using UnityEngine;

namespace SE.Runtime.Rendering
{
    // Shared botanical meshes, not one GameObject per leaf or plant. The LODs keep the same
    // trunk and crown envelope; distant forests retain their established silhouettes.
    static class VegetationMeshes
    {
        static float H(int i) => Mathf.Repeat(Mathf.Sin(i * 127.13f + 19.7f) * 43758.54f, 1);
        static Vector3 V(float a, float r, float y) => new Vector3(Mathf.Sin(a) * r, y, Mathf.Cos(a) * r);
        static readonly Color Bark = new Color(.39f, .28f, .18f);

        public static Mesh Tree(bool pine, bool low = false)
        {
            var m = new MeshBuilder();
            var fork = new Vector3(.025f, .48f, -.014f);
            m.Beam(Vector3.zero, fork, .048f, .026f, low ? 5 : 9, Bark)
                .Beam(fork, new Vector3(-.018f, 1.13f, .025f), .026f, .004f, low ? 4 : 7, Bark);
            for (int i = 0; i < (low ? 3 : 6); i++)
                m.Beam(V(i * 2.39996f, .10f, .006f), new Vector3(0, .15f, 0), .018f, .015f, 4, Bark);
            if (pine)
            {
                int tiers = low ? 6 : 9, arms = low ? 4 : 7;
                for (int k = 0; k < tiers; k++)
                {
                    float y = .22f + k * (.84f / tiers), reach = .37f * (1 - k / (tiers + 1.3f));
                    for (int j = 0; j < arms; j++)
                    {
                        float a = j * Mathf.PI * 2 / arms + k * 1.37f;
                        var tip = V(a, reach, y + .035f + H(k * 17 + j) * .035f);
                        m.Beam(new Vector3(0, y + .055f, 0), tip, .012f, .003f, 4, Bark);
                        for (int p = 0; p < (low ? 2 : 4); p++)
                        {
                            var center = Vector3.Lerp(new Vector3(0, y + .06f, 0), tip, .38f + p * .19f);
                            float r = (low ? .10f : .074f) * (1 - k / (tiers + 3f));
                            Spray(m, center, r, a + p * .81f, low ? 4 : 7, true, k * 37 + j * 9 + p);
                        }
                    }
                }
                Spray(m, new Vector3(-.018f, 1.10f, .025f), .065f, 0, 7, true, 81);
            }
            else
            {
                int arms = low ? 7 : 11;
                for (int k = 0; k < arms; k++)
                {
                    float a = k * 2.39996f, reach = .20f + H(k + 6) * .10f;
                    float y = .55f + (k / (float)arms) * .43f;
                    var start = new Vector3(.016f, .29f + k * .035f, 0);
                    var elbow = V(a, reach * .53f, y - .12f);
                    var end = V(a + .18f, reach, y);
                    m.Beam(start, elbow, .023f - k * .0012f, .010f, low ? 4 : 6, Bark)
                        .Beam(elbow, end, .010f, .003f, 4, Bark);
                    int twigs = low ? 2 : 4;
                    for (int j = 0; j < twigs; j++)
                    {
                        float b = a + (j - (twigs - 1) * .5f) * .85f;
                        var twig = end + V(b, .065f + H(k * 7 + j) * .055f, (j % 2) * .045f);
                        if (!low) m.Beam(Vector3.Lerp(elbow, end, .6f), twig, .005f, .0015f, 3, Bark);
                        Spray(m, twig, low ? .13f : .095f, b, low ? 5 : 12, false, k * 29 + j * 7);
                    }
                }
                Spray(m, new Vector3(-.02f, 1.04f, .025f), .12f, .3f, low ? 7 : 18, false, 401);
            }
            return m.Build((pine ? "Branching fir" : "Asymmetric broadleaf") + (low ? " canopy LOD" : " leaf canopy"));
        }

        static void Spray(MeshBuilder m, Vector3 center, float radius, float rotation, int leaves, bool pine, int seed)
        {
            if (!pine)
            {
                // Each cutout is a photographed twig containing many small leaves. Several
                // intersecting sprays make a full crown without oversized polygon leaves.
                int sprays = leaves > 8 ? 5 : 3;
                m.Surface(SurfaceKind.Foliage);
                for (int j = 0; j < sprays; j++)
                {
                    float a = rotation + j * 2.39996f;
                    var p = center + V(a, radius * .46f, (H(seed + j * 3) - .5f) * radius);
                    var right = V(a, radius * (1.15f + H(seed + j) * .45f), .025f * (H(seed + j * 7) - .5f));
                    var up = new Vector3(-Mathf.Cos(a) * .025f, .025f + H(seed + j * 11) * .045f, Mathf.Sin(a) * .025f);
                    var col = Color.Lerp(new Color(.83f, .88f, .77f), Color.white, H(seed + j * 13));
                    m.Quad(p - right - up, p + right - up, p + right + up, p - right + up, col);
                }
                m.Surface(SurfaceKind.Plain);
                return;
            }
            for (int j = 0; j < leaves; j++)
            {
                float a = rotation + j * 2.39996f, r = radius * Mathf.Sqrt(H(seed + j * 3));
                var p = center + V(a, r, (H(seed + j * 7) - .5f) * radius * 1.1f);
                var along = V(a + .5f, .040f + H(seed + j) * .024f, .012f + H(seed + j * 13) * .022f);
                var side = V(a + Mathf.PI * .5f + .5f, .010f, 0);
                var col = Color.Lerp(new Color(.67f, .74f, .59f), new Color(1, 1, .91f), H(seed + j * 11));
                Leaf(m, p - along * .45f, p + side, p + along * .55f, p - side, col);
            }
        }

        static void Leaf(MeshBuilder m, Vector3 a, Vector3 b, Vector3 c, Vector3 d, Color color)
        {
            m.Quad(a, b, c, d, color);
        }

        public static Mesh Grass()
        {
            var m = new MeshBuilder();
            for (int i = 0; i < 34; i++)
            {
                float a = i * 2.39996f, r = Mathf.Sqrt(H(i + 8)) * .20f;
                var p = V(a, r, 0); float height = .035f + H(i + 4) * .065f;
                var side = V(a + 1.57f, .003f + H(i) * .003f, 0);
                var bend = p + V(a, .020f, height * .58f); var tip = p + V(a, .065f, height);
                var col = Color.Lerp(new Color(.83f, .87f, .65f), Color.white, H(i + 11));
                m.Quad(p - side, p + side, bend + side * .55f, bend - side * .55f, col * .87f);
                m.Tri(bend - side * .55f, bend + side * .55f, tip, col);
            }
            return m.Build("Wind swept grass tuft");
        }

        public static Mesh Understory()
        {
            var m = new MeshBuilder();
            for (int k = 0; k < 6; k++)
            {
                float a = k * 2.39996f;
                var tip = V(a, .21f, .08f + H(k) * .16f);
                m.Beam(Vector3.zero, tip, .006f, .002f, 3, Bark);
                Spray(m, tip, .075f, a, 8, false, k * 41);
            }
            return m.Build("Fern and woodland understory");
        }

        public static Mesh DistantCanopy(bool pine)
        {
            var m = new MeshBuilder().Beam(Vector3.zero, Vector3.up * .75f, .035f, .012f, 4, Bark);
            if (pine)
                for (int i = 0; i < 4; i++) m.Cylinder(Vector3.up * (.22f + i * .20f), .33f - i * .065f, .015f, .35f, 6, Color.white);
            else
            {
                m.Blob(new Vector3(.03f, .77f, 0), new Vector3(.34f, .29f, .31f), Color.white);
                m.Blob(new Vector3(-.12f, .66f, .12f), new Vector3(.22f, .20f, .22f), new Color(.83f, .89f, .77f));
            }
            return m.Build(pine ? "Distant fir silhouette" : "Distant broadleaf silhouette");
        }
    }
}
