using System.Collections.Generic;
using SE.Runtime.Rendering;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Horde
{
    /// <summary>
    /// The Blight's creature models, three levels of detail per kind (original designs). The authored ones are sculpted
    /// in Blender by tools/blender/build_horde.py (Resources/Models/Horde_&lt;Kind&gt;&lt;lod&gt;.bytes): LOD0 a remeshed,
    /// sculpted and decimated surface, LOD1 the same decimated to about a third, LOD2 the bare primitives (silhouette).
    /// When a model is missing the code-built fallback below stands in for every level. Each model faces +z, stands on
    /// y = 0 and is about one unit long or tall; HordeRenderer scales it and SE/HordeLit animates it from per-vertex tags:
    /// uv0.x = animation region + phase (turns), uv0.y = weight, colour alpha = 1 - glow (see HordeLit.shader).
    /// Palette: pale grey-yellow flesh, bruise purple, bile green, yellowed bone and wet red sinew (no team colour).
    /// </summary>
    public static class HordeMeshes
    {
        public const int Kinds = 7, Lods = 3;
        public static readonly string[] Names = { "Crawler", "Husk", "Spitter", "Mauler", "Broodsac", "Colossus", "Hive" };
        public const float Body = 0, Leg = 1, Arm = 2, Sac = 3, Head = 4, Spine = 5, Jaw = 6;

        public static readonly Color Flesh = new Color(.62f, .58f, .44f), FleshDark = new Color(.42f, .37f, .3f), Bruise = new Color(.36f, .22f, .3f),
            Bile = new Color(.56f, .7f, .18f), BileDark = new Color(.26f, .33f, .1f), Bone = new Color(.8f, .74f, .58f), Sinew = new Color(.5f, .14f, .12f),
            Rot = new Color(.2f, .22f, .13f), Uniform = new Color(.3f, .33f, .23f), Pus = new Color(.85f, .8f, .45f), Gum = new Color(.42f, .11f, .14f);

        /// <summary>[kind, lod] models; [kind, *] are the same fallback mesh when the authored set is missing.</summary>
        public static readonly Mesh[,] Models = new Mesh[Kinds, Lods];
        /// <summary>Hive roots laid along the ground (SE/InstancedLit).</summary>
        public static Mesh Tendril;
        /// <summary>How many of the 21 models came from Blender.</summary>
        public static int Authored { get; private set; }

        static bool built;

        public static void Build()
        {
            if (built) return;
            built = true;
            for (int k = 0; k < Kinds; k++)
            {
                Mesh fallback = null;
                for (int l = 0; l < Lods; l++)
                {
                    var m = ModelLibrary.Get("Horde_" + Names[k] + l);
                    if (m != null) { Authored++; Models[k, l] = m; continue; }
                    fallback ??= BuildFallback(k);
                    Models[k, l] = fallback;
                }
            }
            Tendril = new MeshBuilder().Beam(new Vector3(0, .02f, 0), new Vector3(0, .02f, 1f), .06f, .015f, 5, Rot).Build("Blight tendril");
        }

        /// <summary>Triangles per level (for the docs and the debug overlay).</summary>
        public static int Triangles(int kind, int lod) => Models[kind, lod] != null ? (int)Models[kind, lod].GetIndexCount(0) / 3 : 0;

        // ------------------------------------------------------------------------------------- code-built fallback
        /// <summary>A tiny builder that tags every vertex for SE/HordeLit (region, phase, weight, glow).</summary>
        sealed class Tagged
        {
            readonly List<Vector3> v = new List<Vector3>(), n = new List<Vector3>();
            readonly List<Color32> c = new List<Color32>();
            readonly List<Vector2> uv = new List<Vector2>();
            readonly List<int> t = new List<int>();

            void Vertex(Vector3 p, Vector3 normal, Color col, float region, float phase, float w, float glow)
            {
                v.Add(p); n.Add(normal);
                col.a = 1f - glow;
                c.Add(col);
                uv.Add(new Vector2(region + Mathf.Clamp(phase, 0, .98f), Mathf.Clamp01(w)));
            }

            // Unity front faces have normal Cross(b - a, c - a); flip any triangle that disagrees with its vertex normals.
            void Face(int a, int b, int d)
            {
                if (Vector3.Dot(Vector3.Cross(v[b] - v[a], v[d] - v[a]), n[a] + n[b] + n[d]) < 0) { int s = b; b = d; d = s; }
                t.Add(a); t.Add(b); t.Add(d);
            }

            public Tagged Ellipsoid(Vector3 center, Vector3 r, Color col, float region = Body, float w = 0, float phase = 0, float glow = 0, int rings = 5, int sides = 9)
            {
                int start = v.Count;
                for (int y = 0; y <= rings; y++) for (int x = 0; x <= sides; x++)
                {
                    float pitch = Mathf.PI * y / rings, yaw = Mathf.PI * 2 * x / sides;
                    var d = new Vector3(Mathf.Sin(pitch) * Mathf.Cos(yaw), Mathf.Cos(pitch), Mathf.Sin(pitch) * Mathf.Sin(yaw));
                    Vertex(center + Vector3.Scale(d, r), new Vector3(d.x / r.x, d.y / r.y, d.z / r.z).normalized, col, region, phase, w, glow);
                }
                for (int y = 0; y < rings; y++) for (int x = 0; x < sides; x++)
                {
                    int a = start + y * (sides + 1) + x, b = a + 1, d = a + sides + 1;
                    Face(a, b, d); Face(b, d + 1, d);
                }
                return this;
            }

            /// <summary>A tapered tube from a to b, weights w0 at a and w1 at b.</summary>
            public Tagged Tube(Vector3 a, Vector3 b, float ra, float rb, Color col, float region = Body, float w0 = 0, float w1 = 0, float phase = 0, float glow = 0, int sides = 5)
            {
                var axis = (b - a).normalized;
                var side = Vector3.Cross(axis, Mathf.Abs(axis.y) < .9f ? Vector3.up : Vector3.right).normalized;
                var up = Vector3.Cross(side, axis);
                int start = v.Count;
                for (int k = 0; k <= sides; k++)
                {
                    float ang = Mathf.PI * 2 * k / sides;
                    var radial = side * Mathf.Cos(ang) + up * Mathf.Sin(ang);
                    Vertex(a + radial * ra, radial, col, region, phase, w0, glow);
                    Vertex(b + radial * rb, radial, col, region, phase, w1, glow);
                }
                for (int k = 0; k < sides; k++)
                {
                    int i = start + k * 2;
                    Face(i, i + 1, i + 2); Face(i + 1, i + 3, i + 2);
                }
                return this;
            }

            public Mesh Build(string name)
            {
                var m = new Mesh { name = name, indexFormat = v.Count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
                m.SetVertices(v); m.SetNormals(n); m.SetColors(c); m.SetUVs(0, uv); m.SetTriangles(t, 0);
                m.RecalculateBounds();
                m.UploadMeshData(true);
                return m;
            }
        }

        static Mesh BuildFallback(int kind)
        {
            var b = new Tagged();
            switch (kind)
            {
                case 0:   // crawler: a long body slung between six high-kneed legs, bead eyes, mandibles, dorsal spines
                    b.Ellipsoid(new Vector3(0, .32f, -.05f), new Vector3(.24f, .17f, .42f), Flesh);
                    b.Ellipsoid(new Vector3(.04f, .4f, .1f), new Vector3(.16f, .12f, .18f), Bruise, rings: 4, sides: 8);
                    b.Ellipsoid(new Vector3(0, .3f, .42f), new Vector3(.13f, .11f, .14f), FleshDark, Head, 1, rings: 4, sides: 8);
                    b.Ellipsoid(new Vector3(.05f, .36f, .52f), new Vector3(.03f, .03f, .03f), Pus, Head, 1, glow: 1, rings: 3, sides: 5);
                    b.Ellipsoid(new Vector3(-.05f, .36f, .52f), new Vector3(.03f, .03f, .03f), Pus, Head, 1, glow: 1, rings: 3, sides: 5);
                    for (int s = -1; s <= 1; s += 2)
                    {
                        b.Tube(new Vector3(s * .06f, .27f, .5f), new Vector3(s * .13f, .18f, .7f), .03f, .006f, Bone, Jaw, .3f, 1, s < 0 ? 0 : .5f, sides: 4);
                        for (int k = 0; k < 3; k++)
                        {
                            float z = -.25f + k * .25f, flare = s * (k == 1 ? .05f : 0);
                            float ph = ((k + (s > 0 ? 1 : 0)) % 2) * .5f;
                            var hip = new Vector3(s * .16f, .32f, z);
                            var knee = new Vector3(s * (.52f + flare), .58f, z + (k - 1) * .16f);
                            var foot = new Vector3(s * .74f, 0f, z + (k - 1) * .34f);
                            b.Tube(hip, knee, .045f, .03f, FleshDark, Leg, 0, .6f, ph, sides: 4);
                            b.Tube(knee, foot, .03f, .008f, Bone, Leg, .6f, 1, ph, sides: 4);
                        }
                    }
                    for (int k = 0; k < 4; k++)
                        b.Tube(new Vector3((k % 2 - .5f) * .08f, .44f, -.3f + k * .14f), new Vector3((k % 2 - .5f) * .14f, .62f + k * .02f, -.38f + k * .14f), .025f, .004f, Bone, Spine, 0, 1, k * .2f, sides: 4);
                    break;
                case 1:   // husk: a hunched raised soldier, a bile growth through the chest, a long clawed arm, spore stalks
                    b.Tube(new Vector3(.07f, .45f, .02f), new Vector3(.08f, 0, -.02f), .09f, .07f, Uniform, Leg, 0, 1, 0);
                    b.Tube(new Vector3(-.07f, .45f, 0), new Vector3(-.09f, 0, .05f), .09f, .07f, Uniform, Leg, 0, 1, .5f);
                    b.Ellipsoid(new Vector3(0, .62f, .08f), new Vector3(.17f, .22f, .13f), Uniform);
                    b.Ellipsoid(new Vector3(.06f, .72f, .16f), new Vector3(.12f, .1f, .1f), Bile, Sac, 1, glow: .4f, rings: 4, sides: 7);
                    b.Ellipsoid(new Vector3(-.1f, .8f, .02f), new Vector3(.09f, .08f, .08f), Bruise, rings: 3, sides: 6);
                    b.Ellipsoid(new Vector3(.09f, .86f, .2f), new Vector3(.08f, .09f, .085f), Flesh, Head, 1, rings: 4, sides: 7);
                    b.Tube(new Vector3(.17f, .76f, .1f), new Vector3(.26f, .3f, .24f), .045f, .03f, Flesh, Arm, 0, .9f);
                    b.Tube(new Vector3(.26f, .3f, .24f), new Vector3(.3f, .12f, .3f), .03f, .01f, Bone, Arm, .9f, 1, sides: 4);
                    b.Tube(new Vector3(-.17f, .74f, .06f), new Vector3(-.2f, .5f, .2f), .04f, .025f, Uniform, Arm, 0, 1, sides: 4);
                    for (int k = 0; k < 3; k++)
                        b.Tube(new Vector3(-.02f + k * .04f, .82f, -.02f), new Vector3(-.06f + k * .06f, 1f, -.1f), .02f, .004f, Bile, Spine, 0, 1, k * .3f, sides: 3);
                    break;
                case 2:   // spitter: four legs, a long neck and split mouth, a glowing bile sac slung underneath
                    b.Ellipsoid(new Vector3(0, .42f, -.15f), new Vector3(.2f, .17f, .3f), FleshDark);
                    b.Ellipsoid(new Vector3(0, .36f, .16f), new Vector3(.24f, .22f, .26f), Bile, Sac, 1, glow: .75f, rings: 6, sides: 10);
                    b.Tube(new Vector3(0, .5f, .05f), new Vector3(0, .82f, .3f), .07f, .05f, Flesh, Head, 0, 1);
                    b.Ellipsoid(new Vector3(0, .84f, .38f), new Vector3(.09f, .07f, .14f), Flesh, Head, 1, rings: 4, sides: 7);
                    b.Tube(new Vector3(.03f, .8f, .45f), new Vector3(.05f, .76f, .58f), .03f, .006f, Sinew, Jaw, .3f, 1, .5f, sides: 4);
                    b.Tube(new Vector3(-.03f, .8f, .45f), new Vector3(-.05f, .88f, .56f), .03f, .006f, Sinew, Jaw, .3f, 1, 0, sides: 4);
                    for (int s = -1; s <= 1; s += 2)
                        for (int k = 0; k < 2; k++)
                        {
                            float z = k == 0 ? -.3f : .05f, ph = ((k + (s > 0 ? 1 : 0)) % 2) * .5f;
                            b.Tube(new Vector3(s * .14f, .4f, z), new Vector3(s * .34f, .35f, z + .05f), .04f, .03f, FleshDark, Leg, 0, .55f, ph, sides: 4);
                            b.Tube(new Vector3(s * .34f, .35f, z + .05f), new Vector3(s * .4f, 0, z + .12f), .03f, .008f, Bone, Leg, .55f, 1, ph, sides: 4);
                        }
                    break;
                case 3:   // mauler: a plated slab of a torso on column legs, club forearms (arm pivot (.42, .70, .02))
                case 5:   // colossus: fused masses, a glowing maw, a crown of spines, great club arms (pivot (.36, .82, 0))
                {
                    bool boss = kind == 5;
                    float sw = boss ? .36f : .42f, sh = boss ? .82f : .7f, thick = boss ? .16f : .11f;
                    for (int s = -1; s <= 1; s += 2)
                    {
                        b.Tube(new Vector3(s * .18f, .4f, -.03f), new Vector3(s * .18f, 0, -.03f), .15f, .12f, FleshDark, Leg, 0, 1, s > 0 ? 0 : .5f, sides: 6);
                        var shoulder = new Vector3(s * sw, sh, boss ? 0 : .02f);
                        var wrist = shoulder + new Vector3(s * .06f, -.45f, .1f);
                        b.Tube(shoulder, wrist, thick, thick * .8f, boss ? Bruise : Sinew, Arm, 0, 1);
                        b.Ellipsoid(wrist + new Vector3(0, -.1f, .04f), new Vector3(thick * 1.6f, thick * 1.3f, thick * 1.7f), Bone, Arm, 1, rings: 4, sides: 8);
                    }
                    if (!boss)
                    {
                        b.Ellipsoid(new Vector3(0, .62f, .02f), new Vector3(.38f, .32f, .3f), Flesh, rings: 6, sides: 10);
                        b.Ellipsoid(new Vector3(.02f, .82f, -.08f), new Vector3(.32f, .2f, .24f), Bruise, rings: 5, sides: 9);
                        b.Ellipsoid(new Vector3(0, .66f, .3f), new Vector3(.1f, .09f, .1f), FleshDark, Head, 1, rings: 4, sides: 7);
                        for (int k = 0; k < 3; k++)
                            b.Tube(new Vector3(-.1f + k * .1f, .95f, -.12f), new Vector3(-.14f + k * .14f, 1.12f, -.26f), .04f, .006f, Bone, Spine, 0, 1, k * .3f, sides: 4);
                    }
                    else
                    {
                        b.Ellipsoid(new Vector3(0, .52f, 0), new Vector3(.32f, .26f, .26f), Flesh, rings: 6, sides: 10);
                        b.Ellipsoid(new Vector3(.08f, .74f, -.04f), new Vector3(.28f, .22f, .24f), Bruise, rings: 5, sides: 9);
                        b.Ellipsoid(new Vector3(.14f, .58f, .16f), new Vector3(.14f, .13f, .13f), Bile, Sac, 1, glow: .5f, rings: 4, sides: 8);
                        b.Ellipsoid(new Vector3(0, .9f, .12f), new Vector3(.13f, .11f, .12f), Flesh, Head, 1, rings: 4, sides: 8);
                        b.Ellipsoid(new Vector3(0, .86f, .22f), new Vector3(.07f, .06f, .04f), Gum, Jaw, 1, .75f, .5f, 3, 6);
                        for (int k = 0; k < 7; k++)
                        {
                            float a = -1.2f + k * .4f;
                            b.Tube(new Vector3(Mathf.Sin(a) * .2f, .9f, -.08f + Mathf.Cos(a) * .05f), new Vector3(Mathf.Sin(a) * .36f, 1.1f + (k % 2) * .06f, -.2f), .035f, .004f, Bone, Spine, 0, 1, k * .14f, sides: 4);
                        }
                    }
                    break;
                }
                case 4:   // broodsac: a pulsing bladder on four spindly legs, the brood dark inside it
                    b.Ellipsoid(new Vector3(0, .55f, 0), new Vector3(.38f, .34f, .4f), Pus, Sac, 1, glow: .25f, rings: 6, sides: 12);
                    for (int k = 0; k < 6; k++)
                    {
                        float a = k * 1.05f;
                        b.Ellipsoid(new Vector3(Mathf.Sin(a) * .28f, .55f + Mathf.Cos(a * 1.7f) * .16f, Mathf.Cos(a) * .29f), new Vector3(.09f, .07f, .09f), BileDark, Sac, 1, k / 6f, rings: 3, sides: 6);
                    }
                    b.Ellipsoid(new Vector3(0, .38f, .3f), new Vector3(.1f, .08f, .1f), FleshDark, Head, 1, rings: 4, sides: 7);
                    for (int k = 0; k < 4; k++)
                    {
                        float a = .78f + k * 1.571f;
                        var hip = new Vector3(Mathf.Sin(a) * .2f, .35f, Mathf.Cos(a) * .2f);
                        var knee = new Vector3(Mathf.Sin(a) * .42f, .4f, Mathf.Cos(a) * .42f);
                        b.Tube(hip, knee, .03f, .025f, FleshDark, Leg, 0, .5f, k * .25f, sides: 4);
                        b.Tube(knee, new Vector3(Mathf.Sin(a) * .5f, 0, Mathf.Cos(a) * .5f), .025f, .006f, Bone, Leg, .5f, 1, k * .25f, sides: 4);
                    }
                    break;
                default:  // hive: lobes of rot, a glowing crown ringed with spines, pustules
                    b.Ellipsoid(new Vector3(0, 0, 0), new Vector3(.5f, .42f, .5f), Rot, rings: 6, sides: 12);
                    b.Ellipsoid(new Vector3(.18f, .1f, -.12f), new Vector3(.3f, .38f, .28f), FleshDark, rings: 5, sides: 10);
                    b.Ellipsoid(new Vector3(-.2f, .05f, .14f), new Vector3(.28f, .3f, .3f), Bruise, rings: 5, sides: 10);
                    b.Ellipsoid(new Vector3(.02f, .38f, .02f), new Vector3(.2f, .22f, .2f), Flesh, rings: 5, sides: 9);
                    b.Ellipsoid(new Vector3(.03f, .56f, .03f), new Vector3(.09f, .06f, .09f), Pus, Jaw, 1, .25f, 1, 3, 7);
                    for (int k = 0; k < 6; k++)
                    {
                        float a = k * 1.047f + .3f;
                        b.Tube(new Vector3(Mathf.Sin(a) * .12f, .45f, Mathf.Cos(a) * .12f), new Vector3(Mathf.Sin(a) * .26f, .78f + (k % 3) * .06f, Mathf.Cos(a) * .26f), .04f, .006f, Bone, Spine, 0, 1, k / 6f, sides: 4);
                        float c = k * 1.1f;
                        b.Ellipsoid(new Vector3(Mathf.Sin(c) * .4f, .12f + (k % 3) * .1f, Mathf.Cos(c) * .4f), new Vector3(.07f, .07f, .07f), Pus, Sac, 1, k / 6f, 1, 3, 6);
                    }
                    break;
            }
            return b.Build("Blight " + Names[kind] + " (code)");
        }
    }
}
