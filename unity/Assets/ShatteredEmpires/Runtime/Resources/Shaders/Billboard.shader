// Particles for combat and weather, drawn from a pooled StructuredBuffer in one call per blend mode.
// Kinds (extra.w): 0 soft puff (smoke, dust, fireballs), 1 flame (rising, flickering, white-hot core),
// 2 flat ring on the ground (shockwaves, dust rings), 3 streak stretched along extra.xyz (tracers,
// rain, sparks). Everything is procedural: no textures.
Shader "SE/Billboard"
{
    Properties
    {
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src", Float) = 5
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst", Float) = 10
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent" }
        Pass
        {
            Name "Particles"
            Tags { "LightMode" = "UniversalForward" }
            Blend [_SrcBlend] [_DstBlend]
            ZWrite Off
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "SECommon.hlsl"
            struct SEParticle
            {
                float4 position;   // xyz centre, w size
                float4 color;      // rgb, a opacity
                float4 shape;      // x rotation, y softness, z noise seed, w heat (emissive boost)
                float4 extra;      // xyz stretch vector (world), w kind
            };
            StructuredBuffer<SEParticle> _Particles;
            float4 _SE_ImageOffset;

            struct Attributes { float3 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                half4 color : TEXCOORD1;
                float4 shape : TEXCOORD2;
                float kind : TEXCOORD3;
                float fogCoord : TEXCOORD4;
                float3 positionWS : TEXCOORD5;
            };

            Varyings vert(Attributes v, uint id : SV_InstanceID)
            {
                SEParticle p = _Particles[id];
                Varyings o;
                float kind = p.extra.w;
                float3 centre = p.position.xyz + float3(_SE_ImageOffset.x, 0, 0);
                float3 world;
                if (kind > 1.5 && kind < 2.5)
                {
                    // flat on the ground
                    world = centre + float3(v.positionOS.x, 0, v.positionOS.y) * p.position.w;
                }
                else if (kind > 2.5)
                {
                    // a streak along the stretch vector, facing the camera across it
                    float3 axis = p.extra.xyz;
                    float len = max(length(axis), 1e-4);
                    float3 dir = axis / len;
                    float3 toCam = normalize(_WorldSpaceCameraPos - centre);
                    float3 side = normalize(cross(dir, toCam)) * p.position.w;
                    world = centre + dir * (v.positionOS.y * len) + side * v.positionOS.x;
                }
                else
                {
                    float s, c;
                    sincos(p.shape.x, s, c);
                    float2 q = float2(v.positionOS.x * c - v.positionOS.y * s, v.positionOS.x * s + v.positionOS.y * c) * p.position.w;
                    // flames stay upright and taller than wide
                    if (kind > 0.5) q = float2(v.positionOS.x * .52, (v.positionOS.y + .5) * 2.15) * p.position.w;
                    float3 right = UNITY_MATRIX_V[0].xyz;
                    float3 up = kind > 0.5 ? float3(0, 1, 0) : UNITY_MATRIX_V[1].xyz;
                    world = centre + right * q.x + up * q.y;
                }
                o.positionWS = world;
                o.positionCS = TransformWorldToHClip(world);
                o.uv = v.uv;
                o.color = p.color;
                o.shape = p.shape;
                o.kind = kind;
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            float hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }
            float noise(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                float2 u = f * f * (3 - 2 * f);
                return lerp(lerp(hash(i), hash(i + float2(1, 0)), u.x), lerp(hash(i + float2(0, 1)), hash(i + float2(1, 1)), u.x), u.y);
            }
            float fbm(float2 p) { return noise(p) * 0.55 + noise(p * 2.1) * 0.3 + noise(p * 4.3) * 0.15; }

            half4 frag(Varyings i) : SV_Target
            {
                float2 d = i.uv * 2 - 1;
                float t = _Time.y;
                half3 color;
                half a;
                if (i.kind > 0.5 && i.kind < 1.5)
                {
                    // flame: distorted upward-scrolling noise inside a teardrop, hot core to sooty tips
                    float2 uv = i.uv;
                    float speed = 1.25 + frac(i.shape.z * .13) * .7;
                    float2 q = float2(uv.x * 4.3 + i.shape.z, uv.y * 2.7 - t * speed);
                    float curl = fbm(q * .64 + float2(t * .18, -t * .28));
                    float n = fbm(q + float2(curl * 1.3, curl * .5));
                    float center = .5 + sin(uv.y * 6.0 - t * speed + i.shape.z) * uv.y * .10;
                    float width = lerp(.43, .012, uv.y);
                    float body = 1 - smoothstep(width * .22, width, abs(uv.x - center) + (n - .48) * .28);
                    body *= smoothstep(0.0, .035, uv.y) * (1 - smoothstep(.48 + n * .42, .97, uv.y));
                    body *= smoothstep(.20, .62, n + (1 - uv.y) * .25);
                    float heat = saturate((1 - uv.y) * .85 + n * .40);
                    color = lerp(half3(.34, .018, .002), half3(1, .31, .018), saturate(heat * 1.4));
                    color = lerp(color, half3(1, .72, .24), saturate(heat * 2 - 1.2));
                    color *= .85 + i.shape.w * .25;
                    a = body * i.color.a;
                    color *= i.color.rgb;
                }
                else if (i.kind > 1.5 && i.kind < 2.5)
                {
                    // ring: a sharp leading edge with a soft trail inside
                    float r = length(d);
                    float edge = smoothstep(0.78, 0.96, r) * (1 - smoothstep(0.96, 1.0, r));
                    float trail = smoothstep(0.3, 0.95, r) * (1 - smoothstep(0.95, 1.0, r)) * 0.35;
                    float n = noise(float2(atan2(d.y, d.x) * 6, t + i.shape.z));
                    a = (edge + trail) * (0.7 + 0.3 * n) * i.color.a;
                    color = i.color.rgb * (1 + i.shape.w);
                }
                else if (i.kind > 2.5)
                {
                    // streak: bright core along its length, soft sides
                    float side = 1 - smoothstep(0.0, 1.0, abs(d.x));
                    float along = smoothstep(-1.0, -0.6, d.y) * (1 - smoothstep(0.6, 1.0, d.y));
                    a = side * side * along * i.color.a;
                    color = i.color.rgb * (1 + i.shape.w);
                }
                else
                {
                    // puff: noisy soft sphere, lit from above for smoke
                    float r = length(d);
                    float n = fbm(d * 2.2 + i.shape.z + float2(0, -t * 0.15));
                    float edge = 1 - smoothstep(.12, .96, r + (n - .5) * .30);
                    edge *= .76 + .24 * fbm(d * 5.8 + i.shape.z * 1.3);
                    half lit = .69 + .30 * saturate(d.y * .8 + .4) + (n - .5) * .14;
                    color = i.color.rgb * (i.shape.w > 0 ? 1 + i.shape.w * (1 - r) : lit);
                    a = i.color.a * edge;
                }
                return half4(MixFog(SRGBToLinear(saturate(color)) * (1 + min(i.shape.w, 2)), i.fogCoord), saturate(a));
            }
            ENDHLSL
        }
    }
}
