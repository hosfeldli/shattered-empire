// Terrain chunks: vertex-coloured biome surface with world-space detail so large areas never look
// uniform; slope rock; developed city ground (worn paving and packed earth, so districts sit in the
// land instead of on grass pads); shelled no-man's land (churned mud and shell holes); rain-wet ground;
// drifting cloud shadows; fog of war. Meshes are built off the main thread by Burst jobs.
Shader "SE/Terrain"
{
    Properties
    {
        _TerrainAtlas ("Grass / earth / limestone / aggregate", 2D) = "white" {}
        _GrassTex ("Short grass", 2D) = "white" {}
        _GrassNormal ("Grass normal", 2D) = "bump" {}
        _DetailScale ("Detail scale", Float) = 1.35
        _DetailStrength ("Detail strength", Range(0, 0.5)) = 0.10
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
        float4 _TerrainAtlas_TexelSize;
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
                float2 p = i.positionWS.xz * _DetailScale;
                half macro = SE_Noise(p * 0.035);
                half3 grass = SAMPLE_TEXTURE2D(_GrassTex, sampler_GrassTex, i.positionWS.xz * 7.0).rgb;
                half grassLuma = dot(grass, half3(.25h, .60h, .15h));
                half3 palette = SRGBToLinear(i.color.rgb);
                half nearDetail = 1.0h - smoothstep(8.0h, 32.0h, distance(_WorldSpaceCameraPos, i.positionWS));
                half3 albedo = palette * lerp(1.0h, clamp(grassLuma / .075h, .78h, 1.22h), nearDetail * .40h);
                // Close views retain the photograph's fine organic colour rather than
                // turning every blade into a high-contrast luminance pattern.
                albedo = lerp(albedo, grass * lerp(.85h, 1.12h, i.color.g), nearDetail * .12h);
                albedo *= 0.97h + macro * .06h;
                half steep = smoothstep(.16h, .58h, 1.0h - n.y);
                half3 weights = pow(abs(n), 4);
                weights /= max(dot(weights, half3(1, 1, 1)), .001h);
                half3 rock = GroundPhoto(i.positionWS.zy * .73, 2u) * weights.x
                    + GroundPhoto(p * .58, 2u) * weights.y + GroundPhoto(i.positionWS.xy * .73, 2u) * weights.z;
                rock *= half3(.93h, .94h, .93h);
                albedo = lerp(albedo, rock, steep * i.color.a);
                float4 gf = SE_Ground(i.positionWS);
                half3 earth = GroundPhoto(p * 1.13, 1u);
                half3 aggregate = GroundPhoto(p * 1.26, 3u);
                half district = smoothstep(.24h, .88h, gf.r) * (1.0h - steep);
                albedo = lerp(albedo, lerp(earth, aggregate, .54h), district * .74h);
                // Damage changes the material over the actual crater geometry. It does
                // not invent a second field of dark spots across otherwise intact land.
                half scar = saturate(gf.g);
                albedo = lerp(albedo, earth * half3(.64h, .61h, .56h), scar * .85h);
                half wet = saturate(max(_SE_Wetness, gf.b));
                albedo *= 1.0h - wet * .18h;
                half relief = lerp(grassLuma, dot(rock, half3(.3h, .5h, .2h)), steep);
                n = SE_Relief(i.positionWS, n, relief, .00012h + steep * .00050h);
                half3 grassNormal = UnpackNormal(SAMPLE_TEXTURE2D(_GrassNormal, sampler_GrassNormal, i.positionWS.xz * 7.0));
                n = normalize(n + half3(grassNormal.x, 0, grassNormal.y) * nearDetail * (1 - steep) * .10h);

                half3 color = SE_Shade(albedo, i.positionWS, n, 0);
                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight();
                half sheen = pow(saturate(dot(n, normalize(sun.direction + viewDir))), 80.0h) * wet * .12h;
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
