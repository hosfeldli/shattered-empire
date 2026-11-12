using UnityEngine;

namespace SE.Runtime.Rendering
{
    /// <summary>Close-range meshes built in shared local units. The moving pieces have their own pivots.</summary>
    public static class MilitaryMeshes
    {
        public static Mesh Tank, Autonomous, Howitzer, Turret, RemoteTurret, HowitzerTurret, GunBarrel, HowitzerBarrel;
        public static Mesh Carrier, Scout, ArmoredCar, CargoTruck, RocketTruck, AirDefense, FieldGun, Mortar, ReconDrone, StrikeDrone;
        public static Mesh Fighter, Bomber, Helicopter, Rotor, Wheel, RoadWheel, CivilianCar;
        public static Mesh[] Torsos;
        public static Mesh Thigh, Shin, UpperArm, Forearm;
        public static Mesh Rifle, InfantryLauncher, Pistol;
        static readonly Color Paint = new Color(.88f, .90f, .84f);
        static readonly Color Edge = new Color(.70f, .72f, .66f);
        static readonly Color Dark = new Color(.24f, .26f, .24f);
        static readonly Color Steel = new Color(.50f, .54f, .53f);
        static readonly Color Glass = new Color(.36f, .57f, .68f);
        static readonly Color Light = new Color(.98f, .89f, .67f);
        static readonly Color Tail = new Color(.9f, .32f, .18f);
        static readonly Color Optic = new Color(.24f, .69f, .76f);

        public static void Build()
        {
            Tank = Tracked(0).Build("Main battle tank hull");
            Autonomous = Tracked(1).Build("Autonomous tank hull");
            Howitzer = Tracked(2).Build("Self-propelled gun hull");
            Turret = TurretBody(0).Build("Manned turret");
            RemoteTurret = TurretBody(1).Build("Remote turret and sensors");
            HowitzerTurret = TurretBody(2).Build("Howitzer cabin");
            GunBarrel = Barrel(false).Build("Tank cannon and thermal sleeve");
            HowitzerBarrel = Barrel(true).Build("Howitzer tube and muzzle brake");
            Carrier = Wheeled(0).Build("Eight-wheel infantry carrier");
            Scout = Wheeled(1).Build("Scout vehicle");
            ArmoredCar = Wheeled(2).Build("Armored reconnaissance car");
            CargoTruck = Wheeled(3).Build("Military cargo truck");
            RocketTruck = Wheeled(4).Build("Rocket artillery truck");
            AirDefense = Wheeled(5).Build("Air defense radar carrier");
            CivilianCar = Wheeled(6).Build("Civilian saloon");
            Wheel = WheelModel(false).Build("Tire and wheel hub");
            RoadWheel = WheelModel(true).Build("Tracked road wheel");
            FieldGun = Towed(false).Build("Towed gun");
            Mortar = Towed(true).Build("Mortar and bipod");
            Fighter = Aircraft(false).Build("Fighter airframe");
            Bomber = Aircraft(true).Build("Bomber airframe");
            Helicopter = Heli().Build("Helicopter airframe");
            Rotor = RotorModel().Build("Four-blade rotor");
            ReconDrone = Drone(false).Build("Reconnaissance drone");
            StrikeDrone = Drone(true).Build("Fixed-wing strike drone");
            Torsos = new Mesh[7];
            for (int i = 0; i < Torsos.Length; i++) Torsos[i] = Torso(i).Build("Infantry equipment " + i);
            Thigh = Limb(.085f, .245f, false, false).Build("Infantry thigh");
            Shin = Limb(.062f, .222f, true, false).Build("Infantry lower leg and boot");
            UpperArm = Limb(.060f, .155f, false, true).Build("Infantry upper arm");
            Forearm = Limb(.050f, .154f, true, true).Build("Infantry forearm and glove");
            Rifle = InfantryWeapon(false).Build("Infantry rifle and optic");
            InfantryLauncher = InfantryWeapon(true).Build("Shoulder-launched anti-armor weapon");
            Pistol = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Box(P(0, .009f, .015f), P(.024f, .025f, .105f), Dark)
                .Box(P(0, -.031f, -.022f), P(.023f, .065f, .029f), Steel)
                .Box(P(0, -.009f, .016f), P(.015f, .008f, .025f), Dark)
                .Box(P(0, .027f, .054f), P(.007f, .009f, .008f), Steel)
                .Build("Engineer defensive pistol");
        }

        static MeshBuilder InfantryWeapon(bool launcher)
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Armor);
            var finish = new Color(.44f, .46f, .43f);
            if (launcher)
            {
                m.Beam(P(0, .025f, -.20f), P(0, .025f, .25f), .043f, .039f, 10, finish)
                    .Beam(P(0, .025f, -.205f), P(0, .025f, -.175f), .050f, .050f, 10, Dark)
                    .Beam(P(0, .025f, .23f), P(0, .025f, .265f), .043f, .046f, 10, Dark)
                    .Box(P(.015f, .070f, .035f), P(.023f, .032f, .055f), Dark)
                    .Box(P(0, -.065f, .015f), P(.021f, .065f, .027f), Dark)
                    .Box(P(.026f, .010f, -.035f), P(.026f, .025f, .08f), finish);
                return m;
            }
            m.Box(P(0, -.006f, -.015f), P(.034f, .048f, .125f), finish)
                .Box(P(0, .005f, .075f), P(.037f, .035f, .105f), Dark)
                .Beam(P(0, .025f, .105f), P(0, .025f, .244f), .008f, .007f, 8, Steel)
                .Beam(P(0, .025f, .229f), P(0, .025f, .255f), .012f, .012f, 8, Dark)
                .Box(P(0, -.010f, -.115f), P(.029f, .047f, .085f), finish)
                .Box(P(0, -.025f, -.148f), P(.036f, .065f, .014f), Dark)
                .Box(P(0, -.060f, .015f), P(.025f, .064f, .035f), Dark)
                .Box(P(0, -.052f, -.051f), P(.023f, .047f, .022f), finish)
                .Box(P(0, .048f, -.010f), P(.026f, .012f, .092f), Steel)
                .Beam(P(0, .066f, -.023f), P(0, .066f, .027f), .013f, .013f, 8, Dark)
                .Box(P(0, .042f, .112f), P(.012f, .032f, .012f), Steel);
            for (int i = 0; i < 5; i++) m.Box(P(.022f, .020f, .035f + i * .014f), P(.005f, .012f, .007f), finish);
            return m;
        }

        static Vector3 P(float x, float y, float z) => new Vector3(x, y, z);
        static Vector2 V(float x, float y) => new Vector2(x, y);

        static MeshBuilder Tracked(int type)
        {
            bool remote = type == 1, artillery = type == 2;
            float deck = remote ? .31f : .35f;
            var m = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Armor(P(0, .11f, -.02f), P(.66f, deck - .11f, 1.05f), V(.59f, .88f), .10f, Paint)
                .Wedge(P(0, .15f, .33f), P(.58f, .18f, .44f), .045f, Edge)
                .Armor(P(0, deck, -.22f), P(.46f, .024f, .30f), V(.41f, .26f), .04f, Edge);
            for (int side = -1; side <= 1; side += 2)
            {
                float x = side * .365f;
                m.Surface(SurfaceKind.Rubber).Armor(P(x, .028f, -.02f), P(.145f, .164f, 1.03f), V(.145f, 1.11f), .07f, Dark);
                m.Surface(SurfaceKind.Armor).Armor(P(x, .167f, -.02f), P(.179f, .104f, 1.13f), V(.158f, 1.03f), .085f, Paint);
                for (int i = 0; i < 5; i++)
                    m.Box(P(side * .450f, .161f, -.42f + i * .195f), P(.025f, .076f, .176f), i % 2 == 0 ? Edge : Paint);
                m.Box(P(x, .260f, -.40f), P(.11f, .045f, .13f), Steel)
                    .Box(P(x, .25f, .45f), P(.104f, .046f, .10f), Dark)
                    .Surface(SurfaceKind.Glass).Box(P(x, .263f, .502f), P(.069f, .027f, .011f), remote ? Optic : Light)
                    .Box(P(x, .224f, -.550f), P(.059f, .035f, .01f), Tail);
            }
            m.Surface(SurfaceKind.Armor);
            for (int i = 0; i < 8; i++) m.Box(P(0, deck + .025f, -.37f + i * .035f), P(.32f, .008f, .011f), Dark);
            // Recovery fittings, welded joints and protected tools give the hull a useful scale.
            for (int side = -1; side <= 1; side += 2)
            {
                m.Beam(P(side * .25f, .197f, .49f), P(side * .22f, .214f, .54f), .014f, .014f, 6, Steel)
                    .Beam(P(side * .22f, .214f, .54f), P(side * .19f, .196f, .50f), .014f, .014f, 6, Steel)
                    .Box(P(side * .27f, deck + .012f, -.28f), P(.085f, .048f, .21f), Edge)
                    .Beam(P(side * .30f, deck + .065f, -.39f), P(side * .30f, deck + .065f, -.13f), .008f, .008f, 5, Steel);
                for (int bolt = 0; bolt < 4; bolt++)
                    m.Cylinder(P(side * .32f, .264f, -.36f + bolt * .22f), .006f, .006f, .004f, 6, Steel);
            }
            m.Beam(P(-.25f, .273f, .10f), P(.25f, .273f, .10f), .003f, .003f, 4, Steel)
                .Beam(P(-.24f, .243f, -.53f), P(.24f, .243f, -.53f), .011f, .011f, 6, Dark);
            if (artillery)
                m.Armor(P(0, .13f, -.49f), P(.50f, .10f, .16f), V(.43f, .12f), .03f, Steel)
                    .Beam(P(-.22f, .16f, -.52f), P(.22f, .16f, -.52f), .027f, .027f, 6, Dark);
            else
                m.Cylinder(P(-.20f, deck, .20f), .083f, .074f, .026f, 10, Edge)
                    .Box(P(.19f, deck, .10f), P(.12f, .038f, .18f), Paint);
            return m;
        }

        static MeshBuilder TurretBody(int type)
        {
            bool remote = type == 1, gun = type == 2;
            float y = remote ? .30f : .34f;
            float h = gun ? .21f : remote ? .112f : .156f;
            var m = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Cylinder(P(0, y - .015f, -.015f), .205f, .205f, .043f, 12, Dark)
                .Armor(P(0, y, -.075f), P(gun ? .56f : .53f, h, .54f), V(.43f, .43f), .09f, Paint)
                .Armor(P(0, y + .025f, .185f), P(.20f, .122f, .15f), V(.17f, .12f), .027f, Steel)
                .Box(P(0, y + .035f, -.366f), P(.44f, .082f, .13f), Edge);
            for (int sign = -1; sign <= 1; sign += 2)
            {
                m.Box(P(sign * .222f, y + h * .36f, -.04f), P(.075f, .042f, .20f), Edge)
                    .Box(P(sign * .225f, y + .035f, .13f), P(.071f, .058f, .097f), Dark);
                for (int i = 0; i < 3; i++)
                    m.Beam(P(sign * .245f, y + .069f, .14f + i * .026f), P(sign * .28f, y + .11f, .20f + i * .026f), .014f, .015f, 5, Steel);
            }
            m.Cylinder(P(.10f, y + h, -.12f), .062f, .054f, .024f, 10, Edge)
                .Beam(P(-.16f, y + h, -.25f), P(-.19f, y + h + .19f, -.27f), .009f, .0035f, 5, Dark)
                .Box(P(-.13f, y + h, .06f), P(.09f, .057f, .10f), Dark)
                .Surface(SurfaceKind.Glass).Box(P(-.13f, y + h + .015f, .113f), P(.051f, .028f, .011f), Optic);
            if (remote) m.Surface(SurfaceKind.Armor).Box(P(0, y + h, -.22f), P(.074f, .125f, .080f), Steel)
                .Surface(SurfaceKind.Glass).Box(P(0, y + h + .073f, -.175f), P(.065f, .038f, .024f), Optic);
            return m;
        }

        static MeshBuilder Barrel(bool artillery)
        {
            float length = artillery ? .86f : .68f;
            float radius = artillery ? .041f : .031f;
            return new MeshBuilder().Surface(SurfaceKind.Armor)
                .Tube(P(0, 0, 0), length, radius, 12, Steel)
                .Tube(P(0, 0, .10f), length - .29f, radius * 1.38f, 10, Paint)
                .Tube(P(0, 0, length - .071f), .082f, radius * 1.50f, 12, Edge)
                .Beam(P(0, 0, length + .008f), P(0, 0, length + .010f), radius * 1.01f, radius * 1.01f, 12, Dark);
        }

        static MeshBuilder Wheeled(int type)
        {
            bool civilian = type == 6, scout = type == 1, truck = type >= 3 && !civilian, carrier = type == 0;
            float w = civilian ? .44f : scout ? .47f : truck ? .53f : .58f;
            var m = new MeshBuilder().Surface(civilian ? SurfaceKind.SheetMetal : SurfaceKind.Armor)
                .Armor(P(0, .094f, 0), P(w, .13f, 1f), V(w * .96f, .91f), .09f, Paint)
                .Armor(P(0, .072f, .437f), P(w * 1.06f, .049f, .114f), V(w, .102f), .023f, Steel)
                .Armor(P(0, .074f, -.45f), P(w * 1.04f, .052f, .105f), V(w, .093f), .023f, Edge);
            if (truck)
            {
                m.Armor(P(0, .187f, .315f), P(w, .261f, .34f), V(w * .90f, .295f), .048f, Paint);
                Glazing(m, .31f, .26f, .308f, w * .72f, .118f);
                m.Surface(SurfaceKind.SheetMetal).Box(P(0, .192f, -.18f), P(w, .063f, .63f), Steel);
                if (type == 3)
                {
                    m.Surface(SurfaceKind.Fabric).Armor(P(0, .254f, -.18f), P(w * .95f, .235f, .61f), V(w * .79f, .55f), .061f, Edge);
                    for (int i = 0; i < 5; i++)
                        m.Surface(SurfaceKind.Armor).Box(P(0, .25f, -.44f + .127f * i), P(w, .025f, .016f), Paint);
                }
                else if (type == 4)
                {
                    m.Surface(SurfaceKind.Armor).Armor(P(0, .26f, -.20f), P(.49f, .16f, .56f), V(.43f, .47f), .043f, Edge);
                    for (int i = 0; i < 8; i++) m.Tube(P((i % 4 - 1.5f) * .097f, .305f + i / 4 * .066f, -.475f), .58f, .038f, 8, Dark);
                }
                else
                {
                    m.Surface(SurfaceKind.Armor).Cylinder(P(0, .245f, -.20f), .165f, .151f, .12f, 12, Paint)
                        .Box(P(0, .35f, -.21f), P(.29f, .155f, .06f), Steel);
                    for (int i = 0; i < 4; i++)
                        m.Beam(P((i - 1.5f) * .09f, .30f, -.44f), P((i - 1.5f) * .09f, .51f, -.22f), .035f, .031f, 8, Edge);
                }
            }
            else
            {
                float z = scout ? -.13f : -.08f;
                float h = civilian ? .129f : carrier ? .21f : .16f;
                m.Armor(P(0, .211f, z), P(w * .94f, h, carrier ? .65f : .55f), V(w * .74f, .36f), .055f, Paint);
                Glazing(m, z, .206f + h * .39f, carrier ? .58f : .48f, w * .69f, h * .48f);
                m.Surface(SurfaceKind.Armor).Box(P(0, .226f, .317f), P(w * .83f, .031f, .24f), Edge);
                if (carrier)
                    m.Box(P(0, .422f, -.15f), P(.18f, .062f, .22f), Dark).Tube(P(0, .47f, -.07f), .22f, .017f, 8, Steel);
                if (scout)
                    m.Beam(P(-w * .44f, .20f, -.26f), P(-w * .35f, .46f, -.18f), .014f, .014f, 6, Dark)
                        .Beam(P(w * .44f, .20f, -.26f), P(w * .35f, .46f, -.18f), .014f, .014f, 6, Dark)
                        .Beam(P(-w * .35f, .46f, -.18f), P(w * .35f, .46f, -.18f), .014f, .014f, 6, Steel);
            }
            for (int s = -1; s <= 1; s += 2)
            {
                m.Surface(SurfaceKind.Armor).Box(P(s * w * .48f, .154f, 0), P(.043f, .054f, .35f), Edge);
                if (!carrier)
                    m.Beam(P(s * w * .44f, .337f, .19f), P(s * (w * .5f + .055f), .344f, .19f), .007f, .007f, 5, Steel)
                        .Box(P(s * (w * .5f + .055f), .323f, .19f), P(.032f, .047f, .015f), Dark)
                        .Surface(SurfaceKind.Glass).Box(P(s * (w * .5f + .055f), .328f, .181f), P(.027f, .035f, .004f), Glass);
                m.Surface(SurfaceKind.Armor).Box(P(s * w * .49f, .269f, -.05f), P(.008f, .009f, .044f), Steel);
                m.Surface(SurfaceKind.Glass).Box(P(s * w * .37f, .170f, .491f), P(.083f, .041f, .02f), Light)
                    .Box(P(s * w * .39f, .150f, -.497f), P(.067f, .039f, .018f), Tail);
            }
            if (civilian)
                foreach (float x in new[] { -.205f, .205f })
                    foreach (float z in new[] { -.31f, .31f })
                        m.Surface(SurfaceKind.Rubber).Beam(P(x - .022f, .086f, z), P(x + .022f, .086f, z), .087f, .087f, 10, Dark);
            return m;
        }

        static void Glazing(MeshBuilder m, float z, float y, float length, float w, float h)
        {
            float taper = .026f;
            m.Surface(SurfaceKind.Glass).Quad(P(-w / 2, y, z + length / 2), P(w / 2, y, z + length / 2),
                P(w / 2 - taper, y + h, z + length / 2 - .033f), P(-w / 2 + taper, y + h, z + length / 2 - .033f), Glass);
            for (int s = -1; s <= 1; s += 2)
            {
                float x = s * (w * .61f);
                for (int i = 0; i < 2; i++)
                    m.Box(P(x, y + .006f, z + (i - .5f) * length * .38f), P(.009f, h * .83f, length * .31f), Glass);
            }
        }

        static MeshBuilder WheelModel(bool tracked)
        {
            float r = tracked ? .084f : .106f, w = tracked ? .037f : .058f;
            var m = new MeshBuilder().Surface(SurfaceKind.Rubber).Beam(P(-w * .5f, 0, 0), P(w * .5f, 0, 0), r, r, 12, Dark)
                .Surface(SurfaceKind.Armor).Beam(P(-w * .58f, 0, 0), P(w * .58f, 0, 0), r * .66f, r * .66f, 10, Steel)
                .Beam(P(-w * .68f, 0, 0), P(w * .68f, 0, 0), r * .28f, r * .28f, 8, Edge);
            for (int i = 0; i < 6; i++)
            {
                float a = i * Mathf.PI / 3, y = Mathf.Sin(a) * r * .46f, z = Mathf.Cos(a) * r * .46f;
                m.Beam(P(-w * .64f, y, z), P(w * .64f, y, z), r * .07f, r * .07f, 4, Dark);
            }
            return m;
        }

        static MeshBuilder Towed(bool mortar)
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Armor);
            if (mortar)
                return m.Armor(P(0, 0, 0), P(.34f, .045f, .27f), V(.30f, .24f), .045f, Steel)
                    .Beam(P(0, .041f, -.08f), P(0, .55f, .19f), .044f, .039f, 10, Paint)
                    .Beam(P(-.15f, 0, .18f), P(0, .31f, .11f), .015f, .019f, 6, Steel)
                    .Beam(P(.15f, 0, .18f), P(0, .31f, .11f), .015f, .019f, 6, Steel)
                    .Box(P(.25f, 0, -.13f), P(.17f, .10f, .22f), Edge);
            m.Armor(P(0, .09f, -.08f), P(.48f, .18f, .36f), V(.44f, .32f), .044f, Paint)
                .Armor(P(0, .22f, .12f), P(.49f, .19f, .055f), V(.42f, .05f), .018f, Edge)
                .Beam(P(0, .30f, -.14f), P(0, .40f, .78f), .054f, .034f, 12, Steel)
                .Beam(P(0, .395f, .71f), P(0, .405f, .80f), .061f, .057f, 12, Dark);
            for (int s = -1; s <= 1; s += 2)
                m.Beam(P(s * .09f, .15f, -.06f), P(s * .25f, .028f, -.61f), .034f, .028f, 6, Edge)
                    .Surface(SurfaceKind.Rubber).Beam(P(s * .25f, .13f, -.07f), P(s * .34f, .13f, -.07f), .13f, .13f, 12, Dark)
                    .Surface(SurfaceKind.Armor).Beam(P(s * .34f, .13f, -.07f), P(s * .36f, .13f, -.07f), .079f, .072f, 10, Steel);
            return m;
        }

        static MeshBuilder Aircraft(bool bomber)
        {
            float span = bomber ? .80f : .53f;
            var m = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Beam(P(0, 0, -.51f), P(0, .016f, .33f), bomber ? .100f : .083f, bomber ? .110f : .070f, 14, Paint)
                .Beam(P(0, .016f, .33f), P(0, .017f, .64f), bomber ? .110f : .070f, .006f, 14, Edge)
                .Surface(SurfaceKind.Glass).Blob(P(0, .071f, .31f), P(.061f, .048f, .153f), Glass);
            for (int s = -1; s <= 1; s += 2)
            {
                m.Surface(SurfaceKind.Armor);
                Wing(m, P(s * .06f, .025f, .27f), P(s * span, .020f, -.31f), P(s * span * .89f, -.003f, -.44f), P(s * .077f, -.022f, -.39f), Paint);
                Wing(m, P(s * .055f, .04f, -.26f), P(s * .25f, .052f, -.50f), P(s * .24f, .034f, -.56f), P(s * .06f, .02f, -.52f), Edge);
                float x = s * (bomber ? .25f : .095f);
                m.Beam(P(x, -.030f, -.43f), P(x, -.014f, .11f), .059f, .071f, 10, Steel)
                    .Beam(P(x, -.032f, -.52f), P(x, -.030f, -.40f), .046f, .060f, 10, Dark);
                Wing(m, P(x, .033f, -.23f), P(x * 1.46f, .24f, -.45f), P(x * 1.48f, .23f, -.52f), P(x, .024f, -.53f), Edge);
                m.Surface(SurfaceKind.Glass).Box(P(s * span * .98f, .016f, -.32f), P(.025f, .013f, .033f), s < 0 ? Tail : Optic);
            }
            return m;
        }

        static void Wing(MeshBuilder m, Vector3 a, Vector3 b, Vector3 c, Vector3 d, Color paint)
        {
            Vector3 offset = Vector3.up * .014f;
            bool forward = Vector3.Cross(b - a, d - a).y >= 0;
            if (forward) m.Quad(a, b, c, d, paint).Quad(d - offset, c - offset, b - offset, a - offset, Edge);
            else m.Quad(d, c, b, a, paint).Quad(a - offset, b - offset, c - offset, d - offset, Edge);
        }

        static MeshBuilder Heli()
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Armor(P(0, .019f, .08f), P(.29f, .245f, .73f), V(.23f, .57f), .105f, Paint)
                .Beam(P(0, .17f, -.25f), P(0, .205f, -.69f), .082f, .036f, 10, Edge)
                .Armor(P(0, .224f, -.63f), P(.067f, .19f, .16f), V(.042f, .090f), .024f, Paint)
                .Cylinder(P(0, .26f, .08f), .058f, .038f, .057f, 10, Steel)
                .Surface(SurfaceKind.Glass).Blob(P(0, .15f, .355f), P(.106f, .090f, .112f), Glass);
            for (int s = -1; s <= 1; s += 2)
            {
                m.Surface(SurfaceKind.Armor).Beam(P(s * .11f, .21f, -.15f), P(s * .12f, .22f, .16f), .055f, .052f, 8, Steel)
                    .Box(P(s * .177f, .103f, .05f), P(.22f, .036f, .135f), Edge)
                    .Tube(P(s * .236f, .062f, -.052f), .183f, .041f, 8, Dark)
                    .Beam(P(s * .105f, .055f, -.17f), P(s * .167f, -.026f, -.18f), .013f, .013f, 6, Steel)
                    .Beam(P(s * .105f, .055f, .24f), P(s * .167f, -.026f, .22f), .013f, .013f, 6, Steel)
                    .Beam(P(s * .167f, -.026f, -.22f), P(s * .167f, -.015f, .34f), .017f, .011f, 8, Dark);
            }
            return m;
        }

        static MeshBuilder RotorModel()
        {
            return new MeshBuilder().Surface(SurfaceKind.Armor)
                .Cylinder(Vector3.zero, .071f, .050f, .045f, 10, Steel)
                .Box(P(0, .013f, 0), P(1.18f, .012f, .060f), Dark)
                .Box(P(0, .013f, 0), P(.060f, .012f, 1.18f), Dark);
        }

        static MeshBuilder Drone(bool strike)
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Armor)
                .Armor(P(0, .015f, .026f), P(.23f, .109f, .51f), V(.18f, .41f), .07f, Paint)
                .Surface(SurfaceKind.Glass).Blob(P(0, -.009f, .185f), P(.057f, .061f, .057f), Optic);
            for (int s = -1; s <= 1; s += 2)
            {
                m.Surface(SurfaceKind.Armor);
                if (strike)
                {
                    Wing(m, P(s * .07f, .048f, .16f), P(s * .55f, .034f, -.16f), P(s * .42f, .027f, -.28f), P(s * .10f, .035f, -.25f), Edge);
                    continue;
                }
                foreach (float z in new[] { -.31f, .29f })
                {
                    m.Beam(P(s * .063f, .065f, z * .27f), P(s * .335f, .079f, z), .025f, .017f, 6, Steel)
                        .Cylinder(P(s * .335f, .048f, z), .043f, .035f, .075f, 9, Dark)
                        .Box(P(s * .335f, .129f, z), P(.25f, .007f, .026f), Edge);
                }
            }
            return m;
        }

        static MeshBuilder Torso(int role)
        {
            bool engineer = role == 1, militia = role == 2, special = role == 3, exo = role == 4, antiArmor = role == 5, mortar = role == 6;
            Color cloth = militia ? new Color(.79f, .71f, .57f) : special ? Dark * 1.62f : Paint;
            var m = new MeshBuilder().Surface(SurfaceKind.Fabric)
                .Armor(P(0, .440f, 0), P(exo ? .33f : .275f, .338f, .179f), V(exo ? .39f : .307f, .184f), .035f, cloth)
                .Armor(P(0, .51f, -.122f), P(.22f, .23f, .122f), V(.20f, .106f), .03f, engineer ? Edge * .83f : Dark * 1.44f)
                .Armor(P(0, .475f, .076f), P(.28f, .243f, .083f), V(.25f, .068f), .031f, exo ? Steel : cloth * .83f)
                .Box(P(0, .45f, 0), P(.287f, .039f, .186f), Dark);
            for (int i = 0; i < 3; i++)
                m.Box(P((i - 1) * .074f, .538f, .128f), P(.061f, .073f, .038f), cloth * .78f)
                    .Box(P((i - 1) * .074f, .608f, .133f), P(.065f, .015f, .042f), Edge * .82f);
            var skin = new Color(.88f, .70f, .54f);
            m.Surface(SurfaceKind.Fabric).Beam(P(0, .752f, 0), P(0, .806f, .006f), .044f, .045f, 8, cloth)
                .Surface(SurfaceKind.Plain).Blob(P(0, .845f, .009f), P(.087f, .106f, .081f), skin)
                .Armor(P(0, .820f, .084f), P(.034f, .036f, .035f), V(.026f, .021f), .009f, skin)
                .Blob(P(-.087f, .838f, .012f), P(.015f, .028f, .019f), skin)
                .Blob(P(.087f, .838f, .012f), P(.015f, .028f, .019f), skin);
            m.Surface(SurfaceKind.Armor).Armor(P(0, .867f, .003f), P(.214f, .094f, .212f), V(.168f, .158f), .038f,
                engineer ? new Color(.98f, .74f, .36f) : cloth)
                .Box(P(0, .864f, .082f), P(.156f, .024f, .062f), Dark);
            m.Surface(SurfaceKind.Fabric).Beam(P(-.083f, .854f, .04f), P(-.058f, .783f, .044f), .009f, .008f, 5, Dark)
                .Beam(P(.083f, .854f, .04f), P(.058f, .783f, .044f), .009f, .008f, 5, Dark)
                .Surface(SurfaceKind.Armor).Box(P(-.103f, .844f, -.001f), P(.034f, .060f, .062f), Dark)
                .Beam(P(-.113f, .819f, .014f), P(-.052f, .812f, .098f), .005f, .005f, 5, Steel);
            if (special || exo)
                m.Surface(SurfaceKind.Glass).Box(P(0, .844f, .081f), P(.158f, .047f, .046f), special ? Glass : Optic);
            if (engineer || exo || antiArmor || mortar)
                m.Surface(SurfaceKind.Armor).Beam(P(-.096f, .499f, -.178f), P(-.103f, antiArmor ? .97f : .85f, -.174f), .029f, .025f, 7, Steel)
                    .Box(P(.12f, .485f, -.11f), P(.078f, .149f, .09f), exo ? Edge : Dark);
            if (exo)
                foreach (float x in new[] { -.187f, .187f })
                    m.Armor(P(x, .678f, 0), P(.115f, .096f, .187f), V(.082f, .139f), .027f, Edge);
            return m;
        }

        static MeshBuilder Limb(float r, float length, bool end, bool arm)
        {
            var m = new MeshBuilder().Surface(SurfaceKind.Fabric)
                .Beam(Vector3.zero, P(0, -length, 0), r, r * .74f, 8, end ? Edge : Paint);
            if (end && !arm)
            {
                m.Surface(SurfaceKind.Rubber).Armor(P(0, -length - .029f, .031f), P(.109f, .073f, .192f), V(.104f, .152f), .028f, Dark);
                for (int k = 0; k < 3; k++) m.Box(P(0, -length + .012f + k * .010f, .083f - k * .021f), P(.067f, .006f, .009f), Steel * .8f);
            }
            if (end && arm)
                m.Surface(SurfaceKind.Fabric).Blob(P(0, -length, .009f), P(.047f, .055f, .040f), Dark);
            if (!end && !arm)
                m.Surface(SurfaceKind.Armor).Armor(P(0, -length, .035f), P(.109f, .093f, .090f), V(.100f, .075f), .022f, Edge);
            return m;
        }
    }
}
