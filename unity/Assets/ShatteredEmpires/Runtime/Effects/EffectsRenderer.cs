using System;
using System.Runtime.InteropServices;
using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    [StructLayout(LayoutKind.Sequential)]
    struct ParticleGpu
    {
        public float4 Position;   // xyz, size
        public float4 Color;      // rgb, opacity
        public float4 Shape;      // rotation, softness, seed, heat
        public float4 Extra;      // stretch xyz, kind
    }

    /// <summary>
    /// Combat and weather presentation from the server's event stream: muzzle flashes and tracers,
    /// explosions with fireballs, dust and rising smoke, flak air bursts, building fires with flames and
    /// embers, the strategic-strike and reactor sequences (flash, fireball, mushroom cloud, ground
    /// shockwaves), rain streaks and splashes, fading craters and wrecks. A fixed particle budget
    /// (pooled, two draws per frame, triple-buffered uploads) keeps cost bounded however large the
    /// battle; when the budget is reached new cosmetic particles are skipped, never state. The API takes
    /// map coordinates (x east, z south); conversion to Unity space happens inside.
    /// </summary>
    public sealed partial class EffectsRenderer : IDisposable
    {
        public const int Puff = 0, Flame = 1, Ring = 2, Streak = 3;

        struct Particle
        {
            public float3 Pos, Vel, Stretch;
            public float Size, Grow, Life, Max, Rot, Spin, Seed, Heat, Drag, Rise, Kind;
            public float3 Color0, Color1;
            public float Alpha;
            public bool Additive, StretchWithVelocity;
            // debris: the ground height (Unity y) it lands on, bouncing once or twice and coming to rest
            public float Floor;
            public bool Bounce;
        }

        static readonly int ParticlesId = Shader.PropertyToID("_Particles");
        static readonly int ImageOffsetId = Shader.PropertyToID("_SE_ImageOffset");

        readonly Particle[] pool;
        int count;
        public readonly int Budget = 16000;
        NativeArray<ParticleGpu> addData, alphaData;
        readonly GraphicsBuffer[] addBuffers = new GraphicsBuffer[3], alphaBuffers = new GraphicsBuffer[3];
        int frameSlot;
        readonly MaterialPropertyBlock addBlock = new MaterialPropertyBlock(), alphaBlock = new MaterialPropertyBlock();
        int addCount, alphaCount;
        // Client-only marks with lifetimes (destruction pass, 2026-11-18: these were ring buffers that never
        // faded, so a long match carried 4000 scorch decals, 2400 rubble boxes and 900 blood splashes for good).
        // Lifetimes are game seconds (paused while the game is): hold, then fade. See FadingMarks.
        readonly FadingMarks craters, wrecks;
        const int MaxCraters = 1500, MaxWrecks = 300;
        const float CraterHold = 60f, CraterFade = 120f, WreckHold = 180f, WreckFade = 60f;
        /// <summary>Game time (seconds, scaled by the simulation rate) that the mark lifetimes run on.</summary>
        float markClock;
        readonly System.Random rng = new System.Random(5);
        public int Live => count;
        public int Skipped { get; private set; }
        public float Intensity = 1f;
        /// <summary>Camera shake requested by nearby blasts (decays; the camera reads it).</summary>
        public float Shake;
        /// <summary>A brief full-scene flash (strategic blasts, lightning); the atmosphere reads it.</summary>
        public float Flash;
        /// <summary>Raised for every blast (map point, relative strength): ambient life reacts to it.</summary>
        public event Action<float3, float> Blast;

        Material craterMaterial;
        Texture2D craterTexture;
        Mesh craterQuad;
        /// <summary>Instance colour for a ground mark: the decal reads w as opacity (and its splash fades at ~0.8 of the quad, so it is drawn a little larger); the opaque fallback ignores w.</summary>
        float4 MarkColor(float3 rgb, float opacity) => new float4(rgb, craterMaterial != null ? opacity : 0);
        float MarkScale => craterMaterial != null ? 1.25f : 1f;

        public EffectsRenderer()
        {
            pool = new Particle[Budget];
            addData = new NativeArray<ParticleGpu>(Budget, Allocator.Persistent);
            alphaData = new NativeArray<ParticleGpu>(Budget, Allocator.Persistent);
            // Final pass: scorches and craters were opaque 12-sided discs (the hard black octagons left by fallen
            // buildings and wrecks). They are now the same soft-edged SE/GroundDecal splash the wreck scorch uses.
            var decal = Resources.Load<Shader>("Shaders/GroundDecal");
            if (decal != null)
            {
                craterTexture = SE.Runtime.Battlefields.WarzoneRenderer.ScorchTexture();
                craterMaterial = new Material(decal) { name = "SE scorch decals", enableInstancing = true };
                craterMaterial.SetTexture("_MainTex", craterTexture);
                craterQuad = FadingMarks.Quad("SE crater quad");
                craters = new FadingMarks(FadingMarks.NewBatch(craterQuad, craterMaterial, MaxCraters, false), MaxCraters, CraterHold, CraterFade, sink: false);
            }
            // the opaque disc fallback has no alpha: it sinks away instead
            else craters = new FadingMarks(FadingMarks.NewBatch(MeshKit.Disc, RenderResources.Instanced, MaxCraters, false), MaxCraters, CraterHold, CraterFade, sink: true);
            wrecks = new FadingMarks(FadingMarks.NewBatch(MeshKit.Wreck, RenderResources.Instanced, MaxWrecks, true), MaxWrecks, WreckHold, WreckFade, sink: true);
            rubble = new FadingMarks(FadingMarks.NewBatch(MeshKit.Box, RenderResources.Instanced, MaxRubble, true), MaxRubble, RubbleHold, RubbleFade, sink: true);
        }

        float R() => (float)rng.NextDouble();
        float3 RandDir() => math.normalizesafe(new float3(R() - 0.5f, R() - 0.5f, R() - 0.5f), new float3(0, 1, 0));

        void Emit(float3 mapPos, float3 mapVel, float size, float grow, float life, float3 c0, float3 c1, float alpha, bool additive,
            float heat = 0, float drag = 1.5f, float rise = 0, float kind = Puff, float3 mapStretch = default, bool stretchWithVelocity = false)
        {
            if (count >= pool.Length) { Skipped++; return; }
            pool[count++] = new Particle
            {
                Pos = MapSpace.W(mapPos), Vel = MapSpace.W(mapVel), Stretch = MapSpace.W(mapStretch), Size = size, Grow = grow, Life = 0, Max = life,
                Rot = R() * 6.28f, Spin = (R() - 0.5f) * 1.2f, Seed = R() * 100f, Heat = heat, Drag = drag, Rise = rise, Kind = kind,
                Color0 = c0, Color1 = c1, Alpha = alpha, Additive = additive, StretchWithVelocity = stretchWithVelocity,
                Floor = -1e9f, Bounce = false,
            };
        }

        /// <summary>A chunk of debris on a ballistic arc (full gravity) that lands on the ground at floorY, bounces and rests.</summary>
        void EmitDebris(float3 mapPos, float3 mapVel, float size, float life, float3 color, float floorY, float gravity = -3.2f)
        {
            int before = count;
            Emit(mapPos, mapVel, size, 0, life, color, color * .8f, 1f, false, 0, .12f, gravity);
            if (count > before) { pool[count - 1].Floor = floorY + size * .4f; pool[count - 1].Bounce = true; }
        }

        // ------------------------------------------------------------------ combat
        public void Explosion(float3 p, float scale)
        {
            Blast?.Invoke(p, scale);
            FlashLight(p, scale);
            int n = Mathf.Max(2, (int)(7 * Intensity));
            Emit(p + new float3(0, 0.05f * scale, 0), float3.zero, .18f * scale, .72f * scale, .085f, new float3(1f, .77f, .38f), new float3(.86f, .26f, .05f), .92f, true, 1.2f);
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 0.8f + 0.2f, R() - 0.5f) * 0.9f * scale;
                Emit(p + new float3(0, 0.04f, 0), v, 0.13f * scale, 0.5f * scale, 0.35f + R() * 0.25f, new float3(1f, 0.6f, 0.2f), new float3(0.5f, 0.12f, 0.04f), 0.9f, true, 1.5f, 3f);
            }
            // smoke pass (2026-11-17): 7 puffs living 1.8-3.6 s (was n + 3 = 10 living 2.5-5 s), about half the smoke
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 0.5f + 0.3f, R() - 0.5f) * 0.45f * scale;
                float g = R() * 0.07f;   // final pass: dusty grey-brown, not dark (heavy barrages stacked it into a black sheet)
                Emit(p + new float3(0, 0.05f, 0), v, 0.15f * scale, 0.35f * scale, 1.8f + R() * 1.8f, new float3(0.47f + g, 0.42f + g, 0.35f + g), new float3(0.64f, 0.6f, 0.53f), 0.5f, false, 0, 1.2f, 0.12f);
            }
            for (int k = 0; k < n; k++)
            {
                var v = new float3(R() - 0.5f, R() * 1.5f + 0.7f, R() - 0.5f) * 0.65f * scale;
                Emit(p, v, 0.035f * scale, 0.01f, 0.8f, new float3(0.22f, 0.18f, 0.14f), new float3(0.2f, 0.16f, 0.12f), 0.95f, false, 0, 0.4f, -2.4f);
            }
            for (int k = 0; k < n; k++)
            {
                var v = RandDir() * (1.2f + R()) * scale; v.y = math.abs(v.y) + 0.4f;
                Emit(p + new float3(0, 0.05f, 0), v, 0.008f, 0, 0.4f + R() * 0.3f, new float3(1f, 0.8f, 0.4f), new float3(1f, 0.35f, 0.1f), 1f, true, 2f, 0.8f, -1.8f, Streak, default, true);
            }
            // Thrown earth: dark clods that arc up and fall back, so blasts read as tearing up ground.
            float floor = GroundAt != null ? GroundAt(p.x, p.z) : p.y - .01f;
            for (int k = 0; k < n + 2; k++)
            {
                var v = new float3(R() - 0.5f, R() * 1.1f + 0.9f, R() - 0.5f) * 1.05f * scale;
                float g = .17f + R() * .09f;   // earth clods: dark soil, never black
                EmitDebris(p + new float3(0, 0.03f, 0), v, (0.012f + R() * .014f) * scale, 1.3f + R() * .9f, new float3(g, g * .85f, g * .7f), floor, -3.4f);
            }
            if (scale > .6f)
            {
                // A lingering smoke column that drifts with the wind, and a low dust skirt rolling outward.
                // smoke pass: 3 column puffs living 5-8.5 s at .36 alpha (was 4 living 7-12 s at .42)
                for (int k = 0; k < 3; k++)
                {
                    float g = .40f + R() * .07f;   // dusty grey-brown column (was .07-.13: near-black)
                    Emit(p + new float3((R() - .5f) * .08f * scale, .1f * scale + k * .07f * scale, (R() - .5f) * .08f * scale), new float3(0, .12f + R() * .08f, 0) * scale,
                        .22f * scale, .30f * scale, 5f + R() * 3.5f, new float3(g, g * .92f, g * .8f), new float3(.6f, .57f, .52f), .36f, false, 0, .35f, .05f);
                }
                for (int k = 0; k < 6; k++)   // smoke pass: 6 skirt puffs at .38 alpha (was 8 at .45)
                {
                    float a = k / 6f * 6.283f + R() * .4f;
                    Emit(p + new float3(0, .02f, 0), new float3(math.cos(a), .03f, math.sin(a)) * .55f * scale, .10f * scale, .32f * scale, 1.8f + R(),
                        new float3(.42f, .38f, .32f), new float3(.52f, .49f, .45f), .38f, false, 0, 1.6f, .01f);
                }
            }
            if (scale > .48f) GroundShock(p, scale * 1.65f, .65f + scale * .24f);
            if (scale > .8f) Distortion(p, 1.6f * scale, .55f, .55f);
            Shake = Mathf.Max(Shake, 0.12f * scale);
        }

        public void AirBurst(float3 p)
        {
            Emit(p, float3.zero, 0.2f, 0.7f, 0.12f, new float3(1f, 0.85f, 0.6f), new float3(1f, 0.6f, 0.3f), 1f, true, 2.2f);
            for (int k = 0; k < 5; k++)
                Emit(p, RandDir() * 1.4f, 0.006f, 0, 0.35f, new float3(1f, 0.85f, 0.5f), new float3(1f, 0.4f, 0.1f), 1f, true, 2f, 1f, -0.5f, Streak, default, true);
            for (int k = 0; k < 3; k++)
                Emit(p + RandDir() * 0.04f, RandDir() * 0.05f, 0.1f, 0.22f, 4f + R() * 2f, new float3(0.14f, 0.14f, 0.15f), new float3(0.3f, 0.3f, 0.32f), 0.7f, false, 0, 0.8f, 0.01f);
        }

        public void Muzzle(float3 p, bool heavy, float3 direction = default)
        {
            var forward = math.normalizesafe(direction,new float3(0,0,1));
            Emit(p + forward * (heavy ? .025f : .008f),float3.zero,heavy ? .022f : .008f,0,heavy ? .07f : .045f,
                new float3(1,.79f,.37f),new float3(.85f,.24f,.035f),.95f,true,1.0f,0,0,Streak,forward * (heavy ? .15f : .055f));
            // smoke pass: the heavy-gun puff lives 1.1 s at .24 alpha (was 1.6 s at .35)
            if (heavy) Emit(p, new float3(0, 0.1f, 0), 0.09f, 0.4f, 1.1f, new float3(0.5f, 0.5f, 0.48f), new float3(0.62f, 0.62f, 0.6f), 0.24f, false, 0, 1f, 0.05f);
        }

        /// <summary>A tracer or shell streak flying from a to b.</summary>
        public void Tracer(float3 a, float3 b, bool heavy)
        {
            float3 d = b - a;
            float len = math.length(d);
            if (len < 0.05f) return;
            float speed = heavy ? 9f : 14f;
            var dir = d / len;
            Emit(a, dir * speed, heavy ? 0.012f : 0.006f, 0, len / speed, heavy ? new float3(1f, 0.75f, 0.4f) : new float3(1f, 0.9f, 0.55f), new float3(1f, 0.6f, 0.25f), 0.9f, true, 2.5f, 0, 0, Streak, dir * (heavy ? 0.18f : 0.12f));
        }

        /// <summary>Continuous fire on a burning building: flames, embers and a smoke column.</summary>
        public void Fire(float3 p, float size) => Fire(p, size, size < .2f);

        void Fire(float3 p, float size, bool vehicle)
        {
            // a burning vehicle (the game's wreck fires are the small ones) now and then cooks off rounds or fuel
            if (vehicle && R() < .006f) SecondaryExplosion(p);
            for (int k = 0; k < 3; k++)
            {
                var o = new float3(R() - 0.5f, 0, R() - 0.5f) * size;
                Emit(p + o, new float3(Wind.x * .035f, .045f + R() * .055f, Wind.z * .035f), size * (.24f + R() * .22f),
                    -.018f, .35f + R() * .38f, new float3(1, .91f, .72f), new float3(.78f, .42f, .16f), .82f, true, .16f, .5f, .015f, Flame);
            }
            if (R() < 0.6f)
            {
                var ev = new float3(R() - 0.5f, 1f + R(), R() - 0.5f) * 0.3f;
                Emit(p + new float3(R() - 0.5f, 0.1f, R() - 0.5f) * size, ev, 0.004f, 0, 1.2f + R(), new float3(1f, 0.6f, 0.2f), new float3(0.8f, 0.2f, 0.05f), 1f, true, 2f, 0.3f, 0.2f, Streak, default, true);
            }
            float g = R() * 0.06f;
            Emit(p + new float3(0, size * .7f, 0), Wind * .07f + new float3((R() - .5f) * .05f, .20f, (R() - .5f) * .05f),
                size * .42f, size * .55f, 2.3f + R() * 1.0f, new float3(.27f + g, .255f + g, .24f + g), new float3(.5f, .49f, .47f), .19f, false, 0, .35f, .055f);   // smoke pass: 2.3-3.3 s at .19 (was 3.3-4.7 s at .26)   // final pass: lighter again, many fires still stacked into black   // Review V: overlapping columns read as a black sheet at .08 / .46
        }

        /// <summary>
        /// A strategic warhead (scale 1) or a reactor (scale 0.5): blinding flash, fireball, a mushroom
        /// cloud that climbs and spreads, and shockwave rings racing across the ground.
        /// </summary>
        public void Strategic(float3 p, float scale)
        {
            Blast?.Invoke(p, scale * 6f);
            Flash = Mathf.Max(Flash, scale);
            Shake = Mathf.Max(Shake, 1.2f * scale);
            Emit(p + new float3(0, 0.5f * scale, 0), float3.zero, 3f * scale, 9f * scale, 0.5f, new float3(1f, 0.97f, 0.9f), new float3(1f, 0.7f, 0.4f), 1f, true, 4f);
            for (int k = 0; k < 18; k++)
            {
                var v = new float3(R() - 0.5f, 0.6f + R() * 0.5f, R() - 0.5f) * 1.6f * scale;
                Emit(p + new float3(0, 0.3f, 0), v, 0.9f * scale, 1.4f * scale, 1.6f + R(), new float3(1f, 0.7f, 0.3f), new float3(0.6f, 0.15f, 0.05f), 0.95f, true, 2.5f, 1.5f, 0.6f);
            }
            // The stem, cap and roll are simulated over half a minute (EffectsRenderer.Mushroom).
            MushroomCloud(p, scale);
            // effects pass (2026-11-18): the blast front follows the ground (EffectsRenderer.TerrainShock): it runs down
            // valleys, dies on mountain sides and weakens behind ridges, instead of a flat ring and a uniform dust spray.
            // A short flat ring stays for the first instant around ground zero.
            TerrainShock(p, scale);
            GroundShock(p, 5 * scale, .9f);
        }

        /// <summary>
        /// Working industry: a chimney's soot (dark, thin, drifting downwind) or a cooling tower's
        /// steam (white, billowing, short-lived). Called a few times a second per stack.
        /// </summary>
        public void Smoke(float3 p, float3 windMap, bool steam, float size)
        {
            // smoke pass (2026-11-17): steam 2.2-3.3 s at .38 (was 3-4.5 s at .5); soot 3.5-4.9 s at .24 and a
            // slower spread (was 5-7 s at .32): about half the haze over working industry and smouldering ruins
            float g = R() * 0.08f;
            if (steam)
                Emit(p + new float3(R() - 0.5f, 0, R() - 0.5f) * size * 0.4f, new float3(windMap.x * 0.25f, 0.35f + R() * 0.15f, windMap.z * 0.25f), size * 0.5f, size * 0.9f, 2.2f + R() * 1.1f,
                    new float3(0.92f, 0.92f, 0.9f), new float3(0.85f, 0.86f, 0.88f), 0.38f, false, 0, 0.6f, 0.05f);
            else
                Emit(p, new float3(windMap.x * 0.3f, 0.3f + R() * 0.1f, windMap.z * 0.3f), size * 0.25f, size * 0.55f, 3.5f + R() * 1.4f,
                    new float3(0.22f + g, 0.21f + g, 0.20f + g), new float3(0.46f, 0.45f, 0.44f), 0.24f, false, 0, 0.3f, 0.04f);
        }

        // ------------------------------------------------------------------ weather
        /// <summary>Rain around the camera: falling streaks and splashes on the ground.</summary>
        public void Rain(float3 focusMap, float intensity, float3 windMap, Func<float, float, float> ground, float radius)
        {
            int drops = (int)(intensity * 40 * Intensity);
            for (int k = 0; k < drops; k++)
            {
                float gx = focusMap.x + (R() - 0.5f) * 2 * radius, gz = focusMap.z + (R() - 0.5f) * 2 * radius;
                float gy = ground(gx, gz);
                var vel = new float3(windMap.x * 1.5f, -9f, windMap.z * 1.5f);
                float h = 1.2f + R() * radius * 0.4f;
                Emit(new float3(gx - vel.x * h / 9f, gy + h, gz - vel.z * h / 9f), vel, 0.004f + radius * 0.0002f, 0, h / 9f, new float3(0.75f, 0.8f, 0.85f), new float3(0.75f, 0.8f, 0.85f), 0.35f, false, 0, 0, 0, Streak, vel * 0.03f);
                if (R() < 0.3f) Emit(new float3(gx, gy + 0.01f, gz), float3.zero, 0.01f, 0.12f, 0.25f, new float3(0.8f, 0.85f, 0.9f), new float3(0.8f, 0.85f, 0.9f), 0.3f, false, 0, 0, 0, Ring);
            }
        }

        // ------------------------------------------------------------------ persistent marks
        public void Crater(float3 p, float size)
        {
            var d = InstanceData.TRS(MapSpace.W(p) + new float3(0, 0.006f, 0), R() * 6.28f, new float3(size, 1, size * (0.8f + R() * 0.4f)) * MarkScale, MarkColor(new float3(0.27f, 0.22f, 0.16f), .7f));   // turned earth, not a black blob
            craters.Add(d, markClock);
        }

        public void Wreck(float3 p, float yaw, float scale)
        {
            var d = InstanceData.TRS(MapSpace.W(p), MapSpace.Yaw(yaw), new float3(scale), new float4(0.34f, 0.32f, 0.29f, 0));
            wrecks.Add(d, markClock);
            for (int k = 0; k < 2; k++) Emit(p, new float3(0, 0.15f, 0), 0.1f, 0.4f, 4.5f, new float3(0.2f, 0.19f, 0.18f), new float3(0.4f, 0.39f, 0.37f), 0.45f, false, 0, 0.4f, 0.06f);
            Scorch(p, scale * 1.3f);
            AddEmitter(p + new float3(0, .04f, 0), .15f, 30f + R() * 20f, EmitterWreck);
        }

        public void ClearPersistent()
        {
            craters.Clear(); wrecks.Clear(); ClearDecals(); missileBodies?.Clear(); missileBodies?.MarkDirty();
            ClearDestruction();
            count = flightCount = waveCount = waveVertexCount = 0;
            mushroomCount = distortionCount = 0;
            ClearTerrainShocks();
            Flash = Shake = 0;
            addCount = alphaCount = 0;
            for (int i = 0; i < flashLights.Length; i++) { flashLife[i] = 0; if (flashLights[i] != null) flashLights[i].enabled = false; }
        }

        public void Update(float dt, float camX, float period, bool wrap, float simulationRate = 1f)
        {
            UpdateFlights(dt * simulationRate);
            UpdateDestruction(dt * simulationRate);
            UpdateGroundWaves(dt * simulationRate);
            UpdateTerrainShocks(dt * simulationRate);
            markClock += Mathf.Max(0f, dt * simulationRate);
            craters.Refresh(markClock); wrecks.Refresh(markClock); rubble.Refresh(markClock); RefreshDecals(markClock);
            for (int i = 0; i < flashLights.Length; i++) if (flashLights[i] != null && flashLife[i] > 0)
            { flashLife[i] -= dt; flashLights[i].intensity *= math.exp(-dt * 22); if (flashLife[i] <= 0) flashLights[i].enabled = false; }
            addCount = alphaCount = 0;
            Shake = Mathf.Max(0, Shake - dt * 1.6f);
            Flash = Mathf.Max(0, Flash - dt * 1.2f);
            for (int i = 0; i < count; i++)
            {
                ref var p = ref pool[i];
                p.Life += dt;
                if (p.Life >= p.Max) { pool[i] = pool[--count]; i--; continue; }
                float t = p.Life / p.Max;
                p.Vel *= Mathf.Max(0, 1 - p.Drag * dt);
                if (p.Kind == Puff && !p.Additive && p.Rise >= 0)
                {
                    // smoke behaves like a plume: wind shear carries the higher, older smoke faster, and slow
                    // eddies (a cheap curl of the particle seed and age) make neighbouring puffs roll apart
                    p.Vel += MapSpace.W(Wind) * (dt * (.035f + math.saturate(p.Life * .12f) * .06f));
                    float e = p.Seed + p.Life * .9f;
                    p.Vel += new float3(math.sin(e * 1.7f), math.sin(e * 1.3f + 1) * .4f, math.cos(e * 1.1f)) * (dt * p.Size * .35f);
                }
                p.Vel.y += p.Rise * dt * (p.Kind == Puff && !p.Additive && p.Rise > 0 ? 1 - t : 1);   // buoyancy fades as the smoke cools; gravity does not
                p.Pos += p.Vel * dt;
                if (p.Bounce && p.Pos.y < p.Floor)
                {
                    // debris strikes the ground: a dull bounce, skids, then lies still until it fades
                    p.Pos.y = p.Floor;
                    if (p.Vel.y < -.12f) { p.Vel.y *= -.22f; p.Vel.x *= .4f; p.Vel.z *= .4f; p.Spin *= .4f; }
                    else { p.Vel = float3.zero; p.Rise = 0; p.Spin = 0; p.Bounce = false; }
                }
                p.Size = Mathf.Max(0.002f, p.Size + p.Grow * dt * (p.Kind == Puff ? 1.7f - 1.4f * t : 1));   // billows spread fast, then slowly
                if (p.Kind == Puff) p.Rot += p.Spin * dt * (1 - t * .8f);
                float fade = p.Kind == Ring ? 1f - t : t < .1f ? t / .1f : 1f - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.4f, 1f, t));
                float x = wrap ? HexMath.NearX(p.Pos.x, camX, period, true) : p.Pos.x;
                float3 stretch = p.StretchWithVelocity ? p.Vel * 0.04f : p.Stretch;
                var g = new ParticleGpu
                {
                    Position = new float4(x, p.Pos.y, p.Pos.z, p.Size),
                    Color = new float4(math.lerp(p.Color0, p.Color1, t), p.Alpha * fade),
                    Shape = new float4(p.Rot, p.Additive ? 0.25f : 0.55f, p.Seed, p.Heat * (1 - t)),
                    Extra = new float4(stretch, p.Kind),
                };
                if (p.Additive) addData[addCount++] = g; else alphaData[alphaCount++] = g;
            }
            UpdateMushrooms(dt * simulationRate, camX, period, wrap);
            UpdateDistortions(dt);
        }

        void Upload(GraphicsBuffer[] ring, NativeArray<ParticleGpu> data, int n, MaterialPropertyBlock block)
        {
            ref var buffer = ref ring[frameSlot];
            if (buffer == null) buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Budget, Marshal.SizeOf<ParticleGpu>());
            if (n > 0) buffer.SetData(data, 0, 0, n);
            block.SetBuffer(ParticlesId, buffer);
            block.SetVector(ImageOffsetId, Vector4.zero);
        }

        public void Draw(WrapImages images)
        {
            craters.Draw(images);
            DrawDecals(images);
            wrecks.Draw(images);
            rubble.Draw(images);
            DrawGroundWaves(images);
            DrawTerrainShocks(images);
            DrawDistortions(images);
            missileBodies?.DrawImages(images);
            var bounds = new Bounds(Vector3.zero, Vector3.one * 1e5f);
            frameSlot = (frameSlot + 1) % 3;
            if (alphaCount > 0)
            {
                Upload(alphaBuffers, alphaData, alphaCount, alphaBlock);
                Graphics.RenderMeshPrimitives(new RenderParams(RenderResources.AlphaBlend) { worldBounds = bounds, matProps = alphaBlock, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, MeshKit.Quad, 0, alphaCount);
            }
            if (addCount > 0)
            {
                Upload(addBuffers, addData, addCount, addBlock);
                Graphics.RenderMeshPrimitives(new RenderParams(RenderResources.Additive) { worldBounds = bounds, matProps = addBlock, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, MeshKit.Quad, 0, addCount);
            }
        }

        public void Dispose()
        {
            foreach (var b in addBuffers) b?.Release();
            foreach (var b in alphaBuffers) b?.Release();
            if (addData.IsCreated) addData.Dispose();
            if (alphaData.IsCreated) alphaData.Dispose();
            craters.Dispose(); if (craterMaterial != null) UnityEngine.Object.Destroy(craterMaterial); if (craterTexture != null) UnityEngine.Object.Destroy(craterTexture); if (craterQuad != null) UnityEngine.Object.Destroy(craterQuad); wrecks.Dispose(); rubble.Dispose(); DisposeDecals(); DisposeDistortions();
            missileBodies?.Dispose(); DisposeTerrainShocks();
            if (waveMesh != null) UnityEngine.Object.Destroy(waveMesh);
            if (waveMaterial != null) UnityEngine.Object.Destroy(waveMaterial);
            if (lightRoot != null) UnityEngine.Object.Destroy(lightRoot);
        }
    }
}
