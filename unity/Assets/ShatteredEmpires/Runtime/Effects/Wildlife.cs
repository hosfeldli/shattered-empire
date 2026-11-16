using System;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// Ambient life: flocks of crow-sized birds near the camera at close and operational zoom.
    /// Each flock lives a small cycle: it forages on the ground (birds hop and peck, a few at a time look up),
    /// takes off together, flies cross-country to a new feeding ground as a loose boid flock (cohesion,
    /// alignment, separation, a leader seeking the destination, flapping in bursts and gliding between),
    /// then descends, brakes and lands. A blast nearby flushes every flock within reach: they burst up and
    /// flee downwind of the explosion, then settle somewhere else. A lone raptor soars in slow thermals.
    /// Models: BirdUp/BirdDown (alternated to flap) and BirdPerch (on the ground). Purely presentation.
    /// </summary>
    public sealed class Wildlife : IDisposable
    {
        enum State { Grounded, Flying, Landing }
        struct Bird { public float3 Pos, Vel; public float Phase, Glide, Peck, Hop; public int Flock; public bool Down; }
        struct Flock { public State State; public float3 Home, Target; public float Timer, Panic; public int Size; }
        const int Flocks = 5, PerFlock = 16, Raptors = 1;
        const float BirdSize = 1.0f;     // the models are ~0.042 units (1 m) across the wings at scale 1
        readonly Bird[] birds = new Bird[Flocks * PerFlock + Raptors];
        readonly Flock[] flocks = new Flock[Flocks];
        readonly InstanceBatch up, down, perch;
        readonly System.Random rng = new System.Random(23);
        float3 raptorCentre; float raptorAngle;
        bool seeded;
        public float VisibleDistance = 60f;

        float R() => (float)rng.NextDouble();

        public Wildlife()
        {
            var a = ModelLibrary.Get("BirdUp"); var b = ModelLibrary.Get("BirdDown"); var p = ModelLibrary.Get("BirdPerch") ?? b;
            if (a == null || b == null) return;
            InstanceBatch Batch(Mesh m) => new InstanceBatch(m, RenderResources.Instanced, birds.Length) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3, Shadows = ShadowCastingMode.Off };
            up = Batch(a); down = Batch(b); perch = Batch(p);
        }

        /// <summary>A blast at a map point: nearby flocks flush and flee away from it.</summary>
        public void Disturb(float3 mapPos, float strength)
        {
            for (int f = 0; f < Flocks; f++)
            {
                var d = Centre(f) - mapPos; d.y = 0;
                float dist = math.length(d);
                if (dist > 12f * math.max(.5f, strength)) continue;
                ref var fl = ref flocks[f];
                fl.Panic = 1f;
                var away = math.normalizesafe(d, new float3(1, 0, 0));
                fl.Target = fl.Home = Centre(f) + away * (7f + R() * 6f);
                fl.State = State.Flying; fl.Timer = 0;
                for (int i = 0; i < PerFlock; i++)
                {
                    ref var bd = ref birds[f * PerFlock + i];
                    if (bd.Down) { bd.Down = false; bd.Vel = away * (.4f + R() * .3f) + new float3(0, .6f + R() * .3f, 0); }
                }
            }
        }

        float3 Centre(int f)
        {
            float3 c = 0;
            for (int i = 0; i < PerFlock; i++) c += birds[f * PerFlock + i].Pos;
            return c / PerFlock;
        }

        float3 FeedingGround(float3 focus)
        {
            float a = R() * 6.283f, r = 3f + R() * 13f;
            return focus + new float3(math.cos(a) * r, 0, math.sin(a) * r);
        }

        void Seed(int f, float3 focus, Func<float, float, float> ground)
        {
            var home = FeedingGround(focus);
            flocks[f] = new Flock { State = State.Grounded, Home = home, Target = home, Timer = 4f + R() * 14f, Size = PerFlock };
            for (int i = 0; i < PerFlock; i++)
            {
                ref var b = ref birds[f * PerFlock + i];
                b.Flock = f; b.Phase = R() * 6.283f; b.Down = true; b.Vel = 0; b.Glide = 0;
                var p = home + new float3((R() - .5f) * .5f, 0, (R() - .5f) * .5f);
                p.y = ground(p.x, p.z);
                b.Pos = p; b.Peck = R() * 3f; b.Hop = 0;
            }
        }

        public void Update(float dt, float3 focusMap, float camDistance, Func<float, float, float> ground)
        {
            if (up == null) return;
            up.Clear(); down.Clear(); perch.Clear();
            if (camDistance > VisibleDistance || ground == null) { seeded = false; return; }
            dt = math.min(dt, .05f);
            if (!seeded)
            {
                for (int f = 0; f < Flocks; f++) Seed(f, focusMap, ground);
                raptorCentre = focusMap; birds[^1] = new Bird { Pos = focusMap + new float3(0, ground(focusMap.x, focusMap.z) + 3f, 0), Flock = -1 };
                seeded = true;
            }
            for (int f = 0; f < Flocks; f++) StepFlock(f, dt, focusMap, ground);
            StepRaptor(dt, focusMap, ground);
            float fade = math.saturate((VisibleDistance - camDistance) / 12f);
            if (fade <= 0) return;
            float s = BirdSize * math.lerp(.9f, 1f, fade);
            for (int i = 0; i < birds.Length; i++)
            {
                ref var b = ref birds[i];
                var world = MapSpace.W(b.Pos);
                var tint = new float4(1, 1, 1, 0);
                if (b.Down)
                {
                    // pecking dips the body; a hop lifts it
                    float yaw = b.Phase;
                    float peck = b.Peck < .25f ? math.sin(b.Peck / .25f * math.PI) : 0;
                    var rot = math.mul(quaternion.RotateY(MapSpace.Yaw(yaw)), quaternion.RotateX(peck * .5f));
                    perch.Add(InstanceData.TRS(world + new float3(0, math.sin(math.saturate(b.Hop) * math.PI) * .008f, 0), rot, new float3(s * (i == birds.Length - 1 ? 1.6f : 1f)), tint));
                    continue;
                }
                float heading = math.atan2(b.Vel.x, b.Vel.z);
                float climb = math.atan2(b.Vel.y, math.max(.05f, math.length(b.Vel.xz)));
                var q = math.mul(quaternion.RotateY(MapSpace.Yaw(heading)), quaternion.RotateX(-climb * .6f));
                bool wingsUp = b.Glide <= 0 && math.sin(b.Phase) > 0;
                float scale = i == birds.Length - 1 ? s * 1.7f : s;   // the raptor is bigger
                (wingsUp ? up : down).Add(InstanceData.TRS(world, q, new float3(scale), tint));
            }
        }

        void StepFlock(int f, float dt, float3 focus, Func<float, float, float> ground)
        {
            ref var fl = ref flocks[f];
            var centre = Centre(f);
            var off = centre - focus; off.y = 0;
            if (math.lengthsq(off) > 30f * 30f) { Seed(f, focus, ground); return; }
            fl.Panic = math.max(0, fl.Panic - dt * .12f);
            fl.Timer -= dt;
            switch (fl.State)
            {
                case State.Grounded:
                    if (fl.Timer <= 0)
                    {
                        // take off together, toward a fresh feeding ground
                        fl.State = State.Flying; fl.Target = FeedingGround(focus); fl.Timer = 60f;
                        var dir = math.normalizesafe(fl.Target - centre);
                        for (int i = 0; i < PerFlock; i++)
                        {
                            ref var b = ref birds[f * PerFlock + i];
                            b.Down = false; b.Vel = dir * (.15f + R() * .15f) + new float3(0, .35f + R() * .25f, 0); b.Glide = 0;
                        }
                    }
                    break;
                case State.Flying:
                {
                    var to = fl.Target - centre; to.y = 0;
                    if (math.length(to) < 1.2f || fl.Timer <= 0) { fl.State = State.Landing; fl.Timer = 8f; }
                    break;
                }
                case State.Landing:
                {
                    bool all = true;
                    for (int i = 0; i < PerFlock; i++) all &= birds[f * PerFlock + i].Down;
                    if (all || fl.Timer <= 0) { fl.State = State.Grounded; fl.Timer = 8f + R() * 22f; fl.Home = centre; }
                    break;
                }
            }
            var avgVel = float3.zero;
            for (int i = 0; i < PerFlock; i++) avgVel += birds[f * PerFlock + i].Vel;
            avgVel /= PerFlock;
            for (int i = 0; i < PerFlock; i++)
            {
                ref var b = ref birds[f * PerFlock + i];
                float floor = ground(b.Pos.x, b.Pos.z);
                if (b.Down)
                {
                    // forage: peck, look about, hop a short way now and then
                    b.Pos.y = floor;
                    b.Peck -= dt;
                    if (b.Peck <= 0) b.Peck = .6f + R() * 2.4f;
                    if (b.Hop > 0) { b.Hop -= dt * 3f; b.Pos += new float3(math.sin(b.Phase), 0, math.cos(b.Phase)) * dt * .05f; }
                    else if (R() < dt * .35f) { b.Hop = 1; b.Phase += (R() - .5f) * 2.5f; }
                    continue;
                }
                // boids: cohesion, alignment, separation, plus the flock's destination
                var steer = (centre - b.Pos) * .9f + (avgVel - b.Vel) * .8f;
                for (int j = 0; j < PerFlock; j++)
                {
                    if (j == i) continue;
                    var d = b.Pos - birds[f * PerFlock + j].Pos;
                    float l2 = math.lengthsq(d);
                    if (l2 < .06f * .06f && l2 > 1e-8f) steer += d / l2 * .004f;
                }
                float cruise = .55f + .45f * fl.Panic;          // ~14 m/s cruising, ~25 m/s fleeing
                if (fl.State == State.Flying)
                {
                    var target = fl.Target; target.y = floor + 1.1f + fl.Panic * 1.6f + math.sin(b.Phase * .07f + i) * .2f;
                    steer += math.normalizesafe(target - b.Pos) * .9f;
                }
                else
                {
                    // landing: drop toward a spot near the target and brake on approach
                    var spot = fl.Target + new float3(math.sin(i * 2.4f) * .25f, 0, math.cos(i * 2.4f) * .25f);
                    spot.y = ground(spot.x, spot.z);
                    var to = spot - b.Pos;
                    steer += to * 2.2f - b.Vel * 1.4f;
                    cruise = math.max(.25f, math.min(cruise, math.length(to) * 1.5f));
                    if (math.length(to) < .05f || b.Pos.y <= floor + .004f) { b.Down = true; b.Pos.y = floor; b.Phase = math.atan2(b.Vel.x, b.Vel.z); b.Vel = 0; b.Peck = R(); continue; }
                }
                b.Vel += steer * dt;
                float speed = math.length(b.Vel);
                if (speed > cruise) b.Vel *= cruise / speed;
                b.Pos += b.Vel * dt;
                if (b.Pos.y < floor + .02f && fl.State == State.Flying) { b.Pos.y = floor + .02f; b.Vel.y = math.abs(b.Vel.y); }
                // flapping in bursts and gliding between, faster when climbing or fleeing
                b.Glide = math.max(0, b.Glide - dt);
                if (b.Glide <= 0 && b.Vel.y < .1f && R() < dt * .5f && fl.Panic < .2f) b.Glide = .6f + R() * 1.2f;
                b.Phase += dt * (b.Glide > 0 ? 0 : 17f + fl.Panic * 9f + math.max(0, b.Vel.y) * 6f);
            }
        }

        void StepRaptor(float dt, float3 focus, Func<float, float, float> ground)
        {
            // a buzzard riding a thermal: wide, slow circles that drift with the wind, wings held still
            ref var b = ref birds[^1];
            var off = raptorCentre - focus; off.y = 0;
            if (math.lengthsq(off) > 26f * 26f) raptorCentre = FeedingGround(focus);
            raptorCentre += new float3(.05f, 0, .03f) * dt;
            raptorAngle += dt * .22f;
            float h = ground(raptorCentre.x, raptorCentre.z) + 3.2f + math.sin(raptorAngle * .3f) * .6f;
            var target = raptorCentre + new float3(math.cos(raptorAngle) * 2.4f, 0, math.sin(raptorAngle) * 2.4f);
            target.y = h;
            var steer = (target - b.Pos) * .8f - b.Vel * .6f;
            b.Vel += steer * dt;
            b.Pos += b.Vel * dt;
            b.Down = false; b.Glide = 1;
            if (math.sin(raptorAngle * 1.7f) > .97f) { b.Glide = 0; b.Phase += dt * 9f; }
        }

        public void Draw(WrapImages images)
        {
            if (up == null) return;
            up.Draw(); down.Draw(); perch.Draw();
        }

        public void Dispose() { up?.Dispose(); down?.Dispose(); perch?.Dispose(); }
    }
}
