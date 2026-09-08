using System;
using System.Collections.Generic;
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
            try
            {
                list = File.Exists(ShorthandsPath) ? ParseFile(File.ReadAllText(ShorthandsPath)) : DefaultShorthands();
            }
            catch
            {
                list = new List<Shorthand>();
            }
            try
            {
                settings = File.Exists(SettingsPath)
                    ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath), JsonOptions) ?? new AppSettings()
                    : new AppSettings();
            }
            catch
            {
                settings = new AppSettings();
            }
            lock (_lock)
            {
                _shorthands = list;
                _settings = settings;
            }
            if (!File.Exists(ShorthandsPath)) SaveShorthands(list);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SaveShorthands(IEnumerable<Shorthand> list)
        {
            var clean = Expander.Sanitize(list);
            lock (_lock) _shorthands = clean;
            System.IO.Directory.CreateDirectory(Directory);
            File.WriteAllText(ShorthandsPath, Serialize(clean));
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SaveSettings(AppSettings settings)
        {
            lock (_lock) _settings = new AppSettings { Enabled = settings.Enabled, ShiftEnterForNewlines = settings.ShiftEnterForNewlines };
            System.IO.Directory.CreateDirectory(Directory);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
            Changed?.Invoke(this, EventArgs.Empty);
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
