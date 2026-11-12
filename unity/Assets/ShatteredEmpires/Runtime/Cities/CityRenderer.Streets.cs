using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        MeshBuilder streetGeometry;
        int streetQuads;

        void BeginStreetMesh()
        {
            streetGeometry = new MeshBuilder();
            streetQuads = 0;
        }

        void FinishStreetMesh(Cell cell)
        {
            cell.StreetBatch?.Dispose();
            cell.StreetBatch = null;
            if (cell.Streets != null) Object.Destroy(cell.Streets);
            cell.Streets = null;
            if (streetQuads == 0) return;
            cell.Streets = streetGeometry.Build("Continuous streets and pavements");
            cell.StreetBatch = new InstanceBatch(cell.Streets, RenderResources.Instanced, 1)
            { Bounds = cell.Streets.bounds, Shadows = ShadowCastingMode.Off };
            cell.StreetBatch.Add(InstanceData.TRS(float3.zero, 0, new float3(1), new float4(1, 1, 1, 0)));
            bmin = math.min(bmin, (float3)cell.Streets.bounds.min);
            bmax = math.max(bmax, (float3)cell.Streets.bounds.max);
            cell.Any = true;
        }

        Vector3 StreetVertex(float2 point, float deck, float lift)
            => MapSpace.W(new float3(point.x, RoadCurve.Height(world, deck, point.x, point.y) + lift, point.y));

        void RoadStrip(float2 a, float2 b, float2 sideA, float2 sideB, float from, float to,
            float deck, float lift, float3 color, SurfaceKind surface)
        {
            streetGeometry.Surface(surface).Quad(
                StreetVertex(a + sideA * to, deck, lift), StreetVertex(a + sideA * from, deck, lift),
                StreetVertex(b + sideB * from, deck, lift), StreetVertex(b + sideB * to, deck, lift),
                new Color(color.x, color.y, color.z));
            streetQuads++;
        }

        bool OverWater(float2 point)
        {
            int tile = world.Grid.TileAt(point.x, point.y);
            if (tile < 0) return false;
            if (world.View.Water[tile] > Ground(point.x, point.y) + .006f) return true;
            if (!world.IsRiver(tile)) return false;
            return math.distance(point, RoadCurve.Centre(world, tile)) < .32f;
        }

        void DrapeParcel(float2 center, float yaw, float width, float depth, float3 color, SurfaceKind surface)
        {
            math.sincos(yaw, out float sn, out float cs);
            var forward = new float2(sn, cs); var left = new float2(-cs, sn);
            for (int row = 0; row < 4; row++)
            {
                var a = center + forward * (depth * (row / 4f - .5f));
                var b = center + forward * (depth * ((row + 1) / 4f - .5f));
                RoadStrip(a, b, left, left, -width * .5f, width * .5f, float.NegativeInfinity, -.002f, color, surface);
            }
        }

        // A single welded ribbon follows the same curves as traffic. Its cross-section
        // samples the terrain; a road on a slope is no longer a staircase of floating boxes.
        void StreetRibbon(int tile, float2 start, float2 control, float2 end, int cls, bool broken, int na, int nb)
        {
            const int samples = 12;
            var style = StyleOf(tile, cls);
            float half = RoadCurve.Width(cls) * .5f;
            float deck = RoadCurve.Deck(world, tile, na, nb);
            var road = StreetColor(tile, -1, cls, broken);
            bool sidewalks = Sidewalked(tile) && cls >= 2 && style != StreetStyle.Rail;
            var curb = new float3(.59f, .60f, .57f);
            var pavement = new float3(.62f, .62f, .58f);
            for (int step = 0; step < samples; step++)
            {
                float u0 = step / (float)samples, u1 = (step + 1) / (float)samples;
                var a = RoadCurve.Bezier(start, control, end, u0, out var ta);
                var b = RoadCurve.Bezier(start, control, end, u1, out var tb);
                ta = math.normalizesafe(ta, end - start); tb = math.normalizesafe(tb, end - start);
                var sa = new float2(-ta.y, ta.x); var sb = new float2(-tb.y, tb.x);
                bool span = OverWater((a + b) * .5f);
                if (broken && step >= 4 && step <= 7) continue;
                if (style == StreetStyle.Rail)
                {
                    RoadStrip(a, b, sa, sb, -half * 1.20f, half * 1.20f, deck, 0, new float3(.43f, .42f, .39f), SurfaceKind.Concrete);
                    RoadStrip(a, b, sa, sb, -half * .48f, -half * .35f, deck, .008f, new float3(.49f), SurfaceKind.Armor);
                    RoadStrip(a, b, sa, sb, half * .35f, half * .48f, deck, .008f, new float3(.49f), SurfaceKind.Armor);
                    if (step % 2 == 0)
                        RoadStrip(a, math.lerp(a, b, .18f), sa, sb, -half, half, deck, .003f, new float3(.36f, .32f, .27f), SurfaceKind.Plain);
                    continue;
                }
                if (!span)
                {
                    float shoulder = half * (1.14f + Mathf.Sin((a.x + a.y) * 8 + tile) * .022f);
                    RoadStrip(a, b, sa, sb, -shoulder, shoulder, deck, -.002f,
                        style == StreetStyle.Rural ? new float3(.47f, .46f, .39f) : road * 1.10f,
                        style == StreetStyle.Rural ? SurfaceKind.Soil : SurfaceKind.Concrete);
                }
                RoadStrip(a, b, sa, sb, -half, half, deck, 0, road, style == StreetStyle.Rural ? SurfaceKind.Soil : SurfaceKind.Asphalt);
                if (cls >= 2 && style != StreetStyle.Service && style != StreetStyle.Rural && step % 4 < 2)
                    RoadStrip(a, b, sa, sb, -.002f, .002f, deck, .0012f, new float3(.71f, .70f, .62f), SurfaceKind.Plain);
                if (sidewalks && !span)
                    for (int side = -1; side <= 1; side += 2)
                    {
                        float lo = side < 0 ? -half - .012f : half;
                        RoadStrip(a, b, sa, sb, lo, lo + .012f, deck, .006f, curb, SurfaceKind.Concrete);
                        lo = side < 0 ? -half - .048f : half + .012f;
                        RoadStrip(a, b, sa, sb, lo, lo + .036f, deck, .005f, pavement, SurfaceKind.Concrete);
                        if (step % 3 == 1)
                            RoadStrip(a, math.lerp(a, b, .018f), sa, sa, lo, lo + .036f, deck, .0055f, pavement * .82f, SurfaceKind.Plain);
                    }
                if (span)
                {
                    // A crossing has one slim deck, parapets and occasional piers.
                    // Dry approaches retain a normal grounded road cross-section.
                    for (int side = -1; side <= 1; side += 2)
                    {
                        float edge = side * (half + .008f);
                        RoadStrip(a, b, sa, sb, edge - .004f, edge + .004f, deck, .024f, curb * .9f, SurfaceKind.Concrete);
                    }
                    if (step % 5 == 2)
                    {
                        var point = (a + b) * .5f;
                        float ground = Ground(point.x, point.y) - .015f;
                        float top = RoadCurve.Height(world, deck, point.x, point.y);
                        Put(Part.Concrete, new float3(point.x, ground, point.y), Mathf.Atan2(ta.x, ta.y),
                            new float3(half * .7f, Mathf.Max(.01f, top - ground), .025f), curb * .83f);
                    }
                }
            }
        }
    }
}
