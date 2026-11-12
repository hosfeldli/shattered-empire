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
        public float* Impacts;    // six persistent [local x, local z, radius, depth] records per cell
        public byte* ImpactCounts;
        public float* Trenches;   // per cell: local x, local z, facing, depth

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

        /// <summary>The seven base sector heights in SECTOR_UV order, written to out7 (no relief detail).</summary>
        public void BaseSectorHeights(int i, int k, float* out7)
        {
            float c = Height[i];
            float a = CornerHeight(i, k);
            float b = CornerHeight(i, (k + 1) % 6);
            float m = EdgeHeight(i, k);
            out7[0] = c; out7[1] = a; out7[2] = b; out7[3] = m;
            out7[4] = Inner(i, c, a); out7[5] = Inner(i, c, b); out7[6] = Inner(i, c, m);
        }

        // ------------------------------------------------------------------ mountain relief
        // Presentation-only relief on hills and mountains: ridged noise (crests, gullies, spurs) so
        // ranges read as real landforms instead of smooth cones. It is part of the one height function:
        // the mesh, GroundHeight and everything placed on the ground use the same vertex heights, and
        // its amplitude is blended between hexes exactly like the heights, so seams stay closed.

        /// <summary>Relief amplitude of hex i (0 for water and lowland).</summary>
        public float Relief(int i)
        {
            if (Known[i] == 0 || IsSea(i) || IsLake(i) || IsRiver(i)) return 0f;
            switch (Biome[i])
            {
                case 10: return 0.75f;   // peaks
                case 9: return 0.48f;    // mountains
                case 8: return 0.14f;    // hills
                default: return 0f;
            }
        }

        float CornerRelief(int i, int k)
        {
            float s = Relief(i); int c = 1;
            for (int j = 0; j < 2; j++)
            {
                int nb = Nb[i * 6 + HexMath.CornerDirs[k * 2 + j]];
                if (nb >= 0 && Known[nb] != 0) { s += Relief(nb); c++; }
            }
            return s / c;
        }

        float EdgeRelief(int i, int k)
        {
            int nb = Nb[i * 6 + HexMath.PosMod(1 - k, 6)];
            if (nb < 0 || Known[nb] == 0) return Relief(i);
            return (Relief(i) + Relief(nb)) * 0.5f;
        }

        static float Hash(int x, int y)
        {
            uint h = (uint)(x * 374761393 + y * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xffffff) / 16777216f;
        }

        /// <summary>Value noise on a lattice periodic in x (so it wraps with the world).</summary>
        static float PeriodicNoise(float x, float z, int periodCells)
        {
            int x0 = (int)Math.Floor(x), z0 = (int)Math.Floor(z);
            float fx = x - x0, fz = z - z0;
            fx = fx * fx * (3f - 2f * fx); fz = fz * fz * (3f - 2f * fz);
            int xa = HexMath.PosMod(x0, periodCells), xb = HexMath.PosMod(x0 + 1, periodCells);
            float a = Hash(xa, z0), b = Hash(xb, z0), c = Hash(xa, z0 + 1), d = Hash(xb, z0 + 1);
            return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
        }

        /// <summary>Ridged multi-octave noise in [0, 1], periodic with the world in x.</summary>
        public float Ridge(float x, float z)
        {
            float sum = 0f, amp = 0.55f, weight = 1f;
            int cells = Math.Max(4, (int)Math.Round(Period * 0.9f));
            float scale = cells / Period;
            for (int o = 0; o < 3; o++)
            {
                float n = PeriodicNoise(x * scale, z * scale, cells);
                float r = 1f - Math.Abs(2f * n - 1f);
                r *= r * weight;
                weight = Math.Min(1f, r * 1.8f);
                sum += r * amp;
                amp *= 0.5f; scale *= 2f; cells *= 2;
            }
            return sum;
        }

        /// <summary>
        /// Optional cache of the ridge noise at every sector vertex (42 per hex: 6 sectors × 7), filled on
        /// first use by main-thread callers. The noise depends only on position, so it never goes stale
        /// within a world. Jobs pass useCache false and compute it directly (Burst is fast enough).
        /// </summary>
        public float* RidgeCache;
        public byte* RidgeFilled;

        float RidgeAt(int i, int k, int p)
        {
            float cx = HexMath.CenterX(i, W), cz = HexMath.CenterZ(i, W);
            int k2 = (k + 1) % 6;
            float u = SectorU[p], v = SectorV[p];
            // world position of the vertex, in the base image (noise is periodic, so images agree)
            float x = HexMath.FPosMod(cx + u * HexMath.CornerX[k] + v * HexMath.CornerX[k2], Period);
            float z = cz + u * HexMath.CornerZ[k] + v * HexMath.CornerZ[k2];
            return Ridge(x, z);
        }

        /// <summary>The seven sector vertex heights including relief, in SECTOR_UV order.</summary>
        public void SectorHeights(int i, int k, float* out7, bool useCache = false)
        {
            BaseSectorHeights(i, k, out7);
            float rc = Relief(i), ra = CornerRelief(i, k), rb = CornerRelief(i, (k + 1) % 6);
            if (rc <= 0f && ra <= 0f && rb <= 0f) return;
            float rm = EdgeRelief(i, k);
            bool cached = useCache && RidgeCache != null;
            if (cached && RidgeFilled[i] == 0)
            {
                for (int kk = 0; kk < 6; kk++) for (int pp = 0; pp < 7; pp++) RidgeCache[(i * 6 + kk) * 7 + pp] = RidgeAt(i, kk, pp);
                RidgeFilled[i] = 1;
            }
            for (int p = 0; p < 7; p++)
            {
                // relief at this point, blended like the heights (centre, corner means, edge means)
                float r = p == 0 ? rc : p == 1 ? ra : p == 2 ? rb : p == 3 ? rm : p == 4 ? (rc + ra) * 0.5f : p == 5 ? (rc + rb) * 0.5f : (rc + rm) * 0.5f;
                if (r <= 0f) continue;
                float ridge = cached ? RidgeCache[(i * 6 + k) * 7 + p] : RidgeAt(i, k, p);
                out7[p] += r * (ridge - 0.25f);
            }
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
            SectorHeights(t, k, h7, true);
            float ground = SectorPoint(h7, u, v);
            float level = NearWaterLevel(t);
            // Shore dressing may reshape the interior of a sector, but its shared
            // edge and authoritative centre datum must agree with adjacent sectors.
            // NearWaterLevel is cell-local, so fade its influence to zero at both.
            float radius = Math.Max(0, Math.Min(1, u + v));
            float inner = Math.Min(1, radius * 4), outer = Math.Min(1, (1 - radius) * 5);
            float shoreWeight = inner * inner * (3 - 2 * inner) * outer * outer * (3 - 2 * outer);
            if (level > NoWater * .5f && shoreWeight > 0)
            {
                float shoulder = Math.Max(0, 1f - Math.Abs(ground - level) / .16f);
                if (shoulder > 0)
                {
                    const float reach = .22f;
                    float smooth = (ground * 2f + BaseAt(x + reach, z, ground) + BaseAt(x - reach, z, ground)
                        + BaseAt(x, z + reach, ground) + BaseAt(x, z - reach, ground)) / 6f;
                    ground += (smooth - ground) * .72f * shoulder * shoulder * shoreWeight;
                }
                float band = Math.Max(0, 1f - Math.Abs(ground - level) / .085f);
                int cells = Math.Max(4, (int)Math.Round(Period * 1.7f));
                float scale = cells / Period;
                ground += (PeriodicNoise(x * scale + 19.3f, z * scale + 7.1f, cells) - .5f) * .052f * band * band * shoreWeight;
            }
            return ground + DamageHeight(t, x, z);
        }

        float BaseAt(float x, float z, float fallback)
        {
            int tile = HexMath.TileAt(x, z, W, H, Wrap != 0);
            if (tile < 0 || Known[tile] == 0) return fallback;
            float dx = HexMath.DxWrap(HexMath.CenterX(tile, W), x, Period, Wrap != 0), dz = z - HexMath.CenterZ(tile, W);
            LocateSector(dx, dz, out int sector, out float u, out float v);
            float* heights = stackalloc float[7];
            SectorHeights(tile, sector, heights, true);
            return SectorPoint(heights, u, v);
        }

        public float NearWaterLevel(int tile)
        {
            float level = Water[tile];
            for (int d = 0; d < 6; d++)
            {
                int n = Nb[tile * 6 + d];
                if (n >= 0 && Known[n] != 0) level = Math.Max(level, Water[n]);
            }
            return level;
        }

        public bool HasShore(int tile)
        {
            bool water = Water[tile] > NoWater * .5f;
            for (int d = 0; d < 6; d++)
            {
                int n = Nb[tile * 6 + d];
                if (n >= 0 && Known[n] != 0 && (Water[n] > NoWater * .5f) != water) return true;
            }
            return false;
        }

        public bool HasDamage(int t)
        {
            if (ImpactCounts == null) return false;
            if (Trenches != null && Trenches[t * 4 + 3] > 0) return true;
            if (ImpactCounts[t] != 0) return true;
            for (int d = 0; d < 6; d++) { int n = Nb[t * 6 + d]; if (n >= 0 && (ImpactCounts[n] != 0 || Trenches != null && Trenches[n * 4 + 3] > 0)) return true; }
            return false;
        }

        /// <summary>Persistent irregular crater bowls and displaced rims, shared by meshes and actors.</summary>
        public float DamageHeight(int t, float x, float z)
        {
            if (ImpactCounts == null || Impacts == null) return 0;
            float bowl = 0, rim = 0;
            for (int cell = -1; cell < 6; cell++)
            {
                int n = cell < 0 ? t : Nb[t * 6 + cell];
                if (n < 0) continue;
                float dx = HexMath.DxWrap(HexMath.CenterX(n, W), x, Period, Wrap != 0), dz = z - HexMath.CenterZ(n, W);
                if (Trenches != null && Trenches[n * 4 + 3] > 0)
                {
                    int tr = n * 4;
                    float tx = dx - Trenches[tr], tz = dz - Trenches[tr + 1], a = Trenches[tr + 2];
                    float sn = (float)Math.Sin(a), cs = (float)Math.Cos(a);
                    float across = Math.Abs(tx * sn + tz * cs), along = Math.Abs(-tx * cs + tz * sn);
                    float width = Math.Max(0, Math.Min(1, (.11f - across) / .035f));
                    float ends = Math.Max(0, Math.Min(1, (.88f - along) / .12f));
                    bowl = Math.Min(bowl, -Trenches[tr + 3] * width * ends);
                }
                for (int k = 0; k < ImpactCounts[n]; k++)
                {
                    int index = (n * 6 + k) * 4;
                    float ox = dx - Impacts[index], oz = dz - Impacts[index + 1], radius = Impacts[index + 2];
                    float rr = (float)Math.Sqrt(ox * ox + oz * oz) / radius;
                    if (rr >= 1.6f) continue;
                    float angle = index * 1.618034f, sn = (float)Math.Sin(angle), cs = (float)Math.Cos(angle);
                    float ex = (ox * cs + oz * sn) * 1.10f, ez = (-ox * sn + oz * cs) * .91f;
                    float theta = (float)Math.Atan2(ez, ex);
                    rr = (float)Math.Sqrt(ex * ex + ez * ez) / radius;
                    rr *= 1f + .075f * (float)Math.Sin(theta * 3 + angle) + .035f * (float)Math.Cos(theta * 7 - angle);
                    float inner = Math.Max(0, 1f - rr * rr);
                    bowl = Math.Min(bowl, -Impacts[index + 3] * inner * inner);
                    float edge = Math.Max(0, 1f - Math.Abs(rr - 1.02f) / .30f);
                    rim = Math.Max(rim, Impacts[index + 3] * .23f * edge * edge);
                }
            }
            // An older crater's rim is flattened inside a newer overlapping bowl.
            return bowl + rim * Math.Max(0, 1 + bowl / .045f);
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
