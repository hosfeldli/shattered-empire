using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;

namespace SE.Core.Units
{
    /// <summary>
    /// Every unit this viewer can see, as compact records in stable slots, plus a short history of
    /// snapshot positions so movement is drawn smoothly between the server's updates.
    ///
    /// Snapshots must be applied in wire order and none may be skipped: with capability 'udelta' an
    /// unchanged unit is simply absent, so dropping an older delta would freeze or lose units. Only the
    /// presentation built from this store may be coalesced.
    /// </summary>
    public sealed class UnitStore
    {
        public const float InterpDelay = 0.25f;   // seconds of server time drawn behind the newest snapshot
        public const int History = 10;

        public struct Record
        {
            public int Id, Owner, TypeIndex, Tile, Next, Hp, Supply, Flags, Target, Formation, Veteran, Morale;
            public float Prog;
            public int AirState, AirMission, AirMissionTile, AirRadius;
            public bool InUse;
            public WorldMotion Motion;
        }

        /// <summary>Positions in one snapshot, indexed by slot (Id[slot] says whose position it is).</summary>
        sealed class Frame
        {
            public float Time;
            public int[] Id = Array.Empty<int>();
            public int[] Tile = Array.Empty<int>();
            public int[] Next = Array.Empty<int>();
            public float[] Prog = Array.Empty<float>();
            public WorldMotion[] Motion = Array.Empty<WorldMotion>();

            public void Ensure(int n)
            {
                if (Id.Length >= n) return;
                int size = Math.Max(n, Math.Max(64, Id.Length * 2));
                Array.Resize(ref Id, size); Array.Resize(ref Tile, size); Array.Resize(ref Next, size); Array.Resize(ref Prog, size);
                Array.Resize(ref Motion, size);
            }
        }

        public Record[] Records = new Record[256];
        public int SlotCount;                     // slots ever used (iterate 0..SlotCount)
        public int Count { get; private set; }
        public readonly Dictionary<int, int> SlotOf = new Dictionary<int, int>();
        readonly Stack<int> free = new Stack<int>();
        public readonly Dictionary<int, int[]> Paths = new Dictionary<int, int[]>();
        public readonly Dictionary<int, WorldPoint[]> WorldPaths = new Dictionary<int, WorldPoint[]>();
        public readonly UnitTypes Types;

        readonly Frame[] frames = new Frame[History];
        int frameHead = -1, frameCount;
        public float RenderTime { get; private set; }
        public float NewestTime => frameCount > 0 ? frames[frameHead].Time : 0f;
        public int SnapshotCount { get; private set; }
        /// <summary>Increments whenever units are added or removed (renderers rebuild their groupings).</summary>
        public int MembershipRevision { get; private set; }
        public int Revision { get; private set; }

        // interpolation bracket for the current render time
        Frame s0, s1;
        float f = 1f;
        bool single = true;
        float preparedFor = float.NaN;

        HexGrid grid;
        readonly HashSet<int> seen = new HashSet<int>();

        public UnitStore(UnitTypes types)
        {
            Types = types;
            for (int i = 0; i < History; i++) frames[i] = new Frame();
        }

        public void Reset(HexGrid g)
        {
            grid = g;
            Array.Clear(Records, 0, Records.Length);
            SlotCount = 0; Count = 0;
            SlotOf.Clear(); free.Clear(); Paths.Clear(); WorldPaths.Clear();
            frameHead = -1; frameCount = 0; RenderTime = 0; SnapshotCount = 0;
            preparedFor = float.NaN; s0 = s1 = null;
            MembershipRevision++; Revision++;
        }

        int Alloc(int id)
        {
            int slot;
            if (free.Count > 0) slot = free.Pop();
            else
            {
                slot = SlotCount++;
                if (slot >= Records.Length) Array.Resize(ref Records, Records.Length * 2);
            }
            SlotOf[id] = slot;
            Count++;
            MembershipRevision++;
            return slot;
        }

        void Remove(int id)
        {
            if (!SlotOf.TryGetValue(id, out int slot)) return;
            SlotOf.Remove(id);
            WorldPaths.Remove(id);
            Records[slot] = default;
            free.Push(slot);
            Count--;
            MembershipRevision++;
        }

        public bool TryGet(int id, out Record r)
        {
            if (SlotOf.TryGetValue(id, out int slot)) { r = Records[slot]; return true; }
            r = default;
            return false;
        }

        /// <summary>Apply the unit part of one 's' message (port of WorldState.gd apply_snapshot).</summary>
        public void Apply(SnapshotMessage m)
        {
            seen.Clear();
            foreach (var a in m.Units)
            {
                if (a.Id < 0) continue;
                seen.Add(a.Id);
                if (!SlotOf.TryGetValue(a.Id, out int slot)) slot = Alloc(a.Id);
                ref var u = ref Records[slot];
                u.InUse = true;
                u.Id = a.Id; u.Owner = a.Owner; u.TypeIndex = Types.IndexOf(a.Type);
                u.Tile = a.Tile; u.Next = a.Next; u.Prog = a.Prog; u.Hp = a.Hp; u.Supply = a.Supply;
                u.Flags = a.Flags; u.Target = a.Target; u.Formation = a.Formation; u.Veteran = a.Veteran; u.Morale = a.Morale;
                u.AirState = a.AirState; u.AirMission = a.AirMission; u.AirMissionTile = a.AirMissionTile; u.AirRadius = a.AirRadius;
                u.Motion = a.Motion;
            }
            if (m.Delta)
            {
                foreach (int id in m.Gone) Remove(id);
                foreach (var kv in m.Paths) Paths[kv.Key] = kv.Value;
                foreach (int id in m.PathsGone) Paths.Remove(id);
                foreach (int id in m.WorldPathsGone) WorldPaths.Remove(id);
            }
            else
            {
                // a full set: whatever was not listed has left view
                var gone = new List<int>();
                foreach (var kv in SlotOf) if (!seen.Contains(kv.Key)) gone.Add(kv.Key);
                foreach (int id in gone) Remove(id);
                Paths.Clear();
                WorldPaths.Clear();
                foreach (var kv in m.Paths) Paths[kv.Key] = kv.Value;
            }
            foreach (var entry in m.WorldPaths) WorldPaths[entry.Key] = entry.Value;
            // record this snapshot's positions for every unit we now hold
            frameHead = (frameHead + 1) % History;
            if (frameCount < History) frameCount++;
            var fr = frames[frameHead];
            fr.Time = m.Time;
            fr.Ensure(SlotCount);
            for (int s = 0; s < SlotCount; s++)
            {
                ref var u = ref Records[s];
                if (!u.InUse) { fr.Id[s] = -1; continue; }
                fr.Id[s] = u.Id; fr.Tile[s] = u.Tile; fr.Next[s] = u.Next; fr.Prog[s] = u.Prog;
                fr.Motion[s] = u.Motion;
            }
            SnapshotCount++;
            Revision++;
            preparedFor = float.NaN;
        }

        /// <summary>Advance the playback clock: it trails the newest snapshot by InterpDelay and eases toward it.</summary>
        public void AdvanceClock(float dt, float playRate, bool paused)
        {
            if (frameCount == 0) return;
            float newest = frames[frameHead].Time;
            float target = newest - InterpDelay;
            RenderTime += dt * (paused ? 0f : playRate);
            float err = target - RenderTime;
            if (Math.Abs(err) > 1.5f) RenderTime = target;
            else RenderTime += err * Math.Min(1f, dt * 2.5f);
            RenderTime = Math.Min(RenderTime, newest);
        }

        Frame FrameAt(int age) => frames[(frameHead - age + History * 2) % History];

        void Prepare()
        {
            if (preparedFor == RenderTime) return;
            preparedFor = RenderTime;
            s0 = s1 = null; f = 1f; single = true;
            if (frameCount == 0) return;
            int i1 = 0;   // age 0 = newest
            while (i1 < frameCount - 1 && FrameAt(i1 + 1).Time >= RenderTime) i1++;
            s1 = FrameAt(i1);
            if (i1 == frameCount - 1) { s0 = s1; return; }
            single = false;
            s0 = FrameAt(i1 + 1);
            float span = s1.Time - s0.Time;
            f = span > 1e-4f ? Math.Max(0f, Math.Min(1f, (RenderTime - s0.Time) / span)) : 1f;
        }

        void PosIn(Frame fr, int slot, int id, out float x, out float z, out bool ok)
        {
            ok = fr != null && slot < fr.Id.Length && fr.Id[slot] == id;
            if (!ok) { x = z = 0; return; }
            var motion = fr.Motion[slot];
            if (motion.Present) { x = motion.X; z = motion.Z; }
            else PathPoint(fr.Tile[slot], fr.Next[slot], fr.Prog[slot], out x, out z);
        }

        void Latest(in Record u, out float x, out float z)
        {
            if (u.Motion.Present) { x = u.Motion.X; z = u.Motion.Z; }
            else PathPoint(u.Tile, u.Next, u.Prog, out x, out z);
        }

        /// <summary>Position between a hex and the next one on its path, in the image nearest the first.</summary>
        public void PathPoint(int tile, int next, float prog, out float x, out float z)
        {
            x = grid.CenterX(tile); z = grid.CenterZ(tile);
            if (next < 0 || prog <= 0f) return;
            float bx = grid.CenterX(next), bz = grid.CenterZ(next);
            x += grid.DxWrap(x, bx) * prog;
            z += (bz - z) * prog;
        }

        /// <summary>Where the unit in this slot is drawn at the current render time (base image).</summary>
        public void Position(int slot, out float x, out float z)
        {
            Prepare();
            ref var u = ref Records[slot];
            if (s1 == null) { Latest(u, out x, out z); return; }
            PosIn(s1, slot, u.Id, out float x1, out float z1, out bool ok1);
            if (single)
            {
                if (ok1) { x = x1; z = z1; } else Latest(u, out x, out z);
                return;
            }
            PosIn(s0, slot, u.Id, out float x0, out float z0, out bool ok0);
            if (!ok1) { if (ok0) { x = x0; z = z0; } else Latest(u, out x, out z); return; }
            if (!ok0) { x = x1; z = z1; return; }
            x = x0 + grid.DxWrap(x0, x1) * f;
            z = z0 + (z1 - z0) * f;
        }

        /// <summary>Direction of travel at the current render time (zero when stationary).</summary>
        public void Heading(int slot, out float dx, out float dz)
        {
            ref var u = ref Records[slot];
            if (u.Motion.Present) { dx = u.Motion.Vx; dz = u.Motion.Vz; return; }
            dx = dz = 0;
            if (u.Next >= 0 && u.Next != u.Tile)
            {
                dx = grid.DxWrap(grid.CenterX(u.Tile), grid.CenterX(u.Next));
                dz = grid.CenterZ(u.Next) - grid.CenterZ(u.Tile);
            }
        }

        public float Facing(int slot)
        {
            Prepare();
            var u = Records[slot];
            if (s1 == null || slot >= s1.Id.Length || s1.Id[slot] != u.Id) return u.Motion.Yaw;
            float to = s1.Motion[slot].Yaw;
            if (single || slot >= s0.Id.Length || s0.Id[slot] != u.Id) return to;
            float from = s0.Motion[slot].Yaw;
            return from + (float)Math.Atan2(Math.Sin(to - from), Math.Cos(to - from)) * f;
        }
    }

    /// <summary>Unit type names mapped to small stable indices for instanced batching.</summary>
    public sealed class UnitTypes
    {
        readonly Dictionary<string, int> index = new Dictionary<string, int>();
        readonly List<string> names = new List<string>();
        readonly object gate = new object();

        public static readonly string[] Known =
        {
            "colonist", "engineer", "scout_buggy", "militia", "rifle_squad", "mortar_team", "armored_car", "supply_truck",
            "field_gun", "mech_infantry", "tank", "sp_artillery", "helicopter", "recon_drone", "missile_battery", "fighter",
            "bomber", "oneway_drone", "air_defense", "special_forces", "autonomous_tank", "strike_swarm", "exo_infantry",
        };

        public UnitTypes() { foreach (var n in Known) IndexOf(n); }

        public int Count { get { lock (gate) return names.Count; } }

        public int IndexOf(string name)
        {
            name = name ?? "";
            lock (gate)
            {
                if (index.TryGetValue(name, out int i)) return i;
                i = names.Count;
                names.Add(name);
                index[name] = i;
                return i;
            }
        }

        public string Name(int i) { lock (gate) return i >= 0 && i < names.Count ? names[i] : ""; }
    }
}
