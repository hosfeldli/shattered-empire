using System;
using System.Runtime.InteropServices;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    [StructLayout(LayoutKind.Sequential)]
    struct ParticleGpu
    {
        public float4 Position;   // xyz, size
        public float4 Color;      // rgb, opacity
        public float4 Shape;      // rotation, softness, seed, heat
        public float4 Extra;      // stretch xyz, kind
    }

    /// <summary>
    /// Combat and weather presentation from the server's event stream: muzzle flashes and tracers,
    /// explosions with fireballs, dust and rising smoke, flak air bursts, building fires with flames and
    /// embers, the strategic-strike and reactor sequences (flash, fireball, mushroom cloud, ground
    /// shockwaves), rain streaks and splashes, persistent craters and wrecks. A fixed particle budget
    /// (pooled, two draws per frame, triple-buffered uploads) keeps cost bounded however large the
    /// battle; when the budget is reached new cosmetic particles are skipped, never state. The API takes
    /// map coordinates (x east, z south); conversion to Unity space happens inside.
    /// </summary>
    public sealed partial class EffectsRenderer : IDisposable
    {
        public const int Puff = 0, Flame = 1, Ring = 2, Streak = 3;

        struct Particle
        {
            public float3 Pos, Vel, Stretch;
            public float Size, Grow, Life, Max, Rot, Spin, Seed, Heat, Drag, Rise, Kind;
            public float3 Color0, Color1;
            public float Alpha;
            public bool Additive, StretchWithVelocity;
        }

        static readonly int ParticlesId = Shader.PropertyToID("_Particles");
        static readonly int ImageOffsetId = Shader.PropertyToID("_SE_ImageOffset");

        readonly Particle[] pool;
        int count;
        public readonly int Budget = 16000;
        NativeArray<ParticleGpu> addData, alphaData;
        readonly GraphicsBuffer[] addBuffers = new GraphicsBuffer[3], alphaBuffers = new GraphicsBuffer[3];
        int frameSlot;
        readonly MaterialPropertyBlock addBlock = new MaterialPropertyBlock(), alphaBlock = new MaterialPropertyBlock();
        int addCount, alphaCount;
        readonly InstanceBatch craters, wrecks;
        int craterHead, wreckHead;
        const int MaxCraters = 4000, MaxWrecks = 800;
        readonly System.Random rng = new System.Random(5);
        public int Live => count;
        public int Skipped { get; private set; }
        public float Intensity = 1f;
        /// <summary>Camera shake requested by nearby blasts (decays; the camera reads it).</summary>
        public float Shake;
        /// <summary>A brief full-scene flash (strategic blasts, lightning); the atmosphere reads it.</summary>
        public float Flash;

        public EffectsRenderer()
        {
            pool = new Particle[Budget];
            addData = new NativeArray<ParticleGpu>(Budget, Allocator.Persistent);
            alphaData = new NativeArray<ParticleGpu>(Budget, Allocator.Persistent);
            craters = new InstanceBatch(MeshKit.Disc, RenderResources.Instanced, MaxCraters) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off };
            wrecks = new InstanceBatch(MeshKit.Wreck, RenderResources.Instanced, MaxWrecks) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
        }

        float R() => (float)rng.NextDouble();
        float3 RandDir() => math.normalizesafe(new float3(R() - 0.5f, R() - 0.5f, R() - 0.5f), new float3(0, 1, 0));

        void Emit(float3 mapPos, float3 mapVel, float size, float grow, float life, float3 c0, float3 c1, float alpha, bool additive,
            float heat = 0, float drag = 1.5f, float rise = 0, float kind = Puff, float3 mapStretch = default, bool stretchWithVelocity = false)
        {
            if (count >= pool.Length) { Skipped++; return; }
            pool[count++] = new Particle
            {
                Pos = MapSpace.W(mapPos), Vel = MapSpace.W(mapVel), Stretch = MapSpace.W(mapStretch), Size = size, Grow = grow, Life = 0, Max = life,
                Rot = R() * 6.28f, Spin = (R() - 0.5f) * 1.2f, Seed = R() * 100f, Heat = heat, Drag = drag, Rise = rise, Kind = kind,
                Color0 = c0, Color1 = c1, Alpha = alpha, Additive = additive, StretchWithVelocity = stretchWithVelocity,
            };
        }

        // ------------------------------------------------------------------ combat
        public void Explosion(float3 p, float scale)
        {
            FlashLight(p, scale);
            int n = Mathf.Max(2, (int)(7 * Intensity));
            Emit(p + new float3(0, 0.05f * scale, 0), float3.zero, 0.4f * scale, 1.4f * scale, 0.16f, new float3(1f, 0.88f, 0.6f), new float3(1f, 0.5f, 0.2f), 1f, true, 2.5f);
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 0.8f + 0.2f, R() - 0.5f) * 0.9f * scale;
                Emit(p + new float3(0, 0.04f, 0), v, 0.13f * scale, 0.5f * scale, 0.35f + R() * 0.25f, new float3(1f, 0.6f, 0.2f), new float3(0.5f, 0.12f, 0.04f), 0.9f, true, 1.5f, 3f);
            }
            for (int k = 0; k < n + 3; k++)
            {
                var v = new float3(R() - 0.5f, R() * 0.5f + 0.3f, R() - 0.5f) * 0.45f * scale;
                float g = 0.1f + R() * 0.1f;
                Emit(p + new float3(0, 0.05f, 0), v, 0.15f * scale, 0.35f * scale, 2.5f + R() * 2.5f, new float3(0.18f + g, 0.16f + g, 0.14f + g), new float3(0.48f, 0.47f, 0.45f), 0.6f, false, 0, 1.2f, 0.12f);
            }
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 1.5f + 0.7f, R() - 0.5f) * 0.65f * scale;
                Emit(p, v, 0.035f * scale, 0.01f, 0.8f, new float3(0.22f, 0.18f, 0.14f), new float3(0.2f, 0.16f, 0.12f), 0.95f, false, 0, 0.4f, -2.4f);
            }
            for (int k = 0; k < n; k++)
            {
                var v = RandDir() * (1.2f + R()) * scale; v.y = math.abs(v.y) + 0.4f;
                Emit(p + new float3(0, 0.05f, 0), v, 0.008f, 0, 0.4f + R() * 0.3f, new float3(1f, 0.8f, 0.4f), new float3(1f, 0.35f, 0.1f), 1f, true, 2f, 0.8f, -1.8f, Streak, default, true);
            }
            if (scale > .48f) GroundShock(p, scale * 1.65f, .65f + scale * .24f);
            Shake = Mathf.Max(Shake, 0.12f * scale);
        }

        public void AirBurst(float3 p)
        {
            Emit(p, float3.zero, 0.2f, 0.7f, 0.12f, new float3(1f, 0.85f, 0.6f), new float3(1f, 0.6f, 0.3f), 1f, true, 2.2f);
            for (int k = 0; k < 5; k++)
                Emit(p, RandDir() * 1.4f, 0.006f, 0, 0.35f, new float3(1f, 0.85f, 0.5f), new float3(1f, 0.4f, 0.1f), 1f, true, 2f, 1f, -0.5f, Streak, default, true);
            for (int k = 0; k < 3; k++)
                Emit(p + RandDir() * 0.04f, RandDir() * 0.05f, 0.1f, 0.22f, 4f + R() * 2f, new float3(0.14f, 0.14f, 0.15f), new float3(0.3f, 0.3f, 0.32f), 0.7f, false, 0, 0.8f, 0.01f);
        }

        public void Muzzle(float3 p, bool heavy)
        {
            Emit(p, float3.zero, heavy ? 0.13f : 0.05f, heavy ? 0.6f : 0.3f, heavy ? 0.09f : 0.05f, new float3(1f, 0.92f, 0.65f), new float3(1f, 0.6f, 0.2f), 1f, true, 3f);
            if (heavy) Emit(p, new float3(0, 0.1f, 0), 0.09f, 0.4f, 1.6f, new float3(0.5f, 0.5f, 0.48f), new float3(0.62f, 0.62f, 0.6f), 0.35f, false, 0, 1f, 0.05f);
        }

        /// <summary>A tracer or shell streak flying from a to b.</summary>
        public void Tracer(float3 a, float3 b, bool heavy)
        {
            float3 d = b - a;
            float len = math.length(d);
            if (len < 0.05f) return;
            float speed = heavy ? 9f : 14f;
            var dir = d / len;
            Emit(a, dir * speed, heavy ? 0.012f : 0.006f, 0, len / speed, heavy ? new float3(1f, 0.75f, 0.4f) : new float3(1f, 0.9f, 0.55f), new float3(1f, 0.6f, 0.25f), 0.9f, true, 2.5f, 0, 0, Streak, dir * (heavy ? 0.18f : 0.12f));
        }

        /// <summary>Continuous fire on a burning building: flames, embers and a smoke column.</summary>
        public void Fire(float3 p, float size)
        {
            for (int k = 0; k < 3; k++)
            {
                var o = new float3(R() - 0.5f, 0, R() - 0.5f) * size;
                Emit(p + o, new float3(Wind.x * .035f, .045f + R() * .055f, Wind.z * .035f), size * (.24f + R() * .22f),
                    -.018f, .35f + R() * .38f, new float3(1, .91f, .72f), new float3(.78f, .42f, .16f), .82f, true, .16f, .5f, .015f, Flame);
            }
            if (R() < 0.6f)
            {
                var ev = new float3(R() - 0.5f, 1f + R(), R() - 0.5f) * 0.3f;
                Emit(p + new float3(R() - 0.5f, 0.1f, R() - 0.5f) * size, ev, 0.004f, 0, 1.2f + R(), new float3(1f, 0.6f, 0.2f), new float3(0.8f, 0.2f, 0.05f), 1f, true, 2f, 0.3f, 0.2f, Streak, default, true);
            }
            float g = R() * 0.06f;
            Emit(p + new float3(0, size * .7f, 0), Wind * .07f + new float3((R() - .5f) * .05f, .20f, (R() - .5f) * .05f),
                size * .42f, size * .55f, 3.3f + R() * 1.4f, new float3(.08f + g, .075f + g, .07f + g), new float3(.32f, .31f, .3f), .46f, false, 0, .35f, .055f);
        }

        /// <summary>
        /// A strategic warhead (scale 1) or a reactor (scale 0.5): blinding flash, fireball, a mushroom
        /// cloud that climbs and spreads, and shockwave rings racing across the ground.
        /// </summary>
        public void Strategic(float3 p, float scale)
        {
            Flash = Mathf.Max(Flash, scale);
            Shake = Mathf.Max(Shake, 1.2f * scale);
            Emit(p + new float3(0, 0.5f * scale, 0), float3.zero, 3f * scale, 9f * scale, 0.5f, new float3(1f, 0.97f, 0.9f), new float3(1f, 0.7f, 0.4f), 1f, true, 4f);
            for (int k = 0; k < 18; k++)
            {
                var v = new float3(R() - 0.5f, 0.6f + R() * 0.5f, R() - 0.5f) * 1.6f * scale;
                Emit(p + new float3(0, 0.3f, 0), v, 0.9f * scale, 1.4f * scale, 1.6f + R(), new float3(1f, 0.7f, 0.3f), new float3(0.6f, 0.15f, 0.05f), 0.95f, true, 2.5f, 1.5f, 0.6f);
            }
            for (int k = 0; k < 28; k++)
            {
                float h = R();
                var v = new float3((R() - 0.5f) * 0.12f, .72f + h * .65f, (R() - 0.5f) * 0.12f) * scale;
                float g = 0.12f + R() * 0.1f;
                Emit(p + new float3((R() - 0.5f) * .32f, .4f + h * 1.65f, (R() - 0.5f) * .32f) * scale, v,
                    .36f * scale, .12f * scale, 12f + R() * 4f, new float3(.40f + g, .36f + g, .30f + g),
                    new float3(.44f, .44f, .43f), .65f, false, 0, .26f, .015f);
            }
            for (int k = 0; k < 28; k++)
            {
                float angle = k * 2.39996f;
                var o = new float3(math.cos(angle), .12f + R() * .2f, math.sin(angle));
                float radius = .8f + R() * .9f;
                Emit(p + new float3(0, 2.6f * scale, 0) + o * radius * scale,
                    new float3(o.x * .25f, .75f, o.z * .25f) * scale, .53f * scale, .15f * scale,
                    14f + R() * 4f, new float3(.57f, .52f, .45f), new float3(.52f, .52f, .51f), .64f, false, 0, .20f, .025f);
            }
            GroundShock(p, 22 * scale, 2.4f);
            // A filled cap above the stem: the outer billows alone make a hollow ring.
            for (int k = 0; k < 20; k++)
            {
                float a = k * 2.39996f, r = math.sqrt(R()) * 1.1f;
                var offset = new float3(math.cos(a) * r, 3.1f + R() * .45f, math.sin(a) * r) * scale;
                Emit(p + offset, new float3(0, .70f, 0) * scale, .72f * scale, .15f * scale, 13f + R() * 3f,
                    new float3(.52f, .48f, .42f), new float3(.48f, .49f, .49f), .60f, false, 0, .18f, .02f);
            }
            for (int k = 0; k < 48; k++)
            {
                float a = k * 6.283f / 48;
                var v = new float3(math.cos(a), 0.05f, math.sin(a)) * (6f + R() * 2f) * scale;
                Emit(p + new float3(0, 0.12f, 0), v, .18f * scale, .18f * scale, 2.3f + R() * .6f, new float3(.6f, .55f, .47f), new float3(.55f, .52f, .48f), .36f, false, 0, .7f, .02f);
            }
        }

        /// <summary>
        /// Working industry: a chimney's soot (dark, thin, drifting downwind) or a cooling tower's
        /// steam (white, billowing, short-lived). Called a few times a second per stack.
        /// </summary>
        public void Smoke(float3 p, float3 windMap, bool steam, float size)
        {
            float g = R() * 0.08f;
            if (steam)
                Emit(p + new float3(R() - 0.5f, 0, R() - 0.5f) * size * 0.4f, new float3(windMap.x * 0.25f, 0.35f + R() * 0.15f, windMap.z * 0.25f), size * 0.5f, size * 0.9f, 3f + R() * 1.5f,
                    new float3(0.92f, 0.92f, 0.9f), new float3(0.85f, 0.86f, 0.88f), 0.5f, false, 0, 0.6f, 0.05f);
            else
                Emit(p, new float3(windMap.x * 0.3f, 0.3f + R() * 0.1f, windMap.z * 0.3f), size * 0.25f, size * 0.7f, 5f + R() * 2f,
                    new float3(0.16f + g, 0.15f + g, 0.14f + g), new float3(0.42f, 0.41f, 0.4f), 0.4f, false, 0, 0.3f, 0.04f);
        }

        // ------------------------------------------------------------------ weather
        /// <summary>Rain around the camera: falling streaks and splashes on the ground.</summary>
        public void Rain(float3 focusMap, float intensity, float3 windMap, Func<float, float, float> ground, float radius)
        {
            int drops = (int)(intensity * 40 * Intensity);
            for (int k = 0; k < drops; k++)
            {
                float gx = focusMap.x + (R() - 0.5f) * 2 * radius, gz = focusMap.z + (R() - 0.5f) * 2 * radius;
                float gy = ground(gx, gz);
                var vel = new float3(windMap.x * 1.5f, -9f, windMap.z * 1.5f);
                float h = 1.2f + R() * radius * 0.4f;
                Emit(new float3(gx - vel.x * h / 9f, gy + h, gz - vel.z * h / 9f), vel, 0.004f + radius * 0.0002f, 0, h / 9f, new float3(0.75f, 0.8f, 0.85f), new float3(0.75f, 0.8f, 0.85f), 0.35f, false, 0, 0, 0, Streak, vel * 0.03f);
                if (R() < 0.3f) Emit(new float3(gx, gy + 0.01f, gz), float3.zero, 0.01f, 0.12f, 0.25f, new float3(0.8f, 0.85f, 0.9f), new float3(0.8f, 0.85f, 0.9f), 0.3f, false, 0, 0, 0, Ring);
            }
        }

        // ------------------------------------------------------------------ persistent marks
        public void Crater(float3 p, float size)
        {
            var d = InstanceData.TRS(MapSpace.W(p) + new float3(0, 0.006f, 0), R() * 6.28f, new float3(size, 1, size * (0.8f + R() * 0.4f)), new float4(0.14f, 0.11f, 0.09f, 0));
            if (craters.Count < MaxCraters) craters.Add(d);
            else { craters.Data[craterHead] = d; craterHead = (craterHead + 1) % MaxCraters; craters.MarkDirty(); }
        }

        public void Wreck(float3 p, float yaw, float scale)
        {
            var d = InstanceData.TRS(MapSpace.W(p), MapSpace.Yaw(yaw), new float3(scale), new float4(0.2f, 0.19f, 0.18f, 0));
            if (wrecks.Count < MaxWrecks) wrecks.Add(d);
            else { wrecks.Data[wreckHead] = d; wreckHead = (wreckHead + 1) % MaxWrecks; wrecks.MarkDirty(); }
            for (int k = 0; k < 3; k++) Emit(p, new float3(0, 0.15f, 0), 0.1f, 0.4f, 6f, new float3(0.1f, 0.1f, 0.1f), new float3(0.3f, 0.3f, 0.3f), 0.5f, false, 0, 0.4f, 0.06f);
        }

        public void ClearPersistent()
        {
            craters.Clear(); wrecks.Clear(); missileBodies?.Clear(); missileBodies?.MarkDirty();
            craterHead = wreckHead = 0; count = flightCount = waveCount = waveVertexCount = 0;
            Flash = Shake = 0;
        }

        public void Update(float dt, float camX, float period, bool wrap, float simulationRate = 1f)
        {
            UpdateFlights(dt * simulationRate);
            UpdateGroundWaves(dt * simulationRate);
            for (int i = 0; i < flashLights.Length; i++) if (flashLights[i] != null && flashLife[i] > 0)
            { flashLife[i] -= dt; flashLights[i].intensity *= math.exp(-dt * 22); if (flashLife[i] <= 0) flashLights[i].enabled = false; }
            addCount = alphaCount = 0;
            Shake = Mathf.Max(0, Shake - dt * 1.6f);
            Flash = Mathf.Max(0, Flash - dt * 1.2f);
            for (int i = 0; i < count; i++)
            {
                ref var p = ref pool[i];
                p.Life += dt;
                if (p.Life >= p.Max) { pool[i] = pool[--count]; i--; continue; }
                float t = p.Life / p.Max;
                p.Vel *= Mathf.Max(0, 1 - p.Drag * dt);
                if (p.Kind == Puff && !p.Additive && p.Rise >= 0) p.Vel += MapSpace.W(Wind) * (dt * .045f);
                p.Vel.y += p.Rise * dt;
                p.Pos += p.Vel * dt;
                p.Size = Mathf.Max(0.002f, p.Size + p.Grow * dt);
                if (p.Kind == Puff) p.Rot += p.Spin * dt;
                float fade = p.Kind == Ring ? 1f - t : t < .1f ? t / .1f : 1f - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.4f, 1f, t));
                float x = wrap ? HexMath.NearX(p.Pos.x, camX, period, true) : p.Pos.x;
                float3 stretch = p.StretchWithVelocity ? p.Vel * 0.04f : p.Stretch;
                var g = new ParticleGpu
                {
                    Position = new float4(x, p.Pos.y, p.Pos.z, p.Size),
                    Color = new float4(math.lerp(p.Color0, p.Color1, t), p.Alpha * fade),
                    Shape = new float4(p.Rot, p.Additive ? 0.25f : 0.55f, p.Seed, p.Heat * (1 - t)),
                    Extra = new float4(stretch, p.Kind),
                };
                if (p.Additive) addData[addCount++] = g; else alphaData[alphaCount++] = g;
            }
        }

        void Upload(GraphicsBuffer[] ring, NativeArray<ParticleGpu> data, int n, MaterialPropertyBlock block)
        {
            ref var buffer = ref ring[frameSlot];
            if (buffer == null) buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Budget, Marshal.SizeOf<ParticleGpu>());
            if (n > 0) buffer.SetData(data, 0, 0, n);
            block.SetBuffer(ParticlesId, buffer);
            block.SetVector(ImageOffsetId, Vector4.zero);
        }

        public void Draw(WrapImages images)
        {
            craters.DrawImages(images);
            wrecks.DrawImages(images);
            DrawGroundWaves(images);
            missileBodies?.DrawImages(images);
            var bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f);
            frameSlot = (frameSlot + 1) % 3;
            if (alphaCount > 0)
            {
                Upload(alphaBuffers, alphaData, alphaCount, alphaBlock);
                Graphics.RenderMeshPrimitives(new RenderParams(RenderResources.AlphaBlend) { worldBounds = bounds, matProps = alphaBlock, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, MeshKit.Quad, 0, alphaCount);
            }
            if (addCount > 0)
            {
                Upload(addBuffers, addData, addCount, addBlock);
                Graphics.RenderMeshPrimitives(new RenderParams(RenderResources.Additive) { worldBounds = bounds, matProps = addBlock, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, MeshKit.Quad, 0, addCount);
            }
        }

        public void Dispose()
        {
            foreach (var b in addBuffers) b?.Release();
            foreach (var b in alphaBuffers) b?.Release();
            if (addData.IsCreated) addData.Dispose();
            if (alphaData.IsCreated) alphaData.Dispose();
            craters.Dispose(); wrecks.Dispose();
            missileBodies?.Dispose();
            if (waveMesh != null) UnityEngine.Object.Destroy(waveMesh);
            if (waveMaterial != null) UnityEngine.Object.Destroy(waveMaterial);
            if (lightRoot != null) UnityEngine.Object.Destroy(lightRoot);
        }
    }
}
