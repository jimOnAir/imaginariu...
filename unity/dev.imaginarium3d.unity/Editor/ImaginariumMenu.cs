using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Imaginarium.Editor
{
    /// <summary>Menu Imaginarium/… and the batchmode setup of the studio's check project.</summary>
    public static class ImaginariumMenu
    {
        [MenuItem("Imaginarium/Пересобрать все пакеты", priority = 1)]
        public static void RebuildAll()
        {
            int n = 0;
            foreach (var f in ImaginariumBatch.FindPackages())
            {
                try { if (ImaginariumPrefabBuilder.Build(f, true)) n++; }
                catch (Exception e) { Debug.LogError("Imaginarium: " + f + ": " + e.Message); }
            }
            Debug.Log("Imaginarium: пересобрано пакетов: " + n);
        }

        [MenuItem("Imaginarium/Пересобрать выбранный пакет", priority = 2)]
        public static void RebuildSelected()
        {
            var path = AssetDatabase.GetAssetPath(Selection.activeObject);
            var folder = ImaginariumPackageData.FolderOf(path + "/x") ?? ImaginariumPackageData.FolderOf(path);
            if (folder == null) { Debug.LogWarning("Imaginarium: выберите папку пакета или файл внутри неё."); return; }
            ImaginariumPrefabBuilder.Build(folder, true);
        }

        [MenuItem("Imaginarium/Импортировать папку пакета…", priority = 20)]
        public static void ImportFolder()
        {
            var src = EditorUtility.OpenFolderPanel("Папка пакета Imaginarium (с ima_unity.json)", "", "");
            if (string.IsNullOrEmpty(src)) return;
            if (!File.Exists(Path.Combine(src, ImaginariumPackageData.FileName)))
            {
                EditorUtility.DisplayDialog("Imaginarium", "В папке нет ima_unity.json — это не пакет Unity из студии.", "OK");
                return;
            }
            var pkg = JsonUtility.FromJson<ImaginariumPackageData>(File.ReadAllText(Path.Combine(src, ImaginariumPackageData.FileName)));
            var dst = "Assets/Imaginarium/" + pkg.asset_id;
            if (Directory.Exists(dst)) FileUtil.DeleteFileOrDirectory(dst);
            Directory.CreateDirectory("Assets/Imaginarium");
            FileUtil.CopyFileOrDirectory(src, dst);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            ImaginariumPrefabBuilder.Build(dst, true);
            Selection.activeObject = AssetDatabase.LoadAssetAtPath<GameObject>(pkg.HasModel ? dst + "/" + pkg.asset_id + ".prefab"
                                                                                        : dst + "/" + pkg.asset_id + "_sprite.prefab");
        }

        [MenuItem("Imaginarium/Проверить все пакеты (отчёт в Console)", priority = 40)]
        public static void ValidateAll() => ImaginariumBatch.Validate();
    }

    public static class ImaginariumSetup
    {
        /// <summary>Batchmode: print the pipeline state of the check project (created from the URP template).</summary>
        public static void ConfigureCheckProject()
        {
            var p = ImaginariumPipeline.Current;
            var rp = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline;
            Directory.CreateDirectory("Assets/Imaginarium");
            AssetDatabase.Refresh();
            Debug.Log("IMAGINARIUM SETUP " + (p != ImaginariumRenderPipeline.BuiltIn || Arg("-imaPipeline") == "builtin" ? "ok" : "fail")
                      + " pipeline=" + p + " asset=" + (rp != null ? rp.name : "none") + " unity=" + Application.unityVersion);
        }

        /// <summary>
        /// Batchmode / menu: MCP for Unity (com.coplaydev.unity-mcp) in stdio mode. The editor then starts its TCP
        /// bridge (port 6400) on load, and the server that Claude Code launches (uvx mcpforunityserver ...
        /// --transport stdio) connects to it. EditorPrefs are per user, so this is set once per machine.
        /// </summary>
        [MenuItem("Imaginarium/MCP for Unity: режим stdio для Claude Code", priority = 60)]
        public static void ConfigureUnityMcp()
        {
            EditorPrefs.SetBool("MCPForUnity.UseHttpTransport", false);
            EditorPrefs.SetBool("MCPForUnity.AutoStartOnLoad", false);
            EditorPrefs.SetBool("MCPForUnity.TelemetryDisabled", true);     // no usage events to coplay.dev
            Debug.Log("AFMCP ok stdio (MCPForUnity.UseHttpTransport=false, telemetry off); the bridge starts with the editor");
        }

        static string Arg(string name)
        {
            var a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }
    }
}
