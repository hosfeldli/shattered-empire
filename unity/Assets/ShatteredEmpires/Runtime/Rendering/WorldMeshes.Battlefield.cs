using UnityEngine;

namespace SE.Runtime.Rendering
{
    static partial class WorldMeshes
    {
        public static Mesh LightVehicleWreck()
        {
            var metal = new Color(.48f, .45f, .38f); var rubber = new Color(.22f, .23f, .21f);
            var m = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Armor(P(0, .07f, 0), P(.54f, .10f, .91f), new Vector2(.47f, .83f), .04f, metal)
                .Box(P(.01f, .18f, .28f), P(.39f, .13f, .27f), metal)
                .Box(P(0, .15f, -.26f), P(.41f, .09f, .31f), metal)
                .Box(P(0, .16f, -.03f), P(.41f, .045f, .28f), rubber)
                .Beam(P(-.22f, .18f, .15f), P(-.18f, .39f, .06f), .014f, .01f, 5, Steel)
                .Beam(P(.22f, .18f, .15f), P(.13f, .30f, .03f), .015f, .008f, 5, Steel)
                .Beam(P(-.18f, .39f, .06f), P(.13f, .30f, .03f), .012f, .008f, 5, Steel)
                .Quad(P(-.21f, .22f, -.18f), P(-.21f, .26f, -.48f), P(.13f, .33f, -.44f), P(.18f, .24f, -.20f), metal);
            for (int side = -1; side <= 1; side += 2) for (int wheel = -1; wheel <= 1; wheel += 2)
                m.Surface(SurfaceKind.Rubber).Beam(P(side * .245f, .09f, wheel * .30f), P(side * .32f, .075f, wheel * .30f), .09f, .085f, 12, rubber)
                    .Surface(SurfaceKind.Armor).Beam(P(side * .32f, .075f, wheel * .30f), P(side * .33f, .075f, wheel * .30f), .043f, .043f, 8, metal);
            return m.Build("Burnt wheeled chassis with torn cabin and wheel remnants");
        }

        public static Mesh AircraftWreck()
        {
            var metal = new Color(.47f, .45f, .40f);
            return new MeshBuilder().Surface(SurfaceKind.Armor)
                .Beam(P(0, .08f, -.51f), P(.03f, .06f, .49f), .13f, .04f, 10, metal)
                .Quad(P(-.09f, .11f, .04f), P(-.75f, .01f, -.28f), P(-.43f, .025f, -.46f), P(-.06f, .08f, -.25f), metal)
                .Quad(P(.11f, .10f, .10f), P(.16f, .10f, -.23f), P(.39f, .015f, -.32f), P(.59f, .04f, -.09f), metal)
                .Beam(P(.02f, .09f, -.49f), P(.05f, .31f, -.51f), .045f, .017f, 6, Steel)
                .Surface(SurfaceKind.Glass).Armor(P(.02f, .14f, .15f), P(.16f, .035f, .22f), new Vector2(.09f, .15f), .02f, new Color(.21f, .27f, .26f))
                .Surface(SurfaceKind.SheetMetal).Quad(P(.17f, .04f, -.41f), P(.29f, .03f, -.59f), P(.52f, .03f, -.49f), P(.40f, .05f, -.30f), metal)
                .Build("Broken airframe with folded wing and separated tail panel");
        }

        public static Mesh SnappedTree()
        {
            var bark = new Color(.43f, .39f, .31f); var wood = new Color(.64f, .57f, .44f);
            var m = new MeshBuilder().Surface(SurfaceKind.Plain)
                .Beam(P(0, 0, 0), P(.05f, .73f, .03f), .12f, .075f, 9, bark)
                .Beam(P(.05f, .73f, .03f), P(-.016f, .91f, .02f), .038f, .005f, 5, wood)
                .Beam(P(.09f, .68f, .05f), P(.15f, .81f, .07f), .023f, .004f, 5, wood)
                .Beam(P(.02f, .41f, .01f), P(-.25f, .59f, .08f), .045f, .011f, 6, bark);
            for (int k = 0; k < 4; k++)
            {
                float a = k * 1.5708f;
                m.Beam(P(0, .15f, 0), P(Mathf.Cos(a) * .23f, .018f, Mathf.Sin(a) * .23f), .07f, .018f, 6, bark);
            }
            return m.Build("Splintered trunk with bark, exposed heartwood and roots");
        }

        public static Mesh FallenBranch() => new MeshBuilder()
            .Beam(P(-.38f, .05f, -.03f), P(.38f, .08f, .02f), .045f, .022f, 7, new Color(.39f, .36f, .29f))
            .Beam(P(.04f, .06f, 0), P(.20f, .09f, .25f), .024f, .008f, 6, new Color(.41f, .37f, .29f))
            .Beam(P(-.18f, .05f, -.02f), P(-.05f, .08f, -.22f), .018f, .007f, 5, new Color(.48f, .42f, .33f))
            .Build("Fallen forked timber");
    }
}
