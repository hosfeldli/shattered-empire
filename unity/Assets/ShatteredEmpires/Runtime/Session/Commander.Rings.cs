using System;
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
        string fieldPreviewType;
        float fieldPreviewAt;
        Vector3 fieldPreviewPoint;
        int fieldPreviewToken;

        void UpdateFieldPreview(float time, bool overUi)
        {
            if (Current != Mode.Target || ProtocolDecoder.Str(TargetCommand?["c"]) != "fieldBuild" || overUi || !cam.TryGround(InputFacade.MousePosition, out var point))
            { FieldPreviewParcel = null; fieldPreviewType = null; return; }
            int tile = session.World.Grid.TileAt(point.x, point.z);
            FieldPreviewParcel = new BaseParcel { Tile = tile, X = point.x, Z = point.z, Width = .9f, Depth = .9f };
            bool changed = fieldPreviewType != Option || (point - fieldPreviewPoint).sqrMagnitude > .035f;
            if (!changed || time < fieldPreviewAt) return;
            fieldPreviewAt = time + .25f; fieldPreviewType = Option; fieldPreviewPoint = point; FieldPreviewValid = false;
            int token = ++fieldPreviewToken;
            session.Net?.Command(new JObject { ["c"] = "fieldPreview", ["type"] = Option, ["point"] = Point(point) }, r =>
            {
                if (token != fieldPreviewToken || Current != Mode.Target) return;
                FieldPreviewValid = r.Error == null && ProtocolDecoder.Bool(r.Raw?["placement"]?["valid"]);
                Say(r.Error ?? "Valid site · Click to begin construction", r.Error == null, Time.unscaledTime);
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

        bool SelectActionRing(Vector2 mouse)
        {
            if (SpatialBuildingAt(mouse) is BuildingRecord b)
            {
                SelectedPickup = SelectedRingSlot = 0;
                if (b.Type == "town") { SelectObjective(b.City); return true; }
                SelectProduction(new[] { b.Id }); return true;
            }
            if (!cam.TryGround(mouse, out var point)) return false;
            float best = .57f * .57f; ObjectiveSite choice = default; BaseParcel parcel = default;
            foreach (var s in session.Objectives.Values)
            {
                if (!s.IsBase || s.Owner != session.CivId || s.Parcels == null) continue;
                foreach (var p in s.Parcels)
                {
                    if (p.Id == 0) continue;
                    float dx = session.World.Grid.DxWrap(point.x, p.X), dz = p.Z - point.z, d = dx * dx + dz * dz;
                    if (d >= best) continue; best = d; choice = s; parcel = p;
                }
            }
            if (choice.Id == 0) return false;
            SelectRingSlot(choice.Id, parcel.Id); return true;
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
                r => { Say(r.Error ?? "Construction started", r.Error == null, Time.unscaledTime); SelectionChanged?.Invoke(); });
        }

        public void BeginFieldConstruction(string type)
        {
            Begin(Mode.Target, type, new JObject { ["c"] = "fieldBuild", ["type"] = type, ["tile"] = "@map" });
        }
    }
}
