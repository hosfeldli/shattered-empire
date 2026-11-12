using System;
using System.Collections.Generic;
using System.Linq;
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
    public sealed partial class Commander : IDisposable
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
        /// <summary>The frame on which the commander used Escape (so the interface doesn't act on it too).</summary>
        public int EscapeFrame = -1;

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
            routeLines = new InstanceBatch(MeshKit.Box, RenderResources.Instanced, 256) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off, Buffering = 3 };
        }

        public void Say(string text, bool good, float time) { Feedback = text; FeedbackGood = good; FeedbackUntil = time + 3.5f; }

        // ------------------------------------------------------------------ modes
        public void Begin(Mode mode, string option = "", JObject target = null)
        {
            Current = mode; Option = option ?? ""; TargetCommand = target;
            dragging = false; ClearRingPreview(); FieldPreviewParcel = null; FieldPreviewValid = false; fieldPreviewToken++;
            path.Clear(); preview = null; legal.Clear(); legalReady = false;
            worldStroke.Clear(); actionTrenchPreview = null;
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

        public void Cancel() { Current = Mode.Select; Option = ""; TargetCommand = null; path.Clear(); preview = null; legal.Clear(); PlacementSite = null; siteTile = -1; worldStroke.Clear(); actionTrenchPreview = null; }

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
            if (session.ActionRts) return SpatialBuildingAt(InputFacade.MousePosition);
            foreach (var b in session.Structures.Buildings.Values) if (b.Tile == tile) return b;
            return null;
        }

        // ------------------------------------------------------------------ frame
        public void Update(float time, bool pointerOverUi)
        {
            if (!session.Ready) return;
            var mouse = InputFacade.MousePosition;
            hoverTile = pointerOverUi ? -1 : TileUnderCursor();
            if (session.ActionRts) UpdateFieldPreview(time, pointerOverUi);
            if (InputFacade.Pressed(KeyCode.Escape) && rightPress) { EscapeFrame = Time.frameCount; rightPress = false; lineDrag = false; linePreview = null; Say("Battle line cancelled", true, time); return; }
            if (InputFacade.Pressed(KeyCode.Escape) && Current != Mode.Select) { EscapeFrame = Time.frameCount; Cancel(); return; }
            switch (Current)
            {
                case Mode.Select: SelectMode(time, mouse, pointerOverUi); break;
                case Mode.Place: if (session.ActionRts) PlaceBase(time, pointerOverUi); else PlaceMode(time, pointerOverUi); break;
                case Mode.Trench: if (session.ActionRts) DrawActionTrench(time, pointerOverUi); else DrawMode(time, pointerOverUi); break;
                case Mode.Road: if (session.ActionRts) DrawActionTrench(time, pointerOverUi); else DrawMode(time, pointerOverUi); break;
                case Mode.Bridge: DrawMode(time, pointerOverUi); break;
                case Mode.Growth: case Mode.Rally: case Mode.Target: PointMode(time, pointerOverUi); break;
            }
            Orders.RemoveAll(o => time - o.Time > (o.State == "pending" ? 8f : 1.5f));
            var stale = new List<int>();
            foreach (var kv in refusedSites) if (time - kv.Value.at > 2.5f) stale.Add(kv.Key);
            foreach (var t in stale) refusedSites.Remove(t);
            stale.Clear();
            foreach (var kv in pendingSites) if (time - kv.Value > 10f || (session.ActionRts ? session.Structures.Buildings.Values.Any(b => b.Slot == kv.Key) : BuildingAt(kv.Key) != null)) stale.Add(kv.Key);
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
                if (!add) { units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1; SelectedObjective = SelectedPickup = SelectedRingSlot = 0; ClearRingPreview(); }
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
                else if (!box && session.ActionRts && (SelectActionPickup(mouse) || SelectActionRing(mouse) || SelectActionObjective(mouse, tile)))
                {
                    // Objective cards cover both secured and undeveloped sites.
                }
                else if (!box && doubleClick && tile >= 0 && BuildingAt(tile) == null && cam.TryGround(mouse, out var centre))
                    cam.JumpTo(centre);   // double-click on open ground: centre the view there
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
            // right button: a click moves (on release); a drag draws a battle line
            if (!session.Spectator && !overUi && InputFacade.RightDown && units.Selected.Count > 0 && cam.TryGround(mouse, out var ground))
            {
                rightPress = true; lineDrag = false; lineReverse = false; linePreview = null;
                lineStartScreen = mouse; lineStartGround = ground; linePath.Clear();
                worldLine.Clear(); worldLine.Add(ground); linePreviewAt = 0;
                int t0 = session.World.Grid.TileAt(ground.x, ground.z);
                if (t0 >= 0) linePath.Add(t0);
            }
            else if (!session.Spectator && !overUi && InputFacade.RightDown && (SelectedBuildings.Count > 0 || SelectedObjective > 0) && units.Selected.Count == 0)
            {
                int tile = TileUnderCursor();
                if (tile >= 0) SetRally(tile, time);
            }
            if (rightPress) BattleLine(time, mouse);
            if (units.Selected.Count > 0)
            {
                if (InputFacade.Action("hold")) UnitCommand("hold", null, "Holding position");
                if (InputFacade.Action("withdraw")) UnitCommand("withdraw", null, "Withdrawing");
                if (InputFacade.Action("attack")) Begin(Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true });
                if (!lineDrag && InputFacade.Action("follow")) ToggleFollow(time);
            }
            ControlGroups(time);
        }

        // ------------------------------------------------------------------ battle lines
        // Right-drag across the map: the server plans who stands where (a dry run while dragging, so the
        // preview is exactly what will happen), invalid ground shows red, units that don't fit are
        // counted. F flips the facing, Alt makes it an advancing line, Shift queues it; release commits.
        bool rightPress, lineDrag, lineReverse;
        Vector2 lineStartScreen;
        Vector3 lineStartGround;
        readonly List<int> linePath = new List<int>();
        JObject linePreview;
        float linePreviewAt;
        int lineToken;
        public bool DrawingLine => lineDrag;

        void BattleLine(float time, Vector2 mouse)
        {
            if (session.ActionRts) { ActionBattleLine(time, mouse); return; }
            if (!lineDrag && (mouse - lineStartScreen).magnitude > 16f) lineDrag = true;
            if (lineDrag)
            {
                if (InputFacade.Action("flip")) { lineReverse = !lineReverse; linePreviewAt = 0; }
                int t = TileUnderCursor();
                if (t >= 0 && linePath.Count > 0 && linePath[linePath.Count - 1] != t && linePath.Count < 24) { linePath.Add(t); linePreviewAt = Mathf.Min(linePreviewAt, time + 0.12f); }
                if (time >= linePreviewAt && linePath.Count >= 2) { linePreviewAt = time + 0.25f; DeployCommand(true, time); }
            }
            if (!InputFacade.RightUp) return;
            rightPress = false;
            if (lineDrag && linePath.Count >= 2) DeployCommand(false, time);
            else
            {
                int tile = session.World.Grid.TileAt(lineStartGround.x, lineStartGround.z);
                if (tile >= 0) Move(tile, lineStartGround, InputFacade.Shift || InputFacade.Ctrl, time);
            }
            lineDrag = false;
            linePreview = null;
        }

        void DeployCommand(bool preview, float time)
        {
            if (session.Net == null) return;
            var cmd = new JObject
            {
                ["c"] = "deploy", ["units"] = new JArray(new List<int>(units.Selected).ToArray()),
                ["line"] = new JArray(linePath[0], linePath[linePath.Count - 1]), ["path"] = new JArray(linePath.ToArray()),
                ["mode"] = "line", ["behavior"] = InputFacade.Alt ? "attackMove" : "defend", ["reverse"] = lineReverse,
            };
            if (preview) cmd["preview"] = true;
            else if (InputFacade.Shift) cmd["queue"] = true;
            int token = ++lineToken;
            var point = lineStartGround;
            if (!preview) { var order = new Order { MapPoint = point, Time = time }; Orders.Add(order); }
            session.Net.Command(cmd, r =>
            {
                if (preview)
                {
                    if (token == lineToken && lineDrag) linePreview = r.Error == null ? r.Raw : null;
                    return;
                }
                if (r.Error != null) { Say(r.Error, false, Time.unscaledTime); return; }
                var d = r.Raw?["deploy"] as JObject;
                if (d?["queued"] != null) { Say($"Battle line queued for {d["queued"]} units", true, Time.unscaledTime); return; }
                int placed = ProtocolDecoder.Int(d?["placed"]), partial = ProtocolDecoder.Int(d?["partial"]), unreachable = ProtocolDecoder.Int(d?["unreachable"]);
                int overflow = (d?["overflow"] as JArray)?.Count ?? 0;
                Say($"Line formed ({ProtocolDecoder.Str(d?["label"], "line")}): {placed} deploying" + (partial + unreachable > 0 ? $" · {partial + unreachable} can't reach" : "") + (overflow > 0 ? $" · {overflow} don't fit" : ""), unreachable == 0, Time.unscaledTime);
            });
        }

        // ------------------------------------------------------------------ control groups and following
        readonly Dictionary<int, HashSet<int>> groups = new Dictionary<int, HashSet<int>>();
        int lastGroup = -1;
        float lastGroupAt;

        void ControlGroups(float time)
        {
            for (int k = 1; k <= 9; k++)
            {
                if (!InputFacade.Action("group_" + k)) continue;
                if (InputFacade.Ctrl)
                {
                    groups[k] = new HashSet<int>(units.Selected);
                    if (session.ActionRts && !session.Spectator)
                        session.Net?.Command(new JObject { ["c"] = "group", ["group"] = k, ["units"] = new JArray(new List<int>(units.Selected).ToArray()) });
                    Say(units.Selected.Count > 0 ? $"Group {k}: {units.Selected.Count} units" : $"Group {k} cleared", true, time);
                    continue;
                }
                if (session.ActionRts && session.Econ?["groups"] is JArray savedGroups)
                {
                    foreach (var group in savedGroups) if (ProtocolDecoder.Int(group["id"]) == k && group["units"] is JArray roster)
                    {
                        var members = new HashSet<int>();
                        foreach (var member in roster) members.Add(ProtocolDecoder.Int(member));
                        groups[k] = members;
                    }
                }
                if (!groups.TryGetValue(k, out var g) || g.Count == 0) continue;
                g.RemoveWhere(id => !session.Units.SlotOf.ContainsKey(id));
                if (!InputFacade.Shift) { units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1; SelectedObjective = 0; }
                foreach (var id in g) units.Selected.Add(id);
                SelectionChanged?.Invoke();
                // pressing the same group twice quickly brings the camera to it
                if (lastGroup == k && time - lastGroupAt < 0.4f && SelectionCentre() is Vector3 c) cam.JumpTo(c);
                lastGroup = k; lastGroupAt = time;
            }
        }

        /// <summary>The middle of the current selection (map coordinates), wrap-aware.</summary>
        public Vector3? SelectionCentre()
        {
            var g = session.World.Grid;
            float sx = 0, sz = 0; int n = 0; float refX = 0;
            foreach (var id in units.Selected)
            {
                if (!units.TryGetPosition(session.Units, id, out var p)) continue;
                if (n == 0) refX = p.x;
                sx += refX + g.DxWrap(refX, p.x); sz += p.y; n++;
            }
            if (n == 0) return null;
            return new Vector3(sx / n, 0, sz / n);
        }

        void ToggleFollow(float time)
        {
            if (cam.Following) { cam.FollowTarget = null; Say("Stopped following", true, time); return; }
            cam.FollowTarget = SelectionCentre;
            Say("Following the selection · move the camera to stop", true, time);
        }

        // ------------------------------------------------------------------ building placement
        /// <summary>The site under the cursor while placing, whether it is legal, and the server's site report (cost, time, reason).</summary>
        public int PlacementTile => Current == Mode.Place ? hoverTile : -1;
        public bool PlacementLegal => session.ActionRts && Current == Mode.Place ? PlacementParcel is BaseParcel parcel && legal.Contains(parcel.Id) : !legalReady || legal.Contains(hoverTile);
        public JObject PlacementSite;
        int siteTile = -1;
        float siteAt;

        void PlaceMode(float time, bool overUi)
        {
            // ask the server about the site under the cursor (throttled): cost, build time, or why not
            if (!overUi && hoverTile >= 0 && hoverTile != siteTile && time > siteAt && session.Net != null)
            {
                siteTile = hoverTile; siteAt = time + 0.2f;
                int asked = hoverTile; string type = Option;
                session.Net.Command(new JObject { ["c"] = "placement", ["type"] = type, ["tile"] = asked }, r =>
                {
                    if (asked == siteTile && Current == Mode.Place && Option == type) PlacementSite = r.Raw?["site"] as JObject;
                });
            }
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
            if ((!InputFacade.LeftDown && !(session.ActionRts && InputFacade.Pressed(KeyCode.Return))) || hoverTile < 0) return;
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
                if (session.ActionRts && cam.TryGround(InputFacade.MousePosition, out var p))
                {
                    cmd["point"] = Point(p);
                    if (ProtocolDecoder.Str(cmd["c"]) == "move") { cmd["queue"] = InputFacade.Shift; ActionMoveOrders++; }
                }
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
            if (session.ActionRts) { SetActionRally(tile, time); return; }
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
            rings.Clear(); discs.Clear(); routeLines.Clear();
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
            if (Current == Mode.Place && !session.ActionRts)
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
            if (session.ActionRts) DrawActionOverlay(images, time);
            if (lineDrag && !session.ActionRts)
            {
                // the line as drawn, then (once the server has planned it) every unit's slot: green where
                // it will stand, red where the ground refuses it
                foreach (var t in linePath) Ring(t, new float4(1f, 0.85f, 0.35f, 0.7f), 1.2f);
                if (linePreview?["slots"] is JArray slots)
                {
                    var perTile = new Dictionary<int, int>();
                    foreach (JArray s in slots) { int t = (int)s[1]; perTile[t] = perTile.TryGetValue(t, out int n) ? n + 1 : 1; }
                    // green: a good position; amber: crowded (three or more on one hex, vulnerable to shelling)
                    foreach (var kv in perTile)
                    {
                        bool crowded = kv.Value >= 3;
                        var fill = crowded ? new float4(0.95f, 0.72f, 0.25f, 0.5f) : new float4(0.35f, 0.9f, 0.5f, 0.35f + 0.1f * Mathf.Min(4, kv.Value));
                        var ring = crowded ? new float4(1f, 0.8f, 0.35f, 0.85f) : new float4(0.6f, 1f, 0.7f, 0.8f);
                        Disc(kv.Key, fill);
                        for (int k = 0; k < Mathf.Min(4, kv.Value); k++) Ring(kv.Key, ring, 0.35f + k * 0.18f);
                    }
                    // facing: small markers ahead of the line on the side it will face
                    if (linePath.Count >= 2)
                    {
                        var g2 = session.World.Grid;
                        int a = linePath[0], b = linePath[linePath.Count - 1];
                        float dx = g2.DxWrap(g2.CenterX(a), g2.CenterX(b)), dz = g2.CenterZ(b) - g2.CenterZ(a);
                        float len = Mathf.Max(0.01f, Mathf.Sqrt(dx * dx + dz * dz));
                        // the server's own facing (map x/z; already turned away from home and flipped if
                        // asked); before it answers, its default: the drag direction turned left
                        float fx = dz / len, fz = -dx / len;
                        if (lineReverse) { fx = -fx; fz = -fz; }
                        if (linePreview?["facing"] is JArray fa && fa.Count == 2) { fx = (float)fa[0]; fz = (float)fa[1]; float fl = Mathf.Max(0.01f, Mathf.Sqrt(fx * fx + fz * fz)); fx /= fl; fz /= fl; }
                        foreach (var kv in perTile)
                        {
                            float x = g2.CenterX(kv.Key) + fx * 0.7f, z = g2.CenterZ(kv.Key) + fz * 0.7f;
                            rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + 0.03f, z)), 0, new float3(0.18f), new float4(1f, 1f, 0.9f, 0.9f)));
                        }
                    }
                }
                if (linePreview?["invalid"] is JArray bad) foreach (var t in bad) Disc((int)t, new float4(0.95f, 0.3f, 0.25f, 0.55f));
            }
            if ((Current == Mode.Growth || Current == Mode.Rally || Current == Mode.Target) && hoverTile >= 0) Ring(hoverTile, new float4(0.95f, 0.8f, 0.35f, 0.9f), 1.6f + 0.15f * Mathf.Sin(time * 6f));
            float pulse = 1.5f + 0.1f * Mathf.Sin(time * 8f);
            if (!session.ActionRts) foreach (var t in pendingSites.Keys) Ring(t, new float4(1f, 0.82f, 0.25f, 0.9f), pulse);
            if (!session.ActionRts) foreach (var t in refusedSites.Keys) Ring(t, new float4(1f, 0.3f, 0.25f, 0.9f), 1.6f);
            foreach (var id in SelectedBuildings) if (session.Structures.Buildings.TryGetValue(id, out var b) && !session.ActionRts) Ring(b.Tile, new float4(.54f, .77f, .62f, .12f), 1.75f);
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
            if (session.ActionRts && (lineDrag || Current != Mode.Select)) return ActionModeHint();
            if (lineDrag)
            {
                string plan = "";
                if (linePreview != null)
                {
                    int slots = (linePreview["slots"] as JArray)?.Count ?? 0, over = (linePreview["overflow"] as JArray)?.Count ?? 0, bad = (linePreview["invalid"] as JArray)?.Count ?? 0;
                    plan = $"{slots} placed ({ProtocolDecoder.Str(linePreview["label"], "line")})" + (over > 0 ? $" · {over} don't fit" : "") + (bad > 0 ? $" · {bad} hexes refused" : "") + " · ";
                }
                return plan + (InputFacade.Alt ? "Advancing line" : "Defensive line") + (lineReverse ? " · facing flipped" : "")
                    + $" · release to deploy · {InputFacade.KeyFor("flip")} flips facing · Alt advances · Shift queues · Esc cancels";
            }
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

        public void Dispose() { rings.Dispose(); discs.Dispose(); routeLines.Dispose(); }
    }
}
