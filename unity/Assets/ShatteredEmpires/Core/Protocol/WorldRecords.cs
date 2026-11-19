using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace SE.Core.Protocol
{
    /// <summary>A trench segment (server fieldworks.js fieldworksFor).</summary>
    public struct TrenchRecord
    {
        public int Tile, Owner, Dir, Progress, Hp, State, Route;
        /// <summary>trenchWorld element 4: bit d set when the neighbour in hex direction d carries a road (the line stops at its verge).</summary>
        public int RoadMask;
        public bool Reinforced, Upgrading;
        public bool HasPosition;
        public float X, Z, Facing;
        public bool Built => Progress >= 100;
    }

    /// <summary>A ruin of the old world (server econSnapshot ruins: [tile, type, flags]).</summary>
    public struct RuinRecord
    {
        public int Tile, Flags;
        public string Type;
    }

    public struct CraterRecord { public int Tile; public float Depth; }
    public struct WreckRecord { public int Tile, Owner; public string Type; public bool Burning, HasPosition; public float X, Z, Yaw; }
    /// <summary>A crater. Heal: fraction of its depth left (server battlefield.js impactHeal; 1 fresh, falls toward 0 as it fills in).</summary>
    public struct ImpactRecord { public int Tile, Seed; public string Class; public float X, Z, Severity, Heal; }
    public struct TileValue { public int Tile; public float Value; }

    /// <summary>Battlefield damage (server battlefield.js battlefieldSnapshot).</summary>
    public sealed class BattlefieldState
    {
        public CraterRecord[] Craters = Array.Empty<CraterRecord>();
        public WreckRecord[] Wrecks = Array.Empty<WreckRecord>();
        public ImpactRecord[] Impacts = Array.Empty<ImpactRecord>();
        public TileValue[] Scorch = Array.Empty<TileValue>(), Wear = Array.Empty<TileValue>();
        public TileValue[] Smoke = Array.Empty<TileValue>();
        /// <summary>No-man's-land stage per tile (shelled ground: 1 churned .. 4 wasteland).</summary>
        public TileValue[] Intensity = Array.Empty<TileValue>();
    }

    /// <summary>
    /// A keyed battlefield delta (Pass 4, server delta.js keyedBattlefield 'bfd'): for each sub-list, every row of each tile
    /// that changed (they replace all rows that tile had) and the tiles that left the sub-list.
    /// </summary>
    public sealed class BattlefieldDelta
    {
        public int Version;
        public BattlefieldState Updated = new BattlefieldState();
        public int[] CratersGone, WrecksGone, ImpactsGone, ScorchGone, WearGone, SmokeGone, IntensityGone;
    }

    /// <summary>Rows grouped by tile, in the order the server listed them within a tile (crater stamping keeps the first six).</summary>
    sealed class TileGroups<T>
    {
        readonly Dictionary<int, List<T>> byTile = new Dictionary<int, List<T>>();
        readonly Stack<List<T>> pool = new Stack<List<T>>();
        readonly HashSet<int> touched = new HashSet<int>();
        readonly Func<T, int> tileOf;
        int count;
        public TileGroups(Func<T, int> tileOf) { this.tileOf = tileOf; }

        public void Clear()
        {
            foreach (var l in byTile.Values) { l.Clear(); pool.Push(l); }
            byTile.Clear();
            count = 0;
        }

        public void Reset(T[] all) { Clear(); Apply(all, null); }

        public void Apply(T[] updated, int[] removed)
        {
            if (removed != null)
                foreach (int t in removed)
                    if (byTile.TryGetValue(t, out var l)) { count -= l.Count; l.Clear(); pool.Push(l); byTile.Remove(t); }
            if (updated == null) return;
            touched.Clear();
            foreach (var r in updated)
            {
                int t = tileOf(r);
                if (!byTile.TryGetValue(t, out var l)) byTile[t] = l = pool.Count > 0 ? pool.Pop() : new List<T>(4);
                if (touched.Add(t)) { count -= l.Count; l.Clear(); }   // a changed tile's rows replace the rows it had
                l.Add(r);
                count++;
            }
        }

        public T[] ToArray()
        {
            if (count == 0) return Array.Empty<T>();
            var a = new T[count];
            int i = 0;
            foreach (var l in byTile.Values) for (int k = 0; k < l.Count; k++) a[i++] = l[k];
            return a;
        }
    }

    /// <summary>
    /// The battlefield a keyed-delta client holds (Pass 4): a full 'bf' resets it, a 'bfd' delta patches it by tile, and
    /// <see cref="Snapshot"/> builds the arrays the renderers read (a new object, so a queued geometry update keeps its copy).
    /// </summary>
    public sealed class BattlefieldStore
    {
        public int Version = -1;
        readonly TileGroups<CraterRecord> craters = new TileGroups<CraterRecord>(r => r.Tile);
        readonly TileGroups<WreckRecord> wrecks = new TileGroups<WreckRecord>(r => r.Tile);
        readonly TileGroups<ImpactRecord> impacts = new TileGroups<ImpactRecord>(r => r.Tile);
        readonly TileGroups<TileValue> scorch = new TileGroups<TileValue>(r => r.Tile), wear = new TileGroups<TileValue>(r => r.Tile),
            smoke = new TileGroups<TileValue>(r => r.Tile), intensity = new TileGroups<TileValue>(r => r.Tile);

        public void Clear()
        {
            craters.Clear(); wrecks.Clear(); impacts.Clear(); scorch.Clear(); wear.Clear(); smoke.Clear(); intensity.Clear();
            Version = -1;
        }

        public void Reset(BattlefieldState s, int version)
        {
            craters.Reset(s.Craters); wrecks.Reset(s.Wrecks); impacts.Reset(s.Impacts);
            scorch.Reset(s.Scorch); wear.Reset(s.Wear); smoke.Reset(s.Smoke); intensity.Reset(s.Intensity);
            Version = version;
        }

        public void Apply(BattlefieldDelta d)
        {
            var u = d.Updated;
            craters.Apply(u.Craters, d.CratersGone); wrecks.Apply(u.Wrecks, d.WrecksGone); impacts.Apply(u.Impacts, d.ImpactsGone);
            scorch.Apply(u.Scorch, d.ScorchGone); wear.Apply(u.Wear, d.WearGone); smoke.Apply(u.Smoke, d.SmokeGone); intensity.Apply(u.Intensity, d.IntensityGone);
            Version = d.Version;
        }

        public BattlefieldState Snapshot() => new BattlefieldState
        {
            Craters = craters.ToArray(), Wrecks = wrecks.ToArray(), Impacts = impacts.ToArray(),
            Scorch = scorch.ToArray(), Wear = wear.ToArray(), Smoke = smoke.ToArray(), Intensity = intensity.ToArray(),
        };
    }

    /// <summary>Regional weather on a coarse grid (server weather.js snapshot).</summary>
    public sealed class WeatherState
    {
        public int Version, CellsW, CellsH, Cell = 8;
        public float WindAngle, WindSpeed;
        public byte[] Cloud, Rain, Fog, Wet, Storm;

        /// <summary>
        /// The field at a hex, blended bilinearly between the centres of the coarse weather cells. (Reading the
        /// cell the hex falls in drew each 8-hex cell as a flat block: rain-wet ground showed as a straight-edged
        /// light/dark split across the terrain, final pass f60/f91.)
        /// </summary>
        public float Sample(byte[] field, int tile, int mapW)
        {
            if (field == null || CellsW <= 0 || CellsH <= 0 || Cell <= 0) return 0f;
            int q = tile % mapW, r = tile / mapW;
            float gx = (q + .5f) / Cell - .5f, gy = (r + .5f) / Cell - .5f;
            int x0 = (int)Math.Floor(gx), y0 = (int)Math.Floor(gy);
            float tx = gx - x0, ty = gy - y0;
            float a = At(field, x0, y0), b = At(field, x0 + 1, y0), c = At(field, x0, y0 + 1), d = At(field, x0 + 1, y0 + 1);
            return (a + (b - a) * tx) * (1f - ty) + (c + (d - c) * tx) * ty;
        }

        float At(byte[] field, int cx, int cy)
        {
            cx = Math.Max(0, Math.Min(CellsW - 1, cx)); cy = Math.Max(0, Math.Min(CellsH - 1, cy));
            int i = cy * CellsW + cx;
            return i < field.Length ? field[i] / 255f : 0f;
        }
    }

    public static class WorldRecordDecoder
    {
        static int I(JToken t, int def = 0) => ProtocolDecoder.Int(t, def);

        public static TrenchRecord[] Trenches(JToken fw)
        {
            if (!(fw is JArray a)) return null;
            var list = new TrenchRecord[a.Count];
            for (int k = 0; k < a.Count; k++)
            {
                if (!(a[k] is JArray r) || r.Count < 6) continue;
                list[k] = new TrenchRecord
                {
                    Tile = I(r[0], -1), Owner = I(r[1], -1), Reinforced = I(r[2]) == 1, Dir = I(r[3]), Progress = I(r[4]), Hp = I(r[5], 100),
                    State = r.Count > 6 ? I(r[6]) : 0, Upgrading = r.Count > 7 && I(r[7]) == 1, Route = r.Count > 8 ? I(r[8]) : 0,
                };
            }
            return list;
        }

        public static RuinRecord[] Ruins(JToken ruins)
        {
            if (!(ruins is JArray a)) return null;
            var list = new RuinRecord[a.Count];
            for (int k = 0; k < a.Count; k++)
                if (a[k] is JArray r && r.Count >= 2) list[k] = new RuinRecord { Tile = I(r[0], -1), Type = ProtocolDecoder.Str(r[1], ""), Flags = r.Count > 2 ? I(r[2]) : 0 };
            return list;
        }

        /// <summary>Road traffic flow (econ 'traffic': [tileA, tileB, level 1–9]) as flat triples.</summary>
        public static int[] Traffic(JToken traffic)
        {
            if (!(traffic is JArray a)) return null;
            var list = new int[a.Count * 3];
            for (int k = 0; k < a.Count; k++)
                if (a[k] is JArray r && r.Count >= 3) { list[k * 3] = I(r[0], -1); list[k * 3 + 1] = I(r[1], -1); list[k * 3 + 2] = I(r[2]); }
                else list[k * 3] = list[k * 3 + 1] = -1;
            return list;
        }

        /// <summary>Each civilization's era (the civs list), indexed by civ id; -1 where unknown.</summary>
        public static int[] CivAges(JToken civs)
        {
            if (!(civs is JArray a)) return null;
            int max = -1;
            foreach (var c in a) max = System.Math.Max(max, I(c["id"], -1));
            var ages = new int[max + 1];
            for (int i = 0; i < ages.Length; i++) ages[i] = -1;
            foreach (var c in a) { int id = I(c["id"], -1); if (id >= 0 && c["age"] != null && c["age"].Type != JTokenType.Null) ages[id] = I(c["age"], -1); }
            return ages;
        }

        public static BattlefieldState Battlefield(JObject bf)
        {
            if (bf == null) return null;
            var s = new BattlefieldState();
            var c = new List<CraterRecord>();
            if (bf["c"] is JArray ca) foreach (var x in ca) if (x is JArray r && r.Count >= 2) c.Add(new CraterRecord { Tile = I(r[0], -1), Depth = ProtocolDecoder.Float(r[1]) });
            s.Craters = c.ToArray();
            var w = new List<WreckRecord>();
            if (bf["w"] is JArray wa) foreach (var x in wa) if (x is JArray r && r.Count >= 2) w.Add(new WreckRecord { Tile = I(r[0], -1), Type = ProtocolDecoder.Str(r[1], ""), Burning = r.Count > 2 && I(r[2]) == 1, Owner = r.Count > 3 ? I(r[3], -1) : -1, HasPosition = r.Count >= 7, X = r.Count >= 7 ? ProtocolDecoder.Float(r[4]) : 0, Z = r.Count >= 7 ? ProtocolDecoder.Float(r[5]) : 0, Yaw = r.Count >= 7 ? ProtocolDecoder.Float(r[6]) : 0 });
            s.Wrecks = w.ToArray();
            var impacts = new List<ImpactRecord>();
            if (bf["m"] is JArray ma) foreach (var x in ma) if (x is JArray r && r.Count >= 6)
                impacts.Add(new ImpactRecord { Tile = I(r[0], -1), Class = ProtocolDecoder.Str(r[1], "shell"), X = ProtocolDecoder.Float(r[2]), Z = ProtocolDecoder.Float(r[3]), Severity = ProtocolDecoder.Float(r[4]), Seed = I(r[5]),
                    Heal = r.Count >= 7 ? Math.Max(0f, Math.Min(1f, ProtocolDecoder.Float(r[6]) / 100f)) : 1f });   // older servers: no healing field
            s.Impacts = impacts.ToArray();
            s.Scorch = Values(bf["sc"], .1f); s.Wear = Values(bf["wr"], .1f);
            s.Smoke = Values(bf["s"], 0.1f);
            s.Intensity = Values(bf["i"], 1f);
            return s;
        }

        /// <summary>A keyed battlefield delta ('bfd': { v, u: { sub: rows }, r: { sub: tiles } }), or null when absent.</summary>
        public static BattlefieldDelta BattlefieldChanges(JObject bfd)
        {
            if (bfd == null) return null;
            var r = bfd["r"] as JObject;
            return new BattlefieldDelta
            {
                Version = I(bfd["v"], -1),
                Updated = Battlefield(bfd["u"] as JObject) ?? new BattlefieldState(),
                CratersGone = Tiles(r?["c"]), WrecksGone = Tiles(r?["w"]), ImpactsGone = Tiles(r?["m"]),
                ScorchGone = Tiles(r?["sc"]), WearGone = Tiles(r?["wr"]), SmokeGone = Tiles(r?["s"]), IntensityGone = Tiles(r?["i"]),
            };
        }

        static int[] Tiles(JToken t)
        {
            if (!(t is JArray a) || a.Count == 0) return null;
            var r = new int[a.Count];
            for (int i = 0; i < r.Length; i++) r[i] = I(a[i], -1);
            return r;
        }

        static TileValue[] Values(JToken t, float scale)
        {
            if (!(t is JArray a)) return Array.Empty<TileValue>();
            var list = new List<TileValue>(a.Count);
            foreach (var x in a) if (x is JArray r && r.Count >= 2) list.Add(new TileValue { Tile = I(r[0], -1), Value = ProtocolDecoder.Float(r[1]) * scale });
            return list.ToArray();
        }

        public static WeatherState Weather(JObject wx)
        {
            if (wx == null) return null;
            byte[] B(string k)
            {
                var s = ProtocolDecoder.Str(wx[k]);
                if (string.IsNullOrEmpty(s)) return null;
                try { return Convert.FromBase64String(s); } catch (FormatException) { return null; }
            }
            var w = new WeatherState
            {
                Version = I(wx["v"]), CellsW = I(wx["cw"]), CellsH = I(wx["ch"]), Cell = I(wx["cell"], 8),
                Cloud = B("cloud"), Rain = B("rain"), Fog = B("fog"), Wet = B("wet"), Storm = B("storm"),
            };
            if (wx["wind"] is JArray wind && wind.Count >= 2) { w.WindAngle = ProtocolDecoder.Float(wind[0]); w.WindSpeed = ProtocolDecoder.Float(wind[1]); }
            return w;
        }
    }
}
