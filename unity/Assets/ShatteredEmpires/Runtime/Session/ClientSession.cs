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

        /// <summary>Raised before terrain arrays change (renderers must finish jobs reading them).</summary>
        public Action BeforeGeometryChange;
        public event Action Welcomed;
        public event Action<ServerMessage> Other;

        // presentation records with revisions (renderers rebuild only when these change)
        public TrenchRecord[] Trenches = System.Array.Empty<TrenchRecord>();
        public RuinRecord[] Ruins = System.Array.Empty<RuinRecord>();
        public BattlefieldState Battlefield = new BattlefieldState();
        public WeatherState Weather;
        public int TrenchRevision, RuinRevision, BattlefieldRevision, WeatherRevision;
        /// <summary>Server definitions from the welcome (BUILDINGS, UNITS, TECHS, AGES ...).</summary>
        public JObject Defs => Welcome?.Defs;

        public readonly HashSet<int> DirtyChunks = new HashSet<int>();
        public readonly HashSet<int> DirtyCells = new HashSet<int>();
        public readonly List<CombatEvent> Events = new List<CombatEvent>();
        public readonly List<(float time, string text, string level)> Notes = new List<(float, string, string)>();
        /// <summary>Where and what each note is about (same index as <see cref="Notes"/>).</summary>
        public readonly List<NoteInfo> NoteMeta = new List<NoteInfo>();
        public struct NoteInfo { public int Tile; public string Kind, Title; }
        /// <summary>The map location of the most recent important alert (-1: none), for "jump to alert".</summary>
        public int LastAlertTile = -1;
        /// <summary>Notes received in all (keeps counting after old ones are trimmed from the list).</summary>
        public long NotesTotal;
        readonly Dictionary<int, float4> civColors = new Dictionary<int, float4>();
        readonly System.Diagnostics.Stopwatch sw = new System.Diagnostics.Stopwatch();

        public float4 CivColor(int id)
        {
            if (civColors.TryGetValue(id, out var c)) return c;
            // unknown owners (rebels, unexplored civs) in muted greys
            return id < 0 ? new float4(0.55f, 0.55f, 0.52f, 0) : new float4(0.5f, 0.45f, 0.4f, 0);
        }

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
                case "s": if (World.Ready) ApplySnapshot(m.Snapshot); break;
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
                PlayRate = w.Speed; Paused = w.Paused;
                softGeo = true;
                Welcomed?.Invoke();
                return;
            }
            softGeo = false;
            Objectives.Clear(); Pickups.Clear(); ActionPlan = null; Econ = null; Age = 0;
            Trenches =System.Array.Empty<TrenchRecord>(); Ruins = System.Array.Empty<RuinRecord>(); Battlefield = new BattlefieldState(); Weather = null;
            TrenchRevision++; RuinRevision++; BattlefieldRevision++; WeatherRevision++;
            BeforeGeometryChange?.Invoke();
            Welcome = w;
            CivId = w.CivId;
            PlayRate = w.Speed;
            Paused = w.Paused;
            civColors.Clear();
            foreach (var c in w.Civs)
            {
                var col = new Color(((c.Color >> 16) & 255) / 255f, ((c.Color >> 8) & 255) / 255f, (c.Color & 255) / 255f);
                civColors[c.Id] = new float4(col.r, col.g, col.b, 0);
            }
            World.ActionLandscape = w.Ruleset == "action-v2";
            World.Reset(w.W, w.H, w.Wrap);
            Units.Reset(World.Grid);
            Structures.Clear();
            Events.Clear();
            DirtyChunks.Clear(); DirtyCells.Clear();
            Welcomed?.Invoke();
        }

        public void ApplyGeo(GeoMessage g)
        {
            BeforeGeometryChange?.Invoke();
            GeoMessages++;
            bool keep = softGeo && g.Full;
            if (g.Full) softGeo = false;
            foreach (int c in World.ApplyGeo(g, keep)) { DirtyChunks.Add(c); DirtyCells.Add(c); }
        }

        public void ApplySnapshot(SnapshotMessage s)
        {
            Snapshots++;
            if (s.Reset)
            {
                // the server re-sent the view (e.g. a spectator changed whose fog they watch); keep the camera
                BeforeGeometryChange?.Invoke();
                World.Reset(World.Grid.W, World.Grid.H, World.Grid.Wrap);
                Units.Reset(World.Grid);
                Structures.Clear();
            }
            if (s.Observer != null)
            {
                CivId = ProtocolDecoder.Int(s.Observer["follow"], CivId);
                PlayRate = ProtocolDecoder.Float(s.Observer["speed"], PlayRate);
                ObserverFog = ProtocolDecoder.Bool(s.Observer["fog"]);
            }
            if (s.Tiles != null) World.ApplyTiles(s.Tiles, null, DirtyCells);
            if (s.Visibility != null) World.ApplyVisibility(s.Visibility);
            if (s.Urban != null) World.ApplyUrban(s.Urban, DirtyCells);
            Units.Apply(s);
            if (s.Objectives != null)
            {
                Objectives.Clear();
                foreach (var site in s.Objectives) Objectives[site.Id] = site;
            }
            if (s.Pickups != null)
            { Pickups.Clear(); foreach (var pickup in s.Pickups) Pickups[pickup.Id] = pickup; }
            if (s.Events != null) Events.AddRange(s.Events);
            if (s.WeatherState != null) { Weather = s.WeatherState; WeatherRevision++; }
            if (s.HasEcon)
            {
                if (s.Trenches != null) { Trenches = s.Trenches; TrenchRevision++; World.ApplyTrenches(Trenches, BeforeGeometryChange, DirtyChunks, DirtyCells); }
                if (s.Ruins != null && (s.Ruins.Length != Ruins.Length || RuinsChanged(s.Ruins))) { Ruins = s.Ruins; RuinRevision++; }
                if (s.BattlefieldState != null)
                {
                    Battlefield = s.BattlefieldState; BattlefieldRevision++;
                    World.ApplyImpacts(Battlefield.Impacts, BeforeGeometryChange, DirtyChunks, DirtyCells);
                }
                Econ = s.Econ;
                ActionPlan = s.ActionPlan;
                if (Econ != null) Age = ProtocolDecoder.Int(Econ["age"], Age);
                if (s.Buildings != null) Structures.ApplyBuildings(s.Buildings, World, DirtyCells);
                if (s.Cities != null) Structures.ApplyCities(s.Cities, World, DirtyCells);
            }
        }
    }
}
