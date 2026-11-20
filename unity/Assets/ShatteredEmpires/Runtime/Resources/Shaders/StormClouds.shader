// Rain curtains and lightning bolts (StormClouds.cs; the cloud masses are the StormSky deck now; mode 0 puffs are unused), drawn straight from the weather
// texture (SECommon SE_WeatherAt): no per-instance buffers. A world-anchored lattice of slots around the camera
// focus (one instance each, the slot index comes from SV_InstanceID) drifts with the wind; each slot reads the
// weather where it is and becomes a soft, lit cloud puff (or a rain curtain) only where the cloud is thick
// enough, so banks of broken cloud thicken into solid, towering, dark storm systems. Slots with nothing to
// show collapse to a degenerate quad in the vertex shader.
// _Mode: 0 cloud puffs, 1 rain curtains (both premultiplied alpha), 2 lightning bolts (additive, one instance
// per live strike).
Shader "SE/StormClouds"
{
    Properties
    {
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst", Float) = 10
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent+20" }
        Pass
        {
            Name "StormClouds"
            Tags { "LightMode" = "UniversalForward" }
            Blend [_SrcBlend] [_DstBlend]
            ZWrite Off
            ZTest LEqual
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "SECommon.hlsl"

            float4 _L0;   // xy first lattice index, zw slot counts (nx, nz)
            float4 _L1;   // xy lattice spacing (world), zw drift (world x, z)
            float4 _L2;   // xy hash period in slots (x wraps with the map), z fade, w hole strength
            float4 _L3;   // xy hole centre (world xz), z hole radius, w size multiplier
            float4 _L4;   // x window radius, yz focus (world xz), w mode (0 puffs, 1 curtains, 2 bolts)
            float4 _L5;   // x wrap (0/1), y period, z depth, w bolt sharpness

            struct Attributes { float3 positionOS : POSITION; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                half4 data : TEXCOORD1;    // x alpha, y storm, z rain, w flash
                float2 seed : TEXCOORD2;   // x per-slot seed, y age (bolts)
                float fogCoord : TEXCOORD3;
            };

            float Hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }
            float4 Hash4(float2 p)
            {
                return float4(Hash(p), Hash(p + 17.31), Hash(p + float2(3.7, 41.9)), Hash(p + float2(59.1, 7.3)));
            }
            float Noise(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                float2 u = f * f * (3 - 2 * f);
                return lerp(lerp(Hash(i), Hash(i + float2(1, 0)), u.x), lerp(Hash(i + float2(0, 1)), Hash(i + float2(1, 1)), u.x), u.y);
            }

            float StrikeGlow(float2 xz, float radius)
            {
                float g = 0;
                [unroll] for (int i = 0; i < 4; i++)
                {
                    float age = _SE_WxParams.w - _SE_Strikes[i].w;
                    float amp = _SE_StrikeAmp[i];
                    if (amp <= 0 || age < 0 || age > .8) continue;
                    float2 d = xz - _SE_Strikes[i].xz;
                    float k = saturate(1 - length(d) / radius);
                    g += amp * k * exp(-age * 5.5) * (.6 + .4 * sin(age * 63 + i));
                }
                return g;
            }

            Varyings Collapse()
            {
                Varyings o = (Varyings)0;
                o.positionCS = float4(0, 0, -2, 1);   // outside the clip volume: no fragments
                return o;
            }

            Varyings vert(Attributes v, uint id : SV_InstanceID)
            {
                float mode = _L4.w;
                float time = _SE_WxParams.w;
                float3 right = UNITY_MATRIX_V[0].xyz, up = UNITY_MATRIX_V[1].xyz;
                float3 flatRight = float3(right.x, 0, right.z);
                flatRight = dot(flatRight, flatRight) > 1e-4 ? normalize(flatRight) : float3(1, 0, 0);
                Varyings o;
                o.uv = v.positionOS.xy + .5;
                if (mode > 1.5)
                {
                    // a lightning bolt from the cloud base to the struck ground
                    float4 s = _SE_Strikes[min(id, 3u)];
                    float amp = _SE_StrikeAmp[min(id, 3u)];
                    float age = time - s.w;
                    if (amp <= 0 || age < 0 || age > .5 || _SE_WxParams.y <= .001) return Collapse();
                    float top = SE_CLOUD_BASE + 1.5, h = top - s.y;
                    float width = h * .32;
                    float3 world = float3(s.x, s.y, s.z) + flatRight * (v.positionOS.x * width) + float3(0, (v.positionOS.y + .5) * h, 0);
                    o.positionCS = TransformWorldToHClip(world);
                    o.data = half4(amp * _SE_WxParams.y, 0, 0, 0);
                    o.seed = float2(frac(s.w * 7.13 + id * .37) * 50, age);
                    o.fogCoord = ComputeFogFactor(o.positionCS.z);
                    return o;
                }
                uint nx = max((uint)_L0.z, 1u);
                float2 k = _L0.xy + float2(id % nx, id / nx);
                float2 kk = k - _L2.xy * floor(k / _L2.xy);
                float4 h = Hash4(kk + mode * 13.7);
                float2 xz = (k + .5 + (h.xy - .5) * .9) * _L1.xy + _L1.zw;
                float2 rel = xz - _L4.yz;
                float dist = length(rel);
                if (dist > _L4.x) return Collapse();
                if (_L5.x < .5 && (xz.x < 0 || xz.x > _L5.y)) return Collapse();
                if (xz.y > 2 || xz.y < -_L5.z - 2) return Collapse();
                half4 w = SE_WeatherAt(xz);
                float cloud = w.r, rain = w.g, storm = w.b;
                float fade = _L2.z * saturate((_L4.x - dist) / (_L4.x * .22));
                // a hole where the camera looks through the cloud layer (mid zoom only)
                float hole = length(xz - _L3.xy) / max(_L3.z, 1e-3);
                fade *= lerp(1, smoothstep(.55, 1.15, hole), _L2.w);
                float alpha;
                float3 world;
                if (mode < .5)
                {
                    float d = saturate((cloud - .46) * 2.4) * .62 + storm * .85 + rain * .18;
                    alpha = saturate((d - h.z * .7) * 2.6) * lerp(.5, .86, saturate(storm * 1.4)) * fade;
                    if (alpha <= .004) return Collapse();
                    float size = _L1.x * _L3.w * (1.25 + h.w * .8) * (1 + storm * .65);
                    float y = SE_CLOUD_BASE + 1 + h.z * 3 + storm * h.w * 10;   // storms tower
                    world = float3(xz.x, y, xz.y) + (right * v.positionOS.x + up * v.positionOS.y) * size;
                    // intra-cloud lightning: storm cells flicker now and then (strikes near the camera are synced to thunder)
                    float2 cellKey = floor(xz / (_L1.xy * 4 / _L3.w));
                    float beat = time * 1.3 + Hash(cellKey) * 9;
                    float pick = Hash(cellKey + floor(beat) * 1.37);
                    float flick = storm > .5 && pick > 1 - (storm - .5) * .16 ? exp(-frac(beat) * 7) * (.6 + .4 * sin(time * 47)) : 0;
                    o.data = half4(alpha, storm, rain, flick * .8 + StrikeGlow(xz, 28));
                }
                else
                {
                    // rain curtains hang from the cloud base where it pours
                    if (h.z > .5) return Collapse();
                    // inside a storm system its exact field decides (the eye stays dry, the spiral bands pour)
                    half4 sw = SE_SystemsAt(xz);
                    if (sw.x > .01) rain = lerp(rain, max(sw.z, sw.w * .75), saturate(sw.x * 3));
                    alpha = saturate((rain - .32) * 2.2) * saturate(cloud * 1.5) * .34 * fade;
                    if (alpha <= .004) return Collapse();
                    float width = _L1.x * _L3.w * (1.1 + h.w * .7);
                    float top = SE_CLOUD_BASE + 1, bottom = -1.5;
                    world = float3(xz.x, 0, xz.y) + flatRight * (v.positionOS.x * width) + float3(0, lerp(bottom, top, v.positionOS.y + .5), 0);
                    o.data = half4(alpha, storm, rain, StrikeGlow(xz, 28) * .5);
                }
                o.positionCS = TransformWorldToHClip(world);
                o.seed = float2(h.w * 31.7 + h.x * 5.1, 0);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float mode = _L4.w;
                float time = _SE_WxParams.w;
                if (mode > 1.5)
                {
                    // bolt: a jagged path with a white-hot core and a blue glow, re-striking a few times
                    float y = i.uv.y, seed = i.seed.x, age = i.seed.y;
                    float path = (Noise(float2(y * 4.0, seed)) - .5) * .42 + (Noise(float2(y * 15.0, seed + 3.1)) - .5) * .16 + (Noise(float2(y * 46.0, seed + 7.7)) - .5) * .05;
                    float dx = abs(i.uv.x - .5 - path);
                    float sharp = _L5.w;
                    float core = exp(-dx * sharp), glow = exp(-dx * sharp * .16) * .22 * pow(saturate(sin(i.uv.x * 3.14159)), 2);   // no quad edges
                    float restrike = step(.32, frac(age * 9.0 + seed * .1));
                    float lit = (core * 5.5 + glow) * i.data.x * exp(-age * 4.5) * restrike;
                    lit *= smoothstep(1.0, .9, y);   // fades into the cloud base
                    return half4(half3(.78h, .84h, 1.0h) * lit, 0);
                }
                float2 d = i.uv * 2 - 1;
                half alphaV = i.data.x, storm = i.data.y, rain = i.data.z, flash = i.data.w;
                half3 sunCol = _MainLightColor.rgb;
                if (mode > .5)
                {
                    // curtain: falling streaks, soft at the sides, melting into the ground and the cloud
                    float streak = Noise(float2(i.uv.x * 26 + i.seed.x * 13, i.uv.y * 1.6 + time * 2.4));
                    streak = smoothstep(.35, .9, streak);
                    float edge = pow(saturate(sin(i.uv.x * 3.14159)), 2.6) * smoothstep(0, .3, i.uv.y) * smoothstep(1, .55, i.uv.y);
                    half a = (half)(edge * (.35 + .65 * streak)) * alphaV;
                    half3 c = lerp(half3(.55h, .59h, .66h), half3(.30h, .32h, .38h), storm) * (_SE_AmbientSky.rgb + sunCol * .35h) * 1.4h;
                    c += half3(.7h, .75h, .9h) * flash;
                    c = MixFog(c, i.fogCoord);
                    return half4(c * a, a);
                }
                float r2 = dot(d, d);
                if (r2 >= 1) discard;
                // a lumpy, eroded puff lit as a sphere (bright crowns toward the sun, dark bellies)
                float2 q = d * 1.6 + i.seed.x;
                float n = Noise(q + time * .02) * .6 + Noise(q * 2.3 - time * .015) * .4;
                float shape = saturate((1 - r2) * 1.7 - (1 - n) * .95);
                if (shape <= 0) discard;
                float3 nv = float3(d.x, d.y, sqrt(saturate(1 - r2)));
                float3 nw = normalize(UNITY_MATRIX_V[0].xyz * nv.x + UNITY_MATRIX_V[1].xyz * nv.y + UNITY_MATRIX_V[2].xyz * nv.z);
                half lit = (half)saturate(dot(nw, _MainLightPosition.xyz) * .55 + .45);
                half3 bright = lerp(half3(.97h, .97h, .98h), half3(.40h, .42h, .49h), storm) * (1 - rain * .22h);
                half3 dark = lerp(half3(.58h, .62h, .69h), half3(.12h, .13h, .17h), storm) * (1 - rain * .15h);
                half3 c = lerp(dark * (_SE_AmbientSky.rgb * 1.6h), bright * sunCol, lit);
                c += half3(.72h, .78h, 1.0h) * flash * (1.4h - lit * .5h);
                c = MixFog(c, i.fogCoord);
                half a = (half)shape * alphaV;
                return half4(c * a, a);
            }
            ENDHLSL
        }
    }
}
