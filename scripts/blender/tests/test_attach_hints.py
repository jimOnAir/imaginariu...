"""0.7.10 fold wave ticket 64: the clarity hints of the held-item step (the t60 remedy family).

The 0.7.10 note: «Item in hand» on a skeletonless model says which step to run first instead of
a technical error; an item without a grip point gets a hint what to do. The retarget half of the
family already shipped in ticket 60 (test_find_target_rig_remedy_message in test_mixamo.py) -
these tests cover the attach_prop half: load_character's armature pick (no skeleton at all vs an
armature without hands - two different remedies) and the missing socket_grip_main (the remedy is
the bone_kit step, which provably creates that very socket).

Run: blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- attach_hints
"""
import bpy

import af_common as af


def _plain_mesh(name="Plain"):
    me = bpy.data.meshes.new(name.lower())
    me.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def test_skeletonless_character_names_the_rig_step():
    """ticket 64: holding an item on a model without a skeleton must name the next click,
    in the same family as ticket 60's retarget remedy."""
    from steps import attach_prop as AP
    ob = _plain_mesh()
    try:
        AP.pick_hands_armature([ob], "/no/such/file.glb")
        raise AssertionError("expected the no-skeleton error")
    except ValueError as e:
        msg = str(e)
        assert "run rig_humanoid first" in msg, msg
        assert "no armature" in msg, msg


def test_armature_without_hands_is_not_sent_to_rig_humanoid():
    """ticket 64 honesty: a model that HAS an armature but no hand bones must not be told to
    run the rig step again - the message names the armature and what it lacks."""
    from steps import attach_prop as AP
    ob = _plain_mesh("Body")
    arm_data = bpy.data.armatures.new("creature")
    arm = bpy.data.objects.new("CreatureRig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones.new("Spine")
    eb.head = (0, 0, 0)
    eb.tail = (0, 0, 0.5)
    bpy.ops.object.mode_set(mode='OBJECT')
    try:
        AP.pick_hands_armature([ob, arm], "/no/such/file.glb")
        raise AssertionError("expected the no-hands error")
    except ValueError as e:
        msg = str(e)
        assert "CreatureRig" in msg, msg
        assert "hand" in msg.lower(), msg
        assert "run rig_humanoid first" not in msg, 'a creature rig rerun of rig_humanoid is not the remedy: ' + msg


def test_item_without_grip_names_the_kit_step():
    """ticket 64: a bare socket name is a dead end - bone_kit is the step that creates
    socket_grip_main (scripts/blender/steps/bone_kit.py), say so."""
    from steps import attach_prop as AP
    msg = AP.grip_hint("staff.glb")
    assert "socket_grip_main" in msg, msg
    assert "bone_kit" in msg, msg
    assert "staff.glb" in msg, msg
