// The mushroom cloud of a strategic burst as one continuous volume (EffectsRenderer.Mushroom.cs, 2026-11-19):
// a lathe mesh (ground surge, stem and toroidal cap) rebuilt on the CPU each frame from the cloud's evolving
// profile. Here it billows: the vertices are pushed along their normals by 3D noise that is advected along the
// cloud's circulation (up the stem, out over the cap, down its rim), the surface is bump-lit from the same
// noise (wrapped sun, sky ambient, darker underside and folds), glows from the fireball inside while it is hot,
// feathers at its silhouette and erodes into wisps as it dies. Two passes: a depth pre-pass (the near surface
// only, so the volume never shows its own far side through itself) and the blended colour pass.
//
// Vertex data: COLOR rgb albedo (sRGB) / a opacity; TEXCOORD0 x heat, y billow amplitude (world), z noise
// frequency (1 / world), w erosion 0..1; TEXCOORD1 xyz the cloud's base (world), w seed; TANGENT xyz the
// circulation velocity at the vertex (world units / s), w the cloud's age (s).
Shader "SE/NukePlume"
{
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent-5" "RenderType" = "Transparent" }
        HLSLINCLUDE
        #include "SECommon.hlsl"
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
        float4 _SE_ImageOffset;
        float _SE_SoftParticles;

        struct Attributes
        {
            float3 position : POSITION;
            float3 normal : NORMAL;
            float4 tangent : TANGENT;
            float4 color : COLOR;
            float4 uv0 : TEXCOORD0;
            float4 uv1 : TEXCOORD1;
        };
        struct Varyings
        {
            float4 positionCS : SV_POSITION;
            float3 world : TEXCOORD0;
            float3 normal : TEXCOORD1;
            float3 nq : TEXCOORD2;       // noise domain (advected, cloud-local)
            half4 color : COLOR;
            float4 data : TEXCOORD3;     // heat, amplitude, frequency, erosion
            float fog : TEXCOORD4;
        };

        float hash3(float3 p)
        {
            p = frac(p * .3183099 + .1);
            p *= 17.0;
            return frac(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float noise3(float3 x)
        {
            float3 i = floor(x), f = frac(x);
            f = f * f * (3 - 2 * f);
            return lerp(lerp(lerp(hash3(i), hash3(i + float3(1, 0, 0)), f.x), lerp(hash3(i + float3(0, 1, 0)), hash3(i + float3(1, 1, 0)), f.x), f.y),
                        lerp(lerp(hash3(i + float3(0, 0, 1)), hash3(i + float3(1, 0, 1)), f.x), lerp(hash3(i + float3(0, 1, 1)), hash3(i + float3(1, 1, 1)), f.x), f.y), f.z);
        }
        float fbm3(float3 p) { return noise3(p) * .5 + noise3(p * 2.03 + 1.7) * .3 + noise3(p * 4.11 + 3.1) * .2; }
        // rounded billows: the cauliflower look of a convective cloud (bright domes, dark creases)
        float billow(float3 p) { float n = fbm3(p); return 1 - abs(n * 2 - 1) * .55 - .25 + n * .25; }

        Varyings vert(Attributes v)
        {
            Varyings o;
            float freq = v.uv0.z, age = v.tangent.w;
            float3 local = v.position - v.uv1.xyz;
            float3 nq = local * freq - v.tangent.xyz * age * freq + v.uv1.w;
            float n = fbm3(nq);
            float3 world = v.position + v.normal * (n - .42) * 2 * v.uv0.y;
            world.x += _SE_ImageOffset.x;
            o.world = world;
            o.positionCS = TransformWorldToHClip(world);
            o.normal = v.normal;
            o.nq = nq;
            o.color = v.color;
            o.data = v.uv0;
            o.fog = ComputeFogFactor(o.positionCS.z);
            return o;
        }

        // opacity and the fine billow height at this pixel (shared by both passes)
        float PlumeAlpha(Varyings i, float3 n, out float h)
        {
            h = billow(i.nq * 2.3);
            float3 view = normalize(_WorldSpaceCameraPos - i.world);
            float ndv = abs(dot(n, view));
            float a = i.color.a * smoothstep(.02, .42, ndv + (h - .5) * .45);   // feathered, lumpy silhouette
            a *= saturate((h - i.data.w) * 4.5 + 1);                              // dying cloud: erodes into wisps
            return a;
        }
        ENDHLSL

        // depth pre-pass: the near surface of the volume only
        Pass
        {
            Name "PlumeDepth"
            Tags { "LightMode" = "SRPDefaultUnlit" }
            ZWrite On
            ColorMask 0
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment fragDepth
            half4 fragDepth(Varyings i) : SV_Target
            {
                float h;
                clip(PlumeAlpha(i, normalize(i.normal), h) - .45);
                return 0;
            }
            ENDHLSL
        }

        Pass
        {
            Name "Plume"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            ZTest LEqual
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            half4 frag(Varyings i) : SV_Target
            {
                float3 n = normalize(i.normal);
                float h;
                float a = PlumeAlpha(i, n, h);
                // bump the normal with the billow height (screen-space surface gradient)
                float3 dpdx = ddx(i.world), dpdy = ddy(i.world);
                float dhdx = ddx(h), dhdy = ddy(h);
                float3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
                float det = dot(dpdx, r1);
                float3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
                float3 nb = normalize(abs(det) * n - grad * 1.6);
                float3 sun = normalize(_MainLightPosition.xyz);
                float3 view = normalize(_WorldSpaceCameraPos - i.world);
                float wrapped = pow(saturate(dot(nb, sun) * .5 + .5), 1.5);
                float behind = pow(saturate(dot(-view, sun)), 6) * (1 - abs(dot(n, view))) * 1.6;   // silver lining
                float folds = lerp(.58, 1.0, saturate(h * 1.5 - .15));                                 // dark creases
                float under = lerp(.62, 1.0, saturate(nb.y * .6 + .55));                               // shaded underside
                half3 light = SE_Ambient(nb) * .9 + _MainLightColor.rgb * (wrapped * .9 + behind) * (1 - SE_CloudShadow(i.world));
                half3 color = SRGBToLinear(saturate(i.color.rgb * clamp(light, .16, 1.6) * folds * under));
                // the fireball inside: orange through the folds, yellow-white where it is hottest
                float heat = i.data.x;
                half3 fire = lerp(half3(1, .30, .05), half3(1, .78, .42), saturate(heat * .5 + h - .6));
                color += fire * heat * (.35 + h * .9);
                if (_SE_SoftParticles > .5)
                {
                    float2 suv = GetNormalizedScreenSpaceUV(i.positionCS);
                    float scene = LinearEyeDepth(SampleSceneDepth(suv), _ZBufferParams);
                    float here = LinearEyeDepth(i.positionCS.z, _ZBufferParams);
                    a *= saturate((scene - here) / .35);
                }
                return half4(MixFog(color, i.fog), saturate(a));
            }
            ENDHLSL
        }
    }
}
