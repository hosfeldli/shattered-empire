#ifndef SE_COMMON_INCLUDED
#define SE_COMMON_INCLUDED
// Shared lighting for Shattered Empires' URP shaders: main light with shadows, additional lights,
// spherical-harmonics ambient, distance fog, and a soft fog-of-war field.

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

// fog of war: R8 texture covering one world period (x) by the map depth (z); 1 = visible
TEXTURE2D(_SE_FogTex); SAMPLER(sampler_SE_FogTex);
float4 _SE_FogParams;   // x = 1/period, y = 1/depth, z = enabled (0/1), w = explored-dim strength

// map texture coordinates of a Unity world position (Unity z is the map's z mirrored; see MapSpace)
float2 SE_MapUV(float3 positionWS) { return float2(positionWS.x * _SE_FogParams.x, -positionWS.z * _SE_FogParams.y); }

float SE_Visibility(float3 positionWS)
{
    if (_SE_FogParams.z < 0.5) return 1.0;
    return SAMPLE_TEXTURE2D_LOD(_SE_FogTex, sampler_SE_FogTex, SE_MapUV(positionWS), 0).r;
}

// per-hex ground state: r = developed city ground, g = shelled ground (no-man's land),
// b = rain-wet ground, a = crater density
TEXTURE2D(_SE_GroundTex); SAMPLER(sampler_SE_GroundTex);
float4 SE_Ground(float3 positionWS) { return SAMPLE_TEXTURE2D_LOD(_SE_GroundTex, sampler_SE_GroundTex, SE_MapUV(positionWS), 0); }

// drifting cloud shadows: x = cover (0..1), y = wind x, z = wind z, w = speed
float4 _SE_Clouds;
float4 _SE_Wind; // world-space x/z vector, strength
half4 _SE_AmbientSky, _SE_AmbientEquator, _SE_AmbientGround;
float4 _SE_Haze;
half4 _SE_HazeColor;
half3 SE_Ambient(half3 n)
{
    return n.y >= 0 ? lerp(_SE_AmbientEquator.rgb, _SE_AmbientSky.rgb, n.y)
        : lerp(_SE_AmbientEquator.rgb, _SE_AmbientGround.rgb, -n.y);
}
float SE_CloudNoise(float2 p)
{
    float2 i = floor(p), f = frac(p);
    float2 u = f * f * (3 - 2 * f);
    float a = frac(sin(dot(i, float2(127.1, 311.7))) * 43758.5);
    float b = frac(sin(dot(i + float2(1, 0), float2(127.1, 311.7))) * 43758.5);
    float c = frac(sin(dot(i + float2(0, 1), float2(127.1, 311.7))) * 43758.5);
    float d = frac(sin(dot(i + float2(1, 1), float2(127.1, 311.7))) * 43758.5);
    return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
}
half SE_CloudShadow(float3 positionWS)
{
    if (_SE_Clouds.x <= 0.01) return 0;
    float2 p = positionWS.xz * 0.045 - _SE_Clouds.yz * _Time.y * _SE_Clouds.w * 0.02;
    float n = SE_CloudNoise(p) * 0.6 + SE_CloudNoise(p * 2.3 + 7.1) * 0.4;
    return smoothstep(1.0 - _SE_Clouds.x * 0.85, 1.05 - _SE_Clouds.x * 0.6, n) * 0.5;
}

half3 SE_Shade(half3 albedo, float3 positionWS, half3 normalWS, half emission)
{
    // The caller supplies linear reflectance, including decoded colour textures.
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
    half3 ambient = SE_Ambient(normalWS);
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
    float range = distance(_WorldSpaceCameraPos, positionWS);
    half lowMist = exp(-max(0.0, positionWS.y - .5) * .32);
    half haze = (1.0h - exp(-max(0.0, range - _SE_Haze.y) * _SE_Haze.x)) * lowMist * .16h;
    return MixFog(lerp(color, _SE_HazeColor.rgb, haze), fogCoord);
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
