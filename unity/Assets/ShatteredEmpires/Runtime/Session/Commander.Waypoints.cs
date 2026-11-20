using System.Collections.Generic;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// 2026-11-19 (user: "the shift click unit AI pathfinding visual isn't clear as it doesn't connect the paths
    /// visually"): the whole chain of a selected unit's orders. The server sends only the current leg's planned route
    /// (snapshot <c>wp</c>, the first 18 points of <c>u.path</c>), and keeps Shift-queued orders (<c>u.orders</c>, at most
    /// 8 more) to itself, so the client remembers every order it gives per unit: a plain order replaces the unit's
    /// chain, a Shift order appends to it (the server's own rule, actionOrders.assign).
    /// <list type="bullet">
    /// <item>Current leg: the planned route from the unit, drawn solid in its order's colour.</item>
    /// <item>Later legs: dashed straight connectors from waypoint to waypoint (their routes are planned only when
    /// they start).</item>
    /// <item>Each waypoint: a ring in the order's colour and its number (1 = the leg being driven), laid flat on
    /// the ground facing the camera; units sharing a chain share one set of connectors and markers.</item>
    /// <item>Colours: move green, attack move and attack red, capture blue, collect amber, garrison pale blue.</item>
    /// <item>Completion: a waypoint is done when the unit reaches it, when the server's route already ends at a later
    /// waypoint, or when the unit has had no route and no target for 2.5 s (stopped, held, or the rest was refused);
    /// done waypoints and their connectors shrink away over 0.6 s.</item>
    /// </list>
    /// </summary>
    public sealed partial class Commander
    {
        struct Leg { public float X, Z, DoneAt; public byte Kind; }

        const byte LegMove = 0, LegAttack = 1, LegCapture = 2, LegCollect = 3, LegGarrison = 4, LegNone = 255;
        const int MaxLegs = 9;              // the current order and the server's 8 queued
        const float LegFade = .6f, LegIdleClear = 2.5f;

        readonly Dictionary<int, List<Leg>> legs = new Dictionary<int, List<Leg>>();
        readonly Dictionary<int, float> legIdleSince = new Dictionary<int, float>();
        readonly List<int> legScratch = new List<int>();
        readonly HashSet<long> legDrawn = new HashSet<long>();

        static byte LegKindOf(string kind) => kind switch
        {
            "move" => LegMove,
            "attackMove" => LegAttack, "attack" => LegAttack,
            "capture" => LegCapture,
            "collect" => LegCollect,
            "garrison" => LegGarrison,
            _ => LegNone,
        };

        static float4 LegColor(byte kind) => kind switch
        {
            LegAttack => new float4(1f, .32f, .24f, .75f),
            LegCapture => new float4(.42f, .70f, 1f, .75f),
            LegCollect => new float4(.98f, .72f, .27f, .75f),
            LegGarrison => new float4(.68f, .82f, 1f, .7f),
            _ => new float4(.38f, .95f, .55f, .7f),
        };

        /// <summary>From NoteIssued: every order given to the selection, with Shift appending (action ruleset only).</summary>
        void TrackOrderLegs(string kind, Vector3 point)
        {
            if (!session.ActionRts) return;
            byte k = LegKindOf(kind);
            if (k == LegNone || units.Selected.Count == 0) return;
            bool queue = InputFacade.Shift;
            foreach (int id in units.Selected)
            {
                if (!legs.TryGetValue(id, out var list)) legs[id] = list = new List<Leg>(4);
                if (!queue) list.Clear();
                else list.RemoveAll(l => l.DoneAt > 0);
                if (list.Count < MaxLegs) list.Add(new Leg { X = point.x, Z = point.z, Kind = k });
                legIdleSince.Remove(id);
            }
        }

        /// <summary>Per frame (DrawActionOverlay, select mode): updates completion and draws the selected units' chains.</summary>
        void DrawOrderRoutes()
        {
            var w = session.World;
            var g = w.Grid;
            float now = Time.unscaledTime;
            UpdateLegs(now);
            float width = Mathf.Max(.014f, cam.Distance * .0011f);
            var camT = Camera.main != null ? Camera.main.transform : null;
            // the screen's up and right on the ground, in map space (map z is Unity -z)
            float2 up = camT != null ? math.normalizesafe(new float2(camT.forward.x, -camT.forward.z), new float2(0, 1)) : new float2(0, 1);
            float2 right = camT != null ? math.normalizesafe(new float2(camT.right.x, -camT.right.z), new float2(1, 0)) : new float2(1, 0);
            legDrawn.Clear();
            int drawnPaths = 0;
            foreach (int id in units.Selected)
            {
                if (!units.TryGetPosition(session.Units, id, out var at)) continue;
                legs.TryGetValue(id, out var list);
                int head = -1;
                if (list != null) for (int i = 0; i < list.Count; i++) if (list[i].DoneAt <= 0) { head = i; break; }
                var headColor = head >= 0 ? LegColor(list[head].Kind) : LegColor(LegMove);
                // the current leg: the server's planned route (at most 16 units' routes, as before)
                float2 from = new float2(at.x, at.y);
                if (drawnPaths < 16 && session.Units.WorldPaths.TryGetValue(id, out var path) && path.Length > 0)
                {
                    drawnPaths++;
                    var c = headColor * .8f; c.w = headColor.w;
                    for (int j = 0; j < Mathf.Min(18, path.Length); j++)
                    {
                        var b = new float2(path[j].X, path[j].Z);
                        RouteSegment(from, b, c, width, 0f);
                        from = b;
                    }
                }
                if (list == null || list.Count == 0) continue;
                // the chain: (route end or unit) → each remaining waypoint, dashed; completed ones shrink away
                bool first = true;
                for (int i = 0; i < list.Count; i++)
                {
                    var leg = list[i];
                    float fade = leg.DoneAt > 0 ? 1f - Mathf.Clamp01((now - leg.DoneAt) / LegFade) : 1f;
                    if (fade <= 0f) continue;
                    var to = new float2(leg.X, leg.Z);
                    var col = LegColor(leg.Kind);
                    if (leg.DoneAt > 0) { WaypointMarker(to, 0, col, fade, true, up, right); continue; }   // reached: its ring shrinks away
                    // the route already leads to the head waypoint: connect only if it stops short (still planning)
                    float gap = math.length(new float2(g.DxWrap(from.x, to.x), to.y - from.y));
                    long key = SegmentKey(from, to);
                    if (gap > .3f && (first || legDrawn.Add(key))) RouteSegment(from, to, col, width * .85f * fade, .26f);
                    first = false;
                    if (legDrawn.Add(SegmentKey(to, to))) WaypointMarker(to, i - Mathf.Max(0, head) + 1, col, fade, leg.DoneAt > 0, up, right);
                    from = to;
                }
            }
        }

        void UpdateLegs(float now)
        {
            if (legs.Count == 0) return;
            var store = session.Units;
            var g = session.World.Grid;
            legScratch.Clear();
            foreach (var kv in legs)
            {
                int id = kv.Key; var list = kv.Value;
                // completed waypoints that have faded are dropped from the front
                while (list.Count > 0 && list[0].DoneAt > 0 && now - list[0].DoneAt > LegFade) list.RemoveAt(0);
                if (list.Count == 0 || !store.TryGet(id, out var u)) { legScratch.Add(id); continue; }
                if (!units.TryGetPosition(store, id, out var at)) continue;
                int head = -1;
                for (int i = 0; i < list.Count; i++) if (list[i].DoneAt <= 0) { head = i; break; }
                if (head < 0) continue;
                bool routed = store.WorldPaths.TryGetValue(id, out var path) && path.Length > 0;
                // reached the head waypoint (attacks and pickups end beside their target)
                var h = list[head];
                float reach = h.Kind == LegMove ? .45f : 1.1f;
                float dx = g.DxWrap(at.x, h.X), dz = h.Z - at.y;
                if (dx * dx + dz * dz < reach * reach) { Done(list, head, head, now); continue; }
                // the server's route already ends at a later waypoint: everything before it is done
                if (routed)
                {
                    // (group orders spread the units round each point, so "ends at" is: nearer that waypoint than the
                    // head one, and within 2.5)
                    var end = path[path.Length - 1];
                    float hx = g.DxWrap(end.X, h.X), hz = h.Z - end.Z, toHead = hx * hx + hz * hz;
                    int best = -1; float bestD = Mathf.Min(toHead, 6.25f);
                    for (int j = head + 1; j < list.Count; j++)
                    {
                        float ex = g.DxWrap(end.X, list[j].X), ez = list[j].Z - end.Z, d = ex * ex + ez * ez;
                        if (d < bestD) { bestD = d; best = j; }
                    }
                    if (best > head) Done(list, head, best - 1, now);
                    legIdleSince.Remove(id);
                    continue;
                }
                // no route and nothing targeted for a while: stopped, held, or the rest of the chain was refused
                if (u.Target > 0) { legIdleSince.Remove(id); continue; }
                if (!legIdleSince.TryGetValue(id, out float since)) legIdleSince[id] = now;
                else if (now - since > LegIdleClear) { Done(list, head, list.Count - 1, now); legIdleSince.Remove(id); }
            }
            foreach (int id in legScratch) { legs.Remove(id); legIdleSince.Remove(id); }
        }

        static void Done(List<Leg> list, int from, int to, float now)
        {
            for (int i = from; i <= to && i < list.Count; i++)
            {
                var l = list[i];
                if (l.DoneAt <= 0) { l.DoneAt = now; list[i] = l; }
            }
        }

        static long SegmentKey(float2 a, float2 b) =>
            ((long)Mathf.RoundToInt(a.x * 20) & 0xFFFF) | (((long)Mathf.RoundToInt(a.y * 20) & 0xFFFF) << 16)
            | (((long)Mathf.RoundToInt(b.x * 20) & 0xFFFF) << 32) | (((long)Mathf.RoundToInt(b.y * 20) & 0xFFFF) << 48);

        /// <summary>A ground-hugging line from a to b (map x, z), solid (dash 0) or dashed with the given dash length.</summary>
        void RouteSegment(float2 a, float2 b, float4 color, float width, float dash)
        {
            if (width < .002f) return;
            var w = session.World;
            float dx = w.Grid.DxWrap(a.x, b.x), dz = b.y - a.y;
            float length = math.length(new float2(dx, dz));
            if (length < .02f) return;
            float yaw = MapSpace.Yaw(Mathf.Atan2(dx, dz));
            if (dash <= 0f)
            {
                // solid: pieces of at most .5 so the line follows the ground over hills
                int steps = Mathf.Clamp(Mathf.CeilToInt(length / .5f), 1, 40);
                for (int k = 0; k < steps; k++) Piece(a, dx, dz, (float)k / steps, (k + 1f) / steps, length, yaw, color, width);
                return;
            }
            float period = dash * 1.65f;
            int count = Mathf.Clamp(Mathf.CeilToInt(length / period), 1, 120);
            for (int k = 0; k < count; k++)
            {
                float t0 = k * period / length, t1 = Mathf.Min(1f, (k * period + dash) / length);
                if (t0 >= 1f) break;
                Piece(a, dx, dz, t0, t1, length, yaw, color, width);
            }
        }

        void Piece(float2 a, float dx, float dz, float t0, float t1, float length, float yaw, float4 color, float width)
        {
            var w = session.World;
            float tm = (t0 + t1) * .5f;
            float mx = a.x + dx * tm, mz = a.y + dz * tm;
            float h = Mathf.Max(w.GroundHeight(mx, mz), Mathf.Max(w.GroundHeight(a.x + dx * t0, a.y + dz * t0), w.GroundHeight(a.x + dx * t1, a.y + dz * t1)));
            routeLines.Add(InstanceData.TRS(MapSpace.W(new float3(mx, h + .06f, mz)), yaw, new float3(width, .018f, (t1 - t0) * length), color));
        }

        /// <summary>A waypoint ring with its number beside it (seven-segment strokes, readable from any zoom).</summary>
        void WaypointMarker(float2 p, int number, float4 color, float fade, bool done, float2 up, float2 right)
        {
            var w = session.World;
            float zoom = Mathf.Clamp(cam.Distance * .011f, .14f, 1.2f);
            float size = Mathf.Max(.3f, zoom * 1.6f) * (done ? fade : 1f);
            if (size < .02f) return;
            float y = w.GroundHeight(p.x, p.y) + .04f;
            rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.x, y, p.y)), 0, new float3(size), color));
            if (done || number < 1 || number > 9) return;
            float hgt = zoom * .9f, wid = hgt * .55f, stroke = Mathf.Max(.012f, hgt * .13f);
            var centre = p + right * (size * .5f + wid * .9f);
            var ink = new float4(math.saturate(color.xyz * 1.15f + .1f), .95f);
            int mask = SegmentMask(number);
            // corners of the digit (top left, top right, middle left, middle right, bottom left, bottom right)
            float2 tl = centre - right * wid * .5f + up * hgt * .5f, tr = centre + right * wid * .5f + up * hgt * .5f;
            float2 ml = centre - right * wid * .5f, mr = centre + right * wid * .5f;
            float2 bl = centre - right * wid * .5f - up * hgt * .5f, br = centre + right * wid * .5f - up * hgt * .5f;
            if ((mask & 1) != 0) Stroke(tl, tr, ink, stroke);   // a: top
            if ((mask & 2) != 0) Stroke(tr, mr, ink, stroke);   // b: top right
            if ((mask & 4) != 0) Stroke(mr, br, ink, stroke);   // c: bottom right
            if ((mask & 8) != 0) Stroke(bl, br, ink, stroke);   // d: bottom
            if ((mask & 16) != 0) Stroke(ml, bl, ink, stroke);  // e: bottom left
            if ((mask & 32) != 0) Stroke(tl, ml, ink, stroke);  // f: top left
            if ((mask & 64) != 0) Stroke(ml, mr, ink, stroke);  // g: middle
        }

        void Stroke(float2 a, float2 b, float4 color, float width)
        {
            var w = session.World;
            float dx = b.x - a.x, dz = b.y - a.y, length = math.length(new float2(dx, dz)) + width;
            float mx = (a.x + b.x) * .5f, mz = (a.y + b.y) * .5f;
            float h = Mathf.Max(w.GroundHeight(mx, mz), Mathf.Max(w.GroundHeight(a.x, a.y), w.GroundHeight(b.x, b.y)));
            routeLines.Add(InstanceData.TRS(MapSpace.W(new float3(mx, h + .065f, mz)), MapSpace.Yaw(Mathf.Atan2(dx, dz)), new float3(width, .02f, length), color));
        }

        static int SegmentMask(int n) => n switch
        {
            0 => 0b0111111, 1 => 0b0000110, 2 => 0b1011011, 3 => 0b1001111, 4 => 0b1100110,
            5 => 0b1101101, 6 => 0b1111101, 7 => 0b0000111, 8 => 0b1111111, _ => 0b1101111,
        };
    }
}
