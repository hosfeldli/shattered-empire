using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Session;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The bottom-centre defensive build bar (spec B11): trench, road and every field defense, always visible,
    /// tier-locked ones disabled. B arms it for 2.5 s so 1–9, 0, - pick in order. Plus the tool chip that
    /// replaces the selection card while a placement or target tool runs, and the invalid-placement reason
    /// shown at the cursor.
    /// </summary>
    public sealed partial class Hud
    {
        sealed class DefenseButton
        {
            public string Key;          // "trench", "road" or a building type
            public Button Root;
            public Label Digit, Cost, TierLabel;
            public IconElement Icon, Lock;
            public string Tooltip = "";
            public int ShownCost = int.MinValue;
        }

        static readonly string[] DefenseBarOrder = { "trench", "road", "barricade", "guard_post", "bunker", "turret", "aa_battery", "sensor_post", "repair_point", "artillery_post", "fort" };
        static readonly string[] DefenseBarKeysLabels = { "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-" };

        VisualElement defenseBar, toolChip;
        Label toolChipName, toolChipCost, cursorReason;
        IconElement toolChipIcon;
        VisualElement toolChipKeys;
        readonly List<DefenseButton> defenseButtons = new List<DefenseButton>();
        bool defenseBarArmed;
        float defenseBarArmedUntil;
        int defenseBarToggleFrame = -1;
        string toolChipSignature = "";
        Commander.Mode toolChipMode;
        string toolChipOption, toolChipCommand, toolChipAbility, toolChipMission;
        JObject toolChipTarget;
        Vector2 cursorReasonAt = new Vector2(float.NaN, float.NaN);

        void BuildDefenseBar()
        {
            defenseBar = UiKit.El("se-defensebar", root);
            defenseBar.style.position = Position.Absolute;
            defenseBar.style.bottom = 16; defenseBar.style.left = Length.Percent(50);
            defenseBar.style.height = 60; defenseBar.style.width = 620; defenseBar.style.marginLeft = -310;
            defenseBar.style.flexDirection = FlexDirection.Row; defenseBar.style.alignItems = Align.Center;
            defenseBar.style.paddingLeft = 4; defenseBar.style.paddingRight = 4;
            for (int i = 0; i < DefenseBarOrder.Length; i++)
            {
                string key = DefenseBarOrder[i];
                var button = new DefenseButton { Key = key };
                var b = new Button { text = "" };
                b.AddToClassList("se-defensebar-btn");
                b.style.width = 52; b.style.height = 52; b.style.marginLeft = 0; b.style.marginRight = 4; b.style.marginTop = 0; b.style.marginBottom = 0;
                b.style.paddingLeft = 0; b.style.paddingRight = 0; b.style.paddingTop = 0; b.style.paddingBottom = 0;
                b.style.alignItems = Align.Center; b.style.justifyContent = Justify.Center;
                b.clicked += () => PickDefense(key);
                var icon = new IconElement(key == "trench" ? "trench" : key == "road" ? "road" : Icons.BuildingKind(key), "se-defensebar-icon");
                icon.style.width = 28; icon.style.height = 28;
                b.Add(icon);
                var digit = UiKit.Text(DefenseBarKeysLabels[i], "se-defensebar-digit", b);
                digit.style.position = Position.Absolute; digit.style.left = 3; digit.style.top = 1;
                var cost = UiKit.Text("", "se-defensebar-cost", b);
                cost.style.position = Position.Absolute; cost.style.left = 3; cost.style.bottom = 1;
                var lockIcon = new IconElement("lock", "se-defensebar-lock");
                lockIcon.style.position = Position.Absolute; lockIcon.style.right = 12; lockIcon.style.bottom = 3; lockIcon.style.width = 12; lockIcon.style.height = 12;
                b.Add(lockIcon);
                var tier = UiKit.Text("", "se-defensebar-tier", b);
                tier.style.position = Position.Absolute; tier.style.right = 2; tier.style.bottom = 1;
                button.Root = b; button.Icon = icon; button.Digit = digit; button.Cost = cost; button.Lock = lockIcon; button.TierLabel = tier;
                defenseBar.Add(b);
                defenseButtons.Add(button);
                if (key == "road")
                {
                    var divider = UiKit.El("se-defensebar-divider", defenseBar);
                    divider.style.width = 1; divider.style.height = 36; divider.style.marginRight = 4;
                }
            }
            defenseBar.style.display = DisplayStyle.None;
        }

        void ShowDefenseBar(bool on)
        {
            if (defenseBar == null) return;
            bool show = on && !session.Spectator && commandUiShown;
            var d = show ? DisplayStyle.Flex : DisplayStyle.None;
            if (defenseBar.style.display != d) defenseBar.style.display = d;
        }

        /// <summary>B: arm or disarm the bar (guarded so two callers in one frame cannot cancel each other).</summary>
        void ToggleDefenseBarArmed()
        {
            if (defenseBarToggleFrame == Time.frameCount || session.Spectator) return;
            defenseBarToggleFrame = Time.frameCount;
            SetDefenseBarArmed(!defenseBarArmed);
        }

        void SetDefenseBarArmed(bool on)
        {
            defenseBarArmed = on && defenseBar != null && !session.Spectator;
            defenseBarArmedUntil = Time.unscaledTime + 2.5f;
            defenseBar?.EnableInClassList("se-defensebar--armed", defenseBarArmed);
        }

        void DefenseBarKeys()
        {
            for (int i = 0; i < DefenseBarOrder.Length; i++)
            {
                bool pressed = i < 9 ? DigitPressed(i + 1) : i == 9 ? DigitPressed(0) : InputFacade.Pressed(KeyCode.Minus) || InputFacade.Pressed(KeyCode.KeypadMinus);
                if (!pressed) continue;
                digitFrame = Time.frameCount;
                SetDefenseBarArmed(false);
                PickDefense(DefenseBarOrder[i]);
                return;
            }
        }

        /// <summary>"165 Materials · 45 Energy" (zero parts omitted).</summary>
        static string CmdCostText(JToken cost)
        {
            if (!(cost is JObject o)) return "";
            var parts = new List<string>();
            foreach (var p in o.Properties())
            {
                int amount = Mathf.RoundToInt(ProtocolDecoder.Float(p.Value));
                if (amount > 0) parts.Add($"{amount} {(p.Name == "materials" ? "Materials" : p.Name == "energy" ? "Energy" : p.Name)}");
            }
            return string.Join(" · ", parts);
        }

        int DefenseTier(string key) => key == "trench" || key == "road" ? 1 : ProtocolDecoder.Int(Defs?["BUILDINGS"]?[key]?["tier"], 1);

        bool DefenseActive(string key)
        {
            if (key == "trench") return commander.Current == Commander.Mode.Trench;
            if (key == "road") return commander.Current == Commander.Mode.Road;
            return commander.Current == Commander.Mode.Target && ProtocolDecoder.Str(commander.TargetCommand?["c"]) == "fieldBuild" && commander.Option == key;
        }

        void PickDefense(string key)
        {
            if (session.Spectator) return;
            if (DefenseActive(key)) { commander.Cancel(); return; }
            int tier = DefenseTier(key);
            if (tier > Age + 1) { commander.Say($"{DefenseName(key)} requires Tier {Tier(tier)}", false, Time.unscaledTime); return; }
            var cost = DefenseCost(key);
            string shortfall = Shortfall(cost);
            if (shortfall != null) { commander.Say(shortfall, false, Time.unscaledTime); return; }
            CloseWheel();
            if (key == "trench") commander.BeginTrench();
            else if (key == "road") commander.BeginRoad();
            else commander.BeginFieldConstruction(key);
        }

        string DefenseName(string key) => key == "trench" ? "Trench" : key == "road" ? "Road" : NameOf("BUILDINGS", key);

        // read-only cost tokens for the two tools without a definition (shared: never mutate them)
        static readonly JObject TrenchCost = new JObject { ["materials"] = 35 }, RoadCost = new JObject { ["materials"] = 15 };

        JToken DefenseCost(string key) =>
            key == "trench" ? TrenchCost : key == "road" ? RoadCost : Defs?["BUILDINGS"]?[key]?["cost"];

        string DefenseTooltip(string key)
        {
            if (key == "trench") return "Trench · 35 Materials per segment\nDrag across clear, visible ground and release to dig. Infantry inside gain directional protection.";
            if (key == "road") return "Road · 15 Materials per link\nDrag a route between visible locations and release to build.";
            var d = Defs?["BUILDINGS"]?[key];
            int tier = ProtocolDecoder.Int(d?["tier"], 1);
            string text = $"{NameOf("BUILDINGS", key)} · {CmdCostText(d?["cost"])} · {ProtocolDecoder.Int(d?["time"])} s\n" +
                ProtocolDecoder.Str(d?["desc"], "Field defense. Place it on visible, clear ground; engineers help automatically.").Replace(" Q / E rotates before placement.", "") + " Q/E rotate.";
            if (tier > Age + 1) text += $" Requires Tier {Tier(tier)}.";
            return text;
        }

        void UpdateDefenseBar(float time)
        {
            if (defenseBar == null || defenseBar.style.display == DisplayStyle.None) return;
            if (defenseBarArmed && time > defenseBarArmedUntil) SetDefenseBarArmed(false);
            bool slow = time >= defenseBarRefreshAt;
            if (slow) { defenseBarRefreshAt = time + .1f; defenseLabelsSetting = App.GameSettings.DefenseBarHotkeyLabels; }   // a PlayerPrefs read (and key string) per call
            bool labels = defenseBarArmed || defenseLabelsSetting;
            // what the player acts on (hotkey labels, the active tool) is per frame; costs, locks and tooltips
            // follow the economy and refresh at 10 Hz (the tooltip text only when the tier or definitions change)
            int age = Age;
            bool tipsStale = age != defenseTipAge || !ReferenceEquals(Defs, defenseTipDefs);
            if (tipsStale) { defenseTipAge = age; defenseTipDefs = Defs; }
            string command = commander.Current == Commander.Mode.Target ? ProtocolDecoder.Str(commander.TargetCommand?["c"]) : null;
            var visibility = labels ? Visibility.Visible : Visibility.Hidden;
            foreach (var button in defenseButtons)
            {
                if (button.Digit.style.visibility != visibility) button.Digit.style.visibility = visibility;
                string key = button.Key;
                bool active = key == "trench" ? commander.Current == Commander.Mode.Trench : key == "road" ? commander.Current == Commander.Mode.Road
                    : command == "fieldBuild" && commander.Option == key;
                button.Root.EnableInClassList("selected", active);
                if (!slow && !tipsStale) continue;
                int tier = DefenseTier(key);
                bool locked = tier > age + 1;
                var cost = DefenseCost(key);
                int materials = Mathf.RoundToInt(ProtocolDecoder.Float(cost?["materials"]));
                if (button.ShownCost != materials) { button.ShownCost = materials; button.Cost.text = materials.ToString(); }
                button.Cost.EnableInClassList("se-cmd-short", Shortfall(cost) != null);
                var lockDisplay = locked ? DisplayStyle.Flex : DisplayStyle.None;
                if (button.Lock.style.display != lockDisplay) button.Lock.style.display = lockDisplay;
                if (button.TierLabel.style.display != lockDisplay) button.TierLabel.style.display = lockDisplay;
                if (locked) button.TierLabel.text = Tier(tier);
                button.Icon.style.opacity = locked ? .4f : 1f;
                button.Root.EnableInClassList("se-defensebar-btn--disabled", locked);
                if (tipsStale)
                {
                    string tip = DefenseTooltip(key);
                    if (tip != button.Tooltip) { button.Tooltip = tip; button.Root.tooltip = tip; }
                }
            }
        }

        float defenseBarRefreshAt;
        bool defenseLabelsSetting;
        int defenseTipAge = int.MinValue;
        JObject defenseTipDefs;

        // ------------------------------------------------------------------ tool chip + cursor reason
        void BuildToolChip()
        {
            toolChip = UiKit.El("se-cmd-toolchip", root);
            toolChip.style.position = Position.Absolute;
            toolChip.style.bottom = 88; toolChip.style.height = 40;
            toolChip.style.left = Length.Percent(50); toolChip.style.width = 420; toolChip.style.marginLeft = -210;
            toolChip.style.flexDirection = FlexDirection.Row; toolChip.style.alignItems = Align.Center;
            toolChipIcon = new IconElement("", "se-cmd-toolchip-icon");
            toolChipIcon.style.width = 20; toolChipIcon.style.height = 20; toolChipIcon.style.flexShrink = 0;
            toolChip.Add(toolChipIcon);
            toolChipName = UiKit.Text("", "se-cmd-toolchip-name", toolChip);
            toolChipName.style.flexGrow = 1; toolChipName.style.flexShrink = 1; toolChipName.style.overflow = Overflow.Hidden;
            toolChipName.style.textOverflow = TextOverflow.Ellipsis; toolChipName.style.whiteSpace = WhiteSpace.NoWrap;
            toolChipCost = UiKit.Text("", "se-cmd-toolchip-cost", toolChip);
            toolChipCost.style.flexShrink = 0;
            toolChipKeys = UiKit.El("se-cmd-toolchip-keys", toolChip);
            toolChipKeys.style.flexDirection = FlexDirection.Row; toolChipKeys.style.flexShrink = 0;
            UiKit.Text("Q", "se-cmd-keycap", toolChipKeys);
            UiKit.Text("E", "se-cmd-keycap", toolChipKeys);
            UiKit.Text("rotate", "se-cmd-toolchip-cost", toolChipKeys);
            var close = UiKit.IconButton("close", () => commander.Cancel(), "Cancel (Esc)", toolChip, 28);
            close.style.flexShrink = 0;
            toolChip.style.display = DisplayStyle.None;
            cursorReason = UiKit.Text("", "se-cmd-cursor-reason", root);
            cursorReason.pickingMode = PickingMode.Ignore;
            cursorReason.style.position = Position.Absolute; cursorReason.style.whiteSpace = WhiteSpace.NoWrap;
            cursorReason.style.left = 0; cursorReason.style.top = 0;
            cursorReason.style.display = DisplayStyle.None;
        }

        void UpdateToolChip(Vector2 pointer)
        {
            if (toolChip == null) return;
            bool tool = commander.Current != Commander.Mode.Select && !session.Spectator;
            toolChip.style.display = tool ? DisplayStyle.Flex : DisplayStyle.None;
            string command = ProtocolDecoder.Str(commander.TargetCommand?["c"]);
            bool fieldBuild = tool && commander.Current == Commander.Mode.Target && command == "fieldBuild";
            if (tool)
            {
                // the signature parts are compared in place (no per-frame string while a tool runs)
                string chipAbility = ProtocolDecoder.Str(commander.TargetCommand?["ability"]), chipMission = ProtocolDecoder.Str(commander.TargetCommand?["mission"]);
                if (toolChipSignature != "set" || toolChipMode != commander.Current || toolChipOption != commander.Option || toolChipCommand != command
                    || toolChipAbility != chipAbility || toolChipMission != chipMission || toolChipTarget != commander.TargetCommand)
                {
                    toolChipSignature = "set";
                    toolChipMode = commander.Current; toolChipOption = commander.Option; toolChipCommand = command;
                    toolChipAbility = chipAbility; toolChipMission = chipMission; toolChipTarget = commander.TargetCommand;
                    string icon, title, cost = "";
                    switch (commander.Current)
                    {
                        case Commander.Mode.Road: icon = "road"; title = "Build a road"; cost = "15 Materials / link"; break;
                        case Commander.Mode.Trench: icon = "trench"; title = "Draw a trench"; cost = "35 Materials / segment"; break;
                        case Commander.Mode.Rally: icon = "rally"; title = "Set rally point"; break;
                        case Commander.Mode.Place: icon = Icons.BuildingKind(commander.Option); title = NameOf("BUILDINGS", commander.Option); cost = CmdCostText(Defs?["BUILDINGS"]?[commander.Option]?["cost"]); break;
                        default:
                            if (command == "fieldBuild") { icon = Icons.BuildingKind(commander.Option); title = NameOf("BUILDINGS", commander.Option); cost = CmdCostText(Defs?["BUILDINGS"]?[commander.Option]?["cost"]); }
                            else if (command == "move") { bool attack = ProtocolDecoder.Bool(commander.TargetCommand?["attackMove"]); icon = attack ? "attack_move" : "move"; title = attack ? "Attack-move" : "Move"; }
                            else if (command == "ability") { string key = ProtocolDecoder.Str(commander.TargetCommand?["ability"]); icon = AbilityGlyph(key); title = ProtocolDecoder.Str(Defs?["ABILITIES"]?[key]?["name"], "Use ability"); }
                            else if (command == "airMission") { string mission = ProtocolDecoder.Str(commander.TargetCommand?["mission"], ""); icon = "airfield"; title = mission.Length > 0 ? char.ToUpperInvariant(mission[0]) + mission.Substring(1) : "Air mission"; }
                            else if (command == "missileLaunch") { icon = "missile_launch"; title = "Strategic missile target"; }
                            else { icon = "target"; title = "Choose a target"; }
                            break;
                    }
                    toolChipIcon.Kind = icon;
                    toolChipName.text = title;
                    toolChipCost.text = cost;
                    toolChipCost.style.display = cost.Length > 0 ? DisplayStyle.Flex : DisplayStyle.None;
                    toolChipKeys.style.display = fieldBuild ? DisplayStyle.Flex : DisplayStyle.None;
                }
            }
            else toolChipSignature = "";
            // the invalid placement reason sits at the cursor, only while invalid
            string reason = commander.FieldPreviewReason ?? "";
            bool invalid = fieldBuild && commander.FieldPreviewParcel != null && !commander.FieldPreviewValid && reason.Length > 0 && !reason.StartsWith("Checking");
            if (invalid && !IsPointerOverUi(InputFacade.MousePosition))
            {
                if (cursorReason.text != reason) cursorReason.text = reason;
                // follows the cursor: translate only (no layout pass per frame)
                var at = new Vector2(pointer.x + 18, pointer.y + 14);
                if (!((at - cursorReasonAt).sqrMagnitude <= .0025f)) { cursorReasonAt = at; cursorReason.style.translate = new Translate(at.x, at.y); }
                cursorReason.style.display = DisplayStyle.Flex;
            }
            else cursorReason.style.display = DisplayStyle.None;
        }
    }
}
