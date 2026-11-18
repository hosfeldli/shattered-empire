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
        /// <summary>Longest link between two nodes the server routed together (stroke samples in neighbouring hexes).</summary>
        public const float RoutedReach = 2.9f;
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

        /// <summary>The enemy-side facing (map radians, atan2(dx, dz)) of a record, also for records without a position.</summary>
        public static float FacingOf(in TrenchRecord t)
        {
            if (t.HasPosition) return t.Facing;
            int d = ((t.Dir % 6) + 6) % 6;
            return (float)Math.Atan2(HexMath.DirX[d], HexMath.DirZ[d]);
        }
    }
}
