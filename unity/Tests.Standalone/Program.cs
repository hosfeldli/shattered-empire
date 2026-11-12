using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Core.Stress;
using SE.Core.Units;
using SE.Core.World;

// Parity checks for the Unity client's core against the authoritative server (see make-fixtures.mjs).
static class Program
{
    static int failures, checks;

    static void Check(bool ok, string what)
    {
        checks++;
        if (!ok) { failures++; Console.WriteLine("FAIL " + what); }
    }

    static int Main(string[] args)
    {
        if (args.Length > 1 && args[0] == "--live") return LiveCheck.Run(args[1], args.Length > 2 ? int.Parse(args[2]) : 40, args.Length > 3 ? args[3] : "native-v4");
        string file = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "fixtures.json");
        if (!File.Exists(file)) { Console.WriteLine("missing fixtures: run node unity/Tests.Standalone/make-fixtures.mjs"); return 2; }
        var fx = JObject.Parse(File.ReadAllText(file));
        int w = (int)fx["W"], h = (int)fx["H"];
        bool wrap = (bool)fx["wrap"];
        var grid = new HexGrid(w, h, wrap);

        // ---- hex topology
        foreach (JArray row in fx["neighbors"])
        {
            int t = (int)row[0];
            for (int d = 0; d < 6; d++) Check(grid.Nb[t * 6 + d] == (int)row[d + 1], $"neighbour {t}/{d}");
        }
        foreach (JArray row in fx["centers"])
        {
            int t = (int)row[0];
            Check(Math.Abs(grid.CenterX(t) - (float)row[1]) < 1e-3 && Math.Abs(grid.CenterZ(t) - (float)row[2]) < 1e-3, $"centre {t}");
            Check(grid.TileAt(grid.CenterX(t), grid.CenterZ(t)) == t, $"tile_at(centre {t})");
            Check(grid.TileAt(grid.CenterX(t) + grid.Period * 3, grid.CenterZ(t)) == t, $"tile_at wrapped image {t}");
        }
        foreach (JArray row in fx["dists"]) Check(grid.Dist((int)row[0], (int)row[1]) == (int)row[2], $"dist {row[0]}-{row[1]}");
        Console.WriteLine($"hex topology: {checks} checks");

        // ---- terrain geometry: decode the server's message and apply it
        var sw = Stopwatch.StartNew();
        var geoMsg = ProtocolDecoder.Decode((string)fx["geo"]);
        double decodeMs = sw.Elapsed.TotalMilliseconds;
        Check(geoMsg.T == "geo" && geoMsg.Geo != null && geoMsg.Geo.Full, "geo message decodes");
        var world = new WorldModel();
        world.Reset(w, h, wrap);
        sw.Restart();
        var touched = world.ApplyGeo(geoMsg.Geo);
        double applyMs = sw.Elapsed.TotalMilliseconds;
        Check(touched.Count == world.ChunksW * world.ChunksH, "full geo touches every chunk");
        foreach (JArray row in fx["geoSamples"])
        {
            int t = (int)row[0];
            for (int b = 0; b < 6; b++) Check(world.Geo[t * 6 + b] == (int)row[b + 1], $"geo byte {t}/{b}");
        }
        CheckTerrainContinuity(world, "server world");
        Console.WriteLine($"server geo: decode {decodeMs:F1} ms, apply {applyMs:F1} ms");

        // ---- udelta stream: the server's encoder; our store must reproduce every full set
        var store = new UnitStore(new UnitTypes());
        store.Reset(grid);
        var stream = (JArray)fx["stream"];
        var truth = (JArray)fx["truth"];
        int deltas = 0;
        for (int s = 0; s < stream.Count; s++)
        {
            var m = ProtocolDecoder.Decode((string)stream[s]);
            if (m.Snapshot.Delta) deltas++;
            store.Apply(m.Snapshot);
            var expect = (JArray)truth[s];
            bool same = store.Count == expect.Count;
            foreach (JArray e in expect)
            {
                if (!store.TryGet((int)e[0], out var r)) { same = false; break; }
                same &= r.Owner == (int)e[1] && r.Tile == (int)e[2] && r.Next == (int)e[3] && Math.Abs(r.Prog * 100 - (int)e[4]) < 0.5 && r.Hp == (int)e[5];
            }
            Check(same, $"udelta snapshot {s} reconstructs the full unit set");
        }
        Check(deltas > stream.Count / 2, "stream is mostly deltas");
        Console.WriteLine($"udelta: {stream.Count} snapshots ({deltas} deltas) applied");

        // ---- stress world (256×256) and scenario
        sw.Restart();
        var gen = StressWorld.Generate(256, 7);
        double genMs = sw.Elapsed.TotalMilliseconds;
        var big = new WorldModel();
        big.Reset(256, 256, true);
        sw.Restart();
        big.ApplyGeo(gen.Geo);
        double bigApply = sw.Elapsed.TotalMilliseconds;
        int sea = 0, river = 0, lake = 0, mountain = 0, deadEnds = 0;
        for (int i = 0; i < big.Grid.N; i++)
        {
            if (big.IsSea(i)) sea++;
            if (big.IsLake(i)) lake++;
            if (big.Biome[i] >= StressWorld.Mountain) mountain++;
            if (!big.IsRiver(i)) continue;
            river++;
            int d = big.FlowDir(i);
            int nb = d >= 0 ? big.Grid.Nb[i * 6 + d] : -1;
            if (nb < 0 || !(big.IsRiver(nb) || big.IsLake(nb) || big.IsSea(nb))) deadEnds++;
        }
        Check(sea > big.Grid.N / 5 && sea < big.Grid.N * 4 / 5, $"stress world has continents and oceans (sea {sea})");
        Check(river > 200 && mountain > 500, $"stress world has rivers ({river}) and ranges ({mountain})");
        Check(deadEnds == 0, $"every river flows into a river, lake or the sea ({deadEnds} dead ends)");
        CheckTerrainContinuity(big, "stress world");
        Console.WriteLine($"stress world: generate {genMs:F0} ms, apply {bigApply:F0} ms; sea {sea}, rivers {river}, lakes {lake}, mountains {mountain}");

        // Repeated exploration/rejoin updates must not push lake beds farther down.
        // This previously changed the lake level every time geometry was reapplied.
        using (var waterWorld = new WorldModel())
        {
            waterWorld.Reset(256, 256, true);
            waterWorld.ActionLandscape = true;
            waterWorld.ApplyGeo(gen.Geo);
            var firstHeight = (float[])waterWorld.Height.Clone();
            var firstWater = (float[])waterWorld.Water.Clone();
            for (int repeat = 0; repeat < 12; repeat++) waterWorld.RecomputeWater();
            Check(firstHeight.SequenceEqual(waterWorld.Height) && firstWater.SequenceEqual(waterWorld.Water), "action lake basins are idempotent across repeated updates");
            waterWorld.ApplyGeo(gen.Geo);
            Check(firstHeight.SequenceEqual(waterWorld.Height) && firstWater.SequenceEqual(waterWorld.Water), "action lake levels survive a full geometry resend");
            Check(Enumerable.Range(0, waterWorld.Grid.N).Where(waterWorld.IsLake).All(t => waterWorld.Height[t] < waterWorld.Water[t]), "action lake beds remain below their common surface");
        }

        var scenario = new StressScenario(3);
        scenario.Setup(big, 1000, 450);
        var units = new UnitStore(new UnitTypes());
        units.Reset(big.Grid);
        var structures = new StructureStore();
        var dirty = new HashSet<int>();
        var applyTimes = new List<double>();
        int snaps = 0, events = 0;
        for (int frame = 0; frame < 60 * 30; frame++)
        {
            var snap = scenario.Step(1f / 60f);
            if (snap == null) continue;
            snaps++;
            sw.Restart();
            units.Apply(snap);
            if (snap.HasEcon) structures.ApplyBuildings(snap.Buildings, big, dirty);
            applyTimes.Add(sw.Elapsed.TotalMilliseconds);
            events += snap.Events?.Length ?? 0;
            Check(units.Count == scenario.UnitCount, $"stress snapshot {snaps}: {units.Count} units held, {scenario.UnitCount} exist");
        }
        applyTimes.Sort();
        Check(scenario.BuildingCount >= 400, $"city has several hundred buildings ({scenario.BuildingCount})");
        Console.WriteLine($"stress scenario: {snaps} snapshots, {units.Count} units, {structures.Buildings.Count} buildings, {events} combat events; apply p50 {applyTimes[applyTimes.Count / 2]:F3} ms, max {applyTimes[^1]:F3} ms");

        Console.WriteLine(failures == 0 ? $"OK: {checks} checks passed" : $"{failures} of {checks} checks FAILED");
        return failures == 0 ? 0 : 1;
    }

    /// <summary>
    /// The ground must be one continuous surface: sampled from either side, every shared hex edge
    /// (including chunk boundaries and the east-west wrap seam) gives the same height.
    /// </summary>
    static unsafe void CheckTerrainContinuity(WorldModel world, string label)
    {
        var v = world.View;
        var g = world.Grid;
        int bad = 0, samples = 0;
        double worst = 0;
        for (int i = 0; i < g.N; i += 7)
        {
            if (world.Known[i] == 0) continue;
            float cx = g.CenterX(i), cz = g.CenterZ(i);
            float expectCentre = world.Height[i] + v.Relief(i) * (v.Ridge(HexMath.FPosMod(cx, g.Period), cz) - 0.25f);
            Check(Math.Abs(v.GroundHeight(cx, cz) - expectCentre) < 1e-3, $"{label}: centre height of {i}");
            for (int k = 0; k < 6; k++)
            {
                // a point on the edge between corners k and k+1, approached from this hex and from beyond
                int k2 = (k + 1) % 6;
                float ex = cx + (HexMath.CornerX[k] + HexMath.CornerX[k2]) * 0.5f * 0.6f + HexMath.CornerX[k2] * 0.2f;
                float ez = cz + (HexMath.CornerZ[k] + HexMath.CornerZ[k2]) * 0.5f * 0.6f + HexMath.CornerZ[k2] * 0.2f;
                float mx = cx + (HexMath.CornerX[k] * 0.4f + HexMath.CornerX[k2] * 0.6f);
                float mz = cz + (HexMath.CornerZ[k] * 0.4f + HexMath.CornerZ[k2] * 0.6f);
                float ox = mx - cx, oz = mz - cz;
                float inside = v.GroundHeight(cx + ox * 0.9995f, cz + oz * 0.9995f);
                float outside = v.GroundHeight(cx + ox * 1.0005f, cz + oz * 1.0005f);
                int nb = g.TileAt(cx + ox * 1.0005f, cz + oz * 1.0005f);
                if (nb < 0 || world.Known[nb] == 0) continue;
                samples++;
                double diff = Math.Abs(inside - outside);
                worst = Math.Max(worst, diff);
                if (diff > 0.02) bad++;
                _ = ex; _ = ez;
            }
        }
        Check(bad == 0, $"{label}: ground is continuous across hex edges ({bad} of {samples} edge samples jump, worst {worst:F4})");
        // the wrap seam: the same point in two images has the same height
        for (int r = 0; r < g.H; r += 5)
        {
            float z = r * 1.5f + 0.3f;
            Check(Math.Abs(v.GroundHeight(0.2f, z) - v.GroundHeight(0.2f + g.Period, z)) < 1e-4, $"{label}: wrap seam row {r}");
        }
    }
}
