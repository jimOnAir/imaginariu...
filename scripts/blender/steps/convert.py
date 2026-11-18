"""convert — any supported input to GLB / FBX / OBJ, optionally a Mixamo-ready FBX.

inputs.mesh or inputs.blend: .glb/.gltf/.fbx/.obj/.stl/.vrm/.blend. A rig and its animation are kept
(except for OBJ and Mixamo); importer helpers such as the glTF bone-shape Icosphere are deleted.

params:
  format          'glb' (default) | 'fbx' | 'obj'
  name            output basename (default "model")
  height_m        scale so the bbox height equals it (omit = keep)
  rotate_z_deg    rotation about Z
  ground, center  default true when height_m is given or mixamo is on, false otherwise
                  (a plain conversion keeps the original placement)
  mixamo          true -> Mixamo-upload FBX (forces format 'fbx'), ported from an
                  earlier in-house script: one welded mesh "Body" without rig, facing -Y
                  (FBX +Z), feet at z=0, height default 1.8 m, FBX units cm (FBX_SCALE_ALL),
                  textures embedded and limited in size, file kept under the 10 MB browser
                  upload limit when possible
  mixamo_max_tris decimation budget for the Mixamo mesh (default 50000)
  mixamo_weld_m   weld distance (default 1e-4; Mixamo's auto-skinner fails on UV-split meshes)
  mixamo_center   'bbox' (default) | 'head' — X centre on the head column, for props on one side
  texture_max     max texture side for the Mixamo FBX (default 2048, halves if the file is
                  over 10 MB, down to 512)
  lods            triangle-fraction list, e.g. [0.5, 0.2] -> extra <name>_lodN.glb at that share
                  of the main file's triangles (glb output only). The files stay PLAIN GLB that
                  Godot opens; the skin and every clip are carried. imaginarium-mesh-rs builds them at the
                  exact fraction; without it gltfpack -si approximates (provenance in stats.lods)
  compress        true -> extra <name>.compact.glb with EXT_meshopt_compression (gltfpack -c, for
                  three.js / Babylon / Unity glTFast). The main file stays plain on purpose:
                  Godot 4.5.1 cannot read the compressed form
  quantize        with compress: apply KHR_mesh_quantization on top (default true, smaller;
                  false -> -noq, meshopt compression without quantization)

outputs: glb|fbx|obj, blend (converted.blend), textures (FBX/OBJ: the maps written next to it).
         lods/compress (glb only) write additionally lod1..lod3 and compact.
checks: round-trip re-import of the written file (triangles, mesh count, height, base colour,
armature); with height_m also height_matches (round trip vs params.height_m, 1e-3 relative)
and grounded (round-trip z_min = 0) when grounding is on.
         lodN_tris (imaginarium-mesh-rs exact, gltfpack approximate as a warning) and
         compact_meshopt_ext run when those params did.
"""
import json
import math
import os
import shutil
import struct
import subprocess

import bpy

import imaginarium_common as ima
from steps import _mesh_lib as ml

MIXAMO_UPLOAD_LIMIT = 10_000_000
REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "..", "..", ".."))


def _external_tool(env_name, cfg_key, own):
    """An external binary resolved the way server/imaginarium-mesh.mjs resolves imaginarium-mesh-rs (ticket 46):
    the explicit IMAGINARIUM_* env, then config/paths.json (the installer-written key), then the
    in-repo build. An env override pointing at a missing file is an honest absence, never a
    silent fallback (0.7.9 fold wave ticket 56)."""
    forced = (os.environ.get(env_name) or "").strip()
    if forced:
        return forced if os.path.isfile(forced) else None
    try:
        with open(os.path.join(REPO_ROOT, "config", "paths.json")) as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = {}
    p = str(cfg.get(cfg_key) or "").strip()
    if p:
        return p if os.path.isfile(p) else None
    return own if own and os.path.isfile(own) else None


def _imaginarium_mesh_rs():
    return _external_tool("IMAGINARIUM_AF_MESH", "afMesh",
                          os.path.join(REPO_ROOT, "native", "imaginarium_mesh_rs", "target",
                                       "release", "imaginarium-mesh-rs"))


def _gltfpack():
    return _external_tool("IMAGINARIUM_GLTFPACK", "gltfpack", None) or shutil.which("gltfpack")


def _glb_json(path):
    """The JSON chunk of a GLB as a dict, None when it does not parse: what the LOD and
    compact checks read without a Blender re-import."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(20)
            # GLB: 12-byte header, then the chunk - length at 12:16, type ("JSON") at 16:20
            if len(head) < 20 or head[16:20] != b"JSON":
                return None
            n = struct.unpack("<I", head[12:16])[0]
            return json.loads(fh.read(n).decode("utf-8"))
    except (OSError, ValueError, KeyError, struct.error):
        return None


def _glb_tris(g):
    return sum(g["accessors"][p["indices"]]["count"] // 3
               for m in g.get("meshes", []) for p in m.get("primitives", []) if "indices" in p)


def _head_center_x(ob):
    """Ported from an earlier in-house script (--center head): the most populated
    contiguous run of 2 cm X bins in the 75-86 % height band is the head; its centre becomes
    X = 0 so a staff or shield on one side does not shift Mixamo's symmetry line."""
    co = ml.mesh_arrays(ob.data)["co"]
    z0, h = float(co[:, 2].min()), float(co[:, 2].max() - co[:, 2].min())
    band = co[(co[:, 2] > z0 + 0.75 * h) & (co[:, 2] < z0 + 0.86 * h), 0]
    if not len(band):
        return None
    step = 0.02 * max(h / 1.8, 1e-3)
    bins = {}
    for x in band.tolist():
        k = int(math.floor(x / step))
        bins[k] = bins.get(k, 0) + 1
    runs, cur = [], []
    for b in sorted(bins):
        if cur and b != cur[-1] + 1:
            runs.append(cur)
            cur = []
        cur.append(b)
    runs.append(cur)
    best = max(runs, key=lambda r: sum(bins[b] for b in r))
    return (best[0] + best[-1] + 1) * step / 2


def _images_in_use(objs):
    imgs = []
    for o in ima.meshes(objs):
        for m in o.data.materials:
            if m is None or m.node_tree is None:
                continue
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image is not None and n.image not in imgs:
                    if n.image.size[0] > 0:
                        imgs.append(n.image)
    return imgs


def _export_textures(objs, tex_dir):
    """Write every used map next to the output and rebind the nodes to those files: the OBJ
    exporter references them, and the FBX exporter only embeds images that have a file path
    (glTF imports keep textures packed with an empty path)."""
    os.makedirs(tex_dir, exist_ok=True)
    out, remap = [], {}
    for img in _images_in_use(objs):
        ext = ".jpg" if img.file_format == "JPEG" else ".png"
        path = os.path.join(tex_dir, ml.safe_name(img.name, "texture") + ext)
        if img.file_format not in ("JPEG", "PNG"):
            img.file_format = "PNG"
        img.save(filepath=path, save_copy=True)
        new = bpy.data.images.load(path, check_existing=False)
        new.colorspace_settings.name = img.colorspace_settings.name
        new.alpha_mode = img.alpha_mode
        remap[img] = new
        out.append(path)
    for o in ima.meshes(objs):
        for m in o.data.materials:
            if m is None or m.node_tree is None:
                continue
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image in remap:
                    n.image = remap[n.image]
    return out


def _mixamo_prepare(objs, p, warnings, stats):
    objs = ml.prepare_meshes(objs, warnings)
    if not objs:
        raise ValueError("no meshes to send to Mixamo")
    body = ima.join(objs, name="Body")
    body.data.name = "Body"
    ml.rotate_z([body], float(p.get("rotate_z_deg") or 0.0))
    ima.normalize([body], height=float(p.get("height_m") or 1.8), ground=True, center=True)
    shift = 0.0
    if p.get("mixamo_center", "bbox") == "head":
        cx = _head_center_x(body)
        if cx is not None:
            shift = cx
            for v in body.data.vertices:
                v.co.x -= cx
            body.data.update()
    stats["center_shift_m"] = round(shift, 4)
    ml.clear_custom_normals(body)
    weld = float(p.get("mixamo_weld_m", 1e-4))
    stats["welded_verts"] = ml.merge_by_distance(body, weld) if weld > 0 else 0
    limit = int(p.get("mixamo_max_tris", 50000))
    if ml.tris_of(body) > limit:
        stats["decimation"] = ml.decimate_to(body, limit)
        # decimation trims the extremes a little: restore height and feet on z=0
        lo, hi = ima.world_bbox([body])
        k = float(p.get("height_m") or 1.8) / max(hi.z - lo.z, 1e-6)
        for v in body.data.vertices:
            v.co.x *= k
            v.co.y *= k
            v.co.z = (v.co.z - lo.z) * k
        body.data.update()
    ml.smooth_by_angle(body, 40)
    return [body]


def _base_colour_only(objs):
    """Mixamo only previews the colour map; drop the other maps to keep the upload small."""
    for o in ima.meshes(objs):
        for m in o.data.materials:
            if m is None or m.node_tree is None:
                continue
            keep = ml.image_into(m, "Base Color")
            for n in list(m.node_tree.nodes):
                if n.type == "TEX_IMAGE" and n != keep:
                    m.node_tree.nodes.remove(n)


def _limit_textures(objs, size):
    changed = []
    for img in _images_in_use(objs):
        w, h = img.size
        if w > size or h > size:
            k = size / float(max(w, h))
            img.scale(max(1, int(w * k)), max(1, int(h * k)))
            changed.append(img.name)
    return changed


def _build_lods(out, name, lods, tris_in, req, outputs, stats, warnings, checks):
    """<name>_lodN.glb at the requested triangle fractions (0.7.9 fold wave ticket 56).
    imaginarium-mesh-rs is primary - measured: it hits the fraction exactly on UV-seamed painted
    meshes and carries skins, clips and weights bit-exact (glb.rs, ticket 46); gltfpack
    -si -sp -noq -ac is the no-imaginarium-mesh fallback and lands NEAR the fraction, not on it.
    stats["lods"] is the provenance row: file, target, tool that actually built it."""
    imaginarium_mesh, gltf = _imaginarium_mesh_rs(), _gltfpack()
    stats["lods"] = []
    if not imaginarium_mesh and not gltf:
        warnings.append("lods: neither imaginarium-mesh-rs nor gltfpack found (installer components, or "
                        "IMAGINARIUM_AF_MESH / IMAGINARIUM_GLTFPACK) - no LOD files were written")
        checks.append(ima.check("lods_written", False, "no LOD tool present", severity="warning"))
        return
    for i, frac in enumerate(lods, 1):
        target = max(1, int(round(tris_in * frac)))
        row = {"file": "%s_lod%d.glb" % (name, i), "fraction": frac, "target_tris": target}
        out_lod = ima.out_path(req, row["file"])
        if target >= tris_in:
            row["error"] = "fraction %s of %d triangles leaves nothing to remove" % (frac, tris_in)
            warnings.append("lods: " + row["error"])
            stats["lods"].append(row)
            continue
        if imaginarium_mesh:
            info = {}
            try:
                r = subprocess.run([imaginarium_mesh, "simplify", "--in", out, "--out", out_lod,
                                    "--tris", str(target), "--json"],
                                   capture_output=True, text=True, timeout=600)
                if r.returncode == 0:
                    info = json.loads(r.stdout or "{}")
            except (OSError, ValueError, subprocess.TimeoutExpired):
                info = {}
            if info.get("mode") == "simplify" and os.path.isfile(out_lod):
                row["tris"] = int(info["trianglesAfter"])
                row["tool"] = "imaginarium-mesh-rs"
        if "tool" not in row:
            if not gltf:
                row["error"] = ("imaginarium-mesh-rs %s and gltfpack is not installed"
                                % ("unavailable" if not imaginarium_mesh else "refused"))
                warnings.append("lods: %s - %s skipped" % (row["error"], row["file"]))
                stats["lods"].append(row)
                continue
            try:
                r = subprocess.run([gltf, "-i", out, "-o", out_lod, "-si", repr(frac),
                                    "-sp", "-noq", "-ac"], capture_output=True, timeout=600)
                ok = r.returncode == 0 and os.path.isfile(out_lod)
            except (OSError, subprocess.TimeoutExpired):
                ok = False
            if not ok:
                row["error"] = "both LOD tools failed on %s" % row["file"]
                warnings.append("lods: " + row["error"])
                stats["lods"].append(row)
                continue
            g = _glb_json(out_lod)
            row["tris"] = _glb_tris(g) if g else None
            row["tool"] = "gltfpack -si %s -sp -noq -ac (approx)" % frac
            if imaginarium_mesh:
                warnings.append("lods: imaginarium-mesh-rs refused %s - the gltfpack approximation was "
                                "written instead" % row["file"])
        got = row.get("tris")
        if got == target:
            checks.append(ima.check("lod%d_tris" % i, True, got, target, note=row["tool"]))
        else:
            near = got is not None and abs(got - target) <= max(4, 0.25 * target)
            checks.append(ima.check("lod%d_tris" % i, near, got, target, severity="warning",
                                   note=row["tool"]))
        outputs["lod%d" % i] = os.path.abspath(out_lod)
        stats["lods"].append(row)


def _build_compact(out, name, quantize, req, outputs, stats, warnings, checks):
    """<name>.compact.glb with EXT_meshopt_compression for three.js / Babylon / Unity glTFast
    (0.7.9 fold wave ticket 56). gltfpack is the only tool for this and the MAIN file stays
    plain: Godot 4.5.1 cannot read the compressed form - that is why this is a separate file.
    quantize false drops KHR_mesh_quantization (the meshopt compression stays)."""
    g = _gltfpack()
    if not g:
        warnings.append("compress: gltfpack not found (installer component gltfpack, or "
                        "IMAGINARIUM_GLTFPACK) - no compact file written, the plain output is untouched")
        checks.append(ima.check("compact_written", False, "gltfpack missing", severity="warning"))
        return
    out_c = ima.out_path(req, "%s.compact.glb" % name)
    cmd = [g, "-i", out, "-o", out_c, "-c", "-ac"] + ([] if quantize else ["-noq"])
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=600)
        ok = r.returncode == 0 and os.path.isfile(out_c)
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    if not ok:
        warnings.append("compress: gltfpack failed - no compact file written")
        checks.append(ima.check("compact_written", False, "gltfpack failed", severity="warning"))
        return
    gj = _glb_json(out_c) or {}
    used = sorted(set((gj.get("extensionsUsed") or []) + (gj.get("extensionsRequired") or [])))
    stats["compact"] = {"file": os.path.basename(out_c), "bytes": os.path.getsize(out_c),
                        "tool": "gltfpack -c -ac" + ("" if quantize else " -noq"),
                        "quantize": bool(quantize), "extensions": used}
    outputs["compact"] = os.path.abspath(out_c)
    checks.append(ima.check("compact_meshopt_ext", "EXT_meshopt_compression" in used,
                           used, "EXT_meshopt_compression"))


def run(req):
    p = req["params"]
    warnings = []
    stats = {}
    mixamo = bool(p.get("mixamo"))
    fmt = "fbx" if mixamo else str(p.get("format", "glb")).lower().lstrip(".")
    if fmt not in ("glb", "fbx", "obj"):
        raise ValueError("params.format must be glb, fbx or obj, got %r" % fmt)
    name = ml.safe_name(p.get("name") or "model", "model")
    lods = p.get("lods") or []
    if not isinstance(lods, (list, tuple)) or any(
            not isinstance(f, (int, float)) or not 0 < float(f) < 1 for f in lods):
        raise ValueError("params.lods must be a list of fractions in (0, 1), got %r" % (lods,))

    src_path = ml.input_path(req)
    ima.reset_scene()
    objs = ima.import_any(src_path)
    objs, stats["import_helpers_removed"] = ml.purge_import_helpers(objs)
    if not ml.model_meshes(objs):
        raise ValueError("no mesh objects in %s" % src_path)
    stats["input"] = ml.mesh_metrics(objs)
    stats["input"]["armatures"] = len(ima.armatures(objs))
    stats["input"]["actions"] = len(bpy.data.actions)
    tex_in = ml.texture_report(objs)

    if mixamo:
        objs = _mixamo_prepare(objs, p, warnings, stats)
    else:
        default_place = p.get("height_m") is not None
        ml.rotate_z(objs, float(p.get("rotate_z_deg") or 0.0))
        if (p.get("height_m") or p.get("ground", default_place) or p.get("center", default_place)):
            ima.normalize(objs, height=p.get("height_m"), ground=p.get("ground", default_place),
                         center=p.get("center", default_place))
        if fmt == "obj" and (ima.armatures(objs) or bpy.data.actions):
            warnings.append("OBJ keeps no rig or animation; only the meshes were written")

    out = ima.out_path(req, "%s.%s" % (name, fmt))
    outputs = {}
    has_anim = bool(ima.armatures(objs)) or bool(bpy.data.actions)
    if fmt == "glb":
        outputs["glb"] = ima.export_glb(out, objects=None, animations=has_anim, skins=has_anim)
    elif fmt == "fbx":
        tex_dir = ima.out_path(req, "textures")
        if mixamo:
            _base_colour_only(objs)
            size = int(p.get("texture_max", 2048))
            kw = dict(object_types={"MESH"}, apply_scale_options="FBX_SCALE_ALL",
                      axis_forward="-Z", axis_up="Y", mesh_smooth_type="FACE", bake_anim=False)
            while True:
                stats["textures_scaled"] = _limit_textures(objs, size)
                outputs["textures"] = _export_textures(objs, tex_dir)
                ima.export_fbx(out, objects=objs, mixamo=True, **kw)
                if os.path.getsize(out) <= MIXAMO_UPLOAD_LIMIT or size <= 512:
                    break
                size //= 2
            stats["texture_max"] = size
        else:
            outputs["textures"] = _export_textures(objs, tex_dir)
            ima.export_fbx(out, objects=None, bake_anim=has_anim)
        outputs["fbx"] = os.path.abspath(out)
    else:
        outputs["textures"] = _export_textures(objs, ima.out_path(req, "textures"))
        ima.select_only(ima.meshes(objs))
        bpy.ops.wm.obj_export(filepath=out, export_selected_objects=True, apply_modifiers=True,
                              export_materials=True, export_uv=True, export_normals=True,
                              path_mode="RELATIVE", forward_axis="NEGATIVE_Z", up_axis="Y")
        outputs["obj"] = os.path.abspath(out)
    stats["output"] = ml.mesh_metrics(list(bpy.context.scene.objects))
    stats["bytes"] = os.path.getsize(out)
    stats["orphans_purged"] = ml.purge_orphans()  # originals replaced by the written maps
    outputs["blend"] = ima.save_blend(ima.out_path(req, "converted.blend"))

    # ---------------------------------------------------------------- round trip
    want_tris = stats["output"]["tris"]
    want_h = stats["output"]["size"][2]
    want_meshes = stats["output"]["objects"]
    ima.reset_scene()
    back = ima.import_any(out)
    # the glTF importer adds its bone-shape helper again on re-import; anything else extra
    # (e.g. a helper that slipped into the written file) is counted below
    back, _ = ml.purge_import_helpers(back)
    got = ml.mesh_metrics(back)
    tex_back = ml.texture_report(back)
    stats["roundtrip"] = {"tris": got["tris"], "size": got["size"], "bbox_min": got["bbox_min"],
                          "meshes": got["objects"], "textures": tex_back,
                          "armatures": len(ima.armatures(back))}
    checks = [
        ima.check("roundtrip_tris", abs(got["tris"] - want_tris) <= max(2, 0.01 * want_tris),
                 got["tris"], want_tris),
        ima.check("roundtrip_meshes", got["objects"] == want_meshes, got["objects"], want_meshes),
        ima.check("roundtrip_height", abs(got["size"][2] - want_h) <= max(1e-4, 0.01 * want_h),
                 got["size"][2], round(want_h, 5)),
        ima.check("no_nan_verts", got["nan_verts"] == 0, got["nan_verts"], 0),
    ]
    want_height = float(p.get("height_m") or (1.8 if mixamo else 0.0))
    if want_height > 0:
        checks.append(ima.check("height_matches",
                               abs(got["size"][2] - want_height) <= 1e-3 * want_height,
                               got["size"][2], want_height,
                               note="re-imported height against params.height_m"))
    grounded = True if mixamo else p.get("ground", p.get("height_m") is not None)
    if grounded:
        checks.append(ima.check("grounded",
                               abs(got["bbox_min"][2]) <= 1e-4 * max(got["size"][2], 1e-6),
                               got["bbox_min"][2], 0.0, note="re-imported lowest point"))
    had_tex = any(min(v.get("base_color", [0])) > 0 for v in tex_in.values())
    if had_tex:
        kept = any(min(v.get("base_color", [0])) > 0 for v in tex_back.values())
        checks.append(ima.check("roundtrip_base_color", kept, kept, True,
                               note="base colour map found again after re-import"))
    if mixamo:
        checks.append(ima.check("mixamo_upload_size", stats["bytes"] <= MIXAMO_UPLOAD_LIMIT,
                               stats["bytes"], MIXAMO_UPLOAD_LIMIT, severity="warning"))
        checks.append(ima.check("mixamo_single_mesh", len(ima.meshes(back)) == 1,
                               len(ima.meshes(back)), 1))
    if stats["input"]["armatures"] and fmt != "obj" and not mixamo:
        checks.append(ima.check("roundtrip_armature", len(ima.armatures(back)) >= 1,
                               len(ima.armatures(back)), 1))
    if lods or p.get("compress"):
        if fmt != "glb":
            warnings.append("lods and compress apply to the glb output; format=%s wrote none" % fmt)
        else:
            stats["tools"] = {"imaginarium_mesh_rs": _imaginarium_mesh_rs() or "", "gltfpack": _gltfpack() or ""}
            if lods:
                _build_lods(out, name, [float(f) for f in lods], want_tris, req, outputs,
                            stats, warnings, checks)
            if p.get("compress"):
                _build_compact(out, name, bool(p.get("quantize", True)), req, outputs, stats,
                               warnings, checks)
    stats["format"] = fmt
    stats["mixamo"] = mixamo
    return {"outputs": outputs, "stats": stats, "checks": checks, "warnings": warnings}
