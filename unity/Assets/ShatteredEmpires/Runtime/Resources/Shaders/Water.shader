// Sea, lakes and rivers: depth-tinted, wind-rippled, sun glint and fresnel sky reflection.
// Vertex colour: rgb = shallow/deep tint, a = depth factor (0 shore .. 1 deep).
Shader "SE/Water"
{
    Properties
    {
        _DeepColor ("Deep", Color) = (0.04, 0.16, 0.24, 1)
        _ShallowColor ("Shallow", Color) = (0.22, 0.45, 0.5, 1)
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
                half4 _ShallowColor;
            CBUFFER_END
            float _SE_Wetness;
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
                p.y += (sin(p.x * 1.7 + t * 1.3) + sin(p.z * 2.3 - t * 1.1)) * 0.008 * v.color.a;
                o.positionWS = p;
                o.color = v.color;
                o.positionCS = TransformWorldToHClip(p);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float t = _Time.y;
                float2 wind = _SE_Wind.z > 0 ? _SE_Wind.xy : float2(0.7, 0.3);
                float2 p = i.positionWS.xz;
                // analytic ripple normal from layered travelling waves
                float2 g = float2(0, 0);
                g += float2(1.7, 0.4) * cos(dot(p, float2(1.7, 0.4)) * 3.0 + t * 1.6);
                g += float2(-0.6, 2.1) * cos(dot(p, float2(-0.6, 2.1)) * 2.4 + t * 1.2);
                g += wind * 4.0 * cos(dot(p, wind) * 7.0 + t * 3.0) * 0.4;
                half3 n = normalize(half3(-g.x * 0.03, 1, -g.y * 0.03));
                half depth = i.color.a;
                half3 albedo = lerp(_ShallowColor.rgb, _DeepColor.rgb, depth) * i.color.rgb;
                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                half fresnel = pow(1.0h - saturate(dot(n, viewDir)), 4.0h);
                half3 sky = SampleSH(half3(0, 1, 0)) * 1.1h;
                half spec = min(pow(saturate(dot(n, normalize(sun.direction + viewDir))), 180.0h) * 1.2h, 0.6h) * sun.shadowAttenuation;
                half3 color = albedo * (sun.color * saturate(sun.direction.y) * 0.6h + SampleSH(n)) + sky * fresnel * 0.5h + sun.color * spec;
                color *= 1.0h - _SE_Wetness * 0.15h;
                half alpha = lerp(0.55h, 0.92h, depth) + fresnel * 0.08h;
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), saturate(alpha));
            }
            ENDHLSL
        }
    }
}
