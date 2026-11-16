using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Ground decals where infantry fell: photographed blood splatter (Workshop/Textures/Blood*, from the
    /// owner's Asset Store decal pack) on flat instanced quads, persistent in a ring buffer like craters.
    /// Absent when the workshop media has not been ingested; nothing else depends on them.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        const int MaxDecals = 900;
        static readonly string[] BloodTextures = { "Blood1", "Blood3", "Blood5", "Blood7" };
        InstanceBatch[] decals;
        Material[] decalMaterials;
        int[] decalHeads;
        Mesh decalQuad;
        bool decalsTried;

        void EnsureDecals()
        {
            if (decalsTried) return;
            decalsTried = true;
            var shader = Resources.Load<Shader>("Shaders/GroundDecal");
            if (shader == null) return;
            var list = new System.Collections.Generic.List<Material>();
            foreach (var name in BloodTextures)
            {
                var tex = Resources.Load<Texture2D>("Workshop/Textures/" + name);
                if (tex == null) continue;
                var m = new Material(shader) { name = "SE Decal " + name, enableInstancing = true };
                m.SetTexture("_MainTex", tex);
                list.Add(m);
            }
            if (list.Count == 0) return;
            decalMaterials = list.ToArray();
            decalQuad = new Mesh { name = "SE decal quad" };
            decalQuad.SetVertices(new[] { new Vector3(-.5f, 0, -.5f), new Vector3(-.5f, 0, .5f), new Vector3(.5f, 0, .5f), new Vector3(.5f, 0, -.5f) });
            decalQuad.SetUVs(0, new[] { new Vector2(0, 0), new Vector2(0, 1), new Vector2(1, 1), new Vector2(1, 0) });
            decalQuad.SetNormals(new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up });
            decalQuad.SetTriangles(new[] { 0, 1, 2, 0, 2, 3 }, 0);
            decals = new InstanceBatch[decalMaterials.Length];
            decalHeads = new int[decalMaterials.Length];
            for (int i = 0; i < decals.Length; i++)
                decals[i] = new InstanceBatch(decalQuad, decalMaterials[i], 64)
                { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off, ReceiveShadows = true };
        }

        /// <summary>A blood mark on the ground at a map position (infantry casualty). size in world units.</summary>
        public void Blood(float3 mapPos, float size)
        {
            EnsureDecals();
            if (decals == null) return;
            int k = rng.Next(decals.Length);
            var b = decals[k];
            float s = size * (.8f + R() * .5f);
            var d = InstanceData.TRS(MapSpace.W(mapPos) + new float3(0, .004f, 0), R() * 6.28f, new float3(s, 1, s * (.75f + R() * .5f)),
                new float4(.55f + R() * .15f, .5f, .5f, .62f + R() * .25f));
            if (b.Count < MaxDecals / decals.Length) b.Add(d);
            else { b.Data[decalHeads[k]] = d; decalHeads[k] = (decalHeads[k] + 1) % (MaxDecals / decals.Length); b.MarkDirty(); }
        }

        void DrawDecals(WrapImages images)
        {
            if (decals == null) return;
            foreach (var b in decals) b.DrawImages(images);
        }

        void ClearDecals()
        {
            if (decals == null) return;
            foreach (var b in decals) b.Clear();
            for (int i = 0; i < decalHeads.Length; i++) decalHeads[i] = 0;
        }

        void DisposeDecals()
        {
            if (decals != null) foreach (var b in decals) b.Dispose();
            if (decalMaterials != null) foreach (var m in decalMaterials) Object.Destroy(m);
            if (decalQuad != null) Object.Destroy(decalQuad);
        }
    }
}
