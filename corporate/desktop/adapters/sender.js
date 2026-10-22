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

// How long the application gets to read the clipboard after the paste key
// went out, before the person's previous clipboard text is put back.
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
    // Named keys the suite's apps press between fields (Forms) or lines.
    key: (name) => ({ tab: "{TAB}", enter: "{ENTER}", escape: "{ESC}" })[name] || "",
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
    key: (name) => ({ tab: ["key code 48"], enter: ["key code 36"], escape: ["key code 53"] })[name] || [],
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
    key: (name) => ({ tab: ["Tab"], enter: ["Return"], escape: ["Escape"] })[name] || [],
  },
};

function join(platform, parts) {
  return platform === "win32" ? parts.join("") : parts.flat();
}

/**
 * The clipboard may answer synchronously or with promises (Electron's API
 * returns promises in the pinned version); every call is awaited.
 * @param {{clipboard?:{readText:Function, writeText:Function}, platform?:string, notify?:Function,
 *   impl?:object, restoreDelayMs?:number}} options  `impl` replaces parts of the
 *   platform's implementation (available, keys, ...): tests use it instead of a real tool.
 */
function createSender(options) {
  const settings = Object.assign({ platform: process.platform, notify: () => {} }, options || {});
  const own = platforms[settings.platform] || null;
  const impl = settings.impl && typeof settings.impl === "object" ? Object.assign({}, own, settings.impl) : own;
  const delay = Number.isFinite(Number(settings.restoreDelayMs)) && Number(settings.restoreDelayMs) >= 0 ? Number(settings.restoreDelayMs) : RESTORE_DELAY_MS;
  let clipboard = settings.clipboard || null;
  if (!clipboard) {
    try {
      clipboard = require("electron").clipboard;
    } catch (error) {
      clipboard = null;
    }
  }
  let queue = Promise.resolve();
  let active = 0;          // jobs queued or running
  let restoreTimer = null;
  let saved = null;        // {text}, or {unknown} when it could not be read: the clipboard before the first paste of a run of jobs
  let wrote = null;        // what the last paste of the run put on the clipboard

  function isAvailable() {
    return !!impl && !!clipboard && impl.available();
  }

  function unavailableReason() {
    if (!impl) return "typing is not supported on " + settings.platform;
    if (!clipboard) return "no clipboard access";
    if (settings.platform === "linux") return process.env.DISPLAY ? "xdotool is not installed" : "no X11 display (Wayland sessions cannot be typed into)";
    return "typing is unavailable";
  }

  // The person's clipboard text is kept once per run of jobs (a whole Forms
  // fill), then the text to paste is written and awaited before any key is
  // sent. Nothing is put back until the run's last keys went out and the
  // application had RESTORE_DELAY_MS to read the clipboard: a restore on a
  // timer that started before a slow tool sent the paste key pasted the
  // person's previous clipboard (a copied password) into the field instead.
  async function putOnClipboard(text) {
    let current = null;
    try {
      const value = await clipboard.readText();
      current = typeof value === "string" ? value : "";
    } catch (error) {
      current = null;
    }
    // The first paste of a run keeps what was there; a later one keeps a copy
    // made since the previous paste instead, so that copy is what comes back.
    // What could not be read is never put back: writing "" in its place would
    // empty a clipboard that may have held the person's text.
    if (saved == null) saved = current == null ? { unknown: true } : { text: current };
    else if (current != null && (wrote == null || !sameText(current, wrote))) saved = { text: current };
    await clipboard.writeText(text);
    wrote = text;
  }

  function sameText(a, b) {
    return String(a == null ? "" : a).replace(/\r\n/g, "\n") === String(b == null ? "" : b).replace(/\r\n/g, "\n");
  }

  async function restore() {
    const previous = saved;
    const mine = wrote;
    saved = null;
    wrote = null;
    if (previous.unknown) return;
    try {
      // A copy made since the paste (by the person, or by actle elsewhere) is kept.
      if (!sameText(await clipboard.readText(), mine)) return;
      await clipboard.writeText(previous.text);
    } catch (error) {
      // Losing the previous clipboard text is a nuisance, not a failure of the insertion.
    }
  }

  // A job enqueued before the timer fires cancels it (see enqueue): its run restores at its end.
  function scheduleRestore() {
    if (saved == null) return;
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      queue = queue.then(restore);
    }, delay);
  }

  function enqueue(work) {
    active++;
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    const job = queue.then(work).catch((error) => {
      settings.notify("Could not type into this application: " + error.message);
      return { ok: false, error: error.message };
    });
    queue = job.then(() => {
      active--;
      if (active === 0) scheduleRestore();
    });
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
        await putOnClipboard(text);
        steps.push(impl.paste());
      }
      steps.push(impl.left(back));
      await impl.keys(join(settings.platform, steps));
      return { ok: true };
    });
  }

  /**
   * Remove an expansion that was just inserted and type the trigger back.
   * charsBeforeCaret and charsAfterCaret count characters (code points), as
   * the engine reports them: one Backspace or Delete each.
   */
  function undo(action) {
    const before = Math.max(0, Math.floor(Number(action && action.charsBeforeCaret) || 0));
    const after = Math.max(0, Math.floor(Number(action && action.charsAfterCaret) || 0));
    const trigger = String(action && action.trigger == null ? "" : action.trigger);
    return enqueue(async () => {
      if (!isAvailable()) throw new Error(unavailableReason());
      const steps = [impl.backspaces(before), impl.deletes(after)];
      if (trigger) {
        await putOnClipboard(trigger);
        steps.push(impl.paste());
      }
      await impl.keys(join(settings.platform, steps));
      return { ok: true };
    });
  }

  /** Press a named key ("tab", "enter", "escape") `count` times, in order with the other jobs. */
  function press(name, count) {
    const key = String(name == null ? "" : name).toLowerCase();
    const times = Math.max(1, Math.floor(Number(count) || 1));
    return enqueue(async () => {
      if (!isAvailable()) throw new Error(unavailableReason());
      const one = impl.key(key);
      if (!one || !one.length) throw new Error("unknown key " + key);
      const steps = Array.from({ length: times }, () => one);
      await impl.keys(join(settings.platform, steps));
      return { ok: true };
    });
  }

  return { replace, undo, press, isAvailable, unavailableReason, platform: settings.platform, hostname: os.hostname() };
}

module.exports = { createSender, RESTORE_DELAY_MS };
