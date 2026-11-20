using System;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEngine;
using UnityEngine.LowLevel;

namespace SE.Runtime.App
{
    /// <summary>
    /// Player-loop phase timings for client telemetry (docs/TELEMETRY.md, schema v3, Pass 7). Production clients spent
    /// 15-40 ms of CPU frame time outside GameBootstrap.Update's measured phases; the profiler is not available in a
    /// release player, so this inserts tiny timestamp systems around the top-level player-loop phases and a few named
    /// sub-systems (script Update, UI Toolkit panels, frame rendering, present) and reports each one's ms per frame.
    /// Cost: two Stopwatch reads per marked system, about 30 per frame. Installed once while diagnostics are on.
    /// </summary>
    public static class FrameLoopTimer
    {
        /// <summary>Slot names, in <see cref="LastFrameMs"/> order.</summary>
        public static readonly string[] Names = { "initialization", "early_update", "fixed_update", "pre_update", "update", "pre_late_update", "post_late_update", "scripts", "ui", "render", "present", "between_frames" };
        static readonly string[] TopTypes = { "Initialization", "EarlyUpdate", "FixedUpdate", "PreUpdate", "Update", "PreLateUpdate", "PostLateUpdate" };
        static readonly Dictionary<string, int> SubTypes = new Dictionary<string, int>
        {
            ["ScriptRunBehaviourUpdate"] = 7, ["UIElementsUpdatePanels"] = 8, ["UIElementsRepaintPanels"] = 8, ["FinishFrameRendering"] = 9, ["PresentAfterDraw"] = 10,
        };
        const int Between = 11;
        static readonly double[] cur = new double[12], last = new double[12];
        static readonly long[] begun = new long[12];
        static long frameEnd = -1;
        static readonly double TickMs = 1000.0 / Stopwatch.Frequency;

        /// <summary>The previous complete frame's ms per slot (all zero until a frame has run with the timer installed).</summary>
        public static double[] LastFrameMs => last;
        public static bool Installed { get; private set; }

        struct Marker { }   // the type tag of the inserted systems (found again by Uninstall)

        static PlayerLoopSystem Mark(PlayerLoopSystem.UpdateFunction f) => new PlayerLoopSystem { type = typeof(Marker), updateDelegate = f };

        public static void Install()
        {
            if (Installed) return;
            try
            {
                var loop = PlayerLoop.GetCurrentPlayerLoop();
                if (Contains(loop)) { Installed = true; return; }
                var top = loop.subSystemList;
                if (top == null) return;
                for (int i = 0; i < top.Length; i++)
                {
                    int slot = Array.IndexOf(TopTypes, top[i].type?.Name);
                    if (slot < 0) continue;
                    var list = new List<PlayerLoopSystem>();
                    if (slot == 0) list.Add(Mark(FrameStart));
                    int s0 = slot;
                    list.Add(Mark(() => Begin(s0)));
                    foreach (var sub in top[i].subSystemList ?? Array.Empty<PlayerLoopSystem>())
                    {
                        if (sub.type != null && SubTypes.TryGetValue(sub.type.Name, out int k))
                        {
                            int s = k;
                            list.Add(Mark(() => Begin(s))); list.Add(sub); list.Add(Mark(() => End(s)));
                        }
                        else list.Add(sub);
                    }
                    list.Add(Mark(() => End(s0)));
                    if (slot == 6) list.Add(Mark(FrameEnd));
                    top[i].subSystemList = list.ToArray();
                }
                loop.subSystemList = top;
                PlayerLoop.SetPlayerLoop(loop);
                Installed = true;
                Application.quitting += Uninstall;   // also leaving play mode in the editor: no stale delegates after a reload
            }
            catch (Exception e) { UnityEngine.Debug.LogWarning("FrameLoopTimer: " + e.Message); }
        }

        public static void Uninstall()
        {
            if (!Installed) return;
            Installed = false;
            Application.quitting -= Uninstall;
            try
            {
                var loop = PlayerLoop.GetCurrentPlayerLoop();
                var top = loop.subSystemList;
                if (top == null) return;
                for (int i = 0; i < top.Length; i++)
                {
                    if (top[i].subSystemList == null) continue;
                    var list = new List<PlayerLoopSystem>();
                    foreach (var sub in top[i].subSystemList) if (sub.type != typeof(Marker)) list.Add(sub);
                    top[i].subSystemList = list.ToArray();
                }
                loop.subSystemList = top;
                PlayerLoop.SetPlayerLoop(loop);
            }
            catch (Exception e) { UnityEngine.Debug.LogWarning("FrameLoopTimer: " + e.Message); }
        }

        static bool Contains(PlayerLoopSystem s)
        {
            if (s.type == typeof(Marker)) return true;
            if (s.subSystemList != null) foreach (var c in s.subSystemList) if (Contains(c)) return true;
            return false;
        }

        static void FrameStart()
        {
            long now = Stopwatch.GetTimestamp();
            Array.Copy(cur, last, cur.Length);
            Array.Clear(cur, 0, cur.Length);
            if (frameEnd > 0) cur[Between] = (now - frameEnd) * TickMs;
        }
        static void FrameEnd() => frameEnd = Stopwatch.GetTimestamp();
        static void Begin(int slot) => begun[slot] = Stopwatch.GetTimestamp();
        static void End(int slot) { if (begun[slot] != 0) cur[slot] += (Stopwatch.GetTimestamp() - begun[slot]) * TickMs; }
    }
}
