using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace AstraForge.Editor
{
    public enum AFRenderPipeline { BuiltIn, URP, HDRP }

    /// <summary>Shaders and materials for the project's active render pipeline (no pink materials).</summary>
    public static class AFPipeline
    {
        public const string ShaderFolder = "Assets/AstraForge/_Shaders";

        public static AFRenderPipeline Current
        {
            get
            {
                var rp = GraphicsSettings.currentRenderPipeline;
                if (rp == null) return AFRenderPipeline.BuiltIn;
                var n = rp.GetType().FullName ?? "";
                if (n.Contains("HighDefinition")) return AFRenderPipeline.HDRP;
                return AFRenderPipeline.URP;
            }
        }

        public static string LitShader(AFRenderPipeline p) =>
            p == AFRenderPipeline.URP ? "Universal Render Pipeline/Lit" : p == AFRenderPipeline.HDRP ? "HDRP/Lit" : "Standard";

        public static string FoliageShader(AFRenderPipeline p) =>
            p == AFRenderPipeline.URP ? "AstraForge/Foliage URP" : p == AFRenderPipeline.HDRP ? "HDRP/Lit" : "AstraForge/Foliage Built-in";

        /// <summary>Is this shader drawable by the given pipeline (the importer's "no pink" rule)?</summary>
        public static bool ShaderFits(Shader s, AFRenderPipeline p)
        {
            if (s == null || !s.isSupported || ShaderUtil.ShaderHasError(s)) return false;
            var n = s.name;
            if (n.StartsWith("Hidden/InternalErrorShader")) return false;
            switch (p)
            {
                case AFRenderPipeline.URP:
                    return n.StartsWith("Universal Render Pipeline/") || n == "AstraForge/Foliage URP" || n.StartsWith("Sprites/");
                case AFRenderPipeline.HDRP:
                    return n.StartsWith("HDRP/") || n.StartsWith("Sprites/");
                default:
                    return !n.StartsWith("Universal Render Pipeline/") && !n.StartsWith("HDRP/") && n != "AstraForge/Foliage URP";
            }
        }

        // ------------------------------------------------------------------ AstraForge shaders (Shaders~)

        static string PackageRoot()
        {
            var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(AFPipeline).Assembly);
            return info != null ? info.resolvedPath : null;
        }

        /// <summary>Shaders of the package live in Shaders~ (ignored by Unity) so a project without URP does not
        /// compile the URP one; the needed file is copied into Assets/AstraForge/_Shaders on demand.</summary>
        public static Shader EnsureShader(string shaderName)
        {
            var s = Shader.Find(shaderName);
            if (s != null) return s;
            string file = shaderName == "AstraForge/Foliage URP" ? "AF_Foliage_URP.shader"
                : shaderName == "AstraForge/Foliage Built-in" ? "AF_Foliage_BuiltIn.shader" : null;
            var root = PackageRoot();
            if (file == null || root == null) return null;
            var src = Path.Combine(root, "Shaders~", file);
            if (!File.Exists(src)) return null;
            Directory.CreateDirectory(ShaderFolder);
            var dst = ShaderFolder + "/" + file;
            File.Copy(src, dst, true);
            AssetDatabase.ImportAsset(dst, ImportAssetOptions.ForceSynchronousImport);
            return AssetDatabase.LoadAssetAtPath<Shader>(dst) ?? Shader.Find(shaderName);
        }

        // ------------------------------------------------------------------ materials

        static Texture2D Tex(string folder, string rel) =>
            string.IsNullOrEmpty(rel) ? null : AssetDatabase.LoadAssetAtPath<Texture2D>(folder + "/" + rel);

        static Color Col(float[] c, float a = 1f) =>
            c == null ? Color.white : new Color(c[0], c.Length > 1 ? c[1] : 0, c.Length > 2 ? c[2] : 0, c.Length > 3 ? c[3] : a);

        public static Material BuildMaterial(AFPackageData pkg, AFMaterialData m, string path, AFRenderPipeline p)
        {
            bool special = m.wind || m.vertex_color;
            var shader = special ? EnsureShader(FoliageShader(p)) : Shader.Find(LitShader(p));
            if (shader == null) shader = Shader.Find(LitShader(p));
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader) { name = m.name };
                AssetDatabase.CreateAsset(mat, path);
            }
            else mat.shader = shader;
            mat.shaderKeywords = new string[0];
            var baseMap = Tex(pkg.folder, m.base_map);
            var normal = Tex(pkg.folder, m.normal_map);
            var mask = Tex(pkg.folder, m.mask_map);
            var emis = Tex(pkg.folder, m.emission_map);
            var baseCol = Col(m.base_color);
            var emisCol = Col(m.emission_color, 1f);
            bool cut = m.alpha == "cutout", blend = m.alpha == "blend";

            if (shader.name.StartsWith("AstraForge/Foliage"))
            {
                mat.SetTexture("_BaseMap", baseMap);
                mat.SetColor("_BaseColor", baseCol);
                mat.SetFloat("_Cutoff", m.cutoff);
                mat.SetFloat("_AlphaClip", cut || blend ? 1f : 0f);
                mat.SetFloat("_UseVertexColor", m.vertex_color ? 1f : 0f);
                mat.SetFloat("_Wind", m.wind ? 1f : 0f);
                mat.SetVector("_WindDirection", AFPackageData.V3(m.wind_direction, new Vector3(-1, 0, 0.35f)));
                mat.SetFloat("_WindStrength", m.wind_strength);
                mat.SetFloat("_WindSpeed", m.wind_speed);
                mat.SetFloat("_Flutter", m.flutter);
                mat.SetFloat("_Cull", m.double_sided ? 0f : 2f);
                mat.renderQueue = cut || blend ? (int)RenderQueue.AlphaTest : (int)RenderQueue.Geometry;
            }
            else if (p == AFRenderPipeline.URP) SetupUrpLit(mat, m, baseMap, normal, mask, emis, baseCol, emisCol);
            else if (p == AFRenderPipeline.HDRP) SetupHdrpLit(mat, m, baseMap, normal, mask, emis, baseCol, emisCol);
            else SetupStandard(mat, m, baseMap, normal, mask, emis, baseCol, emisCol);
            EditorUtility.SetDirty(mat);
            return mat;
        }

        static void SetupUrpLit(Material mat, AFMaterialData m, Texture2D baseMap, Texture2D normal, Texture2D mask,
                                Texture2D emis, Color baseCol, Color emisCol)
        {
            bool cut = m.alpha == "cutout", blend = m.alpha == "blend";
            mat.SetTexture("_BaseMap", baseMap);
            mat.SetTexture("_MainTex", baseMap);
            mat.SetColor("_BaseColor", baseCol);
            mat.SetColor("_Color", baseCol);
            mat.SetFloat("_WorkflowMode", 1f);
            mat.SetFloat("_Metallic", mask != null ? 1f : m.metallic);
            mat.SetFloat("_Smoothness", mask != null ? 1f : m.smoothness);
            mat.SetFloat("_SmoothnessTextureChannel", 0f);
            if (mask != null) { mat.SetTexture("_MetallicGlossMap", mask); mat.EnableKeyword("_METALLICSPECGLOSSMAP"); }
            if (normal != null) { mat.SetTexture("_BumpMap", normal); mat.SetFloat("_BumpScale", m.normal_scale); mat.EnableKeyword("_NORMALMAP"); }
            if (emis != null || emisCol.maxColorComponent > 1e-4f)
            {
                mat.SetTexture("_EmissionMap", emis);
                mat.SetColor("_EmissionColor", emisCol);
                mat.EnableKeyword("_EMISSION");
                mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.BakedEmissive;
            }
            mat.SetFloat("_Cull", m.double_sided ? 0f : 2f);
            mat.SetFloat("_AlphaClip", cut ? 1f : 0f);
            mat.SetFloat("_Cutoff", m.cutoff);
            mat.SetFloat("_Surface", blend ? 1f : 0f);
            mat.SetFloat("_Blend", 0f);
            if (blend)
            {
                mat.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
                mat.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_SrcBlendAlpha", (float)BlendMode.One);
                mat.SetFloat("_DstBlendAlpha", (float)BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_ZWrite", 0f);
                mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                mat.SetOverrideTag("RenderType", "Transparent");
                mat.renderQueue = (int)RenderQueue.Transparent;
                mat.SetShaderPassEnabled("DepthOnly", false);
                mat.SetShaderPassEnabled("ShadowCaster", true);
            }
            else
            {
                mat.SetFloat("_SrcBlend", (float)BlendMode.One);
                mat.SetFloat("_DstBlend", (float)BlendMode.Zero);
                mat.SetFloat("_SrcBlendAlpha", (float)BlendMode.One);
                mat.SetFloat("_DstBlendAlpha", (float)BlendMode.Zero);
                mat.SetFloat("_ZWrite", 1f);
                mat.SetOverrideTag("RenderType", cut ? "TransparentCutout" : "Opaque");
                mat.renderQueue = cut ? (int)RenderQueue.AlphaTest : (int)RenderQueue.Geometry;
                if (cut) mat.EnableKeyword("_ALPHATEST_ON");
            }
            // let URP recompute its keywords from the properties when its editor API is there
            CallStatic("UnityEditor.BaseShaderGUI, Unity.RenderPipelines.Universal.Editor", "SetMaterialKeywords", mat);
        }

        static void SetupStandard(Material mat, AFMaterialData m, Texture2D baseMap, Texture2D normal, Texture2D mask,
                                  Texture2D emis, Color baseCol, Color emisCol)
        {
            bool cut = m.alpha == "cutout", blend = m.alpha == "blend";
            mat.SetTexture("_MainTex", baseMap);
            mat.SetColor("_Color", baseCol);
            mat.SetFloat("_Metallic", m.metallic);
            mat.SetFloat("_Glossiness", m.smoothness);
            if (mask != null) { mat.SetTexture("_MetallicGlossMap", mask); mat.SetFloat("_GlossMapScale", 1f); mat.EnableKeyword("_METALLICGLOSSMAP"); }
            if (normal != null) { mat.SetTexture("_BumpMap", normal); mat.SetFloat("_BumpScale", m.normal_scale); mat.EnableKeyword("_NORMALMAP"); }
            if (emis != null || emisCol.maxColorComponent > 1e-4f)
            {
                mat.SetTexture("_EmissionMap", emis);
                mat.SetColor("_EmissionColor", emisCol);
                mat.EnableKeyword("_EMISSION");
                mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.BakedEmissive;
            }
            mat.SetFloat("_Cutoff", m.cutoff);
            mat.SetFloat("_Mode", blend ? 3f : cut ? 1f : 0f);
            if (blend)
            {
                mat.SetOverrideTag("RenderType", "Transparent");
                mat.SetFloat("_SrcBlend", (float)BlendMode.One);
                mat.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_ZWrite", 0f);
                mat.EnableKeyword("_ALPHAPREMULTIPLY_ON");
                mat.renderQueue = (int)RenderQueue.Transparent;
            }
            else
            {
                mat.SetOverrideTag("RenderType", cut ? "TransparentCutout" : "");
                mat.SetFloat("_SrcBlend", (float)BlendMode.One);
                mat.SetFloat("_DstBlend", (float)BlendMode.Zero);
                mat.SetFloat("_ZWrite", 1f);
                if (cut) mat.EnableKeyword("_ALPHATEST_ON");
                mat.renderQueue = cut ? (int)RenderQueue.AlphaTest : -1;
            }
        }

        static void SetupHdrpLit(Material mat, AFMaterialData m, Texture2D baseMap, Texture2D normal, Texture2D mask,
                                 Texture2D emis, Color baseCol, Color emisCol)
        {
            mat.SetTexture("_BaseColorMap", baseMap);
            mat.SetColor("_BaseColor", baseCol);
            mat.SetFloat("_Metallic", m.metallic);
            mat.SetFloat("_Smoothness", m.smoothness);
            if (mask != null) { mat.SetTexture("_MaskMap", mask); mat.SetFloat("_Metallic", 1f); mat.SetFloat("_Smoothness", 1f); }
            if (normal != null) { mat.SetTexture("_NormalMap", normal); mat.SetFloat("_NormalScale", m.normal_scale); }
            if (emis != null) mat.SetTexture("_EmissiveColorMap", emis);
            mat.SetColor("_EmissiveColor", emisCol);
            mat.SetFloat("_AlphaCutoffEnable", m.alpha == "cutout" ? 1f : 0f);
            mat.SetFloat("_AlphaCutoff", m.cutoff);
            mat.SetFloat("_SurfaceType", m.alpha == "blend" ? 1f : 0f);
            mat.SetFloat("_DoubleSidedEnable", m.double_sided ? 1f : 0f);
            CallStatic("UnityEditor.Rendering.HighDefinition.HDShaderUtils, Unity.RenderPipelines.HighDefinition.Editor",
                       "ResetMaterialKeywords", mat);
        }

        // ------------------------------------------------------------------ particles

        public static Material BuildParticleMaterial(string path, Texture2D tex, bool additive, AFRenderPipeline p)
        {
            string shaderName = p == AFRenderPipeline.URP ? "Universal Render Pipeline/Particles/Unlit"
                : p == AFRenderPipeline.HDRP ? "HDRP/Unlit"
                : additive ? "Mobile/Particles/Additive" : "Mobile/Particles/Alpha Blended";
            var shader = Shader.Find(shaderName);
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader);
                AssetDatabase.CreateAsset(mat, path);
            }
            else mat.shader = shader;
            mat.shaderKeywords = new string[0];
            if (p == AFRenderPipeline.URP)
            {
                mat.SetTexture("_BaseMap", tex);
                mat.SetColor("_BaseColor", Color.white);
                mat.SetFloat("_Surface", 1f);
                mat.SetFloat("_Blend", additive ? 2f : 0f);
                mat.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
                mat.SetFloat("_DstBlend", additive ? (float)BlendMode.One : (float)BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_SrcBlendAlpha", (float)BlendMode.One);
                mat.SetFloat("_DstBlendAlpha", additive ? (float)BlendMode.One : (float)BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_ZWrite", 0f);
                mat.SetFloat("_Cull", 0f);
                mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                mat.SetOverrideTag("RenderType", "Transparent");
                mat.renderQueue = (int)RenderQueue.Transparent;
                CallStatic("UnityEditor.BaseShaderGUI, Unity.RenderPipelines.Universal.Editor", "SetMaterialKeywords", mat);
            }
            else if (p == AFRenderPipeline.HDRP)
            {
                mat.SetTexture("_UnlitColorMap", tex);
                mat.SetFloat("_SurfaceType", 1f);
                mat.SetFloat("_BlendMode", additive ? 1f : 0f);
                CallStatic("UnityEditor.Rendering.HighDefinition.HDShaderUtils, Unity.RenderPipelines.HighDefinition.Editor",
                           "ResetMaterialKeywords", mat);
            }
            else
            {
                mat.SetTexture("_MainTex", tex);
                mat.SetColor("_TintColor", new Color(0.5f, 0.5f, 0.5f, 0.5f));
            }
            EditorUtility.SetDirty(mat);
            return mat;
        }

        /// <summary>Best-effort call of a static (Material) method of a pipeline editor assembly.</summary>
        static void CallStatic(string typeName, string method, Material mat)
        {
            try
            {
                var t = Type.GetType(typeName);
                if (t == null) return;
                foreach (var mi in t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                {
                    if (mi.Name != method) continue;
                    var ps = mi.GetParameters();
                    if (ps.Length == 0 || ps[0].ParameterType != typeof(Material)) continue;
                    var args = new object[ps.Length];
                    args[0] = mat;
                    for (int i = 1; i < ps.Length; i++) args[i] = ps[i].HasDefaultValue ? ps[i].DefaultValue : null;
                    mi.Invoke(null, args);
                    return;
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning("AstraForge: " + typeName + "." + method + " failed: " + e.Message);
            }
        }
    }
}
