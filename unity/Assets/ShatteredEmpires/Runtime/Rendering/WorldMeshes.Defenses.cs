using UnityEngine;

namespace SE.Runtime.Rendering
{
    static partial class WorldMeshes
    {
        public static Mesh StrategicHatch()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Concrete);
            var concrete = new Color(.68f, .66f, .60f); var metal = new Color(.37f, .39f, .36f);
            m.Cylinder(Vector3.zero, .52f, .51f, .055f, 32, concrete)
                .Surface(SurfaceKind.Rubber).Cylinder(new Vector3(0, .055f, 0), .43f, .43f, .008f, 32, new Color(.20f, .21f, .20f))
                .Surface(SurfaceKind.Armor).Cylinder(new Vector3(0, .063f, 0), .408f, .408f, .025f, 32, metal);
            m.Box(new Vector3(0, .089f, 0), new Vector3(.012f, .004f, .79f), new Color(.16f, .17f, .16f));
            foreach (float x in new[] { -.20f, .20f })
                m.Box(new Vector3(x, .089f, 0), new Vector3(.04f, .026f, .65f), metal * 1.14f);
            for (int i = 0; i < 8; i++)
            {
                float a = i * Mathf.PI / 4; var p = new Vector3(Mathf.Sin(a) * .46f, .06f, Mathf.Cos(a) * .46f);
                m.Cylinder(p, .022f, .018f, .028f, 8, metal * 1.2f);
            }
            return m.Build("Buried armored strategic silo hatch and concrete collar");
        }

        public static Mesh StrategicMissile()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Armor);
            var paint = new Color(.74f, .74f, .69f); var dark = new Color(.23f, .25f, .23f);
            m.Beam(new Vector3(0, 0, -.52f), new Vector3(0, 0, .34f), .065f, .065f, 12, paint)
                .Beam(new Vector3(0, 0, .34f), new Vector3(0, 0, .63f), .065f, .002f, 12, dark)
                .Beam(new Vector3(0, 0, -.55f), new Vector3(0, 0, -.46f), .047f, .058f, 12, dark)
                .Beam(new Vector3(0, 0, .19f), new Vector3(0, 0, .22f), .067f, .067f, 12, dark);
            for (int i = 0; i < 4; i++)
            {
                float a = i * Mathf.PI * .5f; var edge = new Vector3(Mathf.Cos(a), Mathf.Sin(a), 0);
                var p = new Vector3(0, 0, -.48f) + edge * .06f;
                m.Tri(p, p + edge * .11f, p + Vector3.forward * .26f, paint)
                    .Tri(p + Vector3.forward * .26f, p + edge * .11f, p, paint);
            }
            return m.Build("Strategic missile body, reentry nose and stabilizers");
        }

        public static Mesh WireBelt()
        {
            var m = new MeshBuilder(); var steel = new Color(.52f, .53f, .50f);
            // Full-volume concertina wire, supported by driven steel pickets. The coil is
            // circular in cross-section; its height is never flattened into a ground decal.
            for (int i = 0; i < 120; i++)
            {
                float a = i * Mathf.PI * 10 / 120, b = (i + 1) * Mathf.PI * 10 / 120;
                var p = new Vector3(-.5f + i / 120f, .38f + Mathf.Sin(a) * .32f, Mathf.Cos(a) * .32f);
                var q = new Vector3(-.5f + (i + 1) / 120f, .38f + Mathf.Sin(b) * .32f, Mathf.Cos(b) * .32f);
                m.Beam(p, q, .009f, .009f, 4, steel);
                if (i % 5 == 0)
                {
                    var barb = new Vector3(0, Mathf.Sin(a), Mathf.Cos(a)) * .045f;
                    m.Beam(p - barb, p + barb, .007f, .001f, 3, steel)
                        .Beam(p - new Vector3(.025f, .02f, 0), p + new Vector3(.025f, -.02f, 0), .006f, .001f, 3, steel);
                }
            }
            foreach (float x in new[] { -.47f, .47f })
                m.Beam(new Vector3(x, 0, 0), new Vector3(x + .035f, .83f, 0), .021f, .016f, 5, steel);
            m.Beam(new Vector3(-.5f, .66f, 0), new Vector3(.5f, .66f, 0), .008f, .008f, 4, steel);
            return m.Build("Raised concertina wire with pickets and barbs");
        }

        public static Mesh TankObstacle()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Armor);
            var steel = new Color(.49f, .44f, .36f);
            // Three interlocking, flanged steel beams: a Czech hedgehog rather than a flat X.
            void Girder(Vector3 a, Vector3 b, Vector3 flange)
            {
                m.Beam(a, b, .045f, .045f, 4, steel);
                m.Beam(a + flange, b + flange, .027f, .027f, 4, steel * 1.12f)
                    .Beam(a - flange, b - flange, .027f, .027f, 4, steel * 1.12f);
            }
            Girder(new Vector3(-.43f, .03f, -.12f), new Vector3(.43f, .89f, .12f), new Vector3(0, 0, .048f));
            Girder(new Vector3(.43f, .03f, -.12f), new Vector3(-.43f, .89f, .12f), new Vector3(0, 0, .048f));
            Girder(new Vector3(0, .46f, -.57f), new Vector3(0, .46f, .57f), new Vector3(.048f, 0, 0));
            m.Box(new Vector3(0, .39f, 0), new Vector3(.16f, .16f, .16f), steel * .85f);
            foreach (float x in new[] { -.059f, .059f })
                m.Beam(new Vector3(x, .44f, -.11f), new Vector3(x, .44f, .11f), .015f, .015f, 6, new Color(.58f, .57f, .52f));
            return m.Build("Three dimensional steel tank obstacle");
        }
    }
}
