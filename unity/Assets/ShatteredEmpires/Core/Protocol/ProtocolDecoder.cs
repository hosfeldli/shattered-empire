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

        /// <summary>
        /// Perf pass 2 (GC): the decode on the network worker threads was the largest allocator in a late-match profile
        /// (about 180 KB per frame). Property names are interned per thread (every snapshot repeats the same few hundred
        /// keys) and the reader's char buffers are pooled; the parsed tree is identical. Set by -perf-legacy decode.
        /// </summary>
        public static bool LegacyDecode;
        [ThreadStatic] static InternTable names;

        /// <summary>
        /// Interns property names as they are first seen (Newtonsoft's table only looks names up). Numeric keys (unit and
        /// path ids) are left out, and the table stops growing at 4096 names, so it stays small for a whole match.
        /// </summary>
        sealed class InternTable : JsonNameTable
        {
            readonly DefaultJsonNameTable table = new DefaultJsonNameTable();
            int count;
            public override string Get(char[] key, int start, int length)
            {
                var s = table.Get(key, start, length);
                if (s != null || length == 0 || length > 40 || count >= 4096 || (key[start] >= '0' && key[start] <= '9') || key[start] == '-') return s;
                s = new string(key, start, length);
                table.Add(s);
                count++;
                return s;
            }
        }
        [ThreadStatic] static CharPool chars;

        /// <summary>A per-thread pool of the reader's char buffers (they are rented and returned within one decode).</summary>
        sealed class CharPool : IArrayPool<char>
        {
            readonly Stack<char[]> free = new Stack<char[]>();
            public char[] Rent(int minimumLength)
            {
                while (free.Count > 0) { var a = free.Pop(); if (a.Length >= minimumLength) return a; }
                return new char[Math.Max(minimumLength, 1024)];
            }
            public void Return(char[] array) { if (array != null && free.Count < 8) free.Push(array); }
        }

        public static ServerMessage Decode(string text)
        {
            var sw = Stopwatch.StartNew();
            var m = new ServerMessage { Bytes = text.Length };
            JObject o;
            using (var reader = new JsonTextReader(new System.IO.StringReader(text)) { DateParseHandling = DateParseHandling.None, FloatParseHandling = FloatParseHandling.Double })
            {
                if (!LegacyDecode) { reader.PropertyNameTable = names ??= new InternTable(); reader.ArrayPool = chars ??= new CharPool(); }
                o = JObject.Load(reader, LoadSettings);
            }
            m.Raw = o;
            m.T = Str(o["t"], "");
            m.Rid = Int(o["rid"], -1);
            m.Error = o["error"]?.Type == JTokenType.String ? (string)o["error"] : null;
            m.ErrorCode = m.Error != null && o["code"]?.Type == JTokenType.String ? (string)o["code"] : null;
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

        /// <summary>A JSON array of numbers as floats, or null when absent.</summary>
        public static float[] Floats(JToken t)
        {
            if (!(t is JArray a)) return null;
            var r = new float[a.Count];
            for (int i = 0; i < r.Length; i++) r[i] = Float(a[i]);
            return r;
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

        /// <summary>
        /// The upgrade line of a <c>defs.TECHS</c> entry (2026-11-18, docs/gameplay-overhaul/UPGRADES.md): "infantry",
        /// "vehicle" or "air" — one upgrade per line per player per match — or null for an unrestricted upgrade.
        /// </summary>
        public static string UpgradeLine(JToken techDef)
        {
            string line = Str(techDef?["line"]);
            return string.IsNullOrEmpty(line) ? null : line;
        }

        /// <summary>"Infantry", "Vehicle", "Air" (an unknown line is capitalised as sent).</summary>
        public static string UpgradeLineName(string line) => line switch
        {
            "infantry" => "Infantry", "vehicle" => "Vehicle", "air" => "Air",
            null => null, "" => null,
            _ => char.ToUpperInvariant(line[0]) + line.Substring(1),
        };

        static BaseParcel[] BaseParcels(JToken t)
        {
            if (!(t is JArray a)) return Array.Empty<BaseParcel>();
            var records = new List<BaseParcel>();
            foreach (var token in a) if (token is JArray p && p.Count >= 4)
                records.Add(new BaseParcel { Tile = Int(p[0], -1), X = Float(p[1]), Z = Float(p[2]), Yaw = Float(p[3]),
                    Id = p.Count > 4 ? Int(p[4]) : 0, Tier = p.Count > 5 ? Int(p[5], 1) : 1,
                    Width = p.Count > 6 ? Float(p[6]) : .94f, Depth = p.Count > 7 ? Float(p[7]) : .88f,
                    PreviousType = p.Count > 8 ? Str(p[8]) : null });
            return records.ToArray();
        }

        /// <summary>W1 <c>qs: [[unit, count, priority, progressPct, state, repeat01], ...]</c> (PRODUCTION_SCHEDULER.md).</summary>
        static ProductionQueue[] ProductionQueues(JArray a)
        {
            var r = new ProductionQueue[a.Count];
            int n = 0;
            foreach (var token in a)
            {
                if (!(token is JArray e) || e.Count < 2) continue;
                r[n++] = new ProductionQueue
                {
                    Unit = Str(e[0], ""), Count = Int(e[1]), Priority = e.Count > 2 ? Int(e[2], 1) : 1,
                    Progress = e.Count > 3 ? Float(e[3]) : 0f, State = e.Count > 4 ? StateName(Str(e[4])) : null, Repeat = e.Count > 5 && Int(e[5]) != 0,
                };
            }
            if (n < r.Length) Array.Resize(ref r, n);
            return r;
        }

        /// <summary>The known queue states as interned constants (the UI compares them by reference-equal strings).</summary>
        static string StateName(string s) => s switch
        {
            "producing" => "producing", "resources" => "resources", "capacity" => "capacity", "prerequisites" => "prerequisites",
            "exit" => "exit", "paused" => "paused", "waiting" => "waiting", "idle" => "idle", _ => s,
        };

        /// <summary>Older servers: the flattened FIFO <c>q</c> grouped by unit type in first-seen order; the head item carries <c>tr</c>.</summary>
        static ProductionQueue[] LegacyQueues(string[] flat, float headProgress, string repeat)
        {
            var list = new List<ProductionQueue>(4);
            for (int i = 0; i < flat.Length; i++)
            {
                string unit = flat[i];
                int at = -1;
                for (int k = 0; k < list.Count; k++) if (list[k].Unit == unit) { at = k; break; }
                if (at < 0) list.Add(new ProductionQueue { Unit = unit, Count = 1, Priority = 1, Progress = i == 0 ? headProgress : 0f, Repeat = unit == repeat });
                else { var e = list[at]; e.Count++; list[at] = e; }
            }
            return list.ToArray();
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
            s.WorldPathsGone = IntArray(o["wpg"]);
            if (o["wp"] is JObject worldPaths)
                foreach (var path in worldPaths.Properties())
                {
                    if (!int.TryParse(path.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int id) || !(path.Value is JArray points)) continue;
                    var route = new List<WorldPoint>(points.Count);
                    foreach (var point in points)
                        if (point is JArray p && p.Count >= 2) route.Add(new WorldPoint(Float(p[0]), Float(p[1])));
                    s.WorldPaths[id] = route.ToArray();
                }
            if (o["sites"] is JArray sites)
            {
                var records = new List<ObjectiveSite>(sites.Count);
                foreach (var site in sites)
                    if (site is JObject st) records.Add(new ObjectiveSite
                    {
                        Id = Int(st["id"]), Tile = Int(st["tile"], -1), Owner = Int(st["owner"], -1), Capturing = Int(st["by"], -1),
                        Headquarters = Int(st["hq"]), Tier = Int(st["tier"], 1), Capacity = Int(st["capacity"]), DefenseCount = Int(st["defenseCount"]), DefenseLevel = Int(st["defenseLevel"]),
                        X = Float(st["x"]), Z = Float(st["z"]), Radius = Float(st["radius"]), Capture = Float(st["capture"]), Build = Float(st["build"]),
                        IsBase = Bool(st["base"]), Contested = Bool(st["contested"]), Decaying = Bool(st["decaying"]), Operational = Bool(st["operational"]),
                        Memory = Bool(st["memory"]), Starting = Bool(st["starting"]), Name = Str(st["name"], ""), Kind = Str(st["kind"], ""),
                        Slots = IntArray(st["slots"]),
                        Parcels = BaseParcels(st["parcels"]),
                        RingVersion = Int(st["ringVersion"]), DevelopedAt = Float(st["developedAt"]), Tenure = Float(st["tenure"]), Maturity = Float(st["maturity"]), VisualTier = Int(st["visualTier"], 1),
                        SettleMaterials = Int(st["settle"]?["materials"]), SettleEnergy = Int(st["settle"]?["energy"]), SettleRoad = Int(st["settle"]?["road"]),
                        SettleTo = Str(st["settle"]?["to"], ""),
                    });
                s.Objectives = records.ToArray();
            }
            if (o["pickups"] is JArray pickups)
            {
                var records = new List<ResourcePickup>(pickups.Count);
                foreach (var item in pickups) if (item is JObject p) records.Add(new ResourcePickup { Id = Int(p["id"]), Tile = Int(p["tile"], -1),
                    X = Float(p["x"]), Z = Float(p["z"]), Amount = Int(p["amount"]), Resource = Str(p["resource"], "materials"), Memory = Bool(p["memory"]), Replenishes = Bool(p["replenishes"]) });
                s.Pickups = records.ToArray();
            }
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
                        HasOrigin = e["ax"] != null && e["az"] != null, HasDestination = e["bx"] != null && e["bz"] != null,
                        Origin = new WorldPoint(Float(e["ax"]), Float(e["az"])), Destination = new WorldPoint(Float(e["bx"]), Float(e["bz"])),
                        Amount = Int(e["amount"]), Resource = Str(e["resource"]),
                        Altitude = Float(e["y"]), Bursts = Floats(e["p"]),
                        Grenade = Int(e["gr"]) == 1, Rocket = Int(e["rk"]) == 1, Marksman = Int(e["mk"]) == 1, Armoured = Int(e["ar"]) == 1,
                        BurstRound = Int(e["bu"]), Tow = Int(e["tw"]) == 1,
                    };
                }
            }
            s.Weather = o["wx"] as JObject;
            s.WeatherState = WorldRecordDecoder.Weather(s.Weather);
            s.Observer = o["obs"] as JObject;
            s.ActionPlan = o["actionPlan"] as JObject;
            s.Res = o["res"];
            if (o["econ"] is JObject econ)
            {
                s.HasEcon = true;
                s.Econ = econ;
                s.Fieldworks = o["fw"];
                s.Battlefield = o["bf"] as JObject;
                s.Trenches = WorldRecordDecoder.Trenches(s.Fieldworks);
                if (s.Trenches != null && o["trenchWorld"] is JArray trenchWorld)
                {
                    var trenchIndex = new Dictionary<int, int>();
                    for (int i = 0; i < s.Trenches.Length; i++) trenchIndex[s.Trenches[i].Tile] = i;
                    foreach (var token in trenchWorld)
                        if (token is JArray p && p.Count >= 4 && trenchIndex.TryGetValue(Int(p[0]), out int index))
                        {
                            s.Trenches[index].HasPosition = true;
                            s.Trenches[index].X = Float(p[1]); s.Trenches[index].Z = Float(p[2]); s.Trenches[index].Facing = Float(p[3]);
                            s.Trenches[index].RoadMask = p.Count > 4 ? Int(p[4]) : 0;
                        }
                }
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
                            HasPosition = b["px"] != null && b["pz"] != null, X = Float(b["px"]), Z = Float(b["pz"]), HasYaw = b["yaw"] != null, Yaw = Float(b["yaw"]),
                            Missiles = Int(b["mi"]), Slot = Int(b["slot"]), RallyGroup = Int(b["rg"]), Project = Str(b["project"]),
                        };
                        if (q != null)
                        {
                            var types = new string[q.Count];
                            for (int qi = 0; qi < q.Count; qi++) types[qi] = q[qi] is JArray qa && qa.Count > 0 ? Str(qa[0], "") : "";
                            s.Buildings[k].Queue = types;
                        }
                        // W1 production scheduler: per-type queues and the shared capacity (legacy q/tr/rp for older servers)
                        s.Buildings[k].ProductionCapacity = Float(b["cap"]);
                        if (b["qs"] is JArray qs) { s.Buildings[k].Queues = ProductionQueues(qs); s.Buildings[k].QueuesFromServer = true; }
                        else if (q != null && q.Count > 0) s.Buildings[k].Queues = LegacyQueues(s.Buildings[k].Queue, Float(b["tr"]), s.Buildings[k].Repeat);
                        // W4 garrison: occupants and the exit rally point
                        if (b["gar"] is JArray gar && gar.Count > 0) s.Buildings[k].Garrison = IntArray(gar);
                        if (b["ge"] is JArray ge && ge.Count >= 2) { s.Buildings[k].HasGarrisonExit = true; s.Buildings[k].GarrisonExitX = Float(ge[0]); s.Buildings[k].GarrisonExitZ = Float(ge[1]); }
                        if (b["ra"] is JArray ra && ra.Count >= 2) { s.Buildings[k].HasRally = true; s.Buildings[k].RallyX = Float(ra[0]); s.Buildings[k].RallyZ = Float(ra[1]); s.Buildings[k].RallyAttackMove = ra.Count < 3 || Int(ra[2], 1) != 0; }
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
                Formation = n > 16 ? Int(a[16]) : 0, AirState = -1, AirMission = -1, AirMissionTile = -1, Fuel = -1,
                // action ruleset: index 10 is the stance code (0 aggressive, 1 defensive, 2 holdFire) for every visible unit; -1 when absent
                Stance = n > 10 && a[10] != null && a[10].Type == JTokenType.Integer ? Int(a[10], -1) : -1,
            };
            if (n > 18 && a[18] is JArray air && air.Count > 0)
            {
                u.AirState = Int(air[0]);
                if (air.Count > 4) { u.AirMission = Int(air[3], -1); u.AirMissionTile = Int(air[4], -1); }
                if (air.Count > 6) u.AirRadius = Int(air[6]);
                u.Fuel = air.Count > 1 ? Int(air[1], -1) : -1;
            }
            if (n > 20 && a[20] is JArray p && p.Count >= 5) u.Motion = new WorldMotion
            {
                Present = true, X = Float(p[0]), Z = Float(p[1]), Yaw = Float(p[2]), Vx = Float(p[3]), Vz = Float(p[4]),
                Cooldown = p.Count > 5 ? Float(p[5]) : 0,
                Altitude = p.Count > 6 ? Float(p[6]) : 0,
                Equipment = p.Count > 7 ? Int(p[7]) : 0,
                Men = p.Count > 8 ? Int(p[8], -1) : -1,
            };
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
                Dense = world?["dense"]?.Type == JTokenType.String ? Base64(world["dense"]) : null,
            };
            if (o["civs"] is JArray civs)
            {
                var list = new List<CivInfo>();
                foreach (var c in civs)
                    if (c is JObject co)
                        list.Add(new CivInfo { Id = Int(co["id"]), Team = Int(co["team"], -1), Name = Str(co["name"], ""), Color = ParseColor(co["color"]), Human = Bool(co["human"]), Rebel = Bool(co["isRebel"]) || Bool(co["rebel"]) });
                w.Civs = list.ToArray();
            }
            return w;
        }
    }
}
