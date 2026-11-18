using System.Collections.Generic;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Street compose cache (perf 2026-11-17). A hex's streets are draped ribbons whose every vertex samples the full
    /// terrain height (sectors, craters, trenches, shoreline): 28-60 ms per 16x16 cell under Mono, measured, paid on every
    /// recompose of the cell, and a cell recomposes whenever anything in it changes (a building's construction step or
    /// damage band, a pickup, a site's state). Each road hex's output is recorded and replayed until something its
    /// streets read changes, as with the base compounds (<see cref="BaseSignature"/>), so a change recomposes only the
    /// streets around it. <see cref="HexStreetKey"/> folds in everything ComposeStreets reads for one hex over a two-hex
    /// margin (the hex, its neighbours' portals and the terrain under them): roads, explored hexes, urban flags, district
    /// kinds, built parcels, heights, water, geography flags, craters and trench cuts; plus the base sites' layout, which
    /// decides where the ring approaches and entrances replace a street (ComposeRingApproaches, RedundantEntrance).
    /// </summary>
    public sealed unsafe partial class CityRenderer
    {
        sealed class StreetRecord
        {
            public ulong Key;
            public readonly List<(int part, InstanceData data)> Instances = new List<(int, InstanceData)>();
            public readonly List<(int layer, GroundLayers.QuadRecord quad)> Quads = new List<(int, GroundLayers.QuadRecord)>();
            public float3 Min, Max;
            public int QuadCount;
            public readonly ulong[] Parts = new ulong[StreetKeyParts];
        }

        const int StreetKeyParts = 6;
        /// <summary>Diagnostics: street cache misses by the part of the key that changed (base sites, roads+explored,
        /// urban+parcels+districts, terrain, craters+trenches, bridge revisions).</summary>
        public readonly int[] StreetMissBy = new int[StreetKeyParts];
        readonly ulong[] streetParts = new ulong[StreetKeyParts];
        readonly Dictionary<int, StreetRecord> streetCache = new Dictionary<int, StreetRecord>();

        /// <summary>Road hexes whose streets were composed / replayed (diagnostics).</summary>
        public int StreetsBuilt, StreetsReplayed;

        const ulong StreetSeed = 1469598103934665603UL;
        static ulong MixF(ulong h, float v) { unchecked { h ^= (ulong)(uint)System.BitConverter.SingleToInt32Bits(v); h *= 1099511628211UL; return h; } }

        ulong BaseSitesKey()
        {
            ulong h = StreetSeed;
            h = Mix(h, world.Epoch); h = Mix(h, ActionRts ? 1 : 0); h = Mix(h, Showcase ? 1 : 0);
            if (ActionRts)
                foreach (var s in objectiveByTile.Values)
                {
                    if (!s.IsBase) continue;
                    h = Mix(h, s.Tile); h = MixF(h, s.X); h = MixF(h, s.Z); h = Mix(h, s.Parcels?.Length ?? -1);
                }
            return h;
        }

        /// <summary>The street inputs of one road hex (fills <see cref="streetParts"/>); sites is <see cref="BaseSitesKey"/>.</summary>
        ulong HexStreetKey(int tile, ulong sites)
        {
            var g = world.Grid;
            const int margin = 2;
            bool bridged = false;
            ulong hr = StreetSeed, hu = StreetSeed, ht = StreetSeed, hc = StreetSeed;
            int row = tile / g.W, col = tile % g.W;
            for (int r = row - margin; r <= row + margin; r++)
            {
                if (r < 0 || r >= g.H) continue;
                for (int q0 = col - margin; q0 <= col + margin; q0++)
                {
                    int q = g.Wrap ? HexMath.PosMod(q0, g.W) : q0;
                    if (q < 0 || q >= g.W) continue;
                    int t = r * g.W + q;
                    hr = Mix(hr, world.Known[t]);
                    if (world.Known[t] == 0) continue;
                    hr = Mix(hr, world.Road[t]);
                    if (world.Road[t] != 0 && (world.IsRiver(t) || world.IsLake(t))) bridged = true;   // a span over a river or lake
                    hu = Mix(hu, world.IsUrban(t) ? 1 : 0);
                    hu = Mix(hu, streetParcels.Length > t && streetParcels[t] ? 1 : 0);
                    hu = Mix(hu, (long)(Districts.At(t)?.Kind ?? DistrictKind.None));
                    ht = MixF(ht, world.Height[t]); ht = MixF(ht, world.Water[t]);
                    ht = Mix(ht, world.GeoFlags[t]); ht = Mix(ht, world.Biome[t]);
                    int n = t < world.ImpactCounts.Length ? world.ImpactCounts[t] : 0;
                    hc = Mix(hc, n);
                    for (int k = 0; k < n * 4 && t * 24 + k < world.Impacts.Length; k++) hc = MixF(hc, world.Impacts[t * 24 + k]);
                    if (t * 4 + 3 < world.TrenchGeometry.Length)
                        for (int k = 0; k < 4; k++) hc = MixF(hc, world.TrenchGeometry[t * 4 + k]);
                }
            }
            // a bridge deck's level comes from a flood along the whole span (RoadCurve.SpanLevel), which can reach past
            // the margin: hexes near a road on a river or lake also follow the map-wide road and geometry revisions
            ulong hb = StreetSeed;
            if (bridged) { hb = Mix(hb, world.RoadRevision); hb = Mix(hb, world.GeometryRevision); }
            streetParts[0] = sites; streetParts[1] = hr; streetParts[2] = hu; streetParts[3] = ht; streetParts[4] = hc; streetParts[5] = hb;
            ulong key = StreetSeed;
            for (int i = 0; i < StreetKeyParts; i++) key = Mix(key, (long)streetParts[i]);
            return key;
        }

        /// <summary>Compose (or replay) the streets of a cell's hexes, hex by hex.</summary>
        void ComposeCellStreets(int cellId) { var steps = ComposeCellStreetsSteps(cellId); while (steps.MoveNext()) { } }

    }
}
