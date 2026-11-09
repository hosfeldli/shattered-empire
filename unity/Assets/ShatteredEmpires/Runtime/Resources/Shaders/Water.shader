// Sea, lakes, rivers and streams. Vertex colour alpha carries the water depth at that point (0 at the
// shoreline, 1 deep), sampled from the same ground the terrain is drawn with, so colour, clarity and
// shore foam follow the real coastline.
//
// Everything fine-grained (chop, foam texture, sharp sun glint, rain rings) fades out with distance
// from the camera, so from the strategic view water reads as calm, clean colour instead of shimmering
// noise; the shoreline fades in from transparent, so lake edges never show the hex they were built on.
Shader "SE/Water"
{
    Properties
    {
        _DeepColor ("Deep", Color) = (0.07, 0.24, 0.36, 1)
        _MidColor ("Mid", Color) = (0.12, 0.40, 0.48, 1)
        _ShallowColor ("Shallow", Color) = (0.40, 0.64, 0.60, 1)
        _RiverColor ("River", Color) = (0.26, 0.44, 0.42, 1)
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent-50" }
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fog
            #include "SECommon.hlsl"
            CBUFFER_START(UnityPerMaterial)
                half4 _DeepColor;
                half4 _MidColor;
                half4 _ShallowColor;
                half4 _RiverColor;
            CBUFFER_END
            float _SE_Wetness;
            float _SE_Rain;    // rain intensity at the camera (rings on the water)
            float4 _SE_Wind;   // xy direction, z strength

            struct Attributes { float3 positionOS : POSITION; half4 color : COLOR; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                half4 color : TEXCOORD1;
                float fogCoord : TEXCOORD2;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                float3 p = TransformObjectToWorld(v.positionOS);
                float t = _Time.y;
                // a gentle swell only where the water is deep enough to carry it
                p.y += (sin(p.x * 1.1 + t * 0.9) + sin(p.z * 1.6 - t * 0.7)) * 0.008 * saturate(v.color.a * 2 - 0.4);
                o.positionWS = p;
                o.color = v.color;
                o.positionCS = TransformWorldToHClip(p);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            float hash21(float2 p) { return frac(sin(dot(p, float2(41.3, 289.1))) * 43758.5); }
            float vnoise(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                float2 u = f * f * (3 - 2 * f);
                return lerp(lerp(hash21(i), hash21(i + float2(1, 0)), u.x), lerp(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), u.x), u.y);
            }

            half4 frag(Varyings i) : SV_Target
            {
                float t = _Time.y;
                float2 wind = _SE_Wind.z > 0 ? normalize(_SE_Wind.xy) : float2(0.8, 0.35);
                float windS = _SE_Wind.z > 0 ? _SE_Wind.z : 0.4;
                float2 p = i.positionWS.xz;
                float camDist = distance(_WorldSpaceCameraPos.xyz, i.positionWS);
                // fine detail exists only up close: no sub-pixel ripples to shimmer at a distance
                half detail = saturate(1.0 - (camDist - 12.0) / 45.0);
                half mid = saturate(1.0 - (camDist - 40.0) / 120.0);

                // long swells (always), wind chop and noise (near only)
                float2 g = float2(0, 0);
                g += float2(1.7, 0.4) * cos(dot(p, float2(1.7, 0.4)) * 1.6 + t * 1.1) * mid;
                g += float2(-0.6, 2.1) * cos(dot(p, float2(-0.6, 2.1)) * 1.3 + t * 0.9) * mid;
                g += wind * 2.4 * cos(dot(p, wind) * 6.0 + t * 2.6) * (0.3 + windS) * detail;
                g += (float2(vnoise(p * 4 + t * 0.4), vnoise(p * 4 - t * 0.35)) - 0.5) * 1.2 * detail;
                if (_SE_Rain > 0.01 && detail > 0.01)
                {
                    float2 cell = floor(p * 7), f = frac(p * 7) - 0.5;
                    float ph = frac(t * 1.3 + hash21(cell));
                    float ring = abs(length(f) - ph * 0.5);
                    g += f * (1 - smoothstep(0, 0.07, ring)) * (1 - ph) * 9 * _SE_Rain * detail;
                }
                half3 n = normalize(half3(-g.x * 0.02, 1, -g.y * 0.02));

                half depth = saturate(i.color.a);
                // rivers and streams carry silt; standing water is clearer and bluer
                half river = saturate(i.color.r);   // the mesh marks running water with r = 1
                half3 albedo = depth < 0.35 ? lerp(_ShallowColor.rgb, _MidColor.rgb, depth / 0.35) : lerp(_MidColor.rgb, _DeepColor.rgb, saturate((depth - 0.35) / 0.65));
                albedo = lerp(albedo, _RiverColor.rgb, river * 0.7h);

                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                half ndl = saturate(dot(n, sun.direction));
                half3 ambient = SampleSH(half3(0, 1, 0));
                half fresnel = 0.04h + 0.96h * pow(1.0h - saturate(dot(n, viewDir)), 5.0h);
                // glint: tight and bright up close, a broad soft sheen far away (never single-pixel sparkle)
                half power = lerp(48.0h, 260.0h, detail);
                half spec = pow(saturate(dot(n, normalize(sun.direction + viewDir))), power) * lerp(0.35h, 1.4h, detail);
                spec = min(spec, 0.9h) * lerp(0.4h, 1.0h, sun.shadowAttenuation);
                half3 color = albedo * (sun.color * (0.35h + 0.5h * ndl) * lerp(0.6h, 1.0h, sun.shadowAttenuation) + ambient * 0.85h);
                color += ambient * 1.1h * fresnel * 0.55h + sun.color * spec;

                // shore foam: a lapping band (textured up close, a soft pale rim from afar)
                half lap = 0.5h + 0.5h * sin(t * 1.2 + p.x * 1.9 + p.y * 1.5);
                half foamEdge = 1.0h - smoothstep(0.0h, 0.05h + lap * 0.04h, depth);
                half foamTex = lerp(0.55h, smoothstep(0.3h, 0.7h, vnoise(p * 9 + float2(t * 0.25, -t * 0.18))), detail);
                half foam = foamEdge * foamTex * (1.0h - river * 0.6h);
                color = lerp(color, half3(0.9h, 0.93h, 0.94h) * (sun.color * 0.55h + ambient * 0.6h), foam * 0.7h);
                color *= 1.0h - _SE_Wetness * 0.1h;

                // transparent at the waterline, opaque in the deep: the edge melts into the shore
                half alpha = lerp(0.18h, 0.93h, smoothstep(0.0h, 0.45h, depth)) + fresnel * 0.05h;
                alpha = max(alpha, foam * 0.75h);
                alpha *= smoothstep(0.0h, 0.03h, depth + foam * 0.02h);
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), saturate(alpha));
            }
            ENDHLSL
        }
    }
}
