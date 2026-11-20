using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;

namespace SE.Core.Stress
{
    /// <summary>
    /// Scale pass, phase 1 (2026-11-20): the 8-player free-for-all the scale ticket asks for, synthesised offline.
    /// 8 civs x 1,000 units (default) and about 4,000 buildings: per civ several action-RTS bases (headquarters plus a
    /// ring of 8 facility parcels, as the server sends them: positioned, yawed, with sites and parcels) and hundreds of
    /// positioned field defences around them and along the fronts. Every pair of neighbouring civs shares a front.
    /// Units move in groups of ~25 with continuous world motion (action RTS 'Motion' records: x, z, yaw, velocity),
    /// advance, hold, chase enemy groups and fall back; nearby hostiles exchange fire (direct fire, artillery with
    /// impacts and craters), kills respawn at home so the count stays constant, and fronts accumulate wrecks (capped as the
    /// server caps them) and shelled ground. Buildings near fronts take damage, burn, fall and are rebuilt.
    /// Snapshots follow udelta: changed unit records only (quantised position / hp), ids that left, a full set every
    /// 50 snapshots, economy once a second with the building list, battlefield, sites and a synthetic 'perf' block.
    /// </summary>
    public sealed class StressScale
    {
        struct Unit
        {
            public int Id, Owner, Group, Hp;
            public float X, Z, Yaw, Vx, Vz, Speed, Ox, Oz;
            public string Type;
            public bool Air;
        }

        struct Group
        {
            public int Owner, Front, Mode, Chase;   // Mode 0 advance to front, 1 hold, 2 chase, 3 fall back
            public float Gx, Gz, Until;
        }

        static readonly string[] GroundMix =
        {
            "rifle_squad", "rifle_squad", "rifle_squad", "rifle_squad", "militia", "anti_armor", "mortar_team", "mech_infantry", "tank", "tank",
            "armored_car", "field_gun", "sp_artillery", "air_defense", "supply_truck", "engineer", "special_forces", "exo_infantry",
            "autonomous_tank", "missile_battery", "scout_buggy",
        };
        static readonly string[] AirMix = { "helicopter", "fighter", "bomber", "recon_drone", "oneway_drone", "strike_swarm" };
        static readonly string[] Facilities = { "depot", "power_plant", "barracks", "motor_works", "heavy_weapons", "airfield", "advanced_lab", "missile_silo" };
        static readonly string[] Defences = { "barricade", "barricade", "guard_post", "bunker", "turret", "turret", "city_turret", "aa_battery", "sensor_post", "repair_point", "artillery_post", "fort" };

        readonly Random rng;
        readonly List<Unit> units = new List<Unit>();
        readonly List<Group> groups = new List<Group>();
        readonly List<BuildingRecord> buildings = new List<BuildingRecord>();
        readonly List<ObjectiveSite> sites = new List<ObjectiveSite>();
        readonly List<CityRecord> cities = new List<CityRecord>();
        readonly List<CombatEvent> pending = new List<CombatEvent>();
        readonly Dictionary<int, long> sentKey = new Dictionary<int, long>();
        readonly List<WreckRecord> wrecks = new List<WreckRecord>();
        readonly Dictionary<int, float> craters = new Dictionary<int, float>(), intensity = new Dictionary<int, float>();
        readonly List<int>[] byCiv;
        HexGrid g;
        WorldModel world;
        float[] homeX, homeZ;
        float[] frontX, frontZ;   // front k lies between civ k and civ (k + 1) % civs
        int civs, nextUnitId = 1, nextBuildingId = 1, eventSeq, snapshots, tick, unitsPerCiv;
        float time, snapAt, econAt, fireAt, buildAt, perfPhase;

        public int UnitCount => units.Count;
        public int BuildingCount => buildings.Count;
        public int Civs => civs;
        public int HomeTile(int civ) => g.TileAt(homeX[civ], homeZ[civ]);
        public int FrontTile(int k) => g.TileAt(frontX[k], frontZ[k]);
        public IReadOnlyList<ObjectiveSite> Sites => sites;

        public StressScale(int seed, int civCount)
        {
            rng = new Random(seed);
            civs = Math.Max(2, civCount);
            byCiv = new List<int>[civs];
            for (int i = 0; i < civs; i++) byCiv[i] = new List<int>();
        }

        // ------------------------------------------------------------------ setup
        public void Setup(WorldModel model, int perCiv, int buildingTarget)
        {
            world = model; g = model.Grid; unitsPerCiv = perCiv;
            homeX = new float[civs]; homeZ = new float[civs]; frontX = new float[civs]; frontZ = new float[civs];
            float cx = g.Period * .5f, cz = g.H * 1.5f * .5f, ring = Math.Min(g.Period, g.H * 1.5f) * .3f;
            for (int i = 0; i < civs; i++)
            {
                double a = i * Math.PI * 2 / civs + .3;
                int t = FindLand((float)(cx + Math.Sin(a) * ring), (float)(cz + Math.Cos(a) * ring * .9f), 24);
                homeX[i] = g.CenterX(t); homeZ[i] = g.CenterZ(t);
            }
            for (int k = 0; k < civs; k++)
            {
                int n = (k + 1) % civs;
                float mx = homeX[k] + g.DxWrap(homeX[k], homeX[n]) * .5f, mz = (homeZ[k] + homeZ[n]) * .5f;
                int t = FindLand(g.BaseX(mx), mz, 10);
                frontX[k] = g.CenterX(t); frontZ[k] = g.CenterZ(t);
            }
            int perCivBuildings = Math.Max(10, buildingTarget / civs);
            for (int c = 0; c < civs; c++) BuildCiv(c, perCivBuildings);
            // groups of ~25: each civ splits its army over its two fronts (k = c and k = c - 1)
            for (int c = 0; c < civs; c++)
            {
                int nGroups = Math.Max(1, perCiv / 25);
                for (int k = 0; k < nGroups; k++)
                {
                    int front = k % 2 == 0 ? c : (c + civs - 1) % civs;
                    groups.Add(new Group { Owner = c, Front = front, Mode = 0, Chase = -1 });
                    int gi = groups.Count - 1;
                    Retarget(gi);
                    int size = k == nGroups - 1 ? perCiv - 25 * (nGroups - 1) : 25;
                    var gr = groups[gi];
                    // start part way out so fighting starts within seconds
                    float f = (float)rng.NextDouble() * .85f;
                    float sx = homeX[c] + g.DxWrap(homeX[c], gr.Gx) * f, sz = homeZ[c] + (gr.Gz - homeZ[c]) * f;
                    for (int m = 0; m < size; m++) Spawn(c, gi, sx, sz);
                }
            }
            for (int i = 0; i < model.Visible.Length; i++) model.Visible[i] = 0xff;
            model.ApplyVisibility(model.Visible);
            model.ApplyUrban(model.Urban);
        }

        int FindLand(float x, float z, int radius)
        {
            int start = g.TileAt(g.BaseX(x), Math.Max(0, Math.Min(z, (g.H - 1) * 1.5f)));
            if (start < 0) start = g.N / 2;
            int best = start; float bestScore = float.MaxValue;
            for (int dr = -radius; dr <= radius; dr++)
                for (int dq = -radius; dq <= radius; dq++)
                {
                    int q = HexMath.PosMod(start % g.W + dq, g.W), r = start / g.W + dr;
                    if (r < 1 || r >= g.H - 1) continue;
                    int t = r * g.W + q;
                    if (Wet(t) || world.Biome[t] >= StressWorld.Mountain) continue;
                    float s = (world.Biome[t] == StressWorld.Plains || world.Biome[t] == StressWorld.Grass ? 0 : 3) + Math.Abs(world.Elevation(t) - .12f) * 8 + (dq * dq + dr * dr) * .02f;
                    if (s < bestScore) { bestScore = s; best = t; }
                }
            return best;
        }

        bool Wet(int t) => t < 0 || world.IsSea(t) || world.IsLake(t);

        void BuildCiv(int c, int target)
        {
            // bases: the capital and up to 7 more around it (a base is 9 buildings: headquarters + 8 facilities)
            int bases = Math.Max(1, Math.Min(8, target / 60));
            int placed = 0;
            for (int b = 0; b < bases; b++)
            {
                float bx = homeX[c], bz = homeZ[c];
                if (b > 0)
                {
                    double a = b * Math.PI * 2 / (bases - 1) + c;
                    bx += (float)Math.Sin(a) * 9f; bz += (float)Math.Cos(a) * 8f;
                }
                int t = FindLand(g.BaseX(bx), bz, 3);
                bx = g.CenterX(t); bz = g.CenterZ(t);
                placed += AddBase(c, b, t, bx, bz);
            }
            // field defences: around the bases, along the roads toward the fronts and dug in at the fronts
            int guard = 0;
            while (placed < target && guard++ < target * 6)
            {
                double pick = rng.NextDouble();
                float x, z;
                if (pick < .45)
                {
                    var site = sites[sites.Count - 1 - rng.Next(bases)];
                    double a = rng.NextDouble() * Math.PI * 2; float r = 3.2f + (float)rng.NextDouble() * 6f;
                    x = site.X + (float)Math.Sin(a) * r; z = site.Z + (float)Math.Cos(a) * r;
                }
                else
                {
                    int front = pick < .75 ? c : (c + civs - 1) % civs;
                    float f = .25f + (float)rng.NextDouble() * .6f;
                    x = homeX[c] + g.DxWrap(homeX[c], frontX[front]) * f + (float)(rng.NextDouble() - .5) * 10f;
                    z = homeZ[c] + (frontZ[front] - homeZ[c]) * f + (float)(rng.NextDouble() - .5) * 10f;
                }
                x = g.BaseX(x);
                int t = g.TileAt(x, z);
                if (Wet(t) || world.Biome[t] >= StressWorld.Peak) continue;
                string type = Defences[rng.Next(Defences.Length)];
                buildings.Add(new BuildingRecord
                {
                    Id = nextBuildingId++, Owner = c, Type = type, Tile = t, Hp = 100, Done = true, Active = true, Progress = 100, Level = 1, Tier = 1, Era = 1,
                    State = "ok", HasPosition = true, HasYaw = true, X = x, Z = z, Yaw = (float)(rng.NextDouble() * Math.PI * 2),
                });
                world.Owner[t] = c;
                placed++;
            }
        }

        int AddBase(int c, int index, int center, float x, float z)
        {
            int siteId = sites.Count + 1;
            var parcels = new BaseParcel[9];
            parcels[0] = new BaseParcel { Tile = center, Id = 0, Tier = 1, X = x, Z = z, Yaw = .44f, Width = 1.12f, Depth = 1.12f };
            int hq = nextBuildingId++;
            buildings.Add(Record(c, siteId, "town", parcels[0], hq));
            int added = 1;
            for (int i = 0; i < 8; i++)
            {
                float angle = .44f + i * (float)Math.PI / 4, radius = 1.92f + (float)Math.Sin(i * 2.1f) * .09f;
                float px = g.BaseX(x + (float)Math.Sin(angle) * radius * 1.05f), pz = z + (float)Math.Cos(angle) * radius * .96f;
                int pt = g.TileAt(px, pz);
                if (pt < 0) pt = center;
                parcels[i + 1] = new BaseParcel { Id = 17 + i, Tier = i % 2 == 0 ? 1 : i == 1 || i == 5 ? 2 : 3, Tile = pt, X = px, Z = pz,
                    Yaw = (float)Math.Atan2(g.DxWrap(px, x), z - pz), Width = .96f, Depth = .90f };
                world.Owner[pt] = c; world.Urban[pt >> 3] |= (byte)(1 << (pt & 7));
                if (index > 0 && i == 7) continue;   // outlying bases leave a parcel open
                buildings.Add(Record(c, siteId, Facilities[(i + index) % Facilities.Length], parcels[i + 1], nextBuildingId++));
                added++;
            }
            world.Owner[center] = c; world.Urban[center >> 3] |= (byte)(1 << (center & 7));
            sites.Add(new ObjectiveSite
            {
                Id = siteId, Tile = center, X = x, Z = z, IsBase = true, Owner = c, Headquarters = hq, Tier = 2, VisualTier = 2, Capacity = 8, RingVersion = 1,
                Operational = true, Maturity = 35, Name = "Base " + c + "." + index, Kind = "military", Parcels = parcels, Slots = Array.Empty<int>(), Radius = 3f,
            });
            cities.Add(new CityRecord { Id = siteId, Owner = c, Name = "Base " + c + "." + index, Tile = center, Pop = 400, Capital = index == 0, Radius = 3, Tier = 2 });
            return added;
        }

        static BuildingRecord Record(int owner, int city, string type, BaseParcel p, int id) => new BuildingRecord
        {
            Id = id, City = city, Slot = p.Id, Type = type, Tile = p.Tile, Owner = owner, Hp = 100, Done = true, Active = true,
            Progress = 100, Tier = 2, Era = 1, Level = 1, State = "ok", HasPosition = true, HasYaw = true, X = p.X, Z = p.Z, Yaw = p.Yaw,
        };

        void Spawn(int owner, int group, float x, float z)
        {
            bool air = rng.NextDouble() < .06;
            string type = air ? AirMix[rng.Next(AirMix.Length)] : GroundMix[rng.Next(GroundMix.Length)];
            bool vehicle = type.Contains("tank") || type.Contains("car") || type.Contains("buggy") || type.Contains("truck") || type.Contains("artillery") || type == "air_defense" || type == "missile_battery";
            double a = rng.NextDouble() * Math.PI * 2; float r = (float)Math.Sqrt(rng.NextDouble()) * 2.2f;
            units.Add(new Unit
            {
                Id = nextUnitId++, Owner = owner, Group = group, Hp = 100, Type = type, Air = air,
                X = g.BaseX(x + (float)Math.Sin(a) * r), Z = z + (float)Math.Cos(a) * r, Yaw = (float)a,
                Speed = air ? 2.4f : vehicle ? .75f : .32f, Ox = (float)Math.Sin(a) * r, Oz = (float)Math.Cos(a) * r,
            });
        }

        void Retarget(int gi)
        {
            var gr = groups[gi];
            int c = gr.Owner;
            float jitter = 7f;
            switch (gr.Mode)
            {
                case 3:   // fall back toward home
                    gr.Gx = homeX[c] + g.DxWrap(homeX[c], frontX[gr.Front]) * .35f; gr.Gz = homeZ[c] + (frontZ[gr.Front] - homeZ[c]) * .35f; jitter = 4f; break;
                default:   // advance / hold: a point on this side of the front
                    gr.Gx = frontX[gr.Front] + g.DxWrap(frontX[gr.Front], homeX[c]) * .06f; gr.Gz = frontZ[gr.Front] + (homeZ[c] - frontZ[gr.Front]) * .06f; break;
            }
            gr.Gx = g.BaseX(gr.Gx + (float)(rng.NextDouble() - .5) * jitter * 2);
            gr.Gz = Math.Max(2f, Math.Min((g.H - 2) * 1.5f, gr.Gz + (float)(rng.NextDouble() - .5) * jitter * 2));
            gr.Until = time + 8f + (float)rng.NextDouble() * 20f;
            groups[gi] = gr;
        }

        // ------------------------------------------------------------------ step
        public SnapshotMessage Step(float dt)
        {
            time += dt;
            // group orders: advance, hold, chase an enemy group on the same front, fall back
            for (int gi = 0; gi < groups.Count; gi++)
            {
                var gr = groups[gi];
                if (time < gr.Until) continue;
                double r = rng.NextDouble();
                gr.Mode = r < .5 ? 0 : r < .7 ? 1 : r < .9 ? 2 : 3;
                groups[gi] = gr;
                if (gr.Mode == 2)
                {
                    int enemy = gr.Front == gr.Owner ? (gr.Owner + 1) % civs : (gr.Owner + civs - 1) % civs;
                    int other = rng.Next(groups.Count);
                    for (int k = 0; k < 20 && groups[other].Owner != enemy; k++) other = rng.Next(groups.Count);
                    gr.Chase = groups[other].Owner == enemy ? other : -1;
                    gr.Until = time + 10f + (float)rng.NextDouble() * 10f;
                    groups[gi] = gr;
                    if (gr.Chase < 0) Retarget(gi);
                }
                else Retarget(gi);
            }
            // chasing groups follow their quarry's goal
            for (int gi = 0; gi < groups.Count; gi++)
            {
                var gr = groups[gi];
                if (gr.Mode != 2 || gr.Chase < 0) continue;
                gr.Gx = groups[gr.Chase].Gx; gr.Gz = groups[gr.Chase].Gz; groups[gi] = gr;
            }
            // motion: every unit steers toward its group's goal plus its formation offset
            for (int i = 0; i < units.Count; i++)
            {
                var u = units[i];
                var gr = groups[u.Group];
                float tx = g.DxWrap(u.X, gr.Gx + u.Ox), tz = gr.Gz + u.Oz - u.Z;
                float d = (float)Math.Sqrt(tx * tx + tz * tz);
                float sp = u.Speed * (gr.Mode == 1 && d < 3f ? 0f : d < .3f ? 0f : 1f);
                if (u.Air && d < 1.5f) { tx = (float)Math.Cos(time + u.Id); tz = (float)Math.Sin(time + u.Id); d = 1; sp = u.Speed; }   // aircraft orbit
                if (sp > 0 && d > 1e-4f)
                {
                    u.Vx = tx / d * sp; u.Vz = tz / d * sp;
                    u.X = g.BaseX(u.X + u.Vx * dt); u.Z = Math.Max(1f, Math.Min((g.H - 1) * 1.5f, u.Z + u.Vz * dt));
                    u.Yaw = (float)Math.Atan2(u.Vx, u.Vz);
                }
                else { u.Vx = u.Vz = 0; }
                units[i] = u;
            }
            Fight(dt);
            Structures(dt);
            snapAt -= dt;
            if (snapAt > 0) return null;
            snapAt += .2f;
            return Snapshot();
        }

        void Fight(float dt)
        {
            for (int c = 0; c < civs; c++) byCiv[c].Clear();
            for (int i = 0; i < units.Count; i++) byCiv[units[i].Owner].Add(i);
            // about 25 shots a second per 1,000 units (the old stress scene's rate), only between units within range
            fireAt -= dt;
            float interval = .04f * 1000f / Math.Max(1000, units.Count);
            var dead = new List<int>();
            while (fireAt <= 0)
            {
                fireAt += interval;
                int ai = rng.Next(units.Count);
                var a = units[ai];
                var gr = groups[a.Group];
                int enemy = gr.Front == a.Owner ? (a.Owner + 1) % civs : (a.Owner + civs - 1) % civs;
                var list = byCiv[enemy];
                if (list.Count == 0) continue;
                bool artillery = a.Type.Contains("artillery") || a.Type == "mortar_team" || a.Type == "field_gun" || a.Type == "missile_battery";
                float range = artillery ? 14f : a.Air ? 6f : 4.5f;
                int bi = -1; float best = range * range;
                for (int k = 0; k < 12; k++)
                {
                    int j = list[rng.Next(list.Count)];
                    float dx = g.DxWrap(a.X, units[j].X), dz = units[j].Z - a.Z, d2 = dx * dx + dz * dz;
                    if (d2 < best) { best = d2; bi = j; }
                }
                if (bi < 0 || dead.Contains(bi)) continue;
                var b = units[bi];
                int from = g.TileAt(a.X, a.Z), to = g.TileAt(b.X, b.Z);
                pending.Add(new CombatEvent
                {
                    Kind = artillery ? "launch" : "fire", Seq = ++eventSeq, From = from, To = to, Shooter = a.Id, Target = b.Id, Weapon = artillery ? 3 : 1, Flight = artillery ? 1.5f : 0,
                    HasOrigin = true, Origin = new WorldPoint(a.X, a.Z), HasDestination = true, Destination = new WorldPoint(b.X, b.Z),
                });
                float hx = b.X + (float)(rng.NextDouble() - .5) * (artillery ? 1.2f : .2f), hz = b.Z + (float)(rng.NextDouble() - .5) * (artillery ? 1.2f : .2f);
                int ht = g.TileAt(g.BaseX(hx), hz);
                pending.Add(new CombatEvent
                {
                    Kind = artillery ? "impact" : "hit", Seq = ++eventSeq, From = from, To = ht, Target = b.Id, Outcome = "hit", Radius = artillery ? .6f : 0, Damage = 10,
                    HasOrigin = true, Origin = new WorldPoint(a.X, a.Z), HasDestination = true, Destination = new WorldPoint(g.BaseX(hx), hz),
                });
                if (artillery && ht >= 0)
                {
                    craters[ht] = Math.Min(3f, (craters.TryGetValue(ht, out float cd) ? cd : 0f) + .15f);
                    intensity[ht] = Math.Min(4f, (intensity.TryGetValue(ht, out float iv) ? iv : 0f) + .04f);
                }
                b.Hp -= rng.Next(4, 12);
                units[bi] = b;
                if (b.Hp <= 0)
                {
                    dead.Add(bi);
                    pending.Add(new CombatEvent { Kind = "kill", Seq = ++eventSeq, To = to, Target = b.Id, UnitType = b.Type, Owner = b.Owner, Outcome = "destroyed",
                        HasDestination = true, Destination = new WorldPoint(b.X, b.Z) });
                    bool vehicle = b.Speed > .5f && !b.Air;
                    if (vehicle && to >= 0)
                    {
                        wrecks.Add(new WreckRecord { Tile = to, Owner = b.Owner, Type = b.Type, Burning = true, HasPosition = true, X = b.X, Z = b.Z, Yaw = b.Yaw });
                        if (wrecks.Count > 400) wrecks.RemoveAt(0);   // the server's WRECK.total cap
                    }
                }
            }
            if (dead.Count == 0) return;
            dead.Sort();
            for (int k = dead.Count - 1; k >= 0; k--)
            {
                var b = units[dead[k]];
                units.RemoveAt(dead[k]);
                // reinforcements from home rejoin the same group
                Spawn(b.Owner, b.Group, homeX[b.Owner], homeZ[b.Owner]);
            }
        }

        void Structures(float dt)
        {
            buildAt -= dt;
            if (buildAt > 0) return;
            buildAt = .25f;
            // a few buildings a second take damage (fronts first), burn below 60, fall at 0 and are rebuilt from scratch
            for (int n = 0; n < 6; n++)
            {
                int k = rng.Next(buildings.Count);
                var b = buildings[k];
                if (!b.Done)
                {
                    b.Progress = Math.Min(100, b.Progress + 20);
                    if (b.Progress >= 100) { b.Done = true; b.Hp = 100; b.Fire = false; }
                }
                else
                {
                    b.Hp -= rng.Next(10, 35);
                    pending.Add(new CombatEvent { Kind = "bhit", Seq = ++eventSeq, To = b.Tile, Target = b.Id, Outcome = b.Hp <= 0 ? "destroyed" : "hit", HasDestination = true, Destination = new WorldPoint(b.X, b.Z) });
                    b.Fire = b.Hp < 60;
                    b.State = b.Hp < 35 ? "damaged" : "ok";
                    if (b.Hp <= 0)
                    {
                        b.Id = nextBuildingId++; b.Hp = 100; b.Done = false; b.Progress = 0; b.Fire = false; b.State = "ok";   // a new construction in its place
                    }
                }
                buildings[k] = b;
            }
        }

        // ------------------------------------------------------------------ wire
        SnapshotMessage Snapshot()
        {
            tick += 2;
            bool full = snapshots++ % 50 == 0;
            var msg = new SnapshotMessage { Time = time, Tick = tick, Delta = !full };
            var list = new List<UnitWire>(full ? units.Count : units.Count / 2);
            var now = new HashSet<int>();
            foreach (var u in units)
            {
                now.Add(u.Id);
                long key = unchecked((((long)(u.X * 50) * 65537 + (long)(u.Z * 50)) * 131 + u.Hp) * 7 + u.Owner);
                if (!full && sentKey.TryGetValue(u.Id, out long old) && old == key) continue;
                sentKey[u.Id] = key;
                list.Add(new UnitWire
                {
                    Id = u.Id, Owner = u.Owner, Type = u.Type, Tile = g.TileAt(u.X, u.Z), Next = -1, Hp = u.Hp, Supply = 100, AirState = u.Air ? 2 : -1,
                    AirMission = -1, AirMissionTile = -1, Fuel = -1,
                    Motion = new WorldMotion { Present = true, X = u.X, Z = u.Z, Yaw = u.Yaw, Vx = u.Vx, Vz = u.Vz, Altitude = u.Air ? 1.4f : 0, Men = -1 },
                });
            }
            var gone = new List<int>();
            foreach (var id in sentKey.Keys) if (!now.Contains(id)) gone.Add(id);
            foreach (var id in gone) sentKey.Remove(id);
            if (!full) msg.Gone = gone.ToArray();
            msg.Units = list.ToArray();
            if (pending.Count > 0) { msg.Events = pending.ToArray(); pending.Clear(); }
            if (full) msg.Objectives = sites.ToArray();
            econAt -= .2f;
            if (econAt <= 0 || full)
            {
                econAt = 1f;
                msg.HasEcon = true;
                var bf = new BattlefieldState();
                var cl = new List<CraterRecord>(); foreach (var kv in craters) cl.Add(new CraterRecord { Tile = kv.Key, Depth = kv.Value });
                var il = new List<TileValue>(); foreach (var kv in intensity) il.Add(new TileValue { Tile = kv.Key, Value = kv.Value });
                bf.Craters = cl.ToArray(); bf.Intensity = il.ToArray(); bf.Wrecks = wrecks.ToArray();
                msg.BattlefieldState = bf;
                msg.Buildings = buildings.ToArray();
                msg.Cities = cities.ToArray();
                // synthetic server figures so the readout's server rows are exercised offline (labelled synthetic there)
                perfPhase += 1f;
                float load = units.Count / 1000f;
                msg.Perf = new ServerPerf
                {
                    Synthetic = true, Target = 10, Tps = 10f - Math.Max(0, (float)Math.Sin(perfPhase * .3f)) * 1.5f,
                    PathMs = 1.1f * load, SimMs = 2.4f * load, CombatMs = 1.6f * load, VisMs = .7f * load, AiMs = .9f * civs / 8f, EconMs = .3f * load, NetMs = .8f * load,
                };
                msg.Perf.TickMs = msg.Perf.PathMs + msg.Perf.SimMs + msg.Perf.CombatMs + msg.Perf.VisMs + msg.Perf.AiMs + msg.Perf.EconMs;
            }
            return msg;
        }
    }
}
