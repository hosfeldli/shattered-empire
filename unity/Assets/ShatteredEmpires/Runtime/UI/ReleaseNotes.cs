using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using SE.Runtime.App;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// "What's new" (docs/RELEASING.md, release notes): after an in-app update, on the first start of a new client
    /// version (the build stamp's version compared with PlayerPrefs se.notes.seen), a scrollable window beside the
    /// main menu shows that version's notes from the server (/api/release-notes/&lt;version&gt;): summary, sections
    /// with text, bullets, charts drawn here (Painter2D bar and line charts), before/after tables or image pairs,
    /// screenshots (loaded async, cached on disk, failure-tolerant) and a collapsible "Smaller fixes" list.
    /// The menu footer's "What's new" link reopens it. It never blocks the menu or play; offline it shows the cached
    /// copy or a short note. A fresh install (nothing seen yet and no update just installed) shows nothing.
    /// Command line: -whats-new opens it at start (any build), -notes-site URL reads another server (dev).
    /// </summary>
    public static class ReleaseNotes
    {
        const string SeenKey = "se.notes.seen", CachedKey = "se.notes.cached";
        static readonly Regex VersionPattern = new Regex(@"^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$");
        static readonly Regex ImagePattern = new Regex(@"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.(png|jpe?g)$", RegexOptions.IgnoreCase);
        static ReleaseNotesWindow open;
        static bool autoChecked;

        public static bool ValidVersion(string v) => !string.IsNullOrEmpty(v) && VersionPattern.IsMatch(v);
        internal static bool ValidImage(string name) => !string.IsNullOrEmpty(name) && ImagePattern.IsMatch(name);

        /// <summary>This client's version: the release stamp (build_id.txt version=), else the player's bundle version.</summary>
        public static string CurrentVersion
        {
            get
            {
                string v = Updater.Current?.Version ?? "";
                return ValidVersion(v) ? v : Application.version;
            }
        }

        static string site;
        internal static string ApiBase
        {
            get
            {
                if (site == null)
                {
                    string s = LaunchOptions.FromCommandLine().Get("notes-site", Updater.Site).Trim().TrimEnd('/');
                    site = Uri.TryCreate(s, UriKind.Absolute, out var u) && (u.Scheme == "https" || u.Scheme == "http") ? s : Updater.Site;
                }
                return site + "/api/release-notes/";
            }
        }

        /// <summary>
        /// Main menu hook: adds the "What's new" link to <paramref name="footer"/> and, once per process, opens the
        /// window when this version's notes have not been seen and the game was just updated (or -whats-new).
        /// </summary>
        public static void Attach(VisualElement host, VisualElement footer)
        {
            if (host == null) return;
            if (footer != null)
            {
                var link = UiKit.Button("What's new", () => Open(host, false), footer, null, "se-notes-link");
                link.tooltip = "What changed in this version";
            }
            if (autoChecked) return;
            autoChecked = true;
            var opts = LaunchOptions.FromCommandLine();
            if (opts.Has("release-shots") || opts.Has("review") || opts.Has("perf") || opts.Has("perf-soak") || opts.Has("mode")) return;   // automation
            if (opts.Has("whats-new")) { Open(host, true); return; }
            string v = CurrentVersion;
            if (Application.isEditor || !ValidVersion(v)) return;
            string seen = PlayerPrefs.GetString(SeenKey, "");
            if (seen == v) return;
            if (seen == "" && !Updater.JustUpdated) { MarkSeen(v); return; }   // a fresh install: nothing to compare with
            Open(host, true);
        }

        /// <summary>Open the window for this version (the latest notes when this version has none). Auto: opened by itself.</summary>
        public static void Open(VisualElement host, bool auto)
        {
            Close();
            open = new ReleaseNotesWindow(auto);
            host.Add(open);
            UiKit.Enter(open);
            _ = open.Load(CurrentVersion);
        }

        /// <summary>Close the window; false when it was not open (Escape uses this first).</summary>
        public static bool Close()
        {
            if (open == null) return false;
            var w = open; open = null;
            w.Dispose();
            w.RemoveFromHierarchy();
            return true;
        }

        internal static void MarkSeen(string version)
        {
            if (!ValidVersion(version) || version != CurrentVersion) return;
            PlayerPrefs.SetString(SeenKey, version);
            PlayerPrefs.Save();
        }

        // ------------------------------------------------------------------ network and the disk cache
        internal static string CacheDir(string version) => Path.Combine(Application.persistentDataPath, "ReleaseNotes", version);

        /// <summary>GET a URL: (200, bytes) on success, else (HTTP status or 0 without a connection, null).</summary>
        internal static async Task<(long code, byte[] data)> Get(string url, int timeoutSeconds)
        {
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = timeoutSeconds;
                var done = new TaskCompletionSource<bool>();
                var op = req.SendWebRequest();
                if (op.isDone) done.TrySetResult(true); else op.completed += _ => done.TrySetResult(true);
                await done.Task;
                if (req.result == UnityWebRequest.Result.Success) return (200, req.downloadHandler.data);
                return (req.responseCode, null);
            }
        }

        /// <summary>
        /// The notes of <paramref name="version"/> ("latest" for the published client's): the server's copy (cached on
        /// disk), else the cached copy. Missing: true when the server answered that there are no notes.
        /// </summary>
        internal static async Task<(JObject notes, bool fromCache, bool missing)> Fetch(string version)
        {
            long code = 0;
            try
            {
                var (c, data) = await Get(ApiBase + version, 10);
                code = c;
                if (data != null)
                {
                    var n = JObject.Parse(Encoding.UTF8.GetString(data));
                    string v = (string)n["version"];
                    if (ValidVersion(v))
                    {
                        try
                        {
                            Directory.CreateDirectory(CacheDir(v));
                            File.WriteAllBytes(Path.Combine(CacheDir(v), "notes.json"), data);
                            PlayerPrefs.SetString(CachedKey, v);
                        }
                        catch (Exception e) { Debug.LogWarning("[notes] cache: " + e.Message); }
                        return (n, false, false);
                    }
                }
            }
            catch (Exception e) { Debug.Log("[notes] fetch failed: " + e.Message); }
            string cv = version == "latest" ? PlayerPrefs.GetString(CachedKey, "") : version;
            try
            {
                string p = ValidVersion(cv) ? Path.Combine(CacheDir(cv), "notes.json") : null;
                if (p != null && File.Exists(p)) return (JObject.Parse(File.ReadAllText(p, Encoding.UTF8)), true, false);
            }
            catch (Exception e) { Debug.LogWarning("[notes] cached copy: " + e.Message); }
            return (null, false, code == 404);
        }

        /// <summary>An image of a notes version: the disk cache, else the server (then cached). Null on failure.</summary>
        internal static async Task<Texture2D> Image(string version, string name)
        {
            if (!ValidVersion(version) || !ValidImage(name)) return null;
            string path = Path.Combine(CacheDir(version), name);
            byte[] bytes = null;
            try { if (File.Exists(path)) bytes = File.ReadAllBytes(path); } catch { bytes = null; }
            if (bytes == null)
            {
                var (_, data) = await Get(ApiBase + version + "/" + Uri.EscapeDataString(name), 20);
                if (data == null) return null;
                bytes = data;
                try { Directory.CreateDirectory(CacheDir(version)); File.WriteAllBytes(path, data); } catch (Exception e) { Debug.LogWarning("[notes] image cache: " + e.Message); }
            }
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false) { name = "notes " + name };
            if (!tex.LoadImage(bytes, true)) { UnityEngine.Object.Destroy(tex); return null; }
            return tex;
        }
    }

    /// <summary>The "What's new in &lt;version&gt;" window (see <see cref="ReleaseNotes"/>). Styles: SE.uss .se-notes*.</summary>
    public sealed class ReleaseNotesWindow : VisualElement
    {
        readonly bool auto;
        readonly Label title, meta;
        readonly ScrollView body;
        readonly List<Texture2D> textures = new List<Texture2D>();
        bool disposed;

        public ReleaseNotesWindow(bool auto)
        {
            this.auto = auto;
            name = "se-release-notes";
            AddToClassList("se-notes");
            pickingMode = PickingMode.Position;
            var head = UiKit.El("se-notes-head", this);
            title = UiKit.Text("What's new", "se-notes-title", head);
            var close = UiKit.IconButton("close", () => ReleaseNotes.Close(), "Close", head, 28);
            close.focusable = false;
            meta = UiKit.Text("", "se-notes-meta", this);
            body = new ScrollView(ScrollViewMode.Vertical);
            body.AddToClassList("se-notes-scroll");
            Add(body);
            UiKit.Text("Loading…", "se-notes-text", body);
            var foot = UiKit.El("se-notes-foot", this);
            UiKit.Button("Close", () => ReleaseNotes.Close(), foot, null, "se-menu-action");
        }

        public void Dispose()
        {
            disposed = true;
            foreach (var t in textures) if (t != null) UnityEngine.Object.Destroy(t);
            textures.Clear();
        }

        public async Task Load(string version)
        {
            bool mine = ReleaseNotes.ValidVersion(version);
            JObject notes = null; bool fromCache = false, missing = true;
            if (mine) (notes, fromCache, missing) = await ReleaseNotes.Fetch(version);
            // no notes for this build (a dev build, or released without notes): the published version's, when opened by hand
            if (notes == null && missing && !auto) (notes, fromCache, missing) = await ReleaseNotes.Fetch("latest");
            if (disposed) return;
            body.Clear();
            if (notes == null)
            {
                if (auto && missing) { ReleaseNotes.MarkSeen(version); ReleaseNotes.Close(); return; }   // nothing to tell
                title.text = mine ? "What's new in " + version : "What's new";
                meta.text = "";
                UiKit.Text(missing ? "There are no release notes for this version yet."
                    : "The release notes couldn't be loaded. Connect to the internet and open What's new from the main menu.", "se-notes-text", body);
                return;
            }
            string v = (string)notes["version"] ?? version;
            title.text = "What's new in " + v;
            string date = (string)notes["date"] ?? "";
            string since = (string)notes["since"]?["version"] ?? "";
            meta.text = (string)notes["title"] + (date.Length > 0 ? " · " + date : "") + (since.Length > 0 ? " · changes since " + since : "")
                + (fromCache ? " · offline copy" : "") + (notes["draft"]?.Type == JTokenType.Boolean && (bool)notes["draft"] ? " · draft" : "");
            try { Render(notes, v); }
            catch (Exception e) { Debug.LogWarning("[notes] render: " + e); UiKit.Text("Some of these notes couldn't be shown.", "se-notes-caption", body); }
            if (v == version) ReleaseNotes.MarkSeen(v);
        }

        // ------------------------------------------------------------------ blocks
        void Render(JObject n, string version)
        {
            Para((string)n["summary"], "se-notes-summary", body);
            if (n["sections"] is JArray sections)
                foreach (var st in sections)
                {
                    if (!(st is JObject s)) continue;
                    UiKit.Text((string)s["heading"] ?? "", "se-notes-heading", body);
                    if (s["blocks"] is JArray blocks) foreach (var bt in blocks) if (bt is JObject b) Block(b, version, body);
                }
            if (n["fixes"] is JArray fixes && fixes.Count > 0)
            {
                var fold = new Foldout { text = $"Smaller fixes ({fixes.Count})", value = false };
                fold.AddToClassList("se-notes-fixes");
                foreach (var f in fixes) Bullet((string)f, fold);
                body.Add(fold);
            }
        }

        static Label Para(string text, string cls, VisualElement parent)
        {
            if (string.IsNullOrEmpty(text)) return null;
            var l = UiKit.Text(text, cls, parent);
            l.style.whiteSpace = WhiteSpace.Normal;
            return l;
        }

        static void Bullet(string text, VisualElement parent) => Para("•  " + text, "se-notes-bullet", parent);

        void Block(JObject b, string version, VisualElement parent)
        {
            switch ((string)b["type"])
            {
                case "text": Para((string)b["text"], "se-notes-text", parent); break;
                case "bullets":
                    if (b["items"] is JArray items) foreach (var t in items) Bullet((string)t, parent);
                    break;
                case "chart":
                    Para((string)b["title"], "se-notes-chart-title", parent);
                    parent.Add(new NotesChart(b));
                    Para(Caption(b), "se-notes-caption", parent);
                    break;
                case "comparison":
                    Para((string)b["title"], "se-notes-chart-title", parent);
                    if (b["rows"] is JArray rows) Table(b, rows, parent);
                    else
                    {
                        var pair = UiKit.El("se-notes-pair", parent);
                        Picture(version, b["before"] as JObject, "Before", pair).AddToClassList("se-notes-pair-item");
                        Picture(version, b["after"] as JObject, "After", pair).AddToClassList("se-notes-pair-item");
                    }
                    Para(Caption(b), "se-notes-caption", parent);
                    break;
                case "image": Picture(version, b, null, parent); break;
            }
        }

        static string Caption(JObject b)
        {
            string c = (string)b["caption"] ?? "", s = (string)b["source"] ?? "";
            return c + (s.Length > 0 ? (c.Length > 0 ? " " : "") + "Source: " + s : "");
        }

        static void Table(JObject b, JArray rows, VisualElement parent)
        {
            var cols = b["columns"] as JArray;
            var table = UiKit.El("se-notes-table", parent);
            Row(table, "", cols != null && cols.Count > 0 ? (string)cols[0] : "Before", cols != null && cols.Count > 1 ? (string)cols[1] : "After", true);
            foreach (var rt in rows) if (rt is JObject r) Row(table, (string)r["label"], (string)r["before"], (string)r["after"], false);
        }

        static void Row(VisualElement table, string label, string before, string after, bool header)
        {
            var row = UiKit.El("se-notes-row" + (header ? " se-notes-row--head" : ""), table);
            Para(label ?? "", "se-notes-cell se-notes-cell--label", row);
            Para(before ?? "", "se-notes-cell", row);
            Para(after ?? "", "se-notes-cell se-notes-cell--after", row);
        }

        /// <summary>An image with its caption: a placeholder until it loads, a short note if it can't.</summary>
        VisualElement Picture(string version, JObject img, string tag, VisualElement parent)
        {
            var box = UiKit.El("se-notes-figure", parent);
            var frame = UiKit.El("se-notes-image", box);
            frame.style.height = 200;
            var status = UiKit.Text("Loading image…", "se-notes-caption", frame);
            string file = (string)img?["image"];
            string cap = (string)img?["caption"] ?? "";
            Para(tag != null ? tag + (cap.Length > 0 ? ": " + cap : "") : cap, "se-notes-caption", box);
            if (img?["alt"] != null) frame.tooltip = (string)img["alt"];
            _ = LoadPicture(version, file, frame, status);
            return box;
        }

        async Task LoadPicture(string version, string file, VisualElement frame, Label status)
        {
            Texture2D tex = null;
            try { tex = await ReleaseNotes.Image(version, file); } catch (Exception e) { Debug.Log("[notes] image: " + e.Message); }
            if (disposed) { if (tex != null) UnityEngine.Object.Destroy(tex); return; }
            if (tex == null) { status.text = "Image unavailable offline"; frame.style.height = 48; return; }
            textures.Add(tex);
            status.RemoveFromHierarchy();
            frame.style.backgroundImage = new StyleBackground(tex);
            float aspect = tex.height / (float)Mathf.Max(1, tex.width);
            void Fit() { float w = frame.resolvedStyle.width; if (w > 1 && !float.IsNaN(w)) frame.style.height = Mathf.Round(w * aspect); }
            frame.RegisterCallback<GeometryChangedEvent>(_ => Fit());
            Fit();
        }
    }

    /// <summary>
    /// A small bar or line chart for release notes, drawn with Painter2D in theme colours: a nice-rounded value axis
    /// from zero with four grid lines, category labels under the plot, values over bars when they fit, and a legend.
    /// Null values are "not measured" and are skipped (a gap in a line).
    /// </summary>
    public sealed class NotesChart : VisualElement
    {
        const float PlotHeight = 180, Left = 48, Right = 8, Top = 12, Bottom = 22;
        static readonly string[] SeriesColors = { "text-dim", "accent", "ally", "friendly" };
        readonly bool line;
        readonly string unit;
        readonly string[] labels;
        readonly List<(string name, float?[] values)> series = new List<(string, float?[])>();
        readonly float top;
        readonly VisualElement plot;
        readonly List<Label> xLabels = new List<Label>(), yLabels = new List<Label>(), valueLabels = new List<Label>();

        public NotesChart(JObject b)
        {
            AddToClassList("se-notes-chart");
            line = (string)b["kind"] == "line";
            unit = (string)b["unit"] ?? "";
            var la = b["labels"] as JArray ?? new JArray();
            labels = new string[la.Count];
            for (int i = 0; i < la.Count; i++) labels[i] = (string)la[i] ?? "";
            float max = 0;
            if (b["series"] is JArray sa)
                foreach (var st in sa)
                {
                    if (!(st is JObject s) || series.Count >= SeriesColors.Length) continue;
                    var vals = new float?[labels.Length];
                    if (s["values"] is JArray va)
                        for (int i = 0; i < labels.Length && i < va.Count; i++)
                            if (va[i].Type == JTokenType.Integer || va[i].Type == JTokenType.Float) { vals[i] = (float)va[i]; max = Mathf.Max(max, vals[i].Value); }
                    series.Add(((string)s["name"] ?? "", vals));
                }
            top = NiceTop(max);

            plot = new VisualElement { pickingMode = PickingMode.Ignore };
            plot.style.height = PlotHeight;
            plot.generateVisualContent += Draw;
            Add(plot);
            for (int i = 0; i <= 4; i++) yLabels.Add(Axis(Format(top * i / 4f) + (i == 4 && unit.Length > 0 ? " " + unit : ""), TextAnchor.MiddleRight));
            foreach (var l in labels) xLabels.Add(Axis(l, TextAnchor.UpperCenter));
            if (!line && labels.Length * series.Count <= 12)
                foreach (var s in series) foreach (var v in s.values) valueLabels.Add(Axis(v.HasValue ? Format(v.Value) : "n/a", TextAnchor.LowerCenter));
            plot.RegisterCallback<GeometryChangedEvent>(_ => Place());

            var legend = UiKit.El("se-notes-legend", this);
            for (int k = 0; k < series.Count; k++)
            {
                var item = UiKit.El("se-notes-legend-item", legend);
                var sw = UiKit.El("se-notes-swatch", item);
                sw.style.backgroundColor = UiKit.Token(SeriesColors[k]);
                UiKit.Text(series[k].name, "se-notes-legend-label", item);
            }
        }

        Label Axis(string text, TextAnchor align)
        {
            var l = UiKit.Text(text, "se-notes-axis", plot);
            l.pickingMode = PickingMode.Ignore;
            l.style.position = Position.Absolute;
            l.style.unityTextAlign = align;
            return l;
        }

        static float NiceTop(float max)
        {
            if (max <= 0) return 1;
            float raw = max / 4f, mag = Mathf.Pow(10, Mathf.Floor(Mathf.Log10(raw))), norm = raw / mag;
            float step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5f ? 2.5f : norm <= 5 ? 5 : 10) * mag;
            return step * 4 >= max ? step * 4 : step * Mathf.Ceil(max / step);
        }

        static string Format(float v) => v >= 100 || Mathf.Approximately(v, Mathf.Round(v))
            ? Mathf.Round(v).ToString("0", System.Globalization.CultureInfo.InvariantCulture)
            : v.ToString(v >= 10 ? "0.#" : "0.##", System.Globalization.CultureInfo.InvariantCulture);

        Rect Area()
        {
            var r = plot.contentRect;
            return new Rect(Left, Top, Mathf.Max(10, r.width - Left - Right), Mathf.Max(10, r.height - Top - Bottom));
        }

        float Y(Rect a, float v) => a.yMax - Mathf.Clamp01(v / top) * a.height;

        (float x, float w) Bar(Rect a, int i, int k)
        {
            float group = a.width / Mathf.Max(1, labels.Length), w = group * .72f / Mathf.Max(1, series.Count);
            return (a.x + group * i + group * .14f + w * k, w);
        }

        float Cx(Rect a, int i) => a.x + a.width / Mathf.Max(1, labels.Length) * (i + .5f);

        void Place()
        {
            var a = Area();
            if (float.IsNaN(a.width)) return;
            for (int i = 0; i < yLabels.Count; i++)
            {
                var l = yLabels[i];
                l.style.left = 0; l.style.width = Left - 6; l.style.height = 14;
                l.style.top = Y(a, top * i / 4f) - 7;
            }
            float group = a.width / Mathf.Max(1, labels.Length);
            for (int i = 0; i < xLabels.Count; i++)
            {
                var l = xLabels[i];
                l.style.left = a.x + group * i; l.style.width = group; l.style.top = a.yMax + 4; l.style.height = 16;
            }
            int n = 0;
            for (int k = 0; k < series.Count; k++)
                for (int i = 0; i < labels.Length && n < valueLabels.Count; i++, n++)
                {
                    var (x, w) = Bar(a, i, k);
                    float v = series[k].values[i] ?? 0;
                    var l = valueLabels[n];
                    l.style.left = x - 12; l.style.width = w + 24; l.style.height = 14; l.style.top = Y(a, v) - 15;
                }
            plot.MarkDirtyRepaint();
        }

        void Draw(MeshGenerationContext mgc)
        {
            var a = Area();
            if (float.IsNaN(a.width) || labels.Length == 0) return;
            var p = mgc.painter2D;
            p.lineWidth = 1;
            p.strokeColor = UiKit.Token("line");
            for (int i = 0; i <= 4; i++)
            {
                float y = Mathf.Round(Y(a, top * i / 4f)) + .5f;
                p.BeginPath(); p.MoveTo(new Vector2(a.x, y)); p.LineTo(new Vector2(a.xMax, y)); p.Stroke();
            }
            for (int k = 0; k < series.Count; k++)
            {
                var c = UiKit.Token(SeriesColors[k]);
                var vals = series[k].values;
                if (!line)
                {
                    p.fillColor = c;
                    for (int i = 0; i < vals.Length; i++)
                    {
                        if (!vals[i].HasValue) continue;
                        var (x, w) = Bar(a, i, k);
                        float y = Y(a, vals[i].Value);
                        if (a.yMax - y < 1) y = a.yMax - 1;
                        p.BeginPath();
                        p.MoveTo(new Vector2(x, a.yMax)); p.LineTo(new Vector2(x, y)); p.LineTo(new Vector2(x + w, y)); p.LineTo(new Vector2(x + w, a.yMax));
                        p.ClosePath(); p.Fill();
                    }
                    continue;
                }
                p.strokeColor = c; p.fillColor = c; p.lineWidth = 2.5f;
                p.lineJoin = LineJoin.Round; p.lineCap = LineCap.Round;
                bool drawing = false;
                p.BeginPath();
                for (int i = 0; i < vals.Length; i++)
                {
                    if (!vals[i].HasValue) { drawing = false; continue; }
                    var pt = new Vector2(Cx(a, i), Y(a, vals[i].Value));
                    if (drawing) p.LineTo(pt); else p.MoveTo(pt);
                    drawing = true;
                }
                p.Stroke();
                for (int i = 0; i < vals.Length; i++)
                {
                    if (!vals[i].HasValue) continue;
                    p.BeginPath(); p.Arc(new Vector2(Cx(a, i), Y(a, vals[i].Value)), 3.5f, 0, 360); p.Fill();
                }
                p.lineWidth = 1;
            }
        }
    }
}
