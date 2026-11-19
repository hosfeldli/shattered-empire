using System;
using System.Collections.Generic;
using SE.Runtime.App;
using SE.Runtime.Input;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The one Settings view (docs/UI_DESIGN_SPEC.md § B14), used identically by the main menu and the
    /// pause menu. It fills its parent (the parent frame decides the size): a header, a column of tabs
    /// (Graphics, Display, Audio, Interface, Camera, Controls), one scrolling pane and a footer with
    /// "Restore defaults (this tab)". Changing a value never rebuilds the view: only that row changes.
    /// Key rebinding is handled here; while it waits for a key <see cref="Capturing"/> is true and the
    /// view consumes Escape itself (Escape cancels the rebind).
    /// </summary>
    public sealed class SettingsView : VisualElement
    {
        static readonly string[] TabNames = { "Graphics", "Display", "Audio", "Interface", "Camera", "Controls" };

        static string capturing;
        static int captureEndedFrame = -1;

        /// <summary>True while a shortcut is waiting for its new key (and on the frame that ended it), so
        /// callers do not also treat that Escape/key as a navigation key.</summary>
        public static bool Capturing => capturing != null || captureEndedFrame == Time.frameCount;

        readonly IGameActions game;
        readonly VisualElement header;
        readonly UnityEngine.UIElements.Button backButton;
        readonly ScrollView pane;
        readonly Dictionary<string, UnityEngine.UIElements.Button> tabButtons = new Dictionary<string, UnityEngine.UIElements.Button>();
        readonly Dictionary<string, (UnityEngine.UIElements.Button key, Label conflict)> keyRows = new Dictionary<string, (UnityEngine.UIElements.Button, Label)>();
        IVisualElementScheduledItem poll;
        Action back;
        string tab = "Graphics";

        /// <summary>Back arrow in the header (hidden while null). Escape is handled by the owner of the frame.</summary>
        public Action Back
        {
            get => back;
            set { back = value; backButton.style.display = value != null ? DisplayStyle.Flex : DisplayStyle.None; }
        }

        /// <summary>Opens the sound and music credits (the field guide's credits). Null: they unfold in the Audio tab.</summary>
        public Action OpenCredits;

        /// <summary>The selected tab.</summary>
        public string Tab { get => tab; set => Select(value); }

        public SettingsView(IGameActions game)
        {
            this.game = game;
            AddToClassList("se-settings");
            style.flexGrow = 1;

            header = UiKit.El("se-settings-header", this);
            backButton = UiKit.IconButton("back", () => back?.Invoke(), "Back (Esc)", header);
            backButton.style.display = DisplayStyle.None;
            UiKit.Text("SETTINGS", "se-settings-title", header);

            var body = UiKit.El("se-settings-body", this);
            var tabs = UiKit.El("se-settings-tabs", body);
            foreach (var name in TabNames)
            {
                string t = name;
                tabButtons[t] = UiKit.Button(t, () => Select(t), tabs, null, "se-settings-tab");
            }
            pane = UiKit.BoundedScroll(body);
            pane.AddToClassList("se-settings-pane");

            var footer = UiKit.El("se-settings-footer", this);
            UiKit.Button("Restore defaults (this tab)", RestoreDefaults, footer);

            RegisterCallback<DetachFromPanelEvent>(_ => EndCapture(false, KeyCode.None));
            Select(tab);
        }

        void Select(string name)
        {
            if (Array.IndexOf(TabNames, name) < 0) name = "Graphics";
            EndCapture(false, KeyCode.None);
            tab = name;
            foreach (var kv in tabButtons) kv.Value.EnableInClassList("selected", kv.Key == name);
            pane.Clear();
            keyRows.Clear();
            pane.scrollOffset = Vector2.zero;
            var c = pane.contentContainer;
            switch (name)
            {
                case "Graphics": GraphicsTab(c); break;
                case "Display": DisplayTab(c); break;
                case "Audio": AudioTab(c); break;
                case "Interface": InterfaceTab(c); break;
                case "Camera": CameraTab(c); break;
                case "Controls": ControlsTab(c); break;
            }
            // the tab's rows ease in (staggered, at most a dozen steps)
            UiKit.EnterChildren(c, 0, 14);
        }

        // ------------------------------------------------------------------ tabs
        static string Percent(float v) => Mathf.RoundToInt(v * 100f) + "%";

        void GraphicsTab(VisualElement c)
        {
            var items = new (string id, string label, string icon)[] { ("low", "Low", null), ("medium", "Medium", null), ("high", "High", null), ("ultra", "Ultra", null) };
            var quality = UiKit.Segmented(items, PlayerPrefs.GetString("se.quality", "high"), p =>
            {
                game?.ApplyQuality(p);
                PlayerPrefs.SetString("se.quality", p);
                PlayerPrefs.Save();
            }, null, 88);
            UiKit.SettingRow("Quality", quality, c);
        }

        void DisplayTab(VisualElement c)
        {
            var items = new (string id, string label, string icon)[] { ("borderless", "Borderless", null), ("windowed", "Windowed", null) };
            string current = Screen.fullScreenMode == FullScreenMode.Windowed ? "windowed" : "borderless";
            var mode = UiKit.Segmented(items, current, SetWindowMode, null, 120);
            UiKit.SettingRow("Window mode", mode, c);
            UiKit.Text("Borderless fills the display without changing its resolution; windowed lasts for this session.", "se-settings-note", c);
        }

        static void SetWindowMode(string mode)
        {
            if (mode == "windowed")
                Screen.SetResolution(Mathf.Min(1600, Display.main.systemWidth - 120), Mathf.Min(900, Display.main.systemHeight - 120), FullScreenMode.Windowed);
            else
                Screen.SetResolution(Display.main.systemWidth, Display.main.systemHeight, FullScreenMode.FullScreenWindow);
        }

        void AudioTab(VisualElement c)
        {
            var a = game?.Audio;
            if (a == null) { UiKit.Text("Sound is not available.", "se-settings-note", c); return; }
            UiKit.SettingRow("Master volume", UiKit.SliderRow(a.Master, 0f, 1f, Percent, v => { a.Master = v; a.Save(); }), c);
            UiKit.SettingRow("Effects", UiKit.SliderRow(a.Effects, 0f, 1f, Percent, v => { a.Effects = v; a.Save(); }), c);
            UiKit.SettingRow("Ambience", UiKit.SliderRow(a.Ambience, 0f, 1f, Percent, v => { a.Ambience = v; a.Save(); }), c);
            UiKit.SettingRow("Music", UiKit.SliderRow(a.MusicVolume, 0f, 1f, Percent, v => { a.MusicVolume = v; a.Save(); }), c);
            Label credits = null;
            var open = UiKit.Button("Sound credits", () =>
            {
                if (OpenCredits != null) { OpenCredits(); return; }
                if (credits == null) return;
                credits.style.display = credits.resolvedStyle.display == DisplayStyle.None ? DisplayStyle.Flex : DisplayStyle.None;
            });
            UiKit.SettingRow("Credits", open, c);
            var text = Resources.Load<TextAsset>("Audio/Credits");
            credits = UiKit.Text(text != null ? text.text : "", "se-settings-note", c);
            credits.style.display = DisplayStyle.None;
        }

        void InterfaceTab(VisualElement c)
        {
            UiKit.SettingRow("Interface scale", UiKit.SliderRow(GameSettings.UiScale, 0.75f, 1.6f, Percent, v =>
            {
                GameSettings.UiScale = v;
                game?.ApplyUiScale(GameSettings.UiScale);
            }, true), c);
            UiKit.SettingRow("High-contrast markers", UiKit.Switch(GameSettings.HighContrastMarkers, v => GameSettings.HighContrastMarkers = v), c);
            UiKit.SettingRow("Open unit wheel on selection", UiKit.Switch(GameSettings.OpenUnitWheelOnSelection, v => GameSettings.OpenUnitWheelOnSelection = v), c);
            UiKit.SettingRow("Reduce UI motion", UiKit.Switch(GameSettings.ReduceUiMotion, v => { GameSettings.ReduceUiMotion = v; UiKit.ApplyMotion(this); }), c);
            UiKit.Text("Panels, wheels and counters change instantly instead of fading, sliding or counting.", "se-settings-note", c);
            UiKit.SettingRow("Check for updates on startup", UiKit.Switch(Updater.CheckOnStartup, v => Updater.CheckOnStartup = v), c);
            UiKit.SettingRow("Share diagnostics", UiKit.Switch(GameSettings.ShareDiagnostics, v => GameSettings.ShareDiagnostics = v), c);
            UiKit.Text("Sends anonymous performance, system and match statistics to the game server to help fix bugs and lag. No names or accounts.", "se-settings-note", c);
        }

        void CameraTab(VisualElement c)
        {
            UiKit.SettingRow("Edge pan", UiKit.Switch(GameSettings.EdgePan, v => GameSettings.EdgePan = v), c);
            UiKit.SettingRow("Pan speed", UiKit.SliderRow(GameSettings.CameraSpeed, 0.5f, 2f, v => v.ToString("0.0") + "×", v => GameSettings.CameraSpeed = v), c);
            UiKit.SettingRow("Screen shake", UiKit.Switch(GameSettings.ScreenShake, v => GameSettings.ScreenShake = v), c);
            UiKit.SettingRow("Reduced motion", UiKit.Switch(GameSettings.ReducedMotion, v => GameSettings.ReducedMotion = v), c);
            UiKit.SettingRow("Weather intensity", UiKit.SliderRow(GameSettings.WeatherIntensity, 0f, 1f, Percent, v => GameSettings.WeatherIntensity = v), c);
        }

        void ControlsTab(VisualElement c)
        {
            // Camera keys: two complete default sets. Switching swaps the whole set in place (the key list below
            // refreshes); custom binds survive unless their key now belongs to another action in the new set.
            var schemes = new (string id, string label, string icon)[] { ("arrows", "Arrow keys", null), ("wasd", "WASD", null) };
            Label schemeNote = null;
            var scheme = UiKit.Segmented(schemes, InputFacade.WasdScheme ? "wasd" : "arrows", p =>
            {
                var reset = InputFacade.SetWasdScheme(p == "wasd");
                RefreshKeys();
                if (schemeNote != null) schemeNote.text = SchemeNote(reset);
            }, null, 120);
            UiKit.SettingRow("Camera keys", scheme, c);
            schemeNote = UiKit.Text(SchemeNote(null), "se-settings-note", c);
            UiKit.Text("Click a key, then press the new key. Escape keeps the old one.", "se-settings-note", c);
            foreach (var act in InputFacade.Actions)
            {
                string id = act.Id;
                var row = UiKit.El("se-setting-row", c);
                UiKit.Text(act.Label, "se-key-label", row);
                var key = UiKit.Button(KeyName(InputFacade.KeyFor(id)), () => BeginCapture(id), row, null, "se-keycap");
                var conflict = UiKit.Text("", "se-key-conflict", row);
                keyRows[id] = (key, conflict);
            }
            UpdateConflicts();
        }

        static string SchemeNote(List<string> reset)
        {
            string s = InputFacade.WasdScheme
                ? "WASD: W/A/S/D pan (the arrow keys too); Q selects the units on screen (Ctrl+Q every unit); stance and withdraw move to V and X."
                : "Arrow keys: the arrows pan; A selects the units on screen (Ctrl+A every unit); S stance, W withdraw.";
            s += " Both: F attack move, E production buildings (Ctrl+E every building), Ctrl + double-click a building selects that type everywhere.";
            s += " Switching keeps your own keys unless the new set needs them.";
            if (reset != null && reset.Count > 0) s += "\nReset to the new set (their key was taken): " + string.Join("; ", reset) + ".";
            return s;
        }

        /// <summary>Re-reads every key in the list (after a scheme switch) without rebuilding the tab.</summary>
        void RefreshKeys()
        {
            foreach (var kv in keyRows) UiKit.SetText(kv.Value.key, KeyName(InputFacade.KeyFor(kv.Key)));
            UpdateConflicts();
        }

        // ------------------------------------------------------------------ rebinding
        void BeginCapture(string id)
        {
            if (capturing != null) EndCapture(false, KeyCode.None);
            if (!keyRows.TryGetValue(id, out var row)) return;
            capturing = id;
            UiKit.SetText(row.key, "Press a key…");
            row.key.EnableInClassList("selected", true);
            poll?.Pause();
            poll = schedule.Execute(PollKey).Every(0);
        }

        void PollKey()
        {
            if (capturing == null) { poll?.Pause(); return; }
            var k = InputFacade.AnyKeyPressed();
            if (k == KeyCode.None) return;
            EndCapture(k != KeyCode.Escape, k);
        }

        void EndCapture(bool apply, KeyCode k)
        {
            poll?.Pause();
            poll = null;
            if (capturing == null) return;
            string id = capturing;
            capturing = null;
            captureEndedFrame = Time.frameCount;
            if (apply) InputFacade.Rebind(id, k);
            if (keyRows.TryGetValue(id, out var row))
            {
                UiKit.SetText(row.key, KeyName(InputFacade.KeyFor(id)));
                row.key.EnableInClassList("selected", false);
            }
            UpdateConflicts();
        }

        /// <summary>Another action on the same key shows in amber beside the key (deliberate shared defaults, such as
        /// Attack move and Flip on F, are not conflicts).</summary>
        void UpdateConflicts()
        {
            foreach (var kv in keyRows)
            {
                var key = InputFacade.KeyFor(kv.Key);
                string other = null;
                InputFacade.ActionDef self = null;
                foreach (var a in InputFacade.Actions) if (a.Id == kv.Key) self = a;
                foreach (var a in InputFacade.Actions)
                {
                    if (a.Id == kv.Key || InputFacade.KeyFor(a.Id) != key || key == KeyCode.None) continue;
                    bool sharedDefault = self != null && InputFacade.DefaultKey(a) == InputFacade.DefaultKey(self) && key == InputFacade.DefaultKey(self);
                    if (sharedDefault) continue;
                    other = a.Label;
                    break;
                }
                kv.Value.conflict.text = other != null ? "Also: " + other : "";
            }
        }

        /// <summary>A short, readable key name ("1", "=", "Space", "Backspace").</summary>
        public static string KeyName(KeyCode k) => InputFacade.KeyName(k);

        // ------------------------------------------------------------------ defaults
        void RestoreDefaults()
        {
            switch (tab)
            {
                case "Graphics":
                    game?.ApplyQuality("high");
                    PlayerPrefs.SetString("se.quality", "high");
                    PlayerPrefs.Save();
                    break;
                case "Display":
                    SetWindowMode("borderless");
                    break;
                case "Audio":
                    var a = game?.Audio;
                    if (a != null) { a.Master = 1f; a.Effects = 1f; a.Ambience = .65f; a.MusicVolume = .4f; a.Save(); }
                    break;
                case "Interface":
                    GameSettings.ResetInterface();
                    game?.ApplyUiScale(GameSettings.UiScale);
                    UiKit.ApplyMotion(this);
                    break;
                case "Camera":
                    GameSettings.ResetCamera();
                    break;
                case "Controls":
                    InputFacade.ResetBindings();
                    break;
            }
            Select(tab);
        }
    }
}
