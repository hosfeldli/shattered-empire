using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Action ruleset: the selection card (spec B10, status only — commands live on the wheels), the world
    /// markers for bases and objectives (B5), the tutorial coach and the match result.
    /// </summary>
    public sealed partial class Hud
    {
        static readonly string[] TierLabels = { "I", "II", "III" };
        static readonly string[] Facilities = { "depot", "power_plant", "barracks", "motor_works", "heavy_weapons", "airfield", "advanced_lab", "missile_silo" };
        static readonly string[] Defenses = { "barricade", "guard_post", "bunker", "turret", "aa_battery", "sensor_post", "repair_point", "artillery_post", "fort" };

        static string Tier(int tier) => TierLabels[Mathf.Clamp(tier - 1, 0, 2)];

        VisualElement objectiveLayer;
        bool layoutIsAction, layoutInitialized;
        readonly Dictionary<int, ObjectiveMarker> objectiveMarkers = new Dictionary<int, ObjectiveMarker>();

        /// <summary>Called by the shell when the game interface appears; styles the selection card for the action ruleset.</summary>
        void ApplyRulesetLayout()
        {
            if (layoutInitialized && layoutIsAction == session.ActionRts) return;
            layoutInitialized = true;
            layoutIsAction = session.ActionRts;
            if (card != null) StyleSelectionCard(layoutIsAction);
            cmdCardSignature = "";
        }

        JToken SiteDefinition(ObjectiveSite site)
        {
            if (!site.IsBase) return Defs?["OUTPOST_TYPES"]?[site.Kind];
            return (Defs?["RUIN_TYPES"] as JArray)?.FirstOrDefault(r => ProtocolDecoder.Str(r["key"]) == site.Kind);
        }

        /// <summary>Capture state (R7): 0 none, 1 rising, 2 paused (contested), 3 draining (decaying).</summary>
        static int CaptureState(in ObjectiveSite s) => s.Contested && s.Capture > 0 ? 2 : s.Decaying && s.Capture > 0 ? 3 : s.Capture > 0 ? 1 : s.Contested ? 2 : 0;

        /// <summary>The capture line, in words (never colour only): rising, paused while contested, or draining.</summary>
        static string CaptureText(in ObjectiveSite s) => CaptureState(s) switch
        {
            1 => $"Capturing {s.Capture:0}%",
            2 => s.Capture > 0 ? $"Paused · contested · {s.Capture:0}%" : "Contested",
            3 => $"Draining {s.Capture:0}% · nobody capturing",
            _ => "",
        };

        string SiteStatus(ObjectiveSite s)
        {
            if (s.Contested || s.Capture > 0) return CaptureText(s);
            if (s.Operational) return $"Tier {Tier(s.Tier)} headquarters";
            if (s.Headquarters != 0) return $"Rebuilding · {s.Build:0}%";
            if (s.Owner == session.CivId) return s.IsBase ? "Secured · establish a base" : "Controlled";
            return s.Owner < 0 ? "Unclaimed" : "Controlled by " + FactionName(s.Owner);
        }

        string FactionName(int id)
        {
            foreach (var civ in session.Welcome.Civs) if (civ.Id == id) return civ.Name;
            return "a rival";
        }

        /// <summary>The selection panel's place (panel units): bottom-right, beside nothing else that is docked.</summary>
        public const float SelectionPanelWidth = 560f, SelectionPanelRight = 16f, SelectionPanelBottom = 16f, SelectionPanelMaxHeight = 300f;

        /// <summary>One line: what the unit is for, then what it is weak against (hover card, selection tooltips).</summary>
        static string UnitRole(string type) => type switch
        {
            "engineer" => "Automatic base engineer: builds what you place and repairs · weak to everything armed",
            "anti_armor" => "Kills vehicles · weak to infantry and artillery",
            "field_gun" => "Long-range anti-vehicle gun · weak to infantry and artillery",
            "rifle_squad" or "militia" => "Holds and captures ground · weak to artillery and armor in the open",
            "special_forces" => "Elite raiders and capture team · weak to armor and artillery",
            "exo_infantry" => "Infantry fighting vehicle: autocannon vs infantry and light vehicles, anti-tank missile every 10 s · weak to tanks and anti-armor",
            "mech_infantry" => "Fast armored infantry · weak to anti-armor",
            "tank" or "autonomous_tank" => "Armored front line · weak to anti-armor teams and aircraft",
            "mortar_team" => "Indirect fire on dug-in troops · weak to fast raiders",
            "sp_artillery" => "Long-range bombardment · weak to aircraft and raids",
            "missile_battery" => "Long-range missile bombardment; sets up (5 s) before firing and cannot engage within 3.5 hexes · weak to aircraft and anything that closes in",
            "fighter" => "Warthog: strafing runs with a 30 mm cannon, deadly to armor · cannot hit aircraft, slow and fragile under air defense",
            "air_defense" => "Shoots down aircraft · weak to tanks and infantry",
            "scout_buggy" or "armored_car" => "Fast scout and raider · weak to anti-armor and tanks",
            "recon_drone" => "Spots and detects from the air · weak to air defense",
            "bomber" => "Heavy strikes on ground targets · weak to air defense",
            "helicopter" => "Hunts armor from the air · weak to air defense",
            "oneway_drone" or "strike_swarm" => "One-shot precision strike · weak to air defense",
            "supply_truck" => "Repairs and resupplies in the field · unarmed",
            _ => "Ground support"
        };

        // ------------------------------------------------------------------ selection card (B10)
        UiKit.SmoothResize cardResize;   // the selection panel eases to its new height when rebuilt (Hud.cs Build)
        int cardSubject = int.MinValue, cardUnits;
        string cmdCardSignature = "";
        readonly List<Action> cmdCardLive = new List<Action>();
        bool cardStyled;

        void StyleSelectionCard(bool action)
        {
            card.EnableInClassList("se-cmd-card", action);
            cardStyled = action;
            if (!action)
            {
                card.style.left = StyleKeyword.Null; card.style.right = StyleKeyword.Null; card.style.top = StyleKeyword.Null;
                card.style.bottom = StyleKeyword.Null; card.style.width = StyleKeyword.Null; card.style.marginLeft = StyleKeyword.Null;
                card.style.maxHeight = StyleKeyword.Null;
                return;
            }
            // the selection panel, docked bottom-right (mockup 2026-11-16); fixed width, never percentage-based (defect 21)
            card.style.position = Position.Absolute;
            card.style.left = StyleKeyword.Auto; card.style.right = SelectionPanelRight;
            card.style.top = StyleKeyword.Auto; card.style.bottom = SelectionPanelBottom;
            card.style.width = SelectionPanelWidth; card.style.marginLeft = 0;
            card.style.maxHeight = SelectionPanelMaxHeight;
        }

        void ActionCard(bool force)
        {
            if (card == null) return;
            if (!cardStyled) StyleSelectionCard(true);
            // a running tool replaces the card with the tool chip (Hud.DefenseBar.cs)
            // (an armed attack move keeps the panel: its button shows the armed state)
            if (commander.Current != Commander.Mode.Select && !commander.AttackMoveArmed) { UiKit.Hide(card); cmdCardSignature = "tool"; return; }
            session.Objectives.TryGetValue(commander.SelectedObjective, out var site);
            // the living selected units (jumpiness: the global unit-membership revision changed with every spawn and
            // death anywhere on the map, rebuilding the panel several times a second in a battle)
            int unitHash = 0, alive = 0;
            foreach (int id in units.Selected) if (session.Units.TryGet(id, out _)) { unitHash = unitHash * 31 + id; alive++; }
            // the structure revision matters only to a building card and unit membership only to a unit card (live
            // values update in place): a site card is no longer rebuilt whenever any building in the world changes
            bool buildingsSelected = commander.SelectedBuildings.Count > 0;
            int structureRev = buildingsSelected ? session.Structures.Revision : 0;
            int membershipRev = alive;
            string sig = $"{site.Id}|{site.Owner}|{site.Headquarters}|{site.Operational}|{site.Tier}|{site.Contested}|{site.Capture > 0}|{site.Slots?.Length}|" +
                $"{commander.SelectedPickup}|{(buildingsSelected ? string.Join(",", commander.SelectedBuildings) : "")}|{units.Selected.Count}:{unitHash}|{structureRev}|{membershipRev}";
            if (!force && sig == cmdCardSignature) { foreach (var update in cmdCardLive) update(); return; }
            cmdCardSignature = sig;
            // a new subject (or more units) cross-fades the content in; casualties only resize the panel smoothly
            int subject = site.Id * 397 ^ commander.SelectedPickup * 31 ^ (units.Selected.Count > 0 ? 1 : 0);
            foreach (int b in commander.SelectedBuildings) subject ^= b * 7;
            bool freshContent = subject != cardSubject || alive > cardUnits;
            cardSubject = subject; cardUnits = alive;
            bool wasShown = UiKit.IsShown(card);
            cardResize?.Arm();
            card.Clear();
            cmdCardLive.Clear();
            card.RemoveFromClassList("se-sel-panel");
            if (commander.SelectedPickup != 0) PickupCard();
            else if (site.Id > 0) SiteCard(site);
            else if (commander.SelectedBuildings.Count > 0) BuildingStatusCard();
            else if (units.Selected.Count > 0) UnitStatusCard();
            UiKit.SetShown(card, card.childCount > 0);
            if (wasShown && freshContent) UiKit.EnterChildren(card, 0, 16);
            foreach (var update in cmdCardLive) update();
        }

        VisualElement CardHeader(string icon, string title, out Label name)
        {
            var head = UiKit.El("se-cmd-card-head", card);
            head.style.flexDirection = FlexDirection.Row; head.style.alignItems = Align.Center; head.style.height = 32;
            var glyph = new IconElement(icon ?? "", "se-cmd-card-icon");
            glyph.style.width = 24; glyph.style.height = 24; glyph.style.flexShrink = 0;
            head.Add(glyph);
            name = UiKit.Text(title, "se-cmd-card-name", head);
            name.style.flexGrow = 1; name.style.flexShrink = 1; name.style.overflow = Overflow.Hidden;
            name.style.textOverflow = TextOverflow.Ellipsis; name.style.whiteSpace = WhiteSpace.NoWrap;
            return head;
        }

        Label CardLine(string cls = "se-cmd-card-line")
        {
            var line = UiKit.Text("", cls, card);
            line.style.whiteSpace = WhiteSpace.NoWrap; line.style.overflow = Overflow.Hidden; line.style.textOverflow = TextOverflow.Ellipsis;
            return line;
        }

        /// <summary>A 4 px bar with a caption beside it; value 0..100 (or below 0 to hide the row).</summary>
        void CardBar(Func<float> value, Func<string> caption, Func<Color> color = null)
        {
            var row = UiKit.El("se-cmd-bar-row", card);
            row.style.flexDirection = FlexDirection.Row; row.style.alignItems = Align.Center; row.style.height = 20;
            var track = UiKit.El("se-cmd-bar", row);
            track.style.flexGrow = 1; track.style.height = 4;
            var fill = UiKit.El("se-cmd-bar-fill", track);
            fill.style.height = 4;
            var text = UiKit.Text("", "se-cmd-bar-caption", row);
            text.style.width = 190; text.style.flexShrink = 0; text.style.unityTextAlign = TextAnchor.MiddleRight;
            text.style.whiteSpace = WhiteSpace.NoWrap; text.style.overflow = Overflow.Hidden; text.style.textOverflow = TextOverflow.Ellipsis;
            cmdCardLive.Add(() =>
            {
                float v = value();
                row.style.visibility = v < 0 ? Visibility.Hidden : Visibility.Visible;
                fill.style.width = Length.Percent(Mathf.Clamp(v, 0, 100));
                if (color != null) fill.style.backgroundColor = color();
                string t = caption?.Invoke() ?? "";
                if (text.text != t) text.text = t;
            });
        }

        static Color HealthColor(float hp) => hp > 60 ? UiKit.Token("good") : hp > 30 ? UiKit.Token("warn") : UiKit.Token("bad");

        float SelectionHp()
        {
            float hp = 0; int n = 0;
            foreach (int id in units.Selected) if (session.Units.TryGet(id, out var r)) { hp += r.Hp; n++; }
            return n > 0 ? hp / n : 0;
        }

        void PickupCard()
        {
            if (!session.Pickups.TryGetValue(commander.SelectedPickup, out var pickup))
            { CardHeader("materials", "Materials collected", out _); return; }
            bool energy = pickup.Resource == "energy";
            var head = CardHeader(energy ? "energy" : "materials", $"{(energy ? "Energy" : "Materials")} cache", out _);
            // gradual collection (2026-11-19): what is left, live, and the pace (5 a second per unit at the cache)
            int id = pickup.Id;
            var meta = UiKit.Text("", "se-cmd-card-meta", head);
            void Refresh()
            {
                if (!session.Pickups.TryGetValue(id, out var p)) { meta.text = "Collected"; return; }
                string left = p.Max > 0 && p.Max != p.Amount ? $"{p.Amount} / {p.Max} left" : $"{p.Amount} {(energy ? "Energy" : "Materials")}";
                meta.text = p.Memory ? left + " · last seen" : p.Collecting > 0
                    ? $"{left} · {p.Collecting} unit{(p.Collecting == 1 ? "" : "s")} collecting, +{5 * p.Collecting}/s"
                    : $"{left} · units collect 5 a second each";
            }
            Refresh();
            cmdCardLive.Add(Refresh);
        }

        void SiteCard(ObjectiveSite site)
        {
            bool own = site.Owner == session.CivId;
            string glyph = site.IsBase ? own && site.Headquarters != 0 ? "hq" : "house" : OutpostGlyph(site.Kind);
            var head = CardHeader(glyph, site.Name, out _);
            if (!own || !site.IsBase)
            {
                // enemy or neutral site: owner dot + name, capture/contested bar
                var dot = UiKit.El("se-cmd-owner-dot", head);
                dot.style.width = 10; dot.style.height = 10; dot.style.flexShrink = 0; dot.SendToBack();
                dot.style.backgroundColor = UiKit.RelationColor(session, site.Owner);
                var owner = UiKit.Text(site.Owner < 0 ? "Unclaimed" : own ? "Yours" : FactionName(site.Owner), "se-cmd-card-meta", head);
                owner.style.flexShrink = 0;
                int id = site.Id;
                CaptureBar(id, false);
                return;
            }
            int siteId = site.Id;
            if (site.Headquarters == 0)
            {
                var line = CardLine();
                cmdCardLive.Add(() => { string t = session.Objectives.TryGetValue(siteId, out var s) ? SiteStatus(s) : ""; if (line.text != t) line.text = t; });
                CaptureBar(siteId, true);
                return;
            }
            if (!site.Operational)
            {
                CardBar(() => session.Objectives.TryGetValue(siteId, out var s) ? s.Build : 0, () => session.Objectives.TryGetValue(siteId, out var s) ? $"Reconstructing {s.Build:0}%" : "");
                return;
            }
            // own base: tier pips · income · sockets; HQ condition bar
            var info = UiKit.El("se-cmd-base-row", card);
            info.style.flexDirection = FlexDirection.Row; info.style.alignItems = Align.Center; info.style.height = 22;
            var pips = UiKit.El("se-cmd-pips", info);
            pips.style.flexDirection = FlexDirection.Row; pips.style.width = 40; pips.style.flexShrink = 0;
            var pipEls = new VisualElement[3];
            for (int k = 0; k < 3; k++)
            {
                pipEls[k] = UiKit.El("se-cmd-pip", pips);
                pipEls[k].style.width = 6; pipEls[k].style.height = 6; pipEls[k].style.marginRight = 2;
            }
            var income = UiKit.Text("", "se-cmd-card-line", info);
            income.style.flexGrow = 1;
            var sockets = UiKit.Text("", "se-cmd-card-meta", info);
            sockets.style.width = 90; sockets.style.unityTextAlign = TextAnchor.MiddleRight;
            cmdCardLive.Add(() =>
            {
                if (!session.Objectives.TryGetValue(siteId, out var s)) return;
                for (int k = 0; k < 3; k++) pipEls[k].style.backgroundColor = k < s.Tier ? UiKit.Token("friendly") : new Color(1, 1, 1, .18f);
                var (m, e) = BaseIncome(siteId);
                income.text = $"+{m:0.0}/s Materials · +{e:0.0}/s Energy";
                int used = Mathf.Max(0, s.Capacity - (s.Slots?.Length ?? 0));
                sockets.text = $"{used}/{s.Capacity} used";
            });
            int hqId = site.Headquarters;
            if (session.Structures.Buildings.TryGetValue(hqId, out var hqRecord) && GarrisonCapacity(hqRecord.Type) > 0) GarrisonPanel(hqId);
            CardBar(() => session.Structures.Buildings.TryGetValue(hqId, out var hq) ? hq.Project != null ? hq.WorksPct : hq.Hp : 0,
                () => session.Structures.Buildings.TryGetValue(hqId, out var hq) ? hq.Project == "tier" ? $"Upgrading {hq.WorksPct}%" : hq.Project == "perimeter" ? $"Perimeter {hq.WorksPct}%" : $"Condition {hq.Hp}%" : "",
                () => session.Structures.Buildings.TryGetValue(hqId, out var hq) && hq.Project == null ? HealthColor(hq.Hp) : UiKit.Token("good"));
        }

        /// <summary>
        /// The capture bar of a site card (R7): a state glyph and words for rising, paused (contested) and draining
        /// (decaying) progress, so the state never rests on colour alone. Updated only when the state or the value moves.
        /// </summary>
        void CaptureBar(int siteId, bool securing)
        {
            var row = UiKit.El("se-cmd-bar-row", card);
            row.style.flexDirection = FlexDirection.Row; row.style.alignItems = Align.Center; row.style.height = 20;
            var glyph = new IconElement("", "se-cmd-card-icon");
            glyph.style.width = 14; glyph.style.height = 14; glyph.style.flexShrink = 0; glyph.style.marginRight = 6;
            row.Add(glyph);
            var track = UiKit.El("se-cmd-bar", row);
            track.style.flexGrow = 1; track.style.height = 4;
            var fill = UiKit.El("se-cmd-bar-fill", track);
            fill.style.height = 4;
            var text = UiKit.Text("", "se-cmd-bar-caption", row);
            text.style.width = 230; text.style.flexShrink = 0; text.style.unityTextAlign = TextAnchor.MiddleRight;
            text.style.whiteSpace = WhiteSpace.NoWrap; text.style.overflow = Overflow.Hidden; text.style.textOverflow = TextOverflow.Ellipsis;
            int shownState = -2; float shownCapture = -1f; bool shownVisible = true;
            cmdCardLive.Add(() =>
            {
                bool found = session.Objectives.TryGetValue(siteId, out var s);
                bool visible = found && (securing ? s.Capture > 0 && s.Capture < 100 || s.Contested : s.Capture > 0 || s.Contested);
                if (visible != shownVisible) { shownVisible = visible; row.style.visibility = visible ? Visibility.Visible : Visibility.Hidden; }
                if (!visible) return;
                int state = CaptureState(s);
                if (state == shownState && Mathf.Abs(s.Capture - shownCapture) < .05f) return;
                bool stateChanged = state != shownState;
                shownState = state; shownCapture = s.Capture;
                fill.style.width = Length.Percent(Mathf.Clamp(s.Capture, 0, 100));
                string t = securing && state == 1 ? $"Securing {s.Capture:0}%" : CaptureText(s);
                if (text.text != t) text.text = t;
                if (!stateChanged) return;
                glyph.Kind = state == 1 ? "upgrade" : state == 2 ? "pause" : state == 3 ? "withdraw" : "";
                var color = state == 2 ? UiKit.Token("warn") : state == 3 ? UiKit.Token("bad")
                    : UiKit.RelationColor(session, s.Capturing >= 0 ? s.Capturing : s.Owner);
                glyph.Tint = color;
                fill.style.backgroundColor = color;
                // a draining bar reads as emptying: dimmed fill
                fill.style.opacity = state == 3 ? .6f : 1f;
            });
        }

        (float materials, float energy) BaseIncome(int siteId)
        {
            float m = 0, e = 0;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.City != siteId || b.Owner != session.CivId || !b.Done) continue;
                var d = Defs?["BUILDINGS"]?[b.Type];
                m += ProtocolDecoder.Float(d?["materials"]);
                e += ProtocolDecoder.Float(d?["energy"]);
            }
            return (m, e);
        }

        static string OutpostGlyph(string kind) => kind switch
        {
            "supply" => "materials", "energy" => "energy", "radar" => "sensor", "repair" => "repair", "defense" => "bunker", _ => "house"
        };

        void BuildingStatusCard()
        {
            var selected = commander.SelectedBuildings.Where(session.Structures.Buildings.ContainsKey).Select(id => session.Structures.Buildings[id]).ToArray();
            if (selected.Length == 0) return;
            var first = selected[0];
            string title = selected.Length == 1 ? NameOf("BUILDINGS", first.Type) : $"{selected.Length} × {NameOf("BUILDINGS", first.Type)}";
            if (selected.Any(b => b.Type != first.Type)) title = $"{selected.Length} facilities";
            var head = CardHeader(Icons.BuildingKind(first.Type), title, out _);
            if (first.Owner != session.CivId)
            {
                var dot = UiKit.El("se-cmd-owner-dot", head);
                dot.style.width = 10; dot.style.height = 10; dot.style.flexShrink = 0;
                dot.style.backgroundColor = UiKit.RelationColor(session, first.Owner);
            }
            int firstId = first.Id;
            CardBar(() =>
            {
                if (!session.Structures.Buildings.TryGetValue(firstId, out var b)) return -1;
                return !b.Done ? b.Progress : b.Project != null || b.WorksKind != null ? b.WorksPct : b.Hp;
            }, () =>
            {
                if (!session.Structures.Buildings.TryGetValue(firstId, out var b)) return "";
                if (!b.Done) return $"Construction {b.Progress}%";
                if (b.Project != null) return $"{ProjectName(b.Project)} {b.WorksPct}%";
                if (b.WorksKind != null) return $"{(b.WorksKind == "repair" ? "Repairing" : "Upgrading")} {b.WorksPct}%";
                return $"Condition {b.Hp}%";
            }, () => session.Structures.Buildings.TryGetValue(firstId, out var b) && b.Done && b.Project == null && b.WorksKind == null ? HealthColor(b.Hp) : UiKit.Token("good"));
            if (first.Owner != session.CivId) return;
            if (selected.Length == 1 && first.Done && GarrisonCapacity(first.Type) > 0) GarrisonPanel(first.Id);
            var trainerIds = selected.Where(b => Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).Select(b => b.Id).ToArray();
            if (trainerIds.Length == 0) return;
            ProductionPanel(trainerIds);
        }

        // ------------------------------------------------------------------ garrison on the card (W4, R4)
        const int GarrisonChips = 6;

        /// <summary>
        /// A structure's garrison: "Garrison 2/4 · 2 firing" with Exit rally / Clear / Eject all, and one chip per
        /// occupant (a gold top edge marks a firing slot). Click a chip to select that squad; right-click ejects it.
        /// Updated only when the snapshot changes.
        /// </summary>
        void GarrisonPanel(int buildingId)
        {
            var head = UiKit.El("se-cmd-bar-row", card);
            head.style.flexDirection = FlexDirection.Row; head.style.alignItems = Align.Center; head.style.height = 24;
            var glyph = new IconElement("bunker", "se-cmd-card-icon");
            glyph.style.width = 16; glyph.style.height = 16; glyph.style.flexShrink = 0; glyph.style.marginRight = 6;
            head.Add(glyph);
            var summary = UiKit.Text("", "se-cmd-card-line", head);
            summary.style.flexGrow = 1; summary.style.flexShrink = 1;
            summary.style.overflow = Overflow.Hidden; summary.style.textOverflow = TextOverflow.Ellipsis; summary.style.whiteSpace = WhiteSpace.NoWrap;
            SmallButton("Exit rally", null, () => BeginGarrisonExitRally(buildingId), "Set where squads go when they step out (click the ground)", head, 70);
            var clearRally = SmallButton(null, "close", () => ClearGarrisonExitRally(buildingId), "Clear the exit rally point", head, 22);
            var eject = SmallButton("Eject all", null, () => Ungarrison(buildingId), "Every squad steps out", head, 64);
            var chipsRow = UiKit.El("se-cmd-queue", card);
            chipsRow.style.flexDirection = FlexDirection.Row; chipsRow.style.alignItems = Align.Center; chipsRow.style.height = 30;
            var chips = new VisualElement[GarrisonChips];
            var chipIcons = new IconElement[GarrisonChips];
            var chipUnit = new int[GarrisonChips];
            for (int k = 0; k < GarrisonChips; k++)
            {
                int index = k;
                var chip = UiKit.El("se-cmd-queue-item", chipsRow);
                chip.style.width = 30; chip.style.height = 28; chip.style.marginRight = 4;
                chip.style.borderTopWidth = 2; chip.style.borderTopColor = Color.clear;
                chip.style.backgroundColor = new Color(1, 1, 1, .06f);
                var icon = new IconElement("", "se-cmd-queue-icon");
                icon.style.width = 22; icon.style.height = 22;
                chip.Add(icon);
                chip.RegisterCallback<PointerDownEvent>(e =>
                {
                    int id = chipUnit[index];
                    if (id == 0) return;
                    if (e.button == 0) commander.SelectUnits(new[] { id });
                    else if (e.button == 1) Ungarrison(buildingId, id);
                    e.StopPropagation();
                });
                chips[k] = chip; chipIcons[k] = icon;
            }
            var none = UiKit.Text("Empty · select infantry squads and right-click this structure (or Garrison on their wheel)", "se-cmd-card-meta", chipsRow);
            none.style.marginLeft = 0;
            int snap = -1; string shownSummary = null; bool shownRally = true, shownAny = true;
            var shownChip = new int[GarrisonChips];
            for (int k = 0; k < GarrisonChips; k++) shownChip[k] = -1;
            cmdCardLive.Add(() =>
            {
                if (snap == session.Snapshots) return;
                snap = session.Snapshots;
                if (!session.Structures.Buildings.TryGetValue(buildingId, out var b)) return;
                int n = b.Garrison?.Length ?? 0, slots = FiringSlots(b.Type);
                string text = "Garrison · " + GarrisonSummary(buildingId);
                if (text != shownSummary) { shownSummary = text; summary.text = text; }
                if (b.HasGarrisonExit != shownRally) { shownRally = b.HasGarrisonExit; clearRally.style.display = shownRally ? DisplayStyle.Flex : DisplayStyle.None; }
                bool any = n > 0;
                if (any != shownAny) { shownAny = any; eject.SetEnabled(any); none.style.display = any ? DisplayStyle.None : DisplayStyle.Flex; }
                for (int k = 0; k < GarrisonChips; k++)
                {
                    int id = k < n ? b.Garrison[k] : 0;
                    chipUnit[k] = id;
                    if (id == shownChip[k]) continue;
                    shownChip[k] = id;
                    chips[k].style.display = id != 0 ? DisplayStyle.Flex : DisplayStyle.None;
                    if (id == 0) continue;
                    string type = UnitTypeOf(id) ?? "";
                    chipIcons[k].Kind = type;
                    bool firing = k < slots;
                    chips[k].style.borderTopColor = firing ? UiKit.Token("warn") : Color.clear;
                    chips[k].tooltip = (type.Length > 0 ? NameOf("UNITS", type) : "Squad") + (firing ? "\nIn a firing slot: shoots from the structure" : "\nSheltered: protected, not firing")
                        + "\nClick: select · right-click: eject";
                }
            });
        }

        // ------------------------------------------------------------------ production queues on the card (W1, §7–9)
        const int QueueRows = 5;
        static readonly Color[] ShareColors =
        {
            new Color(.43f, .84f, .47f), new Color(.29f, .59f, 1f), new Color(.94f, .74f, .34f), new Color(.78f, .52f, .95f), new Color(.36f, .82f, .84f), new Color(.93f, .45f, .38f),
        };
        // scratch for the live update (no allocation per update)
        readonly List<string> queueTypes = new List<string>(8);

        sealed class QueueRow
        {
            public VisualElement Root, Swatch, Fill;
            public IconElement Icon, StateIcon;
            public Label Name, State;
            public UnityEngine.UIElements.Button Priority, Pause, CancelOne, CancelAll;
            public string Type;
            // last shown values: text and styles are touched only when these change
            public int Count = -1, PriorityShown = -1, Paused = -1;
            public float Progress = -1f;
            public string StateShown;
            public bool Legacy, Shown = true;
        }

        static UnityEngine.UIElements.Button SmallButton(string label, string icon, Action click, string tooltip, VisualElement parent, float width)
        {
            var b = string.IsNullOrEmpty(label) ? UiKit.IconButton(icon, click, tooltip, parent, 22) : UiKit.Button(label, click, parent, null, null);
            b.style.height = 22; b.style.minHeight = 22; b.style.width = width; b.style.minWidth = width;
            b.style.marginLeft = 3; b.style.paddingLeft = 2; b.style.paddingRight = 2; b.style.fontSize = 11;
            b.focusable = false;
            if (!string.IsNullOrEmpty(tooltip)) b.tooltip = tooltip;
            return b;
        }

        /// <summary>
        /// The production panel of the selection card: the shared capacity bar (how the building's one production
        /// budget is split across its queues, R1), Clear, and a row per unit-type queue with count, progress, state
        /// (icon and words), priority, pause, cancel one and cancel all. Several selected buildings of one type are
        /// summed per unit type and every command goes to each building that holds that queue.
        /// </summary>
        void ProductionPanel(int[] trainerIds)
        {
            // header: label · capacity split bar · caption · Repeat tag · Clear
            var head = UiKit.El("se-cmd-bar-row", card);
            head.style.flexDirection = FlexDirection.Row; head.style.alignItems = Align.Center; head.style.height = 24;
            var label = UiKit.Text("Production", "se-cmd-card-meta", head);
            label.style.marginLeft = 0; label.style.flexShrink = 0;
            var bar = UiKit.El("se-cmd-bar", head);
            bar.style.flexGrow = 1; bar.style.height = 5; bar.style.flexDirection = FlexDirection.Row; bar.style.overflow = Overflow.Hidden;
            bar.tooltip = "Production capacity: one budget per building. Units are produced one at a time in the order they were queued " +
                "(high priority first); a queue that is waiting for funds passes its turn to the next. Coloured parts: the queues producing now; dark: unused.";
            var segments = new VisualElement[ShareColors.Length];
            for (int k = 0; k < segments.Length; k++)
            {
                segments[k] = UiKit.El(null, bar);
                segments[k].style.height = 5; segments[k].style.backgroundColor = ShareColors[k];
                segments[k].style.width = 0;
            }
            var caption = UiKit.Text("", "se-cmd-bar-caption", head);
            caption.style.width = 170; caption.style.flexShrink = 0; caption.style.unityTextAlign = TextAnchor.MiddleRight;
            caption.style.whiteSpace = WhiteSpace.NoWrap; caption.style.overflow = Overflow.Hidden; caption.style.textOverflow = TextOverflow.Ellipsis;
            var tag = UiKit.Text("Repeat", "se-cmd-tag", head);
            tag.style.marginLeft = 6; tag.style.flexShrink = 0;
            var clear = SmallButton("Clear", null, () => QueueClear(HostsFor(trainerIds, null)),
                "Clear the whole queue" + (trainerIds.Length > 1 ? $" of all {trainerIds.Length} buildings" : "") + "\nResources already spent are not refunded.", head, 46);
            var rows = new QueueRow[QueueRows];
            for (int k = 0; k < QueueRows; k++) rows[k] = MakeQueueRow(trainerIds);
            var more = CardLine("se-cmd-card-line se-cmd-card-meta");
            more.style.display = DisplayStyle.None;
            var empty = CardLine("se-cmd-card-line se-cmd-card-meta");
            empty.text = "Nothing queued · train from the building's wheel";
            empty.style.display = DisplayStyle.None;
            int snap = -1; float shownCap = -1f; int shownProducing = -1, shownMore = -1; bool shownRepeat = true, shownAny = true;
            var shares = new float[ShareColors.Length];
            cmdCardLive.Add(() =>
            {
                if (snap == session.Snapshots) return;   // queues change with the snapshot only
                snap = session.Snapshots;
                var hosts = HostsFor(trainerIds, null);
                // the unit types queued, in queue order of the first host that has them
                queueTypes.Clear();
                bool repeat = false;
                float cap = 0f;
                foreach (var b in hosts)
                {
                    cap += b.ProductionCapacity;
                    if (!string.IsNullOrEmpty(b.Repeat)) repeat = true;
                    // 2026-11-20: one row per unit type, in the order its first item was queued (production follows it)
                    if (b.Order != null) foreach (var unit in b.Order) if (!string.IsNullOrEmpty(unit) && !queueTypes.Contains(unit)) queueTypes.Add(unit);
                    if (b.Queues == null) continue;
                    foreach (var q in b.Queues) if (q.Count > 0 && !queueTypes.Contains(q.Unit)) queueTypes.Add(q.Unit);
                }
                // capacity split: per building, its budget shared equally by the queues producing now
                Array.Clear(shares, 0, shares.Length);
                int producing = 0;
                foreach (var b in hosts)
                {
                    if (b.Queues == null) continue;
                    int n = 0;
                    foreach (var q in b.Queues) if (q.State == "producing") n++;
                    if (n == 0) continue;
                    producing += n;
                    float each = b.ProductionCapacity > 0 ? b.ProductionCapacity / n : 1f / n;
                    foreach (var q in b.Queues)
                    {
                        if (q.State != "producing") continue;
                        int at = queueTypes.IndexOf(q.Unit);
                        if (at >= 0 && at < shares.Length) shares[at] += each;
                    }
                }
                float total = cap > 0 ? cap : Mathf.Max(1, hosts.Length);
                for (int k = 0; k < segments.Length; k++) segments[k].style.width = Length.Percent(Mathf.Clamp(shares[k] / total * 100f, 0, 100));
                if (Mathf.Abs(cap - shownCap) > .001f || producing != shownProducing)
                {
                    shownCap = cap; shownProducing = producing;
                    string c = cap > 0 ? $"{cap:0.##} work/s · " : "";
                    caption.text = c + (producing == 0 ? "idle" : producing == 1 ? "in the order queued" : $"{producing} buildings producing");
                }
                if (repeat != shownRepeat) { shownRepeat = repeat; tag.style.display = repeat ? DisplayStyle.Flex : DisplayStyle.None; }
                bool any = queueTypes.Count > 0;
                if (any != shownAny) { shownAny = any; empty.style.display = any ? DisplayStyle.None : DisplayStyle.Flex; clear.SetEnabled(any); }
                for (int k = 0; k < QueueRows; k++)
                    UpdateQueueRow(rows[k], k < queueTypes.Count ? queueTypes[k] : null, hosts, k);
                int extra = Mathf.Max(0, queueTypes.Count - QueueRows);
                if (extra != shownMore)
                {
                    shownMore = extra;
                    more.style.display = extra > 0 ? DisplayStyle.Flex : DisplayStyle.None;
                    if (extra > 0) more.text = $"+{extra} more unit {(extra == 1 ? "type" : "types")} queued · see the building's wheel";
                }
            });
        }

        QueueRow MakeQueueRow(int[] trainerIds)
        {
            var row = new QueueRow();
            row.Root = UiKit.El("se-cmd-queue", card);
            row.Root.style.flexDirection = FlexDirection.Row; row.Root.style.alignItems = Align.Center; row.Root.style.height = 26;
            row.Swatch = UiKit.El(null, row.Root);
            row.Swatch.style.width = 4; row.Swatch.style.height = 18; row.Swatch.style.marginRight = 4; row.Swatch.style.flexShrink = 0;
            row.Icon = new IconElement("", "se-cmd-queue-icon");
            row.Icon.style.width = 20; row.Icon.style.height = 20; row.Icon.style.flexShrink = 0;
            row.Root.Add(row.Icon);
            row.Name = UiKit.Text("", "se-cmd-card-line", row.Root);
            row.Name.style.width = 128; row.Name.style.flexShrink = 0; row.Name.style.marginLeft = 4;
            row.Name.style.overflow = Overflow.Hidden; row.Name.style.textOverflow = TextOverflow.Ellipsis; row.Name.style.whiteSpace = WhiteSpace.NoWrap;
            var track = UiKit.El("se-cmd-bar", row.Root);
            track.style.width = 56; track.style.height = 4; track.style.flexShrink = 0;
            row.Fill = UiKit.El("se-cmd-bar-fill", track);
            row.Fill.style.height = 4; row.Fill.style.width = 0;
            row.StateIcon = new IconElement("", "se-cmd-queue-icon");
            row.StateIcon.style.width = 14; row.StateIcon.style.height = 14; row.StateIcon.style.flexShrink = 0; row.StateIcon.style.marginLeft = 2;
            row.Root.Add(row.StateIcon);
            row.State = UiKit.Text("", "se-cmd-card-line", row.Root);
            row.State.style.flexGrow = 1; row.State.style.flexShrink = 1; row.State.style.marginLeft = 4;
            row.State.style.overflow = Overflow.Hidden; row.State.style.textOverflow = TextOverflow.Ellipsis; row.State.style.whiteSpace = WhiteSpace.NoWrap;
            var r = row;
            row.Priority = SmallButton("Normal", null, () => { if (r.Type != null) QueuePriority(HostsFor(trainerIds, null), r.Type, (Mathf.Max(0, r.PriorityShown) + 1) % 3); },
                "Priority: low → normal → high\nHigher priorities take the building's production capacity first.", row.Root, 58);
            row.Pause = SmallButton(null, "pause", () => { if (r.Type != null) QueuePause(HostsFor(trainerIds, null), r.Type, r.Paused != 1); },
                "Pause or resume this queue (it keeps its progress)", row.Root, 22);
            row.CancelOne = SmallButton("-1", null, () => { if (r.Type != null) QueueCancel(HostsFor(trainerIds, null), r.Type, false); },
                "Cancel one\nResources already spent are not refunded.", row.Root, 30);
            row.CancelAll = SmallButton(null, "close", () => { if (r.Type != null) QueueCancel(HostsFor(trainerIds, null), r.Type, true); },
                "Cancel all of this unit\nResources already spent are not refunded.", row.Root, 22);
            return row;
        }

        /// <summary>One queue row from the summed queue of <paramref name="type"/> (null hides the row); touches only what changed.</summary>
        void UpdateQueueRow(QueueRow row, string type, BuildingRecord[] hosts, int index)
        {
            bool show = type != null;
            if (show != row.Shown) { row.Shown = show; row.Root.style.display = show ? DisplayStyle.Flex : DisplayStyle.None; }
            if (!show) { row.Type = null; return; }
            var s = SummarizeQueue(hosts, type);
            if (type != row.Type)
            {
                row.Type = type; row.Count = -1; row.PriorityShown = -1; row.Paused = -1; row.Progress = -1f; row.StateShown = "\0";
                row.Icon.Kind = type;
                row.Swatch.style.backgroundColor = ShareColors[index % ShareColors.Length];
                row.Root.tooltip = NameOf("UNITS", type) + "\n" + UnitRole(type);
            }
            if (s.Count != row.Count) { row.Count = s.Count; row.Name.text = $"{NameOf("UNITS", type)} ×{s.Count}" + (s.Hosts > 1 ? $" ({s.Hosts})" : ""); }
            if (Mathf.Abs(s.Progress - row.Progress) > .05f) { row.Progress = s.Progress; row.Fill.style.width = Length.Percent(Mathf.Clamp(s.Progress, 0, 100)); }
            if (s.State != row.StateShown)
            {
                row.StateShown = s.State;
                row.State.text = QueueStateText(s.State, type);
                string icon = QueueStateIcon(s.State, type);
                row.StateIcon.Kind = icon ?? (s.State == "producing" ? "play" : "");
                bool producing = s.State == "producing" || s.State == null;
                var tone = producing ? UiKit.Token("good") : s.State == "paused" || s.State == "waiting" ? UiKit.Token("text") : UiKit.Token("warn");
                row.State.style.color = tone; row.StateIcon.Tint = tone;
            }
            int paused = s.PausedHosts > 0 && s.PausedHosts >= s.Hosts ? 1 : 0;
            if (paused != row.Paused)
            {
                row.Paused = paused;
                var ic = UiKit.IconOf(row.Pause);
                if (ic != null) ic.Kind = paused == 1 ? "play" : "pause";
                row.Pause.tooltip = paused == 1 ? "Resume this queue" : "Pause this queue (it keeps its progress)";
            }
            if (s.Priority != row.PriorityShown) { row.PriorityShown = s.Priority; UiKit.SetText(row.Priority, PriorityName(s.Priority)); }
            if (s.Legacy != row.Legacy)
            {
                row.Legacy = s.Legacy;
                row.Priority.SetEnabled(!s.Legacy); row.Pause.SetEnabled(!s.Legacy);
            }
        }

        string ProjectName(string project) => project switch
        {
            "tier" => "Upgrading", "perimeter" => "Perimeter", "missile" => "Missile assembly",
            _ => Defs?["TECHS"]?[project] != null ? NameOf("TECHS", project) : "Upgrading"
        };

        void UnitStatusCard()
        {
            var selected = units.Selected.Where(id => session.Units.TryGet(id, out _)).Select(id => { session.Units.TryGet(id, out var u); return u; }).ToArray();
            if (selected.Length == 0) return;
            var groups = selected.GroupBy(u => session.Units.Types.Name(u.TypeIndex)).OrderByDescending(g => g.Count()).ToArray();
            card.AddToClassList("se-sel-panel");
            // head: "N units selected" · Attack move · F · Stance: X (mockup 2026-11-16)
            var head = UiKit.El("se-sel-head", card);
            UiKit.Text(selected.Length == 1 ? NameOf("UNITS", groups[0].Key) : $"{selected.Length} units selected", "se-sel-title", head);
            if (!session.Spectator && selected.Any(u => u.Owner == session.CivId))
            {
                var attack = UiKit.Button("Attack move · " + HudKey("attack", "F"), () => commander.ArmAttackMove(), head, "attack_move", "se-sel-order se-sel-attack");
                attack.tooltip = "Attack move (" + HudKey("attack", "F") + ")\nClick a destination: the units advance and engage every enemy on the way. Shift keeps it armed. Double-tap for every combat unit on screen.";
                var stance = UiKit.Button("Stance: —", () => commander.CycleStance(), head, "hold", "se-sel-order se-sel-stance");
                attack.focusable = false; stance.focusable = false;   // Space / Enter must not re-click them
                stance.tooltip = "Stance (" + HudKey("stance", "V") + ")\nAggressive chases enemies near its post, then returns; Defensive fires at anything in range but never chases; Hold fire never shoots first (orders still fire).";
                string shownStance = null;
                bool shownArmed = false;
                cmdCardLive.Add(() =>
                {
                    string s = commander.SelectionHolding ? "hold" : commander.SelectionStance;
                    if (s != shownStance) { shownStance = s; UiKit.SetText(stance, "Stance: " + Session.Commander.StanceLabel(s)); }
                    bool armed = commander.AttackMoveArmed;
                    if (armed != shownArmed) { shownArmed = armed; attack.EnableInClassList("selected", armed); }
                });
            }
            // a box per unit type (icon, name, ×count); below six units, one box per unit with its condition
            var grid = UiKit.El("se-sel-grid", card);
            const int MaxBoxes = 6;
            if (selected.Length < 6)
            {
                foreach (var u in selected)
                {
                    int id = u.Id;
                    string type = session.Units.Types.Name(u.TypeIndex);
                    var count = SelectionBox(grid, type, NameOf("UNITS", type), "", new[] { id });
                    int shownHp = -1;
                    cmdCardLive.Add(() =>
                    {
                        int hp = session.Units.TryGet(id, out var r) ? r.Hp : 0;
                        if (hp == shownHp) return;
                        shownHp = hp;
                        count.text = hp + "%";
                        count.EnableInClassList("se-sel-count--hurt", hp <= 60);
                    });
                }
            }
            else
            {
                int shown = groups.Length > MaxBoxes ? MaxBoxes - 1 : groups.Length;
                for (int k = 0; k < shown; k++)
                    SelectionBox(grid, groups[k].Key, NameOf("UNITS", groups[k].Key), "×" + groups[k].Count(), groups[k].Select(u => u.Id).ToArray());
                if (groups.Length > shown)
                {
                    int rest = groups.Skip(shown).Sum(g => g.Count());
                    SelectionBox(grid, "", $"{groups.Length - shown} more types", "×" + rest);
                }
            }
            CardBar(SelectionHp, () => $"Condition {SelectionHp():0}%", () => HealthColor(SelectionHp()));
            AirFuelCardBar();   // Hud.Air.cs (D): lowest fuel among selected aircraft
            var movement = CardLine("se-cmd-card-line se-cmd-card-warn");
            movement.style.display = DisplayStyle.None;
            string shownMovement = "";
            cmdCardLive.Add(() =>
            {
                int queued = 0, blocked = 0, settingUp = 0;
                foreach (int id in units.Selected) if (session.Units.TryGet(id, out var u))
                {
                    if ((u.Flags & 128) != 0) queued++;
                    else if ((u.Flags & 16) != 0) blocked++;
                    if ((u.Flags & 1024) != 0) settingUp++;
                }
                string text = queued > 0 ? $"{queued} queued at a crossing" : blocked > 0 ? $"{blocked} rerouting around obstacles" : settingUp > 0 ? $"{settingUp} setting up" : "";
                if (text == shownMovement) return;
                shownMovement = text;
                movement.text = text;
                movement.style.display = text.Length > 0 ? DisplayStyle.Flex : DisplayStyle.None;
            });
        }

        /// <summary>
        /// One box of the selection panel: the unit glyph in a well, the name and a count (or condition). Returns the
        /// count label. A click narrows the selection to the box's units; Shift-click drops them from it.
        /// </summary>
        Label SelectionBox(VisualElement grid, string type, string name, string count, int[] ids = null)
        {
            var box = UiKit.El("se-sel-box", grid);
            var well = UiKit.El("se-sel-well", box);
            if (!string.IsNullOrEmpty(type)) well.Add(new IconElement(type, "se-sel-icon"));
            var text = UiKit.El("se-sel-box-text", box);
            var label = UiKit.Text(name, "se-sel-name", text);
            label.style.whiteSpace = WhiteSpace.Normal;
            var c = UiKit.Text(count, "se-sel-count", text);
            if (!string.IsNullOrEmpty(type)) box.tooltip = name + "\n" + UnitRole(type) + (ids != null ? "\nClick: select only these · Shift-click: remove them" : "");
            if (ids != null && ids.Length > 0)
            {
                box.AddToClassList("se-sel-box--pick");
                box.RegisterCallback<ClickEvent>(e =>
                {
                    if (e.button != 0) return;
                    if (e.shiftKey) commander.SelectUnits(units.Selected.Where(id => Array.IndexOf(ids, id) < 0).ToArray());
                    else commander.SelectUnits(ids);
                    e.StopPropagation();
                });
            }
            return c;
        }

        // ------------------------------------------------------------------ world markers (B5)
        sealed class SiteBadge : VisualElement
        {
            public int Shape;            // 0 filled circle (own), 1 diamond (enemy), 2 hollow ring (neutral / outpost)
            public Color Color = Color.white;
            public float Progress = -1;  // 0..1 capture/rebuild arc
            public Color ProgressColor = Color.white;
            public int Pips;             // tier pips (0 hides)
            public bool Contested;
            public float Pulse;
            /// <summary>Capture state glyph beside the badge (R7): 0 none, 1 rising (up chevron), 2 paused (two bars), 3 draining (down chevron).</summary>
            public int CaptureState;

            public SiteBadge()
            {
                pickingMode = PickingMode.Ignore;
                style.position = Position.Absolute; style.left = 0; style.top = 0; style.width = 28; style.height = 38;
                generateVisualContent += Paint;
            }

            /// <summary>Applies the visual state; repaints only when something drawn changed (the pulse matters only while contested).</summary>
            public void Set(int shape, Color color, float progress, Color progressColor, int pips, bool contested, float pulse, int captureState = 0)
            {
                if (!contested) pulse = 0f;
                if (shape == Shape && color == Color && progress == Progress && progressColor == ProgressColor && pips == Pips && contested == Contested
                    && Mathf.Abs(pulse - Pulse) < .02f && captureState == CaptureState) return;
                Shape = shape; Color = color; Progress = progress; ProgressColor = progressColor; Pips = pips; Contested = contested; Pulse = pulse;
                CaptureState = captureState;
                MarkDirtyRepaint();
            }

            /// <summary>The capture state glyph at the badge's top-right (shape, not colour only).</summary>
            void PaintCaptureState(Painter2D p)
            {
                if (CaptureState == 0) return;
                var o = new Vector2(29, 3);   // just right of the badge, above the name
                p.fillColor = new Color(.03f, .05f, .06f, .75f);
                p.BeginPath(); p.Arc(o + new Vector2(5, 5), 6.5f, 0f, 360f); p.Fill();
                if (CaptureState == 2)
                {
                    p.fillColor = new Color(1f, .82f, .4f, 1f);
                    p.BeginPath(); p.MoveTo(o + new Vector2(2, 1)); p.LineTo(o + new Vector2(4, 1)); p.LineTo(o + new Vector2(4, 9)); p.LineTo(o + new Vector2(2, 9)); p.ClosePath(); p.Fill();
                    p.BeginPath(); p.MoveTo(o + new Vector2(6, 1)); p.LineTo(o + new Vector2(8, 1)); p.LineTo(o + new Vector2(8, 9)); p.LineTo(o + new Vector2(6, 9)); p.ClosePath(); p.Fill();
                    return;
                }
                bool up = CaptureState == 1;
                p.fillColor = up ? ProgressColor : new Color(.95f, .42f, .34f, 1f);
                p.BeginPath();
                if (up) { p.MoveTo(o + new Vector2(5, 0.5f)); p.LineTo(o + new Vector2(10, 8.5f)); p.LineTo(o + new Vector2(0, 8.5f)); }
                else { p.MoveTo(o + new Vector2(0, 1.5f)); p.LineTo(o + new Vector2(10, 1.5f)); p.LineTo(o + new Vector2(5, 9.5f)); }
                p.ClosePath(); p.Fill();
            }

            void Paint(MeshGenerationContext ctx)
            {
                var p = ctx.painter2D;
                var c = new Vector2(14, 14);
                if (Shape == 0)
                {
                    p.fillColor = new Color(Color.r, Color.g, Color.b, .85f);
                    p.BeginPath(); p.Arc(c, 12f, 0f, 360f); p.Fill();
                    p.strokeColor = new Color(1, 1, 1, .9f); p.lineWidth = 1f;
                    p.BeginPath(); p.Arc(c, 12f, 0f, 360f); p.Stroke();
                }
                else if (Shape == 1)
                {
                    p.fillColor = new Color(Color.r, Color.g, Color.b, .85f);
                    p.BeginPath(); p.MoveTo(c + new Vector2(0, -13)); p.LineTo(c + new Vector2(13, 0)); p.LineTo(c + new Vector2(0, 13)); p.LineTo(c + new Vector2(-13, 0)); p.ClosePath(); p.Fill();
                    p.strokeColor = new Color(0, 0, 0, .6f); p.lineWidth = 1f;
                    p.BeginPath(); p.MoveTo(c + new Vector2(0, -13)); p.LineTo(c + new Vector2(13, 0)); p.LineTo(c + new Vector2(0, 13)); p.LineTo(c + new Vector2(-13, 0)); p.ClosePath(); p.Stroke();
                }
                else
                {
                    p.fillColor = new Color(.03f, .05f, .06f, .55f);
                    p.BeginPath(); p.Arc(c, 11f, 0f, 360f); p.Fill();
                    p.strokeColor = Color; p.lineWidth = 2f;
                    p.BeginPath(); p.Arc(c, 11f, 0f, 360f); p.Stroke();
                }
                if (Progress >= 0)
                {
                    p.strokeColor = new Color(0, 0, 0, .45f); p.lineWidth = 3f;
                    p.BeginPath(); p.Arc(c, 13.5f, 0f, 360f); p.Stroke();
                    if (Progress > 0)
                    {
                        p.strokeColor = ProgressColor; p.lineWidth = 3f; p.lineCap = LineCap.Butt;
                        int steps = Mathf.Max(2, Mathf.CeilToInt(Progress * 36));
                        p.BeginPath();
                        for (int k = 0; k <= steps; k++)
                        {
                            float a = Mathf.Clamp01(Progress) * Mathf.PI * 2 * k / steps;
                            var pt = c + new Vector2(Mathf.Sin(a), -Mathf.Cos(a)) * 13.5f;
                            if (k == 0) p.MoveTo(pt); else p.LineTo(pt);
                        }
                        p.Stroke();
                    }
                }
                if (Contested)
                {
                    p.strokeColor = new Color(.95f, .3f, .24f, .5f + .5f * Pulse); p.lineWidth = 2f;
                    p.BeginPath(); p.Arc(c, 16f, 0f, 360f); p.Stroke();
                }
                PaintCaptureState(p);
                if (Pips > 0)
                {
                    for (int k = 0; k < 3; k++)
                    {
                        float x = 14 - 10 + k * 8, y = 31;
                        p.fillColor = k < Pips ? Color : new Color(1, 1, 1, .2f);
                        p.BeginPath(); p.MoveTo(new Vector2(x - 3, y - 3)); p.LineTo(new Vector2(x + 3, y - 3)); p.LineTo(new Vector2(x + 3, y + 3)); p.LineTo(new Vector2(x - 3, y + 3)); p.ClosePath(); p.Fill();
                    }
                }
            }
        }

        sealed class ObjectiveMarker
        {
            public VisualElement Root;
            public SiteBadge Badge;
            public IconElement Icon;
            public Label Name;
            public int SeenFrame = -1;
            public bool Shown;
            public Vector2 At = new Vector2(float.NaN, float.NaN);
        }

        const int MaxObjectiveMarkers = 120;

        public void DrawObjectives(Func<ObjectiveSite, Vector3> project, float zoom)
        {
            if (!session.ActionRts || MenuVisible || topbar == null || topbar.style.display == DisplayStyle.None)
            {
                if (objectiveLayer != null) objectiveLayer.style.display = DisplayStyle.None;
                return;
            }
            if (objectiveLayer == null)
            {
                objectiveLayer = UiKit.El("se-cmd-markers");
                objectiveLayer.pickingMode = PickingMode.Ignore;
                objectiveLayer.style.position = Position.Absolute;
                objectiveLayer.style.left = 0; objectiveLayer.style.top = 0; objectiveLayer.style.right = 0; objectiveLayer.style.bottom = 0;
                root.Insert(0, objectiveLayer);
            }
            objectiveLayer.style.display = DisplayStyle.Flex;
            int frame = Time.frameCount, shownCount = 0;
            float width = root.layout.width, height = root.layout.height;
            if (float.IsNaN(width) || width <= 0) { HideUnseenMarkers(frame); return; }
            float pulse = .5f + .5f * Mathf.Sin(Time.unscaledTime * 6f);
            foreach (var site in session.Objectives.Values)
            {
                if (shownCount >= MaxObjectiveMarkers) break;
                var sp = project(site);
                if (sp.z <= 0) continue;
                var p = ToPanel(sp);
                // cull in panel space against the floating top group (48) and the bottom band (92) — defect 29
                if (p.x < 14 || p.x > width - 14 || p.y < 48 || p.y > height - 92) continue;
                if (!objectiveMarkers.TryGetValue(site.Id, out var mark))
                {
                    var markerRoot = UiKit.El("se-cmd-marker");
                    markerRoot.pickingMode = PickingMode.Ignore;
                    markerRoot.style.position = Position.Absolute;
                    // markers follow the camera every frame: moved by translate (no layout pass)
                    markerRoot.style.left = 0; markerRoot.style.top = 0;
                    markerRoot.usageHints = UsageHints.DynamicTransform;
                    objectiveLayer.Add(markerRoot);
                    var badge = new SiteBadge();
                    markerRoot.Add(badge);
                    var icon = new IconElement("", "se-cmd-marker-icon");
                    icon.style.position = Position.Absolute; icon.style.left = 6; icon.style.top = 6; icon.style.width = 16; icon.style.height = 16;
                    markerRoot.Add(icon);
                    var name = UiKit.Text("", "se-cmd-marker-name", markerRoot);
                    name.pickingMode = PickingMode.Ignore;
                    name.style.position = Position.Absolute; name.style.left = 32; name.style.top = 6; name.style.maxWidth = 110;
                    name.style.overflow = Overflow.Hidden; name.style.textOverflow = TextOverflow.Ellipsis; name.style.whiteSpace = WhiteSpace.NoWrap;
                    name.style.display = DisplayStyle.None;
                    objectiveMarkers[site.Id] = mark = new ObjectiveMarker { Root = markerRoot, Badge = badge, Icon = icon, Name = name };
                }
                mark.SeenFrame = frame;
                shownCount++;
                bool own = site.Owner == session.CivId, enemy = site.Owner >= 0 && !own && session.IsHostile(site.Owner);
                bool hq = site.IsBase && site.Headquarters != 0;
                bool detailed = site.Contested || site.Capture > 0 || site.Id == commander.SelectedObjective ||
                    zoom < 14 && Mathf.Abs(p.x - width * .5f) < 230 && Mathf.Abs(p.y - height * .5f) < 160;
                var relation = UiKit.RelationColor(session, site.Owner);
                int shape;
                if (site.IsBase && site.Owner >= 0 && hq) { shape = enemy ? 1 : 0; mark.Icon.Kind = enemy ? "skirmish" : "hq"; }
                else { shape = 2; mark.Icon.Kind = site.IsBase ? "house" : OutpostGlyph(site.Kind); }
                var color = site.Owner < 0 ? UiKit.Token("neutral") : relation;
                mark.Icon.Tint = shape == 2 ? color : Color.white;
                int pips = hq && site.Operational && site.Tier > 0 && (own || enemy || site.Owner >= 0) ? Mathf.Clamp(site.Tier, 1, 3) : 0;
                float progress = site.Capture > 0 ? site.Capture / 100f : hq && !site.Operational ? site.Build / 100f : -1f;
                var progressColor = site.Capturing >= 0 ? UiKit.RelationColor(session, site.Capturing) : relation;
                int captureState = site.Memory ? 0 : CaptureState(site);
                if (captureState == 3) progressColor = UiKit.Token("bad");   // draining: the arc turns red and shrinks
                mark.Badge.Set(shape, color, progress, progressColor, pips, site.Contested, pulse, captureState);
                if (!mark.Shown) { mark.Shown = true; mark.Root.style.display = DisplayStyle.Flex; }
                var at = new Vector2(p.x - 14, p.y - 24);
                if (!((at - mark.At).sqrMagnitude <= .0025f)) { mark.At = at; mark.Root.style.translate = new Translate(at.x, at.y); }
                mark.Root.style.opacity = site.Memory ? .6f : 1f;
                var nameDisplay = detailed ? DisplayStyle.Flex : DisplayStyle.None;
                if (mark.Name.style.display != nameDisplay) mark.Name.style.display = nameDisplay;
                if (detailed)
                {
                    string label = captureState == 2 ? "Contested · paused" : captureState == 3 ? "Draining" : site.Name;
                    if (mark.Name.text != label) mark.Name.text = label;
                }
            }
            HideUnseenMarkers(frame);
        }

        /// <summary>Hides the markers not drawn this frame (display is touched only when it changes).</summary>
        void HideUnseenMarkers(int frame)
        {
            foreach (var marker in objectiveMarkers.Values)
                if (marker.Shown && marker.SeenFrame != frame) { marker.Shown = false; marker.Root.style.display = DisplayStyle.None; }
            // memory pass 8: markers of sites that no longer exist (destroyed, or an earlier match's) are removed, not
            // kept hidden for the rest of the session
            if (objectiveMarkers.Count > session.Objectives.Count && frame >= markerPruneFrame)
            {
                markerPruneFrame = frame + 120;
                markerGone.Clear();
                foreach (var pair in objectiveMarkers) if (!session.Objectives.ContainsKey(pair.Key)) markerGone.Add(pair.Key);
                foreach (int id in markerGone) { objectiveMarkers[id].Root.RemoveFromHierarchy(); objectiveMarkers.Remove(id); }
            }
        }
        readonly List<int> markerGone = new List<int>();
        int markerPruneFrame;

        // ------------------------------------------------------------------ tutorial and result
        void ActionTutorial(float time)
        {
            if (tutorialStep < 0) { pointer.style.display = DisplayStyle.None; return; }
            if (stepAt == 0) { stepAt = time; startFocus = CameraFocus?.Invoke() ?? Vector3.zero; }
            int id = ProtocolDecoder.Int(Econ?["tutorialSite"]);
            session.Objectives.TryGetValue(id, out var site);
            int tile = -1;
            bool done = false;
            bool check = time >= tutorialCheckAt;
            if (check) tutorialCheckAt = time + .25f;
            string text;
            switch (tutorialStep)
            {
                case 0: text = "Pan with " + Input.InputFacade.PanKeysText() + " or the screen edges, and zoom with the wheel."; done = Vector3.Distance(startFocus, CameraFocus?.Invoke() ?? Vector3.zero) > 2.1f; break;
                case 1: text = "Select your rifle squads. Drag a box to select the entire force."; done = units.Selected.Count > 0; break;
                case 2: text = "Right-click terrain toward the marked ruins."; tile = site.Tile; done = commander.ActionMoveOrders > 0; break;
                case 3: text = AttackStepText(); tile = site.Tile; done = site.Capture > 0 || site.Owner == session.CivId; break;
                case 4: text = "Hold infantry inside the command zone until capture completes."; tile = site.Tile; done = site.Owner == session.CivId; break;
                case 5: text = "Click the secured ruin and choose Establish base on its wheel."; tile = site.Tile; done = site.Headquarters > 0; break;
                case 6: text = "Click your headquarters, pick an empty socket and build a Barracks and a Materials Processor."; tile = site.Tile; done = check && HasBuildingAt(site.Id, "barracks") && HasBuildingAt(site.Id, "depot"); break;
                case 7: text = "Click the Barracks and train reinforcements from its wheel."; done = check && session.Structures.Buildings.Values.Any(b => b.QueueLength > 0 && b.Owner == session.CivId); break;
                case 8: text = "Right-drag to deploy a defensive battle line near the city."; tile = site.Tile; done = commander.ActionFormations > 0; break;
                case 9: text = "Queue an Anti-Armor Squad to counter vehicles. Use terrain and hold position."; done = check && (session.Structures.Buildings.Values.Any(b => b.Queue?.Contains("anti_armor") == true) || session.Units.Records.Any(u => u.InUse && u.Owner == session.CivId && session.Units.Types.Name(u.TypeIndex) == "anti_armor")); break;
                case 10: text = "Hold the new base, then push toward an enemy headquarters."; tile = site.Tile; done = time - stepAt > 8f; break;
                case 11: text = "Destroy the enemy headquarters. Capture the ruin with infantry and rebuild it."; done = check && session.Objectives.Values.Any(s => s.Starting && s.Id != 1 && s.Owner == session.CivId); break;
                default: tutorialStep = -1; UiKit.Hide(coach); pointer.style.display = DisplayStyle.None; return;
            }
            if (coachShownStep != tutorialStep || !ReferenceEquals(coachShownText, text))
            {
                coachShownStep = tutorialStep; coachShownText = text;
                coachText.text = $"{tutorialStep + 1}/12 · {text}";
            }
            if (done) { tutorialStep++; stepAt = 0; }
            if (id > 0 && tile >= 0 && TileScreen?.Invoke(tile) is Vector3 sp && sp.z > 0)
            {
                var p = ToPanel(sp);
                MovePointer(p.x - 9, p.y - 59 - 6 * Mathf.Abs(Mathf.Sin(time * 4)));
                pointer.style.display = DisplayStyle.Flex;
            }
            else pointer.style.display = DisplayStyle.None;
        }

        // step 3 names the bound attack-move key (F by default; T is the terrain wheel since 2026-11-16), cached per key
        string attackStepText;
        KeyCode attackStepKey = KeyCode.None;
        string AttackStepText()
        {
            var k = Input.InputFacade.KeyFor("attack");
            if (attackStepText == null || k != attackStepKey)
            {
                attackStepKey = k;
                attackStepText = $"Press {SettingsView.KeyName(k)} for attack-move, click past the ruins and clear the defenders.";
            }
            return attackStepText;
        }

        // the coach text is set once per step; the scans over every building and unit run at 4 Hz
        int coachShownStep = -1;
        string coachShownText;
        float tutorialCheckAt;

        bool HasBuildingAt(int city, string type)
        {
            foreach (var b in session.Structures.Buildings.Values) if (b.City == city && b.Type == type) return true;
            return false;
        }

        /// <summary>The tutorial pointer bobs every frame: moved by translate (its left/top stay 0, no layout pass).</summary>
        void MovePointer(float x, float y) => pointer.style.translate = new Translate(x, y);

        public void MatchEnded(JObject winner)
        {
            int id = ProtocolDecoder.Int(winner?["civ"], -1);
            string result = id < 0 ? "Draw" : session.Spectator ? "Match complete" : session.IsHostile(id) ? "Defeat" : "Victory";
            string how = ProtocolDecoder.Str(winner?["how"], "Military Domination");
            ResultCard(result, $"{ProtocolDecoder.Str(winner?["name"], "")} · {how}" + HowExplained(how), -1);
            // the countdown ends with the match
            shownDomTeam = int.MinValue;
            if (dominanceBanner != null) UiKit.Hide(dominanceBanner);
            root.EnableInClassList("se-hud--dominance", false);
        }

        /// <summary>One line on what the victory condition means (game over <c>how</c>; actionGame.js checkVictory).</summary>
        string HowExplained(string how)
        {
            switch (how)
            {
                case "Decisive Domination":
                    var rule = Defs?["RULESET"]?["dominance"];
                    return $"\nHeld {Mathf.RoundToInt(ProtocolDecoder.Float(rule?["hqShare"], .65f) * 100f)}% of the headquarters with {ProtocolDecoder.Float(rule?["armyRatio"], 2.5f):0.#}× the rival army for {ProtocolDecoder.Int(rule?["hold"], 90)} s.";
                case "Military Domination": return "\nEvery rival headquarters fell.";
                case "Territorial Control": return "\nHeld most of the bases long enough.";
                default: return "";
            }
        }
    }
}
