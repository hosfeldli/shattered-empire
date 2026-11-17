using Unity.Mathematics;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// What the barracks upgrades look like in battle (server actionUpgrades.js event flags): a grenade lands and
    /// throws a ring of dust over the troops in cover (the server's area burst); a squad's anti-tank rocket leaves
    /// with a back-blast and a smoke trail; a marksman's shot is one long, bright, fast streak; a round stopped by a
    /// plate carrier strikes a small spark. Pooled particles only.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        /// <summary>The grenade's area burst where it lands: a low ring of dust and thrown earth (the blast itself comes from the impact event).</summary>
        public void GrenadeBurst(float3 p)
        {
            float floor = GroundAt != null ? GroundAt(p.x, p.z) : p.y;
            var g = new float3(p.x, floor + .01f, p.z);
            Emit(g, float3.zero, .06f, .9f, .55f, new float3(.52f, .47f, .38f), new float3(.58f, .55f, .5f), .5f, false, 0, 0, 0, Ring);
            Emit(g + new float3(0, .02f, 0), float3.zero, .05f, .22f, .09f, new float3(1f, .8f, .45f), new float3(.9f, .35f, .08f), .9f, true, 1.3f);
            int n = 6 + (int)(4 * Intensity);
            for (int k = 0; k < n; k++)
            {
                float a = k * 6.2831853f / n + R() * .4f;
                var v = new float3(math.cos(a) * (.5f + R() * .3f), .25f + R() * .35f, math.sin(a) * (.5f + R() * .3f));
                Emit(g + new float3(0, .015f, 0), v * .45f, .03f, .09f, 1.4f + R() * .8f, new float3(.46f, .41f, .33f), new float3(.55f, .53f, .49f), .45f, false, 0, 2.2f, .04f);
            }
            for (int k = 0; k < 4; k++)
            {
                float shade = .18f + R() * .08f;
                EmitDebris(g, new float3(R() - .5f, 1f + R() * .6f, R() - .5f) * .5f, .006f + R() * .006f, 1.3f, new float3(shade, shade * .86f, shade * .7f), floor);
            }
        }

        /// <summary>The back-blast of a shoulder-fired anti-tank rocket (the rocket itself flies as a projectile).</summary>
        public void RocketBackBlast(float3 from, float3 to)
        {
            var back = math.normalizesafe(from - to, new float3(0, 0, -1));
            back.y = math.max(back.y, .05f);
            Emit(from + back * .02f, back * .55f, .03f, .16f, .12f, new float3(1f, .78f, .4f), new float3(.8f, .3f, .06f), .8f, true, 1.2f, 4f);
            for (int k = 0; k < 4; k++)
                Emit(from + back * .04f, back * (.35f + R() * .3f) + new float3((R() - .5f) * .15f, .06f, (R() - .5f) * .15f), .035f, .14f, 1.2f + R() * .6f,
                    new float3(.66f, .64f, .6f), new float3(.72f, .71f, .69f), .4f, false, 0, 2.5f, .03f);
        }

        /// <summary>A designated marksman's precision shot: one long, bright, fast streak and a puff where it strikes.</summary>
        public void MarksmanShot(float3 from, float3 to)
        {
            var d = to - from;
            float length = math.length(d);
            if (length < 1e-4f) return;
            Emit((from + to) * .5f, float3.zero, .0045f, 0, .07f, new float3(1f, .95f, .78f), new float3(1f, .8f, .45f), .95f, true, 1.6f, 0, 0, Streak, d * .5f);
            Emit(to, new float3(0, .05f, 0), .012f, .03f, .35f, new float3(.62f, .58f, .5f), new float3(.6f, .58f, .55f), .5f, false, 0, 1.5f, .02f);
        }

        /// <summary>A round stopped by a plate carrier (body armour saved the man): a small bright spark.</summary>
        public void ArmourSave(float3 p)
        {
            for (int k = 0; k < 5; k++)
                Emit(p, RandDir() * (.4f + R() * .4f) + new float3(0, .2f, 0), .003f, 0, .12f + R() * .12f, new float3(1f, .9f, .6f), new float3(1f, .5f, .15f), 1f, true, 2f, .6f, -1.5f, Streak, default, true);
        }
    }
}
