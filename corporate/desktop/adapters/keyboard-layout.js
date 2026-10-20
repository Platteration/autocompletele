// Which keyboard layout the operating system is set to, mapped to one of
// the layouts the listener knows. Returns null when it cannot tell; the
// setting "auto" then keeps en-US.
"use strict";

const { run: defaultRun } = require("./sender.js");

// Windows keyboard layout ids (the last four hex digits of an input method tip).
const WINDOWS_KLID = { "0409": "en-US", "0809": "en-GB", "0407": "de-DE", "040c": "fr-FR", "0c0a": "es-ES", "040a": "es-ES", "041d": "sv-SE", "0414": "nb-NO", "0406": "da-DK", "0413": "nl-NL", "0816": "pt-PT" };
// macOS keyboard layout names (com.apple.HIToolbox AppleSelectedInputSources).
const MAC_NAMES = { "u.s.": "en-US", "abc": "en-US", "british": "en-GB", "german": "de-DE", "french": "fr-FR", "spanish": "es-ES", "spanish - iso": "es-ES", "swedish": "sv-SE", "swedish - pro": "sv-SE", "norwegian": "nb-NO", "danish": "da-DK", "dutch": "nl-NL", "portuguese": "pt-PT" };
// X keyboard layout codes (setxkbmap -query).
const XKB = { us: "en-US", gb: "en-GB", de: "de-DE", fr: "fr-FR", es: "es-ES", se: "sv-SE", no: "nb-NO", dk: "da-DK", nl: "nl-NL", pt: "pt-PT" };

/** Map a tool's output to a layout id; exported for tests. */
function fromOutput(platform, output) {
  const text = String(output == null ? "" : output);
  if (platform === "win32") {
    const match = /([0-9a-fA-F]{4}):[0-9a-fA-F]{8}/.exec(text) || /^\s*([0-9a-fA-F]{8})\s*$/m.exec(text);
    const klid = match ? match[1].slice(-4).toLowerCase() : null;
    return klid && WINDOWS_KLID[klid] ? WINDOWS_KLID[klid] : null;
  }
  if (platform === "darwin") {
    const match = /"?KeyboardLayout Name"?\s*=\s*"?([^";\n]+)"?/.exec(text);
    const name = match ? match[1].trim().toLowerCase() : null;
    return name && MAC_NAMES[name] ? MAC_NAMES[name] : null;
  }
  if (platform === "linux") {
    const match = /^layout:\s*([a-z]+)/m.exec(text);
    const code = match ? match[1].toLowerCase() : null;
    return code && XKB[code] ? XKB[code] : null;
  }
  return null;
}

async function detectLayout(platform, run) {
  const exec = run || defaultRun;
  try {
    if (platform === "win32") {
      const output = await exec("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        "(Get-WinUserLanguageList | Select-Object -First 1).InputMethodTips | Select-Object -First 1"]);
      return fromOutput(platform, output);
    }
    if (platform === "darwin") {
      const output = await exec("defaults", ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"]);
      return fromOutput(platform, output);
    }
    if (platform === "linux") {
      const output = await exec("setxkbmap", ["-query"]);
      return fromOutput(platform, output);
    }
  } catch (error) {
    return null;
  }
  return null;
}

module.exports = { WINDOWS_KLID, MAC_NAMES, XKB, fromOutput, detectLayout };
