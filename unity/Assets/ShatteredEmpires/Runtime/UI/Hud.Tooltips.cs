using SE.Runtime.Input;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    public sealed partial class Hud
    {
        VisualElement helpAnchor;
        string helpText;
        float helpSince;
        bool runtimeHelpVisible;

        static string DefaultActionTip(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return null;
            string text = label.ToLowerInvariant();
            if (text.StartsWith("attack-move")) return "Attack-move (" + InputFacade.KeyLabel("attack") + ")\nClick a destination. The army advances and engages valid enemies along the route. Shift queues the order.";
            if (text == "hold") return "Hold position (" + InputFacade.KeyLabel("hold") + ")\nStop and defend this position. Units fire at valid enemies in range and retain your placement instead of seeking a new position.";
            if (text.StartsWith("retreat")) return "Retreat\nWithdraw to a friendly operational headquarters. Ground units prioritize movement rather than stopping to fight.";
            if (text.StartsWith("new campaign")) return "New Campaign\nStart a combat-first match. Scout, capture city ruins, develop headquarters and defeat the opposing military.";
            if (text.StartsWith("continue")) return "Continue operation\nReconnect to your current hosted match and resume your faction.";
            if (text.StartsWith("tutorial")) return "Tutorial\nLearn camera controls, army commands, ruin capture, base construction and production in a small match.";
            if (text.StartsWith("watch ai")) return "Watch AI\nObserve competing AI factions. Follow armies, inspect bases and control observation speed.";
            if (text.StartsWith("combat sandbox")) return "Combat Sandbox\nChoose a repeatable army scenario to inspect combined-arms combat and military equipment.";
            if (text.StartsWith("multiplayer")) return "Multiplayer\nCreate or join a hosted match. Select teams and opponents before launching.";
            if (text.StartsWith("field guide")) return "Field Guide\nLook up units, buildings, resources, counters, commands and asset credits.";
            if (text.StartsWith("settings")) return "Settings\nAdjust graphics, audio, interface scaling, accessibility and key bindings.";
            if (text.StartsWith("field construction")) return InputFacade.Expand("Build wheel ({build})\nPlace defenses, sandbags, roads and trenches on your land or neutral ground (defenses cost ×3 beyond your ring of influence); outposts and a New Base go inside your territory. Your base engineers build them. {rotate_left} and {rotate_right} rotate a defense before placement.");
            if (text.StartsWith("rally")) return "Rally point\nClick a world position. Newly recruited units move there automatically.";
            if (text.StartsWith("reinforce")) return "Reinforce an army\nSend compatible newly recruited units to the selected army group.";
            if (text.StartsWith("repeat")) return "Repeat production\nContinue recruiting this unit when resources and command capacity permit. Disable it to stop future recruitment.";
            if (text == "details") return "Unit details\nInspect roles, counters, health, equipment, abilities and available commands.";
            if (text.StartsWith("trench")) return "Draw a trench\nDrag across clear visible terrain and release. Infantry ordered into a completed trench line deploy inside it. Defenders gain directional protection.";
            if (text.StartsWith("road")) return "Build a road\nDrag a route across clear visible terrain and release. Roads connect bases and improve vehicle travel.";
            if (text.StartsWith("quit")) return "Quit\nClose Shattered Empires. Hosted match state remains on the server for rejoining.";
            if (text.StartsWith("cancel")) return "Cancel\nCancel the current placement or selection tool. Escape also cancels.";
            if (text.StartsWith("repair")) return "Repair\nSpend Materials to restore this structure. Nearby idle engineers improve repair and construction progress.";
            if (text.Contains("back") || text.StartsWith("‹")) return "Back\nReturn to the previous view. Escape also closes the current tool or panel.";
            return null;   // no specific help: a tooltip that repeats the label is noise
        }

        /// <summary>The tooltip's laid-out width (measured after layout; before the first layout, its styled width).</summary>
        float TooltipWidth()
        {
            float w = tooltip?.resolvedStyle.width ?? float.NaN;
            return float.IsNaN(w) || w < 1f ? 384f : w;
        }

        // UI Toolkit's editor tooltip property is also consumed explicitly in the player.
        // This one overlay works for menu, construction and contextual controls, including
        // disabled buttons whose descriptions explain a prerequisite or shortage.
        void UpdateRuntimeHelp(float time)
        {
            if (root?.panel == null || tooltip == null) return;
            var mouse = InputFacade.MousePosition;
            var panelPoint = RuntimePanelUtils.ScreenToPanel(root.panel, new Vector2(mouse.x, Screen.height - mouse.y));
            var element = PickCached(panelPoint);
            while (element != null && element != root && string.IsNullOrWhiteSpace(element.tooltip)) element = element.parent;
            if (element == root) element = null;
            string text = element?.tooltip;
            if (element != helpAnchor || text != helpText)
            {
                if (text != helpText)
                {
                    if (runtimeHelpVisible) UiKit.Hide(tooltip);
                    runtimeHelpVisible = false; helpSince = time;
                }
                helpAnchor = element; helpText = text;
            }
            if (element == null || string.IsNullOrWhiteSpace(text) || InputFacade.LeftDown || InputFacade.RightDown)
            {
                if (runtimeHelpVisible) UiKit.Hide(tooltip);
                runtimeHelpVisible = false; return;
            }
            if (time - helpSince < .35f) return;
            if (!runtimeHelpVisible)
            {
                tooltip.Clear();
                var lines = text.Split(new[] { '\n' }, 2);
                var title = L(lines[0], "heading", tooltip); title.pickingMode = PickingMode.Ignore; title.style.whiteSpace = WhiteSpace.Normal;
                if (lines.Length > 1)
                {
                    var body = L(lines[1], "small", tooltip); body.style.whiteSpace = WhiteSpace.Normal;
                    body.pickingMode = PickingMode.Ignore;
                }
            }
            tooltip.style.maxWidth = Mathf.Min(360, root.layout.width - 24);
            if (!runtimeHelpVisible) tooltip.BringToFront();
            UiKit.Show(tooltip);
            float measured = tooltip.resolvedStyle.height;
            float height = float.IsNaN(measured) ? 150 : Mathf.Clamp(measured, 65, 260);
            tooltip.style.left = Mathf.Clamp(panelPoint.x + 16, 8, Mathf.Max(8, root.layout.width - TooltipWidth() - 16));
            tooltip.style.top = Mathf.Clamp(panelPoint.y + 22, 8, Mathf.Max(8, root.layout.height - height - 12));
            runtimeHelpVisible = true;
        }
    }
}
