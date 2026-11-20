using System.Collections.Generic;
using System.Linq;
using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        readonly Dictionary<int, int> maturityStages = new Dictionary<int, int>();
        int ringBuildingRevision = -1;
        void InvalidateRingDistricts()
        {
            if (!ActionRts) return;
            // The compound's entrance roads are composed with the headquarters chunk but end on the edge
            // portals of the hexes around it, which can sit in neighbouring chunks: when one of those is
            // recomposed (explored, roads changed) the base is too, or its approach would stop short of
            // the half-street outside (or a stale approach would lead nowhere).
            if (dirty.Count > 0)
                foreach (var site in objectiveByTile.Values)
                {
                    if (!site.IsBase || site.Parcels == null) continue;
                    int home = world.ChunkOf(site.Tile);
                    if (dirty.Contains(home)) continue;
                    for (int ring = 0; ring < 4 && !dirty.Contains(home); ring++)   // out to the portals past CompoundSkipRadius
                        for (int k = 0; k < 12; k++)
                        {
                            float a = k * math.PI / 6, r = 1.6f + ring * .9f;
                            int tile = world.Grid.TileAt(site.X + math.sin(a) * r, site.Z + math.cos(a) * r);
                            if (tile >= 0 && dirty.Contains(world.ChunkOf(tile))) { dirty.Add(home); break; }
                        }
                }
            if (ringBuildingRevision == structures.Revision) return;
            ringBuildingRevision = structures.Revision;
            foreach (var site in objectiveByTile.Values)
                if (site.Parcels != null && site.Parcels.Any(p => dirty.Contains(world.ChunkOf(p.Tile))))
                    dirty.Add(world.ChunkOf(site.Tile));
        }
        readonly Dictionary<int, ResourcePickup> pickups = new Dictionary<int, ResourcePickup>();
        public void SetPickups(IEnumerable<ResourcePickup> records)
        {
            var next = new HashSet<int>();
            foreach (var p in records)
            {
                next.Add(p.Id);
                if (!pickups.TryGetValue(p.Id, out var old) || old.Memory != p.Memory || PickupPieces(old) != PickupPieces(p) || old.Resource != p.Resource)
                    dirty.Add(world.ChunkOf(p.Tile));
                pickups[p.Id] = p;
            }
            foreach (int id in pickups.Keys.Where(id => !next.Contains(id)).ToArray())
            { dirty.Add(world.ChunkOf(pickups[id].Tile)); pickups.Remove(id); }
        }

        /// <summary>Crates (materials) or cells (energy) drawn for a cache: by its full size, fewer as it is emptied.</summary>
        static int PickupPieces(in ResourcePickup p)
        {
            int full = p.Max >= 100 ? 3 : 2;
            if (p.Resource == "energy") full++;
            if (p.Max <= 0 || p.Amount >= p.Max) return full;
            return Mathf.Clamp(Mathf.CeilToInt(full * p.Amount / (float)p.Max), 1, full);
        }

        void MaterialsPickup(in ResourcePickup pickup)
        {
            float dim = pickup.Memory ? .56f : 1;
            var c = new Ctx { X = pickup.X, Z = pickup.Z, Yaw = Hash(pickup.Id, 5) * 1.3f, Seed = pickup.Id,
                Tint = new float3(dim), Civ = new float3(.5f), FixedGround = true, GroundY = Ground(pickup.X, pickup.Z), Era = 1, Level = 1 };
            // §38: a compact ground ring by type, baked with the cell like the crates (no per-frame cost):
            // materials an amber square, energy a cyan hexagon, so shape tells them apart as well as colour
            bool energy = pickup.Resource == "energy";
            PickupRing(new float2(pickup.X, pickup.Z), c.Yaw, energy ? 6 : 4, energy ? new float3(.30f, .80f, .92f) : new float3(.93f, .68f, .22f), dim);
            Module(c, Part.Siding, 0, 0, new float3(.25f, .018f, .19f), new float3(.46f, .40f, .29f));
            int count = PickupPieces(pickup);
            if (energy)
            {
                // energy: upright fuel cells with glowing cyan caps rather than crates
                for (int i = 0; i < count; i++)
                {
                    float x = (i - (count - 1) * .5f) * .07f;
                    Module(c, Part.Cylinder, x, 0, new float3(.055f, .10f, .055f), new float3(.30f, .36f, .40f), 0, .018f);
                    Module(c, Part.Cylinder, x, 0, new float3(.035f, .014f, .035f), new float3(.40f, .86f, .96f), 0, .118f, .5f);
                }
                return;
            }
            for (int i = 0; i < count; i++)
            {
                float x = i == 2 ? 0 : count == 1 ? 0 : (i - .5f) * .112f, lift = i == 2 ? .10f : .02f;
                Module(c, Part.Siding, x, 0, new float3(.105f, .078f, .145f), new float3(.56f, .46f, .29f), 0, lift);
                Module(c, Part.Siding, x, .074f, new float3(.011f, .074f, .006f), new float3(.79f, .73f, .54f), 0, lift);
                Module(c, Part.Siding, x, -.074f, new float3(.011f, .074f, .006f), new float3(.79f, .73f, .54f), 0, lift);
                Module(c, Part.Siding, x, 0, new float3(.011f, .004f, .15f), new float3(.79f, .73f, .54f), 0, lift + .079f);
            }
        }

        /// <summary>A thin draped polygon band (sides 4: a square, 6: a hexagon) around a pickup, in the cell's ground mesh.</summary>
        void PickupRing(float2 p, float yaw, int sides, float3 colour, float dim)
        {
            if (OverWater(p)) return;
            const float Outer = .205f, Inner = .178f;
            float turn = yaw + math.PI / sides;   // a flat side faces the crates' front
            for (int k = 0; k < sides; k++)
            {
                float a = turn + k * 2 * math.PI / sides, b = turn + (k + 1) * 2 * math.PI / sides;
                RoadStrip(p, p, Polar(a), Polar(b), Inner, Outer, float.NegativeInfinity, -.0012f, colour * dim, SurfaceKind.Plain);
            }
        }

        void UpdateCityMaturation()
        {
            foreach (var site in objectiveByTile.Values)
            {
                // (the development stage by tenure regrows the base dressing, CityRenderer.BaseDevelopment.cs)
                int stage = DevelopmentStage(site.Tenure);   // (maturity only grew the removed settlement houses)
                if (maturityStages.TryGetValue(site.Id, out int old) && old == stage) continue;
                maturityStages[site.Id] = stage;
                dirty.Add(world.ChunkOf(site.Tile));
            }
        }

        static float2 Catmull(float2 a, float2 b, float2 c, float2 d, float t)
            => .5f * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

        static float2 CatmullSide(float2 a, float2 b, float2 c, float2 d, float t)
        {
            var tangent = math.normalizesafe(.5f * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t * t));
            return new float2(-tangent.y, tangent.x);
        }

        void CompoundStreet(float2 a, float2 b, float width = .235f, bool restored = true)
        {
            var dir = math.normalizesafe(b - a); var side = new float2(-dir.y, dir.x);
            CompoundStreet(a, b, side, side, width, restored);
        }

        void CompoundStreet(float2 a, float2 b, float2 sideA, float2 sideB, float width, bool restored, bool outerPavement = true)
        {
            float h = width * .5f;
            var pavement = new float3(.53f, .53f, .49f);
            // Paving occupies the verges only. A full-width concrete quad underneath
            // the asphalt intersects its independently sampled slope and creates wedges.
            RoadStrip(a, b, sideA, sideB, -h, h, float.NegativeInfinity, -.001f,
                restored ? new float3(.31f, .33f, .32f) : new float3(.37f, .36f, .32f), SurfaceKind.Asphalt);
            if (width < .20f) return; // A service apron joins the carriageway without curbs across its mouth.
            RoadStrip(a, b, sideA, sideB, -h - .055f, -h, float.NegativeInfinity, -.003f, pavement, SurfaceKind.Concrete);
            RoadStrip(a, b, sideA, sideB, -h - .006f, -h, float.NegativeInfinity, .001f, pavement * 1.14f, SurfaceKind.Concrete);
            if (outerPavement)
            {
                RoadStrip(a, b, sideA, sideB, h, h + .055f, float.NegativeInfinity, -.003f, pavement, SurfaceKind.Concrete);
                RoadStrip(a, b, sideA, sideB, h, h + .006f, float.NegativeInfinity, .001f, pavement * 1.14f, SurfaceKind.Concrete);
            }
        }

        /// <summary>Fewest parcels (the headquarters and three sockets) that make a ring compound.</summary>
        const int MinRingParcels = 4;

        void ComposeCityDistrict(ObjectiveSite site)
        {
            // one source for both paths: the staged form (CityRenderer.Slicing.cs) never yields outside a sliced job
            var steps = ComposeCityDistrictSteps(site);
            while (steps.MoveNext()) { }
        }

        // The complete compound graph is owned by its headquarters chunk. Outside
        // half-streets retain their original shared edge/tangent/width, so adjacent
        // chunks and bridges meet the compound at exactly the same portal.
        bool ComposeRingApproaches(int tile)
        {
            var center = new float2(world.Grid.CenterX(tile), world.Grid.CenterZ(tile));
            foreach (var s in objectiveByTile.Values)
            {
                if (!s.IsBase || s.Parcels == null || s.Parcels.Length < MinRingParcels) continue;
                if (math.distancesq(center, new float2(s.X, s.Z)) < CompoundSkipRadius * CompoundSkipRadius) return true;
            }
            return false;
        }

        // (The ring of street-front settlement houses that grew outside the foundation with maturity was removed
        // for good, user request 2026-11-18: no dynamically built houses next to cities or bases.)

        void HeavyWeaponsFacility(in Ctx c)
        {
            Arsenal(c, true);
            Module(c, Part.Crane, .33f, -.35f, new float3(.27f, .36f, .27f), Hazard, -.18f);
            Module(c, Part.Concrete, -.37f, -.30f, new float3(.26f, .18f, .30f), new float3(.56f, .58f, .53f));
            for (int k = 0; k < 3; k++) Module(c, Part.Cylinder, -.43f + k * .065f, -.28f, new float3(.041f, .17f, .041f), Olive, 0, .18f);
            // §34 silhouette: a yellow gantry crane straddles the loading yard with a gun barrel in its slings
            // (the armoury's yard holds earth-bermed magazines instead)
            for (int i = 0; i < 2; i++)
                for (int j = 0; j < 2; j++)
                    Module(c, Part.Cylinder, -.36f + i * .50f, .20f + j * .20f, new float3(.016f, .27f, .016f), Hazard);
            for (int j = 0; j < 2; j++) Module(c, Part.Box, -.11f, .20f + j * .20f, new float3(.54f, .024f, .024f), Hazard, 0, .27f);
            for (int i = 0; i < 2; i++) Module(c, Part.Box, -.36f + i * .50f, .30f, new float3(.024f, .024f, .22f), Hazard * .9f, 0, .27f);
            Module(c, Part.Box, -.05f, .30f, new float3(.07f, .035f, .23f), Dark, 0, .25f);                         // trolley
            Module(c, Part.Cylinder, -.05f, .30f, new float3(.004f, .10f, .004f), SteelGrey, 0, .15f);                 // hoist line
            Module(c, Part.Box, -.05f, .30f, new float3(.24f, .022f, .022f), Olive * .8f, 0, .13f);                    // the barrel
        }

        void PerimeterTurret(in Ctx original)
        {
            var c = original; c.Scale = S(original) * .5f;
            Module(c, Part.Concrete, 0, 0, new float3(.28f, .022f, .28f), new float3(.58f, .57f, .51f));
            Module(c, Part.Cylinder, 0, 0, new float3(.12f, .10f, .12f), new float3(.35f, .38f, .33f), 0, .022f);
            Module(c, Part.Siding, 0, 0, new float3(.15f, .075f, .16f), Olive, 0, .11f);
            Module(c, Part.Box, -.027f, .105f, new float3(.014f, .014f, .12f), new float3(.22f, .23f, .22f), 0, .14f);
            Module(c, Part.Box, .055f, .015f, new float3(.055f, .038f, .07f), new float3(.40f, .41f, .34f), 0, .13f);
            Module(c, Part.Glass, .025f, .088f, new float3(.035f, .025f, .012f), new float3(.24f, .32f, .34f), 0, .145f);
            Module(c, Part.Cylinder, 0, 0, new float3(.125f, .012f, .125f), c.Civ, 0, .098f, TeamGlow);   // §35 team band (fallback when the authored turret is missing)
        }

        void FieldBarricades(in Ctx c)
        {
            for (int row = 0; row < 4; row++) for (int k = 0; k < 16; k++)
                Module(c, Part.Sandbag, (k - 7.5f) * .027f + (row % 2) * .0135f, .005f * math.sin(k), new float3(.030f, .010f, .019f), new float3(.52f, .47f, .36f), (k % 2 == 0 ? .04f : -.04f), row * .0085f);
            Module(c, Part.Wire, 0, -.11f, new float3(.42f, .07f, .09f), new float3(.84f, .82f, .77f));
            for (int side = -1; side <= 1; side += 2)
                Module(c, Part.TankObstacle, side * .19f, .15f, new float3(.07f), new float3(.90f, .88f, .80f), side * .24f);
        }

        void SensorPost(in Ctx c)
        {
            Module(c, Part.Siding, -.12f, -.10f, new float3(.30f, .13f, .25f), Olive);
            Module(c, Part.Cylinder, .16f, -.05f, new float3(.023f, .56f, .023f), SteelGrey);
            Module(c, Part.Dish, .16f, -.05f, new float3(.27f, .20f, .27f), new float3(.61f, .63f, .58f), 0, .54f);
            FieldBarricades(c);
        }

        void ArtilleryPosition(in Ctx c)
        {
            SupportFacility(c, 3);
            Module(c, Part.Siding, 0, .24f, new float3(.072f, .066f, .52f), Dark, 0, .19f);
            for (int k = -1; k <= 1; k += 2) Module(c, Part.Concrete, k * .32f, -.04f, new float3(.12f, .13f, .49f), new float3(.55f, .53f, .46f));
            Module(c, Part.Siding, -.29f, .31f, new float3(.14f, .10f, .12f), Olive);
        }
    }
}
