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
        }

        void Arsenal(in Ctx c)
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
            for (int k = 0; k < 3; k++) Module(c, Part.Siding, -.37f + k * .14f, .37f, new float3(.095f, .06f, .10f), Olive * .84f);
            RoofPlant(c, -.30f, -.27f, .39f, 1);
            Flag(c, .31f, .34f, .39f);
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
        }

        void StrategicFacility(in Ctx c)
        {
            Module(c, Part.Concrete, -.10f, -.17f, new float3(.69f, .18f, .59f), FacilityConcrete * .85f);
            for (int side = -1; side <= 1; side += 2)
            {
                Module(c, Part.Siding, -.10f + side * .12f, -.17f, new float3(.225f, .032f, .39f), FacilitySteel, 0, .18f);
                Module(c, Part.Concrete, -.10f + side * .38f, -.17f, new float3(.044f, .27f, .68f), FacilityConcrete);
            }
            Module(c, Part.Concrete, -.10f, -.51f, new float3(.80f, .26f, .045f), FacilityConcrete);
            Module(c, Part.Concrete, .39f, .17f, new float3(.23f, .17f, .34f), FacilityConcrete);
            Shutter(c, .39f, .347f, .12f, .13f);
            Module(c, Part.Cylinder, .42f, .12f, new float3(.018f, .30f, .018f), FacilitySteel, 0, .17f);
            Module(c, Part.Dish, .42f, .12f, new float3(.14f, .10f, .14f), FacilityConcrete, -.5f, .45f);
            Module(c, Part.Asphalt, -.16f, .30f, new float3(.50f, .004f, .26f), new float3(.38f, .40f, .39f));
            for (int side = -1; side <= 1; side += 2)
                Module(c, Part.Cylinder, -.10f + side * .31f, .18f, new float3(.012f, .18f, .012f), FacilitySteel);
        }
    }
}
