using System.Collections.Generic;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        /// <summary>
        /// The draped ground layers of a cell (streets, verges, kerbs, base plazas, pads, markings), kept per
        /// layer and emitted lowest first. SE/GroundOverlay draws them in that order (painter's order, pulled
        /// toward the camera along the view ray), so layers a few millimetres apart never z-fight however far
        /// the orthographic camera is, while the true surface depth is still written for everything drawn
        /// later. A layer is a lift above the road surface: quads with the same lift share a layer, and a
        /// higher lift always paints over a lower one.
        /// </summary>
        sealed class GroundLayers
        {
            public struct QuadRecord { public Vector3 A, B, C, D; public Color Color; public SurfaceKind Surface; }
            readonly SortedDictionary<int, List<QuadRecord>> layers = new SortedDictionary<int, List<QuadRecord>>();
            List<QuadRecord> current;
            int currentKey;
            SurfaceKind surface;
            /// <summary>While set, every quad is also copied here with its layer (the base compose cache, CityRenderer.BaseCache.cs).</summary>
            public List<(int layer, QuadRecord quad)> Tap;

            /// <summary>Select the layer for this lift (0.05 mm buckets) and the surface of the following quads.</summary>
            public GroundLayers At(float lift, SurfaceKind kind)
            {
                int key = Mathf.RoundToInt(lift * 20000f);
                if (!layers.TryGetValue(key, out current)) layers[key] = current = new List<QuadRecord>();
                currentKey = key;
                surface = kind;
                return this;
            }

            public void Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, Color color)
            {
                var q = new QuadRecord { A = a, B = b, C = c, D = d, Color = color, Surface = surface };
                current.Add(q);
                Tap?.Add((currentKey, q));
            }

            /// <summary>Append recorded quads to their layers (a cached base compose).</summary>
            public void Replay(List<(int layer, QuadRecord quad)> quads)
            {
                List<QuadRecord> list = null; int key = int.MinValue;
                foreach (var (layer, q) in quads)
                {
                    if (layer != key || list == null)
                    {
                        key = layer;
                        if (!layers.TryGetValue(key, out list)) layers[key] = list = new List<QuadRecord>();
                    }
                    list.Add(q);
                }
            }

            public Mesh Build(string name)
            {
                var builder = new MeshBuilder();
                foreach (var layer in layers.Values)
                    foreach (var q in layer) builder.Surface(q.Surface).Quad(q.A, q.B, q.C, q.D, q.Color);
                return builder.Build(name);
            }
        }

        static Material groundOverlay;
        static Material GroundOverlayMaterial
        {
            get
            {
                if (groundOverlay != null) return groundOverlay;
                var shader = Resources.Load<Shader>("Shaders/GroundOverlay");
                groundOverlay = shader != null && shader.isSupported ? new Material(shader) { name = "SE Ground overlay" } : RenderResources.Instanced;
                return groundOverlay;
            }
        }

        GroundLayers streetGeometry;
        int streetQuads;

        void BeginStreetMesh()
        {
            streetGeometry = new GroundLayers();
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
            cell.StreetBatch = new InstanceBatch(cell.Streets, GroundOverlayMaterial, 1)
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
            streetGeometry.At(lift, surface).Quad(
                StreetVertex(a + sideA * to, deck, lift), StreetVertex(a + sideA * from, deck, lift),
                StreetVertex(b + sideB * from, deck, lift), StreetVertex(b + sideB * to, deck, lift),
                new Color(color.x, color.y, color.z));
            streetQuads++;
        }

        /// <summary>
        /// A draped disc in one ground layer (a fan of thin wedges): junction mouths, turning circles and the
        /// verge or pavement under them, so half-streets meeting at an angle leave no notch or wedge.
        /// </summary>
        void GroundDisc(float2 c, float radius, float deck, float lift, float3 color, SurfaceKind surface)
        {
            int segs = Mathf.Clamp(Mathf.CeilToInt(radius * 2 * math.PI / .05f), 12, 40);
            for (int s = 0; s < segs; s++)
            {
                float ta = s * 2 * math.PI / segs, tb = (s + 1) * 2 * math.PI / segs;
                RoadStrip(c, c, new float2(math.sin(ta), math.cos(ta)), new float2(math.sin(tb), math.cos(tb)), 0, radius, deck, lift, color, surface);
            }
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

        /// <summary>Junction mouths of the hex being composed (x, z, radius): kerbs and painted lines stop there.</summary>
        readonly List<float3> streetClear = new List<float3>();

        bool Cleared(float2 p)
        {
            foreach (var c in streetClear) if (math.distancesq(p, c.xy) < c.z * c.z) return true;
            return false;
        }

        /// <summary>
        /// The ground of a junction or turning circle at <paramref name="at"/>, built from the same layers as
        /// the streets meeting there (gravel verge and shoulder on country roads, pavement in town, then the
        /// carriageway on top), so it fills the notches between half-streets meeting at an angle and their
        /// square ends, with no separate box to z-fight against the road surface.
        /// </summary>
        void JunctionPatch(int tile, float2 at, int cls, float radius, bool pavement)
        {
            var style = StyleOf(tile, cls);
            float deck = RoadCurve.Deck(world, tile, -1, -1);
            bool country = !world.IsUrban(tile) && style != StreetStyle.Service;
            var road = StreetColor(tile, -1, cls, false);
            if (!OverWater(at))
            {
                if (country) GroundDisc(at, radius * 1.42f, deck, -.003f, new float3(.50f, .47f, .40f), SurfaceKind.Soil);
                GroundDisc(at, radius * 1.12f, deck, -.002f,
                    style == StreetStyle.Rural ? new float3(.47f, .46f, .39f) : country ? new float3(.44f, .43f, .40f) : road * 1.10f,
                    style == StreetStyle.Rural || country ? SurfaceKind.Soil : SurfaceKind.Concrete);
                if (pavement) GroundDisc(at, radius + .046f, deck, -.0015f, new float3(.62f, .62f, .58f), SurfaceKind.Concrete);
            }
            // above the street surface and its wheel ruts, below the painted lines (which stop at the mouth)
            GroundDisc(at, radius, deck, .001f, road, style == StreetStyle.Rural ? SurfaceKind.Soil : SurfaceKind.Asphalt);
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
            bool country = !world.IsUrban(tile) && style != StreetStyle.Rail && style != StreetStyle.Service;
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
                    float wobble = Mathf.Sin((a.x + a.y) * 8 + tile) * .022f;
                    if (country)
                    {
                        // Roads across open land (the generated links between bases) sit in a dusty
                        // gravel verge that frays into the field, not on a kerbed concrete apron.
                        float verge = half * (1.46f + wobble * 2f);
                        RoadStrip(a, b, sa, sb, -verge, verge, deck, -.003f, new float3(.50f, .47f, .40f), SurfaceKind.Soil);
                    }
                    float shoulder = half * (1.14f + wobble);
                    RoadStrip(a, b, sa, sb, -shoulder, shoulder, deck, -.002f,
                        style == StreetStyle.Rural ? new float3(.47f, .46f, .39f) : country ? new float3(.44f, .43f, .40f) : road * 1.10f,
                        style == StreetStyle.Rural || country ? SurfaceKind.Soil : SurfaceKind.Concrete);
                }
                RoadStrip(a, b, sa, sb, -half, half, deck, 0, road, style == StreetStyle.Rural ? SurfaceKind.Soil : SurfaceKind.Asphalt);
                if (!span && style == StreetStyle.Rural)
                    for (int side = -1; side <= 1; side += 2)   // wheel ruts worn into the track
                        RoadStrip(a, b, sa, sb, side * half * .56f - half * .12f, side * half * .56f + half * .12f, deck, .0008f, road * .74f, SurfaceKind.Soil);
                // inside a junction mouth the kerbs, pavements and painted lines give way to the crossing street
                bool mouth = Cleared((a + b) * .5f);
                if (!span && !mouth && country && style != StreetStyle.Rural && cls >= 2)
                    for (int side = -1; side <= 1; side += 2)   // painted edge lines keep a country road crisp from above
                        RoadStrip(a, b, sa, sb, side * (half - .016f) - .003f, side * (half - .016f) + .003f, deck, .0012f, new float3(.80f, .79f, .72f), SurfaceKind.Plain);
                if (!mouth && cls >= 2 && style != StreetStyle.Service && style != StreetStyle.Rural && step % 4 < 2)
                    RoadStrip(a, b, sa, sb, -.002f, .002f, deck, .0012f, new float3(.71f, .70f, .62f), SurfaceKind.Plain);
                if (sidewalks && !span && !mouth)
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
                    // A bridge has visible structural depth, not a ground ribbon
                    // that happens to pass across the riverbed.
                    foreach (int side in new[] { -1, 1 })
                    {
                        var pa = a + sa * (half * side); var pb = b + sb * (half * side);
                        var bottomA = StreetVertex(pa, deck, -.028f); var topA = StreetVertex(pa, deck, -.001f);
                        var bottomB = StreetVertex(pb, deck, -.028f); var topB = StreetVertex(pb, deck, -.001f);
                        if (side < 0) streetGeometry.At(-.03f, SurfaceKind.Concrete).Quad(bottomA, bottomB, topB, topA, new Color(.45f, .46f, .43f));
                        else streetGeometry.At(-.03f, SurfaceKind.Concrete).Quad(bottomB, bottomA, topA, topB, new Color(.45f, .46f, .43f));
                        streetQuads++;
                    }
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
