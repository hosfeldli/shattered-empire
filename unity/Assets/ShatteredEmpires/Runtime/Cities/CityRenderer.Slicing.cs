using System.Collections.Generic;
using System.Linq;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Time-sliced cell composition (perf pass 2, 2026-11-18). A cell holding a base compound took 80–165 ms to
    /// compose even when the compound itself was replayed from its cache (its streets, draped hex by hex, and the
    /// street mesh build dominate), and neighbouring base cells were composed together in one frame (100–560 ms
    /// frames). Composition now runs as resumable steps (<see cref="ComposeSteps"/>) that stop whenever the frame's
    /// budget (<see cref="ComposeBudgetMs"/>) is spent and continue next frame. A sliced compose builds into the
    /// cell's back buffer while the previous result stays drawn, and the finished cell replaces it at once, so
    /// nothing flickers or pops. Coupled base cells (which re-dirty each other through the ring invalidation) are
    /// still taken off the dirty set together and composed by one job, one after the other.
    /// <see cref="PerfFlags.LegacyCompose"/> restores the old one-frame loop. This partial is not unsafe: C# does
    /// not allow iterators in an unsafe context.
    /// </summary>
    public sealed partial class CityRenderer
    {
        /// <summary>
        /// Compose time per frame for the sliced path (ms). Smaller than the legacy <see cref="ComposeBudgetMs"/>: a sliced job
        /// pays it on every frame it runs, so it sets the steady cost while a base recomposes (measured: 5 ms raised p95 by ~4 ms).
        /// </summary>
        public double SliceBudgetMs = 2.5;
        readonly Dictionary<int, Cell> backCells = new Dictionary<int, Cell>();
        // the one in-flight job's street layers and mesh builder, reused (the placement ghost keeps its own)
        GroundLayers pooledLayers;
        MeshBuilder streetBuilder;
        IEnumerator<bool> composeJob;
        bool sliceActive;
        long sliceDeadline, sliceStart, frameDeadline;
        double jobPriorMs;
        int jobFrames;
        readonly List<int> jobCells = new List<int>();

        /// <summary>Diagnostics: the longest compose time spent in one frame (ms), jobs that spanned frames, the most frames one took.</summary>
        public double ComposeSliceMsMax;
        public int ComposeJobsSliced, ComposeJobFramesMax;
        /// <summary>Diagnostics: the longest single base compound stage (ms): road network, its drawing, presentation, development, old-town blocks.</summary>
        public readonly double[] BaseStageMsMax = new double[5];

        /// <summary>The frame's compose budget is spent (always false outside a sliced job).</summary>
        bool ComposeOverBudget => sliceActive && System.Diagnostics.Stopwatch.GetTimestamp() > sliceDeadline;

        /// <summary>Compose time of the current job so far (ms), counting only the frames' active slices.</summary>
        double ComposeActiveMs() => jobPriorMs + (System.Diagnostics.Stopwatch.GetTimestamp() - sliceStart) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;

        Cell GetBackCell(int id)
        {
            if (!backCells.TryGetValue(id, out var cell)) backCells[id] = cell = CreateCell(false);
            return cell;
        }

        /// <summary>The back buffer is complete: it becomes the drawn cell, the old one the next back buffer.</summary>
        void PresentBackCell(int id)
        {
            var next = backCells[id];
            if (cells.TryGetValue(id, out var shown)) backCells[id] = shown; else backCells.Remove(id);
            cells[id] = next;
        }

        void DisposeBackCells()
        {
            foreach (var c in backCells.Values) DisposeCell(c);
            backCells.Clear();
        }

        /// <summary>Drop a job in progress (a new world): nothing it built is kept.</summary>
        void AbandonComposeJob()
        {
            composeJob = null;
            jobCells.Clear();
            instanceTap = null;
            if (streetGeometry != null) streetGeometry.Tap = null;
            sliceActive = false;
        }

        /// <summary>Run the job in progress within this frame's budget; true when there is none left (more may start).</summary>
        bool ResumeComposeJob()
        {
            long now = System.Diagnostics.Stopwatch.GetTimestamp();
            frameDeadline = now + (long)(SliceBudgetMs * System.Diagnostics.Stopwatch.Frequency / 1000.0);
            if (composeJob == null) return true;
            if (PerfFlags.LegacyCompose) { sliceActive = false; Drain(); return true; }
            BeginSlice(now, frameDeadline);
            jobFrames++;
            bool done = Advance();
            EndSlice();
            return done;
        }

        void BeginSlice(long start, long deadline) { sliceActive = true; sliceStart = start; sliceDeadline = deadline; }

        void EndSlice()
        {
            double ms = (System.Diagnostics.Stopwatch.GetTimestamp() - sliceStart) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            jobPriorMs += ms;
            if (ms > ComposeSliceMsMax) ComposeSliceMsMax = ms;
            sliceActive = false;
        }

        /// <summary>Step the job until it yields over budget or ends; true when it ended.</summary>
        bool Advance()
        {
            while (composeJob.MoveNext()) if (ComposeOverBudget) return false;
            composeJob = null;
            if (jobFrames > 1) ComposeJobsSliced++;
            if (jobFrames > ComposeJobFramesMax) ComposeJobFramesMax = jobFrames;
            return true;
        }

        void Drain() { while (composeJob != null && composeJob.MoveNext()) { } composeJob = null; }

        /// <summary>
        /// The sliced form of the compose loop in <see cref="Update"/>: the nearest dirty cells in order, each run as a
        /// job until the frame's budget is spent; a job left unfinished continues next frame (<see cref="ResumeComposeJob"/>).
        /// </summary>
        void ScheduleSliced(int n, Landscape.TerrainRenderer terrain, float clock, long frameStart)
        {
            // one budget per frame, shared with the job resumed at the start of Update
            long deadline = frameDeadline != 0 ? frameDeadline : frameStart + (long)(SliceBudgetMs * System.Diagnostics.Stopwatch.Frequency / 1000.0);
            for (int k = 0; k < n; k++)
            {
                if (System.Diagnostics.Stopwatch.GetTimestamp() > deadline) break;
                jobCells.Clear();
                int c = scratch[k];
                jobCells.Add(c);
                // coupled base cells go together (see the legacy loop): all of them leave the dirty set now
                if (baseCells.Contains(c))
                    while (k + 1 < n && baseCells.Contains(scratch[k + 1])) jobCells.Add(scratch[++k]);
                foreach (int id in jobCells) dirty.Remove(id);
                composeJob = ComposeJob(new List<int>(jobCells), terrain, clock);
                jobPriorMs = 0; jobFrames = 1;
                BeginSlice(System.Diagnostics.Stopwatch.GetTimestamp(), deadline);
                bool done = Advance();
                EndSlice();
                if (!done) return;
            }
        }

        /// <summary>One or more cells composed in order, with the per-cell base accounting of the legacy loop.</summary>
        IEnumerator<bool> ComposeJob(List<int> ids, Landscape.TerrainRenderer terrain, float clock)
        {
            foreach (int c in ids)
            {
                double composeStart = ComposeActiveMs();
                var steps = ComposeSteps(c, terrain, true);
                while (steps.MoveNext()) yield return false;
                float ms = (float)(ComposeActiveMs() - composeStart);
                if (baseCells.Contains(c))
                {
                    BaseCellComposes++; BaseCellComposeMsTotal += ms; BaseCellComposeMsMax = Mathf.Max(BaseCellComposeMsMax, ms);
                    // a recompose costing ms (of compose work, not of waiting frames) holds the next one back ms x 0.05 s
                    if (baseComposedOnce.Contains(c)) baseHold = Mathf.Clamp(ms * .05f, 0f, 4f);
                    baseComposedOnce.Add(c);
                    // the hold runs from when the compose finished, not from when its job started frames ago
                    // (a slow sliced job otherwise let the next base recompose start almost at once)
                    lastBaseCompose = Time.realtimeSinceStartup;
                }
                else PlainComposeMsMax = System.Math.Max(PlainComposeMsMax, ms);
            }
        }

        /// <summary>
        /// A cell's composition as resumable steps. Sliced, it is built into the cell's back buffer, yielding whenever
        /// the frame's compose budget is spent, and the finished cell replaces the drawn one in one step; unsliced it
        /// composes straight into the drawn cell exactly as before.
        /// </summary>
        IEnumerator<bool> ComposeSteps(int cellId, Landscape.TerrainRenderer terrain, bool sliced)
        {
            Recomposed++;
            var cell = sliced ? GetBackCell(cellId) : GetCell(cellId);
            current = cell;
            cell.Flags.Clear();
            foreach (var b in cell.Batches) b.Clear();
            BeginStreetMesh();
            // perf pass 2 (GC): a sliced compose draws its quads into a pooled set of layer lists, not fresh ones
            if (sliced) { pooledLayers ??= new GroundLayers(); pooledLayers.Reset(); streetGeometry = pooledLayers; }
            bmin = new float3(1e9f); bmax = new float3(-1e9f);
            var g = world.Grid;
            double tp0 = ComposeActiveMs();
            int cs = WorldModel.ChunkSize, cx = cellId % world.ChunksW, cy = cellId / world.ChunksW;
            // streets and bridges of the cell's hexes (each edge drawn by its lower-index end), replayed from the
            // street cache while nothing they read has changed (CityRenderer.StreetCache.cs)
            if (!Showcase) { var streets = ComposeCellStreetsSteps(cellId); while (streets.MoveNext()) yield return false; }
            HexLoopMs[0] += ComposeActiveMs() - tp0;
            for (int lr = 0; lr < cs; lr++)
            {
                for (int lq = 0; lq < cs; lq++)
                {
                    int q = cx * cs + lq, r = cy * cs + lr;
                    if (q >= g.W || r >= g.H) continue;
                    int t = r * g.W + q;
                    if (world.Known[t] == 0) continue;
                    if (world.Road[t] != 0 && world.IsUrban(t) && !ActionRts && !Showcase) StreetLife(t);
                    if (world.IsUrban(t) && !hasBuildingAt(t) && !Ruins.ContainsKey(t) && !world.IsSea(t) && !world.IsLake(t)
                        && !ActionRts && !Showcase) Infill(t);
                    long th2 = System.Diagnostics.Stopwatch.GetTimestamp();
                    ComposeOldWorld(t);
                    long th3 = System.Diagnostics.Stopwatch.GetTimestamp();
                    terrain.SetBlocked(t, IsBlocked(t));
                    long th4 = System.Diagnostics.Stopwatch.GetTimestamp();
                    double kk = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
                    HexLoopMs[1] += (th3 - th2) * kk; HexLoopMs[2] += (th4 - th3) * kk;
                }
                if (ComposeOverBudget) yield return false;
            }
            double tp1 = ComposeActiveMs();
            if (ActionRts)
            {
                // copies: the site and building tables may change between the frames of a sliced compose
                var sites = new List<ObjectiveSite>();
                foreach (var site in objectiveByTile.Values) if (site.IsBase && world.ChunkOf(site.Tile) == cellId) sites.Add(site);
                foreach (var site in sites)
                {
                    var district = ComposeCityDistrictSteps(site);
                    while (district.MoveNext()) yield return false;
                    if (ComposeOverBudget) yield return false;
                }
            }
            double tp2 = ComposeActiveMs();
            if (ActionRts) foreach (var pickup in pickups.Values)
                if (world.ChunkOf(pickup.Tile) == cellId) MaterialsPickup(pickup);
            if (Showcase) ComposeShowcaseStreets(cellId);
            var buildings = new List<BuildingRecord>();
            foreach (var b in structures.Buildings.Values)
                if (b.Tile >= 0 && b.Tile < g.N && world.ChunkOf(b.Tile) == cellId && world.Known[b.Tile] != 0) buildings.Add(b);
            foreach (var b in buildings)
            {
                ComposeBuilding(b);
                if (b.Done && !ActionRts && !Showcase) DistrictLinks(b.Tile);
                if (ComposeOverBudget) yield return false;
            }
            double tp3 = ComposeActiveMs();
            cell.Any = false;
            foreach (var batch in cell.Batches) if (batch.Count > 0) cell.Any = true;
            var finish = FinishStreetMeshSteps(cell, sliced);
            while (finish.MoveNext()) yield return false;
            double tp4 = ComposeActiveMs();
            ComposeMs[0] += tp1 - tp0; ComposeMs[1] += tp2 - tp1; ComposeMs[2] += tp3 - tp2; ComposeMs[3] += tp4 - tp3;
            var bounds = new Bounds();
            if (cell.Any) bounds.SetMinMax(new Vector3(bmin.x, bmin.y - 0.2f, bmin.z), new Vector3(bmax.x, bmax.y + 0.2f, bmax.z));
            cell.Bounds = bounds;
            foreach (var batch in cell.Batches) { batch.Bounds = bounds; batch.MarkDirty(); }
            if (sliced) PresentBackCell(cellId);
        }

        /// <summary>The cell's street mesh: the draped quads walked in slices, then one mesh build.</summary>
        IEnumerator<bool> FinishStreetMeshSteps(Cell cell, bool sliced)
        {
            if (!sliced) { FinishStreetMesh(cell); yield break; }
            cell.StreetBatch?.Dispose();
            cell.StreetBatch = null;
            if (cell.Streets != null) Object.Destroy(cell.Streets);
            cell.Streets = null;
            if (streetQuads == 0) yield break;
            var geometry = streetGeometry;
            var builder = streetBuilder ??= new MeshBuilder();
            builder.Clear();
            int n = 0;
            foreach (var layer in geometry.Layers)
                for (int i = 0; i < layer.Count; i++)
                {
                    var q = layer[i];
                    builder.Surface(q.Surface).Quad(q.A, q.B, q.C, q.D, q.Color);
                    // the layer lists belong to this job's geometry alone, so they cannot change while it waits
                    if ((++n & 255) == 0 && ComposeOverBudget) yield return false;
                }
            cell.Streets = builder.Build("Continuous streets and pavements");
            builder.Clear();
            cell.StreetBatch = new InstanceBatch(cell.Streets, GroundOverlayMaterial, 1)
            { Bounds = cell.Streets.bounds, Shadows = ShadowCastingMode.Off };
            cell.StreetBatch.Add(InstanceData.TRS(float3.zero, 0, new float3(1), new float4(1, 1, 1, 0)));
            bmin = math.min(bmin, (float3)cell.Streets.bounds.min);
            bmax = math.max(bmax, (float3)cell.Streets.bounds.max);
            cell.Any = true;
        }

        /// <summary>The cell's road hexes' streets, composed or replayed hex by hex, yielding between hexes.</summary>
        IEnumerator<bool> ComposeCellStreetsSteps(int cellId)
        {
            var g = world.Grid;
            int cs = WorldModel.ChunkSize, cx = cellId % world.ChunksW, cy = cellId / world.ChunksW;
            ulong sites = BaseSitesKey();
            for (int lr = 0; lr < cs; lr++)
                for (int lq = 0; lq < cs; lq++)
                {
                    int q = cx * cs + lq, r = cy * cs + lr;
                    if (q >= g.W || r >= g.H) continue;
                    int t = r * g.W + q;
                    if (world.Known[t] == 0 || world.Road[t] == 0) { streetCache.Remove(t); continue; }
                    ulong key = HexStreetKey(t, sites);
                    if (streetCache.TryGetValue(t, out var rec) && rec.Key == key && !PerfFlags.LegacyStreets)
                    {
                        foreach (var (part, data) in rec.Instances) current.Batches[part].Add(data);
                        streetGeometry.Replay(rec.Quads);
                        streetQuads += rec.QuadCount;
                        if (rec.Min.x <= rec.Max.x) { bmin = math.min(bmin, rec.Min); bmax = math.max(bmax, rec.Max); }
                        StreetsReplayed++;
                        continue;
                    }
                    if (rec != null) for (int i = 0; i < StreetKeyParts; i++) if (rec.Parts[i] != streetParts[i]) StreetMissBy[i]++;
                    rec = new StreetRecord { Key = key };
                    System.Array.Copy(streetParts, rec.Parts, StreetKeyParts);
                    var outerMin = bmin; var outerMax = bmax;
                    bmin = new float3(1e9f); bmax = new float3(-1e9f);
                    int quads0 = streetQuads;
                    instanceTap = rec.Instances;
                    streetGeometry.Tap = rec.Quads;
                    ComposeStreets(t);
                    instanceTap = null;
                    streetGeometry.Tap = null;
                    rec.Min = bmin; rec.Max = bmax; rec.QuadCount = streetQuads - quads0;
                    bmin = math.min(outerMin, bmin); bmax = math.max(outerMax, bmax);
                    streetCache[t] = rec;
                    StreetsBuilt++;
                    if (ComposeOverBudget) yield return false;   // between hexes: no record is open here
                }
        }

        /// <summary>
        /// A base compound (CityRenderer.Rings.cs ComposeCityDistrict) as stages: road network, its drawing, the
        /// presentation, the passive development and the old town's blocks, yielding between them when the budget is
        /// spent. The compound's record stays open across those frames; the placement ghost saves and restores it
        /// (CityRenderer.Catalog.cs SetGhost).
        /// </summary>
        IEnumerator<bool> ComposeCityDistrictSteps(ObjectiveSite site)
        {
            if (site.Parcels == null || site.Parcels.Length < MinRingParcels) yield break;
            // sockets in ring order (3, 5 or 7 open by tier; the server may send any count up to the ring size)
            var lots = site.Parcels.Where(p => p.Id > 0).OrderBy(p => p.Id).ToArray();
            if (lots.Length < MinRingParcels - 1 || lots.Length > 12) yield break;
            // The compound only changes with its own state (CityRenderer.BaseCache.cs): shells, damage and units
            // inside the cell replay the recorded compound instead of composing it again.
            ulong key = BaseSignature(site, lots);
            if (RoadCurve.CompoundLanes.ContainsKey(site.Id) && ReplayBase(site.Id, key)) yield break;
            var record = BeginBaseRecord(key, out var outerMin, out var outerMax, out int flagStart);
            var origin = new float2(site.X, site.Z);
            var nodes = lots.Select(p => origin + (new float2(p.X, p.Z) - origin) * .57f).ToArray();
            bool restored = site.Headquarters != 0;
            double s0 = ComposeActiveMs();
            var network = BuildCompoundRoadNetwork(site, lots, nodes);
            // published for the road queries (trench crossings follow the roads actually drawn)
            var lanes = network.Where(r => r.Apron == 0).Select(r => new RoadCurve.Lane { Points = r.Points, Half = Mathf.Max(r.Width, r.EndWidth) * .5f }).ToArray();
            // a recompose usually rebuilds the same lanes: only a real change re-runs what follows the lanes
            // (the warzone's trench road gaps rebuild the whole battlefield on LaneRevision)
            bool lanesChanged = !RoadCurve.CompoundLanes.TryGetValue(site.Id, out var previousLanes) || !RoadCurve.SameLanes(previousLanes, lanes);
            if (PerfFlags.LegacyBaseKey || lanesChanged) RoadCurve.LaneRevision++;
            RoadCurve.CompoundLanes[site.Id] = lanes;
            // defenses near the compound stand beside its roads (RoadsidePosition): those composed in other cells
            // before these lanes existed (or changed) take their roadside place on their cell's next compose
            if (lanesChanged) DirtyRoadsideDefenses(site);
            double s1 = ComposeActiveMs(); NoteBaseStage(0, s1 - s0);
            if (ComposeOverBudget) yield return false;
            s1 = ComposeActiveMs();
            { var draw = DrawCompoundRoadNetworkSteps(network, restored); while (draw.MoveNext()) yield return false; }
            double s2 = ComposeActiveMs(); NoteBaseStage(1, s2 - s1);
            if (ComposeOverBudget) yield return false;
            s2 = ComposeActiveMs();
            { var presentation = ComposeBasePresentationSteps(site, lots, nodes); while (presentation.MoveNext()) yield return false; }
            double s3 = ComposeActiveMs(); NoteBaseStage(2, s3 - s2);
            if (ComposeOverBudget) yield return false;
            s3 = ComposeActiveMs();
            ComposeBaseDevelopment(site, lots);   // passive development outside the foundation (decoration only)
            double s4 = ComposeActiveMs(); NoteBaseStage(3, s4 - s3);
            if (ComposeOverBudget) yield return false;
            s4 = ComposeActiveMs();
            // A held base keeps clean sockets; only an unclaimed compound still shows the old town's ruins.
            bool held = site.Headquarters != 0 && site.Owner >= 0;
            for (int i = 0; i < lots.Length && !held; i++)
            {
                var parcel = lots[i];
                bool occupied = structures.Buildings.Values.Any(b => b.City == site.Id && b.Slot == parcel.Id);
                if (!occupied) HistoricalBlock(parcel, site.Kind);
            }
            NoteBaseStage(4, ComposeActiveMs() - s4);
            EndBaseRecord(site.Id, record, outerMin, outerMax, flagStart);
        }

        /// <summary>CityRenderer.RoadConnections.cs DrawCompoundRoadNetwork as resumable steps (between road segments).</summary>
        IEnumerator<bool> DrawCompoundRoadNetworkSteps(List<CompoundRoute> routes, bool restored)
        {
            // A small spatial hash clips verges at REAL junction mouths. Sidewalks
            // follow the union's edge instead of continuing across an intersecting lane.
            const float cell = .35f;
            var buckets = new Dictionary<long, List<(int route, int segment)>>();
            long Key(int x, int z) => ((long)x << 32) ^ (uint)z;
            for (int r = 0; r < routes.Count; r++) for (int k = 0; k + 1 < routes[r].Points.Length; k++)
            {
                var route = routes[r]; var a = route.Points[k]; var b = route.Points[k + 1];
                float half = Mathf.Max(RouteHalf(route, k), RouteHalf(route, k + 1)) + .025f;
                int2 lo = (int2)math.floor((math.min(a, b) - half) / cell), hi = (int2)math.floor((math.max(a, b) + half) / cell);
                for (int x = lo.x; x <= hi.x; x++) for (int z = lo.y; z <= hi.y; z++)
                { long key = Key(x, z); if (!buckets.TryGetValue(key, out var list)) buckets[key] = list = new List<(int, int)>(); list.Add((r, k)); }
            }
            bool CrossesLane(float2 point, int own)
            {
                var key = (int2)math.floor(point / cell);
                if (!buckets.TryGetValue(Key(key.x, key.y), out var list)) return false;
                foreach (var segment in list)
                {
                    if (segment.route == own) continue;
                    var route = routes[segment.route]; var a = route.Points[segment.segment]; var delta = route.Points[segment.segment + 1] - a;
                    float t = math.saturate(math.dot(point - a, delta) / Mathf.Max(.000001f, math.lengthsq(delta)));
                    if (math.distance(point, a + delta * t) < RouteHalf(route, segment.segment + t) + .018f) return true;
                }
                return false;
            }
            for (int r = 0; r < routes.Count; r++)
            {
                var route = routes[r];
                if (route.Apron > 0)
                {
                    // under the carriageways (lift below 0), in the ring road's asphalt
                    var tone = restored ? route.BaseColor : math.lerp(route.BaseColor, new float3(.36f, .35f, .31f), .30f);
                    GroundDisc(route.Points[0], route.Apron, float.NegativeInfinity, -.0006f, tone, SurfaceKind.Asphalt);
                    continue;
                }
                for (int k = 0; k + 1 < route.Points.Length; k++)
                {
                    var a = route.Points[k]; var b = route.Points[k + 1]; var sa = RouteSide(route, k); var sb = RouteSide(route, k + 1);
                    float ha = RouteHalf(route, k), hb = RouteHalf(route, k + 1), t = (k + .5f) / (route.Points.Length - 1);
                    var color = math.lerp(route.BaseColor, route.EndColor, math.smoothstep(.3f, 1, t));
                    if (!restored) color = math.lerp(color, new float3(.36f, .35f, .31f), .30f);
                    CompoundBand(a, b, sa, sb, -ha, ha, -hb, hb, 0, color, route.Surface);
                    if (ComposeOverBudget) yield return false;
                    if (!route.Pavement) continue;
                    float pavement = math.lerp(.05f, route.EndPavement, math.smoothstep(.65f, 1, t));
                    if (pavement < .003f) continue;
                    for (int side = -1; side <= 1; side += 2)
                    {
                        var middle = (a + b + (sa * (ha + .025f) + sb * (hb + .025f)) * side) * .5f;
                        if (CrossesLane(middle, r)) continue;
                        CompoundBand(a, b, sa, sb, side * ha, side * (ha + pavement), side * hb, side * (hb + pavement), .0045f, new float3(.55f, .56f, .52f), SurfaceKind.Concrete);
                        CompoundBand(a, b, sa, sb, side * ha, side * (ha + .006f), side * hb, side * (hb + .006f), .0055f, new float3(.63f, .64f, .59f), SurfaceKind.Concrete);
                    }
                }
            }
        }

        /// <summary>CityRenderer.BasePresentation.cs ComposeBasePresentation as resumable steps (after the foundation, after each socket).</summary>
        IEnumerator<bool> ComposeBasePresentationSteps(ObjectiveSite site, BaseParcel[] lots, float2[] nodes)
        {
            bool held = site.Headquarters != 0 && site.Owner >= 0;
            if (!held) yield break;
            var origin = new float2(site.X, site.Z);
            float memory = site.Memory ? .62f : 1f;
            var team = CivColor(site.Owner).xyz;
            int tier = Mathf.Clamp(Mathf.Max(site.Tier, 1), 1, 3);
            float glow = site.Memory ? 0f : 1f;
            float foundation = FoundationRadius(origin, lots);

            // the shared round foundation, its kerb and a darker skirt where it meets the land
            GroundSector(origin, 0, foundation, 0, 2 * math.PI, -.0050f, FoundationConcrete * memory, SurfaceKind.Concrete);
            GroundSector(origin, foundation, foundation + .10f, 0, 2 * math.PI, -.0049f, new float3(.47f, .46f, .42f) * memory, SurfaceKind.Concrete);
            GroundSector(origin, foundation - .055f, foundation - .02f, 0, 2 * math.PI, -.0048f, KerbConcrete * memory, SurfaceKind.Concrete);

            // the hub: plaza, a dark collar round the HQ podium, the team ring and lamps
            GroundSector(origin, 0, .92f, 0, 2 * math.PI, -.0035f, FoundationConcrete * .93f * memory, SurfaceKind.Concrete);
            GroundSector(origin, .62f, .70f, 0, 2 * math.PI, -.0030f, PaintDark * 1.6f * memory, SurfaceKind.Asphalt);
            GroundSector(origin, .71f, .78f, 0, 2 * math.PI, -.0015f, team * memory, SurfaceKind.Plain);
            for (int k = 0; k < 8; k++)
            {
                float a = k * math.PI * .25f + math.PI * .125f;
                GroundLight(origin + Polar(a) * .87f, a, new float3(.03f, .012f, .03f), team, .9f * glow);
            }

            if (ComposeOverBudget) yield return false;
            var occupants = new Dictionary<int, BuildingRecord>();
            foreach (var b in structures.Buildings.Values) if (b.City == site.Id && b.Slot > 0) occupants[b.Slot] = b;
            float hubY = BuildingDatum(origin.x, origin.y, site.Parcels[0].Yaw);
            // The server opens sockets in (parcel tier, ring index) order, `capacity` of them: 3 / 5 / 7 by base tier.
            // A socket's rank in that order says from which base tier it opens; one past the last tier never does.
            var order = (BaseParcel[])lots.Clone();
            System.Array.Sort(order, (a, b) => a.Tier != b.Tier ? a.Tier.CompareTo(b.Tier) : a.Id.CompareTo(b.Id));
            int RankOf(int id) { for (int r = 0; r < order.Length; r++) if (order[r].Id == id) return r; return order.Length; }
            int capacity = site.Capacity > 0 ? site.Capacity : 0;
            for (int i = 0; i < lots.Length; i++)
            {
                var lot = lots[i];
                var center = new float2(lot.X, lot.Z);
                bool built = occupants.TryGetValue(lot.Id, out var building);
                int rank = RankOf(lot.Id);
                int needs = capacity > 0 ? (rank < 3 ? 1 : rank < 5 ? 2 : rank < 7 ? 3 : 0) : (lot.Tier <= 3 ? lot.Tier : 0);
                bool open = capacity > 0 ? rank < capacity : lot.Tier <= tier;
                float w = lot.Width > .1f ? lot.Width : .95f, d = lot.Depth > .1f ? lot.Depth : .88f;
                float alt = (i % 2) * .0002f;
                if (built) SocketPad(center, lot.Yaw, w, d, building.Type, team, memory, alt);
                else if (open) OpenSocket(center, lot.Yaw, w, d, team, glow, memory, alt);
                else if (needs > 0) LockedSocket(center, lot.Yaw, w, d, needs, memory, alt);
                if (built || open)
                {
                    DockingArm(origin, nodes[i], hubY, team, built && building.Done, glow, memory);
                    // the identity glyph on the causeway, between the ring road and the threshold
                    var front = Polar(lot.Yaw);
                    var threshold = center + front * (d * .5f);
                    var mark = threshold + math.normalizesafe(nodes[i] - threshold) * math.min(.12f, math.distance(nodes[i], threshold) * .33f);
                    if (built) IdentityGlyph(mark, lot.Yaw + math.PI, building.Type, memory);
                }
                if (tier >= 2) SocketWall(center, lot.Yaw, w, d, tier, team, memory, glow, i);
                if (ComposeOverBudget) yield return false;
            }

            // tier 3: plaza flags in the team colour
            if (tier >= 3)
            {
                var c = new Ctx { X = site.X, Z = site.Z, Yaw = site.Parcels[0].Yaw, Seed = site.Id * 31 + 7, Tint = new float3(memory),
                    Civ = team, Era = 1, Level = 1, Tier = tier, FixedGround = true, GroundY = Ground(site.X, site.Z) - .01f };
                for (int k = 0; k < 4; k++)
                {
                    float a = k * math.PI * .5f + math.PI * .25f;
                    math.sincos(a, out float s, out float co);
                    Flag(c, s * .83f, co * .83f, .46f);
                }
            }
        }

        void NoteBaseStage(int k, double ms) { if (ms > BaseStageMsMax[k]) BaseStageMsMax[k] = ms; }
    }
}
