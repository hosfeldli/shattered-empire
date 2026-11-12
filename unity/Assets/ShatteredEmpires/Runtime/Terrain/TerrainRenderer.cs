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
            public NativeArray<InstanceData> TreesA, TreesB, Grass, Understory;
            public NativeArray<int> Counts;
            public NativeArray<float> Bounds;
        }

        readonly WorldModel world;
        Chunk[] chunks = new Chunk[0];
        readonly List<Pending> pending = new List<Pending>();
        readonly List<int> order = new List<int>();
        public byte[] Blocked = new byte[0];   // per tile: towns, buildings and roads keep trees away
        public int MaxJobs = 6;
        public float LodDistance = 70f, TreeDistance = 110f, TreeShadowDistance = 45f;
        public float TreeDensity = 1f;
        public int ChunksBuilt { get; private set; }
        public int DrawnChunks { get; private set; }
        public int DirtyCount { get; private set; }
        int epoch = -1, seed;

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
        public void SetBlocked(int tile, bool blocked)
        {
            EnsureLayout();
            if (tile < 0 || tile >= Blocked.Length) return;
            byte b = blocked ? (byte)1 : (byte)0;
            if (Blocked[tile] == b) return;
            Blocked[tile] = b;
            chunks[world.ChunkOf(tile)].Dirty = true;
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
            // schedule the nearest dirty chunks
            order.Clear();
            int dirty = 0;
            for (int i = 0; i < chunks.Length; i++)
                if (chunks[i].Dirty && !chunks[i].Building) { order.Add(i); dirty++; }
            DirtyCount = dirty;
            if (order.Count == 0 || pending.Count >= MaxJobs) return;
            float period = world.Grid.Period;
            order.Sort((a, b) => ChunkDistance(a, cameraPos, period).CompareTo(ChunkDistance(b, cameraPos, period)));
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
                TreesA = new NativeArray<InstanceData>(cs * cs * 10, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                TreesB = new NativeArray<InstanceData>(cs * cs * 10, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                Grass = new NativeArray<InstanceData>(cs * cs * 64, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                Understory = new NativeArray<InstanceData>(cs * cs * 4, Allocator.Persistent, NativeArrayOptions.UninitializedMemory),
                Counts = new NativeArray<int>(4, Allocator.Persistent),
                Bounds = new NativeArray<float>(6, Allocator.Persistent),
            };
            for (int lr = 0; lr < cs; lr++)
                for (int lq = 0; lq < cs; lq++)
                {
                    int q = cx * cs + lq, r = cy * cs + lr;
                    if (q < world.Grid.W && r < world.Grid.H) p.Blocked[lr * cs + lq] = Blocked[r * world.Grid.W + q];
                }
            // the model pins its arrays for the life of the world; jobs read them in place
            var v = world.View;
            var job = new ChunkMeshJob
            {
                Height = v.Height, Water = v.Water, Known = v.Known, GeoFlags = v.GeoFlags, Biome = v.Biome, Nb = v.Nb, Geo = world.GeoPtr,
                Impacts = v.Impacts, ImpactCounts = v.ImpactCounts,
                Trenches = v.Trenches,
                W = world.Grid.W, H = world.Grid.H, WrapFlag = world.Grid.Wrap ? 1 : 0, Period = world.Grid.Period,
                Cx = cx, Cy = cy, Cs = cs, Seed = seed, OriginX = ch.OriginX, TreeDensity = TreeDensity,
                Meshes = p.Meshes, Layout = layout, Blocked = p.Blocked, TreesA = p.TreesA, TreesB = p.TreesB, Grass = p.Grass, Understory = p.Understory, Counts = p.Counts, BoundsOut = p.Bounds,
            };
            p.Handle = job.Schedule();
            pending.Add(p);
        }

        void Finish(Pending p)
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
                Mesh.ApplyAndDisposeWritableMeshData(p.Meshes, new[] { ch.Hi, ch.Lo, ch.Water }, MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
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
                    ch.TreesA = new InstanceBatch(MeshKit.Deciduous, RenderResources.Foliage, 256);
                    ch.TreesB = new InstanceBatch(MeshKit.Conifer, RenderResources.Foliage, 256);
                    ch.Grass = new InstanceBatch(MeshKit.Grass, RenderResources.GroundCover, 512);
                    ch.Understory = new InstanceBatch(MeshKit.Understory, RenderResources.Foliage, 128);
                }
                Fill(ch.TreesA, p.TreesA, p.Counts[0], bounds);
                Fill(ch.TreesB, p.TreesB, p.Counts[1], bounds);
                Fill(ch.Grass, p.Grass, p.Counts[2], bounds);
                Fill(ch.Understory, p.Understory, p.Counts[3], bounds);
                ch.Building = false;
                ChunksBuilt++;
            }
            else p.Meshes.Dispose();
            p.Blocked.Dispose(); p.TreesA.Dispose(); p.TreesB.Dispose(); p.Grass.Dispose(); p.Understory.Dispose(); p.Counts.Dispose(); p.Bounds.Dispose();
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
            DrawnChunks = 0;
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
                    if (dist < TreeDistance)
                    {
                        var shadows = dist < TreeShadowDistance ? ShadowCastingMode.On : ShadowCastingMode.Off;
                        ch.TreesA.Shadows = shadows; ch.TreesB.Shadows = shadows;
                        ch.TreesA.Draw(off, k, meshOverride: dist < 18f ? null : dist < 55f ? MeshKit.DeciduousLo : MeshKit.DeciduousFar);
                        ch.TreesB.Draw(off, k, meshOverride: dist < 18f ? null : dist < 55f ? MeshKit.ConiferLo : MeshKit.ConiferFar);
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
