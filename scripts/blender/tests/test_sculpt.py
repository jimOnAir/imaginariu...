"""Self-tests of the sculpt step (masked sculpt operations without a window).

Synthetic tests build meshes with bmesh and write them into tempfile.mkdtemp(); test_real_* use a
rigged asset from the library and return "skip: ..." when it is missing. Run:

    blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- sculpt
"""
import glob
import importlib
import os
import tempfile

import bmesh
import bpy
import numpy as np

import imaginarium_common as ima
from steps import _mesh_lib as ml
from steps import sculpt as sc

R = 0.5                                   # radius of the test sphere, m


# --------------------------------------------------------------------------- helpers

def _tmp():
    return tempfile.mkdtemp(prefix="imaginarium_sculpt_")


def _sphere_bm(radius=R, seg=48, rings=24, uv=False, bump=None):
    bm = bmesh.new()
    if uv:
        bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=radius, calc_uvs=uv)
    if bump:
        for v in bm.verts:
            v.co = bump(v.co.copy())
    return bm


def _save(path, bm, name="Ball", fmt="glb"):
    """Export the bmesh as a one-object file (fresh scene) and clear the scene again."""
    ima.reset_scene()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if fmt == "glb":
        ima.export_glb(path, objects=[ob], animations=False, skins=False)
    else:
        ima.select_only([ob])
        bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True)
    ima.reset_scene()
    return path


def _run(mesh, ops, **params):
    """inputs.blend is not opened yet here: imaginarium_run normally does that before calling run()."""
    mod = importlib.import_module("steps.sculpt")
    p = {"ops": ops, "preview": False}
    p.update(params)
    req = {"step": "sculpt", "inputs": {"mesh": mesh}, "params": p, "out_dir": _tmp()}
    os.makedirs(req["out_dir"], exist_ok=True)
    return ima.finish(req, mod.run(req))   # the step leaves the result loaded: tests read it from the scene


def _run_blend(path, ops, **params):
    mod = importlib.import_module("steps.sculpt")
    p = {"ops": ops, "preview": False}
    p.update(params)
    req = {"step": "sculpt", "inputs": {"blend": path}, "params": p, "out_dir": _tmp()}
    os.makedirs(req["out_dir"], exist_ok=True)
    ima.open_blend(path)
    return ima.finish(req, mod.run(req))


def _check(res, name):
    for c in res["checks"]:
        if c["name"] == name:
            return c
    raise AssertionError("check %s missing: %s" % (name, [c["name"] for c in res["checks"]]))


def _ok(res, *names):
    for n in names:
        c = _check(res, n)
        assert c["ok"], (n, c)


def _verts():
    """World vertices of every model mesh still loaded after a run (welded view)."""
    out = []
    for o in ml.model_meshes(list(bpy.context.scene.objects)):
        out.append(sc.Surface(o).world)
    return np.concatenate(out)


def _radii(co, centre=(0, 0, 0)):
    return np.linalg.norm(co - np.asarray(centre), axis=1)


def _ball(tmp, **kw):
    return _save(os.path.join(tmp, "ball.glb"), _sphere_bm(**kw))


# --------------------------------------------------------------------------- argument checks

def test_parse_ops_rejects_bad_input():
    for ops, msg in (
            ([], "non-empty"),
            ([{"op": "melt"}], "unknown op"),
            ([{"op": "inflate"}], "amount"),
            ([{"op": "inflate", "amount": 0.1, "region": {"type": "sphere", "center": [0, 0, 0]}}],
             "radius"),
            ([{"op": "grab", "offset": [1, 2]}], "offset"),
            ([{"op": "smooth", "factor": 3}], "factor"),
            ([{"op": "transfer"}], "source"),
            ([{"op": "symmetrize", "axis": "w"}], "axis"),
            ([{"op": "smooth", "symmetry": "diag"}], "symmetry")):
        try:
            sc.parse_ops(ops, "none")
        except ValueError as exc:
            assert msg in str(exc), (ops, str(exc))
        else:
            raise AssertionError("accepted: %s" % ops)
    ok = sc.parse_ops([{"op": "Smooth"}, {"op": "relax", "region": {"type": "box", "center": [0, 0, 0],
                                                                    "extents": 1}}], "x")
    assert ok[0]["symmetry"] == "x" and ok[1]["region"]["extents"] == [1.0, 1.0, 1.0]


def test_falloff_and_flip_names():
    t = np.array([0.0, 0.5, 1.0])
    assert np.allclose(sc.falloff_curve(t, "linear"), [1.0, 0.5, 0.0])
    assert np.allclose(sc.falloff_curve(t, "sharp"), [1.0, 0.25, 0.0])
    assert sc.falloff_curve(np.array([0.999]), "constant")[0] == 1.0
    assert sc.falloff_curve(np.array([1.0]), "constant")[0] == 0.0
    s = sc.falloff_curve(t, "smooth")
    assert s[0] > s[1] > s[2] and abs(s[1] - 0.5) < 1e-9            # smoothstep: symmetric middle
    assert sc.flip_group_name("mixamorig:LeftHand") == "mixamorig:RightHand"
    assert sc.flip_group_name("Arm.L") == "Arm.R"
    assert sc.flip_group_name("leg_l") == "leg_r"
    assert sc.flip_group_name("Hips") == "Hips"


# --------------------------------------------------------------------------- welded surface

def test_surface_welds_split_copies_and_flush_moves_them_together():
    tmp = _tmp()
    mesh = _ball(tmp, uv=True)               # a UV sphere imported from glTF: seams split vertices
    objs = ima.import_any(mesh)
    ob = [o for o in objs if o.type == "MESH"][0]
    S = sc.Surface(ob)
    assert S.n > S.m, "a UV sphere carries split copies (n=%d, canonical m=%d)" % (S.n, S.m)
    assert S.boundary_edges == 0 and S.nonmanifold_edges == 0 and S.closed
    S.P += np.array([0.05, 0.0, 0.0])        # move every canonical point
    mx = S.flush()
    assert mx > 0.04
    co = np.empty(S.n * 3)
    ob.data.vertices.foreach_get("co", co)
    got = co.reshape(-1, 3) @ S.A.T + S.t    # world positions after the flush
    assert np.allclose(got[:, 0], S.world[:, 0], atol=1e-5)
    # every canonical point's copies landed on the same new position
    for w in (5, 100):
        rows = got[S.canon == w]
        assert np.linalg.norm(rows.max(axis=0) - rows.min(axis=0)) < 1e-5


# --------------------------------------------------------------------------- point operations

def test_grab_moves_a_sphere_region_and_nothing_else():
    tmp = _tmp()
    mesh = _ball(tmp)
    res = _run(mesh, [{"op": "grab", "offset": [0, 0.2, 0],
                       "region": {"type": "sphere", "center": [R, 0, 0], "radius": 0.25,
                                  "falloff": "constant"}}])
    _ok(res, "sculpt_manifold", "no_nan_verts", "sculpt_changed")
    info = list([r for r in res["stats"]["ops"]][0]["objects"].values())[0]
    assert abs(info["max_shift_m"] - 0.2) < 1e-3 and 10 < info["moved_points"] < info["points"] / 4
    co = _verts()
    # the vertex that sat at [R,0,0] must now sit at [R,0.2,0]; the untouched -X half stays put
    assert np.linalg.norm(co - np.array([R, 0.2, 0]), axis=1).min() < 0.02
    assert abs(co[co[:, 0] < 0][:, 1].mean()) < 0.02


def test_grab_with_symmetry_moves_both_sides_equally():
    tmp = _tmp()
    mesh = _ball(tmp)
    res = _run(mesh, [{"op": "grab", "offset": [0, 0, 0.1]}], symmetry="x")
    _ok(res, "sculpt_manifold", "sculpt_changed")
    co = _verts()
    right, left = co[co[:, 0] > 0.25], co[co[:, 0] < -0.25]
    assert abs(right[:, 2].mean() - 0.1) < 0.02 and abs(left[:, 2].mean() - 0.1) < 0.02
    assert abs(right[:, 2].mean() - left[:, 2].mean()) < 0.005


def test_smooth_removes_a_spike_and_relax_keeps_the_volume():
    tmp = _tmp()

    def spike(co):
        return co * 1.6 if (co.x > 0.2 and abs(co.y) < 0.15 and abs(co.z) < 0.15) else co

    mesh = _save(os.path.join(tmp, "spiky.glb"), _sphere_bm(uv=True, bump=spike))
    # the untouched volume of the same file
    objs = ima.import_any(mesh)
    v0 = sc.Surface([o for o in objs if o.type == "MESH"][0]).volume()
    ima.reset_scene()

    res = _run(mesh, [{"op": "smooth", "iterations": 15, "factor": 0.8,
                       "region": {"type": "sphere", "center": [0.6, 0, 0], "radius": 0.45,
                                  "falloff": "constant"}}])
    _ok(res, "sculpt_manifold", "sculpt_changed")
    assert _radii(_verts()).max() < 0.8, "the spike should be smoothed away"

    res = _run(mesh, [{"op": "relax", "iterations": 10, "factor": 0.5, "region": {"type": "all"}}])
    _ok(res, "sculpt_manifold")
    ob = ml.model_meshes(list(bpy.context.scene.objects))[0]
    v1 = sc.Surface(ob).volume()
    assert 0.6 * v0 <= v1 <= 1.02 * v0, "relax must not melt the model: %.5f vs %.5f" % (v1, v0)


def test_inflate_and_flatten_behave_oppositely():
    tmp = _tmp()
    mesh = _ball(tmp)
    _run(mesh, [{"op": "inflate", "amount": 0.08,
                 "region": {"type": "sphere", "center": [R, 0, 0], "radius": 0.3,
                            "falloff": "constant"}}])
    assert _radii(_verts()).max() > R + 0.05
    _run(mesh, [{"op": "flatten", "strength": 1.0,
                 "region": {"type": "sphere", "center": [R, 0, 0], "radius": 0.3,
                            "falloff": "constant"},
                 "plane": {"point": [R + 0.1, 0, 0], "normal": [1, 0, 0]}}])
    co = _verts()
    cap = co[:, 0] > R - 0.28
    assert co[cap][:, 0].max() <= R + 0.1 + 1e-3


def test_pinch_gathers_the_region():
    tmp = _tmp()
    mesh = _ball(tmp)
    res = _run(mesh, [{"op": "pinch", "amount": 0.9, "radial": True,
                       "region": {"type": "sphere", "center": [R, 0, 0], "radius": 0.25}}])
    _ok(res, "sculpt_manifold", "sculpt_changed")
    info = list([r for r in res["stats"]["ops"] if r["op"] == "pinch"][0]["objects"].values())[0]
    assert info["moved_points"] > 10 and info["max_shift_m"] > 0.01


# --------------------------------------------------------------------------- topology operations

def test_keep_uv_refuses_remesh_on_a_uv_mesh():
    tmp = _tmp()
    mesh = _ball(tmp, uv=True)
    try:
        _run(mesh, [{"op": "remesh"}])
    except ValueError as exc:
        assert "keep_uv" in str(exc), exc
        return
    raise AssertionError("remesh on a UV mesh must be refused while keep_uv is true")


def test_voxel_remesh_rebuilds_and_keep_uv_false_allows_it():
    tmp = _tmp()
    mesh = _ball(tmp, uv=True)
    res = _run(mesh, [{"op": "remesh", "voxel_size": 0.03}], keep_uv=False)
    _ok(res, "sculpt_manifold", "no_nan_verts")
    assert str(_check(res, "sculpt_uv_kept")["value"]).startswith("not required")
    rec = [r for r in res["stats"]["ops"] if r["op"] == "remesh"][0]
    info = list(rec["objects"].values())[0]
    assert info["mode"] == "voxel" and info["tris_after"] > 100
    co = _verts()
    assert abs(_radii(co).mean() - R) < 0.06 and co.shape[0] > 500


def test_subdivide_only_inside_the_vertex_group():
    tmp = _tmp()
    # vertex groups only survive through .blend (glTF exports weights of skinned meshes only)
    ima.reset_scene()
    me = bpy.data.meshes.new("Ball")
    bm = _sphere_bm(seg=32, rings=16)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Ball", me)
    bpy.context.scene.collection.objects.link(ob)
    grp = ob.vertex_groups.new(name="cap")
    grp.add([v.index for v in me.vertices if v.co.x > 0.3], 1.0, "REPLACE")
    path = os.path.join(tmp, "grouped.blend")
    ima.save_blend(path)
    res = _run_blend(path, [{"op": "subdivide", "cuts": 1,
                             "region": {"type": "vertex_group", "name": "cap",
                                        "falloff": "constant"}}])
    _ok(res, "sculpt_manifold", "sculpt_changed")
    info = list([r for r in res["stats"]["ops"] if r["op"] == "subdivide"][0]["objects"].values())[0]
    assert info["edges_split"] > 20 and info["verts_added"] >= info["edges_split"]
    total = res["stats"]["after"]["verts"]
    assert info["verts_added"] < total * 0.9, "the outside of the group must keep its density"


def test_decimate_global_ratio():
    tmp = _tmp()
    mesh = _ball(tmp)
    res = _run(mesh, [{"op": "decimate", "ratio": 0.4, "region": {"type": "all"}}])
    info = list([r for r in res["stats"]["ops"] if r["op"] == "decimate"][0]["objects"].values())[0]
    assert info["tris_after"] < info["tris_before"] * 0.65, info
    _ok(res, "sculpt_manifold")


def test_symmetrize_makes_the_mesh_symmetric():
    tmp = _tmp()
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=R)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.x < -1e-4], context="VERTS")
    mesh = _save(os.path.join(tmp, "half.obj"), bm, fmt="obj")
    res = _run(mesh, [{"op": "symmetrize", "axis": "x", "direction": "+"}])
    _ok(res, "no_nan_verts")
    c = _check(res, "sculpt_symmetric")
    assert c["ok"], c
    co = _verts()
    assert co[:, 0].min() < -R + 0.05, "the mirrored half must cover -X now"


# --------------------------------------------------------------------------- transfer

def test_transfer_copies_the_shape_of_a_source():
    tmp = _tmp()
    mesh = _ball(tmp)
    # source: the same sphere with its +X cap pushed towards the centre
    bump = lambda co: co * (0.7 if co.x > 0.35 else 1.0)
    src = _save(os.path.join(tmp, "source.obj"), _sphere_bm(bump=bump), fmt="obj")
    res = _run(mesh, [{"op": "transfer", "source": src, "align": "none",
                       "region": {"type": "sphere", "center": [R, 0, 0], "radius": 0.4,
                                  "falloff": "constant"}}], tolerance_m=0.3)
    _ok(res, "sculpt_manifold", "sculpt_changed", "transfer_max_dist_m", "transfer_mean_dist_m")
    assert res["stats"]["transfer"]["count"] > 10
    co = _verts()
    dented = co[(co[:, 0] > 0.30) & (np.abs(co[:, 1]) < 0.15) & (np.abs(co[:, 2]) < 0.15)]
    assert _radii(dented).max() < 0.45, "the dent must have arrived: %.3f" % _radii(dented).max()


# --------------------------------------------------------------------------- rigged input

def _rigged_ball(path):
    """A sphere with one bone along Z, fully weighted to it (skinned glTF round trip)."""
    ima.reset_scene()
    me = bpy.data.meshes.new("Body")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=R)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Body", me)
    bpy.context.scene.collection.objects.link(ob)
    arm_data = bpy.data.armatures.new("Rig")
    arm = bpy.data.objects.new("Rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones.new("spine")
    eb.head, eb.tail = (0, 0, -0.5), (0, 0, 0.5)
    bpy.ops.object.mode_set(mode="OBJECT")
    grp = ob.vertex_groups.new(name="spine")
    grp.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    ob.parent = arm
    ima.export_glb(path, objects=[ob, arm], animations=False, skins=True)
    ima.reset_scene()
    return path


def test_rig_survives_point_ops_and_a_bone_region_works():
    tmp = _tmp()
    mesh = _rigged_ball(os.path.join(tmp, "rigged.glb"))
    res = _run(mesh, [{"op": "grab", "offset": [0.1, 0, 0],
                       "region": {"type": "bone", "name": "spine", "falloff": "constant"}}])
    _ok(res, "sculpt_rig_kept", "sculpt_manifold", "sculpt_changed")
    assert abs(_verts()[:, 0].mean() - 0.1) < 0.02      # fully weighted: the whole mesh moved
    arms = ima.armatures()
    assert arms and len(arms[0].data.bones) == 1


def test_rig_dropped_with_preserve_rig_false():
    tmp = _tmp()
    mesh = _rigged_ball(os.path.join(tmp, "rigged2.glb"))
    res = _run(mesh, [{"op": "grab", "offset": [0.05, 0, 0], "region": {"type": "all"}}],
               preserve_rig=False)
    assert _check(res, "sculpt_rig_kept")["ok"]         # "dropped by preserve_rig:false"
    assert not ima.armatures()
    assert any("preserve_rig=false" in w for w in res["warnings"])


# --------------------------------------------------------------------------- reports and outputs

def test_outputs_and_op_reporting():
    tmp = _tmp()
    mesh = _ball(tmp, uv=True)
    res = _run(mesh, [{"op": "grab", "offset": [0, 0, 0.05],
                       "region": {"type": "box", "center": [0, 0, 0.3], "extents": [0.4, 0.4, 0.3]}},
                      {"op": "smooth", "iterations": 2}], preview=True, preview_size=256)
    for key in ("glb", "mesh", "blend", "preview"):
        assert os.path.isfile(res["outputs"][key]), (key, res["outputs"])
    assert res["outputs"]["glb"] == res["outputs"]["mesh"]
    rec0 = res["stats"]["ops"][0]
    assert rec0["region"] == "box" and rec0["seconds"] >= 0
    info = list(rec0["objects"].values())[0]
    assert 0 < info["covered_points"] < info["points"]
    assert info["moved_points"] > 0 and info["max_shift_m"] > 0.01
    assert res["stats"]["render_compare"]["silhouette_iou"] > 0.9    # the shift is small
    _ok(res, "sculpt_uv_kept")


def test_region_that_matches_nothing_warns():
    tmp = _tmp()
    mesh = _ball(tmp)
    res = _run(mesh, [{"op": "grab", "offset": [1, 1, 1],
                       "region": {"type": "sphere", "center": [9, 9, 9], "radius": 0.1}}])
    assert any("matched no vertex" in w for w in res["warnings"]), res["warnings"]
    assert not _check(res, "sculpt_changed")["ok"]      # a warning that nothing moved


# --------------------------------------------------------------------------- real asset

def test_real_rigged_asset():
    roots = [os.environ.get("IMAGINARIUM_LIBRARY") or "",
             os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
                 os.path.dirname(os.path.abspath(__file__))))), "library"),
             "/tmp/afs/lib"]
    cand = []
    for r in roots:
        if r and os.path.isdir(r):
            cand += glob.glob(os.path.join(r, "assets", "*", "exports", "*", "*.glb"))
    if not cand:
        return "skip: no exported rigged asset in the library"
    res = _run(sorted(cand)[0], [{"op": "relax", "iterations": 4, "factor": 0.5,
                                  "region": {"type": "all"}}])
    _ok(res, "sculpt_manifold", "no_nan_verts")
    return None
