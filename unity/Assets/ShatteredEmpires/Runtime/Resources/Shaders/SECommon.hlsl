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
float _SE_Glare;
float _SE_CityPower;
half4 _SE_AmbientSky, _SE_AmbientEquator, _SE_AmbientGround;
float4 _SE_Haze;
half4 _SE_HazeColor;
// How much further back the telephoto match camera stands than the zoom distance (ViewLod.cs; 0 otherwise).
// Detail fades measured from the eye subtract it, so they follow the zoom as with the old camera.
float _SE_EyeOffset;
float SE_ViewDistance(float3 positionWS) { return max(distance(_WorldSpaceCameraPos, positionWS) - _SE_EyeOffset, 0.0); }
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
// ---- regional weather (WeatherField.cs): one texel per 8x8-hex weather cell, r cloud, g rain, b storm,
// a wetness; the previous and the latest server snapshot, blended along the wind between updates
TEXTURE2D(_SE_WxPrev); SAMPLER(sampler_SE_WxPrev);
TEXTURE2D(_SE_WxNext);
float4 _SE_WxParams;    // x = blend prev->next, y = visual intensity (player setting), z = enabled, w = time (s)
float4 _SE_WxScale;     // xy: world (x, -z) -> weather uv
float4 _SE_WxAdvect;    // xy: prev uv offset, zw: next uv offset (wind advection between snapshots)
float4 _SE_Strikes[4];  // lightning strikes (StormClouds.cs): xyz world position, w start time (_SE_WxParams.w clock)
float4 _SE_StrikeAmp;   // strength of each strike (0 = none)
#define SE_CLOUD_BASE 17.0

half4 SE_WeatherAt(float2 xzWS)
{
    if (_SE_WxParams.z < 0.5) return 0;
    float2 uv = float2(xzWS.x, -xzWS.y) * _SE_WxScale.xy;
    half4 a = SAMPLE_TEXTURE2D_LOD(_SE_WxPrev, sampler_SE_WxPrev, uv + _SE_WxAdvect.xy, 0);
    half4 b = SAMPLE_TEXTURE2D_LOD(_SE_WxNext, sampler_SE_WxPrev, uv + _SE_WxAdvect.zw, 0);
    return lerp(a, b, (half)_SE_WxParams.x);
}

// ---- storm systems (StormSystems.cs; server weather.js systemProfile): up to four, two vectors each, Unity world
// [2i]   xy centre (world x, z), z radius, w intensity (0..1, already eased between snapshots)
// [2i+1] x kind (0 squall line, 1 hurricane), y spin (+1 counter-clockwise from above), z heading (radians, Unity xz), w seed
float4 _SE_WxSys[8];
float4 _SE_WxSysN;      // x count, y wrap (0/1), z period, w unused
TEXTURE2D(_SE_CloudNoiseTex); SAMPLER(sampler_SE_CloudNoiseTex);   // tileable cloud noise (StormSky.cs)
#define SE_SKY_Y 20.0   // the storm cloud deck (StormSky)

float2 SE_SysRel(float2 xzWS, float4 a)
{
    float2 rel = xzWS - a.xy;
    if (_SE_WxSysN.y > 0.5) rel.x -= _SE_WxSysN.z * round(rel.x / _SE_WxSysN.z);
    return rel;
}

// One system's (cloud, storm, rain) at an offset from its centre, Unity world: the server's profile (axisymmetric
// hurricane, bowed squall line) plus, for hurricanes, the rotating spiral bands (arms 0..1, also returned).
half3 SE_SysProfile(float2 rel, float4 a, float4 b, float time, out half arms)
{
    arms = 0;
    float R = a.z, s = a.w;
    if (s <= 0.001 || R <= 0) return 0;
    if (b.x > 0.5)
    {
        float r = length(rel), k = r / R;
        if (k > 1.1) return 0;
        float rm = 0.2 * R;
        float eye = smoothstep(0.3 * rm, 0.55 * rm, r);
        float wall = exp(-((r - rm) / (0.42 * rm)) * ((r - rm) / (0.42 * rm)));
        float bands = smoothstep(0.9 * rm, 1.6 * rm, r) * (1 - smoothstep(0.55, 1.0, k));
        float shield = 1 - smoothstep(0.35, 1.05, k);
        float th = atan2(rel.y, rel.x);
        float spiral = 0.5 + 0.5 * cos(2 * b.y * th + 5.0 * log(max(r, 1e-3) / rm) - time * 0.06 + b.w);
        arms = (half)(spiral * spiral * bands);
        float grow = saturate(0.35 + s);
        return half3(eye * saturate(max(wall, 0.32 * bands + 0.62 * shield)) * grow,
            eye * saturate(wall + 0.22 * bands) * s,
            eye * saturate(wall * 0.95 + 0.3 * bands + 0.2 * shield) * saturate(s * 1.2));
    }
    // squall line: map heading h (z south) is Unity heading -h; along the line (u), along the motion (v)
    float2 f = float2(cos(b.z), sin(b.z));
    float u = dot(rel, float2(-f.y, f.x)) / R, v = dot(rel, f);
    if (abs(u) > 1.05 || v > 0.3 * R || v < -0.95 * R) return 0;
    float lat = 1 - smoothstep(0.62, 1.0, abs(u));
    float e = v - (0.2 * R * (1 - u * u) - 0.08 * R);
    float conv = exp(-((e + 0.07 * R) / (0.075 * R)) * ((e + 0.07 * R) / (0.075 * R)));
    float shelf = exp(-((e - 0.01 * R) / (0.035 * R)) * ((e - 0.01 * R) / (0.035 * R)));
    float trail = e < 0 ? exp(e / (0.45 * R)) * smoothstep(0.02 * R, -0.04 * R, e) : 0;
    return half3(lat * saturate(conv + shelf * 0.7 + trail * 0.72) * saturate(0.35 + s), lat * conv * s, lat * saturate(conv * 0.95 + trail * 0.75) * s);
}

// All live systems at a point (strongest of each): x cloud, y storm, z rain, w spiral bands.
half4 SE_SystemsAt(float2 xzWS)
{
    half4 o = 0;
    int n = (int)_SE_WxSysN.x;
    [loop] for (int i = 0; i < n && i < 4; i++)
    {
        half arms;
        half3 p = SE_SysProfile(SE_SysRel(xzWS, _SE_WxSys[2 * i]), _SE_WxSys[2 * i], _SE_WxSys[2 * i + 1], _SE_WxParams.w, arms);
        o = max(o, half4(p, arms));
    }
    return o;
}

// How much heavy cloud and storm overhead darken this point (0..1): the weather is read where the sun ray
// through this point meets the cloud base, so the shade sits under the storm clouds as drawn.
half SE_StormShade(float3 positionWS)
{
    if (_SE_WxParams.z < 0.5 || _SE_WxParams.y <= 0.001) return 0;
    float3 L = _MainLightPosition.xyz;
    float lift = max(SE_CLOUD_BASE - positionWS.y, 0.0) / max(L.y, 0.35);
    float2 p = positionWS.xz + L.xz * lift;
    half4 w = SE_WeatherAt(p);
    half cover = smoothstep(0.42h, 0.95h, w.r) * 0.42h + w.b * 0.62h + w.g * 0.12h;
    // storm systems: the shadow of their cloud deck (spiral bands included), broken up like the clouds
    if (_SE_WxSysN.x > 0.5)
    {
        float2 ps = positionWS.xz + L.xz * (max(SE_SKY_Y - positionWS.y, 0.0) / max(L.y, 0.35));
        half4 sys = SE_SystemsAt(ps);
        if (sys.x > 0.004h)
        {
            half n2 = SAMPLE_TEXTURE2D_LOD(_SE_CloudNoiseTex, sampler_SE_CloudNoiseTex, ps * 0.011, 1).r;
            half body = saturate(max(sys.x, sys.w * 0.9h) * (0.7h + 0.6h * n2));
            cover = max(cover, body * 0.62h + sys.y * 0.38h);
        }
    }
    if (cover <= 0.004h) return 0;
    float n = SE_CloudNoise(p * 0.05 - _SE_Clouds.yz * 1.1);
    return saturate(cover * (0.72h + 0.56h * (half)n)) * (half)_SE_WxParams.y;
}

// Local light from recent lightning strikes (a few hexes around each).
half SE_StrikeLight(float3 positionWS)
{
    if (_SE_WxParams.z < 0.5) return 0;
    half f = 0;
    [unroll] for (int i = 0; i < 4; i++)
    {
        float age = _SE_WxParams.w - _SE_Strikes[i].w;
        float amp = _SE_StrikeAmp[i];
        if (amp <= 0 || age < 0 || age > 0.7) continue;
        float2 d = positionWS.xz - _SE_Strikes[i].xz;
        float k = saturate(1.0 - dot(d, d) * (1.0 / (24.0 * 24.0)));
        float flick = 0.55 + 0.45 * sin(age * 71.0 + i * 1.7);
        f += (half)(amp * exp(-age * 6.5) * k * k * flick);
    }
    return f * (half)_SE_WxParams.y;
}

half SE_CloudShadow(float3 positionWS)
{
    // the regional cloud where the weather texture is live (WeatherField), the camera's cover otherwise
    float cover = _SE_WxParams.z > 0.5 ? SE_WeatherAt(positionWS.xz).r : _SE_Clouds.x;
    if (cover <= 0.01) return 0;
    float2 p = positionWS.xz * 0.045 - _SE_Clouds.yz;   // yz: integrated wind drift (Atmosphere)
    float n = SE_CloudNoise(p) * 0.6 + SE_CloudNoise(p * 2.3 + 7.1) * 0.4;
    return smoothstep(1.0 - cover * 0.85, 1.05 - cover * 0.6, n) * 0.5;
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

float4 _SE_ShroudLit;   // the shroud's sunlit colour (Shroud.cs); w unused
float _SE_ShroudOn;     // 1 while unexplored ground is shrouded

half3 SE_ApplyFog(half3 color, float3 positionWS, float fogCoord)
{
    // regional weather: ground, water, units and buildings under heavy cloud and storms are darker, cooler and
    // flatter; recent lightning lights them for an instant (WeatherField / StormClouds)
    if (_SE_WxParams.z > 0.5)
    {
        half shade = SE_StormShade(positionWS);
        half lum = dot(color, half3(0.3h, 0.59h, 0.11h));
        color = lerp(color, lum * half3(0.86h, 0.92h, 1.04h), shade * 0.4h) * (1.0h - shade * 0.55h);
        color += color * SE_StrikeLight(positionWS) * 2.2h;
    }
    // organic edges: the per-hex fog texture is read through a noise warp, so no hexagon outlines show
    float2 warp = float2(SE_CloudNoise(positionWS.xz * .55), SE_CloudNoise(positionWS.xz * .55 + 17.3)) - .5;
    float3 warped = positionWS + float3(warp.x, 0, warp.y) * .75;
    // 2026-11-19 (line of sight must be obvious): the bilinear per-hex visibility is tightened to a crisp but
    // soft rim (about half a hex wide) instead of a hex-wide gradient
    float4 fogSample = _SE_FogParams.z < 0.5 ? float4(1, 1, 0, 1) : SAMPLE_TEXTURE2D_LOD(_SE_FogTex, sampler_SE_FogTex, SE_MapUV(warped), 0);
    half vis = smoothstep(0.28h, 0.72h, (half)fogSample.r);
    // Explored-but-unseen land is strongly desaturated, cooled and much darker, never fully black so remembered
    // ground and structures stay readable. It carries no cloud: the volumetric shroud (SE/Shroud) covers only
    // never-explored ground and the boundary hexes beside it, which also hides the cut edge of known terrain.
    // 2026-11-20 (Ticket 2: "areas without line of sight should be much darker; undiscovered areas stay as they
    // are"): ground this player has explored (fog G) drops to about a fifth of its lit brightness at the default
    // strength; never-explored ground under the shroud keeps the older, lighter dim (about a third).
    half explored = saturate((half)fogSample.g * 1.25h);
    half grey = dot(color, half3(0.3h, 0.59h, 0.11h));
    half keep = 1.0h - _SE_FogParams.w * lerp(0.7h, 0.87h, explored);
    half3 dimmed = lerp(color, grey.xxx * half3(0.76h, 0.84h, 1.0h), lerp(0.62h, 0.72h, explored)) * keep;
    // a faint dark seam just outside the edge of sight makes the line of sight read at a glance
    half seam = smoothstep(0.0h, 0.35h, vis) * (1.0h - smoothstep(0.35h, 0.8h, vis));
    color = lerp(dimmed, color, vis) * (1.0h - seam * 0.22h * (_SE_FogParams.z > 0.5 ? 1.0h : 0.0h));
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
