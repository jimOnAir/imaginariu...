"""Self-tests of the humanoid module (rig_humanoid, prepare_mixamo, import_mixamo_rig).

Synthetic tests build a procedural mannequin with known joints (_humanoid_lib.make_mannequin);
test_real_* use assets on disk and return early when a file is missing. Temporary files only in
tempfile.mkdtemp(). Run (until the shared runner exists):
  blender -b --factory-startup --python-expr "import sys;sys.path[:0]=[r'<root>/scripts/blender',
  r'<root>/scripts/blender/tests'];import test_humanoid as t;import imaginarium_common as ima
  for n in sorted(dir(t)):
      if n.startswith('test_'): ima.reset_scene(); getattr(t,n)(); print('PASS',n)"
"""
import json
import math
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import imaginarium_common as ima  # noqa: E402
from steps import _humanoid_lib as hl  # noqa: E402
from steps import _items_lib as IL  # noqa: E402

# On-disk fixtures for the test_real_* cases (every one returns a skip string when its file is missing).
# Environment overrides: Imaginarium_NECRO_GLB, Imaginarium_ART_RAW, Imaginarium_BASE_MESHES.
NECRO = os.environ.get("Imaginarium_NECRO_GLB") or r"C:/Imaginarium/test-assets/ReferenceFidelity/Corrected-necromancer.glb"
ART_RAW = os.environ.get("Imaginarium_ART_RAW") or r"C:/Imaginarium/test-assets/art/raw"
KNIGHT = ART_RAW + "/meshy/01a0e2b0-c89f-7338-8b6b-dd8487d093c0/model.glb"
BUNDLE = (os.environ.get("Imaginarium_BASE_MESHES") or r"C:/Imaginarium/test-assets/human-base-meshes/"
          r"human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend")


# ------------------------------------------------------------------ helpers

def _tmp():
    return tempfile.mkdtemp(prefix="imaginarium_humanoid_")


def _mannequin_glb(d, pose="A", rot_z=0.0, **kw):
    ima.reset_scene()
    ob, gt = hl.make_mannequin(pose, **kw)
    if rot_z:
        ob.data.transform(Matrix.Rotation(math.radians(rot_z), 4, "Z"))
    path = os.path.join(d, "mannequin_%s.glb" % pose)
    ima.export_glb(path, objects=[ob], animations=False, skins=False)
    return path, gt


def _run(step, req):
    import importlib
    mod = importlib.import_module("steps." + step)
    req.setdefault("params", {})
    req.setdefault("inputs", {})
    req["step"] = step
    res = mod.run(req)
    full = {"ok": True, "checks": [], "warnings": [], "outputs": {}, "stats": {}}
    full.update(res)
    failed = [c for c in full["checks"] if not c["ok"] and c.get("severity", "error") == "error"]
    if failed:
        full["ok"] = False
    full["failed"] = [c["name"] for c in failed]
    return full


def _detect(path, params=None):
    req = {"inputs": {"mesh": path}, "params": dict(params or {}), "out_dir": _tmp()}
    if path.lower().endswith(".blend") and not req["params"].get("objects"):
        req["inputs"] = {"blend": path}
        ima.open_blend(path)
    w = []
    body, P, info = hl.prepare_body(req, w)
    lm, P = hl.run_landmarks(body, P, float(req["params"].get("height_m", 1.8)), req["params"], w, info)
    shutil.rmtree(req["out_dir"], ignore_errors=True)
    return lm, info, w


def _check(res, name):
    return next((c for c in res["checks"] if c["name"] == name), None)


# ------------------------------------------------------------------ synthetic

def test_landmarks_mannequin_poses():
    d = _tmp()
    try:
        for pose, cls in (("A", "A"), ("T", "T"), ("down", "arms_down")):
            path, gt = _mannequin_glb(d, pose)
            lm, info, _ = _detect(path)
            assert info["facing"]["detected"] == "-Y", info["facing"]
            assert lm.pose == cls, (pose, lm.pose)
            assert lm.fail is None and lm.overall > 0.5, (lm.fail, lm.overall)
            J = lm.joints_m()
            for k in ("LeftForeArm", "RightForeArm", "LeftHand", "RightHand", "LeftLeg", "RightLeg"):
                err = float(np.linalg.norm(J[k] - gt[k]))
                assert err < 0.05, (pose, k, err)
            for k in ("LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg"):
                err = float(np.linalg.norm(J[k] - gt[k]))
                assert err < 0.07, (pose, k, err)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_landmarks_hidden_arms():
    """0.7.1-fold wave ticket 48: a hanging arm fused inside the torso silhouette - the
    ticket-35 probe recorded arm joints drifting 0.081-0.118 m there (the height band
    finds no lateral extreme when the arm never breaks the outline). The interior pass
    extrapolates the visible lower arm's axis through the band; the drift must land back
    inside the normal budgets with the honest interior source, and the normal-arms cases
    above stay the byte-unchanged no-change witnesses."""
    d = _tmp()
    try:
        for widen in (1.55, 1.75):
            path, gt = _mannequin_glb(d, "down", torso_widen=widen)
            lm, _, _ = _detect(path)
            assert lm.pose == "arms_down" and lm.fail is None, (widen, lm.pose, lm.fail)
            assert lm.overall > 0.5, (widen, lm.overall)
            for side in ("Left", "Right"):
                assert lm.info["shoulders"][side].get("interior") == "axis-extrapolated", \
                    (widen, side, lm.info["shoulders"][side])
            J = lm.joints_m()
            for k in ("LeftForeArm", "RightForeArm", "LeftHand", "RightHand"):
                err = float(np.linalg.norm(J[k] - gt[k]))
                assert err < 0.05, (widen, k, err)
            for k in ("LeftArm", "RightArm"):
                err = float(np.linalg.norm(J[k] - gt[k]))
                assert err < 0.07, (widen, k, err)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_facing_detection_rotated():
    d = _tmp()
    try:
        ima.reset_scene()
        ob, _ = hl.make_mannequin("A")
        ob.data.transform(Matrix.Rotation(math.radians(90), 4, "Z"))   # now faces +X
        path = os.path.join(d, "turned.glb")
        ima.export_glb(path, objects=[ob], animations=False, skins=False)
        lm, info, _ = _detect(path)
        assert info["facing"]["detected"] == "+X", info["facing"]
        assert lm.pose == "A"
        lm2, info2, _ = _detect(path, {"front": "+X"})
        assert info2["facing"]["confidence"] == 1.0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_bone_roll_convention():
    ima.reset_scene()
    _, gt = hl.make_mannequin("A")
    j = dict(gt)
    j["Spine"] = (j["Hips"] + j["Neck"]) * 0.5 - np.array([0, 0, 0.1])
    j["Spine1"] = (j["Hips"] + j["Neck"]) * 0.5
    j["Spine2"] = (j["Hips"] + j["Neck"]) * 0.5 + np.array([0, 0, 0.12])
    j["HeadTop_End"] = np.array([0, 0, 1.8])
    for s, sg in (("Left", 1), ("Right", -1)):
        j[s + "Shoulder"] = np.array([sg * 0.04, 0, j[s + "Arm"][2] + 0.04])
        j[s + "ToeBase"] = (j[s + "Foot"] + j[s + "Toe_End"]) * 0.5 + np.array([0, 0, -0.02])
    rig = hl.build_armature(j, 1.8)
    assert len(rig.data.bones) == 25
    fwd, up = Vector((0, -1, 0)), Vector((0, 0, 1))
    for bn in rig.data.bones:
        z = (bn.matrix_local.to_3x3() @ Vector((0, 0, 1))).normalized()
        n = hl.short(bn.name)
        if any(k in n for k in ("Foot", "ToeBase", "Toe_End")):
            assert z.dot(up) > 0.6, (n, z)
        else:
            assert z.dot(fwd) > 0.85, (n, z)
    assert not rig.data.bones[hl.b("HeadTop_End")].use_deform
    assert rig.data.bones[hl.b("LeftForeArm")].parent.name == hl.b("LeftArm")


def test_rig_humanoid_end_to_end():
    d = _tmp()
    try:
        path, gt = _mannequin_glb(d, "A")
        out = os.path.join(d, "out")
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "params": {"intersections": False},
                                    "out_dir": out})
        assert res["ok"], (res["failed"], res.get("error"))
        for k in ("glb", "blend", "markers_json", "markers_png", "poses_png"):
            assert os.path.exists(res["outputs"][k]), k
        assert res["stats"]["bones"] == 25
        assert _check(res, "unweighted_vertices")["value"] == 0
        assert _check(res, "max_influences")["value"] <= 4
        mk = json.load(open(res["outputs"]["markers_json"], encoding="utf-8"))
        for k in hl.MARKER_KEYS:
            assert len(mk["markers"][k]) == 2 and k in mk["confidence"]
        assert mk["pose"] == "A" and "LeftHand" in mk["joints"]
        assert len(res["stats"]["sockets"]) == 9      # contract 6 human list, shield mounts included
        assert res["stats"]["shield_mounts"]["socket_mount_shield_l"]["standoff_m"] <= 0.12
        assert mk["projection"]["image"] == {"width": 1280, "height": 640}, mk["projection"]
        # re-import: skin with 25 joints and socket extras
        ima.reset_scene()
        objs = ima.import_any(res["outputs"]["glb"])
        arms = ima.armatures(objs)
        assert len(arms) == 1 and len(arms[0].data.bones) == 25
        socks = {o.get("game_socket"): o for o in objs if o.get("game_socket")}
        for n in ("socket_mount_hand_r", "socket_mount_hand_l", "socket_mount_shield_r", "socket_mount_shield_l",
                  "socket_mount_back", "socket_mount_hip_l", "socket_mount_hip_r", "socket_fx_head",
                  "socket_fx_chest"):
            assert n in socks, n
        # shield mounts hang off the hand bones; their frame keeps a canonical shield upright, facing out
        for side, out_x in (("l", 1.0), ("r", -1.0)):
            sm = socks["socket_mount_shield_" + side]
            assert sm.parent_type == "BONE" and sm.parent_bone.endswith(("Left" if side == "l" else "Right") + "Hand")
            bpy.context.view_layer.update()
            R3 = sm.matrix_world.to_3x3().normalized()
            assert (R3 @ Vector((0, 0, 1))).z > 0.9, (side, R3)
            assert (R3 @ Vector((0, -1, 0))).x * out_x > 0.5, (side, R3)
        # hand frame: +Z thumb side (front for a hanging A-pose hand), -Y along the fingers (down)
        bpy.context.view_layer.update()
        M = socks["socket_mount_hand_l"].matrix_world
        assert M.col[2].to_3d().normalized().dot(Vector((0, -1, 0))) > 0.7
        assert (-M.col[1].to_3d()).normalized().dot(Vector((0, 0, -1))) > 0.5
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_staff_rigid_and_grip_socket():
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A", staff=True)
        res = _run("rig_humanoid", {"inputs": {"mesh": path},
                                    "params": {"intersections": False, "deform_test": False},
                                    "out_dir": os.path.join(d, "out")})
        rigid = [r for r in res["stats"]["rigid"] if r["kind"] == "prop"]
        assert rigid and rigid[0]["bone"] == hl.b("LeftHand"), res["stats"]["rigid"]
        assert rigid[0]["vertices"] > 100
        c = _check(res, "rigid_prop_LeftHand")
        assert c and c["ok"], c
        ang = res["stats"]["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_l"]
        assert ang < 10.0, ang
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_robe_blend_stride():
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A", robe=True)
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "params": {"intersections": False},
                                    "out_dir": os.path.join(d, "out")})
        assert res["stats"]["robe"] is True
        assert res["stats"]["robe_blend"]["vertices_blended"] > 100
        c = _check(res, "robe_stride_tear")
        assert c is not None and c["ok"], c
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_markers_override():
    d = _tmp()
    try:
        path, gt = _mannequin_glb(d, "A")
        mk = {"l_wrist": [0.40, 0.95], "r_wrist": [-0.40, 0.95], "l_knee": [0.12, 0.47],
              "joints": {"Head": [0.0, 0.0, 1.57]}}
        lm, _, _ = _detect(path, {"markers": mk})
        J = lm.joints_m()
        assert abs(J["LeftHand"][0] - 0.40) < 1e-3 and abs(J["LeftHand"][2] - 0.95) < 1e-3
        assert abs(J["RightHand"][0] + 0.40) < 1e-3
        assert abs(J["LeftLeg"][2] - 0.47) < 1e-3
        assert abs(J["Head"][2] - 1.57) < 1e-3
        assert lm.src["l_wrist"] == "user" and lm.conf["l_wrist"] == 1.0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_legless_fails_gracefully():
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A", legless=True)
        out = os.path.join(d, "out")
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "params": {}, "out_dir": out})
        assert not res["ok"] and "rig not built" in res.get("error", ""), res.get("error")
        assert os.path.exists(res["outputs"]["markers_json"])
        assert os.path.exists(res["outputs"]["markers_png"])
        assert not os.path.exists(os.path.join(out, "rigged.glb"))
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_fingers_skipped_on_mittens():
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A")
        res = _run("rig_humanoid", {"inputs": {"mesh": path},
                                    "params": {"fingers": True, "deform_test": False},
                                    "out_dir": os.path.join(d, "out")})
        assert res["stats"]["bones"] == 25
        assert any("fingers skipped" in w for w in res["warnings"]), res["warnings"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _textured_mannequin(d):
    ima.reset_scene()
    ob, _ = hl.make_mannequin("A")
    img = bpy.data.images.new("tex1024", 1024, 1024)
    img.pixels = np.tile(np.array([0.6, 0.3, 0.2, 1.0], dtype=np.float32), 1024 * 1024)
    p_img = os.path.join(d, "tex1024.png")
    img.filepath_raw = p_img
    img.file_format = "PNG"
    img.save()
    mat = ob.data.materials[0]
    mat.use_nodes = True
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    ob.data.uv_layers.new(name="UVMap")
    path = os.path.join(d, "textured.glb")
    ima.export_glb(path, objects=[ob], animations=False, skins=False)
    return path


def test_prepare_mixamo_lite():
    d = _tmp()
    try:
        path = _textured_mannequin(d)
        out = os.path.join(d, "out")
        res = _run("prepare_mixamo", {"inputs": {"mesh": path}, "params": {"lite": True}, "out_dir": out})
        assert res["ok"], res["failed"]
        assert res["stats"]["tris"] <= 12000
        assert all(max(t["size"]) <= 256 for t in res["stats"]["textures"]), res["stats"]["textures"]
        assert res["stats"]["fits_upload"]
        ima.reset_scene()
        objs = ima.import_any(res["outputs"]["fbx"])
        lo, hi = ima.world_bbox(objs)
        assert abs(hi.z - lo.z - 1.8) < 0.02 and abs(lo.z) < 0.01, (lo, hi)
        assert not ima.armatures(objs)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_prepare_mixamo_prerigged_and_import_roundtrip():
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A")
        out = os.path.join(d, "pm")
        res = _run("prepare_mixamo", {"inputs": {"mesh": path},
                                      "params": {"lite": True, "prerigged": True,
                                                 "rig_params": {"deform_test": False}},
                                      "out_dir": out})
        assert res["ok"], res["failed"]
        assert res["stats"]["prerigged"]["bones"] == 25
        fbx = res["outputs"]["fbx_prerigged"]
        # emulate a Mixamo download: second-character prefix and centimetre scale
        ima.reset_scene()
        objs = ima.import_any(fbx)
        rig = ima.armatures(objs)[0]
        for bn in rig.data.bones:
            bn.name = bn.name.replace("mixamorig:", "mixamorig1:")
        cm = os.path.join(d, "from_mixamo.fbx")
        ima.export_fbx(cm, objects=[rig] + ima.meshes(objs), global_scale=100.0, mixamo=True)
        res2 = _run("import_mixamo_rig", {"inputs": {"fbx": cm}, "params": {"height_m": 1.75},
                                          "out_dir": os.path.join(d, "imr")})
        assert res2["ok"], res2["failed"]
        assert res2["stats"]["renamed_bones"] == 25
        assert _check(res2, "height")["ok"]
        assert len(res2["stats"]["sockets"]) == 9      # the same add_human_sockets (shield mounts too)
        ima.reset_scene()
        objs = ima.import_any(res2["outputs"]["glb"])
        names = [bn.name for bn in ima.armatures(objs)[0].data.bones]
        assert all(n.startswith("mixamorig:") for n in names), names[:3]
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------ real assets


class _Comp:
    def __init__(self, k, n, c):
        self.k, self.n, self.c = k, n, np.asarray(c, dtype=np.float64)


class _Chain:
    ab = [0, 1]

    def __init__(self):
        self.all = []

    def add(self, k, n, x, y=0.0):
        self.all.append(_Comp(k, n, (x, y, 0.1 + 0.005 * k)))
        return len(self.all) - 1


def test_prop_chain_axis_decimation_fragments_vs_bow():
    """_chain_axis (smoke 10.10): a straight shaft whose slices pick up small off-axis fragments (finger
    tips, cross-sections split by decimation) stays straight; a bow limb with its string (two real
    components per level) and a curved chain stay rejected."""
    rng = np.random.default_rng(5)
    staff = _Chain()
    g = [staff.add(k, 80, 0.3 + rng.normal(0, 0.0012)) for k in range(60)]
    g += [staff.add(k, 9, 0.325) for k in (5, 14, 23, 31, 40, 52)]         # fragments beside the shaft
    for k in (0, 1, 58, 59):                                              # fist at the ends of the chain
        staff.all[g[k]].c[0] += 0.015
    cents = np.array([staff.all[i].c for i in g])
    _, _, _, resid = hl._line_fit(cents)
    assert float(np.sqrt(np.mean(resid ** 2))) > 0.006, "the plain centroid fit fails here (the smoke case)"
    c, d, rms, used = hl._chain_axis(staff, g)
    assert rms < 0.003 and abs(d[2]) > 0.99 and abs(c[0] - 0.3) < 0.002, (rms, d, c)
    assert len(used) <= 60
    bow = _Chain()
    gb = []
    for k in range(80):
        t = k / 79.0
        gb.append(bow.add(k, 50, 0.3 + 0.05 * (1 - (2 * t - 1) ** 2)))   # limb, sagitta 0.05 H
        gb.append(bow.add(k, 45, 0.3))                                     # string
    assert hl._chain_axis(bow, gb)[2] > 0.006
    arc = _Chain()
    ga = [arc.add(k, 60, 0.3 + 0.04 * (1 - (2 * k / 79.0 - 1) ** 2)) for k in range(80)]
    assert hl._chain_axis(arc, ga)[2] > 0.006, "trimming does not straighten a curve"


def _glb_animation_names(path):
    import struct
    with open(path, "rb") as fh:
        data = fh.read()
    n = struct.unpack_from("<I", data, 12)[0]
    js = json.loads(data[20:20 + n].decode("utf-8"))
    return [a.get("name") for a in js.get("animations", [])]


def _arm_heads_from_fbx(path, H):
    """Arm heads of a rigged FBX in its own frame scaled to height H (feet on 0, x from the Hips)."""
    ima.reset_scene()
    objs = ima.import_any(path)
    rig = ima.armatures(objs)[0]
    co = np.concatenate([hl.mesh_verts(o) for o in ima.meshes(objs)])
    z0, h = float(co[:, 2].min()), float(co[:, 2].max() - co[:, 2].min())
    k = H / h
    hips = rig.matrix_world @ next(bn for bn in rig.data.bones if bn.name.endswith("Hips")).head_local
    out = {}
    for side in ("Left", "Right"):
        bn = next(bn for bn in rig.data.bones if bn.name.endswith(side + "Arm"))
        p = rig.matrix_world @ bn.head_local
        out[side] = np.array([(p.x - hips.x) * k, (p.z - z0) * k])
    return out


# ------------------------------------------------------------------ review fixes (round 2)

def test_rotated_mannequin_yaw_fixed():
    """An input turned 30 deg about Z is rotated back before the landmarks: same joints, symmetric."""
    d = _tmp()
    try:
        path, gt = _mannequin_glb(d, "A", rot_z=30.0)
        lm, info, w = _detect(path)
        assert info["yaw"]["corrected"] and abs(info["yaw"]["residual_deg"] - 30.0) < 2.0, info["yaw"]
        assert any("turned" in x for x in w), w
        assert lm.fail is None and lm.pose == "A"
        assert lm.arm_sym_max < 0.03, lm.arm_sym
        J = lm.joints_m()
        for k in ("LeftHand", "RightHand", "LeftForeArm", "RightForeArm", "LeftLeg", "RightLeg"):
            err = float(np.linalg.norm(J[k] - gt[k]))
            assert err < 0.05, (k, err)
        # an axis-aligned input is left alone
        path2, _ = _mannequin_glb(d, "down")
        _, info2, _ = _detect(path2)
        assert not info2["yaw"]["corrected"] and abs(info2["yaw"]["residual_deg"]) < 2.0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_blade_down_sword_socket():
    """Synthetic sword hanging from the right fist: rigid to RightHand, hand socket +Z down the
    blade (contract 6), alignment measured against grip -> blade tip."""
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A", sword=True)
        res = _run("rig_humanoid", {"inputs": {"mesh": path},
                                    "params": {"intersections": False, "deform_test": False},
                                    "out_dir": os.path.join(d, "out")})
        assert res["ok"], (res["failed"], res.get("error"))
        st = res["stats"]
        props = [r for r in st["rigid"] if r["kind"] == "prop"]
        assert props and props[0]["bone"] == hl.b("RightHand") and props[0]["vertices"] > 100, st["rigid"]
        rule = st["grip_socket_rule"]["socket_mount_hand_r"]
        assert rule["rule"] == "blade_to_far_end", rule
        assert rule["socket_z"][2] < -0.9, rule              # +Z points down along the blade
        assert st["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_r"] < 10
        assert _check(res, "props_rigid")["ok"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_prepare_mixamo_refuses_failed_rig():
    """prerigged=true on a figure whose rig fails: no pre-rigged FBX, error check prerigged_rig_ok."""
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A", legless=True)
        res = _run("prepare_mixamo", {"inputs": {"mesh": path},
                                      "params": {"lite": True, "prerigged": True},
                                      "out_dir": os.path.join(d, "pm")})
        c = _check(res, "prerigged_rig_ok")
        assert c is not None and not c["ok"] and c["severity"] == "error", c
        assert not res["ok"] and "fbx_prerigged" not in res["outputs"]
        assert os.path.exists(res["outputs"]["fbx"])          # the plain upload FBX is still there
        assert any("not written" in w for w in res["warnings"]), res["warnings"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _bow_rig_asserts(res, side="Left", min_vertices=150):
    assert res["ok"], (res["failed"], res.get("error"))
    bows = [r for r in res["stats"]["rigid"] if r["kind"] == "bow"]
    assert len(bows) == 1 and bows[0]["bone"] == hl.b(side + "Hand") and bows[0]["shape"] == "bow", res["stats"]["rigid"]
    assert bows[0]["vertices"] >= min_vertices, bows
    for name in ("arm_symmetry", "landmark_proportions", "props_rigid", "rigid_bow_" + side + "Hand"):
        assert _check(res, name)["ok"], (name, _check(res, name))
    assert res["stats"]["arm_symmetry_max_h"] <= hl.ARM_SYM_MAX, res["stats"]["arm_symmetry_max_h"]
    # the hand socket runs up the riser (+Z along the bow's chord, upward)
    ang = res["stats"]["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_" + side[0].lower()]
    assert ang < 10.0, ang
    return bows[0]


def test_bow_held_beside_body_rigid_quiver_ignored():
    """Mannequin with a 1.3 m bow in the left fist and a quiver on the back: the bow is a held curved prop
    (rigid to LeftHand, out of the landmarks, symmetry passes), the quiver is not taken. Mutation: with
    find_bows disabled the wrist lands on the limb and the rig is refused for arm asymmetry (the archer
    behaviour before 11.10)."""
    d = _tmp()
    try:
        path, gt = _mannequin_glb(d, "A", bow=True, quiver=True)
        params = {"intersections": False, "deform_test": False}
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "params": dict(params), "out_dir": os.path.join(d, "out")})
        bw = _bow_rig_asserts(res)
        assert 1.15 < bw["length_m"] < 1.45 and 0.03 < bw["sagitta_m"] < 0.09, bw
        mk = json.load(open(res["outputs"]["markers_json"], encoding="utf-8"))
        assert len(mk["bows"]) == 1 and mk["bows"][0]["held_by"] == "Left", mk["bows"]
        # the wrist is on the arm (ground truth), not on the bow limb
        err = float(np.linalg.norm(np.array(mk["joints"]["LeftHand"]) - gt["LeftHand"]))
        assert err < 0.08, err
        orig = hl.Landmarks.find_bows
        hl.Landmarks.find_bows = lambda self: False
        try:
            res0 = _run("rig_humanoid", {"inputs": {"mesh": path}, "params": dict(params),
                                         "out_dir": os.path.join(d, "out0")})
        finally:
            hl.Landmarks.find_bows = orig
        assert not res0["ok"] and not _check(res0, "arm_symmetry")["ok"], (res0["failed"], res0["stats"].get("arm_symmetry_max_h"))
        # quiver alone: no bow
        path2, _ = _mannequin_glb(d, "A", quiver=True)
        lm, _, _ = _detect(path2)
        assert not lm.bow_props, lm.info.get("bows")
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------ integration round (10.10, evening)


def _load_rigged(path):
    if path.lower().endswith(".blend"):
        ima.open_blend(path)
        objs = list(bpy.context.scene.objects)
    else:
        ima.reset_scene()
        objs = ima.import_any(path)
    arm = next(o for o in objs if o.type == "ARMATURE")
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    body = max(IL.skinned_meshes(arm), key=lambda o: len(o.data.vertices))
    socks = IL.find_sockets()
    return arm, body, socks


def _mat_err(A, B):
    return max(abs(A[i][j] - B[i][j]) for i in range(4) for j in range(4))


def _kit_item(out, params):
    from steps import item_kit as K
    ima.reset_scene()
    item, info = K.build_item(params)
    K.export_item(item, out, info, preview=False)
    return os.path.join(out, "item.glb")


def _attach(character, atts, out):
    from steps import attach_prop as A
    res = A.run({"inputs": {"character": character}, "params": {"attachments": atts, "size": 200},
                 "out_dir": out})
    rep = json.load(open(res["outputs"]["json"], encoding="utf-8"))
    return res, rep


# ------------------------------------------------------------------ evidence (not a test)

def _png_rgb(arr, dst):
    """Opaque, maximally compressed RGB PNG of a top-down RGBA array (docs evidence)."""
    h, w = arr.shape[:2]
    im = bpy.data.images.new("imaginarium_evidence", width=w, height=h, alpha=False)
    im.pixels = np.ascontiguousarray(IL.over_bg(arr)[::-1]).ravel()
    st = bpy.context.scene.render.image_settings
    st.file_format, st.color_mode, st.compression = "PNG", "RGB", 100
    im.save_render(os.path.abspath(dst), scene=bpy.context.scene)
    bpy.data.images.remove(im)
    return {"path": dst, "kb": round(os.path.getsize(dst) / 1024.0, 1), "px": [w, h]}


# --------------------------------------------------------------------------- v2 fixes (10.10)

def test_input_sockets_survive_rig_and_grip_dirs():
    """Sockets of the input follow the body into the rig frame: socket_fx_eye_l becomes a child of the
    bone that drives the skull (Head), an input socket_mount_hand_l keeps its frame instead of being
    rebuilt; params.grip_dirs points +Z of a rebuilt hand socket exactly ("down" for the right hand)."""
    d = _tmp()
    try:
        ima.reset_scene()
        ob, gt = hl.make_mannequin("A")
        # the mannequin is shifted / scaled on the way in: the sockets must follow
        ob.data.transform(Matrix.Translation((0.3, -0.2, 0.0)) @ Matrix.Scale(0.5, 4))
        eye = ima.add_socket("socket_fx_eye_l", location=(0.3 + 0.5 * 0.035, -0.2 + 0.5 * -0.09, 0.5 * 1.70),
                            kind="fx")
        W = Vector(gt["LeftHand"]) + (Vector(gt["LeftHandTip"]) - Vector(gt["LeftHand"])) * 0.4
        hand = ima.add_socket("socket_mount_hand_l", location=(0.3 + 0.5 * W.x, -0.2 + 0.5 * W.y, 0.5 * W.z),
                             rotation=(0.0, 0.0, 0.0), kind="mount", grip_radius_m=0.02)
        path = os.path.join(d, "m.glb")
        ima.export_glb(path, objects=[ob, eye, hand], animations=False, skins=False)
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "out_dir": os.path.join(d, "out"),
                                    "params": {"intersections": False, "deform_test": False,
                                               "grip_dirs": {"r": "down"}}})
        assert res["ok"], (res["failed"], res.get("error"))
        st = res["stats"]
        assert st["input_sockets"] == ["socket_fx_eye_l", "socket_mount_hand_l"], st["input_sockets"]
        assert st["sockets_from_input"]["socket_fx_eye_l"]["bone"] == "Head", st["sockets_from_input"]
        assert st["hand_socket_frame"]["socket_mount_hand_l"]["source"] == "input", st["hand_socket_frame"]
        assert len(st["sockets"]) == 10
        ima.reset_scene()
        objs = ima.import_any(res["outputs"]["glb"])
        socks = {o.get("game_socket"): o for o in objs if o.get("game_socket")}
        bpy.context.view_layer.update()
        e = socks["socket_fx_eye_l"]
        assert e.parent_type == "BONE" and e.parent_bone.endswith("Head"), (e.parent_type, e.parent_bone)
        # back in the rig frame (x2, re-centred): the eye lands where the mannequin's eye is
        assert (e.matrix_world.translation - Vector((0.035, -0.09, 1.70))).length < 0.02, e.matrix_world.translation
        h = socks["socket_mount_hand_l"]
        assert h.parent_bone.endswith("LeftHand")
        assert (h.matrix_world.translation - W).length < 0.02, (h.matrix_world.translation, W)
        R = h.matrix_world.to_3x3().normalized()
        assert (R @ Vector((0, 0, 1))).z > 0.999, R          # the input frame (identity rotation) is kept
        assert abs(h.get("grip_radius_m", 0) - 0.02) < 1e-6
        r = socks["socket_mount_hand_r"].matrix_world.to_3x3().normalized() @ Vector((0, 0, 1))
        assert r.z < -0.999, r                               # grip_dirs r: down
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_small_islands_kept_out_of_bone_heat_and_bound_rigidly():
    """Loose little pieces (a skeletal hand of separate bones, beads) make Blender's heat solver give
    up on the whole mesh; they stay out of the proxy and ride rigidly on the nearest bone."""
    d = _tmp()
    try:
        ima.reset_scene()
        ob, gt = hl.make_mannequin("A")
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        tip = Vector(gt["RightHandTip"])
        for k in range(12):          # 'finger bones': a cluster of cubes 2 mm apart below the right hand
            res_ = bmesh.ops.create_cube(bm, size=0.012)
            bmesh.ops.translate(bm, vec=tip + Vector((0.014 * (k % 3) - 0.014, 0.0, -0.014 * (k // 3))),
                                verts=res_["verts"])
        for k in range(3):           # beads in front of the chest
            res_ = bmesh.ops.create_cube(bm, size=0.02)
            bmesh.ops.translate(bm, vec=Vector((0.0, -0.16, 1.15 + 0.025 * k)), verts=res_["verts"])
        bm.to_mesh(ob.data)
        bm.free()
        path = os.path.join(d, "m.glb")
        ima.export_glb(path, objects=[ob], animations=False, skins=False)
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "out_dir": os.path.join(d, "out"),
                                    "params": {"intersections": False}})
        assert res["ok"], (res["failed"], res.get("error"))
        si = res["stats"]["skin"]["small_islands"]
        assert si["clusters"] == 2 and si["vertices"] >= 15 * 8, si
        bones = sorted(c["bone"] for c in si["bound"])
        assert bones[0].startswith("RightHand") and bones[1].startswith("Spine"), si["bound"]
        assert res["stats"]["skin"]["attempts"][0]["unweighted_frac"] < 0.002, res["stats"]["skin"]["attempts"]
        assert _check(res, "unweighted_vertices")["value"] == 0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_repair_for_heat_drops_nonmanifold_faces():
    ima.reset_scene()
    import bmesh
    me = bpy.data.meshes.new("t")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.edges.ensure_lookup_table()
    e = bm.edges[0]
    a, b_ = e.verts
    c = bm.verts.new((0.0, 0.0, 2.0))
    bm.faces.new((a, b_, c))          # a third face on that edge
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("t", me)
    bpy.context.scene.collection.objects.link(ob)
    info = hl.repair_for_heat(ob, 1.8)
    assert info["nonmanifold_faces"] >= 3, info
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    assert not any(len(e.link_faces) > 2 for e in bm.edges)
    bm.free()


NECRO_V2_MARKERS = {"l_wrist": [0.480082, -0.142343, 1.157233], "l_elbow": [0.385688, 0.093641, 1.187847],
                    "r_wrist": [-0.380193, -0.125434, 0.991049],
                    "joints": {"LeftHandTip": [0.556372, -0.206123, 1.146663],
                               "RightHandTip": [-0.406863, -0.156064, 0.899669]}}


def test_oblique_sword_held_forward_rigid_to_hand():
    """A flat 8 cm blade held forward, down and out from the right fist (the pose of the generated knights):
    the vertical/X/Y slice passes do not see it (it crosses them obliquely, wider than their limit) and it
    used to become part of the arm. find_blades takes it from the diagonal slicings: a fist on it, a free tip
    beyond the bare arm's reach. The prop is rigid to RightHand, the wrist stays on the arm, the hand socket
    +Z runs toward the blade tip. Mutation: without find_blades the blade is not a prop and the right wrist
    lands far from the fist."""
    d = _tmp()
    try:
        path, gt = _mannequin_glb(d, "A", sword="oblique")
        params = {"intersections": False, "deform_test": False}
        res = _run("rig_humanoid", {"inputs": {"mesh": path}, "params": dict(params), "out_dir": os.path.join(d, "out")})
        assert res["ok"], (res["failed"], res.get("error"))
        props = [r for r in res["stats"]["rigid"] if r["kind"] == "prop"]
        assert len(props) == 1 and props[0]["bone"] == hl.b("RightHand") and props[0]["vertices"] > 100, props
        assert 0.7 < props[0]["length_m"] < 1.05, props
        mk = json.load(open(res["outputs"]["markers_json"], encoding="utf-8"))
        assert mk["props"][0]["oblique"] and mk["props"][0]["held_by"] == "Right", mk["props"]
        blades = [b for b in mk["detector"]["blades"] if b.get("accepted")]
        assert len(blades) == 1 and blades[0]["tip_reach_h"] > hl.BLADE_REACH, mk["detector"]["blades"]
        err = float(np.linalg.norm(np.array(mk["joints"]["RightHand"]) - gt["RightHand"]))
        assert err < 0.08, err
        rule = res["stats"]["grip_socket_rule"]["socket_mount_hand_r"]
        assert rule["rule"] == "blade_to_far_end", rule
        assert res["stats"]["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_r"] < 15, res["stats"]["grip_socket_vs_prop_axis_deg"]
        assert _check(res, "props_rigid")["ok"]
        orig = hl.Landmarks.find_blades
        hl.Landmarks.find_blades = lambda self: False
        try:
            lm0, _, _ = _detect(path)
        finally:
            hl.Landmarks.find_blades = orig
        assert not lm0.props, [p.get("oblique") for p in lm0.props]
        err0 = float(np.linalg.norm(lm0.joints_m()["RightHand"] - gt["RightHand"]))
        assert err0 > 0.15 or lm0.fail is not None, (err0, lm0.fail)
        # the plain mannequin gets no oblique prop (limbs are not blades)
        path2, _ = _mannequin_glb(d, "A")
        lm2, _, _ = _detect(path2)
        assert not lm2.props and not [b for b in lm2.info.get("blades", []) if b.get("accepted")], lm2.info.get("blades")
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------ 12.10: front prior, hard-surface armour

def _coloured_mannequin(d, rgb, name="coloured"):
    """The A-pose mannequin with a uniform base-colour texture (UVMap, image node -> Base Color), as a GLB."""
    ima.reset_scene()
    ob, _ = hl.make_mannequin("A")
    img = bpy.data.images.new(name, 64, 64)
    img.pixels = np.tile(np.array(list(rgb) + [1.0], dtype=np.float32), 64 * 64)
    p_img = os.path.join(d, name + ".png")
    img.filepath_raw = p_img
    img.file_format = "PNG"
    img.save()
    mat = ob.data.materials[0]
    mat.use_nodes = True
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    ob.data.uv_layers.new(name="UVMap")
    path = os.path.join(d, name + ".glb")
    ima.export_glb(path, objects=[ob], animations=False, skins=False)
    return path


def test_front_prior_beats_back_facing_answer():
    """front_prior -Y (generated front-view concepts): a detector answer of +Y loses to the prior, with a warning;
    without the prior the detector's answer stands."""
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A", rot_z=180.0)
        _, info, w = _detect(path)
        assert info["facing"]["detected"] == "+Y", info["facing"]
        _, info2, w2 = _detect(path, {"front_prior": "-Y"})
        assert info2["facing"]["detected"] == "-Y" and info2["facing"]["overridden"] == "+Y", info2["facing"]
        assert any("front_prior" in x for x in w2), w2
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_hard_surface_plates_rigid_on_grey_armour():
    """A mannequin painted steel grey: hard_surface on makes plate regions rigid (weight 1.0 on one bone each,
    no stretch inside them in any test pose, while the same triangles stretched with the smooth weights);
    a brown (skin / cloth) mannequin under auto keeps its smooth weights."""
    d = _tmp()
    try:
        grey = _coloured_mannequin(d, (0.55, 0.56, 0.58), "steel")
        res = _run("rig_humanoid", {"inputs": {"mesh": grey},
                                    "params": {"intersections": False, "hard_surface": "on", "deform_gate": "warning"},
                                    "out_dir": os.path.join(d, "out_grey")})
        assert res["ok"], (res["failed"], res.get("error"))
        hs = res["stats"]["hard_surface"]
        assert hs["enabled"] and hs["plates"] >= 6 and hs["rigid_area_frac"] > 0.05, hs
        assert hs["metal_area_frac"] > 0.9, hs
        for pose, v in hs["pose_test_hard"].items():
            assert v["plate_rubber_pct"] == 0.0, (pose, v)
        assert max(v["plate_rubber_pct"] for v in hs["pose_test_soft"].values()) > 0.0, hs["pose_test_soft"]
        assert {"Head", "Spine2"} & set(hs["by_bone"]), hs["by_bone"]
        brown = _coloured_mannequin(d, (0.6, 0.3, 0.2), "skin")
        res2 = _run("rig_humanoid", {"inputs": {"mesh": brown},
                                     "params": {"intersections": False, "deform_test": False, "hard_surface": "auto"},
                                     "out_dir": os.path.join(d, "out_brown")})
        hs2 = res2["stats"]["hard_surface"]
        assert not hs2["enabled"] and hs2["metal_area_frac"] < 0.05, hs2
        res3 = _run("rig_humanoid", {"inputs": {"mesh": brown},
                                     "params": {"intersections": False, "deform_test": False, "hard_surface": "auto",
                                                "build": "armored"},
                                     "out_dir": os.path.join(d, "out_brown_armored")})
        hs3 = res3["stats"]["hard_surface"]
        assert hs3["enabled"] and hs3["plates"] == 0, hs3      # armored, but nothing is painted metal
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_shoulders_measured_against_the_solid_head_top():
    """A crown / halo / crest above the head counts into the head top and pushed the shoulders below 0.70 H
    ("not a humanoid": the crusader 0.67-0.69). solid_head_top() is the highest slice whose largest component
    near the midline covers >= 40 % of the fullest head cross-section (on a bare head it is the head top itself);
    sanity() measures out-of-range shoulders against it as well."""
    d = _tmp()
    try:
        path, _ = _mannequin_glb(d, "A")
        lm, info, w = _detect(path)
        solid = lm.solid_head_top()
        assert solid is not None and abs(solid - lm.top) < 0.02, (solid, lm.top)
        z0 = lm.shoulder_z
        # shoulders under 0.70 of a spiky top, but in range against the solid head under the spikes
        lm.shoulder_z = 0.69
        lm.solid_head_top = lambda min_fill=0.4: 0.93
        lm.fail = None
        lm.sanity()
        assert lm.fail is None or "shoulders" not in lm.fail, lm.fail
        assert abs(lm.info["solid_head_top"]["shoulders_vs_solid_top"] - 0.69 / 0.93) < 1e-3, lm.info["solid_head_top"]
        # a figure whose shoulders are low against the solid head too is still refused
        lm.shoulder_z = 0.60
        lm.solid_head_top = lambda min_fill=0.4: 0.97
        lm.fail = None
        lm.sanity()
        assert lm.fail and "shoulders at 0.60" in lm.fail, lm.fail
        assert 0.70 <= z0 <= 0.88
    finally:
        shutil.rmtree(d, ignore_errors=True)


# =========================================================================== real assets
# Fixtures on disk (module constants above, Imaginarium_* environment overrides); every case returns a
# "skip: ..." string when its files are missing, so a machine without the assets shows them as SKIP.

def test_real_necromancer():
    if not os.path.exists(NECRO):
        return "skip: necromancer fixture missing: %s" % NECRO
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": NECRO}, "params": {}, "out_dir": d})
        st = res["stats"]
        assert st["facing"] == "-Y" and st["robe"] is True
        assert os.path.exists(res["outputs"]["glb"])
        props = [r for r in st["rigid"] if r["kind"] == "prop"]
        assert props and props[0]["bone"] == hl.b("LeftHand"), st["rigid"]   # +X side = character left
        assert st["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_l"] < 10
        assert st["grip_socket_rule"]["socket_mount_hand_l"]["rule"] == "shaft_up"
        assert _check(res, "robe_stride_tear")["ok"]
        assert st["landmark_confidence"] >= 0.5
        for name in ("landmark_confidence", "landmark_proportions", "unweighted_vertices", "bones",
                     "props_rigid", "centred", "rigid_prop_LeftHand"):
            assert _check(res, name)["ok"], name
        # known failure, reported honestly: the right sleeve is fused to the robe; with the arms
        # forward that web becomes a sheet (~12 % of the posed surface)
        c = _check(res, "deform_torn_area")
        assert c["value"] > c["limit"] and not res["ok"], c
        assert set(res["failed"]) <= {"deform_torn_area", "deform_torn_area_arms_up"}, res["failed"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_necromancer_decimated_keeps_staff():
    """Smoke 10.10: after cleanup to 40 000 tris the staff was not detected (arm asymmetry 0.231 H, no rig).
    At 40k and 20k the staff is found and bound to LeftHand; the only failures left are the honest ones
    (the fused sleeve tears: deform_torn_area*)."""
    if not os.path.exists(NECRO):
        return "skip: necromancer fixture missing: %s" % NECRO
    d = _tmp()
    try:
        for tris in (40000, 20000):
            cl = _run("cleanup", {"inputs": {"mesh": NECRO}, "params": {"target_tris": tris, "height_m": 1.8},
                                  "out_dir": os.path.join(d, "clean%d" % tris)})
            assert cl["ok"] and cl["stats"]["after"]["tris"] <= tris, cl.get("failed")
            ima.open_blend(cl["outputs"]["blend"])
            res = _run("rig_humanoid", {"inputs": {"blend": cl["outputs"]["blend"]}, "params": {"height_m": 1.8},
                                        "out_dir": os.path.join(d, "rig%d" % tris)})
            st = res["stats"]
            props = [r for r in st["rigid"] if r["kind"] == "prop"]
            assert props and props[0]["bone"] == hl.b("LeftHand"), (tris, st["rigid"])
            for name in ("landmark_confidence", "landmark_proportions", "arm_symmetry", "props_rigid"):
                assert _check(res, name)["ok"], (tris, name, _check(res, name))
            assert st["landmark_confidence"] >= 0.5, (tris, st["landmark_confidence"])
            assert set(res["failed"]) <= {"deform_torn_area", "deform_torn_area_arms_up"}, (tris, res["failed"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


NECRO_V2_PLACED = (os.environ.get("Imaginarium_NECRO_V2_GLB")
                   or r"C:/Imaginarium/test-assets/NecromancerForge/v2/pre_rig/placed.glb")


def test_real_necromancer_v2_tear_gate():
    """The v2 necromancer (sleeves slit off the robe, open hem, bone_kit hands with their sockets,
    clasps, eye sockets): the rig passes the tear gate honestly and keeps every input socket."""
    if not os.path.exists(NECRO_V2_PLACED):
        return "skip: no %s" % NECRO_V2_PLACED
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": NECRO_V2_PLACED}, "out_dir": os.path.join(d, "out"),
                                    "params": {"height_m": 1.8, "proxy_tris": 60000, "intersections": False,
                                               "markers": NECRO_V2_MARKERS}})
        assert res["ok"], (res["failed"], res.get("error"))
        de = res["stats"]["deformation"]
        assert de["arms_forward"]["torn_area_frac"] < 0.01 and de["stride"]["torn_area_frac"] < 0.01, de
        assert de["arms_up"]["torn_area_frac"] < 0.08, de["arms_up"]
        st = res["stats"]
        for n in ("socket_fx_eye_l", "socket_fx_eye_r", "socket_mount_hand_l", "socket_mount_hand_r"):
            assert n in st["sockets"] and n in st["input_sockets"], (n, st["sockets"])
        assert st["sockets_from_input"]["socket_fx_eye_l"]["bone"] == "Head", st["sockets_from_input"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_base_meshes_and_fingers():
    if not os.path.exists(BUNDLE):
        return "skip: base meshes bundle missing: %s" % BUNDLE
    for name, fingers in (("GEO-body_male_realistic", True), ("GEO-body_female_realistic", False)):
        d = _tmp()
        try:
            res = _run("rig_humanoid", {"inputs": {"mesh": BUNDLE},
                                        "params": {"objects": [name], "fingers": fingers,
                                                   "intersections": False},
                                        "out_dir": d})
            assert res["ok"], (name, res["failed"])
            assert res["stats"]["bones"] == (65 if fingers else 25), res["stats"]["bones"]
            assert res["stats"]["pose_class"] in ("A", "arms_down")
            assert _check(res, "deform_torn_area")["value"] < 0.005
        finally:
            shutil.rmtree(d, ignore_errors=True)


BATCH_CLEAN = os.environ.get("Imaginarium_BATCH_CLEAN") or r"C:/Imaginarium/incoming/pilot2/clean"


def test_real_batch_swordsmen_blades_rigid():
    """Generated game swordsmen (concept batch, cleaned to 40k triangles; skipped when the files
    are missing): the bone swordsman's two swords held down-and-out and knight #3's sword held forward-down
    were refused (arm 0.62-0.64 H). Now each sword is an oblique held prop rigid to its hand and the
    landmarks pass (leg minimum 0.31 H: these stocky figures measure 0.325-0.33 H)."""
    cases = {"bone_swordsman_wielding_two_swords": {"Left", "Right"}, "knight_holding_sword_and_shield_3": {"Right"}}
    ran = 0
    for name, hands in cases.items():
        p = os.path.join(BATCH_CLEAN, name, "clean.glb")
        if not os.path.exists(p):
            continue
        ran += 1
        d = _tmp()
        try:
            res = _run("rig_humanoid", {"inputs": {"mesh": p}, "params": {"intersections": False, "deform_test": False},
                                        "out_dir": d})
            assert res["ok"], (name, res["failed"], res.get("error"))
            mk = json.load(open(res["outputs"]["markers_json"], encoding="utf-8"))
            obl = {pp["held_by"] for pp in mk["props"] if pp["oblique"]}
            assert obl == hands, (name, mk["props"])
            for side in hands:
                assert _check(res, "rigid_prop_" + side + "Hand")["ok"], name
            assert res["stats"]["arm_symmetry_max_h"] < 0.15, (name, res["stats"]["arm_symmetry_max_h"])
        finally:
            shutil.rmtree(d, ignore_errors=True)
    if not ran:
        return "skip: batch fixtures missing under " + BATCH_CLEAN


def test_real_ghost_fails():
    p = os.path.join(ART_RAW, "ghost", "model.glb")
    if not os.path.exists(p):
        return "skip: ghost asset missing: " + p
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": p}, "params": {}, "out_dir": d})
        assert not res["ok"] and "ground support" in res.get("error", ""), res.get("error")
        assert os.path.exists(res["outputs"]["markers_png"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_import_mixamo_archer():
    fbx = os.path.join(ART_RAW, "archer", "anims", "idle.fbx")
    glb = os.path.join(ART_RAW, "archer", "model.glb")
    if not (os.path.exists(fbx) and os.path.exists(glb)):
        return "skip: archer fixtures missing under " + ART_RAW
    d = _tmp()
    try:
        res = _run("import_mixamo_rig", {"inputs": {"fbx": fbx}, "params": {"texture_source": glb},
                                         "out_dir": d})
        assert res["ok"], res["failed"]
        assert res["stats"]["facing"]["detected"] == "-Y"
        assert res["stats"]["retex"]["mode"] in ("material", "image")
        assert res["stats"]["actions"], "the idle clip should be kept"
        # contract 7: the glTF animation is named by the clip, "-loop" for a looping clip
        assert res["stats"]["clip"]["name"] == "idle-loop", res["stats"]["clip"]
        assert _glb_animation_names(res["outputs"]["glb"]) == ["idle-loop"]
        res2 = _run("import_mixamo_rig", {"inputs": {"fbx": fbx},
                                          "params": {"clip": "bow_idle", "loop": False, "sockets": False},
                                          "out_dir": os.path.join(d, "b")})
        assert _glb_animation_names(res2["outputs"]["glb"]) == ["bow_idle"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_knight_sword_rigid():
    """A generated knight: the 0.99 m sword hangs from the right fist (end grip above the crossguard) -
    rigid to RightHand, socket +Z down the blade; the heater shield rigid to LeftHand."""
    if not os.path.exists(KNIGHT):
        return "skip: knight fixture missing: " + KNIGHT
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": KNIGHT}, "params": {"intersections": False},
                                    "out_dir": d})
        st = res["stats"]
        kinds = {(r["kind"], r["bone"]) for r in st["rigid"]}
        assert ("prop", hl.b("RightHand")) in kinds and ("plate", hl.b("LeftHand")) in kinds, st["rigid"]
        assert _check(res, "props_rigid")["ok"] and _check(res, "rigid_prop_RightHand")["ok"]
        rule = st["grip_socket_rule"]["socket_mount_hand_r"]
        assert rule["rule"] == "blade_to_far_end" and rule["socket_z"][2] < -0.9, rule
        assert _check(res, "landmark_proportions")["ok"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_militia_spear_and_shield():
    p = os.path.join(ART_RAW, "militia", "model.glb")
    if not os.path.exists(p):
        return "skip: militia asset missing: " + p
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": p}, "params": {"intersections": False}, "out_dir": d})
        assert res["ok"], res["failed"]
        kinds = {(r["kind"], r["bone"]) for r in res["stats"]["rigid"]}
        assert ("prop", hl.b("RightHand")) in kinds and ("plate", hl.b("LeftHand")) in kinds, kinds
        assert res["stats"]["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_r"] < 10
        assert _check(res, "centred")["ok"] and abs(_check(res, "centred")["value"]) < 0.01
        assert _check(res, "props_rigid")["ok"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------ v2 fixes (10.10)

def test_real_archer_bow_rigid_to_left_hand():
    """The archer model (11.10): the long bow in the left hand used to put the wrist on the bow limb (arm
    asymmetry 0.26 H, rig refused). find_bows takes the limb and string out of the landmarks: the rig
    passes, the bow is rigid to LeftHand, the quiver at the right hip stays body."""
    p = os.path.join(ART_RAW, "archer", "model.glb")
    if not os.path.exists(p):
        return "skip: archer asset missing: " + p
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": p}, "params": {"intersections": False}, "out_dir": d})
        bw = _bow_rig_asserts(res, min_vertices=300)
        assert bw["length_m"] > 1.5, bw
        assert res["stats"]["arm_symmetry_max_h"] < 0.05, res["stats"]["arm_symmetry_max_h"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_scout_short_bow_rigid_to_left_hand():
    """The scout model (scout.blend, Body): the short bow was found as a shield "plate" (sleeve pulled
    along) or not at all (arm asymmetry 0.28 H). Now a held bow, rigid to LeftHand, no plate."""
    p = os.path.join(ART_RAW, "scout", "scout.blend")
    if not os.path.exists(p):
        return "skip: scout asset missing: " + p
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": p}, "params": {"objects": ["Body"], "intersections": False},
                                    "out_dir": d})
        bw = _bow_rig_asserts(res, min_vertices=150)
        assert 0.8 < bw["length_m"] < 1.3, bw
        assert res["stats"]["plates"] == 0, res["stats"]["plates"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_warrior_centred_and_blade_down():
    """The warrior model (.blend, turned 15 deg in the file, shield on the left): centred on the trunk
    (|Hips.x| < 1 cm, contract 4), yaw removed, sword socket +Z down the blade."""
    p = os.path.join(ART_RAW, "warrior", "warrior.blend")
    if not os.path.exists(p):
        return "skip: warrior asset missing: " + p
    d = _tmp()
    try:
        res = _run("rig_humanoid", {"inputs": {"mesh": p},
                                    "params": {"objects": ["Body"], "intersections": False,
                                               "deform_test": False}, "out_dir": d})
        st = res["stats"]
        assert st["yaw"]["corrected"] and abs(st["yaw"]["residual_deg"] - 15.0) < 3.0, st["yaw"]
        c = _check(res, "centred")
        assert c["ok"] and abs(c["value"]) < 0.01, c
        rule = st["grip_socket_rule"]["socket_mount_hand_r"]
        assert rule["rule"] == "blade_to_far_end" and rule["socket_z"][2] < -0.9, rule
        assert st["grip_socket_vs_prop_axis_deg"]["socket_mount_hand_r"] < 15
        kinds = {(r["kind"], r["bone"]) for r in st["rigid"]}
        assert ("plate", hl.b("LeftHand")) in kinds, st["rigid"]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_rotated_zombie_matches():
    """The zombie turned 30 deg gives the same landmarks as the original."""
    p = os.path.join(ART_RAW, "zombie", "model.glb")
    if not os.path.exists(p):
        return "skip: zombie asset missing: " + p
    d = _tmp()
    try:
        ima.reset_scene()
        objs = ima.import_any(p)
        for o in ima.meshes(objs):
            o.data.transform(o.matrix_world)
            o.matrix_world = Matrix.Identity(4)
            o.data.transform(Matrix.Rotation(math.radians(30), 4, "Z"))
        rot = os.path.join(d, "rot30.glb")
        ima.export_glb(rot, objects=ima.meshes(objs), animations=False, skins=False)
        lm0, _, _ = _detect(p)
        lm1, info, _ = _detect(rot)
        assert info["yaw"]["corrected"]
        J0, J1 = lm0.joints_m(), lm1.joints_m()
        for k in ("LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand", "LeftLeg"):
            assert float(np.linalg.norm(J0[k] - J1[k])) < 0.02, k
        assert lm1.arm_sym_max < 0.05
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_zombie_shoulders_vs_reference_rig():
    """Arm heads within 4 cm of the reference auto-rig of the same model (zombie/mixamo_rigged.fbx,
    built from hand-placed markers) at the same height, front view."""
    p = os.path.join(ART_RAW, "zombie", "model.glb")
    ref = os.path.join(ART_RAW, "zombie", "mixamo_rigged.fbx")
    if not (os.path.exists(p) and os.path.exists(ref)):
        return "skip: zombie fixtures missing under " + ART_RAW
    H = 1.7
    R = _arm_heads_from_fbx(ref, H)
    lm, _, _ = _detect(p, {"height_m": H})
    J = lm.joints_m()
    for side in ("Left", "Right"):
        ours = np.array([J[side + "Arm"][0], J[side + "Arm"][2]])
        e = float(np.linalg.norm(ours - R[side]))
        assert e <= 0.04, (side, ours, R[side], e)


def test_real_upper_fore_ratios():
    """Upper arm / forearm in 0.8..1.5 on the zombie, militia and generated knight."""
    ran = 0
    for p in (os.path.join(ART_RAW, "zombie", "model.glb"), os.path.join(ART_RAW, "militia", "model.glb"), KNIGHT):
        if not os.path.exists(p):
            continue
        ran += 1
        lm, _, _ = _detect(p)
        assert lm.fail is None, (p, lm.fail)
        for side, r in lm.ratios.items():
            assert 0.8 <= r["upper_fore"] <= 1.5, (p, side, r)
    if not ran:
        return "skip: no landmarks fixture present"


# ------------------------------------------------------------------ integration round (10.10, evening)
# Each test rigs the zombie into its own temp folder and removes it (the shared runner ends with
# os._exit, so a cached rig would leak its folder).

ZOMBIE = os.path.join(ART_RAW, "zombie", "model.glb")
_ZRIG = {}   # numbers kept for make_socket_evidence


def _zombie_rig(d):
    out = os.path.join(d, "rig")
    res = _run("rig_humanoid", {"inputs": {"mesh": ZOMBIE}, "params": {"height_m": 1.7, "intersections": False},
                                "out_dir": out})
    assert res["ok"], (res["failed"], res.get("error"))
    return out, res


def test_real_zombie_vs_hand_markers():
    p = os.path.join(ART_RAW, "zombie", "model.glb")
    if not os.path.exists(p):
        return "skip: zombie asset missing: " + p
    # hand-placed reference markers (art/specs/zombie.markers.json) were set at 1.7 m
    ref = {"l_wrist": [0.432, 0.927], "r_wrist": [-0.435, 0.925], "l_elbow": [0.358, 1.086],
           "r_elbow": [-0.352, 1.092], "l_knee": [0.158, 0.490], "r_knee": [-0.160, 0.490]}
    lm, info, _ = _detect(p, {"height_m": 1.7})
    assert info["facing"]["detected"] == "+X"
    mk = lm.markers_dict()
    for k, (x, z) in ref.items():
        e = math.hypot(mk[k][0] - x, mk[k][1] - z)
        assert e < 0.07, (k, mk[k], (x, z), e)


def test_real_zombie_hand_socket_is_attach_prop_frame():
    """Task: one hand frame for everyone. socket_mount_hand_r/l of rig_humanoid on the zombie equal
    what attach_prop computes for that rig (_items_lib.hand_socket_frame, its defaults) within 1e-4,
    in the saved .blend and after a glTF round trip (what attach_prop sees when given rigged.glb)."""
    if not os.path.exists(ZOMBIE):
        return "skip: zombie asset missing"
    d = _tmp()
    try:
        out, res = _zombie_rig(d)
        assert {"socket_mount_hand_l", "socket_mount_hand_r", "socket_mount_shield_l",
                "socket_mount_shield_r"} <= set(res["stats"]["sockets"]), res["stats"]["sockets"]
        errs = {}
        for src in ("rigged.blend", "rigged.glb"):
            arm, body, socks = _load_rigged(os.path.join(out, src))
            for side in ("r", "l"):
                M, info = IL.hand_socket_frame(arm, body, side)
                S = IL.normalized4(socks["socket_mount_hand_" + side].matrix_world.copy())
                err = _mat_err(M, S)
                errs["%s:%s" % (src, side)] = err
                assert err < 1e-4, (src, side, err, M, S)
                assert info["thumb_source"] == "character_forward", info
                # contract 6: +Z = thumb side = front of an A-pose hand, -Y along the fingers (down)
                assert S.col[2].to_3d().dot(Vector((0, -1, 0))) > 0.7, (side, S.col[2])
                assert (-S.col[1].to_3d()).dot(Vector((0, 0, -1))) > 0.5, (side, S.col[1])
        _ZRIG["hand_frame_max_abs_err"] = max(errs.values())
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_zombie_markers_projection_matches_png():
    """markers.json carries the projection block the marker editor reads (forge-core.js
    markerProjection): every joint projected with it lands on its sphere in markers.png. Spheres are
    located in check renders of the same scene (only a group of well separated spheres visible, the
    framing unchanged) by their alpha-weighted centroid; error < 2 px."""
    if not os.path.exists(ZOMBIE):
        return "skip: zombie asset missing"
    d = _tmp()
    try:
        out, _ = _zombie_rig(d)
        mk = json.load(open(os.path.join(out, "markers.json"), encoding="utf-8"))
        pr = mk["projection"]
        img = bpy.data.images.load(os.path.join(out, "markers.png"), check_existing=False)
        assert [pr["image"]["width"], pr["image"]["height"]] == list(img.size), (pr["image"], list(img.size))
        bpy.data.images.remove(img)
        assert pr["center_px"] == [pr["front_tile"]["width"] / 2.0, pr["image"]["height"] / 2.0]
        H = float(mk["height_m"])
        J = {k: np.array(v, dtype=np.float64) for k, v in mk["joints"].items()}
        conf = dict(mk["confidence"])
        arm, body, _ = _load_rigged(os.path.join(out, "rigged.blend"))
        for o in list(bpy.context.scene.objects):          # sockets and rig do not render; keep the body only
            if o is not body:
                bpy.data.objects.remove(o, do_unlink=True)
        body.modifiers.clear()
        again = {}
        hl.render_markers(os.path.join(d, "again.png"), body, J, conf, H, projection=again)
        # same scene again (joints rounded to 0.1 mm in markers.json): the same projection
        for k in ("center", "center_px"):
            assert max(abs(a - b) for a, b in zip(again[k], pr[k])) < 2e-4, (k, again[k], pr[k])
        assert abs(again["meters_per_px"] - pr["meters_per_px"]) < 2e-7

        def uv(p):
            return (pr["center_px"][0] + (p[0] - pr["center"][0]) / pr["meters_per_px"],
                    pr["center_px"][1] - (p[2] - pr["center"][1]) / pr["meters_per_px"])
        r_px = 0.012 * H * 1.4 / pr["meters_per_px"]
        pts = {k: uv(p) for k, p in J.items()}
        groups = []
        for k in sorted(pts):
            for g in groups:
                if all(math.hypot(pts[k][0] - pts[q][0], pts[k][1] - pts[q][1]) > 4.2 * r_px for q in g):
                    g.append(k)
                    break
            else:
                groups.append([k])
        errors = {}
        for gi, g in enumerate(groups):
            path = os.path.join(d, "check_%d.png" % gi)
            hl.render_markers(path, body, J, conf, H, show=set(g))
            im = bpy.data.images.load(path, check_existing=False)
            w_, h_ = im.size
            a = np.array(im.pixels[:], dtype=np.float32).reshape(h_, w_, 4)[::-1, :, 3]   # top row first
            bpy.data.images.remove(im)
            for k in g:
                u0, v0 = pts[k]
                win = 2.2 * r_px
                i0, i1 = int(max(0, u0 - win)), int(min(pr["front_tile"]["width"], u0 + win + 1))
                j0, j1 = int(max(0, v0 - win)), int(min(h_, v0 + win + 1))
                sub = a[j0:j1, i0:i1]
                assert sub.sum() > 10, (k, "no sphere pixels near the projected joint", (u0, v0))
                jj, ii = np.mgrid[j0:j1, i0:i1]
                cu = float(((ii + 0.5) * sub).sum() / sub.sum())
                cv = float(((jj + 0.5) * sub).sum() / sub.sum())
                errors[k] = math.hypot(cu - u0, cv - v0)
        assert len(errors) == len(J), (len(errors), len(J))
        worst = max(errors.values())
        assert worst < 2.0, sorted(errors.items(), key=lambda kv: -kv[1])[:5]
        _ZRIG["projection_errors_px"] = {"max": round(worst, 3),
                                         "mean": round(float(np.mean(list(errors.values()))), 3),
                                         "joints": len(errors), "check_renders": len(groups)}
        print("projection check:", _ZRIG["projection_errors_px"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_real_zombie_rig_takes_kit_sword_and_shield_without_refit():
    """A kit sword attached to the rigged zombie needs no refit: attach_prop reuses socket_mount_hand_r
    as it is, the grip sits in the hand and the blade runs along socket +Z (contract 6). The kite shield
    reuses the rig's socket_mount_shield_l untouched. Deleting the rig's sockets and letting attach_prop
    build them itself gives the same world matrices (sword and shield) within 1e-4."""
    if not os.path.exists(ZOMBIE):
        return "skip: zombie asset missing"
    d = _tmp()
    try:
        out, _ = _zombie_rig(d)
        sword = _kit_item(os.path.join(d, "sword"), {"type": "sword", "ornament": 2})
        kite = _kit_item(os.path.join(d, "kite"), {"type": "shield_kite", "ornament": 1})
        atts = [{"item": sword, "hand": "r"}, {"item": kite, "hand": "l"}]
        res, rep = _attach(os.path.join(out, "rigged.glb"), atts, os.path.join(d, "a"))
        errs = [c for c in res["checks"] if not c["ok"] and c.get("severity", "error") == "error"]
        assert not errs, errs
        assert rep["hand_sockets"]["r"]["info"]["created"] is False
        assert rep["hand_sockets"]["l"]["info"]["created"] is False
        assert rep["mounts"]["socket_mount_shield_l"]["status"] == "existing", rep["mounts"]
        sw, sh = rep["attachments"]
        assert sw["mount"] == "socket_mount_hand_r" and sw["grip_on_mount_error"]["pos_m"] < 1e-4
        r = sw["rest"]
        assert r["grip_to_hand_m"] < 0.03 and r["axis_inside_arm"] == 0, r
        assert r["overlap_arm_tris"] + r["overlap_body_tris"] == 0, r
        # the canonical proxy clears the open hand; the real kite (thicker board/handle) may graze a few
        # hand triangles - attach_prop reports that as the warning hand_through_board_rest
        assert sh["mount"] == "socket_mount_shield_l" and sh["rest"]["overlap_hand_tris"] <= 4, sh["rest"]
        assert sh["rest"]["overlap_arm_tris"] + sh["rest"]["overlap_body_tris"] == 0, sh["rest"]
        assert sh["rest"]["shield_up_dot"] >= 0.9 and sh["rest"]["shield_face_out_dot"] >= 0.5, sh["rest"]
        # geometry in the equipped scene: grip inside the hand, blade along socket +Z
        arm, body, socks = _load_rigged(res["outputs"]["blend"])
        S = IL.normalized4(socks["socket_mount_hand_r"].matrix_world.copy())
        g, z = S.translation, S.col[2].to_3d().normalized()
        hb = arm.data.bones["mixamorig:RightHand"]
        wrist, tip = arm.matrix_world @ hb.head_local, arm.matrix_world @ hb.tail_local
        ax = (tip - wrist).normalized()
        w = IL.group_weights(body, IL.side_group_names(body, "Right", ("Hand",)))
        hv = np.array([tuple(body.matrix_world @ body.data.vertices[i].co) for i in np.where(w > 0.5)[0]])
        t_h = (hv - np.array(wrist)) @ np.array(ax)
        t_g = (g - wrist).dot(ax)
        assert 0.0 < t_g < float(np.percentile(t_h, 98)), (t_g, float(np.percentile(t_h, 98)))
        lo, hi = hv.min(0) - 0.01, hv.max(0) + 0.01
        assert all(lo[i] <= g[i] <= hi[i] for i in range(3)), (g, lo, hi)   # inside the hand's box
        blade = next(o for o in bpy.data.objects if o.type == "MESH" and o.get("imaginarium_item_type") == "sword")
        co, _, _ = IL.mesh_arrays(blade)
        rel = co - np.array(g)
        far = rel[np.argmax(np.linalg.norm(rel, axis=1))]
        cosang = float(far @ np.array(z) / np.linalg.norm(far))
        assert cosang > 0.995, cosang                                         # the tip lies on +Z
        assert float(np.abs(rel @ np.array(z)).max()) > 0.6                   # a 0.9 m blade, not a stub
        M_sword = IL.normalized4(blade.matrix_world.copy())
        shield = next(o for o in bpy.data.objects if o.type == "MESH" and o.get("imaginarium_item_type") == "shield_kite")
        M_shield = IL.normalized4(shield.matrix_world.copy())
        # the same character without the rig's sockets: attach_prop builds them itself
        arm, body, socks = _load_rigged(os.path.join(out, "rigged.blend"))
        for n in ("socket_mount_hand_r", "socket_mount_hand_l", "socket_mount_shield_l", "socket_mount_shield_r"):
            bpy.data.objects.remove(socks[n], do_unlink=True)
        bare = ima.save_blend(os.path.join(d, "bare.blend"))
        res2, rep2 = _attach(bare, atts, os.path.join(d, "b"))
        assert rep2["hand_sockets"]["r"]["info"]["created"] is True
        assert rep2["mounts"]["socket_mount_shield_l"]["status"] == "created"
        _load_rigged(res2["outputs"]["blend"])
        blade2 = next(o for o in bpy.data.objects if o.type == "MESH" and o.get("imaginarium_item_type") == "sword")
        shield2 = next(o for o in bpy.data.objects if o.type == "MESH" and o.get("imaginarium_item_type") == "shield_kite")
        assert _mat_err(IL.normalized4(blade2.matrix_world.copy()), M_sword) < 1e-4
        assert _mat_err(IL.normalized4(shield2.matrix_world.copy()), M_shield) < 1e-4
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------ evidence (not a test)

def make_socket_evidence(img_dir=None):
    """Numbers and pictures of docs/forge/humanoid.md "Сокеты и хват" (the zombie): the rig's sockets
    take a kit sword and kite as they are (attach_prop preview), and the markers.json projection drawn
    over markers.png. Returns a dict; writes zombie_rig_sockets.png / zombie_markers_projection.png."""
    ev = {}
    for name in ("test_real_zombie_hand_socket_is_attach_prop_frame", "test_real_zombie_markers_projection_matches_png"):
        ima.reset_scene()
        globals()[name]()
    ev["hand_frame_max_abs_err"] = _ZRIG.get("hand_frame_max_abs_err")
    ev["projection_errors_px"] = _ZRIG.get("projection_errors_px")
    ima.reset_scene()
    d = _tmp()
    out, res = _zombie_rig(d)
    ev["sockets"] = res["stats"]["sockets"]
    ev["shield_mounts"] = res["stats"]["shield_mounts"]
    ev["shield_mounts_seconds"] = res["stats"]["shield_mounts_seconds"]
    sword = _kit_item(os.path.join(d, "sword"), {"type": "sword", "ornament": 2})
    kite = _kit_item(os.path.join(d, "kite"), {"type": "shield_kite", "ornament": 1})
    res_a, rep = _attach(os.path.join(out, "rigged.glb"), [{"item": sword, "hand": "r"}, {"item": kite, "hand": "l"}],
                         os.path.join(d, "a"))
    sw, sh = rep["attachments"]
    ev["attach"] = {"hand_sockets_created": {s: v["info"]["created"] for s, v in rep["hand_sockets"].items()},
                    "mounts": {k: v["status"] for k, v in rep["mounts"].items()},
                    "sword_rest": {k: sw["rest"][k] for k in ("grip_to_hand_m", "grip_enclosure", "axis_inside_arm",
                                                              "overlap_arm_tris", "overlap_body_tris")},
                    "shield_rest": {k: sh["rest"][k] for k in ("shield_up_dot", "shield_face_out_dot",
                                                               "overlap_hand_tris", "overlap_body_tris")},
                    "grip_on_mount": [sw["grip_on_mount_error"], sh["grip_on_mount_error"]]}
    if img_dir:
        os.makedirs(img_dir, exist_ok=True)
        rows = [IL.load_png(res_a["outputs"]["preview"]), IL.load_png(res_a["outputs"]["grip_closeup"])]
        W = max(r.shape[1] for r in rows)
        rows = [np.pad(r, ((0, 0), (0, W - r.shape[1]), (0, 0))) for r in rows]
        ev["img_sockets"] = _png_rgb(np.concatenate(rows, axis=0), os.path.join(img_dir, "zombie_rig_sockets.png"))
        # projection block over markers.png: a magenta cross at every projected joint (front tile)
        mk = json.load(open(os.path.join(out, "markers.json"), encoding="utf-8"))
        pr = mk["projection"]
        arr = IL.load_png(os.path.join(out, "markers.png"))[:, :pr["front_tile"]["width"]].copy()
        arr = IL.over_bg(arr, (1.0, 1.0, 1.0))
        for p in mk["joints"].values():
            u = pr["center_px"][0] + (p[0] - pr["center"][0]) / pr["meters_per_px"]
            v = pr["center_px"][1] - (p[2] - pr["center"][1]) / pr["meters_per_px"]
            i, j = int(math.floor(u)), int(math.floor(v))
            for k in range(-7, 8):
                for (y, x) in ((j, i + k), (j + k, i)):
                    if 0 <= y < arr.shape[0] and 0 <= x < arr.shape[1]:
                        arr[y, x, :3] = (0.9, 0.0, 0.9)
        IL.stamp_text(arr, "MARKERS.JSON PROJECTION: %d JOINTS, MAX %.2f PX" % (
            len(mk["joints"]), (ev["projection_errors_px"] or {}).get("max", -1)), 8, 8, 2, (0.1, 0.1, 0.1, 1))
        ev["img_projection"] = _png_rgb(arr, os.path.join(img_dir, "zombie_markers_projection.png"))
    shutil.rmtree(d, ignore_errors=True)
    print("EVIDENCE " + json.dumps(ev))
    return ev
