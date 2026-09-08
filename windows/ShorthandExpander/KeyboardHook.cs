using System;
using System.Diagnostics;
using System.Text;
using static ShorthandExpander.NativeMethods;

namespace ShorthandExpander
{
    /// <summary>Information about a key press, translated to text where possible.</summary>
    public sealed class TypedKey
    {
        /// <summary>Virtual-key code.</summary>
        public int VirtualKey { get; init; }
        /// <summary>The characters this key press produces, or an empty string for non-text keys.</summary>
        public string Text { get; init; } = "";
        /// <summary>True when the key should reset the typing buffer (navigation, shortcuts, ...).</summary>
        public bool ResetsBuffer { get; init; }
        /// <summary>True for Backspace.</summary>
        public bool IsBackspace { get; init; }
    }

    /// <summary>
    /// Global low-level keyboard hook. Raises <see cref="KeyTyped"/> on the thread that
    /// installed the hook (which must run a message loop). Return true from the handler
    /// to swallow the key.
    /// </summary>
    public sealed class KeyboardHook : IDisposable
    {
        private readonly LowLevelProc _keyboardProc;
        private readonly LowLevelProc _mouseProc;
        private readonly WinEventDelegate _foregroundProc;
        private IntPtr _keyboardHook;
        private IntPtr _mouseHook;
        private IntPtr _foregroundHook;
        private readonly int _ownPid = Environment.ProcessId;

        /// <summary>Fired for every physical key-down. Return true to swallow the key.</summary>
        public Func<TypedKey, bool>? KeyTyped { get; set; }

        /// <summary>Fired when the user clicks the mouse or switches window.</summary>
        public Action? FocusChanged { get; set; }

        public KeyboardHook()
        {
            _keyboardProc = KeyboardCallback;
            _mouseProc = MouseCallback;
            _foregroundProc = ForegroundCallback;
        }

        public void Install()
        {
            if (_keyboardHook != IntPtr.Zero) return;
            IntPtr module = GetModuleHandle(null);
            _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, module, 0);
            if (_keyboardHook == IntPtr.Zero)
                throw new InvalidOperationException("Could not install the keyboard hook (error " +
                    System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ").");
            _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, module, 0);
            _foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero,
                _foregroundProc, 0, 0, WINEVENT_OUTOFCONTEXT);
        }

        /// <summary>True when the window that has the focus belongs to this process.</summary>
        public bool ForegroundIsOwnProcess()
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return false;
            GetWindowThreadProcessId(hwnd, out uint pid);
            return pid == (uint)_ownPid;
        }

        private IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = (int)wParam;
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
                {
                    var info = System.Runtime.InteropServices.Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                    if ((info.flags & LLKHF_INJECTED) == 0)
                    {
                        bool swallow = false;
                        try
                        {
                            var key = Translate(info);
                            swallow = KeyTyped?.Invoke(key) ?? false;
                        }
                        catch (Exception ex)
                        {
                            Debug.WriteLine("Keyboard hook handler failed: " + ex);
                        }
                        if (swallow) return (IntPtr)1;
                    }
                }
            }
            return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
        }

        private IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = (int)wParam;
                if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN)
                {
                    var info = System.Runtime.InteropServices.Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                    if ((info.flags & LLMHF_INJECTED) == 0)
                    {
                        try { FocusChanged?.Invoke(); } catch (Exception ex) { Debug.WriteLine(ex); }
                    }
                }
            }
            return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
        }

        private void ForegroundCallback(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
        {
            try { FocusChanged?.Invoke(); } catch (Exception ex) { Debug.WriteLine(ex); }
        }

        private static bool IsDown(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;

        private static TypedKey Translate(KBDLLHOOKSTRUCT info)
        {
            int vk = (int)info.vkCode;

            if (vk == VK_BACK) return new TypedKey { VirtualKey = vk, IsBackspace = true };

            switch (vk)
            {
                case VK_TAB:
                case VK_RETURN:
                case VK_ESCAPE:
                case VK_PRIOR:
                case VK_NEXT:
                case VK_END:
                case VK_HOME:
                case VK_LEFT:
                case VK_UP:
                case VK_RIGHT:
                case VK_DOWN:
                case VK_DELETE:
                    return new TypedKey { VirtualKey = vk, ResetsBuffer = true };
                case VK_SHIFT:
                case VK_LSHIFT:
                case VK_RSHIFT:
                case VK_CONTROL:
                case VK_LCONTROL:
                case VK_RCONTROL:
                case VK_MENU:
                case VK_LMENU:
                case VK_RMENU:
                case VK_CAPITAL:
                case VK_LWIN:
                case VK_RWIN:
                    return new TypedKey { VirtualKey = vk }; // modifiers alone do nothing
            }

            bool ctrl = IsDown(VK_CONTROL);
            bool alt = IsDown(VK_MENU);
            bool win = IsDown(VK_LWIN) || IsDown(VK_RWIN);
            bool altGr = ctrl && alt; // AltGr is reported as Ctrl+Alt

            if (win || (ctrl && !altGr) || (alt && !altGr))
            {
                // A keyboard shortcut, not typing.
                return new TypedKey { VirtualKey = vk, ResetsBuffer = true };
            }

            var state = new byte[256];
            if (IsDown(VK_SHIFT)) state[VK_SHIFT] = 0x80;
            if (ctrl) state[VK_CONTROL] = 0x80;
            if (alt) state[VK_MENU] = 0x80;
            if ((GetKeyState(VK_CAPITAL) & 0x1) != 0) state[VK_CAPITAL] = 0x01;

            IntPtr layout = IntPtr.Zero;
            IntPtr fg = GetForegroundWindow();
            if (fg != IntPtr.Zero)
            {
                uint tid = GetWindowThreadProcessId(fg, out _);
                layout = GetKeyboardLayout(tid);
            }

            var sb = new StringBuilder(8);
            int n = ToUnicodeEx((uint)vk, info.scanCode, state, sb, sb.Capacity, TOUNICODE_NO_STATE_CHANGE, layout);
            if (n > 0)
            {
                string text = sb.ToString(0, n);
                // Control characters (e.g. Ctrl+letter) are not typing.
                foreach (char c in text)
                {
                    if (char.IsControl(c)) return new TypedKey { VirtualKey = vk, ResetsBuffer = true };
                }
                return new TypedKey { VirtualKey = vk, Text = text };
            }
            // n < 0: dead key; n == 0: no character. Neither changes the buffer.
            return new TypedKey { VirtualKey = vk };
        }

        public void Dispose()
        {
            if (_keyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(_keyboardHook); _keyboardHook = IntPtr.Zero; }
            if (_mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; }
            if (_foregroundHook != IntPtr.Zero) { UnhookWinEvent(_foregroundHook); _foregroundHook = IntPtr.Zero; }
            GC.KeepAlive(_keyboardProc);
            GC.KeepAlive(_mouseProc);
            GC.KeepAlive(_foregroundProc);
        }
    }
}
