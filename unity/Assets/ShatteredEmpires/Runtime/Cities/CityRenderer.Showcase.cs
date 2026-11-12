using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        readonly List<float2[]> showcaseRoads = new List<float2[]>();
        float showcaseDamage;
        bool Showcase => showcaseRoads.Count > 0;
        public void SetShowcaseRoads(IEnumerable<Vector2[]> roads)
        {
            showcaseRoads.Clear(); showcaseDamage = 0;
            if (roads != null) foreach (var road in roads)
            {
                var points = new float2[road.Length];
                for (int i = 0; i < points.Length; i++) points[i] = new float2(road[i].x, road[i].y);
                showcaseRoads.Add(points);
            }
            foreach (int cell in cells.Keys) dirty.Add(cell);
        }
        public void SetShowcaseDamage(float damage)
        { showcaseDamage = damage; foreach (int cell in cells.Keys) dirty.Add(cell); }

        void ComposeShowcaseStreets(int cellId)
        {
            foreach (var road in showcaseRoads) for (int i = 0; i + 1 < road.Length; i++)
            {
                bool closed = math.distancesq(road[0], road[road.Length - 1]) < .0001f;
                int count = road.Length - 1;
                var p0 = road[closed ? (i - 1 + count) % count : Mathf.Max(0, i - 1)]; var p1 = road[i]; var p2 = road[i + 1]; var p3 = road[closed ? (i + 2) % count : Mathf.Min(road.Length - 1, i + 2)];
                var from = p1;
                for (int k = 1; k <= 16; k++)
                {
                    var to = Catmull(p0, p1, p2, p3, k / 16f);
                    var mid = (from + to) * .5f; int tile = world.Grid.TileAt(mid.x, mid.y);
                    if (tile >= 0 && world.ChunkOf(tile) == cellId)
                    {
                        bool broken = showcaseDamage > .5f && (i * 17 + k) % 19 >= 16;
                        if (!broken) CompoundStreet(from, to, CatmullSide(p0, p1, p2, p3, (k - 1) / 16f), CatmullSide(p0, p1, p2, p3, k / 16f), road.Length == 2 ? .155f : .27f, showcaseDamage < .5f);
                    }
                    from = to;
                }
            }
        }

        void ModernBlock(in Ctx c, bool office, bool ruined, bool overgrown)
        {
            float width = (office ? .57f : .53f) + Hash(c.Seed, 7) * .12f, depth = .40f + Hash(c.Seed, 8) * .15f;
            float height = .28f + Mathf.Clamp(c.Level, 1, 13) * (office ? .17f : .12f);
            var wall = office ? math.lerp(new float3(.48f, .55f, .58f), new float3(.72f, .71f, .66f), Hash(c.Seed, 12))
                : math.lerp(new float3(.52f, .38f, .29f), new float3(.74f, .70f, .59f), Hash(c.Seed, 12));
            var frame = new float3(.41f, .45f, .45f);
            if (ruined)
            {
                float remnant = .30f + Hash(c.Seed, 27) * .53f;
                Module(c, Part.Broken, -.12f, -.09f, new float3(width * .66f, height * remnant, depth * .83f), new float3(.89f), (Hash(c.Seed, 28) - .5f) * .17f);
                Module(c, Part.Collapse, .16f, .12f, new float3(width * .90f, height * .23f, depth * .83f), new float3(.82f), Hash(c.Seed, 29) * 1.7f);
                Module(c, Part.Shell, .20f, -.10f, new float3(width * .31f, height * (.20f + Hash(c.Seed, 30) * .40f), depth * .9f), new float3(.86f));
                if (overgrown)
                {
                    Module(c, Part.Tree, -.33f, .19f, new float3(.21f, .34f, .21f), new float3(.42f, .51f, .35f));
                    Module(c, Part.Tree, .29f, -.19f, new float3(.16f, .27f, .16f), new float3(.46f, .54f, .40f));
                }
                return;
            }
            bool setback = office && c.Level >= 7;
            if (setback)
            {
                float podium = height * .25f;
                Module(c, Part.Concrete, 0, 0, new float3(width, podium, depth), wall);
                Module(c, Part.Concrete, -.045f, -.03f, new float3(width * .77f, height - podium, depth * .75f), wall * .92f, 0, podium);
                for (int floor = 0; floor < c.Level; floor++)
                {
                    float y = podium + floor * (height - podium) / c.Level;
                    Module(c, Part.Glass, -.045f, -.03f + depth * .38f, new float3(width * .71f, .058f, .012f), new float3(.36f, .48f, .54f), 0, y);
                    Module(c, Part.Glass, -.045f + width * .39f, -.03f, new float3(.012f, .058f, depth * .69f), new float3(.33f, .45f, .51f), 0, y);
                }
            }
            else Module(c, office ? Part.Concrete : Part.Brick, 0, 0, new float3(width, height, depth), wall);
            for (int side = 0; side < 4; side++)
                Facade(c, 0, 0, side % 2 == 0 ? width : depth, side % 2 == 0 ? depth : width, setback ? height * .25f : height, side * math.PI * .5f, c.Seed + side * 17, office);
            Module(c, Part.Siding, setback ? -.045f : 0, setback ? -.03f : 0, new float3(width * (setback ? .80f : 1) + .022f, .021f, depth * (setback ? .78f : 1) + .022f), frame, 0, height);
            Module(c, Part.Concrete, -.13f, -.08f, new float3(.24f, .11f, .22f), wall * .91f, 0, height + .02f);
            Module(c, Part.Siding, -.13f, -.08f, new float3(.26f, .018f, .24f), frame, 0, height + .13f);
            RoofPlant(c, .13f, -.05f, height + .035f, 2);
            Module(c, Part.Siding, 0, depth * .54f, new float3(width * .43f, .018f, .09f), frame, 0, .13f);
            if (!setback) for (int i = -1; i <= 1; i += 2) Module(c, Part.Concrete, i * (width * .5f + .012f), 0, new float3(.023f, height, depth + .02f), wall * 1.06f);
            if (setback && Hash(c.Seed, 6) > .45f)
                Module(c, Part.Cylinder, -.12f, -.08f, new float3(.012f, .28f + Hash(c.Seed, 4) * .19f, .012f), frame, 0, height + .15f);
        }

        void CinematicDistrictBuilding(in Ctx c, string type, bool ruined, bool overgrown)
        {
            bool industrial = type == "cinematic_industrial", civic = type == "cinematic_civic";
            float width = industrial ? .95f : civic ? .83f : .64f;
            float depth = industrial ? .73f : .50f;
            float height = industrial ? .25f + Hash(c.Seed, 21) * .16f : civic ? .44f : .18f + c.Level * .065f;
            var wall = civic ? new float3(.75f, .71f, .61f) : industrial ? new float3(.56f, .55f, .50f)
                : math.lerp(new float3(.56f, .37f, .27f), new float3(.78f, .72f, .60f), Hash(c.Seed, 12));
            var roof = math.lerp(new float3(.27f, .30f, .32f), new float3(.43f, .30f, .22f), Hash(c.Seed, 7));
            if (ruined)
            {
                Module(c, Part.Shell, -.14f, -.08f, new float3(width * .64f, height * (.48f + Hash(c.Seed, 14) * .43f), depth), new float3(.88f));
                Module(c, Part.Collapse, .18f, .11f, new float3(width * .76f, height * .46f, depth * .79f), new float3(.84f), Hash(c.Seed, 15) * 2);
                if (industrial && c.Level == 3) Module(c, Part.Chimney, -.34f, -.27f, new float3(.065f, .58f, .065f), wall * .73f);
                if (overgrown) Module(c, Part.Tree, .25f, -.13f, new float3(.20f, .29f, .20f), new float3(.45f, .53f, .38f));
                return;
            }
            if (!industrial && !civic)
            {
                // Narrow joined terraces: pitched roofs, chimneys and real entrances.
                for (int i = 0; i < 3; i++)
                {
                    float x = (i - 1) * .22f, h = height + Hash(c.Seed, i + 30) * .05f;
                    Module(c, Part.Brick, x, 0, new float3(.214f, h, depth), wall * (.95f + i * .035f));
                    Module(c, Part.Roof, x, 0, new float3(.224f, .10f, depth + .035f), roof, 1.5708f, h);
                    Module(c, Part.Siding, x - .055f, depth * .51f, new float3(.044f, .10f, .012f), roof, 0, .01f);
                    Module(c, Part.Glass, x + .047f, depth * .51f, new float3(.065f, .052f, .012f), new float3(.40f, .47f, .48f), 0, .08f);
                    if (c.Level >= 2) Module(c, Part.Glass, x, depth * .51f, new float3(.12f, .043f, .012f), new float3(.41f, .48f, .49f), 0, h - .08f);
                    Module(c, Part.Chimney, x + .055f, -.12f, new float3(.027f, .13f, .040f), wall * .76f, 0, h + .04f);
                }
                return;
            }
            Module(c, civic ? Part.Concrete : Part.Siding, 0, 0, new float3(width, height, depth), wall);
            if (civic)
            {
                Module(c, Part.Roof, 0, 0, new float3(width + .07f, .14f, depth + .06f), roof, 0, height);
                Module(c, Part.Concrete, 0, .35f, new float3(.63f, .03f, .23f), wall * .85f);
                for (int i = 0; i < 5; i++) Module(c, Part.Cylinder, -.30f + i * .15f, .30f, new float3(.028f, height * .81f, .028f), wall * 1.06f, 0, .03f);
                Module(c, Part.Glass, 0, depth * .51f, new float3(.18f, .24f, .012f), new float3(.30f, .39f, .42f));
            }
            else
            {
                int bays = c.Level == 1 ? 2 : 3;
                for (int bay = 0; bay < bays; bay++)
                {
                    float x = (bay - (bays - 1) * .5f) * .30f;
                    Module(c, Part.MetalRoof, x, 0, new float3(.31f, .065f, depth + .025f), roof, 0, height);
                    Module(c, Part.Siding, x, depth * .51f, new float3(.21f, height * .62f, .012f), roof * .83f);
                    Module(c, Part.Glass, x, depth * .52f, new float3(.23f, .04f, .015f), new float3(.43f, .51f, .52f), 0, height - .075f);
                }
                if (c.Level == 3)
                {
                    Module(c, Part.Chimney, -.34f, -.27f, new float3(.065f, .82f, .065f), wall * .78f);
                    Module(c, Part.Cylinder, .32f, -.24f, new float3(.18f, .24f, .18f), wall * .91f, 0, height);
                }
                else if (c.Level == 2)
                    Module(c, Part.Crane, .34f, .20f, new float3(.32f, .49f, .32f), new float3(.72f, .61f, .36f), .12f);
            }
        }
    }
}
