"""render_sprites — sprite sheets of an (animated) model: 8-direction isometric (iso8) or custom views.

inputs.mesh  animated GLB/FBX/... (or inputs.blend, opened by af_run.py)
inputs.manifest  optional asset.json: kind ship/prop/turret/... sets forward '+Y'
params (all optional):
  profile        'iso8' (default) | 'custom' | 'pixel' (iso8 render + pixel-art post-process,
                 see "pixel profile" below)
  asset_id       snake_case id used for file names / registry snippets (default: input file name, made
                 snake_case with an 'a_' prefix when it starts with a digit)
  forward        '-Y' (default: characters/creatures, contract §4) | '+Y' (ships, props, turrets; default
                 when inputs.manifest kind says so): '+Y' adds 180 deg to every view yaw so S shows the nose
  clips          'all' (default) or [names]; names may be the base name ('idle') or the action name
  clip_names     {action name: clip name} renames
  loop           {clip: bool} overrides ('-loop'/'_loop' suffix and idle/walk/run imply looping)
  frames         int or {clip: int}; default = clip duration x fps (capped by max_frames=48)
  fps            default 12
  ranges         {clip: [start, end]} in frames at ranges_fps (default: the scene fps)
  in_place       'auto' (loops: remove net root drift; one-shots: keep) | 'lock' (hips XY fixed to
                 the first frame) | 'drift' | 'none'
  pixels_per_meter  default 100 (fixed scale: same for every clip/asset of the profile)
  elevation_deg  default 30 (2:1 isometric)
  directions     iso8 subset of S,SW,W,NW,N,NE,E,SE; custom and pixel: [[name, model_yaw_deg], ...]
  padding_px     iso8 cell padding around the max extent of all frames/clips/directions (default 6)
  cell, anchor   force a fixed cell [w, h] and anchor [x, y]
  height_m       rescale the model to this height; center 'feet' (default) | 'none';
                 normalize_pose 'rest' (default) | 'first_frame' (measure on the first sample of the first clip)
  grade_materials  roughness >= 0.55, metallic <= 0.6, saturation x1.1 (default false)
  engine         'EEVEE' (default) | 'CYCLES' | 'WORKBENCH'; samples
  shadow         Cycles shadow catcher on the ground (default false; EEVEE: unsupported); the auto cell
                 includes the projected shadow footprint
  grade          colour grade (default false); shadow_alpha_max, shadow_edge_fade_px
                 (default 0; 16 with shadow and a forced cell, 4 with shadow and an auto cell), alpha_floor (default 6)
  cols           frames per sheet row (default: one row per direction when it fits max_sheet_px, else
                 balanced rows)
  max_sheet_px   soft sheet side limit (default 8192): iso8 stacks all directions in <clip>.png and switches to
                 per-direction sheets <clip>_<DIR>.png when the stack is taller; > 16384 px is an error
  max_cell_px    default 2048: a larger cell side is an error (wrong units?) raised before rendering
  min_body_px    default 24: a smaller projected body (max of width/height) is an error before rendering
  validate_godot load the SpriteFrames .tres in headless Godot 4.5.1 (default true when found)
  keep_frames    keep the raw per-frame renders (default false)
pixel profile (profile 'pixel'; the geometry is iso8 in FINAL pixels, the post-process is scripts/pixel/pixelize.py):
  pixels_per_meter  default 24 (a 2 m figure ~ 42 px tall at elevation 30); directions default S,SW,W,NW,N,NE,E,SE;
                 8 frames per clip, fps 8; engine EEVEE with 1 sample and film filter 0 (no antialiasing),
                 no shadows (no ground catcher, lights without shadows; self_shadow true switches the light
                 shadows back on), no colour grade; padding_px 4, min_body_px 16
  supersample    1 (default) | 2..4: render k times larger and reduce by the block average (premultiplied),
                 then quantise; downscale  1 (default) | 2..8: render k times larger and reduce by nearest
                 (centre sample of the block); give one of them; `cell`/`anchor` are in final pixels
  palette        'auto' (default: median cut over ALL frames of the asset, so colours do not flicker between
                 frames) | path to .png / .gpl (GIMP) / .hex | 'none' (no quantisation)
  colors         auto palette size, default 32 (with an outline one colour is reserved for it when the body
                 has no dark enough colour)
  dither         false (default) | true: ordered Bayer 4x4 by cell coordinates (same pattern in every frame);
                 dither_strength 0.5
  outline        'none' (default) | 'dark' (darkest palette colour) | 'auto' (the neighbouring body colour
                 darkened to the nearest darker palette colour): 1 px outside the body, 4-neighbourhood
  levels         true (default): stretch the brightness of ALL frames together (percentiles 2..98 -> 14..240,
                 the hue is kept) before the palette; dark dull textures otherwise give a muddy palette;
                 saturation  1.2 (1 = off): the same for all frames
  alpha_threshold  128: alpha >= threshold -> 255, otherwise 0 (no translucent edges)
  preview_zoom   4: preview.png is enlarged by nearest neighbour
  Extra outputs: palette (palette.png, one pixel per colour), palette_gpl; checks pixel_palette_only and
  pixel_alpha_binary. The Godot sprites must be shown with texture_filter Nearest.
outputs: sheets (PNG per clip, per clip and direction when large),
sprites_json (rects, root_px hips and feet_px/feet_mid_px ground pivots per frame), spriteframes (.tres),
preview, preview_frames, godot_check (log/json).
"""
import json
import math
import os
import shutil
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

import af_common as af
from steps import _export_lib as xl

PIXEL_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pixel"))


def _pixelize():
    """scripts/pixel/pixelize.py (numpy only, shared with the CLI and pixel_gen.mjs)."""
    if PIXEL_DIR not in sys.path:
        sys.path.insert(0, PIXEL_DIR)
    import pixelize
    return pixelize


# --------------------------------------------------------------------------- configuration

def _forward(p, inputs):
    """Model forward axis: params.forward, else inputs.manifest kind (ships/props/turrets +Y), else -Y."""
    if p.get("forward"):
        f = str(p["forward"]).upper()
        if f not in ("-Y", "+Y"):
            raise ValueError("params.forward must be '-Y' or '+Y': %r" % p["forward"])
        return f, "params.forward"
    if inputs.get("manifest"):
        with open(inputs["manifest"], "r", encoding="utf-8-sig") as fh:
            kind = json.load(fh).get("kind")
        if kind:
            return ("+Y" if kind in xl.SHIP_KINDS else "-Y"), "manifest kind %s" % kind
    return "-Y", "default (characters face -Y)"


def _wrap_deg(a):
    a = (float(a) + 180.0) % 360.0 - 180.0
    return 180.0 if a == -180.0 else a


def _pixel_config(p, warnings):
    """Parameters of the pixel post-process (profile 'pixel'); validated before anything is rendered."""
    px = _pixelize()
    sup, down = int(p.get("supersample", 1)), int(p.get("downscale", 1))
    if not 1 <= sup <= 4:
        raise ValueError("params.supersample must be 1..4: %r" % p.get("supersample"))
    if down < 1 or down > 8:
        raise ValueError("params.downscale must be 1..8: %r" % p.get("downscale"))
    if sup > 1 and down > 1:
        raise ValueError("pixel profile: give params.supersample (block average) or params.downscale (nearest), "
                         "not both")
    outline = str(p.get("outline", "none")).lower()
    if outline not in px.OUTLINES:
        raise ValueError("params.outline must be none, dark or auto: %r" % p.get("outline"))
    palette = p.get("palette", "auto")
    palette = "auto" if palette in (None, True) else palette
    if isinstance(palette, str) and palette.lower() in ("auto", "none"):
        palette = palette.lower()
    elif isinstance(palette, str):
        px.load_palette(palette)        # fail now, not after the render
    else:
        raise ValueError("params.palette must be 'auto', 'none' or a path to .png/.gpl/.hex: %r" % (palette,))
    colors = int(p.get("colors", 32))
    if not 2 <= colors <= 256:
        raise ValueError("params.colors must be 2..256: %r" % p.get("colors"))
    if p.get("shadow"):
        warnings.append("pixel profile: params.shadow is ignored (a translucent ground shadow cannot be pixel art)")
    return {"k": max(sup, down), "mode": "nearest" if down > 1 else "box", "supersample": sup, "downscale": down,
            "palette": palette, "colors": colors, "dither": bool(p.get("dither", False)),
            "dither_strength": float(p.get("dither_strength", 0.5)), "outline": outline,
            "saturation": float(p.get("saturation", 1.2)), "levels": bool(p.get("levels", True)),
            "alpha_threshold": int(p.get("alpha_threshold", 128)), "self_shadow": bool(p.get("self_shadow", False)),
            "preview_zoom": max(1, int(p.get("preview_zoom", 4)))}


def _pixel_render_setup(scene, made, pix):
    """No antialiasing and (by default) no shadows: every rendered pixel is either body or background."""
    try:
        scene.render.filter_size = 0.0
    except Exception:
        pass
    try:
        scene.display.render_aa = "OFF"          # Workbench
    except Exception:
        pass
    if not pix["self_shadow"]:
        try:
            scene.eevee.use_shadows = False
        except Exception:
            pass
        for o in made:
            if getattr(o, "type", None) == "LIGHT":
                try:
                    o.data.use_shadow = False
                except Exception:
                    pass


def _palette_bar(palette, width, sw=16):
    """Palette swatches (sw x sw px, wrapped to `width`) for the preview, on white."""
    per_row = max(1, (width - 8) // sw)
    rows = int(math.ceil(len(palette) / float(per_row)))
    bar = np.full((rows * sw + 8, width, 4), 255, np.uint8)
    for i, c in enumerate(palette):
        r, k = divmod(i, per_row)
        bar[4 + r * sw:4 + (r + 1) * sw - 1, 4 + k * sw:4 + (k + 1) * sw - 1, :3] = c
        bar[4 + r * sw:4 + (r + 1) * sw - 1, 4 + k * sw:4 + (k + 1) * sw - 1, 3] = 255
    return bar


def _config(p, forward="-Y"):
    profile = p.get("profile", "iso8")
    if profile not in ("iso8", "custom", "pixel"):
        raise ValueError("params.profile must be iso8, custom or pixel: %r" % profile)
    cfg = {"profile": profile, "warnings": [], "forward": forward}
    if profile in ("custom", "pixel") and p.get("directions") and isinstance(p["directions"][0], (list, tuple)):
        views = [(str(n), float(y), "_" + str(n)) for n, y in p["directions"]]
    else:
        names = p.get("directions") or [n for n, _ in xl.ISO8]
        table = dict(xl.ISO8)
        bad = [n for n in names if n not in table]
        if bad:
            raise ValueError("unknown directions %s (use S,SW,W,NW,N,NE,E,SE)" % bad)
        views = [(n, table[n], "_" + n) for n in names]
    pixel = profile == "pixel"
    cfg.update(ppm=float(p.get("pixels_per_meter", 24.0 if pixel else 100.0)),
               elevation=float(p.get("elevation_deg", 30.0)), views=views,
               cell=tuple(p["cell"]) if p.get("cell") else None,
               anchor=tuple(p["anchor"]) if p.get("anchor") else None,
               cols=p.get("cols"), fps=float(p.get("fps", 8 if pixel else 12)),
               engine=p.get("engine", "EEVEE"), samples=p.get("samples", 1 if pixel else None),
               shadow=bool(p.get("shadow", False)) and not pixel, grade=bool(p.get("grade", False)) and not pixel,
               margin=0, padding=int(p.get("padding_px", 4 if pixel else 6)))
    if pixel:
        cfg["pixel"] = _pixel_config(p, cfg["warnings"])
        if not float(cfg["ppm"]).is_integer():
            cfg["warnings"].append("pixel profile: pixels_per_meter %g is not an integer, the sprite will not "
                                   "sit on the pixel grid evenly" % cfg["ppm"])
    if cfg["cell"] and not cfg["anchor"]:
        raise ValueError("params.cell needs params.anchor")
    if cfg["shadow"] and str(cfg["engine"]).upper() != "CYCLES":
        cfg["warnings"].append("shadow catcher needs engine CYCLES; rendering without ground shadow")
        cfg["shadow"] = False
    if forward == "+Y":
        # nose at +Y (ships, props): turn every view by 180 deg so S still shows the front
        cfg["views"] = [(n, _wrap_deg(y + 180.0), suf) for n, y, suf in cfg["views"]]
    cfg["alpha_floor"] = int(p.get("alpha_floor", xl.ALPHA_FLOOR))
    cfg["shadow_alpha_max"] = float(p.get("shadow_alpha_max", 0.0))
    # auto cells include the shadow footprint (fade 4 px only removes the faint 1 px line Cycles
    # leaves on the frame border, alpha ~10); a forced cell may cut the shadow, so fade it over 16 px
    fade_default = 0
    if cfg["shadow"]:
        fade_default = 16 if cfg["cell"] else 4
    cfg["shadow_edge_fade_px"] = int(p.get("shadow_edge_fade_px", fade_default))
    cfg["max_cell_px"] = int(p.get("max_cell_px", 2048))
    cfg["min_body_px"] = float(p.get("min_body_px", 16 if profile == "pixel" else 24))
    cfg["max_sheet_px"] = int(p.get("max_sheet_px", xl.SHEET_MAX_PX))
    return cfg


def _clip_count(cfg, p, name, duration_s, loop):
    frames = p.get("frames")
    if isinstance(frames, dict) and name in frames:
        return max(1, int(frames[name]))
    if isinstance(frames, (int, float)) and not isinstance(frames, bool):
        return max(1, int(frames))
    if cfg["profile"] == "pixel":
        return 8            # pixel profile: 8 frames per clip (a loop of 8 frames at fps 8 = 1 s)
    n = int(round(duration_s * cfg["fps"])) + (0 if loop else 1)
    return max(1, min(n, int(p.get("max_frames", 48))))


# --------------------------------------------------------------------------- scene preparation

def _prepare_scene(req):
    inputs = req["inputs"]
    if not inputs.get("blend"):
        if not inputs.get("mesh"):
            raise ValueError("inputs.mesh or inputs.blend is required")
        af.reset_scene()
        af.import_any(inputs["mesh"])
    scene = bpy.context.scene
    for o in scene.objects:
        if o.type in ("CAMERA", "LIGHT"):
            o.hide_render = True
    arms = [o for o in scene.objects if o.type == "ARMATURE"]
    meshes = xl.render_meshes()
    if not meshes:
        raise RuntimeError("no renderable meshes in the input")
    root = bpy.data.objects.new("AF_SPRITE_ROOT", None)
    scene.collection.objects.link(root)
    for o in list(scene.objects):
        if o is root or o.parent is not None or o.type in ("CAMERA", "LIGHT"):
            continue
        if any(getattr(c, "target", None) is not None for c in o.constraints):
            continue
        mw = o.matrix_world.copy()
        o.parent = root
        o.matrix_world = mw
    bpy.context.view_layer.update()
    return scene, root, arms, meshes


def _rest_points(arms, meshes):
    xl.bind_cloth_cache(None)       # cloth_sim caches off: the rest pose is the skinned bind pose
    saved = [(a, a.data.pose_position) for a in arms]
    for a in arms:
        a.data.pose_position = "REST"
    bpy.context.view_layer.update()
    pts = xl.world_points(meshes)
    for a, pos in saved:
        a.data.pose_position = pos
    bpy.context.view_layer.update()
    return pts


def _pose_points(arms, meshes, pose, first_clip):
    """Vertices in the rest pose, or on the first sample of the first clip (measures the model in
    whatever pose the import left active)."""
    if pose == "first_frame" and first_clip is not None:
        _bind(first_clip, arms)
        xl.set_time(first_clip["times"][0])
        return xl.world_points(meshes)
    return _rest_points(arms, meshes)


def _normalize(p, cfg, root, arms, meshes, first_clip):
    pose = p.get("normalize_pose", "rest")
    if pose not in ("rest", "first_frame"):
        raise ValueError("params.normalize_pose must be rest or first_frame: %r" % pose)
    info = {"scale": 1.0, "offset_m": [0.0, 0.0, 0.0], "pose": pose}
    pts = _pose_points(arms, meshes, pose, first_clip)
    if not len(pts):
        return info
    height = float(pts[:, 2].max() - pts[:, 2].min())
    info["height_in_m"] = round(height, 4)
    if p.get("height_m") and height > 1e-6:
        s = float(p["height_m"]) / height
        root.scale = (s, s, s)
        bpy.context.view_layer.update()
        pts = _pose_points(arms, meshes, pose, first_clip)
        info["scale"] = round(s, 6)
    if p.get("center", "feet") == "feet":
        # support centre = middle of the lowest 12 % of vertices
        zmin, zmax = pts[:, 2].min(), pts[:, 2].max()
        floor = zmin + (zmax - zmin) * 0.12
        feet = pts[pts[:, 2] <= floor]
        if not len(feet):
            feet = pts
        off = Vector((-float(feet[:, 0].mean()), -float(feet[:, 1].mean()), -float(zmin)))
        root.location = root.location + off
        bpy.context.view_layer.update()
        info["offset_m"] = [round(v, 4) for v in off]
    final = _pose_points(arms, meshes, pose, first_clip)
    info["height_m"] = round(float(np.ptp(final[:, 2])), 4) if len(final) else 0.0
    rest = _rest_points(arms, meshes)
    info["rest_height_m"] = round(float(np.ptp(rest[:, 2])), 4) if len(rest) else 0.0
    return info


def _foot_bones(arm):
    names = arm.data.bones.keys()
    out = [n for n in ("mixamorig:LeftFoot", "mixamorig:RightFoot", "LeftFoot", "RightFoot") if n in names]
    if not out:
        out = [n for n in names if "foot" in n.lower() or n.lower().startswith("paw_")][:4]
    return out


def _collect_clips(cfg, p, scene, arms):
    src_fps = scene.render.fps / (scene.render.fps_base or 1.0)
    found = xl.find_clips(arms)
    renames = p.get("clip_names", {})
    want = p.get("clips", "all")
    if isinstance(want, str) and want != "all":
        want = [want]
    loops = p.get("loop", {})
    ranges = p.get("ranges", {})
    ranges_fps = float(p.get("ranges_fps", src_fps))
    clips = []
    for c in found:
        action_name = c["name"]
        base, suffix_loop = xl.clip_base(renames.get(action_name, action_name))
        base = xl.safe_name(base)
        if want != "all" and base not in want and action_name not in want:
            continue
        loop = suffix_loop or base in xl.LOOPING
        if base in loops:
            loop = bool(loops[base])
        start, end = c["range"]
        if base in ranges:
            k = src_fps / ranges_fps
            start, end = float(ranges[base][0]) * k, float(ranges[base][1]) * k
        duration = max((end - start) / src_fps, 1e-6)
        count = _clip_count(cfg, p, base, duration, loop)
        times = xl.sample_times(start, end, count, loop)
        fps = cfg["fps"]
        clips.append({"name": base, "action": action_name, "actions": c["actions"], "loop": loop,
                      "range": [round(start, 4), round(end, 4)], "source_fps": src_fps,
                      "duration_s": round(duration, 4), "count": count, "times": times, "fps": fps,
                      "time_scale": round((count / float(fps)) / duration, 4) if loop else
                      round(((count - 1) / float(fps)) / duration, 4) if count > 1 else 1.0})
    if want != "all":
        missing = [w for w in want if not any(w in (c["name"], c["action"]) for c in clips)]
        if missing:
            raise ValueError("clips not found: %s (have: %s)" % (missing, [c["name"] for c in found]))
    names = [c["name"] for c in clips]
    if len(set(names)) != len(names):
        raise ValueError("duplicate clip names after suffix stripping: %s; use params.clip_names" % names)
    return clips


def _bind(clip, arms):
    for a in arms:
        act = clip["actions"].get(a.name) if clip else None
        if act is not None:
            xl.assign_action(a, act)
        elif a.animation_data is not None:
            a.animation_data.action = None
    # cloth_sim caches: the simulated cloth of this clip plays together with its armature action
    xl.bind_cloth_cache(clip["actions"] if clip else None)


def _in_place_offsets(cfg, p, clip, arms, root, base_loc):
    """Per-sample XY offset (world metres) to subtract from the root for in-place playback."""
    mode = p.get("in_place", "auto")
    if mode not in ("auto", "lock", "drift", "none"):
        raise ValueError("params.in_place must be auto, lock, drift or none: %r" % mode)
    if mode == "auto":
        mode = "drift" if clip["loop"] else "none"
    arm = next((a for a in arms if a.name in clip["actions"]), None)
    bone = xl.root_bone(arm) if arm else None
    n = len(clip["times"])
    if mode == "none" or bone is None:
        return [(0.0, 0.0)] * n, ("none" if bone is None and mode != "none" else mode), bone

    def hips_at(t):
        xl.set_time(t)
        root.location = base_loc
        bpy.context.view_layer.update()
        hp = arm.matrix_world @ arm.pose.bones[bone].head
        return float(hp.x), float(hp.y)

    pos = [hips_at(t) for t in clip["times"]]
    if mode == "lock":
        x0, y0 = pos[0]
        return [(x - x0, y - y0) for x, y in pos], mode, bone
    if mode == "drift":
        start, end = clip["range"]
        xs, ys = hips_at(start)
        xe, ye = hips_at(end)
        span = max(end - start, 1e-6)
        return [((xe - xs) * (t - start) / span, (ye - ys) * (t - start) / span) for t in clip["times"]], \
            mode, bone
    raise ValueError("params.in_place must be auto, lock, drift or none: %r" % mode)


# --------------------------------------------------------------------------- main

def run(req):
    t_start = time.time()
    p = req["params"]
    forward, forward_from = _forward(p, req["inputs"])
    cfg = _config(p, forward)
    warnings = list(cfg["warnings"])
    checks = []
    src_name = os.path.splitext(os.path.basename(req["inputs"].get("mesh") or req["inputs"].get("blend") or ""))[0]
    if p.get("asset_id"):
        asset_id = p["asset_id"]
        if not xl.ASSET_ID_RE.match(asset_id):
            raise ValueError("asset_id must be snake_case ASCII: %r" % asset_id)
    else:
        asset_id, id_warn = xl.default_asset_id(src_name)
        if id_warn:
            warnings.append(id_warn)
    scene, root, arms, meshes = _prepare_scene(req)
    clips = _collect_clips(cfg, p, scene, arms)
    norm = _normalize(p, cfg, root, arms, meshes, clips[0] if clips else None)
    rest_h = norm.get("rest_height_m") or norm.get("height_m") or 0.0
    if not p.get("height_m") and not 0.3 <= rest_h <= 15.0:
        warnings.append("model is %.4g m tall at rest: outside 0.3..15 m, probably centimetres/millimetres or "
                        "studio units; pass params.height_m (e.g. 1.8 for a human)" % rest_h)
    base_loc = root.location.copy()
    if p.get("grade_materials", False):
        norm["graded_materials"] = xl.grade_materials(meshes)
    if not clips:
        warnings.append("no armature clips found: rendering one static frame")
        clips = [{"name": "static", "action": None, "actions": {}, "loop": False, "range": [scene.frame_current] * 2,
                  "source_fps": scene.render.fps, "duration_s": 0.0, "count": 1,
                  "times": [float(scene.frame_current)], "fps": cfg["fps"],
                  "time_scale": 1.0}]
    feet = {a.name: _foot_bones(a) for a in arms}
    af.log("clips", clips=[(c["name"], c["count"], c["loop"]) for c in clips], views=[v[0] for v in cfg["views"]])

    # ---- pass 1: in-place offsets and projected extents of every sample in every view
    ppm, elev = cfg["ppm"], cfg["elevation"]
    bases = [xl.view_basis(elev, -math.radians(yaw)) for _, yaw, _ in cfg["views"]]
    auto_cell = not cfg["cell"]
    # the auto cell must also hold the ground shadow (Cycles catcher): cast vertices along the sun
    sun_dirs = [xl.sun_to_light(-math.radians(yaw)) for _, yaw, _ in cfg["views"]] \
        if (cfg["shadow"] and auto_cell) else None
    ext = {"xmin": 0.0, "xmax": 0.0, "ymin": 0.0, "ymax": 0.0}
    shadow_ext = dict(ext)
    per_clip_minz = {}
    max_extent_m = 0.5
    body_px = 0.0
    for clip in clips:
        _bind(clip, arms)
        offs, mode, bone = _in_place_offsets(cfg, p, clip, arms, root, base_loc)
        clip["offsets"], clip["in_place"], clip["root_bone"] = offs, mode, bone
        clip["bounds"] = [[None] * len(clip["times"]) for _ in cfg["views"]]
        clip["root_ground"] = []
        minz = []
        for ti, t in enumerate(clip["times"]):
            xl.set_time(t)
            root.location = base_loc - Vector((offs[ti][0], offs[ti][1], 0.0))
            bpy.context.view_layer.update()
            pts = xl.world_points(meshes)
            minz.append(float(pts[:, 2].min()))
            max_extent_m = max(max_extent_m, float(np.abs(pts).max()))
            hips = None
            arm = next((a for a in arms if a.name in clip["actions"]), arms[0] if arms else None)
            if arm is not None and bone:
                hp = arm.matrix_world @ arm.pose.bones[bone].head
                hips = [float(hp.x), float(hp.y)]
            fpos = []
            if arm is not None:
                clip["feet_bones"] = feet.get(arm.name, [])
                for fb in clip["feet_bones"]:
                    fp = arm.matrix_world @ arm.pose.bones[fb].head
                    fpos.append([float(fp.x), float(fp.y)])
            clip["root_ground"].append({"hips": hips, "feet": fpos})
            for vi, (right, up) in enumerate(bases):
                x = pts @ right * ppm
                y = -(pts @ up) * ppm
                b = [float(x.min()), float(y.min()), float(x.max()), float(y.max())]
                clip["bounds"][vi][ti] = b
                body_px = max(body_px, b[2] - b[0], b[3] - b[1])
                ext["xmin"] = min(ext["xmin"], b[0])
                ext["ymin"] = min(ext["ymin"], b[1])
                ext["xmax"] = max(ext["xmax"], b[2])
                ext["ymax"] = max(ext["ymax"], b[3])
                if sun_dirs is not None:
                    g = xl.shadow_ground(pts, sun_dirs[vi])
                    sx = g @ right * ppm
                    sy = -(g @ up) * ppm
                    shadow_ext["xmin"] = min(shadow_ext["xmin"], float(sx.min()))
                    shadow_ext["ymin"] = min(shadow_ext["ymin"], float(sy.min()))
                    shadow_ext["xmax"] = max(shadow_ext["xmax"], float(sx.max()))
                    shadow_ext["ymax"] = max(shadow_ext["ymax"], float(sy.max()))
        per_clip_minz[clip["name"]] = minz

    # ---- cell
    margin = cfg["margin"]

    def overflow(cw_, ch_, ax_, ay_):
        worst_ = 0.0
        for clip_ in clips:
            for vi_ in range(len(cfg["views"])):
                for b in clip_["bounds"][vi_]:
                    worst_ = max(worst_, margin - (ax_ + b[0]), margin - (ay_ + b[1]), (ax_ + b[2]) - (cw_ - margin),
                                 (ay_ + b[3]) - (ch_ - margin))
        return worst_
    if cfg["cell"]:
        cw, ch = int(cfg["cell"][0]), int(cfg["cell"][1])
        ax, ay = float(cfg["anchor"][0]), float(cfg["anchor"][1])
    else:
        pad = cfg["padding"]
        full = dict(ext)
        if sun_dirs is not None:
            # the soft penumbra and the sky-occlusion halo around the contact spread ~0.3 m past the hard
            # footprint on the ground (x: full metres, y: foreshortened by the elevation)
            sx_m, sy_m = 0.3 * ppm, 0.3 * ppm * math.sin(math.radians(elev))
            full = {"xmin": min(ext["xmin"], shadow_ext["xmin"] - sx_m),
                    "ymin": min(ext["ymin"], shadow_ext["ymin"] - sy_m),
                    "xmax": max(ext["xmax"], shadow_ext["xmax"] + sx_m),
                    "ymax": max(ext["ymax"], shadow_ext["ymax"] + sy_m)}
        half = int(math.ceil(max(-full["xmin"], full["xmax"]))) + pad
        cw = 2 * half
        cw += (-cw) % 4
        top = int(math.ceil(-full["ymin"])) + pad
        bottom = int(math.ceil(full["ymax"])) + pad
        ch = top + bottom
        ch += (-ch) % 4
        ax, ay = cw / 2.0, float(top)
    anchor = (ax, ay)
    worst = overflow(cw, ch, ax, ay)
    checks.append(af.check("cell_fit", worst <= 0.01, round(worst, 2), 0,
                           note="px of model outside the cell (margin %d px), evaluated vertices" % margin))
    af.log("cell", cell=[cw, ch], anchor=anchor, ppm=ppm, body_px=round(body_px, 1))

    # ---- size guards (before any GPU work): wrong units give 1 px blobs or 17000 px frames
    hint = ("model %.4g m tall at rest, %g px/m; fix the units with params.height_m or change pixels_per_meter"
            % (rest_h, ppm))
    if max(cw, ch) > cfg["max_cell_px"]:
        raise ValueError("sprite cell %dx%d px exceeds max_cell_px=%d (%s; or raise params.max_cell_px)"
                         % (cw, ch, cfg["max_cell_px"], hint))
    if body_px < cfg["min_body_px"]:
        raise ValueError("projected model is only %.1f px (min_body_px=%g; %s)" % (body_px, cfg["min_body_px"], hint))
    if not auto_cell and worst > 0.5 * min(cw, ch):
        raise ValueError("model overflows the fixed %dx%d cell by %.0f px (%s)" % (cw, ch, worst, hint))
    checks.append(af.check("sprite_size_sane", True, {"cell": [cw, ch], "body_px": round(body_px, 1)},
                           {"max_cell_px": cfg["max_cell_px"], "min_body_px": cfg["min_body_px"]}))
    sheet_px = {}
    for clip in clips:
        lay = xl.sheet_layout(clip["count"], cw, ch, len(cfg["views"]), cols=cfg["cols"],
                              max_side=cfg["max_sheet_px"])
        clip["layout"] = lay
        sheet_px[clip["name"]] = lay["sheet"]
        if lay["over_soft"]:
            warnings.append("clip %s: sheet %dx%d px is over max_sheet_px=%d (still under Godot's %d)"
                            % (clip["name"], lay["sheet"][0], lay["sheet"][1], cfg["max_sheet_px"],
                               xl.GODOT_TEXTURE_MAX))
    checks.append(af.check("sheet_size", max(max(s) for s in sheet_px.values()) <= xl.GODOT_TEXTURE_MAX,
                           sheet_px, xl.GODOT_TEXTURE_MAX, note="px per sheet side (per-direction sheets when large)"))

    # ---- stage (pixel profile: rendered K times larger, reduced to the cell after the render)
    pix = cfg.get("pixel")
    px = _pixelize() if pix else None
    K = pix["k"] if pix else 1
    if K > 1 and max(cw, ch) * K > 8192:
        raise ValueError("pixel profile: render size %dx%d px (cell %dx%d x %d) is over 8192; lower supersample/"
                         "downscale or the scale" % (cw * K, ch * K, cw, ch, K))
    engine, device = xl.set_engine(scene, cfg["engine"], cfg["samples"])
    xl.setup_output(scene, cw * K, ch * K, fps=clips[0]["fps"])
    light_scale = max(1.0, max_extent_m / 1.2)
    rig, cam, made, rim = xl.build_camera_rig(scene, cw * K, ch * K, (ax * K, ay * K), ppm * K, elev,
                                              extent_m=max_extent_m, light_scale=light_scale)
    if pix:
        _pixel_render_setup(scene, made, pix)
    if cfg["shadow"]:
        made += xl.shadow_catcher(scene, rim, rig, size=max(8.0, max_extent_m * 6.0))

    # ---- pass 2: render
    frames_dir = af.out_path(req, "_frames")
    if os.path.isdir(frames_dir):
        shutil.rmtree(frames_dir, ignore_errors=True)
    t_render = time.time()
    n_frames = 0
    for clip in clips:
        _bind(clip, arms)
        clip["frame_files"] = [[None] * clip["count"] for _ in cfg["views"]]
        for ti, t in enumerate(clip["times"]):
            xl.set_time(t)
            off = clip["offsets"][ti]
            root.location = base_loc - Vector((off[0], off[1], 0.0))
            for vi, (vname, yaw, _suf) in enumerate(cfg["views"]):
                rig.rotation_euler.z = -math.radians(yaw)
                bpy.context.view_layer.update()
                path = os.path.join(frames_dir, clip["name"], vname, "f%03d.png" % ti)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                scene.render.filepath = path
                bpy.ops.render.render(write_still=True)
                clip["frame_files"][vi][ti] = path
                n_frames += 1
        af.log("rendered", clip=clip["name"], frames=clip["count"] * len(cfg["views"]))
    render_s = round(time.time() - t_render, 2)

    # ---- pack sheets
    sheets = {}
    meta_clips = {}
    tres_textures = {}
    tres_anims = []
    pixel_fail = []
    scale_samples = []      # rendered body height / height predicted from the vertices at ppm, top offset
    residue = 0
    lum_by_view = {}
    preview_cells, preview_labels = [], []
    strip_cells, strip_labels = [], []
    pixel_pal, pixel_frames, pixel_bad_color, pixel_bad_alpha = None, {}, 0, 0
    if pix:
        # pass 1 of the post-process: reduce to the cell and binarise alpha for EVERY frame, then one palette for
        # the whole asset (per-frame palettes would make colours flicker between frames)
        for clip in clips:
            for vi in range(len(cfg["views"])):
                for ti in range(clip["count"]):
                    img = xl.load_png(clip["frame_files"][vi][ti])
                    img = px.binarize_alpha(px.reduce_block(img, K, pix["mode"]), pix["alpha_threshold"])
                    pixel_frames[(clip["name"], vi, ti)] = img
        keys = list(pixel_frames)
        toned = px.tone([pixel_frames[k] for k in keys], pix["saturation"], pix["levels"])
        pixel_frames = dict(zip(keys, toned))
        if pix["palette"] == "auto":
            pixel_pal = px.auto_palette(list(pixel_frames.values()), pix["colors"], pix["outline"])
        elif pix["palette"] == "none":
            pixel_pal = px.opaque_colors(list(pixel_frames.values()))[0]
        else:
            pixel_pal = px.load_palette(pix["palette"])
        if not len(pixel_pal):
            raise RuntimeError("pixel profile: no opaque pixels in any frame, nothing to build a palette from")
    for clip in clips:
        n = clip["count"]
        lay = clip["layout"]
        cols, rows_per_view = lay["cols"], lay["rows"]
        processed = []
        for vi in range(len(cfg["views"])):
            row = []
            for ti in range(n):
                if pix:
                    img = pixel_frames.pop((clip["name"], vi, ti))
                    if img.shape[0] != ch or img.shape[1] != cw:
                        raise RuntimeError("frame size %s != cell %sx%s" % (img.shape, cw, ch))
                    if pix["palette"] != "none":
                        img = px.quantize(img, pixel_pal, pix["dither"], pix["dither_strength"])
                    sup = xl.pixel_support(img)         # the body without its outline measures the scale
                    img = px.add_outline(img, pixel_pal, pix["outline"])
                    bad_c, bad_a = px.palette_violations(img, pixel_pal)
                    pixel_bad_color += bad_c
                    pixel_bad_alpha += bad_a
                    sup_border = xl.pixel_support(img)
                else:
                    img = xl.load_png(clip["frame_files"][vi][ti])
                    if img.shape[0] != ch or img.shape[1] != cw:
                        raise RuntimeError("frame size %s != cell %sx%s" % (img.shape, cw, ch))
                    if cfg["shadow"] and cfg["shadow_alpha_max"]:
                        img = xl.clamp_shadow(img, cfg["shadow_alpha_max"])
                    if cfg["shadow"] and cfg["shadow_edge_fade_px"]:
                        img = xl.fade_shadow_edges(img, cfg["shadow_edge_fade_px"])
                    if cfg["grade"]:
                        img = xl.grade(img)
                    img = xl.clean_alpha(img, cfg["alpha_floor"])
                    sup = sup_border = xl.pixel_support(img)
                residue += int(((img[..., 3] > 0) & (img[..., 3] < cfg["alpha_floor"])).sum())
                if sup_border["body_pixels"] == 0 or sup_border["body_border_2px_pixels"]:
                    pixel_fail.append([clip["name"], cfg["views"][vi][0], ti, sup_border])
                bb, pb = sup.get("body_bounds_px"), clip["bounds"][vi][ti]
                if bb is not None and pb[3] - pb[1] >= (20 if pix else 40):
                    scale_samples.append((bb[3] - bb[1] + 1, pb[3] - pb[1], bb[1] - (ay + pb[1])))
                row.append(img)
            processed.append(row)
        entry = {"action": clip["action"], "loop": clip["loop"], "fps": clip["fps"], "frames": n,
                 "source_range": clip["range"], "source_fps": clip["source_fps"],
                 "source_duration_s": clip["duration_s"], "time_scale": clip["time_scale"],
                 "in_place": clip["in_place"], "root_bone": clip["root_bone"], "cols": cols,
                 "layout": lay["layout"], "feet_bones": clip.get("feet_bones", []), "views": {}}
        for vi, (vname, yaw, suf) in enumerate(cfg["views"]):
            if lay["layout"] == "per_view":
                # large: idle_S.png ... idle_SE.png
                fname = "%s%s.png" % (clip["name"], suf)
                sheet = np.zeros((rows_per_view * ch, cols * cw, 4), np.uint8)
                y_base = 0
            else:
                fname = "%s.png" % clip["name"]
                if fname not in sheets:
                    sheets[fname] = np.zeros((len(cfg["views"]) * rows_per_view * ch, cols * cw, 4), np.uint8)
                sheet = sheets[fname]
                y_base = vi * rows_per_view * ch
            rects, roots, feet_px, feet_mid = [], [], [], []
            right, up = bases[vi]

            def to_px(xy):
                pt = np.array([xy[0], xy[1], 0.0])
                return [round(ax + float(pt @ right) * ppm, 1), round(ay - float(pt @ up) * ppm, 1)]
            for ti in range(n):
                x = (ti % cols) * cw
                y = y_base + (ti // cols) * ch
                sheet[y:y + ch, x:x + cw] = processed[vi][ti]
                rects.append([x, y, cw, ch])
                rg = clip["root_ground"][ti]
                if rg["hips"] is not None:
                    roots.append(to_px(rg["hips"]))
                if rg["feet"]:
                    fp = [to_px(f) for f in rg["feet"]]
                    feet_px.append(fp)
                    feet_mid.append([round(sum(f[0] for f in fp) / len(fp), 1),
                                     round(sum(f[1] for f in fp) / len(fp), 1)])
            if lay["layout"] == "per_view":
                sheets[fname] = sheet
            anim_name = "%s_%s" % (clip["name"], vname)
            entry["views"][vname] = {"sheet": fname, "model_yaw_deg": yaw, "animation": anim_name,
                                     "rects": rects, "root_px": roots}
            if feet_px:
                entry["views"][vname]["feet_px"] = feet_px
                entry["views"][vname]["feet_mid_px"] = feet_mid
            tres_textures[fname] = fname
            tres_anims.append({"name": anim_name, "loop": clip["loop"], "speed": clip["fps"],
                               "frames": [(fname, r[0], r[1], r[2], r[3]) for r in rects]})
            f0 = processed[vi][0]
            m = xl.body_mask(f0)
            if m.any():
                lum = xl._l_channel(f0[..., :3])[m].mean()
                lum_by_view.setdefault(vname, []).append(float(lum))
            preview_cells.append(f0)
            preview_labels.append("%s %s" % (clip["name"], vname))
            if vi == 0:
                for ti in range(n):
                    strip_cells.append(processed[vi][ti])
                    strip_labels.append("%s %d" % (clip["name"], ti))
        meta_clips[clip["name"]] = entry

    sheet_paths = {}
    for fname, arr in sheets.items():
        sheet_paths[fname] = xl.save_png(af.out_path(req, fname), arr)

    # ---- checks
    checks.append(af.check("frames_rendered", n_frames == sum(c["count"] for c in clips) * len(cfg["views"]),
                           n_frames))
    checks.append(af.check("frames_body_inside_cell", not pixel_fail, len(pixel_fail), 0,
                           note="empty frames or body pixels within 2 px of the cell border"))
    body_scale = None
    if scale_samples:
        # frames whose projection is at least 40 px tall (below that 1-2 px of antialiasing is several percent)
        ratio = float(np.median([r / p for r, p, _ in scale_samples]))
        diff = float(np.median([r - p for r, p, _ in scale_samples]))
        h_med = float(np.median([p for _, p, _ in scale_samples]))
        top_off = float(np.median([o for _, _, o in scale_samples]))
        body_scale = {"px_per_m": round(ppm * ratio, 2), "expected": ppm, "anchor_top_offset_px": round(top_off, 1),
                      "height_diff_px": round(diff, 2), "frames": len(scale_samples)}
        want = ppm
        tol_px = max(0.03 * h_med, 2.5)
        # pixel art: a thin spear tip or banner pole thinner than a pixel disappears without antialiasing, so the
        # rendered body is legitimately shorter than the vertex projection: only a warning there
        checks.append(af.check("body_scale_px_per_m", abs(diff) <= tol_px and abs(top_off) <= 3.0,
                               body_scale, want, severity="warning" if pix else "error",
                               note="rendered body height / height of the vertex projection at the "
                               "profile scale (median over all frames; must stay %g px/m whatever the cell) and the "
                               "rendered top vs the projection through the anchor (px); tolerance 3 %% of the height or 2.5 px" % want))
    checks.append(af.check("alpha_residue_px", residue == 0, residue, 0,
                           note="pixels with 0 < alpha < alpha_floor after cleanup"))
    if pix:
        checks.append(af.check("pixel_palette_only", pixel_bad_color == 0, pixel_bad_color, 0,
                               note="distinct colours of visible pixels (all frames, with the outline) that are not "
                                    "in the palette (%d colours)" % len(pixel_pal)))
        checks.append(af.check("pixel_alpha_binary", pixel_bad_alpha == 0, pixel_bad_alpha, 0,
                               note="pixels with alpha other than 0 or 255 (no translucent edges)"))
    ground = {}
    for clip in clips:
        mz = per_clip_minz[clip["name"]]
        ground[clip["name"]] = [round(min(mz), 3), round(max(mz), 3)]
        if clip["loop"] and clip["name"] != "static":
            ok = abs(float(np.median(mz))) <= 0.05
            checks.append(af.check("feet_on_ground_%s" % clip["name"], ok, ground[clip["name"]], [-0.05, 0.05],
                                   severity="warning", note="min z of the deformed mesh per frame, m"))
    root_dev = {}
    for clip in clips:
        dev = [math.hypot(rx - ax, ry - ay) for v in meta_clips[clip["name"]]["views"].values()
               for rx, ry in v["root_px"]]
        if dev:
            root_dev[clip["name"]] = round(max(dev), 1)
    if lum_by_view:
        means = {k: round(sum(v) / len(v), 1) for k, v in lum_by_view.items()}
        spread = max(means.values()) / max(min(means.values()), 1e-3)
        checks.append(af.check("lighting_spread", spread <= 1.6, round(spread, 3), 1.6, severity="warning",
                               note="max/min mean luminance of body pixels across views (front vs back "
                                    "albedo differs legitimately)"))
    else:
        means = {}
    # ---- documents
    godot_offset = [cw / 2.0 - ax, ch / 2.0 - ay]
    doc = {"format": "astraforge-sprites/1", "asset_id": asset_id, "profile": cfg["profile"],
           "projection": "orthographic", "px_per_meter": ppm, "elevation_deg": elev,
           "cell": [cw, ch], "anchor": [ax, ay], "pivot_note": "anchor = projected world origin "
           "(ground point under the character after feet centering); root_px = projected hips ground point; "
           "feet_px = projected ground points of the foot bones (feet_bones order), feet_mid_px = their middle",
           "godot_offset": godot_offset, "engine": engine, "device": device, "shadow": cfg["shadow"],
           "forward": cfg["forward"], "forward_from": forward_from,
           "views": [{"name": n, "model_yaw_deg": y} for n, y, _ in cfg["views"]],
           "normalization": norm, "clips": meta_clips, "sheets": sorted(sheet_paths)}
    pixel_info = None
    if pix:
        pixel_info = {"palette": [px.hex_of(c) for c in pixel_pal], "colors": int(len(pixel_pal)),
                      "palette_source": pix["palette"] if pix["palette"] in ("auto", "none") else "file",
                      "outline": pix["outline"], "dither": pix["dither"], "alpha_threshold": pix["alpha_threshold"],
                      "supersample": pix["supersample"], "downscale": pix["downscale"], "reduce": pix["mode"],
                      "render_scale": K, "texture_filter": "nearest"}
        doc["pixel"] = pixel_info
    tres_path = af.out_path(req, "%s_frames.tres" % asset_id)
    xl.write_spriteframes(tres_path, tres_textures, tres_anims)
    outputs = {"sheets": sheet_paths, "spriteframes": tres_path}
    if pix:
        outputs["palette"] = px.write_png(af.out_path(req, "palette.png"), px.palette_strip(pixel_pal))
        gpl_path = af.out_path(req, "palette.gpl")
        with open(gpl_path, "w", encoding="utf-8") as fh:
            fh.write(px.palette_gpl(pixel_pal, asset_id))
        outputs["palette_gpl"] = gpl_path
    sprites_path = af.out_path(req, "sprites.json")
    with open(sprites_path, "w", encoding="utf-8") as fh:
        json.dump(af._jsonable(doc), fh, ensure_ascii=False, indent=1)
    outputs["sprites_json"] = sprites_path

    # ---- previews
    title = "%s %s %dPX/M %dDEG CELL %dX%d" % (asset_id, cfg["profile"], ppm, elev, cw, ch)
    if pix:
        # the preview of pixel art is enlarged by nearest neighbour (never box-filtered), with the palette below
        z = pix["preview_zoom"]

        def zoom(cells):
            return [None if c is None else np.repeat(np.repeat(c, z, axis=0), z, axis=1) for c in cells]
        pv = xl.tile_preview(zoom(preview_cells), min(len(cfg["views"]), 4), cw * z, ch * z, labels=preview_labels,
                             anchor=(ax * z, ay * z), title=title + " X%d" % z)
        pv = np.concatenate([pv, _palette_bar(pixel_pal, pv.shape[1])], axis=0)
        outputs["preview"] = xl.save_png(af.out_path(req, "preview.png"), pv)
        cols_strip = max(1, min(len(strip_cells), 8, max(2, 1600 // (cw * z))))
        ps = xl.tile_preview(zoom(strip_cells), cols_strip, cw * z, ch * z, labels=strip_labels,
                             anchor=(ax * z, ay * z), title="%s frames view %s X%d" % (asset_id, cfg["views"][0][0], z))
        outputs["preview_frames"] = xl.save_png(af.out_path(req, "preview_frames.png"), ps)
    else:
        pv = xl.tile_preview(preview_cells, len(cfg["views"]), cw, ch, labels=preview_labels, anchor=anchor,
                             title=title)
        outputs["preview"] = xl.save_png(af.out_path(req, "preview.png"), xl.downscale(pv, 1280))
        cols_strip = max(1, min(len(strip_cells), 12, max(4, 1280 // cw)))
        ps = xl.tile_preview(strip_cells, cols_strip, cw, ch, labels=strip_labels, anchor=anchor,
                             title="%s frames view %s" % (asset_id, cfg["views"][0][0]))
        outputs["preview_frames"] = xl.save_png(af.out_path(req, "preview_frames.png"), xl.downscale(ps, 1280))

    # ---- Godot SpriteFrames check
    exe = xl.find_godot(p)
    gcheck = None
    if p.get("validate_godot", True):
        if exe is None:
            warnings.append("Godot 4.5.1 not found: SpriteFrames not validated")
            checks.append(af.check("godot_spriteframes", False, "godot missing", severity="warning"))
        else:
            proj = xl.make_check_project(af.out_path(req, "_godot_check"))
            dst = os.path.join(proj, "sprites", asset_id)
            os.makedirs(dst, exist_ok=True)
            for fname, path in sheet_paths.items():
                shutil.copy2(path, os.path.join(dst, fname))
            shutil.copy2(tres_path, os.path.join(dst, os.path.basename(tres_path)))
            expect = {a["name"]: {"frames": len(a["frames"]), "loop": a["loop"], "speed": a["speed"]}
                      for a in tres_anims}
            config = {"sprite_frames": [{"path": "res://sprites/%s/%s" % (asset_id, os.path.basename(tres_path)),
                                         "expect": expect, "cell": [cw, ch]}]}
            gcheck = xl.godot_validate(exe, proj, config)
            res = gcheck.get("result") or {}
            sf = (res.get("sprite_frames") or [{}])[0]
            ok = bool(res) and sf.get("loaded") and not sf.get("mismatches")
            checks.append(af.check("godot_spriteframes", ok, {"animations": sf.get("animation_count"),
                                                               "mismatches": sf.get("mismatches"),
                                                               "engine_errors": len(gcheck["engine_errors"]),
                                                               "godot": gcheck.get("godot_version")},
                                   note="headless Godot 4.5.1 loads the .tres, frame counts/loop/speed match"))
            checks.append(af.check("godot_engine_errors", not gcheck["engine_errors"], gcheck["engine_errors"][:8],
                                   [], severity="warning"))
            gpath = af.out_path(req, "godot_check.json")
            with open(gpath, "w", encoding="utf-8") as fh:
                json.dump(gcheck, fh, ensure_ascii=False, indent=1)
            outputs["godot_check"] = gpath
    if not p.get("keep_frames", False):
        shutil.rmtree(frames_dir, ignore_errors=True)
    else:
        outputs["frames_dir"] = frames_dir

    for o in made:
        if o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
    stats = {"profile": cfg["profile"], "asset_id": asset_id, "engine": engine, "device": device,
             "cell": [cw, ch], "anchor": [ax, ay], "px_per_meter": ppm, "elevation_deg": elev,
             "views": [v[0] for v in cfg["views"]], "frames_rendered": n_frames, "render_seconds": render_s,
             "seconds_per_frame": round(render_s / max(n_frames, 1), 3),
             "clips": {c["name"]: {"frames": c["count"], "loop": c["loop"], "fps": c["fps"],
                                   "in_place": c["in_place"], "time_scale": c["time_scale"]} for c in clips},
             "min_z_per_clip_m": ground, "body_luminance_by_view": means, "normalization": norm,
             "root_ground_max_dev_px": root_dev,
             "total_seconds": round(time.time() - t_start, 2), "forward": cfg["forward"],
             "body_px": round(body_px, 1), "sheet_px": sheet_px,
             "body_scale": body_scale, "pixel": pixel_info,
             "sheet_bytes": {k: os.path.getsize(v) for k, v in sheet_paths.items()}}
    return {"outputs": outputs, "stats": stats, "checks": checks, "warnings": warnings,
            "godot": (gcheck or {}).get("result")}
