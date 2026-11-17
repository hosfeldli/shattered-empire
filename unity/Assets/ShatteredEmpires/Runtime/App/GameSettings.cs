using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// Player preferences that shape presentation and comfort (accessibility, camera, effects), saved
    /// in PlayerPrefs. Nothing here affects the game rules.
    /// </summary>
    public static class GameSettings
    {
        // Settings are read every frame by the HUD and camera: PlayerPrefs is read once per key, then cached
        // (a string concat plus a registry/plist lookup per read was a measurable per-frame cost).
        static readonly System.Collections.Generic.Dictionary<string, float> floats = new System.Collections.Generic.Dictionary<string, float>();
        static readonly System.Collections.Generic.Dictionary<string, bool> bools = new System.Collections.Generic.Dictionary<string, bool>();
        static float F(string k, float d) { if (!floats.TryGetValue(k, out var v)) floats[k] = v = PlayerPrefs.GetFloat("se.set." + k, d); return v; }
        static void SetF(string k, float v) { floats[k] = v; PlayerPrefs.SetFloat("se.set." + k, v); PlayerPrefs.Save(); }
        static bool B(string k, bool d) { if (!bools.TryGetValue(k, out var v)) bools[k] = v = PlayerPrefs.GetInt("se.set." + k, d ? 1 : 0) == 1; return v; }
        static void SetB(string k, bool v) { bools[k] = v; PlayerPrefs.SetInt("se.set." + k, v ? 1 : 0); PlayerPrefs.Save(); }

        /// <summary>Interface scale (0.75–1.6).</summary>
        public static float UiScale { get => F("uiScale", 1f); set => SetF("uiScale", Mathf.Clamp(value, 0.75f, 1.6f)); }
        /// <summary>Camera shake from nearby blasts.</summary>
        public static bool ScreenShake { get => B("shake", true); set => SetB("shake", value); }
        /// <summary>Reduced motion: no shake, no full-screen flashes, gentler camera glides.</summary>
        public static bool ReducedMotion { get => B("reducedMotion", false); set => SetB("reducedMotion", value); }
        /// <summary>How strongly weather is drawn (rain, cloud puffs, lightning flashes), 0–1.</summary>
        public static float WeatherIntensity { get => F("weather", 1f); set => SetF("weather", Mathf.Clamp01(value)); }
        /// <summary>Pan the camera when the mouse touches the screen edge.</summary>
        public static bool EdgePan { get => B("edgePan", true); set => SetB("edgePan", value); }
        /// <summary>Camera pan speed multiplier (0.5–2).</summary>
        public static float CameraSpeed { get => F("camSpeed", 1f); set => SetF("camSpeed", Mathf.Clamp(value, 0.5f, 2f)); }
        /// <summary>Unit and ownership markers in high contrast, with shapes as well as colour.</summary>
        public static bool HighContrastMarkers { get => B("contrast", false); set => SetB("contrast", value); }
        /// <summary>Open the unit command wheel automatically whenever units are selected (off: press C).</summary>
        public static bool OpenUnitWheelOnSelection { get => B("unitWheel", false); set => SetB("unitWheel", value); }
        /// <summary>Always show the digit labels on the defensive build bar (off: only while B arms it).</summary>

        /// <summary>Restore the Interface tab defaults (the interface scale is applied by the caller).</summary>
        public static void ResetInterface()
        {
            UiScale = 1f; HighContrastMarkers = false; OpenUnitWheelOnSelection = false;
        }

        /// <summary>Restore the Camera tab defaults.</summary>
        public static void ResetCamera()
        {
            EdgePan = true; CameraSpeed = 1f; ScreenShake = true; ReducedMotion = false; WeatherIntensity = 1f;
        }

        public static float ShakeScale => ReducedMotion || !ScreenShake ? 0f : 1f;
        public static float FlashScale => ReducedMotion ? 0.15f : 1f;
    }
}
