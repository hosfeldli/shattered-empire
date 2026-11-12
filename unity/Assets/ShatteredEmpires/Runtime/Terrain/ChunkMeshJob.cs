using System.Runtime.InteropServices;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Landscape
{
    [StructLayout(LayoutKind.Sequential)]
    public struct TerrainVertex
    {
        public float3 Position;
        public float3 Normal;
        public Color32 Color;

        public static readonly VertexAttributeDescriptor[] Layout =
        {
            new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Normal, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4),
        };
    }

    /// <summary>
    /// Builds one 16×16-hex chunk off the main thread: the detailed ground (the exact sector
    /// triangulation every height query uses), a coarse LOD, the water surfaces (sea, lakes, river
    /// ribbons) and the chunk's trees. Writes straight into Mesh.MeshData, so the main thread only
    /// uploads finished meshes. Positions are relative to the chunk origin for float precision.
    /// </summary>
    [BurstCompile(FloatMode = FloatMode.Fast)]
    public unsafe struct ChunkMeshJob : IJob
    {
        [NativeDisableUnsafePtrRestriction] public float* Height;
        [NativeDisableUnsafePtrRestriction] public float* Water;
        [NativeDisableUnsafePtrRestriction] public byte* Known;
        [NativeDisableUnsafePtrRestriction] public byte* GeoFlags;
        [NativeDisableUnsafePtrRestriction] public byte* Biome;
        [NativeDisableUnsafePtrRestriction] public int* Nb;
        [NativeDisableUnsafePtrRestriction] public float* Impacts;
        [NativeDisableUnsafePtrRestriction] public byte* ImpactCounts;
        [NativeDisableUnsafePtrRestriction] public float* Trenches;
        [NativeDisableUnsafePtrRestriction] public byte* Geo;
        public int W, H, WrapFlag, Cx, Cy, Cs, Seed;
        public float Period, OriginX, TreeDensity;

        public Mesh.MeshDataArray Meshes;                 // 0 detailed ground, 1 coarse ground, 2 water
        [ReadOnly] public NativeArray<VertexAttributeDescriptor> Layout;   // TerrainVertex layout (Burst needs a native array)
        [ReadOnly] public NativeArray<byte> Blocked;       // chunk-local: no trees (towns, roads, buildings)
        public NativeArray<InstanceData> TreesA;           // broadleaf
        public NativeArray<InstanceData> TreesB;           // conifer
        public NativeArray<int> Counts;                    // [trees A, trees B]
        public NativeArray<float> BoundsOut;               // min xyz, max xyz

        TerrainView View => new TerrainView
        {
            W = W, H = H, Wrap = WrapFlag, Period = Period, Height = Height, Water = Water, Known = Known,
            GeoFlags = GeoFlags, Biome = Biome, Nb = Nb, Impacts = Impacts, ImpactCounts = ImpactCounts, Trenches = Trenches,
        };

        static float Hash(int a, int b)
        {
            uint h = (uint)(a * 374761393 + b * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xffffff) / 16777216f;
        }

        static float3 BiomeColor(int b)
        {
            switch (b)
            {
                case 0: return new float3(0.10f, 0.17f, 0.20f);   // deep sea floor
                case 1: return new float3(0.30f, 0.33f, 0.27f);   // shallow floor
                case 2: return new float3(.46f, .50f, .37f);   // temperate grass
                case 3: return new float3(.51f, .51f, .40f);   // dry meadow
                case 4: return new float3(.36f, .42f, .31f);   // forest floor
                case 5: return new float3(0.72f, 0.62f, 0.42f);   // desert
                case 6: return new float3(0.55f, 0.57f, 0.52f);   // tundra
                case 7: return new float3(.39f, .45f, .36f);   // marsh
                case 8: return new float3(.49f, .50f, .41f);   // hills
                case 9: return new float3(.51f, .51f, .48f);   // mountain
                case 10: return new float3(0.86f, 0.88f, 0.90f);  // peak snow
                case 11: return new float3(0.45f, 0.16f, 0.07f);  // lava fields
                case 12: return new float3(0.30f, 0.29f, 0.28f);  // ash
                default: return new float3(0.4f, 0.4f, 0.4f);
            }
        }

        float3 HexColor(int i)
        {
            var c = BiomeColor(Biome[i]);
            byte f = GeoFlags[i];
            if ((f & 32) != 0) c = math.lerp(c, new float3(0.3f, 0.29f, 0.28f), 0.6f);   // ash fall
            if ((f & 16) != 0) c = math.lerp(c, new float3(0.6f, 0.52f, 0.36f), 0.4f);   // drought
            if ((f & 4) != 0) c *= new float3(0.92f, 0.95f, 0.88f);                       // volcanic soil
            float n = Hash(i, Seed) - 0.5f;
            return c * (1f + n * .025f);
        }

        float3 MeanColor(int i, int a, int b)
        {
            float3 s = HexColor(i); int c = 1;
            if (a >= 0 && Known[a] != 0) { s += HexColor(a); c++; }
            if (b >= 0 && Known[b] != 0) { s += HexColor(b); c++; }
            return s / c;
        }

        float3 SectorColor(int tile, int sector, int point)
        {
            if (point == 1 || point == 2)
            {
                int corner = point == 1 ? sector : (sector + 1) % 6;
                return MeanColor(tile, Nb[tile * 6 + HexMath.CornerDirs[corner * 2]], Nb[tile * 6 + HexMath.CornerDirs[corner * 2 + 1]]);
            }
            return point == 3 ? MeanColor(tile, Nb[tile * 6 + HexMath.PosMod(1 - sector, 6)], -1) : HexColor(tile);
        }

        float3 GroundColor(int tile, float x, float z)
        {
            TerrainView.LocateSector(x, z, out int sector, out float u, out float v);
            int tri = u + v <= .5f ? u >= v ? 0 : 1 : u >= v ? u >= .5f ? 2 : 3 : v >= .5f ? 4 : 5;
            int a = TerrainView.SectorTris[tri * 3], b = TerrainView.SectorTris[tri * 3 + 1], c = TerrainView.SectorTris[tri * 3 + 2];
            float2 origin = new float2(TerrainView.SectorU[a], TerrainView.SectorV[a]);
            var e1 = new float2(TerrainView.SectorU[b], TerrainView.SectorV[b]) - origin;
            var e2 = new float2(TerrainView.SectorU[c], TerrainView.SectorV[c]) - origin;
            var p = new float2(u, v) - origin;
            float determinant = e1.x * e2.y - e1.y * e2.x;
            float s = (p.x * e2.y - p.y * e2.x) / determinant, r = (e1.x * p.y - e1.y * p.x) / determinant;
            return SectorColor(tile, sector, a) * (1 - s - r) + SectorColor(tile, sector, b) * s + SectorColor(tile, sector, c) * r;
        }

        static Color32 Pack(float3 c, float a)
        {
            c = math.saturate(c);
            return new Color32((byte)(c.x * 255f), (byte)(c.y * 255f), (byte)(c.z * 255f), (byte)(math.saturate(a) * 255f));
        }

        float3 Normal(in TerrainView v, float x, float z)
        {
            const float e = 0.1f;
            float hx = v.GroundHeight(x + e, z) - v.GroundHeight(x - e, z);
            float hz = v.GroundHeight(x, z + e) - v.GroundHeight(x, z - e);
            return math.normalize(new float3(-hx, 2f * e, hz));   // map gradient, mirrored into Unity space
        }

        Color32 ShadeAt(float3 baseColor, float y, bool seaFloor)
        {
            // snow on high ground, sand at the waterline
            float snow = math.saturate((y - 4.1f) * 1.2f);
            float3 c = math.lerp(baseColor, new float3(0.9f, 0.92f, 0.94f), snow);
            if (!seaFloor && y < 0.16f) c = math.lerp(c, new float3(0.68f, 0.62f, 0.46f), math.saturate((0.16f - y) * 8f));
            return Pack(c, seaFloor ? 0f : 1f);
        }

        /// <summary>
        /// The water surface over hex i: its own sea or lake level, or (a shore hex) the highest level of a
        /// neighbouring sea or lake. Water drawn over the shore is hidden wherever the ground rises above
        /// it, so the coastline is the true intersection of terrain and water, not a hex outline.
        /// </summary>
        float WaterLevelFor(int i)
        {
            if (Water[i] > TerrainView.NoWater * 0.5f) return Water[i];
            float best = TerrainView.NoWater;
            for (int d = 0; d < 6; d++)
            {
                int n = Nb[i * 6 + d];
                if (n >= 0 && Known[n] != 0 && Water[n] > best) best = Water[n];
            }
            return best;
        }

        void WaterVertex(ref NativeArray<TerrainVertex> wv, ref int vw, in TerrainView v, float level, float x, float z)
        {
            float depth = level - v.GroundHeight(x, z);
            wv[vw++] = new TerrainVertex { Position = new float3(x - OriginX, level, -z), Normal = new float3(0, 1, 0), Color = Pack(new float3(0, 1, 1), depth / 0.9f) };
        }

        // Clip each water triangle to the actual terrain intersection before upload.
        // This works for procedural draws, offscreen cameras and all graphics presets;
        // it does not depend on Unity including procedural terrain in a depth prepass.
        void WaterTriangle(ref NativeArray<TerrainVertex> vertices, ref NativeArray<uint> indices,
            ref int vi, ref int ii, in TerrainView view, float level, float2 a, float2 b, float2 c)
        {
            float3* input = stackalloc float3[3];
            float3* clipped = stackalloc float3[4];
            input[0] = new float3(a, level - view.GroundHeight(a.x, a.y));
            input[1] = new float3(b, level - view.GroundHeight(b.x, b.y));
            input[2] = new float3(c, level - view.GroundHeight(c.x, c.y));
            int count = 0;
            for (int edge = 0; edge < 3; edge++)
            {
                var p = input[edge]; var q = input[(edge + 1) % 3];
                bool inside = p.z > 0, nextInside = q.z > 0;
                if (inside) clipped[count++] = p;
                if (inside != nextInside) clipped[count++] = math.lerp(p, q, p.z / (p.z - q.z));
            }
            for (int k = 1; k + 1 < count; k++) for (int corner = 0; corner < 3; corner++)
            {
                var p = clipped[corner == 0 ? 0 : corner == 1 ? k : k + 1];
                vertices[vi] = new TerrainVertex { Position = new float3(p.x - OriginX, level, -p.y),
                    Normal = new float3(0, 1, 0), Color = Pack(new float3(0, 1, 1), p.z / .9f) };
                indices[ii++] = (uint)vi++;
            }
        }

        /// <summary>A river, or a headwater stream (geo flag bit 7), with a downstream direction.</summary>
        bool IsChannel(int i) => i >= 0 && Known[i] != 0 && (GeoFlags[i] & 1) != 0
            && Geo[i * 6 + 5] > 0 && (GeoFlags[i] & 2) == 0;

        float2 ChannelDirection(int tile)
        {
            var center = new float2(HexMath.CenterX(tile, W), HexMath.CenterZ(tile, W));
            int flow = Geo[tile * 6 + 5] - 1;
            if (flow < 0 || flow > 5) return new float2(1, 0);
            float2 ahead = center + new float2(HexMath.DirX[flow], HexMath.DirZ[flow]) * HexMath.Sqrt3;
            float2 behind = center;
            int biggest = -1;
            for (int d = 0; d < 6; d++)
            {
                int n = Nb[tile * 6 + d];
                if (!IsChannel(n) || Geo[n * 6 + 5] - 1 != (d + 3) % 6 || Geo[n * 6 + 4] <= biggest) continue;
                biggest = Geo[n * 6 + 4];
                behind = center + new float2(HexMath.DirX[d], HexMath.DirZ[d]) * HexMath.Sqrt3;
            }
            return math.normalizesafe(ahead - behind, new float2(1, 0));
        }

        float ChannelWidth(int tile) => (GeoFlags[tile] & 1) != 0
            ? .075f + (Geo[tile * 6 + 4] >> 4) * .018f : .028f;

        bool HasChannelUpstream(int tile)
        {
            for (int d = 0; d < 6; d++)
            {
                int n = Nb[tile * 6 + d];
                if (IsChannel(n) && Geo[n * 6 + 5] - 1 == (d + 3) % 6) return true;
            }
            return false;
        }

        void DamageVertex(ref NativeArray<TerrainVertex> vertices, ref NativeArray<uint> indices, ref int vi, ref int ii,
            in TerrainView view, int tile, float cx, float cz, float ax, float az, float bx, float bz, float2 uv, float3 color, bool sea,
            ref float3 min, ref float3 max)
        {
            float x = cx + uv.x * ax + uv.y * bx, z = cz + uv.x * az + uv.y * bz;
            float y = view.GroundHeight(x, z), depression = view.DamageHeight(tile, x, z);
            color = GroundColor(tile, x - cx, z - cz);
            var pos = new float3(x - OriginX, y, -z);
            min = math.min(min, pos); max = math.max(max, pos);
            var soil = Biome[tile] >= 9 ? new float3(.30f, .28f, .25f) : new float3(.27f, .23f, .16f);
            float level = view.NearWaterLevel(tile);
            if (level > TerrainView.NoWater * .5f)
                color = math.lerp(color, new float3(.48f, .46f, .39f), math.saturate(1f - math.abs(y - level) / .034f) * .58f);
            vertices[vi] = new TerrainVertex { Position = pos, Normal = Normal(view, x, z), Color = ShadeAt(math.lerp(color, soil, math.saturate(math.abs(depression) * 28)), y, sea) };
            indices[ii++] = (uint)vi++;
        }

        public void Execute()
        {
            var v = View;
            v.RidgeCache = null;   // the ridge cache belongs to the main thread; jobs compute the noise directly
            v.RidgeFilled = null;
            int n0 = Cy * Cs, q0 = Cx * Cs;
            int hexes = 0, damaged = 0, water = 0, shoreWater = 0, rivers = 0;
            for (int lr = 0; lr < Cs; lr++)
                for (int lq = 0; lq < Cs; lq++)
                {
                    int q = q0 + lq, r = n0 + lr;
                    if (q >= W || r >= H) continue;
                    int i = r * W + q;
                    if (Known[i] == 0) continue;
                    hexes++;
                    if (v.HasDamage(i) || v.HasShore(i)) damaged++;
                    if (WaterLevelFor(i) > TerrainView.NoWater * 0.5f) { water++; if (v.HasShore(i)) shoreWater++; }
                    if (IsChannel(i)) rivers++;
                }
            float3 bmin = new float3(1e9f), bmax = new float3(-1e9f);

            // ---------------- detailed ground: 6 sectors × 7 points × 6 triangles per hex
            var hi = Meshes[0];
            hi.SetVertexBufferParams((hexes - damaged) * 42 + damaged * 972 + rivers * 52, Layout);
            hi.SetIndexBufferParams((hexes - damaged) * 108 + damaged * 972 + rivers * 144, IndexFormat.UInt32);
            var hv = hi.GetVertexData<TerrainVertex>();
            var hix = hi.GetIndexData<uint>();
            var lo = Meshes[1];
            lo.SetVertexBufferParams(hexes * 7, Layout);
            lo.SetIndexBufferParams(hexes * 18, IndexFormat.UInt32);
            var lv = lo.GetVertexData<TerrainVertex>();
            var lix = lo.GetIndexData<uint>();
            int vh = 0, ih = 0, vl = 0, il = 0;
            float* h7 = stackalloc float[7];
            int treeA = 0, treeB = 0;
            for (int lr = 0; lr < Cs; lr++)
                for (int lq = 0; lq < Cs; lq++)
                {
                    int q = q0 + lq, r = n0 + lr;
                    if (q >= W || r >= H) continue;
                    int i = r * W + q;
                    if (Known[i] == 0) continue;
                    float cx = HexMath.CenterX(i, W), cz = HexMath.CenterZ(i, W);
                    bool seaFloor = v.IsSea(i);
                    float3 own = HexColor(i);
                    bool refine = v.HasDamage(i) || v.HasShore(i);
                    for (int k = 0; k < 6; k++)
                    {
                        int k2 = (k + 1) % 6;
                        v.SectorHeights(i, k, h7);
                        float ax = HexMath.CornerX[k], az = HexMath.CornerZ[k], bx = HexMath.CornerX[k2], bz = HexMath.CornerZ[k2];
                        int baseV = vh;
                        if (refine)
                        {
                            // Dense geometry is limited to damage and banks. Units, streets and
                            // water sample this same surface, including the organic shoreline relief.
                            for (int tri = 0; tri < 6; tri++)
                            {
                                int a = TerrainView.SectorTris[tri * 3], middle = TerrainView.SectorTris[tri * 3 + 1], c = TerrainView.SectorTris[tri * 3 + 2];
                                float2 pa = new float2(TerrainView.SectorU[a], TerrainView.SectorV[a]);
                                float2 pb = new float2(TerrainView.SectorU[middle], TerrainView.SectorV[middle]);
                                float2 pc = new float2(TerrainView.SectorU[c], TerrainView.SectorV[c]);
                                for (int row = 0; row < 3; row++) for (int column = 0; column < 3 - row; column++)
                                {
                                    float2 p0 = pa + (pb - pa) * (row / 3f) + (pc - pa) * (column / 3f);
                                    float2 p1 = p0 + (pb - pa) / 3f, p2 = p0 + (pc - pa) / 3f;
                                    DamageVertex(ref hv, ref hix, ref vh, ref ih, v, i, cx, cz, ax, az, bx, bz, p0, own, seaFloor, ref bmin, ref bmax);
                                    DamageVertex(ref hv, ref hix, ref vh, ref ih, v, i, cx, cz, ax, az, bx, bz, p1, own, seaFloor, ref bmin, ref bmax);
                                    DamageVertex(ref hv, ref hix, ref vh, ref ih, v, i, cx, cz, ax, az, bx, bz, p2, own, seaFloor, ref bmin, ref bmax);
                                    if (row + column >= 2) continue;
                                    float2 p3 = p1 + (pc - pa) / 3f;
                                    DamageVertex(ref hv, ref hix, ref vh, ref ih, v, i, cx, cz, ax, az, bx, bz, p1, own, seaFloor, ref bmin, ref bmax);
                                    DamageVertex(ref hv, ref hix, ref vh, ref ih, v, i, cx, cz, ax, az, bx, bz, p3, own, seaFloor, ref bmin, ref bmax);
                                    DamageVertex(ref hv, ref hix, ref vh, ref ih, v, i, cx, cz, ax, az, bx, bz, p2, own, seaFloor, ref bmin, ref bmax);
                                }
                            }
                            continue;
                        }
                        for (int p = 0; p < 7; p++)
                        {
                            float u = TerrainView.SectorU[p], w = TerrainView.SectorV[p];
                            float x = cx + u * ax + w * bx, z = cz + u * az + w * bz;
                            float y = h7[p];
                            float3 col;
                            if (p == 1) col = MeanColor(i, Nb[i * 6 + HexMath.CornerDirs[k * 2]], Nb[i * 6 + HexMath.CornerDirs[k * 2 + 1]]);
                            else if (p == 2) col = MeanColor(i, Nb[i * 6 + HexMath.CornerDirs[k2 * 2]], Nb[i * 6 + HexMath.CornerDirs[k2 * 2 + 1]]);
                            else if (p == 3) col = MeanColor(i, Nb[i * 6 + HexMath.PosMod(1 - k, 6)], -1);
                            else col = own;
                            var pos = new float3(x - OriginX, y, -z);   // Unity world: map z mirrored (see Space)
                            bmin = math.min(bmin, pos); bmax = math.max(bmax, pos);
                            hv[vh++] = new TerrainVertex { Position = pos, Normal = Normal(v, x, z), Color = ShadeAt(col, y, seaFloor) };
                        }
                        // SECTOR_TRIS winds counter-clockwise in the right-handed map; mirrored into Unity's
                        // left-handed world that is clockwise, Unity's front face, so the order is kept
                        for (int t = 0; t < 18; t++) hix[ih++] = (uint)(baseV + TerrainView.SectorTris[t]);
                    }
                    // coarse LOD: centre and the six corners
                    int baseL = vl;
                    lv[vl++] = new TerrainVertex { Position = new float3(cx - OriginX, Height[i], -cz), Normal = Normal(v, cx, cz), Color = ShadeAt(own, Height[i], seaFloor) };
                    for (int k = 0; k < 6; k++)
                    {
                        float x = cx + HexMath.CornerX[k], z = cz + HexMath.CornerZ[k];
                        float y = v.CornerHeight(i, k);
                        var col = MeanColor(i, Nb[i * 6 + HexMath.CornerDirs[k * 2]], Nb[i * 6 + HexMath.CornerDirs[k * 2 + 1]]);
                        lv[vl++] = new TerrainVertex { Position = new float3(x - OriginX, y, -z), Normal = Normal(v, x, z), Color = ShadeAt(col, y, seaFloor) };
                    }
                    for (int k = 0; k < 6; k++)
                    {
                        lix[il++] = (uint)baseL;
                        lix[il++] = (uint)(baseL + 1 + k);
                        lix[il++] = (uint)(baseL + 1 + (k + 1) % 6);
                    }
                    // trees
                    if (seaFloor || v.IsLake(i) || Blocked[lr * Cs + lq] != 0) continue;
                    int b = Biome[i];
                    float count = b == 4 ? 9 : b == 6 ? 2 : b == 7 ? 3 : b == 8 ? 2 : b == 9 ? 1.2f : b == 2 ? 0.9f : b == 3 ? 0.35f : 0;
                    count *= TreeDensity;
                    int whole = (int)count;
                    if (Hash(i, Seed + 5) < count - whole) whole++;
                    for (int t = 0; t < whole; t++)
                    {
                        // a random point inside a random sector (always inside the hex)
                        int k = (int)(Hash(i * 13 + t, Seed + 1) * 6) % 6;
                        int k2 = (k + 1) % 6;
                        float u = Hash(i * 17 + t, Seed + 2), w = Hash(i * 19 + t, Seed + 3);
                        if (u + w > 1f) { u = 1f - u; w = 1f - w; }
                        u *= 0.9f; w *= 0.9f;
                        float x = cx + u * HexMath.CornerX[k] + w * HexMath.CornerX[k2];
                        float z = cz + u * HexMath.CornerZ[k] + w * HexMath.CornerZ[k2];
                        if ((GeoFlags[i] & 1) != 0 && u + w < 0.35f) continue;   // keep river channels clear
                        float y = v.GroundHeight(x, z);
                        // The detailed tree library is normalized to about one unit tall.
                        // Mature canopy needs a comparable scale to the command buildings.
                        float s = 0.38f + Hash(i * 23 + t, Seed + 4) * 0.23f;
                        bool conifer = b == 6 || b == 9 || b == 8 || (b == 4 && Hash(i, Seed + 9) < 0.3f) || y > 3f;
                        float g = Hash(i * 29 + t, Seed + 6);
                        int grove = (int)math.floor(cx / 12f) + (int)math.floor(cz / 12f) * 4099;
                        float autumn = Hash(grove, Seed + 11) < .055f ? 1f : 0f;
                        var col = conifer ? new float4(.26f + g * .04f, .35f + g * .05f, .25f, 0)
                            : new float4(.36f + g * .07f + autumn * .14f, .44f + g * .06f - autumn * .04f, .29f + g * .025f, 0);
                        var inst = InstanceData.TRS(MapSpace.W(x, y - 0.01f, z), MapSpace.Yaw(Hash(i * 31 + t, Seed) * 6.283f), new float3(s, s * (0.9f + g * 0.4f), s), col);
                        if (conifer) { if (treeB < TreesB.Length) TreesB[treeB++] = inst; }
                        else if (treeA < TreesA.Length) TreesA[treeA++] = inst;
                    }
                }
            lo.subMeshCount = 1;
            lo.SetSubMesh(0, new SubMeshDescriptor(0, il), MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            Counts[0] = treeA; Counts[1] = treeB;

            // ---------------- water: flat hexes at the water level, river ribbons along the flow
            var wm = Meshes[2];
            int waterCapacity = (water - shoreWater) * 216 + shoreWater * 1944;
            wm.SetVertexBufferParams(waterCapacity + rivers * 39, Layout);
            wm.SetIndexBufferParams(waterCapacity + rivers * 144, IndexFormat.UInt32);
            var wv = wm.GetVertexData<TerrainVertex>();
            var wix = wm.GetIndexData<uint>();
            int vw = 0, iw = 0;
            for (int lr = 0; lr < Cs; lr++)
                for (int lq = 0; lq < Cs; lq++)
                {
                    int q = q0 + lq, r = n0 + lr;
                    if (q >= W || r >= H) continue;
                    int i = r * W + q;
                    if (Known[i] == 0) continue;
                    float cx = HexMath.CenterX(i, W), cz = HexMath.CenterZ(i, W);
                    float level = WaterLevelFor(i);
                    if (level > TerrainView.NoWater * 0.5f)
                    {
                        // vertex colour alpha = water depth there (0 at the shoreline, 1 deep): the shader
                        // turns it into colour, transparency and shore foam
                        // each sector is split in four, so the depth (and with it the transparent
                        // waterline) is sampled finely enough to follow the real shore, not the hex
                        // (colour r = 0 marks standing water; rivers carry r = 1)
                        for (int k = 0; k < 6; k++)
                        {
                            int k2 = (k + 1) % 6;
                            var center = new float2(cx, cz);
                            var da = new float2(HexMath.CornerX[k], HexMath.CornerZ[k]);
                            var db = new float2(HexMath.CornerX[k2], HexMath.CornerZ[k2]);
                            for (int tri = 0; tri < 6; tri++)
                            {
                                int ia = TerrainView.SectorTris[tri * 3], ib = TerrainView.SectorTris[tri * 3 + 1], ic = TerrainView.SectorTris[tri * 3 + 2];
                                var pa = center + da * TerrainView.SectorU[ia] + db * TerrainView.SectorV[ia];
                                var pb = center + da * TerrainView.SectorU[ib] + db * TerrainView.SectorV[ib];
                                var pc = center + da * TerrainView.SectorU[ic] + db * TerrainView.SectorV[ic];
                                if (!v.HasShore(i)) WaterTriangle(ref wv, ref wix, ref vw, ref iw, v, level, pa, pb, pc);
                                else for (int row = 0; row < 3; row++) for (int column = 0; column < 3 - row; column++)
                                {
                                    var p0 = pa + (pb - pa) * (row / 3f) + (pc - pa) * (column / 3f);
                                    var p1 = p0 + (pb - pa) / 3f; var p2 = p0 + (pc - pa) / 3f;
                                    WaterTriangle(ref wv, ref wix, ref vw, ref iw, v, level, p0, p1, p2);
                                    if (row + column < 2) WaterTriangle(ref wv, ref wix, ref vw, ref iw, v, level, p1, p1 + (pc - pa) / 3f, p2);
                                }
                            }
                        }
                        bmin.y = math.min(bmin.y, level); bmax.y = math.max(bmax.y, level);
                    }
                    if (IsChannel(i))
                    {
                        int d = Geo[i * 6 + 5] - 1;
                        int nb = Nb[i * 6 + d];
                        float tx = cx + HexMath.DirX[d] * HexMath.Sqrt3, tz = cz + HexMath.DirZ[d] * HexMath.Sqrt3;
                        if (nb >= 0 && Known[nb] != 0) { tx = cx + HexMath.DxWrap(cx, HexMath.CenterX(nb, W), Period, WrapFlag != 0); tz = HexMath.CenterZ(nb, W); }
                        bool stream = (GeoFlags[i] & 1) == 0;
                        float half = ChannelWidth(i), endHalf = IsChannel(nb) ? ChannelWidth(nb) : half;
                        var from = new float2(cx, cz); var to = new float2(tx, tz);
                        float length = math.distance(from, to);
                        var startTangent = ChannelDirection(i) * length * .88f;
                        var endTangent = (IsChannel(nb) ? ChannelDirection(nb) : math.normalizesafe(to - from)) * length * .88f;
                        bool source = !HasChannelUpstream(i);
                        bool fadeEnd = !IsChannel(nb) && !(nb >= 0 && Known[nb] != 0 && (v.IsLake(nb) || v.IsSea(nb)));
                        int baseR = vw;
                        int baseBank = vh;
                        byte* coveredByLake = stackalloc byte[13];
                        // a channel: banks at the shoreline (depth 0, so they fade into the ground) and
                        // a deeper middle; r = 1 marks running water (silty colour, little foam)
                        var bank = Pack(new float3(1, 1, 1), 0);
                        var mid = Pack(new float3(1, 1, 1), stream ? 0.18f : 0.42f);
                        for (int s = 0; s <= 12; s++)
                        {
                            float t = s / 12f, t2 = t * t, t3 = t2 * t;
                            var p = from * (2 * t3 - 3 * t2 + 1) + startTangent * (t3 - 2 * t2 + t)
                                + to * (-2 * t3 + 3 * t2) + endTangent * (t3 - t2);
                            var tangent = from * (6 * t2 - 6 * t) + startTangent * (3 * t2 - 4 * t + 1)
                                + to * (-6 * t2 + 6 * t) + endTangent * (3 * t2 - 2 * t);
                            var dir = math.normalizesafe(tangent, new float2(1, 0));
                            float head = math.saturate(t / .22f), tail = math.saturate((1 - t) / .22f);
                            float taper = (source ? math.sqrt(math.max(0, 1 - (1 - head) * (1 - head))) : 1f)
                                * (fadeEnd ? math.sqrt(math.max(0, 1 - (1 - tail) * (1 - tail))) : 1f);
                            float marginVariation = 1 + .055f * math.sin(p.x * 8.7f + p.y * 5.3f) + .028f * math.sin(p.x * 17.2f - p.y * 11.1f);
                            var side = new float2(-dir.y, dir.x) * math.lerp(half, endHalf, t) * taper * marginVariation;
                            float px = p.x, pz = p.y;
                            float y = v.GroundHeight(px, pz) + .014f;
                            int waterTile = HexMath.TileAt(px, pz, W, H, WrapFlag != 0);
                            float standingLevel = waterTile >= 0 ? WaterLevelFor(waterTile) : TerrainView.NoWater;
                            coveredByLake[s] = (byte)(standingLevel > v.GroundHeight(px, pz) + .003f ? 1 : 0);
                            if (waterTile >= 0 && Water[waterTile] > -1e8f) y = math.max(y, Water[waterTile] + .001f);
                            wv[vw++] = new TerrainVertex { Position = new float3(px - side.x - OriginX, y, -(pz - side.y)), Normal = new float3(0, 1, 0), Color = bank };
                            wv[vw++] = new TerrainVertex { Position = new float3(px - OriginX, y, -pz), Normal = new float3(0, 1, 0), Color = mid };
                            wv[vw++] = new TerrainVertex { Position = new float3(px + side.x - OriginX, y, -(pz + side.y)), Normal = new float3(0, 1, 0), Color = bank };
                            // The river has a wet earthen margin, sampled on the same
                            // ground as the landscape rather than a floating decorative plate.
                            for (int shoreSide = -1; shoreSide <= 1; shoreSide += 2)
                                for (int edge = 0; edge < 2; edge++)
                                {
                                    var margin = p + side * shoreSide * (edge == 0 ? .73f : 1.38f);
                                    float gy = v.GroundHeight(margin.x, margin.y) + .0015f;
                                    var pos = new float3(margin.x - OriginX, gy, -margin.y);
                                    int cell = HexMath.TileAt(margin.x, margin.y, W, H, WrapFlag != 0);
                                    var dry = HexColor(cell >= 0 && Known[cell] != 0 ? cell : i);
                                    var tint = edge == 0 ? new float3(.40f, .38f, .32f) : dry;
                                    hv[vh++] = new TerrainVertex { Position = pos, Normal = Normal(v, margin.x, margin.y), Color = Pack(tint, 1) };
                                    bmin = math.min(bmin, pos); bmax = math.max(bmax, pos);
                                }
                        }
                        for (int s = 0; s < 12; s++)
                        {
                            if (coveredByLake[s] != 0 || coveredByLake[s + 1] != 0) continue;
                            for (int side = 0; side < 2; side++)
                            {
                                uint a = (uint)(baseBank + s * 4 + side * 2), b = a + 1, c = a + 4, farCorner = c + 1;
                                if (side == 0)
                                { hix[ih++] = a; hix[ih++] = b; hix[ih++] = c; hix[ih++] = b; hix[ih++] = farCorner; hix[ih++] = c; }
                                else
                                { hix[ih++] = b; hix[ih++] = a; hix[ih++] = c; hix[ih++] = b; hix[ih++] = c; hix[ih++] = farCorner; }
                            }
                            for (int c = 0; c < 2; c++)
                            {
                                uint a = (uint)(baseR + s * 3 + c), b = a + 1, a2 = a + 3, b2 = a + 4;
                                wix[iw++] = a; wix[iw++] = a2; wix[iw++] = b;
                                wix[iw++] = b; wix[iw++] = a2; wix[iw++] = b2;
                            }
                        }
                    }
                }
            wm.subMeshCount = 1;
            hi.subMeshCount = 1;
            hi.SetSubMesh(0, new SubMeshDescriptor(0, ih), MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            wm.SetSubMesh(0, new SubMeshDescriptor(0, iw), MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            if (hexes == 0) { bmin = float3.zero; bmax = float3.zero; }
            BoundsOut[0] = bmin.x; BoundsOut[1] = bmin.y - 0.5f; BoundsOut[2] = bmin.z;
            BoundsOut[3] = bmax.x; BoundsOut[4] = bmax.y + 0.6f; BoundsOut[5] = bmax.z;
        }
    }
}
