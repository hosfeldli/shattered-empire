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
    /// The built battlefield, from the server's records: WW1-style trench networks dug into the ground
    /// (square fire bays and traverses so fire cannot sweep along a trench, duckboard floors, sandbag
    /// parapets on the enemy side and a lower parados behind), joined to neighbouring segments and to
    /// adjacent bunkers, posts and forts; construction shown as it progresses. No-man's land gets
    /// barbed-wire belts, shattered stumps and debris; destroyed vehicles stay where they fell.
    /// Rebuilt only when trenches, battlefield or terrain change.
    /// </summary>
    public sealed unsafe class WarzoneRenderer : IDisposable
    {
        enum Part { Floor, Bag, Plank, Coil, Post, Stump, Debris, Wreck, LightWreck, GunWreck, AirWreck, Branch, TankObstacle, Scorch, Clod, Count }

        readonly InstanceBatch[] batches = new InstanceBatch[(int)Part.Count];
        readonly WorldModel world;
        readonly HashSet<int> trenchTiles = new HashSet<int>();
        readonly Dictionary<int, TrenchRecord> byTile = new Dictionary<int, TrenchRecord>();
        public readonly List<float3> BurningWrecks = new List<float3>();
        int trenchRev = -1, bfRev = -1, geoRev = -1, structRev = -1, roadRev = int.MinValue;
        readonly List<Mesh> ownedMeshes = new List<Mesh>();
        public Func<int, string> DefenceAt = _ => null;   // building type at a tile (joins trenches to defences)
        public Func<int, int> BuildingOwnerAt = _ => -1;

        public WarzoneRenderer(WorldModel w)
        {
            world = w;
            Mesh[] meshes = { MeshKit.Box, MeshKit.Sandbags, MeshKit.Box, MeshKit.Coil, MeshKit.Cylinder, WorldMeshes.SnappedTree(), MeshKit.Box, MeshKit.Wreck,
                WorldMeshes.LightVehicleWreck(), MeshKit.Wreck, WorldMeshes.AircraftWreck(), WorldMeshes.FallenBranch(), MeshKit.TankObstacle,
                MeshKit.Disc, MeshKit.Box };
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
            if (type == "mech_infantry") return .22f;
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

        /// <summary>
        /// Shell craters' broken ground: clods of thrown earth and torn turf lumps around each crater's lip, half
        /// buried and tumbled, thinning outward (the terrain mesh carries the jagged bowl and raised rim).
        /// </summary>
        void CraterSpoil()
        {
            var impacts = world.Impacts;
            var counts = world.ImpactCounts;
            if (impacts == null || counts == null || counts.Length < world.Grid.N) return;
            var g = world.Grid;
            int placed = 0;
            for (int tile = 0; tile < g.N && placed < 14000; tile++)
            {
                if (counts[tile] == 0 || world.Known[tile] == 0) continue;
                float cx = g.CenterX(tile), cz = g.CenterZ(tile);
                for (int k = 0; k < counts[tile]; k++)
                {
                    int index = (tile * 6 + k) * 4;
                    if (index + 3 >= impacts.Length) break;
                    float ix = cx + impacts[index], iz = cz + impacts[index + 1], radius = impacts[index + 2], depth = impacts[index + 3];
                    int clods = 8 + (int)(depth * 60f);
                    for (int c = 0; c < clods; c++, placed++)
                    {
                        float a = Hash(index, c * 3) * 6.283f;
                        float reach = 1f + Hash(c * 5, index) * Hash(index + c, 17) * .75f;   // most on the lip, a few thrown far
                        float x = ix + Mathf.Cos(a) * radius * reach, z = iz + Mathf.Sin(a) * radius * reach;
                        float size = radius * (.035f + Hash(index + 7, c) * .05f) * (reach > 1.35f ? .6f : 1f);
                        float y = Surface(x, z);
                        var rot = quaternion.EulerZXY((Hash(c, index + 3) - .5f) * 1.2f, Hash(index, c + 9) * 6.283f, (Hash(c + 11, index) - .5f) * 1.2f);
                        float shade = .55f + Hash(c, index + 21) * .35f;
                        var colour = Hash(index + c, 31) < .3f ? new float3(.30f, .34f, .22f) * shade : new float3(.30f, .24f, .17f) * shade;   // torn turf, or subsoil
                        PutQ(Part.Clod, new float3(x, y + size * .12f, z), rot, new float3(size * 1.3f, size * .7f, size), colour);
                    }
                }
            }
        }

        public void Update(TrenchRecord[] trenches, int trenchRevision, BattlefieldState bf, int bfRevision, int structureRevision, Func<int, bool> wasteland)
        {
            if (!world.Ready) return;
            // trenches stop at the roads drawn across them, so a change of roads rebuilds them too
            int roads = world.LayoutRevision * 7919 + RoadCurve.LaneRevision;
            if (trenchRev == trenchRevision && bfRev == bfRevision && geoRev == world.GeometryRevision && structRev == structureRevision
                && (trenches.Length == 0 || roadRev == roads)) return;
            trenchRev = trenchRevision; bfRev = bfRevision; geoRev = world.GeometryRevision; structRev = structureRevision; roadRev = roads;
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
            CraterSpoil();
            foreach (var b in batches) b.MarkDirty();
        }

        // ------------------------------------------------------------------ trenches
        void Trench(in TrenchRecord t)
        {
            var g = world.Grid;
            float cx = g.CenterX(t.Tile), cz = g.CenterZ(t.Tile);
            if (t.HasPosition)
            {
                // A trench network: every link between two trench nodes is one continuous segment, drawn once
                // (by the lower tile), whose zig-zag of fire bays starts and ends on the centreline so it
                // meets the junction pit at each node exactly. Links follow the server's route bits, plus
                // any same-owner node close enough to belong to the same line (lines drawn separately join).
                cx = t.X; cz = t.Z;
                var facing = new float2(math.sin(t.Facing), math.cos(t.Facing));
                int links = 0;
                entries.Clear();
                for (int d = 0; d < 6; d++)
                {
                    int tile = g.Nb[t.Tile * 6 + d];
                    if (!byTile.TryGetValue(tile, out var other) || !other.HasPosition || other.Owner != t.Owner) continue;
                    var delta = new float2(g.DxWrap(cx, other.X), other.Z - cz);
                    float len = math.length(delta);
                    bool routed = (t.Route & (1 << d)) != 0 || (other.Route & (1 << ((d + 3) % 6))) != 0;
                    if (len < .02f || len > (routed ? 2.2f : 1.35f)) continue;
                    links++;
                    entries.Add(delta / len);
                    if (tile < t.Tile) continue;
                    var otherFacing = new float2(math.sin(other.Facing), math.cos(other.Facing));
                    float linkBuilt = math.min(t.Progress, other.Progress) / 100f;
                    bool linkPlanned = t.State == 2 || other.State == 2 || t.Progress <= 0 && other.Progress <= 0;
                    Segment(t, new float2(cx, cz), new float2(cx, cz) + delta, math.normalizesafe(facing + otherFacing, facing), linkBuilt, linkPlanned);
                }
                if (links == 0)
                {
                    // a lone node: a straight run across the facing, closed at both free ends, through its pit
                    var across = new float2(-facing.y, facing.x);
                    Segment(t, new float2(cx, cz) - across * .42f, new float2(cx, cz), facing, t.Progress / 100f, t.State == 2 || t.Progress <= 0, capA: true);
                    Segment(t, new float2(cx, cz), new float2(cx, cz) + across * .42f, facing, t.Progress / 100f, t.State == 2 || t.Progress <= 0, capB: true);
                    entries.Add(across); entries.Add(-across);
                }
                RoadStubs(t, new float2(cx, cz), facing);
                if (t.State != 2 && t.Progress > 0) Junction(t, new float2(cx, cz), facing, entries);
                return;
            }
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

        // Trench cross-section (map units; 1 = 25 m): a 1.5 m wide cut, 2 m deep (shown by dark sunken walls and
        // floor), an earth berm in front topped with sandbags (the parapet), a lower parados behind, plank
        // revetments on the walls and a duckboard walk on the floor.
        static readonly float3 Earth = new float3(.24f, .19f, .14f), Mud = new float3(.19f, .15f, .11f), Wall = new float3(.17f, .13f, .095f), Board = new float3(.42f, .33f, .22f);

        static readonly float3 Steel = new float3(.29f, .30f, .29f);
        /// <summary>How close (outside the carriageway's edge) a trench may come to a road before it stops at the verge.</summary>
        const float RoadClearance = .075f;
        readonly List<bool> crossing = new List<bool>();
        readonly List<float2> entries = new List<float2>();

        float RoadGap(float2 p) => RoadCurve.RoadDistance(world, p, out _, out _);

        /// <summary>
        /// A sandbag end wall closing the trench where it stops (at a road verge, or a free end): an earth
        /// block across the cut topped with a row of bags, facing along the trench.
        /// </summary>
        void EndWall(in TrenchRecord t, float2 at, float yaw, float3 bagColor)
        {
            float y = Ground(at.x, at.y);
            Put(Part.Floor, new float3(at.x, y + .003f, at.y), yaw + math.PI * .5f, new float3(.03f, .014f, .15f), Earth);
            Put(Part.Bag, new float3(at.x, y + .012f, at.y), yaw + math.PI * .5f, new float3(.026f, .02f, .12f), bagColor * .94f);
        }

        /// <summary>
        /// The server never digs on a road hex (a road leaves a gap in the line) and flags the node's road
        /// neighbours (TrenchRecord.RoadMask). Where the line would carry on into such a neighbour, it runs on
        /// from the node to the road's verge (found on the street geometry actually drawn) and ends there
        /// squarely in a sandbag end wall, so the gap reads as a deliberate road crossing, not a missing link.
        /// Only continuations of the line (or a lone node's ends) are run on: a road beside the line adds nothing.
        /// </summary>
        void RoadStubs(in TrenchRecord t, float2 c, float2 facing)
        {
            if (t.RoadMask == 0) return;
            var g = world.Grid;
            int count = entries.Count;
            bool planned = t.State == 2 || t.Progress <= 0;
            for (int d = 0; d < 6; d++)
            {
                if ((t.RoadMask & (1 << d)) == 0) continue;
                int nb = g.Nb[t.Tile * 6 + d];
                if (nb < 0) continue;
                var toward = new float2(g.DxWrap(c.x, g.CenterX(nb)), g.CenterZ(nb) - c.y);
                float reach = math.length(toward);
                if (reach < .1f) continue;
                toward /= reach;
                bool continues = count == 0, linked = false;
                for (int i = 0; i < count; i++)
                {
                    if (math.dot(toward, -entries[i]) > .5f) continues = true;
                    if (math.dot(toward, entries[i]) > .8f) linked = true;
                }
                if (!continues || linked) continue;
                float stop = -1;
                for (float s = .05f; s < reach; s += .02f)
                    if (RoadGap(c + toward * s) < RoadClearance) { stop = s; break; }
                if (stop < .1f) continue;   // the road is right at the node: the pit's rim closes the line
                Segment(t, c, c + toward * stop, facing, t.Progress / 100f, planned, capB: true);
                entries.Add(toward);
            }
        }

        /// <summary>
        /// One continuous trench between two nodes, its bays on a straight trace. Where a road crosses the line
        /// the cut stops at the verge with sandbag end walls and a steel plate bridges the gap on the road, so no
        /// trench geometry lies on the asphalt. At a node the parapet, parados and walls stop short and the
        /// junction pit's sandbag rim (<see cref="Junction"/>) closes the corner, so lines meeting at any angle
        /// join without overlapping blocks or open wedges. capA / capB: a free end (no node) gets an end wall.
        /// </summary>
        void Segment(in TrenchRecord t, float2 a, float2 b, float2 facing, float built, bool planned, bool capA = false, bool capB = false)
        {
            const float bay = .12f;
            float length = math.length(b - a);
            if (length < .01f) return;
            float2 dir = (b - a) / length, side = new float2(-dir.y, dir.x);
            float front = math.dot(side, facing) >= 0 ? 1f : -1f;
            int bays = math.max(1, (int)math.round(length / bay));
            float step = length / bays;
            int drawn = planned ? 0 : (int)math.ceil(bays * math.saturate(built));
            float yaw = math.atan2(dir.x, dir.y);
            float3 bagColor = t.Reinforced ? new float3(.60f, .59f, .56f) : new float3(.66f, .60f, .46f);
            crossing.Clear();
            for (int k = 0; k < bays; k++) crossing.Add(RoadGap(a + dir * ((k + .5f) * step)) < RoadClearance);
            for (int k = 0; k < bays; k++)
            {
                float2 p0 = a + dir * (k * step), p1 = a + dir * ((k + 1) * step);
                float2 mid = (p0 + p1) * .5f;
                float y = Ground(mid.x, mid.y);
                float wobble = Hash(t.Tile * 31 + k, 7);
                if (crossing[k])
                {
                    // the road stays intact: a steel trench plate laid across it carries the line over
                    if (k < drawn)
                        Put(Part.Plank, new float3(mid.x, RoadCurve.Height(world, float.NegativeInfinity, mid.x, mid.y) + .0004f, mid.y), yaw,
                            new float3(.082f, .0025f, step * 1.01f), Steel * (.92f + .16f * wobble));
                    continue;
                }
                if (k >= drawn)
                {
                    // planned: pegged white tape along the line
                    if (k % 2 == 0) Put(Part.Plank, new float3(mid.x, y + .004f, mid.y), yaw, new float3(.006f, .006f, step * .85f), new float3(.85f, .82f, .70f));
                    Put(Part.Post, new float3(p0.x, Ground(p0.x, p0.y) + .008f, p0.y), 0, new float3(.004f, .016f, .004f), new float3(.55f, .45f, .32f));
                    continue;
                }
                // the cut: dark floor below grade, sunken earth walls either side, duckboards down the middle
                Put(Part.Floor, new float3(mid.x, y + .003f, mid.y), yaw, new float3(.062f, .006f, step * 1.04f), Mud * (.85f + .3f * wobble));
                Put(Part.Plank, new float3(mid.x, y + .0065f, mid.y), yaw, new float3(.022f, .003f, step * .92f), Board);
                // the banks (walls, parapet, parados) of a bay at a node stop short of it: the pit's rim takes over there
                float lo = k == 0 && !capA ? .5f : 0f, hi = k == bays - 1 && !capB ? .5f : 1f;
                if (bays == 1 && !capA && !capB) { lo = .3f; hi = .7f; }
                if (hi - lo > .05f)
                {
                    float2 bank = a + dir * ((k + (lo + hi) * .5f) * step);
                    float run = (hi - lo) * step;
                    for (int s = -1; s <= 1; s += 2)
                    {
                        float2 w = bank + side * s * .034f;
                        Put(Part.Floor, new float3(w.x, Ground(w.x, w.y) - .002f, w.y), yaw, new float3(.008f, .022f, run * 1.04f), Wall);
                        if ((k + (s > 0 ? 1 : 0)) % 2 == 0)   // revetment: a plank and post every other bay
                            Put(Part.Plank, new float3(w.x, Ground(w.x, w.y) + .002f, w.y), yaw, new float3(.004f, .014f, run * .9f), Board * .8f);
                    }
                    // earth berm and sandbag parapet toward the enemy; a lower parados behind
                    float2 berm = bank + side * front * .068f, bag = bank + side * front * .052f, parados = bank - side * front * .058f;
                    Put(Part.Floor, new float3(berm.x, Ground(berm.x, berm.y) + .004f, berm.y), yaw, new float3(.06f, .016f, run * 1.1f), Earth * (.9f + .2f * wobble));
                    Put(Part.Bag, new float3(bag.x, Ground(bag.x, bag.y) + .004f, bag.y), yaw, new float3(.03f, .024f, run * 1.06f), bagColor * (.88f + .24f * wobble));
                    Put(Part.Floor, new float3(parados.x, Ground(parados.x, parados.y) + .002f, parados.y), yaw, new float3(.04f, .010f, run * 1.1f), Earth * .85f);
                }
                // where the line meets a road (or ends free) it is closed by a sandbag end wall at the verge
                if (k > 0 && crossing[k - 1] || k == 0 && capA) EndWall(t, p0 + dir * .012f, yaw, bagColor);
                if (k + 1 < bays && crossing[k + 1] || k == bays - 1 && capB) EndWall(t, p1 - dir * .012f, yaw, bagColor);
                // traverses every fourth bay: a sandbagged earth block jutting into the trench from the parapet,
                // so a shell or a gunner in the trench cannot sweep its whole length
                if (k % 4 == 2 && k + 1 < drawn && !crossing[k + 1])
                {
                    float2 tv = mid + side * front * .018f;
                    Put(Part.Floor, new float3(tv.x, Ground(tv.x, tv.y) + .006f, tv.y), yaw, new float3(.04f, .014f, step * .45f), Earth);
                    Put(Part.Bag, new float3(tv.x, Ground(tv.x, tv.y) + .014f, tv.y), yaw, new float3(.036f, .012f, step * .4f), bagColor * .92f);
                }
                if (t.Reinforced && k % 3 == 1)
                {
                    float2 bag = mid + side * front * .052f, wire = mid + side * front * .15f;
                    Put(Part.Debris, new float3(bag.x, Ground(bag.x, bag.y) + .01f, bag.y), yaw, new float3(.045f, .03f, .04f), new float3(.52f, .51f, .48f));
                    if (RoadGap(wire) >= .02f)
                        Put(Part.Coil, new float3(wire.x, Ground(wire.x, wire.y), wire.y), yaw + math.PI * .5f, new float3(.23f, .11f, .11f), new float3(.78f, .77f, .72f));
                }
            }
        }

        /// <summary>
        /// The pit where trench segments meet: a wider floor and duckboards, ringed by an earth-and-sandbag rim
        /// everywhere except where a trench enters, so the lines join as one work at any angle (higher toward the
        /// enemy, a low parados behind). A node on a road is left to the road's steel plates.
        /// </summary>
        void Junction(in TrenchRecord t, float2 c, float2 facing, List<float2> entries)
        {
            if (RoadGap(c) < RoadClearance) return;
            float y = Ground(c.x, c.y), yaw = math.atan2(facing.x, facing.y);
            Put(Part.Floor, new float3(c.x, y + .003f, c.y), yaw + math.PI * .25f, new float3(.085f, .006f, .085f), Mud);
            Put(Part.Plank, new float3(c.x, y + .0065f, c.y), yaw, new float3(.05f, .003f, .05f), Board);
            float3 bagColor = t.Reinforced ? new float3(.60f, .59f, .56f) : new float3(.66f, .60f, .46f);
            const int pieces = 12;
            for (int k = 0; k < pieces; k++)
            {
                float angle = k * 2 * math.PI / pieces;
                var u = new float2(math.sin(angle), math.cos(angle));
                bool open = false;
                foreach (var entry in entries) if (math.dot(u, entry) > .80f) { open = true; break; }
                if (open) continue;
                float toward = math.dot(u, facing);
                float tall = toward > .3f ? 1f : .62f;
                float tangentYaw = angle + math.PI * .5f;
                float2 rim = c + u * .066f, berm = c + u * .082f;
                Put(Part.Floor, new float3(berm.x, Ground(berm.x, berm.y) + .003f, berm.y), tangentYaw, new float3(.05f, .014f * tall, .05f), Earth * (.9f + .1f * Hash(t.Tile, k)));
                Put(Part.Bag, new float3(rim.x, Ground(rim.x, rim.y) + .004f, rim.y), tangentYaw, new float3(.028f, .024f * tall, .042f), bagColor * (.9f + .14f * Hash(k, t.Tile)));
            }
            if (entries.Count >= 3) Put(Part.Post, new float3(c.x, y + .02f, c.y), 0, new float3(.005f, .04f, .005f), new float3(.40f, .32f, .22f));   // a sign post at the crossing
        }

        void Leg(in TrenchRecord t, float cx, float cz, float2 dir, float2 facing, float built, bool planned, float length = .87f)
        {
            const float bay = .13f, offset = .05f;
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
                {
                    Put(Part.Debris, new float3(pf.x, Ground(pf.x, pf.y), pf.y), yaw, new float3(0.045f, 0.032f, 0.04f), new float3(0.52f, 0.51f, 0.48f));
                    var wire = pf + side * front * .075f;
                    Put(Part.Coil, new float3(wire.x, Ground(wire.x, wire.y), wire.y), yaw + math.PI * .5f,
                        new float3(.23f, .11f, .11f), new float3(.78f, .77f, .72f));
                }
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

        public void Draw(WrapImages images) { foreach (var b in batches) b.DrawImages(images); }

        public void Dispose() { foreach (var b in batches) b.Dispose(); foreach (var mesh in ownedMeshes) UnityEngine.Object.Destroy(mesh); if (scorchMaterial != null) UnityEngine.Object.Destroy(scorchMaterial); if (scorchTexture != null) UnityEngine.Object.Destroy(scorchTexture); }
    }
}
