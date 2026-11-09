using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Buildings, streets and bridges, composed procedurally from the authoritative building records
    /// and cached per 16×16 render cell. A cell is recomposed only when something in it changes how it
    /// looks (StructureStore's visual key), so construction progress or a district change never
    /// rebuilds a city, and identities are stable across reconnects (everything derives from ids).
    /// Architecture follows the owner's era: timber and brick early, concrete blocks in the middle eras,
    /// glass towers late. Buildings orient to the street they front.
    /// </summary>
    public sealed unsafe class CityRenderer : IDisposable
    {
        enum Part { Box, Roof, Cylinder, Cone, Skyscraper, Silo, Chimney, Crane, Ship, Broken, Dome, Count }

        sealed class Cell
        {
            public readonly InstanceBatch[] Batches = new InstanceBatch[(int)Part.Count];
            public Bounds Bounds;
            public bool Any;
        }

        readonly WorldModel world;
        readonly StructureStore structures;
        readonly Dictionary<int, Cell> cells = new Dictionary<int, Cell>();
        readonly HashSet<int> dirty = new HashSet<int>();
        readonly List<int> scratch = new List<int>();
        public int Age = 1;
        /// <summary>Old-world ruin sites reported by the server, by tile.</summary>
        public readonly Dictionary<int, RuinRecord> Ruins = new Dictionary<int, RuinRecord>();
        public int Seed;
        /// <summary>Chimney tops and cooling-tower mouths of composed buildings (map space), by building id.</summary>
        public readonly Dictionary<int, List<SmokeStack>> Stacks = new Dictionary<int, List<SmokeStack>>();
        public struct SmokeStack { public float3 Pos; public bool Steam; public float Size; }
        int composing = -1;
        public Func<int, float4> CivColor = _ => new float4(0.6f, 0.6f, 0.6f, 0);
        public int Recomposed { get; private set; }
        public int CellCount => cells.Count;
        public int MaxCellsPerFrame = 6;
        int epoch = -1, roadRevision = -1, age = -1;
        bool[] hasBuilding = new bool[0];

        public CityRenderer(WorldModel w, StructureStore s) { world = w; structures = s; }

        public void MarkDirty(IEnumerable<int> cellIds) { foreach (var c in cellIds) dirty.Add(c); }

        /// <summary>Tiles that hold a building, a road or a developed district (no trees there).</summary>
        public bool IsBlocked(int tile) => (tile < hasBuilding.Length && hasBuilding[tile]) || world.Road[tile] != 0 || world.IsUrban(tile);

        public void Update(Vector3 cameraPos, Landscape.TerrainRenderer terrain)
        {
            if (!world.Ready) return;
            if (epoch != world.Epoch)
            {
                epoch = world.Epoch;
                foreach (var c in cells.Values) DisposeCell(c);
                cells.Clear();
                Stacks.Clear();
                hasBuilding = new bool[world.Grid.N];
                RoadCurve.Occupied = hasBuilding;   // streets wrap round built hexes (drawing and traffic)
                roadRevision = -1;
            }
            if (roadRevision != world.LayoutRevision)
            {
                roadRevision = world.LayoutRevision;
                for (int c = 0; c < world.ChunksW * world.ChunksH; c++) dirty.Add(c);
            }
            if (age != Age)
            {
                age = Age;   // a new era: every building takes on the new architecture
                foreach (var c in cells.Keys) dirty.Add(c);
            }
            if (dirty.Count == 0) return;
            // nearest cells first, a bounded number per frame
            scratch.Clear();
            scratch.AddRange(dirty);
            float period = world.Grid.Period;
            scratch.Sort((a, b) => CellDistance(a, cameraPos, period).CompareTo(CellDistance(b, cameraPos, period)));
            int n = Math.Min(MaxCellsPerFrame, scratch.Count);
            Array.Clear(hasBuilding, 0, hasBuilding.Length);
            foreach (var b in structures.Buildings.Values) if (b.Tile >= 0 && b.Tile < hasBuilding.Length) hasBuilding[b.Tile] = true;
            for (int k = 0; k < n; k++)
            {
                int c = scratch[k];
                dirty.Remove(c);
                Compose(c, terrain);
            }
        }

        float CellDistance(int c, Vector3 cam, float period)
        {
            int cs = WorldModel.ChunkSize;
            float x = (c % world.ChunksW + 0.5f) * cs * HexMath.Sqrt3, z = (c / world.ChunksW + 0.5f) * cs * 1.5f;
            float dx = HexMath.DxWrap(cam.x, x, period, world.Grid.Wrap);
            return dx * dx + (z - cam.z) * (z - cam.z);
        }

        Cell GetCell(int id)
        {
            if (!cells.TryGetValue(id, out var cell))
            {
                cell = new Cell();
                Mesh[] meshes = { MeshKit.Box, MeshKit.Roof, MeshKit.Cylinder, MeshKit.Cone, MeshKit.Skyscraper, MeshKit.Silo, MeshKit.Chimney, MeshKit.Crane, MeshKit.ShipHull, MeshKit.BrokenTower, MeshKit.Dome };
                for (int i = 0; i < cell.Batches.Length; i++)
                    cell.Batches[i] = new InstanceBatch(meshes[i], i == (int)Part.Skyscraper ? RenderResources.InstancedGloss : RenderResources.Instanced, 64);
                cells[id] = cell;
            }
            return cell;
        }

        // ------------------------------------------------------------------ composition
        Cell current;
        float3 bmin, bmax;

        /// <summary>Place a part at a map position with a map heading; converted to Unity space here only.</summary>
        void Put(Part part, float3 mapPos, float mapYaw, float3 size, float3 color, float emission = 0)
        {
            var p = MapSpace.W(mapPos);
            current.Batches[(int)part].Add(InstanceData.TRS(p, MapSpace.Yaw(mapYaw), size, new float4(color, emission)));
            float r = math.max(size.x, size.z);
            bmin = math.min(bmin, p - new float3(r, 0, r)); bmax = math.max(bmax, p + new float3(r, size.y, r));
        }

        internal static float Hash(int a, int b)
        {
            uint h = (uint)(a * 374761393 + b * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xffffff) / 16777216f;
        }

        void Compose(int cellId, Landscape.TerrainRenderer terrain)
        {
            Recomposed++;
            var cell = GetCell(cellId);
            current = cell;
            foreach (var b in cell.Batches) b.Clear();
            bmin = new float3(1e9f); bmax = new float3(-1e9f);
            var g = world.Grid;
            int cs = WorldModel.ChunkSize, cx = cellId % world.ChunksW, cy = cellId / world.ChunksW;
            // streets and bridges of the cell's hexes (each edge drawn by its lower-index end)
            for (int lr = 0; lr < cs; lr++)
                for (int lq = 0; lq < cs; lq++)
                {
                    int q = cx * cs + lq, r = cy * cs + lr;
                    if (q >= g.W || r >= g.H) continue;
                    int t = r * g.W + q;
                    if (world.Known[t] == 0) continue;
                    if (world.Road[t] != 0) ComposeStreets(t);
                    if (world.Road[t] != 0 && world.IsUrban(t)) StreetLife(t);
                    if (world.IsUrban(t) && !hasBuildingAt(t) && !Ruins.ContainsKey(t) && !world.IsSea(t) && !world.IsLake(t)) Infill(t);
                    ComposeOldWorld(t);
                    terrain.SetBlocked(t, IsBlocked(t));
                }
            foreach (var b in structures.Buildings.Values)
            {
                if (b.Tile < 0 || b.Tile >= g.N || world.ChunkOf(b.Tile) != cellId || world.Known[b.Tile] == 0) continue;
                ComposeBuilding(b);
            }
            cell.Any = false;
            foreach (var batch in cell.Batches) if (batch.Count > 0) cell.Any = true;
            var bounds = new Bounds();
            if (cell.Any) bounds.SetMinMax(new Vector3(bmin.x, bmin.y - 0.2f, bmin.z), new Vector3(bmax.x, bmax.y + 0.2f, bmax.z));
            cell.Bounds = bounds;
            foreach (var batch in cell.Batches) { batch.Bounds = bounds; batch.MarkDirty(); }
        }

        float Ground(float x, float z) => world.View.GroundHeight(x, z);

        bool hasBuildingAt(int t) => t < hasBuilding.Length && hasBuilding[t];

        /// <summary>A part with a full rotation (toppled towers, listing ships), in Unity space.</summary>
        void PutRot(Part part, float3 mapPos, quaternion unityRotation, float3 size, float3 color)
        {
            var p = MapSpace.W(mapPos);
            current.Batches[(int)part].Add(InstanceData.TRS(p, unityRotation, size, new float4(color, 0)));
            float r = math.cmax(size);
            bmin = math.min(bmin, p - r); bmax = math.max(bmax, p + r);
        }

        // ------------------------------------------------------------------ the old world
        // Remnants of the collapse: the server's ruin sites (salvage, rebuilding) drawn as what they were,
        // plus scattered landmarks chosen deterministically from the map seed: toppled skyscrapers,
        // dead neighbourhoods, and cargo ships half sunk off the coasts. Decoration only.
        void ComposeOldWorld(int t)
        {
            var g = world.Grid;
            float cx = g.CenterX(t), cz = g.CenterZ(t);
            if (Ruins.TryGetValue(t, out var ruin)) { Ruin(t, cx, cz, ruin.Type ?? "", (ruin.Flags & 4) != 0); return; }
            if (hasBuildingAt(t) || world.Road[t] != 0 || world.IsUrban(t)) return;
            float h = Hash(t, Seed + 77);
            if (world.IsSea(t))
            {
                // a wreck lies off a coast: shallow water beside land
                bool coast = false;
                for (int d = 0; d < 6 && !coast; d++) { int n = g.Nb[t * 6 + d]; coast = n >= 0 && world.Known[n] != 0 && !world.IsSea(n) && !world.IsLake(n); }
                if (coast && h < 0.035f) Ship(t, cx, cz);
                return;
            }
            if (world.IsLake(t) || world.IsRiver(t) || world.Biome[t] >= 9) return;
            if (h < 0.006f) Ruin(t, cx, cz, "tower", false);
            else if (h < 0.016f) Ruin(t, cx, cz, "suburb", world.Biome[t] == 4);
        }

        void Ruin(int t, float cx, float cz, string type, bool overgrown)
        {
            int seed = t * 31 + Seed;
            float3 concrete = overgrown ? new float3(0.42f, 0.47f, 0.38f) : new float3(0.5f, 0.49f, 0.46f);
            var c = new Ctx { X = cx, Z = cz, Yaw = Hash(seed, 1) * 6.28f, Seed = seed, Tint = new float3(1), Civ = new float3(0.5f), Era = 1, Level = 1 };
            switch (type)
            {
                case "tower":
                case "city":
                {
                    // a skyscraper lying where it fell, broken in two, with its stump still standing
                    float yaw = Hash(seed, 2) * 6.28f;
                    float len = 1.2f + Hash(seed, 3) * 0.8f;
                    var fall = quaternion.EulerZXY(math.radians(86f + Hash(seed, 4) * 6f), MapSpace.Yaw(yaw), math.radians(Hash(seed, 5) * 12f - 6f));
                    math.sincos(yaw, out float sn, out float cs);
                    float3 basePos = new float3(cx - sn * 0.2f, Ground(cx, cz) - 0.05f, cz - cs * 0.2f);
                    PutRot(Part.Skyscraper, basePos + new float3(0, 0.12f, 0), fall, new float3(0.32f, len, 0.32f), concrete * 0.9f);
                    Module(c, Part.Broken, 0, 0, new float3(0.36f, 0.35f + Hash(seed, 6) * 0.3f, 0.36f), concrete);
                    for (int k = 0; k < 5; k++) Module(c, Part.Cone, (Hash(seed, 10 + k) - 0.5f) * 1.1f, (Hash(seed, 20 + k) - 0.5f) * 1.1f, new float3(0.22f, 0.07f + Hash(seed, k) * 0.05f, 0.22f), concrete * 0.8f);
                    if (type == "city")
                        for (int k = 0; k < 3; k++) Module(c, Part.Broken, -0.5f + k * 0.5f, 0.45f, new float3(0.28f, 0.25f + Hash(seed, 30 + k) * 0.5f, 0.28f), concrete * (0.9f + Hash(seed, k) * 0.15f));
                    break;
                }
                case "plant":
                    Module(c, Part.Silo, 0.25f, 0, new float3(0.6f, 0.38f, 0.6f), concrete);
                    Module(c, Part.Broken, -0.35f, 0.2f, new float3(0.4f, 0.22f, 0.3f), concrete * 0.9f);
                    for (int k = 0; k < 4; k++) Module(c, Part.Cone, (Hash(seed, 40 + k) - 0.5f) * 1f, (Hash(seed, 50 + k) - 0.5f) * 1f, new float3(0.2f, 0.06f, 0.2f), concrete * 0.75f);
                    break;
                default:
                    // a dead neighbourhood: roofless shells of houses, collapsed walls, rubble
                    for (int k = 0; k < 6; k++)
                    {
                        float a = Hash(seed, 60 + k) * 6.28f, r = 0.2f + Hash(seed, 70 + k) * 0.55f;
                        float s = 0.14f + Hash(seed, 80 + k) * 0.08f;
                        Module(c, Part.Broken, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(s, 0.09f + Hash(seed, 90 + k) * 0.08f, s * 0.85f), overgrown ? new float3(0.45f, 0.43f, 0.36f) : new float3(0.55f, 0.47f, 0.4f), Hash(seed, k) * 3f);
                    }
                    for (int k = 0; k < 4; k++) Module(c, Part.Cone, (Hash(seed, 100 + k) - 0.5f) * 1.2f, (Hash(seed, 110 + k) - 0.5f) * 1.2f, new float3(0.14f, 0.04f, 0.14f), new float3(0.45f, 0.4f, 0.35f));
                    break;
            }
        }

        void Ship(int t, float cx, float cz)
        {
            int seed = t * 17 + Seed;
            float yaw = Hash(seed, 1) * 6.28f;
            float level = world.View.Water[t] > -1e8f ? world.View.Water[t] : 0f;
            // listing to one side, bow raised, the stern under water
            var rot = quaternion.EulerZXY(math.radians(-8f - Hash(seed, 2) * 10f), MapSpace.Yaw(yaw), math.radians(14f + Hash(seed, 3) * 14f));
            float len = 1.3f + Hash(seed, 4) * 0.5f;
            PutRot(Part.Ship, new float3(cx, level - 0.09f, cz), rot, new float3(len, len, len), new float3(1, 1, 1));
            // a few containers still stacked on deck, and some spilled in the water
            math.sincos(yaw, out float sn, out float cs);
            for (int k = 0; k < 5; k++)
            {
                float along = (k - 2) * 0.14f * len;
                float3 col = math.lerp(new float3(0.6f, 0.2f, 0.15f), new float3(0.2f, 0.35f, 0.55f), Hash(seed, 10 + k));
                PutRot(Part.Box, new float3(cx + sn * along, level + 0.03f - k * 0.015f, cz + cs * along), rot, new float3(0.11f * len, 0.05f * len, 0.05f * len), col);
            }
            for (int k = 0; k < 3; k++)
            {
                float a = Hash(seed, 20 + k) * 6.28f, r = 0.4f + Hash(seed, 30 + k) * 0.4f;
                Put(Part.Box, new float3(cx + Mathf.Cos(a) * r, level - 0.02f, cz + Mathf.Sin(a) * r), a, new float3(0.06f, 0.035f, 0.13f), math.lerp(new float3(0.55f, 0.35f, 0.1f), new float3(0.25f, 0.45f, 0.3f), Hash(seed, 40 + k)));
            }
        }

        /// <summary>Street trees and lamps along district roads (breaks up the grey, lights the streets).</summary>
        void StreetLife(int t)
        {
            var g = world.Grid;
            float cx = g.CenterX(t), cz = g.CenterZ(t);
            int seed = t * 13 + Seed;
            if (RoadCurve.Built(t)) return;   // round a block, the building itself lines the street
            float2 node = RoadCurve.Node(world, t);
            for (int k = 0; k < 6; k++)
            {
                // along the pavement of each half-street, never in the carriageway
                int cls = world.RoadClass(t, k);
                if (cls == 0 || Hash(seed, k + 50) < 0.35f) continue;
                float along = 0.25f + Hash(seed, k + 9) * 0.45f;
                float side = (Hash(seed, k + 60) < 0.5f ? -1f : 1f) * (RoadCurve.Width(cls) * 0.5f + 0.035f);
                var pc = RoadCurve.Bezier(RoadCurve.Mid(world, t, k), RoadCurve.HalfControl(world, t, k, node), node, along, out var tan);
                float2 dir = math.normalizesafe(tan);
                float x = pc.x - dir.y * side, z = pc.y + dir.x * side;
                float a = Hash(seed, k) * 6.28f;
                float y = Ground(x, z);
                if (Hash(seed, k + 20) < 0.5f)
                {
                    float s = 0.06f + Hash(seed, k + 30) * 0.03f;
                    Put(Part.Cylinder, new float3(x, y, z), 0, new float3(0.012f, s * 0.9f, 0.012f), new float3(0.35f, 0.28f, 0.2f));
                    Put(Part.Cone, new float3(x, y + s * 0.6f, z), a, new float3(s * 1.4f, s * 1.6f, s * 1.4f), math.lerp(new float3(0.22f, 0.35f, 0.16f), new float3(0.3f, 0.42f, 0.2f), Hash(seed, k + 40)));
                }
                else
                {
                    Put(Part.Cylinder, new float3(x, y, z), 0, new float3(0.008f, 0.11f, 0.008f), new float3(0.25f, 0.25f, 0.27f));
                    Put(Part.Box, new float3(x, y + 0.11f, z), a, new float3(0.02f, 0.008f, 0.02f), new float3(1f, 0.85f, 0.55f), 0.8f);
                }
            }
        }

        /// <summary>
        /// The streets of one hex (see <see cref="RoadCurve"/>): half-streets to an off-centre junction in
        /// an open hex, streets wrapping round the block where a building stands.
        /// </summary>
        void ComposeStreets(int t)
        {
            int* e = stackalloc int[6];
            int n = RoadCurve.Edges(world, t, e);
            if (n == 0) return;
            var g = world.Grid;
            if (!RoadCurve.Built(t))
            {
                float2 node = RoadCurve.Node(world, t);
                int best = 0;
                for (int i = 0; i < n; i++)
                {
                    int d = e[i], cls = world.RoadClass(t, d);
                    best = Math.Max(best, cls);
                    float2 m = RoadCurve.Mid(world, t, d);
                    StreetPiece(t, m, RoadCurve.HalfControl(world, t, d, node), node, cls, world.RoadBroken(t, d), g.Nb[t * 6 + d], -1, 4);
                }
                // a rounded junction (or turning circle) where the streets meet, never a square plaza
                if (n >= 3 || n == 1)
                {
                    float w = RoadCurve.Width(best) * (n == 1 ? 1.3f : 1.05f);
                    float y = RoadCurve.Height(world, RoadCurve.Deck(world, t, -1, -1), node.x, node.y) - 0.012f;
                    Put(Part.Cylinder, new float3(node.x, y, node.y), 0, new float3(w, 0.012f, w), StreetColor(t, -1, best, false));
                }
                return;
            }
            int* chain = stackalloc int[6];
            int c = RoadCurve.Chain(world, t, chain);
            if (c == 1)
            {
                // the block fronts this street: it ends at the kerb, no private driveway
                int d = chain[0];
                float2 m = RoadCurve.Mid(world, t, d), inward = -new float2(HexMath.DirX[d], HexMath.DirZ[d]) * 0.12f;
                StreetPiece(t, m, m + inward * 0.5f, m + inward, world.RoadClass(t, d), world.RoadBroken(t, d), g.Nb[t * 6 + d], -1, 1);
                return;
            }
            for (int i = 0; i + 1 < c; i++)
            {
                int a = chain[i], b = chain[i + 1];
                int cls = Math.Max(world.RoadClass(t, a), world.RoadClass(t, b));
                StreetPiece(t, RoadCurve.Mid(world, t, a), RoadCurve.AroundControl(world, t, a, b), RoadCurve.Mid(world, t, b), cls,
                    world.RoadBroken(t, a) && world.RoadBroken(t, b), g.Nb[t * 6 + a], g.Nb[t * 6 + b], 6);
            }
        }

        float3 StreetColor(int t, int salt, int cls, bool broken)
        {
            float3 color = cls == 1 ? new float3(0.42f, 0.36f, 0.27f) : cls == 4 ? new float3(0.3f, 0.26f, 0.22f) : new float3(0.24f, 0.24f, 0.25f);
            // streets weather differently: patched asphalt, sun-bleached concrete, darker fresh tarmac
            color *= 0.86f + 0.26f * Hash(t * 3 + 1, salt * 5 + 2);
            if (cls >= 2 && Hash(salt + 40, t + 9) < 0.25f) color = math.lerp(color, new float3(0.38f, 0.37f, 0.35f), 0.5f);
            // country lanes vary between dry dust, gravel and damp earth
            if (cls == 1) color = math.lerp(color, Hash(t, salt + 3) < 0.5f ? new float3(0.5f, 0.46f, 0.38f) : new float3(0.34f, 0.3f, 0.24f), 0.4f);
            if (broken) color *= 0.55f;
            return color;
        }

        /// <summary>One curved street piece (quadratic Bézier p0 → c → p2), with kerbs, markings and bridge piers.</summary>
        void StreetPiece(int t, float2 p0, float2 c, float2 p2, int cls, bool broken, int na, int nb, int pieces)
        {
            float deck = RoadCurve.Deck(world, t, na, nb);
            bool bridge = deck > float.NegativeInfinity;
            // street widths vary a little from hex to hex
            float width = RoadCurve.Width(cls) * (0.9f + 0.2f * Hash(t, 77));
            float3 color = StreetColor(t, na, cls, broken);
            bool town = world.IsUrban(t) || (na >= 0 && world.IsUrban(na));
            float chord = math.distance(p0, p2) + math.distance(p0, c) * 0.3f;
            for (int k = 0; k < pieces; k++)
            {
                if (broken && k % 2 == 1) continue;
                float t0 = (k + 0.5f) / pieces;
                var p = RoadCurve.Bezier(p0, c, p2, t0, out var tan);
                float x = p.x, z = p.y;
                float pieceYaw = math.lengthsq(tan) > 1e-8f ? Mathf.Atan2(tan.x, tan.y) : 0f;
                // the ground across the road's width, so it never sinks into a slope (or the bridge deck)
                float y = RoadCurve.Height(world, deck, x, z) - 0.016f;
                float segLen = math.length(tan) / pieces * 1.12f + 0.01f;
                if (segLen < 0.02f) segLen = chord / pieces * 1.12f;
                Put(Part.Box, new float3(x, y + 0.004f, z), pieceYaw, new float3(width, 0.012f, segLen), color);
                if (cls == 3 && !bridge && k % 2 == 0)
                    Put(Part.Box, new float3(x, y + 0.0105f, z), pieceYaw, new float3(0.006f, 0.002f, segLen * 0.45f), new float3(0.78f, 0.74f, 0.55f));
                if ((cls == 2 || cls == 3) && town)
                {
                    // kerbs on paved roads (lifted with the road, so they never clip in and out)
                    float side = width * 0.55f;
                    math.sincos(pieceYaw, out float sn, out float csn);
                    Put(Part.Box, new float3(x + csn * side, y + 0.006f, z - sn * side), pieceYaw, new float3(0.018f, 0.014f, segLen), new float3(0.52f, 0.5f, 0.47f));
                    Put(Part.Box, new float3(x - csn * side, y + 0.006f, z + sn * side), pieceYaw, new float3(0.018f, 0.014f, segLen), new float3(0.52f, 0.5f, 0.47f));
                }
                if (bridge && k % 2 == 0)
                {
                    float floor = Mathf.Min(Ground(x, z), y) - 0.2f;
                    Put(Part.Box, new float3(x, floor, z), pieceYaw, new float3(width * 0.4f, y - floor, 0.03f), new float3(0.4f, 0.38f, 0.36f));
                }
            }
        }

        void ComposeBuilding(in BuildingRecord b)
        {
            var g = world.Grid;
            float cx = g.CenterX(b.Tile), cz = g.CenterZ(b.Tile);
            int seed = b.Id * 7919 + b.Tile;
            // face the street: align to the first road edge of this hex, otherwise a stable random angle
            float yaw = Hash(seed, 3) * 6.283f;
            for (int d = 0; d < 6; d++) if (world.RoadClass(b.Tile, d) != 0) { yaw = Mathf.Atan2(HexMath.DirX[d], HexMath.DirZ[d]) + Mathf.PI * 0.5f * Mathf.Round(Hash(seed, 4)); break; }
            // no two blocks sit exactly alike: a small offset and turn, so the hex grid doesn't show through
            yaw += (Hash(seed, 5) - 0.5f) * 0.22f;
            cx += (Hash(seed, 6) - 0.5f) * 0.1f; cz += (Hash(seed, 7) - 0.5f) * 0.1f;
            float4 civ = CivColor(b.Owner);
            float dmg = b.Hp >= 100 ? 1f : 0.55f + 0.45f * b.Hp / 100f;
            float memory = b.Memory ? 0.6f : 1f;
            float3 tint = new float3(dmg * memory);
            int era = Math.Max(0, Math.Min(4, Age));
            if (!b.Done)
            {
                ComposeSite(b, cx, cz, yaw, seed);
                return;
            }
            var ctx = new Ctx { X = cx, Z = cz, Yaw = yaw, Seed = seed, Tint = tint, Civ = civ.xyz, Era = era, Level = Math.Max(1, b.Level), Tier = b.Tier };
            Stacks.Remove(b.Id);
            composing = b.Id;
            switch (b.Type)
            {
                case "house": House(ctx); break;
                case "town": Centre(ctx); break;
                case "farm": Farm(ctx); break;
                case "barracks": case "fort": case "camp": Base(ctx, b.Type == "fort"); break;
                case "academy": case "university": Campus(ctx, b.Type == "university"); break;
                case "power_plant": Power(ctx, false); break;
                case "fusion_plant": Power(ctx, true); break;
                case "nuclear_plant": Nuclear(ctx); break;
                case "airfield": Airfield(ctx); break;
                case "port": Port(ctx); break;
                case "comms_tower": Mast(ctx); break;
                case "guard_post": case "bunker": case "aa_battery": case "missile_silo": case "shield_generator": Defence(ctx, b.Type); break;
                case "market": case "depot": Warehouses(ctx, b.Type == "market"); break;
                case "mine": case "quarry": case "lumber": case "salvage": case "oil_well": Extraction(ctx, b.Type); break;
                case "wonder": Wonder(ctx); break;
                default: Industry(ctx); break;
            }
        }

        struct Ctx
        {
            public float X, Z, Yaw;
            public int Seed, Era, Level, Tier;
            public float3 Tint, Civ;
        }

        // place a module at local (lx, lz) of the hex in the building's frame, on the ground (sunk a little)
        void Module(in Ctx c, Part part, float lx, float lz, float3 size, float3 color, float yawOffset = 0, float lift = 0, float emission = 0)
        {
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * cs + lz * sn, z = c.Z - lx * sn + lz * cs;
            float y = Mathf.Min(Ground(x, z), Mathf.Min(Ground(x + size.x * 0.4f, z), Ground(x, z + size.z * 0.4f))) - 0.02f;
            Put(part, new float3(x, y + lift, z), c.Yaw + yawOffset, size, color * c.Tint, emission);
        }

        /// <summary>Record a smoke source at local (lx, lz), height h above the ground, for the building being composed.</summary>
        void Stack(in Ctx c, float lx, float lz, float h, bool steam, float size)
        {
            if (composing < 0) return;
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * cs + lz * sn, z = c.Z - lx * sn + lz * cs;
            if (!Stacks.TryGetValue(composing, out var list)) Stacks[composing] = list = new List<SmokeStack>(2);
            list.Add(new SmokeStack { Pos = new float3(x, Ground(x, z) - 0.02f + h, z), Steam = steam, Size = size });
        }

        /// <summary>A module with pitch and roll as well as heading (hoop greenhouses, turbine blades).</summary>
        void ModuleRot(in Ctx c, Part part, float lx, float lz, float3 size, float3 color, float pitch, float roll, float yawOffset = 0, float lift = 0)
        {
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * cs + lz * sn, z = c.Z - lx * sn + lz * cs;
            PutRot(part, new float3(x, Ground(x, z) - 0.02f + lift, z), quaternion.EulerZXY(pitch, MapSpace.Yaw(c.Yaw + yawOffset), roll), size, color * c.Tint);
        }

        // ---- the salvage palette of the Reclamation era: tarps, corrugated sheet, shipping containers
        static float3 Tarp(int seed)
        {
            float h = Hash(seed, 31);
            return h < 0.35f ? new float3(0.2f, 0.4f, 0.62f) : h < 0.6f ? new float3(0.74f, 0.42f, 0.16f) : h < 0.82f ? new float3(0.32f, 0.46f, 0.26f) : new float3(0.7f, 0.7f, 0.66f);
        }
        static float3 Sheet(int seed)
        {
            float h = Hash(seed, 32);
            return h < 0.4f ? new float3(0.5f, 0.33f, 0.22f) : h < 0.7f ? new float3(0.56f, 0.57f, 0.56f) : h < 0.85f ? new float3(0.38f, 0.46f, 0.38f) : new float3(0.36f, 0.43f, 0.52f);
        }
        static float3 Container(int seed)
        {
            float h = Hash(seed, 33);
            return h < 0.25f ? new float3(0.56f, 0.22f, 0.15f) : h < 0.45f ? new float3(0.2f, 0.33f, 0.52f) : h < 0.6f ? new float3(0.26f, 0.42f, 0.3f)
                 : h < 0.75f ? new float3(0.72f, 0.42f, 0.14f) : h < 0.9f ? new float3(0.5f, 0.5f, 0.48f) : new float3(0.2f, 0.45f, 0.45f);
        }
        static float3 Timber(int seed) => math.lerp(new float3(0.42f, 0.32f, 0.22f), new float3(0.55f, 0.45f, 0.32f), Hash(seed, 34));
        // ---- a colour language per kind of building, readable at a glance
        static readonly float3 Copper = new float3(0.33f, 0.52f, 0.46f);       // civic roofs and domes
        static readonly float3 Terracotta = new float3(0.62f, 0.3f, 0.2f);     // homes
        static readonly float3 Olive = new float3(0.36f, 0.39f, 0.26f);        // the military
        static readonly float3 Hazard = new float3(0.86f, 0.66f, 0.12f);       // power and heavy plant
        static float3 Rust(int seed) => math.lerp(new float3(0.46f, 0.3f, 0.21f), new float3(0.55f, 0.4f, 0.28f), Hash(seed, 35));   // industry
        static float3 Stucco(int seed) => math.lerp(new float3(0.82f, 0.74f, 0.6f), new float3(0.88f, 0.8f, 0.68f), Hash(seed, 36));   // homes

        /// <summary>A curved roof (hangar, warehouse): a cylinder on its side, its axis along the building, half above the walls.</summary>
        void BarrelRoof(in Ctx c, float lx, float lz, float length, float depth, float wallHeight, float3 color)
        {
            // two halves from the middle, so the result is centred whichever way the roll turns
            ModuleRot(c, Part.Cylinder, lx, lz, new float3(depth * 0.6f, length * 0.5f, depth), color, 0, Mathf.PI * 0.5f, 0, wallHeight);
            ModuleRot(c, Part.Cylinder, lx, lz, new float3(depth * 0.6f, length * 0.5f, depth), color, 0, -Mathf.PI * 0.5f, 0, wallHeight);
        }

        void Flag(in Ctx c, float lx, float lz, float h)
        {
            Module(c, Part.Cylinder, lx, lz, new float3(0.012f, h, 0.012f), new float3(0.6f, 0.6f, 0.6f));
            Module(c, Part.Box, lx + 0.05f, lz, new float3(0.1f, 0.06f, 0.006f), c.Civ, 0, h - 0.07f, 0.15f);
        }

        void Shack(in Ctx c, float lx, float lz, float rot, int seed)
        {
            // salvaged walls, a sheet or tarp roof, sometimes a lean-to and a rain barrel
            float w = 0.13f + Hash(seed, 1) * 0.06f, h = 0.08f + Hash(seed, 2) * 0.03f;
            Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.8f), Hash(seed, 3) < 0.5f ? Timber(seed) : Sheet(seed + 7), rot);
            Module(c, Part.Box, lx, lz, new float3(w * 1.15f, 0.012f, w * 0.95f), Hash(seed, 4) < 0.55f ? Tarp(seed) : Sheet(seed), rot + (Hash(seed, 5) - 0.5f) * 0.2f, h);
            if (Hash(seed, 6) < 0.4f) Module(c, Part.Cylinder, lx + w * 0.6f, lz, new float3(0.035f, 0.05f, 0.035f), new float3(0.3f, 0.36f, 0.42f));
        }

        void ContainerHome(in Ctx c, float lx, float lz, float rot, int seed, int stack)
        {
            for (int s = 0; s < stack; s++)
                Module(c, Part.Box, lx, lz, new float3(0.24f, 0.075f, 0.09f), Container(seed + s * 3), rot + s * (Hash(seed, 8) - 0.5f) * 0.6f, s * 0.075f);
            if (Hash(seed, 9) < 0.5f) Module(c, Part.Box, lx, lz + 0.07f, new float3(0.2f, 0.008f, 0.08f), Tarp(seed), rot, 0.06f + (stack - 1) * 0.075f);   // an awning
        }

        void WaterTower(in Ctx c, float lx, float lz, int seed)
        {
            for (int k = 0; k < 4; k++) Module(c, Part.Cylinder, lx + (k % 2 == 0 ? -0.04f : 0.04f), lz + (k < 2 ? -0.04f : 0.04f), new float3(0.01f, 0.2f, 0.01f), Timber(seed));
            Module(c, Part.Cylinder, lx, lz, new float3(0.13f, 0.1f, 0.13f), Hash(seed, 3) < 0.5f ? new float3(0.32f, 0.4f, 0.48f) : Sheet(seed), 0, 0.2f);
        }

        void WindTurbine(in Ctx c, float lx, float lz, float h, int seed)
        {
            Module(c, Part.Cylinder, lx, lz, new float3(0.022f, h, 0.022f), new float3(0.82f, 0.82f, 0.8f));
            Module(c, Part.Box, lx, lz, new float3(0.035f, 0.03f, 0.07f), new float3(0.8f, 0.8f, 0.78f), 0.6f, h);
            float phase = Hash(seed, 4) * 2.1f;
            for (int k = 0; k < 3; k++)
                ModuleRot(c, Part.Box, lx, lz, new float3(0.012f, h * 0.42f, 0.004f), new float3(0.9f, 0.9f, 0.88f), 0, phase + k * 2.0944f, 0.6f, h + 0.015f);
        }

        static float3 Brick(int seed) => math.lerp(new float3(0.55f, 0.36f, 0.28f), new float3(0.68f, 0.56f, 0.44f), Hash(seed, 9));
        static float3 Concrete(int seed) => math.lerp(new float3(0.58f, 0.57f, 0.55f), new float3(0.72f, 0.7f, 0.66f), Hash(seed, 10));
        static float3 RoofTone(int seed) => math.lerp(new float3(0.36f, 0.2f, 0.16f), new float3(0.3f, 0.32f, 0.34f), Hash(seed, 11));

        static float3 HomeRoof(int seed) => math.lerp(Terracotta, new float3(0.5f, 0.24f, 0.18f), Hash(seed, 37));

        void House(in Ctx c)
        {
            if (c.Era == 0) { RecoveringHomes(c); return; }
            if (c.Level >= 3)
            {
                if (c.Era >= 3)
                {
                    // late eras: residential towers, much taller than the blocks they replace; warm
                    // facades and roof gardens set them apart from the glass offices downtown
                    int towers = 2 + (int)(Hash(c.Seed, 1) * 2);
                    for (int k = 0; k < towers; k++)
                    {
                        float a = k * 6.283f / towers + Hash(c.Seed, k) * 0.5f;
                        float h = 0.9f + Hash(c.Seed, 20 + k) * 0.9f + (c.Era - 3) * 0.6f;
                        float lx = Mathf.Cos(a) * 0.42f, lz = Mathf.Sin(a) * 0.42f;
                        Module(c, Part.Skyscraper, lx, lz, new float3(0.34f, h, 0.34f), math.lerp(Stucco(c.Seed + k), new float3(0.72f, 0.55f, 0.42f), Hash(c.Seed, 40 + k) * 0.6f));
                        Module(c, Part.Box, lx, lz, new float3(0.26f, 0.025f, 0.26f), new float3(0.3f, 0.46f, 0.24f), 0, h);
                    }
                    Module(c, Part.Box, 0, 0, new float3(0.6f, 0.012f, 0.6f), new float3(0.34f, 0.46f, 0.28f));   // a shared garden
                    return;
                }
                // an apartment complex: three or four large blocks around a courtyard
                int blocks = 3 + (int)(Hash(c.Seed, 2) * 2);
                for (int k = 0; k < blocks; k++)
                {
                    float a = k * 6.283f / blocks;
                    float h = 0.36f + Hash(c.Seed, 30 + k) * 0.22f + c.Era * 0.06f;
                    float3 col = c.Era >= 2 ? Stucco(c.Seed + k) * math.lerp(new float3(1f), new float3(1f, 0.9f, 0.84f), Hash(c.Seed, 50 + k)) : Brick(c.Seed + k);
                    Module(c, Part.Box, Mathf.Cos(a) * 0.48f, Mathf.Sin(a) * 0.48f, new float3(0.62f, h, 0.3f), col, a + Mathf.PI * 0.5f);
                    Module(c, Part.Roof, Mathf.Cos(a) * 0.48f, Mathf.Sin(a) * 0.48f, new float3(0.64f, 0.08f, 0.32f), HomeRoof(c.Seed + k), a + Mathf.PI * 0.5f, h);
                }
                Module(c, Part.Cone, 0, 0, new float3(0.16f, 0.2f, 0.16f), new float3(0.26f, 0.4f, 0.2f));   // a courtyard tree
                return;
            }
            if (c.Level == 2)
            {
                // terraced rows along the street, each house a slightly different height and colour
                for (int row = 0; row < 2; row++)
                {
                    float z = row == 0 ? -0.32f : 0.32f;
                    for (int u = 0; u < 4; u++)
                    {
                        float h = 0.18f + Hash(c.Seed, row * 8 + u) * 0.07f;
                        float x = -0.36f + u * 0.24f;
                        Module(c, Part.Box, x, z, new float3(0.23f, h, 0.24f), c.Era >= 2 ? Stucco(c.Seed + row * 8 + u) : Brick(c.Seed + row * 8 + u));
                        Module(c, Part.Roof, x, z, new float3(0.24f, 0.09f, 0.26f), HomeRoof(c.Seed + row * 8 + u), 0, h);
                    }
                }
                return;
            }
            // cottages: three to five, irregularly set, with gardens
            int n = 3 + (int)(Hash(c.Seed, 5) * 3);
            for (int k = 0; k < n; k++)
            {
                float a = Hash(c.Seed, 40 + k) * 6.283f, r = 0.25f + Hash(c.Seed, 50 + k) * 0.45f;
                float w = 0.16f + Hash(c.Seed, 60 + k) * 0.06f, h = 0.11f + Hash(c.Seed, 70 + k) * 0.04f;
                float rot = Hash(c.Seed, 80 + k) < 0.5f ? 0 : Mathf.PI * 0.5f;
                Module(c, Part.Box, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(w, h, w * 0.8f), Hash(c.Seed, 90 + k) < 0.5f ? Brick(c.Seed + k) : Stucco(c.Seed + k), rot);
                Module(c, Part.Roof, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(w * 1.08f, 0.08f, w * 0.86f), HomeRoof(c.Seed + k), rot, h);
                if (Hash(c.Seed, 100 + k) < 0.5f) Module(c, Part.Cone, Mathf.Cos(a) * r + 0.14f, Mathf.Sin(a) * r, new float3(0.09f, 0.12f, 0.09f), new float3(0.26f, 0.4f, 0.2f));
            }
        }

        /// <summary>
        /// The Reclamation era: survivors living in what they can salvage. Shacks of timber and sheet
        /// under tarps, shipping containers made into homes (stacked as the settlement densifies), a
        /// reoccupied old-world shell, water towers and vegetable plots.
        /// </summary>
        void RecoveringHomes(in Ctx c)
        {
            if (c.Level >= 2)
            {
                // a gutted old-world block brought back into use: its shell patched with tarps and sheet
                Module(c, Part.Broken, -0.15f, -0.1f, new float3(0.5f, 0.3f + c.Level * 0.08f, 0.36f), new float3(0.58f, 0.56f, 0.52f));
                for (int k = 0; k < 3; k++)
                    Module(c, Part.Box, -0.15f + (k - 1) * 0.14f, -0.1f + 0.19f, new float3(0.12f, 0.1f, 0.01f), Tarp(c.Seed + k), 0, 0.06f + k * 0.07f);
                int stacks = c.Level >= 3 ? 3 : 2;
                for (int k = 0; k < stacks; k++)
                    ContainerHome(c, 0.42f, -0.4f + k * 0.3f, Mathf.PI * 0.5f + (Hash(c.Seed, 60 + k) - 0.5f) * 0.3f, c.Seed + 11 * k, c.Level >= 3 ? 2 : 1 + (int)(Hash(c.Seed, 70 + k) * 2));
                Shack(c, -0.45f, 0.42f, 0.2f, c.Seed + 5);
                WaterTower(c, 0.1f, 0.45f, c.Seed);
                return;
            }
            int n = 3 + (int)(Hash(c.Seed, 5) * 3);
            for (int k = 0; k < n; k++)
            {
                float a = Hash(c.Seed, 40 + k) * 6.283f, r = 0.22f + Hash(c.Seed, 50 + k) * 0.45f;
                float rot = (Hash(c.Seed, 80 + k) - 0.5f) * 1.2f;
                if (Hash(c.Seed, 85 + k) < 0.35f) ContainerHome(c, Mathf.Cos(a) * r, Mathf.Sin(a) * r, rot, c.Seed + k * 13, 1);
                else Shack(c, Mathf.Cos(a) * r, Mathf.Sin(a) * r, rot, c.Seed + k * 13);
            }
            // a vegetable plot and the settlement's water
            Module(c, Part.Box, 0.1f, 0.05f, new float3(0.28f, 0.015f, 0.18f), new float3(0.36f, 0.42f, 0.22f), Hash(c.Seed, 6));
            if (Hash(c.Seed, 7) < 0.6f) WaterTower(c, -0.1f, -0.2f, c.Seed);
        }

        void Centre(in Ctx c)
        {
            if (c.Era == 0)
            {
                // the first town hall is an old-world building reclaimed: a patched concrete shell with
                // a radio mast and the flag, a market of tarp stalls in its forecourt, and the water tower
                Module(c, Part.Box, 0, 0.1f, new float3(1.1f, 0.012f, 0.9f), new float3(0.5f, 0.47f, 0.42f));
                Module(c, Part.Broken, 0, -0.32f, new float3(0.7f, 0.42f, 0.4f), new float3(0.62f, 0.6f, 0.56f));
                Module(c, Part.Box, 0, -0.32f, new float3(0.6f, 0.015f, 0.36f), Tarp(c.Seed), 0.05f, 0.3f);
                Module(c, Part.Box, 0.32f, -0.42f, new float3(0.015f, 0.85f, 0.015f), new float3(0.55f, 0.55f, 0.55f));   // radio mast
                Flag(c, -0.42f, 0.0f, 0.55f);
                for (int k = 0; k < 5; k++)
                {
                    float x = -0.4f + k * 0.2f, z = 0.22f + (k % 2) * 0.16f;
                    Module(c, Part.Box, x, z, new float3(0.13f, 0.06f, 0.1f), Timber(c.Seed + k));
                    Module(c, Part.Roof, x, z, new float3(0.16f, 0.05f, 0.13f), Tarp(c.Seed + k * 5), 0, 0.06f);
                }
                WaterTower(c, 0.48f, 0.45f, c.Seed);
                ContainerHome(c, -0.5f, 0.45f, 0.3f, c.Seed + 3, 2);
                return;
            }
            // the civic heart: a plaza, a pale stone hall with a copper-roofed clock tower, the flag,
            // and a skyline that grows with era and tier
            Module(c, Part.Box, 0, 0, new float3(1.3f, 0.03f, 1.3f), new float3(0.66f, 0.63f, 0.58f));
            Module(c, Part.Box, 0, -0.3f, new float3(0.8f, 0.34f, 0.42f), new float3(0.8f, 0.77f, 0.7f));
            Module(c, Part.Roof, 0, -0.3f, new float3(0.82f, 0.1f, 0.44f), Copper, 0, 0.34f);
            Module(c, Part.Box, 0, -0.3f, new float3(0.2f, 0.75f, 0.2f), new float3(0.82f, 0.78f, 0.7f));
            Module(c, Part.Cone, 0, -0.3f, new float3(0.22f, 0.2f, 0.22f), Copper, 0, 0.75f);
            Module(c, Part.Box, 0, -0.19f, new float3(0.1f, 0.1f, 0.01f), new float3(0.95f, 0.9f, 0.75f), 0, 0.55f, 0.6f);   // clock face
            Flag(c, 0.45f, 0.2f, 0.5f);
            Flag(c, -0.45f, 0.2f, 0.5f);
            int towers = c.Era >= 3 ? 5 + c.Tier : c.Era == 2 ? 3 + c.Tier / 2 : 0;
            for (int k = 0; k < towers; k++)
            {
                float a = k * 2.4f + Hash(c.Seed, k);
                float r = 0.45f + Hash(c.Seed, 10 + k) * 0.35f;
                float h = c.Era >= 3 ? 1.4f + Hash(c.Seed, 20 + k) * 1.6f + (c.Era - 3) * 0.9f + c.Tier * 0.2f : 0.6f + Hash(c.Seed, 20 + k) * 0.4f;
                var part = c.Era >= 3 ? Part.Skyscraper : Part.Box;
                Module(c, part, Mathf.Cos(a) * r, Mathf.Sin(a) * r + 0.15f, new float3(0.3f, h, 0.3f), Concrete(c.Seed + k));
            }
            if (c.Era < 2)
            {
                for (int k = 0; k < 4; k++)
                    Module(c, Part.Box, -0.55f + k * 0.37f, 0.45f, new float3(0.3f, 0.24f, 0.26f), Brick(c.Seed + k));
            }
        }

        void Farm(in Ctx c)
        {
            if (c.Era == 0)
            {
                // salvage-era farming: small fenced plots, hoop greenhouses of plastic sheet, a hand pump
                for (int k = 0; k < 3; k++)
                {
                    float3 crop = math.lerp(new float3(0.38f, 0.46f, 0.22f), new float3(0.52f, 0.5f, 0.26f), Hash(c.Seed, k));
                    Module(c, Part.Box, -0.35f + k * 0.3f, -0.35f, new float3(0.24f, 0.02f, 0.3f), crop, (Hash(c.Seed, 10 + k) - 0.5f) * 0.3f);
                }
                for (int k = 0; k < 2; k++)
                    ModuleRot(c, Part.Cylinder, -0.3f + k * 0.38f, 0.25f, new float3(0.2f, 0.36f, 0.2f), new float3(0.86f, 0.9f, 0.88f), 0, Mathf.PI * 0.5f, 0, 0);
                Shack(c, 0.5f, 0.3f, 0.4f, c.Seed + 9);
                WindTurbine(c, 0.5f, -0.1f, 0.32f, c.Seed);
                return;
            }
            // strip fields with varied crops, a barn and a silo; no flat grass pads
            for (int k = 0; k < 4; k++)
            {
                float3 crop = math.lerp(new float3(0.48f, 0.5f, 0.24f), new float3(0.66f, 0.56f, 0.28f), Hash(c.Seed, k));
                Module(c, Part.Box, -0.15f, -0.5f + k * 0.28f, new float3(1.15f, 0.025f, 0.24f), crop);
            }
            Module(c, Part.Box, 0.55f, 0.15f, new float3(0.24f, 0.16f, 0.32f), new float3(0.5f, 0.24f, 0.18f));
            Module(c, Part.Roof, 0.55f, 0.15f, new float3(0.26f, 0.1f, 0.34f), new float3(0.3f, 0.3f, 0.32f), 0, 0.16f);
            Module(c, Part.Silo, 0.62f, -0.2f, new float3(0.12f, 0.3f, 0.12f), new float3(0.7f, 0.7f, 0.68f));
        }

        void Base(in Ctx c, bool fort)
        {
            if (c.Era == 0 && !fort)
            {
                // a militia camp: sandbag walls, olive tents in rows, container stores and a watchtower
                float rr = 0.66f;
                var sand = new float3(0.62f, 0.55f, 0.4f);
                for (int k = 0; k < 4; k++)
                {
                    float a = k * Mathf.PI * 0.5f;
                    Module(c, Part.Box, Mathf.Cos(a) * rr, Mathf.Sin(a) * rr, new float3(0.06f, 0.06f, 0.95f), sand, a);
                }
                for (int k = 0; k < 6; k++)
                    Module(c, Part.Roof, -0.35f + (k % 3) * 0.26f, -0.25f + (k / 3) * 0.3f, new float3(0.2f, 0.12f, 0.15f), Olive * (0.9f + 0.2f * Hash(c.Seed, k)));
                ContainerHome(c, 0.4f, 0.35f, 0, c.Seed + 4, 1);
                ContainerHome(c, 0.4f, 0.12f, 0, c.Seed + 9, 1);
                for (int k = 0; k < 4; k++) Module(c, Part.Cylinder, 0.42f + (k % 2) * 0.08f, -0.4f + (k / 2) * 0.08f, new float3(0.01f, 0.3f, 0.01f), Timber(c.Seed));
                Module(c, Part.Box, 0.46f, -0.36f, new float3(0.14f, 0.07f, 0.14f), Timber(c.Seed + 1), 0, 0.3f);
                Flag(c, -0.5f, 0.45f, 0.5f);
                return;
            }
            // a military compound: perimeter wall with towers, barrack halls in rows, a vehicle park
            float r = fort ? 0.8f : 0.7f, wall = fort ? 0.12f : 0.07f;
            var wc = fort ? new float3(0.5f, 0.49f, 0.46f) : new float3(0.45f, 0.43f, 0.36f);
            Module(c, Part.Box, 0, -r, new float3(2 * r, wall, 0.04f), wc);
            Module(c, Part.Box, 0, r, new float3(2 * r, wall, 0.04f), wc);
            Module(c, Part.Box, -r, 0, new float3(0.04f, wall, 2 * r), wc);
            Module(c, Part.Box, r, 0, new float3(0.04f, wall, 2 * r), wc);
            for (int k = 0; k < 4; k++)
            {
                float sx = k % 2 == 0 ? -r : r, sz = k < 2 ? -r : r;
                Module(c, Part.Box, sx, sz, new float3(0.1f, wall + 0.14f, 0.1f), wc * 0.9f);
            }
            Module(c, Part.Box, 0.25f, 0, new float3(0.62f, 0.012f, 0.9f), new float3(0.46f, 0.44f, 0.4f));   // parade ground
            for (int k = 0; k < 3; k++)
            {
                float z = -0.45f + k * 0.45f;
                var col = Olive * (0.95f + 0.1f * Hash(c.Seed, 40 + k));
                Module(c, Part.Box, -0.38f, z, new float3(0.5f, 0.13f, 0.22f), col);
                Module(c, Part.Roof, -0.38f, z, new float3(0.52f, 0.07f, 0.24f), new float3(0.3f, 0.32f, 0.3f), 0, 0.13f);
            }
            if (c.Era >= 1)
                for (int k = 0; k < 4; k++) Module(c, Part.Box, 0.35f + (k % 2) * 0.2f, 0.4f + (k / 2) * 0.18f, new float3(0.09f, 0.05f, 0.15f), new float3(0.33f, 0.35f, 0.28f));
            Flag(c, 0.55f, -0.5f, 0.45f);
        }

        void Campus(in Ctx c, bool university)
        {
            if (c.Era == 0)
            {
                // a schoolhouse in a salvaged hall: timber and sheet, a tarp over the broken roof, a bell
                Module(c, Part.Box, 0, -0.15f, new float3(0.6f, 0.2f, 0.32f), Timber(c.Seed));
                Module(c, Part.Roof, 0, -0.15f, new float3(0.62f, 0.1f, 0.34f), Sheet(c.Seed), 0, 0.2f);
                Module(c, Part.Box, 0.12f, -0.15f, new float3(0.22f, 0.012f, 0.3f), Tarp(c.Seed), 0.1f, 0.27f);
                Module(c, Part.Box, -0.24f, -0.15f, new float3(0.08f, 0.38f, 0.08f), Timber(c.Seed + 2));
                Module(c, Part.Cone, -0.24f, -0.15f, new float3(0.1f, 0.08f, 0.1f), Copper, 0, 0.38f);
                Module(c, Part.Box, 0, 0.3f, new float3(0.6f, 0.01f, 0.3f), new float3(0.5f, 0.47f, 0.4f));   // the yard
                Flag(c, 0.35f, 0.35f, 0.4f);
                return;
            }
            // civic language: pale stone, copper roofs, a dome or bell tower
            Module(c, Part.Box, 0, -0.3f, new float3(0.9f, 0.26f, 0.32f), new float3(0.8f, 0.76f, 0.68f));
            Module(c, Part.Roof, 0, -0.3f, new float3(0.92f, 0.1f, 0.34f), Copper, 0, 0.26f);
            if (university) Module(c, Part.Dome, 0, -0.3f, new float3(0.26f, 0.22f, 0.26f), Copper, 0, 0.32f);
            for (int k = 0; k < 5; k++) Module(c, Part.Cylinder, -0.32f + k * 0.16f, -0.1f, new float3(0.035f, 0.24f, 0.035f), new float3(0.82f, 0.8f, 0.76f));
            Module(c, Part.Box, -0.5f, 0.35f, new float3(0.3f, 0.2f, 0.45f), new float3(0.66f, 0.6f, 0.52f));
            Module(c, Part.Box, 0.5f, 0.35f, new float3(0.3f, university ? 0.32f : 0.2f, 0.45f), new float3(0.66f, 0.6f, 0.52f));
            if (university)
            {
                Module(c, Part.Box, 0, 0.55f, new float3(0.14f, 0.7f, 0.14f), new float3(0.7f, 0.66f, 0.6f));
                Module(c, Part.Cone, 0, 0.55f, new float3(0.18f, 0.2f, 0.18f), Copper, 0, 0.7f);
            }
            // paved paths across the quad instead of a mismatched lawn
            Module(c, Part.Box, 0, 0.2f, new float3(0.1f, 0.012f, 0.6f), new float3(0.6f, 0.58f, 0.54f));
        }

        void Industry(in Ctx c)
        {
            if (c.Era == 0)
            {
                // an open-sided workshop under a sheet roof on posts, scrap heaps, a container store
                for (int k = 0; k < 6; k++) Module(c, Part.Cylinder, -0.4f + (k % 3) * 0.3f, -0.3f + (k / 3) * 0.36f, new float3(0.02f, 0.18f, 0.02f), Timber(c.Seed + k));
                Module(c, Part.Box, -0.1f, -0.12f, new float3(0.7f, 0.015f, 0.46f), Sheet(c.Seed), 0.04f, 0.18f);
                Module(c, Part.Box, -0.1f, -0.12f, new float3(0.3f, 0.07f, 0.16f), new float3(0.36f, 0.34f, 0.32f));   // a lathe or forge
                for (int k = 0; k < 3; k++) Module(c, Part.Cone, 0.25f + k * 0.15f, 0.42f, new float3(0.18f, 0.1f + Hash(c.Seed, k) * 0.05f, 0.18f), Rust(c.Seed + k));
                ContainerHome(c, -0.4f, 0.42f, 0.2f, c.Seed + 6, 1);
                Module(c, Part.Chimney, 0.45f, -0.4f, new float3(0.05f, 0.35f, 0.05f), new float3(0.4f, 0.35f, 0.3f));
                Stack(c, 0.45f, -0.4f, 0.35f, false, 0.2f);
                return;
            }
            // industrial language: rust-red sheet and brick, dark roofs with skylights, stacks
            var wallColor = c.Era >= 2 ? Rust(c.Seed) : Brick(c.Seed) * new float3(0.95f, 0.85f, 0.8f);
            int sheds = 2 + (int)(Hash(c.Seed, 1) * 2);
            for (int k = 0; k < sheds; k++)
            {
                float z = -0.45f + k * 0.42f;
                Module(c, Part.Box, -0.15f, z, new float3(0.9f, 0.24f + c.Era * 0.03f, 0.34f), wallColor);
                // sawtooth roof
                for (int t = 0; t < 4; t++) Module(c, Part.Roof, -0.5f + t * 0.24f, z, new float3(0.24f, 0.08f, 0.34f), t % 2 == 0 ? new float3(0.26f, 0.26f, 0.28f) : new float3(0.4f, 0.48f, 0.55f), Mathf.PI * 0.5f, 0.24f + c.Era * 0.03f);
            }
            int stacks = 1 + (int)(Hash(c.Seed, 2) * 3);
            for (int k = 0; k < stacks; k++)
            {
                float sh = 0.7f + Hash(c.Seed, k) * 0.3f;
                Module(c, Part.Chimney, 0.5f, -0.4f + k * 0.25f, new float3(0.08f, sh, 0.08f), new float3(0.48f, 0.4f, 0.36f));
                Stack(c, 0.5f, -0.4f + k * 0.25f, sh, false, 0.3f);
            }
            Module(c, Part.Silo, 0.55f, 0.45f, new float3(0.16f, 0.26f, 0.16f), new float3(0.62f, 0.62f, 0.6f));
            Module(c, Part.Box, 0.2f, 0.55f, new float3(0.5f, 0.012f, 0.3f), new float3(0.4f, 0.39f, 0.37f));
        }

        void Power(in Ctx c, bool fusion)
        {
            if (fusion)
            {
                Module(c, Part.Cylinder, 0, 0, new float3(0.8f, 0.3f, 0.8f), new float3(0.78f, 0.8f, 0.82f));
                Module(c, Part.Cone, 0, 0, new float3(0.8f, 0.35f, 0.8f), new float3(0.82f, 0.86f, 0.9f), 0, 0.3f);
                Module(c, Part.Cylinder, 0, 0, new float3(0.86f, 0.03f, 0.86f), new float3(0.3f, 0.7f, 1f), 0, 0.22f, 1.2f);
                return;
            }
            if (c.Era == 0)
            {
                // salvaged power: a row of small wind turbines and a diesel generator in a container
                for (int k = 0; k < 3; k++) WindTurbine(c, -0.45f + k * 0.42f, -0.3f + (k % 2) * 0.2f, 0.42f + Hash(c.Seed, k) * 0.1f, c.Seed + k);
                ContainerHome(c, 0.2f, 0.4f, 0, c.Seed + 2, 1);
                Module(c, Part.Box, -0.3f, 0.42f, new float3(0.12f, 0.12f, 0.12f), Hazard);   // the transformer
                Module(c, Part.Chimney, 0.32f, 0.4f, new float3(0.025f, 0.16f, 0.025f), new float3(0.3f, 0.3f, 0.3f));
                Stack(c, 0.32f, 0.4f, 0.16f, false, 0.15f);
                return;
            }
            // power language: concrete hall, cooling towers, hazard-yellow transformers and pylons
            Module(c, Part.Box, -0.3f, 0, new float3(0.6f, 0.32f, 0.5f), Concrete(c.Seed));
            Module(c, Part.Box, -0.3f, 0.29f, new float3(0.6f, 0.04f, 0.02f), Hazard, 0, 0.26f);
            Module(c, Part.Box, -0.1f, 0.45f, new float3(0.1f, 0.1f, 0.1f), Hazard);
            Module(c, Part.Box, -0.45f, 0.45f, new float3(0.1f, 0.1f, 0.1f), Hazard);
            Module(c, Part.Box, 0.1f, 0.62f, new float3(0.03f, 0.4f, 0.03f), new float3(0.55f, 0.55f, 0.58f));   // a pylon
            Module(c, Part.Box, 0.1f, 0.62f, new float3(0.2f, 0.02f, 0.02f), new float3(0.55f, 0.55f, 0.58f), 0, 0.36f);
            Module(c, Part.Cylinder, 0.45f, -0.35f, new float3(0.42f, 0.55f, 0.42f), new float3(0.7f, 0.69f, 0.66f));
            Module(c, Part.Cylinder, 0.45f, 0.35f, new float3(0.42f, 0.55f, 0.42f), new float3(0.7f, 0.69f, 0.66f));
            Module(c, Part.Chimney, -0.5f, 0.35f, new float3(0.09f, 0.9f, 0.09f), new float3(0.52f, 0.42f, 0.38f));
            Stack(c, -0.5f, 0.35f, 0.9f, c.Era >= 2, 0.3f);
            Stack(c, 0.45f, -0.35f, 0.55f, true, 0.3f);
        }

        void Nuclear(in Ctx c)
        {
            // two great cooling towers (waisted: a wide base, a narrow throat, a flared lip) and a
            // containment dome beside the turbine hall
            var tower = new float3(0.74f, 0.73f, 0.7f);
            for (int k = 0; k < 2; k++)
            {
                float lx = 0.38f, lz = k == 0 ? -0.36f : 0.36f;
                Module(c, Part.Cone, lx, lz, new float3(0.62f, 0.5f, 0.62f), tower);
                Module(c, Part.Cylinder, lx, lz, new float3(0.36f, 0.32f, 0.36f), tower * 0.97f, 0, 0.38f);
                Module(c, Part.Cylinder, lx, lz, new float3(0.44f, 0.06f, 0.44f), tower * 0.92f, 0, 0.7f);
                Stack(c, lx, lz, 0.78f, true, 0.45f);
            }
            Module(c, Part.Cylinder, -0.38f, -0.15f, new float3(0.42f, 0.22f, 0.42f), new float3(0.82f, 0.8f, 0.76f));
            Module(c, Part.Dome, -0.38f, -0.15f, new float3(0.42f, 0.24f, 0.42f), new float3(0.84f, 0.82f, 0.78f), 0, 0.22f);
            Module(c, Part.Box, -0.42f, 0.4f, new float3(0.5f, 0.2f, 0.3f), Concrete(c.Seed));
            Module(c, Part.Box, 0, 0.62f, new float3(1.3f, 0.06f, 0.03f), new float3(0.62f, 0.62f, 0.6f));   // security fence
        }

        // ------------------------------------------------------------------ developed blocks
        // A district hex the server has developed but holds no building of its own: buildings fill the
        // wedges between its streets, facing them, with heights from the era and how central the block
        // is (urban neighbours). A few blocks become parks or plazas, so a city reads as grown, not stamped.
        void Infill(int t)
        {
            var g = world.Grid;
            float cx = g.CenterX(t), cz = g.CenterZ(t);
            int seed = t * 131 + Seed;
            int urbanNb = 0, roads = 0;
            for (int d = 0; d < 6; d++)
            {
                int n = g.Nb[t * 6 + d];
                if (n >= 0 && (world.IsUrban(n) || hasBuildingAt(n))) urbanNb++;
                if (world.RoadClass(t, d) != 0) roads++;
            }
            int era = Math.Max(0, Math.Min(4, Age));
            float centrality = urbanNb / 6f;
            float roll = Hash(seed, 1);
            var c = new Ctx { X = cx, Z = cz, Yaw = 0, Seed = seed, Tint = new float3(1), Civ = CivColor(world.Owner[t]).xyz, Era = era, Level = 1 };
            if (roll < 0.1f && urbanNb >= 3) { Park(c); return; }
            if (roll < 0.15f && urbanNb >= 5 && era >= 1) { Plaza(c); return; }
            // where this hex's streets run (they meet off-centre), so blocks keep clear of them
            int streetPts = 0;
            float2* pts = stackalloc float2[30];
            if (world.Road[t] != 0)
            {
                float2 node = RoadCurve.Node(world, t);
                for (int d = 0; d < 6; d++)
                {
                    if (world.RoadClass(t, d) == 0) continue;
                    float2 m = RoadCurve.Mid(world, t, d), ctl = RoadCurve.HalfControl(world, t, d, node);
                    for (int s = 0; s < 5; s++) pts[streetPts++] = RoadCurve.Bezier(m, ctl, node, s / 4f, out _) - new float2(cx, cz);
                }
            }
            // blocks vary in how far they sit from the centre and how many there are, so no two
            // neighbourhoods share a footprint
            int slots = 4 + (int)(Hash(seed, 9) * 3);
            float spin = Hash(seed, 8) * 1.0472f - 0.5236f;
            for (int k = 0; k < slots; k++)
            {
                float a = (k * 360f / slots + 30f) * Mathf.Deg2Rad + spin + (Hash(seed, 15 + k) - 0.5f) * 0.4f;
                // the two street directions either side of this lot (edge d points at d·60° as (cos, −sin))
                int left = HexMath.PosMod((int)Mathf.Floor(a * Mathf.Rad2Deg / 60f), 6), right = (left + 1) % 6;
                bool streetSide = world.RoadClass(t, left) != 0 || world.RoadClass(t, right) != 0;
                if (Hash(seed, 10 + k) < 0.12f) continue;   // the odd empty lot
                float r = 0.48f + (Hash(seed, 20 + k) - 0.5f) * 0.16f;
                float lx = Mathf.Cos(a) * r, lz = -Mathf.Sin(a) * r;
                // keep clear of the streets: step outward, or leave the lot empty
                bool clear = false;
                for (int tries = 0; tries < 3 && !clear; tries++)
                {
                    clear = true;
                    for (int s = 0; s < streetPts && clear; s++) if (math.distancesq(pts[s], new float2(lx, lz)) < 0.2f * 0.2f) clear = false;
                    if (!clear) { r += 0.1f; lx = Mathf.Cos(a) * r; lz = -Mathf.Sin(a) * r; }
                }
                if (!clear || r > 0.75f) continue;
                // face the nearer street
                int faceDir = world.RoadClass(t, left) != 0 ? left : right;
                float face = Mathf.Atan2(HexMath.DirX[faceDir], HexMath.DirZ[faceDir]);
                float jitter = (Hash(seed, 30 + k) - 0.5f) * 0.25f;
                Block(c, lx, lz, face + jitter, centrality, streetSide, seed + k * 17);
                // the inner ring on dense blocks
                if (centrality > 0.6f && Hash(seed, 40 + k) < 0.5f)
                    Block(c, lx * 0.45f, lz * 0.45f, face + jitter, centrality * 0.85f, false, seed + k * 29);
            }
        }

        void Block(in Ctx c, float lx, float lz, float face, float centrality, bool streetSide, int seed)
        {
            float h01 = Hash(seed, 2);
            switch (c.Era)
            {
                case 0:
                    // the Reclamation: shacks and container homes
                    if (h01 < 0.35f) ContainerHome(c, lx, lz, face, seed, centrality > 0.6f ? 2 : 1);
                    else Shack(c, lx, lz, face, seed);
                    break;
                case 1:
                {
                    float w = 0.2f + h01 * 0.06f, h = 0.16f + centrality * 0.14f + Hash(seed, 3) * 0.06f;
                    Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.75f), Hash(seed, 4) < 0.6f ? Brick(seed) : Stucco(seed), face);
                    Module(c, Part.Roof, lx, lz, new float3(w * 1.05f, 0.08f, w * 0.8f), HomeRoof(seed), face, h);
                    break;
                }
                case 2:
                {
                    float w = 0.24f + h01 * 0.06f, h = 0.22f + centrality * 0.3f + Hash(seed, 3) * 0.1f;
                    Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.7f), Hash(seed, 5) < 0.4f ? Brick(seed) : Concrete(seed), face);
                    if (streetSide && Hash(seed, 6) < 0.5f) Module(c, Part.Box, lx, lz, new float3(w * 1.02f, 0.035f, w * 0.72f), new float3(0.55f, 0.42f, 0.3f), face, 0, 0.15f);   // lit shopfronts
                    break;
                }
                default:
                {
                    // late eras: glass towers downtown, mid-rise around them
                    bool tower = centrality > 0.65f && Hash(seed, 7) < 0.55f;
                    float w = tower ? 0.22f + h01 * 0.06f : 0.26f + h01 * 0.06f;
                    float h = tower ? 0.9f + centrality * 0.9f + Hash(seed, 3) * 0.8f + (c.Era - 3) * 0.5f : 0.3f + centrality * 0.35f + Hash(seed, 3) * 0.15f;
                    var col = tower ? math.lerp(new float3(0.5f, 0.6f, 0.68f), new float3(0.72f, 0.74f, 0.72f), Hash(seed, 8)) : Concrete(seed);
                    Module(c, tower ? Part.Skyscraper : Part.Box, lx, lz, new float3(w, h, w), col, face);
                    if (!tower && streetSide) Module(c, Part.Box, lx, lz, new float3(w * 1.02f, 0.04f, w * 1.02f), new float3(0.6f, 0.5f, 0.36f), face, 0, 0.25f);
                    break;
                }
            }
        }

        void Park(in Ctx c)
        {
            Module(c, Part.Box, 0, 0, new float3(0.06f, 0.008f, 0.9f), new float3(0.6f, 0.57f, 0.5f), Hash(c.Seed, 3) * 3f);   // a path
            int trees = 6 + (int)(Hash(c.Seed, 4) * 5);
            for (int k = 0; k < trees; k++)
            {
                float a = Hash(c.Seed, 50 + k) * 6.28f, r = 0.15f + Hash(c.Seed, 60 + k) * 0.5f;
                float s = 0.08f + Hash(c.Seed, 70 + k) * 0.05f;
                float lx = Mathf.Cos(a) * r, lz = Mathf.Sin(a) * r;
                Module(c, Part.Cylinder, lx, lz, new float3(0.014f, s, 0.014f), new float3(0.35f, 0.28f, 0.2f));
                Module(c, Part.Cone, lx, lz, new float3(s * 1.5f, s * 1.7f, s * 1.5f), math.lerp(new float3(0.2f, 0.34f, 0.15f), new float3(0.34f, 0.44f, 0.2f), Hash(c.Seed, 80 + k)), a, s * 0.6f);
            }
            if (c.Era >= 1) Module(c, Part.Cylinder, 0.2f, -0.15f, new float3(0.14f, 0.03f, 0.14f), new float3(0.45f, 0.6f, 0.7f));   // a pond or fountain
        }

        void Plaza(in Ctx c)
        {
            Module(c, Part.Box, 0, 0, new float3(0.8f, 0.012f, 0.8f), new float3(0.64f, 0.61f, 0.56f), 0.4f);
            Module(c, Part.Cylinder, 0, 0, new float3(0.1f, 0.25f, 0.1f), new float3(0.7f, 0.68f, 0.62f));
            Module(c, Part.Box, 0, 0, new float3(0.06f, 0.08f, 0.06f), new float3(0.45f, 0.5f, 0.48f), 0, 0, 0.25f);
            for (int k = 0; k < 4; k++)
            {
                float a = k * 1.571f + 0.4f;
                Module(c, Part.Cone, Mathf.Cos(a) * 0.32f, Mathf.Sin(a) * 0.32f, new float3(0.12f, 0.14f, 0.12f), new float3(0.26f, 0.38f, 0.18f), a, 0.05f);
            }
        }

        void Airfield(in Ctx c)
        {
            Module(c, Part.Box, 0, 0, new float3(0.26f, 0.012f, 1.6f), new float3(0.22f, 0.22f, 0.24f));
            for (int k = 0; k < 6; k++) Module(c, Part.Box, 0, -0.65f + k * 0.26f, new float3(0.02f, 0.014f, 0.1f), new float3(0.9f, 0.9f, 0.85f));
            Module(c, Part.Box, 0.55f, -0.3f, new float3(0.36f, 0.2f, 0.4f), new float3(0.5f, 0.52f, 0.5f));
            BarrelRoof(c, 0.55f, -0.3f, 0.4f, 0.36f, 0.2f, new float3(0.46f, 0.48f, 0.46f));
            Module(c, Part.Box, -0.5f, 0.4f, new float3(0.1f, 0.4f, 0.1f), Concrete(c.Seed));
            Module(c, Part.Box, -0.5f, 0.4f, new float3(0.16f, 0.08f, 0.16f), new float3(0.4f, 0.5f, 0.56f), 0, 0.4f);
        }

        void Port(in Ctx c)
        {
            for (int k = 0; k < 3; k++) Module(c, Part.Box, -0.4f + k * 0.4f, 0.55f, new float3(0.1f, 0.05f, 0.7f), new float3(0.44f, 0.38f, 0.3f), 0, 0.02f);
            Module(c, Part.Box, 0, -0.3f, new float3(0.9f, 0.2f, 0.36f), Brick(c.Seed));
            Module(c, Part.Crane, 0.35f, 0.3f, new float3(0.5f, 0.6f, 0.5f), new float3(1, 1, 1));
            Module(c, Part.Crane, -0.35f, 0.3f, new float3(0.5f, 0.55f, 0.5f), new float3(1, 1, 1), 1.2f);
        }

        void Mast(in Ctx c)
        {
            Module(c, Part.Box, 0, 0, new float3(0.07f, 1.4f, 0.07f), new float3(0.7f, 0.3f, 0.26f));
            Module(c, Part.Cylinder, 0, 0, new float3(0.2f, 0.05f, 0.2f), new float3(0.8f, 0.8f, 0.8f), 0, 1.1f);
            Module(c, Part.Box, 0.3f, 0.2f, new float3(0.3f, 0.15f, 0.24f), Concrete(c.Seed));
        }

        void Defence(in Ctx c, string type)
        {
            var conc = new float3(0.5f, 0.5f, 0.47f);
            switch (type)
            {
                case "guard_post":
                    Module(c, Part.Box, 0, 0, new float3(0.18f, 0.32f, 0.18f), new float3(0.46f, 0.4f, 0.32f));
                    Module(c, Part.Box, 0, 0, new float3(0.26f, 0.06f, 0.26f), new float3(0.36f, 0.32f, 0.26f), 0, 0.32f);
                    for (int k = 0; k < 6; k++) Module(c, Part.Box, Mathf.Cos(k) * 0.4f, Mathf.Sin(k) * 0.4f, new float3(0.2f, 0.07f, 0.06f), new float3(0.55f, 0.5f, 0.38f), k);
                    break;
                case "bunker":
                    Module(c, Part.Box, 0, 0, new float3(0.5f, 0.14f, 0.4f), conc);
                    Module(c, Part.Box, 0, 0.2f, new float3(0.3f, 0.03f, 0.02f), new float3(0.1f, 0.1f, 0.1f), 0, 0.08f);
                    break;
                case "aa_battery":
                    Module(c, Part.Cylinder, 0, 0, new float3(0.5f, 0.06f, 0.5f), conc);
                    Module(c, Part.Box, 0, 0, new float3(0.12f, 0.1f, 0.18f), new float3(0.36f, 0.38f, 0.32f), 0, 0.06f);
                    Module(c, Part.Box, 0.03f, 0.1f, new float3(0.02f, 0.02f, 0.28f), new float3(0.2f, 0.2f, 0.2f), 0, 0.16f);
                    Module(c, Part.Box, -0.03f, 0.1f, new float3(0.02f, 0.02f, 0.28f), new float3(0.2f, 0.2f, 0.2f), 0, 0.16f);
                    break;
                case "missile_silo":
                    Module(c, Part.Cylinder, 0, 0, new float3(0.36f, 0.04f, 0.36f), conc);
                    Module(c, Part.Box, 0, 0, new float3(0.2f, 0.01f, 0.36f), new float3(0.3f, 0.3f, 0.3f), 0, 0.04f);
                    Module(c, Part.Box, 0.45f, 0.3f, new float3(0.3f, 0.12f, 0.3f), conc);
                    break;
                default:
                    Module(c, Part.Box, 0, 0, new float3(0.06f, 0.6f, 0.06f), new float3(0.7f, 0.7f, 0.74f));
                    Module(c, Part.Cylinder, 0, 0, new float3(0.3f, 0.03f, 0.3f), new float3(0.3f, 0.7f, 1f), 0, 0.6f, 1f);
                    break;
            }
        }

        void Warehouses(in Ctx c, bool market)
        {
            if (market)
            {
                for (int k = 0; k < 6; k++)
                {
                    float x = -0.5f + (k % 3) * 0.5f, z = k < 3 ? -0.25f : 0.25f;
                    // commerce is the most colourful thing in town: striped awnings and lit signs
                    var awning = c.Era == 0 ? Tarp(c.Seed + k * 7) : k % 3 == 0 ? new float3(0.78f, 0.24f, 0.18f) : k % 3 == 1 ? new float3(0.2f, 0.5f, 0.62f) : new float3(0.85f, 0.65f, 0.2f);
                    Module(c, Part.Box, x, z, new float3(0.28f, 0.1f + c.Era * 0.03f, 0.2f), c.Era == 0 ? Timber(c.Seed + k) : Stucco(c.Seed + k));
                    Module(c, Part.Roof, x, z, new float3(0.3f, 0.06f, 0.22f), awning, 0, 0.1f + c.Era * 0.03f);
                    if (c.Era >= 1) Module(c, Part.Box, x, z - 0.105f, new float3(0.16f, 0.035f, 0.008f), awning * 1.2f, 0, 0.06f, 0.5f);
                }
                return;
            }
            if (c.Era == 0)
            {
                // a depot is a container yard: stacks of salvaged boxes and a gantry of scaffold
                for (int k = 0; k < 6; k++)
                    ContainerHome(c, -0.4f + (k % 3) * 0.3f, -0.3f + (k / 3) * 0.45f, (Hash(c.Seed, k) - 0.5f) * 0.2f, c.Seed + k * 5, 1 + (int)(Hash(c.Seed, 20 + k) * 2.5f));
                Flag(c, 0.55f, 0.5f, 0.4f);
                return;
            }
            // logistics: long warehouses with the owner's colour on the loading doors
            for (int k = 0; k < 3; k++)
            {
                Module(c, Part.Box, 0, -0.5f + k * 0.5f, new float3(1f, 0.2f, 0.36f), Concrete(c.Seed + k));
                BarrelRoof(c, 0, -0.5f + k * 0.5f, 1f, 0.36f, 0.2f, new float3(0.48f, 0.5f, 0.5f));
                for (int d = 0; d < 3; d++) Module(c, Part.Box, -0.3f + d * 0.3f, -0.5f + k * 0.5f + 0.185f, new float3(0.12f, 0.12f, 0.008f), c.Civ * 0.85f);
            }
            for (int k = 0; k < 4; k++) Module(c, Part.Box, 0.62f, -0.4f + k * 0.26f, new float3(0.1f, 0.06f, 0.2f), Container(c.Seed + k));
        }

        void Extraction(in Ctx c, string type)
        {
            switch (type)
            {
                case "oil_well":
                    Module(c, Part.Crane, 0, 0, new float3(0.6f, 0.5f, 0.6f), new float3(0.4f, 0.4f, 0.42f));
                    Module(c, Part.Silo, 0.4f, 0.3f, new float3(0.2f, 0.2f, 0.2f), new float3(0.6f, 0.58f, 0.5f));
                    break;
                case "lumber":
                    Module(c, Part.Box, 0, 0, new float3(0.5f, 0.14f, 0.3f), new float3(0.5f, 0.38f, 0.26f));
                    for (int k = 0; k < 4; k++) Module(c, Part.Cylinder, 0.4f, -0.3f + k * 0.12f, new float3(0.1f, 0.5f, 0.1f), new float3(0.48f, 0.36f, 0.24f), 0, 0.05f);
                    break;
                default:
                    // extraction language: raw earth spoil heaps and yellow plant (timber gear in the first era)
                    Module(c, Part.Box, -0.3f, 0, new float3(0.4f, 0.18f, 0.3f), c.Era == 0 ? Sheet(c.Seed) : new float3(0.46f, 0.42f, 0.36f));
                    Module(c, Part.Crane, 0.2f, -0.2f, new float3(0.5f, 0.45f, 0.5f), c.Era == 0 ? Timber(c.Seed) : Hazard);
                    float3 spoil = type == "quarry" ? new float3(0.62f, 0.6f, 0.55f) : type == "salvage" ? new float3(0.45f, 0.4f, 0.36f) : new float3(0.42f, 0.33f, 0.25f);
                    for (int k = 0; k < 3; k++) Module(c, Part.Cone, 0.35f + k * 0.12f, 0.35f, new float3(0.24f, 0.14f + Hash(c.Seed, k) * 0.06f, 0.24f), spoil * (0.9f + 0.2f * Hash(c.Seed, 10 + k)));
                    if (type == "salvage") for (int k = 0; k < 3; k++) Module(c, Part.Box, -0.4f + k * 0.14f, 0.4f, new float3(0.12f, 0.05f, 0.08f), Container(c.Seed + k), Hash(c.Seed, 20 + k));
                    break;
            }
        }

        void Wonder(in Ctx c)
        {
            Module(c, Part.Cylinder, 0, 0, new float3(1.2f, 0.2f, 1.2f), new float3(0.78f, 0.8f, 0.82f));
            Module(c, Part.Skyscraper, 0, 0, new float3(0.5f, 3.6f, 0.5f), new float3(0.82f, 0.86f, 0.9f), 0.4f);
            Module(c, Part.Cone, 0, 0, new float3(0.5f, 0.6f, 0.5f), new float3(0.6f, 0.8f, 1f), 0.4f, 3.6f, 0.6f);
        }

        void ComposeSite(in BuildingRecord b, float cx, float cz, float yaw, int seed)
        {
            var c = new Ctx { X = cx, Z = cz, Yaw = yaw, Seed = seed, Tint = new float3(1), Civ = CivColor(b.Owner).xyz, Era = Age, Level = 1 };
            float prog = Mathf.Clamp01(b.Progress / 100f);
            Module(c, Part.Box, 0, 0, new float3(0.8f, 0.02f, 0.6f), new float3(0.5f, 0.46f, 0.4f));
            float h = 0.05f + prog * 0.3f;
            Module(c, Part.Box, 0, 0, new float3(0.55f, h, 0.4f), new float3(0.62f, 0.6f, 0.56f));
            // scaffold poles
            for (int k = 0; k < 4; k++) Module(c, Part.Box, (k % 2 == 0 ? -1 : 1) * 0.3f, (k < 2 ? -1 : 1) * 0.22f, new float3(0.012f, h + 0.08f, 0.012f), new float3(0.7f, 0.6f, 0.35f));
            Module(c, Part.Crane, 0.42f, 0.3f, new float3(0.55f, 0.5f + prog * 0.2f, 0.55f), new float3(1, 1, 1), Hash(seed, 2) * 3);
        }

        public void Draw(WrapImages images)
        {
            foreach (var cell in cells.Values)
            {
                if (!cell.Any) continue;
                foreach (var b in cell.Batches) b.DrawImages(images);
            }
        }

        void DisposeCell(Cell c) { foreach (var b in c.Batches) b?.Dispose(); }

        public void Dispose()
        {
            foreach (var c in cells.Values) DisposeCell(c);
            cells.Clear();
        }
    }
}
