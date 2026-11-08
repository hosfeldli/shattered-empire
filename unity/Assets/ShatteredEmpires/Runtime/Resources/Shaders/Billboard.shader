// Camera-facing particles for explosions, muzzle flashes, fire and smoke, drawn from a pooled
// StructuredBuffer in one call per blend mode. The fragment builds a soft procedural puff, so no
// textures are needed and thousands of particles cost one draw.
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
                float fogCoord : TEXCOORD3;
            };

            Varyings vert(Attributes v, uint id : SV_InstanceID)
            {
                SEParticle p = _Particles[id];
                Varyings o;
                float s, c;
                sincos(p.shape.x, s, c);
                float2 q = float2(v.positionOS.x * c - v.positionOS.y * s, v.positionOS.x * s + v.positionOS.y * c) * p.position.w;
                float3 right = UNITY_MATRIX_V[0].xyz;
                float3 up = UNITY_MATRIX_V[1].xyz;
                float3 world = p.position.xyz + float3(_SE_ImageOffset.x, 0, 0) + right * q.x + up * q.y;
                o.positionCS = TransformWorldToHClip(world);
                o.uv = v.uv;
                o.color = p.color;
                o.shape = p.shape;
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

            half4 frag(Varyings i) : SV_Target
            {
                float2 d = i.uv * 2 - 1;
                float r = length(d);
                float n = noise(d * 3.0 + i.shape.z) * 0.6 + noise(d * 7.0 - i.shape.z) * 0.4;
                float edge = 1 - smoothstep(0.35 * i.shape.y, 1.0, r + (n - 0.5) * 0.5);
                half3 color = i.color.rgb * (1 + i.shape.w * (1 - r));
                half a = i.color.a * edge;
                return half4(MixFog(color, i.fogCoord), a);
            }
            ENDHLSL
        }
    }
}
