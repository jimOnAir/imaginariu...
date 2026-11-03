using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace AstraForge.Editor
{
    /// <summary>
    /// Batchmode entry points:
    ///   Unity -batchmode -projectPath P -executeMethod AstraForge.Editor.AFBatch.Validate
    ///         -afPackages "Assets/AstraForge/a;Assets/AstraForge/b" -afReport report.json -afShots shots_dir -quit
    /// builds every package, checks the prefabs and writes a JSON report plus a screenshot per asset.
    ///   ... -executeMethod AstraForge.Editor.AFBatch.BuildAll  (rebuild every package under Assets)
    /// </summary>
    public static class AFBatch
    {
        [Serializable] public class Check
        {
            public string name;
            public bool ok;
            public string value;
            public string limit;
            public string severity = "error";
        }

        [Serializable] public class AssetReport
        {
            public string asset_id, folder, pipeline, shot, sprite_shot;
            public bool ok;
            public List<Check> checks = new List<Check>();
        }

        [Serializable] public class Report
        {
            public bool ok;
            public string unity, pipeline, project;
            public List<AssetReport> assets = new List<AssetReport>();
            public List<string> console_errors = new List<string>();
            public string contact_sheet;
        }

        static string Arg(string name)
        {
            var a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }

        public static void BuildAll()
        {
            foreach (var f in FindPackages()) AFPrefabBuilder.Build(f, true);
        }

        public static IEnumerable<string> FindPackages()
        {
            return Directory.GetFiles("Assets", AFPackageData.FileName, SearchOption.AllDirectories)
                .Select(p => Path.GetDirectoryName(p).Replace('\\', '/'));
        }

        public static void Validate()
        {
            var errors = new List<string>();
            Application.LogCallback cb = (msg, stack, type) =>
            {
                if ((type == LogType.Error || type == LogType.Exception || type == LogType.Assert) && errors.Count < 50)
                    errors.Add(msg.Split('\n')[0]);
            };
            Application.logMessageReceived += cb;
            var report = new Report { unity = Application.unityVersion, pipeline = AFPipeline.Current.ToString(),
                                      project = Directory.GetCurrentDirectory() };
            var pkgsArg = Arg("-afPackages");
            var folders = string.IsNullOrEmpty(pkgsArg) ? FindPackages().ToList()
                : pkgsArg.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries).Select(s => s.Trim()).ToList();
            var shots = Arg("-afShots");
            var reportPath = Arg("-afReport") ?? "af_unity_report.json";
            if (!string.IsNullOrEmpty(shots)) Directory.CreateDirectory(shots);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            var shotFiles = new List<string>();
            foreach (var f in folders)
            {
                var ar = new AssetReport { folder = f, pipeline = report.pipeline };
                try
                {
                    var before = errors.Count;
                    AFPrefabBuilder.Build(f, true);
                    var pkg = AFPackageData.Load(f);
                    ar.asset_id = pkg.asset_id;
                    if (pkg.HasModel) CheckModel(pkg, ar);
                    if (pkg.HasSprites) CheckSprites(pkg, ar);
                    if (!string.IsNullOrEmpty(shots))
                    {
                        if (pkg.HasModel) { ar.shot = AFShots.Model(pkg, Path.Combine(shots, pkg.asset_id + ".png")); shotFiles.Add(ar.shot); }
                        if (pkg.HasSprites) { ar.sprite_shot = AFShots.Sprite(pkg, Path.Combine(shots, pkg.asset_id + "_sprite.png")); shotFiles.Add(ar.sprite_shot); }
                    }
                    var mine = errors.Skip(before).ToList();
                    Add(ar, "console_errors", mine.Count == 0, string.Join(" | ", mine.Take(5)), "0");
                }
                catch (Exception e)
                {
                    Add(ar, "build", false, e.GetType().Name + ": " + e.Message, "no exception");
                }
                ar.ok = ar.checks.All(c => c.ok || c.severity != "error");
                report.assets.Add(ar);
            }
            if (!string.IsNullOrEmpty(shots) && shotFiles.Count > 0)
                report.contact_sheet = AFShots.ContactSheet(shotFiles.Where(File.Exists).ToList(), Path.Combine(shots, "contact_sheet.png"));
            Application.logMessageReceived -= cb;
            report.console_errors = errors;
            report.ok = report.assets.Count > 0 && report.assets.All(a => a.ok);
            File.WriteAllText(reportPath, JsonUtility.ToJson(report, true));
            Debug.Log("AFUNITY " + JsonUtility.ToJson(report));
        }

        static void Add(AssetReport ar, string name, bool ok, object value, object limit, string severity = "error")
        {
            ar.checks.Add(new Check { name = name, ok = ok, value = value?.ToString(), limit = limit?.ToString(), severity = severity });
        }

        static string F(Vector3 v) => string.Format(System.Globalization.CultureInfo.InvariantCulture, "({0:0.###}, {1:0.###}, {2:0.###})", v.x, v.y, v.z);

        /// <summary>Bones back to the skin's bind pose (bindposes of the skinned meshes), parents first.</summary>
        public static void ToBindPose(GameObject root)
        {
            var target = new Dictionary<Transform, Matrix4x4>();
            foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            {
                if (smr.sharedMesh == null) continue;
                var bones = smr.bones;
                var bp = smr.sharedMesh.bindposes;
                var m = smr.transform.localToWorldMatrix;
                for (int i = 0; i < bones.Length && i < bp.Length; i++)
                    if (bones[i] != null && !target.ContainsKey(bones[i])) target[bones[i]] = m * bp[i].inverse;
            }
            int Depth(Transform t) { int d = 0; for (var p = t.parent; p != null; p = p.parent) d++; return d; }
            foreach (var kv in target.OrderBy(kv => Depth(kv.Key)))
            {
                kv.Key.position = kv.Value.GetColumn(3);
                kv.Key.rotation = kv.Value.rotation;
            }
        }

        /// <summary>Tight bounds of the rendered vertices in the root's space (skinned meshes baked in their pose).</summary>
        public static Bounds VertexBounds(GameObject root, bool lod0Only)
        {
            var lodSet = new HashSet<Renderer>();
            var lg = root.GetComponent<LODGroup>();
            if (lod0Only && lg != null)
            {
                var lods = lg.GetLODs();
                foreach (var l in lods.Skip(1)) foreach (var r in l.renderers) if (r) lodSet.Add(r);
                foreach (var r in lods[0].renderers) if (r) lodSet.Remove(r);
            }
            var b = new Bounds();
            bool any = false;
            void Enc(Vector3 p) { if (!any) { b = new Bounds(p, Vector3.zero); any = true; } else b.Encapsulate(p); }
            foreach (var mf in root.GetComponentsInChildren<MeshFilter>())
            {
                var r = mf.GetComponent<Renderer>();
                if (r == null || lodSet.Contains(r) || mf.sharedMesh == null) continue;
                var m = mf.transform.localToWorldMatrix;
                foreach (var v in mf.sharedMesh.vertices) Enc(m.MultiplyPoint3x4(v));
            }
            foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                if (lodSet.Contains(smr) || smr.sharedMesh == null) continue;
                var baked = new Mesh();
                smr.BakeMesh(baked, true);
                var m = smr.transform.localToWorldMatrix;
                // BakeMesh with useScale keeps the renderer's scale in the vertices: drop it from the matrix
                m = Matrix4x4.TRS(smr.transform.position, smr.transform.rotation, Vector3.one);
                foreach (var v in baked.vertices) Enc(m.MultiplyPoint3x4(v));
                UnityEngine.Object.DestroyImmediate(baked);
            }
            return b;
        }

        static void CheckModel(AFPackageData pkg, AssetReport ar)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(pkg.PrefabPath);
            Add(ar, "prefab_exists", prefab != null, pkg.PrefabPath, "exists");
            if (prefab == null) return;
            var p = AFPipeline.Current;
            var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                inst.transform.position = Vector3.zero;
                inst.transform.rotation = Quaternion.identity;
                ToBindPose(inst);                   // Blender measured the rest pose: compare in the skin's bind pose

                // materials: every slot filled with a shader the active pipeline draws
                var bad = new List<string>();
                int slots = 0;
                foreach (var r in inst.GetComponentsInChildren<Renderer>(true))
                    foreach (var m in r.sharedMaterials)
                    {
                        slots++;
                        if (m == null) bad.Add(r.name + ": empty slot");
                        else if (!AFPipeline.ShaderFits(m.shader, p)) bad.Add(r.name + ": " + m.name + " / " + (m.shader ? m.shader.name : "null"));
                    }
                Add(ar, "materials_no_pink", bad.Count == 0, bad.Count == 0 ? slots + " slots ok" : string.Join("; ", bad.Take(6)), "shader of " + p);
                var expectedMats = pkg.materials.Select(m => AFPrefabBuilder.Safe(m.name)).ToList();     // asset name = file name
                var usedMats = inst.GetComponentsInChildren<Renderer>(true).Where(r => !(r is ParticleSystemRenderer))
                    .SelectMany(r => r.sharedMaterials).Where(m => m != null).Select(m => m.name).Distinct().ToList();
                var missing = expectedMats.Where(n => !usedMats.Contains(n)).ToList();
                Add(ar, "materials_remapped", missing.Count == 0, missing.Count == 0 ? string.Join(", ", usedMats) : "not used: " + string.Join(", ", missing), "package materials on the model");

                // size and placement against the Blender/glTF measure (axis by axis: catches turned or mirrored models)
                var vb = VertexBounds(inst, true);
                var want = AFPackageData.V3(pkg.size_m);
                var tol = Mathf.Max(0.01f * Mathf.Max(want.x, Mathf.Max(want.y, want.z)), 0.002f);
                bool sizeOk = Mathf.Abs(vb.size.x - want.x) <= tol && Mathf.Abs(vb.size.y - want.y) <= tol && Mathf.Abs(vb.size.z - want.z) <= tol;
                Add(ar, "size_matches_godot", sizeOk, "unity " + F(vb.size) + " vs package " + F(want), "<= 1 %");
                var wmin = AFPackageData.V3(pkg.bounds_min);
                var wmax = AFPackageData.V3(pkg.bounds_max);
                bool placeOk = (vb.min - wmin).magnitude <= 2 * tol && (vb.max - wmax).magnitude <= 2 * tol;
                Add(ar, "placement_axes", placeOk, "min " + F(vb.min) + " max " + F(vb.max) + " vs " + F(wmin) + " " + F(wmax), "same corners (axes, 180 deg turn)");

                // rig and clips
                var animator = inst.GetComponentInChildren<Animator>();
                if (pkg.rig != "none")
                {
                    var av = animator != null ? animator.avatar : null;
                    bool avOk = av != null && av.isValid && (pkg.rig != "humanoid" || av.isHuman);
                    Add(ar, "avatar_" + pkg.rig, avOk, av == null ? "no avatar" : "valid=" + av.isValid + " human=" + av.isHuman, pkg.rig);
                }
                if (pkg.clips.Length > 0)
                {
                    var clips = AssetDatabase.LoadAllAssetsAtPath(pkg.ModelPath).OfType<AnimationClip>().Where(c => !c.name.StartsWith("__preview__")).ToList();
                    var wrong = new List<string>();
                    foreach (var c in pkg.clips)
                    {
                        var u = clips.FirstOrDefault(x => x.name == c.name);
                        if (u == null) wrong.Add(c.name + " missing");
                        else if (u.isLooping != c.loop) wrong.Add(c.name + " loop=" + u.isLooping);
                    }
                    Add(ar, "clips_and_loops", wrong.Count == 0, wrong.Count == 0 ? string.Join(", ", clips.Select(c => c.name + (c.isLooping ? "(loop)" : "") + " " + c.length.ToString("0.00") + "s")) : string.Join("; ", wrong), pkg.clips.Length + " clips");
                    bool ctrlOk = animator != null && animator.runtimeAnimatorController != null
                                  && animator.runtimeAnimatorController.animationClips.Length >= pkg.clips.Length;
                    Add(ar, "animator_controller", ctrlOk, animator?.runtimeAnimatorController?.name, "all clips as states");
                    var moved = AnimationMoves(animator, clips.FirstOrDefault(c => c.name == pkg.default_clip) ?? clips.FirstOrDefault());
                    Add(ar, "animation_plays", moved > 0.001f, moved.ToString("0.0000") + " m max bone travel", "> 0.001 m");
                }

                // sockets (rest pose) and effects
                var sk = inst.GetComponent<AFSockets>();
                if (pkg.sockets.Length > 0)
                {
                    var off = new List<string>();
                    foreach (var s in pkg.sockets)
                    {
                        var t = sk != null ? sk.Get(s.name) : null;
                        if (t == null) { off.Add(s.name + " missing"); continue; }
                        var d = (t.position - AFPackageData.V3(s.position)).magnitude;
                        if (d > Mathf.Max(0.02f, 2 * tol)) off.Add(s.name + " off by " + d.ToString("0.000") + " m: " + F(t.position) + " vs " + F(AFPackageData.V3(s.position)));
                    }
                    Add(ar, "sockets_found", off.Count == 0, off.Count == 0 ? pkg.sockets.Length + " sockets in place" : string.Join("; ", off), "position within 2 cm");
                }
                if (pkg.fx.Length > 0)
                {
                    var mount = inst.GetComponent<AFFxMount>();
                    var fxBad = new List<string>();
                    foreach (var b in pkg.fx)
                    {
                        var bind = mount != null ? mount.bindings.FirstOrDefault(x => x.socket == b.socket && x.fx != null && x.fx.name == b.node_name) : default;
                        if (bind.fx == null) { fxBad.Add(b.node_name + " missing"); continue; }
                        var upDot = Vector3.Dot(bind.fx.transform.up, AFPackageData.V3(b.up).normalized);
                        if (upDot < 0.99f) fxBad.Add(b.node_name + " up dot " + upDot.ToString("0.00"));
                        var pr = bind.fx.GetComponent<ParticleSystemRenderer>();
                        if (pr == null || !AFPipeline.ShaderFits(pr.sharedMaterial ? pr.sharedMaterial.shader : null, p)) fxBad.Add(b.node_name + " material");
                    }
                    Add(ar, "fx_attached", fxBad.Count == 0, fxBad.Count == 0 ? string.Join(", ", pkg.fx.Select(b => b.preset + "@" + b.socket)) : string.Join("; ", fxBad), "Particle System on socket, +Y = emit axis");
                }

                // collider and LOD
                var col = pkg.collider?.type ?? "none";
                if (col != "none")
                {
                    bool hasCol = col == "box" ? inst.GetComponent<BoxCollider>() != null
                        : col == "capsule" ? inst.GetComponent<CapsuleCollider>() != null
                        : inst.GetComponentsInChildren<MeshCollider>().Length > 0;
                    Add(ar, "collider", hasCol, col, col);
                }
                if (pkg.lod.levels.Length > 1)
                {
                    var lg = inst.GetComponent<LODGroup>();
                    var lods = lg != null ? lg.GetLODs() : new LOD[0];
                    var tris = lods.Select(l => l.renderers.Where(r => r).Sum(r => Tris(r))).ToArray();
                    bool lodOk = lods.Length == pkg.lod.levels.Length && lods.All(l => l.renderers.Length > 0)
                                 && tris.Zip(tris.Skip(1), (a, b2) => b2 < a).All(x => x);
                    Add(ar, "lod_group", lodOk, lods.Length + " levels, tris " + string.Join("/", tris), "decreasing triangles");
                }
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(inst);
            }
        }

        static int Tris(Renderer r)
        {
            Mesh m = r is SkinnedMeshRenderer s ? s.sharedMesh : r.GetComponent<MeshFilter>()?.sharedMesh;
            if (m == null) return 0;
            int n = 0;
            for (int i = 0; i < m.subMeshCount; i++) n += (int)m.GetIndexCount(i) / 3;
            return n;
        }

        /// <summary>Largest bone displacement between two times of a clip (AnimationMode: Generic and Humanoid in the editor).</summary>
        public static float AnimationMoves(Animator animator, AnimationClip clip)
        {
            if (animator == null || clip == null) return 0f;
            var bones = animator.GetComponentsInChildren<Transform>();
            var a = SamplePositions(animator.gameObject, clip, 0f, bones);
            var b2 = SamplePositions(animator.gameObject, clip, clip.length * 0.5f, bones);
            float best = 0f;
            for (int i = 0; i < a.Length; i++) best = Mathf.Max(best, (a[i] - b2[i]).magnitude);
            return best;
        }

        static Vector3[] SamplePositions(GameObject go, AnimationClip clip, float t, Transform[] bones)
        {
            AnimationMode.StartAnimationMode();
            try
            {
                AnimationMode.BeginSampling();
                AnimationMode.SampleAnimationClip(go, clip, t);
                AnimationMode.EndSampling();
                return bones.Select(b => b.position).ToArray();
            }
            finally { AnimationMode.StopAnimationMode(); }
        }

        static void CheckSprites(AFPackageData pkg, AssetReport ar)
        {
            var sp = pkg.sprites;
            var sprites = AFSpriteBuilder.LoadSprites(pkg);
            int want = sp.clips.Sum(c => c.views.Sum(v => v.rects.Length));
            Add(ar, "sprites_sliced", sprites.Count == want, sprites.Count + " sprites", want.ToString());
            var ppuBad = sprites.Values.Where(s => Mathf.Abs(s.pixelsPerUnit - sp.ppu) > 0.01f).Select(s => s.name).Take(3).ToList();
            Add(ar, "sprites_ppu", ppuBad.Count == 0, sp.ppu + " px/unit (1 m = 1 unit)", sp.ppu.ToString());
            if (sp.pixel)
            {
                var tex = sprites.Values.Select(s => s.texture).Distinct().ToList();
                Add(ar, "sprites_point_filter", tex.All(t => t.filterMode == FilterMode.Point), string.Join(", ", tex.Select(t => t.filterMode)), "Point");
            }
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(pkg.SpritePrefabPath);
            Add(ar, "sprite_prefab", prefab != null && prefab.GetComponent<SpriteRenderer>()?.sprite != null, pkg.SpritePrefabPath, "SpriteRenderer with a sprite");
            var anim = prefab != null ? prefab.GetComponent<Animator>() : null;
            if (anim != null)
            {
                var ctrl = anim.runtimeAnimatorController as UnityEditor.Animations.AnimatorController;
                var states = ctrl != null ? ctrl.layers[0].stateMachine.states.Select(s => s.state.name).ToList() : new List<string>();
                var missing = sp.clips.Select(c => c.name).Where(n => !states.Contains(n)).ToList();
                Add(ar, "sprite_animator", missing.Count == 0 && ctrl.parameters.Any(x => x.name == "DirX"),
                    string.Join(", ", states), "state per clip, DirX/DirY");
                var frames = new List<string>();
                foreach (var c in sp.clips)
                    foreach (var v in c.views)
                    {
                        var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(pkg.folder + "/sprites/anim/" + c.name + "_" + v.dir + ".anim");
                        var keys = clip != null ? AnimationUtility.GetObjectReferenceCurve(clip, EditorCurveBinding.PPtrCurve("", typeof(SpriteRenderer), "m_Sprite")) : null;
                        if (keys == null || keys.Length != v.rects.Length + 1 || clip.isLooping != c.loop) frames.Add(c.name + "_" + v.dir);
                    }
                Add(ar, "sprite_clips_frames", frames.Count == 0, frames.Count == 0 ? "all clips match the sheets" : "wrong: " + string.Join(", ", frames.Take(6)), "frames + loop as in sprites.json");
            }
        }
    }
}
