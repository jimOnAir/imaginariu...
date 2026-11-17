"""0.7.10 fold wave ticket 62: the vrm_package step and its _vrm_lib data core.

The pure half (bone table against our own rig contract, ARKit expression matching, the missing
component remedy) runs everywhere. The end-to-end export needs the ticket-61 component (the
VRM Add-on for Blender) and SKIPS honestly while it is not installed - the supply-chain gate
for the pinned asset opens 2026-11-18 08:35:20 UTC, and this same file becomes the runtime
verification of the step then (test_vrm_export_round_trip).

Run: blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- vrm
"""
import os
import tempfile

import bpy

import af_common as af
from steps import _vrm_lib as V


# ---------------------------------------------------------------- _vrm_lib: the bone table

def test_match_human_bones_on_our_own_rig_contract():
    """The rig contract of rig_humanoid is _anim_lib.CANON (+ the mixamorig: prefix) - a rig
    this studio builds must satisfy VRM 1.0's Required set through the transcribed table."""
    from steps import _anim_lib as AL
    names = ["mixamorig:" + c for c in AL.CANON]
    mapped, missing = V.match_human_bones(names)
    assert missing == [], "our rig must carry every VRM REQUIRED bone, missing: %s" % missing
    assert all(v in V.VRM1_BONES for v in mapped), "table invented a bone name"
    # the non-obvious rows of the publisher's Mixamo mapping, pinned:
    assert mapped["chest"].endswith("Spine1") and mapped["upperChest"].endswith("Spine2")
    assert mapped["leftThumbMetacarpal"].endswith("LeftHandThumb1")
    assert mapped["leftLittleDistal"].endswith("LeftHandPinky3")
    assert mapped["leftToes"].endswith("LeftToeBase")
    # Mixamo's 4th bone of the four non-thumb fingers has NO VRM slot - it must not be forced
    assert not any(v.endswith("4") for v in mapped.values()), mapped
    # and the same rig without the prefix maps identically (find_bone-style tolerance)
    mapped2, missing2 = V.match_human_bones(list(AL.CANON))
    assert missing2 == [] and set(mapped2) == set(mapped)


def test_match_human_bones_reports_missing_required():
    mapped, missing = V.match_human_bones(["Hips", "Spine", "LeftArm", "RightArm"])
    assert "leftHand" in missing and "leftLowerArm" in missing  # Arm alone is not enough
    assert "hips" not in missing and mapped.get("hips") == "Hips"
    # the required count is the spec's: 15 (the shoulders are NOT Required - the spec column
    # and the addon's human_bone.py agree)
    assert sum(1 for r in V.VRM1_BONES_REQUIRED.values() if r) == 15
    # gate-regression guard for the fresh-context audit finding (F1): a rig that maps all 15
    # Required bones but carries NO shoulders must report no missing
    from steps import _anim_lib as AL
    no_shoulders = [n for n in AL.CANON if n not in ("LeftShoulder", "RightShoulder")]
    mapped_ns, missing_ns = V.match_human_bones(["mixamorig:" + n for n in no_shoulders])
    assert missing_ns == [] and "leftShoulder" not in mapped_ns, missing_ns


# ---------------------------------------------------------------- _vrm_lib: expressions

def test_expressions_direct_keys_win_case_tolerant():
    found, gaps = V.match_expressions(["Blink", "HAPPY", "mouth_smile"], wanted=["blink", "happy", "aa"])
    assert found["blink"] == {"direct": "Blink"}, found
    assert found["happy"] == {"direct": "HAPPY"}, found
    # a shape key that is neither a preset name nor an ARKit key wires nothing, and the preset
    # without any support is a named gap - never a silent skip
    assert "aa" in gaps and "mouth_smile" not in str(found), (found, gaps)


def test_expressions_from_a_stock_arkit_face():
    """A character with the standard 52 ARKit keys gets blink, the five vowels and four of the
    emotions through the publisher's blends - with the publisher's weights, never invented ones."""
    found, gaps = V.match_expressions(V.ARKIT_52)
    assert len(V.ARKIT_52) == 52 and len(set(V.ARKIT_52)) == 52
    assert found["blink"] == {"blend": {"eyeBlinkLeft": 1.0, "eyeBlinkRight": 1.0}}
    assert found["happy"] == {"blend": {"mouthSmileLeft": 0.5, "mouthSmileRight": 0.5}}
    assert found["aa"] == {"blend": {"jawOpen": 0.5}}
    assert {"blink", "aa", "ih", "ou", "ee", "oh", "happy", "angry", "sad", "surprised"} <= set(found)
    assert "relaxed" in gaps  # the publisher has no blend for it - only a named key can wire it
    # every blend member really exists among the 52 (a table drift fails here, not at export)
    for preset in found.values():
        for key in (preset.get("blend") or {}):
            assert key in V.ARKIT_52, key


def test_expressions_partial_face_honest_gaps():
    """Half a face must not produce half a blend: if ANY weight member is absent the preset is
    a named gap."""
    found, gaps = V.match_expressions(["mouthSmileLeft", "jawOpen"], wanted=["happy", "aa", "blink"])
    assert "happy" in gaps, found  # right key, missing its mirror
    assert found["aa"] == {"blend": {"jawOpen": 0.5}}
    assert "blink" in gaps


# ---------------------------------------------------------------- the step's remedy paths

def _fake_ext_dir():
    """A folder that satisfies the component predicate (holds a blender_manifest.toml) without
    the real addon - enough to drive the step past the install check into its input validation."""
    d = tempfile.mkdtemp(prefix="fake-vrm-ext-")
    open(os.path.join(d, "blender_manifest.toml"), "w").close()
    return d


def _cube_glb(path):
    af.reset_scene()
    me = bpy.data.meshes.new("cube")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Cube", me)
    bpy.context.scene.collection.objects.link(ob)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format="GLB")
    return path


def test_no_skeleton_names_the_rig_step():
    """The t60/t64 remedy family, VRM edition: a skeletonless input must name rig_humanoid."""
    from steps import vrm_package as VP
    d = _fake_ext_dir()
    old = os.environ.get("ASTRA_VRM_ADDON")
    os.environ["ASTRA_VRM_ADDON"] = d
    try:
        glb = _cube_glb(os.path.join(d, "cube.glb"))
        VP.run({"step": "vrm_package", "params": {}, "inputs": {"glb": glb}, "out_dir": d})
        raise AssertionError("expected the no-skeleton remedy error")
    except ValueError as e:
        assert "run rig_humanoid first" in str(e), str(e)
    finally:
        if old is None:
            os.environ.pop("ASTRA_VRM_ADDON", None)
        else:
            os.environ["ASTRA_VRM_ADDON"] = old
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_missing_required_bones_are_named():
    """A Hips-only rig maps something but cannot satisfy the spec's Required set: the error
    lists exactly which VRM bones are missing (an export without them would not load)."""
    from steps import vrm_package as VP
    d = _fake_ext_dir()
    old = os.environ.get("ASTRA_VRM_ADDON")
    os.environ["ASTRA_VRM_ADDON"] = d
    try:
        af.reset_scene()
        arm_data = bpy.data.armatures.new("a")
        arm = bpy.data.objects.new("Rig", arm_data)
        bpy.context.scene.collection.objects.link(arm)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode="EDIT")
        eb = arm_data.edit_bones.new("mixamorig:Hips")
        eb.head, eb.tail = (0, 0, 0), (0, 0, 0.1)
        bpy.ops.object.mode_set(mode="OBJECT")
        glb = os.path.join(d, "hips.glb")
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.export_scene.gltf(filepath=glb, use_selection=True, export_format="GLB")
        VP.run({"step": "vrm_package", "params": {}, "inputs": {"glb": glb}, "out_dir": d})
        raise AssertionError("expected the missing-REQUIRED-bones error")
    except ValueError as e:
        msg = str(e)
        assert "lists as Required" in msg and "leftHand" in msg, msg
        assert "run rig_humanoid" in msg, msg
    finally:
        if old is None:
            os.environ.pop("ASTRA_VRM_ADDON", None)
        else:
            os.environ["ASTRA_VRM_ADDON"] = old
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_missing_component_names_the_installer():
    """Ticket 64's family rule: the error names the next action, not the class of problem."""
    from steps import vrm_package as VP
    old = os.environ.get("ASTRA_VRM_ADDON")
    os.environ["ASTRA_VRM_ADDON"] = os.path.join(tempfile.gettempdir(), "no-such-vrm-addon-dir")
    try:
        VP.run({"step": "vrm_package", "params": {}, "inputs": {}, "out_dir": tempfile.gettempdir()})
        raise AssertionError("expected the not-installed remedy error")
    except ValueError as e:
        msg = str(e)
        assert "vrmaddon" in msg, msg
        assert "install" in msg.lower(), msg
    finally:
        if old is None:
            os.environ.pop("ASTRA_VRM_ADDON", None)
        else:
            os.environ["ASTRA_VRM_ADDON"] = old


def test_bad_profile_rejected_before_anything_else():
    from steps import vrm_package as VP
    try:
        VP.run({"step": "vrm_package", "params": {"profile": "bevy"}, "inputs": {}, "out_dir": "."})
        raise AssertionError("expected the profile error")
    except ValueError as e:
        assert "vrm1" in str(e), str(e)


# ---------------------------------------------------------------- end to end (post-gate half)

def _synthetic_character_glb(path, shape_keys=False):
    """A rigged (not shaped) character in a rough T-pose: CANON bones with the REAL humanoid
    parent chain and skinned to a cube body. (The first real round trip found the reason a
    stick of orphan bones is not enough: the VRM 1.0 validator checks each assigned bone's
    hierarchy - "Confirm hierarchy of ... and its children" - so the fixture must mirror the
    spec's chains: Spine>Spine1>Spine2>Neck>Head, Shoulder>Arm>ForeArm>Hand>fingers,
    UpLeg>Leg>Foot>Toes.)"""
    from steps import _anim_lib as AL
    af.reset_scene()
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("mixamorig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    made = {}

    def bone(name, head, tail, parent=None):
        eb = arm_data.edit_bones.new("mixamorig:" + name)
        eb.head, eb.tail = head, tail
        if parent and parent in made:
            eb.parent = made[parent]
        made[name] = eb

    bone("Hips", (0, 0, 1.0), (0, 0, 1.05))
    bone("Spine", (0, 0, 1.05), (0, 0, 1.09), "Hips")
    bone("Spine1", (0, 0, 1.09), (0, 0, 1.13), "Spine")
    bone("Spine2", (0, 0, 1.13), (0, 0, 1.17), "Spine1")
    bone("Neck", (0, 0, 1.17), (0, 0, 1.21), "Spine2")
    bone("Head", (0, 0, 1.21), (0, 0, 1.27), "Neck")
    bone("HeadTop_End", (0, 0, 1.27), (0, 0, 1.30), "Head")
    for sgn, s in ((-1.0, "Left"), (1.0, "Right")):
        bone(s + "Shoulder", (sgn * 0.05, 0, 1.15), (sgn * 0.15, 0, 1.15), "Spine2")
        bone(s + "Arm", (sgn * 0.15, 0, 1.15), (sgn * 0.35, 0, 1.15), s + "Shoulder")
        bone(s + "ForeArm", (sgn * 0.35, 0, 1.15), (sgn * 0.55, 0, 1.15), s + "Arm")
        bone(s + "Hand", (sgn * 0.55, 0, 1.15), (sgn * 0.63, 0, 1.15), s + "ForeArm")
        for f, fy in (("Thumb", -0.04), ("Index", 0.03), ("Middle", 0.01), ("Ring", -0.01), ("Pinky", -0.03)):
            prev = s + "Hand"
            for i in range(1, 5):
                n = s + "Hand" + f + str(i)
                bone(n, (sgn * (0.64 + 0.025 * (i - 1)), fy, 1.15), (sgn * (0.64 + 0.025 * i), fy, 1.15), prev)
                prev = n
        bone(s + "UpLeg", (sgn * 0.09, 0, 0.95), (sgn * 0.09, 0, 0.55), "Hips")
        bone(s + "Leg", (sgn * 0.09, 0, 0.55), (sgn * 0.09, 0, 0.15), s + "UpLeg")
        bone(s + "Foot", (sgn * 0.09, 0, 0.15), (sgn * 0.09, -0.06, 0.12), s + "Leg")
        bone(s + "ToeBase", (sgn * 0.09, -0.06, 0.12), (sgn * 0.09, -0.12, 0.12), s + "Foot")
        bone(s + "Toe_End", (sgn * 0.09, -0.12, 0.12), (sgn * 0.09, -0.15, 0.12), s + "ToeBase")
    assert set(made) == set(AL.CANON), "fixture drifted from the rig contract"
    bpy.ops.object.mode_set(mode="OBJECT")
    me = bpy.data.meshes.new("body")
    me.from_pydata([(-0.1, -0.05, 0), (0.1, -0.05, 0), (0.1, 0.05, 0), (-0.1, 0.05, 0)],
                   [], [(0, 1, 2), (0, 2, 3)])
    me.update()
    body = bpy.data.objects.new("Body", me)
    bpy.context.scene.collection.objects.link(body)
    vg = body.vertex_groups.new(name="mixamorig:Hips")
    vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    mod = body.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    if shape_keys:
        body.shape_key_add(name="Basis")
        for sk in ("eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "mouthSmileLeft",
                   "mouthSmileRight", "browDownLeft", "browDownRight"):
            body.shape_key_add(name=sk)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    body.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format="GLB")
    return path


def test_vrm_export_round_trip():
    """The runtime half of ticket 62: with the component installed the step exports a .vrm
    whose VRM 1.0 bones the addon itself wrote (human_bones_assigned), the container carries
    VRMC_vrm, and the rig re-imports. Ran live first on 2026-11-17 (component installed by
    owner order); still skips honestly if the addon is missing."""
    from steps import vrm_package as VP
    old = os.environ.pop("ASTRA_VRM_ADDON", None)
    try:
        ext_dir = VP._addon_dir()
    finally:
        if old is not None:
            os.environ["ASTRA_VRM_ADDON"] = old
    if not ext_dir:
        return "skip: vrm addon not installed (ticket 61: installer -Only vrmaddon)"
    tmp = tempfile.mkdtemp(prefix="vrm-e2e-")
    try:
        src = _synthetic_character_glb(os.path.join(tmp, "char.glb"))
        res = VP.run({"step": "vrm_package", "params": {"name": "char", "meta_name": "Char One"},
                      "inputs": {"glb": src}, "out_dir": tmp})
        vrm = res["outputs"]["vrm"]
        assert os.path.isfile(vrm) and os.path.getsize(vrm) > 1000, res["stats"]
        assert res["stats"]["human_bones_assigned"] >= 15, res["stats"]  # all of the Required-15
        assert "VRMC_vrm" in res["stats"]["extensions_used"], res["stats"]
        assert res["stats"]["vrm_meta_name"] == "Char One", res["stats"]
        assert res["stats"].get("reimport", {}).get("armatures") == 1, res["stats"]
        assert os.path.isfile(res["outputs"]["report"])
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_manifest_input_is_a_path_to_asset_json():
    """The live wizard run of 2026-11-17 caught this: forge-pipeline passes inputs.manifest
    as a PATH to asset.json (godot_package and bevy_package open it), not as an object -
    vrm_package used to treat it as one and crashed on the first pipeline run
    (AttributeError: 'str' object has no attribute 'get'). The passport name becomes the
    VRM meta name and the .vrm file name."""
    from steps import vrm_package as VP
    old = os.environ.pop("ASTRA_VRM_ADDON", None)
    try:
        ext_dir = VP._addon_dir()
    finally:
        if old is not None:
            os.environ["ASTRA_VRM_ADDON"] = old
    if not ext_dir:
        return "skip: vrm addon not installed (ticket 61: installer -Only vrmaddon)"
    tmp = tempfile.mkdtemp(prefix="vrm-manifest-")
    try:
        src = _synthetic_character_glb(os.path.join(tmp, "char.glb"))
        asset = os.path.join(tmp, "asset.json")
        with open(asset, "w", encoding="utf-8") as fh:
            fh.write('{"name": "Passport Hero"}')
        res = VP.run({"step": "vrm_package", "params": {"profile": "vrm1"},
                      "inputs": {"glb": src, "manifest": asset}, "out_dir": tmp})
        assert res["stats"]["vrm_meta_name"] == "Passport Hero", res["stats"]
        assert os.path.basename(res["outputs"]["vrm"]) == "Passport_Hero.vrm", res["outputs"]
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_expressions_bound_in_the_exported_vrm():
    """Ticket 62's binding half, live-verified: a face carrying the ARKit keys gets its
    presets written into the addon's vrm1.expressions surface, and the addon itself emits
    them in the file (VRMC_vrm.expressions.preset.<name>.morphTargetBinds). The report count
    is checked against what the BYTES show, not against what the matcher found."""
    from steps import vrm_package as VP
    old = os.environ.pop("ASTRA_VRM_ADDON", None)
    try:
        ext_dir = VP._addon_dir()
    finally:
        if old is not None:
            os.environ["ASTRA_VRM_ADDON"] = old
    if not ext_dir:
        return "skip: vrm addon not installed (ticket 61: installer -Only vrmaddon)"
    tmp = tempfile.mkdtemp(prefix="vrm-bind-")
    try:
        src = _synthetic_character_glb(os.path.join(tmp, "face.glb"), shape_keys=True)
        res = VP.run({"step": "vrm_package", "params": {"name": "face", "meta_name": "Face One"},
                      "inputs": {"glb": src}, "out_dir": tmp})
        # the fixture's keys support exactly blink/aa/happy/sad (the blends whose members all
        # exist); ih/ou/ee/oh/angry/surprised/relaxed stay named gaps, and the bound count
        # equals the number of presets the FILE carries
        assert res["stats"]["expressions_bound"] == 4, res["stats"]
        assert sorted(res["stats"]["gaps"]["expressions"]) == sorted(
            ["angry", "ee", "ih", "oh", "ou", "relaxed", "surprised"]), res["stats"]
        from steps import convert as cvt
        g = cvt._glb_json(res["outputs"]["vrm"])
        preset = g["extensions"]["VRMC_vrm"]["expressions"]["preset"]
        bound = sorted(p for p, e in preset.items() if e.get("morphTargetBinds"))
        assert bound == ["aa", "blink", "happy", "sad"], bound
        assert len(preset["blink"]["morphTargetBinds"]) == 2
        aa = preset["aa"]["morphTargetBinds"]
        assert len(aa) == 1 and aa[0]["weight"] == 0.5
        names = [n for m in g["meshes"]
                 for n in ((m.get("extras") or {}).get("targetNames") or [])]
        assert {"eyeBlinkLeft", "eyeBlinkRight", "jawOpen"} <= set(names), names
        mesh_nt = len(((g["meshes"][0].get("extras") or {}).get("targetNames") or []))
        for e in preset.values():
            for b in e.get("morphTargetBinds", []):
                assert isinstance(b["index"], int) and 0 <= b["index"] < mesh_nt, b
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
