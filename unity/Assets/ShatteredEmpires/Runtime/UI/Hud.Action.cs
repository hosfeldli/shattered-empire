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
        static readonly string[] Facilities = { "depot", "power_plant", "barracks", "armory", "motor_works", "heavy_weapons", "airfield", "advanced_lab", "missile_silo" };
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

        string SiteStatus(ObjectiveSite s)
        {
            if (s.Contested) return "Contested";
            if (s.Capture > 0) return $"Capturing · {s.Capture:0}%";
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

        static string UnitRole(string type) => type switch
        {
            "engineer" => "Captures ruins. Repairs vehicles, buildings and defenses, and assists construction outside combat.",
            "anti_armor" or "field_gun" => "Counters vehicles. Protect it from infantry and indirect fire.",
            "rifle_squad" or "militia" or "special_forces" or "exo_infantry" => "Captures ruins and holds covered ground. Vulnerable in the open.",
            "tank" or "autonomous_tank" => "Armored frontline unit. Screen against anti-armor infantry and aircraft.",
            "mortar_team" or "sp_artillery" or "missile_battery" => "Indirect fire against fortifications and clustered forces.",
            "fighter" or "air_defense" => "Intercepts aircraft. Pair with ground forces.",
            "scout_buggy" or "recon_drone" or "armored_car" => "Reconnaissance and detection. Keep clear of heavy fire.",
            "bomber" or "helicopter" or "oneway_drone" or "strike_swarm" => "Mobile ground strikes. Vulnerable to interceptors and air defenses.",
            "supply_truck" => "Mobile field repair.",
            _ => "Mobile ground support."
        };

        // ------------------------------------------------------------------ selection card (B10)
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
            // fixed width, centred, above the defense bar — never percentage-based (defect 21)
            card.style.position = Position.Absolute;
            card.style.left = Length.Percent(50); card.style.right = StyleKeyword.Auto;
            card.style.top = StyleKeyword.Auto; card.style.bottom = 88;
            card.style.width = 600; card.style.marginLeft = -300;
            card.style.maxHeight = 220;
        }

        void ActionCard(bool force)
        {
            if (card == null) return;
            if (!cardStyled) StyleSelectionCard(true);
            // a running tool replaces the card with the tool chip (Hud.DefenseBar.cs)
            if (commander.Current != Commander.Mode.Select) { card.style.display = DisplayStyle.None; cmdCardSignature = "tool"; return; }
            session.Objectives.TryGetValue(commander.SelectedObjective, out var site);
            int unitHash = 0;
            foreach (int id in units.Selected) unitHash = unitHash * 31 + id;
            // the structure revision matters only to a building card and unit membership only to a unit card (live
            // values update in place): a site card is no longer rebuilt whenever any building in the world changes
            bool buildingsSelected = commander.SelectedBuildings.Count > 0;
            int structureRev = buildingsSelected ? session.Structures.Revision : 0;
            int membershipRev = units.Selected.Count > 0 ? session.Units.MembershipRevision : 0;
            string sig = $"{site.Id}|{site.Owner}|{site.Headquarters}|{site.Operational}|{site.Tier}|{site.Contested}|{site.Capture > 0}|{site.Slots?.Length}|" +
                $"{commander.SelectedPickup}|{(buildingsSelected ? string.Join(",", commander.SelectedBuildings) : "")}|{units.Selected.Count}:{unitHash}|{structureRev}|{membershipRev}";
            if (!force && sig == cmdCardSignature) { foreach (var update in cmdCardLive) update(); return; }
            cmdCardSignature = sig;
            card.Clear();
            cmdCardLive.Clear();
            if (commander.SelectedPickup != 0) PickupCard();
            else if (site.Id > 0) SiteCard(site);
            else if (commander.SelectedBuildings.Count > 0) BuildingStatusCard();
            else if (units.Selected.Count > 0) UnitStatusCard();
            card.style.display = card.childCount > 0 ? DisplayStyle.Flex : DisplayStyle.None;
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
            CardHeader("materials", $"+{pickup.Amount} {(pickup.Resource == "energy" ? "Energy" : "Materials")}", out _);
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
                CardBar(() => session.Objectives.TryGetValue(id, out var s) && (s.Capture > 0 || s.Contested) ? s.Capture : -1,
                    () => session.Objectives.TryGetValue(id, out var s) ? s.Contested ? "Contested" : $"Capturing {s.Capture:0}%" : "",
                    () => session.Objectives.TryGetValue(id, out var s) && s.Contested ? UiKit.Token("bad") : UiKit.RelationColor(session, s.Capturing >= 0 ? s.Capturing : s.Owner));
                return;
            }
            int siteId = site.Id;
            if (site.Headquarters == 0)
            {
                var line = CardLine();
                cmdCardLive.Add(() => line.text = session.Objectives.TryGetValue(siteId, out var s) ? SiteStatus(s) : "");
                CardBar(() => session.Objectives.TryGetValue(siteId, out var s) && (s.Capture > 0 && s.Capture < 100 || s.Contested) ? s.Capture : -1,
                    () => session.Objectives.TryGetValue(siteId, out var s) && s.Contested ? "Contested" : "Securing");
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
            CardBar(() => session.Structures.Buildings.TryGetValue(hqId, out var hq) ? hq.Project != null ? hq.WorksPct : hq.Hp : 0,
                () => session.Structures.Buildings.TryGetValue(hqId, out var hq) ? hq.Project == "tier" ? $"Upgrading {hq.WorksPct}%" : hq.Project == "perimeter" ? $"Perimeter {hq.WorksPct}%" : $"Condition {hq.Hp}%" : "",
                () => session.Structures.Buildings.TryGetValue(hqId, out var hq) && hq.Project == null ? HealthColor(hq.Hp) : UiKit.Token("good"));
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
            var trainerIds = selected.Where(b => Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).Select(b => b.Id).ToArray();
            if (trainerIds.Length == 0) return;
            // production line: queue icons with progress on the head, and a Repeat tag
            var line = UiKit.El("se-cmd-queue", card);
            line.style.flexDirection = FlexDirection.Row; line.style.alignItems = Align.Center; line.style.height = 30;
            const int Slots = 10;
            var slotEls = new (VisualElement box, IconElement icon, VisualElement progress)[Slots];
            for (int k = 0; k < Slots; k++)
            {
                var box = UiKit.El("se-cmd-queue-item", line);
                box.style.width = 26; box.style.height = 28; box.style.marginRight = 3;
                var icon = new IconElement("", "se-cmd-queue-icon");
                icon.style.width = 24; icon.style.height = 24;
                box.Add(icon);
                var progress = UiKit.El("se-cmd-queue-progress", box);
                progress.style.height = 2;
                slotEls[k] = (box, icon, progress);
            }
            var tag = UiKit.Text("Repeat", "se-cmd-tag", line);
            tag.style.marginLeft = StyleKeyword.Auto;
            cmdCardLive.Add(() =>
            {
                int n = 0; bool repeat = false;
                foreach (int id in trainerIds)
                {
                    if (!session.Structures.Buildings.TryGetValue(id, out var b)) continue;
                    if (!string.IsNullOrEmpty(b.Repeat)) repeat = true;
                    if (b.Queue == null) continue;
                    for (int q = 0; q < b.Queue.Length && n < Slots; q++, n++)
                    {
                        slotEls[n].icon.Kind = b.Queue[q];
                        slotEls[n].progress.style.width = Length.Percent(q == 0 ? b.TrainProgress : 0);
                    }
                }
                for (int k = 0; k < Slots; k++) slotEls[k].box.style.visibility = k < n ? Visibility.Visible : Visibility.Hidden;
                tag.style.visibility = repeat ? Visibility.Visible : Visibility.Hidden;
            });
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
            string main = groups[0].Key;
            var head = CardHeader(main, groups.Length == 1 ? $"{selected.Length} × {NameOf("UNITS", main)}" : $"{selected.Length} units", out _);
            if (!session.Spectator)
            {
                var wheelButton = UiKit.IconButton("wheel", () => OpenUnitWheel(false), "Command wheel (C)", head, 28);
                wheelButton.style.flexShrink = 0;
            }
            // composition chips
            var chips = UiKit.El("se-cmd-chips", card);
            chips.style.flexDirection = FlexDirection.Row; chips.style.flexWrap = Wrap.NoWrap; chips.style.height = 28; chips.style.overflow = Overflow.Hidden;
            foreach (var g in groups.Take(9))
            {
                var chip = UiKit.El("se-cmd-unit-chip", chips);
                chip.style.flexDirection = FlexDirection.Row; chip.style.alignItems = Align.Center; chip.style.marginRight = 6; chip.style.flexShrink = 0;
                var icon = new IconElement(g.Key, "se-cmd-unit-chip-icon");
                icon.style.width = 20; icon.style.height = 20;
                chip.Add(icon);
                UiKit.Text(g.Count().ToString(), "se-cmd-unit-chip-count", chip);
                chip.tooltip = NameOf("UNITS", g.Key) + "\n" + UnitRole(g.Key);
            }
            CardBar(SelectionHp, () => $"Condition {SelectionHp():0}%", () => HealthColor(SelectionHp()));
            var movement = CardLine("se-cmd-card-line se-cmd-card-warn");
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
                movement.text = text;
                movement.style.visibility = text.Length > 0 ? Visibility.Visible : Visibility.Hidden;
            });
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

            public SiteBadge()
            {
                pickingMode = PickingMode.Ignore;
                style.position = Position.Absolute; style.left = 0; style.top = 0; style.width = 28; style.height = 38;
                generateVisualContent += Paint;
            }

            /// <summary>Applies the visual state; repaints only when something drawn changed (the pulse matters only while contested).</summary>
            public void Set(int shape, Color color, float progress, Color progressColor, int pips, bool contested, float pulse)
            {
                if (!contested) pulse = 0f;
                if (shape == Shape && color == Color && progress == Progress && progressColor == ProgressColor && pips == Pips && contested == Contested
                    && Mathf.Abs(pulse - Pulse) < .02f) return;
                Shape = shape; Color = color; Progress = progress; ProgressColor = progressColor; Pips = pips; Contested = contested; Pulse = pulse;
                MarkDirtyRepaint();
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
                // cull in panel space against the top bar (56) and the bottom band (92) — defect 29
                if (p.x < 14 || p.x > width - 14 || p.y < 56 + 30 || p.y > height - 92) continue;
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
                mark.Badge.Set(shape, color, progress, progressColor, pips, site.Contested, pulse);
                if (!mark.Shown) { mark.Shown = true; mark.Root.style.display = DisplayStyle.Flex; }
                var at = new Vector2(p.x - 14, p.y - 24);
                if (!((at - mark.At).sqrMagnitude <= .0025f)) { mark.At = at; mark.Root.style.translate = new Translate(at.x, at.y); }
                mark.Root.style.opacity = site.Memory ? .6f : 1f;
                var nameDisplay = detailed ? DisplayStyle.Flex : DisplayStyle.None;
                if (mark.Name.style.display != nameDisplay) mark.Name.style.display = nameDisplay;
                if (detailed) mark.Name.text = site.Contested ? "Contested" : site.Name;
            }
            HideUnseenMarkers(frame);
        }

        /// <summary>Hides the markers not drawn this frame (display is touched only when it changes).</summary>
        void HideUnseenMarkers(int frame)
        {
            foreach (var marker in objectiveMarkers.Values)
                if (marker.Shown && marker.SeenFrame != frame) { marker.Shown = false; marker.Root.style.display = DisplayStyle.None; }
        }

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
                case 0: text = "Pan with WASD and zoom with the wheel."; done = Vector3.Distance(startFocus, CameraFocus?.Invoke() ?? Vector3.zero) > 2.1f; break;
                case 1: text = "Select your rifle squads. Drag a box to select the entire force."; done = units.Selected.Count > 0; break;
                case 2: text = "Right-click terrain toward the marked ruins."; tile = site.Tile; done = commander.ActionMoveOrders > 0; break;
                case 3: text = "Press T for attack-move and clear the defenders around the ruins."; tile = site.Tile; done = site.Capture > 0 || site.Owner == session.CivId; break;
                case 4: text = "Hold infantry inside the command zone until capture completes."; tile = site.Tile; done = site.Owner == session.CivId; break;
                case 5: text = "Click the secured ruin and choose Establish base on its wheel."; tile = site.Tile; done = site.Headquarters > 0; break;
                case 6: text = "Click your headquarters, pick an empty socket and build a Barracks and a Materials Processor."; tile = site.Tile; done = check && HasBuildingAt(site.Id, "barracks") && HasBuildingAt(site.Id, "depot"); break;
                case 7: text = "Click the Barracks and train reinforcements from its wheel."; done = check && session.Structures.Buildings.Values.Any(b => b.QueueLength > 0 && b.Owner == session.CivId); break;
                case 8: text = "Right-drag to deploy a defensive battle line near the city."; tile = site.Tile; done = commander.ActionFormations > 0; break;
                case 9: text = "Queue an Anti-Armor Squad to counter vehicles. Use terrain and hold position."; done = check && (session.Structures.Buildings.Values.Any(b => b.Queue?.Contains("anti_armor") == true) || session.Units.Records.Any(u => u.InUse && u.Owner == session.CivId && session.Units.Types.Name(u.TypeIndex) == "anti_armor")); break;
                case 10: text = "Hold the new base, then push toward an enemy headquarters."; tile = site.Tile; done = time - stepAt > 8f; break;
                case 11: text = "Destroy the enemy headquarters. Capture the ruin with infantry and rebuild it."; done = check && session.Objectives.Values.Any(s => s.Starting && s.Id != 1 && s.Owner == session.CivId); break;
                default: tutorialStep = -1; coach.style.display = DisplayStyle.None; pointer.style.display = DisplayStyle.None; return;
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
            ResultCard(result, $"{ProtocolDecoder.Str(winner?["name"], "")} · {ProtocolDecoder.Str(winner?["how"], "Military Domination")}", -1);
        }
    }
}
