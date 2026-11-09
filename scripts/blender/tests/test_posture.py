"""Self-tests of the shoulder-posture guard (_posture_lib + motion_style integration).

Windows 0.6.13 intent (ticket 35): motion style may swing the arms, it must not roll the
fighters' shoulders - twist about the upper-arm axis is the discriminator (a swing is a
rotation about the SIDE axis and leaves it invariant). Covers: the metric's swing
invariance + roll sensitivity, the guard verdict math, the pipeline stats on every styled
clip, the correction of an injected 45 deg roll (positive control) and the death exemption.
Run: blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- posture
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import bpy  # noqa: E402
from mathutils import Quaternion, Vector  # noqa: E402

import af_common as af  # noqa: E402
from steps import _posture_lib as PL  # noqa: E402
from steps import _style_lib as SL  # noqa: E402
from steps import motion_style as ms  # noqa: E402
import importlib  # noqa: E402
import test_mixamo as tm  # noqa: E402

_CACHE = {}


def _tmp():
    import tempfile
    return tempfile.mkdtemp(prefix="af_posture_")


def _animated_blend():
    """Synthetic mixamo-named walk (bent elbows) retargeted onto an arms-down rig (cached)."""
    if "blend" in _CACHE and os.path.exists(_CACHE["blend"]):
        return _CACHE["blend"]
    d = _tmp()
    src = tm.synthetic_clip_fbx(d, amp=1.0, travel=0.8)
    blend = tm.save_target_blend(d, tm.ARMS_DOWN, prefix="mixamorig:", roll=0.7)
    retarget = importlib.import_module("steps.retarget")
    req = tm.request(os.path.join(d, "rt"), {"blend": blend},
                     {"clips": [{"source": src, "name": "walk", "loop": True, "in_place": True}]})
    res = tm.finish(req, retarget.run(req))
    assert res["ok"], res.get("failed")
    _CACHE["blend"] = res["outputs"]["blend"]
    _CACHE["dir"] = d
    return _CACHE["blend"]


def _style(params):
    blend = _animated_blend()
    d = _tmp()
    req = tm.request(d, {"blend": blend}, dict(params))
    res = tm.finish(req, ms.run(req))
    assert res["ok"], res.get("failed")
    clips = {c["gltf_name"]: c for c in json.load(open(os.path.join(d, "clips.json"), encoding="utf-8"))["clips"]}
    return res, clips


def _open_rig(blend):
    bpy.ops.wm.open_mainfile(filepath=blend)
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    return rig


def _act(rig, name):
    return next(a for a in bpy.data.actions if a.name == name and not a.name.endswith("__old"))


# ------------------------------------------------------------------ metric math
def test_twist_is_swing_invariant_and_roll_sensitive():
    shoulder = Vector((0.0, 0.0, 0.0))
    upper, fore = 0.30, 0.28
    base = []
    for swing in range(-60, 61, 15):                       # rotate the arm about the SIDE axis (X)
        a = math.radians(swing)
        du = Vector((0.0, -math.sin(a), -math.cos(a)))     # down, swinging fore-and-aft
        fwd = Vector((0.0, -math.cos(a), math.sin(a)))     # the swing plane's in-plane partner
        elbow = shoulder + du * upper
        wrist = elbow + (du * math.cos(math.radians(70)) + fwd * math.sin(math.radians(70))) * fore
        base.append(PL.upper_arm_twist_deg(shoulder, elbow, wrist))
    assert all(v is not None for v in base), base
    assert max(base) - min(base) < 5.0, ("swing changed the twist", base)
    rolled = []
    du = Vector((0.0, 0.0, -1.0))
    elbow = shoulder + du * upper
    w0 = du * math.cos(math.radians(70)) + Vector((0.0, 1.0, 0.0)) * math.sin(math.radians(70))
    for roll in range(-60, 61, 15):                        # turn the bent elbow about the arm axis
        wrist = elbow + Quaternion(du, math.radians(roll)) @ (w0 * fore)
        rolled.append(PL.upper_arm_twist_deg(shoulder, elbow, wrist))
    vals = [v for v in rolled if v is not None]
    assert len(vals) >= 7, rolled
    assert max(vals) - min(vals) > 90.0, ("roll must move the twist a lot", rolled)
    straight = PL.upper_arm_twist_deg(Vector((0, 0, 0)), Vector((0, 0, -0.3)), Vector((0, 0.01, -0.6)))
    assert straight is None, "a near-straight elbow has no crease and must read None"


def test_twist_guard_wraps_and_ignores_undefined_frames():
    ref = [170.0] * 10
    cur = [170.0] * 4 + [None] * 2 + [-170.0, -170.0, 170.0, 170.0]   # frames 6/7: 20 deg across the wrap
    g = PL.twist_guard(ref, cur, tol_deg=25.0)
    assert g["over"] == [], g
    cur2 = [0.0] * 9 + [40.0]
    g2 = PL.twist_guard([0.0] * 10, cur2, tol_deg=25.0)
    assert g2["worst_deg"] == 40.0 and g2["over"] == [(9, 40.0)], g2
    g3 = PL.twist_guard([None] * 10, [None] * 10, 25.0)
    assert g3["checked"] == 0 and g3["worst_deg"] is None


# ------------------------------------------------------------------ pipeline
def test_every_styled_clip_carries_posture_stats_and_survives_tolerance():
    res, clips = _style({"seed": "posture", "arm_swing": 2.0, "swagger": 1.0, "death": "library"})
    rec = clips["walk-loop"]
    p = rec.get("posture")
    assert p, rec.keys()
    assert p["exempt"] is False
    assert p["over"] == [], ("styled clip still beyond tolerance after the guard", p)
    worst = max((s["worst_deg"] for s in p["stats"].values() if s["worst_deg"] is not None))
    assert worst <= 25.0 + 1e-6, p


def test_guard_corrects_an_injected_roll():
    """Positive control: a 45 deg roll written into the styled clip must be measured,
    clamped back to the tolerance rim and verified by the guard's re-measure."""
    blend = _animated_blend()
    d = _tmp()
    req = tm.request(d, {"blend": blend}, {"seed": "posture", "death": "library"})
    res = tm.finish(req, ms.run(req))
    rig = _open_rig(res["outputs"]["blend"])
    act = _act(rig, "walk-loop")
    R = SL.Rig(rig)
    pre = ms._posture_sample(R, rig, act)
    assert pre, "guard sampling needs the mapped arm bones"
    up_l = R.tr.cname["LeftArm"]
    m = int(round(act.frame_range[1] - act.frame_range[0])) + 1
    fs = range(m // 3, 2 * m // 3)
    for f in fs:
        q = ms._quat_read(act, up_l, f)
        assert q is not None
        assert ms._quat_write(act, up_l, f, (q @ Quaternion((0, 1, 0), math.radians(45))).normalized())
    verdict = ms._posture_guard(R, rig, pre, act, False, 25.0)
    assert verdict["stats"]["l"]["fixed_frames"] > 0, verdict
    assert verdict["stats"]["l"]["over_frames"] == [], ("not clamped back within tolerance", verdict)
    assert abs((verdict["stats"]["l"]["worst_deg"] or 0.0)) <= 25.0, verdict


def test_death_clips_are_exempt_by_construction():
    res, clips = _style({"seed": "posture", "death": "auto"})
    deaths = [c for c in clips.values() if c.get("mode") == "procedural_death"]
    assert deaths, clips.keys()
    for c in deaths:
        assert "posture" not in c or c["posture"] is None, c
    walk = clips["walk-loop"]
    assert walk["posture"] and walk["posture"]["exempt"] is False
