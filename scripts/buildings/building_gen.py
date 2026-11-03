"""building_gen - a destructible panel building made of separate chunks (for "Zombie Defense" and any
city game).

The building is assembled from panels: every facade panel, floor slab, inner wall, balcony and roof
superstructure is a separate `chunk_*` object with its own metadata (floor, bay, side, mass). In the
game (Godot) the chunks become RigidBody3D and collapse for real; here deterministic damage stages are
built for the concept and fallback sprites:
  s0 intact - s1 hit (hole, scorch, debris) - s2 section collapse - s3 ruins - s4/s5 fragment burst.

Run (Blender without a window):
  blender -b --factory-startup -P building_gen.py -- --out <folder> [--bays 6] [--floors 5] [--seed 1]
      [--res 1600x1000] [--no-render] [--joined | --painted file.glb] [--plate]
Output: building.glb (intact, chunks as separate nodes), building_chunks.json, building.blend,
        building_frags.glb, building_graph.json, render/<view>_s<N>.png
        (view: game - the game camera from 60 deg above, iso - the showcase view).
Pixel art is made by scripts/pixel/pixelize.py over the renders (deterministic).
--joined writes one welded mesh (building_paint.glb) for painting in the forge; --painted takes the
painted mesh back apart into the original chunks.
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


OUT = os.path.abspath(arg("--out", "building_out"))
NX = int(arg("--bays", 6))          # bays along the facade
NY = 2                               # bays in depth
NF = int(arg("--floors", 5))
SEED = int(arg("--seed", 1))
RES = [int(v) for v in arg("--res", "1600x1000").split("x")]
RENDER = "--no-render" not in argv
PLATE = "--plate" in argv            # a ground plate (lawn, sidewalk) in building.glb - for fitting the concept and as a tile
BW, BD, FH = 3.2, 6.0, 2.9          # bay width, bay depth, floor height (m)
T = 0.24                             # panel thickness
GAP = 0.035                          # seam between panels
W, D, H = NX * BW, NY * BD, NF * FH
os.makedirs(os.path.join(OUT, "render"), exist_ok=True)
rng = random.Random(SEED)

# ---------------------------------------------------------------- scene and materials

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = bpy.data.collections.new("building")
scene.collection.children.link(COL)
ENV = bpy.data.collections.new("env")
scene.collection.children.link(ENV)

PALETTE = {
    "conc_a": (0.60, 0.58, 0.54), "conc_b": (0.72, 0.63, 0.47), "conc_c": (0.52, 0.52, 0.50),
    "seam": (0.16, 0.15, 0.14), "glass": (0.05, 0.07, 0.09), "frame": (0.42, 0.26, 0.12),
    "roof": (0.22, 0.22, 0.21), "rust": (0.45, 0.22, 0.10), "interior": (0.30, 0.26, 0.22),
    "slab": (0.48, 0.47, 0.45), "scorch": (0.06, 0.055, 0.05), "rubble": (0.42, 0.40, 0.37),
    "ground": (0.33, 0.30, 0.25), "walk": (0.55, 0.53, 0.49), "grass": (0.22, 0.32, 0.12),
    "brick": (0.45, 0.25, 0.18), "metal": (0.30, 0.31, 0.32),
}
MATS = {}
for name, rgb in PALETTE.items():
    m = bpy.data.materials.new("M_" + name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.35 if name == "glass" else 0.9
    m.diffuse_color = (*rgb, 1.0)
    MATS[name] = m

CHUNKS = []   # (obj, meta)


def add_box(bm, mats, center, size, mat, rot_z=0.0):
    """A box into a shared bmesh; mat is a material name, its slot is appended as needed."""
    if mat not in mats:
        mats.append(mat)
    idx = mats.index(mat)
    res = bmesh.ops.create_cube(bm, size=1.0)
    for v in res["verts"]:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        if rot_z:
            v.co.rotate(Euler((0, 0, rot_z)))
        v.co += Vector(center)
    for f in {f for v in res["verts"] for f in v.link_faces}:
        f.material_index = idx


def make_obj(name, parts, collection=COL, origin=None):
    """parts: [(center, size, mat)]; the object origin is `origin` (default: the bbox centre)."""
    if origin is None:
        lo = [min(c[i] - s[i] / 2 for c, s, _ in parts) for i in range(3)]
        hi = [max(c[i] + s[i] / 2 for c, s, _ in parts) for i in range(3)]
        origin = [(lo[i] + hi[i]) / 2 for i in range(3)]
    bm = bmesh.new()
    mats = []
    for c, s, m in parts:
        add_box(bm, mats, [c[i] - origin[i] for i in range(3)], s, m)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(MATS[m])
    ob = bpy.data.objects.new(name, me)
    ob.location = origin
    collection.objects.link(ob)
    return ob


def chunk(name, parts, **meta):
    """One destructible piece: its own object + JSON metadata in the custom property `chunk`."""
    ob = make_obj(name, parts)
    vol = sum(s[0] * s[1] * s[2] for _, s, _ in parts)
    meta.update(name=name, mass_kg=round(vol * 2400 * 0.6, 1), box=list(parts[0][1]),
                box_off=[parts[0][0][i] - ob.location[i] for i in range(3)])
    ob["chunk"] = json.dumps(meta)
    CHUNKS.append((ob, meta))
    return ob


# ---------------------------------------------------------------- the building

def facade_panel(side, bx, f):
    """An outer wall panel: side front(-Y)/back(+Y) runs along X, left(-X)/right(+X) along Y."""
    z0 = f * FH
    zc = z0 + FH / 2
    conc = rng.choice(["conc_a", "conc_a", "conc_b", "conc_c"])
    along_x = side in ("front", "back")
    span = BW if along_x else BD
    if along_x:
        x = -W / 2 + BW * (bx + 0.5)
        y = -D / 2 if side == "front" else D / 2
        out = -1 if side == "front" else 1
    else:
        y = -D / 2 + BD * (bx + 0.5)
        x = -W / 2 if side == "left" else W / 2
        out = -1 if side == "left" else 1
    parts = []

    def P(u, n, z, su, sn, sz, mat):
        # u - along the facade, n - outward from it
        if along_x:
            parts.append(((x + u, y + n * out, z), (su, sn, sz), mat))
        else:
            parts.append(((x + n * out, y + u, z), (sn, su, sz), mat))

    P(0, 0, zc, span - GAP, T, FH - GAP, conc)
    window = along_x or bx % 2 == 0
    if window and not (side == "front" and f == 0 and bx in ENTRANCES):
        ww = 1.5 if along_x else 1.1
        P(0, T / 2 + 0.005, zc + 0.15, ww + 0.16, 0.03, 1.46, "frame")
        P(0, T / 2 + 0.02, zc + 0.15, ww, 0.03, 1.3, "glass")
        P(0, T / 2 + 0.03, zc + 0.15, 0.06, 0.03, 1.3, "frame")
    if rng.random() < 0.18:  # a rust streak
        P(rng.uniform(-span / 3, span / 3), T / 2 + 0.012, zc - 0.5, 0.12, 0.01, 1.2, "rust")
    return parts


ENTRANCES = {1, NX - 2}
BALCONY = {b for b in range(NX) if b % 2 == 0}

for f in range(NF):
    for bx in range(NX):
        for side in ("front", "back"):
            parts = facade_panel(side, bx, f)
            if side == "front" and bx in BALCONY and f > 0:
                xb = -W / 2 + BW * (bx + 0.5)
                parts += [((xb, -D / 2 - 0.75, f * FH + 0.1), (BW * 0.8, 1.2, 0.18), "slab"),
                          ((xb, -D / 2 - 1.3, f * FH + 0.6), (BW * 0.8, 0.1, 0.9), "conc_c")]
            chunk("chunk_f%d_%s_%d" % (f, side, bx), parts, kind="facade", floor=f, bay=bx, side=side)
    for by in range(NY):
        for side in ("left", "right"):
            chunk("chunk_f%d_%s_%d" % (f, side, by), facade_panel(side, by, f),
                  kind="facade", floor=f, bay=by, side=side)
    # the floor of f+1: one slab per cell
    for bx in range(NX):
        for by in range(NY):
            cx, cy = -W / 2 + BW * (bx + 0.5), -D / 2 + BD * (by + 0.5)
            top = f == NF - 1
            parts = [((cx, cy, (f + 1) * FH - 0.11), (BW - GAP, BD - GAP, 0.22), "roof" if top else "slab")]
            if not top:
                parts.append(((cx, cy, (f + 1) * FH + 0.005), (BW - 0.3, BD - 0.3, 0.02), "interior"))
            chunk("chunk_f%d_slab_%d_%d" % (f, bx, by), parts, kind="roof" if top else "slab",
                  floor=f, bay=bx, row=by)
    # inner cross walls - a hole then shows "rooms"
    for bx in range(1, NX):
        for by in range(NY):
            cx, cy = -W / 2 + BW * bx, -D / 2 + BD * (by + 0.5)
            chunk("chunk_f%d_wall_%d_%d" % (f, bx, by),
                  [((cx, cy, f * FH + FH / 2), (0.16, BD - 0.4, FH - 0.25), "interior")],
                  kind="wall", floor=f, bay=bx, row=by)

# roof: parapet, stair hatches, vents, antennas
RZ = H
for bx in range(NX):
    x = -W / 2 + BW * (bx + 0.5)
    for y in (-D / 2, D / 2):
        chunk("chunk_roof_parapet_%d_%s" % (bx, "f" if y < 0 else "b"),
              [((x, y, RZ + 0.35), (BW - GAP, 0.3, 0.7), "conc_c")], kind="parapet", floor=NF, bay=bx)
for by in range(NY):
    y = -D / 2 + BD * (by + 0.5)
    for x in (-W / 2, W / 2):
        chunk("chunk_roof_parapet_s%d_%s" % (by, "l" if x < 0 else "r"),
              [((x, y, RZ + 0.35), (0.3, BD - GAP, 0.7), "conc_c")], kind="parapet", floor=NF, bay=by)
for i, bx in enumerate(sorted(ENTRANCES)):
    x = -W / 2 + BW * (bx + 0.5)
    chunk("chunk_roof_stair_%d" % i, [((x, 1.0, RZ + 1.2), (2.6, 3.0, 2.4), "conc_a"),
                                      ((x - 0.4, -0.52, RZ + 0.95), (0.9, 0.05, 1.9), "metal")],
          kind="roof_box", floor=NF, bay=bx)
for i in range(5):
    x = rng.uniform(-W / 2 + 1.5, W / 2 - 1.5)
    y = rng.uniform(-D / 2 + 1.5, D / 2 - 1.5)
    chunk("chunk_roof_vent_%d" % i, [((x, y, RZ + 0.45), (0.6, 0.6, 0.9), "brick"),
                                     ((x, y, RZ + 0.93), (0.75, 0.75, 0.08), "conc_c")], kind="vent", floor=NF)
for i in range(2):
    x = rng.uniform(-W / 3, W / 3)
    y = rng.uniform(-D / 4, D / 4)
    chunk("chunk_roof_antenna_%d" % i, [((x, y, RZ + 1.3), (0.06, 0.06, 2.6), "metal"),
                                        ((x, y, RZ + 2.3), (1.4, 0.05, 0.05), "metal"),
                                        ((x, y, RZ + 2.0), (1.0, 0.05, 0.05), "metal")], kind="antenna", floor=NF)
# entrance canopies
for bx in ENTRANCES:
    x = -W / 2 + BW * (bx + 0.5)
    chunk("chunk_canopy_%d" % bx, [((x, -D / 2 - 1.0, 2.4), (2.4, 2.0, 0.18), "conc_c"),
                                    ((x - 1.0, -D / 2 - 1.8, 1.2), (0.15, 0.15, 2.4), "conc_c"),
                                    ((x + 1.0, -D / 2 - 1.8, 1.2), (0.15, 0.15, 2.4), "conc_c"),
                                    ((x, -D / 2 + 0.01, 1.1), (1.2, T + 0.04, 2.2), "frame")],
          kind="canopy", floor=0, bay=bx)

# ground (not part of the building): asphalt, sidewalk, lawn
make_obj("ground", [((0, -4, -0.05), (W + 40, D + 40, 0.1), "ground"),
                    ((0, -D / 2 - 3.0, 0.03), (W + 6, 3.0, 0.06), "walk"),
                    ((0, D / 2 + 2.5, 0.03), (W + 6, 5.0, 0.06), "grass")], collection=ENV)

if PLATE:
    make_obj("lot_plate", [((0, -0.9, -0.2), (W + 4.0, D + 5.0, 0.4), "grass"),
                           ((0, -D / 2 - 2.2, 0.03), (W + 2.0, 1.6, 0.06), "walk")], collection=ENV)

BASE = {ob.name: (ob.location.copy(), ob.rotation_euler.copy(), ob.scale.copy(), list(ob.data.materials))
        for ob, _ in CHUNKS}

# ---------------------------------------------------------------- damage stages

BLAST = Vector((-W / 2 + BW * 1.0, -D / 2, FH * 1.5))   # a missile into the corner at floor 2, bays 0-1
DEBRIS = []


def reset():
    for ob, _ in CHUNKS:
        loc, rot, scl, mats = BASE[ob.name]
        ob.location, ob.rotation_euler, ob.scale = loc.copy(), rot.copy(), scl.copy()
        for i, m in enumerate(mats):
            ob.data.materials[i] = m
        ob.hide_render = False
    for ob in DEBRIS:
        bpy.data.objects.remove(ob, do_unlink=True)
    for fo in bpy.data.collections["fragments"].objects if "fragments" in bpy.data.collections else []:
        fo.hide_render = True
    DEBRIS.clear()


def scorch(ob, amount=1.0):
    """Soot: some concrete slots become scorch (the mesh slots are shared with BASE - reset restores them)."""
    for i, m in enumerate(ob.data.materials):
        if m and m.name.startswith(("M_conc", "M_slab", "M_roof", "M_interior")) and rng.random() < amount:
            ob.data.materials[i] = MATS["scorch"]


def rubble(n, center, radius, height, size=(0.3, 0.9)):
    """A pile of small debris in a cone."""
    for i in range(n):
        a, r = rng.uniform(0, math.tau), radius * math.sqrt(rng.random())
        p = Vector((center[0] + math.cos(a) * r, center[1] + math.sin(a) * r * 0.8, 0))
        p.z = max(0.1, height * (1 - r / radius)) * rng.uniform(0.4, 1.0)
        s = rng.uniform(*size)
        ob = make_obj("debris_%d" % len(DEBRIS),
                      [((0, 0, 0), (s, s * rng.uniform(0.5, 1.2), s * 0.5),
                        rng.choice(["rubble", "rubble", "conc_a", "scorch", "slab"]))], origin=(0, 0, 0))
        ob.location = p
        ob.rotation_euler = Euler([rng.uniform(-0.6, 0.6) for _ in range(2)] + [rng.uniform(0, math.tau)])
        DEBRIS.append(ob)


def fall_to_pile(ob, center, radius, height):
    """A chunk joins the pile: a random point of the cone, strong rotation, slightly "crushed" (scale)."""
    a, r = rng.uniform(0, math.tau), radius * math.sqrt(rng.random())
    ob.location = Vector((center[0] + math.cos(a) * r, center[1] + math.sin(a) * r * 0.75,
                          max(0.15, height * (1 - r / radius)) * rng.uniform(0.3, 1.0)))
    ob.rotation_euler = Euler((rng.uniform(-1.2, 1.2), rng.uniform(-1.2, 1.2), rng.uniform(0, math.tau)))
    ob.scale = Vector([rng.uniform(0.55, 0.9)] * 3)
    scorch(ob, 0.5)


def stage(n):
    reset()
    if n == 0:
        return
    if n == 1:
        for ob, meta in CHUNKS:
            d = (ob.location - BLAST).length
            if d < 3.6:
                ob.hide_render = True
            elif d < 6.5:
                push = (ob.location - BLAST).normalized() * rng.uniform(0.1, 0.35)
                ob.location += push
                ob.rotation_euler = Euler([rng.uniform(-0.12, 0.12) for _ in range(3)])
                scorch(ob, 0.7)
        rubble(70, (BLAST.x, BLAST.y - 2.5), 3.2, 1.0)
        return
    if n == 2:
        # the section above the hole (bays 0-1 of the facade, the front row) folds down
        pile = (BLAST.x, BLAST.y - 1.0)
        for ob, meta in CHUNKS:
            bx, f = meta.get("bay", 99), meta.get("floor", 0)
            side = meta.get("side")
            in_front_row = side in ("front", "left") or (side is None and meta.get("row", 0) == 0)
            if bx <= 1 and in_front_row and f >= 1 and meta["kind"] != "canopy":
                fall_to_pile(ob, pile, 5.5, 3.2)
            elif meta.get("side") == "left" and f >= 1:
                fall_to_pile(ob, pile, 5.5, 3.2)
            elif bx == 2 and f >= 1:
                # the neighbouring bay leans into the void
                ob.rotation_euler = Euler((0, rng.uniform(0.08, 0.22), 0))
                ob.location.x -= 0.3 * f
                scorch(ob, 0.5)
            elif (ob.location - BLAST).length < 8:
                scorch(ob, 0.4)
        rubble(160, pile, 5.5, 2.4)
        return
    if n == 3:
        for ob, meta in CHUNKS:
            f = meta.get("floor", 0)
            keep = f == 0 and meta["kind"] in ("facade", "wall") and rng.random() < 0.6
            keep = keep or (f == 1 and meta["kind"] == "facade" and rng.random() < 0.25)
            if keep:
                ob.rotation_euler = Euler([rng.uniform(-0.1, 0.1) for _ in range(3)])
                scorch(ob, 0.6)
            else:
                fall_to_pile(ob, (0, 0), max(W, D) * 0.62, 4.5)
        rubble(320, (0, 0), max(W, D) * 0.68, 3.5)


# ---------------------------------------------------------------- light, cameras, render

def setup_render():
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.45, 0.35, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    scene.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.color = (1.0, 0.86, 0.68)
    sun.data.angle = math.radians(1.5)
    sun.rotation_euler = Euler((math.radians(50), 0, math.radians(-35)))  # long shadows down-right, like the concept
    scene.collection.objects.link(sun)


def camera(name, elev_deg, yaw_deg, ortho):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho
    e, y = math.radians(elev_deg), math.radians(yaw_deg)
    target = Vector((0, -1.0, H * (0.6 if elev_deg > 45 else 0.35)))
    dirv = Vector((math.sin(y) * math.cos(e), -math.cos(y) * math.cos(e), math.sin(e)))
    cam.location = target + dirv * 80
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)
    return cam


def export_glb():
    reset()
    bpy.ops.object.select_all(action="DESELECT")
    for ob, _ in CHUNKS:
        ob.select_set(True)
    if PLATE:
        bpy.data.objects["lot_plate"].select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "building.glb"), export_format="GLB",
                              use_selection=True, export_extras=True, export_apply=True)
    meta = [dict(m, pos=[round(v, 3) for v in BASE[m["name"]][0]]) for _, m in CHUNKS]
    with open(os.path.join(OUT, "building_chunks.json"), "w", encoding="utf-8") as fh:
        json.dump({"size_m": [W, D, H], "bays": NX, "floors": NF, "seed": SEED,
                   "chunks": meta}, fh, ensure_ascii=False, indent=1)


# ---------------------------------------------------------------- fragments (Voronoi) and the link graph

FRAGS = {}   # chunk name -> [fragment objects]
FRAG_COL = bpy.data.collections.new("fragments")
scene.collection.children.link(FRAG_COL)


def voronoi_cells(src_me, seeds, fill_mat):
    """Voronoi cells of a chunk mesh (local coordinates): bisect along the bisector planes + patched
    break faces. UVs and outer materials are kept (bisect interpolates), the break gets fill_mat."""
    cells = []
    for i, s in enumerate(seeds):
        bm = bmesh.new()
        bm.from_mesh(src_me)
        for j, o in enumerate(seeds):
            if i == j:
                continue
            n = (o - s).normalized()
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(s + o) / 2, plane_no=n, clear_outer=True)
            edges = [e for e in bm.edges if len(e.link_faces) < 2]
            if edges:
                for f in bmesh.ops.holes_fill(bm, edges=edges, sides=0)["faces"]:
                    f.material_index = fill_mat
        if len(bm.faces) >= 4:
            cells.append(bm)
        else:
            bm.free()
    return cells


def fracture(ob, meta):
    """A chunk -> 3..12 fragments; the seeds sit inside the chunk's main box (parts[0])."""
    size, off = Vector(meta["box"]), Vector(meta["box_off"])
    vol = size.x * size.y * size.z
    k = max(3, min(12, int(vol / 0.35) + 3))
    seeds = [off + Vector([rng.uniform(-0.45, 0.45) * size[a] for a in range(3)]) for _ in range(k)]
    mats = list(ob.data.materials)
    out = []
    for n, bm in enumerate(voronoi_cells(ob.data, seeds, len(mats))):
        c = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
        for v in bm.verts:
            v.co -= c
        me = bpy.data.meshes.new("frag")
        bm.to_mesh(me)
        bm.free()
        for m in mats + [MATS["rubble"]]:
            me.materials.append(m)
        fo = bpy.data.objects.new("frag__%s__%d" % (ob.name, n), me)
        fo.location = ob.matrix_world @ c
        fo["frag_of"] = ob.name
        FRAG_COL.objects.link(fo)
        out.append(fo)
    FRAGS[ob.name] = out


def aabb(ob):
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return [min(p[a] for p in pts) for a in range(3)], [max(p[a] for p in pts) for a in range(3)]


def build_graph(tol=0.12):
    """Links between chunks whose bounding boxes touch; the contact area becomes the link strength."""
    boxes = {ob.name: aabb(ob) for ob, _ in CHUNKS}
    names = list(boxes)
    links = []
    for i, a in enumerate(names):
        la, ha = boxes[a]
        for b in names[i + 1:]:
            lb, hb = boxes[b]
            ov = [min(ha[k], hb[k]) - max(la[k], lb[k]) for k in range(3)]
            if all(o > -tol for o in ov):
                dims = sorted(max(o, 0.05) for o in ov)
                links.append([a, b, round(dims[1] * dims[2], 3)])   # the two larger overlaps = the contact area
    grounded = [n for n, (lo, _) in boxes.items() if lo[2] < 0.15]
    return links, grounded


bpy.context.view_layer.update()   # matrix_world and bound_box are only valid after a recompute


def export_joined(path):
    """One welded mesh (chunks + plate) for painting in the forge in a single pass."""
    tmp = bpy.data.collections.new("joined")
    scene.collection.children.link(tmp)
    src = [ob for ob, _ in CHUNKS] + ([bpy.data.objects["lot_plate"]] if PLATE else [])
    dups = []
    for ob in src:
        d = ob.copy()
        d.data = ob.data.copy()
        tmp.objects.link(d)
        dups.append(d)
    bpy.ops.object.select_all(action="DESELECT")
    for d in dups:
        d.select_set(True)
    bpy.context.view_layer.objects.active = dups[0]
    bpy.ops.object.join()
    dups[0].name = "building_joined"
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True)
    print("JOINED", path, len(dups[0].data.polygons))


def apply_paint(path):
    """The mesh painted by the forge goes back into the chunks: each face returns to the smallest chunk
    whose box contains its centre (identical seeds -> the chunk geometry equals what went out to paint)."""
    import numpy as np
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imp = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    bm_all = bmesh.new()
    mats = []
    for o in imp:
        me = o.data.copy()
        me.transform(o.matrix_world)
        base = len(mats)
        mats += list(me.materials)
        tmp = bmesh.new()
        tmp.from_mesh(me)
        for f in tmp.faces:
            f.material_index += base
        tmp.to_mesh(me)
        tmp.free()
        bm_all.from_mesh(me)
    for o in imp:
        bpy.data.objects.remove(o, do_unlink=True)
    bm_all.faces.ensure_lookup_table()
    cen = np.array([f.calc_center_median()[:] for f in bm_all.faces])
    owner = np.full(len(cen), -1)
    order = sorted(range(len(CHUNKS)), key=lambda i: math.prod(CHUNKS[i][1]["box"]))
    boxes = {i: aabb(CHUNKS[i][0]) for i in order}
    for i in order:
        lo, hi = np.array(boxes[i][0]) - 0.02, np.array(boxes[i][1]) + 0.02
        m = (owner < 0) & np.all((cen >= lo) & (cen <= hi), axis=1)
        owner[m] = i
    bm_all.to_mesh(painted := bpy.data.meshes.new("painted"))
    bm_all.free()
    for m in mats:
        painted.materials.append(m)
    for i, (ob, meta) in enumerate(CHUNKS):
        keep = set(np.nonzero(owner == i)[0].tolist())
        if not keep:
            continue
        bm = bmesh.new()
        bm.from_mesh(painted)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
        bmesh.ops.translate(bm, verts=bm.verts, vec=-ob.location)
        me = bpy.data.meshes.new(ob.name)
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(m)
        ob.data = me
    print("PAINT faces", len(cen), "assigned", int((owner >= 0).sum()))


if "--joined" in argv:
    export_joined(os.path.join(OUT, "building_paint.glb"))
    sys.exit(0)
if "--painted" in argv:
    apply_paint(os.path.abspath(arg("--painted", "")))
    BASE = {ob.name: (ob.location.copy(), ob.rotation_euler.copy(), ob.scale.copy(), list(ob.data.materials))
            for ob, _ in CHUNKS}
for ob, meta in CHUNKS:
    fracture(ob, meta)
LINKS, GROUNDED = build_graph()
print("FRAGS", sum(len(v) for v in FRAGS.values()), "LINKS", len(LINKS), "GROUNDED", len(GROUNDED))


def export_frags():
    bpy.ops.object.select_all(action="DESELECT")
    for fo in FRAG_COL.objects:
        fo.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "building_frags.glb"), export_format="GLB",
                              use_selection=True, export_extras=True, export_apply=True)


def explode(t=0.55, energy=1.0):
    """The frame `t` seconds after the blast: chunks inside the radius are replaced by fragments on ballistics."""
    reset()
    g = Vector((0, 0, -9.8))
    for fo in FRAG_COL.objects:
        fo.hide_render = True
    for ob, meta in CHUNKS:
        d = (ob.location - BLAST).length
        if d > 9.0 * energy:
            if d < 12:
                scorch(ob, 0.4)
            continue
        ob.hide_render = True
        for fo in FRAGS[ob.name]:
            p0 = BASE_FRAG[fo.name]
            r = p0 - BLAST
            speed = 26.0 * energy / (1 + r.length ** 1.3) * rng.uniform(0.6, 1.4)
            v = r.normalized() * speed + Vector((0, -2.0, rng.uniform(1, 5)))
            p = p0 + v * t + g * (0.5 * t * t)
            p.z = max(p.z, 0.15)
            fo.location = p
            fo.rotation_euler = Euler([rng.uniform(-3, 3) * t * speed / 6 for _ in range(3)])
            fo.hide_render = False
    rubble(90, (BLAST.x, BLAST.y - 3.0), 4.0, 0.8, size=(0.15, 0.4))


BASE_FRAG = {fo.name: fo.location.copy() for fo in FRAG_COL.objects}
for fo in FRAG_COL.objects:
    fo.hide_render = True

export_glb()
export_frags()
with open(os.path.join(OUT, "building_graph.json"), "w", encoding="utf-8") as fh:
    json.dump({"links": LINKS, "grounded": GROUNDED,
               "fragments": {k: [f.name for f in v] for k, v in FRAGS.items()}}, fh, ensure_ascii=False)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "building.blend"))
print("CHUNKS", len(CHUNKS), "SIZE", W, D, H)

if RENDER:
    setup_render()
    views = {"game": camera("cam_game", 60, 0, W * 1.6), "iso": camera("cam_iso", 35, 35, W * 1.45)}
    for n in range(6):
        rng.seed(SEED * 100 + n)
        if n < 4:
            stage(n)
        else:
            explode(t=0.35 if n == 4 else 0.8, energy=1.0 if n == 4 else 1.7)
        for vname, cam in views.items():
            scene.camera = cam
            scene.render.filepath = os.path.join(OUT, "render", "%s_s%d.png" % (vname, n))
            bpy.ops.render.render(write_still=True)
            print("RENDER", scene.render.filepath)
