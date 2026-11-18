// Imaginarium: leaf cards and vertex-colored meshes for the Built-in render pipeline.
// UV2.x = wind weight, UV2.y = per-card phase; COLOR = per-card tint (as leaves_wind.gdshader in Godot).
Shader "Imaginarium/Foliage Built-in"
{
    Properties
    {
        _BaseMap("Base Map", 2D) = "white" {}
        _BaseColor("Base Color", Color) = (1,1,1,1)
        _Cutoff("Alpha Cutoff", Range(0,1)) = 0.5
        [Toggle] _AlphaClip("Alpha Clip", Float) = 1
        _UseVertexColor("Vertex Color", Range(0,1)) = 1
        _Wind("Wind", Range(0,1)) = 1
        _WindDirection("Wind Direction (world)", Vector) = (-1,0,0.35,0)
        _WindStrength("Wind Strength", Range(0,0.5)) = 0.07
        _WindSpeed("Wind Speed", Range(0,5)) = 1.4
        _Flutter("Flutter", Range(0,0.2)) = 0.025
        _Backlight("Backlight", Color) = (0.25,0.3,0.12,1)
        [Enum(UnityEngine.Rendering.CullMode)] _Cull("Cull", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="TransparentCutout" "Queue"="AlphaTest" "IgnoreProjector"="True" }
        Cull [_Cull]
        CGPROGRAM
        #pragma surface surf WrapLambert vertex:vert addshadow fullforwardshadows
        #pragma target 3.0
        sampler2D _BaseMap;
        fixed4 _BaseColor;
        half _Cutoff, _AlphaClip, _UseVertexColor, _Wind, _WindStrength, _WindSpeed, _Flutter;
        float4 _WindDirection;
        fixed4 _Backlight;

        struct Input { float2 uv_BaseMap; float4 color : COLOR; };

        void vert(inout appdata_full v)
        {
            float3 wp = mul(unity_ObjectToWorld, v.vertex).xyz;
            float w = v.texcoord1.x * _Wind;
            float ph = v.texcoord1.y * 6.28318;
            float t = _Time.y;
            float sway = sin(t * _WindSpeed + wp.x * 0.35 + wp.z * 0.25 + ph * 0.3);
            float flut = sin(t * _WindSpeed * 4.3 + ph) * _Flutter;
            float3 nWS = UnityObjectToWorldNormal(v.normal);
            wp += normalize(_WindDirection.xyz + float3(1e-5, 0, 0)) * sway * _WindStrength * w + nWS * flut * w;
            v.vertex.xyz = mul(unity_WorldToObject, float4(wp, 1)).xyz;
        }

        half4 LightingWrapLambert(SurfaceOutput s, half3 lightDir, half atten)
        {
            half ndl = dot(s.Normal, lightDir);
            half4 c;
            c.rgb = s.Albedo * _LightColor0.rgb * (saturate((ndl + 0.5) / 1.5) * atten)
                  + s.Albedo * _Backlight.rgb * saturate(-ndl) * _LightColor0.rgb * atten;
            c.a = s.Alpha;
            return c;
        }

        void surf(Input IN, inout SurfaceOutput o)
        {
            fixed4 t = tex2D(_BaseMap, IN.uv_BaseMap) * _BaseColor;
            if (_AlphaClip > 0.5) clip(t.a - _Cutoff);
            o.Albedo = t.rgb * lerp(fixed3(1, 1, 1), IN.color.rgb, _UseVertexColor);
            o.Alpha = t.a;
        }
        ENDCG
    }
    FallBack "Legacy Shaders/Transparent/Cutout/VertexLit"
}
