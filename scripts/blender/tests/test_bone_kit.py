"""Self-tests of the bone_kit step (skeletal hands, bone staff, bone toggle clasp).

Zero-arg test_*() functions, temp files only under tempfile.mkdtemp(); tests on real assets are
test_real_* and return "skip: ..." when the file is missing (contract §10).

    blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- bone_kit

make_evidence(out_dir=None, img_dir=None) renders the comparison with the owner's reference and the
numbers / pictures of docs/forge/bone_kit.md.
"""
import json
import math
import os
import struct
import tempfile

import bpy
import numpy as np
from mathutils import Euler, Vector

import imaginarium_common as ima
from steps import _bone_kit_lib as B
from steps import bone_kit as K

# the owner's reference picture for the comparison sheet (Imaginarium_BONE_KIT_REFERENCE overrides)
REFERENCE = os.environ.get("Imaginarium_BONE_KIT_REFERENCE") or r"C:/Imaginarium/test-assets/Necromancer/Reference-original.jpg"
# regions of the reference (x0, y0, x1, y1 in its 2752 x 1536 pixels)
REF_CROPS = {"hand_open": (1040, 650, 1210, 900), "grip": (1740, 520, 1900, 660), "staff_head": (1790, 30, 1960, 420),
             "clasps": (1380, 370, 1560, 680), "staff_full": (1690, 30, 1990, 1520)}


def _tmp():
    return tempfile.mkdtemp(prefix="imaginarium_bone_kit_")


def _build(params):
    ima.reset_scene()
    return K.build_part(params)


def _errors(checks):
    return [c for c in checks if not c["ok"] and c.get("severity", "error") == "error"]


def _glb_json(path):
    with open(path, "rb") as fh:
        fh.read(12)
        clen, _ = struct.unpack("<II", fh.read(8))
        return json.loads(fh.read(clen).decode("utf-8"))


def _verts(ob):
    co, _ = B.mesh_arrays(ob, world=True)
    return co


def _dist_to_axis(P, p0, d):
    d = np.asarray(d, float)
    d = d / np.linalg.norm(d)
    v = np.asarray(P, float) - np.asarray(p0, float)
    return np.linalg.norm(v - np.outer(v @ d, d), axis=1)


# =============================================================================== hand

def test_hand_bones_mixamo_names_and_hierarchy():
    for side in ("l", "r"):
        objs, info = _build({"part": "skeleton_hand", "side": side})
        names = [b["name"] for b in info["bones"]]
        assert sorted(names) == sorted(K.hand_bone_names(side)), names
        hand = "mixamorig:%sHand" % K.SIDE_WORD[side]
        finger = [n for n in names if n != hand]
        # contract §5: {Thumb,Index,Middle,Ring,Pinky}{1..4} = 20 finger bones per hand, plus <Side>Hand
        assert len(finger) == 20 and len(names) == 21, len(names)
        arm = [o for o in objs if o.type == "ARMATURE"][0]
        for f in K.FINGERS:
            for k in range(1, 5):
                b = arm.data.bones[K.bname(side, f, k)]
                assert b.parent.name == (hand if k == 1 else K.bname(side, f, k - 1)), b.name
        assert all(n.startswith("mixamorig:") for n in names)
        assert _errors(K.part_checks(info)) == []


def test_hand_rigid_weights_every_piece_exactly_one_bone():
    objs, info = _build({"part": "skeleton_hand", "pose": "relaxed", "rings": ["thumb", "index", "ring"]})
    ob = info["_main"]
    gname = {g.index: g.name for g in ob.vertex_groups}
    for rec in info["_records"]:
        names = set()
        for i in range(rec["v0"], rec["v1"]):
            gs = [(gname[g.group], g.weight) for g in ob.data.vertices[i].groups]
            assert len(gs) == 1 and abs(gs[0][1] - 1.0) < 1e-6, (rec["name"], gs)
            names.add(gs[0][0])
        assert names == {rec["bone"]}, (rec["name"], names)
    recs = info["_records"]
    phal = [r for r in recs if r["kind"] == "phalanx"]
    assert len(phal) == 14 and len({r["bone"] for r in phal}) == 14          # one bone per phalanx
    assert len([r for r in recs if r["kind"] == "carpal"]) == 8
    assert len([r for r in recs if r["kind"] == "metacarpal"]) == 5
    assert all(not r["bone"].endswith("4") for r in recs)                    # *4 = Mixamo end bones
    assert info["weights"]["bad_vertices"] == 0 and not info["weights"]["bad_pieces"]


def test_hand_skinning_moves_only_the_posed_finger():
    objs, info = _build({"part": "skeleton_hand", "side": "r", "pose": "open"})
    ob = info["_main"]
    arm = [o for o in objs if o.type == "ARMATURE"][0]
    rest = _verts_eval(ob)
    pb = arm.pose.bones[K.bname("r", "index", 2)]
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = Euler((math.radians(40), 0, 0))
    bpy.context.view_layer.update()
    posed = _verts_eval(ob)
    moved = np.linalg.norm(posed - rest, axis=1) > 1e-6
    for rec in info["_records"]:
        m = moved[rec["v0"]:rec["v1"]]
        should = rec["name"] in ("index_middle", "index_distal")
        assert (m.all() if should else not m.any()), rec["name"]


def _verts_eval(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return co.reshape(-1, 3)


def test_hand_dimensions_scale_and_budget():
    objs, info = _build({"part": "skeleton_hand", "pose": "open", "curl": 0.0, "finger_spread_deg": 0.0})
    assert abs(info["chain_length_m"] - 0.19) < 1e-4, info["chain_length_m"]
    rec = next(r for r in info["_records"] if r["name"] == "middle_distal")
    tip = np.linalg.norm(_verts(info["_main"])[rec["v0"]:rec["v1"]], axis=1).max()
    assert abs(tip - 0.19) < 0.19 * 0.015, tip                     # wrist crease (origin) -> middle fingertip
    assert info["tris"] <= 3000
    big = _build({"part": "skeleton_hand", "pose": "open", "curl": 0.0, "finger_spread_deg": 0.0, "length_m": 0.25})[1]
    for a, b in zip(info["dimensions_m"], big["dimensions_m"]):
        assert abs(b / a - 0.25 / 0.19) < 0.01, (a, b)
    # proportions: middle finger (MCP -> tip) ~ 0.43-0.47 of the hand length, thumb tip beside the index
    full = _build({"part": "skeleton_hand", "rings": list(K.FINGERS)})[1]
    assert full["tris"] <= 3000, full["tris"]                       # every finger with a ring still fits
    for pose in K.POSES:
        inf = _build({"part": "skeleton_hand", "pose": pose, "side": "l"})[1]
        assert inf["tris"] <= 3000, (pose, inf["tris"])
        assert _errors(K.part_checks(inf)) == [], (pose, _errors(K.part_checks(inf)))


def test_hand_socket_frame_contract():
    for side in ("l", "r"):
        for pose in ("open", "grip"):
            objs, info = _build({"part": "skeleton_hand", "side": side, "pose": pose})
            s = info["sockets"][0]
            assert s["name"] == "socket_mount_hand_%s" % side
            assert s["parent_bone"] == "mixamorig:%sHand" % K.SIDE_WORD[side]
            ortho, hand = B.frame_errors(s)
            assert ortho < 1e-4 and abs(hand - 1.0) < 1e-4, (ortho, hand)
            # +Z out of the fist on the thumb side (thumb points to character forward -Y in the hand frame),
            # -Y along the knuckles (fingers hang along -Z), X = Y x Z
            assert Vector(s["z_axis"]).dot(Vector((0, -1, 0))) > 0.999, s["z_axis"]
            assert Vector(s["y_axis"]).dot(Vector((0, 0, 1))) > 0.999, s["y_axis"]
            # the socket sits on the palm side of the hand: right palm +X, left palm -X
            palm = 1.0 if side == "r" else -1.0
            assert s["location"][0] * palm > 0.01, s["location"]


def test_hand_grip_wraps_cylinder():
    for R in (0.018, 0.025):
        objs, info = _build({"part": "skeleton_hand", "side": "l", "pose": "grip", "grip_radius_m": R,
                             "rings": ["index", "middle", "ring"]})
        ax = info["grip_axis"]
        co = _verts(info["_main"])
        bones = [r for r in info["_records"] if r["kind"] in ("phalanx", "metacarpal", "ring")]
        dmin = min(_dist_to_axis(co[r["v0"]:r["v1"]], ax["point"], ax["direction"]).min() for r in bones)
        assert dmin >= R - 0.0006, (R, dmin)                                   # nothing cuts into the shaft
        for f in ("index", "middle", "ring", "pinky"):
            r = next(x for x in info["_records"] if x["name"] == f + "_distal")
            d = _dist_to_axis(co[r["v0"]:r["v1"]], ax["point"], ax["direction"]).min()
            assert d - R < 0.004, (R, f, d - R)                                # fingertips wrap onto it
            ang = info["joint_angles_deg"][f]
            assert ang[1] + ang[2] + ang[3] > 70, (f, ang)
        s = info["sockets"][0]
        assert _dist_to_axis([s["location"]], ax["point"], ax["direction"])[0] < 1e-4
        assert abs(Vector(s["z_axis"]).dot(Vector(ax["direction"]))) > 0.9999
        assert info["overlaps"] == [], info["overlaps"]
        assert _errors(K.part_checks(info)) == []


def test_hand_poses_distinct_and_clean():
    tips = {}
    for pose in K.POSES:
        objs, info = _build({"part": "skeleton_hand", "pose": pose, "side": "r", "seed": 2})
        assert info["overlaps"] == [], (pose, info["overlaps"])
        co = _verts(info["_main"])
        r = next(x for x in info["_records"] if x["name"] == "middle_distal")
        tips[pose] = co[r["v0"]:r["v1"]].mean(0)
    # curled poses bring the fingertip closer to the wrist
    d = {k: float(np.linalg.norm(v)) for k, v in tips.items()}
    assert d["fist"] < d["claw"] < d["open"] and d["relaxed"] < d["open"], d
    assert d["fist"] < 0.6 * d["open"], d


def test_hand_mirror_symmetry_and_seed():
    l = _verts(_build({"part": "skeleton_hand", "side": "l", "seed": 5})[1]["_main"])
    r = _verts(_build({"part": "skeleton_hand", "side": "r", "seed": 5})[1]["_main"])
    assert l.shape == r.shape
    assert np.allclose(l * np.array([-1, 1, 1]), r, atol=1e-6)
    l2 = _verts(_build({"part": "skeleton_hand", "side": "l", "seed": 5})[1]["_main"])
    l3 = _verts(_build({"part": "skeleton_hand", "side": "l", "seed": 6})[1]["_main"])
    assert np.allclose(l, l2) and not np.allclose(l, l3)


# =============================================================================== staff

def test_staff_dimensions_budget_sockets():
    objs, info = _build({"part": "bone_staff"})
    L = 2.05
    assert abs(info["dimensions_m"][2] - L) < 0.005 * L, info["dimensions_m"]
    assert info["tris"] <= 4500, info["tris"]
    socks = {s["name"]: s for s in info["sockets"]}
    g = socks["socket_grip_main"]
    assert abs(g["location"][2] / L - 0.62) < 0.003, g["location"]
    for s in info["sockets"]:
        ortho, hand = B.frame_errors(s)
        assert ortho < 1e-4 and abs(hand - 1) < 1e-4
    assert Vector(g["z_axis"]).z > 0.995 and Vector(g["y_axis"]).y > 0.99      # item frame: +Z up, -Y front
    # the grip is on the shaft centre line, on a constant-radius stretch away from the joints
    assert abs(info["grip_shaft_radius_m"] - 0.018) < 0.0027, info["grip_shaft_radius_m"]
    assert min(abs(z - g["location"][2]) for z in info["joints_z"]) > 0.06, info["joints_z"]
    # socket_fx_tip at the crystal centre, crystal 0.18..0.24 m tall
    fx = socks["socket_fx_tip"]
    assert (Vector(fx["location"]) - Vector(info["crystal"]["centre"])).length < 1e-4
    assert 0.18 <= info["crystal"]["height_m"] <= 0.24
    ob = info["_main"]
    cr = next(r for r in info["_records"] if r["name"] == "crystal")
    pts = _verts(ob)[cr["v0"]:cr["v1"]]
    assert pts[:, 2].min() < fx["location"][2] < pts[:, 2].max()
    assert _errors(K.part_checks(info)) == []


def test_staff_materials_crystal_emissive_and_ivory():
    objs, info = _build({"part": "bone_staff"})
    mats = {m["name"]: m for m in info["materials"]}
    assert set(mats) == {"Bone", "Crystal"}, list(mats)
    cm = mats["Crystal"]
    assert cm["emission_strength"] > 0 and cm["roughness"] <= 0.2 and cm["principled_to_output"]
    r, g, b = cm["emission_color_linear"]
    assert g > r * 1.5 and g > b * 1.5                                          # green glow
    bm = mats["Bone"]
    assert np.allclose(bm["base_color_linear"], B.hex_lin("#CDBE9C")[:3], atol=1e-3)
    assert abs(bm["roughness"] - 0.7) < 1e-6 and bm["metallic"] == 0.0
    ob = info["_main"]
    names = [s.material.name for s in ob.material_slots]
    assert "Crystal" in names
    idx = names.index("Crystal")
    flat = [p for p in ob.data.polygons if p.material_index == idx]
    assert flat and not any(p.use_smooth for p in flat)                       # faceted crystal
    assert len(flat) < len(ob.data.polygons)


def test_staff_variants_and_grip_fraction():
    for p in ({"grip_fraction": 0.5, "length_m": 1.7}, {"segments": 4, "talons": 3, "seed": 7},
              {"crystal_height_m": 0.30, "bend": 2.0, "seed": 3}):
        params = dict(p, part="bone_staff")
        objs, info = _build(params)
        L = params.get("length_m", 2.05)
        g = next(s for s in info["sockets"] if s["name"] == "socket_grip_main")
        assert abs(g["location"][2] / L - params.get("grip_fraction", 0.62)) < 0.003, (p, g["location"])
        assert info["tris"] <= 4500 and abs(info["dimensions_m"][2] - L) < 0.005 * L, (p, info["tris"])
        assert 0.18 <= info["crystal"]["height_m"] <= 0.24                         # clamped
        assert _errors(K.part_checks(info)) == [], (p, _errors(K.part_checks(info)))
    a = _verts(_build({"part": "bone_staff", "seed": 1})[1]["_main"])
    b = _verts(_build({"part": "bone_staff", "seed": 1})[1]["_main"])
    c = _verts(_build({"part": "bone_staff", "seed": 2})[1]["_main"])
    assert np.allclose(a, b) and (a.shape != c.shape or not np.allclose(a, c))


# =============================================================================== toggle

def test_toggle_dimensions_origin_budget_gold():
    for gold in ("rings", "caps", "none"):
        objs, info = _build({"part": "bone_toggle", "gold": gold})
        assert info["tris"] <= 600, (gold, info["tris"])
        assert abs(info["dimensions_m"][0] - 0.10) < 0.012, info["dimensions_m"]
        lo, hi = info["bbox_min"], info["bbox_max"]
        assert abs(hi[1]) < 1e-5 and lo[1] < -0.015                         # back face at y = 0, body toward -Y
        assert abs(lo[0] + hi[0]) < 1e-4 and abs(lo[2] + hi[2]) < 1e-4      # centred on the back face
        gm = [m for m in info["materials"] if m["name"] == "Gold"]
        assert gm and gm[0]["metallic"] == 1.0 and gm[0]["roughness"] <= 0.4   # the loop is gold too
        assert _errors(K.part_checks(info)) == []
    big = _build({"part": "bone_toggle", "length_m": 0.14})[1]
    assert abs(big["dimensions_m"][0] - 0.14) < 0.017


# =============================================================================== export / protocol

def test_run_protocol_hand_glb_skin_and_socket():
    out = _tmp()
    res = K.run({"params": {"part": "skeleton_hand", "side": "r", "pose": "grip", "rings": ["index"]},
                 "out_dir": out, "inputs": {}})
    assert not _errors(res["checks"]), _errors(res["checks"])
    for k in ("glb", "blend", "json", "preview"):
        assert os.path.isfile(res["outputs"][k]), k
    g = _glb_json(res["outputs"]["glb"])
    assert len(g["skins"]) == 1
    joints = [g["nodes"][j]["name"] for j in g["skins"][0]["joints"]]
    assert sorted(joints) == sorted(K.hand_bone_names("r"))
    sock = next(i for i, n in enumerate(g["nodes"]) if (n.get("extras") or {}).get("game_socket") == "socket_mount_hand_r")
    parent = next(n["name"] for n in g["nodes"] if sock in (n.get("children") or []))
    assert parent == "mixamorig:RightHand"
    prim = g["meshes"][0]["primitives"][0]
    assert "JOINTS_0" in prim["attributes"] and "WEIGHTS_0" in prim["attributes"]
    with open(res["outputs"]["json"], encoding="utf-8") as fh:
        pj = json.load(fh)
    assert len(pj["bones"]) == 21 and pj["sockets"][0]["name"] == "socket_mount_hand_r"


def test_run_protocol_staff_and_toggle_outputs():
    for params in ({"part": "bone_staff"}, {"part": "bone_toggle", "gold": "caps"}):
        out = _tmp()
        res = K.run({"params": params, "out_dir": out, "inputs": {}})
        assert not _errors(res["checks"]), _errors(res["checks"])
        for k in ("glb", "blend", "json", "preview"):
            assert os.path.isfile(res["outputs"][k]), k
        g = _glb_json(res["outputs"]["glb"])
        socks = {(n.get("extras") or {}).get("game_socket") for n in g["nodes"]} - {None}
        if params["part"] == "bone_staff":
            assert {"socket_grip_main", "socket_grip_off", "socket_fx_tip"} <= socks
            assert "Crystal" in [m["name"] for m in g["materials"]]
            em = next(m for m in g["materials"] if m["name"] == "Crystal")
            assert max(em.get("emissiveFactor", [0, 0, 0])) > 0
        else:
            assert "Gold" in [m["name"] for m in g["materials"]]


def test_aged_vertex_colours_export_as_color0():
    out = _tmp()
    res = K.run({"params": {"part": "skeleton_hand", "style": "aged", "rings": ["index"], "preview": False},
                 "out_dir": out, "inputs": {}})
    g = _glb_json(res["outputs"]["glb"])
    mats = [m["name"] for m in g["materials"]]
    prims = g["meshes"][0]["primitives"]
    bone = next(p for p in prims if mats[p["material"]] == "Bone_aged")
    assert "COLOR_0" in bone["attributes"]
    bm = g["materials"][bone["material"]]
    assert bm.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])[:3] == [1, 1, 1]
    # the .blend keeps white vertex colours on gold (glTF multiplies COLOR_0 into every primitive)
    ima.reset_scene()
    objs, info = K.build_part({"part": "skeleton_hand", "style": "aged", "rings": ["index"]})
    ob = info["_main"]
    attr = ob.data.color_attributes["Color"]
    col = np.empty(len(attr.data) * 4)
    attr.data.foreach_get("color", col)
    col = col.reshape(-1, 4)
    ring = next(r for r in info["_records"] if r["material"] == "gold")
    assert np.allclose(col[ring["v0"]:ring["v1"], :3], 1.0)
    bonev = col[[i for r in info["_records"] if r["material"] == "bone" for i in range(r["v0"], r["v1"])], :3]
    assert bonev.min() < 0.6 * bonev.max()                                    # darker crevices / stains
    # clean style: no vertex colours at all
    res2 = K.run({"params": {"part": "bone_toggle", "preview": False}, "out_dir": _tmp(), "inputs": {}})
    g2 = _glb_json(res2["outputs"]["glb"])
    assert all("COLOR_0" not in p["attributes"] for m in g2["meshes"] for p in m["primitives"])


def test_uv_and_principled_materials_all_parts():
    for params in ({"part": "skeleton_hand", "rings": ["thumb"]}, {"part": "bone_staff"}, {"part": "bone_toggle"},
                   {"part": "bone_staff", "style": "aged"}):
        objs, info = _build(params)
        assert info["uv_layers"] == ["UVMap"], params
        assert info["materials"] and all(m["principled_to_output"] for m in info["materials"]), params
        assert B.non_manifold_edges(info["_main"]) == 0, params


def test_batch_contact_sheet_and_safe_names():
    out = _tmp()
    res = K.run({"params": {"batch": [{"part": "skeleton_hand", "pose": "grip", "side": "l"},
                                      {"part": "bone_staff", "name": "../../escape"},
                                      {"part": "bone_toggle", "gold": "caps"}], "preview": False},
                 "out_dir": out, "inputs": {}})
    assert not _errors(res["checks"]), _errors(res["checks"])
    o = res["outputs"]
    assert os.path.isfile(o["contact_sheet"]) and len(o["glb"]) == 3
    for p in o["glb"]:
        assert os.path.commonpath([os.path.realpath(out), os.path.realpath(p)]) == os.path.realpath(out)
    with open(o["json"], encoding="utf-8") as fh:
        b = json.load(fh)
    assert [v["part"] for v in b["variants"]] == ["skeleton_hand", "bone_staff", "bone_toggle"]
    res2 = K.run({"params": {"part": "bone_toggle", "batch": 3, "seed": 10, "preview": False}, "out_dir": _tmp(),
                  "inputs": {}})
    assert res2["stats"]["variants"] == 3


def test_bad_params_raise():
    for p in ({"part": "skull"}, {"part": "skeleton_hand", "pose": "wave"}, {"part": "skeleton_hand", "side": "x"},
              {"part": "bone_staff", "segments": 5}, {"part": "bone_toggle", "gold": "silver"}):
        try:
            _build(p)
        except ValueError:
            continue
        raise AssertionError("no error for %r" % p)


# =============================================================================== real asset

def test_real_reference_crops():
    if not os.path.isfile(REFERENCE):
        return "skip: reference image missing: %s" % REFERENCE
    crops = reference_crops()
    for k, (x0, y0, x1, y1) in REF_CROPS.items():
        c = crops[k]
        assert c.shape[:2] == (y1 - y0, x1 - y0), k
        assert c[..., :3].std() > 0.03, k                                       # not a blank region


def reference_crops():
    im = bpy.data.images.load(REFERENCE, check_existing=True)
    W, H = im.size
    px = np.array(im.pixels[:], dtype=np.float32).reshape(H, W, 4)[::-1]
    out = {k: px[y0:y1, x0:x1].copy() for k, (x0, y0, x1, y1) in REF_CROPS.items()}
    bpy.data.images.remove(im)
    return out


# =============================================================================== evidence

def _small_png(arr, path, max_kb=400):
    """Save an RGBA top-down array as PNG under max_kb (quantised colours, then downscale if needed)."""
    a = arr.copy()
    for levels in (64, 48, 32, 24):
        q = a.copy()
        q[..., :3] = np.round(q[..., :3] * (levels - 1)) / (levels - 1)
        q[..., 3] = 1.0
        B.save_png(q, path)
        if os.path.getsize(path) <= max_kb * 1024:
            return path
    while os.path.getsize(path) > max_kb * 1024:
        h, w = a.shape[:2]
        a = B.resize(a, int(w * 0.85), int(h * 0.85))
        q = a.copy()
        q[..., :3] = np.round(q[..., :3] * 31) / 31
        q[..., 3] = 1.0
        B.save_png(q, path)
    return path


def make_evidence(out_dir=None, img_dir=None, style="aged"):
    """Comparison with the reference + numbers. Writes <out_dir>/evidence.json and the PNGs; copies the
    doc pictures (<= 400 KB) into img_dir when given."""
    out_dir = out_dir or _tmp()
    os.makedirs(out_dir, exist_ok=True)
    ev = {"parts": {}}
    bg = (0.62, 0.62, 0.64)
    # --- open right hand with rings (reference: rings on the thumb, index, middle)
    ima.reset_scene()
    objs, hi = K.build_part({"part": "skeleton_hand", "side": "r", "pose": "open", "style": style,
                             "rings": ["thumb", "index", "middle"]})
    B.eevee_shot(os.path.join(out_dir, "our_hand_open.png"), [hi["_main"]], view_dir=(1, 0.25, -0.15), size=(340, 500))
    ev["parts"]["hand_open_r"] = {k: hi[k] for k in ("tris", "dimensions_m", "chain_length_m", "overlaps")}
    # --- staff + left hand gripping it (hand socket matched onto socket_grip_main)
    ima.reset_scene()
    sobjs, si = K.build_part({"part": "bone_staff", "style": style})
    staff = si["_main"]
    hobjs, gi = K.build_part({"part": "skeleton_hand", "side": "l", "pose": "grip", "style": style,
                              "rings": ["index", "middle", "ring"]})
    arm = [o for o in hobjs if o.type == "ARMATURE"][0]
    sock = [o for o in hobjs if o.name.startswith("socket_mount_hand")][0]
    grip = [o for o in sobjs if o.name == "socket_grip_main"][0]
    bpy.context.view_layer.update()
    arm.matrix_world = grip.matrix_world @ sock.matrix_world.inverted() @ arm.matrix_world
    bpy.context.view_layer.update()
    err = (sock.matrix_world.translation - grip.matrix_world.translation).length
    hand = gi["_main"]
    co = _verts_eval(hand)
    gz = grip.matrix_world.translation
    # back of the hand toward the camera, like the reference (mirrored: the forearm leaves to the right)
    B.eevee_shot(os.path.join(out_dir, "our_grip.png"), [hand, staff], view_dir=(-0.6, 0.8, 0), size=(400, 350),
                 target=gz + Vector((0, 0.02, 0.01)), ortho_scale=0.22)
    c = Vector(si["crystal"]["centre"])
    B.eevee_shot(os.path.join(out_dir, "our_staff_head.png"), [staff], view_dir=(0.25, 1, -0.05), size=(300, 520),
                 target=c - Vector((0, 0, 0.1)), ortho_scale=0.45)
    B.eevee_shot(os.path.join(out_dir, "our_staff_full.png"), [staff, hand], view_dir=(0.25, 1, -0.02), size=(300, 1100))
    ev["parts"]["staff"] = {k: si[k] for k in ("tris", "dimensions_m", "joints_z", "grip_shaft_radius_m", "crystal")}
    ev["parts"]["staff"]["sockets"] = si["sockets"]
    ev["parts"]["hand_grip_l"] = {k: gi[k] for k in ("tris", "joint_angles_deg", "grip_contact", "overlaps")}
    ev["parts"]["hand_grip_l"]["socket_match_error_m"] = round(err, 7)
    # --- clasps (plain gold rings and gold caps, like the 2 + 2 of the reference)
    ima.reset_scene()
    t1 = K.build_part({"part": "bone_toggle", "gold": "rings", "style": style})[1]
    t2 = K.build_part({"part": "bone_toggle", "gold": "caps", "style": style, "seed": 3})[1]
    t2["_main"].location = (0, 0, -0.06)
    bpy.context.view_layer.update()
    B.eevee_shot(os.path.join(out_dir, "our_clasps.png"), [t1["_main"], t2["_main"]], view_dir=(0.15, 1, -0.1),
                 size=(360, 420))
    ev["parts"]["toggle_rings"] = {k: t1[k] for k in ("tris", "dimensions_m")}
    ev["parts"]["toggle_caps"] = {k: t2[k] for k in ("tris", "dimensions_m")}
    # --- comparison sheet: reference crop above, ours below
    th, tw = 420, 300
    pairs = [("hand_open", "our_hand_open.png", "OPEN HAND"), ("grip", "our_grip.png", "GRIP ON STAFF"),
             ("staff_head", "our_staff_head.png", "STAFF HEAD"), ("clasps", "our_clasps.png", "CLASPS")]
    have_ref = os.path.isfile(REFERENCE)
    crops = reference_crops() if have_ref else {}
    cols = []
    for key, ours, lab in pairs:
        top = B.fit_tile(crops[key], tw, th, bg) if have_ref else np.ones((th, tw, 4), np.float32)
        bot = B.fit_tile(B.load_png(os.path.join(out_dir, ours)), tw, th, bg)
        band = np.zeros((26, tw, 4), np.float32)
        band[..., :3] = 0.15
        band[..., 3] = 1
        B.stamp_text(band, lab, 6, 6, 2, (0.95, 0.85, 0.55, 1))
        cols.append(np.concatenate([band, top, bot], axis=0))
    fr = B.fit_tile(crops["staff_full"], 110, th * 2 + 26, bg) if have_ref else np.ones((th * 2 + 26, 110, 4), np.float32)
    fo = B.fit_tile(B.load_png(os.path.join(out_dir, "our_staff_full.png")), 110, th * 2 + 26, bg)
    sheet = np.concatenate(cols + [fr, fo], axis=1)
    lab = np.zeros((24, sheet.shape[1], 4), np.float32)
    lab[..., :3] = 0.1
    lab[..., 3] = 1
    B.stamp_text(lab, "TOP: OWNER REFERENCE   BOTTOM: BONE_KIT (%s, EEVEE)" % style.upper(), 6, 5, 2, (0.9, 0.9, 0.9, 1))
    sheet = np.concatenate([lab, sheet], axis=0)
    comp = B.save_png(sheet, os.path.join(out_dir, "comparison.png"))
    # --- pose sheet (EEVEE shots of the five poses, right hand) + parts contact sheet
    ims = []
    for pose in K.POSES:
        ima.reset_scene()
        objs, pi = K.build_part({"part": "skeleton_hand", "pose": pose, "side": "r", "style": style})
        show = [pi["_main"]]
        if pose == "grip":
            ax = pi["grip_axis"]
            bpy.ops.mesh.primitive_cylinder_add(radius=ax["radius_m"], depth=0.14, vertices=24)
            cyl = bpy.context.active_object
            cyl.matrix_world = (__import__("mathutils").Matrix.Translation(Vector(ax["point"])) @
                                Vector((0, 0, 1)).rotation_difference(Vector(ax["direction"])).to_matrix().to_4x4())
            cyl.data.materials.append(B.principled("staff_wood_preview", "#4a3a2a", 0, 0.6))
            show.append(cyl)
        p_ = os.path.join(out_dir, "pose_%s.png" % pose)
        B.eevee_shot(p_, show, view_dir=(1, 0.3, -0.1), size=(260, 330), ortho_scale=0.23)
        ims.append(B.fit_tile(B.load_png(p_), 260, 330, bg))
        band = np.zeros((22, 260, 4), np.float32)
        band[..., :3] = 0.15
        band[..., 3] = 1
        B.stamp_text(band, "%s %dT" % (pose, pi["tris"]), 6, 4, 2, (0.95, 0.85, 0.55, 1))
        ims[-1] = np.concatenate([band, ims[-1]], axis=0)
        ev["parts"]["pose_" + pose] = {"tris": pi["tris"], "overlaps": pi["overlaps"],
                                       "joint_angles_deg": pi["joint_angles_deg"]}
    poses = B.save_png(np.concatenate(ims, axis=1), os.path.join(out_dir, "poses.png"))
    batch_dir = os.path.join(out_dir, "batch")
    res = K.run({"params": {"batch": [{"part": "skeleton_hand", "pose": "open"}, {"part": "skeleton_hand", "pose": "claw"},
                                      {"part": "skeleton_hand", "pose": "fist", "side": "l"},
                                      {"part": "skeleton_hand", "pose": "grip", "side": "l", "rings": ["index", "middle"]},
                                      {"part": "bone_staff"}, {"part": "bone_staff", "segments": 4, "talons": 3, "seed": 4},
                                      {"part": "bone_toggle", "gold": "rings"}, {"part": "bone_toggle", "gold": "caps"}],
                            "style": style, "preview": False}, "out_dir": batch_dir, "inputs": {}})
    ev["batch"] = res["stats"]
    ev["files"] = {"comparison": comp, "poses": poses, "contact_sheet": res["outputs"]["contact_sheet"]}
    if img_dir:
        os.makedirs(img_dir, exist_ok=True)
        ev["doc_images"] = {}
        for name, src in (("bone_kit_vs_reference.png", comp), ("bone_kit_hand_poses.png", poses),
                          ("bone_kit_contact_sheet.png", res["outputs"]["contact_sheet"])):
            dst = _small_png(B.load_png(src), os.path.join(img_dir, name))
            ev["doc_images"][name] = {"path": dst, "kb": round(os.path.getsize(dst) / 1024, 1)}
    with open(os.path.join(out_dir, "evidence.json"), "w", encoding="utf-8") as fh:
        json.dump(ima._jsonable(ev), fh, ensure_ascii=False, indent=2)
    print("EVIDENCE", os.path.join(out_dir, "evidence.json"))
    return ev


