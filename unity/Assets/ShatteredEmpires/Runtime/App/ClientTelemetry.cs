using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Newtonsoft.Json.Linq;
using SE.Net;
using Unity.Profiling;
using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// Client diagnostics for benchmarking and debugging (docs/TELEMETRY.md). While a match is shown it aggregates frame
    /// pacing, per-phase timings, GC, camera zoom, drawn units and network figures into one row per minute; once per
    /// session it reports the system (OS, CPU, GPU, memory, display); exceptions are folded by stack hash and
    /// rate-limited. Rows go to the game server over the existing connection (never to Google directly: the client
    /// holds no credentials), only when that server said it accepts them (hello.telemetry) and only while
    /// Settings > Interface > Share diagnostics is on. With it off nothing is collected or sent; the server is told
    /// once per session, with no id at all, so the opt-out rate can be counted.
    /// Players are identified only by a random install id kept in PlayerPrefs (no names, Steam ids or addresses).
    /// </summary>
    public sealed class ClientTelemetry
    {
        const string InstallKey = "se.telemetry.install";
        const float MinuteSeconds = 60f;
        const int Bins = 400;                 // frame-time histogram: 0.5 ms bins to 200 ms, then an overflow bin
        const int MaxErrorsPerSession = 25, MaxErrorRowsPerMinute = 5, MaxQueuedRows = 40;

        static bool sessionSent, optOutSent;
        static readonly object errorGate = new object();
        static readonly Dictionary<string, JObject> errorsPending = new Dictionary<string, JObject>();
        static readonly HashSet<string> errorsSeen = new HashSet<string>();
        static bool errorHook;
        static volatile bool inMatchFlag;
        static volatile bool enabledFlag;   // Enabled, cached on the main thread for the log callback (any thread)

        /// <summary>Settings > Interface > Share diagnostics (default on).</summary>
        public static bool Enabled => GameSettings.ShareDiagnostics;

        static string install;
        /// <summary>The anonymous install id (32 hex digits), created on first use.</summary>
        public static string InstallId
        {
            get
            {
                if (!string.IsNullOrEmpty(install)) return install;
                install = PlayerPrefs.GetString(InstallKey, "");
                if (install.Length != 32) { install = Guid.NewGuid().ToString("N"); PlayerPrefs.SetString(InstallKey, install); PlayerPrefs.Save(); }
                return install;
            }
        }

        /// <summary>This build (build_id.txt build=), "editor" in the editor, else "unknown".</summary>
        public static string Build => !string.IsNullOrEmpty(Updater.CurrentBuild) ? Updater.CurrentBuild : Application.isEditor ? "editor" : "unknown";
        public static string Version => UI.ReleaseNotes.CurrentVersion;
        public static string Platform => SystemInfo.operatingSystemFamily.ToString();

        /// <summary>Tell the connection layer what to put in its hello (version details for the server's rows).</summary>
        public static void Identify()
        {
            GameConnection.ClientBuild = Build;
            GameConnection.ClientVersion = Version;
            GameConnection.ClientPlatform = Platform;
        }

        // ------------------------------------------------------------------ per-minute accumulators
        readonly int[] hist = new int[Bins + 1];
        int frames, over33, over50, over100;
        double frameSum, frameMax, mainSum, cpuSum, gpuSum, allocSum, distSum, interpSum;
        int cpuN, gpuN, allocN, interpN, liveFrames;
        long allocLast = -1;
        bool allocByThread = true;     // GC.GetAllocatedBytesForCurrentThread works in players (the recorder only in development builds)
        double decodeStart, applyStart;
        int resyncStart;
        long visibleSum;
        readonly List<double> mainSamples = new List<double>(4096);
        double[] phaseSum, phaseMax;
        string[] phaseNames;
        readonly float[] bandTime = new float[4];
        double minuteStart = -1, wall;
        int gcStart, snapshotsStart = -1;
        GameConnection lastNet;
        long bytesStart;
        TimeSpan cpuStart;
        bool any;
        readonly List<JObject> queued = new List<JObject>();
        int errorRowsThisMinute;
        ProfilerRecorder gcAlloc;
        // Pass 8 (memory growth): each recorder is started once per enable and always disposed. A counter missing from a
        // release player (e.g. "GC Allocated In Frame", the object counts) gives a recorder whose Valid stays false; it
        // used to be started again every frame without disposing the last one, leaking a native recorder per frame that
        // the profiler also kept sampling (memory and CPU frame time rising with session age).
        bool recordersStarted, gcAllocStarted;
        readonly FrameTiming[] timing = new FrameTiming[1];
        // v3 (Pass 7): where the frame goes outside GameBootstrap.Update (main / render thread, present wait, player-loop
        // phases), render counters, live object counts and time on a finished match's screen
        double mainThreadSum, renderThreadSum, presentWaitSum, untrackedSum, postMatchS;
        int mainThreadN, renderThreadN, presentWaitN, untrackedN, loopN, minutesSent;
        readonly double[] loopSum = new double[FrameLoopTimer.Names.Length], loopMax = new double[FrameLoopTimer.Names.Length];
        static readonly string[] RenderCounters = { "Draw Calls Count", "Batches Count", "SetPass Calls Count", "Triangles Count" };
        static readonly string[] RenderKeys = { "draw_calls_avg", "batches_avg", "setpass_calls_avg", "triangles_avg" };
        readonly ProfilerRecorder[] render = new ProfilerRecorder[4];
        readonly double[] renderSum = new double[4];
        readonly int[] renderN = new int[4];
        static readonly string[] MemoryCounters = { "Game Object Count", "Object Count", "Mesh Count", "Material Count", "Texture Count", "Asset Count" };
        static readonly string[] MemoryKeys = { "game_object", "object", "mesh", "material", "texture", "asset" };
        readonly ProfilerRecorder[] memory = new ProfilerRecorder[6];

        public ClientTelemetry()
        {
            Identify();
            if (!errorHook) { errorHook = true; Application.logMessageReceivedThreaded += OnLog; }
            if (Enabled) FrameLoopTimer.Install();
        }

        /// <summary>
        /// Once per frame (end of GameBootstrap.Update). <paramref name="inMatch"/>: a match is on screen (frames are
        /// measured); <paramref name="live"/>: and it has not ended. The minute's in_match is whether most of it was live,
        /// so time spent on a finished match's screen is no longer counted as match time (2026-11-19).
        /// </summary>
        public void Frame(double now, double frameMs, double mainMs, bool inMatch, string[] names, double[] phaseMs, float camDistance, int visibleUnits, float interpDelayS, bool live = true)
        {
            inMatchFlag = inMatch && live; enabledFlag = Enabled;
            if (!Enabled) { if (gcAllocStarted) { gcAlloc.Dispose(); gcAllocStarted = false; } StopRecorders(); minuteStart = -1; any = false; return; }
            if (!FrameLoopTimer.Installed) FrameLoopTimer.Install();
            StartRecorders();
            if (!allocByThread && !gcAllocStarted) { gcAllocStarted = true; try { gcAlloc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame"); } catch { } }
            if (minuteStart < 0) Begin(now, names);
            long allocBytes = SampleAlloc();
            if (!inMatch) return;
            any = true;
            frames++;
            if (live) liveFrames++;
            frameSum += frameMs; if (frameMs > frameMax) frameMax = frameMs;
            hist[Math.Min(Bins, (int)(frameMs * 2))]++;
            if (frameMs > 33.4) over33++;
            if (frameMs > 50) over50++;
            if (frameMs > 100) over100++;
            mainSum += mainMs; if (mainSamples.Count < 16384) mainSamples.Add(mainMs);
            if (FrameTimingManager.GetLatestTimings(1, timing) > 0)
            {
                var ft = timing[0];
                if (ft.cpuFrameTime > 0) { cpuSum += ft.cpuFrameTime; cpuN++; }
                if (ft.gpuFrameTime > 0) { gpuSum += ft.gpuFrameTime; gpuN++; }
                if (ft.cpuMainThreadFrameTime > 0)
                {
                    mainThreadSum += ft.cpuMainThreadFrameTime; mainThreadN++;
                    presentWaitSum += Math.Max(0, ft.cpuMainThreadPresentWaitTime); presentWaitN++;
                    untrackedSum += Math.Max(0, ft.cpuMainThreadFrameTime - Math.Max(0, ft.cpuMainThreadPresentWaitTime) - mainMs); untrackedN++;
                }
                if (ft.cpuRenderThreadFrameTime > 0) { renderThreadSum += ft.cpuRenderThreadFrameTime; renderThreadN++; }
            }
            if (!live) postMatchS += frameMs / 1000.0;
            if (FrameLoopTimer.Installed)
            {
                var lf = FrameLoopTimer.LastFrameMs;
                for (int k = 0; k < loopSum.Length; k++) { loopSum[k] += lf[k]; if (lf[k] > loopMax[k]) loopMax[k] = lf[k]; }
                loopN++;
            }
            for (int k = 0; k < render.Length; k++) if (render[k].Valid && render[k].Count > 0) { renderSum[k] += render[k].LastValue; renderN[k]++; }
            if (allocBytes >= 0) { allocSum += allocBytes; allocN++; }
            if (phaseMs != null && phaseSum != null)
                for (int k = 0; k < phaseSum.Length && k < phaseMs.Length; k++) { phaseSum[k] += phaseMs[k]; if (phaseMs[k] > phaseMax[k]) phaseMax[k] = phaseMs[k]; }
            distSum += camDistance;
            float dt = (float)(frameMs / 1000.0);
            bandTime[camDistance < 18 ? 0 : camDistance < 55 ? 1 : camDistance < 130 ? 2 : 3] += dt;
            visibleSum += visibleUnits;
            if (interpDelayS > 0 && interpDelayS < 30) { interpSum += interpDelayS; interpN++; }
        }

        void Begin(double now, string[] names)
        {
            minuteStart = now; any = false;
            Array.Clear(hist, 0, hist.Length);
            frames = over33 = over50 = over100 = 0;
            frameSum = frameMax = mainSum = cpuSum = gpuSum = allocSum = distSum = interpSum = 0;
            cpuN = gpuN = allocN = interpN = liveFrames = 0; visibleSum = 0;
            mainThreadSum = renderThreadSum = presentWaitSum = untrackedSum = postMatchS = 0;
            mainThreadN = renderThreadN = presentWaitN = untrackedN = loopN = 0;
            Array.Clear(loopSum, 0, loopSum.Length); Array.Clear(loopMax, 0, loopMax.Length);
            Array.Clear(renderSum, 0, renderSum.Length); Array.Clear(renderN, 0, renderN.Length);
            mainSamples.Clear();
            Array.Clear(bandTime, 0, bandTime.Length);
            if (names != null && (phaseNames == null || phaseNames.Length != names.Length)) { phaseNames = names; phaseSum = new double[names.Length]; phaseMax = new double[names.Length]; }
            else if (phaseSum != null) { Array.Clear(phaseSum, 0, phaseSum.Length); Array.Clear(phaseMax, 0, phaseMax.Length); }
            gcStart = GC.CollectionCount(0);
            errorRowsThisMinute = 0;
            try { using (var proc = System.Diagnostics.Process.GetCurrentProcess()) cpuStart = proc.TotalProcessorTime; } catch { cpuStart = TimeSpan.Zero; }
        }

        void StartRecorders()
        {
            if (recordersStarted) return;
            recordersStarted = true;
            for (int k = 0; k < render.Length; k++) { try { render[k] = ProfilerRecorder.StartNew(ProfilerCategory.Render, RenderCounters[k]); } catch { } }
            for (int k = 0; k < memory.Length; k++) { try { memory[k] = ProfilerRecorder.StartNew(ProfilerCategory.Memory, MemoryCounters[k]); } catch { } }
        }
        void StopRecorders()
        {
            if (!recordersStarted) return;
            recordersStarted = false;
            // Dispose, not "if Valid": a recorder for a counter the player lacks is allocated but never Valid
            for (int k = 0; k < render.Length; k++) render[k].Dispose();
            for (int k = 0; k < memory.Length; k++) memory[k].Dispose();
        }

        /// <summary>v3: live object counts (profiler memory counters; UI Toolkit elements every fifth minute).</summary>
        JArray ObjectCounts()
        {
            var a = new JArray();
            for (int k = 0; k < memory.Length; k++) if (memory[k].Valid && memory[k].Count > 0) a.Add(new JObject { ["type"] = MemoryKeys[k], ["count"] = memory[k].LastValue });
            if (minutesSent % 5 == 0)
            {
                int n = 0;
                foreach (var d in UnityEngine.Object.FindObjectsByType<UnityEngine.UIElements.UIDocument>(FindObjectsSortMode.None))
                    if (d != null && d.rootVisualElement != null) n += CountElements(d.rootVisualElement);
                a.Add(new JObject { ["type"] = "ui_element", ["count"] = n });
            }
            return a;
        }
        static int CountElements(UnityEngine.UIElements.VisualElement e)
        {
            int n = 1;
            for (int i = 0; i < e.hierarchy.childCount; i++) n += CountElements(e.hierarchy[i]);
            return n;
        }

        /// <summary>Managed bytes allocated on the main thread since the last frame, or -1 when unknown.</summary>
        long SampleAlloc()
        {
            if (allocByThread)
            {
                try
                {
                    long now = GC.GetAllocatedBytesForCurrentThread(), d = allocLast < 0 ? -1 : now - allocLast;
                    allocLast = now;
                    return d;
                }
                catch { allocByThread = false; }
            }
            return gcAlloc.Valid && (Debug.isDebugBuild || Application.isEditor) ? gcAlloc.LastValue : -1;
        }

        // the working set: Process.WorkingSet64 reads 0 in player builds, so on Windows the OS is asked directly
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessMemoryCounters
        {
            public uint cb, PageFaultCount;
            public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage;
        }
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern bool K32GetProcessMemoryInfo(IntPtr process, out ProcessMemoryCounters counters, uint size);
#endif
        /// <summary>Process working set in MB, or null when the platform does not say.</summary>
        static double? WorkingSetMb()
        {
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
            try
            {
                if (K32GetProcessMemoryInfo(GetCurrentProcess(), out var c, (uint)Marshal.SizeOf<ProcessMemoryCounters>()) && c.WorkingSetSize.ToUInt64() > 0)
                    return c.WorkingSetSize.ToUInt64() / 1048576.0;
            }
            catch { /* fall through */ }
#endif
            try { using (var proc = System.Diagnostics.Process.GetCurrentProcess()) { long ws = proc.WorkingSet64; if (ws > 0) return ws / 1048576.0; } } catch { }
            return null;
        }

        /// <summary>Once per frame after <see cref="Frame"/>: closes the minute and sends what is due.</summary>
        public void Step(double now, GameConnection net, Session.ClientSession session)
        {
            bool ready = net != null && net.State == GameConnection.Status.Ready && net.ServerTelemetry;
            if (!Enabled)
            {
                if (ready && !optOutSent) { optOutSent = true; net.Send(new JObject { ["t"] = "telemetry", ["optOut"] = true }); }
                return;
            }
            if (minuteStart < 0) return;
            if (net != lastNet) { lastNet = net; bytesStart = net?.Link.BytesIn ?? 0; snapshotsStart = session?.Snapshots ?? 0; Baseline(session); }   // a new connection: new baselines
            if (now - minuteStart >= MinuteSeconds)
            {
                if (any && frames > 0) { Enqueue(MinuteRow(now, net, session)); minutesSent++; }
                bytesStart = net?.Link.BytesIn ?? 0;
                snapshotsStart = session?.Snapshots ?? 0;
                Baseline(session);
                Begin(now, phaseNames);
            }
            if (!ready) return;
            if (!sessionSent) { sessionSent = true; Enqueue(SessionRow(now)); }
            lock (errorGate)
            {
                foreach (var e in errorsPending.Values) { if (errorRowsThisMinute++ >= MaxErrorRowsPerMinute) break; Enqueue(e); }
                errorsPending.Clear();
            }
            if (queued.Count == 0) return;
            var rows = new JArray();
            foreach (var r in queued) rows.Add(r);
            queued.Clear();
            net.Send(new JObject { ["t"] = "telemetry", ["install"] = InstallId, ["build"] = Build, ["version"] = Version, ["platform"] = Platform, ["rows"] = rows });
        }

        Session.ClientSession timedSession;
        void Baseline(Session.ClientSession session)
        {
            timedSession = session;
            if (session == null) return;
            decodeStart = session.SnapshotDecodeMsTotal; applyStart = session.SnapshotApplyMsTotal; resyncStart = session.KeyedResyncs;
            session.SnapshotDecodeMsMax = 0; session.SnapshotApplyMsMax = 0;
        }

        void Enqueue(JObject row)
        {
            row["event_time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            queued.Add(row);
            if (queued.Count > MaxQueuedRows) queued.RemoveAt(0);
        }

        double Percentile(double p)
        {
            int target = (int)Math.Ceiling(p * frames), n = 0;
            for (int i = 0; i <= Bins; i++) { n += hist[i]; if (n >= target) return i == Bins ? frameMax : (i + 0.5) * 0.5; }
            return frameMax;
        }

        JObject MinuteRow(double now, GameConnection net, Session.ClientSession session)
        {
            mainSamples.Sort();
            double seconds = now - minuteStart;
            var phases = new JArray();
            if (phaseNames != null && phaseSum != null)
                for (int k = 0; k < phaseNames.Length; k++) phases.Add(new JObject { ["name"] = phaseNames[k], ["avg_ms"] = Round(phaseSum[k] / frames), ["max_ms"] = Round(phaseMax[k]) });
            int band = 0; for (int i = 1; i < 4; i++) if (bandTime[i] > bandTime[band]) band = i;
            double cpuPct = 0;
            try
            {
                using (var p = System.Diagnostics.Process.GetCurrentProcess())
                    cpuPct = (p.TotalProcessorTime - cpuStart).TotalSeconds / Math.Max(1, seconds) * 100.0;
            }
            catch { /* not available on this platform */ }
            double? memMb = WorkingSetMb();
            var units = session?.Units;
            int snaps = session != null ? session.Snapshots - snapshotsStart : 0;
            bool timed = session != null && session == timedSession && snaps > 0;
            var row = new JObject
            {
                ["table"] = "client_minute", ["in_match"] = liveFrames * 2 >= frames, ["wall_s"] = Round(seconds), ["frames"] = frames,
                ["fps_avg"] = Round(frames / Math.Max(0.001, frameSum / 1000.0)),
                ["frame_ms_p50"] = Percentile(.5), ["frame_ms_p95"] = Percentile(.95), ["frame_ms_p99"] = Percentile(.99), ["frame_ms_max"] = Round(frameMax),
                ["frames_over_33ms"] = over33, ["frames_over_50ms"] = over50, ["frames_over_100ms"] = over100,
                ["main_ms_avg"] = Round(mainSum / frames), ["main_ms_p95"] = Round(mainSamples.Count > 0 ? mainSamples[Math.Min(mainSamples.Count - 1, (int)(mainSamples.Count * .95))] : 0),
                ["cpu_frame_ms_avg"] = cpuN > 0 ? (JToken)Round(cpuSum / cpuN) : null, ["gpu_frame_ms_avg"] = gpuN > 0 ? (JToken)Round(gpuSum / gpuN) : null,
                ["phases"] = phases,
                ["gc_alloc_kb_per_frame"] = allocN > 0 ? (JToken)Round(allocSum / allocN / 1024.0) : null, ["gc_collections"] = GC.CollectionCount(0) - gcStart,
                ["mono_heap_mb"] = Round(UnityEngine.Profiling.Profiler.GetMonoUsedSizeLong() / 1048576.0),
                ["total_alloc_mb"] = Round(UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong() / 1048576.0),
                ["process_mem_mb"] = memMb.HasValue ? (JToken)Round(memMb.Value) : null, ["process_cpu_pct"] = Round(cpuPct),
                ["zoom_band"] = new[] { "close", "mid", "far", "strategic" }[band], ["camera_distance"] = Round(distSum / frames),
                ["visible_units"] = visibleSum / frames, ["units_known"] = units?.Count ?? 0,
                ["net_bytes_in"] = net != null ? net.Link.BytesIn - bytesStart : 0, ["snapshots"] = session != null ? session.Snapshots - snapshotsStart : 0,
                ["rtt_ms"] = net != null ? (JToken)Round(net.RttMs) : null, ["interp_delay_ms"] = interpN > 0 ? (JToken)Round(interpSum / interpN * 1000.0) : null,
                ["game_speed"] = session?.PlayRate ?? 1, ["paused"] = session?.Paused ?? false, ["spectator"] = session?.Spectator ?? false,
                ["game_pace"] = session != null && session.Pace >= 0 ? (JToken)Round(session.Pace) : null,
                ["snapshot_decode_ms_avg"] = timed ? (JToken)Round((session.SnapshotDecodeMsTotal - decodeStart) / snaps) : null,
                ["snapshot_decode_ms_max"] = timed ? (JToken)Round(session.SnapshotDecodeMsMax) : null,
                ["snapshot_apply_ms_avg"] = timed ? (JToken)Round((session.SnapshotApplyMsTotal - applyStart) / snaps) : null,
                ["snapshot_apply_ms_max"] = timed ? (JToken)Round(session.SnapshotApplyMsMax) : null,
                ["keyed_resyncs"] = session != null && session == timedSession ? session.KeyedResyncs - resyncStart : 0,
                ["quality"] = Quality(), ["resolution"] = Screen.width + "x" + Screen.height,
                // v3 (Pass 7)
                ["main_thread_ms_avg"] = mainThreadN > 0 ? (JToken)Round(mainThreadSum / mainThreadN) : null,
                ["render_thread_ms_avg"] = renderThreadN > 0 ? (JToken)Round(renderThreadSum / renderThreadN) : null,
                ["present_wait_ms_avg"] = presentWaitN > 0 ? (JToken)Round(presentWaitSum / presentWaitN) : null,
                ["untracked_ms_avg"] = untrackedN > 0 ? (JToken)Round(untrackedSum / untrackedN) : null,
                ["loop_phases"] = LoopPhases(),
                ["objects"] = ObjectCounts(),
                ["post_match_s"] = Round(postMatchS),
            };
            for (int k = 0; k < RenderKeys.Length; k++) row[RenderKeys[k]] = renderN[k] > 0 ? (JToken)Round(renderSum[k] / renderN[k]) : null;
            return row;
        }

        JArray LoopPhases()
        {
            var a = new JArray();
            if (loopN == 0) return a;
            for (int k = 0; k < loopSum.Length; k++) a.Add(new JObject { ["name"] = FrameLoopTimer.Names[k], ["avg_ms"] = Round(loopSum[k] / loopN), ["max_ms"] = Round(loopMax[k]) });
            return a;
        }

        static JObject SessionRow(double now)
        {
            double? memMb = WorkingSetMb();
            return new JObject
            {
                ["table"] = "client_session", ["os"] = SystemInfo.operatingSystem, ["os_family"] = SystemInfo.operatingSystemFamily.ToString(),
                ["cpu_model"] = SystemInfo.processorType, ["cpu_cores"] = SystemInfo.processorCount, ["cpu_mhz"] = SystemInfo.processorFrequency, ["ram_mb"] = SystemInfo.systemMemorySize,
                ["gpu_model"] = SystemInfo.graphicsDeviceName, ["gpu_vendor"] = SystemInfo.graphicsDeviceVendor, ["gpu_vram_mb"] = SystemInfo.graphicsMemorySize,
                ["graphics_api"] = SystemInfo.graphicsDeviceType.ToString(), ["graphics_version"] = SystemInfo.graphicsDeviceVersion,
                ["resolution"] = Screen.width + "x" + Screen.height, ["refresh_hz"] = Round(Screen.currentResolution.refreshRateRatio.value),
                ["fullscreen"] = Screen.fullScreenMode.ToString(), ["quality"] = Quality(), ["vsync"] = QualitySettings.vSyncCount, ["target_fps"] = Application.targetFrameRate,
                ["unity_version"] = Application.unityVersion, ["editor"] = Application.isEditor, ["debug_build"] = Debug.isDebugBuild,
                ["process_mem_mb"] = memMb.HasValue ? (JToken)Round(memMb.Value) : null, ["startup_s"] = Round(Time.realtimeSinceStartupAsDouble),
            };
        }

        static string Quality() => QualitySettings.names.Length > 0 ? QualitySettings.names[QualitySettings.GetQualityLevel()] : "";
        static double Round(double v) => double.IsNaN(v) || double.IsInfinity(v) ? 0 : Math.Round(v, 3);

        // ------------------------------------------------------------------ exceptions (any thread)
        static void OnLog(string message, string stack, LogType type)
        {
            if (type != LogType.Exception && type != LogType.Assert) return;
            if (!enabledFlag) return;
            string hash = Hash(StripNumbers(stack ?? "") + "|" + FirstLine(message));
            lock (errorGate)
            {
                if (errorsPending.TryGetValue(hash, out var row)) { row["count"] = (int)row["count"] + 1; return; }
                if (errorsSeen.Contains(hash) || errorsSeen.Count >= MaxErrorsPerSession) return;   // one row per distinct error per session
                errorsSeen.Add(hash);
                errorsPending[hash] = new JObject
                {
                    ["table"] = "client_errors", ["kind"] = type == LogType.Exception ? "exception" : "assert", ["message"] = Scrub(Truncate(message, 300)),
                    ["stack_hash"] = hash, ["top_frame"] = Scrub(Truncate(FirstLine(stack), 200)), ["count"] = 1, ["in_match"] = inMatchFlag,
                };
            }
        }

        static string FirstLine(string s) { if (string.IsNullOrEmpty(s)) return ""; int i = s.IndexOf('\n'); return (i < 0 ? s : s.Substring(0, i)).Trim(); }
        static string Truncate(string s, int n) => s == null ? "" : s.Length <= n ? s : s.Substring(0, n);
        static string StripNumbers(string s)
        {
            var sb = new StringBuilder(s.Length);
            foreach (char c in s) if (!char.IsDigit(c)) sb.Append(c);
            return sb.ToString();
        }
        /// <summary>User names inside paths never leave the machine (the server scrubs again).</summary>
        internal static string Scrub(string s) => System.Text.RegularExpressions.Regex.Replace(
            System.Text.RegularExpressions.Regex.Replace(s ?? "", @"([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s""']+", "$1<user>", System.Text.RegularExpressions.RegexOptions.IgnoreCase),
            @"(/(?:home|Users)/)[^/\s""']+", "$1<user>");
        static string Hash(string s)
        {
            unchecked
            {
                ulong h = 14695981039346656037UL;
                foreach (char c in s) { h ^= c; h *= 1099511628211UL; }
                return h.ToString("x16");
            }
        }
    }
}
