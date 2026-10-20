// Attaches the files of a document shortcut to the message being written.
// In order of preference:
//   Outlook on Windows   the open message's Attachments collection, through COM
//   Thunderbird          a new compose window with the files attached
//   anything else        the files are put on the clipboard as files (not as
//                        text) and a paste keystroke is sent, which attaches
//                        them in Outlook, Apple Mail, Gmail in a browser, Teams
//                        and most editors; Windows: a file drop list, macOS:
//                        POSIX file references, Linux: text/uri-list via xclip
// Every path reports whether it worked; the shell counts an attachment only
// when it did, and falls back to copying the paths as text otherwise.
"use strict";

const { run: defaultRun, which: defaultWhich } = require("./sender.js");
const { baseName } = require("../../core/capture-policy.js");

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function psList(paths) {
  return "@(" + paths.map(psQuote).join(",") + ")";
}

/** PowerShell: add the files to the message open in Outlook's active inspector. */
function windowsOutlookScript(paths) {
  return "$app = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application'); "
    + "$inspector = $app.ActiveInspector(); if ($null -eq $inspector) { throw 'no message is open in Outlook' }; "
    + "$item = $inspector.CurrentItem; foreach ($p in " + psList(paths) + ") { [void]$item.Attachments.Add($p) }";
}

/** PowerShell (STA): put the files on the clipboard as a file drop list. */
function windowsDropScript(paths) {
  return "Add-Type -AssemblyName System.Windows.Forms; $list = New-Object System.Collections.Specialized.StringCollection; "
    + "foreach ($p in " + psList(paths) + ") { [void]$list.Add($p) }; [System.Windows.Forms.Clipboard]::SetFileDropList($list)";
}

function appleString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** AppleScript: put the files on the clipboard as file references. */
function macDropScript(paths) {
  return ["set the clipboard to {" + paths.map((p) => "POSIX file " + appleString(p)).join(", ") + "}"];
}

/** text/uri-list body for the files (file:// URIs, CRLF-separated). */
function uriList(paths) {
  return paths.map((p) => "file://" + String(p).split("/").map((part) => encodeURIComponent(part)).join("/")).join("\r\n") + "\r\n";
}

/**
 * @param {object} options { platform, run, which, env, notify, paste: () => Promise<{ok}> }
 */
function createAttacher(options) {
  const settings = Object.assign({ platform: process.platform, run: defaultRun, which: defaultWhich, env: process.env, notify: () => {}, paste: null }, options || {});

  function unavailableReason(context) {
    if (settings.platform === "win32" || settings.platform === "darwin") return null;
    if (settings.platform === "linux") {
      if (!settings.env.DISPLAY) return "no X11 display (Wayland sessions cannot receive pasted files)";
      if (!settings.which("xclip")) return "xclip is not installed";
      return null;
    }
    return "attaching files is not supported on " + settings.platform;
  }

  function isAvailable(context) {
    return unavailableReason(context) === null;
  }

  async function pasteFiles() {
    if (!settings.paste) throw new Error("no paste function");
    const result = await settings.paste();
    if (!result || result.ok === false) throw new Error((result && result.error) || "paste failed");
  }

  /**
   * @param {{paths:string[], context:{process?:string}}} request
   * @returns {Promise<{ok:boolean, method:string, error?:string, note?:string}>}
   */
  async function attach(request) {
    const paths = (request && Array.isArray(request.paths) ? request.paths : []).map(String).filter(Boolean);
    const app = baseName(request && request.context && request.context.process);
    if (!paths.length) return { ok: false, method: "none", error: "no files chosen" };
    const reason = unavailableReason(request && request.context);
    if (reason && app !== "thunderbird") return { ok: false, method: "none", error: reason };
    const psArgs = (script) => ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", script];
    let lastError = null;
    try {
      if (settings.platform === "win32" && app === "outlook") {
        try {
          await settings.run("powershell", psArgs(windowsOutlookScript(paths)));
          return { ok: true, method: "outlook-com" };
        } catch (error) {
          lastError = error; // fall back to the clipboard
        }
      }
      if (app === "thunderbird") {
        await settings.run("thunderbird", ["-compose", "attachment='" + paths.join(",") + "'"]);
        return { ok: true, method: "thunderbird-compose", note: "opened a new message with the files attached" };
      }
      if (settings.platform === "win32") {
        await settings.run("powershell", psArgs(windowsDropScript(paths)));
      } else if (settings.platform === "darwin") {
        await settings.run("osascript", macDropScript(paths).flatMap((line) => ["-e", line]));
      } else {
        await settings.run("xclip", ["-selection", "clipboard", "-t", "text/uri-list"], uriList(paths));
      }
      await pasteFiles();
      return { ok: true, method: "clipboard-files", note: lastError ? "Outlook did not accept the files directly (" + lastError.message + "); they were pasted instead" : undefined };
    } catch (error) {
      return { ok: false, method: "clipboard-files", error: String(error && error.message || error) };
    }
  }

  return { attach, isAvailable, unavailableReason };
}

module.exports = { createAttacher, windowsOutlookScript, windowsDropScript, macDropScript, uriList, psQuote };
