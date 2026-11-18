using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// The height-sensitive, volumetric ground shock of a strategic burst (effects pass, 2026-11-18).
    ///
    /// Propagation is the server's (server/sim/shockwave.js, same constants): <see cref="ShockRays"/> rays are
    /// marched once per blast over the terrain height field (<see cref="GroundAt"/>). Each carries energy that
    /// level ground spends with distance, climbing spends fast and descending refunds a little; a first pass
    /// measures how much of the front the terrain blocks and pushes that share into the open directions. So in a
    /// valley the front runs far both ways along the floor and dies a short way up the walls; on open ground it
    /// spreads evenly; behind a ridge it is weak. The server decides which forest falls; this draws it.
    ///
    /// Drawing (bounded): per live shock a ground-hugging bright band, a dust wall whose height follows the energy
    /// left on each ray and a taller, fainter billow behind it, all in one pooled mesh (one draw per wrap image),
    /// plus dust puffs from the particle pool along the front (half the rays per emission tick, ~400 a second).
    /// No allocation after the first blast.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        // server/sim/shockwave.js SHOCK
        public const int ShockRays = 48;
        public const float ShockStep = .5f, ShockReach = 16f, ShockUp = .45f, ShockDown = .12f, ShockChannel = .8f, ShockBoost = 1.7f, ShockCore = 4.5f;
        const int ShockSteps = 55;   // ceil(ShockReach * ShockBoost / ShockStep), the same at every scale
        const int ShockLimit = 4, ShockLayers = 3;

        struct TerrainShockFront { public float3 Point; public float Age, Duration, Scale, E0, Emit, Far; public bool Drawn; }
        readonly TerrainShockFront[] shocks = new TerrainShockFront[ShockLimit];
        readonly bool[] shockLive = new bool[ShockLimit];
        readonly float[] shockEnergy = new float[ShockLimit * ShockRays * ShockSteps];
        readonly float[] shockReach = new float[ShockLimit * ShockRays];
        readonly float[] shockScratch = new float[ShockRays * ShockSteps];
        readonly float[] rayCos = new float[ShockRays], raySin = new float[ShockRays];
        // per frame, per ray of the shock being built: front point (map) and the energy there
        readonly float3[] frontPoint = new float3[ShockRays];
        readonly float[] frontEnergy = new float[ShockRays];
        readonly Vector3[] shockVertices = new Vector3[ShockLimit * ShockRays * ShockLayers * 4];
        readonly Color[] shockColors = new Color[ShockLimit * ShockRays * ShockLayers * 4];
        readonly Vector2[] shockUV = new Vector2[ShockLimit * ShockRays * ShockLayers * 4];
        readonly int[] shockIndices = new int[ShockLimit * ShockRays * ShockLayers * 6];
        readonly MaterialPropertyBlock shockBlock = new MaterialPropertyBlock();
        Mesh shockMesh;
        Material shockMaterial;
        int shockVertexCount, shockTick;

        /// <summary>The slot of the most recent strategic shock (for <see cref="ShockFallChance"/>), or -1.</summary>
        public int LastShock { get; private set; } = -1;

        float GroundOrSea(float x, float z) => GroundAt != null ? math.max(0f, GroundAt(x, z)) : 0f;

        /// <summary>Start a terrain shock at map point p (scale 1: a warhead, .5: a reactor). Returns its slot.</summary>
        public int TerrainShock(float3 p, float scale)
        {
            if (rayCos[1] == 0)
                for (int i = 0; i < ShockRays; i++) { float a = i * 2 * math.PI / ShockRays; rayCos[i] = math.cos(a); raySin[i] = math.sin(a); }
            int slot = -1;
            for (int i = 0; i < ShockLimit; i++) if (!shockLive[i]) { slot = i; break; }
            if (slot < 0) { slot = 0; for (int i = 1; i < ShockLimit; i++) if (shocks[i].Age > shocks[slot].Age) slot = i; }   // replace the oldest
            ComputeShock(slot, p, scale, out float e0, out float far);
            shocks[slot] = new TerrainShockFront { Point = p, Scale = scale, E0 = e0, Far = far, Duration = 4.5f + 2f * scale, Drawn = Intensity >= .25f };
            shockLive[slot] = true;
            LastShock = slot;
            return slot;
        }

        void March(float[] energy, int offset, float x0, float z0, float scale, float e0)
        {
            float step = ShockStep * scale, reach = ShockReach * scale;
            float h0 = GroundOrSea(x0, z0);
            for (int i = 0; i < ShockRays; i++)
            {
                float e = e0, h = h0;
                int row = offset + i * ShockSteps;
                for (int k = 0; k < ShockSteps; k++)
                {
                    float d = (k + 1) * step;
                    float hn = GroundOrSea(x0 + rayCos[i] * d, z0 + raySin[i] * d);
                    float dh = hn - h; h = hn;
                    e -= step / reach;
                    if (dh > 0) e -= ShockUp * dh / scale; else e = math.min(e0, e - ShockDown * dh / scale);
                    if (e <= 0) { for (int j = k; j < ShockSteps; j++) energy[row + j] = 0; break; }
                    energy[row + k] = e;
                }
            }
        }

        void ComputeShock(int slot, float3 p, float scale, out float e0, out float far)
        {
            float step = ShockStep * scale, reach = ShockReach * scale;
            // pass 1: how much of the front the terrain blocks (reach capped at the open-ground reach)
            March(shockScratch, 0, p.x, p.z, scale, 1f);
            float open = 0;
            for (int i = 0; i < ShockRays; i++)
            {
                int last = -1;
                for (int k = 0; k < ShockSteps; k++) if (shockScratch[i * ShockSteps + k] > 0) last = k; else break;
                open += math.min((last + 1) * step, reach) / reach;
            }
            e0 = math.min(ShockBoost, 1f + ShockChannel * (1f - open / ShockRays));
            // pass 2 with the channelled energy, then one 1-2-1 smoothing across neighbouring rays
            March(shockScratch, 0, p.x, p.z, scale, e0);
            int baseE = slot * ShockRays * ShockSteps;
            far = 0;
            for (int i = 0; i < ShockRays; i++)
            {
                int l = (i + ShockRays - 1) % ShockRays, r = (i + 1) % ShockRays, last = -1;
                for (int k = 0; k < ShockSteps; k++)
                {
                    float v = shockScratch[l * ShockSteps + k] * .25f + shockScratch[i * ShockSteps + k] * .5f + shockScratch[r * ShockSteps + k] * .25f;
                    shockEnergy[baseE + i * ShockSteps + k] = v;
                    if (v > 0) last = k;
                }
                shockReach[slot * ShockRays + i] = (last + 1) * step;
                far = math.max(far, (last + 1) * step);
            }
        }

        /// <summary>Energy the shock in slot carries at distance d along ray i (fractional ray index allowed).</summary>
        float ShockEnergyAt(int slot, float ray, float d)
        {
            ref var s = ref shocks[slot];
            float step = ShockStep * s.Scale;
            if (d <= step) return s.E0;
            float f = ray - math.floor(ray / ShockRays) * ShockRays;
            int i0 = (int)f % ShockRays, i1 = (i0 + 1) % ShockRays;
            float fr = f - math.floor(f), g = d / step - 1;
            int k0 = (int)g;
            if (k0 >= ShockSteps - 1) return 0;
            float kr = g - k0;
            int b = slot * ShockRays * ShockSteps;
            float a0 = math.lerp(shockEnergy[b + i0 * ShockSteps + k0], shockEnergy[b + i0 * ShockSteps + k0 + 1], kr);
            float a1 = math.lerp(shockEnergy[b + i1 * ShockSteps + k0], shockEnergy[b + i1 * ShockSteps + k0 + 1], kr);
            return math.lerp(a0, a1, fr);
        }

        /// <summary>
        /// Chance a tree at map (x, z) is knocked down by the shock in slot: 1 inside the core, then rising with the
        /// energy the front still carries there (the client's mirror of shockwave.js blastForest, for the sparse trees
        /// the server does not track). dx must already be wrap-corrected relative to the burst.
        /// </summary>
        public float ShockFallChance(int slot, float dx, float dz)
        {
            if (slot < 0 || slot >= ShockLimit) return 0;
            ref var s = ref shocks[slot];
            float d = math.sqrt(dx * dx + dz * dz);
            if (d <= ShockCore * s.Scale) return 1;
            if (d > s.Far) return 0;
            float angle = math.atan2(dz, dx);
            return math.smoothstep(.05f, .5f, ShockEnergyAt(slot, angle / (2 * math.PI) * ShockRays, d));
        }

        /// <summary>Burst point and farthest reach of the shock in slot (map units).</summary>
        public float3 ShockPoint(int slot) => shocks[math.clamp(slot, 0, ShockLimit - 1)].Point;
        public float ShockFar(int slot) => shocks[math.clamp(slot, 0, ShockLimit - 1)].Far;

        void UpdateTerrainShocks(float dt)
        {
            shockVertexCount = 0;
            bool any = false;
            for (int i = 0; i < ShockLimit; i++) any |= shockLive[i];
            if (!any) return;
            if (shockMesh == null)
            {
                shockMesh = new Mesh { name = "Pooled terrain shock fronts" }; shockMesh.MarkDynamic();
                shockMaterial = new Material(Resources.Load<Shader>("Shaders/GroundWave")) { name = "SE terrain shock" };
                for (int k = 0; k < shockIndices.Length / 6; k++)
                {
                    int v = k * 4, t = k * 6;
                    shockIndices[t] = v; shockIndices[t + 1] = v + 1; shockIndices[t + 2] = v + 2;
                    shockIndices[t + 3] = v; shockIndices[t + 4] = v + 2; shockIndices[t + 5] = v + 3;
                    shockUV[v] = new Vector2(0, 0); shockUV[v + 1] = new Vector2(1, 0); shockUV[v + 2] = new Vector2(1, 1); shockUV[v + 3] = new Vector2(0, 1);
                }
            }
            shockTick++;
            for (int slot = 0; slot < ShockLimit; slot++)
            {
                if (!shockLive[slot]) continue;
                ref var s = ref shocks[slot];
                float before = s.Far * math.sqrt(math.saturate(s.Age / s.Duration));
                s.Age += dt;
                if (s.Age >= s.Duration) { shockLive[slot] = false; continue; }
                if (!s.Drawn) continue;
                float t = s.Age / s.Duration;
                float radius = s.Far * math.sqrt(t), speed = dt > 0 ? (radius - before) / dt : 0;
                float fade = math.saturate(t * 10f) * (1f - math.smoothstep(.75f, 1f, t)) * Intensity;
                float wall = 1.15f * s.Scale, band = .12f + .25f * s.Scale;
                for (int i = 0; i < ShockRays; i++)
                {
                    float r = math.min(radius, shockReach[slot * ShockRays + i]);
                    float e = r < radius ? 0 : ShockEnergyAt(slot, i, radius);
                    float x = s.Point.x + rayCos[i] * r, z = s.Point.z + raySin[i] * r;
                    frontPoint[i] = new float3(x, GroundOrSea(x, z), z);
                    frontEnergy[i] = math.saturate(e);
                }
                // three layers per segment: the bright ground band, the dust wall on the front, the billow behind it
                for (int i = 0; i < ShockRays; i++)
                {
                    int j = (i + 1) % ShockRays;
                    float ea = frontEnergy[i], eb = frontEnergy[j];
                    if (ea <= .01f && eb <= .01f) continue;
                    float3 pa = frontPoint[i], pb = frontPoint[j];
                    var oa = new float3(rayCos[i], 0, raySin[i]); var ob = new float3(rayCos[j], 0, raySin[j]);
                    Quad(pa - oa * band + new float3(0, .02f, 0), pb - ob * band + new float3(0, .02f, 0), pb + ob * band * .5f + new float3(0, .02f, 0), pa + oa * band * .5f + new float3(0, .02f, 0),
                        new Color(.86f, .82f, .74f, .55f * fade * ea), new Color(.86f, .82f, .74f, .55f * fade * eb));
                    Quad(pa - new float3(0, .05f, 0), pb - new float3(0, .05f, 0), pb + new float3(0, wall * eb, 0) - ob * wall * .25f * eb, pa + new float3(0, wall * ea, 0) - oa * wall * .25f * ea,
                        new Color(.70f, .64f, .55f, .62f * fade * ea), new Color(.70f, .64f, .55f, .62f * fade * eb));
                    float3 ba = pa - oa * wall * .9f, bb = pb - ob * wall * .9f;
                    ba.y = math.max(ba.y, pa.y - .2f); bb.y = math.max(bb.y, pb.y - .2f);
                    Quad(ba, bb, bb + new float3(0, wall * 2f * eb, 0) - ob * wall * .6f * eb, ba + new float3(0, wall * 2f * ea, 0) - oa * wall * .6f * ea,
                        new Color(.66f, .62f, .56f, .26f * fade * ea), new Color(.66f, .62f, .56f, .26f * fade * eb));
                }
                // dust rolling along the front: half the rays per tick, more where the front is strong
                s.Emit += dt;
                if (s.Emit >= .06f && Intensity >= .4f)
                {
                    s.Emit = 0;
                    for (int i = shockTick & 1; i < ShockRays; i += 2)
                    {
                        float e = frontEnergy[i];
                        if (e < .04f) continue;
                        var o = new float3(rayCos[i], 0, raySin[i]);
                        float g = R() * .06f;
                        Emit(frontPoint[i] + new float3(0, .06f * s.Scale, 0) - o * R() * .3f * s.Scale,
                            o * (speed * (.25f + R() * .15f)) + new float3(0, .12f + R() * .15f, 0) * s.Scale,
                            (.22f + .3f * e) * s.Scale, .45f * s.Scale, 2.0f + R() * 1.4f,
                            new float3(.55f + g, .50f + g, .42f + g), new float3(.66f, .63f, .58f), .42f * math.min(1f, e * 1.4f), false, 0, 1.3f, .03f);
                        // the condensation flash in the first moments: a pale ring over the front
                        if (t < .2f && (i & 3) == 0)
                            Emit(frontPoint[i] + new float3(0, .5f * s.Scale, 0), o * speed * .4f, .5f * s.Scale, .6f * s.Scale, .9f,
                                new float3(.95f, .95f, .96f), new float3(.85f, .86f, .88f), .30f * e, false, 0, 1.6f, 0);
                    }
                }
            }
            if (shockVertexCount == 0) return;
            shockMesh.Clear(false);
            shockMesh.SetVertices(shockVertices, 0, shockVertexCount); shockMesh.SetColors(shockColors, 0, shockVertexCount);
            shockMesh.SetUVs(0, shockUV, 0, shockVertexCount); shockMesh.SetIndices(shockIndices, 0, shockVertexCount / 4 * 6, MeshTopology.Triangles, 0, true);
        }

        /// <summary>One quad (map points, bottom a-b, top b-a) into the shock mesh: colours at the a and b edges.</summary>
        void Quad(float3 a0, float3 b0, float3 b1, float3 a1, Color ca, Color cb)
        {
            int v = shockVertexCount;
            if (v + 4 > shockVertices.Length) return;
            shockVertices[v] = MapSpace.W(a0); shockVertices[v + 1] = MapSpace.W(b0); shockVertices[v + 2] = MapSpace.W(b1); shockVertices[v + 3] = MapSpace.W(a1);
            shockColors[v] = ca; shockColors[v + 1] = cb; shockColors[v + 2] = cb; shockColors[v + 3] = ca;
            shockVertexCount += 4;
        }

        void DrawTerrainShocks(WrapImages images)
        {
            if (shockVertexCount == 0 || shockMesh == null) return;
            int n = images.For(shockMesh.bounds, out float a, out float b, out float c);
            void Draw(float shift)
            {
                shockBlock.SetVector(ImageOffsetId, new Vector4(shift, 0, 0, 0));
                var bounds = shockMesh.bounds; bounds.center += new Vector3(shift, 0, 0);
                Graphics.RenderMeshPrimitives(new RenderParams(shockMaterial) { worldBounds = bounds, matProps = shockBlock,
                    shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, shockMesh, 0, 1);
            }
            if (n > 0) Draw(a); if (n > 1) Draw(b); if (n > 2) Draw(c);
        }

        void ClearTerrainShocks()
        {
            for (int i = 0; i < ShockLimit; i++) shockLive[i] = false;
            shockVertexCount = 0; LastShock = -1;
        }

        void DisposeTerrainShocks()
        {
            if (shockMesh != null) Object.Destroy(shockMesh);
            if (shockMaterial != null) Object.Destroy(shockMaterial);
        }
    }
}
