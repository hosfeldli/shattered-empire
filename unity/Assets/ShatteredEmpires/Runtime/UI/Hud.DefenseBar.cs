using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The old bottom defense bar is gone (2026-11-16, plan §2.G): every defense and improvement is placed from
    /// the Build wheel (B or the dock's Build button, Hud.Base.cs). What remains here is the tool chip that
    /// replaces the selection card while a placement or target tool runs, and the invalid-placement reason
    /// shown at the cursor (field defenses, new bases, trenches, roads and terrain works: the server refuses
    /// anything outside your own territory and says why).
    /// </summary>
    public sealed partial class Hud
    {
        VisualElement toolChip;
        Label toolChipName, toolChipCost, cursorReason;
        IconElement toolChipIcon;
        VisualElement toolChipKeys;
        string toolChipSignature = "";
        int patrolChipShown = -1;
        Commander.Mode toolChipMode;
        string toolChipOption, toolChipCommand, toolChipAbility, toolChipMission;
        JObject toolChipTarget;
        JToken toolChipQuote = QuoteUnset;
        static readonly JToken QuoteUnset = new JValue("unset");
        JObject terrainChipPlan;
        int terrainChipRadius = -1;
        Vector2 cursorReasonAt = new Vector2(float.NaN, float.NaN);

        /// <summary>Kept for callers of the old defense bar (Hud.ActionContext): B now toggles the Build wheel.</summary>
        void ToggleDefenseBarArmed() => ToggleBuildWheel(true);

        /// <summary>"165 Materials · 45 Energy" (zero parts omitted).</summary>
        static string CmdCostText(JToken cost)
        {
            if (!(cost is JObject o)) return "";
            var sb = new System.Text.StringBuilder();
            foreach (var p in o.Properties())
            {
                int amount = Mathf.RoundToInt(ProtocolDecoder.Float(p.Value));
                if (amount <= 0) continue;
                if (sb.Length > 0) sb.Append(" · ");
                sb.Append(amount).Append(' ').Append(p.Name == "materials" ? "Materials" : p.Name == "energy" ? "Energy" : p.Name);
            }
            return sb.ToString();
        }

        // ------------------------------------------------------------------ tool chip + cursor reason
        void BuildToolChip()
        {
            toolChip = UiKit.Fx(UiKit.El("se-cmd-toolchip", root), "se-fx--cup");   // rises in above the dock, fades out
            toolChip.style.position = Position.Absolute;
            toolChip.style.bottom = 112; toolChip.style.height = 40;
            // sized to its text (no fixed width: long titles were cut, "New base · beside a…"), centred by translate
            toolChip.style.left = Length.Percent(50);   // centred by the -50 % translate of .se-fx--cup (SE.uss), which also slides it
            toolChip.style.maxWidth = 860;
            toolChip.style.flexDirection = FlexDirection.Row; toolChip.style.alignItems = Align.Center;
            toolChipIcon = new IconElement("", "se-cmd-toolchip-icon");
            toolChipIcon.style.width = 20; toolChipIcon.style.height = 20; toolChipIcon.style.flexShrink = 0;
            toolChip.Add(toolChipIcon);
            toolChipName = UiKit.Text("", "se-cmd-toolchip-name", toolChip);
            toolChipName.style.flexGrow = 0; toolChipName.style.flexShrink = 1; toolChipName.style.marginRight = 10; toolChipName.style.overflow = Overflow.Hidden;
            toolChipName.style.textOverflow = TextOverflow.Ellipsis; toolChipName.style.whiteSpace = WhiteSpace.NoWrap;
            toolChipCost = UiKit.Text("", "se-cmd-toolchip-cost", toolChip);
            toolChipCost.style.flexShrink = 0;
            toolChipKeys = UiKit.El("se-cmd-toolchip-keys", toolChip);
            toolChipKeys.style.flexDirection = FlexDirection.Row; toolChipKeys.style.flexShrink = 0;
            UiKit.Text(ChipKey("rotate_left", ","), "se-cmd-keycap", toolChipKeys);
            UiKit.Text(ChipKey("rotate_right", "."), "se-cmd-keycap", toolChipKeys);
            UiKit.Text("rotate", "se-cmd-toolchip-cost", toolChipKeys);
            var close = UiKit.IconButton("close", () => commander.Cancel(), "Cancel (Esc)", toolChip, 28);
            close.style.flexShrink = 0;
            cursorReason = UiKit.Fx(UiKit.Text("", "se-cmd-cursor-reason", root), "se-fx--follow se-fx--quick");
            cursorReason.pickingMode = PickingMode.Ignore;
            // wraps at 380 px so a long refusal never runs off the screen; flipped left of the cursor near the right edge
            cursorReason.style.position = Position.Absolute; cursorReason.style.whiteSpace = WhiteSpace.Normal; cursorReason.style.maxWidth = 380;
            cursorReason.style.left = 0; cursorReason.style.top = 0;
        }

        /// <summary>A short keycap for a bound action (",", ".", "Q"), or the fallback.</summary>
        static string ChipKey(string action, string fallback)
        {
            var key = InputFacade.KeyFor(action);
            switch (key)
            {
                case KeyCode.None: return fallback;
                case KeyCode.Comma: return ",";
                case KeyCode.Period: return ".";
                default:
                    string s = key.ToString();
                    return s.Length <= 3 ? s : fallback;
            }
        }

        static string TerrainTitle(string op) => op switch
        {
            "raise" => "Raise ground", "lower" => "Lower ground", "flatten" => "Flatten ground", "smooth" => "Smooth ground", _ => "Terrain works"
        };

        void UpdateToolChip(Vector2 pointer)
        {
            if (toolChip == null) return;
            bool tool = commander.Current != Commander.Mode.Select && !session.Spectator;
            // aircraft patrol planning (P) runs in select mode: it gets the chip too, with its waypoint count and keys
            bool patrol = !tool && !session.Spectator && commander.PatrolPlanning;
            UiKit.SetShown(toolChip, tool || patrol);
            if (patrol)
            {
                int n = commander.PatrolWaypointCount;
                if (toolChipSignature != "patrol" || patrolChipShown != n)
                {
                    toolChipSignature = "patrol"; patrolChipShown = n;
                    toolChipIcon.Kind = "airfield";
                    toolChipName.text = $"Patrol route · {n}/8 waypoints";
                    toolChipCost.text = "Click waypoints · Shift adds · " + HudKey("air_patrol", "P") + ", Enter or right-click sends";
                    toolChipCost.style.display = DisplayStyle.Flex;
                    toolChipKeys.style.display = DisplayStyle.None;
                }
                UiKit.Hide(cursorReason);
                return;
            }
            if (toolChipSignature == "patrol") toolChipSignature = "";
            string command = ProtocolDecoder.Str(commander.TargetCommand?["c"]);
            bool fieldBuild = tool && commander.Current == Commander.Mode.Target && command == "fieldBuild";
            if (tool)
            {
                // the signature parts are compared in place (no per-frame string while a tool runs)
                string chipAbility = ProtocolDecoder.Str(commander.TargetCommand?["ability"]), chipMission = ProtocolDecoder.Str(commander.TargetCommand?["mission"] ?? commander.TargetCommand?["op"]);
                if (toolChipSignature != "set" || toolChipMode != commander.Current || toolChipOption != commander.Option || toolChipCommand != command
                    || toolChipAbility != chipAbility || toolChipMission != chipMission || toolChipTarget != commander.TargetCommand)
                {
                    toolChipSignature = "set";
                    toolChipMode = commander.Current; toolChipOption = commander.Option; toolChipCommand = command;
                    toolChipAbility = chipAbility; toolChipMission = chipMission; toolChipTarget = commander.TargetCommand;
                    string icon, title, cost = "";
                    switch (commander.Current)
                    {
                        case Commander.Mode.Road: icon = "road"; title = "Build a road in your territory"; cost = "15 Materials / link"; break;
                        case Commander.Mode.Trench: icon = "trench"; title = "Draw a trench in your territory"; cost = "35 Materials / segment"; break;
                        case Commander.Mode.Rally: icon = "rally"; title = commander.RallyAttackMoveArmed ? "Set an attack-move rally point" : "Set rally point"; break;
                        case Commander.Mode.Place: icon = Icons.BuildingKind(commander.Option); title = NameOf("BUILDINGS", commander.Option); cost = CmdCostText(Defs?["BUILDINGS"]?[commander.Option]?["cost"]); break;
                        default:
                            if (command == "fieldBuild")
                            {
                                bool newBase = commander.Option == ProtocolDecoder.Str(Defs?["RULESET"]?["newBase"]?["type"], "base_site");
                                icon = newBase ? "new_base" : Icons.BuildingKind(commander.Option);
                                title = newBase ? "New base · on or beside a road, in your territory" : NameOf("BUILDINGS", commander.Option);
                                cost = CmdCostText(Defs?["BUILDINGS"]?[commander.Option]?["cost"]);
                            }
                            else if (command == "terrain") { string op = ProtocolDecoder.Str(commander.TargetCommand?["op"]); icon = "terrain_" + op; title = TerrainTitle(op) + " · brush"; cost = ""; terrainChipRadius = -1; }
                            else if (command == "move") { bool attack = ProtocolDecoder.Bool(commander.TargetCommand?["attackMove"]); icon = attack ? "attack_move" : "move"; title = attack ? "Attack-move" : "Move"; }
                            else if (command == "ability") { string key = ProtocolDecoder.Str(commander.TargetCommand?["ability"]); icon = AbilityGlyph(key); title = ProtocolDecoder.Str(Defs?["ABILITIES"]?[key]?["name"], "Use ability"); }
                            else if (command == "airMission") { string mission = ProtocolDecoder.Str(commander.TargetCommand?["mission"], ""); icon = "airfield"; title = mission.Length > 0 ? char.ToUpperInvariant(mission[0]) + mission.Substring(1) : "Air mission"; }
                            else if (command == "missileLaunch") { icon = "missile_launch"; title = "Strategic missile target"; }
                            else { icon = "target"; title = "Choose a target"; }
                            break;
                    }
                    toolChipIcon.Kind = icon;
                    toolChipName.text = title;
                    toolChipCost.text = cost; toolChipQuote = QuoteUnset; toolChipCost.RemoveFromClassList("se-cmd-toolchip-cost--surcharge");
                    toolChipCost.style.display = cost.Length > 0 ? DisplayStyle.Flex : DisplayStyle.None;
                    toolChipKeys.style.display = fieldBuild ? DisplayStyle.Flex : DisplayStyle.None;
                }
            }
            else toolChipSignature = "";
            // ring of influence: the server's quote for this spot replaces the list price when it is surcharged
            // ("390 Materials · 30 Energy · Outside your influence: ×3 cost"); rebuilt only when the quote changes
            if (fieldBuild && !ReferenceEquals(commander.FieldPreviewCost, toolChipQuote))
            {
                toolChipQuote = commander.FieldPreviewCost;
                string note = commander.FieldPreviewNote;
                string text = !string.IsNullOrEmpty(note) && toolChipQuote != null ? "! " + CmdCostText(toolChipQuote) + " · " + note
                    : CmdCostText(Defs?["BUILDINGS"]?[commander.Option]?["cost"]);
                if (toolChipCost.text != text) toolChipCost.text = text;
                toolChipCost.style.display = text.Length > 0 ? DisplayStyle.Flex : DisplayStyle.None;
                toolChipCost.EnableInClassList("se-cmd-toolchip-cost--surcharge", !string.IsNullOrEmpty(note));
            }
            else if (!fieldBuild) toolChipQuote = QuoteUnset;
            // terrain brush: the previewed stroke's cost, hexes and the brush size keys (rebuilt only when they change)
            bool terrainBrush = tool && commander.TerrainBrushActive;
            if (terrainBrush && (!ReferenceEquals(commander.TerrainPreview, terrainChipPlan) || commander.TerrainBrushRadius != terrainChipRadius))
            {
                terrainChipPlan = commander.TerrainPreview; terrainChipRadius = commander.TerrainBrushRadius;
                string text = commander.TerrainBrushChipText();
                if (toolChipCost.text != text) toolChipCost.text = text;
                toolChipCost.style.display = DisplayStyle.Flex;
            }
            else if (!terrainBrush) { terrainChipPlan = null; terrainChipRadius = -1; }
            // the invalid placement reason sits at the cursor, only while invalid: field builds (territory, footprint)
            // and trench / road strokes the server refused in preview
            string reason = "";
            bool invalid = false;
            if (fieldBuild)
            {
                reason = commander.FieldPreviewReason ?? "";
                invalid = commander.FieldPreviewParcel != null && !commander.FieldPreviewValid && reason.Length > 0 && !reason.StartsWith("Checking");
            }
            else if (terrainBrush)
            {
                reason = commander.TerrainPreviewReason ?? "";
                invalid = reason.Length > 0;
            }
            bool strokePartial = false;
            if (!fieldBuild && !terrainBrush && tool && (commander.Current == Commander.Mode.Trench || commander.Current == Commander.Mode.Road))
            {
                reason = commander.StrokePreviewReason ?? "";
                invalid = reason.Length > 0;
                // a stroke with some bad hexes is still built where it can be: an amber note, not a refusal
                int skipped = commander.StrokePreviewSkipped;
                if (!invalid && skipped > 0)
                {
                    bool road = commander.Current == Commander.Mode.Road;
                    reason = $"!  {skipped} {(road ? (skipped == 1 ? "segment" : "segments") : (skipped == 1 ? "hex" : "hexes"))} skipped (red) · the rest will be built";
                    invalid = strokePartial = true;
                }
            }
            // a valid defense spot beyond the ring of influence: an amber "!" warning at the cursor with the price
            bool surcharged = false;
            if (fieldBuild && !invalid && commander.FieldPreviewParcel != null
                && (!string.IsNullOrEmpty(commander.FieldPreviewNote) || commander.PlacingSurchargedDefense))
            {
                float factor = ProtocolDecoder.Float(Defs?["RULESET"]?["influence"]?["factor"], 3);
                string price = commander.FieldPreviewCost != null && !string.IsNullOrEmpty(commander.FieldPreviewNote) ? " · " + CmdCostText(commander.FieldPreviewCost) : "";
                reason = $"!  ×{factor:0.#} cost here: outside your ring of influence{price}";
                surcharged = invalid = true;
            }
            cursorReason.EnableInClassList("se-cmd-cursor-reason--warn", surcharged || strokePartial);
            if (invalid && !IsPointerOverUi(InputFacade.MousePosition))
            {
                if (cursorReason.text != reason) cursorReason.text = reason;
                // follows the cursor: translate only (no layout pass per frame)
                float reasonWidth = float.IsNaN(cursorReason.resolvedStyle.width) ? 380f : cursorReason.resolvedStyle.width;
                float panelWidth = root.resolvedStyle.width > 0 ? root.resolvedStyle.width : Screen.width;
                var at = new Vector2(pointer.x + 18 + reasonWidth > panelWidth - 8 ? pointer.x - 12 - reasonWidth : pointer.x + 18, pointer.y + 14);
                if (!((at - cursorReasonAt).sqrMagnitude <= .0025f)) { cursorReasonAt = at; cursorReason.style.translate = new Translate(at.x, at.y); }
                UiKit.Show(cursorReason);
            }
            else UiKit.Hide(cursorReason);
        }
    }
}
