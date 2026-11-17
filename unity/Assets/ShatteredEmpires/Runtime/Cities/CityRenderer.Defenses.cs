using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Field defenses built in Blender (tools/blender/build_defenses.py): one static body per emplacement
    /// (Def_*.bytes, laid out by Models/DefenseLayout.txt) and, for gun positions, a separate turret head
    /// (Def_*_head*.bytes) that is drawn every frame so it can track what it shoots at.
    ///
    /// - Readable at strategic zoom: bodies are larger than the old recipes, heads take a team-tinted paint.
    /// - AA reads as AA: elevated twin (level 1) or quad (level 2+) barrels, a fire-control radar at level 3;
    ///   it scans the sky when idle and slews toward each target it fires at (<see cref="NoteShot"/>).
    /// - Upgrade levels are visible: team rank bars on the front plate (one per level), a ring of blast
    ///   blocks from level 2 that becomes a banded wall at level 3, and heavier heads (twin guns, shields).
    /// Types without a model keep their module recipe.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        enum TurretKind { AntiTank, AntiAir, MachineGun, Fortress, Artillery }

        sealed class DefenseKind
        {
            public Part Body;
            public string Layout, Head;
            public TurretKind Kind;
            public bool Levelled;          // heads come in three upgrade levels (Def_*_head1..3)
            public float Ring;             // radius of the level 2/3 blast-block ring (0: none)
        }

        static readonly Dictionary<string, DefenseKind> DefenseKinds = new Dictionary<string, DefenseKind>
        {
            ["barricade"] = new DefenseKind { Body = Part.DefBarricade, Layout = "barricade" },
            ["sandbags"] = new DefenseKind { Body = Part.DefBarricade, Layout = "barricade" },
            ["guard_post"] = new DefenseKind { Body = Part.DefGuardPost, Layout = "guard_post", Ring = .25f },
            ["watchtower"] = new DefenseKind { Body = Part.DefGuardPost, Layout = "guard_post", Ring = .25f },
            ["bunker"] = new DefenseKind { Body = Part.DefBunker, Layout = "bunker", Ring = .43f },
            ["turret"] = new DefenseKind { Body = Part.DefAtBase, Layout = "turret", Head = "Def_at_head", Kind = TurretKind.AntiTank, Levelled = true, Ring = .38f },
            ["at_emplacement"] = new DefenseKind { Body = Part.DefAtBase, Layout = "turret", Head = "Def_at_head", Kind = TurretKind.AntiTank, Levelled = true, Ring = .38f },
            ["aa_battery"] = new DefenseKind { Body = Part.DefAaBase, Layout = "aa_battery", Head = "Def_aa_head", Kind = TurretKind.AntiAir, Levelled = true, Ring = .37f },
            ["city_turret"] = new DefenseKind { Body = Part.DefMgBase, Layout = "city_turret", Head = "Def_mg_head", Kind = TurretKind.MachineGun, Levelled = true, Ring = .23f },
            ["fort"] = new DefenseKind { Body = Part.DefFort, Layout = "fort", Head = "Def_fort_head", Kind = TurretKind.Fortress },
            ["outpost"] = new DefenseKind { Body = Part.DefFort, Layout = "fort", Head = "Def_fort_head", Kind = TurretKind.Fortress },
            ["sensor_post"] = new DefenseKind { Body = Part.DefSensor, Layout = "sensor_post", Ring = .27f },
            ["artillery_post"] = new DefenseKind { Body = Part.DefArtilleryBase, Layout = "artillery_post", Head = "Def_artillery_head", Kind = TurretKind.Artillery, Ring = .47f },
            ["repair_point"] = new DefenseKind { Body = Part.DefRepair, Layout = "repair_point" },
        };

        sealed class TurretMount
        {
            public float3 Pivot, Color;
            public float Rest, Aim, ShotAt = -100f;
            public float2 Target;
            public string Head;
            public TurretKind Kind;
            public int Level;
            public bool Memory;
        }

        readonly Dictionary<int, TurretMount> mounts = new Dictionary<int, TurretMount>();
        readonly Dictionary<string, InstanceBatch> headBatches = new Dictionary<string, InstanceBatch>();
        readonly List<int> staleMounts = new List<int>();
        float turretClock = float.NaN;

        /// <summary>A defense's ground datum: low enough that its plinth meets the slope, not the corner peaks.</summary>
        float DefenseDatum(float x, float z, float radius)
        {
            float sum = Ground(x, z), low = sum;
            for (int k = 0; k < 4; k++)
            {
                math.sincos(k * math.PI * .5f + .4f, out float s, out float co);
                float h = Ground(x + s * radius, z + co * radius);
                sum += h; low = Mathf.Min(low, h);
            }
            return Mathf.Max(low, sum / 5f - .012f) - .006f;
        }

        /// <summary>Draw an authored field defense; false keeps the module recipe.</summary>
        /// <summary>
        /// A field defense under construction: its own body rising with progress in raw concrete and timber, on its
        /// own small footprint (Review V: the generic construction site drew a house-sized plot and a gable house).
        /// </summary>
        bool DefenseSite(in BuildingRecord b, float cx, float cz, float yaw)
        {
            if (!b.HasPosition || !DefenseKinds.TryGetValue(b.Type, out var kind) || AuthoredMesh(kind.Body, null) == null) return false;
            float prog = Mathf.Clamp01(b.Progress / 100f);
            float ground = DefenseDatum(cx, cz, kind.Ring > 0 ? kind.Ring * .55f : .2f);
            float memory = b.Memory ? .6f : 1f;
            Put(kind.Body, new float3(cx, ground, cz), yaw, new float3(1, math.max(.2f, prog), 1), new float3(.86f, .84f, .80f) * memory);
            // scaffold posts and a timber stack round the work, the team's survey tape on the posts
            float r = kind.Ring > 0 ? kind.Ring * .62f : .2f;
            var timber = new float3(.55f, .44f, .30f) * memory;
            var team = CivColor(b.Owner).xyz * memory;
            for (int k = 0; k < 4; k++)
            {
                float a = yaw + k * math.PI * .5f + math.PI * .25f;
                var p = new float3(cx + math.sin(a) * r, ground, cz + math.cos(a) * r);
                Put(Part.Box, p, yaw, new float3(.012f, .09f, .012f), timber);
                Put(Part.Box, p + new float3(0, .07f, 0), yaw, new float3(.018f, .012f, .018f), team, .4f);
            }
            Put(Part.Box, new float3(cx + math.sin(yaw + 2.4f) * r * .8f, ground, cz + math.cos(yaw + 2.4f) * r * .8f), yaw + .6f, new float3(.07f, .025f, .04f), timber);
            return true;
        }

        bool AuthoredDefense(in Ctx original, in BuildingRecord b)
        {
            if (!DefenseKinds.TryGetValue(b.Type, out var kind) || AuthoredMesh(kind.Body, null) == null) return false;
            Layouts().TryGetValue(kind.Layout, out var layout);
            var c = original;
            c.FixedGround = true;
            c.GroundY = DefenseDatum(c.X, c.Z, kind.Ring > 0 ? kind.Ring * .55f : .2f);
            int level = Mathf.Clamp(b.Level, 1, 3);
            Put(kind.Body, new float3(c.X, c.GroundY, c.Z), c.Yaw, new float3(1), c.Tint);
            math.sincos(c.Yaw, out float sn, out float cs);
            float3 Map(float3 at) => new float3(c.X + at.x * cs + at.z * sn, c.GroundY + at.y, c.Z - at.x * sn + at.z * cs);
            var team = c.Civ * c.Tint;
            if (layout != null)
            {
                foreach (var (at, size) in layout.Marks)
                    Put(Part.Box, Map(at) - new float3(0, size.y * .5f, 0), c.Yaw, size, team, .3f);
                foreach (var f in layout.Flags) Flag(c, f.x, f.y, f.z);
                // rank bars on the front plate: one per upgrade level
                foreach (var plate in layout.Plates)
                    for (int k = 0; k < level; k++)
                    {
                        var at = plate + new float3((k - (level - 1) * .5f) * .024f, -.016f, .006f);
                        Put(Part.Box, Map(at), c.Yaw, new float3(.014f, .032f, .006f), team, .55f);
                    }
                if (recording != null) foreach (var w in layout.Walls) if (!recording.Contains(w)) recording.Add(w);
            }
            if (kind.Ring > 0 && level >= 2) BlastRing(c, kind.Ring, level, team);
            // the tracking head (drawn per frame by AnimateTurrets)
            if (kind.Head != null && b.Id >= 0)
            {
                float3 pivot = new float3(0, .03f, 0);
                if (layout != null && layout.Mounts.Count > 0) pivot = layout.Mounts[0];
                string head = kind.Levelled ? kind.Head + level : kind.Head;
                if (ModelLibrary.Get(head) == null && kind.Levelled) head = kind.Head + 1;
                if (!mounts.TryGetValue(b.Id, out var mount)) mounts[b.Id] = mount = new TurretMount { Aim = c.Yaw };
                mount.Pivot = Map(pivot); mount.Rest = c.Yaw; mount.Head = head; mount.Kind = kind.Kind; mount.Level = level;
                mount.Memory = b.Memory;
                mount.Color = math.lerp(new float3(.86f, .87f, .82f), c.Civ, .55f) * c.Tint;
            }
            return true;
        }

        /// <summary>Level 2: a ring of blast blocks with a gap at the back. Level 3: taller blocks with a team band.</summary>
        void BlastRing(in Ctx c, float radius, int level, float3 team)
        {
            const int Count = 14;
            var stone = new float3(.63f, .62f, .57f) * c.Tint;
            float height = level >= 3 ? .085f : .05f;
            for (int k = 0; k < Count; k++)
            {
                if (k == Count / 2 || k == Count / 2 - 1) continue;   // the rear gap (behind the front at angle 0)
                float a = c.Yaw + (k + .5f) * 2 * math.PI / Count;
                math.sincos(a, out float s, out float co);
                float x = c.X + s * radius, z = c.Z + co * radius;
                float y = Ground(x, z) - .012f;
                float chord = 2 * math.PI * radius / Count * .78f;
                Put(Part.Concrete, new float3(x, y, z), a, new float3(chord, height, .045f), stone);
                if (level >= 3) Put(Part.Box, new float3(x, y + height, z), a, new float3(chord * .9f, .009f, .047f), team, .35f);
            }
        }

        /// <summary>The bootstrap reports every building shot so the turret head can slew onto its target.</summary>
        public void NoteShot(int shooter, float3 target, float time)
        {
            if (!mounts.TryGetValue(shooter, out var m)) return;
            m.Target = target.xz; m.ShotAt = time;
        }

        /// <summary>Where a defense's barrel ends when it fires at target (map space, x near the target).</summary>
        public bool TryMuzzle(int shooter, float3 target, out float3 muzzle)
        {
            muzzle = default;
            if (!mounts.TryGetValue(shooter, out var m)) return false;
            // an AA mount (a battery, or the city AA on an HQ that also fires its own ground weapon) only takes air targets
            if (m.Kind == TurretKind.AntiAir && target.y < m.Pivot.y + .2f) return false;
            float dx = world.Grid.DxWrap(m.Pivot.x, target.x), dz = target.z - m.Pivot.z;
            float yaw = dx * dx + dz * dz > 1e-6f ? math.atan2(dx, dz) : m.Aim;
            float forward, up;
            switch (m.Kind)
            {
                case TurretKind.AntiAir: forward = .19f; up = .30f; break;
                case TurretKind.MachineGun: forward = .2f; up = .045f; break;
                case TurretKind.Fortress: forward = .42f; up = .055f; break;
                case TurretKind.Artillery: forward = .46f; up = .23f; break;
                default: forward = m.Level >= 2 ? .39f : .35f; up = .07f; break;
            }
            math.sincos(yaw, out float s, out float co);
            muzzle = m.Pivot + new float3(s * forward, up, co * forward);
            muzzle.x = world.Grid.NearX(muzzle.x, target.x);
            return true;
        }

        InstanceBatch HeadBatch(string name)
        {
            if (headBatches.TryGetValue(name, out var batch)) return batch;
            var mesh = ModelLibrary.Get(name);
            batch = mesh == null ? null : new InstanceBatch(mesh, RenderResources.Instanced, 32) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
            headBatches[name] = batch;
            return batch;
        }

        /// <summary>
        /// Every turret head, every frame, at every zoom (a head never pops out): idle heads sweep their arc
        /// (AA scans the sky), a head that fired in the last few seconds slews onto its target at its traverse rate.
        /// </summary>
        void AnimateTurrets(float time)
        {
            float dt = float.IsNaN(turretClock) ? 0 : math.clamp(time - turretClock, 0, .25f);
            turretClock = time;
            foreach (var batch in headBatches.Values) batch?.Clear();
            staleMounts.Clear();
            foreach (var pair in mounts)
            {
                if (!structures.Buildings.TryGetValue(pair.Key, out var b) || !b.Done || !b.HasPosition) { staleMounts.Add(pair.Key); continue; }
                var m = pair.Value;
                var batch = HeadBatch(m.Head);
                if (batch == null) continue;
                float want, slew;
                switch (m.Kind)
                {
                    case TurretKind.AntiAir: slew = 2.6f; break;
                    case TurretKind.MachineGun: slew = 3.2f; break;
                    case TurretKind.Artillery: slew = .7f; break;
                    default: slew = 1.3f; break;
                }
                if (m.Memory) want = m.Rest;
                else if (time - m.ShotAt < 5f)
                    want = math.atan2(world.Grid.DxWrap(m.Pivot.x, m.Target.x), m.Target.y - m.Pivot.z);
                else if (m.Kind == TurretKind.AntiAir) want = m.Rest + math.sin(time * .23f + pair.Key * .71f) * 1.6f;
                else want = m.Rest + math.sin(time * .13f + pair.Key * 1.3f) * .35f;
                float delta = Mathf.DeltaAngle(m.Aim * Mathf.Rad2Deg, want * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                float step = slew * dt;
                m.Aim += math.clamp(delta, -step, step);
                batch.Add(InstanceData.TRS(MapSpace.W(m.Pivot), MapSpace.Yaw(m.Aim), new float3(1), new float4(m.Color, 0)));
            }
            foreach (int id in staleMounts) mounts.Remove(id);
        }

        void DrawTurrets(WrapImages images)
        {
            foreach (var batch in headBatches.Values) if (batch != null && batch.Count > 0) batch.DrawImages(images);
        }

        void DisposeTurrets()
        {
            foreach (var batch in headBatches.Values) batch?.Dispose();
            headBatches.Clear();
        }
    }
}
