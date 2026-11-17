using UnityEngine;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Aircraft fuel in the interface (workstream D). The snapshot's air array carries own aircraft fuel as a
    /// byte (0-255) and a state code (0 on the pad, 1 refuelling, 2 airborne, 3 returning to base, 4 out of
    /// fuel). The selection card shows the lowest fuel among selected aircraft; hover cards can use
    /// <see cref="AirStatusText"/>.
    /// </summary>
    public sealed partial class Hud
    {
        /// <summary>"Fuel 72% · Returning to base" for an own aircraft; null for ground units or enemy aircraft.</summary>
        public string AirStatusText(int unitId)
        {
            if (!session.ActionRts || !session.Units.TryGet(unitId, out var u) || u.AirState < 0 || u.Fuel < 0) return null;
            int pct = Mathf.RoundToInt(u.Fuel * 100f / 255f);
            string state = u.AirState switch
            {
                0 => "On the pad",
                1 => "Refuelling",
                3 => "Returning to base",
                4 => "Out of fuel",
                _ => null,
            };
            return state == null ? $"Fuel {pct}%" : $"Fuel {pct}% · {state}";
        }

        /// <summary>Lowest fuel (0-100) among selected own aircraft, or -1 when none are selected.</summary>
        float SelectionFuel()
        {
            float low = -1;
            foreach (int id in units.Selected)
                if (session.Units.TryGet(id, out var u) && u.AirState >= 0 && u.Fuel >= 0)
                {
                    float pct = u.Fuel * 100f / 255f;
                    low = low < 0 ? pct : Mathf.Min(low, pct);
                }
            return low;
        }

        /// <summary>The selection card's fuel row (hidden while no aircraft are selected).</summary>
        void AirFuelCardBar()
        {
            if (!session.ActionRts) return;
            CardBar(SelectionFuel, () =>
            {
                float f = SelectionFuel();
                return f < 0 ? "" : f <= 0 ? "Out of fuel" : $"Fuel {f:0}%";
            }, () => HealthColor(SelectionFuel()));
        }
    }
}
