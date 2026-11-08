// Terrain chunks: vertex-coloured biome surface with world-space detail so large areas never look
// uniform, slope-driven rock, weather wetness and the fog-of-war field. One draw per visible chunk
// image (Graphics.RenderMesh); meshes are built off the main thread by Burst jobs.
Shader "SE/Terrain"
{
    Properties
    {
        _DetailScale ("Detail scale", Float) = 0.9
        _DetailStrength ("Detail strength", Range(0, 0.5)) = 0.16
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry-10" }

        HLSLINCLUDE
        #include "SECommon.hlsl"
        CBUFFER_START(UnityPerMaterial)
            float _DetailScale;
            float _DetailStrength;
        CBUFFER_END
        float _SE_Wetness;   // 0 dry .. 1 soaked (regional weather)

        float SE_Hash(float2 p) { return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
        float SE_Noise(float2 p)
        {
            float2 i = floor(p), f = frac(p);
            float2 u = f * f * (3.0 - 2.0 * f);
            return lerp(lerp(SE_Hash(i), SE_Hash(i + float2(1, 0)), u.x), lerp(SE_Hash(i + float2(0, 1)), SE_Hash(i + float2(1, 1)), u.x), u.y);
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
                float2 p = i.positionWS.xz * _DetailScale;
                // two octaves of world-space variation (mottled grass, soil and scree)
                half detail = SE_Noise(p) * 0.65h + SE_Noise(p * 3.7) * 0.35h;
                half3 albedo = i.color.rgb * (1.0h + (detail - 0.5h) * 2.0h * _DetailStrength);
                // steep slopes show rock regardless of biome
                half steep = saturate((1.0h - n.y) * 3.2h - 0.35h);
                half3 rock = half3(0.36h, 0.34h, 0.31h) * (0.85h + detail * 0.3h);
                albedo = lerp(albedo, rock, steep * i.color.a);
                // rain darkens and saturates the ground
                albedo *= 1.0h - _SE_Wetness * 0.28h;
                half3 color = SE_Shade(albedo, i.positionWS, n, 0);
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), 1);
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
