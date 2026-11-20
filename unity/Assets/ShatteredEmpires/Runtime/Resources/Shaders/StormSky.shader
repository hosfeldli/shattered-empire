// The cloud deck (StormSky.cs): one horizontal quad at SE_SKY_Y around the camera focus, shaded per pixel from
// the regional weather texture (fair-weather and overcast cloud) and the storm systems (SECommon _SE_WxSys):
// domain-warped noise from a small tileable texture, advected with each system's flow. Hurricanes are sampled in
// log-polar coordinates sheared along their spiral arms, so the texture streams along the bands and rotates
// faster near the eyewall (two phases cross-faded, so the shear never winds up); a clear eye, a bright central
// dense overcast and a faint high outflow veil turning the other way. Squall lines are sampled in line
// coordinates: a striated shelf cloud on the leading edge, convective towers along the line, a ragged trailing
// deck. Lit from the sun by the density gradient (bright crowns, grey-blue lee sides), darker and flatter in storm
// cores, flickering with lightning. Pixels with no cloud leave after two cheap reads.
Shader "SE/StormSky"
{
    SubShader
    {
        Tags { "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent+22" }
        Pass
        {
            Name "StormSky"
            Tags { "LightMode" = "UniversalForward" }
            Blend One OneMinusSrcAlpha
            ZWrite Off
            ZTest LEqual
            Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "SECommon.hlsl"

            float4 _Sky0;   // xy window centre (world xz), z half size, w deck height
            float4 _Sky1;   // x opacity (zoom x setting), y hole strength, zw hole centre (world xz)
            float4 _Sky2;   // x hole radius, y background opacity, z map depth, w wrap (0/1)
            float4 _Sky3;   // x period

            struct Attributes { float3 positionOS : POSITION; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 world : TEXCOORD0;
                float fogCoord : TEXCOORD1;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                float3 w = float3(_Sky0.x + v.positionOS.x * 2 * _Sky0.z, _Sky0.w, _Sky0.y + v.positionOS.y * 2 * _Sky0.z);
                o.world = w;
                o.positionCS = TransformWorldToHClip(w);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 N4(float2 uv, float lod) { return SAMPLE_TEXTURE2D_LOD(_SE_CloudNoiseTex, sampler_SE_CloudNoiseTex, uv, lod); }
            float Lod(float uvPerWorld, float wpp) { return max(0.0, log2(max(wpp * uvPerWorld * 256.0, 1e-4))); }
            float Hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

            // cloud body: noise n (0..1) under coverage cov: scattered tufts when thin, a solid textured deck when full
            float Body(float n, float cov) { return smoothstep(1.0 - cov, 1.0 - cov + 0.32, n) * smoothstep(0.0, 0.12, cov); }

            // domain-warped fbm at uv (the warp and detail octaves come from other channels and scales)
            float Fbm(float2 uv, float lod, float t, out float baseN)
            {
                half4 w = N4(uv * 0.31 + 0.21, max(lod - 1.7, 0));
                float2 q = uv + (w.rg - 0.5) * 0.2;
                half4 a = N4(q, lod);
                half4 b = N4(q * 2.73 + float2(t * 0.011, -t * 0.007), lod + 1.45);
                half4 c = N4(q * 6.17 + float2(0.53 - t * 0.006, 0.29), lod + 2.6);
                // cauliflower billows (cellular) over soft fbm, then two finer octaves that erode the edges
                baseN = a.r * 0.45 + a.b * 0.55;
                return baseN * 0.6 + (b.b * 0.55 + b.g * 0.45) * 0.26 + c.a * 0.14;
            }

            // hurricane noise: log-polar coordinates sheared along the arms (close to conformal, so features keep their
            // shape and grow with the radius), rotated with the flow (faster near the eyewall); two phases cross-faded
            float HurNoise(float2 rel, float rm, float4 B, float f1, float f2, float w1, float per, float lod, float time)
            {
                const float NT = 6.0, TAU = 6.2831853;
                float r = max(length(rel), 1e-3), th = atan2(rel.y, rel.x), lnr = log(r / rm);
                float omega = 0.045 * (r < rm ? 1.0 : pow(rm / r, 0.6));
                float U0 = (B.y * th + 1.1 * lnr) * NT / TAU, V = lnr * NT / TAU * 1.1 + B.w;
                float b1, b2;
                float n1 = Fbm(float2(U0 - omega * f1 * per * NT / TAU, V), lod, time, b1);
                float n2 = Fbm(float2(U0 - omega * f2 * per * NT / TAU + 0.37, V + 0.19), lod, time, b2);
                return lerp(n2, n1, w1);
            }

            // hurricane coverage: a ragged clear eye, the eyewall and central dense overcast solid, spiral bands
            // with thinner cloud between them, a ragged outer edge
            float HurCov(float2 rel, float4 A, float4 B, float nn, float time)
            {
                float R = A.z, s = A.w, r = max(length(rel), 1e-3), rm = 0.2 * R, k = r / R;
                // the spiral bands as SE_SysProfile draws them, but broad and frayed by the noise
                float bands = smoothstep(0.9 * rm, 1.6 * rm, r) * (1 - smoothstep(0.55, 1.0, k));
                float spiral = 0.5 + 0.5 * cos(2 * B.y * atan2(rel.y, rel.x) + 5.0 * log(r / rm) - time * 0.06 + B.w + (nn - 0.5) * 3.2);
                float arms = pow(saturate(spiral), 1.4) * bands;
                float eye = smoothstep(0.3 * rm, 0.55 * rm, r + (nn - 0.5) * rm * 0.25);
                float wq = (r - rm) / (0.5 * rm), wall = exp(-wq * wq);
                float cdo = 1 - smoothstep(0.26, 0.48, k + (nn - 0.5) * 0.18);
                float cov = eye * max(max(wall * 0.95, cdo * 0.92), max(arms * (0.45 + 0.75 * nn), (1 - smoothstep(0.3, 0.95, k)) * (0.12 + 0.5 * nn)));
                cov *= saturate(0.35 + s) * (1 - smoothstep(0.8, 1.1, k + (nn - 0.5) * 0.3));
                return saturate(cov);
            }

            float StrikeGlow(float2 xz, float radius)
            {
                float g = 0;
                [unroll] for (int i = 0; i < 4; i++)
                {
                    float age = _SE_WxParams.w - _SE_Strikes[i].w;
                    float amp = _SE_StrikeAmp[i];
                    if (amp <= 0 || age < 0 || age > .8) continue;
                    float k = saturate(1 - length(xz - _SE_Strikes[i].xz) / radius);
                    g += amp * k * k * exp(-age * 5.5) * (.6 + .4 * sin(age * 63 + i));
                }
                return g;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float2 p = i.world.xz;
                float time = _SE_WxParams.w;
                float wpp = max(length(fwidth(p)), 1e-3);   // world units per pixel
                // map bounds (x only when the map does not wrap) and the window edge
                float edge = saturate((_Sky0.z - max(abs(p.x - _Sky0.x), abs(p.y - _Sky0.y))) / (_Sky0.z * 0.12));
                edge *= saturate((-p.y + 18) / 30) * saturate((p.y + _Sky2.z + 18) / 30);
                if (_Sky2.w < 0.5) edge *= saturate((p.x + 18) / 30) * saturate((_Sky3.x + 18 - p.x) / 30);
                // a hole where the camera looks through the deck at mid zoom: the battle stays readable
                float hole = length(p - _Sky1.zw) / max(_Sky2.x, 1e-3);
                float vis = _Sky1.x * edge * lerp(1, smoothstep(0.45, 1.2, hole), _Sky1.y);
                if (vis <= 0.003) discard;

                // ---- what is here: the background weather and the dominant storm system
                half4 wx = SE_WeatherAt(p);
                float bgCov = smoothstep(0.2, 0.9, wx.r) * _Sky2.y;
                int n = (int)_SE_WxSysN.x, dom = -1;
                float best = 0.004;
                half3 sysF = 0; half arms = 0;
                [loop] for (int k = 0; k < n && k < 4; k++)
                {
                    half ak;
                    float2 rel = SE_SysRel(p, _SE_WxSys[2 * k]);
                    half3 f = SE_SysProfile(rel, _SE_WxSys[2 * k], _SE_WxSys[2 * k + 1], time, ak);
                    // a hurricane's outflow veil reaches beyond its cloud
                    float reach = _SE_WxSys[2 * k + 1].x > 0.5 ? saturate(1.3 - length(rel) / _SE_WxSys[2 * k].z) * _SE_WxSys[2 * k].w : 0;
                    float wgt = max(max(f.x, ak), reach);
                    if (wgt > best) { best = wgt; dom = k; sysF = f; arms = ak; }
                }
                if (bgCov < 0.01 && dom < 0) discard;

                float2 sunDir = _MainLightPosition.xz;
                sunDir = dot(sunDir, sunDir) > 1e-4 ? normalize(sunDir) : float2(0.7, 0.7);

                // ---- background cloud (fair-weather cumulus to overcast), drifting with the prevailing wind
                float dBg = 0, dBgSun = 0, nBgTop = 0, nSysTop = 0;
                if (bgCov >= 0.01)
                {
                    float sc = 0.0105;
                    float2 uv = p * sc - _SE_Clouds.yz * 0.23;
                    float lod = Lod(sc, wpp), bn;
                    float nb = Fbm(uv, lod, time, bn);
                    dBg = Body(nb, bgCov); nBgTop = nb;
                    float bs; Fbm(uv + sunDir * 0.035, lod, time, bs);
                    dBgSun = Body(bs * 0.72 + nb * 0.28, bgCov);
                }

                // ---- the dominant storm system
                float dSys = 0, dSysSun = 0, cirrus = 0, shelf = 0, storm = 0, rain = 0;
                if (dom >= 0)
                {
                    float4 A = _SE_WxSys[2 * dom], B = _SE_WxSys[2 * dom + 1];
                    float2 rel = SE_SysRel(p, A);
                    float R = A.z, s = A.w;
                    storm = sysF.y; rain = sysF.z;
                    if (B.x > 0.5)
                    {
                        // hurricane: log-polar noise sheared along the spiral arms, streaming with the flow
                        float r = max(length(rel), 1e-3), rm = 0.2 * R, th = atan2(rel.y, rel.x), lnr = log(r / rm);
                        const float NT = 6.0, TAU = 6.2831853;
                        float per = 22.0, ph = time / per, f1 = frac(ph), f2 = frac(ph + 0.5);
                        float w1 = 1 - abs(2 * f1 - 1);
                        float lod = Lod(NT * 0.4 / r, wpp);
                        float nn = HurNoise(rel, rm, B, f1, f2, w1, per, lod, time);
                        dSys = Body(nn, HurCov(rel, A, B, nn, time));
                        nSysTop = nn;
                        // lit side: the same a little toward the sun
                        float2 relS = rel + sunDir * 2.4;
                        float nS = HurNoise(relS, rm, B, f1, f2, w1, per, lod, time);
                        dSysSun = Body(nS, HurCov(relS, A, B, nS, time));
                        // high outflow: a thin veil streaming out the other way, beyond the main shield
                        float k = r / R;
                        float Uc = (-B.y * th - 1.2 * lnr) * NT / TAU + time * 0.004;
                        float ci = N4(float2(Uc, lnr * NT / TAU * 0.6 + 0.5), lod + 0.5).g * 0.6 + N4(float2(Uc * 3.1, lnr * 2.2 + 0.2), lod + 1.5).a * 0.4;
                        cirrus = smoothstep(0.5, 0.9, ci) * smoothstep(1.3, 0.8, k) * smoothstep(0.4, 0.75, k) * s * 0.22;
                    }
                    else
                    {
                        // squall line: textures run along the line and travel with it
                        float2 f = float2(cos(B.z), sin(B.z));
                        float u = dot(rel, float2(-f.y, f.x)), v = dot(rel, f);
                        float uN = u / R, e = v - (0.2 * R * (1 - uN * uN) - 0.08 * R);
                        float sc = 0.016;
                        float lod = Lod(sc * 1.3, wpp), bn;
                        float2 uv = float2(u * sc + B.w, v * sc * 1.3);
                        float nn = Fbm(uv, lod, time, bn);
                        // convective towers along the line: bubbling cells
                        half cells = N4(float2(u * 0.018 + B.w, time * 0.003), lod).b;
                        float conv = exp(-((e + 0.07 * R) / (0.09 * R)) * ((e + 0.07 * R) / (0.09 * R)));
                        shelf = exp(-((e - 0.005 * R) / (0.05 * R)) * ((e - 0.005 * R) / (0.05 * R))) * (1 - smoothstep(0.55, 1.0, abs(uN + (nn - 0.5) * 0.2)));
                        float cov = saturate(sysF.x * 0.95 + conv * (cells - 0.45) * 0.7);
                        dSys = Body(nn, cov); nSysTop = nn;
                        // the shelf: a smooth, striated arc
                        half stri = N4(float2(u * 0.004 + B.w, e * 0.07 + nn * 0.4), lod).r;
                        dSys = max(dSys, shelf * smoothstep(0.2, 0.7, stri * 0.6 + nn * 0.5) * smoothstep(0.0, 0.3, s));
                        float bs;
                        float nS = Fbm(uv + float2(dot(sunDir, float2(-f.y, f.x)), dot(sunDir, f) * 1.3) * 0.03, lod, time, bs);
                        dSysSun = Body(nS, cov);
                        storm = max(storm, conv * cells * s * 0.6);
                    }
                }

                // ---- compose: the denser of the two layers, lit by the density gradient toward the sun
                float d = max(dBg, dSys), dSun = dSys >= dBg ? dSysSun : dBgSun;
                float a = max(d, cirrus);
                if (a <= 0.004) discard;
                // sun side vs lee side from the density gradient, crowns (high noise) brighter than the troughs
                float nTop = dSys >= dBg ? nSysTop : nBgTop;
                float shade = saturate(0.55 + clamp((d - dSun) * 1.9, -0.45, 0.22));
                float crown = smoothstep(0.35, 0.95, nTop);
                float relief = saturate(shade * 0.65 + crown * 0.45 - 0.08);
                half3 sunCol = _MainLightColor.rgb;
                half3 amb = _SE_AmbientSky.rgb;
                half3 top = half3(0.9h, 0.9h, 0.92h) * sunCol * (half)lerp(1.0, 0.86, storm);
                half3 lee = half3(0.50h, 0.54h, 0.62h) * (amb * 1.4h + sunCol * 0.2h) * (half)lerp(1.0, 0.62, storm);
                half3 c = lerp(lee, top, (half)relief);
                c *= (half)(1 - rain * 0.12);
                // thin edges catch a little light; thick storm cores flatten and darken
                c += sunCol * (half)(saturate(1 - d * 1.8) * relief * 0.08);
                c = lerp(c, c * half3(0.86h, 0.88h, 0.95h), (half)(storm * 0.5));
                // shelf cloud front: a brighter, crisper rim
                c += sunCol * (half)(shelf * 0.1);
                // high veil: pale and flat
                half3 veil = (half3(0.9h, 0.92h, 0.96h) * sunCol * 0.85h + amb * 0.3h);
                c = lerp(veil, c, (half)saturate(d / max(a, 1e-3)));
                // lightning: strikes light the cloud from inside, storm cores flicker
                float2 cellKey = floor(p / 26.0);
                float beat = time * 1.2 + Hash(cellKey) * 9;
                float flick = storm > 0.45 && Hash(cellKey + floor(beat) * 1.37) > 1 - (storm - 0.45) * 0.22 ? exp(-frac(beat) * 7) * (.6 + .4 * sin(time * 47)) : 0;
                float flash = flick * 0.7 + StrikeGlow(p, 34);
                c += half3(0.72h, 0.78h, 1.0h) * (half)(flash * (0.6 + d * 0.8)) * (half)_SE_WxParams.y;
                c = MixFog(c, i.fogCoord);
                // opacity: storms near-solid at strategic zoom, fair-weather cloud a thin veil
                float alpha = saturate(a * lerp(0.62, 1.0, saturate(max(storm * 1.6, dSys > dBg ? 0.75 : 0.0)))) * vis;
                return half4(c * (half)alpha, (half)alpha);
            }
            ENDHLSL
        }
    }
}
