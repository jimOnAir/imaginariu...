"""zombie_gen - low-poly zombie townsfolk per the "Quarter 30" concept sheet (ETALON_zombie_sheet.jpg).

A zombie is ~17 px tall in the game, so detail is pointless: the figure is boxes (~300 triangles),
and what reads is clothes/skin colour and the silhouette (hairstyle, cap, hard hat, vest, backpack,
skirt, girth). The skeleton has 11 bones with rigid binding (one box = one bone) and 4 coded clips:
walk (shuffling drag, hands forward), run (lunge, lean), attack (two-handed wind-up and strike),
death (knees buckle, falls onto the back). The forge captures them with the render_sprites step
(profile pixel, 8 directions).

Run: blender -b --factory-startup -P zombie_gen.py -- --out <folder> [--only flannel,cap_tee]
Output: <folder>/<variant>.glb and variants.json (in-game type, height).
Axes: Blender Z up, face toward -Y (the studio character convention).
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Euler, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = os.path.abspath(arg("--out", "zombies_out"))
ONLY = set(arg("--only", "").split(",")) - {""}
os.makedirs(OUT, exist_ok=True)

# skin: green, blue-grey, pale green (as on the sheet)
SKIN = {"green": (0.4, 0.5, 0.34), "blue": (0.5, 0.58, 0.62), "pale": (0.54, 0.6, 0.48)}
HAIR = {"brown": (0.32, 0.22, 0.14), "dark": (0.14, 0.12, 0.1), "grey": (0.62, 0.62, 0.6), "blond": (0.62, 0.5, 0.3)}
JEANS = (0.22, 0.3, 0.44)
SHOE = (0.18, 0.15, 0.12)
BLOOD = (0.45, 0.06, 0.05)

# a variant: in-game type, skin, top, bottom, hair and worn things; fat/child/hunch change proportions
VARIANTS = {
    "flannel":    dict(type="shambler", skin="green", top=(0.62, 0.16, 0.12), bottom=JEANS, hair="brown"),
    "cap_tee":    dict(type="shambler", skin="green", top=(0.78, 0.74, 0.66), bottom=JEANS, hair="brown",
                       hat=("cap", (0.22, 0.32, 0.58))),
    "office_man": dict(type="shambler", skin="pale", top=(0.86, 0.84, 0.8), bottom=(0.32, 0.24, 0.16), hair="brown",
                       tie=(0.85, 0.42, 0.12)),
    "old_cane":   dict(type="shambler", skin="blue", top=(0.36, 0.38, 0.24), bottom=(0.3, 0.26, 0.2), hair=None,
                       cane=True, hunch=True),
    "skater":     dict(type="sprinter", skin="green", top=(0.16, 0.18, 0.22), bottom=(0.42, 0.42, 0.4), hair="brown",
                       hat=("cap_back", (0.75, 0.2, 0.12))),
    "jacket_man": dict(type="shambler", skin="green", top=(0.3, 0.34, 0.22), bottom=JEANS, hair="dark", blood=True),
    "dress_lady": dict(type="shambler", skin="green", top=(0.88, 0.78, 0.62), bottom=None, hair="brown", long_hair=True,
                       dress=(0.88, 0.78, 0.62), blood=True),
    "cardigan":   dict(type="shambler", skin="green", top=(0.72, 0.48, 0.48), bottom=(0.46, 0.4, 0.3), hair="brown",
                       skirt=(0.46, 0.4, 0.3)),
    "office_lady": dict(type="shambler", skin="pale", top=(0.9, 0.9, 0.88), bottom=(0.24, 0.24, 0.3), hair="brown",
                        skirt=(0.24, 0.24, 0.3)),
    "hoodie_grey": dict(type="sprinter", skin="green", top=(0.42, 0.44, 0.5), bottom=(0.46, 0.48, 0.52), hair="brown"),
    "yellow_coat": dict(type="shambler", skin="green", top=(0.62, 0.58, 0.3), bottom=(0.3, 0.26, 0.24), hair="dark",
                        ponytail=True),
    "granny":     dict(type="shambler", skin="blue", top=(0.5, 0.36, 0.3), bottom=(0.4, 0.3, 0.26), hair="grey",
                       skirt=(0.5, 0.36, 0.3), hunch=True),
    "jogger":     dict(type="sprinter", skin="green", top=(0.14, 0.14, 0.18), bottom=(0.2, 0.18, 0.24), hair="brown",
                       ponytail=True, backpack=(0.4, 0.42, 0.3)),
    "long_hair":  dict(type="shambler", skin="green", top=(0.36, 0.3, 0.28), bottom=(0.26, 0.28, 0.24), hair="dark",
                       long_hair=True),
    "red_shirt":  dict(type="sprinter", skin="green", top=(0.62, 0.12, 0.1), bottom=(0.24, 0.24, 0.22), hair=None,
                       blood=True),
    "worker":     dict(type="armored", skin="green", top=(0.3, 0.3, 0.28), bottom=JEANS, hair=None,
                       hat=("hardhat", (0.9, 0.72, 0.12)), vest=(0.92, 0.48, 0.1)),
    "nurse":      dict(type="shambler", skin="pale", top=(0.46, 0.7, 0.68), bottom=(0.46, 0.7, 0.68), hair="brown",
                       hat=("cap", (0.46, 0.7, 0.68)), blood=True),
    "suit":       dict(type="shambler", skin="blue", top=(0.18, 0.2, 0.26), bottom=(0.18, 0.2, 0.26), hair="dark",
                       tie=(0.6, 0.12, 0.1)),
    "tourist":    dict(type="shambler", skin="green", top=(0.86, 0.4, 0.14), bottom=(0.5, 0.44, 0.32), hair=None,
                       hat=("straw", (0.72, 0.6, 0.36)), backpack=(0.36, 0.4, 0.24)),
    "farmer":     dict(type="armored", skin="green", top=(0.8, 0.7, 0.3), bottom=(0.22, 0.3, 0.46), hair=None,
                       hat=("straw", (0.72, 0.6, 0.36)), overalls=(0.22, 0.3, 0.46)),
    "hoodie_kid": dict(type="sprinter", skin="green", top=(0.52, 0.5, 0.66), bottom=(0.5, 0.42, 0.32), hair="brown",
                       child=True),
    "fat_hoodie": dict(type="bloater", skin="green", top=(0.5, 0.46, 0.34), bottom=JEANS, hair=None, fat=True),
    "fat_torn":   dict(type="bloater", skin="green", top=(0.62, 0.68, 0.76), bottom=(0.2, 0.26, 0.4), hair=None,
                       fat=True, blood=True),
    "brute":      dict(type="bruiser", skin="blue", top=(0.4, 0.42, 0.44), bottom=(0.22, 0.24, 0.3), hair=None,
                       fat=True, big=True, blood=True),
}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


MATS = {}
PARTS = []      # (bmesh, bone name, material)


def mat(rgb):
    key = tuple(round(c, 3) for c in rgb)
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new("m_%02x%02x%02x" % tuple(int(c * 255) for c in rgb))
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    MATS[key] = m
    return m


def part(bone, center, size, rgb, rot=(0, 0, 0)):
    """A box bound to a bone in full."""
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    R = Euler(rot).to_matrix()
    for v in t.verts:
        v.co = R @ Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + Vector(center)
    PARTS.append((t, bone, mat(rgb)))


def build(name, V):
    """The box figure; returns (height m, landmark heights and widths for the rig)."""
    PARTS.clear()
    MATS.clear()
    k = 0.65 if V.get("child") else (1.12 if V.get("big") else 1.0)
    H = 1.75 * k
    fat = 1.45 if V.get("fat") else 1.0
    skin = SKIN[V["skin"]]
    top = V["top"]
    bottom = V["bottom"] or top
    knee, hip, waist, chest, neck = 0.28 * H, 0.52 * H, 0.6 * H, 0.78 * H, 0.83 * H
    hw = 0.1 * H * (1.2 if fat > 1 else 1.0)          # hip half-width
    sw = 0.2 * H * (1.1 if fat > 1 else 1.0)          # shoulder half-width
    # legs
    for s, side in ((1, "L"), (-1, "R")):
        part("thigh." + side, (s * hw, 0, (hip + knee) / 2),
             (0.13 * H * (1.15 if fat > 1 else 1), 0.13 * H, hip - knee + 0.02), V.get("overalls") or bottom)
        part("shin." + side, (s * hw, 0, knee / 2 + 0.03), (0.11 * H, 0.12 * H, knee - 0.02),
             bottom if not V.get("dress") else skin)
        part("shin." + side, (s * hw, -0.03, 0.03), (0.12 * H, 0.2 * H, 0.06), SHOE)
    # pelvis and torso
    part("hips", (0, 0, (hip + waist) / 2), (2 * hw + 0.13 * H, 0.17 * H * fat, waist - hip + 0.06),
         V.get("overalls") or bottom)
    part("spine", (0, 0.0, (waist + neck) / 2), (2 * sw - 0.06 * H, 0.17 * H * fat, neck - waist), top)
    if fat > 1:
        part("spine", (0, -0.1 * H, waist + 0.08 * H), (2 * sw - 0.1 * H, 0.14 * H, 0.18 * H), top)     # belly
    if V.get("vest"):
        part("spine", (0, 0, (waist + neck) / 2 + 0.01), (2 * sw - 0.03 * H, 0.19 * H * fat, neck - waist - 0.04), V["vest"])
    if V.get("tie"):
        part("spine", (0, -0.09 * H * fat - 0.005, chest - 0.02), (0.035 * H, 0.01, 0.2 * H), V["tie"])
    if V.get("overalls"):
        part("spine", (0, -0.087 * H * fat, waist + 0.07 * H), (0.22 * H, 0.012, 0.16 * H), V["overalls"])
    if V.get("blood"):
        for _ in range(3):
            part("spine", (random.uniform(-0.1, 0.1) * H, -0.087 * H * fat - 0.006, random.uniform(waist, chest)),
                 (0.06 * H, 0.01, 0.05 * H), BLOOD)
    if V.get("backpack"):
        part("spine", (0, 0.13 * H * fat, chest - 0.05 * H), (0.26 * H, 0.1 * H, 0.26 * H), V["backpack"])
    if V.get("dress") or V.get("skirt"):
        c = V.get("dress") or V.get("skirt")
        part("hips", (0, 0, hip - 0.07 * H), (2 * hw + 0.2 * H, 0.22 * H, 0.2 * H), c)
    # arms (hang down; the "hands forward" posture comes from the animation)
    for s, side in ((1, "L"), (-1, "R")):
        part("upper_arm." + side, (s * sw, 0, chest - 0.1 * H), (0.1 * H, 0.1 * H, 0.2 * H), top)
        part("lower_arm." + side, (s * sw, 0, chest - 0.3 * H), (0.085 * H, 0.085 * H, 0.18 * H), skin)
    if V.get("cane"):
        part("lower_arm.R", (-sw, -0.04, chest - 0.55 * H), (0.03, 0.03, 0.5 * H), (0.35, 0.24, 0.14))
    # head: bigger than real life (on the concept sheet the head is ~1/5 of the height - otherwise the
    # face disappears at 17 px)
    hz = neck + 0.1 * H
    part("head", (0, 0, hz), (0.2 * H, 0.19 * H, 0.21 * H), skin)
    part("head", (0.045 * H, -0.096 * H, hz + 0.025 * H), (0.035 * H, 0.01, 0.035 * H), (0.9, 0.85, 0.3))   # eyes
    part("head", (-0.045 * H, -0.096 * H, hz + 0.025 * H), (0.035 * H, 0.01, 0.035 * H), (0.9, 0.85, 0.3))
    part("head", (0, -0.096 * H, hz - 0.055 * H), (0.08 * H, 0.01, 0.03 * H), (0.35, 0.08, 0.06))           # mouth
    if V.get("hair"):
        hc = HAIR[V["hair"]]
        part("head", (0, 0.01, hz + 0.1 * H), (0.21 * H, 0.2 * H, 0.05 * H), hc)
        part("head", (0, 0.09 * H, hz + 0.01 * H), (0.21 * H, 0.03 * H, 0.18 * H), hc)
        if V.get("long_hair"):
            part("head", (0, 0.09 * H, hz - 0.16 * H), (0.22 * H, 0.04 * H, 0.24 * H), hc)
        if V.get("ponytail"):
            part("head", (0, 0.13 * H, hz - 0.04 * H), (0.06 * H, 0.06 * H, 0.16 * H), hc)
    if V.get("hat"):
        kind, hc = V["hat"]
        if kind in ("cap", "cap_back"):
            part("head", (0, 0, hz + 0.11 * H), (0.22 * H, 0.21 * H, 0.06 * H), hc)
            part("head", (0, (-1 if kind == "cap" else 1) * 0.15 * H, hz + 0.085 * H), (0.18 * H, 0.1 * H, 0.02 * H), hc)
        elif kind == "hardhat":
            part("head", (0, 0, hz + 0.115 * H), (0.24 * H, 0.24 * H, 0.08 * H), hc)
            part("head", (0, 0, hz + 0.08 * H), (0.28 * H, 0.29 * H, 0.02 * H), hc)
        elif kind == "straw":
            part("head", (0, 0, hz + 0.13 * H), (0.2 * H, 0.2 * H, 0.07 * H), hc)
            part("head", (0, 0, hz + 0.1 * H), (0.38 * H, 0.38 * H, 0.02 * H), hc)
    return H, dict(knee=knee, hip=hip, waist=waist, chest=chest, neck=neck, hw=hw, sw=sw)


def make_rig(H, P):
    """11 bones; one mesh from all the boxes, vertex group = bone (rigid binding)."""
    arm_data = bpy.data.armatures.new("rig")
    arm = bpy.data.objects.new("rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones

    def bone(n, h, t, parent=None):
        b = eb.new(n)
        b.head, b.tail = Vector(h), Vector(t)
        if parent:
            b.parent = eb[parent]
        return b
    bone("root", (0, 0, 0), (0, 0, 0.2))
    bone("hips", (0, 0, P["hip"]), (0, 0, P["waist"]), "root")
    bone("spine", (0, 0, P["waist"]), (0, 0, P["neck"]), "hips")
    bone("head", (0, 0, P["neck"]), (0, 0, P["neck"] + 0.2 * H), "spine")
    for s, side in ((1, "L"), (-1, "R")):
        bone("upper_arm." + side, (s * P["sw"], 0, P["chest"]), (s * P["sw"], 0, P["chest"] - 0.2 * H), "spine")
        bone("lower_arm." + side, (s * P["sw"], 0, P["chest"] - 0.2 * H), (s * P["sw"], 0, P["chest"] - 0.4 * H),
             "upper_arm." + side)
        bone("thigh." + side, (s * P["hw"], 0, P["hip"]), (s * P["hw"], 0, P["knee"]), "hips")
        bone("shin." + side, (s * P["hw"], 0, P["knee"]), (s * P["hw"], 0, 0.03), "thigh." + side)
    bpy.ops.object.mode_set(mode="OBJECT")
    me = bpy.data.meshes.new("body")
    bm = bmesh.new()
    dl = bm.verts.layers.deform.verify()
    groups, mats = [], []
    for t, bn, m in PARTS:
        if bn not in groups:
            groups.append(bn)
        if m not in mats:
            mats.append(m)
        gi, mi = groups.index(bn), mats.index(m)
        vmap = {}
        for v in t.verts:
            nv = bm.verts.new(v.co)
            nv[dl][gi] = 1.0
            vmap[v] = nv
        for f in t.faces:
            nf = bm.faces.new([vmap[v] for v in f.verts])
            nf.material_index = mi
        t.free()
    bm.to_mesh(me)
    bm.free()
    body = bpy.data.objects.new("body", me)
    bpy.context.scene.collection.objects.link(body)
    for g in groups:
        body.vertex_groups.new(name=g)
    for m in mats:
        me.materials.append(m)
    body.parent = arm
    mod = body.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    return arm, body


def calibrate(arm, H):
    """The sign of each bone's X rotation that sends its tip forward (-Y). Bone roll depends on the
    direction of the bone - measure it, do not guess."""
    sign = {}
    bpy.context.view_layer.update()
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        t0 = (arm.matrix_world @ pb.tail).copy()
        pb.rotation_euler = (math.radians(10), 0, 0)
        bpy.context.view_layer.update()
        t1 = arm.matrix_world @ pb.tail
        sign[pb.name] = -1.0 if (t1.y - t0.y) > 0 else 1.0
        pb.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    return sign


def key_pose(arm, sign, frame, pose, root_loc=(0, 0, 0), root_rot=0.0):
    """pose: {bone: degrees "forward"} (+ moves the bone tip forward, toward -Y); root_rot leans the
    whole body backwards (death)."""
    for pb in arm.pose.bones:
        a = pose.get(pb.name, 0.0)
        if pb.name == "root":
            # the root bone points up (+Z): its local axes are X=world X, Y=world Z, Z=world -Y
            pb.location = (root_loc[0], root_loc[2], -root_loc[1])
            pb.rotation_euler = (sign["root"] * math.radians(-root_rot), 0, 0)
            pb.keyframe_insert("location", frame=frame)
        else:
            pb.rotation_euler = (sign[pb.name] * math.radians(a), 0, 0)
        pb.keyframe_insert("rotation_euler", frame=frame)


def clip(arm, sign, name, frames, fn):
    """Sample fn(t) over frames+1 keys and park the action on an NLA track named `name`."""
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    for f in range(frames + 1):
        pose, loc, rr = fn(f / frames)
        key_pose(arm, sign, f + 1, pose, loc, rr)
    tr = arm.animation_data.nla_tracks.new()
    tr.name = name
    tr.strips.new(name, 1, act)
    arm.animation_data.action = None
    return act


def walk(t, H, hunch):
    """Shuffle: 1 s stride, the right leg drags, hands forward with a sway, body leaned."""
    a = t * 2 * math.pi
    lean = 14 + (12 if hunch else 0)
    return ({"thigh.L": 24 * math.sin(a), "thigh.R": -16 * math.sin(a),
             "shin.L": -28 * max(0.0, math.sin(a + 1.2)), "shin.R": -14 * max(0.0, -math.sin(a + 1.2)),
             "spine": lean + 3 * math.sin(2 * a), "head": 8 + 6 * math.sin(a + 0.5),
             "upper_arm.L": 80 + 8 * math.sin(a + 1.0), "upper_arm.R": 72 - 8 * math.sin(a + 1.0),
             "lower_arm.L": 6, "lower_arm.R": 12},
            (0, 0, 0.02 * H * abs(math.sin(a))), 0.0)


def run(t, H, hunch):
    """Run: 0.6 s stride, strong lean, wide leg swing, arms lunging forward."""
    a = t * 2 * math.pi
    return ({"thigh.L": 34 * math.sin(a) + 8, "thigh.R": -34 * math.sin(a) + 8,
             "shin.L": -55 * max(0.0, math.sin(a + 1.4)), "shin.R": -55 * max(0.0, -math.sin(a + 1.4)),
             "hips": 16, "spine": 22, "head": -6,
             "upper_arm.L": 70 - 30 * math.sin(a), "upper_arm.R": 70 + 30 * math.sin(a),
             "lower_arm.L": 30, "lower_arm.R": 30},
            (0, 0, 0.05 * H * abs(math.sin(a))), 0.0)


def attack(t, H, hunch):
    """Strike: both arms up and back (0-0.45), snap down-forward (0.45-0.65), recover."""
    if t < 0.45:
        k = t / 0.45
        arms, sp = 80 + 80 * k, 10 - 15 * k
    elif t < 0.65:
        k = (t - 0.45) / 0.2
        arms, sp = 160 - 120 * k, -5 + 40 * k
    else:
        k = (t - 0.65) / 0.35
        arms, sp = 40 + 40 * k, 35 - 25 * k
    return ({"upper_arm.L": arms, "upper_arm.R": arms - 10, "lower_arm.L": 20, "lower_arm.R": 25,
             "spine": sp, "head": 10, "thigh.L": 18, "thigh.R": -10, "shin.R": -15},
            (0, -0.08 * H * max(0.0, math.sin(t * math.pi)), 0), 0.0)


def death(t, H, hunch):
    """Death: knees buckle, the body tips backwards and lands flat."""
    k = min(1.0, t / 0.8)
    e = k * k * (3 - 2 * k)
    fall = 88 * e
    return ({"thigh.L": 35 * e, "thigh.R": 20 * e, "shin.L": -60 * e, "shin.R": -40 * e,
             "spine": -10 * e, "head": -25 * e, "upper_arm.L": 60 - 140 * e, "upper_arm.R": 50 - 120 * e,
             "lower_arm.L": 10, "lower_arm.R": 10},
            (0, 0.05 * H * e, 0.06 * H * math.sin(e * math.pi)), fall)


info = {}
for name, V in VARIANTS.items():
    if ONLY and name not in ONLY:
        continue
    reset()
    random.seed(name)
    H, P = build(name, V)
    arm, body = make_rig(H, P)
    sign = calibrate(arm, H)
    hunch = bool(V.get("hunch"))
    clip(arm, sign, "walk", 24, lambda t: walk(t, H, hunch))
    clip(arm, sign, "run", 16, lambda t: run(t, H, hunch))
    clip(arm, sign, "attack", 18, lambda t: attack(t, H, hunch))
    clip(arm, sign, "death", 24, lambda t: death(t, H, hunch))
    bpy.ops.object.select_all(action="SELECT")
    path = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_animation_mode="NLA_TRACKS", export_force_sampling=True)
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    info[name] = {"type": V["type"], "height_m": round(H, 2), "tris": tris}
    print("ZOMBIE", name, V["type"], "H", round(H, 2), "tris", tris)
json.dump(info, open(os.path.join(OUT, "variants.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
