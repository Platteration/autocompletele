// Puts text into whatever application has the focus. No second native module:
// the text goes on the clipboard and a paste keystroke is sent with the
// platform's own scripting tool, which also sends the Backspaces that remove
// the trigger. Every call reports whether it could do the job, so the shell
// can tell the person instead of silently doing nothing.
//
//   Windows  PowerShell + System.Windows.Forms.SendKeys (always present)
//   macOS    osascript / System Events (needs Accessibility permission)
//   Linux    xdotool (X11); on Wayland or without xdotool typing is unavailable
"use strict";

const { execFile, execFileSync } = require("node:child_process");
const os = require("node:os");

const RESTORE_DELAY_MS = 600;

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || "").trim() || command + " failed"));
      else resolve(stdout);
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

function which(name) {
  try {
    execFileSync("which", [name], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch (error) {
    return false;
  }
}

const platforms = {
  win32: {
    available: () => true,
    // SendKeys: {BS n} Backspace, {DEL n} Delete, {LEFT n} caret left, ^v paste.
    async keys(sequence) {
      if (!sequence) return;
      const script = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + sequence.replace(/'/g, "''") + "')";
      await run("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script]);
    },
    backspaces: (n) => n > 0 ? "{BS " + n + "}" : "",
    deletes: (n) => n > 0 ? "{DEL " + n + "}" : "",
    left: (n) => n > 0 ? "{LEFT " + n + "}" : "",
    paste: () => "^v",
  },
  darwin: {
    available: () => true,
    async keys(sequence) {
      if (!sequence.length) return;
      const lines = ["tell application \"System Events\""].concat(sequence).concat(["end tell"]);
      await run("osascript", lines.flatMap((line) => ["-e", line]));
    },
    backspaces: (n) => Array.from({ length: n }, () => "key code 51"),
    deletes: (n) => Array.from({ length: n }, () => "key code 117"),
    left: (n) => Array.from({ length: n }, () => "key code 123"),
    paste: () => ["keystroke \"v\" using command down"],
  },
  linux: {
    available: () => !!process.env.DISPLAY && which("xdotool"),
    async keys(sequence) {
      if (!sequence.length) return;
      await run("xdotool", ["key", "--delay", "15"].concat(sequence));
    },
    backspaces: (n) => Array.from({ length: n }, () => "BackSpace"),
    deletes: (n) => Array.from({ length: n }, () => "Delete"),
    left: (n) => Array.from({ length: n }, () => "Left"),
    paste: () => ["ctrl+v"],
  },
};

function join(platform, parts) {
  return platform === "win32" ? parts.join("") : parts.flat();
}

/**
 * @param {{clipboard?:{readText:Function, writeText:Function}, platform?:string, notify?:Function}} options
 */
function createSender(options) {
  const settings = Object.assign({ platform: process.platform, notify: () => {} }, options || {});
  const impl = platforms[settings.platform] || null;
  let clipboard = settings.clipboard || null;
  if (!clipboard) {
    try {
      clipboard = require("electron").clipboard;
    } catch (error) {
      clipboard = null;
    }
  }
  let queue = Promise.resolve();
  let restoreTimer = null;
  let saved = null;

  function isAvailable() {
    return !!impl && !!clipboard && impl.available();
  }

  function unavailableReason() {
    if (!impl) return "typing is not supported on " + settings.platform;
    if (!clipboard) return "no clipboard access";
    if (settings.platform === "linux") return process.env.DISPLAY ? "xdotool is not installed" : "no X11 display (Wayland sessions cannot be typed into)";
    return "typing is unavailable";
  }

  function stash() {
    if (saved == null) {
      try {
        saved = clipboard.readText();
      } catch (error) {
        saved = "";
      }
    }
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      const previous = saved;
      saved = null;
      try {
        clipboard.writeText(previous);
      } catch (error) {
        // Losing the previous clipboard text is a nuisance, not a failure of the insertion.
      }
    }, RESTORE_DELAY_MS);
  }

  function enqueue(work) {
    const job = queue.then(work).catch((error) => {
      settings.notify("Could not type into this application: " + error.message);
      return { ok: false, error: error.message };
    });
    queue = job.then(() => undefined);
    return job;
  }

  /** Delete `backspaces` characters before the caret, paste `text`, move the caret back to `cursorOffset`. */
  function replace(action) {
    const backspaces = Math.max(0, Math.floor(Number(action && action.backspaces) || 0));
    const text = String(action && action.text == null ? "" : action.text);
    const cursorOffset = action && Number.isFinite(Number(action.cursorOffset)) ? Number(action.cursorOffset) : text.length;
    return enqueue(async () => {
      if (!isAvailable()) throw new Error(unavailableReason());
      const back = Math.max(0, Array.from(text).length - Array.from(text.slice(0, cursorOffset)).length);
      const steps = [impl.backspaces(backspaces)];
      if (text) {
        stash();
        clipboard.writeText(text);
        steps.push(impl.paste());
      }
      steps.push(impl.left(back));
      await impl.keys(join(settings.platform, steps));
      return { ok: true };
    });
  }

  /** Remove an expansion that was just inserted and type the trigger back. */
  function undo(action) {
    const before = Math.max(0, Math.floor(Number(action && action.charsBeforeCaret) || 0));
    const after = Math.max(0, Math.floor(Number(action && action.charsAfterCaret) || 0));
    const trigger = String(action && action.trigger == null ? "" : action.trigger);
    return enqueue(async () => {
      if (!isAvailable()) throw new Error(unavailableReason());
      const steps = [impl.backspaces(before), impl.deletes(after)];
      if (trigger) {
        stash();
        clipboard.writeText(trigger);
        steps.push(impl.paste());
      }
      await impl.keys(join(settings.platform, steps));
      return { ok: true };
    });
  }

  /** Send the paste keystroke only; whatever is on the clipboard (text or files) is pasted. */
  function paste() {
    return enqueue(async () => {
      if (!isAvailable()) throw new Error(unavailableReason());
      await impl.keys(join(settings.platform, [impl.paste()]));
      return { ok: true };
    });
  }

  return { replace, undo, paste, isAvailable, unavailableReason, platform: settings.platform, hostname: os.hostname() };
}

module.exports = { createSender, RESTORE_DELAY_MS, run, which };
