using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;

namespace SE.Runtime.Cities
{
    /// <summary>What a district is for (organic city design §5).</summary>
    public enum DistrictKind : byte { None, Residential, Commercial, Civic, Industrial, Energy, Extraction, Agricultural, Military, Air, Port }

    /// <summary>A district: compatible, connected buildings that read as one place.</summary>
    public sealed class District
    {
        public int Id;               // stable: the id of its oldest building
        public DistrictKind Kind;
        public int Owner;
        public int Seed;             // stable per district (world seed, oldest building)
        public readonly List<int> Tiles = new List<int>();
        public int Anchor = -1;      // the oldest building's tile (farmstead, compound HQ, campus core)
        public int Size => Tiles.Count;
    }

    /// <summary>
    /// The district layer of the city composition engine (organic city design §2, §5, §15). From the
    /// authoritative buildings and roads it groups neighbouring buildings into districts with the
    /// affinity score A = wF·F + wR·R + wN·N + wH·H − wB·B (function compatibility, street connection,
    /// proximity, shared history, barriers), keeps each district's identity stable as the city grows
    /// (a district is named after its oldest building, so adding a house never re-rolls a neighbourhood),
    /// and reports which hexes changed character so only those are recomposed.
    /// Presentation only: districts never change ownership, production or passability.
    /// </summary>
    public sealed unsafe class DistrictPlanner
    {
        readonly WorldModel world;
        readonly StructureStore structures;
        int[] districtOf = Array.Empty<int>();        // tile -> district id (0: none)
        int[] signature = Array.Empty<int>();         // tile -> composition signature (what the hex's look depends on)
        readonly Dictionary<int, District> districts = new Dictionary<int, District>();
        readonly Dictionary<int, BuildingRecord> byTile = new Dictionary<int, BuildingRecord>();
        int structRev = -1, layoutRev = -1, roadRev = -1, epoch = -1;
        public int WorldSeed;

        // affinity weights and the joining threshold (tuned on generated cities)
        const float WF = 1.0f, WR = 0.6f, WN = 0.4f, WH = 0.3f, WB = 1.2f, Join = 1.05f;

        public DistrictPlanner(WorldModel w, StructureStore s) { world = w; structures = s; }

        public static DistrictKind KindOf(string type)
        {
            switch (type)
            {
                case "house": return DistrictKind.Residential;
                case "market": case "depot": return DistrictKind.Commercial;
                case "town": case "academy": case "university": case "comms_tower": case "wonder": case "advanced_lab": return DistrictKind.Civic;
                case "steel_mill": case "refinery": case "munitions_plant": case "motor_works": case "heavy_assembly": case "electronics_plant":
                case "drone_works": case "robotics_complex": case "salvage": return DistrictKind.Industrial;
                case "power_plant": case "fusion_plant": case "nuclear_plant": case "shield_generator": return DistrictKind.Energy;
                case "mine": case "quarry": case "lumber": case "oil_well": return DistrictKind.Extraction;
                case "farm": return DistrictKind.Agricultural;
                case "barracks": case "fort": case "camp": case "guard_post": case "bunker": case "aa_battery": case "missile_silo":
                case "armory": case "defense_works": case "turret": case "repair_point": return DistrictKind.Military;
                case "airfield": return DistrictKind.Air;
                case "port": return DistrictKind.Port;
                default: return DistrictKind.Industrial;
            }
        }

        /// <summary>F: how well two uses belong together (1 same, 0.6 compatible, 0 neutral, negative clash).</summary>
        public static float Compatibility(DistrictKind a, DistrictKind b)
        {
            if (a == b) return 1f;
            bool Pair(DistrictKind x, DistrictKind y) => (a == x && b == y) || (a == y && b == x);
            if (Pair(DistrictKind.Residential, DistrictKind.Commercial) || Pair(DistrictKind.Residential, DistrictKind.Civic) || Pair(DistrictKind.Commercial, DistrictKind.Civic)) return 0.6f;
            if (Pair(DistrictKind.Industrial, DistrictKind.Energy) || Pair(DistrictKind.Industrial, DistrictKind.Extraction) || Pair(DistrictKind.Energy, DistrictKind.Extraction)) return 0.6f;
            if (Pair(DistrictKind.Commercial, DistrictKind.Port) || Pair(DistrictKind.Industrial, DistrictKind.Port)) return 0.4f;
            if (Pair(DistrictKind.Military, DistrictKind.Air)) return 0.6f;
            if (Pair(DistrictKind.Residential, DistrictKind.Industrial) || Pair(DistrictKind.Residential, DistrictKind.Energy) || Pair(DistrictKind.Civic, DistrictKind.Industrial)) return -0.6f;
            return 0f;
        }

        public District At(int tile) => tile >= 0 && tile < districtOf.Length && districtOf[tile] != 0 && districts.TryGetValue(districtOf[tile], out var d) ? d : null;
        public int DistrictId(int tile) => tile >= 0 && tile < districtOf.Length ? districtOf[tile] : 0;
        public bool Same(int a, int b) => a >= 0 && b >= 0 && DistrictId(a) != 0 && DistrictId(a) == DistrictId(b);
        public BuildingRecord? BuildingAt(int tile) => byTile.TryGetValue(tile, out var b) ? b : (BuildingRecord?)null;
        public IEnumerable<District> All => districts.Values;

        /// <summary>
        /// Rebuild the district graph when buildings or roads changed. Adds the render cells whose
        /// composition signature changed to <paramref name="dirtyCells"/> (local updates only).
        /// </summary>
        public void Update(HashSet<int> dirtyCells)
        {
            if (!world.Ready) return;
            var g = world.Grid;
            bool reset = epoch != world.Epoch || districtOf.Length != g.N;
            if (!reset && structRev == structures.Revision && layoutRev == world.LayoutRevision && roadRev == world.RoadRevision) return;
            if (reset) { districtOf = new int[g.N]; signature = new int[g.N]; epoch = world.Epoch; }
            structRev = structures.Revision; layoutRev = world.LayoutRevision; roadRev = world.RoadRevision;

            byTile.Clear();
            foreach (var b in structures.Buildings.Values) if (b.Tile >= 0 && b.Tile < g.N) byTile[b.Tile] = b;

            // union-find over neighbouring buildings with enough affinity
            var parent = new Dictionary<int, int>(byTile.Count);
            int Find(int x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
            foreach (var t in byTile.Keys) parent[t] = t;
            foreach (var kv in byTile)
            {
                int t = kv.Key; var a = kv.Value;
                var ka = KindOf(a.Type);
                for (int d = 0; d < 6; d++)
                {
                    int n = g.Nb[t * 6 + d];
                    if (n < 0 || n < t || !byTile.TryGetValue(n, out var b) || b.Owner != a.Owner) continue;
                    float f = Compatibility(ka, KindOf(b.Type));
                    float r = world.RoadClass(t, d) != 0 ? 1f : 0f;
                    float h = a.Era >= 0 && a.Era == b.Era ? 1f : 0f;
                    // a river or open water between two buildings without a crossing separates them
                    bool wet = world.IsRiver(t) || world.IsRiver(n) || world.View.Water[t] > -1e8f || world.View.Water[n] > -1e8f;
                    float barrier = wet && r == 0f ? 1f : 0f;
                    float affinity = WF * f + WR * r + WN * 1f + WH * h - WB * barrier;
                    if (affinity >= Join) { int ra = Find(t), rb = Find(n); if (ra != rb) parent[ra] = rb; }
                }
            }
            // districts named after their oldest building: stable as the city grows
            var groups = new Dictionary<int, List<int>>();
            foreach (var t in byTile.Keys) { int root = Find(t); if (!groups.TryGetValue(root, out var l)) groups[root] = l = new List<int>(); l.Add(t); }
            districts.Clear();
            Array.Clear(districtOf, 0, districtOf.Length);
            foreach (var l in groups.Values)
            {
                int oldest = l[0];
                foreach (var t in l) if (byTile[t].Id < byTile[oldest].Id) oldest = t;
                var anchor = byTile[oldest];
                // the district's kind: the most common use among its members, ties to the oldest
                var counts = new Dictionary<DistrictKind, int>();
                foreach (var t in l) { var k = KindOf(byTile[t].Type); counts[k] = counts.TryGetValue(k, out int c) ? c + 1 : 1; }
                var kind = KindOf(anchor.Type); int best = counts[kind];
                foreach (var kv in counts) if (kv.Value > best) { best = kv.Value; kind = kv.Key; }
                var dist = new District { Id = anchor.Id, Kind = kind, Owner = anchor.Owner, Anchor = oldest, Seed = StableHash(WorldSeed, anchor.Id, 1) };
                dist.Tiles.AddRange(l);
                districts[dist.Id] = dist;
                foreach (var t in l) districtOf[t] = dist.Id;
            }
            // developed hexes without a building of their own belong to the district most of their neighbours do
            for (int t = 0; t < g.N; t++)
            {
                if (districtOf[t] != 0 || !world.IsUrban(t)) continue;
                int pick = 0, votes = 0;
                for (int d = 0; d < 6; d++)
                {
                    int n = g.Nb[t * 6 + d]; if (n < 0 || !byTile.ContainsKey(n)) continue;
                    int id = districtOf[n], v = 0;
                    for (int e = 0; e < 6; e++) { int m = g.Nb[t * 6 + e]; if (m >= 0 && byTile.ContainsKey(m) && districtOf[m] == id) v++; }
                    if (v > votes) { votes = v; pick = id; }
                }
                districtOf[t] = pick;
            }
            // what each hex's look depends on: its district's identity and which neighbours share it
            for (int t = 0; t < g.N; t++)
            {
                int sig = 0;
                if (districtOf[t] != 0)
                {
                    var dd = districts.TryGetValue(districtOf[t], out var x) ? x : null;
                    sig = unchecked(districtOf[t] * 31 + (int)(dd?.Kind ?? 0) * 7 + (dd?.Anchor == t ? 1 : 0) + Math.Min(6, dd?.Size ?? 0) * 3);
                    int mask = 0;
                    for (int d = 0; d < 6; d++) { int n = g.Nb[t * 6 + d]; if (n >= 0 && districtOf[n] == districtOf[t]) mask |= 1 << d; }
                    sig = unchecked(sig * 64 + mask);
                }
                if (sig != signature[t]) { signature[t] = sig; if (!reset) dirtyCells?.Add(world.ChunkOf(t)); }
            }
        }

        /// <summary>A stable, platform-independent hash (never the runtime's string or object hash).</summary>
        public static int StableHash(int a, int b, int c)
        {
            unchecked
            {
                uint h = 2166136261u;
                h = (h ^ (uint)a) * 16777619u; h ^= h >> 15;
                h = (h ^ (uint)b) * 16777619u; h ^= h >> 13;
                h = (h ^ (uint)c) * 16777619u; h ^= h >> 16;
                return (int)(h & 0x7fffffff);
            }
        }
    }
}
