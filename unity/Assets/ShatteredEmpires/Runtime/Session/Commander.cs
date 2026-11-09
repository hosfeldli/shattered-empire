using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.CameraControl;
using SE.Runtime.Input;
using SE.Runtime.Military;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Selection, orders and the map tools. Selection feedback is immediate and local; everything else is
    /// an intent sent to the server, shown as pending until the server accepts or refuses it. A refusal
    /// shows the server's reason; nothing is reported as refused unless the server said so, and a site
    /// already submitted is never submitted twice (fast clicking under load cannot double-place).
    /// </summary>
    public sealed class Commander : IDisposable
    {
        public enum Mode { Select, Place, Road, Bridge, Trench, Growth, Rally, Target }

        readonly ClientSession session;
        readonly RtsCamera cam;
        readonly UnitRenderer units;
        Vector2 dragStart;
        bool dragging;
        float lastClick;
        int lastClickTile = -1;

        public Mode Current { get; private set; } = Mode.Select;
        public string Option = "";              // building type, road class, trench type, growth kind
        public JObject TargetCommand;           // a catalogued action waiting for its map point
        public readonly HashSet<int> SelectedBuildings = new HashSet<int>();
        public int SelectedCity = -1;
        public readonly List<Order> Orders = new List<Order>();
        public string Feedback = "";
        public bool FeedbackGood;
        public float FeedbackUntil;
        public event Action SelectionChanged;

        // placement state
        readonly HashSet<int> legal = new HashSet<int>();
        bool legalReady;
        int placementToken;
        readonly Dictionary<int, float> pendingSites = new Dictionary<int, float>();
        readonly Dictionary<int, (string reason, float at)> refusedSites = new Dictionary<int, (string, float)>();
        // drawing state (roads, bridges, trenches, multi-site placement)
        readonly List<int> path = new List<int>();
        JObject preview;
        float previewAt;
        int hoverTile = -1;

        // overlay drawn in the world
        readonly InstanceBatch rings, discs;

        public sealed class Order
        {
            public Vector3 MapPoint;
            public int Rid;
            public string State = "pending";
            public string Reason;
            public float Time;
        }

        public Commander(ClientSession s, RtsCamera c, UnitRenderer u)
        {
            session = s; cam = c; units = u;
            rings = new InstanceBatch(MeshKit.Ring, RenderResources.Instanced, 512) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off, Buffering = 3 };
            discs = new InstanceBatch(MeshKit.Disc, RenderResources.Instanced, 512) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off, Buffering = 3 };
        }

        public void Say(string text, bool good, float time) { Feedback = text; FeedbackGood = good; FeedbackUntil = time + 3.5f; }

        // ------------------------------------------------------------------ modes
        public void Begin(Mode mode, string option = "", JObject target = null)
        {
            Current = mode; Option = option ?? ""; TargetCommand = target;
            path.Clear(); preview = null; legal.Clear(); legalReady = false;
            if (mode == Mode.Place && session.Net != null)
            {
                int token = ++placementToken;
                session.Net.Command(new JObject { ["c"] = "placement", ["type"] = option }, r =>
                {
                    if (token != placementToken) return;
                    legalReady = true;
                    if (r.Raw?["tiles"] is JArray tiles) foreach (var t in tiles) legal.Add((int)t);
                    bool afford = ProtocolDecoder.Bool(r.Raw?["afford"]);
                    Say(legal.Count == 0 ? (r.Error ?? "No legal site for this building in sight") : $"{legal.Count} sites · {(afford ? "affordable now" : "will wait in the construction queue")}", legal.Count > 0, Time.unscaledTime);
                });
            }
            else if (mode == Mode.Place) legalReady = false;
        }

        public void Cancel() { Current = Mode.Select; Option = ""; TargetCommand = null; path.Clear(); preview = null; legal.Clear(); }

        public bool Dragging(out Rect rect)
        {
            var p = InputFacade.MousePosition;
            rect = Rect.MinMaxRect(Mathf.Min(dragStart.x, p.x), Mathf.Min(dragStart.y, p.y), Mathf.Max(dragStart.x, p.x), Mathf.Max(dragStart.y, p.y));
            return dragging && Current == Mode.Select && rect.width > 6 && rect.height > 6;
        }

        bool ScreenOf(int slot, out Vector2 screen)
        {
            screen = default;
            ref var u = ref session.Units.Records[slot];
            if (!units.TryGetPosition(session.Units, u.Id, out var xz)) return false;
            var g = session.World.Grid;
            float x = g.NearX(xz.x, cam.Focus.x);
            var p = cam.ToScreen(new Vector3(x, session.World.GroundHeight(x, xz.y), xz.y));
            if (p.z <= 0) return false;
            screen = p;
            return true;
        }

        bool TileScreen(int tile, out Vector2 screen)
        {
            var g = session.World.Grid;
            float x = g.NearX(g.CenterX(tile), cam.Focus.x), z = g.CenterZ(tile);
            var p = cam.ToScreen(new Vector3(x, session.World.GroundHeight(x, z), z));
            screen = p;
            return p.z > 0;
        }

        /// <summary>The hex under the mouse, or -1 (for the Alt-held tile readout).</summary>
        public int HoverTile() => TileUnderCursor();

        int TileUnderCursor()
        {
            if (!cam.TryGround(InputFacade.MousePosition, out var gp)) return -1;
            return session.World.Grid.TileAt(gp.x, gp.z);
        }

        BuildingRecord? BuildingAt(int tile)
        {
            foreach (var b in session.Structures.Buildings.Values) if (b.Tile == tile) return b;
            return null;
        }

        // ------------------------------------------------------------------ frame
        public void Update(float time, bool pointerOverUi)
        {
            if (!session.Ready) return;
            var mouse = InputFacade.MousePosition;
            hoverTile = pointerOverUi ? -1 : TileUnderCursor();
            if (InputFacade.Pressed(KeyCode.Escape) && Current != Mode.Select) { Cancel(); return; }
            switch (Current)
            {
                case Mode.Select: SelectMode(time, mouse, pointerOverUi); break;
                case Mode.Place: PlaceMode(time, pointerOverUi); break;
                case Mode.Road: case Mode.Bridge: case Mode.Trench: DrawMode(time, pointerOverUi); break;
                case Mode.Growth: case Mode.Rally: case Mode.Target: PointMode(time, pointerOverUi); break;
            }
            Orders.RemoveAll(o => time - o.Time > (o.State == "pending" ? 8f : 1.5f));
            var stale = new List<int>();
            foreach (var kv in refusedSites) if (time - kv.Value.at > 2.5f) stale.Add(kv.Key);
            foreach (var t in stale) refusedSites.Remove(t);
            stale.Clear();
            foreach (var kv in pendingSites) if (time - kv.Value > 10f || BuildingAt(kv.Key) != null) stale.Add(kv.Key);
            foreach (var t in stale) pendingSites.Remove(t);
        }

        void SelectMode(float time, Vector2 mouse, bool overUi)
        {
            if (!overUi && InputFacade.LeftDown) { dragStart = mouse; dragging = true; }
            if (dragging && InputFacade.LeftUp)
            {
                dragging = false;
                bool add = InputFacade.Shift;
                var rect = Rect.MinMaxRect(Mathf.Min(dragStart.x, mouse.x), Mathf.Min(dragStart.y, mouse.y), Mathf.Max(dragStart.x, mouse.x), Mathf.Max(dragStart.y, mouse.y));
                bool box = rect.width > 6 && rect.height > 6;
                int tile = TileUnderCursor();
                bool doubleClick = !box && time - lastClick < 0.32f && tile == lastClickTile;
                lastClick = time; lastClickTile = tile;
                if (!add) { units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1; }
                int best = -1; float bestD = 18f * 18f; int bestType = -1;
                var st = session.Units;
                for (int s = 0; s < st.SlotCount; s++)
                {
                    ref var u = ref st.Records[s];
                    if (!u.InUse || (u.Owner != session.CivId && !session.Spectator)) continue;
                    if (!ScreenOf(s, out var sp)) continue;
                    if (box) { if (rect.Contains(sp)) units.Selected.Add(u.Id); continue; }
                    float d = (sp - mouse).sqrMagnitude;
                    if (d < bestD) { bestD = d; best = u.Id; bestType = u.TypeIndex; }
                }
                if (best >= 0)
                {
                    units.Selected.Add(best);
                    if (doubleClick)
                        for (int s = 0; s < st.SlotCount; s++)
                        {
                            ref var u = ref st.Records[s];
                            if (u.InUse && u.Owner == session.CivId && u.TypeIndex == bestType && ScreenOf(s, out var sp) && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height) units.Selected.Add(u.Id);
                        }
                }
                else if (!box && tile >= 0 && BuildingAt(tile) is BuildingRecord b && (b.Owner == session.CivId || session.Spectator))
                {
                    // buildings: a click selects one; a double-click every building of that type on screen
                    if (b.Type == "town")
                    {
                        foreach (var c in session.Structures.Cities.Values) if (c.Tile == tile) SelectedCity = c.Id;
                    }
                    SelectedBuildings.Add(b.Id);
                    if (doubleClick)
                        foreach (var o in session.Structures.Buildings.Values)
                            if (o.Owner == b.Owner && o.Type == b.Type && TileScreen(o.Tile, out var sp) && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height) SelectedBuildings.Add(o.Id);
                }
                SelectionChanged?.Invoke();
            }
            units.Selected.RemoveWhere(id => !session.Units.SlotOf.ContainsKey(id));
            SelectedBuildings.RemoveWhere(id => !session.Structures.Buildings.ContainsKey(id));
            if (!overUi && InputFacade.RightDown && units.Selected.Count > 0 && cam.TryGround(InputFacade.MousePosition, out var ground))
            {
                int tile = session.World.Grid.TileAt(ground.x, ground.z);
                if (tile >= 0) Move(tile, ground, InputFacade.Shift || InputFacade.Ctrl, time);
            }
            else if (!overUi && InputFacade.RightDown && SelectedBuildings.Count > 0 && units.Selected.Count == 0)
            {
                int tile = TileUnderCursor();
                if (tile >= 0) SetRally(tile, time);
            }
            if (units.Selected.Count > 0)
            {
                if (InputFacade.Pressed(KeyCode.H)) UnitCommand("hold", null, "Holding position");
                if (InputFacade.Pressed(KeyCode.X)) UnitCommand("withdraw", null, "Withdrawing");
            }
        }

        // ------------------------------------------------------------------ building placement
        void PlaceMode(float time, bool overUi)
        {
            if (overUi) return;
            if (InputFacade.RightDown) { Cancel(); return; }
            if (InputFacade.LeftDown) { path.Clear(); dragging = true; }
            if (dragging && hoverTile >= 0 && (path.Count == 0 || path[path.Count - 1] != hoverTile) && !path.Contains(hoverTile)) path.Add(hoverTile);
            if (dragging && InputFacade.LeftUp)
            {
                dragging = false;
                var sites = new List<int>();
                foreach (var t in path) if ((legal.Contains(t) || !legalReady) && !pendingSites.ContainsKey(t)) sites.Add(t);
                if (sites.Count > 1) PlaceMany(sites, time);
                else if (path.Count >= 1) PlaceOne(path[path.Count - 1], time);
                path.Clear();
            }
        }

        void PlaceOne(int tile, float time)
        {
            if (pendingSites.ContainsKey(tile)) return;   // already submitted: never send a duplicate
            if (legalReady && !legal.Contains(tile)) { Say("Choose one of the highlighted sites", false, time); return; }
            string type = Option;
            pendingSites[tile] = time;
            legal.Remove(tile);
            bool keep = InputFacade.Shift;
            session.Net?.Command(new JObject { ["c"] = "build", ["tile"] = tile, ["type"] = type, ["plan"] = true }, r =>
            {
                pendingSites.Remove(tile);
                if (r.Error != null) { refusedSites[tile] = (r.Error, Time.unscaledTime); legal.Add(tile); Say(r.Error, false, Time.unscaledTime); return; }
                bool planned = ProtocolDecoder.Bool(r.Raw?["built"]?["planned"]);
                Say(planned ? "Site placed · waiting for materials" : "Construction site placed", true, Time.unscaledTime);
                if (!keep && Current == Mode.Place && Option == type) Cancel();
            });
        }

        void PlaceMany(List<int> sites, float time)
        {
            foreach (var t in sites) { pendingSites[t] = time; legal.Remove(t); }
            session.Net?.Command(new JObject { ["c"] = "buildMany", ["type"] = Option, ["tiles"] = new JArray(sites.ToArray()) }, r =>
            {
                foreach (var t in sites) pendingSites.Remove(t);
                if (r.Error != null) { Say(r.Error, false, Time.unscaledTime); return; }
                var many = r.Raw?["many"] as JObject;
                int placed = ProtocolDecoder.Int(many?["placed"], sites.Count), planned = ProtocolDecoder.Int(many?["planned"]), failed = ProtocolDecoder.Int(many?["failed"]);
                if (many?["failedTiles"] is JArray ft) foreach (JArray f in ft) refusedSites[(int)f[0]] = (ProtocolDecoder.Str(f[1], ""), Time.unscaledTime);
                Say($"{placed} sites placed" + (planned > 0 ? $" · {planned} wait for materials" : "") + (failed > 0 ? $" · {failed} refused" : ""), failed == 0, Time.unscaledTime);
            });
        }

        // ------------------------------------------------------------------ roads, bridges, trenches
        void DrawMode(float time, bool overUi)
        {
            if (overUi && !dragging) return;
            if (InputFacade.RightDown) { Cancel(); return; }
            if (InputFacade.LeftDown && !overUi) { path.Clear(); preview = null; dragging = true; }
            if (dragging && hoverTile >= 0 && (path.Count == 0 || path[path.Count - 1] != hoverTile))
            {
                if (Current == Mode.Bridge && path.Count >= 2) path[1] = hoverTile; else path.Add(hoverTile);
                if (time > previewAt) { previewAt = time + 0.25f; Plan(false, time); }
            }
            if (dragging && InputFacade.LeftUp)
            {
                dragging = false;
                if (path.Count >= 1) Plan(true, time);
            }
        }

        JObject PlanCommand(bool commit)
        {
            switch (Current)
            {
                case Mode.Road: return new JObject { ["c"] = "roadPlan", ["tiles"] = new JArray(path.ToArray()), ["type"] = int.TryParse(Option, out int t) ? t : 1, ["auto"] = true, ["commit"] = commit };
                case Mode.Bridge: return new JObject { ["c"] = "bridgePlan", ["from"] = path[0], ["to"] = path[path.Count - 1], ["cls"] = string.IsNullOrEmpty(Option) ? "road" : Option, ["commit"] = commit };
                default: return new JObject { ["c"] = "trenchPlan", ["points"] = new JArray(path.ToArray()), ["type"] = string.IsNullOrEmpty(Option) ? "basic" : Option, ["commit"] = commit };
            }
        }

        void Plan(bool commit, float time)
        {
            if (session.Net == null || path.Count == 0) return;
            var cmd = PlanCommand(commit);
            var mode = Current;
            session.Net.Command(cmd, r =>
            {
                if (r.Error != null) { Say(r.Error, false, Time.unscaledTime); return; }
                preview = (r.Raw?["trench"] ?? r.Raw?["road"] ?? r.Raw?["plan"] ?? r.Raw?["bridge"]) as JObject ?? r.Raw;
                if (!commit) return;
                if (mode == Mode.Trench)
                {
                    var started = r.Raw?["started"] as JObject;
                    int placed = ProtocolDecoder.Int(started?["placed"]);
                    int skipped = (started?["skipped"] as JArray)?.Count ?? 0;
                    Say($"Trench: {placed} segments to dig" + (skipped > 0 ? $" · {skipped} skipped (roads, rivers or buildings)" : ""), placed > 0, Time.unscaledTime);
                }
                else Say(mode == Mode.Road ? "Road works started" : "Bridge works started", true, Time.unscaledTime);
                path.Clear(); preview = null;
                if (!InputFacade.Shift) Cancel();
            });
        }

        // ------------------------------------------------------------------ map points
        void PointMode(float time, bool overUi)
        {
            if (overUi) return;
            if (InputFacade.RightDown) { Cancel(); return; }
            if (!InputFacade.LeftDown || hoverTile < 0) return;
            int tile = hoverTile;
            if (Current == Mode.Growth && SelectedCity >= 0)
            {
                session.Net?.Command(new JObject { ["c"] = "cityGrowth", ["city"] = SelectedCity, ["kind"] = Option, ["tile"] = tile }, r => Say(r.Error ?? $"The mayor will grow {Option} there", r.Error == null, Time.unscaledTime));
            }
            else if (Current == Mode.Rally) SetRally(tile, time);
            else if (Current == Mode.Target && TargetCommand != null)
            {
                var cmd = (JObject)TargetCommand.DeepClone();
                Bind(cmd, tile);
                session.Net?.Command(cmd, r => Say(r.Error ?? "Order accepted", r.Error == null, Time.unscaledTime));
            }
            Cancel();
        }

        /// <summary>Fill "@map" / "@units" / "@buildings" placeholders of a catalogued command.</summary>
        public void Bind(JObject cmd, int tile)
        {
            foreach (var p in new List<JProperty>(cmd.Properties()))
            {
                var s = p.Value.Type == JTokenType.String ? (string)p.Value : null;
                if (s == "@map" || s == "@battle_tile") p.Value = tile;
                else if (s == "@units" || s == "@battle_units") p.Value = new JArray(new List<int>(units.Selected).ToArray());
                else if (s == "@buildings") p.Value = new JArray(new List<int>(SelectedBuildings).ToArray());
                else if (s == "@building") p.Value = SelectedBuildings.Count > 0 ? new List<int>(SelectedBuildings)[0] : -1;
                else if (s == "@city") p.Value = SelectedCity;
                else if (s == "@tiles") p.Value = new JArray(tile);
            }
        }

        void SetRally(int tile, float time)
        {
            foreach (var id in SelectedBuildings)
                session.Net?.Command(new JObject { ["c"] = "rally", ["building"] = id, ["tile"] = tile }, r => Say(r.Error ?? "Rally point set", r.Error == null, Time.unscaledTime));
        }

        // ------------------------------------------------------------------ unit orders
        void Move(int tile, Vector3 point, bool attackMove, float time)
        {
            var order = new Order { MapPoint = point, Time = time };
            Orders.Add(order);
            var cmd = new JObject { ["c"] = "move", ["units"] = new JArray(new List<int>(units.Selected).ToArray()), ["tile"] = tile };
            if (attackMove) cmd["attackMove"] = true;
            order.Rid = session.Net?.Command(cmd, r => Resolve(order, r)) ?? -1;
            if (session.Net == null) order.State = "accepted";
        }

        public void UnitCommand(string c, JObject extra, string done)
        {
            var cmd = new JObject { ["c"] = c, ["units"] = new JArray(new List<int>(units.Selected).ToArray()) };
            if (extra != null) foreach (var p in extra.Properties()) cmd[p.Name] = p.Value;
            session.Net?.Command(cmd, r => Say(r.Error ?? done, r.Error == null, Time.unscaledTime));
        }

        void Resolve(Order order, ServerMessage reply)
        {
            order.Time = Time.unscaledTime;
            if (reply.Error != null) { order.State = "refused"; order.Reason = reply.Error; Say(reply.Error, false, order.Time); }
            else order.State = "accepted";
        }

        // ------------------------------------------------------------------ overlay
        /// <summary>Legal sites, the site under the cursor, pending and refused sites, the drawn path.</summary>
        public void DrawOverlay(WrapImages images, float time)
        {
            rings.Clear(); discs.Clear();
            var w = session.World;
            if (!w.Ready) return;
            var g = w.Grid;
            void Ring(int t, float4 col, float size)
            {
                float x = g.CenterX(t), z = g.CenterZ(t);
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + 0.02f, z)), 0, new float3(size), col));
            }
            void Disc(int t, float4 col)
            {
                float x = g.CenterX(t), z = g.CenterZ(t);
                discs.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + 0.03f, z)), 0, new float3(1.5f, 1f, 1.5f), col));
            }
            if (Current == Mode.Place)
            {
                foreach (var t in legal) if (g.Dist(t, Math.Max(0, hoverTile)) < 14 || hoverTile < 0) Ring(t, new float4(0.85f, 0.95f, 0.8f, 0.4f), 1.6f);
                if (hoverTile >= 0) Disc(hoverTile, legal.Contains(hoverTile) || !legalReady ? new float4(0.35f, 0.9f, 0.45f, 0.6f) : new float4(0.95f, 0.3f, 0.25f, 0.6f));
                foreach (var t in path) Disc(t, new float4(0.95f, 0.8f, 0.35f, 0.5f));
            }
            if (Current == Mode.Road || Current == Mode.Trench || Current == Mode.Bridge)
            {
                var segs = preview?["segments"] as JArray;
                if (segs != null)
                    foreach (var s in segs)
                    {
                        int t = ProtocolDecoder.Int(s["t"] ?? s["a"], -1);
                        if (t < 0) continue;
                        Disc(t, ProtocolDecoder.Bool(s["ok"], true) ? new float4(0.4f, 0.85f, 0.45f, 0.45f) : new float4(0.95f, 0.3f, 0.25f, 0.55f));
                    }
                else foreach (var t in path) Disc(t, new float4(0.95f, 0.8f, 0.35f, 0.5f));
            }
            if ((Current == Mode.Growth || Current == Mode.Rally || Current == Mode.Target) && hoverTile >= 0) Ring(hoverTile, new float4(0.95f, 0.8f, 0.35f, 0.9f), 1.6f + 0.15f * Mathf.Sin(time * 6f));
            float pulse = 1.5f + 0.1f * Mathf.Sin(time * 8f);
            foreach (var t in pendingSites.Keys) Ring(t, new float4(1f, 0.82f, 0.25f, 0.9f), pulse);
            foreach (var t in refusedSites.Keys) Ring(t, new float4(1f, 0.3f, 0.25f, 0.9f), 1.6f);
            foreach (var id in SelectedBuildings) if (session.Structures.Buildings.TryGetValue(id, out var b)) Ring(b.Tile, new float4(0.4f, 1f, 0.5f, 0.85f), 1.75f);
            foreach (var o in Orders)
            {
                float a = 1f - Mathf.Clamp01((time - o.Time) / (o.State == "pending" ? 8f : 1.5f));
                var col = o.State == "pending" ? new float4(1f, 0.82f, 0.25f, 0.6f) : o.State == "accepted" ? new float4(0.35f, 1f, 0.45f, 0.6f * a) : new float4(1f, 0.3f, 0.25f, 0.8f * a);
                float s = o.State == "pending" ? 0.5f + 0.1f * Mathf.Sin(time * 8f) : 0.5f + (1f - a) * 0.3f;
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(o.MapPoint.x, w.GroundHeight(o.MapPoint.x, o.MapPoint.z) + 0.02f, o.MapPoint.z)), 0, new float3(s), col));
            }
            rings.DrawImages(images);
            discs.DrawImages(images);
        }

        public string ModeHint()
        {
            switch (Current)
            {
                case Mode.Place: return "Click a highlighted site · drag to place several · Shift keeps placing · right-click or Esc to stop";
                case Mode.Road: return "Drag the route · release to build · Esc to cancel";
                case Mode.Bridge: return "Drag from one bank to the other · release to build";
                case Mode.Trench: return "Drag the trench line · blocked hexes are skipped · release to dig";
                case Mode.Growth: return "Click where the city should grow";
                case Mode.Rally: return "Click the rally point";
                case Mode.Target: return "Click the target on the map";
                default: return "";
            }
        }

        public void Dispose() { rings.Dispose(); discs.Dispose(); }
    }
}
