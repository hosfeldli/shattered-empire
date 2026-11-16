using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// A simulated mushroom cloud (strategic strikes, reactor failures). Instead of a burst of independent
    /// particles it is a structure evolving over half a minute:
    ///  · the fireball rises and becomes a toroidal vortex — every cap blob circulates around the ring
    ///    (up the middle, out across the top, down the outside, back in underneath), the rolling motion
    ///    that makes a real cloud read as alive; the cap climbs quickly, then slows and spreads;
    ///  · a churning stem draws dust and fire up from the ground into the cap;
    ///  · early on the cap is lit from within (orange fire under grey soot), then cools to brown-grey;
    ///  · a brief white condensation ring flashes outward at mid-height;
    ///  · a firestorm burns around the base and the whole structure drifts downwind as it fades.
    /// Blobs are written straight into the particle buffers each frame (no pool slots, no extra draw).
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        sealed class Mushroom { public float3 Base; public float Scale, Age, Seed; public float3 Drift; }
        const int MushroomLimit = 4, CapBlobs = 110, StemBlobs = 46, SkirtBlobs = 30;
        const float MushroomLife = 34f;
        readonly Mushroom[] mushrooms = new Mushroom[MushroomLimit];
        int mushroomCount;

        /// <summary>Start a rolling mushroom cloud at a map position (scale 1 = strategic warhead).</summary>
        public void MushroomCloud(float3 mapPos, float scale)
        {
            if (mushroomCount >= MushroomLimit) { for (int i = 1; i < mushroomCount; i++) mushrooms[i - 1] = mushrooms[i]; mushroomCount--; }
            mushrooms[mushroomCount++] = new Mushroom { Base = MapSpace.W(mapPos), Scale = scale, Seed = R() * 100f };
            Distortion(mapPos, 24f * scale, 3.2f, 1f);
        }

        void UpdateMushrooms(float dt, float camX, float period, bool wrap)
        {
            var wind = MapSpace.W(Wind);
            for (int m = 0; m < mushroomCount; m++)
            {
                var c = mushrooms[m];
                c.Age += dt;
                if (c.Age >= MushroomLife) { mushrooms[m--] = mushrooms[--mushroomCount]; continue; }
                c.Drift += new float3(wind.x, 0, wind.z) * dt * .05f * math.saturate(c.Age / 8f);
                float t = c.Age, s = c.Scale;
                float grow = 1 - math.exp(-t / 4.5f), spread = 1 - math.exp(-t / 7f);
                float height = s * (.7f + 3.6f * grow);                       // cap centre above the ground
                float major = s * (.45f + 1.55f * spread);                    // ring radius of the torus
                float minor = s * (.38f + .62f * spread);                     // tube radius
                float heat = math.saturate(1.25f - t / 9f);                   // inner fire, fading
                float fade = 1 - math.smoothstep(MushroomLife * .62f, MushroomLife, t);
                float roll = t * (1.25f - .55f * spread);                     // poloidal circulation phase
                var centre = c.Base + c.Drift + new float3(0, height, 0);
                // --- cap: blobs on a torus, circulating around its tube ---
                for (int i = 0; i < CapBlobs; i++)
                {
                    float h1 = Hash01(c.Seed, i * 3), h2 = Hash01(c.Seed, i * 3 + 1), h3 = Hash01(c.Seed, i * 3 + 2);
                    float theta = h1 * math.PI * 2 + t * .05f;                // around the vertical axis (slow swirl)
                    float phi = h2 * math.PI * 2 + roll;                      // around the tube (the roll)
                    float r = minor * (.55f + .45f * h3);
                    math.sincos(theta, out float st, out float ct);
                    math.sincos(phi, out float sp, out float cp);
                    float ring = major + r * cp;
                    var p = centre + new float3(ct * ring, r * sp * .82f, st * ring);
                    // underside and inner face glow while the fire lasts; the top is soot-dark
                    float under = math.saturate(-sp * .8f + .2f) * math.saturate(1 - cp * .5f);
                    float3 smoke = math.lerp(new float3(.30f, .27f, .24f), new float3(.52f, .49f, .45f), h3 * .6f + spread * .4f);
                    float3 fire = new float3(1f, .52f, .18f);
                    float3 col = math.lerp(smoke, fire, heat * under * .85f);
                    WriteBlob(p, minor * (.88f + .55f * h3), col, .86f * fade, h1 * 6.28f + t * .1f, h2 * 100, heat * under * 1.6f, camX, period, wrap);
                }
                // --- stem: rising, narrowing, carrying fire up early and dust later ---
                for (int i = 0; i < StemBlobs; i++)
                {
                    float h1 = Hash01(c.Seed + 7, i), h2 = Hash01(c.Seed + 11, i);
                    float along = math.frac(h1 + t * .085f);                  // travels up the stem and recycles
                    float y = along * (height - minor * .6f);
                    float w = s * (.22f + .16f * (1 - along)) * (.6f + .4f * spread);
                    float a = h2 * 6.283f + t * .6f;
                    var p = c.Base + c.Drift * along + new float3(math.cos(a) * w * .45f, y, math.sin(a) * w * .45f);
                    float3 col = math.lerp(new float3(.42f, .37f, .31f), new float3(1f, .55f, .2f), heat * (1 - along) * .7f);
                    WriteBlob(p, w * 1.4f, col, .7f * fade * math.saturate(t * 2), a, h1 * 50, heat * (1 - along), camX, period, wrap);
                }
                // --- base surge skirt: a low doughnut of dust rolling outward ---
                float surge = s * (.6f + 4.5f * (1 - math.exp(-t / 3f)));
                for (int i = 0; i < SkirtBlobs; i++)
                {
                    float a = i * 6.283f / SkirtBlobs + Hash01(c.Seed + 3, i) * .3f;
                    var p = c.Base + new float3(math.cos(a) * surge, s * .18f, math.sin(a) * surge);
                    WriteBlob(p, s * (.38f + .3f * Hash01(c.Seed + 5, i)), new float3(.55f, .5f, .43f), .42f * fade * math.saturate(1.3f - t / 18f), a, i, 0, camX, period, wrap);
                }
                // --- condensation ring: a white collar flashing outward between 0.6 s and 3 s ---
                if (t > .6f && t < 3.2f)
                {
                    float k = (t - .6f) / 2.6f, ringR = s * (1.2f + 4f * k);
                    for (int i = 0; i < 36; i++)
                    {
                        float a = i * 6.283f / 36;
                        var p = c.Base + new float3(math.cos(a) * ringR, height * .62f, math.sin(a) * ringR);
                        WriteBlob(p, s * .32f, new float3(.95f, .96f, .97f), .5f * (1 - k), a, i, 0, camX, period, wrap);
                    }
                }
                // --- firestorm around the base (pooled flame particles, rate limited) ---
                if (t < 22f && Intensity > .2f && R() < .65f)
                {
                    float a = R() * 6.283f, d = s * (.4f + R() * 2.8f) * math.saturate(t / 4f + .2f);
                    var wp = c.Base + new float3(math.cos(a) * d, 0, math.sin(a) * d);
                    var map = new float3(wp.x, wp.y, -wp.z);
                    if (GroundAt != null) map.y = GroundAt(map.x, map.z);
                    Fire(map, (.25f + R() * .25f) * s * math.saturate(1.2f - t / 22f));
                }
                mushrooms[m] = c;
            }
        }

        static float Hash01(float seed, int i)
        {
            uint h = (uint)(i * 374761393 + (int)(seed * 1000) * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            return ((h ^ (h >> 16)) & 0xffffff) / 16777216f;
        }

        void WriteBlob(float3 p, float size, float3 color, float alpha, float rot, float seed, float heat, float camX, float period, bool wrap)
        {
            if (alpha <= .005f || alphaCount >= Budget) return;
            float x = wrap ? HexMath.NearX(p.x, camX, period, true) : p.x;
            alphaData[alphaCount++] = new ParticleGpu
            {
                Position = new float4(x, p.y, p.z, size),
                Color = new float4(color, alpha),
                Shape = new float4(rot, .55f, seed, heat),
                Extra = new float4(0, 0, 0, Puff),
            };
        }
    }
}
