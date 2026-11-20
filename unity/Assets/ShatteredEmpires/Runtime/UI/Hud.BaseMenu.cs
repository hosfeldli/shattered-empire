using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Base menu rework (2026-11-20, Ticket 3, docs/gameplay-overhaul/BASE_MENU_REWORK.md). The headquarters wheel
    /// (tier upgrade on top with the era glyph, scout buggy and militia each with its upgrade line immediately to its
    /// left, the engineer panel, build perimeter while incomplete; the two bottom segments unused), the production
    /// building wheel (building upgrade on top, four units each with its upgrade to its left), the outpost wheel (tier,
    /// militia, buggies, three plots, garrison) and the perimeter wheel (each turret's path, the centre turret, rebuild).
    /// Server commands: unitUpgrade, engineerUpgrade, centreTurret, perimeterUpgrade, outpostBuild, upgradeBuilding.
    /// </summary>
    public sealed partial class Hud
    {
        /// <summary>Unit wedges of a four-unit production wheel and their upgrades, each immediately to the unit's left on screen.</summary>
        static readonly float[] UnitAngles = { 80f, 120f, 200f, 320f }, UnitUpgradeAngles = { 40f, 160f, 240f, 280f };
        static readonly string[] UpgradeRoman = { "", "I", "II", "III" };

        /// <summary>True when building b trains unit type (its definition, and an outpost's tier gate: server trainsAt).</summary>
        bool TrainsHere(in BuildingRecord b, string type)
        {
            var d = Defs?["BUILDINGS"]?[b.Type];
            if (!(d?["trains"] is JArray trains) || !trains.Any(t => (string)t == type)) return false;
            int gate = ProtocolDecoder.Int(d["trainsAt"]?[type], 1);
            return Mathf.Max(1, b.Level) >= gate;
        }

        static RadialItem Angled(RadialItem item, float angle) { if (item != null) item.Angle = angle; return item; }

        // ------------------------------------------------------------------ headquarters wheel
        List<RadialItem> BaseMenuItems(ObjectiveSite site)
        {
            int siteId = site.Id;
            var hq = HqOf(siteId);
            int[] host = hq.Id != 0 ? new[] { hq.Id } : Array.Empty<int>();
            var list = new List<RadialItem>();
            // the tier upgrade disappears once the base is fully upgraded
            if (site.Tier < 3) list.Add(BaseUpgrade(site));
            list.Add(Angled(UnitUpgradeItem("scout_buggy", host), 40f));
            list.Add(Angled(TrainItem("scout_buggy", host), 80f));
            list.Add(EngineersItem(siteId, 120f));
            // 160° and 200° stay unused (Ticket 3); the perimeter is built here and upgraded by clicking it
            if (site.DefenseCount < 6) list.Add(Angled(PerimeterItem(site), 240f));
            list.Add(Angled(UnitUpgradeItem("militia", host), 280f));
            list.Add(Angled(TrainItem("militia", host), 320f));
            list.Add(PadEntryItem(siteId));
            return list;
        }

        /// <summary>No wedge: a pad clicked on the base enters its facility ring through this hidden item (the pads view is gone).</summary>
        RadialItem PadEntryItem(int siteId) => new RadialItem
        {
            Id = "pads", Icon = "build", Title = "Pad", Angle = 0f,
            Visible = () => false,
            Children = () =>
            {
                baseSubRing = "pads";
                int slot = wheelEnteredSlot != 0 ? wheelEnteredSlot : commander.SelectedRingSlot;
                if (slot != 0) commander.SelectRingSlot(siteId, slot);
                return FacilityItems(siteId, slot);
            },
        };

        /// <summary>The centre circle under the base name: the base's Materials and Energy income.</summary>
        string BaseIncomeLine(int siteId)
        {
            var (m, e) = BaseIncome(siteId);
            return $"+{m * 60f:0} Materials/min · +{e * 60f:0} Energy/min";
        }

        // ------------------------------------------------------------------ per-building unit upgrades
        static string ParamsText(JToken tier)
        {
            if (!(tier is JObject o)) return "";
            var parts = new List<string>();
            foreach (var p in o.Properties())
            {
                if (p.Name == "tier" || p.Name == "cost" || p.Name == "time") continue;
                float v = ProtocolDecoder.Float(p.Value);
                string name = p.Name switch
                {
                    "damage" => "damage", "cooldown" => "every", "radius" => "blast", "detect" => "detects within", "vision" => "+vision",
                    "small" => "small-arms damage ×", "supp" => "suppression ×", "seconds" => "for", "wide" => "wide screen", "mult" => "speed ×",
                    "rate" => "repair", "cut" => "absorbs", "blast" => "blast ×", "delay" => "hidden after", "ambush" => "ambush ×", "extra" => "+munitions",
                    "rof" => "reload ×", "range" => "reach", _ => p.Name,
                };
                string value = p.Name == "cut" ? $"{v * 100:0}%" : p.Name == "cooldown" || p.Name == "seconds" || p.Name == "delay" ? $"{v:0.#} s" : $"{v:0.##}";
                if (p.Name == "wide") { if (v > 0) parts.Add("wide screen"); continue; }
                parts.Add(name + " " + value);
            }
            return string.Join(", ", parts);
        }

        /// <summary>
        /// A unit's upgrade line (three tiers) on the buildings <paramref name="ids"/> that train it: bought per building,
        /// it applies to what that building trains (and the living units it made). The caption shows the tier owned.
        /// </summary>
        RadialItem UnitUpgradeItem(string type, int[] ids)
        {
            var line = Defs?["UNITS"]?[type]?["upgrade"];
            if (line == null) return null;
            int unitTier = ProtocolDecoder.Int(Defs?["UNITS"]?[type]?["tier"], 1);
            string name = ProtocolDecoder.Str(line["name"], "Upgrade"), desc = ProtocolDecoder.Str(line["desc"], "");
            BuildingRecord[] Hosts() => HostsFor(ids, "unit:" + type);
            int Current() { var h = Hosts(); if (h.Length == 0) return 0; int t = 3; foreach (var b in h) t = Mathf.Min(t, b.UnitUpgrade(type)); return t; }
            int current = Current(), next = Mathf.Min(3, current + 1);
            var spec = (line["tiers"] as JArray)?.ElementAtOrDefault(next - 1);
            BuildingRecord Researching() { foreach (var b in Hosts()) if (b.ResearchKind == "unit" && b.ResearchKey == type) return b; return default; }
            return new RadialItem
            {
                Id = "ug:" + type, Icon = "upgrade",
                Name = () => Current() >= 3 ? $"{name} III · complete" : $"{name} {UpgradeRoman[Mathf.Clamp(Current() + 1, 1, 3)]}",
                Cost = current < 3 ? spec?["cost"] : null, Seconds = current < 3 ? ProtocolDecoder.Int(spec?["time"]) : 0,
                Caption = () => Current() > 0 ? UpgradeRoman[Current()] : null,
                Detail = () => $"{NameOf("UNITS", type)}: {desc}" + (Current() < 3 ? $" · Tier {UpgradeRoman[Mathf.Clamp(Current() + 1, 1, 3)]}: {ParamsText(spec)}" : "")
                    + (Hosts().Length > 1 ? $" · on {Hosts().Length} buildings" : " · this building only"),
                Enabled = () =>
                {
                    int c = Current();
                    return c < 3 && Mathf.Max(c + 1, unitTier) <= Age + 1 && Hosts().Any(b => b.ResearchKind == null && b.UnitUpgrade(type) == c);
                },
                Reason = () =>
                {
                    int c = Current();
                    if (c >= 3) return "Fully upgraded here";
                    var r = Researching();
                    if (r.Id != 0) return $"Upgrading · {r.ResearchPct}%";
                    if (Hosts().Length == 0) return "Train it here first (needs the building's tier)";
                    if (Mathf.Max(c + 1, unitTier) > Age + 1) return $"Requires era {Tier(Mathf.Max(c + 1, unitTier))}";
                    if (Hosts().All(b => b.ResearchKind != null)) return "The building is researching another upgrade";
                    return "Visible on the unit · applies to units trained here";
                },
                Progress = () => { var r = Researching(); return r.Id != 0 ? r.ResearchPct / 100f : -1f; },
                Click = _ =>
                {
                    int c = Current();
                    foreach (var b in Hosts())
                        if (b.ResearchKind == null && b.UnitUpgrade(type) == c)
                            Send(new JObject { ["c"] = "unitUpgrade", ["id"] = b.Id, ["unit"] = type }, $"{name} {UpgradeRoman[Mathf.Clamp(c + 1, 1, 3)]} started");
                },
            };
        }

        /// <summary>Snapshot key of what the upgrade wedges show (rebuilds the ring when a tier or research changes).</summary>
        static string UpgradeKey(in BuildingRecord b)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(b.ResearchKind ?? "-").Append(b.ResearchKey).Append(b.ResearchLevel).Append(b.Path).Append(b.Gun);
            if (b.UnitUpgrades != null) foreach (var kv in b.UnitUpgrades.OrderBy(k => k.Key)) sb.Append(kv.Key).Append(kv.Value);
            return sb.ToString();
        }

        // ------------------------------------------------------------------ engineers
        IEnumerable<SE.Core.Units.UnitStore.Record> BaseEngineers(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) yield break;
            var store = session.Units;
            for (int s = 0; s < store.SlotCount; s++)
            {
                var u = store.Records[s];
                if (!u.InUse || u.Owner != session.CivId || (u.Flags & 4096) == 0 || !u.Motion.Present) continue;
                // the engineer's base: the nearest own operational headquarters
                int best = 0; float bestD = float.MaxValue;
                foreach (var o in session.Objectives.Values)
                {
                    if (!o.IsBase || o.Owner != session.CivId || !o.Operational) continue;
                    float dx = session.World.Grid.DxWrap(u.Motion.X, o.X), dz = o.Z - u.Motion.Z, d = dx * dx + dz * dz;
                    if (d < bestD) { bestD = d; best = o.Id; }
                }
                if (best == siteId) yield return u;
            }
        }

        RadialItem EngineersItem(int siteId, float angle) => new RadialItem
        {
            Id = "engineers", Icon = "engineer", Angle = angle,
            Name = () => session.Objectives.TryGetValue(siteId, out var s) ? $"Engineers · {s.Engineers}/{Mathf.Max(s.EngineerQuota, s.Engineers)}" : "Engineers",
            Badge = () => session.Objectives.TryGetValue(siteId, out var s) ? s.Engineers : 0,
            Caption = () => session.Objectives.TryGetValue(siteId, out var s) && s.EngineerLevel > 0 ? UpgradeRoman[Mathf.Clamp(s.EngineerLevel, 0, 3)] : null,
            Detail = () =>
            {
                if (!session.Objectives.TryGetValue(siteId, out var s)) return "";
                string next = s.EngineerNext >= 0 ? $" · next replacement in {Mathf.CeilToInt(s.EngineerNext)} s" : "";
                return $"Automatic: they build what you place and repair damaged structures (nearest, most damaged and safest first){next} · 3 / 5 / 8 by base tier";
            },
            Children = () => { baseSubRing = "engineers"; return EngineerPanel(siteId); },
        };

        /// <summary>The engineer panel: the three upgrades (in order) and one wedge per engineer of this base.</summary>
        List<RadialItem> EngineerPanel(int siteId)
        {
            var list = new List<RadialItem>();
            var specs = Defs?["RULESET"]?["engineerUpgrades"] as JArray;
            for (int i = 0; i < 3; i++)
            {
                int level = i + 1;
                var spec = specs?.ElementAtOrDefault(i);
                string name = ProtocolDecoder.Str(spec?["name"], "Engineer upgrade " + level);
                list.Add(new RadialItem
                {
                    Id = "eng:" + level, Icon = level == 2 ? "scout_buggy" : level == 3 ? "build" : "engineer",
                    Name = () => session.Objectives.TryGetValue(siteId, out var s) && s.EngineerLevel >= level ? name + " · done" : name,
                    Cost = spec?["cost"], Seconds = ProtocolDecoder.Int(spec?["time"]),
                    Caption = () => UpgradeRoman[level],
                    Active = () => session.Objectives.TryGetValue(siteId, out var s) && s.EngineerLevel >= level,
                    Detail = () => ProtocolDecoder.Str(spec?["desc"], ""),
                    Enabled = () => session.Objectives.TryGetValue(siteId, out var s) && s.EngineerLevel == level - 1 && s.Tier >= level && HqOf(siteId).ResearchKind == null,
                    Reason = () =>
                    {
                        if (!session.Objectives.TryGetValue(siteId, out var s)) return "";
                        var h = HqOf(siteId);
                        if (s.EngineerLevel >= level) return "Complete · visible on every engineer";
                        if (h.ResearchKind == "engineer" && h.ResearchLevel == level) return $"Upgrading · {h.ResearchPct}%";
                        if (s.EngineerLevel < level - 1) return $"After {ProtocolDecoder.Str(specs?.ElementAtOrDefault(level - 2)?["name"], "the previous upgrade")}";
                        if (s.Tier < level) return $"Requires a Tier {Tier(level)} base";
                        if (h.ResearchKind != null) return "The headquarters is researching another upgrade";
                        return null;
                    },
                    Progress = () => { var h = HqOf(siteId); return h.ResearchKind == "engineer" && h.ResearchLevel == level ? h.ResearchPct / 100f : -1f; },
                    Click = _ => Send(new JObject { ["c"] = "engineerUpgrade", ["site"] = siteId }, name + " started"),
                });
            }
            int k = 0;
            foreach (var u in BaseEngineers(siteId))
            {
                if (k++ >= 6) break;
                int id = u.Id;
                list.Add(new RadialItem
                {
                    Id = "engineer:" + id, Icon = "engineer",
                    Name = () => session.Units.TryGet(id, out var e) ? $"Engineer · {e.Hp}%" : "Engineer",
                    Detail = () => session.Units.TryGet(id, out var e) && (e.Flags & 256) != 0 ? "At work: building or repairing" : "Looking for work · repairs and builds automatically",
                    Reason = () => "Click to look at it (engineers work on their own)",
                    Click = _ => commander.SelectUnits(new[] { id }),
                });
            }
            return list;
        }

        // ------------------------------------------------------------------ production buildings: four units, four upgrades, one building upgrade
        /// <summary>True when the selection is production buildings of one type with at most four units (the paired wheel).</summary>
        bool PairedProduction(BuildingRecord[] own, out string[] trains)
        {
            trains = null;
            if (own.Length == 0 || own.Any(b => b.Type != own[0].Type || !b.Done)) return false;
            if (own[0].Type == "town" || own[0].Type == "fort") return false;
            if (!(Defs?["BUILDINGS"]?[own[0].Type]?["trains"] is JArray list) || list.Count == 0 || list.Count > 4) return false;
            trains = list.Select(t => (string)t).ToArray();
            return true;
        }

        List<RadialItem> PairedProductionItems(BuildingRecord[] own, string[] trains)
        {
            int[] ids = own.Select(b => b.Id).ToArray();
            var items = new List<RadialItem>();
            var level = LevelUpgradeItem(ids);
            if (level != null) items.Add(Angled(level, 0f));
            for (int i = 0; i < trains.Length && i < 4; i++)
            {
                items.Add(Angled(TrainItem(trains[i], ids), UnitAngles[i]));
                var ug = UnitUpgradeItem(trains[i], ids);
                if (ug != null) items.Add(Angled(ug, UnitUpgradeAngles[i]));
            }
            return items;
        }

        // ------------------------------------------------------------------ outposts: a tiny base
        List<RadialItem> OutpostItems(BuildingRecord fort)
        {
            int[] ids = { fort.Id };
            var items = new List<RadialItem>();
            var level = LevelUpgradeItem(ids);
            if (level != null && Mathf.Max(1, fort.Level) < 3) items.Add(Angled(level, 0f));
            items.Add(Angled(UnitUpgradeItem("scout_buggy", ids), 40f));
            items.Add(Angled(TrainItem("scout_buggy", ids), 80f));
            for (int k = 1; k <= 3; k++) items.Add(Angled(PlotItem(fort.Id, k), 80f + 40f * k));
            if (GarrisonCapacity(fort.Type) > 0) items.Add(GarrisonWedge(fort.Id, 240f));
            items.Add(Angled(UnitUpgradeItem("militia", ids), 280f));
            items.Add(Angled(TrainItem("militia", ids), 320f));
            return items;
        }

        RadialItem PlotItem(int fortId, int plot)
        {
            BuildingRecord Occupant() { foreach (var b in session.Structures.Buildings.Values) if (b.OutpostId == fortId && b.Plot == plot && b.Owner == session.CivId) return b; return default; }
            int FortLevel() => session.Structures.Buildings.TryGetValue(fortId, out var f) ? Mathf.Max(1, f.Level) : 1;
            var occ = Occupant();
            if (occ.Id != 0)
            {
                int oid = occ.Id;
                return new RadialItem
                {
                    Id = "plot:" + plot, Icon = Icons.BuildingKind(occ.Type), Title = NameOf("BUILDINGS", occ.Type),
                    Caption = () => "plot " + plot,
                    Progress = () => session.Structures.Buildings.TryGetValue(oid, out var b) && !b.Done ? b.Progress / 100f : -1f,
                    Detail = () => session.Structures.Buildings.TryGetValue(oid, out var b) && !b.Done ? $"Under construction {b.Progress}%" : "Outpost plot · click to open it",
                    Click = _ => commander.SelectProduction(new[] { oid }),
                };
            }
            var options = Defs?["RULESET"]?["outpost"]?["plots"] as JArray;
            return new RadialItem
            {
                Id = "plot:" + plot, Icon = "plus", Title = "Empty plot", Pulse = true,
                Caption = () => "plot " + plot,
                Enabled = () => FortLevel() >= plot,
                Reason = () => FortLevel() >= plot ? "One build plot per outpost tier" : $"Unlocks at outpost tier {Tier(plot)}",
                Detail = () => "A Materials Processor, Energy Generator or Barracks beside the outpost",
                Children = () =>
                {
                    var list = new List<RadialItem>();
                    foreach (var t in options ?? new JArray("depot", "power_plant", "barracks"))
                    {
                        string type = (string)t;
                        var d = Defs?["BUILDINGS"]?[type];
                        int tier = ProtocolDecoder.Int(d?["tier"], 1);
                        list.Add(new RadialItem
                        {
                            Id = "plotbuild:" + type, Icon = Icons.BuildingKind(type), Title = NameOf("BUILDINGS", type), Cost = d?["cost"], Seconds = ProtocolDecoder.Int(d?["time"]),
                            Detail = () => ProtocolDecoder.Str(d?["desc"], ""),
                            Enabled = () => tier <= Age + 1,
                            Reason = () => tier > Age + 1 ? $"Requires Tier {Tier(tier)}" : null,
                            Click = _ => { Send(new JObject { ["c"] = "outpostBuild", ["id"] = fortId, ["type"] = type }, NameOf("BUILDINGS", type) + " under construction"); CloseWheel(); },
                        });
                    }
                    return list;
                },
            };
        }

        // ------------------------------------------------------------------ perimeter wheel (click a perimeter position)
        string PerimeterStructure(int siteId)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(Age).Append('|');
            if (session.Objectives.TryGetValue(siteId, out var s)) sb.Append(s.DefenseCount).Append(s.Tier).Append('|');
            var hq = HqOf(siteId);
            sb.Append(hq.Gun).Append(UpgradeKey(hq)).Append('|');
            foreach (var b in session.Structures.Buildings.Values)
                if (b.City == siteId && b.Owner == session.CivId && b.Type == "city_turret" && b.PerimeterSlot > 0) sb.Append(b.Id).Append(b.Level).Append(UpgradeKey(b)).Append(b.Done ? 'd' : 'u').Append(',');
            return sb.ToString();
        }

        void OpenPerimeterWheel(int siteId, int fromBuilding)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            CloseWheel();
            wheelKind = "perimeter"; wheelSite = siteId; wheelBuildings = new[] { fromBuilding };
            wheelStructure = PerimeterStructure(siteId); wheelStructureSnap = session.Snapshots;
            float x = site.X, z = site.Z;
            if (session.Structures.Buildings.TryGetValue(fromBuilding, out var from) && from.HasPosition) { x = from.X; z = from.Z; }
            wheel.Open("Perimeter · " + site.Name, "sandbags", PerimeterItems(siteId), WorldAnchor(x, z, .3f));
            wheel.SubjectDetail = () => "Each turret chooses one path: anti-air, anti-infantry or anti-vehicle";
        }

        void RefreshPerimeterWheel()
        {
            if (!session.Objectives.TryGetValue(wheelSite, out var site) || !site.Operational) { CloseWheel(); return; }
            if (wheelStructureSnap == session.Snapshots) return;
            wheelStructureSnap = session.Snapshots;
            string structure = PerimeterStructure(wheelSite);
            if (structure == wheelStructure) return;
            wheelStructure = structure;
            if (wheel.Depth == 0) wheel.ReplaceRoot(PerimeterItems(wheelSite));
        }

        List<RadialItem> PerimeterItems(int siteId)
        {
            var list = new List<RadialItem>();
            var turrets = session.Structures.Buildings.Values.Where(b => b.City == siteId && b.Owner == session.CivId && b.Type == "city_turret" && b.PerimeterSlot > 0)
                .OrderBy(b => b.PerimeterSlot).ToArray();
            int n = 0;
            foreach (var t in turrets) list.Add(TurretItem(t, ++n));
            list.Add(CentreTurretItem(siteId));
            if (session.Objectives.TryGetValue(siteId, out var site) && site.DefenseCount < 6) list.Add(PerimeterItem(site));
            return list;
        }

        RadialItem TurretItem(BuildingRecord t, int n)
        {
            int id = t.Id;
            var paths = Defs?["RULESET"]?["perimeterPaths"] as JObject;
            var costs = Defs?["RULESET"]?["perimeterCost"] as JArray;
            var times = Defs?["RULESET"]?["perimeterTime"] as JArray;
            BuildingRecord Now() => session.Structures.Buildings.TryGetValue(id, out var b) ? b : t;
            if (string.IsNullOrEmpty(t.Path))
                return new RadialItem
                {
                    Id = "turret:" + id, Icon = "guard_post", Title = $"Turret {n} · choose a path",
                    Detail = () => "A permanent choice for this turret: anti-air, anti-infantry or anti-vehicle (three levels deep)",
                    Enabled = () => Now().Done,
                    Reason = () => Now().Done ? null : "Still under construction",
                    Progress = () => Now().ResearchKind == "path" ? Now().ResearchPct / 100f : -1f,
                    Children = () =>
                    {
                        var choices = new List<RadialItem>();
                        if (paths == null) return choices;
                        foreach (var p in paths.Properties())
                        {
                            string key = p.Name;
                            var levels = p.Value["levels"] as JArray;
                            choices.Add(new RadialItem
                            {
                                Id = "path:" + key, Icon = key == "aa" ? "aa" : key == "av" ? "at_gun" : "guard_post", Title = ProtocolDecoder.Str(p.Value["name"], key), Confirm = true,
                                Cost = costs?.ElementAtOrDefault(0), Seconds = ProtocolDecoder.Int(times?.ElementAtOrDefault(0)),
                                Detail = () => string.Join(" · ", (levels ?? new JArray()).Select((l, i) => $"{UpgradeRoman[i + 1]}: {(string)l}")),
                                Enabled = () => Now().ResearchKind == null && Now().Done,
                                Reason = () => Now().ResearchKind != null ? $"Upgrading · {Now().ResearchPct}%" : "Click twice: the path is permanent",
                                Click = _ => { Send(new JObject { ["c"] = "perimeterUpgrade", ["id"] = id, ["path"] = key }, ProtocolDecoder.Str(p.Value["name"], key) + " path chosen"); wheel.Back(); },
                            });
                        }
                        return choices;
                    },
                };
            string path = t.Path;
            var spec = paths?[path];
            int level = Mathf.Max(1, t.Level), next = level + 1;
            var lv = spec?["levels"] as JArray;
            return new RadialItem
            {
                Id = "turret:" + id, Icon = path == "aa" ? "aa" : path == "av" ? "at_gun" : "guard_post",
                Name = () => level >= 3 ? $"{ProtocolDecoder.Str(spec?["name"], path)} III · complete" : $"{ProtocolDecoder.Str(spec?["name"], path)} {UpgradeRoman[Mathf.Clamp(next, 1, 3)]}",
                Caption = () => UpgradeRoman[Mathf.Clamp(Mathf.Max(1, Now().Level), 1, 3)],
                Cost = level < 3 ? costs?.ElementAtOrDefault(next - 1) : null, Seconds = level < 3 ? ProtocolDecoder.Int(times?.ElementAtOrDefault(next - 1)) : 0,
                Detail = () => $"Turret {n} · " + (level < 3 ? (string)lv?.ElementAtOrDefault(next - 1) ?? "" : string.Join(" · ", (lv ?? new JArray()).Select(l => (string)l))),
                Enabled = () => level < 3 && next <= Age + 1 && Now().ResearchKind == null,
                Reason = () =>
                {
                    if (level >= 3) return "Fully upgraded";
                    if (Now().ResearchKind != null) return $"Upgrading · {Now().ResearchPct}%";
                    if (next > Age + 1) return $"Requires era {Tier(next)}";
                    return null;
                },
                Progress = () => Now().ResearchKind == "path" ? Now().ResearchPct / 100f : -1f,
                Click = _ => Send(new JObject { ["c"] = "perimeterUpgrade", ["id"] = id }, "Turret upgrade started"),
            };
        }

        RadialItem CentreTurretItem(int siteId)
        {
            var spec = Defs?["RULESET"]?["centreTurret"];
            var levels = spec?["levels"] as JArray;
            var hq = HqOf(siteId);
            int gun = hq.Gun, next = gun + 1;
            var nextSpec = levels?.ElementAtOrDefault(next - 1);
            return new RadialItem
            {
                Id = "centre", Icon = "artillery",
                Name = () => gun >= 3 ? "Centre turret · complete" : "Centre turret: " + ProtocolDecoder.Str(nextSpec?["name"], "upgrade"),
                Caption = () => HqOf(siteId).Gun > 0 ? UpgradeRoman[Mathf.Clamp(HqOf(siteId).Gun, 0, 3)] : null,
                Cost = gun < 3 ? nextSpec?["cost"] : null, Seconds = gun < 3 ? ProtocolDecoder.Int(nextSpec?["time"]) : 0,
                Detail = () => "The headquarters' own gun on its roof (provisional) · " + (gun < 3 ? ProtocolDecoder.Str(nextSpec?["desc"], "") : "High-explosive shells, airburst fuze, heavy gun"),
                Enabled = () => gun < 3 && session.Objectives.TryGetValue(siteId, out var s) && s.Tier >= next && HqOf(siteId).ResearchKind == null,
                Reason = () =>
                {
                    if (gun >= 3) return "Fully upgraded";
                    var h = HqOf(siteId);
                    if (h.ResearchKind == "gun") return $"Upgrading · {h.ResearchPct}%";
                    if (session.Objectives.TryGetValue(siteId, out var s) && s.Tier < next) return $"Requires a Tier {Tier(next)} base";
                    if (h.ResearchKind != null) return "The headquarters is researching another upgrade";
                    return null;
                },
                Progress = () => HqOf(siteId).ResearchKind == "gun" ? HqOf(siteId).ResearchPct / 100f : -1f,
                Click = _ => Send(new JObject { ["c"] = "centreTurret", ["site"] = siteId }, "Centre turret upgrade started"),
            };
        }
    }
}
