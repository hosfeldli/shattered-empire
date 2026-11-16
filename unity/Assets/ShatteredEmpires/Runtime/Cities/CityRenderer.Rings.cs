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
                    for (int ring = 0; ring < 3 && !dirty.Contains(home); ring++)
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
                if (!pickups.TryGetValue(p.Id, out var old) || old.Memory != p.Memory || old.Amount != p.Amount)
                    dirty.Add(world.ChunkOf(p.Tile));
                pickups[p.Id] = p;
            }
            foreach (int id in pickups.Keys.Where(id => !next.Contains(id)).ToArray())
            { dirty.Add(world.ChunkOf(pickups[id].Tile)); pickups.Remove(id); }
        }

        void MaterialsPickup(in ResourcePickup pickup)
        {
            float dim = pickup.Memory ? .56f : 1;
            var c = new Ctx { X = pickup.X, Z = pickup.Z, Yaw = Hash(pickup.Id, 5) * 1.3f, Seed = pickup.Id,
                Tint = new float3(dim), Civ = new float3(.5f), FixedGround = true, GroundY = Ground(pickup.X, pickup.Z), Era = 1, Level = 1 };
            Module(c, Part.Siding, 0, 0, new float3(.25f, .018f, .19f), new float3(.46f, .40f, .29f));
            int count = pickup.Amount >= 100 ? 3 : 2;
            for (int i = 0; i < count; i++)
            {
                float x = i == 2 ? 0 : (i - .5f) * .112f, lift = i == 2 ? .10f : .02f;
                Module(c, Part.Siding, x, 0, new float3(.105f, .078f, .145f), new float3(.56f, .46f, .29f), 0, lift);
                Module(c, Part.Siding, x, .074f, new float3(.011f, .074f, .006f), new float3(.79f, .73f, .54f), 0, lift);
                Module(c, Part.Siding, x, -.074f, new float3(.011f, .074f, .006f), new float3(.79f, .73f, .54f), 0, lift);
                Module(c, Part.Siding, x, 0, new float3(.011f, .004f, .15f), new float3(.79f, .73f, .54f), 0, lift + .079f);
            }
        }

        void UpdateCityMaturation()
        {
            foreach (var site in objectiveByTile.Values)
            {
                int stage = Mathf.Clamp(Mathf.FloorToInt(site.Maturity / 5), 0, 7);
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

        void ComposeCityDistrict(ObjectiveSite site)
        {
            if (site.Parcels == null || site.Parcels.Length < 9) return;
            var lots = site.Parcels.Where(p => p.Id > 0).OrderBy(p => p.Id).ToArray();
            if (lots.Length != 8) return;
            var origin = new float2(site.X, site.Z);
            var nodes = lots.Select(p => origin + (new float2(p.X, p.Z) - origin) * .57f).ToArray();
            bool restored = site.Headquarters != 0;
            var network = BuildCompoundRoadNetwork(site, lots, nodes);
            // published for the road queries (trench crossings follow the roads actually drawn)
            RoadCurve.CompoundLanes[site.Id] = network.Select(r => new RoadCurve.Lane { Points = r.Points, Half = Mathf.Max(r.Width, r.EndWidth) * .5f }).ToArray();
            RoadCurve.LaneRevision++;
            DrawCompoundRoadNetwork(network, restored);
            ComposeBasePresentation(site, lots, nodes);
            for (int i = 0; i < 8; i++)
            {
                var parcel = lots[i];
                bool occupied = structures.Buildings.Values.Any(b => b.City == site.Id && b.Slot == parcel.Id);
                if (!occupied) HistoricalBlock(parcel, site.Kind);
            }
            // The command entrance is a pedestrian connection into the shared pavement.
            float2 front = new float2(math.sin(site.Parcels[0].Yaw), math.cos(site.Parcels[0].Yaw));
            var end = network[0].Points.OrderBy(p => math.distancesq(p, origin + front * 1.05f)).First() - front * .07f;
            var right = new float2(-front.y, front.x);
            RoadStrip(origin + front * .30f, end, right, right, -.035f, .035f, float.NegativeInfinity, .002f, new float3(.59f, .59f, .55f), SurfaceKind.Concrete);
            ComposeCityAccessories(site, lots);
        }

        // The complete compound graph is owned by its headquarters chunk. Outside
        // half-streets retain their original shared edge/tangent/width, so adjacent
        // chunks and bridges meet the compound at exactly the same portal.
        bool ComposeRingApproaches(int tile)
        {
            var center = new float2(world.Grid.CenterX(tile), world.Grid.CenterZ(tile));
            foreach (var s in objectiveByTile.Values)
            {
                if (!s.IsBase || s.Parcels == null || s.Parcels.Length < 9) continue;
                if (math.distancesq(center, new float2(s.X, s.Z)) < 2.6f * 2.6f) return true;
            }
            return false;
        }

        void ComposeCityAccessories(ObjectiveSite site, BaseParcel[] lots)
        {
            int established = Mathf.Max(site.VisualTier, site.Tier);
            float development = math.saturate(site.Maturity / 35f);
            int seed = DistrictPlanner.StableHash(Seed, site.Id, 2803);
            // A few inherited street fronts: compact blocks, shared setbacks and roof families.
            // Identity depends on the site and lot, never on the capturing faction.
            for (int i = 0; i < 7; i++)
            {
                var lot = lots[(i * 3 + 1) % 8];
                float2 radial = math.normalizesafe(new float2(lot.X - site.X, lot.Z - site.Z));
                float2 side = new float2(-radial.y, radial.x);
                var point = new float2(site.X, site.Z) + radial * (2.72f + Hash(seed, i) * .15f) + side * ((i % 2 == 0 ? -1 : 1) * .17f);
                int tile = world.Grid.TileAt(point.x, point.y);
                if (tile < 0 || world.Known[tile] == 0 || world.IsSea(tile) || world.IsLake(tile) || world.IsRiver(tile) || world.Biome[tile] >= 9) continue;
                bool overlaps = structures.Buildings.Values.Any(b => b.HasPosition && math.distance(point, new float2(b.X, b.Z)) < .84f);
                if (overlaps) continue;
                // nor on a road: the hex streets and compound entrances around the base keep a clear carriageway
                if (RoadCurve.RoadDistance(world, point, out _, out _) < .26f) continue;
                int threshold = i < 2 ? 1 : i < 4 ? 2 : 3;
                float progress = established < threshold ? 0 : established > threshold ? 1 : math.saturate((development - i * .045f) * 1.55f);
                var c = new Ctx { X = point.x, Z = point.y, Yaw = lot.Yaw, Seed = seed + i * 71, Tint = new float3(1), Civ = CivColor(site.Owner).xyz,
                    Era = 1, Level = 1, Tier = established, Kind = DistrictKind.Residential, Scale = .70f,
                    FixedGround = true, GroundY = BuildingDatum(point.x, point.y, lot.Yaw) };
                if (progress < .25f)
                {
                    Module(c, Part.Shell, 0, -.04f, new float3(.53f, .22f, .47f), new float3(.88f, .87f, .82f));
                    if (progress > 0) AccessoryScaffold(c, .30f);
                    continue;
                }
                var facility = structures.Buildings.Values.FirstOrDefault(b => b.City == site.Id && b.Slot == lot.Id);
                bool service = facility.Type == "depot" || facility.Type == "motor_works" || facility.Type == "heavy_weapons" || facility.Type == "power_plant";
                float height = (.20f + Hash(seed, i + 29) * .085f) * math.saturate(progress * 1.8f);
                var plaster = math.lerp(new float3(.69f, .67f, .60f), new float3(.61f, .64f, .62f), Hash(seed, i + 17));
                Module(c, service ? Part.Siding : Part.Brick, 0, -.06f, new float3(.57f, height, .44f), plaster);
                Facade(c, 0, -.06f, .57f, .44f, height, 0, c.Seed, service);
                if (progress < .85f) AccessoryScaffold(c, height + .06f);
                else
                {
                    Module(c, service ? Part.MetalRoof : Part.Roof, 0, -.06f, new float3(.60f, service ? .035f : .105f, .47f),
                        new float3(.36f, .38f, .35f), 0, height);
                    Module(c, Part.Tree, -.42f, .14f, new float3(.17f, .24f, .17f), new float3(.43f, .51f, .37f), Hash(seed, i + 70) * 6f);
                    if (established >= 2 && Hash(seed, i + 90) > .40f) Parked(c, .26f, .31f, math.PI * .5f, c.Seed, false);
                }
                // Small connected service frontage, with no independent economic or collision record.
                var curb = point + radial * -.35f;
                DrapeParcel(curb, lot.Yaw, .57f, .11f, new float3(.51f, .52f, .49f), SurfaceKind.Concrete);
            }
        }

        void AccessoryScaffold(in Ctx c, float height)
        {
            for (int side = -1; side <= 1; side += 2)
            {
                for (int j = -1; j <= 1; j++) Module(c, Part.Cylinder, j * .31f, side * .26f - .06f, new float3(.009f, height, .009f), SteelGrey);
                for (int k = 1; k <= 2; k++) Module(c, Part.Siding, 0, side * .26f - .06f, new float3(.64f, .014f, .045f), SteelGrey, 0, k * height * .45f);
            }
        }

        void HeavyWeaponsFacility(in Ctx c)
        {
            Arsenal(c);
            Module(c, Part.Crane, .33f, -.35f, new float3(.27f, .36f, .27f), Hazard, -.18f);
            Module(c, Part.Concrete, -.37f, -.30f, new float3(.26f, .18f, .30f), new float3(.56f, .58f, .53f));
            for (int k = 0; k < 3; k++) Module(c, Part.Cylinder, -.43f + k * .065f, -.28f, new float3(.041f, .17f, .041f), Olive, 0, .18f);
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
