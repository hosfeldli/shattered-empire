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

        readonly Light sun;
        readonly Camera cam;
        readonly Material sky;
        readonly Volume volume;
        readonly VolumeProfile profile;
        ColorAdjustments grading;
        Vignette vignette;
        public FilmGrain Grain;
        Bloom bloom;
        public float Glare = 1;
        public float Cloud, Rain, Storm, Fog, Wet;
        // mood overrides for cinematic shots (dusk, night, dawn); defaults leave the day untouched
        public float Dim = 1f, SunTintAmount = 0f, SunElevation = -1f, SunAzimuth = -32f;
        public Color SunTint = Color.white;
        public Color AmbientTint = Color.white;
        public float Haze = .16f, Exposure = .08f;

        public void GameplayMood()
        {
            Dim = 1; SunElevation = 48; SunAzimuth = -32; SunTintAmount = .12f;
            SunTint = new Color(1, .95f, .87f); AmbientTint = Color.white; Haze = .16f; Exposure = .08f;
            lightning = 0;
        }
        public void MenuMood()
        {
            Dim = .96f; SunElevation = 22; SunAzimuth = -46; SunTintAmount = .64f;
            SunTint = new Color(1, .77f, .54f); AmbientTint = new Color(.84f, .90f, 1); Haze = .45f; Exposure = .02f;
            Cloud = .18f; Rain = Storm = Fog = Wet = 0; lightning = 0;
        }
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
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            profile = ScriptableObject.CreateInstance<VolumeProfile>();
            var tone = profile.Add<Tonemapping>(true); tone.mode.Override(TonemappingMode.Neutral);
            bloom = profile.Add<Bloom>(true); bloom.threshold.Override(1.15f); bloom.intensity.Override(.12f); bloom.scatter.Override(.6f);
            grading = profile.Add<ColorAdjustments>(true); grading.postExposure.Override(.18f); grading.contrast.Override(3f); grading.saturation.Override(-5f);
            var wb = profile.Add<WhiteBalance>(true); wb.temperature.Override(0f);
            vignette = profile.Add<Vignette>(true); vignette.intensity.Override(.035f); vignette.smoothness.Override(.6f);
            Grain = profile.Add<FilmGrain>(true); Grain.intensity.Override(0f);
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
            bloom.intensity.Override(.10f * Mathf.Clamp01(Glare));
            Shader.SetGlobalFloat("_SE_Glare", Mathf.Clamp01(Glare));
            sun.intensity = (Mathf.Lerp(1.38f, .78f, overcast) + flash * 2.5f) * Dim;
            sun.color = Color.Lerp(Color.Lerp(new Color(1f, .97f, .92f), new Color(.93f, .96f, 1f), overcast), SunTint, SunTintAmount);
            if (SunElevation >= 0) sun.transform.rotation = Quaternion.Euler(SunElevation, SunAzimuth, 0);
            sun.shadowStrength = Mathf.Lerp(.85f, .52f, overcast);
            RenderSettings.ambientSkyColor = Color.Lerp(new Color(.48f, .55f, .66f), new Color(.54f, .58f, .63f), overcast) * (1 + flash) * AmbientTint;
            RenderSettings.ambientEquatorColor = new Color(.36f, .41f, .47f) * AmbientTint;
            RenderSettings.ambientGroundColor = new Color(.23f, .25f, .25f) * AmbientTint;
            Shader.SetGlobalColor("_SE_AmbientSky", RenderSettings.ambientSkyColor.linear);
            Shader.SetGlobalColor("_SE_AmbientEquator", RenderSettings.ambientEquatorColor.linear);
            Shader.SetGlobalColor("_SE_AmbientGround", RenderSettings.ambientGroundColor.linear);
            var horizon = Color.Lerp(new Color(.69f, .76f, .83f), new Color(.59f, .64f, .69f), overcast);
            horizon = Color.Lerp(horizon, new Color(.87f, .76f, .64f), Mathf.Clamp01((32 - SunElevation) / 30) * SunTintAmount * .45f);
            RenderSettings.fog = true; RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = horizon;
            float fogScale = 1f - Mathf.Clamp01(Fog * 0.7f + Rain * 0.35f);
            RenderSettings.fogStartDistance = camDistance * 1.65f * fogScale;
            RenderSettings.fogEndDistance = (camDistance * 3.8f + 125f) * Mathf.Max(.42f, fogScale);
            Shader.SetGlobalVector("_SE_Haze", new Vector4((Haze + Fog * .6f) * .035f, camDistance * .9f, 0, 0));
            Shader.SetGlobalColor("_SE_HazeColor", horizon.linear);
            sky.SetColor("_Horizon", horizon);
            sky.SetFloat("_Overcast", overcast);
            sky.SetFloat("_Flash", flash * 0.6f);
            grading.saturation.Override(Mathf.Lerp(-5f, -15f, overcast));
            grading.postExposure.Override(Exposure + flash * .8f);
            grading.contrast.Override(Mathf.Lerp(8f, 4f, overcast));
            vignette.intensity.Override(.035f + Storm * .04f);
            var windU = MapSpace.W(WindMap);
            Shader.SetGlobalVector(CloudsId, new Vector4(Mathf.Clamp01(Cloud), windU.x, windU.z, 1f));
            Shader.SetGlobalVector(WindId, new Vector4(windU.x, windU.z, math.length(WindMap), 0));
            Shader.SetGlobalFloat(RainId, Rain);
            Shader.SetGlobalFloat(WetId, Wet * 0.5f);
            if (fx != null && Rain > 0.05f && camDistance < 140f && world.Ready && VisualIntensity > 0.01f)
                fx.Rain(focusMap, Rain * VisualIntensity * Mathf.Lerp(1f, 0.3f, camDistance / 140f), WindMap, (x, z) => world.GroundHeight(x, z), Mathf.Clamp(camDistance * 0.55f, 4f, 30f));
        }

        public void Dispose()
        {
            if (volume != null) UnityEngine.Object.Destroy(volume.gameObject);
            if (profile != null) UnityEngine.Object.Destroy(profile);
        }
    }
}
