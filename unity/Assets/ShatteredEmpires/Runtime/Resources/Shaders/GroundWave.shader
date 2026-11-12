Shader "SE/GroundWave"
{
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "Queue"="Transparent-20" "RenderType"="Transparent" }
        Pass
        {
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #pragma multi_compile_fog
            #include "SECommon.hlsl"
            float4 _SE_ImageOffset;
            struct Attributes { float3 position : POSITION; float4 color : COLOR; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 world : TEXCOORD0; half4 color : COLOR; float2 uv : TEXCOORD1; float fog : TEXCOORD2; };
            Varyings vert(Attributes v)
            {
                Varyings o; o.world = v.position + float3(_SE_ImageOffset.x, 0, 0); o.positionCS = TransformWorldToHClip(o.world);
                o.color = v.color; o.uv = v.uv; o.fog = ComputeFogFactor(o.positionCS.z); return o;
            }
            half4 frag(Varyings i) : SV_Target
            {
                half band = saturate(1 - abs(i.uv.y * 2 - 1)); band *= band;
                half variation = .7 + .3 * sin(i.world.x * 41 + i.world.z * 27);
                half3 color = SE_ApplyFog(SRGBToLinear(i.color.rgb) * (_SE_AmbientSky.rgb + .45), i.world, i.fog);
                return half4(color, i.color.a * band * variation * SE_Visibility(i.world));
            }
            ENDHLSL
        }
    }
}
