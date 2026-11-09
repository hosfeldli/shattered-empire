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
        public Color Tint { get => tint; set { tint = value; MarkDirtyRepaint(); } }

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
                    // an armoured exoskeleton: broad shoulders, visor, heavy limbs
                    Box(c, 0.4f, 0.17f, 0.58f, 0.3f); Box(glow, 0.43f, 0.21f, 0.55f, 0.24f);
                    Poly(c, 0.3f, 0.32f, 0.68f, 0.32f, 0.63f, 0.6f, 0.35f, 0.6f);
                    Box(c, 0.36f, 0.6f, 0.46f, 0.9f); Box(c, 0.52f, 0.6f, 0.62f, 0.9f);
                    Box(c, 0.66f, 0.36f, 0.86f, 0.44f);
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
                    Poly(c, 0.02f, 0.5f, 0.82f, 0.44f, 0.98f, 0.5f, 0.82f, 0.56f);
                    Poly(c, 0.38f, 0.48f, 0.62f, 0.48f, 0.42f, 0.16f, 0.34f, 0.16f);
                    Poly(c, 0.38f, 0.52f, 0.62f, 0.52f, 0.42f, 0.84f, 0.34f, 0.84f);
                    Poly(c, 0.04f, 0.5f, 0.16f, 0.48f, 0.12f, 0.3f, 0.06f, 0.3f);
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
                default: Circle(c, 0.5f, 0.5f, 0.3f); break;
            }
        }

        /// <summary>The icon kind for a building type (by its role).</summary>
        public static string BuildingKind(string type)
        {
            switch (type)
            {
                case "house": case "town": case "market": case "academy": case "university": return "house";
                case "farm": case "lumber": return "farm";
                case "barracks": case "fort": case "airfield": case "heavy_assembly": case "motor_works": case "drone_works": case "robotics_complex": case "missile_silo": return "military";
                case "bunker": case "guard_post": case "aa_battery": case "shield_generator": return "defense";
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
