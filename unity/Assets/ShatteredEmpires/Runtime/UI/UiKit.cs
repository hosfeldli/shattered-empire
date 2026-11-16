using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Shared interface building blocks (docs/UI_DESIGN_SPEC.md § C2). Every implementer builds buttons,
    /// chips, segmented controls, setting rows, cost rows and page stacks with these so the whole
    /// interface has one look and one behaviour. Styles live in Resources/UI/SE.uss (.se-* classes and
    /// the --se-* tokens on :root).
    ///
    /// Rule: never set <c>.text</c> on a button built here (it would draw a second string over the
    /// label child); call <see cref="SetText"/> instead.
    /// </summary>
    public static class UiKit
    {
        // ------------------------------------------------------------------ elements
        static void Classes(VisualElement e, string cls)
        {
            if (string.IsNullOrEmpty(cls)) return;
            foreach (var c in cls.Split(' ')) if (c.Length > 0) e.AddToClassList(c);
        }

        /// <summary>A plain element with optional space-separated classes, added to <paramref name="parent"/>.</summary>
        public static VisualElement El(string cls = null, VisualElement parent = null)
        {
            var e = new VisualElement();
            Classes(e, cls);
            parent?.Add(e);
            return e;
        }

        /// <summary>A label (single line unless the class says otherwise).</summary>
        public static Label Text(string text, string cls = null, VisualElement parent = null)
        {
            var l = new Label(text ?? "");
            Classes(l, cls);
            parent?.Add(l);
            return l;
        }

        /// <summary>
        /// A standard button (.se-btn, 36 high): optional icon (20) then the label. No tooltip is set: a
        /// tooltip that repeats the label is noise. Update the label with <see cref="SetText"/>.
        /// </summary>
        public static UnityEngine.UIElements.Button Button(string label, Action click, VisualElement parent = null, string icon = null, string cls = null)
        {
            var b = new UnityEngine.UIElements.Button { text = "" };
            if (click != null) b.clicked += click;
            b.AddToClassList("se-btn");
            Classes(b, cls);
            if (!string.IsNullOrEmpty(icon)) b.Add(new IconElement(icon, "se-btn-icon"));
            if (!string.IsNullOrEmpty(label)) Text(label, "se-btn-label", b);
            parent?.Add(b);
            return b;
        }

        /// <summary>A square icon-only button (36×36 with a 20 icon; 28×28 with a 16 icon). The tooltip names it.</summary>
        public static UnityEngine.UIElements.Button IconButton(string icon, Action click, string tooltip, VisualElement parent = null, int size = 36)
        {
            var b = new UnityEngine.UIElements.Button { text = "" };
            if (click != null) b.clicked += click;
            b.AddToClassList("se-btn");
            b.AddToClassList("se-icon-btn");
            if (size <= 28) b.AddToClassList("se-icon-btn--small");
            b.style.width = size; b.style.height = size;
            b.style.minWidth = size; b.style.minHeight = size;
            float iconSize = size >= 36 ? 20 : size <= 28 ? 16 : Mathf.Round(size * 0.56f);
            var ic = new IconElement(icon ?? "", "se-btn-icon");
            ic.style.width = iconSize; ic.style.height = iconSize;
            ic.style.marginLeft = 0; ic.style.marginRight = 0;
            b.Add(ic);
            if (!string.IsNullOrEmpty(tooltip)) b.tooltip = tooltip;
            parent?.Add(b);
            return b;
        }

        /// <summary>A chip (.se-chip, 36 high, the caller sets the width) with a leading icon; add labels to it.</summary>
        public static UnityEngine.UIElements.Button Chip(string icon, VisualElement parent = null)
        {
            var b = new UnityEngine.UIElements.Button { text = "" };
            b.AddToClassList("se-chip");
            if (!string.IsNullOrEmpty(icon)) b.Add(new IconElement(icon, "se-chip-icon"));
            parent?.Add(b);
            return b;
        }

        /// <summary>Sets the label of a button built by <see cref="Button"/> (adds one if it has none).</summary>
        public static void SetText(UnityEngine.UIElements.Button b, string text)
        {
            if (b == null) return;
            var l = b.Q<Label>(className: "se-btn-label");
            if (l == null) l = Text("", "se-btn-label", b);
            if (l.text != text) l.text = text ?? "";
        }

        /// <summary>The icon element inside a button or chip built here (null if none).</summary>
        public static IconElement IconOf(VisualElement b) => b?.Q<IconElement>();

        /// <summary>
        /// A segmented control: fixed-width segments (an icon or a short label each), one selected.
        /// Width = segmentWidth × count + 2. Clicking calls <paramref name="pick"/>; setting
        /// <c>Segmented.Value</c> only updates the highlight.
        /// </summary>
        public static global::SE.Runtime.UI.Segmented Segmented(IReadOnlyList<(string id, string label, string icon)> items, string selected, Action<string> pick, VisualElement parent = null, int segmentWidth = 44)
        {
            var s = new global::SE.Runtime.UI.Segmented();
            s.AddToClassList("se-segmented");
            s.Pick = pick;
            for (int i = 0; i < items.Count; i++)
            {
                var (id, label, icon) = items[i];
                string segId = id;
                var b = new UnityEngine.UIElements.Button { text = "" };
                b.AddToClassList("se-segment");
                b.style.width = segmentWidth;
                if (!string.IsNullOrEmpty(icon))
                {
                    var ic = new IconElement(icon, "se-segment-icon");
                    b.Add(ic);
                    if (!string.IsNullOrEmpty(label)) b.tooltip = label;
                }
                else Text(label ?? segId, "se-segment-label", b);
                b.clicked += () => s.Choose(segId);
                s.AddSegment(segId, b);
            }
            s.style.width = segmentWidth * items.Count + 2;
            s.Value = selected;
            parent?.Add(s);
            return s;
        }

        /// <summary>A settings row (40 high): label column 220, control column flexible.</summary>
        public static VisualElement SettingRow(string label, VisualElement control, VisualElement parent)
        {
            var row = El("se-setting-row", parent);
            Text(label, "se-setting-label", row);
            var holder = El("se-setting-control", row);
            if (control != null) holder.Add(control);
            return row;
        }

        /// <summary>A 44×24 switch (a Toggle restyled by .se-switch; no built-in label).</summary>
        public static Toggle Switch(bool value, Action<bool> set)
        {
            var t = new Toggle();
            t.AddToClassList("se-switch");
            t.SetValueWithoutNotify(value);
            t.EnableInClassList("se-switch--on", value);
            var track = t.Q(className: "unity-toggle__checkmark");
            if (track != null) El("se-switch-knob", track);
            t.RegisterValueChangedCallback(e =>
            {
                t.EnableInClassList("se-switch--on", e.newValue);
                set?.Invoke(e.newValue);
            });
            return t;
        }

        /// <summary>
        /// A slider (280) with its value label (48). With <paramref name="applyOnRelease"/> the label follows
        /// the drag but <paramref name="set"/> runs only once the mouse button is released.
        /// </summary>
        public static VisualElement SliderRow(float value, float min, float max, Func<float, string> format, Action<float> set, bool applyOnRelease = false)
        {
            var row = El("se-slider-row");
            var slider = new Slider(min, max) { value = value };
            slider.AddToClassList("se-slider");
            row.Add(slider);
            var valueLabel = Text(format != null ? format(value) : value.ToString("0.##"), "se-slider-value", row);
            float applied = value, pending = value;
            slider.RegisterValueChangedCallback(e =>
            {
                pending = e.newValue;
                valueLabel.text = format != null ? format(e.newValue) : e.newValue.ToString("0.##");
                if (!applyOnRelease) { applied = pending; set?.Invoke(pending); }
            });
            if (applyOnRelease)
                row.schedule.Execute(() =>
                {
                    if (Mathf.Approximately(pending, applied) || Input.InputFacade.LeftHeld) return;
                    applied = pending;
                    set?.Invoke(pending);
                }).Every(100);
            return row;
        }

        /// <summary>
        /// Materials and Energy cost: icon 14 + value each (zero parts omitted); a value turns red when
        /// <paramref name="have"/> reports less than it costs. <paramref name="have"/> may be null.
        /// </summary>
        public static VisualElement CostRow(JToken cost, Func<string, int> have, VisualElement parent)
        {
            var row = El("se-cost-row", parent);
            var values = cost as JObject;
            foreach (var res in new[] { "materials", "energy" })
            {
                int amount = Mathf.RoundToInt(ProtocolDecoder.Float(values?[res]));
                if (amount <= 0) continue;
                var part = El("se-cost", row);
                var ic = new IconElement(res, "se-cost-icon");
                part.Add(ic);
                var l = Text(amount.ToString("N0"), "se-cost-value", part);
                l.EnableInClassList("se-cost--short", have != null && have(res) < amount);
            }
            return row;
        }

        /// <summary>A vertical scroll view that shrinks to the space it is given (replaces Hud.Scroll).</summary>
        public static ScrollView BoundedScroll(VisualElement parent)
        {
            var scroll = new ScrollView(ScrollViewMode.Vertical)
            {
                horizontalScrollerVisibility = ScrollerVisibility.Hidden,
                verticalScrollerVisibility = ScrollerVisibility.Auto,
                mouseWheelScrollSize = 38
            };
            scroll.AddToClassList("bounded-scroll");
            scroll.style.minHeight = 0;
            scroll.style.flexShrink = 1;
            scroll.contentContainer.style.flexShrink = 0;
            parent?.Add(scroll);
            return scroll;
        }

        // ------------------------------------------------------------------ colour
        /// <summary>Relation colour of an owner (B5): friendly blue, ally teal, each enemy its hue, neutral sand.
        /// Delegates to <see cref="ClientSession.CivColor"/> so there is one source of truth.</summary>
        public static Color RelationColor(ClientSession s, int owner)
        {
            if (s == null) return Token("neutral");
            var c = s.CivColor(owner);
            var col = new Color(c.x, c.y, c.z, 1f);
            // the action ruleset's relation palette is stored linear (for the renderers); UI wants sRGB
            return s.ActionRts ? col.gamma : col;
        }

        static readonly Dictionary<string, Color> tokens = new Dictionary<string, Color>
        {
            ["surface-0"] = new Color(8 / 255f, 12 / 255f, 14 / 255f, .80f),
            ["surface-1"] = new Color(14 / 255f, 21 / 255f, 24 / 255f, .92f),
            ["surface-2"] = new Color(30 / 255f, 40 / 255f, 43 / 255f, .96f),
            ["surface-hover"] = new Color(52 / 255f, 66 / 255f, 66 / 255f, .98f),
            ["line"] = new Color(1f, 1f, 1f, .08f),
            ["accent"] = new Color(226 / 255f, 182 / 255f, 96 / 255f, 1f),
            ["accent-dim"] = new Color(226 / 255f, 182 / 255f, 96 / 255f, .35f),
            ["text"] = new Color(232 / 255f, 226 / 255f, 210 / 255f, 1f),
            ["text-dim"] = new Color(150 / 255f, 164 / 255f, 160 / 255f, 1f),
            ["good"] = new Color(142 / 255f, 212 / 255f, 132 / 255f, 1f),
            ["warn"] = new Color(240 / 255f, 188 / 255f, 86 / 255f, 1f),
            ["bad"] = new Color(242 / 255f, 116 / 255f, 96 / 255f, 1f),
            ["friendly"] = new Color(74 / 255f, 150 / 255f, 255 / 255f, 1f),
            ["ally"] = new Color(64 / 255f, 200 / 255f, 190 / 255f, 1f),
            ["neutral"] = new Color(200 / 255f, 170 / 255f, 110 / 255f, 1f),
            ["pressed"] = new Color(92 / 255f, 78 / 255f, 44 / 255f, 1f),
            ["selected"] = new Color(98 / 255f, 82 / 255f, 44 / 255f, .96f),
            ["confirm"] = new Color(170 / 255f, 60 / 255f, 40 / 255f, .85f),
        };

        /// <summary>The C# mirror of an SE.uss token for Painter2D users: "accent", "se-accent" or "--se-accent".</summary>
        public static Color Token(string name)
        {
            if (string.IsNullOrEmpty(name)) return Color.white;
            string key = name.StartsWith("--se-") ? name.Substring(5) : name.StartsWith("se-") ? name.Substring(3) : name;
            return tokens.TryGetValue(key, out var c) ? c : Color.white;
        }

        // ------------------------------------------------------------------ escape / back
        /// <summary>
        /// A stack of pages shown one at a time in <c>host</c> (its content is replaced on navigation).
        /// Escape and Back buttons call <see cref="Pop"/>; a page is built once and kept while it is on the
        /// stack, so going back restores it as it was (scroll position included).
        /// </summary>
        public sealed class PageStack
        {
            sealed class Entry { public string Id; public Func<VisualElement> Build; public bool Wide; public VisualElement Page; }
            readonly VisualElement host;
            readonly List<Entry> stack = new List<Entry>();

            public PageStack(VisualElement host) { this.host = host; }

            /// <summary>Raised whenever a page is shown: true when it wants the wide frame (.se-frame--wide).</summary>
            public event Action<bool> WideChanged;

            public string Top => stack.Count == 0 ? null : stack[stack.Count - 1].Id;
            public int Depth => stack.Count;

            public void Push(string id, Func<VisualElement> build, bool wide = false)
            {
                stack.Add(new Entry { Id = id, Build = build, Wide = wide });
                Show();
            }

            /// <summary>Back one level; false (and nothing changes) at the root.</summary>
            public bool Pop()
            {
                if (stack.Count <= 1) return false;
                stack.RemoveAt(stack.Count - 1);
                Show();
                return true;
            }

            /// <summary>Clears the stack and shows <paramref name="build"/> as the root page.</summary>
            public void Reset(string id, Func<VisualElement> build)
            {
                stack.Clear();
                stack.Add(new Entry { Id = id, Build = build, Wide = false });
                Show();
            }

            /// <summary>Rebuilds the top page from its builder (for content that changed underneath it).</summary>
            public void Refresh()
            {
                if (stack.Count == 0) return;
                stack[stack.Count - 1].Page = null;
                Show();
            }

            void Show()
            {
                host.Clear();
                if (stack.Count == 0) { WideChanged?.Invoke(false); return; }
                var top = stack[stack.Count - 1];
                if (top.Page == null) top.Page = top.Build?.Invoke();
                if (top.Page != null)
                {
                    top.Page.style.flexGrow = 1;
                    host.Add(top.Page);
                }
                WideChanged?.Invoke(top.Wide);
            }
        }
    }

    /// <summary>A segmented control built by <see cref="UiKit.Segmented"/>.</summary>
    public sealed class Segmented : VisualElement
    {
        readonly List<(string id, UnityEngine.UIElements.Button button)> segments = new List<(string, UnityEngine.UIElements.Button)>();
        string current;
        internal Action<string> Pick;

        /// <summary>The selected segment id; setting it only moves the highlight (no callback).</summary>
        public string Value
        {
            get => current;
            set
            {
                current = value;
                foreach (var (id, b) in segments) b.EnableInClassList("selected", id == value);
            }
        }

        /// <summary>The button of one segment (to show/hide or retitle it), or null.</summary>
        public UnityEngine.UIElements.Button Segment(string id)
        {
            foreach (var (sid, b) in segments) if (sid == id) return b;
            return null;
        }

        internal void AddSegment(string id, UnityEngine.UIElements.Button b)
        {
            segments.Add((id, b));
            Add(b);
        }

        internal void Choose(string id)
        {
            Value = id;
            Pick?.Invoke(id);
        }
    }
}
