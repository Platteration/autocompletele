using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace ShorthandExpander
{
    public readonly struct Match
    {
        public Shorthand Shorthand { get; }
        /// <summary>Index in the text where the trigger starts.</summary>
        public int Start { get; }

        public Match(Shorthand shorthand, int start)
        {
            Shorthand = shorthand;
            Start = start;
        }
    }

    public readonly struct Rendered
    {
        public string Text { get; }
        /// <summary>Where the caret should end up, measured from the start of Text.</summary>
        public int CursorOffset { get; }

        public Rendered(string text, int cursorOffset)
        {
            Text = text;
            CursorOffset = cursorOffset;
        }
    }

    /// <summary>
    /// Pure matching and placeholder logic. Mirrors chrome-extension/src/expander.js
    /// and the rules in shared/SPEC.md.
    /// </summary>
    public static class Expander
    {
        private static readonly Regex Escaped = new Regex(@"^\{\{([a-zA-Z]+)\}\}", RegexOptions.Compiled);
        private static readonly Regex Placeholder = new Regex(@"^\{([a-zA-Z]+)\}", RegexOptions.Compiled);

        /// <summary>A trigger may only fire after start-of-text, whitespace or punctuation.</summary>
        public static bool IsBoundary(char? ch)
        {
            if (ch == null) return true;
            char c = ch.Value;
            return !(char.IsLetter(c) || char.IsNumber(c) || c == '_');
        }

        public static Match? FindMatch(string? textBeforeCaret, IReadOnlyList<Shorthand>? shorthands)
        {
            if (string.IsNullOrEmpty(textBeforeCaret) || shorthands == null || shorthands.Count == 0) return null;
            Match? best = null;
            foreach (var sh in shorthands)
            {
                string t = sh?.Trigger ?? "";
                if (t.Length == 0 || t.Length > textBeforeCaret.Length) continue;
                if (!textBeforeCaret.EndsWith(t, StringComparison.Ordinal)) continue;
                int start = textBeforeCaret.Length - t.Length;
                char? before = start > 0 ? textBeforeCaret[start - 1] : (char?)null;
                if (!IsBoundary(before)) continue;
                if (best == null || t.Length > best.Value.Shorthand.Trigger.Length)
                {
                    best = new Match(sh!, start);
                }
            }
            return best;
        }

        public static Rendered Render(string? expansion) => Render(expansion, DateTime.Now);

        public static Rendered Render(string? expansion, DateTime now)
        {
            string src = expansion ?? "";
            string date = now.ToString("yyyy-MM-dd");
            string time = now.ToString("HH:mm");
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["date"] = date,
                ["time"] = time,
                ["datetime"] = date + " " + time,
            };

            var sb = new StringBuilder(src.Length);
            int cursor = -1;
            int i = 0;
            while (i < src.Length)
            {
                char ch = src[i];
                if (ch == '{')
                {
                    string rest = src.Substring(i);
                    var esc = Escaped.Match(rest);
                    if (esc.Success)
                    {
                        sb.Append('{').Append(esc.Groups[1].Value).Append('}');
                        i += esc.Length;
                        continue;
                    }
                    var m = Placeholder.Match(rest);
                    if (m.Success)
                    {
                        string name = m.Groups[1].Value.ToLowerInvariant();
                        if (name == "cursor")
                        {
                            if (cursor < 0) cursor = sb.Length;
                            i += m.Length;
                            continue;
                        }
                        if (values.TryGetValue(name, out var v))
                        {
                            sb.Append(v);
                            i += m.Length;
                            continue;
                        }
                    }
                }
                sb.Append(ch);
                i++;
            }
            string text = sb.ToString();
            if (cursor < 0) cursor = text.Length;
            return new Rendered(text, cursor);
        }

        /// <summary>Trim, drop empties and duplicates (first one wins).</summary>
        public static List<Shorthand> Sanitize(IEnumerable<Shorthand?>? list)
        {
            var result = new List<Shorthand>();
            if (list == null) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in list)
            {
                if (item == null) continue;
                string trigger = (item.Trigger ?? "").Trim();
                if (trigger.Length == 0 || !seen.Add(trigger)) continue;
                result.Add(new Shorthand(trigger, item.Expansion ?? ""));
            }
            return result;
        }
    }
}
