using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;

namespace SE.Core.Stress
{
    /// <summary>
    /// Server-representative activity for the stress scene: a developed city of several hundred
    /// buildings with construction, damage and growth; two armies of mixed types (1,000 units by
    /// default) manoeuvring and fighting across a front; artillery impacts. It emits the same wire
    /// records a match does: 's' messages at 5 Hz using udelta semantics (changed records only, ids
    /// that left view, a full set every 50 snapshots), economy blocks with the building list once a
    /// second, and combat events.
    /// </summary>
    public sealed class StressScenario
    {
        struct SimUnit
        {
            public int Id, Owner, Tile, Next, Goal, Hp;
            public float Prog, Speed;
            public string Type;
            public bool Air;
        }

        static readonly string[] GroundMix =
        {
            "rifle_squad", "rifle_squad", "rifle_squad", "militia", "mortar_team", "mech_infantry", "tank", "tank", "armored_car",
            "field_gun", "sp_artillery", "air_defense", "supply_truck", "engineer", "special_forces", "exo_infantry", "autonomous_tank",
            "missile_battery", "scout_buggy",
        };
        static readonly string[] AirMix = { "helicopter", "fighter", "bomber", "recon_drone", "oneway_drone", "strike_swarm" };
        static readonly string[] CityMix =
        {
            "house", "house", "house", "house", "house", "house", "farm", "farm", "lumber", "quarry", "mine", "steel_mill", "power_plant",
            "munitions_plant", "motor_works", "heavy_assembly", "barracks", "academy", "university", "market", "depot", "refinery",
            "electronics_plant", "comms_tower", "guard_post", "bunker", "aa_battery", "airfield", "oil_well",
        };

        readonly List<SimUnit> units = new List<SimUnit>();
        readonly List<BuildingRecord> buildings = new List<BuildingRecord>();
        readonly Dictionary<int, long> sentKey = new Dictionary<int, long>();
        readonly List<CombatEvent> pendingEvents = new List<CombatEvent>();
        readonly Random rng;
        HexGrid g;
        WorldModel world;
        int nextUnitId = 1, nextBuildingId = 1, snapshots, eventSeq, tick;
        float time, snapAt, econAt, buildAt, damageAt, fireAt;

        public int CityTile { get; private set; }
        public int ArenaTile { get; private set; }
        public int UnitCount => units.Count;
        public int BuildingCount => buildings.Count;

        public StressScenario(int seed) { rng = new Random(seed); }

        // presentation records a real match would carry: trench lines, old-world ruins, shelled ground, weather
        readonly List<TrenchRecord> trenches = new List<TrenchRecord>();
        readonly List<RuinRecord> ruins = new List<RuinRecord>();
        readonly Dictionary<int, float> intensity = new Dictionary<int, float>();
        readonly Dictionary<int, float> craters = new Dictionary<int, float>();
        float weatherAt, weatherPhase;

        void DigTrenchLines()
        {
            // two opposing WW1-style lines across the front, facing each other, with the hexes linked
            for (int side = 0; side < 2; side++)
            {
                int anchor = WalkEast(ArenaTile, side == 0 ? -4 : 6);
                int t = anchor;
                for (int k = 0; k < 7; k++) t = g.Nb[t * 6 + 2] >= 0 ? g.Nb[t * 6 + 2] : t;   // walk north-west
                var line = new List<int>();
                for (int k = 0; k < 14; k++)
                {
                    if (!world.IsSea(t) && !world.IsLake(t)) line.Add(t);
                    int nx = g.Nb[t * 6 + (k % 2 == 0 ? 4 : 5)];                                // south-west / south-east zig-zag
                    if (nx < 0) break;
                    t = nx;
                }
                for (int k = 0; k < line.Count; k++)
                {
                    int route = 0;
                    for (int d = 0; d < 6; d++) { int n = g.Nb[line[k] * 6 + d]; if (n >= 0 && line.Contains(n)) route |= 1 << d; }
                    trenches.Add(new TrenchRecord { Tile = line[k], Owner = side, Reinforced = k % 4 == 0, Dir = side == 0 ? 0 : 3, Progress = k < line.Count - 2 ? 100 : 60, Hp = 100, Route = route });
                }
            }
        }

        void PlaceRuins()
        {
            // salvage sites of the old world around the city and across the land
            foreach (int t in Disk(CityTile, 20))
            {
                if (world.IsSea(t) || world.IsLake(t) || world.Owner[t] == 0 || rng.NextDouble() > 0.035) continue;
                string[] kinds = { "city", "tower", "suburb", "plant", "suburb" };
                ruins.Add(new RuinRecord { Tile = t, Type = kinds[rng.Next(kinds.Length)], Flags = rng.NextDouble() < 0.3 ? 2 : 0 });
            }
        }

        public void Setup(WorldModel model, int unitTarget, int buildingTarget)
        {
            world = model; g = model.Grid;
            CityTile = FindFlatLand(g.W / 2 + g.W * (g.H / 2));
            ArenaTile = FindFlatLand(WalkEast(CityTile, 22));
            BuildCity(buildingTarget);
            DigTrenchLines();
            PlaceRuins();
            // the front has been shelled for a while: churned ground between the lines
            foreach (int t in Disk(WalkEast(ArenaTile, 1), 5)) intensity[t] = Math.Max(1, 4 - g.Dist(t, WalkEast(ArenaTile, 1)) / 2);
            // the city's developed core
            foreach (int t in Disk(CityTile, 4)) if (!world.IsSea(t)) world.Urban[t >> 3] |= (byte)(1 << (t & 7));
            world.ApplyUrban(world.Urban);
            int half = unitTarget / 2;
            for (int k = 0; k < unitTarget; k++)
            {
                int owner = k < half ? 0 : 1;
                int home = owner == 0 ? WalkEast(CityTile, 8) : WalkEast(ArenaTile, 10);
                Spawn(owner, Near(home, 6));
            }
            // whole map explored and visible, the city's land owned
            for (int i = 0; i < model.Visible.Length; i++) model.Visible[i] = 0xff;
            model.ApplyVisibility(model.Visible);
        }

        int FindFlatLand(int start)
        {
            int best = start; float bestScore = float.MaxValue;
            foreach (int t in Disk(start, 18))
            {
                if (world.IsSea(t) || world.IsLake(t)) continue;
                int b = world.Biome[t];
                float score = (b == StressWorld.Plains || b == StressWorld.Grass ? 0 : 5) + Math.Abs(world.Elevation(t) - 0.12f) * 10 + g.Dist(start, t) * 0.05f;
                if (score < bestScore) { bestScore = score; best = t; }
            }
            return best;
        }

        int WalkEast(int t, int steps)
        {
            for (int k = 0; k < steps; k++) { int nb = g.Nb[t * 6 + 0]; if (nb >= 0) t = nb; }
            return t;
        }

        int Near(int center, int radius)
        {
            for (int tries = 0; tries < 40; tries++)
            {
                int t = center;
                int steps = rng.Next(radius + 1);
                for (int k = 0; k < steps; k++) { int nb = g.Nb[t * 6 + rng.Next(6)]; if (nb >= 0) t = nb; }
                if (!world.IsSea(t)) return t;
            }
            return center;
        }

        List<int> Disk(int center, int radius)
        {
            var outList = new List<int> { center };
            var seen = new HashSet<int> { center };
            var frontier = new List<int> { center };
            for (int r = 0; r < radius; r++)
            {
                var next = new List<int>();
                foreach (int t in frontier)
                    for (int d = 0; d < 6; d++)
                    {
                        int nb = g.Nb[t * 6 + d];
                        if (nb >= 0 && seen.Add(nb)) { outList.Add(nb); next.Add(nb); }
                    }
                frontier = next;
            }
            return outList;
        }

        void BuildCity(int target)
        {
            var tiles = Disk(CityTile, 16);
            tiles.Sort((a, b) => g.Dist(CityTile, a).CompareTo(g.Dist(CityTile, b)));
            foreach (int t in tiles)
            {
                if (buildings.Count >= target) break;
                if (world.IsSea(t) || world.IsLake(t) || world.Biome[t] >= StressWorld.Mountain) continue;
                world.Owner[t] = 0;
                string type = buildings.Count == 0 ? "town" : CityMix[rng.Next(CityMix.Length)];
                int dist = g.Dist(CityTile, t);
                if (dist <= 3 && type == "farm") type = "house";
                buildings.Add(new BuildingRecord
                {
                    Id = nextBuildingId++, Owner = 0, Type = type, Tile = t, Hp = 100, Done = true, Progress = 100,
                    Level = type == "house" ? 1 + (dist < 5 ? 2 : dist < 9 ? 1 : 0) : 1 + rng.Next(3), Tier = type == "town" ? 3 : 0,
                    State = "ok", City = 1,
                });
                // streets: a few road edges per developed hex
                for (int d = 0; d < 3; d++)
                {
                    int dir = (d * 2 + (t & 1)) % 6;
                    int nb = g.Nb[t * 6 + dir];
                    if (nb < 0 || world.IsSea(nb)) continue;
                    int cls = dist < 4 ? 2 : 1;
                    world.Road[t] |= cls << (dir * 4);
                    world.Road[nb] |= cls << (((dir + 3) % 6) * 4);
                }
            }
        }

        void Spawn(int owner, int tile)
        {
            bool air = rng.NextDouble() < 0.08;
            string type = air ? AirMix[rng.Next(AirMix.Length)] : GroundMix[rng.Next(GroundMix.Length)];
            units.Add(new SimUnit
            {
                Id = nextUnitId++, Owner = owner, Type = type, Tile = tile, Next = -1, Goal = FrontGoal(owner), Hp = 100,
                Speed = air ? 2.2f : type.Contains("tank") || type.Contains("car") || type.Contains("buggy") || type.Contains("truck") ? 0.9f : 0.45f,
                Air = air,
            });
        }

        int FrontGoal(int owner)
        {
            int front = WalkEast(ArenaTile, owner == 0 ? -0 : 4);
            return Near(owner == 0 ? WalkEast(CityTile, 14) : front, 7);
        }

        int StepToward(int from, int goal, bool air)
        {
            int best = -1, bestD = g.Dist(from, goal);
            int start = rng.Next(6);
            for (int k = 0; k < 6; k++)
            {
                int d = (start + k) % 6;
                int nb = g.Nb[from * 6 + d];
                if (nb < 0 || (!air && (world.IsSea(nb) || world.Biome[nb] == StressWorld.Peak))) continue;
                int dd = g.Dist(nb, goal);
                if (dd < bestD) { bestD = dd; best = nb; }
            }
            return best;
        }

        /// <summary>Several construction sites at once, as when a player places ten buildings quickly.</summary>
        public void BurstBuild(int n)
        {
            for (int k = 0; k < n; k++)
            {
                int t = Near(CityTile, 14);
                if (world.IsSea(t)) continue;
                buildings.Add(new BuildingRecord { Id = nextBuildingId++, Owner = 0, Type = CityMix[rng.Next(CityMix.Length)], Tile = t, Hp = 100, Progress = 0, Level = 1, State = "ok", City = 1 });
            }
            econAt = 0;   // the next snapshot carries them, as the server's would
        }

        /// <summary>Advance by dt seconds; returns a snapshot message when one is due (5 Hz).</summary>
        public SnapshotMessage Step(float dt)
        {
            time += dt;
            for (int k = 0; k < units.Count; k++)
            {
                var u = units[k];
                if (u.Next < 0)
                {
                    if (u.Tile == u.Goal || rng.NextDouble() < 0.002) u.Goal = FrontGoal(u.Owner);
                    u.Next = StepToward(u.Tile, u.Goal, u.Air);
                    if (u.Next < 0) u.Goal = FrontGoal(u.Owner);
                    u.Prog = 0;
                }
                else
                {
                    u.Prog += u.Speed * dt;
                    if (u.Prog >= 1f) { u.Tile = u.Next; u.Next = -1; u.Prog = 0; }
                }
                units[k] = u;
            }
            // combat along the front: direct fire and artillery impacts, some casualties and reinforcements
            fireAt -= dt;
            while (fireAt <= 0)
            {
                fireAt += 0.04f;
                int ai = rng.Next(units.Count), bi = rng.Next(units.Count);
                var a = units[ai];
                var b = units[bi];
                if (a.Owner == b.Owner) continue;
                bool artillery = a.Type.Contains("artillery") || a.Type == "mortar_team" || a.Type == "field_gun" || a.Type == "missile_battery";
                pendingEvents.Add(new CombatEvent { Kind = artillery ? "launch" : "fire", Seq = ++eventSeq, From = a.Tile, To = b.Tile, Shooter = a.Id, Target = b.Id, Weapon = artillery ? 3 : 1, Flight = artillery ? 1.5f : 0 });
                int hitTile = Near(b.Tile, 1);
                pendingEvents.Add(new CombatEvent { Kind = artillery ? "impact" : "hit", Seq = ++eventSeq, From = a.Tile, To = hitTile, Target = b.Id, Outcome = "hit", Radius = artillery ? 0.6f : 0, Damage = 10 });
                if (artillery)
                {
                    craters[hitTile] = Math.Min(3f, (craters.TryGetValue(hitTile, out float cd) ? cd : 0f) + 0.2f);
                    intensity[hitTile] = Math.Min(4f, (intensity.TryGetValue(hitTile, out float iv) ? iv : 0f) + 0.05f);
                }
                {
                    b.Hp -= rng.Next(4, 12);
                    if (b.Hp <= 0)
                    {
                        units.RemoveAt(bi);
                        pendingEvents.Add(new CombatEvent { Kind = "kill", Seq = ++eventSeq, To = b.Tile, Target = b.Id, UnitType = b.Type, Owner = b.Owner, Outcome = "destroyed" });
                        Spawn(b.Owner, Near(b.Owner == 0 ? CityTile : WalkEast(ArenaTile, 10), 4));
                    }
                    else units[bi] = b;
                }
            }
            // construction and damage in the city
            buildAt -= dt;
            if (buildAt <= 0)
            {
                buildAt = 0.5f;
                int k = rng.Next(buildings.Count);
                var b = buildings[k];
                if (!b.Done) { b.Progress = Math.Min(100, b.Progress + 10); if (b.Progress >= 100) b.Done = true; }
                else if (rng.NextDouble() < 0.2 && b.Type == "house" && b.Level < 3) b.Level++;
                buildings[k] = b;
                if (rng.NextDouble() < 0.25)
                {
                    // a new site under construction somewhere on the edge of town
                    int t = Near(CityTile, 15);
                    if (!world.IsSea(t)) buildings.Add(new BuildingRecord { Id = nextBuildingId++, Owner = 0, Type = CityMix[rng.Next(CityMix.Length)], Tile = t, Hp = 100, Progress = 0, Level = 1, State = "ok", City = 1 });
                }
            }
            damageAt -= dt;
            if (damageAt <= 0)
            {
                damageAt = 2f;
                int k = rng.Next(buildings.Count);
                var b = buildings[k];
                b.Hp = b.Hp > 30 ? b.Hp - 25 : 100;
                b.Fire = b.Hp < 60;
                buildings[k] = b;
            }
            snapAt -= dt;
            if (snapAt > 0) return null;
            snapAt += 0.2f;
            return Snapshot();
        }

        SnapshotMessage Snapshot()
        {
            tick += 2;
            bool full = snapshots++ % 50 == 0;
            var msg = new SnapshotMessage { Time = time, Tick = tick, Delta = !full };
            var list = new List<UnitWire>(full ? units.Count : 256);
            var now = new HashSet<int>();
            foreach (var u in units)
            {
                now.Add(u.Id);
                long key = unchecked(((((long)u.Tile * 131 + u.Next) * 131 + (int)(u.Prog * 100)) * 131 + u.Hp) * 7 + u.Owner);
                if (!full && sentKey.TryGetValue(u.Id, out long old) && old == key) continue;
                sentKey[u.Id] = key;
                list.Add(new UnitWire
                {
                    Id = u.Id, Owner = u.Owner, Type = u.Type, Tile = u.Tile, Next = u.Next, Prog = (float)Math.Round(u.Prog * 100) / 100f,
                    Hp = u.Hp, AirState = u.Air ? 2 : -1, AirMission = -1, AirMissionTile = -1,
                });
            }
            if (!full)
            {
                var gone = new List<int>();
                foreach (var id in sentKey.Keys) if (!now.Contains(id)) gone.Add(id);
                foreach (var id in gone) sentKey.Remove(id);
                msg.Gone = gone.ToArray();
            }
            else
            {
                var stale = new List<int>();
                foreach (var id in sentKey.Keys) if (!now.Contains(id)) stale.Add(id);
                foreach (var id in stale) sentKey.Remove(id);
            }
            msg.Units = list.ToArray();
            if (pendingEvents.Count > 0) { msg.Events = pendingEvents.ToArray(); pendingEvents.Clear(); }
            weatherAt -= 0.2f;
            if (weatherAt <= 0)
            {
                // a rain band drifting east across the map, clouds around it
                weatherAt = 2f;
                weatherPhase += 0.08f;
                int cw = (g.W + 7) / 8, ch = (g.H + 7) / 8;
                var cloud = new byte[cw * ch]; var rain = new byte[cw * ch]; var wet = new byte[cw * ch];
                float cityCx = (CityTile % g.W) / 8f, cityCy = (CityTile / g.W) / 8f;
                for (int y = 0; y < ch; y++)
                    for (int x = 0; x < cw; x++)
                    {
                        float bx = cityCx - 8 + (weatherPhase * 3f) % 20f;
                        float d = (float)Math.Sqrt((x - bx) * (x - bx) * 0.5f + (y - cityCy) * (y - cityCy));
                        float c = Math.Max(0f, 1f - d / 7f);
                        cloud[y * cw + x] = (byte)(Math.Min(1f, c * 1.4f + 0.15f) * 255);
                        rain[y * cw + x] = (byte)(Math.Max(0f, c - 0.35f) * 1.6f * 255);
                        wet[y * cw + x] = (byte)(Math.Min(1f, c * 1.2f) * 255);
                    }
                msg.WeatherState = new WeatherState { Version = (int)(weatherPhase * 100), CellsW = cw, CellsH = ch, Cell = 8, WindAngle = 0.4f, WindSpeed = 0.6f, Cloud = cloud, Rain = rain, Wet = wet };
            }
            econAt -= 0.2f;
            if (econAt <= 0 || full)
            {
                econAt = 1f;
                msg.HasEcon = true;
                msg.Trenches = trenches.ToArray();
                msg.Ruins = ruins.ToArray();
                var bf = new BattlefieldState();
                var cl = new List<CraterRecord>(); foreach (var kv in craters) cl.Add(new CraterRecord { Tile = kv.Key, Depth = kv.Value });
                var il = new List<TileValue>(); foreach (var kv in intensity) il.Add(new TileValue { Tile = kv.Key, Value = kv.Value });
                bf.Craters = cl.ToArray(); bf.Intensity = il.ToArray();
                msg.BattlefieldState = bf;
                msg.Buildings = buildings.ToArray();
                msg.Cities = new[] { new CityRecord { Id = 1, Owner = 0, Name = "Ironford", Tile = CityTile, Pop = 860, Capital = true, Radius = 6, Tier = 3 } };
            }
            return msg;
        }
    }
}
