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
    /// Contextual command wheels (2026-11-16 rework, plan §2.G). Every wheel has nine segments with the enlarged
    /// centre circle describing the hovered item (see <see cref="RadialMenu"/>):
    /// <list type="bullet">
    /// <item>Base wheel: the top segment is the HQ tier upgrade, the base's sites (3 / 5 / 7 by tier, the
    /// rest shown locked) point toward their parcels, the perimeter sits near the bottom (build, rebuild,
    /// upgrade); an empty site opens a sub-ring of the nine facilities. Outer arc: rally, this base's
    /// production, all production, HQ repair.</item>
    /// <item>Building wheel: the top segment is building upgrades (era level, Armory/Barracks techs), then
    /// training (green progress ring and queued count per unit), missiles. Outer arc: rally, reinforce,
    /// repair, demolish. Several buildings (or bases) selected share one roster and batch-queue across them.</item>
    /// <item>Build wheel (B / dock button): trench, road, sandbags, watchtower, bunker, AT, AA, outpost, new base;
    /// support emplacements on the outer arc. Placement is validated by the server (own territory only), and
    /// the reason is shown at the cursor.</item>
    /// <item>Terrain wheel (T / dock button): raise, lower, flatten, smooth (server command <c>terrain</c>).</item>
    /// <item>Unit wheel (C) and the secured-ruin wheel.</item>
    /// </list>
    /// Wheels never overlap the minimap console, the bottom-centre dock or the selection panel: see
    /// <see cref="RegisterWheelKeepOut"/>. Contract: BuildCommandUi, UpdateCommandUi, CloseCommandContext,
    /// CommandUiCapturesDigits, ShowCommandUi; public: OpenBuildWheel, OpenTerrainWheel, ToggleBuildWheel,
    /// ToggleTerrainWheel, BuildWheelOpen, TerrainWheelOpen, OpenProductionWheel,
    /// RegisterWheelKeepOut, DockWheelLift.
    /// </summary>
    public sealed partial class Hud
    {
        VisualElement commandLayer;
        RadialMenu wheel;
        string wheelKind = "", wheelSubject = "", wheelStructure = "";
        int wheelSite, wheelEnteredSlot;
        int[] wheelBuildings = Array.Empty<int>();
        bool selectionEvent, commandUiShown = true;
        int digitFrame = -1;
        // world-anchored parcel bearings for the socket wedges
        readonly List<RadialItem> socketItems = new List<RadialItem>();
        readonly Dictionary<string, BaseParcel> socketParcels = new Dictionary<string, BaseParcel>();
        // elements the wheels must never cover (registered by the HUD shell: dock, selection panel, minimap console)
        readonly List<VisualElement> wheelKeepOut = new List<VisualElement>();

        const float MinimapRadius = 136f;
        /// <summary>Base wheel segments for the sites (the top is the tier upgrade, 200° the perimeter).</summary>
        static readonly int[] SocketSegments = { 1, 2, 3, 4, 6, 7, 8 };
        const float PerimeterAngle = 200f;

        /// <summary>
        /// Distance (panel px) from the bottom of the screen to the bottom of the Build/Terrain wheels: they open
        /// just above the bottom-centre dock. The HUD shell may set it to its dock's height plus a margin.
        /// </summary>
        public float DockWheelLift = 112f;

        // ------------------------------------------------------------------ public API (HUD shell, F)
        /// <summary>The wheels never cover this element while it is displayed (dock buttons, selection panel, minimap console, banners).</summary>
        public void RegisterWheelKeepOut(VisualElement element)
        {
            if (element != null && !wheelKeepOut.Contains(element)) wheelKeepOut.Add(element);
        }

        public bool BuildWheelOpen => wheel != null && wheel.IsOpen && wheelKind == "build";
        public bool TerrainWheelOpen => wheel != null && wheel.IsOpen && wheelKind == "terrain";

        /// <summary>The Build wheel (B or the dock's Build button): every defense and improvement, outpost and new base.</summary>
        public void OpenBuildWheel(bool keyboard = false)
        {
            if (wheel == null || session.Spectator || !session.ActionRts) return;
            if (commander.Current != Commander.Mode.Select) commander.Cancel();
            CloseWheel();
            wheelKind = "build";
            wheel.Open("Build", "build", BuildWheelItems(), DockAnchor, null, BuildWheelSupport(), keyboard);
            wheel.SubjectDetail = () => "Defenses and improvements · your territory only";
        }

        /// <summary>The Terrain wheel (T or the dock's Terrain button): pay engineers to reshape ground in your territory.</summary>
        public void OpenTerrainWheel(bool keyboard = false)
        {
            if (wheel == null || session.Spectator || !session.ActionRts) return;
            if (commander.Current != Commander.Mode.Select) commander.Cancel();
            CloseWheel();
            wheelKind = "terrain";
            wheel.Open("Terrain", "terrain", TerrainWheelItems(), DockAnchor, null, null, keyboard);
            wheel.SubjectDetail = () => ProtocolDecoder.Str(Defs?["RULESET"]?["terrain"]?["desc"], "Reshape the ground in your territory");
        }

        public void ToggleBuildWheel(bool keyboard = false) { if (BuildWheelOpen) CloseWheel(); else OpenBuildWheel(keyboard); }
        public void ToggleTerrainWheel(bool keyboard = false) { if (TerrainWheelOpen) CloseWheel(); else OpenTerrainWheel(keyboard); }

        /// <summary>
        /// Multi-base select: one shared training roster over every production building of these bases ("all
        /// production"). Clicking a unit batch-queues it across them (Shift ×5, Alt one per building).
        /// </summary>
        public void OpenProductionWheel(IEnumerable<int> siteIds)
        {
            if (wheel == null || session.Spectator || siteIds == null) return;
            var sites = new HashSet<int>(siteIds);
            var ids = new List<int>();
            foreach (var b in session.Structures.Buildings.Values)
                if (sites.Contains(b.City) && IsTrainer(b)) ids.Add(b.Id);
            if (ids.Count == 0) { commander.Say("No production buildings at these bases", false, Time.unscaledTime); return; }
            ids.Sort();
            OpenBuildingWheel(ids.ToArray(), sites.Count > 1 ? $"All production · {sites.Count} bases" : null);
        }

        /// <summary>Select every finished production building of every own base (the wheel shows the shared roster and batch-queues across them).</summary>
        void SelectEveryProduction()
        {
            var ids = new List<int>();
            foreach (var b in session.Structures.Buildings.Values) if (IsTrainer(b)) ids.Add(b.Id);
            if (ids.Count == 0) { commander.Say("No production buildings yet", false, Time.unscaledTime); return; }
            commander.SelectProduction(ids);
        }

        bool IsTrainer(BuildingRecord b) => b.Owner == session.CivId && b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray;

        // ------------------------------------------------------------------ contract (C7)
        /// <summary>Called once from Hud.Build(): the wheel layer and the tool chip.</summary>
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
            BuildToolChip();
        }

        /// <summary>True while digits belong to the command UI (a hot wheel).</summary>
        bool CommandUiCapturesDigits => wheel != null && wheel.IsOpen && wheel.Hot || digitFrame == Time.frameCount;

        /// <summary>From ShowGame: show or hide the command layer and tool chip.</summary>
        void ShowCommandUi(bool on)
        {
            commandUiShown = on;
            if (commandLayer == null) return;
            commandLayer.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
            if (!on) CloseWheel();
        }

        /// <summary>Escape chain step 5: wheel sub-ring → wheel. True if consumed.</summary>
        bool CloseCommandContext()
        {
            // a running tool or battle line belongs to the commander, which cancels it this frame
            // (it runs after the HUD, so its EscapeFrame is not set yet): consume so the selection survives
            if (commander.Current != Commander.Mode.Select || commander.DrawingLine) return true;
            if (wheel != null && wheel.IsOpen && wheel.Back()) return true;
            if (wheel != null && wheel.IsOpen) { CloseWheel(); return true; }
            return false;
        }

        /// <summary>Per frame from Hud.Update (after Escape handling).</summary>
        void UpdateCommandUi(float time)
        {
            if (commandLayer == null) return;
            bool active = commandUiShown && session.ActionRts && session.Ready && !MenuVisible;
            if (!active)
            {
                CloseWheel();
                if (toolChip != null) toolChip.style.display = DisplayStyle.None;
                if (cursorReason != null) cursorReason.style.display = DisplayStyle.None;
                commander.SuppressGroupKeys = false;
                return;
            }
            var mouse = InputFacade.MousePosition;
            var pointer = ToPanel(new Vector3(mouse.x, mouse.y, 1));
            float width = root.layout.width, height = root.layout.height;
            if (float.IsNaN(width) || width <= 0) { width = 1920; height = 1080; }
            // top: the floating clock and pause/menu buttons; the bottom band is handled by the keep-out rectangles
            var safe = new Rect(16, 56, Mathf.Max(0, width - 32), Mathf.Max(0, height - 56 - 12));
            var minimapCentre = new Vector2(136, height - 136);

            if (commander.Current != Commander.Mode.Select) CloseWheel();   // a placement/target tool started
            else
            {
                string subject = session.Spectator ? "" : SubjectKey();
                if (selectionEvent || subject != wheelSubject)
                {
                    bool changed = subject != wheelSubject;
                    selectionEvent = false;
                    bool dock = wheelKind == "build" || wheelKind == "terrain";
                    // a new selection replaces the wheel (the dock wheels stay unless something new is selected)
                    if (wheel.IsOpen && (changed && (!dock || subject != "") || wheelKind == "unit")) CloseWheel();
                    wheelSubject = subject;
                    if (!wheel.IsOpen) AutoOpen(subject);
                    if (wheelKind == "base") SocketFromSelection();
                }
                // right-click orders in the world close the unit wheel
                if (wheelKind == "unit" && InputFacade.RightDown && !IsPointerOverUi(mouse)) CloseWheel();
            }
            if (wheel.IsOpen) RefreshWheel();
            CommandKeys(time);
            FillKeepOut(width, height);
            wheel.Pointer = pointer;
            wheel.Tick(time, safe, minimapCentre, MinimapRadius);
            UpdateToolChip(pointer);
            commander.SuppressGroupKeys = CommandUiCapturesDigits;
            if (!(wheel.IsOpen && wheelKind == "base")) commander.HoverRingSlot = 0;
        }

        /// <summary>
        /// The keep-out rectangles: registered elements while displayed; until the shell registers any, a
        /// conservative layout of the mockup (minimap console bottom-left, dock bottom-centre, selection panel
        /// bottom-right). Rect is a struct: no allocation.
        /// </summary>
        void FillKeepOut(float width, float height)
        {
            var list = wheel.KeepOut;
            list.Clear();
            for (int i = 0; i < wheelKeepOut.Count; i++)
            {
                var e = wheelKeepOut[i];
                if (e == null || e.panel == null || e.resolvedStyle.display == DisplayStyle.None || e.resolvedStyle.visibility == Visibility.Hidden) continue;
                var r = e.worldBound;
                if (float.IsNaN(r.x) || r.width <= 0 || r.height <= 0) continue;
                list.Add(r);
            }
            if (wheelKeepOut.Count > 0) return;
            list.Add(new Rect(0, height - 312, 420, 312));                    // minimap console + resource bars
            list.Add(new Rect(width * .5f - 100, height - 96, 200, 96));      // Build / Terrain dock
            list.Add(new Rect(width - 640, height - 250, 640, 250));          // selection panel
        }

        Vector2? DockAnchor()
        {
            float width = root.layout.width, height = root.layout.height;
            if (float.IsNaN(width) || width <= 0) { width = 1920; height = 1080; }
            float r = wheel.WheelBounds.height * .5f;
            if (r < 10f) r = (RadialMenu.OuterRadius + 6f) * Mathf.Max(.5f, wheel.CurrentScale);
            return new Vector2(width * .5f, height - DockWheelLift - r);
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
                commander.Say(Commander.ReadableError(r) ?? ok, r.Error == null, Time.unscaledTime);
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
                var towns = new List<int>();
                foreach (int id in commander.SelectedBuildings)
                    if (session.Structures.Buildings.TryGetValue(id, out var b) && b.Owner == session.CivId)
                    {
                        if (b.Type == "town") { if (!towns.Contains(b.City)) towns.Add(b.City); }
                        else own.Add(id);
                    }
                if (own.Count == 0 && towns.Count == 1 && session.Objectives.TryGetValue(towns[0], out var hqSite) && hqSite.Operational) return "base:" + towns[0];
                // several headquarters selected: all production across those bases
                if (own.Count == 0 && towns.Count > 1) { towns.Sort(); return "prod:" + string.Join(",", towns); }
                if (own.Count == 0) return "";
                own.Sort();
                return "bld:" + string.Join(",", own);
            }
            return units.Selected.Count > 0 ? "unit" : "";
        }

        static int[] ParseIds(string list) => list.Split(',').Select(s => int.TryParse(s, out int v) ? v : 0).Where(v => v != 0).ToArray();

        void AutoOpen(string subject)
        {
            if (string.IsNullOrEmpty(subject) || session.Spectator) return;
            if (subject.StartsWith("base:") && int.TryParse(subject.Substring(5), out int baseId)) OpenBaseWheel(baseId);
            else if (subject.StartsWith("ruin:") && int.TryParse(subject.Substring(5), out int ruinId)) OpenRuinWheel(ruinId);
            else if (subject.StartsWith("bld:")) OpenBuildingWheel(ParseIds(subject.Substring(4)));
            else if (subject.StartsWith("prod:")) OpenProductionWheel(ParseIds(subject.Substring(5)));
            else if (subject == "unit" && App.GameSettings.OpenUnitWheelOnSelection) OpenUnitWheel(false);
        }

        void CloseWheel()
        {
            if (wheelEnteredSlot != 0) commander.ClearRingPreview();
            if (wheel != null && wheel.IsOpen) wheel.Close();
            wheelKind = ""; wheelStructure = ""; wheelSite = 0; wheelEnteredSlot = 0; wheelBuildings = Array.Empty<int>();
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
                        wheel.ReplaceRoot(BaseItems(site), BaseOuterArc(site));
                    }
                }
                AssignSocketAngles(site);
                int fromWorld = commander.HoverRingSlotFromWorld;
                if (fromWorld != highlightSlot) { highlightSlot = fromWorld; highlightId = fromWorld != 0 ? "socket:" + fromWorld : null; }
                wheel.HighlightId = highlightId;
                // left an empty site's facility ring: drop its world preview and the site selection
                if (wheelEnteredSlot != 0 && wheel.Depth == 0)
                {
                    wheelEnteredSlot = 0;
                    commander.ClearRingPreview();
                    if (commander.SelectedRingSlot != 0 && commander.SelectedObjective == wheelSite) commander.SelectObjective(wheelSite);
                }
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
                        wheel.ReplaceRoot(BuildingItems(wheelBuildings), BuildingOuterArc(wheelBuildings));
                    }
                }
            }
            else if (wheelKind == "build" || wheelKind == "terrain")
            {
                // tier locks and the definitions follow the era: rebuild the ring when the era changes
                if (wheelStructureSnap != session.Snapshots)
                {
                    wheelStructureSnap = session.Snapshots;
                    string structure = Age + "|" + (Defs?.GetHashCode() ?? 0);
                    if (structure != wheelStructure)
                    {
                        bool first = wheelStructure == "";
                        wheelStructure = structure;
                        if (!first)
                        {
                            if (wheelKind == "build") wheel.ReplaceRoot(BuildWheelItems(), BuildWheelSupport());
                            else wheel.ReplaceRoot(TerrainWheelItems());
                        }
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
            if (wheelKind == "base" && wheel.Depth == 0 && ActionKey("upgrade_base", KeyCode.U)) wheel.PressItem("upgrade:tier");
            if (!session.Spectator && InputFacade.KeyFor("build") != KeyCode.None && InputFacade.Action("build")) ToggleBuildWheel(true);
            if (!session.Spectator && InputFacade.KeyFor("terrain") != KeyCode.None && InputFacade.Action("terrain")) ToggleTerrainWheel(true);
            if (wheel.IsOpen && wheel.Hot)
                for (int d = 0; d <= 9; d++) if (DigitPressed(d))
                {
                    digitFrame = Time.frameCount;
                    wheel.PressDigit(d, InputFacade.Shift, InputFacade.Ctrl);
                    break;
                }
        }

        // ------------------------------------------------------------------ base wheel
        /// <summary>The perimeter upgrade level: the server's site.defenseLevel, else the lowest level among the perimeter pieces (1 when unknown).</summary>
        int PerimeterLevel(int siteId)
        {
            if (session.Objectives.TryGetValue(siteId, out var site) && site.DefenseLevel > 0) return site.DefenseLevel;
            int level = int.MaxValue;
            foreach (var b in session.Structures.Buildings.Values)
                if (b.City == siteId && b.Owner == session.CivId && b.Type == "city_turret") level = Mathf.Min(level, Mathf.Max(1, b.Level));
            return level == int.MaxValue ? 1 : level;
        }

        string BaseStructure(ObjectiveSite site)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(site.Tier).Append('|').Append(site.DefenseCount).Append('|').Append(PerimeterLevel(site.Id)).Append('|').Append(Age).Append('|')
                .Append(site.Headquarters).Append('|').Append(site.RingVersion).Append('|');
            if (site.Slots != null) foreach (int s in site.Slots) sb.Append(s).Append(',');
            sb.Append('|');
            if (site.Parcels != null) foreach (var p in site.Parcels) sb.Append(p.Id).Append(':').Append(p.Tier).Append(',');
            sb.Append('|');
            foreach (var b in session.Structures.Buildings.Values)
                if (b.City == site.Id && b.Owner == session.CivId && b.Slot != 0) sb.Append(b.Slot).Append(':').Append(b.Id).Append(b.Type).Append(',');
            return sb.ToString();
        }

        void OpenBaseWheel(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site) || !site.Operational) return;
            wheelKind = "base"; wheelSite = siteId; wheelEnteredSlot = 0;
            wheelStructure = BaseStructure(site);
            wheelStructureSnap = session.Snapshots;
            float x = site.X, z = site.Z;
            if (session.Structures.Buildings.TryGetValue(site.Headquarters, out var hq) && hq.HasPosition) { x = hq.X; z = hq.Z; }
            wheel.Open(site.Name, "hq", BaseItems(site), WorldAnchor(x, z, .3f), null, BaseOuterArc(site));
            wheel.HubPips = () => session.Objectives.TryGetValue(siteId, out var s) ? Mathf.Clamp(s.Tier, 1, 3) : 0;
            wheel.SubjectDetail = () =>
            {
                if (!session.Objectives.TryGetValue(siteId, out var s)) return "";
                int used = Mathf.Max(0, s.Capacity - (s.Slots?.Length ?? 0));
                return $"Tier {Tier(s.Tier)} base · {used}/{s.Capacity} sites used";
            };
            AssignSocketAngles(site);
            SocketFromSelection();
        }

        BuildingRecord HqOf(int siteId) => session.Objectives.TryGetValue(siteId, out var s) && session.Structures.Buildings.TryGetValue(s.Headquarters, out var b) ? b : default;

        /// <summary>The base wheel: tier upgrade on top, the sites, the perimeter near the bottom.</summary>
        List<RadialItem> BaseItems(ObjectiveSite site)
        {
            socketItems.Clear(); socketParcels.Clear();
            int siteId = site.Id;
            var list = new List<RadialItem> { BaseUpgrade(site), PerimeterItem(site) };
            foreach (var parcel in (site.Parcels ?? Array.Empty<BaseParcel>()).Where(p => p.Id > 0).OrderBy(p => p.Id))
            {
                int slot = parcel.Id, parcelTier = parcel.Tier;
                var occupant = session.Structures.Buildings.Values.FirstOrDefault(b => b.City == siteId && b.Slot == slot && b.Owner == session.CivId);
                int occupantId = occupant.Id;
                bool locked = parcelTier > site.Tier;
                bool empty = !locked && occupantId == 0 && site.Slots != null && Array.IndexOf(site.Slots, slot) >= 0;
                string id = "socket:" + slot;
                var item = new RadialItem { Id = id, Angle = SocketSegments[socketItems.Count % SocketSegments.Length] * RadialMenu.SegmentSpan };
                item.Hover = on =>
                {
                    if (on) commander.HoverRingSlot = slot;
                    else if (commander.HoverRingSlot == slot) commander.HoverRingSlot = 0;
                };
                if (locked)
                {
                    item.Icon = "lock"; item.Title = "Locked site";
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
                    item.Caption = () => session.Structures.Buildings.TryGetValue(occupantId, out var b) && b.Level > 1 ? "Lv " + b.Level : null;
                    item.Detail = () =>
                    {
                        if (!session.Structures.Buildings.TryGetValue(occupantId, out var b)) return "";
                        if (!b.Done) return $"Construction {b.Progress}%";
                        if (b.QueueLength > 0) return $"{b.QueueLength} in queue";
                        return b.Hp < 100 ? $"Condition {b.Hp}%" : "Open its wheel: production and upgrades";
                    };
                    item.Click = _ => commander.SelectRingSlot(siteId, slot);
                }
                else if (empty)
                {
                    item.Icon = "plus"; item.Title = "Empty site"; item.Pulse = true;
                    item.Detail = () => "Choose a facility to build here";
                    item.Children = () =>
                    {
                        wheelEnteredSlot = slot;
                        commander.SelectRingSlot(siteId, slot);
                        return FacilityItems(siteId, slot);
                    };
                }
                else
                {
                    item.Icon = "plus"; item.Title = "Site";
                    item.Enabled = () => false;
                    item.Reason = () => "Site not available";
                }
                socketParcels[id] = parcel;
                socketItems.Add(item);
                list.Add(item);
            }
            return list;
        }

        // per-frame socket assignment scratch (no allocations: the camera moves every frame)
        readonly List<(float cost, int item, int wedge)> anglePairs = new List<(float, int, int)>(96);
        bool[] angleItemDone = new bool[16];
        readonly bool[] angleWedgeDone = new bool[RadialMenu.Segments];
        static readonly Func<bool> NoWedge = () => false;

        /// <summary>
        /// Point each site wedge at its parcel: greedy nearest-angle assignment of parcels to the seven site
        /// segments (the top is the upgrade, 200° the perimeter). Also sizes the base wheel to the base on screen.
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
                foreach (int w in SocketSegments)
                {
                    // insertion keeps the list sorted by cost (stable; ≤ 7 × sites entries, no comparer allocation)
                    var entry = (Mathf.Abs(Mathf.DeltaAngle(bearing, RadialMenu.SegmentAngle(w))), i, w);
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
                float angle = RadialMenu.SegmentAngle(w);
                if (it.Angle != angle || it.Visible != null) changed = true;
                it.Angle = angle;
                it.Visible = null;
            }
            for (int i = 0; i < socketItems.Count; i++)
            {
                if (angleItemDone[i]) continue;
                var it = socketItems[i];
                if (it.Visible != NoWedge) changed = true;
                it.Visible = NoWedge;   // more parcels than site segments: the extra one has no wedge
            }
            if (changed) wheel.InvalidateLayout();
            // the base's on-screen radius → wheel size: 1× when the base is small on screen, up to 1.2× close in
            if (reach > 0f) wheel.Scale = Mathf.Clamp(1f + (reach - 170f) / 900f, 1f, 1.2f);
        }

        /// <summary>Top segment of the base wheel: the headquarters tier upgrade (U).</summary>
        RadialItem BaseUpgrade(ObjectiveSite site)
        {
            int siteId = site.Id;
            var next = site.Tier < 3 ? Defs?["AGES"]?[site.Tier] : null;
            var slots = Defs?["RULESET"]?["slots"] as JArray;
            int SlotsAt(int tier) => slots != null && slots.Count >= tier && tier >= 1 ? ProtocolDecoder.Int(slots[tier - 1]) : 1 + 2 * tier;
            return new RadialItem
            {
                Id = "upgrade:tier", Icon = "upgrade", Hotkey = "U", Angle = 0f,
                Name = () => session.Objectives.TryGetValue(siteId, out var s) && s.Tier < 3 ? $"Upgrade to Tier {TierLabels[Mathf.Clamp(s.Tier, 0, 2)]}" : "Tier III headquarters",
                Cost = next?["cost"], Seconds = ProtocolDecoder.Int(next?["time"]),
                Enabled = () => session.Objectives.TryGetValue(siteId, out var s) && s.Tier < 3 && HqOf(siteId).Project == null,
                Reason = () =>
                {
                    if (!session.Objectives.TryGetValue(siteId, out var s)) return "";
                    if (s.Tier >= 3) return "Maximum tier reached";
                    var h = HqOf(siteId);
                    if (h.Project == "tier") return $"Upgrading · {h.WorksPct}%";
                    if (h.Project != null) return "The headquarters is busy";
                    return null;
                },
                Detail = () =>
                {
                    if (!session.Objectives.TryGetValue(siteId, out var s) || s.Tier >= 3) return $"All {SlotsAt(3)} sites are unlocked";
                    int more = SlotsAt(s.Tier + 1) - SlotsAt(s.Tier);
                    return $"Unlocks {more} sites and Tier {TierLabels[Mathf.Clamp(s.Tier, 0, 2)]} units";
                },
                Progress = () => HqOf(siteId).Project == "tier" ? HqOf(siteId).WorksPct / 100f : -1f,
                Click = _ => Send(new JObject { ["c"] = "advance", ["site"] = siteId }, "Upgrade started"),
            };
        }

        static bool PerimeterProject(string project) => project == "perimeter" || project == "defenses" || project == "upgradeDefenses" || project == "defenseUpgrade";

        /// <summary>Near the bottom of the base wheel: build, rebuild or upgrade the city perimeter.</summary>
        RadialItem PerimeterItem(ObjectiveSite site)
        {
            int siteId = site.Id;
            var def = Defs?["CITY_DEFENSES"];
            var upgrade = def?["upgrade"];
            int count = site.DefenseCount;
            var item = new RadialItem { Id = "perimeter", Icon = "sandbags", Angle = PerimeterAngle };
            item.Progress = () => PerimeterProject(HqOf(siteId).Project) ? HqOf(siteId).WorksPct / 100f : -1f;
            if (count < 6)
            {
                int missing = Mathf.Clamp(6 - count, 0, 6);
                item.Cost = new JObject
                {
                    ["materials"] = Mathf.CeilToInt(ProtocolDecoder.Float(def?["cost"]?["materials"], 240) * missing / 6f),
                    ["energy"] = Mathf.CeilToInt(ProtocolDecoder.Float(def?["cost"]?["energy"], 60) * missing / 6f)
                };
                item.Seconds = ProtocolDecoder.Int(def?["time"], 25);
                item.Title = count > 0 ? $"Rebuild perimeter ({count}/6)" : "Build city perimeter";
                item.Detail = () => "Four sandbag positions and two machine-gun turrets around the base. Uses no sites.";
                item.Enabled = () => HqOf(siteId).Project == null;
                item.Reason = () => PerimeterProject(HqOf(siteId).Project) ? $"Under construction · {HqOf(siteId).WorksPct}%" : HqOf(siteId).Project != null ? "The headquarters is busy" : null;
                item.Click = _ => Send(new JObject { ["c"] = "baseDefenses", ["site"] = siteId }, "Construction started");
                return item;
            }
            int level = PerimeterLevel(siteId), max = ProtocolDecoder.Int(upgrade?["max"], 1);
            int aaLevel = ProtocolDecoder.Int(upgrade?["aaLevel"], 2);
            if (upgrade == null || level >= max)
            {
                item.Title = level > 1 ? $"Perimeter · level {level}" : "City perimeter";
                item.Caption = () => level > 1 ? "Lv " + level : null;
                item.Detail = () => upgrade == null ? "Complete" : level >= aaLevel ? "Fully upgraded · built-in anti-aircraft fire" : "Fully upgraded";
                item.Enabled = () => false;
                item.Reason = () => upgrade == null ? "The perimeter is complete" : "Maximum level";
                return item;
            }
            int next = level + 1;
            item.Icon = "upgrade";
            item.Title = $"Upgrade perimeter to level {next}";
            item.Cost = (upgrade["cost"] as JArray)?.ElementAtOrDefault(level - 1);
            item.Seconds = ProtocolDecoder.Int((upgrade["time"] as JArray)?.ElementAtOrDefault(level - 1));
            item.Caption = () => "Lv " + level;
            item.Detail = () => ProtocolDecoder.Str(upgrade["desc"], "Hardens every perimeter position") + (next == aaLevel ? " Adds city anti-aircraft fire." : "");
            item.Enabled = () => next <= Age + 1 && HqOf(siteId).Project == null;
            item.Reason = () =>
            {
                if (next > Age + 1) return $"Requires era {Tier(next)}";
                var h = HqOf(siteId);
                if (PerimeterProject(h.Project)) return $"Upgrading · {h.WorksPct}%";
                return h.Project != null ? "The headquarters is busy" : null;
            };
            item.Click = _ => Send(new JObject { ["c"] = "upgradeDefenses", ["site"] = siteId }, "Perimeter upgrade started");
            return item;
        }

        int[] TrainersAt(int siteId) => session.Structures.Buildings.Values.Where(b => b.City == siteId && IsTrainer(b)).Select(b => b.Id).ToArray();

        /// <summary>Allocation-free <c>TrainersAt(siteId).Length &gt; 0</c> (polled by the outer arc's visibility at 10 Hz).</summary>
        bool HasTrainersAt(int siteId)
        {
            var defs = Defs?["BUILDINGS"];
            foreach (var b in session.Structures.Buildings.Values)
                if ((siteId == 0 || b.City == siteId) && b.Owner == session.CivId && b.Done && defs?[b.Type]?["trains"] is JArray) return true;
            return false;
        }

        /// <summary>True when production exists at more than one own base (allocation-free, 10 Hz).</summary>
        bool TrainersAtSeveralBases()
        {
            var defs = Defs?["BUILDINGS"];
            int first = int.MinValue;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.Owner != session.CivId || !b.Done || !(defs?[b.Type]?["trains"] is JArray)) continue;
                if (first == int.MinValue) first = b.City;
                else if (b.City != first) return true;
            }
            return false;
        }

        List<RadialItem> BaseOuterArc(ObjectiveSite site)
        {
            int siteId = site.Id;
            return new List<RadialItem>
            {
                new RadialItem
                {
                    Id = "arc:rally", Icon = "rally", Title = "Rally point",
                    Detail = () => "Click the ground where new units from this base gather",
                    Visible = () => HasTrainersAt(siteId),
                    Click = _ => commander.Begin(Commander.Mode.Rally),
                },
                new RadialItem
                {
                    Id = "arc:production", Icon = "barracks", Title = "Base production",
                    Detail = () => "Every production building at this base: one shared roster",
                    Visible = () => HasTrainersAt(siteId),
                    Click = _ => commander.SelectProduction(TrainersAt(siteId)),
                },
                new RadialItem
                {
                    Id = "arc:allproduction", Icon = "army", Title = "All production",
                    Detail = () => "Every production building at every base: units queue across all of them",
                    Visible = TrainersAtSeveralBases,
                    Click = _ => SelectEveryProduction(),
                },
                new RadialItem
                {
                    Id = "arc:repair", Icon = "repair", Title = "Repair headquarters",
                    Visible = () => HqOf(siteId).RepairCost > 0,
                    Enabled = () => HqOf(siteId).Project == null,
                    Reason = () => HqOf(siteId).Project != null ? "The headquarters is busy" : $"Costs {HqOf(siteId).RepairCost} Materials",
                    Click = _ => Send(new JObject { ["c"] = "repair", ["id"] = HqOf(siteId).Id }, "Repairs started"),
                },
            };
        }

        void OpenRuinWheel(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
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

        // ------------------------------------------------------------------ an empty site's facility sub-ring
        /// <summary>A site picked in the world (or by the selection) opens its facility ring.</summary>
        void SocketFromSelection()
        {
            int slot = commander.SelectedRingSlot;
            if (slot == 0 || wheelKind != "base" || slot == wheelEnteredSlot && wheel.Depth > 0) return;
            if (!session.Objectives.TryGetValue(wheelSite, out var site) || site.Slots == null || Array.IndexOf(site.Slots, slot) < 0) return;
            while (wheel.Depth > 0) wheel.Back();
            wheelEnteredSlot = slot;   // set first: the item's Children re-selects the same slot
            if (!wheel.EnterItem("socket:" + slot)) wheelEnteredSlot = 0;
        }

        /// <summary>The nine facilities for an empty site: name, description and cost in the centre; hover previews it in the world.</summary>
        List<RadialItem> FacilityItems(int siteId, int slot)
        {
            var list = new List<RadialItem>();
            foreach (string type in Facilities)
            {
                var d = Defs?["BUILDINGS"]?[type];
                if (d == null) continue;
                string facility = type;
                int tier = ProtocolDecoder.Int(d["tier"], 1);
                string needs = ProtocolDecoder.Str(d["needs"]);
                string Lock()
                {
                    if (tier > Age + 1) return $"Requires Tier {Tier(tier)}";
                    if (!string.IsNullOrEmpty(needs) && !session.Structures.Buildings.Values.Any(b => b.City == siteId && b.Owner == session.CivId && b.Type == needs && b.Done))
                        return "Needs " + NameOf("BUILDINGS", needs) + " at this base";
                    if (!session.Objectives.TryGetValue(siteId, out var s) || s.Slots == null || Array.IndexOf(s.Slots, slot) < 0) return "Site taken";
                    return null;
                }
                list.Add(new RadialItem
                {
                    Id = "facility:" + type, Icon = Icons.BuildingKind(type), Title = NameOf("BUILDINGS", type), Cost = d["cost"], Seconds = ProtocolDecoder.Int(d["time"]),
                    Detail = () => ProtocolDecoder.Str(d["desc"], ""),
                    Enabled = () => Lock() == null,
                    Reason = Lock,
                    Hover = on => { if (on && Lock() == null) commander.PreviewRingFacility(siteId, slot, facility); else commander.ClearRingPreview(); },
                    Click = _ =>
                    {
                        commander.BuildRingFacility(siteId, slot, facility);
                        wheel.Back();
                    },
                });
            }
            return list;
        }

        // ------------------------------------------------------------------ building wheel
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
                sb.Append(b.Id).Append(b.Done ? 'd' : 'u').Append(b.Missiles > 0 ? 'm' : '-').Append(b.Project != null ? 'p' : '-').Append(b.RepairCost > 0 ? 'r' : '-').Append(b.Level).Append(',');
            return sb.ToString();
        }

        void OpenBuildingWheel(int[] ids, string titleOverride = null)
        {
            var own = OwnBuildings(ids);
            if (own.Length == 0) return;
            wheelKind = "building"; wheelBuildings = ids; wheelSite = own[0].City;
            wheelStructure = BuildingStructure(ids);
            wheelStructureSnap = session.Snapshots;
            var first = own[0];
            string title = titleOverride ?? (own.Length == 1 ? NameOf("BUILDINGS", first.Type) : own.All(b => b.Type == first.Type) ? $"{own.Length} × {NameOf("BUILDINGS", first.Type)}" : $"{own.Length} facilities");
            Func<Vector2?> anchor;
            if (own.Length == 1 && first.HasPosition) anchor = WorldAnchor(first.X, first.Z, .3f);
            else
            {
                // several buildings: anchor on their centre (wrap-aware relative to the first)
                float sx = 0, sz = 0; int n = 0;
                foreach (var b in own) if (b.HasPosition) { sx += first.X + session.World.Grid.DxWrap(first.X, b.X); sz += b.Z; n++; }
                anchor = n > 0 ? WorldAnchor(sx / n, sz / n, .3f) : (() => (Vector2?)null);
            }
            // a roster spread over several bases: anchor at the dock instead (the buildings may be far apart)
            if (own.Select(b => b.City).Distinct().Count() > 1) anchor = DockAnchor;
            int[] idsCopy = ids;
            wheel.Open(title, Icons.BuildingKind(first.Type), BuildingItems(ids), anchor, null, BuildingOuterArc(ids));
            wheel.SubjectDetail = () =>
            {
                var current = OwnBuildings(idsCopy);
                if (current.Length == 0) return "";
                if (current.Any(b => !b.Done)) return $"Construction {current.First(b => !b.Done).Progress}%";
                int queued = current.Sum(b => b.QueueLength);
                if (queued > 0) return $"{queued} in queue";
                var busy = current.FirstOrDefault(b => b.Project != null);
                if (busy.Id != 0) return $"{ProjectName(busy.Project)} {busy.WorksPct}%";
                int level = current.Max(b => b.Level);
                return (level > 1 ? $"Level {level} · " : "") + $"Condition {current.Min(b => b.Hp)}%";
            };
        }

        List<RadialItem> BuildingItems(int[] ids)
        {
            var items = new List<RadialItem>();
            var own = OwnBuildings(ids);
            if (own.Length == 0) return items;
            int[] all = own.Select(b => b.Id).ToArray();
            var trainers = own.Where(IsTrainer).Select(b => b.Id).ToArray();
            var hostTypes = new HashSet<string>(own.Where(b => b.Done).Select(b => b.Type));
            // 1. the top segment: building upgrades (era level, Armory / Barracks techs)
            items.Add(UpgradesItem(all, hostTypes));
            // 2. training, one wedge per unit type across the selection (batch-queued across every host)
            var types = new List<string>();
            foreach (var b in own)
                if (b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray trains)
                    foreach (var t in trains) { string key = (string)t; if (!types.Contains(key)) types.Add(key); }
            foreach (string type in types) items.Add(TrainItem(type, trainers));
            // 3. strategic missile
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
            return items;
        }

        /// <summary>Rally, reinforce, repair, demolish: outside the nine segments so training keeps the ring.</summary>
        List<RadialItem> BuildingOuterArc(int[] ids)
        {
            var items = new List<RadialItem>();
            var own = OwnBuildings(ids);
            if (own.Length == 0) return items;
            int[] all = own.Select(b => b.Id).ToArray();
            var trainers = own.Where(IsTrainer).Select(b => b.Id).ToArray();
            if (trainers.Length > 0)
                items.Add(new RadialItem
                {
                    Id = "rally", Icon = "rally", Title = "Rally point",
                    Detail = () => "Click the ground where new units gather (right-click also sets it)",
                    Click = _ => commander.Begin(Commander.Mode.Rally),
                });
            if (trainers.Length > 0 && Econ?["groups"] is JArray savedGroups && savedGroups.Count > 0)
                items.Add(new RadialItem
                {
                    Id = "reinforce", Icon = "army", Title = "Reinforce group",
                    Detail = () => "New units from here join a control group",
                    Children = () => GroupItems(trainers),
                });
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

        /// <summary>Project kinds that are not an era level upgrade (anything else running on a building with levels is).</summary>
        static bool LevelProject(string project) =>
            project != null && project != "upgrade" && project != "repair" && project != "missile" && project != "tier" && !PerimeterProject(project);

        /// <summary>
        /// The top segment of a building wheel. With techs (Armory, Barracks) it is an "Upgrades" sub-ring holding
        /// the era level upgrade and the techs; with only a level upgrade it is that upgrade; otherwise disabled.
        /// </summary>
        RadialItem UpgradesItem(int[] ids, HashSet<string> hostTypes)
        {
            var level = LevelUpgradeItem(ids);
            bool techs = Defs?["TECHS"] is JObject options && options.Properties().Any(p => hostTypes.Contains(ProtocolDecoder.Str(p.Value["at"], "armory")));
            if (techs)
                return new RadialItem
                {
                    Id = "upgrades", Icon = "upgrade", Title = "Upgrades",
                    Detail = () => (hostTypes.Contains("barracks") && !hostTypes.Contains("armory") ? "Infantry equipment" : "Faction-wide military upgrades") + (level != null ? " and the building's era level" : ""),
                    Children = () =>
                    {
                        var list = new List<RadialItem>();
                        var lv = LevelUpgradeItem(ids);
                        if (lv != null) list.Add(lv);
                        list.AddRange(TechItems(ids, hostTypes));
                        return list;
                    },
                };
            if (level != null) return level;
            return new RadialItem
            {
                Id = "upgrades", Icon = "upgrade", Title = "Upgrades",
                Enabled = () => false,
                Reason = () => "This building has no upgrades",
            };
        }

        /// <summary>The era level upgrade (server <c>upgradeBuilding</c>), for every selected building that has levels; null when none has.</summary>
        RadialItem LevelUpgradeItem(int[] ids)
        {
            var own = OwnBuildings(ids).Where(b => Defs?["BUILDINGS"]?[b.Type]?["levels"] is JObject).ToArray();
            if (own.Length == 0) return null;
            var first = own.OrderBy(b => Mathf.Max(1, b.Level)).First();
            var levels = Defs?["BUILDINGS"]?[first.Type]?["levels"];
            int current = Mathf.Max(1, first.Level), max = ProtocolDecoder.Int(levels?["max"], 3), next = current + 1;
            int[] candidates = own.Select(b => b.Id).ToArray();
            BuildingRecord[] Ready() => OwnBuildings(candidates).Where(b => b.Done && b.Project == null && Mathf.Max(1, b.Level) < ProtocolDecoder.Int(Defs?["BUILDINGS"]?[b.Type]?["levels"]?["max"], 3)
                && Mathf.Max(1, b.Level) + 1 <= Age + 1).ToArray();
            var item = new RadialItem
            {
                Id = "level", Icon = "upgrade",
                Title = current >= max ? $"Level {current} (maximum)" : own.Length == 1 ? $"Upgrade to level {next}" : $"Upgrade {own.Length} to level {next}",
                Cost = current < max ? (levels?["cost"] as JArray)?.ElementAtOrDefault(current - 1) : null,
                Seconds = current < max ? ProtocolDecoder.Int((levels?["time"] as JArray)?.ElementAtOrDefault(current - 1)) : 0,
                Caption = () => "Lv " + current,
                Detail = () => ProtocolDecoder.Str(levels?["desc"], "Era upgrade") + $" · Level {current} of {max}" + (own.Length > 1 ? " · cost per building" : ""),
                Enabled = () => Ready().Length > 0,
                Reason = () =>
                {
                    if (current >= max) return "Maximum level";
                    if (next > Age + 1) return $"Requires era {Tier(next)}";
                    var cur = OwnBuildings(candidates);
                    if (cur.Any(b => LevelProject(b.Project))) return $"Upgrading · {cur.First(b => LevelProject(b.Project)).WorksPct}%";
                    if (cur.All(b => !b.Done)) return "Still under construction";
                    if (cur.All(b => b.Project != null)) return "The building is busy";
                    return null;
                },
                Progress = () =>
                {
                    foreach (var b in OwnBuildings(candidates)) if (LevelProject(b.Project)) return b.WorksPct / 100f;
                    return -1f;
                },
                Click = _ =>
                {
                    foreach (var b in Ready()) Send(new JObject { ["c"] = "upgradeBuilding", ["id"] = b.Id }, "Upgrade started");
                },
            };
            return item;
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
                Detail = () => UnitRole(type) + $" · {ProtocolDecoder.Int(d?["capacity"])} command" + (Hosts().Length > 1 ? $" · queues across {Hosts().Length} buildings" : ""),
                Enabled = () => tier <= Age + 1 && Hosts().Length > 0,
                Reason = () => tier > Age + 1 ? $"Requires Tier {Tier(tier)}" : Hosts().Length == 0 ? "Needs " + NameOf("BUILDINGS", facility)
                    : Hosts().Length > 1 ? "Shift ×5 · Alt one each · right-click cancels" : "Shift ×5 · right-click cancels · Ctrl repeats",
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
                    // batch production: the server spreads the count over the hosts; Alt queues one in every host
                    bool each = c.Alt && hosts.Length > 1;
                    int count = each ? hosts.Length : c.Shift ? 5 : 1;
                    var cmd = new JObject { ["c"] = "batchTrain", ["buildings"] = new JArray(hosts.Select(b => b.Id).ToArray()), ["unit"] = type, ["count"] = each ? 1 : count };
                    if (each) cmd["policy"] = "each";
                    session.Net?.Command(cmd, r =>
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

        // ------------------------------------------------------------------ Build wheel (B)
        /// <summary>The nine segments, in order clockwise from the top (plan §2.G).</summary>
        static readonly string[] BuildWheelOrder = { "trench", "road", "barricade", "guard_post", "bunker", "turret", "aa_battery", "fort", "@newbase" };
        /// <summary>Support emplacements on the outer arc (any other field building the server adds joins them).</summary>
        static readonly string[] BuildWheelExtras = { "artillery_post", "sensor_post", "repair_point" };

        string NewBaseType => ProtocolDecoder.Str(Defs?["RULESET"]?["newBase"]?["type"], "base_site");

        List<RadialItem> BuildWheelItems()
        {
            var list = new List<RadialItem>();
            foreach (string key in BuildWheelOrder) list.Add(BuildItem(key == "@newbase" ? NewBaseType : key, key == "@newbase"));
            return list;
        }

        List<RadialItem> BuildWheelSupport()
        {
            var list = new List<RadialItem>();
            foreach (string key in BuildWheelExtras) if (Defs?["BUILDINGS"]?[key] != null) list.Add(BuildItem(key, false));
            if (Defs?["BUILDINGS"] is JObject all)
                foreach (var p in all.Properties())
                {
                    string key = p.Name;
                    if (!ProtocolDecoder.Bool(p.Value["field"]) || key == "city_turret" || key == NewBaseType || ProtocolDecoder.Bool(p.Value["newBase"])) continue;
                    if (Array.IndexOf(BuildWheelOrder, key) >= 0 || Array.IndexOf(BuildWheelExtras, key) >= 0) continue;
                    if (list.Count < 5) list.Add(BuildItem(key, false));
                }
            return list;
        }

        // read-only cost tokens for the two tools without a definition (shared: never mutate them)
        static readonly JObject TrenchCost = new JObject { ["materials"] = 35 }, RoadCost = new JObject { ["materials"] = 15 };

        RadialItem BuildItem(string key, bool newBase)
        {
            if (key == "trench")
                return new RadialItem
                {
                    Id = "build:trench", Icon = "trench", Title = "Trench", Cost = TrenchCost,
                    Detail = () => "Drag a line across your territory and release to dig. 35 Materials per segment; infantry inside gain cover.",
                    Click = _ => { CloseWheel(); commander.BeginTrench(); },
                };
            if (key == "road")
                return new RadialItem
                {
                    Id = "build:road", Icon = "road", Title = "Road", Cost = RoadCost,
                    Detail = () => "Drag a route through your territory and release to build. 15 Materials per link; roads over rivers become bridges.",
                    Click = _ => { CloseWheel(); commander.BeginRoad(); },
                };
            var d = Defs?["BUILDINGS"]?[key];
            int tier = ProtocolDecoder.Int(d?["tier"], 1);
            string type = key;
            string name = newBase ? "New base" : d != null ? NameOf("BUILDINGS", key) : key;
            string desc = ProtocolDecoder.Str(d?["desc"], newBase ? "Found a new base in your territory beside a road." : "Field defense.")
                .Replace(" Q / E rotates before placement.", "");
            return new RadialItem
            {
                Id = "build:" + key, Icon = newBase ? "new_base" : Icons.BuildingKind(key), Title = name,
                Cost = d?["cost"], Seconds = ProtocolDecoder.Int(d?["time"]),
                Detail = () => desc,
                Enabled = () => Defs?["BUILDINGS"]?[type] != null && tier <= Age + 1,
                Reason = () => Defs?["BUILDINGS"]?[type] == null ? "Not available on this server" : tier > Age + 1 ? $"Requires Tier {Tier(tier)}"
                    : newBase ? "Inside your territory, on or beside a road" : "Inside your territory · , . rotate",
                Click = _ => { CloseWheel(); commander.BeginFieldConstruction(type); },
            };
        }

        // ------------------------------------------------------------------ Terrain wheel (T)
        static readonly string[] TerrainOps = { "raise", "lower", "flatten", "smooth" };

        List<RadialItem> TerrainWheelItems()
        {
            var works = Defs?["RULESET"]?["terrain"];
            var ops = works?["ops"] is JArray serverOps && serverOps.Count > 0 ? serverOps.Select(o => (string)o).ToArray() : TerrainOps;
            var list = new List<RadialItem>();
            foreach (string op in ops)
            {
                string o = op;
                string title = o switch { "raise" => "Raise ground", "lower" => "Lower ground", "flatten" => "Flatten", "smooth" => "Smooth", _ => char.ToUpperInvariant(o[0]) + o.Substring(1) };
                string detail = o switch
                {
                    "raise" => "Engineers heap up the ground around a point: high ground for defenses",
                    "lower" => "Engineers dig the ground down around a point",
                    "flatten" => "Level the ground around a point to the height at its centre",
                    "smooth" => "Even out rough ground around a point for roads and movement",
                    _ => "Reshape the ground around a point",
                };
                list.Add(new RadialItem
                {
                    Id = "terrain:" + o, Icon = "terrain_" + o, Title = title,
                    Cost = works?["cost"], Seconds = ProtocolDecoder.Int(works?["time"]),
                    Detail = () => detail,
                    Enabled = () => Defs?["RULESET"]?["terrain"] != null,
                    Reason = () => Defs?["RULESET"]?["terrain"] == null ? "Terrain works are not available on this server" : "Then click a point in your territory",
                    Click = _ => { CloseWheel(); commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "terrain", ["op"] = o, ["tile"] = "@map" }); },
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
