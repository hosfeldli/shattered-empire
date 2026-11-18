using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Ground decals where infantry fell: photographed blood splatter (Workshop/Textures/Blood*, from the
    /// owner's Asset Store decal pack) on flat instanced quads; each fades out 90 s after it was made.
    /// Absent when the workshop media has not been ingested; nothing else depends on them.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        const int MaxDecals = 600;
        const float BloodHold = 40f, BloodFade = 50f;
        static readonly string[] BloodTextures = { "Blood1", "Blood3", "Blood5", "Blood7" };
        FadingMarks[] decals;
        Material[] decalMaterials;
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
            decalQuad = FadingMarks.Quad("SE decal quad");
            decals = new FadingMarks[decalMaterials.Length];
            int each = MaxDecals / decalMaterials.Length;
            for (int i = 0; i < decals.Length; i++)
                decals[i] = new FadingMarks(FadingMarks.NewBatch(decalQuad, decalMaterials[i], each, false), each, BloodHold, BloodFade, sink: false);
        }

        /// <summary>A blood mark on the ground at a map position (infantry casualty). size in world units.</summary>
        public void Blood(float3 mapPos, float size)
        {
            EnsureDecals();
            if (decals == null) return;
            int k = rng.Next(decals.Length);
            float s = size * (.8f + R() * .5f);
            var d = InstanceData.TRS(MapSpace.W(mapPos) + new float3(0, .004f, 0), R() * 6.28f, new float3(s, 1, s * (.75f + R() * .5f)),
                new float4(.55f + R() * .15f, .5f, .5f, .62f + R() * .25f));
            decals[k].Add(d, markClock);
        }

        void DrawDecals(WrapImages images)
        {
            if (decals == null) return;
            foreach (var b in decals) b.Draw(images);
        }

        void ClearDecals()
        {
            if (decals == null) return;
            foreach (var b in decals) b.Clear();
        }

        void RefreshDecals(float now)
        {
            if (decals == null) return;
            foreach (var b in decals) b.Refresh(now);
        }

        void DisposeDecals()
        {
            if (decals != null) foreach (var b in decals) b.Dispose();
            if (decalMaterials != null) foreach (var m in decalMaterials) Object.Destroy(m);
            if (decalQuad != null) Object.Destroy(decalQuad);
        }
    }
}
