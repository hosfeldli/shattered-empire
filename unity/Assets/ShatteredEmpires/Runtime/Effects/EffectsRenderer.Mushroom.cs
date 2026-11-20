using SE.Core.World;
using SE.Runtime.Rendering;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Effects
{
    /// <summary>
    /// A simulated mushroom cloud (strategic strikes, reactor failures), evolving over most of a minute.
    ///
    /// 2026-11-19 (user: "the smoke should not be so dotted, it should be a solid plume"): the stem, cap and base
    /// surge are no longer ~190 separate soft puffs (each lit as its own ball, so the cloud read as dots) but one
    /// continuous volume: a lathe mesh rebuilt each frame from the cloud's profile and drawn with SE/NukePlume
    /// (one draw, two passes, per wrap image), which billows it with advected 3D noise, bump-lights it, glows it
    /// from the fireball inside and erodes it into wisps as it dies. The profile:
    ///  · the cap is a torus that climbs fast, then slows and spreads (its rolling circulation is the noise
    ///    flowing out over the top and down the rim), domed over the middle so the volume stays closed;
    ///  · the stem rises out of a flared foot, narrows and leans downwind as the cloud drifts;
    ///  · a low ground surge rolls outward to about the blast radius and settles;
    ///  · early on everything is lit from within (orange fire under soot), cooling to brown-grey.
    /// Particles remain only for what is not a solid: the brief white condensation collar (a dense, overlapping
    /// ring) and the firestorm flames around the base. No allocation after the first cloud.
    /// </summary>
    public sealed partial class EffectsRenderer
    {
        sealed class Mushroom { public float3 Base; public float Scale, Age, Seed; public float3 Drift; }
        const int MushroomLimit = 4;
        const float MushroomLife = 46f;
        // lathe resolution: around the axis, points along the stem + cap profile, points along the surge profile
        const int PlumeAround = 56, PlumeMain = 44, PlumeSurge = 14, PlumeRows = PlumeMain + PlumeSurge;
        const int PlumeVerts = PlumeAround * PlumeRows, PlumeQuads = PlumeAround * (PlumeMain - 1 + PlumeSurge - 1);
        readonly Mushroom[] mushrooms = new Mushroom[MushroomLimit];
        int mushroomCount;

        Mesh plumeMesh;
        Material plumeMaterial;
        readonly MaterialPropertyBlock plumeBlock = new MaterialPropertyBlock();
        Vector3[] plumeVertices, plumeNormals;
        Vector4[] plumeTangents, plumeData, plumeBase;
        Color[] plumeColors;
        int[] plumeIndices;
        int plumeLive;
        Bounds plumeBounds;
        // per frame scratch: the key points of a profile and the sampled profile (radius, height, attributes)
        readonly float2[] plumeKeys = new float2[10];
        readonly float4[] plumeKeyAttr = new float4[10];       // heat, alpha, billow amplitude, flow speed
        readonly float2[] profilePoint = new float2[PlumeMain];
        readonly float2[] profileTangent = new float2[PlumeMain];
        readonly float4[] profileAttr = new float4[PlumeMain];
        readonly float[] ringCos = new float[PlumeAround], ringSin = new float[PlumeAround], ringGround = new float[PlumeAround];

        /// <summary>Start a rolling mushroom cloud at a map position (scale 1 = the old 2.7-radius warhead's size).</summary>
        public void MushroomCloud(float3 mapPos, float scale)
        {
            if (mushroomCount >= MushroomLimit) { for (int i = 1; i < mushroomCount; i++) mushrooms[i - 1] = mushrooms[i]; mushroomCount--; }
            mushrooms[mushroomCount++] = new Mushroom { Base = MapSpace.W(mapPos), Scale = scale, Seed = R() * 100f };
            Distortion(mapPos, 24f * scale, 3.2f, 1f);
        }

        void UpdateMushrooms(float dt, float camX, float period, bool wrap)
        {
            var wind = MapSpace.W(Wind);
            plumeLive = 0;
            float3 lo = new float3(float.MaxValue), hi = new float3(float.MinValue);
            for (int m = 0; m < mushroomCount; m++)
            {
                var c = mushrooms[m];
                c.Age += dt;
                if (c.Age >= MushroomLife) { mushrooms[m--] = mushrooms[--mushroomCount]; continue; }
                c.Drift += new float3(wind.x, 0, wind.z) * dt * .05f * math.saturate(c.Age / 8f);
                float t = c.Age, s = c.Scale;
                float grow = 1 - math.exp(-t / 4.5f), spread = 1 - math.exp(-t / 7f);
                float height = s * (.7f + 3.6f * grow);                       // cap centre above the ground
                float fade = 1 - math.smoothstep(MushroomLife * .6f, MushroomLife, t);
                BuildPlume(plumeLive++, c, t, s, grow, spread, height, fade, ref lo, ref hi);
                // --- condensation collar: a white ring flashing outward at mid-height between 0.6 s and 3.2 s.
                // Dense and overlapping (every blob wider than the gap to the next), so it reads as one band.
                if (t > .6f && t < 3.2f)
                {
                    float k = (t - .6f) / 2.6f, ringR = s * (1.2f + 4f * k);
                    const int collar = 72;
                    float size = math.max(s * .4f, ringR * 6.283f / collar * 2.4f);
                    for (int i = 0; i < collar; i++)
                    {
                        float a = i * 6.283f / collar;
                        var p = c.Base + c.Drift * .6f + new float3(math.cos(a) * ringR, height * .62f, math.sin(a) * ringR);
                        WriteBlob(p, size, new float3(.95f, .96f, .97f), .22f * (1 - k), a, i, 0, camX, period, wrap);
                    }
                }
                // --- firestorm around the base (pooled flame particles, rate limited)
                if (t < 26f && Intensity > .2f && R() < .7f)
                {
                    float a = R() * 6.283f, d = s * (.4f + R() * 2.8f) * math.saturate(t / 4f + .2f);
                    var wp = c.Base + new float3(math.cos(a) * d, 0, math.sin(a) * d);
                    var map = new float3(wp.x, wp.y, -wp.z);
                    if (GroundAt != null) map.y = GroundAt(map.x, map.z);
                    Fire(map, (.25f + R() * .25f) * s * math.saturate(1.2f - t / 26f));
                }
                mushrooms[m] = c;
            }
            if (plumeLive == 0 || plumeMesh == null) return;
            plumeMesh.Clear(false);
            int n = plumeLive * PlumeVerts;
            plumeMesh.SetVertices(plumeVertices, 0, n);
            plumeMesh.SetNormals(plumeNormals, 0, n);
            plumeMesh.SetTangents(plumeTangents, 0, n);
            plumeMesh.SetColors(plumeColors, 0, n);
            plumeMesh.SetUVs(0, plumeData, 0, n);
            plumeMesh.SetUVs(1, plumeBase, 0, n);
            plumeMesh.SetIndices(plumeIndices, 0, plumeLive * PlumeQuads * 6, MeshTopology.Triangles, 0, false);
            plumeBounds = new Bounds((Vector3)((lo + hi) * .5f), (Vector3)(hi - lo + 2f));   // + the billows' reach
            plumeMesh.bounds = plumeBounds;
        }

        void EnsurePlume()
        {
            if (plumeMesh != null) return;
            plumeMesh = new Mesh { name = "Mushroom cloud volumes", indexFormat = IndexFormat.UInt32 };
            plumeMesh.MarkDynamic();
            var shader = Resources.Load<Shader>("Shaders/NukePlume");
            if (shader == null) Debug.LogError("Shattered Empires: missing shader Shaders/NukePlume");
            plumeMaterial = new Material(shader != null ? shader : Shader.Find("Universal Render Pipeline/Unlit")) { name = "SE mushroom cloud" };
            int verts = PlumeVerts * MushroomLimit;
            plumeVertices = new Vector3[verts]; plumeNormals = new Vector3[verts];
            plumeTangents = new Vector4[verts]; plumeData = new Vector4[verts]; plumeBase = new Vector4[verts];
            plumeColors = new Color[verts];
            plumeIndices = new int[PlumeQuads * 6 * MushroomLimit];
            for (int j = 0; j < PlumeAround; j++) { float a = j * 2 * math.PI / PlumeAround; ringCos[j] = math.cos(a); ringSin[j] = math.sin(a); }
            int q = 0;
            for (int m = 0; m < MushroomLimit; m++)
            {
                int block = m * PlumeVerts;
                for (int row = 0; row < PlumeRows - 1; row++)
                {
                    if (row == PlumeMain - 1) continue;   // the main profile and the surge are separate sheets
                    for (int j = 0; j < PlumeAround; j++)
                    {
                        int j1 = (j + 1) % PlumeAround;
                        int a = block + row * PlumeAround + j, b = block + row * PlumeAround + j1;
                        int c = block + (row + 1) * PlumeAround + j1, d = block + (row + 1) * PlumeAround + j;
                        plumeIndices[q++] = a; plumeIndices[q++] = d; plumeIndices[q++] = c;
                        plumeIndices[q++] = a; plumeIndices[q++] = c; plumeIndices[q++] = b;
                    }
                }
            }
        }

        /// <summary>Catmull-Rom through the key points (k of them) sampled at `count` points, attributes linear.</summary>
        void SampleProfile(int k, int count)
        {
            for (int i = 0; i < count; i++)
            {
                float u = i / (float)(count - 1) * (k - 1);
                int seg = math.min((int)u, k - 2);
                float f = u - seg;
                float2 p0 = plumeKeys[math.max(seg - 1, 0)], p1 = plumeKeys[seg], p2 = plumeKeys[seg + 1], p3 = plumeKeys[math.min(seg + 2, k - 1)];
                float f2 = f * f, f3 = f2 * f;
                profilePoint[i] = .5f * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (3 * p1 - p0 - 3 * p2 + p3) * f3);
                float2 d = .5f * ((p2 - p0) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (3 * p1 - p0 - 3 * p2 + p3) * f2);
                profileTangent[i] = math.lengthsq(d) > 1e-10f ? math.normalize(d) : new float2(0, 1);
                profileAttr[i] = math.lerp(plumeKeyAttr[seg], plumeKeyAttr[seg + 1], f);
            }
        }

        void BuildPlume(int slot, Mushroom c, float t, float s, float grow, float spread, float height, float fade, ref float3 lo, ref float3 hi)
        {
            EnsurePlume();
            float major = s * (.45f + 1.55f * spread);                    // ring radius of the cap torus
            float minor = s * (.38f + .62f * spread);                     // its tube radius
            float heat = math.saturate(1.25f - t / 9f);                   // inner fire, fading
            float flash = math.saturate(1 - t / 1.6f);                    // the white-hot fireball of the first moments
            float stem = math.saturate(t / 2.5f);                         // the stem forms as the fireball lifts off
            float topR = s * (.26f + .14f * spread) * stem, footR = s * (.5f + .55f * spread) * stem;
            float erode = math.smoothstep(MushroomLife * .5f, MushroomLife, t) * .8f;
            float freq = 1.5f / s, roll = .07f * s;
            float3 smokeDark = math.lerp(new float3(.30f, .27f, .24f), new float3(.50f, .47f, .43f), spread * .7f);
            float3 dust = new float3(.47f, .41f, .34f);
            float capAlpha = .97f * fade, stemAlpha = .93f * fade * math.saturate(t * 1.5f);
            float capHeat = heat * .9f + flash * 2.2f;
            // ---- the stem and cap: one profile from the flared foot up the stem, out under the cap, round the
            // rim and over the dome to the axis. attr: heat, alpha, billow amplitude, flow speed (+ along the profile)
            int k = 0;
            void Key(float r, float y, float h, float a, float amp, float flow) { plumeKeys[k] = new float2(r, y); plumeKeyAttr[k++] = new float4(h, a, amp, flow); }
            float capBase = height - minor * .85f;
            Key(footR * 1.3f, -.06f * s, heat * .5f, stemAlpha * .55f, footR * .3f, roll);
            Key(footR * .8f, capBase * .14f, heat * .45f, stemAlpha, footR * .3f, roll * 1.4f);
            Key(math.lerp(footR, topR, .65f), capBase * .5f, heat * .35f, stemAlpha, topR * .45f, roll * 1.6f);
            Key(topR, capBase, heat * .5f + flash, stemAlpha, topR * .5f, roll);
            Key(major * .6f, height - minor * .95f, capHeat * 1.25f, capAlpha, minor * .3f, -roll);
            Key(major + minor * .72f, height - minor * .6f, capHeat * 1.1f, capAlpha, minor * .34f, -roll);
            Key(major + minor, height, capHeat * .7f, capAlpha, minor * .34f, -roll);
            Key(major + minor * .6f, height + minor * .78f, capHeat * .35f, capAlpha, minor * .32f, -roll);
            Key(major * .45f, height + minor * .97f, capHeat * .3f, capAlpha, minor * .28f, -roll);
            Key(0, height + minor * .9f, capHeat * .3f, capAlpha, minor * .2f, -roll);
            SampleProfile(k, PlumeMain);
            int block = slot * PlumeVerts;
            float topY = height + minor;
            for (int i = 0; i < PlumeMain; i++)
            {
                float2 pt = profilePoint[i], tg = profileTangent[i];
                var at = profileAttr[i];
                float lean = math.saturate(pt.y / math.max(topY, .01f));
                float3 centre = c.Base + c.Drift * lean;
                bool capPart = i >= PlumeMain * 3 / 10;
                float3 albedo = capPart ? smokeDark : math.lerp(dust, smokeDark, lean);
                WriteRing(block + i * PlumeAround, centre, pt, tg, at, albedo, c, t, freq, erode, ref lo, ref hi);
            }
            // ---- the base surge: from the outer ground edge, up over its rolling front and in to the axis
            float reach = s * (.5f + 4.1f * (1 - math.exp(-t / 3f)));
            float rs = s * (.28f + .37f * (1 - math.exp(-t / 4f)));
            float surgeFade = fade * math.saturate(1.4f - t / 18f) * math.saturate(t * 3f);
            k = 0;
            Key(reach + rs * .9f, -.06f * s, 0, .35f * surgeFade, rs * .2f, -roll * 2);
            Key(reach + rs * .55f, rs * .85f, flash * .5f, .75f * surgeFade, rs * .45f, -roll * 2);
            Key(reach - rs * .3f, rs * 1.25f, flash * .5f, .8f * surgeFade, rs * .5f, -roll * 2);
            Key(reach - rs * 1.4f, rs * .75f, 0, .55f * surgeFade, rs * .4f, -roll);
            Key(reach * .5f, rs * .4f, 0, .3f * surgeFade, rs * .3f, -roll * .5f);
            Key(0, rs * .35f, 0, .25f * surgeFade, rs * .25f, 0);
            SampleProfile(k, PlumeSurge);
            // the surge hugs the ground: the terrain under its front, per direction, blended in from the axis
            for (int j = 0; j < PlumeAround; j++)
            {
                float3 w = c.Base + new float3(ringCos[j], 0, ringSin[j]) * reach;
                ringGround[j] = GroundAt != null ? GroundAt(w.x, -w.z) - c.Base.y : 0;
            }
            for (int i = 0; i < PlumeSurge; i++)
            {
                float lift = math.saturate(profilePoint[i].x / math.max(reach, .01f));
                WriteRing(block + (PlumeMain + i) * PlumeAround, c.Base, profilePoint[i], profileTangent[i], profileAttr[i], dust, c, t, freq * 1.3f, erode, ref lo, ref hi, lift);
            }
        }

        /// <summary>One ring of the lathe: the profile point (radius, height) swept round the axis at `centre`.</summary>
        void WriteRing(int start, float3 centre, float2 pt, float2 tg, float4 at, float3 albedo, Mushroom c, float age, float freq, float erode,
            ref float3 lo, ref float3 hi, float groundLift = -1)
        {
            var color = new Color(albedo.x, albedo.y, albedo.z, at.y);
            var data = new Vector4(at.x, at.z, freq, erode);
            var basis = new Vector4(c.Base.x, c.Base.y, c.Base.z, c.Seed);
            float2 n2 = new float2(tg.y, -tg.x);                         // outward normal in the profile plane
            for (int j = 0; j < PlumeAround; j++)
            {
                float cs = ringCos[j], sn = ringSin[j];
                float y = pt.y + (groundLift >= 0 ? ringGround[j] * groundLift : 0);
                var p = centre + new float3(cs * pt.x, y, sn * pt.x);
                int v = start + j;
                plumeVertices[v] = p;
                plumeNormals[v] = new Vector3(cs * n2.x, n2.y, sn * n2.x);
                var flow = new float3(cs * tg.x, tg.y, sn * tg.x) * at.w;
                plumeTangents[v] = new Vector4(flow.x, flow.y, flow.z, age);
                plumeColors[v] = color;
                plumeData[v] = data;
                plumeBase[v] = basis;
                lo = math.min(lo, p); hi = math.max(hi, p);
            }
        }

        void DrawMushrooms(WrapImages images)
        {
            if (plumeLive == 0 || plumeMesh == null || plumeMaterial == null) return;
            int n = images.For(plumeBounds, out float a, out float b, out float c);
            void Draw(float shift)
            {
                plumeBlock.SetVector(ImageOffsetId, new Vector4(shift, 0, 0, 0));
                var bounds = plumeBounds; bounds.center += new Vector3(shift, 0, 0);
                Graphics.RenderMesh(new RenderParams(plumeMaterial) { worldBounds = bounds, matProps = plumeBlock,
                    shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, plumeMesh, 0, Matrix4x4.identity);
            }
            if (n > 0) Draw(a); if (n > 1) Draw(b); if (n > 2) Draw(c);
        }

        void DisposeMushrooms()
        {
            if (plumeMesh != null) Object.Destroy(plumeMesh);
            if (plumeMaterial != null) Object.Destroy(plumeMaterial);
        }

        void WriteBlob(float3 p, float size, float3 color, float alpha, float rot, float seed, float heat, float camX, float period, bool wrap)
        {
            if (alpha <= .005f || alphaCount >= Budget) return;
            float x = wrap ? HexMath.NearX(p.x, camX, period, true) : p.x;
            alphaData[alphaCount++] = new ParticleGpu
            {
                Position = new float4(x, p.y, p.z, size),
                Color = new float4(color, alpha),
                Shape = new float4(rot, .55f, seed, heat),
                Extra = new float4(0, 0, 0, Puff),
            };
        }
    }
}
