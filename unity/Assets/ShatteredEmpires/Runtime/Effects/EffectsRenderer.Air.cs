using Unity.Mathematics;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Anti-aircraft flak (workstream D): the server's 'flak' event gives the burst centre at altitude and the
    /// offsets of each shell in the volley. Every shell is a short hot flash, a spray of shrapnel streaks and a
    /// ragged black smoke puff that hangs in the sky for several seconds. `scale` grows with camera distance so
    /// volleys stay readable from mid zoom.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        /// <summary>One flak shell bursting at map point p (already at altitude).</summary>
        public void FlakBurst(float3 p, float scale, bool close = false)
        {
            scale = math.max(.5f, scale);
            // flash
            Emit(p, float3.zero, .10f * scale, .55f * scale, .11f, new float3(1f, .9f, .62f), new float3(1f, .55f, .2f), 1f, true, 2.6f);
            Emit(p, float3.zero, .05f * scale, .18f * scale, .22f, new float3(1f, .72f, .35f), new float3(.9f, .3f, .08f), .85f, true, 1.8f);
            // shrapnel streaks
            int streaks = close ? 9 : 6;
            for (int k = 0; k < streaks; k++)
            {
                var v = RandDir() * (1.3f + R() * .9f) * scale;
                Emit(p, v, .006f * scale, 0, .22f + R() * .16f, new float3(1f, .85f, .5f), new float3(1f, .45f, .12f), 1f, true, 2f, 1.4f, -.6f, Streak, default, true);
            }
            // the black puff: a dense core and two ragged lobes that drift and slowly spread
            for (int k = 0; k < 3; k++)
            {
                float g = .045f + R() * .035f;
                var offset = RandDir() * (.035f + k * .02f) * scale;
                Emit(p + offset, RandDir() * .035f * scale + new float3(0, .01f, 0), (.11f + R() * .04f) * scale, .26f * scale, 5f + R() * 3f,
                    new float3(g, g, g * 1.05f), new float3(.2f, .2f, .22f), k == 0 ? .92f : .78f, false, 0, .9f, .008f);
            }
        }

        /// <summary>A volley: one burst per (dx, dy, dz) triple in offsets around the centre.</summary>
        public void FlakVolley(float3 centre, float[] offsets, float scale, bool hit)
        {
            if (offsets == null || offsets.Length < 3) { FlakBurst(centre, scale, hit); return; }
            float spread = math.max(1f, scale * .6f);
            for (int i = 0; i + 2 < offsets.Length; i += 3)
                FlakBurst(centre + new float3(offsets[i], offsets[i + 1], offsets[i + 2]) * spread, scale, hit && i == 0);
        }
    }
}
