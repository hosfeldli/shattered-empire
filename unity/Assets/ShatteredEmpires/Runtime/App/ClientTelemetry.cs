using System;
using System.Collections.Generic;
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
        int cpuN, gpuN, allocN, interpN;
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
        readonly FrameTiming[] timing = new FrameTiming[1];

        public ClientTelemetry()
        {
            Identify();
            if (!errorHook) { errorHook = true; Application.logMessageReceivedThreaded += OnLog; }
        }

        /// <summary>Once per frame (end of GameBootstrap.Update).</summary>
        public void Frame(double now, double frameMs, double mainMs, bool inMatch, string[] names, double[] phaseMs, float camDistance, int visibleUnits, float interpDelayS)
        {
            inMatchFlag = inMatch; enabledFlag = Enabled;
            if (!Enabled) { if (gcAlloc.Valid) gcAlloc.Dispose(); minuteStart = -1; any = false; return; }
            if (!gcAlloc.Valid) gcAlloc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
            if (minuteStart < 0) Begin(now, names);
            if (!inMatch) return;
            any = true;
            frames++;
            frameSum += frameMs; if (frameMs > frameMax) frameMax = frameMs;
            hist[Math.Min(Bins, (int)(frameMs * 2))]++;
            if (frameMs > 33.4) over33++;
            if (frameMs > 50) over50++;
            if (frameMs > 100) over100++;
            mainSum += mainMs; if (mainSamples.Count < 16384) mainSamples.Add(mainMs);
            if (FrameTimingManager.GetLatestTimings(1, timing) > 0)
            {
                if (timing[0].cpuFrameTime > 0) { cpuSum += timing[0].cpuFrameTime; cpuN++; }
                if (timing[0].gpuFrameTime > 0) { gpuSum += timing[0].gpuFrameTime; gpuN++; }
            }
            if (gcAlloc.Valid) { allocSum += gcAlloc.LastValue; allocN++; }
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
            cpuN = gpuN = allocN = interpN = 0; visibleSum = 0;
            mainSamples.Clear();
            Array.Clear(bandTime, 0, bandTime.Length);
            if (names != null && (phaseNames == null || phaseNames.Length != names.Length)) { phaseNames = names; phaseSum = new double[names.Length]; phaseMax = new double[names.Length]; }
            else if (phaseSum != null) { Array.Clear(phaseSum, 0, phaseSum.Length); Array.Clear(phaseMax, 0, phaseMax.Length); }
            gcStart = GC.CollectionCount(0);
            errorRowsThisMinute = 0;
            try { cpuStart = System.Diagnostics.Process.GetCurrentProcess().TotalProcessorTime; } catch { cpuStart = TimeSpan.Zero; }
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
            if (net != lastNet) { lastNet = net; bytesStart = net?.Link.BytesIn ?? 0; snapshotsStart = session?.Snapshots ?? 0; }   // a new connection: new baselines
            if (now - minuteStart >= MinuteSeconds)
            {
                if (any && frames > 0) Enqueue(MinuteRow(now, net, session));
                bytesStart = net?.Link.BytesIn ?? 0;
                snapshotsStart = session?.Snapshots ?? 0;
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
            double cpuPct = 0, memMb = 0;
            try
            {
                var p = System.Diagnostics.Process.GetCurrentProcess();
                cpuPct = (p.TotalProcessorTime - cpuStart).TotalSeconds / Math.Max(1, seconds) * 100.0;
                memMb = p.WorkingSet64 / 1048576.0;
            }
            catch { /* not available on this platform */ }
            var units = session?.Units;
            return new JObject
            {
                ["table"] = "client_minute", ["in_match"] = true, ["wall_s"] = Round(seconds), ["frames"] = frames,
                ["fps_avg"] = Round(frames / Math.Max(0.001, frameSum / 1000.0)),
                ["frame_ms_p50"] = Percentile(.5), ["frame_ms_p95"] = Percentile(.95), ["frame_ms_p99"] = Percentile(.99), ["frame_ms_max"] = Round(frameMax),
                ["frames_over_33ms"] = over33, ["frames_over_50ms"] = over50, ["frames_over_100ms"] = over100,
                ["main_ms_avg"] = Round(mainSum / frames), ["main_ms_p95"] = Round(mainSamples.Count > 0 ? mainSamples[Math.Min(mainSamples.Count - 1, (int)(mainSamples.Count * .95))] : 0),
                ["cpu_frame_ms_avg"] = cpuN > 0 ? (JToken)Round(cpuSum / cpuN) : null, ["gpu_frame_ms_avg"] = gpuN > 0 ? (JToken)Round(gpuSum / gpuN) : null,
                ["phases"] = phases,
                ["gc_alloc_kb_per_frame"] = allocN > 0 ? (JToken)Round(allocSum / allocN / 1024.0) : null, ["gc_collections"] = GC.CollectionCount(0) - gcStart,
                ["mono_heap_mb"] = Round(UnityEngine.Profiling.Profiler.GetMonoUsedSizeLong() / 1048576.0),
                ["total_alloc_mb"] = Round(UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong() / 1048576.0),
                ["process_mem_mb"] = Round(memMb), ["process_cpu_pct"] = Round(cpuPct),
                ["zoom_band"] = new[] { "close", "mid", "far", "strategic" }[band], ["camera_distance"] = Round(distSum / frames),
                ["visible_units"] = visibleSum / frames, ["units_known"] = units?.Count ?? 0,
                ["net_bytes_in"] = net != null ? net.Link.BytesIn - bytesStart : 0, ["snapshots"] = session != null ? session.Snapshots - snapshotsStart : 0,
                ["rtt_ms"] = net != null ? (JToken)Round(net.RttMs) : null, ["interp_delay_ms"] = interpN > 0 ? (JToken)Round(interpSum / interpN * 1000.0) : null,
                ["game_speed"] = session?.PlayRate ?? 1, ["paused"] = session?.Paused ?? false, ["spectator"] = session?.Spectator ?? false,
                ["quality"] = Quality(), ["resolution"] = Screen.width + "x" + Screen.height,
            };
        }

        static JObject SessionRow(double now)
        {
            double memMb = 0;
            try { memMb = System.Diagnostics.Process.GetCurrentProcess().WorkingSet64 / 1048576.0; } catch { }
            return new JObject
            {
                ["table"] = "client_session", ["os"] = SystemInfo.operatingSystem, ["os_family"] = SystemInfo.operatingSystemFamily.ToString(),
                ["cpu_model"] = SystemInfo.processorType, ["cpu_cores"] = SystemInfo.processorCount, ["cpu_mhz"] = SystemInfo.processorFrequency, ["ram_mb"] = SystemInfo.systemMemorySize,
                ["gpu_model"] = SystemInfo.graphicsDeviceName, ["gpu_vendor"] = SystemInfo.graphicsDeviceVendor, ["gpu_vram_mb"] = SystemInfo.graphicsMemorySize,
                ["graphics_api"] = SystemInfo.graphicsDeviceType.ToString(), ["graphics_version"] = SystemInfo.graphicsDeviceVersion,
                ["resolution"] = Screen.width + "x" + Screen.height, ["refresh_hz"] = Round(Screen.currentResolution.refreshRateRatio.value),
                ["fullscreen"] = Screen.fullScreenMode.ToString(), ["quality"] = Quality(), ["vsync"] = QualitySettings.vSyncCount, ["target_fps"] = Application.targetFrameRate,
                ["unity_version"] = Application.unityVersion, ["editor"] = Application.isEditor, ["debug_build"] = Debug.isDebugBuild,
                ["process_mem_mb"] = Round(memMb), ["startup_s"] = Round(Time.realtimeSinceStartupAsDouble),
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
