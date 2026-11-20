using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Per-unit upgrade kit (2026-11-20, docs/gameplay-overhaul/BASE_MENU_REWORK.md §3 and §5). The server sends an
    /// equipment bitfield on each unit record (extra[7], <c>WorldMotion.Equipment</c>); bits 24-25 carry the upgrade tier
    /// (1..3): tier 1 shows the kit, tiers 2 and 3 add to it. Everything here is built from the shared box batch
    /// (Model.Plate, a base-pivoted unit box) and the existing vehicle meshes, so there are no new assets, and nothing
    /// allocates per frame. Props are slightly oversized and in contrasting colours at operational zoom so they still
    /// read when the vehicle is a dozen pixels long.
    /// <list type="bullet">
    /// <item>2 reactive armour (tank): side tiles (UnitRenderer.cs close up) + turret cheeks (t2) + glacis row (t3).</item>
    /// <item>128 body armour: plate carriers (UnitRenderer.cs); on engineers also a combat helmet over the hard hat.</item>
    /// <item>512 smoke dischargers (armored car), 1024 ghillie netting (infantry) / camo net (field gun).</item>
    /// <item>2048 spotter mast (scout buggy), rotating search radar (mobile air defense), sensor ball (recon drone).</item>
    /// <item>4096 exhaust stacks (infantry carrier), 8192 toolboxes and track links (IFV), maintenance pods
    /// (autonomous tank), crane and toolboxes (support truck), tool trailer and generator (engineer car).</item>
    /// <item>16384 ammunition crates (mortar), racks (SP artillery), a larger warhead (one-way drone).</item>
    /// <item>32768 flare dispensers (helicopter, bomber), 65536 extra pods (strike swarm) / launch tubes (missile
    /// battery), 131072 the engineer drives a small utility car, 262144 rocket pods under the Warthog's wings.</item>
    /// </list>
    /// </summary>
    public sealed partial class UnitRenderer
    {
        public const int KitReactive = 2, KitArmour = 128, KitSmoke = 512, KitCamo = 1024, KitSensor = 2048, KitExhaust = 4096,
            KitTools = 8192, KitAmmo = 16384, KitFlares = 32768, KitPods = 65536, KitUtilityCar = 131072, KitRocketPods = 262144;

        /// <summary>The equipment of the unit being drawn (set by KitBegin, read by the aircraft hook).</summary>
        int kitEquipment;

        static readonly float4 KitDark = new float4(.13f, .14f, .13f, 0), KitSteel = new float4(.50f, .52f, .52f, 0),
            KitLight = new float4(.66f, .68f, .66f, 0), KitOlive = new float4(.30f, .33f, .21f, 0), KitTan = new float4(.62f, .53f, .35f, 0),
            KitBrass = new float4(.80f, .62f, .28f, 0), KitYellow = new float4(.86f, .68f, .14f, 0), KitRedBox = new float4(.62f, .20f, .13f, 0),
            KitLens = new float4(.20f, .62f, .70f, .45f), KitFlare = new float4(.95f, .50f, .16f, .35f), KitCyan = new float4(.25f, .80f, .85f, .6f);
        static readonly float4[] Leaf = { new float4(.23f, .33f, .15f, 0), new float4(.33f, .38f, .19f, 0), new float4(.38f, .33f, .21f, 0), new float4(.18f, .26f, .13f, 0) };
        // ghillie strips on a rigged / procedural soldier (model units, ~1.02 tall), in the order they are added by tier
        static readonly float3[] GhillieSpots =
        {
            new float3(-.12f, .74f, -.05f), new float3(.12f, .74f, -.05f), new float3(0, .66f, -.13f), new float3(0, .95f, -.01f),
            new float3(-.08f, .55f, -.12f), new float3(.08f, .56f, -.12f), new float3(-.06f, .90f, -.07f), new float3(.06f, .91f, .04f),
            new float3(-.15f, .47f, .0f), new float3(.15f, .48f, .0f),
        };

        static int KitTier(int equipment) { int t = (equipment >> 24) & 3; return t == 0 ? 1 : t; }

        /// <summary>A box centred at <paramref name="local"/> (scaled), turned by <paramref name="turn"/> about its centre.</summary>
        void KitPart(float3 at, quaternion rot, float s, float3 local, quaternion turn, float3 size, float4 color)
        {
            var q = math.mul(rot, turn);
            var centre = at + math.rotate(rot, local * s);
            batches[(int)Model.Plate].Add(InstanceData.TRS(centre - math.rotate(q, new float3(0, size.y * .5f * s, 0)), q, size * s, color));
        }

        /// <summary>An upright box centred at <paramref name="local"/>.</summary>
        void KitPart(float3 at, quaternion rot, float s, float3 local, float3 size, float4 color)
            => batches[(int)Model.Plate].Add(InstanceData.TRS(at + math.rotate(rot, (local - new float3(0, size.y * .5f, 0)) * s), rot, size * s, color));

        // ---------------------------------------------------------------- hooks from UnitRenderer.Update

        /// <summary>
        /// Called once per drawn unit (below strategic zoom) before it is drawn. Records its equipment for the aircraft
        /// hook and draws an engineer with the Utility Car upgrade (bit 131072) as a small team-coloured car instead of
        /// the walking figure (true: the unit is drawn, skip the rest).
        /// </summary>
        bool KitBegin(int slot, Kind kind, float3 p, float sc, float4 body, float4 team, int equipment)
        {
            kitEquipment = equipment;
            if ((equipment & KitUtilityCar) == 0 || kind != Kind.Infantry || torsoOf[slot] != Detail.Engineer) return false;
            var at = MapSpace.W(p);
            var rot = quaternion.RotateY(MapSpace.Yaw(yaw[slot]));
            float k = sc * .56f;
            var paint = new float4(math.lerp(body.xyz, team.xyz, .5f), 0);
            batches[(int)Model.Buggy].Add(InstanceData.TRS(at, rot, new float3(k), paint));
            // the driver's hard hat in the team colour, and an amber roof beacon (a works vehicle)
            KitPart(at, rot, k, new float3(0, .46f, -.04f), new float3(.15f, .07f, .15f), new float4(figureTeam, .1f));
            KitPart(at, rot, k, new float3(.12f, .45f, .16f), new float3(.06f, .05f, .06f), new float4(.95f, .62f, .12f, .5f));
            if ((equipment & KitTools) != 0)
            {
                // Power Tools: a two-wheel tool trailer with a generator and a tool rack
                KitPart(at, rot, k, new float3(0, .12f, -.56f), new float3(.03f, .025f, .2f), KitDark);                        // drawbar
                KitPart(at, rot, k, new float3(0, .17f, -.86f), new float3(.44f, .14f, .36f), KitOlive);                       // bed
                for (int side = -1; side <= 1; side += 2)
                    KitPart(at, rot, k, new float3(side * .25f, .09f, -.86f), new float3(.06f, .17f, .17f), KitDark);         // wheels
                KitPart(at, rot, k, new float3(-.07f, .31f, -.88f), new float3(.22f, .16f, .2f), KitSteel);                   // generator
                KitPart(at, rot, k, new float3(-.07f, .40f, -.88f), new float3(.23f, .02f, .21f), KitYellow);                 // its hazard band
                KitPart(at, rot, k, new float3(.14f, .30f, -.88f), new float3(.06f, .14f, .26f), KitRedBox);                  // tool chest
            }
            return true;
        }

        /// <summary>After the operational-zoom switch: the kit on vehicles drawn there, and the mortar team's ammunition.</summary>
        void OperationalKit(Kind kind, int slot, float3 p, float sc, int equipment, int level)
        {
            if (equipment == 0 || IsAir(kind)) return;
            if (kind == Kind.Mortar)
            {
                if ((equipment & KitAmmo) != 0 && slot < deployState.Length && deployState[slot] > .3f) MortarCrates(slot, p, equipment, level);
                return;
            }
            if (IsFoot(kind)) return;
            float k = kind switch
            {
                Kind.AutoTank => 1.18f, Kind.Buggy => .75f, Kind.Truck => .9f, Kind.FieldGun => .85f, Kind.AirDefense => .95f, _ => 1f,
            };
            VehicleKit(kind, slot, MapSpace.W(p), quaternion.RotateY(MapSpace.Yaw(yaw[slot])), sc * k, equipment, false);
        }

        /// <summary>Ammunition crates stacked beside the set-up tube (world units; more and higher by tier).</summary>
        void MortarCrates(int slot, float3 p, int equipment, int level)
        {
            int tier = KitTier(equipment);
            var at = MapSpace.W(p);
            var rot = quaternion.RotateY(MapSpace.Yaw(yaw[slot]));
            float b = level == 2 ? 1f : 1.5f;
            var lid = new float4(.52f, .47f, .30f, 0);
            for (int i = 0; i < 2 + tier; i++)
            {
                // two on the ground side by side, then stacked
                float3 local = i < 3 ? new float3(.07f + (i == 2 ? .036f : 0f), 0, -.035f + (i == 1 ? .03f : 0f) + (i == 2 ? .015f : 0f))
                    : new float3(.07f, .019f * b * (i - 2), -.02f);
                local.y += .0095f * b;
                float t = i * .37f;
                KitPart(at, rot, 1f, local, quaternion.RotateY(t), new float3(.034f, .018f, .022f) * b, KitOlive);
                KitPart(at, rot, 1f, local + new float3(0, .0095f * b, 0), quaternion.RotateY(t), new float3(.035f, .003f, .023f) * b, lid);
            }
        }

        // ---------------------------------------------------------------- vehicles

        /// <summary>
        /// The kit on a ground vehicle. <paramref name="at"/>/<paramref name="rot"/>: the hull's Unity frame; offsets are in
        /// the drawn model's units (tracked hulls already at their .64 width and 1.12 length), times <paramref name="s"/>.
        /// </summary>
        void VehicleKit(Kind kind, int slot, float3 at, quaternion rot, float s, int equipment, bool close)
        {
            if (equipment == 0) return;
            int tier = KitTier(equipment);
            float b = close ? 1f : 1.3f;   // oversize at operational zoom
            float time = Time.time;
            switch (kind)
            {
                case Kind.Tank:
                    if ((equipment & KitReactive) != 0)
                    {
                        var tile = new float4(.30f, .32f, .25f, 0);
                        if (!close)   // close up UnitRenderer.AddVehicle draws the side tiles
                            for (int side = -1; side <= 1; side += 2) for (int t = 0; t < 3; t++)
                                KitPart(at, rot, s, new float3(side * .31f, .27f, -.28f + t * .26f), new float3(.06f, .12f * b, .22f), tile);
                        if (tier >= 2)
                        {
                            var swivel = math.mul(rot, quaternion.RotateY(yaw[slot] - turret[slot]));
                            for (int side = -1; side <= 1; side += 2)
                                KitPart(at, swivel, s, new float3(side * .15f, .45f, .25f), quaternion.RotateY(side * .4f), new float3(.13f, .1f, .05f) * b, tile);
                        }
                        if (tier >= 3)
                            for (int t = -1; t <= 1; t++)
                                KitPart(at, rot, s, new float3(t * .13f, .33f, .6f), quaternion.RotateX(.9f), new float3(.12f, .03f, .11f) * b, tile);
                    }
                    break;
                case Kind.ArmoredCar:
                    if ((equipment & KitSmoke) != 0)
                    {
                        int tubes = tier >= 2 ? 4 : 3;
                        for (int side = -1; side <= 1; side += 2)
                        {
                            Dischargers(at, rot, s, new float3(side * .27f, .37f, .28f), side, 0f, tubes, b);
                            if (tier >= 3) Dischargers(at, rot, s, new float3(side * .26f, .37f, -.40f), side, math.PI, 3, b);
                        }
                    }
                    break;
                case Kind.FieldGun:
                    if ((equipment & KitCamo) != 0) CamoNet(at, rot, s, slot, tier, b);
                    break;
                case Kind.Buggy:
                    if ((equipment & KitSensor) != 0)
                    {
                        // telescopic spotter mast at the rear, taller by tier, its sensor head slowly panning
                        float seg = .13f + .05f * tier;
                        var mast = new float3(0, .40f, -.30f);
                        KitPart(at, rot, s, mast + new float3(0, seg * .5f, 0), new float3(.055f * b, seg, .055f * b), KitDark);
                        KitPart(at, rot, s, mast + new float3(0, seg * 1.5f, 0), new float3(.04f * b, seg, .04f * b), KitSteel);
                        KitPart(at, rot, s, mast + new float3(0, seg * 2.4f, 0), new float3(.028f * b, seg * .8f, .028f * b), KitSteel);
                        var head = mast + new float3(0, seg * 2.8f + .035f * b, 0);
                        var pan = quaternion.RotateY(Mathf.Sin(time * .5f + slot) * 1.2f);
                        KitPart(at, rot, s, head, pan, new float3(.14f, .08f, .10f) * b, KitLight);
                        KitPart(at, rot, s, head + math.rotate(pan, new float3(0, 0, .05f * b)), pan, new float3(.08f, .05f, .02f) * b, KitLens);
                    }
                    break;
                case Kind.AirDefense:
                    if ((equipment & KitSensor) != 0)
                    {
                        // search radar on a post at the rear, rotating; tier 3 adds an IFF bar on top
                        var post = new float3(0, .53f, -.33f);
                        KitPart(at, rot, s, post + new float3(0, .07f, 0), new float3(.05f * b, .14f, .05f * b), KitDark);
                        var spin = math.mul(quaternion.RotateY(time * 2.2f + slot), quaternion.RotateX(-.25f));
                        float w = .30f + .06f * tier;
                        KitPart(at, rot, s, post + new float3(0, .24f, 0), spin, new float3(w, .2f, .025f) * b, KitLight);
                        KitPart(at, rot, s, post + new float3(0, .24f, 0) + math.rotate(spin, new float3(0, 0, .07f * b)), spin, new float3(.03f, .03f, .12f) * b, KitDark);
                        if (tier >= 3) KitPart(at, rot, s, post + new float3(0, .38f * b, 0), spin, new float3(.2f, .04f, .02f) * b, KitSteel);
                    }
                    break;
                case Kind.Apc:
                    if ((equipment & KitExhaust) != 0)
                    {
                        float h = .24f + .05f * tier;
                        for (int side = -1; side <= 1; side += 2)
                            for (int n = 0; n < (tier >= 2 ? 2 : 1); n++)
                            {
                                var stack = new float3(side * .26f, .32f + h * .5f, -.40f + n * .1f);
                                KitPart(at, rot, s, stack, new float3(.05f * b, h, .05f * b), KitDark);
                                KitPart(at, rot, s, stack + new float3(0, h * .5f + .01f, 0), new float3(.075f * b, .02f, .075f * b), KitSteel);
                            }
                    }
                    break;
                case Kind.Ifv:
                    if ((equipment & KitTools) != 0)
                    {
                        // toolbox on the rear deck and spare track links on the glacis; more stowage by tier
                        KitPart(at, rot, s, new float3(-.12f, .50f, -.48f), new float3(.18f, .07f, .10f) * b, KitTan);
                        for (int t = -1; t <= 1; t++)
                            KitPart(at, rot, s, new float3(t * .085f, .38f, .55f), quaternion.RotateX(.9f), new float3(.075f, .02f, .06f) * b, KitDark);
                        if (tier >= 2) KitPart(at, rot, s, new float3(.25f, .33f, -.1f), new float3(.07f, .08f, .26f) * b, KitTan);
                        if (tier >= 3)
                            for (int side = -1; side <= 1; side += 2)
                                KitPart(at, rot, s, new float3(side * .2f, .32f, -.62f), new float3(.06f, .11f, .04f) * b, KitOlive);
                    }
                    break;
                case Kind.AutoTank:
                    if ((equipment & KitTools) != 0)
                    {
                        // maintenance pods along the hull sides with a service light; tier 3 a manipulator arm
                        for (int side = -1; side <= 1; side += 2)
                            for (int n = 0; n < (tier >= 2 ? 2 : 1); n++)
                            {
                                var pod = new float3(side * .31f, .27f, -.25f + n * .3f);
                                KitPart(at, rot, s, pod, new float3(.08f * b, .08f * b, .22f), KitLight);
                                KitPart(at, rot, s, pod + new float3(0, .04f * b + .005f, 0), new float3(.025f, .01f, .18f), KitCyan);
                            }
                        if (tier >= 3)
                        {
                            var swing = quaternion.RotateY(Mathf.Sin(time * .4f + slot) * .8f);
                            KitPart(at, rot, s, new float3(0, .44f, -.45f), new float3(.04f, .12f, .04f) * b, KitSteel);
                            KitPart(at, rot, s, new float3(0, .52f, -.45f) + math.rotate(swing, new float3(0, 0, .08f)), math.mul(swing, quaternion.RotateX(1.2f)), new float3(.03f, .18f, .03f) * b, KitSteel);
                        }
                    }
                    break;
                case Kind.Truck:
                    if ((equipment & KitTools) != 0) Workshop(at, rot, s, slot, tier, b, time);
                    break;
                case Kind.SpGun:
                    if ((equipment & KitAmmo) != 0)
                    {
                        // shell racks along the rear hull sides: brass rounds standing in a dark frame
                        int rounds = 2 + tier;
                        for (int side = -1; side <= 1; side += 2)
                        {
                            KitPart(at, rot, s, new float3(side * .32f, .25f, -.5f + rounds * .035f), new float3(.05f, .02f, rounds * .07f + .02f), KitDark);
                            for (int r = 0; r < rounds; r++)
                                KitPart(at, rot, s, new float3(side * .32f, .30f, -.47f + r * .07f), new float3(.04f * b, .11f, .04f * b), KitBrass);
                            KitPart(at, rot, s, new float3(side * .32f, .35f, -.5f + rounds * .035f), new float3(.05f, .015f, rounds * .07f + .02f), KitDark);
                        }
                    }
                    break;
                case Kind.Launcher:
                    if ((equipment & KitPods) != 0) ExtraTubes(at, rot, s, slot, tier, b, close);
                    break;
            }
        }

        /// <summary>A cluster of smoke-grenade tubes on a block, splayed outward and up.</summary>
        void Dischargers(float3 at, quaternion rot, float s, float3 local, int side, float yawBase, int tubes, float b)
        {
            KitPart(at, rot, s, local, quaternion.RotateY(yawBase), new float3(.11f, .04f, .08f) * b, KitDark);
            for (int i = 0; i < tubes; i++)
            {
                var turn = math.mul(quaternion.RotateY(yawBase + side * (.25f + i * .3f)), quaternion.RotateX(.75f));
                var tip = local + new float3((i - (tubes - 1) * .5f) * .028f * b, .045f * b, 0);
                KitPart(at, rot, s, tip, turn, new float3(.032f, .10f, .032f) * b, KitDark);
                KitPart(at, rot, s, tip + math.rotate(turn, new float3(0, .05f * b, 0)), turn, new float3(.026f, .008f, .026f) * b, KitOlive);
            }
        }

        /// <summary>A camouflage net pitched over the field gun like a low tent, with leafy tufts (more by tier).</summary>
        void CamoNet(float3 at, quaternion rot, float s, int slot, int tier, float b)
        {
            for (int side = -1; side <= 1; side += 2)
            {
                KitPart(at, rot, s, new float3(side * .19f, .36f, .02f), quaternion.RotateZ(side * -.42f), new float3(.42f, .025f, .95f), Leaf[side < 0 ? 0 : 1]);
                KitPart(at, rot, s, new float3(side * .38f, .12f, .02f), quaternion.RotateZ(side * -.25f), new float3(.03f, .22f, .85f), Leaf[3]);   // the drape to the ground
            }
            int tufts = 3 + 3 * tier;
            for (int i = 0; i < tufts; i++)
            {
                int seed = slot * 37 + i * 11;
                float x = (Trait(seed, 1) - .5f) * .6f, z = (Trait(seed, 2) - .5f) * .85f;
                float y = .30f + .12f * (1f - math.abs(x) / .3f);
                KitPart(at, rot, s, new float3(x, y, z), quaternion.EulerZXY(Trait(seed, 3) * .4f - .2f, Trait(seed, 4) * 3f, x * -1.2f),
                    new float3(.14f, .05f, .12f) * b, Leaf[i & 3]);
            }
        }

        /// <summary>The support truck's mobile workshop: a slewing yellow crane on the bed and toolboxes along the sides.</summary>
        void Workshop(float3 at, quaternion rot, float s, int slot, int tier, float b, float time)
        {
            var bed = new float3(0, .49f, -.30f);
            KitPart(at, rot, s, bed + new float3(0, .03f, 0), new float3(.14f, .06f, .14f) * b, KitYellow);
            var slew = quaternion.RotateY(Mathf.Sin(time * .3f + slot * 1.7f) * .7f);
            var crane = math.mul(rot, slew);
            var top = at + math.rotate(rot, (bed + new float3(0, .18f, 0)) * s);
            KitPart(top, crane, s, new float3(0, -.06f, 0), new float3(.07f * b, .12f, .07f * b), KitYellow);   // column
            const float boom = .44f, lift = -.8f;
            var boomTurn = quaternion.RotateX(lift);
            var mid = math.rotate(boomTurn, new float3(0, boom * .5f, 0));
            KitPart(top, crane, s, mid, boomTurn, new float3(.05f * b, boom, .05f * b), KitYellow);
            var tip = math.rotate(boomTurn, new float3(0, boom, 0));
            KitPart(top, crane, s, tip - new float3(0, .1f, 0), new float3(.012f, .2f, .012f), KitDark);           // hook line
            KitPart(top, crane, s, tip - new float3(0, .21f, 0), new float3(.05f, .03f, .04f) * b, KitDark);       // hook block
            for (int side = -1; side <= 1; side += 2)
                for (int n = 0; n < tier; n++)
                    KitPart(at, rot, s, new float3(side * .37f, .22f, .10f - n * .17f), new float3(.05f, .10f * b, .14f), n == 1 ? KitTan : KitRedBox);
        }

        /// <summary>The missile battery's extra salvo: a row of launch tubes riding on top of its pod (raised with it).</summary>
        void ExtraTubes(float3 at, quaternion rot, float s, int slot, int tier, float b, bool close)
        {
            LauncherPose(slot, out _, out float raise);
            var podRot = math.mul(rot, quaternion.RotateX(-PodElevation * raise));
            var hinge = at + math.rotate(rot, (close ? PodHinge : PodHingeLo) * s);
            float top = close ? .19f : .24f;
            int n = tier >= 3 ? 4 : 2;
            for (int i = 0; i < n; i++)
            {
                float x = (i - (n - 1) * .5f) * (n == 4 ? .105f : .14f);
                KitPart(hinge, podRot, s, new float3(x, top + .045f * b, .27f), new float3(.095f, .085f * b, .5f), KitOlive);
                KitPart(hinge, podRot, s, new float3(x, top + .045f * b, .525f), new float3(.07f, .06f * b, .012f), KitDark);   // tube mouth
            }
        }

        // ---------------------------------------------------------------- aircraft

        /// <summary>Kit on an aircraft in its drawn frame (map position <paramref name="pos"/>, Unity rotation, model scale).</summary>
        void AirKit(Kind kind, int slot, float3 pos, quaternion rot, float s, bool close, float phaseA)
        {
            int equipment = kitEquipment;
            if (equipment == 0) return;
            int tier = KitTier(equipment);
            float b = close ? 1f : 1.3f;
            var at = MapSpace.W(pos);
            switch (kind)
            {
                case Kind.Heli:
                    if ((equipment & KitFlares) != 0)
                    {
                        float k = .28f * s;
                        for (int side = -1; side <= 1; side += 2)
                        {
                            Dispenser(at, rot, k, new float3(side * .075f, .17f, -.46f), b);
                            if (tier >= 2) Dispenser(at, rot, k, new float3(side * .28f, .10f, -.08f), b);
                            if (tier >= 3) Dispenser(at, rot, k, new float3(side * .07f, .20f, -.62f), b);
                        }
                    }
                    break;
                case Kind.Bomber:
                    if ((equipment & KitFlares) != 0)
                    {
                        float k = .64f * s;
                        for (int side = -1; side <= 1; side += 2)
                        {
                            Dispenser(at, rot, k, new float3(side * .09f, -.03f, -.42f), b);
                            if (tier >= 2) Dispenser(at, rot, k, new float3(side * .24f, -.03f, -.08f), b);
                            if (tier >= 3) Dispenser(at, rot, k, new float3(side * .09f, -.03f, -.30f), b);
                        }
                    }
                    break;
                case Kind.Fighter:
                    if ((equipment & KitRocketPods) != 0)
                    {
                        float k = .48f * s;
                        for (int side = -1; side <= 1; side += 2)
                            for (int n = 0; n < tier; n++)
                            {
                                var pod = new float3(side * (.26f + n * .1f), -.09f, .04f);
                                KitPart(at, rot, k, pod + new float3(0, .05f, 0), new float3(.015f, .04f, .08f), KitDark);    // pylon
                                KitPart(at, rot, k, pod, new float3(.07f * b, .07f * b, .26f), new float4(.22f, .24f, .22f, 0));
                                KitPart(at, rot, k, pod + new float3(0, 0, .14f), new float3(.05f * b, .05f * b, .03f), KitLight);   // the tubes' front cap
                            }
                    }
                    break;
                case Kind.Drone:
                {
                    float k = .12f * s;
                    if (!strikeDrone[slot] && (equipment & KitSensor) != 0)
                    {
                        // thermal camera: a gimballed ball under the nose, slowly turning
                        float size = (.12f + .02f * tier) * b;
                        var gimbal = quaternion.RotateY(Mathf.Sin(Time.time * .7f + slot) * .9f);
                        KitPart(at, rot, k, new float3(0, -.12f, .2f), gimbal, new float3(size, size, size), KitDark);
                        KitPart(at, rot, k, new float3(0, -.12f, .2f) + math.rotate(gimbal, new float3(0, 0, size * .5f)), gimbal, new float3(size * .5f, size * .5f, .02f), KitLens);
                    }
                    if (strikeDrone[slot] && (equipment & KitAmmo) != 0)
                    {
                        // shaped charge: a larger warhead nose with a yellow band
                        float size = (.15f + .03f * tier) * b;
                        KitPart(at, rot, k, new float3(0, .02f, .30f), quaternion.RotateZ(math.PI * .25f), new float3(size, size, .24f), KitOlive);
                        KitPart(at, rot, k, new float3(0, .02f, .21f), quaternion.RotateZ(math.PI * .25f), new float3(size * 1.05f, size * 1.05f, .03f), KitYellow);
                        KitPart(at, rot, k, new float3(0, .02f, .43f), quaternion.RotateZ(math.PI * .25f), new float3(size * .5f, size * .5f, .04f), KitDark);
                    }
                    break;
                }
                case Kind.Swarm:
                    if ((equipment & KitPods) != 0)
                    {
                        // each drone of the swarm (same orbit as AddAircraft) carries extra munition pods under it
                        float k = .07f * s;
                        for (int d = 0; d < 6; d++)
                        {
                            float a = phaseA * 1.3f + d * 1.047f;
                            var dp = pos + new float3(Mathf.Cos(a) * 0.12f, Mathf.Sin(a * 2) * 0.03f, Mathf.Sin(a) * 0.12f);
                            var dat = MapSpace.W(dp);
                            var drot = quaternion.RotateY(MapSpace.Yaw(a + 1.57f));
                            for (int n = 0; n < (tier >= 2 ? 2 : 1); n++)
                            {
                                float x = tier >= 2 ? (n == 0 ? -.16f : .16f) : 0f;
                                KitPart(dat, drot, k, new float3(x, -.12f, 0), new float3(.2f, .14f, .42f) * (tier >= 3 ? 1.25f : 1f) * b, KitOlive);
                                KitPart(dat, drot, k, new float3(x, -.12f, .22f), new float3(.12f, .1f, .04f) * b, KitRedBox);
                            }
                        }
                    }
                    break;
            }
        }

        void Dispenser(float3 at, quaternion rot, float k, float3 local, float b)
        {
            KitPart(at, rot, k, local, new float3(.05f, .05f, .11f) * b, KitDark);
            KitPart(at, rot, k, local + new float3(0, 0, -.06f * b), new float3(.04f, .04f, .01f) * b, KitFlare);
        }

        // ---------------------------------------------------------------- infantry

        /// <summary>Upgrade kit on a rigged soldier (offsets in model units like the barracks kit in AddRigged).</summary>
        void RiggedKit(int role, float3 at, quaternion rot, float s, float build, float kitDrop, float kitForward, float kitLean, int equipment, int seed)
        {
            var torsoRot = kitLean != 0f ? math.mul(rot, quaternion.RotateX(kitLean)) : rot;
            if ((equipment & KitArmour) != 0 && role == (int)Detail.Engineer - (int)Detail.Rifle)
            {
                // Armoured Vests: a combat helmet shell over the hard hat (its team-coloured brim still shows)
                var helmet = at + math.rotate(rot, new float3(0, .955f - kitDrop, kitForward) * s);
                batches[(int)Model.Plate].Add(InstanceData.TRS(helmet, torsoRot, new float3(.19f, .065f, .21f) * s, KitOlive));
            }
            if ((equipment & KitCamo) != 0)
            {
                int n = 4 + 2 * KitTier(equipment);
                for (int i = 0; i < n && i < GhillieSpots.Length; i++)
                {
                    var o = GhillieSpots[i];
                    var p = at + math.rotate(rot, new float3(o.x * build, o.y - kitDrop, o.z * build + kitForward) * s);
                    var turn = math.mul(torsoRot, quaternion.EulerZXY(Trait(seed, 30 + i) * .8f - .4f, Trait(seed, 40 + i) * 3f, Trait(seed, 50 + i) * .6f - .3f));
                    batches[(int)Model.Plate].Add(InstanceData.TRS(p, turn, new float3(.11f, .045f, .13f) * s, Leaf[(seed + i) & 3]));
                }
            }
        }

        /// <summary>Upgrade kit on the procedural figure, in its chest frame.</summary>
        void ProceduralKit(Detail torso, float3 torsoOrigin, quaternion chest, float scale, int equipment, float life)
        {
            if ((equipment & KitArmour) != 0)
            {
                batches[(int)Model.Plate].Add(InstanceData.TRS(torsoOrigin + math.rotate(chest, new float3(0, .55f, .1f) * scale), chest, new float3(.21f, .2f, .045f) * scale, KitOlive));
                batches[(int)Model.Plate].Add(InstanceData.TRS(torsoOrigin + math.rotate(chest, new float3(0, .56f, -.105f) * scale), chest, new float3(.2f, .19f, .04f) * scale, KitOlive));
                if (torso == Detail.Engineer)
                    batches[(int)Model.Plate].Add(InstanceData.TRS(torsoOrigin + math.rotate(chest, new float3(0, .92f, 0) * scale), chest, new float3(.18f, .07f, .2f) * scale, KitOlive));
            }
            if ((equipment & KitCamo) != 0)
            {
                int n = 4 + 2 * KitTier(equipment), seed = (int)(life * 1000f);
                for (int i = 0; i < n && i < GhillieSpots.Length; i++)
                {
                    var p = torsoOrigin + math.rotate(chest, GhillieSpots[i] * scale);
                    var turn = math.mul(chest, quaternion.EulerZXY(Trait(seed, 30 + i) * .8f - .4f, Trait(seed, 40 + i) * 3f, 0));
                    batches[(int)Model.Plate].Add(InstanceData.TRS(p, turn, new float3(.11f, .045f, .13f) * scale, Leaf[i & 3]));
                }
            }
        }

        /// <summary>
        /// Operational-zoom kit on the simple soldier figure: only what changes the silhouette or colour enough to read
        /// at a few pixels: the ghillie hump, body armour and the slung rocket.
        /// </summary>
        void SimpleKit(float3 foot, float heading, float scale, int equipment, Detail torso)
        {
            if ((equipment & (KitCamo | KitArmour | 64)) == 0) return;
            var at = MapSpace.W(foot);
            var rot = quaternion.RotateY(MapSpace.Yaw(heading));
            if ((equipment & KitCamo) != 0)
            {
                KitPart(at, rot, scale, new float3(0, .66f, -.05f), new float3(.40f, .34f, .36f), Leaf[0]);
                KitPart(at, rot, scale, new float3(0, .95f, 0), quaternion.RotateY(.6f), new float3(.3f, .1f, .3f), Leaf[1]);
            }
            else if ((equipment & KitArmour) != 0)
                KitPart(at, rot, scale, new float3(0, .62f, .02f), new float3(.34f, .24f, .32f), KitOlive);
            if ((equipment & 64) != 0 && torso != Detail.Engineer)
                KitPart(at, rot, scale, new float3(.04f, .68f, -.16f), quaternion.RotateZ(.55f), new float3(.07f, .62f, .07f), new float4(.30f, .33f, .24f, 0));
        }
    }
}
