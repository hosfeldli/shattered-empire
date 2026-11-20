using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Passive base development (2026-11-18): a held base grows a ring of civilian and support dressing outside its
    /// round foundation as it upgrades and as its owner keeps it: sheds and fuel tanks, a
    /// transformer yard with power poles, a camp of tents, then a water tower, each tied to the compound by a gravel
    /// footpath, with trees and shrubs between.
    ///
    /// Decoration only, strictly separate from gameplay:
    /// - nothing here has a server record, a footprint (no infantry avoidance, no collision), a selection or a team
    ///   colour: anything team-coloured or authored around a base is gameplay, the dressing is muted civilian paint;
    /// - it stays off the foundation (so off every build pad and docking arm), off every drawn road (hex streets and
    ///   compound lanes, <see cref="RoadCurve.RoadDistance"/>), off water, steep ground, forests and mountains, and
    ///   clear of every positioned building (defenses, field structures) by its footprint plus a margin; a new
    ///   defense near the base re-keys the compound and the dressing makes way;
    /// - it is low (sheds ~.1, the water tower ~.4, below the base's own buildings);
    /// - no houses: nothing residential is generated around cities or bases (user request 2026-11-18).
    ///
    /// Growth: level = 2 × (tier − 1) + <see cref="DevelopmentStage"/> (held 0–1 / 1–3 / 3–6 / 6–10 / 10+ minutes),
    /// 0…8; 3 + 2 × level of the 20 candidate lots are used (at most 19). The lots, their order, kinds and recipes
    /// come from the site id and the world seed only: the same base always grows the same way. Lots near a socket
    /// follow its building (a depot or vehicle works grows sheds and tanks, a power plant a transformer yard, a
    /// barracks a camp; lots by the headquarters and empty sockets, and about half the outer ring, stay open).
    ///
    /// Cost: composed inside the base compound record (CityRenderer.BaseCache.cs), so it is replayed with the compound
    /// and only rebuilt when the compound key changes; the key folds in the development stage and every positioned
    /// building within <see cref="DevelopmentReach"/> of the foundation. At most ~20 lots × ~10 instances + ~12 quads.
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        /// <summary>What a lot grows. None: nothing (the cottages that once grew by the HQ and empty sockets were removed, user request 2026-11-18).</summary>
        enum DecorTheme { None, Industrial, Utility, Camp }

        const int DevelopmentLots = 20;
        /// <summary>How far past the foundation edge development reaches (lot ring + lot size); the base key covers buildings this far out plus their size.</summary>
        const float DevelopmentReach = 1.6f;

        /// <summary>How long a base has been held, in development stages (0–4).</summary>
        internal static int DevelopmentStage(float tenure)
            => tenure < 60f ? 0 : tenure < 180f ? 1 : tenure < 360f ? 2 : tenure < 600f ? 3 : 4;

        static int DevelopmentLevel(in ObjectiveSite site)
            => 2 * (Mathf.Clamp(Mathf.Max(site.Tier, 1), 1, 3) - 1) + DevelopmentStage(site.Tenure);

        static DecorTheme ThemeOf(string type)
        {
            switch (type)
            {
                case "depot": case "motor_works": case "heavy_weapons": case "munitions_plant": case "steel_mill":
                case "refinery": case "heavy_assembly": case "salvage": case "lumber":
                    return DecorTheme.Industrial;
                case "power_plant": case "fusion_plant": case "nuclear_plant": case "electronics_plant": case "advanced_lab":
                case "shield_generator": case "comms_tower":
                    return DecorTheme.Utility;
                case "barracks": case "camp": case "defense_works": case "academy":
                    return DecorTheme.Camp;
                default:
                    return DecorTheme.None;
            }
        }

        readonly List<float3> decorObstacles = new List<float3>();   // x, z, radius
        readonly List<float3> decorPlaced = new List<float3>();

        float UndamagedGround(float x, float z)
        {
            int t = world.Grid.TileAt(x, z);
            return t < 0 ? 0 : world.View.GroundHeight(x, z) - world.View.DamageHeight(t, x, z);
        }

        void ComposeBaseDevelopment(in ObjectiveSite site, BaseParcel[] lots)
        {
            if (site.Headquarters == 0 || site.Owner < 0) return;
            int level = DevelopmentLevel(site);
            int count = Mathf.Min(DevelopmentLots, 3 + 2 * level);
            var origin = new float2(site.X, site.Z);
            float foundation = FoundationRadius(origin, lots);
            float memory = site.Memory ? .62f : 1f;
            int seed = DistrictPlanner.StableHash(Seed, site.Id, 4409);

            // what the dressing keeps clear of: positioned buildings outside this compound's sockets, other compounds
            decorObstacles.Clear(); decorPlaced.Clear();
            float reach = foundation + DevelopmentReach;
            foreach (var b in structures.Buildings.Values)
            {
                if (!b.HasPosition || (b.City == site.Id && b.Slot > 0)) continue;
                var at = new float2(world.Grid.NearX(b.X, site.X), b.Z);
                if (math.distancesq(at, origin) > (reach + .8f) * (reach + .8f)) continue;
                float radius = DefenseKinds.TryGetValue(b.Type ?? "", out var kind) ? (kind.Ring > 0 ? kind.Ring + .05f : .32f) : .55f;
                decorObstacles.Add(new float3(at, radius));
            }
            foreach (var other in objectiveByTile.Values)
            {
                if (other.Id == site.Id || !other.IsBase || other.Parcels == null || other.Parcels.Length < MinRingParcels) continue;
                var at = new float2(world.Grid.NearX(other.X, site.X), other.Z);
                if (math.distancesq(at, origin) < 9f * 9f) decorObstacles.Add(new float3(at, 3.3f));
            }

            // the socket nearest each lot (by bearing) decides what grows there
            var occupants = new Dictionary<int, string>();
            foreach (var b in structures.Buildings.Values) if (b.City == site.Id && b.Slot > 0) occupants[b.Slot] = b.Type;

            float rotation = Hash(seed, 1) * 2 * math.PI;
            int stride = (int)(Hash(seed, 3) * 10);
            bool landmark = level >= 6;
            for (int n = 0; n < count; n++)
            {
                int ring = n < 10 ? 0 : 1, k = n % 10;
                int lot = (k * 7 + stride) % 10;                                  // 7 is prime to 10: a stable scatter
                float angle = rotation + (lot + ring * .5f + (Hash(seed, 10 + n) - .5f) * .5f) * 2 * math.PI / 10;
                var bearing = Polar(angle);
                string type = null; float bestDot = -2;
                foreach (var parcel in lots)
                {
                    float dot = math.dot(math.normalizesafe(new float2(parcel.X, parcel.Z) - origin), bearing);
                    if (dot > bestDot) { bestDot = dot; occupants.TryGetValue(parcel.Id, out type); }
                }
                var theme = ThemeOf(type);
                // the outer ring stays sparser: about half its lots stay open ground (they once held cottages)
                if (ring == 1 && Hash(seed, 60 + n) < .45f) theme = DecorTheme.None;
                bool tower = landmark && ring == 1 && k == 0;
                if (theme == DecorTheme.None && !tower) continue;   // no houses: an open lot stays open
                float size = tower ? .16f : theme == DecorTheme.Utility ? .22f : .25f;
                float baseRadius = foundation + (ring == 0 ? .40f : .98f) + Hash(seed, 40 + n) * .2f;
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    var p = origin + bearing * (baseRadius + attempt * .3f);
                    if (!DecorClear(p, size, origin, foundation)) continue;
                    decorPlaced.Add(new float3(p, size));
                    int lotSeed = seed * 31 + n * 977;
                    var toward = math.normalizesafe(origin - p);
                    float yaw = math.atan2(toward.x, toward.y) + (Hash(lotSeed, 2) - .5f) * .5f;
                    float datum = math.min(math.min(Ground(p.x, p.y), Ground(p.x + size * .6f, p.y)),
                        math.min(Ground(p.x - size * .6f, p.y), math.min(Ground(p.x, p.y + size * .6f), Ground(p.x, p.y - size * .6f)))) - .008f;
                    var c = new Ctx { X = p.x, Z = p.y, Yaw = yaw, Seed = lotSeed, Tint = new float3(memory), Civ = new float3(.5f),
                        Era = 1, Level = 1, Tier = 1, Scale = 1, Style = seed, FixedGround = true, GroundY = datum,
                        Kind = theme == DecorTheme.Industrial ? DistrictKind.Industrial
                            : theme == DecorTheme.Utility ? DistrictKind.Energy : DistrictKind.None };   // (None: canvas tents keep a gable, not a metal roof)
                    int keepStyle = styleSeed; styleSeed = seed;
                    if (tower) WaterTower(c, 0, 0, lotSeed);
                    else switch (theme)
                    {
                        case DecorTheme.Industrial: DecorYard(c, lotSeed, memory); break;
                        case DecorTheme.Utility: DecorUtility(c, lotSeed, memory); break;
                        case DecorTheme.Camp: DecorCamp(c, lotSeed, memory); break;
                    }
                    DecorGreenery(c, lotSeed, size, origin, foundation);
                    styleSeed = keepStyle;
                    DecorPath(origin, foundation, p, size, lotSeed, memory);
                    break;
                }
            }
        }

        /// <summary>Whether a decoration lot of radius r at p is clear of everything gameplay or terrain needs.</summary>
        bool DecorClear(float2 p, float r, float2 origin, float foundation)
        {
            int tile = world.Grid.TileAt(p.x, p.y);
            if (tile < 0 || world.Known[tile] == 0 || world.IsSea(tile) || world.IsLake(tile) || world.IsRiver(tile)) return false;
            int biome = world.Biome[tile];
            if (biome >= 9 || biome == 4 || biome == 7) return false;   // mountains, peaks; forests keep their trees
            if (math.distance(p, origin) < foundation + .14f + r) return false;
            if (OverWater(p) || OverWater(p + new float2(r, 0)) || OverWater(p - new float2(r, 0))) return false;
            foreach (var o in decorObstacles) if (math.distancesq(p, o.xy) < (o.z + r + .08f) * (o.z + r + .08f)) return false;
            foreach (var o in decorPlaced) if (math.distancesq(p, o.xy) < (o.z + r + .06f) * (o.z + r + .06f)) return false;
            if (RoadCurve.RoadDistance(world, p, out _, out _) < r + .09f) return false;
            // level enough to build on (hex terrain without craters, so shelling never moves a lot)
            float lo = float.MaxValue, hi = float.MinValue;
            for (int k = 0; k < 5; k++)
            {
                var q = k == 0 ? p : p + Polar(k * math.PI * .5f + .3f) * r;
                float h = UndamagedGround(q.x, q.y);
                lo = math.min(lo, h); hi = math.max(hi, h);
            }
            return hi - lo < .10f;
        }

        /// <summary>A service yard: a shed, fuel tanks on a slab, stacked crates and drums on gravel.</summary>
        void DecorYard(in Ctx c, int seed, float memory)
        {
            Module(c, Part.Box, 0, 0, new float3(.42f, .006f, .30f), YardGravel * memory);
            float w = .19f + Hash(seed, 5) * .05f;
            Module(c, Part.Siding, -.06f, .03f, new float3(w, .095f, .14f), Sheet(seed));
            Module(c, Part.MetalRoof, -.06f, .03f, new float3(w + .02f, .018f, .16f), new float3(.40f, .42f, .43f), 0, .095f);
            for (int k = 0; k < 2; k++)
                Module(c, Part.Cylinder, .12f, -.06f + k * .08f, new float3(.06f, .075f, .06f), new float3(.70f, .70f, .66f), 0, .004f);
            int crates = 2 + (int)(Hash(seed, 6) * 2);
            for (int k = 0; k < crates; k++)
                Module(c, Part.Box, -.12f + k * .055f, -.11f, new float3(.045f, .04f, .045f), Timber(seed + k), Hash(seed, 20 + k) * .5f, k == crates - 1 && crates > 2 ? .04f : 0);
            for (int k = 0; k < 3; k++)
                Module(c, Part.Cylinder, .05f + k * .028f, -.12f, new float3(.022f, .034f, .022f), Hash(seed, 30 + k) < .5f ? new float3(.48f, .28f, .18f) : new float3(.26f, .34f, .42f));
        }

        /// <summary>A transformer yard: a fenced slab, two transformers and a line of power poles toward the compound.</summary>
        void DecorUtility(in Ctx c, int seed, float memory)
        {
            Module(c, Part.Box, 0, 0, new float3(.28f, .006f, .22f), new float3(.58f, .58f, .55f) * memory);
            for (int k = 0; k < 2; k++)
            {
                Module(c, Part.Concrete, -.06f + k * .12f, 0, new float3(.07f, .065f, .055f), new float3(.47f, .49f, .47f));
                Module(c, Part.Box, -.06f + k * .12f, 0, new float3(.075f, .012f, .06f), new float3(.33f, .35f, .34f), 0, .065f);
            }
            for (int k = 0; k < 4; k++)
                Module(c, Part.Cylinder, (k % 2 == 0 ? -.13f : .13f), (k < 2 ? -.10f : .10f), new float3(.008f, .07f, .008f), SteelGrey);
            for (int side = -1; side <= 1; side += 2)
                Module(c, Part.Box, side * .13f, 0, new float3(.004f, .006f, .20f), SteelGrey, 0, .055f);
            // poles toward the base (local +z faces the hub)
            for (int k = 0; k < 2; k++)
            {
                float lz = .20f + k * .17f;
                Module(c, Part.Cylinder, .02f, lz, new float3(.011f, .22f, .011f), Timber(seed + k) * .8f);
                Module(c, Part.Box, .02f, lz, new float3(.09f, .008f, .008f), Timber(seed + k) * .7f, 0, .20f);
            }
        }

        /// <summary>A camp: canvas tents in a row, a hut, a water tank on beaten earth.</summary>
        void DecorCamp(in Ctx c, int seed, float memory)
        {
            Module(c, Part.Box, 0, 0, new float3(.40f, .006f, .30f), new float3(.44f, .39f, .30f) * memory);
            var canvas = math.lerp(new float3(.55f, .52f, .40f), new float3(.47f, .48f, .38f), Hash(seed, 5));
            int tents = 2 + (int)(Hash(seed, 6) * 2);
            for (int k = 0; k < tents; k++)
                Module(c, Part.Roof, -.13f + k * .1f, .06f, new float3(.085f, .07f, .14f), canvas * (.94f + .1f * Hash(seed, 10 + k)), math.PI * .5f);
            Module(c, Part.Siding, .1f, -.09f, new float3(.13f, .075f, .09f), new float3(.40f, .41f, .34f));
            Module(c, Part.MetalRoof, .1f, -.09f, new float3(.145f, .015f, .105f), new float3(.38f, .39f, .37f), 0, .075f);
            Module(c, Part.Cylinder, -.12f, -.09f, new float3(.05f, .065f, .05f), new float3(.33f, .38f, .36f));
        }

        /// <summary>A tree or two and a shrub at the lot's edge, never on a road or another lot.</summary>
        void DecorGreenery(in Ctx c, int seed, float size, float2 origin, float foundation)
        {
            int trees = 1 + (int)(Hash(seed, 50) * 2.2f);
            for (int k = 0; k < trees; k++)
            {
                float a = Hash(seed, 51 + k) * 2 * math.PI;
                float lx = math.sin(a) * (size + .06f), lz = math.cos(a) * (size + .06f);
                math.sincos(c.Yaw, out float sn, out float cs);
                var at = new float2(c.X + lx * cs + lz * sn, c.Z - lx * sn + lz * cs);
                if (math.distance(at, origin) < foundation + .16f || RoadCurve.RoadDistance(world, at, out _, out _) < .1f || OverWater(at)) continue;
                bool blocked = false;
                foreach (var o in decorObstacles) if (math.distancesq(at, o.xy) < (o.z + .1f) * (o.z + .1f)) { blocked = true; break; }
                if (blocked) continue;
                bool shrub = Hash(seed, 60 + k) < .4f;
                float s = shrub ? .09f + Hash(seed, 70 + k) * .03f : .15f + Hash(seed, 70 + k) * .06f;
                var leaf = math.lerp(new float3(.40f, .49f, .34f), new float3(.47f, .52f, .36f), Hash(seed, 80 + k));
                Module(c, Part.Tree, lx, lz, new float3(s, s * (shrub ? .8f : 1.35f), s), leaf, Hash(seed, 90 + k) * 6f);
            }
        }

        /// <summary>
        /// A gravel footpath from the lot to the foundation's edge, gently bowed; where it would meet a road first it
        /// ends at the road instead (a path never crosses a carriageway).
        /// </summary>
        void DecorPath(float2 origin, float foundation, float2 p, float size, int seed, float memory)
        {
            var dir = math.normalizesafe(p - origin);
            var start = p - dir * (size * .85f);
            var end = origin + dir * (foundation + .02f);
            float length = math.distance(start, end);
            if (length < .08f) return;
            var bow = (start + end) * .5f + new float2(-dir.y, dir.x) * (Hash(seed, 101) - .5f) * math.min(.24f, length * .3f);
            int pieces = Mathf.Clamp(Mathf.CeilToInt(length / .12f), 2, 8);
            int last = pieces;
            for (int k = 1; k <= pieces; k++)
            {
                var at = Quadratic(start, bow, end, k / (float)pieces);
                if (RoadCurve.RoadDistance(world, at, out _, out _) < .02f || OverWater(at)) { last = k; break; }
            }
            var color = PathGravel * (.92f + .1f * Hash(seed, 102)) * memory;
            for (int k = 0; k < last; k++)
            {
                float ta = k / (float)pieces, tb = (k + 1) / (float)pieces;
                var a = Quadratic(start, bow, end, ta); var b = Quadratic(start, bow, end, tb);
                var sa = math.normalizesafe(Quadratic(start, bow, end, math.min(1, ta + .01f)) - Quadratic(start, bow, end, math.max(0, ta - .01f))); sa = new float2(-sa.y, sa.x);
                var sb = math.normalizesafe(Quadratic(start, bow, end, math.min(1, tb + .01f)) - Quadratic(start, bow, end, math.max(0, tb - .01f))); sb = new float2(-sb.y, sb.x);
                RoadStrip(a, b, sa, sb, -.026f, .026f, float.NegativeInfinity, -.0044f, color, SurfaceKind.Soil);
            }
        }
    }
}
