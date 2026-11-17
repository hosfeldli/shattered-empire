using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Runtime.Input;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Session
{
    /// <summary>
    /// Air orders (workstream D). With aircraft selected, the patrol key (P by default, which otherwise pauses)
    /// arms patrol planning: each left click drops a waypoint; Shift-click keeps adding, a plain click places the
    /// last one and sends the route. Enter or the patrol key again sends what is placed; right-click sends it too
    /// (or cancels with no waypoints); Esc cancels. The server ({c:'patrol', units, points}) flies a looping
    /// circuit through the waypoints (one waypoint: a station orbit), refuels on its own and resumes, and pulls
    /// waypoints beyond fuel range back toward the nearest base; the clamped route is shown for a moment.
    /// </summary>
    public sealed partial class Commander
    {
        const int MaxPatrolWaypoints = 8;
        readonly List<Vector3> patrolPoints = new List<Vector3>();
        readonly List<Vector3> patrolShown = new List<Vector3>();
        readonly List<int> airScratch = new List<int>();
        float patrolShownUntil;
        bool patrolArmed;

        /// <summary>True while waypoints are being placed (the mode hint and cursor follow it).</summary>
        public bool PatrolPlanning => patrolArmed;

        /// <summary>Waypoints placed so far while planning a patrol (the tool chip shows n/8).</summary>
        public int PatrolWaypointCount => patrolPoints.Count;

        /// <summary>
        /// The patrol key shares P with pause: while own aircraft are selected (or a patrol is being planned)
        /// the key belongs to the patrol and the interface must not pause.
        /// </summary>
        public bool PatrolKeyClaimed => session.ActionRts && !session.Spectator && Current == Mode.Select
            && InputFacade.KeyFor("air_patrol") == InputFacade.KeyFor("pause") && (patrolArmed || SelectedAircraft().Count > 0);

        /// <summary>Own selected aircraft that can patrol (one-way drones cannot).</summary>
        List<int> SelectedAircraft()
        {
            airScratch.Clear();
            var defs = session.Defs?["UNITS"];
            foreach (int id in units.Selected)
            {
                if (!session.Units.TryGet(id, out var u) || u.Owner != session.CivId) continue;
                string type = session.Units.Types.Name(u.TypeIndex);
                if (type != "oneway_drone" && ProtocolDecoder.Bool(defs?[type]?["air"])) airScratch.Add(id);
            }
            return airScratch;
        }

        /// <summary>Select-mode input while aircraft are selected. Returns true when it used this frame's input.</summary>
        bool AirPatrolInput(float time, bool overUi)
        {
            if (!session.ActionRts || session.Spectator) { patrolArmed = false; return false; }
            bool key = InputFacade.Action("air_patrol");
            if (!patrolArmed)
            {
                if (!key || SelectedAircraft().Count == 0) return false;
                patrolArmed = true;
                patrolPoints.Clear();
                return true;
            }
            if (SelectedAircraft().Count == 0) { CancelPatrol(); return false; }
            if (InputFacade.Pressed(KeyCode.Escape)) { EscapeFrame = Time.frameCount; CancelPatrol(); return true; }
            if (key || InputFacade.Pressed(KeyCode.Return) || (!overUi && InputFacade.RightDown))
            {
                if (patrolPoints.Count > 0) SendPatrol(); else CancelPatrol();
                return true;
            }
            if (!overUi && InputFacade.LeftDown && cam.TryGround(InputFacade.MousePosition, out var p))
            {
                patrolPoints.Add(p);
                if (!InputFacade.Shift || patrolPoints.Count >= MaxPatrolWaypoints) SendPatrol();
            }
            return true;
        }

        void CancelPatrol() { patrolArmed = false; patrolPoints.Clear(); }

        void SendPatrol()
        {
            var ids = SelectedAircraft();
            var points = new JArray();
            foreach (var p in patrolPoints) points.Add(Point(p));
            var cmd = new JObject { ["c"] = "patrol", ["units"] = new JArray(ids.ToArray()), ["points"] = points };
            int count = patrolPoints.Count;
            patrolShown.Clear(); patrolShown.AddRange(patrolPoints);
            patrolShownUntil = Time.unscaledTime + 2.5f;
            CancelPatrol();
            if (session.Net == null) return;
            session.Net.Command(cmd, r =>
            {
                float now = Time.unscaledTime;
                if (r.Error != null) { patrolShown.Clear(); Say(r.Error, false, now); return; }
                var info = r.Raw?["patrol"] as JObject;
                if (info?["route"] is JArray route)
                {
                    patrolShown.Clear();
                    foreach (var q in route)
                        if (q is JArray a && a.Count >= 2) patrolShown.Add(new Vector3(ProtocolDecoder.Float(a[0]), 0, ProtocolDecoder.Float(a[1])));
                    patrolShownUntil = now + 2.5f;
                }
                string note = ProtocolDecoder.Str(info?["note"], "");
                // a clamp is a warning, not a refusal: amber text, the order stands
                Feedback = note.Length > 0 ? note : count == 1 ? "Patrolling the area" : $"Patrol set · {count} waypoints";
                FeedbackGood = note.Length == 0;
                FeedbackUntil = now + (note.Length > 0 ? 3f : 1.5f);
            });
        }

        string PatrolHint()
        {
            string key = InputFacade.KeyFor("air_patrol").ToString();
            return $"Patrol · click waypoints, Shift-click to add more ({patrolPoints.Count}/{MaxPatrolWaypoints}) · {key}, Enter or right-click sends · Esc cancels";
        }

        /// <summary>Waypoint rings and a dotted loop: the route being placed, then the accepted (clamped) route briefly.</summary>
        void DrawPatrolOverlay(float time)
        {
            var w = session.World;
            if (!w.Ready) return;
            List<Vector3> pts;
            bool live = patrolArmed;
            if (live) pts = patrolPoints;
            else if (patrolShown.Count > 0 && Time.unscaledTime < patrolShownUntil) pts = patrolShown;
            else return;
            float fade = live ? 1f : Mathf.Clamp01(patrolShownUntil - Time.unscaledTime);
            var col = new float4(.45f, .82f, 1f, .9f * fade);
            var dot = new float4(.45f, .82f, 1f, .6f * fade);
            void Mark(float x, float z, float size, float4 c) =>
                rings.Add(InstanceData.TRS(MapSpace.W(new float3(x, w.GroundHeight(x, z) + .03f, z)), 0, new float3(size), c));
            var list = new List<Vector3>(pts);
            int placed = list.Count;
            if (live && cam.TryGround(InputFacade.MousePosition, out var cursor)) list.Add(cursor);
            for (int i = 0; i < list.Count; i++)
            {
                var a = list[i];
                Mark(a.x, a.z, i < placed ? .6f : .45f + .05f * Mathf.Sin(time * 6f), col);
                if (list.Count < 2 || (live && i == list.Count - 1 && list.Count == 2)) continue;
                var b = list[(i + 1) % list.Count];   // the circuit closes back on the first waypoint
                float dx = w.Grid.DxWrap(a.x, b.x), dz = b.z - a.z, len = Mathf.Sqrt(dx * dx + dz * dz);
                int dots = Mathf.Min(24, Mathf.FloorToInt(len / .5f));
                for (int k = 1; k < dots; k++) { float t = k / (float)dots; Mark(a.x + dx * t, a.z + dz * t, .14f, dot); }
            }
        }
    }
}
