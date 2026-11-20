using SE.Runtime.Rendering;
using UnityEngine;

namespace SE.Runtime.Horde
{
    /// <summary>
    /// Procedural models of the Blight's creatures (original designs, built from MeshBuilder primitives at start-up).
    /// Each faces +z, stands on y = 0 and is one unit long or tall; HordeRenderer scales and animates them. Grotesque,
    /// asymmetric organic silhouettes in a sickly palette that no team colour shares: pale grey-yellow flesh, bruise
    /// purple, bile green, exposed bone and wet red sinew.
    /// </summary>
    public static class HordeMeshes
    {
        public static readonly Color Flesh = new Color(.62f, .58f, .44f), FleshDark = new Color(.42f, .37f, .3f), Bruise = new Color(.36f, .22f, .3f),
            Bile = new Color(.56f, .7f, .18f), BileDark = new Color(.26f, .33f, .1f), Bone = new Color(.82f, .78f, .64f), Sinew = new Color(.5f, .14f, .12f),
            Rot = new Color(.2f, .22f, .13f), Uniform = new Color(.3f, .33f, .23f), Pus = new Color(.85f, .8f, .45f);

        public static Mesh Crawler, Husk, Spitter, Mauler, MaulerArm, Broodsac, Colossus, ColossusArm, Hive, Pustule, Tendril;

        static bool built;

        public static void Build()
        {
            if (built) return;
            built = true;
            Crawler = BuildCrawler();
            Husk = BuildHusk();
            Spitter = BuildSpitter();
            Mauler = BuildMauler();
            MaulerArm = BuildArm(.11f, Bone, Sinew);
            Broodsac = BuildBroodsac();
            Colossus = BuildColossus();
            ColossusArm = BuildArm(.16f, Bone, Bruise);
            Hive = BuildHive();
            Pustule = new MeshBuilder().Ellipsoid(new Vector3(0, .5f, 0), new Vector3(.5f, .5f, .5f), Pus, 5, 8).Build("Blight pustule");
            Tendril = new MeshBuilder().Beam(new Vector3(0, .02f, 0), new Vector3(0, .02f, 1f), .06f, .015f, 5, Rot).Build("Blight tendril");
        }

        // A low, many-legged knot of claws: an elongated body hung between six jointed legs, a split jaw and dorsal spines.
        static Mesh BuildCrawler()
        {
            var b = new MeshBuilder();
            b.Ellipsoid(new Vector3(0, .32f, -.05f), new Vector3(.24f, .17f, .42f), Flesh, 5, 10);
            b.Ellipsoid(new Vector3(.04f, .37f, .1f), new Vector3(.16f, .12f, .18f), Bruise, 4, 8);   // swollen growth, off-centre
            b.Ellipsoid(new Vector3(0, .3f, .42f), new Vector3(.13f, .11f, .14f), FleshDark, 4, 8);   // head
            b.Beam(new Vector3(.06f, .27f, .5f), new Vector3(.13f, .18f, .7f), .03f, .006f, 4, Bone);    // mandibles
            b.Beam(new Vector3(-.06f, .27f, .5f), new Vector3(-.15f, .2f, .68f), .03f, .006f, 4, Bone);
            for (int side = -1; side <= 1; side += 2)
                for (int k = 0; k < 3; k++)
                {
                    float z = -.25f + k * .25f, flare = side * (k == 1 ? .05f : 0);
                    var hip = new Vector3(side * .16f, .32f, z);
                    var knee = new Vector3(side * (.52f + flare), .58f, z + (k - 1) * .16f);
                    var foot = new Vector3(side * .74f, 0f, z + (k - 1) * .34f);
                    b.Beam(hip, knee, .045f, .03f, 4, FleshDark);
                    b.Beam(knee, foot, .03f, .008f, 4, Bone);
                }
            for (int k = 0; k < 4; k++)
                b.Beam(new Vector3((k % 2 - .5f) * .08f, .44f, -.3f + k * .14f), new Vector3((k % 2 - .5f) * .14f, .62f + k * .02f, -.38f + k * .14f), .025f, .004f, 4, Bone);
            return b.Build("Blight crawler");
        }

        // A soldier the Blight raised: hunched, one arm hanging long, the head lolled to one side, fungal growths
        // bursting through the shreds of a uniform.
        static Mesh BuildHusk()
        {
            var b = new MeshBuilder();
            b.Beam(new Vector3(.08f, 0, -.02f), new Vector3(.07f, .45f, .02f), .07f, .09f, 5, Uniform);   // legs
            b.Beam(new Vector3(-.09f, 0, .05f), new Vector3(-.07f, .45f, 0), .07f, .09f, 5, Uniform);
            b.Ellipsoid(new Vector3(0, .62f, .08f), new Vector3(.17f, .22f, .13f), Uniform, 4, 8);        // torso, pitched forward
            b.Ellipsoid(new Vector3(.06f, .74f, .14f), new Vector3(.12f, .1f, .1f), Bile, 4, 7);          // growth through the chest
            b.Ellipsoid(new Vector3(-.1f, .8f, .02f), new Vector3(.09f, .08f, .08f), Bruise, 3, 6);      // shoulder tumour
            b.Ellipsoid(new Vector3(.09f, .86f, .2f), new Vector3(.08f, .09f, .085f), Flesh, 4, 7);        // head, lolled
            b.Beam(new Vector3(.17f, .76f, .1f), new Vector3(.26f, .3f, .24f), .045f, .03f, 4, Flesh);   // long arm
            b.Beam(new Vector3(.26f, .3f, .24f), new Vector3(.3f, .12f, .3f), .03f, .01f, 4, Bone);       // claws
            b.Beam(new Vector3(-.17f, .74f, .06f), new Vector3(-.2f, .5f, .2f), .04f, .025f, 4, Uniform);
            for (int k = 0; k < 3; k++)
                b.Beam(new Vector3(-.02f + k * .04f, .82f, -.02f), new Vector3(-.06f + k * .06f, 1f, -.1f), .02f, .004f, 3, Bile);   // spore stalks
            return b.Build("Blight husk");
        }

        // A four-legged gullet: a long neck ending in a split mouth and, under it, a swollen sac of glowing bile.
        static Mesh BuildSpitter()
        {
            var b = new MeshBuilder();
            b.Ellipsoid(new Vector3(0, .42f, -.15f), new Vector3(.2f, .17f, .3f), FleshDark, 5, 9);
            b.Ellipsoid(new Vector3(0, .36f, .16f), new Vector3(.24f, .22f, .26f), Bile, 6, 10);       // the acid sac
            b.Ellipsoid(new Vector3(.08f, .45f, .2f), new Vector3(.08f, .07f, .08f), Pus, 3, 6);
            b.Beam(new Vector3(0, .5f, .05f), new Vector3(0, .82f, .3f), .07f, .05f, 5, Flesh);          // neck
            b.Ellipsoid(new Vector3(0, .84f, .38f), new Vector3(.09f, .07f, .14f), Flesh, 4, 7);         // head
            b.Beam(new Vector3(.03f, .8f, .45f), new Vector3(.05f, .76f, .58f), .03f, .006f, 4, Sinew);  // split jaw
            b.Beam(new Vector3(-.03f, .8f, .45f), new Vector3(-.05f, .88f, .56f), .03f, .006f, 4, Sinew);
            for (int side = -1; side <= 1; side += 2)
                for (int k = 0; k < 2; k++)
                {
                    float z = k == 0 ? -.3f : .05f;
                    b.Beam(new Vector3(side * .14f, .4f, z), new Vector3(side * .34f, .35f, z + .05f), .04f, .03f, 4, FleshDark);
                    b.Beam(new Vector3(side * .34f, .35f, z + .05f), new Vector3(side * .4f, 0, z + .12f), .03f, .008f, 4, Bone);
                }
            return b.Build("Blight spitter");
        }

        // A hunched brute: a slab of torso armoured in bone plates, a small sunken head, columns for legs. The
        // battering-ram forearms are separate (MaulerArm) so they can swing.
        static Mesh BuildMauler()
        {
            var b = new MeshBuilder();
            b.Beam(new Vector3(.18f, 0, -.05f), new Vector3(.16f, .38f, -.02f), .12f, .15f, 6, FleshDark);
            b.Beam(new Vector3(-.18f, 0, -.02f), new Vector3(-.16f, .38f, -.04f), .12f, .15f, 6, FleshDark);
            b.Ellipsoid(new Vector3(0, .62f, .02f), new Vector3(.38f, .32f, .3f), Flesh, 6, 10);
            b.Ellipsoid(new Vector3(.02f, .82f, -.08f), new Vector3(.32f, .2f, .24f), Bruise, 5, 9);     // the hump
            b.Ellipsoid(new Vector3(0, .66f, .3f), new Vector3(.1f, .09f, .1f), FleshDark, 4, 7);         // sunken head
            b.Beam(new Vector3(.04f, .64f, .38f), new Vector3(.08f, .58f, .46f), .03f, .005f, 4, Bone);
            for (int k = 0; k < 5; k++)
            {
                float a = -.9f + k * .45f;
                b.Ellipsoid(new Vector3(Mathf.Sin(a) * .3f, .86f - Mathf.Abs(a) * .1f, -.12f + Mathf.Cos(a) * .08f), new Vector3(.12f, .05f, .1f), Bone, 3, 6);   // plates
            }
            for (int k = 0; k < 3; k++)
                b.Beam(new Vector3(-.1f + k * .1f, .95f, -.12f), new Vector3(-.14f + k * .14f, 1.12f, -.26f), .04f, .006f, 4, Bone);
            return b.Build("Blight mauler");
        }

        // A forearm ending in a club of bone (pivot at the shoulder, hanging down -y, knuckles forward).
        static Mesh BuildArm(float thick, Color knuckle, Color skin)
        {
            var b = new MeshBuilder();
            b.Beam(Vector3.zero, new Vector3(0, -.45f, .1f), thick, thick * .8f, 5, skin);
            b.Ellipsoid(new Vector3(0, -.55f, .14f), new Vector3(thick * 1.6f, thick * 1.3f, thick * 1.7f), knuckle, 4, 8);
            b.Beam(new Vector3(0, -.55f, .2f), new Vector3(0, -.62f, .34f), thick * .5f, .01f, 4, knuckle);
            return b.Build("Blight arm");
        }

        // A lurching translucent-looking bladder on spindly legs, mottled where the brood shows through.
        static Mesh BuildBroodsac()
        {
            var b = new MeshBuilder();
            b.Ellipsoid(new Vector3(0, .55f, 0), new Vector3(.38f, .34f, .4f), Pus, 6, 12);
            for (int k = 0; k < 6; k++)
            {
                float a = k * 1.05f;
                b.Ellipsoid(new Vector3(Mathf.Sin(a) * .26f, .55f + Mathf.Cos(a * 1.7f) * .16f, Mathf.Cos(a) * .27f), new Vector3(.09f, .07f, .09f), BileDark, 3, 6);   // shadows of the brood
            }
            b.Ellipsoid(new Vector3(0, .38f, .3f), new Vector3(.1f, .08f, .1f), FleshDark, 4, 7);
            for (int k = 0; k < 4; k++)
            {
                float a = .78f + k * 1.571f;
                var hip = new Vector3(Mathf.Sin(a) * .2f, .35f, Mathf.Cos(a) * .2f);
                var knee = new Vector3(Mathf.Sin(a) * .42f, .36f, Mathf.Cos(a) * .42f);
                b.Beam(hip, knee, .03f, .025f, 4, FleshDark);
                b.Beam(knee, new Vector3(Mathf.Sin(a) * .5f, 0, Mathf.Cos(a) * .5f), .025f, .006f, 4, Bone);
            }
            return b.Build("Blight broodsac");
        }

        // A walking mound of fused bodies: a towering torso of overlapping masses, ribs of bone, a gaping maw and
        // a crown of spines. Arms separate (ColossusArm).
        static Mesh BuildColossus()
        {
            var b = new MeshBuilder();
            b.Beam(new Vector3(.2f, 0, 0), new Vector3(.17f, .3f, 0), .11f, .14f, 6, FleshDark);
            b.Beam(new Vector3(-.2f, 0, .03f), new Vector3(-.17f, .3f, 0), .11f, .14f, 6, FleshDark);
            b.Ellipsoid(new Vector3(0, .52f, 0), new Vector3(.32f, .26f, .26f), Flesh, 6, 10);
            b.Ellipsoid(new Vector3(.08f, .74f, -.04f), new Vector3(.28f, .22f, .24f), Bruise, 5, 9);
            b.Ellipsoid(new Vector3(-.12f, .66f, .08f), new Vector3(.18f, .16f, .16f), FleshDark, 4, 8);
            b.Ellipsoid(new Vector3(.14f, .58f, .16f), new Vector3(.14f, .13f, .13f), Bile, 4, 8);
            b.Ellipsoid(new Vector3(0, .9f, .12f), new Vector3(.13f, .11f, .12f), Flesh, 4, 8);           // head
            b.Ellipsoid(new Vector3(0, .86f, .22f), new Vector3(.07f, .06f, .04f), Sinew, 3, 6);          // maw
            for (int k = 0; k < 5; k++) b.Beam(new Vector3(-.2f + k * .1f, .55f, .2f), new Vector3(-.22f + k * .11f, .4f, .27f), .02f, .012f, 4, Bone);   // ribs
            for (int k = 0; k < 7; k++)
            {
                float a = -1.2f + k * .4f;
                b.Beam(new Vector3(Mathf.Sin(a) * .2f, .9f, -.08f + Mathf.Cos(a) * .05f), new Vector3(Mathf.Sin(a) * .36f, 1.1f + (k % 2) * .06f, -.2f), .035f, .004f, 4, Bone);
            }
            for (int k = 0; k < 3; k++) b.Ellipsoid(new Vector3(-.25f + k * .25f, .45f + k * .1f, -.22f), new Vector3(.07f, .06f, .06f), Pus, 3, 6);
            return b.Build("Blight colossus");
        }

        // A pulsing mound of rot: overlapping lobes, a split crown, and roots (the tendrils are separate instances).
        static Mesh BuildHive()
        {
            var b = new MeshBuilder();
            b.Ellipsoid(new Vector3(0, 0, 0), new Vector3(.5f, .42f, .5f), Rot, 6, 12, true);
            b.Ellipsoid(new Vector3(.18f, .1f, -.12f), new Vector3(.3f, .38f, .28f), FleshDark, 5, 10, true);
            b.Ellipsoid(new Vector3(-.2f, .05f, .14f), new Vector3(.28f, .3f, .3f), Bruise, 5, 10, true);
            b.Ellipsoid(new Vector3(.02f, .38f, .02f), new Vector3(.2f, .22f, .2f), Flesh, 5, 9);
            b.Ellipsoid(new Vector3(.03f, .55f, .03f), new Vector3(.09f, .08f, .09f), Sinew, 3, 7);      // the open crown
            for (int k = 0; k < 6; k++)
            {
                float a = k * 1.047f + .3f;
                b.Beam(new Vector3(Mathf.Sin(a) * .12f, .45f, Mathf.Cos(a) * .12f), new Vector3(Mathf.Sin(a) * .26f, .78f + (k % 3) * .06f, Mathf.Cos(a) * .26f), .04f, .006f, 4, Bone);
            }
            return b.Build("Blight hive");
        }
    }
}
