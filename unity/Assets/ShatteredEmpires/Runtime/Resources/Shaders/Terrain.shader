// Terrain chunks: vertex-coloured biome surface with world-space detail so large areas never look
// uniform. Photographed grass and earth are hex-tiled (three randomly offset lookups blended over a
// hexagonal lattice, after Mikkelsen 2022) so their repeat never shows; a far-scale photo layer and
// generated multi-scale ground noise (GroundNoise.cs: macro colour drift from lush green hollows through
// olive to straw-dry rises, tussocks, worn patches of loam, earth and dust, fine grain, and their filtered
// relief for hummocks and cavities) break up grassland and biome boundaries without shimmer at any zoom;
// slope rock blends by height so ledges show before cracks; developed city ground; base
// aprons and headquarters plazas from the territory field (one cohesive compound under every ring base,
// paved further with each tier); churned no-man's land and crater bowls with torn clods, scorched cores
// and pale rim debris; rain-wet ground; drifting cloud shadows; a soft glowing territory border in each
// owner's team colour; fog of war. Meshes are built off the main thread by Burst jobs.
Shader "SE/Terrain"
{
    Properties
    {
        _TerrainAtlas ("Grass / earth / limestone / aggregate", 2D) = "white" {}
        _GrassTex ("Short grass", 2D) = "white" {}
        _GrassNormal ("Grass normal", 2D) = "bump" {}
        _EarthTex ("Photographed forest earth", 2D) = "white" {}
        _EarthNormal ("Forest earth normal", 2D) = "bump" {}
        _DetailScale ("Detail scale", Float) = 1.35
        _DetailStrength ("Detail strength", Range(0, 0.5)) = 0.10
        _GroundNoise ("Ground noise (GroundNoise.cs)", 2D) = "gray" {}
        _GroundDetail ("Ground detail (GroundNoise.cs)", 2D) = "gray" {}
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry-10" }

        HLSLINCLUDE
        #include "SECommon.hlsl"
        #include "SESurfaces.hlsl"
        TEXTURE2D(_TerrainAtlas); SAMPLER(sampler_TerrainAtlas);
        TEXTURE2D(_GrassTex); SAMPLER(sampler_GrassTex);
        TEXTURE2D(_GrassNormal); SAMPLER(sampler_GrassNormal);
        TEXTURE2D(_EarthTex); SAMPLER(sampler_EarthTex);
        TEXTURE2D(_EarthNormal); SAMPLER(sampler_EarthNormal);
        // Procedural ground (GroundNoise.cs), tileable: noise r macro fbm, g clump height, b patch field, a grain;
        // detail r clump height, g patch field, ba the signed clump-height gradient (.5 = flat). Unset: flat grey.
        TEXTURE2D(_GroundNoise);
        TEXTURE2D(_GroundDetail);
        float4 _TerrainAtlas_TexelSize;
        CBUFFER_START(UnityPerMaterial)
            float _DetailScale;
            float _DetailStrength;
        CBUFFER_END
        float _SE_Wetness;   // global rain wetness (regional wetness comes from the ground field)

        // Territory and base ground (Cities/TerritoryField.cs). Both share one sampler state.
        // _SE_TerritoryTex: rgb team colour (sRGB values), a signed distance to the border (0.5 = border).
        // _SE_BaseGroundTex: r apron ramp, g plaza ramp, b tier/3, a maintained.
        // _SE_TerritoryParams: x enabled, y signed-distance range (world units). Unset (0) disables both.
        TEXTURE2D(_SE_TerritoryTex); SAMPLER(sampler_SE_TerritoryTex);
        TEXTURE2D(_SE_BaseGroundTex);
        float4 _SE_TerritoryParams;
        // Ring of influence edge (TerritoryField, 2026-11-18): _SE_InfluenceTex r = signed distance to the edge of the local
        // player's defense ring of influence (0.5 = the edge, inside > 0.5), same encoding as the territory alpha.
        // _SE_InfluenceParams: x strength (0 off, faint when idle, 1 while placing a defense), y range. _SE_InfluenceColor: sRGB team colour.
        TEXTURE2D(_SE_InfluenceTex);
        float4 _SE_InfluenceParams;
        float4 _SE_InfluenceColor;

        float SE_Hash(float2 p) { return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
        float SE_Noise(float2 p)
        {
            float2 i = floor(p), f = frac(p);
            float2 u = f * f * (3.0 - 2.0 * f);
            return lerp(lerp(SE_Hash(i), SE_Hash(i + float2(1, 0)), u.x), lerp(SE_Hash(i + float2(0, 1)), SE_Hash(i + float2(1, 1)), u.x), u.y);
        }

        float2 SE_Hash22(float2 p)
        {
            float3 p3 = frac(p.xyx * float3(.1031, .1030, .0973));
            p3 += dot(p3, p3.yzx + 33.33);
            return frac((p3.xx + p3.yz) * p3.zy);
        }

        // Hexagonal lattice for hex-tiling: barycentric weights of the three nearest lattice
        // vertices (Mikkelsen, "Practical Real-Time Hex-Tiling", JCGT 2022).
        void SE_HexGrid(float2 uv, out float3 w, out float2 v1, out float2 v2, out float2 v3)
        {
            uv *= 3.4641016;   // 2 * sqrt(3)
            const float2x2 gridToSkewed = float2x2(1.0, 0.0, -0.57735027, 1.15470054);
            float2 skewed = mul(gridToSkewed, uv);
            float2 baseId = floor(skewed);
            float3 temp = float3(frac(skewed), 0);
            temp.z = 1.0 - temp.x - temp.y;
            float s = step(0.0, -temp.z);
            float s2 = 2.0 * s - 1.0;
            w = float3(-temp.z * s2, s - temp.y * s2, s - temp.x * s2);
            v1 = baseId + float2(s, s);
            v2 = baseId + float2(s, 1.0 - s);
            v3 = baseId + float2(1.0 - s, s);
        }

        // A tiling photograph without a visible repeat: every hexagonal cell (cells per uv unit)
        // reads the texture at its own random offset, cross-faded over narrow seams. Gradients come
        // from the continuous uv so the offsets never pick a coarse mip.
        half4 SE_HexTiled(TEXTURE2D_PARAM(tex, samp), float2 uv, float cells)
        {
            float2 dx = ddx(uv), dy = ddy(uv);
            float3 w; float2 v1, v2, v3;
            SE_HexGrid(uv * cells, w, v1, v2, v3);
            half4 a = SAMPLE_TEXTURE2D_GRAD(tex, samp, uv + SE_Hash22(v1) * 7.13, dx, dy);
            half4 b = SAMPLE_TEXTURE2D_GRAD(tex, samp, uv + SE_Hash22(v2) * 7.13, dx, dy);
            half4 c = SAMPLE_TEXTURE2D_GRAD(tex, samp, uv + SE_Hash22(v3) * 7.13, dx, dy);
            w = pow(max(w, 0.0), 3.0);
            w /= max(w.x + w.y + w.z, 1e-4);
            return a * (half)w.x + b * (half)w.y + c * (half)w.z;
        }

        // The same with gradients supplied by the caller, so it may run inside a dynamic branch.
        half4 SE_HexTiledGrad(TEXTURE2D_PARAM(tex, samp), float2 uv, float cells, float2 dx, float2 dy)
        {
            float3 w; float2 v1, v2, v3;
            SE_HexGrid(uv * cells, w, v1, v2, v3);
            half4 a = SAMPLE_TEXTURE2D_GRAD(tex, samp, uv + SE_Hash22(v1) * 7.13, dx, dy);
            half4 b = SAMPLE_TEXTURE2D_GRAD(tex, samp, uv + SE_Hash22(v2) * 7.13, dx, dy);
            half4 c = SAMPLE_TEXTURE2D_GRAD(tex, samp, uv + SE_Hash22(v3) * 7.13, dx, dy);
            w = pow(max(w, 0.0), 3.0);
            w /= max(w.x + w.y + w.z, 1e-4);
            return a * (half)w.x + b * (half)w.y + c * (half)w.z;
        }

        // Atlas regions are sampled with explicit gradients: frac must never choose a
        // coarse mip at a repeat seam. The inset keeps neighbouring materials separate.
        half3 SurfacePhoto(float2 uv, uint layer)
        {
            float2 quadrant = float2(layer & 1u, layer < 2u ? 1.0 : 0.0);
            float2 inset = max(_TerrainAtlas_TexelSize.xy * 3.0, 0.003);
            float2 span = 0.5 - inset * 2.0;
            float2 coord = quadrant * 0.5 + inset + frac(uv) * span;
            return SAMPLE_TEXTURE2D_GRAD(_TerrainAtlas, sampler_TerrainAtlas, coord, ddx(uv) * span, ddy(uv) * span).rgb;
        }

        // A world-space frequency snapped to a whole number of repeats per world period (_SE_FogParams.x = 1/period),
        // so the ground detail lines up across the wrap seam.
        float SE_PeriodScale(float f)
        {
            float invPeriod = _SE_FogParams.x;
            return invPeriod > 1e-5 ? max(1.0, round(f / invPeriod)) * invPeriod : f;
        }

        half3 GroundPhoto(float2 uv, uint layer)
        {
            // Two orientations with a slow, continuous blend remove recognisable repeats.
            half blend = smoothstep(0.20h, 0.80h, SE_Noise(uv * 0.19 + 37.2));
            return lerp(SurfacePhoto(uv, layer), SurfacePhoto(float2(-uv.y, uv.x) + 0.37, layer), blend);
        }
        ENDHLSL

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHTS
            #pragma multi_compile_fog

            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; half4 color : COLOR; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                half3 normalWS : TEXCOORD1;
                half4 color : TEXCOORD2;
                float fogCoord : TEXCOORD3;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS);
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                o.color = v.color;
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 n = normalize(i.normalWS);
                float3 wp = i.positionWS;
                float2 p = wp.xz * _DetailScale;
                // View scale: the rig distance. The in-match camera is orthographic (size = distance * .36),
                // where eye distance says nothing about zoom.
                float camDist = unity_OrthoParams.w > .5 ? unity_OrthoParams.y / .36 : SE_ViewDistance(wp);
                half nearDetail = 1.0h - smoothstep(8.0h, 32.0h, (half)camDist);
                half midDetail = 1.0h - smoothstep(24.0h, 110.0h, (half)camDist);

                // Ground detail at three scales from the generated noise (GroundNoise.cs), every layer mip-filtered so
                // it fades to its mean with distance instead of shimmering. Macro: soft colour drift over tens of
                // hexes, independent of the hex grid, so biome colours wander across hex boundaries. Meso: tussocks
                // and worn patches, two rotated, differently scaled reads cross-faded by the macro field so neither
                // repeat shows. Micro: grain close in. The detail texture carries each scale's gradient, so the light
                // catches the bumps. Five reads in all (four outside the close-up branch).
                float2 xz = wp.xz;
                float2 uvMacro = xz * SE_PeriodScale(.0105) + float2(.13, .71);
                float2 uvDrift = xz.yx * SE_PeriodScale(.027) + float2(.57, .29);
                half4 macA = SAMPLE_TEXTURE2D(_GroundNoise, sampler_GrassTex, uvMacro);
                half m1 = macA.r, m2 = macA.b, m3 = macA.g;
                half macro = m1 * .55h + m2 * .30h + m3 * .15h;
                // the drift read: broad hummocks (its relief) and which soil a stretch of worn ground shows
                half4 drift = SAMPLE_TEXTURE2D(_GroundDetail, sampler_GrassTex, uvDrift);
                half2 hummockGrad = (drift.ab - .5h) * 2.0h;
                hummockGrad = hummockGrad.yx;
                half tone = drift.g;
                float sM1 = SE_PeriodScale(.30), sM2 = SE_PeriodScale(.21);
                float2 uvM1 = xz * sM1 + float2(.31, .17);
                float2 uvM2 = float2(-xz.y, xz.x) * sM2 + float2(.73, .41);
                half4 mesA = SAMPLE_TEXTURE2D(_GroundDetail, sampler_GrassTex, uvM1);
                half4 mesB = SAMPLE_TEXTURE2D(_GroundDetail, sampler_GrassTex, uvM2);
                half wM = smoothstep(.30h, .70h, m2);
                half clump = lerp(mesA.r, mesB.r, wM);
                half patch = lerp(mesA.g, mesB.g, wM);
                // world-space tussock gradient, the second read rotated back into world axes
                half2 gA = (mesA.ba - .5h) * 2.0h, gB = (mesB.ba - .5h) * 2.0h;
                half2 tussockGrad = lerp(gA, half2(gB.y, -gB.x) * .70h, wM);
                // micro grain, only where it can be seen (gradients from outside the branch keep the mips right)
                half microDetail = 1.0h - smoothstep(10.0h, 46.0h, (half)camDist);
                half grain = .5h; half2 grainGrad = 0;
                float sMi = SE_PeriodScale(1.15);
                float2 uvMi = xz * sMi + float2(.21, .67);
                float2 gdxMi = ddx(uvMi), gdyMi = ddy(uvMi);
                UNITY_BRANCH if (microDetail > .001h)
                {
                    half4 micro = SAMPLE_TEXTURE2D_GRAD(_GroundDetail, sampler_GrassTex, uvMi, gdxMi, gdyMi);
                    grain = lerp(.5h, micro.r, microDetail);
                    grainGrad = (micro.ba - .5h) * 2.0h * microDetail;
                }
                // patch edges soften with distance, so a mip-averaged field never snaps patches on and off
                half soft = lerp(.08h, .22h, smoothstep(30.0h, 160.0h, (half)camDist));

                // (perf, workstream A) the close-up photo layers (four hex-tiled reads, twelve samples) only
                // run where they show; the gradients come from outside the branch so mips stay correct
                float2 gdx = ddx(wp.xz), gdy = ddy(wp.xz);
                bool nearOn = nearDetail > .001h;
                half3 grassFar = SAMPLE_TEXTURE2D(_GrassTex, sampler_GrassTex, wp.xz * .83 + .21).rgb;
                half3 grass = grassFar;
                UNITY_BRANCH if (nearOn) grass = SE_HexTiledGrad(TEXTURE2D_ARGS(_GrassTex, sampler_GrassTex), wp.xz * 7.0, .45, gdx * 7.0, gdy * 7.0).rgb;
                half grassLuma = dot(grass, half3(.25h, .60h, .15h));
                half farLuma = dot(grassFar, half3(.25h, .60h, .15h));
                half3 palette = SRGBToLinear(i.color.rgb);
                // vegetated land (green over red in the biome colour); deserts, rock and snow are not
                half vegetated = saturate((i.color.g - i.color.r) * 14.0h + .35h);
                // grassland proper for the new detail: green clearly over blue as well, so snow, tundra, rock and
                // sand (whose biome colours are near grey or red-over-green) keep their own look
                half lushland = saturate((i.color.g - i.color.b) * 10.0h - .4h) * saturate((i.color.g - i.color.r) * 20.0h + 1.0h);
                half3 albedo = palette * lerp(1.0h, clamp(grassLuma / .075h, .78h, 1.22h), nearDetail * .40h);
                // Close views retain the photograph's fine organic colour rather than
                // turning every blade into a high-contrast luminance pattern.
                albedo = lerp(albedo, grass * lerp(.85h, 1.12h, i.color.g), nearDetail * .12h);
                // A far-scale reading of the photograph keeps mid-distance ground textured.
                albedo *= lerp(1.0h, clamp(farLuma / .075h, .86h, 1.14h), midDetail * (1.0h - nearDetail * .6h) * .35h);
                // Grassland colour: no single green. Moisture follows the macro field and the lie of the land (low
                // ground near water stays lush, high rises dry out): deep green hollows, olive middle ground and
                // straw-yellow dry rises, with smaller olive bands drifting through.
                half slope = 1.0h - n.y;
                half dry = smoothstep(.30h, .82h, m1 * .62h + m2 * .38h + ((half)wp.y - .9h) * .18h);
                half3 lushT = half3(.88h, 1.04h, .93h), oliveT = half3(1.0h, 1.0h, .84h), dryT = half3(1.14h, 1.05h, .78h);
                half3 hue = dry < .5h ? lerp(lushT, oliveT, dry * 2.0h) : lerp(oliveT, dryT, dry * 2.0h - 1.0h);
                hue = lerp(hue, oliveT * half3(.95h, .97h, .97h), smoothstep(.58h, .82h, m3) * .40h);
                albedo *= lerp(half3(1.0h, 1.0h, 1.0h), hue, lushland * .80h);
                albedo *= .92h + macro * .16h;
                // Tussocks: dense clumps darker and greener, their sun-bleached tops paler (more so where dry).
                half grassy = lushland * (1.0h - smoothstep(.25h, .55h, slope));
                albedo *= lerp(1.0h, lerp(.83h, 1.10h, clump), grassy * .80h);
                albedo = lerp(albedo, albedo * half3(1.07h, 1.04h, .86h), saturate(clump * 2.0h - 1.1h) * grassy * (.20h + dry * .35h));
                // fine grain close in: blades and pebbles
                albedo *= .88h + grain * .24h;

                // Far away the soil takes the photograph's mean colour (its smallest mip) instead of a
                // near-black constant: churned ground and crater floors read as earth, not black blobs.
                half3 earthDetail = SAMPLE_TEXTURE2D_LOD(_EarthTex, sampler_EarthTex, float2(.5, .5), 12).rgb;
                UNITY_BRANCH if (nearOn) earthDetail = lerp(earthDetail, SE_HexTiledGrad(TEXTURE2D_ARGS(_EarthTex, sampler_EarthTex), wp.xz * 3.2, .5, gdx * 3.2, gdy * 3.2).rgb, nearDetail);
                half3 earth = lerp(half3(.075h, .061h, .038h), earthDetail, .72h);
                // Worn ground: sparse, yellowed grass around small patches of brown soil or pale dust (more on dry
                // rises and slopes, fewer in damp lowland), and broad trodden areas at the macro scale.
                // tussocks fray the patch edges, so they never read as flat cut-outs
                half cover = patch + (dry - .5h) * .26h + slope * .70h + (m3 - .5h) * .10h + (clump - .5h) * .12h + (grain - .5h) * .06h;
                half sparse = smoothstep(.66h - soft, .81h, cover) * lushland;
                half worn = smoothstep(.82h - soft, .82h + soft, cover) * lushland;
                // each patch its own soil: dark loam, brown earth or pale dust (dust only where it is dry)
                half3 loam = earth * half3(1.10h, 1.02h, .94h);
                half3 brown = earth * half3(1.45h, 1.28h, 1.10h);
                half3 dust = half3(.18h, .16h, .12h);
                half3 soilT = lerp(loam, brown, smoothstep(.25h, .60h, tone));
                soilT = lerp(soilT, dust, smoothstep(.55h, .85h, tone) * dry * .7h);
                soilT *= .80h + grain * .40h;
                albedo = lerp(albedo, albedo * half3(1.05h, 1.02h, .88h), sparse * .45h);
                albedo = lerp(albedo, soilT, worn * .72h);
                // a trodden, slightly darker rim where the turf gives way to bare soil
                albedo *= 1.0h - saturate(worn * (1.0h - worn) * 4.0h) * .10h;
                half bare = smoothstep(.70h, .88h, macA.b * .65h + m3 * .35h + (patch - .5h) * .14h) * lushland * .30h;
                albedo = lerp(albedo, earth * half3(1.30h, 1.25h, 1.15h) * (.85h + grain * .3h), bare);
                // cavity: the hollows between tussocks hold shade
                albedo *= lerp(1.0h, .88h + clump * .12h, grassy * (1.0h - worn));

                half3 weights = pow(abs(n), 4);
                weights /= max(dot(weights, half3(1, 1, 1)), .001h);
                half3 rock = GroundPhoto(wp.zy * .73, 2u) * weights.x
                    + GroundPhoto(p * .58, 2u) * weights.y + GroundPhoto(wp.xy * .73, 2u) * weights.z;
                rock *= half3(.93h, .94h, .93h) * (.92h + m2 * .16h);
                half rockLuma = dot(rock, half3(.3h, .5h, .2h));
                // Height-aware transition: bright ledges show first, grass holds in the cracks.
                half steep = smoothstep(.14h, .55h, slope + (rockLuma - .18h) * .45h + (m3 - .5h) * .10h);
                albedo = lerp(albedo, rock, steep * i.color.a);

                float4 gf = SE_Ground(wp);
                half3 aggregate = GroundPhoto(p * 1.26, 3u);
                half district = smoothstep(.24h, .88h, gf.r) * (1.0h - steep);
                albedo = lerp(albedo, lerp(earth, aggregate, .54h), district * .74h);

                // Base compounds: compacted gravel aprons that grow with tier, concrete paving from
                // tier 2 (wider at tier 3) and the headquarters plaza. Abandoned compounds keep weeds.
                half apron = 0;
                bool territoryOn = _SE_TerritoryParams.x > .5;
                if (territoryOn)
                {
                    half4 bg = SAMPLE_TEXTURE2D_LOD(_SE_BaseGroundTex, sampler_SE_TerritoryTex, SE_MapUV(wp), 0);
                    if (bg.r > .01h)
                    {
                        half ragged = (SE_Noise(wp.xz * 1.9) - .5h) * .26h + (SE_Noise(wp.xz * 6.1) - .5h) * .10h;
                        apron = smoothstep(.44h, .60h, bg.r + ragged) * (1.0h - steep * .7h);
                        half keep = bg.a;
                        half tierN = bg.b * 3.0h;
                        half3 gravel = lerp(earth, aggregate, .78h) * lerp(.95h, 1.15h, m3) * half3(1.04h, 1.02h, .96h);
                        float2 cell = wp.xz / .46;
                        float2 f = abs(frac(cell) - .5);
                        half seam = smoothstep(.465h, .495h, (half)max(f.x, f.y));
                        half panel = .90h + (half)SE_Hash(floor(cell)) * .16h;
                        half3 concrete = lerp(half3(.30h, .30h, .28h), aggregate * 1.6h, .35h) * panel * (1.0h - seam * .38h);
                        half pavedEdge = .80h - saturate(tierN - 2.0h) * .12h;
                        half paved = smoothstep(pavedEdge, pavedEdge + .08h, bg.r + ragged * .4h) * saturate(tierN - 1.0h) * step(.6h, keep);
                        paved = max(paved, smoothstep(.45h, .62h, bg.g + ragged * .3h) * keep);
                        half3 apronAlbedo = lerp(lerp(albedo, gravel, .55h), gravel, keep);
                        apronAlbedo = lerp(apronAlbedo, concrete, paved);
                        // a darker trodden berm where the apron meets the land
                        half berm = saturate(apron * (1.0h - apron) * 4.0h);
                        albedo = lerp(albedo, apronAlbedo, apron) * (1.0h - berm * .10h);
                    }
                }

                // No-man's land: the old flat darkening, now torn into clods and furrows.
                half scar = saturate(gf.g);
                half clod = SE_Noise(wp.xz * 9.0) * .6h + SE_Noise(wp.xz * 23.0 + 7.7) * .4h;
                half3 churned = earth * half3(.64h, .61h, .56h) * lerp(.70h, 1.25h, clod);
                albedo = lerp(albedo, churned, scar * .85h);
                // Crater bowls (the damage mesh tints its depression toward soil): torn soil inside,
                // a scorched core at the bottom, and pale ejecta and debris on the rims.
                half cratered = saturate(gf.a * 2.5h + scar * .6h);
                half soilness = saturate((i.color.r - i.color.g) * 12.0h + .1h) * cratered;
                half core = smoothstep(.55h, .92h, soilness);
                half rim = saturate(1.0h - abs(soilness - .28h) / .18h) * cratered;
                half3 scorched = half3(.062h, .054h, .044h) * lerp(.8h, 1.4h, clod);   // charred soil, not a black hole
                half3 debris = lerp(aggregate * half3(.85h, .82h, .78h), rock, .35h) * lerp(.75h, 1.25h, SE_Noise(wp.xz * 31.0));
                albedo = lerp(albedo, churned * .85h, soilness * .6h);
                albedo = lerp(albedo, scorched, core * .55h);
                albedo = lerp(albedo, debris, rim * smoothstep(.45h, .75h, clod) * .7h);

                half woodland = saturate((i.color.g - i.color.r) * 7.0h);
                albedo = lerp(albedo, earth * half3(.82h, .93h, .73h), woodland * nearDetail * .26h * (1.0h - apron));
                half damp = smoothstep(.60h, .85h, m2) * vegetated * .5h;
                // ground under falling rain is wet at once (regional rain, WeatherField); the server's wetness builds up slowly
                half wet = saturate(max(max(_SE_Wetness, gf.b), SE_WeatherAt(wp.xz).g * .85h) + damp * .35h);
                albedo *= 1.0h - wet * .18h;

                half relief = lerp(grassLuma, rockLuma, steep);
                n = SE_Relief(wp, n, relief, .00012h + steep * .00050h);
                // Ground relief from the filtered gradients: broad hummocks everywhere on land, tussocks on grass and
                // grain close in, so the low sun catches the ground instead of a flat wash. Paving stays flat.
                half land = (half)i.color.a * (1.0h - apron) * (1.0h - district * .7h);
                half2 groundGrad = hummockGrad * .10h + tussockGrad * (.05h + grassy * (.08h + nearDetail * .10h)) * (1.0h - worn * .5h) + grainGrad * .12h;
                n = normalize(n + half3(-groundGrad.x, 0, -groundGrad.y) * land * (1.0h - steep * .6h));
                UNITY_BRANCH if (nearOn)
                {
                    half3 grassNormal = UnpackNormal(SE_HexTiledGrad(TEXTURE2D_ARGS(_GrassNormal, sampler_GrassNormal), wp.xz * 7.0, .45, gdx * 7.0, gdy * 7.0));
                    n = normalize(n + half3(grassNormal.x, 0, grassNormal.y) * nearDetail * (1 - steep) * (1.0h - apron) * .10h);
                    half3 earthNormal = UnpackNormal(SE_HexTiledGrad(TEXTURE2D_ARGS(_EarthNormal, sampler_EarthNormal), wp.xz * 3.2, .5, gdx * 3.2, gdy * 3.2));
                    n = normalize(n + half3(earthNormal.x, 0, earthNormal.y) * nearDetail * max(max(scar, woodland), max(soilness, bare)) * .06h);
                }
                // Churned ground and crater walls catch the light instead of reading as smooth bowls.
                n = SE_Relief(wp, n, clod, (scar * .5h + soilness) * .012h * (.2h + nearDetail * .8h));

                half3 color = SE_Shade(albedo, wp, n, 0);
                half3 viewDir = normalize(GetWorldSpaceViewDir(wp));
                Light sun = GetMainLight();
                half sheen = pow(saturate(dot(n, normalize(sun.direction + viewDir))), 80.0h) * wet * .12h;
                color += sun.color * sheen;
                color *= 1.0h - SE_CloudShadow(wp);

                // Territory: a soft glowing line in the owner's team colour with a faint inward wash.
                // Thin and quiet up close, wider and clearer at strategic zoom. The distance field runs along
                // the hex sides (TerritoryField), so it is sampled unwarped: the outline stays a clean hexagon.
                if (territoryOn)
                {
                    half4 tt = SAMPLE_TEXTURE2D_LOD(_SE_TerritoryTex, sampler_SE_TerritoryTex, SE_MapUV(wp), 0);
                    if (tt.a > .004h)
                    {
                        float d = (tt.a - .5) * 2.0 * _SE_TerritoryParams.y;
                        float width = clamp(camDist * .0045, .045, .40);
                        half edge = 1.0h - smoothstep(0.0h, (half)width, (half)abs(d));
                        half inner = d > 0 ? (half)exp(-d / (width * 7.0)) : 0.0h;
                        half zoom = lerp(.30h, 1.0h, smoothstep(6.0h, 32.0h, (half)camDist));
                        half pulse = .88h + .12h * (half)sin(_Time.y * 1.3 - d * 2.0);
                        half3 team = SRGBToLinear(tt.rgb);
                        color = lerp(color, team * .55h, edge * .30h * zoom);
                        color += team * (edge * .32h * pulse + inner * .07h) * zoom;
                    }
                    // the ring of influence edge, drawn with the same glowing border line (no inward wash)
                    if (_SE_InfluenceParams.x > .001)
                    {
                        half inf = SAMPLE_TEXTURE2D_LOD(_SE_InfluenceTex, sampler_SE_TerritoryTex, SE_MapUV(wp), 0).r;
                        if (inf > .004h && inf < .996h)
                        {
                            float d = (inf - .5) * 2.0 * _SE_InfluenceParams.y;
                            float width = clamp(camDist * .0045, .045, .40);
                            half edge = 1.0h - smoothstep(0.0h, (half)width, (half)abs(d));
                            half zoom = lerp(.30h, 1.0h, smoothstep(6.0h, 32.0h, (half)camDist));
                            half pulse = .88h + .12h * (half)sin(_Time.y * 1.3 - d * 2.0);
                            half3 team = SRGBToLinear((half3)_SE_InfluenceColor.rgb);
                            half k = (half)saturate(_SE_InfluenceParams.x);
                            color = lerp(color, team * .55h, edge * .30h * zoom * k);
                            color += team * (edge * .32h * pulse) * zoom * k;
                        }
                    }
                }

                if (any(isnan(color)) || any(isinf(color))) color = albedo * .35h;
                color = clamp(color, 0, 4);
                return half4(SE_ApplyFog(color, wp, i.fogCoord), 1);
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ZWrite On ZTest LEqual ColorMask 0
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; };
            float4 vert(Attributes v) : SV_POSITION
            {
                return SE_ShadowPositionCS(TransformObjectToWorld(v.positionOS), TransformObjectToWorldNormal(v.normalOS));
            }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ZWrite On ColorMask R
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            struct Attributes { float3 positionOS : POSITION; };
            float4 vert(Attributes v) : SV_POSITION { return TransformObjectToHClip(v.positionOS); }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
