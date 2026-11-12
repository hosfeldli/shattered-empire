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
            if (!ActionRts || ringBuildingRevision == structures.Revision) return;
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
            for (int i = 0; i < 8; i++)
            {
                var p0 = nodes[(i + 7) % 8]; var p1 = nodes[i]; var p2 = nodes[(i + 1) % 8]; var p3 = nodes[(i + 2) % 8];
                var a = p1;
                for (int k = 1; k <= 8; k++)
                {
                    var b = Catmull(p0, p1, p2, p3, k / 8f);
                    CompoundStreet(a, b, CatmullSide(p0, p1, p2, p3, (k - 1) / 8f), CatmullSide(p0, p1, p2, p3, k / 8f), .235f, restored, k > 1 && k < 8); a = b;
                }
                var parcel = lots[i];
                bool occupied = structures.Buildings.Values.Any(b => b.City == site.Id && b.Slot == parcel.Id);
                if (!occupied) HistoricalBlock(parcel, site.Kind);
                // Service access from the inner loop stops at the facility frontage.
                var toward = math.normalizesafe(new float2(parcel.X, parcel.Z) - origin);
                var entrance = new float2(parcel.X, parcel.Z) - toward * .45f;
                CompoundStreet(p1, entrance, .155f, restored && parcel.Tier <= site.Tier);
            }
            // The command entrance is a pedestrian connection into the shared pavement.
            float2 front = new float2(math.sin(site.Parcels[0].Yaw), math.cos(site.Parcels[0].Yaw));
            var end = origin + front * .88f;
            var right = new float2(-front.y, front.x);
            RoadStrip(origin + front * .30f, end, right, right, -.035f, .035f, float.NegativeInfinity, .002f, new float3(.59f, .59f, .55f), SurfaceKind.Concrete);
            ComposeCityAccessories(site, lots);
        }

        // Replace the old hex-shaped streets near the compound. Every approach enters
        // through a gap between adjacent facilities, leaving their original parcels intact.
        bool ComposeRingApproaches(int tile)
        {
            var center = new float2(world.Grid.CenterX(tile), world.Grid.CenterZ(tile));
            ObjectiveSite site = default; float nearest = 3.7f * 3.7f;
            foreach (var s in objectiveByTile.Values)
            {
                if (!s.IsBase || s.Parcels == null || s.Parcels.Length < 9) continue;
                float d = math.distancesq(center, new float2(s.X, s.Z));
                if (d < nearest) { site = s; nearest = d; }
            }
            if (site.Id == 0) return false;
            var origin = new float2(site.X, site.Z);
            for (int d = 0; d < 6; d++)
            {
                int neighbor = world.Grid.Nb[tile * 6 + d];
                if (neighbor < 0 || world.RoadClass(tile, d) == 0 || world.RoadBroken(tile, d)) continue;
                var other = new float2(world.Grid.CenterX(neighbor), world.Grid.CenterZ(neighbor));
                float r0 = math.distance(center, origin), r1 = math.distance(other, origin);
                if (r0 < 2.6f && r1 < 2.6f) continue;
                if (r0 >= 2.6f && r1 >= 2.6f)
                {
                    var mid = RoadCurve.Mid(world, tile, d); var node = RoadCurve.Node(world, tile);
                    StreetRibbon(tile, mid, (mid + node) * .5f, node, world.RoadClass(tile, d), false, neighbor, -1);
                    continue;
                }
                if (r0 < r1) continue; // The outside tile owns the complete entrance.
                var bearing = math.normalizesafe(center - origin);
                var lots = site.Parcels.Where(p => p.Id > 0).OrderBy(p => p.Id).ToArray();
                float2 gap = origin; float best = -2;
                for (int k = 0; k < 8; k++)
                {
                    var a = new float2(lots[k].X, lots[k].Z);
                    var b = new float2(lots[(k + 1) % 8].X, lots[(k + 1) % 8].Z);
                    var dir = math.normalizesafe((a + b) * .5f - origin);
                    float score = math.dot(dir, bearing);
                    if (score > best) { best = score; gap = dir; }
                }
                var start = origin + gap * .97f;
                var control = origin + gap * 2.45f;
                var finish = RoadCurve.Node(world, tile);
                var from = start;
                for (int k = 1; k <= 20; k++)
                {
                    float t = k / 20f;
                    var to = (1 - t) * (1 - t) * start + 2 * (1 - t) * t * control + t * t * finish;
                    float t0 = (k - 1) / 20f;
                    var ta = math.normalizesafe(2 * (1 - t0) * (control - start) + 2 * t0 * (finish - control));
                    var tb = math.normalizesafe(2 * (1 - t) * (control - start) + 2 * t * (finish - control));
                    CompoundStreet(from, to, new float2(-ta.y, ta.x), new float2(-tb.y, tb.x), .235f, site.Headquarters != 0); from = to;
                }
            }
            return true;
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
                CompoundStreet(curb - side * .37f, curb + side * .37f, .13f, true);
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

        void FieldBarricades(in Ctx c)
        {
            for (int k = 0; k < 7; k++)
                Module(c, Part.Concrete, (k - 3) * .065f, .018f * math.sin(k), new float3(.060f, .065f + (k % 2) * .01f, .12f), new float3(.53f, .49f, .39f), (k % 2 == 0 ? .04f : -.04f));
            Module(c, Part.Wire, 0, -.11f, new float3(.42f, .12f, .12f), new float3(.84f, .82f, .77f));
            for (int side = -1; side <= 1; side += 2)
                Module(c, Part.TankObstacle, side * .19f, .15f, new float3(.14f), new float3(.90f, .88f, .80f), side * .24f);
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
