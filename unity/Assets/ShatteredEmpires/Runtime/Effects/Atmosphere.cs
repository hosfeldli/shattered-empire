using System;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Sky, light and weather. Reads the server's regional weather (cloud, rain, storm, fog, wind) at the
    /// camera and turns it into the scene: procedural sky, sun strength and colour, ambient light, fog,
    /// sky clouds with their shadows on the land, rain with splashes and rings on water,
    /// lightning in storms, and cinematic post-processing (ACES tonemapping, bloom, grading, vignette).
    /// Purely presentation: the weather itself is the server's.
    /// </summary>
    public sealed class Atmosphere : IDisposable
    {
        static readonly int CloudsId = Shader.PropertyToID("_SE_Clouds");
        static readonly int WindId = Shader.PropertyToID("_SE_Wind");
        static readonly int RainId = Shader.PropertyToID("_SE_Rain");
        static readonly int WetId = Shader.PropertyToID("_SE_Wetness");
        static readonly int GlareId = Shader.PropertyToID("_SE_Glare"), HazeId = Shader.PropertyToID("_SE_Haze"), HazeColorId = Shader.PropertyToID("_SE_HazeColor"),
            AmbientSkyId = Shader.PropertyToID("_SE_AmbientSky"), AmbientEquatorId = Shader.PropertyToID("_SE_AmbientEquator"), AmbientGroundId = Shader.PropertyToID("_SE_AmbientGround"),
            HorizonId = Shader.PropertyToID("_Horizon"), OvercastId = Shader.PropertyToID("_Overcast"), FlashId = Shader.PropertyToID("_Flash");
        Color lastAmbientSky = Color.clear, lastAmbientEquator = Color.clear, lastAmbientGround = Color.clear;
        static bool Same(Color a, Color b) => Mathf.Abs(a.r - b.r) + Mathf.Abs(a.g - b.g) + Mathf.Abs(a.b - b.b) < 1e-3f;
        WorldModel groundWorld;
        Func<float, float, float> groundAt;

        readonly Light sun;
        readonly Camera cam;
        readonly Material sky;
        readonly Volume volume;
        readonly VolumeProfile profile;
        ColorAdjustments grading;
        Vignette vignette;
        public FilmGrain Grain;
        Bloom bloom;
        ChromaticAberration aberration;
        UniversalAdditionalCameraData cameraData;
        LensDistortion lens;
        public float Glare = 1;
        public float Cloud, Rain, Storm, Fog, Wet;
        // mood overrides for cinematic shots (dusk, night, dawn); defaults leave the day untouched
        public float Dim = 1f, SunTintAmount = 0f, SunElevation = -1f, SunAzimuth = -32f;
        /// <summary>The volumetric shroud reads scene depth; the depth copy is requested only while it draws.</summary>
        public bool NeedsDepth;
        Vector2 cloudDrift;
        public Color SunTint = Color.white;
        public Color AmbientTint = Color.white;
        public float Haze = .16f, Exposure = .08f;

        public void GameplayMood()
        {
            Dim = 1; SunElevation = 48; SunAzimuth = -32; SunTintAmount = .12f;
            SunTint = new Color(1, .95f, .87f); AmbientTint = Color.white; Haze = .16f; Exposure = .08f;
            lightning = 0;
            SkyPhoto = null; Impact = 0; SkyExposure = 1f; SkyTint = Color.white;
        }
        public void MenuMood()
        {
            Dim = .96f; SunElevation = 22; SunAzimuth = -46; SunTintAmount = .64f;
            SunTint = new Color(1, .77f, .54f); AmbientTint = new Color(.84f, .90f, 1); Haze = .45f; Exposure = .02f;
            Cloud = .18f; Rain = Storm = Fog = Wet = 0; lightning = 0;
            SkyPhoto = "SkyDusk"; SkyExposure = .85f; SkyTint = new Color(1f, .93f, .88f);
        }

        // ------------------------------------------------------------------ photographed skies
        /// <summary>
        /// The panorama to show (Resources/Workshop/Sky), or null to follow the weather (cumulus in fair
        /// weather, overcast under cloud). Cinematics name a sky per beat. Changes crossfade through the
        /// procedural sky so two 4K panoramas never need to be resident at once.
        /// </summary>
        public string SkyPhoto;
        public float SkyExposure = 1f;
        public Color SkyTint = Color.white;
        /// <summary>Blast or catastrophe impulse (0-1+): lens kick, aberration and a brief exposure lift; decays.</summary>
        public float Impact;
        string shownSky;
        float skyBlend;
        // Where each photograph's sun sits (u of the brightest point above the horizon), so the
        // panorama can be turned to put it behind the scene's directional light.
        static float SunU(string sky) => sky switch
        {
            "SkyDusk" => .536f, "SkyFirestorm" => .278f, "SkyAshfall" => .433f, "SkyOvercast" => .725f,
            "SkyCumulus" => .794f, "SkyNight" => .406f, "SkyDawn" => .456f, _ => .5f
        };

        void UpdateSky(float dt, float overcast)
        {
            string want = SkyPhoto ?? (overcast > (shownSky == "SkyOvercast" ? .45f : .62f) ? "SkyOvercast" : "SkyCumulus");
            if (want != shownSky)
            {
                skyBlend = Mathf.MoveTowards(skyBlend, 0, dt * 1.6f);
                if (skyBlend <= 0)
                {
                    var tex = RenderResources.Sky(want);
                    shownSky = want;
                    sky.SetTexture(PanoId, tex);
                    sky.SetFloat(PanoSunId, SunU(want));
                    hasPhoto = tex != null;
                }
            }
            else skyBlend = Mathf.MoveTowards(skyBlend, hasPhoto ? 1 : 0, dt * .8f);
            // Fair-weather panoramas are partly hidden by heavy weather; cinematic skies stay as directed.
            float weather = SkyPhoto == null ? Mathf.Lerp(.92f, .55f, Mathf.Clamp01(Storm + Fog)) : 1f;
            sky.SetFloat(PanoAmountId, skyBlend * weather);
            sky.SetFloat(PanoExposureId, SkyExposure * Dim);
            sky.SetColor(PanoTintId, SkyTint);
        }
        bool hasPhoto;
        static readonly int PanoId = Shader.PropertyToID("_Pano"), PanoSunId = Shader.PropertyToID("_PanoSunU"),
            PanoAmountId = Shader.PropertyToID("_PanoAmount"), PanoExposureId = Shader.PropertyToID("_PanoExposure"),
            PanoTintId = Shader.PropertyToID("_PanoTint");
        public float3 WindMap = new float3(0.6f, 0, 0.3f);
        /// <summary>How strongly weather is drawn (a player setting, 0–1); the simulation's weather is unchanged.</summary>
        public float VisualIntensity = 1f;
        float lightningAt, lightning;
        readonly System.Random rng = new System.Random(17);
        public event Action<float> Thunder;   // distance-ish delay seconds, for the audio

        public Atmosphere(Camera camera, Light sunLight)
        {
            cam = camera; sun = sunLight;
            sky = new Material(Resources.Load<Shader>("Shaders/Sky")) { name = "SE Sky" };
            RenderSettings.skybox = sky;
            cam.clearFlags = CameraClearFlags.Skybox;
            var data = cam.GetUniversalAdditionalCameraData();
            cameraData = data;
            data.renderPostProcessing = true;
            data.stopNaN = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            profile = ScriptableObject.CreateInstance<VolumeProfile>();
            var tone = profile.Add<Tonemapping>(true); tone.mode.Override(TonemappingMode.Neutral);
            bloom = profile.Add<Bloom>(true); bloom.threshold.Override(1.35f); bloom.intensity.Override(.08f); bloom.scatter.Override(.4f); bloom.clamp.Override(4f);
            grading = profile.Add<ColorAdjustments>(true); grading.postExposure.Override(.18f); grading.contrast.Override(3f); grading.saturation.Override(-5f);
            var wb = profile.Add<WhiteBalance>(true); wb.temperature.Override(0f);
            vignette = profile.Add<Vignette>(true); vignette.intensity.Override(.035f); vignette.smoothness.Override(.6f);
            Grain = profile.Add<FilmGrain>(true); Grain.intensity.Override(0f);
            aberration = profile.Add<ChromaticAberration>(true); aberration.intensity.Override(0f);
            lens = profile.Add<LensDistortion>(true); lens.intensity.Override(0f); lens.scale.Override(1f);
            var go = new GameObject("SE Post Volume");
            volume = go.AddComponent<Volume>();
            volume.isGlobal = true; volume.priority = 10; volume.sharedProfile = profile;
        }

        float R() => (float)rng.NextDouble();

        public void Update(WorldModel world, WeatherState wx, float3 focusMap, float camDistance, EffectsRenderer fx, float time, float dt)
        {
            // weather at the camera, eased so passing fronts change the light gradually
            float tc = 0.15f, tr = 0, ts = 0, tf = 0, tw = 0;
            if (wx != null && world.Ready)
            {
                int tile = world.Grid.TileAt(focusMap.x, focusMap.z);
                if (tile >= 0)
                {
                    int w = world.Grid.W;
                    tc = wx.Sample(wx.Cloud, tile, w); tr = wx.Sample(wx.Rain, tile, w); ts = wx.Sample(wx.Storm, tile, w);
                    tf = wx.Sample(wx.Fog, tile, w); tw = wx.Sample(wx.Wet, tile, w);
                }
                float a = wx.WindAngle;
                WindMap = new float3(math.cos(a), 0, math.sin(a)) * math.max(0.15f, wx.WindSpeed);
            }
            float k = 1f - Mathf.Exp(-dt * 0.8f);
            Cloud = Mathf.Lerp(Cloud, tc, k); Rain = Mathf.Lerp(Rain, tr, k); Storm = Mathf.Lerp(Storm, ts, k);
            Fog = Mathf.Lerp(Fog, tf, k); Wet = Mathf.Lerp(Wet, Mathf.Max(tw, tr), k);
            float overcast = Mathf.Clamp01(Cloud * 0.85f + Storm * 0.4f);
            // lightning in storms
            lightning = Mathf.Max(0, lightning - dt * 6f);
            if (Storm > 0.35f && time > lightningAt)
            {
                lightningAt = time + 3f + R() * 9f / Storm;
                lightning = 0.8f + R() * 0.6f;
                Thunder?.Invoke(0.5f + R() * 3f);
            }
            float flash = Mathf.Max(fx != null ? fx.Flash : 0, lightning);
            UpdateSky(dt, overcast);
            // Shock-front refraction needs the opaque colour copy; pay for it only while a wave is live.
            if (cameraData != null) cameraData.requiresColorOption = fx != null && fx.DistortionActive ? CameraOverrideOption.On : CameraOverrideOption.UsePipelineSettings;
            if (cameraData != null) cameraData.requiresDepthOption = NeedsDepth ? CameraOverrideOption.On : CameraOverrideOption.UsePipelineSettings;
            Impact = Mathf.Max(0, Impact - dt * 1.4f);
            if (fx != null) Impact = Mathf.Max(Impact, fx.Flash * .9f);   // strategic strikes kick the lens
            float kick = Mathf.Clamp01(Impact);
            aberration.intensity.Override(Mathf.Clamp01(kick * .55f + Storm * .04f));
            lens.intensity.Override(-kick * .22f);
            lens.scale.Override(1f - kick * .03f);
            bloom.intensity.Override(.065f * Mathf.Clamp01(Glare));
            Shader.SetGlobalFloat(GlareId, Mathf.Clamp01(Glare));
            sun.intensity = (Mathf.Lerp(1.38f, .78f, overcast) + flash * 2.5f) * Dim;
            sun.color = Color.Lerp(Color.Lerp(new Color(1f, .97f, .92f), new Color(.93f, .96f, 1f), overcast), SunTint, SunTintAmount);
            if (SunElevation >= 0) sun.transform.rotation = Quaternion.Euler(SunElevation, SunAzimuth, 0);
            sun.shadowStrength = Mathf.Lerp(.85f, .52f, overcast);
            // RenderSettings' ambient colours are written only when they change: each write re-derives the ambient probe
            var ambientSky = Color.Lerp(new Color(.48f, .55f, .66f), new Color(.54f, .58f, .63f), overcast) * (1 + flash) * AmbientTint;
            var ambientEquator = new Color(.36f, .41f, .47f) * AmbientTint;
            var ambientGround = new Color(.23f, .25f, .25f) * AmbientTint;
            if (!Same(ambientSky, lastAmbientSky) || !Same(ambientEquator, lastAmbientEquator) || !Same(ambientGround, lastAmbientGround))
            {
                lastAmbientSky = ambientSky; lastAmbientEquator = ambientEquator; lastAmbientGround = ambientGround;
                RenderSettings.ambientSkyColor = ambientSky;
                RenderSettings.ambientEquatorColor = ambientEquator;
                RenderSettings.ambientGroundColor = ambientGround;
                Shader.SetGlobalColor(AmbientSkyId, ambientSky.linear);
                Shader.SetGlobalColor(AmbientEquatorId, ambientEquator.linear);
                Shader.SetGlobalColor(AmbientGroundId, ambientGround.linear);
            }
            var horizon = Color.Lerp(new Color(.69f, .76f, .83f), new Color(.59f, .64f, .69f), overcast);
            horizon = Color.Lerp(horizon, new Color(.87f, .76f, .64f), Mathf.Clamp01((32 - SunElevation) / 30) * SunTintAmount * .45f);
            RenderSettings.fog = true; RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = horizon;
            float fogScale = 1f - Mathf.Clamp01(Fog * 0.7f + Rain * 0.35f);
            // ranges are measured from the logical eye: the telephoto camera stands EyeOffset further back
            float eyeOffset = ViewLod.Telephoto ? ViewLod.EyeOffset : 0f;
            RenderSettings.fogStartDistance = camDistance * 1.65f * fogScale + eyeOffset;
            RenderSettings.fogEndDistance = (camDistance * 3.8f + 125f) * Mathf.Max(.42f, fogScale) + eyeOffset;
            Shader.SetGlobalVector(HazeId, new Vector4((Haze + Fog * .6f) * .035f, camDistance * .9f + eyeOffset, 0, 0));
            FollowShadowDistance(eyeOffset);
            Shader.SetGlobalColor(HazeColorId, horizon.linear);
            sky.SetColor(HorizonId, horizon);
            sky.SetFloat(OvercastId, overcast);
            sky.SetFloat(FlashId, flash * 0.6f);
            grading.saturation.Override(Mathf.Lerp(-5f, -15f, overcast));
            grading.postExposure.Override(Exposure + flash * .8f + kick * .35f);
            grading.contrast.Override(Mathf.Lerp(8f, 4f, overcast));
            vignette.intensity.Override(.035f + Storm * .04f);
            var windU = MapSpace.W(WindMap);
            // Cloud fields drift by an integrated offset (wind x time would jump whenever the wind changed);
            // shadows on the land, the volumetric cumulus and the shroud all read the same offset.
            cloudDrift += new Vector2(windU.x, windU.z) * (dt * .02f);
            if (cloudDrift.sqrMagnitude > 1e6f) cloudDrift = Vector2.zero;
            Shader.SetGlobalVector(CloudsId, new Vector4(Mathf.Clamp01(Cloud), cloudDrift.x, cloudDrift.y, 0f));
            Shader.SetGlobalVector(WindId, new Vector4(windU.x, windU.z, math.length(WindMap), 0));
            Shader.SetGlobalFloat(RainId, Rain);
            Shader.SetGlobalFloat(WetId, Wet * 0.5f);
            if (world != null && groundWorld != world) { groundWorld = world; groundAt = world.GroundHeight; }
            if (fx != null && Rain > 0.05f && camDistance < 140f && world.Ready && VisualIntensity > 0.01f)
                fx.Rain(focusMap, Rain * VisualIntensity * Mathf.Lerp(1f, 0.3f, camDistance / 140f), WindMap, groundAt, Mathf.Clamp(camDistance * 0.55f, 4f, 30f));
        }

        // URP measures the shadow distance from the real eye. The quality preset's distance is kept as the
        // base (re-read whenever something else sets it) and pushed back by the telephoto offset, so the
        // shadowed band still covers what the player sees; the base is restored on exit (the asset is shared).
        float shadowBase = -1f, shadowSet = -1f;
        void FollowShadowDistance(float eyeOffset)
        {
            var urp = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            if (urp == null) return;
            if (shadowBase < 0 || Mathf.Abs(urp.shadowDistance - shadowSet) > .01f)
            {
                if (shadowBase < 0) Application.quitting += RestoreShadowDistance;
                shadowBase = urp.shadowDistance;
            }
            shadowSet = shadowBase + eyeOffset;
            if (Mathf.Abs(urp.shadowDistance - shadowSet) > .5f) urp.shadowDistance = shadowSet;
            else shadowSet = urp.shadowDistance;
        }

        void RestoreShadowDistance()
        {
            var urp = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            if (urp != null && shadowBase > 0) urp.shadowDistance = shadowBase;
        }

        public void Dispose()
        {
            RestoreShadowDistance();
            if (volume != null) UnityEngine.Object.Destroy(volume.gameObject);
            if (profile != null) UnityEngine.Object.Destroy(profile);
        }
    }
}
