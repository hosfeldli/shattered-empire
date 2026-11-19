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
    /// Cursor textures are drawn in code once per kind (32×32, coloured core with a dark outline so they read on any
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
        static readonly Texture2D[] cursorImages = new Texture2D[(int)CursorContext.Count];
        static int cursorShown;

        static void SetContextCursor(CursorContext kind)
        {
            if ((int)kind == cursorShown) return;
            cursorShown = (int)kind;
            if (kind == CursorContext.System) { Cursor.SetCursor(null, Vector2.zero, CursorMode.Auto); return; }
            var image = cursorImages[(int)kind] ??= MakeCursor(kind);
            Cursor.SetCursor(image, Hotspot(kind), CursorMode.Auto);
        }

        /// <summary>Earlier API: 0 the system cursor, 1 the red attack crosshair, 2 the crossed-out circle.</summary>
        static void SetOrderCursor(int kind) => SetContextCursor(kind == 1 ? CursorContext.Attack : kind == 2 ? CursorContext.Invalid : CursorContext.System);

        /// <summary>Back to the system cursor (leaving the match, disposing).</summary>
        public static void ResetOrderCursor() => SetContextCursor(CursorContext.System);

        static Vector2 Hotspot(CursorContext kind) => kind switch
        {
            CursorContext.Select => new Vector2(2, 2),     // the arrow's tip
            CursorContext.Capture => new Vector2(9, 28),   // the foot of the flag pole
            _ => new Vector2(16, 16),
        };

        static Color32 InkOf(CursorContext kind) => kind switch
        {
            CursorContext.Select => new Color32(246, 244, 236, 255),
            CursorContext.Move => new Color32(98, 226, 128, 255),
            CursorContext.Attack => new Color32(240, 72, 56, 255),
            CursorContext.Invalid => new Color32(240, 72, 56, 255),
            CursorContext.Collect => new Color32(244, 182, 56, 255),
            CursorContext.Capture => new Color32(120, 182, 255, 255),
            CursorContext.Build => new Color32(80, 214, 210, 255),
            CursorContext.Repair => new Color32(255, 154, 60, 255),
            CursorContext.Garrison => new Color32(170, 204, 255, 255),
            CursorContext.Terrain => new Color32(222, 184, 116, 255),
            _ => new Color32(255, 255, 255, 255),
        };

        /// <summary>A 32×32 cursor drawn in code: the kind's glyph in its colour with a dark outline.</summary>
        static Texture2D MakeCursor(CursorContext kind)
        {
            const int n = 32;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp, name = "Cursor" + kind };
            var px = new Color32[n * n];
            var ink = InkOf(kind);
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    // shapes are written in screen pixels (y down); texture rows run bottom-up
                    float d = Shape(kind, x, n - 1 - y);
                    const float edge = 1.4f;
                    Color32 col;
                    if (d <= 0f) col = ink;
                    else if (d <= edge) col = new Color32(20, 12, 10, (byte)(220 * Mathf.Clamp01(edge - d + .3f)));
                    else col = new Color32(0, 0, 0, 0);
                    px[y * n + x] = col;
                }
            tex.SetPixels32(px);
            tex.Apply(false, false);
            return tex;
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
                    float ticks = Mathf.Min(Mathf.Abs(dy) >= 5f && Mathf.Abs(dy) <= 14f ? Mathf.Abs(dx) : 99f,
                                            Mathf.Abs(dx) >= 5f && Mathf.Abs(dx) <= 14f ? Mathf.Abs(dy) : 99f);
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
