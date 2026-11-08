// Procedurally instanced lit geometry: units, building modules, trees, props, craters. Per-instance
// transform and colour come from a StructuredBuffer (one GPU upload per batch per change), drawn
// with Graphics.RenderMeshPrimitives. No GameObject per instance.
Shader "SE/InstancedLit"
{
    Properties
    {
        _Gloss ("Gloss", Range(0, 1)) = 0.1
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }

        HLSLINCLUDE
        #include "SECommon.hlsl"
        struct SEInstance
        {
            float4 row0;   // object-to-world 3x4 rows
            float4 row1;
            float4 row2;
            float4 color;  // rgb albedo, a = emission
        };
        StructuredBuffer<SEInstance> _Instances;
        float4 _SE_ImageOffset;   // x: world-wrap image shift for this draw
        float _Gloss;

        void SE_InstanceTransform(uint id, float3 positionOS, float3 normalOS, out float3 positionWS, out float3 normalWS, out float4 color)
        {
            SEInstance inst = _Instances[id];
            float3x4 m = float3x4(inst.row0, inst.row1, inst.row2);
            positionWS = mul(m, float4(positionOS, 1.0)) + float3(_SE_ImageOffset.x, 0, 0);
            // non-uniform scale: normals use the inverse transpose of the 3x3 part, which is the
            // cofactor matrix (rows r1×r2, r2×r0, r0×r1) up to the determinant's scale
            float3x3 m3 = (float3x3)m;
            float3x3 cof = float3x3(cross(m3[1], m3[2]), cross(m3[2], m3[0]), cross(m3[0], m3[1]));
            normalWS = normalize(mul(cof, normalOS));
            color = inst.color;
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
            #pragma multi_compile_fog

            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float4 vcolor : COLOR; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                half3 normalWS : TEXCOORD1;
                half4 color : TEXCOORD2;
                float fogCoord : TEXCOORD3;
            };

            Varyings vert(Attributes v, uint instanceID : SV_InstanceID)
            {
                Varyings o;
                float3 p, n; float4 c;
                SE_InstanceTransform(instanceID, v.positionOS, v.normalOS, p, n, c);
                o.positionWS = p;
                o.normalWS = n;
                // vertex colour tints parts of a mesh (windows, tracks, roofs); white keeps the instance colour
                o.color = half4(c.rgb * v.vcolor.rgb, c.a * v.vcolor.a);
                o.positionCS = TransformWorldToHClip(p);
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 n = normalize(i.normalWS);
                half3 color = SE_Shade(i.color.rgb, i.positionWS, n, i.color.a);
                // a little specular from the sun on metal and glass
                half3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                Light sun = GetMainLight();
                half spec = pow(saturate(dot(n, normalize(sun.direction + viewDir))), 24.0h) * _Gloss;
                color += sun.color * spec;
                return half4(SE_ApplyFog(color, i.positionWS, i.fogCoord), 1);
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ZWrite On ZTest LEqual ColorMask 0 Cull Back
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; };
            float4 vert(Attributes v, uint instanceID : SV_InstanceID) : SV_POSITION
            {
                float3 p, n; float4 c;
                SE_InstanceTransform(instanceID, v.positionOS, v.normalOS, p, n, c);
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
            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; };
            float4 vert(Attributes v, uint instanceID : SV_InstanceID) : SV_POSITION
            {
                float3 p, n; float4 c;
                SE_InstanceTransform(instanceID, v.positionOS, v.normalOS, p, n, c);
                return TransformWorldToHClip(p);
            }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
