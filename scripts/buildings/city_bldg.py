"""city_bldg - procedural city houses in the spirit of the "Zombie Defense" concepts (Soviet-era
development, pixel art from above).

The house has a real construction, so its ruins show breaks like the Ruined_* concepts: walls 0.3 m
thick with window openings (glass, frame, sometimes boarded or broken), floor slabs, room partitions
with doors, balconies, entrances with canopies, parapet, lift houses, vents, antennas, tanks.

Materials go by role, the pattern is drawn by the game (shaders matched by name):
  S_panel / S_brick / S_plaster / S_concrete - facade (base_color is the house colour), S_trim - bands
  and surrounds, S_glass - windows, S_frame - frames, S_roof, S_metal, S_wood, S_sign, S_door,
  M_slab - slabs (floor/ceiling), M_interior - wallpaper and partitions, M_rubble - the break (added
  by the cutting step).
UVs - an unwrap in metres in house coordinates (u along the wall, v up); the cut preserves it.

Run: blender -b --factory-startup -P city_bldg.py -- --style panel --seed 3 --out <folder>
Output: <folder>/model.glb (one mesh), <folder>/grid.json (the room grid for mesh_fracture --grid).
Styles: panel khrush tower school admin shop hotel brutal tenement (3-5 floors per the reference:
fire escapes, roller shutters, awnings, air conditioners, sandbags and roof tanks).
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


STYLE = arg("--style", "panel")
SEED = int(arg("--seed", 1))
OUT = os.path.abspath(arg("--out", "bldg_out"))
rng = random.Random(SEED * 7919 + sum(map(ord, STYLE)))
os.makedirs(OUT, exist_ok=True)

BW = 3.2      # bay (room width)
FH = 3.0      # floor height
T = 0.3       # wall thickness
SL = 0.22     # slab

# a style: floors, bays along the facade and in depth, facade skin, colours, window (w, h, sill),
# balconies, entrances
STYLES = {
    "panel": dict(floors=(9, 10), nx=(7, 9), ny=(4, 4), skin="S_panel",
                  colors=[(0.70, 0.68, 0.62), (0.74, 0.66, 0.52), (0.64, 0.66, 0.66)], win=(1.5, 1.4, 0.9),
                  balcony=0.5, entrances=3, headhouses=2),
    "khrush": dict(floors=(5, 5), nx=(9, 11), ny=(4, 4), skin="S_brick",
                   colors=[(0.55, 0.33, 0.25), (0.74, 0.70, 0.62), (0.62, 0.40, 0.30)], win=(1.4, 1.45, 0.85),
                   balcony=0.3, entrances=3, headhouses=0, tank=True),
    "tower": dict(floors=(14, 16), nx=(5, 5), ny=(5, 5), skin="S_panel",
                  colors=[(0.72, 0.72, 0.70), (0.66, 0.68, 0.72)], win=(1.5, 1.4, 0.9),
                  balcony=0.7, entrances=1, headhouses=1, antenna=True),
    "school": dict(floors=(3, 3), nx=(11, 13), ny=(4, 4), skin="S_plaster",
                   colors=[(0.80, 0.64, 0.40), (0.78, 0.70, 0.52)], win=(2.4, 1.8, 0.8),
                   balcony=0.0, entrances=1, headhouses=0, portico=True, trim=True),
    "admin": dict(floors=(5, 6), nx=(9, 9), ny=(4, 4), skin="S_plaster",
                  colors=[(0.70, 0.60, 0.56), (0.66, 0.66, 0.60)], win=(1.4, 2.0, 0.6),
                  balcony=0.0, entrances=1, headhouses=1, portico=True, trim=True, flag=True),
    "shop": dict(floors=(2, 2), nx=(5, 7), ny=(3, 3), skin="S_plaster",
                 colors=[(0.68, 0.58, 0.46), (0.60, 0.62, 0.58)], win=(1.6, 1.4, 0.9),
                 balcony=0.0, entrances=0, headhouses=0, storefront=True, sign=True),
    "hotel": dict(floors=(12, 14), nx=(7, 8), ny=(4, 4), skin="S_panel",
                  colors=[(0.78, 0.76, 0.70), (0.70, 0.72, 0.74)], win=(2.8, 1.2, 1.0),
                  balcony=0.0, entrances=1, headhouses=1, sign=True, roof_sign=True, storefront=True),
    "brutal": dict(floors=(9, 11), nx=(6, 7), ny=(5, 5), skin="S_concrete",
                   colors=[(0.50, 0.50, 0.48), (0.56, 0.54, 0.50)], win=(1.2, 1.6, 0.8),
                   balcony=0.0, entrances=1, headhouses=1, fins=True),
    # the reference tenement building: narrow, 3-5 floors, brick or plaster, life on the facade and roof
    "tenement": dict(floors=(3, 5), nx=(3, 6), ny=(3, 3), skin="S_brick",
                     skins=[("S_brick", [(0.52, 0.32, 0.24), (0.60, 0.42, 0.30), (0.46, 0.30, 0.24)]),
                            ("S_plaster", [(0.74, 0.62, 0.44), (0.70, 0.58, 0.46), (0.78, 0.68, 0.52), (0.64, 0.56, 0.46)])],
                     win=(1.2, 1.7, 0.8), balcony=0.0, entrances=1, headhouses=0, trim_p=0.6,
                     fire_escape=0.65, shutters=0.6, ac=0.25, sandbags=0.6, stilt_tank=0.35, hatch=True),
}
S = dict(STYLES[STYLE])
NF = rng.randint(*S["floors"])
NX = rng.randint(*S["nx"])
NY = rng.randint(*S["ny"])
W, D, H = NX * BW, NY * BW, NF * FH
X0, Y0 = -W / 2, -D / 2
if "skins" in S:
    S["skin"], S["colors"] = rng.choice(S["skins"])
if "trim_p" in S:
    S["trim"] = rng.random() < S["trim_p"]
skin_rgb = rng.choice(S["colors"])

bpy.ops.wm.read_factory_settings(use_empty=True)
MATS = []
MI = {}


def mat(name, rgb):
    if name in MI:
        return MI[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    m.diffuse_color = (*rgb, 1)
    MATS.append(m)
    MI[name] = len(MATS) - 1
    return MI[name]


SKIN = mat(S["skin"], skin_rgb)
TRIM = mat("S_trim", (0.86, 0.84, 0.78) if S["skin"] != "S_concrete" else (0.42, 0.42, 0.40))
GLASS = mat("S_glass", (0.10, 0.13, 0.16))
FRAME = mat("S_frame", (0.82, 0.80, 0.74) if rng.random() < 0.6 else (0.45, 0.30, 0.18))
ROOF = mat("S_roof", (0.26, 0.25, 0.24))
METAL = mat("S_metal", (0.36, 0.37, 0.38))
WOOD = mat("S_wood", (0.45, 0.33, 0.20))
DOOR = mat("S_door", (0.30, 0.22, 0.16))
SIGN = mat("S_sign", rng.choice([(0.75, 0.15, 0.10), (0.15, 0.35, 0.70), (0.85, 0.60, 0.10)]))
SLAB = mat("M_slab", (0.48, 0.46, 0.43))
INT = mat("M_interior", (0.62, 0.56, 0.44))
PLINTH = mat("S_concrete", (0.42, 0.41, 0.39)) if S["skin"] != "S_concrete" else SKIN
SHUTTER = mat("S_shutter", rng.choice([(0.55, 0.55, 0.52), (0.48, 0.50, 0.46), (0.58, 0.52, 0.40)]))
AWNING = mat("S_awning", rng.choice([(0.62, 0.22, 0.14), (0.25, 0.40, 0.30), (0.70, 0.52, 0.22), (0.35, 0.33, 0.45)]))
SAND = mat("S_sand", (0.62, 0.50, 0.30))

bm = bmesh.new()
uvl = bm.loops.layers.uv.new("UVMap")


def box(c, size, m, out=None, inner=None, rot=None):
    """A box. `out` is the outward vector of the wall: faces along it get m, opposite ones get inner
    (wallpaper), the ends get m. `rot` rotates around the centre (Euler, radians): stair flights,
    awnings, sandbags."""
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    R = Euler(rot).to_matrix() if rot else None
    for v in t.verts:
        p = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        v.co = (R @ p if R else p) + Vector(c)
    t.normal_update()
    for f in t.faces:
        f.material_index = m
        if out is not None and inner is not None and f.normal.dot(Vector(out)) < -0.5:
            f.material_index = inner
    me = bpy.data.meshes.new("t")
    t.to_mesh(me)
    t.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def cyl(c, r, h, m, seg=10):
    t = bmesh.new()
    bmesh.ops.create_cone(t, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=h)
    for v in t.verts:
        v.co += Vector(c)
    for f in t.faces:
        f.material_index = m
    me = bpy.data.meshes.new("t")
    t.to_mesh(me)
    t.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


# ---------------------------------------------------------------- slabs, plinth, roof
box((0, 0, SL - (0.5 + SL) / 2), (W + 0.4, D + 0.4, 0.5 + SL), PLINTH)                      # plinth (its top = floor 1)
for k in range(1, NF + 1):
    box((0, 0, k * FH + SL / 2), (W, D, SL), SLAB)                           # slabs: the bottom exactly at k*FH
box((0, 0, NF * FH + SL + 0.03), (W - 2 * T, D - 2 * T, 0.06), ROOF)          # roof slab
for sx, sy, w_, d_ in ((0, Y0 + 0.15, W, 0.3), (0, -Y0 - 0.15, W, 0.3), (X0 + 0.15, 0, 0.3, D), (-X0 - 0.15, 0, 0.3, D)):
    box((sx, sy, NF * FH + SL + 0.35), (w_, d_, 0.7), TRIM if S.get("trim") else SKIN)   # parapet


# ---------------------------------------------------------------- facade walls with windows
def window_kind():
    r = rng.random()
    return "board" if r < 0.08 else ("broken" if r < 0.2 else "glass")


def wall_bay(side, i, k, kind="window"):
    """The wall of one bay of one floor. side: S(-Y, the face the game sees) N E W; i - the bay along the wall."""
    z0, z1 = k * FH + SL, (k + 1) * FH
    hz = z1 - z0
    if side in "SN":
        n = Vector((0, -1, 0)) if side == "S" else Vector((0, 1, 0))
        along = Vector((1, 0, 0))
        a0 = X0 + i * BW
        base = Vector((0, (Y0 if side == "S" else -Y0) - n.y * T / 2, 0))
        span = BW
        a_off = a0
    else:
        n = Vector((1, 0, 0)) if side == "E" else Vector((-1, 0, 0))
        along = Vector((0, 1, 0))
        a0 = Y0 + i * BW
        base = Vector(((-X0 if side == "E" else X0) - n.x * T / 2, 0, 0))
        span = BW
        a_off = a0
        if i == 0:                      # end walls fit between the longitudinal ones - no double corners
            a_off, span = a0 + T, BW - T
        elif i == NY - 1:
            span = BW - T

    def piece(u0, u1, v0, v1, m=SKIN):
        c = base + along * (a_off + (u0 + u1) / 2) + Vector((0, 0, z0 + (v0 + v1) / 2))
        sz = along * (u1 - u0) + Vector((0, 0, v1 - v0)) + Vector((abs(n.x), abs(n.y), 0)) * T
        box(c, (abs(sz.x), abs(sz.y), sz.z), m, out=n, inner=INT)

    if kind == "solid":
        piece(0, span, 0, hz)
        return
    ww, wh, sill = S["win"]
    if kind in ("store", "shutter"):
        ww, wh, sill = span - 0.5, hz - 0.6, 0.15
    if kind == "door":
        ww, wh, sill = 1.4, 2.2, 0.0
    ww = min(ww, span - 0.4)
    u0 = (span - ww) / 2
    piece(0, u0, 0, hz)                              # piers
    piece(u0 + ww, span, 0, hz)
    if sill > 0:
        piece(u0, u0 + ww, 0, sill)                  # under-sill part
    piece(u0, u0 + ww, sill + wh, hz)                # lintel
    wc = base + along * (a_off + u0 + ww / 2) + Vector((0, 0, z0 + sill + wh / 2))
    recess = wc + n * 0.03          # the glass sits 0.12 m from the wall face
    if kind == "door":
        box(recess - n * 0.05, (ww if n.y else 0.08, 0.08 if n.y else ww, wh), DOOR)
        cz = z0 + wh + 0.15
        cc = base + along * (a_off + u0 + ww / 2) + n * (T / 2 + 0.6)
        box((cc.x, cc.y, cz), (ww + 1.2 if n.y else 1.2, 1.2 if n.y else ww + 1.2, 0.15), TRIM)   # canopy
        return
    if kind == "shutter":      # a shop roller shutter + an awning above it
        box(recess, (ww if n.y else 0.05, 0.05 if n.y else ww, wh), SHUTTER)
        if rng.random() < 0.7:
            ac = base + along * (a_off + u0 + ww / 2) + n * (T / 2 + 0.55)
            tilt = 0.45 * (1 if (n.y < 0 or n.x > 0) else -1)
            box((ac.x, ac.y, z0 + sill + wh + 0.25), (ww + 0.3 if n.y else 1.2, 1.2 if n.y else ww + 0.3, 0.06), AWNING,
                rot=(tilt if n.y else 0, 0 if n.y else tilt, 0))
        return
    wk = window_kind() if kind == "window" else "glass"
    if kind == "window" and S.get("ac") and k_floor(z0) > 0 and rng.random() < S["ac"]:     # AC under the window
        acc = base + along * (a_off + u0 + ww / 2 + rng.uniform(-0.3, 0.3)) + n * (T / 2 + 0.26)
        box((acc.x, acc.y, z0 + sill - 0.35), (0.75 if n.y else 0.5, 0.5 if n.y else 0.75, 0.48), METAL)
    if wk == "glass":
        box(recess, (ww if n.y else 0.04, 0.04 if n.y else ww, wh), GLASS)
    elif wk == "board":
        for p in range(3):
            z = z0 + sill + wh * (0.2 + 0.3 * p)
            bc = wc + n * (T / 2 + 0.03)
            box((bc.x, bc.y, z), (ww + 0.2 if n.y else 0.05, 0.05 if n.y else ww + 0.2, 0.22), WOOD)
    # frame: the mullion and the transom
    if wk != "board":
        mc = recess + n * 0.03
        box(mc, (0.06 if n.y else 0.05, 0.05 if n.y else 0.06, wh), FRAME)
        box((mc.x, mc.y, z0 + sill + wh * 0.62), (ww if n.y else 0.05, 0.05 if n.y else ww, 0.05), FRAME)
    if S.get("trim"):                                # white window surrounds
        tc = base + along * (a_off + u0 + ww / 2) + n * (T / 2 + 0.04)
        box((tc.x, tc.y, z0 + sill + wh + 0.08), (ww + 0.3 if n.y else 0.08, 0.08 if n.y else ww + 0.3, 0.16), TRIM)
        if sill > 0:
            box((tc.x, tc.y, z0 + sill - 0.06), (ww + 0.3 if n.y else 0.1, 0.1 if n.y else ww + 0.3, 0.1), TRIM)


def k_floor(z):
    return int(z // FH)


door_bays = set()
if S["entrances"]:
    step = max(1, NX // S["entrances"])
    door_bays = {min(NX - 1, step // 2 + e * step) for e in range(S["entrances"])}
if S.get("portico"):
    door_bays = {NX // 2}
for k in range(NF):
    for i in range(NX):
        for side in "SN":
            kind = "window"
            if k == 0 and side == "S" and i in door_bays:
                kind = "door"
            elif k == 0 and S.get("storefront") and side == "S":
                kind = "store"
            elif k == 0 and side == "S" and rng.random() < S.get("shutters", 0):
                kind = "shutter"
            elif side == "N" and rng.random() < 0.15:
                kind = "solid"
            wall_bay(side, i, k, kind)
    for j in range(NY):
        for side in "EW":
            wall_bay(side, j, k, "solid" if (STYLE in ("panel", "khrush", "hotel") or rng.random() < 0.5) else "window")

# ---------------------------------------------------------------- balconies, bands, fins
if S["balcony"] > 0:
    cols = [i for i in range(NX) if i not in door_bays and rng.random() < S["balcony"]]
    glazed = rng.random() < 0.4
    for i in cols:
        for k in range(1, NF):
            cx = X0 + i * BW + BW / 2
            y = Y0 - 0.6
            z = k * FH + SL
            box((cx, y, z - 0.08), (BW - 0.5, 1.2, 0.16), SLAB)                        # balcony slab
            if glazed and rng.random() < 0.7:
                box((cx, y - 0.55, z + 0.55), (BW - 0.5, 0.08, 1.0), SKIN, out=(0, -1, 0), inner=SKIN)
                box((cx, y - 0.55, z + 1.55), (BW - 0.5, 0.05, 0.9), GLASS)
            else:
                box((cx, y - 0.56, z + 0.5), (BW - 0.5, 0.08, 1.0), METAL if rng.random() < 0.5 else SKIN)
                for sx in (-1, 1):
                    box((cx + sx * (BW / 2 - 0.29), y, z + 0.5), (0.06, 1.2, 1.0), METAL)
            if rng.random() < 0.15:                                                     # junk on the balcony
                box((cx + rng.uniform(-0.8, 0.8), y, z + 0.3), (0.6, 0.6, 0.6), WOOD)
if S.get("trim"):
    for k in range(1, NF):                                                              # inter-floor bands
        for sy in (Y0 - 0.05, -Y0 + 0.05):
            box((0, sy, k * FH + 0.1), (W + 0.1, 0.12, 0.2), TRIM)
    box((0, Y0 - 0.1, NF * FH + SL + 0.8), (W + 0.3, 0.3, 0.3), TRIM)                     # cornice
if S.get("fins"):
    for i in range(NX + 1):
        box((X0 + i * BW, Y0 - 0.45, H / 2), (0.3, 0.9, H), SKIN)                         # vertical fins
if S.get("portico"):                                                                     # columned portico
    cx = X0 + (NX // 2) * BW + BW / 2
    pw = BW * 3
    for c in range(4):
        box((cx - pw / 2 + 0.4 + c * (pw - 0.8) / 3, Y0 - 2.0, FH * 0.75), (0.5, 0.5, FH * 1.5), TRIM)
    box((cx, Y0 - 1.6, FH * 1.5 + 0.2), (pw + 0.6, 4.0, 0.4), TRIM)
    box((cx, Y0 - 1.6, 0.12), (pw + 0.8, 4.2, 0.25), PLINTH)
if S.get("sign"):                                                                        # a sign board
    box((0, Y0 - 0.25, FH - 0.35 if S.get("storefront") else FH * 1.2), (min(W - 1, 12), 0.2, 0.7), SIGN)
if S.get("storefront"):
    box((0, Y0 - 0.6, FH + 0.25), (W, 1.2, 0.12), TRIM)                                   # showcase canopy

# ---------------------------------------------------------------- roof
roof_z = NF * FH + SL
for h in range(S["headhouses"]):
    hx = X0 + (h + 1) * W / (S["headhouses"] + 1)
    box((hx, BW * 0.2, roof_z + 1.3), (3.0, 3.2, 2.6), SKIN)                              # lift / stair house
    box((hx, BW * 0.2 - 1.62, roof_z + 1.0), (0.9, 0.06, 2.0), DOOR)
for v in range(rng.randint(2, 5)):
    box((rng.uniform(X0 + 1.5, -X0 - 1.5), rng.uniform(Y0 + 1.5, -Y0 - 1.5), roof_z + 0.4), (0.7, 0.7, 0.8), METAL)
if S.get("antenna") or rng.random() < 0.5:
    ax, ay = rng.uniform(X0 + 2, -X0 - 2), rng.uniform(Y0 + 2, -Y0 - 2)
    box((ax, ay, roof_z + 2.5), (0.08, 0.08, 5.0), METAL)
    for q in range(3):
        box((ax, ay, roof_z + 3.2 + q * 0.6), (1.6 - q * 0.4, 0.05, 0.05), METAL)
if S.get("tank"):
    cyl((X0 + W * 0.75, 0, roof_z + 1.8), 1.0, 1.8, METAL, 12)
    for c in range(4):
        box((X0 + W * 0.75 + (c % 2 - 0.5) * 1.2, (c // 2 - 0.5) * 1.2, roof_z + 0.45), (0.12, 0.12, 0.9), METAL)
if S.get("flag"):
    box((0, Y0 + 1.0, roof_z + 3.0), (0.1, 0.1, 6.0), METAL)
    box((0.9, Y0 + 1.0, roof_z + 5.3), (1.7, 0.05, 1.1), SIGN)
if S.get("roof_sign"):
    box((0, Y0 + 0.6, roof_z + 1.6), (W * 0.7, 0.25, 1.8), SIGN)
    for q in range(4):
        box((-W * 0.3 + q * W * 0.2, Y0 + 0.9, roof_z + 0.7), (0.1, 0.1, 1.4), METAL)

# ---------------------------------------------------------------- fire escape (zigzag stair flights on the facade)
if NF >= 3 and rng.random() < S.get("fire_escape", 0):
    side_e = rng.random() < 0.5            # on the end wall (E) or the front (S)
    bay = rng.randrange(NX) if not side_e else rng.randrange(NY)
    for k in range(1, NF):
        z = k * FH + SL
        if side_e:
            cx, cy = -X0 + 0.55, Y0 + bay * BW + BW / 2
            box((cx, cy, z - 0.05), (1.1, 2.8, 0.06), METAL)                              # platform
            box((cx + 0.52, cy, z + 0.5), (0.05, 2.8, 0.05), METAL)                       # railing
            for q in (-1, 1):
                box((cx + 0.52, cy + q * 1.38, z + 0.25), (0.05, 0.05, 0.6), METAL)
            if k < NF - 1:
                d = 1 if k % 2 else -1
                box((cx + 0.2, cy, z + FH / 2), (0.55, 3.6, 0.06), METAL, rot=(d * math.atan2(FH, 2.6), 0, 0))
        else:
            cx, cy = X0 + bay * BW + BW / 2, Y0 - 0.55
            box((cx, cy, z - 0.05), (2.8, 1.1, 0.06), METAL)
            box((cx, cy - 0.52, z + 0.5), (2.8, 0.05, 0.05), METAL)
            for q in (-1, 1):
                box((cx + q * 1.38, cy - 0.52, z + 0.25), (0.05, 0.05, 0.6), METAL)
            if k < NF - 1:
                d = 1 if k % 2 else -1
                box((cx, cy + 0.2, z + FH / 2), (3.6, 0.55, 0.06), METAL, rot=(0, d * math.atan2(FH, 2.6), 0))
    # the ladder to the ground
    lx, ly = ((-X0 + 0.9, Y0 + bay * BW + BW / 2 + 1.1) if side_e else (X0 + bay * BW + BW / 2 + 1.1, Y0 - 0.9))
    box((lx, ly, FH * 0.75 + 0.6), (0.06, 0.06, FH * 1.2), METAL)

# ---------------------------------------------------------------- the reference roof: sandbags, a tank on stilts, a hatch
roof_top = NF * FH + SL
if rng.random() < S.get("sandbags", 0):
    # an arc/row of sandbags along the front parapet and in the corner - shooter and turret positions
    for seg in range(rng.randint(1, 2)):
        x0 = rng.uniform(X0 + 1.0, -X0 - 4.0)
        for row in range(2):
            for i in range(6):
                bx = x0 + i * 0.62 + (0.3 if row else 0)
                box((bx, Y0 + 0.75, roof_top + 0.15 + row * 0.22), (0.6, 0.34, 0.22), SAND,
                    rot=(0, 0, rng.uniform(-0.12, 0.12)))
        for i in range(3):                                                              # the turn to the roof centre
            box((x0 - 0.35, Y0 + 1.3 + i * 0.62, roof_top + 0.15), (0.34, 0.6, 0.22), SAND, rot=(0, 0, rng.uniform(-0.12, 0.12)))
    for i in range(rng.randint(2, 5)):                                                  # ammo crates
        box((rng.uniform(X0 + 1, -X0 - 1), rng.uniform(Y0 + 1.5, -Y0 - 1), roof_top + 0.15), (0.6, 0.35, 0.3), WOOD)
if rng.random() < S.get("stilt_tank", 0):
    tx, ty = rng.uniform(X0 + 2, -X0 - 2), rng.uniform(0, -Y0 - 1.8)
    for c in range(4):
        box((tx + (c % 2 - 0.5) * 1.4, ty + (c // 2 - 0.5) * 1.4, roof_top + 1.0), (0.12, 0.12, 2.0), WOOD)
    cyl((tx, ty, roof_top + 2.9), 1.0, 1.8, WOOD, 12)
    t2 = bmesh.new()
    bmesh.ops.create_cone(t2, cap_ends=True, segments=12, radius1=1.1, radius2=0.1, depth=0.6)
    for v in t2.verts:
        v.co += Vector((tx, ty, roof_top + 4.1))
    for f in t2.faces:
        f.material_index = METAL
    me2 = bpy.data.meshes.new("t")
    t2.to_mesh(me2)
    t2.free()
    bm.from_mesh(me2)
    bpy.data.meshes.remove(me2)
if S.get("hatch"):
    box((rng.uniform(X0 + 1.5, -X0 - 1.5), rng.uniform(0.5, -Y0 - 1.2), roof_top + 0.5), (1.4, 1.4, 1.0), SKIN)

# ---------------------------------------------------------------- room partitions
for k in range(NF):
    z0, z1 = k * FH + SL, (k + 1) * FH
    for i in range(1, NX):
        for j in range(NY):
            if rng.random() < 0.55:
                x = X0 + i * BW
                y0, y1 = Y0 + j * BW + (T if j == 0 else 0.06), Y0 + (j + 1) * BW - (T if j == NY - 1 else 0.06)
                if rng.random() < 0.5:   # with a door opening
                    dy = rng.uniform(y0 + 0.5, y1 - 1.4)
                    box((x, (y0 + dy) / 2, (z0 + z1) / 2), (0.12, dy - y0, z1 - z0), INT)
                    box((x, (dy + 0.9 + y1) / 2, (z0 + z1) / 2), (0.12, y1 - dy - 0.9, z1 - z0), INT)
                    box((x, dy + 0.45, z1 - 0.3), (0.12, 0.9, 0.6), INT)
                else:
                    box((x, (y0 + y1) / 2, (z0 + z1) / 2), (0.12, y1 - y0, z1 - z0), INT)
    for j in range(1, NY):
        for i in range(NX):
            if rng.random() < 0.45:
                y = Y0 + j * BW
                x0, x1 = X0 + i * BW + (T if i == 0 else 0.06), X0 + (i + 1) * BW - (T if i == NX - 1 else 0.06)
                box(((x0 + x1) / 2, y, (z0 + z1) / 2), (x1 - x0, 0.12, z1 - z0), INT)
    for q in range(rng.randint(NX // 2, NX)):                                             # furniture: wardrobe/table/sofa
        fx, fy = rng.uniform(X0 + 0.8, -X0 - 0.8), rng.uniform(Y0 + 0.8, -Y0 - 0.8)
        sz = rng.choice([(0.6, 1.4, 1.9), (1.2, 0.7, 0.75), (1.8, 0.8, 0.8)])
        box((fx, fy, z0 + sz[2] / 2), sz, WOOD if rng.random() < 0.6 else METAL)

# ---------------------------------------------------------------- the metre unwrap and the output
bm.normal_update()
for f in bm.faces:
    n = f.normal
    ax = max(range(3), key=lambda a: abs(n[a]))
    for l in f.loops:
        p = l.vert.co
        if ax == 0:
            l[uvl].uv = (p.y - Y0, p.z)
        elif ax == 1:
            l[uvl].uv = (p.x - X0, p.z)
        else:
            l[uvl].uv = (p.x - X0, p.y - Y0)
me = bpy.data.meshes.new("building")
bm.to_mesh(me)
for m in MATS:
    me.materials.append(m)
ob = bpy.data.objects.new("building", me)
bpy.context.scene.collection.objects.link(ob)
bpy.ops.object.select_all(action="DESELECT")
ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "model.glb"), export_format="GLB", use_selection=True)
grid = {"lo": [X0 + 0.013, Y0 + 0.011, -0.01], "cell": [BW, BW, FH], "n": [NX, NY, NF], "style": STYLE, "seed": SEED,
        "size_m": [W, D, H], "skin": list(skin_rgb)}
json.dump(grid, open(os.path.join(OUT, "grid.json"), "w", encoding="utf-8"), indent=1)
print("CITY_BLDG", STYLE, SEED, "floors", NF, "bays", NX, NY, "faces", len(me.polygons))
