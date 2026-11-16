using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Halo Wars style base presentation, on top of the compound roads (RoadConnections) and the terrain
    /// apron (TerritoryField + SE/Terrain):
    ///
    /// - a paved headquarters plaza with a painted team ring, so the HQ is the visible core;
    /// - every socket gets its own ground: a gravel yard, a type-specific pad (concrete, vehicle asphalt,
    ///   gravel generator yard) with team-coloured corner marks and a hazard-striped threshold where its
    ///   conduit arrives; an open socket shows a dashed team outline and corner lamps;
    /// - a lit conduit runs down every spur from the HQ ring to its socket (bright when the socket is built);
    /// - tier reads in the world: tier 2 adds barrier segments behind every socket and an HQ comms mast,
    ///   tier 3 raises them into walls with watch towers, plaza flags and the HQ command tower.
    /// Unclaimed compounds (no headquarters) keep only their ruins and roads.
    ///
    /// All ground pieces go into the street mesh's ground layers (<see cref="GroundLayers"/>): a lift is a
    /// paint order, not a physical gap (higher lifts paint over lower ones), so plaza, yards, pads and
    /// markings never z-fight. Plaza (-.0035) under every road and pavement; yard (-.0045) under pad (-.0025)
    /// under corner marks (-.001); hazard threshold (+.0008) over the spur road's end (0).
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        static readonly float3 PadConcrete = new float3(.60f, .60f, .56f);
        static readonly float3 YardGravel = new float3(.52f, .49f, .42f);
        static readonly float3 PaintDark = new float3(.17f, .17f, .17f);

        static float2 Polar(float angle) => new float2(math.sin(angle), math.cos(angle));

        /// <summary>A draped annulus sector (full disc when r0 = 0), tessellated so it follows the ground.</summary>
        void GroundSector(float2 c, float r0, float r1, float a0, float a1, float lift, float3 color, SurfaceKind kind)
        {
            int segs = Mathf.Clamp(Mathf.CeilToInt(Mathf.Abs(a1 - a0) * r1 / .16f), 1, 64);
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
            bool held = site.Headquarters != 0 && site.Owner >= 0;
            var origin = new float2(site.X, site.Z);
            float memory = site.Memory ? .62f : 1f;
            var team = held ? CivColor(site.Owner).xyz : new float3(.55f);
            int tier = Mathf.Clamp(Mathf.Max(site.Tier, 1), 1, 3);
            if (!held) return;
            float glow = site.Memory ? 0f : 1f;

            // the core: a paved plaza inside the ring road, a team ring and four lamps
            GroundSector(origin, 0, .90f, 0, 2 * math.PI, -.0035f, PadConcrete * .96f * memory, SurfaceKind.Concrete);
            GroundSector(origin, .80f, .845f, 0, 2 * math.PI, -.0015f, team * memory, SurfaceKind.Plain);
            for (int k = 0; k < 8; k++)
            {
                float a = k * math.PI * .25f + math.PI * .125f;
                GroundLight(origin + Polar(a) * .87f, a, new float3(.03f, .012f, .03f), team, .9f * glow);
            }

            var occupants = new Dictionary<int, BuildingRecord>();
            foreach (var b in structures.Buildings.Values) if (b.City == site.Id && b.Slot > 0) occupants[b.Slot] = b;
            for (int i = 0; i < lots.Length; i++)
            {
                var lot = lots[i];
                var center = new float2(lot.X, lot.Z);
                bool built = occupants.TryGetValue(lot.Id, out var building);
                bool open = lot.Tier <= tier;
                float w = lot.Width > .1f ? lot.Width : .95f, d = lot.Depth > .1f ? lot.Depth : .88f;
                float alt = (i % 2) * .0005f;
                var front = Polar(lot.Yaw);
                if (built) SocketPad(center, lot.Yaw, w, d, building.Type, team, memory, alt);
                else if (open) OpenSocket(center, lot.Yaw, w, d, team, glow, alt);
                // the conduit from the HQ ring to the socket's threshold
                if (built || open)
                {
                    var end = center + front * (d * .5f + .02f);
                    var start = nodes[i];
                    float length = math.distance(start, end);
                    int pieces = Mathf.Max(2, Mathf.CeilToInt(length / .11f));
                    var dir = math.normalizesafe(end - start, front);
                    float yaw = math.atan2(dir.x, dir.y);
                    float bright = (built && building.Done ? 1.1f : .45f) * glow;
                    for (int k = 0; k < pieces; k++)
                    {
                        var at = math.lerp(start, end, (k + .5f) / pieces);
                        GroundLight(at, yaw, new float3(.014f, .004f, length / pieces * .62f), team, bright, .0015f);
                    }
                }
                if (tier >= 2) SocketWall(center, lot.Yaw, w, d, tier, team, memory, glow, i);
            }

            // tier 3: plaza flags in the team colour
            if (tier >= 3)
            {
                var c = new Ctx { X = site.X, Z = site.Z, Yaw = lots.Length > 0 ? lots[0].Yaw : 0, Seed = site.Id * 31 + 7, Tint = new float3(memory),
                    Civ = team, Era = 1, Level = 1, Tier = tier, FixedGround = true, GroundY = Ground(site.X, site.Z) - .01f };
                for (int k = 0; k < 4; k++)
                {
                    float a = k * math.PI * .5f + math.PI * .25f;
                    math.sincos(a, out float s, out float co);
                    Flag(c, s * .70f, co * .70f, .46f);
                }
            }
        }

        /// <summary>A built socket's own ground: gravel yard, a type-specific pad, team corners, hazard threshold.</summary>
        void SocketPad(float2 center, float yaw, float w, float d, string type, float3 team, float memory, float alt)
        {
            GroundRect(center, yaw, 0, 0, w + .14f, d + .14f, -.0045f - alt, YardGravel * memory, SurfaceKind.Soil);
            float3 padColor; SurfaceKind padKind;
            switch (type)
            {
                case "depot": case "motor_works": case "heavy_weapons": padColor = new float3(.33f, .34f, .34f); padKind = SurfaceKind.Asphalt; break;
                case "power_plant": padColor = new float3(.47f, .46f, .42f); padKind = SurfaceKind.Rock; break;
                case "barracks": case "armory": padColor = new float3(.57f, .56f, .51f); padKind = SurfaceKind.Concrete; break;
                default: padColor = PadConcrete; padKind = SurfaceKind.Concrete; break;
            }
            GroundRect(center, yaw, 0, 0, w + .04f, d + .04f, -.0025f - alt, padColor * memory, padKind);
            // painted team corner marks (an L at each corner)
            float hw = (w + .04f) * .5f - .02f, hd = (d + .04f) * .5f - .02f;
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sz = -1; sz <= 1; sz += 2)
                {
                    GroundRect(center, yaw, sx * (hw - .07f), sz * hd, .14f, .018f, -.001f - alt, team * memory, SurfaceKind.Plain);
                    GroundRect(center, yaw, sx * hw, sz * (hd - .07f), .018f, .14f, -.001f - alt, team * memory, SurfaceKind.Plain);
                }
            // hazard stripes across the threshold the conduit meets (the socket's front faces the HQ)
            int stripes = 7;
            for (int k = 0; k < stripes; k++)
            {
                float x = (k - (stripes - 1) * .5f) * .045f;
                GroundRect(center, yaw, x, d * .5f - .005f, .04f, .035f, .0008f - alt, (k % 2 == 0 ? Hazard : PaintDark) * memory, SurfaceKind.Plain);
            }
        }

        /// <summary>An open socket: a dashed team outline over the old ground and a lamp at each corner.</summary>
        void OpenSocket(float2 center, float yaw, float w, float d, float3 team, float glow, float alt)
        {
            const float dash = .09f, gap = .06f;
            for (int side = 0; side < 4; side++)
            {
                bool alongX = side < 2;
                float length = alongX ? w : d, sign = side % 2 == 0 ? -1 : 1;
                for (float t = -length * .5f; t + dash <= length * .5f + .001f; t += dash + gap)
                {
                    float m = t + dash * .5f;
                    if (alongX) GroundRect(center, yaw, m, sign * d * .5f, dash, .02f, -.001f - alt, team * .85f, SurfaceKind.Plain);
                    else GroundRect(center, yaw, sign * w * .5f, m, .02f, dash, -.001f - alt, team * .85f, SurfaceKind.Plain);
                }
            }
            math.sincos(yaw, out float sn, out float cs);
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sz = -1; sz <= 1; sz += 2)
                {
                    float lx = sx * w * .5f, lz = sz * d * .5f;
                    var at = center + new float2(lx * cs + lz * sn, -lx * sn + lz * cs);
                    GroundLight(at, yaw, new float3(.026f, .02f, .026f), team, .8f * glow);
                }
        }

        /// <summary>Tier 2: barrier blocks behind the socket. Tier 3: a wall with a team band and a watch tower.</summary>
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
            int panels = Mathf.Max(2, Mathf.FloorToInt(span / .26f));
            for (int k = 0; k < panels; k++)
            {
                var at = line + right * ((k + .5f) / panels - .5f) * span;
                float y = Ground(at.x, at.y) - .015f;
                Put(Part.Concrete, new float3(at.x, y, at.y), yaw, new float3(span / panels - .01f, .10f, .035f), stone);
                Put(Part.Box, new float3(at.x, y + .085f, at.y), yaw, new float3(span / panels - .012f, .012f, .038f), team, .35f * glow);
            }
            if (index % 2 != 0) return;
            // a watch tower at the wall's end, beacon in the team colour
            var post = line + right * (span * .5f + .05f);
            float g = Ground(post.x, post.y) - .015f;
            Put(Part.Concrete, new float3(post.x, g, post.y), yaw, new float3(.07f, .30f, .07f), stone * .92f);
            Put(Part.Siding, new float3(post.x, g + .30f, post.y), yaw, new float3(.11f, .055f, .11f), Olive * memory);
            Put(Part.Siding, new float3(post.x, g + .355f, post.y), yaw, new float3(.13f, .012f, .13f), SteelGrey * memory);
            Put(Part.Box, new float3(post.x, g + .367f, post.y), yaw, new float3(.025f, .025f, .025f), team, 1.4f * glow);
        }

        /// <summary>Headquarters silhouette by tier, for the authored HQ model (the recipe HQ grows by itself).</summary>
        void HeadquartersTierDressing(in Ctx c, int tier)
        {
            if (tier < 2) return;
            var stone = new float3(.70f, .68f, .62f);
            var roof = new float3(.36f, .42f, .41f);
            // tier 2: a side annex and a comms mast with a team beacon
            Module(c, Part.Concrete, .64f, -.30f, new float3(.20f, .17f, .28f), stone);
            Module(c, Part.MetalRoof, .64f, -.30f, new float3(.22f, .025f, .30f), roof, 0, .17f);
            Module(c, Part.Glass, .64f, -.155f, new float3(.15f, .05f, .012f), new float3(.37f, .52f, .58f), 0, .09f);
            Module(c, Part.Cylinder, .60f, -.40f, new float3(.016f, .62f, .016f), SteelGrey, 0, .17f);
            Module(c, Part.Box, .60f, -.40f, new float3(.028f, .028f, .028f), c.Civ, 0, .79f, 1.4f);
            if (tier < 3) return;
            // tier 3: the command tower, dish and antenna array that make the HQ the tallest thing in the base
            Module(c, Part.Concrete, -.64f, -.32f, new float3(.24f, .70f, .24f), stone * .9f);
            Module(c, Part.Glass, -.64f, -.198f, new float3(.21f, .10f, .014f), new float3(.43f, .60f, .67f), 0, .55f);
            Module(c, Part.Siding, -.64f, -.32f, new float3(.27f, .03f, .27f), roof, 0, .70f);
            Module(c, Part.Box, -.64f, -.198f, new float3(.22f, .018f, .016f), c.Civ, 0, .66f, .9f);
            Module(c, Part.Dish, -.64f, -.32f, new float3(.15f, .11f, .15f), stone, .5f, .73f);
            for (int k = 0; k < 3; k++)
                Module(c, Part.Cylinder, -.72f + k * .08f, -.40f, new float3(.008f, .26f + k * .06f, .008f), SteelGrey, 0, .73f);
            Module(c, Part.Box, -.64f, -.40f, new float3(.03f, .03f, .03f), c.Civ, 0, 1.08f, 1.6f);
        }

        /// <summary>Positioned structures outside a base: a gravel pad with a team ring, so each reads as an element.</summary>
        void FieldStructurePad(in BuildingRecord b, float x, float z)
        {
            if (b.Type == "barricade" || b.Owner < 0) return;
            var p = new float2(x, z);
            if (OverWater(p)) return;
            float r = b.Type == "city_turret" || b.Type == "turret" ? .22f : .34f;
            GroundSector(p, 0, r, 0, 2 * math.PI, -.004f, YardGravel * (b.Memory ? .62f : 1f), SurfaceKind.Soil);
            GroundSector(p, r - .02f, r, 0, 2 * math.PI, -.0015f, CivColor(b.Owner).xyz * (b.Memory ? .62f : 1f), SurfaceKind.Plain);
        }
    }
}
