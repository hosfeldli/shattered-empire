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
    public sealed unsafe partial class CityRenderer : IDisposable
    {
        enum Part { Box, Roof, Cylinder, Cone, Skyscraper, Silo, Chimney, Crane, Ship, Broken, Dome, Car, Truck,
            Concrete, Brick, Siding, Glass, Asphalt, MetalRoof, Shell, Collapse, Tree, Dish, Wire, TankObstacle, StrategicHatch, Count }

        sealed class Cell
        {
            public readonly InstanceBatch[] Batches = new InstanceBatch[(int)Part.Count];
            public Bounds Bounds;
            public bool Any;
            public Mesh Streets;
            public InstanceBatch StreetBatch;
            public readonly List<AnimatedFlag> Flags = new List<AnimatedFlag>();
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
        /// <summary>How long city composition may take per frame (ms) before the rest waits for the next frame.</summary>
        public double ComposeBudgetMs = 5.0;
        int epoch = -1, roadRevision = -1, age = -1;
        bool[] hasBuilding = new bool[0];
        bool[] streetParcels = new bool[0];

        /// <summary>The district layer: which buildings form one neighbourhood, compound, estate or campus.</summary>
        public readonly DistrictPlanner Districts;

        public CityRenderer(WorldModel w, StructureStore s) { world = w; structures = s; Districts = new DistrictPlanner(w, s); }

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
                streetParcels = new bool[world.Grid.N];
                RoadCurve.Occupied = streetParcels;
                roadRevision = -1;
            }
            if (roadRevision != world.LayoutRevision)
            {
                roadRevision = world.LayoutRevision;
                for (int c = 0; c < world.ChunksW * world.ChunksH; c++) dirty.Add(c);
            }
            if (age != Age)
            {
                age = Age;   // a new era: new infill and buildings without a recorded era follow it
                if (!ActionRts) foreach (var c in cells.Keys) dirty.Add(c);
            }
            // the district layer: when buildings or roads change, only hexes whose district relationships
            // changed are recomposed (a new house extends its neighbourhood, it does not re-roll it)
            Districts.WorldSeed = Seed;
            Districts.Update(dirty);
            InvalidateRingDistricts();
            if (dirty.Count == 0) return;
            // nearest cells first, a bounded number per frame
            scratch.Clear();
            scratch.AddRange(dirty);
            float period = world.Grid.Period;
            scratch.Sort((a, b) => CellDistance(a, cameraPos, period).CompareTo(CellDistance(b, cameraPos, period)));
            int n = Math.Min(MaxCellsPerFrame, scratch.Count);
            Array.Clear(hasBuilding, 0, hasBuilding.Length);
            foreach (var b in structures.Buildings.Values) if (b.Tile >= 0 && b.Tile < hasBuilding.Length) hasBuilding[b.Tile] = true;
            Array.Copy(hasBuilding, streetParcels, hasBuilding.Length);
            if (ActionRts)
            {
                foreach (var lot in historicalParcels.Values) streetParcels[lot.parcel.Tile] = true;
                foreach (var objective in objectiveByTile.Values) if (objective.IsBase) streetParcels[objective.Tile] = true;
            }
            // a time budget, not a fixed count: district composition varies a lot per cell, and a burst of
            // heavy cells must not stall a frame (at least one cell always progresses)
            long start = System.Diagnostics.Stopwatch.GetTimestamp();
            double budget = ComposeBudgetMs * System.Diagnostics.Stopwatch.Frequency / 1000.0;
            for (int k = 0; k < n; k++)
            {
                int c = scratch[k];
                dirty.Remove(c);
                Compose(c, terrain);
                if (System.Diagnostics.Stopwatch.GetTimestamp() - start > budget) break;
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
                cell = CreateCell(false);
                cells[id] = cell;
            }
            return cell;
        }

        static Mesh satelliteDish;
        static Cell CreateCell(bool preview)
        {
            if (satelliteDish == null) satelliteDish = WorldMeshes.SatelliteDish();
            var cell = new Cell();
            Mesh[] meshes = { MeshKit.Box, MeshKit.Roof, MeshKit.Cylinder, MeshKit.Cone, MeshKit.Skyscraper, MeshKit.Silo,
                MeshKit.Chimney, MeshKit.Crane, MeshKit.ShipHull, MeshKit.BrokenTower, MeshKit.Dome, MeshKit.Car, MilitaryMeshes.CargoTruck,
                MeshKit.Box, MeshKit.Box, MeshKit.Box, MeshKit.Box, MeshKit.Box, MeshKit.Roof, MeshKit.RuinShell, MeshKit.CollapsedBlock, MeshKit.Deciduous, satelliteDish, MeshKit.Coil, MeshKit.TankObstacle, MeshKit.StrategicHatch };
            for (int i = 0; i < cell.Batches.Length; i++)
            {
                SurfaceKind material = (Part)i switch
                {
                    Part.Concrete or Part.Chimney => SurfaceKind.Concrete,
                    Part.Brick => SurfaceKind.Brick,
                    Part.Siding or Part.MetalRoof or Part.Silo => SurfaceKind.SheetMetal,
                    Part.Glass => SurfaceKind.Glass,
                    Part.Asphalt => SurfaceKind.Asphalt,
                    Part.Roof => SurfaceKind.RoofTile,
                    _ => SurfaceKind.Plain
                };
                var batch = new InstanceBatch(meshes[i], (Part)i == Part.Tree ? RenderResources.Foliage : RenderResources.Surface(material), i >= (int)Part.Concrete ? 24 : 64);
                if (preview) batch.Shadows = UnityEngine.Rendering.ShadowCastingMode.Off;
                cell.Batches[i] = batch;
            }
            return cell;
        }

        // ------------------------------------------------------------------ composition
        Cell current;
        float3 bmin, bmax;

        /// <summary>Place a part at a map position with a map heading; converted to Unity space here only.</summary>
        void Put(Part part, float3 mapPos, float mapYaw, float3 size, float3 color, float emission = 0)
        {
            if (part == Part.Car || part == Part.Truck) return;
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
            cell.Flags.Clear();
            foreach (var b in cell.Batches) b.Clear();
            BeginStreetMesh();
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
                    if (world.Road[t] != 0 && !Showcase) ComposeStreets(t);
                    if (world.Road[t] != 0 && world.IsUrban(t) && !ActionRts && !Showcase) StreetLife(t);
                    if (world.IsUrban(t) && !hasBuildingAt(t) && !Ruins.ContainsKey(t) && !world.IsSea(t) && !world.IsLake(t)
                        && !ActionRts && !Showcase) Infill(t);
                    ComposeOldWorld(t);
                    terrain.SetBlocked(t, IsBlocked(t));
                }
            if (ActionRts) foreach (var site in objectiveByTile.Values)
                if (site.IsBase && world.ChunkOf(site.Tile) == cellId) ComposeCityDistrict(site);
            if (ActionRts) foreach (var pickup in pickups.Values)
                if (world.ChunkOf(pickup.Tile) == cellId) MaterialsPickup(pickup);
            if (Showcase) ComposeShowcaseStreets(cellId);
            foreach (var b in structures.Buildings.Values)
            {
                if (b.Tile < 0 || b.Tile >= g.N || world.ChunkOf(b.Tile) != cellId || world.Known[b.Tile] == 0) continue;
                ComposeBuilding(b);
                if (b.Done && !ActionRts && !Showcase) DistrictLinks(b.Tile);
            }
            cell.Any = false;
            foreach (var batch in cell.Batches) if (batch.Count > 0) cell.Any = true;
            FinishStreetMesh(cell);
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
            if (part == Part.Car || part == Part.Truck) return;
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
            if (ActionRts && objectiveByTile.TryGetValue(t, out var site))
            {
                if (site.Headquarters == 0 || !site.IsBase) ActionRuin(site);
                return;
            }
            if (ActionRts) return;
            if (Ruins.TryGetValue(t, out var ruin)) { if (!hasBuildingAt(t)) Ruin(t, cx, cz, ruin.Type ?? "", (ruin.Flags & 4) != 0); return; }
            if (Showcase) return;
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
            if (ActionRts) return;
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
                    // Collapse retains the original footprint and a supported service core.
                    Module(c, Part.Broken, -.22f, -.17f, new float3(.43f, .78f + Hash(seed, 6) * .25f, .46f), new float3(.91f));
                    Module(c, Part.Collapse, .22f, .23f, new float3(.66f, .46f, .59f), new float3(.90f), .08f);
                    if (type == "city")
                        Module(c, Part.Shell, -.44f, .39f, new float3(.32f, .24f, .31f), new float3(.93f));
                    break;
                }
                case "plant":
                    Module(c, Part.Silo, 0.25f, 0, new float3(0.6f, 0.38f, 0.6f), concrete);
                    Module(c, Part.Shell, -.32f, .15f, new float3(.48f, .33f, .55f), new float3(.85f));
                    Module(c, Part.Collapse, -.09f, -.35f, new float3(.35f, .17f, .28f), new float3(.81f));
                    break;
                default:
                    // Two surviving street-front parcels, with a shared alley.
                    for (int k = 0; k < 2; k++)
                    {
                        Module(c, Part.Shell, -.27f + k * .54f, -.10f, new float3(.39f, .23f + Hash(seed, 90 + k) * .10f, .48f),
                            overgrown ? new float3(.80f, .85f, .78f) : new float3(.91f, .88f, .82f));
                    }
                    Module(c, Part.Collapse, .20f, .33f, new float3(.36f, .13f, .25f), new float3(.84f));
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
        /// The streets of one hex (see <see cref="RoadCurve"/>): half-streets from each road edge to the
        /// hex's junction. In a built hex the junction sits on the street side, so streets pass the
        /// building's parcel instead of crossing it.
        /// </summary>
        void ComposeStreets(int t)
        {
            if (ActionRts && ComposeRingApproaches(t)) return;
            int* e = stackalloc int[6];
            int n = RoadCurve.Edges(world, t, e);
            if (n == 0) return;
            var g = world.Grid;
            if (RoadCurve.Built(t))
            {
                for (int i = 0; i < n; i++)
                {
                    int d = e[i]; var mid = RoadCurve.Mid(world, t, d); var portal = RoadCurve.Portal(world, t, d);
                    StreetPiece(t, mid, (mid + portal) * .5f, portal, world.RoadClass(t, d), world.RoadBroken(t, d), g.Nb[t * 6 + d], -1, 4);
                }
                int* chain = stackalloc int[6];
                int count = RoadCurve.Chain(world, t, chain);
                int firstMain = count, lastMain = -1, mainClass = 1;
                for (int i = 0; i < count; i++)
                {
                    int cls = world.RoadClass(t, chain[i]);
                    if (cls < 2) continue;
                    firstMain = Mathf.Min(firstMain, i); lastMain = i; mainClass = Mathf.Max(mainClass, cls);
                }
                for (int pair = 0; pair + 1 < count; pair++)
                {
                    int d = chain[pair], stop = chain[pair + 1];
                    int cls = Mathf.Min(world.RoadClass(t, d), world.RoadClass(t, stop));
                    if (pair >= firstMain && pair < lastMain) cls = mainClass;
                    bool broken = world.RoadBroken(t, d) || world.RoadBroken(t, stop);
                    for (int arc = 0; d != stop && arc < 5; arc++)
                    {
                        int next = (d + 1) % 6;
                        StreetPiece(t, RoadCurve.Portal(world, t, d), RoadCurve.ArcControl(world, t, d, next), RoadCurve.Portal(world, t, next), cls, broken, -1, -1, 4);
                        d = next;
                    }
                }
                if (count == 1)
                {
                    var cap = RoadCurve.Portal(world, t, chain[0]);
                    int cls = world.RoadClass(t, chain[0]); float width = RoadCurve.Width(cls);
                    Put(Part.Cylinder, new float3(cap.x, RoadCurve.Height(world, RoadCurve.Deck(world, t, -1, -1), cap.x, cap.y) - .001f, cap.y),
                        0, new float3(width, .001f, width), StreetColor(t, -1, cls, world.RoadBroken(t, chain[0])));
                }
                return;
            }
            float2 node = RoadCurve.Node(world, t);
            int best = 0;
            for (int i = 0; i < n; i++)
            {
                int d = e[i], cls = world.RoadClass(t, d);
                best = Math.Max(best, cls);
                float2 m = RoadCurve.Mid(world, t, d);
                StreetPiece(t, m, RoadCurve.HalfControl(world, t, d, node), node, cls, world.RoadBroken(t, d), g.Nb[t * 6 + d], -1, 4);
            }
            // a junction (or turning circle) where streets meet: rounded, never a square plaza; railways
            // don't get one
            if ((n >= 3 || n == 1) && best != 4)
            {
                float w = RoadCurve.Width(best) * (n == 1 ? 1.3f : 1.05f) * StreetWidthScale(t);
                float y = RoadCurve.Height(world, RoadCurve.Deck(world, t, -1, -1), node.x, node.y) - 0.012f;
                Put(Part.Cylinder, new float3(node.x, y, node.y), 0, new float3(w, 0.012f, w), StreetColor(t, -1, best, false));
                // pedestrian crossings on the busier town junctions
                if (n >= 3 && best >= 2 && Sidewalked(t) && Hash(t, 91) < 0.6f)
                    for (int i = 0; i < Math.Min(2, n); i++)
                    {
                        int d = e[i];
                        float2 m = math.lerp(node, RoadCurve.Mid(world, t, d), 0.28f);
                        float yaw = Mathf.Atan2(HexMath.DirX[d], HexMath.DirZ[d]);
                        for (int s = -2; s <= 2; s++)
                        {
                            math.sincos(yaw, out float sn, out float cs);
                            float ox = cs * s * 0.018f, oz = -sn * s * 0.018f;
                            Put(Part.Box, new float3(m.x + ox, y + 0.013f, m.y + oz), yaw, new float3(0.008f, 0.002f, 0.05f), new float3(0.82f, 0.8f, 0.74f));
                        }
                    }
            }
        }

        /// <summary>The street hierarchy (organic city design §4.1) as the district sees it.</summary>
        enum StreetStyle { Rural, Local, Commercial, Service, Primary, Rail }

        StreetStyle StyleOf(int t, int cls)
        {
            if (cls == 4) return StreetStyle.Rail;
            if (cls == 3) return StreetStyle.Primary;
            if (cls == 1) return StreetStyle.Rural;
            var k = Districts.At(t)?.Kind ?? DistrictKind.None;
            if (k == DistrictKind.Industrial || k == DistrictKind.Energy || k == DistrictKind.Extraction || k == DistrictKind.Port || k == DistrictKind.Air) return StreetStyle.Service;
            if (cls == 1 && !world.IsUrban(t)) return StreetStyle.Rural;
            if (k == DistrictKind.Commercial || k == DistrictKind.Civic) return StreetStyle.Commercial;
            return StreetStyle.Local;
        }

        /// <summary>Whether this hex's streets carry sidewalks: homes, shops and institutions, not industry or country lanes.</summary>
        bool Sidewalked(int t)
        {
            var k = Districts.At(t)?.Kind ?? DistrictKind.None;
            return world.IsUrban(t) && (k == DistrictKind.None || k == DistrictKind.Residential || k == DistrictKind.Commercial || k == DistrictKind.Civic);
        }

        float StreetWidthScale(int t)
        {
            var k = Districts.At(t)?.Kind ?? DistrictKind.None;
            return k == DistrictKind.Industrial || k == DistrictKind.Energy ? 1.15f : k == DistrictKind.Residential ? 0.92f : 1f;
        }

        float3 StreetColor(int t, int salt, int cls, bool broken)
        {
            var style = StyleOf(t, cls);
            float3 color = style == StreetStyle.Rural ? new float3(0.42f, 0.36f, 0.27f)
                : style == StreetStyle.Rail ? new float3(0.36f, 0.33f, 0.3f)
                : style == StreetStyle.Service ? new float3(0.4f, 0.39f, 0.37f)   // pale concrete service roads
                : new float3(0.24f, 0.24f, 0.25f);
            // One material along a route. Age affects condition, not a random patchwork of colours.
            color = math.lerp(color, new float3(.43f, .44f, .43f), .24f);
            if (broken) color *= .82f;
            return color;
        }

        /// <summary>
        /// One curved street piece (quadratic Bézier p0 → c → p2) in its street style: kerbs and
        /// continuous sidewalks in town (patchy in old neighbourhoods), soft shoulders on country lanes,
        /// pale concrete for industrial service roads, ballast, sleepers and rails for railways, and on
        /// bridges a deck with railings, piers and abutments.
        /// </summary>
        void StreetPiece(int t, float2 p0, float2 c, float2 p2, int cls, bool broken, int na, int nb, int pieces)
            => StreetRibbon(t, p0, c, p2, cls, broken, na, nb);

        void ComposeBuilding(in BuildingRecord b)
        {
            var g = world.Grid;
            float cx = g.CenterX(b.Tile), cz = g.CenterZ(b.Tile);
            int seed = DistrictPlanner.StableHash(Seed, b.Slot > 0 ? b.Slot : b.HasPosition ? b.Tile : b.Id, b.Tile);
            // the parcel: the widest side of the hex free of streets. The building sits there, scaled to the
            // room it has, fronting the streets that pass along the other side (organic city design §6.1–6.2)
            float yaw;
            if (world.Road[b.Tile] != 0)
            {
                RoadCurve.Parcel(world, b.Tile, out var pdir, out float room);
                parcelScale = Mathf.Lerp(0.68f, 1f, room);
                float offset = Mathf.Lerp(0.2f, 0.06f, room);
                cx += pdir.x * offset; cz += pdir.y * offset;
                yaw = Mathf.Atan2(-pdir.x, -pdir.y);
            }
            else { parcelScale = 1f; yaw = Hash(seed, 3) * 6.283f; }
            // no two parcels sit exactly alike: a small offset and turn, so the hex grid doesn't show through
            yaw += (Hash(seed, 5) - 0.5f) * 0.18f;
            cx += (Hash(seed, 6) - 0.5f) * 0.06f; cz += (Hash(seed, 7) - 0.5f) * 0.06f;
            if (b.HasPosition) { cx = b.X; cz = b.Z; parcelScale = 1f; }
            if (b.HasYaw) yaw = b.Yaw;
            var district = Districts.At(b.Tile);
            styleSeed = district?.Seed ?? seed;
            float4 civ = CivColor(b.Owner);
            // damage darkens by band, not by every point of health
            int band = StructureStore.DamageBand(b.Hp);
            float dmg = band == 0 ? 1f : band == 1 ? 0.88f : band == 2 ? 0.74f : 0.6f;
            float memory = b.Memory ? 0.6f : 1f;
            float3 tint = new float3(dmg * memory);
            // historical continuity: a building keeps the architecture of the era it was built (or last
            // upgraded) in; only old saves without that record follow the nation's current era
            int era = Math.Max(0, Math.Min(4, b.Era >= 0 ? b.Era : Age));
            if (!b.Done)
            {
                ComposeSite(b, cx, cz, yaw, seed);
                return;
            }
            var ctx = new Ctx
            {
                X = cx, Z = cz, Yaw = yaw, Seed = seed, Tint = tint, Civ = civ.xyz, Era = era, Level = Math.Max(1, b.Level), Tier = b.Tier,
                Scale = parcelScale, Style = district?.Seed ?? seed, Kind = district?.Kind ?? DistrictPlanner.KindOf(b.Type),
                Anchor = district == null || district.Anchor == b.Tile, DistrictSize = district?.Size ?? 1,
                FixedGround = b.HasPosition, GroundY = b.HasPosition ? BuildingDatum(cx, cz, yaw) : Ground(cx, cz) - .012f,
            };
            Stacks.Remove(b.Id);
            composing = b.Id;
            switch (b.Type)
            {
                case "house": House(ctx); break;
                case "modern_block": ModernBlock(ctx, false, b.State == "ruin" || b.State == "overgrown", b.State == "overgrown"); break;
                case "modern_office": ModernBlock(ctx, true, b.State == "ruin" || b.State == "overgrown", b.State == "overgrown"); break;
                case "cinematic_rowhouse": case "cinematic_industrial": case "cinematic_civic":
                    CinematicDistrictBuilding(ctx, b.Type, b.State == "ruin" || b.State == "overgrown", b.State == "overgrown"); break;
                case "town": if (b.HasPosition) Headquarters(ctx); else Centre(ctx); break;
                case "farm": Farm(ctx); break;
                case "barracks": case "camp": if (b.HasPosition) MilitaryBarracks(ctx); else Base(ctx, false); break;
                case "fort": Fortress(ctx); break;
                case "steel_mill": SteelMill(ctx); break;
                case "refinery": Refinery(ctx); break;
                case "munitions_plant": Munitions(ctx); break;
                case "motor_works": if (b.HasPosition) VehicleWorks(ctx); else MotorWorks(ctx); break;
                case "heavy_assembly": HeavyAssembly(ctx); break;
                case "heavy_weapons": HeavyWeaponsFacility(ctx); break;
                case "electronics_plant": Electronics(ctx); break;
                case "drone_works": DroneWorks(ctx); break;
                case "robotics_complex": Robotics(ctx); break;
                case "mine": if (ctx.Era == 0) Extraction(ctx, b.Type); else Mine(ctx); break;
                case "quarry": Quarry(ctx); break;
                case "salvage": Salvage(ctx); break;
                case "lumber": TimberMill(ctx); break;
                case "oil_well": PumpJack(ctx); break;
                case "shield_generator": ShieldGenerator(ctx); break;
                case "missile_silo": if (b.HasPosition) StrategicFacility(ctx); else MissileSilo(ctx); break;
                case "academy": case "university": Campus(ctx, b.Type == "university"); break;
                case "power_plant": if (b.HasPosition) GeneratorStation(ctx); else Power(ctx, false); break;
                case "fusion_plant": Power(ctx, true); break;
                case "nuclear_plant": Nuclear(ctx); break;
                case "airfield": if (b.HasPosition) ForwardAirfield(ctx); else Airfield(ctx); break;
                case "port": Port(ctx); break;
                case "comms_tower": LatticeMast(ctx); break;
                case "guard_post": case "bunker": case "aa_battery": Defence(ctx, b.Type); break;
                case "barricade": FieldBarricades(ctx); break;
                case "sensor_post": SensorPost(ctx); break;
                case "artillery_post": ArtilleryPosition(ctx); break;
                case "armory": if (b.HasPosition) Arsenal(ctx); else SupportFacility(ctx, 0); break;
                case "defense_works": if (b.HasPosition) FortificationWorks(ctx); else SupportFacility(ctx, 1); break;
                case "advanced_lab": if (b.HasPosition) SystemsCampus(ctx); else SupportFacility(ctx, 2); break;
                case "turret": SupportFacility(ctx, 3); break;
                case "repair_point": SupportFacility(ctx, 4); break;
                case "market": Warehouses(ctx, true); break;
                case "depot": if (b.HasPosition) SupplyCenter(ctx); else Warehouses(ctx, false); break;

                case "wonder": Wonder(ctx); break;
                default: Industry(ctx); break;
            }
            // Modern skyline blocks provide their own roof plant and damaged shell.
            // Legacy factory annexes and damage piles do not belong to these parcels.
            if (b.Type == "modern_block" || b.Type == "modern_office" || b.Type.StartsWith("cinematic_", StringComparison.Ordinal)) return;
            if (b.HasPosition && ctx.Tier >= 2) MilitaryTierEquipment(ctx, b.Type);
            if (ctx.Level >= 2 && b.Type != "house" && b.Type != "town" && b.Type != "wonder") UpgradeExtras(ctx, b.Type);
            if (!Showcase) ParcelExtras(ctx, b.Type);
            DamageOverlay(b, cx, cz, yaw, seed);
        }

        struct Ctx
        {
            public float X, Z, Yaw;
            public int Seed, Era, Level, Tier;
            public float3 Tint, Civ;
            /// <summary>Parcel scale (0 means 1): footprints shrink to fit the room the streets leave.</summary>
            public float Scale;
            /// <summary>The district's style seed (a shared vocabulary of materials and roofs) and its kind.</summary>
            public int Style;
            public DistrictKind Kind;
            /// <summary>The district's oldest building (the farmstead, the compound's headquarters…).</summary>
            public bool Anchor;
            public int DistrictSize;
            public bool FixedGround;
            public float GroundY;
        }

        static float S(in Ctx c) => c.Scale > 0 ? c.Scale : 1f;

        /// <summary>The parcel scale of the building being composed (sites and damage use it too).</summary>
        float parcelScale = 1f;

        // place a module at local (lx, lz) of the hex in the building's frame, on the ground (sunk a little)
        void Module(in Ctx c, Part part, float lx, float lz, float3 size, float3 color, float yawOffset = 0, float lift = 0, float emission = 0)
        {
            if (part == Part.Car || part == Part.Truck) return;
            if (part == Part.Box && size.y > .10f && size.x >= .11f && size.z >= .09f)
                part = c.Kind switch
                {
                    DistrictKind.Residential => c.Era == 1 ? Part.Brick : c.Era == 0 ? Part.Siding : Part.Concrete,
                    DistrictKind.Industrial or DistrictKind.Extraction or DistrictKind.Energy => c.Era == 1 ? Part.Brick : Part.Siding,
                    _ => Part.Concrete
                };
            if (part == Part.Roof && c.Kind is DistrictKind.Industrial or DistrictKind.Extraction or DistrictKind.Military or DistrictKind.Air)
                part = Part.MetalRoof;
            if (c.FixedGround && lift == 0 && size.y > .09f && size.x > .10f && size.z > .10f
                && part is Part.Concrete or Part.Brick or Part.Siding)
                Foundation(c, lx, lz, size.x, size.z);
            float k = S(c), kh = 0.65f + 0.35f * k;
            lx *= k; lz *= k; size = new float3(size.x * k, size.y * kh, size.z * k); lift *= kh;
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * cs + lz * sn, z = c.Z - lx * sn + lz * cs;
            if (lift <= .01f && emission == 0 && size.y <= .016f && size.x >= .22f && size.z >= .14f
                && part is Part.Asphalt or Part.Box or Part.Concrete)
            {
                DrapeParcel(new float2(x, z), c.Yaw + yawOffset, size.x, size.z, color * c.Tint,
                    part == Part.Asphalt ? SurfaceKind.Asphalt : SurfaceKind.Concrete);
                return;
            }
            float y = part == Part.Tree ? Ground(x, z) : c.FixedGround ? c.GroundY : Mathf.Min(Ground(x, z), Mathf.Min(Ground(x + size.x * 0.4f, z), Ground(x, z + size.z * 0.4f))) - 0.02f;
            Put(part, new float3(x, y + lift, z), c.Yaw + yawOffset, size, color * c.Tint, emission);
        }

        void Facade(in Ctx c, float lx, float lz, float width, float depth, float height, float turn, int seed, bool storefront = false)
        {
            math.sincos(turn, out float sn, out float cs);
            var site = c;
            float k = S(c);
            math.sincos(c.Yaw, out float snSite, out float csSite);
            float cx = c.X + (lx * csSite + lz * snSite) * k, cz = c.Z + (-lx * snSite + lz * csSite) * k;
            site.FixedGround = true;
            site.GroundY = c.FixedGround ? c.GroundY : Mathf.Min(Ground(cx, cz), Mathf.Min(Ground(cx + width * k * .4f, cz), Ground(cx, cz + depth * k * .4f))) - .02f;
            float3 trim = c.Kind == DistrictKind.Industrial ? new float3(.54f, .53f, .47f) : new float3(.78f, .74f, .67f);
            int bays = Mathf.Clamp(Mathf.RoundToInt(width / .094f), 2, 7);
            int floors = Mathf.Clamp(Mathf.FloorToInt(height / .102f), 1, 6);
            for (int floor = 0; floor < floors; floor++)
                for (int i = 0; i < bays; i++)
                {
                    float across = ((i + .5f) / bays - .5f) * width * .92f;
                    float front = depth * .50f;
                    float x = lx + across * cs + front * sn, z = lz - across * sn + front * cs;
                    float lift = height * (floor + .30f) / floors;
                    float w = width / bays * (storefront && floor == 0 ? .83f : .61f), h = Mathf.Min(.083f, height / floors * .49f);
                    if (floor == 0 && i == bays / 2 && !storefront)
                    {
                        Module(site, Part.Siding, x, z, new float3(w * .75f, h * 1.56f, .012f), new float3(.29f, .28f, .26f), turn, .012f);
                        Module(site, Part.Concrete, x + sn * .017f, z + cs * .017f, new float3(w * 1.4f, .012f, .043f), trim * .85f, turn);
                        continue;
                    }
                    Module(site, Part.Concrete, x, z, new float3(w + .010f, h + .010f, .011f), trim, turn, lift - .005f);
                    float lit = Hash(seed, floor * 13 + i);
                    var tint = lit > .68f ? new float3(.69f, .56f, .35f) : math.lerp(new float3(.24f, .33f, .37f), new float3(.53f, .60f, .61f), lit * .7f);
                    Module(site, Part.Glass, x + sn * .006f, z + cs * .006f, new float3(w, h, .009f), tint, turn, lift, lit > .68f ? .42f : 0f);
                    Module(site, Part.Concrete, x + sn * .009f, z + cs * .009f, new float3(.005f, h, .011f), trim * .81f, turn, lift);
                    if (floor > 0 && Hash(seed, 54 + i) < .22f)
                        Module(site, Part.Concrete, x + sn * .021f, z + cs * .021f, new float3(w * 1.28f, .012f, .055f), trim * .88f, turn, lift - .012f);
                }
        }

        /// <summary>Record a smoke source at local (lx, lz), height h above the ground, for the building being composed.</summary>
        void Stack(in Ctx c, float lx, float lz, float h, bool steam, float size)
        {
            if (composing < 0) return;
            float k = S(c); lx *= k; lz *= k; h *= 0.65f + 0.35f * k;
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * cs + lz * sn, z = c.Z - lx * sn + lz * cs;
            if (!Stacks.TryGetValue(composing, out var list)) Stacks[composing] = list = new List<SmokeStack>(2);
            list.Add(new SmokeStack { Pos = new float3(x, Ground(x, z) - 0.02f + h, z), Steam = steam, Size = size });
        }

        /// <summary>A module with pitch and roll as well as heading (hoop greenhouses, turbine blades).</summary>
        void ModuleRot(in Ctx c, Part part, float lx, float lz, float3 size, float3 color, float pitch, float roll, float yawOffset = 0, float lift = 0)
        {
            float k = S(c), kh = 0.65f + 0.35f * k;
            lx *= k; lz *= k; size *= k; lift *= kh;
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
        // District vocabulary (organic city design §6.3): each district has a base material and roof family;
        // a building varies within it (60% district, 40% parcel), so a neighbourhood reads as one place
        // without its houses being copies.
        int styleSeed;
        float Vary(int seed, int salt) => math.lerp(Hash(styleSeed, salt), Hash(seed, salt), 0.4f);
        float3 Stucco(int seed)
        {
            float family = Hash(styleSeed, 46);
            float3 a = family < 0.4f ? new float3(0.84f, 0.76f, 0.62f) : family < 0.7f ? new float3(0.78f, 0.78f, 0.74f) : new float3(0.82f, 0.7f, 0.58f);
            return math.lerp(a, a * new float3(1.06f, 1.04f, 1.02f), Vary(seed, 36));
        }

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
            float k = S(c), kh = .65f + .35f * k;
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * k * cs + lz * k * sn, z = c.Z - lx * k * sn + lz * k * cs;
            current.Flags.Add(new AnimatedFlag { Position = new float3(x, Ground(x, z) + (h - .07f) * kh, z), Color = c.Civ * c.Tint, Seed = c.Seed, Scale = k });
        }

        void Shack(in Ctx c, float lx, float lz, float rot, int seed)
        {
            // salvaged walls, a sheet or tarp roof, sometimes a lean-to and a rain barrel
            float w = 0.13f + Hash(seed, 1) * 0.06f, h = 0.08f + Hash(seed, 2) * 0.03f;
            Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.8f), Hash(seed, 3) < 0.5f ? Timber(seed) : Sheet(seed + 7), rot);
            Facade(c, lx, lz, w, w * .8f, h, rot, seed);
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

        float3 Brick(int seed) => math.lerp(new float3(0.55f, 0.36f, 0.28f), new float3(0.68f, 0.56f, 0.44f), Vary(seed, 9));
        static float3 Concrete(int seed) => math.lerp(new float3(0.58f, 0.57f, 0.55f), new float3(0.72f, 0.7f, 0.66f), Hash(seed, 10));
        static float3 RoofTone(int seed) => math.lerp(new float3(0.36f, 0.2f, 0.16f), new float3(0.3f, 0.32f, 0.34f), Hash(seed, 11));

        float3 HomeRoof(int seed)
        {
            // roof families: terracotta, slate, weathered brown, by district
            float family = Hash(styleSeed, 41);
            float3 a = family < 0.5f ? Terracotta : family < 0.8f ? new float3(0.31f, 0.32f, 0.35f) : new float3(0.42f, 0.31f, 0.24f);
            return math.lerp(a, a * 0.82f, Vary(seed, 37));
        }

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
                    Facade(c, Mathf.Cos(a) * .48f, Mathf.Sin(a) * .48f, .62f, .30f, h, a + Mathf.PI * .5f, c.Seed + k);
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
                        Facade(c, x, z, .23f, .24f, h, 0f, c.Seed + row * 8 + u);
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
                Facade(c, Mathf.Cos(a) * r, Mathf.Sin(a) * r, w, w * .8f, h, rot, c.Seed + k);
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
            Facade(c, 0, -.3f, .8f, .42f, .34f, 0, c.Seed);
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
            // an estate (organic city design §12): strip fields whose rows all run the estate's way, and
            // one farmstead (barn, farmhouse, silos) for the whole estate, at its oldest farm
            bool estate = c.Kind == DistrictKind.Agricultural && c.DistrictSize > 1;
            float rowYaw = estate ? Hash(c.Style, 7) * 3.1416f - c.Yaw : 0f;
            bool stead = !estate || c.Anchor;
            int strips = stead ? 4 : 5;
            for (int k = 0; k < strips; k++)
            {
                float3 crop = math.lerp(new float3(0.48f, 0.5f, 0.24f), new float3(0.66f, 0.56f, 0.28f), Hash(c.Seed, k));
                float along = -0.55f + k * (stead ? 0.28f : 0.27f);
                math.sincos(rowYaw, out float rs, out float rc);
                Module(c, Part.Box, stead ? -0.15f * rc + along * rs : along * rs, stead ? -0.15f * -rs + along * rc : along * rc, new float3(stead ? 1.15f : 1.3f, 0.025f, 0.24f), crop, rowYaw);
            }
            if (!stead) return;
            Module(c, Part.Box, 0.55f, 0.15f, new float3(0.24f, 0.16f, 0.32f), new float3(0.5f, 0.24f, 0.18f));
            Module(c, Part.Roof, 0.55f, 0.15f, new float3(0.26f, 0.1f, 0.34f), new float3(0.3f, 0.3f, 0.32f), 0, 0.16f);
            Module(c, Part.Silo, 0.62f, -0.2f, new float3(0.12f, 0.3f, 0.12f), new float3(0.7f, 0.7f, 0.68f));
            if (c.Level >= 2) Module(c, Part.Silo, 0.75f, -0.05f, new float3(0.1f, 0.26f, 0.1f), new float3(0.66f, 0.66f, 0.64f));
            Module(c, Part.Box, 0.35f, 0.5f, new float3(0.14f, 0.1f, 0.12f), Stucco(c.Seed));   // the farmhouse
            Module(c, Part.Roof, 0.35f, 0.5f, new float3(0.15f, 0.06f, 0.13f), HomeRoof(c.Seed), 0, 0.1f);
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
            // a lone base walls itself in; in a compound the district draws one perimeter for all of it
            bool compound = c.Kind == DistrictKind.Military && c.DistrictSize > 1;
            if (!compound || fort)
            {
                Module(c, Part.Box, 0, -r, new float3(2 * r, wall, 0.04f), wc);
                Module(c, Part.Box, 0, r, new float3(2 * r, wall, 0.04f), wc);
                Module(c, Part.Box, -r, 0, new float3(0.04f, wall, 2 * r), wc);
                Module(c, Part.Box, r, 0, new float3(0.04f, wall, 2 * r), wc);
                for (int k = 0; k < 4; k++)
                {
                    float sx = k % 2 == 0 ? -r : r, sz = k < 2 ? -r : r;
                    Module(c, Part.Box, sx, sz, new float3(0.1f, wall + 0.14f, 0.1f), wc * 0.9f);
                }
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
            Facade(c, 0, -.3f, .9f, .32f, .26f, 0, c.Seed);
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
                Facade(c, -.15f, z, .9f, .34f, .24f + c.Era * .03f, 0, c.Seed + k, true);
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

        // ------------------------------------------------------------------ parcels, parking and shared district spaces

        /// <summary>
        /// A parked vehicle at a stable spot (organic city design §7.3): restrained colours, cars or small
        /// trucks; military districts park olive trucks. Spots stay the same across reloads.
        /// </summary>
        void Parked(in Ctx c, float lx, float lz, float face, int seed, bool truck)
        {
            float3 col;
            if (c.Kind == DistrictKind.Military) col = Olive * (0.9f + 0.15f * Hash(seed, 1));
            else
            {
                float h = Hash(seed, 2);
                col = h < 0.25f ? new float3(0.62f, 0.62f, 0.6f) : h < 0.45f ? new float3(0.18f, 0.19f, 0.21f) : h < 0.6f ? new float3(0.78f, 0.77f, 0.73f)
                    : h < 0.72f ? new float3(0.45f, 0.14f, 0.12f) : h < 0.84f ? new float3(0.18f, 0.26f, 0.38f) : h < 0.94f ? new float3(0.34f, 0.37f, 0.31f) : new float3(0.74f, 0.6f, 0.22f);
            }
            float k = S(c);
            math.sincos(c.Yaw, out float sn, out float cs);
            float x = c.X + lx * k * cs + lz * k * sn, z = c.Z - lx * k * sn + lz * k * cs;
            Put(truck ? Part.Truck : Part.Car, new float3(x, Ground(x, z), z), c.Yaw + face, new float3(truck ? 0.05f : 0.042f), col * c.Tint);
        }

        /// <summary>
        /// What a parcel needs around its building, by district (§6.4, §7.1): driveways and a car or two at
        /// homes (not every house has one), a compact rear lot and curbside cars at shops, employee parking
        /// kept apart from the truck yard at industry, a motor pool at military sites, visitor spaces at
        /// institutions. Lot sizes and occupancy vary per parcel; nothing is a repeated prefab.
        /// </summary>
        void ParcelExtras(in Ctx c, string type)
        {
            int seed = c.Seed;
            var asphalt = new float3(0.3f, 0.3f, 0.31f);
            switch (c.Kind)
            {
                case DistrictKind.Residential:
                    if (c.Era == 0) { if (Hash(seed, 400) < 0.35f) Parked(c, 0.45f, 0.55f, 0.3f, seed + 1, true); return; }
                    if (c.Level >= 3)
                    {
                        // apartments share a lot at the back
                        Module(c, Part.Box, 0f, -0.66f, new float3(0.5f, 0.008f, 0.16f), asphalt);
                        int spaces = 3 + (int)(Hash(seed, 401) * 4);
                        for (int s = 0; s < spaces; s++) if (Hash(seed, 410 + s) < 0.7f) Parked(c, -0.2f + s * 0.07f, -0.66f, 0f, seed + s, false);
                        return;
                    }
                    if (Hash(seed, 402) < 0.6f)
                    {
                        // a short driveway to the street, sometimes with a car on it
                        float side = Hash(seed, 403) < 0.5f ? -0.36f : 0.36f;
                        Module(c, Part.Box, side, 0.6f, new float3(0.06f, 0.008f, 0.2f), new float3(0.46f, 0.45f, 0.42f));
                        if (Hash(seed, 404) < 0.65f) Parked(c, side, 0.58f, 0f, seed + 3, Hash(seed, 405) < 0.15f);
                    }
                    return;
                case DistrictKind.Commercial:
                    if (c.Era == 0) return;
                    Module(c, Part.Box, -0.1f, -0.62f, new float3(0.42f, 0.008f, 0.16f), asphalt);
                    for (int s = 0; s < 5; s++) if (Hash(seed, 420 + s) < 0.6f) Parked(c, -0.26f + s * 0.08f, -0.62f, 0f, seed + 20 + s, s == 4);
                    for (int s = 0; s < 2; s++) if (Hash(seed, 430 + s) < 0.7f) Parked(c, -0.3f + s * 0.5f, 0.72f, 1.57f, seed + 30 + s, false);   // curbside
                    return;
                case DistrictKind.Industrial:
                case DistrictKind.Energy:
                    // employees park by the gate; trucks and containers use the yard behind, apart from them
                    Module(c, Part.Box, -0.55f, 0.5f, new float3(0.26f, 0.008f, 0.2f), asphalt);
                    for (int s = 0; s < 4; s++) if (Hash(seed, 440 + s) < 0.65f) Parked(c, -0.62f + (s % 2) * 0.1f, 0.44f + (s / 2) * 0.1f, 1.57f, seed + 40 + s, false);
                    Module(c, Part.Box, 0.55f, -0.55f, new float3(0.3f, 0.008f, 0.26f), new float3(0.42f, 0.41f, 0.39f));
                    for (int s = 0; s < 3; s++) if (Hash(seed, 450 + s) < 0.6f) Parked(c, 0.48f + s * 0.07f, -0.55f, 0f, seed + 50 + s, true);
                    if (Hash(seed, 455) < 0.6f) Module(c, Part.Box, 0.62f, -0.42f, new float3(0.12f, 0.05f, 0.05f), Container(seed + 5));
                    return;
                case DistrictKind.Military:
                    if (type != "barracks" && type != "fort" && type != "camp") return;
                    // the motor pool: vehicles in an ordered row
                    for (int s = 0; s < 4; s++) if (Hash(seed, 460 + s) < 0.8f) Parked(c, 0.15f + s * 0.09f, 0.62f, 0f, seed + 60 + s, true);
                    return;
                case DistrictKind.Civic:
                    if (type == "academy" || type == "university")
                    {
                        Module(c, Part.Box, 0.55f, 0.6f, new float3(0.2f, 0.008f, 0.12f), asphalt);
                        for (int s = 0; s < 3; s++) if (Hash(seed, 470 + s) < 0.55f) Parked(c, 0.48f + s * 0.07f, 0.6f, 0f, seed + 70 + s, false);
                    }
                    return;
            }
        }

        /// <summary>
        /// Where a building's parcel lies (centre, heading, scale): the same rule <see cref="ComposeBuilding"/>
        /// uses, so shared spaces between buildings join their real parcels.
        /// </summary>
        bool ParcelOf(int tile, out float2 centre, out float yaw, out float scale)
        {
            centre = default; yaw = 0; scale = 1;
            if (!(Districts.BuildingAt(tile) is BuildingRecord b)) return false;
            var g = world.Grid;
            float cx = g.CenterX(tile), cz = g.CenterZ(tile);
            int seed = DistrictPlanner.StableHash(Seed, b.Id, b.Tile);
            if (b.HasPosition && b.HasYaw)
            { centre = new float2(b.X, b.Z); yaw = b.Yaw; return true; }
            if (world.Road[tile] != 0)
            {
                RoadCurve.Parcel(world, tile, out var pdir, out float room);
                scale = Mathf.Lerp(0.68f, 1f, room);
                float offset = Mathf.Lerp(0.2f, 0.06f, room);
                cx += pdir.x * offset; cz += pdir.y * offset;
                yaw = Mathf.Atan2(-pdir.x, -pdir.y);
            }
            else yaw = Hash(seed, 3) * 6.283f;
            yaw += (Hash(seed, 5) - 0.5f) * 0.18f;
            cx += (Hash(seed, 6) - 0.5f) * 0.06f; cz += (Hash(seed, 7) - 0.5f) * 0.06f;
            centre = new float2(cx, cz);
            return true;
        }

        /// <summary>
        /// The spaces a district shares (organic city design §5.3, §10–12): drawn once per pair of
        /// neighbouring members (by the lower hex), so three factories get one yard, not three.
        /// Industry and energy: a paved service yard and a pipe rack between plants, and one perimeter
        /// fence round the whole works with gates where streets enter. Military: one compound wall,
        /// a shared parade ground and the motor pool between barracks. Farms: fields continue across
        /// the estate, rows all one way, joined by a farm track. Campus: paths and lawns. Commerce: a
        /// pedestrian lane with benches. Homes: a shared footpath and a few trees.
        /// </summary>
        void DistrictLinks(int t)
        {
            if (ActionRts) { ActionLandscaping(t); return; }
            var dist = Districts.At(t);
            if (dist == null || dist.Size < 2 || !ParcelOf(t, out var a, out _, out _)) return;
            var g = world.Grid;
            float cx = g.CenterX(t);
            for (int d = 0; d < 6; d++)
            {
                int n = g.Nb[t * 6 + d];
                if (n < 0 || !Districts.Same(t, n)) continue;
                if (n < t || !ParcelOf(n, out var b, out _, out _)) continue;
                b.x = a.x + g.DxWrap(a.x, b.x);
                float2 from = math.lerp(a, b, 0.28f), to = math.lerp(a, b, 0.72f), mid = (from + to) * 0.5f;
                float len = math.distance(from, to);
                float yaw = Mathf.Atan2(to.x - from.x, to.y - from.y);
                float y = Mathf.Max(Ground(mid.x, mid.y), Mathf.Max(Ground(from.x, from.y), Ground(to.x, to.y)));
                int seed = DistrictPlanner.StableHash(dist.Seed, Math.Min(t, n), Math.Max(t, n));
                math.sincos(yaw, out float sn, out float cs);
                switch (dist.Kind)
                {
                    case DistrictKind.Industrial:
                    case DistrictKind.Energy:
                    case DistrictKind.Extraction:
                        Put(Part.Box, new float3(mid.x, y - 0.01f, mid.y), yaw, new float3(0.34f, 0.016f, len + 0.2f), new float3(0.43f, 0.42f, 0.4f));
                        // a pipe rack on short supports beside the yard
                        float off = 0.13f * (Hash(seed, 1) < 0.5f ? 1 : -1);
                        Put(Part.Box, new float3(mid.x + cs * off, y + 0.08f, mid.y - sn * off), yaw, new float3(0.025f, 0.025f, len + 0.25f), new float3(0.55f, 0.5f, 0.42f));
                        for (int s = 0; s < 3; s++)
                        {
                            float along = (s - 1) * len * 0.4f;
                            Put(Part.Box, new float3(mid.x + cs * off + sn * along, y, mid.y - sn * off + cs * along), yaw, new float3(0.012f, 0.08f, 0.012f), new float3(0.4f, 0.4f, 0.4f));
                        }
                        if (Hash(seed, 2) < 0.5f) Put(Part.Box, new float3(mid.x - cs * off, y, mid.y + sn * off), yaw + 0.1f, new float3(0.11f, 0.05f, 0.05f), Container(seed));
                        break;
                    case DistrictKind.Military:
                        Put(Part.Box, new float3(mid.x, y - 0.01f, mid.y), yaw, new float3(0.32f, 0.014f, len + 0.15f), new float3(0.48f, 0.46f, 0.41f));   // parade ground
                        if (Hash(seed, 3) < 0.7f)
                            for (int s = 0; s < 3; s++) { float along = (s - 1) * 0.09f; var pc = new float2(mid.x + cs * 0.1f + sn * along, mid.y - sn * 0.1f + cs * along); Put(Part.Truck, new float3(pc.x, Ground(pc.x, pc.y), pc.y), yaw + 1.57f, new float3(0.05f), Olive); }
                        break;
                    case DistrictKind.Agricultural:
                    {
                        // fields carry on across the estate, every row in the estate's direction
                        float rows = Hash(dist.Seed, 7) * 3.1416f;
                        for (int s = 0; s < 3; s++)
                        {
                            float3 crop = math.lerp(new float3(0.46f, 0.5f, 0.24f), new float3(0.64f, 0.56f, 0.28f), Hash(seed, 10 + s));
                            var p = math.lerp(from, to, (s + 0.5f) / 3f) + new float2(cs, -sn) * ((Hash(seed, 20 + s) - 0.5f) * 0.2f);
                            Put(Part.Box, new float3(p.x, Ground(p.x, p.y) - 0.01f, p.y), rows, new float3(0.34f, 0.022f, 0.12f), crop);
                        }
                        Put(Part.Box, new float3(mid.x, y - 0.012f, mid.y), yaw, new float3(0.035f, 0.01f, len + 0.3f), new float3(0.5f, 0.43f, 0.32f));   // farm track
                        break;
                    }
                    case DistrictKind.Civic:
                        Put(Part.Box, new float3(mid.x, y - 0.012f, mid.y), yaw, new float3(0.28f, 0.01f, len + 0.2f), new float3(0.34f, 0.47f, 0.27f));   // lawn
                        Put(Part.Box, new float3(mid.x, y - 0.006f, mid.y), yaw, new float3(0.04f, 0.01f, len + 0.25f), new float3(0.62f, 0.6f, 0.55f));    // path
                        for (int s = 0; s < 2; s++) { float side = s == 0 ? 0.1f : -0.1f; Put(Part.Cone, new float3(mid.x + cs * side, y, mid.y - sn * side), yaw, new float3(0.1f, 0.13f, 0.1f), new float3(0.24f, 0.38f, 0.18f)); }
                        break;
                    case DistrictKind.Commercial:
                        Put(Part.Box, new float3(mid.x, y - 0.008f, mid.y), yaw, new float3(0.16f, 0.012f, len + 0.2f), new float3(0.6f, 0.57f, 0.52f));   // pedestrian lane
                        if (Hash(seed, 4) < 0.6f) Put(Part.Box, new float3(mid.x + cs * 0.06f, y + 0.01f, mid.y - sn * 0.06f), yaw, new float3(0.012f, 0.012f, 0.05f), new float3(0.4f, 0.32f, 0.24f));   // a bench
                        break;
                    case DistrictKind.Residential:
                        Put(Part.Box, new float3(mid.x, y - 0.008f, mid.y), yaw, new float3(0.035f, 0.01f, len + 0.15f), new float3(0.58f, 0.56f, 0.52f));   // footpath
                        if (Hash(seed, 5) < 0.55f)
                        {
                            // street trees come in small groups, with gaps
                            int trees = 1 + (int)(Hash(seed, 6) * 3);
                            for (int s = 0; s < trees; s++) { float along = (s - (trees - 1) * 0.5f) * 0.09f, side = 0.06f; var pc = new float2(mid.x + cs * side + sn * along, mid.y - sn * side + cs * along); float hh = 0.08f + Hash(seed, 30 + s) * 0.04f; Put(Part.Cone, new float3(pc.x, Ground(pc.x, pc.y) + hh * 0.4f, pc.y), s, new float3(hh * 1.3f, hh * 1.5f, hh * 1.3f), math.lerp(new float3(0.22f, 0.36f, 0.17f), new float3(0.32f, 0.44f, 0.2f), Hash(seed, 40 + s))); }
                        }
                        break;
                }
            }
            // one perimeter round the works or the compound, with gates where streets come in
            if (dist.Kind == DistrictKind.Industrial || dist.Kind == DistrictKind.Energy || dist.Kind == DistrictKind.Military)
            {
                float cz = g.CenterZ(t);
                bool early = Districts.BuildingAt(dist.Anchor) is BuildingRecord ab && ab.Era == 0;
                float3 fenceCol = dist.Kind == DistrictKind.Military ? (early ? new float3(0.62f, 0.55f, 0.4f) : new float3(0.5f, 0.49f, 0.46f)) : new float3(0.55f, 0.56f, 0.56f);
                float fenceH = dist.Kind == DistrictKind.Military ? 0.06f : 0.04f;
                for (int d = 0; d < 6; d++)
                {
                    int n = g.Nb[t * 6 + d];
                    if (n >= 0 && Districts.Same(t, n)) continue;
                    if (world.RoadClass(t, d) != 0) continue;   // a gate
                    int k = HexMath.PosMod(1 - d, 6), k2 = (k + 1) % 6;
                    float ax = cx + HexMath.CornerX[k] * 0.9f, az = cz + HexMath.CornerZ[k] * 0.9f;
                    float bx = cx + HexMath.CornerX[k2] * 0.9f, bz = cz + HexMath.CornerZ[k2] * 0.9f;
                    float mx = (ax + bx) * 0.5f, mz = (az + bz) * 0.5f;
                    Put(Part.Box, new float3(mx, Ground(mx, mz) - 0.005f, mz), Mathf.Atan2(bx - ax, bz - az), new float3(0.012f, fenceH, Mathf.Sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az))), fenceCol);
                }
            }
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
            // the district this block belongs to sets its vocabulary and age: most infill keeps the
            // district's own era, some is newer (historical layers, organic city design §6.5, §14)
            var district = Districts.At(t);
            styleSeed = district?.Seed ?? seed;
            int anchorEra = district != null && Districts.BuildingAt(district.Anchor) is BuildingRecord ab && ab.Era >= 0 ? ab.Era : Age;
            int era = ActionRts ? (Hash(seed, 2) < .42f ? 1 : 2) : Math.Max(0, Math.Min(4, Hash(seed, 2) < 0.6f ? anchorEra : Age));
            float centrality = urbanNb / 6f;
            float roll = Hash(seed, 1);
            var kind = district?.Kind ?? DistrictKind.Residential;
            var c = new Ctx { X = cx, Z = cz, Yaw = 0, Seed = seed, Tint = new float3(1), Civ = CivColor(world.Owner[t]).xyz, Era = era, Level = 1, Style = styleSeed, Kind = kind };
            // green space where it makes sense (§8.1): a leftover interior block, a spot beside a civic
            // building, or (rarely) anywhere in a dense neighbourhood; a young settlement has none formal
            bool nearCivic = false;
            for (int d = 0; d < 6 && !nearCivic; d++) { int n = g.Nb[t * 6 + d]; nearCivic = n >= 0 && Districts.BuildingAt(n) is BuildingRecord nb && DistrictPlanner.KindOf(nb.Type) == DistrictKind.Civic; }
            float parkChance = 0.03f + (roads == 0 ? 0.22f : 0f) + (urbanNb >= 5 ? 0.04f : 0f);
            if (era >= 1 && nearCivic && roll < (ActionRts ? .07f : .3f) && kind != DistrictKind.Industrial) { Plaza(c); return; }
            if (era >= 1 && roll < parkChance && kind != DistrictKind.Industrial && kind != DistrictKind.Energy) { Park(c); return; }
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
            if (c.Kind == DistrictKind.Industrial || c.Kind == DistrictKind.Energy || c.Kind == DistrictKind.Extraction)
            {
                // light industry infill: workshops with yards, stacked materials, a parked truck
                float w = 0.22f + h01 * 0.08f, h = 0.12f + Hash(seed, 3) * 0.08f;
                Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.7f), c.Era == 0 ? Sheet(seed) : Rust(seed), face);
                Module(c, Part.Roof, lx, lz, new float3(w * 1.02f, 0.05f, w * 0.72f), new float3(0.3f, 0.31f, 0.33f), face, h);
                if (Hash(seed, 4) < 0.5f) Module(c, Part.Box, lx * 1.15f, lz * 1.15f, new float3(0.08f, 0.05f, 0.06f), Container(seed), face + 0.4f);
                if (Hash(seed, 5) < 0.4f) Parked(c, lx * 0.7f, lz * 0.7f, face + 1.57f, seed, true);
                return;
            }
            if (c.Kind == DistrictKind.Commercial && c.Era >= 1)
            {
                // shopfronts on the street: ground-floor awning and sign, a flat or two above
                float w = 0.22f + h01 * 0.05f, h = 0.16f + centrality * 0.18f + Hash(seed, 3) * 0.08f + (c.Era >= 3 ? 0.2f : 0f);
                Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.7f), Stucco(seed), face);
                var awning = Hash(seed, 6) < 0.33f ? new float3(0.74f, 0.26f, 0.2f) : Hash(seed, 6) < 0.66f ? new float3(0.22f, 0.48f, 0.6f) : new float3(0.82f, 0.64f, 0.22f);
                Module(c, Part.Box, lx, lz, new float3(w * 1.06f, 0.012f, w * 0.82f), awning, face, 0.07f);
                if (streetSide) Module(c, Part.Box, lx, lz, new float3(w * 0.6f, 0.03f, w * 0.72f), awning * 1.2f, face, 0.1f, 0.4f);
                return;
            }
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
                    Facade(c, lx, lz, w, w * .75f, h, face, seed);
                    Module(c, Part.Roof, lx, lz, new float3(w * 1.05f, 0.08f, w * 0.8f), HomeRoof(seed), face, h);
                    break;
                }
                case 2:
                {
                    float w = 0.24f + h01 * 0.06f, h = 0.22f + centrality * 0.3f + Hash(seed, 3) * 0.1f;
                    Module(c, Part.Box, lx, lz, new float3(w, h, w * 0.7f), Hash(seed, 5) < 0.4f ? Brick(seed) : Concrete(seed), face);
                    Facade(c, lx, lz, w, w * .7f, h, face, seed);
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
            if (ActionRts)
            {
                Module(c, Part.Concrete, -.06f, .02f, new float3(.032f, .005f, .43f), new float3(.58f, .57f, .52f), .27f);
                Module(c, Part.Tree, -.21f, -.11f, new float3(.17f, .23f, .17f), new float3(.45f, .53f, .38f), .7f);
                if (Hash(c.Seed, 2) < .46f) Module(c, Part.Tree, .16f, .14f, new float3(.13f, .19f, .13f), new float3(.50f, .56f, .42f), 2.4f);
                return;
            }
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
            if (ActionRts) { Park(c); return; }
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
            Module(c, Part.Asphalt, 0, 0, new float3(0.26f, 0.012f, 1.6f), new float3(0.22f, 0.22f, 0.24f));
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

        /// <summary>
        /// Construction in five visible stages (target spec §8.2): survey and ground preparation,
        /// excavation and foundations, structural frame, walls and roof, finishing. A site waiting for
        /// materials or workers is visibly dormant: tarps over the work, the crane parked, no fresh earth.
        /// </summary>
        void ComposeSite(in BuildingRecord b, float cx, float cz, float yaw, int seed)
        {
            int era = b.Era >= 0 ? Math.Min(4, b.Era) : Math.Max(0, Math.Min(4, Age));
            var c = new Ctx { X = cx, Z = cz, Yaw = yaw, Seed = seed, Tint = new float3(1), Civ = CivColor(b.Owner).xyz, Era = era, Level = 1, Scale = parcelScale };
            float prog = Mathf.Clamp01(b.Progress / 100f);
            int stage = Mathf.Min(4, (int)(prog * 5f));
            string st = b.State ?? "";
            bool dormant = st.Contains("wait") || st.Contains("stall") || st.Contains("plan") || st.Contains("paused") || st.Contains("blocked");
            var earth = new float3(0.46f, 0.38f, 0.29f);
            var concrete = new float3(0.62f, 0.6f, 0.56f);
            var steel = new float3(0.5f, 0.42f, 0.32f);
            var scaffoldCol = new float3(0.72f, 0.6f, 0.32f);
            // the cleared plot, fenced, with materials stacked by the gate
            Module(c, Part.Box, 0, 0, new float3(0.95f, 0.012f, 0.75f), dormant ? earth * 0.85f : earth);
            for (int k = 0; k < 4; k++)
            {
                float a = k * Mathf.PI * 0.5f;
                Module(c, Part.Box, Mathf.Cos(a) * 0.47f, Mathf.Sin(a) * 0.37f, new float3(k % 2 == 0 ? 0.012f : 0.92f, 0.035f, k % 2 == 0 ? 0.72f : 0.012f), new float3(0.82f, 0.55f, 0.2f));
            }
            Module(c, Part.Box, -0.38f, 0.28f, new float3(0.14f, 0.05f + prog * 0.03f, 0.1f), era == 0 ? Timber(seed) : concrete * 0.9f);
            switch (stage)
            {
                case 0:
                    // survey stakes and the first spoil heap
                    for (int k = 0; k < 6; k++) Module(c, Part.Box, -0.3f + (k % 3) * 0.3f, k < 3 ? -0.2f : 0.2f, new float3(0.01f, 0.06f, 0.01f), new float3(0.9f, 0.4f, 0.2f));
                    Module(c, Part.Cone, 0.3f, 0.25f, new float3(0.2f, 0.08f, 0.2f), earth * 0.9f);
                    break;
                case 1:
                    // excavated pit and foundation slab
                    Module(c, Part.Box, 0, 0, new float3(0.62f, 0.02f, 0.46f), earth * 0.6f, 0, -0.015f);
                    Module(c, Part.Box, 0, 0, new float3(0.58f, 0.03f, 0.42f), concrete, 0, 0.0f);
                    Module(c, Part.Cone, 0.36f, 0.24f, new float3(0.22f, 0.12f, 0.22f), earth * 0.85f);
                    break;
                default:
                {
                    // the frame rises; walls and roof follow; scaffolding comes down at the end
                    float full = 0.36f;
                    float frameH = stage == 2 ? full * Mathf.InverseLerp(0.4f, 0.6f, prog) + 0.06f : full;
                    Module(c, Part.Box, 0, 0, new float3(0.58f, 0.03f, 0.42f), concrete);
                    for (int k = 0; k < 6; k++)
                        Module(c, Part.Box, -0.26f + (k % 3) * 0.26f, k < 3 ? -0.19f : 0.19f, new float3(0.025f, frameH, 0.025f), era >= 2 ? steel : concrete * 0.95f);
                    for (int f = 1; f <= (int)(frameH / 0.12f); f++)
                        Module(c, Part.Box, 0, 0, new float3(0.56f, 0.015f, 0.4f), concrete * 0.92f, 0, f * 0.12f);
                    if (stage >= 3)
                    {
                        float walls = stage == 3 ? Mathf.InverseLerp(0.6f, 0.8f, prog) : 1f;
                        Module(c, Part.Box, 0, 0, new float3(0.57f, full * walls, 0.41f), era == 0 ? Timber(seed) : era == 1 ? Brick(seed) : Concrete(seed));
                        if (stage == 4) Module(c, Part.Roof, 0, 0, new float3(0.6f, 0.08f, 0.44f), era == 0 ? Sheet(seed) : RoofTone(seed), 0, full);
                    }
                    if (stage <= 3)
                        for (int k = 0; k < 4; k++) Module(c, Part.Box, (k % 2 == 0 ? -1 : 1) * 0.32f, (k < 2 ? -1 : 1) * 0.24f, new float3(0.012f, full + 0.08f, 0.012f), scaffoldCol);
                    break;
                }
            }
            if (dormant)
            {
                // nothing moving: the work is covered and the crane is parked low
                Module(c, Part.Box, 0, 0, new float3(0.6f, 0.012f, 0.44f), Tarp(seed), 0.05f, 0.04f + prog * 0.3f);
                Module(c, Part.Crane, 0.42f, 0.3f, new float3(0.45f, 0.35f, 0.45f), new float3(0.65f, 0.65f, 0.65f), 0f);
            }
            else if (stage >= 1 && stage <= 3)
                Module(c, Part.Crane, 0.42f, 0.3f, new float3(0.55f, 0.5f + prog * 0.25f, 0.55f), new float3(1, 1, 1), Hash(seed, 2) * 3);
        }

        /// <summary>
        /// Upgrades change the building, not just a number (target spec §8.1): level 2 adds a second
        /// hall or wing in the building's own materials; level 3 adds storage, loading infrastructure or
        /// reinforcement. Military sites gain revetments and a hardened block instead.
        /// </summary>
        void UpgradeExtras(in Ctx c, string type)
        {
            bool military = type == "barracks" || type == "fort" || type == "camp" || type == "guard_post" || type == "bunker" || type == "aa_battery";
            bool civic = type == "academy" || type == "university" || type == "market";
            float3 wall = military ? Olive : civic ? Stucco(c.Seed) : c.Era == 0 ? Sheet(c.Seed) : c.Era >= 2 ? Rust(c.Seed) : Brick(c.Seed);
            if (military)
            {
                var sand = new float3(0.62f, 0.55f, 0.4f);
                for (int k = 0; k < 3; k++) Module(c, Part.Box, -0.55f + k * 0.28f, 0.6f, new float3(0.24f, 0.06f, 0.06f), sand, (Hash(c.Seed, 300 + k) - 0.5f) * 0.3f);
                if (c.Level >= 3) Module(c, Part.Box, 0.55f, 0.5f, new float3(0.26f, 0.12f, 0.22f), new float3(0.52f, 0.51f, 0.48f));
                return;
            }
            Module(c, Part.Box, -0.52f, 0.5f, new float3(0.3f, 0.16f + c.Era * 0.02f, 0.24f), wall);
            Module(c, Part.Roof, -0.52f, 0.5f, new float3(0.32f, 0.06f, 0.26f), civic ? Copper : new float3(0.3f, 0.3f, 0.32f), 0, 0.16f + c.Era * 0.02f);
            if (c.Level >= 3)
            {
                if (civic) Module(c, Part.Dome, 0.52f, 0.5f, new float3(0.2f, 0.16f, 0.2f), Copper, 0, 0.12f);
                else
                {
                    for (int k = 0; k < 2; k++) Module(c, Part.Silo, 0.5f + k * 0.15f, -0.55f, new float3(0.12f, 0.24f, 0.12f), new float3(0.66f, 0.66f, 0.64f));
                    Module(c, Part.Box, 0.5f, 0.55f, new float3(0.3f, 0.02f, 0.18f), new float3(0.42f, 0.41f, 0.39f));   // a loading apron
                    Module(c, Part.Box, 0.52f, 0.55f, new float3(0.12f, 0.05f, 0.08f), Container(c.Seed + 9));
                }
            }
        }

        /// <summary>
        /// Visible damage by band (target spec §8.3): light damage scorches and scatters debris; heavy
        /// damage tears out sections and heaps rubble; critical damage leaves broken walls standing in
        /// the wreckage. Deterministic per building, so it looks the same after a reload.
        /// </summary>
        void DamageOverlay(in BuildingRecord b, float cx, float cz, float yaw, int seed)
        {
            int band = StructureStore.DamageBand(b.Hp);
            if (band == 0 || !b.Done) return;
            var c = new Ctx { X = cx, Z = cz, Yaw = yaw, Seed = seed, Tint = new float3(1), Civ = new float3(0.5f), Era = 1, Level = 1, Scale = parcelScale };
            var soot = new float3(0.12f, 0.11f, 0.1f);
            var rubble = new float3(0.46f, 0.43f, 0.39f);
            int scorch = band * 2;
            for (int k = 0; k < scorch; k++)
            {
                float a = Hash(seed, 200 + k) * 6.28f, r = 0.15f + Hash(seed, 210 + k) * 0.45f;
                Module(c, Part.Box, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(0.12f + Hash(seed, 220 + k) * 0.1f, 0.006f, 0.1f), soot, a, 0.01f);
            }
            int heaps = band == 1 ? 2 : band == 2 ? 4 : 7;
            for (int k = 0; k < heaps; k++)
            {
                float a = Hash(seed, 230 + k) * 6.28f, r = 0.3f + Hash(seed, 240 + k) * 0.35f;
                float s = (0.08f + Hash(seed, 250 + k) * 0.06f) * (0.7f + band * 0.25f);
                Module(c, Part.Cone, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(s * 1.6f, s * 0.6f, s * 1.6f), rubble * (0.85f + 0.2f * Hash(seed, 260 + k)));
            }
            if (band >= 2)
                for (int k = 0; k < band - 1; k++)
                    Module(c, Part.Broken, (Hash(seed, 270 + k) - 0.5f) * 0.6f, (Hash(seed, 280 + k) - 0.5f) * 0.5f, new float3(0.18f, 0.12f + band * 0.06f, 0.14f), rubble * 0.9f, Hash(seed, 290 + k) * 3f);
        }

        public void Draw(WrapImages images)
        {
            foreach (var cell in cells.Values)
            {
                if (!cell.Any) continue;
                foreach (var b in cell.Batches) b.DrawImages(images);
                cell.StreetBatch?.DrawImages(images);
            }
            DrawGhost(images);
            activityBoxes?.DrawImages(images);
            activityRotors?.DrawImages(images); activityDishes?.DrawImages(images);
        }

        void DisposeCell(Cell c)
        {
            foreach (var b in c.Batches) b?.Dispose();
            c.StreetBatch?.Dispose();
            if (c.Streets != null) UnityEngine.Object.Destroy(c.Streets);
        }

        public void Dispose()
        {
            foreach (var c in cells.Values) DisposeCell(c);
            if (ghost != null) DisposeCell(ghost);
            cells.Clear();
            activityBoxes?.Dispose();
            activityRotors?.Dispose(); activityDishes?.Dispose();
        }
    }
}
