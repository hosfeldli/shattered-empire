using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// A map-builder sketch (server/sim/sketchMaps.js, map id "custom"): a coarse grid of ocean / land /
    /// mountain / hills cells over the whole world rectangle plus the bases the player placed. The server's world
    /// generator honours the classes and fills in the rest (coasts, foothills, rivers, forests, resources,
    /// neutral cities, outposts, roads). Every base is a start; with fewer players the spare ones stay neutral.
    /// HILLS_MOUNTAINS (2026-11-19): painted mountains are impassable to every ground unit (aircraft fly over) and
    /// carry no buildings; painted hills (class 'h', new) are passable, infantry climb them slower. Older sketches
    /// (o / l / m only) load unchanged.
    /// Cell (col, row) covers u ∈ [col/W, (col+1)/W), v ∈ [row/H, (row+1)/H); row 0 is the north edge.
    /// </summary>
    public sealed class MapSketch
    {
        public const int GridW = 64, GridH = 64, MaxBases = 8, MinBases = 2, Slots = 4;
        public const byte Ocean = 0, Land = 1, Mountain = 2, Hills = 3;
        /// <summary>The world is √3 : 1.5 wider than tall.</summary>
        public const float Aspect = 1.1547f;
        const string Classes = "olmh";

        /// <summary>Ground units cross this class (land or hills): the seat metrics walk it and it counts as land.</summary>
        public static bool Walkable(byte c) => c == Land || c == Hills;

        public int W = GridW, H = GridH;
        public byte[] Cells = new byte[GridW * GridH];
        /// <summary>Base positions, normalised (u west → east, v north → south), rounded to 4 decimals as the server keeps them.</summary>
        public readonly List<Vector2Double> Bases = new List<Vector2Double>();
        /// <summary>Map size key: "small", "medium", "large", "huge" (server ACTION_SIZES).</summary>
        public string Size = "small";
        public string Name = "Custom map";
        /// <summary>
        /// Team ownership of the bases (2026-11-18, MAP_BUILDER_TEAMS.md): one entry per base, a team index (0-based,
        /// lobby team = seat / team size) or -1 for a base that stays neutral; null = automatic seating (server chooseStarts).
        /// </summary>
        public int[] Owners;

        /// <summary>True when the bases are assigned to teams (some entry names a team).</summary>
        public bool HasOwners
        {
            get
            {
                if (Owners == null || Owners.Length != Bases.Count) return false;
                foreach (int t in Owners) if (t >= 0) return true;
                return false;
            }
        }

        /// <summary>Keep <see cref="Owners"/> one entry per base after bases were added or removed (new bases neutral).</summary>
        public void SyncOwners()
        {
            if (Owners == null || Owners.Length == Bases.Count) return;
            var next = new int[Bases.Count];
            for (int i = 0; i < next.Length; i++) next[i] = i < Owners.Length ? Owners[i] : -1;
            Owners = next;
        }

        /// <summary>
        /// Why these seats cannot start on this ownership (server sketchMaps.baseOwnersProblem, same words), or null:
        /// every team with an active seat needs as many bases as it has active seats; no base may name a missing team.
        /// </summary>
        public string OwnersProblem(int seatCount, int teamSize, ulong closedMask)
        {
            if (!HasOwners || seatCount <= 0) return null;
            int ts = Math.Max(1, teamSize), teams = (seatCount + ts - 1) / ts;
            bool ffa = ts == 1 && teams > 2;
            var seats = new int[teams];
            var bases = new int[teams];
            for (int i = 0; i < seatCount; i++) if (i >= 64 || (closedMask & (1UL << i)) == 0) seats[i / ts]++;
            for (int b = 0; b < Owners.Length; b++)
            {
                int t = Owners[b];
                if (t < 0) continue;
                if (t >= teams) return $"Base {b + 1} belongs to {TeamName(t, ffa)}, which this format does not have: reassign it in the team window.";
                bases[t]++;
            }
            for (int t = 0; t < teams; t++)
                if (seats[t] > bases[t])
                    return $"{TeamName(t, ffa)} has {seats[t]} player{(seats[t] == 1 ? "" : "s")} but {(bases[t] > 0 ? "only " + bases[t] : "no")} starting base{(bases[t] == 1 ? "" : "s")}: give every player a base in the team window.";
            return null;
        }

        public static string TeamName(int team, bool ffa) => ffa ? $"Player {team + 1}" : $"Team {team + 1}";

        /// <summary>"north-west", "centre", "south" … for a base (the team window names bases by where they stand).</summary>
        public string Where(int index)
        {
            if (index < 0 || index >= Bases.Count) return "";
            var b = Bases[index];
            string ns = b.V < .36 ? "north" : b.V > .64 ? "south" : "", ew = b.U < .36 ? "west" : b.U > .64 ? "east" : "";
            return ns.Length > 0 && ew.Length > 0 ? ns + "-" + ew : ns.Length + ew.Length > 0 ? ns + ew : "centre";
        }

        public static readonly (string id, string label, int tiles)[] Sizes =
            { ("small", "Small", 104), ("medium", "Standard", 152), ("large", "Large", 208), ("huge", "Huge", 232) };

        public static int TilesOf(string size)
        {
            foreach (var s in Sizes) if (s.id == size) return s.tiles;
            return 104;
        }

        /// <summary>All land inside an ocean border three cells wide.</summary>
        public static MapSketch Default(string size = "small")
        {
            var s = new MapSketch { Size = string.IsNullOrEmpty(size) ? "small" : size };
            for (int y = 0; y < s.H; y++)
                for (int x = 0; x < s.W; x++)
                    s.Cells[y * s.W + x] = x < 3 || y < 3 || x >= s.W - 3 || y >= s.H - 3 ? Ocean : Land;
            return s;
        }

        public MapSketch Clone()
        {
            var c = new MapSketch { W = W, H = H, Cells = (byte[])Cells.Clone(), Size = Size, Name = Name, Owners = (int[])Owners?.Clone() };
            c.Bases.AddRange(Bases);
            return c;
        }

        public int CellOf(double u, double v)
        {
            int x = Math.Min(W - 1, Math.Max(0, (int)Math.Floor(u * W)));
            int y = Math.Min(H - 1, Math.Max(0, (int)Math.Floor(v * H)));
            return y * W + x;
        }

        public float LandShare
        {
            get { int n = 0; foreach (var c in Cells) if (Walkable(c)) n++; return Cells.Length == 0 ? 0 : n / (float)Cells.Length; }
        }

        /// <summary>Why the server would refuse this sketch, or null when it is playable.</summary>
        public string Problem()
        {
            if (Bases.Count < MinBases) return $"Place at least {MinBases} bases";
            if (Bases.Count > MaxBases) return $"At most {MaxBases} bases";
            if (LandShare < .08f) return "Paint more land (at least a tenth of the map)";
            foreach (var b in Bases) if (Cells[CellOf(b.U, b.V)] == Ocean) return "A base stands in the sea";
            return null;
        }

        // ------------------------------------------------------------------ wire format (sketchMaps.js)
        public static string EncodeCells(byte[] cells)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < cells.Length;)
            {
                int j = i;
                while (j < cells.Length && cells[j] == cells[i]) j++;
                sb.Append(Classes[Mathf.Clamp(cells[i], 0, Classes.Length - 1)]).Append(j - i);
                i = j;
            }
            return sb.ToString();
        }

        public static byte[] DecodeCells(string s, int n)
        {
            if (string.IsNullOrEmpty(s) || s.Length > 40000) return null;
            var cells = new byte[n];
            int k = 0, at = 0;
            while (at < s.Length)
            {
                int cls = Classes.IndexOf(s[at]);
                if (cls < 0) return null;
                at++;
                int start = at;
                long run = 0;
                while (at < s.Length && char.IsDigit(s[at]) && at - start < 7) { run = run * 10 + (s[at] - '0'); at++; }
                if (at == start || run < 1 || k + run > n) return null;
                for (int i = 0; i < run; i++) cells[k++] = (byte)cls;
            }
            return k == n ? cells : null;
        }

        public JObject Encode()
        {
            var bases = new JArray();
            foreach (var b in Bases) bases.Add(new JArray(b.U, b.V));
            var o = new JObject { ["v"] = 1, ["name"] = Name ?? "", ["size"] = Size, ["w"] = W, ["h"] = H, ["cells"] = EncodeCells(Cells), ["bases"] = bases };
            if (HasOwners) o["owners"] = new JArray(Owners);
            return o;
        }

        /// <summary>A sketch from JSON (a saved slot or the lobby room's 'sketch'); null when unreadable.</summary>
        public static MapSketch Decode(JToken token)
        {
            if (!(token is JObject o)) return null;
            int w = MapPreview.Int(o["w"], 0), h = MapPreview.Int(o["h"], 0);
            if (w < 16 || h < 16 || w > 128 || h > 128) return null;
            var cells = DecodeCells(MapPreview.Str(o["cells"]), w * h);
            if (cells == null) return null;
            var s = new MapSketch { W = w, H = h, Cells = cells, Size = MapPreview.Str(o["size"], "small"), Name = MapPreview.Str(o["name"], "Custom map") };
            if (TilesOf(s.Size) == 104 && s.Size != "small") s.Size = "small";
            if (o["bases"] is JArray arr)
                foreach (var t in arr)
                    if (t is JArray p && p.Count >= 2 && s.Bases.Count < MaxBases)
                        s.Bases.Add(new Vector2Double(Round4(Num(p[0])), Round4(Num(p[1]))));
            if (o["owners"] is JArray owners && owners.Count == s.Bases.Count)
            {
                s.Owners = new int[owners.Count];
                for (int i = 0; i < owners.Count; i++) s.Owners[i] = Math.Max(-1, Math.Min(MaxBases - 1, MapPreview.Int(owners[i], -1)));
                if (!s.HasOwners) s.Owners = null;
            }
            return s;
        }

        static double Num(JToken t) => t != null && (t.Type == JTokenType.Float || t.Type == JTokenType.Integer) ? (double)t : 0;
        public static double Round4(double x) => Math.Round(Math.Min(.98, Math.Max(.02, x)) * 10000, MidpointRounding.AwayFromZero) / 10000;

        /// <summary>
        /// Land steps between bases on the grid (4-neighbour over land; 1e4 without a route) and reach (all 0):
        /// exactly sketchMaps.js sketchMetrics, which the server seats the civs with.
        /// </summary>
        public (double[,] steps, double[] reach) Metrics()
        {
            int n = W * H, P = Bases.Count;
            var steps = new double[P, P];
            var d = new int[n];
            var queue = new int[n];
            for (int i = 0; i < P; i++)
            {
                for (int k = 0; k < n; k++) d[k] = -1;
                int from = CellOf(Bases[i].U, Bases[i].V), head = 0, tail = 0;
                d[from] = 0; queue[tail++] = from;
                while (head < tail)
                {
                    int c = queue[head++], x = c % W, y = c / W;
                    for (int dir = 0; dir < 4; dir++)
                    {
                        int m = dir == 0 ? (x > 0 ? c - 1 : -1) : dir == 1 ? (x < W - 1 ? c + 1 : -1) : dir == 2 ? (y > 0 ? c - W : -1) : (y < H - 1 ? c + W : -1);
                        if (m >= 0 && d[m] < 0 && Walkable(Cells[m])) { d[m] = d[c] + 1; queue[tail++] = m; }
                    }
                }
                for (int j = 0; j < P; j++) { int t = d[CellOf(Bases[j].U, Bases[j].V)]; steps[i, j] = t < 0 ? 1e4 : t; }
            }
            return (steps, new double[P]);
        }

        /// <summary>This sketch as a catalog entry (id "custom") with a preview the map picker can seat.</summary>
        public MapCatalogEntry ToEntry()
        {
            var e = new MapCatalogEntry
            {
                Id = "custom", Name = string.IsNullOrEmpty(Name) ? "Custom map" : Name, Players = Math.Max(2, Bases.Count), TeamSize = 1, Size = TilesOf(Size),
                Description = $"Your map-builder sketch: {Bases.Count} bases. The painted sea, land, hills and mountains are kept (mountains are impassable; infantry climb hills slower); coasts, rivers, forests, resources and neutral cities are generated around them.",
            };
            var cls = new byte[W * H];
            for (int i = 0; i < cls.Length; i++)
            {
                int x = i % W, y = i / W;
                bool land = false, mountain = false;
                for (int dir = 0; dir < 4; dir++)
                {
                    int nx = x + (dir == 0 ? 1 : dir == 1 ? -1 : 0), ny = y + (dir == 2 ? 1 : dir == 3 ? -1 : 0);
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    byte c = Cells[ny * W + nx];
                    if (c != Ocean) land = true;
                    if (c == Mountain) mountain = true;
                }
                // preview classes (actionMap.js PREVIEW_CLASSES): 0 deep, 1 shallow, 2 open, 5 hills, 6 mountains
                cls[i] = (byte)(Cells[i] == Ocean ? (land ? 1 : 0) : Cells[i] == Mountain ? 6 : Cells[i] == Hills || mountain ? 5 : 2);
            }
            var (steps, reach) = Metrics();
            var starts = new JArray();
            var stepRows = new JArray();
            for (int i = 0; i < Bases.Count; i++)
            {
                starts.Add(new JObject { ["seat"] = i, ["u"] = Bases[i].U, ["v"] = Bases[i].V });
                var row = new JArray();
                for (int j = 0; j < Bases.Count; j++) row.Add(steps[i, j]);
                stepRows.Add(row);
            }
            var preview = new JObject
            {
                ["w"] = W, ["h"] = H, ["aspect"] = Aspect,
                ["classes"] = new JArray("deep", "shallow", "open", "forest", "marsh", "hills", "mountains", "peaks", "river", "ford", "road", "bridge"),
                ["cells"] = Convert.ToBase64String(cls), ["starts"] = starts, ["startSteps"] = stepRows, ["startReach"] = new JArray(reach),
            };
            if (HasOwners) preview["startOwners"] = new JArray(Owners);
            try { e.Preview = MapPreviewData.Parse(preview, e); }
            catch (Exception ex) { Debug.LogWarning("Map sketch preview: " + ex.Message); }
            return e;
        }

        /// <summary>A key that changes whenever the sketch does (for caching its entry).</summary>
        public string Key()
        {
            var sb = new StringBuilder(EncodeCells(Cells)).Append('|').Append(Size).Append('|').Append(Name);
            foreach (var b in Bases) sb.Append('|').Append(b.U.ToString("R")).Append(',').Append(b.V.ToString("R"));
            if (HasOwners) sb.Append("|owners:").Append(string.Join(",", Owners));
            return sb.ToString();
        }

        // ------------------------------------------------------------------ local slots
        static string Folder => Path.Combine(Application.persistentDataPath, "map_sketches");
        static string SlotPath(int slot) => Path.Combine(Folder, slot < 0 ? "last.json" : $"slot{slot + 1}.json");

        /// <summary>Save to a slot (0..Slots-1, or -1: the last sketch used); false (with a log line) on failure.</summary>
        public bool Save(int slot)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                File.WriteAllText(SlotPath(slot), Encode().ToString(Newtonsoft.Json.Formatting.None));
                return true;
            }
            catch (Exception ex) { Debug.LogWarning("Map sketch: could not save (" + ex.Message + ")"); return false; }
        }

        public static MapSketch Load(int slot)
        {
            try
            {
                string path = SlotPath(slot);
                if (!File.Exists(path)) return null;
                return Decode(JToken.Parse(File.ReadAllText(path)));
            }
            catch (Exception ex) { Debug.LogWarning("Map sketch: could not load (" + ex.Message + ")"); return null; }
        }
    }

    /// <summary>A normalised position in double precision (the server rounds to 4 decimals; floats would not round-trip).</summary>
    public struct Vector2Double
    {
        public double U, V;
        public Vector2Double(double u, double v) { U = u; V = v; }
    }

    /// <summary>
    /// The map builder page body: a paint canvas over the sketch grid (Land, Sea, Hills, Mountains brushes in four
    /// sizes, Place / Remove base), the map size, undo and clear, a name and four local save slots. The
    /// caller supplies what "use" means (New Skirmish, or the lobby host's map).
    /// </summary>
    public sealed class MapBuilderView : VisualElement
    {
        MapSketch sketch;
        readonly Action<MapSketch> use;
        readonly VisualElement canvas, markers;
        readonly Label info;
        readonly TextField nameField;
        readonly Segmented sizeSeg;
        readonly List<Label> slotNames = new List<Label>();
        readonly Stack<MapSketch> undo = new Stack<MapSketch>();
        readonly Texture2D tex;
        readonly Color32[] px;
        string tool = "land";
        int brush = 2;
        bool painting;
        Vector2 last;

        static readonly Color32 DeepC = new Color32(40, 66, 84, 255), ShallowC = new Color32(70, 106, 120, 255);
        // land, the generated foothills beside a range, painted hills (olive downs), mountains (rock) and their snowy hearts
        static readonly Color32 LandC = new Color32(108, 124, 80, 255), FootC = new Color32(118, 126, 86, 255), HillC = new Color32(150, 146, 78, 255);
        static readonly Color32 MountC = new Color32(124, 114, 104, 255), PeakC = new Color32(206, 204, 198, 255);
        /// <summary>The paint brushes: id, label, canvas colour, tooltip.</summary>
        static readonly (string id, string label, Color32 color, string tip)[] Brushes =
        {
            ("land", "Land", LandC, "Land: open lowland. Grass, plains, forests and rivers are generated on it."),
            ("ocean", "Sea", ShallowC, "Sea: open water. Ground units cross it only by bridges; aircraft fly over."),
            ("hills", "Hills", HillC, "Hills: rolling high ground. Passable, but infantry move slower (x0.7) and vehicles slow down; troops on hills see farther and fight from cover."),
            ("mountain", "Mountains", MountC, "Mountains: high, steep peaks and ridges. Impassable to every ground unit and nothing can be built on them; aircraft fly over. Paint with M or larger for an unbroken wall; leave gaps for passes."),
        };

        public MapSketch Sketch => sketch;

        public MapBuilderView(MapSketch start, Action<MapSketch> use, string useLabel, VisualElement footer)
        {
            sketch = start?.Clone() ?? MapSketch.Default();
            this.use = use;
            AddToClassList("se-builder");
            tex = new Texture2D(sketch.W, sketch.H, TextureFormat.RGBA32, false) { name = "MapSketch", filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            px = new Color32[sketch.W * sketch.H];

            var columns = new VisualElement();
            columns.AddToClassList("se-builder-columns");
            Add(columns);

            // ---- the canvas
            var left = new VisualElement();
            left.AddToClassList("se-builder-left");
            columns.Add(left);
            canvas = new VisualElement();
            canvas.AddToClassList("se-builder-canvas");
            canvas.style.backgroundImage = new StyleBackground(tex);
            left.Add(canvas);
            markers = new VisualElement { pickingMode = PickingMode.Ignore };
            markers.AddToClassList("se-builder-markers");
            canvas.Add(markers);
            info = new Label("");
            info.AddToClassList("se-builder-info");
            left.Add(info);
            canvas.RegisterCallback<PointerDownEvent>(OnDown);
            canvas.RegisterCallback<PointerMoveEvent>(OnMove);
            canvas.RegisterCallback<PointerUpEvent>(OnUp);
            canvas.RegisterCallback<PointerCaptureOutEvent>(_ => painting = false);

            // ---- tools
            var right = new VisualElement();
            right.AddToClassList("se-builder-right");
            columns.Add(right);
            Label("Brush", right);
            Segmented paint = null, bases = null;
            var brushOpts = new List<(string id, string label, string icon)>();
            foreach (var b in Brushes) brushOpts.Add((b.id, b.label, null));
            paint = UiKit.Segmented(brushOpts, tool, v => { tool = v; if (bases != null) bases.Value = ""; }, right, 80);
            foreach (var b in Brushes)
            {
                // a colour swatch (the brush's canvas colour) before the label, and what the terrain does in the tooltip
                var seg = paint.Segment(b.id);
                if (seg == null) continue;
                seg.tooltip = b.tip;
                seg.style.flexDirection = FlexDirection.Row;
                seg.style.justifyContent = Justify.Center;
                seg.style.alignItems = Align.Center;
                var sw = new VisualElement { pickingMode = PickingMode.Ignore };
                sw.style.width = 10; sw.style.height = 10; sw.style.marginRight = 4; sw.style.flexShrink = 0;
                sw.style.borderTopLeftRadius = 2; sw.style.borderTopRightRadius = 2; sw.style.borderBottomLeftRadius = 2; sw.style.borderBottomRightRadius = 2;
                sw.style.backgroundColor = (Color)b.color;
                seg.Insert(0, sw);
            }
            Label("Bases", right);
            bases = UiKit.Segmented(Opts(("base", "Place base"), ("erase", "Remove base")), "", v => { tool = v; paint.Value = ""; }, right, 130);
            Label("Brush size", right);
            UiKit.Segmented(Opts(("1", "S"), ("2", "M"), ("4", "L"), ("7", "XL")), brush.ToString(), v => brush = int.TryParse(v, out int b) ? b : 2, right, 64);
            Label("Map size", right);
            var sizes = new List<(string id, string label, string icon)>();
            foreach (var s in MapSketch.Sizes) sizes.Add((s.id, s.label, null));
            sizeSeg = UiKit.Segmented(sizes, sketch.Size, v => { sketch.Size = v; Redraw(); }, right, 80);
            Label("Name", right);
            nameField = new TextField { value = sketch.Name, maxLength = 32 };
            nameField.AddToClassList("field");
            nameField.AddToClassList("se-menu-field");
            nameField.RegisterValueChangedCallback(e => sketch.Name = (e.newValue ?? "").Trim());
            right.Add(nameField);
            var edit = Row(right);
            UiKit.Button("Undo", Undo, edit, "back", "se-menu-action").tooltip = "Undo the last stroke or base (Ctrl+Z)";
            UiKit.Button("Clear", () => { Push(); sketch = Blank(sketch); Redraw(); }, edit, "close", "se-menu-action").tooltip = "Start again: all land inside an ocean border";
            Label("Saved sketches (this computer)", right);
            for (int i = 0; i < MapSketch.Slots; i++)
            {
                int slot = i;
                var row = Row(right);
                row.AddToClassList("se-builder-slot");
                var n = new Label("");
                n.AddToClassList("se-builder-slot-name");
                row.Add(n);
                slotNames.Add(n);
                UiKit.Button("Save", () => SaveSlot(slot), row, null, "se-menu-action").AddToClassList("se-builder-slot-btn");
                UiKit.Button("Load", () => LoadSlot(slot), row, null, "se-menu-action").AddToClassList("se-builder-slot-btn");
            }
            RefreshSlots();
            var help = new Label("Paint the sea, land, hills and mountain ranges, then place a base for each start. Mountains are impassable walls (aircraft fly over them); hills are passable, but infantry climb them slower. The generator keeps your shapes and adds coasts, foothills, rivers, forests, resources and neutral cities. With fewer players than bases, the spare ones stay neutral.");
            help.AddToClassList("se-menu-note");
            help.AddToClassList("se-menu-note--wrap");
            help.style.whiteSpace = WhiteSpace.Normal;
            right.Add(help);

            if (footer != null)
            {
                var b = UiKit.Button(useLabel ?? "Use this map", Use, footer, "play", "se-menu-action");
                b.AddToClassList("se-menu-action");
                b.AddToClassList("primary");
                b.AddToClassList("se-menu-action--primary");
            }
            focusable = true;
            RegisterCallback<KeyDownEvent>(e =>
            {
                if (e.keyCode == KeyCode.Z && (e.ctrlKey || e.commandKey)) { Undo(); e.StopPropagation(); }
            });
            Redraw();
        }

        static IReadOnlyList<(string id, string label, string icon)> Opts(params (string id, string label)[] o)
        {
            var list = new List<(string id, string label, string icon)>();
            foreach (var x in o) list.Add((x.id, x.label, null));
            return list;
        }

        static void Label(string text, VisualElement parent)
        {
            var l = new Label(text);
            l.AddToClassList("se-menu-label");
            parent.Add(l);
        }

        static VisualElement Row(VisualElement parent)
        {
            var r = new VisualElement();
            r.AddToClassList("se-menu-row");
            parent.Add(r);
            return r;
        }

        static MapSketch Blank(MapSketch from)
        {
            var b = MapSketch.Default(from.Size);
            b.Name = from.Name;
            return b;
        }

        // ------------------------------------------------------------------ painting
        bool ToUV(Vector2 local, out double u, out double v)
        {
            var r = canvas.contentRect;
            u = v = 0;
            if (r.width < 4 || r.height < 4) return false;
            u = Mathf.Clamp01(local.x / r.width);
            v = Mathf.Clamp01(local.y / r.height);
            return true;
        }

        void OnDown(PointerDownEvent e)
        {
            if (e.button != 0 || !ToUV(e.localPosition, out double u, out double v)) return;
            Focus();
            if (tool == "base") { PlaceBase(u, v); e.StopPropagation(); return; }
            if (tool == "erase") { RemoveBase(u, v); e.StopPropagation(); return; }
            Push();
            painting = true;
            last = e.localPosition;
            Stamp(u, v);
            canvas.CapturePointer(e.pointerId);
            Redraw();
            e.StopPropagation();
        }

        void OnMove(PointerMoveEvent e)
        {
            if (!painting || !canvas.HasPointerCapture(e.pointerId)) return;
            // stamp along the segment so a fast stroke leaves no gaps
            Vector2 now = e.localPosition;
            var r = canvas.contentRect;
            float cellPx = Mathf.Max(1f, r.height / sketch.H);
            int steps = Mathf.Max(1, Mathf.CeilToInt(Vector2.Distance(last, now) / cellPx));
            for (int i = 1; i <= steps; i++)
                if (ToUV(Vector2.Lerp(last, now, i / (float)steps), out double u, out double v)) Stamp(u, v);
            last = now;
            Redraw();
            e.StopPropagation();
        }

        void OnUp(PointerUpEvent e)
        {
            if (!painting) return;
            painting = false;
            if (canvas.HasPointerCapture(e.pointerId)) canvas.ReleasePointer(e.pointerId);
            e.StopPropagation();
        }

        void Stamp(double u, double v)
        {
            byte cls = tool == "ocean" ? MapSketch.Ocean : tool == "mountain" ? MapSketch.Mountain : tool == "hills" ? MapSketch.Hills : MapSketch.Land;
            float cx = (float)(u * sketch.W), cy = (float)(v * sketch.H), rad = brush - .5f;
            // the brush is round on screen: a cell is Aspect times wider than tall
            int rx = Mathf.CeilToInt(rad / MapSketch.Aspect) + 1, ry = Mathf.CeilToInt(rad) + 1;
            for (int y = Mathf.FloorToInt(cy) - ry; y <= Mathf.FloorToInt(cy) + ry; y++)
                for (int x = Mathf.FloorToInt(cx) - rx; x <= Mathf.FloorToInt(cx) + rx; x++)
                {
                    if (x < 0 || y < 0 || x >= sketch.W || y >= sketch.H) continue;
                    float dx = (x + .5f - cx) * MapSketch.Aspect, dy = y + .5f - cy;
                    if (dx * dx + dy * dy > Mathf.Max(.36f, rad * rad)) continue;
                    sketch.Cells[y * sketch.W + x] = cls;
                }
        }

        static double Gap(Vector2Double a, double u, double v)
        {
            double dx = (a.U - u) * MapSketch.Aspect, dy = a.V - v;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        void PlaceBase(double u, double v)
        {
            if (sketch.Bases.Count >= MapSketch.MaxBases) { Say($"At most {MapSketch.MaxBases} bases"); return; }
            byte under = sketch.Cells[sketch.CellOf(u, v)];
            if (under == MapSketch.Ocean) { Say("Bases stand on land"); return; }
            if (under == MapSketch.Mountain) { Say("Mountains are impassable: place bases on land or hills"); return; }
            foreach (var b in sketch.Bases) if (Gap(b, u, v) < .1) { Say("Too close to another base"); return; }
            Push();
            sketch.Bases.Add(new Vector2Double(MapSketch.Round4(u), MapSketch.Round4(v)));
            sketch.SyncOwners();   // a new base starts neutral when the bases are assigned to teams
            Redraw();
        }

        void RemoveBase(double u, double v)
        {
            int best = -1; double bd = .07;
            for (int i = 0; i < sketch.Bases.Count; i++) { double d = Gap(sketch.Bases[i], u, v); if (d < bd) { bd = d; best = i; } }
            if (best < 0) { Say("Click on a base to remove it"); return; }
            Push();
            sketch.Bases.RemoveAt(best);
            if (sketch.Owners != null && best < sketch.Owners.Length)
            {
                var owners = new List<int>(sketch.Owners);
                owners.RemoveAt(best);
                sketch.Owners = owners.ToArray();
                if (!sketch.HasOwners) sketch.Owners = null;
            }
            Redraw();
        }

        void Push()
        {
            undo.Push(sketch.Clone());
            // keep the history bounded: rebuild without the oldest entries
            if (undo.Count > 40)
            {
                var keep = undo.ToArray();
                undo.Clear();
                for (int i = 29; i >= 0; i--) undo.Push(keep[i]);
            }
        }

        void Undo()
        {
            if (undo.Count == 0) { Say("Nothing to undo"); return; }
            sketch = undo.Pop();
            nameField.SetValueWithoutNotify(sketch.Name);
            sizeSeg.Value = sketch.Size;
            Redraw();
        }

        // ------------------------------------------------------------------ drawing
        string message;

        void Say(string text) { message = text; UpdateInfo(); }

        void Redraw()
        {
            int w = sketch.W, h = sketch.H;
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    byte c = sketch.Cells[y * w + x];
                    bool nearLand = false, nearMountain = false, allMountain = true;
                    for (int d = 0; d < 4; d++)
                    {
                        int nx = x + (d == 0 ? 1 : d == 1 ? -1 : 0), ny = y + (d == 2 ? 1 : d == 3 ? -1 : 0);
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        byte n = sketch.Cells[ny * w + nx];
                        nearLand |= n != MapSketch.Ocean; nearMountain |= n == MapSketch.Mountain; allMountain &= n == MapSketch.Mountain;
                    }
                    var col = c == MapSketch.Ocean ? (nearLand ? ShallowC : DeepC) : c == MapSketch.Mountain ? (allMountain ? PeakC : MountC)
                        : c == MapSketch.Hills ? HillC : nearMountain ? FootC : LandC;
                    // faint grid every 8 cells, to judge distances
                    if ((x % 8 == 0 || y % 8 == 0) && c != MapSketch.Mountain) col = new Color32((byte)(col.r + 8), (byte)(col.g + 8), (byte)(col.b + 8), 255);
                    px[(h - 1 - y) * w + x] = col;   // texture rows go up; row 0 is the north edge
                }
            tex.SetPixels32(px);
            tex.Apply(false, false);
            markers.Clear();
            for (int i = 0; i < sketch.Bases.Count; i++)
            {
                var b = sketch.Bases[i];
                var m = new Label((i + 1).ToString()) { pickingMode = PickingMode.Ignore };
                m.AddToClassList("se-builder-base");
                m.style.left = Length.Percent((float)b.U * 100f);
                m.style.top = Length.Percent((float)b.V * 100f);
                // team-owned bases (assigned in the team window) wear their team's colour; neutral ones are grey
                bool owned = sketch.HasOwners;
                int team = owned ? sketch.Owners[i] : i;
                m.style.backgroundColor = owned && team < 0 ? (Color)new Color32(120, 120, 120, 255) : (Color)MapPreview.TeamColor(team);
                markers.Add(m);
            }
            message = null;
            UpdateInfo();
        }

        void UpdateInfo()
        {
            string problem = sketch.Problem();
            info.text = (message != null ? message + " · " : "") + $"{MapSketch.TilesOf(sketch.Size)}×{MapSketch.TilesOf(sketch.Size)} hexes · land {Mathf.RoundToInt(sketch.LandShare * 100)}% · {sketch.Bases.Count} base{(sketch.Bases.Count == 1 ? "" : "s")}" +
                (problem != null ? " · " + problem : " · ready: up to " + sketch.Bases.Count + " players");
            info.EnableInClassList("se-builder-info--warn", problem != null || message != null);
        }

        // ------------------------------------------------------------------ slots and use
        void RefreshSlots()
        {
            for (int i = 0; i < slotNames.Count; i++)
            {
                var s = MapSketch.Load(i);
                slotNames[i].text = $"{i + 1}. " + (s == null ? "empty" : $"{s.Name} · {s.Bases.Count} bases");
            }
        }

        void SaveSlot(int slot)
        {
            if (sketch.Save(slot)) Say($"Saved to slot {slot + 1}"); else Say("Could not save");
            RefreshSlots();
        }

        void LoadSlot(int slot)
        {
            var s = MapSketch.Load(slot);
            if (s == null) { Say($"Slot {slot + 1} is empty"); return; }
            if (s.W != sketch.W || s.H != sketch.H) { Say("That sketch uses another grid"); return; }
            Push();
            sketch = s;
            nameField.SetValueWithoutNotify(sketch.Name);
            sizeSeg.Value = sketch.Size;
            Redraw();
            Say($"Loaded slot {slot + 1}");
        }

        void Use()
        {
            string problem = sketch.Problem();
            if (problem != null) { Say(problem); return; }
            if (string.IsNullOrEmpty(sketch.Name)) sketch.Name = "Custom map";
            sketch.Save(-1);
            use?.Invoke(sketch.Clone());
        }
    }
}
