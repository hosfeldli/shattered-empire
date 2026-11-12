using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// Player preferences that shape presentation and comfort (accessibility, camera, effects), saved
    /// in PlayerPrefs. Nothing here affects the game rules.
    /// </summary>
    public static class GameSettings
    {
        static float F(string k, float d) => PlayerPrefs.GetFloat("se.set." + k, d);
        static void SetF(string k, float v) { PlayerPrefs.SetFloat("se.set." + k, v); PlayerPrefs.Save(); }
        static bool B(string k, bool d) => PlayerPrefs.GetInt("se.set." + k, d ? 1 : 0) == 1;
        static void SetB(string k, bool v) { PlayerPrefs.SetInt("se.set." + k, v ? 1 : 0); PlayerPrefs.Save(); }

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

        public static float ShakeScale => ReducedMotion || !ScreenShake ? 0f : 1f;
        public static float FlashScale => ReducedMotion ? 0.15f : 1f;
    }
}
