using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace SE.Core.Protocol
{
    /// <summary>A trench segment (server fieldworks.js fieldworksFor).</summary>
    public struct TrenchRecord
    {
        public int Tile, Owner, Dir, Progress, Hp, State, Route;
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
    public struct ImpactRecord { public int Tile, Seed; public string Class; public float X, Z, Severity; }
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

    /// <summary>Regional weather on a coarse grid (server weather.js snapshot).</summary>
    public sealed class WeatherState
    {
        public int Version, CellsW, CellsH, Cell = 8;
        public float WindAngle, WindSpeed;
        public byte[] Cloud, Rain, Fog, Wet, Storm;

        public float Sample(byte[] field, int tile, int mapW)
        {
            if (field == null || CellsW <= 0) return 0f;
            int q = tile % mapW, r = tile / mapW;
            int cx = Math.Min(CellsW - 1, q / Cell), cy = Math.Min(CellsH - 1, r / Cell);
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
                impacts.Add(new ImpactRecord { Tile = I(r[0], -1), Class = ProtocolDecoder.Str(r[1], "shell"), X = ProtocolDecoder.Float(r[2]), Z = ProtocolDecoder.Float(r[3]), Severity = ProtocolDecoder.Float(r[4]), Seed = I(r[5]) });
            s.Impacts = impacts.ToArray();
            s.Scorch = Values(bf["sc"], .1f); s.Wear = Values(bf["wr"], .1f);
            s.Smoke = Values(bf["s"], 0.1f);
            s.Intensity = Values(bf["i"], 1f);
            return s;
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
