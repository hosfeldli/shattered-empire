using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    public sealed partial class IntroDirector
    {
        // An inherited city plan. Districts have different street grains and architectural
        // families; deterministic parcel variation finishes that plan, rather than replacing it.
        void BuildMetropolitanCity(int center)
        {
            var origin = new Vector2(g.CenterX(center), g.CenterZ(center));
            Vector2 P(float x, float z) => origin + new Vector2(x, z);
            var streets = new List<(Vector2[] points, int district)>();
            void Street(int district, params Vector2[] points) { streets.Add((points, district)); sceneRoads.Add(points); }
            Street(1, P(-28, -4), P(-18, -3), P(-10, -1), P(-2, 0), P(7, -1), P(14, -3), P(26, -5));
            Street(2, P(-23, -10), P(-14, -11), P(-5, -10.8f), P(4, -10), P(11, -8), P(16, -6));
            // Dense business core: short avenues and an asymmetric peak in the skyline.
            Street(0, P(-6, -6), P(-5.6f, -.5f), P(-4.7f, 4), P(-2, 8));
            Street(0, P(.8f, -9.8f), P(1.2f, -3), P(2, 2.7f), P(5, 6));
            Street(0, P(-8, -4), P(-2, -3.1f), P(4, -3.7f), P(8, -5));
            Street(0, P(-8, 3.3f), P(-2, 3.1f), P(4.5f, 2.2f), P(8, 1));
            Street(0, P(-6.3f, -7.2f), P(-1, -6.7f), P(5.7f, -7.3f));
            Street(0, P(-2.4f, -6.9f), P(-1.7f, -1.2f), P(-.6f, 3));
            // Older terraces follow the hillside, joining the same transport spine.
            Street(1, P(-20, -3), P(-17, 1), P(-13, 3.5f), P(-8, 3.3f));
            Street(1, P(-22, -3.4f), P(-20, 2.7f), P(-16, 6.4f), P(-10, 7), P(-4, 5.7f));
            Street(1, P(-16.5f, -2.6f), P(-14.5f, .8f), P(-11, 2.8f));
            Street(1, P(-20, 2.7f), P(-22, 6), P(-18, 10), P(-11, 11.2f), P(-6, 10));
            // Lower residential streets bend around a green valley below the wooded ridge.
            Street(3, P(-10, 7), P(-5, 8.8f), P(1, 8.4f), P(7, 7), P(12, 3));
            Street(3, P(-11, 11.2f), P(-4, 12.3f), P(2.5f, 11.4f), P(9, 10.8f), P(14, 7));
            Street(3, P(-2, 8.6f), P(-1.7f, 11), P(0, 14.8f));
            // Port and eastern works use larger parcels and shared service access.
            Street(2, P(-17, -3), P(-15, -7), P(-14, -11));
            Street(2, P(-9, -1.1f), P(-10, -6), P(-9, -10.9f));
            Street(2, P(10, -2), P(11.5f, 1), P(16, 2), P(22, 0), P(26, -5));
            Street(2, P(14, -3), P(17, -1), P(21, -2), P(24, -4.4f));
            Street(1, P(8, 1), P(10, 4), P(14, 7), P(20, 6), P(23, 2));
            var occupied = new List<Vector3>();
            for (int s = 0; s < streets.Count; s++)
            {
                var street = streets[s]; float spacing = street.district == 2 ? 1.65f : 1.03f;
                float remaining = .55f;
                for (int segment = 0; segment + 1 < street.points.Length; segment++)
                {
                    var p0 = street.points[Mathf.Max(0, segment - 1)]; var p1 = street.points[segment];
                    var p2 = street.points[segment + 1]; var p3 = street.points[Mathf.Min(street.points.Length - 1, segment + 2)];
                    var previous = p1;
                    for (int sample = 1; sample <= 48; sample++)
                    {
                        var at = CityCurve(p0, p1, p2, p3, sample / 48f);
                        remaining -= Vector2.Distance(previous, at);
                        if (remaining <= 0)
                        {
                            int seed = s * 193 + segment * 71 + sample;
                            var tangent = (at - previous).normalized; var normal = new Vector2(-tangent.y, tangent.x);
                            for (int side = -1; side <= 1; side += 2)
                            {
                                float variation = Mathf.Repeat(Mathf.Sin(seed * 91.73f + side * 13) * 43758.54f, 1);
                                float setback = street.district == 2 ? .97f : .62f + variation * .16f;
                                var point = at + normal * side * setback;
                                float radius = street.district == 2 ? .64f : .42f;
                                bool blocked = false;
                                foreach (var placed in occupied)
                                    if (Vector2.Distance(point, new Vector2(placed.x, placed.y)) < radius + placed.z + .08f) { blocked = true; break; }
                                if (blocked || NearOtherStreet(point, streets, s, radius + .17f)) continue;
                                int tile = g.TileAt(point.x, point.y);
                                if (tile < 0 || w.IsSea(tile) || w.IsLake(tile)) continue;
                                float downtown = Vector2.Distance(point, P(-1.5f, -1));
                                string type = street.district == 2 ? "cinematic_industrial" : street.district == 3 ? "cinematic_rowhouse"
                                    : downtown < 8 ? variation < .54f ? "modern_office" : "modern_block" : "cinematic_rowhouse";
                                int floors = type == "modern_office" ? Mathf.RoundToInt(Mathf.Lerp(11, 4, Mathf.Clamp01(downtown / 9)) + variation * 3)
                                    : type == "modern_block" ? 3 + (int)(variation * 4) : 1 + (int)(variation * 3);
                                var b = Building(tile, type, 0, floors, 2);
                                b.HasPosition = b.HasYaw = true; b.X = point.x; b.Z = point.y;
                                b.Yaw = Mathf.Atan2(-normal.x * side, -normal.y * side); b.Slot = b.Id;
                                city.Add(b); if (!cityTiles.Contains(tile)) cityTiles.Add(tile); SetUrban(tile, true);
                                occupied.Add(new Vector3(point.x, point.y, radius));
                            }
                            remaining += spacing * (.88f + Mathf.Repeat(Mathf.Sin(seed * 13.1f) * 713.1f, 1) * .28f);
                        }
                        previous = at;
                    }
                }
            }
            foreach (var point in new[] { P(5.7f, 4.5f), P(-18, 7.8f) })
            {
                int tile = g.TileAt(point.x, point.y); var b = Building(tile, "cinematic_civic", 0, 1, 2);
                b.HasPosition = b.HasYaw = true; b.X = point.x; b.Z = point.y; b.Yaw = .3f; b.Slot = b.Id;
                city.Add(b); cityTiles.Add(tile); SetUrban(tile, true);
            }
            attackTargets[0] = new float3(origin.x - 4, .35f, origin.y - 1.5f);
            attackTargets[1] = new float3(origin.x + 19, .35f, origin.y - 2);
            attackTargets[2] = new float3(origin.x - 13, .35f, origin.y + 5);
        }

        static Vector2 CityCurve(Vector2 a, Vector2 b, Vector2 c, Vector2 d, float t) =>
            .5f * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

        static bool NearOtherStreet(Vector2 point, List<(Vector2[] points, int district)> streets, int own, float clearance)
        {
            for (int s = 0; s < streets.Count; s++)
            {
                if (s == own) continue;
                var road = streets[s].points;
                for (int i = 0; i + 1 < road.Length; i++)
                {
                    var before = road[i];
                    for (int j = 1; j <= 8; j++)
                    {
                        var after = CityCurve(road[Mathf.Max(0, i - 1)], road[i], road[i + 1], road[Mathf.Min(road.Length - 1, i + 2)], j / 8f);
                        var delta = after - before; float along = Mathf.Clamp01(Vector2.Dot(point - before, delta) / Mathf.Max(.00001f, delta.sqrMagnitude));
                        if (Vector2.Distance(point, before + delta * along) < clearance) return true;
                        before = after;
                    }
                }
            }
            return false;
        }
    }
}
