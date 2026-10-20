// Which application has the focus. Each platform answers with its own tool;
// nothing here needs a native module. Answers are {process, title, bundleId,
// secureInput}; an unanswerable query yields an empty context, which the
// capture policy treats as the default mode (never learn).
"use strict";

const fs = require("node:fs");
const { execFile, spawn } = require("node:child_process");

function run(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeout || 3000 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

// Windows keeps one PowerShell alive and asks it on each poll, because
// Add-Type compiles the P/Invoke shim once per process.
const WINDOWS_SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ActleFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $h = [ActleFg]::GetForegroundWindow()
  $procId = [uint32]0
  [void][ActleFg]::GetWindowThreadProcessId($h, [ref]$procId)
  $sb = New-Object System.Text.StringBuilder 1024
  [void][ActleFg]::GetWindowText($h, $sb, 1024)
  $name = ""
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  [Console]::Out.WriteLine(($name + "\`t" + $sb.ToString()).Replace("\`n", " ").Replace("\`r", " "))
  [Console]::Out.Flush()
}`;

function createWindowsLookup() {
  let child = null;
  let pending = [];
  let buffered = "";

  function start() {
    child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_SCRIPT], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    child.on("error", () => { child = null; });
    child.on("exit", () => { child = null; });
    child.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index).replace(/\r$/, "");
        buffered = buffered.slice(index + 1);
        const resolve = pending.shift();
        if (resolve) resolve(line);
      }
    });
  }

  return {
    query() {
      if (!child) start();
      if (!child) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending = pending.filter((p) => p !== done);
          resolve(null);
        }, 3000);
        const done = (line) => {
          clearTimeout(timer);
          resolve(line);
        };
        pending.push(done);
        child.stdin.write("q\n");
      }).then((line) => {
        if (line == null) return null;
        const tab = line.indexOf("\t");
        return { process: tab < 0 ? line : line.slice(0, tab), title: tab < 0 ? "" : line.slice(tab + 1) };
      });
    },
    stop() {
      if (child) child.kill();
      child = null;
    },
  };
}

const MAC_SCRIPT = [
  "tell application \"System Events\"",
  "set p to first application process whose frontmost is true",
  "set t to \"\"",
  "try",
  "set t to name of front window of p",
  "end try",
  "set b to \"\"",
  "try",
  "set b to bundle identifier of p",
  "end try",
  "return (name of p) & tab & b & tab & t",
  "end tell",
];

function createMacLookup() {
  let polls = 0;
  let secure = false;
  return {
    async query() {
      const out = await run("osascript", MAC_SCRIPT.flatMap((line) => ["-e", line]));
      // Secure input (password fields, some terminals) blocks all listeners;
      // checking it costs an ioreg walk, so do it every fourth poll.
      if (polls++ % 4 === 0) {
        const ioreg = await run("sh", ["-c", "ioreg -l -w 0 | grep -c SecureInput"], 5000);
        secure = !!ioreg && parseInt(ioreg, 10) > 0;
      }
      if (out == null) return null;
      const [process, bundleId, title] = out.replace(/\n$/, "").split("\t");
      return { process: process || "", bundleId: bundleId || "", title: title || "", secureInput: secure };
    },
    stop() {},
  };
}

function createLinuxLookup() {
  return {
    async query() {
      const out = await run("xdotool", ["getactivewindow", "getwindowpid", "getwindowname"]);
      if (out == null) return null;
      const [pid, ...rest] = out.split("\n");
      let process = "";
      try {
        process = fs.readFileSync("/proc/" + parseInt(pid, 10) + "/comm", "utf8").trim();
      } catch (error) {
        process = "";
      }
      return { process, title: rest.join(" ").trim() };
    },
    stop() {},
  };
}

function createActiveWindowLookup(platform) {
  const which = platform || process.platform;
  if (which === "win32") return createWindowsLookup();
  if (which === "darwin") return createMacLookup();
  if (which === "linux") return createLinuxLookup();
  return { query: () => Promise.resolve(null), stop() {} };
}

module.exports = { createActiveWindowLookup };
