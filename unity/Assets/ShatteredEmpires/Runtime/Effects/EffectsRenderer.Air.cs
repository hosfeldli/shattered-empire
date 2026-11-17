using Unity.Mathematics;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Anti-aircraft flak (workstream D): the server's 'flak' event gives the burst centre at altitude and the
    /// offsets of each shell in the volley. Every shell is a short hot flash, a spray of shrapnel streaks and a
    /// small charcoal puff that thins out over two to three seconds. `scale` grows with camera distance so
    /// volleys stay readable from mid zoom.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        /// <summary>One flak shell bursting at map point p (already at altitude).</summary>
        public void FlakBurst(float3 p, float scale, bool close = false)
        {
            scale = math.max(.5f, scale);
            // flash: a hot white-gold pop with an orange bloom (the part that reads as "flak")
            Emit(p, float3.zero, .12f * scale, .62f * scale, .10f, new float3(1f, .93f, .7f), new float3(1f, .55f, .2f), 1f, true, 3f);
            Emit(p, float3.zero, .06f * scale, .24f * scale, .24f, new float3(1f, .72f, .35f), new float3(.9f, .3f, .08f), .85f, true, 2f);
            // shrapnel streaks: a crisp starburst
            int streaks = close ? 10 : 7;
            for (int k = 0; k < streaks; k++)
            {
                var v = RandDir() * (1.4f + R() * 1f) * scale;
                Emit(p, v, .006f * scale, 0, .2f + R() * .16f, new float3(1f, .88f, .55f), new float3(1f, .45f, .12f), 1f, true, 2.2f, 1.4f, -.6f, Streak, default, true);
            }
            // one small charcoal puff that thins out quickly (was three dense black puffs hanging 5–8 s,
            // which blanketed the sky over long air fights); a direct hit leaves a second faint wisp
            int puffs = close ? 2 : 1;
            for (int k = 0; k < puffs; k++)
            {
                float g = .11f + R() * .05f;
                var offset = k == 0 ? float3.zero : RandDir() * .04f * scale;
                Emit(p + offset, RandDir() * .03f * scale + new float3(0, .012f, 0), (.07f + R() * .025f) * scale, .17f * scale, 2.2f + R() * 1.2f,
                    new float3(g, g, g * 1.05f), new float3(.32f, .32f, .34f), k == 0 ? .55f : .35f, false, 0, .9f, .008f);
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
