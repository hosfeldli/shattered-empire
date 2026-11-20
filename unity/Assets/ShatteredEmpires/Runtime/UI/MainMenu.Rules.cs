using System;
using System.Globalization;
using SE.Runtime.Social;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    // Game creation settings (Ticket 4, server/sim/matchRules.js): the "Custom rules" block of New Skirmish, Watch AI
    // Match and the lobby host's rules (a custom starting stockpile; unit speed, range and health multipliers), and the
    // per-seat resource multiplier on every seat row. The server validates the same ranges and refuses anything else.
    public sealed partial class MainMenuView
    {
        static readonly string[] IncomeIds = Array.ConvertAll(MatchRulesOptions.IncomeSteps, v => v.ToString("0.##", CultureInfo.InvariantCulture));
        static readonly string[] IncomeNames = Array.ConvertAll(MatchRulesOptions.IncomeSteps, v => "Income " + MatchRulesOptions.Mult(v));

        static string IncomeId(float v)
        {
            int best = 0;
            for (int i = 1; i < MatchRulesOptions.IncomeSteps.Length; i++)
                if (Mathf.Abs(MatchRulesOptions.IncomeSteps[i] - v) < Mathf.Abs(MatchRulesOptions.IncomeSteps[best] - v)) best = i;
            return IncomeIds[best];
        }

        static float IncomeOf(string id) => float.TryParse(id, NumberStyles.Float, CultureInfo.InvariantCulture, out float v) ? v : 1f;

        /// <summary>A seat's resource multiplier as a cycle button (editable) or a chip (read only, shown only when not 1×).</summary>
        static void IncomeControl(VisualElement row, float income, bool editable, Action<float> set)
        {
            if (editable)
            {
                var b = Cycle(IncomeIds, IncomeNames, IncomeId(income), v => set(IncomeOf(v)), row,
                    "Resource multiplier: this player's income (headquarters, generators, processors, outposts) and cache pickups");
                b.AddToClassList("se-cycle--income");
            }
            else if (!Mathf.Approximately(income, 1f)) Line("Income " + MatchRulesOptions.Mult(income), "se-lobby-chip", row);
        }

        static string MultFormat(float v) => MatchRulesOptions.Mult(v);
        static float Snap(float v, float step = .05f) => Mathf.Round(v / step) * step;

        /// <summary>
        /// The custom-rules editor: a switch for a custom starting stockpile (two amount fields), then the unit speed,
        /// range and health sliders. <paramref name="changed"/> runs after every edit with the edited rules.
        /// </summary>
        VisualElement RulesEditor(MatchRulesOptions rules, Action<MatchRulesOptions> changed, VisualElement parent)
        {
            var box = Box("se-menu-rules-custom", parent);
            Line("Custom rules", "se-menu-label", box);
            Label summary = null;
            void Changed() { if (summary != null) summary.text = RulesSummaryText(rules); changed?.Invoke(rules); }

            // starting stockpile: the preset's amounts unless switched to custom amounts
            var startRow = Box("se-menu-row", box);
            Line("Custom starting stockpile", "se-menu-help-line se-menu-grow", startRow);
            VisualElement amounts = null;
            TextField mat = null, en = null;
            var sw = UiKit.Switch(rules.CustomStart, on =>
            {
                if (on) { if (rules.StartMaterials < 0) rules.StartMaterials = 500; if (rules.StartEnergy < 0) rules.StartEnergy = 100; }
                else { rules.StartMaterials = -1; rules.StartEnergy = -1; }
                if (amounts != null) amounts.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;
                SyncAmountFields();
                Changed();
            });
            startRow.Add(sw);
            amounts = Box("se-menu-row", box);
            amounts.style.display = rules.CustomStart ? DisplayStyle.Flex : DisplayStyle.None;
            TextField AmountField(string label, Func<int> get, Action<int> set, int max)
            {
                Line(label, "se-menu-help-line", amounts);
                var f = Field(Mathf.Max(0, get()).ToString(CultureInfo.InvariantCulture), amounts, "se-menu-rules-amount");
                f.maxLength = 5;
                f.tooltip = $"0 to {max:N0}";
                f.RegisterValueChangedCallback(e =>
                {
                    if (!int.TryParse((e.newValue ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int v)) return;
                    v = Mathf.Clamp(v, 0, max);
                    if (v == get()) return;
                    set(v);
                    Changed();
                });
                f.RegisterCallback<FocusOutEvent>(_ => f.SetValueWithoutNotify(Mathf.Max(0, get()).ToString(CultureInfo.InvariantCulture)));
                return f;
            }
            mat = AmountField("Materials", () => rules.StartMaterials, v => rules.StartMaterials = v, MatchRulesOptions.MaxMaterials);
            en = AmountField("Energy", () => rules.StartEnergy, v => rules.StartEnergy = v, MatchRulesOptions.MaxEnergy);
            void SyncAmountFields()
            {
                if (mat == null || en == null) return;
                mat.SetValueWithoutNotify(Mathf.Max(0, rules.StartMaterials).ToString(CultureInfo.InvariantCulture));
                en.SetValueWithoutNotify(Mathf.Max(0, rules.StartEnergy).ToString(CultureInfo.InvariantCulture));
            }

            // unit multipliers (applied on release, so a lobby sends one change per drag)
            UiKit.SettingRow("Unit speed", UiKit.SliderRow(rules.UnitSpeed, MatchRulesOptions.MinSpeed, MatchRulesOptions.MaxSpeed, v => MultFormat(Snap(v)),
                v => { rules.UnitSpeed = Snap(v); Changed(); }, true), box);
            UiKit.SettingRow("Unit range", UiKit.SliderRow(rules.UnitRange, MatchRulesOptions.MinRange, MatchRulesOptions.MaxRange, v => MultFormat(Snap(v)),
                v => { rules.UnitRange = Snap(v); Changed(); }, true), box);
            UiKit.SettingRow("Unit health", UiKit.SliderRow(rules.UnitHealth, MatchRulesOptions.MinHealth, MatchRulesOptions.MaxHealth, v => MultFormat(Snap(v)),
                v => { rules.UnitHealth = Snap(v); Changed(); }, true), box);
            summary = Line(RulesSummaryText(rules), "se-menu-help-line", box);
            UiKit.Button("Standard rules", () =>
            {
                var std = new MatchRulesOptions();
                rules.StartMaterials = std.StartMaterials; rules.StartEnergy = std.StartEnergy;
                rules.UnitSpeed = std.UnitSpeed; rules.UnitRange = std.UnitRange; rules.UnitHealth = std.UnitHealth;
                changed?.Invoke(rules);
                // rebuild in place so every control shows the standard values
                int at = parent.IndexOf(box);
                box.RemoveFromHierarchy();
                var fresh = RulesEditor(rules, changed, parent);
                if (at >= 0) { fresh.RemoveFromHierarchy(); parent.Insert(at, fresh); }
            }, box, "back", "se-menu-action").tooltip = "Back to the standard stockpile and unit statistics";
            return box;
        }

        static string RulesSummaryText(MatchRulesOptions r)
        {
            string s = r.Summary();
            return string.IsNullOrEmpty(s) ? "Standard rules: every unit as designed; the stockpile from Starting resources." :
                s + ". Every player and the AI play by these rules; the resource multiplier is set per seat.";
        }

        // ---- the lobby: the host edits, everyone sees the summary (and each seat's multiplier on its row)
        VisualElement lobbyRulesEditorHost;
        string lobbyRulesKey;

        /// <summary>Rebuild the lobby host's rules editor when the room's rules changed (not while the host drags).</summary>
        void SyncLobbyRulesEditor(MatchRoom r)
        {
            if (lobbyRulesEditorHost == null || r == null) return;
            string key = r.Rules?.ToString(Newtonsoft.Json.Formatting.None) ?? "{}";
            if (key == lobbyRulesKey) return;
            lobbyRulesKey = key;
            lobbyRulesEditorHost.Clear();
            RulesEditor(MatchRulesOptions.FromJson(r.Rules), next =>
            {
                lobbyRulesKey = next.ToJson().ToString(Newtonsoft.Json.Formatting.None);
                game.SendLobby(LobbyMessages.Rules(next.ToJson(true)));
            }, lobbyRulesEditorHost);
        }
    }
}
