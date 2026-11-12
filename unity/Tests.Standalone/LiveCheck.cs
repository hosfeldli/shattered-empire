using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using Newtonsoft.Json.Linq;
using SE.Core.Diagnostics;
using SE.Core.Protocol;
using SE.Core.Units;
using SE.Core.World;
using SE.Net;

/// <summary>
/// End-to-end check of the Unity client's networking against a running server, without the Editor:
/// handshake and capabilities, a sandbox match, terrain geometry, snapshot and delta application,
/// the 1,000-unit 'massive' battle staged through server commands, command acknowledgment latency,
/// and a dropped connection that rejoins the same seat.
///   dotnet run --project unity/Tests.Standalone -- --live ws://127.0.0.1:8141/ws [seconds]
/// </summary>
static class LiveCheck
{
    public static int Run(string url, int seconds, string ruleset = "native-v4")
    {
        var clock = Stopwatch.StartNew();
        double Now() => clock.Elapsed.TotalSeconds;
        var conn = new GameConnection(Now);
        var world = new WorldModel();
        var units = new UnitStore(new UnitTypes());
        var structures = new StructureStore();
        var dirty = new HashSet<int>();
        var applyMs = new SampleRing(10000);
        int welcomes = 0, geos = 0, snaps = 0, deltas = 0, maxUnits = 0;
        string error = null;
        bool staged = false, dropped = false, rejoined = false;
        JArray sideA = null;
        int arena = -1;

        conn.Message += m =>
        {
            var sw = Stopwatch.StartNew();
            switch (m.T)
            {
                case "welcome":
                    welcomes++;
                    world.Reset(m.Welcome.W, m.Welcome.H, m.Welcome.Wrap);
                    units.Reset(world.Grid);
                    structures.Clear();
                    if (dropped) rejoined = true;
                    if (!staged)
                    {
                        staged = true;
                        conn.Command(new JObject { ["c"] = "sandbox", ["op"] = "scenario", ["key"] = "massive" }, r =>
                        {
                            var sc = r.Raw?["scenario"] as JObject;
                            if (sc == null) { error = "scenario refused: " + (r.Error ?? r.Raw?.ToString()); return; }
                            sideA = sc["A"] as JArray;
                            arena = (int)sc["arena"];
                            var all = sideA.Select(t => (int)t).ToArray();
                            conn.Command(new JObject { ["c"] = "fortify", ["units"] = new JArray(all.Take(all.Length / 3)) });
                            conn.Command(new JObject { ["c"] = "move", ["units"] = new JArray(all.Skip(all.Length / 3)), ["tile"] = arena, ["attackMove"] = true });
                        });
                    }
                    break;
                case "geo":
                    if (world.Ready) { world.ApplyGeo(m.Geo); geos++; }
                    break;
                case "s":
                    if (!world.Ready) break;
                    var s = m.Snapshot;
                    snaps++;
                    if (s.Delta) deltas++;
                    if (s.Reset) { world.Reset(world.Grid.W, world.Grid.H, world.Grid.Wrap); units.Reset(world.Grid); }
                    if (s.Tiles != null) world.ApplyTiles(s.Tiles, null);
                    if (s.Visibility != null) world.ApplyVisibility(s.Visibility);
                    units.Apply(s);
                    if (s.HasEcon && s.Buildings != null) structures.ApplyBuildings(s.Buildings, world, dirty);
                    maxUnits = Math.Max(maxUnits, units.Count);
                    applyMs.Add(sw.Elapsed.TotalMilliseconds);
                    break;
                case "error":
                    error = m.Error;
                    break;
            }
        };
        conn.Connect(url);
        conn.Send(new JObject { ["t"] = "create", ["mode"] = "sandbox", ["name"] = "UnityCheck", ["ruleset"] = ruleset, ["ais"] = 1, ["seed"] = 41 });

        double end = Now() + seconds, probeAt = 0, dropAt = Now() + seconds * 0.6;
        int probes = 0;
        while (Now() < end && error == null)
        {
            conn.Update(8.0);
            units.AdvanceClock(0.016f, 1f, false);
            // a read-only command through the simulation worker measures acknowledgment latency
            if (conn.State == GameConnection.Status.Ready && welcomes > 0 && Now() > probeAt)
            {
                probeAt = Now() + 0.5;
                probes++;
                conn.Command(ruleset.StartsWith("action-") ? new JObject { ["c"] = "hold", ["units"] = new JArray() } : new JObject { ["c"] = "stance", ["units"] = new JArray(), ["stance"] = "defensive" });
            }
            if (!dropped && Now() > dropAt && snaps > 20)
            {
                dropped = true;
                conn.Link.Dispose();   // simulate a dropped connection; the client must rejoin its seat
            }
            Thread.Sleep(16);
        }
        conn.Close();
        var ack = conn.Commands.AckMs;
        Console.WriteLine($"live: proto {conn.ProtocolVersion} caps [{string.Join(",", conn.Capabilities)}] server {conn.ServerVersion}");
        Console.WriteLine($"live: {welcomes} welcomes, {geos} geo, {snaps} snapshots ({deltas} deltas), up to {maxUnits} units, {structures.Buildings.Count} buildings");
        Console.WriteLine($"live: apply p50 {applyMs.Percentile(.5):F2} ms p99 {applyMs.Percentile(.99):F2} ms max {applyMs.Max():F2} ms; decode last {conn.Link.LastDecodeMs:F2} ms");
        Console.WriteLine($"live: command ack p50 {ack.Percentile(.5):F1} ms p95 {ack.Percentile(.95):F1} ms max {ack.Max():F1} ms over {ack.Count} replies ({probes} probes, {conn.Commands.Timeouts} timeouts)");
        int fail = 0;
        void Expect(bool ok, string what) { if (!ok) { fail++; Console.WriteLine("FAIL live: " + what); } }
        Expect(error == null, "no server error (" + error + ")");
        Expect(conn.Capabilities.Contains("geo") && conn.Capabilities.Contains("udelta"), "geo and udelta negotiated");
        Expect(geos > 0 && snaps > 20 && deltas > snaps / 2, "geometry and delta snapshots received");
        Expect(sideA != null && maxUnits >= 900, $"massive battle staged ({maxUnits} units)");
        Expect(rejoined && welcomes >= 2, "dropped connection rejoined the same seat");
        Expect(conn.Commands.Timeouts == 0, "no command timed out");
        Expect(ack.Percentile(.95) < 250, "command acknowledgment p95 under 250 ms");
        Console.WriteLine(fail == 0 ? "OK: live checks passed" : $"{fail} live checks FAILED");
        return fail == 0 ? 0 : 1;
    }
}
