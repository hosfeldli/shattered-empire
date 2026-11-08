using UnityEngine;
#if SE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace SE.Runtime.Input
{
    /// <summary>
    /// One input surface over whichever backend the player settings enable (the Input System package
    /// or the legacy manager), so the client runs either way.
    /// </summary>
    public static class InputFacade
    {
#if SE_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        static Keyboard K => Keyboard.current;
        static Mouse M => Mouse.current;
        public static Vector2 MousePosition => M != null ? M.position.ReadValue() : Vector2.zero;
        public static float Scroll => M != null ? M.scroll.ReadValue().y / 120f : 0f;
        public static bool LeftDown => M != null && M.leftButton.wasPressedThisFrame;
        public static bool LeftHeld => M != null && M.leftButton.isPressed;
        public static bool LeftUp => M != null && M.leftButton.wasReleasedThisFrame;
        public static bool RightDown => M != null && M.rightButton.wasPressedThisFrame;
        public static bool RightUp => M != null && M.rightButton.wasReleasedThisFrame;
        public static bool MiddleHeld => M != null && M.middleButton.isPressed;
        public static Vector2 MouseDelta => M != null ? M.delta.ReadValue() : Vector2.zero;
        public static bool Shift => K != null && (K.leftShiftKey.isPressed || K.rightShiftKey.isPressed);
        public static bool Ctrl => K != null && (K.leftCtrlKey.isPressed || K.rightCtrlKey.isPressed);
        public static bool Alt => K != null && (K.leftAltKey.isPressed || K.rightAltKey.isPressed);
        public static bool Held(KeyCode k) => K != null && Map(k) is Key key && key != Key.None && K[key].isPressed;
        public static bool Pressed(KeyCode k) => K != null && Map(k) is Key key && key != Key.None && K[key].wasPressedThisFrame;

        static Key Map(KeyCode k)
        {
            switch (k)
            {
                case KeyCode.W: return Key.W; case KeyCode.A: return Key.A; case KeyCode.S: return Key.S; case KeyCode.D: return Key.D;
                case KeyCode.Q: return Key.Q; case KeyCode.E: return Key.E; case KeyCode.H: return Key.H; case KeyCode.X: return Key.X;
                case KeyCode.UpArrow: return Key.UpArrow; case KeyCode.DownArrow: return Key.DownArrow;
                case KeyCode.LeftArrow: return Key.LeftArrow; case KeyCode.RightArrow: return Key.RightArrow;
                case KeyCode.F3: return Key.F3; case KeyCode.F10: return Key.F10; case KeyCode.Escape: return Key.Escape;
                case KeyCode.Space: return Key.Space; case KeyCode.Tab: return Key.Tab;
                case KeyCode.Alpha1: return Key.Digit1; case KeyCode.Alpha2: return Key.Digit2; case KeyCode.Alpha3: return Key.Digit3;
                case KeyCode.Alpha4: return Key.Digit4; case KeyCode.Alpha5: return Key.Digit5;
                default: return Key.None;
            }
        }
#else
        public static Vector2 MousePosition => UnityEngine.Input.mousePosition;
        public static float Scroll => UnityEngine.Input.mouseScrollDelta.y;
        public static bool LeftDown => UnityEngine.Input.GetMouseButtonDown(0);
        public static bool LeftHeld => UnityEngine.Input.GetMouseButton(0);
        public static bool LeftUp => UnityEngine.Input.GetMouseButtonUp(0);
        public static bool RightDown => UnityEngine.Input.GetMouseButtonDown(1);
        public static bool RightUp => UnityEngine.Input.GetMouseButtonUp(1);
        public static bool MiddleHeld => UnityEngine.Input.GetMouseButton(2);
        public static Vector2 MouseDelta => new Vector2(UnityEngine.Input.GetAxis("Mouse X"), UnityEngine.Input.GetAxis("Mouse Y")) * 10f;
        public static bool Shift => UnityEngine.Input.GetKey(KeyCode.LeftShift) || UnityEngine.Input.GetKey(KeyCode.RightShift);
        public static bool Ctrl => UnityEngine.Input.GetKey(KeyCode.LeftControl) || UnityEngine.Input.GetKey(KeyCode.RightControl);
        public static bool Alt => UnityEngine.Input.GetKey(KeyCode.LeftAlt) || UnityEngine.Input.GetKey(KeyCode.RightAlt);
        public static bool Held(KeyCode k) => UnityEngine.Input.GetKey(k);
        public static bool Pressed(KeyCode k) => UnityEngine.Input.GetKeyDown(k);
#endif
    }
}
