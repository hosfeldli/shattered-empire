using System;
using System.Collections.Generic;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Cities
{
    /// <summary>
    /// Civilian traffic (presentation only; the server has no cars). Vehicles drive on the right of the
    /// streets, hex by hex along the same curves the streets are drawn with (<see cref="RoadCurve"/>):
    /// round blocks, through off-centre junctions. They keep their distance from the car ahead, give
    /// way at junctions (a junction hex is held by one car at a time; main roads go first, side streets
    /// stop at the line), and drive to destinations of their own by varied routes, so the flow never
    /// repeats. Only the streets around the camera are populated, and only at tactical zoom.
    /// </summary>
    public sealed class TrafficSystem : IDisposable
    {
        enum Body { Car, Truck, Bus, Count }

        struct Vehicle
        {
            public int Tile, In, Out, Cls, Dest, Seed;
            public float S, Len, Speed, Cruise, Wait, Size;
            public Body Body;
            public float3 Color;
            public bool Holding;     // holds the junction of the next hex
            public bool Stopped;     // has made its stop at the line
        }

        readonly WorldModel world;
        readonly List<Vehicle> cars = new List<Vehicle>(512);
        readonly InstanceBatch[] batches = new InstanceBatch[(int)Body.Count + 1];
        readonly Dictionary<int, int> junctionHeldBy = new Dictionary<int, int>();   // hex -> car seed
        readonly Dictionary<long, List<int>> lanes = new Dictionary<long, List<int>>();
        readonly List<int> spawnTiles = new List<int>();
        readonly List<int> destTiles = new List<int>();
        readonly System.Random rng = new System.Random(12345);
        int nextSeed = 1;
        float scanAt, camX;
        int epoch = -1;

        public int MaxCars = 360;
        public float Radius = 18f;
        public float MaxCameraDistance = 55f;
        public bool RequireVisible = true;
        public int Count => cars.Count;

        public TrafficSystem(WorldModel w)
        {
            world = w;
            Mesh[] meshes = { MeshKit.Car, MeshKit.Truck, MeshKit.Box, MeshKit.Box };
            for (int i = 0; i < batches.Length; i++)
                batches[i] = new InstanceBatch(meshes[i], RenderResources.Instanced, 256) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3 };
            batches[(int)Body.Count].Shadows = ShadowCastingMode.Off;   // head and tail lights
        }

        static long LaneKey(int tile, int a, int b) => ((long)tile << 8) | (uint)(a * 8 + b);

        bool Usable(int t, int d) => world.RoadClass(t, d) != 0 && !world.RoadBroken(t, d) && world.Grid.Nb[t * 6 + d] >= 0;

        int Legs(int t)
        {
            int n = 0;
            for (int d = 0; d < 6; d++) if (Usable(t, d)) n++;
            return n;
        }

        bool Allowed(int t) => !RequireVisible || world.IsVisible(t);

        float CruiseFor(int cls, Body body, int seed, int tile)
            => (cls >= 3 ? 0.62f : cls == 2 ? 0.48f : 0.3f) * (body == Body.Car ? 1f : 0.82f) * (0.88f + 0.24f * CityRenderer.Hash(seed, tile));

        public void Update(float dt, float3 focus, float camDistance, float time, float daylight)
        {
            if (!world.Ready) return;
            camX = focus.x;
            if (epoch != world.Epoch) { epoch = world.Epoch; cars.Clear(); junctionHeldBy.Clear(); }
            var g = world.Grid;
            bool active = camDistance < MaxCameraDistance;
            if (time > scanAt) { scanAt = time + 0.75f; Scan(focus); }
            // despawn: far away, the street gone, or zoomed out
            for (int i = cars.Count - 1; i >= 0; i--)
            {
                var c = cars[i];
                float dx = g.DxWrap(focus.x, g.CenterX(c.Tile)), dz = g.CenterZ(c.Tile) - focus.z;
                bool gone = !active || dx * dx + dz * dz > Radius * Radius * 1.7f || !Usable(c.Tile, c.Out) || (c.In != c.Out && !Usable(c.Tile, c.In));
                if (gone) { Release(c); cars.RemoveAt(i); }
            }
            if (!active) { Build(daylight); return; }
            int want = Math.Min(MaxCars, spawnTiles.Count / 2);
            for (int k = 0; k < 6 && cars.Count < want && spawnTiles.Count > 0; k++) Spawn();
            // lanes: cars on the same path through the same hex, ordered by progress
            foreach (var l in lanes.Values) l.Clear();
            for (int i = 0; i < cars.Count; i++)
            {
                var key = LaneKey(cars[i].Tile, cars[i].In, cars[i].Out);
                if (!lanes.TryGetValue(key, out var list)) lanes[key] = list = new List<int>(8);
                list.Add(i);
            }
            foreach (var list in lanes.Values) if (list.Count > 1) list.Sort((a, b) => cars[b].S.CompareTo(cars[a].S));
            for (int i = 0; i < cars.Count; i++) Drive(i, dt);
            Build(daylight);
        }

        void Scan(float3 focus)
        {
            spawnTiles.Clear(); destTiles.Clear();
            var g = world.Grid;
            int center = g.TileAt(focus.x, focus.z);
            if (center < 0) return;
            int rr = Mathf.CeilToInt(Radius / 1.5f);
            int cq = center % g.W, cr = center / g.W;
            for (int dr = -rr; dr <= rr; dr++)
            {
                int r = cr + dr; if (r < 0 || r >= g.H) continue;
                for (int dq = -rr; dq <= rr; dq++)
                {
                    int q = cq + dq;
                    if (g.Wrap) q = ((q % g.W) + g.W) % g.W; else if (q < 0 || q >= g.W) continue;
                    int t = r * g.W + q;
                    if (world.Road[t] == 0 || world.Known[t] == 0 || !Allowed(t)) continue;
                    int n = Legs(t);
                    if (n < 2) continue;
                    int best = 0;
                    for (int d = 0; d < 6; d++) best = Math.Max(best, world.RoadClass(t, d));
                    // denser on paved streets and in town
                    int weight = (world.IsUrban(t) ? 2 : 0) + (best >= 2 ? 1 : 0) + (best >= 3 ? 1 : 0);
                    for (int k = 0; k < weight; k++) spawnTiles.Add(t);
                    if (world.IsUrban(t) || n >= 3) destTiles.Add(t);
                }
            }
            if (destTiles.Count == 0) destTiles.AddRange(spawnTiles);
        }

        void Spawn()
        {
            int t = spawnTiles[rng.Next(spawnTiles.Count)];
            int a = -1, b = -1, start = rng.Next(6);
            for (int k = 0; k < 6; k++) { int d = (start + k) % 6; if (Usable(t, d)) { if (a < 0) a = d; else { b = d; break; } } }
            if (a < 0 || b < 0) return;
            if (rng.NextDouble() < 0.5) { int s = a; a = b; b = s; }
            if (lanes.TryGetValue(LaneKey(t, a, b), out var l) && l.Count > 2) return;
            float pick = (float)rng.NextDouble();
            var body = pick < 0.78f ? Body.Car : pick < 0.94f ? Body.Truck : Body.Bus;
            int cls = Math.Max(world.RoadClass(t, a), world.RoadClass(t, b));
            if (cls == 1 && body == Body.Bus) body = Body.Truck;
            int seed = nextSeed++;
            var c = new Vehicle
            {
                Tile = t, In = a, Out = b, Cls = cls, S = (float)rng.NextDouble() * 0.6f, Body = body, Seed = seed,
                Dest = destTiles.Count > 0 ? destTiles[rng.Next(destTiles.Count)] : -1,
                Size = body == Body.Bus ? 0.11f : body == Body.Truck ? 0.085f : 0.06f,
                Color = Paint(body, (float)rng.NextDouble(), (float)rng.NextDouble()),
                Len = RoadCurve.Length(world, t, a, b),
            };
            c.Cruise = CruiseFor(cls, body, seed, t);
            c.Speed = c.Cruise * 0.5f;
            cars.Add(c);
        }

        static float3 Paint(Body body, float a, float b)
        {
            if (body == Body.Bus) return a < 0.5f ? new float3(0.75f, 0.58f, 0.18f) : new float3(0.25f, 0.42f, 0.55f);
            if (body == Body.Truck) return math.lerp(new float3(0.45f, 0.43f, 0.38f), new float3(0.36f, 0.4f, 0.32f), a);
            // muted, believable car colours, with the occasional bright one
            float3[] palette =
            {
                new float3(0.62f, 0.62f, 0.6f), new float3(0.18f, 0.19f, 0.21f), new float3(0.78f, 0.77f, 0.73f), new float3(0.45f, 0.12f, 0.1f),
                new float3(0.16f, 0.24f, 0.38f), new float3(0.32f, 0.36f, 0.3f), new float3(0.52f, 0.44f, 0.32f), new float3(0.75f, 0.6f, 0.2f),
            };
            return palette[(int)(a * palette.Length) % palette.Length] * (0.85f + 0.3f * b);
        }

        void Release(in Vehicle c)
        {
            int next = world.Grid.Nb[c.Tile * 6 + c.Out];
            if (c.Holding && next >= 0 && junctionHeldBy.TryGetValue(next, out int s) && s == c.Seed) junctionHeldBy.Remove(next);
            if (junctionHeldBy.TryGetValue(c.Tile, out int s2) && s2 == c.Seed) junctionHeldBy.Remove(c.Tile);
        }

        void Drive(int i, float dt)
        {
            var c = cars[i];
            var g = world.Grid;
            float limit = c.Cruise;
            // the car ahead on the same path: keep a gap
            if (lanes.TryGetValue(LaneKey(c.Tile, c.In, c.Out), out var lane))
            {
                int idx = lane.IndexOf(i);
                if (idx > 0)
                {
                    var ahead = cars[lane[idx - 1]];
                    float gap = (ahead.S - c.S) * c.Len - (ahead.Size + c.Size) * 0.6f;
                    limit = Mathf.Min(limit, Mathf.Max(0f, (gap - 0.03f) * 2.2f));
                    if (gap < 0.03f) limit = 0;
                }
            }
            // a junction hex ahead: stop at the line on side streets, wait while someone else is crossing
            int next = g.Nb[c.Tile * 6 + c.Out];
            if (next >= 0 && !c.Holding && Legs(next) >= 3)
            {
                int best = 0;
                for (int d = 0; d < 6; d++) if (Usable(next, d)) best = Math.Max(best, world.RoadClass(next, d));
                float stopAt = 1f - 0.05f / c.Len;
                if (c.S >= stopAt - 0.4f)
                {
                    bool priority = c.Cls >= 3 && c.Cls >= best;
                    bool mustStop = !priority && !c.Stopped;
                    bool held = junctionHeldBy.TryGetValue(next, out int by) && by != c.Seed;
                    float toLine = (stopAt - c.S) * c.Len;
                    if (held || mustStop)
                    {
                        limit = Mathf.Min(limit, Mathf.Max(0f, toLine * 2.5f));
                        if (toLine < 0.015f)
                        {
                            limit = 0;
                            c.Wait += dt;
                            if (mustStop && c.Wait > 0.6f + (c.Seed % 5) * 0.12f) c.Stopped = true;
                            if (held && c.Wait > 6f) junctionHeldBy.Remove(next);   // gridlock breaker
                        }
                    }
                    else if (!held) { junctionHeldBy[next] = c.Seed; c.Holding = true; }
                }
            }
            float accel = c.Speed < limit ? 0.35f : 1.6f;
            c.Speed = Mathf.MoveTowards(c.Speed, limit, accel * dt);
            c.S += c.Speed * dt / c.Len;
            if (c.S >= 1f)
            {
                // into the next hex: leave this one's junction, keep the next one's while crossing it
                if (junctionHeldBy.TryGetValue(c.Tile, out int s0) && s0 == c.Seed) junctionHeldBy.Remove(c.Tile);
                if (next < 0) { c.S = 1f; c.Speed = 0; cars[i] = c; return; }
                int into = (c.Out + 3) % 6;
                if (c.Dest < 0 || next == c.Dest) c.Dest = destTiles.Count > 0 ? destTiles[rng.Next(destTiles.Count)] : -1;
                int outDir = ChooseNext(next, into, c.Dest);
                c.S = Mathf.Clamp01((c.S - 1f) * c.Len / Mathf.Max(0.05f, RoadCurve.Length(world, next, into, outDir)));
                c.Tile = next; c.In = into; c.Out = outDir;
                c.Len = RoadCurve.Length(world, next, into, outDir);
                c.Cls = Math.Max(world.RoadClass(next, into), world.RoadClass(next, outDir));
                c.Cruise = CruiseFor(c.Cls, c.Body, c.Seed, next);
                c.Holding = false; c.Stopped = false; c.Wait = 0;
                if (!junctionHeldBy.ContainsKey(next) && Legs(next) >= 3) junctionHeldBy[next] = c.Seed;
            }
            cars[i] = c;
        }

        /// <summary>The way out of a hex: toward the destination usually, sometimes a detour; a U-turn only at a dead end.</summary>
        int ChooseNext(int tile, int into, int dest)
        {
            var g = world.Grid;
            float best = float.NegativeInfinity; int bestDir = -1;
            float dxD = 0, dzD = 0;
            if (dest >= 0) { dxD = g.DxWrap(g.CenterX(tile), g.CenterX(dest)); dzD = g.CenterZ(dest) - g.CenterZ(tile); }
            float dLen = Mathf.Sqrt(dxD * dxD + dzD * dzD);
            for (int d = 0; d < 6; d++)
            {
                if (d == into || !Usable(tile, d) || !Allowed(g.Nb[tile * 6 + d])) continue;
                float toward = dLen > 0.01f ? (HexMath.DirX[d] * dxD + HexMath.DirZ[d] * dzD) / dLen : 0f;
                float score = toward * 1.4f + world.RoadClass(tile, d) * 0.25f + (float)rng.NextDouble() * 1.1f;
                if (score > best) { best = score; bestDir = d; }
            }
            return bestDir >= 0 ? bestDir : into;
        }

        void Build(float daylight)
        {
            foreach (var b in batches) b.Clear();
            float lights = Mathf.Clamp01(1.2f - daylight * 1.6f);
            var g = world.Grid;
            foreach (var c in cars)
            {
                RoadCurve.Route(world, c.Tile, c.In, c.Out, c.S, out float x, out float z, out float yaw);
                // drive on the right of the street
                float lane = RoadCurve.Width(c.Cls) * (c.Cls == 1 ? 0.18f : 0.26f);
                math.sincos(yaw, out float sn, out float cs);
                x -= cs * lane; z += sn * lane;   // map right of heading (sin, cos) is (-cos, sin)
                float deck = RoadCurve.Deck(world, c.Tile, g.Nb[c.Tile * 6 + c.In], g.Nb[c.Tile * 6 + c.Out]);
                float y = RoadCurve.Height(world, deck, x, z) - 0.012f;
                x = g.NearX(x, camX);
                float3 scale = c.Body == Body.Bus ? new float3(0.04f, 0.035f, 0.11f) : c.Body == Body.Truck ? new float3(0.05f) : new float3(0.042f);
                var p = MapSpace.W(new float3(x, y + (c.Body == Body.Bus ? 0.0175f : 0f), z));
                batches[(int)c.Body].Add(InstanceData.TRS(p, MapSpace.Yaw(yaw), scale, new float4(c.Color, 0)));
                if (lights > 0.05f)
                {
                    float half = c.Size * 0.5f;
                    var head = MapSpace.W(new float3(x + sn * half, y + 0.012f, z + cs * half));
                    var tail = MapSpace.W(new float3(x - sn * half, y + 0.012f, z - cs * half));
                    batches[(int)Body.Count].Add(InstanceData.TRS(head, MapSpace.Yaw(yaw), new float3(0.03f, 0.006f, 0.006f), new float4(1f, 0.92f, 0.7f, 2.5f * lights)));
                    batches[(int)Body.Count].Add(InstanceData.TRS(tail, MapSpace.Yaw(yaw), new float3(0.028f, 0.006f, 0.005f), new float4(0.9f, 0.1f, 0.06f, (c.Speed < 0.05f ? 3f : 1.4f) * lights)));
                }
            }
            foreach (var b in batches) b.Upload();
        }

        public void Draw()
        {
            foreach (var b in batches) if (b.Count > 0) b.Draw();
        }

        public void Dispose() { foreach (var b in batches) b.Dispose(); }
    }
}
