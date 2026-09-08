using System;
using System.Text;
using System.Threading.Tasks;

namespace ShorthandExpander
{
    /// <summary>
    /// Keeps a buffer of what the user has typed since the last "reset" (click,
    /// window switch, navigation key) and fires an expansion when the buffer
    /// ends with a trigger.
    /// </summary>
    public sealed class ExpansionEngine
    {
        private const int MaxBuffer = 200;

        private readonly ShorthandStore _store;
        private readonly KeyboardHook _hook;
        private readonly StringBuilder _buffer = new StringBuilder();

        public event EventHandler<Shorthand>? Expanded;

        public ExpansionEngine(ShorthandStore store, KeyboardHook hook)
        {
            _store = store;
            _hook = hook;
            _hook.KeyTyped = OnKeyTyped;
            _hook.FocusChanged = ResetBuffer;
        }

        public void ResetBuffer() => _buffer.Clear();

        /// <summary>Returns true when the key should be swallowed.</summary>
        private bool OnKeyTyped(TypedKey key)
        {
            var settings = _store.Settings;
            if (!settings.Enabled) { _buffer.Clear(); return false; }

            if (key.IsBackspace)
            {
                if (_buffer.Length > 0)
                {
                    int remove = 1;
                    if (_buffer.Length > 1 && char.IsLowSurrogate(_buffer[_buffer.Length - 1]) &&
                        char.IsHighSurrogate(_buffer[_buffer.Length - 2])) remove = 2;
                    _buffer.Length -= remove;
                }
                return false;
            }
            if (key.ResetsBuffer) { _buffer.Clear(); return false; }
            if (key.Text.Length == 0) return false;

            // Never expand while typing inside our own settings window.
            if (_hook.ForegroundIsOwnProcess()) { _buffer.Clear(); return false; }

            _buffer.Append(key.Text);
            if (_buffer.Length > MaxBuffer) _buffer.Remove(0, _buffer.Length - MaxBuffer);

            var match = Expander.FindMatch(_buffer.ToString(), _store.Shorthands);
            if (match == null) return false;

            var sh = match.Value.Shorthand;
            var rendered = Expander.Render(sh.Expansion);
            // The key that completed the trigger is swallowed, so only the characters
            // already on screen need deleting.
            int backspaces = sh.Trigger.Length - key.Text.Length;
            if (backspaces < 0) backspaces = 0;
            _buffer.Clear();

            bool shiftEnter = settings.ShiftEnterForNewlines;
            Task.Run(() =>
            {
                try
                {
                    TextSender.Replace(backspaces, rendered.Text, rendered.CursorOffset, shiftEnter);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine("Expansion failed: " + ex);
                }
            });
            Expanded?.Invoke(this, sh);
            return true;
        }
    }
}
