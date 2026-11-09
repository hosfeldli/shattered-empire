// Terrain chunks: vertex-coloured biome surface with world-space detail so large areas never look
// uniform; slope rock; developed city ground (worn paving and packed earth, so districts sit in the
// land instead of on grass pads); shelled no-man's land (churned mud and shell holes); rain-wet ground;
// drifting cloud shadows; fog of war. Meshes are built off the main thread by Burst jobs.
Shader "SE/Terrain"
{
    Properties
    {
        _DetailScale ("Detail scale", Float) = 0.9
        _DetailStrength ("Detail strength", Range(0, 0.5)) = 0.17
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
        float _SE_Wetness;   // global rain wetness (regional wetness comes from the ground field)

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
                // three octaves of world-space variation: mottled grass, soil, scree; a macro layer breaks
                // up large uniform areas at strategic zoom
                half detail = SE_Noise(p) * 0.55h + SE_Noise(p * 3.7) * 0.3h + SE_Noise(p * 11.0) * 0.15h;
                half macro = SE_Noise(p * 0.07) * 0.6h + SE_Noise(p * 0.19) * 0.4h;
                half3 albedo = i.color.rgb * (1.0h + (detail - 0.5h) * 2.0h * _DetailStrength) * (0.9h + macro * 0.2h);
                // steep slopes show rock, with strata on cliffs
                half steep = saturate((1.0h - n.y) * 3.2h - 0.35h);
                half strata = 0.85h + 0.15h * sin(i.positionWS.y * 26.0 + detail * 3.0);
                half3 rock = half3(0.38h, 0.36h, 0.33h) * (0.8h + detail * 0.35h) * strata;
                albedo = lerp(albedo, rock, steep * i.color.a);

                float4 gf = SE_Ground(i.positionWS);
                half flat = 1.0h - steep;
                // city districts: worn paving, gravel and packed earth (no grass pads under buildings)
                // patchy, never a slab: lighter flagstones and sandy packed earth, with gardens, verges
                // and scrub surviving between them, and a soft edge where the district meets the country
                half paveMix = smoothstep(0.35h, 0.75h, SE_Noise(p * 2.3));
                half3 pave = lerp(half3(0.58h, 0.55h, 0.5h), half3(0.52h, 0.46h, 0.37h), paveMix) * (0.88h + detail * 0.24h);
                half green = smoothstep(0.55h, 0.8h, SE_Noise(p * 1.3 + 11.7));
                half district = smoothstep(0.15h, 0.85h, saturate(gf.r)) * (1.0h - green * 0.7h);
                albedo = lerp(albedo, pave, district * 0.75h * flat);
                // no-man's land: churned mud, shell holes and standing water in the deepest ones
                half scar = saturate(gf.g);
                half holes = smoothstep(0.62h, 0.8h, SE_Noise(p * 4.1 + 3.3)) * saturate(gf.a + scar);
                half3 mud = half3(0.25h, 0.2h, 0.15h) * (0.75h + detail * 0.5h);
                albedo = lerp(albedo, mud, scar * 0.92h);
                albedo = lerp(albedo, half3(0.12h, 0.1h, 0.08h), holes * 0.7h);
                // wet ground darkens and gains a sheen
                half wet = saturate(max(_SE_Wetness, gf.b) + holes * scar * 0.5h);
                albedo *= 1.0h - wet * 0.32h;

                half3 color = SE_Shade(albedo, i.positionWS, n, 0);
                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight();
                half sheen = pow(saturate(dot(n, normalize(sun.direction + viewDir))), 60.0h) * wet * 0.5h;
                color += sun.color * sheen;
                color *= 1.0h - SE_CloudShadow(i.positionWS);
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
