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
        /// <summary>
        /// Camera keys: false = Arrow keys (the default: arrows pan, orders on their natural letters), true = WASD
        /// (W/A/S/D pan, colliding orders move). Read and switched through <c>InputFacade.WasdScheme</c> /
        /// <c>InputFacade.SetWasdScheme</c>, which also migrate and re-derive the default key set.
        /// </summary>
        public static bool WasdCameraKeys { get => B("wasdKeys", false); set => SetB("wasdKeys", value); }
        /// <summary>Always show the digit labels on the defensive build bar (off: only while B arms it).</summary>

        /// <summary>
        /// Reduce UI motion: interface transitions (panel fades and slides, wheel blooms, counting numbers, the
        /// minimap zoom) become instant. Applied by <c>UiKit.ApplyMotion</c>.
        /// </summary>
        public static bool ReduceUiMotion { get => B("reduceUiMotion", false); set => SetB("reduceUiMotion", value); }
        /// <summary>Draw the weapon range of every defense in view (the minimap console toggle; selected defenses always show theirs).</summary>
        public static bool ShowDefenseRanges { get => B("defenseRanges", false); set => SetB("defenseRanges", value); }
        /// <summary>Share anonymous performance and gameplay diagnostics with the game server (ClientTelemetry, docs/TELEMETRY.md).</summary>
        public static bool ShareDiagnostics { get => B("shareDiagnostics", true); set => SetB("shareDiagnostics", value); }

        /// <summary>Restore the Interface tab defaults (the interface scale and UI motion are applied by the caller).</summary>
        public static void ResetInterface()
        {
            UiScale = 1f; HighContrastMarkers = false; OpenUnitWheelOnSelection = false; ReduceUiMotion = false;
        }

        /// <summary>Restore the Camera tab defaults.</summary>
        public static void ResetCamera()
        {
            EdgePan = true; CameraSpeed = 1f; ScreenShake = true; ReducedMotion = false;
        }

        // ------------------------------------------------------------------ graphics (Settings > Graphics)
        // A preset ("low", "medium", "high", "ultra") fills every knob below; changing one knob makes the preset "custom".
        // GameBootstrap.ApplyQuality applies the knobs to the URP asset, the camera and the renderers.
        static string S(string k, string d) => PlayerPrefs.GetString(k, d);

        /// <summary>The graphics preset: "low", "medium", "high", "ultra" or "custom" (PlayerPrefs "se.quality", as before).</summary>
        public static string GraphicsPreset { get => S("se.quality", "high"); set { PlayerPrefs.SetString("se.quality", value); PlayerPrefs.Save(); } }
        /// <summary>Sun shadows: 0 off, 1 low (1024 shadow map), 2 medium (2048), 3 high (4096).</summary>
        public static int ShadowQuality { get => Mathf.RoundToInt(F("gfx.shadows", 2)); set => SetF("gfx.shadows", Mathf.Clamp(value, 0, 3)); }
        /// <summary>How far shadows are drawn (world units, 20–250).</summary>
        public static float ShadowDistance { get => F("gfx.shadowDist", 130); set => SetF("gfx.shadowDist", Mathf.Clamp(value, 20, 250)); }
        /// <summary>Terrain detail: the distance the detailed ground mesh is used to (30–120; TerrainRenderer.LodDistance).</summary>
        public static float TerrainDetail { get => F("gfx.terrainLod", 70); set => SetF("gfx.terrainLod", Mathf.Clamp(value, 30, 120)); }
        /// <summary>Trees and groundcover per hex (0.25–1.5; TerrainRenderer.TreeDensity).</summary>
        public static float VegetationDensity { get => F("gfx.treeDensity", 1); set => SetF("gfx.treeDensity", Mathf.Clamp(value, .25f, 1.5f)); }
        /// <summary>How far trees are drawn in full (250–450; TerrainRenderer.TreeDistance).</summary>
        public static float VegetationDistance { get => F("gfx.treeDist", 380); set => SetF("gfx.treeDist", Mathf.Clamp(value, 250, 450)); }
        /// <summary>Explosions, smoke, debris and particles (0.25–1.25; EffectsRenderer.Intensity).</summary>
        public static float EffectsQuality { get => F("gfx.fx", 1); set => SetF("gfx.fx", Mathf.Clamp(value, .25f, 1.25f)); }
        /// <summary>Draw the high cloud deck of the weather systems (WeatherPresenter).</summary>
        public static bool CloudDeck { get => B("gfx.clouds", true); set => SetB("gfx.clouds", value); }
        /// <summary>Internal render resolution (0.5–1.25 of the screen; URP renderScale).</summary>
        public static float RenderScale { get => F("gfx.renderScale", 1); set => SetF("gfx.renderScale", Mathf.Clamp(value, .5f, 1.25f)); }
        /// <summary>Anti-aliasing: "off", "fxaa", "smaa", "msaa2", "msaa4" (the MSAA modes keep SMAA on top, as before).</summary>
        public static string AntiAliasing { get => S("se.set.gfx.aa", "msaa4"); set { PlayerPrefs.SetString("se.set.gfx.aa", value); PlayerPrefs.Save(); } }
        /// <summary>Post-processing (tone mapping, bloom, colour grading, vignette).</summary>
        public static bool PostProcessing { get => B("gfx.post", true); set => SetB("gfx.post", value); }
        /// <summary>Distance up to which units are drawn as detailed models (8–40; UnitRenderer.OperationalDistance).</summary>
        public static float UnitDetail { get => F("gfx.unitLod", 24); set => SetF("gfx.unitLod", Mathf.Clamp(value, 8, 40)); }
        /// <summary>Wait for the display's refresh (vertical sync).</summary>
        public static bool VSync { get => B("gfx.vsync", true); set => SetB("gfx.vsync", value); }
        /// <summary>Frame rate limit without vsync (0: unlimited).</summary>
        public static int FrameCap { get => Mathf.RoundToInt(F("gfx.frameCap", 0)); set => SetF("gfx.frameCap", Mathf.Max(0, value)); }

        /// <summary>Fill every graphics knob from a preset (unknown: "high"); vsync and the frame cap are left as they are.</summary>
        public static void ApplyGraphicsPreset(string preset)
        {
            switch (preset)
            {
                case "low": SetGraphics(1, 45, 45, .5f, 310, .5f, false, .85f, "smaa", true, 12); break;
                case "medium": SetGraphics(2, 80, 60, .75f, 340, .75f, true, 1f, "msaa2", true, 18); break;
                case "ultra": SetGraphics(3, 200, 100, 1.25f, 420, 1.2f, true, 1f, "msaa4", true, 31); break;
                default: preset = "high"; SetGraphics(2, 130, 70, 1f, 380, 1f, true, 1f, "msaa4", true, 24); break;
            }
            GraphicsPreset = preset;
        }

        static void SetGraphics(int shadows, float shadowDist, float terrainLod, float trees, float treeDist, float fx, bool clouds, float scale, string aa, bool post, float unitLod)
        {
            ShadowQuality = shadows; ShadowDistance = shadowDist; TerrainDetail = terrainLod; VegetationDensity = trees; VegetationDistance = treeDist;
            EffectsQuality = fx; CloudDeck = clouds; RenderScale = scale; AntiAliasing = aa; PostProcessing = post; UnitDetail = unitLod;
        }

        /// <summary>False until a knob was saved (players from before the knobs only have a preset: it is filled in on first use).</summary>
        public static bool HasGraphicsKnobs => PlayerPrefs.HasKey("se.set.gfx.aa");

        public static float ShakeScale => ReducedMotion || !ScreenShake ? 0f : 1f;
        public static float FlashScale => ReducedMotion ? 0.15f : 1f;
    }
}
