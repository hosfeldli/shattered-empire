using UnityEngine;

namespace SE.Runtime.Rendering
{
    static partial class WorldMeshes
    {
        public static Mesh SatelliteDish()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.SheetMetal);
            const int sides = 24, rings = 5;
            Vector3 Point(float radius, float angle, float underside = 0)
                => Quaternion.Euler(31, 0, 0) * P(Mathf.Cos(angle) * radius, radius * radius * .74f + underside, Mathf.Sin(angle) * radius) + P(0, .23f, 0);
            for (int ring = 0; ring < rings; ring++) for (int side = 0; side < sides; side++)
            {
                float r0 = ring * .5f / rings, r1 = (ring + 1) * .5f / rings;
                float a = side * Mathf.PI * 2 / sides, b = (side + 1) * Mathf.PI * 2 / sides;
                m.Quad(Point(r0, a), Point(r0, b), Point(r1, b), Point(r1, a), new Color(.76f, .77f, .72f));
                m.Quad(Point(r0, a, -.012f), Point(r1, a, -.012f), Point(r1, b, -.012f), Point(r0, b, -.012f), Steel);
                if (ring == rings - 1) m.Beam(Point(r1, a), Point(r1, b), .012f, .012f, 5, Edge);
            }
            m.Beam(P(0, 0, 0), P(0, .23f, 0), .065f, .042f, 8, Steel)
                .Beam(Point(.45f, 0), Point(0, 0) + P(0, .35f, -.15f), .009f, .009f, 5, Steel)
                .Beam(Point(.45f, Mathf.PI), Point(0, 0) + P(0, .35f, -.15f), .009f, .009f, 5, Steel)
                .Box(Point(0, 0) + P(0, .32f, -.15f), P(.05f, .05f, .07f), Steel);
            return m.Build("Parabolic communications dish with ribs and receiver");
        }
    }
}
