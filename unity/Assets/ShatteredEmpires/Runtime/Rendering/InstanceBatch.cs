using System;
using System.Runtime.InteropServices;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Rendering
{
    /// <summary>One instance for SE/InstancedLit: a 3x4 object-to-world transform and a colour.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct InstanceData
    {
        public float4 Row0, Row1, Row2;
        public float4 Color;   // rgb albedo, a emission

        public const int Stride = 64;

        /// <summary>Translation, yaw about Y (radians), non-uniform scale.</summary>
        public static InstanceData TRS(float3 p, float yaw, float3 s, float4 color)
        {
            math.sincos(yaw, out float sn, out float cs);
            // R_y(yaw) * S: columns x' = (cos,0,-sin)*sx, y' = (0,1,0)*sy, z' = (sin,0,cos)*sz
            return new InstanceData
            {
                Row0 = new float4(cs * s.x, 0, sn * s.z, p.x),
                Row1 = new float4(0, s.y, 0, p.y),
                Row2 = new float4(-sn * s.x, 0, cs * s.z, p.z),
                Color = color,
            };
        }

        /// <summary>General transform from a rotation quaternion.</summary>
        public static InstanceData TRS(float3 p, quaternion q, float3 s, float4 color)
        {
            var m = new float3x3(q);
            return new InstanceData
            {
                Row0 = new float4(m.c0.x * s.x, m.c1.x * s.y, m.c2.x * s.z, p.x),
                Row1 = new float4(m.c0.y * s.x, m.c1.y * s.y, m.c2.y * s.z, p.y),
                Row2 = new float4(m.c0.z * s.x, m.c1.z * s.y, m.c2.z * s.z, p.z),
                Color = color,
            };
        }
    }

    /// <summary>
    /// A procedurally instanced draw: one mesh, one material, a GPU buffer of instances uploaded only
    /// when the contents change, drawn with Graphics.RenderMeshPrimitives. Static batches keep base-image
    /// positions and are drawn at each world-wrap image that the camera can see.
    /// </summary>
    public sealed class InstanceBatch : IDisposable
    {
        static readonly int InstancesId = Shader.PropertyToID("_Instances");
        static readonly int ImageOffsetId = Shader.PropertyToID("_SE_ImageOffset");

        public readonly Mesh Mesh;
        public readonly Material Material;
        public NativeArray<InstanceData> Data;
        public int Count;
        public Bounds Bounds;
        public ShadowCastingMode Shadows = ShadowCastingMode.On;
        public bool ReceiveShadows = true;
        /// <summary>
        /// GPU buffers rotated per upload. Batches rewritten every frame (units, markers) use 3, so a
        /// frame never writes a buffer the GPU may still be reading (which would stall the CPU until the
        /// GPU caught up); batches that change rarely (cities, trees) use 1.
        /// </summary>
        public int Buffering = 1;
        GraphicsBuffer[] buffers;
        int currentBuffer;
        GraphicsBuffer buffer;
        readonly MaterialPropertyBlock[] blocks = { new MaterialPropertyBlock(), new MaterialPropertyBlock(), new MaterialPropertyBlock() };
        bool dirty;

        public InstanceBatch(Mesh mesh, Material material, int capacity)
        {
            Mesh = mesh;
            Material = material;
            Data = new NativeArray<InstanceData>(Math.Max(16, capacity), Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
        }

        public void Clear() { Count = 0; dirty = true; }

        public void Add(in InstanceData d)
        {
            if (Count >= Data.Length) Grow(Data.Length * 2);
            Data[Count++] = d;
            dirty = true;
        }

        public void Grow(int capacity)
        {
            if (capacity <= Data.Length) return;
            var next = new NativeArray<InstanceData>(capacity, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
            NativeArray<InstanceData>.Copy(Data, next, Count);
            Data.Dispose();
            Data = next;
        }

        public void MarkDirty() => dirty = true;

        public void Upload()
        {
            if (!dirty) return;
            dirty = false;
            if (Count == 0) return;
            if (buffers == null || buffers.Length != Math.Max(1, Buffering))
            {
                if (buffers != null) foreach (var old in buffers) old?.Release();
                buffers = new GraphicsBuffer[Math.Max(1, Buffering)];
            }
            currentBuffer = (currentBuffer + 1) % buffers.Length;
            ref var target = ref buffers[currentBuffer];
            if (target == null || target.count < Count)
            {
                target?.Release();
                target = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Math.Max(Count, Data.Length), InstanceData.Stride);
            }
            target.SetData(Data, 0, 0, Count);
            buffer = target;
            foreach (var b in blocks) b.SetBuffer(InstancesId, buffer);
        }

        /// <summary>Draw once at the given wrap-image offset (instances already in the right image).</summary>
        public void Draw(float imageOffset = 0f, int block = 0, int layer = 0, Mesh meshOverride = null)
        {
            if (Count == 0) return;
            Upload();
            if (buffer == null) return;
            var mpb = blocks[block];
            mpb.SetVector(ImageOffsetId, new Vector4(imageOffset, 0, 0, 0));
            var b = Bounds;
            b.center += new Vector3(imageOffset, 0, 0);
            var rp = new RenderParams(Material)
            {
                worldBounds = b,
                matProps = mpb,
                shadowCastingMode = Shadows,
                receiveShadows = ReceiveShadows,
                layer = layer,
            };
            Graphics.RenderMeshPrimitives(rp, meshOverride != null ? meshOverride : Mesh, 0, Count);
        }

        /// <summary>Draw at every world-wrap image of this batch that intersects the frustum.</summary>
        public void DrawImages(WrapImages images)
        {
            if (Count == 0) return;
            int n = images.For(Bounds, out float a, out float b, out float c);
            if (n > 0) Draw(a, 0);
            if (n > 1) Draw(b, 1);
            if (n > 2) Draw(c, 2);
        }

        public void Dispose()
        {
            if (buffers != null) foreach (var b in buffers) b?.Release();
            buffers = null;
            buffer = null;
            if (Data.IsCreated) Data.Dispose();
        }
    }

    /// <summary>
    /// The one place that decides which east-west images of something the camera sees. Everything
    /// placed in base-image coordinates goes through this, so wrapping is never fixed per renderer.
    /// </summary>
    public sealed class WrapImages
    {
        public float Period;
        public bool Wrap;
        public float CameraX;
        readonly Plane[] planes = new Plane[6];

        public void Begin(Camera cam, float period, bool wrap)
        {
            Period = period; Wrap = wrap;
            CameraX = cam.transform.position.x;
            GeometryUtility.CalculateFrustumPlanes(cam, planes);
        }

        public bool Visible(Bounds b) => GeometryUtility.TestPlanesAABB(planes, b);

        /// <summary>Offsets (up to three) at which bounds b is visible.</summary>
        public int For(Bounds b, out float o0, out float o1, out float o2)
        {
            o0 = o1 = o2 = 0;
            if (!Wrap || Period <= 0) { if (Visible(b)) return 1; return 0; }
            float near = Period * Mathf.Round((CameraX - b.center.x) / Period);
            int n = 0;
            for (int k = -1; k <= 1; k++)
            {
                float off = near + k * Period;
                var s = b;
                s.center += new Vector3(off, 0, 0);
                if (!Visible(s)) continue;
                if (n == 0) o0 = off; else if (n == 1) o1 = off; else o2 = off;
                n++;
                if (n == 3) break;
            }
            return n;
        }
    }
}
