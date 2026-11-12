using SE.Core.Protocol;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        float BuildingDatum(float x, float z, float yaw)
        {
            float top = Ground(x, z);
            math.sincos(yaw, out float sn, out float cs);
            for (int i = 0; i < 4; i++)
            {
                float a = (i % 2 == 0 ? -.47f : .47f), b = (i < 2 ? -.47f : .47f);
                top = Mathf.Max(top, Ground(x + a * cs + b * sn, z - a * sn + b * cs));
            }
            return top - .006f;
        }

        void Foundation(in Ctx c, float x, float z, float width, float depth)
        {
            float scale = S(c);
            math.sincos(c.Yaw, out float sn, out float cs);
            float px = c.X + (x * cs + z * sn) * scale, pz = c.Z + (-x * sn + z * cs) * scale;
            float bottom = Ground(px, pz);
            for (int i = 0; i < 4; i++)
            {
                float a = (i % 2 == 0 ? -.5f : .5f) * width * scale;
                float b = (i < 2 ? -.5f : .5f) * depth * scale;
                bottom = Mathf.Min(bottom, Ground(px + a * cs + b * sn, pz - a * sn + b * cs));
            }
            bottom -= .025f;
            Put(Part.Concrete, new float3(px, bottom, pz), c.Yaw,
                new float3(width * scale + .012f, Mathf.Max(.025f, c.GroundY - bottom + .009f), depth * scale + .012f),
                new float3(.55f, .55f, .51f) * c.Tint);
        }

        void HistoricalBlock(in BaseParcel parcel, string kind)
        {
            int seed = DistrictPlanner.StableHash(Seed, parcel.Id, 731);
            var c = new Ctx { X = parcel.X, Z = parcel.Z, Yaw = parcel.Yaw, Seed = seed,
                Tint = new float3(1), Civ = new float3(.5f), Era = 1, Level = 1,
                Kind = DistrictKind.Industrial, FixedGround = true, GroundY = Ground(parcel.X, parcel.Z) - .01f };
            if (HistoricalFacility(c, parcel.PreviousType)) return;
            bool industrial = kind == "industrial" || kind == "military" || kind == "coastal";
            float width = industrial ? .68f : .49f;
            Module(c, Part.Shell, -.12f, -.22f, new float3(width, industrial ? .29f : .23f, .47f), new float3(.89f, .88f, .83f));
            Module(c, Part.Collapse, .22f, .18f, new float3(.39f, .16f, .32f), new float3(.88f), .08f);
            if (!industrial && Hash(seed, 5) > .46f)
                Module(c, Part.Shell, .29f, -.21f, new float3(.28f, .18f, .37f), new float3(.85f, .88f, .82f));
            if (industrial && Hash(seed, 6) > .5f)
                Module(c, Part.MetalRoof, -.20f, -.34f, new float3(.32f, .033f, .22f), new float3(.46f, .49f, .47f), 0, .23f);
            if (Hash(seed, 11) < .40f)
                Module(c, Part.Tree, -.49f, .34f, new float3(.15f, .19f, .15f), new float3(.49f, .56f, .42f), Hash(seed, 12) * 6f);
        }

        bool HistoricalFacility(in Ctx c, string type)
        {
            if (string.IsNullOrEmpty(type)) return false;
            var concrete = new float3(.83f, .83f, .77f);
            var charred = new float3(.39f, .41f, .37f);
            switch (type)
            {
                case "power_plant":
                    Module(c, Part.Shell, -.20f, -.19f, new float3(.47f, .25f, .36f), concrete);
                    for (int k = 0; k < 3; k++)
                    {
                        Module(c, Part.Cylinder, .18f + k * .11f, -.20f, new float3(.082f, .19f - k * .035f, .082f), charred);
                        Module(c, Part.Siding, .18f + k * .11f, -.20f, new float3(.10f, .027f, .10f), charred, .22f * k, .16f - k * .03f);
                    }
                    Module(c, Part.Collapse, .14f, .21f, new float3(.44f, .13f, .31f), concrete * .85f);
                    break;
                case "motor_works": case "heavy_weapons": case "depot":
                    Module(c, Part.Shell, -.07f, -.14f, new float3(.73f, .31f, .48f), concrete);
                    Module(c, Part.MetalRoof, -.24f, -.29f, new float3(.32f, .06f, .32f), charred, -.08f, .27f);
                    Module(c, Part.Collapse, .22f, .18f, new float3(.43f, .18f, .32f), concrete * .83f);
                    if (type == "heavy_weapons") Module(c, Part.Crane, .40f, -.31f, new float3(.21f, .27f, .21f), charred, .64f);
                    break;
                case "airfield":
                    Module(c, Part.Shell, -.29f, -.26f, new float3(.35f, .22f, .32f), concrete);
                    Module(c, Part.Shell, .14f, -.26f, new float3(.33f, .16f, .31f), concrete * .84f);
                    for (int k = 0; k < 3; k++) Module(c, Part.Asphalt, -.30f + k * .31f, .20f, new float3(.27f, .004f, .22f), charred, (k - 1) * .025f);
                    Module(c, Part.Broken, .42f, -.30f, new float3(.15f, .30f, .17f), concrete * .88f);
                    break;
                case "advanced_lab": case "armory": case "missile_silo":
                    Module(c, Part.Broken, -.22f, -.21f, new float3(.35f, type == "advanced_lab" ? .50f : .31f, .38f), concrete);
                    Module(c, Part.Shell, .27f, -.18f, new float3(.35f, .22f, .42f), concrete * .91f);
                    Module(c, Part.Collapse, .06f, .27f, new float3(.54f, .15f, .28f), concrete * .82f);
                    if (type == "missile_silo") Module(c, Part.Dome, .11f, .09f, new float3(.30f, .04f, .30f), charred);
                    break;
                default: return false;
            }
            return true;
        }

        void ActionLandscaping(int tile)
        {
            if (ActionRts && objectiveByTile.Count > 0) return; // Shared ring pavements replace per-building paths.
            if (!(Districts.BuildingAt(tile) is BuildingRecord building) || !building.HasPosition) return;
            math.sincos(building.Yaw, out float sn, out float cs);
            // A short entrance path joins the actual frontage street. No lawn plates
            // or repeated formal parks are added between unrelated facilities.
            float2 center = new float2(building.X, building.Z), forward = new float2(sn, cs);
            var entrance = building.Type == "town" ? new float2(0, .08f)
                : building.Type == "barracks" ? new float2(-.19f, .035f)
                : building.Type == "depot" ? new float2(.36f, .30f) : new float2(0, .30f);
            var from = center + new float2(entrance.x * cs + entrance.y * sn, -entrance.x * sn + entrance.y * cs);
            int* edges = stackalloc int[6]; int n = RoadCurve.Edges(world, tile, edges);
            if (n > 0)
            {
                var to = RoadCurve.Portal(world, tile, edges[0]);
                for (int i = 1; i < n; i++)
                { var candidate = RoadCurve.Portal(world, tile, edges[i]); if (math.distancesq(candidate, from) < math.distancesq(to, from)) to = candidate; }
                var direction = math.normalizesafe(to - from, forward); var side = new float2(-direction.y, direction.x);
                if (math.dot(to - from, forward) >= 0)
                    RoadStrip(from, to, side, side, -.015f, .015f, float.NegativeInfinity, .0005f, new float3(.58f, .58f, .54f), Rendering.SurfaceKind.Concrete);
            }
            if (building.Type != "town" && building.Type != "advanced_lab") return;
            for (int i = 0; i < 2; i++)
            {
                float lx = i == 0 ? -.54f : .51f, lz = i == 0 ? -.43f : .38f;
                var p = center + new float2(lx * cs + lz * sn, -lx * sn + lz * cs);
                if (OverWater(p)) continue;
                Put(Part.Tree, new float3(p.x, Ground(p.x, p.y), p.y), i * 2.3f,
                    new float3(.16f, .23f, .17f), new float3(.48f, .56f, .42f));
            }
        }

        void MilitaryBarracks(in Ctx c)
        {
            var wall = new float3(.69f, .68f, .61f);
            var roof = new float3(.39f, .43f, .42f);
            Module(c, Part.Concrete, -.19f, -.22f, new float3(.56f, .27f, .43f), wall);
            Module(c, Part.MetalRoof, -.19f, -.22f, new float3(.59f, .065f, .46f), roof, 0, .27f);
            Facade(c, -.19f, -.22f, .56f, .43f, .27f, 0, c.Seed);
            Module(c, Part.Brick, .29f, .04f, new float3(.35f, .15f, .57f), new float3(.62f, .59f, .51f));
            Module(c, Part.MetalRoof, .29f, .04f, new float3(.38f, .045f, .59f), roof, 1.5708f, .15f);
            Facade(c, .29f, .04f, .35f, .57f, .15f, 0, c.Seed + 7);
            Module(c, Part.Asphalt, -.16f, .24f, new float3(.43f, .004f, .24f), new float3(.42f, .44f, .41f));
            Module(c, Part.Siding, -.20f, -.32f, new float3(.15f, .04f, .11f), roof * 1.16f, 0, .30f);
            for (int side = -1; side <= 1; side += 2)
                Module(c, Part.Concrete, side * .49f, -.11f, new float3(.012f, .067f, .86f), wall * .85f);
            Module(c, Part.Concrete, -.20f, -.53f, new float3(.60f, .065f, .013f), wall * .85f);
            Flag(c, -.42f, .37f, .40f);
            Parked(c, .13f, .43f, 1.5708f, c.Seed + 19, true);
        }

        void SupplyCenter(in Ctx c)
        {
            var concrete = new float3(.68f, .68f, .63f);
            var roof = new float3(.43f, .48f, .49f);
            Module(c, Part.Concrete, -.07f, -.17f, new float3(.77f, .25f, .58f), concrete);
            Module(c, Part.MetalRoof, -.07f, -.17f, new float3(.80f, .067f, .61f), roof, 0, .25f);
            Module(c, Part.Concrete, -.09f, .19f, new float3(.70f, .027f, .14f), concrete * .86f);
            for (int bay = 0; bay < 3; bay++)
            {
                float x = -.32f + bay * .24f;
                Module(c, Part.Siding, x, .126f, new float3(.16f, .18f, .012f), roof * .78f, 0, .027f);
                Module(c, Part.Concrete, x, .137f, new float3(.18f, .014f, .025f), concrete * .90f, 0, .21f);
                Module(c, Part.Box, x, .134f, new float3(.028f, .021f, .015f), c.Civ, 0, .221f);
            }
            Module(c, Part.Brick, .36f, .16f, new float3(.22f, .14f, .27f), new float3(.66f, .62f, .54f));
            Module(c, Part.Siding, .36f, .16f, new float3(.24f, .017f, .29f), roof, 0, .14f);
            Facade(c, .36f, .16f, .22f, .27f, .14f, 0, c.Seed);
            Module(c, Part.Asphalt, -.12f, .40f, new float3(.52f, .004f, .24f), new float3(.40f, .42f, .40f));
            for (int k = 0; k < 2; k++)
                Module(c, Part.Siding, -.40f + k * .20f, -.53f, new float3(.17f, .07f, .10f),
                    math.lerp(new float3(.40f, .46f, .45f), new float3(.52f, .49f, .39f), Hash(c.Seed, k + 15)));
            Parked(c, -.16f, .39f, 0, c.Seed + 18, true);
        }
    }
}
