using System;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Purely visual, client-side ground marks and debris (scorch and crater decals, blood, building rubble,
    /// legacy wrecks) with a lifetime: each holds for <see cref="Hold"/> seconds, then fades over
    /// <see cref="Fade"/> seconds and is dropped. Decals fade their opacity (instance colour w); opaque debris
    /// sinks into the ground and shrinks, since the instanced lit material has no alpha.
    ///
    /// A fixed-capacity ring in age order (the oldest is overwritten when full), so memory and the instance
    /// count are bounded however long the match. The GPU batch is rewritten from the ring only when something
    /// was added, expired or is fading, and at most every <see cref="RefreshEvery"/> seconds of game time, so a
    /// quiet battlefield costs nothing and a busy one a few hundred microseconds twice a second. No allocation
    /// after construction.
    /// </summary>
    public sealed class FadingMarks : IDisposable
    {
        public const float RefreshEvery = .5f;
        public readonly InstanceBatch Batch;
        public readonly float Hold, Fade;
        public readonly bool Sink;
        readonly InstanceData[] items;
        readonly float[] born;
        readonly int capacity;
        int head, count;
        bool pending;
        float refreshedAt = float.NegativeInfinity;

        public int Count => count;

        public FadingMarks(InstanceBatch batch, int capacity, float hold, float fade, bool sink)
        {
            Batch = batch;
            this.capacity = Math.Max(1, capacity);
            Hold = hold; Fade = Math.Max(.01f, fade); Sink = sink;
            items = new InstanceData[this.capacity];
            born = new float[this.capacity];
            batch.Grow(this.capacity);
        }

        /// <summary>Adds a mark made at game time now (the oldest is replaced when full).</summary>
        public void Add(in InstanceData d, float now)
        {
            int slot;
            if (count < capacity) slot = (head + count++) % capacity;
            else { slot = head; head = (head + 1) % capacity; }
            items[slot] = d; born[slot] = now;
            pending = true;
        }

        /// <summary>Drops expired marks and rewrites the faded instances (throttled; call every frame).</summary>
        public void Refresh(float now)
        {
            float life = Hold + Fade;
            while (count > 0 && now - born[head] >= life) { head = (head + 1) % capacity; count--; pending = true; }
            bool fading = count > 0 && now - born[head] > Hold;
            if (!pending && !fading) return;
            // new marks show at once; fading alone is advanced in steps
            if (!pending && now - refreshedAt < RefreshEvery) return;
            refreshedAt = now;
            pending = false;
            Batch.Clear();
            for (int i = 0; i < count; i++)
            {
                int slot = (head + i) % capacity;
                float age = now - born[slot];
                if (age <= Hold) { Batch.Add(items[slot]); continue; }
                float t = Mathf.SmoothStep(0f, 1f, (age - Hold) / Fade);
                var d = items[slot];
                if (Sink)
                {
                    // shrink toward 40% and settle into the ground by most of its own height
                    float k = 1f - .6f * t;
                    float height = math.length(new float3(d.Row0.y, d.Row1.y, d.Row2.y));
                    d.Row0.xyz *= k; d.Row1.xyz *= k; d.Row2.xyz *= k;
                    d.Row1.w -= height * .7f * t;
                }
                else d.Color.w *= 1f - t;
                Batch.Add(d);
            }
            Batch.MarkDirty();
        }

        public void Clear() { head = count = 0; pending = false; Batch.Clear(); }

        public void Draw(WrapImages images) => Batch.DrawImages(images);

        public void Dispose() => Batch.Dispose();

        /// <summary>A flat unit quad on XZ (UVs 0..1, normal up) for ground decals.</summary>
        public static Mesh Quad(string name)
        {
            var quad = new Mesh { name = name };
            quad.SetVertices(new[] { new Vector3(-.5f, 0, -.5f), new Vector3(-.5f, 0, .5f), new Vector3(.5f, 0, .5f), new Vector3(.5f, 0, -.5f) });
            quad.SetUVs(0, new[] { new Vector2(0, 0), new Vector2(0, 1), new Vector2(1, 1), new Vector2(1, 0) });
            quad.SetNormals(new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up });
            quad.SetTriangles(new[] { 0, 1, 2, 0, 2, 3 }, 0);
            return quad;
        }

        internal static InstanceBatch NewBatch(Mesh mesh, Material material, int capacity, bool shadows)
            => new InstanceBatch(mesh, material, capacity)
            {
                Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f),
                Shadows = shadows ? ShadowCastingMode.On : ShadowCastingMode.Off,
                ReceiveShadows = true,
            };
    }
}
