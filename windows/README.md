# Shorthand Expander – Windows

A small tray application that expands shorthands such as `cool/` into full
text in **any** Windows application: browsers, Office, chat apps, editors.

It installs a low-level keyboard hook, remembers what you have typed since the
last click / window switch, and when that ends with one of your triggers it
sends Backspaces to delete the trigger and types the expansion in its place.

## Build

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download) on Windows.

```
cd windows
dotnet build -c Release
dotnet run --project ShorthandExpander          # start the tray app
dotnet run --project ShorthandExpander.Tests    # run the logic tests
```

To produce a single self-contained `ShorthandExpander.exe`:

```
dotnet publish ShorthandExpander -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

The executable lands in `ShorthandExpander\bin\Release\net8.0-windows\win-x64\publish\`.

## Use

* The app lives in the system tray. Double-click the icon (or right-click →
  **Manage shorthands…**) to add, edit, delete, import and export shorthands.
* Right-click → **Enabled** pauses/resumes expansion; the tray tooltip shows
  the state.
* **Start with Windows** registers the app under `HKCU\...\Run`.
* Shorthands are stored in `%APPDATA%\ShorthandExpander\shorthands.json`, the
  same format used by the Chrome extension and the Android app
  (see `../shared/SPEC.md`), so you can copy the file between devices or use
  the Import / Export buttons.
* Placeholders `{date}`, `{time}`, `{datetime}` and `{cursor}` are supported.

## Notes and limitations

* Windows only lets a normal-privilege hook see input going to normal-privilege
  windows. To expand text inside programs running **as administrator**, run
  Shorthand Expander as administrator too.
* Multi-line expansions are typed with Enter. In chat apps where Enter sends
  the message, turn on **Use Shift+Enter for new lines** in the settings.
* Typing is tracked from key presses, so characters produced through dead keys
  or an IME may not be recognised as part of a trigger. Keep triggers to plain
  ASCII (e.g. `addr/`, `sig;`) for the most reliable results.
* Expansion is disabled while the Shorthand Expander window itself has focus,
  so you can type a trigger's text into the editor without it firing.

## Project layout

| File                        | Purpose                                                   |
| --------------------------- | --------------------------------------------------------- |
| `Program.cs`                | Entry point, single-instance guard                        |
| `TrayApplicationContext.cs` | Tray icon, menu, wires everything together                |
| `SettingsForm.cs`           | Management window (add/edit/delete/import/export)         |
| `KeyboardHook.cs`           | Low-level keyboard/mouse hooks, key → text translation    |
| `ExpansionEngine.cs`        | Typing buffer and trigger detection                       |
| `TextSender.cs`             | Sends Backspaces and the expansion via `SendInput`        |
| `Expander.cs`               | Pure matching / placeholder logic (same rules as the extension) |
| `ShorthandStore.cs`         | JSON persistence in `%APPDATA%`                           |
| `NativeMethods.cs`          | Win32 P/Invoke declarations                               |
