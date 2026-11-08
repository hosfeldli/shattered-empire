using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using SE.Core.Diagnostics;

namespace SE.Core.Protocol
{
    /// <summary>
    /// Request ids, pending commands and their replies. Each command gets a callback with the server's
    /// reply (or a timeout error), and the acknowledgment latency is recorded for the performance gate.
    /// </summary>
    public sealed class CommandTracker
    {
        public const double TimeoutSeconds = 6.0;

        public struct Pending
        {
            public double SentAt;
            public string Name;
            public JObject Command;
            public Action<ServerMessage> Callback;
        }

        int nextRid = 1;
        readonly Dictionary<int, Pending> pending = new Dictionary<int, Pending>();
        readonly List<int> expired = new List<int>();
        public readonly SampleRing AckMs = new SampleRing(4096);
        public int Timeouts { get; private set; }
        public int Errors { get; private set; }
        public int InFlight => pending.Count;

        /// <summary>Raised for every resolved command (presentation cues listen here).</summary>
        public event Action<JObject, ServerMessage> Resolved;

        public int Register(JObject command, Action<ServerMessage> callback, double now)
        {
            int rid = nextRid++;
            pending[rid] = new Pending { SentAt = now, Name = (string)command["c"] ?? "?", Command = command, Callback = callback };
            return rid;
        }

        public bool IsPending(int rid) => pending.ContainsKey(rid);

        /// <summary>Match a reply to its command. Returns false when the rid is unknown (e.g. after a timeout).</summary>
        public bool Resolve(ServerMessage reply, double now)
        {
            if (reply.Rid < 0 || !pending.TryGetValue(reply.Rid, out var p)) return false;
            pending.Remove(reply.Rid);
            AckMs.Add((now - p.SentAt) * 1000.0);
            if (reply.Error != null) Errors++;
            p.Callback?.Invoke(reply);
            Resolved?.Invoke(p.Command, reply);
            return true;
        }

        public void Expire(double now)
        {
            expired.Clear();
            foreach (var kv in pending) if (now - kv.Value.SentAt > TimeoutSeconds) expired.Add(kv.Key);
            foreach (int rid in expired)
            {
                var p = pending[rid];
                pending.Remove(rid);
                Timeouts++;
                var m = new ServerMessage { T = "ack", Rid = rid, Error = "The server did not answer in time" };
                p.Callback?.Invoke(m);
                Resolved?.Invoke(p.Command, m);
            }
        }

        public void Clear() => pending.Clear();
    }
}
