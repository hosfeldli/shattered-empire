using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>One wedge (or hub, or outer-arc button) of a <see cref="RadialMenu"/>.</summary>
    public sealed class RadialItem
    {
        public string Id, Icon, Title, Hotkey;
        public JToken Cost;
        public int Seconds;
        /// <summary>False: the wedge is disabled (dimmed, lock glyph); the reason explains why.</summary>
        public Func<bool> Enabled;
        /// <summary>Shown when disabled (or as an informational line when enabled).</summary>
        public Func<string> Reason;
        /// <summary>Count badge (queued units); 0 hides it.</summary>
        public Func<int> Badge;
        /// <summary>0..1 progress arc along the outer edge; below 0 hides it.</summary>
        public Func<float> Progress;
        /// <summary>Toggled state (repeat production on): green inner stroke.</summary>
        public Func<bool> Active;
        /// <summary>Two-step: the first click arms the wedge (red "Confirm"), a second within 4 s executes.</summary>
        public bool Confirm;
        public Action<RadialClick> Click;
        public Action RightClick;
        /// <summary>A sub-ring replacing this ring (Upgrades, Air missions).</summary>
        public Func<IList<RadialItem>> Children;
        /// <summary>Fixed angle in degrees clockwise from 12 o'clock (base sockets); null = automatic.</summary>
        public float? Angle;
        /// <summary>Hover enter/leave, for world highlights.</summary>
        public Action<bool> Hover;
        // ---- extensions (Impl-2)
        /// <summary>Dynamic title (overrides <see cref="Title"/>).</summary>
        public Func<string> Name;
        /// <summary>A short description line in the readout.</summary>
        public Func<string> Detail;
        /// <summary>Micro text under the icon (a locked socket's tier numeral).</summary>
        public Func<string> Caption;
        /// <summary>0..1 cooldown remaining: darkens the wedge clockwise.</summary>
        public Func<float> Cooldown;
        /// <summary>False: the item takes no wedge (outer-arc commands that do not apply right now).</summary>
        public Func<bool> Visible;
        /// <summary>A slow brass pulse on the outer stroke (empty sockets glow).</summary>
        public bool Pulse;

        public string TitleText => Name?.Invoke() ?? Title ?? "";
    }

    public struct RadialClick { public bool Shift, Ctrl; }

    /// <summary>
    /// The Halo Wars–style command wheel (spec B6): one component for bases, buildings and units. Wedges are
    /// drawn with Painter2D as translucent dark glass (the world shows through); children exist only for
    /// icons, badges and the readout card, which stay fully opaque on top. The wheel follows a screen anchor
    /// (re-projected every frame by the host), stays inside the safe area and out of the minimap.
    /// Digits 1–8 pick wedges clockwise from 12 o'clock, 0 is More; sub-rings return with Back.
    ///
    /// Performance: the wheel moves with a transform (translate/scale/opacity: no layout pass), the
    /// item callbacks (enabled, badge, progress, readout text) are sampled at 10 Hz or when the hover
    /// changes, child elements are positioned only when the ring's layout changes, and the vector mesh
    /// is regenerated only when something it draws changed.
    /// </summary>
    public sealed class RadialMenu : VisualElement
    {
        public const float HubRadius = 36f, InnerRadius = 46f, OuterRadius = 132f, IconRadius = 89f, BadgeRadius = 118f,
            LockRadius = 112f, ArcRadius = 172f, ArcButtonRadius = 22f, HotRadius = 200f, ReadoutWidth = 280f, ReadoutGap = 148f;
        const float Half = 200f;        // the element is 400×400; its centre is the wheel centre
        const float GapDegrees = 2f;
        const int NoHit = -1, HubHit = 1000, ArcHit = 2000;
        const float OpenSeconds = .12f, CloseSeconds = .10f, SampleSeconds = .1f;

        // translucent dark glass: the world reads through the wedges, icons and text stay opaque on top
        static readonly Color Surface = new Color(12 / 255f, 18 / 255f, 21 / 255f, .62f);
        static readonly Color SurfaceButton = new Color(20 / 255f, 28 / 255f, 31 / 255f, .70f);
        static readonly Color SurfaceHover = new Color(48 / 255f, 60 / 255f, 58 / 255f, .78f);
        static readonly Color HubSurface = new Color(12 / 255f, 18 / 255f, 21 / 255f, .84f);
        static readonly Color HubHover = new Color(48 / 255f, 60 / 255f, 58 / 255f, .92f);
        static readonly Color Line = new Color(1f, 1f, 1f, .18f);       // crisp hairline edge
        static readonly Color Rim = new Color(0f, 0f, 0f, .50f);        // dark outer rim: contrast on bright ground
        static readonly Color Accent = new Color(226 / 255f, 182 / 255f, 96 / 255f, 1f);
        static readonly Color GlowWide = new Color(226 / 255f, 182 / 255f, 96 / 255f, .10f);
        static readonly Color GlowNear = new Color(226 / 255f, 182 / 255f, 96 / 255f, .24f);
        static readonly Color GlowFill = new Color(226 / 255f, 182 / 255f, 96 / 255f, .07f);
        static readonly Color Good = new Color(142 / 255f, 212 / 255f, 132 / 255f, 1f);
        static readonly Color Warn = new Color(240 / 255f, 188 / 255f, 86 / 255f, 1f);
        static readonly Color Bad = new Color(242 / 255f, 116 / 255f, 96 / 255f, 1f);
        static readonly Color Armed = new Color(170 / 255f, 60 / 255f, 40 / 255f, .80f);
        static readonly Color TextColor = new Color(232 / 255f, 226 / 255f, 210 / 255f, 1f);
        static readonly Color TextDim = new Color(150 / 255f, 164 / 255f, 160 / 255f, 1f);
        static readonly Color Friendly = new Color(74 / 255f, 150 / 255f, 255 / 255f, 1f);
        static readonly Color CooldownShade = new Color(0, 0, 0, .45f);
        static readonly Color ProgressTrack = new Color(0, 0, 0, .35f);
        static readonly Color HubTrack = new Color(0, 0, 0, .4f);
        static readonly Color PipOff = new Color(1, 1, 1, .18f);
        static readonly Color PageOff = new Color(1, 1, 1, .3f);

        sealed class Level { public IList<RadialItem> Items; public int Page; }
        struct Slot { public RadialItem Item; public float Mid, Span; public bool More; public int Key; }
        /// <summary>The item callbacks sampled at 10 Hz (painting and the children read these, never the callbacks).</summary>
        struct SlotState { public bool Usable, Active; public int Badge; public float Cooldown, Progress; public string Caption; }

        readonly Func<string, int> have;
        readonly List<Level> levels = new List<Level>();
        readonly List<Slot> slots = new List<Slot>();
        readonly List<(RadialItem item, float angle)> arc = new List<(RadialItem, float)>();
        readonly List<IconElement> icons = new List<IconElement>(), locks = new List<IconElement>(), arcIcons = new List<IconElement>();
        readonly List<Label> badges = new List<Label>(), captions = new List<Label>();
        readonly List<int> badgeShown = new List<int>();
        readonly IconElement hubGlyph;
        readonly VisualElement readout, readCost;
        readonly Label readName, readKey, readMaterials, readEnergy, readTime, readDetail, readReason;
        readonly IconElement readMaterialsIcon, readEnergyIcon;

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
        bool readoutAbove;

        // layout change detection (no per-frame key strings)
        bool layoutValid;
        float layoutAt;
        int arcVisible;
        readonly List<RadialItem> scratch = new List<RadialItem>(), lastItems = new List<RadialItem>();
        readonly List<int> lastAngles = new List<int>();
        readonly List<RadialItem> arcScratch = new List<RadialItem>(), lastArc = new List<RadialItem>();
        readonly List<int> order = new List<int>();
        int lastLevels = -1, lastPage = -1;

        // sampled state
        SlotState[] state = new SlotState[8];
        bool[] arcUsable = new bool[6];
        float hubProgress = -1f;
        int pips, page, hubPlacedFor = int.MinValue;
        bool anyPulse, forceSample, paintDirty;
        float sampleAt;
        string paintedHighlight;

        // presentation: transform-driven open/close and zoom scale
        bool shown, reducedMotion;
        float shownAt, closingAt = -1f, zoom = 1f, lastTick = -1f;
        Vector2 placedAt = new Vector2(float.NaN, float.NaN);
        float placedScale = float.NaN, placedOpacity = float.NaN, readoutTop = float.NaN;

        /// <summary>The pointer in panel coordinates (set by the host every frame before <see cref="Tick"/>).</summary>
        public Vector2 Pointer;
        /// <summary>An item highlighted from the world (hovering a parcel highlights its socket wedge).</summary>
        public string HighlightId;
        /// <summary>Tier pips under the hub glyph (base wheel); null or 0 hides them.</summary>
        public Func<int> HubPips;
        /// <summary>The readout's second line while nothing is hovered.</summary>
        public Func<string> SubjectDetail;
        /// <summary>Raised with the reason when a disabled wedge is clicked (the host toasts it).</summary>
        public Action<string> Refused;
        /// <summary>Optional shared (per-frame cached) panel pick; null uses panel.Pick.</summary>
        public Func<Vector2, VisualElement> Picker;
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
        /// <summary>The eased size factor currently applied (for placing pickers beside the wheel).</summary>
        public float CurrentScale => zoom;
        float BoundRadius => arcVisible > 0 ? HotRadius : OuterRadius;
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

            hubGlyph = new IconElement("", "se-radial-hub-icon");
            Place(hubGlyph, Half, Half, 30);
            Add(hubGlyph);

            readout = new VisualElement { pickingMode = PickingMode.Ignore };
            readout.AddToClassList("se-radial-readout");
            readout.style.position = Position.Absolute;
            readout.style.width = ReadoutWidth;
            readout.style.minHeight = 64;
            readout.style.left = Half - ReadoutWidth * .5f;
            Add(readout);
            var head = Row(readout, "se-radial-readout-head");
            readName = MakeLabel(head, "se-radial-readout-name");
            readName.style.flexGrow = 1; readName.style.flexShrink = 1;
            readName.style.overflow = Overflow.Hidden; readName.style.textOverflow = TextOverflow.Ellipsis; readName.style.whiteSpace = WhiteSpace.NoWrap;
            readKey = MakeLabel(head, "se-radial-readout-key");
            readKey.style.flexShrink = 0;
            readCost = Row(readout, "se-radial-readout-cost");
            readMaterialsIcon = new IconElement("materials", "se-radial-cost-icon");
            readMaterialsIcon.style.width = 14; readMaterialsIcon.style.height = 14;
            readCost.Add(readMaterialsIcon);
            readMaterials = MakeLabel(readCost, "se-radial-cost-value");
            readEnergyIcon = new IconElement("energy", "se-radial-cost-icon");
            readEnergyIcon.style.width = 14; readEnergyIcon.style.height = 14;
            readCost.Add(readEnergyIcon);
            readEnergy = MakeLabel(readCost, "se-radial-cost-value");
            readTime = MakeLabel(readCost, "se-radial-cost-time");
            readDetail = MakeLabel(readout, "se-radial-readout-detail");
            readDetail.style.whiteSpace = WhiteSpace.Normal;
            readReason = MakeLabel(readout, "se-radial-readout-reason");
            readReason.style.whiteSpace = WhiteSpace.NoWrap; readReason.style.overflow = Overflow.Hidden; readReason.style.textOverflow = TextOverflow.Ellipsis;

            RegisterCallback<PointerDownEvent>(OnPointerDown);
            RegisterCallback<WheelEvent>(OnWheel);
        }

        static VisualElement Row(VisualElement parent, string cls)
        {
            var e = new VisualElement { pickingMode = PickingMode.Ignore };
            e.AddToClassList(cls);
            e.style.flexDirection = FlexDirection.Row;
            e.style.alignItems = Align.Center;
            parent.Add(e);
            return e;
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

        static Vector2 Dir(float degrees)
        {
            float r = degrees * Mathf.Deg2Rad;
            return new Vector2(Mathf.Sin(r), -Mathf.Cos(r));
        }

        static Vector2 At(float radius, float degrees) => new Vector2(Half, Half) + Dir(degrees) * radius;

        static float Normalize(float degrees) { degrees %= 360f; return degrees < 0 ? degrees + 360f : degrees; }

        static float DeltaAngle(float a, float b) { float d = Normalize(a - b); return d > 180f ? d - 360f : d; }

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
            reducedMotion = App.GameSettings.ReducedMotion;
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
            // fade out (the wedges, icons and readout stay as they were for the 100 ms fade; nothing is picked)
            if (shown && !reducedMotion) closingAt = now;
            else FinishClose();
        }

        void FinishClose()
        {
            closingAt = -1f;
            slots.Clear(); arc.Clear(); arcVisible = 0;
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
            foreach (var s in slots) if (!s.More && s.Item?.Id == itemId) return s.Mid;
            return float.NaN;
        }

        /// <summary>Panel position of an item's icon on the current ring (for picker placement).</summary>
        public Vector2 IconPosition(string itemId)
        {
            float a = AngleOf(itemId);
            return float.IsNaN(a) ? centre : centre + Dir(a) * (IconRadius * zoom);
        }

        /// <summary>Digit 1–8 (clockwise from 12 o'clock) or 0 (More). True when the key was used.</summary>
        public bool PressDigit(int digit, bool shift, bool ctrl)
        {
            if (!IsOpen) return false;
            if (digit == 0) { if (pages > 1) { Page(1); return true; } return false; }
            for (int i = 0; i < slots.Count; i++)
                if (slots[i].Key == digit) { Execute(i, 0, shift, ctrl); return true; }
            return false;
        }

        /// <summary>Activate the hub (e.g. U upgrades the base tier).</summary>
        public void PressHub() { if (IsOpen) Execute(HubHit, 0, false, false); }

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
            float readHeight = readout.resolvedStyle.height;
            if (float.IsNaN(readHeight) || readHeight < 64) readHeight = 96;
            float gap = ReadoutGap * s;
            readHeight *= s;
            var c = a.Value;
            // clamp: the wheel's bounding circle, plus the readout card, inside the safe area
            float minX = safeArea.xMin + radius, maxX = safeArea.xMax - radius;
            float minY = safeArea.yMin + radius, maxY = safeArea.yMax - radius;
            c.x = minX <= maxX ? Mathf.Clamp(c.x, minX, maxX) : safeArea.center.x;
            c.y = minY <= maxY ? Mathf.Clamp(c.y, minY, maxY) : safeArea.center.y;
            bool above = c.y + gap + readHeight > safeArea.yMax;
            if (above && c.y - gap - readHeight < safeArea.yMin)
                c.y = Mathf.Max(minY, safeArea.yMax - gap - readHeight);
            // never over the minimap: push the centre out along the line between the centres
            var d = c - minimapCentre;
            float need = minimapRadius + radius;
            if (minimapRadius > 0 && d.sqrMagnitude < need * need)
            {
                var n = d.sqrMagnitude < 1f ? new Vector2(1, -1).normalized : d.normalized;
                c = minimapCentre + n * need;
                c.x = Mathf.Clamp(c.x, safeArea.xMin + radius, Mathf.Max(safeArea.xMin + radius, safeArea.xMax - radius));
                c.y = Mathf.Clamp(c.y, safeArea.yMin + radius, Mathf.Max(safeArea.yMin + radius, safeArea.yMax - radius));
            }
            centre = c;
            if (above != readoutAbove) readoutAbove = above;
            if (appearing)
            {
                shown = true; shownAt = time;
                style.display = DisplayStyle.Flex;
                paintDirty = true; forceSample = true;
            }
            ApplyOpenTransform(time);
            Hot = (Pointer - c).sqrMagnitude <= HotRadius * s * HotRadius * s || keyboard && time - openedAt < 3f;
            // hover from the pointer (the wheel moves under a still pointer as the camera moves); the panel is
            // only asked when the pointer is within the wheel's reach
            int hit = NoHit;
            var rel = Pointer - c;
            float reach = (arc.Count > 0 ? ArcRadius + ArcButtonRadius + 2f : OuterRadius + 8f) * s;
            if (panel != null && rel.sqrMagnitude <= reach * reach)
            {
                var picked = Picker != null ? Picker(Pointer) : panel.Pick(Pointer);
                if (picked == this) hit = HitTest(rel / s + new Vector2(Half, Half));
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
                UpdateReadout();
            }
            else if (highlightChanged) RefreshChildren();
            if (hoverChanged || highlightChanged) paintDirty = true;
            ReadoutFlash();
            PlaceReadout();
            if (paintDirty) { paintDirty = false; MarkDirtyRepaint(); }
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
                // centred at 6 o'clock, left to right, 26° apart
                float angle = 180f + 26f * (arcScratch.Count - 1) * .5f - 26f * i;
                arc.Add((arcScratch[i], angle));
            }
            slots.Clear();
            if (fixedAngles)
            {
                pages = 1;
                foreach (var item in scratch) slots.Add(new Slot { Item = item, Mid = Normalize(item.Angle.Value), Span = 45f });
            }
            else
            {
                int count = scratch.Count;
                pages = count > 8 ? Mathf.CeilToInt(count / 7f) : 1;
                if (level.Page >= pages) level.Page = 0;
                int start = pages > 1 ? level.Page * 7 : 0, take = pages > 1 ? Mathf.Min(7, count - start) : count;
                int n = take + (pages > 1 ? 1 : 0);
                float span = n <= 1 ? 90f : 360f / n;
                for (int i = 0; i < take; i++) slots.Add(new Slot { Item = scratch[start + i], Mid = i * span, Span = span });
                if (pages > 1) slots.Add(new Slot { Item = null, Mid = take * span, Span = span, More = true });
            }
            // digits 1–8 clockwise from 12 o'clock (More is 0): insertion sort, no comparer allocation
            order.Clear();
            for (int i = 0; i < slots.Count; i++)
            {
                if (slots[i].More) continue;
                float key = Normalize(slots[i].Mid + .01f);
                int at = order.Count;
                while (at > 0 && Normalize(slots[order[at - 1]].Mid + .01f) > key) at--;
                order.Insert(at, i);
            }
            for (int r = 0; r < order.Count; r++) { var s = slots[order[r]]; s.Key = r < 8 ? r + 1 : -1; slots[order[r]] = s; }
            for (int i = 0; i < slots.Count; i++) if (slots[i].More) { var s = slots[i]; s.Key = 0; slots[i] = s; }
            EnsurePool();
            PlaceChildren();
            return true;
        }

        static int AngleKey(RadialItem item) => item.Angle.HasValue ? Mathf.RoundToInt(item.Angle.Value) : int.MinValue;

        void EnsurePool()
        {
            while (icons.Count < slots.Count)
            {
                var icon = new IconElement("", "se-radial-icon"); Add(icon); icons.Add(icon);
                var lockIcon = new IconElement("lock", "se-radial-lock") { Tint = Warn }; Add(lockIcon); locks.Add(lockIcon);
                var badge = new Label("") { pickingMode = PickingMode.Ignore }; badge.AddToClassList("se-radial-badge"); Add(badge); badges.Add(badge); badgeShown.Add(-1);
                var caption = new Label("") { pickingMode = PickingMode.Ignore }; caption.AddToClassList("se-radial-caption"); Add(caption); captions.Add(caption);
                caption.style.position = Position.Absolute; caption.style.width = 36; caption.style.height = 14;
                badge.style.display = DisplayStyle.None; caption.style.display = DisplayStyle.None; lockIcon.style.display = DisplayStyle.None;
            }
            while (arcIcons.Count < arc.Count) { var icon = new IconElement("", "se-radial-arc-icon"); Add(icon); arcIcons.Add(icon); }
            if (state.Length < slots.Count) state = new SlotState[Mathf.Max(slots.Count, state.Length * 2)];
            if (arcUsable.Length < arc.Count) arcUsable = new bool[Mathf.Max(arc.Count, arcUsable.Length * 2)];
            readout.BringToFront();
        }

        /// <summary>Positions and glyphs of the children: only when the ring's layout changes.</summary>
        void PlaceChildren()
        {
            for (int i = 0; i < icons.Count; i++)
            {
                bool show = i < slots.Count;
                Show(icons[i], show);
                if (!show) { Show(locks[i], false); Show(badges[i], false); Show(captions[i], false); continue; }
                var s = slots[i];
                var ip = At(IconRadius, s.Mid);
                Place(icons[i], ip.x, ip.y, 32);
                icons[i].Kind = s.More ? "more" : s.Item.Icon ?? "";
                var lp = At(LockRadius, s.Mid - Mathf.Min(14f, s.Span * .25f));
                Place(locks[i], lp.x, lp.y, 12);
                var bp = At(BadgeRadius, s.Mid);
                Place(badges[i], bp.x, bp.y, 20);
                var cp = At(IconRadius - 26f, s.Mid);
                captions[i].style.left = cp.x - 18; captions[i].style.top = cp.y - 7;
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
            for (int i = 0; i < slots.Count; i++)
            {
                var s = slots[i];
                if (s.More || s.Item == null) continue;
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

        /// <summary>Tints, lock glyphs, badges and captions from the sampled state (10 Hz or on hover change).</summary>
        void RefreshChildren()
        {
            bool sub = levels.Count > 1;
            hubGlyph.Kind = sub ? "back" : hubIcon;
            int hubKey = (!sub && pips > 0 ? 1 : 0) | (pages > 1 ? 2 : 0);
            if (hubKey != hubPlacedFor)
            {
                hubPlacedFor = hubKey;
                Place(hubGlyph, Half, Half - ((hubKey & 1) != 0 ? 6 : 0) - ((hubKey & 2) != 0 ? 4 : 0), 30);
            }
            hubGlyph.Tint = hover == HubHit ? Color.white : TextColor;
            for (int i = 0; i < slots.Count && i < icons.Count; i++)
            {
                var s = slots[i];
                if (s.More) { icons[i].Tint = hover == i ? Color.white : TextColor; continue; }
                var item = s.Item;
                ref var st = ref state[i];
                bool hi = hover == i || HighlightId != null && HighlightId == item.Id;
                var tint = hi ? Color.white : TextColor;
                if (!st.Usable) tint.a = .4f;
                icons[i].Tint = tint;
                Show(locks[i], !st.Usable && item.Icon != "lock");
                int badge = st.Badge > 99 ? 99 : st.Badge;
                if (badge > 0 && badgeShown[i] != badge) { badgeShown[i] = badge; badges[i].text = badge.ToString(); }
                Show(badges[i], badge > 0);
                bool caption = !string.IsNullOrEmpty(st.Caption);
                if (caption) captions[i].text = st.Caption;
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
            if (hit >= 0 && hit < slots.Count) return slots[hit].More ? null : slots[hit].Item;
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
            for (int k = 0; k < arc.Count; k++)
                if ((local - At(ArcRadius, arc[k].angle)).sqrMagnitude <= (ArcButtonRadius + 2) * (ArcButtonRadius + 2)) return ArcHit + k;
            if (r < InnerRadius - 4 || r > OuterRadius + 6) return NoHit;
            float angle = Normalize(Mathf.Atan2(v.x, -v.y) * Mathf.Rad2Deg);
            for (int i = 0; i < slots.Count; i++)
                if (Mathf.Abs(DeltaAngle(angle, slots[i].Mid)) <= slots[i].Span * .5f) return i;
            return NoHit;
        }

        public override bool ContainsPoint(Vector2 localPoint)
        {
            if (!IsOpen) return false;
            var v = localPoint - new Vector2(Half, Half);
            if (v.sqrMagnitude <= (OuterRadius + 8) * (OuterRadius + 8)) return true;
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
            Execute(hit, 0, e.shiftKey, e.ctrlKey);
        }

        void OnWheel(WheelEvent e)
        {
            if (!IsOpen || pages <= 1) return;
            Page(e.delta.y > 0 ? 1 : -1);
            e.StopPropagation();
        }

        void Execute(int hit, int button, bool shift, bool ctrl)
        {
            forceSample = true;
            if (hit == HubHit && levels.Count > 1) { Back(); return; }
            if (hit >= 0 && hit < slots.Count && slots[hit].More) { Page(1); return; }
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
            item.Click?.Invoke(new RadialClick { Shift = shift, Ctrl = ctrl });
        }

        // ------------------------------------------------------------------ readout
        static readonly string[] DigitKeys = { "", "[1]", "[2]", "[3]", "[4]", "[5]", "[6]", "[7]", "[8]" };

        /// <summary>The readout card's text (10 Hz or when the hover changes; Label skips unchanged text).</summary>
        void UpdateReadout()
        {
            var item = hovered;
            int key = -1;
            if (hover >= 0 && hover < slots.Count) key = slots[hover].Key;
            if (hover >= 0 && hover < slots.Count && slots[hover].More)
            {
                readName.text = "More";
                readKey.text = "[0]";
                Show(readCost, false);
                readDetail.text = $"Page {levels[levels.Count - 1].Page + 1} of {pages}";
                Show(readDetail, true);
                Show(readReason, false);
            }
            else if (item == null)
            {
                bool sub = levels.Count > 1;
                readName.text = subject;
                readKey.text = sub ? "[Esc]" : "";
                Show(readCost, false);
                string detail = sub ? "Back to the previous ring" : SubjectDetail?.Invoke();
                readDetail.text = detail ?? "";
                Show(readDetail, !string.IsNullOrEmpty(detail));
                Show(readReason, false);
            }
            else
            {
                bool armed = armedId == item.Id;
                readName.text = armed ? "Confirm · " + item.TitleText : item.TitleText;
                readKey.text = key > 0 && key < DigitKeys.Length ? DigitKeys[key] : !string.IsNullOrEmpty(item.Hotkey) ? "[" + item.Hotkey + "]" : "";
                int materials = 0, energy = 0;
                if (item.Cost is JObject cost)
                {
                    materials = Mathf.RoundToInt(ProtocolDecoder.Float(cost["materials"]));
                    energy = Mathf.RoundToInt(ProtocolDecoder.Float(cost["energy"]));
                }
                bool anyCost = materials > 0 || energy > 0 || item.Seconds > 0;
                Show(readCost, anyCost);
                Show(readMaterialsIcon, materials > 0);
                Show(readMaterials, materials > 0);
                if (materials > 0) readMaterials.text = materials.ToString("N0");
                readMaterials.style.color = have != null && have("materials") < materials ? Bad : TextColor;
                Show(readEnergyIcon, energy > 0);
                Show(readEnergy, energy > 0);
                if (energy > 0) readEnergy.text = energy.ToString("N0");
                readEnergy.style.color = have != null && have("energy") < energy ? Bad : TextColor;
                readTime.text = item.Seconds > 0 ? item.Seconds + " s" : "";
                string detail = armed ? "Click again within 4 s to confirm" : item.Detail?.Invoke();
                readDetail.text = detail ?? "";
                Show(readDetail, !string.IsNullOrEmpty(detail));
                string reason = ReasonFor(item);
                if (!flashShown) readReason.text = reason ?? "";
                Show(readReason, !string.IsNullOrEmpty(reason) || flashShown);
            }
        }

        /// <summary>A refused click flashes its reason for 0.7 s (per frame only while flashing).</summary>
        void ReadoutFlash()
        {
            if (now < pulseUntil && !string.IsNullOrEmpty(flash))
            {
                flashShown = true;
                readReason.text = flash;
                Show(readReason, true);
                float k = Mathf.PingPong((pulseUntil - now) * 6f, 1f);
                readReason.style.color = Color.Lerp(Warn, Color.white, k);
            }
            else if (flashShown)
            {
                flashShown = false;
                readReason.style.color = Warn;
                forceSample = true;   // restore the hovered item's own reason next frame
            }
        }

        void PlaceReadout()
        {
            float h = readout.resolvedStyle.height;
            if (float.IsNaN(h) || h < 64) h = 64;
            float top = readoutAbove ? Half - ReadoutGap - h : Half + ReadoutGap;
            if (!(Mathf.Abs(top - readoutTop) < .01f)) { readoutTop = top; readout.style.top = top; }
        }

        // ------------------------------------------------------------------ painting
        void Paint(MeshGenerationContext ctx)
        {
            if (!shown) return;
            var p = ctx.painter2D;
            var c = new Vector2(Half, Half);
            p.lineJoin = LineJoin.Miter;
            for (int i = 0; i < slots.Count; i++)
            {
                var s = slots[i];
                float a0 = s.Mid - s.Span * .5f + GapDegrees * .5f, a1 = s.Mid + s.Span * .5f - GapDegrees * .5f;
                var item = s.Item;
                bool hi = hover == i || !s.More && item != null && HighlightId != null && HighlightId == item.Id;
                bool armed = !s.More && item != null && armedId == item.Id;
                var fill = armed ? Armed : hi ? SurfaceHover : Surface;
                Sector(p, a0, a1, InnerRadius, OuterRadius, fill);
                if (hi)
                {
                    // a soft brass glow: a warm wash inside, two faint halos just outside the rim
                    Sector(p, a0, a1, InnerRadius, OuterRadius, GlowFill);
                    ArcStroke(p, a0, a1, OuterRadius + 4f, 7f, GlowWide);
                    ArcStroke(p, a0, a1, OuterRadius + 1.5f, 3f, GlowNear);
                }
                else ArcStroke(p, a0, a1, OuterRadius + .5f, 1f, Rim);
                // crisp hairline edge
                p.strokeColor = hi ? GlowNear : Line; p.lineWidth = 1f;
                SectorOutline(p, a0, a1, InnerRadius, OuterRadius);
                if (s.More || item == null)
                {
                    if (hi) ArcStroke(p, a0, a1, OuterRadius - 1.5f, 3f, Accent);
                    continue;
                }
                var st = state[i];
                if (st.Cooldown > .001f) Sector(p, a0, a0 + (a1 - a0) * Mathf.Clamp01(st.Cooldown), InnerRadius, OuterRadius, CooldownShade);
                if (st.Active) ArcStroke(p, a0, a1, InnerRadius + 1.5f, 3f, Good);
                if (item.Pulse && !hi)
                {
                    float alpha = Mathf.Lerp(.35f, .7f, .5f + .5f * Mathf.Sin(now * Mathf.PI * 2f / 1.6f));
                    ArcStroke(p, a0, a1, OuterRadius - 1.5f, 2.5f, new Color(Accent.r, Accent.g, Accent.b, alpha));
                }
                if (hi) ArcStroke(p, a0, a1, OuterRadius - 1.5f, 3f, Accent);
                if (st.Progress >= 0f)
                {
                    ArcStroke(p, a0, a1, OuterRadius - 4f, 4f, ProgressTrack);
                    if (st.Progress > 0f) ArcStroke(p, a0, a0 + (a1 - a0) * Mathf.Clamp01(st.Progress), OuterRadius - 4f, 4f, Good);
                }
            }
            // hub: a little more opaque than the wedges so the glyph and pips always read
            bool hubHover = hover == HubHit;
            if (hubHover)
            {
                p.strokeColor = GlowWide; p.lineWidth = 7f;
                p.BeginPath(); p.Arc(c, HubRadius + 4f, 0f, 360f); p.Stroke();
            }
            p.fillColor = hubHover ? HubHover : HubSurface;
            p.BeginPath(); p.Arc(c, HubRadius, 0f, 360f); p.Fill();
            p.strokeColor = hubHover ? Accent : Line; p.lineWidth = hubHover ? 2f : 1f;
            p.BeginPath(); p.Arc(c, HubRadius, 0f, 360f); p.Stroke();
            if (hubProgress >= 0f)
            {
                ArcStroke(p, 0f, 359.9f, HubRadius + 4f, 3f, HubTrack);
                if (hubProgress > 0f) ArcStroke(p, 0f, 360f * Mathf.Clamp01(hubProgress), HubRadius + 4f, 3f, Good);
            }
            int drawPips = lastLevels == 1 ? pips : 0;
            if (drawPips > 0)
            {
                float y = Half + 13f + (pages > 1 ? -2f : 0f);
                for (int k = 0; k < 3; k++)
                {
                    float x = Half - 10f + k * 8f;
                    FillRect(p, x - 3f, y - 3f, 6f, 6f, k < drawPips ? Friendly : PipOff);
                }
            }
            if (pages > 1)
            {
                float total = pages * 6f + (pages - 1) * 4f, x0 = Half - total * .5f + 3f, y = Half + 24f;
                for (int k = 0; k < pages; k++)
                {
                    p.fillColor = k == page ? Accent : PageOff;
                    p.BeginPath(); p.Arc(new Vector2(x0 + k * 10f, y), 3f, 0f, 360f); p.Fill();
                }
            }
            // outer command arc
            for (int k = 0; k < arc.Count; k++)
            {
                var at = At(ArcRadius, arc[k].angle);
                bool hi = hover == ArcHit + k;
                if (hi)
                {
                    p.strokeColor = GlowWide; p.lineWidth = 6f;
                    p.BeginPath(); p.Arc(at, ArcButtonRadius + 3.5f, 0f, 360f); p.Stroke();
                }
                p.fillColor = hi ? SurfaceHover : SurfaceButton;
                p.BeginPath(); p.Arc(at, ArcButtonRadius, 0f, 360f); p.Fill();
                p.strokeColor = hi ? Accent : Line; p.lineWidth = hi ? 2f : 1f;
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

        static void SectorOutline(Painter2D p, float a0, float a1, float r0, float r1)
        {
            int steps = Mathf.Max(2, Mathf.CeilToInt((a1 - a0) / 4f));
            p.BeginPath();
            p.MoveTo(At(r1, a0));
            for (int k = 1; k <= steps; k++) p.LineTo(At(r1, Mathf.Lerp(a0, a1, k / (float)steps)));
            for (int k = steps; k >= 0; k--) p.LineTo(At(r0, Mathf.Lerp(a0, a1, k / (float)steps)));
            p.ClosePath();
            p.Stroke();
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
