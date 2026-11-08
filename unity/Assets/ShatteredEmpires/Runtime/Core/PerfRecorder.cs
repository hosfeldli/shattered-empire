using System.Collections.Generic;
using System.IO;
using SE.Core.Diagnostics;
using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// Records frame pacing for the M2 gate: whole-frame time (what the player feels), CPU and GPU
    /// frame time from FrameTimingManager, long stalls, and per-segment breakdowns so a missed target
    /// names where it was missed. Writes one JSON report.
    /// </summary>
    public sealed class PerfRecorder
    {
        sealed class Segment
        {
            public readonly FrameStats Frame = new FrameStats();
            public readonly SampleRing Cpu = new SampleRing(36000);
            public readonly SampleRing Gpu = new SampleRing(36000);
            public readonly SampleRing Main = new SampleRing(36000);
            public long PeakMemory;
        }

        readonly Dictionary<string, Segment> segments = new Dictionary<string, Segment>();
        readonly List<string> order = new List<string>();
        readonly Segment overall = new Segment();
        Segment current;
        readonly FrameTiming[] timings = new FrameTiming[1];
        public bool Recording => current != null;

        public void Begin(string name)
        {
            if (!segments.TryGetValue(name, out current))
            {
                current = new Segment();
                segments[name] = current;
                order.Add(name);
            }
        }

        public void Pause() => current = null;

        /// <summary>Call once per frame with the frame's duration and the main thread's own work.</summary>
        public void Sample(double frameMs, double mainThreadMs)
        {
            FrameTimingManager.CaptureFrameTimings();
            double cpu = 0, gpu = 0;
            if (FrameTimingManager.GetLatestTimings(1, timings) > 0) { cpu = timings[0].cpuFrameTime; gpu = timings[0].gpuFrameTime; }
            if (current == null) return;
            long mem = System.GC.GetTotalMemory(false) + UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong();
            foreach (var s in new[] { current, overall })
            {
                s.Frame.Add(frameMs);
                s.Main.Add(mainThreadMs);
                if (cpu > 0) s.Cpu.Add(cpu);
                if (gpu > 0) s.Gpu.Add(gpu);
                if (mem > s.PeakMemory) s.PeakMemory = mem;
            }
        }

        static void Write(JsonOut j, string key, Segment s)
        {
            j.Begin(key);
            j.Dist("frame_ms", s.Frame.Frames).Dist("cpu_ms", s.Cpu).Dist("gpu_ms", s.Gpu).Dist("main_thread_ms", s.Main);
            j.Num("fps_avg", s.Frame.Frames.Average() > 0 ? 1000.0 / s.Frame.Frames.Average() : 0);
            j.Num("frames_over_33ms", s.Frame.Over33).Num("frames_over_50ms", s.Frame.Over50).Num("stalls_over_100ms", s.Frame.Over100);
            j.Num("longest_frame_ms", s.Frame.LongestStallMs).Num("peak_memory_mb", s.PeakMemory / 1048576.0);
            j.End();
        }

        public string Report(System.Action<JsonOut> meta)
        {
            var j = new JsonOut().Begin();
            j.Begin("meta");
            j.Str("engine", "unity").Str("unity", Application.unityVersion).Str("gpu", SystemInfo.graphicsDeviceName).Str("gpu_api", SystemInfo.graphicsDeviceType.ToString())
                .Str("cpu", SystemInfo.processorType).Num("cpu_cores", SystemInfo.processorCount).Num("ram_mb", SystemInfo.systemMemorySize).Num("vram_mb", SystemInfo.graphicsMemorySize)
                .Str("resolution", Screen.width + "x" + Screen.height).Str("quality", QualitySettings.names.Length > 0 ? QualitySettings.names[QualitySettings.GetQualityLevel()] : "")
                .Num("vsync", QualitySettings.vSyncCount).Bool("editor", Application.isEditor);
            meta?.Invoke(j);
            j.End();
            Write(j, "overall", overall);
            j.Begin("segments");
            foreach (var name in order) Write(j, name, segments[name]);
            j.End();
            // the M2 targets, evaluated on the whole run
            var f = overall.Frame;
            j.Begin("gate");
            j.Bool("p95_at_or_below_16_7ms", f.Frames.Percentile(0.95) <= 16.7).Bool("p99_below_25ms", f.Frames.Percentile(0.99) < 25)
                .Bool("no_repeated_100ms_stalls", f.Over100 <= 1).Bool("avg_60fps", f.Frames.Average() > 0 && 1000.0 / f.Frames.Average() >= 60);
            j.End();
            return j.End().ToString();
        }

        public static void Save(string path, string json)
        {
            if (string.IsNullOrEmpty(path)) { Debug.Log("PERF " + json); return; }
            var dir = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, json);
            Debug.Log("PERF report written to " + path);
        }
    }
}
