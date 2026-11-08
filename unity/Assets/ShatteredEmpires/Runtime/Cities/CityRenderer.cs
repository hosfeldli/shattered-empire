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
        enum Part { Box, Roof, Cylinder, Cone, Skyscraper, Silo, Chimney, Crane, Count }

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
                hasBuilding = new bool[world.Grid.N];
                roadRevision = -1;
            }
            if (roadRevision != world.RoadRevision)
            {
                roadRevision = world.RoadRevision;
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
                Mesh[] meshes = { MeshKit.Box, MeshKit.Roof, MeshKit.Cylinder, MeshKit.Cone, MeshKit.Skyscraper, MeshKit.Silo, MeshKit.Chimney, MeshKit.Crane };
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

        static float Hash(int a, int b)
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
                    if (world.Road[t] != 0) for (int d = 0; d < 6; d++) ComposeRoad(t, d);
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

        void ComposeRoad(int t, int d)
        {
            int cls = world.RoadClass(t, d);
            if (cls == 0) return;
            var g = world.Grid;
            int nb = g.Nb[t * 6 + d];
            if (nb < 0 || nb < t) return;
            bool broken = world.RoadBroken(t, d);
            float ax = g.CenterX(t), az = g.CenterZ(t);
            float bx = ax + g.DxWrap(ax, g.CenterX(nb)), bz = g.CenterZ(nb);
            bool bridge = world.IsRiver(t) || world.IsRiver(nb) || world.View.Water[t] > -1e8f || world.View.Water[nb] > -1e8f;
            float width = cls == 1 ? 0.075f : cls == 2 ? 0.11f : cls == 3 ? 0.16f : 0.07f;
            float3 color = cls == 1 ? new float3(0.42f, 0.36f, 0.27f) : cls == 4 ? new float3(0.3f, 0.26f, 0.22f) : new float3(0.24f, 0.24f, 0.25f);
            if (broken) color *= 0.55f;
            float yaw = Mathf.Atan2(bx - ax, bz - az);
            const int pieces = 6;
            float deck = -1e9f;
            if (bridge)
            {
                float wa = Mathf.Max(world.View.Water[t], world.Height[t]), wb = Mathf.Max(world.View.Water[nb], world.Height[nb]);
                deck = Mathf.Max(wa, wb) + 0.06f;
            }
            float len = Mathf.Sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
            for (int k = 0; k < pieces; k++)
            {
                if (broken && k % 2 == 1) continue;
                float t0 = (k + 0.5f) / pieces;
                float x = Mathf.Lerp(ax, bx, t0), z = Mathf.Lerp(az, bz, t0);
                // sample the ground across the road's width, so it never sinks into a slope
                float y = Mathf.Max(Ground(x, z), Mathf.Max(Ground(x + 0.06f, z), Ground(x - 0.06f, z)));
                if (bridge) y = Mathf.Max(y, deck);
                float segLen = len / pieces * 1.08f;
                Put(Part.Box, new float3(x, y + 0.004f, z), yaw, new float3(width, 0.012f, segLen), color);
                if (cls == 2 || cls == 3)
                {
                    // kerbs on paved roads (lifted with the road, so they never clip in and out)
                    float side = width * 0.55f;
                    math.sincos(yaw, out float sn, out float csn);
                    Put(Part.Box, new float3(x + csn * side, y + 0.006f, z - sn * side), yaw, new float3(0.018f, 0.014f, segLen), new float3(0.52f, 0.5f, 0.47f));
                    Put(Part.Box, new float3(x - csn * side, y + 0.006f, z + sn * side), yaw, new float3(0.018f, 0.014f, segLen), new float3(0.52f, 0.5f, 0.47f));
                }
                if (bridge && k % 2 == 0)
                {
                    float floor = Mathf.Min(Ground(x, z), y) - 0.2f;
                    Put(Part.Box, new float3(x, floor, z), yaw, new float3(width * 0.4f, y - floor, 0.03f), new float3(0.4f, 0.38f, 0.36f));
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
            switch (b.Type)
            {
                case "house": House(ctx); break;
                case "town": Centre(ctx); break;
                case "farm": Farm(ctx); break;
                case "barracks": case "fort": case "camp": Base(ctx, b.Type == "fort"); break;
                case "academy": case "university": Campus(ctx, b.Type == "university"); break;
                case "power_plant": Power(ctx, false); break;
                case "fusion_plant": Power(ctx, true); break;
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

        static float3 Brick(int seed) => math.lerp(new float3(0.55f, 0.36f, 0.28f), new float3(0.68f, 0.56f, 0.44f), Hash(seed, 9));
        static float3 Concrete(int seed) => math.lerp(new float3(0.58f, 0.57f, 0.55f), new float3(0.72f, 0.7f, 0.66f), Hash(seed, 10));
        static float3 RoofTone(int seed) => math.lerp(new float3(0.36f, 0.2f, 0.16f), new float3(0.3f, 0.32f, 0.34f), Hash(seed, 11));

        void House(in Ctx c)
        {
            if (c.Level >= 3)
            {
                if (c.Era >= 3)
                {
                    // late eras: residential towers, much taller than the blocks they replace
                    int towers = 2 + (int)(Hash(c.Seed, 1) * 2);
                    for (int k = 0; k < towers; k++)
                    {
                        float a = k * 6.283f / towers + Hash(c.Seed, k) * 0.5f;
                        float h = 0.9f + Hash(c.Seed, 20 + k) * 0.9f + (c.Era - 3) * 0.6f;
                        Module(c, Part.Skyscraper, Mathf.Cos(a) * 0.42f, Mathf.Sin(a) * 0.42f, new float3(0.34f, h, 0.34f), math.lerp(Concrete(c.Seed + k), c.Civ, 0.08f));
                    }
                    Module(c, Part.Box, 0, 0, new float3(0.6f, 0.08f, 0.6f), Concrete(c.Seed) * 0.9f);
                    return;
                }
                // an apartment complex: three or four large blocks around a courtyard
                int blocks = 3 + (int)(Hash(c.Seed, 2) * 2);
                for (int k = 0; k < blocks; k++)
                {
                    float a = k * 6.283f / blocks;
                    float h = 0.36f + Hash(c.Seed, 30 + k) * 0.22f + c.Era * 0.06f;
                    float3 col = c.Era >= 2 ? Concrete(c.Seed + k) : Brick(c.Seed + k);
                    Module(c, Part.Box, Mathf.Cos(a) * 0.48f, Mathf.Sin(a) * 0.48f, new float3(0.62f, h, 0.3f), col, a + Mathf.PI * 0.5f);
                    if (c.Era < 2) Module(c, Part.Roof, Mathf.Cos(a) * 0.48f, Mathf.Sin(a) * 0.48f, new float3(0.64f, 0.1f, 0.32f), RoofTone(c.Seed), a + Mathf.PI * 0.5f, h);
                }
                return;
            }
            if (c.Level == 2)
            {
                // terraced rows along the street
                for (int row = 0; row < 2; row++)
                {
                    float z = row == 0 ? -0.32f : 0.32f;
                    float h = 0.2f + Hash(c.Seed, row) * 0.06f;
                    Module(c, Part.Box, 0, z, new float3(0.95f, h, 0.24f), Brick(c.Seed + row));
                    Module(c, Part.Roof, 0, z, new float3(0.97f, 0.1f, 0.26f), RoofTone(c.Seed + row), 0, h);
                }
                return;
            }
            // cottages: three to five, irregularly set
            int n = 3 + (int)(Hash(c.Seed, 5) * 3);
            for (int k = 0; k < n; k++)
            {
                float a = Hash(c.Seed, 40 + k) * 6.283f, r = 0.25f + Hash(c.Seed, 50 + k) * 0.45f;
                float w = 0.16f + Hash(c.Seed, 60 + k) * 0.06f, h = 0.11f + Hash(c.Seed, 70 + k) * 0.04f;
                float rot = Hash(c.Seed, 80 + k) < 0.5f ? 0 : Mathf.PI * 0.5f;
                Module(c, Part.Box, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(w, h, w * 0.8f), c.Era == 0 ? new float3(0.55f, 0.47f, 0.36f) : Brick(c.Seed + k), rot);
                Module(c, Part.Roof, Mathf.Cos(a) * r, Mathf.Sin(a) * r, new float3(w * 1.08f, 0.08f, w * 0.86f), RoofTone(c.Seed + k), rot, h);
            }
        }

        void Centre(in Ctx c)
        {
            // the civic heart: a plaza, a hall with a tower, and a skyline that grows with era and tier
            Module(c, Part.Box, 0, 0, new float3(1.3f, 0.03f, 1.3f), new float3(0.62f, 0.6f, 0.56f));
            Module(c, Part.Box, 0, -0.3f, new float3(0.8f, 0.34f, 0.42f), Concrete(c.Seed));
            Module(c, Part.Box, 0, -0.3f, new float3(0.2f, 0.75f, 0.2f), new float3(0.7f, 0.66f, 0.6f));
            Module(c, Part.Cone, 0, -0.3f, new float3(0.22f, 0.2f, 0.22f), math.lerp(new float3(0.3f, 0.36f, 0.34f), c.Civ, 0.4f), 0, 0.75f);
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
                var col = math.lerp(new float3(0.42f, 0.44f, 0.34f), c.Civ, 0.12f);
                Module(c, Part.Box, -0.38f, z, new float3(0.5f, 0.13f, 0.22f), col);
                Module(c, Part.Roof, -0.38f, z, new float3(0.52f, 0.07f, 0.24f), new float3(0.3f, 0.32f, 0.3f), 0, 0.13f);
            }
            if (c.Era >= 1)
                for (int k = 0; k < 4; k++) Module(c, Part.Box, 0.35f + (k % 2) * 0.2f, 0.4f + (k / 2) * 0.18f, new float3(0.09f, 0.05f, 0.15f), new float3(0.33f, 0.35f, 0.28f));
            Module(c, Part.Cylinder, 0.55f, -0.5f, new float3(0.02f, 0.45f, 0.02f), new float3(0.6f, 0.6f, 0.6f));
            Module(c, Part.Box, 0.6f, -0.5f, new float3(0.1f, 0.06f, 0.005f), c.Civ, 0, 0.38f);
        }

        void Campus(in Ctx c, bool university)
        {
            Module(c, Part.Box, 0, -0.3f, new float3(0.9f, 0.26f, 0.32f), new float3(0.72f, 0.66f, 0.56f));
            Module(c, Part.Roof, 0, -0.3f, new float3(0.92f, 0.1f, 0.34f), new float3(0.34f, 0.36f, 0.36f), 0, 0.26f);
            for (int k = 0; k < 5; k++) Module(c, Part.Cylinder, -0.32f + k * 0.16f, -0.1f, new float3(0.035f, 0.24f, 0.035f), new float3(0.82f, 0.8f, 0.76f));
            Module(c, Part.Box, -0.5f, 0.35f, new float3(0.3f, 0.2f, 0.45f), new float3(0.66f, 0.6f, 0.52f));
            Module(c, Part.Box, 0.5f, 0.35f, new float3(0.3f, university ? 0.32f : 0.2f, 0.45f), new float3(0.66f, 0.6f, 0.52f));
            if (university)
            {
                Module(c, Part.Box, 0, 0.55f, new float3(0.14f, 0.7f, 0.14f), new float3(0.7f, 0.66f, 0.6f));
                Module(c, Part.Cone, 0, 0.55f, new float3(0.18f, 0.2f, 0.18f), new float3(0.3f, 0.38f, 0.36f), 0, 0.7f);
            }
            // paved paths across the quad instead of a mismatched lawn
            Module(c, Part.Box, 0, 0.2f, new float3(0.1f, 0.012f, 0.6f), new float3(0.6f, 0.58f, 0.54f));
        }

        void Industry(in Ctx c)
        {
            var wallColor = c.Era >= 2 ? Concrete(c.Seed) : Brick(c.Seed);
            int sheds = 2 + (int)(Hash(c.Seed, 1) * 2);
            for (int k = 0; k < sheds; k++)
            {
                float z = -0.45f + k * 0.42f;
                Module(c, Part.Box, -0.15f, z, new float3(0.9f, 0.24f + c.Era * 0.03f, 0.34f), wallColor);
                // sawtooth roof
                for (int t = 0; t < 4; t++) Module(c, Part.Roof, -0.5f + t * 0.24f, z, new float3(0.24f, 0.08f, 0.34f), new float3(0.36f, 0.36f, 0.38f), Mathf.PI * 0.5f, 0.24f + c.Era * 0.03f);
            }
            int stacks = 1 + (int)(Hash(c.Seed, 2) * 3);
            for (int k = 0; k < stacks; k++) Module(c, Part.Chimney, 0.5f, -0.4f + k * 0.25f, new float3(0.08f, 0.7f + Hash(c.Seed, k) * 0.3f, 0.08f), new float3(0.48f, 0.4f, 0.36f));
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
            Module(c, Part.Box, -0.3f, 0, new float3(0.6f, 0.32f, 0.5f), Concrete(c.Seed));
            Module(c, Part.Cylinder, 0.45f, -0.35f, new float3(0.42f, 0.55f, 0.42f), new float3(0.7f, 0.69f, 0.66f));
            Module(c, Part.Cylinder, 0.45f, 0.35f, new float3(0.42f, 0.55f, 0.42f), new float3(0.7f, 0.69f, 0.66f));
            Module(c, Part.Chimney, -0.5f, 0.35f, new float3(0.09f, 0.9f, 0.09f), new float3(0.52f, 0.42f, 0.38f));
        }

        void Airfield(in Ctx c)
        {
            Module(c, Part.Box, 0, 0, new float3(0.26f, 0.012f, 1.6f), new float3(0.22f, 0.22f, 0.24f));
            for (int k = 0; k < 6; k++) Module(c, Part.Box, 0, -0.65f + k * 0.26f, new float3(0.02f, 0.014f, 0.1f), new float3(0.9f, 0.9f, 0.85f));
            Module(c, Part.Box, 0.55f, -0.3f, new float3(0.36f, 0.2f, 0.4f), new float3(0.5f, 0.52f, 0.5f));
            Module(c, Part.Cylinder, 0.55f, -0.3f, new float3(0.36f, 0.2f, 0.4f), new float3(0.46f, 0.48f, 0.46f), Mathf.PI * 0.5f, 0.1f);
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
                    var awning = math.lerp(new float3(0.7f, 0.3f, 0.2f), new float3(0.3f, 0.5f, 0.6f), Hash(c.Seed, k));
                    Module(c, Part.Box, x, z, new float3(0.28f, 0.1f, 0.2f), Brick(c.Seed + k));
                    Module(c, Part.Roof, x, z, new float3(0.3f, 0.06f, 0.22f), awning, 0, 0.1f);
                }
                return;
            }
            for (int k = 0; k < 3; k++)
            {
                Module(c, Part.Box, 0, -0.5f + k * 0.5f, new float3(1f, 0.2f, 0.36f), Concrete(c.Seed + k));
                Module(c, Part.Cylinder, 0, -0.5f + k * 0.5f, new float3(1f, 0.12f, 0.36f), new float3(0.48f, 0.5f, 0.5f), Mathf.PI * 0.5f, 0.14f);
            }
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
                    Module(c, Part.Box, -0.3f, 0, new float3(0.4f, 0.18f, 0.3f), new float3(0.46f, 0.42f, 0.36f));
                    Module(c, Part.Crane, 0.2f, -0.2f, new float3(0.5f, 0.45f, 0.5f), new float3(0.6f, 0.5f, 0.3f));
                    for (int k = 0; k < 3; k++) Module(c, Part.Cone, 0.35f + k * 0.12f, 0.35f, new float3(0.24f, 0.14f, 0.24f), new float3(0.45f, 0.42f, 0.38f));
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
