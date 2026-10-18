using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

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

        private static bool FileHolds(string path, byte[] expected) =>
            File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(expected);

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

            Console.WriteLine("CaretSteps");
            Equal(5, TextSender.CaretSteps("hello"), "plain text");
            Equal(3, TextSender.CaretSteps("a\r\nb"), "CRLF counts once");
            Equal(3, TextSender.CaretSteps("a\nb"), "LF counts once");
            Equal(2, TextSender.CaretSteps("a\U0001F600"), "surrogate pair counts once");
            Equal(0, TextSender.CaretSteps(""), "empty");

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

            Console.WriteLine("Store safety");
            string safeDir = Path.Combine(Path.GetTempPath(), "ShorthandExpanderTests-" + Guid.NewGuid().ToString("N"));
            try
            {
                // An unreadable shorthands.json (here cut off mid-write) is copied aside before anything can save over it.
                string brokenDir = Path.Combine(safeDir, "broken");
                Directory.CreateDirectory(brokenDir);
                var broken = new ShorthandStore(brokenDir);
                byte[] original = Encoding.UTF8.GetBytes("{\"version\":1,\"shorthands\":[{\"trigger\":\"keep/\",\"expansion\":\"Grüße\"},{\"trig");
                File.WriteAllBytes(broken.ShorthandsPath, original);
                broken.Load();
                string[] copies = Directory.GetFiles(brokenDir, "shorthands.unreadable-*.json");
                string copy = copies.Length == 1 ? copies[0] : "(none)";
                Equal(1, copies.Length, "unreadable shorthands.json is copied aside");
                Check(FileHolds(copy, original), "the copy is byte-for-byte identical");
                Equal(0, broken.Shorthands.Count, "unreadable shorthands.json loads as an empty list");
                Check(broken.LoadProblem != null && broken.LoadProblem.Contains(copy), "LoadProblem names the copy");
                Check(!broken.ShorthandsSaveBlocked, "saving is allowed once the copy exists");
                Check(FileHolds(broken.ShorthandsPath, original), "Load leaves the unreadable file in place");
                broken.Load();
                Equal(1, Directory.GetFiles(brokenDir, "shorthands.unreadable-*.json").Length, "the same unreadable file is copied only once");
                // Different unreadable content gets its own copy. The names the next copy could take in the coming
                // seconds are taken first, so the numbered-name path runs whatever the clock does.
                for (int s = 0; s < 3; s++)
                {
                    string taken = Path.Combine(brokenDir, "shorthands.unreadable-" +
                        DateTime.Now.AddSeconds(s).ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture) + ".json");
                    if (!File.Exists(taken)) File.WriteAllText(taken, "taken");
                }
                byte[] other = Encoding.UTF8.GetBytes("{\"version\":1,\"shorthands\":[{\"trigger\":\"other/\"");
                File.WriteAllBytes(broken.ShorthandsPath, other);
                broken.Load();
                string[] numbered = Directory.GetFiles(brokenDir, "shorthands.unreadable-*-2.json");
                Check(numbered.Length == 1 && FileHolds(numbered[0], other), "a different unreadable file gets a numbered copy");
                Check(FileHolds(copy, original), "a later copy never overwrites an earlier one");
                broken.SaveShorthands(new[] { new Shorthand("new/", "fresh") });
                Check(FileHolds(copy, original), "the copy still holds the original bytes after a save");
                var saved = ShorthandStore.ParseFile(File.ReadAllText(broken.ShorthandsPath));
                Check(saved.Count == 1 && saved[0].Trigger == "new/", "the save writes the new list");

                // A missing file still seeds the defaults, with no copy and no problem reported.
                string freshDir = Path.Combine(safeDir, "fresh");
                var fresh = new ShorthandStore(freshDir);
                fresh.Load();
                Equal(ShorthandStore.DefaultShorthands().Count, fresh.Shorthands.Count, "a missing file seeds the defaults");
                Check(fresh.LoadProblem == null && !fresh.ShorthandsSaveBlocked && !fresh.SettingsSaveBlocked, "a missing file is not a load problem");
                Equal(0, Directory.GetFiles(freshDir, "*.unreadable-*").Length, "a missing file makes no copy");

                // Saves go through a temp file that is swapped in, keeping the previous file as .bak.
                fresh.SaveShorthands(new[] { new Shorthand("a/", "Alpha\nline two"), new Shorthand("b/", "{date}") });
                Equal(0, Directory.GetFiles(freshDir, "*.tmp").Length, "a save leaves no temp file behind");
                var back = ShorthandStore.ParseFile(File.ReadAllText(fresh.ShorthandsPath));
                Check(back.Count == 2 && back[0].Trigger == "a/" && back[0].Expansion == "Alpha\nline two" &&
                      back[1].Trigger == "b/" && back[1].Expansion == "{date}", "the saved file parses back to the saved list");
                byte[] before = File.ReadAllBytes(fresh.ShorthandsPath);
                Check(before.Length > 0 && before[0] == (byte)'{', "the saved file has no byte-order mark");
                fresh.SaveShorthands(new[] { new Shorthand("c/", "C") });
                Check(FileHolds(fresh.ShorthandsPath + ".bak", before), "replacing keeps the previous file as .bak");
                fresh.SaveSettings(new AppSettings { Enabled = false, ShiftEnterForNewlines = true });
                fresh.SaveSettings(new AppSettings { Enabled = false, ShiftEnterForNewlines = false });
                Equal(0, Directory.GetFiles(freshDir, "*.tmp").Length, "settings saves leave no temp file behind");
                var reopened = new ShorthandStore(freshDir);
                reopened.Load();
                Check(reopened.LoadProblem == null && reopened.Shorthands.Count == 1 && !reopened.Settings.Enabled &&
                      !reopened.Settings.ShiftEnterForNewlines, "saved files load back without problems");

                // A save that cannot finish (its temp file's name is taken by a folder) leaves the previous file intact.
                byte[] kept = File.ReadAllBytes(fresh.ShorthandsPath);
                Directory.CreateDirectory(fresh.ShorthandsPath + ".tmp");
                bool failed = false;
                try { fresh.SaveShorthands(new[] { new Shorthand("lost/", "x") }); }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { failed = true; }
                Check(failed, "a save that cannot write its temp file reports the failure");
                Check(FileHolds(fresh.ShorthandsPath, kept), "a failed save leaves the previous file intact");
                Check(fresh.Shorthands.Count == 1 && fresh.Shorthands[0].Trigger == "c/", "a failed save leaves the list in use unchanged");
                Directory.Delete(fresh.ShorthandsPath + ".tmp");

                // An unreadable settings.json is copied aside too, and the defaults are used.
                string settingsDir = Path.Combine(safeDir, "settings");
                Directory.CreateDirectory(settingsDir);
                var odd = new ShorthandStore(settingsDir);
                byte[] badSettings = Encoding.UTF8.GetBytes("{\"enabled\": fals");
                File.WriteAllBytes(odd.SettingsPath, badSettings);
                odd.Load();
                string[] settingsCopies = Directory.GetFiles(settingsDir, "settings.unreadable-*.json");
                string settingsCopy = settingsCopies.Length == 1 ? settingsCopies[0] : "(none)";
                Check(FileHolds(settingsCopy, badSettings), "unreadable settings.json is copied aside unchanged");
                Check(odd.Settings.Enabled && !odd.Settings.ShiftEnterForNewlines, "unreadable settings fall back to the defaults");
                Check(odd.LoadProblem != null && odd.LoadProblem.Contains(settingsCopy), "LoadProblem names the settings copy");

                // A file that can be neither read nor copied (another handle holds it exclusively) is never saved over,
                // until a later Load succeeds.
                string lockedDir = Path.Combine(safeDir, "locked");
                Directory.CreateDirectory(lockedDir);
                var locked = new ShorthandStore(lockedDir);
                byte[] mine = Encoding.UTF8.GetBytes("{\"version\":1,\"shorthands\":[{\"trigger\":\"mine/\",\"expansion\":\"M\"}]}");
                byte[] mySettings = Encoding.UTF8.GetBytes("{\"enabled\":false}");
                File.WriteAllBytes(locked.ShorthandsPath, mine);
                File.WriteAllBytes(locked.SettingsPath, mySettings);
                using (new FileStream(locked.ShorthandsPath, FileMode.Open, FileAccess.Read, FileShare.None))
                using (new FileStream(locked.SettingsPath, FileMode.Open, FileAccess.Read, FileShare.None))
                {
                    locked.Load();
                }
                Check(locked.ShorthandsSaveBlocked && locked.SettingsSaveBlocked, "files that cannot be read or copied block saving");
                Check(locked.LoadProblem != null, "LoadProblem reports the blocked files");
                bool refused = false;
                try { locked.SaveShorthands(new[] { new Shorthand("x/", "X") }); } catch (InvalidOperationException) { refused = true; }
                Check(refused && FileHolds(locked.ShorthandsPath, mine), "SaveShorthands refuses and leaves the file untouched");
                Equal(0, locked.Shorthands.Count, "a refused save leaves the list in use unchanged");
                refused = false;
                try { locked.SaveSettings(new AppSettings()); } catch (InvalidOperationException) { refused = true; }
                Check(refused && FileHolds(locked.SettingsPath, mySettings), "SaveSettings refuses and leaves the file untouched");
                locked.Load();
                Check(!locked.ShorthandsSaveBlocked && !locked.SettingsSaveBlocked && locked.LoadProblem == null, "a later successful Load lifts the block");
                Check(locked.Shorthands.Count == 1 && !locked.Settings.Enabled, "the untouched files load once they are readable");

                // A save interrupted between ReplaceFile's two renames leaves no file: the newest list in .tmp, the
                // previous one in .bak. Load puts the newest readable one back instead of seeding the defaults over them.
                string interruptedDir = Path.Combine(safeDir, "interrupted");
                Directory.CreateDirectory(interruptedDir);
                var interrupted = new ShorthandStore(interruptedDir);
                byte[] newest = Encoding.UTF8.GetBytes(ShorthandStore.Serialize(new[] { new Shorthand("newest/", "N") }));
                byte[] previous = Encoding.UTF8.GetBytes(ShorthandStore.Serialize(new[] { new Shorthand("previous/", "P") }));
                File.WriteAllBytes(interrupted.ShorthandsPath + ".tmp", newest);
                File.WriteAllBytes(interrupted.ShorthandsPath + ".bak", previous);
                interrupted.Load();
                Check(interrupted.Shorthands.Count == 1 && interrupted.Shorthands[0].Trigger == "newest/", "an interrupted save is restored from .tmp, not seeded");
                Check(FileHolds(interrupted.ShorthandsPath, newest), "the restored file holds the newest list");
                Check(FileHolds(interrupted.ShorthandsPath + ".bak", previous), "restoring keeps the previous list in .bak");
                Check(interrupted.LoadProblem != null && interrupted.LoadProblem.Contains(".tmp"), "LoadProblem says the list was restored");

                string bakOnlyDir = Path.Combine(safeDir, "bak-only");
                Directory.CreateDirectory(bakOnlyDir);
                var bakOnly = new ShorthandStore(bakOnlyDir);
                File.WriteAllText(bakOnly.ShorthandsPath + ".tmp", "{\"version\":1,\"shorth");
                File.WriteAllBytes(bakOnly.ShorthandsPath + ".bak", previous);
                bakOnly.Load();
                Check(bakOnly.Shorthands.Count == 1 && bakOnly.Shorthands[0].Trigger == "previous/", "an unreadable .tmp falls back to .bak");

                // When the leftover cannot be put back, nothing is seeded or saved over it, and Load does not throw.
                string stuckDir = Path.Combine(safeDir, "stuck");
                Directory.CreateDirectory(stuckDir);
                var stuck = new ShorthandStore(stuckDir);
                File.WriteAllBytes(stuck.ShorthandsPath + ".tmp", newest);
                Directory.CreateDirectory(stuck.ShorthandsPath); // the restore's copy cannot create the file
                bool loadThrew = false;
                try { stuck.Load(); } catch { loadThrew = true; }
                Check(!loadThrew && stuck.ShorthandsSaveBlocked, "a leftover that cannot be restored blocks saving without crashing Load");
                Check(FileHolds(stuck.ShorthandsPath + ".tmp", newest), "the leftover .tmp is left untouched");

                // A file that parses but has no recognisable entries (a hand edit capitalised the names) is copied aside.
                string editedDir = Path.Combine(safeDir, "edited");
                Directory.CreateDirectory(editedDir);
                var edited = new ShorthandStore(editedDir);
                byte[] capitalised = Encoding.UTF8.GetBytes("{\"version\":1,\"shorthands\":[{\"Trigger\":\"a/\",\"Expansion\":\"A\"}]}");
                File.WriteAllBytes(edited.ShorthandsPath, capitalised);
                edited.Load();
                string[] editedCopies = Directory.GetFiles(editedDir, "shorthands.unreadable-*.json");
                Check(editedCopies.Length == 1 && FileHolds(editedCopies[0], capitalised), "a file with no recognisable entries is copied aside");
                Check(edited.LoadProblem != null, "LoadProblem reports the unrecognised entries");
                var emptyListDir = Path.Combine(safeDir, "empty-list");
                Directory.CreateDirectory(emptyListDir);
                var emptyList = new ShorthandStore(emptyListDir);
                File.WriteAllText(emptyList.ShorthandsPath, "{\"version\":1,\"shorthands\":[]}");
                emptyList.Load();
                Check(emptyList.LoadProblem == null && emptyList.Shorthands.Count == 0, "a saved empty list is not a problem");
            }
            finally
            {
                try { Directory.Delete(safeDir, true); } catch { /* ignore */ }
            }

            Console.WriteLine("Store before import");
            string importDir = Path.Combine(Path.GetTempPath(), "ShorthandExpanderTests-" + Guid.NewGuid().ToString("N"));
            try
            {
                var store = new ShorthandStore(importDir);
                store.Load();
                var current = new[] { new Shorthand("a/", "Alpha\nline two"), new Shorthand("b/", "{date} Grüße") };
                store.SaveShorthands(current);
                byte[] savedBytes = File.ReadAllBytes(store.ShorthandsPath);
                var at = new DateTime(2026, 10, 18, 14, 30, 5);
                string expectedName = Path.Combine(importDir, "shorthands.before-import-20261018-143005.json");

                string copy = store.KeepCopyBeforeImport(at);
                Equal(expectedName, copy, "the pre-import copy is named shorthands.before-import-<date>-<time>.json beside shorthands.json");
                var copied = File.Exists(copy) ? ShorthandStore.ParseFile(File.ReadAllText(copy)) : new List<Shorthand>();
                Check(copied.Count == 2 && copied[0].Trigger == "a/" && copied[0].Expansion == "Alpha\nline two" &&
                      copied[1].Trigger == "b/" && copied[1].Expansion == "{date} Grüße", "the pre-import copy parses back to the list in use");
                Check(File.Exists(copy) && File.ReadAllText(copy).Contains("\"version\": 1"), "the pre-import copy uses the shared file format");
                Check(FileHolds(store.ShorthandsPath, savedBytes) && store.Shorthands.Count == 2, "keeping the copy leaves shorthands.json and the list alone");
                Equal(0, Directory.GetFiles(importDir, "*.tmp").Length, "the pre-import copy leaves no temp file behind");

                // A copy made in the same second never overwrites the earlier one: it takes the next numbered name.
                byte[] firstCopy = File.ReadAllBytes(copy);
                store.SaveShorthands(new[] { new Shorthand("imported/", "I") });
                string second = store.KeepCopyBeforeImport(at);
                Equal(Path.Combine(importDir, "shorthands.before-import-20261018-143005-2.json"), second, "a taken name gets a numbered copy");
                Check(FileHolds(copy, firstCopy), "a later pre-import copy never overwrites an earlier one");
                var secondList = File.Exists(second) ? ShorthandStore.ParseFile(File.ReadAllText(second)) : new List<Shorthand>();
                Check(secondList.Count == 1 && secondList[0].Trigger == "imported/", "the numbered copy holds the list in use at that time");
                string third = store.KeepCopyBeforeImport(at);
                Check(third.EndsWith("-3.json", StringComparison.Ordinal) && FileHolds(copy, firstCopy) && File.Exists(second),
                    "numbering continues past every taken name");

                // A copy that cannot be written (its temp file's name is taken by a folder) is reported, and nothing changes.
                var failAt = new DateTime(2026, 10, 18, 15, 0, 0);
                string failName = Path.Combine(importDir, "shorthands.before-import-20261018-150000.json");
                Directory.CreateDirectory(failName + ".tmp");
                byte[] beforeFail = File.ReadAllBytes(store.ShorthandsPath);
                int copiesBefore = Directory.GetFiles(importDir, "shorthands.before-import-*.json").Length;
                bool copyFailed = false;
                try { store.KeepCopyBeforeImport(failAt); }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { copyFailed = true; }
                Check(copyFailed, "a pre-import copy that cannot be written reports the failure");
                Check(!File.Exists(failName) && Directory.GetFiles(importDir, "shorthands.before-import-*.json").Length == copiesBefore,
                    "a failed pre-import copy leaves no copy file");
                Check(FileHolds(store.ShorthandsPath, beforeFail) && store.Shorthands.Count == 1 && store.Shorthands[0].Trigger == "imported/",
                    "a failed pre-import copy leaves shorthands.json and the list unchanged");

                // The public overload uses the clock and still lands beside shorthands.json.
                string dated = store.KeepCopyBeforeImport();
                Check(Path.GetDirectoryName(dated) == importDir && Path.GetFileName(dated).StartsWith("shorthands.before-import-", StringComparison.Ordinal) &&
                      File.Exists(dated), "KeepCopyBeforeImport() writes a dated copy beside shorthands.json");
            }
            finally
            {
                try { Directory.Delete(importDir, true); } catch { /* ignore */ }
            }

            Conformance.Run(Check, name => Console.WriteLine(name));

            Console.WriteLine();
            Console.WriteLine($"{_passed} passed, {_failed} failed");
            return _failed == 0 ? 0 : 1;
        }
    }
}
