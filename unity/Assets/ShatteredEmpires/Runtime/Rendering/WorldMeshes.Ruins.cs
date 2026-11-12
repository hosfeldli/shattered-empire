using UnityEngine;

namespace SE.Runtime.Rendering
{
    static partial class WorldMeshes
    {
        static readonly Color RuinConcrete = new Color(.59f, .60f, .57f);
        static readonly Color RuinEdge = new Color(.67f, .66f, .61f);
        static readonly Color RuinInterior = new Color(.31f, .32f, .30f);
        static readonly Color RuinBrick = new Color(.52f, .47f, .40f);

        static Mesh RuinedFrame()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Concrete);
            m.Box(P(-.27f, .02f, -.25f), P(.26f, .84f, .29f), RuinInterior)
                .Box(Vector3.zero, P(.98f, .035f, .95f), RuinInterior);
            for (int floor = 0; floor < 5; floor++)
            {
                float y = .04f + floor * .16f;
                if (floor == 4)
                    m.Armor(P(-.14f, y, -.09f), P(.69f, .027f, .74f), new Vector2(.67f, .71f), .055f, RuinConcrete);
                else
                    m.Armor(P(-.015f, y, -.015f), P(.94f, .024f, .91f), new Vector2(.93f, .90f), .022f, RuinConcrete);
                // The lower storeys keep their original footprint. A damaged upper
                // corner opens the structure without turning it into a stepped pyramid.
                if (floor == 4) break;
                for (int bay = 0; bay < 4; bay++)
                {
                    float x = -.43f + bay * .28f;
                    m.Box(P(x, y + .024f, -.43f), P(.033f, .137f, .035f), RuinConcrete);
                    if (!(floor >= 2 && bay >= 2))
                        m.Box(P(x, y + .024f, .42f), P(.035f, .137f, .034f), RuinEdge);
                    if (!(floor >= 3 && bay == 3))
                        m.Box(P(-.45f, y + .024f, x), P(.034f, .137f, .035f), RuinConcrete);
                    if (bay < 2)
                        m.Box(P(.43f, y + .024f, x), P(.034f, .137f, .035f), RuinConcrete);
                    if (bay >= 3 || floor >= 3 && bay > 0) continue;
                    float across = x + .14f;
                    m.Surface(SurfaceKind.Brick).Box(P(across, y + .024f, .416f), P(.245f, .034f, .026f), RuinBrick)
                        .Surface(SurfaceKind.Concrete).Box(P(across, y + .13f, .419f), P(.245f, .020f, .031f), RuinConcrete);
                    if ((floor == 0 && bay == 1) || (floor == 1 && bay == 0))
                        m.Surface(SurfaceKind.Glass).Box(P(across - .04f, y + .061f, .419f), P(.10f, .059f, .008f), new Color(.27f, .33f, .33f))
                            .Surface(SurfaceKind.Concrete);
                }
            }
            m.Armor(P(.23f, .03f, .20f), P(.38f, .12f, .40f), new Vector2(.27f, .29f), .08f, RuinInterior)
                .Surface(SurfaceKind.Armor).Beam(P(.29f, .19f, .38f), P(.34f, .24f, .39f), .005f, .004f, 4, Steel * .65f);
            return m.Build("Damaged reinforced frame with facade bays and a surviving core");
        }

        public static Mesh Shell()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Concrete)
                .Box(Vector3.zero, P(.97f, .036f, .91f), RuinInterior);
            for (int bay = 0; bay < 4; bay++)
            {
                float x = -.44f + bay * .29f;
                float height = bay == 2 ? .64f : bay == 3 ? .75f : .87f;
                m.Box(P(x, .036f, -.43f), P(.052f, height, .057f), RuinConcrete);
                if (bay >= 3) continue;
                m.Surface(SurfaceKind.Brick).Box(P(x + .145f, .036f, -.43f), P(.24f, .28f, .05f), RuinBrick)
                    .Surface(SurfaceKind.Concrete);
                if (bay < 2) m.Box(P(x + .145f, .71f, -.43f), P(.27f, .05f, .057f), RuinEdge);
            }
            m.Surface(SurfaceKind.Brick).Box(P(-.45f, .036f, -.19f), P(.052f, .56f, .49f), RuinBrick)
                .Box(P(.45f, .036f, -.29f), P(.05f, .35f, .29f), RuinBrick)
                .Surface(SurfaceKind.Concrete)
                .Box(P(-.45f, .036f, .40f), P(.065f, .76f, .063f), RuinConcrete)
                .Box(P(.44f, .036f, .40f), P(.063f, .49f, .065f), RuinConcrete)
                .Box(P(-.22f, .036f, .42f), P(.40f, .20f, .05f), RuinConcrete)
                .Box(P(-.25f, .70f, .41f), P(.43f, .047f, .058f), RuinConcrete)
                .Armor(P(.13f, .037f, -.07f), P(.51f, .078f, .38f), new Vector2(.36f, .26f), .07f, RuinInterior);
            return m.Build("Masonry shell with open window bays and broken lintels");
        }

        public static Mesh CollapsedBlock()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Concrete)
                .Armor(P(0, 0, 0), P(.97f, .10f, .94f), new Vector2(.78f, .73f), .14f, RuinInterior);
            for (int i = 0; i < 4; i++)
            {
                float z = -.25f + i * .16f, y = .06f + i * .042f;
                var a = P(-.36f + i * .018f, y, z - .17f);
                var b = P(.36f - i * .049f, y + .017f, z - .13f);
                var c = P(.34f - i * .035f, y + .10f, z + .14f);
                var d = P(-.39f + i * .025f, y + .08f, z + .11f);
                m.Quad(a, d, c, b, Color.Lerp(RuinConcrete, RuinEdge, i * .17f))
                    .Quad(a - P(0, .023f, 0), a, b, b - P(0, .023f, 0), RuinInterior);
            }
            m.Box(P(-.36f, .05f, -.35f), P(.07f, .38f, .07f), RuinConcrete)
                .Box(P(-.19f, .06f, -.35f), P(.045f, .24f, .05f), RuinConcrete)
                .Surface(SurfaceKind.Armor).Beam(P(-.34f, .13f, .20f), P(.29f, .21f, .33f), .009f, .007f, 5, Steel * .65f);
            return m.Build("Collapsed reinforced slabs and a fractured column base");
        }
    }
}
