using UnityEngine;

namespace SE.Runtime.Rendering
{
    static partial class WorldMeshes
    {
        static Vector3 P(float x, float y, float z) => new Vector3(x, y, z);
        static readonly Color Stone = new Color(.80f, .78f, .73f);
        static readonly Color Edge = new Color(.58f, .55f, .51f);
        static readonly Color Steel = new Color(.43f, .46f, .46f);

        public static Mesh Tower(bool damaged)
        {
            if (damaged) return RuinedFrame();
            var m = new MeshBuilder().Surface(SurfaceKind.Concrete);
            int floors = damaged ? 5 : 9;
            float rise = damaged ? .178f : .105f;
            for (int i = 0; i <= floors; i++)
            {
                float y = i * rise;
                float slab = damaged && i > 2 ? .62f + (i % 3) * .10f : 1f;
                m.Surface(SurfaceKind.Concrete).Box(P((1f - slab) * -.3f, y, 0), P(slab, .025f, slab), i == 0 ? Edge : Stone);
                if (i == floors) break;
                for (int side = -1; side <= 1; side += 2)
                    for (int bay = 0; bay < 4; bay++)
                    {
                        float x = (bay - 1.5f) * .237f;
                        if (damaged && i > 1 && (i + bay + side + 1) % 4 < 2) continue;
                        m.Surface(SurfaceKind.Concrete).Box(P(x, y + .024f, side * .483f), P(.031f, rise * .93f, .038f), Stone)
                            .Box(P(side * .483f, y + .024f, x), P(.037f, rise * .93f, .033f), Stone);
                        if (damaged)
                        {
                            m.Surface(SurfaceKind.Armor).Beam(P(x, y + rise, side * .483f),
                                P(x - .024f, y + rise + .060f, side * .514f), .005f, .004f, 4, Steel);
                            continue;
                        }
                        var glass = Color.Lerp(new Color(.43f, .58f, .66f), new Color(.72f, .79f, .83f), ((i * 13 + bay * 7 + side + 1) % 11) / 12f);
                        m.Surface(SurfaceKind.Glass).Box(P(x + .074f, y + .028f, side * .484f), P(.139f, rise - .035f, .020f), glass)
                            .Box(P(side * .484f, y + .028f, x + .074f), P(.020f, rise - .035f, .139f), glass);
                    }
            }
            m.Surface(SurfaceKind.Concrete);
            if (!damaged)
                m.Box(P(.17f, .965f, -.12f), P(.33f, .095f, .31f), Stone)
                    .Surface(SurfaceKind.SheetMetal).Box(P(.15f, 1.06f, -.12f), P(.24f, .021f, .23f), Steel)
                    .Beam(P(-.27f, .95f, .30f), P(-.27f, 1.13f, .30f), .012f, .006f, 5, Steel);
            else
                m.Armor(P(-.11f, .03f, .09f), P(.66f, .10f, .47f), new Vector2(.38f, .26f), .09f, Edge)
                    .Armor(P(.27f, .01f, -.32f), P(.26f, .07f, .32f), new Vector2(.15f, .19f), .04f, Stone);
            return m.Build(damaged ? "Broken concrete frame and exposed rebar" : "Curtain wall and rooftop plant");
        }

        public static Mesh Tree(bool conifer)
        {
            var bark = new Color(.41f, .34f, .25f);
            var m = new MeshBuilder().Cylinder(Vector3.zero, conifer ? .043f : .065f, .023f, .72f, 6, bark);
            if (conifer)
            {
                for (int k = 0; k < 5; k++)
                {
                    float y = .16f + k * .14f, r = .34f - k * .051f;
                    var color = Color.Lerp(new Color(.73f, .79f, .69f), Color.white, k * .19f);
                    m.Cylinder(P(Mathf.Sin(k * 4f) * .022f, y, Mathf.Cos(k * 3f) * .027f), r, .034f, .36f, 9, color);
                }
            }
            else
            {
                for (int k = 0; k < 6; k++)
                {
                    float a = k * 2.39996f;
                    float x = Mathf.Cos(a), z = Mathf.Sin(a), y = .59f + (k % 3) * .095f;
                    m.Beam(P(0, .29f + k * .044f, 0), P(x * .22f, y, z * .22f), .031f, .009f, 5, bark)
                        .Blob(P(x * .207f, y, z * .207f), P(.235f, .185f + k % 2 * .05f, .234f),
                            Color.Lerp(new Color(.75f, .79f, .69f), Color.white, k / 6f));
                }
                m.Blob(P(.02f, .88f, .04f), P(.24f, .20f, .23f), new Color(.93f, .96f, .88f));
            }
            return m.Build(conifer ? "Layered conifer" : "Broadleaf canopy");
        }

        public static Mesh Wreck()
        {
            var scorch = new Color(.34f, .27f, .23f);
            return new MeshBuilder().Surface(SurfaceKind.Armor)
                .Armor(P(0, .051f, 0), P(.66f, .19f, .99f), new Vector2(.50f, .83f), .10f, scorch)
                .Armor(P(.09f, .20f, -.12f), P(.43f, .12f, .42f), new Vector2(.27f, .34f), .095f, Edge * .64f)
                .Beam(P(.14f, .28f, .06f), P(.27f, .18f, .49f), .037f, .026f, 8, scorch)
                .Surface(SurfaceKind.Rubber).Armor(P(-.36f, .02f, .015f), P(.17f, .14f, .95f), new Vector2(.14f, .91f), .045f, Steel * .56f)
                .Armor(P(.40f, .008f, -.16f), P(.15f, .089f, .72f), new Vector2(.14f, .67f), .06f, Steel * .50f)
                .Surface(SurfaceKind.Armor).Beam(P(.46f, .05f, -.27f), P(.55f, .05f, -.26f), .075f, .065f, 9, Edge * .61f)
                .Beam(P(.42f, .023f, .25f), P(.57f, .021f, .31f), .071f, .064f, 9, Steel * .64f).Build("Scorched armored hull");
        }
    }
}
