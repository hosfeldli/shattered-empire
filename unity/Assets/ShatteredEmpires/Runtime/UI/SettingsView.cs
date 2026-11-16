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
            UiKit.SettingRow("Show defense bar hotkey labels", UiKit.Switch(GameSettings.DefenseBarHotkeyLabels, v => GameSettings.DefenseBarHotkeyLabels = v), c);
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
        /// Follow and Flip on F, are not conflicts).</summary>
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
                    bool sharedDefault = self != null && a.Default == self.Default && key == self.Default;
                    if (sharedDefault) continue;
                    other = a.Label;
                    break;
                }
                kv.Value.conflict.text = other != null ? "Also: " + other : "";
            }
        }

        /// <summary>A short, readable key name ("1", "=", "Space", "Backspace").</summary>
        public static string KeyName(KeyCode k)
        {
            string n = k.ToString();
            if (n.StartsWith("Alpha") && n.Length == 6) return n.Substring(5);
            if (n.StartsWith("Keypad") && n.Length == 7 && char.IsDigit(n[6])) return "Num " + n[6];
            switch (k)
            {
                case KeyCode.None: return "—";
                case KeyCode.Equals: return "=";
                case KeyCode.Minus: return "-";
                case KeyCode.Period: return ".";
                case KeyCode.Comma: return ",";
                case KeyCode.Slash: return "/";
                case KeyCode.Backslash: return "\\";
                case KeyCode.Semicolon: return ";";
                case KeyCode.Quote: return "'";
                case KeyCode.LeftBracket: return "[";
                case KeyCode.RightBracket: return "]";
                case KeyCode.BackQuote: return "`";
                case KeyCode.Return: return "Enter";
                case KeyCode.LeftShift: return "Left Shift";
                case KeyCode.RightShift: return "Right Shift";
                case KeyCode.LeftControl: return "Left Ctrl";
                case KeyCode.RightControl: return "Right Ctrl";
                case KeyCode.LeftAlt: return "Left Alt";
                case KeyCode.RightAlt: return "Right Alt";
                case KeyCode.UpArrow: return "Up";
                case KeyCode.DownArrow: return "Down";
                case KeyCode.LeftArrow: return "Left";
                case KeyCode.RightArrow: return "Right";
                default: return n;
            }
        }

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
