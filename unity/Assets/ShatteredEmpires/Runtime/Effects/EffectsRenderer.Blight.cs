using Unity.Mathematics;
using UnityEngine;
using SE.Runtime.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// BLIGHT survival mode effects (docs/gameplay-overhaul/HORDE_MODE.md): ichor, acid, spores, eruptions. All
    /// positions are map space (x, ground height, z). The palette stays sickly (bile green, bruise purple, pus yellow)
    /// so the horde never reads as a team colour or as ordinary blood and fire.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        static readonly float3 Bile = new float3(.55f, .72f, .14f), BileDark = new float3(.2f, .28f, .05f);
        static readonly float3 Pus = new float3(.86f, .82f, .42f), Bruise = new float3(.32f, .16f, .26f);
        static readonly float3 Ichor = new float3(.3f, .36f, .1f), Spore = new float3(.62f, .7f, .38f);

        /// <summary>A creature torn apart: a wet burst of ichor and flesh, and a dark stain left on the ground.</summary>
        public void BlightGore(float3 p, float size, bool big = false)
        {
            float floor = GroundOr(p);
            int n = Mathf.Max(3, (int)((big ? 14 : 6) * Intensity));
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - .5f, R() * 1.2f + .5f, R() - .5f) * (big ? 1.3f : .8f) * size * 6f;
                var c = R() < .3f ? Bruise : R() < .5f ? Ichor : BileDark;
                EmitDebris(p + new float3(0, .02f, 0), v, (.006f + R() * .01f) * (big ? 2.2f : 1f), .8f + R() * .9f, c, floor, -3.6f);
            }
            Emit(p + new float3(0, .02f, 0), float3.zero, .05f * size * 8f, .18f * size * 8f, .5f, Bile * .8f, BileDark, .55f, false, 0, 2f, .02f);
            BlightSplat(p, (big ? .28f : .14f) * (.8f + R() * .5f));
        }

        /// <summary>A lasting dark-green stain (creature remains, acid burns), on the scorch decals.</summary>
        public void BlightSplat(float3 p, float size)
        {
            float y = GroundOr(p);
            var d = InstanceData.TRS(MapSpace.W(new float3(p.x, y, p.z)) + new float3(0, .007f, 0), R() * 6.28f,
                new float3(size * 2f, 1, size * 2f * (.7f + R() * .5f)) * MarkScale, MarkColor(new float3(.2f + R() * .05f, .27f, .07f), .82f));
            craters.Add(d, markClock);
        }

        /// <summary>A glob of acid lobbed from a spitter: a trail of droplets on an arc, then a hissing splash.</summary>
        public void BlightSpit(float3 from, float3 to)
        {
            int n = Mathf.Max(4, (int)(7 * Intensity));
            for (int k = 0; k < n; k++)
            {
                float t = k / (float)n;
                var p = math.lerp(from, to, t) + new float3(0, math.sin(t * math.PI) * math.distance(from, to) * .32f + .03f, 0);
                Emit(p, new float3(0, -.05f, 0), .016f + .01f * (1 - t), .01f, .18f + t * .3f, Bile, BileDark, .9f, true, .5f, 1f, -.2f);
            }
            BlightAcid(to, .5f);
        }

        /// <summary>Acid landing: a splash of bright bile and a curl of greenish vapour.</summary>
        public void BlightAcid(float3 p, float scale)
        {
            Emit(p + new float3(0, .02f, 0), float3.zero, .05f * scale, .16f * scale, .22f, new float3(.8f, 1f, .3f), Bile, .85f, true, 1.2f);
            for (int k = 0; k < 4; k++)
                Emit(p + new float3(0, .02f, 0), new float3(R() - .5f, R() * .5f + .2f, R() - .5f) * .25f * scale, .04f * scale, .18f * scale, 1.2f + R(),
                    Spore, new float3(.5f, .55f, .4f), .4f, false, 0, 1.2f, .08f);
            if (R() < .4f) BlightSplat(p, .06f * scale + .03f);
        }

        /// <summary>The ground heaving and splitting as creatures tunnel up (burrow ambush) or a husk claws out of its grave.</summary>
        public void BlightEruption(float3 p, float scale)
        {
            float floor = GroundOr(p);
            int n = Mathf.Max(4, (int)(10 * Intensity * scale));
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - .5f, R() * 1.4f + .8f, R() - .5f) * .9f * scale;
                float g = .16f + R() * .08f;
                EmitDebris(p + new float3((R() - .5f) * .2f * scale, .02f, (R() - .5f) * .2f * scale), v, (.01f + R() * .016f) * scale, 1.2f + R(), new float3(g, g * .86f, g * .7f), floor, -3.4f);
            }
            for (int k = 0; k < 5; k++)
                Emit(p + new float3(0, .03f, 0), new float3(R() - .5f, R() * .3f + .1f, R() - .5f) * .4f * scale, .1f * scale, .4f * scale, 2f + R() * 1.5f,
                    new float3(.4f, .37f, .3f), new float3(.55f, .53f, .46f), .45f, false, 0, 1.4f, .03f);
            Emit(p + new float3(0, .02f, 0), float3.zero, .2f * scale, .5f * scale, .5f, BileDark, BileDark, .4f, false, 0, 0, 0, Ring);
            if (scale > .9f) GroundShock(p, scale * 1.3f, .7f);
            Shake = Mathf.Max(Shake, .05f * scale);
        }

        /// <summary>A cloud of spores rising from a corpse that will not stay dead (infection), or puffing from a hive.</summary>
        public void BlightSpores(float3 p, float scale)
        {
            int n = Mathf.Max(3, (int)(6 * Intensity));
            for (int k = 0; k < n; k++)
                Emit(p + new float3((R() - .5f) * .1f, .03f, (R() - .5f) * .1f), new float3(R() - .5f, R() * .4f + .15f, R() - .5f) * .12f * scale,
                    .03f * scale, .12f * scale, 2.5f + R() * 2f, Spore, new float3(.45f, .5f, .3f), .5f, false, 0, .8f, .05f);
            if (R() < .5f) Emit(p + new float3(0, .04f, 0), new float3(0, .05f, 0), .02f * scale, .05f * scale, 1.2f, Pus, Bile, .8f, true, .4f, .5f, .02f);
        }

        /// <summary>A colossus slam: a shock ring of dust and flesh, a heavy thump in the camera.</summary>
        public void BlightSlam(float3 p, float radius)
        {
            for (int k = 0; k < 10; k++)
            {
                float a = k / 10f * 6.283f + R() * .3f;
                Emit(p + new float3(0, .03f, 0), new float3(math.cos(a), .05f, math.sin(a)) * radius * 1.4f, .07f, .26f, 1.1f + R() * .6f,
                    new float3(.42f, .38f, .3f), new float3(.55f, .5f, .44f), .5f, false, 0, 2f, .02f);
            }
            Emit(p + new float3(0, .02f, 0), float3.zero, radius * .5f, radius * 1.6f, .45f, BileDark, BileDark, .35f, false, 0, 0, 0, Ring);
            GroundShock(p, radius * 1.6f, .55f);
            Shake = Mathf.Max(Shake, .16f);
        }

        /// <summary>A burst broodsac: a wet pop and a spray of pus and membrane.</summary>
        public void BlightBurst(float3 p)
        {
            Emit(p + new float3(0, .05f, 0), float3.zero, .08f, .4f, .35f, Pus, Bile, .8f, false, 0, 2f);
            BlightGore(p, .03f, true);
        }

        /// <summary>A hive burning down: a sickly fire, a column of spore smoke and a lot of mess.</summary>
        public void BlightHiveBurn(float3 p)
        {
            Explosion(p, .9f);
            for (int k = 0; k < 6; k++) Fire(p + new float3((R() - .5f) * .6f, .02f, (R() - .5f) * .6f), .25f);
            for (int k = 0; k < 8; k++)
                Emit(p + new float3(0, .1f, 0), new float3(R() - .5f, R() + .6f, R() - .5f) * .3f, .15f, .6f, 5f + R() * 3f, Spore * .7f, new float3(.35f, .38f, .28f), .5f, false, 0, .5f, .08f);
            BlightGore(p, .06f, true);
            Shake = Mathf.Max(Shake, .2f);
        }
    }
}
