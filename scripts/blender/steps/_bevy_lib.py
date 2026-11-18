"""_bevy_lib — helpers for bevy_package (docs/forge/bevy.md, 0.6.10 wave ticket 28).

Pure logic (no bpy): the Bevy passport of a package is a small JSON contract that the
imaginarium_bevy crate reads (ticket 29) - clips with their real GLB animation names, the default
clip to autostart, effect sockets with their parent bone, the collider plan, collision hulls,
fx + fx presets, and the model/scene summary. Every rule that decides WHAT goes into ima_bevy.json
lives here so the step file stays Blender plumbing and the rules are testable in one place.
"""
import json
import re
import struct

PASSPORT_FILE = "ima_bevy.json"
GLB_FILE = "model.glb"
FX_PRESETS_FILE = "fx_presets.json"
FORMAT = "imaginarium-bevy-package/1"

# collision meshes of the model contract (same names the Godot/Unity packers honour):
# COL_* prefixes and *-colonly / *-convcolonly suffixes
COLLISION_RE = re.compile(r"(^COL_|[-_](colonly|convcolonly)$)", re.I)
# a socket name may carry a '*' mask (socket_thruster_*) when the packer should fan it out
MASK_RE = re.compile(r"\*")

# the clip loop contract of §7 (same suffixes the other packers honor, kept local so this
# library imports without bpy - run_tests can poke it directly)
LOOP_SUFFIXES = ("-loop", "_loop", "-cycle", "_cycle")


def clip_base(name):
    """('idle-loop' -> ('idle', True))."""
    low = str(name).lower()
    for suf in LOOP_SUFFIXES:
        if low.endswith(suf):
            return name[:-len(suf)], True
    return name, False


def glb_animations(path):
    """[{name, loop, seconds}] read straight from the GLB's JSON chunk - the names Bevy will
    address these animations by, immune to the '.001' suffixes a re-import gives colliding
    action blocks (a passport that lies about clip names is worse than no passport)."""
    with open(path, "rb") as fh:
        magic, _ver, _total = struct.unpack("<III", fh.read(12))
        if magic != 0x46546C67:                       # 'glTF'
            raise ValueError("not a GLB file: %r" % path)
        clen, _ctype = struct.unpack("<II", fh.read(8))
        doc = json.loads(fh.read(clen).decode("utf-8"))
    accessors = doc.get("accessors") or []
    out = []
    for a in doc.get("animations") or []:
        span = 0.0
        for s in a.get("samplers") or []:
            acc = accessors[s["input"]] if s.get("input") is not None and s["input"] < len(accessors) else {}
            mn, mx = acc.get("min") or [], acc.get("max") or []
            if mn and mx:
                span = max(span, float(mx[0]) - float(mn[0]))
        name = a.get("name") or ""
        base, loop = clip_base(name)
        out.append({"name": name, "loop": bool(loop), "seconds": round(span, 3)})
    return out


def pick_default_clip(clips, requested=None):
    """'' when there are no clips; the requested name when it exists; else idle; else first loop; else first."""
    if not clips:
        return ""
    names = [c["name"] for c in clips]
    if requested:
        if requested in names:
            return requested
        base = [c["name"] for c in clips if c["name"].split("-")[0] == requested.split("-")[0]]
        if base:
            return base[0]
    for want in ("idle", "idle-loop"):
        if want in names:
            return want
    loops = [c["name"] for c in clips if c["loop"]]
    return loops[0] if loops else names[0]


def socket_rows(sockets):
    """Bevy needs name + what bone it hangs off (effects must follow the animation)."""
    rows = []
    for s in sockets:
        rows.append({"name": s["name"], "node": s["node"], "kind": s.get("kind") or "",
                     "parent": s.get("parent") or "", "parent_bone": s.get("parent_bone") or ""})
    return rows


def expand_fx(fx, socket_names):
    """[{preset, socket, params}] with '*' masks fanned over the real socket names (idempotent)."""
    out, seen = [], set()
    for f in fx or []:
        preset = (f or {}).get("preset")
        sock = str((f or {}).get("socket") or "")
        params = (f or {}).get("params") or {}
        if not preset:
            continue
        if MASK_RE.search(sock):
            pat = re.compile("^" + re.escape(sock).replace("\\*", ".*") + "$", re.I)
            for name in socket_names:
                if pat.match(name) and (preset, name) not in seen:
                    seen.add((preset, name))
                    out.append({"preset": preset, "socket": name, "params": dict(params)})
        elif (preset, sock) not in seen:
            seen.add((preset, sock))
            out.append({"preset": preset, "socket": sock, "params": dict(params)})
    return out


def unknown_fx_presets(fx, presets):
    """Preset names the table does not know (the effect would silently not spawn - better to say)."""
    return sorted({f["preset"] for f in fx} - set(presets or {}))


def collision_meshes(object_names):
    return sorted({n for n in object_names if COLLISION_RE.search(n)})


def collider_plan(collider, has_hulls, rigged):
    """Resolve the passport collider: Bevy builds one of these at spawn from the GLB itself."""
    if collider in ("none", "box", "capsule", "mesh"):
        return {"kind": collider}
    # auto: hull meshes in the model win (they are the artist's answer), then rigged - capsule,
    # everything else - a box around the scene bounds. 'hulls' tells the crate to look for the
    # collision_meshes list instead of a generated shape.
    if has_hulls:
        return {"kind": "hulls"}
    return {"kind": "capsule" if rigged else "box"}


def rig_summary(info):
    arms = info.get("armatures")
    n = len(arms) if isinstance(arms, (list, tuple)) else int(arms or 0)
    return {"type": "skinned" if n else "static", "armatures": n, "bones": int(info.get("bones") or 0)}


def build_passport(asset_id, info, *, clips, default_clip, sockets, collider, collision, fx,
                   fx_presets_file, rig, kind):
    """The ima_bevy.json document - exactly the contract keys, in reading order."""
    return {
        "format": FORMAT,
        "asset_id": asset_id,
        "kind": kind or "",
        "glb": GLB_FILE,
        "gltf": None,                       # a single binary GLB is what ships; the key names the alternative
        "clips": clips,
        "default_clip": default_clip,
        "sockets": sockets,
        "collider": collider,
        "collision_meshes": collision,
        "fx": fx,
        "fx_presets": fx_presets_file if fx else None,
        "rig": rig,
        "scene": {"size_gltf_m": info["size_gltf_m"], "longest_m": info["longest_m"],
                  "tris": info["tris"], "meshes": info["meshes"]},
        "checks": [],                       # filled by the step as its build checks run
    }
