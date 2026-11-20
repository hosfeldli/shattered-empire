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
    /// upgrade); an empty site opens a sub-ring of the eight facilities. Outer arc: rally, this base's
    /// production, all production, HQ repair.</item>
    /// <item>Building wheel: the top segment is building upgrades (era level, any techs the server offers), then
    /// training (green progress ring and queued count per unit), missiles. Outer arc: rally, reinforce,
    /// repair, demolish. Several buildings (or bases) selected share one roster and batch-queue across them.</item>
    /// <item>Build wheel (B / dock button): trench, road, sandbags, watchtower, bunker, AT, AA, outpost, new base;
    /// support emplacements on the outer arc. Placement is validated by the server (own territory; defenses also on neutral ground,
    /// at ×3 beyond the ring of influence), and
    /// the reason is shown at the cursor.</item>
    /// <item>Terrain wheel (T / dock button): raise, lower, flatten, smooth, painted as a brush stroke (server command <c>terrain</c> with points + radius; Commander.Terrain.cs).</item>
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
        /// <summary>Segments of the pads sub-ring (all nine: the pads have the ring to themselves since §11).</summary>
        static readonly int[] SocketSegments = { 0, 1, 2, 3, 4, 5, 6, 7, 8 };
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
            wheel.SubjectDetail = () => "Defenses and improvements · your land or neutral ground";
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
            // §12 pad hover: what the pad under the cursor holds and what a click does (follows the cursor by translate)
            padHint = UiKit.Text("", "se-cmd-cursor-reason", root);
            padHint.pickingMode = PickingMode.Ignore;
            padHint.style.position = Position.Absolute; padHint.style.left = 0; padHint.style.top = 0;
            padHint.style.whiteSpace = WhiteSpace.Normal; padHint.style.maxWidth = 340;
            padHint.style.color = UiKit.Token("text");
            padHint.usageHints = UsageHints.DynamicTransform;
            padHint.style.display = DisplayStyle.None;
        }

        // ------------------------------------------------------------------ pad hover hint (§12)
        Label padHint;
        string padHintText = "";
        int padHintSite, padHintSlot, padHintSnap = -1;
        bool padHintShown;
        Vector2 padHintAt = new Vector2(float.NaN, float.NaN);

        /// <summary>
        /// The pad under the cursor (any own base, selected or not): its state, the facility on it and its
        /// construction progress, and what a click does. Text is rebuilt only when the pad or the snapshot changes.
        /// </summary>
        void UpdatePadHint(Vector2 pointer, Vector2 mouse)
        {
            int siteId = commander.HoverPadSite, slot = commander.HoverPadSlot;
            bool show = siteId != 0 && slot != 0 && commander.Current == Commander.Mode.Select && !(wheel.IsOpen && wheel.Hot) && !IsPointerOverUi(mouse);
            if (show && (siteId != padHintSite || slot != padHintSlot || padHintSnap != session.Snapshots))
            {
                padHintSite = siteId; padHintSlot = slot; padHintSnap = session.Snapshots;
                string text = PadHintText(siteId, slot);
                if (text != padHintText) { padHintText = text; padHint.text = text; }
            }
            show &= padHintText.Length > 0;
            if (show)
            {
                var at = new Vector2(pointer.x + 18, pointer.y + 14);
                if (!((at - padHintAt).sqrMagnitude <= .0025f)) { padHintAt = at; padHint.style.translate = new Translate(at.x, at.y); }
            }
            if (show != padHintShown) { padHintShown = show; padHint.style.display = show ? DisplayStyle.Flex : DisplayStyle.None; }
        }

        string PadHintText(int siteId, int slot)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site) || site.Parcels == null) return "";
            BaseParcel parcel = default;
            foreach (var p in site.Parcels) if (p.Id == slot) { parcel = p; break; }
            if (parcel.Id == 0) return "";
            BuildingRecord occupant = default;
            foreach (var b in session.Structures.Buildings.Values)
                if (b.City == siteId && b.Slot == slot && b.Owner == session.CivId) { occupant = b; break; }
            var (used, open, _) = PadCounts(siteId);
            if (occupant.Id != 0)
            {
                string name = NameOf("BUILDINGS", occupant.Type);
                if (!occupant.Done)
                    return $"{name} · under construction {occupant.Progress}%" + (CanCancelConstruction ? " · click, then right-click its pad wedge to cancel" : " · click to open");
                if (occupant.QueueLength > 0) return $"{name} · {occupant.QueueLength} in production · click for its queue and upgrades";
                return $"{name}" + (occupant.Hp < 100 ? $" · condition {occupant.Hp}%" : "") + " · click for production and upgrades";
            }
            if (parcel.Tier > site.Tier) return $"Locked pad · unlocks at base Tier {Tier(parcel.Tier)}";
            if (!site.Operational) return "Pad · the headquarters must be rebuilt first";
            if (site.Slots != null && Array.IndexOf(site.Slots, slot) >= 0) return $"Empty pad · click to choose a facility ({used}/{open} pads used)";
            return "Pad not available";
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
                if (toolChip != null) UiKit.Hide(toolChip);
                if (cursorReason != null) UiKit.Hide(cursorReason);
                if (padHintShown) { padHintShown = false; padHint.style.display = DisplayStyle.None; }
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
                // §40 click-away (C-C hook): a world click outside an open unit / build / terrain wheel only closes it;
                // the commander skips that frame's click (no move, build or selection)
                if ((wheelKind == "unit" || wheelKind == "build" || wheelKind == "terrain") && (InputFacade.LeftDown || InputFacade.RightDown) && !IsPointerOverUi(mouse)) { CloseWheel(); commander.ConsumedClickFrame = Time.frameCount; }
            }
            if (wheel.IsOpen) RefreshWheel();
            CommandKeys(time);
            FillKeepOut(width, height);
            wheel.Pointer = pointer;
            wheel.Tick(time, safe, minimapCentre, MinimapRadius);
            UpdateToolChip(pointer);
            UpdatePadHint(pointer, mouse);
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
        int highlightSlot, highlightDepth;
        /// <summary>Which base-wheel sub-ring was entered last ("pads" or "garrison"): only the pads ring is rebuilt with the base.</summary>
        string baseSubRing;
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
                // a pad hovered in the world lights its wedge in the pads ring, or the Pads wedge on the root ring
                int fromWorld = commander.HoverRingSlotFromWorld;
                int depth = wheel.Depth;
                if (fromWorld != highlightSlot || depth != highlightDepth)
                {
                    highlightSlot = fromWorld; highlightDepth = depth;
                    highlightId = null;   // (the pads view is gone, 2026-11-20)
                }
                wheel.HighlightId = highlightId;
                // left an empty pad's facility ring (depth 1): drop its world preview and the pad selection
                if (wheelEnteredSlot != 0 && wheel.Depth < 1)
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
            else if (wheelKind == "perimeter") RefreshPerimeterWheel();
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
            sb.Append(UpgradeKey(HqOf(site.Id))).Append(site.EngineerLevel).Append('|');
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
                // 2026-11-20: materials and power under the base name (health has its own bar, the tier is the hub's pips)
                return session.Objectives.ContainsKey(siteId) ? BaseIncomeLine(siteId) : "";
            };
            AssignSocketAngles(site);
            SocketFromSelection();
        }

        BuildingRecord HqOf(int siteId) => session.Objectives.TryGetValue(siteId, out var s) && session.Structures.Buildings.TryGetValue(s.Headquarters, out var b) ? b : default;

        // base wheel segment angles (§11): upgrades and status on the root ring; construction is on the pads (§12)
        const float PadsAngle = 40f, EconomyAngle = 80f, GarrisonAngle = 120f, ProductionAngle = 160f, StatusAngle = 240f, AllProductionAngle = 280f;

        /// <summary>
        /// The base wheel (§11): the tier upgrade on top, then pads (a sub-ring of the base's pads pointing at their
        /// parcels; construction is normally started by clicking a pad in the world, §12), economy, garrison (when the
        /// server offers it), this base's production, the perimeter near the bottom, headquarters status / repair and
        /// every base's production. Outer arc: rally point.
        /// </summary>
        List<RadialItem> BaseItems(ObjectiveSite site)
        {
            // 2026-11-20 (Ticket 3, BASE_MENU_REWORK.md §1): Hud.BaseMenu.cs. Gone: pads, economy, garrison, headquarters /
            // repair and the perimeter upgrade; production moved to the outer arc
            return BaseMenuItems(site);
        }

        /// <summary>Pads used / open on a base (open = the tier's pads; free = still empty).</summary>
        (int used, int open, int free) PadCounts(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var s)) return (0, 0, 0);
            int free = s.Slots?.Length ?? 0;
            return (Mathf.Max(0, s.Capacity - free), s.Capacity, free);
        }

        RadialItem PadsItem(int siteId) => new RadialItem
        {
            Id = "pads", Icon = "build", Angle = PadsAngle,
            Name = () => { var (used, open, _) = PadCounts(siteId); return $"Pads · {used}/{open} used"; },
            Caption = () => { var (_, _, free) = PadCounts(siteId); return free > 0 ? free + " free" : null; },
            Detail = () => "Click a pad on the base to build there, or pick one here",
            // 2026-11-19 (user: "the option to see open pads in a base menu should be removed"): hidden from the root
            // ring, since the open pads now stand out on the base itself; a pad clicked in the world still enters
            // its facility ring through this item (SocketFromSelection → EnterItem("pads"), which ignores Visible)
            Visible = () => false,
            Children = () => { baseSubRing = "pads"; return PadItems(siteId); },
        };

        RadialItem EconomyItem(int siteId) => new RadialItem
        {
            Id = "economy", Icon = "materials", Title = "Economy", Angle = EconomyAngle,
            Caption = () => { var (m, _) = BaseIncome(siteId); return m > 0 ? "+" + m.ToString("0.#") : null; },
            Detail = () =>
            {
                var (m, e) = BaseIncome(siteId);
                return $"This base: +{m:0.0}/s Materials · +{e:0.0}/s Energy · stock {ResourceHave("materials")} Materials, {ResourceHave("energy")} Energy";
            },
        };

        RadialItem ProductionItem(int siteId) => new RadialItem
        {
            Id = "production", Icon = "barracks", Title = "Base production", Angle = ProductionAngle,
            Detail = () =>
            {
                int queued = 0, buildings = 0;
                var defs = Defs?["BUILDINGS"];
                foreach (var b in session.Structures.Buildings.Values)
                    if (b.City == siteId && b.Owner == session.CivId && b.Done && defs?[b.Type]?["trains"] is JArray) { buildings++; queued += b.QueueLength; }
                return $"{buildings} production {(buildings == 1 ? "building" : "buildings")} · {queued} queued · one shared roster";
            },
            Badge = () =>
            {
                int queued = 0;
                foreach (var b in session.Structures.Buildings.Values) if (b.City == siteId && b.Owner == session.CivId) queued += b.QueueLength;
                return queued;
            },
            Visible = () => HasTrainersAt(siteId),
            Click = _ => commander.SelectProduction(TrainersAt(siteId)),
        };

        RadialItem AllProductionItem() => new RadialItem
        {
            Id = "allproduction", Icon = "army", Title = "All production", Angle = AllProductionAngle,
            Detail = () => "Every production building at every base: units queue across all of them",
            Visible = TrainersAtSeveralBases,
            Click = _ => SelectEveryProduction(),
        };

        /// <summary>The headquarters garrison (W4, R4) on the base wheel; null when the server has no garrisons.</summary>
        RadialItem GarrisonItem(int siteId)
        {
            var hq = HqOf(siteId);
            if (hq.Id == 0 || GarrisonCapacity(hq.Type) <= 0) return null;
            return GarrisonWedge(hq.Id, GarrisonAngle);
        }

        // ------------------------------------------------------------------ garrison (W4, R4; CAPTURE_AND_GARRISON.md)
        /// <summary>Unit flag bit: the unit is inside a structure (its model is hidden by the renderer).</summary>
        public const int InsideFlag = 16384;

        int GarrisonCapacity(string buildingType) => ProtocolDecoder.Int(Defs?["BUILDINGS"]?[buildingType]?["garrison"]);
        int FiringSlots(string buildingType) => ProtocolDecoder.Int(Defs?["BUILDINGS"]?[buildingType]?["firingSlots"]);

        /// <summary>Capture-capable infantry squads (defs UNITS capture:true, not auto) may garrison.</summary>
        bool CanGarrison(string unitType)
        {
            var d = Defs?["UNITS"]?[unitType];
            return ProtocolDecoder.Bool(d?["capture"]) && !ProtocolDecoder.Bool(d?["auto"]);
        }

        int OccupantCount(int buildingId) => session.Structures.Buildings.TryGetValue(buildingId, out var b) ? b.Garrison?.Length ?? 0 : 0;

        string UnitTypeOf(int unitId) => session.Units.TryGet(unitId, out var u) ? session.Units.Types.Name(u.TypeIndex) : null;

        /// <summary>"2/4 inside · 2 firing · exit rally set" for a structure.</summary>
        string GarrisonSummary(int buildingId)
        {
            if (!session.Structures.Buildings.TryGetValue(buildingId, out var b)) return "";
            int n = b.Garrison?.Length ?? 0, cap = GarrisonCapacity(b.Type), slots = FiringSlots(b.Type);
            int firing = Mathf.Min(n, slots);
            string fire = slots == 0 ? "shelter only, no firing slots" : $"{firing} firing, {n - firing} sheltered";
            return $"{n}/{cap} inside · {fire}" + (b.HasGarrisonExit ? " · exit rally set" : "");
        }

        void Ungarrison(int buildingId, int unitId = 0)
        {
            var cmd = new JObject { ["c"] = "ungarrison", ["building"] = buildingId };
            if (unitId != 0) cmd["units"] = new JArray(unitId); else cmd["all"] = true;
            session.Net?.Command(cmd, r =>
            {
                int n = ProtocolDecoder.Int(r.Raw?["ungarrisoned"], unitId != 0 ? 1 : 0);
                commander.Say(Commander.ReadableError(r) ?? (n == 1 ? "1 squad stepped out" : $"{n} squads stepped out"), r.Error == null, Time.unscaledTime);
                cmdCardSignature = "";
            });
        }

        void BeginGarrisonExitRally(int buildingId) =>
            commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "garrisonRally", ["building"] = buildingId });

        void ClearGarrisonExitRally(int buildingId) =>
            Send(new JObject { ["c"] = "garrisonRally", ["building"] = buildingId, ["clear"] = true }, "Exit rally cleared");

        /// <summary>Send squads into a structure (only the eligible ones are sent; the server walks the others in).</summary>
        void GarrisonInto(int buildingId, IList<int> unitIds)
        {
            var ids = new JArray();
            foreach (int id in unitIds) { string t = UnitTypeOf(id); if (t != null && CanGarrison(t)) ids.Add(id); }
            if (ids.Count == 0) { commander.Say("Only infantry squads can garrison structures", false, Time.unscaledTime); return; }
            session.Net?.Command(new JObject { ["c"] = "garrison", ["units"] = ids, ["building"] = buildingId }, r =>
            {
                if (r.Error != null) { commander.Say(Commander.ReadableError(r), false, Time.unscaledTime); return; }
                int entered = ProtocolDecoder.Int(r.Raw?["entered"]), moving = ProtocolDecoder.Int(r.Raw?["moving"]), refused = ProtocolDecoder.Int(r.Raw?["refused"]);
                string text = entered > 0 && moving > 0 ? $"{entered} inside, {moving} moving in" : entered > 0 ? $"{entered} inside" : $"{moving} moving in";
                if (refused > 0) text += $" · {refused} refused (full or not infantry)";
                commander.Say(text, entered + moving > 0, Time.unscaledTime);
            });
        }

        /// <summary>A structure's garrison wedge: occupants as the badge; its sub-ring lists them and the exit commands.</summary>
        RadialItem GarrisonWedge(int buildingId, float? angle) => new RadialItem
        {
            Id = "garrison", Icon = "bunker", Angle = angle,
            Name = () => session.Structures.Buildings.TryGetValue(buildingId, out var b) ? $"Garrison · {b.Garrison?.Length ?? 0}/{GarrisonCapacity(b.Type)}" : "Garrison",
            Detail = () => GarrisonSummary(buildingId) + " · select infantry and right-click the structure (or Garrison on their wheel) to enter",
            Badge = () => OccupantCount(buildingId),
            Children = () => { baseSubRing = "garrison"; return GarrisonItems(buildingId); },
        };

        /// <summary>The garrison sub-ring: eject all, exit rally (set / clear) and one wedge per occupant (click selects it, right-click ejects it).</summary>
        List<RadialItem> GarrisonItems(int buildingId)
        {
            var list = new List<RadialItem>
            {
                new RadialItem
                {
                    Id = "garrison:eject", Icon = "withdraw", Title = "Eject all",
                    Detail = () => GarrisonSummary(buildingId),
                    Enabled = () => OccupantCount(buildingId) > 0,
                    Reason = () => OccupantCount(buildingId) > 0 ? null : "Nobody is inside",
                    Click = _ => Ungarrison(buildingId),
                },
                new RadialItem
                {
                    Id = "garrison:rally", Icon = "rally", Title = "Exit rally point",
                    Detail = () => "Click the ground where squads go when they step out",
                    Click = _ => { CloseWheel(); BeginGarrisonExitRally(buildingId); },
                },
                new RadialItem
                {
                    Id = "garrison:rallyclear", Icon = "close", Title = "Clear exit rally",
                    Detail = () => "Squads step out beside the structure",
                    Visible = () => session.Structures.Buildings.TryGetValue(buildingId, out var b) && b.HasGarrisonExit,
                    Click = _ => ClearGarrisonExitRally(buildingId),
                },
            };
            if (!session.Structures.Buildings.TryGetValue(buildingId, out var building)) return list;
            int cap = Mathf.Clamp(GarrisonCapacity(building.Type), 0, 6), slots = FiringSlots(building.Type);
            for (int k = 0; k < cap; k++)
            {
                int index = k;
                int Occupant() => session.Structures.Buildings.TryGetValue(buildingId, out var b) && b.Garrison != null && index < b.Garrison.Length ? b.Garrison[index] : 0;
                string type = building.Garrison != null && k < building.Garrison.Length ? UnitTypeOf(building.Garrison[k]) : null;
                list.Add(new RadialItem
                {
                    Id = "garrison:unit:" + k, Icon = type ?? "rifle_squad",
                    Name = () => { string t = UnitTypeOf(Occupant()); return t != null ? NameOf("UNITS", t) : "Occupant"; },
                    Detail = () => index < slots ? "In a firing slot: shoots from the structure (+range, +damage)" : "Sheltered: protected, not firing",
                    Caption = () => index < slots ? "fire" : null,
                    Reason = () => "Click selects · right-click ejects",
                    Visible = () => Occupant() != 0,
                    Click = _ => { int id = Occupant(); if (id != 0) commander.SelectUnits(new[] { id }); },
                    RightClickWith = _ => { int id = Occupant(); if (id != 0) Ungarrison(buildingId, id); },
                });
            }
            return list;
        }

        /// <summary>
        /// The unit wheel's Garrison sub-ring: the nearest own finished structures with free garrison room (up to
        /// eight), nearest first. Picking one sends the selected infantry squads in.
        /// </summary>
        List<RadialItem> GarrisonTargets(int[] selected)
        {
            var list = new List<RadialItem>();
            float cx = 0, cz = 0; int n = 0;
            foreach (int id in selected) if (session.Units.TryGet(id, out var u) && u.Motion.Present) { cx += u.Motion.X; cz += u.Motion.Z; n++; }
            if (n > 0) { cx /= n; cz /= n; }
            var candidates = new List<(float d, BuildingRecord b)>();
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.Owner != session.CivId || !b.Done || !b.HasPosition) continue;
                int cap = GarrisonCapacity(b.Type);
                if (cap <= 0 || (b.Garrison?.Length ?? 0) >= cap) continue;
                float dx = session.World.Grid.DxWrap(cx, b.X), dz = b.Z - cz;
                candidates.Add((dx * dx + dz * dz, b));
            }
            candidates.Sort((a, c) => a.d.CompareTo(c.d));
            for (int k = 0; k < candidates.Count && k < 8; k++)
            {
                var b = candidates[k].b;
                int bid = b.Id;
                float dist = Mathf.Sqrt(candidates[k].d);
                list.Add(new RadialItem
                {
                    Id = "enter:" + bid, Icon = Icons.BuildingKind(b.Type), Title = NameOf("BUILDINGS", b.Type),
                    Detail = () => GarrisonSummary(bid) + $" · {dist:0} away",
                    Badge = () => OccupantCount(bid),
                    Click = _ => { GarrisonInto(bid, selected); CloseWheel(); },
                });
            }
            if (list.Count == 0)
                list.Add(new RadialItem { Id = "enter:none", Icon = "bunker", Title = "No room", Enabled = () => false, Reason = () => "No own structure with free garrison room" });
            return list;
        }

        /// <summary>The pads sub-ring: one wedge per pad, pointed toward its parcel (empty pads open the facility ring).</summary>
        List<RadialItem> PadItems(int siteId)
        {
            socketItems.Clear(); socketParcels.Clear();
            var list = new List<RadialItem>();
            if (!session.Objectives.TryGetValue(siteId, out var site)) return list;
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
                    item.Icon = "lock"; item.Title = "Locked pad";
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
                        if (!b.Done) return $"Under construction {b.Progress}% · engineers are building it";
                        if (b.QueueLength > 0) return $"{b.QueueLength} in queue";
                        return b.Hp < 100 ? $"Condition {b.Hp}%" : "Open its wheel: production and upgrades";
                    };
                    // cancel a facility still under construction (right-click): only when the server offers it
                    item.Reason = () => session.Structures.Buildings.TryGetValue(occupantId, out var b) && !b.Done
                        ? CanCancelConstruction ? "Right-click cancels construction" : null : null;
                    if (CanCancelConstruction) item.RightClickWith = _ => CancelConstruction(occupantId);
                    item.Click = _ => commander.SelectRingSlot(siteId, slot);
                }
                else if (empty)
                {
                    item.Icon = "plus"; item.Title = "Empty pad"; item.Pulse = true;
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
                    item.Icon = "plus"; item.Title = "Pad";
                    item.Enabled = () => false;
                    item.Reason = () => "Pad not available";
                }
                socketParcels[id] = parcel;
                socketItems.Add(item);
                list.Add(item);
            }
            return list;
        }

        /// <summary>
        /// Cancelling a facility under construction needs a server command the action ruleset does not have yet
        /// (actionBases.demolish refuses unfinished structures). The client hook is live once the server advertises
        /// <c>RULESET.cancelConstruction</c> (command <c>{c:'cancelConstruction', id}</c>); until then it is hidden.
        /// </summary>
        bool CanCancelConstruction => ProtocolDecoder.Bool(Defs?["RULESET"]?["cancelConstruction"]);

        void CancelConstruction(int buildingId)
        {
            if (!CanCancelConstruction) return;
            if (!session.Structures.Buildings.TryGetValue(buildingId, out var b) || b.Done || b.Owner != session.CivId) return;
            Send(new JObject { ["c"] = "cancelConstruction", ["id"] = buildingId }, "Construction cancelled");
        }

        // per-frame socket assignment scratch (no allocations: the camera moves every frame)
        readonly List<(float cost, int item, int wedge)> anglePairs = new List<(float, int, int)>(96);
        bool[] angleItemDone = new bool[16];
        readonly bool[] angleWedgeDone = new bool[RadialMenu.Segments];
        static readonly Func<bool> NoWedge = () => false;

        /// <summary>
        /// Point each pad wedge (pads sub-ring) at its parcel: greedy nearest-angle assignment of parcels to the
        /// nine segments. Also sizes the base wheel to the base on screen.
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
                // the era glyph (the hub's tier pips) of the tier it leads to
                Id = "upgrade:tier", Icon = site.Tier >= 2 ? "era_up3" : "era_up2", Hotkey = InputFacade.KeyLabel("upgrade_base"), Angle = 0f,
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

        /// <summary>Near the bottom of the base wheel: build, rebuild or upgrade the city perimeter (its defense upgrades).</summary>
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
                item.Click = _ => Send(new JObject { ["c"] = "baseDefenses", ["site"] = siteId }, "Construction started", r =>
                {
                    // blocked or contested outer lots are skipped (the rest are built and paid for pro rata)
                    int skipped = ProtocolDecoder.Int(r.Raw?["skipped"]), placed = ProtocolDecoder.Int(r.Raw?["placed"]);
                    if (r.Error == null && skipped > 0)
                        commander.Say($"Perimeter: {placed} positions started · {skipped} blocked lots skipped (add them later)", true, Time.unscaledTime);
                });
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
                // circle buttons at the bottom (Ticket 3): this base's production, the rally point, every base's production
                ProductionItem(siteId),
                new RadialItem
                {
                    Id = "arc:rally", Icon = "rally", Title = "Rally point",
                    Detail = () => "Click the ground where new units from this base gather",
                    Visible = () => HasTrainersAt(siteId),
                    Click = _ => commander.Begin(Commander.Mode.Rally),
                },
                AllProductionItem(),
            };
        }

        void OpenRuinWheel(int siteId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            wheelKind = "ruin"; wheelSite = siteId;
            JToken cost = ProtocolDecoder.Int(Econ?["recovery"]) > 0 ? new JObject { ["materials"] = 140 } : Defs?["BUILDINGS"]?["town"]?["cost"];
            // 2026-11-18: the server's settlement price includes the road to the nearest own base (ROADS_AND_CLAIMS.md)
            if (site.SettleMaterials > 0) cost = new JObject { ["materials"] = site.SettleMaterials, ["energy"] = site.SettleEnergy };
            var establish = new RadialItem
            {
                Id = "establish", Icon = "hq", Title = "Establish base", Cost = cost, Seconds = ProtocolDecoder.Int(Defs?["BUILDINGS"]?["town"]?["time"]),
                Detail = () => (site.SettleRoad > 0 ? $"Includes the road to {site.SettleTo} ({site.SettleRoad} segments) · " : "")
                    + ProtocolDecoder.Str(SiteDefinition(site)?["bonus"], "Build a headquarters on this ruin"),
                Enabled = () => session.Objectives.TryGetValue(siteId, out var s) && !s.Contested,
                Reason = () => session.Objectives.TryGetValue(siteId, out var s) && s.Contested ? "Contested · clear hostile ground forces" : null,
                Click = _ => Send(new JObject { ["c"] = "establish", ["site"] = siteId }, "Construction started"),
            };
            wheel.Open(site.Name, "house", new List<RadialItem> { establish }, WorldAnchor(site.X, site.Z, .3f));
            wheel.SubjectDetail = () => "Secured ruin";
        }

        // ------------------------------------------------------------------ an empty site's facility sub-ring
        /// <summary>A pad clicked in the world (§12, or picked by the selection) opens its facility ring: Pads → pad.</summary>
        void SocketFromSelection()
        {
            int slot = commander.SelectedRingSlot;
            if (slot == 0 || wheelKind != "base" || slot == wheelEnteredSlot && wheel.Depth > 0) return;
            if (!session.Objectives.TryGetValue(wheelSite, out var site) || site.Slots == null || Array.IndexOf(site.Slots, slot) < 0) return;
            while (wheel.Depth > 0) wheel.Back();
            wheelEnteredSlot = slot;   // set first: the item's Children re-selects the same slot
            if (!wheel.EnterItem("pads")) wheelEnteredSlot = 0;   // straight into the pad's facility ring
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
                        CloseWheel();   // the menu closes once a facility is chosen (user ticket)
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
                sb.Append(b.Id).Append(b.Done ? 'd' : 'u').Append(b.Missiles > 0 ? 'm' : '-').Append(b.Project != null ? 'p' : '-').Append(b.Level).Append(UpgradeKey(b)).Append(',');
            // an outpost's plots
            foreach (var b in session.Structures.Buildings.Values) if (b.OutpostId != 0 && Array.IndexOf(ids, b.OutpostId) >= 0) sb.Append('p').Append(b.Id).Append(b.Done ? 'd' : 'u');
            return sb.ToString();
        }

        void OpenBuildingWheel(int[] ids, string titleOverride = null)
        {
            var own = OwnBuildings(ids);
            if (own.Length == 0) return;
            // 2026-11-20: a perimeter position opens the perimeter wheel (turret paths, the centre turret)
            if (own.Length == 1 && own[0].PerimeterSlot > 0 && own[0].City >= 0) { OpenPerimeterWheel(own[0].City, own[0].Id); return; }
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
                if (queued > 0)
                {
                    // the shared production budget (R1): more queues share it, they never add speed
                    float cap = 0f; int producing = 0;
                    foreach (var b in current)
                    {
                        cap += b.ProductionCapacity;
                        if (b.Queues != null) foreach (var q in b.Queues) if (q.State == "producing") producing++;
                    }
                    return cap > 0f ? $"{queued} in queue · capacity {cap:0.##}/s shared by {producing} producing" : $"{queued} in queue";
                }
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
            // 2026-11-20 (BASE_MENU_REWORK.md): an outpost is a tiny base; a production building has four units, four upgrades, one building upgrade
            if (own.Length == 1 && own[0].Type == "fort" && own[0].Done) return OutpostItems(own[0]);
            if (PairedProduction(own, out var paired)) return PairedProductionItems(own, paired);
            var trainers = own.Where(IsTrainer).Select(b => b.Id).ToArray();
            var hostTypes = new HashSet<string>(own.Where(b => b.Done).Select(b => b.Type));
            // 1. the top segment: building upgrades (era level, any techs the server offers; none since 2026-11-20)
            items.Add(UpgradesItem(all, hostTypes));
            // 2. training, one wedge per unit type across the selection (batch-queued across every host)
            var types = new List<string>();
            foreach (var b in own)
                if (b.Done && Defs?["BUILDINGS"]?[b.Type]?["trains"] is JArray trains)
                    foreach (var t in trains) { string key = (string)t; if (!types.Contains(key)) types.Add(key); }
            foreach (string type in types) items.Add(TrainItem(type, trainers));
            // W4 garrison: one garrisonable structure selected (bunker, watchtower, outpost, barracks)
            if (own.Length == 1 && own[0].Done && GarrisonCapacity(own[0].Type) > 0) items.Add(GarrisonWedge(own[0].Id, null));
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
            if (trainers.Length > 0)
                items.Add(new RadialItem
                {
                    Id = "clearqueue", Icon = "close", Title = trainers.Length == 1 ? "Clear queue" : $"Clear {trainers.Length} queues", Confirm = true,
                    Detail = () => "Cancel everything queued here · resources already spent are not refunded",
                    Visible = () => AnyQueued(HostsFor(trainers, null)),
                    Click = _ => QueueClear(HostsFor(trainers, null)),
                });
            // (no repair button since 2026-11-20: the base engineers repair automatically)
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
        /// The top segment of a building wheel. With techs (the server offers none since the Armory's removal, 2026-11-20) it is an "Upgrades" sub-ring holding
        /// the era level upgrade and the techs; with only a level upgrade it is that upgrade; otherwise disabled.
        /// </summary>
        RadialItem UpgradesItem(int[] ids, HashSet<string> hostTypes)
        {
            var level = LevelUpgradeItem(ids);
            bool techs = Defs?["TECHS"] is JObject options && options.Properties().Any(p => hostTypes.Contains(ProtocolDecoder.Str(p.Value["at"], "")));
            if (techs)
                return new RadialItem
                {
                    Id = "upgrades", Icon = "upgrade", Title = "Upgrades",
                    Detail = () => (hostTypes.Contains("barracks") ? "Infantry equipment" : "Faction-wide military upgrades") + (level != null ? " and the building's era level" : "")
                        + (ProtocolDecoder.Bool(Defs?["RULESET"]?["upgradeLines"]) ? " · one upgrade per unit class (infantry, vehicle, air) per match" : ""),
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

        /// <summary>
        /// A unit type's training wedge (W1 production, §7–9): its queue across every compatible selected building.
        /// The badge is the queued count, the green ring the current item's progress, the glyph at the top-right the
        /// queue state when it is not producing. Queueing never needs the resources up front (the order waits).
        /// Click +1 · Shift +5 · Alt one per building · Ctrl repeat. Right-click −1 · Shift+right all of this type ·
        /// Ctrl+right pause / resume · Alt+right priority (low → normal → high). Cancelling never refunds what was spent.
        /// </summary>
        RadialItem TrainItem(string type, int[] trainers)
        {
            var d = Defs?["UNITS"]?[type];
            int tier = ProtocolDecoder.Int(d?["tier"], 1);
            string facility = ProtocolDecoder.Str(d?["facility"]);
            var cost = d?["cost"];
            // the buildings that train this type (the headquarters and outposts share militia and scout buggies)
            BuildingRecord[] Hosts() => HostsFor(trainers, "unit:" + type);
            return new RadialItem
            {
                Id = "train:" + type, Icon = type, Title = NameOf("UNITS", type), Cost = cost, Seconds = ProtocolDecoder.Int(d?["time"]),
                CostAdvisory = true,
                Detail = () =>
                {
                    var hosts = Hosts();
                    var s = SummarizeQueue(hosts, type);
                    if (s.Count == 0)
                        return UnitRole(type) + $" · {ProtocolDecoder.Int(d?["capacity"])} command" + (hosts.Length > 1 ? $" · queues across {hosts.Length} buildings" : "");
                    return $"{s.Count} queued · {Mathf.RoundToInt(s.Progress)}% · {PriorityName(s.Priority)} priority" + (s.Hosts > 1 ? $" · {s.Hosts} buildings" : "")
                        + " · cancelling never refunds spent resources";
                },
                Enabled = () => tier <= Age + 1 && Hosts().Length > 0,
                Reason = () =>
                {
                    if (tier > Age + 1) return $"Requires Tier {Tier(tier)}";
                    var hosts = Hosts();
                    if (hosts.Length == 0) return "Needs " + NameOf("BUILDINGS", facility);
                    var s = SummarizeQueue(hosts, type);
                    if (s.Count == 0) return hosts.Length > 1 ? "Shift ×5 · Alt one each · Ctrl repeat" : "Shift ×5 · Ctrl repeat";
                    if (s.State == "producing" || s.State == null) return "Right-click -1 · Shift all · Ctrl pause · Alt priority";
                    return QueueStateText(s.State, type);
                },
                Badge = () => SummarizeQueue(Hosts(), type).Count,
                Progress = () =>
                {
                    var s = SummarizeQueue(Hosts(), type);
                    return s.Count > 0 ? s.Progress / 100f : -1f;
                },
                StatusIcon = () =>
                {
                    var s = SummarizeQueue(Hosts(), type);
                    return s.Count > 0 ? QueueStateIcon(s.State, type) : null;
                },
                Active = () =>
                {
                    foreach (var b in Hosts()) if (b.Repeat == type) return true;
                    return false;
                },
                Click = c =>
                {
                    var hosts = Hosts();
                    if (hosts.Length == 0) return;
                    if (c.Ctrl)
                    {
                        bool on = true;
                        foreach (var b in hosts) if (b.Repeat == type) { on = false; break; }
                        foreach (var b in hosts)
                            session.Net?.Command(new JObject { ["c"] = "repeat", ["id"] = b.Id, ["unit"] = on ? type : null },
                                r => { if (r.Error != null) commander.Say(r.Error, false, Time.unscaledTime); });
                        return;
                    }
                    QueueTrain(hosts, type, c.Shift ? 5 : 1, c.Alt && hosts.Length > 1);
                },
                RightClickWith = c =>
                {
                    var hosts = Hosts();
                    if (c.Ctrl) QueuePause(hosts, type, SummarizeQueue(hosts, type).PausedHosts < SummarizeQueue(hosts, type).Hosts);
                    else if (c.Alt) QueuePriority(hosts, type, (SummarizeQueue(hosts, type).Priority + 1) % 3);
                    else QueueCancel(hosts, type, c.Shift);
                },
            };
        }

        // ------------------------------------------------------------------ production queues (W1 contract, §7–9)
        // Hosts per (trainer list, facility), rebuilt once per snapshot: the wheel and the card poll them at 10 Hz
        int hostCacheSnap = -1;
        readonly Dictionary<(int[] ids, string facility), BuildingRecord[]> hostCache = new Dictionary<(int[], string), BuildingRecord[]>();

        /// <summary>The finished own buildings of <paramref name="facility"/> among <paramref name="ids"/> (null facility: any producer).</summary>
        BuildingRecord[] HostsFor(int[] ids, string facility)
        {
            if (hostCacheSnap != session.Snapshots) { hostCache.Clear(); hostCacheSnap = session.Snapshots; }
            var key = (ids, facility ?? "");
            if (hostCache.TryGetValue(key, out var cached)) return cached;
            var list = new List<BuildingRecord>(ids.Length);
            var defs = Defs?["BUILDINGS"];
            foreach (int id in ids)
                if (session.Structures.Buildings.TryGetValue(id, out var b) && b.Owner == session.CivId && b.Done
                    && (facility == null ? defs?[b.Type]?["trains"] is JArray : facility.StartsWith("unit:") ? TrainsHere(b, facility.Substring(5)) : b.Type == facility)) list.Add(b);
            var hosts = list.ToArray();
            hostCache[key] = hosts;
            return hosts;
        }

        /// <summary>One unit type's queue summed over several buildings.</summary>
        struct QueueSummary
        {
            public int Count, Hosts, Priority, PausedHosts;
            /// <summary>Best current-item progress, 0..100.</summary>
            public float Progress;
            /// <summary>The most telling state among the hosts (producing first, then the blocking reasons).</summary>
            public string State;
            public bool Legacy;
        }

        static int StateRank(string state) => state switch
        {
            "producing" => 0, "exit" => 1, "resources" => 2, "capacity" => 3, "prerequisites" => 4, "waiting" => 5, "paused" => 6, "idle" => 7, _ => 8
        };

        static QueueSummary SummarizeQueue(BuildingRecord[] hosts, string type)
        {
            var s = new QueueSummary { Priority = -1 };
            int rank = int.MaxValue;
            foreach (var b in hosts)
            {
                if (b.Queues == null) continue;
                foreach (var q in b.Queues)
                {
                    if (q.Unit != type || q.Count <= 0) continue;
                    s.Count += q.Count; s.Hosts++;
                    if (q.Progress > s.Progress) s.Progress = q.Progress;
                    if (q.Priority > s.Priority) s.Priority = q.Priority;
                    if (q.State == "paused") s.PausedHosts++;
                    if (!b.QueuesFromServer) s.Legacy = true;
                    int r = StateRank(q.State);
                    if (r < rank) { rank = r; s.State = q.State; }
                }
            }
            if (s.Priority < 0) s.Priority = 1;
            return s;
        }

        static string PriorityName(int priority) => priority >= 2 ? "High" : priority <= 0 ? "Low" : "Normal";

        /// <summary>The resource a queue waits for ("Materials", "Energy"), from the unit's cost against the stockpile.</summary>
        string ShortResource(string unitType)
        {
            if (!(Defs?["UNITS"]?[unitType]?["cost"] is JObject cost)) return null;
            foreach (var p in cost.Properties())
                if (ProtocolDecoder.Float(p.Value) > 0 && ResourceHave(p.Name) < 1) return p.Name == "materials" ? "Materials" : p.Name == "energy" ? "Energy" : p.Name;
            return null;
        }

        /// <summary>A queue state as the player should read it (PRODUCTION_SCHEDULER.md, qs[i][4]).</summary>
        string QueueStateText(string state, string unitType) => state switch
        {
            "producing" => "Producing",
            "resources" => ShortResource(unitType) is string r ? "Waiting for funds (" + r + ")" : "Waiting for funds",
            "capacity" => "Waiting for unit capacity",
            "prerequisites" => "Prerequisites missing",
            "exit" => "Exit blocked · clear the exit",
            "paused" => "Paused",
            "waiting" => "Waiting for production capacity",
            "idle" => "Idle",
            _ => "Queued",
        };

        /// <summary>The state glyph (never colour only): null while producing.</summary>
        string QueueStateIcon(string state, string unitType) => state switch
        {
            "resources" => ShortResource(unitType) == "Energy" ? "energy" : "materials",
            "capacity" => "command",
            "prerequisites" => "lock",
            "exit" => "close",
            "paused" => "pause",
            "waiting" => "queued",
            _ => null,
        };

        /// <summary>Queue <paramref name="count"/> (or one per building with <paramref name="each"/>); accepted without resources, it then waits.</summary>
        void QueueTrain(BuildingRecord[] hosts, string type, int count, bool each)
        {
            if (hosts.Length == 0) return;
            var ids = new JArray();
            foreach (var b in hosts) ids.Add(b.Id);
            if (each) count = hosts.Length;
            var cmd = new JObject { ["c"] = "batchTrain", ["buildings"] = ids, ["unit"] = type, ["count"] = each ? 1 : count };
            if (each) cmd["policy"] = "each";
            session.Net?.Command(cmd, r =>
            {
                int n = ProtocolDecoder.Int(r.Raw?["training"]?["queued"], count);
                string why = ProtocolDecoder.Str(r.Raw?["training"]?["reason"], "");
                string waiting = "";
                if (r.Raw?["training"]?["waiting"] is JArray wait && wait.Count > 0)
                {
                    bool res = false, cap = false;
                    foreach (var w in wait) { string k = (string)w; res |= k == "resources"; cap |= k == "capacity"; }
                    waiting = res && cap ? " · waiting for funds and unit capacity" : res ? " · waiting for funds" : cap ? " · waiting for unit capacity" : "";
                }
                if (r.Error != null) commander.Say(Commander.ReadableError(r), false, Time.unscaledTime);
                else if (n <= 0 && why.Length > 0) commander.Say(why, false, Time.unscaledTime);
                else commander.Say($"{n} × {NameOf("UNITS", type)} queued{waiting}", true, Time.unscaledTime);
                cmdCardSignature = "";
            });
        }

        /// <summary>The "lost" part of a cancel reply as text ("30 Materials, 5 Energy already spent were lost").</summary>
        static string LostText(JToken lost)
        {
            int m = Mathf.RoundToInt(ProtocolDecoder.Float(lost?["materials"])), e = Mathf.RoundToInt(ProtocolDecoder.Float(lost?["energy"]));
            if (m <= 0 && e <= 0) return "nothing had been spent yet";
            string what = m > 0 && e > 0 ? $"{m} Materials and {e} Energy" : m > 0 ? $"{m} Materials" : $"{e} Energy";
            return what + " already spent are not refunded";
        }

        void CancelReply(ServerMessage r, string what)
        {
            if (r.Error != null) { commander.Say(Commander.ReadableError(r), false, Time.unscaledTime); return; }
            var lost = r.Raw?["cancelled"]?["lost"];
            commander.Say(lost != null ? $"{what} · {LostText(lost)}" : what, true, Time.unscaledTime);
            cmdCardSignature = "";
        }

        /// <summary>
        /// Cancel one item of <paramref name="type"/> (on the building with the most queued, so an unstarted item goes
        /// first) or, with <paramref name="all"/>, the whole type on every host. Spent resources are never refunded.
        /// </summary>
        void QueueCancel(BuildingRecord[] hosts, string type, bool all)
        {
            BuildingRecord best = default; int bestCount = 0;
            foreach (var b in hosts)
            {
                if (b.Queues == null) continue;
                foreach (var q in b.Queues)
                {
                    if (q.Unit != type || q.Count <= 0) continue;
                    if (all)
                    {
                        if (!b.QueuesFromServer) { LegacyCancel(b, type, q.Count); continue; }
                        session.Net?.Command(new JObject { ["c"] = "cancelTrain", ["id"] = b.Id, ["type"] = type, ["all"] = true },
                            r => CancelReply(r, $"{NameOf("UNITS", type)} queue cancelled"));
                    }
                    else if (q.Count > bestCount) { bestCount = q.Count; best = b; }
                }
            }
            if (all || best.Id == 0) return;
            if (!best.QueuesFromServer) { LegacyCancel(best, type, 1); return; }
            session.Net?.Command(new JObject { ["c"] = "cancelTrain", ["id"] = best.Id, ["type"] = type, ["count"] = 1 },
                r => CancelReply(r, $"1 × {NameOf("UNITS", type)} cancelled"));
        }

        /// <summary>Older servers: cancel by index into the flattened queue (from the back).</summary>
        void LegacyCancel(BuildingRecord b, string type, int count)
        {
            if (b.Queue == null) return;
            int sent = 0;
            for (int i = b.Queue.Length - 1; i >= 0 && sent < count; i--)
                if (b.Queue[i] == type) { Send(new JObject { ["c"] = "cancelTrain", ["id"] = b.Id, ["index"] = i }, "Queue entry cancelled"); sent++; }
        }

        void QueuePause(BuildingRecord[] hosts, string type, bool on)
        {
            foreach (var b in hosts)
            {
                if (b.Queues == null || !b.QueuesFromServer) continue;
                foreach (var q in b.Queues)
                    if (q.Unit == type && q.Count > 0)
                        session.Net?.Command(new JObject { ["c"] = "pauseTrain", ["id"] = b.Id, ["type"] = type, ["on"] = on },
                            r => { commander.Say(Commander.ReadableError(r) ?? (on ? $"{NameOf("UNITS", type)} paused" : $"{NameOf("UNITS", type)} resumed"), r.Error == null, Time.unscaledTime); cmdCardSignature = ""; });
            }
        }

        void QueuePriority(BuildingRecord[] hosts, string type, int priority)
        {
            priority = Mathf.Clamp(priority, 0, 2);
            foreach (var b in hosts)
            {
                if (b.Queues == null || !b.QueuesFromServer) continue;
                foreach (var q in b.Queues)
                    if (q.Unit == type && q.Count > 0)
                        session.Net?.Command(new JObject { ["c"] = "setPriority", ["id"] = b.Id, ["type"] = type, ["priority"] = priority },
                            r => { commander.Say(Commander.ReadableError(r) ?? $"{NameOf("UNITS", type)}: {PriorityName(priority)} priority", r.Error == null, Time.unscaledTime); cmdCardSignature = ""; });
            }
        }

        /// <summary>Drop every queue of every host (clearQueue). Spent resources are never refunded.</summary>
        void QueueClear(BuildingRecord[] hosts)
        {
            foreach (var b in hosts)
            {
                if (b.QueueLength <= 0 && (b.Queues == null || b.Queues.Length == 0)) continue;
                if (!b.QueuesFromServer) { if (b.Queue != null) for (int i = b.Queue.Length - 1; i >= 0; i--) Send(new JObject { ["c"] = "cancelTrain", ["id"] = b.Id, ["index"] = i }, "Queue cleared"); continue; }
                session.Net?.Command(new JObject { ["c"] = "clearQueue", ["id"] = b.Id }, r => CancelReply(r, "Queue cleared"));
            }
        }

        /// <summary>True when any host has something queued (allocation-free, polled at 10 Hz).</summary>
        static bool AnyQueued(BuildingRecord[] hosts)
        {
            foreach (var b in hosts) if (b.QueueLength > 0 || b.Queues != null && b.Queues.Length > 0) return true;
            return false;
        }

        /// <summary>True when every queuing host speaks the W1 contract (priority and pause need it).</summary>
        static bool QueuesModern(BuildingRecord[] hosts)
        {
            foreach (var b in hosts) if (b.Queues != null && b.Queues.Length > 0 && !b.QueuesFromServer) return false;
            return true;
        }

        /// <summary>The server takes <c>cancelResearch</c> (RULESET.cancelResearch, 2026-11-18).</summary>
        bool CanCancelResearch => ProtocolDecoder.Bool(Defs?["RULESET"]?["cancelResearch"]);

        /// <summary>
        /// The upgrade that already holds <paramref name="line"/> for this player, other than <paramref name="except"/>:
        /// researched (econ <c>techs</c>) or in progress (econ <c>research</c>), as the server's upgradeLineHolder; or null.
        /// </summary>
        string UpgradeLineHolder(string line, string except)
        {
            var defs = Defs?["TECHS"];
            if (line == null || defs == null) return null;
            if (Econ?["techs"] is JArray done)
                foreach (var t in done)
                {
                    string k = ProtocolDecoder.Str(t);
                    if (k != null && k != except && ProtocolDecoder.UpgradeLine(defs[k]) == line) return k;
                }
            if (Econ?["research"] is JArray running)
                foreach (var t in running)
                {
                    string k = ProtocolDecoder.Str(t["key"]);
                    if (k != null && k != except && ProtocolDecoder.UpgradeLine(defs[k]) == line) return k;
                }
            return null;
        }

        List<RadialItem> TechItems(int[] ids, HashSet<string> hostTypes)
        {
            var list = new List<RadialItem>();
            if (!(Defs?["TECHS"] is JObject options)) return list;
            foreach (var option in options.Properties())
            {
                var d = option.Value;
                string key = option.Name, at = ProtocolDecoder.Str(d["at"], "");
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
                // one upgrade per unit class (2026-11-18, UPGRADES.md): the line's other upgrades lock once one is chosen
                string line = ProtocolDecoder.UpgradeLine(d), lineName = ProtocolDecoder.UpgradeLineName(line);
                string Holder() => line == null ? null : UpgradeLineHolder(line, key);
                bool Chosen() => Complete() || Active() != null;
                string desc = ProtocolDecoder.Str(d["desc"], "");
                list.Add(new RadialItem
                {
                    Id = "tech:" + key, Title = NameOf("TECHS", key), Cost = d["cost"], Seconds = ProtocolDecoder.Int(d["time"]),
                    Icon = Complete() ? "check" : "upgrade",
                    Caption = line == null ? null : (Func<string>)(() => lineName),
                    // a free line asks for a second click ("Confirm"): the choice is permanent for the match
                    Confirm = line != null,
                    Detail = () =>
                    {
                        if (line == null) return desc;
                        if (Chosen()) return $"{lineName} path · " + desc;
                        string holder = Holder();
                        if (holder != null) return $"{lineName} path: {NameOf("TECHS", holder)} · " + desc;
                        return $"Permanent choice: your only {lineName.ToLowerInvariant()} upgrade this match, the other {lineName.ToLowerInvariant()} upgrades lock · " + desc;
                    },
                    Enabled = () => !Complete() && Active() == null && Holder() == null && tier <= Age + 1 && Host().Id != 0 && Host().Project == null,
                    Reason = () =>
                    {
                        if (Complete()) return line != null ? $"{lineName} path · complete" : "Complete";
                        var running = Active();
                        if (running != null)
                            return $"Researching · {ProtocolDecoder.Int(running["progress"])}%" + (CanCancelResearch ? " · Shift+right-click cancels (no refund)" : "");
                        string holder = Holder();
                        if (holder != null) return $"Locked · {lineName} path: {NameOf("TECHS", holder)} · one upgrade per unit class";
                        if (tier > Age + 1) return $"Requires Tier {Tier(tier)}";
                        if (Host().Id == 0) return "Needs " + NameOf("BUILDINGS", at);
                        if (Host().Project != null) return "The facility is busy";
                        if (line != null) return $"Choose your {lineName.ToLowerInvariant()} path · click twice to confirm";
                        return null;
                    },
                    Progress = () => { var running = Active(); return running != null ? ProtocolDecoder.Int(running["progress"]) / 100f : -1f; },
                    Click = _ => Send(new JObject { ["c"] = "research", ["tech"] = key, ["id"] = Host().Id }, "Upgrade started"),
                    // cancelResearch (server-advertised): abandons it, the cost is not refunded, and its line is free again
                    RightClickWith = c =>
                    {
                        if (!c.Shift || !CanCancelResearch || Active() == null) return;
                        session.Net?.Command(new JObject { ["c"] = "cancelResearch", ["tech"] = key },
                            r => CancelReply(r, $"{NameOf("TECHS", key)} cancelled" + (line != null ? $" · {lineName.ToLowerInvariant()} path free again" : "")));
                    },
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
        // 2026-11-20 (Ticket 3): the New Base option is gone (outposts are the tiny bases); the artillery emplacement takes its segment
        static readonly string[] BuildWheelOrder = { "trench", "road", "barricade", "guard_post", "bunker", "turret", "aa_battery", "fort", "artillery_post" };
        /// <summary>Support emplacements on the outer arc (any other field building the server adds joins them).</summary>
        static readonly string[] BuildWheelExtras = { "sensor_post", "repair_point" };

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
                    Detail = () => "Drag a route through your territory and release to build. 15 Materials per link, 40 per bridge link: a road over a river lays its bridge (matches start without bridges).",
                    Click = _ => { CloseWheel(); commander.BeginRoad(); },
                };
            var d = Defs?["BUILDINGS"]?[key];
            int tier = ProtocolDecoder.Int(d?["tier"], 1);
            string type = key;
            string name = newBase ? "New base" : d != null ? NameOf("BUILDINGS", key) : key;
            string desc = ProtocolDecoder.Str(d?["desc"], newBase ? "Found a new base in your territory beside a road." : "Field defense.")
                .Replace(" Q / E rotates before placement.", "");
            // ring of influence (server DEFENSE_INFLUENCE): defenses far from your bases' own land cost more
            var influence = Defs?["RULESET"]?["influence"];
            // W2: neutral infrastructure (sensor post, repair station) also goes on neutral ground, same surcharge
            bool neutralGround = ProtocolDecoder.Bool(d?["defense"]) || ProtocolDecoder.Bool(d?["neutral"]);
            if (neutralGround && influence != null)
                desc += $" Can also go on neutral ground; costs ×{ProtocolDecoder.Float(influence["factor"], 2):0.#} more than {ProtocolDecoder.Int(influence["reach"], 8)} hexes beyond your territory.";
            // 2026-11-18 road rule: every defense but the sandbag barricade stands beside roads (a click on one snaps off it)
            bool offRoad = !newBase && key != "barricade" && ProtocolDecoder.Bool(d?["defense"]);
            if (offRoad) desc += " Not on roads: a click on one places it beside the road.";
            else if (key == "barricade") desc += " May block a road.";
            return new RadialItem
            {
                Id = "build:" + key, Icon = newBase ? "new_base" : Icons.BuildingKind(key), Title = name,
                Cost = d?["cost"], Seconds = ProtocolDecoder.Int(d?["time"]),
                Detail = () => desc,
                Enabled = () => Defs?["BUILDINGS"]?[type] != null && tier <= Age + 1,
                Reason = () => Defs?["BUILDINGS"]?[type] == null ? "Not available on this server" : tier > Age + 1 ? $"Requires Tier {Tier(tier)}"
                    : newBase ? "Inside your territory, on or beside a road" : neutralGround ? "Your land or neutral ground · , . rotate · Shift places several" : "Inside your territory · , . rotate · Shift places several",
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
                    "raise" => "Engineers heap up the ground along a stroke",
                    "lower" => "Engineers dig the ground down along a stroke",
                    "flatten" => "Levels a stroke to the height where it starts",
                    "smooth" => "Evens out rough ground along a stroke",
                    _ => "Paint a stroke to reshape the ground",
                };
                detail += " · " + InputFacade.KeyLabel("brush_smaller") + " " + InputFacade.KeyLabel("brush_larger") + " size";
                list.Add(new RadialItem
                {
                    Id = "terrain:" + o, Icon = "terrain_" + o, Title = title,
                    Cost = works?["cost"], Seconds = ProtocolDecoder.Int(works?["time"]),
                    Detail = () => detail,
                    Enabled = () => Defs?["RULESET"]?["terrain"] != null,
                    Reason = () => Defs?["RULESET"]?["terrain"] == null ? "Terrain works are not available on this server" : "Cost per 7 hexes · drag across your territory",
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
                new RadialItem { Id = "attack_move", Icon = "attack_move", Title = "Attack-move", Hotkey = InputFacade.KeyLabel("attack"),
                    Detail = () => "Advance and engage enemies along the route",
                    Click = _ => commander.Begin(Commander.Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true }) },
                new RadialItem { Id = "hold", Icon = "hold", Title = "Hold position", Hotkey = InputFacade.KeyLabel("hold"),
                    Detail = () => "Stop and defend this position",
                    Click = _ => commander.UnitCommand("hold", null, "Holding position") },
                new RadialItem { Id = "withdraw", Icon = "withdraw", Title = "Withdraw", Hotkey = InputFacade.KeyLabel("withdraw"),
                    Detail = () => "Fall back to the nearest friendly headquarters",
                    Click = _ => commander.UnitCommand("withdraw", null, "Retreat ordered") },
            };
            // passive abilities (the support truck's automatic field repair, 2026-11-20) have no button
            foreach (string ability in types.Where(t => !ProtocolDecoder.Bool(Defs?["UNITS"]?[t]?["passive"])).Select(t => ProtocolDecoder.Str(Defs?["UNITS"]?[t]?["ability"])).Where(a => !string.IsNullOrEmpty(a)).Distinct())
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
            // W4 garrison: infantry squads enter a nearby own structure; squads already inside can step out
            var inside = selected.Where(id => session.Units.TryGet(id, out var u) && (u.Flags & InsideFlag) != 0).ToArray();
            if (inside.Length > 0)
                items.Add(new RadialItem { Id = "ungarrison", Icon = "withdraw", Title = "Leave structure", Detail = () => $"{inside.Length} inside · step out (to the exit rally point when one is set)",
                    Click = _ =>
                    {
                        session.Net?.Command(new JObject { ["c"] = "ungarrison", ["units"] = new JArray(inside) },
                            r => commander.Say(Commander.ReadableError(r) ?? $"{ProtocolDecoder.Int(r.Raw?["ungarrisoned"], inside.Length)} stepped out", r.Error == null, Time.unscaledTime));
                    } });
            else if (types.Any(CanGarrison) && Defs?["RULESET"]?["garrison"] != null)
                items.Add(new RadialItem { Id = "garrison", Icon = "bunker", Title = "Garrison", Detail = () => "Enter a nearby structure: protection, and firing slots where it has them",
                    Children = () => GarrisonTargets(selected) });
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
