using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>One wedge (or outer-arc button) of a <see cref="RadialMenu"/>.</summary>
    public sealed class RadialItem
    {
        public string Id, Icon, Title, Hotkey;
        public JToken Cost;
        public int Seconds;
        /// <summary>False: the wedge is disabled (dimmed, lock glyph); the reason explains why.</summary>
        public Func<bool> Enabled;
        /// <summary>Shown when disabled (or as an informational line when enabled).</summary>
        public Func<string> Reason;
        /// <summary>Queued count, shown at the bottom of the item; 0 hides it.</summary>
        public Func<int> Badge;
        /// <summary>0..1 progress: a green ring that fills around the item's icon; below 0 hides it.</summary>
        public Func<float> Progress;
        /// <summary>Toggled state (repeat production on): green inner stroke.</summary>
        public Func<bool> Active;
        /// <summary>Two-step: the first click arms the wedge (red "Confirm"), a second within 4 s executes.</summary>
        public bool Confirm;
        public Action<RadialClick> Click;
        public Action RightClick;
        /// <summary>A sub-ring replacing this ring (Upgrades, Air missions, an empty site's facilities).</summary>
        public Func<IList<RadialItem>> Children;
        /// <summary>
        /// Fixed angle in degrees clockwise from 12 o'clock, snapped to one of the nine 40° segments (base wheel:
        /// upgrade at 0°, sockets, perimeter near the bottom); null = automatic (in order, clockwise from the top).
        /// </summary>
        public float? Angle;
        /// <summary>Hover enter/leave, for world highlights.</summary>
        public Action<bool> Hover;
        /// <summary>Dynamic title (overrides <see cref="Title"/>).</summary>
        public Func<string> Name;
        /// <summary>A short description in the centre circle.</summary>
        public Func<string> Detail;
        /// <summary>Micro text under the icon (a locked socket's tier numeral).</summary>
        public Func<string> Caption;
        /// <summary>0..1 cooldown remaining: darkens the wedge clockwise.</summary>
        public Func<float> Cooldown;
        /// <summary>False: the item takes no wedge (commands that do not apply right now).</summary>
        public Func<bool> Visible;
        /// <summary>A slow brass pulse on the outer stroke (empty sockets glow).</summary>
        public bool Pulse;

        public string TitleText => Name?.Invoke() ?? Title ?? "";
    }

    public struct RadialClick { public bool Shift, Ctrl, Alt; }

    /// <summary>
    /// The command wheel (2026-11-16 rework, plan §2.G): always nine 40° segments (odd, so there is a clear top)
    /// that meet each other and the enlarged centre circle with no gap. The centre circle shows the hovered item's
    /// name, description and cost (nothing is drawn below the wheel and nothing covers the icons). A next-page
    /// segment appears only when a ring has more than nine items. Progress is a green ring filling around the
    /// item's icon with the queued count at the bottom of the item. The backing is ~86 % opaque with a subtle
    /// blur-free drop shadow so it reads over busy bases. The wheel stays inside the safe area, out of the
    /// minimap circle and out of every <see cref="KeepOut"/> rectangle (bottom-centre dock, selection panel,
    /// minimap console). Digits 1–9 pick wedges clockwise from 12 o'clock, 0 is the next page.
    ///
    /// Performance: the wheel moves with a transform (no layout pass), item callbacks are sampled at 10 Hz or
    /// when the hover changes, children are positioned only when the ring's layout changes, and the vector mesh
    /// is regenerated only when something it draws changed. No per-frame allocations.
    /// </summary>
    public sealed class RadialMenu : VisualElement
    {
        public const int Segments = 9;
        public const float SegmentSpan = 360f / Segments;
        public const float HubRadius = 70f, InnerRadius = HubRadius, OuterRadius = 158f, IconRadius = 114f, IconSize = 30f,
            ProgressRadius = 20f, ArcRadius = 196f, ArcButtonRadius = 20f, HotRadius = 226f;
        const float Half = 232f;        // the element is 464×464; its centre is the wheel centre
        const int NoHit = -1, HubHit = 1000, ArcHit = 2000;
        const float OpenSeconds = .16f, CloseSeconds = .12f, SampleSeconds = .1f;
        // hover highlights ease in and out over about HoverSeconds; progress rings ease to a new value over ProgressSeconds
        const float HoverSeconds = .09f, ProgressSeconds = .3f;

        // ~86 % opaque dark glass: busy bases do not bleed through, icons and text stay fully opaque on top
        static readonly Color Surface = new Color(12 / 255f, 18 / 255f, 21 / 255f, .86f);
        static readonly Color SurfaceEmpty = new Color(16 / 255f, 22 / 255f, 25 / 255f, .74f);
        static readonly Color SurfaceButton = new Color(20 / 255f, 28 / 255f, 31 / 255f, .88f);
        static readonly Color SurfaceHover = new Color(52 / 255f, 64 / 255f, 60 / 255f, .94f);
        static readonly Color HubSurface = new Color(9 / 255f, 13 / 255f, 15 / 255f, .94f);
        static readonly Color HubHover = new Color(40 / 255f, 50 / 255f, 48 / 255f, .96f);
        static readonly Color Line = new Color(1f, 1f, 1f, .16f);       // hairline separators (no gaps)
        static readonly Color Rim = new Color(0f, 0f, 0f, .55f);        // dark outer rim: contrast on bright ground
        static readonly Color Shadow = new Color(0f, 0f, 0f, .20f);     // blur-free drop shadow
        static readonly Color ShadowNear = new Color(0f, 0f, 0f, .22f);
        static readonly Color Accent = new Color(226 / 255f, 182 / 255f, 96 / 255f, 1f);
        static readonly Color GlowWide = new Color(226 / 255f, 182 / 255f, 96 / 255f, .10f);
        static readonly Color GlowNear = new Color(226 / 255f, 182 / 255f, 96 / 255f, .26f);
        static readonly Color GlowFill = new Color(226 / 255f, 182 / 255f, 96 / 255f, .07f);
        static readonly Color Good = new Color(110 / 255f, 214 / 255f, 120 / 255f, 1f);
        static readonly Color Warn = new Color(240 / 255f, 188 / 255f, 86 / 255f, 1f);
        static readonly Color Bad = new Color(242 / 255f, 116 / 255f, 96 / 255f, 1f);
        static readonly Color Armed = new Color(170 / 255f, 60 / 255f, 40 / 255f, .90f);
        static readonly Color TextColor = new Color(232 / 255f, 226 / 255f, 210 / 255f, 1f);
        static readonly Color Friendly = new Color(74 / 255f, 150 / 255f, 255 / 255f, 1f);
        static readonly Color CooldownShade = new Color(0, 0, 0, .45f);
        static readonly Color ProgressTrack = new Color(0, 0, 0, .55f);
        static readonly Color PipOff = new Color(1, 1, 1, .18f);
        static readonly Color PageOff = new Color(1, 1, 1, .3f);

        sealed class Level { public IList<RadialItem> Items; public int Page; }
        /// <summary>One of the nine segments: an item, the next-page segment, or empty.</summary>
        struct Slot { public RadialItem Item; public float Mid; public bool More, Empty; public int Key; }
        /// <summary>The item callbacks sampled at 10 Hz (painting and the children read these, never the callbacks).</summary>
        struct SlotState { public bool Usable, Active; public int Badge; public float Cooldown, Progress; public string Caption; }

        readonly Func<string, int> have;
        readonly List<Level> levels = new List<Level>();
        readonly Slot[] slots = new Slot[Segments];
        readonly List<(RadialItem item, float angle)> arc = new List<(RadialItem, float)>();
        readonly IconElement[] icons = new IconElement[Segments], locks = new IconElement[Segments];
        readonly Label[] badges = new Label[Segments], captions = new Label[Segments];
        readonly int[] badgeShown = new int[Segments];
        readonly List<IconElement> arcIcons = new List<IconElement>();
        // centre circle: name, description, cost, reason
        readonly VisualElement info, infoCost;
        readonly IconElement infoGlyph, infoMaterialsIcon, infoEnergyIcon;
        readonly Label infoName, infoDetail, infoMaterials, infoEnergy, infoTime, infoKey, infoReason;

        IList<RadialItem> outerArc;
        RadialItem hub;
        string hubIcon = "", subject = "";
        Func<Vector2?> anchor;
        bool keyboard;
        float openedAt, now;
        int pages = 1;
        int hover = NoHit;
        RadialItem hovered;
        string armedId;
        float armedUntil, pulseUntil;
        string flash;
        bool flashShown;
        Vector2 centre;

        // layout change detection (no per-frame key strings)
        bool layoutValid;
        float layoutAt;
        int arcVisible;
        readonly List<RadialItem> scratch = new List<RadialItem>(), lastItems = new List<RadialItem>();
        readonly List<int> lastAngles = new List<int>();
        readonly List<RadialItem> arcScratch = new List<RadialItem>(), lastArc = new List<RadialItem>();
        int lastLevels = -1, lastPage = -1;

        // sampled state
        readonly SlotState[] state = new SlotState[Segments];
        bool[] arcUsable = new bool[6];
        float hubProgress = -1f, hubProgressShown = -1f;
        // eased presentation (0..1 hover glow per segment, per outer-arc button and the hub; shown progress per segment)
        readonly float[] hoverGlow = new float[Segments], progressShown = new float[Segments];
        float[] arcGlow = new float[6];
        float hubGlow;
        bool easing;
        int pips, page;
        bool anyPulse, forceSample, paintDirty;
        float sampleAt;
        string paintedHighlight;

        // presentation: transform-driven open/close and zoom scale
        bool shown, reducedMotion;
        float shownAt, closingAt = -1f, zoom = 1f, lastTick = -1f;
        Vector2 placedAt = new Vector2(float.NaN, float.NaN);
        float placedScale = float.NaN, placedOpacity = float.NaN;

        /// <summary>The pointer in panel coordinates (set by the host every frame before <see cref="Tick"/>).</summary>
        public Vector2 Pointer;
        /// <summary>An item highlighted from the world (hovering a parcel highlights its socket wedge).</summary>
        public string HighlightId;
        /// <summary>Tier pips at the bottom of the centre circle (base wheel); null or 0 hides them.</summary>
        public Func<int> HubPips;
        /// <summary>The centre circle's description while nothing is hovered.</summary>
        public Func<string> SubjectDetail;
        /// <summary>Raised with the reason when a disabled wedge is clicked (the host toasts it).</summary>
        public Action<string> Refused;
        /// <summary>Optional shared (per-frame cached) panel pick; null uses panel.Pick.</summary>
        public Func<Vector2, VisualElement> Picker;
        /// <summary>
        /// Panel-space rectangles the wheel must never cover (bottom-centre dock, selection panel, minimap console).
        /// The host refills this list (no allocation) before <see cref="Tick"/>.
        /// </summary>
        public readonly List<Rect> KeepOut = new List<Rect>(8);
        /// <summary>
        /// Requested size factor (1 = design size). The base wheel grows a little when the camera is close so it
        /// keeps its proportion to the base; changes are eased. Reset to 1 by <see cref="Open"/>.
        /// </summary>
        public float Scale = 1f;

        public bool IsOpen { get; private set; }
        public bool Hot { get; private set; }
        /// <summary>0 at the root ring, 1+ inside sub-rings.</summary>
        public int Depth => Mathf.Max(0, levels.Count - 1);
        public Vector2 Centre => centre;
        public string Subject => subject;
        /// <summary>The id of the hovered item (null when none).</summary>
        public string HoveredId => hovered?.Id;
        /// <summary>The eased size factor currently applied.</summary>
        public float CurrentScale => zoom;
        float BoundRadius => arcVisible > 0 && levels.Count == 1 ? ArcRadius + ArcButtonRadius + 4f : OuterRadius + 6f;
        public Rect WheelBounds
        {
            get { float r = BoundRadius * zoom; return new Rect(centre.x - r, centre.y - r, r * 2, r * 2); }
        }

        public RadialMenu(Func<string, int> resourceHave)
        {
            have = resourceHave;
            AddToClassList("se-radial");
            style.position = Position.Absolute;
            style.width = Half * 2; style.height = Half * 2;
            // positioned with translate (no layout pass when the wheel follows the camera)
            style.left = 0; style.top = 0;
            style.display = DisplayStyle.None;
            pickingMode = PickingMode.Position;
            usageHints = UsageHints.DynamicTransform;
            generateVisualContent += Paint;

            for (int i = 0; i < Segments; i++)
            {
                slots[i] = new Slot { Empty = true, Mid = SegmentAngle(i) };
                var icon = new IconElement("", "se-radial-icon"); Add(icon); icons[i] = icon;
                var lockIcon = new IconElement("lock", "se-radial-lock") { Tint = Warn }; Add(lockIcon); locks[i] = lockIcon;
                var badge = new Label("") { pickingMode = PickingMode.Ignore }; badge.AddToClassList("se-radial-badge"); Add(badge); badges[i] = badge; badgeShown[i] = -1;
                badge.style.position = Position.Absolute; badge.style.width = 24; badge.style.height = 15;
                var caption = new Label("") { pickingMode = PickingMode.Ignore }; caption.AddToClassList("se-radial-caption"); Add(caption); captions[i] = caption;
                caption.style.position = Position.Absolute; caption.style.width = 36; caption.style.height = 14;
                icon.style.display = DisplayStyle.None; badge.style.display = DisplayStyle.None; caption.style.display = DisplayStyle.None; lockIcon.style.display = DisplayStyle.None;
            }

            // the centre circle's text column (inside the hub, above the tier pips / page dots)
            info = new VisualElement { pickingMode = PickingMode.Ignore };
            info.AddToClassList("se-radial-info");
            info.style.position = Position.Absolute;
            info.style.left = Half - HubRadius + 12; info.style.width = (HubRadius - 12) * 2;
            info.style.top = Half - HubRadius + 10; info.style.height = HubRadius * 2 - 32;
            info.style.flexDirection = FlexDirection.Column; info.style.alignItems = Align.Center; info.style.justifyContent = Justify.Center;
            info.style.overflow = Overflow.Hidden;
            Add(info);
            infoGlyph = new IconElement("", "se-radial-hub-icon");
            infoGlyph.style.position = Position.Relative; infoGlyph.style.width = 24; infoGlyph.style.height = 24; infoGlyph.style.flexShrink = 0; infoGlyph.style.marginBottom = 2;
            info.Add(infoGlyph);
            infoName = MakeLabel(info, "se-radial-info-name");
            infoName.style.whiteSpace = WhiteSpace.Normal; infoName.style.unityTextAlign = TextAnchor.MiddleCenter;
            infoName.style.maxHeight = 36; infoName.style.overflow = Overflow.Hidden; infoName.style.flexShrink = 0;
            infoDetail = MakeLabel(info, "se-radial-info-detail");
            infoDetail.style.whiteSpace = WhiteSpace.Normal; infoDetail.style.unityTextAlign = TextAnchor.UpperCenter;   // a long detail clips at its end, never its start
            infoDetail.style.maxHeight = 42; infoDetail.style.overflow = Overflow.Hidden; infoDetail.style.flexShrink = 1;
            infoCost = new VisualElement { pickingMode = PickingMode.Ignore };
            infoCost.AddToClassList("se-radial-info-cost");
            infoCost.style.flexDirection = FlexDirection.Row; infoCost.style.alignItems = Align.Center; infoCost.style.justifyContent = Justify.Center; infoCost.style.flexShrink = 0;
            info.Add(infoCost);
            infoMaterialsIcon = new IconElement("materials", "se-radial-cost-icon");
            infoMaterialsIcon.style.width = 12; infoMaterialsIcon.style.height = 12; infoMaterialsIcon.style.marginRight = 2;
            infoCost.Add(infoMaterialsIcon);
            infoMaterials = MakeLabel(infoCost, "se-radial-cost-value");
            infoEnergyIcon = new IconElement("energy", "se-radial-cost-icon");
            infoEnergyIcon.style.width = 12; infoEnergyIcon.style.height = 12; infoEnergyIcon.style.marginRight = 2;
            infoCost.Add(infoEnergyIcon);
            infoEnergy = MakeLabel(infoCost, "se-radial-cost-value");
            infoTime = MakeLabel(infoCost, "se-radial-cost-time");
            infoKey = MakeLabel(infoCost, "se-radial-info-key");
            infoReason = MakeLabel(info, "se-radial-info-reason");
            infoReason.style.whiteSpace = WhiteSpace.Normal; infoReason.style.unityTextAlign = TextAnchor.UpperCenter;
            infoReason.style.maxHeight = 28; infoReason.style.overflow = Overflow.Hidden; infoReason.style.flexShrink = 0;

            RegisterCallback<PointerDownEvent>(OnPointerDown);
            RegisterCallback<WheelEvent>(OnWheel);
        }

        static Label MakeLabel(VisualElement parent, string cls)
        {
            var l = new Label("") { pickingMode = PickingMode.Ignore };
            l.AddToClassList(cls);
            parent.Add(l);
            return l;
        }

        static void Place(VisualElement e, float x, float y, float size)
        {
            e.style.position = Position.Absolute;
            e.style.width = size; e.style.height = size;
            e.style.left = x - size * .5f; e.style.top = y - size * .5f;
        }

        /// <summary>Show or hide without touching the style when it already matches (no style/layout invalidation).</summary>
        static void Show(VisualElement e, bool on)
        {
            var d = on ? DisplayStyle.Flex : DisplayStyle.None;
            if (e.style.display != d) e.style.display = d;
        }

        static void SetText(Label l, string text)
        {
            text ??= "";
            if (l.text != text) l.text = text;
        }

        static Vector2 Dir(float degrees)
        {
            float r = degrees * Mathf.Deg2Rad;
            return new Vector2(Mathf.Sin(r), -Mathf.Cos(r));
        }

        static Vector2 At(float radius, float degrees) => new Vector2(Half, Half) + Dir(degrees) * radius;

        static float Normalize(float degrees) { degrees %= 360f; return degrees < 0 ? degrees + 360f : degrees; }

        /// <summary>The segment (0..8, clockwise from 12 o'clock) containing an angle.</summary>
        public static int SegmentOf(float degrees) => (int)(Normalize(degrees + SegmentSpan * .5f) / SegmentSpan) % Segments;

        /// <summary>The centre angle of a segment (0..8).</summary>
        public static float SegmentAngle(int segment) => ((segment % Segments) + Segments) % Segments * SegmentSpan;

        // ------------------------------------------------------------------ opening and navigation
        public void Open(string subject, string hubIcon, IList<RadialItem> items, Func<Vector2?> anchor, RadialItem hub = null, IList<RadialItem> outerArc = null, bool keyboardOpened = false)
        {
            if (IsOpen) SetHover(NoHit);
            this.subject = subject ?? "";
            this.hubIcon = hubIcon ?? "";
            this.anchor = anchor;
            this.hub = hub;
            this.outerArc = outerArc;
            keyboard = keyboardOpened;
            openedAt = now;
            levels.Clear();
            levels.Add(new Level { Items = items ?? new List<RadialItem>(), Page = 0 });
            armedId = null; flash = null; HighlightId = null; HubPips = null; SubjectDetail = null;
            Scale = 1f;
            reducedMotion = App.GameSettings.ReducedMotion || App.GameSettings.ReduceUiMotion;
            System.Array.Clear(hoverGlow, 0, Segments); System.Array.Clear(arcGlow, 0, arcGlow.Length); hubGlow = 0f;
            for (int i = 0; i < Segments; i++) progressShown[i] = -1f;
            hubProgressShown = -1f;
            layoutValid = false; forceSample = true; paintDirty = true;
            IsOpen = true;
            closingAt = -1f;
            Hide();   // shown by Tick once the anchor resolves (and animates in from there)
        }

        /// <summary>Replace the root ring and outer arc (structure changed) without closing; sub-rings are kept.</summary>
        public void ReplaceRoot(IList<RadialItem> items, IList<RadialItem> outerArcItems = null, RadialItem hubItem = null)
        {
            if (!IsOpen || levels.Count == 0) return;
            levels[0].Items = items ?? new List<RadialItem>();
            outerArc = outerArcItems;
            if (hubItem != null) hub = hubItem;
            layoutValid = false;
        }

        /// <summary>The host changed something the layout depends on (fixed wedge angles): re-layout this frame.</summary>
        public void InvalidateLayout() => layoutValid = false;

        public void Close()
        {
            if (!IsOpen) return;
            SetHover(NoHit);
            IsOpen = false; Hot = false;
            levels.Clear();
            anchor = null; hub = null; outerArc = null; armedId = null; flash = null; HighlightId = null;
            // fade out (the wedges and icons stay as they were for the 100 ms fade; nothing is picked)
            if (shown && !reducedMotion) closingAt = now;
            else FinishClose();
        }

        void FinishClose()
        {
            closingAt = -1f;
            for (int i = 0; i < Segments; i++) slots[i] = new Slot { Empty = true, Mid = SegmentAngle(i) };
            arc.Clear(); arcVisible = 0;
            layoutValid = false;
            Hide();
        }

        void Hide()
        {
            if (!shown && style.display == DisplayStyle.None) return;
            shown = false;
            style.display = DisplayStyle.None;
        }

        /// <summary>Sub-ring → parent ring. False at the root.</summary>
        public bool Back()
        {
            if (!IsOpen || levels.Count <= 1) return false;
            SetHover(NoHit);
            levels.RemoveAt(levels.Count - 1);
            armedId = null; layoutValid = false;
            return true;
        }

        /// <summary>Open the sub-ring of an item on the current ring (e.g. an empty site picked in the world). True when entered.</summary>
        public bool EnterItem(string itemId)
        {
            if (!IsOpen || string.IsNullOrEmpty(itemId)) return false;
            var level = levels[levels.Count - 1];
            foreach (var item in level.Items)
            {
                if (item == null || item.Id != itemId || item.Children == null) continue;
                if (!Usable(item)) return false;
                SetHover(NoHit);
                levels.Add(new Level { Items = item.Children() ?? new List<RadialItem>(), Page = 0 });
                armedId = null; layoutValid = false; forceSample = true;
                return true;
            }
            return false;
        }

        public void Page(int direction)
        {
            if (!IsOpen || pages <= 1) return;
            var level = levels[levels.Count - 1];
            level.Page = (level.Page + direction + pages) % pages;
            SetHover(NoHit);
            layoutValid = false;
        }

        /// <summary>The wedge angle of an item on the current ring (degrees clockwise from 12 o'clock), or NaN.</summary>
        public float AngleOf(string itemId)
        {
            for (int i = 0; i < Segments; i++) if (!slots[i].More && !slots[i].Empty && slots[i].Item?.Id == itemId) return slots[i].Mid;
            return float.NaN;
        }

        /// <summary>Panel position of an item's icon on the current ring.</summary>
        public Vector2 IconPosition(string itemId)
        {
            float a = AngleOf(itemId);
            return float.IsNaN(a) ? centre : centre + Dir(a) * (IconRadius * zoom);
        }

        /// <summary>Digit 1–9 (clockwise from 12 o'clock) or 0 (next page). True when the key was used.</summary>
        public bool PressDigit(int digit, bool shift, bool ctrl)
        {
            if (!IsOpen) return false;
            if (digit == 0) { if (pages > 1) { Page(1); return true; } return false; }
            for (int i = 0; i < Segments; i++)
                if (!slots[i].Empty && slots[i].Key == digit) { Execute(i, shift, ctrl, false); return true; }
            return false;
        }

        /// <summary>Activate an item of the current ring by id (e.g. U upgrades from the base wheel's top segment). True when found.</summary>
        public bool PressItem(string itemId)
        {
            if (!IsOpen) return false;
            for (int i = 0; i < Segments; i++)
                if (!slots[i].Empty && !slots[i].More && slots[i].Item?.Id == itemId) { Execute(i, false, false, false); return true; }
            return false;
        }

        /// <summary>Activate the hub item (when one was given to <see cref="Open"/>).</summary>
        public void PressHub() { if (IsOpen) Execute(HubHit, false, false, false); }

        // ------------------------------------------------------------------ per frame
        public void Tick(float time, Rect safeArea, Vector2 minimapCentre, float minimapRadius)
        {
            float dt = lastTick < 0f ? 0f : Mathf.Clamp(time - lastTick, 0f, .25f);
            lastTick = time;
            now = time;
            if (!IsOpen) { TickClosing(time); return; }
            var a = anchor?.Invoke();
            if (a == null) { SetHover(NoHit); Hide(); Hot = false; return; }
            if (armedId != null && time > armedUntil) { armedId = null; forceSample = true; paintDirty = true; }
            // structure: the item visibility callbacks are polled at 10 Hz; explicit changes re-layout at once
            bool relaid = false;
            if (!layoutValid || time >= layoutAt)
            {
                layoutAt = time + SampleSeconds;
                relaid = Layout();
            }
            bool appearing = !shown;
            zoom = appearing ? Mathf.Max(.5f, Scale) : Mathf.Lerp(zoom, Mathf.Max(.5f, Scale), 1f - Mathf.Exp(-dt * 12f));
            float s = zoom;
            float radius = BoundRadius * s;
            centre = Place(a.Value, radius, safeArea, minimapCentre, minimapRadius);
            if (appearing)
            {
                shown = true; shownAt = time;
                style.display = DisplayStyle.Flex;
                paintDirty = true; forceSample = true;
            }
            ApplyOpenTransform(time);
            var c = centre;
            Hot = (Pointer - c).sqrMagnitude <= HotRadius * s * HotRadius * s || keyboard && time - openedAt < 3f;
            // hover from the pointer (the wheel moves under a still pointer as the camera moves); the panel is
            // only asked when the pointer is within the wheel's reach
            int hit = NoHit;
            var rel = Pointer - c;
            float reach = (arc.Count > 0 ? ArcRadius + ArcButtonRadius + 2f : OuterRadius + 8f) * s;
            if (panel != null && rel.sqrMagnitude <= reach * reach)
            {
                var picked = Picker != null ? Picker(Pointer) : panel.Pick(Pointer);
                if (picked == this) hit =HitTest(rel / s + new Vector2(Half, Half));
            }
            bool hoverChanged = SetHover(hit);
            bool highlightChanged = HighlightId != paintedHighlight;
            paintedHighlight = HighlightId;
            if (relaid || forceSample || hoverChanged || time >= sampleAt)
            {
                sampleAt = time + SampleSeconds;
                forceSample = false;
                if (Sample() || relaid) paintDirty = true;
                RefreshChildren();
                UpdateInfo();
            }
            else if (highlightChanged) RefreshChildren();
            if (hoverChanged || highlightChanged) paintDirty = true;
            InfoFlash();
            if (Ease(dt)) paintDirty = true;
            if (paintDirty) { paintDirty = false; MarkDirtyRepaint(); }
        }

        /// <summary>
        /// The wheel centre: the anchor, clamped so the bounding circle stays inside the safe area, pushed out of
        /// the minimap circle and out of every keep-out rectangle (the smallest move that stays on screen).
        /// </summary>
        Vector2 Place(Vector2 c, float radius, Rect safe, Vector2 minimapCentre, float minimapRadius)
        {
            float minX = safe.xMin + radius, maxX = Mathf.Max(minX, safe.xMax - radius);
            float minY = safe.yMin + radius, maxY = Mathf.Max(minY, safe.yMax - radius);
            c.x = Mathf.Clamp(c.x, minX, maxX);
            c.y = Mathf.Clamp(c.y, minY, maxY);
            for (int pass = 0; pass < 3; pass++)
            {
                bool moved = false;
                var d = c - minimapCentre;
                float need = minimapRadius + radius;
                if (minimapRadius > 0 && d.sqrMagnitude < need * need)
                {
                    var n = d.sqrMagnitude < 1f ? new Vector2(1, -1).normalized : d.normalized;
                    c = minimapCentre + n * need;
                    moved = true;
                }
                for (int k = 0; k < KeepOut.Count; k++)
                {
                    var r = KeepOut[k];
                    if (r.width <= 0 || r.height <= 0) continue;
                    float x0 = r.xMin - radius, x1 = r.xMax + radius, y0 = r.yMin - radius, y1 = r.yMax + radius;
                    if (c.x <= x0 || c.x >= x1 || c.y <= y0 || c.y >= y1) continue;
                    // candidates: above, left, right, below — the shortest that stays inside the safe bounds
                    float best = float.MaxValue; var to = c;
                    void Try(Vector2 p)
                    {
                        if (p.x < minX - .5f || p.x > maxX + .5f || p.y < minY - .5f || p.y > maxY + .5f) return;
                        float cost = (p - c).sqrMagnitude;
                        if (cost < best) { best = cost; to = p; }
                    }
                    Try(new Vector2(c.x, y0)); Try(new Vector2(x0, c.y)); Try(new Vector2(x1, c.y)); Try(new Vector2(c.x, y1));
                    if (best == float.MaxValue) to = new Vector2(c.x, Mathf.Max(minY, y0));   // nothing fits: go up as far as allowed
                    c = to;
                    moved = true;
                }
                c.x = Mathf.Clamp(c.x, minX, maxX);
                c.y = Mathf.Clamp(c.y, minY, maxY);
                if (!moved) break;
            }
            return c;
        }

        /// <summary>Position, eased scale and fade: transform and opacity only (no layout, no mesh rebuild).</summary>
        void ApplyOpenTransform(float time)
        {
            float k = reducedMotion ? 1f : Mathf.Clamp01((time - shownAt) / OpenSeconds);
            float e = 1f - (1f - k) * (1f - k) * (1f - k);   // ease-out cubic
            SetTransform(centre, zoom * Mathf.Lerp(.9f, 1f, e), e);
        }

        void TickClosing(float time)
        {
            if (closingAt < 0f) return;
            float k = (time - closingAt) / CloseSeconds;
            if (k >= 1f) { FinishClose(); return; }
            SetTransform(centre, zoom * Mathf.Lerp(1f, .94f, k), 1f - k);
        }

        void SetTransform(Vector2 at, float scale, float opacity)
        {
            if (!(Mathf.Abs(at.x - placedAt.x) < .01f && Mathf.Abs(at.y - placedAt.y) < .01f))
            {
                placedAt = at;
                style.translate = new Translate(at.x - Half, at.y - Half);
            }
            if (!(Mathf.Abs(scale - placedScale) < .0005f))
            {
                placedScale = scale;
                style.scale = new StyleScale(new UnityEngine.UIElements.Scale(new Vector2(scale, scale)));
            }
            if (!(Mathf.Abs(opacity - placedOpacity) < .002f))
            {
                placedOpacity = opacity;
                style.opacity = opacity;
            }
        }

        /// <summary>Re-reads the visible items; true (and repositions the children) when the ring's layout changed.</summary>
        bool Layout()
        {
            var level = levels[levels.Count - 1];
            scratch.Clear();
            foreach (var item in level.Items) if (item != null && (item.Visible?.Invoke() ?? true)) scratch.Add(item);
            bool fixedAngles = scratch.Count > 0;
            foreach (var item in scratch) if (item.Angle == null) { fixedAngles = false; break; }
            arcScratch.Clear();
            arcVisible = 0;
            if (outerArc != null)
                foreach (var item in outerArc)
                    if (item != null && (item.Visible?.Invoke() ?? true))
                    {
                        arcVisible++;
                        if (levels.Count == 1) arcScratch.Add(item);
                    }
            // a sub-ring or another page re-blooms the wheel briefly (from about half way), so the change reads
            if (shown && !reducedMotion && (lastLevels != levels.Count || lastPage != level.Page) && lastLevels > 0)
            {
                shownAt = now - OpenSeconds * .45f;
                for (int i = 0; i < Segments; i++) progressShown[i] = -1f;
            }
            bool same = layoutValid && lastLevels == levels.Count && lastPage == level.Page
                && scratch.Count == lastItems.Count && arcScratch.Count == lastArc.Count;
            for (int i = 0; same && i < scratch.Count; i++)
                same = ReferenceEquals(scratch[i], lastItems[i]) && lastAngles[i] == AngleKey(scratch[i]);
            for (int i = 0; same && i < arcScratch.Count; i++) same = ReferenceEquals(arcScratch[i], lastArc[i]);
            if (same) return false;
            layoutValid = true;
            lastLevels = levels.Count; lastPage = level.Page;
            lastItems.Clear(); lastAngles.Clear(); lastArc.Clear();
            foreach (var item in scratch) { lastItems.Add(item); lastAngles.Add(AngleKey(item)); }
            lastArc.AddRange(arcScratch);
            arc.Clear();
            for (int i = 0; i < arcScratch.Count; i++)
            {
                // centred at 6 o'clock, left to right, 24° apart (outside the nine segments)
                float angle = 180f + 24f * (arcScratch.Count - 1) * .5f - 24f * i;
                arc.Add((arcScratch[i], angle));
            }
            for (int i = 0; i < Segments; i++) slots[i] = new Slot { Empty = true, Mid = SegmentAngle(i) };
            if (fixedAngles)
            {
                pages = 1;
                foreach (var item in scratch)
                {
                    int seg = SegmentOf(item.Angle.Value);
                    // two items on one segment: the later one takes the next free segment clockwise
                    for (int k = 0; k < Segments && !slots[seg].Empty; k++) seg = (seg + 1) % Segments;
                    if (!slots[seg].Empty) continue;
                    slots[seg] = new Slot { Item = item, Mid = SegmentAngle(seg) };
                }
            }
            else
            {
                int count = scratch.Count;
                pages = count > Segments ? Mathf.CeilToInt(count / (float)(Segments - 1)) : 1;
                if (level.Page >= pages) level.Page = 0;
                int per = pages > 1 ? Segments - 1 : Segments;
                int start = level.Page * per, take = Mathf.Min(per, count - start);
                for (int i = 0; i < take; i++) slots[i] = new Slot { Item = scratch[start + i], Mid = SegmentAngle(i) };
                // the next-page segment only when a second page is needed: the last segment (11 o'clock)
                if (pages > 1) slots[Segments - 1] = new Slot { More = true, Mid = SegmentAngle(Segments - 1) };
            }
            // digits 1–9 clockwise from 12 o'clock over the item segments (next page is 0)
            int key = 0;
            for (int i = 0; i < Segments; i++)
            {
                if (slots[i].Empty) continue;
                slots[i].Key = slots[i].More ? 0 : ++key;
            }
            EnsureArcPool();
            PlaceChildren();
            return true;
        }

        static int AngleKey(RadialItem item) => item.Angle.HasValue ? Mathf.RoundToInt(item.Angle.Value) : int.MinValue;

        void EnsureArcPool()
        {
            while (arcIcons.Count < arc.Count) { var icon = new IconElement("", "se-radial-arc-icon"); Add(icon); arcIcons.Add(icon); }
            if (arcUsable.Length < arc.Count) arcUsable = new bool[Mathf.Max(arc.Count, arcUsable.Length * 2)];
            if (arcGlow.Length < arc.Count) arcGlow = new float[arcUsable.Length];
            info.BringToFront();
        }

        /// <summary>Positions and glyphs of the children: only when the ring's layout changes.</summary>
        void PlaceChildren()
        {
            for (int i = 0; i < Segments; i++)
            {
                var s = slots[i];
                bool show = !s.Empty;
                Show(icons[i], show);
                if (!show) { Show(locks[i], false); Show(badges[i], false); Show(captions[i], false); continue; }
                var ip = At(IconRadius, s.Mid);
                Place(icons[i], ip.x, ip.y, IconSize);
                icons[i].Kind = s.More ? "more" : s.Item.Icon ?? "";
                Place(locks[i], ip.x + 14f, ip.y - 14f, 12);
                // the queued count sits at the bottom of the item, just below the progress ring
                badges[i].style.left = ip.x - 12f; badges[i].style.top = ip.y + ProgressRadius + 1f;
                captions[i].style.left = ip.x - 18f; captions[i].style.top = ip.y + ProgressRadius;
                if (s.More) { Show(locks[i], false); Show(badges[i], false); Show(captions[i], false); }
            }
            for (int k = 0; k < arcIcons.Count; k++)
            {
                bool show = k < arc.Count;
                Show(arcIcons[k], show);
                if (!show) continue;
                var p = At(ArcRadius, arc[k].angle);
                Place(arcIcons[k], p.x, p.y, 22);
                arcIcons[k].Kind = arc[k].item.Icon ?? "";
            }
        }

        /// <summary>Samples the item callbacks (10 Hz). True when anything painted changed (or a pulse is animating).</summary>
        bool Sample()
        {
            bool changed = false;
            anyPulse = false;
            for (int i = 0; i < Segments; i++)
            {
                var s = slots[i];
                if (s.More || s.Empty || s.Item == null) continue;
                var item = s.Item;
                var next = new SlotState
                {
                    Usable = Usable(item),
                    Active = item.Active?.Invoke() == true,
                    Badge = item.Badge?.Invoke() ?? 0,
                    Cooldown = item.Cooldown?.Invoke() ?? 0f,
                    Progress = item.Progress?.Invoke() ?? -1f,
                    Caption = item.Caption?.Invoke(),
                };
                ref var prev = ref state[i];
                if (prev.Usable != next.Usable || prev.Active != next.Active || prev.Cooldown != next.Cooldown || prev.Progress != next.Progress) changed = true;
                prev = next;
                if (item.Pulse) anyPulse = true;
            }
            for (int k = 0; k < arc.Count; k++) arcUsable[k] = Usable(arc[k].item);
            float hp = levels.Count == 1 && hub != null ? hub.Progress?.Invoke() ?? -1f : -1f;
            int nextPips = HubPips?.Invoke() ?? 0;
            int nextPage = levels.Count > 0 ? levels[levels.Count - 1].Page : 0;
            if (hp != hubProgress || nextPips != pips || nextPage != page) changed = true;
            hubProgress = hp; pips = nextPips; page = nextPage;
            // the empty-socket pulse is a slow (1.6 s) alpha swing: 10 Hz repaints are smooth enough
            return changed || anyPulse;
        }

        /// <summary>Tints, lock glyphs, counts and captions from the sampled state (10 Hz or on hover change).</summary>
        void RefreshChildren()
        {
            for (int i = 0; i < Segments; i++)
            {
                var s = slots[i];
                if (s.Empty) continue;
                if (s.More) { icons[i].Tint = hover == i ? Color.white : TextColor; continue; }
                var item = s.Item;
                ref var st = ref state[i];
                bool hi = hover == i || HighlightId != null && HighlightId == item.Id;
                var tint = hi ? Color.white : TextColor;
                if (!st.Usable) tint.a = .4f;
                icons[i].Tint = tint;
                Show(locks[i], !st.Usable && item.Icon != "lock");
                int badge = st.Badge > 99 ? 99 : st.Badge;
                if (badge > 0 && badgeShown[i] != badge) { badgeShown[i] = badge; badges[i].text = "×" + badge; }
                Show(badges[i], badge > 0);
                bool caption = badge <= 0 && !string.IsNullOrEmpty(st.Caption);
                if (caption) SetText(captions[i], st.Caption);
                Show(captions[i], caption);
            }
            for (int k = 0; k < arc.Count && k < arcIcons.Count; k++)
            {
                var tint = hover == ArcHit + k ? Color.white : TextColor;
                if (!arcUsable[k]) tint.a = .4f;
                arcIcons[k].Tint = tint;
            }
        }

        // ------------------------------------------------------------------ state helpers
        bool Affordable(JToken cost, out string shortfall)
        {
            shortfall = null;
            if (!(cost is JObject o) || have == null) return true;
            foreach (var p in o.Properties())
            {
                int need = Mathf.RoundToInt(ProtocolDecoder.Float(p.Value)) - have(p.Name);
                if (need <= 0) continue;
                shortfall = $"Need {need} more {(p.Name == "materials" ? "Materials" : p.Name == "energy" ? "Energy" : p.Name)}";
                return false;
            }
            return true;
        }

        bool Usable(RadialItem item)
        {
            if (item == null) return false;
            if (!(item.Enabled?.Invoke() ?? true)) return false;
            return Affordable(item.Cost, out _);
        }

        string ReasonFor(RadialItem item)
        {
            if (item == null) return "";
            bool enabled = item.Enabled?.Invoke() ?? true;
            if (!enabled) return item.Reason?.Invoke() ?? "Unavailable";
            if (!Affordable(item.Cost, out var shortfall)) return shortfall;
            return item.Reason?.Invoke() ?? "";
        }

        RadialItem ItemAt(int hit)
        {
            if (hit == HubHit) return levels.Count > 1 ? null : hub;
            if (hit >= ArcHit) { int k = hit - ArcHit; return k < arc.Count ? arc[k].item : null; }
            if (hit >= 0 && hit < Segments) return slots[hit].More || slots[hit].Empty ? null : slots[hit].Item;
            return null;
        }

        /// <summary>True when the hovered wedge changed.</summary>
        bool SetHover(int hit)
        {
            if (hit == hover) return false;
            var next = ItemAt(hit);
            if (hovered != null && hovered != next) hovered.Hover?.Invoke(false);
            if (next != null && next != hovered) next.Hover?.Invoke(true);
            hovered = next;
            hover = hit;
            return true;
        }

        int HitTest(Vector2 local)
        {
            var v = local - new Vector2(Half, Half);
            float r = v.magnitude;
            if (r <= HubRadius) return HubHit;
            if (levels.Count == 1)
                for (int k = 0; k < arc.Count; k++)
                    if ((local - At(ArcRadius, arc[k].angle)).sqrMagnitude <= (ArcButtonRadius + 2) * (ArcButtonRadius + 2)) return ArcHit + k;
            if (r > OuterRadius + 4) return NoHit;
            int seg = SegmentOf(Mathf.Atan2(v.x, -v.y) * Mathf.Rad2Deg);
            return slots[seg].Empty ? NoHit : seg;
        }

        public override bool ContainsPoint(Vector2 localPoint)
        {
            if (!IsOpen) return false;
            var v = localPoint - new Vector2(Half, Half);
            if (v.sqrMagnitude <= (OuterRadius + 6) * (OuterRadius + 6)) return true;
            for (int k = 0; k < arc.Count; k++)
                if ((localPoint - At(ArcRadius, arc[k].angle)).sqrMagnitude <= (ArcButtonRadius + 2) * (ArcButtonRadius + 2)) return true;
            return false;
        }

        // ------------------------------------------------------------------ input
        void OnPointerDown(PointerDownEvent e)
        {
            if (!IsOpen) return;
            int hit = HitTest(new Vector2(e.localPosition.x, e.localPosition.y));
            e.StopPropagation();
            if (e.button == 1)
            {
                if (hit == HubHit || hit == NoHit) { if (!Back()) Close(); return; }
                var item = ItemAt(hit);
                if (item?.RightClick != null) { item.RightClick(); forceSample = true; }
                else if (!Back()) Close();
                return;
            }
            if (e.button != 0 || hit == NoHit) return;
            Execute(hit, e.shiftKey, e.ctrlKey, e.altKey);
        }

        void OnWheel(WheelEvent e)
        {
            if (!IsOpen || pages <= 1) return;
            Page(e.delta.y > 0 ? 1 : -1);
            e.StopPropagation();
        }

        void Execute(int hit, bool shift, bool ctrl, bool alt)
        {
            forceSample = true;
            if (hit == HubHit && levels.Count > 1) { Back(); return; }
            if (hit >= 0 && hit < Segments && slots[hit].More) { Page(1); return; }
            var item = ItemAt(hit);
            if (item == null) return;
            bool repeatToggle = ctrl && item.Active != null;
            if (!Usable(item) && !repeatToggle)
            {
                string reason = ReasonFor(item);
                flash = reason; pulseUntil = now + .7f;
                if (!string.IsNullOrEmpty(reason)) Refused?.Invoke(reason);
                return;
            }
            if (item.Children != null)
            {
                SetHover(NoHit);
                levels.Add(new Level { Items = item.Children() ?? new List<RadialItem>(), Page = 0 });
                armedId = null; layoutValid = false;
                return;
            }
            if (item.Confirm && armedId != item.Id) { armedId = item.Id; armedUntil = now + 4f; paintDirty = true; return; }
            if (armedId != null) paintDirty = true;
            armedId = null;
            item.Click?.Invoke(new RadialClick { Shift = shift, Ctrl = ctrl, Alt = alt });
        }

        // ------------------------------------------------------------------ centre circle
        static readonly string[] DigitKeys = { "", "[1]", "[2]", "[3]", "[4]", "[5]", "[6]", "[7]", "[8]", "[9]" };

        /// <summary>The centre circle's text (10 Hz or when the hover changes; labels skip unchanged text).</summary>
        void UpdateInfo()
        {
            var item = hovered;
            int key = -1;
            if (hover >= 0 && hover < Segments) key = slots[hover].Key;
            if (hover >= 0 && hover < Segments && slots[hover].More)
            {
                infoGlyph.Kind = "more"; Show(infoGlyph, true);
                SetText(infoName, "Next page");
                SetText(infoDetail, $"Page {levels[levels.Count - 1].Page + 1} of {pages}");
                Show(infoDetail, true);
                ShowCost(0, 0, 0, "[0]");
                Show(infoReason, false);
            }
            else if (item == null)
            {
                bool sub = levels.Count > 1;
                infoGlyph.Kind = sub ? "back" : hubIcon;
                Show(infoGlyph, !string.IsNullOrEmpty(infoGlyph.Kind));
                infoGlyph.Tint = hover == HubHit && sub ? Color.white : TextColor;
                SetText(infoName, subject);
                string detail = sub ? "Back · Esc" : SubjectDetail?.Invoke();
                SetText(infoDetail, detail);
                Show(infoDetail, !string.IsNullOrEmpty(detail));
                ShowCost(0, 0, 0, null);
                Show(infoReason, false);
            }
            else
            {
                Show(infoGlyph, false);
                bool armed = armedId == item.Id;
                SetText(infoName, armed ? "Confirm · " + item.TitleText : item.TitleText);
                int materials = 0, energy = 0;
                if (item.Cost is JObject cost)
                {
                    materials = Mathf.RoundToInt(ProtocolDecoder.Float(cost["materials"]));
                    energy = Mathf.RoundToInt(ProtocolDecoder.Float(cost["energy"]));
                }
                string keyText = key > 0 && key < DigitKeys.Length ? DigitKeys[key] : !string.IsNullOrEmpty(item.Hotkey) ? "[" + item.Hotkey + "]" : null;
                ShowCost(materials, energy, item.Seconds, keyText);
                string detail = armed ? "Click again within 4 s to confirm" : item.Detail?.Invoke();
                SetText(infoDetail, detail);
                Show(infoDetail, !string.IsNullOrEmpty(detail));
                string reason = ReasonFor(item);
                if (!flashShown) SetText(infoReason, reason);
                Show(infoReason, !string.IsNullOrEmpty(reason) || flashShown);
            }
        }

        void ShowCost(int materials, int energy, int seconds, string keyText)
        {
            bool any = materials > 0 || energy > 0 || seconds > 0 || !string.IsNullOrEmpty(keyText);
            Show(infoCost, any);
            if (!any) return;
            Show(infoMaterialsIcon, materials > 0);
            Show(infoMaterials, materials > 0);
            if (materials > 0) SetText(infoMaterials, materials.ToString("N0"));
            infoMaterials.style.color = have != null && have("materials") < materials ? Bad : TextColor;
            Show(infoEnergyIcon, energy > 0);
            Show(infoEnergy, energy > 0);
            if (energy > 0) SetText(infoEnergy, energy.ToString("N0"));
            infoEnergy.style.color = have != null && have("energy") < energy ? Bad : TextColor;
            SetText(infoTime, seconds > 0 ? seconds + " s" : "");
            Show(infoTime, seconds > 0);
            SetText(infoKey, keyText);
            Show(infoKey, !string.IsNullOrEmpty(keyText));
        }

        /// <summary>A refused click flashes its reason for 0.7 s (per frame only while flashing).</summary>
        void InfoFlash()
        {
            if (now < pulseUntil && !string.IsNullOrEmpty(flash))
            {
                flashShown = true;
                SetText(infoReason, flash);
                Show(infoReason, true);
                float k = Mathf.PingPong((pulseUntil - now) * 6f, 1f);
                infoReason.style.color = Color.Lerp(Warn, Color.white, k);
            }
            else if (flashShown)
            {
                flashShown = false;
                infoReason.style.color = Warn;
                forceSample = true;   // restore the hovered item's own reason next frame
            }
        }

        // ------------------------------------------------------------------ eased presentation
        /// <summary>
        /// Per frame while open: hover glows ease in and out (about 90 ms) and progress rings ease to a jump in value
        /// (about 0.3 s; the small 10 Hz steps of a running job are drawn as they come, so a training wheel is not
        /// repainted every frame). True while anything moved (the wheel repaints only then).
        /// </summary>
        bool Ease(float dt)
        {
            bool moving = false;
            float step = reducedMotion ? 1f : dt / HoverSeconds;
            for (int i = 0; i < Segments; i++)
            {
                var s = slots[i];
                bool hi = !s.Empty && (hover == i || !s.More && s.Item != null && HighlightId != null && HighlightId == s.Item.Id);
                moving |= Approach(ref hoverGlow[i], hi ? 1f : 0f, step);
                moving |= EaseProgress(ref progressShown[i], s.Empty || s.More ? -1f : state[i].Progress, dt);
            }
            for (int k = 0; k < arcGlow.Length; k++) moving |= Approach(ref arcGlow[k], k < arc.Count && hover == ArcHit + k ? 1f : 0f, step);
            moving |= Approach(ref hubGlow, hover == HubHit && (levels.Count > 1 || hub != null) ? 1f : 0f, step);
            moving |= EaseProgress(ref hubProgressShown, hubProgress, dt);
            return moving;
        }

        static bool Approach(ref float v, float target, float step)
        {
            if (v == target) return false;
            v = Mathf.MoveTowards(v, target, Mathf.Max(step, 0f));
            return true;
        }

        bool EaseProgress(ref float shown, float target, float dt)
        {
            if (shown == target) return false;
            // appearing, hiding, restarting (a new job) or a small running step: drawn at once
            if (reducedMotion || target < 0f || shown < 0f || target < shown || target - shown < .02f) { shown = target; return true; }
            shown += (target - shown) * (1f - Mathf.Exp(-dt * 3f / ProgressSeconds));
            if (target - shown < .004f) shown = target;
            return true;
        }

        static float Smooth(float t) => t * t * (3f - 2f * t);
        static Color Alpha(Color c, float a) => new Color(c.r, c.g, c.b, c.a * a);

        // ------------------------------------------------------------------ painting
        void Paint(MeshGenerationContext ctx)
        {
            if (!shown) return;
            var p = ctx.painter2D;
            var c = new Vector2(Half, Half);
            p.lineJoin = LineJoin.Round;
            // blur-free drop shadow: two soft dark discs just under the wheel
            p.fillColor = Shadow;
            p.BeginPath(); p.Arc(c + new Vector2(0, 4f), OuterRadius + 6f, 0f, 360f); p.Fill();
            p.fillColor = ShadowNear;
            p.BeginPath(); p.Arc(c + new Vector2(0, 2f), OuterRadius + 2f, 0f, 360f); p.Fill();
            for (int i = 0; i < Segments; i++)
            {
                var s = slots[i];
                float a0 = s.Mid - SegmentSpan * .5f, a1 = s.Mid + SegmentSpan * .5f;
                if (s.Empty) { Sector(p, a0, a1, InnerRadius, OuterRadius, SurfaceEmpty); continue; }
                var item = s.Item;
                float g = Smooth(hoverGlow[i]);   // eased hover / world highlight
                bool hi = g > .5f;
                bool armed = !s.More && item != null && armedId == item.Id;
                Sector(p, a0, a1, InnerRadius, OuterRadius, armed ? Armed : Color.Lerp(Surface, SurfaceHover, g));
                if (g > .001f) Sector(p, a0, a1, InnerRadius, OuterRadius, Alpha(GlowFill, g));
                if (s.More || item == null)
                {
                    if (g > .001f) ArcStroke(p, a0, a1, OuterRadius - 1.5f, 3f, Alpha(Accent, g));
                    continue;
                }
                var st = state[i];
                if (st.Cooldown > .001f) Sector(p, a0, a0 + (a1 - a0) * Mathf.Clamp01(st.Cooldown), InnerRadius, OuterRadius, CooldownShade);
                if (st.Active) ArcStroke(p, a0 + 1f, a1 - 1f, InnerRadius + 2f, 3f, Good);
                if (item.Pulse && !hi)
                {
                    float alpha = Mathf.Lerp(.35f, .7f, .5f + .5f * Mathf.Sin(now * Mathf.PI * 2f / 1.6f));
                    ArcStroke(p, a0 + 1f, a1 - 1f, OuterRadius - 1.5f, 2.5f, new Color(Accent.r, Accent.g, Accent.b, alpha));
                }
                if (g > .001f)
                {
                    ArcStroke(p, a0, a1, OuterRadius + 4f, 7f, Alpha(GlowWide, g));
                    ArcStroke(p, a0, a1, OuterRadius - 1.5f, 3f, Alpha(Accent, g));
                }
                // progress: a green ring filling clockwise around the item's icon (eased to jumps, Ease)
                float prog = progressShown[i] >= 0f || st.Progress < 0f ? progressShown[i] : st.Progress;
                if (prog >= 0f)
                {
                    var ic = At(IconRadius, s.Mid);
                    RingStroke(p, ic, ProgressRadius, 0f, 1f, 3.5f, ProgressTrack);
                    if (prog > 0f) RingStroke(p, ic, ProgressRadius, 0f, Mathf.Clamp01(prog), 3.5f, Good);
                }
            }
            // hairline separators between the segments (no gaps) and the outer rim
            p.strokeColor = Line; p.lineWidth = 1f; p.lineCap = LineCap.Butt;
            for (int i = 0; i < Segments; i++)
            {
                float a = SegmentAngle(i) - SegmentSpan * .5f;
                p.BeginPath(); p.MoveTo(At(InnerRadius, a)); p.LineTo(At(OuterRadius, a)); p.Stroke();
            }
            p.strokeColor = Rim; p.lineWidth = 1.5f;
            p.BeginPath(); p.Arc(c, OuterRadius + .75f, 0f, 360f); p.Stroke();
            // the enlarged centre circle: the info disc, meeting the segments with no gap
            float hg = Smooth(hubGlow);
            p.fillColor = Color.Lerp(HubSurface, HubHover, hg);
            p.BeginPath(); p.Arc(c, HubRadius, 0f, 360f); p.Fill();
            p.strokeColor = Color.Lerp(Line, Accent, hg); p.lineWidth = Mathf.Lerp(1f, 2f, hg);
            p.BeginPath(); p.Arc(c, HubRadius, 0f, 360f); p.Stroke();
            float hubProg = hubProgressShown >= 0f || hubProgress < 0f ? hubProgressShown : hubProgress;
            if (hubProg >= 0f)
            {
                RingStroke(p, c, HubRadius - 3f, 0f, 1f, 3f, ProgressTrack);
                if (hubProg > 0f) RingStroke(p, c, HubRadius - 3f, 0f, Mathf.Clamp01(hubProg), 3f, Good);
            }
            int drawPips = lastLevels == 1 ? pips : 0;
            float bottom = Half + HubRadius - 14f;
            if (drawPips > 0)
            {
                float y = pages > 1 ? bottom - 6f : bottom;
                for (int k = 0; k < 3; k++)
                {
                    float x = Half - 10f + k * 8f;
                    FillRect(p, x - 3f, y - 3f, 6f, 6f, k < drawPips ? Friendly : PipOff);
                }
            }
            if (pages > 1)
            {
                float total = pages * 6f + (pages - 1) * 4f, x0 = Half - total * .5f + 3f, y = drawPips > 0 ? bottom + 4f : bottom;
                for (int k = 0; k < pages; k++)
                {
                    p.fillColor = k == page ? Accent : PageOff;
                    p.BeginPath(); p.Arc(new Vector2(x0 + k * 10f, y), 3f, 0f, 360f); p.Fill();
                }
            }
            // outer command arc (root ring only)
            for (int k = 0; k < arc.Count && levels.Count <= 1; k++)
            {
                var at = At(ArcRadius, arc[k].angle);
                float ag = k < arcGlow.Length ? Smooth(arcGlow[k]) : 0f;
                p.fillColor = Shadow;
                p.BeginPath(); p.Arc(at + new Vector2(0, 2f), ArcButtonRadius + 2f, 0f, 360f); p.Fill();
                if (ag > .001f)
                {
                    p.strokeColor = Alpha(GlowWide, ag); p.lineWidth = 6f;
                    p.BeginPath(); p.Arc(at, ArcButtonRadius + 3.5f, 0f, 360f); p.Stroke();
                }
                p.fillColor = Color.Lerp(SurfaceButton, SurfaceHover, ag);
                p.BeginPath(); p.Arc(at, ArcButtonRadius, 0f, 360f); p.Fill();
                p.strokeColor = Color.Lerp(Line, Accent, ag); p.lineWidth = Mathf.Lerp(1f, 2f, ag);
                p.BeginPath(); p.Arc(at, ArcButtonRadius, 0f, 360f); p.Stroke();
            }
        }

        static void Sector(Painter2D p, float a0, float a1, float r0, float r1, Color fill)
        {
            if (a1 <= a0) return;
            int steps = Mathf.Max(2, Mathf.CeilToInt((a1 - a0) / 4f));
            p.fillColor = fill;
            p.BeginPath();
            p.MoveTo(At(r1, a0));
            for (int k = 1; k <= steps; k++) p.LineTo(At(r1, Mathf.Lerp(a0, a1, k / (float)steps)));
            for (int k = steps; k >= 0; k--) p.LineTo(At(r0, Mathf.Lerp(a0, a1, k / (float)steps)));
            p.ClosePath();
            p.Fill();
        }

        static void ArcStroke(Painter2D p, float a0, float a1, float radius, float width, Color color)
        {
            if (a1 <= a0) return;
            int steps = Mathf.Max(2, Mathf.CeilToInt((a1 - a0) / 4f));
            p.strokeColor = color; p.lineWidth = width;
            p.lineCap = LineCap.Butt;
            p.BeginPath();
            p.MoveTo(At(radius, a0));
            for (int k = 1; k <= steps; k++) p.LineTo(At(radius, Mathf.Lerp(a0, a1, k / (float)steps)));
            p.Stroke();
        }

        /// <summary>A ring around <paramref name="centre"/> from fraction f0 to f1 (0 = 12 o'clock, clockwise).</summary>
        static void RingStroke(Painter2D p, Vector2 centre, float radius, float f0, float f1, float width, Color color)
        {
            if (f1 <= f0) return;
            float a0 = f0 * 360f, a1 = f1 * 360f;
            int steps = Mathf.Max(3, Mathf.CeilToInt((a1 - a0) / 10f));
            p.strokeColor = color; p.lineWidth = width;
            p.lineCap = LineCap.Butt;
            p.BeginPath();
            p.MoveTo(centre + Dir(a0) * radius);
            for (int k = 1; k <= steps; k++) p.LineTo(centre + Dir(Mathf.Lerp(a0, a1, k / (float)steps)) * radius);
            if (f1 - f0 >= .999f) p.ClosePath();
            p.Stroke();
        }

        static void FillRect(Painter2D p, float x, float y, float w, float h, Color color)
        {
            p.fillColor = color;
            p.BeginPath();
            p.MoveTo(new Vector2(x, y)); p.LineTo(new Vector2(x + w, y)); p.LineTo(new Vector2(x + w, y + h)); p.LineTo(new Vector2(x, y + h));
            p.ClosePath();
            p.Fill();
        }
    }
}
