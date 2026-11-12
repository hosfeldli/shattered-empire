using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        public bool ActionRts;
        public float SimulationTime;
        readonly Dictionary<int, ObjectiveSite> objectiveByTile = new Dictionary<int, ObjectiveSite>();
        readonly HashSet<int> objectiveTiles = new HashSet<int>();
        readonly Dictionary<int, (BaseParcel parcel, string kind)> historicalParcels = new Dictionary<int, (BaseParcel, string)>();
        int parcelEpoch = -1;

        public void SetObjectives(IEnumerable<ObjectiveSite> sites)
        {
            if (parcelEpoch != world.Epoch)
            {
                parcelEpoch = world.Epoch;
                historicalParcels.Clear();
                objectiveByTile.Clear();
                pickups.Clear(); maturityStages.Clear();
            }
            objectiveTiles.Clear();
            foreach (var s in sites)
            {
                if (s.Tile < 0 || s.Tile >= world.Grid.N) continue;
                objectiveTiles.Add(s.Tile);
                if (!objectiveByTile.TryGetValue(s.Tile, out var old) || old.Owner != s.Owner || old.Tier != s.Tier || old.DevelopedAt != s.DevelopedAt ||
                    old.Headquarters != s.Headquarters || old.Operational != s.Operational || old.Memory != s.Memory || old.Slots?.Length != s.Slots?.Length)
                    dirty.Add(world.ChunkOf(s.Tile));
                objectiveByTile[s.Tile] = s;
                if (s.Parcels != null) foreach (var p in s.Parcels)
                {
                    if (p.Id == 0 || p.Tile < 0 || p.Tile >= world.Grid.N) continue;
                    if (!historicalParcels.TryGetValue(p.Id, out var previous) || previous.parcel.PreviousType != p.PreviousType)
                    { dirty.Add(world.ChunkOf(p.Tile)); dirty.Add(world.ChunkOf(s.Tile)); }
                    historicalParcels[p.Id] = (p, s.Kind);
                }
            }
            scratchObjectives.Clear();
            foreach (int tile in objectiveByTile.Keys) if (!objectiveTiles.Contains(tile)) scratchObjectives.Add(tile);
            foreach (int tile in scratchObjectives)
            {
                objectiveByTile.Remove(tile);
                if (tile >= 0 && tile < world.Grid.N) dirty.Add(world.ChunkOf(tile));
            }
            UpdateCityMaturation();
        }
        readonly List<int> scratchObjectives = new List<int>();

        void ActionRuin(in ObjectiveSite site)
        {
            int seed = DistrictPlanner.StableHash(Seed, site.Tile, 47);
            float angle = Hash(seed, 5) * 6.283f;
            if (site.Parcels != null) foreach (var parcel in site.Parcels)
                if (parcel.Tile == site.Tile) { angle = parcel.Yaw; break; }
            float tint = site.Memory ? .69f : 1f;
            var c = new Ctx
            {
                X = site.X, Z = site.Z, Yaw = angle, Seed = seed, Tint = new float3(tint), Civ = CivColor(site.Owner).xyz,
                Era = 1, Level = 1, Kind = DistrictKind.Civic,
            };
            if (!site.IsBase)
            {
                float3 rust = new float3(.51f, .41f, .32f), concrete = new float3(.59f, .56f, .50f);
                Module(c, Part.Concrete, 0, -.12f, new float3(.45f, .037f, .32f), concrete);
                switch (site.Kind)
                {
                    case "radar":
                        var mast = c; mast.Scale = .46f; LatticeMast(mast);
                        break;
                    case "energy":
                        Module(c, Part.Concrete, -.26f, -.17f, new float3(.31f, .22f, .34f), concrete);
                        Module(c, Part.MetalRoof, -.26f, -.17f, new float3(.34f, .035f, .36f), new float3(.37f, .42f, .40f), 0, .22f);
                        Facade(c, -.26f, -.17f, .31f, .34f, .22f, 0, seed, true);
                        for (int i = 0; i < 3; i++)
                        {
                            float z = -.25f + i * .19f;
                            Module(c, Part.Siding, .15f, z, new float3(.24f, .14f, .14f), new float3(.47f, .52f, .48f));
                            for (int j = -1; j <= 1; j += 2)
                            {
                                Module(c, Part.Cylinder, .15f + j * .07f, z, new float3(.025f, .14f, .025f), new float3(.49f, .34f, .26f), 0, .14f);
                                Module(c, Part.Cylinder, .15f + j * .07f, z, new float3(.041f, .012f, .041f), new float3(.65f, .56f, .43f), 0, .23f);
                            }
                        }
                        Module(c, Part.Siding, .15f, -.06f, new float3(.15f, .012f, .59f), SteelGrey, 0, .29f);
                        Module(c, Part.Shell, -.16f, .32f, new float3(.27f, .16f, .21f), new float3(.86f));
                        break;
                    case "defense": Defence(c, "bunker"); break;
                    default:
                        Module(c, Part.Broken, .11f, -.12f, new float3(.22f, .19f, .20f), concrete);
                        Module(c, Part.Siding, -.15f, .06f, new float3(.17f, .071f, .09f), rust, .2f);
                        break;
                }
                if (site.Owner >= 0) Flag(c, .30f, .24f, .42f);
                return;
            }
            var stone = new float3(.59f, .55f, .49f);
            var gray = new float3(.42f, .45f, .43f);
            // Keep a clear forecourt inside the capture boundary. The surviving shells frame it.
            Module(c, Part.Shell, 0, -.50f, new float3(.65f, .34f, .43f), new float3(.93f));
            Module(c, Part.Concrete, 0, -.27f, new float3(.29f, .031f, .11f), stone * .85f);
            for (int k = 0; k < 3; k++)
            {
                float x = (Hash(seed, k * 7) - .5f) * 1.35f, z = -.38f - Hash(seed, k * 7 + 1) * .36f;
                float w = .055f + Hash(seed, 13 + k) * .09f;
                ModuleRot(c, Part.Concrete, x, z, new float3(w, .033f, w * .76f), stone * (.68f + Hash(seed, 20 + k) * .26f),
                    Hash(seed, 35 + k) * .50f, Hash(seed, 45 + k) * .39f, Hash(seed, 53 + k) * 6f);
            }
            switch (site.Kind)
            {
                case "metro":
                    Module(c, Part.Broken, -.61f, -.28f, new float3(.34f, .85f, .36f), new float3(.91f));
                    Module(c, Part.Broken, .58f, -.37f, new float3(.35f, .56f, .34f), new float3(.86f));
                    Module(c, Part.Collapse, .60f, .27f, new float3(.39f, .30f, .39f), new float3(.89f), .08f);
                    break;
                case "industrial":
                    Module(c, Part.Silo, .60f, -.35f, new float3(.26f, .38f, .26f), gray);
                    Module(c, Part.Chimney, .66f, -.52f, new float3(.07f, .73f, .07f), stone * .75f);
                    Module(c, Part.Shell, -.58f, -.17f, new float3(.36f, .29f, .47f), new float3(.91f, .88f, .84f));
                    break;
                case "coastal":
                    Module(c, Part.Crane, .61f, -.30f, new float3(.51f, .43f, .51f), gray, .75f);
                    for (int k = 0; k < 3; k++)
                        Module(c, Part.Siding, -.55f, -.44f + k * .16f, new float3(.26f, .08f, .10f), Container(seed + 17 * k), .2f * k);
                    break;
                case "military":
                    Module(c, Part.Concrete, -.57f, -.29f, new float3(.31f, .14f, .37f), gray, .17f);
                    Module(c, Part.Shell, .55f, -.32f, new float3(.29f, .21f, .34f), new float3(.87f));
                    break;
                case "research":
                    Module(c, Part.Shell, -.58f, -.28f, new float3(.36f, .29f, .28f), new float3(.93f));
                    Module(c, Part.Dome, .56f, -.35f, new float3(.24f, .14f, .24f), gray, .1f, .10f);
                    break;
                default:
                    Module(c, Part.Shell, -.48f, -.18f, new float3(.27f, .21f, .28f), new float3(.89f));
                    Module(c, Part.Shell, .48f, -.24f, new float3(.27f, .20f, .28f), new float3(.94f));
                    break;
            }
            Module(c, Part.Car, .46f, .34f, new float3(.14f), gray * .72f, 2.1f);
            if (site.Owner >= 0) Flag(c, -.31f, .37f, .52f);
        }

        void MilitaryTierEquipment(in Ctx c, string type)
        {
            var steel = new float3(.40f, .44f, .43f);
            var concrete = Concrete(c.Seed);
            if (type == "town") return;
            if (type == "power_plant")
            {
                Module(c, Part.Concrete, -.42f, .31f, new float3(.26f, .09f, .20f), concrete);
                for (int k = 0; k < 3; k++)
                {
                    Module(c, Part.Cylinder, -.51f + k * .08f, .30f, new float3(.025f, .12f, .025f), steel, 0, .09f);
                    Module(c, Part.Cylinder, -.51f + k * .08f, .30f, new float3(.048f, .015f, .048f), new float3(.57f, .41f, .31f), 0, .18f);
                }
            }
            else if (type == "barracks" || type == "armory" || type == "defense_works")
            {
                Module(c, Part.Concrete, -.38f, -.32f, new float3(.18f, .20f, .21f), concrete * .78f);
                Module(c, Part.Siding, -.38f, -.32f, new float3(.19f, .032f, .22f), steel, 0, .20f);
                Module(c, Part.Cylinder, -.38f, -.32f, new float3(.009f, .25f, .009f), steel, 0, .23f);
                if (c.Tier >= 3) Module(c, Part.Dome, -.38f, -.32f, new float3(.09f, .06f, .09f), new float3(.65f, .68f, .64f), 0, .23f);
            }
            else if (type == "motor_works" || type == "depot")
            {
                Module(c, Part.Siding, -.47f, -.38f, new float3(.13f, .19f, .25f), steel);
                Module(c, Part.Cylinder, -.47f, -.38f, new float3(.017f, .08f, .017f), steel * .8f, 0, .19f);
                Module(c, Part.Concrete, -.44f, .32f, new float3(.16f, .09f, .24f), concrete * .84f);
                if (c.Tier >= 3) Module(c, Part.Crane, -.38f, .38f, new float3(.28f, .24f, .28f), new float3(.81f, .64f, .31f), -.4f);
            }
            else if (type == "airfield")
            {
                Module(c, Part.Cylinder, -.48f, .41f, new float3(.05f, .13f, .05f), concrete);
                Module(c, Part.Cylinder, -.48f, .41f, new float3(.012f, .32f, .012f), steel, 0, .13f);
                Module(c, Part.Box, -.48f, .41f, new float3(.06f, .012f, .05f), c.Civ, 0, .43f, .2f);
            }
        }

        void Headquarters(in Ctx c)
        {
            var stone = new float3(.76f, .72f, .64f);
            var roof = new float3(.38f, .45f, .43f);
            var concrete = new float3(.56f, .57f, .53f);
            float h = .29f;
            Module(c, Part.Concrete, 0, -.27f, new float3(.86f, h, .43f), stone);
            Module(c, Part.MetalRoof, 0, -.27f, new float3(.90f, .091f, .47f), roof, 0, h);
            Facade(c, 0, -.27f, .86f, .43f, h, 0, c.Seed);
            Facade(c, 0, -.27f, .86f, .43f, h, math.PI, c.Seed + 11);
            Facade(c, 0, -.27f, .43f, .86f, h, math.PI * .5f, c.Seed + 23);
            Facade(c, 0, -.27f, .43f, .86f, h, -math.PI * .5f, c.Seed + 37);
            Module(c, Part.Concrete, 0, -.048f, new float3(.31f, .037f, .17f), concrete);
            Module(c, Part.Siding, 0, .006f, new float3(.27f, .022f, .105f), Olive, 0, .159f);
            for (int i = -1; i <= 1; i += 2)
            {
                Module(c, Part.Concrete, i * .114f, .031f, new float3(.024f, .15f, .026f), stone, 0, .029f);
                Module(c, Part.Siding, i * .48f, -.21f, new float3(.16f, .099f, .23f), Olive, i * .14f);
                Module(c, Part.Cylinder, i * .31f, -.42f, new float3(.018f, .19f, .018f), SteelGrey, 0, h);
                Flag(c, i * .28f, .26f, .48f);
            }
            Module(c, Part.Shell, -.45f, -.47f, new float3(.22f, .19f, .17f), new float3(.84f));
            Module(c, Part.Asphalt, .23f, .36f, new float3(.33f, .012f, .22f), new float3(.34f, .36f, .34f), -.11f);
            Parked(c, .16f, .34f, 2.25f, c.Seed, true);
            if (c.Tier < 2) return;
            Module(c, Part.Concrete, .48f, -.38f, new float3(.28f, .24f, .32f), concrete);
            Module(c, Part.Siding, .48f, -.38f, new float3(.29f, .035f, .33f), roof, 0, .24f);
            Module(c, Part.Glass, .48f, -.216f, new float3(.19f, .087f, .016f), new float3(.37f, .52f, .58f), 0, .115f);
            Module(c, Part.Cylinder, .56f, -.47f, new float3(.028f, .51f, .028f), SteelGrey, 0, .20f);
            if (c.Tier < 3) return;
            Module(c, Part.Concrete, -.38f, -.30f, new float3(.26f, .66f, .25f), stone * .83f);
            Module(c, Part.Glass, -.38f, -.17f, new float3(.23f, .13f, .033f), new float3(.43f, .60f, .67f), 0, .50f);
            Module(c, Part.Siding, -.38f, -.30f, new float3(.29f, .026f, .28f), roof, 0, .65f);
            Facade(c, -.38f, -.30f, .26f, .25f, .66f, 0, c.Seed + 101);
            Facade(c, -.38f, -.30f, .26f, .25f, .66f, math.PI, c.Seed + 119);
            Module(c, Part.Dish, -.38f, -.30f, new float3(.14f, .11f, .14f), stone * .92f, .4f, .70f);
            for (int i = 0; i < 3; i++) Module(c, Part.Siding, -.38f, -.432f, new float3(.27f, .012f, .012f), roof, 0, .18f + i * .20f);
        }

        void SupportFacility(in Ctx c, int kind)
        {
            var concrete = new float3(.67f, .65f, .59f);
            var metal = new float3(.45f, .49f, .47f);
            if (kind == 3)
            {
                Module(c, Part.Cylinder, 0, 0, new float3(.36f, .13f, .36f), concrete * .82f);
                Module(c, Part.Cylinder, 0, 0, new float3(.24f, .12f, .24f), Olive, 0, .12f);
                Module(c, Part.Siding, 0, .14f, new float3(.047f, .045f, .27f), Dark, 0, .206f);
                return;
            }
            if (kind == 4)
            {
                Module(c, Part.Asphalt, 0, .06f, new float3(.58f, .013f, .42f), metal * .72f);
                Module(c, Part.Siding, -.15f, -.09f, new float3(.21f, .12f, .21f), Olive);
                Module(c, Part.Crane, .18f, -.14f, new float3(.29f, .28f, .29f), Hazard, -.8f);
                return;
            }
            float width = kind == 2 ? .83f : .67f;
            float height = kind == 2 ? .32f : .21f;
            Module(c, Part.Concrete, -.09f, -.21f, new float3(width, height, .42f), concrete);
            Module(c, Part.Siding, -.09f, -.21f, new float3(width + .027f, .025f, .44f), metal, 0, height);
            Facade(c, -.09f, -.21f, width, .42f, height, 0, c.Seed, kind == 2);
            Module(c, Part.Asphalt, -.05f, .21f, new float3(.61f, .011f, .36f), new float3(.38f, .39f, .37f));
            if (kind == 2)
            {
                Module(c, Part.Glass, -.12f, -.21f, new float3(.38f, .042f, .25f), new float3(.47f, .65f, .72f), 0, height + .026f);
                Module(c, Part.Dome, .36f, -.34f, new float3(.22f, .15f, .22f), concrete, 0, .18f);
            }
            else if (kind == 1)
            {
                Module(c, Part.Crane, .37f, .16f, new float3(.36f, .42f, .36f), Hazard, 1.13f);
                for (int k = 0; k < 4; k++) Module(c, Part.Siding, -.3f + k * .14f, .31f, new float3(.12f, .055f, .07f), Container(c.Seed + k));
            }
            else
            {
                Module(c, Part.Siding, -.12f, .016f, new float3(.19f, .141f, .025f), Olive);
                Module(c, Part.Cylinder, .32f, -.32f, new float3(.021f, .36f, .021f), metal);
            }
        }
    }
}
