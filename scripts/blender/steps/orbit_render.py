"""orbit_render — the auto-review orbit (docs/product/autoreview.md, ticket 08).

Flyaround renders of a finished shape: `frames` orthographic Workbench frames at evenly spaced
azimuths around the model's centre, each PNG written into out_dir as orbit_NN.png, plus an
orbit.json manifest (the orbit contract: {"frames":[{"file":"orbit_00.png","yaw_deg":0},…],
"size":px,"elevation_deg":deg}). Alongside the pictures the step reports the PLAIN mesh numbers
(af's mesh_metrics: boundary/non-manifold/wire edges, loose parts, tris) that cap the VLM's
seam score in the studio's decide() — a model never grades topology by taste here.

inputs.mesh: .glb/.gltf/.obj/.stl path; params: frames (4..16, default 8), size px (default 384),
elevation_deg (default 12).
"""
import json
import math
import os
import time

import bpy
import mathutils

import af_common as af
from steps import _mesh_lib as ml


def _frames_count(params):
    try:
        n = int(params.get("frames", 8))
    except (TypeError, ValueError):
        n = 8
    return max(4, min(16, n))


def run(req):
    started = time.time()
    params = req.get("params", {})
    size = int(params.get("size", 384))
    elevation = math.radians(float(params.get("elevation_deg", 12)))
    count = _frames_count(params)

    af.reset_scene()
    objs = af.import_any(req["inputs"]["mesh"])
    stats = ml.mesh_metrics(objs)

    scene = bpy.context.scene
    lo, hi = af.world_bbox(objs)
    centre = (lo + hi) / 2
    extent = max((hi - lo).length, 1e-3)
    cam_data = bpy.data.cameras.new("af_orbit_cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = extent * 1.08
    cam_data.clip_end = extent * 20
    cam = bpy.data.objects.new("af_orbit_cam", cam_data)
    scene.collection.objects.link(cam)
    prev_cam = scene.camera
    scene.camera = cam
    r = scene.render
    af.set_engine(scene, "WORKBENCH")
    r.resolution_x = r.resolution_y = size
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    if r.engine == "BLENDER_WORKBENCH":
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "MATERIAL"
        sh.show_cavity = True
        sh.show_object_outline = False

    manifest = []
    for i in range(count):
        yaw = (math.tau * i) / count
        direction = mathutils.Vector((math.sin(yaw) * math.cos(elevation),
                                      -math.cos(yaw) * math.cos(elevation),
                                      math.sin(elevation))).normalized()
        cam.location = centre + direction * extent * 3
        look = (centre - cam.location).normalized()
        cam.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
        file = af.out_path(req, "orbit_%02d.png" % i)
        r.filepath = file
        bpy.ops.render.render(write_still=True)
        manifest.append({"file": os.path.basename(file), "yaw_deg": round(math.degrees(yaw), 1)})

    orbit = {"frames": manifest, "size": size, "elevation_deg": round(math.degrees(elevation), 1),
             "seconds": round(time.time() - started, 1)}
    with open(af.out_path(req, "orbit.json"), "w", encoding="utf-8") as fh:
        json.dump(orbit, fh, ensure_ascii=False, indent=1)
    scene.camera = prev_cam
    bpy.data.objects.remove(cam)
    bpy.data.cameras.remove(cam_data)
    return {"outputs": {"frames": [af.out_path(req, f["file"]) for f in manifest],
                        "orbit": af.out_path(req, "orbit.json")},
            "stats": stats, "orbit": orbit}
