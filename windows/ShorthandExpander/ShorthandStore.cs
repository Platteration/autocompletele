using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace ShorthandExpander
{
    /// <summary>Loads and saves shorthands and settings under %APPDATA%\ShorthandExpander.</summary>
    public sealed class ShorthandStore
    {
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNameCaseInsensitive = true,
        };

        public string Directory { get; }
        public string ShorthandsPath => Path.Combine(Directory, "shorthands.json");
        public string SettingsPath => Path.Combine(Directory, "settings.json");

        private readonly object _lock = new object();
        private List<Shorthand> _shorthands = new List<Shorthand>();
        private AppSettings _settings = new AppSettings();

        public event EventHandler? Changed;

        /// <summary>
        /// Set by Load when shorthands.json or settings.json exists but could not be read: what went wrong and
        /// where the unreadable file was copied. Null when both loaded (or were missing).
        /// </summary>
        public string? LoadProblem { get; private set; }

        /// <summary>True when an unreadable shorthands.json could not be copied aside; SaveShorthands then refuses.</summary>
        public bool ShorthandsSaveBlocked { get; private set; }

        /// <summary>True when an unreadable settings.json could not be copied aside; SaveSettings then refuses.</summary>
        public bool SettingsSaveBlocked { get; private set; }

        public ShorthandStore() : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ShorthandExpander"))
        {
        }

        public ShorthandStore(string directory)
        {
            Directory = directory;
        }

        /// <summary>Snapshot of the current list (safe to read from any thread).</summary>
        public IReadOnlyList<Shorthand> Shorthands
        {
            get { lock (_lock) return _shorthands.ToArray(); }
        }

        public AppSettings Settings
        {
            get { lock (_lock) return new AppSettings { Enabled = _settings.Enabled, ShiftEnterForNewlines = _settings.ShiftEnterForNewlines }; }
        }

        public void Load()
        {
            List<Shorthand> list;
            AppSettings settings;
            var problems = new List<string>();
            bool shorthandsBlocked = !RestoreInterruptedSave(ShorthandsPath, text => ParseFile(text), problems);
            bool settingsBlocked = !RestoreInterruptedSave(SettingsPath,
                text => JsonSerializer.Deserialize<AppSettings>(text, JsonOptions) ?? throw new FormatException("Empty settings."), problems);
            try
            {
                list = File.Exists(ShorthandsPath) ? ReadSavedList(File.ReadAllText(ShorthandsPath)) : DefaultShorthands();
            }
            catch (Exception ex)
            {
                // Start empty, but keep the unreadable file: the next save would otherwise overwrite it.
                list = new List<Shorthand>();
                shorthandsBlocked |= !CopyAside(ShorthandsPath, ex, "Your shorthand list started empty.", problems);
            }
            try
            {
                settings = File.Exists(SettingsPath)
                    ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath), JsonOptions) ?? new AppSettings()
                    : new AppSettings();
            }
            catch (Exception ex)
            {
                settings = new AppSettings();
                settingsBlocked |= !CopyAside(SettingsPath, ex, "Default settings are in use.", problems);
            }
            lock (_lock)
            {
                _shorthands = list;
                _settings = settings;
            }
            ShorthandsSaveBlocked = shorthandsBlocked;
            SettingsSaveBlocked = settingsBlocked;
            LoadProblem = problems.Count == 0 ? null : string.Join("\n\n", problems);
            // First run seeds the defaults, but never while something is left that saving would bury.
            if (!File.Exists(ShorthandsPath) && !shorthandsBlocked) SaveShorthands(list);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        /// <summary>
        /// A crash, or a ReplaceFile failure between its two renames, can leave no file at all: the newest version in
        /// ".tmp" and the previous one in ".bak". Put the newest readable one back before loading, so the first-run seed
        /// cannot write over them. Returns false when one was found but could not be put back; saving is then refused.
        /// </summary>
        private bool RestoreInterruptedSave(string path, Func<string, object> mustRead, List<string> problems)
        {
            if (File.Exists(path)) return true;
            foreach (string candidate in new[] { path + ".tmp", path + ".bak" })
            {
                if (!File.Exists(candidate)) continue;
                try { mustRead(File.ReadAllText(candidate)); } catch { continue; }
                try
                {
                    File.Copy(candidate, path, overwrite: false);
                    problems.Add($"{Path.GetFileName(path)} was missing after an interrupted save, so it was restored from {candidate}.");
                    return true;
                }
                catch (Exception ex)
                {
                    problems.Add($"{Path.GetFileName(path)} was missing after an interrupted save, and {candidate} could not be put back ({ex.Message}).\n" +
                        "It was left untouched, and nothing will be saved over it until Shorthand Expander is restarted and can restore it.");
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// Reads the saved list, treating a file whose entries were all unrecognised (a hand edit, another tool's
        /// format) as unreadable, so it is copied aside instead of loading empty and being saved over.
        /// </summary>
        private static List<Shorthand> ReadSavedList(string json)
        {
            var list = ParseFile(json);
            if (list.Count == 0)
            {
                using var doc = JsonDocument.Parse(json);
                if (FindArray(doc.RootElement).GetArrayLength() > 0) throw new FormatException("None of its entries could be read.");
            }
            return list;
        }

        public void SaveShorthands(IEnumerable<Shorthand> list)
        {
            if (ShorthandsSaveBlocked) throw new InvalidOperationException(BlockedMessage(ShorthandsPath));
            var clean = Expander.Sanitize(list);
            System.IO.Directory.CreateDirectory(Directory);
            WriteAtomically(ShorthandsPath, Serialize(clean));
            // Only a list that reached the disk becomes the one in use.
            lock (_lock) _shorthands = clean;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SaveSettings(AppSettings settings)
        {
            if (SettingsSaveBlocked) throw new InvalidOperationException(BlockedMessage(SettingsPath));
            System.IO.Directory.CreateDirectory(Directory);
            WriteAtomically(SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
            lock (_lock) _settings = new AppSettings { Enabled = settings.Enabled, ShiftEnterForNewlines = settings.ShiftEnterForNewlines };
            Changed?.Invoke(this, EventArgs.Empty);
        }

        /// <summary>
        /// Copies a file that exists but could not be read, byte for byte, to "name.unreadable-yyyyMMdd-HHmmss.json"
        /// beside it (never overwriting anything) and records what happened. Returns false if the copy failed.
        /// </summary>
        private bool CopyAside(string path, Exception readError, string fallback, List<string> problems)
        {
            string name = Path.GetFileName(path);
            try
            {
                // An identical earlier copy is reused, so starting with the same unreadable file adds no new copies.
                string? backup = null;
                byte[] bytes = File.ReadAllBytes(path);
                foreach (string earlier in System.IO.Directory.GetFiles(Directory, Path.GetFileNameWithoutExtension(path) + ".unreadable-*.json"))
                {
                    if (File.ReadAllBytes(earlier).AsSpan().SequenceEqual(bytes)) { backup = earlier; break; }
                }
                if (backup == null)
                {
                    string stem = Path.Combine(Directory, Path.GetFileNameWithoutExtension(path) + ".unreadable-" +
                        DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
                    backup = stem + ".json";
                    for (int n = 2; File.Exists(backup); n++) backup = stem + "-" + n + ".json";
                    File.Copy(path, backup, overwrite: false);
                }
                problems.Add($"{name} could not be read ({readError.Message}).\n" +
                    $"An exact copy was saved as {backup}, and nothing was overwritten. {fallback}");
                return true;
            }
            catch (Exception copyError)
            {
                problems.Add($"{name} could not be read ({readError.Message}), and it could not be copied aside ({copyError.Message}).\n" +
                    $"It was left untouched, and changes will not be saved over it until Shorthand Expander is restarted and can read or copy it. {fallback}");
                return false;
            }
        }

        private static string BlockedMessage(string path) =>
            $"{Path.GetFileName(path)} could not be read or copied aside when Shorthand Expander started, so it is not being saved over. " +
            "Restart Shorthand Expander once the file can be read.";

        /// <summary>
        /// Before an import changes the list: writes the list in use, in the shared file format, to
        /// "shorthands.before-import-yyyyMMdd-HHmmss.json" beside shorthands.json (a numbered name when that one is taken),
        /// so Import can bring it back. An earlier copy is never overwritten. Returns the copy's path; throws, leaving the
        /// list and shorthands.json unchanged, when the copy cannot be written.
        /// </summary>
        public string KeepCopyBeforeImport() => KeepCopyBeforeImport(DateTime.Now);

        internal string KeepCopyBeforeImport(DateTime now)
        {
            string contents = Serialize(Shorthands);
            System.IO.Directory.CreateDirectory(Directory);
            string stem = Path.Combine(Directory, Path.GetFileNameWithoutExtension(ShorthandsPath) + ".before-import-" +
                now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
            string copy = stem + ".json";
            for (int n = 2; File.Exists(copy); n++) copy = stem + "-" + n + ".json";
            WriteAtomically(copy, contents, replace: false);
            return copy;
        }

        /// <summary>
        /// Writes to a temp file beside the target, then swaps it in, so a crash mid-write cannot truncate the target.
        /// With replace false, an existing target is never overwritten: the swap throws instead.
        /// </summary>
        private static void WriteAtomically(string path, string contents, bool replace = true)
        {
            string temp = path + ".tmp";
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream))
            {
                writer.Write(contents);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            if (replace && File.Exists(path)) File.Replace(temp, path, path + ".bak", ignoreMetadataErrors: true);
            else File.Move(temp, path);
        }

        public static string Serialize(IEnumerable<Shorthand> list)
        {
            var file = new ShorthandFile { Version = 1, Shorthands = new List<Shorthand>(list) };
            return JsonSerializer.Serialize(file, JsonOptions);
        }

        /// <summary>Parse the shared file format (or a bare array) into a sanitized list.</summary>
        public static List<Shorthand> ParseFile(string json)
        {
            using var doc = JsonDocument.Parse(json);
            JsonElement arr = FindArray(doc.RootElement);
            var list = new List<Shorthand?>();
            foreach (var el in arr.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Object) continue;
                string trigger = el.TryGetProperty("trigger", out var t) ? (t.ToString() ?? "") : "";
                string expansion = el.TryGetProperty("expansion", out var e) ? (e.ToString() ?? "") : "";
                list.Add(new Shorthand(trigger, expansion));
            }
            return Expander.Sanitize(list);
        }

        private static JsonElement FindArray(JsonElement root)
        {
            if (root.ValueKind == JsonValueKind.Array) return root;
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("shorthands", out var prop) &&
                prop.ValueKind == JsonValueKind.Array) return prop;
            throw new FormatException("No \"shorthands\" array found.");
        }

        public static List<Shorthand> DefaultShorthands() => new List<Shorthand>
        {
            new Shorthand("cool/", "That is really cool, thanks for sharing!"),
            new Shorthand("sig/", "Best regards,\n{cursor}"),
            new Shorthand("td/", "{date}"),
        };
    }
}
