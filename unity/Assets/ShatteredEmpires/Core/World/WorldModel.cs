using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SE.Core.Protocol;

namespace SE.Core.World
{
    /// <summary>
    /// The client's mirror of the terrain and tile state the server has told this viewer. Nothing here
    /// is simulated. Arrays are allocated once per world and pinned, so Burst jobs can read them
    /// through a <see cref="TerrainView"/> without copying.
    /// </summary>
    public sealed unsafe class WorldModel : IDisposable
    {
        public const int GeoStride = 6;
        public const float LandScale = 3.2f;
        public const float SeaScale = 1.4f;
        public const float LakeDepth = 0.14f;
        public const float RiverDepth = 0.07f;
        public const int ChunkSize = 16;

        public HexGrid Grid { get; private set; }
        public bool ActionLandscape;
        public int ChunksW { get; private set; }
        public int ChunksH { get; private set; }

        // terrain geometry ('geo' capability)
        public byte[] Geo = Array.Empty<byte>();
        public byte[] Known = Array.Empty<byte>();
        public byte[] Biome = Array.Empty<byte>();
        public byte[] GeoFlags = Array.Empty<byte>();
        public float[] Height = Array.Empty<float>();
        public float[] Water = Array.Empty<float>();
        float[] waterBefore = Array.Empty<float>(), heightBefore = Array.Empty<float>();
        public float[] Impacts = Array.Empty<float>();
        public byte[] ImpactCounts = Array.Empty<byte>();
        public float[] TrenchGeometry = Array.Empty<float>();
        readonly HashSet<int> trenchTiles = new HashSet<int>();
        readonly HashSet<int> impactTiles = new HashSet<int>();

        // tile records (protocol 1)
        public byte[] Terrain = Array.Empty<byte>();
        public int[] Owner = Array.Empty<int>();
        public int[] Road = Array.Empty<int>();
        public int[] TileFlags = Array.Empty<int>();
        public byte[] Resource = Array.Empty<byte>();
        public uint[] ServerColor = Array.Empty<uint>();
        public byte[] Visible = Array.Empty<byte>();   // packed bits, as sent
        public byte[] Urban = Array.Empty<byte>();     // packed bits, as sent

        /// <summary>Increments whenever heights change (anything sampling the ground re-samples).</summary>
        public int GeometryRevision { get; private set; }
        public int VisibilityRevision { get; private set; }
        public int RoadRevision { get; private set; }
        /// <summary>Increments on a welcome or reset, even when the same match is rejoined.</summary>
        public int Epoch { get; private set; }

        readonly List<GCHandle> pins = new List<GCHandle>();
        TerrainView view;

        public TerrainView View => view;
        public bool Ready => Grid != null;

        public void Reset(int width, int height, bool wraps)
        {
            if (Grid == null || Grid.W != width || Grid.H != height || Grid.Wrap != wraps)
            {
                Unpin();
                Grid = new HexGrid(width, height, wraps);
                int n = Grid.N;
                Geo = new byte[n * GeoStride];
                Known = new byte[n];
                Biome = new byte[n];
                GeoFlags = new byte[n];
                Height = new float[n];
                Water = new float[n];
                waterBefore = new float[n]; heightBefore = new float[n];
                Impacts = new float[n * 24]; ImpactCounts = new byte[n];
                TrenchGeometry = new float[n * 4];
                Terrain = new byte[n];
                Owner = new int[n];
                Road = new int[n];
                TileFlags = new int[n];
                Resource = new byte[n];
                ServerColor = new uint[n];
                Visible = new byte[(n + 7) / 8];
                Urban = new byte[(n + 7) / 8];
                Pin();
            }
            else
            {
                Array.Clear(Geo, 0, Geo.Length); Array.Clear(Known, 0, Known.Length);
                Array.Clear(Biome, 0, Biome.Length); Array.Clear(GeoFlags, 0, GeoFlags.Length);
                Array.Clear(Height, 0, Height.Length); Array.Clear(Terrain, 0, Terrain.Length);
                Array.Clear(Road, 0, Road.Length); Array.Clear(TileFlags, 0, TileFlags.Length);
                Array.Clear(Resource, 0, Resource.Length); Array.Clear(ServerColor, 0, ServerColor.Length);
                Array.Clear(Visible, 0, Visible.Length); Array.Clear(Urban, 0, Urban.Length);
                Array.Clear(Impacts, 0, Impacts.Length); Array.Clear(ImpactCounts, 0, ImpactCounts.Length);
                Array.Clear(TrenchGeometry, 0, TrenchGeometry.Length);
            }
            impactTiles.Clear();
            trenchTiles.Clear();
            for (int i = 0; i < Owner.Length; i++) Owner[i] = -1;
            for (int i = 0; i < Water.Length; i++) Water[i] = TerrainView.NoWater;
            ChunksW = (Grid.W + ChunkSize - 1) / ChunkSize;
            ChunksH = (Grid.H + ChunkSize - 1) / ChunkSize;
            Epoch++; GeometryRevision++; VisibilityRevision++; RoadRevision++; LayoutRevision++;
        }

        void Pin()
        {
            view = new TerrainView
            {
                W = Grid.W, H = Grid.H, Wrap = Grid.Wrap ? 1 : 0, Period = Grid.Period,
                Height = (float*)PinArray(Height), Water = (float*)PinArray(Water),
                Known = (byte*)PinArray(Known), GeoFlags = (byte*)PinArray(GeoFlags),
                Biome = (byte*)PinArray(Biome), Nb = (int*)PinArray(Grid.Nb),
                Impacts = (float*)PinArray(Impacts), ImpactCounts = (byte*)PinArray(ImpactCounts),
                Trenches = (float*)PinArray(TrenchGeometry),
            };
            GeoPtr = (byte*)PinArray(Geo);
            // ridge-noise cache for main-thread height queries (pure function of position: never stale)
            ridgeCache = new float[Grid.N * 42];
            ridgeFilled = new byte[Grid.N];
            view.RidgeCache = (float*)PinArray(ridgeCache);
            view.RidgeFilled = (byte*)PinArray(ridgeFilled);
        }

        float[] ridgeCache;
        byte[] ridgeFilled;

        /// <summary>The pinned raw geo bytes (6 per hex), for jobs that need flow and deposit data.</summary>
        public byte* GeoPtr { get; private set; }

        IntPtr PinArray(Array a)
        {
            var h = GCHandle.Alloc(a, GCHandleType.Pinned);
            pins.Add(h);
            return h.AddrOfPinnedObject();
        }

        void Unpin()
        {
            foreach (var h in pins) if (h.IsAllocated) h.Free();
            pins.Clear();
            view = default;
        }

        public void Dispose() => Unpin();

        public int ChunkOf(int i)
        {
            int q = i % Grid.W, r = i / Grid.W;
            return (r / ChunkSize) * ChunksW + q / ChunkSize;
        }

        public void ApplyTrenches(TrenchRecord[] records, Action beforeChange, HashSet<int> chunks, HashSet<int> cells)
        {
            if (!Ready) return;
            var next = new Dictionary<int, TrenchRecord>();
            foreach (var r in records) if (r.HasPosition && r.Tile >= 0 && r.Tile < Grid.N && r.Progress > 0) next[r.Tile] = r;
            var candidates = new HashSet<int>(trenchTiles); candidates.UnionWith(next.Keys);
            bool changed = false;
            foreach (int tile in candidates)
            {
                next.TryGetValue(tile, out var r);
                float x = r.HasPosition ? Grid.DxWrap(Grid.CenterX(tile), r.X) : 0, z = r.HasPosition ? r.Z - Grid.CenterZ(tile) : 0;
                float depth = r.HasPosition ? (float)Math.Ceiling(r.Progress / 25f) * .013f : 0;
                int i = tile * 4;
                if (TrenchGeometry[i] == x && TrenchGeometry[i + 1] == z && TrenchGeometry[i + 2] == r.Facing && TrenchGeometry[i + 3] == depth) continue;
                if (!changed) { beforeChange?.Invoke(); changed = true; }
                TrenchGeometry[i] = x; TrenchGeometry[i + 1] = z; TrenchGeometry[i + 2] = r.Facing; TrenchGeometry[i + 3] = depth;
                chunks.Add(ChunkOf(tile)); cells.Add(ChunkOf(tile));
                for (int d = 0; d < 6; d++) { int n = Grid.Nb[tile * 6 + d]; if (n >= 0) { chunks.Add(ChunkOf(n)); cells.Add(ChunkOf(n)); } }
            }
            trenchTiles.Clear(); trenchTiles.UnionWith(next.Keys);
            if (changed) GeometryRevision++;
        }

        public void ApplyImpacts(ImpactRecord[] records, Action beforeChange, HashSet<int> chunks, HashSet<int> cells)
        {
            if (!Ready) return;
            var next = new Dictionary<int, List<ImpactRecord>>();
            foreach (var r in records)
            {
                if (r.Tile < 0 || r.Tile >= Grid.N) continue;
                if (!next.TryGetValue(r.Tile, out var list)) next[r.Tile] = list = new List<ImpactRecord>(6);
                if (list.Count < 6) list.Add(r);
            }
            var candidates = new HashSet<int>(impactTiles); candidates.UnionWith(next.Keys);
            bool changed = false;
            foreach (int tile in candidates)
            {
                next.TryGetValue(tile, out var list);
                int count = list?.Count ?? 0, offset = tile * 24;
                var values = new float[24];
                for (int k = 0; k < count; k++)
                {
                    var r = list[k];
                    float power = r.Class == "strategic" ? 1f : r.Class == "bomb" || r.Class == "missile" ? .72f : r.Class == "mortar" ? .28f : .47f;
                    values[k * 4] = r.X; values[k * 4 + 1] = r.Z;
                    values[k * 4 + 2] = .15f + power * .35f + r.Severity * .08f;
                    values[k * 4 + 3] = .035f + power * .10f;
                }
                bool same = ImpactCounts[tile] == count;
                for (int k = 0; k < 24 && same; k++) same = Impacts[offset + k] == values[k];
                if (same) continue;
                if (!changed) { beforeChange?.Invoke(); changed = true; }
                ImpactCounts[tile] = (byte)count;
                Array.Copy(values, 0, Impacts, offset, 24);
                chunks.Add(ChunkOf(tile)); cells.Add(ChunkOf(tile));
                for (int d = 0; d < 6; d++) { int n = Grid.Nb[tile * 6 + d]; if (n >= 0) { chunks.Add(ChunkOf(n)); cells.Add(ChunkOf(n)); } }
            }
            impactTiles.Clear(); impactTiles.UnionWith(next.Keys);
            if (changed) GeometryRevision++;
        }

        public float Elevation(int i) => Geo[i * GeoStride] / 127.5f - 1f;
        public int Deposit(int i) => Geo[i * GeoStride + 4] & 15;
        public int FlowBucket(int i) => Geo[i * GeoStride + 4] >> 4;
        public int FlowDir(int i) => Geo[i * GeoStride + 5] - 1;
        public bool IsLake(int i) => (GeoFlags[i] & 2) != 0;
        public bool IsRiver(int i) => (GeoFlags[i] & 1) != 0;
        public bool IsSea(int i) => Biome[i] <= 1 && (GeoFlags[i] & 2) == 0;
        public bool IsVisible(int i) => (Visible[i >> 3] & (1 << (i & 7))) != 0;
        public bool IsUrban(int i) => (Urban[i >> 3] & (1 << (i & 7))) != 0;

        /// <summary>World height of hex i from its quantized elevation (WorldState.gd _tile_height).</summary>
        public static float TileHeightFromGeo(byte elevByte, byte biome, byte flags)
        {
            float e = elevByte / 127.5f - 1f;
            bool lake = (flags & 2) != 0, river = (flags & 1) != 0;
            bool sea = biome <= 1 && !lake;
            if (sea) return Math.Min(e, -0.03f) * SeaScale;
            float relief = Math.Max(e - 0.32f, 0f);
            float y = Math.Max(e, 0f) * LandScale + relief * relief * 6f + 0.05f;
            if (lake) y -= LakeDepth;
            else if (river) y -= RiverDepth;
            return y;
        }

        /// <summary>
        /// Apply terrain geometry. Returns the chunks whose meshes must be rebuilt: a hex's shape changes
        /// its neighbours' corners, so neighbouring chunks are included.
        /// </summary>
        public HashSet<int> ApplyGeo(GeoMessage m, bool keepExisting = false)
        {
            var touched = new HashSet<int>();
            if (!Ready) return touched;
            bool watchBasins = ActionLandscape && (!m.Full || keepExisting);
            if (watchBasins) { Array.Copy(Water, waterBefore, Water.Length); Array.Copy(Height, heightBefore, Height.Length); }
            int cs = m.ChunkSize > 0 ? m.ChunkSize : ChunkSize;
            int stride = m.Stride > 0 ? m.Stride : GeoStride;
            if (m.Full && !keepExisting)
            {
                Array.Clear(Known, 0, Known.Length);
                Array.Clear(Height, 0, Height.Length);
                for (int c = 0; c < ChunksW * ChunksH; c++) touched.Add(c);
            }
            int w = Grid.W;
            bool heightChanged = m.Full && !keepExisting;
            foreach (var chunk in m.Chunks)
            {
                int k = 0;
                for (int cell = 0; cell < cs * cs; cell++)
                {
                    if ((chunk.Mask[cell >> 3] & (1 << (cell & 7))) == 0) continue;
                    int q = chunk.Cx * cs + cell % cs;
                    int r = chunk.Cy * cs + cell / cs;
                    int i = r * w + q;
                    if (q >= w || r >= Grid.H || k * stride + GeoStride > chunk.Data.Length) { k++; continue; }
                    if (keepExisting && Known[i] != 0)
                    {
                        // a re-send after a reconnect: skip hexes that are exactly as we have them
                        bool same = true;
                        for (int b = 0; b < GeoStride && same; b++) same = Geo[i * GeoStride + b] == chunk.Data[k * stride + b];
                        if (same) { k++; continue; }
                    }
                    for (int b = 0; b < GeoStride; b++) Geo[i * GeoStride + b] = chunk.Data[k * stride + b];
                    Biome[i] = Geo[i * GeoStride + 1];
                    GeoFlags[i] = Geo[i * GeoStride + 3];
                    float y = TileHeightFromGeo(Geo[i * GeoStride], Biome[i], GeoFlags[i]);
                    if (Known[i] == 0 || Height[i] != y) heightChanged = true;
                    Height[i] = y;
                    Known[i] = 1;
                    k++;
                    touched.Add(ChunkOf(i));
                    for (int d = 0; d < 6; d++)
                    {
                        int nb = Grid.Nb[i * 6 + d];
                        if (nb >= 0) touched.Add(ChunkOf(nb));
                    }
                }
            }
            RecomputeWater();
            if (watchBasins) for (int tile = 0; tile < Grid.N; tile++)
            {
                if (Known[tile] == 0 || Water[tile] == waterBefore[tile] && Height[tile] == heightBefore[tile]) continue;
                // Discovering an upstream part of a lake can change its common level.
                // Refresh existing banks too, so an old water mesh cannot leave a seam.
                heightChanged = true; touched.Add(ChunkOf(tile));
                for (int d = 0; d < 6; d++) { int n = Grid.Nb[tile * 6 + d]; if (n >= 0) touched.Add(ChunkOf(n)); }
            }
            if (heightChanged) GeometryRevision++;
            return touched;
        }

        /// <summary>Standing water: sea level 0; a lake's surface is shared by its connected hexes.</summary>
        public void RecomputeWater()
        {
            int n = Grid.N;
            for (int i = 0; i < n; i++) Water[i] = Known[i] != 0 && IsSea(i) ? 0f : TerrainView.NoWater;
            var queue = new List<int>();
            var visited = new bool[n];
            for (int i = 0; i < n; i++)
            {
                if (visited[i] || Known[i] == 0 || !IsLake(i)) continue;
                queue.Clear(); queue.Add(i); visited[i] = true;
                float level = float.NegativeInfinity;
                for (int cursor = 0; cursor < queue.Count; cursor++)
                {
                    int t = queue[cursor];
                    float rawBed = TileHeightFromGeo(Geo[t * GeoStride], Biome[t], GeoFlags[t]);
                    level = Math.Max(level, rawBed + LakeDepth * .8f);
                    for (int d = 0; d < 6; d++)
                    {
                        int nb = Grid.Nb[t * 6 + d];
                        if (nb >= 0 && !visited[nb] && Known[nb] != 0 && IsLake(nb)) { visited[nb] = true; queue.Add(nb); }
                    }
                }
                if (ActionLandscape)
                {
                    float bank = float.PositiveInfinity;
                    foreach (int t in queue) for (int d = 0; d < 6; d++)
                    {
                        int n2 = Grid.Nb[t * 6 + d];
                        if (n2 >= 0 && Known[n2] != 0 && !IsLake(n2)) bank = Math.Min(bank, Height[n2] - .025f);
                    }
                    level = Math.Min(level, bank);
                    // The marked lake is impassable in the simulation. Give its basin one
                    // coherent water plane and a bed below it, without drowning dry parcels.
                    foreach (int t in queue)
                        Height[t] = Math.Min(TileHeightFromGeo(Geo[t * GeoStride], Biome[t], GeoFlags[t]), level - LakeDepth);
                }
                foreach (int t in queue) Water[t] = level;
            }
        }

        /// <summary>
        /// Apply tile records. Fills the changed tile list, adds the render cells a road change touches
        /// (the hex and its neighbours, which share its streets) and returns whether any road changed.
        /// </summary>
        public bool ApplyTiles(TileRecord[] tiles, List<int> changed, HashSet<int> roadCells = null)
        {
            bool roads = false;
            foreach (var t in tiles)
            {
                int i = t.Index;
                if (i < 0 || i >= Grid.N) continue;
                Terrain[i] = (byte)t.Terrain;
                Resource[i] = (byte)t.Resource;
                if (Road[i] != t.Roads)
                {
                    roads = true;
                    if (roadCells != null) TouchAround(i, roadCells);
                }
                Road[i] = t.Roads;
                TileFlags[i] = t.Flags;
                Owner[i] = t.Owner;
                ServerColor[i] = (uint)t.Color;
                changed?.Add(i);
            }
            if (roads) RoadRevision++;
            return roads;
        }

        public void ApplyVisibility(byte[] bits)
        {
            if (bits == null || bits.Length != Visible.Length) return;
            Buffer.BlockCopy(bits, 0, Visible, 0, bits.Length);
            VisibilityRevision++;
        }

        /// <summary>Apply district bits; the render cells of every changed hex (and its neighbours) go into <paramref name="cells"/>.</summary>
        public void ApplyUrban(byte[] bits, HashSet<int> cells = null)
        {
            if (bits == null || bits.Length != Urban.Length) return;
            if (!ReferenceEquals(bits, Urban))
            {
                bool any = false;
                for (int k = 0; k < bits.Length; k++)
                {
                    int diff = bits[k] ^ Urban[k];
                    if (diff == 0) continue;
                    any = true;
                    if (cells != null)
                        for (int b = 0; b < 8; b++)
                            if ((diff & (1 << b)) != 0 && k * 8 + b < Grid.N) TouchAround(k * 8 + b, cells);
                }
                if (!any) return;
                Buffer.BlockCopy(bits, 0, Urban, 0, bits.Length);
            }
            UrbanRevision++;
        }

        void TouchAround(int i, HashSet<int> cells)
        {
            cells.Add(ChunkOf(i));
            for (int d = 0; d < 6; d++) { int nb = Grid.Nb[i * 6 + d]; if (nb >= 0) cells.Add(ChunkOf(nb)); }
        }

        public int UrbanRevision { get; private set; }

        /// <summary>Increments when the whole street layout must be redrawn (a reset, or a locally composed scene).</summary>
        public int LayoutRevision { get; private set; }

        /// <summary>For locally composed scenes (stress test, intro) that write road bits directly.</summary>
        public void MarkRoadsChanged() { RoadRevision++; LayoutRevision++; }

        /// <summary>Road type on edge d of hex i (0 none; server roads.js edge.type), packed 4 bits per edge.</summary>
        public int RoadClass(int i, int d) => (Road[i] >> (d * 4)) & 7;
        /// <summary>Whether the road on edge d of hex i is destroyed (condition 0).</summary>
        public bool RoadBroken(int i, int d) => ((Road[i] >> (d * 4)) & 8) != 0;

        public float GroundHeight(float x, float z) => view.GroundHeight(x, z);
    }
}
