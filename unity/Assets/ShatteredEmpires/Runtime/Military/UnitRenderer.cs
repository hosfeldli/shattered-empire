using System;
using System.Collections.Generic;
using SE.Core.Units;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Every unit drawn from compact records with one instanced batch per model, in three continuous
    /// presentation levels: strategic (readable markers), operational (vehicles, small figure groups)
    /// and tactical (full squads, turret tracking, walking figures, rotors). No GameObject per unit
    /// and no per-unit Update(): one loop fills the instance buffers, uploaded once per frame.
    /// Vehicles turn hull or turret toward what they last fired at; aircraft keep moving on patrol
    /// orbits around the server position instead of hovering; vehicles ride bridge decks.
    /// </summary>
    public sealed partial class UnitRenderer : IDisposable
    {
        enum Model { Soldier, Hull, Turret, Apc, Truck, Car, Buggy, Gun, Launcher, Exo, Fighter, Bomber, Heli, Rotor, Drone, Marker, Ring, AutoHull, AutoTurret, Plate, Disc, Count }
        enum Detail
        {
            Tank, Autonomous, Howitzer, Turret, RemoteTurret, HowitzerTurret, Barrel, HowitzerBarrel,
            Carrier, Scout, ArmoredCar, Truck, RocketTruck, AirDefense, FieldGun, Mortar, ReconDrone, StrikeDrone,
            Fighter, Bomber, Helicopter, Rotor, Wheel, RoadWheel, Rifle, Engineer, Militia, Special, Exo, AntiArmor, MortarCrew,
            Thigh, Shin, UpperArm, Forearm, RifleWeapon, LauncherWeapon, PistolWeapon, Count
        }

        enum Kind { Infantry, Exo, Tank, AutoTank, Apc, ArmoredCar, Buggy, Truck, FieldGun, SpGun, Launcher, AirDefense, Heli, Fighter, Bomber, Drone, Swarm, Mortar }

        readonly InstanceBatch[] batches = new InstanceBatch[(int)Model.Count];
        readonly InstanceBatch[] details = new InstanceBatch[(int)Detail.Count];
        Kind[] kindOf = new Kind[0];
        Detail[] torsoOf = new Detail[0];
        bool[] strikeDrone = new bool[0];
        float[] yaw = new float[0], turret = new float[0], px = new float[0], pz = new float[0], seen = new float[0];
        float[] speed = new float[0], wheelPhase = new float[0], spread = new float[0];
        float[] gaitPhase = new float[0], turnRate = new float[0], suspensionPitch = new float[0], suspensionRoll = new float[0], treadTravel = new float[0];
        // flight state per slot: aircraft fly continuously toward where the server says they are
        float[] airX = new float[0], airZ = new float[0], airH = new float[0], airBank = new float[0];
        bool[] airLive = new bool[0];
        int[] ids = new int[0];
        readonly Dictionary<int, (int target, float time, Vector2? point)> lastShot = new Dictionary<int, (int, float, Vector2?)>();
        public readonly HashSet<int> Selected = new HashSet<int>();
        /// <summary>Whether a tile holds a finished trench (troops there are drawn down in it).</summary>
        public Func<int, bool> InTrench;
        /// <summary>High-contrast markers (accessibility): stronger ownership rings and fully saturated strategic markers.</summary>
        public bool HighContrast;
        public int Drawn { get; private set; }

        /// <summary>A strategic badge: where it is (map), how many units it stands for, their role and owner.</summary>
        public struct Badge { public float3 MapPos; public int Count, Category, Owner; }
        /// <summary>This frame's strategic badges (empty at closer zoom), for the count labels.</summary>
        public readonly List<Badge> Badges = new List<Badge>();
        readonly Dictionary<long, int> badgeIndex = new Dictionary<long, int>();
        readonly Dictionary<int, SE.Core.Protocol.BuildingRecord> footprints = new Dictionary<int, SE.Core.Protocol.BuildingRecord>();
        int footprintRevision = -1, footprintEpoch = -1;
        public int Instances { get; private set; }
        /// <summary>Last frame's cost by phase (diagnostics and stall attribution).</summary>
        public double PositionsMs, BuildMs, UploadMs;
        public float OperationalDistance = 26f, StrategicDistance = 75f;
        static readonly Vector3 Up = Vector3.up;

        public UnitRenderer()
        {
            Mesh[] meshes =
            {
                MeshKit.Soldier, MeshKit.TankHull, MeshKit.TankTurret, MeshKit.Apc, MeshKit.Truck, MeshKit.Car, MeshKit.Buggy, MeshKit.Gun,
                MeshKit.Rocket, MeshKit.Mech, MeshKit.Fighter, MeshKit.Bomber, MeshKit.HeliBody, MeshKit.Rotor, MeshKit.Drone, MeshKit.Marker, MeshKit.Ring, MeshKit.AutoTankHull, MeshKit.AutoTankTurret, MeshKit.Box, MeshKit.Disc,
            };
            for (int i = 0; i < batches.Length; i++)
            {
                batches[i] = new InstanceBatch(meshes[i], i == (int)Model.Fighter || i == (int)Model.Bomber ? RenderResources.InstancedGloss : RenderResources.Instanced, 512)
                {
                    Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f),
                    Buffering = 3,   // rewritten every frame
                };
            }
            batches[(int)Model.Ring].Shadows = ShadowCastingMode.Off;
            batches[(int)Model.Marker].Shadows = ShadowCastingMode.Off;
            batches[(int)Model.Plate].Shadows = ShadowCastingMode.Off;
            batches[(int)Model.Disc].Shadows = ShadowCastingMode.Off;
            Mesh[] detailed =
            {
                MilitaryMeshes.Tank, MilitaryMeshes.Autonomous, MilitaryMeshes.Howitzer, MilitaryMeshes.Turret, MilitaryMeshes.RemoteTurret,
                MilitaryMeshes.HowitzerTurret, MilitaryMeshes.GunBarrel, MilitaryMeshes.HowitzerBarrel, MilitaryMeshes.Carrier,
                MilitaryMeshes.Scout, MilitaryMeshes.ArmoredCar, MilitaryMeshes.CargoTruck, MilitaryMeshes.RocketTruck,
                MilitaryMeshes.AirDefense, MilitaryMeshes.FieldGun, MilitaryMeshes.Mortar, MilitaryMeshes.ReconDrone, MilitaryMeshes.StrikeDrone,
                MilitaryMeshes.Fighter, MilitaryMeshes.Bomber, MilitaryMeshes.Helicopter, MilitaryMeshes.Rotor, MilitaryMeshes.Wheel,
                MilitaryMeshes.RoadWheel, MilitaryMeshes.Torsos[0], MilitaryMeshes.Torsos[1], MilitaryMeshes.Torsos[2],
                MilitaryMeshes.Torsos[3], MilitaryMeshes.Torsos[4], MilitaryMeshes.Torsos[5], MilitaryMeshes.Torsos[6],
                MilitaryMeshes.Thigh, MilitaryMeshes.Shin, MilitaryMeshes.UpperArm, MilitaryMeshes.Forearm, MilitaryMeshes.Rifle, MilitaryMeshes.InfantryLauncher,
                MilitaryMeshes.Pistol,
            };
            for (int i = 0; i < detailed.Length; i++)
                details[i] = new InstanceBatch(detailed[i], RenderResources.Instanced, 64)
                {
                    Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f),
                    Buffering = 3,
                    Shadows = i >= (int)Detail.Wheel ? ShadowCastingMode.Off : ShadowCastingMode.On
                };
        }

        static Kind Classify(string type)
        {
            switch (type)
            {
                case "tank": return Kind.Tank;
                case "autonomous_tank": return Kind.AutoTank;
                case "mech_infantry": return Kind.Apc;
                case "armored_car": return Kind.ArmoredCar;
                case "scout_buggy": return Kind.Buggy;
                case "supply_truck": case "colonist": return Kind.Truck;
                case "field_gun": return Kind.FieldGun;
                case "sp_artillery": return Kind.SpGun;
                case "missile_battery": return Kind.Launcher;
                case "air_defense": return Kind.AirDefense;
                case "helicopter": return Kind.Heli;
                case "fighter": return Kind.Fighter;
                case "bomber": return Kind.Bomber;
                case "recon_drone": case "oneway_drone": return Kind.Drone;
                case "strike_swarm": return Kind.Swarm;
                case "exo_infantry": return Kind.Exo;
                case "mortar_team": return Kind.Mortar;
                default: return Kind.Infantry;
            }
        }

        static bool IsAir(Kind k) => k == Kind.Heli || k == Kind.Fighter || k == Kind.Bomber || k == Kind.Drone || k == Kind.Swarm;
        static bool HasTurret(Kind k) => k == Kind.Tank || k == Kind.AutoTank || k == Kind.SpGun || k == Kind.ArmoredCar || k == Kind.AirDefense;
        static Detail Torso(string type) => type switch
        {
            "engineer" => Detail.Engineer, "militia" => Detail.Militia, "special_forces" => Detail.Special, "exo_infantry" => Detail.Exo,
            "anti_armor" => Detail.AntiArmor, "mortar_team" => Detail.MortarCrew, _ => Detail.Rifle
        };

        /// <summary>A shot seen in the combat stream: the shooter keeps facing its target for a while.</summary>
        public void NoteShot(int shooter, int target, float time, Vector2? point = null)
        {
            if (shooter > 0) lastShot[shooter] = (target, time, point);
        }

        void Ensure(int n)
        {
            if (yaw.Length >= n) return;
            int s = Math.Max(n, yaw.Length * 2);
            Array.Resize(ref yaw, s); Array.Resize(ref turret, s); Array.Resize(ref px, s); Array.Resize(ref pz, s);
            Array.Resize(ref seen, s); Array.Resize(ref kindOf, s);
            Array.Resize(ref torsoOf, s); Array.Resize(ref strikeDrone, s);
            Array.Resize(ref speed, s); Array.Resize(ref wheelPhase, s); Array.Resize(ref spread, s);
            Array.Resize(ref gaitPhase, s); Array.Resize(ref turnRate, s);
            Array.Resize(ref suspensionPitch, s); Array.Resize(ref suspensionRoll, s);
            Array.Resize(ref treadTravel, s);
            Array.Resize(ref airX, s); Array.Resize(ref airZ, s); Array.Resize(ref airH, s); Array.Resize(ref airBank, s); Array.Resize(ref airLive, s);
            int old = ids.Length;
            Array.Resize(ref ids, s);
            for (int i = old; i < s; i++) ids[i] = -1;
        }

        // Military paint: each faction fields its own camouflage scheme, with only a hint of its colour.
        // Aircraft wear lighter sky greys; autonomous machines a dark gunmetal.
        static readonly float3[] Camo =
        {
            new float3(0.33f, 0.35f, 0.22f),   // olive drab
            new float3(0.37f, 0.39f, 0.38f),   // field grey
            new float3(0.56f, 0.49f, 0.35f),   // desert sand
            new float3(0.22f, 0.29f, 0.21f),   // forest green
            new float3(0.31f, 0.35f, 0.39f),   // slate
            new float3(0.4f, 0.33f, 0.25f),    // dark earth
            new float3(0.45f, 0.44f, 0.36f),   // khaki
            new float3(0.27f, 0.3f, 0.28f),    // dark green-grey
        };

        static float3 Paint(int owner, Kind kind, float3 team)
        {
            float3 camo = Camo[((owner % Camo.Length) + Camo.Length) % Camo.Length];
            if (IsAir(kind)) camo = math.lerp(camo, new float3(0.55f, 0.58f, 0.6f), 0.65f);
            if (kind == Kind.AutoTank || kind == Kind.Exo) camo = math.lerp(camo, new float3(0.2f, 0.21f, 0.23f), 0.5f);
            float tint = kind == Kind.Infantry || kind == Kind.Mortar ? 0.22f : 0.12f;
            return math.lerp(camo, team, tint);
        }

        static float Approach(float a, float b, float rate)
        {
            float d = Mathf.DeltaAngle(a * Mathf.Rad2Deg, b * Mathf.Rad2Deg) * Mathf.Deg2Rad;
            return a + Mathf.Clamp(d, -rate, rate);
        }

        public unsafe void Update(UnitStore store, WorldModel world, Func<int, float4> civColor, float camX, Vector3 focus, float camDist, float time, float dt, StructureStore structures = null)
        {
            long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Clear();
            foreach (var b in details) b.Clear();
            Badges.Clear(); badgeIndex.Clear();
            if (!world.Ready) return;
            var grid = world.Grid;
            var view = world.View;
            if (structures != null && (footprintRevision != structures.Revision || footprintEpoch != world.Epoch))
            {
                footprintRevision = structures.Revision; footprintEpoch = world.Epoch; footprints.Clear();
                foreach (var b in structures.Buildings.Values) if (b.HasPosition) footprints[b.Tile] = b;
            }
            Ensure(store.SlotCount);
            int level = camDist > StrategicDistance ? 0 : camDist > OperationalDistance ? 1 : 2;
            float vehicleScale = 0.235f;
            float markerScale = Mathf.Clamp(camDist * 0.0065f, 0.3f, 2.4f);
            int drawn = 0;
            // pass 1: positions (base image) for every live slot, so turrets can aim at other units
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse) continue;
                bool fresh = ids[s] != u.Id;
                float oldX = px[s], oldZ = pz[s];
                if (fresh)
                {
                    ids[s] = u.Id;
                    string type = store.Types.Name(u.TypeIndex);
                    kindOf[s] = Classify(type);
                    torsoOf[s] = Torso(type);
                    strikeDrone[s] = type == "oneway_drone";
                    store.Heading(s, out float hx0, out float hz0);
                    yaw[s] = turret[s] = u.Motion.Present ? store.Facing(s) : hx0 != 0 || hz0 != 0 ? Mathf.Atan2(hx0, hz0) : (u.Id * 0.618f) % 6.283f;
                    airLive[s] = false;
                    speed[s] = spread[s] = wheelPhase[s] = 0f;
                    gaitPhase[s] = (u.Id * .618f % 1f) * math.PI * 2;
                    turnRate[s] = suspensionPitch[s] = suspensionRoll[s] = 0;
                    treadTravel[s] = 0;
                }
                store.Position(s, out px[s], out pz[s]);
                if (!fresh && dt > 0f)
                {
                    float dx = grid.DxWrap(oldX, px[s]), dz = pz[s] - oldZ;
                    speed[s] = Mathf.Lerp(speed[s], Mathf.Min(4f, Mathf.Sqrt(dx * dx + dz * dz) / dt), 1f - Mathf.Exp(-dt * 10f));
                    wheelPhase[s] = (wheelPhase[s] + Mathf.Sqrt(dx * dx + dz * dz) / .0247f) % (Mathf.PI * 2f);
                    treadTravel[s] += Mathf.Sqrt(dx * dx + dz * dz);
                    gaitPhase[s] = (gaitPhase[s] + Mathf.Sqrt(dx * dx + dz * dz) / .031f * math.PI) % (math.PI * 2);
                }
                if (IsAir(kindOf[s]))
                {
                    if (u.Motion.Present)
                    {
                        float facing = store.Facing(s);
                        float turn = fresh ? 0 : Mathf.DeltaAngle(airH[s] * Mathf.Rad2Deg, facing * Mathf.Rad2Deg) * Mathf.Deg2Rad / Mathf.Max(.001f, dt);
                        airBank[s] = Mathf.Lerp(airBank[s], Mathf.Clamp(turn * .25f, -.72f, .72f), 1f - Mathf.Exp(-dt * 5f));
                        airH[s] = facing;
                    }
                    else Fly(s, u.Id, kindOf[s], store, grid, time, dt);
                }
            }
            long t1 = System.Diagnostics.Stopwatch.GetTimestamp();
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse) continue;
                var kind = kindOf[s];
                float x = grid.NearX(px[s], camX), z = pz[s];
                float fx = grid.DxWrap(focus.x, x), fz = z - focus.z;
                bool close = level == 2 && fx * fx + fz * fz < (camDist + 3f) * (camDist + 3f);
                float ground = view.GroundHeight(x, z);
                int tile = u.Tile;
                // vehicles and troops cross bridges on the deck, not the river bed
                if (tile >= 0 && tile < grid.N && world.Road[tile] != 0 && (world.IsRiver(tile) || view.Water[tile] > -1e8f))
                    ground = Mathf.Max(ground, Mathf.Max(view.Water[tile], world.Height[tile]) + 0.06f);
                else if (tile >= 0 && tile < grid.N && view.Water[tile] > ground) ground = view.Water[tile];   // embarked
                // troops in a finished trench stand down in it, below the parapet
                if (!world.ActionLandscape && InTrench != null && tile >= 0 && InTrench(tile) && (kind == Kind.Infantry || kind == Kind.Mortar || kind == Kind.Exo || kind == Kind.FieldGun)) ground -= 0.035f;
                // facing: along the path when moving; toward the last target when engaging
                store.Heading(s, out float hx, out float hz);
                bool moving = hx != 0 || hz != 0;
                float wantHull = u.Motion.Present ? store.Facing(s) : moving ? Mathf.Atan2(hx, hz) : yaw[s];
                float wantTurret = wantHull;
                int target = u.Target;
                float shotAge = lastShot.TryGetValue(u.Id, out var shot) ? time - shot.time : 100f;
                if (shotAge < 6f && shot.target > 0) target = shot.target;
                if (target > 0 && store.SlotOf.TryGetValue(target, out int ts))
                {
                    float tx = grid.DxWrap(px[s], px[ts]), tz = pz[ts] - pz[s];
                    if (tx * tx + tz * tz > 1e-6f)
                    {
                        wantTurret = Mathf.Atan2(tx, tz);
                        if (!moving && !HasTurret(kind)) wantHull = wantTurret;   // guns, infantry and cars turn bodily
                    }
                }
                else if (shotAge < 3f && shot.point.HasValue)
                {
                    var aim = shot.point.Value;
                    wantTurret = Mathf.Atan2(grid.DxWrap(x, aim.x), aim.y - z);
                    if (!moving && !HasTurret(kind)) wantHull = wantTurret;
                }
                float previousFacing = yaw[s];
                yaw[s] = Approach(yaw[s], wantHull, dt * 2.2f);
                turnRate[s] = Mathf.Lerp(turnRate[s], Mathf.DeltaAngle(previousFacing * Mathf.Rad2Deg, yaw[s] * Mathf.Rad2Deg) * Mathf.Deg2Rad / Mathf.Max(.001f, dt), 1 - Mathf.Exp(-dt * 8));
                turret[s] = Approach(turret[s], wantTurret, dt * 3.5f);
                float4 team = civColor(u.Owner);
                float hp = Mathf.Clamp01(u.Hp / 100f);
                float4 body = new float4(Paint(u.Owner, kind, team.xyz) * (0.7f + 0.3f * hp), 0);
                var p = new float3(x, ground, z);
                drawn++;
                if (Selected.Contains(u.Id))
                    batches[(int)Model.Ring].Add(T(new float3(x, ground + 0.015f, z), 0, new float3(level == 0 ? markerScale * 1.4f : 0.42f), new float4(.54f, .86f, .65f, .18f)));
                else if (level > 0 && !IsAir(kind) && (camDist >= 12f || HighContrast))
                    // whose unit it is, at a glance: a faint team ring on the ground (the paint stays military)
                    batches[(int)Model.Ring].Add(T(new float3(x, ground + 0.012f, z), 0, new float3((kind == Kind.Infantry || kind == Kind.Mortar || kind == Kind.Exo ? 0.3f : 0.26f) * (HighContrast ? 1.25f : 1f)),
                        HighContrast ? new float4(math.saturate(team.xyz * 1.6f), 0.9f) : new float4(math.lerp(team.xyz, new float3(.50f, .55f, .54f), .34f), .10f)));
                if (level == 0)
                {
                    // strategic (bible §29): one badge per type of unit on a hex, shaped by role (circle:
                    // infantry, rectangle: vehicles, diamond: aircraft) with a dark rim so shape, not
                    // colour alone, tells them apart; units of one kind sharing a hex merge into one
                    // badge whose count the interface prints beside it
                    int cat = IsAir(kind) ? 2 : kind == Kind.Infantry || kind == Kind.Mortar || kind == Kind.Exo ? 0 : 1;
                    long key = ((long)u.Owner << 40) | ((long)Math.Max(0, tile) << 2) | (uint)cat;
                    if (badgeIndex.TryGetValue(key, out int bi)) { var bd = Badges[bi]; bd.Count++; Badges[bi] = bd; continue; }
                    float alt = cat == 2 ? 1.2f : 0.05f;
                    var mc = HighContrast ? new float4(math.saturate(team.xyz * 1.6f), 0.8f) : new float4(team.xyz, cat == 2 ? 0.35f : 0.2f);
                    var rim = new float4(team.xyz * 0.25f, 0f);
                    float m = markerScale;
                    var bp = p + new float3(0, alt, 0);
                    switch (cat)
                    {
                        case 0:
                            batches[(int)Model.Disc].Add(T(bp, 0, new float3(m * 1.5f, 1f, m * 1.5f), rim));
                            batches[(int)Model.Disc].Add(T(bp + new float3(0, 0.01f, 0), 0, new float3(m * 1.2f, 1f, m * 1.2f), mc));
                            break;
                        case 1:
                            batches[(int)Model.Plate].Add(T(bp, 0, new float3(m * 1.7f, m * 0.08f, m * 1.15f), rim));
                            batches[(int)Model.Plate].Add(T(bp + new float3(0, m * 0.04f, 0), 0, new float3(m * 1.45f, m * 0.08f, m * 0.92f), mc));
                            break;
                        default:
                            batches[(int)Model.Plate].Add(T(bp, 0.785f, new float3(m * 1.3f, m * 0.08f, m * 1.3f), rim));
                            batches[(int)Model.Plate].Add(T(bp + new float3(0, m * 0.04f, 0), 0.785f, new float3(m * 1.05f, m * 0.08f, m * 1.05f), mc));
                            break;
                    }
                    badgeIndex[key] = Badges.Count;
                    Badges.Add(new Badge { MapPos = bp, Count = 1, Category = cat, Owner = u.Owner });
                    continue;
                }
                float sc = vehicleScale;
                if (close && kind != Kind.Infantry && kind != Kind.Mortar && kind != Kind.Exo && !IsAir(kind))
                {
                    AddVehicle(kind, s, p, sc, body, team, shotAge, view, moving, u.Motion.Equipment);
                    if (kind == Kind.FieldGun) AddCrew(u.Id, p, yaw[s], 3, body, time, view, x, z);
                    continue;
                }
                switch (kind)
                {
                    case Kind.Infantry:
                    case Kind.Mortar:
                    case Kind.Exo:
                        AddSquad(s, u.Id, kind, p, yaw[s], close ? 2 : 1, moving, target > 0 || shotAge < 2.4f, time, dt, shotAge, body, ground, view, x, z, u.Motion.Equipment, (u.Flags & 256) != 0);
                        break;
                    case Kind.Tank:
                    case Kind.AutoTank:
                    case Kind.SpGun:
                    {
                        float k = kind == Kind.AutoTank ? 1.18f : 1f;
                        var tint = kind == Kind.AutoTank ? new float4(body.xyz, 0.05f) : body;
                        bool auto = kind == Kind.AutoTank;
                        batches[(int)(auto ? Model.AutoHull : Model.Hull)].Add(T(p, yaw[s], new float3(sc * k), tint));
                        batches[(int)(auto ? Model.AutoTurret : Model.Turret)].Add(T(p, turret[s], new float3(sc * k, sc * k, sc * k * (kind == Kind.SpGun ? 1.5f : 1f)), tint));
                        break;
                    }
                    case Kind.Apc:
                        batches[(int)Model.Apc].Add(T(p, yaw[s], new float3(sc), body));
                        break;
                    case Kind.ArmoredCar:
                        batches[(int)Model.Car].Add(T(p, yaw[s], new float3(sc * 0.9f), body));
                        batches[(int)Model.Turret].Add(T(p + new float3(0, -sc * 0.12f, 0), turret[s], new float3(sc * 0.55f), body));
                        break;
                    case Kind.Buggy:
                        batches[(int)Model.Buggy].Add(T(p, yaw[s], new float3(sc * 0.75f), body));
                        break;
                    case Kind.Truck:
                        batches[(int)Model.Truck].Add(T(p, yaw[s], new float3(sc * 0.9f), body));
                        break;
                    case Kind.FieldGun:
                        batches[(int)Model.Gun].Add(T(p, yaw[s], new float3(sc * 0.85f), body));
                        if (level == 2) AddCrew(u.Id, p, yaw[s], 3, body, time, view, x, z);
                        break;
                    case Kind.Launcher:
                        batches[(int)Model.Launcher].Add(T(p, yaw[s], new float3(sc), body));
                        break;
                    case Kind.AirDefense:
                        batches[(int)Model.Truck].Add(T(p, yaw[s], new float3(sc * 0.95f), body));
                        batches[(int)Model.Turret].Add(T(p + new float3(0, sc * 0.05f, 0), turret[s], new float3(sc * 0.6f, sc * 0.6f, sc * 0.4f), body));
                        break;
                    default:
                        AddAircraft(kind, s, u.Id, p, level, close, time, body, u.Motion.Present ? u.Motion.Altitude : -1f);
                        break;
                }
            }
            DrawCasualties(time, world, focus, camDist);
            long t2 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Upload();
            foreach (var b in details) b.Upload();
            long t3 = System.Diagnostics.Stopwatch.GetTimestamp();
            double f = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            PositionsMs = (t1 - t0) * f; BuildMs = (t2 - t1) * f; UploadMs = (t3 - t2) * f;
            Drawn = drawn;
            int inst = 0;
            foreach (var b in batches) inst += b.Count;
            foreach (var b in details) inst += b.Count;
            Instances = inst;
            // forget shots nobody remembers any more
            if (lastShot.Count > 4096) lastShot.Clear();
        }

        unsafe void AddSquad(int slot, int id, Kind kind, float3 p, float facing, int level, bool moving, bool fighting, float time,
            float dt, float shotAge, float4 body, float ground, SE.Core.World.TerrainView view, float x, float z, int equipment, bool assisting = false)
        {
            int figures = kind == Kind.Exo ? (level == 2 ? 3 : 2) : level == 2 ? 6 : 3;
            float scale = kind == Kind.Exo ? 0.084f : 0.069f;
            spread[slot] = Mathf.Lerp(spread[slot], fighting ? 1f : 0f, 1f - Mathf.Exp(-dt * 3.5f));
            math.sincos(facing, out float sn, out float cs);
            var model = kind == Kind.Exo ? Model.Exo : Model.Soldier;
            for (int f = 0; f < figures; f++)
            {
                float2 column = new float2(f % 2 == 0 ? -.057f : .057f, .08f - f / 2 * .122f);
                float2 line = new float2((f - (figures - 1) * .5f) * .087f, -.022f - (f % 2) * .067f);
                float2 o = math.lerp(column, line, spread[slot]) * (level == 2 ? 1f : 1.25f);
                // jitter so squads never look stamped
                float j = (id * 7 + f * 13) % 17 / 17f - 0.5f;
                o += new float2(j * 0.04f, -j * 0.03f);
                float ox = o.x * cs + o.y * sn, oz = -o.x * sn + o.y * cs;
                float fx = x + ox, fz = z + oz;
                if (level == 2 && footprints.Count > 0)
                    for (int attempt = 0; attempt < 5 && FigureBlocked(world: view, x: fx, z: fz); attempt++)
                    { fx = math.lerp(fx, x, .45f); fz = math.lerp(fz, z, .45f); }
                float fy = level == 2 ? view.GroundHeight(fx, fz) : ground;
                var foot = new float3(fx, Mathf.Max(fy, ground - 0.05f), fz);
                float phase = gaitPhase[slot] + f * .71f;
                if (level == 2)
                    AddFigure(torsoOf[slot], foot, facing + j * .20f, scale, body, moving ? math.saturate(speed[slot] / .11f) : 0f, spread[slot], phase, shotAge, equipment, view, assisting);
                else
                    batches[(int)model].Add(T(foot, facing + j * 0.3f, new float3(scale), body));
            }
            if (kind == Kind.Mortar && level == 2)
                details[(int)Detail.Mortar].Add(T(p, facing, new float3(0.09f), body));
        }

        unsafe bool FigureBlocked(TerrainView world, float x, float z)
        {
            int tile = HexMath.TileAt(x, z, world.W, world.H, world.Wrap != 0);
            if (tile < 0) return true;
            for (int d = -1; d < 6; d++)
            {
                int n = d < 0 ? tile : world.Nb[tile * 6 + d];
                if (!footprints.TryGetValue(n, out var b)) continue;
                float dx = HexMath.DxWrap(x, b.X, world.Period, world.Wrap != 0), dz = b.Z - z;
                float radius = b.Type == "motor_works" ? .58f : b.Type == "town" ? .53f : .46f;
                if (dx * dx + dz * dz < radius * radius) return true;
            }
            return false;
        }

        unsafe void AddFigure(Detail torso, float3 foot, float facing, float scale, float4 color, float stride, float aim, float phase, float shotAge, int equipment, TerrainView groundView = default, bool assisting = false)
        {
            float step = Mathf.Sin(phase) * stride, crouch = aim * (1f - stride) * .115f;
            float recoil = shotAge >= 0f && shotAge < .25f ? Mathf.Exp(-shotAge * 19) * (1 - Mathf.Exp(-shotAge * 180)) * .065f : 0f;
            float reload = shotAge > .40f && shotAge < 1.15f ? Mathf.Sin((shotAge - .40f) / .75f * Mathf.PI) : 0;
            float bob = -Mathf.Abs(step) * .018f + Mathf.Sin(phase * 2) * .006f * stride;
            var root = MapSpace.W(foot) + new float3(0, (bob - crouch) * scale, 0);
            var turn = quaternion.RotateY(MapSpace.Yaw(facing));
            var chest = math.mul(turn, quaternion.EulerZXY(.095f * stride + .19f * aim, step * .08f, step * .052f));
            var torsoOrigin = root + math.rotate(turn, new float3(0, .453f * scale, 0)) - math.rotate(chest, new float3(0, .453f * scale, 0));
            DetailPart(torso, torsoOrigin, chest, scale, color);
            bool engineer = torso == Detail.Engineer;
            var weapon = torsoOrigin + math.rotate(chest, new float3(engineer ? .12f : .055f, .535f + .12f * aim, .14f - recoil) * scale);
            var weaponTilt = math.mul(chest, quaternion.EulerZXY(.39f * (1f - aim) + reload * .12f, -.13f * (1f - aim), -.29f * (1f - aim) + reload * .20f));
            if ((equipment & 1) != 0)
            {
                var plate = torsoOrigin + math.rotate(chest, new float3(0, .63f, .105f) * scale);
                batches[(int)Model.Plate].Add(InstanceData.TRS(plate, chest, new float3(.22f, .19f, .037f) * scale, new float4(.34f, .38f, .29f, 0)));
            }
            if ((equipment & 16) != 0)
            {
                var radio = torsoOrigin + math.rotate(chest, new float3(-.14f, .75f, -.07f) * scale);
                batches[(int)Model.Plate].Add(InstanceData.TRS(radio, chest, new float3(.013f, .21f, .014f) * scale, new float4(.17f, .19f, .18f, 0)));
            }
            for (int side = -1; side <= 1; side += 2)
            {
                float s = side * step;
                var hip = root + math.rotate(turn, new float3(side * .072f, .454f, 0) * scale);
                float cycle = phase + (side < 0 ? math.PI : 0);
                float swing = Mathf.Max(0, Mathf.Cos(cycle));
                var ankle = MapSpace.W(foot) + math.rotate(turn, new float3(side * .072f, .029f + swing * swing * .095f * stride, Mathf.Sin(cycle) * .22f * stride) * scale);
                if (groundView.W > 0)
                {
                    float floor = groundView.GroundHeight(ankle.x, -ankle.z);
                    ankle.y += Mathf.Clamp(floor - foot.y, -.07f * scale, .13f * scale);
                }
                float3 delta = ankle - hip;
                float length = math.clamp(math.length(delta), .13f * scale, .461f * scale);
                float3 down = math.normalizesafe(delta, new float3(0, -1, 0));
                float a = .245f * scale, b = .222f * scale;
                float along = (a * a - b * b + length * length) / (2 * length);
                float bend = Mathf.Sqrt(Mathf.Max(0, a * a - along * along));
                float3 forward = math.rotate(turn, new float3(0, 0, 1));
                var knee = hip + down * along + math.normalizesafe(forward - down * math.dot(forward, down), forward) * bend;
                var thigh = LimbRotation(turn, knee - hip);
                var shin = LimbRotation(turn, ankle - knee);
                DetailPart(Detail.Thigh, hip, thigh, scale, color);
                DetailPart(Detail.Shin, knee, shin, scale, color);
                var shoulder = torsoOrigin + math.rotate(chest, new float3(side * .161f, .715f, .01f) * scale);
                float3 wrist;
                if (!engineer || aim > .25f && !assisting)
                {
                    var grip = side > 0 ? new float3(.006f, -.052f, -.045f) : new float3(-.014f, -.012f, .055f);
                    if (engineer) grip = new float3(side > 0 ? 0 : -.028f, -.035f, -.02f);
                    if (reload > 0 && side < 0) grip += new float3(-.03f, -.09f * reload, -.06f * reload);
                    wrist = weapon + math.rotate(weaponTilt, grip * scale);
                }
                else wrist = torsoOrigin + math.rotate(chest, new float3(side * .17f, assisting ? .49f : .43f, assisting ? .19f : .02f + s * .16f) * scale);
                var armDelta = wrist - shoulder;
                float armLength = math.clamp(math.length(armDelta), .055f * scale, .305f * scale);
                var armDown = math.normalizesafe(armDelta, new float3(0, -1, 0));
                float upperLength = .155f * scale, lowerLength = .154f * scale;
                float armAlong = (upperLength * upperLength - lowerLength * lowerLength + armLength * armLength) / (2 * armLength);
                float armBend = math.sqrt(math.max(0, upperLength * upperLength - armAlong * armAlong));
                var outward = math.rotate(chest, new float3(side * .7f, -.6f, -.4f));
                var elbow = shoulder + armDown * armAlong + math.normalizesafe(outward - armDown * math.dot(outward, armDown)) * armBend;
                var upper = LimbRotation(chest, elbow - shoulder);
                var forearm = LimbRotation(chest, wrist - elbow);
                DetailPart(Detail.UpperArm, shoulder, upper, scale, color);
                DetailPart(Detail.Forearm, elbow, forearm, scale, color);
            }
            if (!engineer || !assisting)
            {
                details[(int)(engineer ? Detail.PistolWeapon : torso == Detail.AntiArmor ? Detail.LauncherWeapon : Detail.RifleWeapon)].Add(InstanceData.TRS(weapon, weaponTilt, new float3(scale), new float4(.72f, .74f, .69f, 0)));
            }
        }

        void DetailPart(Detail part, float3 unity, quaternion rotation, float scale, float4 color)
            => details[(int)part].Add(InstanceData.TRS(unity, rotation, new float3(scale), color));

        static quaternion LimbRotation(quaternion facing, float3 direction)
        {
            float3 local = math.rotate(math.inverse(facing), direction);
            var q = Quaternion.FromToRotation(Vector3.down, new Vector3(local.x, local.y, local.z));
            return math.mul(facing, new quaternion(q.x, q.y, q.z, q.w));
        }

        void AddVehicle(Kind kind, int slot, float3 p, float scale, float4 body, float4 team, float shotAge,
            SE.Core.World.TerrainView view, bool moving, int equipment)
        {
            float facing = yaw[slot];
            math.sincos(facing, out float sn, out float cs);
            float h = scale * .43f;
            float f = view.GroundHeight(p.x + sn * h, p.z + cs * h) - view.GroundHeight(p.x - sn * h, p.z - cs * h);
            float r = view.GroundHeight(p.x + cs * h, p.z - sn * h) - view.GroundHeight(p.x - cs * h, p.z + sn * h);
            float pitch = Mathf.Clamp(-f / (h * 2), -.25f, .25f);
            float roll = Mathf.Clamp(r / (h * 2), -.24f, .24f);
            float kick = shotAge >= 0f && shotAge < .28f ? Mathf.Sin(shotAge * 11.22f) : 0;
            suspensionPitch[slot] = Mathf.Lerp(suspensionPitch[slot], pitch, .18f);
            suspensionRoll[slot] = Mathf.Lerp(suspensionRoll[slot], roll, .18f);
            var rot = quaternion.EulerZXY(suspensionPitch[slot] + kick * .018f, MapSpace.Yaw(facing), suspensionRoll[slot]);
            var at = MapSpace.W(p);
            bool tracked = kind == Kind.Tank || kind == Kind.AutoTank || kind == Kind.SpGun;
            Detail model = kind switch
            {
                Kind.Tank => Detail.Tank, Kind.AutoTank => Detail.Autonomous, Kind.SpGun => Detail.Howitzer,
                Kind.Apc => Detail.Carrier, Kind.ArmoredCar => Detail.ArmoredCar, Kind.Buggy => Detail.Scout, Kind.Truck => Detail.Truck,
                Kind.Launcher => Detail.RocketTruck, Kind.AirDefense => Detail.AirDefense, _ => Detail.FieldGun
            };
            if (kind == Kind.AutoTank) scale *= 1.12f;
            if (kind == Kind.Buggy || kind == Kind.FieldGun) scale *= .84f;
            var paint = new float4(body.xyz * 1.28f + .09f, 0);
            DetailPart(model, at, rot, scale, paint);
            if (kind == Kind.FieldGun) return;
            if (tracked)
            {
                for (int side = -1; side <= 1; side += 2) for (int link = 0; link < 26; link++)
                {
                    float travel = treadTravel[slot] / math.max(.01f, scale);
                    TrackPoint(link / 26f + travel / (1.48f + math.PI * .218f), out float ty, out float tz, out float tangentAngle);
                    var center = at + math.rotate(rot, new float3(side * .434f, ty, tz) * scale);
                    var tangent = math.mul(rot, quaternion.RotateX(tangentAngle));
                    batches[(int)Model.Plate].Add(InstanceData.TRS(center, tangent, new float3(.143f, .018f, .078f) * scale, new float4(.25f, .26f, .23f, 0)));
                }
                if ((equipment & 2) != 0) for (int side = -1; side <= 1; side += 2) for (int tile = 0; tile < 4; tile++)
                {
                    var center = at + math.rotate(rot, new float3(side * .367f, .25f, -.31f + tile * .20f) * scale);
                    batches[(int)Model.Plate].Add(InstanceData.TRS(center, rot, new float3(.052f, .113f, .16f) * scale, new float4(body.xyz * .82f, 0)));
                }
            }
            int axles = tracked ? 5 : kind == Kind.Apc ? 4 : kind == Kind.Truck || kind == Kind.Launcher || kind == Kind.AirDefense ? 3 : 2;
            float axleWidth = tracked ? .432f : kind == Kind.Buggy ? .239f : kind == Kind.Apc ? .30f : .277f;
            for (int side = -1; side <= 1; side += 2)
                for (int a = 0; a < axles; a++)
                {
                    float z = Mathf.Lerp(-.38f, .36f, (float)a / (axles - 1));
                    float sx = p.x + (side * axleWidth * cs + z * sn) * scale;
                    float sz = p.z + (-side * axleWidth * sn + z * cs) * scale;
                    float response = Mathf.Clamp((view.GroundHeight(sx, sz) - p.y) / scale, -.027f, .027f);
                    float y = (tracked ? .106f : .104f) + response;
                    var pivot = at + math.rotate(rot, new float3(side * axleWidth, y, z) * scale);
                    float steer = !tracked && a >= axles - 1 ? Mathf.Clamp(-turnRate[slot] * .34f, -.49f, .49f) : 0;
                    var wheel = math.mul(rot, math.mul(quaternion.RotateY(steer), quaternion.RotateX(wheelPhase[slot])));
                    DetailPart(tracked ? Detail.RoadWheel : Detail.Wheel, pivot, wheel, scale, new float4(.71f, .73f, .70f, 0));
                }
            if (tracked || kind == Kind.ArmoredCar)
            {
                var swivel = math.mul(rot, quaternion.RotateY(facing - turret[slot]));
                float y = kind == Kind.AutoTank ? .362f : kind == Kind.SpGun ? .455f : .420f;
                float k = kind == Kind.ArmoredCar ? .59f : 1f;
                var ring = kind == Kind.ArmoredCar ? at + math.rotate(rot, new float3(0, .167f, -.10f) * scale) : at;
                DetailPart(kind == Kind.AutoTank ? Detail.RemoteTurret : kind == Kind.SpGun ? Detail.HowitzerTurret : Detail.Turret, ring, swivel, scale * k, paint);
                var pivot = ring + math.rotate(swivel, new float3(0, y, .17f - kick * .09f) * (scale * k));
                DetailPart(kind == Kind.SpGun ? Detail.HowitzerBarrel : Detail.Barrel, pivot,
                    math.mul(swivel, quaternion.RotateX(kind == Kind.SpGun ? -.25f : -.02f)), scale * k, paint);
            }
            var marking = at + math.rotate(rot, new float3(.17f, tracked ? .287f : .246f, .36f) * scale);
            batches[(int)Model.Plate].Add(InstanceData.TRS(marking, rot, new float3(.072f, .007f, .068f) * scale, new float4(team.xyz, .06f)));
        }

        unsafe void AddCrew(int id, float3 p, float facing, int n, float4 body, float time, SE.Core.World.TerrainView view, float x, float z)
        {
            math.sincos(facing, out float sn, out float cs);
            for (int f = 0; f < n; f++)
            {
                float ox = (f - 1) * 0.06f, oz = -0.09f;
                float fx = x + ox * cs + oz * sn, fz = z - ox * sn + oz * cs;
                AddFigure(Detail.MortarCrew, new float3(fx, view.GroundHeight(fx, fz), fz), facing + (f - 1) * .5f,
                    .062f, body, 0, .7f, time * .8f + id + f, 10, 0, view);
            }
        }

        static void TrackPoint(float phase, out float y, out float z, out float angle)
        {
            const float straight = .74f, radius = .109f, arc = math.PI * radius;
            float path = math.frac(phase) * (straight * 2 + arc * 2);
            if (path < straight) { y = .021f; z = -.37f + path; angle = 0; }
            else if ((path -= straight) < arc)
            { float a = path / radius; y = .130f - math.cos(a) * radius; z = .37f + math.sin(a) * radius; angle = -a; }
            else if ((path -= arc) < straight) { y = .239f; z = .37f - path; angle = -math.PI; }
            else { float a = (path - straight) / radius; y = .130f + math.cos(a) * radius; z = -.37f - math.sin(a) * radius; angle = -math.PI - a; }
        }

        /// <summary>
        /// Flight model (presentation only). The server moves aircraft hex by hex along strafing passes
        /// and patrol rings; here each aircraft chases that position with a limited turn rate. Jets
        /// never slow below cruise, so they overshoot, bank and swing round for the next pass;
        /// helicopters slow down but keep circling their station; nothing hovers in a clump.
        /// </summary>
        void Fly(int s, int id, Kind kind, UnitStore store, HexGrid grid, float time, float dt)
        {
            float cruise, top, turn, lead;
            switch (kind)
            {
                case Kind.Fighter: cruise = 1.5f; top = 2.6f; turn = 1.5f; lead = 0.6f; break;
                case Kind.Bomber: cruise = 0.9f; top = 1.4f; turn = 0.65f; lead = 0.8f; break;
                case Kind.Heli: cruise = 0.22f; top = 1.2f; turn = 2.2f; lead = 0.35f; break;
                case Kind.Swarm: cruise = 0.5f; top = 1.9f; turn = 3.2f; lead = 0.3f; break;
                default: cruise = 0.35f; top = 1.6f; turn = 2.8f; lead = 0.3f; break;
            }
            float sx = px[s], sz = pz[s];
            store.Heading(s, out float hx, out float hz);
            bool moving = hx != 0 || hz != 0;
            if (!airLive[s] || Mathf.Abs(grid.DxWrap(airX[s], sx)) + Mathf.Abs(sz - airZ[s]) > 8f)
            {
                airLive[s] = true;
                airX[s] = sx; airZ[s] = sz; airH[s] = yaw[s]; airBank[s] = 0;
            }
            // the point being chased: ahead along the server path, or a station ring when on station
            float tx, tz;
            if (moving) { float l = Mathf.Sqrt(hx * hx + hz * hz); tx = sx + hx / l * lead; tz = sz + hz / l * lead; }
            else
            {
                float phase = (id * 0.6180339f) % 1f * 6.283f;
                float r = kind == Kind.Heli ? 0.55f : kind == Kind.Fighter ? 1.3f : kind == Kind.Bomber ? 1.8f : 0.45f;
                float a = phase + time * (kind == Kind.Heli ? 0.45f : 0.8f);
                tx = sx + Mathf.Cos(a) * r; tz = sz + Mathf.Sin(a) * r * 0.85f;
            }
            float dx = grid.DxWrap(airX[s], tx), dz = tz - airZ[s];
            float d = Mathf.Sqrt(dx * dx + dz * dz);
            float want = d > 1e-4f ? Mathf.Atan2(dx, dz) : airH[s];
            float before = airH[s];
            airH[s] = Approach(airH[s], want, turn * dt);
            float turnRate = Mathf.DeltaAngle(before * Mathf.Rad2Deg, airH[s] * Mathf.Rad2Deg) * Mathf.Deg2Rad / Mathf.Max(dt, 1e-4f);
            float speed = Mathf.Clamp(d * 1.6f, cruise, top);
            airX[s] += Mathf.Sin(airH[s]) * speed * dt;
            airZ[s] += Mathf.Cos(airH[s]) * speed * dt;
            float bankWant = Mathf.Clamp(turnRate * (kind == Kind.Heli ? 0.12f : 0.45f), -1.0f, 1.0f);
            airBank[s] = Mathf.Lerp(airBank[s], bankWant, 1f - Mathf.Exp(-dt * 4f));
            // aircraft are drawn (and shoot from) where they fly, not where the server hex is
            px[s] = airX[s]; pz[s] = airZ[s];
        }

        void AddAircraft(Kind kind, int slot, int id, float3 p, int level, bool close, float time, float4 body, float altitude)
        {
            float phase = (id * 0.6180339f) % 1f * 6.283f;
            float alt = kind == Kind.Heli ? 0.75f : kind == Kind.Fighter ? 2.0f : kind == Kind.Bomber ? 2.6f : 1.0f;
            if (altitude >= 0) alt = altitude;
            float a = phase + time * 1.6f;
            float heading = airH[slot];
            float bank = -airBank[slot];
            // Hover is subtle, and ground servicing has neither banking nor bobbing.
            float flightBlend = math.saturate(alt / .24f);
            float pitch = kind == Kind.Heli ? Mathf.Clamp(speed[slot] * .12f, 0, .22f) * flightBlend : 0f;
            var pos = p + new float3(0, alt + Mathf.Sin(time * .7f + phase) * .008f * flightBlend, 0);
            var rot = quaternion.EulerZXY(pitch, MapSpace.Yaw(heading), -bank);   // map heading into Unity space; mirroring flips the roll
            float s = altitude >= 0 ? 1f : level == 2 ? 1f : 1.5f;
            switch (kind)
            {
                case Kind.Heli:
                    if (close)
                    {
                        float scale = .28f * s;
                        var center = MapSpace.W(pos);
                        DetailPart(Detail.Helicopter, center, rot, scale, new float4(body.xyz * 1.35f + .07f, 0));
                        DetailPart(Detail.Rotor, center + math.rotate(rot, new float3(0, .316f, .08f) * scale),
                            math.mul(rot, quaternion.RotateY(time * (19f + flightBlend * 32f) + phase)), scale * 1.55f, new float4(.75f, .77f, .72f, 0));
                        var tail = center + math.rotate(rot, new float3(.052f, .28f, -.65f) * scale);
                        var tailSpin = math.mul(rot, math.mul(quaternion.RotateZ(math.PI * .5f), quaternion.RotateY(time * 74f + phase)));
                        DetailPart(Detail.Rotor, tail, tailSpin, scale * .27f, new float4(.51f, .54f, .50f, 0));
                    }
                    else
                    {
                        batches[(int)Model.Heli].Add(Q(pos, rot, new float3(0.28f * s), body));
                        batches[(int)Model.Rotor].Add(Q(pos + new float3(0, 0.085f * s, 0), quaternion.EulerZXY(0, time * 40f + phase, 0), new float3(0.62f * s, 0.28f * s, 0.62f * s), new float4(0.2f, 0.2f, 0.2f, 0)));
                    }
                    break;
                case Kind.Fighter:
                    (close ? details[(int)Detail.Fighter] : batches[(int)Model.Fighter]).Add(Q(pos, rot, new float3(0.48f * s), body));
                    break;
                case Kind.Bomber:
                    (close ? details[(int)Detail.Bomber] : batches[(int)Model.Bomber]).Add(Q(pos, rot, new float3(0.64f * s), body));
                    break;
                case Kind.Swarm:
                    for (int k = 0; k < 6; k++)
                    {
                        float b = a * 1.3f + k * 1.047f;
                        var d = pos + new float3(Mathf.Cos(b) * 0.12f, Mathf.Sin(b * 2) * 0.03f, Mathf.Sin(b) * 0.12f);
                        batches[(int)Model.Drone].Add(Q(d, quaternion.EulerZXY(0, MapSpace.Yaw(b + 1.57f), 0), new float3(0.07f * s), body));
                    }
                    break;
                default:
                    (close ? details[(int)(strikeDrone[slot] ? Detail.StrikeDrone : Detail.ReconDrone)] : batches[(int)Model.Drone])
                        .Add(Q(pos, rot, new float3(0.12f * s), body));
                    break;
            }
        }

        /// <summary>An instance from map position and map heading (converted once, here).</summary>
        static InstanceData T(float3 mapPos, float mapYaw, float3 s, float4 c) => InstanceData.TRS(MapSpace.W(mapPos), MapSpace.Yaw(mapYaw), s, c);
        /// <summary>An instance from map position and a rotation already in Unity space.</summary>
        static InstanceData Q(float3 mapPos, quaternion unityRotation, float3 s, float4 c) => InstanceData.TRS(MapSpace.W(mapPos), unityRotation, s, c);

        public void Draw()
        {
            foreach (var b in batches) b.Draw();
            foreach (var b in details) b.Draw();
        }

        /// <summary>Current drawn position of a unit (camera image), for selection and effects.</summary>
        public bool TryGetPosition(UnitStore store, int id, out Vector2 xz)
        {
            xz = default;
            if (!store.SlotOf.TryGetValue(id, out int s) || s >= px.Length || ids[s] != id) return false;
            xz = new Vector2(px[s], pz[s]);
            return true;
        }

        public void Dispose()
        {
            foreach (var b in batches) b.Dispose();
            foreach (var b in details) b.Dispose();
        }
    }
}
