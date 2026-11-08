using System.IO;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SE.Core.Protocol;
using SE.Core.Stress;
using SE.Core.Units;
using SE.Core.World;
using SE.Runtime.App;
using SE.Runtime.Rendering;
using UnityEngine;

namespace SE.Tests
{
    /// <summary>
    /// EditMode checks of the client core inside Unity (the full server-parity suite also runs as plain
    /// .NET in unity/Tests.Standalone, against fixtures produced by the server).
    /// </summary>
    public class CoreTests
    {
        [Test]
        public void HexNeighboursWrapEastWest()
        {
            var g = new HexGrid(64, 64, true);
            Assert.AreEqual(0, g.Neighbor(63, 0), "east of the last column is the first");
            Assert.AreEqual(63, g.Neighbor(0, 3), "west of the first column is the last");
            Assert.AreEqual(1, g.Dist(0, 63));
            Assert.AreEqual(5, g.TileAt(g.CenterX(5) + g.Period * 2, g.CenterZ(5)));
        }

        [Test]
        public void MapToUnitySpaceKeepsEastOnTheRight()
        {
            // looking north in Unity (+z), east (+x) must be on the right: the map is not mirrored
            var look = Quaternion.Euler(60, 0, 0);
            Assert.Greater((look * Vector3.right).x, 0.99f);
            var north = MapSpace.ToUnity(new Vector3(0, 0, -10));
            Assert.Greater(north.z, 0, "map north (−z) is Unity +z");
            Assert.AreEqual(0f, Mathf.DeltaAngle(MapSpace.Yaw(MapSpace.MapYaw(1, 0)) * Mathf.Rad2Deg, 90f), 0.01f, "a heading due east faces Unity +x");
        }

        [Test]
        public void StressWorldIsContinuousAndRiversNeverStop()
        {
            var gen = StressWorld.Generate(128, 3);
            var w = new WorldModel();
            w.Reset(128, 128, true);
            w.ApplyGeo(gen.Geo);
            int dead = 0;
            for (int i = 0; i < w.Grid.N; i++)
            {
                if (!w.IsRiver(i)) continue;
                int d = w.FlowDir(i);
                int nb = d >= 0 ? w.Grid.Nb[i * 6 + d] : -1;
                if (nb < 0 || !(w.IsRiver(nb) || w.IsLake(nb) || w.IsSea(nb))) dead++;
            }
            Assert.AreEqual(0, dead);
            Assert.AreEqual(w.GroundHeight(0.3f, 20f), w.GroundHeight(0.3f + w.Grid.Period, 20f), 1e-4f);
            w.Dispose();
        }

        [Test]
        public void DeltaSnapshotsKeepUnchangedUnits()
        {
            var store = new UnitStore(new UnitTypes());
            store.Reset(new HexGrid(32, 32, true));
            store.Apply(ProtocolDecoder.Decode("{\"t\":\"s\",\"time\":1,\"units\":[[1,0,\"tank\",5,-1,0,100,50,0],[2,0,\"rifle_squad\",6,-1,0,100,50,0]],\"paths\":{}}").Snapshot);
            store.Apply(ProtocolDecoder.Decode("{\"t\":\"s\",\"time\":1.2,\"d\":1,\"units\":[[1,0,\"tank\",7,-1,0,90,50,0]],\"paths\":{}}").Snapshot);
            Assert.AreEqual(2, store.Count, "a delta that omits unit 2 must keep it");
            Assert.IsTrue(store.TryGet(1, out var t) && t.Tile == 7 && t.Hp == 90);
            store.Apply(ProtocolDecoder.Decode("{\"t\":\"s\",\"time\":1.4,\"d\":1,\"units\":[],\"ug\":[2],\"paths\":{}}").Snapshot);
            Assert.AreEqual(1, store.Count, "ids in ug leave view");
        }

        [Test]
        public void ServerFixturesWhenPresent()
        {
            var file = Path.Combine(Application.dataPath, "..", "Tests.Standalone", "fixtures.json");
            if (!File.Exists(file)) Assert.Ignore("run node unity/Tests.Standalone/make-fixtures.mjs to generate server fixtures");
            var fx = JObject.Parse(File.ReadAllText(file));
            var g = new HexGrid((int)fx["W"], (int)fx["H"], (bool)fx["wrap"]);
            foreach (JArray row in fx["dists"]) Assert.AreEqual((int)row[2], g.Dist((int)row[0], (int)row[1]));
        }

        [Test]
        public void LaunchOptionsAcceptBothStyles()
        {
            var o = LaunchOptions.Parse(new[] { "exe", "-mode", "stress", "--perf=20", "--perf-zooms", "14,40" });
            Assert.AreEqual("stress", o.Get("mode"));
            Assert.AreEqual(20f, o.Float("perf", 0));
            Assert.AreEqual(2, o.Floats("perf-zooms").Length);
        }
    }
}
