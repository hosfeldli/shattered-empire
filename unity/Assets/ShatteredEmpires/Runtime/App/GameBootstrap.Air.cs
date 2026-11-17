using SE.Core.Protocol;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>Air presentation from the event stream (workstream D): flak volleys bursting at altitude.</summary>
    public sealed partial class GameBootstrap
    {
        /// <summary>
        /// A 'flak' event (action RTS): the volley bursts around the aircraft as it is drawn (the client flight
        /// model leads the server track), at the server's altitude, one puff per offset triple. Bursts are scaled
        /// up with camera distance so they still read at mid zoom.
        /// </summary>
        void PresentFlak(CombatEvent e)
        {
            if (!e.HasDestination || fx == null) return;
            float x = e.Destination.X, z = e.Destination.Z;
            if (e.Target > 0 && units != null && units.TryGetPosition(session.Units, e.Target, out var drawn)) { x = drawn.x; z = drawn.y; }
            float altitude = e.Altitude > 0 ? e.Altitude : 1.6f;
            var centre = new float3(x, session.World.GroundHeight(x, z) + altitude, z);
            if (!Near(centre, Mathf.Max(60f, rts.Distance * 3f))) return;
            float scale = Mathf.Clamp(rts.Distance / 16f, 1f, 3.2f);
            fx.FlakVolley(centre, e.Bursts, scale, e.Outcome == "hit");
            audioDirector?.Play("flak", centre, 0.8f, 5f, 2, rts.Distance);
        }
    }
}
