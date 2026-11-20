using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Core.Units;
using SE.Core.World;
using SE.Net;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Everything the server has told this viewer, applied in wire order: welcome, terrain geometry,
    /// tile records, visibility, units (full and delta), economy, buildings and cities, combat events
    /// and notes. Presentation systems read from here and react to revisions; nothing is simulated.
    /// The same apply path serves live matches and the offline stress scenario.
    /// </summary>
    public sealed class ClientSession
    {
        public readonly WorldModel World = new WorldModel();
        public readonly UnitStore Units = new UnitStore(new UnitTypes());
        public readonly StructureStore Structures = new StructureStore();
        public GameConnection Net;

        public WelcomeMessage Welcome { get; private set; }
        public int CivId { get; private set; } = -1;
        public bool Spectator => Welcome?.Spectator ?? false;
        public bool ActionRts => Welcome?.Ruleset == "action-v2";
        public readonly Dictionary<int, ResourcePickup> Pickups = new Dictionary<int, ResourcePickup>();
        public readonly Dictionary<int, ObjectiveSite> Objectives = new Dictionary<int, ObjectiveSite>();
        public JObject ActionPlan;
        public bool ObserverFog;
        public bool IsHostile(int owner)
        {
            if (owner < 0 || owner == CivId) return false;
            if (!ActionRts) return true;
            int a = -1, b = -2;
            foreach (var civ in Welcome.Civs) { if (civ.Id == CivId) a = civ.Team; if (civ.Id == owner) b = civ.Team; }
            return a != b;
        }
        public bool Ready => Welcome != null && World.Ready;
        public float PlayRate = 1;
        public bool Paused;
        public JObject Econ;
        public int Age;
        public string StatusText = "";
        public string LastError;
        public int GeoMessages, Snapshots;
        public double ApplyMs;
        /// <summary>B7 (2026-11-19): the server's measured pace (simulated seconds per real second, the econ snapshots' 'pace'); -1 unknown.</summary>
        public float Pace = -1;
        /// <summary>Scale pass (2026-11-20): the last server 'perf' block (null until one arrives) and the snapshot count it came with.</summary>
        public ServerPerf ServerPerf;
        public int ServerPerfSnapshot;
        /// <summary>The rate the playback clock runs at: the chosen speed, or the measured pace when the server falls clearly behind it.</summary>
        public float ClockRate => Pace > 0 && Pace < PlayRate * 0.9f ? Pace : PlayRate;
        /// <summary>The server announced the end of the match ('over'); cleared by a new match's welcome.</summary>
        public bool MatchOver;
        /// <summary>Telemetry: cumulative snapshot decode (off the main thread) and apply times, and keyed resyncs asked for.</summary>
        public double SnapshotDecodeMsTotal, SnapshotDecodeMsMax, SnapshotApplyMsTotal, SnapshotApplyMsMax;
        public int KeyedResyncs;

        /// <summary>Raised before terrain arrays change (renderers must finish jobs reading them).</summary>
        public Action BeforeGeometryChange;
        /// <summary>
        /// True while terrain jobs are reading the world's geometry arrays (craters, trenches, heights). Geometry
        /// updates that arrive meanwhile are queued, in arrival order, and applied by <see cref="FlushGeometry"/> once
        /// the jobs have finished on their own, instead of blocking the main thread on them (perf 2026-11-17:
        /// waiting here cost 0.3-1.2 s frames in late-match combat).
        /// </summary>
        public Func<bool> GeometryBusy;
        readonly List<Action> deferredGeometry = new List<Action>();
        public bool GeometryDeferred => deferredGeometry.Count > 0;

        /// <summary>Apply queued geometry updates; unless forced, only when no terrain job is reading the arrays.</summary>
        public void FlushGeometry(bool force)
        {
            if (deferredGeometry.Count == 0) return;
            if (!force && GeometryBusy != null && GeometryBusy()) return;
            if (force) BeforeGeometryChange?.Invoke();
            // an action may not queue another (the queue is drained in one go)
            var batch = deferredGeometry.ToArray();
            deferredGeometry.Clear();
            foreach (var a in batch) a();
        }

        /// <summary>Run a geometry update now when the arrays are free (and nothing is queued ahead of it), else queue it.</summary>
        void Geometry(Action apply)
        {
            if (PerfFlags.LegacyGeometry || deferredGeometry.Count == 0 && (GeometryBusy == null || !GeometryBusy())) apply();
            else deferredGeometry.Add(apply);
        }
        public event Action Welcomed;
        public event Action<ServerMessage> Other;

        // presentation records with revisions (renderers rebuild only when these change)
        public TrenchRecord[] Trenches = System.Array.Empty<TrenchRecord>();
        public RuinRecord[] Ruins = System.Array.Empty<RuinRecord>();
        public BattlefieldState Battlefield = new BattlefieldState();
        public WeatherState Weather;
        public int TrenchRevision, RuinRevision, BattlefieldRevision, WeatherRevision;

        // Pass 4 keyed deltas (capability econ-delta-v1, server/delta.js): the versions of sites, buildings and battlefield
        // held, and the battlefield grouped by tile. A delta applies only on top of the version it follows; anything else
        // is a gap: the delta is dropped and the server is asked (at most every 2 s) to send the fields whole.
        readonly BattlefieldStore battlefieldStore = new BattlefieldStore();
        int sitesVersion = -1, buildingsVersion = -1;
        long resyncAskedAt;
        readonly List<int> anchoredSites = new List<int>();
        /// <summary>Diagnostics: keyed deltas dropped because they did not follow the version held.</summary>
        public int KeyedGaps;

        void ResetKeyed() { sitesVersion = buildingsVersion = -1; battlefieldStore.Clear(); }

        void KeyedGap()
        {
            KeyedGaps++;
            long now = System.Diagnostics.Stopwatch.GetTimestamp();
            if (resyncAskedAt != 0 && now - resyncAskedAt < 2 * System.Diagnostics.Stopwatch.Frequency) return;
            resyncAskedAt = now;
            KeyedResyncs++;
            Net?.Command(new JObject { ["c"] = "resync" });
        }

        /// <summary>Tenure and maturity of sites sent with time anchors follow the snapshot clock.</summary>
        void RederiveSites(float time)
        {
            anchoredSites.Clear();
            foreach (var kv in Objectives) if (kv.Value.HasTenureAnchor || kv.Value.MaturityLive) anchoredSites.Add(kv.Key);
            foreach (int id in anchoredSites) { var o = Objectives[id]; o.Rederive(time); Objectives[id] = o; }
        }
        /// <summary>Server definitions from the welcome (BUILDINGS, UNITS, TECHS, AGES ...).</summary>
        public JObject Defs => Welcome?.Defs;

        public readonly HashSet<int> DirtyChunks = new HashSet<int>();
        public readonly HashSet<int> DirtyCells = new HashSet<int>();
        public readonly List<CombatEvent> Events = new List<CombatEvent>();
        public readonly List<(float time, string text, string level)> Notes = new List<(float, string, string)>();
        /// <summary>Where and what each note is about (same index as <see cref="Notes"/>).</summary>
        public readonly List<NoteInfo> NoteMeta = new List<NoteInfo>();
        public struct NoteInfo { public int Tile; public string Kind, Title; }

        /// <summary>
        /// A note raised by the client itself (e.g. a storm over one of our air bases, WeatherPresenter), shown and
        /// pinged exactly like a server note of that level.
        /// </summary>
        public void LocalNote(string text, string level, int tile, string kind = "weather")
        {
            Notes.Add((Units.RenderTime, text, level));
            NoteMeta.Add(new NoteInfo { Tile = tile, Kind = kind });
            if (tile >= 0 && (level == "critical" || level == "major")) LastAlertTile = tile;
            NotesTotal++;
            if (Notes.Count > 200) { Notes.RemoveRange(0, Notes.Count - 200); NoteMeta.RemoveRange(0, NoteMeta.Count - 200); }
        }
        /// <summary>The map location of the most recent important alert (-1: none), for "jump to alert".</summary>
        public int LastAlertTile = -1;
        /// <summary>Notes received in all (keeps counting after old ones are trimmed from the list).</summary>
        public long NotesTotal;
        Dictionary<int, float4> civColors = new Dictionary<int, float4>();
        readonly System.Diagnostics.Stopwatch sw = new System.Diagnostics.Stopwatch();
        /// <summary>Diagnostics: cumulative and worst apply time per part (0 geo, 1 units+tiles, 2 trenches, 3 impacts, 4 buildings+cities).</summary>
        public readonly double[] PartMs = new double[5], PartMax = new double[5];
        long partAt;
        void PartStart() => partAt = System.Diagnostics.Stopwatch.GetTimestamp();
        void PartEnd(int k)
        {
            double ms = (System.Diagnostics.Stopwatch.GetTimestamp() - partAt) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            PartMs[k] += ms; if (ms > PartMax[k]) PartMax[k] = ms;
            partAt = System.Diagnostics.Stopwatch.GetTimestamp();
        }

        /// <summary>
        /// The colour of a civilization (linear rgb, w = 0). The action ruleset colours by relation to the
        /// viewer so units, building tints, markers, health bars and the minimap all agree: you are always
        /// blue, team-mates teal, each enemy a distinct warm hue (by order in the welcome's civ list),
        /// neutral / unowned sand. The legacy ruleset keeps the server's civ colours.
        /// UI code converts with <c>new Color(c.x, c.y, c.z).gamma</c>, which returns the sRGB palette exactly.
        /// </summary>
        public float4 CivColor(int id)
        {
            var colors = civColors;   // swapped whole, never mutated after publication
            if (colors.TryGetValue(id, out var c)) return c;
            if (ActionRts) return id < 0 ? RelationNeutral : RelationEnemy(id);
            // unknown owners (rebels, unexplored civs) in muted greys
            return id < 0 ? new float4(0.55f, 0.55f, 0.52f, 0) : new float4(0.5f, 0.45f, 0.4f, 0);
        }

        /// <summary>Relation palette (sRGB bytes, see docs/UI_DESIGN_SPEC.md B0/B5).</summary>
        public static readonly Color32 PaletteFriendly = new Color32(74, 150, 255, 255);
        public static readonly Color32 PaletteAlly = new Color32(64, 200, 190, 255);
        public static readonly Color32 PaletteNeutral = new Color32(200, 170, 110, 255);
        public static readonly Color32[] PaletteEnemies =
        {
            new Color32(232, 72, 60, 255), new Color32(240, 140, 40, 255), new Color32(210, 70, 180, 255),
            new Color32(230, 200, 50, 255), new Color32(150, 90, 230, 255),
        };
        static readonly float4 RelationNeutral = Linear(PaletteNeutral);

        static float4 Linear(Color32 c)
        {
            var l = ((Color)c).linear;
            return new float4(l.r, l.g, l.b, 0);
        }

        /// <summary>The n-th enemy's hue; beyond five the list repeats lightened so neighbours stay distinct.</summary>
        static float4 RelationEnemy(int n)
        {
            var c = (Color)PaletteEnemies[n % PaletteEnemies.Length];
            int round = n / PaletteEnemies.Length;
            if (round > 0) c = Color.Lerp(c, Color.white, Mathf.Min(0.6f, 0.28f * round));
            var l = c.linear;
            return new float4(l.r, l.g, l.b, 0);
        }

        /// <summary>
        /// Rebuild the civ colour table for the current viewer (welcome, rejoin, observer follow change).
        /// The table is built aside and swapped in whole so readers never see it half-written.
        /// </summary>
        void RebuildCivColors()
        {
            var next = new Dictionary<int, float4>();
            var w = Welcome;
            if (w != null)
            {
                if (w.Ruleset != "action-v2")
                {
                    foreach (var c in w.Civs)
                    {
                        var col = new Color(((c.Color >> 16) & 255) / 255f, ((c.Color >> 8) & 255) / 255f, (c.Color & 255) / 255f);
                        next[c.Id] = new float4(col.r, col.g, col.b, 0);
                    }
                }
                else
                {
                    int myTeam = int.MinValue;
                    bool haveMe = false;
                    foreach (var c in w.Civs) if (c.Id == CivId && CivId >= 0) { myTeam = c.Team; haveMe = true; }
                    int enemies = 0;
                    foreach (var c in w.Civs)
                    {
                        if (CivId >= 0 && c.Id == CivId) next[c.Id] = Linear(PaletteFriendly);
                        else if (haveMe && c.Team == myTeam && !c.Rebel) next[c.Id] = Linear(PaletteAlly);
                        else if (c.Rebel) next[c.Id] = RelationNeutral;
                        else next[c.Id] = RelationEnemy(enemies++);
                    }
                }
            }
            civColors = next;
            colorsFor = CivId;
        }
        int colorsFor = int.MinValue;

        public void Attach(GameConnection connection)
        {
            Net = connection;
            Net.Message += Apply;
        }

        public void Apply(ServerMessage m)
        {
            sw.Restart();
            switch (m.T)
            {
                case "welcome": ApplyWelcome(m.Welcome); break;
                case "geo": if (World.Ready) ApplyGeo(m.Geo); break;
                case "s":
                    if (World.Ready) ApplySnapshot(m.Snapshot);
                    SnapshotDecodeMsTotal += m.DecodeMs; if (m.DecodeMs > SnapshotDecodeMsMax) SnapshotDecodeMsMax = m.DecodeMs;
                    break;
                case "note":
                    Notes.Add((ProtocolDecoder.Float(m.Raw["time"]), ProtocolDecoder.Str(m.Raw["text"], ""), ProtocolDecoder.Str(m.Raw["level"], "info")));
                    NoteMeta.Add(new NoteInfo { Tile = ProtocolDecoder.Int(m.Raw["tile"], -1), Kind = ProtocolDecoder.Str(m.Raw["kind"], ""), Title = ProtocolDecoder.Str(m.Raw["title"]) });
                    {
                        string lv = ProtocolDecoder.Str(m.Raw["level"], "info");
                        int tile = ProtocolDecoder.Int(m.Raw["tile"], -1);
                        if (tile >= 0 && (lv == "critical" || lv == "major")) LastAlertTile = tile;
                    }
                    NotesTotal++;
                    if (Notes.Count > 200) { Notes.RemoveRange(0, Notes.Count - 200); NoteMeta.RemoveRange(0, NoteMeta.Count - 200); }
                    break;
                case "paused":
                    Paused = ProtocolDecoder.Bool(m.Raw["on"]);
                    if (m.Raw["speed"] != null && !Paused) PlayRate = ProtocolDecoder.Float(m.Raw["speed"], 1);
                    Pace = -1;   // a new speed: the next measured pace follows it
                    break;
                case "over":
                    MatchOver = true;
                    Other?.Invoke(m);
                    break;
                case "joined":
                    StatusText = ProtocolDecoder.Str(m.Raw["status"]) == "lobby" ? "Waiting in the match lobby…" : "Joined " + ProtocolDecoder.Str(m.Raw["match"], "");
                    Other?.Invoke(m);
                    break;
                case "error":
                    LastError = m.Error;
                    Other?.Invoke(m);
                    break;
                default:
                    Other?.Invoke(m);
                    break;
            }
            ApplyMs = sw.Elapsed.TotalMilliseconds;
            if (m.T == "s") { SnapshotApplyMsTotal += ApplyMs; if (ApplyMs > SnapshotApplyMsMax) SnapshotApplyMsMax = ApplyMs; }
        }

        bool RuinsChanged(RuinRecord[] next)
        {
            for (int i = 0; i < next.Length; i++) if (next[i].Tile != Ruins[i].Tile || next[i].Flags != Ruins[i].Flags || next[i].Type != Ruins[i].Type) return true;
            return false;
        }

        /// <summary>True when the last welcome re-entered the same match (a reconnect): nothing was cleared.</summary>
        public bool Rejoined { get; private set; }
        bool softGeo;

        public void ApplyWelcome(WelcomeMessage w)
        {
            // a reconnect to the same match keeps the world, units and buildings on screen; the server's
            // full re-send then only redraws what actually changed while we were away
            bool same = Welcome != null && World.Ready && w.Match == Welcome.Match && w.CivId == Welcome.CivId && World.Grid.W == w.W && World.Grid.H == w.H
                && World.Grid.Wrap == w.Wrap && !string.IsNullOrEmpty(w.Match) && w.Match != "menu" && w.Match != "stress" && w.Match != "intro";
            Rejoined = same;
            if (same)
            {
                Welcome = w;
                PlayRate = w.Speed; Paused = w.Paused; Pace = -1;
                RebuildCivColors();
                softGeo = true;
                Welcomed?.Invoke();
                return;
            }
            softGeo = false;
            deferredGeometry.Clear();   // updates for the world being replaced
            Objectives.Clear(); Pickups.Clear(); ActionPlan = null; Econ = null; Age = 0;
            ResetKeyed();
            Trenches =System.Array.Empty<TrenchRecord>(); Ruins = System.Array.Empty<RuinRecord>(); Battlefield = new BattlefieldState(); Weather = null;
            TrenchRevision++; RuinRevision++; BattlefieldRevision++; WeatherRevision++;
            BeforeGeometryChange?.Invoke();
            Welcome = w;
            CivId = w.CivId;
            PlayRate = w.Speed;
            Paused = w.Paused;
            Pace = -1; MatchOver = false;
            RebuildCivColors();
            World.ActionLandscape = w.Ruleset == "action-v2";
            World.Reset(w.W, w.H, w.Wrap);
            World.SetDense(w.Dense);   // §30 dense forest (welcome world.dense)
            Units.Reset(World.Grid);
            Structures.Clear();
            Events.Clear();
            DirtyChunks.Clear(); DirtyCells.Clear();
            Welcomed?.Invoke();
        }

        public void ApplyGeo(GeoMessage g) => Geometry(() => ApplyGeoNow(g));

        void ApplyGeoNow(GeoMessage g)
        {
            PartStart();
            BeforeGeometryChange?.Invoke();
            GeoMessages++;
            bool keep = softGeo && g.Full;
            if (g.Full) softGeo = false;
            foreach (int c in World.ApplyGeo(g, keep)) { DirtyChunks.Add(c); DirtyCells.Add(c); }
            PartEnd(0);
        }

        public void ApplySnapshot(SnapshotMessage s)
        {
            Snapshots++;
            PartStart();
            if (s.Reset)
            {
                // the server re-sent the view (e.g. a spectator changed whose fog they watch); keep the camera
                BeforeGeometryChange?.Invoke();
                deferredGeometry.Clear();   // the server re-sends the view after a reset
                World.Reset(World.Grid.W, World.Grid.H, World.Grid.Wrap);
                Units.Reset(World.Grid);
                Structures.Clear();
                ResetKeyed();
            }
            if (s.Observer != null)
            {
                CivId = ProtocolDecoder.Int(s.Observer["follow"], CivId);
                if (CivId != colorsFor) RebuildCivColors();   // relation colours follow the watched nation
                PlayRate = ProtocolDecoder.Float(s.Observer["speed"], PlayRate);
                ObserverFog = ProtocolDecoder.Bool(s.Observer["fog"]);
            }
            if (s.Pace >= 0) Pace = s.Pace;
            if (s.Perf != null) { ServerPerf = s.Perf; ServerPerfSnapshot = Snapshots; }
            if (s.Tiles != null) World.ApplyTiles(s.Tiles, null, DirtyCells);
            if (s.Visibility != null) World.ApplyVisibility(s.Visibility);
            if (s.Urban != null) World.ApplyUrban(s.Urban, DirtyCells);
            Units.Apply(s);
            if (s.Objectives != null)
            {
                Objectives.Clear();
                foreach (var site in s.Objectives) Objectives[site.Id] = site;
                sitesVersion = s.SitesVersion;
            }
            else if (s.SitesDelta != null)
            {
                var d = s.SitesDelta;
                if (sitesVersion >= 0 && d.Version == sitesVersion + 1)
                {
                    foreach (int id in d.Removed) Objectives.Remove(id);
                    foreach (var site in d.Updated) Objectives[site.Id] = site;
                    sitesVersion = d.Version;
                }
                else KeyedGap();
            }
            if (sitesVersion >= 0) RederiveSites(s.Time);
            if (s.Pickups != null)
            { Pickups.Clear(); foreach (var pickup in s.Pickups) Pickups[pickup.Id] = pickup; }
            if (s.Events != null) Events.AddRange(s.Events);
            if (s.WeatherState != null) { Weather = s.WeatherState; WeatherRevision++; }
            PartEnd(1);
            if (s.HasEcon)
            {
                if (s.Trenches != null)
                {
                    var trenches = s.Trenches;
                    Geometry(() => { Trenches = trenches; TrenchRevision++; World.ApplyTrenches(trenches, BeforeGeometryChange, DirtyChunks, DirtyCells); });
                }
                PartEnd(2);
                if (s.Ruins != null && (s.Ruins.Length != Ruins.Length || RuinsChanged(s.Ruins))) { Ruins = s.Ruins; RuinRevision++; }
                BattlefieldState bf = null;
                if (s.BattlefieldState != null)
                {
                    bf = s.BattlefieldState;
                    if (s.BattlefieldVersion >= 0) battlefieldStore.Reset(bf, s.BattlefieldVersion); else battlefieldStore.Clear();
                }
                else if (s.BattlefieldDelta != null)
                {
                    if (battlefieldStore.Version >= 0 && s.BattlefieldDelta.Version == battlefieldStore.Version + 1) { battlefieldStore.Apply(s.BattlefieldDelta); bf = battlefieldStore.Snapshot(); }
                    else KeyedGap();
                }
                // the battlefield and its craters change together (the warzone draws both)
                if (bf != null) Geometry(() => { Battlefield = bf; BattlefieldRevision++; World.ApplyImpacts(bf.Impacts, BeforeGeometryChange, DirtyChunks, DirtyCells); });
                PartEnd(3);
                Econ = s.Econ;
                ActionPlan = s.ActionPlan;
                if (Econ != null) Age = ProtocolDecoder.Int(Econ["age"], Age);
                if (s.Buildings != null) { Structures.ApplyBuildings(s.Buildings, World, DirtyCells); buildingsVersion = s.BuildingsVersion; }
                else if (s.BuildingsDelta != null)
                {
                    var d = s.BuildingsDelta;
                    if (buildingsVersion >= 0 && d.Version == buildingsVersion + 1) { Structures.ApplyBuildingChanges(d.Updated, d.Removed, World, DirtyCells); buildingsVersion = d.Version; }
                    else KeyedGap();
                }
                // building pads (2026-11-20): structures on a slope level the ground under them (WorldModel.ApplyPads)
                if (Structures.Revision != padRevision) { padRevision = Structures.Revision; Geometry(ApplyBuildingPads); }
                if (s.Cities != null) Structures.ApplyCities(s.Cities, World, DirtyCells);
                PartEnd(4);
            }
            // between econ frames the stockpile still arrives every snapshot, so the bars fill smoothly
            else if (s.Res != null && Econ != null) Econ["res"] = s.Res.DeepClone();
        }

        // building pads (2026-11-20): the footprints last applied, so a frame whose buildings moved nowhere costs one pass
        int padRevision = -1;
        long padKey;
        readonly List<WorldModel.PadSource> padSources = new List<WorldModel.PadSource>();

        /// <summary>Level the ground under every placed structure on a slope (WorldModel.ApplyPads); runs as a geometry update.</summary>
        void ApplyBuildingPads()
        {
            if (!World.Ready) return;
            long key = World.Epoch;
            padSources.Clear();
            var defs = Defs?["BUILDINGS"];
            foreach (var b in Structures.Buildings.Values)
            {
                if (!b.HasPosition || b.Type == null) continue;
                var def = defs?[b.Type];
                float radius = Mathf.Max(ProtocolDecoder.Float(def?["radius"], .3f), .5f * Mathf.Max(ProtocolDecoder.Float(def?["width"], 0), ProtocolDecoder.Float(def?["depth"], 0)));
                padSources.Add(new WorldModel.PadSource { X = b.X, Z = b.Z, Radius = radius + .05f });
                unchecked { key = key * 31 + b.Id; key = key * 31 + b.X.GetHashCode(); key = key * 31 + b.Z.GetHashCode(); key = key * 31 + (int)(radius * 1000); }
            }
            if (key == padKey) return;
            padKey = key;
            World.ApplyPads(padSources, BeforeGeometryChange, DirtyChunks, DirtyCells);
        }
    }
}
