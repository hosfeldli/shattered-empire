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
        public int SelectedRingSlot { get; private set; }
        public int SelectedPickup { get; private set; }
        public string RingPreviewType { get; private set; }
        public BaseParcel? RingPreviewParcel { get; private set; }
        public BaseParcel? FieldPreviewParcel { get; private set; }
        public bool FieldPreviewValid { get; private set; }
        public float FieldYaw { get; private set; }
        public string FieldPreviewReason { get; private set; } = "Choose visible, clear terrain.";
        float fieldPreviewYaw;
        string fieldPreviewType;
        float fieldPreviewAt;
        Vector3 fieldPreviewPoint;
        int fieldPreviewToken;
        /// <summary>The New Base preview ring: (x, yaw, z) per parcel, from the server preview.</summary>
        readonly List<Vector3> newBaseRing = new List<Vector3>(8);

        void UpdateFieldPreview(float time, bool overUi)
        {
            cam.PlacementRotation = Current == Mode.Target && ProtocolDecoder.Str(TargetCommand?["c"]) == "fieldBuild";
            if (Current != Mode.Target || ProtocolDecoder.Str(TargetCommand?["c"]) != "fieldBuild" || overUi || !cam.TryGround(InputFacade.MousePosition, out var point))
            { FieldPreviewParcel = null; fieldPreviewType = null; return; }
            if (InputFacade.Action("rotate_left")) FieldYaw -= Mathf.PI / 12;
            if (InputFacade.Action("rotate_right")) FieldYaw += Mathf.PI / 12;
            FieldYaw = Mathf.Atan2(Mathf.Sin(FieldYaw), Mathf.Cos(FieldYaw));
            int tile = session.World.Grid.TileAt(point.x, point.z);
            FieldPreviewParcel = new BaseParcel { Tile = tile, X = point.x, Z = point.z, Yaw = FieldYaw, Width = .9f, Depth = .9f };
            bool changed = fieldPreviewType != Option || (point - fieldPreviewPoint).sqrMagnitude > .035f || Mathf.Abs(FieldYaw - fieldPreviewYaw) > .001f;
            if (changed) { fieldPreviewToken++; FieldPreviewValid = false; FieldPreviewReason = "Checking the footprint…"; newBaseRing.Clear(); }
            if (!changed || time < fieldPreviewAt) return;
            fieldPreviewAt = time + .15f; fieldPreviewType = Option; fieldPreviewPoint = point; fieldPreviewYaw = FieldYaw; FieldPreviewValid = false;
            int token = ++fieldPreviewToken;
            session.Net?.Command(new JObject { ["c"] = "fieldPreview", ["type"] = Option, ["point"] = Point(point), ["yaw"] = FieldYaw }, r =>
            {
                if (token != fieldPreviewToken || Current != Mode.Target) return;
                FieldPreviewValid = r.Error == null && ProtocolDecoder.Bool(r.Raw?["placement"]?["valid"]);
                FieldPreviewReason = ReadableError(r) ?? "Valid footprint · Click to begin construction";
                // a New Base preview answers with its eight-parcel ring ([tile, x, z, yaw] each): drawn while placing
                newBaseRing.Clear();
                if (FieldPreviewValid && r.Raw?["placement"]?["parcels"] is JArray ring)
                    foreach (var t in ring) if (t is JArray q && q.Count >= 4) newBaseRing.Add(new Vector3(ProtocolDecoder.Float(q[1]), ProtocolDecoder.Float(q[3]), ProtocolDecoder.Float(q[2])));
            });
        }

        BuildingRecord? SpatialBuildingAt(Vector2 mouse)
        {
            BuildingRecord? result = null; float best = float.MaxValue;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (!b.HasPosition) continue;
                float x = session.World.Grid.NearX(b.X, cam.Focus.x), y = session.World.GroundHeight(b.X, b.Z);
                var center = cam.ToScreen(new Vector3(x, y + .18f, b.Z)); if (center.z <= 0) continue;
                float size = ProtocolDecoder.Float(session.Defs?["BUILDINGS"]?[b.Type]?["radius"], .5f);
                var a = cam.ToScreen(new Vector3(x - size, y, b.Z - size));
                var c = cam.ToScreen(new Vector3(x + size, y + .65f, b.Z + size));
                float radius = Mathf.Max(12, Mathf.Abs(a.x - c.x) * .58f);
                float d = (new Vector2(center.x, center.y) - mouse).sqrMagnitude;
                if (d < radius * radius && d < best) { best = d; result = b; }
            }
            return result;
        }

        bool PickupAt(Vector2 mouse, out ResourcePickup pickup)
        {
            pickup = default; float best = 22 * 22;
            foreach (var c in session.Pickups.Values)
            {
                float x = session.World.Grid.NearX(c.X, cam.Focus.x);
                var p = cam.ToScreen(new Vector3(x, session.World.GroundHeight(c.X, c.Z) + .09f, c.Z));
                float d = (new Vector2(p.x, p.y) - mouse).sqrMagnitude;
                if (p.z > 0 && d < best) { best = d; pickup = c; }
            }
            return pickup.Id != 0;
        }

        bool SelectActionPickup(Vector2 mouse)
        {
            if (!PickupAt(mouse, out var p)) return false;
            units.Selected.Clear(); SelectedBuildings.Clear(); SelectedObjective = SelectedRingSlot = 0;
            SelectedPickup = p.Id; SelectionChanged?.Invoke(); return true;
        }

        bool SelectActionRing(Vector2 mouse, bool doubleClick = false)
        {
            if (SpatialBuildingAt(mouse) is BuildingRecord b)
            {
                SelectedPickup = SelectedRingSlot = 0;
                if (b.Type == "town") { SelectObjective(b.City); return true; }
                if (!doubleClick || b.Owner != session.CivId) { SelectProduction(new[] { b.Id }); return true; }
                // double-click: every own building of that type on screen (the wheel shows the shared roster)
                var same = new List<int> { b.Id };
                foreach (var o in session.Structures.Buildings.Values)
                {
                    if (o.Id == b.Id || o.Owner != b.Owner || o.Type != b.Type || !o.HasPosition) continue;
                    var sp = WorldToScreen(o.X, o.Z, .18f);
                    if (sp.z > 0 && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height) same.Add(o.Id);
                }
                SelectProduction(same); return true;
            }
            if (!cam.TryGround(mouse, out var point)) return false;
            if (!NearestOwnParcel(point, out var choice, out var parcel)) return false;
            SelectRingSlot(choice.Id, parcel.Id); return true;
        }

        bool NearestOwnParcel(Vector3 point, out ObjectiveSite choice, out BaseParcel parcel, int onlySite = 0)
        {
            float best = .57f * .57f; choice = default; parcel = default;
            foreach (var s in session.Objectives.Values)
            {
                if (!s.IsBase || s.Owner != session.CivId || s.Parcels == null) continue;
                if (onlySite != 0 && s.Id != onlySite) continue;
                foreach (var p in s.Parcels)
                {
                    if (p.Id == 0) continue;
                    float dx = session.World.Grid.DxWrap(point.x, p.X), dz = p.Z - point.z, d = dx * dx + dz * dz;
                    if (d >= best) continue; best = d; choice = s; parcel = p;
                }
            }
            return choice.Id != 0;
        }

        // ------------------------------------------------------------------ socket glow (spec B7)
        /// <summary>Set by the base wheel while a socket wedge is hovered: that parcel glows in the world.</summary>
        public int HoverRingSlot { get; set; }
        /// <summary>The parcel of the selected own base under the cursor (computed each frame), so its wedge lights up.</summary>
        public int HoverRingSlotFromWorld { get; private set; }

        int WorldParcelUnderCursor()
        {
            if (SelectedObjective == 0 || units.Selected.Count > 0) return 0;
            if (!cam.TryGround(InputFacade.MousePosition, out var point)) return 0;
            return NearestOwnParcel(point, out _, out var parcel, SelectedObjective) ? parcel.Id : 0;
        }

        /// <summary>Screen position (pixels, z = depth; z &lt;= 0 behind the camera) of a map point, wrap-aware.</summary>
        public Vector3 WorldToScreen(float x, float z, float raise = 0f)
        {
            float nx = session.World.Grid.NearX(x, cam.Focus.x);
            return cam.ToScreen(new Vector3(nx, session.World.GroundHeight(nx, z) + raise, z));
        }

        public void SelectRingSlot(int siteId, int slotId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            var building = session.Structures.Buildings.Values.FirstOrDefault(b => b.Slot == slotId && b.City == siteId);
            if (building.Id != 0) { SelectProduction(new[] { building.Id }); return; }
            SelectObjective(siteId); SelectedRingSlot = slotId; SelectedPickup = 0;
            RingPreviewType = null; RingPreviewParcel = null; SelectionChanged?.Invoke();
        }

        public void PreviewRingFacility(int siteId, int slotId, string type)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site) || site.Slots == null || !site.Slots.Contains(slotId)) return;
            RingPreviewType = type; RingPreviewParcel = site.Parcels.First(p => p.Id == slotId);
        }
        public void ClearRingPreview() { RingPreviewType = null; RingPreviewParcel = null; }

        public void BuildRingFacility(int siteId, int slotId, string type)
        {
            ClearRingPreview();
            session.Net?.Command(new JObject { ["c"] = "baseBuild", ["site"] = siteId, ["slot"] = slotId, ["type"] = type },
                r => { Say(ReadableError(r) ?? "Construction started", r.Error == null, Time.unscaledTime); SelectionChanged?.Invoke(); });
        }

        public void BeginFieldConstruction(string type)
        {
            Begin(Mode.Target, type, new JObject { ["c"] = "fieldBuild", ["type"] = type, ["tile"] = "@map" });
        }

        /// <summary>Draw a trench (defense bar).</summary>
        public void BeginTrench() => Begin(Mode.Trench);
        /// <summary>Draw a road (defense bar).</summary>
        public void BeginRoad() => Begin(Mode.Road);
    }
}
