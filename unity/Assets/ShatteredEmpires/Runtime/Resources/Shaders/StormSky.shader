// The cloud deck (StormSky.cs): one horizontal quad at SE_SKY_Y around the camera focus, shaded per pixel from
// the regional weather texture (fair-weather and overcast cloud) and the storm systems (SECommon _SE_WxSys):
// domain-warped noise from a small tileable texture, advected with each system's flow, lit as a height field
// (the same field sampled a little toward the sun: sun-facing slopes bright, lee slopes and crevices shadowed).
// Hurricanes: a tight eye (smaller the stronger the storm) inside a sharp eyewall whose inner face is lit on the
// far side and casts a shadow into the eye on the near side (the stadium look); a central dense overcast of
// convective clumps turning rigidly with the core (no shear, no streaks); spiral bands outside it sampled in
// log-polar coordinates sheared along the arms (two phases cross-faded, so the shear never winds up), broken
// into fragments and thinner outer rainbands toward the edge; a faint high outflow veil turning the other way.
// Squall lines: discrete cumulonimbus towers along the bowed line (hashed per slot: size, strength, gaps,
// overshooting tops, a slow life cycle) with cauliflower billows, a fibrous anvil veil streaming ahead, a darker
// striated shelf cloud on the leading edge and a broken stratiform deck behind. Storm cores flicker with
// lightning. Pixels with no cloud leave after two cheap reads.
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

            // cloud body: noise n (0..1) under coverage cov: scattered tufts when thin, a solid textured deck when
            // full; `soft` is the edge width (narrow for crisp convective edges, wide for soft stratiform)
            float Body(float n, float cov, float soft) { return smoothstep(1.0 - cov, 1.0 - cov + soft, n) * smoothstep(0.0, 0.12, cov); }

            // domain-warped fbm at uv (the warp and detail octaves come from other channels and scales)
            float Fbm(float2 uv, float lod, float t)
            {
                half4 w = N4(uv * 0.31 + 0.21, max(lod - 1.7, 0));
                float2 q = uv + (w.rg - 0.5) * 0.2;
                half4 a = N4(q, lod);
                half4 b = N4(q * 2.73 + float2(t * 0.011, -t * 0.007), lod + 1.45);
                half4 c = N4(q * 6.17 + float2(0.53 - t * 0.006, 0.29), lod + 2.6);
                // cauliflower billows (cellular) over soft fbm, then two finer octaves that erode the edges
                float baseN = a.r * 0.45 + a.b * 0.55;
                return baseN * 0.6 + (b.b * 0.55 + b.g * 0.45) * 0.26 + c.a * 0.14;
            }

            // lumpy convective fbm: billows (cellular) dominate, so the texture reads as clumps and turrets
            float Clumps(float2 uv, float lod, float t, out float low)
            {
                half4 w = N4(uv * 0.29 + 0.63, max(lod - 1.7, 0));
                float2 q = uv + (w.gr - 0.5) * 0.16;
                half4 a = N4(q, lod);
                half4 b = N4(q * 2.41 + float2(0.17 + t * 0.006, 0.71), lod + 1.27);
                half4 c = N4(q * 5.83 + float2(0.39, 0.11 - t * 0.005), lod + 2.54);
                low = a.r * 0.6 + a.b * 0.4;
                return a.b * 0.42 + a.r * 0.18 + b.b * 0.26 + c.b * 0.09 + c.a * 0.05;
            }

            // hurricane bands: log-polar coordinates sheared along the arms (close to conformal, so features keep
            // their shape and grow with the radius), rotated with the flow (slower outward); two phases cross-faded
            float HurNoise(float2 rel, float rm, float4 B, float f1, float f2, float w1, float per, float lod, float time)
            {
                const float NT = 6.0, TAU = 6.2831853;
                float r = max(length(rel), 1e-3), th = atan2(rel.y, rel.x), lnr = log(r / rm);
                float omega = 0.045 * (r < rm ? 1.0 : pow(rm / r, 0.6));
                // four noise tiles round the circle (an integer, so no seam where atan2 wraps)
                float U0 = (B.y * th + 1.1 * lnr) * 4.0 / TAU, V = lnr * 4.0 / TAU * 1.1 + B.w;
                omega *= 4.0 / NT;
                float n1 = Fbm(float2(U0 - omega * f1 * per * NT / TAU, V), lod, time);
                float n2 = Fbm(float2(U0 - omega * f2 * per * NT / TAU + 0.37, V + 0.19), lod, time);
                return lerp(n2, n1, w1);
            }

            // hurricane coverage: a clear eye of radius re, the eyewall and central dense overcast solid, the main
            // spiral bands (as SE_SysProfile draws them, so the ground shade matches) frayed and broken into
            // fragments outward, thinner outer rainbands, a ragged outer edge
            float HurCov(float2 rel, float4 A, float4 B, float nn, float re, float time)
            {
                float R = A.z, s = A.w, r = max(length(rel), 1e-3), rm = 0.2 * R, k = r / R, th = atan2(rel.y, rel.x);
                float bands = smoothstep(0.9 * rm, 1.6 * rm, r) * (1 - smoothstep(0.5, 1.05, k + (nn - 0.5) * 0.35));
                float spiral = 0.5 + 0.5 * cos(2 * B.y * th + 5.0 * log(r / rm) - time * 0.06 + B.w + (nn - 0.5) * 3.4);
                // fragments: a slow noise along the arm breaks it into cloud clusters with gaps, more so outward
                half frag = N4(float2(B.y * th * 3.0 / 6.2831853 + log(r / rm) * 0.7 + B.w, log(r / rm) * 0.35 - time * 0.002), 1).r;
                float broken = lerp(1.0, 0.3 + 0.7 * smoothstep(0.3, 0.6, frag), smoothstep(0.3, 0.68, k));
                float arms = pow(saturate(spiral), 1.6) * bands * broken;
                // thinner outer rainbands, a tighter spiral of three
                float sp2 = 0.5 + 0.5 * cos(3 * B.y * th + 7.5 * log(r / rm) - time * 0.05 + B.w * 1.7 + (nn - 0.5) * 4.0);
                float outer = pow(saturate(sp2), 5.0) * smoothstep(0.42, 0.6, k) * (1 - smoothstep(0.85, 1.12, k + (nn - 0.5) * 0.25)) * smoothstep(0.25, 0.55, frag);
                float eye = smoothstep(re * 0.8, re * 1.12, r + (nn - 0.5) * re * 0.45);
                float wq = (r - max(re * 1.6, rm * 0.75)) / (0.55 * rm), wall = exp(-wq * wq);
                // the overcast's edge is not a circle: it bulges out along the arms that feed it
                float cdo = 1 - smoothstep(0.22, 0.46, k + (nn - 0.5) * 0.3 - (spiral - 0.5) * 0.2);
                float cov = eye * max(max(wall * 0.98, cdo * 0.94), max(max(arms * (0.55 + 0.6 * nn), outer * 0.75), (1 - smoothstep(0.32, 0.95, k)) * (0.18 + 0.45 * nn)));
                cov *= saturate(0.35 + s) * (1 - smoothstep(0.8, 1.1, k + (nn - 0.5) * 0.3));
                return saturate(cov);
            }

            // ---- squall line: cumulonimbus towers in slots along the line (u along it, e from the leading edge)
            // H: tower height 0..1 (rounded domes, an overshooting top on the strongest)
            float Towers(float u, float e, float R, float seed, float time)
            {
                float S = 0.13 * R, j0 = floor(u / S), H = 0;
                [unroll] for (int jj = -1; jj <= 1; jj++)
                {
                    float j = j0 + jj;
                    float h1 = Hash(float2(j, seed)), h2 = Hash(float2(j + 0.37, seed * 1.3)), h3 = Hash(float2(j - 0.71, seed * 0.7)), h4 = Hash(float2(j * 1.7, seed + 3.1));
                    float uc = (j + 0.5 + (h1 - 0.5) * 0.7) * S, ec = -0.07 * R + (h2 - 0.5) * 0.06 * R;
                    float rc = S * (0.42 + 0.55 * h3);
                    // gaps between towers, a slow life cycle (each tower grows and collapses on its own clock)
                    float life = 0.75 + 0.25 * sin(time * 0.045 + h4 * 6.2831853);
                    float str = (h4 < 0.2 ? 0.35 : 0.62 + 0.38 * h3) * life;
                    float2 dq = float2(u - uc, (e - ec) * 1.25) / rc;
                    float q2 = dot(dq, dq);
                    float dome = sqrt(saturate(1 - q2));
                    float over = h3 > 0.55 ? 0.3 * sqrt(saturate(1 - q2 * 5.0)) : 0;
                    H = max(H, str * (dome * 0.85 + over));
                }
                return H;
            }

            // tower height with cauliflower billows on it (cellular at two scales, larger toward the tops)
            float SquallHeight(float2 ue, float2 uvB, float R, float seed, float lod, float time, out float cauli)
            {
                // a low-frequency warp makes the towers' outlines irregular (no clean circles)
                half4 w = N4(uvB * 0.23 + 0.41, max(lod - 2.0, 0));
                float2 q = ue + (w.rg - 0.5) * (0.075 * R);
                float H = Towers(q.x, q.y, R, seed, time);
                half b1 = N4(uvB + (w.ba - 0.5) * 0.3, lod).b, b2 = N4(uvB * 2.63 + float2(0.31, 0.77), lod + 1.4).b;
                // spherical caps from the cellular distance: scalloped, rounded lobes
                float c1 = sqrt(saturate(1 - (1 - b1) * (1 - b1) * 2.4)), c2 = sqrt(saturate(1 - (1 - b2) * (1 - b2) * 2.4));
                cauli = c1 * 0.78 + c2 * 0.22;
                // billows: lobes on the towers, and an edge that is lumpy rather than round
                return H * (0.92 + 0.11 * (cauli - 0.5) * 2.0) + (cauli - 0.5) * 0.12 * sqrt(saturate(H * 3));
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
                    // a hurricane's outflow veil and a squall's anvil reach beyond their cloud
                    float reach = _SE_WxSys[2 * k + 1].x > 0.5 ? saturate(1.3 - length(rel) / _SE_WxSys[2 * k].z) * _SE_WxSys[2 * k].w : 0;
                    float wgt = max(max(f.x, ak), reach);
                    if (_SE_WxSys[2 * k + 1].x < 0.5)
                    {
                        float2 fh = float2(cos(_SE_WxSys[2 * k + 1].z), sin(_SE_WxSys[2 * k + 1].z));
                        float uu = dot(rel, float2(-fh.y, fh.x)) / _SE_WxSys[2 * k].z, vv = dot(rel, fh) / _SE_WxSys[2 * k].z;
                        if (abs(uu) < 1.0 && vv > 0 && vv < 0.42) wgt = max(wgt, 0.05);
                    }
                    if (wgt > best) { best = wgt; dom = k; sysF = f; arms = ak; }
                }
                if (bgCov < 0.01 && dom < 0) discard;

                float2 sunDir = _MainLightPosition.xz;
                sunDir = dot(sunDir, sunDir) > 1e-4 ? normalize(sunDir) : float2(0.7, 0.7);

                // ---- background cloud (fair-weather cumulus to overcast), drifting with the prevailing wind
                float dBg = 0, dBgSun = 0, nBgTop = 0;
                if (bgCov >= 0.01)
                {
                    float sc = 0.0105;
                    float2 uv = p * sc - _SE_Clouds.yz * 0.23;
                    float lod = Lod(sc, wpp);
                    float nb = Fbm(uv, lod, time);
                    dBg = Body(nb, bgCov, 0.32); nBgTop = nb;
                    float bs = Fbm(uv + sunDir * 0.035, lod, time);
                    dBgSun = Body(bs * 0.72 + nb * 0.28, bgCov, 0.32);
                }

                // ---- the dominant storm system
                // dSys density, sysLight (+ sun-facing, - shadowed), nSysTop crowns, crev crevice darkening,
                // tone (multiplies the colour: grey decks, dark shelf), hi (extra sunlit rim), veil (high thin cloud),
                // under (alpha of a dark layer under the deck: the eye's shadowed floor)
                float dSys = 0, sysLight = 0, nSysTop = 0, crev = 0, hi = 0, cirrus = 0, shelf = 0, storm = 0, rain = 0, under = 0;
                half3 tone = 1;
                if (dom >= 0)
                {
                    float4 A = _SE_WxSys[2 * dom], B = _SE_WxSys[2 * dom + 1];
                    float2 rel = SE_SysRel(p, A);
                    float R = A.z, s = A.w;
                    storm = sysF.y; rain = sysF.z;
                    if (B.x > 0.5)
                    {
                        // ---- hurricane
                        float r = max(length(rel), 1e-3), rm = 0.2 * R, th = atan2(rel.y, rel.x), lnr = log(r / rm), k = r / R;
                        const float NT = 6.0, TAU = 6.2831853;
                        // the eye: a pinhole in a strong storm, wider in a weak one
                        float re = rm * lerp(0.5, 0.26, saturate(s));
                        // the core turns rigidly (no shear: convective clumps, no streaks); the bands stream outside it
                        float wBand = smoothstep(1.7 * rm, 2.7 * rm, r);
                        float nCore = 0, nCoreS = 0, nBand = 0, nBandS = 0, lowC = 0.5, lowS = 0.5;
                        float off = 1.6;   // the sun sample offset (world units)
                        if (wBand < 0.999)
                        {
                            float ang = -B.y * 0.045 * time, ca = cos(ang), sa = sin(ang);
                            float2 rr = float2(ca * rel.x - sa * rel.y, sa * rel.x + ca * rel.y);
                            float2 sr = float2(ca * sunDir.x - sa * sunDir.y, sa * sunDir.x + ca * sunDir.y);
                            float sc = 2.4 / R;
                            float lod = Lod(sc, wpp);
                            float2 uv = rr * sc + B.w * 0.37;
                            nCore = Clumps(uv, lod, time, lowC);
                            nCoreS = Clumps(uv + sr * (off * sc), lod, time, lowS);
                        }
                        if (wBand > 0.001)
                        {
                            float per = 22.0, ph = time / per, f1 = frac(ph), f2 = frac(ph + 0.5);
                            float w1 = 1 - abs(2 * f1 - 1);
                            float lod = Lod(NT * 0.28 / r, wpp);
                            nBand = HurNoise(rel, rm, B, f1, f2, w1, per, lod, time);
                            nBandS = HurNoise(rel + sunDir * off * 1.5, rm, B, f1, f2, w1, per, lod, time);
                        }
                        float nn = lerp(nCore, nBand, wBand), nS = lerp(nCoreS, nBandS, wBand);

                        // the outline follows the broad clumps (no confetti of tiny tufts at the overcast's edge)
                        float nE = lerp(lowC * 0.8 + nCore * 0.2, nBand, wBand);
                        float cov = HurCov(rel, A, B, nE, re, time);
                        // thin cloud between the bands frays softly; dense cloud has crisp edges
                        float soft = lerp(0.46, 0.26, cov);
                        dSys = Body(nE, cov, soft);
                        float2 relS = rel + sunDir * off * 2.0;
                        float dS = Body(nS, HurCov(relS, A, B, nS, re, time), soft);
                        nSysTop = nn;
                        // lit by the density edge and, inside the solid deck, by the clumps' own relief
                        sysLight = (dSys - dS) * 1.5 + (nn - nS) * lerp(2.4, 1.6, wBand) * saturate(dSys * 1.5);
                        crev = saturate(0.5 - nn) * 0.3 * dSys * (1 - wBand * 0.5);
                        // the eyewall: a towering ring; its inner face is lit where it faces the sun (the far side)
                        // and in shadow on the near side, which also shades the eye floor (the stadium effect)
                        float2 rh = rel / r;
                        float rimQ = (r - re * 1.25) / (0.35 * re + 0.12 * rm), rim = exp(-rimQ * rimQ) * dSys;
                        float face = dot(-rh, sunDir);
                        hi = rim * saturate(face * 0.9 + 0.1) * 0.4;
                        sysLight += rim * face * 0.45;
                        tone *= (half)(1 - rim * saturate(-face) * 0.22);
                        float inEye = 1 - smoothstep(re * 0.8, re * 1.15, r);
                        float shadowed = smoothstep(re * 0.85, re * 1.2, length(rel + sunDir * re * 0.85));
                        under = inEye * shadowed * 0.5 * saturate(s * 1.4);
                        // low cloud on the eye floor: faint, broken
                        float floorC = inEye * smoothstep(0.55, 0.8, nn) * 0.18;
                        cirrus = max(cirrus, floorC);
                        // high outflow: a thin veil streaming out the other way, beyond the main shield
                        float lodC = Lod(NT * 0.4 / r, wpp);
                        float Uc = (-B.y * th - 1.2 * lnr) * NT / TAU + time * 0.004;
                        float ci = N4(float2(Uc, lnr * NT / TAU * 0.6 + 0.5), lodC + 0.5).g * 0.6 + N4(float2(Uc * 3.1, lnr * 2.2 + 0.2), lodC + 1.5).a * 0.4;
                        cirrus = max(cirrus, smoothstep(0.5, 0.9, ci) * smoothstep(1.3, 0.8, k) * smoothstep(0.3, 0.62, k) * s * 0.28);
                    }
                    else
                    {
                        // ---- squall line: line coordinates (u along it, v along the motion, e from the bowed edge)
                        float2 f = float2(cos(B.z), sin(B.z)), l = float2(-f.y, f.x);
                        float u = dot(rel, l), v = dot(rel, f);
                        float uN = u / R, bow = 0.2 * R * (1 - uN * uN) - 0.08 * R, e = v - bow;
                        float sc = 0.016;
                        float lod = Lod(sc * 1.3, wpp);
                        float2 uv = float2(u * sc + B.w, v * sc * 1.3);
                        float nn = Fbm(uv, lod, time);
                        float lat = 1 - smoothstep(0.6, 1.0, abs(uN) + (nn - 0.5) * 0.22);
                        // the towers with cauliflower billows; the same field a little toward the sun for the shading
                        float scB = 0.036, lodB = Lod(scB, wpp), cauli, cauliS;
                        float2 sunL = float2(dot(sunDir, l), dot(sunDir, f));
                        float d2 = 1.8;
                        float Ht = SquallHeight(float2(u, e), float2(u, v) * scB + B.w * 0.5, R, B.w, lodB, time, cauli) * lat;
                        float Hs = SquallHeight(float2(u, e) + sunL * d2, (float2(u, v) + sunL * d2) * scB + B.w * 0.5, R, B.w, lodB, time, cauliS) * lat;
                        float dConv = smoothstep(0.1, 0.2, Ht) * smoothstep(0.0, 0.25, s);
                        // the shelf cloud: a darker, striated arc on the leading edge, ragged in thickness
                        // (thickness and position wander along the line; striations run along it, arcus lip lit)
                        half shW = N4(float2(u * 0.0055 + B.w * 0.3, 0.71), max(lod - 1.0, 0)).g;
                        half stri = N4(float2(u * 0.011 + B.w, e * 0.12 + nn * 0.7), lod).r;
                        float wS = 0.045 * R * (0.45 + 1.1 * shW);
                        float eS = e - 0.012 * R + (nn - 0.5) * 0.05 * R + (shW - 0.5) * 0.03 * R;
                        shelf = exp(-(eS / wS) * (eS / wS)) * lat;
                        float dShelf = shelf * smoothstep(0.3, 0.72, stri * 0.6 + nn * 0.45 + shW * 0.15) * smoothstep(0.0, 0.3, s);
                        hi = shelf * smoothstep(0.0, 1.2, eS / wS) * smoothstep(0.45, 0.8, stri) * 0.07;
                        // the trailing stratiform deck: broken, flat and grey
                        float trail = e < 0 ? exp(e / (0.5 * R)) * smoothstep(0.02 * R, -0.06 * R, e) : 0;
                        float dStrat = Body(nn, saturate(trail * 1.2 * lat * saturate(0.35 + s)), 0.3);
                        dSys = max(dConv, max(dShelf, dStrat));
                        // which layer is on top colours it: towers white and lit, shelf dark slate, deck grey
                        float wConv = saturate(dConv * 1.6), wShelf = saturate(dShelf - dConv * 1.5);
                        tone = lerp(lerp(half3(0.72h, 0.74h, 0.78h), (half3)1.0h, (half)wConv), half3(0.5h, 0.55h, 0.63h), (half)wShelf);
                        sysLight = lerp((nn - 0.5) * 0.3 - 0.05, (Ht - Hs) * 3.6, wConv);
                        nSysTop = lerp(nn * 0.8, saturate(Ht * 1.15), wConv);
                        crev = (1 - cauli) * 0.14 * wConv + wShelf * 0.3;
                        // anvil cirrus: a fibrous veil streaming ahead of the towers, thin and fanning out
                        float eA = e - 0.035 * R;
                        float anvilEnv = exp(-(eA / (0.1 * R)) * (eA / (0.1 * R))) * lat;
                        float lodF = Lod(0.02, wpp);
                        half fib = N4(float2(u * 0.016 + B.w, v * 0.011 - time * 0.0015), lodF).a * 0.5 + N4(float2(u * 0.034 + 0.3, v * 0.024), lodF + 1.1).g * 0.3 + N4(float2(u * 0.02 + 0.6, v * 0.02), lodF).b * 0.2;
                        half puffs = N4(float2(u * 0.007 + B.w * 0.5, 0.37), 2).r;
                        cirrus = smoothstep(0.28, 0.85, fib * 0.7 + puffs * 0.45) * anvilEnv * smoothstep(0.1, 0.5, s) * 0.58;
                        storm = max(storm, saturate(Ht * 1.3) * s * 0.6);
                    }
                }

                // ---- compose: the denser of the two layers, lit as a height field toward the sun
                float d = max(dBg, dSys);
                bool sysTop = dSys >= dBg && dom >= 0;
                float a = max(d, cirrus);
                if (a <= 0.004 && under <= 0.004) discard;
                float light = sysTop ? sysLight : (dBg - dBgSun) * 1.9;
                float nTop = sysTop ? nSysTop : nBgTop;
                float shade = saturate(0.55 + clamp(light, -0.5, 0.32));
                float crown = smoothstep(0.35, 0.95, nTop);
                float relief = saturate(shade * 0.65 + crown * 0.42 - 0.08 + (sysTop ? 0.2 - crev : 0));
                half3 sunCol = _MainLightColor.rgb;
                half3 amb = _SE_AmbientSky.rgb;
                half3 top = half3(0.92h, 0.92h, 0.93h) * sunCol * (half)lerp(1.0, 0.88, storm);
                half3 lee = half3(0.5h, 0.52h, 0.58h) * (amb * 1.15h + sunCol * 0.24h) * (half)lerp(1.0, 0.66, storm);
                half3 c = lerp(lee, top, (half)relief);
                if (sysTop) c *= tone;
                c *= (half)(1 - rain * 0.1);
                // thin edges catch a little light; sunlit rims (the eyewall's far inner face)
                c += sunCol * (half)(saturate(1 - d * 1.8) * relief * 0.08 + hi);
                c = lerp(c, c * half3(0.86h, 0.88h, 0.95h), (half)(storm * 0.4));
                // high veil: pale, flat, faintly shaded on the lee
                half3 veil = (half3(0.9h, 0.92h, 0.96h) * sunCol * 0.82h + amb * 0.3h);
                c = lerp(veil, c, (half)saturate(d / max(a, 1e-3)));
                // lightning: strikes light the cloud from inside, storm cores flicker
                // (a soft glow round a jittered point in each 26-unit cell, so a flash never shows the cell's square)
                float2 cellKey = floor(p / 26.0);
                float beat = time * 1.2 + Hash(cellKey) * 9;
                float2 glowAt = (cellKey + 0.3 + 0.4 * float2(Hash(cellKey + 0.17), Hash(cellKey + 0.61))) * 26.0;
                float glow = saturate(1 - length(p - glowAt) / 7.8);
                float flick = storm > 0.45 && Hash(cellKey + floor(beat) * 1.37) > 1 - (storm - 0.45) * 0.22 ? exp(-frac(beat) * 7) * (.6 + .4 * sin(time * 47)) * glow * glow : 0;
                float flash = flick * 0.7 + StrikeGlow(p, 34);
                c += half3(0.72h, 0.78h, 1.0h) * (half)(flash * (0.6 + d * 0.8)) * (half)_SE_WxParams.y;
                c = MixFog(c, i.fogCoord);
                // opacity: storms near-solid at strategic zoom, fair-weather cloud a thin veil
                float alpha = saturate(a * lerp(0.62, 1.0, saturate(max(storm * 1.6, sysTop ? 0.75 : 0.0)))) * vis;
                // the dark layer under the deck (the eye's shadowed floor) shows where the deck is thin
                float ua = under * vis * (1 - alpha);
                half3 underCol = half3(0.08h, 0.09h, 0.12h);
                return half4(c * (half)alpha + underCol * (half)ua, (half)(alpha + ua));
            }
            ENDHLSL
        }
    }
}
