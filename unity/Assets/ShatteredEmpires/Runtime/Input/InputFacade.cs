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
        public sealed class ActionDef { public string Id, Label; public KeyCode Default; }

        /// <summary>Every remappable shortcut, in the order the settings list shows them.</summary>
        public static readonly ActionDef[] Actions =
        {
            new ActionDef { Id = "pan_up", Label = "Camera: pan forward", Default = KeyCode.W },
            new ActionDef { Id = "pan_down", Label = "Camera: pan backward", Default = KeyCode.S },
            new ActionDef { Id = "pan_left", Label = "Camera: pan left", Default = KeyCode.A },
            new ActionDef { Id = "pan_right", Label = "Camera: pan right", Default = KeyCode.D },
            new ActionDef { Id = "rotate_left", Label = "Camera: rotate left", Default = KeyCode.Q },
            new ActionDef { Id = "rotate_right", Label = "Camera: rotate right", Default = KeyCode.E },
            new ActionDef { Id = "group_1", Label = "Control group 1 (Ctrl: assign)", Default = KeyCode.Alpha1 },
            new ActionDef { Id = "group_2", Label = "Control group 2 (Ctrl: assign)", Default = KeyCode.Alpha2 },
            new ActionDef { Id = "group_3", Label = "Control group 3 (Ctrl: assign)", Default = KeyCode.Alpha3 },
            new ActionDef { Id = "group_4", Label = "Control group 4 (Ctrl: assign)", Default = KeyCode.Alpha4 },
            new ActionDef { Id = "group_5", Label = "Control group 5 (Ctrl: assign)", Default = KeyCode.Alpha5 },
            new ActionDef { Id = "group_6", Label = "Control group 6 (Ctrl: assign)", Default = KeyCode.Alpha6 },
            new ActionDef { Id = "group_7", Label = "Control group 7 (Ctrl: assign)", Default = KeyCode.Alpha7 },
            new ActionDef { Id = "group_8", Label = "Control group 8 (Ctrl: assign)", Default = KeyCode.Alpha8 },
            new ActionDef { Id = "group_9", Label = "Control group 9 (Ctrl: assign)", Default = KeyCode.Alpha9 },
            new ActionDef { Id = "hold", Label = "Hold position", Default = KeyCode.H },
            new ActionDef { Id = "withdraw", Label = "Withdraw", Default = KeyCode.X },
            new ActionDef { Id = "attack", Label = "Attack-move (then click)", Default = KeyCode.T },   // A pans
            new ActionDef { Id = "follow", Label = "Follow selection", Default = KeyCode.F },
            new ActionDef { Id = "flip", Label = "Flip battle-line facing (while drawing)", Default = KeyCode.F },
            new ActionDef { Id = "back", Label = "Camera: back to previous view", Default = KeyCode.Backspace },
            new ActionDef { Id = "alert", Label = "Camera: jump to latest alert", Default = KeyCode.Space },
            new ActionDef { Id = "build", Label = "Open Build", Default = KeyCode.B },
            new ActionDef { Id = "research", Label = "Open Research", Default = KeyCode.R },
            new ActionDef { Id = "overview", Label = "Open Overview", Default = KeyCode.O },
            new ActionDef { Id = "pause", Label = "Pause (when allowed)", Default = KeyCode.P },
        };

        static readonly Dictionary<string, KeyCode> bound = new Dictionary<string, KeyCode>();

        public static KeyCode KeyFor(string action)
        {
            if (bound.TryGetValue(action, out var k)) return k;
            foreach (var a in Actions)
                if (a.Id == action)
                {
                    k = (KeyCode)PlayerPrefs.GetInt("se.key." + action, (int)a.Default);
                    bound[action] = k;
                    return k;
                }
            return KeyCode.None;
        }

        public static void Rebind(string action, KeyCode key)
        {
            bound[action] = key;
            PlayerPrefs.SetInt("se.key." + action, (int)key);
            PlayerPrefs.Save();
        }

        public static void ResetBindings()
        {
            foreach (var a in Actions) PlayerPrefs.DeleteKey("se.key." + a.Id);
            bound.Clear();
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
        public static float Scroll => M != null ? M.scroll.ReadValue().y / 120f : 0f;
        public static bool LeftDown => M != null && M.leftButton.wasPressedThisFrame;
        public static bool LeftHeld => M != null && M.leftButton.isPressed;
        public static bool LeftUp => M != null && M.leftButton.wasReleasedThisFrame;
        public static bool RightDown => M != null && M.rightButton.wasPressedThisFrame;
        public static bool RightHeld => M != null && M.rightButton.isPressed;
        public static bool RightUp => M != null && M.rightButton.wasReleasedThisFrame;
        public static bool MiddleHeld => M != null && M.middleButton.isPressed;
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
        public static Vector2 MouseDelta => new Vector2(UnityEngine.Input.GetAxis("Mouse X"), UnityEngine.Input.GetAxis("Mouse Y")) * 10f;
        public static bool Shift => !Typing && (UnityEngine.Input.GetKey(KeyCode.LeftShift) || UnityEngine.Input.GetKey(KeyCode.RightShift));
        public static bool Ctrl => !Typing && (UnityEngine.Input.GetKey(KeyCode.LeftControl) || UnityEngine.Input.GetKey(KeyCode.RightControl));
        public static bool Alt => !Typing && (UnityEngine.Input.GetKey(KeyCode.LeftAlt) || UnityEngine.Input.GetKey(KeyCode.RightAlt));
        static bool HeldRaw(KeyCode k) => UnityEngine.Input.GetKey(k);
        static bool PressedRaw(KeyCode k) => UnityEngine.Input.GetKeyDown(k);
#endif
    }
}
