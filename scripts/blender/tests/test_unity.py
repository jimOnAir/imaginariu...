"""Self-tests of unity_package (docs/forge/unity.md).

The test builds synthetic models and exports them to GLB; the Unity batchmode check runs only with
AF_UNITY_TESTS=1 (it needs a signed-in Unity Hub and takes 20 s ... minutes). Temporary files under tempfile.mkdtemp().
"""
import atexit
import json
import os
import shutil
import tempfile

import bpy
import numpy as np

import af_common as af
from steps import _unity_lib as ul
from steps import unity_package as up


def _tmp(prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    if not os.environ.get("AF_KEEP_TEST_FILES"):
        atexit.register(shutil.rmtree, d, True)
    return d


def _leaf_image(name="leaf_tex", size=32):
    img = bpy.data.images.new(name, width=size, height=size, alpha=True)
    yy, xx = np.mgrid[0:size, 0:size]
    a = ((xx - size / 2) ** 2 + (yy - size / 2) ** 2 < (size / 2.5) ** 2).astype(np.float32)
    px = np.zeros((size, size, 4), dtype=np.float32)
    px[..., 1] = 0.6
    px[..., 3] = a
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def _material(name, image=None, alpha=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    if image is not None:
        t = m.node_tree.nodes.new("ShaderNodeTexImage")
        t.image = image
        m.node_tree.links.new(t.outputs["Color"], b.inputs["Base Color"])
        if alpha:
            m.node_tree.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    return m


def _tree_glb(folder):
    """A trunk (cylinder, ~4k tris), a leaf card mesh 'Leaves' and an fx socket: a prop with wind and LOD."""
    af.reset_scene()
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.2, depth=3.0, location=(0, 0, 1.5))
    trunk = bpy.context.active_object
    trunk.name = "Trunk"
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.subdivide(number_cuts=6)
    bpy.ops.object.mode_set(mode="OBJECT")
    trunk.data.materials.append(_material("Bark"))
    bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0.4, 0.0, 3.2))
    leaves = bpy.context.active_object
    leaves.name = "Leaves"
    leaves.data.materials.append(_material("Leaves", _leaf_image(), alpha=True))
    af.add_socket("socket_fx_top", location=(0.0, 0.5, 3.0), kind="fx")
    path = os.path.join(folder, "tree.glb")
    af.export_glb(path, animations=False)
    return path


def _run(req):
    return up.run(req)


def test_to_unity_axes():
    # Blender -Y (a character's face) -> Unity -Z; Blender +Y (a ship's nose) -> Unity +Z; up stays up
    assert up.to_unity([0, -1, 0]) == [0.0, 0.0, -1.0]
    assert up.to_unity([0, 1, 0]) == [0.0, 0.0, 1.0]
    assert up.to_unity([0, 0, 1]) == [0.0, 1.0, 0.0]
    assert up.to_unity([1, 0, 0]) == [1.0, 0.0, 0.0]
    assert up.turn([1.0, 2.0, 3.0], True) == [-1.0, 2.0, -3.0]
    # glTF -Z (muzzle forward) is Unity +Z of the FX object, glTF +Y stays +Y
    assert up._gltf_to_unity_local([0, 0, -1]) == [0.0, 0.0, 1.0]
    assert up._gltf_to_unity_local([0, 1, 0]) == [0.0, 1.0, 0.0]


def test_unity_package_prop_wind_lod_collider_fx():
    d = _tmp("af_unity_tree_")
    glb = _tree_glb(d)
    res = _run({"step": "unity_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out"),
                "params": {"asset_id": "test_tree", "kind": "prop", "validate": False,
                           "fx": [{"preset": "fire", "socket": "socket_fx_top"}]}})
    failed = [c["name"] for c in res["checks"] if not c["ok"] and c.get("severity") == "error"]
    assert not failed, failed
    pkg_dir = res["outputs"]["package"]
    for f in ("test_tree.fbx", "af_unity.json", "README.md", "fx/textures/soft.png"):
        assert os.path.isfile(os.path.join(pkg_dir, f)), f
    with open(res["outputs"]["manifest"], encoding="utf-8") as fh:
        pkg = json.load(fh)
    assert pkg["format"] == up.FORMAT and pkg["rig"] == "none"
    assert pkg["model_rotation_y"] == 0.0                      # prop: glTF -Z nose already looks along Unity +Z
    leaves = next(m for m in pkg["materials"] if m["name"] == "Leaves")
    assert leaves["wind"] and leaves["alpha"] == "cutout" and leaves["base_map"].startswith("textures/")
    assert not next(m for m in pkg["materials"] if m["name"] == "Bark")["wind"]
    assert len(pkg["lod"]["levels"]) == 3
    assert pkg["lod"]["tris"][0] > pkg["lod"]["tris"][1] > pkg["lod"]["tris"][2]
    assert all("Leaves" in lv["renderers"] for lv in pkg["lod"]["levels"])     # cards shared by every level
    assert pkg["collider"]["type"] == "capsule" and pkg["collider"].get("note") == "trunk"
    assert pkg["collider"]["radius"] < 0.4
    sock = pkg["sockets"][0]
    assert sock["name"] == "socket_fx_top"
    assert np.allclose(sock["position"], up.to_unity([0.0, 0.5, 3.0]), atol=1e-3)
    fx = pkg["fx"][0]
    assert fx["socket"] == "socket_fx_top" and abs(np.linalg.norm(fx["up"]) - 1) < 1e-3
    assert pkg["fx_presets"][0]["preset"] == "fire"
    assert abs(sorted(pkg["size_m"])[-1] - sorted(pkg["size_gltf_m"])[-1]) < 0.01


def test_unity_package_character_turned_and_rigged():
    d = _tmp("af_unity_char_")
    af.reset_scene()
    bpy.ops.object.armature_add(location=(0, 0, 0))
    arm = bpy.context.active_object
    arm.name = "Armature"
    bpy.ops.mesh.primitive_cube_add(size=0.5, location=(0, -0.2, 0.9))     # body slightly in front (-Y)
    body = bpy.context.active_object
    body.name = "Body"
    body.data.materials.append(_material("Skin"))
    body.parent = arm
    md = body.modifiers.new("Armature", "ARMATURE")
    md.object = arm
    vg = body.vertex_groups.new(name="Bone")
    vg.add(list(range(len(body.data.vertices))), 1.0, "REPLACE")
    arm.animation_data_create()
    act = bpy.data.actions.new("idle-loop")
    arm.animation_data.action = act
    pb = arm.pose.bones["Bone"]
    pb.rotation_mode = "XYZ"
    for f, z in ((1, 0.0), (12, 0.3), (24, 0.0)):
        pb.rotation_euler = (0, 0, z)
        pb.keyframe_insert("rotation_euler", frame=f)
    path = os.path.join(d, "char.glb")
    af.export_glb(path)
    res = _run({"step": "unity_package", "inputs": {"glb": path}, "out_dir": os.path.join(d, "out"),
                "params": {"asset_id": "test_char", "kind": "creature", "validate": False}})
    with open(res["outputs"]["manifest"], encoding="utf-8") as fh:
        pkg = json.load(fh)
    assert pkg["rig"] == "generic"
    assert pkg["model_rotation_y"] == 180.0                     # +Z GLB faces Unity -Z: turned to +Z
    assert [c["name"] for c in pkg["clips"]] == ["idle"] and pkg["clips"][0]["loop"]
    assert pkg["default_clip"] == "idle"
    assert pkg["collider"]["type"] == "capsule"
    assert pkg["lod"]["levels"] == []                           # skinned: no LOD
    # the body sits at Blender -Y = in front of the character: after the turn it is on Unity +Z
    assert pkg["bounds_max"][2] > abs(pkg["bounds_min"][2]) - 1e-6


def test_unity_package_sprites_only():
    d = _tmp("af_unity_spr_")
    sheet = os.path.join(d, "idle.png")
    arr = np.zeros((32, 64, 4), dtype=np.uint8)
    arr[8:24, 8:24] = (200, 120, 60, 255)
    arr[8:24, 40:56] = (200, 120, 60, 255)
    from steps import _export_lib as xl
    xl.save_png(sheet, arr)
    sp = {"format": "astraforge-sprites/1", "asset_id": "blob", "profile": "pixel", "px_per_meter": 32.0,
          "cell": [32, 32], "anchor": [16.0, 28.0], "sheets": ["idle.png"],
          "clips": {"idle": {"loop": True, "fps": 8.0, "frames": 2,
                             "views": {"S": {"sheet": "idle.png", "animation": "idle_S",
                                             "rects": [[0, 0, 32, 32], [32, 0, 32, 32]]}}}}}
    spj = os.path.join(d, "sprites.json")
    with open(spj, "w", encoding="utf-8") as fh:
        json.dump(sp, fh)
    res = _run({"step": "unity_package", "inputs": {"sprites": spj}, "out_dir": os.path.join(d, "out"),
                "params": {"asset_id": "blob", "validate": False}})
    with open(res["outputs"]["manifest"], encoding="utf-8") as fh:
        pkg = json.load(fh)
    assert pkg["model"] == "" and pkg["sprites"]["pixel"] and pkg["sprites"]["ppu"] == 32.0
    assert pkg["sprites"]["clips"][0]["views"][0]["rects"][1] == {"x": 32, "y": 0, "w": 32, "h": 32}
    assert os.path.isfile(os.path.join(res["outputs"]["package"], "sprites", "idle.png"))


def test_unity_batchmode_check():
    if not os.environ.get("AF_UNITY_TESTS"):
        return "skip: AF_UNITY_TESTS=1 runs Unity -batchmode (signed-in Unity Hub, 20 s ... minutes)"
    if ul.find_unity() is None:
        return "skip: Unity not found"
    d = _tmp("af_unity_bm_")
    glb = _tree_glb(d)
    res = _run({"step": "unity_package", "inputs": {"glb": glb}, "out_dir": os.path.join(d, "out"),
                "params": {"asset_id": "test_tree_bm", "kind": "prop",
                           "fx": [{"preset": "fire", "socket": "socket_fx_top"}]}})
    names = {c["name"]: c for c in res["checks"]}
    assert names["unity_validation"]["ok"], names["unity_validation"]
    for k in ("unity_materials_no_pink", "unity_size_matches_godot", "unity_placement_axes", "unity_lod_group",
              "unity_fx_attached", "unity_sockets_found"):
        assert names[k]["ok"], (k, names[k])
