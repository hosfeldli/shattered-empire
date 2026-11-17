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

        // ------------------------------------------------------------------ motion (UI transitions)
        // Panels, cards, banners, toasts and tooltips fade with a small slide or scale through USS transitions
        // (SE.uss "UI transitions"): the element carries .se-fx (its hidden look: transparent, slightly scaled or
        // offset) and .se-in (its shown look). Transitions run on the panel's real-time clock, so they also play
        // while the game is paused. Show sets display Flex and adds .se-in a frame later (a transition needs one
        // styled frame in the start state); Hide removes .se-in and sets display None only once the out-transition
        // has finished. Each element gets one Fader with two reusable scheduled items: toggling never allocates.
        // "Reduce UI motion" (GameSettings.ReduceUiMotion) adds .se-calm to the root (zero durations) and makes
        // Show/Hide immediate.

        /// <summary>Durations (ms) of the in- and out-transitions in SE.uss (.se-fx / .se-in).</summary>
        public const int InMs = 180, OutMs = 140;
        /// <summary>The start-state frame before .se-in is added (at least one styled frame at any frame rate).</summary>
        const int EnterDelayMs = 20;
        public const string FxClass = "se-fx", InClass = "se-in", CalmClass = "se-calm";

        /// <summary>True while the player asked for reduced interface motion.</summary>
        public static bool Calm => App.GameSettings.ReduceUiMotion;

        sealed class Fader
        {
            readonly VisualElement el;
            IVisualElementScheduledItem inJob, outJob;
            public bool Shown, Leaving, RemoveWhenHidden;

            public Fader(VisualElement e) { el = e; }

            public void Show()
            {
                RemoveWhenHidden = false;
                if (Shown) return;
                Shown = true;
                if (Leaving)
                {
                    // reversed mid-way: the transition turns back from where it is
                    Leaving = false;
                    outJob?.Pause();
                    el.AddToClassList(InClass);
                    return;
                }
                el.style.display = DisplayStyle.Flex;
                if (Calm) { el.AddToClassList(InClass); return; }
                el.RemoveFromClassList(InClass);
                if (inJob == null) inJob = el.schedule.Execute(AddIn);
                inJob.ExecuteLater(EnterDelayMs);
            }

            void AddIn() { if (Shown) el.AddToClassList(InClass); }

            public void Hide()
            {
                if (!Shown) { if (!Leaving && el.style.display != DisplayStyle.None) Finish(); return; }
                Shown = false;
                inJob?.Pause();
                bool wasIn = el.ClassListContains(InClass);
                el.RemoveFromClassList(InClass);
                if (!wasIn || Calm || el.panel == null) { Finish(); return; }
                Leaving = true;
                if (outJob == null) outJob = el.schedule.Execute(Finish);
                outJob.ExecuteLater(OutMs + 20);
            }

            public void Finish()
            {
                Leaving = false;
                if (Shown) return;
                el.style.display = DisplayStyle.None;
                if (RemoveWhenHidden) { RemoveWhenHidden = false; el.RemoveFromHierarchy(); }
            }
        }

        static readonly System.Runtime.CompilerServices.ConditionalWeakTable<VisualElement, Fader> faders = new System.Runtime.CompilerServices.ConditionalWeakTable<VisualElement, Fader>();
        static readonly System.Runtime.CompilerServices.ConditionalWeakTable<VisualElement, Fader>.CreateValueCallback newFader = e => new Fader(e);
        static Fader FaderOf(VisualElement e) => faders.GetValue(e, newFader);

        /// <summary>
        /// Makes <paramref name="e"/> a transitioned element: .se-fx plus an optional variant (".se-fx--up",
        /// ".se-fx--left", ".se-fx--cdown" / ".se-fx--cup" for elements centred with translate -50%, ".se-fx--follow"
        /// for elements moved by translate every frame, ".se-fx--quick"), starting hidden (display None) unless
        /// <paramref name="shown"/>. From then on show and hide it only with <see cref="Show"/> / <see cref="Hide"/>.
        /// </summary>
        public static T Fx<T>(T e, string variant = null, bool shown = false) where T : VisualElement
        {
            if (e == null) return null;
            e.AddToClassList(FxClass);
            Classes(e, variant);
            var f = FaderOf(e);
            f.Shown = shown;
            e.EnableInClassList(InClass, shown);
            e.style.display = shown ? DisplayStyle.Flex : DisplayStyle.None;
            return e;
        }

        /// <summary>Fade (and slide/scale) a <see cref="Fx"/> element in. Cheap when it is already shown (call it per frame freely).</summary>
        public static void Show(VisualElement e) { if (e != null) FaderOf(e).Show(); }

        /// <summary>Fade a <see cref="Fx"/> element out; display None once the transition has finished. Cheap when already hidden.</summary>
        public static void Hide(VisualElement e) { if (e != null) FaderOf(e).Hide(); }

        public static void SetShown(VisualElement e, bool on) { if (on) Show(e); else Hide(e); }

        /// <summary>The logical state of a <see cref="Fx"/> element: false from the moment it starts fading out.</summary>
        public static bool IsShown(VisualElement e) => e != null && FaderOf(e).Shown;

        /// <summary>Hide immediately (no out-transition), e.g. when the whole interface is torn down.</summary>
        public static void HideNow(VisualElement e)
        {
            if (e == null) return;
            var f = FaderOf(e);
            f.Shown = false;
            e.RemoveFromClassList(InClass);
            f.Finish();
        }

        /// <summary>Fade a transient element (a card, a dialog) out, then remove it from the hierarchy.</summary>
        public static void HideAndRemove(VisualElement e)
        {
            if (e == null) return;
            if (!e.ClassListContains(FxClass) || e.panel == null) { e.RemoveFromHierarchy(); return; }
            var f = FaderOf(e);
            f.Hide();
            if (e.style.display == DisplayStyle.None) e.RemoveFromHierarchy();
            else f.RemoveWhenHidden = true;   // Finish removes it once faded
        }

        sealed class EnterJob
        {
            public VisualElement El;
            public int Stage;
            public void Run()
            {
                if (Stage == 0) { Stage = 1; El.RemoveFromClassList("se-enter"); job.ExecuteLater(InMs + 80); }
                else El.RemoveFromClassList("se-enter-anim");
            }
            public IVisualElementScheduledItem job;
        }

        /// <summary>
        /// One-shot entrance for a newly built element (a list row, a page, rebuilt card content): it starts
        /// transparent and 6 px low and eases in after <paramref name="delayMs"/>. For elements in normal flow (it
        /// sets translate while it runs). Nothing happens with reduced UI motion.
        /// </summary>
        public static void Enter(VisualElement e, int delayMs = 0)
        {
            if (e == null || Calm) return;
            e.AddToClassList("se-enter-anim");
            e.AddToClassList("se-enter");
            var j = new EnterJob { El = e };
            j.job = e.schedule.Execute(j.Run);
            j.job.ExecuteLater(EnterDelayMs + Mathf.Max(0, delayMs));
        }

        /// <summary>
        /// Entrance for the children of <paramref name="parent"/> from index <paramref name="from"/>, staggered by
        /// <paramref name="staggerMs"/> (at most 12 steps, so a long list never takes long). Pass the child count
        /// from before a rebuild as <paramref name="from"/> to animate only rows that were added.
        /// </summary>
        public static void EnterChildren(VisualElement parent, int from = 0, int staggerMs = 22)
        {
            if (parent == null || Calm) return;
            for (int i = Mathf.Max(0, from), k = 0; i < parent.childCount; i++, k++) Enter(parent[i], Mathf.Min(k, 12) * staggerMs);
        }

        /// <summary>
        /// For a list about to be cleared and refilled: call with its child count from before the Clear(); once the
        /// rebuild is done (the panel's next scheduler tick, before the new rows are first styled) the rows beyond
        /// that count ease in, staggered. A periodic refresh with the same rows therefore never flashes.
        /// </summary>
        public static void EnterAdded(VisualElement parent, int before)
        {
            if (parent == null || Calm) return;
            parent.schedule.Execute(() => EnterChildren(parent, before));
        }

        /// <summary>Applies the "Reduce UI motion" setting to the panel that holds <paramref name="any"/> (and to it).</summary>
        public static void ApplyMotion(VisualElement any)
        {
            if (any == null) return;
            bool calm = Calm;
            any.EnableInClassList(CalmClass, calm);
            var top = any.panel?.visualTree;
            if (top != null && top != any) top.EnableInClassList(CalmClass, calm);
            // turning it off clears the class wherever an earlier call put it (the Hud root before it had a panel)
            if (!calm) for (var p = any.parent; p != null; p = p.parent) p.RemoveFromClassList(CalmClass);
        }

        /// <summary>
        /// Smooth height changes of a bottom-anchored or flowing panel whose content is rebuilt (the selection
        /// panel): call <see cref="SmoothResize.Arm"/> just before the rebuild; when the new layout differs, the
        /// height eases from the old to the new value instead of popping (overflow hidden while it runs).
        /// </summary>
        public sealed class SmoothResize
        {
            readonly VisualElement el;
            readonly IVisualElementScheduledItem go, release;
            float from = float.NaN, to;
            bool armed;

            public SmoothResize(VisualElement e)
            {
                el = e;
                go = e.schedule.Execute(Go); go.Pause();
                release = e.schedule.Execute(Release); release.Pause();
                e.RegisterCallback<GeometryChangedEvent>(OnGeometry);
            }

            /// <summary>Remember the current height (only when the element is shown and laid out).</summary>
            public void Arm()
            {
                if (Calm || el.panel == null || el.resolvedStyle.display == DisplayStyle.None) { armed = false; return; }
                float h = el.layout.height;
                if (float.IsNaN(h) || h < 1f) { armed = false; return; }
                // a rebuild during a running resize starts from the height on screen now
                from = h; armed = true;
            }

            void OnGeometry(GeometryChangedEvent e)
            {
                if (!armed) return;
                armed = false;
                float h = e.newRect.height;
                if (float.IsNaN(h) || Mathf.Abs(h - from) < 2f) return;
                to = h;
                el.RemoveFromClassList("se-resizing");
                el.style.height = from;
                release.Pause();
                go.ExecuteLater(EnterDelayMs);
            }

            void Go()
            {
                el.AddToClassList("se-resizing");
                el.style.height = to;
                release.ExecuteLater(InMs + 40);
            }

            void Release()
            {
                el.RemoveFromClassList("se-resizing");
                el.style.height = StyleKeyword.Null;
            }
        }

        /// <summary>
        /// A value that eases toward its target on unscaled time (resource counters, bars driven from code).
        /// No allocation; <see cref="Step"/> returns true when the shown value changed.
        /// </summary>
        public struct Tween
        {
            public float Value, Target;
            bool started;

            /// <summary>
            /// Move toward <paramref name="target"/>: about 95 % of the way in <paramref name="seconds"/>, snapping
            /// once within <paramref name="snap"/>. The first call (and reduced UI motion) jumps straight there.
            /// </summary>
            public bool Step(float target, float dt, float seconds = .35f, float snap = .5f)
            {
                Target = target;
                if (!started || Calm || seconds <= 0f)
                {
                    started = true;
                    bool changed = Value != target;
                    Value = target;
                    return changed;
                }
                if (Value == target) return false;
                float k = 1f - Mathf.Exp(-Mathf.Max(0f, dt) * 3f / seconds);
                float next = Value + (target - Value) * k;
                if (Mathf.Abs(target - next) <= snap) next = target;
                Value = next;
                return true;
            }

            /// <summary>Jump to <paramref name="value"/> (no easing).</summary>
            public void Set(float value) { Value = Target = value; started = true; }
        }

        // Cached "N0" strings for small non-negative integers: a counting number allocates no string per frame.
        static string[] intText;
        const int IntTextMax = 32768;

        /// <summary>The "N0" text of <paramref name="v"/> (cached for 0..32767).</summary>
        public static string IntText(int v)
        {
            if (v < 0 || v >= IntTextMax) return v.ToString("N0");
            if (intText == null) intText = new string[IntTextMax];
            return intText[v] ??= v.ToString("N0");
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
                var top = stack.Count == 0 ? null : stack[stack.Count - 1];
                if (top != null && top.Page == null) top.Page = top.Build?.Invoke();
                // the page on screen cross-fades out where it stands (absolutely placed, so nothing shifts) while
                // the new one eases in (UiKit.Enter); a page kept on the stack is restored when it comes back
                for (int i = host.childCount - 1; i >= 0; i--)
                {
                    var old = host[i];
                    if (top == null || old != top.Page) Leave(old);
                }
                if (top == null) { WideChanged?.Invoke(false); return; }
                if (top.Page != null)
                {
                    Unleave(top.Page);
                    top.Page.style.flexGrow = 1;
                    if (top.Page.parent != host) host.Add(top.Page);
                    else top.Page.BringToFront();
                    Enter(top.Page);
                }
                WideChanged?.Invoke(top.Wide);
            }

            static void Leave(VisualElement old)
            {
                if (old.ClassListContains("se-leave")) return;
                var r = old.layout;
                if (Calm || old.panel == null || float.IsNaN(r.width) || r.width < 1f) { old.RemoveFromHierarchy(); return; }
                old.style.position = Position.Absolute;
                old.style.left = r.x; old.style.top = r.y; old.style.width = r.width; old.style.height = r.height;
                old.AddToClassList("se-leave");
                old.schedule.Execute(() => { if (old.ClassListContains("se-leave")) { old.RemoveFromHierarchy(); Unleave(old); } }).ExecuteLater(OutMs);
            }

            static void Unleave(VisualElement page)
            {
                if (!page.ClassListContains("se-leave")) return;
                page.RemoveFromClassList("se-leave");
                page.style.position = StyleKeyword.Null;
                page.style.left = StyleKeyword.Null; page.style.top = StyleKeyword.Null;
                page.style.width = StyleKeyword.Null; page.style.height = StyleKeyword.Null;
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
