using System.Collections.Generic;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>Control groups as a clickable bar for the HUD (the idle-units button was removed, spec B12).</summary>
    public sealed partial class Commander
    {
        /// <summary>Assigned control groups (1-9) with their living members.</summary>
        public IEnumerable<(int key, int count)> GroupSummary()
        {
            for (int k = 1; k <= 9; k++)
            {
                if (!groups.TryGetValue(k, out var g)) continue;
                g.RemoveWhere(id => !session.Units.SlotOf.ContainsKey(id));
                if (g.Count > 0) yield return (k, g.Count);
            }
        }

        /// <summary>Select a control group (as pressing its number); a second call within 0.4 s centres the camera on it.</summary>
        public void RecallGroup(int k, float time)
        {
            if (!groups.TryGetValue(k, out var g) || g.Count == 0) return;
            units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1; SelectedObjective = 0;
            foreach (var id in g) units.Selected.Add(id);
            SelectionChanged?.Invoke();
            if (lastGroup == k && time - lastGroupAt < 0.4f && SelectionCentre() is Vector3 c) cam.JumpTo(c);
            lastGroup = k; lastGroupAt = time;
        }
    }
}
