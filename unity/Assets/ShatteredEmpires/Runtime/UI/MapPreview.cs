using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// One hand-authored map from the server's catalog (server/sim/mapCatalog.js mapList: GET /api/maps, the
    /// 'hello' reply's maps, or a 'maps' request): what the menus need to offer, filter and preview it.
    /// </summary>
    public sealed class MapCatalogEntry
    {
        public string Id = "", Name = "", Description = "";
        /// <summary>Seats on the map and seats per team (1 for a free-for-all map); Size in tiles (0: unknown).</summary>
        public int Players = 2, TeamSize = 1, Size;
        /// <summary>The top-down preview grid, or null when the server sends none.</summary>
        public MapPreviewData Preview;

        public int Teams => Mathf.Max(2, Players / Mathf.Max(1, TeamSize));
        /// <summary>The lobby format id this map was drawn for ("2v2", "ffa4").</summary>
        public string Format => MapPreview.FormatId(TeamSize, Teams);
        /// <summary>
        /// Whether a match with this many seats can play here (maps wave 3): any format up to the map's starts.
        /// The server seats the players on sensible starts and leaves the spare ones as neutral ruins.
        /// </summary>
        public bool Fits(int seats) => seats <= 0 || (seats >= 2 && seats <= Players);

        /// <summary>Parse one catalog entry; null for "random" or anything unusable.</summary>
        public static MapCatalogEntry Parse(JToken token)
        {
            if (!(token is JObject o)) return null;
            string id = MapPreview.Str(o["id"]);
            if (string.IsNullOrEmpty(id) || id == "random") return null;
            int team = MapPreview.Int(o["teamSize"], 0);
            int players = MapPreview.Int(o["players"], 0);
            if (players <= 0 && team > 0) players = team * 2;
            if (team <= 0 && players > 0) team = 1;
            if (team < 1 || players < 2) return null;
            var e = new MapCatalogEntry
            {
                Id = id,
                Name = MapPreview.Str(o["name"], id),
                Description = MapPreview.Str(o["description"]),
                Players = players,
                TeamSize = team,
                Size = MapPreview.Int(o["size"], 0),
            };
            try { e.Preview = MapPreviewData.Parse(o["preview"], e); }
            catch (Exception ex) { Debug.LogWarning($"Map {id}: unreadable preview ({ex.Message})"); e.Preview = null; }
            return e;
        }
    }

    /// <summary>A marker on the preview (start position, base site or outpost) in normalised 0..1 coordinates, v down.</summary>
    public struct MapMarker
    {
        public float U, V;
        /// <summary>The team (starts) or -1 (neutral).</summary>
        public int Team;
    }

    /// <summary>
    /// The catalog's preview grid (workstream E, 2026-11-16): a small top-down grid of terrain classes plus
    /// start positions, bases and outposts. The parser is deliberately tolerant so the menu degrades to a
    /// plain card instead of failing:
    /// <list type="bullet">
    /// <item>size: <c>w</c>/<c>h</c>, <c>width</c>/<c>height</c>, or <c>size</c> (square);</item>
    /// <item>cells (<c>cells</c>, <c>grid</c>, <c>terrain</c>, <c>data</c> or <c>classes</c>): a base64 byte string, a hex string, one
    /// character per cell (a string, or an array of row strings), or an array of numbers; row 0 is the north edge;</item>
    /// <item><c>legend</c>: class names by value (an array, or an object value/char → name); without it a default
    /// numbering (0 water, 1 plains, 2 forest, 3 hills, 4 mountains, 5 river, 6 marsh, 7 road, 8 peaks) and a
    /// default character set are assumed;</item>
    /// <item><c>starts</c>, <c>bases</c>/<c>sites</c>, <c>outposts</c>: [u, v] pairs or objects ({u, v} / {x, y} / {x, z} / {at: [u, v]},
    /// optional team/seat/start), normalised 0..1 or in grid cells.</item>
    /// </list>
    /// </summary>
    public sealed class MapPreviewData
    {
        public int W, H;
        /// <summary>Drawn width / height (the hex world is √3 : 1.5 wider than tall: 1.1547).</summary>
        public float Aspect = 1f;
        /// <summary>Row-major colours (row 0 = north), already resolved from the terrain classes.</summary>
        public Color32[] Colors;
        public readonly List<MapMarker> Starts = new List<MapMarker>(), Bases = new List<MapMarker>(), Outposts = new List<MapMarker>();
        /// <summary>
        /// Seating metrics of the starts (server actionMap.startMetrics, in preview order): ground steps between
        /// starts and the mean steps from each to its three nearest neutral bases. Null on an older server.
        /// </summary>
        public double[,] StartSteps;
        public double[] StartReach;
        /// <summary>
        /// A map-builder sketch's team ownership of its bases (preview order; team index, -1 neutral), or null for
        /// automatic seating (2026-11-18, MAP_BUILDER_TEAMS.md: server sketchMaps.ownedStarts).
        /// </summary>
        public int[] StartOwners;

        public static MapPreviewData Parse(JToken token, MapCatalogEntry map)
        {
            if (!(token is JObject o)) return null;
            int w = MapPreview.Int(o["w"] ?? o["width"] ?? o["size"] ?? o["cols"], 0);
            int h = MapPreview.Int(o["h"] ?? o["height"] ?? o["rows"], w);
            JToken cells = o["cells"] ?? o["grid"] ?? o["terrain"] ?? o["data"] ?? (o["classes"] is JArray ca && ca.Count > 0 && ca[0].Type != JTokenType.String ? ca : null);
            if (w <= 0 && cells is JArray rowsGuess && rowsGuess.Count > 0 && rowsGuess[0].Type == JTokenType.String)
            {
                h = rowsGuess.Count;
                w = ((string)rowsGuess[0])?.Length ?? 0;
            }
            if (w <= 0 || h <= 0 || w > 512 || h > 512 || cells == null) return null;
            var p = new MapPreviewData { W = w, H = h, Colors = new Color32[w * h] };
            float aspect = MapPreview.Float(o["aspect"]);
            p.Aspect = aspect > 0.2f && aspect < 5f ? aspect : 1f;
            // E's format (actionMap.js mapPreview): "classes" names the class of each byte value
            var legend = Legend(o["legend"] ?? (o["classes"] is JArray cn && cn.Count > 0 && cn[0].Type == JTokenType.String ? cn : null));
            if (!p.Fill(cells, legend, o["encoding"])) return null;
            int ts = Mathf.Max(1, map?.TeamSize ?? 1);
            Markers(o["starts"], p, map, p.Starts, ts);
            Markers(o["bases"] ?? o["sites"], p, map, p.Bases, 0);
            Markers(o["outposts"], p, map, p.Outposts, 0);
            p.Metrics(o["startSteps"] as JArray, o["startReach"] as JArray);
            if (o["startOwners"] is JArray owners && owners.Count == p.Starts.Count)
            {
                p.StartOwners = new int[owners.Count];
                for (int i = 0; i < owners.Count; i++) p.StartOwners[i] = MapPreview.Int(owners[i], -1);
            }
            return p;
        }

        void Metrics(JArray steps, JArray reach)
        {
            int n = Starts.Count;
            if (steps == null || reach == null || n < 2 || steps.Count != n || reach.Count != n) return;
            var d = new double[n, n];
            var r = new double[n];
            for (int i = 0; i < n; i++)
            {
                if (!(steps[i] is JArray row) || row.Count != n) return;
                for (int j = 0; j < n; j++)
                {
                    if (row[j].Type != JTokenType.Integer && row[j].Type != JTokenType.Float) return;
                    d[i, j] = (double)row[j];
                }
                if (reach[i].Type != JTokenType.Integer && reach[i].Type != JTokenType.Float) return;
                r[i] = (double)reach[i];
            }
            StartSteps = d; StartReach = r;
        }

        // value or character → class name (null: use the defaults)
        static Dictionary<string, string> Legend(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null) return null;
            var d = new Dictionary<string, string>();
            if (token is JArray arr)
                for (int i = 0; i < arr.Count; i++)
                {
                    var t = arr[i];
                    string name = t is JObject lo ? MapPreview.Str(lo["name"] ?? lo["class"] ?? lo["id"]) : MapPreview.Str(t);
                    if (!string.IsNullOrEmpty(name)) d[i.ToString()] = name;
                }
            else if (token is JObject obj)
                foreach (var kv in obj)
                {
                    // { "0": "water" } or { "water": 0 }
                    if (kv.Value.Type == JTokenType.Integer) d[((int)kv.Value).ToString()] = kv.Key;
                    else d[kv.Key] = MapPreview.Str(kv.Value);
                }
            return d.Count > 0 ? d : null;
        }

        bool Fill(JToken cells, Dictionary<string, string> legend, JToken encoding)
        {
            int n = W * H;
            if (cells is JArray arr)
            {
                if (arr.Count == H && arr[0].Type == JTokenType.String)
                {
                    var sb = new System.Text.StringBuilder(n);
                    foreach (var row in arr) sb.Append(((string)row ?? "").PadRight(W).Substring(0, W));
                    return FillChars(sb.ToString(), legend);
                }
                if (arr.Count == H && arr[0] is JArray)
                {
                    int k = 0;
                    foreach (var row in arr) for (int x = 0; x < W; x++) Colors[k++] = ColorOf(x < ((JArray)row).Count ? MapPreview.Int(((JArray)row)[x], 0) : 0, legend);
                    return true;
                }
                if (arr.Count < n) return false;
                for (int i = 0; i < n; i++) Colors[i] = ColorOf(MapPreview.Int(arr[i], 0), legend);
                return true;
            }
            string s = MapPreview.Str(cells);
            if (string.IsNullOrEmpty(s)) return false;
            string enc = MapPreview.Str(encoding).ToLowerInvariant();
            if (enc != "base64" && enc != "hex" && s.Length == n) return FillChars(s, legend);
            if (enc == "hex" || enc != "base64" && s.Length == n * 2 && IsHex(s))
            {
                for (int i = 0; i < n; i++) Colors[i] = ColorOf(Convert.ToInt32(s.Substring(i * 2, 2), 16), legend);
                return true;
            }
            byte[] bytes;
            try { bytes = Convert.FromBase64String(s); }
            catch (FormatException) { return false; }
            if (bytes.Length < n) return false;
            for (int i = 0; i < n; i++) Colors[i] = ColorOf(bytes[i], legend);
            return true;
        }

        static bool IsHex(string s)
        {
            foreach (char c in s) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F')) return false;
            return true;
        }

        bool FillChars(string s, Dictionary<string, string> legend)
        {
            for (int i = 0; i < W * H; i++)
            {
                char c = s[i];
                string name = null;
                if (legend != null) legend.TryGetValue(c.ToString(), out name);
                if (name == null && c >= '0' && c <= '9') { Colors[i] = ColorOf(c - '0', legend); continue; }
                Colors[i] = MapPreview.ClassColor(name ?? MapPreview.CharClass(c));
            }
            return true;
        }

        static Color32 ColorOf(int value, Dictionary<string, string> legend)
        {
            if (legend != null && legend.TryGetValue(value.ToString(), out var name)) return MapPreview.ClassColor(name);
            return MapPreview.ClassColor(MapPreview.DefaultClass(value));
        }

        static void Markers(JToken token, MapPreviewData p, MapCatalogEntry map, List<MapMarker> into, int teamSize)
        {
            if (!(token is JArray arr)) return;
            for (int i = 0; i < arr.Count; i++)
            {
                var t = arr[i];
                float u, v;
                int team = -1, seat = i;
                if (t is JArray pair && pair.Count >= 2) { u = MapPreview.Float(pair[0]); v = MapPreview.Float(pair[1]); }
                else if (t is JObject o)
                {
                    JToken at = o["at"] ?? o["pos"];
                    if (at is JArray ap && ap.Count >= 2) { u = MapPreview.Float(ap[0]); v = MapPreview.Float(ap[1]); }
                    else
                    {
                        u = MapPreview.Float(o["u"] ?? o["x"]);
                        v = MapPreview.Float(o["v"] ?? o["y"] ?? o["z"]);
                    }
                    team = MapPreview.Int(o["team"], -1);
                    seat = MapPreview.Int(o["seat"] ?? o["start"] ?? o["civ"], i);
                }
                else continue;
                // grid cells (or world units) rather than 0..1
                if (u > 1.001f || v > 1.001f)
                {
                    float sx = map != null && map.Size > p.W && (u > p.W || v > p.H) ? map.Size : p.W;
                    float sy = map != null && map.Size > p.H && (u > p.W || v > p.H) ? map.Size : p.H;
                    u /= sx; v /= sy;
                }
                if (team < 0 && teamSize > 0) team = seat / teamSize;
                into.Add(new MapMarker { U = Mathf.Clamp01(u), V = Mathf.Clamp01(v), Team = team });
            }
        }
    }

    public static class MapPreview
    {
        /// <summary>Lobby format id: "NvN" for two teams, "ffaN" for one-seat teams.</summary>
        public static string FormatId(int teamSize, int teams) => teamSize > 1 || teams == 2 ? $"{teamSize}v{teamSize}" : $"ffa{teams}";
        /// <summary>"2v2", "FFA 4" (1v1v1v1 reads worse at a glance).</summary>
        public static string FormatLabel(string format)
        {
            if (string.IsNullOrEmpty(format)) return "";
            return format.StartsWith("ffa", StringComparison.Ordinal) ? "FFA " + format.Substring(3) : format;
        }
        /// <summary>Seats of a format id (0: unknown).</summary>
        public static int Seats(string format)
        {
            if (string.IsNullOrEmpty(format)) return 0;
            if (format.StartsWith("ffa", StringComparison.Ordinal)) return int.TryParse(format.Substring(3), out int n) ? n : 0;
            int v = format.IndexOf('v');
            return v > 0 && int.TryParse(format.Substring(0, v), out int ts) ? ts * 2 : 0;
        }
        public static int TeamSizeOf(string format)
        {
            if (string.IsNullOrEmpty(format) || format.StartsWith("ffa", StringComparison.Ordinal)) return 1;
            int v = format.IndexOf('v');
            return v > 0 && int.TryParse(format.Substring(0, v), out int ts) ? Mathf.Max(1, ts) : 1;
        }

        // team colours: blue (team 1), red (team 2) as in the HUD mockup, then distinct FFA colours
        static readonly Color32[] TeamColors =
        {
            new Color32(74, 150, 255, 255), new Color32(232, 96, 76, 255), new Color32(236, 196, 72, 255),
            new Color32(96, 196, 120, 255), new Color32(176, 120, 230, 255), new Color32(80, 210, 210, 255),
        };
        public static Color32 TeamColor(int team) => team < 0 ? new Color32(220, 214, 196, 255) : TeamColors[team % TeamColors.Length];

        internal static string DefaultClass(int value)
        {
            switch (value)
            {
                case 0: return "water";
                case 1: return "plains";
                case 2: return "forest";
                case 3: return "hills";
                case 4: return "mountains";
                case 5: return "river";
                case 6: return "marsh";
                case 7: return "road";
                case 8: return "peak";
                case 9: return "shallows";
                default: return "plains";
            }
        }

        internal static string CharClass(char c)
        {
            switch (c)
            {
                case '~': case 'w': case 'W': case 'o': case 'O': return "water";
                case '-': case 's': return "shallows";
                case 'r': case 'R': return "river";
                case 'f': case 'F': case 'T': case 't': return "forest";
                case 'h': case 'H': case 'n': return "hills";
                case 'm': case 'M': case '^': return "mountains";
                case 'A': case 'P': case '*': return "peak";
                case 'x': case 'X': case '%': return "marsh";
                case '=': case '#': case '+': return "road";
                case 'b': case 'B': return "bridge";
                case 'c': case 'C': return "city";
                case 'd': case 'D': return "sand";
                default: return "plains";
            }
        }

        /// <summary>A muted, map-like colour for a terrain class name (matches the HUD mockup's palette).</summary>
        public static Color32 ClassColor(string name)
        {
            string n = (name ?? "").ToLowerInvariant();
            if (n.Contains("deep") || n.Contains("sea") || n.Contains("ocean") || n == "water" || n.Contains("lake")) return new Color32(52, 82, 98, 255);
            if (n.Contains("shallow") || n.Contains("coast") || n.Contains("ford")) return new Color32(78, 112, 122, 255);
            if (n.Contains("river") || n.Contains("water")) return new Color32(64, 104, 128, 255);
            if (n.Contains("bridge")) return new Color32(176, 160, 128, 255);
            if (n.Contains("road")) return new Color32(150, 138, 108, 255);
            if (n.Contains("peak") || n.Contains("impass") || n.Contains("snow")) return new Color32(176, 172, 164, 255);
            if (n.Contains("mount") || n.Contains("cliff")) return new Color32(118, 108, 92, 255);
            if (n.Contains("hill") || n.Contains("rough")) return new Color32(122, 128, 88, 255);
            if (n.Contains("forest") || n.Contains("wood") || n.Contains("tree")) return new Color32(66, 92, 58, 255);
            if (n.Contains("marsh") || n.Contains("swamp") || n.Contains("wet")) return new Color32(84, 106, 88, 255);
            if (n.Contains("sand") || n.Contains("beach") || n.Contains("desert")) return new Color32(172, 160, 118, 255);
            if (n.Contains("city") || n.Contains("ruin") || n.Contains("base") || n.Contains("urban")) return new Color32(190, 184, 166, 255);
            if (n.Contains("crater") || n.Contains("scar") || n.Contains("waste") || n.Contains("mud")) return new Color32(98, 92, 74, 255);
            return new Color32(108, 122, 82, 255);   // plains / grass / land
        }

        static readonly Dictionary<string, Texture2D> cache = new Dictionary<string, Texture2D>();

        // statics survive between play sessions when domain reload is off
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() { cache.Clear(); cacheOrder.Clear(); }

        // memory pass 8: every seat layout, team split and edited sketch made a new texture that was never freed. The
        // cache now keeps the newest CacheCap previews; the oldest go (a page asks again whenever it redraws).
        const int CacheCap = 128;
        static readonly Queue<string> cacheOrder = new Queue<string>();
        static void Store(string key, Texture2D tex)
        {
            if (!cache.ContainsKey(key)) cacheOrder.Enqueue(key);
            cache[key] = tex;
            while (cache.Count > CacheCap && cacheOrder.Count > 0)
            {
                string old = cacheOrder.Dequeue();
                if (old == key || !cache.TryGetValue(old, out var gone)) continue;
                cache.Remove(old);
                if (gone != null) UnityEngine.Object.Destroy(gone);
            }
        }

        /// <summary>The preview texture of a map (cached per map and grid), or null without a preview.</summary>
        public static Texture2D Texture(MapCatalogEntry map)
        {
            var p = map?.Preview;
            if (p == null || p.Colors == null) return null;
            string key = map.Id + ":" + p.W + "x" + p.H + ":" + p.Starts.Count + ":" + p.Colors.Length + ":" + Hash(p);
            if (cache.TryGetValue(key, out var tex) && tex != null) return tex;
            tex = Render(p);
            Store(key, tex);
            return tex;
        }

        /// <summary>
        /// The preview of a map as a match with <paramref name="seats"/> seats (teams of <paramref name="teamSize"/>,
        /// <paramref name="closedMask"/> a bit per seat left empty) will play it: the starts the civs take in their
        /// team colours, chosen exactly as the server does (<see cref="SeatStarts"/>), and the spare starts as
        /// hollow neutral rings (they stay neutral city ruins). Without seats, or as drawn, the designed preview.
        /// </summary>
        public static Texture2D Texture(MapCatalogEntry map, int seats, int teamSize, ulong closedMask)
        {
            var p = map?.Preview;
            if (p == null || p.Colors == null) return null;
            int P = p.Starts.Count;
            if (seats <= 0 || seats > P || P < 2) return Texture(map);
            teamSize = Mathf.Max(1, teamSize);
            // the server's seating (matches.js dropClosed / catalogTeams): closed seats leave, teams renumber in order
            var colourTeam = new List<int>();
            var order = new List<int>();
            var teams = new List<int>();
            for (int s = 0; s < seats && s < 64; s++)
            {
                if ((closedMask & (1UL << s)) != 0) continue;
                int team = s / teamSize;
                if (!order.Contains(team)) order.Add(team);
                colourTeam.Add(team);
                teams.Add(order.IndexOf(team));
            }
            if (teams.Count < 2) return Texture(map);
            // team-owned bases (a map-builder sketch): each lobby team on its own bases, in base order
            var civStart = p.StartOwners != null ? OwnedStarts(p.StartOwners, colourTeam) : SeatStarts(p, teams.ToArray(), map.TeamSize);
            if (civStart != null && teams.Count == P && p.StartOwners == null)
            {
                bool designed = true;
                for (int c = 0; c < civStart.Length && designed; c++) designed = civStart[c] == c && colourTeam[c] == p.Starts[c].Team;
                if (designed) return Texture(map);
            }
            string key = map.Id + ":" + p.W + "x" + p.H + ":" + P + ":" + p.Colors.Length + ":" + Hash(p) + ":seated:" + string.Join(",", teams) + ":" + string.Join(",", colourTeam)
                + (p.StartOwners != null ? ":owners:" + string.Join(",", p.StartOwners) : "");
            if (cache.TryGetValue(key, out var tex) && tex != null) return tex;
            var seated = new int[P];
            for (int i = 0; i < P; i++) seated[i] = -2;   // spare (all of them when the preview has no seating metrics)
            if (civStart != null) for (int c = 0; c < civStart.Length; c++) if (civStart[c] >= 0) seated[civStart[c]] = colourTeam[c];
            tex = Render(p, seated);
            Store(key, tex);
            return tex;
        }

        /// <summary>
        /// Which base each civ takes when the sketch assigns bases to teams (server sketchMaps.ownedStarts): the k-th
        /// civ of a team on that team's k-th base; -1 for a civ its team has no base left for (the start is refused).
        /// </summary>
        public static int[] OwnedStarts(int[] owners, IList<int> teams)
        {
            var result = new int[teams.Count];
            var next = new Dictionary<int, int>();
            for (int c = 0; c < teams.Count; c++)
            {
                next.TryGetValue(teams[c], out int from);
                int b = -1;
                for (int i = from; i < owners.Length; i++) if (owners[i] == teams[c]) { b = i; break; }
                result[c] = b;
                if (b >= 0) next[teams[c]] = b + 1;
                else next[teams[c]] = owners.Length;
            }
            return result;
        }

        /// <summary>
        /// Which start (preview order) each civ takes, exactly as the server's actionMap.chooseStarts: the
        /// designed seating when the teams fill every start as drawn, otherwise the best-scoring assignment
        /// (rivals on opposite sides and far apart, allies close, every civ's distances and reach alike).
        /// Null when the preview has no seating metrics (an older server).
        /// </summary>
        public static int[] SeatStarts(MapPreviewData p, int[] teams, int designedTeamSize)
        {
            int P = p?.Starts.Count ?? 0, C = teams?.Length ?? 0;
            if (C < 1 || C > P) return null;
            var sides = new int[P];
            for (int i = 0; i < P; i++) sides[i] = i / Mathf.Max(1, designedTeamSize);
            bool designed = C == P;
            for (int a = 0; a < C && designed; a++)
                for (int b = 0; b < C && designed; b++) designed = (teams[a] == teams[b]) == (sides[a] == sides[b]);
            if (designed) { var id = new int[C]; for (int i = 0; i < C; i++) id[i] = i; return id; }
            if (p.StartSteps == null || p.StartReach == null) return null;
            var D = p.StartSteps;
            double sum = 0; int pairs = 0;
            for (int i = 0; i < P; i++) for (int j = i + 1; j < P; j++) if (D[i, j] < 1e4) { sum += D[i, j]; pairs++; }
            double unit = pairs > 0 ? sum / pairs : 1;
            var reach = new double[P];
            for (int i = 0; i < P; i++) reach[i] = p.StartReach[i] / unit;
            bool teamSided = new HashSet<int>(sides).Count < P;
            var pick = new int[C];
            var used = new bool[P];
            var near = new double[C];
            int[] best = null;
            double bestScore = double.PositiveInfinity;
            double Score()
            {
                int side = 0, allies = 0; double close = 0;
                for (int a = 0; a < C; a++) near[a] = double.PositiveInfinity;
                for (int a = 0; a < C; a++)
                    for (int b = a + 1; b < C; b++)
                    {
                        double d = D[pick[a], pick[b]] / unit;
                        bool ally = teams[a] == teams[b];
                        if (ally) { close += d; allies++; }
                        else { near[a] = Math.Min(near[a], d); near[b] = Math.Min(near[b], d); }
                        if (teamSided && ally != (sides[pick[a]] == sides[pick[b]])) side++;
                    }
                double eMax = double.NegativeInfinity, eMin = double.PositiveInfinity; int eCount = 0;
                for (int a = 0; a < C; a++) if (!double.IsInfinity(near[a])) { eCount++; eMax = Math.Max(eMax, near[a]); eMin = Math.Min(eMin, near[a]); }
                double rMax = double.NegativeInfinity, rMin = double.PositiveInfinity;
                for (int a = 0; a < C; a++) { rMax = Math.Max(rMax, reach[pick[a]]); rMin = Math.Min(rMin, reach[pick[a]]); }
                double spreadE = eCount > 0 ? eMax - eMin : 0, spreadR = rMax - rMin;
                return side * 4 + spreadE * 3 + spreadR * 3 + (allies > 0 ? close / allies : 0) - (eCount > 0 ? eMin : 0) * 1.5;
            }
            void Walk(int c)
            {
                if (c == C)
                {
                    double v = Score();
                    if (v < bestScore - 1e-9) { bestScore = v; best = (int[])pick.Clone(); }
                    return;
                }
                for (int s = 0; s < P; s++)
                    if (!used[s]) { used[s] = true; pick[c] = s; Walk(c + 1); used[s] = false; }
            }
            Walk(0);
            return best;
        }

        static int Hash(MapPreviewData p)
        {
            unchecked
            {
                int h = 17;
                for (int i = 0; i < p.Colors.Length; i += 7) h = h * 31 + p.Colors[i].r + (p.Colors[i].g << 8) + (p.Colors[i].b << 16);
                // markers too: a map-builder sketch can move a base without changing its terrain
                foreach (var m in p.Starts) h = h * 31 + Mathf.RoundToInt(m.U * 10000f) * 7919 + Mathf.RoundToInt(m.V * 10000f);
                return h;
            }
        }

        /// <summary>
        /// A stand-in preview for a procedural world: a soft island in the chosen style with one start disc per
        /// seat on a ring (team colours; a closed seat is left out), so a random map still shows who plays whom.
        /// </summary>
        public static Texture2D RandomTexture(int seats, int teamSize, string style, ulong closedMask = 0)
        {
            seats = Mathf.Clamp(seats, 2, 12);
            teamSize = Mathf.Max(1, teamSize);
            string key = "random:" + seats + ":" + teamSize + ":" + (style ?? "") + ":" + closedMask;
            if (cache.TryGetValue(key, out var cached) && cached != null) return cached;
            const int n = 160;
            var px = new Color32[n * n];
            var sea = new Color32(46, 74, 90, 255);
            var shallow = new Color32(70, 104, 114, 255);
            var land = new Color32(108, 122, 82, 255);
            var forest = new Color32(78, 100, 62, 255);
            var hills = new Color32(128, 128, 92, 255);
            bool archipelago = style == "archipelago", inland = style == "inlandSea", continents = style == "continents";
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    float u = x / (n - 1f) * 2f - 1f, v = y / (n - 1f) * 2f - 1f;
                    float r = Mathf.Sqrt(u * u + v * v);
                    float wobble = (Mathf.PerlinNoise(x * .045f + 3.1f, y * .045f + 7.7f) - .5f) * .42f + (Mathf.PerlinNoise(x * .11f, y * .11f) - .5f) * .14f;
                    float h = .86f - r + wobble;
                    if (archipelago) h = Mathf.PerlinNoise(x * .05f + 11f, y * .05f + 5f) - .48f + (.55f - r) * .55f;
                    if (continents) h -= Mathf.Max(0f, .16f - Mathf.Abs(u + v * .3f + wobble * .5f)) * 2.2f;
                    if (inland) h -= Mathf.Max(0f, .34f - r) * 2.2f;
                    Color32 c = h < -.04f ? sea : h < .02f ? shallow : land;
                    if (h >= .02f)
                    {
                        float f = Mathf.PerlinNoise(x * .09f + 40f, y * .09f + 13f);
                        if (f > .62f) c = forest; else if (f < .28f && h > .2f) c = hills;
                    }
                    px[y * n + x] = c;
                }
            float unit = n / 64f;
            float ring = archipelago ? .70f : .66f;
            for (int s = 0; s < seats; s++)
            {
                if ((closedMask & (1UL << s)) != 0) continue;
                // seats go round the ring in order, so a team's seats sit side by side
                float a = Mathf.PI * .5f + s * Mathf.PI * 2f / seats;
                var m = new MapMarker { U = .5f + Mathf.Cos(a) * ring * .5f, V = .5f + Mathf.Sin(a) * ring * .5f, Team = s / teamSize };
                Disc(px, n, n, m, 4.2f * unit, TeamColor(m.Team), new Color32(250, 246, 236, 255), 1.1f * unit);
            }
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, false) { name = "MapPreviewRandom", filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            tex.SetPixels32(px);
            tex.Apply(false, false);
            Store(key, tex);
            return tex;
        }

        /// <summary>Upscaled terrain with start discs (team colours), base rings and outpost dots.</summary>
        public static Texture2D Render(MapPreviewData p) => Render(p, null);

        /// <summary>
        /// As <see cref="Render(MapPreviewData)"/>; <paramref name="seated"/> (per start, preview order): the colour
        /// team of the civ that takes it, or -2 for a spare start (a hollow neutral ring). Null: designed teams.
        /// </summary>
        public static Texture2D Render(MapPreviewData p, int[] seated)
        {
            int scale = Mathf.Clamp(256 / Mathf.Max(p.W, p.H), 1, 8);
            int th = p.H * scale, tw = Mathf.Max(1, Mathf.RoundToInt(p.W * scale * p.Aspect));
            var px = new Color32[tw * th];
            for (int y = 0; y < th; y++)
            {
                int row = p.H - 1 - y / scale;   // texture rows go up; the grid's row 0 is the north edge
                for (int x = 0; x < tw; x++) px[y * tw + x] = p.Colors[row * p.W + Mathf.Min(p.W - 1, x * p.W / tw)];
            }
            float unit = Mathf.Max(tw, th) / 64f;
            foreach (var m in p.Outposts) Disc(px, tw, th, m, 1.4f * unit, new Color32(40, 40, 34, 255), new Color32(214, 200, 150, 255), 0.6f * unit);
            foreach (var m in p.Bases) Disc(px, tw, th, m, 2.2f * unit, new Color32(30, 30, 28, 255), new Color32(196, 188, 168, 255), 0.9f * unit);
            for (int i = 0; i < p.Starts.Count; i++)
            {
                var m = p.Starts[i];
                int team = seated == null || i >= seated.Length ? m.Team : seated[i];
                if (team == -2)
                {
                    // a spare start stays a neutral city ruin: a hollow grey ring instead of a team disc
                    Ring(px, tw, th, m, 2.6f * unit, 0.5f * unit, new Color32(30, 30, 28, 255));
                    Ring(px, tw, th, m, 2.2f * unit, 0.8f * unit, new Color32(206, 200, 186, 255));
                }
                else Disc(px, tw, th, m, 2.8f * unit, TeamColor(team), new Color32(250, 246, 236, 255), 0.8f * unit);
            }
            var tex = new Texture2D(tw, th, TextureFormat.RGBA32, false) { name = "MapPreview", filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            tex.SetPixels32(px);
            tex.Apply(false, false);
            return tex;
        }

        static void Ring(Color32[] px, int tw, int th, MapMarker m, float r, float width, Color32 colour)
        {
            float cx = m.U * (tw - 1), cy = (1f - m.V) * (th - 1);
            int x0 = Mathf.Max(0, Mathf.FloorToInt(cx - r)), x1 = Mathf.Min(tw - 1, Mathf.CeilToInt(cx + r));
            int y0 = Mathf.Max(0, Mathf.FloorToInt(cy - r)), y1 = Mathf.Min(th - 1, Mathf.CeilToInt(cy + r));
            for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                {
                    float d = Mathf.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
                    if (d <= r && d > r - width) px[y * tw + x] = colour;
                }
        }

        static void Disc(Color32[] px, int tw, int th, MapMarker m, float r, Color32 fill, Color32 rim, float rimWidth)
        {
            float cx = m.U * (tw - 1), cy = (1f - m.V) * (th - 1);
            float outer = r + rimWidth;
            int x0 = Mathf.Max(0, Mathf.FloorToInt(cx - outer)), x1 = Mathf.Min(tw - 1, Mathf.CeilToInt(cx + outer));
            int y0 = Mathf.Max(0, Mathf.FloorToInt(cy - outer)), y1 = Mathf.Min(th - 1, Mathf.CeilToInt(cy + outer));
            for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                {
                    float d = Mathf.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
                    if (d <= r) px[y * tw + x] = fill;
                    else if (d <= outer) px[y * tw + x] = rim;
                }
        }

        internal static string Str(JToken t, string fallback = "") => t != null && t.Type != JTokenType.Null && t.Type != JTokenType.Object && t.Type != JTokenType.Array ? (string)t ?? fallback : fallback;
        internal static int Int(JToken t, int fallback) => t != null && (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) ? (int)t : fallback;
        internal static float Float(JToken t) => t != null && (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) ? (float)t : 0f;
    }

    /// <summary>
    /// The map picker used by New Skirmish, Host lobby and the lobby page: a list (Random, then every catalog map
    /// with at least as many starts as the match has seats, the ones drawn for this format first and marked
    /// Recommended; or every map) beside a preview card (the catalog's preview grid with start positions, or a
    /// plain card when the map has none). Read-only for lobby guests (preview only).
    /// </summary>
    public sealed class MapPicker : VisualElement
    {
        readonly Func<IReadOnlyList<MapCatalogEntry>> catalog;
        readonly Action<string> pick;
        readonly VisualElement list, image, filterRow;
        readonly Label caption, meta, description, placeholder;
        readonly Button fitButton, allButton;
        bool showAll;

        /// <summary>Seats the match has (0: any); with "Fits" on, only maps with at least this many starts are listed.</summary>
        public int Seats;
        /// <summary>The match format ("2v2", "ffa4"); null: filter by <see cref="Seats"/> only.</summary>
        public string Format;
        /// <summary>For the random world's stand-in preview: its style and the seats left out (bit per seat).</summary>
        public string RandomStyle = "pangaea";
        public ulong ClosedSeats;
        public string Selected = "random";
        /// <summary>False: the list and filters are hidden (a lobby guest sees the host's choice).</summary>
        public bool Editable = true;
        /// <summary>Shown when <see cref="Selected"/> is not in this client's catalog (a newer server map).</summary>
        public string FallbackName = "";

        public MapPicker(Func<IReadOnlyList<MapCatalogEntry>> catalog, Action<string> pick)
        {
            this.catalog = catalog;
            this.pick = pick;
            AddToClassList("se-map-picker");
            // the preview card first (always in view), then the filter and the list
            var card = new VisualElement();
            card.AddToClassList("se-map-card");
            Add(card);
            image = new VisualElement();
            image.AddToClassList("se-map-preview");
            card.Add(image);
            placeholder = new Label("");
            placeholder.AddToClassList("se-map-preview-empty");
            image.Add(placeholder);
            var info = new VisualElement();
            info.AddToClassList("se-map-card-info");
            card.Add(info);
            caption = new Label("");
            caption.AddToClassList("se-map-card-name");
            info.Add(caption);
            meta = new Label("");
            meta.AddToClassList("se-map-card-meta");
            info.Add(meta);
            description = new Label("");
            description.AddToClassList("se-map-card-text");
            info.Add(description);

            var left = new VisualElement();
            left.AddToClassList("se-map-picker-list");
            Add(left);
            filterRow = new VisualElement();
            filterRow.AddToClassList("se-map-filter");
            left.Add(filterRow);
            fitButton = new Button(() => { showAll = false; Refresh(); }) { text = "Fits" };
            allButton = new Button(() => { showAll = true; Refresh(); }) { text = "All maps" };
            foreach (var b in new[] { fitButton, allButton }) { b.AddToClassList("se-map-filter-option"); filterRow.Add(b); }
            fitButton.tooltip = "Every map with a start for each seat (spare starts stay neutral)";
            allButton.tooltip = "Every map; one with fewer starts than seats sets its own format";
            list = new VisualElement();
            list.AddToClassList("se-map-list");
            left.Add(list);
        }

        MapCatalogEntry Find(string id)
        {
            var maps = catalog?.Invoke();
            if (maps != null) foreach (var m in maps) if (m.Id == id) return m;
            return null;
        }

        public void Refresh()
        {
            filterRow.style.display = Editable && Seats > 0 ? DisplayStyle.Flex : DisplayStyle.None;
            fitButton.EnableInClassList("selected", !showAll);
            allButton.EnableInClassList("selected", showAll);
            if (Seats > 0) fitButton.text = $"Fits {Seats}";
            list.parent.style.display = Editable ? DisplayStyle.Flex : DisplayStyle.None;
            UiKit.EnterAdded(list, list.childCount);   // rows a filter change adds ease in
            list.Clear();
            if (Editable)
            {
                Row("random", "Random", "Any", "A new procedurally generated world each time.", false);
                var maps = catalog?.Invoke();
                if (maps != null)
                {
                    // the maps drawn for this format first (Recommended), then every other map that has room
                    for (int pass = 0; pass < 2; pass++)
                        foreach (var m in maps)
                        {
                            bool recommended = Recommended(m);
                            if (recommended != (pass == 0)) continue;
                            if (showAll || Seats <= 0 || m.Fits(Seats) || m.Id == Selected)
                                Row(m.Id, m.Name, MapPreview.FormatLabel(m.Format) + " · designed for " + m.Players, Tip(m), recommended);
                        }
                }
            }
            ShowCard(Find(Selected));
        }

        /// <summary>Drawn for the match's format (or, without one, for exactly this many players).</summary>
        bool Recommended(MapCatalogEntry m) => Seats > 0 && (!string.IsNullOrEmpty(Format) ? m.Format == Format : m.Players == Seats);

        string Tip(MapCatalogEntry m)
        {
            string fit = Seats <= 0 ? "" : Recommended(m) ? "Recommended: drawn for this format. " : m.Fits(Seats)
                ? $"Drawn for {MapPreview.FormatLabel(m.Format)} ({m.Players} players); {Seats} play here, the spare starts stay neutral. "
                : $"Only {m.Players} starts: choosing it switches to {MapPreview.FormatLabel(m.Format)}. ";
            return fit + m.Description;
        }

        void Row(string id, string name, string mode, string tip, bool recommended)
        {
            var row = new Button { text = "" };
            row.AddToClassList("se-map-option");
            row.tooltip = tip;
            var n = new Label(name);
            n.AddToClassList("se-map-name");
            row.Add(n);
            if (recommended)
            {
                var badge = new Label("Recommended");
                badge.style.fontSize = 11;
                badge.style.color = (Color)new Color32(226, 182, 96, 255);
                badge.style.backgroundColor = (Color)new Color32(226, 182, 96, 36);
                badge.style.borderTopLeftRadius = badge.style.borderTopRightRadius = badge.style.borderBottomLeftRadius = badge.style.borderBottomRightRadius = 3;
                badge.style.paddingLeft = badge.style.paddingRight = 5;
                badge.style.marginLeft = badge.style.marginRight = 6;
                badge.style.flexShrink = 0;
                badge.style.unityTextAlign = TextAnchor.MiddleCenter;
                row.Add(badge);
            }
            var md = new Label(mode);
            md.AddToClassList("se-map-mode");
            md.style.width = StyleKeyword.Auto;
            md.style.minWidth = 48;
            row.Add(md);
            row.EnableInClassList("selected", id == Selected);
            row.clicked += () =>
            {
                Selected = id;
                pick?.Invoke(id);
                Refresh();
            };
            list.Add(row);
        }

        void ShowCard(MapCatalogEntry m)
        {
            bool unknownMap = m == null && !string.IsNullOrEmpty(Selected) && Selected != "random";
            var tex = m != null ? MapPreview.Texture(m, Seats, string.IsNullOrEmpty(Format) ? 1 : MapPreview.TeamSizeOf(Format), ClosedSeats) : unknownMap ? null
                : MapPreview.RandomTexture(Mathf.Max(2, Seats), string.IsNullOrEmpty(Format) ? 1 : MapPreview.TeamSizeOf(Format), RandomStyle, ClosedSeats);
            image.style.backgroundImage = tex != null ? new StyleBackground(tex) : new StyleBackground(StyleKeyword.None);
            image.EnableInClassList("se-map-preview--none", tex == null);
            placeholder.text = tex != null ? "" : m == null ? "?" : MapPreview.FormatLabel(m.Format);
            placeholder.style.display = tex != null ? DisplayStyle.None : DisplayStyle.Flex;
            bool unknown = m == null && !string.IsNullOrEmpty(Selected) && Selected != "random";
            caption.text = m != null ? m.Name : unknown ? (string.IsNullOrEmpty(FallbackName) ? Selected : FallbackName) : "Random world";
            meta.text = m == null ? (!string.IsNullOrEmpty(Format) ? MapPreview.FormatLabel(Format) + " · " : "") + (Seats > 0 ? $"{Seats} players · procedural" : "Procedural") :
                $"Designed for {MapPreview.FormatLabel(m.Format)} · {m.Players} starts" + (m.Size > 0 ? $" · {m.Size}×{m.Size}" : "") +
                (Seats > 0 && Seats < m.Players && m.Fits(Seats) ? $" · {Seats} playing, spare starts stay neutral" : Recommended(m) ? " · recommended" : "");
            description.text = m != null ? m.Description : unknown ? "A map from the server's catalog." : "A new world generated for this match: choose its style and size below. The starts shown are illustrative.";
            description.tooltip = description.text;
        }
    }
}
