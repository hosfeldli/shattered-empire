Shader "Hidden/SE/ReviewComposite"
{
    Properties { _MainTex ("UI", 2D) = "black" {} }
    SubShader
    {
        Pass
        {
            ZTest Always ZWrite Off Cull Off
            Blend One OneMinusSrcAlpha
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            struct V { float4 vertex : SV_POSITION; float2 uv : TEXCOORD0; };
            V vert(float4 vertex : POSITION, float2 uv : TEXCOORD0) { V o; o.vertex = TransformObjectToHClip(vertex.xyz); o.uv = uv; return o; }
            half4 frag(V i) : SV_Target { return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv); }
            ENDHLSL
        }
    }
}
