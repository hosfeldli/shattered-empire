using System.Collections.Generic;
using System.Linq;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        sealed class CompoundRoute
        {
            public float2[] Points;
            public float Width = .235f, EndWidth = .235f, EndPavement = .05f;
            public bool Closed, Pavement = true;
            public float3 EndColor = new float3(.286f, .288f, .296f);
        }

        static float2 Cubic(float2 a, float2 b, float2 c, float2 d, float t)
        { float u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; }

        List<CompoundRoute> BuildCompoundRoadNetwork(ObjectiveSite site, BaseParcel[] lots, float2[] nodes)
        {
            var result = new List<CompoundRoute>();
            var loop = new List<float2>(); var origin = new float2(site.X, site.Z);
            for (int i = 0; i < 8; i++) for (int k = 0; k < 20; k++)
                loop.Add(Catmull(nodes[(i + 7) % 8], nodes[i], nodes[(i + 1) % 8], nodes[(i + 2) % 8], k / 20f));
            loop.Add(loop[0]);
            result.Add(new CompoundRoute { Points = loop.ToArray(), Closed = true });
            for (int i = 0; i < 8; i++)
            {
                var front = new float2(math.sin(lots[i].Yaw), math.cos(lots[i].Yaw));
                var end = new float2(lots[i].X, lots[i].Z) + front * .43f;
                var points = new float2[12];
                for (int k = 0; k < points.Length; k++) points[k] = math.lerp(nodes[i], end, k / (float)(points.Length - 1));
                result.Add(new CompoundRoute { Points = points, Width = .155f, EndWidth = .155f, Pavement = false });
            }

            // Only authoritative road edges can produce entrances. Each continuation
            // terminates at the SAME edge portal as the outside half-street, with its
            // tangent and carriageway width. No independent decorative road stubs.
            var anchors = new Dictionary<int, List<(int tile, int direction)>>();
            var g = world.Grid; int row = site.Tile / g.W, column = site.Tile % g.W;
            for (int r = Mathf.Max(0, row - 3); r <= Mathf.Min(g.H - 1, row + 3); r++)
                for (int q0 = column - 4; q0 <= column + 4; q0++)
                {
                    int q = g.Wrap ? HexMath.PosMod(q0, g.W) : q0;
                    if (q < 0 || q >= g.W) continue;
                    int tile = r * g.W + q;
                    if (world.Known[tile] == 0 || math.distance(RoadCurve.Centre(world, tile), origin) < 2.6f) continue;
                    for (int d = 0; d < 6; d++)
                    {
                        int n = g.Nb[tile * 6 + d];
                        if (n < 0 || world.RoadClass(tile, d) == 0 || world.RoadClass(tile, d) == 4 || world.RoadBroken(tile, d)
                            || math.distance(RoadCurve.Centre(world, n), origin) >= 2.6f || RedundantEntrance(tile, d)) continue;
                        var bearing = math.normalizesafe(RoadCurve.Mid(world, tile, d) - origin);
                        int gap = 0; float best = -2;
                        for (int i = 0; i < 8; i++)
                        {
                            var between = loop[i * 20 + 10];
                            float score = math.dot(math.normalizesafe(between - origin), bearing);
                            if (score > best) { best = score; gap = i; }
                        }
                        if (!anchors.TryGetValue(gap, out var list)) anchors[gap] = list = new List<(int, int)>();
                        list.Add((tile, d));
                    }
                }
            foreach (var entry in anchors.OrderBy(a => a.Key))
            {
                var mouth = loop[entry.Key * 20 + 10];
                var radial = math.normalizesafe(mouth - origin);
                var hub = origin + radial * 2.43f;
                // Multiple highways using one gap share a single entrance trunk.
                if (entry.Value.Count > 1)
                {
                    var trunk = new float2[30];
                    for (int k = 0; k < trunk.Length; k++) trunk[k] = math.lerp(mouth, hub, k / (float)(trunk.Length - 1));
                    result.Add(new CompoundRoute { Points = trunk });
                }
                foreach (var anchor in entry.Value)
                {
                    var end = RoadCurve.Mid(world, anchor.tile, anchor.direction);
                    var outward = math.normalizesafe(RoadCurve.HalfControl(world, anchor.tile, anchor.direction, RoadCurve.Node(world, anchor.tile)) - end, radial);
                    var start = entry.Value.Count > 1 ? hub : mouth;
                    float reach = math.distance(start, end);
                    var a = start + radial * Mathf.Min(.65f, reach * .45f);
                    var b = end - outward * Mathf.Min(.5f, reach * .38f);
                    var points = new float2[48];
                    for (int k = 0; k < points.Length; k++) points[k] = Cubic(start, a, b, end, k / (float)(points.Length - 1));
                    int cls = world.RoadClass(anchor.tile, anchor.direction);
                    result.Add(new CompoundRoute { Points = points, EndWidth = RoadCurve.Width(cls),
                        EndPavement = Sidewalked(anchor.tile) && cls >= 2 ? .048f : 0,
                        EndColor = StreetColor(anchor.tile, -1, cls, false) });
                }
            }
            return result;
        }

        static bool EntranceEdge(WorldModel w, int tile, int d)
            => w.RoadClass(tile, d) != 0 && w.RoadClass(tile, d) != 4 && !w.RoadBroken(tile, d);

        float2 CompoundCentreAround(int tile)
        {
            var c = RoadCurve.Centre(world, tile);
            foreach (var s in objectiveByTile.Values)
                if (s.IsBase && s.Parcels != null && s.Parcels.Length >= 9 && math.distancesq(c, new float2(s.X, s.Z)) < 2.6f * 2.6f) return new float2(s.X, s.Z);
            return c;
        }

        /// <summary>
        /// One entrance per outside hex. The hex road graph often runs two parallel links from one hex into a
        /// compound; drawn literally they become two approach roads crossing in an X at that hex. Only the road
        /// edge nearest the base centre enters: the others get neither an approach nor a half-street.
        /// </summary>
        bool RedundantEntrance(int tile, int d)
        {
            if (!ActionRts || ComposeRingApproaches(tile) || !EntranceEdge(world, tile, d)) return false;
            int n = world.Grid.Nb[tile * 6 + d];
            if (n < 0 || !ComposeRingApproaches(n)) return false;
            int keep = -1; float best = float.MaxValue;
            for (int k = 0; k < 6; k++)
            {
                int m = world.Grid.Nb[tile * 6 + k];
                if (m < 0 || !EntranceEdge(world, tile, k) || !ComposeRingApproaches(m)) continue;
                float distance = math.distancesq(RoadCurve.Mid(world, tile, k), CompoundCentreAround(m));
                if (distance < best - 1e-6f) { best = distance; keep = k; }
            }
            return keep >= 0 && keep != d;
        }

        static float RouteHalf(CompoundRoute route, float sample)
            => .5f * math.lerp(route.Width, route.EndWidth, math.smoothstep(.25f, 1, sample / (route.Points.Length - 1)));

        static float2 RouteSide(CompoundRoute route, int sample)
        {
            int last = route.Points.Length - 1;
            int previous = sample == 0 ? route.Closed ? last - 1 : 0 : sample - 1;
            int next = sample == last ? route.Closed ? 1 : last : sample + 1;
            var tangent = math.normalizesafe(route.Points[next] - route.Points[previous], new float2(1, 0));
            return new float2(-tangent.y, tangent.x);
        }

        void CompoundBand(float2 a, float2 b, float2 sa, float2 sb, float fromA, float toA, float fromB, float toB, float lift, float3 color, SurfaceKind material)
        {
            streetGeometry.At(lift, material).Quad(StreetVertex(a + sa * math.max(fromA, toA), float.NegativeInfinity, lift),
                StreetVertex(a + sa * math.min(fromA, toA), float.NegativeInfinity, lift), StreetVertex(b + sb * math.min(fromB, toB), float.NegativeInfinity, lift),
                StreetVertex(b + sb * math.max(fromB, toB), float.NegativeInfinity, lift), new Color(color.x, color.y, color.z));
            streetQuads++;
        }

        void DrawCompoundRoadNetwork(List<CompoundRoute> routes, bool restored)
        {
            // A small spatial hash clips verges at REAL junction mouths. Sidewalks
            // follow the union's edge instead of continuing across an intersecting lane.
            const float cell = .35f;
            var buckets = new Dictionary<long, List<(int route, int segment)>>();
            long Key(int x, int z) => ((long)x << 32) ^ (uint)z;
            for (int r = 0; r < routes.Count; r++) for (int k = 0; k + 1 < routes[r].Points.Length; k++)
            {
                var route = routes[r]; var a = route.Points[k]; var b = route.Points[k + 1];
                float half = Mathf.Max(RouteHalf(route, k), RouteHalf(route, k + 1)) + .025f;
                int2 lo = (int2)math.floor((math.min(a, b) - half) / cell), hi = (int2)math.floor((math.max(a, b) + half) / cell);
                for (int x = lo.x; x <= hi.x; x++) for (int z = lo.y; z <= hi.y; z++)
                { long key = Key(x, z); if (!buckets.TryGetValue(key, out var list)) buckets[key] = list = new List<(int, int)>(); list.Add((r, k)); }
            }
            bool CrossesLane(float2 point, int own)
            {
                var key = (int2)math.floor(point / cell);
                if (!buckets.TryGetValue(Key(key.x, key.y), out var list)) return false;
                foreach (var segment in list)
                {
                    if (segment.route == own) continue;
                    var route = routes[segment.route]; var a = route.Points[segment.segment]; var delta = route.Points[segment.segment + 1] - a;
                    float t = math.saturate(math.dot(point - a, delta) / Mathf.Max(.000001f, math.lengthsq(delta)));
                    if (math.distance(point, a + delta * t) < RouteHalf(route, segment.segment + t) + .018f) return true;
                }
                return false;
            }
            for (int r = 0; r < routes.Count; r++)
            {
                var route = routes[r];
                for (int k = 0; k + 1 < route.Points.Length; k++)
                {
                    var a = route.Points[k]; var b = route.Points[k + 1]; var sa = RouteSide(route, k); var sb = RouteSide(route, k + 1);
                    float ha = RouteHalf(route, k), hb = RouteHalf(route, k + 1), t = (k + .5f) / (route.Points.Length - 1);
                    var color = math.lerp(new float3(.286f, .288f, .296f), route.EndColor, math.smoothstep(.3f, 1, t));
                    if (!restored) color = math.lerp(color, new float3(.36f, .35f, .31f), .30f);
                    CompoundBand(a, b, sa, sb, -ha, ha, -hb, hb, 0, color, SurfaceKind.Asphalt);
                    if (!route.Pavement) continue;
                    float pavement = math.lerp(.05f, route.EndPavement, math.smoothstep(.65f, 1, t));
                    if (pavement < .003f) continue;
                    for (int side = -1; side <= 1; side += 2)
                    {
                        var middle = (a + b + (sa * (ha + .025f) + sb * (hb + .025f)) * side) * .5f;
                        if (CrossesLane(middle, r)) continue;
                        CompoundBand(a, b, sa, sb, side * ha, side * (ha + pavement), side * hb, side * (hb + pavement), .0045f, new float3(.55f, .56f, .52f), SurfaceKind.Concrete);
                        CompoundBand(a, b, sa, sb, side * ha, side * (ha + .006f), side * hb, side * (hb + .006f), .0055f, new float3(.63f, .64f, .59f), SurfaceKind.Concrete);
                    }
                }
            }
        }
    }
}
