using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AstraForge.Editor
{
    /// <summary>Menu AstraForge/… and the batchmode setup of the studio's check project.</summary>
    public static class AFMenu
    {
        [MenuItem("AstraForge/Пересобрать все пакеты", priority = 1)]
        public static void RebuildAll()
        {
            int n = 0;
            foreach (var f in AFBatch.FindPackages())
            {
                try { if (AFPrefabBuilder.Build(f, true)) n++; }
                catch (Exception e) { Debug.LogError("AstraForge: " + f + ": " + e.Message); }
            }
            Debug.Log("AstraForge: пересобрано пакетов: " + n);
        }

        [MenuItem("AstraForge/Пересобрать выбранный пакет", priority = 2)]
        public static void RebuildSelected()
        {
            var path = AssetDatabase.GetAssetPath(Selection.activeObject);
            var folder = AFPackageData.FolderOf(path + "/x") ?? AFPackageData.FolderOf(path);
            if (folder == null) { Debug.LogWarning("AstraForge: выберите папку пакета или файл внутри неё."); return; }
            AFPrefabBuilder.Build(folder, true);
        }

        [MenuItem("AstraForge/Импортировать папку пакета…", priority = 20)]
        public static void ImportFolder()
        {
            var src = EditorUtility.OpenFolderPanel("Папка пакета AstraForge (с af_unity.json)", "", "");
            if (string.IsNullOrEmpty(src)) return;
            if (!File.Exists(Path.Combine(src, AFPackageData.FileName)))
            {
                EditorUtility.DisplayDialog("AstraForge", "В папке нет af_unity.json — это не пакет Unity из студии.", "OK");
                return;
            }
            var pkg = JsonUtility.FromJson<AFPackageData>(File.ReadAllText(Path.Combine(src, AFPackageData.FileName)));
            var dst = "Assets/AstraForge/" + pkg.asset_id;
            if (Directory.Exists(dst)) FileUtil.DeleteFileOrDirectory(dst);
            Directory.CreateDirectory("Assets/AstraForge");
            FileUtil.CopyFileOrDirectory(src, dst);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            AFPrefabBuilder.Build(dst, true);
            Selection.activeObject = AssetDatabase.LoadAssetAtPath<GameObject>(pkg.HasModel ? dst + "/" + pkg.asset_id + ".prefab"
                                                                                        : dst + "/" + pkg.asset_id + "_sprite.prefab");
        }

        [MenuItem("AstraForge/Проверить все пакеты (отчёт в Console)", priority = 40)]
        public static void ValidateAll() => AFBatch.Validate();
    }

    public static class AFSetup
    {
        /// <summary>Batchmode: print the pipeline state of the check project (created from the URP template).</summary>
        public static void ConfigureCheckProject()
        {
            var p = AFPipeline.Current;
            var rp = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline;
            Directory.CreateDirectory("Assets/AstraForge");
            AssetDatabase.Refresh();
            Debug.Log("AFSETUP " + (p != AFRenderPipeline.BuiltIn || Arg("-afPipeline") == "builtin" ? "ok" : "fail")
                      + " pipeline=" + p + " asset=" + (rp != null ? rp.name : "none") + " unity=" + Application.unityVersion);
        }

        /// <summary>
        /// Batchmode / menu: MCP for Unity (com.coplaydev.unity-mcp) in stdio mode. The editor then starts its TCP
        /// bridge (port 6400) on load, and the server that Claude Code launches (uvx mcpforunityserver ...
        /// --transport stdio) connects to it. EditorPrefs are per user, so this is set once per machine.
        /// </summary>
        [MenuItem("AstraForge/MCP for Unity: режим stdio для Claude Code", priority = 60)]
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
