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
    /// <summary>
    /// Contextual command wheels (spec B6–B9): the base wheel (eight sockets wired to the HQ, tier upgrade on
    /// the hub, an outer arc of base commands), building wheels (training, upgrades, rally, repair, missile,
    /// demolish) and the unit wheel (orders, abilities, air missions). Empty sockets open a pop-out build
    /// picker; the Defenses command opens the defense picker. Contract C7: BuildCommandUi, UpdateCommandUi,
    /// CloseCommandContext, CommandUiCapturesDigits, ShowCommandUi.
    /// </summary>
    public sealed partial class Hud
    {
        VisualElement commandLayer;
        RadialMenu wheel;
        string wheelKind = "", wheelSubject = "", wheelStructure = "";
        int wheelSite;
        int[] wheelBuildings = Array.Empty<int>();
        bool selectionEvent, commandUiShown = true;
        int digitFrame = -1;
        // world-anchored parcel bearings for the socket wedges
        readonly List<RadialItem> socketItems = new List<RadialItem>();
        readonly Dictionary<string, BaseParcel> socketParcels = new Dictionary<string, BaseParcel>();

        // pop-out pickers (build / defense)
        VisualElement picker, pickerGrid;
        Label pickerTitle;
        string pickerKind = "";
        int pickerSite, pickerSlot;
        readonly List<(Action pick, Action refresh)> pickerTiles = new List<(Action, Action)>();

        const float MinimapRadius = 136f;

        // ------------------------------------------------------------------ contract (C7)
        /// <summary>Called once from Hud.Build(): the wheel layer, the defense bar and the tool chip.</summary>
        void BuildCommandUi()
        {
            if (commandLayer != null) return;
            commandLayer = UiKit.El("se-cmd-layer", root);
            commandLayer.pickingMode = PickingMode.Ignore;
            commandLayer.style.position = Position.Absolute;
            commandLayer.style.left = 0; commandLayer.style.top = 0; commandLayer.style.right = 0; commandLayer.style.bottom = 0;
            wheel = new RadialMenu(ResourceHave);
            wheel.Refused = reason => commander.Say(reason, false, Time.unscaledTime);
            wheel.Picker = PickCached;   // one panel pick per frame, shared with the tooltip and pointer-over-UI tests
            commandLayer.Add(wheel);
            commander.SelectionChanged += () => selectionEvent = true;
            commander.Refused += FlashForRefusal;
            BuildDefenseBar();
            BuildToolChip();
        }

        /// <summary>True while digits belong to the command UI (wheel hot, picker open, defense bar armed).</summary>
        bool CommandUiCapturesDigits => wheel != null && wheel.IsOpen && wheel.Hot || picker != null && pickerKind != "" || defenseBarArmed || digitFrame == Time.frameCount;

        /// <summary>From ShowGame: show or hide the command layer, defense bar and tool chip.</summary>
        void ShowCommandUi(bool on)
        {
            commandUiShown = on;
            if (commandLayer == null) return;
            commandLayer.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
            if (!on) { CloseWheel(); SetDefenseBarArmed(false); }
            ShowDefenseBar(on);
            if (on && defenseBar != null)
            {
                defenseBar.style.opacity = 0;
                var bar = defenseBar; bar.schedule.Execute(() => bar.style.opacity = 1).StartingIn(60);
            }
        }

        /// <summary>Escape chain step 5: picker → wheel sub-ring → armed defense bar → wheel. True if consumed.</summary>
        bool CloseCommandContext()
        {
            // a running tool or battle line belongs to the commander, which cancels it this frame
            // (it runs after the HUD, so its EscapeFrame is not set yet): consume so the selection survives
            if (commander.Current != Commander.Mode.Select || commander.DrawingLine) return true;
            if (pickerKind != "") { ClosePicker(); return true; }
            if (wheel != null && wheel.IsOpen && wheel.Back()) return true;
            if (defenseBarArmed) { SetDefenseBarArmed(false); return true; }
            if (wheel != null && wheel.IsOpen) { CloseWheel(); return true; }
            return false;
        }

        /// <summary>Per frame from Hud.Update (after Escape handling).</summary>
        void UpdateCommandUi(float time)
        {
            if (commandLayer == null) return;
            bool active = commandUiShown && session.ActionRts && session.Ready && !MenuVisible && topbar != null && topbar.style.display != DisplayStyle.None;
            if (!active)
            {
                CloseWheel();
                SetDefenseBarArmed(false);
                ShowDefenseBar(false);
                if (toolChip != null) toolChip.style.display = DisplayStyle.None;
                if (cursorReason != null) cursorReason.style.display = DisplayStyle.None;
                commander.SuppressGroupKeys = false;
                return;
            }
            ShowDefenseBar(!session.Spectator);
            var mouse = InputFacade.MousePosition;
            var pointer = ToPanel(new Vector3(mouse.x, mouse.y, 1));
            float width = root.layout.width, height = root.layout.height;
            if (float.IsNaN(width) || width <= 0) { width = 1920; height = 1080; }
            var safe = new Rect(16, 64, Mathf.Max(0, width - 32), Mathf.Max(0, height - 64 - 92));
            var minimapCentre = new Vector2(136, height - 136);

            if (commander.Current != Commander.Mode.Select) CloseWheel();   // a placement/target tool started
            else
            {
                string subject = session.Spectator ? "" : SubjectKey();
                if (selectionEvent || subject != wheelSubject)
                {
                    bool changed = subject != wheelSubject;
                    selectionEvent = false;
                    if (wheel.IsOpen && (changed || wheelKind == "unit")) CloseWheel();
                    wheelSubject = subject;
                    if (!wheel.IsOpen) AutoOpen(subject);
                    if (wheelKind == "base") SocketPickerFromSelection();
                }
                // right-click orders in the world close the unit wheel
                if (wheelKind == "unit" && InputFacade.RightDown && !IsPointerOverUi(mouse)) CloseWheel();
            }
            if (wheel.IsOpen) RefreshWheel();
            CommandKeys(time);
            wheel.Pointer = pointer;
            wheel.Tick(time, safe, minimapCentre, MinimapRadius);
            UpdatePicker(safe);
            UpdateDefenseBar(time);
            UpdateToolChip(pointer);
            commander.SuppressGroupKeys = CommandUiCapturesDigits;
            if (!(wheel.IsOpen && wheelKind == "base")) commander.HoverRingSlot = 0;
        }

        // ------------------------------------------------------------------ helpers
        int ResourceHave(string res) => ProtocolDecoder.Int(Econ?["res"]?[res]);

        /// <summary>"Need 40 more Materials", or null when affordable.</summary>
        string Shortfall(JToken cost)
        {
            if (!(cost is JObject o)) return null;
            foreach (var p in o.Properties())
            {
                int need = Mathf.RoundToInt(ProtocolDecoder.Float(p.Value)) - ResourceHave(p.Name);
                if (need > 0) return $"Need {need} more {(p.Name == "materials" ? "Materials" : p.Name == "energy" ? "Energy" : p.Name)}";
            }
            return null;
        }

        void FlashForRefusal(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            string t = text.ToLowerInvariant();
            if (t.Contains("material")) FlashResource("materials");
            if (t.Contains("energy")) FlashResource("energy");
            if (t.Contains("command capacity") || t.Contains("capacity")) FlashResource("command");
        }

        /// <summary>Send a command; refusals toast (and flash the short resource), successes say <paramref name="ok"/> (filtered by the toast allow-list).</summary>
        void Send(JObject cmd, string ok, Action<ServerMessage> after = null)
        {
            session.Net?.Command(cmd, r =>
            {
                commander.Say(r.Error ?? ok, r.Error == null, Time.unscaledTime);
                cmdCardSignature = "";
                after?.Invoke(r);
            });
        }

        static bool DigitPressed(int digit)
        {
            if (digit < 0 || digit > 9) return false;
            return InputFacade.Pressed(KeyCode.Alpha0 + digit) || InputFacade.Pressed(KeyCode.Keypad0 + digit);
        }

        static bool ActionKey(string action, KeyCode fallback) =>
            InputFacade.KeyFor(action) != KeyCode.None ? InputFacade.Action(action) : InputFacade.Pressed(fallback);

        Func<Vector2?> WorldAnchor(float x, float z, float raise)
        {
            return () =>
            {
                var sp = commander.WorldToScreen(x, z, raise);
                if (sp.z <= 0 || sp.x < 0 || sp.y < 0 || sp.x > Screen.width || sp.y > Screen.height) return null;
                return ToPanel(sp);
            };
        }

        // SubjectKey cache: the key only changes with the selection or a snapshot, so it is rebuilt (and its
        // strings allocated) only then, not every frame
        string subjectCache = "";
        int subjectSnap = -1, subjectPickup, subjectObjective, subjectCount = -1, subjectSum, subjectXor, subjectCiv;
        bool subjectUnits;

        string SubjectKey()
        {
            int sum = 0, xor = 0;
            foreach (int id in commander.SelectedBuildings) { sum += id * -1640531535; xor ^= id; }
            bool anyUnits = units.Selected.Count > 0;
            if (subjectSnap == session.Snapshots && subjectPickup == commander.SelectedPickup && subjectObjective == commander.SelectedObjective
                && subjectCount == commander.SelectedBuildings.Count && subjectSum == sum && subjectXor == xor && subjectUnits == anyUnits && subjectCiv == session.CivId)
                return subjectCache;
            subjectSnap = session.Snapshots; subjectPickup = commander.SelectedPickup; subjectObjective = commander.SelectedObjective;
            subjectCount = commander.SelectedBuildings.Count; subjectSum = sum; subjectXor = xor; subjectUnits = anyUnits; subjectCiv = session.CivId;
            subjectCache = ComputeSubjectKey();
            return subjectCache;
        }

        string ComputeSubjectKey()
        {
            if (commander.SelectedPickup != 0) return "";
            if (commander.SelectedObjective != 0)
            {
                if (session.Objectives.TryGetValue(commander.SelectedObjective, out var s) && s.IsBase && s.Owner == session.CivId)
                    return s.Headquarters == 0 ? "ruin:" + s.Id : s.Operational ? "base:" + s.Id : "rebuild:" + s.Id;
                return "";
            }
            if (commander.SelectedBuildings.Count > 0)
            {
                var own = new List<int>();
                int town = -1;
                foreach (int id in commander.SelectedBuildings)
                    if (session.Structures.Buildings.TryGetValue(id, out var b) && b.Owner == session.CivId)
                    {
                        if (b.Type == "town") town = b.City; else own.Add(id);
                    }
                if (own.Count == 0 && town >= 0 && session.Objectives.TryGetValue(town, out var hqSite) && hqSite.Operational) return "base:" + town;
                if (own.Count == 0) return "";
                own.Sort();
                return "bld:" + string.Join(",", own);
            }
            return units.Selected.Count > 0 ? "unit" : "";
        }

        void AutoOpen(string subject)
        {
            if (string.IsNullOrEmpty(subject) || session.Spectator) return;
            if (subject.StartsWith("base:") && int.TryParse(subject.Substring(5), out int baseId)) OpenBaseWheel(baseId);
            else if (subject.StartsWith("ruin:") && int.TryParse(subject.Substring(5), out int ruinId)) OpenRuinWheel(ruinId);
            else if (subject.StartsWith("bld:"))
            {
                var ids = subject.Substring(4).Split(',').Select(s => int.TryParse(s, out int v) ? v : 0).Where(v => v != 0).ToArray();
                OpenBuildingWheel(ids);
            }
            else if (subject == "unit" && App.GameSettings.OpenUnitWheelOnSelection) OpenUnitWheel(false);
        }

        void CloseWheel()
        {
            ClosePicker();
            if (wheel != null && wheel.IsOpen) wheel.Close();
            wheelKind = ""; wheelStructure = ""; wheelSite = 0; wheelBuildings = Array.Empty<int>();
            commander.HoverRingSlot = 0;
        }

        // the structure strings depend only on server state: rebuilt once per snapshot, not every frame
        int wheelStructureSnap = -1;
        int highlightSlot;
        string highlightId;

        void RefreshWheel()
        {
            if (wheelKind == "base")
            {
                if (!session.Objectives.TryGetValue(wheelSite, out var site) || !site.Operational) { CloseWheel(); return; }
                if (wheelStructureSnap != session.Snapshots)
                {
                    wheelStructureSnap = session.Snapshots;
                    string structure = BaseStructure(site);
                    if (structure != wheelStructure)
                    {
                        wheelStructure = structure;
                        wheel.ReplaceRoot(BaseSockets(site), BaseOuterArc(site), BaseHub(site));
                    }
                }
                AssignSocketAngles(site);
                int fromWorld = commander.HoverRingSlotFromWorld;
                if (fromWorld != highlightSlot) { highlightSlot = fromWorld; highlightId = fromWorld != 0 ? "socket:" + fromWorld : null; }
                wheel.HighlightId = highlightId;
            }
            else if (wheelKind == "building")
            {
                if (wheelStructureSnap != session.Snapshots)
                {
                    wheelStructureSnap = session.Snapshots;
                    string structure = BuildingStructure(wheelBuildings);
                    if (structure != wheelStructure)
                    {
                        wheelStructure = structure;
                        wheel.ReplaceRoot(BuildingItems(wheelBuildings));
                    }
                }
            }
            else if (wheelKind == "ruin")
            {
                if (!session.Objectives.TryGetValue(wheelSite, out var ruin) || ruin.Headquarters != 0) CloseWheel();
            }
        }

        void CommandKeys(float time)
        {
            if (InputFacade.Typing) return;
            if (!session.Spectator && ActionKey("commands", KeyCode.C) && units.Selected.Count > 0 && commander.Current == Commander.Mode.Select)
            {
                if (wheelKind == "unit") CloseWheel(); else OpenUnitWheel(true);
            }
            if (wheelKind == "base" && ActionKey("upgrade_base", KeyCode.U)) wheel.PressHub();
            if (!session.Spectator && InputFacade.Action("build")) ToggleDefenseBarArmed();
            // digits: picker, then the armed defense bar, then a hot wheel
            if (pickerKind != "")
            {
                for (int d = 1; d <= 9; d++) if (DigitPressed(d))
                {
                    digitFrame = Time.frameCount;
                    if (d - 1 < pickerTiles.Count) pickerTiles[d - 1].pick();
                    break;
                }
                return;
            }
            if (defenseBarArmed) { DefenseBarKeys(); return; }
            if (wheel.IsOpen && wheel.Hot)
                for (int d = 0; d <= 9; d++) if (DigitPressed(d))
                {
                    digitFrame = Time.frameCount;
                    wheel.PressDigit(d, InputFacade.Shift, InputFacade.Ctrl);
                    break;
                }
        }

        // ------------------------------------------------------------------ base wheel (B7)
        string BaseStructure(ObjectiveSite site)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(site.Tier).Append('|').Append(site.DefenseCount).Append('|').Append(site.Headquarters).Append('|').Append(site.RingVersion).Append('|');
            if (site.Slots != null) foreach (int s in site.Slots) sb.Append(s).Append(',');
            sb.Append('|');
            foreach (var b in session.Structures.Buildings.Values)
                if (b.City == site.Id && b.Owner == session.CivId && b.Slot != 0) sb.Append(b.Slot).Append(':').Append(b.Id).Append(b.Type).Append(',');
            return sb.ToString();
        }

        void OpenBaseWheel(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site) || !site.Operational) return;
            ClosePicker();
            wheelKind = "base"; wheelSite = siteId;
            wheelStructure = BaseStructure(site);
            wheelStructureSnap = session.Snapshots;
            float x = site.X, z = site.Z;
            if (session.Structures.Buildings.TryGetValue(site.Headquarters, out var hq) && hq.HasPosition) { x = hq.X; z = hq.Z; }
            wheel.Open(site.Name, "hq", BaseSockets(site), WorldAnchor(x, z, .3f), BaseHub(site), BaseOuterArc(site));
            wheel.HubPips = () => session.Objectives.TryGetValue(siteId, out var s) ? Mathf.Clamp(s.Tier, 1, 3) : 0;
            wheel.SubjectDetail = () =>
            {
                if (!session.Objectives.TryGetValue(siteId, out var s)) return "";
                int used = Mathf.Max(0, s.Capacity - (s.Slots?.Length ?? 0));
                return $"Tier {Tier(s.Tier)} base · {used}/{s.Capacity} sites used";
            };
            AssignSocketAngles(site);
        }

        List<RadialItem> BaseSockets(ObjectiveSite site)
        {
            socketItems.Clear(); socketParcels.Clear();
            int siteId = site.Id;
            var list = new List<RadialItem>();
            foreach (var parcel in (site.Parcels ?? Array.Empty<BaseParcel>()).Where(p => p.Id > 0).OrderBy(p => p.Id))
            {
                int slot = parcel.Id, parcelTier = parcel.Tier;
                var occupant = session.Structures.Buildings.Values.FirstOrDefault(b => b.City == siteId && b.Slot == slot && b.Owner == session.CivId);
                int occupantId = occupant.Id;
                bool locked = parcelTier > site.Tier;
                bool empty = !locked && occupantId == 0 && site.Slots != null && Array.IndexOf(site.Slots, slot) >= 0;
                string id = "socket:" + slot;
                var item = new RadialItem { Id = id, Angle = 0f };
                item.Hover = on =>
                {
                    if (on) commander.HoverRingSlot = slot;
                    else if (commander.HoverRingSlot == slot) commander.HoverRingSlot = 0;
                };
                if (locked)
                {
                    item.Icon = "lock"; item.Title = $"Site {slot % 16} · locked";
                    item.Caption = () => Tier(parcelTier);
                    item.Enabled = () => false;
                    item.Reason = () => $"Unlocks at base Tier {Tier(parcelTier)}";
                }
                else if (occupantId != 0)
                {
                    string type = occupant.Type;
                    item.Icon = Icons.BuildingKind(type);
                    item.Title = NameOf("BUILDINGS", type);
                    item.Badge = () => session.Structures.Buildings.TryGetValue(occupantId, out var b) ? b.QueueLength : 0;
                    item.Progress = () =>
                    {
                        if (!session.Structures.Buildings.TryGetValue(occupantId, out var b)) return -1f;
                        if (!b.Done) return b.Progress / 100f;
                        if (b.Project != null || b.WorksKind != null) return b.WorksPct / 100f;
                        if (b.QueueLength > 0) return b.TrainProgress / 100f;
                        return -1f;
                    };
                    item.Detail = () =>
                    {
                        if (!session.Structures.Buildings.TryGetValue(occupantId, out var b)) return "";
                        if (!b.Done) return $"Construction {b.Progress}%";
                        if (b.QueueLength > 0) return $"{b.QueueLength} in queue";
                        return b.Hp < 100 ? $"Condition {b.Hp}%" : "Open its command wheel";
                    };
                    item.Click = _ => commander.SelectRingSlot(siteId, slot);
                }
                else if (empty)
                {
                    item.Icon = "plus"; item.Title = $"Site {slot % 16} · empty"; item.Pulse = true;
                    item.Detail = () => "Choose a facility to build here";
                    item.Click = _ => { commander.SelectRingSlot(siteId, slot); OpenBuildPicker(siteId, slot); };
                }
                else
                {
                    item.Icon = "plus"; item.Title = $"Site {slot % 16}";
                    item.Enabled = () => false;
                    item.Reason = () => "Site not available";
                }
                socketParcels[id] = parcel;
                socketItems.Add(item);
                list.Add(item);
            }
            return list;
        }

        /// <summary>Point each socket wedge at its parcel: greedy nearest-angle assignment of parcels to the 8 wedge angles.</summary>
        // per-frame socket assignment scratch (no allocations: the camera moves every frame)
        readonly List<(float cost, int item, int wedge)> anglePairs = new List<(float, int, int)>(96);
        bool[] angleItemDone = new bool[16];
        readonly bool[] angleWedgeDone = new bool[8];
        static readonly Func<bool> NoWedge = () => false;

        /// <summary>
        /// Point each socket wedge at its parcel: greedy nearest-angle assignment of parcels to the 8 wedge angles.
        /// Also sizes the base wheel to the base on screen: a little larger when the camera is close.
        /// </summary>
        void AssignSocketAngles(ObjectiveSite site)
        {
            if (socketItems.Count == 0) return;
            float hx = site.X, hz = site.Z;
            if (session.Structures.Buildings.TryGetValue(site.Headquarters, out var hq) && hq.HasPosition) { hx = hq.X; hz = hq.Z; }
            var centre = commander.WorldToScreen(hx, hz, .3f);
            if (centre.z <= 0) return;
            var hub = ToPanel(centre);
            var pairs = anglePairs;
            pairs.Clear();
            float reach = 0f;
            for (int i = 0; i < socketItems.Count; i++)
            {
                if (!socketParcels.TryGetValue(socketItems[i].Id, out var parcel)) continue;
                var sp = commander.WorldToScreen(parcel.X, parcel.Z, 0f);
                var d = sp.z > 0 ? ToPanel(sp) - hub : Vector2.up;
                if (sp.z > 0) reach = Mathf.Max(reach, d.magnitude);
                float bearing = Mathf.Atan2(d.x, -d.y) * Mathf.Rad2Deg;
                for (int w = 0; w < 8; w++)
                {
                    // insertion keeps the list sorted by cost (stable; ≤ 8 × sockets entries, no comparer allocation)
                    var entry = (Mathf.Abs(Mathf.DeltaAngle(bearing, w * 45f)), i, w);
                    int at = pairs.Count;
                    while (at > 0 && pairs[at - 1].cost > entry.Item1) at--;
                    pairs.Insert(at, entry);
                }
            }
            if (angleItemDone.Length < socketItems.Count) angleItemDone = new bool[socketItems.Count * 2];
            Array.Clear(angleItemDone, 0, angleItemDone.Length);
            Array.Clear(angleWedgeDone, 0, angleWedgeDone.Length);
            bool changed = false;
            for (int k = 0; k < pairs.Count; k++)
            {
                var (_, item, w) = pairs[k];
                if (angleItemDone[item] || angleWedgeDone[w]) continue;
                angleItemDone[item] = angleWedgeDone[w] = true;
                var it = socketItems[item];
                float angle = w * 45f;
                if (it.Angle != angle || it.Visible != null) changed = true;
                it.Angle = angle;
                it.Visible = null;
            }
            for (int i = 0; i < socketItems.Count; i++)
            {
                if (angleItemDone[i]) continue;
                var it = socketItems[i];
                if (it.Visible != NoWedge) changed = true;
                it.Visible = NoWedge;   // more parcels than wedges: the extra one has no wedge
            }
            if (changed) wheel.InvalidateLayout();
            // the base's on-screen radius → wheel size: 1× when the base is small on screen, up to 1.25× close in
            if (reach > 0f) wheel.Scale = Mathf.Clamp(1f + (reach - 170f) / 900f, 1f, 1.25f);
        }

        RadialItem BaseHub(ObjectiveSite site)
        {
            int siteId = site.Id;
            BuildingRecord Hq() => session.Objectives.TryGetValue(siteId, out var s) && session.Structures.Buildings.TryGetValue(s.Headquarters, out var b) ? b : default;
            var next = site.Tier < 3 ? Defs?["AGES"]?[site.Tier] : null;
            return new RadialItem
            {
                Id = "hub:tier", Icon = "hq", Hotkey = "U",
                Name = () => session.Objectives.TryGetValue(siteId, out var s) && s.Tier < 3 ? $"Upgrade to Tier {TierLabels[Mathf.Clamp(s.Tier, 0, 2)]}" : "Tier III headquarters",
                Cost = next?["cost"], Seconds = ProtocolDecoder.Int(next?["time"]),
                Enabled = () => session.Objectives.TryGetValue(siteId, out var s) && s.Tier < 3 && Hq().Project == null,
                Reason = () =>
                {
                    if (!session.Objectives.TryGetValue(siteId, out var s)) return "";
                    if (s.Tier >= 3) return "Maximum tier reached";
                    var h = Hq();
                    if (h.Project == "tier") return $"Upgrading · {h.WorksPct}%";
                    if (h.Project != null) return "The headquarters is busy";
                    return null;
                },
                Detail = () =>
                {
                    if (!session.Objectives.TryGetValue(siteId, out var s) || s.Tier >= 3) return "All eight sites are unlocked";
                    return $"Unlocks 2 sites and Tier {TierLabels[Mathf.Clamp(s.Tier, 0, 2)]} units";
                },
                Progress = () => Hq().Project == "tier" ? Hq().WorksPct / 100f : -1f,
                Click = _ => Send(new JObject { ["c"] = "advance", ["site"] = siteId }, "Upgrade started"),
            };
        }

        int[] TrainersAt(int siteId) => session.Structures.Buildings.Values
            .Where(b => b.City == siteId && b.Owner == session.CivId && b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray)
            .Select(b => b.Id).ToArray();

        /// <summary>Allocation-free <c>TrainersAt(siteId).Length &gt; 0</c> (polled by the outer arc's visibility at 10 Hz).</summary>
        bool HasTrainersAt(int siteId)
        {
            var defs = Defs?["BUILDINGS"];
            foreach (var b in session.Structures.Buildings.Values)
                if (b.City == siteId && b.Owner == session.CivId && b.Done && defs?[b.Type]?["trains"] is JArray) return true;
            return false;
        }

        List<RadialItem> BaseOuterArc(ObjectiveSite site)
        {
            int siteId = site.Id;
            BuildingRecord Hq() => session.Objectives.TryGetValue(siteId, out var s) && session.Structures.Buildings.TryGetValue(s.Headquarters, out var b) ? b : default;
            JObject PerimeterCost()
            {
                var def = Defs?["CITY_DEFENSES"];
                int missing = session.Objectives.TryGetValue(siteId, out var s) ? Mathf.Clamp(6 - s.DefenseCount, 0, 6) : 6;
                return new JObject
                {
                    ["materials"] = Mathf.CeilToInt(ProtocolDecoder.Float(def?["cost"]?["materials"], 240) * missing / 6f),
                    ["energy"] = Mathf.CeilToInt(ProtocolDecoder.Float(def?["cost"]?["energy"], 60) * missing / 6f)
                };
            }
            var perimeter = new RadialItem
            {
                Id = "arc:perimeter", Icon = "sandbags", Seconds = ProtocolDecoder.Int(Defs?["CITY_DEFENSES"]?["time"], 25),
                Cost = PerimeterCost(),
                Name = () => session.Objectives.TryGetValue(siteId, out var s) && s.DefenseCount > 0 ? $"Rebuild perimeter ({s.DefenseCount}/6)" : "Build city perimeter",
                Detail = () => "Four sandbag positions and two machine-gun turrets. Uses no sites.",
                Visible = () => session.Objectives.TryGetValue(siteId, out var s) && s.DefenseCount < 6,
                Enabled = () => Hq().Project == null,
                Reason = () => Hq().Project == "perimeter" ? $"Under construction · {Hq().WorksPct}%" : Hq().Project != null ? "The headquarters is busy" : null,
                Click = _ => Send(new JObject { ["c"] = "baseDefenses", ["site"] = siteId }, "Construction started"),
            };
            return new List<RadialItem>
            {
                new RadialItem
                {
                    Id = "arc:defenses", Icon = "defense", Title = "Defenses",
                    Detail = () => "Place field defenses anywhere on visible ground",
                    Click = _ => OpenDefensePicker(siteId),
                },
                perimeter,
                new RadialItem
                {
                    Id = "arc:rally", Icon = "rally", Title = "Rally point",
                    Detail = () => "Click the ground where new units from this base gather",
                    Visible = () => HasTrainersAt(siteId),
                    Click = _ => commander.Begin(Commander.Mode.Rally),
                },
                new RadialItem
                {
                    Id = "arc:production", Icon = "barracks", Title = "Production",
                    Detail = () => "Select every production facility at this base",
                    Visible = () => HasTrainersAt(siteId),
                    Click = _ => commander.SelectProduction(TrainersAt(siteId)),
                },
                new RadialItem
                {
                    Id = "arc:repair", Icon = "repair", Title = "Repair headquarters",
                    Visible = () => Hq().RepairCost > 0,
                    Enabled = () => Hq().Project == null,
                    Reason = () => Hq().Project != null ? "The headquarters is busy" : $"Costs {Hq().RepairCost} Materials",
                    Click = _ => Send(new JObject { ["c"] = "repair", ["id"] = Hq().Id }, "Repairs started"),
                },
            };
        }

        void OpenRuinWheel(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            ClosePicker();
            wheelKind = "ruin"; wheelSite = siteId;
            JToken cost = ProtocolDecoder.Int(Econ?["recovery"]) > 0 ? new JObject { ["materials"] = 140 } : Defs?["BUILDINGS"]?["town"]?["cost"];
            var establish = new RadialItem
            {
                Id = "establish", Icon = "hq", Title = "Establish base", Cost = cost, Seconds = ProtocolDecoder.Int(Defs?["BUILDINGS"]?["town"]?["time"]),
                Detail = () => ProtocolDecoder.Str(SiteDefinition(site)?["bonus"], "Build a headquarters on this ruin"),
                Enabled = () => session.Objectives.TryGetValue(siteId, out var s) && !s.Contested,
                Reason = () => session.Objectives.TryGetValue(siteId, out var s) && s.Contested ? "Contested · clear hostile ground forces" : null,
                Click = _ => Send(new JObject { ["c"] = "establish", ["site"] = siteId }, "Construction started"),
            };
            wheel.Open(site.Name, "house", new List<RadialItem> { establish }, WorldAnchor(site.X, site.Z, .3f));
            wheel.SubjectDetail = () => "Secured ruin";
        }

        // ------------------------------------------------------------------ build / defense pickers (B7)
        void SocketPickerFromSelection()
        {
            int slot = commander.SelectedRingSlot;
            if (slot == 0 || !session.Objectives.TryGetValue(wheelSite, out var site)) return;
            if (site.Slots == null || Array.IndexOf(site.Slots, slot) < 0) return;
            if (pickerKind == "build" && pickerSlot == slot) return;
            OpenBuildPicker(wheelSite, slot);
        }

        VisualElement OpenPickerPanel(string kind, string title)
        {
            if (picker == null)
            {
                picker = UiKit.El("se-cmd-picker");
                picker.style.position = Position.Absolute;
                picker.style.width = 352;
                picker.style.left = 0; picker.style.top = 0;
                picker.usageHints = UsageHints.DynamicTransform;   // hints before attaching
                commandLayer.Add(picker);
                var header = UiKit.El("se-cmd-picker-head", picker);
                header.style.flexDirection = FlexDirection.Row; header.style.alignItems = Align.Center; header.style.height = 36;
                pickerTitle = UiKit.Text("", "se-cmd-picker-title", header);
                pickerTitle.style.flexGrow = 1; pickerTitle.style.overflow = Overflow.Hidden; pickerTitle.style.textOverflow = TextOverflow.Ellipsis; pickerTitle.style.whiteSpace = WhiteSpace.NoWrap;
                UiKit.IconButton("close", ClosePicker, "Close (Esc)", header, 28);
                pickerGrid = UiKit.El("se-cmd-picker-grid", picker);
                pickerGrid.style.flexDirection = FlexDirection.Row; pickerGrid.style.flexWrap = Wrap.Wrap;
            }
            pickerTiles.Clear();
            pickerGrid.Clear();
            pickerKind = kind;
            pickerTitle.text = title;
            picker.style.display = DisplayStyle.Flex;
            picker.BringToFront();
            return pickerGrid;
        }

        void ClosePicker()
        {
            if (pickerKind == "") return;
            string kind = pickerKind;
            int site = pickerSite;
            pickerKind = ""; pickerSlot = 0;
            pickerTiles.Clear();
            if (picker != null) picker.style.display = DisplayStyle.None;
            commander.ClearRingPreview();
            if (kind == "build" && commander.SelectedRingSlot != 0 && commander.SelectedObjective == site) commander.SelectObjective(site);
        }

        float pickerRefreshAt;
        Vector2 pickerAt = new Vector2(float.NaN, float.NaN);
        int pickerSlotIdFor;
        string pickerSlotId;

        void UpdatePicker(Rect safe)
        {
            if (pickerKind == "" || picker == null) return;
            if (!wheel.IsOpen || wheel.style.display == DisplayStyle.None) { picker.style.visibility = Visibility.Hidden; return; }
            picker.style.visibility = Visibility.Visible;
            // tile states (locks, shortfalls) follow the economy: 10 Hz is plenty (tiles refresh on build too)
            if (Time.unscaledTime >= pickerRefreshAt)
            {
                pickerRefreshAt = Time.unscaledTime + .1f;
                foreach (var tile in pickerTiles) tile.refresh();
            }
            float w = 352, h = picker.resolvedStyle.height;
            if (float.IsNaN(h) || h < 60) h = pickerKind == "build" ? 404 : 344;
            var c = wheel.Centre;
            float k = wheel.CurrentScale;
            float left, top;
            if (pickerKind == "build")
            {
                if (pickerSlotId == null || pickerSlotIdFor != pickerSlot) { pickerSlotIdFor = pickerSlot; pickerSlotId = "socket:" + pickerSlot; }
                string id = pickerSlotId;
                float angle = wheel.AngleOf(id);
                var icon = wheel.IconPosition(id);
                bool right = !float.IsNaN(angle) && Mathf.Repeat(angle, 360f) > 0f && Mathf.Repeat(angle, 360f) < 180f;
                left = right ? c.x + 148 * k : c.x - 148 * k - w;
                top = icon.y - h * .5f;
            }
            else
            {
                left = c.x + 210 * k + w <= safe.xMax ? c.x + 210 * k : c.x - 210 * k - w;
                top = c.y - h * .5f;
            }
            left = Mathf.Clamp(left, safe.xMin, Mathf.Max(safe.xMin, safe.xMax - w));
            top = Mathf.Clamp(top, safe.yMin, Mathf.Max(safe.yMin, safe.yMax - h));
            // moved with a transform (it follows the wheel every frame): no layout pass
            var at = new Vector2(left, top);
            if (!((at - pickerAt).sqrMagnitude <= .0001f)) { pickerAt = at; picker.style.translate = new Translate(left, top); }
        }

        /// <summary>One picker tile: icon, name, cost row (or the lock reason), digit, lock glyph. Disabled tiles stay hoverable.</summary>
        void PickerTile(VisualElement grid, string icon, string title, JToken cost, Func<string> lockReason, Action pick, Action<bool> hover, float width, float height, float iconSize, string tooltip)
        {
            int index = pickerTiles.Count;
            var tile = new Button { text = "" };
            tile.AddToClassList("se-cmd-tile");
            tile.style.width = width; tile.style.height = height;
            tile.style.marginRight = (index + 1) % (width > 90 ? 3 : 4) == 0 ? 0 : 8;
            tile.style.marginBottom = 8; tile.style.marginLeft = 0; tile.style.marginTop = 0;
            tile.style.paddingLeft = 4; tile.style.paddingRight = 4; tile.style.paddingTop = 0; tile.style.paddingBottom = 0;
            tile.style.flexDirection = FlexDirection.Column; tile.style.alignItems = Align.Center;
            if (!string.IsNullOrEmpty(tooltip)) tile.tooltip = tooltip;
            var digit = UiKit.Text(index < 9 ? (index + 1).ToString() : "", "se-cmd-tile-digit", tile);
            digit.style.position = Position.Absolute; digit.style.left = 4; digit.style.top = 2;
            var lockIcon = new IconElement("lock", "se-cmd-tile-lock");
            lockIcon.style.position = Position.Absolute; lockIcon.style.right = 4; lockIcon.style.top = 4; lockIcon.style.width = 12; lockIcon.style.height = 12;
            tile.Add(lockIcon);
            var glyph = new IconElement(icon, "se-cmd-tile-icon");
            glyph.style.width = iconSize; glyph.style.height = iconSize; glyph.style.marginTop = width > 90 ? 10 : 8; glyph.style.flexShrink = 0;
            tile.Add(glyph);
            var name = UiKit.Text(title, "se-cmd-tile-name", tile);
            name.style.whiteSpace = WhiteSpace.Normal; name.style.unityTextAlign = TextAnchor.MiddleCenter;
            name.style.height = width > 90 ? 30 : 26; name.style.overflow = Overflow.Hidden;
            var footer = UiKit.El("se-cmd-tile-footer", tile);
            footer.style.flexDirection = FlexDirection.Row; footer.style.justifyContent = Justify.Center; footer.style.alignItems = Align.Center; footer.style.height = 14;
            int materials = Mathf.RoundToInt(ProtocolDecoder.Float(cost?["materials"])), energy = Mathf.RoundToInt(ProtocolDecoder.Float(cost?["energy"]));
            Label CostPart(string res, int amount)
            {
                if (amount <= 0) return null;
                var ic = new IconElement(res, "se-cmd-tile-cost-icon");
                ic.style.width = 11; ic.style.height = 11; ic.style.marginRight = 1;
                footer.Add(ic);
                var l = UiKit.Text(amount.ToString(), "se-cmd-tile-cost", footer);
                l.style.marginRight = 4;
                return l;
            }
            var materialsLabel = CostPart("materials", materials);
            var energyLabel = CostPart("energy", energy);
            var reasonLabel = UiKit.Text("", "se-cmd-tile-reason", footer);
            reasonLabel.style.whiteSpace = WhiteSpace.NoWrap; reasonLabel.style.overflow = Overflow.Hidden; reasonLabel.style.textOverflow = TextOverflow.Ellipsis;
            string lastReason = "\u0001";
            void Refresh()
            {
                string reason = lockReason?.Invoke();
                bool locked = !string.IsNullOrEmpty(reason);
                tile.EnableInClassList("se-cmd-tile--disabled", locked || Shortfall(cost) != null);
                glyph.style.opacity = locked ? .4f : 1f;
                lockIcon.style.display = locked ? DisplayStyle.Flex : DisplayStyle.None;
                if (reason != lastReason)
                {
                    lastReason = reason;
                    reasonLabel.text = reason ?? "";
                    reasonLabel.style.display = locked ? DisplayStyle.Flex : DisplayStyle.None;
                    foreach (var child in footer.Children()) if (child != reasonLabel) child.style.display = locked ? DisplayStyle.None : DisplayStyle.Flex;
                }
                if (materialsLabel != null) materialsLabel.EnableInClassList("se-cmd-short", ResourceHave("materials") < materials);
                if (energyLabel != null) energyLabel.EnableInClassList("se-cmd-short", ResourceHave("energy") < energy);
            }
            void Pick()
            {
                string reason = lockReason?.Invoke() ?? Shortfall(cost);
                if (!string.IsNullOrEmpty(reason)) { commander.Say(reason, false, Time.unscaledTime); return; }
                pick();
            }
            tile.clicked += Pick;
            if (hover != null)
            {
                tile.RegisterCallback<PointerEnterEvent>(_ => hover(true));
                tile.RegisterCallback<PointerLeaveEvent>(_ => hover(false));
            }
            grid.Add(tile);
            Refresh();
            pickerTiles.Add((Pick, Refresh));
        }

        void OpenBuildPicker(int siteId, int slot)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            var grid = OpenPickerPanel("build", $"Site {slot % 16} · empty");
            pickerSite = siteId; pickerSlot = slot;
            foreach (string type in Facilities)
            {
                var d = Defs?["BUILDINGS"]?[type];
                if (d == null) continue;
                string facility = type;
                int tier = ProtocolDecoder.Int(d["tier"], 1);
                string needs = ProtocolDecoder.Str(d["needs"]);
                string Lock()
                {
                    if (tier > Age + 1) return $"Tier {Tier(tier)}";
                    if (!string.IsNullOrEmpty(needs) && !session.Structures.Buildings.Values.Any(b => b.City == siteId && b.Owner == session.CivId && b.Type == needs && b.Done))
                        return "Needs " + ShortName(needs);
                    if (!session.Objectives.TryGetValue(siteId, out var s) || s.Slots == null || Array.IndexOf(s.Slots, slot) < 0) return "Site taken";
                    return null;
                }
                string tip = NameOf("BUILDINGS", type) + "\n" + ProtocolDecoder.Str(d["desc"], "") + $" {ProtocolDecoder.Int(d["time"])} s." +
                    (tier > 1 ? $" Requires faction Tier {Tier(tier)}." : "") + (string.IsNullOrEmpty(needs) ? "" : $" Requires {NameOf("BUILDINGS", needs)} at this base.");
                PickerTile(grid, Icons.BuildingKind(type), NameOf("BUILDINGS", type), d["cost"], Lock,
                    () => { commander.BuildRingFacility(siteId, slot, facility); ClosePicker(); },
                    on => { if (on && Lock() == null) commander.PreviewRingFacility(siteId, slot, facility); else commander.ClearRingPreview(); },
                    104, 104, 36, tip);
            }
        }

        string ShortName(string type) => type switch
        {
            "advanced_lab" => "Adv. Lab", "heavy_weapons" => "Heavy Weapons", "motor_works" => "Vehicle Works", "missile_silo" => "Missile Facility",
            _ => NameOf("BUILDINGS", type)
        };

        void OpenDefensePicker(int siteId)
        {
            var grid = OpenPickerPanel("defense", "Defenses");
            pickerSite = siteId; pickerSlot = 0;
            if (session.Objectives.TryGetValue(siteId, out var site) && site.DefenseCount < 6)
            {
                var def = Defs?["CITY_DEFENSES"];
                int missing = 6 - site.DefenseCount;
                var cost = new JObject
                {
                    ["materials"] = Mathf.CeilToInt(ProtocolDecoder.Float(def?["cost"]?["materials"], 240) * missing / 6f),
                    ["energy"] = Mathf.CeilToInt(ProtocolDecoder.Float(def?["cost"]?["energy"], 60) * missing / 6f)
                };
                PickerTile(grid, "sandbags", "City perimeter", cost,
                    () => session.Structures.Buildings.TryGetValue(site.Headquarters, out var hq) && hq.Project != null ? "HQ busy" : null,
                    () => { Send(new JObject { ["c"] = "baseDefenses", ["site"] = siteId }, "Construction started"); ClosePicker(); },
                    null, 76, 88, 28, "City perimeter\nFour sandbag positions and two machine-gun turrets. Uses no sites.");
            }
            foreach (string type in Defenses)
            {
                var d = Defs?["BUILDINGS"]?[type];
                if (d == null) continue;
                string defense = type;
                int tier = ProtocolDecoder.Int(d["tier"], 1);
                PickerTile(grid, Icons.BuildingKind(type), NameOf("BUILDINGS", type), d["cost"],
                    () => tier > Age + 1 ? $"Tier {Tier(tier)}" : null,
                    () => { ClosePicker(); commander.BeginFieldConstruction(defense); },
                    null, 76, 88, 28, DefenseTooltip(type));
            }
        }

        // ------------------------------------------------------------------ building wheel (B8)
        BuildingRecord[] OwnBuildings(int[] ids)
        {
            var list = new List<BuildingRecord>(ids.Length);
            foreach (int id in ids) if (session.Structures.Buildings.TryGetValue(id, out var b) && b.Owner == session.CivId) list.Add(b);
            return list.ToArray();
        }

        string BuildingStructure(int[] ids)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(Age).Append('|').Append((Econ?["techs"] as JArray)?.Count ?? 0).Append('|').Append((Econ?["groups"] as JArray)?.Count ?? 0).Append('|');
            foreach (var b in OwnBuildings(ids))
                sb.Append(b.Id).Append(b.Done ? 'd' : 'u').Append(b.Missiles > 0 ? 'm' : '-').Append(b.Project != null ? 'p' : '-').Append(b.RepairCost > 0 ? 'r' : '-').Append(',');
            return sb.ToString();
        }

        void OpenBuildingWheel(int[] ids)
        {
            var own = OwnBuildings(ids);
            if (own.Length == 0) return;
            ClosePicker();
            wheelKind = "building"; wheelBuildings = ids; wheelSite = own[0].City;
            wheelStructure = BuildingStructure(ids);
            wheelStructureSnap = session.Snapshots;
            var first = own[0];
            string title = own.Length == 1 ? NameOf("BUILDINGS", first.Type) : own.All(b => b.Type == first.Type) ? $"{own.Length} × {NameOf("BUILDINGS", first.Type)}" : $"{own.Length} facilities";
            Func<Vector2?> anchor;
            if (own.Length == 1 && first.HasPosition) anchor = WorldAnchor(first.X, first.Z, .3f);
            else
            {
                // several buildings: anchor on their centre (wrap-aware relative to the first)
                float sx = 0, sz = 0; int n = 0;
                foreach (var b in own) if (b.HasPosition) { sx += first.X + session.World.Grid.DxWrap(first.X, b.X); sz += b.Z; n++; }
                anchor = n > 0 ? WorldAnchor(sx / n, sz / n, .3f) : (() => (Vector2?)null);
            }
            int[] idsCopy = ids;
            wheel.Open(title, Icons.BuildingKind(first.Type), BuildingItems(ids), anchor);
            wheel.SubjectDetail = () =>
            {
                var current = OwnBuildings(idsCopy);
                if (current.Length == 0) return "";
                if (current.Any(b => !b.Done)) return $"Construction {current.First(b => !b.Done).Progress}%";
                int queued = current.Sum(b => b.QueueLength);
                if (queued > 0) return $"{queued} in queue";
                var busy = current.FirstOrDefault(b => b.Project != null);
                if (busy.Id != 0) return $"{ProjectName(busy.Project)} {busy.WorksPct}%";
                return $"Condition {current.Min(b => b.Hp)}%";
            };
        }

        List<RadialItem> BuildingItems(int[] ids)
        {
            var items = new List<RadialItem>();
            var own = OwnBuildings(ids);
            if (own.Length == 0) return items;
            int[] all = own.Select(b => b.Id).ToArray();
            var trainers = own.Where(b => b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray).Select(b => b.Id).ToArray();
            // 1. training, one wedge per unit type across the selection
            var types = new List<string>();
            foreach (var b in own)
                if (b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray trains)
                    foreach (var t in trains) { string key = (string)t; if (!types.Contains(key)) types.Add(key); }
            foreach (string type in types) items.Add(TrainItem(type, trainers));
            // 2. upgrades (Armory techs, Barracks upgrades)
            var hostTypes = new HashSet<string>(own.Where(b => b.Done).Select(b => b.Type));
            if (Defs?["TECHS"] is JObject techs && techs.Properties().Any(p => hostTypes.Contains(ProtocolDecoder.Str(p.Value["at"], "armory"))))
                items.Add(new RadialItem
                {
                    Id = "upgrades", Icon = "upgrade", Title = "Upgrades",
                    Detail = () => hostTypes.Contains("barracks") && !hostTypes.Contains("armory") ? "Infantry equipment" : "Faction-wide military upgrades",
                    Children = () => TechItems(all, hostTypes),
                });
            // 3. rally
            if (trainers.Length > 0)
                items.Add(new RadialItem
                {
                    Id = "rally", Icon = "rally", Title = "Rally point",
                    Detail = () => "Click the ground where new units gather (right-click also sets it)",
                    Click = _ => commander.Begin(Commander.Mode.Rally),
                });
            // 4. reinforce a control group
            if (trainers.Length > 0 && Econ?["groups"] is JArray savedGroups && savedGroups.Count > 0)
                items.Add(new RadialItem
                {
                    Id = "reinforce", Icon = "army", Title = "Reinforce group",
                    Detail = () => "New units from here join a control group",
                    Children = () => GroupItems(trainers),
                });
            // 5. repair
            items.Add(new RadialItem
            {
                Id = "repair", Icon = "repair", Title = "Repair",
                Visible = () => OwnBuildings(all).Any(b => b.Done && b.RepairCost > 0),
                Cost = new JObject { ["materials"] = own.Where(b => b.Done && b.Project == null).Sum(b => b.RepairCost) },
                Enabled = () => OwnBuildings(all).Any(b => b.Done && b.RepairCost > 0 && b.Project == null),
                Reason = () => "The facility is busy",
                Click = _ =>
                {
                    foreach (var b in OwnBuildings(all)) if (b.Done && b.RepairCost > 0 && b.Project == null)
                        Send(new JObject { ["c"] = "repair", ["id"] = b.Id }, "Repairs started");
                },
            });
            // 6. strategic missile
            var silo = own.FirstOrDefault(b => b.Type == "missile_silo" && b.Done);
            if (silo.Id != 0)
            {
                int siloId = silo.Id;
                if (silo.Missiles > 0)
                    items.Add(new RadialItem
                    {
                        Id = "launch", Icon = "missile_launch", Title = "Launch missile", Confirm = true,
                        Detail = () => "Choose a strategic target on the map",
                        Click = _ => commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "missileLaunch", ["id"] = siloId, ["tile"] = "@map" }),
                    });
                else
                    items.Add(new RadialItem
                    {
                        Id = "missile", Icon = "silo", Title = "Build missile", Cost = Defs?["MISSILE"]?["cost"], Seconds = ProtocolDecoder.Int(Defs?["MISSILE"]?["time"]),
                        Enabled = () => session.Structures.Buildings.TryGetValue(siloId, out var s) && s.Project == null,
                        Reason = () => session.Structures.Buildings.TryGetValue(siloId, out var s) && s.Project != null ? $"Assembling · {s.WorksPct}%" : null,
                        Progress = () => session.Structures.Buildings.TryGetValue(siloId, out var s) && s.Project != null ? s.WorksPct / 100f : -1f,
                        Click = _ => Send(new JObject { ["c"] = "missileBuild", ["id"] = siloId }, "Construction started"),
                    });
            }
            // 7. demolish (two-step)
            if (own.Any(b => b.Type != "town"))
            {
                int refund = own.Where(b => b.Type != "town").Sum(b => Mathf.FloorToInt(ProtocolDecoder.Float(Defs?["BUILDINGS"]?[b.Type]?["cost"]?["materials"]) * .35f));
                items.Add(new RadialItem
                {
                    Id = "demolish", Icon = "demolish", Title = own.Length == 1 ? "Demolish" : $"Demolish {own.Length}", Confirm = true,
                    Detail = () => $"Refund {refund} Materials · the site becomes free",
                    Enabled = () => DemolishBlock(all) == null,
                    Reason = () => DemolishBlock(all),
                    Click = _ =>
                    {
                        foreach (var b in OwnBuildings(all))
                            if (b.Type != "town" && b.Done && b.QueueLength == 0 && b.Project == null)
                                Send(new JObject { ["c"] = "demolish", ["id"] = b.Id }, "Demolished");
                    },
                });
            }
            return items;
        }

        string DemolishBlock(int[] ids)
        {
            var own = OwnBuildings(ids);
            if (own.Length == 0) return "Nothing to demolish";
            if (own.All(b => b.Type == "town")) return "Headquarters cannot be demolished";
            if (own.All(b => !b.Done)) return "Still under construction";
            if (own.All(b => b.QueueLength > 0)) return "Cancel training first";
            if (own.All(b => b.Project != null)) return "Wait for the current project";
            return null;
        }

        RadialItem TrainItem(string type, int[] trainers)
        {
            var d = Defs?["UNITS"]?[type];
            int tier = ProtocolDecoder.Int(d?["tier"], 1);
            string facility = ProtocolDecoder.Str(d?["facility"]);
            BuildingRecord[] Hosts() => OwnBuildings(trainers).Where(b => b.Done && b.Type == facility).ToArray();
            return new RadialItem
            {
                Id = "train:" + type, Icon = type, Title = NameOf("UNITS", type), Cost = d?["cost"], Seconds = ProtocolDecoder.Int(d?["time"]),
                Detail = () => UnitRole(type) + $" · {ProtocolDecoder.Int(d?["capacity"])} command",
                Enabled = () => tier <= Age + 1 && Hosts().Length > 0,
                Reason = () => tier > Age + 1 ? $"Requires Tier {Tier(tier)}" : Hosts().Length == 0 ? "Needs " + NameOf("BUILDINGS", facility) : "Shift ×5 · right-click cancels · Ctrl repeats",
                Badge = () =>
                {
                    int n = 0;
                    foreach (var b in Hosts()) if (b.Queue != null) foreach (var q in b.Queue) if (q == type) n++;
                    return n;
                },
                Progress = () =>
                {
                    float best = -1f;
                    foreach (var b in Hosts()) if (b.Queue != null && b.Queue.Length > 0 && b.Queue[0] == type) best = Mathf.Max(best, b.TrainProgress / 100f);
                    return best;
                },
                Active = () => Hosts().Any(b => b.Repeat == type),
                Click = c =>
                {
                    var hosts = Hosts();
                    if (hosts.Length == 0) return;
                    if (c.Ctrl)
                    {
                        bool on = !hosts.Any(b => b.Repeat == type);
                        foreach (var b in hosts)
                            session.Net?.Command(new JObject { ["c"] = "repeat", ["id"] = b.Id, ["unit"] = on ? type : null },
                                r => { if (r.Error != null) commander.Say(r.Error, false, Time.unscaledTime); });
                        return;
                    }
                    int count = c.Shift ? 5 : 1;
                    session.Net?.Command(new JObject { ["c"] = "batchTrain", ["buildings"] = new JArray(hosts.Select(b => b.Id).ToArray()), ["unit"] = type, ["count"] = count }, r =>
                    {
                        int n = ProtocolDecoder.Int(r.Raw?["training"]?["queued"], count);
                        string why = ProtocolDecoder.Str(r.Raw?["training"]?["reason"], "");
                        if (r.Error != null) commander.Say(r.Error, false, Time.unscaledTime);
                        else if (n <= 0 && why.Length > 0) commander.Say(why, false, Time.unscaledTime);
                        else commander.Say($"{n} queued", true, Time.unscaledTime);
                        cmdCardSignature = "";
                    });
                },
                RightClick = () =>
                {
                    foreach (var b in Hosts())
                    {
                        if (b.Queue == null) continue;
                        int index = Array.LastIndexOf(b.Queue, type);
                        if (index < 0) continue;
                        Send(new JObject { ["c"] = "cancelTrain", ["id"] = b.Id, ["index"] = index }, "Queue entry cancelled");
                        return;
                    }
                },
            };
        }

        List<RadialItem> TechItems(int[] ids, HashSet<string> hostTypes)
        {
            var list = new List<RadialItem>();
            if (!(Defs?["TECHS"] is JObject options)) return list;
            foreach (var option in options.Properties())
            {
                var d = option.Value;
                string key = option.Name, at = ProtocolDecoder.Str(d["at"], "armory");
                if (!hostTypes.Contains(at)) continue;
                int tier = ProtocolDecoder.Int(d["tier"], 1);
                BuildingRecord Host()
                {
                    var hosts = OwnBuildings(ids).Where(b => b.Done && b.Type == at).ToArray();
                    var idle = hosts.FirstOrDefault(b => b.Project == null);
                    return idle.Id != 0 ? idle : hosts.FirstOrDefault();
                }
                JToken Active() => (Econ?["research"] as JArray)?.FirstOrDefault(t => ProtocolDecoder.Str(t["key"]) == key);
                bool Complete() => Techs().Contains(key);
                list.Add(new RadialItem
                {
                    Id = "tech:" + key, Title = NameOf("TECHS", key), Cost = d["cost"], Seconds = ProtocolDecoder.Int(d["time"]),
                    Icon = Complete() ? "check" : "upgrade",
                    Detail = () => ProtocolDecoder.Str(d["desc"], ""),
                    Enabled = () => !Complete() && Active() == null && tier <= Age + 1 && Host().Id != 0 && Host().Project == null,
                    Reason = () =>
                    {
                        if (Complete()) return "Complete";
                        var running = Active();
                        if (running != null) return $"Researching · {ProtocolDecoder.Int(running["progress"])}%";
                        if (tier > Age + 1) return $"Requires Tier {Tier(tier)}";
                        if (Host().Id == 0) return "Needs " + NameOf("BUILDINGS", at);
                        if (Host().Project != null) return "The facility is busy";
                        return null;
                    },
                    Progress = () => { var running = Active(); return running != null ? ProtocolDecoder.Int(running["progress"]) / 100f : -1f; },
                    Click = _ => Send(new JObject { ["c"] = "research", ["tech"] = key, ["id"] = Host().Id }, "Upgrade started"),
                });
            }
            return list;
        }

        List<RadialItem> GroupItems(int[] trainers)
        {
            var list = new List<RadialItem>();
            if (!(Econ?["groups"] is JArray groups)) return list;
            foreach (var group in groups)
            {
                int id = ProtocolDecoder.Int(group["id"]);
                int members = (group["units"] as JArray)?.Count ?? 0;
                if (id <= 0 || members == 0) continue;
                list.Add(new RadialItem
                {
                    Id = "group:" + id, Icon = "army", Title = $"Group {id}", Caption = () => id.ToString(),
                    Detail = () => $"{members} units · new recruits join this group",
                    Active = () => OwnBuildings(trainers).Any(b => b.RallyGroup == id),
                    Click = _ => Send(new JObject { ["c"] = "rallyGroup", ["buildings"] = new JArray(trainers), ["group"] = id }, "Rally point set"),
                });
            }
            return list;
        }

        // ------------------------------------------------------------------ unit wheel (B9)
        static string AbilityGlyph(string ability) => ability switch
        {
            "cover" => "cover", "repair" => "repair", "scan" => "scan", "focused_fire" => "focus_fire", "bombard" => "bombard",
            "intercept" => "intercept", "patrol" => "patrol", "strike" => "strike", "infiltrate" => "infiltrate", _ => "focus_fire"
        };

        void OpenUnitWheel(bool keyboard)
        {
            if (session.Spectator || units.Selected.Count == 0) return;
            var selected = units.Selected.Where(id => session.Units.TryGet(id, out _)).ToArray();
            if (selected.Length == 0) return;
            var typeNames = selected.Select(id => { session.Units.TryGet(id, out var u); return session.Units.Types.Name(u.TypeIndex); }).ToArray();
            var groups = typeNames.GroupBy(t => t).OrderByDescending(g => g.Count()).ToArray();
            string main = groups[0].Key;
            var types = groups.Select(g => g.Key).ToArray();
            ClosePicker();
            wheelKind = "unit"; wheelSite = 0; wheelBuildings = Array.Empty<int>(); wheelStructure = "";
            var items = new List<RadialItem>
            {
                new RadialItem { Id = "move", Icon = "move", Title = "Move", Detail = () => "Click a destination · Shift queues",
                    Click = _ => commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map" }) },
                new RadialItem { Id = "attack_move", Icon = "attack_move", Title = "Attack-move", Hotkey = InputFacade.KeyFor("attack").ToString(),
                    Detail = () => "Advance and engage enemies along the route",
                    Click = _ => commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true }) },
                new RadialItem { Id = "hold", Icon = "hold", Title = "Hold position", Hotkey = InputFacade.KeyFor("hold").ToString(),
                    Detail = () => "Stop and defend this position",
                    Click = _ => commander.UnitCommand("hold", null, "Holding position") },
                new RadialItem { Id = "withdraw", Icon = "withdraw", Title = "Withdraw", Hotkey = InputFacade.KeyFor("withdraw").ToString(),
                    Detail = () => "Fall back to the nearest friendly headquarters",
                    Click = _ => commander.UnitCommand("withdraw", null, "Retreat ordered") },
            };
            foreach (string ability in types.Select(t => ProtocolDecoder.Str(Defs?["UNITS"]?[t]?["ability"])).Where(a => !string.IsNullOrEmpty(a)).Distinct())
            {
                var d = Defs?["ABILITIES"]?[ability];
                if (d == null) continue;
                string name = ProtocolDecoder.Str(d["name"], ability), abilityKey = ability;
                float total = Mathf.Max(1f, ProtocolDecoder.Float(d["cooldown"], 25f));
                var holders = selected.Where(id => session.Units.TryGet(id, out var u) && ProtocolDecoder.Str(Defs?["UNITS"]?[session.Units.Types.Name(u.TypeIndex)]?["ability"]) == abilityKey).ToArray();
                float Ready()
                {
                    float ready = float.MaxValue;
                    foreach (int id in holders) if (session.Units.TryGet(id, out var u)) ready = Mathf.Min(ready, u.Motion.Cooldown);
                    return ready == float.MaxValue ? 0f : ready;
                }
                bool point = ProtocolDecoder.Bool(d["point"]);
                items.Add(new RadialItem
                {
                    Id = "ability:" + abilityKey, Icon = AbilityGlyph(abilityKey), Title = name,
                    Detail = () => ProtocolDecoder.Str(d["desc"], ""),
                    Cooldown = () => Mathf.Clamp01(Ready() / total),
                    Enabled = () => Ready() <= .1f,
                    Reason = () => Ready() > .1f ? $"Ready in {Mathf.CeilToInt(Ready())} s" : point ? "Then click a target" : null,
                    Click = _ =>
                    {
                        var command = new JObject { ["c"] = "ability", ["ability"] = abilityKey, ["units"] = "@units" };
                        if (point) commander.Begin(Commander.Mode.Target, "", command);
                        else commander.UnitCommand("ability", new JObject { ["ability"] = abilityKey }, name);
                    },
                });
            }
            if (types.Any(t => ProtocolDecoder.Bool(Defs?["UNITS"]?[t]?["air"])))
                items.Add(new RadialItem { Id = "air", Icon = "airfield", Title = "Air missions", Detail = () => "Patrol, scout, intercept, support or return", Children = AirMissionItems });
            if (types.Any(t => ProtocolDecoder.Str(Defs?["UNITS"]?[t]?["move"]) == "infantry"))
                items.Add(new RadialItem { Id = "fortify", Icon = "fortify", Title = "Dig in", Detail = () => "Brace and hold this ground",
                    Click = _ => commander.UnitCommand("fortify", null, "Digging in") });
            if (Econ?["groups"] is JArray saved && saved.Any(g => g["units"] is JArray members && members.Any(m => selected.Contains(ProtocolDecoder.Int(m)))))
                items.Add(new RadialItem { Id = "detach", Icon = "detach", Title = "Detach", Detail = () => "Leave their reinforcement groups",
                    Click = _ => commander.UnitCommand("detach", null, "Detached") });
            Vector2? at;
            var mouse = InputFacade.MousePosition;
            at = ToPanel(new Vector3(mouse.x, mouse.y, 1));
            wheel.Open(selected.Length == 1 || groups.Length == 1 ? $"{selected.Length} × {NameOf("UNITS", main)}" : $"{selected.Length} units", main, items, () => at, null, null, keyboard);
            wheel.SubjectDetail = () => groups.Length == 1 ? UnitRole(main) : string.Join(" · ", groups.Take(3).Select(g => $"{g.Count()} {NameOf("UNITS", g.Key)}"));
        }

        IList<RadialItem> AirMissionItems()
        {
            var list = new List<RadialItem>();
            foreach (var (mission, icon, title, detail) in new[]
            {
                ("patrol", "patrol", "Patrol", "Hold the airspace around a point"),
                ("scout", "scan", "Scout", "Fly over a point and report"),
                ("intercept", "intercept", "Intercept", "Engage enemy aircraft near a point"),
                ("support", "attack_move", "Support", "Attack ground targets near a point"),
                ("return", "airfield", "Return", "Return to the airfield"),
            })
            {
                string m = mission, d = detail;
                list.Add(new RadialItem
                {
                    Id = "mission:" + m, Icon = icon, Title = title, Detail = () => d,
                    Click = _ =>
                    {
                        if (m == "return") commander.UnitCommand("airMission", new JObject { ["mission"] = m }, "Returning to base");
                        else commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "airMission", ["mission"] = m, ["units"] = "@units", ["tile"] = "@map" });
                    },
                });
            }
            return list;
        }
    }
}
