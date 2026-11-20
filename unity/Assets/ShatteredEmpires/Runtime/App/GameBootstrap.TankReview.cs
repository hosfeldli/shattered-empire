using System.Collections;
using System.IO;
using UnityEngine;

namespace SE.Runtime.App
{
    public sealed partial class GameBootstrap
    {
        /// <summary>
        /// Review frames for the tank pass (2026-11-20): launched with -mode sandbox -battle tanks -review DIR, before the
        /// ordinary review frames. A burst of captures at gameplay zoom over the tank battle, then a close burst on a Main
        /// Battle Tank and on an Autonomous Tank, a few tenths of a second apart so muzzle blasts, shell blasts and coax
        /// tracers are caught: tanks_gameplay_N.png, tanks_close_tank_N.png, tanks_close_autonomous_N.png.
        /// </summary>
        IEnumerator TankReview(string directory)
        {
            if (battleKey != "tanks") yield break;
            yield return TankBurst(directory, "tanks_gameplay", null, 13f, 5, .6f);
            yield return TankBurst(directory, "tanks_close_tank", "tank", 2.4f, 6, .45f);
            yield return TankBurst(directory, "tanks_close_autonomous", "autonomous_tank", 2.6f, 6, .45f);
        }

        IEnumerator TankBurst(string directory, string name, string type, float distance, int shots, float gap)
        {
            for (int k = 0; k < shots; k++)
            {
                if (TankFocus(type, out var focus)) rts.Focus = focus;
                rts.Distance = rts.TargetDistance = distance;
                rts.Yaw = -22 + k * 4; rts.Apply();
                yield return new WaitForSecondsRealtime(k == 0 ? 1.2f : gap);
                yield return new WaitForEndOfFrame();
                CaptureReviewFrame(Path.Combine(directory, name + "_" + k + ".png"));
            }
        }

        /// <summary>The camera focus: the living unit of `type` nearest the enemy (where it is fighting), or the tanks' centroid.</summary>
        bool TankFocus(string type, out Vector3 focus)
        {
            focus = default;
            float x = 0, z = 0, ex = 0, ez = 0; int n = 0, en = 0;
            foreach (var id in session.Units.SlotOf.Keys)
            {
                if (!session.Units.TryGet(id, out var u) || !units.TryGetPosition(session.Units, id, out var p)) continue;
                if (u.Owner != session.CivId) { ex += p.x; ez += p.y; en++; }
                if (!session.Units.Types.Name(u.TypeIndex).Contains("tank")) continue;
                x += p.x; z += p.y; n++;
            }
            if (type == null)
            {
                if (n == 0) return false;
                focus = new Vector3(x / n, 0, z / n);
                return true;
            }
            var enemy = en > 0 ? new Vector2(ex / en, ez / en) : Vector2.zero;
            float best = float.MaxValue;
            foreach (var id in session.Units.SlotOf.Keys)
            {
                if (!session.Units.TryGet(id, out var u) || u.Owner != session.CivId || session.Units.Types.Name(u.TypeIndex) != type) continue;
                if (!units.TryGetPosition(session.Units, id, out var p)) continue;
                float d = (new Vector2(p.x, p.y) - enemy).sqrMagnitude;
                if (d < best) { best = d; focus = new Vector3(p.x, 0, p.y); }
            }
            return best < float.MaxValue;
        }
    }
}
