using System;
using System.Runtime.InteropServices;
using SE.Core.Protocol;
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
    }

    /// <summary>
    /// Combat presentation from the server's event stream: muzzle flashes, explosions with fireballs
    /// and rising smoke, air bursts for anti-aircraft fire, burning buildings, persistent craters and
    /// wrecks. A fixed particle budget (pooled, two draws per frame) keeps cost bounded however large
    /// the battle; when the budget is reached, new cosmetic particles are skipped, never state.
    /// Effects never decide anything: every impact, hit and kill is the server's. The API takes map
    /// coordinates (x east, z south); conversion to Unity space happens inside.
    /// </summary>
    public sealed class EffectsRenderer : IDisposable
    {
        struct Particle
        {
            public float3 Pos, Vel;
            public float Size, Grow, Life, Max, Rot, Spin, Seed, Heat, Drag, Rise;
            public float3 Color0, Color1;
            public float Alpha;
            public bool Additive;
        }

        static readonly int ParticlesId = Shader.PropertyToID("_Particles");
        static readonly int ImageOffsetId = Shader.PropertyToID("_SE_ImageOffset");

        Particle[] pool;
        int count;
        public int Budget = 12000;
        NativeArray<ParticleGpu> addData, alphaData;
        // three of each, rotated per frame, so a frame never overwrites a buffer the GPU is still reading
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
        public float Intensity = 1f;   // graphics preset scales particle counts

        public EffectsRenderer()
        {
            pool = new Particle[Budget];
            addData = new NativeArray<ParticleGpu>(Budget, Allocator.Persistent);
            alphaData = new NativeArray<ParticleGpu>(Budget, Allocator.Persistent);
            craters = new InstanceBatch(MeshKit.Disc, RenderResources.Instanced, MaxCraters) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off };
            wrecks = new InstanceBatch(MeshKit.Wreck, RenderResources.Instanced, MaxWrecks) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
        }

        float R() => (float)rng.NextDouble();

        void Emit(float3 pos, float3 vel, float size, float grow, float life, float3 c0, float3 c1, float alpha, bool additive, float heat = 0, float drag = 1.5f, float rise = 0)
        {
            if (count >= pool.Length) { Skipped++; return; }
            pool[count++] = new Particle
            {
                Pos = MapSpace.W(pos), Vel = MapSpace.W(vel), Size = size, Grow = grow, Life = 0, Max = life, Rot = R() * 6.28f, Spin = (R() - 0.5f) * 1.5f,
                Seed = R() * 100f, Heat = heat, Drag = drag, Rise = rise, Color0 = c0, Color1 = c1, Alpha = alpha, Additive = additive,
            };
        }

        public void Explosion(float3 p, float scale)
        {
            int n = Mathf.Max(1, (int)(6 * Intensity));
            Emit(p + new float3(0, 0.05f * scale, 0), float3.zero, 0.35f * scale, 1.2f * scale, 0.18f, new float3(1f, 0.85f, 0.55f), new float3(1f, 0.5f, 0.2f), 1f, true, 2.5f);
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 0.8f + 0.2f, R() - 0.5f) * 0.9f * scale;
                Emit(p + new float3(0, 0.04f, 0), v, 0.12f * scale, 0.5f * scale, 0.35f + R() * 0.25f, new float3(1f, 0.6f, 0.2f), new float3(0.5f, 0.12f, 0.04f), 0.9f, true, 1.5f, 3f);
            }
            for (int k = 0; k < n + 2; k++)
            {
                var v = new float3(R() - 0.5f, R() * 0.5f + 0.3f, R() - 0.5f) * 0.45f * scale;
                float g = 0.14f + R() * 0.12f;
                Emit(p + new float3(0, 0.05f, 0), v, 0.14f * scale, 0.32f * scale, 2.2f + R() * 2f, new float3(0.22f + g, 0.2f + g, 0.18f + g), new float3(0.45f, 0.44f, 0.42f), 0.55f, false, 0, 1.2f, 0.12f);
            }
            // dirt thrown up
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 1.4f + 0.6f, R() - 0.5f) * 0.6f * scale;
                Emit(p, v, 0.04f * scale, 0.02f, 0.7f, new float3(0.25f, 0.2f, 0.15f), new float3(0.2f, 0.17f, 0.13f), 0.9f, false, 0, 0.5f, -2.2f);
            }
        }

        public void AirBurst(float3 p)
        {
            Emit(p, float3.zero, 0.18f, 0.6f, 0.15f, new float3(1f, 0.85f, 0.6f), new float3(1f, 0.6f, 0.3f), 1f, true, 2f);
            for (int k = 0; k < 4; k++)
                Emit(p, new float3(R() - 0.5f, R() - 0.5f, R() - 0.5f) * 0.25f, 0.1f, 0.25f, 3f + R() * 2f, new float3(0.18f, 0.18f, 0.18f), new float3(0.32f, 0.32f, 0.33f), 0.6f, false, 0, 0.8f, 0.02f);
        }

        public void Muzzle(float3 p, bool heavy)
        {
            Emit(p, float3.zero, heavy ? 0.12f : 0.05f, heavy ? 0.6f : 0.3f, heavy ? 0.1f : 0.06f, new float3(1f, 0.9f, 0.6f), new float3(1f, 0.6f, 0.2f), 1f, true, 3f);
            if (heavy) Emit(p, new float3(0, 0.1f, 0), 0.08f, 0.35f, 1.4f, new float3(0.5f, 0.5f, 0.48f), new float3(0.6f, 0.6f, 0.58f), 0.35f, false, 0, 1f, 0.05f);
        }

        /// <summary>Continuous fire on a burning building (called a few times a second while it burns).</summary>
        public void Fire(float3 p, float size)
        {
            for (int k = 0; k < 2; k++)
            {
                var o = new float3(R() - 0.5f, 0, R() - 0.5f) * size;
                Emit(p + o, new float3(0, 0.25f + R() * 0.2f, 0), 0.08f * size * 3f, -0.05f, 0.5f + R() * 0.3f, new float3(1f, 0.7f, 0.3f), new float3(0.9f, 0.25f, 0.05f), 0.85f, true, 1.8f, 0.6f, 0.15f);
            }
            Emit(p + new float3(0, 0.2f, 0), new float3(R() - 0.5f, 1.2f, R() - 0.5f) * 0.18f, 0.16f * size * 2f, 0.4f, 4f + R() * 2f, new float3(0.12f, 0.11f, 0.1f), new float3(0.35f, 0.34f, 0.33f), 0.5f, false, 0, 0.4f, 0.08f);
        }

        public void Crater(float3 p, float size)
        {
            var d = InstanceData.TRS(MapSpace.W(p) + new float3(0, 0.006f, 0), R() * 6.28f, new float3(size, 1, size * (0.8f + R() * 0.4f)), new float4(0.17f, 0.14f, 0.11f, 0));
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

        public void ClearPersistent() { craters.Clear(); wrecks.Clear(); craterHead = wreckHead = 0; count = 0; }

        public void Update(float dt, float camX, float period, bool wrap)
        {
            addCount = alphaCount = 0;
            for (int i = 0; i < count; i++)
            {
                ref var p = ref pool[i];
                p.Life += dt;
                if (p.Life >= p.Max) { pool[i] = pool[--count]; i--; continue; }
                float t = p.Life / p.Max;
                p.Vel *= Mathf.Max(0, 1 - p.Drag * dt);
                p.Vel.y += p.Rise * dt;
                p.Pos += p.Vel * dt;
                p.Size = Mathf.Max(0.005f, p.Size + p.Grow * dt);
                p.Rot += p.Spin * dt;
                float fade = t < 0.1f ? t / 0.1f : 1f - Mathf.SmoothStep(0.4f, 1f, t);
                float x = wrap ? HexMath.NearX(p.Pos.x, camX, period, true) : p.Pos.x;
                var g = new ParticleGpu
                {
                    Position = new float4(x, p.Pos.y, p.Pos.z, p.Size),
                    Color = new float4(math.lerp(p.Color0, p.Color1, t), p.Alpha * fade),
                    Shape = new float4(p.Rot, p.Additive ? 0.2f : 0.55f, p.Seed, p.Heat * (1 - t)),
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
        }
    }
}
