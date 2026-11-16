// Blast-front distortion: an expanding hemisphere that refracts the scene behind it. The camera's opaque
// colour copy is resampled with an offset along the dome's screen-space normal, strongest at the rim
// where the shock front is seen edge-on, plus a faint hot shimmer and brightening at the front.
// Requires the camera opaque texture (Atmosphere enables it while a wave is live).
Shader "SE/Shockwave"
{
    Properties
    {
        _Strength ("Strength", Float) = 0.04
        _Front ("Front brightness", Float) = 0.15
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "Queue" = "Transparent-100" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Distort"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareOpaqueTexture.hlsl"
            float _Strength, _Front;
            float4 _SE_ImageOffset;
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; };
            struct Varyings { float4 positionCS : SV_POSITION; float4 screen : TEXCOORD0; float3 normalWS : TEXCOORD1; float3 positionWS : TEXCOORD2; };

            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS) + float3(_SE_ImageOffset.x, 0, 0);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.screen = ComputeScreenPos(o.positionCS);
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float3 n = normalize(i.normalWS);
                float3 view = normalize(GetWorldSpaceViewDir(i.positionWS));
                float rim = 1 - saturate(abs(dot(n, view)));
                float edge = pow(rim, 3.0);
                float2 uv = i.screen.xy / i.screen.w;
                float3 nv = TransformWorldToViewDir(n);
                float shimmer = sin(i.positionWS.x * 23 + _Time.y * 31) * sin(i.positionWS.z * 19 - _Time.y * 27);
                float2 offset = nv.xy * edge * _Strength + shimmer * edge * _Strength * .15;
                half3 scene = SampleSceneColor(saturate(uv + offset));
                scene += scene * edge * _Front;
                // Alpha follows the rim so the dome's face is invisible and only the bending front shows.
                return half4(scene, saturate(edge * 1.6));
            }
            ENDHLSL
        }
    }
}
