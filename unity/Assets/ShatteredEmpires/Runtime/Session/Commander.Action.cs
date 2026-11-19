using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    public sealed partial class Commander
    {
        public int SelectedObjective { get; private set; }
        public int ActionMoveOrders { get; private set; }
        public int ActionFormations { get; private set; }
        readonly List<Vector3> worldLine = new List<Vector3>(96);
        readonly List<Vector3> worldStroke = new List<Vector3>(72);
        readonly InstanceBatch routeLines;
        JObject actionTrenchPreview;
        int placementBase, trenchToken;
        public BaseParcel? PlacementParcel
        {
            get
            {
                if (!session.ActionRts || !session.Objectives.TryGetValue(placementBase, out var site) || site.Parcels == null) return null;
                if (!cam.TryGround(InputFacade.MousePosition, out var point)) return null;
                BaseParcel? best = null; float range = .65f * .65f;
                foreach (var parcel in site.Parcels)
                {
                    if (parcel.Id == 0) continue;
                    float dx = session.World.Grid.DxWrap(point.x, parcel.X), dz = point.z - parcel.Z, d = dx * dx + dz * dz;
                    if (d >= range) continue; range = d; best = parcel;
                }
                return best;
            }
        }
        static readonly float4 Valid = new float4(.38f, .92f, .64f, .68f);
        static readonly float4 Amber = new float4(.98f, .72f, .27f, .72f);
        static readonly float4 Invalid = new float4(1f, .31f, .23f, .72f);

        static JObject Point(Vector3 p) => new JObject { ["x"] = p.x, ["z"] = p.z };
        static JArray PointArray(List<Vector3> list)
        {
            var points = new JArray();
            foreach (var p in list) points.Add(Point(p));
            return points;
        }

        public void ResetAction()
        {
            SelectedObjective = placementBase = ActionMoveOrders = ActionFormations = 0;
            SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            rightPress = lineDrag = rallyPlacing = false;
            worldLine.Clear(); ClearLinePreview();
            SelectedBuildings.Clear();
            SelectedCity = -1;
        }

        bool SiteAt(Vector2 mouse, Vector3 p, int tile, out ObjectiveSite site)
        {
            site = default;
            var grid = session.World.Grid;
            float best = 1.8f * 1.8f;
            foreach (var s in session.Objectives.Values)
            {
                float dx = grid.DxWrap(p.x, s.X), dz = p.z - s.Z;
                float d = dx * dx + dz * dz;
                var mark = cam.ToScreen(new Vector3(grid.NearX(s.X, cam.Focus.x), session.World.GroundHeight(s.X, s.Z) + .55f, s.Z));
                bool marker = mark.z > 0 && (new Vector2(mark.x, mark.y) - mouse).sqrMagnitude < 13f * 13f;
                if (!marker && s.Tile != tile && (d > s.Radius * s.Radius || d >= best)) continue;
                site = s; best = d;
                if (marker || s.Tile == tile) break;
            }
            return site.Id > 0;
        }

        bool SelectActionObjective(Vector2 mouse, int tile)
        {
            if (tile < 0 || !cam.TryGround(mouse, out var p) || !SiteAt(mouse, p, tile, out var site)) return false;
            if (BuildingAt(tile) is BuildingRecord b && b.Type != "town" && (b.Owner == session.CivId || session.Spectator)) return false;
            if (units.Selected.Count == 0) SelectedObjective = site.Id;
            return true;
        }

        /// <summary>True while the interface owns the digit keys (wheel hot, picker open, defense bar armed).</summary>
        public bool SuppressGroupKeys { get; set; }

        /// <summary>Drop the whole selection (Escape chain step 7). True when anything was selected.</summary>
        public bool ClearSelection()
        {
            bool any = units.Selected.Count > 0 || SelectedBuildings.Count > 0 || SelectedObjective != 0 || SelectedPickup != 0 || SelectedRingSlot != 0 || SelectedCity >= 0;
            if (!any) return false;
            units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1;
            SelectedObjective = SelectedPickup = SelectedRingSlot = 0; HoverRingSlot = 0; ClearRingPreview();
            SelectionChanged?.Invoke();
            return true;
        }

        /// <summary>Right-click on the minimap: move the selected units to that map point (Shift queues).</summary>
        public void MinimapOrder(float x, float z, bool queue)
        {
            if (session.Spectator || units.Selected.Count == 0 || session.Net == null || !session.World.Ready) return;
            var g = session.World.Grid;
            int tile = g.TileAt(x, z);
            if (tile < 0) return;
            var point = new Vector3(x, session.World.GroundHeight(x, z), z);
            var cmd = new JObject { ["c"] = "move", ["units"] = new JArray(units.Selected.ToArray()), ["tile"] = tile };
            if (session.ActionRts) { cmd["point"] = Point(point); cmd["queue"] = queue; }
            DenseForestHint(tile, Time.unscaledTime);
            var order = new Order { MapPoint = point, Time = Time.unscaledTime };
            Orders.Add(order);
            NoteIssued("move", point);
            UI.Hud.NoteOrder(units.Selected, point, "move", order.Time);
            order.Rid = session.Net.Command(cmd, r => { Resolve(order, r); if (r.Error == null) ActionMoveOrders++; });
        }

        public void SelectObjective(int id)
        {
            SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            units.Selected.Clear();
            SelectedBuildings.Clear();
            SelectedCity = -1;
            SelectedObjective = id;
            SelectionChanged?.Invoke();
        }

        public void SelectProduction(IEnumerable<int> ids)
        {
            SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            units.Selected.Clear(); SelectedCity = -1; SelectedObjective = 0;
            SelectedBuildings.Clear();
            foreach (var id in ids) SelectedBuildings.Add(id);
            SelectionChanged?.Invoke();
        }

        public void BeginBasePlacement(int siteId, string type)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            Cancel();
            Current = Mode.Place; Option = type; placementBase = siteId;
            legalReady = true;
            foreach (int tile in site.Slots) legal.Add(tile);
        }

        void PlaceBase(float time, bool overUi)
        {
            if (InputFacade.RightDown) { Cancel(); return; }
            if (overUi || hoverTile < 0 || (!InputFacade.LeftDown && !InputFacade.Pressed(KeyCode.Return))) return;
            if (!(PlacementParcel is BaseParcel parcel) || !legal.Contains(parcel.Id)) { Say("Choose an unlocked ring site.", false, time); return; }
            int tile = parcel.Id;
            if (pendingSites.ContainsKey(tile)) return;
            pendingSites[tile] = time;
            session.Net?.Command(new JObject { ["c"] = "baseBuild", ["site"] = placementBase, ["type"] = Option, ["slot"] = tile }, r =>
            {
                if (r.Error != null) { pendingSites.Remove(tile); refusedSites[tile] = (r.Error, Time.unscaledTime); }
                Say(r.Error ?? "Construction started", r.Error == null, Time.unscaledTime);
            });
            Cancel();
        }

        static void AppendPoint(List<Vector3> points, Vector3 p, int max, float spacing)
        {
            if (points.Count >= max) { points[max - 1] = p; return; }
            if (points.Count == 0 || (p - points[points.Count - 1]).sqrMagnitude >= spacing * spacing) points.Add(p);
        }

        void ActionBattleLine(float time, Vector2 mouse)
        {
            if (!lineDrag && (mouse - lineStartScreen).sqrMagnitude > 16f * 16f) lineDrag = true;
            if (lineDrag)
            {
                if (InputFacade.Action("flip")) { lineReverse = !lineReverse; linePreviewAt = 0; }
                if (cam.TryGround(mouse, out var point)) AppendPoint(worldLine, point, 96, .13f);
                if (time >= linePreviewAt && worldLine.Count >= 2) { linePreviewAt = time + .32f; DeployActionLine(true, time); }
            }
            if (!InputFacade.RightUp) return;
            rightPress = false;
            if (lineDrag && worldLine.Count >= 2) DeployActionLine(false, time);
            else ActionContextOrder(lineStartScreen, lineStartGround, time);
            lineDrag = false;
            ClearLinePreview();
        }

        // ------------------------------------------------------------------ formation preview cache (§23)
        // The server's dry-run positions are parsed once per reply into this array (the overlay used to walk the
        // JArray every frame). Until the first reply arrives the selection is spread evenly along the drawn line as
        // dim placeholder rings, so the drag answers immediately.
        struct LineSlot { public float X, Z, Face; public int State; }
        LineSlot[] lineSlots = new LineSlot[64];
        int lineSlotCount, linePlaced;

        void SetLinePreview(JObject plan)
        {
            linePreview = plan;
            lineSlotCount = 0;
            linePlaced = ProtocolDecoder.Int(plan?["placed"]);
            if (!(plan?["positions"] is JArray positions)) return;
            if (lineSlots.Length < positions.Count) lineSlots = new LineSlot[Mathf.NextPowerOfTwo(positions.Count)];
            foreach (var token in positions)
                if (token is JArray p && p.Count >= 5)
                    lineSlots[lineSlotCount++] = new LineSlot { X = ProtocolDecoder.Float(p[1]), Z = ProtocolDecoder.Float(p[2]), Face = ProtocolDecoder.Float(p[3]), State = ProtocolDecoder.Int(p[4]) };
        }

        void ClearLinePreview() { linePreview = null; lineSlotCount = 0; linePlaced = 0; }

        /// <summary>Placeholder slots: the selected count spread evenly along the drawn polyline (wrap-aware).</summary>
        void DrawLinePlaceholders()
        {
            var w = session.World;
            int n = Mathf.Min(units.Selected.Count, 256);
            if (n == 0 || worldLine.Count < 2) return;
            var g = session.World.Grid;
            float total = 0;
            for (int k = 1; k < worldLine.Count; k++)
            {
                float dx = g.DxWrap(worldLine[k - 1].x, worldLine[k].x), dz = worldLine[k].z - worldLine[k - 1].z;
                total += Mathf.Sqrt(dx * dx + dz * dz);
            }
            if (total < .01f) return;
            var dim = new float4(.78f, .86f, .82f, .22f);
            int seg = 1; float segStart = 0;
            for (int i = 0; i < n; i++)
            {
                float at = (i + .5f) / n * total;
                // walk forward to the segment holding this distance (slots are in order, so the walk is linear overall)
                while (seg < worldLine.Count)
                {
                    var a = worldLine[seg - 1]; var b = worldLine[seg];
                    float dx = g.DxWrap(a.x, b.x), dz = b.z - a.z, len = Mathf.Sqrt(dx * dx + dz * dz);
                    if (at <= segStart + len || seg == worldLine.Count - 1)
                    {
                        float f = len > 1e-4f ? Mathf.Clamp01((at - segStart) / len) : 0;
                        float x = a.x + dx * f, z = a.z + dz * f;
                        rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .034f, z)), 0, new float3(.22f, 1, .22f), dim));
                        break;
                    }
                    segStart += len; seg++;
                }
            }
        }

        void DeployActionLine(bool previewOnly, float time)
        {
            var cmd = new JObject
            {
                ["c"] = "deploy", ["units"] = new JArray(units.Selected.ToArray()), ["points"] = PointArray(worldLine),
                ["behavior"] = InputFacade.Alt ? "attackMove" : "defend", ["reverse"] = lineReverse,
                ["preview"] = previewOnly, ["queue"] = !previewOnly && InputFacade.Shift
            };
            int token = ++lineToken;
            Order order = previewOnly ? null : new Order { MapPoint = lineStartGround, Time = time };
            if (order != null) Orders.Add(order);
            session.Net?.Command(cmd, r =>
            {
                var plan = r.Raw?["deploy"] as JObject;
                if (previewOnly) { if (token == lineToken && lineDrag) SetLinePreview(plan); return; }
                Resolve(order, r);
                if (r.Error != null) return;
                ActionFormations++;
                int placed = ProtocolDecoder.Int(plan?["placed"]), unreachable = ProtocolDecoder.Int(plan?["unreachable"]);
                int overflow = (plan?["overflow"] as JArray)?.Count ?? 0;
                Say($"{placed} deploying" + (unreachable + overflow > 0 ? $" · {unreachable + overflow} positions unavailable" : ""), true, Time.unscaledTime);
            });
        }

        void ActionContextOrder(Vector2 mouse, Vector3 point, float time)
        {
            var g = session.World.Grid;
            int tile = g.TileAt(point.x, point.z);
            if (tile < 0) return;
            int enemy = 0;
            float nearest = 19f * 19f;
            for (int i = 0; i < session.Units.SlotCount; i++)
            {
                ref var u = ref session.Units.Records[i];
                if (!u.InUse || !session.IsHostile(u.Owner) || !ScreenOf(i, out var pixel)) continue;
                float d = (pixel - mouse).sqrMagnitude;
                if (d < nearest) { nearest = d; enemy = u.Id; }
            }
            if (enemy == 0 && BuildingAt(tile) is BuildingRecord b && !b.Memory && session.IsHostile(b.Owner)) enemy = b.Id;
            var cmd = new JObject { ["units"] = new JArray(units.Selected.ToArray()) };
            if (enemy > 0) { cmd["c"] = "attack"; cmd["target"] = enemy; cmd["queue"] = InputFacade.Shift; }
            else if (PickupAt(mouse, out var pickup) && !pickup.Memory)
            { cmd["c"] = "collect"; cmd["cache"] = pickup.Id; cmd["queue"] = InputFacade.Shift; }
            else if (SiteAt(mouse, point, tile, out var s) && s.Headquarters == 0 && s.Owner != session.CivId)
            {
                cmd["c"] = "capture"; cmd["site"] = s.Id; cmd["queue"] = InputFacade.Shift;
            }
            else if (SpatialBuildingAt(mouse) is BuildingRecord home && GarrisonTarget(home) && GarrisonOrder(home, point, time)) return;
            else
            {
                cmd["c"] = "move"; cmd["point"] = Point(point);
                cmd["attackMove"] = InputFacade.Ctrl; cmd["queue"] = InputFacade.Shift;
                DenseForestHint(tile, time);   // §30: infantry cannot enter dense forest (Commander.Orders.cs)
            }
            string kind = (string)cmd["c"] == "move" && InputFacade.Ctrl ? "attackMove" : (string)cmd["c"];
            var order = new Order { MapPoint = point, Time = time, Kind = kind };
            Orders.Add(order);
            NoteIssued(kind, point);
            UI.Hud.NoteOrder(units.Selected, point, kind == "attackMove" ? "attack" : (string)cmd["c"], time);
            order.Rid = session.Net?.Command(cmd, r =>
            {
                Resolve(order, r);
                if (r.Error == null) ActionMoveOrders++;
            }) ?? -1;
        }

        /// <summary>
        /// W4 garrison (2026-11-18): a right-click on an own garrisonable structure (the Garrison cursor) sends the
        /// eligible squads in with <c>{c:'garrison', units, building}</c>, exactly as the unit wheel does. Before this the
        /// right-click fell through to a plain <c>move</c>, so squads walked up to the structure and stood beside it.
        /// The rest of the selection (vehicles, mortar teams) moves to the structure as before. False when no selected
        /// unit may garrison (the caller then issues the ordinary move).
        /// </summary>
        bool GarrisonOrder(BuildingRecord home, Vector3 point, float time)
        {
            var eligible = new JArray(); var rest = new JArray();
            SplitGarrison(eligible, rest);
            if (eligible.Count == 0) return false;
            int cap = ProtocolDecoder.Int(session.Defs?["BUILDINGS"]?[home.Type ?? ""]?["garrison"]);
            var order = new Order { MapPoint = point, Time = time, Kind = "garrison" };
            Orders.Add(order);
            NoteIssued("garrison", point);
            UI.Hud.NoteOrder(units.Selected, point, "move", time);
            order.Rid = session.Net?.Command(new JObject { ["c"] = "garrison", ["units"] = eligible, ["building"] = home.Id }, r =>
            {
                Resolve(order, r);   // refusals ("That structure is full.", "Only infantry squads ...") are said by Resolve
                if (r.Error != null) return;
                ActionMoveOrders++;
                int entered = ProtocolDecoder.Int(r.Raw?["entered"]), moving = ProtocolDecoder.Int(r.Raw?["moving"]), refused = ProtocolDecoder.Int(r.Raw?["refused"]);
                string text = entered > 0 && moving > 0 ? $"{entered} inside, {moving} moving in" : entered > 0 ? $"{entered} inside" : $"{moving} moving in to garrison";
                if (refused > 0) text += $" · {refused} turned away ({cap} places, full)";
                Say(text, refused == 0, Time.unscaledTime);
            }) ?? -1;
            if (rest.Count > 0)
                session.Net?.Command(new JObject { ["c"] = "move", ["units"] = rest, ["point"] = Point(point), ["queue"] = InputFacade.Shift }, r => { });
            return true;
        }

        void SetActionRally(int tile, float time)
        {
            var ids = SelectedBuildings.ToList();
            if (SelectedObjective > 0) ids.AddRange(session.Structures.Buildings.Values.Where(b =>
                b.City == SelectedObjective && b.Done && session.Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).Select(b => b.Id));
            // the rally point carries an action: right-click sets a move, F then click an attack move
            bool attack = RallyAttackMoveArmed;
            var cmd = new JObject { ["c"] = "rally", ["buildings"] = new JArray(ids), ["tile"] = tile, ["action"] = attack ? "attackMove" : "move", ["attackMove"] = attack };
            if (cam.TryGround(InputFacade.MousePosition, out var p)) cmd["point"] = Point(p);
            else { var g = session.World.Grid; p = new Vector3(g.CenterX(tile), 0, g.CenterZ(tile)); }
            var order = new Order { MapPoint = p, Time = time, Kind = attack ? "rallyAttackMove" : "rally" };
            Orders.Add(order);
            NoteIssued(order.Kind, p);
            order.Rid = session.Net?.Command(cmd, r => { Resolve(order, r); if (r.Error == null) Say("Rally point set", true, Time.unscaledTime); }) ?? -1;
        }

        /// <summary>Why the trench / road stroke being drawn was refused in preview (null while valid; shown at the cursor by the HUD).</summary>
        public string StrokePreviewReason { get; private set; }
        /// <summary>
        /// Hexes (trench) or road segments the previewed stroke skips (drawn red). The stroke is still built where it
        /// can be: the server keeps the valid parts and skips the rest (2026-11-17), refusing only when nothing remains.
        /// </summary>
        public int StrokePreviewSkipped { get; private set; }

        // ------------------------------------------------------------------ shared stroke-tool rules (§28)
        // Road, trench and terrain brush strokes behave the same: right-click mid-stroke drops only that stroke (the
        // tool stays armed), right-click otherwise puts the tool away, Escape cancels, and after a committed stroke
        // Shift keeps the tool armed for the next one.
        enum StrokeRightClick { None, DropStroke, EndTool }

        static StrokeRightClick StrokeRightClickInput(bool stroking) =>
            !InputFacade.RightDown ? StrokeRightClick.None : stroking ? StrokeRightClick.DropStroke : StrokeRightClick.EndTool;

        /// <summary>After a stroke is sent: Shift keeps the tool (only the stroke resets), otherwise the tool ends.</summary>
        static bool KeepToolAfterStroke => InputFacade.Shift;

        struct StrokePart { public float Ax, Az, Bx, Bz; public bool Ok, Segment; }
        StrokePart[] strokeParts = new StrokePart[64];
        int strokePartCount, strokeAccepted;
        string lineHint = "";
        int lineHintCount;

        /// <summary>The road / trench stroke's server preview (cost, positions, skipped), or null.</summary>
        public JObject StrokePreview => actionTrenchPreview;

        /// <summary>Accepted road links or trench hexes in the current preview.</summary>
        public int StrokeAccepted => strokeAccepted;

        void SetStrokePreview(JObject plan, bool road)
        {
            actionTrenchPreview = plan;
            strokePartCount = strokeAccepted = 0;
            if (plan == null) return;
            for (int pass = 0; pass < 2; pass++)
            {
                if (!(plan[pass == 0 ? "positions" : "skipped"] is JArray parts)) continue;
                if (pass == 0) strokeAccepted = parts.Count;
                if (strokeParts.Length < strokePartCount + parts.Count) System.Array.Resize(ref strokeParts, Mathf.NextPowerOfTwo(strokePartCount + parts.Count));
                foreach (var p in parts)
                    strokeParts[strokePartCount++] = road
                        ? new StrokePart { Ax = ProtocolDecoder.Float(p["from"]?["x"]), Az = ProtocolDecoder.Float(p["from"]?["z"]), Bx = ProtocolDecoder.Float(p["to"]?["x"]), Bz = ProtocolDecoder.Float(p["to"]?["z"]), Ok = pass == 0, Segment = true }
                        : new StrokePart { Ax = ProtocolDecoder.Float(p["x"]), Az = ProtocolDecoder.Float(p["z"]), Ok = pass == 0 };
            }
        }

        /// <summary>Drop the stroke being drawn (or just sent) but keep the road / trench tool armed.</summary>
        void ResetStroke()
        {
            worldStroke.Clear(); trenchToken++;
            SetStrokePreview(null, false);
            StrokePreviewReason = null; StrokePreviewSkipped = 0;
        }

        /// <summary>Road / trench list prices per accepted link or hex (the server's roadBuild / trenchLine).</summary>
        public const int RoadLinkPrice = 15, TrenchHexPrice = 35;

        /// <summary>
        /// The tool chip's cost line for a road or trench stroke: the server preview's total when present, else the
        /// accepted parts × the unit price; with no stroke yet, the list price.
        /// </summary>
        public string StrokeChipText()
        {
            bool road = Current == Mode.Road;
            int unit = road ? RoadLinkPrice : TrenchHexPrice;
            string per = road ? "link" : "segment";
            var plan = actionTrenchPreview;
            if (plan == null || worldStroke.Count < 2) return $"{unit} Materials / {per}";
            int cost = plan["cost"] is JObject c ? ProtocolDecoder.Int(c["materials"], strokeAccepted * unit) : strokeAccepted * unit;
            string text = $"{cost} Materials · {strokeAccepted} {(strokeAccepted == 1 ? per : per + "s")}";
            if (StrokePreviewSkipped > 0) text += $" ({StrokePreviewSkipped} skipped)";
            float seconds = ProtocolDecoder.Float(plan["seconds"]);
            if (seconds > 0) text += $" · {seconds:0}s";
            return text + " · Shift keeps the tool";
        }

        void DrawActionTrench(float time, bool overUi)
        {
            switch (StrokeRightClickInput(dragging))
            {
                case StrokeRightClick.DropStroke: ResetStroke(); dragging = false; return;
                case StrokeRightClick.EndTool: Cancel(); return;
            }
            if (!overUi && InputFacade.LeftDown) { ResetStroke(); previewAt = 0; dragging = true; }
            if (!dragging) return;
            if (!overUi && cam.TryGround(InputFacade.MousePosition, out var p)) AppendPoint(worldStroke, p, 72, .22f);
            bool commit = InputFacade.LeftUp || InputFacade.Pressed(KeyCode.Return);
            if (worldStroke.Count >= 2 && (commit || time >= previewAt))
            {
                previewAt = time + .33f;
                int token = ++trenchToken;
                string operation = Current == Mode.Road ? "roadBuild" : "trenchWorld";
                var cmd = new JObject { ["c"] = operation, ["points"] = PointArray(worldStroke), ["preview"] = !commit };
                session.Net?.Command(cmd, r =>
                {
                    bool road = operation == "roadBuild";
                    if (commit)
                    {
                        int skipped = ProtocolDecoder.Int(r.Raw?["skipped"]);
                        string done = (road ? "Road construction started" : "Trench construction started")
                            + (skipped > 0 ? $" · {skipped} {(road ? (skipped == 1 ? "segment" : "segments") : (skipped == 1 ? "hex" : "hexes"))} skipped" : "");
                        Say(ReadableError(r) ?? done, r.Error == null, Time.unscaledTime);
                    }
                    else if (token == trenchToken && (Current == Mode.Trench || Current == Mode.Road))
                    {
                        SetStrokePreview(r.Raw?[road ? "road" : "trench"] as JObject, road);
                        StrokePreviewReason = ReadableError(r);   // nothing buildable: e.g. outside your own territory, through a base foundation
                        StrokePreviewSkipped = (actionTrenchPreview?["skipped"] as JArray)?.Count ?? 0;
                    }
                });
            }
            if (!commit) return;
            // a click without a stroke sends nothing and keeps the tool; a sent stroke ends it unless Shift is held
            dragging = false;
            if (worldStroke.Count < 2 || KeepToolAfterStroke) ResetStroke();
            else Cancel();
        }

        void DrawActionOverlay(WrapImages images, float time)
        {
            var w = session.World;
            float3 At(float x, float z, float raise = .034f) => new float3(x, w.GroundHeight(x, z) + raise, z);
            void Ring(float x, float z, float size, float4 color) => rings.Add(InstanceData.TRS(MapSpace.W(At(x, z)), 0, new float3(size, 1, size), color));
            void Line(float3 a, float3 b, float4 color, float width)
            {
                float dx = w.Grid.DxWrap(a.x, b.x), dz = b.z - a.z;
                float length = math.length(new float2(dx, dz));
                if (length < .025f) return;
                var pos = At(a.x + dx * .5f, a.z + dz * .5f, .058f);
                routeLines.Add(InstanceData.TRS(MapSpace.W(pos), MapSpace.Yaw(Mathf.Atan2(dx, dz)), new float3(width, .018f, length), color));
            }
            void Corners(float x, float z, float yaw, float width, float depth, float4 color)
            {
                math.sincos(yaw, out float sn, out float cs);
                float3 PointAt(float a, float b) => At(x + a * cs + b * sn, z - a * sn + b * cs);
                for (int i = -1; i <= 1; i += 2) for (int j = -1; j <= 1; j += 2)
                {
                    float a = i * width * .5f, b = j * depth * .5f;
                    color.w = 0;
                    Line(PointAt(a, b), PointAt(a - i * .15f, b), color, .0045f);
                    Line(PointAt(a, b), PointAt(a, b - j * .15f), color, .0045f);
                }
            }
            // the instanced material is opaque (colour alpha drives emission), so the hovered parcel is shown
            // as a full glowing outline plus an inset outline rather than a translucent plate
            void Fill(float x, float z, float yaw, float width, float depth, float4 color)
            {
                math.sincos(yaw, out float sn, out float cs);
                float3 PointAt(float a, float b) => At(x + a * cs + b * sn, z - a * sn + b * cs);
                for (int ring = 0; ring < 2; ring++)
                {
                    float w2 = width * (ring == 0 ? .5f : .42f), d2 = depth * (ring == 0 ? .5f : .42f);
                    var c0 = PointAt(-w2, -d2); var c1 = PointAt(w2, -d2); var c2 = PointAt(w2, d2); var c3 = PointAt(-w2, d2);
                    Line(c0, c1, color, .006f); Line(c1, c2, color, .006f); Line(c2, c3, color, .006f); Line(c3, c0, color, .006f);
                }
            }
            if (session.Objectives.TryGetValue(SelectedObjective, out var headquarters) && headquarters.IsBase && headquarters.Owner == session.CivId && headquarters.Parcels != null)
            {
                // the wider selection ring around the whole base (spec B5)
                float baseRadius = headquarters.Radius * 1.15f;
                var ringColor = new float4(.29f, .59f, 1f, .55f);
                for (int segment = 0; segment < 96; segment++)
                {
                    float a = segment * math.PI * 2 / 96, b = (segment + 1) * math.PI * 2 / 96;
                    Line(At(headquarters.X + math.sin(a) * baseRadius, headquarters.Z + math.cos(a) * baseRadius),
                        At(headquarters.X + math.sin(b) * baseRadius, headquarters.Z + math.cos(b) * baseRadius), ringColor, .02f);
                }
                float glow = .5f + .5f * Mathf.Sin(time * Mathf.PI * 2f / 1.6f);
                foreach (var lot in headquarters.Parcels)
                {
                    if (lot.Id == 0) continue;
                    bool locked = lot.Tier > headquarters.Tier;
                    bool empty = !locked && headquarters.Slots != null && Array.IndexOf(headquarters.Slots, lot.Id) >= 0;
                    var color = locked ? new float4(.61f, .56f, .44f, .45f) : empty ? new float4(.89f, .71f, .38f, .35f + .35f * glow) : new float4(.46f, .71f, .64f, .55f);
                    bool hovered = lot.Id == HoverRingSlot || lot.Id == HoverRingSlotFromWorld;
                    if (hovered)
                    {
                        color = new float4(.55f, .78f, 1f, 1f);
                        Fill(lot.X, lot.Z, lot.Yaw, lot.Width, lot.Depth, new float4(.35f, .65f, 1f, 1f));
                    }
                    if (lot.Id == SelectedRingSlot) color = Amber;
                    Corners(lot.X, lot.Z, lot.Yaw, lot.Width, lot.Depth, color);
                }
            }
            if (Current == Mode.Target && FieldPreviewParcel != null) foreach (var lot in newBaseRing) Corners(lot.x, lot.z, lot.y, .9f, .9f, Valid);   // New Base ring footprint
            // 2026-11-18: the build-wheel structure's real footprint under its ghost (green allowed, red refused): the
            // rotated rectangle for walls with width × depth (the server's level-check outline), else its radius; when the
            // ghost was snapped away from the cursor, an amber lead from the cursor to where it will really stand
            if (Current == Mode.Target && FieldPreviewParcel is BaseParcel ghost && newBaseRing.Count == 0 && ProtocolDecoder.Str(TargetCommand?["c"]) == "fieldBuild")
            {
                var def = session.Defs?["BUILDINGS"]?[Option];
                var footprint = FieldPreviewValid ? Valid : Invalid;
                float fw = ProtocolDecoder.Float(def?["width"]), fd = ProtocolDecoder.Float(def?["depth"]), fr = ProtocolDecoder.Float(def?["radius"], .3f);
                if (fw > 0f && fd > 0f) Fill(ghost.X, ghost.Z, ghost.Yaw, fw, fd, footprint);
                else { Ring(ghost.X, ghost.Z, fr * 2f, footprint); Ring(ghost.X, ghost.Z, fr * 2f + .06f, new float4(footprint.xyz, footprint.w * .5f)); }
                if (FieldPreviewSnapped)
                {
                    var c = FieldPreviewCursor;
                    Line(At(c.x, c.z), At(ghost.X, ghost.Z), Amber, .014f);
                    Ring(c.x, c.z, .22f, Amber);
                }
            }
            DrawSelectedBuildingRings();   // footprint-fitted building / turret rings (Commander.Selection.cs, C-D §36)
            foreach (var s in session.Objectives.Values)
            {
                if (s.Operational && s.Headquarters != 0) continue;
                if (cam.Distance > 39 && s.Id != SelectedObjective) continue;
                float dx = w.Grid.DxWrap(cam.Focus.x, s.X), dz = s.Z - cam.Focus.z;
                if (dx * dx + dz * dz > (cam.Distance + 5) * (cam.Distance + 5)) continue;
                if (s.Id != SelectedObjective && s.Capture <= 0 && !s.Contested && s.Tile != hoverTile) continue;
                var color = s.Contested ? Invalid : s.Owner >= 0 ? new float4(session.CivColor(s.Owner).xyz, .10f) : new float4(.66f, .47f, .24f, .08f);
                for (int segment = 0; segment < 72; segment++)
                {
                    float a = segment * math.PI * 2 / 72, b = (segment + 1) * math.PI * 2 / 72;
                    Line(At(s.X + math.sin(a) * s.Radius, s.Z + math.cos(a) * s.Radius), At(s.X + math.sin(b) * s.Radius, s.Z + math.cos(b) * s.Radius), color, .006f);
                }
            }
            if (lineDrag)
            {
                for (int k = 1; k < worldLine.Count; k++) Line(worldLine[k - 1], worldLine[k], Amber, .024f);
                if (linePreview == null) DrawLinePlaceholders();   // until the server's dry run answers
                for (int i = 0; i < lineSlotCount; i++)
                {
                    ref var p = ref lineSlots[i];
                    var color = p.State == 0 ? Invalid : p.State == 1 ? Valid : Amber;
                    Ring(p.X, p.Z, .25f, color);
                    if (p.State > 0) Line(At(p.X, p.Z), At(p.X + Mathf.Sin(p.Face) * .23f, p.Z + Mathf.Cos(p.Face) * .23f), color, .028f);
                }
            }
            else if (Current == Mode.Trench || Current == Mode.Road)
            {
                for (int k = 1; k < worldStroke.Count; k++) Line(worldStroke[k - 1], worldStroke[k], Amber, .028f);
                // accepted parts green, skipped parts red (they are left out when the stroke is committed); parsed once per reply
                for (int i = 0; i < strokePartCount; i++)
                {
                    ref var p = ref strokeParts[i];
                    var color = p.Ok ? Valid : Invalid;
                    if (p.Segment) Line(At(p.Ax, p.Az), At(p.Bx, p.Bz), color, .023f);
                    else Ring(p.Ax, p.Az, .29f, color);
                }
            }
            else if (units.Selected.Count <= 16)
            {
                foreach (int id in units.Selected)
                {
                    if (!session.Units.WorldPaths.TryGetValue(id, out var path) || !units.TryGetPosition(session.Units, id, out var u)) continue;
                    var a = At(u.x, u.y);
                    for (int j = 0; j < Math.Min(8, path.Length); j++)
                    {
                        var b = At(path[j].X, path[j].Z);
                        float dx = w.Grid.DxWrap(a.x, b.x), dz = b.z - a.z;
                        int steps = Mathf.Clamp(Mathf.CeilToInt(math.length(new float2(dx, dz)) / .8f), 1, 12);
                        for (int k = 1; k <= steps; k++)
                            Line(At(a.x + dx * (k - 1f) / steps, a.z + dz * (k - 1f) / steps), At(a.x + dx * k / steps, a.z + dz * k / steps), Valid * .67f, .014f);
                        a = b;
                    }
                }
            }
            routeLines.DrawImages(images);
        }

        /// <summary>
        /// No persistent mode hints in the action ruleset (spec B3/E17): tools are explained by the tool chip.
        /// Only a battle line being drawn reports how many positions it found.
        /// </summary>
        string ActionModeHint()
        {
            if (!lineDrag) return "";
            if (linePlaced != lineHintCount) { lineHintCount = linePlaced; lineHint = linePlaced > 0 ? $"{linePlaced} positions" : ""; }
            return lineHint;
        }
    }
}
