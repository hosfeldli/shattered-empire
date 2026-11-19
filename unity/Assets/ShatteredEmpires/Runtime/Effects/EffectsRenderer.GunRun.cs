using Unity.Mathematics;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Rotary-cannon effects for the Warthog's gun runs (GameBootstrap.GunRun.cs drives them ~30 times a second for
    /// the length of a burst). Kept light on purpose: a run fires many rounds, so each pulse is a handful of
    /// particles instead of a full Explosion (no flash light, no shake, no shock ring).
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        /// <summary>The cannon's muzzle: a long flickering flash along the line of fire and a thin gun-smoke trail.</summary>
        public void GunFlash(float3 p, float3 direction)
        {
            var forward = math.normalizesafe(direction, new float3(0, 0, 1));
            Emit(p + forward * .03f, float3.zero, .03f + R() * .015f, 0, .05f, new float3(1, .86f, .5f), new float3(.95f, .38f, .08f), 1f, true, 1.6f,
                0, 0, Streak, forward * (.16f + R() * .08f));
            Emit(p, float3.zero, .05f, .1f, .04f, new float3(1, .8f, .45f), new float3(1, .5f, .15f), .85f, true, 1.4f);
            if (R() < .35f) Emit(p - forward * .02f, Wind * .1f + new float3(0, .05f, 0), .03f, .14f, .9f + R() * .5f,
                new float3(.55f, .55f, .53f), new float3(.68f, .68f, .66f), .22f, false, 0, .8f, .03f);
        }

        /// <summary>One cannon round striking the ground: a small flash, a dirt spurt and, on armour, sparks.</summary>
        public void GunImpact(float3 p, int biome, bool armor)
        {
            if (biome <= 1 && !armor)
            {
                // water: a thin column of spray
                for (int k = 0; k < 3; k++)
                    Emit(p, new float3(R() - .5f, 1.2f + R(), R() - .5f) * .35f, .018f, .02f, .5f + R() * .2f, new float3(.74f, .84f, .86f), new float3(.62f, .72f, .76f), .7f, false, 0, .5f, -2.6f);
                return;
            }
            Emit(p + new float3(0, .02f, 0), float3.zero, .05f, .12f, .06f, new float3(1, .82f, .48f), new float3(.9f, .35f, .08f), .9f, true, 1.5f);
            var dirt = biome >= 9 ? new float3(.50f, .48f, .44f) : biome == 5 ? new float3(.69f, .58f, .39f) : new float3(.42f, .36f, .26f);
            for (int k = 0; k < 3; k++)
            {
                var v = new float3(R() - .5f, .9f + R() * .9f, R() - .5f) * .55f;
                Emit(p, v, .028f + R() * .02f, .09f, .7f + R() * .5f, dirt, dirt * 1.15f, .65f, false, 0, 1.4f, -.9f);
            }
            float floor = GroundAt != null ? GroundAt(p.x, p.z) : p.y - .01f;
            for (int k = 0; k < 2; k++)
                EmitDebris(p + new float3(0, .02f, 0), new float3(R() - .5f, 1f + R(), R() - .5f) * .5f, .008f + R() * .006f, .8f + R() * .5f, dirt * .7f, floor, -3.2f);
            if (armor)
                for (int k = 0; k < 4; k++)
                    Emit(p + new float3(0, .03f, 0), RandDir() * (.9f + R()), .004f, 0, .15f + R() * .2f, new float3(1, .85f, .55f), new float3(.95f, .3f, .05f), .95f, true, 2, .5f, -1f, Streak, default, true);
        }
    }
}
