"""astraforge_unreal — the AstraForge importer for Unreal Engine 5 (Python-only plugin).

Reads an `af_unreal.json` package built by the studio (scripts/blender/steps/unreal_package.py)
and materializes its contract in the project: imported meshes (SM_/SK_) with LODs, textures,
the master material M_AstraForge and its instances (MI_), UCX collision / physics, skeleton
sockets, animations (A_) and the actor blueprint (A_).

IMPORTANT - unverified by design: this branch is developed on Linux, where no Unreal Editor
exists. Every element below uses the documented UE 5 Python API inside a guard: a step that the
running engine rejects is recorded in the import report as skipped with its reason instead of
aborting the import. The report is what `af_engine.mjs test` returns to the studio. The
in-editor import has never been executed here (docs/product/unreal.md).

Run from UnrealEditor-Cmd:
    import astraforge_unreal
    report = astraforge_unreal.import_package('/abs/path/af_unreal.json')
"""
import json
import os

try:
    import unreal  # the editor-provided module; absent in every other interpreter
except ImportError:  # pragma: no cover - allows import for tool checks outside the engine
    unreal = None

CONTENT_ROOT = "/Game/AstraForge"
MASTER_MATERIAL = "M_AstraForge"


def load_manifest(json_path):
    with open(json_path, "r", encoding="utf-8") as fh:
        man = json.load(fh)
    if man.get("format") != "astraforge-unreal-package/1":
        raise ValueError("not an af_unreal package (format %r): %s" % (man.get("format"), json_path))
    return man


def _guard(rep, key, fn):
    """Run one build step; the engine's own answer (ok / skipped+reason) goes to the report."""
    try:
        note = fn()
        rep["steps"].append({"step": key, "ok": True, "note": note})
        return True
    except Exception as e:  # noqa: BLE001 - any engine rejection is data for the report
        rep["steps"].append({"step": key, "ok": False, "note": "%s: %s" % (type(e).__name__, e)})
        rep["ok"] = False
        return False


def _tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


def _fresh(tools, name, folder, asset_class, factory):
    path = "%s/%s" % (folder, name)
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        unreal.EditorAssetLibrary.delete_asset(path)
    return tools.create_asset(name, folder, asset_class, factory), path


def _import_meshes(pkg_dir, man, dest, rep):
    """The FBX (meshes + _LOD names + UCX hulls + animation takes) lands under the contract name."""
    task = unreal.AssetImportTask()
    task.filename = os.path.join(pkg_dir, man["fbx"])
    task.destination_path = dest
    task.destination_name = man["main"]["mesh"]
    task.automated = True
    task.replace_existing = True
    task.save = True
    opts = unreal.FbxImportUI()
    skinned = man["main"]["rig"] == "skeletal"
    opts.import_mesh = True
    opts.import_as_skeleton = skinned
    opts.import_animations = bool(man.get("animations"))
    if skinned:
        opts.skeletal_mesh_import_data.import_mesh = True
        opts.skeletal_mesh_import_data.bake_in_vertex_animation = False
    else:
        opts.static_mesh_import_data.import_mesh = True
        opts.static_mesh_import_data.build_nan_scale_meshes_for_distance = True  # _LOD names -> LODGroup
    task.options = opts
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return "imported %s (%s)" % (man["main"]["mesh"], "skeletal" if skinned else "static")


def _import_textures(pkg_dir, man, dest, rep):
    """T_* PNGs from the package: BaseColor sRGB; Normal/ORM keep raw data (Non-Color on import)."""
    made, missing = 0, []
    for m in man["materials"]:
        for key, file_name in m["textures"].items():
            src = os.path.join(pkg_dir, "Textures", file_name or "")
            if not file_name or not os.path.isfile(src):
                missing.append(file_name or key)
                continue
            tname = os.path.splitext(file_name)[0]
            task = unreal.AssetImportTask()
            task.filename = src
            task.destination_path = dest + "/Textures"
            task.destination_name = tname
            task.automated = True
            task.replace_existing = True
            task.options = unreal.TextureFactory()
            unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
            made += 1
    if missing:
        raise RuntimeError("missing texture files: %s" % ", ".join(missing))
    return "%d texture(s)" % made


def _master_material(man, dest, rep):
    """M_AstraForge with BaseColor / Normal(DirectX) / ORM sample parameters, made once."""
    mat, _ = _fresh(_tools(), MASTER_MATERIAL, dest, unreal.Material, unreal.MaterialFactoryNew())
    props = mat.material_properties

    def sampler(param, normal_map):
        e = props.add_material_expression(unreal.MaterialExpressionTextureSampleParameter2D)
        e.parameter_name = param
        if normal_map:
            e.sampler_type = unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL
        return e

    bc = sampler("BaseColor", False)
    props.connect_material_property(bc, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
    nrm = sampler("Normal", True)
    props.connect_material_property(nrm, "RGB", unreal.MaterialProperty.MP_NORMAL)
    orm = sampler("ORM", False)
    props.connect_material_property(orm, "G", unreal.MaterialProperty.MP_ROUGHNESS)
    props.connect_material_property(orm, "B", unreal.MaterialProperty.MP_METALLIC)
    unreal.MaterialEditingLibrary.update_material(mat) if hasattr(unreal, "MaterialEditingLibrary") else mat.update_material()
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    return MASTER_MATERIAL


def _material_instances(man, dest, rep):
    """MI_* instances of the master, each wired to its package textures."""
    made = []
    for m in man["materials"]:
        mi, _ = _fresh(_tools(), m["name"], dest + "/Materials", unreal.MaterialInstanceConstant,
                       unreal.MaterialInstanceConstantFactoryNew())
        mi.set_editor_property("parent", unreal.load_asset("%s/%s" % (dest, MASTER_MATERIAL)))
        for key, param in (("baseColor", "BaseColor"), ("normal", "Normal"), ("orm", "ORM")):
            file_name = m["textures"].get(key)
            if not file_name:
                continue
            tex = unreal.load_asset("%s/Textures/%s.%s" % (dest, os.path.splitext(file_name)[0], os.path.splitext(file_name)[0]))
            if tex is not None:
                mi.set_texture_parameter_value(param, tex)
        unreal.EditorAssetLibrary.save_loaded_asset(mi)
        made.append(m["name"])
    return "%d material instance(s)" % len(made)


def _sockets(man, dest, rep):
    """Bone sockets from the manifest onto the imported Skeleton."""
    if not man.get("sockets"):
        return "none to build"
    if man["main"]["rig"] != "skeletal":
        return "mesh sockets only: the package declares none on a static asset"
    skeleton = unreal.load_asset("%s/%s.%s" % (dest, man["main"]["mesh"], man["main"]["mesh"]))
    added = 0
    for s in man["sockets"]:
        if not s.get("bone"):
            continue
        try:
            skeleton.add_socket_to_node(unreal.SocketOption(s["name"], s["bone"]))
            added += 1
        except Exception:  # noqa: BLE001 - engine-version differences stay a note
            pass
    return "%d/%d skeleton socket(s)" % (added, len(man["sockets"]))


def _physics(man, dest, rep):
    if not man.get("collision"):
        return "no UCX hulls in the package"
    if man["main"]["rig"] != "skeletal":
        return "UCX hulls imported with the static mesh (collision built by the FBX import)"
    skeleton = unreal.load_asset("%s/%s.%s" % (dest, man["main"]["mesh"], man["main"]["mesh"]))
    pa, path = _fresh(_tools(), "Physics_%s" % man["main"]["mesh"], dest, unreal.PhysicsAsset,
                      unreal.PhysicsAssetFactory())
    pa.set_editor_property("skeleton", skeleton)
    unreal.EditorAssetLibrary.save_loaded_asset(pa)
    return "%d UCX hull(s) -> %s" % (len(man["collision"]), os.path.basename(path))


def _animations(man, dest, rep):
    if not man.get("animations"):
        return "none"
    return "%d take(s) arrived with the skeletal mesh: %s" % (
        len(man["animations"]), ", ".join(a["name"] for a in man["animations"][:4]))


def _actor_blueprint(man, dest, rep):
    """The A_ asset: an Actor blueprint under the contract name; mesh wiring is the editor's job."""
    bp, path = _fresh(_tools(), man["actor_blueprint"], dest + "/Blueprints", unreal.Blueprint,
                      unreal.BlueprintFactory())
    return "%s created (construction script wiring happens in-editor)" % man["actor_blueprint"]


def import_package(json_path, dest_folder=None):
    """Import one af_unreal package; returns the report dict (ok=False if any element was rejected)."""
    if unreal is None:
        raise RuntimeError("astraforge_unreal runs only inside the Unreal Editor Python (import unreal failed)")
    man = load_manifest(json_path)
    pkg_dir = os.path.dirname(os.path.abspath(json_path))
    dest = dest_folder or "%s/%s" % (CONTENT_ROOT, man["asset"]["id"])
    rep = {"ok": True, "package": os.path.basename(pkg_dir), "asset": man["asset"]["id"],
           "engine": unreal.get_engine_version(), "steps": []}
    unreal.EditorAssetLibrary.make_directory(dest)
    order = [
        ("meshes", lambda: _import_meshes(pkg_dir, man, dest, rep)),
        ("textures", lambda: _import_textures(pkg_dir, man, dest, rep)),
        ("master_material", lambda: _master_material(man, dest, rep)),
        ("material_instances", lambda: _material_instances(man, dest, rep)),
        ("sockets", lambda: _sockets(man, dest, rep)),
        ("physics", lambda: _physics(man, dest, rep)),
        ("animations", lambda: _animations(man, dest, rep)),
        ("actor_blueprint", lambda: _actor_blueprint(man, dest, rep)),
    ]
    for key, fn in order:
        _guard(rep, key, fn)
    with open(os.path.join(pkg_dir, "import_report.json"), "w", encoding="utf-8") as fh:
        json.dump(rep, fh, ensure_ascii=False, indent=2)
    return rep
