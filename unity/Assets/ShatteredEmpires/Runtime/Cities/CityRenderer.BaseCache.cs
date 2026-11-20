using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Base compose cache (W2-C, 2026-11-16). A held base's compound (ring road, causeways, entrances, foundation,
    /// pads, docking arms, glyphs, walls, accessories) cost 20–60 ms to compose, and its cell recomposes whenever
    /// anything in it changes: a shell crater, a building's damage band, a unit dying. None of that changes the
    /// compound, so its output (instances, draped ground quads, flags, bounds and the published lanes) is recorded
    /// once per site and replayed until something it depends on changes (<see cref="BaseSignature"/>): the site's
    /// owner, tier, capacity, defense level, memory, parcels and occupants, the roads and explored hexes around it,
    /// nearby positioned buildings and the team colours. Craters under the foundation are deliberately not part of
    /// the key: the concrete keeps its shape (the terrain still shows the crater beside it).
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        sealed class BaseComposeRecord
        {
            public ulong Key;
            public readonly List<(int part, InstanceData data)> Instances = new List<(int, InstanceData)>();
            public readonly List<(int layer, GroundLayers.QuadRecord quad)> Quads = new List<(int, GroundLayers.QuadRecord)>();
            public readonly List<AnimatedFlag> Flags = new List<AnimatedFlag>();
            public float3 Min, Max;
        }

        readonly Dictionary<int, BaseComposeRecord> baseCache = new Dictionary<int, BaseComposeRecord>();
        List<(int part, InstanceData data)> instanceTap;

        /// <summary>Base compounds composed from scratch / replayed from the cache (diagnostics).</summary>
        public int BaseComposeBuilt, BaseComposeReplayed;

        static ulong Mix(ulong h, long v) { unchecked { h ^= (ulong)v; h *= 1099511628211UL; return h; } }
        static ulong Mix(ulong h, float v) => Mix(h, (long)Mathf.RoundToInt(v * 1000f));
        static ulong Mix(ulong h, string s) { if (s != null) foreach (char ch in s) h = Mix(h, (long)ch); return Mix(h, -7L); }

        /// <summary>Everything the compound composition reads, folded into one 64-bit key.</summary>
        ulong BaseSignature(in ObjectiveSite site, BaseParcel[] lots)
        {
            ulong h = 1469598103934665603UL;
            h = Mix(h, site.Id); h = Mix(h, site.Tile); h = Mix(h, site.Owner); h = Mix(h, site.Tier); h = Mix(h, site.VisualTier);
            h = Mix(h, site.Capacity); h = Mix(h, site.DefenseLevel); h = Mix(h, site.Memory ? 1 : 0); h = Mix(h, site.Headquarters != 0 ? 1 : 0);
            h = Mix(h, site.X); h = Mix(h, site.Z); h = Mix(h, site.Kind);
            // maturity only grew the settlement houses outside the compound (removed 2026-11-18); kept for the legacy A/B key
            if (PerfFlags.LegacyBaseKey) h = Mix(h, (long)Mathf.FloorToInt(site.Maturity));
            if (PerfFlags.LegacyBaseKey) h = Mix(h, world.RoadRevision);
            // roads: only those around this compound (below), not the map-wide road revision, which every
            // road built anywhere bumped, so every base recomposed whenever anyone paved a hex (perf 2026-11-17)
            h = Mix(h, world.Epoch);
            // the passive development stage (time held, in stages: not the raw tenure, which ticks every snapshot)
            h = Mix(h, DevelopmentStage(site.Tenure));
            var team = CivColor(site.Owner);
            h = Mix(h, team.x); h = Mix(h, team.y); h = Mix(h, team.z);
            foreach (var p in site.Parcels)
            {
                h = Mix(h, p.Id); h = Mix(h, p.Tile); h = Mix(h, p.Tier); h = Mix(h, p.X); h = Mix(h, p.Z); h = Mix(h, p.Yaw);
                h = Mix(h, p.Width); h = Mix(h, p.Depth); h = Mix(h, p.PreviousType);
            }
            // occupants (pads, glyphs, live docking arms) and positioned buildings the accessories keep clear of
            var origin = new float2(site.X, site.Z);
            // (as far as the passive development reaches, plus the largest structure: CityRenderer.BaseDevelopment.cs)
            float reach = FoundationRadius(origin, lots) + DevelopmentReach + .8f;
            foreach (var b in structures.Buildings.Values)
            {
                if (b.City == site.Id && b.Slot > 0) { h = Mix(h, b.Slot); h = Mix(h, b.Type); h = Mix(h, b.Done ? 1 : 0); h = Mix(h, b.Id); }
                else if (b.HasPosition && math.distancesq(origin, new float2(b.X, b.Z)) < reach * reach) { h = Mix(h, b.Id); h = Mix(h, b.X); h = Mix(h, b.Z); }
            }
            // explored hexes and their roads around the compound (entrances end on the portals of the hexes
            // within ~4.3 units, CityRenderer.Rings.InvalidateRingDistricts; the window keeps a margin past that)
            var g = world.Grid; int row = site.Tile / g.W, column = site.Tile % g.W;
            for (int r = Mathf.Max(0, row - 5); r <= Mathf.Min(g.H - 1, row + 5); r++)
                for (int q0 = column - 6; q0 <= column + 6; q0++)
                {
                    int q = g.Wrap ? HexMath.PosMod(q0, g.W) : q0;
                    if (q < 0 || q >= g.W) continue;
                    int i = r * g.W + q;
                    h = Mix(h, world.Known[i] != 0 ? 1 : 0);
                    h = Mix(h, world.Road[i]);
                }
            return h;
        }

        /// <summary>Replay a recorded compound into the cell being composed; false when there is no valid record.</summary>
        bool ReplayBase(int siteId, ulong key)
        {
            if (!baseCache.TryGetValue(siteId, out var rec) || rec.Key != key) return false;
            foreach (var (part, data) in rec.Instances)
            {
                if (part >= current.Batches.Length) EnsureModelBatches(current);   // staged models (CityRenderer.StagedModels.cs)
                current.Batches[part].Add(data);
            }
            streetGeometry.Replay(rec.Quads);
            streetQuads += rec.Quads.Count;
            current.Flags.AddRange(rec.Flags);
            if (rec.Min.x <= rec.Max.x) { bmin = math.min(bmin, rec.Min); bmax = math.max(bmax, rec.Max); }
            BaseComposeReplayed++;
            return true;
        }

        /// <summary>Start recording a compound's output; <see cref="EndBaseRecord"/> stores it.</summary>
        BaseComposeRecord BeginBaseRecord(ulong key, out float3 outerMin, out float3 outerMax, out int flagStart)
        {
            var rec = new BaseComposeRecord { Key = key };
            instanceTap = rec.Instances;
            streetGeometry.Tap = rec.Quads;
            outerMin = bmin; outerMax = bmax;
            bmin = new float3(1e9f); bmax = new float3(-1e9f);
            flagStart = current.Flags.Count;
            return rec;
        }

        void EndBaseRecord(int siteId, BaseComposeRecord rec, float3 outerMin, float3 outerMax, int flagStart)
        {
            instanceTap = null;
            streetGeometry.Tap = null;
            rec.Min = bmin; rec.Max = bmax;
            for (int i = flagStart; i < current.Flags.Count; i++) rec.Flags.Add(current.Flags[i]);
            bmin = math.min(outerMin, bmin); bmax = math.max(outerMax, bmax);
            baseCache[siteId] = rec;
            BaseComposeBuilt++;
        }
    }
}
