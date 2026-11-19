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
            if (hoverId == 0 && BuildingHoverCard(toScreen, time)) return;   // no unit: the structure under the cursor (below)
            if (hoverId == 0 || !session.Units.TryGet(hoverId, out var u)) { HideHoverCard(); return; }
            hoverBuildingFilled = -1;
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

        // ---- structures (workstream B, 2026-11-18): with no unit under the cursor, the card names the structure the
        // commander's pick has under it (Commander.HoverBuildingId: the same footprint pick a click uses, so the card
        // never names something a click would not select). Text is rebuilt only when the structure or its values change.
        int hoverBuilding, hoverBuildingFilled = -1, hoverBuildingHp = -1, hoverBuildingLevel = -1, hoverBuildingProgress = -1;
        float hoverBuildingSince;

        /// <summary>The storm value the server's air rules read at a hex (0..1, grounded at .5; WeatherPresenter), or null.</summary>
        public static Func<int, float> StormAt;
        int stormHoverTile = -1; float stormHoverPickAt, stormHoverSince; bool stormHoverFilled;

        /// <summary>Over open ground under a storm: what the storm does to aircraft there (picked ten times a second).</summary>
        bool StormHoverCard(float time)
        {
            if (StormAt == null) return false;
            if (time >= stormHoverPickAt)
            {
                stormHoverPickAt = time + .1f;
                int t = commander.HoverTile();
                if (t >= 0 && StormAt(t) < .5f) t = -1;
                if (t != stormHoverTile) { stormHoverTile = t; stormHoverSince = time; }
            }
            if (stormHoverTile < 0 || time - stormHoverSince < .35f) return false;
            if (!stormHoverFilled || hoverFilledFor != -1 || hoverBuildingFilled != -1)   // a unit or building card was shown since
            {
                stormHoverFilled = true;
                hoverFilledFor = -1; hoverBuildingFilled = -1;
                hoverName.text = "Storm";
                hoverOwner.text = "Weather";
                hoverOwner.style.color = new Color(.70f, .66f, .95f);
                hoverDot.style.backgroundColor = new Color(.42f, .33f, .78f);
                hoverRole.text = "Aircraft cannot take off or land at bases under it";
                hoverStatus.text = "Aircraft inside fly slower and burn fuel faster";
            }
            if (!hoverShown) { hoverShown = true; hoverCard.BringToFront(); UiKit.Show(hoverCard); }
            var mouse = InputFacade.MousePosition;
            var p = ToPanel(new Vector3(mouse.x, mouse.y, 1));
            float w = root.layout.width, h = root.layout.height;
            if (float.IsNaN(w) || w <= 0) { w = 1920; h = 1080; }
            var pos = new Vector2(p.x + 24, p.y + 18);
            if (pos.x + 330 > w - 8) pos.x = p.x - 24 - 330;
            pos.y = Mathf.Clamp(pos.y, 48, h - 120);
            if (!((pos - hoverAt).sqrMagnitude <= .0025f)) { hoverAt = pos; hoverCard.style.translate = new Translate(pos.x, pos.y); }
            return true;
        }

        bool BuildingHoverCard(Func<Vector3, Vector3> toScreen, float time)
        {
            int id = commander.HoverBuildingId;
            if (id != hoverBuilding) { hoverBuilding = id; hoverBuildingSince = time; }
            if (id == 0 && StormHoverCard(time)) return true;
            stormHoverFilled = false;
            if (id == 0 || !session.Structures.Buildings.TryGetValue(id, out var b) || !b.HasPosition) { HideHoverCard(); return true; }
            if (time - hoverBuildingSince < .2f) { HideHoverCard(); return true; }
            var sp = toScreen(new Vector3(b.X, session.World.GroundHeight(b.X, b.Z) + .45f, b.Z));
            if (sp.z <= 0) { HideHoverCard(); return true; }
            FillBuildingHoverCard(b);
            if (!hoverShown) { hoverShown = true; hoverCard.BringToFront(); UiKit.Show(hoverCard); }
            var p = ToPanel(sp);
            float w = root.layout.width, h = root.layout.height;
            if (float.IsNaN(w) || w <= 0) { w = 1920; h = 1080; }
            var pos = new Vector2(p.x + 30, p.y - 40);
            if (pos.x + 330 > w - 8) pos.x = p.x - 30 - 330;
            pos.y = Mathf.Clamp(pos.y, 48, h - 120);
            if (!((pos - hoverAt).sqrMagnitude <= .0025f)) { hoverAt = pos; hoverCard.style.translate = new Translate(pos.x, pos.y); }
            return true;
        }

        void FillBuildingHoverCard(in BuildingRecord b)
        {
            int progress = b.Done ? 100 : b.Progress;
            if (hoverBuildingFilled == b.Id && hoverBuildingHp == b.Hp && hoverBuildingLevel == b.Level && hoverBuildingProgress == progress) return;
            hoverFilledFor = -1;   // the unit card refills when it is next shown
            if (hoverBuildingFilled != b.Id)
            {
                hoverName.text = NameOf("BUILDINGS", b.Type ?? "");
                hoverOwner.text = b.Memory ? OwnerLine(b.Owner) + " · last seen" : OwnerLine(b.Owner);
                var rel = UiKit.RelationColor(session, b.Owner);
                hoverOwner.style.color = rel;
                hoverDot.style.backgroundColor = rel;
                hoverRole.text = StructureRole(b.Type);
            }
            hoverBuildingFilled = b.Id; hoverBuildingHp = b.Hp; hoverBuildingLevel = b.Level; hoverBuildingProgress = progress;
            string status = b.Done ? $"Condition {b.Hp}%" : $"Under construction {progress}%";
            if (b.Done && b.Level > 1) status += $" · Level {b.Level}";
            hoverStatus.text = status;
            hoverStatus.EnableInClassList("warn", b.Done && b.Hp <= 60 && b.Hp > 30);
            hoverStatus.EnableInClassList("bad", b.Done && b.Hp <= 30);
        }

        /// <summary>A one-line role: what the structure is for and, for defenses, what it is good and weak against.</summary>
        string StructureRole(string type)
        {
            switch (type)
            {
                case "town": return "Headquarters · trains engineers, unlocks ring sites";
                case "barracks": case "camp": return "Trains infantry and scout buggies";
                case "motor_works": return "Builds armored cars, carriers and tanks";
                case "heavy_weapons": case "heavy_assembly": return "Builds artillery, missile vehicles and mobile AA";
                case "airfield": return "Builds and services aircraft";
                case "depot": return "Generates materials";
                case "power_plant": return "Generates energy";
                case "armory": return "Faction-wide upgrades";
                case "advanced_lab": return "Autonomous systems and specialist units";
                case "missile_silo": return "Strategic missiles";
                case "barricade": case "sandbags": return "Low cover · infantry fire over it";
                case "city_turret": return "MG turret · strong vs infantry, weak vs armor";
                case "guard_post": case "watchtower": return "MG watchtower · spots and claims ground";
                case "bunker": return "Bunker · holds against infantry and shellfire";
                case "turret": case "at_emplacement": return "Anti-armor gun · strong vs vehicles";
                case "aa_battery": return "Anti-air · engages aircraft only";
                case "artillery_post": return "Howitzer · long range, slow to traverse";
                case "fort": case "outpost": return "Outpost · heavy gun, claims ground";
                case "sensor_post": return "Radar · wide vision";
                case "repair_point": return "Repairs nearby vehicles";
                default:
                    var desc = ProtocolDecoder.Str(Defs?["BUILDINGS"]?[type ?? ""]?["desc"], "");
                    int stop = desc.IndexOf('.');
                    return stop > 0 ? desc.Substring(0, stop) : desc;
            }
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
