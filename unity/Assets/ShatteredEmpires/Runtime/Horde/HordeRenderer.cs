using System;
using System.Collections.Generic;
using SE.Core.Units;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Horde
{
    /// <summary>
    /// Draws The Blight (BLIGHT survival mode). Each creature is one 64-byte record (HordeInstance) in the batch of its
    /// kind and level of detail; SE/HordeLit poses it on the GPU from that record (twitching, jerking headings, scuttling
    /// bob, stepping legs, swinging and clubbing arms, lunges, pulsing sacs, trembling heads, swaying stalks, gnashing
    /// mouths, clawing up out of the ground; elites larger, darker and smouldering). The CPU only keeps the smoothed
    /// heading, the gait phase and the speed per creature, tests each against the camera's real frustum, picks the level
    /// of detail from its size on screen (the far level casts no shadow) and writes the record. Hives also get roots
    /// along the ground, and the corrupted ground spreads around each hive (ground decals, one per hex, tilted to the
    /// terrain). The unit renderer skips Blight types (HordeTypes.Is).
    /// </summary>
    public sealed class HordeRenderer : IDisposable
    {
        // creature sizes in world units (a soldier is ~0.07 tall; these read clearly beside him and grow with zoom)
        static readonly float[] Size = { .11f, .085f, .12f, .26f, .2f, .62f, 1.15f };
        // bounding sphere radius per kind, in model units (legs, arms and a lunge reach past the body)
        static readonly float[] Reach = { 1.05f, .75f, .85f, .95f, .85f, 1f, .95f };
        /// <summary>On-screen height (pixels) above which a creature draws at LOD0, and above which at LOD1; below, LOD2 without shadows.</summary>
        public static float Lod0Pixels = 56f, Lod1Pixels = 16f;

        readonly HordeBatch[] batches = new HordeBatch[HordeMeshes.Kinds * HordeMeshes.Lods];
        readonly Material[] materials = new Material[HordeMeshes.Kinds];
        readonly InstanceBatch tendrils, ground;
        Material groundMaterial;
        Texture2D groundTexture;
        static readonly int HordeTimeId = Shader.PropertyToID("_HordeTime");

        sealed class Anim
        {
            public float X, Z, Speed, Phase, Yaw, StrikeAt, Rise, LastSeen, GroundY;
            public CreatureKind Kind;
        }
        readonly Dictionary<int, Anim> anims = new Dictionary<int, Anim>();
        readonly Stack<Anim> pool = new Stack<Anim>();
        readonly List<int> stale = new List<int>();
        readonly Plane[] planes = new Plane[6];
        int groundRevision = -1;

        /// <summary>Creatures drawn / culled by the frustum last frame, per-LOD counts and the CPU cost of Update (ms).</summary>
        public int Drawn { get; private set; }
        public int Culled { get; private set; }
        public readonly int[] LodCounts = new int[HordeMeshes.Lods];
        public float BuildMs { get; private set; }
        /// <summary>Unit ids that rose from the dead recently (claw up out of the ground).</summary>
        public readonly Dictionary<int, float> Rising = new Dictionary<int, float>();

        public HordeRenderer()
        {
            HordeMeshes.Build();
            var shader = Resources.Load<Shader>("Shaders/HordeLit");
            if (shader == null) Debug.LogError("Shattered Empires: missing shader Shaders/HordeLit; the Blight will not draw");
            for (int k = 0; k < HordeMeshes.Kinds; k++)
            {
                if (shader != null) materials[k] = KindMaterial(shader, k);
                for (int l = 0; l < HordeMeshes.Lods; l++)
                    batches[k * HordeMeshes.Lods + l] = new HordeBatch(HordeMeshes.Models[k, l], materials[k], k == (int)CreatureKind.Hive ? 16 : 128,
                        l < 2 ? ShadowCastingMode.On : ShadowCastingMode.Off);
            }
            tendrils = new InstanceBatch(HordeMeshes.Tendril, RenderResources.Instanced, 64) { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3 };
            var decal = Resources.Load<Shader>("Shaders/GroundDecal");
            if (decal != null)
            {
                groundTexture = CorruptionTexture();
                groundMaterial = new Material(decal) { name = "SE blight ground", enableInstancing = true };
                groundMaterial.SetTexture("_MainTex", groundTexture);
                ground = new InstanceBatch(SE.Runtime.Effects.FadingMarks.Quad("SE blight quad"), groundMaterial, 512)
                { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 1, Shadows = ShadowCastingMode.Off, ReceiveShadows = true };
            }
        }

        /// <summary>How each kind moves (SE/HordeLit amplitudes, in model units and radians).</summary>
        static Material KindMaterial(Shader shader, int kind)
        {
            var m = new Material(shader) { name = "SE blight " + HordeMeshes.Names[kind] };
            //                       stride lift  bob   twitch jerk  rate  sac   rate breathe rate tremor sway  jaw   still
            float[][] table =
            {
                new[] { .16f, .10f, .14f, .12f, 1.4f, 1.1f, 0f,   4f,  .025f, 2.6f, .02f,  .05f, .06f, 0f },   // crawler
                new[] { .14f, .05f, .08f, .08f, .7f,  .5f,  .03f, 3f,  .02f,  2.2f, .035f, .04f, .03f, 0f },   // husk
                new[] { .12f, .06f, .06f, .08f, .7f,  .5f,  .05f, 4f,  .025f, 2.6f, .015f, .03f, .05f, 0f },   // spitter
                new[] { .10f, .05f, .08f, .06f, .5f,  .4f,  0f,   4f,  .025f, 2.2f, .02f,  .03f, .03f, 0f },   // mauler
                new[] { .10f, .08f, .10f, .06f, .6f,  .5f,  .06f, 6f,  .05f,  2.6f, .02f,  .04f, .04f, 0f },   // broodsac
                new[] { .08f, .04f, .05f, .04f, .35f, .3f,  .03f, 3f,  .02f,  1.6f, .02f,  .035f, .04f, 0f },  // colossus
                new[] { 0f,   0f,   0f,   0f,   0f,   .5f,  .08f, 2.2f, .05f, 1.4f, 0f,    .04f, .05f, 1f },   // hive
            };
            var t = table[kind];
            m.SetFloat("_LegStride", t[0]); m.SetFloat("_LegLift", t[1]); m.SetFloat("_Bob", t[2]);
            m.SetFloat("_Twitch", t[3]); m.SetFloat("_JerkAmp", t[4]); m.SetFloat("_JerkRate", t[5]);
            m.SetFloat("_SacAmp", t[6]); m.SetFloat("_SacRate", t[7]); m.SetFloat("_Breathe", t[8]); m.SetFloat("_BreatheRate", t[9]);
            m.SetFloat("_Tremor", t[10]); m.SetFloat("_Sway", t[11]); m.SetFloat("_Jaw", t[12]); m.SetFloat("_Still", t[13]);
            // shoulder pivots (|x|, y, z) of the arm region and the gait swing (tools/blender/build_horde.py)
            m.SetVector("_ArmPivot", kind == 1 ? new Vector4(.17f, .76f, .1f, .35f) : kind == 3 ? new Vector4(.42f, .7f, .02f, .5f) : kind == 5 ? new Vector4(.36f, .82f, 0f, .4f) : Vector4.zero);
            m.SetFloat("_Gloss", kind == 6 ? .35f : .45f);
            return m;
        }

        /// <summary>A blotchy, veined decal: dark rot with lighter bile veins, soft and ragged at the edge.</summary>
        static Texture2D CorruptionTexture()
        {
            const int S = 128;
            var t = new Texture2D(S, S, TextureFormat.RGBA32, true) { name = "SE blight corruption", wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[S * S];
            for (int y = 0; y < S; y++) for (int x = 0; x < S; x++)
            {
                float u = (x + .5f) / S - .5f, v = (y + .5f) / S - .5f, r = Mathf.Sqrt(u * u + v * v) * 2f;
                float n = Mathf.PerlinNoise(x * .06f, y * .06f) * .6f + Mathf.PerlinNoise(x * .17f + 9, y * .17f + 3) * .4f;
                float vein = Mathf.Abs(Mathf.PerlinNoise(x * .045f + 31, y * .045f + 17) - .5f);
                float veinMask = Mathf.Clamp01(1f - vein * 22f);
                float edge = Mathf.Clamp01((1.02f - r + (n - .5f) * .45f) * 4f);
                var rot = Color.Lerp(new Color(.16f, .17f, .1f), new Color(.3f, .24f, .26f), n);
                var c = Color.Lerp(rot, new Color(.62f, .74f, .2f), veinMask * .8f);
                c.a = edge * (.72f + n * .25f);
                px[y * S + x] = c;
            }
            t.SetPixels32(px);
            t.Apply(true);
            return t;
        }

        /// <summary>Note a strike from the event stream: the creature rears back and lunges, or clubs down.</summary>
        public void NoteStrike(int id, float time) { if (anims.TryGetValue(id, out var a)) a.StrikeAt = time; }

        public void Update(UnitStore store, WorldModel world, HordeState state, Camera cam, float camX, float camDist, float time, float dt)
        {
            long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
            foreach (var b in batches) b.Clear();
            tendrils.Clear();
            Drawn = Culled = 0;
            Array.Clear(LodCounts, 0, LodCounts.Length);
            if (!world.Ready || cam == null) return;
            Shader.SetGlobalFloat(HordeTimeId, time);
            var grid = world.Grid;
            if (ground != null && groundRevision != state.HiveRevision) RebuildGround(world, state);
            GeometryUtility.CalculateFrustumPlanes(cam, planes);
            Vector3 eye = cam.transform.position;
            // pixels per world unit at distance 1 (screen-space size for the level of detail)
            float pixK = cam.orthographic ? 0f : cam.pixelHeight / (2f * Mathf.Tan(cam.fieldOfView * .5f * Mathf.Deg2Rad));
            float orthoPx = cam.orthographic ? cam.pixelHeight / (2f * Mathf.Max(.01f, cam.orthographicSize)) : 0f;
            // far zoom: creatures grow so the swarm still reads as a swarm (they would be specks)
            float zoom = Mathf.Clamp(camDist / 34f, 1f, 3.2f);
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse || !HordeTypes.Is(store.Types, u.TypeIndex)) continue;
                store.Position(s, out float sx, out float sz);
                float x = grid.NearX(sx, camX);
                if (!anims.TryGetValue(u.Id, out var a))
                {
                    a = pool.Count > 0 ? pool.Pop() : new Anim();
                    a.X = sx; a.Z = sz; a.Speed = 0; a.Kind = HordeTypes.KindOf(store.Types.Name(u.TypeIndex));
                    a.Phase = (u.Id * .618f) % 1f * 6.28f; a.Yaw = store.Facing(s); a.StrikeAt = -1000f;
                    a.Rise = Rising.TryGetValue(u.Id, out float riseAt) && time - riseAt < 2f ? riseAt : -1000f;
                    a.GroundY = world.GroundHeight(x, sz);
                    anims[u.Id] = a;
                }
                a.LastSeen = time;
                float mdx = grid.DxWrap(a.X, sx), mdz = sz - a.Z, moved = Mathf.Sqrt(mdx * mdx + mdz * mdz);
                a.Speed = Mathf.Lerp(a.Speed, dt > 0 ? Mathf.Min(3f, moved / dt) : 0f, 1f - Mathf.Exp(-dt * 8f));
                a.X = sx; a.Z = sz;
                if (a.Kind == CreatureKind.None) continue;
                int kind = (int)a.Kind;
                int elite = state.EliteOf(u.Id);
                float scale = Size[kind] * (a.Kind == CreatureKind.Hive ? 1f : zoom) * (1f + .12f * Mathf.Min(5, elite));
                // heading: eases toward the server's facing (crawlers snap round fastest); the twitch is on the GPU
                float turn = Mathf.DeltaAngle(a.Yaw * Mathf.Rad2Deg, store.Facing(s) * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                a.Yaw += turn * (1f - Mathf.Exp(-dt * (a.Kind == CreatureKind.Crawler ? 14f : 6f)));
                a.Phase = (a.Phase + a.Speed * dt / (scale * .45f) * 6.2832f) % 6.2832f;
                // frustum test on a sphere around the body (the ground height from the last visible frame)
                float radius = scale * Reach[kind];
                var center = new Vector3(x, a.GroundY + scale * .45f, -sz);
                if (!Visible(center, radius)) { Culled++; continue; }
                a.GroundY = world.GroundHeight(x, sz);
                center.y = a.GroundY + scale * .45f;
                float dist = Vector3.Distance(center, eye);
                float px = cam.orthographic ? scale * orthoPx : scale * pixK / Mathf.Max(.01f, dist);
                int lod = px > Lod0Pixels ? 0 : px > Lod1Pixels ? 1 : 2;
                var feet = MapSpace.W(x, a.GroundY, sz);
                var rec = new HordeInstance
                {
                    PosYaw = new float4(feet, MapSpace.Yaw(a.Yaw)),
                    Motion = new float4(scale, a.Phase, Mathf.Clamp01(a.Speed / .3f), (u.Id * .6180339f) % 1f * 10f),
                    Events = new float4(a.StrikeAt, a.Rise, elite, u.Hp * .01f),
                    Extra = new float4(u.Target > 0 ? 1 : 0, 0, 0, 0),
                };
                batches[kind * HordeMeshes.Lods + lod].Add(rec, center, radius);
                LodCounts[lod]++;
                Drawn++;
                if (a.Kind == CreatureKind.Hive) Roots(world, feet, x, sz, a.GroundY, scale, u.Id * .37f);
            }
            // forget creatures not seen for a while
            if (anims.Count > 0 && Time.frameCount % 60 == 0)
            {
                stale.Clear();
                foreach (var kv in anims) if (time - kv.Value.LastSeen > 5f) stale.Add(kv.Key);
                foreach (var id in stale) { pool.Push(anims[id]); anims.Remove(id); Rising.Remove(id); }
            }
            foreach (var b in batches) b.Upload();
            tendrils.Upload();
            BuildMs = (System.Diagnostics.Stopwatch.GetTimestamp() - t0) * 1000f / System.Diagnostics.Stopwatch.Frequency;
        }

        bool Visible(Vector3 c, float r)
        {
            for (int i = 0; i < 6; i++) if (planes[i].GetDistanceToPoint(c) < -r) return false;
            return true;
        }

        /// <summary>A hive's roots spread over the ground around it, each tilted to the slope it runs down.</summary>
        void Roots(WorldModel world, float3 basePos, float x, float z, float ground, float scale, float seed)
        {
            for (int k = 0; k < 9; k++)
            {
                float ang = k * .698f + seed, len = scale * (.9f + (k % 3) * .35f);
                var root = basePos + new float3(math.sin(ang), 0, math.cos(ang)) * scale * .35f;
                float g = world.GroundHeight(x + math.sin(ang) * len, z - math.cos(ang) * len);
                root.y = ground + .01f;
                var dir = quaternion.EulerYXZ(-math.atan2(g - ground, len), ang, 0);
                tendrils.Add(InstanceData.TRS(root, dir, new float3(scale * .7f, scale * .7f, len), new float4(.9f, .9f, .85f, 0)));
            }
        }

        /// <summary>Corrupted ground: a tilted decal on every hex within each hive's blight radius.</summary>
        void RebuildGround(WorldModel world, HordeState state)
        {
            groundRevision = state.HiveRevision;
            ground.Clear();
            var grid = world.Grid;
            var seen = new HashSet<int>();
            var r = new System.Random(state.HiveRevision * 31 + 7);
            foreach (var h in state.Hives)
            {
                int center = grid.TileAt(h.X, h.Z);
                if (center < 0) continue;
                int rad = Mathf.Max(1, h.Radius);
                int cq = grid.Q(center), cr = grid.R(center);
                for (int dr = -rad - 1; dr <= rad + 1; dr++) for (int dq = -rad - 2; dq <= rad + 2; dq++)
                {
                    int q = cq + dq, row = cr + dr;
                    if (row < 0 || row >= grid.H) continue;
                    if (!grid.Wrap && (q < 0 || q >= grid.W)) continue;
                    int t = row * grid.W + ((q % grid.W) + grid.W) % grid.W;
                    if (HexMath.Dist(center, t, grid.W, grid.Wrap) > rad || !seen.Add(t)) continue;
                    float tx = grid.CenterX(t), tz = grid.CenterZ(t);
                    float gy = world.GroundHeight(tx, tz);
                    // tilt to the ground (finite differences)
                    float hx = world.GroundHeight(tx + .6f, tz) - world.GroundHeight(tx - .6f, tz), hz = world.GroundHeight(tx, tz + .6f) - world.GroundHeight(tx, tz - .6f);
                    var nMap = math.normalize(new float3(-hx / 1.2f, 1f, -hz / 1.2f));
                    var n = MapSpace.W(nMap);
                    var tilt = Quaternion.FromToRotation(Vector3.up, new Vector3(n.x, n.y, n.z));
                    var q2 = (quaternion)(tilt * Quaternion.Euler(0, (float)r.NextDouble() * 360f, 0));
                    float edge = HexMath.Dist(center, t, grid.W, grid.Wrap) / (float)rad;
                    float size = 2.6f + (float)r.NextDouble() * .8f;
                    ground.Add(InstanceData.TRS(MapSpace.W(new float3(tx, gy + .012f, tz)), q2, new float3(size, 1, size * (.8f + (float)r.NextDouble() * .4f)),
                        new float4(1f, 1f, 1f, Mathf.Lerp(.95f, .55f, edge))));
                }
            }
            ground.Upload();
        }

        public void Draw()
        {
            ground?.Draw();
            foreach (var b in batches) b.Draw();
            tendrils.Draw();
        }

        public void Clear()
        {
            foreach (var a in anims.Values) pool.Push(a);
            anims.Clear(); Rising.Clear();
            ground?.Clear(); groundRevision = -1;
        }

        public void Dispose()
        {
            foreach (var b in batches) b.Dispose();
            tendrils.Dispose(); ground?.Dispose();
            foreach (var m in materials) if (m != null) UnityEngine.Object.Destroy(m);
            if (groundMaterial != null) UnityEngine.Object.Destroy(groundMaterial);
            if (groundTexture != null) UnityEngine.Object.Destroy(groundTexture);
        }
    }
}
