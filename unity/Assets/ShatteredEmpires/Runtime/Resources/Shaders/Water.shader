// Shared lake/sea and flowing-channel water. The mesh is clipped against terrain;
// vertex depth provides a restrained shore transition without foam on dry land.
Shader "SE/Water"
{
    Properties
    {
        _Horizon ("Ocean beyond map boundary", Float) = 0
        _OceanBounds ("Playable columns, rows, wrapping", Vector) = (64, 64, 0, 0)
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
                float _Horizon;
                float4 _OceanBounds;
            CBUFFER_END
            float _SE_Rain;

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
                o.positionWS = TransformObjectToWorld(v.positionOS);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.color = v.color;
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                if (_Horizon > .5)
                {
                    // Exact offset-grid domain, without drawing any tile boundaries.
                    // One continuous plane fills the outside, including concave corners.
                    float row = -i.positionWS.z * (2.0 / 3.0);
                    float column = i.positionWS.x * .577350269 - row * .5;
                    float3 cube = float3(column, row, -column - row);
                    float3 rounded = floor(cube + .5), error = abs(rounded - cube);
                    if (error.x > error.y && error.x > error.z) rounded.x = -rounded.y - rounded.z;
                    else if (error.y > error.z) rounded.y = -rounded.x - rounded.z;
                    int r = (int)rounded.y;
                    int q = (int)rounded.x + (r - (r & 1)) / 2;
                    if (r >= 0 && r < (int)_OceanBounds.y && (_OceanBounds.z > .5 || q >= 0 && q < (int)_OceanBounds.x)) discard;
                }
                float physicalDepth = i.color.a * .9;
                clip(physicalDepth - .0005);
                half river = i.color.r;
                half coverage = river > .5h ? smoothstep(.005h, .11h, i.color.a) : smoothstep(.0005h, .012h, physicalDepth);
                half depth = saturate(physicalDepth * 3.5);
                depth = lerp(depth, max(depth, i.color.a * .5h), river);

                float2 p = i.positionWS.xz;
                float nearDetail = 1.0 - smoothstep(12.0, 65.0, distance(_WorldSpaceCameraPos, i.positionWS));
                float t = _Time.y;
                float2 wind = normalize(_SE_Wind.xy + float2(.001, .001));
                float2 gradient = float2(.8, .3) * cos(dot(p, float2(1.9, .8)) - t * .43)
                    + float2(-.25, .7) * cos(dot(p, float2(-.7, 2.1)) + t * .36);
                gradient += wind * cos(dot(p, wind) * 8.0 - t * 1.5) * nearDetail * .34;
                gradient += float2(.24, -.19) * sin(dot(p, float2(13.2, -8.7)) + t * 1.9) * nearDetail;
                half3 n = normalize(half3(-gradient.x * .012, 1, -gradient.y * .012));
                half3 view = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                half fresnel = .045h + .35h * pow(1.0h - saturate(dot(n, view)), 4.0h);
                // Absorption and a restrained sky reflection, in linear reflectance.
                half3 bed = lerp(half3(.09h, .115h, .10h), half3(.030h, .073h, .085h), depth);
                bed = lerp(bed, half3(.065h, .090h, .079h), river * .27h);
                half3 illumination = SE_Ambient(half3(0, 1, 0)) + sun.color * .6h * lerp(.65h, 1.0h, sun.shadowAttenuation);
                half skyVariation = .94h + .06h * SE_CloudNoise(p * .17 + wind * t * .008);
                half3 reflection = lerp(SE_Ambient(half3(0, 1, 0)) * half3(.72h, .88h, 1.08h), half3(.20h, .28h, .34h), .35h) * skyVariation;
                half spec = pow(saturate(dot(n, normalize(sun.direction + view))), 180.0h) * .34h * sun.shadowAttenuation;
                half3 color = lerp(bed * illumination, reflection, fresnel) + sun.color * spec;
                half alpha = coverage * lerp(.82h, .95h, saturate(depth * 3.0h));
                alpha = lerp(alpha, 1.0h, _Horizon);
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), alpha);
            }
            ENDHLSL
        }
    }
}
