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

        public readonly HashSet<int> DirtyChunks = new HashSet<int>();
        public readonly HashSet<int> DirtyCells = new HashSet<int>();
        public readonly List<CombatEvent> Events = new List<CombatEvent>();
        public readonly List<(float time, string text, string level)> Notes = new List<(float, string, string)>();
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
                    if (Notes.Count > 200) Notes.RemoveRange(0, Notes.Count - 200);
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

        public void ApplyWelcome(WelcomeMessage w)
        {
            BeforeGeometryChange?.Invoke();
            Welcome = w;
            CivId = w.CivId;
            PlayRate = w.Speed;
            Paused = w.Paused;
            civColors.Clear();
            foreach (var c in w.Civs)
            {
                var col = new Color(((c.Color >> 16) & 255) / 255f, ((c.Color >> 8) & 255) / 255f, (c.Color & 255) / 255f).linear;
                civColors[c.Id] = new float4(col.r, col.g, col.b, 0);
            }
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
            foreach (int c in World.ApplyGeo(g)) { DirtyChunks.Add(c); DirtyCells.Add(c); }
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
            }
            if (s.Tiles != null) World.ApplyTiles(s.Tiles, null);
            if (s.Visibility != null) World.ApplyVisibility(s.Visibility);
            if (s.Urban != null) World.ApplyUrban(s.Urban);
            Units.Apply(s);
            if (s.Events != null) Events.AddRange(s.Events);
            if (s.HasEcon)
            {
                Econ = s.Econ;
                if (Econ != null) Age = ProtocolDecoder.Int(Econ["age"], Age);
                if (s.Buildings != null) Structures.ApplyBuildings(s.Buildings, World, DirtyCells);
                if (s.Cities != null) Structures.ApplyCities(s.Cities, World, DirtyCells);
            }
        }
    }
}
