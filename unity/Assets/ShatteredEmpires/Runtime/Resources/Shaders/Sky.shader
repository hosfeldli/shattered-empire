// Procedural sky: zenith-to-horizon gradient, horizon haze that matches the scene fog, the sun with a
// soft glow, and an overcast blend driven by the weather at the camera.
Shader "SE/Sky"
{
    Properties
    {
        _Zenith ("Zenith", Color) = (0.24, 0.42, 0.66, 1)
        _Horizon ("Horizon", Color) = (0.7, 0.76, 0.8, 1)
        _Ground ("Below horizon", Color) = (0.42, 0.42, 0.4, 1)
        _Overcast ("Overcast", Range(0, 1)) = 0
        _Flash ("Flash", Range(0, 1)) = 0
    }
    SubShader
    {
        Tags { "Queue" = "Background" "RenderType" = "Background" "PreviewType" = "Skybox" "RenderPipeline" = "UniversalPipeline" }
        Cull Off ZWrite Off
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            CBUFFER_START(UnityPerMaterial)
                half4 _Zenith, _Horizon, _Ground;
                float _Overcast, _Flash;
            CBUFFER_END
            float _SE_Glare;
            struct Attributes { float3 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 dir : TEXCOORD0; };
            float CloudNoise(float2 p)
            {
                float2 i = floor(p), f = frac(p); f = f * f * (3 - 2 * f);
                float a = frac(sin(dot(i, float2(127.1, 311.7))) * 43758.5453);
                float b = frac(sin(dot(i + float2(1, 0), float2(127.1, 311.7))) * 43758.5453);
                float c = frac(sin(dot(i + float2(0, 1), float2(127.1, 311.7))) * 43758.5453);
                float d = frac(sin(dot(i + 1, float2(127.1, 311.7))) * 43758.5453);
                return lerp(lerp(a, b, f.x), lerp(c, d, f.x), f.y);
            }
            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(v.positionOS);
                o.dir = v.positionOS;
                return o;
            }
            half4 frag(Varyings i) : SV_Target
            {
                float3 d = normalize(i.dir);
                float h = d.y;
                half3 grey = half3(0.55, 0.58, 0.6);
                half3 zen = lerp(_Zenith.rgb, grey * 0.85, _Overcast);
                half3 hor = lerp(_Horizon.rgb, grey, _Overcast);
                half3 col = h > 0 ? lerp(hor, zen, pow(saturate(h), 0.55)) : lerp(hor, _Ground.rgb, saturate(-h * 4));
                float2 cloudUV = d.xz / max(.24, d.y + .25) * 1.6 + float2(_Time.y * .002, _Time.y * .001);
                float clouds = CloudNoise(cloudUV) * .68 + CloudNoise(cloudUV * 2.7 + 4.2) * .32;
                half cover = smoothstep(.79 - _Overcast * .42, .98 - _Overcast * .28, clouds) * saturate(h * 4 + .08);
                col = lerp(col, hor * .93h + .035h, cover * .64h);
                Light sun = GetMainLight();
                float s = saturate(dot(d, sun.direction));
                half sunFade = 1 - _Overcast * 0.85;
                col += sun.color * (pow(s, 1600) * 2.0 + pow(s, 70) * .08 + pow(s, 10) * .025) * sunFade * _SE_Glare;
                col += _Flash * half3(1, 0.95, 0.85) * 2;
                return half4(col, 1);
            }
            ENDHLSL
        }
    }
}
