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
            buttonRows.Clear();
            buttonList = null;
            presetSeg = null;
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

        static (string id, string label, string icon)[] Items(params (string id, string label)[] o)
        {
            var list = new (string id, string label, string icon)[o.Length];
            for (int i = 0; i < o.Length; i++) list[i] = (o[i].id, o[i].label, null);
            return list;
        }

        Segmented presetSeg;

        /// <summary>A graphics preset fills every knob; any knob changed by hand makes the preset Custom.</summary>
        static void ApplyPreset(IGameActions game, string preset)
        {
            if (game != null) game.ApplyQuality(preset); else GameSettings.ApplyGraphicsPreset(preset);
        }

        /// <summary>A knob changed: save it (done by the setter), mark the preset Custom and apply everything.</summary>
        void Knob(Action set)
        {
            set();
            GameSettings.GraphicsPreset = "custom";
            if (presetSeg != null) presetSeg.Value = "custom";
            game?.ApplyQuality("custom");
        }

        void GraphicsTab(VisualElement c)
        {
            if (!GameSettings.HasGraphicsKnobs) GameSettings.ApplyGraphicsPreset(GameSettings.GraphicsPreset);
            presetSeg = UiKit.Segmented(Items(("low", "Low"), ("medium", "Medium"), ("high", "High"), ("ultra", "Ultra"), ("custom", "Custom")), GameSettings.GraphicsPreset, p =>
            {
                if (p == "custom") { presetSeg.Value = GameSettings.GraphicsPreset; return; }   // Custom is reached by changing a knob
                ApplyPreset(game, p);
                Select("Graphics");   // every knob below shows the preset's value
            }, null, 80);
            UiKit.SettingRow("Preset", presetSeg, c);
            UiKit.Text("A preset sets everything below; changing any setting makes it Custom.", "se-settings-note", c);
            string Num(float v) => Mathf.RoundToInt(v).ToString();

            UiKit.SettingRow("Shadows", UiKit.Segmented(Items(("0", "Off"), ("1", "Low"), ("2", "Medium"), ("3", "High")), GameSettings.ShadowQuality.ToString(),
                v => Knob(() => GameSettings.ShadowQuality = int.TryParse(v, out int n) ? n : 2), null, 80), c);
            UiKit.SettingRow("Shadow distance", UiKit.SliderRow(GameSettings.ShadowDistance, 20, 250, Num, v => Knob(() => GameSettings.ShadowDistance = v), true), c);
            UiKit.SettingRow("Terrain detail distance", UiKit.SliderRow(GameSettings.TerrainDetail, 30, 120, Num, v => Knob(() => GameSettings.TerrainDetail = v), true), c);
            UiKit.SettingRow("Vegetation density", UiKit.SliderRow(GameSettings.VegetationDensity, .25f, 1.5f, Percent, v => Knob(() => GameSettings.VegetationDensity = v), true), c);
            UiKit.SettingRow("Vegetation distance", UiKit.SliderRow(GameSettings.VegetationDistance, 250, 450, Num, v => Knob(() => GameSettings.VegetationDistance = v), true), c);
            UiKit.SettingRow("Effects and particles", UiKit.SliderRow(GameSettings.EffectsQuality, .25f, 1.25f, Percent, v => Knob(() => GameSettings.EffectsQuality = v), true), c);
            UiKit.SettingRow("Unit detail distance", UiKit.SliderRow(GameSettings.UnitDetail, 8, 40, Num, v => Knob(() => GameSettings.UnitDetail = v), true), c);
            UiKit.SettingRow("Cloud deck", UiKit.Switch(GameSettings.CloudDeck, v => Knob(() => GameSettings.CloudDeck = v)), c);
            UiKit.SettingRow("Weather effects", UiKit.SliderRow(GameSettings.WeatherIntensity, 0f, 1f, Percent, v => GameSettings.WeatherIntensity = v), c);
            UiKit.SettingRow("Render scale", UiKit.SliderRow(GameSettings.RenderScale, .5f, 1.25f, Percent, v => Knob(() => GameSettings.RenderScale = v), true), c);
            UiKit.SettingRow("Anti-aliasing", UiKit.Segmented(Items(("off", "Off"), ("fxaa", "FXAA"), ("smaa", "SMAA"), ("msaa2", "MSAA 2×"), ("msaa4", "MSAA 4×")), GameSettings.AntiAliasing,
                v => Knob(() => GameSettings.AntiAliasing = v), null, 72), c);
            UiKit.SettingRow("Post-processing", UiKit.Switch(GameSettings.PostProcessing, v => Knob(() => GameSettings.PostProcessing = v)), c);
            UiKit.Text("Post-processing: tone mapping, bloom, colour grading and vignette. Weather effects scale rain, shade and lightning (not part of the presets).", "se-settings-note", c);
            UiKit.SettingRow("Vertical sync", UiKit.Switch(GameSettings.VSync, v => { GameSettings.VSync = v; game?.ApplyQuality("custom-timing"); }), c);
            UiKit.SettingRow("Frame rate limit", UiKit.Segmented(Items(("0", "None"), ("30", "30"), ("60", "60"), ("120", "120"), ("144", "144"), ("240", "240")), GameSettings.FrameCap.ToString(),
                v => { GameSettings.FrameCap = int.TryParse(v, out int n) ? n : 0; game?.ApplyQuality("custom-timing"); }, null, 56), c);
            UiKit.Text("The frame rate limit applies with vertical sync off.", "se-settings-note", c);
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
            UiKit.Text("Weather intensity is in Graphics › Weather effects.", "se-settings-note", c);
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

            // ---- every other button: interface buttons and wheel commands, discovered as they appear (ButtonHotkeys)
            UiKit.Text("BUTTONS", "se-menu-section", c);
            UiKit.Text("Any button can have a key: those of the interface (top bar, panels, menus) and every command on the unit, base and build wheels. " +
                "Buttons appear here once they have been shown. Click a key, then press the key (with Ctrl, Shift or Alt if you like); Escape keeps the old one, Delete removes it. " +
                "A wheel command's key works while that wheel is open.", "se-settings-note", c);
            var filterRow = UiKit.El("se-setting-row", c);
            UiKit.Text("Find", "se-key-label", filterRow);
            var filter = new TextField { value = buttonFilter };
            filter.style.flexGrow = 1;
            filter.AddToClassList("se-menu-field");
            filterRow.Add(filter);
            buttonList = UiKit.El(null, c);
            filter.RegisterValueChangedCallback(e => { buttonFilter = e.newValue ?? ""; FillButtons(); });
            FillButtons();
            UpdateConflicts();
        }

        static string buttonFilter = "";
        VisualElement buttonList;
        readonly Dictionary<string, (UnityEngine.UIElements.Button key, Label conflict)> buttonRows = new Dictionary<string, (UnityEngine.UIElements.Button, Label)>();
        const string ButtonCapture = "btn:";

        /// <summary>The bindable buttons, grouped (interface, wheels, menus), filtered by the Find text; bound ones first in each group.</summary>
        void FillButtons()
        {
            if (buttonList == null) return;
            buttonList.Clear();
            buttonRows.Clear();
            string f = (buttonFilter ?? "").Trim().ToLowerInvariant();
            int shown = 0;
            foreach (var group in new[] { ButtonHotkeys.GroupHud, ButtonHotkeys.GroupWheel, ButtonHotkeys.GroupMenu })
            {
                var list = new List<ButtonHotkeys.Entry>();
                foreach (var e in ButtonHotkeys.Entries)
                    if (e.Group == group && (f.Length == 0 || e.Label.ToLowerInvariant().Contains(f))) list.Add(e);
                if (list.Count == 0) continue;
                list.Sort((a, b) =>
                {
                    int ka = ButtonHotkeys.TryGet(a.Id, out _) ? 0 : 1, kb = ButtonHotkeys.TryGet(b.Id, out _) ? 0 : 1;
                    return ka != kb ? ka - kb : string.Compare(a.Label, b.Label, StringComparison.OrdinalIgnoreCase);
                });
                UiKit.Text(group, "se-menu-label", buttonList);
                foreach (var e in list)
                {
                    string id = e.Id;
                    var row = UiKit.El("se-setting-row", buttonList);
                    UiKit.Text(e.Label, "se-key-label", row).tooltip = e.Label;
                    var key = UiKit.Button(ButtonChordText(id), () => BeginCapture(ButtonCapture + id), row, null, "se-keycap");
                    key.style.width = 180;   // room for "Ctrl+Alt+Shift+F12"
                    UiKit.IconButton("close", () => { ButtonHotkeys.Unbind(id); RefreshButton(id); UpdateConflicts(); }, "Remove the key", row, 28);
                    var conflict = UiKit.Text("", "se-key-conflict", row);
                    buttonRows[id] = (key, conflict);
                    shown++;
                }
            }
            if (shown == 0)
                UiKit.Text(f.Length > 0 ? "No button matches." : "No buttons seen yet: open a match or a menu, then come back.", "se-settings-note", buttonList);
            UpdateConflicts();
        }

        static string ButtonChordText(string id) => ButtonHotkeys.TryGet(id, out var c) ? ButtonHotkeys.ChordName(c) : "—";

        void RefreshButton(string id)
        {
            if (buttonRows.TryGetValue(id, out var row)) UiKit.SetText(row.key, ButtonChordText(id));
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
            if (!CaptureRow(id, out var row)) return;
            capturing = id;
            UiKit.SetText(row.key, "Press a key…");
            row.key.EnableInClassList("selected", true);
            poll?.Pause();
            poll = schedule.Execute(PollKey).Every(0);
        }

        bool CaptureRow(string id, out (UnityEngine.UIElements.Button key, Label conflict) row) =>
            id.StartsWith(ButtonCapture) ? buttonRows.TryGetValue(id.Substring(ButtonCapture.Length), out row) : keyRows.TryGetValue(id, out row);

        static bool IsModifier(KeyCode k) => k == KeyCode.LeftShift || k == KeyCode.RightShift || k == KeyCode.LeftControl || k == KeyCode.RightControl
            || k == KeyCode.LeftAlt || k == KeyCode.RightAlt || k == KeyCode.LeftCommand || k == KeyCode.RightCommand || k == KeyCode.AltGr;

        void PollKey()
        {
            if (capturing == null) { poll?.Pause(); return; }
            var k = InputFacade.AnyKeyPressed();
            if (k == KeyCode.None) return;
            // a button key may carry Ctrl / Shift / Alt: wait for the key itself
            if (capturing.StartsWith(ButtonCapture) && IsModifier(k)) return;
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
            if (id.StartsWith(ButtonCapture))
            {
                string bid = id.Substring(ButtonCapture.Length);
                if (apply)
                {
                    if (k == KeyCode.Delete) ButtonHotkeys.Unbind(bid);
                    else ButtonHotkeys.Bind(bid, new ButtonHotkeys.Chord { Key = k, Ctrl = UnityCtrl(), Shift = UnityShift(), Alt = UnityAlt() });
                }
                if (buttonRows.TryGetValue(bid, out var brow)) { RefreshButton(bid); brow.key.EnableInClassList("selected", false); }
                UpdateConflicts();
                return;
            }
            if (apply) InputFacade.Rebind(id, k);
            if (keyRows.TryGetValue(id, out var row))
            {
                UiKit.SetText(row.key, KeyName(InputFacade.KeyFor(id)));
                row.key.EnableInClassList("selected", false);
            }
            UpdateConflicts();
        }

        // modifier state while capturing: InputFacade reads keys as released while "typing", which the HUD also sets during a capture
        static bool RawHeld(KeyCode a, KeyCode b)
        {
            bool typing = InputFacade.Typing;
            InputFacade.Typing = false;
            bool held = InputFacade.Held(a) || InputFacade.Held(b);
            InputFacade.Typing = typing;
            return held;
        }
        static bool UnityCtrl() => RawHeld(KeyCode.LeftControl, KeyCode.RightControl);
        static bool UnityShift() => RawHeld(KeyCode.LeftShift, KeyCode.RightShift);
        static bool UnityAlt() => RawHeld(KeyCode.LeftAlt, KeyCode.RightAlt);

        /// <summary>Another action or button on the same key shows in amber beside the key (deliberate shared defaults, such as
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
                other ??= ButtonHotkeys.ButtonOnKey(key);
                kv.Value.conflict.text = other != null ? "Also: " + other : "";
            }
            foreach (var kv in buttonRows)
            {
                string other = ButtonHotkeys.TryGet(kv.Key, out var chord) ? ButtonHotkeys.ConflictFor(kv.Key, chord) : null;
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
                    GameSettings.VSync = true; GameSettings.FrameCap = 0; GameSettings.WeatherIntensity = 1f; GameSettings.CloudDeck = true;
                    ApplyPreset(game, "high");
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
                    ButtonHotkeys.ClearAll();   // button keys are all custom: none by default
                    break;
            }
            Select(tab);
        }
    }
}
