// The unexplored world as a bank of low cloud. A full-screen pass ray-marches a slab of fog from below the
// lowest ground to above the hills. Only never-explored ground (and explored hexes on the boundary with it,
// so the cut edge of known terrain is buried) is covered; explored ground that is merely out of sight gets no
// cloud at all (world shaders dim it, SE_ApplyFog). The coverage is read from the explored channel of the
// fog-of-war texture through a noise warp, so no hex outline shows; billowing 3D noise drifts on the wind and
// the top surface rolls. Everything past a bounded map border is unexplored, so the edge of the world is never
// visible. Lit from above (bright crowns, shadowed undersides) and tinted by the atmosphere's haze colour.
//
// Rays: Shroud.cs passes, per screen corner, the world-space ray origin (on the camera plane) and direction
// (scaled so its component along the camera's forward axis is 1), computed with Camera.ViewportToWorldPoint.
// They are interpolated across the full-screen triangle, so perspective and orthographic cameras (the action
// RTS camera is orthographic) both get exact rays, independent of reversed-Z or projection flips. The scene
// distance comes from the linear eye depth of the camera depth texture (URP copy after opaques).
Shader "SE/Shroud"
{
    SubShader
    {
        Tags { "RenderType" = "Transparent" "Queue" = "Transparent-40" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Shroud"
            Tags { "LightMode" = "UniversalForward" }
            Blend One OneMinusSrcAlpha
            ZWrite Off
            ZTest Always
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            TEXTURE2D(_SE_FogTex); SAMPLER(sampler_SE_FogTex);
            float4 _SE_FogParams;     // x = 1/period, y = 1/depth, z = enabled
            float4 _SE_ShroudParams;  // x = wrap (0/1), y = floor height, z = top height, w = density
            float4 _SE_ShroudLit;     // rgb = sunlit colour
            float4 _SE_ShroudShade;   // rgb = shadowed colour
            float4 _SE_ShroudWind;    // xz = drift (world units), y = time
            float4x4 _SE_ShroudRayO;  // rows: world ray origin at the screen corners (bottom-left, bottom-right, top-left, top-right)
            float4x4 _SE_ShroudRayD;  // rows: world ray direction at the same corners (forward component 1)
            float4 _SE_ShroudCam;     // x = orthographic (0/1), y = near, z = far

            struct Attributes { float3 positionOS : POSITION; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 origin : TEXCOORD0;
                float3 ray : TEXCOORD1;
                float screenV : TEXCOORD2;   // 0 at the bottom of the image, 1 at the top
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionCS = float4(v.positionOS.xy, UNITY_NEAR_CLIP_VALUE, 1);
                // clip space to the image's own coordinates (y flipped while rendering into a flipped target)
                float su = v.positionOS.x * .5 + .5;
                float sv = v.positionOS.y * _ProjectionParams.x * .5 + .5;
                o.origin = lerp(lerp(_SE_ShroudRayO[0].xyz, _SE_ShroudRayO[1].xyz, su), lerp(_SE_ShroudRayO[2].xyz, _SE_ShroudRayO[3].xyz, su), sv);
                o.ray = lerp(lerp(_SE_ShroudRayD[0].xyz, _SE_ShroudRayD[1].xyz, su), lerp(_SE_ShroudRayD[2].xyz, _SE_ShroudRayD[3].xyz, su), sv);
                o.screenV = sv;
                return o;
            }

            float Hash(float3 p) { p = frac(p * 0.3183099 + 0.1); p *= 17.0; return frac(p.x * p.y * p.z * (p.x + p.y + p.z)); }
            float Noise(float3 x)
            {
                float3 i = floor(x), f = frac(x); f = f * f * (3 - 2 * f);
                return lerp(lerp(lerp(Hash(i), Hash(i + float3(1, 0, 0)), f.x), lerp(Hash(i + float3(0, 1, 0)), Hash(i + float3(1, 1, 0)), f.x), f.y),
                            lerp(lerp(Hash(i + float3(0, 0, 1)), Hash(i + float3(1, 0, 1)), f.x), lerp(Hash(i + float3(0, 1, 1)), Hash(i + float3(1, 1, 1)), f.x), f.y), f.z);
            }
            float Fbm(float3 p) { return Noise(p) * .55 + Noise(p * 2.03 + 7.1) * .28 + Noise(p * 4.11 + 3.3) * .17; }

            // The fog texel at a world xz; outside a bounded map everything is unexplored.
            float4 FogTexel(float2 xz)
            {
                float2 uv = float2(xz.x * _SE_FogParams.x, -xz.y * _SE_FogParams.y);
                float outside = max(_SE_ShroudParams.x > .5 ? -1 : max(-uv.x, uv.x - 1), max(-uv.y, uv.y - 1));
                float4 fog = SAMPLE_TEXTURE2D_LOD(_SE_FogTex, sampler_SE_FogTex, uv, 0);
                if (outside > 0) fog.g = 0;
                return fog;
            }

            // x: 1 = unexplored (boundary hexes, G = .47, are fully covered so the cut edge never shows; interior
            // explored ground, G = 1, never is); y: the ground height the bank must bury there.
            float2 Cover(float3 p)
            {
                float2 warp = float2(Noise(float3(p.xz * .45, 1.7)), Noise(float3(p.xz * .45, 9.3))) - .5;
                float4 fog = FogTexel(p.xz + warp * .6);
                return float2(1 - smoothstep(.55, .85, fog.g), fog.b * 8.0);   // B: 0..1 = 0..FogField.HeightRange
            }

            // ------------------------------------------------------------------ sky clouds
            // Cumulus between _SE_CloudLayer.x and .y (world units). Coverage is the same 2D field that casts
            // the cloud shadows on the land (SE_CloudShadow in SECommon), so every cloud sits over its shadow;
            // 3D noise erodes the edges and builds billowing tops, and one step toward the sun self-shadows
            // the bellies. Only for a low perspective camera looking toward the horizon: it fades out as the
            // camera climbs, is masked to the top of the image, and Shroud.cs disables it for orthographic views,
            // so it never covers the middle of the screen or the battlefield.
            float4 _SE_Clouds;          // x = cover, yz = wind, w = speed (Atmosphere)
            float4 _SE_CloudLayer;      // x = base, y = top, z = enabled
            float CloudNoise2(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                float2 u = f * f * (3 - 2 * f);
                float a = frac(sin(dot(i, float2(127.1, 311.7))) * 43758.5);
                float b = frac(sin(dot(i + float2(1, 0), float2(127.1, 311.7))) * 43758.5);
                float c = frac(sin(dot(i + float2(0, 1), float2(127.1, 311.7))) * 43758.5);
                float d = frac(sin(dot(i + float2(1, 1), float2(127.1, 311.7))) * 43758.5);
                return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
            }
            float CloudCover(float2 xz)
            {
                float2 p = xz * 0.045 - _SE_Clouds.yz;
                float n = CloudNoise2(p) * 0.6 + CloudNoise2(p * 2.3 + 7.1) * 0.4;
                return smoothstep(1.0 - _SE_Clouds.x * 0.85, 1.05 - _SE_Clouds.x * 0.6, n);
            }
            float CloudDensity(float3 p)
            {
                float h = saturate((p.y - _SE_CloudLayer.x) / (_SE_CloudLayer.y - _SE_CloudLayer.x));
                float cover = CloudCover(p.xz);
                if (cover <= .02) return 0;
                // flat bases, towering rounded tops where cover is thick
                float shape = saturate(h * 5) * saturate((cover * 1.15 - h) * 2.2);
                float3 q = p * .085 - float3(_SE_Clouds.y, 0, _SE_Clouds.z) * 1.9 + float3(0, _Time.y * .004, 0);   // drifts with the cover, slowly boils
                float detail = Fbm(q) * .7 + Fbm(q * 3.1) * .3;
                return saturate(shape * 1.3 - (1 - detail) * .75) * 1.6;
            }
            float4 Clouds(float3 eye, float3 dir, float sceneDist, float jitter, float screenV, out float entry)
            {
                entry = 1e9;
                if (_SE_CloudLayer.z < .5 || _SE_Clouds.x <= .02) return 0;
                float fade = saturate((_SE_CloudLayer.x - 2 - eye.y) / 6);
                // only the upper part of the image, and only rays climbing gently toward the horizon
                fade *= smoothstep(.58, .8, screenV) * smoothstep(.01, .06, dir.y);
                if (fade <= 0) return 0;
                float t0 = (_SE_CloudLayer.x - eye.y) / dir.y, t1 = min(sceneDist, (_SE_CloudLayer.y - eye.y) / dir.y);
                t1 = min(t1, t0 + 260);
                if (t0 < 0 || t1 <= t0) return 0;
                entry = t0;
                const int STEPS = 18;
                float dt = (t1 - t0) / STEPS, T = 1;
                float3 L = 0, sun = normalize(_MainLightPosition.xyz);
                float3 sunCol = _MainLightColor.rgb, skyCol = _SE_ShroudLit.rgb;
                [loop] for (int s = 0; s < STEPS; s++)
                {
                    float3 p = eye + dir * (t0 + (s + jitter) * dt);
                    float d = CloudDensity(p);
                    if (d <= .001) continue;
                    float toward = CloudDensity(p + sun * 2.2);
                    float lit = exp(-toward * 2.4) * (1 - exp(-d * 2));            // beer + powder
                    float h = saturate((p.y - _SE_CloudLayer.x) / (_SE_CloudLayer.y - _SE_CloudLayer.x));
                    float3 col = skyCol * (.42 + .35 * h) + sunCol * lit * 1.1;
                    float a = 1 - exp(-d * dt * .9);
                    L += T * a * col; T *= 1 - a;
                    if (T < .02) break;
                }
                // distant clouds melt into the haze
                float far = saturate((entry - 140) / 260);
                return float4(L, 1 - T) * fade * (1 - far);
            }

            // ------------------------------------------------------------------ the shroud bank
            float4 FogBank(float3 eye, float3 dir, float sceneDist, float3 scenePos, float jitter, out float entry)
            {
                entry = 1e9;
                if (_SE_FogParams.z < .5 || _SE_ShroudParams.w <= 0) return 0;
                float lo = _SE_ShroudParams.y, hi = _SE_ShroudParams.z;
                float t0 = 0, t1 = sceneDist;
                if (abs(dir.y) < 1e-5) { if (eye.y < lo || eye.y > hi) return 0; }
                else
                {
                    float ta = (lo - eye.y) / dir.y, tb = (hi - eye.y) / dir.y;
                    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
                }
                float transmittance = 1;
                float3 light = 0;
                if (t1 > t0)
                {
                    entry = t0;
                    // The bank hugs the land: its rolling top sits a little above the ground it buries (the height
                    // channel), so it never stands as a wall in front of explored ground. Step count follows the
                    // length of the slab crossing: steep views take few steps, grazing views at most 44.
                    float span = max(min(t1, t0 + 50) - t0, 1e-3);
                    int steps = (int)clamp(ceil(span / .55), 6, 44);
                    float dt = span / steps;
                    float3 drift = float3(_SE_ShroudWind.x, 0, _SE_ShroudWind.z);
                    float time = _SE_ShroudWind.y;
                    float3 sun = normalize(_MainLightPosition.xyz);
                    [loop] for (int s = 0; s < steps; s++)
                    {
                        float t = t0 + (s + jitter) * dt;
                        float3 p = eye + dir * t;
                        // cheap rejects before any noise: well inside explored ground (the coverage warp moves at most
                        // .3 units), or above the highest crown the bank can reach here (burial height + .6 + .44)
                        float4 rawFog = FogTexel(p.xz);
                        if (rawFog.g > .97 || p.y > rawFog.b * 8.0 + 1.5) continue;
                        float2 c = Cover(p);
                        float cover = c.x;
                        if (cover < .01) continue;
                        // rolling crowns of cloud that rise and sink as they drift; they flatten into a calm sea
                        // toward the horizon so grazing views never alias into streaks
                        float reach = exp(-t / 30);
                        float crown = max(c.y, 0) + .6 + (Fbm(float3(p.xz * .12 + drift.xz * .5, time * .03)) - .45) * .8 * reach;
                        float h = saturate((crown - p.y) / .9);
                        if (h <= 0) continue;
                        float billow = Fbm(p * float3(.45, .7, .45) + drift + float3(0, time * .02, 0));
                        float density = cover * h * saturate(billow * 1.7 - .3 + cover * .4) * _SE_ShroudParams.w * 1.6;
                        if (density <= .001) continue;
                        float a = 1 - exp(-density * dt);
                        // sunlit crowns, shadowed bellies and hollows: depth below the crown plus a cheap sun-facing term
                        float depth = saturate((crown - p.y) / 1.2);
                        float facing = saturate(.5 + .5 * dot(sun, normalize(float3(billow - .5, 1.2, .5 - billow))));
                        float detail = exp(-t / 22);
                        float3 col = lerp(_SE_ShroudShade.rgb, _SE_ShroudLit.rgb, saturate(.88 + ((1 - depth) * .5 + facing * .25 + (billow - .5) * .45 - .5) * detail));
                        light += transmittance * a * col;
                        transmittance *= 1 - a;
                        if (transmittance < .015) break;
                    }
                }
                // over unexplored ground the bank is solid down to the floor: no gaps, streaks or cut terrain show through
                if (transmittance > .015 && (sceneDist < 9e4 || (dir.y < -1e-3 && eye.y > .2)))
                {
                    float3 floorP = sceneDist < 9e4 ? scenePos : eye + dir * ((.2 - eye.y) / dir.y);
                    float a = FogTexel(floorP.xz).g > .97 ? 0 : smoothstep(.55, .95, Cover(floorP).x);
                    if (a > 0)
                    {
                        entry = min(entry, sceneDist < 9e4 ? sceneDist : (.2 - eye.y) / dir.y);
                        light += transmittance * a * lerp(_SE_ShroudShade.rgb, _SE_ShroudLit.rgb, .9);
                        transmittance *= 1 - a;
                    }
                }
                return float4(light, 1 - transmittance);
            }

            half4 frag(Varyings i) : SV_Target
            {
                float2 uv = GetNormalizedScreenSpaceUV(i.positionCS);
                float raw = SampleSceneDepth(uv);
                #if UNITY_REVERSED_Z
                    bool sky = raw <= 1e-7;
                    float depth01 = 1 - raw;
                #else
                    bool sky = raw >= 1 - 1e-7;
                    float depth01 = raw;
                #endif
                // distance along the camera's forward axis to the opaque surface
                float eyeDepth = _SE_ShroudCam.x > .5 ? lerp(_SE_ShroudCam.y, _SE_ShroudCam.z, depth01) : LinearEyeDepth(raw, _ZBufferParams);
                float rayScale = max(length(i.ray), 1e-6);
                float3 dir = i.ray / rayScale;
                float3 eye = i.origin;
                float sceneDist = sky ? 1e5 : eyeDepth * rayScale;
                float3 scene = eye + dir * sceneDist;
                float jitter = frac(52.9829189 * frac(dot(i.positionCS.xy, float2(.06711056, .00583715))));
                float fogAt, cloudAt;
                float4 fog = FogBank(eye, dir, sceneDist, scene, jitter, fogAt);
                float4 cloud = Clouds(eye, dir, sceneDist, jitter, i.screenV, cloudAt);
                // premultiplied, front to back
                float4 nearer = fogAt <= cloudAt ? fog : cloud, farther = fogAt <= cloudAt ? cloud : fog;
                return half4(nearer.rgb + farther.rgb * (1 - nearer.a), 1 - (1 - nearer.a) * (1 - farther.a));
            }
            ENDHLSL
        }
    }
}
