using System.Collections.Generic;
using SE.Core.Protocol;
using Unity.Mathematics;

namespace SE.Runtime.Cities
{
    public sealed unsafe partial class CityRenderer
    {
        // Each facility reuses an old parcel but has its own engineering vocabulary.
        // Service aprons stay local to the building and connect to the shared streets.
        static readonly float3 FacilityConcrete = new float3(.65f, .65f, .60f);
        static readonly float3 FacilitySteel = new float3(.43f, .48f, .47f);
        static readonly float3 FacilityBrick = new float3(.63f, .54f, .44f);

        void Shutter(in Ctx c, float x, float z, float width, float height, float lift = .02f)
        {
            Module(c, Part.Siding, x, z, new float3(width, height, .012f), FacilitySteel * .72f, 0, lift);
            for (int k = 1; k < 5; k++)
                Module(c, Part.Box, x, z + .007f, new float3(width * .96f, .003f, .005f), FacilitySteel, 0, lift + height * k / 5);
            Module(c, Part.Concrete, x, z, new float3(width + .026f, .014f, .028f), FacilityConcrete, 0, lift + height);
        }

        // ---- team accents (overhaul §35): the recipe facilities wear their owner's colour like the authored models'
        // "mark" panels (AuthoredBase: c.Civ with a little emission), as a roof band seen from the RTS camera and a
        // panel over the main door. Recomposed with the cell on a change of owner, like every module.
        const float TeamGlow = .22f;
        static readonly float3 BermEarth = new float3(.50f, .44f, .32f);

        /// <summary>A team-coloured band laid across a flat roof (lift: the roof's top).</summary>
        void TeamRoofBand(in Ctx c, float x, float z, float width, float lift, float depth = .065f)
            => Module(c, Part.Box, x, z, new float3(width, .02f, depth), c.Civ, 0, lift, TeamGlow);

        /// <summary>A team-coloured panel on a front wall (z: just proud of the wall face).</summary>
        void TeamPanel(in Ctx c, float x, float z, float width, float lift, float height = .04f)
            => Module(c, Part.Box, x, z, new float3(width, height, .008f), c.Civ, 0, lift, TeamGlow);

        void RoofPlant(in Ctx c, float x, float z, float height, int count = 2)
        {
            for (int k = 0; k < count; k++)
            {
                float px = x + (k - (count - 1) * .5f) * .095f;
                Module(c, Part.Siding, px, z, new float3(.071f, .044f, .10f), FacilitySteel, 0, height);
                Module(c, Part.Cylinder, px, z, new float3(.045f, .008f, .045f), Dark, 0, height + .044f);
            }
        }

        void VehicleWorks(in Ctx c)
        {
            // Three parallel assembly bays, brick offices and a separate maintenance yard.
            for (int k = 0; k < 3; k++)
            {
                float x = -.35f + k * .255f, h = k == 1 ? .34f : .28f;
                Module(c, Part.Brick, x, -.20f, new float3(.24f, h, .58f), FacilityBrick);
                Module(c, Part.MetalRoof, x, -.20f, new float3(.255f, .064f, .60f), FacilitySteel, 0, h);
                Shutter(c, x, .098f, .18f, .20f);
                Module(c, Part.Glass, x, -.503f, new float3(.18f, .043f, .008f), new float3(.38f, .50f, .52f), 0, h - .07f);
                Module(c, Part.Box, x + .092f, .115f, new float3(.014f, .013f, .012f), new float3(.91f, .77f, .47f), 0, .245f, .10f);
            }
            Module(c, Part.Brick, .40f, -.25f, new float3(.23f, .18f, .44f), FacilityBrick * .93f);
            Module(c, Part.Siding, .40f, -.25f, new float3(.25f, .022f, .46f), FacilitySteel, 0, .18f);
            Facade(c, .40f, -.25f, .23f, .44f, .18f, 0, c.Seed);
            Module(c, Part.Asphalt, -.06f, .30f, new float3(.78f, .004f, .34f), new float3(.39f, .41f, .40f));
            for (int i = -1; i <= 1; i += 2)
            {
                Module(c, Part.Cylinder, .33f + i * .075f, .30f, new float3(.016f, .22f, .016f), FacilitySteel);
                Module(c, Part.Cylinder, .33f + i * .075f, .46f, new float3(.016f, .22f, .016f), FacilitySteel);
            }
            Module(c, Part.Siding, .33f, .38f, new float3(.19f, .018f, .20f), FacilitySteel, 0, .22f);
            Module(c, Part.Box, .33f, .38f, new float3(.012f, .16f, .012f), SteelGrey, 0, .052f);
            RoofPlant(c, -.07f, -.39f, .35f);
            Flag(c, -.48f, .41f, .37f);
            if (c.Tier >= 3) Module(c, Part.Siding, .16f, -.52f, new float3(.27f, .10f, .12f), Olive);
        }

        void GeneratorStation(in Ctx c)
        {
            Module(c, Part.Brick, -.19f, -.22f, new float3(.54f, .29f, .51f), FacilityBrick * .96f);
            Module(c, Part.MetalRoof, -.19f, -.22f, new float3(.57f, .047f, .54f), FacilitySteel, 1.5708f, .29f);
            Facade(c, -.19f, -.22f, .54f, .51f, .29f, 0, c.Seed);
            Shutter(c, -.18f, .043f, .16f, .18f);
            for (int k = 0; k < 3; k++)
            {
                float z = -.37f + k * .22f;
                Module(c, Part.Concrete, .31f, z, new float3(.28f, .024f, .17f), FacilityConcrete * .86f);
                Module(c, Part.Siding, .31f, z, new float3(.19f, .105f, .12f), FacilitySteel, 0, .024f);
                for (int j = -1; j <= 1; j += 2)
                {
                    Module(c, Part.Cylinder, .31f + j * .048f, z, new float3(.018f, .10f, .018f), new float3(.44f, .39f, .31f), 0, .129f);
                    Module(c, Part.Box, .31f + j * .108f, z, new float3(.014f, .085f, .125f), FacilitySteel * .75f, 0, .034f);
                }
                Module(c, Part.Cylinder, -.37f + k * .16f, -.35f, new float3(.027f, .29f, .027f), SteelGrey, 0, .30f);
            }
            Module(c, Part.Concrete, -.25f, .28f, new float3(.40f, .022f, .23f), FacilityConcrete * .85f);
            for (int k = 0; k < 2; k++)
            {
                Module(c, Part.Silo, -.36f + k * .21f, .28f, new float3(.15f, .16f, .15f), new float3(.56f, .59f, .55f), 0, .022f);
                Module(c, Part.Cylinder, -.36f + k * .21f, .28f, new float3(.025f, .025f, .025f), FacilitySteel, 0, .18f);
            }
            Module(c, Part.Siding, .28f, .27f, new float3(.22f, .115f, .22f), Olive * .83f);
            RoofPlant(c, .28f, .27f, .115f, 1);
        }

        void ForwardAirfield(in Ctx c)
        {
            // A narrow usable strip rather than a giant decorative slab. Shoulder and taxi link
            // are draped by Module, so neither floats above the valley.
            Module(c, Part.Asphalt, .11f, .19f, new float3(1.05f, .004f, .23f), new float3(.37f, .39f, .39f));
            Module(c, Part.Asphalt, -.25f, -.035f, new float3(.15f, .004f, .28f), new float3(.40f, .42f, .41f));
            for (int k = 0; k < 8; k++)
            {
                Module(c, Part.Box, -.31f + k * .12f, .19f, new float3(.056f, .002f, .006f), new float3(.77f, .76f, .67f), 0, .006f);
                for (int side = -1; side <= 1; side += 2)
                    Module(c, Part.Box, -.34f + k * .13f, .19f + side * .105f, new float3(.009f, .008f, .009f), new float3(.59f, .72f, .75f), 0, .008f, .11f);
            }
            for (int k = 0; k < 2; k++)
            {
                float x = -.31f + k * .39f;
                Module(c, Part.Concrete, x, -.29f, new float3(.35f, .22f, .33f), FacilityConcrete);
                Module(c, Part.MetalRoof, x, -.29f, new float3(.37f, .075f, .35f), FacilitySteel, 0, .22f);
                Shutter(c, x, -.117f, .29f, .18f);
            }
            Module(c, Part.Concrete, .42f, -.29f, new float3(.16f, .36f, .19f), FacilityConcrete * .91f);
            Module(c, Part.Glass, .42f, -.29f, new float3(.19f, .073f, .22f), new float3(.37f, .52f, .55f), 0, .36f);
            Module(c, Part.Siding, .42f, -.29f, new float3(.23f, .018f, .25f), FacilitySteel, 0, .433f);
            Module(c, Part.Cylinder, .44f, -.31f, new float3(.006f, .13f, .006f), SteelGrey, 0, .45f);
            Module(c, Part.Siding, .43f, .44f, new float3(.25f, .065f, .12f), Olive);
            // §34 silhouette: a team beacon on the control tower and a striped windsock on its mast by the strip
            Module(c, Part.Box, .42f, -.29f, new float3(.035f, .03f, .035f), c.Civ, 0, .451f, .6f);
            Module(c, Part.Cylinder, .53f, .02f, new float3(.010f, .22f, .010f), SteelGrey);
            for (int k = 0; k < 3; k++)
                Module(c, Part.Box, .556f + k * .045f, .02f, new float3(.045f, .034f - k * .007f, .034f - k * .007f),
                    k % 2 == 0 ? new float3(.93f, .42f, .12f) : new float3(.92f, .91f, .86f), 0, .19f - k * .006f);
            // §35 team: a band across each hangar roof
            for (int k = 0; k < 2; k++) TeamRoofBand(c, -.31f + k * .39f, -.29f, .38f, .295f);
        }

        void Arsenal(in Ctx c) => Arsenal(c, false);

        /// <summary>The armoury hall; <paramref name="heavy"/>: the heavy weapons facility builds on it (its yard holds a gantry, not the magazines).</summary>
        void Arsenal(in Ctx c, bool heavy)
        {
            Module(c, Part.Brick, -.12f, -.18f, new float3(.69f, .30f, .48f), FacilityBrick);
            Module(c, Part.MetalRoof, -.12f, -.18f, new float3(.73f, .11f, .52f), new float3(.39f, .43f, .44f), 0, .30f);
            Facade(c, -.12f, -.18f, .69f, .48f, .30f, 0, c.Seed);
            for (int k = 0; k < 4; k++)
                Module(c, Part.Concrete, -.43f + k * .21f, .072f, new float3(.023f, .23f, .065f), FacilityConcrete * .9f);
            Shutter(c, -.13f, .094f, .18f, .20f);
            Module(c, Part.Concrete, .39f, -.20f, new float3(.22f, .16f, .38f), FacilityConcrete * .83f);
            Module(c, Part.Concrete, .39f, -.20f, new float3(.25f, .045f, .40f), FacilityConcrete, 0, .16f);
            Module(c, Part.Asphalt, -.10f, .30f, new float3(.55f, .004f, .27f), new float3(.38f, .40f, .39f));
            RoofPlant(c, -.30f, -.27f, .39f, 1);
            Flag(c, .31f, .34f, .39f);
            // §35 team: a ridge band along the hall roof and a panel over the main door
            TeamRoofBand(c, -.12f, -.18f, .75f, .41f);
            TeamPanel(c, -.13f, .068f, .30f, .245f);
            if (heavy) return;
            // §34 silhouette: the magazines sit in a blast revetment, earth traverses between the bunkers and a
            // berm behind them, so an armoury reads apart from the heavy weapons hall at a glance
            for (int k = 0; k < 3; k++) Module(c, Part.Siding, -.37f + k * .14f, .37f, new float3(.095f, .06f, .10f), Olive * .84f);
            for (int k = 0; k < 4; k++) Module(c, Part.Box, -.44f + k * .14f, .37f, new float3(.034f, .085f, .15f), BermEarth, 0, 0);
            Module(c, Part.Box, -.23f, .455f, new float3(.46f, .07f, .045f), BermEarth * .94f);
            Module(c, Part.Box, -.23f, .455f, new float3(.40f, .012f, .03f), new float3(.40f, .47f, .30f), 0, .07f);   // turf on the berm
        }

        void FortificationWorks(in Ctx c)
        {
            Module(c, Part.Siding, -.22f, -.24f, new float3(.51f, .22f, .51f), new float3(.50f, .53f, .49f));
            Module(c, Part.MetalRoof, -.22f, -.24f, new float3(.54f, .05f, .54f), FacilitySteel, 0, .22f);
            Shutter(c, -.22f, .024f, .28f, .18f);
            Module(c, Part.Asphalt, .26f, .0f, new float3(.38f, .004f, .76f), new float3(.42f, .44f, .42f));
            for (int k = 0; k < 3; k++)
            {
                Module(c, Part.Concrete, .31f, -.30f + k * .12f, new float3(.24f, .085f, .075f), FacilityConcrete * .87f);
                Module(c, Part.Box, .31f, -.30f + k * .12f, new float3(.15f, .012f, .045f), FacilitySteel, 0, .085f);
            }
            Module(c, Part.Concrete, -.21f, .27f, new float3(.43f, .11f, .19f), FacilityConcrete * .9f);
            Module(c, Part.Concrete, -.21f, .27f, new float3(.45f, .045f, .22f), FacilityConcrete, 0, .11f);
            Module(c, Part.Siding, -.21f, .369f, new float3(.23f, .028f, .012f), Dark, 0, .078f);
            Module(c, Part.Crane, .30f, .27f, new float3(.20f, .27f, .20f), new float3(.66f, .59f, .40f), -.45f);
            // §35 team: a band across the casting hall roof and a panel over its door
            TeamRoofBand(c, -.22f, -.24f, .54f, .27f);
            TeamPanel(c, -.22f, .022f, .30f, .205f, .03f);
        }

        void SystemsCampus(in Ctx c)
        {
            // A recovered institutional building with a new test wing; technology adds to history.
            Module(c, Part.Concrete, -.22f, -.23f, new float3(.43f, .47f, .47f), FacilityConcrete);
            Module(c, Part.Siding, -.22f, -.23f, new float3(.46f, .026f, .50f), FacilitySteel, 0, .47f);
            Facade(c, -.22f, -.23f, .43f, .47f, .47f, 0, c.Seed);
            Module(c, Part.Brick, .30f, -.19f, new float3(.34f, .25f, .56f), FacilityBrick * .91f);
            Module(c, Part.Siding, .30f, -.19f, new float3(.37f, .026f, .59f), FacilitySteel, 0, .25f);
            Facade(c, .30f, -.19f, .34f, .56f, .25f, 0, c.Seed + 1);
            Module(c, Part.Glass, .06f, -.21f, new float3(.13f, .09f, .13f), new float3(.36f, .53f, .55f), 0, .145f);
            Module(c, Part.Concrete, .06f, -.21f, new float3(.15f, .014f, .15f), FacilityConcrete, 0, .235f);
            Module(c, Part.Concrete, -.21f, .034f, new float3(.18f, .04f, .10f), FacilityConcrete);
            Module(c, Part.Glass, -.21f, .043f, new float3(.12f, .14f, .012f), new float3(.33f, .47f, .48f), 0, .04f);
            Module(c, Part.Cylinder, -.24f, -.28f, new float3(.016f, .18f, .016f), FacilitySteel, 0, .49f);
            Module(c, Part.Dish, -.24f, -.28f, new float3(.19f, .13f, .19f), FacilityConcrete, .4f, .65f);
            RoofPlant(c, .30f, -.25f, .28f);
            Module(c, Part.Asphalt, .06f, .31f, new float3(.69f, .004f, .24f), new float3(.40f, .43f, .41f));
            Parked(c, .30f, .31f, 1.5708f, c.Seed + 40, false);
            Flag(c, -.42f, .29f, .42f);
            // §34 silhouette: an antenna array on the test wing (three masts with crossed dipoles), so the lab's
            // skyline is masts and a dish rather than another flat hall
            for (int k = 0; k < 3; k++)
            {
                float x = .21f + k * .09f;
                Module(c, Part.Cylinder, x, -.38f, new float3(.008f, .21f, .008f), SteelGrey, 0, .276f);
                for (int j = 0; j < 2; j++)
                    Module(c, Part.Box, x, -.38f, new float3(.075f - j * .02f, .006f, .006f), new float3(.78f, .80f, .78f), 0, .41f + j * .05f);
            }
            // §35 team: bands across the institute roof and the test wing
            TeamRoofBand(c, -.22f, -.23f, .46f, .496f);
            TeamRoofBand(c, .30f, -.05f, .37f, .276f);
        }

        void StrategicFacility(in Ctx c)
        {
            Module(c, Part.StrategicHatch, -.10f, -.17f, new float3(.76f), new float3(.90f));
            for (int side = -1; side <= 1; side += 2)
            {
                Module(c, Part.Concrete, -.10f + side * .46f, -.17f, new float3(.08f, .065f, .78f), FacilityConcrete);
            }
            Module(c, Part.Concrete, -.10f, -.62f, new float3(.90f, .07f, .065f), FacilityConcrete);
            Module(c, Part.Concrete, .39f, .17f, new float3(.23f, .17f, .34f), FacilityConcrete);
            Shutter(c, .39f, .347f, .12f, .13f);
            Module(c, Part.Cylinder, .42f, .12f, new float3(.018f, .30f, .018f), FacilitySteel, 0, .17f);
            Module(c, Part.Dish, .42f, .12f, new float3(.14f, .10f, .14f), FacilityConcrete, -.5f, .45f);
            Module(c, Part.Asphalt, -.16f, .30f, new float3(.50f, .004f, .26f), new float3(.38f, .40f, .39f));
            for (int side = -1; side <= 1; side += 2)
                Module(c, Part.Cylinder, -.10f + side * .31f, .18f, new float3(.012f, .18f, .012f), FacilitySteel);
            // §34 silhouette and §35 team: a ring of bollards round the hatch, hazard yellow alternating with the
            // owner's colour, so the silo reads as a launch site and whose it is at a glance
            for (int k = 0; k < 16; k++)
            {
                float a = k * math.PI / 8;
                bool team = k % 2 == 0;
                Module(c, Part.Box, -.10f + math.sin(a) * .41f, -.17f + math.cos(a) * .41f, new float3(.03f, .055f, .03f),
                    team ? c.Civ : Hazard, a, 0, team ? TeamGlow : 0);
            }
            TeamRoofBand(c, .39f, .17f, .25f, .17f);   // on the control block
        }

        // ================================================================== building readability (workstream B, 2026-11-18)
        // Every gameplay structure gets a signature that reads at mid and far zoom (a beacon, a dish, a dome, a camo net,
        // dragon's teeth, a lamp mast, a gantry, a proof tank) and a crisp team rim on the ground round its body, so it
        // never reads as an ambient house or ruin (those carry no team colour and no rim). All of it is static and
        // composed with the building (cell instances and draped quads; nothing per frame); everything it reads (type,
        // level, owner, memory, damage band, position) is already in StructureStore.VisualKey.

        static readonly HashSet<string> GameplayFacilities = new HashSet<string>
        {
            "town", "barracks", "camp", "depot", "power_plant", "motor_works", "heavy_weapons", "heavy_assembly", "airfield",
            "armory", "defense_works", "advanced_lab", "missile_silo", "base_site",
        };

        /// <summary>
        /// Whether a building type is a gameplay structure (a field defense or a base facility) rather than ambient city
        /// fabric: only these are picked by the cursor (Commander.Selection.cs) when the server's definitions are unknown.
        /// </summary>
        public static bool IsGameplayType(string type)
            => !string.IsNullOrEmpty(type) && (DefenseKinds.ContainsKey(type) || GameplayFacilities.Contains(type));

        /// <summary>
        /// The drawn extent of a positioned structure: the radius of its visible body (berms, sandbags, blast ring,
        /// dragon's teeth) and the height of its tallest readable part, in map units. The cursor picks against this
        /// (never smaller than the server's footprint radius), so the click target matches what is on screen.
        /// Negative when the type is not a known positioned structure.
        /// </summary>
        public static float VisualExtent(string type, out float height)
        {
            switch (type)
            {
                case "barricade": case "sandbags": height = .12f; return .30f;
                case "guard_post": case "watchtower": height = .66f; return .28f;     // the blast ring at level 2 (.25)
                case "bunker": height = .27f; return .46f;                            // berm .38, blast ring .43
                case "turret": case "at_emplacement": height = .22f; return .42f;      // dragon's teeth .40
                case "aa_battery": height = .48f; return .40f;                         // director mast, blast ring .37
                case "city_turret": height = .27f; return .26f;                        // lamp mast; blast ring .23
                case "fort": case "outpost": height = .34f; return .56f;               // bastions
                case "sensor_post": height = .70f; return .30f;                        // the dish on the mast
                case "artillery_post": height = .28f; return .50f;                     // berm .42, blast ring .47
                case "repair_point": height = .38f; return .36f;
                case "town": height = .80f; return .54f;
                case "airfield": height = .30f; return .56f;
                case "missile_silo": height = .32f; return .54f;
                case "base_site": height = .30f; return .52f;
                default:
                    if (GameplayFacilities.Contains(type ?? "")) { height = .46f; return .54f; }
                    height = .40f; return -1f;
            }
        }

        /// <summary>A part in a structure's own frame (fixed ground datum, no parcel scale), tinted by damage and memory.</summary>
        void Sig(in Ctx c, Part part, float lx, float lz, float lift, float3 size, float3 color, float yawOffset = 0, float emission = 0)
        {
            math.sincos(c.Yaw, out float sn, out float cs);
            Put(part, new float3(c.X + lx * cs + lz * sn, c.GroundY + lift, c.Z - lx * sn + lz * cs), c.Yaw + yawOffset, size, color * c.Tint, emission);
        }

        /// <summary>
        /// The per-type signature of an authored field defense (CityRenderer.Defenses.cs) and its team rim. Frame: the
        /// recipe frame (+lz is the firing side, model +Y), ground at the defense datum.
        /// </summary>
        void DefenseSignature(in Ctx c, in BuildingRecord b, int level)
        {
            float glow = b.Memory ? 0f : 1f;
            var team = c.Civ;
            var concrete = new float3(.70f, .69f, .64f);
            switch (b.Type)
            {
                case "barricade": case "sandbags":
                    // low and long: striped marker posts at both ends with team caps
                    for (int s = -1; s <= 1; s += 2)
                    {
                        Sig(c, Part.Box, s * .25f, -.07f, 0, new float3(.018f, .10f, .018f), Hazard);
                        Sig(c, Part.Box, s * .25f, -.07f, .04f, new float3(.02f, .02f, .02f), PaintDark);
                        Sig(c, Part.Box, s * .25f, -.07f, .10f, new float3(.026f, .022f, .026f), team, 0, .5f * glow);
                    }
                    return;
                case "guard_post": case "watchtower":
                    // the tallest thin silhouette: a mast and a team beacon over the cabin roof
                    Sig(c, Part.Cylinder, 0, 0, .56f, new float3(.008f, .07f, .008f), SteelGrey);
                    Sig(c, Part.Box, 0, 0, .625f, new float3(.034f, .034f, .034f), team, 0, 1.2f * glow);
                    break;
                case "bunker":
                    // a squat concrete dome over the pillbox, a team cap and a periscope: "pillbox" at any zoom
                    Sig(c, Part.Dome, 0, 0, .185f, new float3(.30f, .065f, .30f), concrete * .92f);
                    Sig(c, Part.Cylinder, 0, 0, .245f, new float3(.12f, .012f, .12f), team, 0, .35f * glow);
                    Sig(c, Part.Cylinder, .05f, -.03f, .24f, new float3(.012f, .035f, .012f), PaintDark);
                    break;
                case "turret": case "at_emplacement":
                    // anti-armour: a row of dragon's teeth across the field of fire
                    for (int k = -2; k <= 2; k++)
                        Sig(c, Part.Cone, k * .085f, .385f - math.abs(k) * .025f, 0, new float3(.06f, .075f, .06f), concrete, k * .4f);
                    break;
                case "aa_battery":
                    // anti-air: a fire-director mast with a sky-facing dish behind the guns, a team band on the mast
                    Sig(c, Part.Cylinder, 0, -.25f, .04f, new float3(.016f, .38f, .016f), SteelGrey);
                    Sig(c, Part.Box, 0, -.25f, .30f, new float3(.03f, .03f, .03f), team, 0, .5f * glow);
                    Sig(c, Part.Dish, 0, -.25f, .40f, new float3(.16f, .10f, .16f), concrete, math.PI);
                    break;
                case "city_turret":
                    // perimeter MG: a team disc round the cupola and a searchlight mast at the rear
                    Sig(c, Part.Cylinder, 0, 0, .07f, new float3(.27f, .008f, .27f), team, 0, .3f * glow);
                    Sig(c, Part.Cylinder, 0, -.19f, 0, new float3(.009f, .24f, .009f), SteelGrey);
                    Sig(c, Part.Box, 0, -.185f, .235f, new float3(.03f, .022f, .03f), new float3(.95f, .92f, .78f), 0, .9f * glow);
                    break;
                case "fort": case "outpost":
                    // a team cap on each of the six bastions: the star outline reads as the owner's
                    for (int k = 0; k < 6; k++)
                    {
                        float a = math.PI / 6 + k * math.PI / 3;
                        Sig(c, Part.Cylinder, -math.sin(a) * .47f, math.cos(a) * .47f, .165f, new float3(.15f, .014f, .15f), team, 0, .35f * glow);
                    }
                    break;
                case "sensor_post":
                    // radar: a dish on the mast head and a team beacon above it
                    Sig(c, Part.Dish, 0, 0, .565f, new float3(.20f, .13f, .20f), concrete);
                    Sig(c, Part.Cylinder, 0, 0, .565f, new float3(.006f, .12f, .006f), SteelGrey);
                    Sig(c, Part.Box, 0, 0, .675f, new float3(.026f, .026f, .026f), team, 0, 1.1f * glow);
                    break;
                case "artillery_post":
                    // a camouflage net on poles over the ammunition bunker behind the gun, its front edge in the team colour
                    for (int sx = -1; sx <= 1; sx += 2)
                        for (int sz = 0; sz < 2; sz++)
                            Sig(c, Part.Cylinder, sx * .15f, -.20f - sz * .20f, 0, new float3(.008f, .17f, .008f), new float3(.45f, .37f, .26f));
                    Sig(c, Part.Box, 0, -.30f, .165f, new float3(.36f, .012f, .26f), Olive * .9f, 0);
                    Sig(c, Part.Box, .06f, -.31f, .175f, new float3(.22f, .010f, .16f), Olive * 1.12f, .35f);
                    Sig(c, Part.Box, 0, -.17f, .155f, new float3(.36f, .022f, .012f), team, 0, .4f * glow);
                    break;
                case "repair_point":
                    // a repair sign on the gantry: a team plate with a white cross
                    Sig(c, Part.Box, 0, .0f, .327f, new float3(.11f, .11f, .010f), team, 0, .35f * glow);
                    Sig(c, Part.Box, 0, .007f, .365f, new float3(.075f, .022f, .006f), White, 0, .3f * glow);
                    Sig(c, Part.Box, 0, .007f, .3445f, new float3(.022f, .065f, .006f), White, 0, .3f * glow);
                    break;
            }
            DefenseRim(c, b, level);
        }

        /// <summary>
        /// A crisp team rim on the ground just outside a defense's visible body (outside its blast ring from level 2),
        /// over a concrete apron where no field pad is drawn (inside a base's influence ring). Where the field pad
        /// (<see cref="FieldStructurePad"/>) already rings the body, the rim is left to it.
        /// </summary>
        void DefenseRim(in Ctx c, in BuildingRecord b, int level)
        {
            if (b.Owner < 0 || Showcase) return;
            var p = new float2(c.X, c.Z);
            if (OverWater(p)) return;
            float body = VisualExtent(b.Type, out _);
            if (body <= 0) return;
            // the body proper (the extent above includes the level 2+ blast ring and the signature)
            float r = DefenseKinds.TryGetValue(b.Type, out var kind) && kind.Ring > 0 && level >= 2 ? kind.Ring + .035f
                : b.Type == "fort" || b.Type == "outpost" ? body : body - .04f;
            bool padded = b.City <= 0 && ActionRts && b.Id >= 0;
            float pad = b.Type == "city_turret" || b.Type == "turret" ? .22f : .34f;
            if (padded && pad >= r - .03f) return;
            var team = c.Civ * c.Tint;
            if (!padded) GroundSector(p, 0, r, 0, 2 * math.PI, -.0036f, PadConcrete * c.Tint, Rendering.SurfaceKind.Concrete, 12);
            GroundSector(p, r, r + .026f, 0, 2 * math.PI, -.0012f, team, Rendering.SurfaceKind.Plain, 16);
        }

        /// <summary>
        /// The signature of an authored base facility, in its model frame (no parcel scale, fixed ground): a drill yard
        /// and radio mast at the barracks, a team gantry crane over a container stack at the supply centre, a proof tank
        /// on a turntable at the vehicle works. The headquarters has its tier dressing; the generator its smoke stacks.
        /// </summary>
        void FacilitySignature(in Ctx c, string type)
        {
            var team = c.Civ;
            var center = new float2(c.X, c.Z);
            switch (type)
            {
                case "barracks":
                {
                    // drill yard in front of the hall (team-edged), three timber hurdles on it
                    var yard = LocalToMap(center, c.Yaw, .17f, .27f);
                    GroundRect(yard, c.Yaw, 0, 0, .36f, .20f, -.0016f, new float3(.55f, .50f, .40f) * c.Tint, Rendering.SurfaceKind.Soil);
                    GroundRoundOutline(yard, c.Yaw, .36f, .20f, .03f, .014f, -.0010f, team * c.Tint, Rendering.SurfaceKind.Plain);
                    for (int k = 0; k < 3; k++)
                    {
                        float lx = .06f + k * .11f;
                        for (int s = -1; s <= 1; s += 2) Sig(c, Part.Box, lx + s * .03f, .27f, 0, new float3(.008f, .05f, .008f), new float3(.50f, .40f, .28f));
                        Sig(c, Part.Box, lx, .27f, .045f, new float3(.07f, .008f, .008f), new float3(.55f, .45f, .31f));
                    }
                    // radio mast at the rear corner, cross arms and a team beacon: the barracks' skyline
                    Sig(c, Part.Cylinder, -.38f, -.40f, 0, new float3(.012f, .62f, .012f), SteelGrey);
                    for (int k = 0; k < 2; k++) Sig(c, Part.Box, -.38f, -.40f, .42f + k * .1f, new float3(.09f - k * .025f, .006f, .006f), SteelGrey * 1.2f);
                    Sig(c, Part.Box, -.38f, -.40f, .62f, new float3(.03f, .03f, .03f), team, 0, 1.2f);
                    break;
                }
                case "depot":
                {
                    // a container stack in the front corner under a portal crane whose beam wears the team colour
                    // (clear of the three bay doors on the front face, lz .13)
                    Sig(c, Part.Box, .38f, .36f, 0, new float3(.20f, .07f, .08f), Container(c.Seed));
                    Sig(c, Part.Box, .38f, .45f, 0, new float3(.20f, .07f, .08f), Container(c.Seed + 5));
                    Sig(c, Part.Box, .38f, .36f, .07f, new float3(.20f, .07f, .08f), Container(c.Seed + 10));
                    for (int s = -1; s <= 1; s += 2)
                    {
                        Sig(c, Part.Box, .38f + s * .125f, .31f, 0, new float3(.014f, .24f, .014f), Hazard);
                        Sig(c, Part.Box, .38f + s * .125f, .49f, 0, new float3(.014f, .24f, .014f), Hazard);
                        Sig(c, Part.Box, .38f + s * .125f, .40f, .225f, new float3(.016f, .016f, .20f), Hazard * .9f);
                    }
                    Sig(c, Part.Box, .38f, .40f, .24f, new float3(.28f, .028f, .03f), team, 0, .35f);
                    break;
                }
                case "motor_works":
                {
                    // a proof tank on a turntable at the works' front: the product, at any zoom
                    var at = LocalToMap(center, c.Yaw, -.26f, .31f);
                    GroundSector(at, 0, .13f, 0, 2 * math.PI, -.0016f, new float3(.58f, .58f, .54f) * c.Tint, Rendering.SurfaceKind.Concrete, 12);
                    GroundSector(at, .13f, .152f, 0, 2 * math.PI, -.0010f, team * c.Tint, Rendering.SurfaceKind.Plain, 12);
                    const float turn = .6f;
                    math.sincos(turn, out float ts, out float tc);
                    var hull = Olive * 1.05f;
                    Sig(c, Part.Box, -.26f, .31f, .012f, new float3(.12f, .045f, .20f), hull, turn);
                    for (int s = -1; s <= 1; s += 2)
                        Sig(c, Part.Box, -.26f + s * .068f * tc, .31f - s * .068f * ts, 0, new float3(.032f, .04f, .21f), PaintDark * 1.6f, turn);
                    Sig(c, Part.Box, -.26f - .02f * ts, .31f - .02f * tc, .057f, new float3(.075f, .035f, .085f), hull * 1.08f, turn);
                    Sig(c, Part.Box, -.26f + .09f * ts, .31f + .09f * tc, .068f, new float3(.012f, .012f, .14f), PaintDark * 1.8f, turn);
                    Sig(c, Part.Box, -.26f - .02f * ts, .31f - .02f * tc, .093f, new float3(.03f, .006f, .03f), team, turn, .4f);
                    break;
                }
            }
        }
    }
}
