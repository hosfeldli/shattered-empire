using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Input;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Direct order keys (workstream H, 2026-11-16): attack move on F in both camera schemes since 2026-11-17
    /// (selection; twice: every combat unit on screen; Ctrl: whole army), stances cycled with S / V, rally points that carry an action, and the crossed-out cursor over
    /// ground the selected units cannot reach. The HUD's selection panel calls the same public methods,
    /// so a button and its key always do the same thing.
    /// </summary>
    public sealed partial class Commander
    {
        /// <summary>Who an attack move is for: the selection, every combat unit on screen, or the whole army.</summary>
        public enum AttackScope { Selection, Local, All }

        /// <summary>The stances V cycles through, in order (server values for <c>{c:'stance'}</c>).</summary>
        public static readonly string[] Stances = { "aggressive", "defensive", "holdFire" };

        /// <summary>A stance as the interface writes it ("Hold fire").</summary>
        public static string StanceLabel(string stance)
        {
            switch (stance)
            {
                case "aggressive": return "Aggressive";
                case "defensive": return "Defensive";
                case "holdFire": case "hold_fire": case "passive": return "Hold fire";
                case "hold": return "Hold";
                case null: case "": return "—";
                default: return "Mixed";
            }
        }

        /// <summary>
        /// Raised once per order the player gives, with its kind and map point, for markers and sounds.
        /// Kinds: "move", "attackMove", "attack", "capture", "collect", "deploy", "rally", "rallyAttackMove".
        /// </summary>
        public event Action<string, Vector3> OrderIssued;

        /// <summary>Raised after a stance change is sent, with the stance (for the selection panel).</summary>
        public event Action<string> StanceChanged;

        /// <summary>True while the next map click gives an attack move (F, or the selection panel button).</summary>
        public bool AttackMoveArmed => Current == Mode.Target && TargetCommand != null
            && ProtocolDecoder.Str(TargetCommand["c"]) == "move" && ProtocolDecoder.Bool(TargetCommand["attackMove"]);

        /// <summary>True while the next map click sets an attack-move rally point (F with production selected).</summary>
        public bool RallyAttackMoveArmed => Current == Mode.Rally && Option == "attackMove";

        /// <summary>True while the cursor is over ground the selected ground units cannot reach (the cursor is crossed out).</summary>
        public bool TargetImpassable { get; private set; }

        // stances we sent, per unit (the action snapshot does not carry stance yet)
        readonly Dictionary<int, string> sentStance = new Dictionary<int, string>();
        float lastAttackKey = -10f;

        /// <summary>Production (buildings or a base) is selected without units: F and right-click set rally points.</summary>
        bool RallyCapable => units.Selected.Count == 0 && (SelectedBuildings.Count > 0 || SelectedObjective > 0);

        /// <summary>
        /// Arm an attack move: the next map click sends it (Shift keeps it armed for more). Local and All first
        /// select every combat unit on screen or in the army. Returns false when no unit can take the order.
        /// </summary>
        public bool ArmAttackMove(AttackScope scope = AttackScope.Selection)
        {
            if (session.Spectator || !session.Ready) return false;
            if (scope != AttackScope.Selection && SelectCombatUnits(scope == AttackScope.Local) == 0)
            {
                Say(scope == AttackScope.Local ? "No combat units on screen" : "No combat units", false, Time.unscaledTime);
                return false;
            }
            if (units.Selected.Count == 0) return false;
            Begin(Mode.Target, "", new JObject { ["c"] = "move", ["units"] = "@units", ["tile"] = "@map", ["attackMove"] = true });
            return true;
        }

        /// <summary>Arm an attack-move rally point for the selected production (the next map click sets it).</summary>
        public bool ArmRallyAttackMove()
        {
            if (session.Spectator || !RallyCapable) return false;
            Begin(Mode.Rally, "attackMove");
            return true;
        }

        /// <summary>Select every combat unit we own, on screen only or everywhere. Returns the count.</summary>
        public int SelectCombatUnits(bool onScreenOnly)
        {
            units.Selected.Clear(); SelectedBuildings.Clear(); SelectedCity = -1;
            SelectedObjective = SelectedPickup = SelectedRingSlot = 0; ClearRingPreview();
            var st = session.Units;
            for (int s = 0; s < st.SlotCount; s++)
            {
                ref var u = ref st.Records[s];
                if (!u.InUse || u.Owner != session.CivId || (u.Flags & AutoEngineerFlag) != 0 || !IsCombatType(u.TypeIndex)) continue;
                if (onScreenOnly && !(ScreenOf(s, out var sp) && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height)) continue;
                units.Selected.Add(u.Id);
            }
            SelectionChanged?.Invoke();
            return units.Selected.Count;
        }

        JToken UnitDef(int typeIndex) => session.Defs?["UNITS"]?[session.Units.Types.Name(typeIndex)];

        /// <summary>Armed and not defensive-only (engineers and unarmed support stay out of attack moves).</summary>
        bool IsCombatType(int typeIndex)
        {
            var d = UnitDef(typeIndex);
            if (d == null) return true;
            if (ProtocolDecoder.Bool(d["defensiveOnly"]) || ProtocolDecoder.Bool(d["civilian"])) return false;
            return !string.IsNullOrEmpty(ProtocolDecoder.Str(d["weapon"])) || ProtocolDecoder.Float(d["atk"]) > 0;
        }

        // ------------------------------------------------------------------ stances
        /// <summary>The selection's stance (as last sent), "mixed" when units differ, or null with nothing selected.</summary>
        public string SelectionStance
        {
            get
            {
                string common = null;
                foreach (int id in units.Selected)
                {
                    string s = StanceOf(id);   // server value when the snapshot carries it (F, Commander.Markers.cs)
                    if (common == null) common = s;
                    else if (common != s) return "mixed";
                }
                return common;
            }
        }

        /// <summary>What a unit we haven't given a stance is assumed to use (the server default).</summary>
        public static string DefaultStance = "defensive";   // actionOrders.js stanceOf: defensive unless told otherwise

        /// <summary>Set the selected units' stance and tell the server.</summary>
        public void SetStance(string stance)
        {
            if (session.Spectator || units.Selected.Count == 0 || string.IsNullOrEmpty(stance)) return;
            var ids = units.Selected.ToArray();
            var before = new Dictionary<int, string>();
            foreach (int id in ids) { if (sentStance.TryGetValue(id, out var old)) before[id] = old; sentStance[id] = stance; }
            if (sentStance.Count > 4096) foreach (var gone in sentStance.Keys.Where(id => !session.Units.SlotOf.ContainsKey(id)).ToList()) sentStance.Remove(gone);
            StanceChanged?.Invoke(stance);
            session.Net?.Command(new JObject { ["c"] = "stance", ["units"] = new JArray(ids), ["stance"] = stance }, r =>
            {
                if (r.Error == null) { Say("Stance: " + StanceLabel(stance), true, Time.unscaledTime); return; }
                // refused: put back what we believed before
                foreach (int id in ids) { if (before.TryGetValue(id, out var old)) sentStance[id] = old; else sentStance.Remove(id); }
                Say(r.Error, false, Time.unscaledTime);
                StanceChanged?.Invoke(SelectionStance);
            });
        }

        /// <summary>V (and the selection panel's Stance button): aggressive → defensive → hold fire → aggressive.</summary>
        public void CycleStance()
        {
            string now = SelectionStance;
            int i = Array.IndexOf(Stances, now);
            SetStance(Stances[i < 0 ? 0 : (i + 1) % Stances.Length]);
        }

        // ------------------------------------------------------------------ keys (called every frame before the mode switch)
        void OrderKeys(float time, bool overUi)
        {
            UpdateTargetCursor(overUi);
            if (session.Spectator || lineDrag) return;   // F flips a battle line while one is drawn
            bool selectLike = Current == Mode.Select || AttackMoveArmed || RallyAttackMoveArmed;
            if (!selectLike) return;
            if (InputFacade.Action("attack"))
            {
                bool doubleTap = time - lastAttackKey < 0.35f;
                lastAttackKey = time;
                if (InputFacade.Ctrl) ArmAttackMove(AttackScope.All);
                else if (doubleTap && !RallyAttackMoveArmed) ArmAttackMove(AttackScope.Local);
                else if (units.Selected.Count > 0) ArmAttackMove(AttackScope.Selection);
                else if (RallyCapable) ArmRallyAttackMove();
                else ArmAttackMove(AttackScope.Local);
            }
            if (Current == Mode.Select && units.Selected.Count > 0 && InputFacade.Action("stance")) CycleStance();
        }

        /// <summary>A map click while attack move is armed: the order, its red marker, and the event.</summary>
        void IssueAttackMove(int tile, float time)
        {
            if (units.Selected.Count == 0 || session.Spectator) return;
            var g = session.World.Grid;
            Vector3 point = cam.TryGround(InputFacade.MousePosition, out var p) ? p
                : new Vector3(g.CenterX(tile), session.World.GroundHeight(g.CenterX(tile), g.CenterZ(tile)), g.CenterZ(tile));
            var cmd = new JObject { ["c"] = "move", ["units"] = new JArray(units.Selected.ToArray()), ["tile"] = tile, ["attackMove"] = true };
            if (session.ActionRts) { cmd["point"] = Point(point); cmd["queue"] = InputFacade.Shift; }
            DenseForestHint(tile, time);
            var order = new Order { MapPoint = point, Time = time, Kind = "attackMove" };
            Orders.Add(order);
            UI.Hud.NoteOrder(units.Selected, point, "attack", time);
            NoteIssued("attackMove", point);
            order.Rid = session.Net?.Command(cmd, r => { Resolve(order, r); if (r.Error == null) ActionMoveOrders++; }) ?? -1;
            if (session.Net == null) order.State = "accepted";
        }

        void NoteIssued(string kind, Vector3 point) { TrackOrderLegs(kind, point); OrderIssued?.Invoke(kind, point); }   // Commander.Waypoints.cs: the order chain

        // ------------------------------------------------------------------ impassable target cursor
        void UpdateTargetCursor(bool overUi)
        {
            bool aiming = !overUi && !session.Spectator && !cam.MouseRotating
                && (AttackMoveArmed || Current == Mode.Rally || (Current == Mode.Select && units.Selected.Count > 0 && !lineDrag));
            bool blocked = false;
            if (aiming && cam.TryGround(InputFacade.MousePosition, out var p))
                blocked = (Current == Mode.Rally || SelectionHasGround()) && (Impassable(p) || ReachBlocked(p));   // + server reach query (F, Commander.Markers.cs)
            TargetImpassable = blocked;
            UpdateContextCursor(overUi, aiming, blocked);   // the context cursor (Commander.Cursor.cs, C-D §39)
        }

        bool SelectionHasGround()
        {
            foreach (int id in units.Selected)
                if (session.Units.TryGet(id, out var u) && !ProtocolDecoder.Bool(UnitDef(u.TypeIndex)?["air"])) return true;
            return false;
        }

        /// <summary>
        /// Cheap client-side reachability: off the map, open water (sea or lake) without a road or bridge, and
        /// peaks are impassable to ground units. Unexplored hexes are never marked (we don't know them).
        /// The server stays the authority; this only changes the cursor.
        /// </summary>
        public bool Impassable(Vector3 mapPoint)
        {
            var w = session.World;
            if (w == null || !w.Ready) return false;
            int t = w.Grid.TileAt(mapPoint.x, mapPoint.z);
            if (t < 0) return true;
            if (t >= w.Known.Length || w.Known[t] == 0) return false;
            // HILLS_MOUNTAINS (2026-11-19): mountains (9) and peaks (10) are walls for every ground unit, road or not
            if (session.ActionRts && t < w.Terrain.Length && (w.Terrain[t] == 9 || w.Terrain[t] == 10)) return true;
            if (t < w.Road.Length && w.Road[t] != 0) return false;   // roads and bridges carry every vehicle
            float water = w.View.WaterLevel(mapPoint.x, mapPoint.z);
            if (water > TerrainView.NoWater * .5f && water > w.GroundHeight(mapPoint.x, mapPoint.z) + .01f) return true;
            if (t < w.Terrain.Length && (w.Terrain[t] == 0 || w.Terrain[t] == 1 || w.Terrain[t] == 10)) return true;   // deep, shallow, peak
            return false;
        }

        // The cursor images and SetOrderCursor / ResetOrderCursor moved to Commander.Cursor.cs (C-D §39 context cursors).

        float denseHintAt = -10f;

        /// <summary>
        /// §30 dense forest (2026-11-18): an immediate hint when a move order's target hex is dense forest off the road
        /// and the selection holds infantry-class units (def move "infantry": squads, engineers, special forces), which
        /// cannot pass it. The order is still sent (vehicles go; infantry halt, and the server's quiet "could not reach"
        /// note, surfaced by the HUD, follows later). At most one hint per 2 s.
        /// </summary>
        void DenseForestHint(int tile, float time)
        {
            var w = session.World;
            if (!session.ActionRts || tile < 0 || !w.IsDense(tile) || time - denseHintAt < 2f) return;
            if (tile >= w.Known.Length || w.Known[tile] == 0) return;   // VISION (2026-11-20): no hint about undiscovered ground
            if (w.Road != null && tile < w.Road.Length && (w.Road[tile] & 0xFFFFFF) != 0) return;   // a road through it stays open
            int infantry = 0, total = 0;
            foreach (int id in units.Selected)
            {
                if (!session.Units.TryGet(id, out var u)) continue;
                total++;
                if (ProtocolDecoder.Str(session.Defs?["UNITS"]?[session.Units.Types.Name(u.TypeIndex)]?["move"]) == "infantry") infantry++;
            }
            if (infantry == 0) return;
            denseHintAt = time;
            Say(infantry == total ? "Dense forest · infantry cannot pass it (tanks can clear it): they will halt at its edge"
                : "Dense forest · your infantry cannot pass it (tanks can clear it); the vehicles go on", false, time);
        }
    }
}
