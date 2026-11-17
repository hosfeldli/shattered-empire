// Instanced ground decals (blood where infantry fell, scorch): a flat quad per instance from the same
// StructuredBuffer layout as SE/InstancedLit, alpha-blended over the terrain and lit like the ground.
// Instance colour: rgb tint, a = opacity (fades with age on the CPU side).
Shader "SE/GroundDecal"
{
    Properties
    {
        _MainTex ("Decal (RGBA)", 2D) = "white" {}
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "Queue" = "Transparent-60" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            ZTest LEqual
            Cull Off
            Offset -1, -1
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fog
            #include "SECommon.hlsl"

            struct SEInstance { float4 row0, row1, row2, color; };
            StructuredBuffer<SEInstance> _Instances;
            float4 _SE_ImageOffset;
            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);

            struct Attributes { float3 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; float2 uv : TEXCOORD1; half4 color : TEXCOORD2; float fogCoord : TEXCOORD3; };

            Varyings vert(Attributes v, uint id : SV_InstanceID)
            {
                SEInstance inst = _Instances[id];
                float3x4 m = float3x4(inst.row0, inst.row1, inst.row2);
                Varyings o;
                o.positionWS = mul(m, float4(v.positionOS, 1)) + float3(_SE_ImageOffset.x, 0, 0);
                // Pulled toward the eye along the view ray (screen position unchanged): a polygon offset alone is
                // too small for the long orthographic match camera, and decals must also clear the draped road
                // and pad overlays (SE/GroundOverlay) that sit a few millimetres above the terrain.
                // (kept small: decals draw after units, so a large pull would paint over the feet of troops standing on them)
                float bias = .012 + (unity_OrthoParams.w > .5 ? unity_OrthoParams.y * .0006 : _SE_EyeOffset * .36 * .0006);   // telephoto: as orthographic at that zoom
                o.positionCS = TransformWorldToHClip(o.positionWS + GetWorldSpaceNormalizeViewDir(o.positionWS) * bias);
                o.uv = v.uv;
                o.color = inst.color;
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half4 tex = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                half a = tex.a * i.color.a;
                clip(a - .02h);
                half3 albedo = SRGBToLinear(saturate(tex.rgb * i.color.rgb));
                half3 color = SE_Shade(albedo, i.positionWS, half3(0, 1, 0), 0);
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), a * SE_Visibility(i.positionWS));
            }
            ENDHLSL
        }
    }
}
