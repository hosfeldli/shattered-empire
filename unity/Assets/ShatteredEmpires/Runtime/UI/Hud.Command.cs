using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// Control groups, bottom-right (docs/UI_DESIGN_SPEC.md § B12): every assigned group as a 52×32 chip
    /// with its digit and strength. Click selects, double-click jumps the camera there, Ctrl+click assigns
    /// the current selection. Hidden when no group exists. Plus the game-speed hotkeys (spectators, sandbox and
    /// single-player matches; matches with several humans change speed by vote, Hud.SpeedVote.cs).
    /// </summary>
    public sealed partial class Hud
    {
        VisualElement groupsBar;
        string groupSignature = "";
        readonly List<(int key, int count)> groupList = new List<(int, int)>(9), groupShown = new List<(int, int)>(9);
        float groupsAt, groupsBottom = -1f;
        static readonly int[] Speeds = { 1, 2, 4 };
        static readonly int[] SpectatorSpeeds = { 1, 2, 4, 8 };

        void BuildCommandGroups()
        {
            groupsBar = UiKit.Fx(El("se-groups", root), "se-fx--fade");   // fades; its bottom glides with the panel (SE.uss)
            groupsBar.pickingMode = PickingMode.Ignore;
        }

        void UpdateCommandGroups(float time)
        {
            if (!session.ActionRts || session.Spectator) { UiKit.Hide(groupsBar); return; }
            if (time < groupsAt) return;
            groupsAt = time + .25f;
            var list = groupList;
            list.Clear();
            foreach (var entry in commander.GroupSummary()) list.Add(entry);
            UiKit.SetShown(groupsBar, list.Count > 0);
            // the chips sit just above the bottom-right selection panel (or in its place when nothing is selected)
            float cardH = card != null && UiKit.IsShown(card) ? card.resolvedStyle.height : 0f;
            float bottom = float.IsNaN(cardH) || cardH <= 0 ? 16f : 16f + cardH + 8f;
            if (Mathf.Abs(bottom - groupsBottom) > .5f) { groupsBottom = bottom; groupsBar.style.bottom = bottom; }
            // rebuild the chips only when a group or its strength changed (compared in place, no signature string)
            bool same = groupSignature == "built" && list.Count == groupShown.Count;
            for (int i = 0; same && i < list.Count; i++) same = list[i] == groupShown[i];
            if (same) return;
            groupSignature = "built";
            groupShown.Clear(); groupShown.AddRange(list);
            groupsBar.Clear();
            foreach (var (key, count) in list)
            {
                int k = key;
                var chip = UiKit.Chip(null, groupsBar);
                chip.AddToClassList("se-group-chip");
                L(k.ToString(), "se-group-digit", chip).pickingMode = PickingMode.Ignore;
                L(count.ToString(), "se-group-count", chip).pickingMode = PickingMode.Ignore;
                chip.tooltip = $"Group {k} · {count} units\nClick selects, double-click jumps there, Ctrl+click assigns the selection.";
                chip.clicked += () =>
                {
                    if (Input.InputFacade.Ctrl) AssignGroup(k);
                    else commander.RecallGroup(k, now);
                };
            }
        }

        /// <summary>Ctrl+click on a group chip: the current unit selection becomes that group (as Ctrl+digit).</summary>
        void AssignGroup(int k)
        {
            var ids = units.Selected.ToArray();
            if (session.ActionRts && !session.Spectator)
                session.Net?.Command(new JObject { ["c"] = "group", ["group"] = k, ["units"] = new JArray(ids) });
            commander.Say(ids.Length > 0 ? $"Group {k}: {ids.Length} units" : $"Group {k} cleared", true, now);
            groupSignature = "";
        }

        void SpeedHotkeys()
        {
            bool spectator = session.Spectator;
            // spectators, the sandbox and single-player matches (Hud.Shell.cs SpeedDirect); several humans vote instead (Hud.SpeedVote.cs)
            if (session.Paused || !SpeedDirect) return;
            var speeds = spectator ? SpectatorSpeeds : Speeds;
            int current = Mathf.RoundToInt(session.PlayRate), i = System.Array.IndexOf(speeds, current);
            if (i < 0) i = 0;
            if (Input.InputFacade.Action("faster") && i < speeds.Length - 1) SetSpeed(speeds[i + 1]);
            else if (Input.InputFacade.Action("slower") && i > 0) SetSpeed(speeds[i - 1]);
        }
    }
}
