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
    /// Draws The Blight (BLIGHT survival mode): every creature as instanced procedural models (HordeMeshes) with twitchy,
    /// per-creature animation (jittering headings, scuttling bobs, lunges when striking, swinging arms, pulsing sacs,
    /// elites larger and darker), hives with roots and pulsing pustules, and the corrupted ground spreading around each
    /// hive (ground decals, one per hex, tilted to the terrain). The unit renderer skips Blight types (HordeTypes.Is).
    /// </summary>
    public sealed class HordeRenderer : IDisposable
    {
        // creature sizes in world units (a soldier is ~0.07 tall; these read clearly beside him and grow with zoom)
        static readonly float[] Size = { .11f, .085f, .12f, .26f, .2f, .62f, 1.15f };
        readonly InstanceBatch[] bodies = new InstanceBatch[7];
        readonly InstanceBatch maulerArms, colossusArms, pustules, tendrils, ground;
        Material groundMaterial;
        Texture2D groundTexture;

        sealed class Anim
        {
            public float X, Z, Speed, Phase, Yaw, Seen, JerkAt, JerkYaw, StrikeAt, Rise = -1, LastSeen;
            public CreatureKind Kind;
            public int Elite;
        }
        readonly Dictionary<int, Anim> anims = new Dictionary<int, Anim>();
        readonly List<int> stale = new List<int>();
        readonly System.Random rng = new System.Random(77);
        int groundRevision = -1;
        readonly List<InstanceData> groundMarks = new List<InstanceData>();
        public int Drawn { get; private set; }
        /// <summary>Unit ids that rose from the dead recently (claw up out of the ground).</summary>
        public readonly Dictionary<int, float> Rising = new Dictionary<int, float>();

        public HordeRenderer()
        {
            HordeMeshes.Build();
            Mesh[] meshes = { HordeMeshes.Crawler, HordeMeshes.Husk, HordeMeshes.Spitter, HordeMeshes.Mauler, HordeMeshes.Broodsac, HordeMeshes.Colossus, HordeMeshes.Hive };
            for (int i = 0; i < bodies.Length; i++) bodies[i] = Batch(meshes[i], 256);
            maulerArms = Batch(HordeMeshes.MaulerArm, 128);
            colossusArms = Batch(HordeMeshes.ColossusArm, 16);
            pustules = Batch(HordeMeshes.Pustule, 256);
            tendrils = Batch(HordeMeshes.Tendril, 256);
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

        static InstanceBatch Batch(Mesh mesh, int capacity) => new InstanceBatch(mesh, RenderResources.Instanced, capacity)
        { Bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f), Buffering = 3 };

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

        static float Noise(float t, float seed) => Mathf.PerlinNoise(t, seed) * 2f - 1f;

        /// <summary>Note a strike from the event stream: the creature lunges or swings.</summary>
        public void NoteStrike(int id, float time) { if (anims.TryGetValue(id, out var a)) a.StrikeAt = time; }

        public void Update(UnitStore store, WorldModel world, HordeState state, float camX, Vector3 focus, float camDist, float time, float dt)
        {
            foreach (var b in bodies) b.Clear();
            maulerArms.Clear(); colossusArms.Clear(); pustules.Clear(); tendrils.Clear();
            Drawn = 0;
            if (!world.Ready) return;
            var grid = world.Grid;
            if (ground != null && groundRevision != state.HiveRevision) RebuildGround(world, state);
            // far zoom: creatures grow so the swarm still reads as a swarm (they would be specks)
            float zoom = Mathf.Clamp(camDist / 34f, 1f, 3.2f);
            float reach = Mathf.Max(40f, camDist * 2.6f);
            for (int s = 0; s < store.SlotCount; s++)
            {
                ref var u = ref store.Records[s];
                if (!u.InUse || !HordeTypes.Is(store.Types, u.TypeIndex)) continue;
                store.Position(s, out float sx, out float sz);
                float x = grid.NearX(sx, camX);
                if (Mathf.Abs(x - focus.x) > reach || Mathf.Abs(sz - focus.z) > reach) continue;
                if (!anims.TryGetValue(u.Id, out var a))
                {
                    a = new Anim { X = sx, Z = sz, Kind = HordeTypes.KindOf(store.Types.Name(u.TypeIndex)), Phase = (u.Id * .618f) % 1f * 6.28f, Seen = time,
                        Yaw = store.Facing(s), JerkAt = time + (float)rng.NextDouble() * 2f };
                    anims[u.Id] = a;
                    if (Rising.TryGetValue(u.Id, out float riseAt) && time - riseAt < 2f) a.Rise = riseAt;
                }
                a.LastSeen = time;
                a.Elite = state.EliteOf(u.Id);
                float mdx = grid.DxWrap(a.X, sx), mdz = sz - a.Z, moved = Mathf.Sqrt(mdx * mdx + mdz * mdz);
                a.Speed = Mathf.Lerp(a.Speed, dt > 0 ? Mathf.Min(3f, moved / dt) : 0f, 1f - Mathf.Exp(-dt * 8f));
                a.X = sx; a.Z = sz;
                if (a.Kind == CreatureKind.None) continue;
                Draw(a, u.Id, u.Hp, x, sz, world, time, dt, zoom, store.Facing(s), u.Target > 0);
            }
            // forget creatures not seen for a while
            if (anims.Count > 0 && Time.frameCount % 60 == 0)
            {
                stale.Clear();
                foreach (var kv in anims) if (time - kv.Value.LastSeen > 5f) stale.Add(kv.Key);
                foreach (var id in stale) { anims.Remove(id); Rising.Remove(id); }
            }
            foreach (var b in bodies) b.Upload();
            maulerArms.Upload(); colossusArms.Upload(); pustules.Upload(); tendrils.Upload();
        }

        void Draw(Anim a, int id, int hpPct, float x, float z, WorldModel world, float time, float dt, float zoom, float facing, bool engaged)
        {
            int kind = (int)a.Kind;
            float scale = Size[kind] * (a.Kind == CreatureKind.Hive ? 1f : zoom) * (1f + .12f * Mathf.Min(5, a.Elite));
            float ground = world.GroundHeight(x, z);
            float seed = id * .37f;
            // heading: the move direction when moving, else the server's facing; jittering, with sudden jerks
            float want = facing;
            float turn = Mathf.DeltaAngle(a.Yaw * Mathf.Rad2Deg, want * Mathf.Rad2Deg) * Mathf.Deg2Rad;
            a.Yaw += turn * (1f - Mathf.Exp(-dt * (a.Kind == CreatureKind.Crawler ? 14f : 6f)));
            if (time > a.JerkAt)
            {
                a.JerkAt = time + .25f + (float)rng.NextDouble() * (a.Kind == CreatureKind.Crawler ? .9f : 2.2f);
                a.JerkYaw = ((float)rng.NextDouble() - .5f) * (a.Kind == CreatureKind.Crawler ? 1.4f : .7f);
            }
            a.JerkYaw *= Mathf.Exp(-dt * 7f);
            float twitch = Noise(time * 9f, seed) * .12f + a.JerkYaw;
            float yaw = a.Yaw + (a.Kind == CreatureKind.Hive ? 0 : twitch);
            a.Phase += a.Speed * dt / (scale * .45f) * 6.28f;
            float moving = Mathf.Clamp01(a.Speed / .3f);
            float bob = Mathf.Abs(Mathf.Sin(a.Phase)) * scale * (a.Kind == CreatureKind.Crawler ? .14f : .08f) * moving;
            float pitch = Mathf.Sin(a.Phase * 2f) * .08f * moving + Noise(time * 3f, seed + 5) * .05f;
            float roll = Mathf.Sin(a.Phase) * .1f * moving + Noise(time * 11f, seed + 9) * .04f;
            // strike: a lunge forward and down, decaying over half a second
            float strike = Mathf.Clamp01(1f - (time - a.StrikeAt) / .45f);
            float lunge = Mathf.Sin(strike * Mathf.PI) * (engaged ? 1f : .6f);
            pitch += lunge * .45f;
            // breathing / pulsing
            float pulse = 1f + Mathf.Sin(time * (a.Kind == CreatureKind.Hive ? 1.4f : 2.6f) + seed) * (a.Kind == CreatureKind.Broodsac || a.Kind == CreatureKind.Hive ? .06f : .025f);
            // rising out of the ground (infection, burrows)
            float sink = 0f;
            if (a.Rise >= 0f)
            {
                float t = (time - a.Rise) / 1.4f;
                if (t >= 1f) a.Rise = -1f;
                else { sink = (1f - Mathf.SmoothStep(0, 1, t)) * scale; roll += Noise(time * 20f, seed) * .4f * (1 - t); }
            }
            var fwd = new float3(math.sin(a.Yaw), 0, math.cos(a.Yaw));
            var mapPos = new float3(x + fwd.x * lunge * scale * .25f, ground + bob - sink, z + fwd.z * lunge * scale * .25f);
            var rot = quaternion.EulerYXZ(-pitch, MapSpace.Yaw(yaw), roll);
            var color = Tint(a, hpPct, time, seed);
            float3 s3 = new float3(scale, scale * pulse, scale);
            bodies[kind].Add(InstanceData.TRS(MapSpace.W(mapPos), rot, s3, color));
            Drawn++;
            var right = math.mul(rot, new float3(1, 0, 0));
            var up = math.mul(rot, new float3(0, 1, 0));
            var forward = math.mul(rot, new float3(0, 0, 1));
            var basePos = MapSpace.W(mapPos);
            switch (a.Kind)
            {
                case CreatureKind.Mauler:
                case CreatureKind.Colossus:
                {
                    bool boss = a.Kind == CreatureKind.Colossus;
                    float sh = boss ? .82f : .7f, sw = boss ? .36f : .42f;
                    for (int side = -1; side <= 1; side += 2)
                    {
                        // arms swing with the gait, and both club down in a strike
                        float swing = Mathf.Sin(a.Phase + (side > 0 ? 0 : Mathf.PI)) * .5f * moving + Noise(time * 2f, seed + side) * .12f;
                        float smash = strike > 0 ? -Mathf.Sin(strike * Mathf.PI) * 1.6f : 0f;
                        var shoulder = basePos + (right * side * sw + up * sh) * scale;
                        var arm = math.mul(rot, quaternion.EulerYXZ(swing + smash, 0, side * .2f));
                        (boss ? colossusArms : maulerArms).Add(InstanceData.TRS(shoulder, arm, new float3(scale), color));
                    }
                    break;
                }
                case CreatureKind.Spitter:
                case CreatureKind.Broodsac:
                {
                    // the glowing sac swells before a spit / throbs with the brood
                    float swell = a.Kind == CreatureKind.Spitter ? .14f + Mathf.Sin(time * 4f + seed) * .02f + Mathf.Sin(strike * Mathf.PI) * .06f : .1f + Mathf.Sin(time * 6f + seed) * .03f;
                    var at = basePos + (up * (a.Kind == CreatureKind.Spitter ? .3f : .62f) + forward * (a.Kind == CreatureKind.Spitter ? .2f : -.1f)) * scale;
                    pustules.Add(InstanceData.TRS(at, rot, new float3(scale * swell * 2f), Glow(time, seed, .55f)));
                    break;
                }
                case CreatureKind.Hive:
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
                    for (int k = 0; k < 6; k++)
                    {
                        float ang = k * 1.1f + seed * 2f, p = 1f + Mathf.Sin(time * 2.2f + k * 1.3f) * .25f;
                        var at = basePos + new float3(math.sin(ang) * .3f, .18f + (k % 3) * .1f, math.cos(ang) * .3f) * scale;
                        pustules.Add(InstanceData.TRS(at, quaternion.identity, new float3(scale * .12f * p), Glow(time, seed + k, .4f)));
                    }
                    break;
                }
            }
        }

        static float4 Tint(Anim a, int hpPct, float time, float seed)
        {
            // elites go darker and redder; the badly wounded paler
            float e = Mathf.Min(4, a.Elite) / 4f;
            var c = new float3(1f, .98f, .94f);
            c = math.lerp(c, new float3(.78f, .45f, .42f), e * .8f);
            if (hpPct < 40) c = math.lerp(c, new float3(.85f, .82f, .7f), (40 - hpPct) / 80f);
            float emission = a.Elite > 0 ? .25f + .15f * Mathf.Sin(time * 5f + seed) : 0f;
            return new float4(c, emission);
        }

        static float4 Glow(float time, float seed, float baseGlow) => new float4(1f, 1f, .9f, baseGlow + .3f * (.5f + .5f * Mathf.Sin(time * 3.2f + seed)));

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
            foreach (var b in bodies) b.Draw();
            maulerArms.Draw(); colossusArms.Draw(); pustules.Draw(); tendrils.Draw();
        }

        public void Clear()
        {
            anims.Clear(); Rising.Clear();
            ground?.Clear(); groundRevision = -1;
        }

        public void Dispose()
        {
            foreach (var b in bodies) b.Dispose();
            maulerArms.Dispose(); colossusArms.Dispose(); pustules.Dispose(); tendrils.Dispose(); ground?.Dispose();
            if (groundMaterial != null) UnityEngine.Object.Destroy(groundMaterial);
            if (groundTexture != null) UnityEngine.Object.Destroy(groundTexture);
        }
    }
}
