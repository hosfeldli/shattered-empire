using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace SE.Core.Diagnostics
{
    /// <summary>A fixed-size ring of samples with percentile queries (no per-sample allocation).</summary>
    public sealed class SampleRing
    {
        readonly double[] data;
        double[] scratch;
        int head, count;
        public long Total { get; private set; }

        public SampleRing(int capacity) { data = new double[capacity]; scratch = new double[capacity]; }

        public int Count => count;

        public void Add(double v)
        {
            data[head] = v;
            head = (head + 1) % data.Length;
            if (count < data.Length) count++;
            Total++;
        }

        public void Clear() { head = 0; count = 0; Total = 0; }

        public double Percentile(double p)
        {
            if (count == 0) return 0;
            if (scratch.Length < count) scratch = new double[data.Length];
            Array.Copy(data, scratch, count);
            Array.Sort(scratch, 0, count);
            int i = (int)Math.Min(count - 1, Math.Floor(p * count));
            return scratch[i];
        }

        public double Average()
        {
            if (count == 0) return 0;
            double s = 0;
            for (int i = 0; i < count; i++) s += data[i];
            return s / count;
        }

        public double Max()
        {
            double m = 0;
            for (int i = 0; i < count; i++) m = Math.Max(m, data[i]);
            return m;
        }
    }

    /// <summary>
    /// Frame pacing as the migration gate measures it: frame-time distribution, long stalls and their
    /// count. Every recorded value is a whole frame (CPU and GPU waits included), not just script time.
    /// </summary>
    public sealed class FrameStats
    {
        public readonly SampleRing Frames = new SampleRing(36000);
        public int Over33, Over50, Over100;
        public double LongestStallMs;

        public void Add(double ms)
        {
            Frames.Add(ms);
            if (ms > 33.4) Over33++;
            if (ms > 50) Over50++;
            if (ms > 100) Over100++;
            LongestStallMs = Math.Max(LongestStallMs, ms);
        }

        public void Clear()
        {
            Frames.Clear();
            Over33 = Over50 = Over100 = 0;
            LongestStallMs = 0;
        }
    }

    /// <summary>Minimal JSON writer for benchmark reports (no reflection, invariant culture).</summary>
    public sealed class JsonOut
    {
        readonly StringBuilder sb = new StringBuilder();
        readonly Stack<bool> first = new Stack<bool>();

        public JsonOut Begin() { Sep(); sb.Append('{'); first.Push(true); return this; }
        public JsonOut Begin(string key) { Key(key); sb.Append('{'); first.Push(true); return this; }
        public JsonOut End() { first.Pop(); sb.Append('}'); return this; }

        public JsonOut Num(string key, double v)
        {
            Key(key);
            sb.Append(double.IsNaN(v) || double.IsInfinity(v) ? "null" : Math.Round(v, 3).ToString("R", CultureInfo.InvariantCulture));
            return this;
        }

        public JsonOut Str(string key, string v) { Key(key); Quote(v); return this; }
        public JsonOut Bool(string key, bool v) { Key(key); sb.Append(v ? "true" : "false"); return this; }

        public JsonOut Dist(string key, SampleRing r)
        {
            Begin(key);
            Num("avg", r.Average()).Num("p50", r.Percentile(0.5)).Num("p95", r.Percentile(0.95)).Num("p99", r.Percentile(0.99)).Num("max", r.Max()).Num("samples", r.Count);
            return End();
        }

        void Sep()
        {
            if (first.Count == 0) return;
            if (first.Peek()) { first.Pop(); first.Push(false); }
            else sb.Append(',');
        }

        void Key(string k) { Sep(); Quote(k); sb.Append(':'); }

        void Quote(string s)
        {
            sb.Append('"');
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            sb.Append('"');
        }

        public override string ToString() => sb.ToString();
    }
}
