"""props_gen - procedural city infrastructure (Soviet city) for "Quarter 30" and other city games.

Every prop is its own GLB; vehicle details are separate nodes (part_*) so they fly apart on an
explosion in the game. Sizes in metres, Blender Z up, the object front faces -Y.
Run: blender -b --factory-startup -P props_gen.py -- --out <folder> [--only sedan,tree] [--seed 1]
Output: <name>.glb + props.json (dimensions, mass, type, parts).
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = os.path.abspath(arg("--out", "props_out"))
ONLY = set(arg("--only", "").split(",")) - {""}
rng = random.Random(int(arg("--seed", 1)))
os.makedirs(OUT, exist_ok=True)

MATS = {}


def mat(name, rgb, rough=0.8, metal=0.0, emit=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    MATS[name] = m
    return m


def reset():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def obj(name, build, m, loc=(0, 0, 0), rot=(0, 0, 0)):
    bm = bmesh.new()
    build(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    o.location, o.rotation_euler = loc, rot
    bpy.context.scene.collection.objects.link(o)
    return o


def box(name, size, loc, m, rot=(0, 0, 0), bevel=0.0):
    def b(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        if bevel:
            bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=1, affect="EDGES")
    return obj(name, b, m, loc, rot)


def cyl(name, r, h, loc, m, rot=(0, 0, 0), seg=12, r2=None):
    def b(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    return obj(name, b, m, loc, rot)


def ico(name, r, loc, m, sub=1, squash=1.0):
    def b(bm):
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
        for v in bm.verts:
            v.co.z *= squash
            v.co += Vector([rng.uniform(-0.08, 0.08) * r for _ in range(3)])
    return obj(name, b, m, loc)


# ---------------------------------------------------------------- vehicles

def car(kind, color, burned=False):
    L, W, H, cab = {"sedan": (4.2, 1.68, 1.42, 0.55), "hatch": (3.7, 1.6, 1.4, 0.62),
                    "van": (4.4, 2.0, 2.05, 1.0), "bus": (10.5, 2.5, 2.95, 1.0)}[kind]
    paint = mat("paint_" + kind + ("_burn" if burned else ""), (0.06, 0.05, 0.045) if burned else color,
                rough=0.95 if burned else 0.45, metal=0.0 if burned else 0.3)
    glass = mat("glass_burn" if burned else "glass", (0.03, 0.03, 0.03) if burned else (0.12, 0.18, 0.22), rough=0.15)
    dark = mat("rubber", (0.03, 0.03, 0.03), rough=0.9)
    chrome = mat("chrome", (0.55, 0.55, 0.55), rough=0.3, metal=1.0)
    rust = mat("rust", (0.32, 0.14, 0.06), rough=1.0)
    lamp = mat("headlight", (0.95, 0.9, 0.7), emit=0.0 if burned else 1.5)
    tail = mat("taillight", (0.7, 0.05, 0.03), emit=0.0 if burned else 1.0)
    wr = 0.33 if kind != "bus" else 0.5
    body_h = H * (0.48 if cab < 1 else 0.9)
    box("part_body", (W, L, body_h - wr * 0.6), (0, 0, wr * 0.6 + (body_h - wr * 0.6) / 2), paint, bevel=0.06)
    if cab < 1:   # a car cabin is narrower than the body and shifted back
        ch = H - body_h
        box("part_cabin", (W * 0.86, L * cab, ch), (0, L * 0.06, body_h + ch / 2), paint, bevel=0.08)
        box("part_glass_f", (W * 0.8, 0.05, ch * 0.75), (0, L * 0.06 - L * cab / 2 + 0.02, body_h + ch * 0.45), glass,
            rot=(math.radians(-25), 0, 0))
        box("part_glass_s", (W * 0.88, L * cab * 0.85, ch * 0.6), (0, L * 0.06, body_h + ch * 0.48), glass)
    else:          # van/bus: a window band
        box("part_glass_s", (W + 0.02, L * 0.8, H * 0.28), (0, L * 0.02, H * 0.68), glass)
        box("part_glass_f", (W * 0.9, 0.05, H * 0.32), (0, -L / 2 - 0.01, H * 0.66), glass)
        box("part_roof", (W * 0.96, L * 0.98, 0.08), (0, 0, H - 0.02), paint, bevel=0.03)
    for i, sx in enumerate((-1, 1)):
        box(f"part_door_{i}", (0.04, L * 0.32, body_h * 0.6), (sx * (W / 2 + 0.01), -L * 0.05, body_h * 0.62), paint)
        box(f"part_light_{i}", (W * 0.18, 0.04, 0.12), (sx * W * 0.32, -L / 2 - 0.02, body_h * 0.7), lamp)
        box(f"part_tail_{i}", (W * 0.18, 0.04, 0.12), (sx * W * 0.32, L / 2 + 0.02, body_h * 0.7), tail)
    box("part_bumper_f", (W * 1.02, 0.12, 0.14), (0, -L / 2 - 0.05, wr + 0.05), rust if burned else chrome)
    box("part_bumper_r", (W * 1.02, 0.12, 0.14), (0, L / 2 + 0.05, wr + 0.05), rust if burned else chrome)
    axles = (-L * 0.32, L * 0.3) if kind != "bus" else (-L * 0.36, L * 0.28)
    for ax, y in enumerate(axles):
        for sx in (-1, 1):
            r = wr * (0.8 if burned else 1.0)
            cyl(f"part_wheel_{ax}_{sx}", r, 0.22, (sx * (W / 2 - 0.08), y, r * (0.7 if burned else 1.0)), dark,
                rot=(0, math.radians(90), 0), seg=10)
    if burned:
        for i in range(6):
            box(f"part_rust_{i}", (rng.uniform(0.3, 0.7), rng.uniform(0.3, 0.8), 0.02),
                (rng.uniform(-W / 3, W / 3), rng.uniform(-L / 3, L / 3), body_h + 0.01), rust)
    return {"type": "vehicle", "size": [W, L, H], "mass_kg": {"sedan": 1050, "hatch": 900, "van": 1900, "bus": 9000}[kind],
            "explodes": not burned}


# ---------------------------------------------------------------- street

def streetlamp():
    c = mat("concrete", (0.55, 0.54, 0.5))
    m = mat("lamp_metal", (0.2, 0.21, 0.22), metal=0.6, rough=0.5)
    cyl("pole", 0.13, 7.0, (0, 0, 3.5), c, seg=8, r2=0.08)
    box("arm", (0.08, 1.6, 0.08), (0, -0.75, 6.9), m)
    box("head", (0.35, 0.6, 0.15), (0, -1.5, 6.8), m)
    box("bulb", (0.25, 0.45, 0.04), (0, -1.5, 6.71), mat("bulb", (1.0, 0.85, 0.55), emit=4.0))
    return {"type": "lamp", "size": [0.4, 1.9, 7.0], "mass_kg": 400, "light": [0, -1.5, 6.7]}


def traffic_light():
    m = mat("tl_metal", (0.14, 0.15, 0.13), metal=0.5, rough=0.6)
    cyl("pole", 0.07, 3.2, (0, 0, 1.6), m, seg=8)
    box("housing", (0.32, 0.25, 0.95), (0, 0, 3.4), m)
    for i, (z, col) in enumerate(((3.7, (0.9, 0.08, 0.05)), (3.4, (0.95, 0.65, 0.05)), (3.1, (0.1, 0.8, 0.2)))):
        cyl(f"lamp_{i}", 0.09, 0.05, (0, -0.14, z), mat(f"tl_{i}", col, emit=2.0 if i == 0 else 0.3), rot=(math.radians(90), 0, 0))
    return {"type": "traffic_light", "size": [0.32, 0.3, 3.9], "mass_kg": 120}


def tree(variant=0):
    bark = mat("bark", (0.25, 0.17, 0.1))
    leaves = mat(f"leaves_{variant}", [(0.2, 0.32, 0.1), (0.28, 0.33, 0.12), (0.35, 0.3, 0.1)][variant % 3])
    h = 3.0 + variant * 0.6
    cyl("trunk", 0.18, h, (0, 0, h / 2), bark, seg=7, r2=0.12)
    for i in range(5):
        a = i * 1.26
        ico(f"crown_{i}", rng.uniform(1.0, 1.5), (math.cos(a) * 0.8, math.sin(a) * 0.8, h + rng.uniform(0.2, 1.2)), leaves, squash=0.8)
    ico("crown_top", 1.4, (0, 0, h + 1.6), leaves, squash=0.85)
    return {"type": "tree", "size": [3.5, 3.5, h + 3.0], "mass_kg": 600}


def fence():
    c = mat("fence_concrete", (0.6, 0.58, 0.53))
    box("panel", (2.4, 0.12, 2.2), (0, 0, 1.1), c)
    for i in range(3):
        for j in range(2):
            box(f"rhomb_{i}_{j}", (0.45, 0.04, 0.45), (-0.8 + i * 0.8, -0.07, 0.6 + j * 0.9),
                mat("fence_dark", (0.48, 0.46, 0.42)), rot=(0, math.radians(45), 0))
    return {"type": "fence", "size": [2.4, 0.15, 2.2], "mass_kg": 1100}


def jersey():
    c = mat("jersey", (0.62, 0.6, 0.55))
    box("base", (0.6, 3.0, 0.3), (0, 0, 0.15), c)
    box("mid", (0.35, 3.0, 0.45), (0, 0, 0.5), c)
    box("top", (0.2, 3.0, 0.15), (0, 0, 0.8), c)
    sb = mat("sandbag", (0.55, 0.47, 0.32))
    for i in range(5):
        box(f"bag_{i}", (0.4, 0.55, 0.2), (0, -1.2 + i * 0.6, 0.98), sb, bevel=0.06)
    return {"type": "barricade", "size": [0.6, 3.0, 1.1], "mass_kg": 1500}


def tank_trap():
    s = mat("trap_steel", (0.28, 0.16, 0.09), metal=0.7, rough=0.8)
    for i, rot in enumerate(((math.radians(55), 0, 0), (0, math.radians(55), math.radians(45)), (math.radians(-55), 0, math.radians(90)))):
        box(f"beam_{i}", (0.18, 0.18, 2.0), (0, 0, 0.7), s, rot=rot)
    return {"type": "obstacle", "size": [1.6, 1.6, 1.5], "mass_kg": 300}


def dumpster():
    g = mat("dump_green", (0.12, 0.3, 0.16), metal=0.4, rough=0.6)
    box("bin", (1.8, 1.1, 1.1), (0, 0, 0.65), g, bevel=0.03)
    box("lid", (1.85, 1.15, 0.06), (0, 0.05, 1.24), mat("dump_lid", (0.08, 0.2, 0.1)), rot=(math.radians(-8), 0, 0))
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl(f"wheel_{sx}_{sy}", 0.08, 0.06, (sx * 0.75, sy * 0.4, 0.08), mat("rubber", (0.03, 0.03, 0.03)),
                rot=(0, math.radians(90), 0))
    return {"type": "dumpster", "size": [1.8, 1.1, 1.3], "mass_kg": 250}


def bus_stop():
    c = mat("stop_concrete", (0.58, 0.56, 0.52))
    m = mat("stop_metal", (0.25, 0.3, 0.35), metal=0.5)
    box("floor", (4.0, 1.8, 0.15), (0, 0, 0.075), c)
    box("back", (4.0, 0.15, 2.4), (0, 0.85, 1.35), c)
    box("roof", (4.4, 2.2, 0.15), (0, 0.1, 2.62), c)
    for sx in (-1, 1):
        box(f"side_{sx}", (0.12, 1.6, 2.4), (sx * 1.95, 0.1, 1.35), m)
    box("bench", (3.0, 0.45, 0.08), (0, 0.5, 0.5), mat("wood", (0.45, 0.28, 0.14)))
    box("sign", (0.6, 0.05, 0.6), (1.6, -0.9, 2.4), mat("sign_yellow", (0.85, 0.7, 0.1)))
    return {"type": "bus_stop", "size": [4.4, 2.2, 2.7], "mass_kg": 3000}


def kiosk():
    m = mat("kiosk_blue", (0.22, 0.36, 0.55), metal=0.3)
    box("body", (2.2, 1.8, 2.3), (0, 0, 1.15), m, bevel=0.03)
    box("window", (1.6, 0.04, 0.9), (0, -0.91, 1.4), mat("glass", (0.12, 0.18, 0.22), rough=0.15))
    box("awning", (2.5, 0.8, 0.08), (0, -1.1, 2.15), mat("awning", (0.75, 0.15, 0.1)), rot=(math.radians(15), 0, 0))
    box("sign", (2.0, 0.06, 0.4), (0, -0.92, 2.5), mat("kiosk_sign", (0.95, 0.85, 0.6), emit=0.5))
    return {"type": "kiosk", "size": [2.5, 2.2, 2.7], "mass_kg": 800}


def bench():
    w = mat("wood", (0.45, 0.28, 0.14))
    m = mat("lamp_metal", (0.2, 0.21, 0.22), metal=0.6, rough=0.5)
    box("seat", (1.8, 0.45, 0.06), (0, 0, 0.45), w)
    box("back", (1.8, 0.06, 0.4), (0, 0.22, 0.75), w)
    for sx in (-1, 1):
        box(f"leg_{sx}", (0.06, 0.45, 0.45), (sx * 0.8, 0, 0.22), m)
    return {"type": "bench", "size": [1.8, 0.5, 0.95], "mass_kg": 40}


def hydrant():
    r = mat("hydrant_red", (0.7, 0.08, 0.05), metal=0.3)
    cyl("body", 0.13, 0.8, (0, 0, 0.4), r, seg=10)
    cyl("cap", 0.16, 0.12, (0, 0, 0.82), r, seg=10)
    cyl("nozzle", 0.06, 0.4, (0, 0, 0.55), r, rot=(math.radians(90), 0, 0), seg=8)
    return {"type": "hydrant", "size": [0.4, 0.4, 0.9], "mass_kg": 60}


def road_sign():
    m = mat("lamp_metal", (0.2, 0.21, 0.22), metal=0.6, rough=0.5)
    cyl("pole", 0.04, 2.5, (0, 0, 1.25), m, seg=8)
    cyl("plate", 0.35, 0.03, (0, -0.03, 2.5), mat("sign_red", (0.75, 0.06, 0.05)), rot=(math.radians(90), 0, 0), seg=16)
    cyl("plate_in", 0.26, 0.035, (0, -0.04, 2.5), mat("sign_white", (0.92, 0.92, 0.9)), rot=(math.radians(90), 0, 0), seg=16)
    return {"type": "sign", "size": [0.7, 0.1, 2.85], "mass_kg": 25}


def trash_bin():
    g = mat("bin_grey", (0.35, 0.36, 0.34), metal=0.4)
    cyl("bin", 0.3, 0.9, (0, 0, 0.45), g, seg=10, r2=0.34)
    return {"type": "bin", "size": [0.7, 0.7, 0.9], "mass_kg": 20}


def mg_nest():
    """A machine-gun nest per the Turrets_firing_on_roof_edges sheet (TYPE-01): an arc of sandbags,
    a pedestal, a DShK, an ammo box, a belt, a soldier."""
    sb = mat("sandbag_tan", (0.62, 0.47, 0.28), rough=1.0)
    steel = mat("gun_steel", (0.12, 0.13, 0.13), metal=0.7, rough=0.45)
    olive = mat("olive", (0.25, 0.3, 0.17))
    camo = mat("camo", (0.3, 0.33, 0.22))
    skin = mat("skin", (0.62, 0.45, 0.35))
    brass = mat("brass", (0.75, 0.55, 0.2), metal=0.8, rough=0.3)
    # the sandbag arc in front of the gun: two rows, bags of slightly different size
    for row in range(2):
        for i in range(9):
            a = math.radians(-70 + i * 17.5)
            r = 1.55
            box(f"bag_{row}_{i}", (0.62 * rng.uniform(0.9, 1.05), 0.34, 0.22),
                (math.sin(a) * r, -math.cos(a) * r, 0.12 + row * 0.22), sb,
                rot=(0, 0, a + rng.uniform(-0.06, 0.06)), bevel=0.07)
    cyl("base_plate", 0.42, 0.08, (0, 0, 0.04), steel, seg=16)
    cyl("pedestal", 0.11, 0.85, (0, 0, 0.5), steel, seg=10)
    cyl("yoke", 0.16, 0.12, (0, 0, 0.95), steel, seg=10)
    # the machine gun (points -Y)
    box("receiver", (0.2, 0.7, 0.22), (0, -0.05, 1.08), steel, bevel=0.02)
    cyl("barrel", 0.035, 1.25, (0, -1.0, 1.1), steel, rot=(math.radians(90), 0, 0), seg=8)
    cyl("barrel_jacket", 0.06, 0.45, (0, -0.55, 1.1), steel, rot=(math.radians(90), 0, 0), seg=8)
    cyl("muzzle_brake", 0.06, 0.12, (0, -1.6, 1.1), steel, rot=(math.radians(90), 0, 0), seg=8)
    box("sight", (0.04, 0.06, 0.12), (0, -0.25, 1.24), steel)
    box("handles", (0.24, 0.06, 0.08), (0, 0.35, 1.05), steel)
    box("ammo_box", (0.2, 0.28, 0.24), (0.2, -0.05, 1.0), olive, bevel=0.015)
    for k in range(6):   # the belt
        box(f"belt_{k}", (0.05, 0.05, 0.03), (0.3 + k * 0.04, -0.02, 0.95 - k * 0.09), brass)
    # the soldier behind the gun (low-poly)
    box("leg_l", (0.14, 0.16, 0.8), (-0.12, 0.75, 0.4), camo, rot=(math.radians(-8), 0, 0))
    box("leg_r", (0.14, 0.16, 0.8), (0.12, 0.62, 0.42), camo, rot=(math.radians(12), 0, 0))
    box("boot_l", (0.15, 0.26, 0.1), (-0.12, 0.72, 0.05), steel)
    box("boot_r", (0.15, 0.26, 0.1), (0.12, 0.56, 0.05), steel)
    box("torso", (0.42, 0.26, 0.55), (0, 0.62, 1.05), camo, rot=(math.radians(-15), 0, 0), bevel=0.04)
    box("vest", (0.46, 0.3, 0.38), (0, 0.6, 1.08), olive, rot=(math.radians(-15), 0, 0), bevel=0.04)
    for s in (-1, 1):
        box(f"arm_{s}", (0.1, 0.48, 0.1), (s * 0.24, 0.4, 1.12), camo, rot=(math.radians(-10), 0, math.radians(-8 * s)))
        box(f"hand_{s}", (0.08, 0.1, 0.08), (s * 0.13, 0.36, 1.06), skin)
    ico("head", 0.13, (0, 0.52, 1.46), skin, sub=2)
    ico("helmet", 0.16, (0, 0.53, 1.52), olive, sub=2, squash=0.75)
    return {"type": "turret", "size": [3.2, 3.6, 1.7], "mass_kg": 600}


def soldier(pose="aim"):
    """A rooftop soldier (the "Quarter 30" reference): helmet, vest, camo, assault rifle. Faces and
    aims at -Y. pose: aim - standing with the sight, kneel - on one knee."""
    camo = mat("camo", (0.3, 0.33, 0.22))
    olive = mat("olive", (0.25, 0.3, 0.17))
    steel = mat("gun_steel", (0.12, 0.13, 0.13), metal=0.7, rough=0.45)
    wood = mat("gun_wood", (0.42, 0.26, 0.12))
    skin = mat("skin", (0.62, 0.45, 0.35))
    boot = mat("boot", (0.14, 0.12, 0.1))
    kneel = pose == "kneel"
    hip = 0.55 if kneel else 0.95
    if kneel:
        box("thigh_l", (0.15, 0.45, 0.16), (-0.13, -0.18, 0.5), camo, rot=(math.radians(-10), 0, 0))
        box("shin_l", (0.14, 0.16, 0.45), (-0.13, -0.38, 0.24), camo)
        box("thigh_r", (0.15, 0.16, 0.42), (0.13, 0.05, 0.36), camo, rot=(math.radians(-60), 0, 0))
        box("shin_r", (0.14, 0.48, 0.14), (0.13, 0.28, 0.08), camo)
        box("boot_l", (0.15, 0.26, 0.1), (-0.13, -0.44, 0.05), boot)
        box("boot_r", (0.14, 0.12, 0.22), (0.13, 0.5, 0.12), boot)
    else:
        box("leg_l", (0.15, 0.17, 0.9), (-0.13, -0.08, 0.47), camo, rot=(math.radians(-6), 0, 0))
        box("leg_r", (0.15, 0.17, 0.9), (0.13, 0.12, 0.47), camo, rot=(math.radians(8), 0, 0))
        box("boot_l", (0.16, 0.28, 0.1), (-0.13, -0.12, 0.05), boot)
        box("boot_r", (0.16, 0.28, 0.1), (0.13, 0.15, 0.05), boot)
    lean = math.radians(-12)
    box("torso", (0.42, 0.26, 0.58), (0, 0.02, hip + 0.3), camo, rot=(lean, 0, 0), bevel=0.04)
    box("vest", (0.46, 0.3, 0.4), (0, 0.0, hip + 0.34), olive, rot=(lean, 0, 0), bevel=0.04)
    box("pouches", (0.4, 0.08, 0.14), (0, -0.17, hip + 0.22), olive)
    ico("head", 0.12, (0, -0.06, hip + 0.76), skin, sub=2)
    ico("helmet", 0.155, (0, -0.05, hip + 0.82), olive, sub=2, squash=0.75)
    # the rifle shouldered, barrel forward (-Y)
    gz = hip + 0.58
    box("rifle_body", (0.07, 0.62, 0.12), (0.08, -0.38, gz), steel)
    box("rifle_stock", (0.06, 0.26, 0.12), (0.08, 0.02, gz - 0.02), wood)
    box("rifle_mag", (0.05, 0.08, 0.2), (0.08, -0.36, gz - 0.14), steel, rot=(math.radians(15), 0, 0))
    cyl("rifle_barrel", 0.018, 0.4, (0.08, -0.85, gz + 0.02), steel, rot=(math.radians(90), 0, 0), seg=6)
    box("arm_r", (0.1, 0.42, 0.1), (0.2, -0.12, gz - 0.04), camo, rot=(0, 0, math.radians(-12)))
    box("arm_l", (0.1, 0.5, 0.1), (-0.06, -0.34, gz - 0.06), camo, rot=(0, 0, math.radians(20)))
    box("hand_l", (0.08, 0.09, 0.08), (0.04, -0.58, gz - 0.06), skin)
    box("hand_r", (0.08, 0.09, 0.08), (0.1, -0.24, gz - 0.06), skin)
    return {"type": "soldier", "pose": pose, "size": [0.6, 1.4, 1.1 if kneel else 1.8], "mass_kg": 90}


# ---------------------------------------------------------------- the "Quarter 30" emplacements per the ETALON_* sheets
# Shared sheet traits: olive + dark steel, rust, yellow-black stripes, a tripod or pedestal, ammo
# boxes with a belt. The barrel points -Y.

def _wpn_mats():
    return dict(olive=mat("w_olive", (0.36, 0.4, 0.22), rough=0.8), olive_d=mat("w_olive_d", (0.24, 0.27, 0.15), rough=0.8),
                steel=mat("w_steel", (0.2, 0.21, 0.22), metal=0.6, rough=0.5), steel_l=mat("w_steel_l", (0.42, 0.43, 0.44), metal=0.6, rough=0.45),
                rust=mat("w_rust", (0.45, 0.24, 0.1), rough=1.0), brass=mat("w_brass", (0.78, 0.6, 0.22), metal=0.8, rough=0.3),
                yellow=mat("w_yellow", (0.85, 0.66, 0.1), rough=0.7), black=mat("w_black", (0.08, 0.08, 0.08), rough=0.7),
                red=mat("w_red", (0.75, 0.12, 0.08), rough=0.6), glass=mat("w_lens", (0.2, 0.5, 0.6), rough=0.2, emit=0.6))


def strut(name, p0, p1, w, m):
    """A beam from point to point (tripod legs, struts)."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return box(name, (w, w, d.length), (p0 + p1) / 2, m, rot=tuple(q.to_euler()))


def _tripod(M, h=0.95, spread=0.75, col="olive"):
    for i in range(3):
        a = math.radians(90 + i * 120)
        foot = (math.cos(a) * spread, math.sin(a) * spread, 0.04)
        strut(f"leg_{i}", (0, 0, h * 0.8), foot, 0.075, M[col])
        box(f"foot_{i}", (0.18, 0.18, 0.05), foot, M[col])
    cyl("column", 0.07, h * 0.5, (0, 0, h * 0.8), M["steel"], seg=8)
    cyl("swivel", 0.13, 0.1, (0, 0, h + 0.05), M[col], seg=10)


def weapon_mg():
    """1. Machine gun: heavy caliber on a tripod, gun shield, ammo box with a belt (ROOF-MOUNTED / SINGLE MG with shield sheet)."""
    M = _wpn_mats()
    _tripod(M)
    z = 1.12
    box("receiver", (0.2, 0.75, 0.24), (0, 0.05, z), M["steel"], bevel=0.02)
    box("top_cover", (0.18, 0.4, 0.06), (0, 0.15, z + 0.15), M["steel_l"])
    cyl("jacket", 0.065, 0.55, (0, -0.55, z), M["steel"], rot=(math.radians(90), 0, 0), seg=8)
    cyl("barrel", 0.03, 0.6, (0, -1.05, z), M["steel"], rot=(math.radians(90), 0, 0), seg=6)
    cyl("muzzle", 0.045, 0.1, (0, -1.38, z), M["steel"], rot=(math.radians(90), 0, 0), seg=6)
    box("grips", (0.24, 0.08, 0.14), (0, 0.48, z - 0.02), M["steel"])
    box("shield", (0.62, 0.05, 0.5), (0, -0.32, z + 0.05), M["olive"], bevel=0.02)
    for sx in (-1, 1):
        box(f"shield_wing_{sx}", (0.05, 0.25, 0.48), (sx * 0.33, -0.22, z + 0.05), M["olive"], rot=(0, 0, sx * 0.4))
    box("ammo_box", (0.26, 0.32, 0.26), (0.28, 0.05, z - 0.08), M["olive_d"], bevel=0.015)
    box("rust_patch", (0.12, 0.01, 0.1), (0.15, -0.35, z + 0.12), M["rust"])
    for k in range(7):
        box(f"belt_{k}", (0.06, 0.05, 0.03), (0.2 - k * 0.025, 0.05, z - 0.02 - k * 0.07), M["brass"])
    return {"type": "weapon", "size": [1.6, 2.6, 1.5], "mass_kg": 120}


def weapon_gatling():
    """2. Gatling: a six-barrel minigun on a tripod, motor, ammo box, cables (MACHINE GUN TURRETS / SINGLE-BARREL MINIGUN sheet)."""
    M = _wpn_mats()
    _tripod(M, col="steel_l")
    z = 1.15
    for i in range(6):
        a = i * math.pi / 3
        cyl(f"barrel_{i}", 0.028, 1.05, (math.cos(a) * 0.075, -0.65, z + math.sin(a) * 0.075), M["steel"],
            rot=(math.radians(90), 0, 0), seg=6)
    for yy in (-1.12, -0.5):
        cyl(f"clamp_{yy}", 0.12, 0.06, (0, yy, z), M["steel_l"], rot=(math.radians(90), 0, 0), seg=10)
    box("motor", (0.3, 0.45, 0.3), (0, 0.0, z), M["steel_l"], bevel=0.03)
    box("handle", (0.06, 0.3, 0.2), (0, 0.05, z + 0.25), M["steel"])
    box("ammo_box", (0.32, 0.36, 0.3), (0.34, 0.1, z - 0.05), M["olive"], bevel=0.02)
    box("feed", (0.08, 0.3, 0.08), (0.18, 0.0, z + 0.08), M["brass"])
    for k, c in enumerate(("red", "black")):
        box(f"cable_{k}", (0.03, 0.03, 0.55), (0.12 + k * 0.05, 0.25, z - 0.3), M[c], rot=(0.4, 0, 0))
    box("rust_patch", (0.1, 0.15, 0.01), (0, -0.05, z + 0.16), M["rust"])
    return {"type": "weapon", "size": [1.6, 2.4, 1.5], "mass_kg": 140}


def weapon_flamer():
    """3. Flamethrower: a pedestal, two fuel tanks, hoses, a barrel with a nozzle and an igniter (sheet
    style: olive, rust, stripes)."""
    M = _wpn_mats()
    cyl("base", 0.55, 0.16, (0, 0, 0.08), M["steel"], seg=12)
    for i in range(8):
        a = i * math.pi / 4
        box(f"stripe_{i}", (0.18, 0.06, 0.17), (math.cos(a) * 0.5, math.sin(a) * 0.5, 0.09),
            M["yellow" if i % 2 else "black"], rot=(0, 0, a))
    cyl("pedestal", 0.16, 0.6, (0, 0, 0.45), M["olive_d"], seg=10)
    box("body", (0.5, 0.7, 0.32), (0, 0.05, 0.9), M["olive"], bevel=0.04)
    for sx in (-1, 1):
        cyl(f"tank_{sx}", 0.17, 0.75, (sx * 0.36, 0.2, 0.95), M["red"], seg=10)
        ico(f"tank_cap_{sx}", 0.17, (sx * 0.36, 0.2, 1.32), M["red"], sub=1, squash=0.5)
        box(f"hose_{sx}", (0.05, 0.4, 0.05), (sx * 0.2, -0.05, 0.8), M["black"])
    cyl("nozzle", 0.06, 0.9, (0, -0.7, 0.95), M["steel"], rot=(math.radians(90), 0, 0), seg=8)
    cyl("nozzle_tip", 0.09, 0.14, (0, -1.18, 0.95), M["steel_l"], rot=(math.radians(90), 0, 0), seg=8)
    box("igniter", (0.05, 0.08, 0.08), (0, -1.2, 0.86), M["yellow"])
    box("shield", (0.55, 0.05, 0.38), (0, -0.32, 1.05), M["olive"], bevel=0.02)
    box("rust_patch", (0.12, 0.01, 0.12), (-0.12, -0.36, 1.08), M["rust"])
    return {"type": "weapon", "size": [1.3, 2.2, 1.4], "mass_kg": 160}


def weapon_rocket():
    """4. Rocket launcher: a 4-tube pack on a rotating base, red warhead tips, stripes, a camera
    (4-PACK ROCKET LAUNCHER sheet)."""
    M = _wpn_mats()
    cyl("base", 0.62, 0.18, (0, 0, 0.09), M["steel"], seg=14)
    for i in range(10):
        a = i * math.pi / 5
        box(f"stripe_{i}", (0.2, 0.06, 0.19), (math.cos(a) * 0.58, math.sin(a) * 0.58, 0.1),
            M["yellow" if i % 2 else "black"], rot=(0, 0, a))
    box("yoke", (0.6, 0.45, 0.45), (0, 0.05, 0.42), M["olive_d"], bevel=0.04)
    box("pod", (0.86, 0.9, 0.78), (0, 0.0, 0.98), M["olive"], bevel=0.05)
    for ix in (-1, 1):
        for iz in (-1, 1):
            cyl(f"tube_{ix}_{iz}", 0.19, 0.55, (ix * 0.21, -0.55, 0.98 + iz * 0.2), M["olive_d"], rot=(math.radians(90), 0, 0), seg=10)
            cyl(f"mouth_{ix}_{iz}", 0.15, 0.04, (ix * 0.21, -0.83, 0.98 + iz * 0.2), M["black"], rot=(math.radians(90), 0, 0), seg=10)
            ico(f"tip_{ix}_{iz}", 0.11, (ix * 0.21, -0.86, 0.98 + iz * 0.2), M["red"], sub=1, squash=1.0)
    box("hazard", (0.25, 0.01, 0.1), (0.25, -0.46, 1.33), M["yellow"])
    box("cam", (0.18, 0.22, 0.14), (0.18, -0.25, 1.42), M["steel_l"])
    box("cam_lens", (0.08, 0.02, 0.08), (0.18, -0.37, 1.42), M["glass"])
    box("rust_patch", (0.01, 0.3, 0.15), (0.42, 0.1, 0.9), M["rust"])
    for k, c in enumerate(("red", "black")):
        box(f"cable_{k}", (0.03, 0.03, 0.5), (-0.3 + k * 0.06, 0.25, 0.5), M[c], rot=(0.3, 0, 0))
    return {"type": "weapon", "size": [1.4, 2.0, 1.6], "mass_kg": 400}


def weapon_cannon():
    """5. Cannon: an armoured turret, paired heavy barrels, a shell belt, a pedestal on struts
    (upgrade sheet, HEAVY CANNON)."""
    M = _wpn_mats()
    for i in range(4):
        a = math.radians(45 + i * 90)
        box(f"strut_{i}", (0.12, 0.6, 0.12), (math.cos(a) * 0.45, math.sin(a) * 0.45, 0.25), M["olive_d"], rot=(0.5, 0, a + math.pi / 2))
        box(f"pad_{i}", (0.22, 0.22, 0.05), (math.cos(a) * 0.7, math.sin(a) * 0.7, 0.03), M["olive_d"])
    cyl("pedestal", 0.36, 0.55, (0, 0, 0.45), M["steel"], seg=12)
    cyl("ring", 0.46, 0.1, (0, 0, 0.75), M["olive_d"], seg=12)
    box("turret", (0.95, 0.95, 0.6), (0, 0.05, 1.1), M["olive"], bevel=0.08)
    box("mantlet", (0.7, 0.2, 0.4), (0, -0.48, 1.08), M["olive_d"], bevel=0.03)
    for sx in (-1, 1):
        cyl(f"barrel_{sx}", 0.075, 1.3, (sx * 0.18, -1.1, 1.08), M["steel"], rot=(math.radians(90), 0, 0), seg=10)
        cyl(f"brake_{sx}", 0.11, 0.16, (sx * 0.18, -1.78, 1.08), M["steel"], rot=(math.radians(90), 0, 0), seg=10)
    box("hatch", (0.36, 0.36, 0.08), (0.15, 0.2, 1.44), M["olive_d"])
    box("ammo_drum", (0.3, 0.42, 0.42), (0.6, 0.15, 1.0), M["olive_d"], bevel=0.04)
    for k in range(6):
        box(f"shell_{k}", (0.07, 0.12, 0.07), (0.45 - k * 0.02, 0.0 - k * 0.04, 0.8 - k * 0.07), M["brass"])
    for sx in (-1, 1):
        box(f"plate_{sx}", (0.04, 0.6, 0.4), (sx * 0.5, 0.05, 1.1), M["steel_l"])
    box("hazard", (0.4, 0.01, 0.08), (0, -0.59, 1.32), M["yellow"])
    box("rust_patch", (0.2, 0.01, 0.15), (-0.25, -0.43, 1.2), M["rust"])
    return {"type": "weapon", "size": [1.5, 2.8, 1.6], "mass_kg": 900}


ITEMS = {
    "weapon_mg": weapon_mg,
    "weapon_gatling": weapon_gatling,
    "weapon_flamer": weapon_flamer,
    "weapon_rocket": weapon_rocket,
    "weapon_cannon": weapon_cannon,
    "turret_mg_nest": mg_nest,
    "soldier_aim": lambda: soldier("aim"),
    "soldier_kneel": lambda: soldier("kneel"),
    "car_sedan": lambda: car("sedan", (0.72, 0.62, 0.42)),
    "car_sedan_blue": lambda: car("sedan", (0.18, 0.3, 0.5)),
    "car_hatch": lambda: car("hatch", (0.62, 0.12, 0.08)),
    "car_van": lambda: car("van", (0.3, 0.36, 0.18)),
    "car_bus": lambda: car("bus", (0.85, 0.7, 0.12)),
    "car_burned": lambda: car("sedan", (0, 0, 0), burned=True),
    "car_burned_van": lambda: car("van", (0, 0, 0), burned=True),
    "prop_streetlamp": streetlamp,
    "prop_traffic_light": traffic_light,
    "prop_tree_a": lambda: tree(0),
    "prop_tree_b": lambda: tree(1),
    "prop_tree_c": lambda: tree(2),
    "prop_fence": fence,
    "prop_barricade": jersey,
    "prop_tank_trap": tank_trap,
    "prop_dumpster": dumpster,
    "prop_bus_stop": bus_stop,
    "prop_kiosk": kiosk,
    "prop_bench": bench,
    "prop_hydrant": hydrant,
    "prop_road_sign": road_sign,
    "prop_trash_bin": trash_bin,
}

bpy.ops.wm.read_factory_settings(use_empty=True)
info = {}
for name, fn in ITEMS.items():
    if ONLY and name not in ONLY:
        continue
    reset()
    meta = fn()
    meta["parts"] = [o.name for o in bpy.data.objects]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + ".glb"), export_format="GLB", use_selection=True)
    info[name] = meta
    print("PROP", name, len(meta["parts"]))
with open(os.path.join(OUT, "props.json"), "w", encoding="utf-8") as fh:
    json.dump(info, fh, ensure_ascii=False, indent=1)
