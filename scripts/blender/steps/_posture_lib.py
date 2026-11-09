"""_posture_lib - the fighters' shoulder-posture guard (wave ticket 35).

Windows 0.6.13: "retargeting clips and motion style no longer roll the fighters' shoulders
back - posture is fixed and checked on every clip". The observable this branch watches is the
TWIST of the arm around the upper arm's own long axis - the direction the elbow crease points
to. Legitimate motion swings the arm (rotation about the shoulder's left-right axis) and
changes no twist; the roll bug turns the humerus and drags the elbow crease sideways. So a
change of twist measured against the reference pose of the SAME rig is the discriminator:

  * motion_style: reference = the clip's own pose before the style was applied. The rigs, the
    rest and the hips frame are identical on both sides, so the raw per-frame twist delta is
    exact: style may swing the arms, it may not roll the shoulders beyond the tolerance.

The retarget side needs no new gate on this branch: its existing contract already measures
both DOFs against the SOURCE pose - `arm_dir_err_deg` (checked in the test lane at < 1 deg;
the 0.6.18-wave probe of ticket 35 measured 0.00) for the arm direction and `hand_twist_*`
(limit 25 deg) for the twist motion span - and a rolled shoulder must move one of them.
`motion_style` had no such gate (its reference is the clip itself pre-style), which is why
the guard lives there - exactly where the Windows note placed the regression ("retargeting
clips AND motion style": their retarget bug this branch never had, their style bug needed one).

Death-category clips are exempt from the correction (a fall pose throws the arms everywhere
on purpose - the 0.6.14 lesson): measured, reported, never clamped.

All math is pure (mathutils.Vector / quaternion lists) so the unit lane runs without rigging:
`tests/low-vram`-style headless asserts + Blender-lane integration tests prove it.

Frame convention (this module only): vectors expressed in the hips' local frame, facing -Y
(the rest of the GLB clip contract), up +Z, character-left +X; bone-local frames are Blender's
(bone's long axis = local +Y).
"""
import math

from mathutils import Vector

BACK = Vector((0.0, 1.0, 0.0))   # fallback reference (arm pointing straight sideways)
SIDE = Vector((1.0, 0.0, 0.0))   # primary: a swing lives in the YZ hips plane, so the side
#                                  axis stays perpendicular to the arm through the whole stride -
#                                  the crease angle measured against it is continuous under
#                                  legitimate swing and moves ONLY when the humerus rolls.


def upper_arm_twist_deg(shoulder, elbow, wrist):
    """Signed twist of the elbow crease around the upper-arm axis, degrees. None for
    (near-)straight or (near-)folded arms, where the crease direction is undefined."""
    d_u = elbow - shoulder
    d_f = wrist - elbow
    if d_u.length < 1e-6 or d_f.length < 1e-6:
        return None
    n = d_u.cross(d_f)
    # sin of the elbow bend angle below ~10 deg: the crease direction is undefined and the
    # atan2 output is pure noise (a straight arm jitters between +-180 near the branch cut)
    if n.length < 0.1736 * d_u.length * d_f.length:
        return None
    n.normalize()
    du = d_u.normalized()
    ref = SIDE - du * SIDE.dot(du)
    if ref.length < 1e-3:
        ref = BACK - du * BACK.dot(du)
    if ref.length < 1e-3:
        return None
    ref.normalize()
    return math.degrees(math.atan2(du.dot(ref.cross(n)), ref.dot(n)))


def twist_deltas(ref_tw, cur_tw):
    """Per-frame signed deltas (cur - ref); None where either side is undefined."""
    return [None if (a is None or b is None) else b - a for a, b in zip(ref_tw, cur_tw)]


def wrap_deg(a):
    return (a + 180.0) % 360.0 - 180.0


def twist_guard(ref_tw, cur_tw, tol_deg=25.0):
    """Verdict for one clip and one side: worst |delta| beyond the wrap, offender frames.
    Returns {worst_deg, over: [(frame, delta_deg)], checked}."""
    deltas = twist_deltas(ref_tw, cur_tw)
    checked = [d for d in deltas if d is not None]
    if not checked:
        return {"worst_deg": None, "over": [], "checked": 0}
    over = [(f, round(wrap_deg(d), 2)) for f, d in enumerate(deltas)
            if d is not None and abs(wrap_deg(d)) > tol_deg]
    worst = max((abs(wrap_deg(d)) for d in checked))
    return {"worst_deg": round(worst, 2), "over": over, "checked": len(checked)}


def sample_twists_deg(obj, sides, hips_bone, start, n):
    """Twist series of the given bone pairs for an ANIMATED object: sides = [(label,
    upper_arm_bone, forearm_bone)], evaluated frame by frame (the action must be assigned).
    Vectors are taken into the hips' local frame (the BACK reference is defined there);
    returns None when the hips bone is missing, None entries where a bone pair or a straight
    arm gives no crease. bpy is imported lazily so the pure math stays headless-testable."""
    import bpy
    from mathutils import Vector as _V
    sc = bpy.context.scene
    out = {label: [] for label, _, _ in sides}
    if hips_bone is None or hips_bone not in {p.name for p in obj.pose.bones}:
        return None
    for f in range(n):
        sc.frame_set(start + f)
        dg = bpy.context.evaluated_depsgraph_get()
        pb = {p.name: p for p in obj.evaluated_get(dg).pose.bones}
        hrot = pb[hips_bone].matrix.to_3x3().inverted()
        for label, up, fore in sides:
            if up not in pb or fore not in pb:
                out[label].append(None)
                continue
            sh = pb[up].matrix.translation
            el = pb[fore].matrix.translation
            wr = pb[fore].matrix @ _V((0.0, pb[fore].bone.length, 0.0))
            du = hrot @ (el - sh)
            df = hrot @ (wr - el)
            out[label].append(upper_arm_twist_deg(_V((0.0, 0.0, 0.0)), du, du + df))
    return out
