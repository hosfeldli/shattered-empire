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
            rightPress = lineDrag = false;
            worldLine.Clear();
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
            var order = new Order { MapPoint = point, Time = Time.unscaledTime };
            Orders.Add(order);
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
            linePreview = null;
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
                if (previewOnly) { if (token == lineToken && lineDrag) linePreview = plan; return; }
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
            else
            {
                cmd["c"] = "move"; cmd["point"] = Point(point);
                cmd["attackMove"] = InputFacade.Ctrl; cmd["queue"] = InputFacade.Shift;
            }
            var order = new Order { MapPoint = point, Time = time };
            Orders.Add(order);
            UI.Hud.NoteOrder(units.Selected, point, (string)cmd["c"], time);
            order.Rid = session.Net?.Command(cmd, r =>
            {
                Resolve(order, r);
                if (r.Error == null) ActionMoveOrders++;
            }) ?? -1;
        }

        void SetActionRally(int tile, float time)
        {
            var ids = SelectedBuildings.ToList();
            if (SelectedObjective > 0) ids.AddRange(session.Structures.Buildings.Values.Where(b =>
                b.City == SelectedObjective && b.Done && session.Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).Select(b => b.Id));
            var cmd = new JObject { ["c"] = "rally", ["buildings"] = new JArray(ids), ["tile"] = tile };
            if (cam.TryGround(InputFacade.MousePosition, out var p)) cmd["point"] = Point(p);
            session.Net?.Command(cmd, r => Say(r.Error ?? "Rally point set", r.Error == null, Time.unscaledTime));
        }

        void DrawActionTrench(float time, bool overUi)
        {
            if (InputFacade.RightDown) { Cancel(); return; }
            if (!overUi && InputFacade.LeftDown) { worldStroke.Clear(); previewAt = 0; dragging = true; }
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
                    if (commit) Say(r.Error ?? (operation == "roadBuild" ? "Road construction started" : "Trench construction started"), r.Error == null, Time.unscaledTime);
                    else if (token == trenchToken && (Current == Mode.Trench || Current == Mode.Road)) actionTrenchPreview = r.Raw?[operation == "roadBuild" ? "road" : "trench"] as JObject;
                });
            }
            if (commit) { dragging = false; Cancel(); }
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
            foreach (int id in SelectedBuildings) if (session.Structures.Buildings.TryGetValue(id, out var selected))
                Corners(selected.X, selected.Z, selected.Yaw, 1.02f, 1.02f, new float4(.43f, .77f, .65f, .5f));
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
                if (linePreview?["positions"] is JArray positions) foreach (var token in positions)
                    if (token is JArray p && p.Count >= 5)
                    {
                        float x = ProtocolDecoder.Float(p[1]), z = ProtocolDecoder.Float(p[2]), face = ProtocolDecoder.Float(p[3]);
                        int state = ProtocolDecoder.Int(p[4]);
                        var color = state == 0 ? Invalid : state == 1 ? Valid : Amber;
                        Ring(x, z, .25f, color);
                        if (state > 0) Line(At(x, z), At(x + Mathf.Sin(face) * .23f, z + Mathf.Cos(face) * .23f), color, .028f);
                    }
            }
            else if (Current == Mode.Trench || Current == Mode.Road)
            {
                for (int k = 1; k < worldStroke.Count; k++) Line(worldStroke[k - 1], worldStroke[k], Amber, .028f);
                if (actionTrenchPreview?["positions"] is JArray trench) foreach (var p in trench)
                {
                    if (Current == Mode.Road) Line(At(ProtocolDecoder.Float(p["from"]?["x"]), ProtocolDecoder.Float(p["from"]?["z"])), At(ProtocolDecoder.Float(p["to"]?["x"]), ProtocolDecoder.Float(p["to"]?["z"])), Valid, .023f);
                    else Ring(ProtocolDecoder.Float(p["x"]), ProtocolDecoder.Float(p["z"]), .29f, Valid);
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
            int count = ProtocolDecoder.Int(linePreview?["placed"]);
            return count > 0 ? $"{count} positions" : "";
        }
    }
}
