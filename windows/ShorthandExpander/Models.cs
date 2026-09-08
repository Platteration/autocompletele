using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace ShorthandExpander
{
    /// <summary>One shorthand: a trigger the user types and the text it expands to.</summary>
    public sealed class Shorthand
    {
        [JsonPropertyName("trigger")]
        public string Trigger { get; set; } = "";

        [JsonPropertyName("expansion")]
        public string Expansion { get; set; } = "";

        public Shorthand() { }

        public Shorthand(string trigger, string expansion)
        {
            Trigger = trigger;
            Expansion = expansion;
        }
    }

    /// <summary>The cross-platform JSON file format described in shared/SPEC.md.</summary>
    public sealed class ShorthandFile
    {
        [JsonPropertyName("version")]
        public int Version { get; set; } = 1;

        [JsonPropertyName("shorthands")]
        public List<Shorthand> Shorthands { get; set; } = new List<Shorthand>();
    }

    public sealed class AppSettings
    {
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; } = true;

        /// <summary>Send Shift+Enter instead of Enter for new lines (useful in chat apps).</summary>
        [JsonPropertyName("shiftEnterForNewlines")]
        public bool ShiftEnterForNewlines { get; set; } = false;
    }
}
