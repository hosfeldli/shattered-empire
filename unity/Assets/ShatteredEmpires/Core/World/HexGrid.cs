using System;

namespace SE.Core.World
{
    /// <summary>
    /// Pure hex arithmetic shared by managed code and Burst jobs (no allocations, no managed state).
    /// Odd-r offset grid, pointy-top hexes, odd rows shoved east: the server's layout
    /// (server/sim/hex.js). One world unit is one hex radius; X runs east, Z runs south, Y is up.
    /// The world is a cylinder: every x has images x + k * period.
    /// </summary>
    public static class HexMath
    {
        public const float Sqrt3 = 1.7320508075688772f;

        // neighbour directions: 0 E, 1 NE, 2 NW, 3 W, 4 SW, 5 SE (pairs of dq, dr)
        public static readonly int[] DirsEven = { 1, 0, 0, -1, -1, -1, -1, 0, -1, 1, 0, 1 };
        public static readonly int[] DirsOdd = { 1, 0, 1, -1, 0, -1, -1, 0, 0, 1, 1, 1 };
        // the two neighbour directions that share corner k (corner k sits at angle -90 + 60k degrees)
        public static readonly int[] CornerDirs = { 1, 2, 0, 1, 0, 5, 5, 4, 4, 3, 3, 2 };
        public static readonly float[] CornerX =
        {
            0f, 0.8660254037844387f, 0.8660254037844387f, 0f, -0.8660254037844387f, -0.8660254037844387f,
        };
        public static readonly float[] CornerZ = { -1f, -0.5f, 0.5f, 1f, 0.5f, -0.5f };
        // unit vectors toward each neighbour (angle -60 * d degrees)
        public static readonly float[] DirX = { 1f, 0.5f, -0.5f, -1f, -0.5f, 0.5f };
        public static readonly float[] DirZ = { 0f, -0.8660254037844387f, -0.8660254037844387f, 0f, 0.8660254037844387f, 0.8660254037844387f };

        /// <summary>Round half away from zero (GDScript roundf), written with Floor so Burst can compile it.</summary>
        public static float RoundAway(float v) => v >= 0f ? (float)Math.Floor(v + 0.5f) : -(float)Math.Floor(-v + 0.5f);

        public static int PosMod(int a, int m)
        {
            int r = a % m;
            return r < 0 ? r + m : r;
        }

        public static float FPosMod(float a, float m)
        {
            float r = a - m * (float)Math.Floor(a / m);
            return r >= m ? r - m : r;
        }

        public static float CenterX(int i, int w)
        {
            int q = i % w, r = i / w;
            return Sqrt3 * (q + 0.5f * (r & 1));
        }

        public static float CenterZ(int i, int w) => 1.5f * (i / w);

        /// <summary>Signed shortest east-west difference b - a.</summary>
        public static float DxWrap(float a, float b, float period, bool wrap)
        {
            float d = b - a;
            if (wrap) d -= period * RoundAway(d / period);
            return d;
        }

        /// <summary>x moved by whole periods to the image nearest reference.</summary>
        public static float NearX(float x, float reference, float period, bool wrap)
        {
            if (!wrap) return x;
            return x + period * RoundAway((reference - x) / period);
        }

        /// <summary>The hex containing (x, z) in any image, or -1 beyond the north / south edge.</summary>
        public static int TileAt(float x, float z, int w, int h, bool wrap)
        {
            float cx = Sqrt3 / 3f * x - z / 3f;
            float cz = 2f / 3f * z;
            float cy = -cx - cz;
            float rx = RoundAway(cx);
            float ry = RoundAway(cy);
            float rz = RoundAway(cz);
            float dx = Math.Abs(rx - cx), dy = Math.Abs(ry - cy), dz = Math.Abs(rz - cz);
            if (dx > dy && dx > dz) rx = -ry - rz;
            else if (dy > dz) ry = -rx - rz;
            else rz = -rx - ry;
            int r = (int)rz;
            if (r < 0 || r >= h) return -1;
            int q = (int)rx + ((r - (r & 1)) >> 1);
            if (wrap) q = PosMod(q, w);
            else if (q < 0 || q >= w) return -1;
            return r * w + q;
        }

        static int Cube(int dx, int dy) => Math.Max(Math.Abs(dx), Math.Max(Math.Abs(dy), Math.Abs(-dx - dy)));

        /// <summary>Hex distance (cube metric, shortest image), identical to server/sim/hex.js dist.</summary>
        public static int Dist(int a, int b, int w, bool wrap)
        {
            int ar = a / w, br = b / w;
            int ax = (a % w) - ((ar - (ar & 1)) >> 1);
            int bx = (b % w) - ((br - (br & 1)) >> 1);
            int best = Cube(ax - bx, ar - br);
            if (wrap)
            {
                best = Math.Min(best, Cube(ax - bx - w, ar - br));
                best = Math.Min(best, Cube(ax - bx + w, ar - br));
            }
            return best;
        }
    }

    /// <summary>A sized grid: neighbour table, period and depth. One per match.</summary>
    public sealed class HexGrid
    {
        public readonly int W, H, N;
        public readonly bool Wrap;
        public readonly float Period, Depth;
        /// <summary>Nb[i * 6 + d] = neighbour index or -1.</summary>
        public readonly int[] Nb;

        public HexGrid(int width, int height, bool wraps)
        {
            W = width; H = height; N = W * H; Wrap = wraps;
            Period = HexMath.Sqrt3 * W;
            Depth = 1.5f * H;
            Nb = new int[N * 6];
            for (int r = 0; r < H; r++)
            {
                int[] dirs = (r & 1) == 1 ? HexMath.DirsOdd : HexMath.DirsEven;
                for (int q = 0; q < W; q++)
                {
                    int i = r * W + q;
                    for (int d = 0; d < 6; d++)
                    {
                        int nq = q + dirs[d * 2], nr = r + dirs[d * 2 + 1];
                        int v = -1;
                        if (nr >= 0 && nr < H)
                        {
                            if (Wrap) v = nr * W + HexMath.PosMod(nq, W);
                            else if (nq >= 0 && nq < W) v = nr * W + nq;
                        }
                        Nb[i * 6 + d] = v;
                    }
                }
            }
        }

        public int Q(int i) => i % W;
        public int R(int i) => i / W;
        public float CenterX(int i) => HexMath.CenterX(i, W);
        public float CenterZ(int i) => HexMath.CenterZ(i, W);
        public int Neighbor(int i, int d) => Nb[i * 6 + d];
        public int TileAt(float x, float z) => HexMath.TileAt(x, z, W, H, Wrap);
        public float NearX(float x, float reference) => HexMath.NearX(x, reference, Period, Wrap);
        public float BaseX(float x) => Wrap ? HexMath.FPosMod(x, Period) : x;
        public float DxWrap(float a, float b) => HexMath.DxWrap(a, b, Period, Wrap);
        public int Dist(int a, int b) => HexMath.Dist(a, b, W, Wrap);
    }
}
