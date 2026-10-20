const test = require("node:test");
const assert = require("node:assert/strict");
const attach = require("../desktop/adapters/attach.js");
const { createSender } = require("../desktop/adapters/sender.js");

function fake(options) {
  const calls = [];
  const pastes = [];
  const attacher = attach.createAttacher(Object.assign({
    platform: "win32",
    env: { DISPLAY: ":0" },
    which: () => true,
    run: async (command, args, input) => {
      calls.push({ command, args, input });
      if (options && options.fail && options.fail(command, args)) throw new Error("boom: " + command);
      return "";
    },
    paste: async () => { pastes.push(1); return { ok: true }; },
  }, options && options.settings));
  return { attacher, calls, pastes };
}

test("script builders quote paths and encode URIs", () => {
  assert.equal(attach.psQuote("C:\\Docs\\O'Brien.pdf"), "'C:\\Docs\\O''Brien.pdf'");
  assert.match(attach.windowsOutlookScript(["C:\\a.pdf", "D:\\b's.xlsx"]), /GetActiveObject\('Outlook\.Application'\).*@\('C:\\a\.pdf','D:\\b''s\.xlsx'\).*Attachments\.Add/);
  assert.match(attach.windowsDropScript(["C:\\a.pdf"]), /SetFileDropList/);
  assert.deepEqual(attach.macDropScript(["/Users/me/My \"Docs\"/a.pdf"]), ['set the clipboard to {POSIX file "/Users/me/My \\"Docs\\"/a.pdf"}']);
  assert.equal(attach.uriList(["/tmp/a b#1.pdf", "/tmp/c.pdf"]), "file:///tmp/a%20b%231.pdf\r\nfile:///tmp/c.pdf\r\n");
});

test("Outlook on Windows gets the files through COM; other apps get a file drop and a paste", async () => {
  const outlook = fake();
  const result = await outlook.attacher.attach({ paths: ["C:\\a.pdf"], context: { process: "C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE" } });
  assert.deepEqual(result, { ok: true, method: "outlook-com" });
  assert.equal(outlook.calls.length, 1);
  assert.equal(outlook.calls[0].command, "powershell");
  assert.ok(outlook.calls[0].args.includes("-STA"));
  assert.match(outlook.calls[0].args[outlook.calls[0].args.length - 1], /Outlook\.Application/);
  assert.equal(outlook.pastes.length, 0, "no paste when COM worked");

  const teams = fake();
  const dropped = await teams.attacher.attach({ paths: ["C:\\a.pdf", "C:\\b.pdf"], context: { process: "Teams.exe" } });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.method, "clipboard-files");
  assert.match(teams.calls[0].args[teams.calls[0].args.length - 1], /SetFileDropList/);
  assert.equal(teams.pastes.length, 1);

  // COM refused (Outlook elevated, no message open): fall back to the drop list.
  const fallback = fake({ fail: (command, args) => /Outlook\.Application/.test(args[args.length - 1]) });
  const fell = await fallback.attacher.attach({ paths: ["C:\\a.pdf"], context: { process: "outlook.exe" } });
  assert.equal(fell.ok, true);
  assert.equal(fell.method, "clipboard-files");
  assert.match(fell.note, /did not accept the files directly/);
  assert.equal(fallback.calls.length, 2);
  assert.equal(fallback.pastes.length, 1);
});

test("Thunderbird opens a compose window on any platform", async () => {
  const tb = fake({ settings: { platform: "linux", env: {} } });
  const result = await tb.attacher.attach({ paths: ["/home/me/a.pdf", "/home/me/b.pdf"], context: { process: "thunderbird" } });
  assert.equal(result.ok, true);
  assert.equal(result.method, "thunderbird-compose");
  assert.deepEqual(tb.calls[0].args, ["-compose", "attachment='/home/me/a.pdf,/home/me/b.pdf'"]);
  assert.equal(tb.pastes.length, 0);
});

test("macOS and Linux put file references on the clipboard; Wayland and missing xclip are reported", async () => {
  const mac = fake({ settings: { platform: "darwin" } });
  const result = await mac.attacher.attach({ paths: ["/Users/me/a.pdf"], context: { process: "Mail" } });
  assert.equal(result.ok, true);
  assert.equal(mac.calls[0].command, "osascript");
  assert.deepEqual(mac.calls[0].args, ["-e", 'set the clipboard to {POSIX file "/Users/me/a.pdf"}']);
  assert.equal(mac.pastes.length, 1);

  const linux = fake({ settings: { platform: "linux", env: { DISPLAY: ":0" } } });
  const dropped = await linux.attacher.attach({ paths: ["/home/me/a.pdf"], context: { process: "evolution" } });
  assert.equal(dropped.ok, true);
  assert.deepEqual(linux.calls[0].args, ["-selection", "clipboard", "-t", "text/uri-list"]);
  assert.equal(linux.calls[0].input, "file:///home/me/a.pdf\r\n");

  const wayland = fake({ settings: { platform: "linux", env: {} } });
  assert.equal(wayland.attacher.isAvailable({}), false);
  const refused = await wayland.attacher.attach({ paths: ["/home/me/a.pdf"], context: { process: "evolution" } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Wayland/);
  assert.equal(wayland.calls.length, 0);
  const noXclip = fake({ settings: { platform: "linux", env: { DISPLAY: ":0" }, which: () => false } });
  assert.match(noXclip.attacher.unavailableReason({}), /xclip is not installed/);
  assert.equal(noXclip.attacher.isAvailable({}), false);
});

test("a failed paste or tool reports ok:false, and nothing is chosen means nothing happens", async () => {
  const broken = fake({ fail: () => true });
  const result = await broken.attacher.attach({ paths: ["C:\\a.pdf"], context: { process: "notepad" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom: powershell/);
  const noPaste = fake({ settings: { paste: async () => ({ ok: false, error: "typing is unavailable" }) } });
  const failed = await noPaste.attacher.attach({ paths: ["C:\\a.pdf"], context: { process: "notepad" } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /typing is unavailable/);
  const none = fake();
  assert.equal((await none.attacher.attach({ paths: [], context: {} })).ok, false);
  assert.equal(none.calls.length, 0);
});

test("the sender can paste whatever is on the clipboard without writing text", async () => {
  const sender = createSender({ platform: "win32", clipboard: { readText: () => "x", writeText: () => { throw new Error("must not write"); } } });
  assert.equal(typeof sender.paste, "function");
  // Not executed here: it would run PowerShell. The shape is what the attacher relies on.
});
