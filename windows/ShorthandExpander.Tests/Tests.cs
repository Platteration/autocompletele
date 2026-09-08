using System;
using System.Collections.Generic;
using System.IO;

namespace ShorthandExpander.Tests
{
    internal static class Tests
    {
        private static int _failed;
        private static int _passed;

        private static void Check(bool condition, string name)
        {
            if (condition) { _passed++; Console.WriteLine("  ok   " + name); }
            else { _failed++; Console.WriteLine("  FAIL " + name); }
        }

        private static void Equal<T>(T expected, T actual, string name)
        {
            bool ok = EqualityComparer<T>.Default.Equals(expected, actual);
            Check(ok, ok ? name : $"{name} (expected '{expected}', got '{actual}')");
        }

        private static int Main()
        {
            var list = new List<Shorthand>
            {
                new Shorthand("cool/", "That is really cool!"),
                new Shorthand("verycool/", "Extremely cool!"),
                new Shorthand("sig/", "Best regards,\n{cursor}\nAlex"),
            };

            Console.WriteLine("FindMatch");
            var m = Expander.FindMatch("hey cool/", list);
            Check(m != null && m.Value.Shorthand.Trigger == "cool/" && m.Value.Start == 4, "matches at end of text");
            Check(Expander.FindMatch("cool/", list)?.Start == 0, "matches at start of field");
            Check(Expander.FindMatch("school/", list) == null, "does not fire inside a word");
            Check(Expander.FindMatch("x_cool/", list) == null, "underscore is not a boundary");
            Check(Expander.FindMatch("1cool/", list) == null, "digit is not a boundary");
            Check(Expander.FindMatch("(cool/", list) != null, "punctuation is a boundary");
            Check(Expander.FindMatch("line\ncool/", list) != null, "newline is a boundary");
            Check(Expander.FindMatch("cool/ and more", list) == null, "trigger must be at the caret");
            Equal("verycool/", Expander.FindMatch("verycool/", list)?.Shorthand.Trigger, "longest trigger wins");
            Check(Expander.FindMatch("COOL/", list) == null, "case sensitive");
            Check(Expander.FindMatch("", list) == null && Expander.FindMatch("cool/", null) == null, "empty inputs");

            Console.WriteLine("Render");
            var now = new DateTime(2026, 9, 8, 14, 5, 0);
            Equal("Today is 2026-09-08 at 14:05", Expander.Render("Today is {date} at {time}", now).Text, "date/time");
            Equal("2026-09-08 14:05", Expander.Render("{datetime}", now).Text, "datetime");
            Equal("2026-09-08", Expander.Render("{DATE}", now).Text, "placeholders are case-insensitive");
            var r = Expander.Render("Best regards,\n{cursor}\nAlex", now);
            Equal("Best regards,\n\nAlex", r.Text, "cursor removed");
            Equal(14, r.CursorOffset, "cursor offset");
            Equal(5, Expander.Render("hello", now).CursorOffset, "cursor defaults to end");
            Equal("{nope} {date} {", Expander.Render("{nope} {{date}} {", now).Text, "unknown placeholders and escapes");

            Console.WriteLine("Sanitize");
            var clean = Expander.Sanitize(new Shorthand?[]
            {
                new Shorthand("  a/ ", "A"), new Shorthand("a/", "dup"), new Shorthand("", "x"), null, new Shorthand("b/", "B"),
            });
            Equal(2, clean.Count, "drops empties, nulls and duplicates");
            Equal("a/", clean[0].Trigger, "trims trigger");
            Equal("A", clean[0].Expansion, "first duplicate wins");

            Console.WriteLine("Store");
            string dir = Path.Combine(Path.GetTempPath(), "ShorthandExpanderTests-" + Guid.NewGuid().ToString("N"));
            try
            {
                var store = new ShorthandStore(dir);
                store.Load();
                Check(store.Shorthands.Count > 0, "first load seeds defaults");
                Check(File.Exists(store.ShorthandsPath), "defaults written to disk");
                store.SaveShorthands(new[] { new Shorthand("x/", "line1\nline2") });
                var again = new ShorthandStore(dir);
                again.Load();
                Equal(1, again.Shorthands.Count, "round-trips through disk");
                Equal("line1\nline2", again.Shorthands[0].Expansion, "newlines preserved");
                store.SaveSettings(new AppSettings { Enabled = false, ShiftEnterForNewlines = true });
                again.Load();
                Check(!again.Settings.Enabled && again.Settings.ShiftEnterForNewlines, "settings round-trip");

                string json = ShorthandStore.Serialize(new[] { new Shorthand("t/", "e") });
                Check(json.Contains("\"version\": 1") && json.Contains("\"trigger\": \"t/\""), "serialises shared format");
                Equal(1, ShorthandStore.ParseFile(json).Count, "parses shared format");
                Equal(1, ShorthandStore.ParseFile("[{\"trigger\":\"q/\",\"expansion\":\"Q\"}]").Count, "parses bare array");
                bool threw = false;
                try { ShorthandStore.ParseFile("{\"foo\":1}"); } catch (FormatException) { threw = true; }
                Check(threw, "rejects files without shorthands");
            }
            finally
            {
                try { Directory.Delete(dir, true); } catch { /* ignore */ }
            }

            Console.WriteLine();
            Console.WriteLine($"{_passed} passed, {_failed} failed");
            return _failed == 0 ? 0 : 1;
        }
    }
}
