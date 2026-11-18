using System;
using System.Collections.Generic;
using SE.Core.Protocol;
using SE.Core.World;
using SE.Runtime.Cities;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Battlefields
{
    /// <summary>
    /// The built battlefield, from the server's records: WW1-style trench networks (drawn by
    /// <see cref="TrenchRenderer"/>: continuous revetted works with duckboard floors, sandbagged parapets
    /// on the enemy side and a lower parados behind, following the terrain; construction shown as it
    /// progresses). No-man's land gets
    /// barbed-wire belts, shattered stumps and debris; destroyed vehicles stay where they fell.
    /// Rebuilt only when trenches, battlefield or terrain change.
    /// </summary>
    public sealed unsafe class WarzoneRenderer : IDisposable
    {
        enum Part { Floor, Bag, Plank, Coil, Post, Stump, Debris, Wreck, LightWreck, GunWreck, AirWreck, Branch, TankObstacle, Scorch, Count }

        readonly InstanceBatch[] batches = new InstanceBatch[(int)Part.Count];
        readonly WorldModel world;
        readonly HashSet<int> trenchTiles = new HashSet<int>();
        readonly Dictionary<int, TrenchRecord> byTile = new Dictionary<int, TrenchRecord>();
        public readonly List<float3> BurningWrecks = new List<float3>();
        int trenchRev = -1, bfRev = -1, geoRev = -1, structRev = -1, roadRev = int.MinValue;
        readonly List<Mesh> ownedMeshes = new List<Mesh>();
        public Func<int, string> DefenceAt = _ => null;   // building type at a tile (joins trenches to defences)
        public Func<int, int> BuildingOwnerAt = _ => -1;
        /// <summary>The trench works (continuous terrain-following meshes and their details).</summary>
        public readonly TrenchRenderer Works;

        public WarzoneRenderer(WorldModel w)
        {
            world = w;
            Works = new TrenchRenderer(w, t => DefenceAt(t), t => BuildingOwnerAt(t));
            Mesh[] meshes = { MeshKit.Box, MeshKit.Sandbags, MeshKit.Box, MeshKit.Coil, MeshKit.Cylinder, WorldMeshes.SnappedTree(), MeshKit.Box, MeshKit.Wreck,
                WorldMeshes.LightVehicleWreck(), MeshKit.Wreck, WorldMeshes.AircraftWreck(), WorldMeshes.FallenBranch(), MeshKit.TankObstacle,
                MeshKit.Disc };
            foreach (int index in new[] { 5, 8, 10, 11 }) ownedMeshes.Add(meshes[index]);
            for (int i = 0; i < batches.Length; i++)
                batches[i] = new InstanceBatch(meshes[i], RenderResources.Instanced, 256) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f) };
            batches[(int)Part.Floor].Shadows = ShadowCastingMode.Off;
            batches[(int)Part.Plank].Shadows = ShadowCastingMode.Off;
            batches[(int)Part.Scorch].Shadows = ShadowCastingMode.Off;
            // The burnt patch under a wreck is a soft-edged ground decal (SE/GroundDecal), not an opaque disc:
            // a hard dark polygon read as a hole in the map (Rowen: black patches).
            var decal = Resources.Load<Shader>("Shaders/GroundDecal");
            if (decal != null)
            {
                scorchTexture = ScorchTexture();
                scorchMaterial = new Material(decal) { name = "SE Wreck scorch", enableInstancing = true };
                scorchMaterial.SetTexture("_MainTex", scorchTexture);
                var quad = new Mesh { name = "SE scorch quad" };
                quad.SetVertices(new[] { new Vector3(-.5f, 0, -.5f), new Vector3(-.5f, 0, .5f), new Vector3(.5f, 0, .5f), new Vector3(.5f, 0, -.5f) });
                quad.SetUVs(0, new[] { new Vector2(0, 0), new Vector2(0, 1), new Vector2(1, 1), new Vector2(1, 0) });
                quad.SetNormals(new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up });
                quad.SetTriangles(new[] { 0, 1, 2, 0, 2, 3 }, 0);
                ownedMeshes.Add(quad);
                batches[(int)Part.Scorch].Dispose();
                batches[(int)Part.Scorch] = new InstanceBatch(quad, scorchMaterial, 256)
                { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Shadows = ShadowCastingMode.Off, ReceiveShadows = true };
            }
        }

        Texture2D scorchTexture;
        Material scorchMaterial;

        /// <summary>A charred-earth splash: dark core, ragged soft edge (alpha), white rgb so the instance colour tints it.</summary>
        internal static Texture2D ScorchTexture()
        {
            const int n = 64;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, true) { name = "SE scorch", wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[n * n];
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    float u = (x + .5f) / n * 2 - 1, v = (y + .5f) / n * 2 - 1;
                    float r = math.sqrt(u * u + v * v), ang = math.atan2(v, u);
                    float edge = .78f + .12f * math.sin(ang * 5 + 1.3f) + .07f * math.sin(ang * 11 + .4f);
                    float a = math.saturate((edge - r) / (edge * .55f));
                    a = a * a * (3 - 2 * a);
                    float grain = Hash(x, y) * .25f;
                    byte shade = (byte)(255 * (.82f + grain * .7f));
                    px[y * n + x] = new Color32(shade, shade, shade, (byte)(255 * a * (.9f - grain * .4f)));
                }
            tex.SetPixels32(px); tex.Apply(true, true);
            return tex;
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

        /// <summary>The drawn ground: the shared height plus the terrain mesh's crater relief (lips, clods, pits).</summary>
        float Surface(float x, float z)
        {
            var view = world.View;
            float y = view.GroundHeight(x, z);
            int tile = HexMath.TileAt(x, z, view.W, view.H, view.Wrap != 0);
            if (tile >= 0 && tile < world.Grid.N && view.ImpactCounts != null)
                y += SE.Runtime.Landscape.ChunkMeshJob.CraterRelief(view, tile, x, z, out _, out _);
            return y;
        }

        void Put(Part part, float3 mapPos, float mapYaw, float3 size, float3 color)
            => batches[(int)part].Add(InstanceData.TRS(MapSpace.W(mapPos), MapSpace.Yaw(mapYaw), size, new float4(color, 0)));

        /// <summary>The soft scorch decal (rgb tint, a = opacity); the opaque disc fallback takes the tint only.</summary>
        void PutScorch(float3 mapPos, float mapYaw, float3 size, float4 color)
            => batches[(int)Part.Scorch].Add(InstanceData.TRS(MapSpace.W(mapPos), MapSpace.Yaw(mapYaw), size,
                scorchMaterial != null ? color : new float4(color.xyz * .8f, 0)));

        void PutQ(Part part, float3 mapPos, quaternion unityRotation, float3 size, float3 color)
            => batches[(int)part].Add(InstanceData.TRS(MapSpace.W(mapPos), unityRotation, size, new float4(color, 0)));

        /// <summary>Wreck size by vehicle type (the same scale the living vehicle is drawn at, never oversized).</summary>
        static float WreckScale(string type, bool air)
        {
            if (air) return type == "bomber" ? .34f : type == "helicopter" ? .22f : .26f;
            if (type.Contains("tank") || type == "sp_artillery") return .235f;
            if (type == "mech_infantry" || type == "exo_infantry") return .22f;   // exo_infantry: the IFV (2026-11-18)
            if (type == "supply_truck" || type == "colonist" || type == "missile_battery" || type == "air_defense") return .2f;
            if (type == "armored_car") return .19f;
            if (type == "field_gun") return .16f;
            if (type == "scout_buggy") return .14f;
            return .17f;
        }

        /// <summary>
        /// A wreck resting on the ground: its pitch and roll follow the terrain under its hull, and it is bedded in
        /// (the mean ground under its footprint, a little sunk) rather than floating on the centre sample.
        /// </summary>
        void PlaceWreck(Part part, float x, float z, float yaw, float s, float3 color, out float groundY)
        {
            math.sincos(yaw, out float sn, out float cs);
            float halfLength = s * (part == Part.AirWreck ? .45f : .45f), halfWidth = s * (part == Part.AirWreck ? .25f : .3f);
            float front = Surface(x + sn * halfLength, z + cs * halfLength), back = Surface(x - sn * halfLength, z - cs * halfLength);
            float right = Surface(x + cs * halfWidth, z - sn * halfWidth), left = Surface(x - cs * halfWidth, z + sn * halfWidth);
            float centre = Surface(x, z);
            float pitch = Mathf.Clamp(-Mathf.Atan2(front - back, halfLength * 2f), -.45f, .45f);
            float roll = Mathf.Clamp(Mathf.Atan2(right - left, halfWidth * 2f), -.45f, .45f);
            // a wreck that came down hard sits a little askew
            pitch += (Hash((int)(x * 97f), (int)(z * 89f)) - .5f) * .06f;
            roll += (Hash((int)(z * 83f), (int)(x * 79f)) - .5f) * .08f;
            groundY = Mathf.Min(centre, (front + back + right + left + centre) * .2f);
            float sink = part == Part.AirWreck ? .002f : s * .03f;
            var rot = quaternion.EulerZXY(pitch, MapSpace.Yaw(yaw), roll);
            PutQ(part, new float3(x, groundY - sink, z), rot, new float3(s, s * .92f, s), color);
        }

        // Crater spoil (destruction pass, 2026-11-18): the thrown earth around each crater is no longer up to 14k
        // instanced clods re-placed on every battlefield change (the per-tile SpoilKey / SpoilEntry cache of perf
        // pass C4 only made the re-placement cheaper). The terrain mesh already paints it: ChunkMeshJob.CraterRelief
        // returns a spoil and scorch weight that tints the vertex colour, and raises the lip and clod bumps in the
        // relief. That costs no draw calls or instances and fades with the server's crater healing (the spoil is
        // gone halfway through the heal, the bowl when the record is removed). Nothing is cached here any more.

        /// <summary>Diagnostics: full rebuilds, and their cumulative ms split into trenches / no-man's-land and wrecks / (formerly crater spoil, now always 0).</summary>
        public int Rebuilds;
        public readonly double[] PartMs = new double[3];

        public void Update(TrenchRecord[] trenches, int trenchRevision, BattlefieldState bf, int bfRevision, int structureRevision, Func<int, bool> wasteland)
        {
            if (!world.Ready) return;
            // trenches stop at the roads drawn across them, so a change of roads rebuilds them too
            int roads = world.LayoutRevision * 7919 + RoadCurve.LaneRevision;
            if (trenchRev == trenchRevision && bfRev == bfRevision && geoRev == world.GeometryRevision && structRev == structureRevision
                && (trenches.Length == 0 || roadRev == roads)) return;
            trenchRev = trenchRevision; bfRev = bfRevision; geoRev = world.GeometryRevision; structRev = structureRevision; roadRev = roads;
            Rebuilds++;
            long w0 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Clear();
            byTile.Clear(); trenchTiles.Clear(); BurningWrecks.Clear();
            foreach (var t in trenches) if (t.Tile >= 0 && t.Tile < world.Grid.N) { byTile[t.Tile] = t; trenchTiles.Add(t.Tile); }
            Works.Build(trenches);
            long w1 = System.Diagnostics.Stopwatch.GetTimestamp();
            if (bf != null)
            {
                foreach (var it in bf.Intensity) if (it.Value >= 2f && it.Tile >= 0 && it.Tile < world.Grid.N && world.Known[it.Tile] != 0 && !trenchTiles.Contains(it.Tile)) NoMansLand(it.Tile, it.Value);
                int n = 0;
                foreach (var w in bf.Wrecks)
                {
                    if (w.Tile < 0 || w.Tile >= world.Grid.N || world.Known[w.Tile] == 0) continue;
                    var g = world.Grid;
                    float x = w.HasPosition ? w.X : g.CenterX(w.Tile) + (Hash(w.Tile, n) - 0.5f) * 0.9f, z = w.HasPosition ? w.Z : g.CenterZ(w.Tile) + (Hash(n, w.Tile) - 0.5f) * 0.9f;
                    string wreckType = w.Type ?? "";
                    var part = wreckType == "sp_artillery" ? Part.GunWreck : wreckType == "fighter" || wreckType == "bomber" || wreckType == "helicopter" ? Part.AirWreck
                        : wreckType.Contains("tank") ? Part.Wreck : Part.LightWreck;
                    float s = WreckScale(wreckType, part == Part.AirWreck);
                    float wreckYaw = w.HasPosition ? w.Yaw : Hash(w.Tile, n + 7) * 6.28f;
                    // burnt out: blackened, the paint gone to rust-brown; still burning ones darker still
                    float char0 = .45f + Hash(w.Tile * 7 + n, 3) * .12f - (w.Burning ? .1f : 0f);
                    var burnt = new float3(char0, char0 * .9f, char0 * .82f);
                    PlaceWreck(part, x, z, wreckYaw, s, burnt, out float y);
                    // the scorched patch it burned out on, and fragments thrown around it
                    PutScorch(new float3(x, y + .004f, z), wreckYaw, new float3(s * 1.9f, 1f, s * 2.3f), new float4(.26f, .22f, .17f, .78f));   // soft burnt earth, not a black blob
                    if (part == Part.GunWreck)
                        Put(Part.Plank, new float3(x + math.sin(wreckYaw) * .055f, y + .05f, z + math.cos(wreckYaw) * .055f), wreckYaw,
                            new float3(.014f, .014f, .26f), new float3(.20f, .20f, .18f));
                    for (int k = 0; k < 5; k++)
                    {
                        float fa = Hash(w.Tile + n, k) * 6.283f, fr = s * (.6f + Hash(n + k, w.Tile) * .9f);
                        float fx = x + Mathf.Cos(fa) * fr, fz = z + Mathf.Sin(fa) * fr, piece = s * (.05f + Hash(k, n + 5) * .08f);
                        var tumble = quaternion.EulerZXY((Hash(k, n) - .5f) * .8f, fa * 3f, (Hash(n, k + 2) - .5f) * .8f);
                        PutQ(Part.Debris, new float3(fx, Surface(fx, fz) + piece * .1f, fz), tumble, new float3(piece * 1.4f, piece * .35f, piece), new float3(.30f, .28f, .25f));
                    }
                    if (w.Burning) BurningWrecks.Add(new float3(x, y + 0.05f, z));
                    n++;
                }
            }
            long w2 = System.Diagnostics.Stopwatch.GetTimestamp();
            long w3 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.MarkDirty();
            double msPerTick = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            PartMs[0] += (w1 - w0) * msPerTick; PartMs[1] += (w2 - w1) * msPerTick; PartMs[2] += (w3 - w2) * msPerTick;
        }

        // ------------------------------------------------------------------ trenches
        // Drawn by TrenchRenderer (continuous meshes on the terrain; docs/gameplay-overhaul/TRENCHES.md).

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
                if (world.ActionLandscape)
                {
                    // Damage preserves the landscape's material history. A shell in
                    // grassland does not invent a tree or an unbuilt wire defense.
                    if (world.Biome[tile] == 4 && pick < .35f)
                    {
                        float width = .023f + Hash(tile, k + 14) * .018f;
                        Put(Part.Stump, new float3(x, y - .006f, z), a,
                            new float3(width * 1.8f, .10f + Hash(tile, k + 15) * .15f, width * 1.8f), new float3(.85f, .82f, .74f));
                        if (stage > 2.7f)
                            Put(Part.Branch, new float3(x + math.sin(a) * .08f, y + .002f, z + math.cos(a) * .08f), a + .7f,
                                new float3(.19f + Hash(tile, k) * .15f), new float3(.84f, .81f, .73f));
                    }
                    else if (world.IsUrban(tile) || pick > .72f)
                    {
                        float size = .018f + Hash(tile, k + 16) * .025f;
                        Put(Part.Debris, new float3(x, y + .001f, z), a,
                            new float3(size, size * .28f, size * 1.35f), new float3(.41f, .39f, .34f));
                    }
                    continue;
                }
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
                    Put(Part.Coil, new float3(x, y, z), yaw, new float3(.32f, .15f, .15f), new float3(.78f, .76f, .70f));
                    if (k % 3 == 1) Put(Part.TankObstacle, new float3(x + .13f, y, z + .12f), yaw + .7f,
                        new float3(.19f), new float3(.85f, .82f, .76f));
                }
                else
                {
                    // debris: timber, broken carts, spoil
                    Put(Part.Debris, new float3(x, y - 0.005f, z), a, new float3(0.04f + pick * 0.03f, 0.012f, 0.02f), new float3(0.28f, 0.24f, 0.2f));
                }
            }
        }

        public void Draw(WrapImages images) { foreach (var b in batches) b.DrawImages(images); Works.Draw(images); }

        public void Dispose() { Works.Dispose(); foreach (var b in batches) b.Dispose(); foreach (var mesh in ownedMeshes) UnityEngine.Object.Destroy(mesh); if (scorchMaterial != null) UnityEngine.Object.Destroy(scorchMaterial); if (scorchTexture != null) UnityEngine.Object.Destroy(scorchTexture); }
    }
}
