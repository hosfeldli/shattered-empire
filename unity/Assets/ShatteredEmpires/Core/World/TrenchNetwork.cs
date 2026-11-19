using System;
using SE.Core.Protocol;

namespace SE.Core.World
{
    /// <summary>
    /// Which trench nodes are joined into one line: the single rule shared by the trench renderer
    /// (Runtime/Battlefields/TrenchRenderer) and the terrain's trench geometry (WorldModel.ApplyTrenches →
    /// TerrainView.TrenchNearest, which troops stand along). See docs/gameplay-overhaul/TRENCHES.md.
    /// </summary>
    public static class TrenchNetwork
    {
        /// <summary>
        /// Longest link between two nodes the server routed together. Routed nodes are always in neighbouring hexes
        /// (centres 1.73 apart, a node anywhere inside its hex of radius 1), so this only guards against bad data.
        /// It was 2.9 and silently dropped the longer joins (about 1 link in 100: a junction to an older line whose
        /// node sits across its hex), which showed as a gap (2026-11-18, "the trenches don't connect").
        /// </summary>
        public const float RoutedReach = 3.8f;
        /// <summary>Longest link between route-less nodes (older servers): close neighbours of one owner join.</summary>
        public const float LegacyReach = 1.35f;

        /// <summary>
        /// Whether node a and node b (b is a's neighbour in hex direction d, at map distance length) are joined.
        /// The server's route bits decide (either end's bit is enough). Records that carry route bits link by them
        /// only, so two parallel lines a hex apart are not laddered together and a stroke over a hex corner draws no
        /// triangle; route-less records (servers before 2026-11-18 under the action ruleset) fall back to proximity.
        /// </summary>
        public static bool Linked(in TrenchRecord a, in TrenchRecord b, int d, float length)
        {
            if (a.Owner != b.Owner || length < .02f) return false;
            bool routed = (a.Route & (1 << d)) != 0 || (b.Route & (1 << ((d + 3) % 6))) != 0;
            if (routed) return length <= RoutedReach;
            if (a.Route != 0 || b.Route != 0) return false;
            return length <= LegacyReach;
        }

        /// <summary>A record's digging progress, 0..1 (a planned or queued node is 0).</summary>
        public static float ProgressOf(in TrenchRecord t) => t.State == 2 ? 0f : Clamp01(t.Progress / 100f);

        /// <summary>
        /// Which stretch of node a's half of a link to node b is drawn dug, as fractions of the half measured from
        /// a's node (from..to; from == to: nothing). A link's digging is drawn as one stretch grown from the more
        /// advanced node (higher progress, ties to the lower tile), (progress a + progress b) halves long. So a
        /// finished node and a part-dug neighbour show one trench reaching on from the finished one, never two pits
        /// with a gap between them (before 2026-11-18 each half grew from its own node). Both finished: both halves
        /// whole. <paramref name="otherKnown"/> false (the neighbour is not drawn): a's half is dug from its node by
        /// its own progress.
        /// </summary>
        public static void HalfDug(int tileA, float progressA, int tileB, float progressB, bool otherKnown, out float from, out float to)
        {
            float pa = Clamp01(progressA), pb = otherKnown ? Clamp01(progressB) : 0f;
            bool leads = !otherKnown || pa > pb || (pa == pb && tileA < tileB);
            float total = pa + pb;
            if (leads) { from = 0f; to = Math.Min(1f, total); return; }
            float far = Math.Max(0f, total - 1f);
            from = 1f - far; to = far > 0f ? 1f : from;
        }

        /// <summary>Whether link a-b is dug right across its midpoint (both halves meet open there, no digging face).</summary>
        public static bool MeetsOpen(float progressA, float progressB, bool otherKnown)
            => otherKnown && Clamp01(progressA) + Clamp01(progressB) > 1f + 1e-4f;

        static float Clamp01(float v) => v < 0f ? 0f : v > 1f ? 1f : v;

        /// <summary>The enemy-side facing (map radians, atan2(dx, dz)) of a record, also for records without a position.</summary>
        public static float FacingOf(in TrenchRecord t)
        {
            if (t.HasPosition) return t.Facing;
            int d = ((t.Dir % 6) + 6) % 6;
            return (float)Math.Atan2(HexMath.DirX[d], HexMath.DirZ[d]);
        }

        /// <summary>
        /// Self-test of the link rule and the dig stretches (pure C#, no scene needed). Run it in the editor with
        /// execute_code: <c>return SE.Core.World.TrenchNetwork.SelfTest();</c>. Returns "ok" or the first failure.
        /// </summary>
        public static string SelfTest()
        {
            TrenchRecord R(int tile, int owner, int route) => new TrenchRecord { Tile = tile, Owner = owner, Route = route, HasPosition = true, Progress = 100 };
            // links: either end's bit is enough; routed links reach across any pair of neighbouring hexes
            if (!Linked(R(1, 0, 1 << 0), R(2, 0, 0), 0, 1.7f)) return "routed link (own bit)";
            if (!Linked(R(1, 0, 0), R(2, 0, 1 << 3), 0, 1.7f)) return "routed link (the neighbour's bit)";
            if (!Linked(R(1, 0, 1 << 0), R(2, 0, 1 << 3), 0, 3.4f)) return "long routed link across both hexes";
            if (Linked(R(1, 0, 1 << 0), R(2, 1, 1 << 3), 0, 1.7f)) return "different owners must not link";
            if (Linked(R(1, 0, 1 << 1), R(2, 0, 1 << 5), 0, 1.7f)) return "bits for other directions must not link";
            if (Linked(R(1, 0, 1 << 1), R(2, 0, 0), 0, 1f)) return "routed records link by route only";
            if (!Linked(R(1, 0, 0), R(2, 0, 0), 0, 1.2f)) return "legacy proximity";
            var planned = R(3, 0, 0); planned.State = 2;
            if (ProgressOf(planned) != 0f || ProgressOf(R(3, 0, 0)) != 1f) return "progress of a record";
            // dig stretches: one contiguous stretch from the more advanced node, whole when both are finished
            bool Near(float x, float y) => Math.Abs(x - y) < 1e-4f;
            string Pair(float pa, float pb, float af, float at, float bf, float bt, bool open, string what)
            {
                HalfDug(10, pa, 11, pb, true, out var a0, out var a1);
                HalfDug(11, pb, 10, pa, true, out var b0, out var b1);
                bool emptyA = Near(af, at) && Near(a0, a1), emptyB = Near(bf, bt) && Near(b0, b1);
                bool okA = emptyA || (Near(a0, af) && Near(a1, at)), okB = emptyB || (Near(b0, bf) && Near(b1, bt));
                if (!okA || !okB || MeetsOpen(pa, pb, true) != open)
                    return $"{what}: a {a0:0.##}-{a1:0.##} b {b0:0.##}-{b1:0.##} open {MeetsOpen(pa, pb, true)}";
                // contiguity: when both halves have a dug stretch, both reach the midpoint (no gap between them)
                if (a1 > a0 + 1e-4f && b1 > b0 + 1e-4f && !(Near(a1, 1f) && Near(b1, 1f))) return what + ": gap at the midpoint";
                // and a follower's stretch always starts at the midpoint side, never at its own node alone
                if (b1 > b0 + 1e-4f && b0 > 1e-4f && !Near(b1, 1f)) return what + ": detached stretch";
                return null;
            }
            string fail = Pair(1f, 1f, 0, 1, 0, 1, true, "both finished")
                ?? Pair(1f, .4f, 0, 1, .6f, 1, true, "finished + part-dug")
                ?? Pair(1f, 0f, 0, 1, 0, 0, false, "finished + planned")
                ?? Pair(.3f, .3f, 0, .6f, 0, 0, false, "tie (the lower tile leads)")
                ?? Pair(.2f, .7f, 0, 0, 0, .9f, false, "the more advanced node leads")
                ?? Pair(0f, 0f, 0, 0, 0, 0, false, "both planned");
            if (fail != null) return fail;
            HalfDug(10, .5f, 11, 1f, false, out var u0, out var u1);
            if (!(Near(u0, 0) && Near(u1, .5f)) || MeetsOpen(.5f, 1f, false)) return "unknown neighbour: own progress from the node";
            return "ok";
        }
    }
}
