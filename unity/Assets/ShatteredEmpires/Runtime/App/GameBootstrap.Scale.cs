using System;
using System.Collections.Generic;
using System.Text;
using SE.Core.Protocol;
using SE.Core.Stress;
using Unity.Profiling;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace SE.Runtime.App
{
    /// <summary>
    /// Scale pass, phase 1 (2026-11-20): the 8-player stress scene (8 x 1,000 units, ~4,000 buildings, SE.Core.Stress
    /// .StressScale) and the performance readout (F3, always on in stress scenes). Measurement only.
    ///
    /// Launch: <c>-mode stress -stress-scale [-stress-civs 8] [-stress-units 1000] [-stress-buildings 4000] [-stress-zoom 80]</c>
    /// (units are per civ here); without <c>-stress-zoom</c> the camera holds far (80), middle (20) and close (2.5) over a
    /// front for <c>-stress-hold</c> s each (15) after an optional <c>-stress-warmup</c> hold, and logs one "SCALE segment" line
    /// per hold (timed after <c>-stress-settle</c> s). <c>-stress-quit</c> writes the report to <c>-perf-out</c> and quits after
    /// one pass; <c>-shots DIR</c> saves one screenshot per hold. In the editor: <c>StartStressScale(8, 1000, 4000)</c>.
    /// The readout: frame rate and frame ms (avg / p95 over the last second), FrameTimingManager main / render / GPU ms,
    /// server ticks per second against the target (the econ 'perf' block; else snapshot cadence and 'pace'), server
    /// path / sim / combat ms, unit and building counts with drawn / culled, client phase ms, player-loop UI / render /
    /// present ms, and the render counters (draw calls, batches, SetPass, triangles).
    /// </summary>
    public sealed partial class GameBootstrap
    {
        StressScale scale;
        CameraTour scaleTour;
        int scaleFront;
        float scaleZoom = -1f;

        /// <summary>The 8k / 4k stress scene. perCiv: units per civ; buildings: in total.</summary>
        public void StartStressScale(int civs, int perCiv, int buildings, float fixedZoom = -1f)
        {
            hud?.ShowMenu(false, null);
            hud?.ShowGame(false);
            stress = null;
            phase = Phase.Stress;
            int seed = opts.Int("seed", 7);
            int size = opts.Int("stress-size", 256);
            stressSeconds = opts.Float("stress-seconds", 1e6f);
            var gen = StressWorld.Generate(size, seed);
            var civInfo = new CivInfo[civs];
            uint[] colours = { 0x3f7fbf, 0xbf4a3a, 0xd9a43b, 0x5aa457, 0x8e5bb5, 0x3fb3b0, 0xc96aa0, 0x9a8f7a };
            for (int i = 0; i < civs; i++) civInfo[i] = new CivInfo { Id = i, Name = "Nation " + (i + 1), Color = colours[i % colours.Length], Human = i == 0 };
            session.ApplyWelcome(new WelcomeMessage { W = size, H = size, Wrap = true, CivId = 0, Seed = seed, Match = "stress-scale", Ruleset = "action-v2", Civs = civInfo });
            session.ApplyGeo(gen.Geo);
            session.World.ActionLandscape = true;
            terrain.SetSeed(seed);
            city.Seed = seed;
            city.ActionRts = true; city.SetShowcaseRoads(null);
            scale = new StressScale(seed, civs);
            scale.Setup(session.World, perCiv, buildings);
            session.Objectives.Clear();
            foreach (var s in scale.Sites) session.Objectives[s.Id] = s;
            city.SetObjectives(session.Objectives.Values);
            session.World.MarkRoadsChanged();
            session.Age = 3;
            fog.Enabled = false;
            rts.UserControl = false;
            rts.PitchOverride = -1f;
            rts.Cam.orthographic = false; rts.Telephoto = true;   // the match camera (workstream A)
            showDiag = true;
            scaleZoom = fixedZoom > 0 ? fixedZoom : opts.Float("stress-zoom", -1f);
            scaleFront = 0;
            int front = scale.FrontTile(scaleFront);
            // a warm-up hold first: city cells and terrain chunks compose nearest-first within a frame budget
            float hold = opts.Float("stress-hold", 15f), warm = opts.Float("stress-warmup", 0f);
            scaleTour = new CameraTour(session.World.Grid);
            if (warm > 0) scaleTour.Add("warmup", front, front, 80, 80, 0, warm);
            scaleTour.Add("far", front, front, 80, 80, 0, hold).Add("middle", front, front, 20, 20, 0, hold).Add("close", front, front, 2.5f, 2.5f, 0, hold);
            scaleEnd = opts.Has("stress-quit") ? time + warm + hold * 3 + .5f : -1f;
            scaleShots = opts.Get("shots"); scaleShotSegment = null;
            ScaleSettleSeconds = opts.Float("stress-settle", ScaleSettleSeconds);
            ScaleStats.Reset();
            Debug.Log($"SCALE stress: {civs} civs, {scale.UnitCount} units, {scale.BuildingCount} buildings, {scale.Sites.Count} bases, map {size}");
        }

        void StepStressScale(float dt)
        {
            if (scale == null) return;
            if (phase != Phase.Stress) { scale = null; return; }
            long s0 = System.Diagnostics.Stopwatch.GetTimestamp();
            var snap = scale.Step(dt);
            long s1 = System.Diagnostics.Stopwatch.GetTimestamp();
            if (snap != null) session.ApplySnapshot(snap);
            long s2 = System.Diagnostics.Stopwatch.GetTimestamp();
            // the synthetic server runs on this thread: timed apart so it can be taken out of the client's frame
            ScaleSimMs = (s1 - s0) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            ScaleApplyMs = (s2 - s1) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            string segment;
            if (scaleZoom > 0)
            {
                int front = scale.FrontTile(scaleFront);
                rts.Focus = new Vector3(session.World.Grid.CenterX(front), rts.Focus.y, session.World.Grid.CenterZ(front));
                rts.Distance = rts.TargetDistance = scaleZoom; rts.Apply();
                segment = "fixed@" + scaleZoom;
            }
            else scaleTour.Update(dt, rts, out segment);
            ScaleStats.Frame(this, segment, time);
            // -shots DIR: one screenshot of the readout per segment, late in the hold
            if (!string.IsNullOrEmpty(scaleShots) && segment != scaleShotSegment) { scaleShotSegment = segment; scaleShotAt = time + opts.Float("stress-hold", 15f) * .8f; }
            if (scaleShotAt > 0 && time >= scaleShotAt)
            {
                scaleShotAt = 0;
                System.IO.Directory.CreateDirectory(scaleShots);
                ScreenCapture.CaptureScreenshot(System.IO.Path.Combine(scaleShots, scaleShotSegment + ".png"));
            }
            if (scaleEnd > 0 && time >= scaleEnd)
            {
                scaleEnd = -1f;
                ScaleStats.Flush();
                var outPath = opts.Get("perf-out");
                if (!string.IsNullOrEmpty(outPath)) System.IO.File.WriteAllText(outPath, ScaleReport);
                Debug.Log("SCALE report: " + ScaleReport);
                if (!Application.isEditor) Application.Quit();
            }
        }
        float scaleEnd = -1f, scaleShotAt;
        string scaleShots, scaleShotSegment;

        /// <summary>Per-segment averages of the scale scene (also logged as "SCALE segment ..." when a segment ends).</summary>
        public static string ScaleReport => ScaleStats.Report();
        /// <summary>Seconds a segment settles (cells compose, chunks build) before it is timed.</summary>
        public static float ScaleSettleSeconds = 3f;
        /// <summary>This frame: the synthetic server's step and the snapshot apply (both on the main thread in the stress scene).</summary>
        public static double ScaleSimMs, ScaleApplyMs;

        // ------------------------------------------------------------------ readout
        GUIStyle perfStyle;
        string perfText = "";
        float perfAt;
        int perfSnapshots, perfSnapshotsAt;
        float perfSnapRate = -1, perfSnapRateAt;

        void PerfReadoutGUI()
        {
            if (Event.current.type != EventType.Repaint && Event.current.type != EventType.Layout) return;
            if (Event.current.type == EventType.Repaint) ScaleStats.Sample();
            if (perfStyle == null) perfStyle = new GUIStyle(small) { fontSize = 12, wordWrap = false, richText = true };
            if (time > perfAt) { perfAt = time + .25f; perfText = PerfReadoutText(); }
            int lines = 1; foreach (char ch in perfText) if (ch == '\n') lines++;
            float h = lines * 15 + 12;
            GUI.Box(new Rect(8, 48, 640, h), GUIContent.none, box);
            GUI.Label(new Rect(16, 54, 628, h - 6), perfText, perfStyle);
        }

        string PerfReadoutText()
        {
            ScaleStats.EnsureRecorders();
            var sb = new StringBuilder(1024);
            ScaleStats.Window(out double avg, out double p95, out double main, out double render, out double gpu, out double wait);
            sb.Append("<b>PERF</b>  FPS ").Append((1000.0 / Math.Max(.01, avg)).ToString("0")).Append("   frame ").Append(avg.ToString("0.0")).Append(" ms avg, p95 ").Append(p95.ToString("0.0"))
              .Append("   main ").Append(main.ToString("0.0")).Append("  render ").Append(render.ToString("0.0")).Append("  GPU ").Append(gpu > 0 ? gpu.ToString("0.0") : "n/a")
              .Append("  present wait ").Append(wait.ToString("0.0")).Append('\n');
            // simulation speed
            if (time - perfSnapRateAt >= 1f)
            {
                if (perfSnapRateAt > 0) perfSnapRate = (session.Snapshots - perfSnapshotsAt) / (time - perfSnapRateAt);
                perfSnapRateAt = time; perfSnapshotsAt = session.Snapshots;
            }
            var sp = session.ServerPerf;
            bool fresh = sp != null && session.Snapshots - session.ServerPerfSnapshot <= 15;
            if (fresh)
            {
                sb.Append("server ").Append(sp.Tps.ToString("0.0")).Append(" / ").Append(sp.Target.ToString("0")).Append(" ticks/s");
                if (sp.Synthetic) sb.Append(" <color=#e0b050>(SYNTHETIC stress figures)</color>");
                sb.Append("   tick ").Append(F(sp.TickMs)).Append(" ms: path ").Append(F(sp.PathMs)).Append("  sim ").Append(F(sp.SimMs)).Append("  combat ").Append(F(sp.CombatMs))
                  .Append("  vis ").Append(F(sp.VisMs)).Append("  ai ").Append(F(sp.AiMs)).Append("  econ ").Append(F(sp.EconMs)).Append("  net ").Append(F(sp.NetMs)).Append('\n');
            }
            else
                sb.Append("server (no perf block) snapshots ").Append(perfSnapRate >= 0 ? perfSnapRate.ToString("0.0") : "-").Append("/s of 5 = ~")
                  .Append(perfSnapRate >= 0 ? (perfSnapRate * 2f * Math.Max(1f, session.PlayRate)).ToString("0.0") : "-").Append(" ticks/s")
                  .Append("   pace ").Append(session.Pace >= 0 ? session.Pace.ToString("0.0") + "x" : "-").Append('\n');
            // counts
            int bCount = session.Structures.Buildings.Count, bView = ScaleStats.BuildingsInView(this);
            sb.Append("units ").Append(session.Units.Count).Append("  drawn ").Append(units.Drawn).Append("  culled ").Append(units.Culled).Append("  instances ").Append(units.Instances)
              .Append("  (").Append(rts.Distance > units.StrategicDistance ? "badges" : rts.Distance > units.OperationalDistance ? "operational" : "detailed").Append(")")
              .Append("   buildings ").Append(bCount).Append("  in view ").Append(bView).Append("  city cells drawn ").Append(city.CellsDrawn).Append(" / ").Append(city.CellsDrawn + city.CellsCulled)
              .Append("   cam ").Append(rts.Distance.ToString("0.0")).Append('\n');
            // client phases (this frame)
            sb.Append("client ms  units ").Append(phaseMs[6].ToString("0.0")).Append("  city ").Append(phaseMs[3].ToString("0.0")).Append("  warzone ").Append(phaseMs[4].ToString("0.0"))
              .Append("  terrain ").Append(phaseMs[2].ToString("0.0")).Append("  fx ").Append(phaseMs[8].ToString("0.0")).Append("  events ").Append(phaseMs[0].ToString("0.0"))
              .Append("  fog+ground ").Append(phaseMs[1].ToString("0.0")).Append("  atmos ").Append(phaseMs[7].ToString("0.0")).Append("  draw ").Append(phaseMs[9].ToString("0.0")).Append('\n');
            sb.Append("draw ms  terrain ").Append(drawMs[0].ToString("0.0")).Append("  city ").Append(drawMs[1].ToString("0.0")).Append("  warzone ").Append(drawMs[2].ToString("0.0"))
              .Append("  units ").Append(drawMs[3].ToString("0.0")).Append("  fx ").Append(drawMs[4].ToString("0.0"))
              .Append("   units pos ").Append(units.PositionsMs.ToString("0.0")).Append(" build ").Append(units.BuildMs.ToString("0.0")).Append(" upload ").Append(units.UploadMs.ToString("0.0"))
              .Append("   apply ").Append(session.ApplyMs.ToString("0.0")).Append('\n');
            if (scale != null)
                sb.Append("<color=#e0b050>stress scene: synthetic server step ").Append(ScaleSimMs.ToString("0.0")).Append(" ms + snapshot apply ").Append(ScaleApplyMs.ToString("0.0"))
                  .Append(" ms run on this thread</color>   city cells pending ").Append(city.DirtyCount).Append('\n');
            if (FrameLoopTimer.Installed)
            {
                var l = FrameLoopTimer.LastFrameMs;
                sb.Append("loop ms  scripts ").Append(l[7].ToString("0.0")).Append("  UI ").Append(l[8].ToString("0.0")).Append("  render ").Append(l[9].ToString("0.0"))
                  .Append("  present ").Append(l[10].ToString("0.0")).Append("  between ").Append(l[11].ToString("0.0")).Append('\n');
            }
            sb.Append("render  draw calls ").Append(ScaleStats.Counter(0)).Append("  batches ").Append(ScaleStats.Counter(1)).Append("  SetPass ").Append(ScaleStats.Counter(2))
              .Append("  tris ").Append((ScaleStats.Counter(3) / 1e6).ToString("0.00")).Append("M  shadow casters ").Append(ScaleStats.Counter(4));
            return sb.ToString();
        }

        static string F(float v) => v < 0 ? "-" : v.ToString("0.0");

        /// <summary>Frame sampling for the readout's last-second window and the per-segment scale report.</summary>
        static class ScaleStats
        {
            static readonly string[] Counters = { "Draw Calls Count", "Batches Count", "SetPass Calls Count", "Triangles Count", "Shadow Casters Count" };
            static ProfilerRecorder[] rec;
            static readonly FrameTiming[] timing = new FrameTiming[1];
            const int Ring = 240;
            static readonly double[] wall = new double[Ring], mainMs = new double[Ring], renderMs = new double[Ring], gpuMs = new double[Ring], waitMs = new double[Ring];
            static readonly float[] stamp = new float[Ring];
            static int head, filled;
            static float lastSample = -1;
            static readonly Plane[] planes = new Plane[6];

            sealed class Seg
            {
                public string Name; public int Frames; public float Start;
                public double Wall, Main, Render, Gpu, Sim, Apply, Dirty, Calls, Batches, SetPass, Tris, Shadows, UnitsDrawn, UnitsCulled, Instances, CellsDrawn, CellsTotal, BView, Units, Buildings;
                public readonly double[] Phase = new double[10], Draw = new double[5];
                public readonly List<double> Frame = new List<double>();
            }
            static Seg cur;
            static readonly List<string> done = new List<string>();

            public static void Reset() { cur = null; done.Clear(); head = filled = 0; }
            public static void Flush() { if (cur != null && cur.Frames > 0) Finish(); cur = null; }

            public static void EnsureRecorders()
            {
                if (rec != null) return;
                rec = new ProfilerRecorder[Counters.Length];
                for (int k = 0; k < Counters.Length; k++) { try { rec[k] = ProfilerRecorder.StartNew(ProfilerCategory.Render, Counters[k]); } catch { } }
                FrameLoopTimer.Install();
            }

            public static long Counter(int k) => rec != null && rec[k].Valid ? rec[k].LastValue : -1;

            /// <summary>Last-second window; also samples the frame if nothing else did this frame (non-stress F3 use).</summary>
            public static void Window(out double avg, out double p95, out double main, out double render, out double gpu, out double wait)
            {
                avg = p95 = main = render = gpu = wait = 0;
                float now = Time.realtimeSinceStartup;
                var list = new List<double>(Ring);
                int n = 0;
                for (int i = 0; i < filled; i++)
                {
                    int k = (head - 1 - i + Ring) % Ring;
                    if (now - stamp[k] > 1f) break;
                    list.Add(wall[k]); main += mainMs[k]; render += renderMs[k]; gpu += gpuMs[k]; wait += waitMs[k]; n++;
                }
                if (n == 0) { avg = Time.unscaledDeltaTime * 1000.0; p95 = avg; return; }
                foreach (var w in list) avg += w;
                avg /= n; main /= n; render /= n; gpu /= n; wait /= n;
                list.Sort(); p95 = list[Math.Min(n - 1, (int)(n * .95))];
            }

            public static void Sample()
            {
                float now = Time.realtimeSinceStartup;
                if (now == lastSample) return;
                lastSample = now;
                int k = head; head = (head + 1) % Ring; if (filled < Ring) filled++;
                stamp[k] = now; wall[k] = Time.unscaledDeltaTime * 1000.0;
                mainMs[k] = renderMs[k] = gpuMs[k] = waitMs[k] = 0;
                if (FrameTimingManager.GetLatestTimings(1, timing) > 0)
                { mainMs[k] = timing[0].cpuMainThreadFrameTime; renderMs[k] = timing[0].cpuRenderThreadFrameTime; gpuMs[k] = timing[0].gpuFrameTime; waitMs[k] = timing[0].cpuMainThreadPresentWaitTime; }
            }

            public static void Frame(GameBootstrap b, string segment, float time)
            {
                EnsureRecorders();
                Sample();
                if (cur == null || cur.Name != segment)
                {
                    if (cur != null && cur.Frames > 0) Finish();
                    cur = new Seg { Name = segment, Start = time };
                }
                if (time - cur.Start < ScaleSettleSeconds) return;   // let the view settle (cells compose, chunks build) before timing
                int k = (head - 1 + Ring) % Ring;
                cur.Frames++;
                cur.Wall += wall[k]; cur.Frame.Add(wall[k]); cur.Main += mainMs[k]; cur.Render += renderMs[k]; cur.Gpu += gpuMs[k]; cur.Sim += ScaleSimMs; cur.Apply += ScaleApplyMs; cur.Dirty += b.city.DirtyCount;
                cur.Calls += Counter(0); cur.Batches += Counter(1); cur.SetPass += Counter(2); cur.Tris += Counter(3); cur.Shadows += Counter(4);
                cur.UnitsDrawn += b.units.Drawn; cur.UnitsCulled += b.units.Culled; cur.Instances += b.units.Instances;
                cur.CellsDrawn += b.city.CellsDrawn; cur.CellsTotal += b.city.CellsDrawn + b.city.CellsCulled;
                cur.Units += b.session.Units.Count; cur.Buildings += b.session.Structures.Buildings.Count;
                if (cur.Frames % 10 == 1) cur.BView += BuildingsInView(b) * 10;
                for (int i = 0; i < 10; i++) cur.Phase[i] += b.phaseMs[i];
                for (int i = 0; i < 5; i++) cur.Draw[i] += b.drawMs[i];
            }

            static void Finish()
            {
                var s = cur; double n = Math.Max(1, s.Frames);
                s.Frame.Sort();
                double p95 = s.Frame.Count > 0 ? s.Frame[Math.Min(s.Frame.Count - 1, (int)(s.Frame.Count * .95))] : 0;
                var sb = new StringBuilder();
                sb.Append("SCALE segment ").Append(s.Name).Append(" frames ").Append(s.Frames).Append(" fps ").Append((1000 * n / Math.Max(1e-3, s.Wall)).ToString("0.0"))
                  .Append(" frame ").Append((s.Wall / n).ToString("0.0")).Append(" p95 ").Append(p95.ToString("0.0"))
                  .Append(" | ftm main ").Append((s.Main / n).ToString("0.0")).Append(" render ").Append((s.Render / n).ToString("0.0")).Append(" gpu ").Append((s.Gpu / n).ToString("0.0")).Append(" | synthSim ").Append((s.Sim / n).ToString("0.0")).Append(" apply ").Append((s.Apply / n).ToString("0.0"))
                  .Append(" | calls ").Append((s.Calls / n).ToString("0")).Append(" batches ").Append((s.Batches / n).ToString("0")).Append(" setpass ").Append((s.SetPass / n).ToString("0"))
                  .Append(" tris ").Append((s.Tris / n / 1e6).ToString("0.00")).Append("M shadowCasters ").Append((s.Shadows / n).ToString("0"))
                  .Append(" | units ").Append((s.Units / n).ToString("0")).Append(" drawn ").Append((s.UnitsDrawn / n).ToString("0")).Append(" culled ").Append((s.UnitsCulled / n).ToString("0")).Append(" inst ").Append((s.Instances / n).ToString("0"))
                  .Append(" | buildings ").Append((s.Buildings / n).ToString("0")).Append(" inView ").Append((s.BView / n).ToString("0")).Append(" cells ").Append((s.CellsDrawn / n).ToString("0")).Append("/").Append((s.CellsTotal / n).ToString("0")).Append(" dirty ").Append((s.Dirty / n).ToString("0"))
                  .Append(" | phases");
                for (int i = 0; i < 10; i++) sb.Append(' ').Append(PhaseNames[i]).Append(' ').Append((s.Phase[i] / n).ToString("0.00"));
                sb.Append(" | draw");
                for (int i = 0; i < 5; i++) sb.Append(' ').Append(DrawNames[i]).Append(' ').Append((s.Draw[i] / n).ToString("0.00"));
                done.Add(sb.ToString());
                Debug.Log(sb.ToString());
            }

            public static string Report()
            {
                var sb = new StringBuilder();
                foreach (var l in done) sb.Append(l).Append('\n');
                return sb.ToString();
            }

            public static int BuildingsInView(GameBootstrap b)
            {
                var cam = b.rts.Cam; var w = b.session.World;
                if (cam == null || !w.Ready) return 0;
                GeometryUtility.CalculateFrustumPlanes(cam, planes);
                float camX = SE.Runtime.Rendering.ViewLod.EyeOr(cam).x;
                int n = 0;
                foreach (var r in b.session.Structures.Buildings.Values)
                {
                    float x = r.HasPosition ? r.X : w.Grid.CenterX(r.Tile), z = r.HasPosition ? r.Z : w.Grid.CenterZ(r.Tile);
                    x = w.Grid.NearX(x, camX);
                    var p = new Vector3(x, r.Tile >= 0 && r.Tile < w.Grid.N ? w.Height[r.Tile] : 0f, -z);
                    bool inView = true;
                    for (int k = 0; k < 6 && inView; k++) inView = planes[k].GetDistanceToPoint(p) > -1f;
                    if (inView) n++;
                }
                return n;
            }
        }
    }
}
