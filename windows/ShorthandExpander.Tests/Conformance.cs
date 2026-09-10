using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace ShorthandExpander.Tests
{
    /// <summary>
    /// Runs the shared conformance suite (shared/conformance.json). The Chrome
    /// extension and Android test suites run the same file, so a change to the
    /// matching rules applied to only one platform fails on the others.
    /// </summary>
    internal static class Conformance
    {
        /// <summary>Walk up from the working directory to find the repository's shared/ folder.</summary>
        public static string FindSuiteFile()
        {
            var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
            while (dir != null)
            {
                string candidate = Path.Combine(dir.FullName, "shared", "conformance.json");
                if (File.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            throw new FileNotFoundException(
                "Could not find shared/conformance.json in any parent of " + Directory.GetCurrentDirectory());
        }

        public static void Run(Action<bool, string> check, Action<string> section)
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(FindSuiteFile()));
            var root = doc.RootElement;

            var shorthands = new List<Shorthand>();
            foreach (var el in root.GetProperty("shorthands").EnumerateArray())
            {
                shorthands.Add(new Shorthand(
                    el.GetProperty("trigger").GetString() ?? "",
                    el.GetProperty("expansion").GetString() ?? ""));
            }

            section("Conformance: FindMatch");
            foreach (var c in root.GetProperty("match").EnumerateArray())
            {
                string name = c.GetProperty("name").GetString() ?? "";
                string input = c.GetProperty("input").GetString() ?? "";
                var expect = c.GetProperty("expect");
                var actual = Expander.FindMatch(input, shorthands);

                if (expect.ValueKind == JsonValueKind.Null)
                {
                    check(actual == null, actual == null ? name : $"{name} (expected no match, got '{actual!.Value.Shorthand.Trigger}')");
                    continue;
                }
                string wantTrigger = expect.GetProperty("trigger").GetString() ?? "";
                int wantStart = expect.GetProperty("start").GetInt32();
                if (actual == null)
                {
                    check(false, $"{name} (expected '{wantTrigger}', got no match)");
                    continue;
                }
                string gotTrigger = actual.Value.Shorthand.Trigger;
                int gotStart = actual.Value.Start;
                bool ok = gotTrigger == wantTrigger && gotStart == wantStart;
                check(ok, ok ? name : $"{name} (expected '{wantTrigger}'@{wantStart}, got '{gotTrigger}'@{gotStart})");
            }

            section("Conformance: Render");
            foreach (var c in root.GetProperty("render").EnumerateArray())
            {
                string name = c.GetProperty("name").GetString() ?? "";
                string expansion = c.GetProperty("expansion").GetString() ?? "";
                var now = c.GetProperty("now");
                var when = new DateTime(
                    now[0].GetInt32(), now[1].GetInt32(), now[2].GetInt32(),
                    now[3].GetInt32(), now[4].GetInt32(), 0);
                string wantText = c.GetProperty("expectText").GetString() ?? "";
                int wantCursor = c.GetProperty("expectCursor").GetInt32();

                var actual = Expander.Render(expansion, when);
                bool ok = actual.Text == wantText && actual.CursorOffset == wantCursor;
                check(ok, ok ? name : $"{name} (expected '{Escape(wantText)}'@{wantCursor}, got '{Escape(actual.Text)}'@{actual.CursorOffset})");
            }

            section("Conformance: Sanitize");
            foreach (var c in root.GetProperty("sanitize").EnumerateArray())
            {
                string name = c.GetProperty("name").GetString() ?? "";
                var input = new List<Shorthand?>();
                foreach (var el in c.GetProperty("input").EnumerateArray())
                {
                    if (el.ValueKind == JsonValueKind.Null) { input.Add(null); continue; }
                    input.Add(new Shorthand(
                        el.GetProperty("trigger").GetString() ?? "",
                        el.GetProperty("expansion").GetString() ?? ""));
                }
                var want = new List<Shorthand>();
                foreach (var el in c.GetProperty("expect").EnumerateArray())
                {
                    want.Add(new Shorthand(
                        el.GetProperty("trigger").GetString() ?? "",
                        el.GetProperty("expansion").GetString() ?? ""));
                }

                var actual = Expander.Sanitize(input);
                bool ok = actual.Count == want.Count;
                if (ok)
                {
                    for (int i = 0; i < want.Count; i++)
                    {
                        if (actual[i].Trigger != want[i].Trigger || actual[i].Expansion != want[i].Expansion)
                        {
                            ok = false;
                            break;
                        }
                    }
                }
                check(ok, ok ? name : $"{name} (expected {Describe(want)}, got {Describe(actual)})");
            }
        }

        private static string Escape(string s) => s.Replace("\n", "\\n");

        private static string Describe(List<Shorthand> list)
        {
            var parts = new List<string>();
            foreach (var s in list) parts.Add($"{s.Trigger}=>{Escape(s.Expansion)}");
            return "[" + string.Join(", ", parts) + "]";
        }
    }
}
