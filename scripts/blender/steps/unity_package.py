"""unity_package — the Unity package of a GLB (FBX + textures + af_unity.json) for the AstraForge
importer (unity/com.astraforge.unity), which assembles prefabs itself; validated in Unity -batchmode.

inputs.glb       the asset (sockets per contract §6, clips '-loop' per §7) — as for godot_package
inputs.manifest  optional asset.json (kind, fx)
inputs.sprites   optional sprites.json from render_sprites (iso8 / pixel / custom): sheets go to
                 sprites/, the importer builds Sprites, 8-direction AnimationClips and an
                 AnimatorController. Without inputs.glb the package is sprites only.
params:
  asset_id       snake_case ASCII (required)
  profile        'unity' (default)
  pipeline       'urp' (default) | 'builtin' | 'hdrp' — a README hint only; the importer takes the
                 shaders of the project's active pipeline
  unity_forward  '+Z' (default: the prefab looks along transform.forward, a -Z GLB nose turns 180 deg)
                 | 'keep' (as in the GLB)
  rig            'auto' (Mixamo / Unity humanoid bone names -> humanoid, other skeletons -> generic) |
                 'humanoid' | 'generic'
  collider       'auto' (rigged: capsule; a tree: trunk capsule; the rest: box) | box | capsule |
                 convex | mesh | none
  lod            true (default): static meshes of at least lod_min_tris triangles get decimated
                 LOD1/LOD2 copies (lod_ratios); wind meshes are shared by all levels; lod_screen =
                 LODGroup transition heights
  wind           'auto' (materials named Leaves/Leaf/Foliage or with the custom property af_wind) | 'off'
  wind_strength, wind_speed, flutter, wind_direction   as leaves_wind.gdshader of the level demo
  fx, fx_auto_scale   as godot_package (fx_presets.json; Particle System in Unity)
  autoplay       the default clip of the AnimatorController (idle, else the first looping clip)
  validate       run Unity -batchmode on the check project (default true when Unity is found);
                 unity: editor override; unity_project: check project (ASTRA_UNITY / ASTRA_UNITY_PROJECT)
outputs: package (folder), fbx, manifest (af_unity.json), readme, unity_check (json), unity_shots (folder)
"""
import json
import math
import os
import re
import shutil

import bpy
import numpy as np
from mathutils import Vector

import af_common as af
from steps import _export_lib as xl
from steps import _unity_lib as ul
from steps import godot_package as gp

FORMAT = "astraforge-unity-package/1"
WIND_RE = re.compile(r"(^|[_\s.-])(leaves|leaf|foliage)", re.I)
# Unity's humanoid auto-mapper understands Mixamo names (the 'mixamorig:' namespace is stripped)
HUMANOID_CORE = {"Hips", "Spine", "Head", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftFoot",
                 "RightFoot", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand"}
LOD_RATIOS = (0.5, 0.2)
LOD_SCREEN = (0.5, 0.18, 0.04)
WIND_DEFAULTS = {"wind_strength": 0.07, "wind_speed": 1.4, "flutter": 0.025, "wind_direction": [1.0, 0.0, 0.35]}


# --------------------------------------------------------------------------- axes

def to_unity(v):
    """Blender world vector -> Unity behind the FBX export below plus ModelImporter.bakeAxisConversion:
    (x, z, y) (measured 31.10.2026 on Unity 6000.0.64f1: corners of an asymmetric tree, socket positions).
    A character along Blender -Y (glTF +Z) ends up along Unity -Z, a ship nose at Blender +Y (glTF -Z)
    along Unity +Z."""
    return [float(v[0]) + 0.0, float(v[2]) + 0.0, float(v[1]) + 0.0]


def turn(v, rotate):
    """The model child turned 180 deg about Y (unity_forward +Z for a -Z GLB): (x, y, z) -> (-x, y, -z)."""
    return [-v[0] + 0.0, v[1], -v[2] + 0.0] if rotate else list(v)


def _r(v, n=4):
    return [round(float(x), n) + 0.0 for x in v]


# --------------------------------------------------------------------------- materials

def _bsdf(mat):
    if not mat or not mat.node_tree:
        return None
    out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if out and out.inputs["Surface"].is_linked:
        n = out.inputs["Surface"].links[0].from_node
        if n.type == "BSDF_PRINCIPLED":
            return n
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def _upstream(sock, depth=0):
    """What feeds a socket (breadth first): [(node, output socket name)]."""
    out = []
    if depth > 8 or not sock.is_linked:
        return out
    for ln in sock.links:
        n = ln.from_node
        out.append((n, ln.from_socket.name))
        for i in n.inputs:
            out.extend(_upstream(i, depth + 1))
    return out


def _image_of(sock):
    for n, _s in _upstream(sock):
        if n.type == "TEX_IMAGE" and n.image is not None:
            return n.image
    return None


def _pixels(img):
    """uint8 (H, W, 4) top-down; byte images give their stored (sRGB) values."""
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    return np.rint(np.clip(buf.reshape(h, w, 4), 0, 1) * 255.0).astype(np.uint8)[::-1].copy()


def _safe(name):
    s = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._") or "tex"
    return s[:64]


class TextureWriter:
    """PNG files of the package: one write per key, path cached."""

    def __init__(self, folder):
        self.folder = folder
        self.done = {}
        os.makedirs(folder, exist_ok=True)

    def write(self, key, make):
        if key not in self.done:
            name = "%s.png" % _safe(key)
            xl.save_png(os.path.join(self.folder, name), make())
            self.done[key] = "textures/" + name
        return self.done[key]


def analyze_material(mat, tex, objs_with_colors, wind_mode):
    """The Unity description of a Blender (glTF-imported) material, its textures written as PNG."""
    m = {"name": mat.name, "base_map": "", "normal_map": "", "mask_map": "", "emission_map": "",
         "base_color": [1.0, 1.0, 1.0, 1.0], "emission_color": [0.0, 0.0, 0.0], "metallic": 0.0,
         "smoothness": 0.5, "normal_scale": 1.0, "alpha": "opaque", "cutoff": 0.5,
         "double_sided": not mat.use_backface_culling, "vertex_color": False, "wind": False}
    b = _bsdf(mat)
    if b is None:
        m["base_color"] = _r(list(mat.diffuse_color))
        return m
    bc = b.inputs["Base Color"]
    img = _image_of(bc)
    if not bc.is_linked:
        m["base_color"] = _r(list(bc.default_value))
    if any(n.type == "VERTEX_COLOR" or n.type == "ATTRIBUTE" for n, _s in _upstream(bc)):
        m["vertex_color"] = mat.name in objs_with_colors
    alpha = b.inputs["Alpha"]
    if not alpha.is_linked:
        m["base_color"][3] = round(float(alpha.default_value), 4)
    base_arr = None
    if img is not None:
        base_arr = _pixels(img)
        if alpha.is_linked:
            ups = _upstream(alpha)
            maths = [n for n, _s in ups if n.type == "MATH"]
            a = base_arr[..., 3].astype(np.float32) / 255.0
            mid = float(np.mean((a > 0.08) & (a < 0.92)))
            # a comparison in the chain, a nearly binary alpha or a non-blended surface: a cutout
            if maths or mid < 0.04 or getattr(mat, "surface_render_method", "DITHERED") != "BLENDED":
                m["alpha"] = "cutout"
                for n in maths:
                    if n.operation in ("LESS_THAN", "GREATER_THAN") and not n.inputs[1].is_linked:
                        thr = float(n.inputs[1].default_value)
                        if 0.0 < thr < 1.0:
                            m["cutoff"] = round(thr, 3)
            else:
                m["alpha"] = "blend"
        arr = base_arr
        m["base_map"] = tex.write("%s_base" % img.name, lambda: arr)
    elif alpha.is_linked or float(alpha.default_value) < 0.999:
        m["alpha"] = "blend"
    # metallic / roughness (glTF: G roughness, B metallic) -> the Unity mask: R metal, G occlusion, B 0, A smoothness
    met, rough = b.inputs["Metallic"], b.inputs["Roughness"]
    m["metallic"] = round(float(met.default_value), 4) if not met.is_linked else 1.0
    m["smoothness"] = round(1.0 - float(rough.default_value), 4) if not rough.is_linked else 1.0
    mr = _image_of(rough) or _image_of(met)
    if mr is not None:
        def mask(img=mr, met_linked=met.is_linked, rough_linked=rough.is_linked,
                 met_v=float(met.default_value), rough_v=float(rough.default_value)):
            p = _pixels(img)
            out = np.zeros_like(p)
            out[..., 0] = p[..., 2] if met_linked else int(round(met_v * 255))
            out[..., 1] = 255
            out[..., 3] = 255 - p[..., 1] if rough_linked else int(round((1.0 - rough_v) * 255))
            return out
        m["mask_map"] = tex.write("%s_mask" % mr.name, mask)
    nrm = b.inputs["Normal"]
    if nrm.is_linked:
        nm_node = next((n for n, _s in _upstream(nrm) if n.type == "NORMAL_MAP"), None)
        nimg = _image_of(nrm)
        if nimg is not None:
            m["normal_map"] = tex.write("%s_normal" % nimg.name, lambda: _pixels(nimg))
            if nm_node is not None and not nm_node.inputs["Strength"].is_linked:
                m["normal_scale"] = round(float(nm_node.inputs["Strength"].default_value), 4)
    ec = b.inputs.get("Emission Color")
    es = b.inputs.get("Emission Strength")
    strength = float(es.default_value) if es is not None and not es.is_linked else 1.0
    if ec is not None:
        eimg = _image_of(ec)
        if eimg is not None:
            m["emission_map"] = tex.write("%s_emission" % eimg.name, lambda: _pixels(eimg))
            m["emission_color"] = [round(strength, 4)] * 3
        elif not ec.is_linked and strength > 0:
            col = [float(c) * strength for c in list(ec.default_value)[:3]]
            if max(col) > 1e-4:
                m["emission_color"] = _r(col)
    if wind_mode != "off" and (WIND_RE.search(mat.name) or mat.get("af_wind")):
        m["wind"] = True
        if m["alpha"] == "opaque" and base_arr is not None:
            m["alpha"] = "cutout"
    return m


# --------------------------------------------------------------------------- scene helpers

def _arm_rest(arms, rest=True):
    saved = [(a, a.data.pose_position) for a in arms]
    for a in arms:
        a.data.pose_position = "REST" if rest else a.data.pose_position
    bpy.context.view_layer.update()
    return saved


def _arm_restore(saved):
    for a, pos in saved:
        a.data.pose_position = pos
    bpy.context.view_layer.update()


def _rig_type(arms, mode):
    if not arms:
        return "none", None
    if mode in ("humanoid", "generic"):
        return mode, None
    names = {b.name.split(":")[-1] for a in arms for b in a.data.bones}
    hit = HUMANOID_CORE & names
    return ("humanoid" if len(hit) >= len(HUMANOID_CORE) - 1 else "generic"), sorted(HUMANOID_CORE - names)


def _select(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def _is_skinned(o):
    return any(md.type == "ARMATURE" for md in o.modifiers) or (o.parent is not None and o.parent.type == "ARMATURE")


def _split_wind(meshes, wind_mats):
    """A static mesh that mixes wind and solid materials is split by material (LOD shares the wind part)."""
    out = []
    for o in meshes:
        mats = [s.material.name for s in o.material_slots if s.material]
        if _is_skinned(o) or len(mats) < 2 or not any(n in wind_mats for n in mats) \
                or all(n in wind_mats for n in mats):
            out.append(o)
            continue
        before = set(bpy.data.objects)
        _select([o])
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")
        out.append(o)
        out.extend(x for x in bpy.data.objects if x not in before)
    return out


def _mesh_tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def _ensure_wind_uv(o, z_lo, z_hi):
    """Leaf cards need UV2 = (wind weight, phase). glTF TEXCOORD_1 of the level demo trees already holds it;
    other meshes get weight = height in the crown and phase = a hash of the position."""
    me = o.data
    if len(me.uv_layers) >= 2:
        return False
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.new(name="wind")
    mw = o.matrix_world
    span = max(z_hi - z_lo, 1e-4)
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            w = min(1.0, max(0.0, (co.z - z_lo) / span)) * 0.7 + 0.3
            ph = (math.sin(co.x * 12.9898 + co.y * 78.233 + co.z * 37.719) * 43758.5453) % 1.0
            uv.data[li].uv = (w, ph)
    return True


def _make_lods(meshes, wind_mats, ratios, min_tris):
    """Decimated copies '<name>__LOD1', '__LOD2' of the static solid meshes. ([[names per level]], tris)."""
    static = [o for o in meshes if not _is_skinned(o)]
    if not static or len(static) != len(meshes):
        return None, "skinned meshes: no LOD"
    total = sum(_mesh_tris(o) for o in static)
    if total < min_tris:
        return None, "%d tris < lod_min_tris %d" % (total, min_tris)
    levels = [[o.name for o in static]]
    tris = [total]
    for li, ratio in enumerate(ratios, start=1):
        names, t = [], 0
        for o in static:
            mats = [s.material.name for s in o.material_slots if s.material]
            if any(n in wind_mats for n in mats) or _mesh_tris(o) < 64:
                names.append(o.name)                       # cards / tiny parts: the same renderer in every level
                t += _mesh_tris(o)
                continue
            c = o.copy()
            c.data = o.data.copy()
            c.name = "%s__LOD%d" % (o.name, li)
            for col in o.users_collection:
                col.objects.link(c)
            md = c.modifiers.new("af_lod", "DECIMATE")
            md.ratio = float(ratio)
            md.use_collapse_triangulate = True
            _select([c])
            bpy.ops.object.modifier_apply(modifier=md.name)
            names.append(c.name)
            t += _mesh_tris(c)
        levels.append(names)
        tris.append(t)
    return levels, tris


def _collider(mode, meshes, wind_mats, rig, rotate, kind):
    """The collider in the prefab root's space (Unity axes, metres)."""
    pts = xl.world_points(meshes)
    if not len(pts) or mode == "none":
        return {"type": "none"}
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    solid = [o for o in meshes if not any(s.material and s.material.name in wind_mats for s in o.material_slots)
             and "crown" not in o.name.lower()]
    tree = bool(wind_mats) and bool(solid) and len(solid) < len(meshes)
    if mode == "auto":
        mode = "capsule" if rig != "none" or tree else "box"

    def ubox(a, b):
        ua, ub = turn(to_unity(a), rotate), turn(to_unity(b), rotate)
        center = [(x + y) / 2.0 for x, y in zip(ua, ub)]
        size = [abs(x - y) for x, y in zip(ua, ub)]
        return center, size

    if mode in ("mesh", "convex"):
        return {"type": mode, "nodes": [o.name for o in (solid or meshes)]}
    if mode == "box":
        c, s = ubox(lo, hi)
        return {"type": "box", "center": _r(c), "size": _r(s)}
    # capsule
    if tree:
        sp = xl.world_points(solid)
        z0, z1 = float(sp[:, 2].min()), float(sp[:, 2].max())
        low = sp[sp[:, 2] < z0 + 0.25 * (z1 - z0)]
        axis = np.median(low[:, :2], axis=0)
        rad = float(np.percentile(np.linalg.norm(low[:, :2] - axis, axis=1), 90)) if len(low) else 0.2
        rad = max(0.05, min(rad, 0.25 * (z1 - z0)))
        c = turn(to_unity([axis[0], axis[1], (z0 + z1) / 2.0]), rotate)
        return {"type": "capsule", "center": _r(c), "radius": round(rad, 4), "height": round(z1 - z0, 4),
                "direction": 1, "note": "trunk"}
    c, s = ubox(lo, hi)
    d = int(np.argmax(s)) if kind not in ("humanoid",) and rig != "humanoid" else 1
    others = [s[i] for i in range(3) if i != d]
    rad = 0.5 * max(others) * 0.85
    return {"type": "capsule", "center": _r(c), "radius": round(rad, 4), "height": round(max(s[d], 2 * rad), 4),
            "direction": d}


# --------------------------------------------------------------------------- FX (Godot preset -> Unity data)

def _pair(v, default):
    if v is None:
        return [float(default), float(default)]
    if isinstance(v, (int, float)):
        return [float(v), float(v)]
    v = list(v) + [v[-1]] * (2 - len(v))
    return [float(v[0]), float(v[1])]


def _gltf_to_unity_local(v):
    """glTF/Godot vector -> Unity: glTF (x, y, z) = Blender (x, -z, y) -> to_unity -> (x, y, -z)."""
    return [float(v[0]) + 0.0, float(v[1]) + 0.0, -float(v[2]) + 0.0]


def fx_unity(pid, preset_name, p):
    em = p.get("emission") or {"shape": "point"}
    light = p.get("light") or None
    color_ramp = []
    for t, col in p.get("color_ramp", []) or [[0, [1, 1, 1, 1]], [1, [1, 1, 1, 0]]]:
        col = list(col) + [1.0] * (4 - len(col))
        color_ramp.append({"t": float(t), "r": float(col[0]), "g": float(col[1]), "b": float(col[2]),
                           "a": float(col[3])})
    return {"id": pid, "preset": preset_name, "amount": int(p.get("amount", 16)),
            "lifetime": float(p.get("lifetime", 1.0)), "one_shot": bool(p.get("one_shot", False)),
            "autostart": bool(p.get("autostart", not p.get("one_shot", False))),
            "explosiveness": float(p.get("explosiveness", 0.0)), "local_coords": bool(p.get("local_coords", False)),
            "direction": _gltf_to_unity_local(p.get("direction", [0, 1, 0])), "spread": float(p.get("spread", 45)),
            "velocity": _pair(p.get("velocity"), 1.0), "gravity": _gltf_to_unity_local(p.get("gravity", [0, -9.8, 0])),
            "damping": _pair(p.get("damping"), 0.0), "scale": _pair(p.get("scale"), 1.0),
            "scale_curve": [{"t": float(t), "v": float(v)} for t, v in (p.get("scale_curve") or [])],
            "color_ramp": color_ramp, "emission_shape": str(em.get("shape", "point")),
            "radius": float(em.get("radius", 0.0)), "inner_radius": float(em.get("inner_radius", 0.0)),
            "height": float(em.get("height", 0.0)),
            "extents": [abs(x) for x in _gltf_to_unity_local(em.get("extents", [0, 0, 0]))],
            "ring_axis": _gltf_to_unity_local(em.get("axis", [0, 1, 0])),
            "quad_size": float(p.get("quad_size", 0.2)), "texture": str(p.get("texture", "soft")),
            "blend": str(p.get("blend", "add")), "turbulence": float(p.get("turbulence", 0.0)),
            "angle": _pair(p.get("angle"), 0.0), "angular_velocity": _pair(p.get("angular_velocity"), 0.0),
            "tangential_accel": _pair(p.get("tangential_accel"), 0.0),
            "radial_accel": _pair(p.get("radial_accel"), 0.0),
            "has_light": light is not None,
            "light_color": [float(c) for c in (light or {}).get("color", [1, 1, 1])][:3],
            "light_energy": float((light or {}).get("energy", 1.0)),
            "light_range": float((light or {}).get("range", 1.0)),
            "scale_factor": float(p.get("_scale", 1.0))}


def _socket_frames(info, arms):
    """Rest-pose world matrices (3x3) and locations of every socket node."""
    saved = _arm_rest(arms)
    out = {}
    for s in info["sockets"]:
        o = bpy.data.objects.get(s["node"])
        if o is not None:
            out[s["name"]] = (o.matrix_world.to_3x3().copy(), o.matrix_world.translation.copy())
    _arm_restore(saved)
    return out


def _fx_frame(m3, rotate, emit_axis=None):
    """The Unity root-space (up, forward) of an FX object on a socket so that its local axes are the
    socket's glTF axes in Unity terms (glTF (x, y, z) -> Unity (x, y, -z)): +Y = the socket 'out'
    (Blender local +Z) or the thruster exhaust axis, +Z = Blender local +Y (glTF -Z: what a -Z emitter fires along)."""
    if emit_axis is not None:
        up_b = m3 @ Vector((emit_axis[0], -emit_axis[2], emit_axis[1]))
    else:
        up_b = m3 @ Vector((0.0, 0.0, 1.0))
    fwd_b = m3 @ Vector((0.0, 1.0, 0.0))
    up, fwd = Vector(turn(to_unity(up_b), rotate)), Vector(turn(to_unity(fwd_b), rotate))
    if up.length < 1e-9:
        up = Vector((0, 1, 0))
    up.normalize()
    fwd = fwd - up * fwd.dot(up)
    if fwd.length < 1e-6:
        fwd = Vector((0, 0, 1)) if abs(up.z) < 0.9 else Vector((1, 0, 0))
        fwd = fwd - up * fwd.dot(up)
    fwd.normalize()
    return _r(up, 5), _r(fwd, 5)


# --------------------------------------------------------------------------- sprites

def sprites_unity(sp, pixel):
    clips = []
    for name, c in (sp.get("clips") or {}).items():
        views = []
        for d, v in (c.get("views") or {}).items():
            views.append({"dir": d, "sheet": "sprites/" + v["sheet"],
                          "rects": [{"x": int(r[0]), "y": int(r[1]), "w": int(r[2]), "h": int(r[3])}
                                    for r in v.get("rects", [])]})
        clips.append({"name": name, "loop": bool(c.get("loop")), "fps": float(c.get("fps", 12)), "views": views})
    cell = sp.get("cell") or [0, 0]
    anchor = sp.get("anchor") or [0, 0]
    return {"ppu": float(sp.get("px_per_meter", 100.0)), "pixel": bool(pixel), "cell_w": int(cell[0]),
            "cell_h": int(cell[1]), "anchor_x": float(anchor[0]), "anchor_y": float(anchor[1]),
            "elevation_deg": float(sp.get("elevation_deg", 30.0)), "clips": clips,
            "sheets": ["sprites/" + s for s in sp.get("sheets", [])]}


# --------------------------------------------------------------------------- FBX

def _rest_pose(arms):
    """No active action and identity pose bones: the FBX node transforms (Unity's default pose of the prefab)
    are the rest pose; bake_anim_use_all_actions still writes every action as its own take."""
    for a in arms:
        if a.animation_data is not None:
            for tr in a.animation_data.nla_tracks:
                tr.mute = True
            a.animation_data.action = None
        for pb in a.pose.bones:
            pb.location = (0.0, 0.0, 0.0)
            pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
            pb.rotation_euler = (0.0, 0.0, 0.0)
            pb.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def export_fbx(path, objs, animated):
    _rest_pose([o for o in objs if o.type == "ARMATURE"])
    _select(objs)
    bpy.ops.export_scene.fbx(
        filepath=path, use_selection=True, object_types={"ARMATURE", "MESH", "EMPTY"},
        apply_unit_scale=True, apply_scale_options="FBX_SCALE_UNITS", global_scale=1.0,
        axis_forward="-Z", axis_up="Y", bake_space_transform=False, use_mesh_modifiers=True,
        mesh_smooth_type="FACE", use_tspace=False, colors_type="SRGB", use_custom_props=True,
        add_leaf_bones=False, primary_bone_axis="Y", secondary_bone_axis="X", use_armature_deform_only=False,
        armature_nodetype="NULL", bake_anim=animated, bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False, bake_anim_use_all_actions=animated,
        bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
        path_mode="STRIP", embed_textures=False)
    return path


# --------------------------------------------------------------------------- README

def _readme(pkg, rep):
    m = pkg
    lines = ["# %s — Unity package (AstraForge Forge)" % m["asset_id"], "",
             "Made by the `unity_package` step. Put the folder into the `Assets/` of a Unity project with the",
             "`com.astraforge.unity` package — the importer builds the prefab `%s.prefab` itself" % m["asset_id"],
             "(or run `node scripts/unity/af_unity_send.mjs --project <project> <this folder>`).", "",
             "## Contents", "", "| File | What |", "|---|---|"]
    if m["model"]:
        lines.append("| `%s` | FBX model: 1 m = 1 Unity unit, Y up%s |" % (
            m["model"], ", clips duplicated (takes)" if m["clips"] else ""))
        lines.append("| `textures/*.png` | material textures (base colour, normals, metal/smoothness mask, emission) |")
    if m["fx"]:
        lines.append("| `fx/textures/*.png` | particle textures |")
    if m["sprites"]["clips"]:
        lines.append("| `sprites/*.png` | sprite sheets (%d px/m = Pixels Per Unit) |" % m["sprites"]["ppu"])
    lines += ["| `af_unity.json` | the passport for the importer |", "", "## What the importer builds", ""]
    if m["model"]:
        lines.append("- the prefab `%s.prefab`: the model looks along `transform.forward` (+Z)%s;" % (
            m["asset_id"], ", the `model` node is turned 180 deg" if m["model_rotation_y"] else ""))
        lines.append("- skeleton: **%s**%s;" % (m["rig"], " (an Avatar from this model)" if m["rig"] != "none" else ""))
        if m["clips"]:
            lines.append("- clips: %s; the controller `%s_Animator.controller`, first state `%s`;" % (
                ", ".join("`%s`%s" % (c["name"], " (loop)" if c["loop"] else "") for c in m["clips"]),
                m["asset_id"], m["default_clip"]))
        lines.append("- materials: URP Lit (Built-in — Standard, HDRP — HDRP/Lit); leaves and vertex colour — "
                     "the `AstraForge/Foliage` shader (wind in URP and Built-in, in HDRP — HDRP/Lit without wind);")
        col = m["collider"]
        lines.append("- collider: %s;" % col["type"])
        if m["lod"]["levels"]:
            lines.append("- LOD: %d levels, triangles %s;" % (len(m["lod"]["levels"]),
                                                              " / ".join(str(t) for t in m["lod"]["tris"])))
        if m["sockets"]:
            lines.append("- sockets: %s (the `AFSockets` component);" % ", ".join("`%s`" % s["name"] for s in m["sockets"]))
        if m["fx"]:
            lines.append("- effects (Particle System): %s;" % ", ".join(
                "`%s` -> `%s`" % (b["preset"], b["socket"]) for b in m["fx"]))
    if m["sprites"]["clips"]:
        lines.append("- sprites: the `%s_sprite.prefab` (SpriteRenderer + 8-direction Animator, `DirX`/`DirY` "
                     "parameters, the `AFSprite8Dir` component), clips %s." % (
                         m["asset_id"], ", ".join(c["name"] for c in m["sprites"]["clips"])))
    if rep:
        lines += ["", "## Unity %s check (batchmode)" % (rep.get("unity") or ""), ""]
        r = rep.get("result") or {}
        a = next((x for x in (r.get("assets") or []) if x.get("asset_id") == m["asset_id"]), None)
        if a:
            for c in a.get("checks", []):
                lines.append("- %s `%s`: %s" % ("OK" if c.get("ok") else "FAIL", c.get("name"), c.get("value")))
        else:
            lines.append("- not checked: %s" % (rep.get("error") or "no report"))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- run

def run(req):
    p = req["params"]
    inputs = req["inputs"]
    warnings, checks = [], []
    asset_id = p.get("asset_id")
    if not asset_id or not xl.ASSET_ID_RE.match(asset_id):
        raise ValueError("params.asset_id must be snake_case ASCII (^[a-z][a-z0-9]*(_[a-z0-9]+)*$): %r" % asset_id)
    glb = inputs.get("glb") or inputs.get("mesh")
    if glb and (not os.path.isfile(glb) or not glb.lower().endswith(".glb")):
        raise ValueError("inputs.glb must be an existing .glb file: %r" % glb)
    if not glb and not inputs.get("sprites"):
        raise ValueError("unity_package needs inputs.glb or inputs.sprites")
    manifest = {}
    if inputs.get("manifest"):
        with open(inputs["manifest"], "r", encoding="utf-8-sig") as fh:
            manifest = json.load(fh)
    kind = manifest.get("kind") or p.get("kind")
    pkg_dir = af.out_path(req, asset_id)
    if os.path.isdir(pkg_dir):
        shutil.rmtree(pkg_dir)
    os.makedirs(pkg_dir)
    pkg = {"format": FORMAT, "asset_id": asset_id, "profile": p.get("profile", "unity"), "kind": kind or "",
           "generator": "astraforge-forge/unity_package", "pipeline_hint": p.get("pipeline", "urp"),
           "model": "", "rig": "none", "missing_humanoid_bones": [], "model_rotation_y": 0.0,
           "source_forward": "", "size_m": [0, 0, 0], "bounds_min": [0, 0, 0], "bounds_max": [0, 0, 0],
           "tris": 0, "materials": [], "clips": [], "default_clip": "", "sockets": [],
           "lod": {"levels": [], "screen": [], "tris": []}, "collider": {"type": "none"},
           "fx": [], "fx_presets": [], "sprites": {"ppu": 100.0, "pixel": False, "clips": [], "sheets": []},
           "size_gltf_m": [0, 0, 0]}
    stats = {"asset_id": asset_id}
    fbx_path = None

    if glb:
        info = gp._inspect(glb)                  # leaves the GLB imported in the scene
        objs = [o for o in bpy.data.objects]
        arms = [o for o in objs if o.type == "ARMATURE"]
        meshes = xl.render_meshes(objs)
        src_fwd, fwd_from, guessed = gp._source_forward(p, manifest, "godot", info)
        if guessed:
            warnings.append("source_forward %s %s; pass params.kind or inputs.manifest" % (src_fwd, fwd_from))
        # Unity looks along +Z: a +Z GLB (characters, creatures, items) arrives looking along Unity -Z (to_unity)
        rotate = p.get("unity_forward", "+Z") == "+Z" and src_fwd == "+Z"
        rig, missing = _rig_type(arms, p.get("rig", "auto"))
        if rig == "generic" and missing is not None and len(missing) < len(HUMANOID_CORE) // 2:
            warnings.append("skeleton looks almost humanoid but misses %s: imported as Generic" % missing)

        # materials
        wind_mode = p.get("wind", "auto")
        with_colors = set()
        for o in meshes:
            if o.data.color_attributes:
                with_colors.update(s.material.name for s in o.material_slots if s.material)
        tex = TextureWriter(os.path.join(pkg_dir, "textures"))
        mats, seen = [], set()
        for o in meshes:
            for s in o.material_slots:
                if s.material and s.material.name not in seen:
                    seen.add(s.material.name)
                    mats.append(analyze_material(s.material, tex, with_colors, wind_mode))
        for m in mats:
            if m["wind"]:
                for k, dv in WIND_DEFAULTS.items():
                    m[k] = p.get(k, dv)
                m["wind_direction"] = _gltf_to_unity_local(m["wind_direction"])     # world direction, glTF axes
        wind_mats = {m["name"] for m in mats if m["wind"]}
        empty_slots = [o.name for o in meshes if not any(s.material for s in o.material_slots)]
        if empty_slots:
            warnings.append("meshes without a material get the pipeline's default: %s" % empty_slots[:6])

        # wind UV2
        if wind_mats:
            meshes = _split_wind(meshes, wind_mats)
            pts = xl.world_points(meshes)
            z_lo, z_hi = float(pts[:, 2].min()), float(pts[:, 2].max())
            made = [o.name for o in meshes if any(s.material and s.material.name in wind_mats for s in o.material_slots)
                    and _ensure_wind_uv(o, z_lo + 0.3 * (z_hi - z_lo), z_hi)]
            if made:
                warnings.append("wind weights generated (UV2 = height, phase) for %s" % made)

        # size / bounds in Unity axes (rest pose, deformed vertices)
        saved = _arm_rest(arms)
        pts = xl.world_points(meshes)
        _arm_restore(saved)
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        ua, ub = turn(to_unity(lo), rotate), turn(to_unity(hi), rotate)
        bmin = [min(a, b) for a, b in zip(ua, ub)]
        bmax = [max(a, b) for a, b in zip(ua, ub)]

        # sockets
        frames = _socket_frames(info, arms)
        sockets = []
        for s in info["sockets"]:
            fr = frames.get(s["name"])
            sockets.append({"name": s["name"], "node": s["node"], "kind": str(s.get("kind") or ""),
                            "bone": s.get("parent_bone") or "",
                            "position": _r(turn(to_unity(fr[1]), rotate)) if fr else [0, 0, 0]})
        bad = [s["name"] for s in sockets if not gp.SOCKET_RE.match(s["name"])]
        checks.append(af.check("socket_names_snake_ascii", not bad, bad, [], severity="warning"))

        # FX (the same bindings and auto scale as godot_package)
        gp.resolve_thruster_axes(info, src_fwd, warnings)
        with open(xl.FX_PRESETS_PATH, "r", encoding="utf-8") as fh:
            presets = json.load(fh)["presets"]
        sock_info = {s["name"]: s for s in info["sockets"]}
        fx_list = p.get("fx", manifest.get("fx", [])) or []
        variants, fx_bind, unknown, missing_s, fx_tex = {}, [], [], [], set()
        per = {}
        for b in fx_list:
            preset, sock = b.get("preset"), b.get("socket")
            if preset not in presets:
                unknown.append(preset)
                continue
            if sock not in sock_info:
                missing_s.append(sock)
                continue
            bparams = b.get("params") or {}
            if "scale" in bparams:
                k, k_src = float(bparams["scale"]), "params.scale"
            elif p.get("fx_auto_scale", True):
                k, k_src = xl.fx_auto_scale(presets[preset], sock_info.get(sock), info["longest_m"])
            else:
                k, k_src = 1.0, "preset native size"
            merged = xl.merge_fx(presets[preset], bparams, scale=k)
            key = json.dumps(merged, sort_keys=True)
            if key not in variants:
                n = sum(1 for v in variants.values() if v.startswith(preset))
                vid = preset if n == 0 else "%s_%d" % (preset, n + 1)
                variants[key] = vid
                pkg["fx_presets"].append(fx_unity(vid, preset, merged))
                fx_tex.add(str(merged.get("texture", "soft")))
            si = sock_info[sock]
            emit = si.get("exhaust_axis") if gp.is_thruster_socket(si) and gp._emits_up(merged.get("direction")) else None
            fr = frames.get(sock)
            up, fwd = _fx_frame(fr[0], rotate, emit) if fr else ([0, 1, 0], [0, 0, 1])
            cnt = per.setdefault((sock, preset), 0) + 1
            per[(sock, preset)] = cnt
            fx_bind.append({"preset": preset, "fx": variants[key], "socket": sock,
                            "node_name": "fx_%s" % preset if cnt == 1 else "fx_%s_%d" % (preset, cnt),
                            "up": up, "forward": fwd, "one_shot": bool(merged.get("one_shot", False)),
                            "scale": k, "scale_source": k_src})
        for t in sorted(fx_tex):
            xl.save_png(os.path.join(pkg_dir, "fx", "textures", "%s.png" % t), xl.make_fx_texture(t))
        pkg["fx"] = fx_bind
        checks.append(af.check("fx_presets_known", not unknown, unknown, []))
        checks.append(af.check("fx_sockets_exist", not missing_s, missing_s, []))

        # clips
        clips = []
        for c in info["clips"]:
            clips.append({"take": c["name"], "name": xl.safe_name(c["base"]) if c["base"] else c["name"],
                          "loop": bool(c["loop"] or c["base"].lower() in ("idle", "walk", "run")),
                          "first": float(c["frames"][0]), "last": float(c["frames"][1]),
                          "fps": float(bpy.context.scene.render.fps) / float(bpy.context.scene.render.fps_base)})
        names = [c["name"] for c in clips]
        dupes = sorted({n for n in names if names.count(n) > 1})
        if dupes:
            for c in clips:
                if c["name"] in dupes:
                    c["name"] = xl.safe_name(c["take"])
        default = p.get("autoplay") or next((c["name"] for c in clips if c["name"].startswith("idle")), None) \
            or next((c["name"] for c in clips if c["loop"]), clips[0]["name"] if clips else "")
        pkg["clips"], pkg["default_clip"] = clips, default

        # LOD + collider
        lod_levels, lod_tris = None, None
        if p.get("lod", True):
            lod_levels, lod_tris = _make_lods(meshes, wind_mats, p.get("lod_ratios", LOD_RATIOS),
                                              int(p.get("lod_min_tris", 3000)))
            if lod_levels is None:
                warnings.append("LOD skipped: %s" % lod_tris)
        if lod_levels:
            screen = list(p.get("lod_screen", LOD_SCREEN))[:len(lod_levels)]
            pkg["lod"] = {"levels": [{"screen": float(s), "renderers": names}
                                     for s, names in zip(screen, lod_levels)],
                          "screen": screen, "tris": lod_tris}
        else:
            pkg["lod"] = {"levels": [], "screen": [], "tris": []}
        saved = _arm_rest(arms)
        lod0 = [o for o in meshes]
        pkg["collider"] = _collider(p.get("collider", "auto"), lod0, wind_mats, rig, rotate, kind)
        _arm_restore(saved)

        # FBX
        export_objs = [o for o in bpy.data.objects if o.type in ("MESH", "ARMATURE", "EMPTY")
                       and (o.type != "MESH" or o in xl.render_meshes(list(bpy.data.objects)))]
        fbx_path = os.path.join(pkg_dir, "%s.fbx" % asset_id)
        export_fbx(fbx_path, export_objs, bool(clips))
        pkg.update({"model": os.path.basename(fbx_path), "rig": rig,
                    "missing_humanoid_bones": missing if rig == "humanoid" else [],
                    "model_rotation_y": 180.0 if rotate else 0.0, "source_forward": src_fwd,
                    "source_forward_from": fwd_from, "size_m": _r([b - a for a, b in zip(bmin, bmax)]),
                    "bounds_min": _r(bmin), "bounds_max": _r(bmax), "tris": info["tris"],
                    "size_gltf_m": info["size_gltf_m"], "materials": mats, "sockets": sockets})
        stats.update({"rig": rig, "clips": len(clips), "materials": len(mats), "wind_materials": sorted(wind_mats),
                      "sockets": len(sockets), "fx": len(fx_bind), "lod_tris": lod_tris if lod_levels else None,
                      "collider": pkg["collider"]["type"], "size_m": pkg["size_m"], "tris": info["tris"],
                      "model_rotation_y": pkg["model_rotation_y"], "fbx_mb": round(os.path.getsize(fbx_path) / 2**20, 2)})
        # Godot and Unity must agree on the size: the glTF (x, y, z) extents are the Unity (x, y, z) extents
        g = sorted(info["size_gltf_m"])
        u = sorted(pkg["size_m"])
        checks.append(af.check("size_matches_gltf", all(abs(a - b) <= max(0.01 * max(g), 1e-4) for a, b in zip(g, u)),
                               {"unity": pkg["size_m"], "gltf": info["size_gltf_m"]}, "<= 1 %"))

    # sprites
    if inputs.get("sprites"):
        with open(inputs["sprites"], "r", encoding="utf-8") as fh:
            sp = json.load(fh)
        sdir = os.path.dirname(os.path.abspath(inputs["sprites"]))
        dst = os.path.join(pkg_dir, "sprites")
        os.makedirs(dst, exist_ok=True)
        for name in sp.get("sheets", []):
            shutil.copy2(os.path.join(sdir, name), os.path.join(dst, name))
        pkg["sprites"] = sprites_unity(sp, sp.get("profile") == "pixel" or bool(sp.get("pixel")))
        stats["sprite_clips"] = len(pkg["sprites"]["clips"])

    man_path = os.path.join(pkg_dir, "af_unity.json")
    with open(man_path, "w", encoding="utf-8") as fh:
        json.dump(af._jsonable(pkg), fh, ensure_ascii=False, indent=1)

    # Unity validation
    rep = None
    if p.get("validate", True):
        exe = ul.find_unity(p)
        if exe is None:
            warnings.append("Unity not found: package not validated (params.unity / ASTRA_UNITY)")
            checks.append(af.check("unity_validation", False, "unity missing", severity="warning"))
        else:
            af.log("unity batchmode validation", project=ul.check_project(p))
            rep = ul.validate([(asset_id, pkg_dir)], req["out_dir"], p)
            if rep.get("error") == "license":
                warnings.append("Unity has no active license (sign in to Unity Hub): package not validated")
                checks.append(af.check("unity_validation", False, "license", severity="warning"))
            elif rep.get("error") == "project_open":
                warnings.append("the Unity check project is open in the editor: close it to validate")
                checks.append(af.check("unity_validation", False, "project open", severity="warning"))
            else:
                res = rep.get("result") or {}
                a = next((x for x in (res.get("assets") or []) if x.get("asset_id") == asset_id), None)
                checks.append(af.check("unity_validation", bool(a and a.get("ok")),
                                       {"error": rep.get("error"), "failed": [c["name"] for c in (a or {}).get("checks", [])
                                                                              if not c.get("ok")]}, True,
                                       note="AFBatch.Validate in Unity %s: prefab, materials, avatar, clips, sockets, "
                                            "FX, LOD, colliders, size" % rep.get("unity")))
                for c in (a or {}).get("checks", []):
                    checks.append(af.check("unity_" + c["name"], c.get("ok"), c.get("value"), c.get("limit"),
                                           severity=c.get("severity", "error")))
                if rep.get("engine_errors"):
                    checks.append(af.check("unity_engine_errors", False, rep["engine_errors"][:10], [],
                                           severity="warning"))
            with open(af.out_path(req, "unity_check.json"), "w", encoding="utf-8") as fh:
                json.dump(rep, fh, ensure_ascii=False, indent=1)
            stats["unity_seconds"] = rep.get("seconds")
            stats["unity_version"] = rep.get("unity")

    with open(os.path.join(pkg_dir, "README.md"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(_readme(pkg, rep))
    outputs = {"package": pkg_dir, "manifest": man_path, "readme": os.path.join(pkg_dir, "README.md")}
    if fbx_path:
        outputs["fbx"] = fbx_path
    if rep:
        outputs["unity_check"] = af.out_path(req, "unity_check.json")
        if rep.get("shots"):
            outputs["unity_shots"] = rep["shots"]
        if rep.get("log"):
            outputs["unity_log"] = rep["log"]
    return {"outputs": outputs, "stats": stats, "checks": checks, "warnings": warnings}
