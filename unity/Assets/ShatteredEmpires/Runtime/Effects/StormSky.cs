using System;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using SE.Runtime.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// The cloud deck (SE/StormSky): one quad at SE_SKY_Y around the camera focus, shaded per pixel from the
    /// regional weather texture and the storm systems (<see cref="StormSystems"/>), plus the tileable noise
    /// texture it and the ground shade (SECommon SE_StormShade) read. One draw call; no buffers; the noise texture
    /// is built once (256², RGBA: three fbm octaves sets and inverted cellular billows).
    /// Zoom: nothing below 28; fades in to a translucent deck at mid zoom with a hole where the camera looks at
    /// the battle; near-solid storm systems at strategic zoom. The Weather intensity setting scales it.
    /// </summary>
    public sealed class StormSky : IDisposable
    {
        public const float DeckY = 20f;   // SECommon SE_SKY_Y
        static readonly int NoiseId = Shader.PropertyToID("_SE_CloudNoiseTex");
        static readonly int Sky0 = Shader.PropertyToID("_Sky0"), Sky1 = Shader.PropertyToID("_Sky1"), Sky2 = Shader.PropertyToID("_Sky2"), Sky3 = Shader.PropertyToID("_Sky3");

        readonly Material material;
        readonly MaterialPropertyBlock block = new MaterialPropertyBlock();
        Texture2D noise;
        bool draw;

        public StormSky()
        {
            var shader = Resources.Load<Shader>("Shaders/StormSky");
            if (shader == null) return;
            material = new Material(shader) { name = "SE Storm Sky", renderQueue = (int)RenderQueue.Transparent + 22 };
            noise = BuildNoise();
            Shader.SetGlobalTexture(NoiseId, noise);
        }

        /// <param name="focusMap">camera focus (map coordinates)</param>
        /// <param name="eye">the camera's real position (Unity world)</param>
        public void Update(WeatherField field, StormSystems systems, float3 focusMap, Vector3 eye, float camDistance, bool wrap, float intensity)
        {
            draw = false;
            if (material == null || field == null || !field.Active) return;
            if (noise != null) Shader.SetGlobalTexture(NoiseId, noise);
            float zoom = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(28f, 70f, camDistance));
            float opacity = zoom * Mathf.Lerp(.55f, 1f, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(80f, 170f, camDistance))) * Mathf.Clamp01(intensity);
            if (opacity <= .004f) return;
            var fw = MapSpace.W(focusMap);
            // where the line of sight to the focus crosses the deck: a hole at mid zoom so the deck never covers the battle
            float t = eye.y - fw.y > 1f ? Mathf.Clamp01((DeckY - fw.y) / (eye.y - fw.y)) : 0f;
            var hole = new Vector2(fw.x + (eye.x - fw.x) * t, fw.z + (eye.z - fw.z) * t);
            float holeStrength = 1f - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(85f, 180f, camDistance));
            float half = Mathf.Min(camDistance * 2.6f + 90f, 1400f);
            // fair-weather cloud is a thinner veil than the storm systems, and thinner still up close
            float background = Mathf.Lerp(.55f, .85f, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(60f, 170f, camDistance)));
            block.SetVector(Sky0, new Vector4(fw.x, fw.z, half, DeckY));
            block.SetVector(Sky1, new Vector4(opacity, holeStrength, hole.x, hole.y));
            block.SetVector(Sky2, new Vector4(camDistance * .5f + 12f, background, field.Depth, wrap ? 1 : 0));
            block.SetVector(Sky3, new Vector4(field.Period, 0, 0, 0));
            draw = true;
        }

        public void Draw()
        {
            if (!draw || material == null) return;
            var rp = new RenderParams(material) { worldBounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), matProps = block, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            Graphics.RenderMesh(rp, MeshKit.Quad, 0, Matrix4x4.identity);
        }

        public void Dispose()
        {
            if (material != null) UnityEngine.Object.Destroy(material);
            if (noise != null) UnityEngine.Object.Destroy(noise);
        }

        // ------------------------------------------------------------------ the noise texture
        const int Size = 256;

        static Texture2D BuildNoise()
        {
            var r = new float[Size * Size]; var g = new float[Size * Size]; var b = new float[Size * Size]; var a = new float[Size * Size];
            for (int y = 0; y < Size; y++)
                for (int x = 0; x < Size; x++)
                {
                    float u = x / (float)Size, v = y / (float)Size;
                    int i = y * Size + x;
                    r[i] = Fbm(u, v, 4, 4, 11);
                    g[i] = Fbm(u, v, 8, 3, 23);
                    b[i] = 1f - Worley(u, v, 6, 37) * .8f - Worley(u, v, 12, 41) * .2f;
                    a[i] = Fbm(u, v, 16, 3, 53);
                }
            Normalize(r); Normalize(g); Normalize(b); Normalize(a);
            var px = new Color32[Size * Size];
            for (int i = 0; i < px.Length; i++) px[i] = new Color32(B(r[i]), B(g[i]), B(b[i]), B(a[i]));
            var tex = new Texture2D(Size, Size, TextureFormat.RGBA32, true, true)
            {
                name = "SE cloud noise", wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Trilinear, anisoLevel = 2,
            };
            tex.SetPixels32(px);
            tex.Apply(true, true);
            return tex;
        }

        static byte B(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(v * 255f), 0, 255);

        // auto-levels: stretch the 1st..99th percentile to 0..1, so every channel uses its full range
        static void Normalize(float[] f)
        {
            var s = (float[])f.Clone();
            Array.Sort(s);
            float lo = s[s.Length / 100], hi = s[s.Length - 1 - s.Length / 100];
            float k = 1f / Mathf.Max(1e-4f, hi - lo);
            for (int i = 0; i < f.Length; i++) f[i] = Mathf.Clamp01((f[i] - lo) * k);
        }

        static float Fbm(float u, float v, int freq, int octaves, int seed)
        {
            float sum = 0, amp = .5f, norm = 0;
            for (int o = 0; o < octaves; o++) { sum += amp * Perlin(u * freq, v * freq, freq, seed + o * 101); norm += amp; amp *= .5f; freq *= 2; }
            return sum / norm * .5f + .5f;
        }

        static uint H(int x, int y, int seed)
        {
            uint h = (uint)(x * 374761393 + y * 668265263 + seed * 1442695041);
            h = (h ^ (h >> 13)) * 1274126177u;
            return h ^ (h >> 16);
        }

        // periodic gradient noise (tiles every `period` lattice cells)
        static float Perlin(float x, float y, int period, int seed)
        {
            int x0 = Mathf.FloorToInt(x), y0 = Mathf.FloorToInt(y);
            float fx = x - x0, fy = y - y0;
            float Grad(int ix, int iy, float dx, float dy)
            {
                ix = ((ix % period) + period) % period; iy = ((iy % period) + period) % period;
                float ang = H(ix, iy, seed) * (6.2831853f / 4294967296f);
                return Mathf.Cos(ang) * dx + Mathf.Sin(ang) * dy;
            }
            float sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
            float n00 = Grad(x0, y0, fx, fy), n10 = Grad(x0 + 1, y0, fx - 1, fy), n01 = Grad(x0, y0 + 1, fx, fy - 1), n11 = Grad(x0 + 1, y0 + 1, fx - 1, fy - 1);
            return Mathf.Lerp(Mathf.Lerp(n00, n10, sx), Mathf.Lerp(n01, n11, sx), sy) * 1.41f;
        }

        // periodic cellular noise: distance to the nearest feature point (0..~1)
        static float Worley(float u, float v, int cells, int seed)
        {
            float x = u * cells, y = v * cells;
            int cx = Mathf.FloorToInt(x), cy = Mathf.FloorToInt(y);
            float best = 9f;
            for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++)
                {
                    int ix = cx + i, iy = cy + j;
                    int wx = ((ix % cells) + cells) % cells, wy = ((iy % cells) + cells) % cells;
                    uint h = H(wx, wy, seed);
                    float px = ix + (h & 0xffff) / 65535f, py = iy + (h >> 16) / 65535f;
                    float d = (px - x) * (px - x) + (py - y) * (py - y);
                    if (d < best) best = d;
                }
            return Mathf.Clamp01(Mathf.Sqrt(best));
        }
    }
}
