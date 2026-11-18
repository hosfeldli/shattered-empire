namespace SE.Runtime
{
    /// <summary>
    /// Diagnostic switches for A/B performance measurements (docs/performance). Each one restores the code path that
    /// an optimisation replaced, so one build can measure before and after under identical conditions. Set from the
    /// command line with -perf-legacy geometry,streets,spoil,territory,basekey,trees,unitcull,compose,decode (or all); all off in normal play.
    /// </summary>
    public static class PerfFlags
    {
        /// <summary>Apply geometry updates immediately, blocking on running terrain jobs (ClientSession.Geometry).</summary>
        public static bool LegacyGeometry;
        /// <summary>Compose every cell's streets from scratch (no CityRenderer street cache).</summary>
        public static bool LegacyStreets;
        /// <summary>Re-place all crater spoil on every warzone rebuild (no per-tile cache).</summary>
        public static bool LegacySpoil;
        /// <summary>Rebuild the territory textures synchronously on the main thread.</summary>
        public static bool LegacyTerritory;
        /// <summary>Base compound cache keyed on the map-wide road revision and maturity; lanes always re-published.</summary>
        public static bool LegacyBaseKey;
        /// <summary>Pass 2: one shared no-tree flag for towns and battle wasteland, and trees re-derived from the current (capped) crater list (TerrainRenderer).</summary>
        public static bool LegacyTrees;
        /// <summary>Pass 2: build every unit's detailed model and figures across the whole map, not just those in view (UnitRenderer).</summary>
        public static bool LegacyUnitCull;
        /// <summary>Pass 2: compose each dirty city cell start to finish in one frame, coupled base cells together (no time slicing, CityRenderer.Slicing.cs).</summary>
        public static bool LegacyCompose;

        public static void Parse(string list)
        {
            if (string.IsNullOrEmpty(list)) return;
            foreach (var raw in list.Split(','))
            {
                var k = raw.Trim().ToLowerInvariant();
                bool all = k == "all";
                if (all || k == "geometry") LegacyGeometry = true;
                if (all || k == "streets") LegacyStreets = true;
                if (all || k == "spoil") LegacySpoil = true;
                if (all || k == "territory") LegacyTerritory = true;
                if (all || k == "basekey") LegacyBaseKey = true;
                if (all || k == "trees") LegacyTrees = true;
                if (all || k == "unitcull") LegacyUnitCull = true;
                if (all || k == "compose") LegacyCompose = true;
                if (all || k == "decode") SE.Core.Protocol.ProtocolDecoder.LegacyDecode = true;
            }
        }

        public static string Describe() =>
            (LegacyGeometry ? "geometry," : "") + (LegacyStreets ? "streets," : "") + (LegacySpoil ? "spoil," : "") +
            (LegacyTerritory ? "territory," : "") + (LegacyBaseKey ? "basekey," : "") +
            (LegacyTrees ? "trees," : "") + (LegacyUnitCull ? "unitcull," : "") +
            (LegacyCompose ? "compose," : "") +
            (SE.Core.Protocol.ProtocolDecoder.LegacyDecode ? "decode," : "");
    }
}
