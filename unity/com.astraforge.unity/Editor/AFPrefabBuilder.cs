using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace AstraForge.Editor
{
    /// <summary>
    /// Builds &lt;id&gt;.prefab from an AstraForge package folder: model (nested FBX prefab, turned to look along +Z),
    /// pipeline materials, Animator Controller with every clip, sockets, Particle System effects on sockets,
    /// collider, LODGroup; and &lt;id&gt;_sprite.prefab from sprite sheets. Idempotent: a stamp of the package
    /// files skips a rebuild when nothing changed (force = true always rebuilds).
    /// </summary>
    public static class AFPrefabBuilder
    {
        public static bool Building { get; private set; }
        const string StampFile = ".af_build_stamp";      // dot files are invisible to the AssetDatabase

        public static string Stamp(AFPackageData pkg)
        {
            using (var md5 = MD5.Create())
            {
                var sb = new StringBuilder(pkg.json).Append("|importer:").Append(typeof(AFPrefabBuilder).Assembly.GetName().Version);
                foreach (var f in Directory.GetFiles(pkg.folder, "*", SearchOption.AllDirectories)
                             .Where(f => f.EndsWith(".fbx") || f.EndsWith(".png")).OrderBy(f => f))
                    sb.Append('|').Append(f.Replace('\\', '/')).Append(':').Append(new FileInfo(f).Length);
                return BitConverter.ToString(md5.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()))).Replace("-", "").ToLowerInvariant();
            }
        }

        public static Transform FindDeep(Transform t, string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            if (t.name == name) return t;
            foreach (Transform c in t)
            {
                var r = FindDeep(c, name);
                if (r != null) return r;
            }
            return null;
        }

        public static string Safe(string s)
        {
            var b = new StringBuilder();
            foreach (var ch in s) b.Append(char.IsLetterOrDigit(ch) || ch == '_' || ch == '-' ? ch : '_');
            return b.Length > 0 ? b.ToString() : "material";
        }

        /// <summary>Returns true when something was built.</summary>
        public static bool Build(string folder, bool force)
        {
            var pkg = AFPackageData.Load(folder);
            if (pkg == null) throw new Exception("not an AstraForge package (no valid af_unity.json): " + folder);
            var stamp = Stamp(pkg);
            var stampPath = Path.Combine(folder, StampFile);
            if (!force && File.Exists(stampPath) && File.ReadAllText(stampPath) == stamp
                && (!pkg.HasModel || File.Exists(pkg.PrefabPath)) && (!pkg.HasSprites || File.Exists(pkg.SpritePrefabPath)))
                return false;
            Building = true;
            try
            {
                if (pkg.HasModel) BuildModel(pkg, stamp);
                if (pkg.HasSprites) AFSpriteBuilder.Build(pkg);
                AssetDatabase.SaveAssets();
                File.WriteAllText(stampPath, stamp);
                Debug.Log("AstraForge: built " + pkg.asset_id + " (" + AFPipeline.Current + ")");
                return true;
            }
            finally { Building = false; }
        }

        static void BuildModel(AFPackageData pkg, string stamp)
        {
            var pipeline = AFPipeline.Current;
            var folder = pkg.folder;
            AssetDatabase.ImportAsset(pkg.ModelPath, ImportAssetOptions.ForceSynchronousImport);

            // materials of the active pipeline, remapped onto the FBX's own material slots
            Directory.CreateDirectory(folder + "/Materials");
            var mats = new Dictionary<string, Material>();
            foreach (var m in pkg.materials)
                mats[m.name] = AFPipeline.BuildMaterial(pkg, m, folder + "/Materials/" + Safe(m.name) + ".mat", pipeline);
            AssetDatabase.SaveAssets();
            var mi = AssetImporter.GetAtPath(pkg.ModelPath) as ModelImporter;
            if (mi == null) throw new Exception("model is not imported: " + pkg.ModelPath);
            var map = mi.GetExternalObjectMap();
            bool remapped = false;
            foreach (var kv in mats)
            {
                var id = new AssetImporter.SourceAssetIdentifier(typeof(Material), kv.Key);
                if (!map.TryGetValue(id, out var cur) || cur != kv.Value)
                {
                    mi.AddRemap(id, kv.Value);
                    remapped = true;
                }
            }
            if (remapped) mi.SaveAndReimport();

            var modelAsset = AssetDatabase.LoadAssetAtPath<GameObject>(pkg.ModelPath);
            var clips = AssetDatabase.LoadAllAssetsAtPath(pkg.ModelPath).OfType<AnimationClip>()
                .Where(c => !c.name.StartsWith("__preview__")).ToList();

            AnimatorController ctrl = null;
            if (clips.Count > 0)
            {
                var ctrlPath = folder + "/" + pkg.asset_id + "_Animator.controller";
                ctrl = ResetController(ctrlPath);
                var sm = ctrl.layers[0].stateMachine;
                foreach (var c in clips)
                {
                    var st = sm.AddState(c.name);
                    st.motion = c;
                    if (c.name == pkg.default_clip) sm.defaultState = st;
                }
            }

            var fxPrefabs = new Dictionary<string, GameObject>();
            foreach (var f in pkg.fx_presets) fxPrefabs[f.id] = AFFxBuilder.BuildPrefab(pkg, f, pipeline);

            var root = new GameObject(pkg.asset_id);
            try
            {
                var model = (GameObject)PrefabUtility.InstantiatePrefab(modelAsset);
                model.name = "model";
                model.transform.SetParent(root.transform, false);
                model.transform.localRotation = Quaternion.Euler(0f, pkg.model_rotation_y, 0f);

                var info = root.AddComponent<AFAssetInfo>();
                info.assetId = pkg.asset_id;
                info.kind = pkg.kind;
                info.rig = pkg.rig;
                info.sizeMeters = AFPackageData.V3(pkg.size_m);
                info.stamp = stamp;

                if (ctrl != null)
                {
                    var animator = model.GetComponent<Animator>() ?? model.AddComponent<Animator>();
                    animator.runtimeAnimatorController = ctrl;
                    animator.applyRootMotion = false;
                    var anims = root.AddComponent<AFAnimations>();
                    anims.animator = animator;
                    anims.defaultClip = pkg.default_clip;
                    anims.clips = clips.Select(c => c.name).ToList();
                }

                AFSockets sockets = null;
                if (pkg.sockets.Length > 0)
                {
                    sockets = root.AddComponent<AFSockets>();
                    foreach (var s in pkg.sockets)
                    {
                        var t = FindDeep(model.transform, s.node) ?? FindDeep(model.transform, s.name);
                        if (t == null) Debug.LogWarning("AstraForge: socket " + s.name + " not found in " + pkg.model);
                        sockets.sockets.Add(new AFSockets.Entry { name = s.name, transform = t });
                    }
                }

                if (pkg.fx.Length > 0)
                {
                    var mount = root.AddComponent<AFFxMount>();
                    foreach (var b in pkg.fx)
                    {
                        var t = sockets != null ? sockets.Get(b.socket) : null;
                        if (t == null || !fxPrefabs.TryGetValue(b.fx, out var fxPrefab)) continue;
                        var inst = (GameObject)PrefabUtility.InstantiatePrefab(fxPrefab);
                        inst.name = b.node_name;
                        inst.transform.SetParent(t, false);
                        inst.transform.localPosition = Vector3.zero;
                        inst.transform.rotation = Quaternion.LookRotation(AFPackageData.V3(b.forward, Vector3.forward),
                                                                          AFPackageData.V3(b.up, Vector3.up));
                        mount.bindings.Add(new AFFxMount.Binding
                        {
                            socket = b.socket, preset = b.preset, oneShot = b.one_shot,
                            fx = inst.GetComponent<ParticleSystem>(),
                        });
                    }
                }

                AddCollider(root, model, pkg.collider);

                if (pkg.lod != null && pkg.lod.levels.Length > 1)
                {
                    var lods = pkg.lod.levels.Select(l => new LOD(l.screen, l.renderers
                        .Select(n => FindDeep(model.transform, n)).Where(t => t != null)
                        .Select(t => t.GetComponent<Renderer>()).Where(r => r != null).ToArray())).ToArray();
                    var lg = root.AddComponent<LODGroup>();
                    lg.SetLODs(lods);
                    lg.RecalculateBounds();
                }

                PrefabUtility.SaveAsPrefabAsset(root, pkg.PrefabPath);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(root);
            }
        }

        /// <summary>The controller at path emptied for a rebuild (same asset and GUID: references in scenes survive).</summary>
        public static AnimatorController ResetController(string path)
        {
            var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
            if (ctrl == null) return AnimatorController.CreateAnimatorControllerAtPath(path);
            var sm = ctrl.layers[0].stateMachine;
            foreach (var st in sm.states.ToArray()) sm.RemoveState(st.state);
            foreach (var prm in ctrl.parameters.ToArray()) ctrl.RemoveParameter(prm);
            foreach (var sub in AssetDatabase.LoadAllAssetsAtPath(path).OfType<BlendTree>().ToArray())
                AssetDatabase.RemoveObjectFromAsset(sub);
            return ctrl;
        }

        static void AddCollider(GameObject root, GameObject model, AFColliderData c)
        {
            if (c == null) return;
            switch (c.type)
            {
                case "box":
                    var b = root.AddComponent<BoxCollider>();
                    b.center = AFPackageData.V3(c.center);
                    b.size = AFPackageData.V3(c.size);
                    break;
                case "capsule":
                    var k = root.AddComponent<CapsuleCollider>();
                    k.center = AFPackageData.V3(c.center);
                    k.radius = c.radius;
                    k.height = c.height;
                    k.direction = Mathf.Clamp(c.direction, 0, 2);
                    break;
                case "mesh":
                case "convex":
                    foreach (var n in c.nodes)
                    {
                        var t = FindDeep(model.transform, n);
                        var mf = t != null ? t.GetComponent<MeshFilter>() : null;
                        if (mf == null) continue;
                        var mc = t.gameObject.AddComponent<MeshCollider>();
                        mc.sharedMesh = mf.sharedMesh;
                        mc.convex = c.type == "convex";
                    }
                    break;
                case "ucx":
                    // Unity's FBX collision convention: UCX_<mesh>_## is collision geometry and
                    // never renders. When the import settings did not consume the hulls, enforce
                    // both halves of that rule by hand: renderer off, convex MeshCollider on.
                    foreach (var h in c.hulls)
                    {
                        var ht = FindDeep(model.transform, h.ucx);
                        var hmf = ht != null ? ht.GetComponent<MeshFilter>() : null;
                        if (hmf == null) continue;                      // consumed as collision by the importer
                        var hr = ht.GetComponent<MeshRenderer>();
                        if (hr != null) hr.enabled = false;             // a hull is never seen
                        if (ht.GetComponent<MeshCollider>() == null)
                        {
                            var hmc = ht.gameObject.AddComponent<MeshCollider>();
                            hmc.sharedMesh = hmf.sharedMesh;
                            hmc.convex = true;
                        }
                    }
                    break;
            }
        }
    }
}
