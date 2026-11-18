using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using Newtonsoft.Json.Linq;
using Unity.Profiling;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace SE.Runtime.App
{
    /// <summary>
    /// Performance soak benchmark (diagnostics only; inert unless launched with -perf-soak).
    /// Watches an AI-only match (-mode observe) as it develops, alternating a stationary camera on the
    /// busiest area with a fast pan across the map, and writes one JSON line per measurement window:
    /// frame-time percentiles, the per-phase cost of Present, network/HUD time, render counters,
    /// GC allocation, memory and live object counts, plus match age and entity counts. Comparing windows
    /// at different match ages with similar unit counts separates scaling costs from accumulation.
    ///   -perf-soak MINUTES   real minutes to run (then quits)
    ///   -perf-speed N        observer match speed (1, 2, 4; default 4)
    ///   -perf-window S       seconds per window (default 15)
    ///   -perf-out FILE       JSON-lines output (default: Debug.Log)
    /// </summary>
    public sealed partial class GameBootstrap
    {
        bool soakStarted, profiled;
        double stallHud;
        sealed class SoakWindow
        {
            public readonly List<double> Frame = new List<double>(4096), Main = new List<double>(4096), Cpu = new List<double>(4096), Gpu = new List<double>(4096);
            public double Net, NetMax, Hud, HudMax, Gc, Batches, SetPass, Draws, Tris;
            public int Frames, Gc0, Composes0, BaseComposes0, Built0, Replayed0, Snaps0, Geo0;
            public double UnitPos, UnitBuild, UnitUpload, UnitMax;
            public readonly double[] Part0 = new double[5], Compose0 = new double[4];
            public double Territory0, Districts0;
            public readonly double[] Hex0 = new double[3], Warz0 = new double[3];
            public int WarzRebuilds0;
            public int Streets0, StreetsRep0;
            public readonly double[] Phase = new double[10], PhaseMax = new double[10];
            // perf pass 2: draw-phase split, render thread, terrain chunk collection, trees, units
            public readonly double[] DrawPart = new double[5], DrawPartMax = new double[5];
            public readonly List<double> Render = new List<double>(4096), EngineMain = new List<double>(4096);
            public double Finish0, TreesDrawn, TreeShadows, UnitInstances, UnitsDrawn, UnitsCulled, ShadowCasters;
            public int Chunks0, Refills0, Churn0, Regrown0, Sliced0;
        }
        SoakWindow soak;
        ProfilerRecorder recShadowCasters, recGc, recBatches, recSetPass, recDraws, recTris, recUsed, recGfx, recGcReserved;
        readonly FrameTiming[] soakTimings = new FrameTiming[1];

        float soakDeadline = -1;
        void StepSoak()
        {
            // a hard stop independent of the coroutine (a slow frame must not extend the run)
            if (soakDeadline > 0 && Time.realtimeSinceStartup > soakDeadline)
            {
                soakDeadline = -1;
                Write(opts.Get("perf-out"), new JObject { ["kind"] = "end", ["reason"] = "deadline" }, false);
                if (!Application.isEditor) Application.Quit();
            }
            if (soakStarted || !opts.Has("perf-soak")) return;
            if (phase != Phase.Playing || session.Snapshots < 8) return;
            soakStarted = true;
            soakDeadline = Time.realtimeSinceStartup + opts.Float("perf-soak", 20f) * 60f + 30f;
            StartCoroutine(SoakPerf());
        }

        void SoakSample(double frameMs, double mainMs)
        {
            var w = soak;
            if (w == null) return;
            w.Frame.Add(frameMs); w.Main.Add(mainMs); w.Frames++;
            FrameTimingManager.CaptureFrameTimings();
            if (FrameTimingManager.GetLatestTimings(1, soakTimings) > 0)
            {
                if (soakTimings[0].cpuFrameTime > 0) w.Cpu.Add(soakTimings[0].cpuFrameTime);
                if (soakTimings[0].gpuFrameTime > 0) w.Gpu.Add(soakTimings[0].gpuFrameTime);
                if (soakTimings[0].cpuRenderThreadFrameTime > 0) w.Render.Add(soakTimings[0].cpuRenderThreadFrameTime);
                if (soakTimings[0].cpuMainThreadFrameTime > 0) w.EngineMain.Add(soakTimings[0].cpuMainThreadFrameTime);
            }
            for (int k = 0; k < 5; k++) { w.DrawPart[k] += drawMs[k]; if (drawMs[k] > w.DrawPartMax[k]) w.DrawPartMax[k] = drawMs[k]; }
            w.TreesDrawn += terrain.TreeInstancesDrawn; w.TreeShadows += terrain.TreeShadowInstances;
            w.UnitInstances += units.Instances; w.UnitsDrawn += units.Drawn; w.UnitsCulled += units.Culled;
            if (recShadowCasters.Valid) w.ShadowCasters += recShadowCasters.LastValue;
            w.UnitPos += units.PositionsMs; w.UnitBuild += units.BuildMs; w.UnitUpload += units.UploadMs;
            w.UnitMax = System.Math.Max(w.UnitMax, units.PositionsMs + units.BuildMs + units.UploadMs);
            w.Net += stallNet; if (stallNet > w.NetMax) w.NetMax = stallNet;
            w.Hud += stallHud; if (stallHud > w.HudMax) w.HudMax = stallHud;
            for (int k = 0; k < 10; k++) { w.Phase[k] += phaseMs[k]; if (phaseMs[k] > w.PhaseMax[k]) w.PhaseMax[k] = phaseMs[k]; }
            if (recGc.Valid) w.Gc += recGc.LastValue;
            if (recBatches.Valid) w.Batches += recBatches.LastValue;
            if (recSetPass.Valid) w.SetPass += recSetPass.LastValue;
            if (recDraws.Valid) w.Draws += recDraws.LastValue;
            if (recTris.Valid) w.Tris += recTris.LastValue;
        }

        System.Collections.IEnumerator SoakPerf()
        {
            float minutes = opts.Float("perf-soak", 20f), window = opts.Float("perf-window", 15f);
            int speed = opts.Int("perf-speed", 4);
            string outPath = opts.Get("perf-out");
            recGc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
            recShadowCasters = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Shadow Casters Count");
            recBatches = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Batches Count");
            recSetPass = ProfilerRecorder.StartNew(ProfilerCategory.Render, "SetPass Calls Count");
            recDraws = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count");
            recTris = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Triangles Count");
            recUsed = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Total Used Memory");
            recGfx = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Gfx Used Memory");
            recGcReserved = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Reserved Memory");
            if (session.Spectator) session.Net?.ObserverCommand(new JObject { ["c"] = "speed", ["speed"] = speed });
            hideUi = false;
            var started = Time.realtimeSinceStartup;
            Write(outPath, new JObject
            {
                ["kind"] = "meta", ["unity"] = Application.unityVersion, ["dev"] = Debug.isDebugBuild, ["editor"] = Application.isEditor,
                ["gpu"] = SystemInfo.graphicsDeviceName, ["cpu"] = SystemInfo.processorType, ["cores"] = SystemInfo.processorCount, ["ramMb"] = SystemInfo.systemMemorySize,
                ["screen"] = Screen.width + "x" + Screen.height, ["vsync"] = QualitySettings.vSyncCount, ["quality"] = QualitySettings.names[QualitySettings.GetQualityLevel()],
                ["speed"] = speed, ["window"] = window, ["zooms"] = opts.Get("perf-zooms") ?? "", ["server"] = serverUrl, ["build"] = BuildId(), ["legacy"] = PerfFlags.Describe(),
            }, true);
            int n = 0;
            // -perf-zooms a,b,c: every cycle measures a static and a pan window at each camera distance (perf pass 2:
            // the lag was worst at middle and very close zoom, which the single-zoom soak never measured)
            var zooms = ParseZooms(opts.Get("perf-zooms"));
            while (zooms != null && Time.realtimeSinceStartup - started < minutes * 60f)
            {
                foreach (float zoom in zooms)
                {
                    if (Time.realtimeSinceStartup - started >= minutes * 60f) break;
                    string tag = "@" + zoom.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
                    rts.FocusTile(BusiestTile(), zoom);
                    yield return new WaitForSecondsRealtime(1.5f);
                    // -perf-profile MIN: one static window at the middle zoom after MIN real minutes is captured to a binary
                    // profiler log (-perf-profile-out FILE, default soak-profile), for GC attribution (perf pass 2)
                    bool capture = !profiled && opts.Has("perf-profile") && Mathf.Abs(zoom - 30f) < .01f && Time.realtimeSinceStartup - started >= opts.Float("perf-profile", 10f) * 60f;
                    if (capture)
                    {
                        profiled = true;
                        UnityEngine.Profiling.Profiler.maxUsedMemory = 512 << 20;
                        UnityEngine.Profiling.Profiler.logFile = opts.Get("perf-profile-out") ?? "soak-profile";
                        UnityEngine.Profiling.Profiler.enableBinaryLog = true;
                        UnityEngine.Profiling.Profiler.enabled = true;
                    }
                    yield return Measure((capture ? "profiled-" : "") + "static" + tag, capture ? 6f : window, outPath, null);
                    if (capture) { UnityEngine.Profiling.Profiler.enabled = false; UnityEngine.Profiling.Profiler.enableBinaryLog = false; UnityEngine.Profiling.Profiler.logFile = ""; }
                    // a scroll at the speed a held pan key gives at this zoom (RtsCamera: 1.1 x Distance per second)
                    float dir = (n++ & 1) == 0 ? 1f : -1f, vx = zoom * 1.1f * dir;
                    yield return Measure("pan" + tag, window * 0.6f, outPath, () => { rts.Focus.x += vx * Mathf.Min(Time.unscaledDeltaTime, .1f); });
                }
                if (session.Units.Count == 0 && session.Structures.Buildings.Count == 0) break;
            }
            while (zooms == null && Time.realtimeSinceStartup - started < minutes * 60f)
            {
                // stationary: the busiest place on the map, at a typical play zoom
                rts.FocusTile(BusiestTile(), 30f);
                yield return new WaitForSecondsRealtime(1.5f);
                yield return Measure("static", window, outPath, null);
                // pan: a steady sweep across the map at the same zoom (the scroll lag report)
                var g = session.World.Grid;
                float dir = (n++ & 1) == 0 ? 1f : -1f, vx = g.Period / (window * 1.2f) * dir;
                yield return Measure("pan", window * 0.6f, outPath, () => { rts.Focus.x += vx * Mathf.Min(Time.unscaledDeltaTime, .1f); });
                if (session.Units.Count == 0 && session.Structures.Buildings.Count == 0) break;
            }
            Write(outPath, new JObject { ["kind"] = "end", ["realMinutes"] = (Time.realtimeSinceStartup - started) / 60f }, false);
            recShadowCasters.Dispose(); recGc.Dispose(); recBatches.Dispose(); recSetPass.Dispose(); recDraws.Dispose(); recTris.Dispose(); recUsed.Dispose(); recGfx.Dispose(); recGcReserved.Dispose();
            if (!Application.isEditor) Application.Quit();
        }

        System.Collections.IEnumerator Measure(string label, float seconds, string outPath, System.Action perFrame)
        {
            var s0 = new SoakWindow { Gc0 = System.GC.CollectionCount(0), Composes0 = city.Recomposed, BaseComposes0 = city.BaseCellComposes, Built0 = city.BaseComposeBuilt, Replayed0 = city.BaseComposeReplayed,
                Snaps0 = session.Snapshots, Geo0 = session.GeoMessages, Territory0 = city.TerritoryMs, Districts0 = city.DistrictsMs };
            System.Array.Copy(session.PartMs, s0.Part0, 5); System.Array.Copy(city.ComposeMs, s0.Compose0, 4); System.Array.Copy(city.HexLoopMs, s0.Hex0, 3); System.Array.Copy(warzone.PartMs, s0.Warz0, 3);             s0.WarzRebuilds0 = warzone.Rebuilds; s0.Streets0 = city.StreetsBuilt; s0.StreetsRep0 = city.StreetsReplayed;
            s0.Finish0 = terrain.FinishMsTotal; terrain.FinishMsMax = 0; s0.Chunks0 = terrain.ChunksFinished;
            s0.Sliced0 = city.ComposeJobsSliced; city.ComposeSliceMsMax = 0; city.ComposeJobFramesMax = 0; System.Array.Clear(city.BaseStageMsMax, 0, city.BaseStageMsMax.Length);
            s0.Refills0 = terrain.TreeRefills; s0.Churn0 = terrain.TreeChurn; s0.Regrown0 = terrain.TreesRegrown;
            System.Array.Clear(session.PartMax, 0, 5);
            city.BaseCellComposeMsMax = 0; city.PlainComposeMsMax = 0; city.TerritoryMsMax = 0; city.DistrictsMsMax = 0;
            soak = s0;
            float end = Time.realtimeSinceStartup + seconds;
            while (Time.realtimeSinceStartup < end) { perFrame?.Invoke(); yield return null; }
            var w = soak; soak = null;
            int f = Mathf.Max(1, w.Frames);
            var phases = new JObject();
            for (int k = 0; k < PhaseNames.Length; k++) phases[PhaseNames[k]] = new JArray(R(w.Phase[k] / f), R(w.PhaseMax[k]));
            // live object counts (taken after the window so their cost is not measured)
            var j = new JObject
            {
                ["kind"] = "window", ["label"] = label, ["matchTime"] = R(session.Units.NewestTime), ["frames"] = w.Frames,
                ["frameMs"] = Dist(w.Frame), ["mainMs"] = Dist(w.Main), ["cpuMs"] = Dist(w.Cpu), ["gpuMs"] = Dist(w.Gpu),
                ["fps"] = R(w.Frames / System.Math.Max(.001, Sum(w.Frame) / 1000.0)),
                ["netMs"] = new JArray(R(w.Net / f), R(w.NetMax)), ["hudMs"] = new JArray(R(w.Hud / f), R(w.HudMax)), ["present"] = phases,
                ["gcKbPerFrame"] = R(w.Gc / f / 1024), ["gc0"] = System.GC.CollectionCount(0) - w.Gc0,
                ["batches"] = R(w.Batches / f), ["setpass"] = R(w.SetPass / f), ["draws"] = R(w.Draws / f), ["trisK"] = R(w.Tris / f / 1000),
                ["usedMb"] = recUsed.Valid ? recUsed.LastValue >> 20 : -1, ["gfxMb"] = recGfx.Valid ? recGfx.LastValue >> 20 : -1,
                ["gcHeapMb"] = System.GC.GetTotalMemory(false) >> 20,
                ["units"] = session.Units.Count, ["buildings"] = session.Structures.Buildings.Count, ["particles"] = fx.Live,
                ["snapshots"] = session.Snapshots,
                ["gameObjects"] = Object.FindObjectsByType<Transform>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length,
                ["renderers"] = Object.FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length,
                ["colliders"] = Object.FindObjectsByType<Collider>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length,
                ["particleSystems"] = Object.FindObjectsByType<ParticleSystem>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length,
                ["meshes"] = Resources.FindObjectsOfTypeAll<Mesh>().Length, ["materials"] = Resources.FindObjectsOfTypeAll<Material>().Length,
                ["textures"] = Resources.FindObjectsOfTypeAll<Texture>().Length,
            };
            var parts = new JObject(); string[] pn = { "geo", "units", "trenches", "impacts", "buildings" };
            for (int k = 0; k < 5; k++) parts[pn[k]] = new JArray(R(session.PartMs[k] - w.Part0[k]), R(session.PartMax[k]));
            j["applyMsTotalMax"] = parts;
            j["snapsInWindow"] = session.Snapshots - w.Snaps0; j["geoInWindow"] = session.GeoMessages - w.Geo0;
            j["city"] = new JObject
            {
                ["composes"] = city.Recomposed - w.Composes0, ["baseComposes"] = city.BaseCellComposes - w.BaseComposes0,
                ["baseBuilt"] = city.BaseComposeBuilt - w.Built0, ["baseReplayed"] = city.BaseComposeReplayed - w.Replayed0,
                ["baseMax"] = R(city.BaseCellComposeMsMax), ["plainMax"] = R(city.PlainComposeMsMax),
                ["streetsMs"] = R(city.ComposeMs[0] - w.Compose0[0]), ["districtMs"] = R(city.ComposeMs[1] - w.Compose0[1]), ["buildingsMs"] = R(city.ComposeMs[2] - w.Compose0[2]), ["finishMs"] = R(city.ComposeMs[3] - w.Compose0[3]),
                ["streetMissBy"] = new JArray(city.StreetMissBy[0], city.StreetMissBy[1], city.StreetMissBy[2], city.StreetMissBy[3], city.StreetMissBy[4], city.StreetMissBy[5]),
                ["streetsBuilt"] = city.StreetsBuilt - w.Streets0, ["streetsReplayed"] = city.StreetsReplayed - w.StreetsRep0,
                ["hexStreetsMs"] = R(city.HexLoopMs[0] - w.Hex0[0]), ["hexOldWorldMs"] = R(city.HexLoopMs[1] - w.Hex0[1]), ["hexBlockedMs"] = R(city.HexLoopMs[2] - w.Hex0[2]),
                ["territoryTotal"] = R(city.TerritoryMs - w.Territory0), ["territoryMax"] = R(city.TerritoryMsMax),
                ["districtsTotal"] = R(city.DistrictsMs - w.Districts0), ["districtsMax"] = R(city.DistrictsMsMax),
            };
            j["compose"] = new JObject
            {
                ["sliceMax"] = R(city.ComposeSliceMsMax), ["jobsSliced"] = city.ComposeJobsSliced - w.Sliced0, ["jobFramesMax"] = city.ComposeJobFramesMax,
                ["baseStageMax"] = new JArray(R(city.BaseStageMsMax[0]), R(city.BaseStageMsMax[1]), R(city.BaseStageMsMax[2]), R(city.BaseStageMsMax[3]), R(city.BaseStageMsMax[4])),
            };
            j["warzone"] = new JObject { ["rebuilds"] = warzone.Rebuilds - w.WarzRebuilds0, ["trenchMs"] = R(warzone.PartMs[0] - w.Warz0[0]), ["wrecksMs"] = R(warzone.PartMs[1] - w.Warz0[1]), ["spoilMs"] = R(warzone.PartMs[2] - w.Warz0[2]) };
            j["unitsMs"] = new JArray(R(w.UnitPos / f), R(w.UnitBuild / f), R(w.UnitUpload / f), R(w.UnitMax));
            var draw = new JObject();
            for (int k = 0; k < DrawNames.Length; k++) draw[DrawNames[k]] = new JArray(R(w.DrawPart[k] / f), R(w.DrawPartMax[k]));
            j["drawMs"] = draw;
            j["renderMs"] = Dist(w.Render); j["engineMainMs"] = Dist(w.EngineMain);   // whole main thread (scripts + Unity culling and submission)
            j["terrain"] = new JObject
            {
                ["chunksFinished"] = terrain.ChunksFinished - w.Chunks0, ["finishMs"] = R(terrain.FinishMsTotal - w.Finish0), ["finishMax"] = R(terrain.FinishMsMax),
                ["treesDrawn"] = R(w.TreesDrawn / f), ["treeShadows"] = R(w.TreeShadows / f),
                ["treeRefills"] = terrain.TreeRefills - w.Refills0, ["treeChurn"] = terrain.TreeChurn - w.Churn0, ["treesRegrown"] = terrain.TreesRegrown - w.Regrown0,
            };
            j["unitInstances"] = R(w.UnitInstances / f); j["unitsDrawn"] = R(w.UnitsDrawn / f); j["unitsCulled"] = R(w.UnitsCulled / f);
            j["shadowCasters"] = R(w.ShadowCasters / f); j["zoom"] = R(rts.Distance);
            Write(outPath, j, false);
        }

        static double R(double v) => System.Math.Round(v, 2);

        static List<float> ParseZooms(string list)
        {
            if (string.IsNullOrEmpty(list)) return null;
            var zooms = new List<float>();
            foreach (var part in list.Split(','))
                if (float.TryParse(part.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float z) && z > 0) zooms.Add(z);
            return zooms.Count > 0 ? zooms : null;
        }
        static double Sum(List<double> l) { double s = 0; foreach (var v in l) s += v; return s; }
        static JObject Dist(List<double> l)
        {
            if (l.Count == 0) return new JObject();
            var a = l.ToArray(); System.Array.Sort(a);
            double P(double p) => a[Mathf.Clamp((int)System.Math.Ceiling(p * a.Length) - 1, 0, a.Length - 1)];
            return new JObject { ["avg"] = R(Sum(l) / l.Count), ["p50"] = R(P(.5)), ["p95"] = R(P(.95)), ["p99"] = R(P(.99)), ["max"] = R(a[a.Length - 1]), ["over33"] = System.Array.FindAll(a, v => v > 33.3).Length };
        }

        int BusiestTile()
        {
            // the 4x4-tile block holding the most units (ties keep the first)
            var store = session.Units; var g = session.World.Grid;
            var counts = new Dictionary<int, int>();
            int best = -1, bestN = 0;
            for (int i = 0; i < store.SlotCount; i++)
            {
                ref var r = ref store.Records[i];
                if (!r.InUse || r.Tile < 0) continue;
                int q = r.Tile % g.W, row = r.Tile / g.W, key = (row / 4) * 100000 + q / 4;
                counts.TryGetValue(key, out int c); counts[key] = ++c;
                if (c > bestN) { bestN = c; best = r.Tile; }
            }
            return best >= 0 ? best : g.N / 2;
        }

        string BuildId()
        {
            try { var p = Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "build_id.txt"); return File.Exists(p) ? File.ReadAllText(p).Trim() : "editor"; }
            catch { return "?"; }
        }

        static void Write(string path, JObject j, bool truncate)
        {
            var line = j.ToString(Newtonsoft.Json.Formatting.None);
            Debug.Log("SOAK " + line);
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)) ?? ".");
                if (truncate) File.WriteAllText(path, line + "\n", Encoding.UTF8); else File.AppendAllText(path, line + "\n", Encoding.UTF8);
            }
            catch (System.Exception e) { Debug.LogWarning("soak write failed: " + e.Message); }
        }
    }
}
