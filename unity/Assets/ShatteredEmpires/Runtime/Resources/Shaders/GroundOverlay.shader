// Draped ground overlays: streets, verges, kerbs, base plazas, socket pads, painted markings and field pads
// (CityRenderer's street mesh). These are thin layers a few millimetres apart that follow the terrain, and
// depth alone cannot order them: their tessellations differ from each other and from the terrain mesh, and
// the match camera is orthographic at long range, so they used to z-fight and stripe.
//
// Ordering is by painter's order instead: the CPU emits the mesh layer by layer (lowest lift first), and
// the colour pass is pulled toward the camera along the view ray (no change in screen position, only
// depth) so every layer passes the depth test against the terrain and against the layers below it; the
// last layer written wins, exactly once per pixel order. A separate unbiased depth pass writes the true
// surface depth, so units, buildings, water and bridges drawn later still test against the real ground
// (feet are not cut off, water does not cover bridge decks).
// Same vertex layout and instance buffer as SE/InstancedLit.
Shader "SE/GroundOverlay"
{
    Properties
    {
        _Gloss ("Gloss", Range(0, 1)) = 0.1
        _ViewBias ("Colour pass pull toward the camera (world units)", Float) = 0.035
        _ViewBiasOrtho ("Extra pull per unit of orthographic half-height", Float) = 0.0015
    }
    SubShader
    {
        // after the terrain (Geometry-10), before buildings, units and props (Geometry)
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry-5" }
        Cull Back

        HLSLINCLUDE
        #include "SECommon.hlsl"
        #include "SESurfaces.hlsl"
        struct SEInstance { float4 row0, row1, row2, color; };
        StructuredBuffer<SEInstance> _Instances;
        float4 _SE_ImageOffset;
        float _Gloss, _ViewBias, _ViewBiasOrtho;

        float3 SE_OverlayWorld(uint id, float3 positionOS)
        {
            SEInstance inst = _Instances[id];
            float3x4 m = float3x4(inst.row0, inst.row1, inst.row2);
            return mul(m, float4(positionOS, 1.0)) + float3(_SE_ImageOffset.x, 0, 0);
        }
        ENDHLSL

        // The true surface depth, written before the colour (URP draws SRPDefaultUnlit ahead of UniversalForward).
        // Order does not matter for correctness: the colour pass is biased past it either way.
        Pass
        {
            Name "OverlayDepth"
            Tags { "LightMode" = "SRPDefaultUnlit" }
            ZWrite On ZTest LEqual ColorMask 0
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            struct Attributes { float3 positionOS : POSITION; };
            float4 vert(Attributes v, uint id : SV_InstanceID) : SV_POSITION { return TransformWorldToHClip(SE_OverlayWorld(id, v.positionOS)); }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            ZWrite Off ZTest LEqual
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
                nointerpolation uint surface : TEXCOORD5;
            };

            Varyings vert(Attributes v, uint id : SV_InstanceID)
            {
                Varyings o;
                float3 p = SE_OverlayWorld(id, v.positionOS);
                o.positionWS = p;
                o.normalWS = normalize(v.normalOS);
                SEInstance inst = _Instances[id];
                o.color = half4(inst.color.rgb * v.vcolor.rgb, inst.color.a * v.vcolor.a);
                // Pull along the ray to the eye: for an orthographic camera that is the camera's back vector,
                // for a perspective one the direction to the eye; either way the pixel stays where it is.
                float bias = _ViewBias + (unity_OrthoParams.w > .5 ? unity_OrthoParams.y * _ViewBiasOrtho : 0);
                o.positionCS = TransformWorldToHClip(p + GetWorldSpaceNormalizeViewDir(p) * bias);
                o.fogCoord = ComputeFogFactor(TransformWorldToHClip(p).z);
                o.materialPos = v.positionOS;
                o.surface = (uint)v.surface.x;
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 n = normalize(i.normalWS);
                half3 albedo = i.color.rgb;
                half photoVariation = 1.0h;
                half smoothness = _Gloss;
                if (i.surface != 0u)
                {
                    half4 surface = SE_Surface(i.materialPos, n, i.surface);
                    smoothness = surface.b;
                    if (SE_HasPhoto(i.surface))
                    {
                        half3 photo = SE_Architecture(i.materialPos, n, i.surface);
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
                half spec = pow(saturate(dot(n, normalize(sun.direction + viewDir))), lerp(12.0h, 78.0h, smoothness))
                    * smoothness * smoothness * sun.shadowAttenuation;
                color += sun.color * spec * _SE_Glare;
                if (any(isnan(color)) || any(isinf(color))) color = SRGBToLinear(saturate(albedo)) * .35h;
                color = clamp(color, 0, 12.0h);
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), 1);
            }
            ENDHLSL
        }

        // Prepass / depth texture: the true surface.
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
            float4 vert(Attributes v, uint id : SV_InstanceID) : SV_POSITION { return TransformWorldToHClip(SE_OverlayWorld(id, v.positionOS)); }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
