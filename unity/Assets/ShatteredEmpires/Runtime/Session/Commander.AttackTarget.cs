using System.Collections.Generic;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// 2026-11-20 (Ticket 2, user: "right-clicking an enemy should show a red indicator that you are attacking it";
    /// "the shift-click path preview doesn't connect its waypoints").
    /// <list type="bullet">
    /// <item>Attack target: a right-click on an enemy unit or building (<see cref="ActionContextOrder"/>'s attack)
    /// remembers the target per ordered unit. The target gets a red reticle (a ring with four inward ticks) that follows
    /// it, a bright ring that snaps in from twice its size on the click, and each selected attacker a thin red line
    /// to it. An order ends when the unit gets a plain (non-Shift) order, the target dies or leaves sight for good, or
    /// the unit has not been targeting it for 3 s after a 3 s grace.</item>
    /// <item>Shift preview: while Shift is held with units selected, a dashed connector in the colour of what a
    /// click would do runs from the end of each selected unit's order chain (its last queued waypoint, else its route
    /// end, else the unit) to the cursor, with a ghost waypoint ring numbered as the next leg, so the queue reads as
    /// one connected path before the click.</item>
    /// </list>
    /// </summary>
    public sealed partial class Commander
    {
        struct AttackOrder { public int Target; public float Since, MissingSince; }

        readonly Dictionary<int, AttackOrder> attackOrders = new Dictionary<int, AttackOrder>();
        readonly List<int> attackScratch = new List<int>();
        readonly HashSet<int> attackDrawn = new HashSet<int>();
        int attackPulseTarget;
        float attackPulseAt = -10f;
        const float AttackPulse = .7f, AttackGrace = 3f;
        static readonly float4 AttackRed = new float4(1f, .22f, .16f, 1f);

        /// <summary>From ActionContextOrder: the selection was ordered to attack <paramref name="target"/>.</summary>
        void NoteAttackOrder(int target)
        {
            if (!session.ActionRts || target <= 0) return;
            float now = Time.unscaledTime;
            foreach (int id in units.Selected) attackOrders[id] = new AttackOrder { Target = target, Since = now, MissingSince = -1f };
            attackPulseTarget = target; attackPulseAt = now;
        }

        /// <summary>From TrackOrderLegs: a plain order replaces this unit's attack.</summary>
        void ClearAttackOrder(int unit) => attackOrders.Remove(unit);

        /// <summary>Where the target is (map x, z) and how large its marker is; false when it can't be seen.</summary>
        bool AttackTargetAt(int target, out float2 at, out float radius)
        {
            at = default; radius = .55f;
            if (units.TryGetPosition(session.Units, target, out var xz)) { at = new float2(xz.x, xz.y); return true; }
            if (session.Structures != null && session.Structures.Buildings.TryGetValue(target, out var b) && !b.Memory)
            {
                var g = session.World.Grid;
                at = b.HasPosition ? new float2(b.X, b.Z) : new float2(g.CenterX(b.Tile), g.CenterZ(b.Tile));
                radius = 1.15f;
                return true;
            }
            return false;
        }

        /// <summary>Per frame (DrawActionOverlay): expire attack orders, then draw the reticles, lines and the click pulse.</summary>
        void DrawAttackTargets()
        {
            if (!session.ActionRts || !session.World.Ready) return;
            float now = Time.unscaledTime;
            var store = session.Units;
            attackScratch.Clear();
            foreach (var kv in attackOrders)
            {
                var o = kv.Value;
                bool unitAlive = store.TryGet(kv.Key, out var u);
                bool targetGone = !store.SlotOf.ContainsKey(o.Target) && !(session.Structures != null && session.Structures.Buildings.ContainsKey(o.Target));
                if (!unitAlive || targetGone) { attackScratch.Add(kv.Key); continue; }
                if (now - o.Since < AttackGrace || u.Target == o.Target) { if (o.MissingSince >= 0) { o.MissingSince = -1f; attackOrders[kv.Key] = o; } continue; }
                if (o.MissingSince < 0) { o.MissingSince = now; attackOrders[kv.Key] = o; }
                else if (now - o.MissingSince > AttackGrace) attackScratch.Add(kv.Key);
            }
            foreach (int id in attackScratch) attackOrders.Remove(id);

            var w = session.World;
            var g = w.Grid;
            float zoom = Mathf.Clamp(cam.Distance * .011f, .14f, 1.2f);
            float width = Mathf.Max(.03f, cam.Distance * .0022f);
            float beat = .5f + .5f * Mathf.Sin(now * 7f);
            attackDrawn.Clear();
            if (units.Selected.Count <= 64)
                foreach (int id in units.Selected)
                {
                    if (!attackOrders.TryGetValue(id, out var o) || !AttackTargetAt(o.Target, out var at, out float radius)) continue;
                    // a unit still on its way follows its red route and chain leg (Commander.Waypoints.cs) to the target;
                    // one in range (no attack leg left) gets a straight line
                    bool chained = false;
                    if (legs.TryGetValue(id, out var chain))
                        foreach (var leg in chain) if (leg.DoneAt <= 0) { chained = leg.Kind == LegAttack; break; }
                    if (!chained && units.TryGetPosition(store, id, out var from))
                    {
                        // the line stops at the reticle so it never crosses the target
                        float2 a = new float2(from.x, from.y);
                        float dx = g.DxWrap(a.x, at.x), dz = at.y - a.y, len = math.length(new float2(dx, dz));
                        float reticle = Mathf.Max(radius, zoom * .9f);
                        if (len > reticle + .2f)
                        {
                            float2 end = a + new float2(dx, dz) * ((len - reticle) / len);
                            RouteSegment(a, end, new float4(AttackRed.xyz, .55f), width * .9f, 0f);
                        }
                    }
                    if (attackDrawn.Add(o.Target)) Reticle(at, Mathf.Max(radius, zoom * .9f), new float4(AttackRed.xyz, .85f + .35f * beat), width);
                }
            // the click: a bright ring snapping in onto the target, shown whether or not the attackers stay selected
            float age = now - attackPulseAt;
            if (age >= 0f && age < AttackPulse && AttackTargetAt(attackPulseTarget, out var p, out float r))
            {
                float t = age / AttackPulse;
                float size = Mathf.Max(r, zoom * .9f) * 2f * Mathf.Lerp(2f, 1f, 1f - (1f - t) * (1f - t));
                float y = w.GroundHeight(p.x, p.y) + .05f;
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.x, y, p.y)), 0, new float3(size), new float4(AttackRed.xyz, 1.6f * (1f - t))));
                if (!attackDrawn.Contains(attackPulseTarget)) Reticle(p, Mathf.Max(r, zoom * .9f), new float4(AttackRed.xyz, 1.2f * (1f - t * .5f)), width);
            }
        }

        /// <summary>A red target reticle: a ground ring of the given radius and four ticks pointing in at it.</summary>
        void Reticle(float2 p, float radius, float4 color, float width)
        {
            var w = session.World;
            float y = w.GroundHeight(p.x, p.y) + .05f;
            rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.x, y, p.y)), 0, new float3(radius * 2f), color));
            float tick = radius * .45f;
            for (int k = 0; k < 4; k++)
            {
                float a = k * math.PI * .5f + math.PI * .25f;
                var dir = new float2(math.sin(a), math.cos(a));
                Stroke(p + dir * (radius + tick * .15f), p + dir * (radius + tick), color, width * 1.6f);
            }
        }

        /// <summary>
        /// Shift held with units selected: a dashed connector from each chain's end to the cursor and a ghost waypoint
        /// there (called from DrawActionOverlay with the order routes).
        /// </summary>
        void DrawQueuePreview()
        {
            if (!session.ActionRts || session.Spectator || !InputFacade.Shift || units.Selected.Count == 0 || units.Selected.Count > 64) return;
            if (dragging || lineDrag || hoverTile < 0 || cam.MouseRotating) return;
            if (Current != Mode.Select && !AttackMoveArmed) return;
            if (!cam.TryGround(InputFacade.MousePosition, out var ground)) return;
            byte kind = AttackMoveArmed ? LegAttack : HoverContext switch
            {
                CursorContext.Attack => LegAttack,
                CursorContext.Capture => LegCapture,
                CursorContext.Collect => LegCollect,
                CursorContext.Garrison => LegGarrison,
                CursorContext.Move => LegMove,
                CursorContext.Invalid => LegNone,
                _ => (byte)254,
            };
            if (kind == 254) return;
            var col = kind == LegNone ? new float4(.75f, .75f, .75f, .5f) : LegColor(kind);
            col.w *= .8f;
            var g = session.World.Grid;
            var to = new float2(ground.x, ground.z);
            float width = Mathf.Max(.03f, cam.Distance * .0022f);
            var camT = Camera.main != null ? Camera.main.transform : null;
            float2 up = camT != null ? math.normalizesafe(new float2(camT.forward.x, -camT.forward.z), new float2(0, 1)) : new float2(0, 1);
            float2 right = camT != null ? math.normalizesafe(new float2(camT.right.x, -camT.right.z), new float2(1, 0)) : new float2(1, 0);
            int number = 1;
            bool numbered = false;
            legDrawn.Clear();
            foreach (int id in units.Selected)
            {
                float2 from;
                int pending = 0;
                if (legs.TryGetValue(id, out var list))
                    for (int i = 0; i < list.Count; i++) if (list[i].DoneAt <= 0) pending++;
                if (pending > 0)
                {
                    var last = list[list.Count - 1];
                    from = new float2(last.X, last.Z);
                }
                else if (session.Units.WorldPaths.TryGetValue(id, out var path) && path.Length > 0)
                    from = new float2(path[path.Length - 1].X, path[path.Length - 1].Z);
                else if (units.TryGetPosition(session.Units, id, out var at)) from = new float2(at.x, at.y);
                else continue;
                if (!numbered) { number = pending + 1; numbered = true; }
                // units sharing a chain end share one connector
                if (!legDrawn.Add(SegmentKey(new float2(Mathf.Round(from.x * 2f) * .5f, Mathf.Round(from.y * 2f) * .5f), to))) continue;
                float gap = math.length(new float2(g.DxWrap(from.x, to.x), to.y - from.y));
                if (gap > .3f) RouteSegment(from, to, col, width * .85f, .3f);
            }
            WaypointMarker(to, kind == LegNone ? 0 : number, col, 1f, false, up, right);
        }
    }
}
