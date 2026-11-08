using System;

namespace SE.Core.World
{
    /// <summary>
    /// The one terrain-height function of the client: an exact port of WorldState.gd's sector
    /// triangulation. Terrain meshes, roads, buildings, units, rivers and craters all sample this, so
    /// nothing floats above or sinks into the drawn ground.
    ///
    /// Blittable view over pinned world arrays, usable from managed code and Burst jobs alike. The
    /// arrays belong to <see cref="WorldModel"/>; jobs holding a view must finish before the model
    /// applies new geometry.
    ///
    /// Each hex sector (centre C toward corners k and k+1) is subdivided: the shared edge midpoint M
    /// carries the mean of the two hexes meeting there (adjacent mountains form one ridge), and an
    /// inner ring (a, m, b) bulges hills and peaks into rounded mass. Points are (u, v) toward corners
    /// A (k) and B (k+1): C, A, B, M, a, b, m.
    /// </summary>
    public unsafe struct TerrainView
    {
        public int W, H;
        public int Wrap;          // 1 when the world wraps east-west
        public float Period;
        public float* Height;     // per hex, world units
        public float* Water;      // per hex: sea 0, lake surface, or NoWater on land
        public byte* Known;       // 1 when the hex geometry has been received
        public byte* GeoFlags;    // geo byte 3: river | lake<<1 | soil<<2 | ruin<<3 | ...
        public byte* Biome;       // geo byte 1
        public int* Nb;           // neighbour table, 6 per hex

        public const float NoWater = -1e9f;
        public const float LakeDepth = 0.14f;

        // SECTOR_UV and SECTOR_TRIS from WorldState.gd
        public static readonly float[] SectorU = { 0f, 1f, 0f, 0.5f, 0.5f, 0f, 0.25f };
        public static readonly float[] SectorV = { 0f, 0f, 1f, 0.5f, 0f, 0.5f, 0.25f };
        public static readonly int[] SectorTris = { 0, 4, 6, 0, 6, 5, 4, 1, 3, 4, 3, 6, 5, 3, 2, 5, 6, 3 };

        public bool IsValid => Height != null;
        public bool IsLake(int i) => (GeoFlags[i] & 2) != 0;
        public bool IsRiver(int i) => (GeoFlags[i] & 1) != 0;
        public bool IsSea(int i) => Biome[i] <= 1 && (GeoFlags[i] & 2) == 0;
        public bool IsKnown(int i) => i >= 0 && Known[i] != 0;

        public float TileHeight(int i) => i >= 0 && Known[i] != 0 ? Height[i] : 0f;

        /// <summary>Height at corner k of hex i: the mean of the known hexes that share it.</summary>
        public float CornerHeight(int i, int k)
        {
            float s = Height[i];
            int c = 1;
            int lakeCount = IsLake(i) ? 1 : 0;
            int lakeTile = lakeCount == 1 ? i : -1;
            for (int j = 0; j < 2; j++)
            {
                int d = HexMath.CornerDirs[k * 2 + j];
                int nb = Nb[i * 6 + d];
                if (nb >= 0 && Known[nb] != 0)
                {
                    s += Height[nb];
                    c++;
                    if (IsLake(nb)) { lakeCount++; lakeTile = nb; }
                }
            }
            float result = s / c;
            // a land sample on the bank must not lift an internal lake edge through the surface
            if (lakeCount >= 2) result = Math.Min(result, Water[lakeTile] - 0.035f);
            return result;
        }

        /// <summary>Height at the midpoint of the edge between corners k and k+1.</summary>
        public float EdgeHeight(int i, int k)
        {
            int nb = Nb[i * 6 + HexMath.PosMod(1 - k, 6)];
            if (nb < 0 || Known[nb] == 0) return Height[i];
            float result = (Height[i] + Height[nb]) * 0.5f;
            if (IsLake(i) && IsLake(nb)) result = Math.Min(result, Water[i] - 0.035f);
            return result;
        }

        float Inner(int i, float c, float x)
        {
            if (c <= x || IsSea(i) || IsLake(i) || IsRiver(i)) return (c + x) * 0.5f;
            return x + (c - x) * 0.68f;
        }

        /// <summary>The seven sector heights in SECTOR_UV order, written to out7.</summary>
        public void SectorHeights(int i, int k, float* out7)
        {
            float c = Height[i];
            float a = CornerHeight(i, k);
            float b = CornerHeight(i, (k + 1) % 6);
            float m = EdgeHeight(i, k);
            out7[0] = c; out7[1] = a; out7[2] = b; out7[3] = m;
            out7[4] = Inner(i, c, a); out7[5] = Inner(i, c, b); out7[6] = Inner(i, c, m);
        }

        /// <summary>Interpolated height inside sector k at (u, v), given that sector's heights.</summary>
        public static float SectorPoint(float* h7, float u, float v)
        {
            int tri;
            if (u + v <= 0.5f) tri = u >= v ? 0 : 1;
            else if (u >= v) tri = u >= 0.5f ? 2 : 3;
            else tri = v >= 0.5f ? 4 : 5;
            int i0 = SectorTris[tri * 3], i1 = SectorTris[tri * 3 + 1], i2 = SectorTris[tri * 3 + 2];
            float p0u = SectorU[i0], p0v = SectorV[i0];
            float e1u = SectorU[i1] - p0u, e1v = SectorV[i1] - p0v;
            float e2u = SectorU[i2] - p0u, e2v = SectorV[i2] - p0v;
            float qu = u - p0u, qv = v - p0v;
            float d = e1u * e2v - e1v * e2u;
            if (Math.Abs(d) < 1e-9f) return h7[i0];
            float s = (qu * e2v - qv * e2u) / d;
            float r = (e1u * qv - e1v * qu) / d;
            return h7[i0] * (1f - s - r) + h7[i1] * s + h7[i2] * r;
        }

        /// <summary>Sector index and (u, v) of a local offset from a hex centre.</summary>
        public static void LocateSector(float dx, float dz, out int k, out float u, out float v)
        {
            double angle = Math.Atan2(dz, dx) * (180.0 / Math.PI);
            k = HexMath.PosMod((int)Math.Floor((angle + 90.0) / 60.0), 6);
            int k2 = (k + 1) % 6;
            float ax = HexMath.CornerX[k], az = HexMath.CornerZ[k];
            float bx = HexMath.CornerX[k2], bz = HexMath.CornerZ[k2];
            float det = ax * bz - az * bx;
            u = (dx * bz - dz * bx) / det;
            v = (ax * dz - az * dx) / det;
        }

        /// <summary>Ground height under (x, z) in any image.</summary>
        public float GroundHeight(float x, float z)
        {
            int t = HexMath.TileAt(x, z, W, H, Wrap != 0);
            if (t < 0 || Known[t] == 0) return 0f;
            float dx = HexMath.DxWrap(HexMath.CenterX(t, W), x, Period, Wrap != 0);
            float dz = z - HexMath.CenterZ(t, W);
            LocateSector(dx, dz, out int k, out float u, out float v);
            float* h7 = stackalloc float[7];
            SectorHeights(t, k, h7);
            return SectorPoint(h7, u, v);
        }

        /// <summary>Surface of standing water under (x, z), or NoWater on dry land.</summary>
        public float WaterLevel(float x, float z)
        {
            int t = HexMath.TileAt(x, z, W, H, Wrap != 0);
            if (t < 0 || Known[t] == 0) return NoWater;
            return Water[t];
        }
    }
}
