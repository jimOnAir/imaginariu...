"""weapon_gen - the "Quarter 30" emplacements rigged for fire animation (concept sheets / ETALON_*).

Unlike props_gen (static props), here the gun assembly carries a `gun` bone: the fire clip is a
recoil backwards and a muzzle rise, the idle clip is the rest pose. The forge captures both with the
render_sprites step (profile pixel, 16 directions: [[D00, 0], [D01, 22.5], ...]). The barrel points
-Y, Z is up. Game attachment points (muzzle, ejection port, axis height) go into weapons.json - the
game places muzzle flash, tracer and shell casings exactly there.

The emplacement is cut into two models (owner's decision of 31.10: "the tripod stands, only the gun
with its cover rotates"):
  <name>_base.glb - immobile (tripod, pedestal), no skeleton;
  <name>_gun.glb  - the gun assembly on the `gun` bone; clips for every barrel-down PITCHES:
                    idle00/fire00, idle10/fire10, ... (the roof is above the street - the barrel
                    points down, the tracer flies out of the muzzle).
Both models share one coordinate frame (origin = the floor under the emplacement); the forge renders
them with center=none so the in-game layers coincide. For every pitch, weapons.json carries the
muzzle and ejection point (muzzle_p / eject_p) in Blender axes.

Run: blender -b --factory-startup -P weapon_gen.py -- --out <folder> [--only mg_l1]
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = os.path.abspath(arg("--out", "weapons_out"))
ONLY = set(arg("--only", "").split(",")) - {""}
SCALE = float(arg("--scale", 1.5))   # game exaggeration: on the roof the gun must read as on the reference sheet
os.makedirs(OUT, exist_ok=True)

# the sheet palette: olive, dark steel, rust, brass, orange tips, green lens
C = {
    "olive": (0.33, 0.37, 0.2), "olive_d": (0.22, 0.25, 0.14), "steel": (0.17, 0.18, 0.19),
    "steel_l": (0.36, 0.37, 0.38), "rust": (0.46, 0.23, 0.1), "brass": (0.8, 0.62, 0.22),
    "orange": (0.9, 0.42, 0.1), "red": (0.7, 0.12, 0.08), "black": (0.06, 0.06, 0.06),
    "lens": (0.3, 0.95, 0.4),
}
PARTS = []      # (bmesh, bone name, colour key)
MATS = {}


def mat(name):
    """Flat colour material: steel gets a metallic sheen, the lens glows."""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new("w_" + name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*C[name], 1)
    b.inputs["Roughness"].default_value = 0.55 if name.startswith("steel") else 0.85
    b.inputs["Metallic"].default_value = 0.5 if name.startswith("steel") or name == "brass" else 0.0
    if name == "lens":
        b.inputs["Emission Color"].default_value = (*C[name], 1)
        b.inputs["Emission Strength"].default_value = 3.0
    MATS[name] = m
    return m


def box(bone, center, size, col, rot=(0, 0, 0)):
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    R = Euler(rot).to_matrix()
    for v in t.verts:
        v.co = R @ Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + Vector(center)
    PARTS.append((t, bone, col))


def cyl(bone, center, r, h, col, axis="Y", seg=10):
    t = bmesh.new()
    bmesh.ops.create_cone(t, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=h)
    R = Euler({"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]).to_matrix()
    for v in t.verts:
        v.co = R @ v.co + Vector(center)
    PARTS.append((t, bone, col))


def strut(bone, p0, p1, w, col):
    """A square beam between two points (legs, braces, cables)."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    box(bone, (p0 + p1) / 2, (w, w, d.length), col, rot=tuple(q.to_euler()))


def mg_l1():
    """Machine gun level 1 (Light Gun Turret + Single MG): tripod, receiver, windowed shroud, ammo
    box with a belt, sensor."""
    pivot = 1.0
    # --- immobile: tripod, column, turret ring
    for a in (90, 210, 330):
        r = math.radians(a)
        foot = (math.cos(r) * 0.72, math.sin(r) * 0.72, 0.03)
        strut("root", (math.cos(r) * 0.05, math.sin(r) * 0.05, 0.82), foot, 0.065, "olive")
        box("root", foot, (0.16, 0.16, 0.05), "olive_d")
        strut("root", (math.cos(r) * 0.36, math.sin(r) * 0.36, 0.42), (0, 0, 0.5), 0.035, "olive_d")   # brace
    cyl("root", (0, 0, 0.72), 0.06, 0.36, "steel", axis="Z")
    cyl("root", (0, 0, 0.93), 0.13, 0.08, "olive", axis="Z")
    box("root", (0.1, 0.0, 0.93), (0.05, 0.05, 0.05), "rust")
    # --- gun assembly (bone `gun`): cradle, receiver, shroud, ammo box, belt, sensor
    g = "gun"
    z = pivot + 0.18
    box(g, (0, 0.02, pivot + 0.05), (0.24, 0.32, 0.12), "olive")                      # cradle
    box(g, (0, 0.05, z), (0.2, 0.72, 0.24), "steel")                                  # receiver
    box(g, (0, 0.13, z + 0.145), (0.18, 0.44, 0.05), "steel_l")                       # top cover
    box(g, (0.101, 0.1, z + 0.03), (0.01, 0.2, 0.1), "rust")                          # rust patch on the side
    box(g, (0.102, -0.08, z), (0.01, 0.12, 0.06), "black")                            # ejection port (right)
    for sx in (-1, 1):                                                                # spade grips
        box(g, (sx * 0.07, 0.47, z - 0.01), (0.035, 0.035, 0.17), "steel")
        box(g, (sx * 0.07, 0.47, z + 0.09), (0.045, 0.045, 0.04), "orange")
    box(g, (0, 0.44, z - 0.06), (0.12, 0.04, 0.04), "steel")                          # trigger
    cyl(g, (0, -0.6, z), 0.058, 0.62, "steel")                                        # barrel shroud
    for k in range(4):                                                                # shroud cooling windows
        for sx in (-1, 1):
            box(g, (sx * 0.055, -0.38 - k * 0.14, z + 0.01), (0.012, 0.05, 0.03), "black")
    cyl(g, (0, -1.18, z), 0.024, 0.56, "steel_l", seg=8)                              # barrel
    cyl(g, (0, -1.49, z), 0.042, 0.1, "steel", seg=8)                                 # muzzle brake
    box(g, (0, -1.36, z + 0.07), (0.02, 0.02, 0.08), "steel")                         # front sight
    box(g, (0, 0.2, z + 0.2), (0.05, 0.03, 0.07), "steel")                            # rear sight
    box(g, (-0.3, 0.05, z - 0.1), (0.24, 0.38, 0.3), "olive")                         # ammo box (large, as on the sheet)
    box(g, (-0.3, 0.05, z + 0.06), (0.25, 0.39, 0.025), "olive_d")                    # box lid
    box(g, (-0.3, -0.15, z - 0.05), (0.08, 0.02, 0.06), "olive_d")                    # latch
    for k in range(8):                                                                # belt feeding the receiver
        t = k / 7
        box(g, (-0.26 + 0.17 * t, 0.05, z + 0.08 + 0.1 * math.sin(t * math.pi)), (0.05, 0.08, 0.035), "brass")
    box(g, (0.13, -0.04, z + 0.21), (0.1, 0.15, 0.09), "steel_l")                     # sensor pod
    box(g, (0.13, -0.122, z + 0.215), (0.06, 0.012, 0.05), "lens")                    # green lens
    strut(g, (0.17, 0.02, z + 0.17), (0.11, 0.0, pivot + 0.06), 0.02, "orange")       # cables
    strut(g, (0.09, 0.03, z + 0.17), (-0.05, 0.06, pivot + 0.06), 0.02, "red")
    return {"pivot_z": pivot, "muzzle": [0, -1.55, z], "eject": [0.11, -0.08, z], "barrel_len": 1.55,
            "recoil_m": 0.14, "kick_deg": 4.0}


WEAPONS = {"mg_l1": mg_l1}
# barrel pitch down, degrees: the roof is 3-5 floors up and the targets are 15-50 m away in the
# street; steeper angles are a dead zone behind the parapet
PITCHES = [0, 10, 20, 30, 40]


def build_mesh(name, parts, rig=None):
    """One mesh welded from the bmesh parts; with rig - full weight to the `gun` bone."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    mats = []
    for t, _bone, col in parts:
        m = mat(col)
        if m not in mats:
            mats.append(m)
        vmap = {}
        for v in t.verts:
            vmap[v] = bm.verts.new(v.co)
        for f in t.faces:
            bm.faces.new([vmap[v] for v in f.verts]).material_index = mats.index(m)
        t.free()
    bm.to_mesh(me)
    bm.free()
    body = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(body)
    for m in mats:
        me.materials.append(m)
    if rig is not None:
        vg = body.vertex_groups.new(name="gun")
        vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
        body.parent = rig
        body.modifiers.new("rig", "ARMATURE").object = rig
    return body


def build_rig(pivot):
    """root + gun bone at the trunnion height; gun is what the fire animation moves."""
    arm_data = bpy.data.armatures.new("rig")
    arm = bpy.data.objects.new("rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    r = arm_data.edit_bones.new("root")
    r.head, r.tail = Vector((0, 0, 0)), Vector((0, 0, 0.3))
    g = arm_data.edit_bones.new("gun")
    g.head, g.tail = Vector((0, 0, pivot)), Vector((0, 0, pivot + 0.3))
    g.parent = r
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def gun_matrix(arm):
    """The world transform the `gun` bone currently applies to bound geometry."""
    pb = arm.pose.bones["gun"]
    return arm.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted()


def lift_sign(arm, muzzle):
    """The sign of the bone rotation that raises the muzzle. Measured on the bone axes, not guessed."""
    pb = arm.pose.bones["gun"]
    pb.rotation_mode = "XYZ"
    pb.location = (0, 0, 0)
    best = None
    for sgn in (1, -1):
        pb.rotation_euler = (sgn * math.radians(5.0), 0, 0)
        bpy.context.view_layer.update()
        z = (gun_matrix(arm) @ Vector(muzzle)).z
        if best is None or z > best[0]:
            best = (z, sgn)
    return best[1]


def pose_gun(arm, sgn, pitch_deg, back, kick_deg, update=True):
    """Barrel tilted down by pitch; a shot kicks it back along the barrel axis by `back` and raises
    the muzzle by kick. With update=False only the pose values are set for keying: a scene recompute
    while NLA strips are live would overwrite the pose with the last played clip."""
    pb = arm.pose.bones["gun"]
    pb.rotation_euler = (sgn * math.radians(kick_deg - pitch_deg), 0, 0)
    p = math.radians(pitch_deg)
    world_back = Vector((0, math.cos(p), math.sin(p))) * back     # barrel at -Y and down -> back is +Y and up
    mw = (arm.matrix_world @ pb.bone.matrix_local).to_3x3()
    pb.location = mw.inverted() @ world_back
    if update:
        bpy.context.view_layer.update()


def clip(arm, name, sgn, pitch, poses, meta):
    """A 2..4 frame clip over the gun bone, parked on an NLA track (render_sprites picks clips up)."""
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    pb = arm.pose.bones["gun"]
    for f, k in enumerate(poses):
        pose_gun(arm, sgn, pitch, meta["recoil_m"] * k, meta["kick_deg"] * k, update=False)
        pb.keyframe_insert("location", frame=f + 1)
        pb.keyframe_insert("rotation_euler", frame=f + 1)
    tr = arm.animation_data.nla_tracks.new()
    tr.name = name
    tr.strips.new(name, 1, act)
    arm.animation_data.action = None


def export(objs, path, anim):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_animation_mode="NLA_TRACKS" if anim else "ACTIONS",
                              export_animations=anim, export_force_sampling=anim)


info = {}
for name, fn in WEAPONS.items():
    if ONLY and name not in ONLY:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    PARTS.clear()
    MATS.clear()
    meta = fn()
    for t, _b, _c in PARTS:            # scale the whole model and the game points together
        for v in t.verts:
            v.co *= SCALE
    meta["pivot_z"] *= SCALE
    meta["muzzle"] = [c * SCALE for c in meta["muzzle"]]
    meta["eject"] = [c * SCALE for c in meta["eject"]]
    meta["barrel_len"] *= SCALE
    meta["recoil_m"] *= SCALE
    meta["scale"] = SCALE
    base_parts = [p for p in PARTS if p[1] == "root"]
    gun_parts = [p for p in PARTS if p[1] != "root"]
    arm = build_rig(meta["pivot_z"])
    base = build_mesh(name + "_base", base_parts)
    gun = build_mesh(name + "_gun", gun_parts, rig=arm)
    tris = {k: sum(len(f.vertices) - 2 for f in o.data.polygons) for k, o in (("base", base), ("gun", gun))}
    sgn = lift_sign(arm, meta["muzzle"])
    meta["pitches"], meta["muzzle_p"], meta["eject_p"], meta["clips"] = PITCHES, [], [], []
    for pt in PITCHES:                # measure the points before the clips exist: afterwards the NLA owns the pose
        pose_gun(arm, sgn, pt, 0.0, 0.0)
        m = gun_matrix(arm)
        meta["muzzle_p"].append([round(c, 4) for c in m @ Vector(meta["muzzle"])])
        meta["eject_p"].append([round(c, 4) for c in m @ Vector(meta["eject"])])
    for pt in PITCHES:
        clip(arm, "idle%02d" % pt, sgn, pt, [0.0, 0.0], meta)
        clip(arm, "fire%02d" % pt, sgn, pt, [1.0, 0.55, 0.2, 0.0], meta)    # shot: kick back, return over 3 frames
        meta["clips"] += ["idle%02d" % pt, "fire%02d" % pt]
    pose_gun(arm, sgn, 0.0, 0.0, 0.0, update=False)
    export([base], os.path.join(OUT, name + "_base.glb"), False)
    export([arm, gun], os.path.join(OUT, name + "_gun.glb"), True)
    meta["tris"] = tris["base"] + tris["gun"]
    meta["tris_parts"] = tris
    info[name] = meta
    print("WEAPON", name, "tris", tris, "lift_sign", sgn, "muzzle_p", meta["muzzle_p"])
json.dump(info, open(os.path.join(OUT, "weapons.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
