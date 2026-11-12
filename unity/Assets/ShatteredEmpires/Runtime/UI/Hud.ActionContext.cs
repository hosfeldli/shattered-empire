using System;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    public sealed partial class Hud
    {
        bool showUnitDetails, showAirMissions, reinforcementPicker;
        string lastActionSelection;
        bool CloseActionContext()
        {
            if (openPanel != "") return false;
            if (showUnitDetails || showAirMissions || reinforcementPicker)
            { showUnitDetails = showAirMissions = reinforcementPicker = false; Refresh(true); return true; }
            if (commander.SelectedRingSlot != 0)
            { commander.SelectObjective(commander.SelectedObjective); Refresh(true); return true; }
            return false;
        }
        void UpdateActionContextState()
        {
            string selection = $"{commander.SelectedObjective}:{commander.SelectedRingSlot}:{commander.SelectedPickup}:{string.Join(",", commander.SelectedBuildings)}:{string.Join(",", units.Selected)}";
            if (selection == lastActionSelection) return;
            lastActionSelection = selection; showUnitDetails = showAirMissions = reinforcementPicker = false;
            resultCard?.RemoveFromHierarchy(); resultCard = null;
            if (openPanel != "settings" && openPanel != "guide" && openPanel != "overview") { openPanel = ""; panelSignature = ""; }
        }

        void UpdateActionRail()
        {
            rail.AddToClassList("compact-rail");
            var research = rail.Q<Button>("rail-research");
            if (research != null) research.style.display = session.Structures.Buildings.Values.Any(b => b.Owner == session.CivId && b.Type == "armory" && b.Done) ? DisplayStyle.Flex : DisplayStyle.None;
            var settings = rail.Q<Button>("rail-settings");
            if (settings != null) settings.style.display = DisplayStyle.None;
            foreach (var button in rail.Children().OfType<Button>())
            {
                var label = button.Q<Label>();
                if (label != null) button.tooltip = label.text;
            }
            var build = rail.Q<Button>("rail-build");
            if (build != null) build.tooltip = commander.SelectedObjective != 0 ? "Base construction" : "Field construction";
        }

        void OpenFieldMenu()
        { commander.ClearRingPreview(); openPanel = "build"; panelTab = "Field"; panelSignature = ""; Refresh(true); }

        void ActionFieldMenu(VisualElement into)
        {
            L("Field construction", "title", into);
            L("Choose a structure, then place it on visible terrain. Engineers help automatically.", "small muted", into);
            var routes = El("row wrap", into);
            void Tool(Commander.Mode mode) { openPanel = ""; commander.Begin(mode); Refresh(true); }
            B("Trench · 35 M / segment", () => Tool(Commander.Mode.Trench), routes, "defense");
            B("Road · 15 M / link", () => Tool(Commander.Mode.Road), routes, "build");
            foreach (string type in Defenses)
            {
                var d = Defs?["BUILDINGS"]?[type];
                if (d == null || ProtocolDecoder.Int(d["tier"], 1) > Age + 1) continue;
                var button = B(NameOf("BUILDINGS", type) + " · " + CostText(d["cost"]), () =>
                { openPanel = ""; commander.BeginFieldConstruction(type); Refresh(true); }, into, "defense");
                button.tooltip = ProtocolDecoder.Str(d["desc"], "") + $" Construction {ProtocolDecoder.Int(d["time"])}s. No ring site required.";
                TrackConstructionCost(button, d["cost"], !session.Spectator);
            }
        }

        void ActionToolCard()
        {
            var row = El("row", card);
            string command = ProtocolDecoder.Str(commander.TargetCommand?["c"]);
            string title = commander.Current switch
            {
                Commander.Mode.Road => "Build a road", Commander.Mode.Trench => "Draw a trench",
                Commander.Mode.Rally => "Set rally point", Commander.Mode.Place => "Choose a ring site",
                _ => command == "fieldBuild" ? NameOf("BUILDINGS", commander.Option) : command == "move" ? "Attack-move" : command == "ability" ? ProtocolDecoder.Str(Defs?["ABILITIES"]?[ProtocolDecoder.Str(commander.TargetCommand?["ability"])]?["name"], "Use ability") : "Choose a target"
            };
            L(title, "heading grow", row);
            B("Cancel · Esc", () => { commander.Cancel(); Refresh(true); }, row);
            var state = L("", "small muted", card);
            string Status() => commander.Current == Commander.Mode.Road || commander.Current == Commander.Mode.Trench
                ? "Drag across clear, visible terrain. Release to construct."
                : command == "fieldBuild" ? commander.FieldPreviewValid ? "Valid ground · Click to construct" : "Move the preview to a legal, visible position"
                : "Click a world position. Enter confirms; right-click or Escape cancels.";
            state.text = Status(); live.Add((state, Status));
            if (command == "fieldBuild") L(CostText(Defs?["BUILDINGS"]?[commander.Option]?["cost"]), "small", card);
        }

        void ActionCompactSite(VisualElement into, ObjectiveSite site)
        {
            var header = El("row", into);
            L(site.Name, "heading grow", header).tooltip = ProtocolDecoder.Str(SiteDefinition(site)?[site.IsBase ? "bonus" : "benefit"], "");
            L(site.IsBase && site.Headquarters != 0 ? $"HQ {TierLabels[Mathf.Clamp(site.Tier - 1, 0, 2)]}" : SiteStatus(site), "small muted", header);
            if (site.Owner != session.CivId || !site.IsBase || site.Headquarters == 0)
            {
                L(ProtocolDecoder.Str(SiteDefinition(site)?[site.IsBase ? "bonus" : "benefit"], ""), "small muted", into);
                if (site.Capture > 0 || site.Contested)
                    ActionMeter(into, () => session.Objectives.TryGetValue(site.Id, out var current) ? current.Capture : 0, () => site.Contested ? "CONTESTED" : "CAPTURING");
                else if (site.Headquarters == 0 && site.Owner != session.CivId) L("Infantry or engineers secure the command zone.", "small muted", into);
                if (site.IsBase && site.Owner == session.CivId && site.Headquarters == 0 && !session.Spectator)
                {
                    var cost = ProtocolDecoder.Int(Econ?["recovery"]) > 0 ? new JObject { ["materials"] = 140 } : Defs?["BUILDINGS"]?["town"]?["cost"];
                    var establish = B("Establish headquarters · " + CostText(cost), () => Cmd(new JObject { ["c"] = "establish", ["site"] = site.Id }, "Reconstruction started"), into, "build", "primary");
                    TrackConstructionCost(establish, cost, !site.Contested);
                }
                return;
            }
            if (!site.Operational)
            { ActionMeter(into, () => session.Objectives.TryGetValue(site.Id, out var current) ? current.Build : 0, () => "RECONSTRUCTING"); return; }
            var hq = session.Structures.Buildings.TryGetValue(site.Headquarters, out var record) ? record : default;
            bool choosing = commander.SelectedRingSlot != 0;
            if (choosing)
            {
                B("‹ Headquarters", () => { commander.SelectObjective(site.Id); Refresh(true); }, header);
                var parcel = site.Parcels.FirstOrDefault(p => p.Id == commander.SelectedRingSlot);
                if (parcel.Tier > site.Tier)
                { L($"This site unlocks at local HQ Tier {TierLabels[parcel.Tier - 1]}.", "small muted", into); CompactHeadquartersUpgrade(into, site, hq); return; }
                var choices = El("row wrap context-facilities", into);
                var buildings = session.Structures.Buildings.Values.Where(b => b.City == site.Id && b.Owner == session.CivId).ToArray();
                foreach (string type in Facilities)
                {
                    var d = Defs?["BUILDINGS"]?[type];
                    if (d == null || ProtocolDecoder.Int(d["tier"], 1) > Age + 1) continue;
                    int slot = commander.SelectedRingSlot;
                    string needs = ProtocolDecoder.Str(d["needs"]);
                    bool ready = string.IsNullOrEmpty(needs) || buildings.Any(b => b.Type == needs && b.Done);
                    var button = B(NameOf("BUILDINGS", type) + " · " + CostText(d["cost"]), () => commander.BuildRingFacility(site.Id, slot, type), choices, Icons.BuildingKind(type), "context-facility");
                    button.tooltip = ProtocolDecoder.Str(d["desc"], "") + $" {ProtocolDecoder.Int(d["time"])}s." + (ready ? "" : " Requires " + NameOf("BUILDINGS", needs) + ".");
                    button.RegisterCallback<PointerEnterEvent>(_ => commander.PreviewRingFacility(site.Id, slot, type));
                    button.RegisterCallback<PointerLeaveEvent>(_ => commander.ClearRingPreview());
                    TrackConstructionCost(button, d["cost"], ready && site.Slots.Contains(slot));
                }
                return;
            }
            var grid = El("ring-site-grid compact-sites", into);
            foreach (var parcel in (site.Parcels ?? Array.Empty<BaseParcel>()).Where(p => p.Id > 0).OrderBy(p => p.Id))
            {
                int id = parcel.Id;
                var building = session.Structures.Buildings.Values.FirstOrDefault(b => b.City == site.Id && b.Slot == id);
                bool locked = parcel.Tier > site.Tier;
                string label = locked ? "Tier " + TierLabels[parcel.Tier - 1] : building.Id == 0 ? "Build" : NameOf("BUILDINGS", building.Type);
                var button = B(label, () => { commander.SelectRingSlot(site.Id, id); Refresh(true); }, grid, locked ? "research" : building.Id == 0 ? "build" : Icons.BuildingKind(building.Type), "ring-site");
                button.EnableInClassList("locked", locked);
                button.tooltip = locked ? $"Upgrade this headquarters to Tier {TierLabels[parcel.Tier - 1]}." : building.Id == 0 ? "Select a facility for this empty site." : building.Done ? "Open production and facility controls." : $"Construction {building.Progress}%";
            }
            var footer = El("row wrap", into);
            CompactHeadquartersUpgrade(footer, site, hq);
            B("Field construction", OpenFieldMenu, footer, "defense");
            if (hq.Project == "tier") ActionMeter(into, () => session.Structures.Buildings.TryGetValue(hq.Id, out var current) ? current.WorksPct : 0, () => "HQ UPGRADE");
        }

        void CompactHeadquartersUpgrade(VisualElement into, ObjectiveSite site, BuildingRecord hq)
        {
            if (site.Tier >= 3 || session.Spectator || hq.Project != null) return;
            var next = Defs?["AGES"]?[site.Tier];
            var button = B($"Upgrade HQ · {TierLabels[site.Tier]}", () => Cmd(new JObject { ["c"] = "advance", ["site"] = site.Id }, "Headquarters upgrade started"), into, "research");
            button.tooltip = $"Unlock two local building sites and faction technology. {CostText(next?["cost"])} · {ProtocolDecoder.Int(next?["time"])}s.";
            TrackConstructionCost(button, next?["cost"], true);
        }

        void ActionUnitCard()
        {
            if (showUnitDetails) { B("‹ Army controls", () => { showUnitDetails = false; Refresh(true); }, card); ActionUnitDetails(); return; }
            var selected = units.Selected.Where(id => session.Units.TryGet(id, out _)).Select(id => { session.Units.TryGet(id, out var u); return u; }).ToArray();
            if (selected.Length == 0) return;
            var types = selected.Select(u => session.Units.Types.Name(u.TypeIndex)).Distinct().ToArray();
            var head = El("row", card);
            L(types.Length == 1 ? $"{selected.Length} × {NameOf("UNITS", types[0])}" : $"{selected.Length} units · {types.Length} roles", "heading grow", head)
                .tooltip = string.Join("\n", types.Select(t => NameOf("UNITS", t) + ": " + UnitRole(t)));
            B("Details", () => { showUnitDetails = true; Refresh(true); }, head);
            if (AvgHp() < 99) ActionMeter(card, AvgHp, () => "CONDITION");
            if (session.Spectator) return;
            var row = El("row wrap", card);
            B("Attack-move", () => commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true }), row, "attack");
            B("Hold", () => commander.UnitCommand("hold", null, "Holding position"), row);
            B("Retreat", () => commander.UnitCommand("withdraw", null, "Retreat ordered"), row);
            foreach (string ability in types.Select(t => ProtocolDecoder.Str(Defs?["UNITS"]?[t]?["ability"])).Where(a => a != null).Distinct())
            {
                var d = Defs?["ABILITIES"]?[ability]; if (d == null) continue;
                string name = ProtocolDecoder.Str(d["name"], ability);
                var button = B(name, () =>
                {
                    var command = new JObject { ["c"] = "ability", ["ability"] = ability, ["units"] = "@units" };
                    if (ProtocolDecoder.Bool(d["point"])) commander.Begin(Commander.Mode.Target, "", command);
                    else commander.UnitCommand("ability", new JObject { ["ability"] = ability }, name);
                }, row, null, "ability");
                button.tooltip = ProtocolDecoder.Str(d["desc"]);
                var ids = selected.Where(u => ProtocolDecoder.Str(Defs?["UNITS"]?[session.Units.Types.Name(u.TypeIndex)]?["ability"]) == ability).Select(u => u.Id).ToArray();
                var label = button.Q<Label>();
                string Cooldown()
                {
                    float ready = float.MaxValue;
                    foreach (int id in ids) if (session.Units.TryGet(id, out var unit)) ready = Mathf.Min(ready, unit.Motion.Cooldown);
                    button.SetEnabled(ready <= .1f);
                    return ready > .1f && ready < float.MaxValue ? $"{name} · {Mathf.CeilToInt(ready)}s" : name;
                }
                label.text = Cooldown(); live.Add((label, Cooldown));
            }
            if (types.Any(t => ProtocolDecoder.Bool(Defs?["UNITS"]?[t]?["air"])))
            {
                B("Air missions", () => { showAirMissions = !showAirMissions; Refresh(true); }, row);
                if (showAirMissions) foreach (string mission in new[] { "patrol", "scout", "intercept", "support", "return" })
                    B(mission, () => { if (mission == "return") commander.UnitCommand("airMission", new JObject { ["mission"] = mission }, "Returning to base"); else BeginAirMission(mission); }, row);
            }
        }

        void BeginAirMission(string mission)
        { commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "airMission", ["mission"] = mission, ["units"] = "@units", ["tile"] = "@map" }); }
    }
}
