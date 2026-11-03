"""Render the model's head from the face_match views (runs inside Blender).

    blender -b --factory-startup --python face_render.py -- <model .blend|.glb> <out folder> <spec.json>

spec.json: {"res": 1600, "frame_frac": 0.28, "center_frac": 0.14,
            "views": [{"name": "front", "yaw": 0, "pitch": 0}, ...]}
  * an orthographic camera, Workbench FLAT + TEXTURE, transparent background, square res x res;
  * the frame centre is the head centre (vertices above zmax - 0.2*H), the height zc = zmax - center_frac*H;
  * the frame side = frame_frac * H (H - the model height); yaw 0 - the front (camera at -Y), +yaw moves
    the camera to +X (the model's left cheek visible), 180 - the back of the head; pitch > 0 - the camera
    above the head;
  * output: raw_<name>.png and raw_info.json (H, zc, centre, frame, cameras).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, out_dir, spec_path = os.path.abspath(argv[0]), os.path.abspath(argv[1]), os.path.abspath(argv[2])
with open(spec_path, "r", encoding="utf-8") as fh:
    spec = json.load(fh)
os.makedirs(out_dir, exist_ok=True)

if src.lower().endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene
for o in list(sc.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
    elif o.type == "ARMATURE":
        o.hide_render = True
    elif o.type == "MESH" and o.hide_render:
        pass
meshes = [o for o in sc.objects if o.type == "MESH" and not o.hide_render]
if not meshes:
    raise SystemExit("no visible meshes in %s" % src)

dg = bpy.context.evaluated_depsgraph_get()
pts = []
for o in meshes:
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ev.matrix_world
    pts.extend(mw @ v.co for v in me.vertices)
    ev.to_mesh_clear()
zmax = max(p.z for p in pts)
zmin = min(p.z for p in pts)
H = zmax - zmin
head = [p for p in pts if p.z > zmax - 0.2 * H]
cx = sum(p.x for p in head) / len(head)
cy = sum(p.y for p in head) / len(head)
zc = zmax - float(spec.get("center_frac", 0.14)) * H
frame = float(spec.get("frame_frac", 0.28)) * H
res = int(spec.get("res", 1600))
# fixed camera (the fix loop): the centre and the frame side from the previous report, so the frame does
# not drift with the geometry (a vertex edit changes zmax and the head centre)
if spec.get("centre") is not None:
    cx, cy, zc = [float(t) for t in spec["centre"]]
if spec.get("frame_m") is not None:
    frame = float(spec["frame_m"])

sc.render.engine = "BLENDER_WORKBENCH"
sc.render.film_transparent = True
sc.render.image_settings.color_mode = "RGBA"
sc.render.image_settings.file_format = "PNG"
sc.render.resolution_x = sc.render.resolution_y = res
sc.render.resolution_percentage = 100
sh = sc.display.shading
sh.light, sh.color_type = "FLAT", "TEXTURE"
sh.show_object_outline = sh.show_specular_highlight = sh.show_shadows = sh.show_cavity = False
sc.display_settings.display_device = "sRGB"
try:
    sc.view_settings.view_transform = "Standard"
except TypeError:
    pass
cam = bpy.data.objects.new("face_match_cam", bpy.data.cameras.new("face_match_cam"))
sc.collection.objects.link(cam)
cam.data.type = "ORTHO"
cam.data.clip_end = 100
sc.camera = cam

info = {"model": src, "H": H, "zmax": zmax, "zmin": zmin, "cx": cx, "cy": cy, "zc": zc, "frame_m": frame, "res": res, "views": {}}
tgt = Vector((cx, cy, zc))
for v in spec["views"]:
    yaw, pitch = math.radians(float(v.get("yaw", 0))), math.radians(float(v.get("pitch", 0)))
    d = 6.0
    loc = tgt + Vector((d * math.sin(yaw) * math.cos(pitch), -d * math.cos(yaw) * math.cos(pitch), d * math.sin(pitch)))
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
    cam.data.ortho_scale = frame
    path = os.path.join(out_dir, "raw_%s.png" % v["name"])
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    info["views"][v["name"]] = {"yaw": float(v.get("yaw", 0)), "pitch": float(v.get("pitch", 0)), "png": path,
                               "px_per_m": res / frame}
with open(os.path.join(out_dir, "raw_info.json"), "w", encoding="utf-8") as fh:
    json.dump(info, fh, ensure_ascii=False, indent=1)
print("FACE_RENDER_OK", json.dumps({"H": round(H, 4), "zc": round(zc, 4), "frame_m": round(frame, 4), "n": len(spec["views"])}))
