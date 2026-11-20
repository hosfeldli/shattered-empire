using System;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Order markers (workstream F, 2026-11-16): every order the player gives shows exactly one clean ring on
    /// the ground at its destination — green for a move, red for an attack move or an attack — that pops in,
    /// settles and fades out within 1.5 s. Markers are fed from <see cref="OrderIssued"/> (raised once per
    /// order; the HUD subscribes), never from per-unit state, so they cannot stick or multiply. Timed on
    /// Time.unscaledTime throughout: the old rings mixed that clock with the bootstrap clock and could stick. Also the HUD's helpers for the
    /// minimap console (idle units, camera jump).
    /// </summary>
    public sealed partial class Commander
    {
        struct OrderMarker { public Vector3 Point; public float Born; public bool Attack; }

        const int MaxMarkers = 12;
        const float MarkerLife = 1.5f;
        static readonly OrderMarker[] markers = new OrderMarker[MaxMarkers];
        static int markerNext;

        /// <summary>
        /// One marker for one order (map point). An order repeated at the same spot within a quarter second
        /// (several calls for the same click) replaces the earlier marker instead of stacking.
        /// </summary>
        public static void AddOrderMarker(string kind, Vector3 mapPoint)
        {
            float now = Time.unscaledTime;
            bool attack = IsAttackKind(kind);
            for (int i = 0; i < MaxMarkers; i++)
            {
                ref var m = ref markers[i];
                if (m.Born <= 0 || now - m.Born > .25f) continue;
                float dx = m.Point.x - mapPoint.x, dz = m.Point.z - mapPoint.z;
                if (dx * dx + dz * dz < .04f) { m.Point = mapPoint; m.Born = now; m.Attack = attack; return; }
            }
            markers[markerNext] = new OrderMarker { Point = mapPoint, Born = Mathf.Max(now, .001f), Attack = attack };
            markerNext = (markerNext + 1) % MaxMarkers;
        }

        static bool IsAttackKind(string kind) =>
            kind == "attack" || kind == "attackMove" || kind == "attack_move" || kind == "rallyAttackMove";

        /// <summary>Ground rings for the live markers (called from DrawOverlay, action ruleset).</summary>
        void DrawOrderMarkers()
        {
            var w = session.World;
            float now = Time.unscaledTime;
            for (int i = 0; i < MaxMarkers; i++)
            {
                ref var m = ref markers[i];
                if (m.Born <= 0) continue;
                float age = now - m.Born;
                if (age > MarkerLife || age < 0) { m.Born = 0; continue; }
                float t = age / MarkerLife;
                // pop in (0.12 s), hold, then shrink away over the last third: the instanced material is opaque
                // (alpha drives emission), so the size carries the fade
                float pop = Mathf.Clamp01(age / .12f);
                float size = Mathf.Lerp(.75f, .5f, pop) * (t < .66f ? 1f : Mathf.Clamp01((1f - t) / .34f));
                if (size < .02f) continue;
                float glow = .9f * (1f - t * .6f);
                var col = m.Attack ? new float4(1f, .28f, .22f, glow) : new float4(.35f, 1f, .45f, glow);
                float y = w.GroundHeight(m.Point.x, m.Point.z) + .025f;
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(m.Point.x, y, m.Point.z)), 0, new float3(size), col));
                // an inner ring makes the attack marker read as a target, not just a red move
                if (m.Attack) rings.Add(InstanceData.TRS(MapSpace.W(new float3(m.Point.x, y, m.Point.z)), 0, new float3(size * .45f), col));
            }
        }

        // ------------------------------------------------------------------ minimap console helpers
        /// <summary>Replace the selection with these units (the idle-units button).</summary>
        public void SelectUnits(System.Collections.Generic.IEnumerable<int> ids)
        {
            units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1;
            SelectedObjective = SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            foreach (int id in ids) units.Selected.Add(id);
            SelectionChanged?.Invoke();
        }

        /// <summary>
        /// A unit's stance: the server's (snapshot index 10, any visible unit, friend or foe), else what this client
        /// last sent, else the default. A stance just sent shows the old value until the next snapshot (~0.1 s).
        /// </summary>
        public string StanceOf(int id)
        {
            if (session.ActionRts && session.Units.TryGet(id, out var u) && u.Stance >= 0 && u.Stance < Stances.Length) return Stances[u.Stance];
            return sentStance.TryGetValue(id, out var s) ? s : DefaultStance;
        }

        // ------------------------------------------------------------------ server reachability for the crossed-out cursor
        // {c:'reach', units, point, move?} → {reach:{ok, all, reachable, units, reason}} (workstream C). Asked at most
        // five times a second, only when the hovered hex changes, and cached per hex for the current selection (4 s).
        readonly System.Collections.Generic.Dictionary<int, (bool blocked, float at)> reachCache = new System.Collections.Generic.Dictionary<int, (bool, float)>();
        int reachSelection = int.MinValue, reachPendingTile = -1;
        float reachNextAt, reachPendingAt;

        /// <summary>
        /// True when the server said no selected unit can reach this hex (reason impassable or unreachable). Unknown
        /// hexes answer false until the reply arrives; H's client-side <see cref="Impassable"/> covers that gap.
        /// </summary>
        bool ReachBlocked(Vector3 mapPoint)
        {
            if (!session.ActionRts || session.Net == null || !session.World.Ready) return false;
            int tile = session.World.Grid.TileAt(mapPoint.x, mapPoint.z);
            if (tile < 0) return false;
            // VISION (2026-11-20): undiscovered ground is never crossed out: whether it can be reached is unseen terrain
            var seen = session.World.Known;
            if (tile >= seen.Length || seen[tile] == 0) return false;
            int sel = units.Selected.Count * 7919 + (Current == Mode.Rally ? 1 : 0);
            foreach (int id in units.Selected) sel = unchecked(sel * 31 + id);
            if (sel != reachSelection || reachCache.Count > 512) { reachSelection = sel; reachCache.Clear(); reachPendingTile = -1; }
            float now = Time.unscaledTime;
            bool have = reachCache.TryGetValue(tile, out var known);
            if (have && now - known.at < 4f) return known.blocked;
            if (reachPendingTile >= 0 && now - reachPendingAt < 2f || now < reachNextAt) return have && known.blocked;
            reachNextAt = now + .2f;
            reachPendingTile = tile; reachPendingAt = now;
            var cmd = new Newtonsoft.Json.Linq.JObject
            {
                ["c"] = "reach", ["units"] = new Newtonsoft.Json.Linq.JArray(new System.Collections.Generic.List<int>(units.Selected).ToArray()), ["point"] = Point(mapPoint),
            };
            if (units.Selected.Count == 0) cmd["move"] = "infantry";   // a rally point: probe as infantry
            int token = sel;
            session.Net.Command(cmd, r =>
            {
                if (reachPendingTile == tile) reachPendingTile = -1;
                if (token != reachSelection) return;
                var reach = r.Raw?["reach"];
                bool blocked = r.Error == null && reach != null && !SE.Core.Protocol.ProtocolDecoder.Bool(reach["ok"], true);
                reachCache[tile] = (blocked, Time.unscaledTime);
            });
            return have && known.blocked;
        }

        /// <summary>Server flag 2048: the unit is holding position (the hold command).</summary>
        public const int HoldingFlag = 2048;

        /// <summary>True when every selected unit is holding position (the selection panel then reads "Stance: Hold").</summary>
        public bool SelectionHolding
        {
            get
            {
                int n = 0;
                foreach (int id in units.Selected)
                {
                    if (!session.Units.TryGet(id, out var u)) continue;
                    if ((u.Flags & HoldingFlag) == 0) return false;
                    n++;
                }
                return n > 0;
            }
        }

        /// <summary>Centre the camera on a map point, keeping the current zoom.</summary>
        public void JumpCamera(Vector3 mapPoint) => cam.JumpTo(mapPoint);

        /// <summary>Server flag 4096: an automatic base engineer (not selectable or commandable; the server ignores orders to it).</summary>
        public const int AutoEngineerFlag = 4096;

        /// <summary>Whether a unit record may join the player's selection (own, not an automatic engineer; spectators see all).</summary>
        bool Selectable(in SE.Core.Units.UnitStore.Record u) =>
            session.Spectator || u.Owner == session.CivId && (u.Flags & AutoEngineerFlag) == 0;

        // ------------------------------------------------------------------ readable refusals (review U)
        /// <summary>
        /// A server refusal as the player should read it. Placement refusals carry a <c>code</c> (territory, road,
        /// spacing, ring, era, foundation; actionBases.js / actionEconomy.js). The command ack can drop the code
        /// (worker.js forwards only <c>error</c>), so a missing code is recognised from the server's text.
        /// </summary>
        public static string ReadableError(ServerMessage reply) => reply == null ? null : ReadableError(reply.Error, reply.ErrorCode);

        public static string ReadableError(string error, string code)
        {
            if (string.IsNullOrEmpty(error)) return error;
            if (string.IsNullOrEmpty(code)) code = GuessErrorCode(error);
            switch (code)
            {
                case "territory":
                    // defenses may also go on neutral ground (ring of influence): their refusal is only for another player's land
                    // (as may trenches and roads since 2026-11-17)
                    if (error.StartsWith("Trenches ", StringComparison.OrdinalIgnoreCase) || error.StartsWith("Roads ", StringComparison.OrdinalIgnoreCase))
                        return "In another player's territory · trenches and roads go on your own land or neutral ground";
                    return error.StartsWith("Defenses ", StringComparison.OrdinalIgnoreCase)
                        ? "In another player's territory · defenses go on your own land or neutral ground"
                        : "Outside your territory · build only on your own land (defenses claim the hexes around them)";
                case "road": return "Not on a road · place a new base on or beside a road";
                case "spacing": return "Too close to another base or outpost · choose a spot further away";
                case "ring": return "No room for the base ring · " + error;
                case "era": return error.TrimEnd('.') + " · upgrade a base's tier to reach the next era";
                case "foundation": return "Roads can't cross a base foundation · the base links its own roads to the hub";
                case "blocked": return BlockedReason(error);
                default: return error;
            }
        }

        /// <summary>"The trench line runs through the bunker: draw it around …" → "Blocked by the bunker · draw the line around it".</summary>
        static string BlockedReason(string error)
        {
            int at = error.IndexOf(" runs through ", StringComparison.OrdinalIgnoreCase);
            if (at < 0) return "Blocked by a structure · draw the line around it";
            string what = error.Substring(at + 14);
            int end = what.IndexOf(':');
            if (end >= 0) what = what.Substring(0, end);
            return "Blocked by " + what + " · draw the line around it";
        }

        static string GuessErrorCode(string error)
        {
            if (error.IndexOf("own territory", StringComparison.OrdinalIgnoreCase) >= 0) return "territory";
            if (error.IndexOf("must connect to a road", StringComparison.OrdinalIgnoreCase) >= 0) return "road";
            if (error.StartsWith("Too close to another base", StringComparison.OrdinalIgnoreCase)) return "spacing";
            if (error.IndexOf(" foundation;", StringComparison.OrdinalIgnoreCase) >= 0) return "foundation";
            if (error.IndexOf(" runs through ", StringComparison.OrdinalIgnoreCase) >= 0) return "blocked";
            if (error.IndexOf("requires Era", StringComparison.OrdinalIgnoreCase) >= 0) return "era";
            return null;
        }

        // ------------------------------------------------------------------ rally markers (econ `ra`)
        /// <summary>
        /// The rally points of the selected production (selected buildings, or every producer of the selected own
        /// base) from the server's econ <c>ra:[x, z, mode]</c>: a flag ring at the point (green move, red attack move)
        /// and a faint dotted lead from the building, so the player sees where new units will go.
        /// </summary>
        void DrawRallyMarkers(float time)
        {
            if (!session.ActionRts || session.Spectator) return;
            if (SelectedBuildings.Count == 0 && SelectedObjective <= 0) return;
            DrawRallyPreview(time);
            var w = session.World;
            var g = w.Grid;
            int shown = 0;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (!b.HasRally || b.Owner != session.CivId || !b.HasPosition) continue;
                if (!SelectedBuildings.Contains(b.Id) && !(SelectedObjective > 0 && b.City == SelectedObjective)) continue;
                if (++shown > 24) break;
                float rx = g.NearX(b.RallyX, b.X), rz = b.RallyZ;
                var col = b.RallyAttackMove ? new float4(1f, .32f, .25f, .75f) : new float4(.38f, .95f, .5f, .7f);
                float pulse = .32f + .03f * Mathf.Sin(time * 4f + b.Id);
                float ry = w.GroundHeight(rx, rz) + .03f;
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(rx, ry, rz)), 0, new float3(pulse), col));
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(rx, ry, rz)), 0, new float3(.12f), col));
                // dotted lead from the building to the point
                float dx = rx - b.X, dz = rz - b.Z, len = Mathf.Sqrt(dx * dx + dz * dz);
                if (len < .4f) continue;
                int steps = Mathf.Clamp(Mathf.CeilToInt(len / .5f), 1, 40);
                var dim = new float4(col.xyz, .35f);
                for (int k = 1; k < steps; k++)
                {
                    float f = k / (float)steps, x = b.X + dx * f, z = b.Z + dz * f;
                    discs.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .03f, z)), 0, new float3(.06f, 1f, .06f), dim));
                }
            }
        }

        /// <summary>
        /// §22: where a new rally point would go — while a Shift-click rally is held, while the rally tool is armed,
        /// and (as a hint) while Shift is held over open ground with production selected: a ring at the cursor and a
        /// dotted lead from each selected producer.
        /// </summary>
        void DrawRallyPreview(float time)
        {
            if (!RallyCapable || hoverTile < 0) return;
            bool hint = Current == Mode.Select && !dragging && InputFacade.Shift;
            if (!rallyPlacing && Current != Mode.Rally && !hint) return;
            if (!cam.TryGround(InputFacade.MousePosition, out var p)) return;
            var w = session.World;
            var g = w.Grid;
            bool attack = RallyAttackMoveArmed;
            var col = attack ? new float4(1f, .32f, .25f, .8f) : new float4(.38f, .95f, .5f, .8f);
            if (hint) col.w = .45f;   // a hint until the click
            float py = w.GroundHeight(p.x, p.z) + .03f;
            rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.x, py, p.z)), 0, new float3(.34f + .04f * Mathf.Sin(time * 7f)), col));
            rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.x, py, p.z)), 0, new float3(.12f), col));
            var dim = new float4(col.xyz, .3f);
            int shown = 0;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.Owner != session.CivId || !b.HasPosition) continue;
                if (!SelectedBuildings.Contains(b.Id) && !(SelectedObjective > 0 && b.City == SelectedObjective && b.Done && IsProductionType(b.Type))) continue;
                if (++shown > 24) break;
                float bx = g.NearX(b.X, p.x), dx = p.x - bx, dz = p.z - b.Z, len = Mathf.Sqrt(dx * dx + dz * dz);
                if (len < .4f) continue;
                int steps = Mathf.Clamp(Mathf.CeilToInt(len / .5f), 1, 40);
                for (int k = 1; k < steps; k++)
                {
                    float f = k / (float)steps, x = bx + dx * f, z = b.Z + dz * f;
                    discs.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .03f, z)), 0, new float3(.06f, 1f, .06f), dim));
                }
            }
        }
    }
}
