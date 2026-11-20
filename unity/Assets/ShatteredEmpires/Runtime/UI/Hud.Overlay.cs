using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The battle overlay: what is happening, at a glance, drawn in one vector pass (no element per unit).
    ///  · Health bars over selected units, damaged units and anything in contact; selection brackets.
    ///  · Order lines: from selected units to where they were sent (dotted; a ring at the destination),
    ///    coloured by order (move, attack, capture, collect) and cleared on arrival.
    ///  · Under attack: pulsing red rings on your forces taking fire, and arrows at the screen edge
    ///    pointing toward attacks out of view.
    /// </summary>
    public sealed partial class Hud
    {
        sealed class OverlayCanvas : VisualElement
        {
            public readonly List<(Vector2 p, float hp, Color team, bool selected, float width)> Bars = new List<(Vector2, float, Color, bool, float)>();
            public readonly List<(Vector2 a, Vector2 b, Color color)> Lines = new List<(Vector2, Vector2, Color)>();
            public readonly List<(Vector2 p, Color color, float radius)> Rings = new List<(Vector2, Color, float)>();
            public readonly List<(Vector2 p, float angle, float alpha)> Arrows = new List<(Vector2, float, float)>();
            /// <summary>The drag-selection rectangle in panel space (shown while <see cref="HasBox"/>).</summary>
            public Rect Box;
            public bool HasBox;
            public OverlayCanvas() { pickingMode = PickingMode.Ignore; generateVisualContent += Paint; style.position = Position.Absolute; style.left = style.top = style.right = style.bottom = 0; }

            int paintedHash = int.MinValue;

            /// <summary>
            /// Repaint only when what is drawn changed (positions to a quarter pixel, health, colours): a still camera
            /// over idle units costs no tessellation. Returns true when a repaint was requested.
            /// </summary>
            public bool RepaintIfChanged()
            {
                int h = Bars.Count * 7 + Lines.Count * 131 + Rings.Count * 1031 + Arrows.Count * 8191;
                foreach (var (p, hp, team, selected, width) in Bars)
                    h = Mix(Mix(Mix(Mix(h, p.x), p.y), hp * 100f), width) * 31 + (selected ? 1 : 0) + team.GetHashCode();
                foreach (var (a, b, color) in Lines) h = Mix(Mix(Mix(Mix(h, a.x), a.y), b.x), b.y) * 31 + color.GetHashCode();
                foreach (var (p, color, radius) in Rings) h = Mix(Mix(Mix(h, p.x), p.y), radius) * 31 + color.GetHashCode();
                foreach (var (p, angle, alpha) in Arrows) h = Mix(Mix(Mix(Mix(h, p.x), p.y), angle * 100f), alpha * 100f);
                if (HasBox) h = Mix(Mix(Mix(Mix(h * 7 + 1, Box.xMin), Box.yMin), Box.xMax), Box.yMax);
                if (h == paintedHash) return false;
                paintedHash = h;
                MarkDirtyRepaint();
                return true;
            }

            static int Mix(int h, float v) => unchecked(h * 31 + (int)Mathf.Round(v * 4f));

            static readonly (int sx, int sy)[] Corners = { (1, 1), (-1, 1), (1, -1), (-1, -1) };

            static readonly Color BoxFill = new Color(.55f, .82f, 1f, .14f), BoxEdge = new Color(.70f, .90f, 1f, .95f);

            void Paint(MeshGenerationContext ctx)
            {
                var p2 = ctx.painter2D;
                if (HasBox)
                {
                    // the drag-selection box: a translucent fill with a bright border
                    p2.fillColor = BoxFill;
                    p2.BeginPath();
                    p2.MoveTo(new Vector2(Box.xMin, Box.yMin)); p2.LineTo(new Vector2(Box.xMax, Box.yMin));
                    p2.LineTo(new Vector2(Box.xMax, Box.yMax)); p2.LineTo(new Vector2(Box.xMin, Box.yMax)); p2.ClosePath();
                    p2.Fill();
                    p2.strokeColor = BoxEdge; p2.lineWidth = 1.5f; p2.lineJoin = LineJoin.Miter;
                    p2.Stroke();
                }
                p2.lineWidth = 1.6f;
                foreach (var (a, b, color) in Lines)
                {
                    // dotted: dashes every 9 px
                    float len = Vector2.Distance(a, b);
                    var dir = len > 0 ? (b - a) / len : Vector2.zero;
                    p2.strokeColor = color;
                    p2.BeginPath();
                    for (float d = 0; d < len; d += 9)
                    {
                        p2.MoveTo(a + dir * d);
                        p2.LineTo(a + dir * Mathf.Min(len, d + 5));
                    }
                    p2.Stroke();
                }
                foreach (var (p, color, radius) in Rings)
                {
                    p2.strokeColor = color; p2.lineWidth = 2f;
                    p2.BeginPath(); p2.Arc(p, radius, 0, 360); p2.Stroke();
                }
                foreach (var (p, hp, team, selected, width) in Bars)
                {
                    float w = width, h = 4f, x = p.x - w * .5f, y = p.y;
                    p2.fillColor = new Color(0, 0, 0, .62f);
                    p2.BeginPath(); p2.MoveTo(new Vector2(x - 1, y - 1)); p2.LineTo(new Vector2(x + w + 1, y - 1)); p2.LineTo(new Vector2(x + w + 1, y + h + 1)); p2.LineTo(new Vector2(x - 1, y + h + 1)); p2.ClosePath(); p2.Fill();
                    var fill = hp > .6f ? new Color(.45f, .86f, .42f) : hp > .3f ? new Color(.95f, .78f, .28f) : new Color(.94f, .32f, .26f);
                    p2.fillColor = fill;
                    float fw = w * Mathf.Clamp01(hp);
                    p2.BeginPath(); p2.MoveTo(new Vector2(x, y)); p2.LineTo(new Vector2(x + fw, y)); p2.LineTo(new Vector2(x + fw, y + h)); p2.LineTo(new Vector2(x, y + h)); p2.ClosePath(); p2.Fill();
                    // owner stripe under the bar
                    p2.strokeColor = team; p2.lineWidth = 1.2f;
                    p2.BeginPath(); p2.MoveTo(new Vector2(x, y + h + 2)); p2.LineTo(new Vector2(x + w, y + h + 2)); p2.Stroke();
                    if (selected)
                    {
                        p2.strokeColor = new Color(.95f, .95f, .85f, .95f); p2.lineWidth = 1.4f;
                        float bx = p.x - w * .5f - 4, by = y + 9, bw = w + 8, bh = w * .9f;
                        for (int k = 0; k < Corners.Length; k++)
                        {
                            var (sx, sy) = Corners[k];
                            float cx = sx > 0 ? bx : bx + bw, cy = sy > 0 ? by : by + bh;
                            p2.BeginPath(); p2.MoveTo(new Vector2(cx, cy + sy * 5)); p2.LineTo(new Vector2(cx, cy)); p2.LineTo(new Vector2(cx + sx * 5, cy)); p2.Stroke();
                        }
                    }
                }
                foreach (var (p, angle, alpha) in Arrows)
                {
                    var d = new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)); var n = new Vector2(-d.y, d.x);
                    p2.fillColor = new Color(.96f, .30f, .24f, alpha);
                    p2.BeginPath(); p2.MoveTo(p + d * 14); p2.LineTo(p - d * 6 + n * 9); p2.LineTo(p - d * 6 - n * 9); p2.ClosePath(); p2.Fill();
                }
            }
        }

        OverlayCanvas battleOverlay;
        struct OrderMark { public Vector3 Dest; public float Time; public string Kind; }
        static readonly Dictionary<int, OrderMark> orderMarks = new Dictionary<int, OrderMark>();
        readonly Dictionary<int, (Vector3 at, float time, bool building)> underFire = new Dictionary<int, (Vector3, float, bool)>();
        readonly List<int> overlayScratch = new List<int>();

        /// <summary>Remember where units were just sent (map point), for the order lines (shown for 1.5 s after the order).
        /// The ground marker comes from <see cref="Session.Commander.OrderIssued"/> (one per order), not from here.</summary>
        public static void NoteOrder(IEnumerable<int> ids, Vector3 mapPoint, string kind, float time)
        {
            // stamped on Time.unscaledTime (callers pass different clocks; the bootstrap clock lags after hitches)
            float stamp = Time.unscaledTime;
            foreach (int id in ids) orderMarks[id] = new OrderMark { Dest = mapPoint, Time = stamp, Kind = kind };
        }

        /// <summary>One of our units or buildings was hit at a map point.</summary>
        public void NoteUnderFire(int id, Vector3 mapPoint, bool building, float time) => underFire[id] = (mapPoint, time, building);

        /// <summary>
        /// Per frame. toScreen: world (map x, height, map z) to screen pixels (z &lt;= 0 behind the camera).
        /// unitAt: a unit's map position with ground height, or null.
        /// </summary>
        public void DrawBattleOverlay(Func<Vector3, Vector3> toScreen, Func<int, Vector3?> unitAt, float time, float zoom)
        {
            if (!session.ActionRts || MenuVisible || topbar.style.display == DisplayStyle.None)
            {
                if (battleOverlay != null) battleOverlay.style.display = DisplayStyle.None;
                // both only live for seconds; pruned below only while the overlay draws (memory pass 8)
                if (orderMarks.Count > 0) orderMarks.Clear();
                if (underFire.Count > 0) underFire.Clear();
                HideHoverCard();
                return;
            }
            if (battleOverlay == null) { battleOverlay = new OverlayCanvas(); root.Insert(0, battleOverlay); }
            battleOverlay.style.display = DisplayStyle.Flex;
            battleOverlay.Bars.Clear(); battleOverlay.Lines.Clear(); battleOverlay.Rings.Clear(); battleOverlay.Arrows.Clear();
            // the drag-selection box (screen pixels, y up → panel space)
            battleOverlay.HasBox = commander.Dragging(out var drag);
            if (battleOverlay.HasBox)
            {
                var a0 = ToPanel(new Vector3(drag.xMin, drag.yMin, 1)); var a1 = ToPanel(new Vector3(drag.xMax, drag.yMax, 1));
                battleOverlay.Box = Rect.MinMaxRect(Mathf.Min(a0.x, a1.x), Mathf.Min(a0.y, a1.y), Mathf.Max(a0.x, a1.x), Mathf.Max(a0.y, a1.y));
            }
            var store = session.Units;
            bool close = zoom < 45f;
            float barWidth = Mathf.Clamp(46f - zoom * .55f, 18f, 40f);
            int bars = 0;
            // health bars
            for (int s = 0; s < store.SlotCount && bars < 260; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse || (u.Flags & InsideFlag) != 0) continue;   // W4: garrisoned squads are hidden inside their structure
                bool selected = units.Selected.Contains(u.Id);
                bool hurt = u.Hp < 100, contact = u.Target > 0, fired = underFire.ContainsKey(u.Id);
                if (!selected && !(close && (hurt || contact)) && !fired) continue;
                var at = unitAt(u.Id);
                if (at == null) continue;
                var sp = toScreen(at.Value + new Vector3(0, .28f, 0));
                if (sp.z <= 0 || sp.x < 0 || sp.y < 0 || sp.x > Screen.width || sp.y > Screen.height) continue;
                var c = session.CivColor(u.Owner);
                battleOverlay.Bars.Add((ToPanel(sp), u.Hp / 100f, new Color(c.x, c.y, c.z).gamma, selected, barWidth));
                bars++;
            }
            // order lines for the current selection
            overlayScratch.Clear();
            foreach (var pair in orderMarks)
            {
                var mark = pair.Value;
                // a line shows who was sent where for 1.5 s after the order, then fades (no destination ring: the one
                // ground marker per order is drawn by the commander)
                float lineAge = Time.unscaledTime - mark.Time;
                var at = unitAt(pair.Key);
                if (at == null || lineAge > 1.5f || lineAge < -1f) { overlayScratch.Add(pair.Key); continue; }
                var here = at.Value; var dest = mark.Dest; dest.y = here.y;
                if (new Vector2(here.x - dest.x, here.z - dest.z).sqrMagnitude < .09f) { overlayScratch.Add(pair.Key); continue; }
                if (!units.Selected.Contains(pair.Key)) continue;
                var a = toScreen(here + new Vector3(0, .05f, 0)); var b = toScreen(mark.Dest + new Vector3(0, .05f, 0));
                if (a.z <= 0 || b.z <= 0) continue;
                float fade = .85f * Mathf.Clamp01((1.5f - lineAge) / .6f);
                var color = mark.Kind == "attack" ? new Color(.95f, .35f, .28f, fade) : mark.Kind == "capture" ? new Color(.95f, .78f, .32f, fade)
                    : mark.Kind == "collect" ? new Color(.45f, .85f, .95f, fade) : new Color(.55f, .92f, .55f, fade);
                battleOverlay.Lines.Add((ToPanel(a), ToPanel(b), color));
            }
            foreach (int id in overlayScratch) orderMarks.Remove(id);
            // under attack: rings on screen, arrows at the edges for attacks out of view
            overlayScratch.Clear();
            var centre = new Vector2(Screen.width * .5f, Screen.height * .5f);
            foreach (var pair in underFire)
            {
                float age = time - pair.Value.time;
                if (age > 3.5f) { overlayScratch.Add(pair.Key); continue; }
                var at = pair.Value.building ? pair.Value.at : unitAt(pair.Key) ?? pair.Value.at;
                var sp = toScreen(at + new Vector3(0, .1f, 0));
                float pulse = .5f + .5f * Mathf.Sin(time * 9f);
                bool onScreen = sp.z > 0 && sp.x > 30 && sp.y > 60 && sp.x < Screen.width - 30 && sp.y < Screen.height - 60;
                if (onScreen) battleOverlay.Rings.Add((ToPanel(sp), new Color(.96f, .3f, .24f, (1 - age / 3.5f) * (.5f + .5f * pulse)), pair.Value.building ? 26f : 12f + pulse * 4f));
                else
                {
                    var dir = new Vector2(sp.x, sp.y) - centre;
                    if (sp.z <= 0) dir = -dir;
                    if (dir.sqrMagnitude < 1) continue;
                    dir.Normalize();
                    float k = Mathf.Min((Screen.width * .5f - 40) / Mathf.Max(.001f, Mathf.Abs(dir.x)), (Screen.height * .5f - 80) / Mathf.Max(.001f, Mathf.Abs(dir.y)));
                    var edge = centre + dir * k;
                    // panel space has y down; screen space from the camera has y up
                    var panel = ToPanel(new Vector3(edge.x, edge.y, 1));
                    var panelCentre = ToPanel(new Vector3(centre.x, centre.y, 1));
                    var pd = panel - panelCentre;
                    battleOverlay.Arrows.Add((panel, Mathf.Atan2(pd.y, pd.x), (1 - age / 3.5f) * (.6f + .4f * pulse)));
                }
            }
            foreach (int id in overlayScratch) underFire.Remove(id);
            battleOverlay.RepaintIfChanged();
            UpdateHoverCard(toScreen, unitAt, time);   // Hud.HoverCard.cs
        }
    }
}
