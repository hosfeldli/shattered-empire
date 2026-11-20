using System;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using SE.Runtime.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Where the weather is, drawn in the sky: rain curtains under every pouring weather cell (SE/StormClouds
    /// reads the weather texture itself; this class only places a lattice window around the camera focus and sets a
    /// handful of vectors), and lightning: strikes are scheduled here from the storm cells near the camera, lit on
    /// the ground and in the cloud by every world shader (SECommon SE_StrikeLight), drawn as bolts, and handed to the
    /// audio as thunder from the strike's direction, delayed by its distance.
    /// The cloud masses themselves are the cloud deck (<see cref="StormSky"/>); the old billboard puffs are gone.
    /// Per frame: at most two instanced draws, no buffers, no allocations; the strike scan runs four times a second.
    /// </summary>
    public sealed class StormClouds : IDisposable
    {
        static readonly int StrikesId = Shader.PropertyToID("_SE_Strikes"), StrikeAmpId = Shader.PropertyToID("_SE_StrikeAmp");
        static readonly int L0 = Shader.PropertyToID("_L0"), L1 = Shader.PropertyToID("_L1"), L2 = Shader.PropertyToID("_L2"),
            L3 = Shader.PropertyToID("_L3"), L4 = Shader.PropertyToID("_L4"), L5 = Shader.PropertyToID("_L5");
        const float CloudBase = 17f;   // SECommon SE_CLOUD_BASE

        readonly Material blend, additive;
        readonly MaterialPropertyBlock curtainBlock = new MaterialPropertyBlock(), boltBlock = new MaterialPropertyBlock();
        int curtainCount;
        bool drawBolts;

        // strikes: a ring of four (xyz Unity world, w start time) and their strengths
        readonly Vector4[] strikes = new Vector4[4];
        Vector4 strikeAmp;
        int strikeNext;
        float scanAt, lastStrike = -99f;
        float[] weight = Array.Empty<float>();
        int[] weightCell = Array.Empty<int>();
        readonly System.Random rng = new System.Random(911);
        Vector2 drift;

        /// <summary>A lightning strike at a map position: (map position, thunder delay seconds, loudness 0..1).</summary>
        public event Action<float3, float, float> Strike;
        /// <summary>How strongly recent lightning lights the camera's view (0..1+), for the global flash.</summary>
        public float ViewFlash { get; private set; }
        /// <summary>Strongest storm within earshot of the camera focus (0..1), for the storm ambience.</summary>
        public float StormNear => lastStormNear;

        public StormClouds()
        {
            var shader = Resources.Load<Shader>("Shaders/StormClouds");
            if (shader == null) return;
            blend = new Material(shader) { name = "SE Storm Clouds", renderQueue = (int)RenderQueue.Transparent + 20, enableInstancing = true };
            blend.SetFloat("_SrcBlend", (float)BlendMode.One); blend.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
            additive = new Material(shader) { name = "SE Lightning", renderQueue = (int)RenderQueue.Transparent + 21, enableInstancing = true };
            additive.SetFloat("_SrcBlend", (float)BlendMode.One); additive.SetFloat("_DstBlend", (float)BlendMode.One);
        }

        /// <param name="focusMap">camera focus (map coordinates)</param>
        /// <param name="eye">the camera's real position (Unity world)</param>
        /// <param name="simRate">0 while paused: clouds stop drifting and no new lightning strikes</param>
        public void Update(WeatherField field, float3 focusMap, Vector3 eye, float camDistance, bool wrap, float time, float dt, float simRate,
            float intensity, Func<float, float, float> groundAt)
        {
            curtainCount = 0; drawBolts = false; ViewFlash = 0;
            if (blend == null || field == null || !field.Active) { strikeAmp = Vector4.zero; lastStormNear = 0; Shader.SetGlobalVector(StrikeAmpId, strikeAmp); return; }
            float period = field.Period, depth = field.Depth;
            float cellX = field.CellWorldX, cellZ = field.CellWorldZ;
            // the lattice drifts with the prevailing wind (the weather field itself glides by WeatherField's advection)
            float rate = simRate / Mathf.Max(.5f, field.Interval);
            drift += new Vector2(field.StepCells.x * cellX, -field.StepCells.y * cellZ) * (rate * dt);
            float sx = cellX * .5f, sz = cellZ * .5f;
            float zSpan = sz * 1024f;
            drift.x = Mathf.Repeat(drift.x, period); drift.y = Mathf.Repeat(drift.y, zSpan);

            Strikes(field, focusMap, camDistance, period, time, dt, simRate, intensity, groundAt);

            var fw = MapSpace.W(focusMap);
            float fade = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(26f, 62f, camDistance)) * Mathf.Clamp01(intensity);
            if (fade > .004f)
            {
                // where the line of sight to the focus crosses the cloud layer: thinned at mid zoom so the clouds never cover the battle
                float groundY = fw.y;
                float t = eye.y - groundY > 1f ? Mathf.Clamp01((CloudBase + 4f - groundY) / (eye.y - groundY)) : 0f;
                var hole = new Vector2(fw.x + (eye.x - fw.x) * t, fw.z + (eye.z - fw.z) * t);
                float holeStrength = 1f - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(80f, 175f, camDistance));
                float holeR = camDistance * .5f + 10f;
                int mx = Mathf.Max(1, Mathf.RoundToInt(period / sx)), mz = 1024;
                // rain shafts read from the side: strongest at mid zoom, gone at strategic zoom where the cloud deck covers them
                float curtainFade = fade * Mathf.SmoothStep(0, 1, Mathf.InverseLerp(40f, 80f, camDistance)) * (1f - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(120f, 190f, camDistance)));
                if (curtainFade > .004f)
                    curtainCount = Window(curtainBlock, camDistance > 140f ? 2 : 1, Mathf.Min(camDistance * 2f + 40f, 700f), sx, sz, mx, mz, fw, curtainFade, holeStrength, hole, holeR, 1, wrap, period, depth);
            }
            if (intensity > .001f && strikeAmp != Vector4.zero)
            {
                drawBolts = true;
                boltBlock.SetVector(L4, new Vector4(0, 0, 0, 2));
                boltBlock.SetVector(L5, new Vector4(wrap ? 1 : 0, period, depth, Mathf.Clamp(60f * 30f / Mathf.Max(camDistance, 1f), 7f, 60f)));
            }
        }

        int Window(MaterialPropertyBlock block, int level, float radius, float sx, float sz, int mx, int mz, float3 fw, float fade,
            float holeStrength, Vector2 hole, float holeR, int mode, bool wrap, float period, float depth)
        {
            float lx = sx * level, lz = sz * level;
            int nx = Mathf.Min(160, Mathf.CeilToInt(radius * 2f / lx) + 1), nz = Mathf.Min(160, Mathf.CeilToInt(radius * 2f / lz) + 1);
            radius = Mathf.Min(radius, Mathf.Min((nx - 1) * lx, (nz - 1) * lz) * .5f);
            float k0x = Mathf.Floor((fw.x - drift.x) / lx) - nx / 2, k0z = Mathf.Floor((fw.z - drift.y) / lz) - nz / 2;
            block.SetVector(L0, new Vector4(k0x, k0z, nx, nz));
            block.SetVector(L1, new Vector4(lx, lz, drift.x, drift.y));
            block.SetVector(L2, new Vector4(Mathf.Max(1, mx / level), Mathf.Max(1, mz / level), fade, holeStrength));
            block.SetVector(L3, new Vector4(hole.x, hole.y, holeR, level));
            block.SetVector(L4, new Vector4(radius, fw.x, fw.z, mode));
            block.SetVector(L5, new Vector4(wrap ? 1 : 0, period, depth, 0));
            return nx * nz;
        }

        void Strikes(WeatherField field, float3 focus, float camDistance, float period, float time, float dt, float simRate, float intensity, Func<float, float, float> groundAt)
        {
            // view flash and the storm ambience from the live strikes; expire old ones
            for (int i = 0; i < 4; i++)
            {
                if (strikeAmp[i] <= 0) continue;
                float age = time - strikes[i].w;
                if (age > 1f || age < -1f) { strikeAmp[i] = 0; continue; }
                float dx = DxWrap(focus.x, strikes[i].x, period), dz = -strikes[i].z - focus.z;
                float near = Mathf.Clamp01(1f - Mathf.Sqrt(dx * dx + dz * dz) / (camDistance * .9f + 25f));
                ViewFlash = Mathf.Max(ViewFlash, strikeAmp[i] * near * Mathf.Exp(-age * 7f) * (age < .45f ? 1 : 0));
            }
            Shader.SetGlobalVectorArray(StrikesId, strikes);
            Shader.SetGlobalVector(StrikeAmpId, strikeAmp);
            if (time < scanAt) return;
            scanAt = time + .25f;
            int cw = field.CellsW, ch = field.CellsH, n = cw * ch;
            if (weight.Length < n) { weight = new float[n]; weightCell = new int[n]; }
            float cellX = field.CellWorldX, cellZ = field.CellWorldZ;
            float reach = Mathf.Max(70f, camDistance * 1.6f), hear = Mathf.Max(60f, camDistance * 1.2f);
            float total = 0; int count = 0; float stormNear = 0;
            for (int cy = 0; cy < ch; cy++)
            {
                float z = (cy + .5f) * cellZ, dz = z - focus.z;
                if (Mathf.Abs(dz) > reach + cellZ) continue;
                for (int cx = 0; cx < cw; cx++)
                {
                    float x = (cx + .5f) * cellX, dx = DxWrap(focus.x, x, period);
                    float d = Mathf.Sqrt(dx * dx + dz * dz);
                    if (d > reach + cellX) continue;
                    float s = field.SampleCells(WeatherField.Channel.Storm, cx + .5f, cy + .5f);
                    if (d < hear) stormNear = Mathf.Max(stormNear, s * Mathf.Clamp01(1.2f - d / hear));
                    float w = s - .35f;
                    if (w <= 0) continue;
                    total += w * w;
                    weight[count] = total; weightCell[count] = cy * cw + cx; count++;
                }
            }
            lastStormNear = stormNear;
            if (count == 0 || simRate <= 0) return;
            float strikesPerSecond = Mathf.Min(1.4f, total * 1.1f);
            if (time - lastStrike < .5f || rng.NextDouble() > strikesPerSecond * .25f) return;
            float pick = (float)rng.NextDouble() * total;
            int k = 0; while (k < count - 1 && weight[k] < pick) k++;
            int cell = weightCell[k];
            float mx = (cell % cw + (float)rng.NextDouble()) * cellX, mz = (cell / cw + (float)rng.NextDouble()) * cellZ;
            float my = groundAt != null ? groundAt(mx, mz) : 0;
            float strength = Mathf.Clamp01(.55f + field.SampleCells(WeatherField.Channel.Storm, mx / cellX, mz / cellZ) * .6f);
            lastStrike = time;
            float nearX = focus.x + DxWrap(focus.x, mx, period);
            strikes[strikeNext] = new Vector4(nearX, my, -mz, time);
            strikeAmp[strikeNext] = intensity > .001f ? strength : 0f;
            strikeNext = (strikeNext + 1) % 4;
            float dist = Mathf.Sqrt((nearX - focus.x) * (nearX - focus.x) + (mz - focus.z) * (mz - focus.z));
            // sound covers about 30 world units a second here: a strike across the screen rumbles in a few seconds later
            Strike?.Invoke(new float3(nearX, my + CloudBase * .5f, mz), Mathf.Clamp(.12f + dist / 30f, .12f, 7f), strength);
        }
        float lastStormNear;

        /// <summary>Distant thunder from a storm system beyond the strike range (no bolt): position, delay, loudness.</summary>
        public void Rumble(float3 mapPos, float delay, float loudness) => Strike?.Invoke(mapPos, delay, loudness);

        static float DxWrap(float from, float to, float period)
        {
            float d = to - from;
            if (period > 0) { d = Mathf.Repeat(d + period * .5f, period) - period * .5f; }
            return d;
        }

        public void Draw()
        {
            if (blend == null) return;
            var bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f);
            if (curtainCount > 0) Graphics.RenderMeshPrimitives(Params(blend, curtainBlock, bounds), MeshKit.Quad, 0, curtainCount);
            if (drawBolts) Graphics.RenderMeshPrimitives(Params(additive, boltBlock, bounds), MeshKit.Quad, 0, 4);
        }

        static RenderParams Params(Material m, MaterialPropertyBlock b, Bounds bounds) =>
            new RenderParams(m) { worldBounds = bounds, matProps = b, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };

        public void Dispose()
        {
            if (blend != null) UnityEngine.Object.Destroy(blend);
            if (additive != null) UnityEngine.Object.Destroy(additive);
            strikeAmp = Vector4.zero;
            Shader.SetGlobalVector(StrikeAmpId, strikeAmp);
        }
    }
}
