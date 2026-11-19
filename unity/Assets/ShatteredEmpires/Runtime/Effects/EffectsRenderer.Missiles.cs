using SE.Runtime.Rendering;
using Unity.Mathematics;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Missile systems (effects pass, 2026-11-18): launch, flight and interception for the missile battery's guided
    /// rounds, strategic missiles from the silo and the air-defense interceptors that shoot them down.
    ///
    /// - Launch: a flash and light, exhaust smoke billowing back along the ground (the silo's vents all round), a low
    ///   dust skirt and sparks; a strategic launch also shakes the camera and leaves a rising steam column.
    /// - Flight: battery rounds climb out steeply, cruise and dive (<see cref="FlightPosition"/>); strategic missiles
    ///   rise nearly vertically out of the silo, arc high and re-enter steeply. A hot motor (streak and additive glow)
    ///   and a smoke trail laid by distance travelled, not by frame, so fast missiles leave an unbroken line; the
    ///   puffs live seconds (a strategic trail ten) and drift and spread with the wind like any smoke.
    /// - Interception ('mintercept'): the bootstrap passes the interceptor and the intercept point. The visible
    ///   missile nearest that point is marked to die when an interceptor launched now reaches it; the interceptor
    ///   flies there and the missile breaks up in an air burst with falling debris. If no flight is visible (the
    ///   launch was off screen) the interceptor bursts at the intercept point.
    /// Budget: at most 4 trail puffs per missile per frame, all from the shared pooled particle budget.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        static readonly float3 Up = new float3(0, 1, 0);

        /// <summary>Where a flight is at fraction t of its duration (map space).</summary>
        static float3 FlightPosition(in Flight f, float t)
        {
            if (f.Interceptor) return math.lerp(f.From, f.To, t) + Up * (4 * f.Arc * t * (1 - t));
            if (f.Strategic)
            {
                // boost out of the silo almost straight up, a high arc, a steep re-entry
                float h = t * t * (3 - 2 * t);
                return math.lerp(f.From, f.To, h) + Up * (4 * f.Arc * t * (1 - t));
            }
            if (f.Missile)
            {
                // climb out fast, apex at ~40% of the flight, a long dive onto the target
                float u = math.pow(t, .7f);
                return math.lerp(f.From, f.To, t) + Up * (4 * f.Arc * u * (1 - u));
            }
            return math.lerp(f.From, f.To, t) + Up * (4 * f.Arc * t * (1 - t));
        }

        void MissileTravel(ref Flight f, float3 p, float3 heading, float moved)
        {
            bool strategic = f.Strategic && !f.Interceptor, interceptor = f.Interceptor;
            float body = strategic ? .44f : interceptor ? .055f : .13f;
            missileBodies.Add(InstanceData.TRS(MapSpace.W(p), quaternion.LookRotationSafe(MapSpace.W(heading), Up), new float3(body), new float4(.93f, .92f, .86f, 0)));
            // the motor: a hot streak and a soft additive glow behind the body
            float flare = strategic ? .09f : interceptor ? .028f : .04f;
            var nozzle = p - heading * body * .5f;
            Emit(nozzle, float3.zero, flare, 0, .045f, new float3(1f, .96f, .82f), new float3(1f, .62f, .26f), 1f, true, 2.6f, 0, 0, Streak, -heading * (strategic ? .9f : interceptor ? .16f : .22f));
            Emit(nozzle, float3.zero, flare * 2.6f, 0, .05f, new float3(1f, .80f, .48f), new float3(1f, .46f, .16f), .55f, true, 1.6f);
            // the smoke trail, by distance travelled
            float spacing = (strategic ? .2f : interceptor ? .06f : .07f) / math.max(.35f, Intensity);
            f.TrailDistance += moved;
            float t = f.Age / f.Duration;
            int n = 0;
            while (f.TrailDistance >= spacing && n < 4)
            {
                f.TrailDistance -= spacing; n++;
                var at = p - heading * (f.TrailDistance + body * .6f);
                float g = R() * .05f;
                if (strategic)
                {
                    bool boost = t < .14f;   // the thick plume while it claws out of the silo
                    Emit(at + RandDir() * .03f, Wind * .06f + RandDir() * .03f, boost ? .22f : .11f, boost ? .5f : .2f, (boost ? 12f : 8f) + R() * 3.5f,
                        new float3(.86f + g, .86f + g, .84f + g), new float3(.66f, .67f, .68f), boost ? .62f : .5f, false, 0, .5f, .01f);
                }
                else if (interceptor)
                    Emit(at, Wind * .05f + RandDir() * .01f, .022f, .07f, 2.2f + R(),
                        new float3(.9f, .9f, .9f), new float3(.70f, .72f, .73f), .38f, false, 0, .6f, .015f);
                else
                    // a tactical missile (missile battery): a thick white trail that hangs along the arc for a while
                    Emit(at, Wind * .06f + RandDir() * .015f, .045f, .16f, 4.5f + R() * 1.8f,
                        new float3(.88f + g, .88f + g, .86f + g), new float3(.66f, .68f, .69f), .55f, false, 0, .5f, .015f);
            }
            if (n == 4) f.TrailDistance = 0;   // a hitch: do not try to catch up next frame
        }

        /// <summary>A missile leaving its launcher (scale 1 strategic, ~.45 a battery round, ~.25 an interceptor).</summary>
        public void MissileLaunch(float3 from, float3 to, float scale, bool strategic)
        {
            var dir = math.normalizesafe(new float3(to.x - from.x, 0, to.z - from.z), new float3(0, 0, 1));
            float ground = GroundAt != null ? GroundAt(from.x, from.z) : from.y;
            var floor = new float3(from.x, ground + .03f * scale, from.z);
            FlashLight(from, strategic ? 2f : .4f + scale);
            Blast?.Invoke(from, strategic ? 1.5f : .3f);
            Emit(from, float3.zero, .16f * scale, .7f * scale, .12f, new float3(1f, .95f, .8f), new float3(1f, .55f, .2f), 1f, true, 3f);
            // exhaust: smoke billowing back along the ground (a silo vents it all round)
            int n = (int)((strategic ? 22 : scale > .3f ? 9 : 4) * math.max(.4f, Intensity));
            for (int k = 0; k < n; k++)
            {
                float a = R() * 6.283f;
                var side = new float3(math.cos(a), 0, math.sin(a));
                var v = (strategic ? side * (1.1f + R() * .7f) : -dir * (.5f + R() * .5f) + side * .35f) * scale + new float3(0, .05f + R() * .12f, 0) * scale;
                float g = R() * .06f;
                Emit(floor, v, .09f * scale, .38f * scale, (strategic ? 6f : 2.2f) + R() * (strategic ? 4f : 1.5f),
                    new float3(.80f + g, .78f + g, .74f + g), new float3(.68f, .67f, .65f), .5f, false, 0, 1.4f, .02f);
            }
            // a low dust skirt kicked up off the ground
            int dust = strategic ? 12 : scale > .3f ? 5 : 2;
            for (int k = 0; k < dust; k++)
            {
                float a = k * 6.283f / dust + R() * .5f;
                Emit(floor, new float3(math.cos(a), .02f, math.sin(a)) * (.7f + R() * .4f) * scale, .06f * scale, .3f * scale, 1.5f + R(),
                    new float3(.55f, .48f, .38f), new float3(.62f, .58f, .52f), .35f, false, 0, 1.8f, .005f);
            }
            for (int k = 0; k < (strategic ? 10 : 4); k++)
            {
                var v = (-dir * .6f + RandDir() * .5f + new float3(0, .6f, 0)) * (1.2f + R()) * scale;
                Emit(from, v, .006f, 0, .3f + R() * .3f, new float3(1f, .85f, .5f), new float3(1f, .4f, .1f), 1f, true, 2f, .8f, -1.5f, Streak, default, true);
            }
            if (!strategic) return;
            Shake = math.max(Shake, .25f);
            for (int k = 0; k < 6; k++)   // steam and smoke welling up out of the silo after the missile has gone
                Emit(floor + new float3(0, k * .08f, 0), new float3(0, .25f + R() * .15f, 0), .2f, .35f, 7f + R() * 4f,
                    new float3(.9f, .9f, .9f), new float3(.72f, .73f, .74f), .45f, false, 0, .4f, .04f);
        }

        /// <summary>
        /// A missile shot down (server 'mintercept'): an interceptor flies from the defender to the missile, which
        /// breaks up in an air burst. interceptor and point are map positions (point on the ground below the kill).
        /// </summary>
        public void MissileIntercept(float3 interceptor, float3 point, bool strategic)
        {
            int best = -1;
            float bestD = strategic ? 36f : 6.25f;   // squared search radius around the intercept point
            for (int i = 0; i < flightCount; i++)
            {
                ref var f = ref flights[i];
                if (f.Interceptor || f.KillAt >= 0 || (strategic ? !f.Strategic : !f.Missile)) continue;
                float dx = f.Last.x - point.x, dz = f.Last.z - point.z, d = dx * dx + dz * dz;
                if (d < bestD) { bestD = d; best = i; }
            }
            float tau;
            float3 aim;
            if (best >= 0)
            {
                ref var f = ref flights[best];
                tau = math.clamp(math.distance(interceptor, f.Last) / (strategic ? 7f : 9f), .3f, .9f);
                float kill = math.min(f.Age + tau, f.Duration * .98f);
                if (kill - f.Age < .1f) kill = math.min(f.Duration, f.Age + .1f);
                tau = math.max(.05f, kill - f.Age);
                f.KillAt = kill;
                aim = FlightPosition(f, kill / f.Duration);
            }
            else
            {
                aim = point + new float3(0, strategic ? 3f : .7f, 0);
                tau = math.clamp(math.distance(interceptor, aim) / 9f, .3f, .9f);
            }
            if (flightCount < flights.Length)
                flights[flightCount++] = new Flight
                {
                    From = interceptor, To = aim, Last = interceptor, Duration = tau, Arc = .1f + math.distance(interceptor, aim) * .02f,
                    Rocket = true, Interceptor = true, Strategic = strategic, BurstAtEnd = best < 0, KillAt = -1,
                };
            MissileLaunch(interceptor, aim, .25f, false);
        }

        /// <summary>A missile destroyed in the air: flash, fireball, shrapnel, a lingering smoke ball and falling debris.</summary>
        void InterceptBurst(float3 p, bool strategic)
        {
            float s = strategic ? 1.6f : .6f;
            FlashLight(p, s);
            Emit(p, float3.zero, .2f * s, .9f * s, .12f, new float3(1f, .96f, .82f), new float3(1f, .6f, .25f), 1f, true, 3f);
            Emit(p, float3.zero, .12f * s, .5f * s, .35f, new float3(1f, .72f, .35f), new float3(.85f, .28f, .06f), .85f, true, 2f);
            for (int k = 0; k < (strategic ? 14 : 8); k++)
                Emit(p, RandDir() * (1.6f + R()) * s, .006f * s, 0, .25f + R() * .2f, new float3(1f, .88f, .55f), new float3(1f, .45f, .12f), 1f, true, 2.2f, 1.2f, -1.2f, Streak, default, true);
            for (int k = 0; k < (strategic ? 6 : 3); k++)
                Emit(p + RandDir() * .05f * s, RandDir() * .15f * s, .1f * s, .3f * s, .6f + R() * .3f, new float3(1f, .62f, .25f), new float3(.4f, .1f, .03f), .9f, true, 1.8f, 1.5f, .1f);
            for (int k = 0; k < (strategic ? 6 : 3); k++)
            {
                float g = .14f + R() * .06f;
                Emit(p + RandDir() * .06f * s, RandDir() * .05f * s, .12f * s, .35f * s, 5f + R() * 3f,
                    new float3(g, g, g * 1.05f), new float3(.42f, .42f, .43f), .55f, false, 0, .8f, .01f);
            }
            float floor = GroundAt != null ? GroundAt(p.x, p.z) : p.y - 1f;
            for (int k = 0; k < (strategic ? 10 : 5); k++)
            {
                var v = RandDir() * (.6f + R()) * s * .6f + new float3(0, .3f, 0);
                EmitDebris(p, v, (.01f + R() * .012f) * s, 3f + R() * 2f, new float3(.22f, .21f, .2f), floor, -2.4f);
            }
            if (strategic)
            {
                for (int k = 0; k < 4; k++)   // burning fragments
                    Emit(p, RandDir() * .8f + new float3(0, .4f, 0), .012f, 0, 1.4f + R() * .6f, new float3(1f, .7f, .3f), new float3(.9f, .25f, .05f), 1f, true, 2f, .3f, -1.6f, Streak, default, true);
                Flash = math.max(Flash, .25f);
                Shake = math.max(Shake, .2f);
            }
        }
    }
}
