using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Context cursors (overhaul §39, workstream C-D): one shared priority system for what a click would do here.
    /// <list type="bullet">
    /// <item>Tools first, decided every frame from the mode alone (cheap): placement modes build (crossed out where
    /// the footprint is refused), terrain tools and road / trench / bridge strokes edit terrain, an armed attack move
    /// attacks, a rally point moves (or attacks).</item>
    /// <item>With units selected, the hover target, in the order a right-click resolves it
    /// (<see cref="ActionContextOrder"/>): an enemy unit or building attacks, a pickup collects, a site we don't
    /// hold captures, an own damaged building with an engineer selected repairs, an own building with garrison
    /// slots takes the selected garrison-eligible squads (W4, 2026-11-18: the right-click sends <c>garrison</c>), ground the selection
    /// can't reach is crossed out, anything else moves.</item>
    /// <item>With nothing selected: the select cursor over anything clickable.</item>
    /// </list>
    /// The hover look-up is the O(units) part, so it runs at most 10 times a second and only when the mouse moved more
    /// than 2 px, the selection or the mode changed, or 0.3 s passed (the world under a still mouse moves too).
    /// Cursor textures are drawn in code once per kind and display scale (32 px at 1080p up to 128 px, anti-aliased, coloured core with a dark outline and a soft shadow so they read on any
    /// ground) and set only when the kind changes.
    /// </summary>
    public sealed partial class Commander
    {
        /// <summary>What a click at the cursor would do; drives the cursor image.</summary>
        public enum CursorContext { System, Select, Move, Attack, Collect, Capture, Build, Repair, Garrison, Terrain, Invalid, Count }

        /// <summary>The context under the cursor (last evaluated; the HUD may read it for hints).</summary>
        public CursorContext HoverContext { get; private set; }

        Vector2 hoverEvalMouse = new Vector2(-1e4f, -1e4f);
        float hoverEvalAt = -10f;
        int hoverEvalSignature;
        CursorContext hoverEvalResult;

        const float HoverInterval = .1f, HoverRefresh = .3f, HoverMovePixels = 2f;

        /// <summary>
        /// Called every frame from UpdateTargetCursor (Commander.Orders.cs) with its own result: whether the units are
        /// aiming an order and whether the target ground is impassable for them.
        /// </summary>
        void UpdateContextCursor(bool overUi, bool aiming, bool blocked)
        {
            var kind = ModeContext(overUi, aiming, blocked, out bool needsHover);
            if (needsHover) kind = HoverContextThrottled(blocked);
            HoverContext = kind;
            SetContextCursor(kind);
        }

        CursorContext ModeContext(bool overUi, bool aiming, bool blocked, out bool needsHover)
        {
            needsHover = false;
            if (overUi || cam.MouseRotating || session.Spectator) return CursorContext.System;
            switch (Current)
            {
                case Mode.Place:
                    if (!session.ActionRts) return hoverTile >= 0 && legalReady && !legal.Contains(hoverTile) ? CursorContext.Invalid : CursorContext.Build;
                    return PlacementParcel is BaseParcel parcel && !legal.Contains(parcel.Id) ? CursorContext.Invalid : CursorContext.Build;
                case Mode.Road: case Mode.Trench: case Mode.Bridge: return CursorContext.Terrain;
                case Mode.Growth: return CursorContext.Build;
                case Mode.Rally: return blocked ? CursorContext.Invalid : RallyAttackMoveArmed ? CursorContext.Attack : CursorContext.Move;
                case Mode.Target:
                {
                    if (TerrainBrushActive) return CursorContext.Terrain;
                    string c = ProtocolDecoder.Str(TargetCommand?["c"]);
                    if (c == "fieldBuild")
                        return FieldPreviewValid || FieldPreviewParcel == null || (FieldPreviewReason ?? "").StartsWith("Checking")
                            ? CursorContext.Build : CursorContext.Invalid;
                    if (c == "baseBuild" || c == "newBase") return CursorContext.Build;
                    if (c == "repair") return CursorContext.Repair;
                    if (c == "move") return blocked ? CursorContext.Invalid : AttackMoveArmed ? CursorContext.Attack : CursorContext.Move;
                    if (c != null && c.StartsWith("terrain")) return CursorContext.Terrain;
                    return CursorContext.Attack;   // targeted abilities (bombard, strike, missile…): pick a point
                }
            }
            // select mode
            if (dragging) return CursorContext.Select;   // a box selection in progress
            needsHover = true;
            return CursorContext.System;
        }

        CursorContext HoverContextThrottled(bool blocked)
        {
            float now = Time.unscaledTime;
            var mouse = InputFacade.MousePosition;
            int signature = units.Selected.Count * 31 + SelectedBuildings.Count * 7 + (int)Current + (blocked ? 1 << 20 : 0);
            bool changed = signature != hoverEvalSignature;
            bool moved = (mouse - hoverEvalMouse).sqrMagnitude > HoverMovePixels * HoverMovePixels;
            if (!changed && (now - hoverEvalAt < HoverInterval || (!moved && now - hoverEvalAt < HoverRefresh))) return hoverEvalResult;
            hoverEvalAt = now; hoverEvalMouse = mouse; hoverEvalSignature = signature;
            hoverEvalResult = EvaluateHover(mouse, blocked);
            return hoverEvalResult;
        }

        /// <summary>The hover target in <see cref="ActionContextOrder"/>'s priority (same reaches and helpers).</summary>
        CursorContext EvaluateHover(Vector2 mouse, bool blocked)
        {
            bool commanding = units.Selected.Count > 0;
            if (!session.ActionRts) return commanding ? (blocked ? CursorContext.Invalid : CursorContext.Move) : CursorContext.System;
            // one pass over the units: the nearest enemy within 19 px (ActionContextOrder's reach), any unit within 14 px
            bool enemy = false, anyNear = false;
            float best = 19f * 19f;
            var store = session.Units;
            for (int i = 0; i < store.SlotCount; i++)
            {
                ref var u = ref store.Records[i];
                if (!u.InUse) continue;
                bool hostile = session.IsHostile(u.Owner);
                if (commanding && !hostile) continue;
                if (!ScreenOf(i, out var pixel)) continue;
                float d = (pixel - mouse).sqrMagnitude;
                if (hostile && d < best) { enemy = true; if (commanding) break; }
                if (d < 14f * 14f) anyNear = true;
            }
            if (!commanding)
                return anyNear || enemy || SpatialBuildingAt(mouse) != null || PickupAt(mouse, out _) ? CursorContext.Select : CursorContext.System;
            if (enemy) return CursorContext.Attack;
            if (!cam.TryGround(mouse, out var point)) return CursorContext.System;
            int tile = session.World.Grid.TileAt(point.x, point.z);
            if (tile < 0) return CursorContext.Invalid;
            var building = SpatialBuildingAt(mouse);
            if (building is BuildingRecord hostileBuilding && !hostileBuilding.Memory && session.IsHostile(hostileBuilding.Owner)) return CursorContext.Attack;
            if (PickupAt(mouse, out var pickup) && !pickup.Memory) return CursorContext.Collect;
            if (SiteAt(mouse, point, tile, out var site) && site.Headquarters == 0 && site.Owner != session.CivId) return CursorContext.Capture;
            if (building is BuildingRecord own && own.Owner == session.CivId && !own.Memory)
            {
                SelectionMakeup(out bool engineers, out bool infantry);
                if (engineers && own.Done && (own.RepairCost > 0 || own.Hp < 100)) return CursorContext.Repair;
                if (infantry && GarrisonTarget(own)) return CursorContext.Garrison;
            }
            return blocked ? CursorContext.Invalid : CursorContext.Move;
        }

        /// <summary>
        /// Whether the selection holds engineers and garrison-eligible squads (O(selected), only on a hover evaluation).
        /// <paramref name="infantry"/> follows the server's actionGarrison.canGarrison, so mortar teams alone keep the move cursor.
        /// </summary>
        void SelectionMakeup(out bool engineers, out bool infantry)
        {
            engineers = infantry = false;
            var store = session.Units;
            foreach (int id in units.Selected)
            {
                if (!store.TryGet(id, out var u)) continue;
                string type = store.Types.Name(u.TypeIndex);
                if (type == "engineer") engineers = true;
                if (GarrisonEligible(u.TypeIndex)) infantry = true;
                if (engineers && infantry) return;
            }
        }

        // ------------------------------------------------------------------ garrison (W4, R4; CAPTURE_AND_GARRISON.md)
        /// <summary>Unit flag: the squad is inside a structure (server actionGame unitSnapshot, bit 16384).</summary>
        const int GarrisonedFlag = 16384;

        /// <summary>Server actionGarrison.canGarrison: capture-capable ground squads that are not the automatic engineers.</summary>
        bool GarrisonEligible(int typeIndex)
        {
            var d = UnitDef(typeIndex);
            return ProtocolDecoder.Bool(d?["capture"]) && !ProtocolDecoder.Bool(d?["auto"]) && !ProtocolDecoder.Bool(d?["air"]);
        }

        /// <summary>An own, finished, live structure with garrison places (defs BUILDINGS[type].garrison).</summary>
        bool GarrisonTarget(in BuildingRecord b) =>
            b.Owner == session.CivId && !b.Memory && b.Done && b.Hp > 0 && ProtocolDecoder.Int(session.Defs?["BUILDINGS"]?[b.Type ?? ""]?["garrison"]) > 0;

        /// <summary>Selected squads that may enter a structure, and the rest of the selection.</summary>
        void SplitGarrison(JArray eligible, JArray rest)
        {
            var store = session.Units;
            foreach (int id in units.Selected)
            {
                if (store.TryGet(id, out var u) && GarrisonEligible(u.TypeIndex)) eligible.Add(id);
                else rest.Add(id);
            }
        }

        // ------------------------------------------------------------------ cursor images
        // 2026-11-19 (user: "improve the resolution/quality of the contextual crosshairs"): the glyphs are signed
        // distance shapes designed on a 32-unit grid. Each is rendered once per kind and display scale at the
        // screen's own pixel size (32 px at 1080p, 43 at 1440p, 64 at 4K, scaled with the interface scale and high
        // DPI), anti-aliased analytically from the distance (no jaggies at any size), with a dark outline and a
        // soft drop shadow so it reads on snow, sand, grass and water alike. Hotspots scale with the image.
        static readonly Texture2D[] cursorImages = new Texture2D[(int)CursorContext.Count];
        static int cursorShown;
        static float cursorScale, cursorScaleWanted, cursorScaleAt;
        const float CursorPad = 2.5f;   // design units of margin round the 32-unit glyph grid

        /// <summary>Design units to screen pixels for the cursor (1 = the 32-px design at 1080p), in quarter steps.</summary>
        static float CursorScale()
        {
            float byHeight = Screen.height / 1080f;
            float byDpi = Screen.dpi > 0 ? Screen.dpi / 96f : 1f;
            float s = Mathf.Max(byHeight, byDpi) * Mathf.Clamp(SE.Runtime.App.GameSettings.UiScale, .75f, 1.6f);
            // Windows hardware cursors stay sharp up to 128 px (scale 4)
            return Mathf.Clamp(Mathf.Round(s * 4f) / 4f, 1f, 4f);
        }

        static void SetContextCursor(CursorContext kind)
        {
            // the scale is re-read once a second (resolution, DPI and interface scale rarely change)
            float now = Time.unscaledTime;
            if (now >= cursorScaleAt || cursorScale <= 0) { cursorScaleAt = now + 1f; cursorScaleWanted = CursorScale(); }
            float scale = cursorScaleWanted;
            if ((int)kind == cursorShown && scale == cursorScale) return;
            if (scale != cursorScale)
            {
                // resolution or interface scale changed: redraw every kind at the new size
                for (int i = 0; i < cursorImages.Length; i++) { if (cursorImages[i] != null) Object.Destroy(cursorImages[i]); cursorImages[i] = null; }
                cursorScale = scale;
            }
            cursorShown = (int)kind;
            if (kind == CursorContext.System) { Cursor.SetCursor(null, Vector2.zero, CursorMode.Auto); return; }
            var image = cursorImages[(int)kind] ??= MakeCursor(kind, scale);
            Cursor.SetCursor(image, (Hotspot(kind) + new Vector2(CursorPad, CursorPad)) * scale, CursorMode.Auto);
        }

        /// <summary>Earlier API: 0 the system cursor, 1 the red attack crosshair, 2 the crossed-out circle.</summary>
        static void SetOrderCursor(int kind) => SetContextCursor(kind == 1 ? CursorContext.Attack : kind == 2 ? CursorContext.Invalid : CursorContext.System);

        /// <summary>Back to the system cursor (leaving the match, disposing).</summary>
        public static void ResetOrderCursor() => SetContextCursor(CursorContext.System);

        /// <summary>The click point in design units (screen pixels at scale 1, from the top left).</summary>
        static Vector2 Hotspot(CursorContext kind) => kind switch
        {
            CursorContext.Select => new Vector2(3, 2),     // the arrow's tip
            CursorContext.Capture => new Vector2(9, 28),   // the foot of the flag pole
            _ => new Vector2(16, 16),
        };

        static Color32 InkOf(CursorContext kind) => kind switch
        {
            CursorContext.Select => new Color32(248, 246, 238, 255),
            CursorContext.Move => new Color32(98, 230, 128, 255),
            CursorContext.Attack => new Color32(250, 70, 52, 255),
            CursorContext.Invalid => new Color32(250, 70, 52, 255),
            CursorContext.Collect => new Color32(248, 186, 56, 255),
            CursorContext.Capture => new Color32(120, 186, 255, 255),
            CursorContext.Build => new Color32(80, 220, 214, 255),
            CursorContext.Repair => new Color32(255, 158, 60, 255),
            CursorContext.Garrison => new Color32(170, 206, 255, 255),
            CursorContext.Terrain => new Color32(228, 190, 120, 255),
            _ => new Color32(255, 255, 255, 255),
        };

        /// <summary>
        /// The kind's glyph at <paramref name="scale"/> screen pixels per design unit: its colour, a dark outline
        /// (1.5 design units) and a soft shadow offset down-right, composited with analytic anti-aliasing.
        /// </summary>
        static Texture2D MakeCursor(CursorContext kind, float scale)
        {
            // the 32-unit design plus a CursorPad margin on every side, so outlines and the shadow are never clipped
            int n = Mathf.Clamp(Mathf.CeilToInt((32 + 2 * CursorPad) * scale), 32, 160);
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp, name = "Cursor" + kind + "@" + scale };
            var px = new Color32[n * n];
            Color ink = InkOf(kind);
            // a slightly darker ink toward the bottom of the glyph gives it a little body at large sizes
            Color inkLow = ink * .82f; inkLow.a = 1;
            var rim = new Color(.06f, .045f, .04f);
            const float edge = 1.5f, shadowX = 1.1f, shadowY = 1.6f, shadowSoft = 2.2f;
            float aa = .5f / scale;   // half a screen pixel, in design units
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    // the pixel centre in design units (screen y down; texture rows run bottom-up)
                    float dxu = (x + .5f) / scale - .5f - CursorPad, dyu = (n - 1 - y + .5f) / scale - .5f - CursorPad;
                    float d = Shape(kind, dxu, dyu);
                    float inkA = Mathf.Clamp01((aa - d) / (2 * aa));
                    float rimA = Mathf.Clamp01((aa - (d - edge)) / (2 * aa));
                    float sd = Shape(kind, dxu - shadowX, dyu - shadowY) - edge;
                    float shadowA = .42f * (1f - Mathf.SmoothStep(0f, 1f, Mathf.Max(0f, sd) / shadowSoft));
                    // composite back to front: shadow, outline, ink (straight alpha)
                    var col = new Color(0, 0, 0, shadowA);
                    col = Over(new Color(rim.r, rim.g, rim.b, rimA * .94f), col);
                    var tint = Color.Lerp(ink, inkLow, Mathf.Clamp01(dyu / 32f));
                    col = Over(new Color(tint.r, tint.g, tint.b, inkA), col);
                    px[y * n + x] = col;
                }
            tex.SetPixels32(px);
            tex.Apply(false, false);
            return tex;
        }

        /// <summary>Straight-alpha "a over b".</summary>
        static Color Over(Color a, Color b)
        {
            float outA = a.a + b.a * (1 - a.a);
            if (outA <= 1e-5f) return new Color(0, 0, 0, 0);
            float k = b.a * (1 - a.a);
            return new Color((a.r * a.a + b.r * k) / outA, (a.g * a.a + b.g * k) / outA, (a.b * a.a + b.b * k) / outA, outA);
        }

        /// <summary>Signed distance (pixels, ≤ 0 inside) from a pixel to the kind's glyph.</summary>
        static float Shape(CursorContext kind, float x, float y)
        {
            const float c = 15.5f;
            float dx = x - c, dy = y - c, r = Mathf.Sqrt(dx * dx + dy * dy);
            switch (kind)
            {
                case CursorContext.Attack:
                {
                    // the red crosshair: a ring, four ticks and a centre point
                    float ring = Mathf.Abs(r - 8.5f);
                    // ticks as true segments, so their ends carry the outline too (they were cut off flat)
                    float ticks = Mathf.Min(Mathf.Min(Segment(dx, dy, 0, -14f, 0, -6f), Segment(dx, dy, 0, 6f, 0, 14f)),
                                            Mathf.Min(Segment(dx, dy, -14f, 0, -6f, 0), Segment(dx, dy, 6f, 0, 14f, 0)));
                    return Mathf.Min(Mathf.Min(ring, ticks), r) - 1.1f;
                }
                case CursorContext.Invalid:
                {
                    float ring = Mathf.Abs(r - 11.5f);
                    float slash = r < 12.5f ? Mathf.Abs(dx - dy) * .7071f : 99f;   // top-left to bottom-right (screen y down)
                    return Mathf.Min(ring, slash) - 1.9f;
                }
                case CursorContext.Select:
                    // an arrow pointer, tip at the top left
                    return Polygon(x, y, ArrowPoints);
                case CursorContext.Move:
                {
                    // a ring with four chevrons pointing in, and a centre dot: "go here"
                    float d = Mathf.Abs(r - 10.5f) - 1f;
                    d = Mathf.Min(d, r - 1.8f);
                    for (int k = 0; k < 4; k++)
                    {
                        // rotate the pixel into the top chevron's frame
                        float ax = k == 0 ? dx : k == 1 ? dy : k == 2 ? -dx : -dy;
                        float ay = k == 0 ? dy : k == 1 ? -dx : k == 2 ? -dy : dx;
                        d = Mathf.Min(d, Segment(ax, ay, -3.5f, -15f, 0f, -11.5f) - 1.1f);
                        d = Mathf.Min(d, Segment(ax, ay, 3.5f, -15f, 0f, -11.5f) - 1.1f);
                    }
                    return d;
                }
                case CursorContext.Collect:
                {
                    // a crate with an arrow dropping into it
                    float box = Mathf.Max(Mathf.Abs(dx), Mathf.Abs(dy - 5f)) - 8f;
                    float d = Mathf.Abs(box) - 1.1f;
                    d = Mathf.Min(d, Segment(x, y, 8f, 21f, 23f, 21f) - .8f);
                    d = Mathf.Min(d, Segment(x, y, c, 1f, c, 14f) - 1.2f);
                    d = Mathf.Min(d, Polygon(x, y, CollectArrowHead));
                    return d;
                }
                case CursorContext.Capture:
                {
                    // a flag on a pole
                    float d = Segment(x, y, 9f, 3f, 9f, 28f) - 1.2f;
                    return Mathf.Min(d, Polygon(x, y, FlagPoints));
                }
                case CursorContext.Build:
                {
                    // a hammer: the handle and the head across its end
                    float d = Segment(x, y, 7f, 26f, 19f, 14f) - 1.6f;
                    return Mathf.Min(d, Segment(x, y, 14f, 8f, 25f, 19f) - 3.2f);
                }
                case CursorContext.Repair:
                {
                    // a spanner: the shank and an open jaw (a ring with its upper right cut away)
                    float d = Segment(x, y, 7f, 25f, 17.5f, 14.5f) - 1.7f;
                    float jx = x - 21f, jy = y - 10.5f, jr = Mathf.Sqrt(jx * jx + jy * jy);
                    bool open = jx > 0 && jy < 0 && Mathf.Abs(jx + jy) < 3.6f;
                    if (!open) d = Mathf.Min(d, Mathf.Abs(jr - 4.6f) - 1.6f);
                    return d;
                }
                case CursorContext.Garrison:
                {
                    // a house: roof, walls and a door
                    float d = Segment(x, y, 5f, 15f, c, 5f) - 1.2f;
                    d = Mathf.Min(d, Segment(x, y, c, 5f, 26f, 15f) - 1.2f);
                    d = Mathf.Min(d, Segment(x, y, 9f, 14f, 9f, 26f) - 1.1f);
                    d = Mathf.Min(d, Segment(x, y, 22f, 14f, 22f, 26f) - 1.1f);
                    d = Mathf.Min(d, Segment(x, y, 9f, 26f, 22f, 26f) - 1.1f);
                    return Mathf.Min(d, Segment(x, y, c, 20f, c, 26f) - 1.8f);
                }
                case CursorContext.Terrain:
                {
                    // a ridge line over the ground line: the land being reshaped
                    float d = Segment(x, y, 3f, 22f, 11f, 11f) - 1.2f;
                    d = Mathf.Min(d, Segment(x, y, 11f, 11f, 17f, 18f) - 1.2f);
                    d = Mathf.Min(d, Segment(x, y, 17f, 18f, 21f, 13f) - 1.2f);
                    d = Mathf.Min(d, Segment(x, y, 21f, 13f, 29f, 22f) - 1.2f);
                    return Mathf.Min(d, Segment(x, y, 3f, 26f, 29f, 26f) - 1.1f);
                }
                default: return 99f;
            }
        }

        static readonly Vector2[] ArrowPoints =
        {
            new Vector2(3, 2), new Vector2(3, 23), new Vector2(8, 18.5f), new Vector2(12, 27), new Vector2(15.5f, 25.5f),
            new Vector2(11.5f, 17), new Vector2(18, 17),
        };
        static readonly Vector2[] FlagPoints = { new Vector2(10, 3), new Vector2(26, 8.5f), new Vector2(10, 15) };
        static readonly Vector2[] CollectArrowHead = { new Vector2(10.5f, 12), new Vector2(20.5f, 12), new Vector2(15.5f, 18) };

        static float Segment(float px, float py, float ax, float ay, float bx, float by)
        {
            float vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
            float t = Mathf.Clamp01((wx * vx + wy * vy) / Mathf.Max(1e-6f, vx * vx + vy * vy));
            float ex = wx - vx * t, ey = wy - vy * t;
            return Mathf.Sqrt(ex * ex + ey * ey);
        }

        /// <summary>Signed distance to a filled polygon (negative inside).</summary>
        static float Polygon(float x, float y, Vector2[] p)
        {
            float d = float.MaxValue; bool inside = false;
            for (int i = 0, j = p.Length - 1; i < p.Length; j = i++)
            {
                d = Mathf.Min(d, Segment(x, y, p[j].x, p[j].y, p[i].x, p[i].y));
                if ((p[i].y > y) != (p[j].y > y) && x < (p[j].x - p[i].x) * (y - p[i].y) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
            }
            return inside ? -d : d;
        }
    }
}
