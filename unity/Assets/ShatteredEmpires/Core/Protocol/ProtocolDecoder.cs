using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SE.Core.Protocol
{
    /// <summary>
    /// Converts one wire message (JSON text) into a typed <see cref="ServerMessage"/>. Thread-safe and
    /// stateless: the network layer runs it on worker threads, then applies results in wire order.
    /// </summary>
    public static class ProtocolDecoder
    {
        static readonly JsonLoadSettings LoadSettings = new JsonLoadSettings
        {
            CommentHandling = CommentHandling.Ignore,
            LineInfoHandling = LineInfoHandling.Ignore,
        };

        public static ServerMessage Decode(string text)
        {
            var sw = Stopwatch.StartNew();
            var m = new ServerMessage { Bytes = text.Length };
            JObject o;
            using (var reader = new JsonTextReader(new System.IO.StringReader(text)) { DateParseHandling = DateParseHandling.None, FloatParseHandling = FloatParseHandling.Double })
                o = JObject.Load(reader, LoadSettings);
            m.Raw = o;
            m.T = Str(o["t"], "");
            m.Rid = Int(o["rid"], -1);
            m.Error = o["error"]?.Type == JTokenType.String ? (string)o["error"] : null;
            switch (m.T)
            {
                case "s": m.Snapshot = DecodeSnapshot(o); break;
                case "geo": m.Geo = DecodeGeo(o); break;
                case "welcome": m.Welcome = DecodeWelcome(o); break;
            }
            m.DecodeMs = sw.Elapsed.TotalMilliseconds;
            return m;
        }

        // ------------------------------------------------------------------ helpers
        public static int Int(JToken t, int def = 0)
        {
            if (t == null) return def;
            switch (t.Type)
            {
                case JTokenType.Integer: return (int)(long)t;
                case JTokenType.Float: return (int)Math.Round((double)t);
                case JTokenType.Boolean: return (bool)t ? 1 : 0;
                case JTokenType.String:
                    return int.TryParse((string)t, NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) ? v : def;
                default: return def;
            }
        }

        public static float Float(JToken t, float def = 0f)
        {
            if (t == null) return def;
            switch (t.Type)
            {
                case JTokenType.Integer: return (long)t;
                case JTokenType.Float: return (float)(double)t;
                default: return def;
            }
        }

        public static string Str(JToken t, string def = null) =>
            t == null || t.Type == JTokenType.Null || t.Type == JTokenType.Undefined ? def : t.Type == JTokenType.String ? (string)t : t.ToString(Formatting.None);

        public static bool Bool(JToken t, bool def = false)
        {
            if (t == null) return def;
            if (t.Type == JTokenType.Boolean) return (bool)t;
            if (t.Type == JTokenType.Integer) return (long)t != 0;
            return def;
        }

        static int[] IntArray(JToken t)
        {
            if (!(t is JArray a)) return Array.Empty<int>();
            var r = new int[a.Count];
            for (int i = 0; i < a.Count; i++) r[i] = Int(a[i], -1);
            return r;
        }

        static byte[] Base64(JToken t)
        {
            var s = Str(t);
            if (string.IsNullOrEmpty(s)) return null;
            try { return Convert.FromBase64String(s); } catch (FormatException) { return null; }
        }

        public static uint ParseColor(JToken t, uint def = 0x999999)
        {
            if (t == null) return def;
            if (t.Type == JTokenType.Integer) return (uint)(long)t & 0xffffff;
            var s = Str(t);
            if (s != null && s.StartsWith("#") && uint.TryParse(s.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out uint v))
                return s.Length == 4 ? ((v >> 8 & 15) * 0x110000) | ((v >> 4 & 15) * 0x1100) | ((v & 15) * 0x11) : v & 0xffffff;
            return def;
        }

        // ------------------------------------------------------------------ snapshot
        static SnapshotMessage DecodeSnapshot(JObject o)
        {
            var s = new SnapshotMessage
            {
                Time = Float(o["time"]),
                Tick = Int(o["tick"]),
                Reset = Int(o["reset"]) != 0,
                Delta = Int(o["d"]) == 1,
            };
            if (o["units"] is JArray ua)
            {
                s.Units = new UnitWire[ua.Count];
                for (int k = 0; k < ua.Count; k++) s.Units[k] = DecodeUnit(ua[k] as JArray);
            }
            s.Gone = IntArray(o["ug"]);
            s.PathsGone = IntArray(o["pg"]);
            if (o["paths"] is JObject po)
                foreach (var p in po.Properties())
                    if (int.TryParse(p.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int id)) s.Paths[id] = IntArray(p.Value);
            if (o["tiles"] is JArray ta)
            {
                s.Tiles = new TileRecord[ta.Count];
                for (int k = 0; k < ta.Count; k++)
                {
                    var t = ta[k] as JArray;
                    if (t == null) continue;
                    s.Tiles[k] = new TileRecord
                    {
                        Index = Int(t[0], -1), Terrain = Int(t[1]), Color = Int(t[2]), Resource = Int(t[3]), Roads = Int(t[4]),
                        Flags = Int(t[5]), FlowDir = Int(t[6], -1), FlowBucket = Int(t[7]), Owner = Int(t[8], -1),
                        Stability = t.Count > 9 ? Int(t[9], -1) : -1,
                    };
                }
            }
            s.Visibility = Base64(o["vis"]);
            s.Urban = Base64(o["urban"]);
            if (o["ev"] is JArray ea)
            {
                s.Events = new CombatEvent[ea.Count];
                for (int k = 0; k < ea.Count; k++)
                {
                    var e = ea[k] as JObject;
                    if (e == null) continue;
                    s.Events[k] = new CombatEvent
                    {
                        Kind = Str(e["k"], ""), Outcome = Str(e["o"]), UnitType = Str(e["ty"]), Seq = Int(e["i"]),
                        From = Int(e["a"], -1), To = Int(e["b"], -1), Shooter = Int(e["s"], -1), Target = Int(e["t"], -1),
                        Weapon = Int(e["w"], -1), Damage = Int(e["d"]), Owner = Int(e["ow"], -1), Flight = Float(e["f"]),
                        Radius = Float(e["r"]), Airburst = Int(e["ab"]) == 1, Half = Int(e["h"]) == 1,
                    };
                }
            }
            s.Weather = o["wx"] as JObject;
            s.WeatherState = WorldRecordDecoder.Weather(s.Weather);
            s.Observer = o["obs"] as JObject;
            if (o["econ"] is JObject econ)
            {
                s.HasEcon = true;
                s.Econ = econ;
                s.Fieldworks = o["fw"];
                s.Battlefield = o["bf"] as JObject;
                s.Trenches = WorldRecordDecoder.Trenches(s.Fieldworks);
                s.BattlefieldState = WorldRecordDecoder.Battlefield(s.Battlefield);
                s.Ruins = WorldRecordDecoder.Ruins(o["ruins"]);
                if (o["buildings"] is JArray ba)
                {
                    s.Buildings = new BuildingRecord[ba.Count];
                    for (int k = 0; k < ba.Count; k++)
                    {
                        var b = ba[k] as JObject;
                        if (b == null) continue;
                        var q = b["q"] as JArray;
                        s.Buildings[k] = new BuildingRecord
                        {
                            Id = Int(b["id"]), Owner = Int(b["o"], -1), Type = Str(b["ty"], ""), Tile = Int(b["t"], -1),
                            Hp = Int(b["hp"], 100), Done = Int(b["d"]) == 1, Progress = Int(b["p"]), Active = Int(b["a"]) == 1,
                            State = Str(b["st"]), Fire = Int(b["f"]) == 1, Memory = Int(b["mem"]) == 1, Level = Int(b["lv"], 1),
                            Tier = Int(b["ti"]), Era = Int(b["ea"], -1), City = Int(b["c"], -1), QueueLength = q?.Count ?? 0, TrainProgress = Int(b["tr"]),
                            Staffed = Int(b["s"]), Why = Str(b["w"]), UpgradeCost = b["uc"] as JObject, RepairCost = Int(b["rc"]), Repeat = Str(b["rp"]),
                        };
                        if (q != null)
                        {
                            var types = new string[q.Count];
                            for (int qi = 0; qi < q.Count; qi++) types[qi] = q[qi] is JArray qa && qa.Count > 0 ? Str(qa[0], "") : "";
                            s.Buildings[k].Queue = types;
                        }
                        if (b["wk"] is JArray wk && wk.Count >= 2) { s.Buildings[k].WorksKind = Str(wk[0]) == "r" ? "repair" : "upgrade"; s.Buildings[k].WorksPct = Int(wk[1]); }
                    }
                }
                if (o["cities"] is JArray ca)
                {
                    s.Cities = new CityRecord[ca.Count];
                    for (int k = 0; k < ca.Count; k++)
                    {
                        var c = ca[k] as JObject;
                        if (c == null) continue;
                        s.Cities[k] = new CityRecord
                        {
                            Id = Int(c["id"]), Owner = Int(c["o"], -1), Name = Str(c["n"], ""), Tile = Int(c["t"], -1),
                            Pop = Float(c["pop"]), Capital = Int(c["cap"]) == 1, Radius = Int(c["r"], 2), Tier = Int(c["ti"]),
                            Housing = Int(c["h"]), Jobs = Int(c["jobs"]), Unemployed = Int(c["un"]), Stability = Int(c["st"], -1), GrowthRate = Float(c["gr"]),
                            GrowthTile = -1,
                        };
                        if (c["gz"] is JArray gz && gz.Count >= 4)
                        {
                            s.Cities[k].GrowthKind = Str(gz[0]); s.Cities[k].GrowthTile = Int(gz[1], -1); s.Cities[k].GrowthBuilt = Int(gz[2]); s.Cities[k].GrowthTarget = Int(gz[3]);
                        }
                        if (c["development"] is JObject dev)
                        {
                            s.Cities[k].MayorOn = Bool(dev["on"], true); s.Cities[k].Priority = Str(dev["priority"], "balanced"); s.Cities[k].Activity = Str(dev["activity"]);
                        }
                    }
                }
            }
            return s;
        }

        static UnitWire DecodeUnit(JArray a)
        {
            if (a == null) return new UnitWire { Id = -1 };
            int n = a.Count;
            var u = new UnitWire
            {
                Id = Int(a[0], -1), Owner = Int(a[1], -1), Type = Str(a[2], ""), Tile = Int(a[3], -1),
                Next = n > 4 ? Int(a[4], -1) : -1, Prog = n > 5 ? Float(a[5]) / 100f : 0f, Hp = n > 6 ? Int(a[6], 100) : 100,
                Supply = n > 7 ? Int(a[7]) : 0, Flags = n > 8 ? Int(a[8]) : 0,
                Target = n > 11 ? Int(a[11], 0) : 0, Morale = n > 13 ? Int(a[13], 100) : 100, Veteran = n > 14 ? Int(a[14]) : 0,
                Formation = n > 16 ? Int(a[16]) : 0, AirState = -1, AirMission = -1, AirMissionTile = -1,
            };
            if (n > 18 && a[18] is JArray air && air.Count > 0)
            {
                u.AirState = Int(air[0]);
                if (air.Count > 4) { u.AirMission = Int(air[3], -1); u.AirMissionTile = Int(air[4], -1); }
                if (air.Count > 6) u.AirRadius = Int(air[6]);
            }
            return u;
        }

        // ------------------------------------------------------------------ geo
        static GeoMessage DecodeGeo(JObject o)
        {
            var g = new GeoMessage
            {
                Full = Int(o["full"]) != 0,
                ChunkSize = Int(o["cs"], 16),
                Stride = Int(o["stride"], 6),
                W = Int(o["w"]),
                H = Int(o["h"]),
            };
            if (o["chunks"] is JArray ca)
                foreach (var c in ca)
                    if (c is JArray a && a.Count >= 4)
                        g.Chunks.Add(new GeoChunk { Cx = Int(a[0]), Cy = Int(a[1]), Mask = Base64(a[2]) ?? Array.Empty<byte>(), Data = Base64(a[3]) ?? Array.Empty<byte>() });
            return g;
        }

        // ------------------------------------------------------------------ welcome
        static WelcomeMessage DecodeWelcome(JObject o)
        {
            var defs = o["defs"] as JObject;
            var world = o["world"] as JObject;
            var w = new WelcomeMessage
            {
                Match = Str(o["match"], ""), Ruleset = Str(o["ruleset"], "legacy-v1"), Speed = Float(o["speed"], 1),
                CivId = Int(o["civId"]), Seed = Int(o["seed"]), Spectator = Bool(o["spectator"]), Sandbox = Bool(o["sandbox"]),
                Paused = Bool(o["paused"]), CanPause = Bool(o["canPause"]), Start = Int(o["start"], -1), Defs = defs,
                W = Int(defs?["W"], 128), H = Int(defs?["H"], 128), Wrap = world?["wrap"]?.Type != JTokenType.Boolean || (bool)world["wrap"],
            };
            if (o["civs"] is JArray civs)
            {
                var list = new List<CivInfo>();
                foreach (var c in civs)
                    if (c is JObject co)
                        list.Add(new CivInfo { Id = Int(co["id"]), Name = Str(co["name"], ""), Color = ParseColor(co["color"]), Human = Bool(co["human"]), Rebel = Bool(co["isRebel"]) || Bool(co["rebel"]) });
                w.Civs = list.ToArray();
            }
            return w;
        }
    }
}
