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
            GeoFlags = GeoFlags, Biome = Biome, Nb = Nb,
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
                case 2: return new float3(0.30f, 0.42f, 0.19f);   // grassland
                case 3: return new float3(0.50f, 0.49f, 0.29f);   // plains
                case 4: return new float3(0.19f, 0.29f, 0.13f);   // forest floor
                case 5: return new float3(0.72f, 0.62f, 0.42f);   // desert
                case 6: return new float3(0.55f, 0.57f, 0.52f);   // tundra
                case 7: return new float3(0.28f, 0.34f, 0.22f);   // marsh
                case 8: return new float3(0.42f, 0.42f, 0.28f);   // hills
                case 9: return new float3(0.40f, 0.38f, 0.35f);   // mountain
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
            return c * (1f + n * 0.08f);
        }

        float3 MeanColor(int i, int a, int b)
        {
            float3 s = HexColor(i); int c = 1;
            if (a >= 0 && Known[a] != 0) { s += HexColor(a); c++; }
            if (b >= 0 && Known[b] != 0) { s += HexColor(b); c++; }
            return s / c;
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

        public void Execute()
        {
            var v = View;
            int n0 = Cy * Cs, q0 = Cx * Cs;
            int hexes = 0, water = 0, rivers = 0;
            for (int lr = 0; lr < Cs; lr++)
                for (int lq = 0; lq < Cs; lq++)
                {
                    int q = q0 + lq, r = n0 + lr;
                    if (q >= W || r >= H) continue;
                    int i = r * W + q;
                    if (Known[i] == 0) continue;
                    hexes++;
                    if (Water[i] > TerrainView.NoWater * 0.5f) water++;
                    if ((GeoFlags[i] & 1) != 0 && Geo[i * 6 + 5] > 0 && (GeoFlags[i] & 2) == 0) rivers++;
                }
            float3 bmin = new float3(1e9f), bmax = new float3(-1e9f);

            // ---------------- detailed ground: 6 sectors × 7 points × 6 triangles per hex
            var hi = Meshes[0];
            hi.SetVertexBufferParams(hexes * 42, Layout);
            hi.SetIndexBufferParams(hexes * 108, IndexFormat.UInt32);
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
                    for (int k = 0; k < 6; k++)
                    {
                        int k2 = (k + 1) % 6;
                        v.SectorHeights(i, k, h7);
                        float ax = HexMath.CornerX[k], az = HexMath.CornerZ[k], bx = HexMath.CornerX[k2], bz = HexMath.CornerZ[k2];
                        int baseV = vh;
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
                        float s = 0.13f + Hash(i * 23 + t, Seed + 4) * 0.09f;
                        bool conifer = b == 6 || b == 9 || b == 8 || (b == 4 && Hash(i, Seed + 9) < 0.3f) || y > 3f;
                        float g = Hash(i * 29 + t, Seed + 6);
                        float autumn = Hash(i, Seed + 11) < 0.12f ? 1f : 0f;
                        var col = conifer ? new float4(0.16f + g * 0.05f, 0.27f + g * 0.08f, 0.15f, 0) : new float4(0.24f + g * 0.1f + autumn * 0.3f, 0.36f + g * 0.1f - autumn * 0.05f, 0.14f, 0);
                        var inst = InstanceData.TRS(new float3(x, y - 0.01f, z), Hash(i * 31 + t, Seed) * 6.283f, new float3(s, s * (0.9f + g * 0.4f), s), col);
                        if (conifer) { if (treeB < TreesB.Length) TreesB[treeB++] = inst; }
                        else if (treeA < TreesA.Length) TreesA[treeA++] = inst;
                    }
                }
            hi.subMeshCount = 1;
            hi.SetSubMesh(0, new SubMeshDescriptor(0, ih), MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            lo.subMeshCount = 1;
            lo.SetSubMesh(0, new SubMeshDescriptor(0, il), MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            Counts[0] = treeA; Counts[1] = treeB;

            // ---------------- water: flat hexes at the water level, river ribbons along the flow
            var wm = Meshes[2];
            wm.SetVertexBufferParams(water * 7 + rivers * 10, Layout);
            wm.SetIndexBufferParams(water * 18 + rivers * 24, IndexFormat.UInt32);
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
                    float level = Water[i];
                    if (level > TerrainView.NoWater * 0.5f)
                    {
                        float depth = v.IsLake(i) ? 0.55f : math.saturate((level - Height[i]) / 1.0f + 0.25f);
                        int baseW = vw;
                        var col = Pack(new float3(1, 1, 1), depth);
                        wv[vw++] = new TerrainVertex { Position = new float3(cx - OriginX, level, -cz), Normal = new float3(0, 1, 0), Color = col };
                        for (int k = 0; k < 6; k++)
                            wv[vw++] = new TerrainVertex { Position = new float3(cx + HexMath.CornerX[k] * 1.02f - OriginX, level, -(cz + HexMath.CornerZ[k] * 1.02f)), Normal = new float3(0, 1, 0), Color = col };
                        for (int k = 0; k < 6; k++)
                        {
                            wix[iw++] = (uint)baseW;
                            wix[iw++] = (uint)(baseW + 1 + k);
                            wix[iw++] = (uint)(baseW + 1 + (k + 1) % 6);
                        }
                        bmin.y = math.min(bmin.y, level); bmax.y = math.max(bmax.y, level);
                    }
                    if ((GeoFlags[i] & 1) != 0 && Geo[i * 6 + 5] > 0 && (GeoFlags[i] & 2) == 0)
                    {
                        int d = Geo[i * 6 + 5] - 1;
                        int nb = Nb[i * 6 + d];
                        float tx = cx + HexMath.DirX[d] * HexMath.Sqrt3, tz = cz + HexMath.DirZ[d] * HexMath.Sqrt3;
                        if (nb >= 0 && Known[nb] != 0) { tx = cx + HexMath.DxWrap(cx, HexMath.CenterX(nb, W), Period, WrapFlag != 0); tz = HexMath.CenterZ(nb, W); }
                        int bucket = Geo[i * 6 + 4] >> 4;
                        float half = 0.06f + bucket * 0.035f;
                        float2 dir = math.normalizesafe(new float2(tx - cx, tz - cz));
                        float2 side = new float2(-dir.y, dir.x) * half;
                        int baseR = vw;
                        var rc = Pack(new float3(0.9f, 0.95f, 1f), 0.3f);
                        for (int s = 0; s < 5; s++)
                        {
                            float t = s / 4f;
                            // meander a little so channels are not ruler-straight
                            float wob = math.sin(t * 3.14159f) * (Hash(i, Seed + 13) - 0.5f) * 0.35f;
                            float px = math.lerp(cx, tx, t) + side.x / half * wob, pz = math.lerp(cz, tz, t) + side.y / half * wob;
                            float y = math.max(v.GroundHeight(px, pz), v.GroundHeight(px + side.x, pz + side.y)) + 0.02f;
                            wv[vw++] = new TerrainVertex { Position = new float3(px - side.x - OriginX, y, -(pz - side.y)), Normal = new float3(0, 1, 0), Color = rc };
                            wv[vw++] = new TerrainVertex { Position = new float3(px + side.x - OriginX, y, -(pz + side.y)), Normal = new float3(0, 1, 0), Color = rc };
                        }
                        for (int s = 0; s < 4; s++)
                        {
                            uint a = (uint)(baseR + s * 2);
                            wix[iw++] = a; wix[iw++] = a + 2; wix[iw++] = a + 1;
                            wix[iw++] = a + 1; wix[iw++] = a + 2; wix[iw++] = a + 3;
                        }
                    }
                }
            wm.subMeshCount = 1;
            wm.SetSubMesh(0, new SubMeshDescriptor(0, iw), MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            if (hexes == 0) { bmin = float3.zero; bmax = float3.zero; }
            BoundsOut[0] = bmin.x; BoundsOut[1] = bmin.y - 0.5f; BoundsOut[2] = bmin.z;
            BoundsOut[3] = bmax.x; BoundsOut[4] = bmax.y + 0.6f; BoundsOut[5] = bmax.z;
        }
    }
}
