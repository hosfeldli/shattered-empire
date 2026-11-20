using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
    /// "What's new": the running changelog (docs/RELEASING.md, release notes). After an in-app update, on the first
    /// start of a new client version (the build stamp's version compared with PlayerPrefs se.notes.seen), a window
    /// beside the main menu opens on that version's notes. It is a changelog browser: a version list (newest first,
    /// the player's version marked, versions newer than the last one seen badged "new") from
    /// /api/release-notes/index, and per version a summary, a jump list of sections, sections grouped by category
    /// (collapsible) with text, bullets, charts drawn here (Painter2D), before/after tables or image pairs,
    /// screenshots (loaded async, cached on disk, failure-tolerant), "Changed in" pointers and the smaller fixes.
    /// A search box and a category filter search every version. The menu footer's "What's new" link reopens it.
    /// It never blocks the menu or play; offline it uses the cached index and notes, or a short note. A fresh install
    /// (nothing seen yet and no update just installed) shows nothing.
    /// Command line: -whats-new opens it at start (any build), -notes-site URL reads another server (dev).
    /// Keys: Up/Down (or [ ]) switch version, Ctrl+F or / searches, Escape closes (MainMenu.HandleEscape).
    /// </summary>
    public static class ReleaseNotes
    {
        const string SeenKey = "se.notes.seen", CachedKey = "se.notes.cached";
        static readonly Regex VersionPattern = new Regex(@"^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$");
        static readonly Regex ImagePattern = new Regex(@"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.(png|jpe?g)$", RegexOptions.IgnoreCase);
        static ReleaseNotesWindow open;
        static bool autoChecked;

        /// <summary>Section categories (tools/release-notes.mjs CATEGORIES): id and label, in display order.</summary>
        public static readonly (string id, string label)[] Categories =
        {
            ("gameplay", "Gameplay"), ("units", "Units & balance"), ("ai", "AI"), ("performance", "Performance"),
            ("visuals", "Visuals & audio"), ("interface", "Interface"), ("fixes", "Fixes"), ("other", "Other"),
        };

        public static string CategoryOf(JToken section)
        {
            string c = (string)(section as JObject)?["category"];
            foreach (var (id, _) in Categories) if (id == c) return id;
            return "other";
        }

        public static string CategoryLabel(string id)
        {
            foreach (var (cid, label) in Categories) if (cid == id) return label;
            return "Other";
        }

        public static int CategoryOrder(string id)
        {
            for (int i = 0; i < Categories.Length; i++) if (Categories[i].id == id) return i;
            return Categories.Length;
        }

        public static bool ValidVersion(string v) => !string.IsNullOrEmpty(v) && VersionPattern.IsMatch(v);
        internal static bool ValidImage(string name) => !string.IsNullOrEmpty(name) && ImagePattern.IsMatch(name);

        /// <summary>Semver order (the server's and tools/release-notes.mjs cmpVersion): 0.10.0 &gt; 0.9.9 &gt; 0.9.9-rc1.</summary>
        public static int Compare(string a, string b)
        {
            var pa = (a ?? "").Split('.', '-'); var pb = (b ?? "").Split('.', '-');
            for (int i = 0; i < Math.Max(pa.Length, pb.Length); i++)
            {
                string x = i < pa.Length ? pa[i] : "", y = i < pb.Length ? pb[i] : "";
                bool nx = int.TryParse(x, out int ix), ny = int.TryParse(y, out int iy);
                if (nx && ny) { if (ix != iy) return ix.CompareTo(iy); continue; }
                if (x == y) continue;
                if (x == "") return 1;
                if (y == "") return -1;
                return string.CompareOrdinal(x, y) < 0 ? -1 : 1;
            }
            return 0;
        }

        /// <summary>This client's version: the release stamp (build_id.txt version=), else the player's bundle version.</summary>
        public static string CurrentVersion
        {
            get
            {
                string v = Updater.Current?.Version ?? "";
                return ValidVersion(v) ? v : Application.version;
            }
        }

        /// <summary>The last version whose notes the player saw ("" when none): versions newer than it are badged new.</summary>
        public static string SeenVersion => PlayerPrefs.GetString(SeenKey, "");

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
                link.tooltip = "What changed in this version, and every version before it";
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

        /// <summary>Open the changelog on this version (the newest when this version has none). Auto: opened by itself.</summary>
        public static void Open(VisualElement host, bool auto, string version = null)
        {
            Close();
            open = new ReleaseNotesWindow(auto);
            host.Add(open);
            UiKit.Enter(open);
            _ = open.Load(ValidVersion(version) ? version : CurrentVersion);
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
        internal static string CacheRoot => Path.Combine(Application.persistentDataPath, "ReleaseNotes");
        internal static string CacheDir(string version) => Path.Combine(CacheRoot, version);

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
            var cached = Cached(cv);
            if (cached != null) return (cached, true, false);
            return (null, false, code == 404);
        }

        /// <summary>The cached notes of a version, or null.</summary>
        internal static JObject Cached(string version)
        {
            try
            {
                string p = ValidVersion(version) ? Path.Combine(CacheDir(version), "notes.json") : null;
                if (p != null && File.Exists(p)) return JObject.Parse(File.ReadAllText(p, Encoding.UTF8));
            }
            catch (Exception e) { Debug.LogWarning("[notes] cached copy: " + e.Message); }
            return null;
        }

        /// <summary>
        /// Every version's index entry, newest first ({version, date, title, summary, since, sections[{heading,
        /// category}], fixes, draft?}): /api/release-notes/index (cached on disk), else the cached index, else entries
        /// made from the notes cached on disk. Null when there is nothing at all. Old servers without the index route
        /// answer 404, and the cache is used then too.
        /// </summary>
        internal static async Task<(List<JObject> entries, bool fromCache)> FetchIndex()
        {
            string file = Path.Combine(CacheRoot, "index.json");
            try
            {
                var (_, data) = await Get(ApiBase + "index", 10);
                if (data != null)
                {
                    var list = Entries(JObject.Parse(Encoding.UTF8.GetString(data)));
                    if (list.Count > 0)
                    {
                        try { Directory.CreateDirectory(CacheRoot); File.WriteAllBytes(file, data); }
                        catch (Exception e) { Debug.LogWarning("[notes] index cache: " + e.Message); }
                        return (list, false);
                    }
                }
            }
            catch (Exception e) { Debug.Log("[notes] index fetch failed: " + e.Message); }
            var merged = new Dictionary<string, JObject>();
            try { if (File.Exists(file)) foreach (var e in Entries(JObject.Parse(File.ReadAllText(file, Encoding.UTF8)))) merged[(string)e["version"]] = e; }
            catch (Exception e) { Debug.LogWarning("[notes] cached index: " + e.Message); }
            // notes cached on disk that the cached index doesn't list (e.g. the index was never fetched)
            try
            {
                if (Directory.Exists(CacheRoot))
                    foreach (var d in Directory.GetDirectories(CacheRoot))
                    {
                        string v = Path.GetFileName(d);
                        if (!ValidVersion(v) || merged.ContainsKey(v)) continue;
                        var n = Cached(v);
                        if (n != null) merged[v] = EntryOf(n, v);
                    }
            }
            catch (Exception e) { Debug.LogWarning("[notes] cache listing: " + e.Message); }
            if (merged.Count == 0) return (null, true);
            return (merged.Values.OrderByDescending(e => (string)e["version"], Comparer<string>.Create(Compare)).ToList(), true);
        }

        static List<JObject> Entries(JObject index)
        {
            var list = new List<JObject>();
            if (index?["versions"] is JArray vs)
                foreach (var t in vs) if (t is JObject e && ValidVersion((string)e["version"])) list.Add(e);
            list.Sort((a, b) => Compare((string)b["version"], (string)a["version"]));
            return list;
        }

        /// <summary>An index entry made from a full notes object (the server's shape).</summary>
        internal static JObject EntryOf(JObject n, string version)
        {
            var secs = new JArray();
            if (n["sections"] is JArray ss)
                foreach (var s in ss) if (s is JObject so) secs.Add(new JObject { ["heading"] = (string)so["heading"] ?? "", ["category"] = CategoryOf(so) });
            var e = new JObject
            {
                ["version"] = version, ["date"] = (string)n["date"] ?? "", ["title"] = (string)n["title"] ?? "",
                ["summary"] = (string)n["summary"] ?? "", ["since"] = (string)n["since"]?["version"] ?? "",
                ["sections"] = secs, ["fixes"] = (n["fixes"] as JArray)?.Count ?? 0,
            };
            if (n["draft"]?.Type == JTokenType.Boolean && (bool)n["draft"]) e["draft"] = true;
            return e;
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

    /// <summary>The changelog window (see <see cref="ReleaseNotes"/>). Styles: SE.uss .se-notes*.</summary>
    public sealed class ReleaseNotesWindow : VisualElement
    {
        readonly bool auto;
        readonly string current, seenBefore;
        readonly Label title, meta;
        readonly TextField search;
        readonly VisualElement filters, sidebar, toc;
        readonly ScrollView versionList, body;
        readonly List<Texture2D> textures = new List<Texture2D>();
        readonly Dictionary<string, JObject> loaded = new Dictionary<string, JObject>();
        readonly HashSet<string> offline = new HashSet<string>();   // versions shown from the disk cache
        readonly Dictionary<string, Button> versionButtons = new Dictionary<string, Button>();
        readonly Dictionary<string, Button> filterButtons = new Dictionary<string, Button>();
        readonly List<Foldout> sectionFolds = new List<Foldout>();
        List<JObject> entries = new List<JObject>();
        bool indexFromCache, allLoading, allLoaded, disposed;
        string shown, category = "all", query = "";
        int generation;   // bumps on every re-render; late image loads for an old render are dropped

        public ReleaseNotesWindow(bool auto)
        {
            this.auto = auto;
            current = ReleaseNotes.CurrentVersion;
            seenBefore = ReleaseNotes.SeenVersion;
            name = "se-release-notes";
            AddToClassList("se-notes");
            pickingMode = PickingMode.Position;
            focusable = true;

            var head = UiKit.El("se-notes-head", this);
            title = UiKit.Text("What's new", "se-notes-title", head);
            var close = UiKit.IconButton("close", () => ReleaseNotes.Close(), "Close (Esc)", head, 28);
            close.focusable = false;

            var tools = UiKit.El("se-notes-tools", this);
            search = new TextField();
            search.AddToClassList("field");
            search.AddToClassList("se-menu-field");
            search.AddToClassList("se-notes-search");
            search.textEdition.placeholder = "Search every version…  (Ctrl+F)";
            search.RegisterValueChangedCallback(e => { query = (e.newValue ?? "").Trim(); Refresh(); });
            tools.Add(search);
            filters = UiKit.El("se-notes-filters", this);
            Filter("all", "All");
            foreach (var (id, label) in ReleaseNotes.Categories) Filter(id, label);

            var main = UiKit.El("se-notes-main", this);
            sidebar = UiKit.El("se-notes-side", main);
            UiKit.Text("Versions", "se-notes-side-title", sidebar);
            versionList = new ScrollView(ScrollViewMode.Vertical) { horizontalScrollerVisibility = ScrollerVisibility.Hidden };
            versionList.AddToClassList("se-notes-versions");
            sidebar.Add(versionList);
            UiKit.Text("Loading…", "se-notes-caption", versionList);

            var col = UiKit.El("se-notes-col", main);
            meta = UiKit.Text("", "se-notes-meta", col);
            toc = UiKit.El("se-notes-toc", col);
            body = new ScrollView(ScrollViewMode.Vertical) { horizontalScrollerVisibility = ScrollerVisibility.Hidden, mouseWheelScrollSize = 38 };
            body.AddToClassList("se-notes-scroll");
            col.Add(body);
            UiKit.Text("Loading…", "se-notes-text", body);

            var foot = UiKit.El("se-notes-foot", this);
            UiKit.Text("↑ ↓ change version · Ctrl+F search · Esc close", "se-notes-keys", foot);
            UiKit.Button("Close", () => ReleaseNotes.Close(), foot, null, "se-menu-action");

            RegisterCallback<KeyDownEvent>(OnKey, TrickleDown.TrickleDown);
            UpdateFilters();
        }

        public void Dispose()
        {
            disposed = true;
            generation++;
            DropTextures();
        }

        void DropTextures()
        {
            foreach (var t in textures) if (t != null) UnityEngine.Object.Destroy(t);
            textures.Clear();
        }

        // ------------------------------------------------------------------ loading
        public async Task Load(string version)
        {
            bool mine = ReleaseNotes.ValidVersion(version);
            if (auto && mine)
            {
                // opened by itself after an update: only when this version has notes
                var (n, _, missing) = await ReleaseNotes.Fetch(version);
                if (disposed) return;
                if (n == null) { if (missing) ReleaseNotes.MarkSeen(version); ReleaseNotes.Close(); return; }
                loaded[version] = n;
            }
            var (list, fromCache) = await ReleaseNotes.FetchIndex();
            if (disposed) return;
            indexFromCache = fromCache;
            entries = list ?? new List<JObject>();
            // this version's notes may be known without an index (an old server, or a version not listed yet)
            if (mine && !entries.Any(e => (string)e["version"] == version))
            {
                if (!loaded.ContainsKey(version))
                {
                    var (n, _, _) = await ReleaseNotes.Fetch(version);
                    if (disposed) return;
                    if (n != null) loaded[version] = n;
                }
                if (loaded.TryGetValue(version, out var mineNotes)) entries.Insert(0, ReleaseNotes.EntryOf(mineNotes, version));
                entries.Sort((a, b) => ReleaseNotes.Compare((string)b["version"], (string)a["version"]));
            }
            if (entries.Count == 0)
            {
                // no index, nothing cached: try the published version's notes on their own (an old server)
                var (n, _, _) = await ReleaseNotes.Fetch("latest");
                if (disposed) return;
                if (n != null && ReleaseNotes.ValidVersion((string)n["version"]))
                {
                    loaded[(string)n["version"]] = n;
                    entries.Add(ReleaseNotes.EntryOf(n, (string)n["version"]));
                }
            }
            BuildVersionList();
            if (entries.Count == 0)
            {
                body.Clear();
                meta.text = "";
                UiKit.Text("The release notes couldn't be loaded. Connect to the internet and open What's new from the main menu.", "se-notes-text", body)
                    .style.whiteSpace = WhiteSpace.Normal;
                return;
            }
            string first = mine && entries.Any(e => (string)e["version"] == version) ? version : (string)entries[0]["version"];
            await Show(first);
        }

        async Task<JObject> Notes(string version)
        {
            if (loaded.TryGetValue(version, out var n)) return n;
            var (f, fromCache, _) = await ReleaseNotes.Fetch(version);
            if (f != null) loaded[version] = f;
            if (fromCache) offline.Add(version);
            return f;
        }

        /// <summary>Every version's notes (for search and the category filter); loaded once, in the background.</summary>
        async void LoadAll()
        {
            if (allLoaded || allLoading) return;
            allLoading = true;
            try
            {
                foreach (var e in entries.ToList())
                {
                    if (disposed) return;
                    await Notes((string)e["version"]);
                }
            }
            catch (Exception ex) { Debug.Log("[notes] load all: " + ex.Message); }
            allLoading = false;
            allLoaded = true;
            if (!disposed) Refresh();
        }

        // ------------------------------------------------------------------ the version list
        void BuildVersionList()
        {
            versionList.Clear();
            versionButtons.Clear();
            foreach (var e in entries)
            {
                string v = (string)e["version"];
                var b = new Button { text = "" };
                b.AddToClassList("se-notes-ver");
                b.focusable = false;
                var top = UiKit.El("se-notes-ver-top", b);
                UiKit.Text(v, "se-notes-ver-num", top);
                if (v == current) UiKit.Text("yours", "se-notes-badge se-notes-badge--yours", top);
                else if (IsNew(v)) UiKit.Text("new", "se-notes-badge se-notes-badge--new", top);
                if (e["draft"]?.Type == JTokenType.Boolean && (bool)e["draft"]) UiKit.Text("draft", "se-notes-badge", top);
                var t = UiKit.Text((string)e["title"] ?? "", "se-notes-ver-title", b);
                t.style.whiteSpace = WhiteSpace.Normal;
                UiKit.Text((string)e["date"] ?? "", "se-notes-ver-date", b);
                b.tooltip = v == current ? "The version you are running" : IsNew(v) ? "Newer than the last notes you read" : "";
                b.clicked += () => { ClearFilters(); _ = Show(v); };
                versionList.Add(b);
                versionButtons[v] = b;
            }
            if (indexFromCache) UiKit.Text("Offline: showing saved notes", "se-notes-caption se-notes-offline", versionList);
        }

        /// <summary>Newer than what the player last saw (not shown before any version was seen, e.g. a fresh install).</summary>
        bool IsNew(string v) => ReleaseNotes.ValidVersion(seenBefore) && ReleaseNotes.Compare(v, seenBefore) > 0;

        void Select(string v)
        {
            foreach (var kv in versionButtons) kv.Value.EnableInClassList("selected", kv.Key == v);
            if (v != null && versionButtons.TryGetValue(v, out var b)) versionList.ScrollTo(b);
        }

        void Step(int dir)
        {
            if (entries.Count == 0) return;
            int i = entries.FindIndex(e => (string)e["version"] == shown);
            int j = Mathf.Clamp(i < 0 ? 0 : i + dir, 0, entries.Count - 1);
            if (j == i) return;
            ClearFilters();
            _ = Show((string)entries[j]["version"]);
        }

        // ------------------------------------------------------------------ filters and search
        void Filter(string id, string label)
        {
            var b = new Button { text = "" };
            b.AddToClassList("se-notes-chip");
            b.focusable = false;
            UiKit.Text(label, "se-notes-chip-label", b);
            b.clicked += () => { category = category == id ? "all" : id; UpdateFilters(); Refresh(); };
            filters.Add(b);
            filterButtons[id] = b;
        }

        void UpdateFilters()
        {
            foreach (var kv in filterButtons) kv.Value.EnableInClassList("selected", kv.Key == category);
        }

        void ClearFilters()
        {
            bool had = query.Length > 0 || category != "all";
            category = "all";
            query = "";
            search.SetValueWithoutNotify("");
            UpdateFilters();
            if (had) shown = null;
        }

        bool Filtering => query.Length > 0 || category != "all";

        /// <summary>Re-render for the current query and category: one version, or the matches across all versions.</summary>
        void Refresh()
        {
            if (disposed) return;
            if (!Filtering) { if (shown != null) _ = Show(shown, true); else if (entries.Count > 0) _ = Show((string)entries[0]["version"], true); return; }
            LoadAll();
            RenderResults();
        }

        void OnKey(KeyDownEvent e)
        {
            bool typing = panel?.focusController?.focusedElement is TextField;
            if ((e.ctrlKey || e.commandKey) && e.keyCode == KeyCode.F || !typing && e.character == '/')
            {
                search.Focus();
                e.StopPropagation();
                return;
            }
            if (typing)
            {
                if (e.keyCode == KeyCode.Escape && search.value.Length > 0) { search.value = ""; e.StopPropagation(); }
                else if (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter || e.keyCode == KeyCode.DownArrow) { Focus(); e.StopPropagation(); }
                return;
            }
            switch (e.keyCode)
            {
                case KeyCode.UpArrow: case KeyCode.LeftBracket: Step(-1); e.StopPropagation(); break;
                case KeyCode.DownArrow: case KeyCode.RightBracket: Step(1); e.StopPropagation(); break;
                case KeyCode.PageDown: body.scrollOffset += new Vector2(0, body.contentViewport.layout.height * .9f); e.StopPropagation(); break;
                case KeyCode.PageUp: body.scrollOffset -= new Vector2(0, body.contentViewport.layout.height * .9f); e.StopPropagation(); break;
                case KeyCode.Home: body.scrollOffset = Vector2.zero; e.StopPropagation(); break;
            }
        }

        // ------------------------------------------------------------------ one version
        async Task Show(string version, bool keepScroll = false)
        {
            int gen = ++generation;
            shown = version;
            Select(version);
            var entry = entries.FirstOrDefault(e => (string)e["version"] == version);
            title.text = "What's new in " + version;
            if (!loaded.ContainsKey(version))
            {
                body.Clear(); toc.Clear();
                UiKit.Text("Loading…", "se-notes-text", body);
            }
            var notes = await Notes(version);
            if (disposed || gen != generation) return;
            float scroll = body.scrollOffset.y;
            body.Clear(); toc.Clear(); sectionFolds.Clear();
            DropTextures();
            if (notes == null)
            {
                meta.text = Meta(entry, false);
                UiKit.Text("These notes aren't saved on this computer yet. Connect to the internet to read them.", "se-notes-text", body).style.whiteSpace = WhiteSpace.Normal;
                if (entry != null) Para((string)entry["summary"], "se-notes-summary", body);
                return;
            }
            meta.text = Meta(entry ?? ReleaseNotes.EntryOf(notes, version), offline.Contains(version));
            try { Render(notes, version, gen); }
            catch (Exception e) { Debug.LogWarning("[notes] render: " + e); UiKit.Text("Some of these notes couldn't be shown.", "se-notes-caption", body); }
            if (keepScroll) body.schedule.Execute(() => body.scrollOffset = new Vector2(0, scroll)).ExecuteLater(1);
            else body.scrollOffset = Vector2.zero;
            if (version == current) ReleaseNotes.MarkSeen(version);
        }

        static string Meta(JObject e, bool offline)
        {
            if (e == null) return "";
            string date = (string)e["date"] ?? "", since = (string)e["since"] ?? "";
            return (string)e["title"] + (date.Length > 0 ? " · " + date : "") + (since.Length > 0 ? " · changes since " + since : "")
                + (offline ? " · offline copy" : "") + (e["draft"]?.Type == JTokenType.Boolean && (bool)e["draft"] ? " · draft" : "");
        }

        /// <summary>Sections in category order (stable within a category), each under its category heading.</summary>
        static List<(string cat, List<JObject> sections)> Grouped(JObject n)
        {
            var groups = new List<(string, List<JObject>)>();
            var all = (n["sections"] as JArray)?.OfType<JObject>().ToList() ?? new List<JObject>();
            foreach (var (id, _) in ReleaseNotes.Categories)
            {
                var g = all.Where(s => ReleaseNotes.CategoryOf(s) == id).ToList();
                if (g.Count > 0) groups.Add((id, g));
            }
            return groups;
        }

        void Render(JObject n, string version, int gen)
        {
            Para((string)n["summary"], "se-notes-summary", body);
            var groups = Grouped(n);
            var fixes = n["fixes"] as JArray;
            var anchors = new List<(string label, string cat, VisualElement target)>();
            foreach (var (cat, sections) in groups)
            {
                UiKit.Text(ReleaseNotes.CategoryLabel(cat), "se-notes-cat se-notes-cat--" + cat, body);
                foreach (var s in sections)
                {
                    var fold = Section(s, version, gen, body);
                    anchors.Add(((string)s["heading"] ?? "", cat, fold));
                }
            }
            if (fixes != null && fixes.Count > 0)
            {
                var fold = new Foldout { text = $"Smaller fixes ({fixes.Count})", value = false };
                fold.AddToClassList("se-notes-fixes");
                foreach (var f in fixes) Bullet((string)f, fold);
                body.Add(fold);
                anchors.Add(($"Smaller fixes ({fixes.Count})", "fixes", fold));
            }
            // the jump list: one chip per section, in reading order, coloured by category
            if (anchors.Count > 1)
            {
                UiKit.Text("Jump to", "se-notes-toc-label", toc);
                foreach (var (label, cat, target) in anchors)
                {
                    var t = target;
                    var b = new Button(() => { if (t is Foldout f) f.value = true; body.schedule.Execute(() => body.ScrollTo(t)).ExecuteLater(30); }) { text = "" };
                    b.AddToClassList("se-notes-jump");
                    b.AddToClassList("se-notes-jump--" + cat);
                    b.focusable = false;
                    b.tooltip = ReleaseNotes.CategoryLabel(cat);
                    UiKit.Text(label, "se-notes-jump-label", b);
                    toc.Add(b);
                }
                var all = new Button(() =>
                {
                    bool open = sectionFolds.Any(f => !f.value);
                    foreach (var f in sectionFolds) f.value = open;
                }) { text = "" };
                all.AddToClassList("se-notes-jump");
                all.AddToClassList("se-notes-jump--all");
                all.focusable = false;
                UiKit.Text("Collapse / expand all", "se-notes-jump-label", all);
                toc.Add(all);
            }
        }

        Foldout Section(JObject s, string version, int gen, VisualElement parent)
        {
            var fold = new Foldout { text = (string)s["heading"] ?? "", value = true };
            fold.AddToClassList("se-notes-section");
            parent.Add(fold);
            sectionFolds.Add(fold);
            if (s["blocks"] is JArray blocks) foreach (var bt in blocks) if (bt is JObject b) Block(b, version, gen, fold);
            Later(s, fold);
            return fold;
        }

        /// <summary>"Changed in 0.7.0: …" pointers: the section stays as shipped; clicking opens the later version.</summary>
        void Later(JObject s, VisualElement parent)
        {
            if (!(s["later"] is JArray later)) return;
            foreach (var lt in later)
            {
                if (!(lt is JObject l)) continue;
                string v = (string)l["version"];
                if (!ReleaseNotes.ValidVersion(v)) continue;
                var row = new Button { text = "" };
                row.AddToClassList("se-notes-later");
                row.focusable = false;
                bool known = entries.Any(e => (string)e["version"] == v);
                UiKit.Text("Changed in " + v, "se-notes-later-tag", row);
                Para((string)l["text"], "se-notes-later-text", row);
                if (known) { row.tooltip = "Open the " + v + " notes"; row.clicked += () => { ClearFilters(); _ = Show(v); }; }
                parent.Add(row);
            }
        }

        // ------------------------------------------------------------------ search results across versions
        void RenderResults()
        {
            int gen = ++generation;
            body.Clear(); toc.Clear(); sectionFolds.Clear();
            DropTextures();
            Select(null);
            string q = query.ToLowerInvariant();
            title.text = "Changelog";
            meta.text = (query.Length > 0 ? $"Searching for “{query}”" : "All versions")
                + (category != "all" ? " · " + ReleaseNotes.CategoryLabel(category) : "")
                + (allLoaded ? "" : " · loading every version…");
            int hits = 0;
            foreach (var e in entries)
            {
                string v = (string)e["version"];
                if (!loaded.TryGetValue(v, out var n) || n == null) continue;
                var head = (VisualElement)null;
                VisualElement Head()
                {
                    if (head != null) return head;
                    head = new Button(() => { ClearFilters(); _ = Show(v); }) { text = "" };
                    head.AddToClassList("se-notes-result-ver");
                    head.focusable = false;
                    UiKit.Text(v, "se-notes-ver-num", head);
                    UiKit.Text(((string)n["title"] ?? "") + ((string)n["date"] is string d && d.Length > 0 ? " · " + d : ""), "se-notes-result-title", head);
                    head.tooltip = "Open the " + v + " notes";
                    body.Add(head);
                    return head;
                }
                foreach (var (cat, sections) in Grouped(n))
                {
                    if (category != "all" && category != cat) continue;
                    foreach (var s in sections)
                    {
                        string heading = (string)s["heading"] ?? "";
                        if (q.Length == 0)
                        {
                            Head();
                            UiKit.Text(ReleaseNotes.CategoryLabel(cat), "se-notes-cat se-notes-cat--" + cat, body);
                            Section(s, v, gen, body);
                            hits++;
                            continue;
                        }
                        var lines = Lines(s).Where(t => t.ToLowerInvariant().Contains(q)).ToList();
                        bool headingHit = heading.ToLowerInvariant().Contains(q);
                        if (!headingHit && lines.Count == 0) continue;
                        Head();
                        var box = UiKit.El("se-notes-result", body);
                        var h = UiKit.Text(Mark(heading, q) + "  <color=#96A4A0><size=11>" + ReleaseNotes.CategoryLabel(cat) + "</size></color>", "se-notes-result-heading", box);
                        h.enableRichText = true;
                        foreach (var t in (lines.Count > 0 ? lines : Lines(s).Take(2)).Take(8)) MarkedBullet(t, q, box);
                        hits++;
                    }
                }
                if ((category == "all" || category == "fixes") && n["fixes"] is JArray fixes)
                {
                    var fl = fixes.Select(f => (string)f ?? "").Where(t => q.Length == 0 || t.ToLowerInvariant().Contains(q)).ToList();
                    if (fl.Count > 0)
                    {
                        Head();
                        var box = UiKit.El("se-notes-result", body);
                        UiKit.Text("Smaller fixes", "se-notes-result-heading", box);
                        foreach (var t in fl) MarkedBullet(t, q, box);
                        hits++;
                    }
                }
            }
            if (hits == 0)
                UiKit.Text(allLoaded ? "Nothing in the changelog matches that." : "Searching…", "se-notes-text", body);
            body.scrollOffset = Vector2.zero;
        }

        /// <summary>The searchable lines of a section: text, bullets, chart and table titles/captions/rows, "changed in".</summary>
        static IEnumerable<string> Lines(JObject s)
        {
            if (s["blocks"] is JArray blocks)
                foreach (var bt in blocks)
                {
                    if (!(bt is JObject b)) continue;
                    switch ((string)b["type"])
                    {
                        case "text": yield return (string)b["text"] ?? ""; break;
                        case "bullets": if (b["items"] is JArray items) foreach (var t in items) yield return (string)t ?? ""; break;
                        case "comparison":
                            if (b["title"] != null) yield return (string)b["title"];
                            if (b["rows"] is JArray rows)
                                foreach (var r in rows.OfType<JObject>()) yield return $"{(string)r["label"]}: {(string)r["before"]} → {(string)r["after"]}";
                            if (b["caption"] != null) yield return (string)b["caption"];
                            break;
                        case "chart":
                            if (b["title"] != null) yield return (string)b["title"];
                            if (b["caption"] != null) yield return (string)b["caption"];
                            break;
                        case "image": if (b["caption"] != null) yield return (string)b["caption"]; break;
                    }
                }
            if (s["later"] is JArray later)
                foreach (var l in later.OfType<JObject>()) yield return $"Changed in {(string)l["version"]}: {(string)l["text"]}";
        }

        /// <summary>Rich text with every match of <paramref name="q"/> highlighted (text with markup of its own is left plain).</summary>
        static string Mark(string text, string q)
        {
            text = text ?? "";
            if (q.Length == 0 || text.IndexOf('<') >= 0) return text;
            var sb = new StringBuilder();
            int i = 0;
            while (i < text.Length)
            {
                int k = text.IndexOf(q, i, StringComparison.OrdinalIgnoreCase);
                if (k < 0) { sb.Append(text, i, text.Length - i); break; }
                sb.Append(text, i, k - i).Append("<mark=#E2B66066><color=#FFF3D6>").Append(text, k, q.Length).Append("</color></mark>");
                i = k + q.Length;
            }
            return sb.ToString();
        }

        static void MarkedBullet(string text, string q, VisualElement parent)
        {
            var l = Para("•  " + Mark(text, q), "se-notes-bullet", parent);
            if (l != null) l.enableRichText = true;
        }

        // ------------------------------------------------------------------ blocks
        static Label Para(string text, string cls, VisualElement parent)
        {
            if (string.IsNullOrEmpty(text)) return null;
            var l = UiKit.Text(text, cls, parent);
            l.style.whiteSpace = WhiteSpace.Normal;
            l.enableRichText = false;
            return l;
        }

        static void Bullet(string text, VisualElement parent) => Para("•  " + text, "se-notes-bullet", parent);

        void Block(JObject b, string version, int gen, VisualElement parent)
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
                        Picture(version, gen, b["before"] as JObject, "Before", pair).AddToClassList("se-notes-pair-item");
                        Picture(version, gen, b["after"] as JObject, "After", pair).AddToClassList("se-notes-pair-item");
                    }
                    Para(Caption(b), "se-notes-caption", parent);
                    break;
                case "image": Picture(version, gen, b, null, parent); break;
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
            // every cell exists, even empty (the header's label cell), so the columns line up
            Cell(label, "se-notes-cell se-notes-cell--label", row);
            Cell(before, "se-notes-cell", row);
            Cell(after, "se-notes-cell se-notes-cell--after", row);
        }

        static void Cell(string text, string cls, VisualElement row)
        {
            var l = UiKit.Text(text ?? "", cls, row);
            l.style.whiteSpace = WhiteSpace.Normal;
            l.enableRichText = false;
        }

        /// <summary>An image with its caption: a placeholder until it loads, a short note if it can't.</summary>
        VisualElement Picture(string version, int gen, JObject img, string tag, VisualElement parent)
        {
            var box = UiKit.El("se-notes-figure", parent);
            var frame = UiKit.El("se-notes-image", box);
            frame.style.height = 200;
            var status = UiKit.Text("Loading image…", "se-notes-caption", frame);
            string file = (string)img?["image"];
            string cap = (string)img?["caption"] ?? "";
            Para(tag != null ? tag + (cap.Length > 0 ? ": " + cap : "") : cap, "se-notes-caption", box);
            if (img?["alt"] != null) frame.tooltip = (string)img["alt"];
            _ = LoadPicture(version, gen, file, frame, status);
            return box;
        }

        async Task LoadPicture(string version, int gen, string file, VisualElement frame, Label status)
        {
            Texture2D tex = null;
            try { tex = await ReleaseNotes.Image(version, file); } catch (Exception e) { Debug.Log("[notes] image: " + e.Message); }
            if (disposed || gen != generation) { if (tex != null) UnityEngine.Object.Destroy(tex); return; }
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
