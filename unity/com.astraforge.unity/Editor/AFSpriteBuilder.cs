using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace AstraForge.Editor
{
    /// <summary>
    /// render_sprites sheets (iso8 / pixel / custom) as Unity sprites: the texture importer slices the sheets
    /// (AFImportPostprocessor), this builder makes one AnimationClip per clip and direction, an AnimatorController
    /// with a 2D directional blend tree per clip and the prefab &lt;id&gt;_sprite.prefab. 1 metre = 1 unit
    /// (Pixels Per Unit = px_per_meter of the render), pivot = the anchor (ground point under the model).
    /// </summary>
    public static class AFSpriteBuilder
    {
        public static string FrameName(string clip, string dir, int i) => clip + "_" + dir + "_" + i;

        public static Dictionary<string, Sprite> LoadSprites(AFPackageData pkg)
        {
            var d = new Dictionary<string, Sprite>();
            foreach (var sheet in pkg.sprites.sheets)
                foreach (var o in AssetDatabase.LoadAllAssetsAtPath(pkg.folder + "/" + sheet))
                    if (o is Sprite s) d[s.name] = s;
            return d;
        }

        public static GameObject Build(AFPackageData pkg)
        {
            var sp = pkg.sprites;
            var sprites = LoadSprites(pkg);
            var animDir = pkg.folder + "/sprites/anim";
            Directory.CreateDirectory(animDir);
            var clipsByName = new Dictionary<string, Dictionary<string, AnimationClip>>();
            Sprite first = null;
            bool animated = sp.clips.Any(c => c.views.Length > 1 || c.views.Any(v => v.rects.Length > 1)) || sp.clips.Length > 1;
            foreach (var c in sp.clips)
            {
                var perDir = new Dictionary<string, AnimationClip>();
                foreach (var v in c.views)
                {
                    var frames = new List<Sprite>();
                    for (int i = 0; i < v.rects.Length; i++)
                        if (sprites.TryGetValue(FrameName(c.name, v.dir, i), out var s)) frames.Add(s);
                    if (frames.Count == 0) continue;
                    if (first == null || (v.dir == "S" && first.name.Contains("_S_") == false)) first = frames[0];
                    if (!animated) continue;
                    var path = animDir + "/" + c.name + "_" + v.dir + ".anim";
                    var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(path);
                    if (clip == null)
                    {
                        clip = new AnimationClip();
                        AssetDatabase.CreateAsset(clip, path);
                    }
                    clip.ClearCurves();
                    clip.frameRate = Mathf.Max(1f, c.fps);
                    var keys = new ObjectReferenceKeyframe[frames.Count + 1];
                    for (int i = 0; i < frames.Count; i++) keys[i] = new ObjectReferenceKeyframe { time = i / clip.frameRate, value = frames[i] };
                    keys[frames.Count] = new ObjectReferenceKeyframe { time = frames.Count / clip.frameRate, value = frames[frames.Count - 1] };
                    var binding = EditorCurveBinding.PPtrCurve("", typeof(SpriteRenderer), "m_Sprite");
                    AnimationUtility.SetObjectReferenceCurve(clip, binding, keys);
                    var settings = AnimationUtility.GetAnimationClipSettings(clip);
                    settings.loopTime = c.loop;
                    settings.stopTime = frames.Count / clip.frameRate;
                    AnimationUtility.SetAnimationClipSettings(clip, settings);
                    EditorUtility.SetDirty(clip);
                    perDir[v.dir] = clip;
                }
                clipsByName[c.name] = perDir;
            }

            var go = new GameObject(pkg.asset_id + "_sprite");
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = first;
            var dirComp = go.AddComponent<AFSprite8Dir>();
            dirComp.clips = sp.clips.Select(c => c.name).ToList();
            dirComp.defaultClip = sp.clips.Select(c => c.name).FirstOrDefault(n => n.StartsWith("idle")) ?? dirComp.clips.FirstOrDefault();
            if (animated)
            {
                var ctrlPath = pkg.folder + "/sprites/" + pkg.asset_id + "_sprite.controller";
                var ctrl = AFPrefabBuilder.ResetController(ctrlPath);
                ctrl.AddParameter("DirX", AnimatorControllerParameterType.Float);
                ctrl.AddParameter("DirY", AnimatorControllerParameterType.Float);
                var sm = ctrl.layers[0].stateMachine;
                foreach (var c in sp.clips)
                {
                    if (!clipsByName.TryGetValue(c.name, out var perDir) || perDir.Count == 0) continue;
                    AnimatorState state;
                    if (perDir.Count == 1)
                    {
                        state = sm.AddState(c.name);
                        state.motion = perDir.Values.First();
                    }
                    else
                    {
                        state = ctrl.CreateBlendTreeInController(c.name, out var tree, 0);
                        tree.blendType = BlendTreeType.SimpleDirectional2D;
                        tree.blendParameter = "DirX";
                        tree.blendParameterY = "DirY";
                        foreach (var kv in perDir) tree.AddChild(kv.Value, AFSprite8Dir.ToVector(kv.Key));
                    }
                    if (c.name == dirComp.defaultClip) sm.defaultState = state;
                }
                var anim = go.AddComponent<Animator>();
                anim.runtimeAnimatorController = ctrl;
                dirComp.animator = anim;
            }
            var prefab = PrefabUtility.SaveAsPrefabAsset(go, pkg.SpritePrefabPath);
            Object.DestroyImmediate(go);
            return prefab;
        }
    }
}
