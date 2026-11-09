using System;
using System.Runtime.InteropServices;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Sky, light and weather. Reads the server's regional weather (cloud, rain, storm, fog, wind) at the
    /// camera and turns it into the scene: procedural sky, sun strength and colour, ambient light, fog,
    /// drifting cloud banks with their shadows on the land, rain with splashes and rings on water,
    /// lightning in storms, and cinematic post-processing (ACES tonemapping, bloom, grading, vignette).
    /// Purely presentation: the weather itself is the server's.
    /// </summary>
    public sealed class Atmosphere : IDisposable
    {
        static readonly int CloudsId = Shader.PropertyToID("_SE_Clouds");
        static readonly int WindId = Shader.PropertyToID("_SE_Wind");
        static readonly int RainId = Shader.PropertyToID("_SE_Rain");
        static readonly int WetId = Shader.PropertyToID("_SE_Wetness");
        static readonly int ParticlesId = Shader.PropertyToID("_Particles");
        static readonly int ImageOffsetId = Shader.PropertyToID("_SE_ImageOffset");

        readonly Light sun;
        readonly Camera cam;
        readonly Material sky;
        readonly Volume volume;
        readonly VolumeProfile profile;
        ColorAdjustments grading;
        Vignette vignette;
        public FilmGrain Grain;
        public float Cloud, Rain, Storm, Fog, Wet;
        // mood overrides for cinematic shots (dusk, night, dawn); defaults leave the day untouched
        public float Dim = 1f, SunTintAmount = 0f, SunElevation = -1f, SunAzimuth = -32f;
        public Color SunTint = Color.white;
        public Color AmbientTint = Color.white;
        public float3 WindMap = new float3(0.6f, 0, 0.3f);
        /// <summary>How strongly weather is drawn (a player setting, 0–1); the simulation's weather is unchanged.</summary>
        public float VisualIntensity = 1f;
        float lightningAt, lightning;
        readonly System.Random rng = new System.Random(17);
        public event Action<float> Thunder;   // distance-ish delay seconds, for the audio

        // cloud banks: soft billboards drawn above the land from the weather grid
        const int MaxPuffs = 900;
        NativeArray<ParticleGpu> puffs;
        readonly GraphicsBuffer[] puffBuffers = new GraphicsBuffer[3];
        readonly MaterialPropertyBlock puffBlock = new MaterialPropertyBlock();
        int puffCount, puffSlot;
        float puffAt;

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
            var tone = profile.Add<Tonemapping>(true); tone.mode.Override(TonemappingMode.ACES);
            var bloom = profile.Add<Bloom>(true); bloom.threshold.Override(1.05f); bloom.intensity.Override(0.35f); bloom.scatter.Override(0.7f);
            grading = profile.Add<ColorAdjustments>(true); grading.postExposure.Override(0.25f); grading.contrast.Override(12f); grading.saturation.Override(6f);
            var wb = profile.Add<WhiteBalance>(true); wb.temperature.Override(6f);
            vignette = profile.Add<Vignette>(true); vignette.intensity.Override(0.2f); vignette.smoothness.Override(0.45f);
            Grain = profile.Add<FilmGrain>(true); Grain.intensity.Override(0f);
            var go = new GameObject("SE Post Volume");
            volume = go.AddComponent<Volume>();
            volume.isGlobal = true; volume.priority = 10; volume.sharedProfile = profile;
            puffs = new NativeArray<ParticleGpu>(MaxPuffs, Allocator.Persistent);
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
            sun.intensity = (Mathf.Lerp(1.35f, 0.5f, overcast) + flash * 2.5f) * Dim;
            sun.color = Color.Lerp(Color.Lerp(new Color(1f, 0.93f, 0.82f), new Color(0.86f, 0.9f, 0.95f), overcast), SunTint, SunTintAmount);
            if (SunElevation >= 0) sun.transform.rotation = Quaternion.Euler(SunElevation, SunAzimuth, 0);
            sun.shadowStrength = Mathf.Lerp(0.88f, 0.45f, overcast);
            RenderSettings.ambientSkyColor = Color.Lerp(new Color(0.55f, 0.63f, 0.74f), new Color(0.5f, 0.53f, 0.56f), overcast) * (1 + flash) * AmbientTint;
            RenderSettings.ambientEquatorColor = Color.Lerp(new Color(0.46f, 0.45f, 0.41f), new Color(0.44f, 0.45f, 0.45f), overcast) * AmbientTint;
            RenderSettings.ambientGroundColor = new Color(0.22f, 0.2f, 0.17f) * AmbientTint;
            var horizon = Color.Lerp(new Color(0.7f, 0.75f, 0.79f), new Color(0.6f, 0.63f, 0.66f), overcast);
            RenderSettings.fogColor = horizon;
            float fogScale = 1f - Mathf.Clamp01(Fog * 0.7f + Rain * 0.35f);
            RenderSettings.fogStartDistance = camDistance * 2.4f * fogScale;
            RenderSettings.fogEndDistance = (camDistance * 6f + 260f) * Mathf.Max(0.35f, fogScale);
            sky.SetColor("_Horizon", horizon);
            sky.SetFloat("_Overcast", overcast);
            sky.SetFloat("_Flash", flash * 0.6f);
            grading.saturation.Override(Mathf.Lerp(6f, -14f, overcast));
            grading.postExposure.Override(0.25f + flash * 0.8f);
            vignette.intensity.Override(0.2f + Storm * 0.08f);
            var windU = MapSpace.W(WindMap);
            Shader.SetGlobalVector(CloudsId, new Vector4(Mathf.Clamp01(Cloud), windU.x, windU.z, 1f));
            Shader.SetGlobalVector(WindId, new Vector4(windU.x, windU.z, math.length(WindMap), 0));
            Shader.SetGlobalFloat(RainId, Rain);
            Shader.SetGlobalFloat(WetId, Wet * 0.5f);
            if (fx != null && Rain > 0.05f && camDistance < 140f && world.Ready && VisualIntensity > 0.01f)
                fx.Rain(focusMap, Rain * VisualIntensity * Mathf.Lerp(1f, 0.3f, camDistance / 140f), WindMap, (x, z) => world.GroundHeight(x, z), Mathf.Clamp(camDistance * 0.55f, 4f, 30f));
            puffAt -= dt;
            if (puffAt <= 0 && world.Ready) { puffAt = 0.25f; BuildClouds(world, wx, focusMap, camDistance, time); }
        }

        void BuildClouds(WorldModel world, WeatherState wx, float3 focusMap, float camDistance, float time)
        {
            puffCount = 0;
            if (wx == null || wx.Cloud == null || wx.CellsW <= 0) return;
            var g = world.Grid;
            float cellW = wx.Cell * HexMath.Sqrt3, cellH = wx.Cell * 1.5f;
            float radius = Mathf.Clamp(camDistance * 2.6f, 50f, 320f);
            int rx = Mathf.CeilToInt(radius / cellW), rz = Mathf.CeilToInt(radius / cellH);
            int fcx = Mathf.FloorToInt(g.BaseX(focusMap.x) / cellW), fcz = Mathf.FloorToInt(focusMap.z / cellH);
            // above the clouds at strategic zoom: keep them thin so the map stays readable
            float camHeight = cam.transform.position.y;
            // (the ground keeps its drifting cloud shadows, which carry the weather at that scale)
            float alphaScale = Mathf.Lerp(1f, 0.07f, Mathf.Clamp01((camHeight - 22f) / 55f)) * VisualIntensity;
            if (alphaScale < 0.08f && Storm < 0.3f) return;
            float drift = time * 0.35f;
            for (int dz = -rz; dz <= rz && puffCount < MaxPuffs; dz++)
            {
                int cz = fcz + dz;
                if (cz < 0 || cz >= wx.CellsH) continue;
                for (int dx = -rx; dx <= rx && puffCount < MaxPuffs; dx++)
                {
                    int cx = ((fcx + dx) % wx.CellsW + wx.CellsW) % wx.CellsW;
                    int ci = cz * wx.CellsW + cx;
                    if (ci >= wx.Cloud.Length) continue;
                    float c = wx.Cloud[ci] / 255f;
                    if (c < 0.3f) continue;
                    float rain = wx.Rain != null && ci < wx.Rain.Length ? wx.Rain[ci] / 255f : 0f;
                    int n = c > 0.7f ? 4 : c > 0.5f ? 3 : 2;
                    for (int p = 0; p < n && puffCount < MaxPuffs; p++)
                    {
                        uint h = (uint)(ci * 7919 + p * 104729);
                        h = (h ^ (h >> 13)) * 1274126177u;
                        float hx = (h & 1023) / 1023f, hz = ((h >> 10) & 1023) / 1023f, hy = ((h >> 20) & 1023) / 1023f;
                        float mx = (fcx + dx + hx) * cellW + WindMap.x * drift, mz = (cz + hz) * cellH + WindMap.z * drift;
                        float x = HexMath.NearX(mx, focusMap.x, g.Period, g.Wrap);
                        float y = 10f + c * 5f + hy * 3f;
                        float size = (5f + hy * 6f) * (0.6f + c * 0.6f);
                        float shade = Mathf.Lerp(0.98f, 0.55f, Mathf.Clamp01(rain * 1.4f + Storm * 0.5f));
                        var u = MapSpace.W(new float3(x, y, mz));
                        puffs[puffCount++] = new ParticleGpu
                        {
                            Position = new float4(u, size),
                            Color = new float4(shade, shade, shade * 1.02f, 0.42f * c * alphaScale),
                            Shape = new float4(hx * 6.28f, 0.9f, hz * 50f, 0f),
                            Extra = new float4(0, 0, 0, EffectsRenderer.Puff),
                        };
                    }
                }
            }
        }

        public void Draw()
        {
            if (puffCount == 0) return;
            puffSlot = (puffSlot + 1) % 3;
            ref var buffer = ref puffBuffers[puffSlot];
            if (buffer == null) buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, MaxPuffs, Marshal.SizeOf<ParticleGpu>());
            buffer.SetData(puffs, 0, 0, puffCount);
            puffBlock.SetBuffer(ParticlesId, buffer);
            puffBlock.SetVector(ImageOffsetId, Vector4.zero);
            Graphics.RenderMeshPrimitives(new RenderParams(RenderResources.AlphaBlend) { worldBounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), matProps = puffBlock, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, MeshKit.Quad, 0, puffCount);
        }

        public void Dispose()
        {
            foreach (var b in puffBuffers) b?.Release();
            if (puffs.IsCreated) puffs.Dispose();
            if (volume != null) UnityEngine.Object.Destroy(volume.gameObject);
            if (profile != null) UnityEngine.Object.Destroy(profile);
        }
    }
}
