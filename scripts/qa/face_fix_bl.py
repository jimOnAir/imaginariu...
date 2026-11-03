"""The Blender part of the face_fix executor (run by face_fix.py; can also be run by hand):
  blender -b --factory-startup --python face_fix_bl.py -- export <in.blend|glb> <out.npz> <tex_dir>
      -> npz: V (world), F (triangles), UV (tri,3,2), MAT (tri), zmin/zmax, material names; maps -> <tex_dir>/<material>.png
  blender -b --factory-startup --python face_fix_bl.py -- apply <in.blend> <job.json> <out.blend> <out.glb>
      job.json: {"object": "Body", "disp_npy": "<path|null>", "textures": {"Head": "<png>", ...}, "history": [...]}
      -> vertex shift (world), map replacement (packed), materials OPAQUE + doubleSided, GLB (Body 4096 + Head 2048)
  blender -b --factory-startup --python face_fix_bl.py -- render <blend|glb> <cams.json> <prefix>
      cams.json: {"<name>": {"yaw","pitch","centre":[x,y,z],"ortho_scale","size","distance"}} -> <prefix>_<name>.png (Workbench FLAT TEXTURE)
"""
import json
import math
import os
import struct
import sys

import bpy
import numpy as np
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def open_model(path):
    if path.lower().endswith(".blend"):
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)


def main_mesh(name=None):
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if name:
        for o in objs:
            if o.name == name:
                return o
    return max(objs, key=lambda o: len(o.data.polygons))


def material_image(mat):
    """The material's Base Color image (the Image Texture node wired into the Principled BSDF, else any Image Texture)."""
    if not mat or not mat.use_nodes:
        return None, None
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        for link in nt.links:
            if link.to_node == bsdf and link.to_socket.name == "Base Color" and link.from_node.type == "TEX_IMAGE":
                return link.from_node, link.from_node.image
    for n in nt.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            return n, n.image
    return None, None


def image_to_png(img, path):
    """Save the image as an 8-bit PNG with no colour transforms (byte buffers - as is)."""
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)[::-1]
    if img.is_float:                      # linear buffer -> sRGB
        c = np.clip(a[..., :3], 0, 1)
        c = np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)
        a = np.concatenate([c, a[..., 3:]], axis=2)
    out = bpy.data.images.new("__ff_tmp", w, h, alpha=False)
    out.file_format = "PNG"
    rgb = np.concatenate([a[::-1, :, :3], np.ones((h, w, 1), np.float32)], axis=2).astype(np.float32).ravel()
    out.pixels.foreach_set(rgb)
    out.filepath_raw = path
    out.save()
    bpy.data.images.remove(out)


def cmd_export(src, out_npz, tex_dir):
    open_model(src)
    o = main_mesh()
    me = o.data
    me.calc_loop_triangles()
    mw = o.matrix_world
    nv = len(me.vertices)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(nv, 3).astype(np.float64)
    M = np.array(mw, np.float64)
    V = co @ M[:3, :3].T + M[:3, 3]
    tris = me.loop_triangles
    nt = len(tris)
    F = np.empty(nt * 3, np.int32)
    tris.foreach_get("vertices", F)
    F = F.reshape(nt, 3)
    L = np.empty(nt * 3, np.int32)
    tris.foreach_get("loops", L)
    L = L.reshape(nt, 3)          # loop indices per triangle: UV is per-loop, indexing with F would scramble it
    MAT = np.empty(nt, np.int32)
    tris.foreach_get("material_index", MAT)
    uvl = me.uv_layers.active
    if uvl is None:
        raise RuntimeError("the mesh has no UV layer")
    uv = np.empty(len(uvl.data) * 2, np.float32)
    uvl.data.foreach_get("uv", uv)
    UV = uv.reshape(-1, 2)[L.ravel()].reshape(nt, 3, 2)
    os.makedirs(tex_dir, exist_ok=True)
    mats = []
    for i, m in enumerate(me.materials):
        name = m.name if m else "mat%d" % i
        node, img = material_image(m)
        entry = {"index": i, "name": name, "image": None, "size": None}
        if img is not None and img.size[0]:
            p = os.path.join(tex_dir, "%s.png" % name)
            image_to_png(img, p)
            entry.update({"image": p, "size": list(img.size), "image_name": img.name})
        mats.append(entry)
    hist = []
    if "face_fix_history" in o:
        try:
            hist = json.loads(o["face_fix_history"])
        except Exception:
            hist = []
    np.savez(out_npz, V=V.astype(np.float64), F=F, L=L, UV=UV.astype(np.float32), MAT=MAT,
             meta=json.dumps({"object": o.name, "materials": mats, "zmin": float(V[:, 2].min()),
                              "zmax": float(V[:, 2].max()), "xmin": float(V[:, 0].min()), "xmax": float(V[:, 0].max()),
                              "history": hist, "source": src}, ensure_ascii=False))
    print("FACEFIX_OK export verts %d tris %d mats %s" % (nv, nt, [m["name"] for m in mats]))


def set_material_flags(m):
    m.blend_method = "OPAQUE"
    if hasattr(m, "surface_render_method"):
        m.surface_render_method = "DITHERED"
    m.use_backface_culling = False
    if hasattr(m, "use_backface_culling_shadow"):
        m.use_backface_culling_shadow = False


def cmd_apply(src, job_path, out_blend, out_glb):
    with open(job_path, "r", encoding="utf-8") as fh:
        job = json.load(fh)
    open_model(src)
    o = main_mesh(job.get("object"))
    me = o.data
    moved = 0
    if job.get("disp_npy"):
        disp = np.load(job["disp_npy"]).astype(np.float64)
        if len(disp) != len(me.vertices):
            raise RuntimeError("disp: %d vertices, the mesh has %d" % (len(disp), len(me.vertices)))
        M = np.array(o.matrix_world, np.float64)
        Minv = np.linalg.inv(M[:3, :3])
        local = disp @ Minv.T
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = (co.reshape(-1, 3).astype(np.float64) + local).astype(np.float32)
        me.vertices.foreach_set("co", co.ravel())
        moved = int((np.linalg.norm(disp, axis=1) > 1e-7).sum())
        me.update()
    replaced = []
    for i, m in enumerate(me.materials):
        if not m:
            continue
        p = (job.get("textures") or {}).get(m.name)
        if not p:
            set_material_flags(m)
            continue
        node, old = material_image(m)
        new = bpy.data.images.load(p, check_existing=False)
        new.alpha_mode = "NONE"
        new.pack()
        if old is not None:
            name = old.name
            old.name = name + "_old"
            new.name = name
            if node is not None:
                node.image = new
            if old.users == 0:
                bpy.data.images.remove(old)
        elif node is not None:
            node.image = new
        else:
            m.use_nodes = True
            nt = m.node_tree
            bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = new
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        set_material_flags(m)
        replaced.append(m.name)
    for img in bpy.data.images:
        if img.users and img.size[0] and not img.packed_file:
            img.pack()
    o["face_fix_history"] = json.dumps(job.get("history") or [], ensure_ascii=False)
    for ob in list(bpy.context.scene.objects):
        if ob.type in ("CAMERA", "LIGHT") and ob.name.startswith("__ff"):
            bpy.data.objects.remove(ob)
    bpy.ops.wm.save_as_mainfile(filepath=out_blend)
    bpy.ops.export_scene.gltf(filepath=out_glb, export_format="GLB", export_image_format="AUTO", export_apply=True,
                              export_yup=True, export_materials="EXPORT")
    with open(out_glb, "rb") as f:
        f.read(12)
        ln, _ = struct.unpack("<II", f.read(8))
        g = json.loads(f.read(ln))
    info = {"materials": [(m["name"], bool(m.get("doubleSided")), m.get("alphaMode", "OPAQUE")) for m in g["materials"]],
            "images": len(g.get("images", [])), "primitives": [len(m["primitives"]) for m in g["meshes"]],
            "moved_vertices": moved, "textures_replaced": replaced}
    print("FACEFIX_OK apply " + json.dumps(info, ensure_ascii=False))


def cmd_render(src, cams_path, prefix):
    with open(cams_path, "r", encoding="utf-8") as fh:
        cams = json.load(fh)
    open_model(src)
    sc = bpy.context.scene
    for ob in list(sc.objects):
        if ob.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(ob)
        elif ob.type == "ARMATURE":
            ob.hide_render = True
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.film_transparent = True
    sc.render.image_settings.color_mode = "RGBA"
    try:  # like the checker's face_render.py: without AgX/Filmic, otherwise the before/after render colours are not comparable to the reference
        sc.display_settings.display_device = "sRGB"
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
    except Exception:
        pass
    sh = sc.display.shading
    sh.light, sh.color_type, sh.show_object_outline, sh.show_specular_highlight = "FLAT", "TEXTURE", False, False
    sh.show_backface_culling = False
    cam = bpy.data.objects.new("__ff_cam", bpy.data.cameras.new("__ff_cam"))
    sc.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.clip_end = 100
    sc.camera = cam
    for name, c in cams.items():
        a, e = math.radians(c["yaw"]), math.radians(c.get("pitch", 0.0))
        d = Vector((-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), -math.sin(e)))
        tgt = Vector(c["centre"])
        loc = tgt - d * float(c.get("distance", 6.0))
        sc.render.resolution_x = sc.render.resolution_y = int(c.get("size", 800))
        cam.data.ortho_scale = float(c["ortho_scale"])
        cam.location = loc
        cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = "%s_%s.png" % (prefix, name)
        bpy.ops.render.render(write_still=True)
    print("FACEFIX_OK render %d" % len(cams))


if __name__ == "__main__":
    if not ARGS:
        raise SystemExit(__doc__)
    cmd = ARGS[0]
    if cmd == "export":
        cmd_export(*ARGS[1:4])
    elif cmd == "apply":
        cmd_apply(*ARGS[1:5])
    elif cmd == "render":
        cmd_render(*ARGS[1:4])
    else:
        raise SystemExit("unknown command: " + cmd)
