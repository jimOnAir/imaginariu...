using System;
using System.IO;
using UnityEngine;

namespace AstraForge.Editor
{
    // Mirrors af_unity.json (scripts/blender/steps/unity_package.py, format astraforge-unity-package/1).
    // JsonUtility-friendly: no dictionaries, no nested arrays.

    [Serializable] public class AFMaterialData
    {
        public string name;
        public string base_map, normal_map, mask_map, emission_map;
        public float[] base_color = { 1, 1, 1, 1 };
        public float[] emission_color = { 0, 0, 0 };
        public float metallic, smoothness = 0.5f, normal_scale = 1f, cutoff = 0.5f;
        public string alpha = "opaque";               // opaque | cutout | blend
        public bool double_sided, vertex_color, wind;
        public float wind_strength = 0.07f, wind_speed = 1.4f, flutter = 0.025f;
        public float[] wind_direction = { -1f, 0f, 0.35f };
    }

    [Serializable] public class AFClipData
    {
        public string take, name;
        public bool loop;
        public float first, last, fps;
    }

    [Serializable] public class AFSocketData
    {
        public string name, node, kind, bone;
        public float[] position = { 0, 0, 0 };
    }

    [Serializable] public class AFLodLevelData
    {
        public float screen;
        public string[] renderers = new string[0];
    }

    [Serializable] public class AFLodData
    {
        public AFLodLevelData[] levels = new AFLodLevelData[0];
        public int[] tris = new int[0];
    }

    [Serializable] public class AFColliderData
    {
        public string type = "none";                  // none | box | capsule | mesh | convex
        public float[] center = { 0, 0, 0 };
        public float[] size = { 0, 0, 0 };
        public float radius, height;
        public int direction = 1;
        public string[] nodes = new string[0];
        public string note;
    }

    [Serializable] public class AFFxBindingData
    {
        public string preset, fx, socket, node_name, scale_source;
        public float[] up = { 0, 1, 0 };
        public float[] forward = { 0, 0, 1 };
        public bool one_shot;
        public float scale = 1f;
    }

    [Serializable] public class AFKeyData { public float t, v; }
    [Serializable] public class AFColorKeyData { public float t, r, g, b, a; }

    [Serializable] public class AFFxPresetData
    {
        public string id, preset;
        public int amount = 16;
        public float lifetime = 1f, explosiveness, spread = 45f, quad_size = 0.2f, turbulence;
        public bool one_shot, autostart = true, local_coords;
        public float[] direction = { 0, 1, 0 };
        public float[] velocity = { 1, 1 }, gravity = { 0, -9.8f, 0 }, damping = { 0, 0 }, scale = { 1, 1 };
        public AFKeyData[] scale_curve = new AFKeyData[0];
        public AFColorKeyData[] color_ramp = new AFColorKeyData[0];
        public string emission_shape = "point";
        public float radius, inner_radius, height;
        public float[] extents = { 0, 0, 0 }, ring_axis = { 0, 1, 0 };
        public string texture = "soft", blend = "add";
        public float[] angle = { 0, 0 }, angular_velocity = { 0, 0 }, tangential_accel = { 0, 0 }, radial_accel = { 0, 0 };
        public bool has_light;
        public float[] light_color = { 1, 1, 1 };
        public float light_energy = 1f, light_range = 1f;
    }

    [Serializable] public class AFRectData { public int x, y, w, h; }

    [Serializable] public class AFSpriteViewData
    {
        public string dir, sheet;
        public AFRectData[] rects = new AFRectData[0];
    }

    [Serializable] public class AFSpriteClipData
    {
        public string name;
        public bool loop;
        public float fps = 12f;
        public AFSpriteViewData[] views = new AFSpriteViewData[0];
    }

    [Serializable] public class AFSpritesData
    {
        public float ppu = 100f;
        public bool pixel;
        public int cell_w, cell_h;
        public float anchor_x, anchor_y, elevation_deg;
        public AFSpriteClipData[] clips = new AFSpriteClipData[0];
        public string[] sheets = new string[0];
    }

    [Serializable] public class AFPackageData
    {
        public string format, asset_id, profile, kind, generator, pipeline_hint;
        public string model, rig = "none", default_clip, source_forward;
        public string[] missing_humanoid_bones = new string[0];
        public float model_rotation_y;
        public float[] size_m = { 0, 0, 0 }, bounds_min = { 0, 0, 0 }, bounds_max = { 0, 0, 0 }, size_gltf_m = { 0, 0, 0 };
        public int tris;
        public AFMaterialData[] materials = new AFMaterialData[0];
        public AFClipData[] clips = new AFClipData[0];
        public AFSocketData[] sockets = new AFSocketData[0];
        public AFLodData lod = new AFLodData();
        public AFColliderData collider = new AFColliderData();
        public AFFxBindingData[] fx = new AFFxBindingData[0];
        public AFFxPresetData[] fx_presets = new AFFxPresetData[0];
        public AFSpritesData sprites = new AFSpritesData();

        [NonSerialized] public string folder;          // Assets/... folder that holds af_unity.json
        [NonSerialized] public string json;

        public const string FileName = "af_unity.json";

        public bool HasModel => !string.IsNullOrEmpty(model);
        public bool HasSprites => sprites != null && sprites.clips != null && sprites.clips.Length > 0;
        public string ModelPath => folder + "/" + model;
        public string PrefabPath => folder + "/" + asset_id + ".prefab";
        public string SpritePrefabPath => folder + "/" + asset_id + "_sprite.prefab";

        public static AFPackageData Load(string folder)
        {
            var path = folder + "/" + FileName;
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path);
            var p = JsonUtility.FromJson<AFPackageData>(text);
            if (p == null || p.format == null || !p.format.StartsWith("astraforge-unity-package/")) return null;
            p.folder = folder;
            p.json = text;
            return p;
        }

        /// <summary>Package folder of an asset inside it (the FBX, textures/, fx/textures/, sprites/).</summary>
        public static string FolderOf(string assetPath)
        {
            var dir = Path.GetDirectoryName(assetPath)?.Replace('\\', '/');
            for (int i = 0; i < 3 && !string.IsNullOrEmpty(dir); i++)
            {
                if (File.Exists(dir + "/" + FileName)) return dir;
                dir = Path.GetDirectoryName(dir)?.Replace('\\', '/');
            }
            return null;
        }

        public static AFPackageData ForAsset(string assetPath)
        {
            var f = FolderOf(assetPath);
            return f == null ? null : Load(f);
        }

        public static Vector3 V3(float[] a, Vector3 fallback = default)
        {
            return a != null && a.Length >= 3 ? new Vector3(a[0], a[1], a[2]) : fallback;
        }
    }
}
