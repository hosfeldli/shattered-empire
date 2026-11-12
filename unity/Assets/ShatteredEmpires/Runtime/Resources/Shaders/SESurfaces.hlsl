#ifndef SE_SURFACES_INCLUDED
#define SE_SURFACES_INCLUDED

TEXTURE2D_ARRAY(_SE_SurfaceMaps); SAMPLER(sampler_SE_SurfaceMaps);
TEXTURE2D(_SE_ArchitectureAtlas); SAMPLER(sampler_SE_ArchitectureAtlas);
float4 _SE_ArchitectureAtlas_TexelSize;

bool SE_HasPhoto(uint kind) { return kind == 1u || kind == 2u || kind == 3u || kind == 5u; }

half3 SE_Architecture(float3 p, half3 normal, uint kind)
{
    float3 n = abs(normal);
    float2 uv = n.y >= max(n.x, n.z) ? p.xz : n.x > n.z ? p.zy : p.xy;
    float frequency = kind == 2u ? 15.0 : kind == 3u ? 8.0 : kind == 5u ? 5.0 : 6.0;
    uv *= frequency;
    uint layer = kind == 1u ? 0u : kind == 2u ? 1u : kind == 3u ? 2u : 3u;
    float2 quadrant = float2(layer & 1u, layer < 2u ? 1.0 : 0.0);
    float2 inset = max(_SE_ArchitectureAtlas_TexelSize.xy * 3.0, .003);
    float2 span = .5 - inset * 2.0;
    return SAMPLE_TEXTURE2D_GRAD(_SE_ArchitectureAtlas, sampler_SE_ArchitectureAtlas,
        quadrant * .5 + inset + frac(uv) * span, ddx(uv) * span, ddy(uv) * span).rgb;
}

float SE_SurfaceFrequency(uint kind)
{
    if (kind == 2u) return 7.5;
    if (kind == 3u) return 4.0;
    if (kind == 4u) return 6.0;
    if (kind == 6u || kind == 7u) return 18.0;
    if (kind == 8u) return 31.0;
    if (kind == 10u || kind == 11u) return 1.3;
    return 2.5;
}

half4 SE_Surface(float3 p, float3 localNormal, uint kind)
{
    float3 n = abs(localNormal);
    float2 uv = n.y >= max(n.x, n.z) ? p.xz : (n.x > n.z ? p.zy : p.xy);
    uv *= SE_SurfaceFrequency(kind);
    return SAMPLE_TEXTURE2D_ARRAY(_SE_SurfaceMaps, sampler_SE_SurfaceMaps, uv, kind);
}

// Surface-gradient normal perturbation in world units, independent of model UV tangents.
half3 SE_Relief(float3 p, half3 n, half height, half strength)
{
    float3 u = ddx(p), v = ddy(p);
    float3 a = cross(v, n), b = cross(n, u);
    float det = dot(u, a);
    float3 g = (ddx(height) * a + ddy(height) * b) * (det < 0 ? -1.0 : 1.0);
    return normalize(n * max(abs(det), 1e-8) - g * strength);
}

#endif
