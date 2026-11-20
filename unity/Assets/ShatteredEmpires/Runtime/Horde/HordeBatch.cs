using System;
using System.Runtime.InteropServices;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Horde
{
    /// <summary>One creature for SE/HordeLit: where it stands and the state its animation is computed from (64 bytes).</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct HordeInstance
    {
        public float4 PosYaw;   // xyz Unity world position of the feet, w Unity yaw (radians)
        public float4 Motion;   // x scale, y gait phase (radians), z moving 0..1, w seed
        public float4 Events;   // x strike time, y rise time, z elite level, w health 0..1
        public float4 Extra;    // x engaged (1/0)

        public const int Stride = 64;
    }

    /// <summary>
    /// One creature kind at one level of detail: a persistent CPU array and three rotating GPU buffers (a frame never
    /// writes the buffer the GPU may still be reading), reused every frame; they grow only when the horde outgrows
    /// them. The draw bounds are the union of the visible creatures' spheres, so Unity culls an empty or off-screen
    /// batch (shadows included) for free.
    /// </summary>
    public sealed class HordeBatch : IDisposable
    {
        static readonly int HordeId = Shader.PropertyToID("_Horde");
        public readonly Mesh Mesh;
        public readonly Material Material;
        public ShadowCastingMode Shadows;
        public NativeArray<HordeInstance> Data;
        public int Count;
        readonly GraphicsBuffer[] buffers = new GraphicsBuffer[3];
        readonly MaterialPropertyBlock[] blocks = { new MaterialPropertyBlock(), new MaterialPropertyBlock(), new MaterialPropertyBlock() };
        int current = -1;
        Vector3 min, max;

        public HordeBatch(Mesh mesh, Material material, int capacity, ShadowCastingMode shadows)
        {
            Mesh = mesh; Material = material; Shadows = shadows;
            Data = new NativeArray<HordeInstance>(Math.Max(16, capacity), Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
        }

        public void Clear() { Count = 0; }

        public void Add(in HordeInstance d, float3 center, float radius)
        {
            if (Count >= Data.Length)
            {
                var next = new NativeArray<HordeInstance>(Data.Length * 2, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
                NativeArray<HordeInstance>.Copy(Data, next, Count);
                Data.Dispose();
                Data = next;
            }
            var lo = new Vector3(center.x - radius, center.y - radius, center.z - radius);
            var hi = new Vector3(center.x + radius, center.y + radius, center.z + radius);
            if (Count == 0) { min = lo; max = hi; }
            else { min = Vector3.Min(min, lo); max = Vector3.Max(max, hi); }
            Data[Count++] = d;
        }

        /// <summary>Send this frame's records to the next GPU buffer (once per frame, after the last Add).</summary>
        public void Upload()
        {
            if (Count == 0) return;
            current = (current + 1) % buffers.Length;
            ref var buffer = ref buffers[current];
            if (buffer == null || buffer.count < Count)
            {
                buffer?.Release();
                buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Data.Length, HordeInstance.Stride);
            }
            buffer.SetData(Data, 0, 0, Count);
            blocks[current].SetBuffer(HordeId, buffer);
        }

        /// <summary>One draw call for the uploaded creatures (nothing when empty).</summary>
        public void Draw()
        {
            if (Count == 0 || Material == null || current < 0) return;
            var mpb = blocks[current];
            var bounds = new Bounds();
            bounds.SetMinMax(min, max);
            var rp = new RenderParams(Material)
            {
                worldBounds = bounds,
                matProps = mpb,
                shadowCastingMode = Shadows,
                receiveShadows = true,
            };
            Graphics.RenderMeshPrimitives(rp, Mesh, 0, Count);
        }

        public void Dispose()
        {
            for (int i = 0; i < buffers.Length; i++) { buffers[i]?.Release(); buffers[i] = null; }
            if (Data.IsCreated) Data.Dispose();
        }
    }
}
