using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using static ShorthandExpander.NativeMethods;

namespace ShorthandExpander
{
    /// <summary>Injects keystrokes into the focused application with SendInput.</summary>
    public static class TextSender
    {
        private const int ChunkSize = 64;
        private static readonly object SendLock = new object();

        /// <summary>
        /// Delete <paramref name="backspaces"/> characters before the caret, type
        /// <paramref name="text"/>, then move the caret left so it lands at
        /// <paramref name="cursorOffset"/> characters into the inserted text.
        /// </summary>
        public static void Replace(int backspaces, string text, int cursorOffset, bool shiftEnterForNewlines)
        {
            lock (SendLock) ReplaceCore(backspaces, text, cursorOffset, shiftEnterForNewlines);
        }

        /// <summary>
        /// Reverse an expansion: delete <paramref name="charsAfterCaret"/> characters after the
        /// caret and <paramref name="charsBeforeCaret"/> before it, then type <paramref name="trigger"/>.
        /// </summary>
        public static void Undo(int charsBeforeCaret, int charsAfterCaret, string trigger)
        {
            lock (SendLock)
            {
                var inputs = new List<INPUT>();
                for (int i = 0; i < charsAfterCaret; i++) AddKey(inputs, VK_DELETE);
                for (int i = 0; i < charsBeforeCaret; i++) AddKey(inputs, VK_BACK);
                Flush(inputs);
                Thread.Sleep(10);
                foreach (char c in trigger) AddUnicode(inputs, c);
                Flush(inputs);
            }
        }

        /// <summary>Number of caret steps a piece of text occupies (newlines and surrogate pairs count once).</summary>
        public static int CaretSteps(string text)
        {
            int n = 0;
            foreach (char c in text)
            {
                if (c == '\r' || char.IsLowSurrogate(c)) continue;
                n++;
            }
            return n;
        }

        private static void ReplaceCore(int backspaces, string text, int cursorOffset, bool shiftEnterForNewlines)
        {
            var inputs = new List<INPUT>();
            for (int i = 0; i < backspaces; i++) AddKey(inputs, VK_BACK);
            Flush(inputs);
            Thread.Sleep(10);

            int caretSteps = 0;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r') continue; // \r\n and \n both become one Enter
                if (c == '\n')
                {
                    if (shiftEnterForNewlines) AddKeyDown(inputs, VK_SHIFT);
                    AddKey(inputs, VK_RETURN);
                    if (shiftEnterForNewlines) AddKeyUp(inputs, VK_SHIFT);
                }
                else
                {
                    AddUnicode(inputs, c);
                }
                // Count caret steps for the part after the {cursor} position.
                if (i >= cursorOffset && !char.IsLowSurrogate(c) && c != '\r') caretSteps++;
                if (inputs.Count >= ChunkSize) { Flush(inputs); Thread.Sleep(5); }
            }
            Flush(inputs);

            if (caretSteps > 0)
            {
                Thread.Sleep(10);
                for (int i = 0; i < caretSteps; i++) AddKey(inputs, VK_LEFT);
                Flush(inputs);
            }
        }

        private static void AddUnicode(List<INPUT> inputs, char c)
        {
            inputs.Add(new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE } }
            });
            inputs.Add(new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } }
            });
        }

        private static void AddKeyDown(List<INPUT> inputs, int vk)
        {
            inputs.Add(new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new INPUTUNION { ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = 0, dwFlags = 0 } }
            });
        }

        private static void AddKeyUp(List<INPUT> inputs, int vk)
        {
            inputs.Add(new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new INPUTUNION { ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP } }
            });
        }

        private static void AddKey(List<INPUT> inputs, int vk)
        {
            AddKeyDown(inputs, vk);
            AddKeyUp(inputs, vk);
        }

        private static void Flush(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            var arr = inputs.ToArray();
            inputs.Clear();
            SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
        }
    }
}
