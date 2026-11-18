"""_vrm_lib - data and pure mappings for the vrm_package step (0.7.10 fold wave ticket 62).

No bpy, no state: the bone table, the ARKit blendshape facts and the expression matcher, so the
whole surface of this module is unit-testable in the lane without the VRM add-on installed (the
add-on itself is gated by the supply-chain rule until 2026-11-18 08:35:20 UTC - the step that
drives it lives in vrm_package.py).

Provenance of the tables (ADR-0004: published facts, byte-exact where the publisher publishes
them; saved copies in .scratch/imaginarium-1117-0710-fold/):
  * VRM 1.0 humanoid bone names + the Required set - the official VRMC_vrm 1.0 spec,
    specification/VRMC_vrm-1.0/humanoid.md (vrm-c/vrm-specification@master, CC0/MIT docs).
  * The Mixamo -> VRM bone correspondence - the saturday06 VRM Add-on for Blender v4.10.5,
    src/io_scene_vrm/common/human_bone_mapper/mixamo_mapping.py (MIT OR GPL-3.0-or-later):
    Spine1->chest, Spine2->upperChest, Thumb1->metacarpal, Thumb2->proximal, Thumb3->distal,
    the other four fingers {1,2,3}->{proximal,intermediate,distal}; the 4th bone of those four
    fingers has no VRM humanoid slot - the gap is reported, never guessed around.
  * The 52 ARKit blendshape names + the preset->blendshape blends - the same add-on's
    src/io_scene_vrm/common/shape_key_mapper/arkit_mapping.py (the file itself links
    developer.apple.com's ARKit blend shape location list). A preset the character has no key
    for is still wireable when its whole ARKit blend is present - that is how a stock ARKit
    face gets blink, the five vowels and the four ARKit-backed emotions (the fifth preset,
    relaxed, has no blend - a named gap until a key names it), as the 0.7.10 note
    promises; the weights are the publisher's, not invented.
"""
import re

# ---------------------------------------------------------------- VRM 1.0 humanoid bones

# bone name -> required?  (the Required column of VRMC_vrm-1.0/humanoid.md - 15 bones, parsed
# from the live spec AND the byte-identical saved copy 2026-11-17; the shoulders are NOT
# Required - the addon's human_bone.py marks LEFT_SHOULDER/RIGHT_SHOULDER requirement=False,
# matching the spec column, so they map when present but never gate the export)
VRM1_BONES_REQUIRED = {
    "hips": True, "spine": True, "head": True,
    "leftUpperLeg": True, "leftLowerLeg": True, "leftFoot": True,
    "rightUpperLeg": True, "rightLowerLeg": True, "rightFoot": True,
    "leftUpperArm": True, "leftLowerArm": True, "leftHand": True,
    "rightUpperArm": True, "rightLowerArm": True, "rightHand": True,
}
# the optional bones a studio character commonly has (the full spec list minus the required 15;
# VRM 1.0 thumbs are metacarpal/proximal/distal - there is no thumb "intermediate" in this spec)
VRM1_BONES_OPTIONAL = {
    "chest": False, "upperChest": False, "neck": False, "jaw": False,
    "leftShoulder": False, "rightShoulder": False,
    "leftEye": False, "rightEye": False, "leftToes": False, "rightToes": False,
    "leftThumbMetacarpal": False, "leftThumbProximal": False,
    "leftThumbDistal": False, "leftIndexProximal": False, "leftIndexIntermediate": False,
    "leftIndexDistal": False, "leftMiddleProximal": False, "leftMiddleIntermediate": False,
    "leftMiddleDistal": False, "leftRingProximal": False, "leftRingIntermediate": False,
    "leftRingDistal": False, "leftLittleProximal": False, "leftLittleIntermediate": False,
    "leftLittleDistal": False,
    "rightThumbMetacarpal": False, "rightThumbProximal": False,
    "rightThumbDistal": False, "rightIndexProximal": False, "rightIndexIntermediate": False,
    "rightIndexDistal": False, "rightMiddleProximal": False, "rightMiddleIntermediate": False,
    "rightMiddleDistal": False, "rightRingProximal": False, "rightRingIntermediate": False,
    "rightRingDistal": False, "rightLittleProximal": False, "rightLittleIntermediate": False,
    "rightLittleDistal": False,
}
VRM1_BONES = dict(VRM1_BONES_REQUIRED, **VRM1_BONES_OPTIONAL)

# our canonical rig bone (prefix-insensitive, see _anim_lib.map_bone_names) -> VRM 1.0 bone.
# Transcribed from the add-on's published Mixamo mapping with the "mixamorig:" prefixes dropped;
# the mapping is the publisher's, so a rig we built (which names bones mixamorig:*) maps 1:1.
MIXAMO_TO_VRM1 = {
    "Hips": "hips", "Spine": "spine", "Spine1": "chest", "Spine2": "upperChest",
    "Neck": "neck", "Head": "head",
    "LeftShoulder": "leftShoulder", "LeftArm": "leftUpperArm", "LeftForeArm": "leftLowerArm",
    "LeftHand": "leftHand",
    "RightShoulder": "rightShoulder", "RightArm": "rightUpperArm", "RightForeArm": "rightLowerArm",
    "RightHand": "rightHand",
    "LeftUpLeg": "leftUpperLeg", "LeftLeg": "leftLowerLeg", "LeftFoot": "leftFoot",
    "LeftToeBase": "leftToes",
    "RightUpLeg": "rightUpperLeg", "RightLeg": "rightLowerLeg", "RightFoot": "rightFoot",
    "RightToeBase": "rightToes",
}
_FINGER_VRM = {"Thumb": ("ThumbMetacarpal", "ThumbProximal", "ThumbDistal"),   # 1,2,3; no intermediate
               "Index": ("IndexProximal", "IndexIntermediate", "IndexDistal"),
               "Middle": ("MiddleProximal", "MiddleIntermediate", "MiddleDistal"),
               "Ring": ("RingProximal", "RingIntermediate", "RingDistal"),
               "Pinky": ("LittleProximal", "LittleIntermediate", "LittleDistal")}
for _side in ("Left", "Right"):
    for _finger, _vrm3 in _FINGER_VRM.items():
        for _i, _vrm in enumerate(_vrm3):  # Mixamo bones 1..3 (the 4th has no VRM slot)
            MIXAMO_TO_VRM1["%sHand%s%d" % (_side, _finger, _i + 1)] = \
                _side[0].lower() + _side[1:] + _vrm


def _short(bone_name):
    """Strip the mixamo-style prefix: 'mixamorig:Hips' and 'Hips' become the same key."""
    return str(bone_name).split(":")[-1]


def match_human_bones(bone_names):
    """Map an armature's bone names onto VRM 1.0 humanoid bones.

    Returns ({vrm_bone: actual_bone_name}, missing_required). Bones VRM has no slot for are not
    failures - they are simply not reported; a missing REQUIRED bone is (honesty rule: the step
    says what it could not wire instead of exporting a half-rig silently)."""
    by_short = {}
    for n in bone_names:
        by_short.setdefault(_short(n), n)  # the first wins; rigs do not duplicate shorts
    mapped, missing = {}, []
    for short, vrm in MIXAMO_TO_VRM1.items():
        actual = by_short.get(short)
        if actual is not None:
            mapped[vrm] = actual
    for vrm, required in VRM1_BONES_REQUIRED.items():
        if required and vrm not in mapped:
            missing.append(vrm)
    return mapped, sorted(missing)


# ---------------------------------------------------------------- ARKit 52 and the presets

# The ARKit blendshape identifiers are the standard 52 names Apple publishes (the add-on's
# table lists them in Apple's order under four anatomical headings; the same grouping is kept
# here so the table reads by region, with our note on which keys the presets actually need).
ARKIT_52 = (
    # eyes - blink and gaze are the VRM blink / look_* presets; squint and wide are extras
    "eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeSquintLeft",
    "eyeWideLeft", "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight",
    "eyeSquintRight", "eyeWideRight",
    # jaw
    "jawForward", "jawLeft", "jawRight", "jawOpen",
    # mouth - the vowel and emotion blends live here
    "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft", "mouthRight", "mouthSmileLeft",
    "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft",
    "mouthStretchRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthPressLeft",
    "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    # brows, cheeks, nose, tongue
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "noseSneerLeft", "noseSneerRight", "tongueOut",
)

# preset -> ARKit blends, the weights published by the add-on's arkit_mapping.py (the presets
# the table leaves out - neutral, relaxed, ugh/grin family - have no blend: only a direct
# shape key can wire them, and the matcher says so).
PRESET_ARKIT_BLENDS = {
    "happy": [{"mouthSmileLeft": 0.5, "mouthSmileRight": 0.5}],
    "angry": [{"mouthFrownLeft": 0.5, "mouthFrownRight": 0.5}],
    "sad": [{"browDownLeft": 0.25, "browDownRight": 0.25}],
    "surprised": [{"browInnerUp": 0.25, "browOuterUpLeft": 0.25, "browOuterUpRight": 0.25,
                   "jawOpen": 0.25}],
    "aa": [{"jawOpen": 0.5}],
    "ih": [{"jawOpen": 0.2, "mouthStretchLeft": 0.2, "mouthStretchRight": 0.2}],
    "ou": [{"jawOpen": 0.2, "mouthPucker": 0.2}],
    "ee": [{"jawOpen": 0.3, "mouthStretchLeft": 0.3, "mouthStretchRight": 0.3}],
    "oh": [{"jawOpen": 0.3, "mouthPucker": 0.3}],
    "blink": [{"eyeBlinkLeft": 1.0, "eyeBlinkRight": 1.0}],
    "blink_left": [{"eyeBlinkLeft": 1.0}],
    "blink_right": [{"eyeBlinkRight": 1.0}],
    "look_up": [{"eyeLookUpLeft": 1.0, "eyeLookUpRight": 1.0}],
    "look_down": [{"eyeLookDownLeft": 1.0, "eyeLookDownRight": 1.0}],
    "look_left": [{"eyeLookOutLeft": 1.0, "eyeLookInRight": 1.0}],
    "look_right": [{"eyeLookInLeft": 1.0, "eyeLookOutRight": 1.0}],
}
# the presets a VRM avatar should carry when the character can speak and emote at all
# (the note's promise: blink, the vowels and the VRM emotions)
PRESET_PRIORITY = ("blink", "aa", "ih", "ou", "ee", "oh", "happy", "angry", "sad", "relaxed",
                   "surprised")

# a shape key named like a preset (case/underscore/space tolerant) wires it directly
def _preset_key_match(shape_key_lower, preset):
    clean = re.sub(r"[\s_\-.]+", "", shape_key_lower)
    return clean == re.sub(r"[\s_\-.]+", "", preset)


def match_expressions(shape_key_names, wanted=None):
    """Match a character's shape keys onto VRM 1.0 expression presets.

    Returns ({preset: {"direct": shape_key_name} | {"blend": {arkit_key: weight}}}, gaps).
    A preset is wired by a directly-named key first; else by the publisher's ARKit blend when
    EVERY member of the blend exists on the character; else it is a named gap - never a silent
    skip and never an invented weight (honesty rule, the LOD-bands precedent)."""
    want = list(wanted) if wanted else list(PRESET_PRIORITY)
    keys = [str(k) for k in shape_key_names]
    by_lower = {}
    for k in keys:
        by_lower.setdefault(k.lower(), k)

    def actual(name):  # case-tolerant lookup of a published ARKit name on this character
        return by_lower.get(name.lower())

    found, gaps = {}, []
    for preset in want:
        direct = next((k for k in keys if _preset_key_match(k.lower(), preset)), None)
        if direct is not None:
            found[preset] = {"direct": direct}
            continue
        blend = None
        for cand in PRESET_ARKIT_BLENDS.get(preset, []):
            resolved = {c: actual(c) for c in cand}
            if all(v is not None for v in resolved.values()):
                blend = {resolved[c]: w for c, w in cand.items()}
                break
        if blend is not None:
            found[preset] = {"blend": blend}
        else:
            gaps.append(preset)
    return found, gaps
