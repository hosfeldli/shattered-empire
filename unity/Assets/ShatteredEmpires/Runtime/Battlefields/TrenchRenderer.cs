using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Cities;
using SE.Runtime.Rendering;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Battlefields
{
    /// <summary>
    /// Trench works as continuous meshes standing on the drawn terrain (2026-11-18, docs/gameplay-overhaul/TRENCHES.md).
    ///
    /// Each node of a trench network draws the half of every link it is joined to (TrenchNetwork.Linked), so the
    /// two halves of a link meet in one identical cross-section and a line is one unbroken work. A link is swept
    /// with a single cross-section: a floor of duckboards, a fire step and a timber-revetted wall up to the sandbagged
    /// parapet on the enemy side, a lower parados behind, and earth banks sloping down to a buried toe. Every vertex
    /// sits on the terrain mesh's actual surface (MeshSurface replicates ChunkMeshJob's triangulation), sampled
    /// densely and refined where the ground bends, so the works follow slopes and height steps without floating
    /// or sinking. Where several links leave a node, each link's banks and walls are pressed down to the floor
    /// inside the other links' slots (so corners and T/X junctions open into one pit), and the outer side of a
    /// corner, a free end and a lone pit are closed by sweeping the same profile round the node. A line that meets
    /// a road ends square at the verge behind a sandbag wall and a steel plate carries it over the road.
    ///
    /// Budget: one mesh (one draw) per 16×16-hex terrain chunk holding trenches, plus three instanced detail
    /// batches (sandbag courses, timber and tape, wire). Geometry is cached per node, keyed by everything it reads
    /// (its record, its linked neighbours and the terrain within three hexes), so the 1 Hz trench progress only
    /// rebuilds the nodes being dug and the chunks holding them.
    /// </summary>
    public sealed unsafe class TrenchRenderer : IDisposable
    {
        // ---------------------------------------------------------------- cross-section (map units: 1 = 25 m)
        const float FloorHalf = .019f;      // duckboard floor, either side of the centre line
        const float StepOuter = .030f;      // fire step (front), a narrow ledge (rear)
        const float WallFoot = .034f;       // revetment foot
        const float WallTop = .041f;        // revetment top = inner edge of the crest
        const float CrestOuter = .075f;     // outer edge of the bank's crest
        const float ToeFront = TerrainView.TrenchWorksReach - .005f, ToeRear = .13f;
        const float ParapetHeight = .050f, ParadosHeight = .034f, StepHeight = .017f;
        const float FloorLift = .0016f;     // the floor floats this far above the terrain mesh
        const float ToeSink = .004f;        // the banks' outer edge tucks under the ground
        const float Flatten = .0015f;       // banks pressed into another link's slot end this far below its floor
        const float RoadClearance = .075f;  // how close outside a carriageway's edge the cut may come

        static readonly float3 Mud = new float3(.19f, .15f, .11f), Board = new float3(.42f, .33f, .22f), StepEarth = new float3(.23f, .18f, .13f);
        static readonly float3 RevetFoot = new float3(.20f, .16f, .115f), RevetTop = new float3(.36f, .29f, .20f);
        static readonly float3 Crest = new float3(.31f, .25f, .18f), CrestOut = new float3(.29f, .235f, .165f), Toe = new float3(.21f, .18f, .13f);
        static readonly float3 Concrete = new float3(.46f, .45f, .42f), ConcreteFoot = new float3(.30f, .30f, .28f);
        static readonly float3 Steel = new float3(.29f, .30f, .29f);

        enum Detail { Bags, Boxes, Wire, Count }
        enum End { Open, Round, Square }

        struct Arm
        {
            public float2 Dir;          // unit, from the node
            public float Length;        // to the link's midpoint (or the free end)
            public float Dug;           // dug length from the node (0 while planned)
            public float2 EdgeFacing;   // enemy side at the far end (shared by both halves of a link)
            public End Far;
            public bool Planned;
        }

        sealed class NodeGeo
        {
            public ulong Key;
            public int Stamp, Chunk = -1;
            public readonly List<float3> Pos = new List<float3>();
            public readonly List<float3> Nrm = new List<float3>();
            public readonly List<Color32> Col = new List<Color32>();
            public readonly List<byte> Kind = new List<byte>();
            public readonly List<int> Idx = new List<int>();
            public readonly List<InstanceData>[] Items = { new List<InstanceData>(), new List<InstanceData>(), new List<InstanceData>() };
            public void Clear() { Pos.Clear(); Nrm.Clear(); Col.Clear(); Kind.Clear(); Idx.Clear(); foreach (var l in Items) l.Clear(); }
        }

        sealed class ChunkDraw { public Mesh Mesh; public InstanceBatch Batch; }

        /// <summary>One cross-section: 17 rows (floor 0-2, left side 3-9, right side 10-16).</summary>
        sealed class Sec
        {
            public readonly float3[] P = new float3[17];
            public readonly float[] Ground = new float[17];
            public readonly Color32[] C = new Color32[17];
            public readonly byte[] K = new byte[17];
            public float3 InL, InR;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct Vtx { public float3 P, N; public Color32 C; public float2 Uv0, Uv1; }

        static readonly VertexAttributeDescriptor[] Layout =
        {
            new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Normal, VertexAttributeFormat.Float32, 3),
            new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4),
            new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 2),
            new VertexAttributeDescriptor(VertexAttribute.TexCoord1, VertexAttributeFormat.Float32, 2),
        };

        // bands of rows swept along an arm (one vertex set each: hard creases between bands)
        static readonly int[] FloorRows = { 0, 1, 2 }, FanFloorRows = { 1, 0 };
        static readonly int[] LStep = { 3, 4 }, LWall = { 5, 6 }, LBank = { 7, 8, 9 };
        static readonly int[] RStep = { 10, 11 }, RWall = { 12, 13 }, RBank = { 14, 15, 16 };
        // the closed outline of a square end, from the left toe to the right toe
        static readonly int[] Outline = { 9, 8, 6, 5, 4, 3, 1, 10, 11, 12, 13, 15, 16 };

        readonly WorldModel world;
        readonly Func<int, string> defenceAt;
        readonly Func<int, int> buildingOwnerAt;
        readonly InstanceBatch[] details = new InstanceBatch[(int)Detail.Count];
        readonly Dictionary<int, TrenchRecord> byTile = new Dictionary<int, TrenchRecord>();
        readonly Dictionary<int, NodeGeo> nodes = new Dictionary<int, NodeGeo>();
        readonly Dictionary<int, ChunkDraw> chunks = new Dictionary<int, ChunkDraw>();
        readonly HashSet<int> dirtyChunks = new HashSet<int>();
        readonly List<int> stale = new List<int>();
        readonly Dictionary<long, float> vertexHeight = new Dictionary<long, float>();
        int stamp, epoch = -1;

        // node build scratch
        NodeGeo cur;
        float2 curP;
        int curSeed;
        bool curReinforced;
        readonly List<Arm> arms = new List<Arm>();
        readonly List<Sec> secPool = new List<Sec>();
        readonly List<float> ts = new List<float>();
        readonly List<float> angles = new List<float>();

        /// <summary>Diagnostics: nodes rebuilt / replayed from cache, and the vertices of the trench meshes.</summary>
        public int NodesBuilt, NodesReplayed, Vertices;

        public TrenchRenderer(WorldModel w, Func<int, string> defenceAt, Func<int, int> buildingOwnerAt)
        {
            world = w;
            this.defenceAt = defenceAt;
            this.buildingOwnerAt = buildingOwnerAt;
            Mesh[] meshes = { MeshKit.Sandbags, MeshKit.Box, MeshKit.Coil };
            for (int i = 0; i < details.Length; i++)
                details[i] = new InstanceBatch(meshes[i], RenderResources.Instanced, 256) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
        }

        static float Hash(int a, int b)
        {
            uint h = (uint)(a * 374761393 + b * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xffffff) / 16777216f;
        }

        static Color32 C32(float3 c) { c = math.saturate(c); return new Color32((byte)(c.x * 255f), (byte)(c.y * 255f), (byte)(c.z * 255f), 255); }
        static float3 U(float2 mapDir) => new float3(mapDir.x, 0, -mapDir.y);
        float RoadGap(float2 p) => RoadCurve.RoadDistance(world, p, out _, out _);

        // ================================================================ the terrain mesh's own surface
        /// <summary>
        /// The height of the drawn terrain at (x, z): ChunkMeshJob's triangulation replicated exactly (a damaged or
        /// shore hex is split 3×3, or 4×4 by craters, into triangles whose corners carry GroundHeight plus the
        /// crater relief; other hexes are the plain sector triangles). Linear between those vertices, so works
        /// placed on it neither float over nor sink into the ground the player sees.
        /// </summary>
        float MeshSurface(float x, float z)
        {
            var v = world.View;
            int tile = HexMath.TileAt(x, z, v.W, v.H, v.Wrap != 0);
            if (tile < 0 || v.Known[tile] == 0) return v.GroundHeight(x, z);
            float cx = HexMath.CenterX(tile, v.W), cz = HexMath.CenterZ(tile, v.W);
            float dx = HexMath.DxWrap(cx, x, v.Period, v.Wrap != 0), dz = z - cz;
            TerrainView.LocateSector(dx, dz, out int k, out float u, out float w);
            if (!(v.HasDamage(tile) || v.HasShore(tile)))
            {
                float* h7 = stackalloc float[7];
                v.SectorHeights(tile, k, h7, true);
                return TerrainView.SectorPoint(h7, u, w);
            }
            int div = CraterHex(tile) ? 4 : 3;
            int tri;
            if (u + w <= .5f) tri = u >= w ? 0 : 1;
            else if (u >= w) tri = u >= .5f ? 2 : 3;
            else tri = w >= .5f ? 4 : 5;
            int ia = TerrainView.SectorTris[tri * 3], ib = TerrainView.SectorTris[tri * 3 + 1], ic = TerrainView.SectorTris[tri * 3 + 2];
            var pa = new float2(TerrainView.SectorU[ia], TerrainView.SectorV[ia]);
            var e1 = new float2(TerrainView.SectorU[ib], TerrainView.SectorV[ib]) - pa;
            var e2 = new float2(TerrainView.SectorU[ic], TerrainView.SectorV[ic]) - pa;
            var q = new float2(u, w) - pa;
            float det = e1.x * e2.y - e1.y * e2.x;
            if (math.abs(det) < 1e-9f) return v.GroundHeight(x, z);
            float s = (q.x * e2.y - q.y * e2.x) / det * div, r = (e1.x * q.y - e1.y * q.x) / det * div;
            int row = math.clamp((int)math.floor(s), 0, div - 1);
            int col = math.clamp((int)math.floor(r), 0, div - 1 - row);
            float fs = s - row, fr = r - col;
            long baseKey = (((long)tile * 6 + k) * 6 + tri) * 64;
            if (fs + fr <= 1f || row + col >= div - 1)
                return Vertex(tile, k, cx, cz, pa, e1, e2, div, row, col, baseKey) * (1 - fs - fr)
                    + Vertex(tile, k, cx, cz, pa, e1, e2, div, row + 1, col, baseKey) * fs
                    + Vertex(tile, k, cx, cz, pa, e1, e2, div, row, col + 1, baseKey) * fr;
            return Vertex(tile, k, cx, cz, pa, e1, e2, div, row + 1, col + 1, baseKey) * (fs + fr - 1)
                + Vertex(tile, k, cx, cz, pa, e1, e2, div, row, col + 1, baseKey) * (1 - fs)
                + Vertex(tile, k, cx, cz, pa, e1, e2, div, row + 1, col, baseKey) * (1 - fr);
        }

        /// <summary>One vertex of the refined terrain mesh (ChunkMeshJob.DamageVertex's height), cached for this rebuild.</summary>
        float Vertex(int tile, int k, float cx, float cz, float2 pa, float2 e1, float2 e2, int div, int row, int col, long baseKey)
        {
            long key = baseKey + row * 8 + col;
            if (vertexHeight.TryGetValue(key, out float y)) return y;
            var v = world.View;
            float2 uv = pa + e1 * ((float)row / div) + e2 * ((float)col / div);
            int k2 = (k + 1) % 6;
            float x = cx + uv.x * HexMath.CornerX[k] + uv.y * HexMath.CornerX[k2];
            float z = cz + uv.x * HexMath.CornerZ[k] + uv.y * HexMath.CornerZ[k2];
            y = v.GroundHeight(x, z) + SE.Runtime.Landscape.ChunkMeshJob.CraterRelief(v, tile, x, z, out _, out _);
            vertexHeight[key] = y;
            return y;
        }

        bool CraterHex(int tile)
        {
            var counts = world.ImpactCounts;
            if (counts.Length <= tile) return false;
            if (counts[tile] != 0) return true;
            for (int d = 0; d < 6; d++) { int n = world.Grid.Nb[tile * 6 + d]; if (n >= 0 && counts[n] != 0) return true; }
            return false;
        }

        // ================================================================ update
        static ulong Mix(ulong h, uint v) { unchecked { h ^= v; h *= 1099511628211UL; return h; } }
        static ulong MixF(ulong h, float v) => Mix(h, (uint)BitConverter.SingleToInt32Bits(v));

        static ulong MixRecord(ulong h, in TrenchRecord r)
        {
            h = Mix(h, (uint)r.Tile); h = Mix(h, (uint)r.Owner); h = Mix(h, (uint)r.Progress); h = Mix(h, (uint)r.State);
            h = Mix(h, (uint)r.Route); h = Mix(h, (uint)r.RoadMask); h = Mix(h, (uint)r.Dir);
            h = Mix(h, (uint)((r.Reinforced ? 1 : 0) | (r.HasPosition ? 2 : 0)));
            h = MixF(h, r.X); h = MixF(h, r.Z); return MixF(h, r.Facing);
        }

        /// <summary>Everything a node's geometry reads: its record, its neighbours' records, and the ground within three hexes.</summary>
        ulong NodeKey(int tile, in TrenchRecord t, int roads)
        {
            var g = world.Grid;
            ulong h = 1469598103934665603UL;
            h = Mix(h, (uint)world.Epoch);
            h = MixRecord(h, t);
            for (int d = 0; d < 6; d++)
            {
                int nb = g.Nb[tile * 6 + d];
                h = Mix(h, (uint)nb);
                if (nb < 0) continue;
                h = Mix(h, world.Known[nb]);
                if (byTile.TryGetValue(nb, out var o)) h = MixRecord(h, o);
                if (t.HasPosition) continue;
                string def = defenceAt(nb);
                h = Mix(h, (uint)(def?.GetHashCode() ?? 0)); h = Mix(h, (uint)buildingOwnerAt(nb));
            }
            bool road = false;
            int row = tile / g.W, column = tile % g.W;
            for (int r = row - 3; r <= row + 3; r++)
            {
                if (r < 0 || r >= g.H) continue;
                for (int q0 = column - 3; q0 <= column + 3; q0++)
                {
                    int q = g.Wrap ? HexMath.PosMod(q0, g.W) : q0;
                    if (q < 0 || q >= g.W) continue;
                    int c = r * g.W + q;
                    h = Mix(h, world.Known[c]);
                    h = MixF(h, world.Height[c]); h = MixF(h, world.Water[c]);
                    h = Mix(h, world.GeoFlags[c]); h = Mix(h, world.Biome[c]);
                    int n = world.ImpactCounts[c];
                    h = Mix(h, (uint)n);
                    for (int k = 0; k < n * 4; k++) h = MixF(h, world.Impacts[c * 24 + k]);
                    if (c * 4 + 3 < world.TrenchGeometry.Length) for (int k = 0; k < 4; k++) h = MixF(h, world.TrenchGeometry[c * 4 + k]);
                    if (c < world.Road.Length && world.Road[c] != 0) road = true;
                }
            }
            // roads near the node: its crossings and stubs follow the streets actually drawn
            if (road) h = Mix(h, (uint)roads);
            return h;
        }

        /// <summary>Rebuild the works whose inputs changed (see <see cref="NodeKey"/>) and re-place every node's details.</summary>
        public void Build(TrenchRecord[] trenches)
        {
            if (!world.Ready) return;
            var g = world.Grid;
            if (epoch != world.Epoch)
            {
                epoch = world.Epoch;
                nodes.Clear();
                foreach (var c in chunks.Values) DestroyChunk(c);
                chunks.Clear();
            }
            byTile.Clear();
            foreach (var t in trenches) if (t.Tile >= 0 && t.Tile < g.N) byTile[t.Tile] = t;
            int roads = world.LayoutRevision * 7919 + RoadCurve.LaneRevision;
            stamp++;
            vertexHeight.Clear();
            dirtyChunks.Clear();
            foreach (var kv in byTile)
            {
                int tile = kv.Key;
                if (world.Known[tile] == 0) continue;
                var t = kv.Value;
                ulong key = NodeKey(tile, t, roads);
                if (!nodes.TryGetValue(tile, out var geo)) nodes[tile] = geo = new NodeGeo { Key = ~key };
                geo.Stamp = stamp;
                int chunk = world.ChunkOf(tile);
                if (geo.Key != key)
                {
                    geo.Key = key;
                    BuildNode(geo, tile, t);
                    dirtyChunks.Add(chunk);
                    NodesBuilt++;
                }
                else NodesReplayed++;
                if (geo.Chunk >= 0 && geo.Chunk != chunk) dirtyChunks.Add(geo.Chunk);
                geo.Chunk = chunk;
            }
            stale.Clear();
            foreach (var kv in nodes) if (kv.Value.Stamp != stamp) stale.Add(kv.Key);
            foreach (int tile in stale) { dirtyChunks.Add(nodes[tile].Chunk); nodes.Remove(tile); }
            foreach (int chunk in dirtyChunks) Assemble(chunk);
            foreach (var b in details) b.Clear();
            foreach (var geo in nodes.Values)
                for (int i = 0; i < details.Length; i++)
                {
                    var items = geo.Items[i];
                    for (int j = 0; j < items.Count; j++) details[i].Add(items[j]);
                }
            foreach (var b in details) b.MarkDirty();
            Vertices = 0;
            foreach (var c in chunks.Values) Vertices += c.Mesh != null ? c.Mesh.vertexCount : 0;
        }

        void DestroyChunk(ChunkDraw c)
        {
            c.Batch?.Dispose();
            if (c.Mesh != null) UnityEngine.Object.Destroy(c.Mesh);
            c.Batch = null; c.Mesh = null;
        }

        /// <summary>Joins the cached geometry of every node in a terrain chunk into that chunk's one trench mesh.</summary>
        void Assemble(int chunk)
        {
            if (chunk < 0) return;
            int vertexCount = 0, indexCount = 0;
            float3 origin = float3.zero; bool first = true;
            foreach (var geo in nodes.Values)
            {
                if (geo.Chunk != chunk || geo.Pos.Count == 0) continue;
                if (first) { origin = math.floor(geo.Pos[0]); first = false; }
                vertexCount += geo.Pos.Count; indexCount += geo.Idx.Count;
            }
            if (!chunks.TryGetValue(chunk, out var draw)) chunks[chunk] = draw = new ChunkDraw();
            DestroyChunk(draw);
            if (vertexCount == 0 || indexCount == 0) { chunks.Remove(chunk); return; }
            var vertices = new NativeArray<Vtx>(vertexCount, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            var indices = new NativeArray<int>(indexCount, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            float3 min = new float3(1e9f), max = new float3(-1e9f);
            int vi = 0, ii = 0;
            foreach (var geo in nodes.Values)
            {
                if (geo.Chunk != chunk || geo.Pos.Count == 0) continue;
                int baseVertex = vi;
                for (int i = 0; i < geo.Pos.Count; i++)
                {
                    var p = geo.Pos[i] - origin;
                    min = math.min(min, p); max = math.max(max, p);
                    vertices[vi++] = new Vtx { P = p, N = geo.Nrm[i], C = geo.Col[i], Uv0 = float2.zero, Uv1 = new float2(geo.Kind[i], 0) };
                }
                for (int i = 0; i < geo.Idx.Count; i++) indices[ii++] = baseVertex + geo.Idx[i];
            }
            var mesh = new Mesh { name = "SE trench works " + chunk };
            mesh.SetVertexBufferParams(vertexCount, Layout);
            mesh.SetVertexBufferData(vertices, 0, 0, vertexCount, 0, MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds);
            mesh.SetIndexBufferParams(indexCount, IndexFormat.UInt32);
            mesh.SetIndexBufferData(indices, 0, 0, indexCount, MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds);
            var local = new Bounds((Vector3)((min + max) * .5f), (Vector3)(max - min));
            mesh.subMeshCount = 1;
            mesh.SetSubMesh(0, new SubMeshDescriptor(0, indexCount) { bounds = local, vertexCount = vertexCount }, MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
            mesh.bounds = local;
            mesh.UploadMeshData(true);
            vertices.Dispose(); indices.Dispose();
            draw.Mesh = mesh;
            draw.Batch = new InstanceBatch(mesh, RenderResources.Instanced, 1)
            {
                Bounds = new Bounds((Vector3)(origin + (min + max) * .5f), (Vector3)(max - min) + Vector3.one * .02f),
                Shadows = ShadowCastingMode.On, ReceiveShadows = true,
            };
            draw.Batch.Add(InstanceData.TRS(origin, 0f, new float3(1), new float4(1, 1, 1, 0)));
            draw.Batch.MarkDirty();
        }

        public void Draw(WrapImages images)
        {
            foreach (var c in chunks.Values) c.Batch?.DrawImages(images);
            foreach (var b in details) b.DrawImages(images);
        }

        public void Dispose()
        {
            foreach (var b in details) b.Dispose();
            foreach (var c in chunks.Values) DestroyChunk(c);
            chunks.Clear(); nodes.Clear();
        }

        // ================================================================ one node
        void BuildNode(NodeGeo geo, int tile, in TrenchRecord t)
        {
            geo.Clear();
            cur = geo;
            var g = world.Grid;
            float2 p = t.HasPosition ? new float2(t.X, t.Z) : new float2(g.CenterX(tile), g.CenterZ(tile));
            float facingAngle = TrenchNetwork.FacingOf(t);
            var facing = new float2(math.sin(facingAngle), math.cos(facingAngle));
            bool planned = t.State == 2 || t.Progress <= 0;
            float built = math.saturate(t.Progress / 100f);
            bool complete = !planned && t.Progress >= 100;
            curP = p; curSeed = tile; curReinforced = t.Reinforced;
            arms.Clear();
            for (int d = 0; d < 6; d++)
            {
                int nb = g.Nb[tile * 6 + d];
                if (nb < 0 || !byTile.TryGetValue(nb, out var o)) continue;
                var q = o.HasPosition ? new float2(o.X, o.Z) : new float2(g.CenterX(nb), g.CenterZ(nb));
                var delta = new float2(g.DxWrap(p.x, q.x), q.y - p.y);
                float length = math.length(delta);
                if (!TrenchNetwork.Linked(t, o, d, length)) continue;
                float otherFacing = TrenchNetwork.FacingOf(o);
                var edgeFacing = math.normalizesafe(facing + new float2(math.sin(otherFacing), math.cos(otherFacing)), facing);
                bool otherDone = o.State != 2 && o.Progress >= 100 && world.Known[nb] != 0;
                AddArm(delta / length, length * .5f, edgeFacing, planned, built, complete && otherDone ? End.Open : End.Round);
            }
            if (!t.HasPosition)
                for (int d = 0; d < 6; d++)
                {
                    // hex-centred records (older rulesets): the trench runs into the owner's defences beside it
                    int nb = g.Nb[tile * 6 + d];
                    if (nb < 0 || byTile.ContainsKey(nb) || defenceAt(nb) == null || buildingOwnerAt(nb) != t.Owner) continue;
                    AddArm(new float2(HexMath.DirX[d], HexMath.DirZ[d]), .87f, facing, planned, built, End.Round);
                }
            if (arms.Count == 0)
            {
                // a lone node: a straight run across its facing, rounded off at both ends
                var across = new float2(-facing.y, facing.x);
                AddArm(across, .42f, facing, planned, built, End.Round);
                AddArm(-across, .42f, facing, planned, built, End.Round);
            }
            RoadStubs(t, tile, p, facing, planned, built);

            // the links: dug stretches (split where a road crosses), steel plates on the road, tape where still planned
            for (int i = 0; i < arms.Count; i++) ArmWorks(i, facing);
            // the node: the outer side of every corner (and a free end, a lone pit) closed by the profile swept round it
            if (!planned && built > 0 && RoadGap(p) >= RoadClearance)
            {
                angles.Clear();
                for (int i = 0; i < arms.Count; i++)
                    if (arms[i].Dug > .015f && RoadGap(p + arms[i].Dir * .02f) >= RoadClearance) angles.Add(math.atan2(arms[i].Dir.y, arms[i].Dir.x));
                angles.Sort();
                if (angles.Count == 0) Fan(p, 0, 2 * math.PI, facing, -1, 0);
                for (int i = 0; i < angles.Count; i++)
                {
                    float a = angles[i], b = i + 1 < angles.Count ? angles[i + 1] : angles[0] + 2 * math.PI;
                    if (b - a > math.PI + 1e-3f) Fan(p, a + math.PI * .5f, b - a - math.PI, facing, -1, 1 + i);
                }
                if (angles.Count >= 3)   // a sign post at the crossing
                    Box(new float3(p.x, MeshSurface(p.x, p.y) + FloorLift, p.y), 0, 0, new float3(.005f, .045f, .005f), new float3(.40f, .32f, .22f));
            }
            // vertex normals: the sum of the faces around each vertex
            for (int i = 0; i < geo.Nrm.Count; i++) geo.Nrm[i] = math.normalizesafe(geo.Nrm[i], new float3(0, 1, 0));
            cur = null;
        }

        void AddArm(float2 dir, float length, float2 edgeFacing, bool planned, float built, End far)
            => arms.Add(new Arm { Dir = dir, Length = length, Dug = planned ? 0 : length * built, EdgeFacing = edgeFacing, Far = built >= 1 ? far : End.Round, Planned = planned });

        /// <summary>
        /// The server never digs on a road hex (a road leaves a gap in the line) and flags the node's road
        /// neighbours (TrenchRecord.RoadMask). Where the line would carry on into such a neighbour it runs on from
        /// the node to the road's verge (found on the street geometry actually drawn) and ends square there behind
        /// a sandbag wall, so the gap reads as a deliberate crossing. A road beside the line adds nothing.
        /// </summary>
        void RoadStubs(in TrenchRecord t, int tile, float2 c, float2 facing, bool planned, float built)
        {
            if (t.RoadMask == 0) return;
            var g = world.Grid;
            int count = arms.Count;
            for (int d = 0; d < 6; d++)
            {
                if ((t.RoadMask & (1 << d)) == 0) continue;
                int nb = g.Nb[tile * 6 + d];
                if (nb < 0) continue;
                var toward = new float2(g.DxWrap(c.x, g.CenterX(nb)), g.CenterZ(nb) - c.y);
                float reach = math.length(toward);
                if (reach < .1f) continue;
                toward /= reach;
                bool continues = count == 0, linked = false;
                for (int i = 0; i < count; i++)
                {
                    if (math.dot(toward, -arms[i].Dir) > .5f) continues = true;
                    if (math.dot(toward, arms[i].Dir) > .8f) linked = true;
                }
                if (!continues || linked) continue;
                float stop = -1;
                for (float s = .05f; s < reach; s += .02f)
                    if (RoadGap(c + toward * s) < RoadClearance) { stop = s; break; }
                if (stop < .1f) continue;   // the road is right at the node: the pit's rim closes the line
                arms.Add(new Arm { Dir = toward, Length = stop, Dug = planned ? 0 : stop * built, EdgeFacing = facing, Far = End.Square, Planned = planned });
            }
        }

        /// <summary>Arm i's dug stretches, road plates and planned tape.</summary>
        void ArmWorks(int i, float2 nodeFacing)
        {
            var arm = arms[i];
            float yaw = math.atan2(arm.Dir.x, arm.Dir.y);
            if (arm.Dug > .015f)
            {
                // march along the dug length, splitting it where it runs onto a road
                float s0 = 0; bool onRoad = RoadGap(curP) < RoadClearance;
                const float probe = .02f;
                for (float s = probe; ; s += probe)
                {
                    bool last = s >= arm.Dug;
                    float at = math.min(s, arm.Dug);
                    bool road = !last && RoadGap(curP + arm.Dir * at) < RoadClearance;
                    if (road == onRoad && !last) continue;
                    float s1 = last ? arm.Dug : at - probe * .5f;
                    if (onRoad) Plates(arm, s0, s1, yaw);
                    else if (s1 - s0 > .03f)
                    {
                        End start = s0 <= 0 ? End.Open : End.Square;
                        End end = !last ? End.Square : arm.Dug < arm.Length - 1e-4f ? End.Round : arm.Far;
                        Sweep(i, nodeFacing, s0, s1, start, end);
                    }
                    if (last) break;
                    s0 = s1; onRoad = road;
                }
            }
            if (arm.Dug < arm.Length - .02f) Tape(arm.Dir, arm.Dug, arm.Length, yaw);
        }

        void Plates(in Arm arm, float s0, float s1, float yaw)
        {
            int pieces = math.max(1, (int)math.ceil((s1 - s0) / .12f));
            float step = (s1 - s0) / pieces;
            for (int k = 0; k < pieces; k++)
            {
                var m = curP + arm.Dir * (s0 + (k + .5f) * step);
                Box(new float3(m.x, RoadCurve.Height(world, float.NegativeInfinity, m.x, m.y) + .0004f, m.y), yaw, 0,
                    new float3(.082f, .0025f, step * 1.01f), Steel * (.92f + .16f * Hash(curSeed + k, 7)));
            }
        }

        /// <summary>Planned works: pegged white tape along the line on the ground.</summary>
        void Tape(float2 dir, float s0, float s1, float yaw)
        {
            int pieces = math.max(1, (int)math.round((s1 - s0) / .12f));
            float step = (s1 - s0) / pieces;
            for (int k = 0; k <= pieces; k++)
            {
                var a = curP + dir * (s0 + k * step);
                if (RoadGap(a) < RoadClearance) continue;   // the road stays clear
                Box(new float3(a.x, MeshSurface(a.x, a.y), a.y), 0, 0, new float3(.004f, .016f, .004f), new float3(.55f, .45f, .32f));
                if (k == pieces) continue;
                var b = curP + dir * (s0 + (k + 1) * step);
                if (RoadGap(b) < RoadClearance) continue;
                float ha = MeshSurface(a.x, a.y), hb = MeshSurface(b.x, b.y);
                var m = (a + b) * .5f;
                Box(new float3(m.x, (ha + hb) * .5f + .006f, m.y), yaw, -math.atan2(hb - ha, step), new float3(.006f, .003f, step * .9f), new float3(.85f, .82f, .70f));
            }
        }

        // ---------------------------------------------------------------- the swept profile
        float2 FacingAt(in Arm arm, float2 nodeFacing, float s)
            => math.normalizesafe(math.lerp(nodeFacing, arm.EdgeFacing, math.saturate(s / math.max(arm.Length, 1e-3f))), nodeFacing);

        /// <summary>
        /// Whether map point p lies in the open slot of another dug link of this node (along it, within the slot's
        /// half-width): this link's banks, steps and walls there are pressed down to the floor, so the links open
        /// into one another at a corner or junction instead of walling each other off.
        /// </summary>
        bool InOtherSlot(float2 p, int self)
        {
            if (self < 0) return false;
            var g = world.Grid;
            var rel = new float2(g.DxWrap(curP.x, p.x), p.y - curP.y);
            for (int j = 0; j < arms.Count; j++)
            {
                if (j == self) continue;
                var a = arms[j];
                if (a.Dug <= .015f) continue;
                float along = math.dot(rel, a.Dir);
                if (along < 0 || along > a.Dug) continue;
                if (math.abs(rel.x * a.Dir.y - rel.y * a.Dir.x) < WallTop - .001f) return true;
            }
            return false;
        }

        Sec NextSec(int index)
        {
            while (secPool.Count <= index) secPool.Add(new Sec());
            return secPool[index];
        }

        /// <summary>
        /// Fills one side (rows b..b+6) of a section: fire step, revetted wall, crest and outer bank, placed along
        /// side (unit, map) from centre c. Frontness (how squarely the side faces the enemy) sets the bank's height,
        /// the fire step and the toe's reach.
        /// </summary>
        void Side(Sec sec, int b, float2 c, float2 side, float2 facing, int self, float wobble)
        {
            float w = math.smoothstep(-.25f, .25f, math.dot(side, facing));
            float bank = math.lerp(ParadosHeight, ParapetHeight, w), step = StepHeight * w * w, toe = math.lerp(ToeRear, ToeFront, w);
            bool hard = curReinforced;
            var crest = (hard ? math.lerp(Crest, Concrete, .25f) : Crest) * (.9f + .2f * wobble);
            Point(sec, b + 0, c + side * FloorHalf, FloorLift, StepEarth * .9f, SurfaceKind.Soil, self);
            Point(sec, b + 1, c + side * StepOuter, FloorLift + step, StepEarth, SurfaceKind.Soil, self);
            Point(sec, b + 2, c + side * WallFoot, FloorLift + step, hard ? ConcreteFoot : RevetFoot, SurfaceKind.Plain, self);
            Point(sec, b + 3, c + side * WallTop, bank, (hard ? Concrete : RevetTop) * (.92f + .16f * wobble), SurfaceKind.Plain, self);
            Point(sec, b + 4, c + side * WallTop, bank, crest, SurfaceKind.Soil, self);
            Point(sec, b + 5, c + side * CrestOuter, bank * .93f, CrestOut * (.92f + .16f * wobble), SurfaceKind.Soil, self);
            Point(sec, b + 6, c + side * toe, -ToeSink, Toe, SurfaceKind.Soil, -1);
        }

        void Point(Sec sec, int row, float2 p, float lift, float3 color, SurfaceKind kind, int self)
        {
            float ground = MeshSurface(p.x, p.y);
            if (self >= 0 && InOtherSlot(p, self)) { lift = FloorLift - Flatten; color = Mud; kind = SurfaceKind.Soil; }
            sec.P[row] = MapSpace.W(p.x, ground + lift, p.y);
            sec.Ground[row] = ground;
            sec.C[row] = C32(color);
            sec.K[row] = (byte)kind;
        }

        void Floor(Sec sec, int row, float2 p, float lift, float3 color, SurfaceKind kind)
        {
            float ground = MeshSurface(p.x, p.y);
            sec.P[row] = MapSpace.W(p.x, ground + lift, p.y);
            sec.Ground[row] = ground;
            sec.C[row] = C32(color);
            sec.K[row] = (byte)kind;
        }

        /// <summary>A link's cross-section at distance s from the node.</summary>
        void ArmSection(Sec sec, int i, float2 nodeFacing, float s, int index)
        {
            var arm = arms[i];
            var c = curP + arm.Dir * s;
            var n = new float2(-arm.Dir.y, arm.Dir.x);
            var f = FacingAt(arm, nodeFacing, s);
            float wobble = Hash(curSeed * 7 + i, index);
            // the duckboards: a lighter walk down the middle, slats read as alternating shades
            Floor(sec, 0, c + n * FloorHalf, FloorLift, Mud * (.9f + .2f * wobble), SurfaceKind.Soil);
            Floor(sec, 1, c, FloorLift + .0006f, Board * (index % 2 == 0 ? 1f : .78f), SurfaceKind.Plain);
            Floor(sec, 2, c - n * FloorHalf, FloorLift, Mud * (.9f + .2f * wobble), SurfaceKind.Soil);
            Side(sec, 3, c, n, f, i, wobble);
            Side(sec, 10, c, -n, f, i, wobble);
            sec.InL = U(-n); sec.InR = U(n);
        }

        /// <summary>A section of the profile swept round a point (a node's open side, or a rounded end).</summary>
        void FanSection(Sec sec, float2 c, float angle, float2 facing, int self, int index)
        {
            var r = new float2(math.cos(angle), math.sin(angle));
            float wobble = Hash(curSeed * 13 + index, 5);
            Floor(sec, 1, c, FloorLift, Mud, SurfaceKind.Soil);
            Floor(sec, 0, c + r * FloorHalf, FloorLift, Mud * (.9f + .2f * wobble), SurfaceKind.Soil);
            Side(sec, 3, c, r, facing, self, wobble);
            sec.InL = U(-r);
        }

        /// <summary>Sweeps the profile along arm i from s0 to s1, with the given caps, and sets its sandbags, posts and wire.</summary>
        void Sweep(int i, float2 nodeFacing, float s0, float s1, End start, End end)
        {
            var arm = arms[i];
            // sections: close together near the node (where links open into each other), then every .05; a section
            // is added wherever the ground between two bends by more than a couple of centimetres
            ts.Clear();
            ts.Add(s0);
            for (float s = s0; s < s1 - 1e-4f;)
            {
                s = math.min(s1, s + (s < .2f ? .02f : .05f));
                ts.Add(s);
            }
            for (int pass = 0; pass < 2; pass++)
                for (int k = ts.Count - 2; k >= 0; k--)
                {
                    float a = ts[k], b = ts[k + 1];
                    if (b - a < .012f) continue;
                    var pa = curP + arm.Dir * a; var pb = curP + arm.Dir * b; var pm = (pa + pb) * .5f;
                    float bend = MeshSurface(pm.x, pm.y) - (MeshSurface(pa.x, pa.y) + MeshSurface(pb.x, pb.y)) * .5f;
                    if (math.abs(bend) > .0012f) ts.Insert(k + 1, (a + b) * .5f);
                }
            int count = ts.Count;
            for (int k = 0; k < count; k++) ArmSection(NextSec(k), i, nodeFacing, ts[k], k);
            Bands(count, FloorRows, 0);
            Bands(count, LStep, 1); Bands(count, LWall, 1); Bands(count, LBank, 1);
            Bands(count, RStep, 2); Bands(count, RWall, 2); Bands(count, RBank, 2);
            float yaw = math.atan2(arm.Dir.x, arm.Dir.y);
            if (start == End.Square) SquareEnd(secPool[0], -arm.Dir, curP + arm.Dir * s0, yaw, i);
            if (end == End.Square) SquareEnd(secPool[count - 1], arm.Dir, curP + arm.Dir * s1, yaw, i);
            if (end == End.Round)
            {
                float a = math.atan2(arm.Dir.y, arm.Dir.x);
                Fan(curP + arm.Dir * s1, a - math.PI * .5f, math.PI, FacingAt(arm, nodeFacing, s1), i, 40 + i);
            }
            ArmDetails(i, nodeFacing, s0, s1, start, end, yaw);
        }

        /// <summary>
        /// The profile swept round point c from angle a0 through sweep radians (counter-clockwise in the map's
        /// x/z angle): the open outer side of a corner, a rounded end, or a lone pit.
        /// </summary>
        void Fan(float2 c, float a0, float sweep, float2 facing, int self, int seed)
        {
            int steps = math.max(2, (int)math.ceil(sweep / (math.PI / 12f)));
            for (int k = 0; k <= steps; k++) FanSection(NextSec(k), c, a0 + sweep * k / steps, facing, self, seed * 31 + k);
            Bands(steps + 1, FanFloorRows, 0);
            Bands(steps + 1, LStep, 1); Bands(steps + 1, LWall, 1); Bands(steps + 1, LBank, 1);
        }

        /// <summary>Emits a band: the given rows of sections 0..count-1 as one grid of shared vertices.</summary>
        void Bands(int count, int[] rows, int inwardSide)
        {
            int baseVertex = cur.Pos.Count, n = rows.Length;
            for (int k = 0; k < count; k++)
            {
                var sec = secPool[k];
                for (int r = 0; r < n; r++)
                {
                    cur.Pos.Add(sec.P[rows[r]]); cur.Nrm.Add(float3.zero); cur.Col.Add(sec.C[rows[r]]); cur.Kind.Add(sec.K[rows[r]]);
                }
            }
            for (int k = 0; k + 1 < count; k++)
            {
                var sec = secPool[k];
                float3 want = new float3(0, 1, 0) + (inwardSide == 1 ? sec.InL : inwardSide == 2 ? sec.InR : float3.zero);
                for (int r = 0; r + 1 < n; r++)
                {
                    int a = baseVertex + k * n + r, b = a + n, c = b + 1, d = a + 1;
                    Tri(a, b, c, want); Tri(a, c, d, want);
                }
            }
        }

        /// <summary>A triangle wound so its face points toward want (Unity's front face: normal = (p1 - p0) × (p2 - p0)).</summary>
        void Tri(int i0, int i1, int i2, float3 want)
        {
            var p0 = cur.Pos[i0];
            var nrm = math.cross(cur.Pos[i1] - p0, cur.Pos[i2] - p0);
            if (math.lengthsq(nrm) < 1e-14f) return;
            if (math.dot(nrm, want) < 0) { int swap = i1; i1 = i2; i2 = swap; nrm = -nrm; }
            cur.Idx.Add(i0); cur.Idx.Add(i1); cur.Idx.Add(i2);
            cur.Nrm[i0] += nrm; cur.Nrm[i1] += nrm; cur.Nrm[i2] += nrm;
        }

        /// <summary>
        /// A square end (at a road verge, or where a road splits the line): the cut faces of the banks closed down
        /// into the ground, and a sandbag wall across the slot.
        /// </summary>
        void SquareEnd(Sec sec, float2 outward, float2 at, float yaw, int self)
        {
            var want = U(outward);
            for (int k = 0; k + 1 < Outline.Length; k++)
            {
                int ra = Outline[k], rb = Outline[k + 1];
                var top0 = sec.P[ra]; var top1 = sec.P[rb];
                var bottom0 = new float3(top0.x, sec.Ground[ra] - .012f, top0.z); var bottom1 = new float3(top1.x, sec.Ground[rb] - .012f, top1.z);
                if (math.abs(top0.y - bottom0.y) < 1e-4f && math.abs(top1.y - bottom1.y) < 1e-4f) continue;
                int b0 = cur.Pos.Count;
                var color = C32(StepEarth * .85f);
                cur.Pos.Add(top0); cur.Pos.Add(top1); cur.Pos.Add(bottom1); cur.Pos.Add(bottom0);
                for (int j = 0; j < 4; j++) { cur.Nrm.Add(float3.zero); cur.Col.Add(color); cur.Kind.Add((byte)SurfaceKind.Soil); }
                Tri(b0, b0 + 1, b0 + 2, want); Tri(b0, b0 + 2, b0 + 3, want);
            }
            // the sandbag wall closing the slot, just inside the end
            var wall = at - outward * .016f;
            float y = MeshSurface(wall.x, wall.y) + FloorLift;
            float height = math.min(sec.P[6].y, sec.P[13].y) - y + .004f;
            Bags(new float3(wall.x, y, wall.y), yaw + math.PI * .5f, 0, new float3(.026f, math.max(.012f, height), WallTop * 2f + .012f), self);
        }

        // ---------------------------------------------------------------- details
        static float3 BagColor(bool reinforced) => reinforced ? new float3(.60f, .59f, .56f) : new float3(.66f, .60f, .46f);

        void Bags(float3 mapPos, float mapYaw, float pitch, float3 size, int self, float shade = 1f)
            => cur.Items[(int)Detail.Bags].Add(InstanceData.TRS(MapSpace.W(mapPos), quaternion.EulerZXY(pitch, MapSpace.Yaw(mapYaw), 0), size,
                new float4(BagColor(curReinforced) * shade, 0)));

        void Box(float3 mapPos, float mapYaw, float pitch, float3 size, float3 color)
            => cur.Items[(int)Detail.Boxes].Add(InstanceData.TRS(MapSpace.W(mapPos), quaternion.EulerZXY(pitch, MapSpace.Yaw(mapYaw), 0), size, new float4(color, 0)));

        /// <summary>
        /// Along a dug stretch: sandbag courses on the parapet's crest in fire bays (gaps between them are the
        /// loopholes), a few bags on the parados, revetment posts on the fire step's wall, and (reinforced) wire
        /// out in front. Nothing is set where the bank is pressed into another link's slot.
        /// </summary>
        void ArmDetails(int i, float2 nodeFacing, float s0, float s1, End start, End end, float yaw)
        {
            var arm = arms[i];
            var n = new float2(-arm.Dir.y, arm.Dir.x);
            const float bay = .12f;
            float from = s0 + (start == End.Open ? .07f : .045f), to = s1 - (end == End.Open ? .01f : .045f);
            int k = 0;
            for (float s = from; s <= to; s += bay, k++)
            {
                var c = curP + arm.Dir * s;
                var f = FacingAt(arm, nodeFacing, s);
                for (int side = -1; side <= 1; side += 2)
                {
                    var sv = n * side;
                    float w = math.smoothstep(-.25f, .25f, math.dot(sv, f));
                    float bank = math.lerp(ParadosHeight, ParapetHeight, w), step = StepHeight * w * w;
                    bool front = w > .5f;
                    float wobble = Hash(curSeed * 17 + k, side + 3 + i * 5);
                    // sandbags on the crest: every bay in front (continuous on a reinforced line), every third behind
                    if (front || k % 3 == 1)
                    {
                        float length = front ? (curReinforced ? .112f : .082f) : .056f;
                        var mid = c + sv * ((WallTop + CrestOuter) * .5f - .006f);
                        var a = mid - arm.Dir * length * .5f; var b = mid + arm.Dir * length * .5f;
                        if (!InOtherSlot(mid, i) && !InOtherSlot(a, i) && !InOtherSlot(b, i))
                        {
                            float ha = MeshSurface(a.x, a.y), hb = MeshSurface(b.x, b.y);
                            float y = (ha + hb) * .5f + bank * .955f - .006f;
                            Bags(new float3(mid.x, y, mid.y), yaw, -math.atan2(hb - ha, length),
                                new float3(.03f, front ? .017f : .012f, length), i, .9f + .2f * wobble);
                        }
                    }
                    // revetment posts on the firing wall
                    if (front || k % 2 == 0)
                    {
                        var post = c + arm.Dir * (bay * .5f) + sv * (WallFoot + .002f);
                        if (s + bay * .5f < to && !InOtherSlot(post, i))
                        {
                            float y = MeshSurface(post.x, post.y) + FloorLift + step;
                            Box(new float3(post.x, y - .002f, post.y), yaw, 0, new float3(.005f, bank - step + .004f, .005f), new float3(.30f, .24f, .17f) * (.9f + .2f * wobble));
                        }
                    }
                    // a reinforced line's wire belt out in front
                    if (front && curReinforced && k % 3 == 1)
                    {
                        var wire = c + sv * (ToeFront + .05f);
                        if (RoadGap(wire) >= .02f && !InOtherSlot(wire, i))
                            cur.Items[(int)Detail.Wire].Add(InstanceData.TRS(MapSpace.W(new float3(wire.x, MeshSurface(wire.x, wire.y), wire.y)),
                                MapSpace.Yaw(yaw + math.PI * .5f), new float3(.23f, .11f, .11f), new float4(.78f, .77f, .72f, 0)));
                    }
                }
            }
        }
    }
}
