using System;
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Landscape
{
    /// <summary>
    /// Tileable noise for the terrain shader's ground detail (Terrain.shader), generated once at start by a Burst job
    /// (a few milliseconds). Two 256x256 linear textures with full mip chains, so every layer fades to its mean with
    /// distance instead of shimmering:
    ///   noise  r macro fbm (soft colour drift), g clump height, b patch field (worn ground, domain-warped so the
    ///          shapes are organic), a unused; read once at the macro scale
    ///   detail r clump height (tussocks, hummocks, grain: the same field read at three scales), g patch field, ba the
    ///          signed gradient of the clump height (.5 = flat), so one filtered read gives both the pattern and the
    ///          bumps the light catches, with no screen-space derivatives to shimmer
    /// </summary>
    public static class GroundNoise
    {
        const int Size = 256;

        public static void Build(out Texture2D noise, out Texture2D detail)
        {
            int n = Size * Size;
            var fields = new NativeArray<float4>(n, Allocator.TempJob);
            new FieldJob { Out = fields }.Schedule(n, 256).Complete();
            var r = new float[n]; var g = new float[n]; var b = new float[n];
            for (int i = 0; i < n; i++) { var f = fields[i]; r[i] = f.x; g[i] = f.y; b[i] = f.z; }
            fields.Dispose();
            Normalize(r); Normalize(g); Normalize(b);

            var gx = new float[n]; var gy = new float[n];
            for (int y = 0; y < Size; y++)
                for (int x = 0; x < Size; x++)
                {
                    int i = y * Size + x;
                    int xl = y * Size + (x + Size - 1) % Size, xr = y * Size + (x + 1) % Size;
                    int yd = ((y + Size - 1) % Size) * Size + x, yu = ((y + 1) % Size) * Size + x;
                    gx[i] = (g[xr] - g[xl]) * .5f; gy[i] = (g[yu] - g[yd]) * .5f;
                }
            float gMax = Percentile(gx, gy);

            var np = new Color32[n]; var dp = new Color32[n];
            for (int i = 0; i < n; i++)
            {
                np[i] = new Color32(B(r[i]), B(g[i]), B(b[i]), 128);
                dp[i] = new Color32(B(g[i]), B(b[i]), B(gx[i] / gMax * .5f + .5f), B(gy[i] / gMax * .5f + .5f));
            }
            noise = Make("SE ground noise", np);
            detail = Make("SE ground detail", dp);
        }

        [BurstCompile(FloatMode = FloatMode.Fast)]
        struct FieldJob : IJobParallelFor
        {
            [WriteOnly] public NativeArray<float4> Out;

            public void Execute(int i)
            {
                float u = (i % Size) / (float)Size, v = (i / Size) / (float)Size;
                float macro = Fbm(u, v, 4, 5, 11);
                // clumps: a slightly warped fbm with a faint cellular lift, so tufts vary in size and run together
                // (a strong cellular term reads as regular bubbles once lit)
                float qu = Fbm(u, v, 8, 2, 71) - .5f, qv = Fbm(u + .29f, v + .53f, 8, 2, 73) - .5f;
                float clump = Fbm(math.frac(u + qu * .06f), math.frac(v + qv * .06f), 16, 4, 17) * .85f
                    + (1f - math.smoothstep(0f, .85f, Worley(u, v, 40, 31))) * .15f;
                // patches: domain-warped fbm (no blobs on a grid)
                float wu = Fbm(u, v, 3, 3, 43) - .5f, wv = Fbm(u + .37f, v + .61f, 3, 3, 47) - .5f;
                float patch = Fbm(math.frac(u + wu * .22f), math.frac(v + wv * .22f), 6, 4, 23);
                Out[i] = new float4(macro, clump, patch, 0f);
            }
        }

        static Texture2D Make(string name, Color32[] px)
        {
            var tex = new Texture2D(Size, Size, TextureFormat.RGBA32, true, true)
            {
                name = name, wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Trilinear, anisoLevel = 4,
            };
            tex.SetPixels32(px);
            tex.Apply(true, true);
            return tex;
        }

        static byte B(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(v * 255f), 0, 255);

        // auto-levels: stretch the 1st..99th percentile to 0..1
        static void Normalize(float[] f)
        {
            float lo = Quantile(f, .01f, false), hi = Quantile(f, .99f, false);
            float k = 1f / Mathf.Max(1e-4f, hi - lo);
            for (int i = 0; i < f.Length; i++) f[i] = Mathf.Clamp01((f[i] - lo) * k);
        }

        // the 99.5th percentile of |gradient component|, so the signed encoding uses its range without clipping much
        static float Percentile(float[] x, float[] y) => Mathf.Max(1e-4f, Mathf.Max(Quantile(x, .995f, true), Quantile(y, .995f, true)));

        // a quantile from a 4096-bin histogram (no sort): exact enough for levels
        static float Quantile(float[] f, float q, bool absolute)
        {
            float min = float.MaxValue, max = float.MinValue;
            for (int i = 0; i < f.Length; i++) { float v = absolute ? Math.Abs(f[i]) : f[i]; if (v < min) min = v; if (v > max) max = v; }
            if (max - min < 1e-9f) return max;
            const int Bins = 4096;
            var hist = new int[Bins];
            float scale = (Bins - 1) / (max - min);
            for (int i = 0; i < f.Length; i++) hist[(int)(((absolute ? Math.Abs(f[i]) : f[i]) - min) * scale)]++;
            int target = (int)(f.Length * q), sum = 0;
            for (int b = 0; b < Bins; b++) { sum += hist[b]; if (sum > target) return min + (b + .5f) / scale; }
            return max;
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

        static int Wrap(int i, int period) => ((i % period) + period) % period;

        static float Grad(int ix, int iy, int period, int seed, float dx, float dy)
        {
            float ang = (H(Wrap(ix, period), Wrap(iy, period), seed) >> 8) * (6.2831853f / 16777216f);
            math.sincos(ang, out float s, out float c);
            return c * dx + s * dy;
        }

        // periodic gradient noise (tiles every `period` lattice cells)
        static float Perlin(float x, float y, int period, int seed)
        {
            int x0 = (int)math.floor(x), y0 = (int)math.floor(y);
            float fx = x - x0, fy = y - y0;
            float sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
            float n00 = Grad(x0, y0, period, seed, fx, fy), n10 = Grad(x0 + 1, y0, period, seed, fx - 1, fy);
            float n01 = Grad(x0, y0 + 1, period, seed, fx, fy - 1), n11 = Grad(x0 + 1, y0 + 1, period, seed, fx - 1, fy - 1);
            return math.lerp(math.lerp(n00, n10, sx), math.lerp(n01, n11, sx), sy) * 1.41f;
        }

        // periodic cellular noise: distance to the nearest feature point (cell units)
        static float Worley(float u, float v, int cells, int seed)
        {
            float x = u * cells, y = v * cells;
            int cx = (int)math.floor(x), cy = (int)math.floor(y);
            float best = 9f;
            for (int j = -1; j <= 1; j++)
                for (int i = -1; i <= 1; i++)
                {
                    int ix = cx + i, iy = cy + j;
                    uint h = H(Wrap(ix, cells), Wrap(iy, cells), seed);
                    float px = ix + .15f + (h & 0xffff) / 65535f * .7f, py = iy + .15f + (h >> 16) / 65535f * .7f;
                    best = math.min(best, (px - x) * (px - x) + (py - y) * (py - y));
                }
            return math.sqrt(best);
        }
    }
}
