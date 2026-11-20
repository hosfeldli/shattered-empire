using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;

namespace SE.Runtime.UI
{
    /// <summary>
    /// 2026-11-19 (user: "when hovering over a unit it should show information on their slopes needed for
    /// pathfinding"): one line of terrain limits for a ground unit's hover card and the Field Guide. The climb limit
    /// is the server's navigation gradient (rise over run) per movement class, sent in
    /// <c>RULESET.mobility.maxGradient</c> (actionDefinitions.js, read from actionNavigation MAX_GRADIENT); a unit
    /// definition's own <c>maxSlope</c> (degrees, or a gradient when below 2) overrides it. Rivers and terrain follow
    /// actionNavigation.cost(): infantry wade any river and cannot enter dense forest off a road; vehicles ford narrow
    /// rivers but need a bridge over wide ones; wheels cannot enter marsh or mountains; a road cuts any slope.
    /// </summary>
    public sealed partial class Hud
    {
        /// <summary>The steepest ground a unit type climbs off-road, in degrees, or -1 for aircraft / unknown types.</summary>
        public static float MaxSlopeDegrees(JObject defs, string type)
        {
            var def = defs?["UNITS"]?[type ?? ""] as JObject;
            if (def == null || ProtocolDecoder.Bool(def["air"])) return -1;
            var own = def["maxSlope"];
            if (own != null && own.Type is JTokenType.Float or JTokenType.Integer)
            {
                float v = own.Value<float>();
                if (v > 0) return v >= 2f ? v : Mathf.Atan(v) * Mathf.Rad2Deg;
            }
            string move = ProtocolDecoder.Str(def["move"], "infantry");
            var g = defs?["RULESET"]?["mobility"]?["maxGradient"]?[move];
            float gradient = g != null && g.Type is JTokenType.Float or JTokenType.Integer ? g.Value<float>()
                : move == "wheeled" ? .31f : move == "tracked" ? .45f : .50f;   // the server's values on 2026-11-19
            return Mathf.Atan(gradient) * Mathf.Rad2Deg;
        }

        /// <summary>"On foot · climbs slopes up to 33° · wades rivers · dense forest only by road", or null for aircraft.</summary>
        public static string TerrainLimits(JObject defs, string type)
        {
            float deg = MaxSlopeDegrees(defs, type);
            if (deg < 0) return null;
            string move = ProtocolDecoder.Str(defs?["UNITS"]?[type ?? ""]?["move"], "infantry");
            int d = Mathf.RoundToInt(deg);
            var mobility = defs?["RULESET"]?["mobility"];
            // HILLS_MOUNTAINS (server, 2026-11-19): mountains and peaks are walls for every ground class (impassableTerrain);
            // infantry climb hills at hillPace of their speed. Older servers: wheels never entered mountains anyway.
            bool noMountains = mobility?["impassableTerrain"] is JArray walls ? walls.ToString().Contains("mountain") : move == "wheeled";
            var pace = mobility?["hillPace"]?[move];
            string hills = pace != null && pace.Type is JTokenType.Float or JTokenType.Integer && pace.Value<float>() < .99f
                ? $" · {Mathf.RoundToInt(pace.Value<float>() * 100)}% pace up hills" : "";
            string mountains = noMountains ? " · no mountains" : "";
            switch (move)
            {
                case "wheeled": return $"Wheeled · slopes up to {d}°, steeper only by road{hills} · no marsh{mountains} · needs bridges over wide rivers";
                case "tracked": return $"Tracked · slopes up to {d}°, steeper only by road{hills} · crosses marsh{mountains} · needs bridges over wide rivers";
                default: return $"On foot · climbs slopes up to {d}°{hills}{mountains} · wades rivers · dense forest only by road";
            }
        }

        /// <summary>The ring style that shows a stance (UnitRenderer stance outlines), for the hover card and Field Guide.</summary>
        public static string StanceRingName(string stance) => stance switch
        {
            "aggressive" => "dashed ring",
            "defensive" => "solid ring",
            "hold" => "double ring",
            "holdFire" => "dotted ring",
            _ => null,
        };
    }
}
