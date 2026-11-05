"""Self-tests of unreal_package (docs/product/unreal.md).

The test builds synthetic models, exports them to GLB and runs the step; assertions cover the
package contract (naming, units/axes, textures, UCX collision, LODs, sockets, passport). The
in-editor Unreal import is SKIP by design here: this branch is developed on Linux without an
Unreal Editor, so the data-level contract is the tested scope (the engine pass is proven where
an editor exists).
"""
import atexit
import json
import os
import shutil
import tempfile

import bpy

import af_common as af
from steps import unreal_package as up


def _tmp(prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    if not os.environ.get("AF_KEEP_TEST_FILES"):
        atexit.register(shutil.rmtree, d, True)
    return d


def _material(name="Hull", rgba=(0.2, 0.5, 0.8, 1.0)):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    return mat


def _static_glb(d, subdivisions=0, kind_mesh=None):
    af.reset_scene()
    if subdivisions:
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0)
    else:
        bpy.ops.mesh.primitive_cube_add(size=1.0)
    body = bpy.context.active_object
    body.name = "body"
    body.data.materials.append(_material())
    if subdivisions:                                       # dense mesh for the LOD path
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.quads_convert_to_tris(quad_method="BEAUTY")
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.mesh.primitive_cube_add(size=1.1)
    col = bpy.context.active_object
    col.name = "body-colonly"
    emp = bpy.data.objects.new("socket_mount", None)
    bpy.context.collection.objects.link(emp)
    emp.location = (0, 0, 0.6)
    glb = os.path.join(d, "asset.glb")
    af.export_glb(glb)
    return glb


def _passport(d, kind="ship"):
    path = os.path.join(d, "asset.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"name": "Test asset", "kind": kind}, fh)
    return path


def _req(glb, d, **params):
    p = {"asset_id": "test_unreal_asset"}
    p.update(params)
    return {"step": "unreal_package", "inputs": {"glb": glb, "manifest": _passport(d, params.pop("passport_kind", "ship"))},
            "out_dir": os.path.join(d, "out"), "params": p}


def _run(req):
    res = up.run(req)
    return res


def test_unreal_static_package_contract():
    d = _tmp("af_unreal_static_")
    res = _run(_req(_static_glb(d), d))
    assert all(c["ok"] for c in res["checks"] if c.get("severity", "error") == "error"), res["checks"]
    man_path = res["outputs"]["manifest"]
    with open(man_path, "r", encoding="utf-8") as fh:
        man = json.load(fh)
    assert man["format"] == "astraforge-unreal-package/1"
    assert man["units"] == "cm"
    assert man["axes"]["up"] == "Z" and man["axes"]["forward"] == "+X" and man["axes"]["handed"] == "left"
    assert man["axes"]["source_forward_glb"] == "-Z" and man["axes"]["root_rotation_z_deg"] == 0.0
    assert man["axes"]["fbx_axes"] == {"forward": "-Y", "up": "Z"}
    assert man["main"]["mesh"] == "SM_test_unreal_asset" and man["main"]["rig"] == "static"
    assert man["fbx"] == "SM_test_unreal_asset.fbx" and os.path.isfile(res["outputs"]["fbx"])
    assert os.path.getsize(res["outputs"]["fbx"]) > 500
    # collision: the -colonly cube became one UCX hull on the main mesh, within the triangle budget
    assert len(man["collision"]) == 1, man["collision"]
    assert man["collision"][0]["ucx"].startswith("UCX_SM_test_unreal_asset_")
    assert man["collision"][0]["render"] == "SM_test_unreal_asset"
    assert 0 < man["collision"][0]["triangles"] <= 64
    # textures + material instance per the conventions
    assert len(man["materials"]) == 1
    mi = man["materials"][0]
    assert mi["name"] == "MI_test_unreal_asset_Hull"
    tex_dir = os.path.join(os.path.dirname(man_path), "Textures")
    assert mi["textures"]["baseColor"].startswith("T_test_unreal_asset_Hull_BaseColor")
    assert os.path.isfile(os.path.join(tex_dir, mi["textures"]["baseColor"]))
    assert os.path.isfile(os.path.join(tex_dir, mi["textures"]["orm"]))
    assert "normal" not in mi["textures"]                  # no normal map on the synthetic material
    # sockets ride the manifest; the passport is carried untouched; LOD0-only below lod_min_tris
    assert [s["name"] for s in man["sockets"]] == ["socket_mount"]
    assert man["passport"]["kind"] == "ship"
    assert man["meshes"][0]["lods"] == []
    assert man["actor_blueprint"] == "A_test_unreal_asset" and man["master_material"] == "M_AstraForge"
    assert os.path.isfile(res["outputs"]["readme"])


def test_unreal_lods_for_dense_mesh():
    d = _tmp("af_unreal_lod_")
    res = _run(_req(_static_glb(d, subdivisions=5), d))
    assert all(c["ok"] for c in res["checks"] if c.get("severity", "error") == "error"), res["checks"]
    with open(res["outputs"]["manifest"], "r", encoding="utf-8") as fh:
        man = json.load(fh)
    lods = man["meshes"][0]["lods"]
    assert [l["level"] for l in lods] == [1, 2], lods
    assert lods[0]["mesh"] == "SM_test_unreal_asset_LOD1" and lods[1]["mesh"] == "SM_test_unreal_asset_LOD2"
    assert res["stats"]["lods"] == 2


def test_unreal_character_source_forward():
    d = _tmp("af_unreal_fwd_")
    res = _run(_req(_static_glb(d), d, passport_kind="humanoid"))
    with open(res["outputs"]["manifest"], "r", encoding="utf-8") as fh:
        man = json.load(fh)
    assert man["axes"]["source_forward_glb"] == "+Z"
    assert man["axes"]["root_rotation_z_deg"] == -90.0     # the nose turns to UE +X on import


def test_unreal_collision_off():
    d = _tmp("af_unreal_nocol_")
    res = _run(_req(_static_glb(d), d, collision="none"))
    with open(res["outputs"]["manifest"], "r", encoding="utf-8") as fh:
        man = json.load(fh)
    assert man["collision"] == []


def test_unreal_input_guards():
    d = _tmp("af_unreal_guard_")
    glb = _static_glb(d)
    for bad in ({"asset_id": "Bad ID"}, {"asset_id": "ok_id", "profile": "godot"}):
        req = {"step": "unreal_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out2"), "params": bad}
        try:
            up.run(req)
            raise AssertionError("expected ValueError for %r" % bad)
        except ValueError:
            pass
    req = {"step": "unreal_package", "inputs": {"glb": os.path.join(d, "missing.glb")}, "out_dir": os.path.join(d, "out3"),
           "params": {"asset_id": "ok_id"}}
    try:
        up.run(req)
        raise AssertionError("expected ValueError for a missing glb")
    except ValueError:
        pass


def test_unreal_ineditor_import():
    return "skip: no Unreal Editor on this machine; the plugin pass is proven where one exists (docs/product/unreal.md)"
