using System.Collections.Generic;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Collections;
using Unity.Jobs;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Landscape
{
    /// <summary>
    /// Chunked terrain. Only dirty chunks are rebuilt (new geometry, or a change to where trees may
    /// grow), nearest the camera first, by a bounded number of Burst jobs that run across frames;
    /// the main thread never waits for a mesh. Each visible chunk is drawn at the wrap images the
    /// camera sees, with a coarse LOD at distance and trees only where they can be told apart.
    /// </summary>
    public sealed unsafe class TerrainRenderer : System.IDisposable
    {
        sealed class Chunk
        {
            public Mesh Hi, Lo, Water;
            public Bounds Bounds;
            public bool HasMesh, Dirty, Building, HasWater;
            public float OriginX;
            public InstanceBatch TreesA, TreesB, Grass, Understory;
        }

        sealed class Pending
        {
            public int Chunk;
            public JobHandle Handle;
            public Mesh.MeshDataArray Meshes;
            public NativeArray<byte> Blocked;
            public NativeArray<uint> TreeScars;
            public NativeArray<ulong> GrassScars;
            public NativeArray<InstanceData> TreesA, TreesB, Grass, Understory;
            public NativeArray<int> Counts;
            public NativeArray<float> Bounds;
        }

        readonly WorldModel world;
        Chunk[] chunks = new Chunk[0];
        readonly List<Pending> pending = new List<Pending>();
        readonly List<int> order = new List<int>();
        readonly Mesh[] applyTargets = new Mesh[3];
        System.Comparison<int> sortByDistance;
        Vector3 sortCamera;
        float sortPeriod;
        public byte[] Blocked = new byte[0];   // per tile: towns, buildings and roads keep trees away
        public int MaxJobs = 6;
        public float LodDistance = 70f, TreeDistance = 110f, TreeShadowDistance = 45f;
        /// <summary>Tree LOD bands (distance from the camera to the chunk): authored mesh, Blender low LOD, distant silhouette, single-crown speck.</summary>
        public float TreeLoDistance = 18f, TreeFarDistance = 55f, TreeSpeckDistance = 150f;
        public float TreeDensity = 1f;
        /// <summary>Ticket 4: a custom map's tree season (0 summer, 1 autumn, 2 winter, 3 spring) and tree height (server defs.MAP_STYLE).
        /// Set through <see cref="SetMapStyle"/>, which rebuilds the chunks when either changes.</summary>
        public int Season { get; private set; }
        public float TreeHeight { get; private set; } = 1f;

        public void SetMapStyle(int season, float treeHeight)
        {
            treeHeight = Mathf.Clamp(treeHeight <= 0 ? 1f : treeHeight, .5f, 2f);
            if (season == Season && Mathf.Approximately(treeHeight, TreeHeight)) return;
            Season = season; TreeHeight = treeHeight;
            MarkAllDirty();
        }
        public int ChunksBuilt { get; private set; }
        public int DrawnChunks { get; private set; }
        public int DirtyCount { get; private set; }
        /// <summary>Diagnostics (perf soak): main-thread time collecting finished chunks (total, worst), chunks finished, tree instances drawn and of those casting shadows.</summary>
        public double FinishMsTotal, FinishMsMax;
        public int ChunksFinished, TreeInstancesDrawn, TreeShadowInstances;
        /// <summary>Diagnostics: chunk tree refills, the net tree count change summed over them, and trees that came back (a refill with more trees than before).</summary>
        public int TreeRefills, TreeChurn, TreesRegrown;
        int epoch = -1, seed, denseRevision = -1;

        NativeArray<VertexAttributeDescriptor> layout;
        Mesh oceanHorizon;
        Material horizonMaterial;

        public TerrainRenderer(WorldModel model)
        {
            world = model;
            layout = new NativeArray<VertexAttributeDescriptor>(TerrainVertex.Layout, Allocator.Persistent);
        }

        public void SetSeed(int s) => seed = s;

        void EnsureLayout()
        {
            if (!world.Ready) return;
            if (epoch == world.Epoch && chunks.Length == world.ChunksW * world.ChunksH) return;
            CompleteAll();
            foreach (var c in chunks) DisposeChunk(c);
            epoch = world.Epoch;
            chunks = new Chunk[world.ChunksW * world.ChunksH];
            for (int i = 0; i < chunks.Length; i++)
            {
                int cx = i % world.ChunksW;
                chunks[i] = new Chunk { OriginX = cx * WorldModel.ChunkSize * HexMath.Sqrt3 };
            }
            if (Blocked.Length != world.Grid.N) Blocked = new byte[world.Grid.N];
            TreeScars = new uint[world.Grid.N]; GrassScars = new ulong[world.Grid.N];   // a new world: nothing destroyed yet
            BuildOceanHorizon();
        }

        void BuildOceanHorizon()
        {
            if (oceanHorizon != null) Object.Destroy(oceanHorizon);
            if (horizonMaterial == null)
            {
                horizonMaterial = new Material(RenderResources.Water) { name = "Ocean horizon", renderQueue = RenderResources.Water.renderQueue - 1 };
                horizonMaterial.SetFloat("_Horizon", 1);
            }
            var mesh = new MeshBuilder(); var grid = world.Grid;
            var color = new Color(0, 1, 1, 1);
            horizonMaterial.SetVector("_OceanBounds", new Vector4(grid.W, grid.H, grid.Wrap ? 1 : 0, 0));
            // The camera far plane lies well inside this continuous ocean. No repeated map images
            // or visible water edge, even at maximum strategic zoom.
            const float horizon = 12000;
            mesh.Quad(new Vector3(-horizon, 0, horizon), new Vector3(grid.Period + horizon, 0, horizon),
                new Vector3(grid.Period + horizon, 0, -grid.H * 1.5f - horizon), new Vector3(-horizon, 0, -grid.H * 1.5f - horizon), color);
            oceanHorizon = mesh.Build("Ocean beyond playable geography");
        }

        public void MarkDirty(IEnumerable<int> chunkIds)
        {
            EnsureLayout();
            foreach (int c in chunkIds) if (c >= 0 && c < chunks.Length) chunks[c].Dirty = true;
        }

        public void MarkAllDirty()
        {
            EnsureLayout();
            foreach (var c in chunks) c.Dirty = true;
        }

        /// <summary>Set the no-tree flag of a tile; rebuilds its chunk only when the flag changes.</summary>
        public void SetBlocked(int tile, bool blocked) => SetBlockBit(tile, BlockCity, blocked);

        /// <summary>
        /// Mark a tile as battle wasteland (no trees). Perf pass 2: this used to share the town flag, so the ground
        /// field (wasteland: blocked) and every city cell recompose (no road or building: not blocked) flipped it back
        /// and forth in battle areas; each flip rebuilt the chunk and its trees popped in and out. The two sources are
        /// now separate bits (PerfFlags.LegacyTrees restores the shared flag).
        /// </summary>
        public void SetWasteland(int tile, bool wasteland) => SetBlockBit(tile, PerfFlags.LegacyTrees ? BlockCity : BlockWaste, wasteland);

        const byte BlockCity = 1, BlockWaste = 2;

        void SetBlockBit(int tile, byte bit, bool on)
        {
            EnsureLayout();
            if (tile < 0 || tile >= Blocked.Length) return;
            byte was = Blocked[tile];
            byte b = on ? (byte)(was | bit) : (byte)(was & ~bit);
            if (was == b) return;
            Blocked[tile] = b;
            if ((was != 0) != (b != 0)) chunks[world.ChunkOf(tile)].Dirty = true;   // only a change of "trees may grow" rebuilds
        }

        /// <summary>
        /// Per tile, the tree (bit t of TreeScars) and groundcover (GrassScars) slots a crater or trench has destroyed
        /// (perf pass 2). The server keeps only the newest few craters per tile, so older bowls drop out of the impact
        /// list as new shells land; trees used to be re-derived from the current list and grew back under every
        /// forgotten crater, then vanished under the next (continuous popping, and a chunk rebuild each time).
        /// A destroyed tree now stays destroyed for the life of the world. Off with PerfFlags.LegacyTrees.
        /// </summary>
        public uint[] TreeScars = new uint[0];
        public ulong[] GrassScars = new ulong[0];

        /// <summary>While set, no new chunk jobs start (geometry updates are waiting for the running ones to finish).</summary>
        public bool HoldScheduling;

        /// <summary>Collect finished jobs without waiting; true while any job is still reading the world's arrays.</summary>
        public bool PollBusy()
        {
            for (int k = pending.Count - 1; k >= 0; k--)
            {
                if (!pending[k].Handle.IsCompleted) continue;
                Finish(pending[k]);
                pending.RemoveAt(k);
            }
            return pending.Count > 0;
        }

        /// <summary>Wait for running jobs (call before the world's arrays change).</summary>
        public void CompleteAll()
        {
            for (int k = pending.Count - 1; k >= 0; k--) Finish(pending[k]);
            pending.Clear();
        }

        public void Update(Vector3 cameraPos)
        {
            EnsureLayout();
            if (!world.Ready) return;
            // collect finished meshes (never block on one still running)
            for (int k = pending.Count - 1; k >= 0; k--)
            {
                if (!pending[k].Handle.IsCompleted) continue;
                Finish(pending[k]);
                pending.RemoveAt(k);
            }
            // §30: a new dense-forest set (welcome) regrows every chunk's trees
            if (denseRevision != world.DenseRevision) { denseRevision = world.DenseRevision; foreach (var c in chunks) c.Dirty = true; }
            // schedule the nearest dirty chunks
            order.Clear();
            int dirty = 0;
            for (int i = 0; i < chunks.Length; i++)
                if (chunks[i].Dirty && !chunks[i].Building) { order.Add(i); dirty++; }
            DirtyCount = dirty;
            if (order.Count == 0 || pending.Count >= MaxJobs || HoldScheduling) return;
            float period = world.Grid.Period;
            sortCamera = cameraPos; sortPeriod = period;
            sortByDistance ??= (a, b) => ChunkDistance(a, sortCamera, sortPeriod).CompareTo(ChunkDistance(b, sortCamera, sortPeriod));
            order.Sort(sortByDistance);
            for (int k = 0; k < order.Count && pending.Count < MaxJobs; k++) Schedule(order[k]);
            JobHandle.ScheduleBatchedJobs();
        }

        float ChunkDistance(int c, Vector3 cam, float period)
        {
            int cs = WorldModel.ChunkSize;
            float x = (c % world.ChunksW + 0.5f) * cs * HexMath.Sqrt3, z = (c / world.ChunksW + 0.5f) * cs * 1.5f;
            float dx = HexMath.DxWrap(cam.x, x, period, world.Grid.Wrap);
            return dx * dx + (z - cam.z) * (z - cam.z);
        }

        void Schedule(int c)
        {
            var ch = chunks[c];
            ch.Dirty = false;
            ch.Building = true;
            int cs = WorldModel.ChunkSize, cx = c % world.ChunksW, cy = c / world.ChunksW;
            var p = new Pending
            {
                Chunk = c,
                Meshes = Mesh.AllocateWritableMeshData(3),
                Blocked = new NativeArray<byte>(cs * cs, Allocator.Persistent),
                TreeScars = new NativeArray<uint>(cs * cs, Allocator.Persistent),
                GrassScars = new NativeArray<ulong>(cs * cs, Allocator.Persistent),
                TreesA = new NativeArray<InstanceData>(cs * cs * 12, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                TreesB = new NativeArray<InstanceData>(cs * cs * 12, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                Grass = new NativeArray<InstanceData>(cs * cs * 64, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                Understory = new NativeArray<InstanceData>(cs * cs * 6, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                Counts = new NativeArray<int>(4, Allocator.Persistent),
                Bounds = new NativeArray<float>(6, Allocator.Persistent),
            };
            for (int lr = 0; lr < cs; lr++)
                for (int lq = 0; lq < cs; lq++)
                {
                    int q = cx * cs + lq, r = cy * cs + lr;
                    if (q < world.Grid.W && r < world.Grid.H)
                    {
                        int t = r * world.Grid.W + q;
                        p.Blocked[lr * cs + lq] = Blocked[t];
                        p.TreeScars[lr * cs + lq] = TreeScars[t];
                        p.GrassScars[lr * cs + lq] = GrassScars[t];
                    }
                }
            // the model pins its arrays for the life of the world; jobs read them in place
            var v = world.View;
            var job = new ChunkMeshJob
            {
                Height = v.Height, Water = v.Water, Known = v.Known, GeoFlags = v.GeoFlags, Biome = v.Biome, Nb = v.Nb, Geo = world.GeoPtr, Dense = world.DensePtr,
                Impacts = v.Impacts, ImpactCounts = v.ImpactCounts,
                Trenches = v.Trenches, Pads = v.Pads,
                W = world.Grid.W, H = world.Grid.H, WrapFlag = world.Grid.Wrap ? 1 : 0, Period = world.Grid.Period,
                Cx = cx, Cy = cy, Cs = cs, Seed = seed, OriginX = ch.OriginX, TreeDensity = TreeDensity, Season = Season, TreeHeight = TreeHeight,
                Meshes = p.Meshes, Layout = layout, Blocked = p.Blocked, TreeScars = p.TreeScars, GrassScars = p.GrassScars, StickyScars = PerfFlags.LegacyTrees ? 0 : 1, TreesA = p.TreesA, TreesB = p.TreesB, Grass = p.Grass, Understory = p.Understory, Counts = p.Counts, BoundsOut = p.Bounds,
            };
            p.Handle = job.Schedule();
            pending.Add(p);
        }

        void Finish(Pending p)
        {
            long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            FinishCore(p);
            double ms = (System.Diagnostics.Stopwatch.GetTimestamp() - t0) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            FinishMsTotal += ms; if (ms > FinishMsMax) FinishMsMax = ms;
            ChunksFinished++;
        }

        void FinishCore(Pending p)
        {
            p.Handle.Complete();
            var ch = p.Chunk < chunks.Length ? chunks[p.Chunk] : null;
            if (ch != null && epoch == world.Epoch)
            {
                if (ch.Hi == null)
                {
                    ch.Hi = new Mesh { name = "terrain-" + p.Chunk };
                    ch.Lo = new Mesh { name = "terrain-lo-" + p.Chunk };
                    ch.Water = new Mesh { name = "water-" + p.Chunk };
                    ch.Hi.MarkDynamic(); ch.Lo.MarkDynamic(); ch.Water.MarkDynamic();
                }
                applyTargets[0] = ch.Hi; applyTargets[1] = ch.Lo; applyTargets[2] = ch.Water;
                Mesh.ApplyAndDisposeWritableMeshData(p.Meshes, applyTargets, MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
                applyTargets[0] = applyTargets[1] = applyTargets[2] = null;
                var b = p.Bounds;
                var bounds = new Bounds();
                bounds.SetMinMax(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
                ch.Hi.bounds = bounds; ch.Lo.bounds = bounds; ch.Water.bounds = bounds;
                bounds.center += new Vector3(ch.OriginX, 0, 0);
                // Tree batches share the terrain chunk's culling bounds. Include the
                // canopy and wind motion so edge-of-screen forests do not disappear.
                bounds.Expand(new Vector3(1.2f, 1.9f, 1.2f));
                ch.Bounds = bounds;
                ch.HasMesh = ch.Hi.vertexCount > 0;
                ch.HasWater = ch.Water.vertexCount > 0;
                if (ch.TreesA == null)
                {
                    ch.TreesA = new InstanceBatch(MeshKit.Deciduous, RenderResources.TreeFoliage, 256);
                    ch.TreesB = new InstanceBatch(MeshKit.Conifer, RenderResources.TreeFoliage, 256);
                    ch.Grass = new InstanceBatch(MeshKit.Grass, RenderResources.GroundCover, 512);
                    ch.Understory = new InstanceBatch(MeshKit.Understory, RenderResources.Foliage, 128);
                }
                int oldTrees = ch.TreesA.Count + ch.TreesB.Count, newTrees = p.Counts[0] + p.Counts[1];
                if (oldTrees > 0 || newTrees > 0) { TreeRefills++; TreeChurn += System.Math.Abs(newTrees - oldTrees); if (newTrees > oldTrees && ch.HasMesh) TreesRegrown += newTrees - oldTrees; }
                Fill(ch.TreesA, p.TreesA, p.Counts[0], bounds);
                Fill(ch.TreesB, p.TreesB, p.Counts[1], bounds);
                Fill(ch.Grass, p.Grass, p.Counts[2], bounds);
                Fill(ch.Understory, p.Understory, p.Counts[3], bounds);
                // keep what the job destroyed (scars only ever gain bits; this chunk owns these tiles)
                {
                    int cs = WorldModel.ChunkSize, cx = p.Chunk % world.ChunksW, cy = p.Chunk / world.ChunksW;
                    for (int lr = 0; lr < cs; lr++)
                        for (int lq = 0; lq < cs; lq++)
                        {
                            int q = cx * cs + lq, r = cy * cs + lr;
                            if (q >= world.Grid.W || r >= world.Grid.H) continue;
                            int t = r * world.Grid.W + q;
                            TreeScars[t] |= p.TreeScars[lr * cs + lq];
                            GrassScars[t] |= p.GrassScars[lr * cs + lq];
                        }
                }
                ch.Building = false;
                ChunksBuilt++;
            }
            else p.Meshes.Dispose();
            p.Blocked.Dispose(); p.TreeScars.Dispose(); p.GrassScars.Dispose(); p.TreesA.Dispose(); p.TreesB.Dispose(); p.Grass.Dispose(); p.Understory.Dispose(); p.Counts.Dispose(); p.Bounds.Dispose();
        }

        static void Fill(InstanceBatch batch, NativeArray<InstanceData> src, int count, Bounds bounds)
        {
            batch.Clear();
            batch.Grow(count);
            NativeArray<InstanceData>.Copy(src, batch.Data, count);
            batch.Count = count;
            batch.Bounds = bounds;
            batch.MarkDirty();
        }

        public void Draw(WrapImages images, Vector3 cameraPos)
        {
            DrawnChunks = 0; TreeInstancesDrawn = 0; TreeShadowInstances = 0;
            if (ViewLod.Valid) cameraPos = ViewLod.Eye;   // detail bands follow the zoom, not the telephoto eye
            var terrainParams = new RenderParams(RenderResources.Terrain) { shadowCastingMode = ShadowCastingMode.On, receiveShadows = true };
            var waterParams = new RenderParams(RenderResources.Water) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = true };
            if (oceanHorizon != null)
            {
                int count = images.For(oceanHorizon.bounds, out float a, out float b, out float c);
                for (int i = 0; i < count; i++)
                {
                    float offset = i == 0 ? a : i == 1 ? b : c;
                    var bounds = oceanHorizon.bounds; bounds.center += new Vector3(offset, 0, 0);
                    Graphics.RenderMesh(new RenderParams(horizonMaterial) { worldBounds = bounds, shadowCastingMode = ShadowCastingMode.Off }, oceanHorizon, 0,
                        Matrix4x4.Translate(new Vector3(offset, 0, 0)));
                }
            }
            foreach (var ch in chunks)
            {
                if (!ch.HasMesh) continue;
                int n = images.For(ch.Bounds, out float o0, out float o1, out float o2);
                for (int k = 0; k < n; k++)
                {
                    float off = k == 0 ? o0 : k == 1 ? o1 : o2;
                    var b = ch.Bounds;
                    b.center += new Vector3(off, 0, 0);
                    float dist = Vector3.Distance(cameraPos, b.ClosestPoint(cameraPos));
                    var m = Matrix4x4.Translate(new Vector3(ch.OriginX + off, 0, 0));
                    terrainParams.worldBounds = b;
                    Graphics.RenderMesh(terrainParams, dist > LodDistance ? ch.Lo : ch.Hi, 0, m);
                    if (ch.HasWater) { waterParams.worldBounds = b; Graphics.RenderMesh(waterParams, ch.Water, 0, m); }
                    // forests never vanish when zoomed out: past every band they still draw as single-crown specks
                    // (TreeDistance now only ends the silhouette band early on low quality)
                    {
                        var shadows = dist < TreeShadowDistance ? ShadowCastingMode.On : ShadowCastingMode.Off;
                        if (dist >= TreeDistance) dist = Mathf.Max(dist, TreeSpeckDistance);
                        ch.TreesA.Shadows = shadows; ch.TreesB.Shadows = shadows;
                        int trees = ch.TreesA.Count + ch.TreesB.Count;
                        TreeInstancesDrawn += trees; if (shadows == ShadowCastingMode.On) TreeShadowInstances += trees;
                        ch.TreesA.Draw(off, k, meshOverride: dist < TreeLoDistance ? null : dist < TreeFarDistance ? MeshKit.DeciduousLo : dist < TreeSpeckDistance ? MeshKit.DeciduousFar : MeshKit.DeciduousSpeck);
                        ch.TreesB.Draw(off, k, meshOverride: dist < TreeLoDistance ? null : dist < TreeFarDistance ? MeshKit.ConiferLo : dist < TreeSpeckDistance ? MeshKit.ConiferFar : MeshKit.ConiferSpeck);
                    }
                    if (dist < 28f * Mathf.Clamp(TreeDensity, .55f, 1.1f))
                    { ch.Grass.Shadows = ShadowCastingMode.Off; ch.Grass.Draw(off, k); }
                    if (dist < 65f * Mathf.Clamp(TreeDensity, .6f, 1.1f))
                    { ch.Understory.Shadows = ShadowCastingMode.Off; ch.Understory.Draw(off, k); }
                    DrawnChunks++;
                }
            }
        }

        void DisposeChunk(Chunk c)
        {
            if (c == null) return;
            if (c.Hi != null) { Object.Destroy(c.Hi); Object.Destroy(c.Lo); Object.Destroy(c.Water); }
            c.TreesA?.Dispose(); c.TreesB?.Dispose(); c.Grass?.Dispose(); c.Understory?.Dispose();
        }

        public void Dispose()
        {
            CompleteAll();
            foreach (var c in chunks) DisposeChunk(c);
            chunks = new Chunk[0];
            if (oceanHorizon != null) Object.Destroy(oceanHorizon);
            if (horizonMaterial != null) Object.Destroy(horizonMaterial);
            if (layout.IsCreated) layout.Dispose();
        }
    }
}
