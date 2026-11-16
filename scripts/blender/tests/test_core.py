"""Self-tests of the core module: steps cleanup / convert / separate and _mesh_lib.

Synthetic tests build their inputs in tempfile.mkdtemp(); test_real_* use assets on disk and
return "skip: ..." when the file is missing. Run:

    blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- core
"""
import importlib
import math
import os
import tempfile
import time

import bmesh
import bpy
import mathutils
import numpy as np

import af_common as af
from steps import _mesh_lib as ml

# On-disk fixtures for the test_real_* cases (every one returns a "skip: ..." string when its file
# is missing). Environment overrides: AF_NECRO_GLB, AF_NECRO_HIGH_GLB, AF_ART_RAW.
NECRO = os.environ.get("AF_NECRO_GLB") or r"C:/AstraForge/test-assets/ReferenceFidelity/Corrected-necromancer.glb"
NECRO_HIGH = os.environ.get("AF_NECRO_HIGH_GLB") or r"C:/AstraForge/test-assets/ReferenceFidelity/Corrected-MC-high.glb"
ART_RAW = os.environ.get("AF_ART_RAW") or r"C:/AstraForge/test-assets/art/raw"
GRIFFIN = os.path.join(ART_RAW, "griffin", "model.glb")
ZOMBIE_RIG = os.path.join(ART_RAW, "zombie", "mixamo_rigged.fbx")

# Staff of the necromancer after normalisation to 1.8 m (feet on z=0, X/Y centred). Found by
# slicing the mesh in 5 cm bands (docs/forge/core.md): the shaft runs x 0.29..0.50,
# y -0.31..-0.18 from the ground to the fist (z 0.99..1.22), the head sits at x 0.42..0.62,
# z 1.45..1.80. The fist itself is left with the body.
STAFF_REGIONS = [
    {"name": "staff", "min": [0.285, -0.37, -0.01], "max": [0.52, -0.17, 0.70]},
    {"name": "staff", "min": [0.285, -0.37, 0.70], "max": [0.52, -0.21, 0.99]},
    {"name": "staff", "min": [0.38, -0.38, 1.22], "max": [0.66, -0.16, 1.81]},
]


# --------------------------------------------------------------------------- helpers

def _purge_stale_sessions(max_age_s=2 * 3600):
    """Old af_core_* session folders of earlier runs (only ours, only stale ones)."""
    import shutil
    root = tempfile.gettempdir()
    now = time.time()
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if name.startswith("af_core_") and os.path.isdir(path):
            try:
                if now - os.path.getmtime(path) > max_age_s:
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                pass


_purge_stale_sessions()
_SESSION = tempfile.mkdtemp(prefix="af_core_")  # every test writes below this folder


def _tmp():
    return tempfile.mkdtemp(dir=_SESSION)


def _run(step, inputs, params, out_dir=None):
    mod = importlib.import_module("steps." + step)
    req = {"step": step, "inputs": inputs, "params": params, "out_dir": out_dir or _tmp()}
    os.makedirs(req["out_dir"], exist_ok=True)
    res = mod.run(req)
    return af.finish(req, res)


def _check(res, name):
    for c in res["checks"]:
        if c["name"] == name:
            return c
    raise AssertionError("check %s missing: %s" % (name, [c["name"] for c in res["checks"]]))


def _half_texture(name="halves", size=64):
    """Image: left half (u < 0.5) red, right half blue."""
    img = bpy.data.images.new(name, size, size, alpha=False)
    px = np.zeros((size, size, 4), dtype=np.float32)
    px[..., 3] = 1.0
    px[:, : size // 2, 0] = 1.0
    px[:, size // 2:, 2] = 1.0
    img.pixels = px.ravel()
    img.pack()
    return img


def _textured_material(img):
    mat = bpy.data.materials.new("mat_" + img.name)
    mat.use_nodes = True
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], ml.principled_of(mat).inputs["Base Color"])
    return mat


def _sphere_glb(path, with_island=True, segments=48, rings=24):
    """UV sphere r=1 with the half texture, plus a tiny floating cube (an island)."""
    af.reset_scene()
    me = bpy.data.meshes.new("sphere")
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")  # calc_uvs writes into the active UV layer
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0,
                              calc_uvs=True)
    if with_island:
        ret = bmesh.ops.create_cube(bm, size=0.05)
        bmesh.ops.translate(bm, verts=ret["verts"], vec=(1.6, 0.0, 0.2))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("sphere", me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(_textured_material(_half_texture()))
    for poly in me.polygons:
        poly.use_smooth = True
    af.export_glb(path, objects=[ob], animations=False, skins=False)
    return path


def _cylinder(name, radius=0.05, height=2.0, segments=24, rings=40, z0=0.0):
    """Closed cylinder along Z with cylindrical UVs (a stand-in for a staff)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts_rings = []
    for r in range(rings + 1):
        z = z0 + height * r / rings
        ring = [bm.verts.new((radius * math.cos(2 * math.pi * s / segments),
                              radius * math.sin(2 * math.pi * s / segments), z))
                for s in range(segments)]
        verts_rings.append(ring)
    for r in range(rings):
        a, b = verts_rings[r], verts_rings[r + 1]
        for s in range(segments):
            bm.faces.new((a[s], a[(s + 1) % segments], b[(s + 1) % segments], b[s]))
    bm.faces.new(list(reversed(verts_rings[0])))
    bm.faces.new(verts_rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for l in f.loops:
            l[uv].uv = (math.atan2(l.vert.co.y, l.vert.co.x) / (2 * math.pi) + 0.5,
                        (l.vert.co.z - z0) / height)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _sample(img, uv):
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    x = np.clip((uv[:, 0] % 1.0 * w).astype(int), 0, w - 1)
    y = np.clip((uv[:, 1] % 1.0 * h).astype(int), 0, h - 1)
    return px[y, x, :3]


def _loop_colours(ob, img):
    me = ob.data
    nl = len(me.loops)
    uv = np.empty(nl * 2)
    me.uv_layers.active.data.foreach_get("uv", uv)
    lv = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    co = ml.mesh_arrays(me)["co"][lv]
    return co, _sample(img, uv.reshape(nl, 2))


def _imported_base_color(path):
    af.reset_scene()
    objs = af.import_any(path)
    rep = ml.texture_report(objs)
    sizes = [v["base_color"] for v in rep.values() if "base_color" in v]
    return objs, sizes


def _rigged_glb(path, height=1.7):
    """Skinned cylinder (2 bones) exported as GLB: re-importing it makes the glTF importer add
    its 2 m bone-shape 'Icosphere' in the collection glTF_not_exported."""
    af.reset_scene()
    body = _cylinder("Body", radius=0.15, height=height, segments=16, rings=12)
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    af.select_only([arm])
    bpy.ops.object.mode_set(mode="EDIT")
    hips = arm_data.edit_bones.new("hips")
    hips.head, hips.tail = (0, 0, 0), (0, 0, height / 2)
    chest = arm_data.edit_bones.new("chest")
    chest.head, chest.tail = (0, 0, height / 2), (0, 0, height)
    chest.parent = hips
    bpy.ops.object.mode_set(mode="OBJECT")
    g_hips, g_chest = body.vertex_groups.new(name="hips"), body.vertex_groups.new(name="chest")
    for v in body.data.vertices:
        w = min(1.0, max(0.0, v.co.z / height))
        g_hips.add([v.index], 1.0 - w, "REPLACE")
        g_chest.add([v.index], w, "REPLACE")
    body.parent = arm
    body.modifiers.new("Armature", "ARMATURE").object = arm
    af.export_glb(path, objects=None, animations=False, skins=True)
    return path


def _assert_rigged_inputs_clean(glb, height, d):
    """Rigged GLB through convert (FBX, GLB + height), cleanup join:false and separate loose:
    one mesh each, the right height, feet on z=0 and no bone-shape helper anywhere."""
    af.reset_scene()
    af.import_any(glb, purge_helpers=False)  # precondition: the raw importer still adds the helper
    assert bpy.data.collections.get("glTF_not_exported") is not None, \
        "test input does not trigger the importer helper any more"
    # (a) FBX without params: one mesh, stored height, nothing extra in the file
    res = _run("convert", {"mesh": glb}, {"format": "fbx"}, os.path.join(d, "fbx"))
    assert res["ok"], (res.get("error"), res["checks"])
    rt = res["stats"]["roundtrip"]
    # af.import_any now purges the helper itself, so the step may find nothing left to remove
    assert res["stats"]["import_helpers_removed"] in ([], ["Icosphere"]), res["stats"]
    assert rt["meshes"] == 1 and rt["armatures"] == 1, rt
    assert abs(rt["size"][2] - height) < 2e-3 * height and abs(rt["bbox_min"][2]) < 1e-3, rt
    af.reset_scene()
    names = [o.name for o in af.meshes(af.import_any(res["outputs"]["fbx"]))]
    assert len(names) == 1 and not any("Icosphere" in n for n in names), names
    # (b) GLB with height_m=1.8: the model, not the helper, is 1.8 m and grounded
    res = _run("convert", {"mesh": glb}, {"format": "glb", "height_m": 1.8},
               os.path.join(d, "glb"))
    assert res["ok"], (res.get("error"), res["checks"])
    rt = res["stats"]["roundtrip"]
    assert _check(res, "height_matches")["ok"] and _check(res, "grounded")["ok"], res["checks"]
    assert rt["meshes"] == 1 and abs(rt["size"][2] - 1.8) < 2e-3 and abs(rt["bbox_min"][2]) < 1e-3, rt
    # (c) cleanup join:false keeps the stored height, feet on z=0, one object
    res = _run("cleanup", {"mesh": glb}, {"join": False, "preview": False},
               os.path.join(d, "clean"))
    assert res["ok"], (res.get("error"), res["checks"])
    after = res["stats"]["after"]
    assert after["objects"] == 1 and abs(after["size"][2] - height) < 2e-3 * height, after
    assert abs(after["bbox_min"][2]) < 1e-4, after
    af.reset_scene()  # clean.blend is the current file after the step saved it
    with bpy.data.libraries.load(res["outputs"]["blend"]) as (src, _dst):
        assert not any("Icosphere" in n for n in src.objects), list(src.objects)
    # (d) separate loose: one real part, no fake 'small'
    res = _run("separate", {"mesh": glb}, {"mode": "loose", "preview": False},
               os.path.join(d, "sep"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["part_count"] == 1, res["stats"]["parts"]
    part = res["stats"]["parts"][0]
    assert part["name"] != "small" and abs(part["size"][2] - height) < 2e-3 * height, part
    assert abs(part["bbox_min"][2]) < 1e-4, part


def _vertex_colour_sphere(name="vc_sphere", with_material=True):
    """UV sphere r=1 with a colour attribute: red where x > 0, blue where x < 0 (corner domain),
    optionally a material that feeds the attribute into Base Color."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0)
    bm.to_mesh(me)
    bm.free()
    attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    nl = len(me.loops)
    lv = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    x = ml.mesh_arrays(me)["co"][lv, 0]
    col = np.zeros((nl, 4), dtype=np.float32)
    col[:, 3] = 1.0
    col[x >= 0, 0] = 1.0
    col[x < 0, 2] = 1.0
    attr.data.foreach_set("color", col.ravel())
    me.color_attributes.active_color = attr
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if with_material:
        mat = bpy.data.materials.new("vc_mat")
        mat.use_nodes = True
        node = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        node.layer_name = "Col"
        mat.node_tree.links.new(node.outputs["Color"], ml.principled_of(mat).inputs["Base Color"])
        me.materials.append(mat)
    return ob


def _red_blue_agreement(glb):
    """Share of loops whose baked colour says red on the +X side and blue on the -X side."""
    af.reset_scene()
    objs = ml.prepare_meshes(af.import_any(glb))
    low = objs[0]
    img = ml.image_into(low.data.materials[0], "Base Color").image
    co, col = _loop_colours(low, img)
    side = np.abs(co[:, 0]) > 0.15 * float(np.abs(co[:, 0]).max())
    good = np.where(co[side, 0] > 0, col[side, 0] > col[side, 2], col[side, 2] > col[side, 0])
    return float(good.mean())


# --------------------------------------------------------------------------- _mesh_lib

def test_components_matches_bfs():
    rng = np.random.default_rng(7)
    n = 3000
    edges = rng.integers(0, n, size=(1800, 2))
    labels = ml.components(n, edges)
    adj = [[] for _ in range(n)]
    for a, b in edges.tolist():
        adj[a].append(b)
        adj[b].append(a)
    seen = [-1] * n
    comp = 0
    for s in range(n):
        if seen[s] >= 0:
            continue
        stack = [s]
        seen[s] = comp
        while stack:
            v = stack.pop()
            for w in adj[v]:
                if seen[w] < 0:
                    seen[w] = comp
                    stack.append(w)
        comp += 1
    assert len(np.unique(labels)) == comp, (len(np.unique(labels)), comp)
    for a, b in edges.tolist():
        assert labels[a] == labels[b]


def test_metrics_and_islands():
    a = _cylinder("a")
    b = _cylinder("b", z0=3.0)
    ob = af.join([a, b], name="ab")
    m = ml.mesh_metrics([ob])
    assert m["loose_parts"] == 2, m
    assert m["boundary_edges"] == 0 and m["non_manifold_edges"] == 0, m
    assert m["nan_verts"] == 0
    # a tiny third piece is removed by the island filter, the two big ones stay
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.create_cube(bm, size=0.01)
    bm.to_mesh(ob.data)
    bm.free()
    parts, verts = ml.remove_small_islands(ob, 0.05)
    assert (parts, verts) == (1, 8), (parts, verts)
    assert ml.mesh_metrics([ob])["loose_parts"] == 2


def test_rotate_z_quaternion_mode():
    """glTF imports use quaternion rotation mode; rotate_z must still turn them."""
    ob = _cylinder("q", height=1.0)
    ob.rotation_mode = "QUATERNION"
    bpy.ops.mesh.primitive_cube_add()
    cube = bpy.context.active_object
    cube.rotation_mode = "QUATERNION"
    cube.scale = (2.0, 0.5, 0.5)
    bpy.context.view_layer.update()
    ml.rotate_z([cube], 90)
    lo, hi = af.world_bbox([cube])
    assert abs((hi - lo).x - 1.0) < 1e-4 and abs((hi - lo).y - 4.0) < 1e-4, (lo, hi)


def test_allocate_budget_protects_low_poly():
    # a 12-tri box next to big meshes stays whole; the rest is split in proportion
    b = ml.allocate_budget([12, 100000, 20000], 30000, 64)
    assert b[0] == 12 and sum(b) <= 30000 and b[1] > 4 * b[2] > 0, b
    # a mid object whose share would fall under the floor gets the floor
    b = ml.allocate_budget([500, 100000], 10000, 64)
    assert b[0] == 64 and b[1] == 9936, b
    # everything fits: nothing changes
    assert ml.allocate_budget([10, 20], 100) == [10, 20]
    # floors do not fit: plain proportional split, still >= 4 each
    b = ml.allocate_budget([1000, 1000, 1000], 90, 64)
    assert b == [30, 30, 30], b


def test_cut_by_boxes_closes_both_sides():
    ob = _cylinder("staff", radius=0.05, height=2.0)
    vol0 = ml.signed_volume(ob)
    part, info = ml.cut_by_boxes(ob, [([-0.2, -0.2, 1.2], [0.2, 0.2, 2.1])], "top")
    assert part is not None
    assert info["open_seam_edges"] == 0 and info["rest_open_seam_edges"] == 0, info
    for o in (part, ob):
        m = ml.mesh_metrics([o])
        assert m["boundary_edges"] == 0 and m["non_manifold_edges"] == 0, (o.name, m)
    v_top, v_rest = ml.signed_volume(part), ml.signed_volume(ob)
    assert v_top > 0 and v_rest > 0, (v_top, v_rest)
    assert abs(v_top + v_rest - vol0) < 0.01 * vol0, (v_top, v_rest, vol0)
    assert abs(v_top / vol0 - 0.4) < 0.02, v_top / vol0
    lo, hi = af.world_bbox([part])
    assert abs(lo.z - 1.2) < 1e-4 and abs(hi.z - 2.0) < 1e-4, (lo, hi)


# --------------------------------------------------------------------------- cleanup

def test_cleanup_synthetic_decimate_keeps_texture():
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"))
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "target_tris": 1000, "remove_islands_below": 0.01,
                "preview_size": 192}, os.path.join(d, "out"))
    assert res["ok"], res.get("error")
    s = res["stats"]
    assert s["before"]["boundary_edges"] > 0, s["before"]  # glTF split the UV seam open
    assert s["welded"]["boundary_edges"] == 0, s["welded"]  # ...and the weld closed it again
    assert s["welded"]["loose_parts"] == 1, s["welded"]     # tiny cube removed as an island
    assert s["islands_removed"] == 1 and s["island_verts_removed"] == 8, s
    assert s["after"]["tris"] <= 1000
    assert abs(s["after"]["size"][2] - 2.0) < 2e-3
    assert _check(res, "base_color_texture_kept")["ok"]
    # removing the island re-centres the sphere; the comparison frame must follow it
    # (it did not before the fix round: IoU 0.668 from a pure 0.31 m shift)
    assert s["render_compare"]["silhouette_iou"] >= 0.97, s["render_compare"]
    assert os.path.isfile(res["outputs"]["preview"]) and os.path.isfile(res["outputs"]["blend"])
    objs, sizes = _imported_base_color(res["outputs"]["glb"])
    assert sizes == [[64, 64]], sizes
    assert ml.mesh_metrics(objs)["tris"] <= 1000


def test_cleanup_planar_waits_for_collapse_on_heavy_meshes():
    """Ticket 49 (0.7.1-fold wave): the planar DISSOLVE on a huge mesh is the pathological slow
    pass (0.7.3 public-note fact, re-derived branch-side). Above planar_wait_above_tris the
    COLLAPSE stages run FIRST and planar only polishes the smaller mesh; planar_wait_above_tris=0
    restores the legacy order exactly; meshes under the threshold keep the old order at the
    default. This test proves the SEMANTICS fast - the threshold is a parameter, so the ORDER is
    verified on a small slab with a lowered threshold. The pathological COST is proven by the
    same-machine measurement table (Blender 5.2.2, 2026-11-16): the grid slab dissolves in
    2.7 s @ 40.8k tris, 3.7 s @ 91.2k, 14.4 s @ 116.9k, then CLIFFs to 185.8 s @ 145.9k,
    193.3 s @ 202.5k, > 2700 s at 410k without finishing - the default planar_wait_above_tris
    (120000, branch-measured just under the cliff edge) keeps the polishing pass in the fast
    zone by construction. (bmesh icospheres decimate to nothing on 5.2 for synthetic-topology
    reasons — they are NOT usable as decimation fixtures here.)"""
    def slab(cells, name):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=cells, y_segments=cells, size=1.0)
        res = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
        verts = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, verts=verts, vec=(0, 0, 0.1))
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(ob)
        bpy.context.view_layer.update()
        return ob, me

    def drop(ob, me):
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)

    ob, me = slab(100, "slab_wait_a")
    n0 = ml.tris_of(ob)
    assert n0 > 20000, n0
    log = ml.decimate_to(ob, 8000, planar_deg=0.5, planar_wait_above_tris=20000)
    names = [e["stage"] for e in log]
    assert names[0].startswith("collapse"), names
    pi = [i for i, n in enumerate(names) if n == "planar"]
    assert len(pi) == 1 and pi[0] > 0, names
    assert log[pi[0]]["tris_in"] <= 20000, log[pi[0]]
    assert ml.tris_of(ob) <= 8000, ml.tris_of(ob)
    drop(ob, me)

    ob, me = slab(100, "slab_wait_b")
    log = ml.decimate_to(ob, 8000, planar_deg=0.5, planar_wait_above_tris=0)   # legacy order
    assert log[0]["stage"] == "planar" and log[0]["tris_in"] > 20000, log[0]
    assert ml.tris_of(ob) <= 8000, ml.tris_of(ob)
    drop(ob, me)

    ob, me = slab(100, "slab_wait_c")                                          # under the default
    log = ml.decimate_to(ob, 8000, planar_deg=0.5)                             # default 120000
    assert log[0]["stage"] == "planar", log                                    # old order kept
    assert ml.tris_of(ob) <= 8000, ml.tris_of(ob)
    drop(ob, me)
    print("ticket 49 semantics OK on %d-tri slabs (threshold 20000); default 120000 measured "
          "under the cliff: 14.4s@116.9k vs 185.8s@145.9k" % n0, flush=True)


def test_cleanup_rotate_and_keep_scale():
    d = _tmp()
    af.reset_scene()
    bpy.ops.mesh.primitive_cube_add()
    cube = bpy.context.active_object
    cube.scale = (2.0, 0.5, 0.25)
    src = af.export_glb(os.path.join(d, "box.glb"), objects=[cube], animations=False,
                        skins=False)
    res = _run("cleanup", {"mesh": src}, {"rotate_z_deg": 90, "preview": False},
               os.path.join(d, "out"))
    assert res["ok"], res.get("error")
    size = res["stats"]["after"]["size"]
    assert abs(size[0] - 1.0) < 1e-3 and abs(size[1] - 4.0) < 1e-3 and abs(size[2] - 0.5) < 1e-3, size
    assert abs(res["stats"]["after"]["bbox_min"][2]) < 1e-5


def test_cleanup_without_join_splits_budget():
    d = _tmp()
    af.reset_scene()
    a = _cylinder("shaft", radius=0.05, segments=32, rings=60)
    b = _cylinder("guard", radius=0.3, height=0.1, segments=64, rings=6, z0=1.0)
    src = af.export_glb(os.path.join(d, "two.glb"), objects=[a, b], animations=False,
                        skins=False)
    t_in = ml.tris_of(a) + ml.tris_of(b)
    res = _run("cleanup", {"mesh": src}, {"join": False, "target_tris": t_in // 3,
                                          "preview": False}, os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["after"]["objects"] == 2, res["stats"]["after"]
    assert res["stats"]["after"]["tris"] <= t_in // 3
    af.reset_scene()
    names = sorted(o.name for o in af.meshes(af.import_any(res["outputs"]["glb"])))
    assert names == ["guard", "shaft"], names


def test_cleanup_voxel_remesh_bakes_colour():
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"), with_island=False)
    t0 = time.time()
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "voxel_remesh_m": 0.05, "target_tris": 2500, "bake_size": 128,
                "bake_samples": 2, "preview_size": 192}, os.path.join(d, "out"))
    assert res["ok"], res.get("error")
    assert time.time() - t0 < 120
    s = res["stats"]
    assert s["after"]["tris"] <= 2500 and s["bake"]["miss_fraction"] <= 0.02, s["bake"]
    assert os.path.isfile(res["outputs"]["baked_base_color"])
    # compare colours: original texture at original UVs vs baked texture at new UVs, matched by
    # nearest position — red/blue sides must agree
    af.reset_scene()
    orig = ml.prepare_meshes(af.import_any(src))[0]
    af.normalize([orig], height=2.0)
    co_a, col_a = _loop_colours(orig, ml.image_into(orig.data.materials[0], "Base Color").image)
    objs = ml.prepare_meshes(af.import_any(res["outputs"]["glb"]))
    low = objs[0]
    img = ml.image_into(low.data.materials[0], "Base Color").image
    co_b, col_b = _loop_colours(low, img)
    idx = np.random.default_rng(1).choice(len(co_b), size=min(1500, len(co_b)), replace=False)
    agree = 0
    for i in idx:
        j = int(np.argmin(((co_a - co_b[i]) ** 2).sum(axis=1)))
        agree += int((col_a[j, 0] > col_a[j, 2]) == (col_b[i, 0] > col_b[i, 2]))
    share = agree / float(len(idx))
    assert share > 0.9, share


def test_cleanup_remesh_bake_normal_shading_and_orphans():
    """bake_normal: normals fixed and shading set BEFORE the bake (fully smooth, no sharp
    edges), and clean.blend no longer carries the original map."""
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"), with_island=False)
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "voxel_remesh_m": 0.05, "target_tris": 2000, "bake_size": 128,
                "bake_samples": 2, "bake_normal": True, "preview": False}, os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert s["shading"] == "smooth (bake_normal)" and s["sharp_edges"] == 0, s["shading"]
    assert s["orphans_purged"] > 0, s["orphans_purged"]
    af.reset_scene()
    objs = af.import_any(res["outputs"]["blend"])
    body = af.meshes(objs)[0]
    smooth = np.zeros(len(body.data.polygons), dtype=bool)
    body.data.polygons.foreach_get("use_smooth", smooth)
    assert smooth.all() and ml.sharp_edge_count(body) == 0
    images = sorted(i.name for i in bpy.data.images)
    assert images and all(n.startswith("baked_") for n in images), images  # "halves" is gone


def test_cleanup_join_false_budgets():
    """join:false: a 12-tri box is left whole when decimating, and after a voxel remesh the
    budget is split over the remeshed counts (the box used to collapse into a tetrahedron)."""
    d = _tmp()
    af.reset_scene()
    ball = _cylinder("ball", radius=0.4, height=1.0, segments=96, rings=80)
    ball.data.materials.append(_textured_material(_half_texture()))
    bpy.ops.mesh.primitive_cube_add(size=0.5, location=(1.2, 0.0, 0.25))
    box = bpy.context.active_object
    box.name = "box"
    shaft = _cylinder("shaft", radius=0.1, height=1.0, segments=48, rings=60)
    shaft.location = (-1.2, 0.0, 0.0)
    src = af.export_glb(os.path.join(d, "three.glb"), objects=[ball, box, shaft],
                        animations=False, skins=False)
    res = _run("cleanup", {"mesh": src}, {"join": False, "target_tris": 3000,
                                          "preview_size": 192}, os.path.join(d, "dec"))
    assert res["ok"], (res.get("error"), res["checks"])
    af.reset_scene()
    tris = {o.name: ml.tris_of(o) for o in af.meshes(af.import_any(res["outputs"]["glb"]))}
    assert tris["box"] == 12 and sum(tris.values()) <= 3000, tris
    res = _run("cleanup", {"mesh": src}, {"join": False, "voxel_remesh_m": 0.04,
                                          "target_tris": 3000, "bake_size": 128,
                                          "bake_samples": 2, "preview_size": 192},
               os.path.join(d, "vox"))
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert s["after"]["tris"] <= 3000 and min(s["budgets"]) > 100, s["budgets"]
    assert s["render_compare"]["silhouette_iou"] >= 0.95, s["render_compare"]
    af.reset_scene()
    objs = {o.name: o for o in af.meshes(af.import_any(res["outputs"]["blend"]))}
    vol = ml.signed_volume(objs["box"])
    assert abs(vol - 0.125) < 0.15 * 0.125, vol  # a tetrahedron would keep a third of it


def test_cleanup_vertex_colours():
    """Vertex colours survive: decimation keeps the attribute, a remesh bakes it (through the
    material's Color Attribute node, or a temporary one when the mesh has no material), and the
    previews draw them (VERTEX mode) so render_color_mae can see a loss."""
    d = _tmp()
    af.reset_scene()
    ob = _vertex_colour_sphere()
    src = af.export_glb(os.path.join(d, "vc.glb"), objects=[ob], animations=False, skins=False)
    af.reset_scene()
    objs = af.import_any(src)
    assert ml.preview_color_type(objs) == "VERTEX"
    assert ml.color_source(af.meshes(objs)[0]) == "linked"
    res = _run("cleanup", {"mesh": src}, {"height_m": 2.0, "target_tris": 600,
                                          "preview_size": 160}, os.path.join(d, "dec"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["render_compare"]["color_mae"] <= 0.05, res["stats"]["render_compare"]
    res = _run("cleanup", {"mesh": src}, {"height_m": 2.0, "voxel_remesh_m": 0.05,
                                          "target_tris": 2000, "bake_size": 128,
                                          "bake_samples": 2, "preview_size": 160},
               os.path.join(d, "vox"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["bake"]["colour_source"] == "linked", res["stats"]["bake"]
    assert res["stats"]["render_compare"]["color_mae"] <= 0.08, res["stats"]["render_compare"]
    share = _red_blue_agreement(res["outputs"]["glb"])
    assert share > 0.95, share
    # no material at all, colours only in the attribute (.blend input)
    af.reset_scene()
    _vertex_colour_sphere("bare", with_material=False)
    blend = os.path.join(d, "bare.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend, copy=True)
    res = _run("cleanup", {"blend": blend}, {"height_m": 2.0, "voxel_remesh_m": 0.05,
                                             "target_tris": 2000, "bake_size": 128,
                                             "bake_samples": 2, "preview": False},
               os.path.join(d, "bare"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["bake"]["colour_source"] == "attribute", res["stats"]["bake"]
    share = _red_blue_agreement(res["outputs"]["glb"])
    assert share > 0.95, share


def test_inputs_blend_only():
    """The pipeline passes only {blend} after a step that wrote a .blend (cleanup -> separate)."""
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"), with_island=False)
    res = _run("cleanup", {"mesh": src}, {"height_m": 2.0, "target_tris": 1500,
                                          "preview": False}, os.path.join(d, "clean"))
    assert res["ok"], res.get("error")
    blend = res["outputs"]["blend"]
    res = _run("separate", {"blend": blend},
               {"mode": "regions", "regions": [{"name": "top", "min": [-2, -2, 1.2],
                                                "max": [2, 2, 2.1]}], "preview": False},
               os.path.join(d, "sep"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert sorted(p["name"] for p in res["stats"]["parts"]) == ["body", "top"]
    assert res["stats"]["input"] == os.path.abspath(blend)
    res = _run("convert", {"blend": blend}, {"format": "fbx"}, os.path.join(d, "fbx"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert _check(res, "roundtrip_base_color")["ok"] and res["stats"]["roundtrip"]["meshes"] == 1
    res = _run("cleanup", {"blend": blend}, {"target_tris": 800, "preview": False},
               os.path.join(d, "again"))
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["after"]["tris"] <= 800
    assert abs(res["stats"]["after"]["size"][2] - 2.0) < 2e-3, res["stats"]["after"]


def test_missing_input_is_reported():
    d = _tmp()
    missing = os.path.join(d, "no_such_model.glb")
    for step in ("cleanup", "convert", "separate"):
        try:
            _run(step, {"mesh": missing}, {}, os.path.join(d, step))
        except FileNotFoundError as exc:
            assert "inputs.mesh not found" in str(exc) and "no_such_model.glb" in str(exc), exc
        else:
            raise AssertionError("%s accepted a missing file" % step)
        try:
            _run(step, {}, {}, os.path.join(d, step + "_none"))
        except ValueError as exc:
            assert "inputs.mesh or inputs.blend" in str(exc), exc
        else:
            raise AssertionError("%s ran without inputs" % step)


def test_rigged_glb_helper_purged():
    d = _tmp()
    glb = _rigged_glb(os.path.join(d, "rigged.glb"), height=1.7)
    _assert_rigged_inputs_clean(glb, 1.7, d)


def _ridged_sphere_glb(path, flat_rgba=None, segments=160, rings=80, flip_top=False):
    """Dense sphere (~25k tris) with 16 sharp meridian ridges and no UVs: geometry-only detail
    like a Pixal3D mesh. flat_rgba: one flat Principled material, else no material at all.
    flip_top: the upper half faces inward (an AI mesh wound two ways)."""
    af.reset_scene()
    me = bpy.data.meshes.new("ridged")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for v in bm.verts:
        a = math.atan2(v.co.y, v.co.x)
        v.co *= 1.0 + 0.04 * abs(math.sin(8 * a)) ** 0.5
    if flip_top:
        bmesh.ops.reverse_faces(bm, faces=[f for f in bm.faces if f.calc_center_median().z > 0.0])
    bm.to_mesh(me)
    bm.free()
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    ob = bpy.data.objects.new("ridged", me)
    bpy.context.scene.collection.objects.link(ob)
    for poly in me.polygons:
        poly.use_smooth = True
    if flat_rgba is not None:
        mat = bpy.data.materials.new("bone")
        mat.use_nodes = True
        ml.principled_of(mat).inputs["Base Color"].default_value = flat_rgba
        me.materials.append(mat)
    af.export_glb(path, objects=[ob], animations=False, skins=False)
    return path


def _glb_json(path):
    import json
    import struct
    with open(path, "rb") as fh:
        fh.read(12)
        clen, _ = struct.unpack("<II", fh.read(8))
        return json.loads(fh.read(clen).decode("utf-8"))


def _normal_map_detail(glb, inverted=False):
    """(GLB materials with a normalTexture, share of normal-map texels tilted > ~6 deg from flat
    [, share of texels pointing INTO the surface: a source read inside out])."""
    g = _glb_json(glb)
    with_nrm = sum(1 for m in g.get("materials", []) if "normalTexture" in m)
    af.reset_scene()
    objs = af.import_any(glb)
    imgs = [ml.image_into(m, "Normal").image for o in af.meshes(objs) for m in o.data.materials
            if m is not None and ml.image_into(m, "Normal") is not None]
    if not imgs:
        return (with_nrm, 0.0, 1.0) if inverted else (with_nrm, 0.0)
    w, h = imgs[0].size
    px = np.empty(w * h * 4, dtype=np.float32)
    imgs[0].pixels.foreach_get(px)
    n = px.reshape(-1, 4)[:, :3] * 2.0 - 1.0
    tilted = float((n[:, 2] < 0.995).mean())
    return (with_nrm, tilted, float((n[:, 2] < 0.0).mean())) if inverted else (with_nrm, tilted)


def test_cleanup_bake_normal_source_wound_both_ways():
    """An open AI mesh can be wound two ways (one dense generated mesh: recalc turned 355k of 675k
    source faces against the decimated mesh, the map came out inside out in black patches). The
    bake source is two-sided (ml.two_sided), so its winding does not matter: half of
    the sphere faces inward and the map still has no texel pointing into the surface."""
    d = _tmp()
    src = _ridged_sphere_glb(os.path.join(d, "mixed.glb"), flip_top=True)
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "target_tris": 1200, "bake_normal": True, "bake_size": 256,
                "bake_samples": 1, "preview": False}, os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    with_nrm, tilted, inside = _normal_map_detail(res["outputs"]["glb"], inverted=True)
    # inside out it was 0.25..0.31; ~1 % is left where 256 px islands touch
    assert with_nrm == 1 and tilted > 0.05 and inside < 0.03, (with_nrm, tilted, inside)
    # the same through a voxel remesh (the source there is the welded original itself)
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "voxel_remesh_m": 0.02, "target_tris": 2000, "bake_normal": True,
                "bake_size": 256, "bake_samples": 1, "preview": False}, os.path.join(d, "vox"))
    assert res["ok"], (res.get("error"), res["checks"])
    with_nrm, tilted, inside = _normal_map_detail(res["outputs"]["glb"], inverted=True)
    assert with_nrm == 1 and inside < 0.03, (with_nrm, tilted, inside)


def test_cleanup_decimate_bake_normal_keeps_texture_uv():
    """A colour map on usable UVs: they are kept, the colour map stays the original 64 px one and
    the normal map is baked into the same material (no re-bake of the colour)."""
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"), with_island=False)
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "target_tris": 1000, "bake_normal": True, "bake_size": 128,
                "bake_samples": 1, "preview": False}, os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    b = res["stats"]["bake"]
    assert b["uv"] == "kept" and b["maps"] == ["normal"] and b["material_kept"], b
    assert _check(res, "base_color_texture_kept")["ok"] and _check(res, "normal_map_baked")["ok"]
    objs, sizes = _imported_base_color(res["outputs"]["glb"])
    assert sizes == [[64, 64]], sizes
    assert "normalTexture" in _glb_json(res["outputs"]["glb"])["materials"][0]


def test_cleanup_decimate_bake_normal_without_colour():
    """bake_normal without a remesh on a geometry-only mesh (the Pixal3D case): the welded original
    is copied, the mesh decimated, Smart UV'd, shaded fully smooth and the ridges baked into a
    tangent-space normal map that reaches the GLB as normalTexture. No material in = one plain
    material out; a flat material keeps its colour."""
    d = _tmp()
    src = _ridged_sphere_glb(os.path.join(d, "ridged.glb"))
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "target_tris": 1200, "bake_normal": True, "bake_size": 256,
                "bake_samples": 1, "preview_size": 160}, os.path.join(d, "bare"))
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert _check(res, "normal_map_baked")["ok"], res["checks"]
    assert s["after"]["tris"] <= 1200 and s["shading"] == "smooth (bake_normal)", s["shading"]
    assert s["sharp_edges"] == 0, s["sharp_edges"]
    b = s["bake"]
    assert b["maps"] == ["normal"] and b["uv"] == "smart_uv+pack_aabb" and b["material_kept"], b
    assert os.path.isfile(res["outputs"]["baked_normal"]), res["outputs"]
    assert s["render_compare"]["silhouette_iou"] >= 0.97, s["render_compare"]
    with_nrm, tilted = _normal_map_detail(res["outputs"]["glb"])
    assert with_nrm == 1 and tilted > 0.05, (with_nrm, tilted)
    # the high-poly copy is gone: one mesh in the blend
    af.reset_scene()
    assert len(af.meshes(af.import_any(res["outputs"]["blend"]))) == 1
    # one flat material: kept (same colour, same name), normal map added
    src2 = _ridged_sphere_glb(os.path.join(d, "flat.glb"), flat_rgba=(0.2, 0.6, 0.3, 1.0))
    res = _run("cleanup", {"mesh": src2},
               {"height_m": 2.0, "target_tris": 1200, "bake_normal": True, "bake_size": 256,
                "bake_samples": 1, "preview": False}, os.path.join(d, "flat"))
    assert res["ok"], (res.get("error"), res["checks"])
    g = _glb_json(res["outputs"]["glb"])
    assert [m["name"] for m in g["materials"]] == ["bone"], g["materials"]
    m = g["materials"][0]
    col = m["pbrMetallicRoughness"].get("baseColorFactor")
    assert "normalTexture" in m and col and abs(col[1] - 0.6) < 0.01, m
    assert "baseColorTexture" not in m["pbrMetallicRoughness"], m


def test_cleanup_remesh_bake_normal_without_colour():
    """voxel remesh + bake_normal on a mesh without colour used to bake nothing (the bake ran only
    for a colour source): now the flat material is kept and gets the normal map."""
    d = _tmp()
    src = _ridged_sphere_glb(os.path.join(d, "ridged.glb"), flat_rgba=(0.5, 0.5, 0.45, 1.0))
    res = _run("cleanup", {"mesh": src},
               {"height_m": 2.0, "voxel_remesh_m": 0.02, "target_tris": 2000, "bake_normal": True,
                "bake_size": 128, "bake_samples": 1, "preview": False}, os.path.join(d, "vox"))
    assert res["ok"], (res.get("error"), res["checks"])
    b = res["stats"]["bake"]
    assert b["maps"] == ["normal"] and b["colour_source"] is None, b
    assert _check(res, "normal_map_baked")["ok"]
    with_nrm, tilted = _normal_map_detail(res["outputs"]["glb"])
    assert with_nrm == 1 and tilted > 0.05, (with_nrm, tilted)


# --------------------------------------------------------------------------- convert

def test_convert_formats_roundtrip():
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"), with_island=False)
    for fmt in ("glb", "fbx", "obj"):
        res = _run("convert", {"mesh": src}, {"format": fmt, "height_m": 1.5},
                   os.path.join(d, "out_" + fmt))
        assert res["ok"], (fmt, res.get("error"), res["checks"])
        assert os.path.isfile(res["outputs"][fmt])
        assert _check(res, "roundtrip_base_color")["ok"], fmt
        assert abs(res["stats"]["roundtrip"]["size"][2] - 1.5) < 2e-3, res["stats"]["roundtrip"]


def test_convert_mixamo_fbx():
    d = _tmp()
    src = _sphere_glb(os.path.join(d, "sphere.glb"), segments=96, rings=48)
    res = _run("convert", {"mesh": src}, {"mixamo": True, "mixamo_max_tris": 3000},
               os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    rt = res["stats"]["roundtrip"]
    assert rt["tris"] <= 3000 and abs(rt["size"][2] - 1.8) < 2e-3, rt
    assert _check(res, "mixamo_single_mesh")["ok"]
    assert res["stats"]["welded_verts"] > 0


def _rigged_clipped_glb(path, height=1.7):
    """Skinned cylinder (2 bones) plus one keyframed clip "wave": the ticket-56 LOD fixture -
    every LOD must carry both the skin and the clip."""
    af.reset_scene()
    body = _cylinder("Body", radius=0.15, height=height, segments=16, rings=12)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
    bm.to_mesh(body.data)
    bm.free()
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    af.select_only([arm])
    bpy.ops.object.mode_set(mode="EDIT")
    hips = arm_data.edit_bones.new("hips")
    hips.head, hips.tail = (0, 0, 0), (0, 0, height / 2)
    chest = arm_data.edit_bones.new("chest")
    chest.head, chest.tail = (0, 0, height / 2), (0, 0, height)
    chest.parent = hips
    bpy.ops.object.mode_set(mode="OBJECT")
    g_hips, g_chest = body.vertex_groups.new(name="hips"), body.vertex_groups.new(name="chest")
    for v in body.data.vertices:
        w = min(1.0, max(0.0, v.co.z / height))
        g_hips.add([v.index], 1.0 - w, "REPLACE")
        g_chest.add([v.index], w, "REPLACE")
    body.parent = arm
    body.modifiers.new("Armature", "ARMATURE").object = arm
    act = bpy.data.actions.new("wave")
    arm.animation_data_create()
    arm.animation_data.action = act
    pb = arm.pose.bones["hips"]
    pb.rotation_euler = (0.0, 0.0, 0.0)
    pb.keyframe_insert("rotation_euler", frame=1)
    pb.rotation_euler = (math.radians(20), 0.0, 0.0)
    pb.keyframe_insert("rotation_euler", frame=12)
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 12
    return af.export_glb(path, objects=None, animations=True, skins=True)


def test_convert_lods_and_compact():
    """0.7.9 fold wave ticket 56: lods -> <name>_lodN.glb (af-mesh-rs hits the exact fraction,
    gltfpack -si approximates as the no-af-mesh fallback), compress -> <name>.compact.glb with
    EXT_meshopt_compression. Main and LOD files stay PLAIN GLB (Godot opens them) and every
    LOD carries the skin and the clip; stats.lods/compact carry the tool provenance."""
    conv = importlib.import_module("steps.convert")
    af_mesh, gltf = conv._af_mesh_rs(), conv._gltfpack()
    if not af_mesh and not gltf:
        print("SKIP convert lods: neither af-mesh-rs nor gltfpack found")
        return

    def gj(path):
        g = conv._glb_json(path)  # the step's own GLB reader: the files must parse with it too
        assert g is not None, path
        return g

    def tris(g):
        return conv._glb_tris(g)

    d = _tmp()
    src = _rigged_clipped_glb(os.path.join(d, "hero_src.glb"))
    res = _run("convert", {"mesh": src},
               {"format": "glb", "name": "hero", "lods": [0.5, 0.2], "compress": True},
               os.path.join(d, "main"))
    assert res["ok"], (res.get("error"), res["checks"])
    st, main = res["stats"], res["outputs"]["glb"]
    assert os.path.basename(main) == "hero.glb"
    main_tris = tris(gj(main))
    assert "EXT_meshopt_compression" not in (gj(main).get("extensionsUsed") or [])
    rows = st["lods"]
    assert [r["file"] for r in rows] == ["hero_lod1.glb", "hero_lod2.glb"], rows
    for r, frac in zip(rows, (0.5, 0.2)):
        g = gj(os.path.join(os.path.dirname(main), r["file"]))
        t = tris(g)
        assert t == r["tris"], (r, t)
        if af_mesh:  # the exact-fraction contract of the ticket (meshopt can be 1 triangle off)
            assert abs(t - r["target_tris"]) <= 1, r
            assert abs(t - main_tris * frac) <= max(2, 0.01 * main_tris * frac), (r, main_tris)
        else:  # the sanctioned no-af-mesh approximation (provenance says so)
            assert abs(t - main_tris * frac) <= max(4, 0.25 * main_tris * frac), (r, main_tris)
            assert r["tool"].startswith("gltfpack"), r
        assert len(g.get("skins", [])) == 1, r["file"]  # bones carried
        assert "wave" in [a["name"] for a in g.get("animations", [])], (r["file"], g.get("animations"))
        assert "EXT_meshopt_compression" not in (g.get("extensionsUsed") or [])
    if gltf:
        comp = res["outputs"]["compact"]
        assert os.path.basename(comp) == "hero.compact.glb"
        used = set((gj(comp).get("extensionsUsed") or []) + (gj(comp).get("extensionsRequired") or []))
        assert "EXT_meshopt_compression" in used, used
        assert "KHR_mesh_quantization" in used, used  # quantize defaults to on
        assert st["compact"]["quantize"] is True and st["compact"]["bytes"] == os.path.getsize(comp)
        # quantize off: meshopt compression without KHR_mesh_quantization (gltfpack -noq)
        res2 = _run("convert", {"mesh": src},
                    {"format": "glb", "name": "hero", "compress": True, "quantize": False},
                    os.path.join(d, "noq"))
        used2 = set((gj(res2["outputs"]["compact"]).get("extensionsUsed") or [])
                    + (gj(res2["outputs"]["compact"]).get("extensionsRequired") or []))
        assert "EXT_meshopt_compression" in used2, used2
        assert "KHR_mesh_quantization" not in used2, used2
    else:  # the honest absence row: a warning, the plain output untouched
        assert "compact" not in res["outputs"]
        assert any("gltfpack not found" in w for w in res["warnings"]), res["warnings"]
    # af-mesh-rs absent (but gltfpack present): the LOD falls back and says so in provenance
    if af_mesh and gltf:
        keep = conv._af_mesh_rs
        conv._af_mesh_rs = lambda: None
        try:
            res3 = _run("convert", {"mesh": src}, {"format": "glb", "name": "hero", "lods": [0.5]},
                        os.path.join(d, "fallback"))
        finally:
            conv._af_mesh_rs = keep
        assert res3["ok"], (res3.get("error"), res3["checks"])
        r3 = res3["stats"]["lods"][0]
        assert r3["tool"].startswith("gltfpack"), r3
        g3 = gj(res3["outputs"]["lod1"])
        assert abs(tris(g3) - r3["target_tris"]) <= max(4, 0.25 * r3["target_tris"]), (g3, r3)
        assert _check(res3, "lod1_tris")["ok"]
    # the plain outputs open in Godot (main + lod1) - the reason compact is a SEPARATE file
    from steps import _export_lib as _xl
    godot = _xl.find_godot()
    if godot:
        import shutil
        proj = _xl.make_check_project(os.path.join(d, "godot_smoke"))
        shutil.copy(main, proj)
        shutil.copy(os.path.join(os.path.dirname(main), "hero_lod1.glb"), proj)
        _code, out, _sec = _xl.run_godot(godot, proj, ["--import"], 300)
        bad = [ln for ln in out.splitlines() if "ERROR" in ln and "hero" in ln]
        assert not bad, bad or out[-1500:]
        imported = os.path.join(proj, ".godot", "imported")
        files = os.listdir(imported) if os.path.isdir(imported) else []
        assert any(f.startswith("hero.glb-") for f in files), files
        assert any(f.startswith("hero_lod1.glb-") for f in files), files


# --------------------------------------------------------------------------- separate

def test_separate_regions_union_and_rest():
    d = _tmp()
    af.reset_scene()
    ob = _cylinder("staff", radius=0.05, height=2.0)
    src = af.export_glb(os.path.join(d, "staff.glb"), objects=[ob], animations=False, skins=False)
    regions = [{"name": "ends", "min": [-0.2, -0.2, -0.1], "max": [0.2, 0.2, 0.6]},
               {"name": "ends", "min": [-0.2, -0.2, 1.4], "max": [0.2, 0.2, 2.1]}]
    res = _run("separate", {"mesh": src}, {"mode": "regions", "regions": regions,
                                           "preview_size": 160}, os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    parts = {p["name"]: p for p in res["stats"]["parts"]}
    assert set(parts) == {"ends", "body"}, parts.keys()
    assert parts["ends"]["loose_parts"] == 2 and parts["body"]["loose_parts"] == 1
    assert parts["ends"]["closed"] and parts["body"]["closed"], parts
    total = parts["ends"]["volume_m3"] + parts["body"]["volume_m3"]
    assert abs(parts["body"]["volume_m3"] / total - 0.4) < 0.03, parts
    af.reset_scene()
    objs = af.import_any(res["outputs"]["glb"])
    names = sorted(o.name for o in af.meshes(objs))
    assert names == ["body", "ends"], names


def test_separate_loose_and_material():
    d = _tmp()
    af.reset_scene()
    a = _cylinder("a")
    b = _cylinder("b", z0=3.0, radius=0.2, segments=48)  # more vertices -> listed first
    m1, m2 = bpy.data.materials.new("Wood"), bpy.data.materials.new("Iron")
    a.data.materials.append(m1)
    b.data.materials.append(m2)
    ob = af.join([a, b], name="ab")
    src = af.export_glb(os.path.join(d, "ab.glb"), objects=[ob], animations=False, skins=False)
    res = _run("separate", {"mesh": src}, {"mode": "loose", "names": ["big", "thin"],
                                           "preview": False}, os.path.join(d, "loose"))
    assert res["ok"] and res["stats"]["part_count"] == 2, res["stats"]
    by_name = {p["name"]: p for p in res["stats"]["parts"]}
    assert by_name["big"]["tris"] > by_name["thin"]["tris"]
    assert by_name["big"]["size"][0] > 3 * by_name["thin"]["size"][0]
    res = _run("separate", {"mesh": src}, {"mode": "material", "preview": False},
               os.path.join(d, "mat"))
    names = sorted(p["name"] for p in res["stats"]["parts"])
    assert res["ok"] and names == ["Iron", "Wood"], names


def test_runner_argument_parsing():
    import run_tests
    assert run_tests.parse_args(["blender", "--", "core,items", "-k", "real"]) == \
        (["core", "items"], "real", False)
    assert run_tests.parse_args(["blender", "--", "test_core", "--list"]) == (["core"], None, True)
    assert run_tests.parse_args(["blender"]) == ([], None, False)


# --------------------------------------------------------------------------- real assets

def test_real_griffin_cleanup():
    if not os.path.isfile(GRIFFIN):
        return "skip: " + GRIFFIN
    res = _run("cleanup", {"mesh": GRIFFIN},
               {"height_m": 1.6, "rotate_z_deg": -90, "target_tris": 8000,
                "remove_islands_below": 0.001})
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert s["before"]["loose_parts"] == 220 and s["after"]["loose_parts"] == 1, s["after"]
    assert s["after"]["tris"] <= 8000
    # the griffin faces +X as stored; after -90 deg the body length runs along Y
    assert s["after"]["size"][1] > s["after"]["size"][0] * 0.9, s["after"]["size"]
    assert _check(res, "base_color_texture_kept")["ok"] and _check(res, "uv_kept")["ok"]
    assert s["render_compare"]["silhouette_iou"] >= 0.97, s["render_compare"]


def test_real_million_tris_decimate():
    if not os.path.isfile(NECRO_HIGH):
        return "skip: " + NECRO_HIGH
    t0 = time.time()
    res = _run("cleanup", {"mesh": NECRO_HIGH},
               {"height_m": 1.8, "target_tris": 30000, "remove_islands_below": 0.001})
    dt = time.time() - t0
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert s["before"]["tris"] > 1_000_000 and s["after"]["tris"] <= 30000
    assert len([x for x in s["decimation"] if x["stage"].startswith("collapse")]) >= 3
    assert dt < 120, s["timings_s"]


def test_real_necromancer_decimate_30k():
    if not os.path.isfile(NECRO):
        return "skip: " + NECRO
    res = _run("cleanup", {"mesh": NECRO}, {"height_m": 1.8, "target_tris": 30000})
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert s["before"]["tris"] == 119997 and s["after"]["tris"] <= 30000, s["after"]
    assert s["welded"]["loose_parts"] <= 4, s["welded"]
    assert s["render_compare"]["silhouette_iou"] >= 0.98, s["render_compare"]
    assert s["render_compare"]["color_mae"] <= 0.05, s["render_compare"]
    assert s["timings_s"]["total"] < 60, s["timings_s"]
    _, sizes = _imported_base_color(res["outputs"]["glb"])
    assert [4096, 4096] in sizes, sizes


def test_real_necromancer_mixamo_fbx():
    if not os.path.isfile(NECRO):
        return "skip: " + NECRO
    res = _run("convert", {"mesh": NECRO}, {"mixamo": True, "mixamo_center": "head"})
    assert res["ok"], (res.get("error"), res["checks"])
    s = res["stats"]
    assert s["bytes"] <= 10_000_000 and s["roundtrip"]["tris"] <= 50000, s
    assert abs(s["roundtrip"]["size"][2] - 1.8) < 2e-3, s["roundtrip"]
    assert abs(s["center_shift_m"]) < 0.1


def test_real_necromancer_remesh_bake():
    if not os.path.isfile(NECRO):
        return "skip: " + NECRO
    t0 = time.time()
    res = _run("cleanup", {"mesh": NECRO},
               {"height_m": 1.8, "voxel_remesh_m": 0.006, "target_tris": 12000,
                "bake_size": 1024, "bake_normal": True})
    assert res["ok"], (res.get("error"), res["checks"])
    assert time.time() - t0 < 180
    s = res["stats"]
    assert s["after"]["tris"] <= 12000 and s["after"]["boundary_edges"] == 0, s["after"]
    assert s["bake"]["miss_fraction"] <= 0.02, s["bake"]
    assert s["render_compare"]["silhouette_iou"] >= 0.98, s["render_compare"]
    assert s["textures_after"] and all("normal" in v for v in s["textures_after"].values())
    # 6 mm voxel is under the tearing threshold, so no voxel-size warning
    assert not [w for w in res["warnings"] if "voxel_remesh_m" in w], res["warnings"]


def test_real_necromancer_staff_regions():
    if not os.path.isfile(NECRO):
        return "skip: " + NECRO
    res = _run("separate", {"mesh": NECRO}, {"mode": "regions", "height_m": 1.8,
                                             "regions": STAFF_REGIONS})
    assert res["ok"], (res.get("error"), res["checks"])
    parts = {p["name"]: p for p in res["stats"]["parts"]}
    staff, body = parts["staff"], parts["body"]
    assert res["stats"]["regions"]["staff"]["open_seam_edges"] == 0
    assert res["stats"]["regions"]["staff"]["rest_open_seam_edges"] == 0
    assert staff["loose_parts"] == 2, staff        # shaft below the fist + shaft/head above
    assert staff["bbox_min"][2] < 0.02 and staff["bbox_max"][2] > 1.79, staff
    assert staff["size"][0] < 0.4 and staff["size"][1] < 0.22, staff
    assert 8000 < staff["tris"] < 20000 and body["tris"] > 90000, (staff["tris"], body["tris"])


def test_real_rigged_fbx_to_glb():
    if not os.path.isfile(ZOMBIE_RIG):
        return "skip: " + ZOMBIE_RIG
    res = _run("convert", {"mesh": ZOMBIE_RIG}, {"format": "glb"})
    assert res["ok"], (res.get("error"), res["checks"])
    assert res["stats"]["roundtrip"]["armatures"] == 1
    assert _check(res, "roundtrip_height")["ok"]


def test_real_rigged_glb_inputs():
    """The review's repro: the Mixamo-rigged zombie as a GLB through convert / cleanup /
    separate (the glTF importer's bone-shape Icosphere used to be 2.7 m tall in every bbox)."""
    if not os.path.isfile(ZOMBIE_RIG):
        return "skip: " + ZOMBIE_RIG
    d = _tmp()
    res = _run("convert", {"mesh": ZOMBIE_RIG}, {"format": "glb"}, os.path.join(d, "src"))
    assert res["ok"], (res.get("error"), res["checks"])
    _assert_rigged_inputs_clean(res["outputs"]["glb"], 1.7, d)


# --------------------------------------------------------------------------- slits, delete, sockets (10.10, v2)

def test_two_sided_open_sheet():
    """An open sheet has no inside for recalc_normals to find; two_sided gives every face a reversed
    twin behind it, so a ray from either side first meets a face that looks at it."""
    from mathutils.bvhtree import BVHTree
    af.reset_scene()
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=8, y_subdivisions=8, size=2.0)
    sheet = bpy.context.active_object
    tris = ml.tris_of(sheet)
    assert ml.two_sided(sheet, 0.001) == 2 * tris
    bvh = BVHTree.FromObject(sheet, bpy.context.evaluated_depsgraph_get())
    for z, d in ((0.5, (0, 0, -1)), (-0.5, (0, 0, 1))):
        loc, nrm, _i, _d = bvh.ray_cast((0.13, 0.27, z), d)
        assert loc is not None and nrm.dot(mathutils.Vector(d)) < -0.99, (z, nrm)

def _dumbbell_glb(path, neck=0.02):
    """Two cubes joined by a thin neck (one watertight mesh by a voxel remesh): a sleeve fused to a
    robe side in miniature. Left cube x -0.5..0, neck x 0..0.06 (+-neck in y/z), right cube 0.06..0.56."""
    af.reset_scene()
    objs = []
    for lo, hi in (((-0.5, -0.25, -0.25), (0.0, 0.25, 0.25)), ((-0.01, -neck, -neck), (0.07, neck, neck)),
                   ((0.06, -0.25, -0.25), (0.56, 0.25, 0.25))):
        me = bpy.data.meshes.new("c")
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=[hi[k] - lo[k] for k in range(3)], verts=bm.verts)
        bmesh.ops.translate(bm, vec=[(hi[k] + lo[k]) / 2 for k in range(3)], verts=bm.verts)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new("c", me)
        bpy.context.scene.collection.objects.link(ob)
        objs.append(ob)
    ob = af.join(objs, name="db")
    mod = ob.modifiers.new("r", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = 0.008
    af.select_only([ob])
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return af.export_glb(path, objects=[ob], animations=False, skins=False)


def _islands_after_weld(ob, dist=1e-6):
    me = ob.data.copy()
    tmp = bpy.data.objects.new("tmp", me)
    bpy.context.scene.collection.objects.link(tmp)
    ml.merge_by_distance(tmp, dist)
    _, counts = ml.island_labels(tmp.data)
    m = ml.mesh_metrics([tmp])
    bpy.data.objects.remove(tmp, do_unlink=True)
    return len(counts), m


def test_slit_rip_separates_without_caps():
    d = _tmp()
    src = _dumbbell_glb(os.path.join(d, "db.glb"))
    af.reset_scene()
    ob = af.join([o for o in af.import_any(src) if o.type == "MESH"], name="db")
    ml.merge_by_distance(ob, 1e-6)
    n0, m0 = _islands_after_weld(ob)
    assert n0 == 1 and m0["boundary_edges"] == 0, (n0, m0)
    faces0 = len(ob.data.polygons)
    box = ([0.01, -0.1, -0.1], [0.05, 0.1, 0.1])
    info = ml.slit(ob, [box], ml.SlitSurface({"axis": "x", "value": 0.03}), width=0.0, gap=0.004)
    assert info["ripped_edges"] > 8 and info["rim_verts_moved"] > 0, info
    n1, m1 = _islands_after_weld(ob, 1e-4)        # the gap keeps a weld from sewing it back
    assert n1 == 2, n1
    assert m1["boundary_edges"] >= 2 * info["ripped_edges"] - 4, (m1, info)   # open rims, no caps
    assert len(ob.data.polygons) >= faces0      # nothing removed (bisect only adds faces)


def test_slit_slab_caps_each_side_and_curve():
    d = _tmp()
    src = _dumbbell_glb(os.path.join(d, "db.glb"))
    res = _run("separate", {"mesh": src}, {"mode": "slit", "ground": False, "center": False, "preview": False,
                                           "regions": [{"name": "neck", "min": [0.01, -0.1, -0.1],
                                                        "max": [0.05, 0.1, 0.1], "width_m": 0.012,
                                                        "plane": {"axis": "x", "value": 0.03}}]},
               os.path.join(d, "out"))
    assert res["ok"], (res.get("error"), res["checks"])
    reg = res["stats"]["regions"]["slit_neck"]
    s0 = reg["slits"][0]
    assert s0["faces_removed"] > 0 and s0["caps"]["+"] > 0 and s0["caps"]["-"] > 0, s0
    assert _check(res, "slit_neck_cut")["ok"] and _check(res, "slit_neck_capped")["ok"]
    af.reset_scene()
    ob = af.join([o for o in af.import_any(res["outputs"]["glb"]) if o.type == "MESH"], name="db")
    assert [o.name for o in bpy.context.scene.objects if o.type == "MESH"] == ["db"]
    n, m = _islands_after_weld(ob, 1e-5)
    assert n == 2 and m["boundary_edges"] == 0, (n, m)      # two closed pieces, each with its own cap
    # curve: value = f(along) piecewise linear, one plane per band, continuous at the borders
    sf = ml.SlitSurface({"axis": "x", "along": "z", "points": [[0.0, 0.0], [1.0, 0.1], [2.0, 0.1]]})
    assert len(sf.planes) == 2
    assert abs(sf.offset((0.05, 3.0, 0.5))) < 1e-9 and abs(sf.offset((0.1, -1.0, 1.0))) < 1e-9
    assert abs(sf.offset((0.1, 0.0, 1.5))) < 1e-9 and sf.offset((0.2, 0.0, 1.5)) > 0.09


def test_separate_delete_kind_open_or_capped_and_facing():
    d = _tmp()
    af.reset_scene()
    ob = _cylinder("robe", radius=0.3, height=1.5)
    src = af.export_glb(os.path.join(d, "robe.glb"), objects=[ob], animations=False, skins=False)
    region = {"name": "bottom", "kind": "delete", "min": [-0.5, -0.5, -0.01], "max": [0.5, 0.5, 0.04],
              "facing": [0, 0, -1], "facing_min": 0.5}
    res = _run("separate", {"mesh": src}, {"mode": "regions", "preview": False, "ground": False, "center": False,
                                           "regions": [dict(region, caps=False)]}, os.path.join(d, "open"))
    assert res["ok"], res["checks"]
    parts = res["stats"]["parts"]
    assert [p["name"] for p in parts] == ["body"], parts               # deleted, not a part
    info = res["stats"]["regions"]["delete_bottom"]
    assert info["faces_inside"] > 0 and info["rest_cap_faces"] == 0 and info["rest_open_seam_edges"] > 0, info
    assert parts[0]["boundary_edges"] > 0 and abs(parts[0]["bbox_min"][2]) < 1e-4  # the side wall stays
    res = _run("separate", {"mesh": src}, {"mode": "regions", "preview": False, "ground": False, "center": False,
                                           "regions": [dict(region, caps=True)]}, os.path.join(d, "capped"))
    info = res["stats"]["regions"]["delete_bottom"]
    assert info["rest_cap_faces"] > 0 and res["stats"]["parts"][0]["closed"], info


def _socket_scene_glb(path, height=1.0):
    af.reset_scene()
    ob = _cylinder("body", radius=0.2, height=height)
    e = af.add_socket("socket_fx_test", location=(0.1, -0.2, 0.8 * height), rotation=(0.3, 0.0, 0.5), kind="fx",
                      size_class="S")
    return af.export_glb(path, objects=[ob, e], animations=False, skins=False), e.matrix_world.copy()


def _socket_in(glb, name):
    af.reset_scene()
    objs = af.import_any(glb)
    s = [o for o in objs if o.type == "EMPTY" and (o.get("game_socket") == name or o.name == name)]
    return s[0] if s else None


def test_cleanup_and_separate_keep_sockets():
    d = _tmp()
    src, M0 = _socket_scene_glb(os.path.join(d, "s.glb"))
    res = _run("cleanup", {"mesh": src}, {"height_m": 2.0, "preview": False}, os.path.join(d, "clean"))
    assert res["ok"] and res["stats"]["sockets_kept"] == ["socket_fx_test"], res["stats"].get("sockets_kept")
    s = _socket_in(res["outputs"]["glb"], "socket_fx_test")
    assert s is not None and s.get("kind") == "fx" and s.get("size_class") == "S"
    # height 1 -> 2 (x2 about the base centre), feet on z = 0: the socket follows, unit scale
    loc = s.matrix_world.translation.copy()   # a copy: the scene is reset below
    assert (loc - mathutils.Vector((0.2, -0.4, 1.6))).length < 2e-3, loc
    assert abs(s.matrix_world.to_scale().x - 1.0) < 1e-4
    ang = (s.matrix_world.to_quaternion().rotation_difference(M0.to_quaternion())).angle
    assert ang < 1e-3, ang
    res = _run("separate", {"mesh": res["outputs"]["glb"]},
               {"mode": "regions", "preview": False, "regions": [{"name": "top", "min": [-1, -1, 1.5],
                                                                   "max": [1, 1, 2.1]}]}, os.path.join(d, "sep"))
    assert res["ok"] and res["stats"]["sockets_kept"] == ["socket_fx_test"]
    s = _socket_in(res["outputs"]["glb"], "socket_fx_test")
    assert s is not None and (s.matrix_world.translation - loc).length < 2e-3
