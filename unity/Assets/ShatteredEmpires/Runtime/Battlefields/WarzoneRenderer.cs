using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Battlefields
{
    /// <summary>
    /// The built battlefield, from the server's records: WW1-style trench networks dug into the ground
    /// (square fire bays and traverses so fire cannot sweep along a trench, duckboard floors, sandbag
    /// parapets on the enemy side and a lower parados behind), joined to neighbouring segments and to
    /// adjacent bunkers, posts and forts; construction shown as it progresses. No-man's land gets
    /// barbed-wire belts, shattered stumps and debris; destroyed vehicles stay where they fell.
    /// Rebuilt only when trenches, battlefield or terrain change.
    /// </summary>
    public sealed unsafe class WarzoneRenderer : IDisposable
    {
        enum Part { Floor, Bag, Plank, Coil, Post, Stump, Debris, Wreck, Count }

        readonly InstanceBatch[] batches = new InstanceBatch[(int)Part.Count];
        readonly WorldModel world;
        readonly HashSet<int> trenchTiles = new HashSet<int>();
        readonly Dictionary<int, TrenchRecord> byTile = new Dictionary<int, TrenchRecord>();
        public readonly List<float3> BurningWrecks = new List<float3>();
        int trenchRev = -1, bfRev = -1, geoRev = -1, structRev = -1;
        public Func<int, string> DefenceAt = _ => null;   // building type at a tile (joins trenches to defences)
        public Func<int, int> BuildingOwnerAt = _ => -1;

        public WarzoneRenderer(WorldModel w)
        {
            world = w;
            Mesh[] meshes = { MeshKit.Box, MeshKit.Sandbags, MeshKit.Box, MeshKit.Coil, MeshKit.Cylinder, MeshKit.Stump, MeshKit.Box, MeshKit.Wreck };
            for (int i = 0; i < batches.Length; i++)
                batches[i] = new InstanceBatch(meshes[i], RenderResources.Instanced, 256) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
            batches[(int)Part.Floor].Shadows = ShadowCastingMode.Off;
            batches[(int)Part.Plank].Shadows = ShadowCastingMode.Off;
        }

        /// <summary>A finished trench at this tile (troops there stand down in it).</summary>
        public bool HasTrench(int tile) => byTile.TryGetValue(tile, out var t) && t.Built;

        static float Hash(int a, int b)
        {
            uint h = (uint)(a * 374761393 + b * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xffffff) / 16777216f;
        }

        float Ground(float x, float z) => world.View.GroundHeight(x, z);

        void Put(Part part, float3 mapPos, float mapYaw, float3 size, float3 color)
            => batches[(int)part].Add(InstanceData.TRS(MapSpace.W(mapPos), MapSpace.Yaw(mapYaw), size, new float4(color, 0)));

        public void Update(TrenchRecord[] trenches, int trenchRevision, BattlefieldState bf, int bfRevision, int structureRevision, Func<int, bool> wasteland)
        {
            if (!world.Ready) return;
            if (trenchRev == trenchRevision && bfRev == bfRevision && geoRev == world.GeometryRevision && structRev == structureRevision) return;
            trenchRev = trenchRevision; bfRev = bfRevision; geoRev = world.GeometryRevision; structRev = structureRevision;
            foreach (var b in batches) b.Clear();
            byTile.Clear(); trenchTiles.Clear(); BurningWrecks.Clear();
            foreach (var t in trenches) if (t.Tile >= 0 && t.Tile < world.Grid.N) { byTile[t.Tile] = t; trenchTiles.Add(t.Tile); }
            foreach (var t in trenches) if (t.Tile >= 0 && t.Tile < world.Grid.N && world.Known[t.Tile] != 0) Trench(t);
            if (bf != null)
            {
                foreach (var it in bf.Intensity) if (it.Value >= 2f && it.Tile >= 0 && it.Tile < world.Grid.N && world.Known[it.Tile] != 0 && !trenchTiles.Contains(it.Tile)) NoMansLand(it.Tile, it.Value);
                int n = 0;
                foreach (var w in bf.Wrecks)
                {
                    if (w.Tile < 0 || w.Tile >= world.Grid.N || world.Known[w.Tile] == 0) continue;
                    var g = world.Grid;
                    float x = g.CenterX(w.Tile) + (Hash(w.Tile, n) - 0.5f) * 0.9f, z = g.CenterZ(w.Tile) + (Hash(n, w.Tile) - 0.5f) * 0.9f;
                    float y = Ground(x, z);
                    float s = w.Type.Contains("tank") ? 0.2f : w.Type.Contains("truck") || w.Type.Contains("car") ? 0.15f : 0.12f;
                    Put(Part.Wreck, new float3(x, y - 0.01f, z), Hash(w.Tile, n + 7) * 6.28f, new float3(s), new float3(0.22f, 0.2f, 0.18f));
                    if (w.Burning) BurningWrecks.Add(new float3(x, y + 0.05f, z));
                    n++;
                }
            }
            foreach (var b in batches) b.MarkDirty();
        }

        // ------------------------------------------------------------------ trenches
        void Trench(in TrenchRecord t)
        {
            var g = world.Grid;
            float cx = g.CenterX(t.Tile), cz = g.CenterZ(t.Tile);
            // the enemy side: the facing direction the server chose for the line
            float fx = HexMath.DirX[((t.Dir % 6) + 6) % 6], fz = HexMath.DirZ[((t.Dir % 6) + 6) % 6];
            var legs = new List<float2>();
            for (int d = 0; d < 6; d++)
            {
                int nb = g.Nb[t.Tile * 6 + d];
                if (nb < 0) continue;
                bool linked = (t.Route & (1 << d)) != 0 || (byTile.TryGetValue(nb, out var other) && other.Owner == t.Owner && t.Route == 0);
                // trenches run into the defences beside them (bunkers, posts, forts, AA sites)
                string def = DefenceAt(nb);
                if (!linked && def != null && BuildingOwnerAt(nb) == t.Owner) linked = true;
                if (linked) legs.Add(new float2(HexMath.DirX[d], HexMath.DirZ[d]));
            }
            if (legs.Count == 0)
            {
                // a lone segment runs across the facing
                legs.Add(new float2(-fz, fx)); legs.Add(new float2(fz, -fx));
            }
            float built = t.Progress / 100f;
            bool planned = t.State == 2 || t.Progress <= 0;
            foreach (var leg in legs) Leg(t, cx, cz, leg, new float2(fx, fz), built, planned);
            // a sandbagged junction at the centre
            if (!planned) Put(Part.Floor, new float3(cx, Ground(cx, cz) + 0.004f, cz), 0, new float3(0.11f, 0.008f, 0.11f), new float3(0.17f, 0.13f, 0.1f));
        }

        void Leg(in TrenchRecord t, float cx, float cz, float2 dir, float2 facing, float built, bool planned)
        {
            const float length = 0.87f, bay = 0.13f, offset = 0.05f;
            float2 side = new float2(-dir.y, dir.x);
            // parapet on whichever side of the leg faces the enemy
            float front = math.dot(side, facing) >= 0 ? 1f : -1f;
            int bays = (int)(length / bay);
            int drawn = planned ? 0 : (int)Math.Ceiling(bays * Mathf.Clamp01(built));
            float3 floorColor = new float3(0.16f, 0.12f, 0.09f);
            float3 bagColor = t.Reinforced ? new float3(0.6f, 0.59f, 0.56f) : new float3(0.66f, 0.6f, 0.46f);
            for (int b = 0; b < bays; b++)
            {
                // square-wave trace: fire bays alternate with traverses one step back
                float o = (b % 2 == 0 ? 1f : -1f) * offset;
                float s0 = b * bay, s1 = s0 + bay;
                float2 p0 = new float2(cx, cz) + dir * s0 + side * o, p1 = new float2(cx, cz) + dir * s1 + side * o;
                float2 mid = (p0 + p1) * 0.5f;
                float yaw = Mathf.Atan2(dir.x, dir.y);
                float y = Ground(mid.x, mid.y);
                if (b >= drawn)
                {
                    // planned: a pale pegged outline on the ground
                    if (b % 2 == 0) Put(Part.Plank, new float3(mid.x, y + 0.004f, mid.y), yaw, new float3(0.008f, 0.006f, bay * 0.8f), new float3(0.8f, 0.75f, 0.6f));
                    continue;
                }
                // the dug floor (dark, damp) and duckboards
                Put(Part.Floor, new float3(mid.x, y + 0.003f, mid.y), yaw, new float3(0.05f, 0.008f, bay * 1.02f), floorColor * (0.85f + 0.3f * Hash(t.Tile, b)));
                Put(Part.Plank, new float3(mid.x, y + 0.008f, mid.y), yaw, new float3(0.022f, 0.003f, bay * 0.9f), new float3(0.42f, 0.33f, 0.22f));
                // parapet (front, higher) and parados (rear, lower) of sandbags
                float2 pf = mid + side * front * 0.04f, pr = mid - side * front * 0.04f;
                Put(Part.Bag, new float3(pf.x, Ground(pf.x, pf.y) - 0.004f, pf.y), yaw, new float3(0.028f, 0.024f, bay * 1.05f), bagColor * (0.9f + 0.2f * Hash(b, t.Tile)));
                Put(Part.Bag, new float3(pr.x, Ground(pr.x, pr.y) - 0.006f, pr.y), yaw, new float3(0.022f, 0.014f, bay * 1.05f), bagColor * 0.85f);
                // the traverse joining this bay to the next, across the line
                if (b + 1 < drawn)
                {
                    float2 j = new float2(cx, cz) + dir * s1;
                    Put(Part.Floor, new float3(j.x, Ground(j.x, j.y) + 0.003f, j.y), yaw + Mathf.PI * 0.5f, new float3(0.05f, 0.008f, offset * 2.2f), floorColor);
                }
                // reinforced lines have concrete firing steps and the odd machine-gun post
                if (t.Reinforced && b % 3 == 1)
                    Put(Part.Debris, new float3(pf.x, Ground(pf.x, pf.y), pf.y), yaw, new float3(0.045f, 0.032f, 0.04f), new float3(0.52f, 0.51f, 0.48f));
            }
        }

        // ------------------------------------------------------------------ no-man's land
        void NoMansLand(int tile, float stage)
        {
            var g = world.Grid;
            float cx = g.CenterX(tile), cz = g.CenterZ(tile);
            int n = (int)(stage * 3);
            for (int k = 0; k < n; k++)
            {
                float a = Hash(tile, k) * 6.28f, r = 0.15f + Hash(k, tile) * 0.7f;
                float x = cx + Mathf.Cos(a) * r, z = cz + Mathf.Sin(a) * r;
                float y = Ground(x, z);
                float pick = Hash(tile * 3 + k, 11);
                if (pick < 0.35f)
                {
                    // shattered tree stumps
                    float s = 0.025f + Hash(k, 5) * 0.02f;
                    Put(Part.Stump, new float3(x, y - 0.005f, z), a, new float3(s, s * (2.5f + Hash(k, 6) * 3f), s), new float3(0.3f, 0.25f, 0.2f));
                }
                else if (pick < 0.7f)
                {
                    // barbed wire belts on pickets
                    float yaw = Hash(tile, 99) * 3.14f + (pick - 0.5f) * 0.6f;
                    Put(Part.Coil, new float3(x, y, z), yaw, new float3(0.22f, 0.035f, 0.035f), new float3(0.32f, 0.3f, 0.28f));
                    Put(Part.Post, new float3(x, y, z), 0, new float3(0.008f, 0.06f, 0.008f), new float3(0.36f, 0.3f, 0.22f));
                }
                else
                {
                    // debris: timber, broken carts, spoil
                    Put(Part.Debris, new float3(x, y - 0.005f, z), a, new float3(0.04f + pick * 0.03f, 0.012f, 0.02f), new float3(0.28f, 0.24f, 0.2f));
                }
            }
        }

        public void Draw(WrapImages images) { foreach (var b in batches) b.DrawImages(images); }

        public void Dispose() { foreach (var b in batches) b.Dispose(); }
    }
}
