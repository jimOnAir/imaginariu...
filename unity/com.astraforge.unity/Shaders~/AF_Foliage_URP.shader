// AstraForge: leaf cards and vertex-colored meshes for URP 17 (Unity 6).
// UV2.x = wind weight (0 at the trunk, 1 at the crown edge), UV2.y = per-card phase; COLOR = per-card tint.
// Same motion as leaves_wind.gdshader of the Godot packages: sway along the wind + flutter along the normal.
Shader "AstraForge/Foliage URP"
{
    Properties
    {
        [MainTexture] _BaseMap("Base Map", 2D) = "white" {}
        [MainColor] _BaseColor("Base Color", Color) = (1,1,1,1)
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
        Tags { "RenderType"="TransparentCutout" "Queue"="AlphaTest" "RenderPipeline"="UniversalPipeline" "IgnoreProjector"="True" }
        Cull [_Cull]

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
        CBUFFER_START(UnityPerMaterial)
            float4 _BaseMap_ST;
            half4 _BaseColor;
            half _Cutoff;
            half _AlphaClip;
            half _UseVertexColor;
            half _Wind;
            float4 _WindDirection;
            float _WindStrength;
            float _WindSpeed;
            float _Flutter;
            half4 _Backlight;
            half _Cull;
        CBUFFER_END

        float3 AFWindWS(float3 positionOS, float3 normalOS, float2 uv2)
        {
            float3 wp = TransformObjectToWorld(positionOS);
            float w = uv2.x * _Wind;
            float ph = uv2.y * 6.28318;
            float t = _Time.y;
            float sway = sin(t * _WindSpeed + wp.x * 0.35 + wp.z * 0.25 + ph * 0.3);
            float flut = sin(t * _WindSpeed * 4.3 + ph) * _Flutter;
            float3 dirWS = normalize(_WindDirection.xyz + float3(1e-5, 0, 0));
            float3 nWS = TransformObjectToWorldNormal(normalOS);
            return wp + dirWS * sway * _WindStrength * w + nWS * flut * w;
        }

        half AFAlpha(float2 uv)
        {
            return SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, uv).a * _BaseColor.a;
        }
        ENDHLSL

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHT_SHADOWS
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile _ _FORWARD_PLUS
            #pragma multi_compile_fog
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS : NORMAL;
                float2 uv : TEXCOORD0;
                float2 uv2 : TEXCOORD1;
                half4 color : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 positionWS : TEXCOORD1;
                float3 normalWS : TEXCOORD2;
                half4 color : TEXCOORD3;
                half fogFactor : TEXCOORD4;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_TRANSFER_INSTANCE_ID(v, o);
                float3 wp = AFWindWS(v.positionOS.xyz, v.normalOS, v.uv2);
                o.positionWS = wp;
                o.positionCS = TransformWorldToHClip(wp);
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                o.uv = TRANSFORM_TEX(v.uv, _BaseMap);
                o.color = lerp(half4(1, 1, 1, 1), v.color, _UseVertexColor);
                o.fogFactor = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i, bool front : SV_IsFrontFace) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);
                half4 tex = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, i.uv) * _BaseColor;
                if (_AlphaClip > 0.5) clip(tex.a - _Cutoff);
                half3 albedo = tex.rgb * i.color.rgb;
                float3 n = normalize(i.normalWS) * (front ? 1.0 : -1.0);
                float4 shadowCoord = TransformWorldToShadowCoord(i.positionWS);
                Light ml = GetMainLight(shadowCoord);
                half ndl = dot(n, ml.direction);
                half att = ml.shadowAttenuation * ml.distanceAttenuation;
                half3 col = albedo * ml.color * (saturate((ndl + 0.5) / 1.5) * att);          // wrapped Lambert
                col += albedo * _Backlight.rgb * saturate(-ndl) * ml.color * att;            // light through leaves
                col += albedo * SampleSH(n);
            #if defined(_ADDITIONAL_LIGHTS) || defined(_FORWARD_PLUS)
                InputData inputData = (InputData)0;
                inputData.positionWS = i.positionWS;
                inputData.normalWS = n;
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
                uint pixelLightCount = GetAdditionalLightsCount();
                LIGHT_LOOP_BEGIN(pixelLightCount)
                    Light l = GetAdditionalLight(lightIndex, i.positionWS, half4(1, 1, 1, 1));
                    col += albedo * l.color * (saturate((dot(n, l.direction) + 0.5) / 1.5) * l.distanceAttenuation * l.shadowAttenuation);
                LIGHT_LOOP_END
            #endif
                col = MixFog(col, i.fogFactor);
                return half4(col, 1);
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode"="ShadowCaster" }
            ZWrite On
            ZTest LEqual
            ColorMask 0
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"
            float3 _LightDirection;
            float3 _LightPosition;
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float2 uv2 : TEXCOORD1; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };
            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                float3 wp = AFWindWS(v.positionOS.xyz, v.normalOS, v.uv2);
                float3 nWS = TransformObjectToWorldNormal(v.normalOS);
            #if defined(_CASTING_PUNCTUAL_LIGHT_SHADOW)
                float3 lightDir = normalize(_LightPosition - wp);
            #else
                float3 lightDir = _LightDirection;
            #endif
                float4 cs = TransformWorldToHClip(ApplyShadowBias(wp, nWS, lightDir));
            #if UNITY_REVERSED_Z
                cs.z = min(cs.z, UNITY_NEAR_CLIP_VALUE);
            #else
                cs.z = max(cs.z, UNITY_NEAR_CLIP_VALUE);
            #endif
                o.positionCS = cs;
                o.uv = TRANSFORM_TEX(v.uv, _BaseMap);
                return o;
            }
            half4 frag(Varyings i) : SV_Target
            {
                if (_AlphaClip > 0.5) clip(AFAlpha(i.uv) - _Cutoff);
                return 0;
            }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode"="DepthOnly" }
            ZWrite On
            ColorMask R
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float2 uv2 : TEXCOORD1; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };
            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                o.positionCS = TransformWorldToHClip(AFWindWS(v.positionOS.xyz, v.normalOS, v.uv2));
                o.uv = TRANSFORM_TEX(v.uv, _BaseMap);
                return o;
            }
            half frag(Varyings i) : SV_Target
            {
                if (_AlphaClip > 0.5) clip(AFAlpha(i.uv) - _Cutoff);
                return i.positionCS.z;
            }
            ENDHLSL
        }

        Pass
        {
            Name "DepthNormals"
            Tags { "LightMode"="DepthNormals" }
            ZWrite On
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float2 uv2 : TEXCOORD1; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; float3 normalWS : TEXCOORD1; };
            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                o.positionCS = TransformWorldToHClip(AFWindWS(v.positionOS.xyz, v.normalOS, v.uv2));
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                o.uv = TRANSFORM_TEX(v.uv, _BaseMap);
                return o;
            }
            half4 frag(Varyings i, bool front : SV_IsFrontFace) : SV_Target
            {
                if (_AlphaClip > 0.5) clip(AFAlpha(i.uv) - _Cutoff);
                float3 n = normalize(i.normalWS) * (front ? 1.0 : -1.0);
                return half4(n, 0.0);
            }
            ENDHLSL
        }
    }
    Fallback "Hidden/Universal Render Pipeline/FallbackError"
}
