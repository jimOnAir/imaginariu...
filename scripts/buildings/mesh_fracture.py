"""mesh_fracture v2 - turns any finished building model (Pixal3D/Hunyuan + paint_from_concept) into a
destructible one so that the breaks look like the "Ruined_*" concepts: thick walls, floor slabs and
room partitions inside, chunks breaking into concrete blocks rather than thin "foil".

1. The shell gets a wall thickness (--wall; the inner surface uses material M_interior, "wallpaper").
2. Floor slabs are laid inside at every storey (M_slab) and some partitions (M_interior) - only where
   the point is inside the building (ray tests over the BVH).
3. A storey x bay grid cuts the model into chunks. The cut is filled with a ring (triangle_fill with
   holes, M_rubble): when the neighbouring chunk falls off, you see a room with a floor, not a grey
   stub.
4. Each chunk is pre-split into --split^3 rectangular blocks with jitter and slightly tilted planes.
5. Every chunk gets its mean facade colour (col) - the game paints the brick splash with it.

Run: blender -b --factory-startup -P mesh_fracture.py -- --in model.glb --out <folder> [--height 18 --cell 3.2
        --floor 3.0 --wall 0.35 --split 2]
Output: building.glb (chunk_*), building_frags.glb (frag__<chunk>__N), building_chunks.json,
        building_graph.json - the format is the same, the game's destruction code is shared with
        building_gen.py.
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


SRC = os.path.abspath(arg("--in", ""))
OUT = os.path.abspath(arg("--out", "fracture_out"))
CELL = float(arg("--cell", 3.2))
FLOOR = float(arg("--floor", 3.0))
HEIGHT = float(arg("--height", 0))   # >0: scale the model to this height (a repaint without height_m loses the scale)
WALL = float(arg("--wall", 0.35))    # wall thickness, m
SLAB = 0.25                          # floor slab thickness, m
SPLIT = int(arg("--split", 2))       # blocks per chunk edge
GRID = arg("--grid", "")             # grid.json from city_bldg: the room grid; such a model has its own walls and slabs
MARGIN = 0.5 if not GRID else 6.0    # the outer chunks absorb the protrusions (balconies, portico, antennas)
rng = random.Random(1)
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
src = bmesh.new()
mats = []
for o in meshes:   # everything into one mesh in world coordinates, materials in order
    me = o.data.copy()
    me.transform(o.matrix_world)
    base = len(mats)
    mats += list(me.materials)
    t = bmesh.new()
    t.from_mesh(me)
    for f in t.faces:
        f.material_index += base
    t.to_mesh(me)
    t.free()
    src.from_mesh(me)
N_SKIN = len(mats)


def _mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    mats.append(m)
    return len(mats) - 1


FILL = _mat("M_rubble", (0.42, 0.40, 0.37))     # the concrete break
SLABM = _mat("M_slab", (0.45, 0.38, 0.30))      # slabs: a floor from above, a ceiling from below
INT = _mat("M_interior", (0.62, 0.56, 0.44))    # wallpaper, partitions
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

# ---- skin textures for the mean chunk colour
images = {}
for i, m in enumerate(mats[:N_SKIN]):
    img = None
    if m and m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image is not None:
                img = n.image
                break
    if img is not None and img.size[0] > 0:
        px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        images[i] = px.reshape(img.size[1], img.size[0], 4)

# ---- scale, ground, centre
lo = Vector([min(v.co[i] for v in src.verts) for i in range(3)])
hi = Vector([max(v.co[i] for v in src.verts) for i in range(3)])
if HEIGHT > 0 and hi.z - lo.z > 1e-6:
    k = HEIGHT / (hi.z - lo.z)
    for v in src.verts:
        v.co *= k
    lo *= k
    hi *= k
shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
for v in src.verts:
    v.co -= shift
lo -= shift
hi -= shift
NX, NY, NZ = (max(1, math.ceil((hi.x - lo.x) / CELL)), max(1, math.ceil((hi.y - lo.y) / CELL)),
              max(1, math.ceil((hi.z - lo.z) / FLOOR)))
SX, SY, SZ = (hi.x - lo.x) / NX, (hi.y - lo.y) / NY, (hi.z - lo.z) / NZ
size_out = [hi.x - lo.x, hi.y - lo.y, hi.z - lo.z]
if GRID:
    g = json.load(open(GRID, encoding="utf-8"))
    lo = Vector(g["lo"]) - shift          # the model was moved to the ground/centre - the grid goes with it
    SX, SY, SZ = g["cell"]
    NX, NY, NZ = g["n"]
    size_out = g["size_m"]

# ---- 1. wall thickness: a copy of the shell pushed inward along the normals, flipped, "wallpaper"
# material (a city_bldg model has its own walls)
if GRID:
    bmesh.ops.recalc_face_normals(src, faces=src.faces[:])
    bvh = BVHTree.FromBMesh(src)
bmesh.ops.recalc_face_normals(src, faces=src.faces[:]) if not GRID else None
if not GRID:
    bvh = BVHTree.FromBMesh(src)          # the outer shell - for the "is the point inside" test
    dup = bmesh.ops.duplicate(src, geom=src.faces[:])
    new_faces = [g for g in dup["geom"] if isinstance(g, bmesh.types.BMFace)]
    new_verts = [g for g in dup["geom"] if isinstance(g, bmesh.types.BMVert)]
    src.normal_update()
    for v in new_verts:
        v.co -= v.normal * WALL
    bmesh.ops.reverse_faces(src, faces=new_faces)
    for f in new_faces:
        f.material_index = INT


def inside(p, margin=0.0):
    """A point inside the shell: crossing parity over 5 rays, majority vote; and not closer than margin
    to a wall."""
    votes = 0
    for d in (Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, 1, 0)), Vector((0, -1, 0)), Vector((0, 0, 1))):
        n = 0
        o = p.copy()
        for _ in range(48):
            loc, _no, _i, _d = bvh.ray_cast(o, d)
            if loc is None:
                break
            n += 1
            o = loc + d * 1e-3
        votes += n % 2
    if votes < 3:
        return False
    if margin > 0:
        near = bvh.find_nearest(p)
        if near[0] is not None and near[3] < margin:
            return False
    return True


def add_box(bm, c, size, mat):
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    for v in t.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + c
    for f in t.faces:
        f.material_index = mat
    me = bpy.data.meshes.new("tmp")
    t.to_mesh(me)
    t.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


# ---- 2. slabs and partitions (4x4 tiles per bay, only inside the building)
TILES = 4
n_slab = n_wall = 0
for k in (range(1, NZ) if not GRID else []):
    z = lo.z + k * SZ + 0.02 + SLAB / 2
    for i in range(NX):
        for j in range(NY):
            tw, td = SX / TILES, SY / TILES
            for a in range(TILES):
                for b in range(TILES):
                    c = Vector((lo.x + i * SX + (a + 0.5) * tw, lo.y + j * SY + (b + 0.5) * td, z))
                    if inside(c, WALL + 0.05):
                        add_box(src, c, (tw - 0.02, td - 0.02, SLAB), SLABM)
                        n_slab += 1
for k in (range(NZ) if not GRID else []):
    zc = lo.z + k * SZ + 0.02 + SLAB + (SZ - SLAB - 0.04) / 2
    hz = SZ - SLAB - 0.06
    for i in range(1, NX):
        for j in range(NY):
            if rng.random() < 0.45:        # a partition across X
                x = lo.x + i * SX + 0.12
                for b in range(TILES):
                    c = Vector((x, lo.y + j * SY + (b + 0.5) * SY / TILES, zc))
                    if inside(c, WALL + 0.05):
                        add_box(src, c, (0.14, SY / TILES - 0.02, hz), INT)
                        n_wall += 1
    for i in range(NX):
        for j in range(1, NY):
            if rng.random() < 0.35:        # a partition across Y
                y = lo.y + j * SY + 0.12
                for a in range(TILES):
                    c = Vector((lo.x + i * SX + (a + 0.5) * SX / TILES, y, zc))
                    if inside(c, WALL + 0.05):
                        add_box(src, c, (SX / TILES - 0.02, 0.14, hz), INT)
                        n_wall += 1
print("INTERIOR slabs", n_slab, "walls", n_wall)


def cut(bm, co, no):
    """Keep the part on the -no side of the plane; fill the cut with a ring (holes stay holes), normals out."""
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no, clear_outer=True, dist=1e-5)
    edges = [e for e in bm.edges if len(e.link_faces) < 2
             and abs((e.verts[0].co - co).dot(no)) < 1e-3 and abs((e.verts[1].co - co).dot(no)) < 1e-3]
    if not edges:
        return
    r = bmesh.ops.triangle_fill(bm, use_beauty=False, use_dissolve=False, edges=edges)
    faces = [f for f in r["geom"] if isinstance(f, bmesh.types.BMFace)]
    flip = []
    for f in faces:
        f.material_index = FILL
        f.normal_update()
        if f.normal.dot(no) < 0:
            flip.append(f)
    if flip:
        bmesh.ops.reverse_faces(bm, faces=flip)


def slab(bm_src, axis, a, b):
    bm = bm_src.copy()
    n = Vector((0, 0, 0))
    n[axis] = 1
    cut(bm, n * b, n)
    cut(bm, n * a, -n)
    return bm


def to_obj(name, bm, origin, coll):
    for v in bm.verts:
        v.co -= origin
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    o.location = origin
    coll.objects.link(o)
    return o


def skin_color(bm):
    """The mean skin colour of a chunk from the texture (up to 160 faces)."""
    uv = bm.loops.layers.uv.active
    acc = np.zeros(3)
    n = 0
    if not images:                    # a textureless model (city_bldg): the facade material colour weighted by area
        wsum = 0.0
        for f in bm.faces:
            m = mats[f.material_index] if f.material_index < N_SKIN else None
            if m is None or not m.name.startswith(("S_panel", "S_brick", "S_plaster", "S_concrete")):
                continue
            a = f.calc_area()
            acc += np.array(m.diffuse_color[:3]) * a
            wsum += a
        return [round(float(x), 3) for x in acc / wsum] if wsum > 0 else None
    faces = [f for f in bm.faces if f.material_index < N_SKIN and f.material_index in images]
    if uv is None or not faces:
        return None
    for f in faces[:: max(1, len(faces) // 160)]:
        px = images[f.material_index]
        u = sum(l[uv].uv.x for l in f.loops) / len(f.loops)
        w = sum(l[uv].uv.y for l in f.loops) / len(f.loops)
        x = int((u % 1.0) * (px.shape[1] - 1))
        y = int((w % 1.0) * (px.shape[0] - 1))
        acc += px[y, x, :3]
        n += 1
    if n == 0:
        return None
    c = (acc / n) ** (1 / 2.2)       # to sRGB, as the game sees it
    return [round(float(x), 3) for x in c]


def jitter_plane(center, axis, span):
    """A block split plane: +/-12% shift and up to ~7 deg tilt, so the blocks are not perfect cubes."""
    no = Vector((0, 0, 0))
    no[axis] = 1
    for ax in range(3):
        if ax != axis:
            no[ax] = rng.uniform(-0.12, 0.12)
    co = center.copy()
    co[axis] += rng.uniform(-0.12, 0.12) * span
    return co, no.normalized()


chunks_col = bpy.data.collections.new("chunks")
frags_col = bpy.data.collections.new("frags")
bpy.context.scene.collection.children.link(chunks_col)
bpy.context.scene.collection.children.link(frags_col)
CH = []
cells = {}
n_frag = 0
for k in range(NZ):          # hierarchical: storey -> column -> cell
    z0, z1 = lo.z + k * SZ - (MARGIN if k == 0 else 0), lo.z + (k + 1) * SZ + (MARGIN if k == NZ - 1 else 0)
    fz = slab(src, 2, z0, z1)
    if not fz.faces:
        fz.free()
        continue
    for i in range(NX):
        fx = slab(fz, 0, lo.x + i * SX - (MARGIN if i == 0 else 0), lo.x + (i + 1) * SX + (MARGIN if i == NX - 1 else 0))
        if not fx.faces:
            fx.free()
            continue
        for j in range(NY):
            c = slab(fx, 1, lo.y + j * SY - (MARGIN if j == 0 else 0), lo.y + (j + 1) * SY + (MARGIN if j == NY - 1 else 0))
            if len(c.faces) < 4:
                c.free()
                continue
            center = Vector((lo.x + (i + 0.5) * SX, lo.y + (j + 0.5) * SY, lo.z + (k + 0.5) * SZ))
            name = f"chunk_f{k}_x{i}_y{j}"
            skin = sum(f.calc_area() for f in c.faces if f.material_index < N_SKIN)
            inner = sum(f.calc_area() for f in c.faces if f.material_index == SLABM) / 2
            mass = max(200.0, skin * WALL * 2400 + inner * SLAB * 2400)
            col = skin_color(c)
            frag_src = c.copy()
            to_obj(name, c, center, chunks_col)
            c.free()
            cells[(i, j, k)] = name
            kind = "roof" if k == NZ - 1 else ("facade" if i in (0, NX - 1) or j in (0, NY - 1) else "slab")
            rec = {"name": name, "kind": kind, "floor": k, "bay": i, "row": j, "mass_kg": round(mass, 1),
                   "box": [SX, SY, SZ], "box_off": [0, 0, 0]}
            if col:
                rec["col"] = col
            CH.append(rec)
            # 4. blocks: SPLIT planes per axis with jitter
            planes = []
            for ax, span in ((0, SX), (1, SY), (2, SZ)):
                ps = []
                for m in range(1, SPLIT):
                    p = center.copy()
                    p[ax] = center[ax] - span / 2 + span * m / SPLIT
                    ps.append(jitter_plane(p, ax, span / SPLIT))
                planes.append(ps)
            idx = 0
            for a in range(SPLIT):
                for b in range(SPLIT):
                    for cz in range(SPLIT):
                        fb = frag_src.copy()
                        for ax, s in ((0, a), (1, b), (2, cz)):
                            ps = planes[ax]
                            if s > 0:
                                co, no = ps[s - 1]
                                cut(fb, co, -no)
                            if s < SPLIT - 1:
                                co, no = ps[s]
                                cut(fb, co, no)
                        if len(fb.faces) >= 4:
                            cc = sum((v.co for v in fb.verts), Vector()) / len(fb.verts)
                            to_obj(f"frag__{name}__{idx}", fb, cc, frags_col)
                            n_frag += 1
                        fb.free()
                        idx += 1
            frag_src.free()
        fx.free()
    fz.free()

links = []
for (i, j, k), a in cells.items():
    for di, dj, dk, ar in ((1, 0, 0, SY * SZ), (0, 1, 0, SX * SZ), (0, 0, 1, SX * SY)):
        b = cells.get((i + di, j + dj, k + dk))
        if b:
            links.append([a, b, round(ar * 0.25, 3)])   # strength by the joint area, corrected for the shell
grounded = [n for (i, j, k), n in cells.items() if k == 0]


def export(coll, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in coll.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True)


export(chunks_col, os.path.join(OUT, "building.glb"))
export(frags_col, os.path.join(OUT, "building_frags.glb"))
json.dump({"size_m": size_out, "grid": [NX, NY, NZ], "wall_m": WALL, "chunks": CH},
          open(os.path.join(OUT, "building_chunks.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
json.dump({"links": links, "grounded": grounded}, open(os.path.join(OUT, "building_graph.json"), "w", encoding="utf-8"))
print("FRACTURE", SRC, "grid", NX, NY, NZ, "chunks", len(CH), "frags", n_frag, "links", len(links))
