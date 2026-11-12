using System;
using SE.Core.World;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Street geometry, shared by the street meshes and the traffic on them so cars sit exactly on the
    /// road. The server only says which hex edges carry a road; how a street runs inside a hex is ours:
    ///
    /// - every street crosses a hex edge at that edge's midpoint (so neighbours always join up);
    /// - in an open hex the streets meet at a junction placed off-centre (stable per hex), with gentle
    ///   bends, so a city's network meanders instead of drawing a hex lattice;
    /// - in a hex with a building the streets never cut through it: they wrap around the block along
    ///   the hex's edge, linking the road edges in order around the hex (leaving the widest gap open),
    ///   and a lone road edge stops at the kerb instead of laying a private driveway.
    ///
    /// A path through a hex (in edge → out edge) is a chain of up to six quadratic Bézier pieces.
    /// </summary>
    public static unsafe class RoadCurve
    {
        public const float Inradius = 0.8660254f;
        public const float BlockRadius = .64f;
        /// <summary>Hexes holding a building (kept current by the city renderer).</summary>
        public static bool[] Occupied = Array.Empty<bool>();
        public static bool Built(int t) => t >= 0 && t < Occupied.Length && Occupied[t];

        public static float Width(int cls) => cls == 1 ? .115f : cls == 2 ? .235f : cls == 3 ? .34f : .09f;

        static float H(int a, int b) => CityRenderer.Hash(a, b);

        public static float2 Centre(WorldModel w, int t) => new float2(w.Grid.CenterX(t), w.Grid.CenterZ(t));

        /// <summary>Where the street on edge d of hex t crosses the edge (in t's coordinates).</summary>
        public static float2 Mid(WorldModel w, int t, int d) => Centre(w, t) + new float2(HexMath.DirX[d], HexMath.DirZ[d]) * Inradius;
        public static float2 Portal(WorldModel w, int t, int d) => Centre(w, t) + new float2(HexMath.DirX[d], HexMath.DirZ[d]) * BlockRadius;
        public static float2 ArcControl(WorldModel w, int t, int a, int b) => Centre(w, t)
            + math.normalizesafe(new float2(HexMath.DirX[a] + HexMath.DirX[b], HexMath.DirZ[a] + HexMath.DirZ[b])) * (BlockRadius / .8660254f);

        /// <summary>
        /// Where a hex's streets meet. In an open hex: off-centre by a stable amount, so streets meander.
        /// In a hex with a building: pushed to the street side, so the streets pass along one side and
        /// the building keeps a whole parcel (no street ever runs through or round a block).
        /// </summary>
        public static float2 Node(WorldModel w, int t)
        {
            int* edges = stackalloc int[6];
            int count = Edges(w, t, edges);
            float2 control = JunctionControl(w, t);
            // De Casteljau midpoint: the two half-streets share exactly one tangent.
            if (count == 2) return (Mid(w, t, edges[0]) + Mid(w, t, edges[1])) * .25f + control * .5f;
            return control;
        }

        static float2 JunctionControl(WorldModel w, int t)
        {
            var center = Centre(w, t);
            if (!Built(t)) return center;
            Parcel(w, t, out var direction, out float room);
            return center - direction * Mathf.Lerp(.20f, .49f, room);
        }

        /// <summary>
        /// The parcel of a built hex: the direction of the widest side free of streets (unit vector, map
        /// x/z) and how wide that free side is (0–1, 1 = no streets at all). The building is composed
        /// there, facing the streets.
        /// </summary>
        public static void Parcel(WorldModel w, int t, out float2 dir, out float room)
        {
            int* e = stackalloc int[6];
            int n = Edges(w, t, e);
            if (n == 0) { float a = H(t, 503) * 6.2832f; dir = new float2(Mathf.Cos(a), Mathf.Sin(a)); room = 1f; return; }
            // the widest angular gap between consecutive road edges
            int bestGap = -1, from = 0;
            for (int i = 0; i < n; i++)
            {
                int gap = n == 1 ? 6 : ((e[(i + 1) % n] - e[i]) + 6) % 6;
                if (gap == 0) gap = 6;
                if (gap > bestGap) { bestGap = gap; from = e[i]; }
            }
            // its bisector (edge directions are d·60°, measured as (cos, −sin))
            float mid = (from + bestGap * 0.5f) * 60f * Mathf.Deg2Rad;
            dir = new float2(Mathf.Cos(mid), -Mathf.Sin(mid));
            room = Mathf.Clamp01((bestGap - 1) / 5f);
        }

        /// <summary>
        /// Control point of the half-street from edge d's midpoint to the junction: straight in from
        /// the edge (so it lines up with the neighbour's half), bending toward the off-centre junction.
        /// </summary>
        public static float2 HalfControl(WorldModel w, int t, int d, float2 node)
        {
            float2 m = Mid(w, t, d);
            int* edges = stackalloc int[6];
            if (Edges(w, t, edges) == 2) return (m + JunctionControl(w, t)) * .5f;
            return m - new float2(HexMath.DirX[d], HexMath.DirZ[d]) * (math.distance(m, node) * 0.5f);
        }

        /// <summary>Road edges of hex t (usable or not), in direction order.</summary>
        public static int Edges(WorldModel w, int t, int* outDirs)
        {
            int n = 0;
            for (int d = 0; d < 6; d++) if (w.RoadClass(t, d) != 0 && w.Grid.Nb[t * 6 + d] >= 0) outDirs[n++] = d;
            return n;
        }

        /// <summary>
        /// For a built hex: the order the streets are linked around the block. The chain starts after
        /// the widest gap between consecutive road edges and goes round from there.
        /// </summary>
        public static int Chain(WorldModel w, int t, int* chain)
        {
            int* e = stackalloc int[6];
            int n = Edges(w, t, e);
            if (n == 0) return 0;
            int bestGap = -1, start = 0;
            for (int i = 0; i < n; i++)
            {
                int gap = ((e[(i + 1) % n] - e[i]) + 6) % 6;
                if (n == 1) gap = 6;
                if (gap > bestGap) { bestGap = gap; start = (i + 1) % n; }
            }
            for (int i = 0; i < n; i++) chain[i] = e[(start + i) % n];
            return n;
        }

        /// <summary>The control point that carries a street from edge e round the block to edge f.</summary>
        public static float2 AroundControl(WorldModel w, int t, int e, int f)
        {
            int steps = ((f - e) + 6) % 6;
            if (steps == 0) steps = 6;
            float theta = steps * 60f * Mathf.Deg2Rad;
            float2 me = new float2(HexMath.DirX[e], HexMath.DirZ[e]), mf = new float2(HexMath.DirX[f], HexMath.DirZ[f]);
            // (opposite edges: no bisector; go round on the side the edge order turns toward)
            float2 bis = math.normalizesafe(me + mf, new float2(me.y, -me.x));
            // keep the curve's middle at about the edge-midpoint radius, hugging the hex boundary
            float avg = Inradius * Mathf.Cos(theta * 0.5f);
            float r = 2f * 0.84f - avg;
            // the inner-side bisector for steps > 3 would point the wrong way: walk round the other side
            if (steps > 3) bis = -bis;
            return Centre(w, t) + bis * r;
        }

        /// <summary>
        /// Bézier pieces of the path through hex t from edge a to edge b (b == a: a dead end, in and back).
        /// Returns the number of pieces written into p0/p1/p2 (at most 6).
        /// </summary>
        public static int Pieces(WorldModel w, int t, int a, int b, float2* p0, float2* p1, float2* p2)
        {
            if (Built(t))
            {
                var pa = Portal(w, t, a); var pb = Portal(w, t, b);
                p0[0] = Mid(w, t, a); p1[0] = (p0[0] + pa) * .5f; p2[0] = pa;
                int count = 1;
                if (a != b)
                {
                    int* chain = stackalloc int[6]; int n = Chain(w, t, chain), ia = 0, ib = 0;
                    for (int j = 0; j < n; j++) { if (chain[j] == a) ia = j; if (chain[j] == b) ib = j; }
                    int step = ib > ia ? 1 : -1, edge = a;
                    for (int j = 0; edge != b && j < 5; j++)
                    {
                        int next = (edge + step + 6) % 6;
                        p0[count] = Portal(w, t, edge); p1[count] = ArcControl(w, t, edge, next); p2[count] = Portal(w, t, next);
                        count++; edge = next;
                    }
                }
                p0[count] = pb; p1[count] = (pb + Mid(w, t, b)) * .5f; p2[count] = Mid(w, t, b);
                return count + 1;
            }
            // two half-streets meeting at the junction, each leaving its edge square-on; in a built hex the
            // junction sits on the street side, clear of the building's parcel (b == a: in and back out)
            float2 ma = Mid(w, t, a), mb = Mid(w, t, b);
            float2 node = Node(w, t);
            p0[0] = ma; p1[0] = HalfControl(w, t, a, node); p2[0] = node;
            p0[1] = node; p1[1] = HalfControl(w, t, b, node); p2[1] = mb;
            return 2;
        }

        public static float2 Bezier(float2 a, float2 c, float2 b, float s, out float2 tangent)
        {
            float u = 1f - s;
            tangent = 2f * u * (c - a) + 2f * s * (b - c);
            return u * u * a + 2f * u * s * c + s * s * b;
        }

        /// <summary>A point at fraction s of the path through hex t from edge a to edge b, and its heading.</summary>
        public static void Route(WorldModel w, int t, int a, int b, float s, out float x, out float z, out float yaw)
        {
            float2* p0 = stackalloc float2[8]; float2* p1 = stackalloc float2[8]; float2* p2 = stackalloc float2[8];
            int n = Pieces(w, t, a, b, p0, p1, p2);
            s = Mathf.Clamp01(s) * n;
            int i = Math.Min(n - 1, (int)s);
            var p = Bezier(p0[i], p1[i], p2[i], s - i, out var tan);
            x = p.x; z = p.y;
            yaw = math.lengthsq(tan) > 1e-8f ? Mathf.Atan2(tan.x, tan.y) : 0f;
        }

        /// <summary>Approximate length of the path through hex t from edge a to edge b.</summary>
        public static float Length(WorldModel w, int t, int a, int b)
        {
            float2* p0 = stackalloc float2[8]; float2* p1 = stackalloc float2[8]; float2* p2 = stackalloc float2[8];
            int n = Pieces(w, t, a, b, p0, p1, p2);
            float len = 0;
            for (int i = 0; i < n; i++) len += (math.distance(p0[i], p1[i]) + math.distance(p1[i], p2[i]) + math.distance(p0[i], p2[i])) * 0.5f;
            return Mathf.Max(0.05f, len);
        }

        public static bool IsWet(WorldModel w, int t) => t >= 0 && (w.IsRiver(t) || w.View.Water[t] > -1e8f);

        /// <summary>Bridge deck height for a street piece in hex t that leaves by the edges toward na and nb, or -inf.</summary>
        public static float Deck(WorldModel w, int t, int na, int nb)
        {
            if (!IsWet(w, t) && !IsWet(w, na) && !IsWet(w, nb)) return float.NegativeInfinity;
            return Mathf.Max(DeckAt(w, t), Mathf.Max(DeckAt(w, na), DeckAt(w, nb)));
        }

        static float DeckAt(WorldModel w, int tile) => !IsWet(w, tile) ? float.NegativeInfinity
            : (w.View.Water[tile] > -1e8f ? w.View.Water[tile] : w.Height[tile] + WorldModel.RiverDepth) + .028f;

        /// <summary>Road surface height at (x, z): the ground across the road's width, or the bridge deck.</summary>
        public static float Height(WorldModel w, float deck, float x, float z)
        {
            var v = w.View;
            float y = Mathf.Max(v.GroundHeight(x, z), Mathf.Max(v.GroundHeight(x + 0.06f, z), v.GroundHeight(x - 0.06f, z)));
            return Mathf.Max(y, deck) + .006f;
        }
    }
}
