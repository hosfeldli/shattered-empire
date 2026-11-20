using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Tank gun effects (2026-11-20 tank pass: the main gun fires slower, heavier high-explosive rounds whose impact is an
    /// area blast, server def.blast; a coaxial machine gun fires tracer bursts at infantry). A big muzzle blast with a
    /// flash cone, side-venting brake smoke and a dust ring kicked off the ground under the barrel; on impact a sized
    /// fireball, a ground ring that sweeps out to the server's blast radius (the impact event's r) and a dust skirt, so
    /// what the round covers reads on screen.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        /// <summary>Main-gun blast at the muzzle. premium: the autonomous tank's (cooler, cyan-white flash).</summary>
        public void TankGunBlast(float3 p, float3 direction, bool premium)
        {
            var forward = math.normalizesafe(new float3(direction.x, 0, direction.z), new float3(0, 0, 1));
            var side = new float3(forward.z, 0, -forward.x);
            var hot = premium ? new float3(.85f, .95f, 1f) : new float3(1f, .86f, .45f);
            var cool = premium ? new float3(.35f, .7f, 1f) : new float3(.95f, .38f, .07f);
            // the flash: a long forward streak, a fat core and a short cone of fire
            Emit(p + forward * .06f, float3.zero, .06f, 0, .10f, hot, cool, 1f, true, 1.8f, 0, 0, Streak, forward * .42f);
            Emit(p + forward * .03f, float3.zero, .09f, .25f, .09f, hot, cool, .9f, true, 1.4f);
            for (int k = 0; k < 4; k++)
                Emit(p + forward * .04f, forward * (1.2f + R()) + RandDir() * .25f, .025f, .05f, .12f, hot, cool, .9f, true, 1.6f, 3f);
            // brake vents: smoke jets out of both sides of the muzzle brake, then a drifting forward cloud
            for (int s = -1; s <= 1; s += 2)
                for (int k = 0; k < 2; k++)
                    Emit(p + side * s * .02f, side * s * (.35f + R() * .15f) + forward * .08f + new float3(0, .04f, 0), .045f, .30f, 1.1f + R() * .4f,
                        new float3(.62f, .61f, .58f), new float3(.72f, .71f, .69f), .32f, false, 0, 2.2f, .03f);
            Emit(p + forward * .10f, Wind * .1f + forward * .16f + new float3(0, .06f, 0), .10f, .55f, 2.0f, new float3(.58f, .57f, .54f), new float3(.70f, .69f, .67f), .30f, false, 0, 1.2f, .04f);
            // the overpressure kicks a ring of dust off the ground below and ahead of the barrel
            float floor = GroundAt != null ? GroundAt(p.x, p.z) : p.y - .1f;
            var dust = new float3(p.x, floor + .01f, p.z) + forward * .08f;
            for (int k = 0; k < 6; k++)
            {
                float a = k / 6f * 6.283f + R() * .5f;
                var out_ = new float3(math.cos(a), 0, math.sin(a));
                Emit(dust, out_ * .32f + forward * .2f + new float3(0, .03f, 0), .05f, .26f, 1.2f + R() * .5f,
                    new float3(.55f, .49f, .39f), new float3(.62f, .58f, .50f), .30f, false, 0, 2f, .01f);
            }
            FlashLight(p, premium ? 1f : .9f);
            Shake = Mathf.Max(Shake, .035f);
        }

        /// <summary>A tank round's area blast: a fireball and a ground ring sweeping out to the server's blast radius.</summary>
        public void TankShellBlast(float3 p, float radius, bool premium)
        {
            float scale = math.max(.75f, radius * 1.9f);
            Explosion(p, scale);
            // the lethal area: a bright ring racing out to the blast radius and a scorched flash disc
            var ring = premium ? new float3(.7f, .9f, 1f) : new float3(1f, .78f, .42f);
            Emit(p + new float3(0, .02f, 0), float3.zero, .05f, radius * 5.2f, .38f, ring, new float3(1f, .45f, .12f), .55f, true, .6f, 0, 0, Ring);
            Emit(p + new float3(0, .015f, 0), float3.zero, .05f, radius * 4.6f, .9f, new float3(.52f, .47f, .40f), new float3(.60f, .56f, .50f), .4f, false, 0, 0, 0, Ring);
            // dust skirt rolling out across the blast area
            for (int k = 0; k < 8; k++)
            {
                float a = k / 8f * 6.283f + R() * .4f;
                Emit(p + new float3(0, .02f, 0), new float3(math.cos(a), .04f, math.sin(a)) * radius * 1.9f, .07f, .30f, 1.4f + R() * .8f,
                    new float3(.47f, .42f, .35f), new float3(.58f, .55f, .49f), .34f, false, 0, 2.2f, .015f);
            }
            GroundShock(p, radius * 2.2f, .55f);
        }
    }
}
