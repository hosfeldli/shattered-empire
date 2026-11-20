using System;
using System.Collections.Generic;
using UnityEngine;
#if SE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace SE.Runtime.Input
{
    /// <summary>
    /// One input surface over whichever backend the player settings enable (the Input System package
    /// or the legacy manager), so the client runs either way.
    ///
    /// Guarantees: while a text field has focus no game key fires (Escape still does); shortcuts are
    /// named actions whose keys the player can remap (saved in PlayerPrefs); a key press is reported
    /// once per press, never repeated by key-repeat.
    /// </summary>
    public static class InputFacade
    {
        /// <summary>Set by the interface while a text field has keyboard focus.</summary>
        public static bool Typing;

        // ---------------------------------------------------------------- remappable actions
        /// <summary>A remappable shortcut. <see cref="Default"/> is its key in the Arrow-keys camera scheme;
        /// <see cref="Wasd"/> (when not None) replaces it in the WASD scheme.</summary>
        public sealed class ActionDef { public string Id, Label; public KeyCode Default, Wasd; }

        /// <summary>Every remappable shortcut, in the order the settings list shows them.</summary>
        /// <remarks>
        /// Two complete default sets (Settings › Controls › Camera keys). Arrow keys (the default): the arrows pan,
        /// A selects the units on screen (Ctrl+A every unit), the orders keep natural letters (S stance, W withdraw)
        /// and attack move is F. WASD: W/A/S/D pan, Q selects (Ctrl+Q every unit), and the orders that would collide
        /// move to V and X. Both: F attack move (it flips a battle line only while one is drawn), E production
        /// buildings (Ctrl+E every building). In the WASD scheme the arrows pan too (unless one is bound to an order).
        /// </remarks>
        public static readonly ActionDef[] Actions =
        {
            // camera: the pan keys (per scheme), the screen edges and middle drag pan; Alt + drag turns
            new ActionDef { Id = "pan_up", Label = "Camera: pan forward", Default = KeyCode.UpArrow, Wasd = KeyCode.W },
            new ActionDef { Id = "pan_down", Label = "Camera: pan backward", Default = KeyCode.DownArrow, Wasd = KeyCode.S },
            new ActionDef { Id = "pan_left", Label = "Camera: pan left", Default = KeyCode.LeftArrow, Wasd = KeyCode.A },
            new ActionDef { Id = "pan_right", Label = "Camera: pan right", Default = KeyCode.RightArrow, Wasd = KeyCode.D },
            new ActionDef { Id = "rotate_left", Label = "Camera: rotate left (or Alt + drag)", Default = KeyCode.Comma },
            new ActionDef { Id = "rotate_right", Label = "Camera: rotate right (or Alt + drag)", Default = KeyCode.Period },
            new ActionDef { Id = "group_1", Label = "Control group 1 (Ctrl: assign)", Default = KeyCode.Alpha1 },
            new ActionDef { Id = "group_2", Label = "Control group 2 (Ctrl: assign)", Default = KeyCode.Alpha2 },
            new ActionDef { Id = "group_3", Label = "Control group 3 (Ctrl: assign)", Default = KeyCode.Alpha3 },
            new ActionDef { Id = "group_4", Label = "Control group 4 (Ctrl: assign)", Default = KeyCode.Alpha4 },
            new ActionDef { Id = "group_5", Label = "Control group 5 (Ctrl: assign)", Default = KeyCode.Alpha5 },
            new ActionDef { Id = "group_6", Label = "Control group 6 (Ctrl: assign)", Default = KeyCode.Alpha6 },
            new ActionDef { Id = "group_7", Label = "Control group 7 (Ctrl: assign)", Default = KeyCode.Alpha7 },
            new ActionDef { Id = "group_8", Label = "Control group 8 (Ctrl: assign)", Default = KeyCode.Alpha8 },
            new ActionDef { Id = "group_9", Label = "Control group 9 (Ctrl: assign)", Default = KeyCode.Alpha9 },
            new ActionDef { Id = "select_local", Label = "Select your units on screen (Ctrl: every unit; Shift adds)", Default = KeyCode.A, Wasd = KeyCode.Q },
            new ActionDef { Id = "select_production", Label = "Select every production building (Ctrl: every building; Shift adds)", Default = KeyCode.E },
            new ActionDef { Id = "attack", Label = "Attack move, then click (twice: units on screen; Ctrl: whole army)", Default = KeyCode.F },
            new ActionDef { Id = "stance", Label = "Cycle stance: aggressive, defensive, hold fire", Default = KeyCode.S, Wasd = KeyCode.V },
            new ActionDef { Id = "hold", Label = "Hold position", Default = KeyCode.H },
            new ActionDef { Id = "withdraw", Label = "Withdraw", Default = KeyCode.W, Wasd = KeyCode.X },
            new ActionDef { Id = "air_patrol", Label = "Aircraft: patrol route, then click waypoints (Shift-click adds more; pauses when no aircraft selected)", Default = KeyCode.P },
            new ActionDef { Id = "follow", Label = "Follow selection with the camera", Default = KeyCode.G },
            new ActionDef { Id = "flip", Label = "Flip battle-line facing (while drawing)", Default = KeyCode.F },
            new ActionDef { Id = "back", Label = "Camera: back to previous view", Default = KeyCode.Backspace },
            new ActionDef { Id = "alert", Label = "Camera: jump to latest alert", Default = KeyCode.Space },
            new ActionDef { Id = "commands", Label = "Unit command wheel (optional)", Default = KeyCode.C },
            new ActionDef { Id = "upgrade_base", Label = "Upgrade base tier (base wheel open)", Default = KeyCode.U },
            new ActionDef { Id = "build", Label = "Build wheel", Default = KeyCode.B },
            new ActionDef { Id = "terrain", Label = "Terrain wheel", Default = KeyCode.T },
            new ActionDef { Id = "brush_smaller", Label = "Terrain brush: smaller (while painting terrain)", Default = KeyCode.LeftBracket },
            new ActionDef { Id = "brush_larger", Label = "Terrain brush: larger (while painting terrain)", Default = KeyCode.RightBracket },
            new ActionDef { Id = "minimap_zoom", Label = "Minimap: zoom", Default = KeyCode.Z },
            new ActionDef { Id = "research", Label = "Open Research (legacy)", Default = KeyCode.R },
            new ActionDef { Id = "overview", Label = "Open Overview (legacy)", Default = KeyCode.O },
            new ActionDef { Id = "pause", Label = "Pause (when allowed)", Default = KeyCode.P },
            new ActionDef { Id = "faster", Label = "Game speed: faster", Default = KeyCode.Equals },
            new ActionDef { Id = "slower", Label = "Game speed: slower", Default = KeyCode.Minus },
        };

        static readonly string[] PanActions = { "pan_up", "pan_down", "pan_left", "pan_right" };
        static readonly Dictionary<string, KeyCode> bound = new Dictionary<string, KeyCode>();

        // 2026-11-16 (v2): pan moved from WASD to the arrows, rotate off Q/E, attack move to F, follow to G.
        // Saved bindings for those actions came from the old layout, so they are dropped once.
        // 2026-11-17 (v3): WASD panning by default (arrows hard-wired), so saved pan keys reset again.
        // 2026-11-17 (v4): two schemes, Arrow keys (default) and WASD. Players without custom binds land on the
        // Arrow scheme; a v3 player who had custom binds keeps the WASD scheme, so their layout does not change.
        // 2026-11-17 (v5): selection hotkeys. Arrow scheme: A selects the units on screen (Ctrl+A all) and attack move
        // moves from A to F (as in the WASD scheme); WASD scheme: Q selects. E selects production in both. A player's
        // own binds are never overwritten: a new or moved default that lands on a key the player already gave to
        // another action is pinned instead (attack move stays on A, a new select action starts unbound).
        const int BindingVersion = 5;
        static bool migrated;
        static void Migrate()
        {
            migrated = true;
            int saved = PlayerPrefs.GetInt("se.keys.version", 1);
            if (saved >= BindingVersion) return;
            if (saved < 4)
            {
                string[] reset = saved < 2
                    ? new[] { "pan_up", "pan_down", "pan_left", "pan_right", "rotate_left", "rotate_right", "attack", "follow", "build" }
                    : saved < 3 ? PanActions : new string[0];
                foreach (var id in reset)
                    PlayerPrefs.DeleteKey("se.key." + id);
                bool custom = false;
                foreach (var a in Actions) if (PlayerPrefs.HasKey("se.key." + a.Id)) custom = true;
                SE.Runtime.App.GameSettings.WasdCameraKeys = saved == 3 && custom;
            }
            MigrateSelectionKeys(SE.Runtime.App.GameSettings.WasdCameraKeys);
            PlayerPrefs.SetInt("se.keys.version", BindingVersion);
            PlayerPrefs.Save();
        }

        /// <summary>v5: keep every custom bind; pin the moved attack key and the new select keys where they would collide.</summary>
        static void MigrateSelectionKeys(bool wasd)
        {
            KeyCode SchemeDefault(ActionDef a) => wasd && a.Wasd != KeyCode.None ? a.Wasd : a.Default;
            bool TakenByCustom(string self, KeyCode key)
            {
                foreach (var a in Actions)
                    if (a.Id != self && PlayerPrefs.HasKey("se.key." + a.Id) && (KeyCode)PlayerPrefs.GetInt("se.key." + a.Id, 0) == key) return true;
                return false;
            }
            // attack move (Arrow scheme only: A → F; F is shared on purpose with "flip", which acts only while a line is drawn)
            if (!wasd && !PlayerPrefs.HasKey("se.key.attack") && TakenByCustom("attack", KeyCode.F) && !TakenByCustom("attack", KeyCode.A))
                PlayerPrefs.SetInt("se.key.attack", (int)KeyCode.A);
            foreach (var id in new[] { "select_local", "select_production" })
            {
                var a = Def(id);
                if (a == null || PlayerPrefs.HasKey("se.key." + id)) continue;
                if (TakenByCustom(id, SchemeDefault(a))) PlayerPrefs.SetInt("se.key." + id, (int)KeyCode.None);
            }
        }

        /// <summary>True when the WASD camera scheme is chosen (Settings › Controls › Camera keys; default: Arrow keys).</summary>
        public static bool WasdScheme
        {
            get { if (!migrated) Migrate(); return SE.Runtime.App.GameSettings.WasdCameraKeys; }
        }

        /// <summary>The action's default key in the chosen scheme.</summary>
        public static KeyCode DefaultKey(ActionDef a) => WasdScheme && a.Wasd != KeyCode.None ? a.Wasd : a.Default;

        static ActionDef Def(string id)
        {
            foreach (var a in Actions) if (a.Id == id) return a;
            return null;
        }

        /// <summary>True when the player saved their own key for this action.</summary>
        public static bool IsCustom(string action) => PlayerPrefs.HasKey("se.key." + action);

        public static KeyCode KeyFor(string action)
        {
            if (bound.TryGetValue(action, out var k)) return k;
            if (!migrated) Migrate();
            var a = Def(action);
            if (a == null) return KeyCode.None;
            k = (KeyCode)PlayerPrefs.GetInt("se.key." + action, (int)DefaultKey(a));
            bound[action] = k;
            return k;
        }

        public static void Rebind(string action, KeyCode key)
        {
            bound[action] = key;
            var a = Def(action);
            // binding an action back to its scheme default clears the custom bind, so it follows later scheme switches
            if (a != null && key == DefaultKey(a)) PlayerPrefs.DeleteKey("se.key." + action);
            else PlayerPrefs.SetInt("se.key." + action, (int)key);
            PlayerPrefs.Save();
        }

        /// <summary>Restore every shortcut to the default (Arrow keys) scheme, dropping custom binds.</summary>
        public static void ResetBindings()
        {
            if (!migrated) Migrate();
            foreach (var a in Actions) PlayerPrefs.DeleteKey("se.key." + a.Id);
            SE.Runtime.App.GameSettings.WasdCameraKeys = false;
            PlayerPrefs.Save();
            bound.Clear();
        }

        /// <summary>
        /// Switch the camera key scheme, swapping in that scheme's whole default set. The pan keys always follow the
        /// scheme. Every other custom bind is kept unless its key is now the default of another (not custom) action in
        /// the new scheme; such a bind resets to the scheme default. Returns the labels of the binds that were reset.
        /// </summary>
        public static List<string> SetWasdScheme(bool wasd)
        {
            var reset = new List<string>();
            if (WasdScheme == wasd) return reset;
            SE.Runtime.App.GameSettings.WasdCameraKeys = wasd;
            bound.Clear();
            foreach (var id in PanActions) PlayerPrefs.DeleteKey("se.key." + id);
            var customKeys = new Dictionary<string, KeyCode>();
            foreach (var a in Actions)
                if (IsCustom(a.Id)) customKeys[a.Id] = (KeyCode)PlayerPrefs.GetInt("se.key." + a.Id, 0);
            foreach (var kv in customKeys)
            {
                var self = Def(kv.Key);
                if (kv.Value == DefaultKey(self)) { PlayerPrefs.DeleteKey("se.key." + kv.Key); continue; }
                foreach (var b in Actions)
                {
                    if (b.Id == kv.Key || customKeys.ContainsKey(b.Id) || DefaultKey(b) != kv.Value) continue;
                    PlayerPrefs.DeleteKey("se.key." + kv.Key);
                    reset.Add(self.Label);
                    break;
                }
            }
            PlayerPrefs.Save();
            return reset;
        }

        /// <summary>
        /// A camera pan direction is held: its bound key or, as a fixed extra, the matching arrow key (unless that
        /// arrow is bound to another action).
        /// </summary>
        public static bool PanHeld(string panAction, KeyCode arrow)
        {
            if (ActionHeld(panAction)) return true;
            if (!Held(arrow)) return false;
            foreach (var a in Actions)
                if (Array.IndexOf(PanActions, a.Id) < 0 && KeyFor(a.Id) == arrow) return false;
            return true;
        }

        /// <summary>A short, readable key name ("1", "=", "Space", "Up").</summary>
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

        /// <summary>The bound key's short name for an action ("A", ",").</summary>
        public static string KeyLabel(string action) => KeyName(KeyFor(action));

        /// <summary>The pan keys as help text: "the arrow keys", or "W/A/S/D (or the arrow keys)".</summary>
        public static string PanKeysText()
        {
            KeyCode u = KeyFor("pan_up"), l = KeyFor("pan_left"), d = KeyFor("pan_down"), r = KeyFor("pan_right");
            if (u == KeyCode.UpArrow && l == KeyCode.LeftArrow && d == KeyCode.DownArrow && r == KeyCode.RightArrow) return "the arrow keys";
            return KeyName(u) + "/" + KeyName(l) + "/" + KeyName(d) + "/" + KeyName(r) + " (or the arrow keys)";
        }

        /// <summary>Help text with the bound keys filled in: "{attack}" becomes the attack-move key, "{pan}" ("{Pan}" capitalised) the pan keys.</summary>
        public static string Expand(string text)
        {
            if (string.IsNullOrEmpty(text) || text.IndexOf('{') < 0) return text;
            var sb = new System.Text.StringBuilder(text.Length + 16);
            for (int i = 0; i < text.Length; i++)
            {
                int close = text[i] == '{' ? text.IndexOf('}', i + 1) : -1;
                if (close > i + 1)
                {
                    string id = text.Substring(i + 1, close - i - 1);
                    if (id == "pan" || id == "Pan") { string t = PanKeysText(); sb.Append(id == "Pan" ? char.ToUpperInvariant(t[0]) + t.Substring(1) : t); i = close; continue; }
                    if (Def(id) != null) { sb.Append(KeyLabel(id)); i = close; continue; }
                }
                sb.Append(text[i]);
            }
            return sb.ToString();
        }

        public static bool Action(string action) => Pressed(KeyFor(action));
        public static bool ActionHeld(string action) => Held(KeyFor(action));

        /// <summary>The first key pressed this frame (for rebinding), or None.</summary>
        public static KeyCode AnyKeyPressed()
        {
            foreach (KeyCode k in Enum.GetValues(typeof(KeyCode)))
                if (k > KeyCode.None && k < KeyCode.Mouse0 && PressedRaw(k)) return k;
            return KeyCode.None;
        }

        public static bool Held(KeyCode k) => !(Typing && k != KeyCode.Escape) && HeldRaw(k);
        public static bool Pressed(KeyCode k) => !(Typing && k != KeyCode.Escape && k != KeyCode.Return) && PressedRaw(k);

#if SE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        static Keyboard K => Keyboard.current;
        static Mouse M => Mouse.current;
        public static Vector2 MousePosition => M != null ? M.position.ReadValue() : Vector2.zero;
        // Input System 1.8+ reports one wheel notch as 1 (UniformAcrossAllPlatforms); older versions and raw
        // Windows deltas report 120. Either way one notch is 1 here.
        public static float Scroll { get { if (M == null) return 0f; float y = M.scroll.ReadValue().y; return Mathf.Abs(y) > 10f ? y / 120f : y; } }
        public static bool LeftDown => M != null && M.leftButton.wasPressedThisFrame;
        public static bool LeftHeld => M != null && M.leftButton.isPressed;
        public static bool LeftUp => M != null && M.leftButton.wasReleasedThisFrame;
        public static bool RightDown => M != null && M.rightButton.wasPressedThisFrame;
        public static bool RightHeld => M != null && M.rightButton.isPressed;
        public static bool RightUp => M != null && M.rightButton.wasReleasedThisFrame;
        public static bool MiddleHeld => M != null && M.middleButton.isPressed;
        public static bool MiddleDown => M != null && M.middleButton.wasPressedThisFrame;
        public static Vector2 MouseDelta => M != null ? M.delta.ReadValue() : Vector2.zero;
        public static bool Shift => !Typing && K != null && (K.leftShiftKey.isPressed || K.rightShiftKey.isPressed);
        public static bool Ctrl => !Typing && K != null && (K.leftCtrlKey.isPressed || K.rightCtrlKey.isPressed);
        public static bool Alt => !Typing && K != null && (K.leftAltKey.isPressed || K.rightAltKey.isPressed);
        static bool HeldRaw(KeyCode k) => K != null && Map(k) is Key key && key != Key.None && K[key].isPressed;
        static bool PressedRaw(KeyCode k) => K != null && Map(k) is Key key && key != Key.None && K[key].wasPressedThisFrame;

        static readonly Dictionary<KeyCode, Key> map = new Dictionary<KeyCode, Key>();

        /// <summary>KeyCode to Input System key: by name, with the few names that differ spelled out.</summary>
        static Key Map(KeyCode k)
        {
            if (map.TryGetValue(k, out var key)) return key;
            switch (k)
            {
                case KeyCode.Return: key = Key.Enter; break;
                case KeyCode.KeypadEnter: key = Key.NumpadEnter; break;
                case KeyCode.LeftControl: key = Key.LeftCtrl; break;
                case KeyCode.RightControl: key = Key.RightCtrl; break;
                case KeyCode.BackQuote: key = Key.Backquote; break;
                default:
                {
                    string name = k.ToString();
                    if (name.StartsWith("Alpha")) name = "Digit" + name.Substring(5);
                    else if (name.StartsWith("Keypad") && name.Length == 7 && char.IsDigit(name[6])) name = "Numpad" + name[6];
                    if (!Enum.TryParse(name, true, out key)) key = Key.None;
                    break;
                }
            }
            map[k] = key;
            return key;
        }
#else
        public static Vector2 MousePosition => UnityEngine.Input.mousePosition;
        public static float Scroll => UnityEngine.Input.mouseScrollDelta.y;
        public static bool LeftDown => UnityEngine.Input.GetMouseButtonDown(0);
        public static bool LeftHeld => UnityEngine.Input.GetMouseButton(0);
        public static bool LeftUp => UnityEngine.Input.GetMouseButtonUp(0);
        public static bool RightDown => UnityEngine.Input.GetMouseButtonDown(1);
        public static bool RightHeld => UnityEngine.Input.GetMouseButton(1);
        public static bool RightUp => UnityEngine.Input.GetMouseButtonUp(1);
        public static bool MiddleHeld => UnityEngine.Input.GetMouseButton(2);
        public static bool MiddleDown => UnityEngine.Input.GetMouseButtonDown(2);
        public static Vector2 MouseDelta => new Vector2(UnityEngine.Input.GetAxis("Mouse X"), UnityEngine.Input.GetAxis("Mouse Y")) * 10f;
        public static bool Shift => !Typing && (UnityEngine.Input.GetKey(KeyCode.LeftShift) || UnityEngine.Input.GetKey(KeyCode.RightShift));
        public static bool Ctrl => !Typing && (UnityEngine.Input.GetKey(KeyCode.LeftControl) || UnityEngine.Input.GetKey(KeyCode.RightControl));
        public static bool Alt => !Typing && (UnityEngine.Input.GetKey(KeyCode.LeftAlt) || UnityEngine.Input.GetKey(KeyCode.RightAlt));
        static bool HeldRaw(KeyCode k) => UnityEngine.Input.GetKey(k);
        static bool PressedRaw(KeyCode k) => UnityEngine.Input.GetKeyDown(k);
#endif
    }
}
