using System;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    public sealed partial class EffectsRenderer
    {
        struct GroundWave { public float3 Point; public float Age, Duration, Radius, Seed; }
        const int WaveLimit = 20, WaveSegments = 48;
        readonly GroundWave[] groundWaves = new GroundWave[WaveLimit];
        readonly Vector3[] waveVertices = new Vector3[WaveLimit * WaveSegments * 4];
        readonly Color[] waveColors = new Color[WaveLimit * WaveSegments * 4];
        readonly Vector2[] waveUV = new Vector2[WaveLimit * WaveSegments * 4];
        readonly int[] waveIndices = new int[WaveLimit * WaveSegments * 6];
        readonly MaterialPropertyBlock waveBlock = new MaterialPropertyBlock();
        Mesh waveMesh;
        Material waveMaterial;
        int waveCount, waveVertexCount;
        public Func<float, float, float> GroundAt;

        void GroundShock(float3 point, float radius, float duration)
        {
            if (Intensity < .25f || waveCount >= WaveLimit) return;
            groundWaves[waveCount++] = new GroundWave { Point = point, Radius = radius, Duration = duration, Seed = R() * 17f };
        }

        void UpdateGroundWaves(float dt)
        {
            waveVertexCount = 0;
            if (waveCount == 0) return;
            if (waveMesh == null)
            {
                waveMesh = new Mesh { name = "Pooled terrain-following blast fronts" }; waveMesh.MarkDynamic();
                waveMaterial = new Material(Resources.Load<Shader>("Shaders/GroundWave"));
                for (int k = 0; k < waveIndices.Length / 6; k++)
                {
                    int i = k * 4, t = k * 6;
                    waveIndices[t] = i; waveIndices[t + 1] = i + 1; waveIndices[t + 2] = i + 2;
                    waveIndices[t + 3] = i; waveIndices[t + 4] = i + 2; waveIndices[t + 5] = i + 3;
                    waveUV[i] = new Vector2(0, 0); waveUV[i + 1] = new Vector2(1, 0);
                    waveUV[i + 2] = new Vector2(1, 1); waveUV[i + 3] = new Vector2(0, 1);
                }
            }
            for (int k = 0; k < waveCount; k++)
            {
                var wave = groundWaves[k]; wave.Age += dt;
                if (wave.Age >= wave.Duration) { groundWaves[k--] = groundWaves[--waveCount]; continue; }
                groundWaves[k] = wave;
                float t = wave.Age / wave.Duration;
                float radius = wave.Radius * math.sqrt(t), width = .025f + wave.Radius * .055f * (1 - t * .45f);
                float opacity = (1 - t) * math.saturate(t * 14) * .29f * Intensity;
                float3 Point(float a, float offset)
                {
                    float variation = 1 + math.sin(a * 3 + wave.Seed) * .026f + math.cos(a * 7 - wave.Seed) * .018f;
                    float x = wave.Point.x + math.cos(a) * (radius * variation + offset);
                    float z = wave.Point.z + math.sin(a) * (radius * variation + offset);
                    return MapSpace.W(new float3(x, (GroundAt != null ? GroundAt(x, z) : wave.Point.y) + .008f + t * .012f, z));
                }
                for (int s = 0; s < WaveSegments; s++)
                {
                    float a = s * math.PI * 2 / WaveSegments, b = (s + 1) * math.PI * 2 / WaveSegments;
                    int v = waveVertexCount;
                    waveVertices[v] = Point(a, -width); waveVertices[v + 1] = Point(b, -width);
                    waveVertices[v + 2] = Point(b, width); waveVertices[v + 3] = Point(a, width);
                    for (int j = 0; j < 4; j++) waveColors[v + j] = new Color(.58f, .54f, .46f, opacity);
                    waveVertexCount += 4;
                }
            }
            if (waveVertexCount == 0) return;
            waveMesh.Clear(false);
            waveMesh.SetVertices(waveVertices, 0, waveVertexCount); waveMesh.SetColors(waveColors, 0, waveVertexCount);
            waveMesh.SetUVs(0, waveUV, 0, waveVertexCount); waveMesh.SetIndices(waveIndices, 0, waveVertexCount / 4 * 6, MeshTopology.Triangles, 0, true);
        }

        void DrawGroundWaves(WrapImages images)
        {
            if (waveVertexCount == 0 || waveMesh == null) return;
            int n = images.For(waveMesh.bounds, out float a, out float b, out float c);
            void Draw(float shift)
            {
                waveBlock.SetVector(ImageOffsetId, new Vector4(shift, 0, 0, 0));
                var bounds = waveMesh.bounds; bounds.center += new Vector3(shift, 0, 0);
                Graphics.RenderMeshPrimitives(new RenderParams(waveMaterial) { worldBounds = bounds, matProps = waveBlock,
                    shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, waveMesh, 0, 1);
            }
            if (n > 0) Draw(a); if (n > 1) Draw(b); if (n > 2) Draw(c);
        }

        float warningBeaconAt;
        public void WarningBeacon(float3 point, float pulse)
        {
            // A dim lens, not an additive flare. Rate limiting prevents brightness
            // from stacking with render frame rate, and it never changes scene exposure.
            if (Time.unscaledTime < warningBeaconAt) return;
            warningBeaconAt = Time.unscaledTime + .12f;
            Emit(point, float3.zero, .008f, 0, .12f, new float3(.58f, .035f, .014f),
                new float3(.28f, .008f, .004f), Mathf.Clamp01(pulse) * .32f, false);
        }
    }
}
