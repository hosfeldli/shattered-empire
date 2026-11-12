using System;
using System.Collections.Generic;
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
        static readonly (string topic, string text)[] ActionGuide =
        {
            ("Scout and capture", "Move infantry or engineers into a ruin’s command zone. Hostile ground troops contest it. Progress decays if the zone is abandoned. Use the site card to establish a headquarters."),
            ("Build a base", "Select a headquarters, then one of its four ring sites. Upgrading that city unlocks two sites, reaching eight at Tier III. Technology unlocked by any headquarters is available faction-wide."),
            ("Materials and Energy", "Ground troops collect material drops on contact without a return trip. Capture abandoned energy plants for extra Energy. Materials Processors and Energy Generators provide passive income."),
            ("Command an army", "Box-select or double-click similar units. Right-click to move, capture, or attack. Shift queues movement and Ctrl attack-moves. Ctrl+1–9 saves a selection and 1–9 recalls it."),
            ("Draw a battle line", "Right-drag to deploy ground units along the terrain. Infantry take the front. Vehicles and artillery deploy behind them. Flip facing, advance with Alt, or queue with Shift."),
            ("Combined arms", "Infantry capture objectives and benefit from cover. Anti-armor teams counter vehicles. Artillery threatens clustered defenses. Aircraft need room to operate around air defense."),
            ("Reinforcements", "Select production facilities together to share a training order. Right-click a rally point. Units in the queue reserve command capacity until they deploy or you cancel."),
            ("Field construction", "Build defenses on visible, legal terrain anywhere. Engineers are optional: they automatically assist construction and repair nearby vehicles, buildings and defenses when out of combat. Their pistols are for self-defense."),
            ("Roads", "Cities connect automatically through inherited roads. Use Build Road to add visible routes between settlements and forward positions. Roads cost Materials and never consume ring sites."),
            ("Military Domination", "Destroy opposing headquarters and prevent recovery. A faction with a recovery window can reclaim a ruin and reestablish command."),
            ("Camera and shortcuts", "WASD pans, middle-drag moves the camera, and the wheel zooms toward the cursor. Use Objectives to jump to sites. Shortcuts are remappable in Settings."),
        };
        static readonly string[] TierLabels = { "I", "II", "III" };
        static readonly string[] Facilities = { "depot", "power_plant", "barracks", "armory", "motor_works", "heavy_weapons", "airfield", "advanced_lab", "missile_silo" };
        static readonly string[] Defenses = { "barricade", "guard_post", "bunker", "turret", "aa_battery", "sensor_post", "repair_point", "artillery_post", "fort" };

        VisualElement objectiveLayer, actionTierBox;
        Label materialsCount, energyCount, commandCount, actionTier, holdState;
        bool layoutIsAction, layoutInitialized, missileArmed;
        int armedMissile;
        readonly Dictionary<int, ObjectiveMarker> objectiveMarkers = new Dictionary<int, ObjectiveMarker>();

        sealed class ObjectiveMarker
        {
            public VisualElement Root, Track, Fill;
            public Label Name;
            public IconElement Icon;
        }

        void ApplyRulesetLayout()
        {
            if (layoutInitialized && layoutIsAction == session.ActionRts) return;
            layoutInitialized = true;
            layoutIsAction = session.ActionRts;
            resRow.Clear(); resEls.Clear();
            eraLabel?.parent?.RemoveFromHierarchy(); eraLabel = eraNext = null;
            actionTierBox?.RemoveFromHierarchy(); actionTierBox = null;
            powerLabel = peopleLabel = null; powerFill = null;
            openPanel = panelTab = cardSignature = panelSignature = "";
            foreach (var (key, oldLabel, newLabel) in new[]
            {
                ("build", "Build", "Base"), ("army", "Army", "Army"), ("research", "Research", "Upgrades"), ("overview", "Overview", "Objectives")
            })
            {
                var label = rail.Q<Button>("rail-" + key)?.Q<Label>();
                if (label != null) label.text = layoutIsAction ? newLabel : oldLabel;
            }
            rail.EnableInClassList("action-rail", layoutIsAction);
            card.EnableInClassList("action-card", layoutIsAction);
            focusPill.style.display = DisplayStyle.None;
            tooltip.style.display = DisplayStyle.None;
        }

        void ActionTopBar()
        {
            if (actionTierBox == null)
            {
                actionTierBox = El("era-pill");
                actionTier = L("", "era-name", actionTierBox);
                holdState = L("", "era-next", actionTierBox);
                topbar.Insert(0, actionTierBox);
                materialsCount = ActionResource("Materials", new Color(.81f, .64f, .42f), "Materials Processors, relays and field drops fund construction and armies.");
                energyCount = ActionResource("Energy", new Color(.48f, .77f, .88f), "Energy Generators and captured abandoned energy plants fund advanced systems.");
                commandCount = ActionResource("Command", new Color(.59f, .77f, .57f), "Faction-wide capacity follows your highest technology tier: 80 / 120 / 160, plus purchased upgrades. Training reserves capacity.");
            }
            var res = Econ?["res"]; var rates = Econ?["rates"]; var capacity = Econ?["capacity"];
            int used = ProtocolDecoder.Int(capacity?["used"]), queued = ProtocolDecoder.Int(capacity?["queued"]), cap = ProtocolDecoder.Int(capacity?["limit"]);
            materialsCount.text = $"{ProtocolDecoder.Int(res?["materials"]):N0}";
            energyCount.text = $"{ProtocolDecoder.Int(res?["energy"]):N0}";
            materialsCount.parent.tooltip = $"Materials · +{ProtocolDecoder.Float(rates?["materials"]) * 60:0}/min. Processors, relays and field salvage fund your army.";
            energyCount.parent.tooltip = $"Energy · +{ProtocolDecoder.Float(rates?["energy"]) * 60:0}/min. Generators and captured energy plants fund advanced systems.";
            commandCount.text = $"{used}/{cap}";
            commandCount.parent.tooltip = $"Command Capacity · {queued} reserved in production. Capacity follows faction technology, not headquarters count.";
            commandCount.EnableInClassList("warn", cap > 0 && used + queued >= cap);
            int tier = Mathf.Clamp(Age, 0, 2);
            actionTier.text = $"TIER {TierLabels[tier]}";
            actionTier.tooltip = ProtocolDecoder.Str(Defs?["AGES"]?[tier]?["name"], "Reclamation");
            int recovery = ProtocolDecoder.Int(Econ?["recovery"]), held = ProtocolDecoder.Int(Econ?["hold"]);
            holdState.text = recovery > 0 ? $"Restore command in {recovery}s" : held > 0 ? $"Objective held for {held}s" : "";
            var invite = topbar.Q<Button>("invite");
            if (invite != null) invite.style.display = game.CanInvite && session.Welcome.Civs.Count(c => c.Human) > 1 ? DisplayStyle.Flex : DisplayStyle.None;
            UpdateActionRail();
        }

        Label ActionResource(string name, Color color, string help)
        {
            var box = El("res action-resource", resRow); box.tooltip = help;
            El("dot", box).style.backgroundColor = color;
            L(name, "muted small", box);
            return L("", "amount", box);
        }

        void TrackConstructionCost(Button button, JToken cost, bool permitted)
        {
            string help = button.tooltip ?? "";
            void Update()
            {
                button.SetEnabled(permitted && Affordable(cost));
                if (!(cost is JObject values)) return;
                var missing = values.Properties().Select(p => (p.Name, amount: ProtocolDecoder.Int(p.Value) - ProtocolDecoder.Int(Econ?["res"]?[p.Name])))
                    .Where(p => p.amount > 0).Select(p => $"{p.amount} {(p.Name == "materials" ? "Materials" : "Energy")}");
                string shortfall = string.Join(" and ", missing);
                button.tooltip = help + (shortfall.Length == 0 ? "" : $" Need {shortfall}. Collect Materials or develop generators and captured energy plants.");
            }
            Update(); button.schedule.Execute(Update).Every(200);
        }

        JToken SiteDefinition(ObjectiveSite site)
        {
            if (!site.IsBase) return Defs?["OUTPOST_TYPES"]?[site.Kind];
            return (Defs?["RUIN_TYPES"] as JArray)?.FirstOrDefault(r => ProtocolDecoder.Str(r["key"]) == site.Kind);
        }

        string SiteStatus(ObjectiveSite s)
        {
            if (s.Contested) return "Contested";
            if (s.Capture > 0) return $"Capturing · {s.Capture:0}%";
            if (s.Operational) return $"Tier {TierLabels[Mathf.Clamp(s.Tier - 1, 0, 2)]} headquarters";
            if (s.Headquarters != 0) return $"Rebuilding · {s.Build:0}%";
            if (s.Owner == session.CivId) return s.IsBase ? "Secured · Establish Base available" : "Controlled";
            return s.Owner < 0 ? "Unclaimed" : "Controlled by " + FactionName(s.Owner);
        }

        string FactionName(int id)
        {
            foreach (var civ in session.Welcome.Civs) if (civ.Id == id) return civ.Name;
            return "a rival";
        }

        void ActionCard(bool force)
        {
            UpdateActionContextState();
            session.Objectives.TryGetValue(commander.SelectedObjective, out var site);
            string sig = $"{site.Id}|{site.Owner}|{site.Headquarters}|{site.Operational}|{site.Tier}|{site.Slots?.Length}|{site.Contested}|{site.Capture > 0}|{site.Capturing}|{units.Selected.Count > 0 && AvgHp() < 99}|" +
                $"{commander.Current}|{commander.Option}|{showUnitDetails}|{showAirMissions}|{commander.SelectedRingSlot}|{commander.SelectedPickup}|{Age}|{string.Join(",", commander.SelectedBuildings)}|{string.Join(",", units.Selected)}|{quantity}|{session.Structures.Revision}|{session.Units.MembershipRevision}|{missileArmed}";
            if (!force && sig == cardSignature) { UpdateCardLive(); return; }
            cardSignature = sig;
            card.Clear();
            live.Clear();
            card.EnableInClassList("expanded-details", showUnitDetails && units.Selected.Count > 0);
            card.EnableInClassList("active-tool-card", commander.Current != Commander.Mode.Select);
            if (commander.Current != Commander.Mode.Select) ActionToolCard();
            else if (commander.SelectedPickup != 0) ActionPickupCard();
            else if (site.Id > 0) ActionSiteCard(card, site, false);
            else if (commander.SelectedBuildings.Count > 0) ActionBuildingCard();
            else if (units.Selected.Count > 0) ActionUnitCard();
            card.style.display = card.childCount > 0 ? DisplayStyle.Flex : DisplayStyle.None;
        }

        void ActionSiteCard(VisualElement into, ObjectiveSite site, bool expanded)
        {
            if (!expanded) { ActionCompactSite(into, site); return; }
            var def = SiteDefinition(site);
            var head = El("row", into);
            head.Add(new IconElement(site.IsBase ? "house" : "energy"));
            L(site.Name, "heading grow", head);
            L(ProtocolDecoder.Str(def?["name"], site.IsBase ? "City Ruins" : "Resource Objective"), "muted", head);
            var state = L(SiteStatus(site), site.Contested ? "bad" : "small", into);
            if (!expanded) live.Add((state, () => session.Objectives.TryGetValue(site.Id, out var latest) ? SiteStatus(latest) : ""));
            string bonus = ProtocolDecoder.Str(def?[site.IsBase ? "bonus" : "benefit"], "");
            if (bonus.Length > 0) L(bonus, "muted small", into);
            if (!site.Operational && site.Headquarters == 0)
                ActionMeter(into, () => session.Objectives.TryGetValue(site.Id, out var s) ? s.Capture : 0,
                    () => session.Objectives.TryGetValue(site.Id, out var s) && s.Contested ? "CONTESTED · Clear hostile ground forces" : "CAPTURE · Infantry or engineers required");
            else if (site.Headquarters != 0 && !site.Operational)
                ActionMeter(into, () => session.Objectives.TryGetValue(site.Id, out var s) ? s.Build : 0, () => "RECONSTRUCTION");
            if (site.Owner != session.CivId || session.Spectator)
            {
                if (site.Headquarters == 0) L("Hold the command zone with infantry or engineers.", "small", into);
                return;
            }
            if (!site.IsBase) return;
            if (site.Headquarters == 0)
            {
                int recovery = ProtocolDecoder.Int(Econ?["recovery"]);
                string cost = recovery > 0 ? "140 Materials during recovery" : CostText(Defs?["BUILDINGS"]?["town"]?["cost"]);
                B($"Establish Base · {cost}", () => Cmd(new JObject { ["c"] = "establish", ["site"] = site.Id }, "Headquarters reconstruction started"),
                    into, "build", "primary").SetEnabled(!site.Contested);
                return;
            }
            if (!site.Operational) return;
            var row = El("row wrap", into);
            var hq = session.Structures.Buildings.TryGetValue(site.Headquarters, out var building) ? building : default;
            if (site.Tier < 3)
            {
                var next = Defs?["AGES"]?[site.Tier];
                var advance = B(hq.Project == "tier" ? $"Advancing · {hq.WorksPct}%" : $"Advance to Tier {TierLabels[site.Tier]} · {CostText(next?["cost"])}",
                    () => Cmd(new JObject { ["c"] = "advance", ["site"] = site.Id }, "Headquarters upgrade started"), row, "research", "primary");
                advance.SetEnabled(hq.Project == null && Affordable(next?["cost"]));
                if (Defs?["UNITS"] is JObject roster)
                {
                    string unlocks = string.Join(", ", roster.Properties().Where(p => ProtocolDecoder.Int(p.Value["tier"], 1) == site.Tier + 1)
                        .Take(3).Select(p => NameOf("UNITS", p.Name)));
                    if (unlocks.Length > 0) advance.tooltip = "New capabilities: " + unlocks;
                }
                TrackConstructionCost(advance, next?["cost"], hq.Project == null);
            }
            if (hq.RepairCost > 0 && hq.Project == null)
                B($"Repair · {hq.RepairCost} materials", () => Cmd(new JObject { ["c"] = "repair", ["id"] = hq.Id }, "Repairs started"), row);
            L($"LOCAL CITY TIER {TierLabels[Mathf.Clamp(site.Tier - 1, 0, 2)]} · {site.Capacity} active sites · FACTION TECHNOLOGY {TierLabels[Mathf.Clamp(Age, 0, 2)]}", "small muted", into);
            var builders = session.Structures.Buildings.Values.Where(b => b.City == site.Id && b.Id != site.Headquarters && b.Owner == session.CivId).ToArray();
            foreach (var group in builders.Where(b => Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).GroupBy(b => b.Type))
            {
                int[] ids = group.Select(b => b.Id).ToArray();
                B(NameOf("BUILDINGS", group.Key), () => commander.SelectProduction(ids), row, Icons.BuildingKind(group.Key));
            }
            var sites = El("ring-site-grid", into);
            foreach (var parcel in (site.Parcels ?? Array.Empty<BaseParcel>()).Where(p => p.Id > 0).OrderBy(p => p.Id))
            {
                int id = parcel.Id;
                var occupant = builders.FirstOrDefault(b => b.Slot == id);
                bool locked = parcel.Tier > site.Tier;
                string text = locked ? $"Tier {TierLabels[Mathf.Clamp(parcel.Tier - 1, 0, 2)]} · Locked" : occupant.Id != 0 ? NameOf("BUILDINGS", occupant.Type) : "Empty site";
                var chip = B(text, () => { commander.SelectRingSlot(site.Id, id); panelSignature = cardSignature = ""; Refresh(true); }, sites,
                    locked ? "research" : occupant.Id != 0 ? Icons.BuildingKind(occupant.Type) : "build", "ring-site");
                chip.EnableInClassList("selected", commander.SelectedRingSlot == id);
                chip.EnableInClassList("locked", locked);
                chip.tooltip = locked ? $"Upgrade this headquarters to Tier {TierLabels[parcel.Tier - 1]} to recover this site." : occupant.Id != 0 ? occupant.Done ? "Open facility controls" : $"Construction {occupant.Progress}%" : "Choose a facility for this site";
            }
            int selectedSlot = commander.SelectedRingSlot;
            bool emptySiteSelected = site.Slots != null && site.Slots.Contains(selectedSlot);
            if (!emptySiteSelected)
            {
                L(selectedSlot != 0 ? "Upgrade this headquarters to unlock the selected site." : "Select an empty site to build. All eight parcels retain their positions through upgrades.", "small muted", into);
                return;
            }
            L("Build in selected site", "heading section", into);
            var choices = new ScrollView(ScrollViewMode.Vertical); choices.style.maxHeight = expanded ? 290 : 170; into.Add(choices);
            var grid = El("row wrap", choices);
            foreach (var type in Facilities)
            {
                var entry = Defs?["BUILDINGS"]?[type];
                if (entry == null) continue;
                int tier = ProtocolDecoder.Int(entry["tier"], 1);
                string prerequisite = ProtocolDecoder.Str(entry["needs"]);
                bool allowed = tier <= Age + 1 && (string.IsNullOrEmpty(prerequisite) || builders.Any(b => b.Type == prerequisite && b.Done));
                var b = B($"{NameOf("BUILDINGS", type)} · {CostText(entry["cost"])}",
                    () => commander.BuildRingFacility(site.Id, selectedSlot, type), grid, Icons.BuildingKind(type), "facility-choice");
                b.RegisterCallback<PointerEnterEvent>(_ => commander.PreviewRingFacility(site.Id, selectedSlot, type));
                b.RegisterCallback<PointerLeaveEvent>(_ => commander.ClearRingPreview());
                b.SetEnabled(allowed && site.Slots?.Length > 0 && Affordable(entry["cost"]));
                b.tooltip = ProtocolDecoder.Str(entry["desc"], "") + $" Tier {TierLabels[Mathf.Clamp(tier - 1, 0, 2)]}, {ProtocolDecoder.Int(entry["time"])}s."
                    + (tier > Age + 1 ? $" Requires faction technology Tier {TierLabels[Mathf.Clamp(tier - 1, 0, 2)]}." : !allowed ? $" Requires {NameOf("BUILDINGS", prerequisite)}." : "");
                TrackConstructionCost(b, entry["cost"], allowed && site.Slots?.Length > 0);
            }
        }

        void ActionPickupCard()
        {
            if (!session.Pickups.TryGetValue(commander.SelectedPickup, out var pickup))
            { L("Materials collected", "heading", card); return; }
            L("Materials cache", "heading", card);
            L($"+{pickup.Amount} Materials", "good", card);
            L(pickup.Memory ? "Last observed here. Scout to confirm availability." : "Move any mobile ground unit over this cache to collect it instantly. Right-click with troops selected to collect.", "small muted", card);
        }

        void ActionBuildingCard()
        {
            var selected = commander.SelectedBuildings.Where(session.Structures.Buildings.ContainsKey).Select(id => session.Structures.Buildings[id]).ToArray();
            if (selected.Length == 0) return;
            var first = selected[0];
            L(selected.Length == 1 ? NameOf("BUILDINGS", first.Type) : $"{selected.Length} facilities selected", "heading", card);
            var details = L("", "muted", card);
            live.Add((details, () =>
            {
                if (!session.Structures.Buildings.TryGetValue(first.Id, out var b)) return "";
                return !b.Done ? $"Construction · {b.Progress}%" : b.Project != null ? $"{b.Project} · {b.WorksPct}%" : $"Operational · {b.Hp}% condition";
            }));
            if (session.Spectator || first.Owner != session.CivId) return;
            var row = El("row wrap", card);
            if (first.Done && first.RepairCost > 0 && first.Project == null)
                B($"Repair · {first.RepairCost} materials", () => Cmd(new JObject { ["c"] = "repair", ["id"] = first.Id }, "Repairs started"), row);
            if (first.Type == "armory") B("Open upgrades", () => Toggle("research"), row, "research");
            if (first.Type == "missile_silo" && first.Done)
            {
                if (first.Missiles > 0)
                {
                    bool armed = missileArmed && armedMissile == first.Id;
                    B(armed ? "Confirm target selection" : "Prepare strategic launch", () =>
                    {
                        if (!armed) { missileArmed = true; armedMissile = first.Id; cardSignature = ""; return; }
                        missileArmed = false;
                        commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "missileLaunch", ["id"] = first.Id, ["tile"] = "@map" });
                        cardSignature = "";
                    }, row, "military", "primary");
                    if (armed) B("Cancel", () => { missileArmed = false; cardSignature = ""; }, row);
                }
                else if (first.Project == null)
                    B($"Build missile · {CostText(Defs?["MISSILE"]?["cost"])}", () => Cmd(new JObject { ["c"] = "missileBuild", ["id"] = first.Id }, "Missile assembly started"), row);
            }
            var trainers = selected.Where(b => b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).ToArray();
            if (trainers.Length > 0) ActionTrain(card, trainers);
        }

        void ActionMeter(VisualElement into, Func<float> value, Func<string> title)
        {
            var group = El("action-meter", into);
            var text = L("", "small muted", group);
            var track = El("action-meter-track", group); var fill = El("action-meter-fill", track);
            string Update()
            {
                float progress = Mathf.Clamp(value(), 0, 100);
                fill.style.width = Length.Percent(progress);
                return title() + $" · {progress:0}%";
            }
            text.text = Update(); live.Add((text, Update));
        }

        static string RoleCaption(string type) => type switch
        {
            "engineer" => "ENGINEER · CAPTURE / REPAIR",
            "rifle_squad" or "militia" or "special_forces" or "exo_infantry" => "INFANTRY · CAPTURE / COVER",
            "anti_armor" => "ANTI-ARMOR · AMBUSH",
            "tank" or "autonomous_tank" => "ARMOR · FRONTLINE",
            "mortar_team" or "sp_artillery" or "field_gun" or "missile_battery" => "FIRE SUPPORT · SIEGE",
            "air_defense" or "fighter" => "AIR DEFENSE · INTERCEPT",
            "scout_buggy" or "recon_drone" => "RECON · SCOUT",
            "bomber" or "helicopter" or "oneway_drone" or "strike_swarm" => "AIR STRIKE · GROUND ATTACK",
            _ => "MOBILE SUPPORT"
        };

        void ActionTrain(VisualElement into, BuildingRecord[] trainers)
        {
            var controls = El("row wrap", into);
            B("Rally point", () => commander.Begin(Commander.Mode.Rally), controls);
            B($"Batch ×{quantity}", () => { quantity = quantity == 1 ? 5 : quantity == 5 ? 10 : 1; Refresh(true); }, controls).tooltip = "Cycle batch size. Shift-click a unit to queue five batches.";
            var ids = trainers.Select(b => b.Id).ToArray();
            if (Econ?["groups"] is JArray availableGroups && availableGroups.Count > 0)
                B("Reinforce group", () => { reinforcementPicker = !reinforcementPicker; Refresh(true); }, controls);
            if (reinforcementPicker && Econ?["groups"] is JArray groups)
                foreach (var group in groups)
                {
                    int id = ProtocolDecoder.Int(group["id"]);
                    if (!(group["units"] is JArray members) || members.Count == 0) continue;
                    B($"Reinforce group {id}", () => Cmd(new JObject { ["c"] = "rallyGroup", ["buildings"] = new JArray(ids), ["group"] = id }, $"Reinforcing group {id}"), controls);
                }
            var choices = new ScrollView(ScrollViewMode.Vertical); choices.style.maxHeight = 210; into.Add(choices);
            var grid = El("train-grid", choices);
            var available = trainers.SelectMany(b => (JArray)Defs["BUILDINGS"][b.Type]["trains"]).Select(t => (string)t).Distinct();
            foreach (string type in available)
            {
                var d = Defs["UNITS"][type];
                int tier = ProtocolDecoder.Int(d["tier"], 1);
                bool unlocked = Age + 1 >= tier && trainers.Any(b => b.Type == ProtocolDecoder.Str(d["facility"]));
                if (!unlocked) continue;
                var button = B(NameOf("UNITS", type), () =>
                {
                    session.Net?.Command(new JObject { ["c"] = "batchTrain", ["buildings"] = new JArray(ids), ["unit"] = type, ["count"] = quantity * (InputFacade.Shift ? 5 : 1) }, r =>
                    {
                        int n = ProtocolDecoder.Int(r.Raw?["training"]?["queued"]);
                        string why = ProtocolDecoder.Str(r.Raw?["training"]?["reason"], "");
                        commander.Say(r.Error ?? $"{n} queued" + (why.Length > 0 ? $" · {why}" : ""), r.Error == null, Time.unscaledTime);
                        cardSignature = panelSignature = "";
                    });
                }, grid, type, "action-train");
                button.tooltip = $"{UnitRole(type)} {CostText(d["cost"])} · {ProtocolDecoder.Int(d["time"])}s · {ProtocolDecoder.Int(d["capacity"])} command.";
                button.RegisterCallback<PointerDownEvent>(e =>
                {
                    if (e.button != 1) return;
                    foreach (var trainer in trainers.Where(b => b.Type == ProtocolDecoder.Str(d["facility"])))
                        session.Net?.Command(new JObject { ["c"] = "repeat", ["id"] = trainer.Id, ["unit"] = trainer.Repeat == type ? null : type },
                            r => { commander.Say(r.Error ?? "Repeat production updated", r.Error == null, Time.unscaledTime); cardSignature = ""; });
                    e.StopPropagation();
                });
                button.tooltip += " Right-click to toggle repeat production.";
            }
            foreach (var building in trainers.Where(b => b.QueueLength > 0 || !string.IsNullOrEmpty(b.Repeat)).Take(3))
            {
                var line = El("production-line", into);
                L(NameOf("BUILDINGS", building.Type) + (!string.IsNullOrEmpty(building.Repeat) ? " · REPEAT" : ""), "small", line);
                var q = El("row wrap", line);
                var queue = L("", "small muted", q);
                string QueueText()
                {
                    if (!session.Structures.Buildings.TryGetValue(building.Id, out var b) || b.QueueLength == 0) return "";
                    return string.Join(" · ", b.Queue.Take(5).Select(u => NameOf("UNITS", u))) + $" · {b.TrainProgress}%";
                }
                queue.text = QueueText();
                live.Add((queue, QueueText));
                if (building.QueueLength > 0)
                {
                    ActionMeter(line, () => session.Structures.Buildings.TryGetValue(building.Id, out var b) ? b.TrainProgress : 0, () => "TRAINING");
                    B("Cancel next", () => Cmd(new JObject { ["c"] = "cancelTrain", ["id"] = building.Id, ["index"] = 0 }, "Queue entry cancelled"), q);
                }
            }
        }

        static string UnitRole(string type) => type switch
        {
            "engineer" => "Captures ruins. Automatically repairs vehicles, buildings and defenses, and assists construction outside combat. Carries a defensive pistol.",
            "anti_armor" or "field_gun" => "Counters vehicles. Protect it from infantry and indirect fire.",
            "rifle_squad" or "militia" or "special_forces" or "exo_infantry" => "Captures ruins and holds covered ground. Vulnerable in the open.",
            "tank" or "autonomous_tank" => "Armored frontline unit. Screen against anti-armor infantry and aircraft.",
            "mortar_team" or "sp_artillery" or "missile_battery" => "Indirect fire against fortifications and clustered forces.",
            "fighter" or "air_defense" => "Intercepts aircraft. Pair with ground forces.",
            "scout_buggy" or "recon_drone" => "Reconnaissance and detection. Keep clear of heavy fire.",
            "bomber" or "helicopter" or "oneway_drone" or "strike_swarm" => "Mobile ground strikes. Vulnerable to interceptors and air defenses.",
            "supply_truck" => "Mobile field repair.",
            _ => "Mobile ground support."
        };

        void ActionUnitDetails()
        {
            var groups = units.Selected.Where(id => session.Units.TryGet(id, out _)).Select(id =>
            {
                session.Units.TryGet(id, out var u);
                return (id, key: session.Units.Types.Name(u.TypeIndex), u.Veteran);
            }).GroupBy(u => u.key).ToArray();
            if (groups.Length == 0) return;
            L(groups.Length == 1 ? NameOf("UNITS", groups[0].Key) : $"{units.Selected.Count} units selected", "heading", card);
            var composition = El("row wrap", card);
            foreach (var g in groups)
            {
                var label = L($"{g.Count()} {NameOf("UNITS", g.Key)}", "force-chip", composition);
                label.tooltip = UnitRole(g.Key);
            }
            int capture = groups.Where(g => ProtocolDecoder.Bool(Defs?["UNITS"]?[g.Key]?["capture"])).Sum(g => g.Count());
            if (groups.Length == 1) L(UnitRole(groups[0].Key), "unit-role-description", card);
            else L(capture > 0 ? $"{capture} capture-capable units · Keep infantry with your armor." : "No capture-capable infantry selected.", "unit-role-description", card);
            ActionMeter(card, AvgHp, () => "FORCE CONDITION");
            var condition = L("", "small muted", card);
            live.Add((condition, () => $"Condition {AvgHp():0}%" + (groups.Length == 1 ? $" · Veterancy {groups[0].Max(u => u.Veteran)}" : "")));
            var movementState = L("", "small muted", card);
            live.Add((movementState, () =>
            {
                int queued = 0, blocked = 0;
                foreach (int id in units.Selected) if (session.Units.TryGet(id, out var u))
                { if ((u.Flags & 128) != 0) queued++; else if ((u.Flags & 16) != 0) blocked++; }
                return queued > 0 ? $"{queued} units queued at a narrow crossing" : blocked > 0 ? $"{blocked} units rerouting around obstacles" : "";
            }));
            if (session.Spectator) return;
            var row = El("row wrap", card);
            B("Attack-move", () => commander.Begin(Commander.Mode.Target, "", new JObject
                { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true }), row, "attack");
            B("Hold", () => commander.UnitCommand("hold", null, "Holding position"), row);
            B("Retreat", () => commander.UnitCommand("withdraw", null, "Retreat ordered"), row);
            B("Detach", () => commander.UnitCommand("detach", null, "Detached from reinforcement groups"), row);
            if (groups.Any(g => ProtocolDecoder.Bool(Defs?["UNITS"]?[g.Key]?["air"])))
            {
                B("Return to airfield", () => commander.UnitCommand("airMission", new JObject { ["mission"] = "return" }, "Aircraft returning"), row);
                foreach (var mission in new[] { "patrol", "scout", "intercept", "support" })
                    B(char.ToUpperInvariant(mission[0]) + mission.Substring(1), () => commander.Begin(Commander.Mode.Target, "",
                        new JObject { ["c"] = "airMission", ["mission"] = mission, ["units"] = "@units", ["tile"] = "@map" }), row);
            }
            B("Field construction", OpenFieldMenu, row, "defense");
            var abilities = El("row wrap abilities-row", card);
            foreach (var g in groups.GroupBy(g => ProtocolDecoder.Str(Defs?["UNITS"]?[g.Key]?["ability"])))
            {
                string ability = g.Key;
                var d = ability == null ? null : Defs?["ABILITIES"]?[ability];
                if (d == null) continue;
                var cmd = new JObject { ["c"] = "ability", ["ability"] = ability, ["units"] = "@units" };
                string name = ProtocolDecoder.Str(d["name"], ability);
                var b = B(name, () =>
                {
                    if (ProtocolDecoder.Bool(d["point"])) commander.Begin(Commander.Mode.Target, "", cmd);
                    else commander.UnitCommand("ability", new JObject { ["ability"] = ability }, name);
                }, abilities, null, "ability");
                b.tooltip = ProtocolDecoder.Str(d["desc"], "");
                var text = b.Q<Label>();
                var groupIds = g.SelectMany(x => x.Select(u => u.id)).ToArray();
                live.Add((text, () =>
                {
                    float cooldown = float.MaxValue;
                    foreach (int id in groupIds) if (session.Units.TryGet(id, out var u)) cooldown = Mathf.Min(cooldown, u.Motion.Cooldown);
                    b.SetEnabled(cooldown <= .1f);
                    return cooldown > .1f && cooldown < float.MaxValue ? $"{name} · {Mathf.CeilToInt(cooldown)}s" : name;
                }));
            }
        }

        void ActionPanel(bool force)
        {
            panel.style.display = openPanel == "" ? DisplayStyle.None : DisplayStyle.Flex;
            if (openPanel == "") return;
            string sig = $"{openPanel}|{panelTab}|{commander.SelectedObjective}|{commander.SelectedRingSlot}|{session.Structures.Revision}|{Age}|" +
                (openPanel == "settings" || openPanel == "guide" ? "" : session.Snapshots / 7);
            if (!force && (panelSignature == sig || InputFacade.Typing)) return;
            panelSignature = sig;
            panel.Clear();
            panel.EnableInClassList("wide", false);
            B("×", () => { openPanel = ""; Refresh(true); }, panel, null, "close");
            if (openPanel == "settings") { SettingsPanel(); return; }
            if (openPanel == "guide") { GuidePage(panel, false); return; }
            var scroll = new ScrollView(ScrollViewMode.Vertical); scroll.style.maxHeight = 620; panel.Add(scroll);
            if (openPanel == "build") ActionBuildPanel(scroll);
            else if (openPanel == "research") ActionUpgradePanel(scroll);
            else ActionOverview(scroll);
        }

        void ActionBuildPanel(VisualElement into)
        {
            if (panelTab == "Field") { ActionFieldMenu(into); return; }
            L("Base construction", "title", into);
            if (session.Objectives.TryGetValue(commander.SelectedObjective, out var selected) && selected.IsBase && selected.Owner == session.CivId)
                ActionSiteCard(into, selected, true);
            else
            {
                foreach (var site in session.Objectives.Values.Where(s => s.IsBase && s.Owner == session.CivId))
                {
                    var s = site;
                    B($"{s.Name} · {SiteStatus(s)}", () => { commander.SelectObjective(s.Id); game.FocusTile(s.Tile, 18f); }, into, "house");
                }
                if (!session.Objectives.Values.Any(s => s.IsBase && s.Owner == session.CivId)) L("Capture a city ruin to establish a base.", "muted", into);
            }
            if (session.Spectator) return;
            B("Field construction", OpenFieldMenu, into, "defense");
        }

        void ActionUpgradePanel(VisualElement into)
        {
            L("Armory upgrades", "title", into);
            if (!(Defs?["TECHS"] is JObject options)) return;
            var techs = Techs();
            var progress = Econ?["research"] as JArray;
            foreach (var option in options.Properties())
            {
                var d = option.Value;
                int tier = ProtocolDecoder.Int(d["tier"], 1);
                var item = El("list-item", into);
                L($"{NameOf("TECHS", option.Name)} · Tier {TierLabels[Mathf.Clamp(tier - 1, 0, 2)]}", "heading", item);
                L(ProtocolDecoder.Str(d["desc"], ""), "muted small", item);
                var active = progress?.FirstOrDefault(t => ProtocolDecoder.Str(t["key"]) == option.Name);
                if (techs.Contains(option.Name)) L("Complete", "good", item);
                else if (active != null) L($"Researching · {ProtocolDecoder.Int(active["progress"])}%", "warn", item);
                else B($"{CostText(d["cost"])} · {ProtocolDecoder.Int(d["time"])}s",
                    () => Cmd(new JObject { ["c"] = "research", ["tech"] = option.Name }, "Upgrade started"), item, "research")
                    .SetEnabled(!session.Spectator && Age + 1 >= tier && Affordable(d["cost"]));
            }
        }

        void ActionOverview(VisualElement into)
        {
            bool army = panelTab == "Armies";
            L(army ? "Army" : "Objectives", "title", into);
            var tabs = El("row wrap", into);
            B("Objectives", () => { panelTab = ""; Refresh(true); }, tabs).EnableInClassList("selected", !army);
            B("Army", () => { panelTab = "Armies"; Refresh(true); }, tabs).EnableInClassList("selected", army);
            if (army)
            {
                var formations = session.Units.Records.Take(session.Units.SlotCount).Where(u => u.InUse && u.Owner == session.CivId)
                    .GroupBy(u => session.Units.Types.Name(u.TypeIndex));
                foreach (var unit in formations.OrderByDescending(g => g.Count()))
                {
                    var u = unit.First();
                    B($"{unit.Count()} × {NameOf("UNITS", unit.Key)}", () => game.FocusTile(u.Tile, 19f), into, unit.Key);
                }
                return;
            }
            string rule = ProtocolDecoder.Str(Econ?["objective"], "domination");
            L(rule == "control" ? "Hold a majority of city sites for 105 seconds." : rule == "operation" ? "Secure the metropolitan objective for 80 seconds." : "Destroy rival headquarters and prevent their recovery.", "muted small", into);
            foreach (var s in session.Objectives.Values.OrderByDescending(s => s.Owner == session.CivId).ThenByDescending(s => s.IsBase))
            {
                var site = s;
                B($"{s.Name} · {SiteStatus(s)}", () => { commander.SelectObjective(site.Id); game.FocusTile(site.Tile, 23f); }, into, s.IsBase ? "house" : "energy");
            }
            if (session.Spectator)
            {
                L("Observer", "heading section", into);
                var row = El("row wrap", into);
                foreach (var civ in session.Welcome.Civs)
                    B(civ.Name, () => Cmd(new JObject { ["c"] = "follow", ["civ"] = civ.Id }, "Following " + civ.Name), row);
                B("Toggle fog", () => Cmd(new JObject { ["c"] = "fog", ["on"] = !session.ObserverFog }, "Visibility changed"), row);
                if (session.ActionPlan is JObject plan)
                {
                    L($"{ProtocolDecoder.Str(plan["state"], "")} · {ProtocolDecoder.Str(plan["phase"], "")}", "heading", into);
                    if (plan["notes"] is JArray notes) foreach (var note in notes.Take(4))
                        L(ProtocolDecoder.Str(note["text"], ""), "small muted", into);
                }
            }
        }

        public void DrawObjectives(Func<ObjectiveSite, Vector3> project, float zoom)
        {
            if (!session.ActionRts || MenuVisible || topbar.style.display == DisplayStyle.None)
            {
                if (objectiveLayer != null) objectiveLayer.style.display = DisplayStyle.None;
                return;
            }
            if (objectiveLayer == null)
            {
                objectiveLayer = El("objective-layer");
                objectiveLayer.pickingMode = PickingMode.Ignore;
                root.Insert(0, objectiveLayer);
            }
            objectiveLayer.style.display = DisplayStyle.Flex;
            foreach (var marker in objectiveMarkers.Values) marker.Root.style.display = DisplayStyle.None;
            foreach (var site in session.Objectives.Values)
            {
                var sp = project(site);
                if (sp.z <= 0 || sp.x < 6 || sp.y < 50 || sp.x > Screen.width - 6 || sp.y > Screen.height - 49) continue;
                if (!objectiveMarkers.TryGetValue(site.Id, out var mark))
                {
                    var marker = El("objective-marker glass", objectiveLayer);
                    marker.pickingMode = PickingMode.Ignore;
                    var row = El("row", marker); row.pickingMode = PickingMode.Ignore;
                    var icon = new IconElement(site.IsBase ? "house" : "energy") { pickingMode = PickingMode.Ignore };
                    row.Add(icon);
                    var name = L("", "objective-name", row); name.pickingMode = PickingMode.Ignore;
                    var track = El("objective-track", marker); track.pickingMode = PickingMode.Ignore;
                    var fill = El("objective-fill", track); fill.pickingMode = PickingMode.Ignore;
                    objectiveMarkers[site.Id] = mark = new ObjectiveMarker { Root = marker, Name = name, Icon = icon, Track = track, Fill = fill };
                }
                var p = ToPanel(sp);
                bool detailed = site.Contested || site.Capture > 0 || site.Id == commander.SelectedObjective ||
                    zoom < 14 && Mathf.Abs(sp.x - Screen.width * .5f) < 230 && Mathf.Abs(sp.y - Screen.height * .5f) < 160;
                mark.Root.style.display = DisplayStyle.Flex;
                mark.Root.style.left = p.x - (detailed ? 55 : 12);
                mark.Root.style.top = p.y - 27;
                mark.Root.style.width = detailed ? 110 : 24;
                mark.Root.style.opacity = site.Memory ? .60f : 1f;
                mark.Name.style.display = detailed ? DisplayStyle.Flex : DisplayStyle.None;
                mark.Name.text = site.Contested ? "Contested" : site.Name;
                var c = session.CivColor(site.Capturing >= 0 ? site.Capturing : site.Owner);
                var color = site.Contested ? new Color(.96f, .41f, .31f) :
                    site.Owner < 0 && site.Capturing < 0 ? new Color(.91f, .70f, .33f) : new Color(c.x, c.y, c.z).gamma;
                mark.Icon.Tint = color;
                mark.Root.style.borderTopColor = color;
                mark.Track.style.display = site.Capture > 0 || site.Headquarters > 0 && !site.Operational ? DisplayStyle.Flex : DisplayStyle.None;
                mark.Fill.style.backgroundColor = color;
                mark.Fill.style.width = new Length(site.Capture > 0 ? site.Capture : site.Build, LengthUnit.Percent);
            }
        }

        void ActionTutorial(float time)
        {
            if (tutorialStep < 0) { pointer.style.display = DisplayStyle.None; return; }
            if (stepAt == 0) { stepAt = time; startFocus = CameraFocus?.Invoke() ?? Vector3.zero; }
            int id = ProtocolDecoder.Int(Econ?["tutorialSite"]);
            session.Objectives.TryGetValue(id, out var site);
            int tile = -1;
            bool done = false;
            string text;
            switch (tutorialStep)
            {
                case 0: text = "Pan with WASD and zoom with the wheel."; done = Vector3.Distance(startFocus, CameraFocus?.Invoke() ?? Vector3.zero) > 2.1f; break;
                case 1: text = "Select your rifle squads. Drag a box to select the entire force."; done = units.Selected.Count > 0; break;
                case 2: text = "Right-click terrain toward the marked ruins."; tile = site.Tile; done = commander.ActionMoveOrders > 0; break;
                case 3: text = "Use attack-move to approach the ruins and clear the defenders."; tile = site.Tile; done = site.Capture > 0 || site.Owner == session.CivId; break;
                case 4: text = "Hold infantry inside the command zone until capture completes."; tile = site.Tile; done = site.Owner == session.CivId; break;
                case 5: text = "Select the secured ruin and choose Establish Base."; tile = site.Tile; done = site.Headquarters > 0; break;
                case 6: text = "Select empty ring sites and build a Barracks and Materials Processor."; tile = site.Tile; done = new[] { "barracks", "depot" }.All(t => session.Structures.Buildings.Values.Any(b => b.City == site.Id && b.Type == t)); break;
                case 7: text = "Select a Barracks and train reinforcements. Set a rally point with right-click."; done = session.Structures.Buildings.Values.Any(b => b.QueueLength > 0 && b.Owner == session.CivId); break;
                case 8: text = "Right-drag to deploy a defensive battle line near the city."; tile = site.Tile; done = commander.ActionFormations > 0; break;
                case 9: text = "Queue an Anti-Armor Squad to counter vehicles. Use terrain and hold position."; done = session.Structures.Buildings.Values.Any(b => b.Queue?.Contains("anti_armor") == true) || session.Units.Records.Any(u => u.InUse && u.Owner == session.CivId && session.Units.Types.Name(u.TypeIndex) == "anti_armor"); break;
                case 10: text = "Hold the new base, then push toward an enemy headquarters."; tile = site.Tile; done = time - stepAt > 8f; break;
                case 11: text = "Destroy the enemy headquarters. Capture the ruin with infantry and rebuild it."; done = session.Objectives.Values.Any(s => s.Starting && s.Id != 1 && s.Owner == session.CivId); break;
                default: tutorialStep = -1; coach.style.display = DisplayStyle.None; pointer.style.display = DisplayStyle.None; return;
            }
            coachText.text = $"{tutorialStep + 1}/12 · {text}";
            if (done) { tutorialStep++; stepAt = 0; }
            if (id > 0 && tile >= 0 && TileScreen?.Invoke(tile) is Vector3 sp && sp.z > 0)
            {
                var p = ToPanel(sp);
                pointer.style.left = p.x - 9; pointer.style.top = p.y - 59 - 6 * Mathf.Abs(Mathf.Sin(time * 4));
                pointer.style.display = DisplayStyle.Flex;
            }
            else pointer.style.display = DisplayStyle.None;
        }

        public void MatchEnded(JObject winner)
        {
            int id = ProtocolDecoder.Int(winner?["civ"], -1);
            string result = id < 0 ? "Draw" : session.Spectator ? "Match complete" : session.IsHostile(id) ? "Defeat" : "Victory";
            ResultCard(result, $"{ProtocolDecoder.Str(winner?["name"], "")} · {ProtocolDecoder.Str(winner?["how"], "Military Domination")}", -1);
        }
    }
}
