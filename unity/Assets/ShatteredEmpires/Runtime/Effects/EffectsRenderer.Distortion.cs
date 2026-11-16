using System.Collections.Generic;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Visible shock fronts: expanding refraction domes (SE/Shockwave) for strategic strikes and heavy
    /// blasts. Each wave races out with a decelerating radius and loses strength as it spreads.
    /// <see cref="DistortionActive"/> lets the atmosphere enable the camera colour copy only when needed.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        struct DistortionWave { public float3 Point; public float Age, Duration, Radius, Strength; }
        const int DistortionLimit = 12;
        readonly DistortionWave[] distortions = new DistortionWave[DistortionLimit];
        int distortionCount;
        Mesh dome;
        Material distortionMaterial;
        readonly MaterialPropertyBlock distortionBlock = new MaterialPropertyBlock();
        static readonly int StrengthId = Shader.PropertyToID("_Strength"), FrontId = Shader.PropertyToID("_Front");

        /// <summary>True while any distortion wave is on screen (the camera needs its opaque copy).</summary>
        public bool DistortionActive => distortionCount > 0;

        /// <summary>A shock front at a map position: final radius in world units, duration, relative strength.</summary>
        public void Distortion(float3 mapPos, float radius, float duration, float strength)
        {
            if (Intensity < .2f) return;
            if (distortionCount >= DistortionLimit) { for (int i = 1; i < distortionCount; i++) distortions[i - 1] = distortions[i]; distortionCount--; }
            distortions[distortionCount++] = new DistortionWave { Point = MapSpace.W(mapPos), Radius = radius, Duration = duration, Strength = strength };
        }

        void UpdateDistortions(float dt)
        {
            for (int i = 0; i < distortionCount; i++)
            {
                distortions[i].Age += dt;
                if (distortions[i].Age >= distortions[i].Duration) distortions[i--] = distortions[--distortionCount];
            }
        }

        void DrawDistortions(WrapImages images)
        {
            if (distortionCount == 0) return;
            if (dome == null) { dome = BuildDome(32, 12); distortionMaterial = new Material(Resources.Load<Shader>("Shaders/Shockwave")) { name = "SE Shock front" }; }
            for (int i = 0; i < distortionCount; i++)
            {
                var w = distortions[i];
                float t = w.Age / w.Duration;
                float r = w.Radius * (1 - math.pow(1 - t, 2.2f)) + .05f;      // fast out, decelerating
                float strength = w.Strength * .055f * (1 - t) * math.saturate(t * 12);
                var bounds = new Bounds(w.Point, Vector3.one * (r * 2 + 1));
                int n = images.For(bounds, out float a, out float b, out float c);
                for (int k = 0; k < n; k++)
                {
                    float shift = k == 0 ? a : k == 1 ? b : c;
                    distortionBlock.SetFloat(StrengthId, strength);
                    distortionBlock.SetFloat(FrontId, .25f * (1 - t));
                    distortionBlock.SetVector(ImageOffsetId, new Vector4(shift, 0, 0, 0));
                    var m = Matrix4x4.TRS(w.Point, Quaternion.identity, new Vector3(r, r * .55f, r));
                    Graphics.RenderMesh(new RenderParams(distortionMaterial) { matProps = distortionBlock, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false,
                        worldBounds = new Bounds(bounds.center + new Vector3(shift, 0, 0), bounds.size) }, dome, 0, m);
                }
            }
        }

        static Mesh BuildDome(int segments, int rings)
        {
            var v = new List<Vector3>(); var nrm = new List<Vector3>(); var idx = new List<int>();
            for (int r = 0; r <= rings; r++)
            {
                float phi = r / (float)rings * math.PI * .5f;
                for (int s = 0; s <= segments; s++)
                {
                    float theta = s / (float)segments * math.PI * 2;
                    var p = new Vector3(math.cos(theta) * math.cos(phi), math.sin(phi), math.sin(theta) * math.cos(phi));
                    v.Add(p); nrm.Add(p);
                }
            }
            for (int r = 0; r < rings; r++)
                for (int s = 0; s < segments; s++)
                {
                    int a = r * (segments + 1) + s, b = a + segments + 1;
                    idx.Add(a); idx.Add(b); idx.Add(a + 1);
                    idx.Add(a + 1); idx.Add(b); idx.Add(b + 1);
                }
            var mesh = new Mesh { name = "Shock front dome" };
            mesh.SetVertices(v); mesh.SetNormals(nrm); mesh.SetTriangles(idx, 0);
            return mesh;
        }

        void DisposeDistortions()
        {
            if (dome != null) Object.Destroy(dome);
            if (distortionMaterial != null) Object.Destroy(distortionMaterial);
        }
    }
}
