// Procedurally instanced lit geometry: units, building modules, trees, props, craters. Per-instance
// transform and colour come from a StructuredBuffer (one GPU upload per batch per change), drawn
// with Graphics.RenderMeshPrimitives. No GameObject per instance.
Shader "SE/InstancedLit"
{
    Properties
    {
        _Gloss ("Gloss", Range(0, 1)) = 0.1
        _Surface ("Surface", Float) = 0
        _Wind ("Wind", Float) = 0
        _Cull ("Cull", Float) = 2
        _LeavesTex ("Leafy branch cutout", 2D) = "white" {}
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }
        Cull [_Cull]

        HLSLINCLUDE
        #include "SECommon.hlsl"
        #include "SESurfaces.hlsl"
        struct SEInstance
        {
            float4 row0;   // object-to-world 3x4 rows
            float4 row1;
            float4 row2;
            float4 color;  // rgb albedo, a = emission
        };
        StructuredBuffer<SEInstance> _Instances;
        float4 _SE_ImageOffset;   // x: world-wrap image shift for this draw
        float _Gloss;
        float _Surface;
        float _Wind;
        TEXTURE2D(_LeavesTex); SAMPLER(sampler_LeavesTex);

        void SE_InstanceTransform(uint id, float3 positionOS, float3 normalOS, out float3 positionWS, out float3 normalWS, out float4 color)
        {
            SEInstance inst = _Instances[id];
            float3x4 m = float3x4(inst.row0, inst.row1, inst.row2);
            positionWS = mul(m, float4(positionOS, 1.0)) + float3(_SE_ImageOffset.x, 0, 0);
            if (_Wind > 0.5)
            {
                float h = max(0.0, positionOS.y);
                float phase = dot(float2(inst.row0.w, inst.row2.w), float2(.74, 1.21));
                float gust = .55 + .45 * sin(_Time.y * .63 + phase * .37);
                float sway = sin(_Time.y * 1.8 + phase) * .7 + sin(_Time.y * 3.7 + phase * 1.43) * .3;
                float2 wind = _SE_Wind.xy / max(.15, length(_SE_Wind.xy));
                float weight = _Wind > 1.5 ? h * .9 : h * h;
                float bend = weight * (.006 + min(_SE_Wind.z, 3) * .012) * (gust + sway * .36);
                positionWS.xz += bend * wind;
            }
            // non-uniform scale: normals use the inverse transpose of the 3x3 part, which is the
            // cofactor matrix (rows r1×r2, r2×r0, r0×r1) up to the determinant's scale
            float3x3 m3 = (float3x3)m;
            float3x3 cof = float3x3(cross(m3[1], m3[2]), cross(m3[2], m3[0]), cross(m3[0], m3[1]));
            normalWS = normalize(mul(cof, normalOS));
            if (_Wind > 1.5) normalWS = normalize(lerp(normalWS, float3(0, 1, 0), .65));
            color = inst.color;
        }
        ENDHLSL

        Pass
        {
            Name "ForwardLit"
            AlphaToMask On
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHTS
            #pragma multi_compile_fog

            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float4 vcolor : COLOR; float2 uv : TEXCOORD0; float2 surface : TEXCOORD1; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                half3 normalWS : TEXCOORD1;
                half4 color : TEXCOORD2;
                float fogCoord : TEXCOORD3;
                float3 materialPos : TEXCOORD4;
                half3 materialNormal : TEXCOORD5;
                nointerpolation uint surface : TEXCOORD6;
                float2 uv : TEXCOORD7;
            };

            Varyings vert(Attributes v, uint instanceID : SV_InstanceID)
            {
                Varyings o;
                float3 p, n; float4 c;
                SE_InstanceTransform(instanceID, v.positionOS, v.normalOS, p, n, c);
                o.positionWS = p;
                o.normalWS = n;
                // vertex colour tints parts of a mesh (windows, tracks, roofs); white keeps the instance colour
                // Bark keeps its own warm albedo rather than inheriting a green canopy tint.
                half3 tint = v.surface.x == 13 || _Wind > .5 && v.vcolor.r > v.vcolor.g * 1.15 ? half3(1, 1, 1) : c.rgb;
                o.color = half4(tint * v.vcolor.rgb, c.a * v.vcolor.a);
                o.positionCS = TransformWorldToHClip(p);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                SEInstance inst = _Instances[instanceID];
                float3 s = float3(length(float3(inst.row0.x, inst.row1.x, inst.row2.x)),
                    length(float3(inst.row0.y, inst.row1.y, inst.row2.y)), length(float3(inst.row0.z, inst.row1.z, inst.row2.z)));
                o.materialPos = v.positionOS * s;
                o.materialNormal = v.normalOS;
                o.surface = (uint)max(v.surface.x, _Surface);
                o.uv = v.uv;
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 n = normalize(i.normalWS);
                half3 albedo = i.color.rgb;
                half photoVariation = 1.0h;
                half smoothness = _Gloss;
                half coverage = 1;
                if (i.surface == 12u)
                {
                    half4 leaf = SAMPLE_TEXTURE2D(_LeavesTex, sampler_LeavesTex, i.uv);
                    clip(leaf.a - .35h);
                    coverage = leaf.a;
                    albedo *= .65h + leaf.rgb * 2.5h;
                }
                else if (i.surface == 13u) smoothness = .14h;
                else if (i.surface != 0u)
                {
                    half4 surface = SE_Surface(i.materialPos, i.materialNormal, i.surface);
                    smoothness = surface.b;
                    if (SE_HasPhoto(i.surface))
                    {
                        half3 photo = SE_Architecture(i.materialPos, i.materialNormal, i.surface);
                        half luminance = dot(photo, half3(.25h, .60h, .15h));
                        half average = i.surface == 1u ? .32h : i.surface == 2u ? .13h : i.surface == 3u ? .25h : .15h;
                        photoVariation = clamp(luminance / average, i.surface == 2u ? .60h : .82h, i.surface == 2u ? 1.42h : 1.20h);
                        n = SE_Relief(i.positionWS, n, luminance, i.surface == 2u ? .0007h : .0003h);
                    }
                    else
                    {
                        albedo *= (0.58h + surface.r * 0.53h) * (1.0h - surface.a * 0.15h);
                        n = SE_Relief(i.positionWS, n, surface.g, i.surface == 8u ? .00035h : .0015h);
                    }
                }
                half3 color = SE_Shade(SRGBToLinear(saturate(albedo)) * photoVariation, i.positionWS, n, i.color.a * _SE_CityPower);
                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                if (_Wind > .5)
                    color += SRGBToLinear(albedo) * sun.color * .12h * saturate(dot(-n, sun.direction)) * sun.shadowAttenuation;
                half spec = pow(saturate(dot(n, normalize(sun.direction + viewDir))), lerp(12.0h, 78.0h, smoothness))
                    * smoothness * smoothness * sun.shadowAttenuation;
                if (i.surface == 9u)
                {
                    half fresnel = pow(1.0h - saturate(dot(n, viewDir)), 4.0h);
                    color += lerp(half3(0.05h, 0.07h, 0.09h), SE_Ambient(reflect(-viewDir, n)), fresnel) * 0.23h;
                }
                color += sun.color * spec * _SE_Glare;
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), coverage);
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ZWrite On ZTest LEqual ColorMask 0 Cull [_Cull]
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float2 surface : TEXCOORD1; };
            struct DepthVaryings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; nointerpolation uint surface : TEXCOORD1; };
            DepthVaryings vert(Attributes v, uint instanceID : SV_InstanceID)
            {
                float3 p, n; float4 c;
                SE_InstanceTransform(instanceID, v.positionOS, v.normalOS, p, n, c);
                DepthVaryings o; o.positionCS = SE_ShadowPositionCS(p, n); o.uv = v.uv; o.surface = (uint)v.surface.x; return o;
            }
            half4 frag(DepthVaryings i) : SV_Target { if (i.surface == 12u) clip(SAMPLE_TEXTURE2D(_LeavesTex, sampler_LeavesTex, i.uv).a - .35h); return 0; }
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
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float2 surface : TEXCOORD1; };
            struct DepthVaryings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; nointerpolation uint surface : TEXCOORD1; };
            DepthVaryings vert(Attributes v, uint instanceID : SV_InstanceID)
            {
                float3 p, n; float4 c;
                SE_InstanceTransform(instanceID, v.positionOS, v.normalOS, p, n, c);
                DepthVaryings o; o.positionCS = TransformWorldToHClip(p); o.uv = v.uv; o.surface = (uint)v.surface.x; return o;
            }
            half4 frag(DepthVaryings i) : SV_Target { if (i.surface == 12u) clip(SAMPLE_TEXTURE2D(_LeavesTex, sampler_LeavesTex, i.uv).a - .35h); return 0; }
            ENDHLSL
        }
    }
}
