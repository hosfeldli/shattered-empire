using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;

namespace SE.Core.Stress
{
    /// <summary>
    /// A deterministic, server-shaped world for the M2 performance proof: a wrapped 256×256 map with
    /// ridged mountain ranges, valleys, rivers that end in lakes or the sea, forests and coastlines.
    /// The output is a full 'geo' message in the server's wire layout (terrainGeo.js), so the stress
    /// scene exercises the same decode and apply path as a live match.
    /// </summary>
    public static class StressWorld
    {
        public const byte Deep = 0, Shallow = 1, Grass = 2, Plains = 3, Forest = 4, Desert = 5, Tundra = 6, Marsh = 7, Hills = 8, Mountain = 9, Peak = 10;

        static float Hash(int x, int y, int seed)
        {
            unchecked
            {
                uint h = (uint)(x * 374761393 + y * 668265263 + seed * 982451653);
                h = (h ^ (h >> 13)) * 1274126177u;
                h ^= h >> 16;
                return (h & 0xffffff) / 16777216f;
            }
        }

        static float Smooth(float t) => t * t * (3f - 2f * t);

        /// <summary>Value noise, periodic in x with the given lattice period.</summary>
        static float Value(float x, float y, int period, int seed)
        {
            int x0 = (int)Math.Floor(x), y0 = (int)Math.Floor(y);
            float fx = Smooth(x - x0), fy = Smooth(y - y0);
            int xa = HexMath.PosMod(x0, period), xb = HexMath.PosMod(x0 + 1, period);
            float a = Hash(xa, y0, seed), b = Hash(xb, y0, seed), c = Hash(xa, y0 + 1, seed), d = Hash(xb, y0 + 1, seed);
            return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
        }

        static float Fbm(float x, float y, int period, int octaves, int seed)
        {
            float sum = 0, amp = 0.5f, norm = 0;
            for (int o = 0; o < octaves; o++)
            {
                sum += amp * Value(x, y, period, seed + o * 101);
                norm += amp;
                amp *= 0.5f; x *= 2; y *= 2; period *= 2;
            }
            return sum / norm;
        }

        static float Ridged(float x, float y, int period, int octaves, int seed)
        {
            float sum = 0, amp = 0.5f, norm = 0, weight = 1;
            for (int o = 0; o < octaves; o++)
            {
                float v = 1f - Math.Abs(2f * Value(x, y, period, seed + o * 131) - 1f);
                v *= v * weight;
                weight = Math.Min(1f, v * 2f);
                sum += amp * v;
                norm += amp;
                amp *= 0.5f; x *= 2; y *= 2; period *= 2;
            }
            return sum / norm;
        }

        public sealed class Result
        {
            public GeoMessage Geo;
            public float[] Elevation;
            public byte[] Biome;
            public int Size;
        }

        public static Result Generate(int size, int seed)
        {
            int w = size, h = size, n = w * h;
            var elev = new float[n];
            var moist = new float[n];
            var biome = new byte[n];
            const int P = 6;                          // continent lattice period across the whole wrap
            float scale = (float)P / w;
            for (int r = 0; r < h; r++)
                for (int q = 0; q < w; q++)
                {
                    int i = r * w + q;
                    float x = (q + 0.5f * (r & 1)) * scale, y = r * 0.866f * scale;
                    // domain warp gives ranges and coasts natural, non-grid shapes
                    float wx = x + (Fbm(x + 3.1f, y, P, 3, seed + 7) - 0.5f) * 0.9f;
                    float wy = y + (Fbm(x, y + 5.7f, P, 3, seed + 11) - 0.5f) * 0.9f;
                    float continent = Fbm(wx, wy, P, 5, seed);
                    float lat = Math.Abs(r / (float)(h - 1) * 2f - 1f);
                    float land = continent * 1.55f - 0.62f - lat * lat * 0.25f;
                    float ranges = Ridged(wx * 1.6f + 9f, wy * 1.6f, P * 2, 5, seed + 23);
                    float massif = Math.Max(0f, land) * 2.2f;
                    float e = land + (float)Math.Pow(ranges, 2.2) * Math.Min(1f, massif) * 0.95f;
                    elev[i] = Math.Max(-1f, Math.Min(1f, e));
                    moist[i] = Fbm(x * 2f + 40f, y * 2f, P * 2, 4, seed + 41);
                }
            // rivers: run downhill from wet highlands; end in the sea, another river, or a lake basin
            var river = new bool[n];
            var lake = new bool[n];
            var flowDir = new int[n];
            var flow = new int[n];
            for (int i = 0; i < n; i++) flowDir[i] = -1;
            var grid = new HexGrid(w, h, true);
            for (int i = 0; i < n; i++)
            {
                if (elev[i] < 0.42f || elev[i] > 0.8f || Hash(i, 3, seed) > 0.02f + moist[i] * 0.03f) continue;
                int t = i, steps = 0;
                var path = new List<int>();
                while (steps++ < 400)
                {
                    path.Add(t);
                    if (elev[t] < 0f) break;
                    if (river[t] && t != i) break;
                    int best = -1; float bestE = elev[t];
                    for (int d = 0; d < 6; d++)
                    {
                        int nb = grid.Nb[t * 6 + d];
                        if (nb >= 0 && elev[nb] < bestE) { bestE = elev[nb]; best = d; }
                    }
                    if (best < 0)
                    {
                        // a basin: a lake fills it (rivers never just stop)
                        lake[t] = true;
                        for (int d = 0; d < 6; d++) { int nb = grid.Nb[t * 6 + d]; if (nb >= 0 && elev[nb] < elev[t] + 0.04f && elev[nb] >= 0f) lake[nb] = true; }
                        break;
                    }
                    flowDir[t] = best;
                    t = grid.Nb[t * 6 + best];
                }
                if (path.Count < 6) continue;
                for (int k = 0; k < path.Count; k++)
                {
                    int p = path[k];
                    if (elev[p] < 0f || lake[p]) break;
                    river[p] = true;
                    flow[p] += k + 1;
                }
            }
            for (int i = 0; i < n; i++)
            {
                float e = elev[i], m = moist[i];
                float lat = Math.Abs((i / w) / (float)(h - 1) * 2f - 1f);
                byte b;
                if (lake[i]) b = Shallow;   // as on the server: lakes are shallow water flagged as lake
                else if (e < -0.22f) b = Deep;
                else if (e < 0f) b = Shallow;
                else if (e > 0.78f) b = Peak;
                else if (e > 0.58f) b = Mountain;
                else if (e > 0.4f) b = Hills;
                else if (lat > 0.82f) b = Tundra;
                else if (m < 0.33f && lat < 0.5f) b = Desert;
                else if (m > 0.68f && e < 0.08f) b = Marsh;
                else if (m > 0.52f) b = Forest;
                else b = m > 0.42f ? Grass : Plains;
                biome[i] = b;
            }
            // pack into the server's 'geo' wire layout
            const int cs = 16, stride = 6;
            int cw = (w + cs - 1) / cs, ch = (h + cs - 1) / cs;
            var msg = new GeoMessage { Full = true, ChunkSize = cs, Stride = stride, W = w, H = h };
            for (int cy = 0; cy < ch; cy++)
                for (int cx = 0; cx < cw; cx++)
                {
                    var mask = new byte[cs * cs / 8];
                    var data = new List<byte>(cs * cs * stride);
                    for (int cell = 0; cell < cs * cs; cell++)
                    {
                        int q = cx * cs + cell % cs, r = cy * cs + cell / cs;
                        if (q >= w || r >= h) continue;
                        int i = r * w + q;
                        mask[cell >> 3] |= (byte)(1 << (cell & 7));
                        float e = elev[i];
                        int fb = river[i] ? Math.Min(4, (int)Math.Floor(Math.Log(Math.Max(1, flow[i] / 6.0), 2)) + 1) : 0;
                        bool water = biome[i] <= 1;
                        data.Add(ClampByte((e + 1f) * 127.5f));
                        data.Add(biome[i]);
                        data.Add(water ? (lake[i] ? (byte)24 : (byte)Math.Max(1, (int)ClampByte(-e * 400f))) : lake[i] ? (byte)24 : (byte)(fb * 8));
                        data.Add((byte)((river[i] ? 1 : 0) | (lake[i] ? 2 : 0)));
                        data.Add((byte)(fb << 4));
                        data.Add((byte)(river[i] && flowDir[i] >= 0 ? flowDir[i] + 1 : 0));
                    }
                    msg.Chunks.Add(new GeoChunk { Cx = cx, Cy = cy, Mask = mask, Data = data.ToArray() });
                }
            return new Result { Geo = msg, Elevation = elev, Biome = biome, Size = size };
        }

        static byte ClampByte(float v) => v < 0 ? (byte)0 : v > 255 ? (byte)255 : (byte)Math.Round(v);
    }
}
