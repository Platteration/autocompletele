using System;
using System.Drawing;
using System.Windows.Forms;

namespace ShorthandExpander
{
    /// <summary>Runs the app from the system tray: installs the hook, shows the menu and settings.</summary>
    internal sealed class TrayApplicationContext : ApplicationContext
    {
        private readonly NotifyIcon _tray;
        private readonly ShorthandStore _store;
        private readonly KeyboardHook _hook;
        private readonly ExpansionEngine _engine;
        private readonly ToolStripMenuItem _enabledItem;
        private SettingsForm? _settingsForm;

        public TrayApplicationContext()
        {
            _store = new ShorthandStore();
            _store.Load();

            _hook = new KeyboardHook();
            _engine = new ExpansionEngine(_store, _hook);

            _enabledItem = new ToolStripMenuItem("Enabled", null, (_, _) => ToggleEnabled())
            {
                CheckOnClick = false,
                Checked = _store.Settings.Enabled,
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add(new ToolStripMenuItem("Manage shorthands…", null, (_, _) => ShowSettings()) { Font = new Font(menu.Font, FontStyle.Bold) });
            menu.Items.Add(_enabledItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit", null, (_, _) => ExitThread()));

            _tray = new NotifyIcon
            {
                Icon = LoadIcon(),
                Text = "Shorthand Expander",
                ContextMenuStrip = menu,
                Visible = true,
            };
            _tray.DoubleClick += (_, _) => ShowSettings();
            _store.Changed += (_, _) => UpdateTrayState();

            try
            {
                _hook.Install();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not start the keyboard hook:\n" + ex.Message, "Shorthand Expander",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }

            UpdateTrayState();
            if (_store.Shorthands.Count == 0) ShowSettings();
            else _tray.ShowBalloonTip(3000, "Shorthand Expander is running",
                "Type a trigger such as cool/ in any app to expand it. Double-click the tray icon to manage shorthands.",
                ToolTipIcon.Info);
        }

        private static Icon LoadIcon()
        {
            try
            {
                var icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (icon != null) return icon;
            }
            catch { /* fall through */ }
            return SystemIcons.Application;
        }

        private void ToggleEnabled()
        {
            var s = _store.Settings;
            s.Enabled = !s.Enabled;
            _store.SaveSettings(s);
        }

        private void UpdateTrayState()
        {
            if (_tray.ContextMenuStrip?.InvokeRequired == true)
            {
                _tray.ContextMenuStrip.BeginInvoke(new Action(UpdateTrayState));
                return;
            }
            bool enabled = _store.Settings.Enabled;
            _enabledItem.Checked = enabled;
            _tray.Text = enabled
                ? $"Shorthand Expander – {_store.Shorthands.Count} shorthand(s)"
                : "Shorthand Expander – paused";
        }

        private void ShowSettings()
        {
            if (_settingsForm == null || _settingsForm.IsDisposed)
            {
                _settingsForm = new SettingsForm(_store);
            }
            _settingsForm.Show();
            if (_settingsForm.WindowState == FormWindowState.Minimized) _settingsForm.WindowState = FormWindowState.Normal;
            _settingsForm.Activate();
        }

        protected override void ExitThreadCore()
        {
            _tray.Visible = false;
            _hook.Dispose();
            _tray.Dispose();
            base.ExitThreadCore();
        }
    }
}
