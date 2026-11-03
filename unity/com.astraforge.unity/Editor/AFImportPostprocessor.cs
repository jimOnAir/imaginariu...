using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AstraForge.Editor
{
    /// <summary>
    /// Import settings for files inside an AstraForge package folder (a folder with af_unity.json) and the
    /// automatic prefab build after they land in the project.
    /// </summary>
    public class AFImportPostprocessor : AssetPostprocessor
    {
        public override uint GetVersion() => 3;

        void OnPreprocessModel()
        {
            var pkg = AFPackageData.ForAsset(assetPath);
            if (pkg == null || !pkg.HasModel || Path.GetFileName(assetPath) != pkg.model) return;
            var mi = (ModelImporter)assetImporter;
            mi.globalScale = 1f;
            mi.useFileScale = true;
            mi.bakeAxisConversion = true;               // Blender FBX: no -90 deg X on the root, metres
            mi.importCameras = false;
            mi.importLights = false;
            mi.importVisibility = true;
            mi.importBlendShapes = true;
            mi.meshCompression = ModelImporterMeshCompression.Off;
            mi.importNormals = ModelImporterNormals.Import;
            mi.importTangents = ModelImporterTangents.CalculateMikk;
            mi.sortHierarchyByName = false;
            mi.isReadable = pkg.collider != null && (pkg.collider.type == "mesh" || pkg.collider.type == "convex");
            mi.materialImportMode = ModelImporterMaterialImportMode.ImportViaMaterialDescription;
            mi.materialLocation = ModelImporterMaterialLocation.InPrefab;
            switch (pkg.rig)
            {
                case "humanoid":
                    mi.animationType = ModelImporterAnimationType.Human;
                    mi.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
                    break;
                case "generic":
                    mi.animationType = ModelImporterAnimationType.Generic;
                    mi.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
                    break;
                default:
                    mi.animationType = pkg.clips.Length > 0 ? ModelImporterAnimationType.Generic : ModelImporterAnimationType.None;
                    break;
            }
            mi.importAnimation = pkg.clips.Length > 0;
            mi.resampleCurves = true;
            mi.animationCompression = ModelImporterAnimationCompression.KeyframeReduction;
        }

        void OnPreprocessAnimation()
        {
            var pkg = AFPackageData.ForAsset(assetPath);
            if (pkg == null || !pkg.HasModel || Path.GetFileName(assetPath) != pkg.model || pkg.clips.Length == 0) return;
            var mi = (ModelImporter)assetImporter;
            var defaults = mi.defaultClipAnimations;
            var outClips = new List<ModelImporterClipAnimation>();
            foreach (var d in defaults)
            {
                var c = Match(pkg, d.takeName);
                if (c == null) continue;
                d.name = c.name;
                d.loopTime = c.loop;
                d.loopPose = false;
                if (pkg.rig == "humanoid")
                {
                    d.lockRootRotation = true;           // bake into pose: in-place clips stay in place
                    d.lockRootHeightY = true;
                    d.lockRootPositionXZ = c.loop;
                    d.keepOriginalOrientation = true;
                    d.keepOriginalPositionY = true;
                    d.keepOriginalPositionXZ = true;
                }
                outClips.Add(d);
            }
            mi.clipAnimations = (outClips.Count > 0 ? outClips : defaults.ToList()).ToArray();
        }

        /// <summary>FBX take "Armature|idle-loop" (Blender) -> package clip with take "idle-loop".</summary>
        public static AFClipData Match(AFPackageData pkg, string takeName)
        {
            if (string.IsNullOrEmpty(takeName)) return null;
            var tail = takeName.Contains("|") ? takeName.Substring(takeName.LastIndexOf('|') + 1) : takeName;
            return pkg.clips.FirstOrDefault(c => c.take == takeName || c.take == tail)
                ?? pkg.clips.FirstOrDefault(c => c.name == tail);
        }

        void OnPreprocessTexture()
        {
            var folder = AFPackageData.FolderOf(assetPath);
            if (folder == null) return;
            var rel = assetPath.Substring(folder.Length + 1);
            var ti = (TextureImporter)assetImporter;
            if (rel.StartsWith("textures/"))
            {
                ti.textureType = rel.EndsWith("_normal.png") ? TextureImporterType.NormalMap : TextureImporterType.Default;
                ti.sRGBTexture = !rel.EndsWith("_mask.png") && !rel.EndsWith("_normal.png");
                ti.mipmapEnabled = true;
                ti.maxTextureSize = 4096;
                ti.alphaIsTransparency = ti.sRGBTexture;
            }
            else if (rel.StartsWith("fx/textures/"))
            {
                ti.textureType = TextureImporterType.Default;
                ti.alphaIsTransparency = true;
                ti.wrapMode = TextureWrapMode.Clamp;
                ti.mipmapEnabled = true;
            }
            else if (rel.StartsWith("sprites/"))
            {
                var pkg = AFPackageData.Load(folder);
                if (pkg == null || !pkg.HasSprites) return;
                SetupSpriteSheet(ti, pkg, rel);
            }
        }

#pragma warning disable 618   // TextureImporter.spritesheet: no dependency on the 2D Sprite package
        static void SetupSpriteSheet(TextureImporter ti, AFPackageData pkg, string rel)
        {
            var sp = pkg.sprites;
            ti.textureType = TextureImporterType.Sprite;
            ti.spriteImportMode = SpriteImportMode.Multiple;
            ti.spritePixelsPerUnit = sp.ppu;
            ti.mipmapEnabled = false;
            ti.alphaIsTransparency = true;
            ti.wrapMode = TextureWrapMode.Clamp;
            ti.filterMode = sp.pixel ? FilterMode.Point : FilterMode.Bilinear;
            ti.textureCompression = sp.pixel ? TextureImporterCompression.Uncompressed : TextureImporterCompression.Compressed;
            ti.maxTextureSize = 16384;
            int texH = PngHeight(Path.Combine(Directory.GetCurrentDirectory(), pkg.folder, rel));
            var metas = new List<SpriteMetaData>();
            foreach (var c in sp.clips)
                foreach (var v in c.views)
                {
                    if (v.sheet != rel) continue;
                    for (int i = 0; i < v.rects.Length; i++)
                    {
                        var r = v.rects[i];
                        metas.Add(new SpriteMetaData
                        {
                            name = AFSpriteBuilder.FrameName(c.name, v.dir, i),
                            rect = new Rect(r.x, texH - r.y - r.h, r.w, r.h),
                            alignment = (int)SpriteAlignment.Custom,
                            pivot = new Vector2(sp.anchor_x / Mathf.Max(1, r.w), 1f - sp.anchor_y / Mathf.Max(1, r.h)),
                        });
                    }
                }
            ti.spritesheet = metas.ToArray();
        }
#pragma warning restore 618

        static int PngHeight(string path)
        {
            using (var fs = File.OpenRead(path))
            {
                var b = new byte[24];
                fs.Read(b, 0, 24);
                return (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
            }
        }

        // ------------------------------------------------------------------ auto build

        static readonly HashSet<string> Pending = new HashSet<string>();

        static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            if (AFPrefabBuilder.Building) return;
            foreach (var path in imported.Concat(moved))
            {
                // only the package's own files trigger a build, never what the build writes (.prefab, .mat, .anim)
                if (path.Contains("/_Shaders/") || !(path.EndsWith(AFPackageData.FileName) || path.EndsWith(".fbx")
                                                     || path.EndsWith(".png"))) continue;
                var folder = AFPackageData.FolderOf(path);
                if (folder != null) Pending.Add(folder);
            }
            if (Pending.Count == 0 || Application.isBatchMode) return;   // batchmode: AFBatch builds explicitly
            EditorApplication.delayCall -= BuildPending;
            EditorApplication.delayCall += BuildPending;
        }

        static void BuildPending()
        {
            var folders = Pending.ToArray();
            Pending.Clear();
            foreach (var f in folders)
            {
                try { AFPrefabBuilder.Build(f, false); }
                catch (System.Exception e) { Debug.LogError("AstraForge: build of " + f + " failed: " + e); }
            }
        }
    }
}
