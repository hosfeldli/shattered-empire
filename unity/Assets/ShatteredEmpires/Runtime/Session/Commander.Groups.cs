using System.Collections.Generic;
using SE.Runtime.Input;
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

        // ------------------------------------------------------------------ selection hotkeys (§19-21)
        // select_local (Arrow A / WASD Q): your units on screen; with Ctrl every unit you own. select_production (E):
        // every finished production building; with Ctrl every building you own. Shift adds to the selection. Keys come
        // from the remappable action table (InputFacade), which already ignores them while a text field has focus.

        /// <summary>Per frame in select mode: the selection hotkeys.</summary>
        void SelectionKeys()
        {
            if (lineDrag || rightPress || dragging) return;
            if (InputFacade.Action("select_local")) SelectFriendlyUnits(!InputFacade.Ctrl, InputFacade.Shift);
            if (InputFacade.Action("select_production")) SelectOwnBuildings(!InputFacade.Ctrl, InputFacade.Shift);
        }

        /// <summary>
        /// Select every unit of ours that may be selected (not the automatic base engineers), within the visible camera
        /// area or world-wide. Returns how many units are selected afterwards.
        /// </summary>
        public int SelectFriendlyUnits(bool onScreenOnly, bool add = false)
        {
            if (!add)
            {
                units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1;
                SelectedObjective = SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            }
            int before = units.Selected.Count;
            var st = session.Units;
            for (int s = 0; s < st.SlotCount; s++)
            {
                ref var u = ref st.Records[s];
                if (!u.InUse || !Selectable(u)) continue;
                if (onScreenOnly && !(ScreenOf(s, out var sp) && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height)) continue;
                units.Selected.Add(u.Id);
            }
            if (units.Selected.Count == before && !add) Say(onScreenOnly ? "No units on screen" : "No units", false, Time.unscaledTime);
            SelectionChanged?.Invoke();
            return units.Selected.Count;
        }

        /// <summary>True for a building type that trains units (BUILDINGS[type].trains).</summary>
        bool IsProductionType(string type) => !string.IsNullOrEmpty(type) && session.Defs?["BUILDINGS"]?[type]?["trains"] is Newtonsoft.Json.Linq.JArray;

        /// <summary>
        /// Select our buildings world-wide: only finished production buildings, or every building (towns stay with
        /// their base). Returns the number selected.
        /// </summary>
        public int SelectOwnBuildings(bool productionOnly, bool add = false)
        {
            if (session.Spectator) return 0;
            if (!add)
            {
                units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1;
                SelectedObjective = SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            }
            int n = 0;
            foreach (var b in session.Structures.Buildings.Values)
            {
                if (b.Owner != session.CivId || b.Memory || b.Type == "town") continue;
                if (productionOnly && (!b.Done || !IsProductionType(b.Type))) continue;
                if (SelectedBuildings.Add(b.Id)) n++;
            }
            if (n == 0 && !add) Say(productionOnly ? "No production buildings" : "No buildings", false, Time.unscaledTime);
            SelectionChanged?.Invoke();
            return n;
        }

        /// <summary>Ctrl + double-click on a building: every building of ours of that type, anywhere on the map.</summary>
        void SelectSameTypeEverywhere(string type)
        {
            if (string.IsNullOrEmpty(type) || session.Spectator) return;
            foreach (var b in session.Structures.Buildings.Values)
                if (b.Owner == session.CivId && !b.Memory && b.Type == type) SelectedBuildings.Add(b.Id);
        }
    }
}
