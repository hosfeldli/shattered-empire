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
    public sealed class UnitRenderer : IDisposable
    {
        enum Model { Soldier, Hull, Turret, Apc, Truck, Car, Buggy, Gun, Launcher, Exo, Fighter, Bomber, Heli, Rotor, Drone, Marker, Ring, Count }

        enum Kind { Infantry, Exo, Tank, AutoTank, Apc, ArmoredCar, Buggy, Truck, FieldGun, SpGun, Launcher, AirDefense, Heli, Fighter, Bomber, Drone, Swarm, Mortar }

        readonly InstanceBatch[] batches = new InstanceBatch[(int)Model.Count];
        Kind[] kindOf = new Kind[0];
        float[] yaw = new float[0], turret = new float[0], px = new float[0], pz = new float[0], seen = new float[0];
        int[] ids = new int[0];
        readonly Dictionary<int, (int target, float time)> lastShot = new Dictionary<int, (int, float)>();
        public readonly HashSet<int> Selected = new HashSet<int>();
        public int Drawn { get; private set; }
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
                MeshKit.Rocket, MeshKit.Mech, MeshKit.Fighter, MeshKit.Bomber, MeshKit.HeliBody, MeshKit.Rotor, MeshKit.Drone, MeshKit.Marker, MeshKit.Ring,
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
                case "supply_truck": return Kind.Truck;
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

        /// <summary>A shot seen in the combat stream: the shooter keeps facing its target for a while.</summary>
        public void NoteShot(int shooter, int target, float time)
        {
            if (shooter > 0 && target > 0) lastShot[shooter] = (target, time);
        }

        void Ensure(int n)
        {
            if (yaw.Length >= n) return;
            int s = Math.Max(n, yaw.Length * 2);
            Array.Resize(ref yaw, s); Array.Resize(ref turret, s); Array.Resize(ref px, s); Array.Resize(ref pz, s);
            Array.Resize(ref seen, s); Array.Resize(ref kindOf, s);
            int old = ids.Length;
            Array.Resize(ref ids, s);
            for (int i = old; i < s; i++) ids[i] = -1;
        }

        static float Approach(float a, float b, float rate)
        {
            float d = Mathf.DeltaAngle(a * Mathf.Rad2Deg, b * Mathf.Rad2Deg) * Mathf.Deg2Rad;
            return a + Mathf.Clamp(d, -rate, rate);
        }

        public unsafe void Update(UnitStore store, WorldModel world, Func<int, float4> civColor, float camX, float camDist, float time, float dt)
        {
            long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Clear();
            if (!world.Ready) return;
            var grid = world.Grid;
            var view = world.View;
            Ensure(store.SlotCount);
            int level = camDist > StrategicDistance ? 0 : camDist > OperationalDistance ? 1 : 2;
            float vehicleScale = level == 2 ? 0.17f : 0.26f;
            float markerScale = Mathf.Clamp(camDist * 0.0065f, 0.3f, 2.4f);
            int drawn = 0;
            // pass 1: positions (base image) for every live slot, so turrets can aim at other units
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse) continue;
                if (ids[s] != u.Id)
                {
                    ids[s] = u.Id;
                    kindOf[s] = Classify(store.Types.Name(u.TypeIndex));
                    store.Heading(s, out float hx0, out float hz0);
                    yaw[s] = turret[s] = hx0 != 0 || hz0 != 0 ? Mathf.Atan2(hx0, hz0) : (u.Id * 0.618f) % 6.283f;
                }
                store.Position(s, out px[s], out pz[s]);
            }
            long t1 = System.Diagnostics.Stopwatch.GetTimestamp();
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse) continue;
                var kind = kindOf[s];
                float x = grid.NearX(px[s], camX), z = pz[s];
                float ground = view.GroundHeight(x, z);
                int tile = u.Tile;
                // vehicles and troops cross bridges on the deck, not the river bed
                if (tile >= 0 && tile < grid.N && world.Road[tile] != 0 && (world.IsRiver(tile) || view.Water[tile] > -1e8f))
                    ground = Mathf.Max(ground, Mathf.Max(view.Water[tile], world.Height[tile]) + 0.06f);
                else if (tile >= 0 && tile < grid.N && view.Water[tile] > ground) ground = view.Water[tile];   // embarked
                // facing: along the path when moving; toward the last target when engaging
                store.Heading(s, out float hx, out float hz);
                bool moving = hx != 0 || hz != 0;
                float wantHull = moving ? Mathf.Atan2(hx, hz) : yaw[s];
                float wantTurret = wantHull;
                int target = u.Target;
                if (lastShot.TryGetValue(u.Id, out var shot) && time - shot.time < 6f) target = shot.target;
                if (target > 0 && store.SlotOf.TryGetValue(target, out int ts))
                {
                    float tx = grid.DxWrap(px[s], px[ts]), tz = pz[ts] - pz[s];
                    if (tx * tx + tz * tz > 1e-6f)
                    {
                        wantTurret = Mathf.Atan2(tx, tz);
                        if (!moving && !HasTurret(kind)) wantHull = wantTurret;   // guns, infantry and cars turn bodily
                    }
                }
                yaw[s] = Approach(yaw[s], wantHull, dt * 2.2f);
                turret[s] = Approach(turret[s], wantTurret, dt * 3.5f);
                float4 team = civColor(u.Owner);
                float hp = Mathf.Clamp01(u.Hp / 100f);
                float4 body = new float4(math.lerp(new float3(0.36f, 0.38f, 0.3f), team.xyz, 0.5f) * (0.55f + 0.45f * hp), 0);
                var p = new float3(x, ground, z);
                drawn++;
                if (Selected.Contains(u.Id))
                    batches[(int)Model.Ring].Add(T(new float3(x, ground + 0.015f, z), 0, new float3(level == 0 ? markerScale * 1.4f : 0.42f), new float4(0.3f, 1f, 0.45f, 0.8f)));
                if (level == 0)
                {
                    // strategic: one readable marker per unit, air units above the ground
                    float alt = IsAir(kind) ? 1.2f : 0.05f;
                    var mc = new float4(team.xyz, IsAir(kind) ? 0.35f : 0.15f);
                    batches[(int)Model.Marker].Add(T(p + new float3(0, alt, 0), yaw[s], new float3(markerScale, markerScale * (kind == Kind.Infantry ? 0.6f : 1f), markerScale), mc));
                    continue;
                }
                float sc = vehicleScale;
                switch (kind)
                {
                    case Kind.Infantry:
                    case Kind.Mortar:
                    case Kind.Exo:
                        AddSquad(s, u.Id, kind, p, yaw[s], level, moving, time, body, ground, view, x, z);
                        break;
                    case Kind.Tank:
                    case Kind.AutoTank:
                    case Kind.SpGun:
                    {
                        float k = kind == Kind.AutoTank ? 1.18f : 1f;
                        var tint = kind == Kind.AutoTank ? new float4(body.xyz * 0.7f + new float3(0.05f, 0.06f, 0.08f), 0.05f) : body;
                        batches[(int)Model.Hull].Add(T(p, yaw[s], new float3(sc * k), tint));
                        batches[(int)Model.Turret].Add(T(p, turret[s], new float3(sc * k, sc * k, sc * k * (kind == Kind.SpGun ? 1.5f : 1f)), tint));
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
                        AddAircraft(kind, u.Id, p, level, time, body, camX, grid);
                        break;
                }
            }
            long t2 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Upload();
            long t3 = System.Diagnostics.Stopwatch.GetTimestamp();
            double f = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            PositionsMs = (t1 - t0) * f; BuildMs = (t2 - t1) * f; UploadMs = (t3 - t2) * f;
            Drawn = drawn;
            int inst = 0;
            foreach (var b in batches) inst += b.Count;
            Instances = inst;
            // forget shots nobody remembers any more
            if (lastShot.Count > 4096) lastShot.Clear();
        }

        static readonly float2[] SquadSlots =
        {
            new float2(0, 0), new float2(-0.11f, -0.09f), new float2(0.11f, -0.09f), new float2(-0.22f, -0.18f), new float2(0.22f, -0.18f),
            new float2(0, -0.2f), new float2(-0.06f, -0.3f), new float2(0.06f, -0.3f),
        };

        unsafe void AddSquad(int slot, int id, Kind kind, float3 p, float facing, int level, bool moving, float time, float4 body, float ground, SE.Core.World.TerrainView view, float x, float z)
        {
            int figures = kind == Kind.Exo ? (level == 2 ? 3 : 2) : level == 2 ? 6 : 3;
            float scale = kind == Kind.Exo ? (level == 2 ? 0.075f : 0.11f) : level == 2 ? 0.055f : 0.085f;
            float spread = level == 2 ? 1f : 1.3f;
            math.sincos(facing, out float sn, out float cs);
            var model = kind == Kind.Exo ? Model.Exo : Model.Soldier;
            for (int f = 0; f < figures; f++)
            {
                float2 o = SquadSlots[f] * spread;
                // jitter so squads never look stamped
                float j = (id * 7 + f * 13) % 17 / 17f - 0.5f;
                o += new float2(j * 0.04f, -j * 0.03f);
                float ox = o.x * cs + o.y * sn, oz = -o.x * sn + o.y * cs;
                float fx = x + ox, fz = z + oz;
                float fy = level == 2 ? view.GroundHeight(fx, fz) : ground;
                float bob = moving ? Mathf.Abs(Mathf.Sin(time * 9f + f * 1.7f + id)) * scale * 0.12f : 0f;
                batches[(int)model].Add(T(new float3(fx, Mathf.Max(fy, ground - 0.05f) + bob, fz), facing + j * 0.3f, new float3(scale), body));
            }
            if (kind == Kind.Mortar && level == 2)
                batches[(int)Model.Gun].Add(T(p + new float3(0, 0, 0), facing, new float3(0.06f), body));
        }

        unsafe void AddCrew(int id, float3 p, float facing, int n, float4 body, float time, SE.Core.World.TerrainView view, float x, float z)
        {
            math.sincos(facing, out float sn, out float cs);
            for (int f = 0; f < n; f++)
            {
                float ox = (f - 1) * 0.06f, oz = -0.09f;
                float fx = x + ox * cs + oz * sn, fz = z - ox * sn + oz * cs;
                batches[(int)Model.Soldier].Add(T(new float3(fx, view.GroundHeight(fx, fz), fz), facing, new float3(0.05f), body));
            }
        }

        void AddAircraft(Kind kind, int id, float3 p, int level, float time, float4 body, float camX, HexGrid grid)
        {
            // patrol orbits around the server position: helicopters circle the area they cover, jets
            // fly wide loops and bank through turns; nothing hovers in place
            float phase = (id * 0.6180339f) % 1f * 6.283f;
            float radius, speed, alt;
            switch (kind)
            {
                case Kind.Heli: radius = 0.55f; speed = 0.55f; alt = 0.75f; break;
                case Kind.Fighter: radius = 1.5f; speed = 1.4f; alt = 2.0f; break;
                case Kind.Bomber: radius = 2.0f; speed = 0.7f; alt = 2.6f; break;
                case Kind.Swarm: radius = 0.35f; speed = 1.6f; alt = 1.0f; break;
                default: radius = 0.45f; speed = 0.9f; alt = 1.2f; break;
            }
            float a = phase + time * speed;
            // fighters fly a figure-eight; others a slightly eccentric circle
            float ox = kind == Kind.Fighter ? Mathf.Sin(a) * radius : Mathf.Cos(a) * radius;
            float oz = kind == Kind.Fighter ? Mathf.Sin(a) * Mathf.Cos(a) * radius : Mathf.Sin(a) * radius * 0.85f;
            float vx = kind == Kind.Fighter ? Mathf.Cos(a) : -Mathf.Sin(a);
            float vz = kind == Kind.Fighter ? Mathf.Cos(2 * a) : Mathf.Cos(a) * 0.85f;
            float heading = Mathf.Atan2(vx, vz);
            float bank = kind == Kind.Heli ? -0.15f : kind == Kind.Fighter ? -Mathf.Sin(a) * 0.9f : -0.35f;
            var pos = p + new float3(ox, alt + Mathf.Sin(time * 0.7f + phase) * 0.05f, oz);
            var rot = quaternion.EulerZXY(0, MapSpace.Yaw(heading), -bank);   // map heading into Unity space; mirroring flips the roll
            float s = level == 2 ? 1f : 1.5f;
            switch (kind)
            {
                case Kind.Heli:
                    batches[(int)Model.Heli].Add(Q(pos, rot, new float3(0.28f * s), body));
                    batches[(int)Model.Rotor].Add(Q(pos + new float3(0, 0.085f * s, 0), quaternion.EulerZXY(0, time * 40f + phase, 0), new float3(0.62f * s, 0.28f * s, 0.62f * s), new float4(0.2f, 0.2f, 0.2f, 0)));
                    break;
                case Kind.Fighter:
                    batches[(int)Model.Fighter].Add(Q(pos, rot, new float3(0.3f * s), body));
                    break;
                case Kind.Bomber:
                    batches[(int)Model.Bomber].Add(Q(pos, rot, new float3(0.42f * s), body));
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
                    batches[(int)Model.Drone].Add(Q(pos, rot, new float3(0.12f * s), body));
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
        }

        /// <summary>Current drawn position of a unit (camera image), for selection and effects.</summary>
        public bool TryGetPosition(UnitStore store, int id, out Vector2 xz)
        {
            xz = default;
            if (!store.SlotOf.TryGetValue(id, out int s) || s >= px.Length || ids[s] != id) return false;
            xz = new Vector2(px[s], pz[s]);
            return true;
        }

        public void Dispose() { foreach (var b in batches) b.Dispose(); }
    }
}
