#ifndef SE_COMMON_INCLUDED
#define SE_COMMON_INCLUDED
// Shared lighting for Shattered Empires' URP shaders: main light with shadows, additional lights,
// spherical-harmonics ambient, distance fog, and a soft fog-of-war field.

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

// fog of war: R8 texture covering one world period (x) by the map depth (z); 1 = visible
TEXTURE2D(_SE_FogTex); SAMPLER(sampler_SE_FogTex);
float4 _SE_FogParams;   // x = 1/period, y = 1/depth, z = enabled (0/1), w = explored-dim strength

float SE_Visibility(float3 positionWS)
{
    if (_SE_FogParams.z < 0.5) return 1.0;
    float2 uv = float2(positionWS.x * _SE_FogParams.x, positionWS.z * _SE_FogParams.y);
    return SAMPLE_TEXTURE2D_LOD(_SE_FogTex, sampler_SE_FogTex, uv, 0).r;
}

half3 SE_Shade(half3 albedo, float3 positionWS, half3 normalWS, half emission)
{
    float4 shadowCoord = TransformWorldToShadowCoord(positionWS);
    Light mainLight = GetMainLight(shadowCoord);
    half ndl = saturate(dot(normalWS, mainLight.direction));
    // wrapped diffuse keeps shadowed faces readable at strategic zoom
    half wrapDiffuse = saturate((dot(normalWS, mainLight.direction) + 0.35h) / 1.35h);
    half3 light = mainLight.color * (ndl * 0.75h + wrapDiffuse * 0.25h) * (mainLight.shadowAttenuation * mainLight.distanceAttenuation);
    #if defined(_ADDITIONAL_LIGHTS)
    uint count = GetAdditionalLightsCount();
    LIGHT_LOOP_BEGIN(count)
        Light l = GetAdditionalLight(lightIndex, positionWS);
        light += l.color * saturate(dot(normalWS, l.direction)) * l.distanceAttenuation;
    LIGHT_LOOP_END
    #endif
    half3 ambient = SampleSH(normalWS);
    half3 color = albedo * (light + ambient) + albedo * emission;
    return color;
}

half3 SE_ApplyFog(half3 color, float3 positionWS, float fogCoord)
{
    float vis = SE_Visibility(positionWS);
    // explored-but-unseen land is desaturated and darker; never fully black so the map stays readable
    half grey = dot(color, half3(0.3h, 0.59h, 0.11h));
    half3 dimmed = lerp(color, grey.xxx * 0.8h, 0.55h) * (1.0h - _SE_FogParams.w);
    color = lerp(dimmed, color, vis);
    return MixFog(color, fogCoord);
}

// clamp shadow casters to the near plane (URP's shadow caster convention)
float4 SE_ShadowClamp(float4 positionCS)
{
    #if UNITY_REVERSED_Z
    positionCS.z = min(positionCS.z, UNITY_NEAR_CLIP_VALUE);
    #else
    positionCS.z = max(positionCS.z, UNITY_NEAR_CLIP_VALUE);
    #endif
    return positionCS;
}

float3 _LightDirection;
float3 _LightPosition;

float4 SE_ShadowPositionCS(float3 positionWS, float3 normalWS)
{
    #if defined(_CASTING_PUNCTUAL_LIGHT_SHADOW)
    float3 lightDir = normalize(_LightPosition - positionWS);
    #else
    float3 lightDir = _LightDirection;
    #endif
    return SE_ShadowClamp(TransformWorldToHClip(ApplyShadowBias(positionWS, normalWS, lightDir)));
}

#endif
