using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Staged building models (2026-11-20, user: "all buildings should be more visually distinct and have level of
    /// destruction meshes as well"). tools/blender/build_buildings.py models every base facility (the headquarters per
    /// tier) and every field defense body in Blender, each in four destruction stages, Models/Bld_&lt;key&gt;_s0..s3:
    /// <list type="bullet">
    /// <item>s0 intact, drawn while the building is at 60% health or more (damage bands 0 and 1);</item>
    /// <item>s1 damaged, 35-60% (band 2): blast holes through roofs and upper walls with dark interiors, blown-out
    /// windows, charred rims, missing details, rubble spills, exposed frame members;</item>
    /// <item>s2 heavily damaged, below 35% (band 3): a collapsed section, exposed columns and trusses, toppled masts;</item>
    /// <item>s3 destroyed: the ruin footprint (wall stubs, rubble mounds), drawn where the existing ruin logic leaves a
    /// ruin (a facility's historical parcel, CityRenderer.Architecture.cs; old-world defense sites).</item>
    /// </list>
    /// The existing damage dressing (body darkening, soot, cracks, roof char, smoke and fire, DamageOverlay) stays on top.
    /// A stage change is covered by a dust burst (<see cref="StageDust"/>, played by the bootstrap). Heavy stage meshes
    /// carry a lower level of detail (Bld_*_lo) drawn for cells beyond <see cref="ModelLoDistance"/>.
    /// The models are instanced like every other part: a cell that holds one grows one batch per model and stage after
    /// its Part batches (<see cref="EnsureModelBatches"/>); the base cache and ghost record and replay them by index.
    /// Collision is unchanged: each model's layout repeats the walls of the model or recipe it replaces.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        static readonly string[] StagedKeys =
        {
            "town", "town_t2", "town_t3", "barracks", "motor_works", "heavy_weapons", "airfield", "power_plant", "depot",
            "advanced_lab", "missile_silo",
            "barricade", "guard_post", "bunker", "turret", "aa_battery", "city_turret", "fort", "sensor_post", "artillery_post", "repair_point",
        };
        const int StageCount = 4;
        static int ModelSlots => StagedKeys.Length * StageCount;
        static Mesh[] stagedHi, stagedLo;
        // 2026-11-20 (performance): meshes are decoded the first time a building of that type and stage is drawn, not
        // all ~120 at once, so a match only holds the models it shows and nothing hitches when the first base appears.
        static bool[] hiLoaded, loLoaded;
        static string StagedName(int slot) => "Bld_" + StagedKeys[slot / StageCount] + "_s" + (slot % StageCount);
        static Mesh HiMesh(int slot)
        {
            if (!hiLoaded[slot]) { hiLoaded[slot] = true; stagedHi[slot] = ModelLibrary.Get(StagedName(slot)); }
            return stagedHi[slot];
        }
        static Mesh LoMesh(int slot)
        {
            if (!loLoaded[slot]) { loLoaded[slot] = true; stagedLo[slot] = ModelLibrary.Get(StagedName(slot) + "_lo"); }
            return stagedLo[slot];
        }
        static Dictionary<string, int> stagedIndex;

        /// <summary>Cells nearer the logical eye than this draw the full staged meshes, further ones their LOD.</summary>
        public float ModelLoDistance = 24f;

        /// <summary>Dust bursts for buildings whose destruction stage just worsened: map x, ground y, z, radius. Drained by the bootstrap.</summary>
        public readonly List<float4> StageDust = new List<float4>();
        readonly Dictionary<int, int> stageOf = new Dictionary<int, int>();

        static void StagedTables()
        {
            if (stagedHi != null) return;
            stagedHi = new Mesh[ModelSlots]; stagedLo = new Mesh[ModelSlots];
            hiLoaded = new bool[ModelSlots]; loLoaded = new bool[ModelSlots];
            stagedIndex = new Dictionary<string, int>();
            for (int k = 0; k < StagedKeys.Length; k++) stagedIndex[StagedKeys[k]] = k;
        }

        static bool HasStaged(string key)
        {
            StagedTables();
            return key != null && stagedIndex.TryGetValue(key, out int k) && HiMesh(k * StageCount) != null;
        }

        /// <summary>The model stage for a damage band (StructureStore.DamageBand): intact down to 60%, then damaged, then heavily damaged.</summary>
        public static int MeshStage(int band) => band <= 1 ? 0 : band == 2 ? 1 : 2;

        /// <summary>The staged model key for a positioned building type (the headquarters by its site tier), or null.</summary>
        static string StagedKey(string type, int tier)
        {
            if (string.IsNullOrEmpty(type)) return null;
            string key = type;
            if (DefenseKinds.TryGetValue(type, out var kind)) key = kind.Layout;
            else if (type == "town") key = tier >= 3 ? "town_t3" : tier == 2 ? "town_t2" : "town";
            if (HasStaged(key)) return key;
            return type == "town" && HasStaged("town") ? "town" : null;
        }

        static int StagedSlot(string key, int stage)
        {
            StagedTables();
            if (!stagedIndex.TryGetValue(key, out int k)) return -1;
            stage = Mathf.Clamp(stage, 0, StageCount - 1);
            if (HiMesh(k * StageCount + stage) == null) stage = 0;
            return (int)Part.Count + k * StageCount + stage;
        }

        /// <summary>Grow a cell's batches by one per staged model and stage (once; cells without models never pay for them).</summary>
        static void EnsureModelBatches(Cell cell)
        {
            int total = (int)Part.Count + ModelSlots;
            if (cell.Batches.Length >= total) return;
            StagedTables();
            var next = new InstanceBatch[total];
            System.Array.Copy(cell.Batches, next, cell.Batches.Length);
            var material = RenderResources.Surface(SurfaceKind.Plain);
            for (int i = cell.Batches.Length; i < total; i++)
            {
                int slot = i - (int)Part.Count;
                // the real mesh is passed at draw time (HiMesh/LoMesh, loaded on first use); Box only if a model is missing
                var batch = new InstanceBatch(MeshKit.Box, material, 16);
                if (cell.Preview) batch.Shadows = UnityEngine.Rendering.ShadowCastingMode.Off;
                batch.Bounds = cell.Batches[0].Bounds;
                next[i] = batch;
            }
            cell.Batches = next;
        }

        /// <summary>Place a staged model (its pivot at the building centre on the ground datum).</summary>
        void PutStaged(string key, int stage, float3 mapPos, float mapYaw, float3 size, float3 color)
        {
            int slot = StagedSlot(key, stage);
            if (slot < 0) return;
            EnsureModelBatches(current);
            var p = MapSpace.W(mapPos);
            var data = InstanceData.TRS(p, MapSpace.Yaw(mapYaw), size, new float4(color, 0));
            current.Batches[slot].Add(data);
            instanceTap?.Add((slot, data));
            float r = .75f * math.max(size.x, size.z);
            bmin = math.min(bmin, p - new float3(r, 0, r)); bmax = math.max(bmax, p + new float3(r, 1.2f * size.y, r));
        }

        /// <summary>The cell's batches; staged models switch to their LOD meshes when the cell is far from the eye.</summary>
        void DrawCellBatches(Cell cell, WrapImages images)
        {
            var batches = cell.Batches;
            int parts = (int)Part.Count;
            for (int i = 0; i < parts; i++) if (batches[i].Count > 0) batches[i].DrawImages(images);
            if (batches.Length <= parts) return;
            bool far = false;
            if (ViewLod.Valid)
            {
                var b = cell.Bounds;
                var eye = ViewLod.Eye;
                if (images.Wrap && images.Period > 0) b.center += new Vector3(images.Period * Mathf.Round((eye.x - b.center.x) / images.Period), 0, 0);
                far = b.SqrDistance(eye) > ModelLoDistance * ModelLoDistance;
            }
            for (int i = parts; i < batches.Length; i++)
            {
                var batch = batches[i];
                if (batch.Count == 0) continue;
                int slot = i - parts;
                var hi = HiMesh(slot);
                batch.DrawImages(images, far ? (LoMesh(slot) ?? hi) : hi);
            }
        }

        /// <summary>Remember a positioned building's stage; when it worsens, queue a dust burst over the swap.</summary>
        void NoteStage(in BuildingRecord b, string key, int stage, float x, float z, float ground)
        {
            if (b.Id < 0 || !b.Done) return;
            if (stageOf.TryGetValue(b.Id, out int previous) && stage > previous && !b.Memory)
            {
                float r = VisualExtent(b.Type, out _);
                StageDust.Add(new float4(x, ground, z, Mathf.Clamp(r > 0 ? r : .45f, .2f, .6f)));
            }
            if (stageOf.Count > 8192) stageOf.Clear();
            stageOf[b.Id] = stage;
        }

        /// <summary>
        /// A staged base facility: its model for the current stage, then its layout records that survive the stage: team
        /// marks, flags, smoke stacks, accent pieces (the facility accent colour), team bands, beacons; the walls always.
        /// The headquarters' AA mount (perimeter defense level 2+) stands on its layout mount.
        /// </summary>
        void StagedBuilding(in Ctx c, string type, string key)
        {
            PutStaged(key, c.Stage, new float3(c.X, c.GroundY, c.Z), c.Yaw, new float3(1), c.Tint);
            if (!Layouts().TryGetValue(key, out var l)) return;
            var cc = c;
            math.sincos(cc.Yaw, out float sn, out float cs);
            float3 Map(float3 at) => new float3(cc.X + at.x * cs + at.z * sn, cc.GroundY + at.y, cc.Z - at.x * sn + at.z * cs);
            int stage = c.Stage;
            var team = c.Civ * c.Tint;
            var accent = FacilityAccent(type, out var a) ? a * c.Tint : team;
            for (int i = 0; i < l.Marks.Count; i++)
                if (l.MarkMax[i] >= stage) Put(Part.Box, Map(l.Marks[i].at) - new float3(0, l.Marks[i].size.y * .5f, 0), c.Yaw, l.Marks[i].size, team, .25f);
            foreach (var f in l.Flags) if (f.w >= stage) Flag(c, f.x, f.y, f.z);
            for (int i = 0; i < l.Smoke.Count; i++)
                if (l.SmokeMax[i] >= stage) Stack(c, l.Smoke[i].at.x, l.Smoke[i].at.z, l.Smoke[i].at.y, l.Smoke[i].steam, l.Smoke[i].size);
            foreach (var (at, size, glow, max) in l.Accents)
                if (max >= stage) Put(Part.Box, Map(at), c.Yaw, size, accent, glow);
            foreach (var (at, radius, h, segs, gap, glow, isAccent, max) in l.Bands)
            {
                if (max < stage || segs <= 0) continue;
                float chord = 2f * radius * math.sin(math.PI / segs) - gap;
                for (int k = 0; k < segs; k++)
                {
                    float ang = (k + (gap > 0 ? 0f : .5f)) * 2f * math.PI / segs;
                    math.sincos(ang, out float s, out float co);
                    Put(Part.Box, Map(at + new float3(s * radius, 0, co * radius)), c.Yaw + ang, new float3(chord, h, .012f), isAccent ? accent : team, glow);
                }
            }
            foreach (var (at, size, glow, max) in l.Beacons)
                if (max >= stage) Put(Part.Box, Map(at), c.Yaw, new float3(size), team, glow);
            if (recording != null) foreach (var w in l.Walls) if (!recording.Contains(w)) recording.Add(w);
            if (type == "town" && l.Mounts.Count > 0) HeadquartersAaMount(c, Map(l.Mounts[0]), stage);
        }

        /// <summary>City AA on the headquarters roof (perimeter level 2+), as the old tier dressing placed it, on the model's mount.</summary>
        void HeadquartersAaMount(in Ctx c, float3 roof, int stage)
        {
            foreach (var st in objectiveByTile.Values)
            {
                if (!st.IsBase || math.abs(st.X - c.X) > .6f || math.abs(st.Z - c.Z) > .6f) continue;
                if (st.DefenseLevel >= 2 && composing >= 0 && stage < 2)
                {
                    Put(Part.Cylinder, roof, c.Yaw, new float3(.2f, .02f, .2f), new float3(.62f, .61f, .57f) * c.Tint);
                    var head = st.DefenseLevel >= 3 ? "Def_aa_head3" : "Def_aa_head2";
                    if (!mounts.TryGetValue(composing, out var mount)) mounts[composing] = mount = new TurretMount { Aim = c.Yaw };
                    mount.Pivot = roof + new float3(0, .02f, 0);
                    mount.Rest = c.Yaw + math.PI; mount.Head = head; mount.Kind = TurretKind.AntiAir; mount.Level = st.DefenseLevel;
                    mount.Memory = st.Memory; mount.Color = math.lerp(new float3(.86f, .87f, .82f), c.Civ, .55f) * c.Tint;
                }
                else if (composing >= 0) mounts.Remove(composing);
                break;
            }
        }

        /// <summary>The ruin (s3) of a staged type at a ruin parcel or ruin site; false when the type has no staged model.</summary>
        bool StagedRuin(in Ctx c, string type)
        {
            string key = StagedKey(type, 1);
            if (key == null || ModelLibrary.Get("Bld_" + key + "_s3") == null) return false;
            PutStaged(key, 3, new float3(c.X, c.GroundY, c.Z), c.Yaw, new float3(1), c.Tint);
            return true;
        }
    }
}
