// The Blight's creatures (HordeRenderer): procedurally instanced like SE/InstancedLit, but every motion is done here in
// the vertex shader. The CPU writes one record per creature (position, heading, scale, gait phase, how fast it moves,
// strike and rise times, elite level, health) and the shader builds the pose: twitching heading with sudden jerks,
// scuttling bob, pitch and roll, legs stepping and lifting, arms swinging about the shoulder and clubbing down in a
// strike (rear back, then slam), sacs pulsing and swelling before a spit, heads trembling, stalks and spines swaying,
// mouths gnashing and gaping, and creatures clawing up out of the ground. Per-vertex animation regions and weights are
// baked into the models (tools/blender/build_horde.py; HordeMeshes for the code-built fallback):
//   uv0.x = region + phase (turns)   uv0.y = weight   colour.a = 1 - glow
//   regions: 0 body, 1 leg, 2 arm, 3 sac, 4 head, 5 spine/stalk, 6 jaw (opens toward its phase: 0 -x, .25 up, .5 +x, .75 down)
// Per-kind amplitudes are material properties (one material per creature kind).
Shader "SE/HordeLit"
{
    Properties
    {
        _LegStride ("Leg stride", Float) = .12
        _LegLift ("Leg lift", Float) = .06
        _Bob ("Body bob", Float) = .08
        _Twitch ("Heading twitch (rad)", Float) = .1
        _JerkAmp ("Jerk size (rad)", Float) = .7
        _JerkRate ("Jerks per second", Float) = .7
        _ArmPivot ("Arm pivot (|x|, y, z) + swing", Vector) = (.4, .7, 0, .5)
        _SacAmp ("Sac pulse", Float) = 0
        _SacRate ("Sac pulse rate", Float) = 4
        _Breathe ("Body breathing", Float) = .025
        _BreatheRate ("Breathing rate", Float) = 2.6
        _Tremor ("Head tremor", Float) = .02
        _Sway ("Stalk sway", Float) = .04
        _Jaw ("Jaw gape", Float) = .04
        _Still ("Rooted (hive: no gait or heading motion)", Float) = 0
        _Gloss ("Wet gloss", Range(0, 1)) = .45
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }
        Cull Back

        HLSLINCLUDE
        #include "SECommon.hlsl"
        struct HordeInstance
        {
            float4 posYaw;   // xyz world position (feet), w Unity yaw (radians)
            float4 motion;   // x scale, y gait phase (radians), z moving 0..1, w seed
            float4 events;   // x strike time, y rise time, z elite level, w health 0..1
            float4 extra;    // x engaged (1/0), yzw spare
        };
        StructuredBuffer<HordeInstance> _Horde;
        float _HordeTime;
        float _LegStride, _LegLift, _Bob, _Twitch, _JerkAmp, _JerkRate, _SacAmp, _SacRate, _Breathe, _BreatheRate;
        float _Tremor, _Sway, _Jaw, _Still, _Gloss;
        float4 _ArmPivot;

        uint SE_Pcg(uint v)
        {
            uint state = v * 747796405u + 2891336453u;
            uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
            return (word >> 22u) ^ word;
        }
        float SE_Hash(float n) { return SE_Pcg((uint)(int)floor(n)) * (1.0 / 4294967295.0); }
        // smooth 1D value noise in -1..1
        float SE_VNoise(float x, float seed)
        {
            float o = seed * 57.31;
            float i = floor(x + o), f = frac(x + o);
            float u = f * f * (3 - 2 * f);
            return lerp(SE_Hash(i), SE_Hash(i + 1), u) * 2 - 1;
        }
        float3 SE_RotX(float3 p, float a) { float s, c; sincos(a, s, c); return float3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }   // + = nose down
        float3 SE_RotY(float3 p, float a) { float s, c; sincos(a, s, c); return float3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }  // Unity yaw
        float3 SE_RotZ(float3 p, float a) { float s, c; sincos(a, s, c); return float3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }

        // 2026-11-20 palette grade: the baked vertex colours (tools/blender/build_horde.py COL) read pastel (cream flesh,
        // lilac bruises, pale green bile). Grade them into bruised greys and near-blacks, wet dark reds for sinew and gums,
        // a sour green for bile, and a sickly yellow-green for whatever glows (eyes, pus, sacs); each model's light/dark
        // structure (its silhouette and markings) is kept. sRGB in, sRGB out.
        float3 SE_BlightGrade(float3 c, float glow)
        {
            float l = dot(c, float3(.3, .59, .11));
            float3 g = lerp(float3(.06, .055, .065), float3(.38, .35, .36), smoothstep(.1, .95, l));      // bruised grey ramp
            float purple = saturate((c.b - c.g) * 4);                                                    // bruises
            g = lerp(g, float3(.21, .09, .15) * (.6 + .8 * l), purple);
            float red = saturate((c.r - max(c.g, c.b) - .1) * 3.5);                                     // sinew, gums
            g = lerp(g, float3(.34, .035, .045) * (.75 + .6 * l), red);
            float green = saturate((c.g - c.r) * 6);                                                     // bile, rot
            g = lerp(g, float3(.36, .45, .08) * (.45 + .9 * l), green);
            float pus = saturate((min(c.r, c.g) - c.b) * 2.5) * smoothstep(.74, .86, l);               // pus, eyes
            g = lerp(g, float3(.58, .62, .16), pus);
            return lerp(g, float3(.72, .9, .2), saturate(glow * 2));                                     // glows: sickly yellow-green
        }

        void SE_HordeVertex(uint id, float3 p, float3 n, float2 uv, float4 vcolor, out float3 positionWS, out float3 normalWS, out float4 color, out float glow)
        {
            HordeInstance h = _Horde[id];
            float T = _HordeTime;
            float scale = h.motion.x, phase = h.motion.y, moving = h.motion.z, seed = h.motion.w;
            float elite = h.events.z, health = h.events.w;
            float lungeK = h.extra.x > .5 ? 1.0 : .6;
            float region = floor(uv.x + .001), ph = frac(uv.x + .001), w = saturate(uv.y);
            float still = _Still;

            // strike: rear back for a quarter second, then slam forward and down
            float st = (T - h.events.x) / .55;
            float active = st >= 0 && st < 1 ? 1.0 : 0.0;
            float rear = active * smoothstep(0, .26, st) * (1 - smoothstep(.26, .4, st));
            float slam = active * smoothstep(.28, .4, st) * (1 - smoothstep(.55, 1, st));

            // ---- local deformation by region
            if (region == 1)        // legs: step and lift with the gait, scrabble when idle, splay on the slam
            {
                float a = phase + ph * 6.2832;
                float idle = SE_VNoise(T * 7 + ph * 13, seed + ph) * (1 - moving) * (1 - still);
                p.z += w * (_LegStride * sin(a) * moving + idle * _LegStride * .35);
                p.y += w * (_LegLift * max(0, cos(a)) * moving + abs(idle) * _LegLift * .5);
                p.x += sign(p.x) * w * slam * .06;
            }
            else if (region == 2)   // arms: swing about the shoulder, raised overhead in the rear-back, clubbed down in the slam
            {
                float side = p.x >= 0 ? 1 : -1;
                float swing = sin(phase + (side > 0 ? 0 : 3.1416)) * _ArmPivot.w * moving + SE_VNoise(T * 2, seed + side) * .14;
                float ang = (swing + rear * 2.1 + slam * .55) * smoothstep(0, .22, w);
                float3 pivot = float3(side * _ArmPivot.x, _ArmPivot.y, _ArmPivot.z);
                p = pivot + SE_RotX(p - pivot, -ang);
                n = SE_RotX(n, -ang);
            }
            else if (region == 3)   // sacs: throb, swell before the spit, squeeze in it
            {
                float pulse = sin(T * _SacRate + ph * 6.2832 + seed * 3) * .5 + .5;
                p += n * w * _SacAmp * (.35 + .65 * pulse + rear * 1.6 - slam * .8);
            }
            else if (region == 4)   // heads: tremble, snap forward in the strike
            {
                float3 tremor = float3(SE_VNoise(T * 17, seed), SE_VNoise(T * 15, seed + 3), SE_VNoise(T * 19, seed + 7)) * _Tremor;
                float snap = step(.93, SE_Hash(T * 3 + seed * 11)) * _Tremor * 2;   // the odd violent twitch
                p += w * (tremor + float3(snap, -slam * .03 + rear * .05, slam * .09 * lungeK));
            }
            else if (region == 5)   // stalks, spines, entrails: sway, trail when moving; elites' bristle more
            {
                float k = 1 + elite * .3;
                float3 sway = float3(sin(T * 2.3 + ph * 6.2832 + seed), .3 * sin(T * 3.1 + ph * 4 + seed), cos(T * 1.7 + ph * 5.1 + seed)) * _Sway * k;
                p += w * (sway + float3(0, 0, -moving * _Sway * .8));
            }
            else if (region == 6)   // jaws: gnash, gape in the strike
            {
                float gnash = pow(saturate(sin(T * 9 + seed * 5 + ph) * .5 + .5), 4) * .6;
                float open = .2 + gnash + rear * 1.2 + slam * .5;
                float s, c; sincos(ph * 6.2832, s, c);
                p += float3(-c, s, 0) * w * open * _Jaw;
            }

            // ---- whole body: breathing, bob, lunge, rising out of the ground
            p.y *= 1 + sin(T * _BreatheRate + seed * 2) * _Breathe;
            float mobile = 1 - still;
            float bob = abs(sin(phase)) * _Bob * moving * mobile;
            float pitch = (sin(phase * 2) * .08 * moving + SE_VNoise(T * 3, seed + 5) * .05 + (-rear * .35 + slam * .5) * lungeK) * mobile;
            float roll = (sin(phase) * .1 * moving + SE_VNoise(T * 11, seed + 9) * .04) * mobile;
            float lungeZ = (slam * .3 - rear * .08) * lungeK * mobile;
            float sink = 0;
            float rt = (T - h.events.y) / 1.4;
            if (rt >= 0 && rt < 1)
            {
                sink = 1 - smoothstep(0, 1, rt);
                roll += SE_VNoise(T * 20, seed) * .45 * (1 - rt);
                pitch -= .45 * (1 - rt);
            }
            p += float3(0, bob - sink * 1.05, lungeZ);
            // heading: a constant nervous twitch plus sudden jerks that decay
            float jt = T * _JerkRate + seed * 3.7;
            float since = frac(jt) / max(_JerkRate, .01);
            float jerk = (SE_Hash(floor(jt) + seed * 101) - .5) * _JerkAmp * exp(-since * 7);
            float yaw = h.posYaw.w + (SE_VNoise(T * 9, seed) * _Twitch + jerk) * mobile;
            p = SE_RotY(SE_RotX(SE_RotZ(p, roll), pitch), yaw);
            n = SE_RotY(SE_RotX(SE_RotZ(n, roll), pitch), yaw);
            positionWS = h.posYaw.xyz + p * scale;
            normalWS = normalize(n);

            // elites go darker and redder and smoulder; the badly wounded bloodied
            float e = min(4, elite) / 4;
            float3 tint = lerp(float3(1, 1, 1), float3(.95, .5, .45), e * .8);
            if (health < .4) tint = lerp(tint, float3(1.1, .62, .58), (.4 - health) * 1.25);
            float eliteGlow = elite > 0 ? .25 + .15 * sin(T * 5 + seed) : 0;
            glow = saturate(1 - vcolor.a);
            float throb = .55 + .45 * sin(T * 3.2 + seed * 7 + ph * 6.2832);
            color = float4(SE_BlightGrade(vcolor.rgb, saturate(1 - vcolor.a)) * tint,eliteGlow + glow * (.6 + .9 * throb + rear * 1.5));
        }
        ENDHLSL

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHTS
            #pragma multi_compile_fog

            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float4 vcolor : COLOR; float2 uv : TEXCOORD0; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                half3 normalWS : TEXCOORD1;
                half4 color : TEXCOORD2;
                float fogCoord : TEXCOORD3;
                half glow : TEXCOORD4;
            };

            Varyings vert(Attributes v, uint instanceID : SV_InstanceID)
            {
                Varyings o;
                float3 p, n; float4 c; float g;
                SE_HordeVertex(instanceID, v.positionOS, v.normalOS, v.uv, v.vcolor, p, n, c, g);
                o.positionWS = p; o.normalWS = n; o.color = c; o.glow = g;
                o.positionCS = TransformWorldToHClip(p);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 n = normalize((float3)i.normalWS);
                half3 albedo = SRGBToLinear(saturate(i.color.rgb));
                half3 color = SE_Shade(albedo, i.positionWS, n, i.color.a);
                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                // wet flesh: a tight glistening highlight, stronger on sacs and pustules
                half gloss = saturate(_Gloss + i.glow * .4h);
                half spec = pow(saturate(dot(n, normalize(sun.direction + viewDir))), lerp(16.0h, 96.0h, gloss)) * gloss * gloss * sun.shadowAttenuation;
                color += sun.color * spec * _SE_Glare * .8h;
                // a sickly translucent rim where the light shows through thin flesh
                half rim = pow(1.0h - saturate(dot(n, viewDir)), 3.0h);
                // plus a faint sour-green edge independent of the (now dark) albedo, so silhouettes hold on dark ground
                color += (albedo * half3(.55h, .7h, .3h) * .35h + half3(.05h, .07h, .015h)) * rim * (.4h + .6h * sun.shadowAttenuation);
                if (any(isnan(color)) || any(isinf(color))) color = albedo * .35h;
                color = clamp(color, 0, 10.0h);
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), 1);
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ZWrite On ZTest LEqual ColorMask 0
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float4 vcolor : COLOR; float2 uv : TEXCOORD0; };
            float4 vert(Attributes v, uint instanceID : SV_InstanceID) : SV_POSITION
            {
                float3 p, n; float4 c; float g;
                SE_HordeVertex(instanceID, v.positionOS, v.normalOS, v.uv, v.vcolor, p, n, c, g);
                return SE_ShadowPositionCS(p, n);
            }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ZWrite On ColorMask R
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float4 vcolor : COLOR; float2 uv : TEXCOORD0; };
            float4 vert(Attributes v, uint instanceID : SV_InstanceID) : SV_POSITION
            {
                float3 p, n; float4 c; float g;
                SE_HordeVertex(instanceID, v.positionOS, v.normalOS, v.uv, v.vcolor, p, n, c, g);
                return TransformWorldToHClip(p);
            }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
