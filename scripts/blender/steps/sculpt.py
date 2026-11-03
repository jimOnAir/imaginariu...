"""sculpt — sculpting operations on a mesh without a window: the moves of the sculpt brushes as
repeatable, masked operations (bmesh + numpy + modifiers; bpy.ops.sculpt is not used because it
needs a viewport). Called from the pipeline and from MCP tools (`sculpt`, `sculpt_transfer`).

inputs.blend (preferred: sockets, the rig and the clips stay exactly as they are) or inputs.mesh
(.glb/.gltf/.fbx/.obj/.stl/.blend). The model is NOT normalised: coordinates stay as Blender
imported them (metres, Z up, front = -Y; for a rig - the rest/bind pose), so `region` coordinates
are the ones a `cleanup` / `inspect` report shows.

params:
  ops             list of operations applied in order (required). Every entry is
                  {"op": name, "region": {...}, "symmetry": ..., ...op parameters}
  symmetry        'x' | 'y' | 'z' | 'none' (default 'none'): the mask and the operation are also
                  applied mirrored; an operation may override it with its own "symmetry"
  keep_uv         default true: existing UV layers must survive. `remesh` is then refused when the
                  model has UVs (voxel/quad remesh cannot keep them - pass keep_uv:false and bake a
                  colour with `cleanup` instead); `subdivide` interpolates UVs, `decimate` keeps them
  preserve_rig    default true: armatures, bones, clips and skin weights survive (after `remesh`
                  and `symmetrize` the weights are rebuilt); false drops the rig
  objects         names of the meshes to work on (default: every model mesh)
  shade_auto_smooth_deg  40 (like cleanup): touched meshes get their custom normals cleared and
                  re-derived (smooth by angle); null = clear them, keep the smooth flags
  tolerance_m     distance limit of the transfer check (default 0.01 * model size)
  preview, preview_size   before|after sheet (front + three-quarter), default true / 512

region (the mask of an operation; default {"type": "all"}):
  {"type": "all"}
  {"type": "sphere", "center": [x,y,z], "radius": r, "falloff": "smooth"}
  {"type": "box", "center": [x,y,z], "extents": [hx,hy,hz] (half sizes) | h, "feather": 0.3,
                  "falloff": "smooth"}
  {"type": "vertex_group", "name": g, "falloff": "linear"}   the weight of the group
  {"type": "bone", "name": b, "children": false, "radius": r}  weights of the bone's group (and of
                  its descendants); a mesh without that group falls back to the distance to the
                  bone segment (radius, default half the bone length)
  falloff: 'smooth' (smoothstep, default) | 'linear' | 'sharp' ((1-t)^2, peaked) | 'constant';
  "invert": true takes 1 - weight. Weights are 0..1 and scale the operation per vertex.

operations (point ops move vertices and keep the topology; metres):
  smooth       iterations (5), factor (0.5), pin_boundary (true): Laplacian smoothing
  relax        iterations (5), factor (0.5), keep_volume (true), pin_boundary (true): Taubin
               smoothing + a volume correction along the normals (closed meshes) - no shrink
  inflate      amount: along the vertex normal by `amount` m at weight 1
  deflate      amount: the same inwards
  flatten      strength (1), iterations (1), plane {point, normal} (default: the best-fit plane of
               the region)
  pinch        amount (0.3): towards the centre (default the region centroid); radial (false):
               move in 3D instead of along the surface
  expand       the same away from the centre
  grab         offset [x,y,z]: shift the region (the weight decays with the falloff)
  transfer     source (OBJ/GLB path) | source_asset (studio asset UUID), method 'project'
               (default: along the normal, nearest point for misses) | 'nearest', strength (1),
               align 'auto' (default) | 'none' | 'bbox', seam_smooth (2): copy the shape of another
               mesh (e.g. the one returned by the Sculpt tab) onto this one; UVs, weights and the
               rig stay
topology ops:
  remesh       mode 'voxel' (default) | 'quad', voxel_size (m; default 0.0033 * model height),
               target_faces (quad), adaptivity (0): whole meshes only; UVs are dropped (see
               keep_uv); skin weights come back through a data transfer from the original
  subdivide    cuts (1), threshold (0.5): split the edges whose both ends carry weight >= threshold
  decimate     ratio (0..1): the region keeps `ratio` of its triangles (outside it changes little)
  symmetrize   axis ('x'), direction '+' (copy the + side onto the - side) | '-': cut at the world
               plane and mirror; the mirrored half gets mirrored skin weights (L<->R groups)

outputs: glb (sculpt.glb), mesh (the same file), blend (sculpt.blend), preview (preview.png).
stats: before / after metrics, per-op log (covered points, moved vertices, max shift, seconds),
transfer distances, timings.
checks (error): sculpt_manifold (no new boundary / non-manifold edges in the welded view),
  no_nan_verts, sculpt_uv_kept (keep_uv), sculpt_rig_kept (preserve_rig);
  (warning): sculpt_changed (the ops moved something), sculpt_symmetric (after symmetrize or with
  symmetry), transfer_max_dist_m, transfer_mean_dist_m.
"""
import math
import os
import re
import time

import bmesh
import bpy
import mathutils
import numpy as np

import af_common as af
from steps import _mesh_lib as ml

POINT_OPS = ("smooth", "relax", "inflate", "deflate", "flatten", "pinch", "expand", "grab",
             "transfer")
TOPO_OPS = ("remesh", "subdivide", "decimate", "symmetrize")
ALL_OPS = POINT_OPS + TOPO_OPS
REGION_TYPES = ("all", "sphere", "box", "vertex_group", "bone")
FALLOFFS = ("smooth", "linear", "sharp", "constant")
AXES = {"x": 0, "y": 1, "z": 2}
EPS = 1e-9


# --------------------------------------------------------------------------- operation list

def _vec3(v, what):
    if not (isinstance(v, (list, tuple)) and len(v) == 3
            and all(isinstance(x, (int, float)) and math.isfinite(x) for x in v)):
        raise ValueError("%s must be [x, y, z] in metres" % what)
    return [float(x) for x in v]


def _norm_region(r, where):
    if r is None:
        r = {"type": "all"}
    if not isinstance(r, dict):
        raise ValueError("%s.region must be an object {type: ...}" % where)
    r = dict(r)
    typ = str(r.get("type", "all")).lower()
    if typ not in REGION_TYPES:
        raise ValueError("%s.region.type must be one of %s" % (where, ", ".join(REGION_TYPES)))
    r["type"] = typ
    fo = str(r.get("falloff", "smooth")).lower()
    if fo not in FALLOFFS:
        raise ValueError("%s.region.falloff must be one of %s" % (where, ", ".join(FALLOFFS)))
    r["falloff"] = fo
    r["invert"] = bool(r.get("invert", False))
    if typ == "sphere":
        r["center"] = _vec3(r.get("center"), where + ".region.center")
        if not (isinstance(r.get("radius"), (int, float)) and r["radius"] > 0):
            raise ValueError("%s.region.radius must be a positive number" % where)
        r["radius"] = float(r["radius"])
    elif typ == "box":
        r["center"] = _vec3(r.get("center"), where + ".region.center")
        ext = r.get("extents", r.get("h"))
        if isinstance(ext, (int, float)):
            ext = [ext, ext, ext]
        ext = _vec3(ext, where + ".region.extents")
        if min(ext) <= 0:
            raise ValueError("%s.region.extents must be positive" % where)
        r["extents"] = ext
        r["feather"] = min(1.0, max(0.0, float(r.get("feather", 0.3))))
    elif typ in ("vertex_group", "bone"):
        if not (isinstance(r.get("name"), str) and r["name"]):
            raise ValueError("%s.region.name (%s name) is required" % (where, typ))
    return r


def _num(op, key, default, lo, hi, where):
    v = op.get(key, default)
    if v is None:
        return default
    if isinstance(v, bool) or not (isinstance(v, (int, float)) and math.isfinite(v)):
        raise ValueError("%s.%s must be a number" % (where, key))
    if v < lo or v > hi:
        raise ValueError("%s.%s must be within %s..%s" % (where, key, lo, hi))
    return float(v) if isinstance(default, float) else v


def parse_ops(ops, default_symmetry):
    """Validate and complete the operation list; raises ValueError before any heavy work."""
    if not isinstance(ops, list) or not ops:
        raise ValueError("params.ops must be a non-empty list of {op, region, ...}")
    out = []
    for i, raw in enumerate(ops):
        if not isinstance(raw, dict):
            raise ValueError("ops[%d] must be an object" % i)
        name = str(raw.get("op", "")).lower()
        where = "ops[%d] (%s)" % (i, name or "?")
        if name not in ALL_OPS:
            raise ValueError("%s: unknown op; use one of %s" % (where, ", ".join(ALL_OPS)))
        op = dict(raw)
        op["op"] = name
        op["region"] = _norm_region(raw.get("region"), where)
        sym = str(raw.get("symmetry", default_symmetry) or "none").lower()
        if sym not in ("x", "y", "z", "none"):
            raise ValueError("%s.symmetry must be 'x' | 'y' | 'z' | 'none'" % where)
        op["symmetry"] = sym
        if name in ("smooth", "relax"):
            op["iterations"] = int(_num(op, "iterations", 5, 1, 200, where))
            op["factor"] = _num(op, "factor", 0.5, 0.0, 1.0, where)
            op["pin_boundary"] = bool(op.get("pin_boundary", True))
            op["keep_volume"] = bool(op.get("keep_volume", True))
        elif name in ("inflate", "deflate"):
            if "amount" not in op:
                raise ValueError("%s.amount (metres) is required" % where)
            op["amount"] = _num(op, "amount", 0.0, -10.0, 10.0, where)
        elif name == "flatten":
            op["strength"] = _num(op, "strength", 1.0, 0.0, 1.0, where)
            op["iterations"] = int(_num(op, "iterations", 1, 1, 50, where))
            if op.get("plane") is not None:
                pl = op["plane"]
                if not isinstance(pl, dict):
                    raise ValueError("%s.plane must be {point, normal}" % where)
                op["plane"] = {"point": _vec3(pl.get("point"), where + ".plane.point"),
                               "normal": _vec3(pl.get("normal"), where + ".plane.normal")}
                if not any(abs(x) > 1e-12 for x in op["plane"]["normal"]):
                    raise ValueError("%s.plane.normal must not be zero" % where)
        elif name in ("pinch", "expand"):
            op["amount"] = _num(op, "amount", 0.3, 0.0, 1.0, where)
            op["radial"] = bool(op.get("radial", False))
            if op.get("center") is not None:
                op["center"] = _vec3(op["center"], where + ".center")
        elif name == "grab":
            op["offset"] = _vec3(op.get("offset"), where + ".offset")
        elif name == "transfer":
            if not (op.get("source") or op.get("source_asset")):
                raise ValueError("%s: source (OBJ/GLB path) or source_asset is required" % where)
            op["method"] = str(op.get("method", "project")).lower()
            if op["method"] == "nearest_project":
                op["method"] = "project"
            if op["method"] not in ("project", "nearest"):
                raise ValueError("%s.method must be 'project' or 'nearest'" % where)
            op["strength"] = _num(op, "strength", 1.0, 0.0, 1.0, where)
            op["seam_smooth"] = int(_num(op, "seam_smooth", 2, 0, 50, where))
            op["align"] = str(op.get("align", "auto")).lower()
            if op["align"] not in ("auto", "none", "bbox"):
                raise ValueError("%s.align must be 'auto' | 'none' | 'bbox'" % where)
        elif name == "remesh":
            op["mode"] = str(op.get("mode", "voxel")).lower()
            if op["mode"] not in ("voxel", "quad"):
                raise ValueError("%s.mode must be 'voxel' or 'quad'" % where)
            if op.get("voxel_size") is not None:
                op["voxel_size"] = _num(op, "voxel_size", 0.01, 1e-5, 10.0, where)
            if op.get("target_faces") is not None:
                op["target_faces"] = int(_num(op, "target_faces", 5000, 100, 2000000, where))
            op["adaptivity"] = _num(op, "adaptivity", 0.0, 0.0, 1.0, where)
        elif name == "subdivide":
            op["cuts"] = int(_num(op, "cuts", 1, 1, 3, where))
            op["threshold"] = _num(op, "threshold", 0.5, 0.0, 1.0, where)
        elif name == "decimate":
            if "ratio" not in op:
                raise ValueError("%s.ratio (0..1) is required" % where)
            op["ratio"] = _num(op, "ratio", 0.5, 0.01, 1.0, where)
        elif name == "symmetrize":
            ax = str(op.get("axis", "x")).lower()
            if ax not in AXES:
                raise ValueError("%s.axis must be 'x' | 'y' | 'z'" % where)
            op["axis"] = ax
            op["direction"] = str(op.get("direction", "+"))
            if op["direction"] not in ("+", "-"):
                raise ValueError("%s.direction must be '+' (copy + onto -) or '-'" % where)
        out.append(op)
    return out


# --------------------------------------------------------------------------- welded surface

class Surface:
    """A numpy view of one mesh object in WORLD space with split vertices welded.

    glTF import splits vertices along UV seams and hard edges; moving such copies independently
    would tear the mesh open. Everything here works on canonical points (coincident positions
    share one) and writes the displacement back to every copy."""

    def __init__(self, ob, tol_rel=1e-6):
        self.ob = ob
        me = ob.data
        n = len(me.vertices)
        mw = np.array(ob.matrix_world, dtype=np.float64)
        self.A, self.t = mw[:3, :3], mw[:3, 3]
        det = float(np.linalg.det(self.A))
        if abs(det) < 1e-12:
            raise ValueError("object %s has a singular transform" % ob.name)
        self.Ainv = np.linalg.inv(self.A)
        self.flip = det < 0
        self.n = n
        co = np.empty(n * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        self.world = co.reshape(n, 3) @ self.A.T + self.t
        size = float((self.world.max(axis=0) - self.world.min(axis=0)).max()) if n else 1.0
        self.size = max(size, 1e-6)
        tol = max(self.size * tol_rel, 1e-9)
        q = np.round(self.world / tol).astype(np.int64)
        _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
        self.canon = inv.reshape(-1)
        self.m = int(len(first))
        self.P = self.world[first].copy()
        self.P0 = self.P.copy()
        # triangles over canonical points
        me.calc_loop_triangles()
        nt = len(me.loop_triangles)
        tri = np.empty(nt * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", tri)
        T = self.canon[tri.reshape(-1, 3)]
        ok = (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])
        self.T = T[ok]
        # canonical edges with their face counts (a loop of a face lies on one edge)
        ne = len(me.edges)
        ev = np.empty(ne * 2, dtype=np.int64)
        me.edges.foreach_get("vertices", ev)
        ce = self.canon[ev.reshape(-1, 2)]
        le = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("edge_index", le)
        efc = np.bincount(le, minlength=ne) if ne else np.zeros(0, dtype=np.int64)
        a, b = np.minimum(ce[:, 0], ce[:, 1]), np.maximum(ce[:, 0], ce[:, 1])
        keep = a != b
        key = a[keep] * self.m + b[keep]
        uk, inv_e = np.unique(key, return_inverse=True)
        counts = np.bincount(inv_e, weights=efc[keep], minlength=len(uk)) if len(uk) else np.zeros(0)
        edges = np.stack([uk // self.m, uk % self.m], axis=1) if len(uk) else np.zeros((0, 2), dtype=np.int64)
        self.boundary_edges = int((counts == 1).sum())
        self.nonmanifold_edges = int((counts > 2).sum())
        self.closed = self.boundary_edges == 0 and self.nonmanifold_edges == 0 and len(self.T) > 0
        self.E = edges[counts >= 1]
        self.deg = (np.bincount(self.E[:, 0], minlength=self.m)
                    + np.bincount(self.E[:, 1], minlength=self.m)).astype(np.float64)
        bad = self.E[(counts[counts >= 1] != 2)]
        self.on_boundary = np.zeros(self.m, dtype=bool)
        if len(bad):
            self.on_boundary[bad.ravel()] = True

    # ---- geometry
    def mean_neighbors(self, X):
        """The per-point average of the neighbour positions (graph Laplacian helper)."""
        E = self.E
        out = np.empty_like(X)
        for c in range(X.shape[1]):
            out[:, c] = (np.bincount(E[:, 0], X[E[:, 1], c], self.m)
                         + np.bincount(E[:, 1], X[E[:, 0], c], self.m))
        has = self.deg > 0
        out[has] /= self.deg[has, None]
        out[~has] = X[~has]
        return out

    def any_neighbor(self, mask):
        E = self.E
        cnt = (np.bincount(E[:, 0], mask[E[:, 1]].astype(np.float64), self.m)
               + np.bincount(E[:, 1], mask[E[:, 0]].astype(np.float64), self.m))
        return cnt > 0

    def normals(self, with_area=False):
        """Area-weighted vertex normals over canonical points (flipped with a negative scale)."""
        P, T = self.P, self.T
        fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])   # 2 * area vector
        N = np.zeros((self.m, 3))
        area = np.zeros(self.m)
        per_corner = np.linalg.norm(fn, axis=1) / 6.0                     # a third of the face area
        for k in range(3):
            for c in range(3):
                N[:, c] += np.bincount(T[:, k], fn[:, c], self.m)
            area += np.bincount(T[:, k], per_corner, self.m)
        ln = np.linalg.norm(N, axis=1)
        z = ln < 1e-20
        N[~z] /= ln[~z, None]
        N[z] = (0.0, 0.0, 1.0)
        if self.flip:
            N = -N
        return (N, area) if with_area else N

    def volume(self):
        P, T = self.P, self.T
        v = np.einsum("ij,ij->i", P[T[:, 0]], np.cross(P[T[:, 1]], P[T[:, 2]])).sum() / 6.0
        return float(-v if self.flip else v)

    def mirrored(self, k):
        """The original positions mirrored at the world plane through the origin."""
        out = self.P0.copy()
        out[:, k] = -out[:, k]
        return out

    # ---- write back
    def moved(self):
        return np.linalg.norm(self.P - self.P0, axis=1)

    def flush(self):
        """Write the canonical displacement onto every vertex copy. Returns the largest shift."""
        me = self.ob.data
        dW = (self.P - self.P0)[self.canon]
        mx = float(np.abs(dW).max()) if len(dW) else 0.0
        if mx == 0.0:
            return 0.0
        dL = dW @ self.Ainv.T
        co = np.empty(self.n * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        me.vertices.foreach_set("co", (co.reshape(-1, 3) + dL).ravel().astype(np.float32))
        sk = me.shape_keys
        if sk is not None:
            for kb in sk.key_blocks:     # morph targets are absolute: shift them with the basis
                kc = np.empty(self.n * 3, dtype=np.float64)
                kb.data.foreach_get("co", kc)
                kb.data.foreach_set("co", (kc.reshape(-1, 3) + dL).ravel().astype(np.float32))
        me.update()
        self.world = self.world + dW
        self.P0 = self.P.copy()
        return mx


# --------------------------------------------------------------------------- masks

def falloff_curve(t, kind):
    """Weight for a normalised distance t (0 at the centre .. 1 at the edge)."""
    t = np.clip(t, 0.0, 1.0)
    if kind == "linear":
        return 1.0 - t
    if kind == "sharp":
        return (1.0 - t) ** 2
    if kind == "constant":
        return (t < 1.0 - 1e-12).astype(np.float64)
    s = 1.0 - t
    return s * s * (3.0 - 2.0 * s)


def flip_group_name(name):
    """The left/right counterpart of a bone or group name (".L"/".R", "_l"/"_r", Left/Right,
    mixamorig:LeftArm...). Returns the name itself when there is none."""
    try:
        f = bpy.utils.flip_name(name)
        if f != name:
            return f
    except Exception:
        pass
    for a, b in (("Left", "Right"), ("left", "right"), ("LEFT", "RIGHT")):
        if a in name:
            return name.replace(a, b)
        if b in name:
            return name.replace(b, a)
    m = re.search(r"([._\-:])([LRlr])(?=$|[._\-:\d])", name)
    if m:
        nc = {"L": "R", "R": "L", "l": "r", "r": "l"}[m.group(2)]
        return name[:m.start(2)] + nc + name[m.end(2):]
    return name


def vertex_group_weights(ob, names):
    """Per-vertex maximum weight over the named vertex groups (length = vertex count)."""
    out = np.zeros(len(ob.data.vertices))
    ids = {g.index for g in ob.vertex_groups if g.name in names}
    if not ids:
        return out
    bm = bmesh.new()
    try:
        bm.from_mesh(ob.data)
        dl = bm.verts.layers.deform.active
        if dl is None:
            return out
        for v in bm.verts:
            best = 0.0
            for gi, w in v[dl].items():
                if gi in ids and w > best:
                    best = w
            out[v.index] = best
    finally:
        bm.free()
    return out


def _bone_descendants(arm, name, children):
    bone = arm.data.bones.get(name)
    if bone is None:
        return None
    names = {name}
    if children:
        stack = list(bone.children)
        while stack:
            b = stack.pop()
            names.add(b.name)
            stack.extend(b.children)
    return names


def _find_bone(ob, name):
    """The armature that owns the bone: first the one of the object's modifiers, then any."""
    cands = [m.object for m in ob.modifiers if m.type == "ARMATURE" and m.object is not None]
    cands += [a for a in af.armatures() if a not in cands]
    for arm in cands:
        if arm.data.bones.get(name) is not None:
            return arm
    return None


def canonical_max(S, per_vertex):
    """Reduce a per-source-vertex field to canonical points by max."""
    out = np.zeros(S.m)
    np.maximum.at(out, S.canon, per_vertex)
    return out


def _shape_weight(wv, fo):
    if fo == "smooth":
        return wv * wv * (3.0 - 2.0 * wv)
    if fo == "sharp":
        return wv * wv
    if fo == "constant":
        return (wv > 0.5).astype(np.float64)
    return wv


def _group_region(region, S, mirror_axis):
    """Weights of the vertex_group / bone mask (mirrored lookups included)."""
    ob, typ, name = S.ob, region["type"], region["name"]
    if typ == "vertex_group":
        names = {name}
        if ob.vertex_groups.get(name) is None:
            raise ValueError("object %s has no vertex group %r (has: %s)" % (
                ob.name, name, ", ".join(g.name for g in ob.vertex_groups) or "none"))
    else:
        arm = _find_bone(ob, name)
        if arm is None:
            raise ValueError("bone %r not found in any armature" % name)
        names = _bone_descendants(arm, name, bool(region.get("children")))
    if mirror_axis is not None:
        flipped = {flip_group_name(n) for n in names}
        if flipped != names and all(ob.vertex_groups.get(n) is not None for n in flipped):
            names = flipped
            mirror_axis = None      # the flipped group already is the mirror image
    present = {n for n in names if ob.vertex_groups.get(n) is not None}
    if present:
        w = _shape_weight(canonical_max(S, vertex_group_weights(ob, present)), region["falloff"])
    elif typ == "bone":          # no skin group: distance to the bone segment instead
        arm = _find_bone(ob, name)
        bone = arm.data.bones[name]
        mw = np.array(arm.matrix_world)
        h = mw[:3, :3] @ np.array(bone.head_local) + mw[:3, 3]
        tl = mw[:3, :3] @ np.array(bone.tail_local) + mw[:3, 3]
        seg = tl - h
        L2 = max(float(seg @ seg), 1e-12)
        s = np.clip(((S.P0 - h) @ seg) / L2, 0.0, 1.0)
        d = np.linalg.norm(S.P0 - (h + s[:, None] * seg), axis=1)
        rad = float(region.get("radius") or 0.5 * math.sqrt(L2))
        w = falloff_curve(d / rad, region["falloff"])
    else:
        w = np.zeros(S.m)
    if mirror_axis is not None:      # no flipped group: look the weight up at the mirror twin
        kd = mathutils.kdtree.KDTree(S.m)
        for i, p in enumerate(S.P0):
            kd.insert(p, i)
        kd.balance()
        tol = 2e-3 * S.size
        wm = np.zeros(S.m)
        Q = S.mirrored(mirror_axis)
        for i in range(S.m):
            _co, j, dist = kd.find(Q[i])
            if dist <= tol:
                wm[i] = w[j]
        w = wm
    return w


def region_weights(region, S, mirror_axis=None):
    """Weights (m,) over the canonical points; mirror_axis (0/1/2) evaluates the mirrored mask."""
    typ, fo = region["type"], region["falloff"]
    P = S.mirrored(mirror_axis) if mirror_axis is not None else S.P0
    if typ == "all":
        w = np.ones(S.m)
    elif typ == "sphere":
        c = np.asarray(region["center"])
        w = falloff_curve(np.linalg.norm(P - c, axis=1) / region["radius"], fo)
    elif typ == "box":
        c, ext = np.asarray(region["center"]), np.asarray(region["extents"])
        t = (np.abs(P - c) / ext).max(axis=1)
        inner = 1.0 - region["feather"]
        if inner >= 1.0 - 1e-9:
            w = (t <= 1.0).astype(np.float64)
        else:
            u = (t - inner) / (1.0 - inner)
            w = np.where(t <= inner, 1.0, falloff_curve(u, fo))
            w = np.where(t > 1.0, 0.0, w)
    else:
        w = _group_region(region, S, mirror_axis)
    if region["invert"]:
        w = 1.0 - w
    return np.clip(w, 0.0, 1.0)


def symmetric_weights(region, S, sym):
    """(w, w_mirror) of the mask; w_mirror is None without symmetry."""
    w = region_weights(region, S)
    if sym == "none":
        return w, None
    return w, region_weights(region, S, AXES[sym])


def combine(w1, w2, D1, D2):
    """Blend two full-strength displacement fields (original / mirrored), scaled by the stronger
    mask weight: where the zones overlap on the symmetry plane the result is the symmetric average."""
    if w2 is None:
        return D1 * w1[:, None]
    w = np.maximum(w1, w2)
    s = w1 + w2
    safe = np.where(s > 0, s, 1.0)
    return (w1[:, None] * D1 + w2[:, None] * D2) / safe[:, None] * w[:, None]


# --------------------------------------------------------------------------- point operations

def _mirror_vec(v, k):
    v = np.array(v, dtype=np.float64)
    v[k] = -v[k]
    return v


def _weighted_center(P, w):
    s = float(w.sum())
    return (P * w[:, None]).sum(axis=0) / s if s > 0 else P.mean(axis=0)


def op_smooth(S, op, w1, w2):
    w = np.maximum(w1, w2) if w2 is not None else w1
    w = np.where(S.on_boundary, 0.0, w) if op["pin_boundary"] else w
    for _ in range(op["iterations"]):
        S.P += op["factor"] * w[:, None] * (S.mean_neighbors(S.P) - S.P)


def op_relax(S, op, w1, w2):
    """Taubin smoothing (shrink then un-shrink) + an along-the-normal correction that restores the
    volume of a closed mesh: unlike Laplacian smoothing the model does not melt."""
    w = np.maximum(w1, w2) if w2 is not None else w1
    w = np.where(S.on_boundary, 0.0, w) if op["pin_boundary"] else w
    lam = max(op["factor"], 1e-3)
    mu = 1.0 / (0.1 - 1.0 / lam)            # pass band 0.1: the negative pass cancels the shrink
    v0 = S.volume() if (op["keep_volume"] and S.closed) else None
    for _ in range(op["iterations"]):
        S.P += lam * w[:, None] * (S.mean_neighbors(S.P) - S.P)
        S.P += mu * w[:, None] * (S.mean_neighbors(S.P) - S.P)
    if v0 is not None:
        N, area = S.normals(with_area=True)
        denom = float((w * area).sum())
        if denom > 0:
            delta = (v0 - S.volume()) / denom     # d(volume) = sum(area * shift along the normal)
            S.P += (w * delta)[:, None] * N


def op_inflate(S, op, w1, w2):
    N = S.normals()
    amt = op["amount"] * (-1.0 if op["op"] == "deflate" else 1.0)
    D = N * amt
    S.P += combine(w1, w2, D, D)


def op_grab(S, op, w1, w2, k):
    off = np.asarray(op["offset"], dtype=np.float64)
    D1 = np.tile(off, (S.m, 1))
    D2 = np.tile(_mirror_vec(off, k), (S.m, 1)) if w2 is not None else None
    S.P += combine(w1, w2, D1, D2)


def _best_plane(S, w, N):
    """Weighted covariance fit; the normal is oriented along the average face normal."""
    c = _weighted_center(S.P, w)
    X = (S.P - c) * np.sqrt(w)[:, None]
    vals, vecs = np.linalg.eigh(X.T @ X)
    n = vecs[:, 0]
    mean_n = (N * w[:, None]).sum(axis=0)
    if float(n @ mean_n) < 0:
        n = -n
    return c, n / (np.linalg.norm(n) or 1.0)


def op_flatten(S, op, w1, w2, k):
    for _ in range(op["iterations"]):
        N = S.normals()
        if op.get("plane"):
            c, n = np.asarray(op["plane"]["point"]), np.asarray(op["plane"]["normal"], float)
            n = n / np.linalg.norm(n)
        else:
            c, n = _best_plane(S, np.maximum(w1, 1e-12) * (w1 > 0), N)
        d1 = ((c - S.P) @ n)[:, None] * n * op["strength"]
        d2 = None
        if w2 is not None:
            c2, n2 = c.copy(), n.copy()
            c2[k], n2[k] = -c2[k], -n2[k]
            d2 = ((c2 - S.P) @ n2)[:, None] * n2 * op["strength"]
        S.P += combine(w1, w2, d1, d2)


def op_pinch(S, op, w1, w2, k):
    sign = 1.0 if op["op"] == "pinch" else -1.0
    N = S.normals()
    c = np.asarray(op["center"]) if op.get("center") is not None else _weighted_center(S.P, w1)

    def field(center):
        d = center - S.P
        if not op["radial"]:
            d = d - (d * N).sum(axis=1)[:, None] * N   # slide along the surface, not through it
        return d * (op["amount"] * sign)

    D1 = field(c)
    D2 = field(_mirror_vec(c, k)) if w2 is not None else None
    S.P += combine(w1, w2, D1, D2)


# --------------------------------------------------------------------------- transfer

def _import_source(path):
    """Import a source mesh as (verts (n,3) world, tris (k,3)); the imported objects are removed."""
    path = os.path.abspath(str(path))
    if not os.path.isfile(path):
        raise FileNotFoundError("transfer source not found: %s" % path)
    objs = af.import_any(path)
    bpy.context.view_layer.update()
    meshes = [o for o in objs if o.type == "MESH"]
    if not meshes:
        raise ValueError("transfer source %s has no mesh" % path)
    verts, tris, off = [], [], 0
    for o in meshes:
        me = o.data
        n = len(me.vertices)
        co = np.empty(n * 3)
        me.vertices.foreach_get("co", co)
        mw = np.array(o.matrix_world)
        verts.append(co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3])
        me.calc_loop_triangles()
        tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", tri)
        tris.append(tri.reshape(-1, 3) + off)
        off += n
    for o in list(objs):
        if o.name in bpy.data.objects:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if data is not None and getattr(data, "users", 1) == 0 and isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
    for a in list(bpy.data.armatures):
        if a.users == 0:
            bpy.data.armatures.remove(a)
    bpy.context.view_layer.update()
    return np.concatenate(verts), np.concatenate(tris)


def _align_source(V, target_lo, target_hi, mode, warnings):
    """Fit the source into the model's frame by bounding box when it clearly differs."""
    lo, hi = V.min(axis=0), V.max(axis=0)
    if mode == "none":
        return V, "none"
    t_size, s_size = target_hi - target_lo, hi - lo
    ratio = float(np.linalg.norm(s_size) / max(np.linalg.norm(t_size), EPS))
    off = float(np.linalg.norm((hi + lo) / 2 - (target_hi + target_lo) / 2)
                / max(np.linalg.norm(t_size), EPS))
    if mode == "auto":
        if abs(1.0 - ratio) < 0.15 and off < 0.15:
            return V, "none"
        warnings.append("transfer: the source differs from the model in size/position "
                        "(size x%.2f, offset %.0f%% of the diagonal): fitted by bounding box" % (
                            ratio, 100 * off))
    s = float(t_size[2] / s_size[2]) if s_size[2] > EPS else 1.0
    # uniform scale by height, the foot-centre of the source onto the foot-centre of the target
    c_s = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    c_t = np.array([(target_lo[0] + target_hi[0]) / 2, (target_lo[1] + target_hi[1]) / 2,
                    target_lo[2]])
    return (V - c_s) * s + c_t, "bbox(scale %.4f)" % s


def _build_bvh(V, T):
    return mathutils.bvhtree.BVHTree.FromPolygons([tuple(v) for v in V.tolist()],
                                                  [tuple(t) for t in T.tolist()])


def op_transfer(S, op, w1, w2, ctx):
    """Copy the shape of the source mesh onto the masked region (the Sculpt tab round trip)."""
    bvh = ctx["source_bvh"]
    N = S.normals()
    P = S.P
    target = P.copy()
    method = op["method"]
    near_d = np.zeros(S.m)
    hit_proj = 0
    tol_abs = 0.002 * S.size
    active = np.maximum(w1, w2 if w2 is not None else 0) > 1e-6
    for i in np.nonzero(active)[0].tolist():
        p = mathutils.Vector(P[i])
        loc, _n, _idx, dist = bvh.find_nearest(p)
        if loc is None:
            continue
        near_d[i] = dist
        best = np.array(loc)
        if method == "project":
            # along the vertex normal both ways; a ray hit much farther than the nearest point is
            # the wrong side of a fold - keep the nearest point then
            n = mathutils.Vector(N[i])
            cands = []
            for sgn in (1.0, -1.0):
                h = bvh.ray_cast(p, n * sgn)
                if h[0] is not None:
                    cands.append((h[3], np.array(h[0])))
            if cands:
                dmin, q = min(cands, key=lambda c: c[0])
                if dmin <= 1.5 * dist + tol_abs:
                    best = q
                    hit_proj += 1
        target[i] = best
    D1 = (target - P) * op["strength"]
    w = np.maximum(w1, w2) if w2 is not None else w1
    # for a mirrored mask the shape of the source itself is the symmetric answer: no mirror field
    D = D1 * w[:, None]
    if op["seam_smooth"] and float(w.min()) < 0.999:
        inside = w > 1e-6
        band = (inside & (w < 0.999)) | (inside & S.any_neighbor(~inside))
        for _ in range(2):
            band |= S.any_neighbor(band) & inside
        for _ in range(op["seam_smooth"]):
            Dn = S.mean_neighbors(D)
            D[band] = 0.5 * D[band] + 0.5 * Dn[band]
    S.P += D
    return {"projected": hit_proj,
            "nearest_dist_mean_m": round(float(near_d[active].mean()), 6) if active.any() else 0.0}


def transfer_distances(S, w, bvh_src, src_V):
    """Distances target(full-weight vertices) -> source, and source samples -> target surface."""
    full = np.nonzero(w >= 0.999)[0]
    d_t = []
    for i in full.tolist():
        loc, _n, _idx, dist = bvh_src.find_nearest(mathutils.Vector(S.P[i]))
        if loc is not None:
            d_t.append(dist)
    out = {"max": None, "mean": None, "cover_max": None, "cover_mean": None, "count": len(d_t)}
    if d_t:
        out["max"], out["mean"] = float(max(d_t)), float(np.mean(d_t))
    if len(S.T):
        tb = mathutils.bvhtree.BVHTree.FromPolygons([tuple(v) for v in S.P.tolist()],
                                                    [tuple(t) for t in S.T.tolist()])
        step = max(1, len(src_V) // 20000)
        d_s = []
        for p in src_V[::step].tolist():
            loc, _n, _idx, dist = tb.find_nearest(mathutils.Vector(p))
            if loc is not None:
                d_s.append(dist)
        if d_s:
            out["cover_max"], out["cover_mean"] = float(max(d_s)), float(np.mean(d_s))
    return out


# --------------------------------------------------------------------------- topology operations

def _object_mode():
    try:
        if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass


def _apply(ob, mod):
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob],
                                   selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def _pop_armature_mods(ob):
    saved = []
    for m in list(ob.modifiers):
        if m.type == "ARMATURE":
            saved.append({"name": m.name, "object": m.object, "vgroups": m.use_vertex_groups,
                          "preserve": m.use_deform_preserve_volume,
                          "envelopes": m.use_bone_envelopes})
            ob.modifiers.remove(m)
    return saved


def _restore_armature_mods(ob, saved):
    for s in saved:
        m = ob.modifiers.new(s["name"], "ARMATURE")
        m.object = s["object"]
        m.use_vertex_groups = s["vgroups"]
        m.use_deform_preserve_volume = s["preserve"]
        m.use_bone_envelopes = s["envelopes"]


def _scale_of(ob):
    return abs(float(np.linalg.det(np.array(ob.matrix_world)[:3, :3]))) ** (1.0 / 3.0)


def op_remesh(ob, op, ctx, warnings):
    """Remesh a whole mesh; skin weights come back through a data transfer from the original."""
    _object_mode()
    size = Surface(ob).size
    keep_rig = ctx["preserve_rig"] and any(m.type == "ARMATURE" for m in ob.modifiers)
    src = ml.duplicate(ob, ob.name + "_sculpt_src") if keep_rig else None
    group_names = [g.name for g in ob.vertex_groups]
    arm_mods = _pop_armature_mods(ob)
    af.select_only([ob])
    before_tris = ml.tris_of(ob)
    if op["mode"] == "quad":
        faces = op.get("target_faces") or max(500, before_tris // 4)
        ml.merge_by_distance(ob, 1e-5 * size / max(_scale_of(ob), 1e-9))   # QuadriFlow wants one shell
        try:
            with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob],
                                           selected_editable_objects=[ob]):
                bpy.ops.object.quadriflow_remesh(mode="FACES", target_faces=int(faces),
                                                 use_mesh_symmetry=False, use_preserve_sharp=False,
                                                 use_preserve_boundary=False, smooth_normals=True,
                                                 seed=0)
        except Exception as exc:      # QuadriFlow is optional and fails on non-manifold input
            warnings.append("remesh quad failed (%s): fell back to voxel" % str(exc)[:120])
            op = dict(op, mode="voxel")
    if op["mode"] == "voxel":
        voxel = op.get("voxel_size") or 0.0033 * size
        if voxel > 0.004 * size:
            warnings.append("remesh voxel_size=%.4g is %.2f%% of the model: thin parts tear above "
                            "~0.4%%" % (voxel, 100 * voxel / size))
        vt = ml.voxel_remesh(ob, voxel / max(_scale_of(ob), 1e-9), op.get("adaptivity", 0.0))
        if vt == 0:
            raise RuntimeError("voxel remesh produced an empty mesh (voxel_size too large?)")
    # the remesher drops UVs and colour attributes; weights are rebuilt below
    for name in group_names:
        if ob.vertex_groups.get(name) is None:
            ob.vertex_groups.new(name=name)
    if src is not None:
        mod = ob.modifiers.new("af_wt", "DATA_TRANSFER")
        mod.object = src
        mod.use_vert_data = True
        mod.data_types_verts = {"VGROUP_WEIGHTS"}
        mod.vert_mapping = "POLYINTERP_NEAREST"
        mod.layers_vgroup_select_src = "ALL"
        mod.layers_vgroup_select_dst = "NAME"
        mod.mix_mode = "REPLACE"
        mod.mix_factor = 1.0
        _apply(ob, mod)
        ml.remove_object(src)
    _restore_armature_mods(ob, arm_mods)
    return {"tris_before": before_tris, "tris_after": ml.tris_of(ob), "mode": op["mode"]}


def op_subdivide(ob, S, op, w):
    """Split the edges whose both endpoints carry mask weight >= threshold."""
    _object_mode()
    me = ob.data
    wv = w[S.canon]      # mask per source vertex
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    thr = op["threshold"]
    edges = [e for e in bm.edges if wv[e.verts[0].index] >= thr and wv[e.verts[1].index] >= thr
             and wv[e.verts[0].index] > 0 and wv[e.verts[1].index] > 0]
    n0 = len(bm.verts)
    if edges:
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=op["cuts"], use_grid_fill=True)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return {"edges_split": len(edges), "verts_added": len(me.vertices) - n0}


def op_decimate(ob, S, op, w):
    """Collapse the region towards `ratio` of its triangles; outside the mask the mesh is kept."""
    _object_mode()
    t0 = ml.tris_of(ob)
    if t0 == 0:
        return {"tris_before": 0, "tris_after": 0}
    full = bool(float(w.min()) > 0.999)
    mod = ob.modifiers.new("af_decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.use_collapse_triangulate = True
    if full:
        ratio = op["ratio"]
    else:
        wv = w[S.canon]
        grp = ob.vertex_groups.get("af_sculpt_mask") or ob.vertex_groups.new(name="af_sculpt_mask")
        grp.add(list(range(len(wv))), 0.0, "REPLACE")
        idx = np.nonzero(wv > 0)[0]
        q = np.round(wv[idx] * 20) / 20.0                  # 21 levels are plenty for a mask
        for wt in np.unique(q):
            grp.add(idx[q == wt].tolist(), float(wt), "REPLACE")
        mod.vertex_group = grp.name
        mod.vertex_group_factor = 1.0
        tri_w = w[S.T].min(axis=1) if len(S.T) else np.zeros(0)
        region_tris = float((tri_w > 0.5).sum())
        ratio = 1.0 - (1.0 - op["ratio"]) * region_tris / max(float(len(S.T)), 1.0)
    mod.ratio = max(1e-4, min(1.0, ratio))
    arm_mods = _pop_armature_mods(ob)
    _apply(ob, mod)
    _restore_armature_mods(ob, arm_mods)
    grp = ob.vertex_groups.get("af_sculpt_mask")
    if grp is not None:
        ob.vertex_groups.remove(grp)
    return {"tris_before": t0, "tris_after": ml.tris_of(ob), "global_ratio": round(ratio, 4)}


def op_symmetrize(ob, op, warnings):
    """Cut at the world plane and mirror one half onto the other; the mirrored half gets the
    mirrored skin weights (L<->R groups)."""
    _object_mode()
    k = AXES[op["axis"]]
    me = ob.data
    mw = ob.matrix_world.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(mw)                        # world space: the object itself may be rotated
    size = max(max(v.co[i] for v in bm.verts) - min(v.co[i] for v in bm.verts) for i in range(3)) \
        if len(bm.verts) else 1.0
    dist = 1e-5 * max(size, 1e-3)
    sign = 1.0 if op["direction"] == "+" else -1.0
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    direction = op["axis"].upper() if op["direction"] == "+" else "-" + op["axis"].upper()
    n0 = len(bm.verts)
    bmesh.ops.symmetrize(bm, input=geom, direction=direction, dist=dist)
    dl = bm.verts.layers.deform.active
    if dl is not None and ob.vertex_groups:
        names = [g.name for g in ob.vertex_groups]
        flip = {}
        for i, nme in enumerate(names):
            f = flip_group_name(nme)
            flip[i] = names.index(f) if f in names else i
        for v in bm.verts:
            if v.co[k] * sign < -dist * 2:   # a mirrored copy of the other side
                items = list(v[dl].items())
                v[dl].clear()
                for gi, wt in items:
                    v[dl][flip.get(gi, gi)] = wt
    bm.transform(mw.inverted())
    bm.to_mesh(me)
    bm.free()
    me.update()
    if me.uv_layers:
        warnings.append("symmetrize: the mirrored half shares the UV of the original half "
                        "(overlapping islands); re-unwrap for baked textures")
    return {"verts_before": n0, "verts_after": len(me.vertices), "axis": op["axis"],
            "direction": op["direction"]}


# --------------------------------------------------------------------------- snapshots & checks

def uv_snapshot(ob):
    me = ob.data
    snap = {"layers": len(me.uv_layers), "loops": len(me.loops), "arrays": [], "finite": True}
    for layer in me.uv_layers:
        a = np.empty(len(me.loops) * 2)
        layer.data.foreach_get("uv", a)
        snap["arrays"].append(a)
        if not np.isfinite(a).all():
            snap["finite"] = False
    return snap


def uv_unchanged(before, after):
    """Point ops must not touch UVs: with the same loop count the layers must be bit-identical;
    after subdivide/decimate only presence and finiteness can be checked."""
    if before["layers"] != after["layers"] or not after["finite"]:
        return False
    if before["loops"] == after["loops"]:
        return all(np.array_equal(a, b) for a, b in zip(before["arrays"], after["arrays"]))
    return True


def rig_snapshot():
    arms = af.armatures()
    snap = {"bones": {a.name: len(a.data.bones) for a in arms}, "actions": len(bpy.data.actions),
            "meshes": {}}
    for ob in ml.model_meshes(list(bpy.context.scene.objects)):
        mods = [m.object.name if m.object else None for m in ob.modifiers if m.type == "ARMATURE"]
        groups = sorted(g.name for g in ob.vertex_groups)
        weighted = 0
        n = len(ob.data.vertices)
        if groups and n:
            wv = vertex_group_weights(ob, set(groups))
            weighted = int((wv > 0).sum())
        snap["meshes"][ob.name] = {"armature_mods": mods, "groups": groups,
                                   "weighted": weighted, "verts": n}
    return snap


def rig_problem(before, after):
    """None when the rig survived; otherwise a short description of what broke."""
    if before["bones"] != after["bones"]:
        return "bones %s -> %s" % (before["bones"], after["bones"])
    if after["actions"] < before["actions"]:
        return "actions %d -> %d" % (before["actions"], after["actions"])
    for name, b in before["meshes"].items():
        a = after["meshes"].get(name)
        if a is None:
            return "mesh %s disappeared" % name
        if sorted(b["armature_mods"], key=str) != sorted(a["armature_mods"], key=str):
            return "mesh %s: armature modifiers %s -> %s" % (name, b["armature_mods"],
                                                              a["armature_mods"])
        if not set(b["groups"]) <= set(a["groups"]):
            return "mesh %s lost vertex groups %s" % (name, sorted(set(b["groups"]) - set(a["groups"])))
        if b["groups"] and b["verts"] and a["verts"]:
            fb, fa = b["weighted"] / b["verts"], a["weighted"] / a["verts"]
            if fa < fb - 0.02:
                return "mesh %s: weighted vertices %.1f%% -> %.1f%%" % (name, 100 * fb, 100 * fa)
    return None


def welded_metrics(objs):
    out = {"verts": 0, "boundary_edges": 0, "nonmanifold_edges": 0, "nan_verts": 0, "tris": 0}
    for o in objs:
        S = Surface(o)
        out["verts"] += S.m
        out["boundary_edges"] += S.boundary_edges
        out["nonmanifold_edges"] += S.nonmanifold_edges
        out["nan_verts"] += int((~np.isfinite(S.world)).any(axis=1).sum())
        out["tris"] += len(S.T)
    return out


def mirror_pair_error(objs, axis_name):
    """(share of canonical points that have a mirror twin within tolerance, worst miss in m)."""
    k = AXES[axis_name]
    total, hit, worst = 0, 0, 0.0
    for o in objs:
        S = Surface(o)
        kd = mathutils.kdtree.KDTree(S.m)
        for i, p in enumerate(S.P0):
            kd.insert(p, i)
        kd.balance()
        Q = S.mirrored(k)
        tol = 2e-3 * S.size
        for i in range(S.m):
            _co, _j, dist = kd.find(Q[i])
            total += 1
            if dist <= tol:
                hit += 1
            worst = max(worst, dist)
    return (hit / total if total else 1.0), worst


def fix_normals(ob, smooth_deg):
    ml.clear_custom_normals(ob)
    ml.apply_shading(ob, smooth_deg)


# --------------------------------------------------------------------------- the step

def _pose_mode(mode):
    saved = []
    for a in af.armatures():
        saved.append((a, a.data.pose_position))
        a.data.pose_position = mode
    bpy.context.view_layer.update()
    return saved


def _restore_pose(saved):
    for a, pm in saved:
        try:
            a.data.pose_position = pm
        except ReferenceError:      # the rig was dropped (preserve_rig false)
            pass
    bpy.context.view_layer.update()


def _merge_transfer(acc, d):
    if acc is None:
        return dict(d)
    out = dict(acc)
    for key in ("max", "cover_max"):
        if d[key] is not None:
            out[key] = d[key] if acc[key] is None else max(acc[key], d[key])
    if d["mean"] is not None:
        tot = acc["count"] + d["count"]
        out["mean"] = d["mean"] if not acc["count"] else \
            (acc["mean"] * acc["count"] + d["mean"] * d["count"]) / tot
        out["count"] = tot
    if d["cover_mean"] is not None:
        out["cover_mean"] = d["cover_mean"] if acc["cover_mean"] is None else \
            (acc["cover_mean"] + d["cover_mean"]) / 2
    return out


def run(req):
    p = req["params"]
    warnings, timings, op_log = [], {}, []
    t_all = time.time()
    default_sym = str(p.get("symmetry") or "none").lower()
    if default_sym not in ("x", "y", "z", "none"):
        raise ValueError("params.symmetry must be 'x' | 'y' | 'z' | 'none'")
    ops = parse_ops(p.get("ops"), default_sym)
    keep_uv = bool(p.get("keep_uv", True))
    preserve_rig = bool(p.get("preserve_rig", True))
    shade_deg = p.get("shade_auto_smooth_deg", 40)

    # ------------------------------------------------------------------ load
    t0 = time.time()
    inputs = req.get("inputs") or {}
    if inputs.get("blend"):
        src_path = os.path.abspath(str(inputs["blend"]))     # af_run has opened it already
        objs = list(bpy.context.scene.objects)
    else:
        src_path = ml.input_path(req)
        af.reset_scene()
        objs = af.import_any(src_path)
        objs, _helpers = ml.purge_import_helpers(objs)
    bpy.context.view_layer.update()
    meshes = ml.model_meshes(list(bpy.context.scene.objects))
    wanted = p.get("objects")
    if wanted:
        low = {str(n).lower() for n in wanted}
        targets = [o for o in meshes if o.name.lower() in low]
        if not targets:
            raise ValueError("params.objects %s match no mesh (have: %s)" % (
                sorted(low), ", ".join(o.name for o in meshes)))
    else:
        targets = meshes
    if not targets:
        raise ValueError("no mesh objects in %s" % src_path)
    af.log("loaded", file=os.path.basename(src_path), meshes=len(targets))
    timings["load"] = round(time.time() - t0, 2)

    has_rig = bool(af.armatures())
    rig_before = rig_snapshot() if has_rig else None
    if has_rig and not preserve_rig:
        warnings.append("preserve_rig=false: armature, clips and skin weights are dropped")
    uvs_before = {o.name: uv_snapshot(o) for o in targets}
    has_uv = any(s["layers"] for s in uvs_before.values())
    if keep_uv and has_uv and any(o["op"] == "remesh" for o in ops):
        raise ValueError("remesh cannot keep UVs: pass keep_uv:false (the texture is lost - bake "
                         "a colour with `cleanup` voxel_remesh_m instead) or drop the remesh op")
    for o in targets:
        if o.data.shape_keys is not None:
            warnings.append("%s has shape keys: they are shifted with the basis" % o.name)

    before = welded_metrics(targets)
    stats_before = ml.mesh_metrics(targets)
    lo0, hi0 = af.world_bbox(targets)
    height = float(hi0.z - lo0.z) or 1.0
    model_size = float(max(hi0.x - lo0.x, hi0.y - lo0.y, hi0.z - lo0.z)) or 1.0

    psize = int(p.get("preview_size", 512))
    views = ("front", "three_quarter")
    sheet_before = None
    pose_saved = _pose_mode("REST") if has_rig else []
    if p.get("preview", True):
        t0 = time.time()
        _, sheet_before = ml.render_sheet(af.out_path(req, "_before.png"), targets, views=views,
                                          size=psize, bbox=(lo0.copy(), hi0.copy()))
        timings["render_before"] = round(time.time() - t0, 2)

    # ------------------------------------------------------------------ operations
    dirty = set()
    transfer_stats = None
    sym_for_check = None
    sym_base = {}       # the symmetry that was already there: symmetric ops must not make it worse
    for o in ops:
        if o["symmetry"] != "none" and o["op"] in POINT_OPS + ("subdivide",) and o["symmetry"] not in sym_base:
            sym_base[o["symmetry"]] = mirror_pair_error(targets, o["symmetry"])[0]
    t_ops = time.time()
    for i, op in enumerate(ops):
        t0 = time.time()
        name = op["op"]
        rec = {"index": i, "op": name, "region": op["region"]["type"], "objects": {}}
        af.log("op %d/%d %s" % (i + 1, len(ops), name))
        sym = op["symmetry"]
        k = AXES.get(sym)
        if name in ("remesh", "symmetrize") and op["region"]["type"] != "all":
            warnings.append("ops[%d] %s works on whole meshes: region ignored" % (i, name))
        ctx = {"preserve_rig": preserve_rig}
        if name == "transfer":
            path = op.get("source")
            if not path:
                raise ValueError("ops[%d] transfer: `source` (a path) is required here; the studio "
                                 "turns `source_asset` into `source` before the run" % i)
            t_lo, t_hi = af.world_bbox(targets)
            V, T = _import_source(path)
            V, how = _align_source(V, np.array(t_lo), np.array(t_hi), op["align"], warnings)
            ctx["source_mesh"] = (V, T)
            ctx["source_bvh"] = _build_bvh(V, T)
            rec["aligned"] = how
        for ob in targets:
            if name in ("remesh", "symmetrize"):
                if name == "remesh":
                    info = op_remesh(ob, op, ctx, warnings)
                else:
                    info = op_symmetrize(ob, op, warnings)
                    sym_for_check = ("make", op["axis"])
                dirty.add(ob.name)
                rec["objects"][ob.name] = info
                continue
            if name == "decimate":   # the collapse decimator wants shared vertices, not split copies
                S0 = Surface(ob)
                ml.merge_by_distance(ob, 1e-5 * S0.size / max(_scale_of(ob), 1e-9))
            S = Surface(ob)
            w1, w2 = symmetric_weights(op["region"], S, sym)
            covered = int((np.maximum(w1, w2 if w2 is not None else 0) > 1e-6).sum())
            if covered == 0:
                rec["objects"][ob.name] = {"covered_points": 0}
                continue
            info = {"covered_points": covered, "points": S.m}
            if name in ("subdivide", "decimate"):
                w = np.maximum(w1, w2) if w2 is not None else w1
                info.update(op_subdivide(ob, S, op, w) if name == "subdivide"
                            else op_decimate(ob, S, op, w))
                dirty.add(ob.name)
            else:
                if name == "smooth":
                    op_smooth(S, op, w1, w2)
                elif name == "relax":
                    op_relax(S, op, w1, w2)
                elif name in ("inflate", "deflate"):
                    op_inflate(S, op, w1, w2)
                elif name == "grab":
                    op_grab(S, op, w1, w2, k if k is not None else 0)
                elif name == "flatten":
                    op_flatten(S, op, w1, w2, k if k is not None else 0)
                elif name in ("pinch", "expand"):
                    op_pinch(S, op, w1, w2, k if k is not None else 0)
                elif name == "transfer":
                    info.update(op_transfer(S, op, w1, w2, ctx))
                    wt = np.maximum(w1, w2) if w2 is not None else w1
                    dist = transfer_distances(S, wt if op["strength"] >= 0.999 else wt * 0.0,
                                              ctx["source_bvh"], ctx["source_mesh"][0])
                    transfer_stats = _merge_transfer(transfer_stats, dist)
                mv = S.moved()
                info["moved_points"] = int((mv > 1e-9).sum())
                info["max_shift_m"] = round(float(mv.max()), 6) if len(mv) else 0.0
                if info["moved_points"]:
                    S.flush()
                    dirty.add(ob.name)
            if sym != "none" and name in POINT_OPS + ("subdivide",) and not sym_for_check:
                sym_for_check = ("keep", sym)
            rec["objects"][ob.name] = info
        rec["seconds"] = round(time.time() - t0, 2)
        if not any(v.get("covered_points", 1) for v in rec["objects"].values()):
            warnings.append("ops[%d] %s: the region matched no vertex of any mesh" % (i, name))
        op_log.append(rec)
    timings["ops"] = round(time.time() - t_ops, 2)

    # ------------------------------------------------------------------ normals, rig
    if not preserve_rig and has_rig:
        for o in targets:
            for m in list(o.modifiers):
                if m.type == "ARMATURE":
                    o.modifiers.remove(m)
            o.parent = None
        for a in list(af.armatures()):
            bpy.data.objects.remove(a, do_unlink=True)
        for ac in list(bpy.data.actions):
            bpy.data.actions.remove(ac)
    for o in targets:
        if o.name in dirty:
            fix_normals(o, shade_deg)

    lo1, hi1 = af.world_bbox(targets)
    after = welded_metrics(targets)
    stats_after = ml.mesh_metrics(targets)

    # ------------------------------------------------------------------ outputs
    outputs = {}
    compare = None
    if p.get("preview", True):
        t0 = time.time()
        _, sheet_after = ml.render_sheet(af.out_path(req, "_after.png"), targets, views=views,
                                         size=psize, bbox=(lo0.copy(), hi0.copy()))
        compare = ml.render_compare(sheet_before, sheet_after)
        outputs["preview"] = ml.side_by_side(af.out_path(req, "preview.png"),
                                             [np.concatenate(sheet_before, axis=1),
                                              np.concatenate(sheet_after, axis=1)])
        for tmp in ("_before.png", "_after.png"):
            try:
                os.remove(af.out_path(req, tmp))
            except OSError:
                pass
        timings["render_after"] = round(time.time() - t0, 2)
    if pose_saved:
        _restore_pose(pose_saved)
    t0 = time.time()
    arms_now = af.armatures()
    outputs["glb"] = af.export_glb(af.out_path(req, "sculpt.glb"), objects=None,
                                   animations=bool(bpy.data.actions) and bool(arms_now),
                                   skins=bool(arms_now))
    outputs["mesh"] = outputs["glb"]
    timings["export_glb"] = round(time.time() - t0, 2)
    ml.purge_orphans()
    outputs["blend"] = af.save_blend(af.out_path(req, "sculpt.blend"))

    # ------------------------------------------------------------------ checks
    checks = []
    checks.append(af.check("no_nan_verts", after["nan_verts"] == 0, after["nan_verts"], 0))
    n_sym = sum(1 for o in ops if o["op"] == "symmetrize")
    has_remesh = any(o["op"] == "remesh" for o in ops)
    # symmetrize mirrors the open borders too (x2 each); a remesh of thin overlapping sheets may
    # leave a handful of pinched edges (a few per 100k triangles)
    lim_boundary = before["boundary_edges"] * (2 ** n_sym)
    lim_nonman = before["nonmanifold_edges"] + (max(8, int(5e-5 * after["tris"])) if has_remesh else 0)
    ok_m = after["boundary_edges"] <= lim_boundary and after["nonmanifold_edges"] <= lim_nonman
    checks.append(af.check("sculpt_manifold", ok_m,
                           {"boundary": after["boundary_edges"], "non_manifold": after["nonmanifold_edges"]},
                           {"boundary": lim_boundary, "non_manifold": lim_nonman},
                           note="welded view (UV-split copies count as one vertex): the ops must "
                                "not open or pinch the surface"))
    if has_remesh and after["nonmanifold_edges"] > before["nonmanifold_edges"]:
        warnings.append("remesh left %d non-manifold edges (thin overlapping sheets)"
                        % (after["nonmanifold_edges"] - before["nonmanifold_edges"]))
    if keep_uv:
        bad = [o.name for o in targets if o.name in dirty
               and not uv_unchanged(uvs_before[o.name], uv_snapshot(o))]
        checks.append(af.check("sculpt_uv_kept", not bad, bad or "kept", "kept",
                               note="UV layers present, finite and (for point ops) bit-identical"))
    else:
        checks.append(af.check("sculpt_uv_kept", True, "not required (keep_uv:false)", None))
    if has_rig and preserve_rig:
        problem = rig_problem(rig_before, rig_snapshot())
        checks.append(af.check("sculpt_rig_kept", problem is None, problem or "kept", "kept"))
    else:
        checks.append(af.check("sculpt_rig_kept", True, "no rig" if not has_rig else "dropped by "
                               "preserve_rig:false", None))
    moved_any = any(v.get("moved_points") or v.get("verts_added") or v.get("tris_after") is not None
                    or v.get("verts_after") is not None
                    for r in op_log for v in r["objects"].values())
    checks.append(af.check("sculpt_changed", bool(moved_any), bool(moved_any), True,
                           severity="warning",
                           note="false: the region missed the mesh or the amounts were zero"))
    if sym_for_check:
        kind, axis = sym_for_check
        frac, worst = mirror_pair_error(targets, axis)
        if kind == "make":        # after symmetrize the mesh must be symmetric
            limit, note = 0.98, "share of points with a mirror twin; worst miss %.5f m" % worst
        else:                      # symmetric ops keep the symmetry the mesh already had
            limit = min(0.98, sym_base.get(axis, 1.0) - 0.02)
            note = ("share of points with a mirror twin (%.1f%% before); worst miss %.5f m"
                    % (100 * sym_base.get(axis, 1.0), worst))
        checks.append(af.check("sculpt_symmetric", frac >= limit, round(frac, 4), round(limit, 4),
                               severity="warning", note=note))
    tol = float(p.get("tolerance_m") or 0.01 * model_size)
    if transfer_stats and transfer_stats["max"] is not None:
        checks.append(af.check("transfer_max_dist_m", transfer_stats["max"] <= tol,
                               round(transfer_stats["max"], 6), tol, severity="warning",
                               note="target vertices (full weight) to the source surface"))
        checks.append(af.check("transfer_mean_dist_m", transfer_stats["mean"] <= tol / 4,
                               round(transfer_stats["mean"], 6), tol / 4, severity="warning"))
    elif transfer_stats is not None:
        warnings.append("transfer: no full-weight vertices to measure the distance on "
                        "(strength < 1 or a soft region)")

    timings["total"] = round(time.time() - t_all, 2)
    stats = {
        "before": stats_before, "after": stats_after, "welded_before": before,
        "welded_after": after, "ops": op_log, "transfer": transfer_stats,
        "render_compare": compare, "timings_s": timings, "input": src_path,
        "tris": stats_after["tris"], "verts": stats_after["verts"],
        "size_m": [round(float(x), 5) for x in (hi1 - lo1)], "height_before_m": round(height, 5),
        "meshes": [o.name for o in targets], "dirty": sorted(dirty),
    }
    return {"outputs": outputs, "stats": stats, "checks": checks, "warnings": warnings}
