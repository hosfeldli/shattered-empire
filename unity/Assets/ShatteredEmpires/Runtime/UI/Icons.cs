using System;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Vector icons for units, buildings and resources, drawn with UI Toolkit's Painter2D so they stay
    /// crisp at any interface scale. Units are side silhouettes with the details that identify them at
    /// a glance (turrets, barrels, rotors, wheels vs tracks, kit carried).
    /// </summary>
    public sealed class IconElement : VisualElement
    {
        string kind = "";
        Color tint = new Color(0.93f, 0.89f, 0.8f);

        public IconElement(string kind = "", string cls = "icon")
        {
            this.kind = kind;
            AddToClassList(cls);
            pickingMode = PickingMode.Ignore;
            generateVisualContent += Paint;
        }

        public string Kind { get => kind; set { if (kind != value) { kind = value; MarkDirtyRepaint(); } } }
        /// <summary>Repaints only when the colour actually changes (callers set it every frame).</summary>
        public Color Tint { get => tint; set { if (tint != value) { tint = value; MarkDirtyRepaint(); } } }

        void Paint(MeshGenerationContext ctx)
        {
            var r = contentRect;
            if (r.width < 2 || r.height < 2) return;
            var p = ctx.painter2D;
            Icons.Draw(p, kind, r, tint);
        }
    }

    public static class Icons
    {
        static Painter2D P;
        static Rect R;
        static Vector2 V(float x, float y) => new Vector2(R.x + x * R.width, R.y + y * R.height);
        static float S(float v) => v * Mathf.Min(R.width, R.height);

        static void Poly(Color c, params float[] xy)
        {
            P.fillColor = c;
            P.BeginPath();
            P.MoveTo(V(xy[0], xy[1]));
            for (int i = 2; i < xy.Length; i += 2) P.LineTo(V(xy[i], xy[i + 1]));
            P.ClosePath();
            P.Fill();
        }

        static void Box(Color c, float x0, float y0, float x1, float y1) => Poly(c, x0, y0, x1, y0, x1, y1, x0, y1);

        static void Circle(Color c, float x, float y, float rad)
        {
            P.fillColor = c;
            P.BeginPath();
            P.Arc(V(x, y), S(rad), 0f, 360f);
            P.Fill();
        }

        static void Line(Color c, float w, params float[] xy)
        {
            P.strokeColor = c;
            P.lineWidth = S(w);
            P.lineCap = LineCap.Round;
            P.lineJoin = LineJoin.Round;
            P.BeginPath();
            P.MoveTo(V(xy[0], xy[1]));
            for (int i = 2; i < xy.Length; i += 2) P.LineTo(V(xy[i], xy[i + 1]));
            P.Stroke();
        }

        static void Soldier(Color c, float x, float s, bool rifle = true, bool helmet = true)
        {
            Circle(c, x, 0.3f, 0.07f * s);
            if (helmet) Poly(c, x - 0.09f * s, 0.27f, x + 0.09f * s, 0.27f, x + 0.06f * s, 0.2f, x - 0.06f * s, 0.2f);
            Poly(c, x - 0.07f * s, 0.38f, x + 0.07f * s, 0.38f, x + 0.06f * s, 0.62f, x - 0.06f * s, 0.62f);
            Line(c, 0.035f * s, x - 0.03f * s, 0.62f, x - 0.06f * s, 0.88f);
            Line(c, 0.035f * s, x + 0.03f * s, 0.62f, x + 0.07f * s, 0.88f);
            if (rifle) Line(c, 0.025f * s, x - 0.05f * s, 0.5f, x + 0.2f * s, 0.4f);
        }

        /// <summary>A stroked circle.</summary>
        static void Ring(Color c, float w, float x, float y, float rad)
        {
            P.strokeColor = c;
            P.lineWidth = S(w);
            P.BeginPath();
            P.Arc(V(x, y), S(rad), 0f, 360f);
            P.ClosePath();
            P.Stroke();
        }

        /// <summary>A stroked arc; angles in degrees, 0 = right, increasing clockwise (y down).</summary>
        static void ArcLine(Color c, float w, float x, float y, float rad, float a0, float a1)
        {
            P.strokeColor = c;
            P.lineWidth = S(w);
            P.lineCap = LineCap.Butt;
            P.BeginPath();
            P.Arc(V(x, y), S(rad), a0, a1);
            P.Stroke();
        }

        /// <summary>A filled arc segment (the chord closes it): 180→360 is the upper half disc.</summary>
        static void ArcFill(Color c, float x, float y, float rad, float a0, float a1)
        {
            P.fillColor = c;
            P.BeginPath();
            P.Arc(V(x, y), S(rad), a0, a1);
            P.ClosePath();
            P.Fill();
        }

        /// <summary>A filled pie wedge from the centre.</summary>
        static void Wedge(Color c, float x, float y, float rad, float a0, float a1)
        {
            P.fillColor = c;
            P.BeginPath();
            P.MoveTo(V(x, y));
            P.Arc(V(x, y), S(rad), a0, a1);
            P.ClosePath();
            P.Fill();
        }

        /// <summary>Points transformed about (.5,.5): scaled, rotated (degrees, clockwise) and moved.</summary>
        static float[] Xf(float scale, float degrees, float dx, float dy, params float[] xy)
        {
            float a = degrees * Mathf.Deg2Rad, cs = Mathf.Cos(a), sn = Mathf.Sin(a);
            var o = new float[xy.Length];
            for (int i = 0; i + 1 < xy.Length; i += 2)
            {
                float x = (xy[i] - 0.5f) * scale, y = (xy[i + 1] - 0.5f) * scale;
                o[i] = 0.5f + x * cs - y * sn + dx;
                o[i + 1] = 0.5f + x * sn + y * cs + dy;
            }
            return o;
        }

        /// <summary>A stroked ellipse (24 segments) centred at (x,y), radii rx/ry, rotated by degrees.</summary>
        static void Ellipse(Color c, float w, float x, float y, float rx, float ry, float degrees)
        {
            const int n = 24;
            var pts = new float[(n + 1) * 2];
            float a = degrees * Mathf.Deg2Rad, cs = Mathf.Cos(a), sn = Mathf.Sin(a);
            for (int i = 0; i <= n; i++)
            {
                float t = i * Mathf.PI * 2f / n, ex = Mathf.Cos(t) * rx, ey = Mathf.Sin(t) * ry;
                pts[i * 2] = x + ex * cs - ey * sn;
                pts[i * 2 + 1] = y + ex * sn + ey * cs;
            }
            Line(c, w, pts);
        }

        /// <summary>A regular polygon (filled), circumradius rad, first vertex at startDeg.</summary>
        static void Regular(Color c, float x, float y, float rad, int sides, float startDeg)
        {
            var pts = new float[sides * 2];
            for (int i = 0; i < sides; i++)
            {
                float a = (startDeg + i * 360f / sides) * Mathf.Deg2Rad;
                pts[i * 2] = x + Mathf.Cos(a) * rad;
                pts[i * 2 + 1] = y + Mathf.Sin(a) * rad;
            }
            Poly(c, pts);
        }

        /// <summary>A five-pointed star (filled).</summary>
        static void Star(Color c, float x, float y, float rad)
        {
            var pts = new float[20];
            for (int i = 0; i < 10; i++)
            {
                float a = (-90f + i * 36f) * Mathf.Deg2Rad, r = i % 2 == 0 ? rad : rad * 0.42f;
                pts[i * 2] = x + Mathf.Cos(a) * r;
                pts[i * 2 + 1] = y + Mathf.Sin(a) * r;
            }
            Poly(c, pts);
        }

        static void Almond(Color c) => Poly(c, 0.08f, 0.5f, 0.28f, 0.32f, 0.5f, 0.26f, 0.72f, 0.32f, 0.92f, 0.5f, 0.72f, 0.68f, 0.5f, 0.74f, 0.28f, 0.68f);

        static void Person(Color c, float dx, float dy, float s)
        {
            Circle(c, 0.38f * s + dx, 0.3f * s + dy, 0.14f * s);
            Poly(c, 0.12f * s + dx, 0.86f * s + dy, 0.18f * s + dx, 0.58f * s + dy, 0.58f * s + dx, 0.58f * s + dy, 0.64f * s + dx, 0.86f * s + dy);
        }

        static void Wheels(Color c, params float[] xs) { foreach (var x in xs) Circle(c, x, 0.78f, 0.09f); }
        static void Tracks(Color c, float x0, float x1)
        {
            Poly(c, x0, 0.66f, x1, 0.66f, x1 - 0.05f, 0.86f, x0 + 0.05f, 0.86f);
        }

        public static void Draw(Painter2D painter, string kind, Rect rect, Color c)
        {
            P = painter; R = rect;
            var dark = new Color(c.r * 0.45f, c.g * 0.45f, c.b * 0.45f, c.a);
            var glow = new Color(0.35f, 0.9f, 1f, 1f);
            switch (kind)
            {
                // ---------------------------------------------------- infantry
                case "militia": Soldier(c, 0.38f, 1f, true, false); Soldier(c, 0.64f, 0.9f, true, false); break;
                case "rifle_squad": Soldier(c, 0.25f, 0.9f); Soldier(c, 0.5f, 1f); Soldier(c, 0.75f, 0.9f); break;
                case "special_forces":
                    // a single operator: beret, scoped and suppressed carbine, knife
                    Circle(c, 0.45f, 0.3f, 0.075f);
                    Poly(c, 0.36f, 0.25f, 0.56f, 0.21f, 0.52f, 0.27f, 0.37f, 0.29f);
                    Poly(c, 0.37f, 0.38f, 0.53f, 0.38f, 0.52f, 0.63f, 0.38f, 0.63f);
                    Line(c, 0.035f, 0.42f, 0.63f, 0.38f, 0.9f); Line(c, 0.035f, 0.49f, 0.63f, 0.55f, 0.9f);
                    Line(c, 0.03f, 0.38f, 0.48f, 0.86f, 0.42f);
                    Box(c, 0.56f, 0.38f, 0.66f, 0.42f);
                    break;
                case "engineer":
                    // non-combat: hard hat, tool belt, a large wrench; no rifle
                    Circle(c, 0.42f, 0.32f, 0.07f);
                    Poly(c, 0.31f, 0.29f, 0.53f, 0.29f, 0.5f, 0.2f, 0.34f, 0.2f);
                    Box(c, 0.29f, 0.28f, 0.55f, 0.3f);
                    Poly(c, 0.35f, 0.39f, 0.49f, 0.39f, 0.48f, 0.63f, 0.36f, 0.63f);
                    Box(dark, 0.35f, 0.54f, 0.49f, 0.58f);
                    Line(c, 0.035f, 0.39f, 0.63f, 0.36f, 0.9f); Line(c, 0.035f, 0.45f, 0.63f, 0.5f, 0.9f);
                    Line(c, 0.05f, 0.5f, 0.45f, 0.78f, 0.26f);
                    Circle(c, 0.8f, 0.23f, 0.06f); Circle(dark, 0.83f, 0.2f, 0.03f);
                    break;
                case "exo_infantry":
                    // infantry fighting vehicle (2026-11-18): a tall tracked hull, a small turret with a long autocannon and a missile box
                    Tracks(c, 0.08f, 0.9f); Poly(c, 0.08f, 0.38f, 0.8f, 0.38f, 0.92f, 0.5f, 0.9f, 0.66f, 0.08f, 0.66f);
                    Box(c, 0.36f, 0.27f, 0.6f, 0.38f); Line(c, 0.03f, 0.6f, 0.31f, 0.94f, 0.29f);
                    Box(c, 0.3f, 0.19f, 0.5f, 0.26f); Box(glow, 0.47f, 0.2f, 0.5f, 0.25f);
                    break;
                case "colonist":
                    Soldier(c, 0.3f, 0.9f, false, false);
                    Box(c, 0.45f, 0.45f, 0.88f, 0.7f); Wheels(c, 0.53f, 0.8f);
                    Poly(c, 0.45f, 0.45f, 0.88f, 0.45f, 0.8f, 0.28f, 0.53f, 0.28f);
                    break;
                case "mortar_team":
                    Soldier(c, 0.3f, 0.9f, false);
                    Line(c, 0.06f, 0.58f, 0.86f, 0.8f, 0.3f); Line(c, 0.03f, 0.68f, 0.6f, 0.6f, 0.88f); Line(c, 0.03f, 0.68f, 0.6f, 0.78f, 0.88f);
                    Box(c, 0.5f, 0.86f, 0.7f, 0.9f);
                    break;
                // ---------------------------------------------------- guns
                case "field_gun":
                    // a direct-fire anti-tank gun: gun shield, long level barrel, split trail, two wheels
                    Poly(c, 0.4f, 0.32f, 0.56f, 0.3f, 0.58f, 0.62f, 0.4f, 0.62f);
                    Line(c, 0.05f, 0.5f, 0.45f, 0.96f, 0.43f);
                    Box(c, 0.93f, 0.4f, 0.97f, 0.47f);
                    Line(c, 0.05f, 0.45f, 0.62f, 0.08f, 0.86f);
                    Circle(c, 0.5f, 0.72f, 0.13f); Circle(dark, 0.5f, 0.72f, 0.05f);
                    break;
                case "sp_artillery":
                    Tracks(c, 0.1f, 0.88f); Box(c, 0.12f, 0.5f, 0.86f, 0.66f);
                    Poly(c, 0.3f, 0.5f, 0.66f, 0.5f, 0.62f, 0.32f, 0.34f, 0.32f);
                    Line(c, 0.05f, 0.6f, 0.38f, 0.95f, 0.14f);
                    break;
                case "missile_battery":
                    Wheels(c, 0.22f, 0.45f, 0.75f); Box(c, 0.1f, 0.55f, 0.9f, 0.7f); Box(c, 0.1f, 0.4f, 0.28f, 0.55f);
                    Poly(c, 0.35f, 0.55f, 0.88f, 0.24f, 0.93f, 0.32f, 0.42f, 0.58f);
                    break;
                case "air_defense":
                    Wheels(c, 0.25f, 0.72f); Box(c, 0.1f, 0.55f, 0.9f, 0.7f); Box(c, 0.38f, 0.42f, 0.62f, 0.55f);
                    Line(c, 0.035f, 0.47f, 0.45f, 0.72f, 0.1f); Line(c, 0.035f, 0.55f, 0.45f, 0.8f, 0.12f);
                    break;
                // ---------------------------------------------------- vehicles
                case "tank":
                    Tracks(c, 0.08f, 0.9f); Poly(c, 0.1f, 0.5f, 0.9f, 0.5f, 0.84f, 0.66f, 0.14f, 0.66f);
                    Poly(c, 0.3f, 0.5f, 0.64f, 0.5f, 0.6f, 0.34f, 0.34f, 0.34f);
                    Line(c, 0.05f, 0.62f, 0.42f, 0.98f, 0.42f);
                    Circle(dark, 0.42f, 0.32f, 0.03f);
                    break;
                case "autonomous_tank":
                    // unmanned: low faceted hull, no hatch, sensor mast, a glowing sensor strip
                    Tracks(c, 0.06f, 0.92f);
                    Poly(c, 0.06f, 0.54f, 0.94f, 0.54f, 0.98f, 0.62f, 0.9f, 0.68f, 0.1f, 0.68f);
                    Poly(c, 0.28f, 0.54f, 0.7f, 0.54f, 0.64f, 0.4f, 0.32f, 0.4f);
                    Line(c, 0.045f, 0.66f, 0.47f, 0.99f, 0.47f);
                    Line(c, 0.025f, 0.36f, 0.4f, 0.36f, 0.18f); Box(glow, 0.31f, 0.14f, 0.41f, 0.19f);
                    Box(glow, 0.2f, 0.58f, 0.8f, 0.6f);
                    break;
                case "mech_infantry":
                    Tracks(c, 0.08f, 0.9f); Poly(c, 0.1f, 0.42f, 0.78f, 0.42f, 0.9f, 0.56f, 0.88f, 0.66f, 0.1f, 0.66f);
                    Box(c, 0.4f, 0.32f, 0.56f, 0.42f); Line(c, 0.03f, 0.55f, 0.36f, 0.78f, 0.34f);
                    break;
                case "armored_car":
                    Wheels(c, 0.22f, 0.45f, 0.75f); Poly(c, 0.08f, 0.45f, 0.82f, 0.45f, 0.92f, 0.6f, 0.9f, 0.7f, 0.08f, 0.7f);
                    Box(c, 0.38f, 0.33f, 0.58f, 0.45f); Line(c, 0.035f, 0.56f, 0.38f, 0.82f, 0.38f);
                    break;
                case "scout_buggy":
                    Wheels(c, 0.25f, 0.75f); Poly(c, 0.12f, 0.55f, 0.9f, 0.55f, 0.84f, 0.68f, 0.16f, 0.68f);
                    Line(c, 0.03f, 0.3f, 0.55f, 0.42f, 0.3f, 0.7f, 0.3f, 0.78f, 0.55f); Line(c, 0.03f, 0.6f, 0.3f, 0.72f, 0.22f);
                    break;
                case "supply_truck":
                    Wheels(c, 0.22f, 0.5f, 0.78f); Box(c, 0.08f, 0.3f, 0.62f, 0.7f); Poly(c, 0.64f, 0.42f, 0.84f, 0.42f, 0.92f, 0.56f, 0.92f, 0.7f, 0.64f, 0.7f);
                    Box(dark, 0.72f, 0.46f, 0.84f, 0.54f);
                    break;
                // ---------------------------------------------------- aircraft
                case "helicopter":
                    Poly(c, 0.25f, 0.42f, 0.62f, 0.42f, 0.7f, 0.56f, 0.6f, 0.66f, 0.28f, 0.66f);
                    Line(c, 0.04f, 0.28f, 0.52f, 0.02f, 0.48f); Poly(c, 0.02f, 0.4f, 0.08f, 0.4f, 0.08f, 0.56f, 0.02f, 0.56f);
                    Line(c, 0.03f, 0.08f, 0.3f, 0.92f, 0.3f); Line(c, 0.03f, 0.45f, 0.3f, 0.45f, 0.42f);
                    Line(c, 0.03f, 0.3f, 0.74f, 0.66f, 0.74f);
                    break;
                case "fighter":
                    // the Warthog from above: long fuselage, straight wing, twin engine pods, tailplane with twin fins
                    Poly(c, 0.04f, 0.46f, 0.84f, 0.45f, 0.97f, 0.5f, 0.84f, 0.55f, 0.04f, 0.54f);
                    Poly(c, 0.52f, 0.47f, 0.64f, 0.47f, 0.62f, 0.05f, 0.54f, 0.05f);
                    Poly(c, 0.52f, 0.53f, 0.64f, 0.53f, 0.62f, 0.95f, 0.54f, 0.95f);
                    Circle(c, 0.3f, 0.37f, 0.055f); Circle(c, 0.3f, 0.63f, 0.055f);
                    Line(c, 0.11f, 0.24f, 0.37f, 0.36f, 0.37f); Line(c, 0.11f, 0.24f, 0.63f, 0.36f, 0.63f);
                    Poly(c, 0.06f, 0.24f, 0.14f, 0.24f, 0.14f, 0.76f, 0.06f, 0.76f);
                    Line(c, 0.03f, 0.04f, 0.24f, 0.17f, 0.24f); Line(c, 0.03f, 0.04f, 0.76f, 0.17f, 0.76f);
                    break;
                case "bomber":
                    Poly(c, 0.04f, 0.5f, 0.86f, 0.44f, 0.98f, 0.5f, 0.86f, 0.58f);
                    Poly(c, 0.3f, 0.48f, 0.6f, 0.48f, 0.5f, 0.06f, 0.4f, 0.06f);
                    Poly(c, 0.3f, 0.54f, 0.6f, 0.54f, 0.5f, 0.94f, 0.4f, 0.94f);
                    Circle(c, 0.44f, 0.24f, 0.05f); Circle(c, 0.44f, 0.76f, 0.05f);
                    break;
                case "recon_drone":
                    // a quadcopter seen from above: four rotors, a camera pod
                    Line(c, 0.04f, 0.22f, 0.22f, 0.78f, 0.78f); Line(c, 0.04f, 0.78f, 0.22f, 0.22f, 0.78f);
                    foreach (var (x, y) in new[] { (0.22f, 0.22f), (0.78f, 0.22f), (0.22f, 0.78f), (0.78f, 0.78f) }) { Circle(new Color(c.r, c.g, c.b, 0.35f), x, y, 0.15f); Circle(c, x, y, 0.04f); }
                    Box(c, 0.4f, 0.4f, 0.6f, 0.6f); Circle(glow, 0.5f, 0.5f, 0.05f);
                    break;
                case "oneway_drone":
                    // a delta-wing loitering munition with a pusher propeller
                    Poly(c, 0.92f, 0.5f, 0.2f, 0.12f, 0.3f, 0.5f, 0.2f, 0.88f);
                    Line(c, 0.03f, 0.12f, 0.36f, 0.12f, 0.64f);
                    break;
                case "strike_swarm":
                    foreach (var (x, y) in new[] { (0.25f, 0.3f), (0.7f, 0.25f), (0.45f, 0.62f), (0.82f, 0.7f), (0.2f, 0.78f) })
                        Poly(c, x + 0.12f, y, x - 0.08f, y - 0.1f, x - 0.04f, y, x - 0.08f, y + 0.1f);
                    break;
                // ---------------------------------------------------- buildings and tools
                case "house": Poly(c, 0.15f, 0.5f, 0.5f, 0.18f, 0.85f, 0.5f); Box(c, 0.22f, 0.5f, 0.78f, 0.88f); Box(dark, 0.44f, 0.62f, 0.56f, 0.88f); break;
                case "industry": Box(c, 0.1f, 0.5f, 0.9f, 0.88f); Poly(c, 0.1f, 0.5f, 0.3f, 0.32f, 0.3f, 0.5f, 0.5f, 0.32f, 0.5f, 0.5f, 0.7f, 0.32f, 0.7f, 0.5f); Box(c, 0.76f, 0.12f, 0.86f, 0.5f); break;
                case "farm": Poly(c, 0.1f, 0.88f, 0.5f, 0.55f, 0.9f, 0.88f); Line(c, 0.04f, 0.5f, 0.55f, 0.5f, 0.12f); Circle(c, 0.42f, 0.25f, 0.06f); Circle(c, 0.58f, 0.32f, 0.06f); Circle(c, 0.42f, 0.4f, 0.06f); break;
                case "military": Poly(c, 0.5f, 0.1f, 0.88f, 0.28f, 0.82f, 0.7f, 0.5f, 0.92f, 0.18f, 0.7f, 0.12f, 0.28f); Poly(dark, 0.5f, 0.3f, 0.6f, 0.5f, 0.5f, 0.7f, 0.4f, 0.5f); break;
                case "defense": Box(c, 0.15f, 0.45f, 0.85f, 0.85f); Box(c, 0.15f, 0.3f, 0.3f, 0.45f); Box(c, 0.42f, 0.3f, 0.58f, 0.45f); Box(c, 0.7f, 0.3f, 0.85f, 0.45f); break;
                case "road": Poly(c, 0.3f, 0.92f, 0.45f, 0.08f, 0.55f, 0.08f, 0.7f, 0.92f); Line(dark, 0.04f, 0.5f, 0.2f, 0.5f, 0.32f); Line(dark, 0.04f, 0.5f, 0.48f, 0.5f, 0.6f); Line(dark, 0.04f, 0.5f, 0.76f, 0.5f, 0.88f); break;
                case "trench": Line(c, 0.1f, 0.06f, 0.6f, 0.22f, 0.6f, 0.22f, 0.4f, 0.42f, 0.4f, 0.42f, 0.6f, 0.62f, 0.6f, 0.62f, 0.4f, 0.82f, 0.4f, 0.82f, 0.6f, 0.94f, 0.6f); break;
                case "research": Circle(c, 0.5f, 0.5f, 0.12f); P.strokeColor = c; P.lineWidth = S(0.05f); P.BeginPath(); P.Arc(V(0.5f, 0.5f), S(0.36f), 0, 360); P.Stroke(); Line(c, 0.05f, 0.5f, 0.06f, 0.5f, 0.2f); break;
                case "army": Poly(c, 0.12f, 0.2f, 0.88f, 0.2f, 0.88f, 0.55f, 0.5f, 0.88f, 0.12f, 0.55f); Poly(dark, 0.5f, 0.3f, 0.56f, 0.45f, 0.72f, 0.45f, 0.59f, 0.55f, 0.64f, 0.72f, 0.5f, 0.62f, 0.36f, 0.72f, 0.41f, 0.55f, 0.28f, 0.45f, 0.44f, 0.45f); break;
                case "build": Line(c, 0.08f, 0.2f, 0.82f, 0.62f, 0.4f); Box(c, 0.55f, 0.15f, 0.88f, 0.42f); break;
                case "overview": Box(c, 0.12f, 0.15f, 0.88f, 0.3f); Box(c, 0.12f, 0.42f, 0.88f, 0.57f); Box(c, 0.12f, 0.69f, 0.88f, 0.84f); break;
                case "settings": Circle(c, 0.5f, 0.5f, 0.3f); Circle(dark, 0.5f, 0.5f, 0.12f); for (int k = 0; k < 8; k++) { float a = k * Mathf.PI / 4; Line(c, 0.1f, 0.5f + Mathf.Cos(a) * 0.3f, 0.5f + Mathf.Sin(a) * 0.3f, 0.5f + Mathf.Cos(a) * 0.42f, 0.5f + Mathf.Sin(a) * 0.42f); } break;
                case "city": Box(c, 0.1f, 0.5f, 0.32f, 0.9f); Box(c, 0.36f, 0.18f, 0.62f, 0.9f); Box(c, 0.66f, 0.38f, 0.9f, 0.9f); break;
                default: DrawShell(kind, c, dark); break;
            }
        }

        /// <summary>Alias of <see cref="Draw"/> for painters (radial menu, minimap) that draw glyphs into a rect.</summary>
        public static void DrawAt(Painter2D p, string kind, Rect r, Color c) => Draw(p, kind, r, c);

        static readonly Color MaterialsColor = new Color(199 / 255f, 158 / 255f, 102 / 255f);
        static readonly Color EnergyColor = new Color(122 / 255f, 196 / 255f, 224 / 255f);
        static readonly Color CommandColor = new Color(150 / 255f, 196 / 255f, 146 / 255f);

        /// <summary>The interface glyphs of docs/UI_DESIGN_SPEC.md § D (resources, commands, buildings, menus).</summary>
        static void DrawShell(string kind, Color c, Color dark)
        {
            switch (kind)
            {
                // ---------------------------------------------------- resources
                case "materials":
                {
                    var m = new Color(MaterialsColor.r, MaterialsColor.g, MaterialsColor.b, c.a);
                    var md = new Color(m.r * 0.45f, m.g * 0.45f, m.b * 0.45f, c.a);
                    Box(m, 0.12f, 0.62f, 0.88f, 0.78f); Box(m, 0.18f, 0.44f, 0.82f, 0.60f); Box(m, 0.24f, 0.26f, 0.76f, 0.42f);
                    foreach (var (y0, y1) in new[] { (0.64f, 0.76f), (0.46f, 0.58f), (0.28f, 0.40f) })
                    {
                        Box(md, 0.28f, y0, 0.32f, y1);
                        Box(md, 0.68f, y0, 0.72f, y1);
                    }
                    break;
                }
                case "energy":
                    Poly(new Color(EnergyColor.r, EnergyColor.g, EnergyColor.b, c.a), 0.58f, 0.06f, 0.22f, 0.56f, 0.46f, 0.56f, 0.38f, 0.94f, 0.78f, 0.40f, 0.54f, 0.40f, 0.66f, 0.06f);
                    break;
                case "command":
                {
                    var k = new Color(CommandColor.r, CommandColor.g, CommandColor.b, c.a);
                    Line(k, 0.1f, 0.2f, 0.38f, 0.5f, 0.18f, 0.8f, 0.38f);
                    Line(k, 0.1f, 0.2f, 0.6f, 0.5f, 0.4f, 0.8f, 0.6f);
                    Line(k, 0.1f, 0.2f, 0.82f, 0.5f, 0.62f, 0.8f, 0.82f);
                    break;
                }
                case "queued": Poly(c, 0.25f, 0.15f, 0.75f, 0.15f, 0.5f, 0.5f); Poly(c, 0.5f, 0.5f, 0.75f, 0.85f, 0.25f, 0.85f); break;
                case "tier_pip": Box(c, 0.2f, 0.2f, 0.8f, 0.8f); break;
                case "pointer": Poly(c, 0.18f, 0.2f, 0.82f, 0.2f, 0.5f, 0.86f); break;   // tutorial pointer (down)
                // ---------------------------------------------------- shell controls
                case "pause": Box(c, 0.26f, 0.18f, 0.42f, 0.82f); Box(c, 0.58f, 0.18f, 0.74f, 0.82f); break;
                case "play": case "continue": Poly(c, 0.3f, 0.16f, 0.84f, 0.5f, 0.3f, 0.84f); break;
                case "menu": Box(c, 0.16f, 0.22f, 0.84f, 0.32f); Box(c, 0.16f, 0.45f, 0.84f, 0.55f); Box(c, 0.16f, 0.68f, 0.84f, 0.78f); break;
                case "close": Line(c, 0.1f, 0.24f, 0.24f, 0.76f, 0.76f); Line(c, 0.1f, 0.76f, 0.24f, 0.24f, 0.76f); break;
                case "back": Line(c, 0.1f, 0.78f, 0.5f, 0.24f, 0.5f); Line(c, 0.1f, 0.48f, 0.24f, 0.22f, 0.5f, 0.48f, 0.76f); break;
                case "more": Circle(c, 0.24f, 0.5f, 0.08f); Circle(c, 0.5f, 0.5f, 0.08f); Circle(c, 0.76f, 0.5f, 0.08f); break;
                case "plus": Line(c, 0.12f, 0.5f, 0.18f, 0.5f, 0.82f); Line(c, 0.12f, 0.18f, 0.5f, 0.82f, 0.5f); break;
                case "lock":
                    ArcLine(c, 0.09f, 0.5f, 0.46f, 0.2f, 180f, 360f);
                    Box(c, 0.22f, 0.46f, 0.78f, 0.88f);
                    Circle(dark, 0.5f, 0.64f, 0.06f);
                    break;
                case "check": Line(c, 0.12f, 0.18f, 0.52f, 0.42f, 0.76f, 0.84f, 0.26f); break;
                case "invite":
                    Person(c, 0f, 0f, 1f);
                    Line(c, 0.07f, 0.67f, 0.36f, 0.93f, 0.36f); Line(c, 0.07f, 0.8f, 0.23f, 0.8f, 0.49f);
                    break;
                case "friends": case "steam_overlay":
                    Person(new Color(c.r * 0.75f, c.g * 0.75f, c.b * 0.75f, c.a), 0.36f, 0.2f, 0.7f);
                    Person(c, 0f, 0f, 1f);
                    break;
                case "copy":
                    Line(c, 0.07f, 0.18f, 0.3f, 0.62f, 0.3f, 0.62f, 0.82f, 0.18f, 0.82f, 0.18f, 0.3f);
                    Line(c, 0.07f, 0.38f, 0.12f, 0.82f, 0.12f, 0.82f, 0.64f, 0.66f, 0.64f);
                    Line(c, 0.07f, 0.38f, 0.12f, 0.38f, 0.26f);
                    break;
                case "code":
                    Line(c, 0.08f, 0.38f, 0.14f, 0.3f, 0.86f); Line(c, 0.08f, 0.7f, 0.14f, 0.62f, 0.86f);
                    Line(c, 0.08f, 0.16f, 0.38f, 0.86f, 0.38f); Line(c, 0.08f, 0.14f, 0.64f, 0.84f, 0.64f);
                    break;
                case "skirmish":
                    Line(c, 0.08f, 0.18f, 0.82f, 0.82f, 0.18f); Line(c, 0.08f, 0.82f, 0.82f, 0.18f, 0.18f);
                    Line(c, 0.08f, 0.24f, 0.64f, 0.36f, 0.76f); Line(c, 0.08f, 0.64f, 0.76f, 0.76f, 0.64f);
                    break;
                case "multiplayer":
                    Ring(c, 0.07f, 0.5f, 0.5f, 0.36f);
                    Ellipse(c, 0.06f, 0.5f, 0.5f, 0.15f, 0.36f, 0f);
                    Line(c, 0.06f, 0.15f, 0.5f, 0.85f, 0.5f);
                    break;
                case "training": Ring(c, 0.07f, 0.5f, 0.5f, 0.36f); Ring(c, 0.07f, 0.5f, 0.5f, 0.2f); Circle(c, 0.5f, 0.5f, 0.07f); break;
                case "quit": ArcLine(c, 0.1f, 0.5f, 0.54f, 0.3f, -60f, 240f); Line(c, 0.1f, 0.5f, 0.14f, 0.5f, 0.5f); break;
                case "guide":
                    Poly(c, 0.1f, 0.24f, 0.48f, 0.3f, 0.48f, 0.84f, 0.1f, 0.78f);
                    Poly(c, 0.9f, 0.24f, 0.52f, 0.3f, 0.52f, 0.84f, 0.9f, 0.78f);
                    Line(dark, 0.03f, 0.5f, 0.3f, 0.5f, 0.84f);
                    break;
                // ---------------------------------------------------- base facilities (spec C3 mapping)
                case "hq": Box(c, 0.14f, 0.5f, 0.86f, 0.88f); Box(c, 0.38f, 0.18f, 0.62f, 0.5f); Star(dark, 0.5f, 0.32f, 0.1f); break;
                case "processor":
                    Box(c, 0.14f, 0.4f, 0.86f, 0.86f);
                    Box(c, 0.3f, 0.28f, 0.7f, 0.36f); Box(c, 0.34f, 0.18f, 0.66f, 0.26f);
                    Line(dark, 0.05f, 0.22f, 0.47f, 0.78f, 0.79f); Line(dark, 0.05f, 0.78f, 0.47f, 0.22f, 0.79f);
                    break;
                case "generator":
                    Poly(c, 0.2f, 0.88f, 0.3f, 0.2f, 0.7f, 0.2f, 0.8f, 0.88f);
                    Poly(dark, Xf(0.5f, 0f, 0f, 0.08f, 0.58f, 0.06f, 0.22f, 0.56f, 0.46f, 0.56f, 0.38f, 0.94f, 0.78f, 0.40f, 0.54f, 0.40f, 0.66f, 0.06f));
                    break;
                case "barracks": ArcFill(c, 0.5f, 0.58f, 0.34f, 180f, 360f); Box(c, 0.1f, 0.56f, 0.9f, 0.64f); break;
                case "vehicle_works":
                    for (int k = 0; k < 8; k++)
                    {
                        float a = k * Mathf.PI / 4f;
                        Line(c, 0.12f, 0.5f + Mathf.Cos(a) * 0.28f, 0.5f + Mathf.Sin(a) * 0.28f, 0.5f + Mathf.Cos(a) * 0.4f, 0.5f + Mathf.Sin(a) * 0.4f);
                    }
                    Circle(c, 0.5f, 0.5f, 0.3f); Circle(dark, 0.5f, 0.5f, 0.12f);
                    break;
                case "heavy_weapons": Poly(c, 0.4f, 0.88f, 0.4f, 0.38f, 0.5f, 0.12f, 0.6f, 0.38f, 0.6f, 0.88f); Box(dark, 0.4f, 0.66f, 0.6f, 0.72f); break;
                case "airfield":
                    Poly(c, Xf(0.8f, -90f, 0f, -0.06f, 0.02f, 0.5f, 0.82f, 0.44f, 0.98f, 0.5f, 0.82f, 0.56f));
                    Poly(c, Xf(0.8f, -90f, 0f, -0.06f, 0.38f, 0.48f, 0.62f, 0.48f, 0.42f, 0.16f, 0.34f, 0.16f));
                    Poly(c, Xf(0.8f, -90f, 0f, -0.06f, 0.38f, 0.52f, 0.62f, 0.52f, 0.42f, 0.84f, 0.34f, 0.84f));
                    Poly(c, Xf(0.8f, -90f, 0f, -0.06f, 0.04f, 0.5f, 0.16f, 0.48f, 0.12f, 0.3f, 0.06f, 0.3f));
                    Line(c, 0.06f, 0.1f, 0.9f, 0.9f, 0.9f);
                    break;
                case "lab":
                    Ellipse(c, 0.05f, 0.5f, 0.5f, 0.38f, 0.14f, 0f);
                    Ellipse(c, 0.05f, 0.5f, 0.5f, 0.38f, 0.14f, 60f);
                    Ellipse(c, 0.05f, 0.5f, 0.5f, 0.38f, 0.14f, 120f);
                    Circle(c, 0.5f, 0.5f, 0.07f);
                    break;
                case "silo": Poly(c, 0.5f, 0.06f, 0.62f, 0.24f, 0.62f, 0.72f, 0.74f, 0.88f, 0.26f, 0.88f, 0.38f, 0.72f, 0.38f, 0.24f); Circle(dark, 0.5f, 0.36f, 0.05f); break;
                // ---------------------------------------------------- field defenses
                case "sandbags":
                    foreach (var (x, y) in new[] { (0.2f, 0.72f), (0.44f, 0.72f), (0.68f, 0.72f), (0.32f, 0.5f), (0.56f, 0.5f) }) Circle(c, x, y, 0.13f);
                    Box(c, 0.07f, 0.72f, 0.81f, 0.85f); Box(c, 0.19f, 0.5f, 0.69f, 0.6f);
                    break;
                case "guard_post":
                    Line(c, 0.06f, 0.3f, 0.9f, 0.38f, 0.42f); Line(c, 0.06f, 0.7f, 0.9f, 0.62f, 0.42f);
                    Box(c, 0.28f, 0.22f, 0.72f, 0.42f); Poly(c, 0.22f, 0.22f, 0.5f, 0.08f, 0.78f, 0.22f);
                    break;
                case "bunker": ArcFill(c, 0.5f, 0.8f, 0.38f, 180f, 360f); Box(c, 0.08f, 0.8f, 0.92f, 0.88f); Box(dark, 0.32f, 0.6f, 0.68f, 0.66f); break;
                case "at_gun":
                    Poly(c, 0.3f, 0.34f, 0.48f, 0.3f, 0.5f, 0.7f, 0.3f, 0.7f);
                    Line(c, 0.07f, 0.42f, 0.48f, 0.94f, 0.42f);
                    Circle(c, 0.4f, 0.76f, 0.12f);
                    break;
                case "aa": Line(c, 0.07f, 0.4f, 0.62f, 0.6f, 0.12f); Line(c, 0.07f, 0.52f, 0.62f, 0.72f, 0.16f); Box(c, 0.2f, 0.62f, 0.8f, 0.86f); break;
                case "sensor":
                    ArcLine(c, 0.08f, 0.42f, 0.46f, 0.3f, 170f, 310f);
                    Line(c, 0.06f, 0.5f, 0.6f, 0.5f, 0.9f);
                    Line(c, 0.05f, 0.42f, 0.46f, 0.5f, 0.6f);
                    Circle(c, 0.62f, 0.3f, 0.05f);
                    break;
                case "repair":
                    Line(c, 0.12f, 0.24f, 0.78f, 0.62f, 0.4f);
                    Circle(c, 0.7f, 0.3f, 0.17f); Circle(dark, 0.7f, 0.3f, 0.08f);
                    Poly(dark, 0.72f, 0.28f, 0.84f, 0.08f, 0.94f, 0.18f);
                    break;
                case "artillery":
                    Poly(c, 0.4f, 0.32f, 0.56f, 0.3f, 0.58f, 0.62f, 0.4f, 0.62f);
                    Line(c, 0.06f, 0.5f, 0.48f, 0.92f, 0.12f);
                    Line(c, 0.05f, 0.45f, 0.62f, 0.08f, 0.86f);
                    Circle(c, 0.5f, 0.72f, 0.13f); Circle(dark, 0.5f, 0.72f, 0.05f);
                    break;
                case "fortress":
                    Box(c, 0.2f, 0.34f, 0.8f, 0.9f);
                    Box(c, 0.2f, 0.2f, 0.32f, 0.34f); Box(c, 0.44f, 0.2f, 0.56f, 0.34f); Box(c, 0.68f, 0.2f, 0.8f, 0.34f);
                    ArcFill(dark, 0.5f, 0.9f, 0.13f, 180f, 360f);
                    break;
                // ---------------------------------------------------- orders and abilities
                case "rally": Line(c, 0.06f, 0.3f, 0.1f, 0.3f, 0.9f); Poly(c, 0.3f, 0.12f, 0.8f, 0.26f, 0.3f, 0.42f); break;
                case "move": Line(c, 0.1f, 0.18f, 0.82f, 0.74f, 0.26f); Poly(c, 0.82f, 0.18f, 0.5f, 0.22f, 0.78f, 0.5f); break;
                case "attack_move":
                    Line(c, 0.1f, 0.3f, 0.7f, 0.74f, 0.26f); Poly(c, 0.82f, 0.18f, 0.5f, 0.22f, 0.78f, 0.5f);
                    Ring(c, 0.06f, 0.26f, 0.74f, 0.12f);
                    Line(c, 0.05f, 0.26f, 0.54f, 0.26f, 0.6f); Line(c, 0.05f, 0.26f, 0.88f, 0.26f, 0.94f);
                    Line(c, 0.05f, 0.06f, 0.74f, 0.12f, 0.74f); Line(c, 0.05f, 0.4f, 0.74f, 0.46f, 0.74f);
                    break;
                case "hold": Regular(c, 0.5f, 0.5f, 0.38f, 8, 22.5f); Box(dark, 0.28f, 0.46f, 0.72f, 0.54f); break;
                case "withdraw": Line(c, 0.1f, 0.6f, 0.2f, 0.3f, 0.5f, 0.6f, 0.8f); Line(c, 0.1f, 0.84f, 0.2f, 0.54f, 0.5f, 0.84f, 0.8f); break;
                case "fortify":
                    Poly(c, 0.36f, 0.5f, 0.64f, 0.5f, 0.64f, 0.74f, 0.5f, 0.9f, 0.36f, 0.74f);
                    Line(c, 0.07f, 0.5f, 0.1f, 0.5f, 0.5f);
                    Box(c, 0.4f, 0.08f, 0.6f, 0.14f);
                    break;
                case "detach":
                    Ring(c, 0.07f, 0.3f, 0.5f, 0.14f); Ring(c, 0.07f, 0.7f, 0.5f, 0.14f);
                    Line(c, 0.06f, 0.42f, 0.5f, 0.47f, 0.5f); Line(c, 0.06f, 0.53f, 0.5f, 0.58f, 0.5f);
                    break;
                case "upgrade": Line(c, 0.1f, 0.2f, 0.56f, 0.5f, 0.26f, 0.8f, 0.56f); Line(c, 0.1f, 0.2f, 0.84f, 0.5f, 0.54f, 0.8f, 0.84f); break;
                // 2026-11-20 (Ticket 3): the base tier upgrade, drawn as the era's tier pips (the wheel hub's) under the up-chevron
                case "era_up2": case "era_up3":
                {
                    int pips = kind == "era_up3" ? 3 : 2;
                    Line(c, 0.1f, 0.24f, 0.46f, 0.5f, 0.18f, 0.76f, 0.46f);
                    float w = 0.16f, gap = 0.06f, x0 = 0.5f - (pips * w + (pips - 1) * gap) * 0.5f;
                    for (int k = 0; k < pips; k++) Box(c, x0 + k * (w + gap), 0.62f, x0 + k * (w + gap) + w, 0.82f);
                    break;
                }
                case "demolish": Box(c, 0.2f, 0.16f, 0.62f, 0.36f); Line(c, 0.09f, 0.42f, 0.36f, 0.74f, 0.88f); break;
                // Build / Terrain wheels (workstream G, 2026-11-16)
                case "new_base":
                    Line(c, 0.07f, 0.5f, 0.08f, 0.86f, 0.29f, 0.86f, 0.71f, 0.5f, 0.92f, 0.14f, 0.71f, 0.14f, 0.29f, 0.5f, 0.08f);
                    Line(c, 0.1f, 0.5f, 0.32f, 0.5f, 0.68f); Line(c, 0.1f, 0.32f, 0.5f, 0.68f, 0.5f);
                    break;
                case "terrain":
                    Line(c, 0.07f, 0.5f, 0.08f, 0.86f, 0.29f, 0.86f, 0.71f, 0.5f, 0.92f, 0.14f, 0.71f, 0.14f, 0.29f, 0.5f, 0.08f);
                    Poly(c, 0.26f, 0.7f, 0.44f, 0.42f, 0.54f, 0.54f, 0.62f, 0.46f, 0.76f, 0.7f);
                    break;
                case "terrain_raise":
                    Poly(c, 0.08f, 0.9f, 0.5f, 0.5f, 0.92f, 0.9f);
                    Line(c, 0.09f, 0.5f, 0.42f, 0.5f, 0.1f); Line(c, 0.09f, 0.34f, 0.24f, 0.5f, 0.08f, 0.66f, 0.24f);
                    break;
                case "terrain_lower":
                    Poly(c, 0.08f, 0.62f, 0.3f, 0.62f, 0.5f, 0.84f, 0.7f, 0.62f, 0.92f, 0.62f, 0.92f, 0.92f, 0.08f, 0.92f);
                    Line(c, 0.09f, 0.5f, 0.08f, 0.5f, 0.46f); Line(c, 0.09f, 0.34f, 0.3f, 0.5f, 0.46f, 0.66f, 0.3f);
                    break;
                case "terrain_flatten":
                    Box(c, 0.08f, 0.66f, 0.92f, 0.92f);
                    Line(c, 0.09f, 0.12f, 0.5f, 0.88f, 0.5f);
                    Line(c, 0.07f, 0.3f, 0.12f, 0.3f, 0.38f); Line(c, 0.07f, 0.7f, 0.12f, 0.7f, 0.38f);
                    break;
                case "terrain_smooth":
                    Line(c, 0.09f, 0.08f, 0.52f, 0.3f, 0.36f, 0.5f, 0.52f, 0.7f, 0.36f, 0.92f, 0.52f);
                    Box(c, 0.08f, 0.68f, 0.92f, 0.9f);
                    break;
                case "cover": ArcFill(c, 0.5f, 0.7f, 0.3f, 180f, 360f); Box(c, 0.14f, 0.68f, 0.86f, 0.74f); Line(c, 0.05f, 0.08f, 0.88f, 0.92f, 0.88f); break;
                case "scan":
                    Ring(c, 0.06f, 0.5f, 0.5f, 0.36f);
                    Wedge(c, 0.5f, 0.5f, 0.36f, -50f, 0f);
                    Circle(c, 0.32f, 0.62f, 0.04f); Circle(c, 0.62f, 0.7f, 0.04f);
                    break;
                case "bombard":
                    Circle(c, 0.5f, 0.5f, 0.14f);
                    for (int k = 0; k < 8; k++)
                    {
                        float a = k * 45f * Mathf.Deg2Rad, b0 = a - 0.22f, b1 = a + 0.22f;
                        Poly(c, 0.5f + Mathf.Cos(a) * 0.44f, 0.5f + Mathf.Sin(a) * 0.44f,
                                0.5f + Mathf.Cos(b0) * 0.13f, 0.5f + Mathf.Sin(b0) * 0.13f,
                                0.5f + Mathf.Cos(b1) * 0.13f, 0.5f + Mathf.Sin(b1) * 0.13f);
                    }
                    break;
                case "focus_fire": case "target":
                    Ring(c, 0.07f, 0.5f, 0.5f, 0.3f);
                    Line(c, 0.07f, 0.5f, 0.06f, 0.5f, 0.32f); Line(c, 0.07f, 0.5f, 0.68f, 0.5f, 0.94f);
                    Line(c, 0.07f, 0.06f, 0.5f, 0.32f, 0.5f); Line(c, 0.07f, 0.68f, 0.5f, 0.94f, 0.5f);
                    break;
                case "intercept":
                    Line(c, 0.07f, 0.3f, 0.66f, 0.48f, 0.24f); Line(c, 0.07f, 0.42f, 0.66f, 0.6f, 0.28f); Box(c, 0.14f, 0.66f, 0.66f, 0.88f);
                    Poly(c, 0.94f, 0.18f, 0.66f, 0.12f, 0.72f, 0.18f, 0.66f, 0.24f);
                    break;
                case "patrol":
                {
                    ArcLine(c, 0.08f, 0.5f, 0.5f, 0.32f, 30f, 330f);
                    float a = 330f * Mathf.Deg2Rad, ex = 0.5f + Mathf.Cos(a) * 0.32f, ey = 0.5f + Mathf.Sin(a) * 0.32f;
                    float tx = -Mathf.Sin(a), ty = Mathf.Cos(a);
                    Poly(c, ex + tx * 0.12f, ey + ty * 0.12f, ex - ty * 0.1f, ey + tx * 0.1f, ex + ty * 0.1f, ey - tx * 0.1f);
                    break;
                }
                case "strike": Line(c, 0.1f, 0.5f, 0.1f, 0.5f, 0.6f); Poly(c, 0.3f, 0.5f, 0.5f, 0.8f, 0.7f, 0.5f); Line(c, 0.06f, 0.2f, 0.9f, 0.8f, 0.9f); break;
                case "infiltrate": Almond(c); Circle(dark, 0.5f, 0.5f, 0.11f); Line(c, 0.07f, 0.18f, 0.82f, 0.82f, 0.18f); break;
                case "observer": Almond(c); Circle(dark, 0.5f, 0.5f, 0.12f); Circle(c, 0.5f, 0.5f, 0.05f); break;
                case "missile_launch":
                    Poly(c, Xf(0.85f, 30f, 0f, 0f, 0.5f, 0.06f, 0.62f, 0.24f, 0.62f, 0.72f, 0.74f, 0.88f, 0.26f, 0.88f, 0.38f, 0.72f, 0.38f, 0.24f));
                    Poly(new Color(0.95f, 0.62f, 0.25f, c.a), Xf(0.85f, 30f, 0f, 0f, 0.38f, 0.88f, 0.62f, 0.88f, 0.5f, 1.0f));
                    break;
                case "wheel":
                    foreach (var a0 in new[] { -30f, 60f, 150f, 240f }) ArcLine(c, 0.1f, 0.5f, 0.5f, 0.34f, a0, a0 + 60f);
                    Circle(c, 0.5f, 0.5f, 0.08f);
                    break;
                default: Circle(c, 0.5f, 0.5f, 0.3f); break;
            }
        }

        /// <summary>The icon kind for a building type (by its role).</summary>
        public static string BuildingKind(string type)
        {
            switch (type)
            {
                // action-v2 facilities and field defenses: one glyph per type (spec C3)
                case "depot": return "processor";
                case "power_plant": return "generator";
                case "barracks": return "barracks";
                case "motor_works": return "vehicle_works";
                case "heavy_weapons": return "heavy_weapons";
                case "airfield": return "airfield";
                case "advanced_lab": return "lab";
                case "missile_silo": return "silo";
                case "town": return "hq";
                case "barricade": return "sandbags";
                case "guard_post": return "guard_post";
                case "bunker": return "bunker";
                case "turret": return "at_gun";
                case "aa_battery": return "aa";
                case "sensor_post": return "sensor";
                case "repair_point": return "repair";
                case "artillery_post": return "artillery";
                case "fort": return "fortress";
                case "city_turret": return "guard_post";
                // legacy types keep their role glyphs
                case "house": case "market": case "academy": case "university": return "house";
                case "farm": case "lumber": return "farm";
                case "heavy_assembly": case "drone_works": case "robotics_complex": return "military";
                case "shield_generator": return "defense";
                default: return "industry";
            }
        }

        public static Color ResourceColor(string good)
        {
            switch (good)
            {
                case "food": return new Color(0.55f, 0.82f, 0.36f);
                case "materials": return new Color(0.78f, 0.62f, 0.4f);
                case "ore": return new Color(0.6f, 0.52f, 0.5f);
                case "steel": return new Color(0.7f, 0.76f, 0.82f);
                case "fuel": return new Color(0.3f, 0.3f, 0.3f);
                case "electronics": return new Color(0.35f, 0.8f, 0.95f);
                case "munitions": return new Color(0.85f, 0.4f, 0.3f);
                case "credits": return new Color(0.95f, 0.8f, 0.3f);
                case "research": return new Color(0.6f, 0.6f, 0.95f);
                case "power": return new Color(1f, 0.9f, 0.35f);
                default: return new Color(0.8f, 0.8f, 0.8f);
            }
        }
    }
}
