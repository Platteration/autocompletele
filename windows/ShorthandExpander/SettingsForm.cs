using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using Registry = Microsoft.Win32.Registry;

namespace ShorthandExpander
{
    /// <summary>Window for adding, editing, importing and exporting shorthands.</summary>
    internal sealed class SettingsForm : Form
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "ShorthandExpander";

        private readonly ShorthandStore _store;
        private readonly List<Shorthand> _items;

        private readonly ListView _list = new ListView();
        private readonly TextBox _trigger = new TextBox();
        private readonly TextBox _expansion = new TextBox();
        private readonly Button _add = new Button();
        private readonly Button _save = new Button();
        private readonly Button _delete = new Button();
        private readonly CheckBox _enabled = new CheckBox();
        private readonly CheckBox _shiftEnter = new CheckBox();
        private readonly CheckBox _startup = new CheckBox();
        private readonly Label _status = new Label();

        private int _editingIndex = -1;

        public SettingsForm(ShorthandStore store)
        {
            _store = store;
            _items = store.Shorthands.Select(s => new Shorthand(s.Trigger, s.Expansion)).ToList();
            BuildUi();
            RefreshList();
            LoadSettings();
        }

        private void BuildUi()
        {
            Text = "Shorthand Expander";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(640, 520);
            Size = new Size(760, 560);
            Font = new Font("Segoe UI", 9.5f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* ignore */ }

            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(12),
                ColumnCount = 1,
                RowCount = 4,
            };
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            // --- header / settings -------------------------------------------------
            var header = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
            var hint = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(720, 0),
                Text = "Type a trigger such as cool/ in any application and it is replaced by its expansion.\n" +
                       "Placeholders: {date}, {time}, {datetime}, {cursor}. The trigger only fires after a space, punctuation or at the start of a line.",
            };
            _enabled.Text = "Expansion enabled";
            _enabled.AutoSize = true;
            _enabled.CheckedChanged += (_, _) => SaveSettings();
            _shiftEnter.Text = "Use Shift+Enter for new lines (recommended for chat apps such as Teams, Slack, Discord)";
            _shiftEnter.AutoSize = true;
            _shiftEnter.CheckedChanged += (_, _) => SaveSettings();
            _startup.Text = "Start with Windows";
            _startup.AutoSize = true;
            _startup.CheckedChanged += (_, _) => ApplyStartup();
            header.Controls.AddRange(new Control[] { hint, _enabled, _shiftEnter, _startup });
            root.Controls.Add(header, 0, 0);

            // --- list ----------------------------------------------------------------
            _list.Dock = DockStyle.Fill;
            _list.View = View.Details;
            _list.FullRowSelect = true;
            _list.HideSelection = false;
            _list.MultiSelect = false;
            _list.Columns.Add("Trigger", 140);
            _list.Columns.Add("Expansion", 540);
            _list.SelectedIndexChanged += (_, _) => OnSelectionChanged();
            _list.Resize += (_, _) => _list.Columns[1].Width = Math.Max(200, _list.ClientSize.Width - _list.Columns[0].Width - 4);
            root.Controls.Add(_list, 0, 1);

            // --- editor ---------------------------------------------------------------
            var editor = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, Margin = new Padding(0, 8, 0, 0) };
            editor.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80));
            editor.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            editor.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            editor.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            editor.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            editor.Controls.Add(new Label { Text = "Trigger", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 0, 0) }, 0, 0);
            _trigger.Dock = DockStyle.Fill;
            _trigger.PlaceholderText = "cool/";
            editor.Controls.Add(_trigger, 1, 0);

            editor.Controls.Add(new Label { Text = "Expansion", AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Top, Margin = new Padding(0, 6, 0, 0) }, 0, 1);
            _expansion.Dock = DockStyle.Fill;
            _expansion.Multiline = true;
            _expansion.AcceptsReturn = true;
            _expansion.ScrollBars = ScrollBars.Vertical;
            _expansion.PlaceholderText = "That is really cool, thanks for sharing!";
            editor.Controls.Add(_expansion, 1, 1);

            var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
            _add.Text = "Add";
            _add.AutoSize = true;
            _add.Click += (_, _) => AddOrSave(asNew: true);
            _save.Text = "Save changes";
            _save.AutoSize = true;
            _save.Click += (_, _) => AddOrSave(asNew: false);
            _delete.Text = "Delete";
            _delete.AutoSize = true;
            _delete.Click += (_, _) => DeleteSelected();
            var clear = new Button { Text = "New", AutoSize = true };
            clear.Click += (_, _) => ClearEditor();
            var import = new Button { Text = "Import JSON…", AutoSize = true };
            import.Click += (_, _) => Import();
            var export = new Button { Text = "Export JSON…", AutoSize = true };
            export.Click += (_, _) => Export();
            buttons.Controls.AddRange(new Control[] { _add, _save, _delete, clear, import, export });
            editor.Controls.Add(buttons, 1, 2);
            root.Controls.Add(editor, 0, 2);

            // --- status ---------------------------------------------------------------
            _status.AutoSize = true;
            _status.ForeColor = SystemColors.GrayText;
            _status.Margin = new Padding(0, 6, 0, 0);
            root.Controls.Add(_status, 0, 3);

            Controls.Add(root);
            AcceptButton = null;
            ClearEditor();
        }

        private void RefreshList()
        {
            _list.BeginUpdate();
            _list.Items.Clear();
            foreach (var sh in _items)
            {
                var item = new ListViewItem(sh.Trigger);
                item.SubItems.Add(sh.Expansion.Replace("\r", "").Replace("\n", " ⏎ "));
                _list.Items.Add(item);
            }
            _list.EndUpdate();
            _status.Text = $"{_items.Count} shorthand(s) – stored in {_store.ShorthandsPath}";
        }

        private void OnSelectionChanged()
        {
            if (_list.SelectedIndices.Count == 0) return;
            _editingIndex = _list.SelectedIndices[0];
            var sh = _items[_editingIndex];
            _trigger.Text = sh.Trigger;
            _expansion.Text = sh.Expansion.Replace("\r\n", "\n").Replace("\n", "\r\n");
            _save.Enabled = true;
            _delete.Enabled = true;
        }

        private void ClearEditor()
        {
            _editingIndex = -1;
            _list.SelectedIndices.Clear();
            _trigger.Text = "";
            _expansion.Text = "";
            _save.Enabled = false;
            _delete.Enabled = false;
            _trigger.Focus();
        }

        private void AddOrSave(bool asNew)
        {
            string trigger = _trigger.Text.Trim();
            string expansion = _expansion.Text.Replace("\r\n", "\n");
            if (trigger.Length == 0)
            {
                MessageBox.Show(this, "Please enter a trigger.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (trigger.Any(char.IsWhiteSpace))
            {
                MessageBox.Show(this, "A trigger cannot contain spaces.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            int target = asNew ? -1 : _editingIndex;
            for (int i = 0; i < _items.Count; i++)
            {
                if (i != target && _items[i].Trigger == trigger)
                {
                    MessageBox.Show(this, $"The trigger \"{trigger}\" is already used.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }
            if (target >= 0)
            {
                _items[target] = new Shorthand(trigger, expansion);
            }
            else
            {
                _items.Add(new Shorthand(trigger, expansion));
            }
            Persist();
            ClearEditor();
        }

        private void DeleteSelected()
        {
            if (_editingIndex < 0 || _editingIndex >= _items.Count) return;
            _items.RemoveAt(_editingIndex);
            Persist();
            ClearEditor();
        }

        private void Persist()
        {
            try
            {
                _store.SaveShorthands(_items);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not save shorthands:\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            RefreshList();
        }

        private void Import()
        {
            using var dlg = new OpenFileDialog { Filter = "JSON files (*.json)|*.json|All files|*.*", Title = "Import shorthands" };
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            List<Shorthand> list;
            try
            {
                list = ShorthandStore.ParseFile(File.ReadAllText(dlg.FileName));
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not read that file:\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (list.Count == 0)
            {
                MessageBox.Show(this, "No shorthands were found in that file.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (_items.Count > 0)
            {
                var answer = MessageBox.Show(this,
                    $"Replace your {_items.Count} shorthand(s) with the {list.Count} from the file?\n\nChoose No to merge them instead (imported triggers overwrite existing ones).",
                    Text, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) return;
                if (answer == DialogResult.No)
                {
                    var merged = _items.Where(e => list.All(n => n.Trigger != e.Trigger)).ToList();
                    merged.AddRange(list);
                    list = merged;
                }
            }
            _items.Clear();
            _items.AddRange(list);
            Persist();
            ClearEditor();
        }

        private void Export()
        {
            using var dlg = new SaveFileDialog { Filter = "JSON files (*.json)|*.json", FileName = "shorthands.json", Title = "Export shorthands" };
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            try
            {
                File.WriteAllText(dlg.FileName, ShorthandStore.Serialize(_items));
                _status.Text = $"Exported {_items.Count} shorthand(s) to {dlg.FileName}";
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not write that file:\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private bool _loadingSettings;

        private void LoadSettings()
        {
            _loadingSettings = true;
            var s = _store.Settings;
            _enabled.Checked = s.Enabled;
            _shiftEnter.Checked = s.ShiftEnterForNewlines;
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
                _startup.Checked = key?.GetValue(RunValueName) != null;
            }
            catch { _startup.Checked = false; }
            _loadingSettings = false;
        }

        private void SaveSettings()
        {
            if (_loadingSettings) return;
            _store.SaveSettings(new AppSettings { Enabled = _enabled.Checked, ShiftEnterForNewlines = _shiftEnter.Checked });
        }

        private void ApplyStartup()
        {
            if (_loadingSettings) return;
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
                if (key == null) return;
                if (_startup.Checked) key.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                else key.DeleteValue(RunValueName, throwOnMissingValue: false);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not update the startup setting:\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Closing the window keeps the app running in the tray.
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
