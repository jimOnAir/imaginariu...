"""unreal_package — the Unreal Engine 5 package of a GLB (FBX + textures + af_unreal.json) for the
Python-only importer plugin (unreal/AstraForge), which builds the engine assets itself.
Behavior per ADR-0004, ticket 05; the flow and the unverified-by-design status: docs/product/unreal.md.

inputs.glb        the asset (socket empties named socket_*, clips with the '-loop' suffix - the same
                  studio contract the Godot and Unity packages use), required
inputs.manifest   optional passport json (name, kind, fx...) - carried into the package untouched
params:
  asset_id       snake_case ASCII (required)
  profile        'unreal' (only value today)
  source_forward '+Z' | '-Z' - the nose axis in GLB space; empty: by kind (ships, props, turrets -Z;
                 characters, creatures +Z). The package rotates the root so the nose arrives at UE +X.
  lod            true (default): static meshes from lod_min_tris triangles get decimated _LOD1/_LOD2
  lod_min_tris   3000 by default
  lod_ratios     [0.5, 0.2] by default
  collision      'auto' (default: meshes named *-colonly / *-convcolonly / COL_* become UCX convex
                 hulls and never render) | 'none'
outputs: package (folder), fbx, manifest (af_unreal.json), readme
No Unreal Editor is needed to build a package; when one exists it is driven by
scripts/engines/af_engine.mjs test, never from this step.
"""
import json
import math
import os
import re

import bpy
import numpy as np

import af_common as af
from steps import _export_lib as xl
from steps import _unreal_lib as ul

DEFAULT_LOD_RATIOS = (0.5, 0.2)
UCX_MAX_TRIS = 64


# --------------------------------------------------------------------------- textures

def _save_png(name, w, h, rgba_rows, path, srgb):
    """rows: (w*h, 4) float32 array -> an authored PNG file (the file is the package's, not a .blend)."""
    img = bpy.data.images.new(name, width=w, height=h, alpha=False, float_buffer=True)
    try:
        img.pixels.foreach_set(np.ascontiguousarray(rgba_rows, dtype=np.float32).ravel())
        img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)
    return os.path.basename(path)


def _image_rows(img):
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    return w, h, buf.reshape(w * h, 4)


def _flat_rows(rgba, count=4):
    rows = np.tile(np.asarray(rgba, dtype=np.float32), (count, 1))
    return rows


def _linked_image(link):
    """The image behind a shader input link, following the glTF importer's common node shapes."""
    seen = 0
    node = link.from_node if link else None
    while node is not None and node.type != "TEX_IMAGE" and seen < 6:
        ins = getattr(node, "inputs", None)
        link = ins[0].links[0] if ins and len(ins) and ins[0].links else None
        node = link.from_node if link else None
        seen += 1
    return getattr(node, "image", None) if node is not None else None


def _bsdf_default(bsdf, name, fallback):
    if bsdf is None or name not in bsdf.inputs:
        return fallback
    v = bsdf.inputs[name].default_value
    seq = list(v) if hasattr(v, "__len__") else [v]
    return [float(x) for x in seq[:3]] + ([float(seq[3])] if len(seq) > 3 else [1.0])


def _extract_material(mat, asset_id, slot, tex_dir, warnings):
    """T_<asset>_<slot>_BaseColor/_Normal(DirectX)/_ORM PNGs + the manifest entry for one material."""
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF") or next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if tree else None
    link_of = lambda name: (bsdf.inputs[name].links[0] if bsdf is not None and name in bsdf.inputs and bsdf.inputs[name].links else None)
    entry = {"name": ul.ue_name("MI", asset_id, slot), "textures": {}, "normal_space": None,
             "params": {"metallic": round(_bsdf_default(bsdf, "Metallic", [0.0])[0], 4),
                        "roughness": round(_bsdf_default(bsdf, "Roughness", [0.5])[0], 4)}}

    base = _linked_image(link_of("Base Color"))
    if base is not None and base.size > 0:
        w, h, rows = _image_rows(base)
        entry["textures"]["baseColor"] = _save_png("af_bc_" + slot, w, h, rows, os.path.join(tex_dir, ul.ue_name("T", asset_id, slot) + "_BaseColor.png"), True)
    else:
        entry["textures"]["baseColor"] = _save_png("af_bc_" + slot, 2, 2, _flat_rows(_bsdf_default(bsdf, "Base Color", [0.8, 0.8, 0.8, 1.0])), os.path.join(tex_dir, ul.ue_name("T", asset_id, slot) + "_BaseColor.png"), True)

    nrm = None
    if bsdf is not None and "Normal" in bsdf.inputs and bsdf.inputs["Normal"].links:
        nm = bsdf.inputs["Normal"].links[0].from_node
        if nm is not None and nm.type == "NORMAL_MAP" and nm.inputs["Color"].links:
            nrm = nm.inputs["Color"].links[0].from_node.image
    if nrm is not None and nrm.size > 0:
        w, h, rows = _image_rows(nrm)
        rows = rows.copy()
        rows[:, 1] = 1.0 - rows[:, 1]                    # OpenGL green -> DirectX green (UE's rule)
        entry["textures"]["normal"] = _save_png("af_nrm_" + slot, w, h, rows, os.path.join(tex_dir, ul.ue_name("T", asset_id, slot) + "_Normal.png"), False)
        entry["normal_space"] = "directX"

    mr = _bsdf_default(bsdf, "Metallic", [0.0])[0]
    rg = _bsdf_default(bsdf, "Roughness", [0.5])[0]
    orm_src = _linked_image(link_of("Metallic Roughness"))
    if orm_src is not None and orm_src.size > 0:
        w, h, rows = _image_rows(orm_src)
        orm = np.ones((w * h, 4), dtype=np.float32)
        orm[:, 1] = rows[:, 1]                           # glTF G = roughness
        orm[:, 2] = rows[:, 2]                           # glTF B = metallic; R stays occlusion
        entry["textures"]["orm"] = _save_png("af_orm_" + slot, w, h, orm, os.path.join(tex_dir, ul.ue_name("T", asset_id, slot) + "_ORM.png"), False)
    else:
        entry["textures"]["orm"] = _save_png("af_orm_" + slot, 2, 2, _flat_rows([1.0, rg, mr, 1.0]), os.path.join(tex_dir, ul.ue_name("T", asset_id, slot) + "_ORM.png"), False)
    if tree is None:
        warnings.append("material %s has no node tree; flat colours packaged" % mat.name)
    return entry


# --------------------------------------------------------------------------- geometry

def _split_collision(objs):
    render, coll = [], []
    for o in objs:
        (coll if ul.is_collision_name(o.name) else render).append(o)
    return render, coll


def _decimate_to(obj, max_tris):
    guard = 0
    while sum(len(p.vertices) - 2 for p in obj.data.polygons) > max_tris and guard < 5:
        m = obj.modifiers.new("dec", "DECIMATE")
        cur = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        m.ratio = max(0.05, max_tris / max(cur, 1))
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=m.name)
        guard += 1


def _convex_ucx(src, render_name, index):
    """UCX_<render>_## convex hull from a collision source, within UE's triangle budget."""
    hull = bpy.data.objects.new(ul.ucx_name(render_name, index), src.data.copy())
    bpy.context.collection.objects.link(hull)
    hull.matrix_world = src.matrix_world.copy()
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    hull.select_set(True)
    bpy.context.view_layer.objects.active = hull
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.convex_hull()
    bpy.ops.object.mode_set(mode="OBJECT")
    _decimate_to(hull, UCX_MAX_TRIS)
    return hull


def _make_lods(obj, ratios, warnings):
    lods = []
    for i, r in enumerate(ratios, start=1):
        dup = obj.copy()
        dup.data = obj.data.copy()
        dup.name = ul.lod_name(obj.name, i)
        bpy.context.collection.objects.link(dup)
        m = dup.modifiers.new("lod", "DECIMATE")
        m.ratio = float(r)
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        dup.select_set(True)
        bpy.context.view_layer.objects.active = dup
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
            lods.append({"level": i, "mesh": dup.name, "ratio": float(r)})
        except RuntimeError as e:                        # degenerate mesh: LOD0 only, say so
            warnings.append("LOD%d of %s skipped: %s" % (i, obj.name, e))
            bpy.data.objects.remove(dup, do_unlink=True)
    return lods


def _sockets(objs, armatures):
    """The studio socket contract: empties named socket_*; an empty parented to a bone becomes a
    bone socket the plugin re-creates on the Skeleton."""
    bones = {b.name for a in armatures for b in a.data.bones}
    out = []
    for o in objs:
        if o.type != "EMPTY" or not o.name.startswith("socket_"):
            continue
        bone = o.parent_bone if (o.parent and o.parent.type == "ARMATURE" and o.parent_bone in bones) else None
        out.append({"name": o.name, "bone": bone,
                    "transform": [[round(float(v), 5) for v in row] for row in o.matrix_world]})
    return out


# --------------------------------------------------------------------------- step

def run(req):
    p, inputs = req["params"], req["inputs"]
    warnings, checks = [], []
    asset_id = p.get("asset_id")
    if not asset_id or not xl.ASSET_ID_RE.match(asset_id):
        raise ValueError("params.asset_id must be snake_case ASCII (^[a-z][a-z0-9]*(_[a-z0-9]+)*$): %r" % asset_id)
    if p.get("profile", "unreal") != "unreal":
        raise ValueError("params.profile must be unreal: %r" % p.get("profile"))
    glb = inputs.get("glb") or inputs.get("mesh")
    if not glb or not os.path.isfile(glb) or not glb.lower().endswith(".glb"):
        raise ValueError("inputs.glb must be an existing .glb file: %r" % glb)
    passport = {}
    if inputs.get("manifest"):
        with open(inputs["manifest"], "r", encoding="utf-8-sig") as fh:
            passport = json.load(fh)

    af.log("importing %s" % os.path.basename(glb))
    af.reset_scene()
    af.import_any(glb)
    objs = [o for o in bpy.context.view_layer.objects if o is not None]
    render, coll_sources = _split_collision([o for o in objs if o.type in ("MESH", "ARMATURE", "EMPTY")])
    render_meshes = [o for o in render if o.type == "MESH"]
    armatures = [o for o in render if o.type == "ARMATURE"]
    if not render_meshes:
        raise ValueError("the GLB has no render meshes (only collision?)")

    kind = (passport.get("kind") or "").lower()
    source_forward = ul.source_forward_for(kind, p.get("source_forward"))
    rot = ul.rotation_for_source(source_forward)
    if rot:
        for o in [x for x in render if x.parent is None]:
            o.delta_rotation_euler.z += math.radians(rot)
        bpy.context.view_layer.update()

    skinned = bool(armatures)
    main_prefix = ul.PREFIX_MESH["skinned" if skinned else "static"]
    main_name = ul.ue_name(main_prefix, asset_id)

    # UE addresses assets by FBX object names: rename to the SM_/SK_ conventions
    for i, o in enumerate(sorted(render_meshes, key=lambda x: x.name)):
        o.name = main_name if i == 0 else ul.ue_name(main_prefix, asset_id, re.sub(r"[^A-Za-z0-9]+", "_", o.name)[:24])
        o.data.name = o.name

    pkg = os.path.join(req["out_dir"], "unreal_package")
    tex_dir = os.path.join(pkg, "Textures")
    os.makedirs(tex_dir, exist_ok=True)
    # materials: one manifest entry + texture set per unique material (before LODs copy the data)
    by_source = {}
    for o in render_meshes:
        for slot_i, ms in enumerate(o.data.materials):
            if ms is None or ms.name in by_source:
                continue
            by_source[ms.name] = _extract_material(ms, asset_id, ul.slot_slug(ms.name, slot_i), tex_dir, warnings)
    material_entries = list(by_source.values())

    mesh_entries = []
    for o in render_meshes:
        lods = []
        if p.get("lod", True) and not skinned:
            tris = sum(len(pg.vertices) - 2 for pg in o.data.polygons)
            if tris >= int(p.get("lod_min_tris", 3000)):
                lods = _make_lods(o, p.get("lod_ratios") or DEFAULT_LOD_RATIOS, warnings)
        mesh_entries.append({"mesh": o.name,
                             "materials": [by_source[m.name]["name"] for m in o.data.materials if m is not None],
                             "lods": lods})

    # collision sources -> UCX hulls attached to their render mesh; the sources never export
    coll_entries, ucx_objs = [], []
    if p.get("collision", "auto") != "none":
        for src in coll_sources:
            if src.type != "MESH":
                continue
            base = re.sub(r"[-_](conv)?colonly$", "", src.name, flags=re.I)
            base = re.sub(r"^COL_", "", base, flags=re.I).strip("_-")
            target = next((m["mesh"] for m in mesh_entries if base and base[:16].lower() in m["mesh"].lower()), main_name)
            hull = _convex_ucx(src, target, len([c for c in coll_entries if c["render"] == target]))
            ucx_objs.append(hull)
            coll_entries.append({"render": target, "ucx": hull.name, "kind": "convex",
                                 "triangles": int(sum(len(pg.vertices) - 2 for pg in hull.data.polygons))})
    for src in coll_sources:
        if src.type == "MESH":
            bpy.data.objects.remove(src, do_unlink=True)

    sockets = _sockets([o for o in bpy.context.view_layer.objects if o is not None and o.type == "EMPTY"], armatures)
    clips = []
    for a in bpy.data.actions:
        if not xl.fcurves_of(a):
            continue
        name, loop = ul.anim_name(xl.clip_base(a.name)[0])
        clips.append({"source": a.name, "name": name, "loop": loop,
                      "frames": [round(a.frame_range[0], 3), round(a.frame_range[1], 3)]})

    lod_objs = [o for o in bpy.context.view_layer.objects if o is not None and o.type == "MESH" and re.search(r"_LOD\d$", o.name)]
    export_objs = armatures + render_meshes + lod_objs + ucx_objs
    fbx = os.path.join(pkg, main_name + ".fbx")
    af.log("writing %s" % os.path.basename(fbx))
    has_anim = any(xl.fcurves_of(a) for a in bpy.data.actions)
    af.export_fbx(fbx, objects=export_objs, axis_forward="-Y", axis_up="Z",
                  apply_unit_scale=True, bake_space_transform=False, embed_textures=False,
                  bake_anim=has_anim, bake_anim_use_nla_strips=False, bake_anim_use_all_actions=has_anim)

    manifest = {
        "format": ul.FORMAT, "asset": {"id": asset_id, "name": passport.get("name") or asset_id, "kind": kind or None},
        "units": "cm", "axes": {"up": "Z", "forward": "+X", "handed": "left", "source_forward_glb": source_forward,
                                "root_rotation_z_deg": rot, "fbx_axes": {"forward": "-Y", "up": "Z"}},
        "fbx": os.path.basename(fbx), "main": {"mesh": main_name, "rig": "skeletal" if skinned else "static"},
        "meshes": mesh_entries, "materials": material_entries, "collision": coll_entries,
        "sockets": sockets, "animations": clips, "fps": float(bpy.context.scene.render.fps),
        "master_material": "M_AstraForge", "actor_blueprint": ul.ue_name("A", asset_id),
        "passport": passport,
        "studio": {"tool": "AstraForge unreal_package", "version": _studio_version()},
    }
    man_path = os.path.join(pkg, "af_unreal.json")
    with open(man_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    readme = os.path.join(pkg, "README.md")
    with open(readme, "w", encoding="utf-8") as fh:
        fh.write(readme_text(main_name, material_entries, coll_entries, sockets, clips))

    pngs = [f for f in os.listdir(tex_dir) if f.endswith(".png")]
    checks = [
        af.check("package_fbx", os.path.isfile(fbx), os.path.basename(fbx)),
        af.check("package_manifest", os.path.isfile(man_path)),
        af.check("naming_prefix", main_name.startswith(("SM_", "SK_")), main_name),
        af.check("collision_ucx", all(c["ucx"].startswith("UCX_") for c in coll_entries), len(coll_entries), severity="warning"),
        af.check("textures_packaged", len(pngs) > 0, len(pngs), severity="warning"),
    ]
    return {"outputs": {"package": pkg, "fbx": fbx, "manifest": man_path, "readme": readme},
            "stats": dict(af.scene_stats(xl.render_meshes(list(bpy.context.view_layer.objects))),
                          sockets=len(sockets), collision=len(coll_entries),
                          lods=sum(len(m["lods"]) for m in mesh_entries)),
            "checks": checks, "warnings": warnings}


def _studio_version():
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        with open(os.path.join(root, "package.json"), "r", encoding="utf-8") as fh:
            return json.load(fh).get("version")
    except Exception:
        return None


def readme_text(main_name, materials, collision, sockets, clips):
    return "\n".join([
        "# %s - Unreal Engine 5 package" % main_name, "",
        "Import with the AstraForge importer plugin (unreal/AstraForge): run",
        "`astraforge_unreal.import_package` over the `af_unreal.json` beside this README.", "",
        "The package carries the FBX (%s), %d material instance(s) with their" % (main_name + ".fbx", len(materials)),
        "BaseColor / Normal(DirectX) / ORM textures, %d UCX collision hull(s), %d socket(s)," % (len(collision), len(sockets)),
        "and %d animation(s); units are centimetres, Z up, nose +X, assets are named" % len(clips),
        "SM_ / SK_ / A_ / T_ / MI_. The studio builds and checks packages on Linux; the",
        "in-editor import is verified wherever an Unreal Editor exists (see the studio docs).", "",
    ])
