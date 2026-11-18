using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Halo Wars / Grey Goo style base presentation (2026-11-16 mockup), on top of the compound roads
    /// (RoadConnections) and the terrain apron (TerritoryField + SE/Terrain):
    ///
    /// - one round concrete foundation holds the whole base, with a kerb and a darker skirt at its edge;
    /// - the round headquarters hub (Base_town) stands in the middle on a plaza: a dark collar, a team ring and
    ///   lamps; the dark ring road around it is the hub ring of the mockup;
    /// - every socket is a rounded square pad on the foundation, docked to the hub: a lit docking arm runs from
    ///   a gate in the HQ drum to the ring road (chevrons point out to the socket) and a concrete causeway runs
    ///   on to the pad's threshold, where the building's front (doors, bays) faces the hub;
    /// - a painted identity glyph on each causeway says which building it is (rank chevrons for barracks, crate for
    ///   materials, bolt for energy, bars for vehicles, crosshair for heavy weapons…);
    /// - open sockets show a dashed team outline, corner lamps and a build cross; locked sockets (next tier) are
    ///   faint pads with one dot per tier they need;
    /// - tier reads in the world: tier 2 adds barrier blocks behind every socket, HQ radomes and a beacon;
    ///   tier 3 raises T-wall runs with a team band and watch towers, plaza flags and the HQ crown.
    /// Unclaimed compounds (no headquarters) keep only their ruins and roads.
    ///
    /// All ground pieces go into the street mesh's ground layers (<see cref="GroundLayers"/>): a lift is a paint
    /// order, not a physical gap (higher lifts paint over lower ones). Foundation (-.0050) under the skirt and kerb
    /// (-.0049/-.0048) under the plaza (-.0035) under pads (-.0030) and pad kerbs (-.0026) under marks (-.0012…
    /// -.001) under roads and causeways (0) under glyphs (+.0006) and hazard thresholds (+.0008).
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        static readonly float3 FoundationConcrete = new float3(.64f, .63f, .59f);
        static readonly float3 CausewayConcrete = new float3(.57f, .57f, .54f);
        static readonly float3 PadConcrete = new float3(.50f, .50f, .47f);
        static readonly float3 KerbConcrete = new float3(.73f, .72f, .67f);
        static readonly float3 YardGravel = new float3(.52f, .49f, .42f);
        static readonly float3 PathGravel = new float3(.58f, .54f, .46f);
        static readonly float3 PaintDark = new float3(.17f, .17f, .17f);

        static float2 Polar(float angle) => new float2(math.sin(angle), math.cos(angle));

        /// <summary>A point in a building frame (yaw: +z forward) on the map.</summary>
        static float2 LocalToMap(float2 center, float yaw, float lx, float lz)
        {
            math.sincos(yaw, out float sn, out float cs);
            return center + new float2(lx * cs + lz * sn, -lx * sn + lz * cs);
        }

        /// <summary>The map heading at the start of the quarter turn that holds corner (sx, sz) of a building frame.</summary>
        static float CornerAngle(int sx, int sz) => sx > 0 ? (sz > 0 ? 0 : math.PI * .5f) : (sz < 0 ? math.PI : math.PI * 1.5f);

        /// <summary>A draped annulus sector (full disc when r0 = 0), tessellated so it follows the ground.</summary>
        void GroundSector(float2 c, float r0, float r1, float a0, float a1, float lift, float3 color, SurfaceKind kind, int minSegments = 1)
        {
            int segs = Mathf.Clamp(Mathf.Max(minSegments, Mathf.CeilToInt(Mathf.Abs(a1 - a0) * r1 / .16f)), 1, 64);
            int rings = Mathf.Clamp(Mathf.CeilToInt((r1 - r0) / .28f), 1, 8);
            for (int r = 0; r < rings; r++)
            {
                float ra = math.lerp(r0, r1, r / (float)rings), rb = math.lerp(r0, r1, (r + 1) / (float)rings);
                for (int s = 0; s < segs; s++)
                {
                    // Polar(angle) turns clockwise in map x/z as the angle grows, so walking up the angles
                    // keeps the outward side on the strip's left: the same winding as a street ribbon.
                    float ta = math.lerp(a0, a1, s / (float)segs), tb = math.lerp(a0, a1, (s + 1) / (float)segs);
                    RoadStrip(c, c, Polar(ta), Polar(tb), ra, rb, float.NegativeInfinity, lift, color, kind);
                }
            }
        }

        /// <summary>A draped rectangle in a building frame (yaw: +z forward), tessellated both ways.</summary>
        void GroundRect(float2 center, float yaw, float lx, float lz, float width, float depth, float lift, float3 color, SurfaceKind kind)
        {
            math.sincos(yaw, out float sn, out float cs);
            var forward = new float2(sn, cs); var left = new float2(-cs, sn);
            var mid = center + new float2(lx * cs + lz * sn, -lx * sn + lz * cs);   // the Module frame
            int rows = Mathf.Clamp(Mathf.CeilToInt(depth / .16f), 1, 12), cols = Mathf.Clamp(Mathf.CeilToInt(width / .16f), 1, 12);
            for (int r = 0; r < rows; r++)
            {
                var a = mid + forward * (depth * (r / (float)rows - .5f));
                var b = mid + forward * (depth * ((r + 1) / (float)rows - .5f));
                for (int k = 0; k < cols; k++)
                {
                    float from = width * (k / (float)cols - .5f), to = width * ((k + 1) / (float)cols - .5f);
                    RoadStrip(a, b, left, left, from, to, float.NegativeInfinity, lift, color, kind);
                }
            }
        }

        /// <summary>A draped rounded rectangle (corner radius r) in a building frame.</summary>
        void GroundRoundRect(float2 center, float yaw, float w, float d, float r, float lift, float3 color, SurfaceKind kind)
        {
            r = math.min(r, math.min(w, d) * .5f - .001f);
            GroundRect(center, yaw, 0, 0, w, d - 2 * r, lift, color, kind);
            GroundRect(center, yaw, 0, d * .5f - r * .5f, w - 2 * r, r, lift, color, kind);
            GroundRect(center, yaw, 0, -(d * .5f - r * .5f), w - 2 * r, r, lift, color, kind);
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sz = -1; sz <= 1; sz += 2)
                {
                    float a0 = yaw + CornerAngle(sx, sz);
                    GroundSector(LocalToMap(center, yaw, sx * (w * .5f - r), sz * (d * .5f - r)), 0, r, a0, a0 + math.PI * .5f, lift, color, kind, 4);
                }
        }

        /// <summary>The outline (thickness t) of a rounded rectangle; dashed sides when dash > 0.</summary>
        void GroundRoundOutline(float2 center, float yaw, float w, float d, float r, float t, float lift, float3 color, SurfaceKind kind, float dash = 0)
        {
            r = math.min(r, math.min(w, d) * .5f - .001f);
            for (int side = 0; side < 4; side++)
            {
                bool alongX = side < 2;
                float length = (alongX ? w : d) - 2 * r, sign = side % 2 == 0 ? 1 : -1;
                float offset = (alongX ? d : w) * .5f - t * .5f;
                float step = dash > 0 ? dash * 1.7f : length;
                int pieces = Mathf.Max(1, Mathf.RoundToInt(length / step));
                for (int k = 0; k < pieces; k++)
                {
                    float piece = length / pieces, m = -length * .5f + (k + .5f) * piece, size = dash > 0 ? piece * .6f : piece;
                    if (alongX) GroundRect(center, yaw, m, sign * offset, size, t, lift, color, kind);
                    else GroundRect(center, yaw, sign * offset, m, t, size, lift, color, kind);
                }
            }
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sz = -1; sz <= 1; sz += 2)
                {
                    float a0 = yaw + CornerAngle(sx, sz);
                    GroundSector(LocalToMap(center, yaw, sx * (w * .5f - r), sz * (d * .5f - r)), r - t, r, a0, a0 + math.PI * .5f, lift, color, kind, 4);
                }
        }

        /// <summary>A small emissive box sitting on the draped ground (lights, conduit strips, beacons).</summary>
        void GroundLight(float2 at, float yaw, float3 size, float3 color, float emission, float lift = 0)
        {
            float y = RoadCurve.Height(world, float.NegativeInfinity, at.x, at.y) + lift;
            Put(Part.Box, new float3(at.x, y, at.y), yaw, size, color, emission);
        }

        int SiteTier(int city)
        {
            foreach (var s in objectiveByTile.Values) if (s.Id == city) return Mathf.Clamp(Mathf.Max(s.Tier, 1), 1, 3);
            return 1;
        }

        void ComposeBasePresentation(ObjectiveSite site, BaseParcel[] lots, float2[] nodes)
        {
            // one source for both paths (CityRenderer.Slicing.cs): it only yields inside a sliced compose
            var steps = ComposeBasePresentationSteps(site, lots, nodes);
            while (steps.MoveNext()) { }
        }

        /// <summary>
        /// A docking arm from a gate in the HQ drum to the ring road: a low concrete walkway with a lit team
        /// strip of chevrons pointing out to its socket (bright when the socket's building is operational).
        /// </summary>
        void DockingArm(float2 origin, float2 node, float hubY, float3 team, bool live, float glow, float memory)
        {
            var dir = math.normalizesafe(node - origin, new float2(0, 1));
            float yaw = math.atan2(dir.x, dir.y);
            float r0 = .56f, r1 = math.max(r0 + .12f, math.distance(origin, node) - .14f);
            var stone = new float3(.66f, .65f, .60f) * memory;
            const int Pieces = 3;
            float piece = (r1 - r0) / Pieces;
            for (int k = 0; k < Pieces; k++)
            {
                var at = origin + dir * (r0 + (k + .5f) * piece);
                float y = Ground(at.x, at.y) - .012f;
                Put(Part.Concrete, new float3(at.x, y, at.y), yaw, new float3(.085f, .045f, piece + .004f), stone);
                // a chevron on top, pointing out along the arm
                var side = new float2(dir.y, -dir.x);
                for (int s = -1; s <= 1; s += 2)
                {
                    var bar = at - dir * .012f + side * (s * .016f);
                    Put(Part.Box, new float3(bar.x, y + .045f, bar.y), yaw - s * .75f, new float3(.008f, .005f, .045f), team, (live ? 1.0f : .35f) * glow);
                }
            }
            // the gate in the drum
            var gate = origin + dir * .505f;
            Put(Part.Siding, new float3(gate.x, hubY + .03f, gate.y), yaw, new float3(.12f, .105f, .05f), new float3(.30f, .31f, .30f) * memory);
            Put(Part.Box, new float3(gate.x, hubY + .135f, gate.y), yaw, new float3(.13f, .014f, .056f), team, .6f * glow);
        }

        /// <summary>A painted symbol saying which building stands on the socket (yaw: the glyph's up, pointing out to the building).</summary>
        void IdentityGlyph(float2 at, float yaw, string type, float memory)
        {
            const float Lift = .0006f, Thick = .022f;
            float3 color;
            void Bar(float lx, float lz, float length, float turn, float thick = Thick)
                => GroundRect(LocalToMap(at, yaw, lx, lz), yaw + turn, 0, 0, thick, length, Lift, color * memory, SurfaceKind.Plain);
            void Chevron(float tipZ, float size)
            {
                const float A = .85f;
                Bar(size * .5f * math.sin(A), tipZ - size * .5f * math.cos(A), size, -A);
                Bar(-size * .5f * math.sin(A), tipZ - size * .5f * math.cos(A), size, A);
            }
            switch (type)
            {
                case "barracks":                                  // infantry: two rank chevrons
                    color = new float3(.56f, .76f, .36f);
                    Chevron(.055f, .09f); Chevron(-.005f, .09f);
                    break;
                case "armory":                                    // a shield: a chevron under a bar
                    color = new float3(.70f, .52f, .90f);
                    Bar(0, .045f, .11f, math.PI * .5f); Chevron(.0f, .1f);
                    break;
                case "depot":                                     // materials: a crate
                    color = new float3(.96f, .66f, .20f);
                    Bar(0, .05f, .11f, math.PI * .5f); Bar(0, -.05f, .11f, math.PI * .5f);
                    Bar(.05f, 0, .1f, 0); Bar(-.05f, 0, .1f, 0); Bar(0, 0, .13f, .785f, .014f);
                    break;
                case "power_plant":                               // energy: a lightning bolt
                    color = new float3(1f, .86f, .24f);
                    Bar(.022f, .04f, .07f, .45f); Bar(0, 0, .07f, math.PI * .5f - .2f); Bar(-.022f, -.04f, .07f, .45f);
                    break;
                case "motor_works":                               // vehicles: track links
                    color = new float3(.46f, .66f, .96f);
                    for (int k = -1; k <= 1; k++) Bar(0, k * .042f, .12f, math.PI * .5f);
                    Bar(.065f, 0, .11f, 0, .014f); Bar(-.065f, 0, .11f, 0, .014f);
                    break;
                case "heavy_weapons":                             // heavy weapons: a crosshair
                    color = new float3(.96f, .46f, .30f);
                    GroundSector(at, .045f, .065f, 0, 2 * math.PI, Lift, color * memory, SurfaceKind.Plain, 12);
                    Bar(0, 0, .16f, 0, .016f); Bar(0, 0, .16f, math.PI * .5f, .016f);
                    break;
                case "airfield":                                  // aircraft: a plan-view plane
                    color = new float3(.76f, .88f, 1f);
                    Bar(0, 0, .15f, 0); Bar(0, .015f, .14f, math.PI * .5f); Bar(0, -.055f, .06f, math.PI * .5f);
                    break;
                case "advanced_lab":                              // systems: a ring and a core
                    color = new float3(.40f, .95f, .90f);
                    GroundSector(at, .045f, .066f, 0, 2 * math.PI, Lift, color * memory, SurfaceKind.Plain, 12);
                    GroundSector(at, 0, .022f, 0, 2 * math.PI, Lift, color * memory, SurfaceKind.Plain, 8);
                    break;
                case "missile_silo":                              // strategic: an arrow up
                    color = new float3(.96f, .32f, .30f);
                    Bar(0, -.01f, .12f, 0); Chevron(.06f, .08f);
                    break;
                default:
                    color = new float3(.80f, .80f, .76f);
                    GroundSector(at, 0, .035f, 0, 2 * math.PI, Lift, color * memory, SurfaceKind.Plain, 8);
                    break;
            }
        }

        /// <summary>A built socket's own ground: a rounded pad by type, a light kerb, team corner arcs, hazard threshold.</summary>
        void SocketPad(float2 center, float yaw, float w, float d, string type, float3 team, float memory, float alt)
        {
            float3 padColor; SurfaceKind padKind;
            switch (type)
            {
                case "depot": case "motor_works": case "heavy_weapons": case "airfield": padColor = new float3(.36f, .37f, .37f); padKind = SurfaceKind.Asphalt; break;
                case "power_plant": padColor = new float3(.47f, .46f, .42f); padKind = SurfaceKind.Rock; break;
                default: padColor = PadConcrete; padKind = SurfaceKind.Concrete; break;
            }
            float pw = w + .08f, pd = d + .08f;
            const float Round = .14f;
            GroundRoundRect(center, yaw, pw, pd, Round, -.0030f - alt, padColor * memory, padKind);
            GroundRoundOutline(center, yaw, pw, pd, Round, .024f, -.0026f - alt, KerbConcrete * memory, SurfaceKind.Concrete);
            // team arcs on the rounded corners
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sz = -1; sz <= 1; sz += 2)
                {
                    float a0 = yaw + CornerAngle(sx, sz);
                    GroundSector(LocalToMap(center, yaw, sx * (pw * .5f - Round), sz * (pd * .5f - Round)), Round - .05f, Round - .026f,
                        a0 + .15f, a0 + math.PI * .5f - .15f, -.0012f - alt, team * memory, SurfaceKind.Plain, 3);
                }
            // hazard stripes across the threshold the causeway meets (the socket's front faces the HQ)
            const int Stripes = 7;
            for (int k = 0; k < Stripes; k++)
            {
                float x = (k - (Stripes - 1) * .5f) * .042f;
                GroundRect(center, yaw, x, d * .5f - .01f, .036f, .035f, .0008f - alt, (k % 2 == 0 ? Hazard : PaintDark) * memory, SurfaceKind.Plain);
            }
        }

        /// <summary>An open socket: an empty rounded pad, a dashed team outline, corner lamps and a build cross.</summary>
        void OpenSocket(float2 center, float yaw, float w, float d, float3 team, float glow, float memory, float alt)
        {
            float pw = w + .02f, pd = d + .02f;
            const float Round = .14f;
            GroundRoundRect(center, yaw, pw, pd, Round, -.0030f - alt, PadConcrete * 1.06f * memory, SurfaceKind.Concrete);
            GroundRoundOutline(center, yaw, pw, pd, Round, .02f, -.0012f - alt, team * .85f * memory, SurfaceKind.Plain, .09f);
            GroundRect(center, yaw, 0, 0, .22f, .03f, -.0011f - alt, team * .6f * memory, SurfaceKind.Plain);
            GroundRect(center, yaw, 0, 0, .03f, .22f, -.0011f - alt, team * .6f * memory, SurfaceKind.Plain);
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sz = -1; sz <= 1; sz += 2)
                {
                    var at = LocalToMap(center, yaw, sx * (pw * .5f - Round * .3f), sz * (pd * .5f - Round * .3f));
                    GroundLight(at, yaw, new float3(.026f, .02f, .026f), team, .8f * glow);
                }
        }

        /// <summary>A socket of a later tier: a faint pad with one dot per tier it needs.</summary>
        void LockedSocket(float2 center, float yaw, float w, float d, int needs, float memory, float alt)
        {
            const float Round = .14f;
            GroundRoundRect(center, yaw, w, d, Round, -.0030f - alt, FoundationConcrete * .9f * memory, SurfaceKind.Concrete);
            GroundRoundOutline(center, yaw, w, d, Round, .014f, -.0026f - alt, new float3(.48f, .48f, .45f) * memory, SurfaceKind.Concrete);
            for (int k = 0; k < needs; k++)
                GroundSector(LocalToMap(center, yaw, (k - (needs - 1) * .5f) * .07f, 0), 0, .022f, 0, 2 * math.PI, -.0012f - alt,
                    new float3(.40f, .40f, .38f) * memory, SurfaceKind.Plain, 8);
        }

        /// <summary>Tier 2: barrier blocks behind the socket. Tier 3: a T-wall run with a team band and a watch tower.</summary>
        void SocketWall(float2 center, float yaw, float w, float d, int tier, float3 team, float memory, float glow, int index)
        {
            math.sincos(yaw, out float sn, out float cs);
            var forward = new float2(sn, cs); var right = new float2(cs, -sn);
            var line = center - forward * (d * .5f + .15f);
            float span = w + .12f;
            var stone = new float3(.62f, .61f, .56f) * memory;
            if (tier == 2)
            {
                int blocks = Mathf.Max(3, Mathf.FloorToInt(span / .12f));
                for (int k = 0; k < blocks; k++)
                {
                    var at = line + right * ((k + .5f) / blocks - .5f) * span;
                    Put(Part.Concrete, new float3(at.x, Ground(at.x, at.y) - .01f, at.y), yaw, new float3(.10f, .05f, .035f), stone);
                }
                return;
            }
            bool authoredWall = AuthoredMesh(Part.DefWall, null) != null;
            int panels = Mathf.Max(2, Mathf.FloorToInt(span / .26f));
            for (int k = 0; k < panels; k++)
            {
                var at = line + right * ((k + .5f) / panels - .5f) * span;
                float y = Ground(at.x, at.y) - .015f;
                float length = span / panels - .01f;
                if (authoredWall)
                {
                    Put(Part.DefWall, new float3(at.x, y, at.y), yaw, new float3(length / .25f, .85f, 1), new float3(memory));
                    Put(Part.Box, new float3(at.x, y + .108f, at.y), yaw, new float3(length - .004f, .012f, .05f), team, .35f * glow);
                }
                else
                {
                    Put(Part.Concrete, new float3(at.x, y, at.y), yaw, new float3(length, .10f, .035f), stone);
                    Put(Part.Box, new float3(at.x, y + .085f, at.y), yaw, new float3(length - .002f, .012f, .038f), team, .35f * glow);
                }
            }
            if (index % 2 != 0) return;
            // a watch tower at the wall's end, beacon in the team colour
            var post = line + right * (span * .5f + .05f);
            float g = Ground(post.x, post.y) - .015f;
            Put(Part.Concrete, new float3(post.x, g, post.y), yaw, new float3(.07f, .30f, .07f), stone * .92f);
            Put(Part.Siding, new float3(post.x, g + .30f, post.y), yaw, new float3(.11f, .055f, .11f), Olive * memory);
            Put(Part.Siding, new float3(post.x, g + .355f, post.y), yaw, new float3(.13f, .012f, .13f), RoofFloor(SteelGrey) * memory);
            Put(Part.Box, new float3(post.x, g + .367f, post.y), yaw, new float3(.025f, .025f, .025f), team, 1.4f * glow);
        }

        /// <summary>
        /// The round HQ's team bands and its tier silhouette (the model itself stands 10% / 20% taller at tier 2 / 3):
        /// tier 2 adds radomes on the drum roof and a beacon on the mast, tier 3 a team crown on the cab, a dish
        /// and an antenna array.
        /// </summary>
        void HeadquartersTierDressing(in Ctx c, int tier)
        {
            float hs = 1f + .10f * (tier - 1);
            var hq = c;   // local functions cannot capture an in parameter
            math.sincos(hq.Yaw, out float sn, out float cs);
            // Placed in the authored model's own frame (no parcel scale, fixed ground), exactly like AuthoredBase,
            // so the dressing always lands on the model whatever the parcel scale is.
            void Hq(Part part, float lx, float lz, float lift, float3 size, float3 color, float yawOffset = 0, float emission = 0)
                => Put(part, new float3(hq.X + lx * cs + lz * sn, hq.GroundY + lift, hq.Z - lx * sn + lz * cs), hq.Yaw + yawOffset, size, color * hq.Tint, emission);
            // A team band round a drum: thin panels on its wall, not a disc (a disc capped the whole drum roof).
            void Band(float radius, float z, float height, int segments, float gap, float emission)
            {
                float chord = 2f * radius * math.sin(math.PI / segments) - gap;
                for (int k = 0; k < segments; k++)
                {
                    float a = (k + (gap > 0 ? 0f : .5f)) * 2f * math.PI / segments;
                    math.sincos(a, out float s, out float co);
                    Hq(Part.Box, s * radius, co * radius, z * hs, new float3(chord, height * hs, .012f), hq.Civ, a, emission);
                }
            }
            // team bands round the lower drum (between its 16 pilasters, above the windows) and the upper drum
            Band(.507f, .186f, .026f, 16, .03f, .3f);
            Band(.377f, .238f, .018f, 20, 0f, .3f);
            // city AA (perimeter level 2+): a tracking AA mount on the drum roof, behind the command tower
            foreach (var st in objectiveByTile.Values)
            {
                if (!st.IsBase || math.abs(st.X - c.X) > .6f || math.abs(st.Z - c.Z) > .6f) continue;
                if (st.DefenseLevel >= 2 && composing >= 0)
                {
                    Hq(Part.Cylinder, 0, -.265f, .352f * hs, new float3(.2f, .02f, .2f), new float3(.62f, .61f, .57f));
                    var head = st.DefenseLevel >= 3 ? "Def_aa_head3" : "Def_aa_head2";
                    if (!mounts.TryGetValue(composing, out var mount)) mounts[composing] = mount = new TurretMount { Aim = c.Yaw };
                    mount.Pivot = new float3(c.X - .265f * sn, c.GroundY + .372f * hs, c.Z - .265f * cs);
                    mount.Rest = c.Yaw + math.PI; mount.Head = head; mount.Kind = TurretKind.AntiAir; mount.Level = st.DefenseLevel;
                    mount.Memory = st.Memory; mount.Color = math.lerp(new float3(.86f, .87f, .82f), c.Civ, .55f) * c.Tint;
                }
                else if (composing >= 0) mounts.Remove(composing);
                break;
            }
            if (tier < 2) return;
            var stone = new float3(.74f, .73f, .69f);
            for (int k = 0; k < 4; k++)
            {
                float a = k * math.PI * .5f;
                math.sincos(a, out float s, out float co);
                Hq(Part.Cylinder, s * .43f, co * .43f, .24f * hs, new float3(.07f, .03f, .07f), stone * .9f);
                Hq(Part.Dome, s * .43f, co * .43f, .27f * hs, new float3(.085f, .065f, .085f), stone);
            }
            Hq(Part.Box, 0, 0, 1.09f * hs, new float3(.03f, .03f, .03f), c.Civ, 0, 1.4f);   // beacon on the mast top
            if (tier < 3) return;
            Band(.218f, .652f, .016f, 20, 0f, .5f);                                            // team crown on the cab
            Hq(Part.Dish, .27f, .2f, .385f * hs, new float3(.13f, .1f, .13f), stone, .6f);
            for (int k = 0; k < 3; k++)
                Hq(Part.Cylinder, -.2f + k * .07f, .24f, .375f * hs, new float3(.008f, .22f + k * .05f, .008f), SteelGrey);
        }

        /// <summary>
        /// Positioned structures outside a base stand on their own pad with a team ring, and a small gravel path
        /// connects each to the foundation of its owner's nearest base, so improvements read as part of a base.
        /// </summary>
        void FieldStructurePad(in BuildingRecord b, float x, float z)
        {
            if (b.Owner < 0) return;
            var p = new float2(x, z);
            if (OverWater(p)) return;
            bool barricade = b.Type == "barricade" || b.Type == "sandbags";
            float r = b.Type == "city_turret" || b.Type == "turret" ? .22f : .34f;
            if (!barricade)
            {
                GroundSector(p, 0, r, 0, 2 * math.PI, -.004f, YardGravel * (b.Memory ? .62f : 1f), SurfaceKind.Soil);
                GroundSector(p, r - .02f, r, 0, 2 * math.PI, -.0015f, CivColor(b.Owner).xyz * (b.Memory ? .62f : 1f), SurfaceKind.Plain);
            }
            ImprovementPath(b, p, barricade ? .12f : r);
        }

        void ImprovementPath(in BuildingRecord b, float2 p, float radius)
        {
            const float Reach = 7.5f;
            float best = Reach; float2 hub = default; float rim = 0; bool found = false;
            foreach (var s in objectiveByTile.Values)
            {
                if (!s.IsBase || s.Headquarters == 0 || s.Owner != b.Owner || s.Parcels == null || s.Parcels.Length < MinRingParcels) continue;
                var o = new float2(world.Grid.NearX(s.X, p.x), s.Z);
                float distance = math.distance(o, p);
                if (distance >= best) continue;
                var lots = new List<BaseParcel>();
                foreach (var lot in s.Parcels) if (lot.Id > 0) lots.Add(lot);
                best = distance; hub = o; rim = FoundationRadius(new float2(s.X, s.Z), lots.ToArray()) + .06f; found = true;
            }
            if (!found || best < rim + radius + .2f) return;
            var dir = math.normalizesafe(p - hub);
            var side = new float2(-dir.y, dir.x);
            var start = hub + dir * rim; var end = p - dir * (radius * .9f);
            float length = math.distance(start, end);
            var bow = (start + end) * .5f + side * (Hash(b.Id, 77) - .5f) * math.min(.6f, length * .18f);
            int pieces = Mathf.Clamp(Mathf.CeilToInt(length / .22f), 2, 48);
            var color = PathGravel * (b.Memory ? .62f : 1f);
            for (int k = 0; k < pieces; k++)
            {
                float ta = k / (float)pieces, tb = (k + 1) / (float)pieces;
                var a = Quadratic(start, bow, end, ta); var c = Quadratic(start, bow, end, tb);
                if (OverWater(a) || OverWater(c)) continue;
                var sa = math.normalizesafe(Quadratic(start, bow, end, ta + .01f) - a); sa = new float2(-sa.y, sa.x);
                var sb = math.normalizesafe(Quadratic(start, bow, end, math.min(1, tb + .01f)) - Quadratic(start, bow, end, math.max(0, tb - .01f))); sb = new float2(-sb.y, sb.x);
                RoadStrip(a, c, sa, sb, -.034f, .034f, float.NegativeInfinity, -.0042f, color, SurfaceKind.Soil);
            }
        }

        static float2 Quadratic(float2 a, float2 b, float2 c, float t) { float u = 1 - t; return u * u * a + 2 * u * t * b + t * t * c; }
    }
}
