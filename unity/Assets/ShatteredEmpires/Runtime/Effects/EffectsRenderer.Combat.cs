using Unity.Mathematics;
using UnityEngine;
using SE.Runtime.Rendering;

namespace SE.Runtime.Effects
{
    public sealed partial class EffectsRenderer
    {
        struct Flight
        {
            public float3 From, To, Last;
            public float Age, Duration, Arc, Trail;
            public bool Rocket, Strategic;
        }
        readonly Flight[] flights = new Flight[512];
        int flightCount;
        public float3 Wind;
        readonly Light[] flashLights = new Light[4];
        readonly float[] flashLife = new float[4];
        GameObject lightRoot;

        void FlashLight(float3 point, float scale)
        {
            if (Intensity < .7f) return;
            if (lightRoot == null)
            {
                lightRoot = new GameObject("Pooled combat lights");
                for (int i = 0; i < flashLights.Length; i++)
                {
                    var child = new GameObject("Impact light " + i); child.transform.SetParent(lightRoot.transform);
                    var light = child.AddComponent<Light>(); light.type = LightType.Point; light.shadows = LightShadows.None;
                    light.color = new Color(1, .63f, .28f); light.enabled = false; flashLights[i] = light;
                }
            }
            int slot = 0;
            for (int i = 1; i < flashLights.Length; i++) if (flashLife[i] < flashLife[slot]) slot = i;
            flashLights[slot].transform.position = MapSpace.W(point + new float3(0, .15f, 0));
            flashLights[slot].intensity = 1.4f + scale * 2;
            flashLights[slot].range = .65f + scale * 1.3f;
            flashLights[slot].enabled = true; flashLife[slot] = .12f;
        }

        public void EngineTrail(float3 point, float3 velocity, bool damaged, bool dusty)
        {
            float speed = math.length(velocity);
            if (damaged) Emit(point + new float3(0, .12f, 0), Wind * .12f + new float3(0, .12f, 0), .035f, .11f, 2.2f,
                new float3(.13f, .14f, .14f), new float3(.40f), .42f, false, 0, .5f, .03f);
            if (speed < .04f || !dusty) return;
            Emit(point - math.normalizesafe(velocity) * .16f + new float3(0, .018f, 0), Wind * .08f + new float3(0, .04f, 0), .024f, .075f, .7f,
                new float3(.49f, .43f, .33f), new float3(.55f, .52f, .45f), .18f * math.min(1, speed), false, 0, .8f, .01f);
        }

        public void Projectile(float3 from, float3 to, string weapon, float duration)
        {
            if (flightCount >= flights.Length) return;
            bool strategic = weapon == "warhead" && duration > 3;
            float distance = math.distance(from, to);
            flights[flightCount++] = new Flight {
                From = from, To = to, Last = from, Duration = math.max(.05f, duration),
                Arc = strategic ? math.min(13, distance * .48f) : weapon == "mortar" || weapon == "howitzer" ? math.min(3.4f, distance * .27f) : weapon == "bombs" ? .20f : .03f,
                Rocket = weapon == "warhead" || weapon == "missile" || weapon == "rockets" || weapon == "aam" || weapon == "drone_strike",
                Strategic = strategic,
            };
        }

        void UpdateFlights(float dt)
        {
            if (dt <= 0) return;
            for (int i = 0; i < flightCount; i++)
            {
                ref var f = ref flights[i];
                f.Age += dt;
                if (f.Age > f.Duration + .05f) { flights[i--] = flights[--flightCount]; continue; }
                float t = math.saturate(f.Age / f.Duration);
                float3 p = math.lerp(f.From, f.To, t) + new float3(0, 4 * f.Arc * t * (1 - t), 0);
                var step = p - f.Last;
                var heading = math.normalizesafe(step, new float3(0, 0, 1));
                float size = f.Strategic ? .035f : f.Rocket ? .016f : .007f;
                Emit(p, float3.zero, size, 0, .04f, new float3(1, .84f, .5f), new float3(1, .50f, .18f), 1, true,
                    f.Rocket ? 2f : 1f, 0, 0, Streak, -heading * (f.Rocket ? .12f : .07f));
                f.Trail += dt;
                if (f.Rocket && f.Trail >= .045f)
                {
                    f.Trail = 0;
                    Emit(p - heading * .05f, Wind * .10f, size * 1.8f, f.Strategic ? .26f : .10f,
                        f.Strategic ? 4f : 1.2f, new float3(.70f, .70f, .67f), new float3(.50f, .52f, .53f), .30f, false, 0, .6f, .025f);
                }
                f.Last = p;
            }
        }

        public void Impact(float3 p, float scale, int biome, bool armor = false)
        {
            // Water produces spray; armored impacts produce sparks; earth and rock throw different debris.
            if (biome <= 1 && !armor)
            {
                for (int k = 0; k < 12 * Intensity; k++)
                    Emit(p, new float3(R() - .5f, .8f + R() * 1.3f, R() - .5f) * scale,
                        .025f * scale, .035f, .6f + R() * .3f, new float3(.72f, .83f, .86f), new float3(.60f, .72f, .77f), .75f, false, 0, .5f, -2.8f);
                Emit(p + new float3(0, .015f, 0), float3.zero, .1f, scale * 1.4f, 1.6f, new float3(.73f, .84f, .85f), new float3(.63f, .72f, .75f), .45f, false, 0, 0, 0, Ring);
                return;
            }
            Explosion(p, scale * (armor ? .40f : .78f));
            var color = armor ? new float3(.49f, .48f, .42f) : biome >= 9 ? new float3(.49f, .47f, .43f) : biome == 5 ? new float3(.69f, .58f, .39f) : new float3(.40f, .34f, .24f);
            for (int k = 0; k < 7 * Intensity; k++)
            {
                float3 vel = new float3(R() - .5f, .4f + R() * .6f, R() - .5f) * scale;
                Emit(p, vel, .025f * scale, .025f, .8f + R() * .4f, color, color * .8f, .9f, false, 0, .5f, -2f);
            }
            if (armor) for (int k = 0; k < 8; k++)
                Emit(p, RandDir() * (R() + .7f), .004f, 0, .18f + R() * .25f, new float3(1, .85f, .55f), new float3(.95f, .28f, .05f), .9f, true, 2, .5f, -1f, Streak, default, true);
        }

        public void Capture(float3 p, float3 color)
        {
            Emit(p + new float3(0, .025f, 0), float3.zero, .25f, 1.1f, 1.25f, color, color, .6f, true, .15f, 0, 0, Ring);
            for (int i = 0; i < 6; i++)
                Emit(p + new float3((R() - .5f) * .5f, .08f, (R() - .5f) * .5f), new float3(0, .18f, 0), .015f, 0, .8f, color, color, .6f, true);
        }
    }
}
