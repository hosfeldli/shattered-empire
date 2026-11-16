using System;
using System.Collections.Generic;
using SE.Core.Units;
using SE.Core.World;
using SE.Runtime.Rendering;
using SE.Runtime.Cities;
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
        // Vehicle weight: a spring-damper body on its suspension (pitch, roll and their rates), the speed last frame
        // (acceleration squat and braking dive) and the shot that last rocked the hull.
        float[] pitchRate = new float[0], rollRate = new float[0], lastSpeed = new float[0], kickedAt = new float[0];
        float frameDt = 1f / 60f;
        // flight state per slot: aircraft fly continuously toward where the server says they are
        float[] airX = new float[0], airZ = new float[0], airH = new float[0], airBank = new float[0];
        // smoothed altitude, and the server track last frame with its measured speed (fast aircraft are chased at that speed)
        float[] airAlt = new float[0], srvX = new float[0], srvZ = new float[0], srvSpeed = new float[0];
        bool[] airLive = new bool[0];
        int[] ids = new int[0];
        // Squad behaviour (per slot): how long it has stood still, how far its men have gone to cover, how far they
        // have dropped into a trench, how far a mortar is set up, and the friendly vehicle they shelter behind.
        float[] stillFor = new float[0], coverBlend = new float[0], trenchIn = new float[0], deployState = new float[0];
        int[] coverArmor = new int[0];
        // per soldier (slot * MaxFigures + figure): the fold of ground each man picked when the squad went to ground
        float[] coverDx = new float[0], coverDz = new float[0];
        const int MaxFigures = 6;
        // armoured vehicles this frame (slots), for infantry sheltering behind them
        int[] armorSlots = new int[32];
        int armorCount;
        readonly Dictionary<int, (int target, float time, Vector2? point)> lastShot = new Dictionary<int, (int, float, Vector2?)>();
        readonly Dictionary<int, int> shotCounts = new Dictionary<int, int>();
        // the last shot aimed at each unit (time, shooter): squads under fire go to ground, facing the shooter
        readonly Dictionary<int, (float time, int shooter)> incoming = new Dictionary<int, (float, int)>();
        /// <summary>
        /// Server unit flag bits for crew weapons (mortar team, field gun): 512 deployed / ready to fire, 1024 setting
        /// up (2.5-3 s). When a server sends neither, deployment is derived from standing still and firing.
        /// </summary>
        public int DeployedFlag = 512, SettingUpFlag = 1024;
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
        // Positioned buildings by every tile their walls can reach (a hex may hold several buildings).
        readonly Dictionary<int, List<SE.Core.Protocol.BuildingRecord>> footprints = new Dictionary<int, List<SE.Core.Protocol.BuildingRecord>>();
        int footprintRevision = -1, footprintEpoch = -1;
        public int Instances { get; private set; }
        /// <summary>Last frame's cost by phase (diagnostics and stall attribution).</summary>
        public double PositionsMs, BuildMs, UploadMs;
        public float OperationalDistance = 26f, StrategicDistance = 75f;
        static readonly Vector3 Up = Vector3.up;

        // Rigged, animated infantry (Blender, tools/blender/build_soldiers.py), one batch per role:
        // Rifle, Engineer, Militia, Special, Exo, AntiArmor, MortarCrew (the Detail torso order).
        readonly SoldierRig[] rigs = new SoldierRig[7];
        readonly InstanceBatch[] soldiers = new InstanceBatch[7];

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
            for (int r = 0; r < rigs.Length; r++)
            {
                rigs[r] = SoldierRig.Load(r);
                if (rigs[r] != null)
                    soldiers[r] = new InstanceBatch(rigs[r].Mesh, rigs[r].Material, 128) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3 };
            }
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
            if (shooter > 0) { lastShot[shooter] = (target, time, point); shotCounts.TryGetValue(shooter, out int shots); shotCounts[shooter] = shots + 1; }
            if (target > 0) incoming[target] = (time, shooter);
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
            Array.Resize(ref pitchRate, s); Array.Resize(ref rollRate, s); Array.Resize(ref lastSpeed, s); Array.Resize(ref kickedAt, s);
            Array.Resize(ref treadTravel, s);
            Array.Resize(ref airX, s); Array.Resize(ref airZ, s); Array.Resize(ref airH, s); Array.Resize(ref airBank, s); Array.Resize(ref airLive, s);
            Array.Resize(ref airAlt, s); Array.Resize(ref srvX, s); Array.Resize(ref srvZ, s); Array.Resize(ref srvSpeed, s);
            Array.Resize(ref stillFor, s); Array.Resize(ref coverBlend, s); Array.Resize(ref trenchIn, s); Array.Resize(ref deployState, s);
            Array.Resize(ref coverArmor, s);
            Array.Resize(ref coverDx, s * MaxFigures); Array.Resize(ref coverDz, s * MaxFigures);
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
            frameDt = Mathf.Clamp(dt, 0f, .1f);
            foreach (var b in batches) b.Clear();
            foreach (var b in details) b.Clear();
            foreach (var b in soldiers) b?.Clear();
            Badges.Clear(); badgeIndex.Clear();
            armorCount = 0;
            if (!world.Ready) return;
            var grid = world.Grid;
            var view = world.View;
            if (structures != null && (footprintRevision != structures.Revision || footprintEpoch != world.Epoch))
            {
                footprintRevision = structures.Revision; footprintEpoch = world.Epoch; footprints.Clear();
                foreach (var b in structures.Buildings.Values)
                {
                    if (!b.HasPosition || b.Memory) continue;
                    int tile = HexMath.TileAt(b.X, b.Z, view.W, view.H, view.Wrap != 0);
                    if (tile < 0) continue;
                    if (!footprints.TryGetValue(tile, out var list)) footprints[tile] = list = new List<SE.Core.Protocol.BuildingRecord>();
                    list.Add(b);
                }
            }
            Ensure(store.SlotCount);
            int level = camDist > StrategicDistance ? 0 : camDist > OperationalDistance ? 1 : 2;
            float vehicleScale = WorldScale.Vehicle;
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
                    turnRate[s] = suspensionPitch[s] = suspensionRoll[s] = pitchRate[s] = rollRate[s] = lastSpeed[s] = 0; kickedAt[s] = -100;
                    treadTravel[s] = 0;
                    stillFor[s] = coverBlend[s] = trenchIn[s] = deployState[s] = 0; coverArmor[s] = -1;
                    srvSpeed[s] = 0; airAlt[s] = u.Motion.Present ? u.Motion.Altitude : 0;
                }
                store.Position(s, out px[s], out pz[s]);
                if (!fresh && dt > 0f)
                {
                    float dx = grid.DxWrap(oldX, px[s]), dz = pz[s] - oldZ;
                    speed[s] = Mathf.Lerp(speed[s], Mathf.Min(4f, Mathf.Sqrt(dx * dx + dz * dz) / dt), 1f - Mathf.Exp(-dt * 10f));
                    wheelPhase[s] = (wheelPhase[s] + Mathf.Sqrt(dx * dx + dz * dz) / .0247f) % (Mathf.PI * 2f);
                    treadTravel[s] += Mathf.Sqrt(dx * dx + dz * dz);
                    gaitPhase[s] = (gaitPhase[s] + Mathf.Sqrt(dx * dx + dz * dz) / (kindOf[s] == Kind.Exo ? .068f : .056f) * math.PI * 2) % (math.PI * 2);
                }
                if (IsAir(kindOf[s]))
                {
                    if (u.Motion.Present) FlySnapshot(s, kindOf[s], u.Motion, store, grid, fresh, dt);
                    else Fly(s, u.Id, kindOf[s], store, grid, time, dt);
                }
                else
                {
                    stillFor[s] = speed[s] > .012f ? 0 : stillFor[s] + dt;
                    var k0 = kindOf[s];
                    if (k0 == Kind.Tank || k0 == Kind.AutoTank || k0 == Kind.Apc || k0 == Kind.ArmoredCar || k0 == Kind.SpGun)
                    {
                        if (armorCount >= armorSlots.Length) Array.Resize(ref armorSlots, armorSlots.Length * 2);
                        armorSlots[armorCount++] = s;
                    }
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
                    ground = Mathf.Max(ground, RoadCurve.SupportHeight(world, x, z));
                else if (tile >= 0 && tile < grid.N && world.Road[tile] != 0)
                    ground = Mathf.Max(ground, RoadCurve.SupportHeight(world, x, z));
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
                // Continuous snapshots already interpolate authoritative steering. A second,
                // slower hull filter made fast vehicles visibly slide sideways through turns.
                yaw[s] = u.Motion.Present ? wantHull : Approach(yaw[s], wantHull, dt * 2.2f);
                turnRate[s] = Mathf.Lerp(turnRate[s], Mathf.DeltaAngle(previousFacing * Mathf.Rad2Deg, yaw[s] * Mathf.Rad2Deg) * Mathf.Deg2Rad / Mathf.Max(.001f, dt), 1 - Mathf.Exp(-dt * 8));
                // Turrets traverse at a believable rate (a main-gun turret ~45°/s, light mounts faster),
                // independently of the hull: a tank keeps its gun on the target while it drives past.
                float traverse = kind == Kind.Tank || kind == Kind.AutoTank ? .8f : kind == Kind.SpGun ? .45f : HasTurret(kind) ? 1.6f : 3.5f;
                turret[s] = Approach(turret[s], wantTurret, dt * traverse);
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
                    {
                        // Under fire: the squad goes to ground facing whoever is shooting at it, behind a friendly
                        // vehicle when one stands close by.
                        var threat = new float2(Mathf.Sin(yaw[s]), Mathf.Cos(yaw[s]));
                        bool underFire = incoming.TryGetValue(u.Id, out var inc) && time - inc.time < 5f && time >= inc.time;
                        if (underFire && inc.shooter > 0 && store.SlotOf.TryGetValue(inc.shooter, out int shooterSlot) && shooterSlot < px.Length)
                        {
                            var toShooter = new float2(grid.DxWrap(px[s], px[shooterSlot]), pz[shooterSlot] - pz[s]);
                            if (math.lengthsq(toShooter) > 1e-6f) threat = math.normalize(toShooter);
                        }
                        // while the men are still coming back out from behind a vehicle, keep that vehicle as their reference
                        int keptArmor = coverArmor[s];
                        bool keepValid = keptArmor >= 0 && keptArmor < store.SlotCount && store.Records[keptArmor].InUse && coverBlend[s] > 0f && !moving;
                        coverArmor[s] = underFire && !moving && kind != Kind.Mortar ? FindCoverArmor(s, u.Owner, store, grid) : keepValid ? keptArmor : -1;
                        int deployHint = (u.Flags & DeployedFlag) != 0 ? 2 : (u.Flags & SettingUpFlag) != 0 ? 1 : 0;
                        AddSquad(s, u.Id, kind, p, yaw[s], close ? 2 : 1, moving, target > 0 || shotAge < 2.4f, time, dt, shotAge, body, ground, view, x, z, u.Motion.Equipment,
                            (u.Flags & 256) != 0, underFire, threat, deployHint);
                        break;
                    }
                    case Kind.Tank:
                    case Kind.AutoTank:
                    case Kind.SpGun:
                    {
                        float k = kind == Kind.AutoTank ? 1.18f : 1f;
                        var tint = kind == Kind.AutoTank ? new float4(body.xyz, 0.05f) : body;
                        bool auto = kind == Kind.AutoTank;
                        batches[(int)(auto ? Model.AutoHull : Model.Hull)].Add(T(p, yaw[s], new float3(sc * k * .64f, sc * k, sc * k * 1.12f), tint));   // true proportions (see AddVehicle)
                        batches[(int)(auto ? Model.AutoTurret : Model.Turret)].Add(T(p, turret[s], new float3(sc * k * .8f, sc * k, sc * k * (kind == Kind.SpGun ? 1.5f : 1f)), tint));
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
                        AddAircraft(kind, s, u.Id, p, level, close, time, body, u.Motion.Present ? Mathf.Max(0f, airAlt[s]) : -1f);
                        break;
                }
            }
            DrawCasualties(time, world, focus, camDist);
            long t2 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Upload();
            foreach (var b in details) b.Upload();
            foreach (var b in soldiers) b?.Upload();
            long t3 = System.Diagnostics.Stopwatch.GetTimestamp();
            double f = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            PositionsMs = (t1 - t0) * f; BuildMs = (t2 - t1) * f; UploadMs = (t3 - t2) * f;
            Drawn = drawn;
            int inst = 0;
            foreach (var b in batches) inst += b.Count;
            foreach (var b in details) inst += b.Count;
            foreach (var b in soldiers) if (b != null) inst += b.Count;
            Instances = inst;
            // forget shots nobody remembers any more
            if (lastShot.Count > 4096) { lastShot.Clear(); shotCounts.Clear(); }
            if (incoming.Count > 4096) incoming.Clear();
        }

        // Rigged figure poses. Auto picks walk / run / aim / fire / idle from motion and combat.
        const int PoseAuto = 0, PoseKneel = 1, PoseDeploy = 2, PoseHop = 3, PoseDash = 4;

        /// <summary>The friendly armoured vehicle (slot) close to this squad and still enough to shelter behind, or -1.</summary>
        int FindCoverArmor(int s, int owner, UnitStore store, HexGrid grid)
        {
            int keep = coverArmor[s], found = -1;
            float best = .45f * .45f;
            for (int i = 0; i < armorCount; i++)
            {
                int a = armorSlots[i];
                if (a == s || a >= store.SlotCount) continue;
                ref var r = ref store.Records[a];
                if (!r.InUse || r.Owner != owner || speed[a] > .08f) continue;
                float dx = grid.DxWrap(px[s], px[a]), dz = pz[a] - pz[s];
                float d2 = dx * dx + dz * dz;
                if (a == keep) d2 *= .6f;   // stay with the vehicle already chosen
                if (d2 < best) { best = d2; found = a; }
            }
            return found;
        }

        /// <summary>Where each man of a set-up mortar team works (lateral, forward of the tube, map units).</summary>
        static float2 CrewSpot(int f) => f switch
        {
            0 => new float2(-.03f, -.012f),    // loader, at the muzzle
            1 => new float2(.032f, -.02f),     // gunner, at the sight
            2 => new float2(-.006f, -.062f),   // ammunition bearer, behind
            3 => new float2(-.085f, .045f),    // the rest kneel out to the flanks and front, watching
            4 => new float2(.085f, .05f),
            _ => new float2(0f, .095f),
        };

        /// <summary>
        /// A squad as individual soldiers. On the move: a column or line, each man on his own gait phase. Halted:
        /// calm idle, or engaged (some kneel). Under fire: each man in turn dashes to cover (behind a friendly
        /// vehicle on the far side from the shooter, else the lowest fold of ground near his place: a shell hole,
        /// a ditch) and kneels facing the threat. A trench is entered with a short hop down, one man after another.
        /// A mortar team halts, kneels round the tube while it is laid down and raised on its baseplate, then
        /// works it. Every choice is seeded by unit id and figure, and nothing here allocates.
        /// </summary>
        unsafe void AddSquad(int slot, int id, Kind kind, float3 p, float facing, int level, bool moving, bool fighting, float time,
            float dt, float shotAge, float4 body, float ground, SE.Core.World.TerrainView view, float x, float z, int equipment, bool assisting,
            bool underFire, float2 threat, int deployHint)
        {
            int figures = kind == Kind.Exo ? (level == 2 ? 3 : 2) : level == 2 ? 6 : 3;
            float scale = kind == Kind.Exo ? WorldScale.Soldier * 1.20f : WorldScale.Soldier;
            spread[slot] = Mathf.Lerp(spread[slot], fighting ? 1f : 0f, 1f - Mathf.Exp(-dt * 3.5f));
            math.sincos(facing, out float sn, out float cs);
            bool trench = TryTrenchFrame(view, x, z, out float trenchX, out float trenchZ, out float trenchFacing, out float trenchBlend);
            var model = kind == Kind.Exo ? Model.Exo : Model.Soldier;
            bool still = !moving && stillFor[slot] > .3f;
            // into a trench: the men drop into the cut one after another (and climb out the same way)
            float trenchGoal = trench && !moving && trenchBlend > .5f ? 1f : 0f;
            float trenchBefore = trenchIn[slot];
            trenchIn[slot] = Mathf.MoveTowards(trenchBefore, trenchGoal, dt * (trenchGoal > trenchBefore ? 1.1f : 2.2f));
            bool trenchShift = trenchIn[slot] != trenchBefore, climbingIn = trenchIn[slot] > trenchBefore;
            // a mortar team sets up when it halts to fire (or the server reports it emplaced) and packs up to move
            bool mortar = kind == Kind.Mortar;
            if (mortar)
            {
                // server flags when present (1 setting up: ~2.8 s to ready, 2 deployed: finish quickly); otherwise derived
                bool wantDeploy = !moving && (deployHint > 0 || stillFor[slot] > .5f && (deployState[slot] > 0f || fighting || shotAge < 20f));
                float rate = !wantDeploy ? 1.6f : deployHint == 2 ? 1.5f : deployHint == 1 ? 1f / 2.8f : 1f / 3.2f;
                deployState[slot] = Mathf.MoveTowards(deployState[slot], wantDeploy ? 1f : 0f, dt * rate);
            }
            float deploy = mortar ? deployState[slot] : 0f;
            float setup = Mathf.SmoothStep(0f, 1f, deploy);
            // going to ground under fire (not in a trench, not a mortar crew at its tube)
            bool canCover = still && underFire && trenchGoal < .5f && !(mortar && deploy > .05f);
            float coverBefore = coverBlend[slot];
            bool chooseCover = canCover && coverBefore <= 0f;   // each man picks his spot once, as the squad reacts
            coverBlend[slot] = Mathf.MoveTowards(coverBefore, canCover ? 1f : 0f, dt * (canCover ? 1.1f : 1.8f));
            float cover = coverBlend[slot];
            bool coverShift = cover != coverBefore, takingCover = cover > coverBefore;
            int armor = coverArmor[slot];
            float tankX = 0f, tankZ = 0f;
            if (armor >= 0)
            {
                tankX = x + HexMath.DxWrap(px[slot], px[armor], view.Period, view.Wrap != 0);
                tankZ = pz[armor];
            }
            var across = new float2(threat.y, -threat.x);
            float threatYaw = Mathf.Atan2(threat.x, threat.y);
            bool reloadCycle = shotCounts.TryGetValue(id, out int shots) && shots > 0 && shots % 8 == 0;
            for (int f = 0; f < figures; f++)
            {
                float2 column = new float2(f % 2 == 0 ? -.057f : .057f, .08f - f / 2 * .122f);
                float2 line = new float2((f - (figures - 1) * .5f) * .087f, -.022f - (f % 2) * .067f);
                float2 o = math.lerp(column, line, spread[slot]) * (level == 2 ? 1f : 1.25f);
                // jitter so squads never look stamped
                float j = (id * 7 + f * 13) % 17 / 17f - 0.5f;
                o += new float2(j * 0.04f, -j * 0.03f);
                if (mortar && setup > 0f) o = math.lerp(o, CrewSpot(f), setup);
                float ox = o.x * cs + o.y * sn, oz = -o.x * sn + o.y * cs;
                float fx = x + ox, fz = z + oz;
                int seed = id * 31 + f * 7;
                float order = Trait(seed, 12);   // who reacts first
                if (trench)
                {
                    float along = (f - (figures - 1) * .5f) * .071f;
                    fx = Mathf.Lerp(fx, trenchX - Mathf.Cos(trenchFacing) * along, trenchBlend);
                    fz = Mathf.Lerp(fz, trenchZ + Mathf.Sin(trenchFacing) * along, trenchBlend);
                }
                int coverIndex = slot * MaxFigures + Mathf.Min(f, MaxFigures - 1);
                if (chooseCover)
                {
                    // the lowest spot a few metres around him, preferring ground away from the shooter
                    float bestScore = view.GroundHeight(fx, fz) - .003f, bestX = 0f, bestZ = 0f;
                    float turn = Trait(seed, 15) * 1.5708f;
                    for (int c = 0; c < 4; c++)
                    {
                        float a = turn + c * 1.5708f;
                        float cdx = Mathf.Sin(a) * .065f, cdz = Mathf.Cos(a) * .065f;
                        float score = view.GroundHeight(fx + cdx, fz + cdz) + (cdx * threat.x + cdz * threat.y) * .03f;
                        if (score < bestScore) { bestScore = score; bestX = cdx; bestZ = cdz; }
                    }
                    coverDx[coverIndex] = bestX; coverDz[coverIndex] = bestZ;
                }
                float myCover = cover > 0f ? math.saturate(cover * 1.45f - order * .45f) : 0f;
                float dashYaw = facing;
                if (myCover > 0f)
                {
                    float gx, gz;
                    if (armor >= 0)
                    {
                        // tucked in behind the hull, spread along it, on the side away from the shooter
                        float lateral = (f - (figures - 1) * .5f) * .04f + j * .015f;
                        float back = .17f + Trait(seed, 13) * .05f;
                        gx = tankX - threat.x * back + across.x * lateral;
                        gz = tankZ - threat.y * back + across.y * lateral;
                    }
                    else { gx = fx + coverDx[coverIndex]; gz = fz + coverDz[coverIndex]; }
                    if ((gx - fx) * (gx - fx) + (gz - fz) * (gz - fz) > 1e-6f) dashYaw = Mathf.Atan2(gx - fx, gz - fz);
                    float blend = Mathf.SmoothStep(0f, 1f, myCover);
                    fx = Mathf.Lerp(fx, gx, blend); fz = Mathf.Lerp(fz, gz, blend);
                }
                if (level == 2 && footprints.Count > 0)
                    for (int attempt = 0; attempt < 6 && FigureBlocked(world: view, x: fx, z: fz); attempt++)
                    {
                        // Slide toward the squad's own (server-legal) position first; then fan sideways.
                        if (attempt < 4) { fx = math.lerp(fx, x, .45f); fz = math.lerp(fz, z, .45f); }
                        else { float side = (f % 2 == 0 ? 1 : -1) * .05f; fx += Mathf.Cos(facing) * side; fz -= Mathf.Sin(facing) * side; }
                    }
                float fy = level == 2 ? view.GroundHeight(fx, fz) : ground;
                // manning a trench: stood down in the cut (~1.1 m) behind the parapet, facing the enemy side.
                // Each man drops in on his own beat with a little hop.
                float drop = trench ? math.saturate(trenchIn[slot] * 1.5f - order * .5f) : 0f;
                float stand = trench ? Mathf.SmoothStep(0f, 1f, drop) * trenchBlend : 0f;
                bool hopping = trenchShift && drop > .02f && drop < .98f;
                float hopLift = hopping ? Mathf.Sin(drop * Mathf.PI) * .012f : 0f;
                var foot = new float3(fx, trench ? fy - .045f * stand + hopLift : Mathf.Max(fy, ground - 0.05f), fz);
                float figureFacing = stand > .5f ? trenchFacing + j * .25f : facing + j * .20f;
                int pose = PoseAuto;
                float poseTime = 0f;
                if (!moving)
                {
                    if (hopping) { pose = PoseHop; poseTime = climbingIn ? drop : 1f - drop; }
                    else if (mortar && setup > .05f)
                    {
                        // loader and ammunition bearer work the tube, the gunner lays it (then kneels at the
                        // sight), the rest kneel out to the front and flanks
                        bool atTube = f == 0 || f == 2 || f == 1 && deploy < .98f;
                        pose = atTube ? PoseDeploy : PoseKneel;
                        if (atTube && (x - fx) * (x - fx) + (z - fz) * (z - fz) > 1e-6f) figureFacing = Mathf.Atan2(x - fx, z - fz);
                    }
                    else if (coverShift && myCover > .02f && myCover < .98f)
                    {
                        // a crouching dash to his spot (or back up to the line)
                        pose = PoseDash; poseTime = time * 1.45f + order;
                        figureFacing = takingCover ? dashYaw : dashYaw + Mathf.PI;
                    }
                    else if (myCover >= .98f) { pose = PoseKneel; figureFacing = threatYaw + j * .15f; }
                    else if (fighting && stand < .5f && Trait(seed, 14) < .35f) pose = PoseKneel;
                }
                if (level == 2)
                {
                    AddFigure(torsoOf[slot], foot, figureFacing, scale, body, moving ? math.saturate(speed[slot] / .11f) : 0f, Mathf.Max(spread[slot], stand * .6f),
                        gaitPhase[slot] + f * .71f + j * 1.3f, shotAge, equipment, view, assisting, reloadCycle, seed, pose, poseTime);
                    if (mortar && f == 0 && setup < .15f)
                    {
                        // packed: the tube rides on the loader's back
                        var carry = quaternion.RotateY(MapSpace.Yaw(figureFacing));
                        var slung = MapSpace.W(foot) + math.rotate(carry, new float3(.045f, .6f, -.14f) * scale);
                        batches[(int)Model.Plate].Add(InstanceData.TRS(slung, math.mul(carry, quaternion.RotateX(-.32f)), new float3(.075f, .76f, .075f) * scale, new float4(.18f, .19f, .17f, 0)));
                    }
                }
                else
                    batches[(int)model].Add(T(foot, figureFacing + j * 0.1f, new float3(scale), body));
            }
            if (mortar && level == 2 && setup > .15f)
            {
                // the tube is laid on the ground, then raised on its baseplate and bipod; each round kicks it down
                float raise = Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(.35f, .9f, deploy));
                float kick = deploy > .98f && shotAge >= 0f && shotAge < .4f ? Mathf.Exp(-shotAge * 12f) * (1f - Mathf.Exp(-shotAge * 90f)) * .006f : 0f;
                var tube = quaternion.EulerZXY((1f - raise) * 1.3f, MapSpace.Yaw(facing), (1f - raise) * .25f);
                float baseY = view.GroundHeight(x, z);
                details[(int)Detail.Mortar].Add(InstanceData.TRS(MapSpace.W(new float3(x, baseY - kick, z)), tube, new float3(.09f * Mathf.Lerp(.9f, 1f, raise)), body));
            }
        }

        static unsafe bool TryTrenchFrame(TerrainView view, float x, float z, out float tx, out float tz, out float facing, out float blend)
        {
            tx = x; tz = z; facing = blend = 0;
            int tile = HexMath.TileAt(x, z, view.W, view.H, view.Wrap != 0);
            if (tile < 0 || view.Trenches == null) return false;
            float nearest = .27f;
            for (int i = -1; i < 6; i++)
            {
                int n = i < 0 ? tile : view.Nb[tile * 6 + i];
                if (n < 0 || view.Trenches[n * 4 + 3] < .05f) continue;
                int tr = n * 4; float a = view.Trenches[tr + 2], sa = Mathf.Sin(a), ca = Mathf.Cos(a);
                float cx = HexMath.CenterX(n, view.W) + view.Trenches[tr], cz = HexMath.CenterZ(n, view.W) + view.Trenches[tr + 1];
                float dx = HexMath.DxWrap(cx, x, view.Period, view.Wrap != 0), dz = z - cz;
                float along = Mathf.Clamp(-dx * ca + dz * sa, -.56f, .56f);
                float px = cx - ca * along, pz = cz + sa * along;
                float distance = Mathf.Sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
                if (distance >= nearest) continue;
                nearest = distance; tx = px; tz = pz; facing = a;
                blend = 1 - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.06f, .27f, distance));
            }
            return blend > 0;
        }

        unsafe bool FigureBlocked(TerrainView world, float x, float z)
        {
            int tile = HexMath.TileAt(x, z, world.W, world.H, world.Wrap != 0);
            if (tile < 0) return true;
            for (int d = -1; d < 6; d++)
            {
                int n = d < 0 ? tile : world.Nb[tile * 6 + d];
                if (!footprints.TryGetValue(n, out var list)) continue;
                foreach (var b in list)
                {
                    // Recorded walls when this type has been drawn; the old circle until then.
                    if (Cities.CityRenderer.Footprints.ContainsKey(b.Type))
                    {
                        if (Cities.CityRenderer.InsideFootprint(b, x, z, .018f, world.Period, world.Wrap != 0)) return true;
                        continue;
                    }
                    float dx = HexMath.DxWrap(x, b.X, world.Period, world.Wrap != 0), dz = b.Z - z;
                    float radius = b.Type == "motor_works" ? .58f : b.Type == "town" ? .53f : .46f;
                    if (dx * dx + dz * dz < radius * radius) return true;
                }
            }
            return false;
        }

        /// <summary>The rigged soldier for a torso role, if it was built and baked.</summary>
        SoldierRig RigFor(Detail torso, out int role)
        {
            role = (int)torso - (int)Detail.Rifle;
            return role >= 0 && role < rigs.Length ? rigs[role] : null;
        }

        /// <summary>
        /// One animated soldier: run or walk locked to the distance-driven gait phase (no foot sliding as
        /// speed changes), the firing clip on a fresh shot, aiming while engaged, otherwise idle breathing
        /// and scanning. Per-figure offsets keep a squad from moving in lockstep.
        /// </summary>
        static float Trait(int seed, int k) => math.frac(math.sin(seed * 12.9898f + k * 78.233f) * 43758.5453f);

        /// <summary>
        /// One soldier, as an individual. Stable per-man traits (seeded by squad and position): height
        /// (1.66-1.86 m), build, stride length and cadence, how often he shifts his weight, scans the horizon or
        /// brings his rifle up when nothing is happening, and how quickly he reacts to a volley (so a squad's
        /// shots ripple instead of firing as one). Kit from the barracks upgrades is worn on the body.
        /// </summary>
        void AddRigged(int role, float3 foot, float facing, float scale, float4 color, float stride, float aim, float phase, float shotAge, int seed = 0, int equipment = 0,
            int pose = PoseAuto, float poseTime = 0f)
        {
            var rig = rigs[role];
            float height = .95f + Trait(seed, 1) * .11f, build = .96f + Trait(seed, 2) * .09f;
            float cadence = .92f + Trait(seed, 3) * .16f, reaction = Trait(seed, 4) * .22f;
            float cycle = phase / (2 * Mathf.PI) * cadence;
            float now = Time.time + Trait(seed, 5) * 40f;
            float frame;
            float look = 0;
            // kit offsets follow the torso down when he kneels or leans over the tube
            float kitDrop = 0f, kitForward = 0f, kitLean = 0f;
            switch (pose)
            {
                case PoseDash:
                    frame = rig.Cycle(SoldierRig.Clip.Run, poseTime);
                    break;
                case PoseHop:
                    frame = rig.Has(SoldierRig.Clip.Hop) ? rig.Frame(SoldierRig.Clip.Hop, poseTime * rig.Duration(SoldierRig.Clip.Hop)) : rig.Cycle(SoldierRig.Clip.Walk, poseTime);
                    break;
                case PoseKneel:
                    frame = rig.Has(SoldierRig.Clip.Kneel) ? rig.Frame(SoldierRig.Clip.Kneel, now * (.8f + Trait(seed, 6) * .4f)) : rig.Frame(SoldierRig.Clip.Aim, now);
                    if (rig.Has(SoldierRig.Clip.Kneel)) { kitDrop = .19f; kitLean = .1f; }
                    look = Mathf.Sin(now * .3f) * .04f;
                    break;
                case PoseDeploy:
                    frame = rig.Has(SoldierRig.Clip.Deploy) ? rig.Frame(SoldierRig.Clip.Deploy, now * (.9f + Trait(seed, 6) * .2f)) : rig.Frame(SoldierRig.Clip.Aim, now);
                    if (rig.Has(SoldierRig.Clip.Deploy)) { kitDrop = .21f; kitForward = .04f; kitLean = .5f; }
                    break;
                default:
                    if (stride > .08f) frame = rig.Cycle(stride > .72f ? SoldierRig.Clip.Run : SoldierRig.Clip.Walk, cycle);
                    else if (shotAge >= reaction && shotAge < reaction + .2f && aim > .25f) frame = rig.Frame(SoldierRig.Clip.Fire, shotAge - reaction);
                    else if (aim > .25f) { frame = rig.Frame(SoldierRig.Clip.Aim, now * (.8f + Trait(seed, 6) * .4f)); look = Mathf.Sin(now * .35f) * .05f; }
                    else
                    {
                        // at ease: calm idle; the head and shoulders only drift a little, slowly (no scanning, no rifle raising)
                        frame = rig.Frame(SoldierRig.Clip.Idle, now * (.85f + Trait(seed, 8) * .3f));
                        look = Mathf.Sin(now * (.05f + Trait(seed, 9) * .04f)) * .07f;
                    }
                    break;
            }
            facing += look;
            var rot = quaternion.RotateY(MapSpace.Yaw(facing));
            var at = MapSpace.W(foot);
            soldiers[role].Add(InstanceData.TRS(at, rot, new float3(scale * build, scale * height, scale * build), new float4(color.xyz, 2 + frame)));
            if ((equipment & (32 | 64 | 128 | 256)) == 0) return;
            // barracks kit, worn on the torso (offsets in model units, ~1.02 tall)
            float s = scale * height;
            var kit = new float4(.20f, .22f, .17f, 0);
            var torsoRot = kitLean != 0f ? math.mul(rot, quaternion.RotateX(kitLean)) : rot;
            float3 P(float x, float y, float z) => at + math.rotate(rot, new float3(x * build, y - kitDrop, z * build + kitForward) * s);
            if ((equipment & 128) != 0)   // body armour: plate carrier front and back
            {
                batches[(int)Model.Plate].Add(InstanceData.TRS(P(0, .66f, .085f), torsoRot, new float3(.20f, .21f, .045f) * s, kit));
                batches[(int)Model.Plate].Add(InstanceData.TRS(P(0, .67f, -.09f), torsoRot, new float3(.19f, .20f, .04f) * s, kit));
            }
            if ((equipment & 32) != 0)    // grenades on the belt
                for (int g = -1; g <= 1; g += 2)
                    batches[(int)Model.Plate].Add(InstanceData.TRS(P(g * .075f, .52f, .095f), torsoRot, new float3(.045f, .055f, .045f) * s, new float4(.26f, .30f, .20f, 0)));
            if ((equipment & 64) != 0 && (role == 0 || role == 2 || role == 3) && Trait(seed, 10) < .5f)   // a disposable rocket slung across the back
                batches[(int)Model.Plate].Add(InstanceData.TRS(P(.03f, .70f, -.15f), math.mul(torsoRot, quaternion.RotateZ(.55f)), new float3(.055f, .62f, .055f) * s, new float4(.30f, .33f, .24f, 0)));
            if ((equipment & 256) != 0 && Trait(seed, 11) < .2f && pose != PoseDeploy)   // the squad's marksman: a long scope on his rifle
                batches[(int)Model.Plate].Add(InstanceData.TRS(P(.06f, .83f, .30f), rot, new float3(.022f, .024f, .16f) * s, new float4(.12f, .12f, .12f, 0)));
        }

        unsafe void AddFigure(Detail torso, float3 foot, float facing, float scale, float4 color, float stride, float aim, float phase, float shotAge, int equipment, TerrainView groundView = default, bool assisting = false, bool reloadCycle = false, int seed = 0,
            int pose = PoseAuto, float poseTime = 0f)
        {
            if (RigFor(torso, out int rigRole) != null) { AddRigged(rigRole, foot, facing, scale, color, stride, aim, phase, shotAge, seed, equipment, pose, poseTime); return; }
            // the procedural figure approximates the poses: crouched aim for kneeling work, a run for a dash
            if (pose == PoseKneel || pose == PoseDeploy) { stride = 0f; aim = 1f; }
            else if (pose == PoseDash) { stride = 1f; phase = poseTime * 2f * Mathf.PI; }
            else if (pose == PoseHop) { stride = .5f; phase = poseTime * Mathf.PI; }
            float step = Mathf.Sin(phase) * stride, crouch = aim * (1f - stride) * .115f;
            float recoil = shotAge >= 0f && shotAge < .25f ? Mathf.Exp(-shotAge * 19) * (1 - Mathf.Exp(-shotAge * 180)) * .065f : 0f;
            float reload = reloadCycle && shotAge > .50f && shotAge < 1.45f ? Mathf.Sin((shotAge - .50f) / .95f * Mathf.PI) : 0;
            float breathe = Mathf.Sin(Time.time * 1.8f + phase) * .003f * (1 - stride);
            float bob = -Mathf.Abs(step) * .018f + Mathf.Sin(phase * 2) * .006f * stride + breathe;
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
                float cycle01 = math.frac(cycle / (math.PI * 2));
                bool planted = cycle01 < .54f;
                float swing = planted ? 0 : Mathf.Clamp01((cycle01 - .54f) / .46f);
                float advance = planted ? Mathf.Lerp(.22f, -.22f, cycle01 / .54f) : Mathf.Lerp(-.22f, .22f, Mathf.SmoothStep(0, 1, swing));
                float lift = planted ? 0 : Mathf.Sin(swing * math.PI) * .115f;
                var ankle = MapSpace.W(foot) + math.rotate(turn, new float3(side * .072f, .029f + lift * stride, advance * stride) * scale);
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
            bool tracked = kind == Kind.Tank || kind == Kind.AutoTank || kind == Kind.SpGun;
            // Weight: the hull rides a spring-damper suspension instead of snapping to the ground. Heavy tracked
            // hulls are stiff and slow to settle; wheeled vehicles are softer and bounce. Acceleration squats the
            // tail, braking dips the nose, turning leans the body outward, and the main gun rocks the hull back.
            float dt = frameDt;
            if (dt > 0f)
            {
                float accel = (speed[slot] - lastSpeed[slot]) / dt;
                lastSpeed[slot] = speed[slot];
                float targetPitch = pitch - Mathf.Clamp(accel * (tracked ? .010f : .016f), -.06f, .06f);
                float targetRoll = roll + Mathf.Clamp(turnRate[slot] * speed[slot] * (tracked ? .05f : .09f), -.07f, .07f);
                if (!moving) targetPitch += Mathf.Sin(Time.time * 31f + slot) * .0015f;   // idling engine shudder
                float stiffness = tracked ? 55f : 75f, damping = tracked ? 11f : 7.5f;
                if (shotAge >= 0f && shotAge < .1f && Time.time - kickedAt[slot] > .4f && kind != Kind.Buggy && kind != Kind.Truck)
                {
                    kickedAt[slot] = Time.time;
                    // recoil: the hull pitches away from the gun's line of fire
                    float rel = Mathf.DeltaAngle(facing * Mathf.Rad2Deg, turret[slot] * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                    float power = kind == Kind.SpGun ? 1.6f : tracked ? 1.1f : .45f;
                    pitchRate[slot] -= Mathf.Cos(rel) * power;
                    rollRate[slot] -= Mathf.Sin(rel) * power;
                }
                pitchRate[slot] += (stiffness * (targetPitch - suspensionPitch[slot]) - damping * pitchRate[slot]) * dt;
                rollRate[slot] += (stiffness * (targetRoll - suspensionRoll[slot]) - damping * rollRate[slot]) * dt;
                suspensionPitch[slot] = Mathf.Clamp(suspensionPitch[slot] + pitchRate[slot] * dt, -.32f, .32f);
                suspensionRoll[slot] = Mathf.Clamp(suspensionRoll[slot] + rollRate[slot] * dt, -.3f, .3f);
            }
            var rot = quaternion.EulerZXY(suspensionPitch[slot], MapSpace.Yaw(facing), suspensionRoll[slot]);
            var at = MapSpace.W(p);
            Detail model = kind switch
            {
                Kind.Tank => Detail.Tank, Kind.AutoTank => Detail.Autonomous, Kind.SpGun => Detail.Howitzer,
                Kind.Apc => Detail.Carrier, Kind.ArmoredCar => Detail.ArmoredCar, Kind.Buggy => Detail.Scout, Kind.Truck => Detail.Truck,
                Kind.Launcher => Detail.RocketTruck, Kind.AirDefense => Detail.AirDefense, _ => Detail.FieldGun
            };
            if (kind == Kind.AutoTank) scale *= 1.12f;
            if (kind == Kind.Buggy || kind == Kind.FieldGun) scale *= .84f;
            var paint = new float4(body.xyz * 1.28f + .09f, 0);
            // True proportions: the tracked hull models are drawn 64% as wide and 12% longer than built, so a
            // main battle tank is ~4 m wide, ~7.7 m long and ~2.4 m tall beside 1.75 m soldiers.
            float3 prop = tracked ? new float3(.64f, 1f, 1.12f) : new float3(1f);
            details[(int)model].Add(InstanceData.TRS(at, rot, prop * scale, paint));
            if (kind == Kind.FieldGun) return;
            if (tracked)
            {
                for (int side = -1; side <= 1; side += 2) for (int link = 0; link < 26; link++)
                {
                    float travel = treadTravel[slot] / math.max(.01f, scale);
                    TrackPoint(link / 26f + travel / (1.48f + math.PI * .218f), out float ty, out float tz, out float tangentAngle);
                    var center = at + math.rotate(rot, new float3(side * .434f, ty, tz) * prop * scale);
                    var tangent = math.mul(rot, quaternion.RotateX(tangentAngle));
                    batches[(int)Model.Plate].Add(InstanceData.TRS(center, tangent, new float3(.143f * prop.x, .018f, .078f * prop.z) * scale, new float4(.25f, .26f, .23f, 0)));
                }
                if ((equipment & 2) != 0) for (int side = -1; side <= 1; side += 2) for (int tile = 0; tile < 4; tile++)
                {
                    var center = at + math.rotate(rot, new float3(side * .367f, .25f, -.31f + tile * .20f) * prop * scale);
                    batches[(int)Model.Plate].Add(InstanceData.TRS(center, rot, new float3(.052f, .113f, .16f) * scale, new float4(body.xyz * .82f, 0)));
                }
            }
            int axles = tracked ? 5 : kind == Kind.Apc ? 4 : kind == Kind.Truck || kind == Kind.Launcher || kind == Kind.AirDefense ? 3 : 2;
            float axleWidth = tracked ? .432f : kind == Kind.Buggy ? .239f : kind == Kind.Apc ? .30f : .277f;
            for (int side = -1; side <= 1; side += 2)
                for (int a = 0; a < axles; a++)
                {
                    float z = Mathf.Lerp(-.38f, .36f, (float)a / (axles - 1));
                    float sx = p.x + (side * axleWidth * prop.x * cs + z * prop.z * sn) * scale;
                    float sz = p.z + (-side * axleWidth * prop.x * sn + z * prop.z * cs) * scale;
                    float response = Mathf.Clamp((view.GroundHeight(sx, sz) - p.y) / scale, -.027f, .027f);
                    float y = (tracked ? .106f : .104f) + response;
                    var pivot = at + math.rotate(rot, new float3(side * axleWidth, y, z) * prop * scale);
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
                details[(int)(kind == Kind.AutoTank ? Detail.RemoteTurret : kind == Kind.SpGun ? Detail.HowitzerTurret : Detail.Turret)].Add(InstanceData.TRS(ring, swivel, new float3(tracked ? .8f : 1f, 1f, 1f) * (scale * k), paint));
                // barrel recoil: a sharp run-back, then a slower return to battery
                float recoil = shotAge >= 0f && shotAge < .6f ? Mathf.Exp(-shotAge * 7f) * (1 - Mathf.Exp(-shotAge * 120f)) * .16f : 0f;
                var pivot = ring + math.rotate(swivel, new float3(0, y, .17f - recoil) * (scale * k));
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
                // the loader works the breech; the layer and the third man kneel by the trail
                AddFigure(Detail.MortarCrew, new float3(fx, view.GroundHeight(fx, fz), fz), facing + (f - 1) * .5f,
                    .062f, body, 0, .7f, time * .8f + id + f, 10, 0, view, false, false, id * 31 + f * 7, f == 0 ? PoseDeploy : PoseKneel);
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
            // however fast the server now moves this aircraft, chase it at least that fast (no lagging or snapping)
            if (airLive[s] && dt > 0f)
            {
                float mdx = grid.DxWrap(srvX[s], sx), mdz = sz - srvZ[s];
                float measured = Mathf.Sqrt(mdx * mdx + mdz * mdz) / dt;
                if (measured < 30f) srvSpeed[s] = Mathf.Lerp(srvSpeed[s], measured, 1f - Mathf.Exp(-dt * 2f));
            }
            srvX[s] = sx; srvZ[s] = sz;
            float server = srvSpeed[s];
            top = Mathf.Max(top, server * 1.35f);
            if (kind == Kind.Fighter || kind == Kind.Bomber) cruise = Mathf.Max(cruise, server * .85f);
            lead = Mathf.Max(lead, server * .35f);
            turn *= Mathf.Max(1f, Mathf.Sqrt(server / Mathf.Max(.1f, cruise)));
            if (!airLive[s] || Mathf.Abs(grid.DxWrap(airX[s], sx)) + Mathf.Abs(sz - airZ[s]) > Mathf.Max(8f, server * 3f))
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

        /// <summary>
        /// Aircraft with continuous server motion. Snapshot interpolation is piecewise linear, so a fast jet showed
        /// kinks at every snapshot and froze then jumped whenever playback reached the newest one. Instead the
        /// drawn aircraft dead-reckons along the server velocity and bleeds off its error toward the interpolated
        /// track; heading follows the smoothed velocity at a turn-rate limit, and the bank is the coordinated-turn
        /// angle for that speed and turn rate. Altitude is eased the same way.
        /// </summary>
        void FlySnapshot(int s, Kind kind, in SE.Core.Protocol.WorldMotion m, UnitStore store, HexGrid grid, bool fresh, float dt)
        {
            float tx = px[s], tz = pz[s];
            float vx = m.Vx, vz = m.Vz;
            if (!fresh && airLive[s] && dt > 0f)
            {
                // the interpolated track's own velocity, for when the server sends none
                float mdx = grid.DxWrap(srvX[s], tx), mdz = tz - srvZ[s];
                float measured = Mathf.Sqrt(mdx * mdx + mdz * mdz) / dt;
                if (measured < 30f) srvSpeed[s] = Mathf.Lerp(srvSpeed[s], measured, 1f - Mathf.Exp(-dt * 3f));
                if (vx * vx + vz * vz < 1e-6f && measured > 1e-4f && measured < 30f)
                { float k = srvSpeed[s] / measured; vx = mdx / dt * k; vz = mdz / dt * k; }
            }
            srvX[s] = tx; srvZ[s] = tz;
            float v = Mathf.Sqrt(vx * vx + vz * vz);
            if (fresh || !airLive[s])
            {
                airLive[s] = true;
                airX[s] = tx; airZ[s] = tz; airH[s] = store.Facing(s); airBank[s] = 0; airAlt[s] = m.Altitude;
                px[s] = airX[s]; pz[s] = airZ[s];
                return;
            }
            if (dt <= 0f) { px[s] = airX[s]; pz[s] = airZ[s]; return; }
            float px1 = airX[s] + vx * dt, pz1 = airZ[s] + vz * dt;
            float ex = grid.DxWrap(px1, tx), ez = tz - pz1;
            if (ex * ex + ez * ez > Mathf.Max(1.5f, v * 1.2f) * Mathf.Max(1.5f, v * 1.2f)) { airX[s] = tx; airZ[s] = tz; }   // teleported (respawn, long gap)
            else
            {
                float pull = 1f - Mathf.Exp(-dt * 4.5f);
                airX[s] = px1 + ex * pull; airZ[s] = pz1 + ez * pull;
            }
            airAlt[s] = Mathf.Lerp(airAlt[s], m.Altitude, 1f - Mathf.Exp(-dt * 3f));
            float limit, bankMax;
            switch (kind)
            {
                case Kind.Fighter: limit = 3.2f; bankMax = 1.15f; break;
                case Kind.Bomber: limit = 1.6f; bankMax = .6f; break;
                case Kind.Heli: limit = 3.5f; bankMax = .32f; break;
                default: limit = 4f; bankMax = .55f; break;
            }
            float want = v > .05f ? Mathf.Atan2(vx, vz) : store.Facing(s);
            float before = airH[s];
            airH[s] = Approach(airH[s], want, dt * limit);
            float rate = Mathf.DeltaAngle(before * Mathf.Rad2Deg, airH[s] * Mathf.Rad2Deg) * Mathf.Deg2Rad / dt;
            float bankWant = Mathf.Clamp(Mathf.Atan(rate * Mathf.Max(.3f, v) * .6f), -bankMax, bankMax);
            airBank[s] = Mathf.Lerp(airBank[s], bankWant, 1f - Mathf.Exp(-dt * 5f));
            speed[s] = Mathf.Lerp(speed[s], v, 1f - Mathf.Exp(-dt * 6f));
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
            foreach (var b in soldiers) b?.Draw();
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
            foreach (var b in soldiers) b?.Dispose();
            foreach (var r in rigs) r?.Dispose();
        }
    }
}
