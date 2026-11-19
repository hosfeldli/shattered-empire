using System.Collections.Generic;
using SE.Core.Protocol;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// The Warthog's gun runs (server 'strafe' events, server/sim/actionFlight.js). One event carries the whole burst:
    /// the line of impacts on the ground (Origin -> Destination) and its duration (Flight). Over that time the cannon
    /// fires from the aircraft as it is drawn: a heavy, flickering muzzle flash at the nose, a dense tracer stream
    /// and a walk of dust-and-flash impacts along the line, with the rotary cannon's "brrrt" (AudioSynth.GunRun,
    /// procedural) at the aircraft.
    /// </summary>
    public sealed partial class GameBootstrap
    {
        sealed class GunRun { public int Shooter; public float3 From, To; public float Age, Duration, NextShot; public int Biome; }
        readonly List<GunRun> gunRuns = new List<GunRun>();

        void PresentStrafe(CombatEvent e)
        {
            if (fx == null || !e.HasOrigin || !e.HasDestination) return;
            var world = session.World;
            float x0 = e.Origin.X, z0 = e.Origin.Z, x1 = e.Destination.X, z1 = e.Destination.Z;
            var from = new float3(x0, world.GroundHeight(x0, z0), z0);
            // the end in the image nearest the start (a line drawn across the wrap seam)
            x1 = x0 + world.Grid.DxWrap(x0, x1);
            var to = new float3(x1, world.GroundHeight(x1, z1), z1);
            if (!Near(from, Mathf.Max(60f, rts.Distance * 3f))) return;
            int biome = e.From >= 0 && e.From < world.Grid.N ? world.Biome[e.From] : 2;
            gunRuns.Add(new GunRun { Shooter = e.Shooter, From = from, To = to, Duration = Mathf.Max(.3f, e.Flight > 0 ? e.Flight : 1f), Biome = biome });
            var muzzle = GunMuzzle(e.Shooter, from, out _);
            audioDirector?.Play("gun_run", muzzle, 1f, 9f, 3, rts.Distance);
            if (gunRuns.Count > 24) gunRuns.RemoveAt(0);
        }

        /// <summary>Where the cannon fires from: the drawn aircraft's nose, or above the start of the line when it is not drawn.</summary>
        float3 GunMuzzle(int shooter, float3 fallback, out bool drawn)
        {
            drawn = false;
            if (units != null && shooter > 0 && units.TryGetAirPose(session.Units, shooter, out var pose, out float heading))
            {
                drawn = true;
                float ground = session.World.GroundHeight(pose.x, pose.z);
                var nose = new float3(Mathf.Sin(heading), 0, Mathf.Cos(heading)) * .17f;
                return new float3(pose.x, ground + pose.y - .03f, pose.z) + nose;
            }
            return fallback + new float3(0, 1.1f, 0);
        }

        /// <summary>Per frame: advance every burst in progress, firing tracers and walking the impacts along the line.</summary>
        void UpdateGunRuns(float dt)
        {
            if (fx == null || dt <= 0f) return;
            for (int i = gunRuns.Count - 1; i >= 0; i--)
            {
                var g = gunRuns[i];
                g.Age += dt;
                float t = Mathf.Clamp01(g.Age / g.Duration);
                if (g.Age > g.Duration + .05f) { gunRuns.RemoveAt(i); continue; }
                var impact = math.lerp(g.From, g.To, t);
                var muzzle = GunMuzzle(g.Shooter, g.From, out _);
                // ~65 rounds a second is far more than can be drawn: about 30 tracer/impact pulses a second read as a solid stream
                while (g.NextShot <= g.Age)
                {
                    g.NextShot += 1f / 30f;
                    var jitter = new float3(UnityEngine.Random.value - .5f, 0, UnityEngine.Random.value - .5f) * .16f;
                    var hit = impact + jitter;
                    fx.GunFlash(muzzle, hit - muzzle);
                    fx.Tracer(muzzle, hit, true);
                    if (UnityEngine.Random.value < .55f) fx.Tracer(muzzle, hit + jitter * .5f, false);
                    fx.GunImpact(hit, g.Biome, UnityEngine.Random.value < .2f);
                    // every few rounds a heavier burst of earth, so the walk of impacts reads from operational zoom
                    if (UnityEngine.Random.value < .12f) fx.Impact(hit, .3f, g.Biome);
                }
            }
        }
    }
}
