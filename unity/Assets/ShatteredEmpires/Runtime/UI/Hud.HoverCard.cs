using System;
using SE.Core.Protocol;
using SE.Runtime.Input;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// The unit hover card (workstream F, mockup 2026-11-16): hovering any unit, friendly or enemy, shows its
    /// name, owner and team, a one-line role with what it is weak against, and its condition and stance (and
    /// fuel for aircraft once the snapshot carries it). One card, built once; the unit under the cursor is
    /// picked ten times a second; text changes only when the unit or its values change; the card follows the
    /// unit by translate (no layout pass).
    /// </summary>
    public sealed partial class Hud
    {
        /// <summary>
        /// Optional override of an aircraft's fuel, 0..255 (negative when unknown). By default the hover card reads
        /// <c>UnitStore.Record.Fuel</c> (decoded from the air snapshot, workstream D).
        /// </summary>
        public static Func<int, int> UnitFuel;

        VisualElement hoverCard, hoverDot;
        Label hoverName, hoverOwner, hoverRole, hoverStatus;
        int hoverId, hoverFilledFor = -1, hoverHp = -1, hoverFuel = int.MinValue;
        string hoverStance;
        float hoverPickAt, hoverCardSince;
        Vector2 hoverAt = new Vector2(float.NaN, float.NaN);
        bool hoverShown;

        void BuildHoverCard()
        {
            hoverCard = UiKit.Fx(El("se-hovercard", root), "se-fx--follow");   // fades and scales; its follow translate is never transitioned
            hoverCard.pickingMode = PickingMode.Ignore;
            hoverCard.style.left = 0; hoverCard.style.top = 0;
            hoverCard.usageHints = UsageHints.DynamicTransform;
            var head = El("se-hovercard-head", hoverCard);
            hoverName = L("", "se-hovercard-name", head);
            hoverDot = El("se-civ-dot se-hovercard-dot", head);
            hoverOwner = L("", "se-hovercard-owner", head);
            hoverRole = L("", "se-hovercard-role", hoverCard);
            hoverStatus = L("", "se-hovercard-status", hoverCard);
            foreach (var l in new[] { hoverName, hoverOwner, hoverRole, hoverStatus }) l.pickingMode = PickingMode.Ignore;
        }

        void HideHoverCard()
        {
            hoverId = 0;
            if (hoverCard != null && hoverShown) { hoverShown = false; UiKit.Hide(hoverCard); }
        }

        /// <summary>Per frame from <see cref="DrawBattleOverlay"/> (which has the projection).</summary>
        void UpdateHoverCard(Func<Vector3, Vector3> toScreen, Func<int, Vector3?> unitAt, float time)
        {
            if (hoverCard == null) BuildHoverCard();
            var mouse = InputFacade.MousePosition;
            // never while the pointer is on the interface, a box is being dragged or a button is held
            if (MenuVisible || PauseMenuOpen || commander.Dragging(out _) || InputFacade.LeftHeld || InputFacade.RightHeld || IsPointerOverUi(mouse))
            { HideHoverCard(); return; }
            if (time >= hoverPickAt)
            {
                hoverPickAt = time + .1f;
                int found = PickHoverUnit(toScreen, unitAt, mouse);
                if (found != hoverId) { hoverId = found; hoverCardSince = time; if (found == 0) HideHoverCard(); }
            }
            if (hoverId == 0 || !session.Units.TryGet(hoverId, out var u)) { HideHoverCard(); return; }
            if (time - hoverCardSince < .15f) return;   // a short settle so sweeping the cursor across an army doesn't flicker
            var at = unitAt(hoverId);
            if (at == null) { HideHoverCard(); return; }
            var sp = toScreen(at.Value + new Vector3(0, .3f, 0));
            if (sp.z <= 0) { HideHoverCard(); return; }
            FillHoverCard(u);
            if (!hoverShown) { hoverShown = true; hoverCard.BringToFront(); UiKit.Show(hoverCard); }
            var p = ToPanel(sp);
            float w = root.layout.width, h = root.layout.height;
            if (float.IsNaN(w) || w <= 0) { w = 1920; h = 1080; }
            // to the right of the unit and a little above it; flipped left near the right edge
            var pos = new Vector2(p.x + 26, p.y - 34);
            if (pos.x + 330 > w - 8) pos.x = p.x - 26 - 330;
            pos.y = Mathf.Clamp(pos.y, 48, h - 120);
            if (!((pos - hoverAt).sqrMagnitude <= .0025f)) { hoverAt = pos; hoverCard.style.translate = new Translate(pos.x, pos.y); }
        }

        /// <summary>The unit nearest the cursor within 18 px (screen), or 0.</summary>
        int PickHoverUnit(Func<Vector3, Vector3> toScreen, Func<int, Vector3?> unitAt, Vector2 mouse)
        {
            var store = session.Units;
            int best = 0;
            float bestD = 18f * 18f;
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse) continue;
                var at = unitAt(u.Id);
                if (at == null) continue;
                var sp = toScreen(at.Value + new Vector3(0, .1f, 0));
                if (sp.z <= 0) continue;
                float dx = sp.x - mouse.x, dy = sp.y - mouse.y, d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = u.Id; }
            }
            return best;
        }

        void FillHoverCard(in SE.Core.Units.UnitStore.Record u)
        {
            bool own = u.Owner == session.CivId && session.CivId >= 0;
            // the server sends every visible unit's stance (enemies too); without it only our own (as last sent) is known
            string stance = own || (session.ActionRts && u.Stance >= 0) ? commander.StanceOf(u.Id) : null;
            if (stance != null && (u.Flags & Session.Commander.HoldingFlag) != 0) stance = "hold";
            // own aircraft: fuel 0..255 from the air snapshot (D; -1 when not sent); UnitFuel overrides when wired
            int fuel = IsAircraft(u.TypeIndex) ? (UnitFuel != null ? UnitFuel(u.Id) : u.Fuel) : -1;
            if (hoverFilledFor == u.Id && hoverHp == u.Hp && hoverStance == stance && hoverFuel == fuel) return;
            string type = session.Units.Types.Name(u.TypeIndex);
            if (hoverFilledFor != u.Id)
            {
                hoverName.text = NameOf("UNITS", type);
                hoverOwner.text = OwnerLine(u.Owner);
                var rel = UiKit.RelationColor(session, u.Owner);
                hoverOwner.style.color = rel;
                hoverDot.style.backgroundColor = rel;
                hoverRole.text = UnitRole(type);
            }
            hoverFilledFor = u.Id; hoverHp = u.Hp; hoverStance = stance; hoverFuel = fuel;
            string status = $"Condition {u.Hp}%";
            if (stance != null) status += " · Stance: " + Session.Commander.StanceLabel(stance);
            if (fuel >= 0) status += $" · Fuel {Mathf.RoundToInt(fuel / 2.55f)}%";
            hoverStatus.text = status;
            hoverStatus.EnableInClassList("warn", u.Hp <= 60 && u.Hp > 30);
            hoverStatus.EnableInClassList("bad", u.Hp <= 30);
        }

        bool IsAircraft(int typeIndex) => ProtocolDecoder.Bool(Defs?["UNITS"]?[session.Units.Types.Name(typeIndex)]?["air"]);

        /// <summary>"You · Team A", "Player 2 · Team B" (no team letter in a free-for-all with one civ per team).</summary>
        string OwnerLine(int owner)
        {
            if (owner < 0) return "Neutral";
            int team = -1;
            string name = null;
            foreach (var c in session.Welcome?.Civs ?? Array.Empty<CivInfo>()) if (c.Id == owner) { team = c.Team; name = c.Name; }
            string who = owner == session.CivId ? "You" : name ?? "Unknown";
            return team >= 0 && team < 26 ? $"{who} · Team {(char)('A' + team)}" : who;
        }
    }
}
