"""Renders for a paint check: front, back, close face (straight and 3/4) -> <prefix>_{front,back,face,face34}.png
(800x800, transparent background).
   blender -b --python bl_paint_check.py -- <file .blend|.glb> <prefix>"""
import math, sys
import bpy
from mathutils import Vector
src, prefix = sys.argv[sys.argv.index("--") + 1:][:2]
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
ms = [o for o in sc.objects if o.type == "MESH" and not o.hide_render]
pts = [o.matrix_world @ Vector(c) for o in ms for c in o.bound_box]
zmax, zmin = max(p.z for p in pts), min(p.z for p in pts)
cx = (max(p.x for p in pts) + min(p.x for p in pts)) / 2
sc.render.engine = "BLENDER_WORKBENCH"
sc.render.film_transparent = True
sc.render.image_settings.color_mode = "RGBA"
sc.render.resolution_x = sc.render.resolution_y = 800
sh = sc.display.shading
sh.light, sh.color_type, sh.show_object_outline, sh.show_specular_highlight = "FLAT", "TEXTURE", False, False
cam = bpy.data.objects.new("c", bpy.data.cameras.new("c")); sc.collection.objects.link(cam); cam.data.type = "ORTHO"; sc.camera = cam
H = zmax - zmin


def shot(name, loc, tgt, ortho):
    cam.data.ortho_scale = ortho
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = "%s_%s.png" % (prefix, name)
    bpy.ops.render.render(write_still=True)


zc = zmax - 0.135 * H / 1.8
shot("front", (cx, -6, zmin + H / 2), (cx, 0, zmin + H / 2), H * 1.14)
shot("back", (cx, 6, zmin + H / 2), (cx, 0, zmin + H / 2), H * 1.14)
shot("face", (cx, -6, zc), (cx, 0, zc), 0.40 * H / 1.8)
a = math.radians(35)
shot("face34", (cx + 6 * math.sin(a), -6 * math.cos(a), zc), (cx, 0, zc), 0.40 * H / 1.8)
print("DONE", round(H, 3), "m")
