using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    public sealed partial class Commander
    {
        public int SelectedRingSlot { get; private set; }
        public int SelectedPickup { get; private set; }
        public string RingPreviewType { get; private set; }
        public BaseParcel? RingPreviewParcel { get; private set; }
        public BaseParcel? FieldPreviewParcel { get; private set; }
        public bool FieldPreviewValid { get; private set; }
        public float FieldYaw { get; private set; }
        public string FieldPreviewReason { get; private set; } = "Choose visible, clear terrain.";
        /// <summary>The price the server quoted for this spot (null until a preview answers): defenses outside the
        /// ring of influence cost more, with FieldPreviewNote saying why ("Outside your influence: ×3 cost").</summary>
        public JToken FieldPreviewCost { get; private set; }
        public string FieldPreviewNote { get; private set; }
        float fieldPreviewYaw;
        string fieldPreviewType;
        float fieldPreviewAt;
        Vector3 fieldPreviewPoint;
        int fieldPreviewToken;
        /// <summary>The New Base preview ring: (x, yaw, z) per parcel, from the server preview.</summary>
        readonly List<Vector3> newBaseRing = new List<Vector3>(8);

        // Ring of influence (server DEFENSE_INFLUENCE, BFS from every hex we own): while a defense is being placed,
        // the hexes where the surcharge starts are outlined in amber, so it is clear before the click where it costs more.
        int[] influenceDist = Array.Empty<int>();
        float influenceAt = -1f;
        public bool PlacingSurchargedDefense { get; private set; }
        /// <summary>Placing a structure priced by the ring of influence: the terrain draws the ring's edge at full strength (TerritoryField, 2026-11-18).</summary>
        public bool PlacingInfluencedStructure => PlacingDefense(out _);

        /// <summary>
        /// Placing a structure that may go on neutral ground with the ×3 surcharge beyond the ring of influence:
        /// defenses, and since W2 the <c>neutral</c> infrastructure (sensor post, forward repair station).
        /// </summary>
        bool PlacingDefense(out int reach)
        {
            reach = 8;
            if (Current != Mode.Target || ProtocolDecoder.Str(TargetCommand?["c"]) != "fieldBuild" || string.IsNullOrEmpty(Option)) return false;
            var influence = session.Defs?["RULESET"]?["influence"];
            var def = session.Defs?["BUILDINGS"]?[Option];
            if (influence == null || !(ProtocolDecoder.Bool(def?["defense"]) || ProtocolDecoder.Bool(def?["neutral"]))) return false;
            reach = ProtocolDecoder.Int(influence["reach"], 8);
            return true;
        }

        /// <summary>True when the structure type may also go on neutral ground (defenses and W2 neutral infrastructure).</summary>
        bool NeutralGroundAllowed(string type)
        {
            var def = session.Defs?["BUILDINGS"]?[type];
            return ProtocolDecoder.Bool(def?["defense"]) || ProtocolDecoder.Bool(def?["neutral"]);
        }

        /// <summary>
        /// A placement refusal as the ghost / cursor shows it (§14): the server's <c>code</c> (actionBases.PLACEMENT_REASONS,
        /// docs/gameplay-overhaul/CONSTRUCTION_DESIGN.md) as plain words; unknown codes fall back to the readable error.
        /// </summary>
        public string PlacementRefusal(string code, string error, string type)
        {
            switch (code)
            {
                case "hidden": return "Not in sight · scout neutral ground before building on it";
                case "territory":
                    if (!string.IsNullOrEmpty(error) && error.IndexOf("rotated footprint", StringComparison.OrdinalIgnoreCase) >= 0)
                        return "The rotated footprint crosses into another player's territory · rotate or move it";
                    return NeutralGroundAllowed(type) ? "Another player's territory · build on your land or neutral ground" : "Outside your territory · this goes on your own land only";
                case "base": return "Too close to a base · keep its command zone and approaches clear";
                case "pad": return "On a base building pad · keep the pads clear";
                case "trench": return "A trench already runs here";
                case "water": return "Water, a deep river or a bridge · structures need dry ground";
                case "slope": return "Too steep · choose level ground";
                case "blocked": return "Something is in the way · choose clear ground";
                case "enemy": return "Hostile troops contest this spot";
                case "influence": return "Not enough resources for the ×3 price outside your ring of influence" + FundsShortfall(type, true);
                // 2026-11-18: the snap rule moves most refusals to a valid hex nearby; these reach the player only when
                // no hex within RULESET.placementSnap of the cursor passes (or for codes that never snap)
                case "road":
                    if (IsNewBaseType(type)) return ReadableError(error, code);
                    return "On a road, with no clear ground beside it · defenses go beside roads (sandbag barricades may block one)";
                case "forest": return "Dense forest · engineers can't reach it: build at its edge or clear it first";
                case "funds": return "Not enough resources" + FundsShortfall(type, false) + " · structures are paid in full when placed";
                case "tech": return "Needs a higher base tier";
                default: return ReadableError(error, code);
            }
        }

        bool IsNewBaseType(string type) =>
            type != null && (type == ProtocolDecoder.Str(session.Defs?["RULESET"]?["newBase"]?["type"], "base_site") || ProtocolDecoder.Bool(session.Defs?["BUILDINGS"]?[type]?["newBase"]));

        /// <summary>" · need 40 more Materials" against the list price (×factor with <paramref name="surcharged"/>), or "".</summary>
        string FundsShortfall(string type, bool surcharged)
        {
            if (!(session.Defs?["BUILDINGS"]?[type]?["cost"] is JObject cost)) return "";
            float factor = surcharged ? ProtocolDecoder.Float(session.Defs?["RULESET"]?["influence"]?["factor"], 3f) : 1f;
            foreach (var p in cost.Properties())
            {
                int need = Mathf.CeilToInt(ProtocolDecoder.Float(p.Value) * factor) - ProtocolDecoder.Int(session.Econ?["res"]?[p.Name]);
                if (need > 0) return $" · need {need} more {(p.Name == "materials" ? "Materials" : p.Name == "energy" ? "Energy" : p.Name)}";
            }
            return "";
        }

        /// <summary>
        /// What the ghost says when the server moved the structure (placement <c>snapped</c>, its <c>reason</c> = the code
        /// that was resolved): the problem under the cursor, then where it will really go.
        /// </summary>
        public static string SnapNote(string reason) => reason switch
        {
            "road" => "On a road · will be placed beside it",
            "slope" => "Too steep · will be placed on level ground nearby",
            "blocked" => "Something is in the way · will be placed on clear ground nearby",
            "water" => "Water or a bridge · will be placed on dry ground nearby",
            "trench" => "A trench runs here · will be placed beside it",
            "pad" => "On a building pad · will be placed clear of the pads",
            "forest" => "Dense forest · will be placed at its edge",
            _ => "Will be placed on the nearest clear spot",
        };

        /// <summary>The toast after a snapped build ("Construction started · kept off the road").</summary>
        static string SnapDone(string reason) => reason switch
        {
            "road" => "kept off the road", "slope" => "moved to level ground", "blocked" => "moved to clear ground",
            "water" => "moved out of the water", "trench" => "moved off the trench", "pad" => "kept clear of the building pads",
            "forest" => "moved out of the dense forest", _ => "moved to the nearest clear spot",
        };

        void DrawInfluenceEdge(float time)
        {
            DrawPadHover(time);   // §12: the hovered pad of a base that is not selected (this runs once per frame with the overlays)
            DrawGarrisonExits(time);
            PlacingSurchargedDefense = false;
            if (!session.ActionRts || !PlacingDefense(out int reach)) return;
            var w = session.World;
            var g = w.Grid;
            var own = w.Owner;
            if (g == null || own == null || own.Length < g.N) return;
            if (influenceDist.Length != g.N || time >= influenceAt)
            {
                influenceAt = time + .5f;
                if (influenceDist.Length != g.N) influenceDist = new int[g.N];
                int cap = reach + 1;
                var queue = new Queue<int>();
                for (int i = 0; i < g.N; i++)
                {
                    if (own[i] == session.CivId) { influenceDist[i] = 0; queue.Enqueue(i); }
                    else influenceDist[i] = cap + 1;
                }
                while (queue.Count > 0)
                {
                    int t = queue.Dequeue(), d0 = influenceDist[t];
                    if (d0 >= cap) continue;
                    for (int k = 0; k < 6; k++)
                    {
                        int n = g.Neighbor(t, k);
                        if (n >= 0 && influenceDist[n] > d0 + 1) { influenceDist[n] = d0 + 1; queue.Enqueue(n); }
                    }
                }
            }
            float pulse = .5f + .5f * Mathf.Sin(time * 3f);
            // 2026-11-18: the ring's edge is drawn on the terrain in the territory border style (TerritoryField influence
            // texture, full strength while placing); the amber band of discs is gone
            bool near = FieldPreviewParcel.HasValue;
            // the hovered hex: amber when this spot pays the surcharge
            if (near)
            {
                int tile = FieldPreviewParcel.Value.Tile;
                if (tile >= 0 && tile < g.N && influenceDist[tile] > reach)
                {
                    PlacingSurchargedDefense = true;
                    float x = g.CenterX(tile), z = g.CenterZ(tile);
                    rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .05f, z)), 0, new float3(2.1f + .15f * pulse), new float4(1f, .55f, .15f, .95f)));
                }
            }
        }

        // ------------------------------------------------------------------ build-wheel placement preview (2026-11-18)
        // The ghost stands where the structure will really go. The server's fieldPreview answer is authoritative: a
        // refusal the ground can resolve (road, slope, blocked, water, trench, pad, forest) is snapped to the nearest valid
        // hex centre within RULESET.placementSnap hexes (CONSTRUCTION_DESIGN.md, snap rule), and the answer carries
        // `snapped`, `reason`, `tile`, `x`, `z`. Until it answers, a client mirror of the road rule (defenses other than the
        // sandbag barricade keep off roads) moves the ghost beside the road at once. A snapped answer holds the ghost
        // (magnetic) while the cursor stays within FieldHold of where it asked, and the last answer's colour is kept while
        // a new one is in flight (no red flicker while moving).

        /// <summary>True when the ghost was moved from the cursor (server snap, or the client's road estimate).</summary>
        public bool FieldPreviewSnapped { get; private set; }
        /// <summary>The refusal code under the cursor (null when it stands where asked and is valid).</summary>
        public string FieldPreviewCode { get; private set; }
        /// <summary>The server's answer is for the spot under the cursor (not an estimate, not the previous spot).</summary>
        public bool FieldPreviewFresh { get; private set; }
        /// <summary>The ground point under the cursor (the ghost may stand elsewhere when snapped).</summary>
        public Vector3 FieldPreviewCursor { get; private set; }

        bool fieldAnswered, fieldAnswerValid, fieldAnswerSnapped, fieldBuildInFlight;
        float fieldAnswerX, fieldAnswerZ, fieldAnswerYaw;
        string fieldAnswerType, fieldAnswerCode, fieldAnswerReason;
        Vector3 fieldAnswerPoint;
        int fieldAppliedToken, fieldToolSerial;
        const float FieldAsk = .035f;   // squared distance the cursor moves before the spot is asked again
        const float FieldHold = .6f;    // a snapped answer holds the ghost while the cursor stays this close to its spot

        // client road-snap estimate, cached per hovered spot (5 cm grid) / type / road revision: no per-frame work or garbage
        int snapKeyX = int.MinValue, snapKeyZ, snapKeyRoads = -1, snapTile = -1;
        string snapKeyType;
        bool snapOnRoad;
        readonly int[] snapHexes = new int[64];
        readonly long[] snapOrder = new long[64];

        /// <summary>Forget the answer and the tool's pending replies (Begin / Cancel, Commander.cs).</summary>
        void ResetFieldPreview()
        {
            fieldToolSerial++; fieldAnswered = false; fieldBuildInFlight = false; fieldPreviewType = null;
            FieldPreviewSnapped = false; FieldPreviewCode = null; FieldPreviewFresh = false; FieldPreviewCost = null; FieldPreviewNote = null;
            FieldPreviewReason = "Checking the footprint…";
        }

        void UpdateFieldPreview(float time, bool overUi)
        {
            cam.PlacementRotation = Current == Mode.Target && ProtocolDecoder.Str(TargetCommand?["c"]) == "fieldBuild";
            if (Current != Mode.Target || ProtocolDecoder.Str(TargetCommand?["c"]) != "fieldBuild" || overUi || !cam.TryGround(InputFacade.MousePosition, out var point))
            { FieldPreviewParcel = null; fieldPreviewType = null; FieldPreviewCost = null; FieldPreviewNote = null; FieldPreviewSnapped = false; FieldPreviewFresh = false; return; }
            if (InputFacade.Action("rotate_left")) FieldYaw -= Mathf.PI / 12;
            if (InputFacade.Action("rotate_right")) FieldYaw += Mathf.PI / 12;
            FieldYaw = Mathf.Atan2(Mathf.Sin(FieldYaw), Mathf.Cos(FieldYaw));
            var g = session.World.Grid;
            string type = Option;
            FieldPreviewCursor = point;

            bool sameAsk = fieldAnswered && fieldAnswerType == type && Mathf.Abs(FieldYaw - fieldAnswerYaw) <= .001f;
            float dx = g.DxWrap(fieldAnswerPoint.x, point.x), dz = point.z - fieldAnswerPoint.z, d2 = dx * dx + dz * dz;
            bool fresh = sameAsk && d2 <= FieldAsk;
            bool hold = sameAsk && fieldAnswerValid && fieldAnswerSnapped && d2 <= FieldHold * FieldHold;
            float gx = point.x, gz = point.z;
            bool valid, snapped = false;
            string code, reason;
            if (fresh || hold)
            {
                valid = fieldAnswerValid; code = fieldAnswerCode; reason = fieldAnswerReason;
                if (valid && fieldAnswerSnapped) { gx = g.NearX(fieldAnswerX, point.x); gz = fieldAnswerZ; snapped = true; }
            }
            else if (RoadSnapEstimate(type, point, out int beside))
            {
                // waiting for the server, the cursor on a road: mirror the rule (the nearest hex centre off the road)
                code = "road";
                if (beside >= 0) { valid = true; snapped = true; gx = g.NearX(g.CenterX(beside), point.x); gz = g.CenterZ(beside); reason = SnapNote("road"); }
                else { valid = false; reason = PlacementRefusal("road", null, type); }
            }
            else
            {
                // waiting for the server: keep the last answer's colour and words
                valid = !sameAsk || fieldAnswerValid;
                code = valid ? null : fieldAnswerCode;
                reason = valid ? "Checking the footprint…" : fieldAnswerReason;
            }
            FieldPreviewParcel = new BaseParcel { Tile = g.TileAt(gx, gz), X = gx, Z = gz, Yaw = FieldYaw, Width = .9f, Depth = .9f };
            FieldPreviewValid = valid; FieldPreviewSnapped = snapped; FieldPreviewCode = code; FieldPreviewReason = reason; FieldPreviewFresh = fresh;
            if (!fresh && !hold && newBaseRing.Count > 0) newBaseRing.Clear();

            bool changed = fieldPreviewType != type || (point - fieldPreviewPoint).sqrMagnitude > FieldAsk || Mathf.Abs(FieldYaw - fieldPreviewYaw) > .001f;
            if (!changed || time < fieldPreviewAt) return;
            fieldPreviewAt = time + .12f; fieldPreviewType = type; fieldPreviewPoint = point; fieldPreviewYaw = FieldYaw;
            // every answer newer than the last one applied is used (a reply that only lags the cursor still updates it)
            int token = ++fieldPreviewToken, serial = fieldToolSerial;
            var asked = point;
            float askedYaw = FieldYaw;
            session.Net?.Command(new JObject { ["c"] = "fieldPreview", ["type"] = type, ["point"] = Point(point), ["yaw"] = FieldYaw }, r =>
            {
                if (serial != fieldToolSerial || token <= fieldAppliedToken || Current != Mode.Target) return;
                fieldAppliedToken = token;
                var placement = r.Raw?["placement"];
                fieldAnswered = true; fieldAnswerType = type; fieldAnswerPoint = asked; fieldAnswerYaw = askedYaw;
                fieldAnswerValid = r.Error == null && ProtocolDecoder.Bool(placement?["valid"]);
                fieldAnswerSnapped = fieldAnswerValid && ProtocolDecoder.Bool(placement?["snapped"]);
                fieldAnswerX = ProtocolDecoder.Float(placement?["x"], asked.x); fieldAnswerZ = ProtocolDecoder.Float(placement?["z"], asked.z);
                fieldAnswerCode = r.Error != null ? r.ErrorCode : fieldAnswerSnapped ? ProtocolDecoder.Str(placement?["reason"], ProtocolDecoder.Str(placement?["from"], null)) : null;
                FieldPreviewCost = placement?["cost"];
                FieldPreviewNote = ProtocolDecoder.Str(placement?["note"], null);
                // W2 refusal codes (§14) label the ghost: hidden, territory, base, pad, trench, water, slope, blocked, enemy,
                // influence, funds, road …; a snapped answer says what was wrong under the cursor and where it will go
                fieldAnswerReason = r.Error != null ? PlacementRefusal(r.ErrorCode, r.Error, type)
                    : fieldAnswerSnapped ? SnapNote(fieldAnswerCode) : "Valid footprint · Click to begin construction";
                // a New Base preview answers with its eight-parcel ring ([tile, x, z, yaw] each): drawn while placing
                newBaseRing.Clear();
                if (fieldAnswerValid && placement?["parcels"] is JArray ring)
                    foreach (var t in ring) if (t is JArray q && q.Count >= 4) newBaseRing.Add(new Vector3(ProtocolDecoder.Float(q[1]), ProtocolDecoder.Float(q[3]), ProtocolDecoder.Float(q[2])));
            });
        }

        /// <summary>
        /// A click with a build-wheel structure armed (PointMode, Commander.cs). The cursor point is sent: the server
        /// runs the same snap as its preview, so the structure lands where the ghost stood. Refused locally only when
        /// the answer for this very spot is a refusal nothing nearby resolves. Shift places several (the tool stays and
        /// the next spot is asked afresh, so a second click on the same spot snaps beside the first); without Shift the
        /// tool ends when the server accepts, and stays armed (with the reason) when it refuses.
        /// </summary>
        void FieldBuildClick(float time)
        {
            if (FieldPreviewParcel == null || TargetCommand == null) return;
            bool keep = InputFacade.Shift;
            if (fieldBuildInFlight && !keep) return;   // one placement in flight; its reply ends the tool
            if (FieldPreviewFresh && !FieldPreviewValid) { Say(FieldPreviewReason, false, time); return; }
            var cmd = (JObject)TargetCommand.DeepClone();
            var p = FieldPreviewCursor;
            Bind(cmd, session.World.Grid.TileAt(p.x, p.z));
            cmd["point"] = Point(p);
            cmd["yaw"] = FieldYaw;
            int serial = fieldToolSerial;
            string type = Option;
            if (session.Net == null) return;
            fieldBuildInFlight = !keep;
            session.Net.Command(cmd, r =>
            {
                if (serial == fieldToolSerial) fieldBuildInFlight = false;
                if (r.Error != null) { Say(PlacementRefusal(r.ErrorCode, r.Error, type), false, Time.unscaledTime); return; }
                bool moved = ProtocolDecoder.Bool(r.Raw?["snapped"]) || ProtocolDecoder.Bool(r.Raw?["placement"]?["snapped"]);
                string why = ProtocolDecoder.Str(r.Raw?["reason"], ProtocolDecoder.Str(r.Raw?["placement"]?["reason"], null));
                Say(moved ? "Construction started · " + SnapDone(why) : "Construction started", true, Time.unscaledTime);
                if (!keep && serial == fieldToolSerial && Current == Mode.Target) Cancel();
            });
            // the spot just used is taken now: ask again (with Shift the next click there snaps beside it)
            fieldAnswered = false; fieldPreviewType = null;
        }

        /// <summary>True for structures the road rule keeps off roads: every defense but the sandbag barricade.</summary>
        bool RoadRuleApplies(string type)
        {
            var def = session.Defs?["BUILDINGS"]?[type];
            return def != null && type != "barricade" && ProtocolDecoder.Bool(def["defense"]) && !IsNewBaseType(type);
        }

        /// <summary>
        /// The client's estimate of the road rule (server actionBases.onRoad + the snap rule) while the preview is in
        /// flight: true when a road-restricted structure at <paramref name="p"/> would stand on a road; then
        /// <paramref name="beside"/> is the hex whose centre it snaps to (the hexes within RULESET.placementSnap of the
        /// cursor's hex, nearest centre first, ties by the lowest tile id; the first off the road on your land or neutral
        /// ground), or -1. Base ring roads, slopes and obstacles are left to the server's answer. Cached per spot.
        /// </summary>
        bool RoadSnapEstimate(string type, Vector3 p, out int beside)
        {
            beside = -1;
            var w = session.World;
            var g = w.Grid;
            if (g == null || w.Road == null || w.Road.Length < g.N || !RoadRuleApplies(type)) return false;
            int kx = Mathf.RoundToInt(p.x * 20f), kz = Mathf.RoundToInt(p.z * 20f);
            if (kx == snapKeyX && kz == snapKeyZ && snapKeyRoads == w.RoadRevision && snapKeyType == type) { beside = snapTile; return snapOnRoad; }
            snapKeyX = kx; snapKeyZ = kz; snapKeyRoads = w.RoadRevision; snapKeyType = type;
            float radius = ProtocolDecoder.Float(session.Defs?["BUILDINGS"]?[type]?["radius"], .3f);
            snapOnRoad = ClientOnRoad(p.x, p.z, radius);
            snapTile = -1;
            int t = g.TileAt(p.x, p.z);
            if (snapOnRoad && t >= 0)
            {
                int reach = Mathf.Clamp(ProtocolDecoder.Int(session.Defs?["RULESET"]?["placementSnap"], 2), 0, 4);
                int count = 0, start = 0;
                snapHexes[count++] = t;
                for (int ring = 0; ring < reach; ring++)
                {
                    int end = count;
                    for (int i = start; i < end; i++)
                        for (int k = 0; k < 6; k++)
                        {
                            int n = g.Neighbor(snapHexes[i], k);
                            if (n < 0 || count >= snapHexes.Length) continue;
                            bool seen = false;
                            for (int j = 0; j < count && !seen; j++) seen = snapHexes[j] == n;
                            if (!seen) snapHexes[count++] = n;
                        }
                    start = end;
                }
                // order: distance rounded to 1e-6 (as the server), then tile id; packed in a long and insertion-sorted
                for (int i = 0; i < count; i++)
                {
                    int n = snapHexes[i];
                    float ddx = g.DxWrap(p.x, g.CenterX(n)), ddz = g.CenterZ(n) - p.z;
                    long key = ((long)Mathf.RoundToInt(Mathf.Sqrt(ddx * ddx + ddz * ddz) * 1e6f) << 24) | (uint)(n & 0xFFFFFF);
                    int at = i;
                    while (at > 0 && snapOrder[at - 1] > key) { snapOrder[at] = snapOrder[at - 1]; at--; }
                    snapOrder[at] = key;
                }
                var own = w.Owner;
                for (int i = 0; i < count; i++)
                {
                    int n = (int)(snapOrder[i] & 0xFFFFFF);
                    if (own != null && n < own.Length && own[n] != session.CivId && own[n] >= 0) continue;   // another player's land
                    if (ClientOnRoad(g.CenterX(n), g.CenterZ(n), radius)) continue;
                    snapTile = n; break;
                }
            }
            beside = snapTile;
            return snapOnRoad;
        }

        /// <summary>Client mirror of server actionBases.onRoad (hex roads only): on a road hex, or within the road's half-width (.35) + r of a road link.</summary>
        bool ClientOnRoad(float x, float z, float r)
        {
            var w = session.World;
            var g = w.Grid;
            int t = g.TileAt(x, z);
            if (t < 0) return false;
            if ((w.Road[t] & 0xFFFFFF) != 0) return true;
            float clear = ProtocolDecoder.Float(session.Defs?["RULESET"]?["roadClear"], .35f);
            float reach = (r + clear) * (r + clear);
            for (int i = -1; i < 6; i++)
            {
                int a = i < 0 ? t : g.Neighbor(t, i);
                if (a < 0 || (w.Road[a] & 0xFFFFFF) == 0) continue;
                float ax = x + g.DxWrap(x, g.CenterX(a)), az = g.CenterZ(a);
                for (int d = 0; d < 6; d++)
                {
                    int n = g.Neighbor(a, d);
                    if (n < 0 || ((w.Road[a] >> (d * 4)) & 15) == 0) continue;
                    float bx = ax + g.DxWrap(g.CenterX(a), g.CenterX(n)), bz = g.CenterZ(n);
                    float sx = bx - ax, sz = bz - az, px = x - ax, pz = z - az, len = sx * sx + sz * sz;
                    float s = len > 0 ? Mathf.Clamp01((sx * px + sz * pz) / len) : 0f;
                    float ex = px - sx * s, ez = pz - sz * s;
                    if (ex * ex + ez * ez < reach) return true;
                }
            }
            return false;
        }

        /// <summary>The structure under the cursor: footprint-and-height picking, memoised per frame (Commander.Selection.cs).</summary>
        BuildingRecord? SpatialBuildingAt(Vector2 mouse) => PickBuilding(mouse);

        bool PickupAt(Vector2 mouse, out ResourcePickup pickup)
        {
            pickup = default; float best = 22 * 22;
            foreach (var c in session.Pickups.Values)
            {
                float x = session.World.Grid.NearX(c.X, cam.Focus.x);
                var p = cam.ToScreen(new Vector3(x, session.World.GroundHeight(c.X, c.Z) + .09f, c.Z));
                float d = (new Vector2(p.x, p.y) - mouse).sqrMagnitude;
                if (p.z > 0 && d < best) { best = d; pickup = c; }
            }
            return pickup.Id != 0;
        }

        bool SelectActionPickup(Vector2 mouse)
        {
            if (!PickupAt(mouse, out var p)) return false;
            units.Selected.Clear(); SelectedBuildings.Clear(); SelectedObjective = SelectedRingSlot = 0;
            SelectedPickup = p.Id; SelectionChanged?.Invoke(); return true;
        }

        bool SelectActionRing(Vector2 mouse, bool doubleClick = false)
        {
            if (SpatialBuildingAt(mouse) is BuildingRecord b)
            {
                SelectedPickup = SelectedRingSlot = 0;
                if (b.Type == "town") { SelectObjective(b.City); return true; }
                if (!doubleClick || b.Owner != session.CivId) { SelectProduction(new[] { b.Id }); return true; }
                // double-click: every own building of that type on screen (the wheel shows the shared roster)
                var same = new List<int> { b.Id };
                foreach (var o in session.Structures.Buildings.Values)
                {
                    if (o.Id == b.Id || o.Owner != b.Owner || o.Type != b.Type || !o.HasPosition) continue;
                    var sp = WorldToScreen(o.X, o.Z, .18f);
                    if (sp.z > 0 && sp.x >= 0 && sp.y >= 0 && sp.x <= Screen.width && sp.y <= Screen.height) same.Add(o.Id);
                }
                SelectProduction(same); return true;
            }
            if (!cam.TryGround(mouse, out var point)) return false;
            if (!NearestOwnParcel(point, out var choice, out var parcel)) return false;
            SelectRingSlot(choice.Id, parcel.Id); return true;
        }

        /// <summary>
        /// World pick radius of a pad: .57 close in, growing with the camera distance (pads shrink on screen) up to
        /// .82 (pads are ≈1.2 apart, and the nearest pad always wins).
        /// </summary>
        float PadPickRadius => Mathf.Clamp(.57f * Mathf.Sqrt(Mathf.Max(1f, cam.Distance) / 14f), .57f, .82f);

        bool NearestOwnParcel(Vector3 point, out ObjectiveSite choice, out BaseParcel parcel, int onlySite = 0)
        {
            float pick = PadPickRadius;
            float best = pick * pick; choice = default; parcel = default;
            foreach (var s in session.Objectives.Values)
            {
                if (!s.IsBase || s.Owner != session.CivId || s.Parcels == null) continue;
                if (onlySite != 0 && s.Id != onlySite) continue;
                foreach (var p in s.Parcels)
                {
                    if (p.Id == 0) continue;
                    float dx = session.World.Grid.DxWrap(point.x, p.X), dz = p.Z - point.z, d = dx * dx + dz * dz;
                    if (d >= best) continue; best = d; choice = s; parcel = p;
                }
            }
            return choice.Id != 0;
        }

        // ------------------------------------------------------------------ socket glow (spec B7)
        /// <summary>Set by the base wheel while a socket wedge is hovered: that parcel glows in the world.</summary>
        public int HoverRingSlot { get; set; }
        /// <summary>The parcel of the selected own base under the cursor (computed each frame), so its wedge lights up.</summary>
        public int HoverRingSlotFromWorld { get; private set; }

        int hoverPadSite, hoverPadSlot, hoverPadFrame = -10;
        /// <summary>§12: the own base whose pad is under the cursor, whether or not that base is selected (0 when none).</summary>
        public int HoverPadSite => hoverPadFrame >= Time.frameCount - 1 ? hoverPadSite : 0;
        /// <summary>§12: the pad (parcel id) under the cursor on <see cref="HoverPadSite"/> (0 when none).</summary>
        public int HoverPadSlot => hoverPadFrame >= Time.frameCount - 1 ? hoverPadSlot : 0;

        /// <summary>
        /// Called each frame in select mode (Commander.cs). Pads of every own base are hoverable and clickable
        /// without selecting the base first (§12); the result is the slot only when it belongs to the selected base
        /// (or none is selected), so the selected base's wedge highlight never lights a same-numbered pad elsewhere.
        /// Not while units are selected: a right-click there is a move order.
        /// </summary>
        int WorldParcelUnderCursor()
        {
            hoverPadSite = hoverPadSlot = 0;
            hoverPadFrame = Time.frameCount;
            if (units.Selected.Count > 0) return 0;
            if (!cam.TryGround(InputFacade.MousePosition, out var point)) return 0;
            if (!NearestOwnParcel(point, out var site, out var parcel)) return 0;
            hoverPadSite = site.Id; hoverPadSlot = parcel.Id;
            return SelectedObjective == 0 || SelectedObjective == site.Id ? parcel.Id : 0;
        }

        /// <summary>
        /// The hovered pad of an own base that is not selected (the selected base's pads are drawn by the action
        /// overlay): a ring around the pad, amber when empty (click builds), teal when built, grey when locked.
        /// </summary>
        /// <summary>W4: the garrison exit rally point (econ <c>ge</c>) of each selected structure (or the selected base's HQ): a blue ring.</summary>
        void DrawGarrisonExits(float time)
        {
            if (!session.ActionRts || session.Spectator) return;
            var w = session.World;
            void Mark(in BuildingRecord b)
            {
                if (!b.HasGarrisonExit || b.Owner != session.CivId) return;
                float x = w.Grid.NearX(b.GarrisonExitX, cam.Focus.x), z = b.GarrisonExitZ;
                float pulse = .3f + .03f * Mathf.Sin(time * 4f);
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .03f, z)), 0, new float3(pulse), new float4(.45f, .7f, 1f, .8f)));
            }
            foreach (int id in SelectedBuildings) if (session.Structures.Buildings.TryGetValue(id, out var b)) Mark(b);
            if (session.Objectives.TryGetValue(SelectedObjective, out var site) && session.Structures.Buildings.TryGetValue(site.Headquarters, out var hq)) Mark(hq);
        }

        void DrawPadHover(float time)
        {
            if (!session.ActionRts || Current != Mode.Select) return;
            int siteId = HoverPadSite, slot = HoverPadSlot;
            if (siteId == 0 || slot == 0 || siteId == SelectedObjective) return;
            if (!session.Objectives.TryGetValue(siteId, out var site) || site.Parcels == null) return;
            foreach (var p in site.Parcels)
            {
                if (p.Id != slot) continue;
                bool locked = p.Tier > site.Tier;
                bool empty = !locked && site.Slots != null && Array.IndexOf(site.Slots, slot) >= 0;
                var color = locked ? new float4(.61f, .56f, .44f, .7f) : empty ? new float4(.95f, .74f, .36f, .95f) : new float4(.46f, .82f, .74f, .9f);
                float size = Mathf.Max(p.Width, p.Depth) * 1.35f + .06f * Mathf.Sin(time * 6f);
                var w = session.World;
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.X, w.GroundHeight(p.X, p.Z) + .05f, p.Z)), 0, new float3(size), color));
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(p.X, w.GroundHeight(p.X, p.Z) + .05f, p.Z)), 0, new float3(size * .8f), new float4(color.xyz, color.w * .6f)));
                break;
            }
        }

        /// <summary>Screen position (pixels, z = depth; z &lt;= 0 behind the camera) of a map point, wrap-aware.</summary>
        public Vector3 WorldToScreen(float x, float z, float raise = 0f)
        {
            float nx = session.World.Grid.NearX(x, cam.Focus.x);
            return cam.ToScreen(new Vector3(nx, session.World.GroundHeight(nx, z) + raise, z));
        }

        public void SelectRingSlot(int siteId, int slotId)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site)) return;
            var building = session.Structures.Buildings.Values.FirstOrDefault(b => b.Slot == slotId && b.City == siteId);
            if (building.Id != 0) { SelectProduction(new[] { building.Id }); return; }
            SelectObjective(siteId); SelectedRingSlot = slotId; SelectedPickup = 0;
            RingPreviewType = null; RingPreviewParcel = null; SelectionChanged?.Invoke();
        }

        public void PreviewRingFacility(int siteId, int slotId, string type)
        {
            if (!session.Objectives.TryGetValue(siteId, out var site) || site.Slots == null || !site.Slots.Contains(slotId)) return;
            RingPreviewType = type; RingPreviewParcel = site.Parcels.First(p => p.Id == slotId);
        }
        public void ClearRingPreview() { RingPreviewType = null; RingPreviewParcel = null; }

        public void BuildRingFacility(int siteId, int slotId, string type)
        {
            ClearRingPreview();
            session.Net?.Command(new JObject { ["c"] = "baseBuild", ["site"] = siteId, ["slot"] = slotId, ["type"] = type },
                r => { Say(ReadableError(r) ?? "Construction started", r.Error == null, Time.unscaledTime); SelectionChanged?.Invoke(); });
        }

        public void BeginFieldConstruction(string type)
        {
            Begin(Mode.Target, type, new JObject { ["c"] = "fieldBuild", ["type"] = type, ["tile"] = "@map" });
        }

        /// <summary>Draw a trench (defense bar).</summary>
        public void BeginTrench() => Begin(Mode.Trench);
        /// <summary>Draw a road (defense bar).</summary>
        public void BeginRoad() => Begin(Mode.Road);
    }
}
