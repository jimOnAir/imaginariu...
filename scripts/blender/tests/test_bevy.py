"""Self-tests of bevy_package (docs/forge/bevy.md, 0.6.10 wave ticket 28).

A synthetic rigged-less model (box + socket empty + COL_ hull + two clips) is exported to GLB and
packed; everything the passport promises is then read back from ima_bevy.json. No Rust needed: the
package build is the contract, the headless cargo check is a separate, optional pass (ticket
30): its lines drive the driver with a stub toolchain - the real check runs live on the box.
"""
import atexit
import json
import os
import shutil
import tempfile

import bpy

import imaginarium_common as ima
from steps import _bevy_lib as bl
from steps import bevy_package as bp


def _tmp(prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    if not os.environ.get("Imaginarium_KEEP_TEST_FILES"):
        atexit.register(shutil.rmtree, d, True)
    return d


def _model_glb(folder, clips=True, hull=True):
    """A box body, a socket_fx_gun empty, an optional COL_hull mesh, idle-loop + attack actions."""
    ima.reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
    body = bpy.context.active_object
    body.name = "Body"
    bpy.ops.object.empty_add(location=(0.0, 0.3, 0.7))
    sock = bpy.context.active_object
    sock.name = "socket_fx_gun"
    sock.parent = body
    if hull:
        bpy.ops.mesh.primitive_cube_add(size=1.2, location=(0, 0, 0.5))
        h = bpy.context.active_object
        h.name = "COL_Body"
        h.display_type = "WIRE"
    if clips:
        body.animation_data_create()
        for nm, f_end in (("idle-loop", 30), ("attack", 12)):        # NLA tracks named like the clips (test_export)
            body.animation_data.action = None
            body.location.x = 0.0
            body.keyframe_insert("location", index=0, frame=1)      # component fcurves: the NLA exporter's shape
            body.location.x = 0.4
            body.keyframe_insert("location", index=0, frame=max(2, f_end // 2))
            body.location.x = 0.0
            body.keyframe_insert("location", index=0, frame=f_end)
            act = body.animation_data.action
            act.name = nm
            tr = body.animation_data.nla_tracks.new()
            tr.name = nm
            tr.strips.new(nm, 1, act)
            body.animation_data.action = None
    path = os.path.join(folder, "model_in.glb")
    ima.export_glb(path, animation_mode="NLA_TRACKS")
    return path


def _run(req):
    req.setdefault("params", {})
    return bp.run(req)


# ---------------------------------------------------------------- the lib rules, without a scene

def test_bevy_lib_clip_base_default_sockets():
    assert bl.clip_base("idle-loop") == ("idle", True) and bl.clip_base("walk_cycle") == ("walk", True)
    assert bl.clip_base("attack") == ("attack", False)
    clips = [{"name": "idle-loop", "loop": True, "seconds": 0.967}, {"name": "attack", "loop": False, "seconds": 0.367}]
    assert bl.pick_default_clip(clips) == "idle-loop", "idle first, always"
    assert bl.pick_default_clip(clips, "attack") == "attack", "a requested existing clip wins"
    assert bl.pick_default_clip(clips, "walk") == "idle-loop", "an unknown request falls back, never invented"
    assert bl.pick_default_clip([{"name": "run-loop", "loop": True}, {"name": "slash", "loop": False}], "nope") == "run-loop", "first loop beats the one-shot"
    assert bl.pick_default_clip([]) == "", "no clips, no default"
    rows = bl.socket_rows([{"name": "socket_fx_gun", "node": "socket_fx_gun", "kind": None,
                            "parent": "Body", "parent_bone": None}])
    assert rows == [{"name": "socket_fx_gun", "node": "socket_fx_gun", "kind": "",
                     "parent": "Body", "parent_bone": ""}]


def test_bevy_lib_fx_masks_and_unknowns():
    got = bl.expand_fx([{"preset": "fire", "socket": "socket_thruster_*", "params": {"s": 1}},
                        {"preset": "fire", "socket": "socket_thruster_l"},      # idempotent with the mask
                        {"preset": "smoke", "socket": ""}],
                       ["socket_thruster_l", "socket_thruster_r", "socket_fx_gun"])
    assert [(f["preset"], f["socket"]) for f in got] == [("fire", "socket_thruster_l"),
                                                          ("fire", "socket_thruster_r"),
                                                          ("smoke", "")]
    assert bl.unknown_fx_presets(got, {"fire": {}}) == ["smoke"]
    assert bl.unknown_fx_presets(got, {"fire": {}, "smoke": {}}) == []


def test_bevy_lib_collider_and_hulls():
    assert bl.collision_meshes(["Body", "COL_Body", "hand-colonly", "foot_convcolonly", "socket_fx_gun"]) == \
        ["COL_Body", "foot_convcolonly", "hand-colonly"]
    assert bl.collider_plan("auto", True, True) == {"kind": "hulls"}
    assert bl.collider_plan("auto", False, True) == {"kind": "capsule"}
    assert bl.collider_plan("auto", False, False) == {"kind": "box"}
    assert bl.collider_plan("mesh", True, False) == {"kind": "mesh"}, "an explicit choice is respected over the hulls"
    assert bl.collider_plan("none", True, True) == {"kind": "none"}


# ---------------------------------------------------------------- the packaged contract

def test_bevy_package_passport_full():
    d = _tmp("imaginarium_bevy_")
    glb = _model_glb(d)
    res = _run({"step": "bevy_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out"),
                "params": {"asset_id": "test_box", "profile": "bevy", "validate": False,   # the cargo pass has its own tests below
                           "fx": [{"preset": "fire", "socket": "socket_fx_*"}]}})
    failed = [c["name"] for c in res["checks"] if not c["ok"] and c.get("severity") == "error"]
    assert not failed, failed
    pkg = res["outputs"]["package"]
    for f in ("model.glb", "ima_bevy.json", "README.md", "fx_presets.json"):
        assert os.path.isfile(os.path.join(pkg, f)), f
    with open(res["outputs"]["manifest"], encoding="utf-8") as fh:
        p = json.load(fh)
    # the contract keys, all present (ticket 29's crate reads exactly these)
    for key in ("asset_id", "clips", "default_clip", "sockets", "collider", "collision_meshes",
                "fx", "fx_presets", "glb", "gltf", "rig", "scene", "checks"):
        assert key in p, key
    assert p["format"] == bl.FORMAT and p["asset_id"] == "test_box"
    assert p["glb"] == "model.glb" and p["gltf"] is None
    assert [c["name"] for c in p["clips"]] == ["idle-loop", "attack"], "GLB animation names as-is"
    assert p["clips"][0]["loop"] is True and p["clips"][1]["loop"] is False
    assert p["default_clip"] == "idle-loop"
    assert [s["name"] for s in p["sockets"]] == ["socket_fx_gun"]
    assert p["collision_meshes"] == ["COL_Body"]
    assert p["collider"] == {"kind": "hulls"}, "auto + a COL_ mesh in the model"
    assert p["fx"] == [{"preset": "fire", "socket": "socket_fx_gun", "params": {}}], "the socket mask fanned out"
    assert p["fx_presets"] == "fx_presets.json"
    assert p["rig"]["type"] == "static" and p["rig"]["armatures"] == 0
    assert p["scene"]["longest_m"] > 0 and p["scene"]["tris"] > 0
    assert "glb_copied" in p["checks"] and "fx_presets_known" in p["checks"]
    assert res["stats"]["collider"] == "hulls"


def test_bevy_package_static_no_fx_no_presets_file():
    d = _tmp("imaginarium_bevy_plain_")
    glb = _model_glb(d, clips=False, hull=False)
    res = _run({"step": "bevy_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out"),
                "params": {"asset_id": "plain_box", "validate": False}})
    assert not [c for c in res["checks"] if not c["ok"] and c.get("severity") == "error"], \
        [c for c in res["checks"] if not c["ok"]]
    p = json.load(open(res["outputs"]["manifest"], encoding="utf-8"))
    assert p["clips"] == [] and p["default_clip"] == ""
    assert p["collider"] == {"kind": "box"}, "no hulls, no armature - a box"
    assert p["fx"] == [] and p["fx_presets"] is None
    assert not os.path.exists(os.path.join(res["outputs"]["package"], "fx_presets.json")), "no effects, no presets file"
    warns = [c["name"] for c in res["checks"] if not c["ok"]]
    assert "clips_found" in warns, "a clip-less package is flagged, loudly enough to see, not fatally"


def test_bevy_package_rejects_bad_input():
    d = _tmp("imaginarium_bevy_bad_")
    glb = _model_glb(d, clips=False)
    try:
        _run({"step": "bevy_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "o1"), "params": {}})
        raise AssertionError("a missing asset_id must raise")
    except ValueError as e:
        assert "asset_id" in str(e)
    try:
        _run({"step": "bevy_package", "inputs": {}, "out_dir": os.path.join(d, "o2"),
              "params": {"asset_id": "x_box"}})
        raise AssertionError("no glb input must raise")
    except ValueError as e:
        assert "inputs.glb" in str(e)


# ------------------------------------------------- the ticket 30 cargo pass (driver contract)

def _stub_cargo(folder):
    """A stand-in for the Rust toolchain: it answers exactly the argv the driver builds and
    writes exactly the artifacts imaginarium_bevy_check writes - the real check is verified live, this
    row tests that the step FINDS the answer and CARRIES the outputs."""
    p = os.path.join(folder, "cargo")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("""#!/usr/bin/env bash
slug=""; out=""; prev=""
for a in "$@"; do
  case "$prev" in --slug) slug="$a";; --out) out="$a";; esac
  prev="$a"
done
if [ ! -f "assets/imaginarium/$slug/ima_bevy.json" ]; then
  echo 'IMAGINARIUM_BEVY {"ok":false,"slug":"'"$slug"'","code":2,"why":"no package in the scaffold","shots":[],"checks":[]}'
  exit 2
fi
mkdir -p "$out/shots"
printf 'PNGSTUB' > "$out/shots/forward.png"
echo '{"ok":true,"from":"stub"}' > "$out/bevy_check.json"
echo '{"up":"+Y","from":"stub"}' > "$out/bevy_forward.json"
echo "IMAGINARIUM_BEVY {\\\"ok\\\":true,\\\"slug\\\":\\\"$slug\\\",\\\"code\\\":0,\\\"why\\\":\\\"\\\",\\\"shots\\\":[\\\"shots/forward.png\\\"],\\\"checks\\\":[{\\\"name\\\":\\\"scene_mounted\\\",\\\"ok\\\":true,\\\"detail\\\":\\\"stub\\\"}]}"
exit 0
""")
    os.chmod(p, 0o755)
    return p


def _cargo_env(env):
    """Point the driver's findCargo at env; hand back a restore closure (the suite shares one os.environ)."""
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    def restore():
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return restore


def test_bevy_package_validate_row_without_cargo():
    """The T2-3 absence row: no Rust, honest warning, package bytes unchanged, no check outputs."""
    d = _tmp("imaginarium_bevy_nocargo_")
    glb = _model_glb(d)
    if not shutil.which("node"):
        import pytest
        pytest.skip("the honest skip row needs node to answer (the absence of BOTH is another row)")
    restore = _cargo_env({"IMAGINARIUM_CARGO": os.path.join(d, "definitely-not-cargo"),
                          "IMAGINARIUM_CARGO_TARGET_DIR": os.path.join(d, "target")})
    try:
        res = _run({"step": "bevy_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out"),
                    "params": {"asset_id": "nocargo_box"}})   # validate defaults True
    finally:
        restore()
    rows = [c for c in res["checks"] if c["name"] == "bevy_validation"]
    assert len(rows) == 1, "exactly one validation verdict"
    assert rows[0]["ok"] is False and rows[0]["severity"] == "warning", rows[0]
    assert "cargo not found" in str(rows[0]["value"]), rows[0]
    assert any("unchecked" in w for w in res["warnings"]), res["warnings"]
    for tok in ("bevy_check", "bevy_shots", "bevy_log", "bevy_forward"):
        assert tok not in res["outputs"], tok
    assert res["stats"]["bevy_checked"] is False
    assert not [c for c in res["checks"] if not c["ok"] and c.get("severity") == "error"], \
        "a skipped check must never fail the export"
    assert os.path.isfile(os.path.join(res["outputs"]["package"], "ima_bevy.json")), "the package is still complete"


def test_bevy_package_validate_row_with_stub_cargo():
    """The four contract tokens ride the step outputs when the check answers (ticket 30)."""
    d = _tmp("imaginarium_bevy_stub_")
    glb = _model_glb(d)
    if not shutil.which("node"):
        import pytest
        pytest.skip("the driver is node")
    restore = _cargo_env({"IMAGINARIUM_CARGO": _stub_cargo(d),
                          "IMAGINARIUM_CARGO_TARGET_DIR": os.path.join(d, "target")})
    try:
        res = _run({"step": "bevy_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out"),
                    "params": {"asset_id": "stub_box"}})
    finally:
        restore()
    row = [c for c in res["checks"] if c["name"] == "bevy_validation"]
    assert len(row) == 1 and row[0]["ok"] is True, row
    out = res["outputs"]
    for tok in ("bevy_check", "bevy_log", "bevy_forward"):
        assert tok in out and os.path.isfile(out[tok]), tok
    assert isinstance(out["bevy_shots"], list) and any(s.endswith("forward.png") for s in out["bevy_shots"])
    assert res["stats"]["bevy_checked"] is True
    val = row[0]["value"]
    assert val["failed"] == [] and val["shots"] == ["shots/forward.png"], val
    assert os.path.isfile(out["bevy_check"]), "the check json the binary wrote rides the outputs"
