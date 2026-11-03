using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace AstraForge.Editor
{
    /// <summary>Screenshots of built prefabs through the active pipeline (batchmode with graphics).</summary>
    public static class AFShots
    {
        const int Size = 640;
        static readonly Color Sky = new Color(0.56f, 0.63f, 0.72f);

        static void Stage()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var sun = new GameObject("sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.4f;
            sun.color = new Color(1f, 0.95f, 0.86f);
            sun.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(48f, -35f, 0f);
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.62f, 0.68f, 0.78f);
            RenderSettings.ambientEquatorColor = new Color(0.45f, 0.45f, 0.45f);
            RenderSettings.ambientGroundColor = new Color(0.25f, 0.22f, 0.2f);
        }

        static Camera MakeCamera()
        {
            var cam = new GameObject("cam").AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Sky;
            cam.fieldOfView = 30f;
            return cam;
        }

        public static string Model(AFPackageData pkg, string outPath)
        {
            Stage();
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(pkg.PrefabPath);
            if (prefab == null) return null;
            var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            var animator = inst.GetComponentInChildren<Animator>();
            var clips = AssetDatabase.LoadAllAssetsAtPath(pkg.ModelPath).OfType<AnimationClip>().Where(c => !c.name.StartsWith("__preview__")).ToList();
            var clip = clips.FirstOrDefault(c => c.name == pkg.default_clip) ?? clips.FirstOrDefault();
            bool sampling = animator != null && clip != null;
            if (sampling)
            {
                AnimationMode.StartAnimationMode();                 // the pose holds until StopAnimationMode
                AnimationMode.BeginSampling();
                AnimationMode.SampleAnimationClip(animator.gameObject, clip, clip.length * 0.35f);
                AnimationMode.EndSampling();
            }
            try
            {
            foreach (var ps in inst.GetComponentsInChildren<ParticleSystem>()) ps.Simulate(1.5f, true, true, true);
            var b = AFBatch.VertexBounds(inst, true);
            var ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            ground.transform.position = new Vector3(b.center.x, 0f, b.center.z);
            ground.transform.localScale = Vector3.one * Mathf.Max(1f, b.size.magnitude);
            var cam = MakeCamera();
            var dir = new Vector3(0.55f, 0.42f, 1f).normalized;          // front-right-above: the model looks along +Z
            float radius = Mathf.Max(0.05f, b.extents.magnitude);
            float dist = radius / Mathf.Sin(cam.fieldOfView * 0.5f * Mathf.Deg2Rad) * 1.02f;
            cam.transform.position = b.center + dir * dist;
            cam.transform.LookAt(b.center);
            cam.nearClipPlane = Mathf.Max(0.01f, dist - radius * 3f);
            cam.farClipPlane = dist + radius * 6f;
            Render(cam, outPath);
            }
            finally
            {
                if (sampling) AnimationMode.StopAnimationMode();
            }
            return outPath;
        }

        public static string Sprite(AFPackageData pkg, string outPath)
        {
            Stage();
            var sp = pkg.sprites;
            var sprites = AFSpriteBuilder.LoadSprites(pkg);
            var clip = sp.clips.FirstOrDefault(c => c.name.StartsWith("idle")) ?? sp.clips.First();
            var row = new List<GameObject>();
            int i = 0;
            foreach (var v in clip.views)                                     // 4 x 2 grid: S SW W NW / N NE E SE
            {
                int mid = v.rects.Length / 2;
                if (!sprites.TryGetValue(AFSpriteBuilder.FrameName(clip.name, v.dir, mid), out var s)) continue;
                var go = new GameObject(v.dir);
                go.AddComponent<SpriteRenderer>().sprite = s;
                float cw = sp.cell_w > 0 ? sp.cell_w / sp.ppu : s.bounds.size.x, ch = sp.cell_h > 0 ? sp.cell_h / sp.ppu : s.bounds.size.y;
                go.transform.position = new Vector3((i % 4) * cw * 1.1f, -(i / 4) * ch * 1.1f, 0f);
                row.Add(go);
                i++;
            }
            var cam = MakeCamera();
            cam.orthographic = true;
            var minX = row.Count > 0 ? row.Min(g => g.GetComponent<SpriteRenderer>().bounds.min.x) : 0f;
            var maxX = row.Count > 0 ? row.Max(g => g.GetComponent<SpriteRenderer>().bounds.max.x) : 1f;
            var minY = row.Count > 0 ? row.Min(g => g.GetComponent<SpriteRenderer>().bounds.min.y) : 0f;
            var maxY = row.Count > 0 ? row.Max(g => g.GetComponent<SpriteRenderer>().bounds.max.y) : 1f;
            float w = maxX - minX, hh = maxY - minY;
            cam.orthographicSize = Mathf.Max(hh, w) * 0.55f;                       // square shot: aspect 1
            cam.transform.position = new Vector3((minX + maxX) / 2f, (minY + maxY) / 2f, -10f);
            Render(cam, outPath, sp.pixel ? FilterMode.Point : FilterMode.Bilinear);
            return outPath;
        }

        static void Render(Camera cam, string path, FilterMode filter = FilterMode.Bilinear)
        {
            var rt = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 1, filterMode = filter };
            rt.Create();
            cam.targetTexture = rt;
            cam.aspect = 1f;
            bool done = false;
            if (GraphicsSettings.currentRenderPipeline != null)
            {
                var req = new RenderPipeline.StandardRequest { destination = rt };
                if (RenderPipeline.SupportsRenderRequest(cam, req))
                {
                    RenderPipeline.SubmitRenderRequest(cam, req);
                    done = true;
                }
            }
            if (!done) cam.Render();
            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            var tex = new Texture2D(Size, Size, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, Size, Size), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;
            cam.targetTexture = null;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllBytes(path, tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
            rt.Release();
            Object.DestroyImmediate(rt);
        }

        public static string ContactSheet(List<string> files, string outPath, int cell = 320, int cols = 4)
        {
            if (files.Count == 0) return null;
            int rows = (files.Count + cols - 1) / cols;
            var sheet = new Texture2D(cols * cell, rows * cell, TextureFormat.RGB24, false);
            var fill = Enumerable.Repeat(new Color32(40, 40, 40, 255), sheet.width * sheet.height).ToArray();
            sheet.SetPixels32(fill);
            for (int i = 0; i < files.Count; i++)
            {
                var t = new Texture2D(2, 2);
                t.LoadImage(File.ReadAllBytes(files[i]));
                int ox = (i % cols) * cell, oy = (rows - 1 - i / cols) * cell;
                for (int y = 0; y < cell; y++)
                    for (int x = 0; x < cell; x++)
                        sheet.SetPixel(ox + x, oy + y, t.GetPixelBilinear((x + 0.5f) / cell, (y + 0.5f) / cell));
                Object.DestroyImmediate(t);
            }
            sheet.Apply();
            File.WriteAllBytes(outPath, sheet.EncodeToPNG());
            Object.DestroyImmediate(sheet);
            return outPath;
        }
    }
}
