"""face_fix - the executor of the face checker's instructions (face_report.json -> fixed model).

    python face_fix.py --model <in.blend> --report <face_report.json> --refs <in/ folder> --out <folder>
        [--blender <blender>] [--crop 0.45] [--force] [--no-render]
    -> <out>/painted.blend, archer_painted.glb, face_fix.log, before_after.jpg, face_fix_result.json

Python: numpy + Pillow (+ scipy for soft edges and UV-field filling; PIL fallback without it).
Example: <studio python> scripts/qa/face_fix.py ...

The face_report.json contract - see the task (defects[].instruction.{action, params}). Application order:
geometry_warp -> reproject -> inpaint_from_ref -> recolor -> fill_seam. Each defect is applied once: the key
"iteration:id:action" goes into the model's history (custom property face_fix_history); rerunning the same
report changes nothing (--force lifts the guard).

Coordinates: bbox_render / zone_mask are pixels of the view's 800x800 frame (see face_views.py). When the
checker attached its render (views[v].render) and its frame differs from the canonical one, bboxes are
mapped into our frame by silhouette matching. Reference alignment: views[v].align {scale, dx, dy}
(frame = scale * ref800 + (dx, dy)); without it - our own silhouette fit. params.camera: either
{yaw, pitch, scale, dx, dy} (the view frame) or an AstraForge concept camera
{px_per_m, offset_px, centre, yaw_deg, pitch_deg} (pixels of the reference itself).

Russian stays where it is report data: the before/after sheet captions and the text_ru lines passed
through into face_fix_result.json.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import face_views as fv  # noqa: E402

try:
    from scipy import ndimage
except Exception:  # pragma: no cover
    ndimage = None

BLENDER_DEFAULT = (r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" if os.name == "nt" else "blender")
# the order: first the shape (mesh fit to the reference, point shifts), then the whole repaint, zones,
# colour, the palette lock (hair/headband/skin keep only their own colours), seams, and last - blending
# the head cut into the body
ACTION_ORDER = ["geometry_fit", "geometry_warp", "reproject", "inpaint_from_ref", "recolor", "palette_lock", "fill_seam", "blend_cut"]
JOINT_PRIORITY = ["front", "face34_left", "face34_right", "back"]  # who paints first (joint reprojection)
JOINT_SIGMA_DEG = 8.0   # joint reprojection: width of the view-weight gaussian over the normal-to-camera angle (narrow - every view paints its own, no doubled features)
COS_FULL, COS_MIN = math.cos(math.radians(45)), math.cos(math.radians(65))
# the primary view (front) owns faces up to 50 deg to the camera (falloff to 65); temples, ears and side
# strands (faces steeper than 65) go to the 3/4 references with a hard z-buffer occlusion - otherwise the
# front was stretched over the temple into a smear (review r1)
COS_PRI_FULL, COS_PRI_MIN = math.cos(math.radians(50)), math.cos(math.radians(65))
CUT_Z_DEFAULT = 1.515   # the horizontal head cut of archer v4/v5 (Head material above it, the seam shows on the collar)
BG = (214, 214, 224)

FONT_CANDIDATES = (r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\segoeui.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
                   "/usr/share/fonts/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf")


def _font(size, bold=False):
    for f in FONT_CANDIDATES:
        if os.path.isfile(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                continue
    return ImageFont.load_default()


# --------------------------------------------------------------------------- plumbing
class Log:
    def __init__(self, path):
        self.path = path
        self.lines = []
        self.t0 = time.time()

    def __call__(self, msg):
        line = "%7.1fs  %s" % (time.time() - self.t0, msg)
        self.lines.append(line)
        print(line, flush=True)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def run_blender(blender, args, log):
    cmd = [blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "face_fix_bl.py"), "--"] + [str(a) for a in args]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    ok = [l for l in p.stdout.splitlines() if l.startswith("FACEFIX_OK")]
    if p.returncode != 0 or not ok:
        tail = (p.stdout + "\n" + p.stderr)[-3000:]
        log("Blender ERROR (%s): %s" % (args[0], tail))
        raise RuntimeError("Blender %s failed" % args[0])
    log("Blender %s: %s" % (args[0], ok[-1][11:][:300]))
    return ok[-1]


def gauss(a, sigma):
    if sigma <= 0:
        return a
    if ndimage is not None:
        return ndimage.gaussian_filter(a.astype(np.float32), sigma, mode="nearest")
    from PIL import ImageFilter
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").filter(ImageFilter.GaussianBlur(sigma)), np.float32)


def feather(mask, px):
    """Mask 0/1 -> soft mask: 1 inside, decays to 0 over px pixels outward."""
    m = mask.astype(np.float32)
    if px <= 0:
        return m
    if ndimage is not None:
        dist = ndimage.distance_transform_edt(~mask.astype(bool))
        return np.clip(1.0 - dist / float(px), 0, 1).astype(np.float32)
    return np.clip(gauss(m, px / 2.0) * 1.5, 0, 1)


def dilate(mask, px):
    if px <= 0:
        return mask.astype(bool)
    if ndimage is not None:
        return ndimage.distance_transform_edt(~mask.astype(bool)) <= px
    return gauss(mask.astype(np.float32), px / 2.0) > 0.05


def erode(mask, px):
    if px <= 0:
        return mask.astype(bool)
    if ndimage is not None:
        return ndimage.distance_transform_edt(mask.astype(bool)) > px
    return gauss(mask.astype(np.float32), px / 2.0) > 0.95


def bilinear(img, x, y):
    """img (H,W,C) float, x/y are pixel coordinates (centre = +0.5). Outside the frame - nearest edge."""
    H, W = img.shape[:2]
    fx = np.clip(x - 0.5, 0, W - 1)
    fy = np.clip(y - 0.5, 0, H - 1)
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    x1 = np.minimum(x0 + 1, W - 1)
    y1 = np.minimum(y0 + 1, H - 1)
    tx = (fx - x0)[..., None] if img.ndim == 3 else (fx - x0)
    ty = (fy - y0)[..., None] if img.ndim == 3 else (fy - y0)
    return (img[y0, x0] * (1 - tx) * (1 - ty) + img[y0, x1] * tx * (1 - ty) + img[y1, x0] * (1 - tx) * ty + img[y1, x1] * tx * ty)


def srgb_to_lab(rgb):
    c = np.clip(np.asarray(rgb, np.float64) / 255.0, 0, 1)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def lab_to_srgb(lab):
    lab = np.asarray(lab, np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx, fz = fy + lab[..., 1] / 500, fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], axis=-1)
    xyz = np.where(f ** 3 > 0.008856, f ** 3, (f - 16.0 / 116.0) / 7.787) * np.array([0.95047, 1.0, 1.08883])
    Mi = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
    lin = np.clip(xyz @ Mi.T, 0, 1)
    c = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(c * 255.0, 0, 255)


def rasterize(P2, size_xy, depth=None, pad=0.01):
    """P2 (T,3,2) - pixel coordinates of triangle vertices (x right, y down).
    -> TRI (H,W) int32 (-1 = empty), B0, B1 (barycentrics), Z (depth when depth (T,3) is given: nearer wins)."""
    W, H = size_xy
    TRI = -np.ones((H, W), np.int32)
    B0 = np.zeros((H, W), np.float32)
    B1 = np.zeros((H, W), np.float32)
    Z = np.full((H, W), np.inf, np.float32)
    for i in range(len(P2)):
        q = P2[i]
        x0, x1 = int(max(math.floor(q[:, 0].min()), 0)), int(min(math.ceil(q[:, 0].max()) + 1, W))
        y0, y1 = int(max(math.floor(q[:, 1].min()), 0)), int(min(math.ceil(q[:, 1].max()) + 1, H))
        if x1 <= x0 or y1 <= y0:
            continue
        (ax, ay), (bx, by), (cx, cy) = q
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        w0 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / den
        w1 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / den
        w2 = 1 - w0 - w1
        m = (w0 >= -pad) & (w1 >= -pad) & (w2 >= -pad)
        if not m.any():
            continue
        if depth is not None:
            z = w0 * depth[i, 0] + w1 * depth[i, 1] + w2 * depth[i, 2]
            m &= z < Z[y0:y1, x0:x1]
            Z[y0:y1, x0:x1][m] = z[m]
        TRI[y0:y1, x0:x1][m] = i
        B0[y0:y1, x0:x1][m] = w0[m]
        B1[y0:y1, x0:x1][m] = w1[m]
    return TRI, B0, B1, Z


def fit_mask_transform(src, dst, scales=None, window_rows=None):
    """Find (scale, dx, dy): dst ~= T(src), T(x) = scale * x + (dx, dy) in dst frame pixels (H,W).
    Scale sweep + cross-correlation (FFT) on downsampled masks, criterion - IoU inside the frame window
    (only rows < window_rows, i.e. the head without shoulders when the window is given)."""
    H, W = dst.shape
    k = 4
    dst = dst.copy()
    if window_rows is not None:
        dst[int(window_rows):, :] = False
    d_small = np.asarray(Image.fromarray(dst.astype(np.uint8) * 255).resize((W // k, H // k), Image.BOX), np.float32) / 255
    best = (0.0, 1.0, 0.0, 0.0)
    if scales is None:
        scales = np.arange(0.5, 1.61, 0.02)
    sh, sw = d_small.shape
    wh = sh if window_rows is None else min(sh, int(window_rows) // k)
    for s in scales:
        sz = (max(1, int(round(src.shape[1] * s / k))), max(1, int(round(src.shape[0] * s / k))))
        s_small = np.asarray(Image.fromarray(src.astype(np.uint8) * 255).resize(sz, Image.BOX), np.float32) / 255
        ph, pw = max(sh, s_small.shape[0]) * 2, max(sw, s_small.shape[1]) * 2
        A = np.zeros((ph, pw), np.float32)
        B = np.zeros((ph, pw), np.float32)
        A[:sh, :sw] = d_small
        B[:s_small.shape[0], :s_small.shape[1]] = s_small
        corr = np.fft.irfft2(np.fft.rfft2(A) * np.conj(np.fft.rfft2(B)), s=(ph, pw))
        iy, ix = np.unravel_index(int(np.argmax(corr)), corr.shape)
        if iy > ph // 2:
            iy -= ph
        if ix > pw // 2:
            ix -= pw
        inter = float(corr[iy % ph, ix % pw])
        # union inside the frame window: dst + shifted src clipped by the frame
        ys0, xs0 = max(iy, 0), max(ix, 0)
        ys1, xs1 = min(iy + s_small.shape[0], wh), min(ix + s_small.shape[1], sw)
        src_in = float(s_small[ys0 - iy:ys1 - iy, xs0 - ix:xs1 - ix].sum()) if (ys1 > ys0 and xs1 > xs0) else 0.0
        union = float(d_small.sum()) + src_in - inter
        iou = inter / max(union, 1.0)
        if iou > best[0]:
            best = (iou, float(s), float(ix * k), float(iy * k))
    iou, s, dx, dy = best
    # refine the shift at full resolution (+/-k px)
    sz = (max(1, int(round(src.shape[1] * s))), max(1, int(round(src.shape[0] * s))))
    s_full = np.asarray(Image.fromarray(src.astype(np.uint8) * 255).resize(sz, Image.BOX)) > 127
    bestf = (iou, dx, dy)
    for ddy in range(-k, k + 1):
        for ddx in range(-k, k + 1):
            v = place_iou(s_full, dst, dx + ddx, dy + ddy, window_rows)
            if v > bestf[0]:
                bestf = (v, dx + ddx, dy + ddy)
    return {"scale": s, "dx": bestf[1], "dy": bestf[2], "iou": round(bestf[0], 4), "method": "silhouette-fft"}


def place_iou(src, dst, dx, dy, window_rows=None):
    H, W = dst.shape
    canvas = np.zeros_like(dst)
    x0, y0 = int(round(dx)), int(round(dy))
    sx0, sy0 = max(0, -x0), max(0, -y0)
    tx0, ty0 = max(0, x0), max(0, y0)
    w = min(src.shape[1] - sx0, W - tx0)
    h = min(src.shape[0] - sy0, H - ty0)
    if w <= 0 or h <= 0:
        return 0.0
    canvas[ty0:ty0 + h, tx0:tx0 + w] = src[sy0:sy0 + h, sx0:sx0 + w]
    if window_rows is not None:
        canvas = canvas[:int(window_rows)]
        dst = dst[:int(window_rows)]
    return float((canvas & dst).sum()) / max(float((canvas | dst).sum()), 1.0)


def edge_map(gray, mask, sigma=1.5):
    g = gauss(gray.astype(np.float32), sigma)
    gy, gx = np.gradient(g)
    e = np.hypot(gx, gy) * mask
    return e / (float(e[mask].std()) + 1e-6) if mask.any() else e


def ncc_shift(A, B, max_shift=40):
    """The shift (dx, dy) at which B, moved by it, correlates best with A (no rotation). -> dx, dy, score"""
    H, W = A.shape
    A = A - A.mean()
    B = B - B.mean()
    corr = np.fft.irfft2(np.fft.rfft2(A, s=(2 * H, 2 * W)) * np.conj(np.fft.rfft2(B, s=(2 * H, 2 * W))), s=(2 * H, 2 * W))
    sh = np.arange(-max_shift, max_shift + 1)
    sub = corr[np.ix_(sh % (2 * H), sh % (2 * W))]
    iy, ix = np.unravel_index(int(np.argmax(sub)), sub.shape)
    score = float(sub[iy, ix]) / (float(np.linalg.norm(A)) * float(np.linalg.norm(B)) + 1e-9)
    return float(sh[ix]), float(sh[iy]), score


def face_mask(img, head_cut_row):
    """The face-features region for alignment: skin (R > B, warm) eroded 6 px inside the silhouette, above
    the cut row; when there is little skin (back of the head) - the whole silhouette without its edge."""
    a = alpha_mask(img)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    skin = a & (r > b + 25) & (r > g + 5) & (r > 90)
    skin[int(head_cut_row):, :] = False
    if skin.sum() > 3000:
        m = erode(dilate(skin, 6) & a, 3)
    else:
        m = erode(a, 5)
    m[int(head_cut_row):, :] = False
    return m


def align_edge_score(ref, align, render, head_cut_row, size):
    """The face-features edge NCC for a given alignment (without a search)."""
    rm = face_mask(render, head_cut_row)
    w = warp_ref(ref, align, size)
    wm = face_mask(w, head_cut_row)
    if rm.sum() < 500 or wm.sum() < 500:
        return 0.0
    return ncc_shift(edge_map(render[..., :3].mean(2), rm), edge_map(w[..., :3].mean(2), wm), max_shift=0)[2]


def refine_align_edges(ref, align0, render, head_cut_row, size, scale_span=0.2, step=0.02, max_shift=80):
    """Alignment refinement by the face-feature edges (gradients in the skin region, above the cut row):
    scale sweep around align0 keeping the head centre + shift by cross-correlation. -> align, score"""
    rm = face_mask(render, head_cut_row)
    if rm.sum() < 500:
        return dict(align0), 0.0
    A = edge_map(render[..., :3].mean(2), rm)
    k = float(size) / max(ref.shape[:2])
    ys, xs = np.nonzero(alpha_mask(ref))
    pc = np.array([xs.mean() * k, ys.mean() * k])                      # reference centre in ref800
    fc = align0["scale"] * pc + np.array([align0["dx"], align0["dy"]])  # its place in the frame - keep it
    best = (-1.0, dict(align0))
    scales = np.arange(align0["scale"] * (1 - scale_span), align0["scale"] * (1 + scale_span) + 1e-9, step * align0["scale"])
    for s in scales:
        dx, dy = fc - s * pc
        w = warp_ref(ref, {"scale": s, "dx": dx, "dy": dy}, size)
        wm = face_mask(w, head_cut_row)
        if wm.sum() < 500:
            continue
        B = edge_map(w[..., :3].mean(2), wm)
        sdx, sdy, score = ncc_shift(A, B, max_shift)
        if score > best[0]:
            best = (score, {"scale": float(s), "dx": float(dx + sdx), "dy": float(dy + sdy)})
    score, al = best
    # fine scale polish
    for s in np.arange(al["scale"] - 0.015, al["scale"] + 0.0151, 0.005):
        dx, dy = fc - s * pc
        w = warp_ref(ref, {"scale": s, "dx": dx, "dy": dy}, size)
        wm = face_mask(w, head_cut_row)
        if wm.sum() < 500:
            continue
        B = edge_map(w[..., :3].mean(2), wm)
        sdx, sdy, sc = ncc_shift(A, B, max_shift=12)
        if sc > score:
            score, al = sc, {"scale": float(s), "dx": float(dx + sdx), "dy": float(dy + sdy)}
    al["edge_ncc"] = round(score, 4)
    al["method"] = "silhouette-fft+edge-ncc"
    return al, score


def postwarp_renders(prefix, posts):
    """The checker camera's raw renders -> its frame (post affine, continuous coordinates, pixel centre +0.5)."""
    for name, (M, size) in posts.items():
        path = "%s_%s.png" % (prefix, name)
        if not os.path.isfile(path):
            continue
        A = np.vstack([np.asarray(M, np.float64), [0.0, 0.0, 1.0]])
        inv = np.linalg.inv(A)
        im = Image.open(path).convert("RGBA")
        out = im.transform((size, size), Image.AFFINE, tuple(inv[:2].ravel()), Image.BILINEAR)
        out.save(path)


def load_rgba(path):
    return np.asarray(Image.open(path).convert("RGBA"), np.float32)


def alpha_mask(img):
    return img[..., 3] > 127


def warp_ref(ref, align, size):
    """Reference -> size x size frame by align (scale, dx, dy): frame = scale * ref * k + (dx, dy), k = size / max(W,H)."""
    k = float(size) / max(ref.shape[:2])
    s = align["scale"] * k
    im = Image.fromarray(np.clip(ref, 0, 255).astype(np.uint8), "RGBA")
    out = im.transform((size, size), Image.AFFINE, (1 / s, 0, -align["dx"] / s, 0, 1 / s, -align["dy"] / s), Image.BILINEAR)
    return np.asarray(out, np.float32)


# --------------------------------------------------------------------------- model
class Model:
    def __init__(self, npz_path, log):
        d = np.load(npz_path)
        self.V = d["V"].astype(np.float64)
        self.F = d["F"].astype(np.int64)
        self.L = d["L"].astype(np.int64) if "L" in d else None   # per-loop triangle indices (UV is per-loop)
        self.UV = d["UV"].astype(np.float64)
        self.MAT = d["MAT"].astype(np.int64)
        self.meta = json.loads(str(d["meta"]))
        self.disp = np.zeros_like(self.V)
        self.log = log
        self.tex = {}        # material index -> float32 (S,S,3)
        self.raster = {}     # material index -> dict(TRI,B0,B1,COV,P,N,ys,xs,refill)
        self.modified = {}   # material index -> bool mask of touched texels
        mats = self.meta["materials"]
        for m in mats:
            if m.get("image"):
                self.tex[m["index"]] = np.asarray(Image.open(m["image"]).convert("RGB"), np.float32)
        head = [m for m in mats if m["name"].lower() == "head"]
        self.head_mat = head[0]["index"] if head else next(iter(self.tex))   # one material: the whole mesh is the "head"
        hv = self.V[self.F[self.MAT == self.head_mat]].reshape(-1, 3)
        self.zc = float(hv[:, 2].min()) if len(hv) else fv.HEAD_CUT_Z
        self.zmax = float(self.V[:, 2].max())
        self.zmin = float(self.V[:, 2].min())
        self.cx = float((self.V[:, 0].max() + self.V[:, 0].min()) / 2)
        self.head_h = self.zmax - self.zc
        log("model: %d vertices, %d triangles, maps %s, head z>=%.3f (height %.3f m), zmax %.3f" %
            (len(self.V), len(self.F), {m["name"]: m.get("size") for m in mats}, self.zc, self.head_h, self.zmax))

    def positions(self):
        return self.V + self.disp

    def face_normals(self):
        P = self.positions()[self.F]
        n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)

    def vertex_normals(self):
        fn = np.cross(self.positions()[self.F[:, 1]] - self.positions()[self.F[:, 0]],
                      self.positions()[self.F[:, 2]] - self.positions()[self.F[:, 0]])
        vn = np.zeros_like(self.V)
        for k in range(3):
            np.add.at(vn, self.F[:, k], fn)
        return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)

    def texels(self, mat):
        """UV rasterization of a material: for every covered texel - the triangle, position, normal."""
        if mat in self.raster:
            r = self.raster[mat]
            r["P"] = self._texel_positions(mat, r)
            r["N"] = self.face_normals()[r["t"]]
            return r
        S = self.tex[mat].shape[0]
        idx = np.nonzero(self.MAT == mat)[0]
        uv = self.UV[idx].copy()   # UV is per-triangle (the exporter gathered it by loop indices)
        P2 = np.stack([uv[..., 0] * S, (1 - uv[..., 1]) * S], axis=-1)
        TRI, B0, B1, _ = rasterize(P2, (S, S))
        COV = TRI >= 0
        ys, xs = np.nonzero(COV)
        r = {"S": S, "TRI": TRI, "COV": COV, "ys": ys, "xs": xs, "t": idx[TRI[ys, xs]],
             "b0": np.clip(B0[ys, xs], 0, 1).astype(np.float64), "b1": np.clip(B1[ys, xs], 0, 1).astype(np.float64)}
        r["b2"] = np.clip(1 - r["b0"] - r["b1"], 0, 1)
        if ndimage is not None:
            _, ind = ndimage.distance_transform_edt(~COV, return_indices=True)
            r["refill"] = ind
        self.raster[mat] = r
        self.modified.setdefault(mat, np.zeros((S, S), bool))
        r["P"] = self._texel_positions(mat, r)
        r["N"] = self.face_normals()[r["t"]]
        self.log("map %s: %d x %d, covered %d texels (%.1f%%)" % (self.mat_name(mat), S, S, len(ys), 100.0 * len(ys) / S / S))
        return r

    def _texel_positions(self, mat, r):
        P = self.positions()[self.F[r["t"]]]
        return P[:, 0] * r["b0"][:, None] + P[:, 1] * r["b1"][:, None] + P[:, 2] * r["b2"][:, None]

    def mat_name(self, mat):
        for m in self.meta["materials"]:
            if m["index"] == mat:
                return m["name"]
        return str(mat)

    def finish_textures(self):
        """Fill empty texels next to modified ones (nearest covered) so bilinear sampling does not drag
        the old colour out of the islands."""
        for mat, mod in self.modified.items():
            if not mod.any():
                continue
            r = self.raster[mat]
            if "refill" not in r:
                continue
            near = dilate(mod, 8) & ~r["COV"]
            iy, ix = r["refill"]
            T = self.tex[mat]
            T[near] = T[iy[near], ix[near]]
            self.log("map %s: filled empty texels along island borders: %d" % (self.mat_name(mat), int(near.sum())))


# --------------------------------------------------------------------------- views
class View:
    """A view frame: canonical camera, z-buffer, the reference and its alignment, the checker's render -> our frame."""

    def __init__(self, name, model, report_view, refs_dir, crop, log, align_override=None, render_png=None):
        self.name = fv.canon_view(name)
        self.model = model
        self.log = log
        self.cam = fv.view_camera(self.name, model.zmax, model.cx, crop=crop)
        self.size = self.cam["size"]
        self.render = load_rgba(render_png) if render_png and os.path.isfile(render_png) else None
        rv = report_view or {}
        ref_path = rv.get("ref")
        if not ref_path or not os.path.isfile(ref_path):
            ref_path = os.path.join(refs_dir or "", fv.VIEWS[self.name]["ref"])
        self.ref_path = ref_path if os.path.isfile(ref_path) else None
        self.ref = load_rgba(self.ref_path) if self.ref_path else None
        if self.ref is not None:
            a = self.ref[..., 3:4] / 255.0
            self.ref_rgb = np.where(a > 0.02, self.ref[..., :3] / np.maximum(a, 0.02), 0)   # undo premultiply
            self.ref_rgb = np.clip(self.ref_rgb, 0, 255)
            self.ref_a = self.ref[..., 3] / 255.0
        self.mask = None          # silhouette of our frame (from the z-buffer)
        self.frame_xf = {"scale": 1.0, "dx": 0.0, "dy": 0.0, "iou": 1.0, "method": "identity"}
        self.align = None
        self.frame_mode = False   # True: work directly in the checker's frame (its camera + post affine)
        fc = ((align_override or rv.get("align")) or {}).get("frame_camera")
        if fc and fc.get("post") is not None and fc.get("centre") is not None:
            self.cam = {"view": self.name, "yaw": float(fc["yaw"]), "pitch": float(fc.get("pitch", 0.0)), "centre": [float(c) for c in fc["centre"]],
                        "px_per_m": float(fc["px_per_m"]), "raw_size": int(fc.get("raw_size", 1600)), "size": int(fc.get("size", fv.SIZE)),
                        "post": [[float(x) for x in row] for row in fc["post"]], "distance": 6.0}
            self.cam["ortho_scale"] = self.cam["raw_size"] / self.cam["px_per_m"]
            self.size = self.cam["size"]
            self.frame_mode = True
            self._zbuf()
            # the reference is already aligned into this frame by the checker: ref800 = ref * k, no shift
            self.align = {"scale": 1.0, "dx": 0.0, "dy": 0.0, "iou": None, "method": "frame_camera"}
            if self.ref is not None:
                rm = alpha_mask(self.ref)
                k = float(self.size) / max(rm.shape)
                rm800 = np.asarray(Image.fromarray(rm.astype(np.uint8) * 255).resize((int(round(rm.shape[1] * k)), int(round(rm.shape[0] * k))), Image.BOX)) > 127
                self.align["iou"] = round(place_iou(rm800, self.mask, 0, 0, self.head_cut_row), 4)
            chk = rv.get("render")
            chk_iou = None
            if chk and os.path.isfile(chk):
                om = alpha_mask(load_rgba(chk))
                if om.shape == self.mask.shape:
                    # compare only inside the footprint of the checker's raw frame (it is smaller than the
                    # 800 frame at the edges where we see the whole model)
                    A = np.vstack([np.asarray(self.cam["post"], np.float64), [0.0, 0.0, 1.0]])
                    inv = np.linalg.inv(A)
                    ones = Image.new("L", (self.cam["raw_size"], self.cam["raw_size"]), 255)
                    foot = np.asarray(ones.transform((self.size, self.size), Image.AFFINE, tuple(inv[:2].ravel()), Image.NEAREST)) > 127
                    foot = erode(foot, 3)
                    inter = float((om & self.mask & foot).sum())
                    union = float(((om | self.mask) & foot).sum())
                    chk_iou = inter / max(union, 1.0)
            self.log("view %s: checker frame (yaw %.1f, %.0f px/m, post %s); IoU of our silhouette with its render %s, with the reference %s" %
                     (self.name, self.cam["yaw"], fv.frame_px_per_m(self.cam), [[round(x, 3) for x in row] for row in self.cam["post"]],
                      "%.3f" % chk_iou if chk_iou is not None else "-", self.align["iou"]))
            if chk_iou is not None and chk_iou < 0.9:
                self.log("view %s: WARNING - the frame camera does not match the checker's render (IoU %.3f)" % (self.name, chk_iou))
            return
        self._zbuf()
        self._frame_transform(rv.get("render"))
        self._align(align_override or rv.get("align"))

    def _zbuf(self):
        m = self.model
        P = m.positions()
        u, v, z = fv.project(self.cam, P)
        self.k = 2
        S = self.size * self.k
        P2 = np.stack([u[m.F] * self.k, v[m.F] * self.k], axis=-1)
        TRI, _, _, Z = rasterize(P2, (S, S), depth=z[m.F])
        self.Z = Z
        self.mask = np.asarray(Image.fromarray((TRI >= 0).astype(np.uint8) * 255).resize((self.size, self.size), Image.BOX)) > 127
        # head bbox in the frame: the silhouette above the cut row
        _, vc, _ = fv.project(self.cam, np.array([[m.cx, 0, m.zc]]))
        self.head_cut_row = int(min(max(vc[0], 0), self.size))
        hm = self.mask.copy()
        hm[self.head_cut_row:, :] = False
        hy, hx = np.nonzero(hm)
        self.head_bbox = (float(hx.min()), float(hy.min()), float(hx.max() + 1), float(hy.max() + 1)) if len(hy) else (0, 0, self.size, self.size)

    def _frame_transform(self, render_path):
        if not render_path or not os.path.isfile(render_path):
            return
        other = load_rgba(render_path)
        om = alpha_mask(other)
        if om.shape == self.mask.shape and place_iou(om, self.mask, 0, 0) > 0.97:
            self.log("view %s: the checker frame matches ours (IoU %.3f)" % (self.name, place_iou(om, self.mask, 0, 0)))
            return
        self.frame_xf = fit_mask_transform(om, self.mask)
        self.log("view %s: checker frame -> ours: scale %.3f dx %.1f dy %.1f (IoU %.3f)" %
                 (self.name, self.frame_xf["scale"], self.frame_xf["dx"], self.frame_xf["dy"], self.frame_xf["iou"]))

    def _align(self, given):
        if self.ref is None:
            self.log("view %s: no reference" % self.name)
            return
        rm = alpha_mask(self.ref)
        k = float(self.size) / max(rm.shape)
        rm800 = np.asarray(Image.fromarray(rm.astype(np.uint8) * 255).resize((int(round(rm.shape[1] * k)), int(round(rm.shape[0] * k))), Image.BOX)) > 127
        win = self.head_cut_row
        own = fit_mask_transform(rm800, self.mask, window_rows=win)
        chosen, src = own, "own silhouette fit"
        own_edge = None
        if self.render is not None:
            refined, score = refine_align_edges(self.ref, own, self.render, win, self.size)
            sz = (max(1, int(round(rm800.shape[1] * refined["scale"]))), max(1, int(round(rm800.shape[0] * refined["scale"]))))
            refined["iou"] = place_iou(np.asarray(Image.fromarray(rm800.astype(np.uint8) * 255).resize(sz, Image.BOX)) > 127, self.mask, refined["dx"], refined["dy"], win)
            self.log("view %s: face-edge refinement: scale %.3f -> %.3f, shift (%.0f, %.0f) -> (%.0f, %.0f), NCC %.3f" %
                     (self.name, own["scale"], refined["scale"], own["dx"], own["dy"], refined["dx"], refined["dy"], score))
            own, own_edge = refined, score
            chosen = own
        if given and all(key in given for key in ("scale", "dx", "dy")):
            g = {"scale": float(given["scale"]), "dx": float(given["dx"]), "dy": float(given["dy"])}
            # the checker frame may differ from ours: map across
            xf = self.frame_xf
            g = {"scale": g["scale"] * xf["scale"], "dx": g["dx"] * xf["scale"] + xf["dx"], "dy": g["dy"] * xf["scale"] + xf["dy"]}
            sz = (max(1, int(round(rm800.shape[1] * g["scale"]))), max(1, int(round(rm800.shape[0] * g["scale"]))))
            g["iou"] = place_iou(np.asarray(Image.fromarray(rm800.astype(np.uint8) * 255).resize(sz, Image.BOX)) > 127, self.mask, g["dx"], g["dy"], win)
            take = g["iou"] >= own["iou"] - 0.03
            if self.render is not None and own_edge is not None:
                # compare by edges: whose face-feature correlation is higher
                g_edge = align_edge_score(self.ref, g, self.render, win, self.size)
                g["edge_ncc"] = round(g_edge, 4)
                take = g_edge >= own_edge - 0.02
            if take:
                chosen, src = g, "from the report (%s)" % given.get("method", "")
        self.align = chosen
        self.log("view %s: reference %s, alignment %s: scale %.3f dx %.1f dy %.1f, silhouette IoU %.3f (own %.3f)" %
                 (self.name, os.path.basename(self.ref_path), src, chosen["scale"], chosen["dx"], chosen["dy"], chosen["iou"], own["iou"]))

    def derive(self, yaw, pitch, align=None):
        """The same view/reference, but a camera with an explicit yaw/pitch (and, when given, its own alignment)."""
        v2 = View.__new__(View)
        v2.name, v2.model, v2.log = self.name, self.model, self.log
        v2.cam = dict(self.cam, yaw=float(yaw), pitch=float(pitch))
        v2.size = self.size
        v2.ref, v2.ref_path, v2.render = self.ref, self.ref_path, None
        if self.ref is not None:
            v2.ref_rgb, v2.ref_a = self.ref_rgb, self.ref_a
        v2.frame_xf = dict(self.frame_xf)
        v2.align = None
        v2._zbuf()
        v2._align(align)
        return v2

    # -- mappings
    def to_frame(self, P):
        return fv.project(self.cam, P)

    def frame_to_world_z(self, v_px):
        """A frame row (orthographic camera without tilt) -> world height z of the surface at that row."""
        c = self.cam
        v = float(v_px)
        M = c.get("post")
        if M is not None:
            A = np.vstack([np.asarray(M, np.float64), [0.0, 0.0, 1.0]])
            inv = np.linalg.inv(A)
            # the column does not matter for z (up = Z at pitch 0): take the frame centre
            raw = inv @ np.array([self.size / 2.0, v, 1.0])
            v_raw, half = raw[1], c.get("raw_size", self.size) / 2.0
        else:
            v_raw, half = v, self.size / 2.0
        return float(c["centre"][2] + (half - v_raw) / c["px_per_m"])

    def visible(self, P, N, tol_m=0.003):
        """Visibility of surface points: facing the camera and not occluded (z-buffer)."""
        u, v, z = self.to_frame(P)
        facing = N @ fv.toward(self.cam)
        ui = np.clip((u * self.k).astype(np.int64), 0, self.Z.shape[1] - 1)
        vi = np.clip((v * self.k).astype(np.int64), 0, self.Z.shape[0] - 1)
        occl = z <= self.Z[vi, ui] + tol_m
        return u, v, facing, occl & (facing > 0)

    def ref_sample(self, u, v, cam_override=None, P=None):
        """Reference colour for frame points (u, v) (or 3D points P under the concept camera). -> rgb (n,3), alpha (n,)"""
        if self.ref is None:
            raise RuntimeError("view %s: reference not found" % self.name)
        if cam_override and "px_per_m" in cam_override and P is not None:
            c = cam_override
            r, up, _ = fv.basis(c.get("yaw_deg", c.get("yaw", fv.VIEWS[self.name]["yaw"])), c.get("pitch_deg", c.get("pitch", 0.0)))
            Q = np.asarray(P, np.float64) - np.asarray(c.get("centre", [0, 0, 0]), np.float64)
            off = c.get("offset_px") or [0, 0]
            rx = c["px_per_m"] * (Q @ r) + off[0]
            ry = -c["px_per_m"] * (Q @ up) + off[1]
        else:
            a = dict(self.align)
            if cam_override:
                for key in ("scale", "dx", "dy"):
                    if key in cam_override:
                        a[key] = float(cam_override[key])
            k = float(self.size) / max(self.ref.shape[:2])
            rx = (u - a["dx"]) / (a["scale"] * k)
            ry = (v - a["dy"]) / (a["scale"] * k)
        rgb = bilinear(self.ref_rgb, rx, ry)
        alpha = bilinear(self.ref_a, rx, ry)
        inside = (rx >= 0) & (ry >= 0) & (rx < self.ref.shape[1]) & (ry < self.ref.shape[0])
        return rgb, alpha * inside

    def ref_in_frame(self):
        return warp_ref(self.ref, self.align, self.size) if self.ref is not None and self.align else None

    def bbox_to_frame(self, bbox):
        xf = self.frame_xf
        x, y, w, h = [float(t) for t in bbox]
        return [x * xf["scale"] + xf["dx"], y * xf["scale"] + xf["dy"], w * xf["scale"], h * xf["scale"]]

    def zone_mask(self, defect, params, soft_px=6.0, grow_px=0.0):
        """The zone mask in our frame (float 0..1) + bbox [x,y,w,h] in our frame."""
        S = self.size
        zm = params.get("zone_mask")
        bbox = None
        hard = None
        if isinstance(zm, str) and os.path.isfile(zm):
            im = np.asarray(Image.open(zm).convert("L"), np.float32) / 255.0
            xf = self.frame_xf
            if im.shape != (S, S) or xf["method"] != "identity":
                pil = Image.fromarray((im * 255).astype(np.uint8))
                s = xf["scale"] * (S / max(im.shape)) if im.shape != (S, S) else xf["scale"]
                pil = pil.transform((S, S), Image.AFFINE, (1 / s, 0, -xf["dx"] / s, 0, 1 / s, -xf["dy"] / s), Image.BILINEAR)
                im = np.asarray(pil, np.float32) / 255.0
            hard = im > 0.5
            ys, xs = np.nonzero(hard)
            if len(ys):
                bbox = [float(xs.min()), float(ys.min()), float(xs.max() - xs.min() + 1), float(ys.max() - ys.min() + 1)]
        elif isinstance(zm, (list, tuple)) and len(zm) == 4:
            bbox = self.bbox_to_frame(zm)
        if bbox is None and defect.get("bbox_render"):
            bbox = self.bbox_to_frame(defect["bbox_render"])
        if bbox is None and defect.get("bbox_ref") and self.align:
            x, y, w, h = [float(t) for t in defect["bbox_ref"]]
            a, k = self.align, float(S) / max(self.ref.shape[:2])
            bbox = [x * k * a["scale"] + a["dx"], y * k * a["scale"] + a["dy"], w * k * a["scale"], h * k * a["scale"]]
        if bbox is None:
            bbox = fv.zone_bbox(defect.get("zone", ""), self.head_bbox)
            if bbox is None:
                raise RuntimeError("defect %s: no bbox/zone_mask and unknown zone %r" % (defect.get("id"), defect.get("zone")))
            self.log("defect %s: bbox not given, zone %s by table: %s" % (defect.get("id"), defect.get("zone"), [round(t) for t in bbox]))
        if hard is None:
            hard = np.zeros((S, S), bool)
            x, y, w, h = bbox
            x0, y0 = int(max(math.floor(x - grow_px), 0)), int(max(math.floor(y - grow_px), 0))
            x1, y1 = int(min(math.ceil(x + w + grow_px), S)), int(min(math.ceil(y + h + grow_px), S))
            hard[y0:y1, x0:x1] = True
        elif grow_px > 0:
            hard = dilate(hard, grow_px)
        return feather(hard, soft_px), hard, bbox


# --------------------------------------------------------------------------- actions
class Fixer:
    def __init__(self, model, views, log, stats, class_tex=None, work=None):
        self.m, self.views, self.log, self.stats = model, views, log, stats
        self.class_tex_path = class_tex   # the Head map for the skin/hair classification in the mesh fit (the source paint)
        self.work = work
        self._ref_cls = {}                # view name -> (class map 800x800 int8, alpha bool, class medians, rgb)

    # ---- 0. geometry_fit - fit the head mesh to the reference silhouette and anchor rows (front)
    def geometry_fit(self, defect, params):
        import face_geom  # noqa: E402
        view = self.view(defect, {"view": params.get("view") or defect.get("view") or "front"})
        if view.ref is None:
            raise RuntimeError("geometry_fit: view %s has no reference" % view.name)
        path = params.get("class_tex") or self.class_tex_path
        if path and os.path.isfile(path):
            class_tex = np.asarray(Image.open(path).convert("RGB"), np.float32)
            src = path
        else:
            class_tex = self.m.tex[self.m.head_mat]
            src = "the current Head map"
        S = self.m.tex[self.m.head_mat].shape[0]
        if class_tex.shape[0] != S:
            class_tex = np.asarray(Image.fromarray(class_tex.astype(np.uint8)).resize((S, S), Image.BILINEAR), np.float32)
        self.log("defect %s: geometry_fit @%s, skin/hair classification from %s" % (defect.get("id"), view.name, src))
        dbg = os.path.join(self.work, "geom_fit_%s.png" % view.name) if self.work else None
        res = face_geom.fit_head(self.m, view, class_tex, ref_rows=params.get("ref_rows"), log=self.log, debug_png=dbg,
                                 max_share=float(params.get("max_share", 0.18)))
        for vw in self.views.values():
            vw._zbuf()
        pts = self.m.positions()[np.linalg.norm(self.m.disp, axis=1) > 1e-6]
        res.update({"_pts": pts, "_grow": 30, "debug": dbg})
        return res

    def view(self, defect, params):
        name = params.get("view") or defect.get("view") or "front"
        name = fv.canon_view(name)
        if name not in self.views:
            raise RuntimeError("view %s is not prepared" % name)
        return self.views[name]

    def frame_cam(self, view, params):
        """The camera for reference sampling: params.camera (yaw/pitch change the projection view) or the view's camera."""
        cam = params.get("camera") or {}
        if getattr(view, "frame_mode", False):
            return {}, view
        if "px_per_m" in cam:
            return cam, view
        if cam.get("yaw") is not None or cam.get("pitch") is not None:
            yaw, pitch = float(cam.get("yaw", view.cam["yaw"])), float(cam.get("pitch", view.cam["pitch"]))
            if abs(yaw - view.cam["yaw"]) > 0.5 or abs(pitch - view.cam["pitch"]) > 0.5:
                given = {k: cam[k] for k in ("scale", "dx", "dy") if k in cam} if "scale" in cam else None
                self.log("projection camera: yaw %.1f pitch %.1f (view %s)" % (yaw, pitch, view.name))
                return cam, view.derive(yaw, pitch, given)
        return cam, view

    # ---- 1. geometry_warp
    def geometry_warp(self, defect, params):
        w = params.get("warp") or {}
        view = self.view(defect, {"view": params.get("view") or w.get("view") or defect.get("view")})
        dx_px, dy_px = float(w.get("dx_px", 0.0)), float(w.get("dy_px", 0.0))
        falloff = float(w.get("falloff_px", 40.0))
        if abs(dx_px) < 1e-6 and abs(dy_px) < 1e-6:
            self.log("defect %s: geometry_warp without a shift - skip" % defect.get("id"))
            return {"vertices": 0}
        soft, hard, bbox = view.zone_mask(dict(defect, zone=w.get("zone", defect.get("zone"))), params, soft_px=0)
        P = self.m.positions()
        Nv = self.m.vertex_normals()
        # for geometry the z-buffer is soft (30 mm): the eye socket under the fringe must move with the
        # brow, the back of the head must not
        u, v, facing, vis = view.visible(P, Nv, tol_m=0.03)
        x, y, bw, bh = bbox
        if hard is not None and hard.any() and ndimage is not None and params.get("zone_mask") is not None:
            # distance to the zone mask itself (a silhouette band), not to its rectangle: otherwise a
            # 100x300 px hair band with a 117 px bbox falloff dragged half the face along
            edt = ndimage.distance_transform_edt(~hard).astype(np.float32)
            dist = bilinear(edt, u, v)
        else:
            ddx = np.maximum(np.maximum(x - u, 0), u - (x + bw))
            ddy = np.maximum(np.maximum(y - v, 0), v - (y + bh))
            dist = np.hypot(ddx, ddy)
        wgt = np.exp(-0.5 * (dist / max(falloff, 1e-6)) ** 2)
        head = P[:, 2] >= self.m.zc - 0.005
        sel = head & (facing > 0.05) & (wgt > 0.02) & vis
        if hard is not None and (params.get("zone_mask") is not None):
            inside = bilinear(soft, u, v) > 0.5
            wgt = np.where(inside, 1.0, wgt)
        wgt = wgt * sel
        ppm = fv.frame_px_per_m(view.cam)
        d = fv.frame_shift_to_world(view.cam, dx_px, dy_px)[None, :]
        disp = wgt[:, None] * d
        limit = 0.04 * self.m.head_h
        mx = float(np.linalg.norm(disp, axis=1).max()) if sel.any() else 0.0
        scale = 1.0
        if mx > limit:
            scale = limit / mx
            disp *= scale
        self.m.disp += disp
        n = int(sel.sum())
        pts = P[wgt > 0.02]
        self.log("defect %s: geometry_warp %s @%s bbox %s: shift (%.1f, %.1f) px = (%.1f, %.1f) mm, falloff %.0f px, vertices %d, "
                 "max %.1f mm (limit %.1f mm%s)" % (defect.get("id"), w.get("zone", defect.get("zone")), view.name, [round(t) for t in bbox],
                                                     dx_px, dy_px, 1000 * dx_px / ppm, -1000 * dy_px / ppm, falloff, n, 1000 * mx * scale, 1000 * limit,
                                                     ", clamped x%.2f" % scale if scale < 1 else ""))
        for vw in self.views.values():
            vw._zbuf()
        return {"vertices": n, "max_mm": round(1000 * mx * scale, 2), "bbox": [round(t, 1) for t in bbox], "_pts": pts, "_grow": falloff * 1.5}

    # ---- reference sampling into texels
    def _project_texels(self, view, params, mat, zone_soft=None, full=False):
        r = self.m.texels(mat)
        cam, pview = self.frame_cam(view, params)
        u, v, facing, vis = pview.visible(r["P"], r["N"])
        if not full and zone_soft is not None:
            uz, vz, _, visz = view.visible(r["P"], r["N"]) if pview is not view else (u, v, facing, vis)
            zw = bilinear(zone_soft, uz, vz) * visz
        else:
            zw = np.ones_like(u)
        fade = np.clip((facing - COS_MIN) / (COS_FULL - COS_MIN), 0, 1)
        wgt = zw * fade * vis
        idx = np.nonzero(wgt > 0.002)[0]
        if len(idx) == 0:
            return r, idx, wgt, None, None
        rgb, a = pview.ref_sample(u[idx], v[idx], cam_override=cam if "px_per_m" in cam else (cam or None), P=r["P"][idx])
        wgt_idx = wgt[idx] * np.clip((a - 0.6) / 0.35, 0, 1)
        return r, idx, wgt_idx, rgb, wgt

    def _mats_for(self, view, zone_hard):
        """Materials whose triangles land in the zone (no body rasterization unless needed)."""
        out = []
        fn = self.m.face_normals()
        P = self.m.positions()
        for mat in self.m.tex:
            tri = np.nonzero(self.m.MAT == mat)[0]
            C = P[self.m.F[tri]].mean(1)
            u, v, _ = view.to_frame(C)
            facing = fn[tri] @ fv.toward(view.cam)
            ui = np.clip(u.astype(np.int64), 0, view.size - 1)
            vi = np.clip(v.astype(np.int64), 0, view.size - 1)
            if ((zone_hard[vi, ui]) & (facing > COS_MIN)).any():
                out.append(mat)
        return out

    # ---- 2/3. reproject, inpaint_from_ref
    def reproject(self, defect, params, full=True):
        view = self.view(defect, params)
        if full:
            soft, hard, bbox = None, view.mask.copy(), None
            soft_apply = None
        else:
            soft, hard, bbox = view.zone_mask(defect, params, soft_px=6.0)
            soft_apply = soft
        total = 0
        pts = []
        for mat in self._mats_for(view, hard if not full else view.mask):
            r, idx, wgt, rgb, _ = self._project_texels(view, params, mat, zone_soft=soft_apply, full=full)
            if rgb is None:
                continue
            pts.append(r["P"][idx][wgt > 0.05][::7])
            T = self.m.tex[mat]
            ys, xs = r["ys"][idx], r["xs"][idx]
            cur = T[ys, xs]
            if not full:
                # brightness fit: the ring around the zone - mean L of the current map vs the reference
                ring_w = bilinear(dilate(hard, 14).astype(np.float32) - hard.astype(np.float32), *view.to_frame(r["P"][idx])[:2])
                ring = ring_w > 0.5
                if ring.sum() > 200:
                    Lc, Lr = srgb_to_lab(cur[ring])[:, 0].mean(), srgb_to_lab(rgb[ring])[:, 0].mean()
                    gain = float(np.clip((Lc + 1) / (Lr + 1), 0.75, 1.35))
                    lab = srgb_to_lab(rgb)
                    lab[:, 0] = np.clip(lab[:, 0] * gain, 0, 100)
                    rgb = lab_to_srgb(lab)
                    self.log("defect %s: reference brightness fitted to the surroundings x%.3f (ring %d texels)" % (defect.get("id"), gain, int(ring.sum())))
            new = cur * (1 - wgt[:, None]) + rgb * wgt[:, None]
            T[ys, xs] = new
            touched = wgt > 0.05
            self.m.modified[mat][ys[touched], xs[touched]] = True
            total += int(touched.sum())
        self.log("defect %s: %s @%s %s: texels moved %d" % (defect.get("id"), "reproject" if full else "inpaint_from_ref",
                                                           view.name, "the whole head" if full else "bbox %s" % [round(t) for t in bbox], total))
        return {"texels": total, "bbox": None if full else [round(t, 1) for t in bbox],
                "_pts": np.concatenate(pts) if pts else np.zeros((0, 3)), "_grow": 12}

    def inpaint_from_ref(self, defect, params):
        return self.reproject(defect, params, full=False)

    def reproject_joint(self, items):
        """Whole reprojection over several views at once: a texel's colour is the weighted mean of all view
        references, applied where the texel is visible to a requested view, so the views do not overwrite
        each other in turn. items: [(defect, params), ...] -> {id: result}"""
        req = {}
        for df, params in items:
            view = self.view(df, params)
            req.setdefault(view.name, []).append(df)
        # view priority: the front owns everything it sees up to a steep angle, 3/4 paints the rest, the
        # back - what is invisible from the front and sides. The GPT references are not 3D-consistent, so a
        # plain mean doubles the features; priority gives the front (50 % of the score, what the owner
        # looks at) an exact match
        src_views = sorted([v for v in self.views.values() if v.ref is not None],
                           key=lambda v: JOINT_PRIORITY.index(v.name) if v.name in JOINT_PRIORITY else 99)
        mats = set()
        for name in req:
            mats |= set(self._mats_for(self.views[name], self.views[name].mask))
        self.log("joint reprojection: requested views %s, sources %s, maps %s" % (
            sorted(req), [v.name for v in src_views], [self.m.mat_name(m) for m in sorted(mats)]))
        results = {df.get("id"): {"texels": 0, "bbox": None, "_pts": [], "_grow": 12} for dfs in req.values() for df in dfs}
        for mat in sorted(mats):
            r = self.m.texels(mat)
            n = len(r["P"])
            num = np.zeros((n, 3), np.float64)
            den = np.zeros(n, np.float64)
            cover = np.zeros(n, np.float64)
            per_view_w = {}
            free = np.ones(n, np.float64)   # the texel share not yet taken by a higher-priority view
            for pri, view in enumerate(src_views):
                # softer z-test (5 mm): at 3 mm edge texels of steep faces were rejected and stayed old - seams along edges
                u, v, facing, vis = view.visible(r["P"], r["N"], tol_m=0.005)
                if pri == 0:   # the primary view owns everything it sees: full weight to 60 deg, falloff to 80 (temples under hair are its too)
                    fade = np.clip((facing - COS_PRI_MIN) / (COS_PRI_FULL - COS_PRI_MIN), 0, 1)
                else:
                    fade = np.clip((facing - COS_MIN) / (COS_FULL - COS_MIN), 0, 1)
                own = fade * vis
                w = own * free
                free = free * (1.0 - own)
                idx = np.nonzero(w > 0.002)[0]
                if not len(idx):
                    continue
                rgb, a = view.ref_sample(u[idx], v[idx])
                wa = w[idx] * np.clip((a - 0.6) / 0.35, 0, 1)
                num[idx] += rgb * wa[:, None]
                den[idx] += wa
                if view.name in req:
                    cover[idx] = np.maximum(cover[idx], wa)
                    per_view_w[view.name] = (idx, wa)
            sel = np.nonzero((den > 1e-6) & (cover > 0.002))[0]
            if not len(sel):
                continue
            blend = num[sel] / den[sel][:, None]
            W = cover[sel][:, None]
            T = self.m.tex[mat]
            ys, xs = r["ys"][sel], r["xs"][sel]
            T[ys, xs] = T[ys, xs] * (1 - W) + blend * W
            touched = cover[sel] > 0.05
            self.m.modified[mat][ys[touched], xs[touched]] = True
            for name, (idx, wa) in per_view_w.items():
                strong = idx[wa > 0.05]
                for df in req[name]:
                    results[df.get("id")]["texels"] += int(len(strong))
                    results[df.get("id")]["_pts"].append(r["P"][strong][::7])
            self.log("joint reprojection: map %s - changed texels %d (strongly %d)" % (self.m.mat_name(mat), len(sel), int(touched.sum())))
        for rid, res in results.items():
            res["_pts"] = np.concatenate(res["_pts"]) if res["_pts"] else np.zeros((0, 3))
        return results

    # ---- 4. recolor
    def recolor(self, defect, params):
        view = self.view(defect, params)
        target = params.get("target_rgb")
        if not target:
            raise RuntimeError("defect %s: recolor without target_rgb" % defect.get("id"))
        soft, hard, bbox = view.zone_mask(defect, params, soft_px=6.0)
        tl = srgb_to_lab(np.array(target, np.float64))
        total = 0
        pts = []
        for mat in self._mats_for(view, hard):
            r = self.m.texels(mat)
            u, v, facing, vis = view.visible(r["P"], r["N"])
            wgt = bilinear(soft, u, v) * vis * np.clip((facing - COS_MIN) / (COS_FULL - COS_MIN), 0, 1)
            idx = np.nonzero(wgt > 0.002)[0]
            if not len(idx):
                continue
            pts.append(r["P"][idx][wgt[idx] > 0.05][::7])
            T = self.m.tex[mat]
            ys, xs = r["ys"][idx], r["xs"][idx]
            lab = srgb_to_lab(T[ys, xs])
            core = wgt[idx] > 0.5
            mean = lab[core].mean(0) if core.sum() > 10 else lab.mean(0)
            shifted = lab_to_srgb(lab + (tl - mean)[None, :])
            w = wgt[idx][:, None]
            T[ys, xs] = T[ys, xs] * (1 - w) + shifted * w
            self.m.modified[mat][ys[core], xs[core]] = True
            total += int(core.sum())
            self.log("defect %s: recolor @%s bbox %s: map %s, mean Lab %s -> %s, texels %d" %
                     (defect.get("id"), view.name, [round(t) for t in bbox], self.m.mat_name(mat), np.round(mean, 1).tolist(), np.round(tl, 1).tolist(), int(core.sum())))
        return {"texels": total, "bbox": [round(t, 1) for t in bbox], "_pts": np.concatenate(pts) if pts else np.zeros((0, 3)), "_grow": 12}

    # ---- 5. fill_seam
    def fill_seam(self, defect, params):
        """Cross blending on both sides of the seam: colours of the visible texels in the zone are painted
        into frame space (so surface neighbours become pixel neighbours even across UV island borders),
        blurred, and returned into the texels; empty texels at island borders are topped up with the nearest covered one."""
        view = self.view(defect, params)
        blur = float(params.get("blur_px", 4.0))
        soft, hard, bbox = view.zone_mask(defect, params, soft_px=6.0)
        S, k = view.size, 2
        total = 0
        pts = []
        for mat in self._mats_for(view, hard):
            r = self.m.texels(mat)
            u, v, facing, vis = view.visible(r["P"], r["N"])
            zw = bilinear(soft, u, v) * vis * np.clip((facing - COS_MIN) / (COS_FULL - COS_MIN), 0, 1)
            idx = np.nonzero(zw > 0.002)[0]
            if not len(idx):
                continue
            pts.append(r["P"][idx][zw[idx] > 0.05][::7])
            T = self.m.tex[mat]
            ys, xs = r["ys"][idx], r["xs"][idx]
            col = T[ys, xs]
            ui = np.clip((u[idx] * k).astype(np.int64), 0, S * k - 1)
            vi = np.clip((v[idx] * k).astype(np.int64), 0, S * k - 1)
            acc = np.zeros((S * k, S * k, 3), np.float64)
            cnt = np.zeros((S * k, S * k), np.float64)
            for c in range(3):
                np.add.at(acc[..., c], (vi, ui), col[:, c])
            np.add.at(cnt, (vi, ui), 1.0)
            sig = blur * k
            num = np.stack([gauss(acc[..., c], sig) for c in range(3)], axis=-1)
            den = gauss(cnt, sig)[..., None]
            sm = num / np.maximum(den, 1e-6)
            smoothed = bilinear(sm.astype(np.float32), u[idx] * k, v[idx] * k)
            w = zw[idx][:, None]
            T[ys, xs] = col * (1 - w) + smoothed * w
            core = zw[idx] > 0.5
            self.m.modified[mat][ys[core], xs[core]] = True
            total += int(core.sum())
        self.log("defect %s: fill_seam @%s bbox %s: frame-space blur %.1f px, texels %d" % (defect.get("id"), view.name, [round(t) for t in bbox], blur, total))
        return {"texels": total, "bbox": [round(t, 1) for t in bbox], "_pts": np.concatenate(pts) if pts else np.zeros((0, 3)), "_grow": 12}

    # ---- 6. palette_lock - the palette guard: a texel may only be of the class (skin / hair / headband) of
    # the reference pixel that owns it; mixed colours (translucent strands, blue strokes in the hair) are
    # replaced with the reference sample of the same class or the class median
    def _ref_classes(self, view):
        if view.name in self._ref_cls:
            return self._ref_cls[view.name]
        import face_geom  # noqa: E402
        ref = view.ref_in_frame()
        a = ref[..., 3] > 127
        rgb = np.where(a[..., None], ref[..., :3], 128.0).astype(np.float32)
        cls = face_geom.classify_lab(face_geom.srgb_to_lab(rgb))
        cls[~a] = 0
        if ndimage is not None:  # drop single-pixel classes (anti-aliased edges)
            cls = ndimage.median_filter(cls, size=3)
        med = np.zeros((4, 3), np.float32)
        for c in (1, 2, 3):
            if (cls == c).sum() > 50:
                med[c] = np.median(rgb[cls == c], axis=0)
        self._ref_cls[view.name] = (cls, a, med, rgb)
        return self._ref_cls[view.name]

    def palette_lock(self, defect=None, params=None):
        import face_geom  # noqa: E402
        params = params or {}
        src_views = sorted([v for v in self.views.values() if v.ref is not None],
                           key=lambda v: JOINT_PRIORITY.index(v.name) if v.name in JOINT_PRIORITY else 99)
        mat = self.m.head_mat
        r = self.m.texels(mat)
        n = len(r["P"])
        best_w = np.zeros(n)
        owner = -np.ones(n, np.int64)
        ou = np.zeros(n)
        ov = np.zeros(n)
        free = np.ones(n)
        for pri, view in enumerate(src_views):
            u, v, facing, vis = view.visible(r["P"], r["N"], tol_m=0.005)
            if pri == 0:
                fade = np.clip((facing - COS_PRI_MIN) / (COS_PRI_FULL - COS_PRI_MIN), 0, 1)
            else:
                fade = np.clip((facing - COS_MIN) / (COS_FULL - COS_MIN), 0, 1)
            own = fade * vis
            w = own * free
            free = free * (1.0 - own)
            cls, a, med, rgb = self._ref_classes(view)
            inside = bilinear(a.astype(np.float32), u, v) > 0.6
            w = w * inside
            better = w > best_w
            best_w[better], owner[better], ou[better], ov[better] = w[better], pri, u[better], v[better]
        sel = (owner >= 0) & (best_w > 0.05)
        T = self.m.tex[mat]
        ys, xs = r["ys"], r["xs"]
        cur_cls = face_geom.classify_rgb(T[ys, xs])
        stats = {"skin": 0, "dark": 0, "blue": 0}
        names = {1: "skin", 2: "dark", 3: "blue"}
        changed_total = 0
        pts = []
        for pri, view in enumerate(src_views):
            idx = np.nonzero(sel & (owner == pri))[0]
            if not len(idx):
                continue
            cls, a, med, rgb = self._ref_classes(view)
            S = cls.shape[0]
            ui = np.clip(ou[idx].astype(np.int64), 0, S - 1)
            vi = np.clip(ov[idx].astype(np.int64), 0, S - 1)
            oc = cls[vi, ui]
            mism = (oc != 0) & (oc != cur_cls[idx])
            if not mism.any():
                continue
            j = idx[mism]
            samp = bilinear(rgb, ou[j], ov[j])
            sc = face_geom.classify_rgb(samp)
            ok = sc == oc[mism]
            rep = np.where(ok[:, None], samp, med[oc[mism]])
            T[ys[j], xs[j]] = rep
            self.m.modified[mat][ys[j], xs[j]] = True
            for c in (1, 2, 3):
                stats[names[c]] += int((oc[mism] == c).sum())
            changed_total += int(len(j))
            pts.append(r["P"][j][::5])
        self.log("palette_lock: owners %s; texels replaced %d (into skin %d, into hair %d, into blue %d) of %d visible" % (
            [v.name for v in src_views], changed_total, stats["skin"], stats["dark"], stats["blue"], int(sel.sum())))
        return {"texels": changed_total, "by_class": stats, "bbox": None, "_pts": np.concatenate(pts) if pts else np.zeros((0, 3)), "_grow": 8}

    # ---- 7. blend_cut - blending the horizontal head cut (z = const) into the body: collar/shoulder colours
    # above the cut shift to the colours of the same class below it, then a cross blur across the cut in the
    # front, back and side frames
    def blend_cut(self, defect=None, params=None):
        params = params or {}
        view = self.view(defect or {}, {"view": params.get("view") or (defect or {}).get("view") or "front"})
        if params.get("z_seam") is not None:
            z_seam = float(params["z_seam"])
        elif params.get("seam_row") is not None:
            z_seam = view.frame_to_world_z(params["seam_row"])
        else:
            z_seam = CUT_Z_DEFAULT
        band = float(params.get("band_m", 0.035))
        z_top = float(params.get("z_top", z_seam + 0.05))

        def collar_class(lab):
            L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
            ch = np.hypot(a, b)
            c = np.zeros(len(L), np.int8)             # 0 other
            c[(L >= 62) & (ch < 25)] = 1              # light (shirt, trim)
            c[(a > 5) & (b > 10) & (L < 62)] = 2      # brown (pauldrons, belts)
            c[(b < -10) & (ch > 15)] = 3              # blue (collar, headband)
            c[(L < 40) & (ch < 30)] = 4               # dark
            skin = (a > 6) & (b > 12) & (L > 50) & (L < 78) & (ch < 40) & (b < 32)
            c[skin & (c == 2)] = 5                    # skin (untouched)
            return c

        acc = {}
        per_mat = {}
        for mat in list(self.m.tex.keys()):
            r = self.m.texels(mat)
            z = r["P"][:, 2]
            inb = (z > z_seam - band) & (z < z_seam + band)
            if not inb.any():
                continue
            idx = np.nonzero(inb)[0]
            lab = srgb_to_lab(self.m.tex[mat][r["ys"][idx], r["xs"][idx]])
            c = collar_class(lab)
            per_mat[mat] = (idx, lab, c)
            for cc in (1, 2, 3, 4):
                for side, m in (("above", z[idx] >= z_seam), ("below", z[idx] < z_seam)):
                    sel = (c == cc) & m
                    if sel.sum() >= 150:
                        acc.setdefault(cc, {}).setdefault(side, []).append(lab[sel])
        deltas = {}
        for cc, sides in acc.items():
            if "above" in sides and "below" in sides:
                a = np.concatenate(sides["above"]).mean(0)
                b = np.concatenate(sides["below"]).mean(0)
                d = np.clip(b - a, [-25, -20, -20], [25, 20, 20])
                deltas[cc] = d
                self.log("blend_cut: class %d: above the cut Lab %s, below %s -> shift %s" % (cc, np.round(a, 1).tolist(), np.round(b, 1).tolist(), np.round(d, 1).tolist()))
        total = 0
        pts = []
        for mat, (idx, lab, c) in per_mat.items():
            r = self.m.texels(mat)
            z = r["P"][:, 2][idx]
            w = np.clip((z_top - z) / max(z_top - (z_seam + 0.015), 1e-6), 0, 1) * (z >= z_seam)
            upd = np.zeros(len(idx), bool)
            for cc, d in deltas.items():
                m = (c == cc) & (w > 0)
                if m.any():
                    lab[m] += w[m][:, None] * d[None, :]
                    upd |= m
            if upd.any():
                self.m.tex[mat][r["ys"][idx[upd]], r["xs"][idx[upd]]] = lab_to_srgb(lab[upd])
                self.m.modified[mat][r["ys"][idx[upd]], r["xs"][idx[upd]]] = True
                total += int(upd.sum())
                pts.append(r["P"][idx[upd]][::9])
        self.log("blend_cut: cut z=%.3f, band +/- %.0f mm, recolored texels above the cut %d (classes %s)" % (z_seam, 1000 * band, total, sorted(deltas)))
        # cross blur across the cut: front, back, sides
        blur = float(params.get("blur_px", 3.0))
        half = float(params.get("blur_band_m", 0.012))
        cams = [view]
        back = self.views.get("back")
        if back is not None:
            cams.append(back)
        try:
            cams += [view.derive(90.0, 0.0), view.derive(-90.0, 0.0)]
        except Exception as exc:
            self.log("blend_cut: side cameras not built (%s) - blurring front/back only" % exc)
        k = 2
        smoothed_total = 0
        for cam_view in cams:
            S = cam_view.size
            for mat in list(self.m.tex.keys()):
                r = self.m.texels(mat)
                z = r["P"][:, 2]
                zw = np.exp(-0.5 * ((z - z_seam) / half) ** 2)
                cand = np.nonzero(zw > 0.05)[0]
                if not len(cand):
                    continue
                u, v, facing, vis = cam_view.visible(r["P"][cand], r["N"][cand], tol_m=0.005)
                ww = zw[cand] * vis * np.clip((facing - COS_MIN) / (COS_FULL - COS_MIN), 0, 1)
                keep = ww > 0.02
                if keep.sum() < 50:
                    continue
                j, u, v, ww = cand[keep], u[keep], v[keep], ww[keep]
                T = self.m.tex[mat]
                ys, xs = r["ys"][j], r["xs"][j]
                col = T[ys, xs]
                ui = np.clip((u * k).astype(np.int64), 0, S * k - 1)
                vi = np.clip((v * k).astype(np.int64), 0, S * k - 1)
                accum = np.zeros((S * k, S * k, 3), np.float64)
                cnt = np.zeros((S * k, S * k), np.float64)
                for ch in range(3):
                    np.add.at(accum[..., ch], (vi, ui), col[:, ch])
                np.add.at(cnt, (vi, ui), 1.0)
                sig = blur * k
                num = np.stack([gauss(accum[..., ch], sig) for ch in range(3)], axis=-1)
                den = gauss(cnt, sig)[..., None]
                sm = bilinear((num / np.maximum(den, 1e-6)).astype(np.float32), u * k, v * k)
                T[ys, xs] = col * (1 - ww[:, None]) + sm * ww[:, None]
                self.m.modified[mat][ys[ww > 0.3], xs[ww > 0.3]] = True
                smoothed_total += int((ww > 0.3).sum())
        self.log("blend_cut: cross blur across the cut in %d cameras, texels %d" % (len(cams), smoothed_total))
        return {"texels": total, "smoothed": smoothed_total, "z_seam": round(z_seam, 4), "deltas": {int(k_): np.round(v_, 1).tolist() for k_, v_ in deltas.items()},
                "bbox": None, "_pts": np.concatenate(pts) if pts else np.zeros((0, 3)), "_grow": 10}


# --------------------------------------------------------------------------- before/after sheet
def compose_sheet(views, before_prefix, after_prefix, defects_by_view, all_defects, out_jpg, log):
    font, small = _font(18), _font(14)
    names = [n for n in ("front", "face34_left", "face34_right", "back") if n in views and (n in defects_by_view or n in ("front", "face34_left"))]
    S = 400
    # sheet captions are report artifacts - Russian verbatim
    cols = ["эталон (выровнен)", "до", "после", "|после - до| (зоны в рамках)"]
    sheet = Image.new("RGB", (S * 4, 30 + S * len(names)), BG)
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), "face_fix: " + "   |   ".join(cols), fill=(20, 20, 20), font=font)
    report = {}
    for row, name in enumerate(names):
        view = views[name]
        bg = Image.new("RGBA", (view.size, view.size), BG + (255,))
        ref = view.ref_in_frame()
        ref_im = Image.alpha_composite(bg, Image.fromarray(ref.astype(np.uint8), "RGBA")) if ref is not None else bg.copy()
        bef = Image.open("%s_%s.png" % (before_prefix, name)).convert("RGBA")
        aft = Image.open("%s_%s.png" % (after_prefix, name)).convert("RGBA")
        b = np.asarray(bef, np.float32)[..., :3]
        a = np.asarray(aft, np.float32)[..., :3]
        diff = np.abs(a - b).max(2)
        changed = diff > 8
        zone = np.zeros(changed.shape, bool)
        boxes = []
        for df in all_defects:            # each defect's zone is its 3D footprint projected into this view
            pts = df.get("_pts")
            if pts is None or not len(pts):
                continue
            u, v, _ = view.to_frame(pts)
            ui = np.clip(u.astype(np.int64), 0, view.size - 1)
            vi = np.clip(v.astype(np.int64), 0, view.size - 1)
            inside = (u >= 0) & (v >= 0) & (u < view.size) & (v < view.size)
            if not inside.any():
                continue
            z = np.zeros(changed.shape, bool)
            z[vi[inside], ui[inside]] = True
            z = dilate(z, float(df.get("_grow", 12)))
            zone |= z
            boxes.append((df.get("id", ""), [float(u[inside].min()), float(v[inside].min()), float(np.ptp(u[inside])), float(np.ptp(v[inside]))]))
        outside = float((changed & ~zone).sum()) / changed.size
        inside = float((changed & zone).sum()) / max(float(zone.sum()), 1)
        report[name] = {"changed_px_outside_zones_share": round(outside, 5), "changed_px_inside_zones_share": round(inside, 4),
                        "zone_px": int(zone.sum())}
        heat = np.zeros((view.size, view.size, 3), np.uint8)
        heat[...] = BG
        hv = np.clip(diff * 3, 0, 255).astype(np.uint8)
        heat[..., 0] = np.maximum(heat[..., 0], hv)
        heat[..., 1] = np.where(hv > 0, np.clip(heat[..., 1] - hv // 2, 0, 255), heat[..., 1])
        heat[..., 2] = np.where(hv > 0, np.clip(heat[..., 2] - hv // 2, 0, 255), heat[..., 2])
        heat_im = Image.fromarray(heat)
        cells = [ref_im.convert("RGB"), Image.alpha_composite(bg, bef).convert("RGB"), Image.alpha_composite(bg, aft).convert("RGB"), heat_im]
        for col, im in enumerate(cells):
            dr = ImageDraw.Draw(im)
            if col >= 2:
                for did, (x, y, w, h) in boxes:
                    dr.rectangle([x, y, x + w, y + h], outline=(230, 40, 40), width=2)
                    dr.text((x + 3, y + 2), did, fill=(230, 40, 40), font=small)
            im = im.resize((S, S), Image.LANCZOS)
            sheet.paste(im, (col * S, 30 + row * S))
        d.text((6, 34 + row * S), "%s  (вне зон изменено %.2f%% пикселей)" % (fv.VIEWS[name]["ru"], 100 * outside), fill=(20, 20, 20), font=small)
    sheet.save(out_jpg, quality=90)
    log("before/after sheet: %s" % out_jpg)
    return report


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--refs", default=None, help="folder with the references (face_front_rgba.png, face34_rgba.png, face34_flip_rgba.png, head_back_rgba.png)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--blender", default=os.environ.get("HG_BLENDER") or os.environ.get("ASTRA_BLENDER") or BLENDER_DEFAULT)
    ap.add_argument("--crop", type=float, default=fv.CROP_M, help="face frame height, m (as in bl_shots: ortho = crop*1.1)")
    ap.add_argument("--force", action="store_true", help="apply defects even when they are already in the model's history")
    ap.add_argument("--no-render", action="store_true", help="do not draw before_after.jpg")
    ap.add_argument("--class-tex", default=None, help="the Head map for the skin/hair classification in geometry_fit (the source paint, not reprojected)")
    ap.add_argument("--auto-lock", action="store_true", default=True, help="always run palette_lock after a whole reprojection (default yes)")
    ap.add_argument("--no-auto-lock", dest="auto_lock", action="store_false")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    work = os.path.join(out, "_work")
    os.makedirs(work, exist_ok=True)
    log_path = os.path.join(out, "face_fix.log")
    open(log_path, "w", encoding="utf-8").close()
    log = Log(log_path)
    log("face_fix: model %s, report %s" % (a.model, a.report))
    with open(a.report, "r", encoding="utf-8") as fh:
        rep = json.load(fh)
    refs = a.refs or rep.get("reference_set") or os.path.dirname(a.model)
    model_in = os.path.abspath(a.model)

    npz = os.path.join(work, "mesh.npz")
    run_blender(a.blender, ["export", model_in, npz, os.path.join(work, "tex_in")], log)
    model = Model(npz, log)
    history = list(model.meta.get("history") or [])

    defects = list(rep.get("defects") or [])
    order = {k: i for i, k in enumerate(ACTION_ORDER)}
    todo = []
    for df in defects:
        ins = df.get("instruction") or {}
        act = ins.get("action")
        if act not in order:
            log("defect %s: unknown action %r - skip" % (df.get("id"), act))
            continue
        key = "%s:%s:%s" % (rep.get("iteration", 0), df.get("id"), act)
        if key in history and not a.force:
            log("defect %s: already applied (%s) - skip" % (df.get("id"), key))
            continue
        todo.append((order[act], df, ins, key))
    todo.sort(key=lambda t: t[0])
    log("report: iteration %s, score %s, defects %d, to apply %d" % (rep.get("iteration"), rep.get("score"), len(defects), len(todo)))

    # views: everything that appears in the defects + front and 3/4-left for the sheet
    needed = {"front", "face34_left"}
    for _, df, ins, _ in todo:
        needed.add(fv.canon_view((ins.get("params") or {}).get("view") or df.get("view") or "front"))
    # the "before" render is needed right away: the reference alignment is refined over it (face-feature edges);
    # when the checker passed the exact camera of its frame - render its raw frame and map it by the post affine
    report_views = rep.get("views") or {}
    cams, posts = {}, {}
    for n in sorted(needed):
        rv = report_views.get(n) or report_views.get(fv.VIEWS[n]["shot"]) or {}
        fc = (rv.get("align") or {}).get("frame_camera")
        if fc and fc.get("post") is not None and fc.get("centre") is not None:
            cams[n] = {"yaw": float(fc["yaw"]), "pitch": float(fc.get("pitch", 0.0)), "centre": [float(c) for c in fc["centre"]],
                       "ortho_scale": int(fc.get("raw_size", 1600)) / float(fc["px_per_m"]), "size": int(fc.get("raw_size", 1600)), "distance": 6.0}
            posts[n] = (fc["post"], int(fc.get("size", fv.SIZE)))
        else:
            cams[n] = fv.view_camera(n, model.zmax, model.cx, crop=a.crop)
    cams_path = os.path.join(work, "cams.json")
    with open(cams_path, "w", encoding="utf-8") as fh:
        json.dump(cams, fh, indent=1)
    before_prefix = os.path.join(work, "before")
    run_blender(a.blender, ["render", model_in, cams_path, before_prefix], log)
    postwarp_renders(before_prefix, posts)
    views = {}
    for name in sorted(needed):
        rv = report_views.get(name) or report_views.get(fv.VIEWS[name]["shot"])
        views[name] = View(name, model, rv, refs, a.crop, log, render_png="%s_%s.png" % (before_prefix, name))

    stats = {"applied": [], "skipped": []}
    fixer = Fixer(model, views, log, stats, class_tex=a.class_tex, work=work)
    defects_by_view = {}
    all_entries = []
    # whole reprojections (empty zone_mask) go in one joint pass over all views
    joint = [(df, ins.get("params") or {}) for _, df, ins, _ in todo
             if ins.get("action") == "reproject" and not (ins.get("params") or {}).get("zone_mask")]
    joint_ids = {df.get("id") for df, _ in joint}
    joint_res = None   # computed lazily - at the first reproject in the action order, i.e. AFTER all geometry_warp
    has_fit = any(ins.get("action") == "geometry_fit" for _, _, ins, _ in todo)
    has_lock = any(ins.get("action") == "palette_lock" for _, _, ins, _ in todo)
    lock_done = False
    for _, df, ins, key in todo:
        params = ins.get("params") or {}
        act = ins.get("action")
        t0 = time.time()
        if has_fit and act == "geometry_warp" and df.get("kind") == "geometry_shape":
            # the whole-mesh fit already aligns the contour - silhouette bands are not moved this iteration (double shift otherwise)
            log("defect %s: silhouette geometry_warp skipped - geometry_fit fixes the contour this iteration" % df.get("id"))
            stats["skipped"].append({"id": df.get("id"), "action": act, "error": "subsumed by geometry_fit"})
            history.append(key)
            continue
        if act == "palette_lock" and lock_done:
            log("defect %s: palette_lock already done this iteration" % df.get("id"))
            stats["skipped"].append({"id": df.get("id"), "action": act, "error": "already locked"})
            history.append(key)
            continue
        try:
            if act == "palette_lock":
                lock_done = True
            if joint_res is not None and not lock_done and a.auto_lock and not has_lock and ACTION_ORDER.index(act) > ACTION_ORDER.index("palette_lock"):
                # there was a reprojection and the report has no explicit palette lock - run it before seams and blending
                lock_done = True
                res_l = fixer.palette_lock(None, {})
                stats["applied"].append(dict({k: v for k, v in res_l.items() if not k.startswith("_")}, id="auto", action="palette_lock", zone="head", text_ru="замок палитры после перепроекции"))
                all_entries.append({"id": "lock", "_pts": res_l.get("_pts"), "_grow": 8})
            if df.get("id") in joint_ids:
                if joint_res is None:
                    tj = time.time()
                    try:
                        joint_res = fixer.reproject_joint(joint)
                        for rr in joint_res.values():
                            rr["seconds_joint"] = round(time.time() - tj, 2)
                    except Exception as exc:
                        log("joint reprojection: ERROR %s - the views will be reprojected one by one" % exc)
                        joint_res = {}
                res = joint_res[df.get("id")] if df.get("id") in joint_res else getattr(fixer, act)(df, params)
            else:
                res = getattr(fixer, act)(df, params)
        except Exception as exc:
            log("defect %s: ERROR %s: %s" % (df.get("id"), act, exc))
            stats["skipped"].append({"id": df.get("id"), "action": act, "error": str(exc)})
            continue
        res = dict(res or {}, id=df.get("id"), action=act, zone=df.get("zone"), seconds=round(time.time() - t0, 2),
                   text_ru=ins.get("text_ru"))
        entry = {"id": df.get("id"), "_pts": res.pop("_pts", None), "_grow": res.pop("_grow", 12)}
        stats["applied"].append(res)
        history.append(key)
        vname = fv.canon_view(params.get("view") or df.get("view") or "front")
        defects_by_view.setdefault(vname, []).append(entry)
        all_entries.append(entry)
    if joint_res is not None and not lock_done and a.auto_lock:
        try:
            res_l = fixer.palette_lock(None, {})
            stats["applied"].append(dict({k: v for k, v in res_l.items() if not k.startswith("_")}, id="auto", action="palette_lock", zone="head", text_ru="замок палитры после перепроекции"))
            all_entries.append({"id": "lock", "_pts": res_l.get("_pts"), "_grow": 8})
        except Exception as exc:
            log("palette_lock (auto): ERROR %s" % exc)

    model.finish_textures()
    tex_out = {}
    for mat, T in model.tex.items():
        if mat in model.modified and model.modified[mat].any():
            p = os.path.join(work, "tex_out_%s.png" % model.mat_name(mat))
            Image.fromarray(np.clip(T + 0.5, 0, 255).astype(np.uint8)).save(p)
            tex_out[model.mat_name(mat)] = p
    disp_path = None
    if np.abs(model.disp).max() > 0:
        disp_path = os.path.join(work, "disp.npy")
        np.save(disp_path, model.disp.astype(np.float64))
    job = {"object": model.meta["object"], "disp_npy": disp_path, "textures": tex_out, "history": history}
    job_path = os.path.join(work, "job.json")
    with open(job_path, "w", encoding="utf-8") as fh:
        json.dump(job, fh, ensure_ascii=False, indent=1)
    out_blend = os.path.join(out, "painted.blend")
    out_glb = os.path.join(out, "archer_painted.glb")
    info = run_blender(a.blender, ["apply", model_in, job_path, out_blend, out_glb], log)
    try:
        glb_info = json.loads(info.split("apply", 1)[1])
    except Exception:
        glb_info = {}

    sheet_report = {}
    if not a.no_render:
        after_prefix = os.path.join(work, "after")
        run_blender(a.blender, ["render", out_blend, cams_path, after_prefix], log)
        postwarp_renders(after_prefix, posts)
        sheet_report = compose_sheet(views, before_prefix, after_prefix, defects_by_view, all_entries, os.path.join(out, "before_after.jpg"), log)
        for n, r in sheet_report.items():
            log("view %s: pixels changed outside zones %.3f%%, inside zones %.1f%%" % (n, 100 * r["changed_px_outside_zones_share"], 100 * r["changed_px_inside_zones_share"]))
    result = {"ok": True, "model_in": model_in, "report": os.path.abspath(a.report), "iteration": rep.get("iteration"),
              "out": {"blend": out_blend, "glb": out_glb, "log": log_path, "sheet": os.path.join(out, "before_after.jpg") if not a.no_render else None},
              "applied": stats["applied"], "skipped": stats["skipped"], "history": history, "glb": glb_info,
              "views": {n: {"align": v.align, "frame_xf": v.frame_xf, "ref": v.ref_path, "camera": v.cam} for n, v in views.items()},
              "locality": sheet_report}
    with open(os.path.join(out, "face_fix_result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    log("DONE: applied %d, skipped %d -> %s" % (len(stats["applied"]), len(stats["skipped"]), out_blend))
    return 0


if __name__ == "__main__":
    sys.exit(main())
