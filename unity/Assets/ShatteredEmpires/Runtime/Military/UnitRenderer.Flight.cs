using System;
using SE.Core.Units;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Military
{
    /// <summary>
    /// Aircraft attitude (presentation only). The server flies fixed-wing aircraft with a limited, smoothly changing
    /// turn rate and helicopters with limited acceleration (server/sim/actionFlight.js); FlySnapshot follows that
    /// track on a Hermite curve. Here the attitude comes from the motion itself: helicopters pitch nose-down while
    /// accelerating and flare nose-up while braking, with a gentle hover bob when slow; jets pitch with their climb
    /// and dive (down into a gun or bombing run, up as they pull out). Bank is set in FlySnapshot from the turn.
    /// </summary>
    public sealed partial class UnitRenderer
    {
        float[] flPitch = new float[0], flVx = new float[0], flVz = new float[0], flAccel = new float[0];

        void EnsureFlight(int n)
        {
            if (flPitch.Length >= n) return;
            Array.Resize(ref flPitch, n); Array.Resize(ref flVx, n); Array.Resize(ref flVz, n); Array.Resize(ref flAccel, n);
        }

        void ResetFlight(int s, float vx, float vz, float altitude)
        {
            flPitch[s] = 0; flVx[s] = vx; flVz[s] = vz; flAccel[s] = 0;
        }

        /// <summary>Update the pitch of the aircraft in slot s from its smoothed velocity and climb rate.</summary>
        void FlightAttitude(int s, Kind kind, float vx, float vz, float climb, float dt)
        {
            if (dt <= 0f) return;
            float v = Mathf.Sqrt(vx * vx + vz * vz);
            // forward acceleration: the change of velocity along the direction of flight (smoothed)
            float ax = (vx - flVx[s]) / dt, az = (vz - flVz[s]) / dt;
            float forward = v > .02f ? (ax * vx + az * vz) / v : 0f;
            flAccel[s] = Mathf.Lerp(flAccel[s], Mathf.Clamp(forward, -6f, 6f), 1f - Mathf.Exp(-dt * 3f));
            flVx[s] = vx; flVz[s] = vz;
            float want;
            if (kind == Kind.Heli || kind == Kind.Drone || kind == Kind.Swarm)
            {
                // cruise attitude grows with speed; accelerating tips the nose down further, braking flares it up
                float cruise = Mathf.Clamp(v * .045f, 0f, .14f);
                want = Mathf.Clamp(cruise + flAccel[s] * .075f, -.22f, .32f);
            }
            else
            {
                // flight-path angle: nose down in a dive, up in a climb (positive pitch is nose-down)
                want = Mathf.Clamp(-Mathf.Atan2(climb, Mathf.Max(.5f, v)), -.42f, .42f);
            }
            flPitch[s] = Mathf.Lerp(flPitch[s], want, 1f - Mathf.Exp(-dt * 4f));
        }

        float AirPitch(int slot, Kind kind)
        {
            if (slot < flPitch.Length && airLive[slot]) return flPitch[slot];
            return kind == Kind.Heli ? Mathf.Clamp(speed[slot] * .12f, 0, .22f) : 0f;
        }

        /// <summary>A slow hover bob: noticeable for a helicopter holding still, fading out as it picks up speed.</summary>
        float HoverBob(int slot, Kind kind, float time, float phase)
        {
            if (kind != Kind.Heli && kind != Kind.Drone) return Mathf.Sin(time * .7f + phase) * .008f;
            float still = 1f - Mathf.Clamp01(speed[slot] / .8f);
            return Mathf.Sin(time * 1.1f + phase) * (.006f + .012f * still) + Mathf.Sin(time * 2.3f + phase * 1.7f) * .003f * still;
        }

        /// <summary>
        /// Drawn pose of an airborne unit (camera-independent base image): position with altitude and its heading.
        /// Used by gun-run effects so the muzzle flash and tracers leave the aircraft where it is drawn.
        /// </summary>
        public bool TryGetAirPose(UnitStore store, int id, out float3 mapPos, out float heading)
        {
            mapPos = default; heading = 0;
            if (!store.SlotOf.TryGetValue(id, out int s) || s >= px.Length || ids[s] != id || !airLive[s]) return false;
            mapPos = new float3(px[s], airAlt[s], pz[s]);
            heading = airH[s];
            return true;
        }
    }
}
