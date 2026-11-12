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
            float width = office ? .62f : .55f, depth = office ? .48f : .46f;
            float height = .32f + Mathf.Clamp(c.Level, 1, 7) * .13f;
            var wall = math.lerp(new float3(.64f, .63f, .57f), new float3(.73f, .72f, .66f), Hash(c.Seed, 12));
            var frame = new float3(.41f, .45f, .45f);
            if (ruined)
            {
                Module(c, Part.Broken, -.12f, -.09f, new float3(width * .66f, height * .75f, depth * .83f), new float3(.89f));
                Module(c, Part.Collapse, .16f, .12f, new float3(width * .90f, height * .23f, depth * .83f), new float3(.82f));
                Module(c, Part.Shell, .20f, -.10f, new float3(width * .31f, height * .29f, depth * .9f), new float3(.86f));
                if (overgrown)
                {
                    Module(c, Part.Tree, -.33f, .19f, new float3(.21f, .34f, .21f), new float3(.42f, .51f, .35f));
                    Module(c, Part.Tree, .29f, -.19f, new float3(.16f, .27f, .16f), new float3(.46f, .54f, .40f));
                }
                return;
            }
            Module(c, office ? Part.Concrete : Part.Brick, 0, 0, new float3(width, height, depth), wall);
            for (int side = 0; side < 4; side++)
                Facade(c, 0, 0, side % 2 == 0 ? width : depth, side % 2 == 0 ? depth : width, height, side * math.PI * .5f, c.Seed + side * 17, office);
            Module(c, Part.Siding, 0, 0, new float3(width + .022f, .021f, depth + .022f), frame, 0, height);
            Module(c, Part.Concrete, -.13f, -.08f, new float3(.24f, .11f, .22f), wall * .91f, 0, height + .02f);
            Module(c, Part.Siding, -.13f, -.08f, new float3(.26f, .018f, .24f), frame, 0, height + .13f);
            RoofPlant(c, .13f, -.05f, height + .035f, 2);
            Module(c, Part.Siding, 0, depth * .54f, new float3(width * .43f, .018f, .09f), frame, 0, .13f);
            for (int i = -1; i <= 1; i += 2) Module(c, Part.Concrete, i * (width * .5f + .012f), 0, new float3(.023f, height, depth + .02f), wall * 1.06f);
        }
    }
}
