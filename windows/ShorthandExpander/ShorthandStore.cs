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
            bool shorthandsBlocked = false, settingsBlocked = false;
            try
            {
                list = File.Exists(ShorthandsPath) ? ParseFile(File.ReadAllText(ShorthandsPath)) : DefaultShorthands();
            }
            catch (Exception ex)
            {
                // Start empty, but keep the unreadable file: the next save would otherwise overwrite it.
                list = new List<Shorthand>();
                shorthandsBlocked = !CopyAside(ShorthandsPath, ex, "Your shorthand list started empty.", problems);
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
                settingsBlocked = !CopyAside(SettingsPath, ex, "Default settings are in use.", problems);
            }
            lock (_lock)
            {
                _shorthands = list;
                _settings = settings;
            }
            ShorthandsSaveBlocked = shorthandsBlocked;
            SettingsSaveBlocked = settingsBlocked;
            LoadProblem = problems.Count == 0 ? null : string.Join("\n\n", problems);
            if (!File.Exists(ShorthandsPath)) SaveShorthands(list);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SaveShorthands(IEnumerable<Shorthand> list)
        {
            if (ShorthandsSaveBlocked) throw new InvalidOperationException(BlockedMessage(ShorthandsPath));
            var clean = Expander.Sanitize(list);
            lock (_lock) _shorthands = clean;
            System.IO.Directory.CreateDirectory(Directory);
            WriteAtomically(ShorthandsPath, Serialize(clean));
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SaveSettings(AppSettings settings)
        {
            if (SettingsSaveBlocked) throw new InvalidOperationException(BlockedMessage(SettingsPath));
            lock (_lock) _settings = new AppSettings { Enabled = settings.Enabled, ShiftEnterForNewlines = settings.ShiftEnterForNewlines };
            System.IO.Directory.CreateDirectory(Directory);
            WriteAtomically(SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
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
                string stem = Path.Combine(Directory, Path.GetFileNameWithoutExtension(path) + ".unreadable-" +
                    DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
                string backup = stem + ".json";
                for (int n = 2; File.Exists(backup); n++) backup = stem + "-" + n + ".json";
                File.Copy(path, backup, overwrite: false);
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

        /// <summary>Writes to a temp file beside the target, then swaps it in, so a crash mid-write cannot truncate the target.</summary>
        private static void WriteAtomically(string path, string contents)
        {
            string temp = path + ".tmp";
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream))
            {
                writer.Write(contents);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(path)) File.Replace(temp, path, path + ".bak", ignoreMetadataErrors: true);
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
            JsonElement arr;
            if (doc.RootElement.ValueKind == JsonValueKind.Array)
            {
                arr = doc.RootElement;
            }
            else if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                     doc.RootElement.TryGetProperty("shorthands", out var prop) &&
                     prop.ValueKind == JsonValueKind.Array)
            {
                arr = prop;
            }
            else
            {
                throw new FormatException("No \"shorthands\" array found.");
            }
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

        public static List<Shorthand> DefaultShorthands() => new List<Shorthand>
        {
            new Shorthand("cool/", "That is really cool, thanks for sharing!"),
            new Shorthand("sig/", "Best regards,\n{cursor}"),
            new Shorthand("td/", "{date}"),
        };
    }
}
