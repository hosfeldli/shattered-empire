using System.Collections.Generic;
using SE.Core.Protocol;

namespace SE.Core.World
{
    /// <summary>
    /// Buildings and cities as last reported, with change detection by render cell. Production values,
    /// staffing and other state that does not change how a building looks never dirty a cell, so a
    /// building completing or a district changing rebuilds one cell, never a whole city.
    /// </summary>
    public sealed class StructureStore
    {
        public readonly Dictionary<int, BuildingRecord> Buildings = new Dictionary<int, BuildingRecord>();
        public readonly Dictionary<int, CityRecord> Cities = new Dictionary<int, CityRecord>();
        readonly Dictionary<int, long> visualKey = new Dictionary<int, long>();
        readonly HashSet<int> seen = new HashSet<int>();
        readonly List<int> gone = new List<int>();
        public int Revision { get; private set; }
        /// <summary>The civilization's era drives every building's architecture (0 Reclamation .. 4 Advanced Systems).</summary>
        public readonly Dictionary<int, int> CivAge = new Dictionary<int, int>();

        public void Clear()
        {
            Buildings.Clear(); Cities.Clear(); visualKey.Clear(); CivAge.Clear();
            Revision++;
        }

        /// <summary>What a building looks like, packed: anything outside this key is not visual.</summary>
        /// <summary>Damage band of a building (target spec §8.3): 0 intact (85–100%), 1 light (60–85), 2 heavy (35–60), 3 critical (below 35).</summary>
        public static int DamageBand(int hpPercent) => hpPercent >= 85 ? 0 : hpPercent >= 60 ? 1 : hpPercent >= 35 ? 2 : 3;

        public static long VisualKey(in BuildingRecord b)
        {
            unchecked
            {
                long k = (b.Type ?? "").GetHashCode();
                k = k * 31 + b.Owner;
                k = k * 31 + b.Level;
                k = k * 31 + b.Tier;
                k = k * 31 + (b.Done ? 1 : 0);
                k = k * 31 + (b.Done ? 0 : b.Progress / 10);    // construction shows in 10% steps
                k = k * 31 + DamageBand(b.Hp);                   // damage shows in the design's bands
                k = k * 31 + b.Era;
                k = k * 31 + (b.Fire ? 1 : 0);
                k = k * 31 + (b.Memory ? 1 : 0);
                k = k * 31 + b.Tile;
                if (b.HasPosition) { k = k * 31 + b.X.GetHashCode(); k = k * 31 + b.Z.GetHashCode(); }
                if (b.HasYaw) k = k * 31 + b.Yaw.GetHashCode();
                return k;
            }
        }

        /// <summary>Apply a full building list; adds every render cell whose look changed to dirtyCells.</summary>
        public void ApplyBuildings(BuildingRecord[] list, WorldModel world, HashSet<int> dirtyCells)
        {
            seen.Clear();
            foreach (var b in list)
            {
                if (b.Tile < 0 || b.Tile >= world.Grid.N) continue;
                seen.Add(b.Id);
                long key = VisualKey(b);
                if (!visualKey.TryGetValue(b.Id, out long old) || old != key)
                {
                    if (Buildings.TryGetValue(b.Id, out var prev) && prev.Tile != b.Tile) dirtyCells.Add(world.ChunkOf(prev.Tile));
                    dirtyCells.Add(world.ChunkOf(b.Tile));
                    visualKey[b.Id] = key;
                }
                Buildings[b.Id] = b;
            }
            gone.Clear();
            foreach (var id in Buildings.Keys) if (!seen.Contains(id)) gone.Add(id);
            foreach (var id in gone)
            {
                dirtyCells.Add(world.ChunkOf(Buildings[id].Tile));
                Buildings.Remove(id);
                visualKey.Remove(id);
            }
            if (dirtyCells.Count > 0) Revision++;
        }

        public void ApplyCities(CityRecord[] list, WorldModel world, HashSet<int> dirtyCells)
        {
            seen.Clear();
            foreach (var c in list)
            {
                seen.Add(c.Id);
                if (!Cities.TryGetValue(c.Id, out var prev) || prev.Tier != c.Tier || prev.Owner != c.Owner || (int)prev.Pop / 10 != (int)c.Pop / 10)
                    if (c.Tile >= 0 && c.Tile < world.Grid.N) dirtyCells.Add(world.ChunkOf(c.Tile));
                Cities[c.Id] = c;
            }
            gone.Clear();
            foreach (var id in Cities.Keys) if (!seen.Contains(id)) gone.Add(id);
            foreach (var id in gone) Cities.Remove(id);
        }
    }
}
