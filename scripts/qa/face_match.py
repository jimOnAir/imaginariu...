#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""face_match.py - checking the model's face against the reference (the head-paint QA gate).

    python face_match.py --model <blend|glb|folder with renders> --refs <in/ folder> --out <folder>
                         [--iteration N] [--strict] [--no-vlm] [--blender <exe>] [--vlm-model qwen3-vl:8b]

What it does:
  1. renders the model's head with an orthographic camera (Workbench FLAT+TEXTURE, transparent background)
     from the reference views: front yaw 0, 3/4 ±35° (the sign is picked by the reference silhouette),
     back 180 - through face_render.py inside Blender;
  2. aligns the render to the reference: head silhouette (scale, dx, dy) -> cv2.findTransformECC (euclidean) refinement;
  3. computes the contract metrics: silhouette IoU, gray SSIM, edge chamfer, feature mask IoU (skin/hair/
     headband/dark features - k-means 6 clusters Lab on the reference, the same centers on the render),
     landmark offsets (dark-component centroids + local ECC 96x96), the share of the substantially
     different area (|ref-render| in Lab, 5 px blur, threshold);
  4. asks the local VLM (Ollama qwen3-vl): yes/no per contract + landmark coordinates on the pair
     "reference | render" (used only when the reference error is < 5 % of the frame); frees ComfyUI (/free)
     before the series;
  5. turns every difference into a defect with a machine-executable instruction (reproject / inpaint_from_ref /
     geometry_warp / recolor / fill_seam) and a Russian phrase;
  6. writes face_report.json + face_report.jpg (references on top, renders with defect boxes below, difference
     heat maps and the feature-mask overlay on the right).

Return code: 0 - pass, 1 - fail, 2 - error. Libraries: numpy, cv2, scikit-image, scipy, PIL (the studio QA
python); Blender only for the render (.blend/.glb). "left/right" in zones and texts is the frame (the viewer's)
side. Defect coordinates and offsets - pixels of the aligned 800x800 frames (the reference shrunk to 800, the
render aligned to the reference).
"""
import argparse
import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

import cv2
import numpy as np
from scipy import ndimage
from skimage.metrics import structural_similarity

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME = 800
BG = 128  # neutral background for compositing RGBA

# key, reference file, nominal yaws (the 3/4 sign is refined), weight in the total, Russian name
VIEWS = [
    ("front", "face_front_rgba.png", [0.0], 0.50, "Анфас"),
    ("face34_left", "face34_rgba.png", [-35.0, 35.0], 0.20, "3/4 слева"),
    ("face34_right", "face34_flip_rgba.png", [35.0, -35.0], 0.20, "3/4 справа"),
    ("back", "head_back_rgba.png", [180.0], 0.10, "Затылок"),
]
THRESHOLDS = {"ssim_gray": 0.85, "feature_mask_iou_min": 0.80, "landmark_max_px_share": 0.02,
              "diff_area_share_max": 0.01, "silhouette_iou": 0.93}
DIFF_DE = 16.0        # deltaE76 threshold of a "substantial" difference after the blur
LOCAL_SHIFT_MIN = 3.0  # px: a local ECC shift under this is treated as edges matching
YAW34_CANDIDATES = (15, 20, 25, 30, 35, 40, 45)  # 3/4 angles, the one closest to the reference is chosen
MAX_DEFECTS_PER_VIEW = 10  # the report gets the most serious and largest ones; the rest is on the heat map
COARSE_DIFF_SHARE = 0.10   # head-area share of difference above which the view is reprojected whole, not per patch
VLM_URL = "http://127.0.0.1:11434"
COMFY_URL = "http://127.0.0.1:8191"
DEFAULT_BLENDER = (r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" if os.name == "nt" else "blender")

ZONE_RU = {"left_eye": "левый глаз (в кадре слева)", "right_eye": "правый глаз (в кадре справа)", "brows": "брови",
           "nose": "нос", "mouth": "рот", "left_cheek": "левая щека (в кадре слева)", "right_cheek": "правая щека (в кадре справа)",
           "chin": "подбородок/челюсть", "forehead_headband": "лоб/повязка", "hair_left": "волосы слева", "hair_right": "волосы справа",
           "hair_top": "волосы сверху", "neck_collar": "шея/воротник", "seam": "шов"}
KIND_RU = {"texture_smear": "размазанная/чужая текстура", "missing_feature": "деталь референса отсутствует",
           "feature_shift": "черта смещена", "colour_off": "цвет не совпадает", "seam": "шов-линия", "hole": "дыра/просвет",
           "geometry_shape": "форма не совпадает с референсом"}
ACTION_RU = {"reproject": "перепроецировать референс с поправкой камеры", "inpaint_from_ref": "перенести фрагмент референса по маске",
             "geometry_warp": "сдвинуть сетку/текстуру в зоне", "recolor": "перекрасить в цвет референса", "fill_seam": "залить шов цветом соседей"}


# ----------------------------------------------------------------------------------------------- utils
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(*a):
    print("[face_match]", *a, flush=True)


def load_rgba(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise FileNotFoundError(path)
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    if im.shape[2] == 3:
        im = np.dstack([im, np.full(im.shape[:2], 255, np.uint8)])
    return im


def composite(rgba, bg=BG):
    a = rgba[:, :, 3:4].astype(np.float32) / 255.0
    return (rgba[:, :, :3].astype(np.float32) * a + bg * (1 - a)).astype(np.uint8)


def gray_of(rgba):
    return cv2.cvtColor(composite(rgba), cv2.COLOR_BGR2GRAY)


def resize_frame(rgba, size=FRAME):
    inter = cv2.INTER_AREA if rgba.shape[0] > size else cv2.INTER_CUBIC
    return cv2.resize(rgba, (size, size), interpolation=inter)


def alpha_mask(rgba):
    return rgba[:, :, 3] > 127


def head_measure(mask):
    """Head by silhouette: top, neck row (the first width minimum after the maximum), height, center x."""
    rows = np.where(mask.any(1))[0]
    if len(rows) == 0:
        return None
    top, bottom = int(rows[0]), int(rows[-1])
    w = mask.sum(1).astype(np.float64)
    ws = ndimage.uniform_filter1d(w, 9)
    neck = bottom
    runmax = np.maximum.accumulate(ws[top:bottom + 1])
    y0 = None
    for i in range(int(0.25 * (bottom - top)), bottom - top + 1):
        if ws[top + i] < 0.85 * runmax[i]:
            y0 = top + i
            break
    if y0 is not None:
        y = y0
        while y < bottom and ws[y + 1] <= ws[y] * 1.01:
            y += 1
        neck = y
    sub = mask[top:neck + 1]
    ys, xs = np.nonzero(sub)
    cx = float(xs.mean()) if len(xs) else float(mask.shape[1] / 2)
    # the head width is taken over the upper silhouette (to the neck - half, otherwise 45 % of the height)
    # so the shoulders are not captured
    lim = top + int(0.5 * (neck - top)) if neck < bottom else top + int(0.45 * (bottom - top))
    hw = float(ws[top:max(lim, top + 1)].max())
    return {"top": top, "neck": int(neck), "bottom": bottom, "head_h": float(max(neck - top, 1)), "cx": cx, "head_w": hw}


def warp_rgba(rgba, scale, dx, dy, size=FRAME):
    img = rgba
    if scale != 1.0:
        inter = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        img = cv2.resize(rgba, None, fx=scale, fy=scale, interpolation=inter)
    M = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
    return cv2.warpAffine(img, M, (size, size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))


def roi_rows_for(ref_hm, lm, H):
    """The frame rows we compare over: the head and the neck down to the collar (chin + 0.9 IOD); without
    landmarks - to the silhouette neck, and when there is no neck (shoulders to the frame bottom) - top +
    1.15 head widths."""
    if lm is not None:
        limit = lm["chin"][1] + 0.5 * lm["iod"]  # the head and the neck under the chin; shoulders and collar are not the face
    elif ref_hm["neck"] < ref_hm["bottom"]:
        limit = ref_hm["neck"] + 0.25 * ref_hm["head_h"]
    else:
        limit = ref_hm["top"] + 1.15 * ref_hm["head_w"]
    rows = np.zeros((H, H), bool)
    rows[:int(min(H, max(limit, ref_hm["top"] + 40)))] = True
    return rows


def ncc_gray(ref_g, ren_g, roi):
    a = cv2.GaussianBlur(ref_g.astype(np.float32), (0, 0), 4.0)[roi]
    b = cv2.GaussianBlur(ren_g.astype(np.float32), (0, 0), 4.0)[roi]
    if a.size < 100 or a.std() < 1e-3 or b.std() < 1e-3:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def sil_align(ref_mask, roi_rows, ref_hm, raw_mask, raw_hm):
    """Fitting the render silhouette to the reference: a scale sweep (±20 % around the head height/width
    estimate), the shift by maximum overlap (FFT correlation) over the reference head rows, criterion IoU.
    -> (scale, dx, dy, iou)."""
    from scipy.signal import fftconvolve
    H = ref_mask.shape[0]
    R = (ref_mask & roi_rows)
    f = 0.25  # working resolution 200 px
    Rs = cv2.resize(R.astype(np.float32), None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    rows_s = cv2.resize(roi_rows.astype(np.float32), None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    areaR = float(Rs.sum())
    s_h = ref_hm["head_h"] / max(raw_hm["head_h"], 1)
    s_w = ref_hm["head_w"] / max(raw_hm["head_w"], 1)
    s0 = math.sqrt(s_h * s_w)
    best = None

    def evaluate(sc):
        m = cv2.resize(raw_mask.astype(np.float32), None, fx=sc * f, fy=sc * f, interpolation=cv2.INTER_AREA)
        if m.shape[0] < 4 or m.shape[0] > 4 * Rs.shape[0]:
            return None
        inter = fftconvolve(Rs, m[::-1, ::-1], mode="full")
        raw_in = fftconvolve(rows_s, m[::-1, ::-1], mode="full")
        iou_map = inter / np.maximum(areaR + raw_in - inter, 1.0)
        iy, ix = np.unravel_index(int(np.argmax(iou_map)), iou_map.shape)
        # the shift in the working resolution: the top-left corner of m = (ix - (mw-1), iy - (mh-1))
        tx, ty = (ix - (m.shape[1] - 1)) / f, (iy - (m.shape[0] - 1)) / f
        return float(iou_map[iy, ix]), sc, tx, ty
    for sc in s0 * np.linspace(0.6, 1.6, 51):
        r = evaluate(sc)
        if r and (best is None or r[0] > best[0]):
            best = r
    for sc in best[1] * np.linspace(0.97, 1.03, 25):
        r = evaluate(sc)
        if r and r[0] > best[0]:
            best = r
    iou0, sc, tx, ty = best
    # refine the shift at full resolution (±4 px)
    m_full = cv2.resize(raw_mask.astype(np.uint8), None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA) > 0
    bestt = (iou0, tx, ty)
    for ddx in range(-4, 5):
        for ddy in range(-4, 5):
            M = np.array([[1, 0, tx + ddx], [0, 1, ty + ddy]], np.float32)
            w = cv2.warpAffine(m_full.astype(np.uint8), M, (H, H), flags=cv2.INTER_NEAREST) > 0
            inter = float((w & R).sum())
            u = float(R.sum() + (w & roi_rows).sum() - inter)
            v = inter / max(u, 1)
            if v > bestt[0]:
                bestt = (v, tx + ddx, ty + ddy)
    return sc, bestt[1], bestt[2], bestt[0]


def ecc_refine(ref_rgba, ren_rgba, roi_mask):
    """Euclidean transform refinement over the blurred gray; returns (rgba, 2x3 matrix) or (ren, None)."""
    rg = cv2.GaussianBlur(gray_of(ref_rgba).astype(np.float32), (0, 0), 2.0)
    ng = cv2.GaussianBlur(gray_of(ren_rgba).astype(np.float32), (0, 0), 2.0)
    warp = np.eye(2, 3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    m = cv2.dilate(roi_mask.astype(np.uint8), np.ones((15, 15), np.uint8))
    try:
        _, warp = cv2.findTransformECC(rg, ng, warp, cv2.MOTION_EUCLIDEAN, crit, m, 5)
    except cv2.error as exc:
        return ren_rgba, None, "ecc failed: %s" % str(exc).splitlines()[-1][:80]
    ang = math.degrees(math.atan2(warp[1, 0], warp[0, 0]))
    if abs(ang) > 6 or abs(warp[0, 2]) > 40 or abs(warp[1, 2]) > 40:
        return ren_rgba, None, "ecc rejected (rot %.1f°, t %.0f/%.0f)" % (ang, warp[0, 2], warp[1, 2])
    out = cv2.warpAffine(ren_rgba, warp, (FRAME, FRAME), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    return out, warp, "ok"


def local_shift(ref_g, ren_g, cx, cy, win=96):
    """Local ECC (translation) in a win x win window around (cx, cy): the render shift relative to the
    reference, px."""
    h, w = ref_g.shape
    r = win // 2
    x0, y0 = int(round(cx)) - r, int(round(cy)) - r
    x0 = min(max(x0, 0), w - win)
    y0 = min(max(y0, 0), h - win)
    a = ref_g[y0:y0 + win, x0:x0 + win].astype(np.float32)
    b = ren_g[y0:y0 + win, x0:x0 + win].astype(np.float32)
    if a.std() < 2 or b.std() < 2:
        return None
    best = None
    warp = np.eye(2, 3, dtype=np.float32)
    for sc in (0.5, 1.0):
        aa = cv2.resize(a, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA) if sc != 1 else a
        bb = cv2.resize(b, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA) if sc != 1 else b
        aa = cv2.GaussianBlur(aa, (0, 0), 1.5)
        bb = cv2.GaussianBlur(bb, (0, 0), 1.5)
        w0 = warp.copy()
        w0[:, 2] *= sc
        try:
            cc, w1 = cv2.findTransformECC(aa, bb, w0, cv2.MOTION_TRANSLATION,
                                          (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5), None, 5)
        except cv2.error:
            continue
        warp = w1.copy()
        warp[:, 2] /= sc
        best = (float(warp[0, 2]), float(warp[1, 2]), float(cc))
    if best is None or abs(best[0]) > r * 0.8 or abs(best[1]) > r * 0.8:
        return None
    return best  # dx, dy: how far the render is shifted relative to the reference (render = ref + (dx,dy))


def lab_of(rgba):
    bgr = composite(rgba).astype(np.float32) / 255.0
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)  # L 0..100, a/b -127..127


def largest_component(mask):
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def face_fill(skin):
    m = cv2.morphologyEx(skin.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)) > 0
    m = ndimage.binary_fill_holes(m)
    m = largest_component(m)
    return m


# ----------------------------------------------------------------------------------------------- features
def kmeans_classes(ref_lab, ref_mask, k=6):
    cv2.setRNGSeed(7)
    pts = ref_lab[ref_mask].reshape(-1, 3).astype(np.float32)
    if len(pts) > 60000:
        idx = np.random.RandomState(7).choice(len(pts), 60000, replace=False)
        pts = pts[idx]
    _, _, centers = cv2.kmeans(pts, k, None, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 0.5), 3, cv2.KMEANS_PP_CENTERS)
    cls = []
    for L, a, b in centers:
        chroma = math.hypot(a, b)
        if L < 38 and chroma < 40:
            cls.append("dark")
        elif b < -12 and chroma > 18:
            cls.append("blue")
        elif a > 4 and b > 8 and L > 38:
            cls.append("skin")
        else:
            cls.append("other")
    if "skin" not in cls:  # fallback: the warmest cluster
        warm = int(np.argmax([c[1] + c[2] for c in centers]))
        cls[warm] = "skin"
    return centers, cls


def label_by_centers(lab, mask, centers):
    px = lab.reshape(-1, 3).astype(np.float32)
    d = ((px[:, None, :] - centers[None, :, :]) ** 2).sum(2)
    idx = np.argmin(d, 1).reshape(lab.shape[:2])
    idx[~mask] = -1
    return idx


def feature_masks(idx, cls, mask, hm, landmarks=None, is_back=False):
    """Feature masks by cluster class and position: skin, hair, headband, dark face features."""
    of = lambda name: np.isin(idx, [i for i, c in enumerate(cls) if c == name]) & mask
    skin, dark, blue = of("skin"), of("dark"), of("blue")
    H, W = mask.shape
    yy, xx = np.mgrid[0:H, 0:W]
    head_rows = (yy >= hm["top"]) & (yy <= hm["neck"] + 0.12 * hm["head_h"])
    if is_back:
        face = np.zeros_like(mask)
    else:
        face = face_fill(skin)
    face_in = cv2.erode(face.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    dark_features = dark & face_in
    hair = dark & ~face & head_rows
    if landmarks and landmarks.get("eye_y"):
        band_rows = yy < landmarks["eye_y"] - 0.15 * landmarks["iod"]
    else:
        band_rows = yy < hm["top"] + 0.5 * hm["head_h"]
    headband = blue & band_rows & head_rows
    headband = cv2.morphologyEx(headband.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0
    return {"skin": skin & head_rows, "hair": hair, "headband": headband, "dark_features": dark_features, "face": face}


def iou(a, b):
    u = (a | b).sum()
    if u < 50:
        return None
    return float((a & b).sum() / u)


def ref_landmarks(ref_g, fm, hm):
    """The reference landmarks: eyes/brows - dark-feature components, nose/mouth - dark rows along the axis,
    chin - the skin edge."""
    df = fm["dark_features"]
    face = fm["face"]
    lab, n = ndimage.label(df)
    if n == 0:
        return None
    comps = []
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        if area < 25:
            continue
        ys, xs = np.nonzero(m)
        comps.append({"id": i, "area": area, "cx": float(xs.mean()), "cy": float(ys.mean()),
                      "bbox": [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]})
    if len(comps) < 2:
        return None
    fy, fx = np.nonzero(face)
    axis0 = float(fx.mean())
    face_top, face_bot = float(fy.min()), float(fy.max())
    # pairs of components on opposite sides of the axis at a close height - eye/brow candidates:
    # the eyes are the largest pair, the brows are the pair just above them
    pairs = []
    for a in comps:
        for b in comps:
            dist = b["cx"] - a["cx"]
            if a["cx"] < axis0 < b["cx"] and dist > 0.12 * face.shape[1] and abs(a["cy"] - b["cy"]) < 0.3 * dist:
                pairs.append((a, b))
    if not pairs:
        return None

    def mid(p):
        return ((p[0]["cx"] + p[1]["cx"]) / 2, (p[0]["cy"] + p[1]["cy"]) / 2)
    big = max(pairs, key=lambda p: p[0]["area"] + p[1]["area"])
    bx, by = mid(big)
    iod0 = big[1]["cx"] - big[0]["cx"]
    # a pair under the largest one (0.12-0.7 IOD lower, close in x) - those are the eyes and the large one is
    # the brows; otherwise the large pair is the eyes and the brows are searched above it
    below = [p for p in pairs if p is not big and 0.12 * iod0 < mid(p)[1] - by < 0.7 * iod0 and abs(mid(p)[0] - bx) < 0.3 * iod0
             and abs((p[1]["cx"] - p[0]["cx"]) - iod0) < 0.35 * iod0]
    if below:
        eyes = max(below, key=lambda p: p[0]["area"] + p[1]["area"])
        brows = big
    else:
        eyes = big
        ey = by
        above = [p for p in pairs if p is not eyes and 0.12 * iod0 < ey - mid(p)[1] < 0.7 * iod0 and abs(mid(p)[0] - bx) < 0.3 * iod0]
        brows = min(above, key=lambda p: ey - mid(p)[1]) if above else None
    L, R = eyes
    eye_y = (L["cy"] + R["cy"]) / 2
    iod = max(R["cx"] - L["cx"], 20.0)
    axis = (L["cx"] + R["cx"]) / 2
    lm = {"left_eye": [L["cx"], L["cy"]], "right_eye": [R["cx"], R["cy"]], "eye_y": eye_y, "iod": iod, "axis": axis,
          "left_eye_bbox": L["bbox"], "right_eye_bbox": R["bbox"]}
    if brows is not None:
        lm["brows"] = [(brows[0]["cx"] + brows[1]["cx"]) / 2, (brows[0]["cy"] + brows[1]["cy"]) / 2]
        lm["brow_y"] = lm["brows"][1]
    else:
        lm["brow_y"] = eye_y - 0.35 * iod
        lm["brows"] = [axis, lm["brow_y"]]
    # nose and mouth: minima of the mean row brightness in a strip along the axis (nostrils, mouth line)
    g = cv2.GaussianBlur(ref_g.astype(np.float32), (0, 0), 1.5)
    x0, x1 = int(axis - 0.3 * iod), int(axis + 0.3 * iod)
    x0, x1 = max(x0, 0), min(x1, g.shape[1])
    strip = g[:, x0:x1].mean(1)
    strip = ndimage.uniform_filter1d(strip, 5)

    def argmin_band(y_from, y_to):
        y_from, y_to = int(max(y_from, 0)), int(min(y_to, g.shape[0] - 1))
        if y_to <= y_from:
            return None
        return float(y_from + int(np.argmin(strip[y_from:y_to])))
    nose_y = argmin_band(eye_y + 0.55 * iod, eye_y + 1.0 * iod)
    mouth_y = argmin_band(eye_y + 1.05 * iod, eye_y + 1.7 * iod)
    # mouth: a dark component inside the band gives a more accurate center
    for c in comps:
        if c not in (L, R) and abs(c["cx"] - axis) < 0.5 * iod and eye_y + 1.0 * iod < c["cy"] < eye_y + 1.8 * iod:
            mouth_y = c["cy"]
            axis_m = c["cx"]
            break
    else:
        axis_m = axis
    lm["nose"] = [axis, nose_y if nose_y is not None else eye_y + 0.8 * iod]
    lm["mouth"] = [axis_m, mouth_y if mouth_y is not None else eye_y + 1.35 * iod]
    # chin: the strongest vertical brightness transition along the axis below the mouth (the shadow under the
    # chin) within the face
    gy = np.gradient(g, axis=0)
    col = np.abs(gy[:, x0:x1]).mean(1)
    col = ndimage.uniform_filter1d(col, 5)
    yA, yB = int(lm["mouth"][1] + 0.35 * iod), int(min(lm["mouth"][1] + 1.3 * iod, face_bot + 6))
    if yB > yA + 3:
        chin_y = float(yA + int(np.argmax(col[yA:yB])))
    else:
        chin_y = face_bot
    lm["chin"] = [axis, chin_y]
    lm["face_top"] = float(face[:, int(axis)].nonzero()[0].min()) if face[:, int(axis)].any() else face_top
    lm["face_h"] = max(chin_y - lm["face_top"], 1.0)
    return lm


def match_landmark(ref_g, ren_g, x, y, tw, th, radius):
    """Where the reference window around (x, y) is on the render: normalized cross-correlation
    (TM_CCOEFF_NORMED) over blurred gray within radius px. -> (dx, dy, score) or None."""
    H, W = ref_g.shape
    x0, y0 = int(round(x - tw / 2)), int(round(y - th / 2))
    x0, y0 = min(max(x0, 0), W - int(tw)), min(max(y0, 0), H - int(th))
    tpl = ref_g[y0:y0 + int(th), x0:x0 + int(tw)]
    r = int(radius)
    sx0, sy0 = max(x0 - r, 0), max(y0 - r, 0)
    sx1, sy1 = min(x0 + int(tw) + r, W), min(y0 + int(th) + r, H)
    search = ren_g[sy0:sy1, sx0:sx1]
    if tpl.std() < 2 or search.shape[0] <= tpl.shape[0] or search.shape[1] <= tpl.shape[1]:
        return None
    res = cv2.matchTemplate(search, tpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(res)
    dx, dy = (sx0 + loc[0]) - x0, (sy0 + loc[1]) - y0
    if abs(dx) >= r - 1 or abs(dy) >= r - 1:  # stuck at the search-window edge - no match found
        return None
    return float(dx), float(dy), float(mx)


def render_landmarks(ref_lm, ref_g, ren_g, ren_fm):
    """Positions of the reference landmarks on the render: the reference window around the landmark is
    searched on the render by correlation (radius 0.45 IOD), on weak correlation - local ECC; otherwise the
    landmark is not found (it is absent from the report)."""
    out, src = {}, {}
    iod = ref_lm["iod"]
    rg = cv2.GaussianBlur(ref_g, (0, 0), 1.5)
    ng = cv2.GaussianBlur(ren_g, (0, 0), 1.5)
    windows = {"left_eye": (0.55, 0.35, 0.45), "right_eye": (0.55, 0.35, 0.45), "brows": (1.5, 0.3, 0.35),
               "nose": (0.5, 0.45, 0.4), "mouth": (0.7, 0.3, 0.4), "chin": (0.6, 0.35, 0.4)}
    for key, (fw, fh, fr) in windows.items():
        if key not in ref_lm:
            continue
        rx, ry = ref_lm[key]
        m = match_landmark(rg, ng, rx, ry, fw * iod, fh * iod, fr * iod)
        need = 0.5 if key in ("left_eye", "right_eye", "brows") else 0.6
        if m and m[2] >= need:
            out[key] = [rx + m[0], ry + m[1]]
            src[key] = "template(%.2f)" % m[2]
            continue
        s = local_shift(ref_g, ren_g, rx, ry)
        if s and s[2] >= 0.6:
            out[key] = [rx + s[0], ry + s[1]]
            src[key] = "ecc(%.2f)" % s[2]
        else:
            src[key] = "not_found(%.2f)" % (m[2] if m else 0.0)
    return out, src


# ----------------------------------------------------------------------------------------------- VLM
def http_json(method, url, payload=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        txt = r.read().decode("utf-8", "replace")
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return {"raw": txt}


def free_comfy():
    try:
        http_json("POST", COMFY_URL + "/free", {"unload_models": True, "free_memory": True}, timeout=30)
        time.sleep(4)
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader"],
                                 capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception:
            out = "?"
        log("ComfyUI /free done; GPU:", out)
        return out
    except Exception as exc:
        log("ComfyUI /free unavailable:", exc)
        return None


def parse_json_loose(txt):
    m = re.search(r"\{.*\}", txt or "", re.S)
    if not m:
        return None
    s = m.group(0)
    for cand in (s, s.replace("'", '"')):
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    return None


def vlm_ask(model, prompt, image_path, timeout=420):
    body = {"model": model, "stream": False, "think": False, "format": "json", "keep_alive": "3m",
            "options": {"temperature": 0, "num_predict": 6000, "num_ctx": 16384},
            "messages": [{"role": "user", "content": prompt, "images": [base64.b64encode(open(image_path, "rb").read()).decode()]}]}
    t0 = time.time()
    res = http_json("POST", VLM_URL + "/api/chat", body, timeout=timeout)
    msg = res.get("message") or {}
    txt = msg.get("content") or ""
    ans = parse_json_loose(txt)
    if ans is None and msg.get("thinking"):  # qwen3-vl sometimes reasons despite think=false and puts the JSON there
        cands = re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", msg["thinking"], re.S)
        for c in reversed(cands):
            ans = parse_json_loose(c)
            if ans:
                break
        txt = txt or ("[thinking] " + msg["thinking"][-800:])
    return ans, round(time.time() - t0, 1), txt


def make_pair(ref_rgba, ren_rgba, path, size=512):
    a = cv2.resize(composite(ref_rgba), (size, size), interpolation=cv2.INTER_AREA)
    b = cv2.resize(composite(ren_rgba), (size, size), interpolation=cv2.INTER_AREA)
    pair = np.full((size + 28, 2 * size + 16, 3), 200, np.uint8)
    pair[28:, :size] = a
    pair[28:, size + 16:] = b
    cv2.putText(pair, "A: reference", (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    cv2.putText(pair, "B: 3D model render", (size + 24, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    cv2.imwrite(path, pair, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return size


YESNO_KEYS = ["face_readable", "eyes_symmetric", "mouth_visible", "headband_on_forehead", "hair_solid", "no_smear", "same_person"]
BACK_KEYS = ["headband_on_forehead", "hair_solid", "no_smear", "same_person"]


def vlm_prompt_yesno(view_key):
    if view_key == "back":
        return ("Two images side by side: A is the reference drawing of the back of a stylized low-poly character's head, "
                "B is a render of a 3D model of the same character from the same angle. Compare B against A carefully. "
                "Answer ONLY with JSON of yes/no strings: {\"headband_on_forehead\": \"is the blue headband a clean continuous band around the head in B like in A\", "
                "\"hair_solid\": \"is the hair in B a solid dark mass without light gaps, holes or skin showing through\", "
                "\"no_smear\": \"is B free of smeared, doubled or stretched texture\", \"same_person\": \"does B match A in hair shape, colours and headband position\"}. "
                "Use the keys exactly; values are \"yes\" or \"no\".")
    return ("Two images side by side: A is the reference painting of a stylized low-poly character's face, B is a flat render of a 3D "
            "model of the same character from the same angle. Judge B strictly against A. Answer ONLY with JSON of yes/no strings with "
            "exactly these keys: {\"face_readable\": \"is the face in B clearly readable (eyes, brows, nose, mouth all visible)\", "
            "\"eyes_symmetric\": \"are the two eyes in B the same size and shape, on one horizontal line, at the same height as in A\", "
            "\"mouth_visible\": \"is the mouth in B as clearly drawn and as dark as in A\", \"headband_on_forehead\": \"is the blue headband in B "
            "on the forehead at the same height as in A\", \"hair_solid\": \"is the hair in B a solid dark mass without light gaps or skin showing through\", "
            "\"no_smear\": \"is B free of smeared, doubled, stretched or stray dark strokes (also on the neck and collar)\", "
            "\"same_person\": \"would a viewer say B is the same face as A (same face width, jaw shape, eye spacing, expression)\"}. Values are \"yes\" or \"no\".")


def vlm_prompt_coords(size):
    return ("Two %dx%d images side by side: A (left) is a painting of a face, B (right) is a 3D render of the same character. "
            "Do not reason, just estimate. For each image give pixel coordinates [x, y] inside that image (origin top-left, x right, y down, 0..%d) "
            "of: left_eye (the eye nearer the left edge of the image), right_eye, nose (tip), mouth (centre), chin (lowest point of the chin), "
            "headband (centre of the blue band). Answer ONLY with JSON: {\"A\": {\"left_eye\": [x, y], \"right_eye\": [x, y], \"nose\": [x, y], "
            "\"mouth\": [x, y], \"chin\": [x, y], \"headband\": [x, y]}, \"B\": {same keys}}" % (size, size, size))


# ----------------------------------------------------------------------------------------------- defects
def zone_of(cx, cy, lm, hm, face, is_back):
    H, W = face.shape
    inside = (0 <= int(cy) < H and 0 <= int(cx) < W and face[int(cy), int(cx)])
    axis = lm["axis"] if lm else hm["cx"]
    if is_back or lm is None:
        if cy > hm["neck"]:
            return "neck_collar"
        if cy < hm["top"] + 0.3 * hm["head_h"]:
            return "hair_top"
        if hm["top"] + 0.3 * hm["head_h"] <= cy < hm["top"] + 0.5 * hm["head_h"] and abs(cx - axis) < 0.35 * hm["head_w"]:
            return "forehead_headband"
        return "hair_left" if cx < axis else "hair_right"
    iod = lm["iod"]
    if not inside:
        if cy > lm["chin"][1] + 0.25 * iod:
            return "neck_collar"
        if cy < lm["brow_y"] - 0.6 * iod:
            return "hair_top"
        return "hair_left" if cx < axis else "hair_right"
    if cy < lm["brow_y"] - 0.25 * iod:
        return "forehead_headband"
    if abs(cy - lm["brow_y"]) <= 0.22 * iod:
        return "brows"
    if abs(cy - lm["eye_y"]) <= 0.3 * iod:
        return "left_eye" if cx < axis else "right_eye"
    if abs(cy - lm["mouth"][1]) <= 0.22 * iod and abs(cx - axis) < 0.6 * iod:
        return "mouth"
    if cy > lm["mouth"][1] + 0.22 * iod:
        return "chin"
    if abs(cx - axis) < 0.35 * iod:
        return "nose"
    return "left_cheek" if cx < axis else "right_cheek"


def comp_stats(m, ref_g, ren_g, ref_mask, ren_mask, ref_edges, ren_edges):
    ys, xs = np.nonzero(m)
    area = int(m.sum())
    bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    cxy = (float(xs.mean()), float(ys.mean()))
    cov = np.cov(np.vstack([xs, ys]).astype(np.float64)) if area > 3 else np.eye(2)
    ev = np.sort(np.linalg.eigvalsh(cov))[::-1]
    elong = float(math.sqrt(max(ev[0], 1e-6) / max(ev[1], 1e-6)))
    d = cv2.dilate(m.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    st = {"area": area, "bbox": bbox, "cxy": cxy, "elong": elong,
          "ref_std": float(ref_g[d].std()), "ren_std": float(ren_g[d].std()),
          "ref_ed": float(ref_edges[d].mean()), "ren_ed": float(ren_edges[d].mean()),
          "sil_xor": float((ref_mask[m] != ren_mask[m]).mean()),
          "hole": float((ref_mask[m] & ~ren_mask[m]).mean()),
          "ref_l": float(ref_g[m].mean()), "ren_l": float(ren_g[m].mean())}
    return st


def fmt(v, nd=1):
    return ("%%.%df" % nd % v).replace(".", ",")


def build_defects(view, ctx):
    """The view's defects: difference-map components + landmark offsets + silhouette + VLM."""
    lm, hm, is_back = ctx["lm"], ctx["hm"], view == "back"
    ref_g, ren_g = ctx["ref_g"], ctx["ren_g"]
    ref_mask, ren_mask = ctx["ref_mask"], ctx["ren_mask"]
    face = ctx["ref_fm"]["face"]
    face_h = lm["face_h"] if lm else hm["head_h"] * 0.6
    thr_px = THRESHOLDS["landmark_max_px_share"] * face_h
    head_area = float(ctx["roi"].sum())
    ref_edges = cv2.Canny(ref_g, 60, 140) > 0
    ren_edges = cv2.Canny(ren_g, 60, 140) > 0
    ref_lab, ren_lab = ctx["ref_lab"], ctx["ren_lab"]
    ref_bgr = composite(ctx["ref_rgba"])
    cam = ctx["camera"]
    defects = []
    boundary = cv2.morphologyEx(ref_mask.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((9, 9), np.uint8)) > 0
    hair_edge = cv2.morphologyEx(ctx["ref_fm"]["hair"].astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((9, 9), np.uint8)) > 0

    def add(zone, kind, bbox_ref, bbox_ren, measured, severity, action, params, text, extra=None):
        d = {"id": "d%d" % (len(defects) + 1), "view": view, "zone": zone, "kind": kind, "bbox_ref": [int(v) for v in bbox_ref],
             "bbox_render": [int(v) for v in bbox_ren], "measured": measured, "severity": severity,
             "instruction": {"action": action, "params": params, "text_ru": text}}
        if extra:
            d.update(extra)
        defects.append(d)
        return d

    def camera_params(dx=0.0, dy=0.0):
        return {"yaw": cam["yaw"], "pitch": cam["pitch"], "scale": round(cam.get("px_per_m_aligned", 0), 2), "dx": round(dx, 1), "dy": round(dy, 1)}

    def mask_path(m, name):
        p = os.path.join(ctx["mask_dir"], "%s_%s.png" % (view, name))
        cv2.imwrite(p, (cv2.dilate(m.astype(np.uint8), np.ones((9, 9), np.uint8)) * 255))
        return p

    vru = ctx["view_ru"]
    diff_share_total = float((ctx["diff_mask"] & ctx["roi"]).sum()) / max(head_area, 1.0)
    coarse = diff_share_total > COARSE_DIFF_SHARE
    if coarse:
        # a quarter or more of the head does not match - that is not a set of local defects but a general
        # texture mismatch: reproject the whole view first (multiview, with the other views), fix the geometry
        # right away, and look at the local texture defects on the next iteration (otherwise the executor fixes
        # them twice)
        offs = [ctx["offsets"][k] for k in ("left_eye", "right_eye", "mouth") if k in ctx["offsets"]]
        gx, gy = (float(np.mean([o[0] for o in offs])), float(np.mean([o[1] for o in offs]))) if offs else (0.0, 0.0)
        bb = _bbox_of(ctx["roi"] & (ref_mask | ren_mask))
        add("nose" if not is_back else "hair_top", "texture_smear", bb, bb,
            "%s %% площади головы отличается от референса (ΔE > %s после размытия); среднее смещение черт (%s; %s) px" % (
                fmt(100 * diff_share_total, 0), DIFF_DE, fmt(gx), fmt(gy)),
            "blocker", "reproject", {"view": view, "camera": camera_params(-gx, -gy), "zone_mask": None, "target_rgb": None,
                                     "warp": None, "multiview": True},
            "%s: %s %% площади головы не совпадает с референсом — перепроецировать ракурс целиком по эталону (совместно с остальными "
            "ракурсами, веса по нормали); локальные дефекты текстуры проверить после." % (vru, fmt(100 * diff_share_total, 0)),
            {"area_share": round(diff_share_total, 4)})
    # 0) a reference landmark not found on the render (no similar structure within 0.45 IOD)
    if lm and not coarse:
        for key, srcv in (ctx.get("lm_sources") or {}).items():
            if not str(srcv).startswith("not_found") or key not in ("left_eye", "right_eye", "nose", "mouth", "chin"):
                continue
            bb = _zone_bbox(key if key != "chin" else "chin", lm, hm) if key in ("left_eye", "right_eye", "mouth") else \
                [int(lm[key][0] - 0.35 * lm["iod"]), int(lm[key][1] - 0.25 * lm["iod"]), int(0.7 * lm["iod"]), int(0.5 * lm["iod"])]
            add(key, "missing_feature", bb, bb, "корреляция окна референса с рендером %s (нужно ≥ 0,6)" % srcv.split("(")[1].rstrip(")").replace(".", ","),
                "blocker" if key in ("left_eye", "right_eye", "mouth", "nose") else "major", "inpaint_from_ref",
                {"view": view, "camera": camera_params(), "zone_mask": [int(v) for v in bb], "target_rgb": None, "warp": None},
                "%s: %s на рендере не распознаётся (нет структуры референса в радиусе 0,45 IOD) — перенести зону с референса по маске." % (vru, ZONE_RU[key]))
    # 1) landmark offsets
    if lm and ctx["offsets"] and not coarse:
        shifts = {}
        for key, (dx, dy) in ctx["offsets"].items():
            if key not in ("left_eye", "right_eye", "nose", "mouth", "chin"):
                continue
            mag = math.hypot(dx, dy)
            shifts[key] = (dx, dy, mag)
        eye_pair = ("left_eye" in shifts and "right_eye" in shifts)
        global_shift = None
        if eye_pair and "mouth" in shifts:
            vs = np.array([shifts[k][:2] for k in ("left_eye", "right_eye", "mouth")])
            spread = np.abs(vs - vs.mean(0)).max()
            # eyes and mouth moved the same way (spread < 1.5 thresholds) - a whole-face shift, not three separate ones
            if spread < thr_px * 1.5 and np.hypot(*vs.mean(0)) > thr_px:
                global_shift = vs.mean(0)
        if global_shift is not None:
            gx, gy = float(global_shift[0]), float(global_shift[1])
            bb = [int(lm["axis"] - 1.1 * lm["iod"]), int(lm["brow_y"] - 0.5 * lm["iod"]), int(2.2 * lm["iod"]), int(lm["chin"][1] - lm["brow_y"] + 0.7 * lm["iod"])]
            add("nose", "feature_shift", bb, [bb[0] + gx, bb[1] + gy, bb[2], bb[3]],
                "все черты сдвинуты на (%s; %s) px = %s %% высоты лица" % (fmt(gx), fmt(gy), fmt(100 * math.hypot(gx, gy) / face_h)),
                "blocker", "reproject", {"view": view, "camera": camera_params(-gx, -gy), "zone_mask": None, "target_rgb": None,
                                         "warp": {"zone": "face", "dx_px": round(-gx, 1), "dy_px": round(-gy, 1), "falloff_px": int(0.8 * lm["iod"])}},
                "%s: всё лицо сдвинуто на %s px по x и %s px по y относительно референса — перепроецировать лицо с поправкой камеры dx=%s, dy=%s px." % (
                    vru, fmt(gx), fmt(gy), fmt(-gx), fmt(-gy)))
        for key, (dx, dy, mag) in shifts.items():
            if mag <= thr_px:
                continue
            if global_shift is not None and math.hypot(dx - global_shift[0], dy - global_shift[1]) <= thr_px:
                continue
            rx, ry = lm[key]
            r = 0.35 * lm["iod"]
            bb_ref = [rx - r, ry - r * 0.6, 2 * r, 1.2 * r]
            bb_ren = [rx + dx - r, ry + dy - r * 0.6, 2 * r, 1.2 * r]
            zone = key
            add(zone, "feature_shift", bb_ref, bb_ren,
                "сдвиг (%s; %s) px = %s %% высоты лица (порог %s %%)" % (fmt(dx), fmt(dy), fmt(100 * mag / face_h), fmt(100 * THRESHOLDS["landmark_max_px_share"], 0)),
                "blocker" if key in ("left_eye", "right_eye", "mouth") else "major", "geometry_warp",
                {"view": view, "camera": camera_params(-dx, -dy), "zone_mask": [int(v) for v in bb_ren], "target_rgb": None,
                 "warp": {"zone": zone, "dx_px": round(-dx, 1), "dy_px": round(-dy, 1), "falloff_px": int(0.5 * lm["iod"])}},
                "%s: %s на рендере смещён на %s px по x и %s px по y (%s %% высоты лица) — сдвинуть зону на dx=%s, dy=%s px." % (
                    vru, ZONE_RU[zone], fmt(dx), fmt(dy), fmt(100 * mag / face_h), fmt(-dx), fmt(-dy)))
        # eye asymmetry: interpupillary distance and the tilt of the eye line
        if eye_pair:
            rl, rr = np.array(lm["left_eye"]), np.array(lm["right_eye"])
            nl, nr = rl + np.array(shifts["left_eye"][:2]), rr + np.array(shifts["right_eye"][:2])
            d_ref, d_ren = float(np.linalg.norm(rr - rl)), float(np.linalg.norm(nr - nl))
            a_ref = math.degrees(math.atan2(rr[1] - rl[1], rr[0] - rl[0]))
            a_ren = math.degrees(math.atan2(nr[1] - nl[1], nr[0] - nl[0]))
            if abs(d_ren - d_ref) > thr_px or abs(a_ren - a_ref) > 3.0:
                worse = "left_eye" if shifts["left_eye"][2] >= shifts["right_eye"][2] else "right_eye"
                dx, dy = shifts[worse][:2]
                bb = [min(rl[0], nl[0]) - 0.3 * lm["iod"], min(rl[1], rr[1], nl[1], nr[1]) - 0.25 * lm["iod"],
                      d_ref + 0.6 * lm["iod"], max(rl[1], rr[1], nl[1], nr[1]) - min(rl[1], rr[1], nl[1], nr[1]) + 0.5 * lm["iod"]]
                add(worse, "feature_shift", bb, bb,
                    "межзрачковое расстояние %s px против %s px у референса (%s %%), наклон линии глаз %s° против %s°" % (
                        fmt(d_ren), fmt(d_ref), fmt(100 * (d_ren - d_ref) / d_ref), fmt(a_ren), fmt(a_ref)),
                    "blocker", "geometry_warp",
                    {"view": view, "camera": camera_params(-dx, -dy), "zone_mask": [int(v) for v in bb], "target_rgb": None,
                     "warp": {"zone": worse, "dx_px": round(-dx, 1), "dy_px": round(-dy, 1), "falloff_px": int(0.5 * lm["iod"])}},
                    "%s: глаза асимметричны — расстояние между зрачками %s px вместо %s px, линия глаз наклонена на %s° (референс %s°); "
                    "вернуть %s на место: dx=%s, dy=%s px." % (vru, fmt(d_ren), fmt(d_ref), fmt(a_ren), fmt(a_ref), ZONE_RU[worse], fmt(-dx), fmt(-dy)))
    # 2) silhouette
    sil_xor = (ref_mask ^ ren_mask) & ctx["roi"]
    sil_xor = cv2.morphologyEx(sil_xor.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0
    lab, n = ndimage.label(sil_xor)
    sil_comps = sorted([(int((lab == i).sum()), i) for i in range(1, n + 1)], reverse=True)
    n_sil = 0
    for area, i in sil_comps:
        if area < 0.01 * head_area or n_sil >= 4:
            break
        m = lab == i
        st = comp_stats(m, ref_g, ren_g, ref_mask, ren_mask, ref_edges, ren_edges)
        zone = zone_of(st["cxy"][0], st["cxy"][1], lm, hm, face, is_back)
        if zone == "neck_collar":  # shoulders and collar are not the face, geometry is not edited there
            continue
        n_sil += 1
        wider_ref = float(ref_mask[m].mean()) > 0.5
        vertical = zone in ("hair_top", "chin")
        thick = area / max(st["bbox"][2] if vertical else st["bbox"][3], 1)  # the mean band thickness, px
        # direction: where to move the render edge so it matches the reference
        sign = 1 if st["cxy"][0] > (lm["axis"] if lm else hm["cx"]) else -1
        dxp, dyp = (1 if wider_ref else -1) * sign * thick, 0.0
        if vertical:
            dxp, dyp = 0.0, (-1 if wider_ref else 1) * thick * (1 if zone == "hair_top" else -1)
        add(zone, "geometry_shape", st["bbox"], st["bbox"],
            "силуэт: %s в среднем на %s px (%s %% площади головы) в зоне «%s»" % ("у референса шире" if wider_ref else "у рендера лишнее", fmt(thick), fmt(100 * area / head_area), ZONE_RU[zone]),
            "major" if area > 0.025 * head_area else "minor", "geometry_warp",
            {"view": view, "camera": camera_params(), "zone_mask": mask_path(m, "sil_%d" % i), "target_rgb": None,
             "warp": {"zone": zone, "dx_px": round(dxp, 1), "dy_px": round(dyp, 1), "falloff_px": int(max(16, min(48, 1.0 * thick)))}},
            "%s: контур головы в зоне «%s» %s референса в среднем на %s px (полоса %sx%s px) — подвинуть сетку/контур (dx=%s, dy=%s px)." % (
                vru, ZONE_RU[zone], "уже" if wider_ref else "шире", fmt(thick), st["bbox"][2], st["bbox"][3], fmt(dxp), fmt(dyp)), {"area_share": round(area / head_area, 4)})
    # 3) the difference map
    # for defects the thin difference lines (face edges) are removed with a 9x9 dilation, otherwise they stitch
    # the whole face into one blob
    dmask = cv2.morphologyEx(ctx["diff_mask"].astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    lab, n = ndimage.label(dmask)
    cands = []
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        if area < max(80, 0.002 * head_area):
            continue
        cands.append((area, i))
    cands.sort(reverse=True)
    for area, i in (cands[:12] if not coarse else []):
        m = lab == i
        st = comp_stats(m, ref_g, ren_g, ref_mask, ren_mask, ref_edges, ren_edges)
        cx, cy = st["cxy"]
        zone = zone_of(cx, cy, lm, hm, face, is_back)
        share = area / head_area
        shift = local_shift(ref_g, ren_g, cx, cy, 96) if not is_back else None
        shift_mag = math.hypot(shift[0], shift[1]) if shift else 0.0
        on_boundary = float(boundary[m].mean()) > 0.35 or float(hair_edge[m].mean()) > 0.35
        de = float(np.linalg.norm(ref_lab[m] - ren_lab[m], axis=1).mean())
        falloff = int(max(24, 1.5 * math.sqrt(area)))
        sprawling = st["bbox"][2] > 0.6 * FRAME and share > 0.08
        if share > 0.15 or sprawling:
            # a blob of a quarter of the head - not a local defect but a general mismatch: reproject the whole view
            offs = [ctx["offsets"][k] for k in ("left_eye", "right_eye", "mouth") if k in ctx["offsets"]]
            gx, gy = (float(np.mean([o[0] for o in offs])), float(np.mean([o[1] for o in offs]))) if offs else (0.0, 0.0)
            add("nose" if not is_back else "hair_top", "texture_smear", st["bbox"], st["bbox"],
                "%s %% площади головы отличается от референса (ΔE > %s после размытия), средний ΔE %s" % (fmt(100 * share, 0), DIFF_DE, fmt(de)),
                "blocker", "reproject", {"view": view, "camera": camera_params(-gx, -gy), "zone_mask": mask_path(m, "diff_%d" % i), "target_rgb": None,
                                         "warp": {"zone": "face" if not is_back else "head", "dx_px": round(-gx, 1), "dy_px": round(-gy, 1), "falloff_px": falloff}},
                "%s: %s %% площади головы не совпадает с референсом (ΔE %s) — перепроецировать ракурс целиком с поправкой камеры dx=%s, dy=%s px." % (
                    vru, fmt(100 * share, 0), fmt(de), fmt(-gx), fmt(-gy)), {"area_share": round(share, 4)})
            continue
        if st["sil_xor"] > 0.5:
            kind = "hole" if st["hole"] > 0.5 and not on_boundary else "geometry_shape"
        elif shift and shift[2] >= 0.55 and shift_mag > max(thr_px, LOCAL_SHIFT_MIN) and st["ref_ed"] > 0.03 and st["ren_ed"] > 0.015:
            kind = "feature_shift"
        elif st["ref_ed"] > 0.035 and st["ren_ed"] < 0.5 * st["ref_ed"]:
            kind = "missing_feature"
        elif st["ref_std"] > 9 and st["ren_std"] < 0.5 * st["ref_std"]:
            kind = "texture_smear"
        elif st["elong"] > 3.5 and (on_boundary or st["ren_ed"] > 1.5 * st["ref_ed"]):
            kind = "seam"
        elif st["ren_std"] > 1.6 * st["ref_std"] + 4 or st["ren_ed"] > 1.8 * st["ref_ed"] + 0.01:
            kind = "texture_smear"
        else:
            kind = "colour_off"
        if zone == "neck_collar" and kind not in ("texture_smear", "colour_off"):
            continue  # the shoulder and collar geometry is not the face; only stray strokes and colour are caught in this zone
        target = [int(v) for v in ref_bgr[m].mean(0)[::-1]]
        ren_rgb = [int(v) for v in composite(ctx["ren_rgba"])[m].mean(0)[::-1]]
        falloff = int(max(24, 1.5 * math.sqrt(area)))
        sev = severity_for(zone, kind, share)
        mp = mask_path(m, "diff_%d" % i)
        falloff = int(max(24, 1.5 * math.sqrt(area)))
        if kind == "feature_shift":
            action = "reproject" if zone in ("left_eye", "right_eye", "nose", "mouth", "brows") else "geometry_warp"
            params = {"view": view, "camera": camera_params(-shift[0], -shift[1]), "zone_mask": mp, "target_rgb": None,
                      "warp": {"zone": zone, "dx_px": round(-shift[0], 1), "dy_px": round(-shift[1], 1), "falloff_px": falloff}}
            measured = "локальный сдвиг (%s; %s) px = %s %% высоты лица, ΔE %s" % (fmt(shift[0]), fmt(shift[1]), fmt(100 * shift_mag / face_h), fmt(de))
            text = "%s: %s — текстура сдвинута на %s px по x и %s px по y; перепроецировать зону с поправкой dx=%s, dy=%s px." % (
                vru, ZONE_RU[zone], fmt(shift[0]), fmt(shift[1]), fmt(-shift[0]), fmt(-shift[1]))
        elif kind == "colour_off":
            action = "recolor"
            params = {"view": view, "camera": camera_params(), "zone_mask": mp, "target_rgb": target, "warp": None}
            measured = "средний ΔE %s, рендер RGB %s против референса RGB %s, площадь %s %% головы" % (fmt(de), ren_rgb, target, fmt(100 * share, 2))
            text = "%s: %s — цвет не тот (ΔE %s): перекрасить пятно %sx%s px в цвет референса RGB %s." % (vru, ZONE_RU[zone], fmt(de), st["bbox"][2], st["bbox"][3], target)
        elif kind == "seam":
            action = "fill_seam"
            params = {"view": view, "camera": camera_params(), "zone_mask": mp, "target_rgb": target, "warp": None}
            measured = "вытянутая линия %sx%s px (вытянутость %s), ΔE %s" % (st["bbox"][2], st["bbox"][3], fmt(st["elong"]), fmt(de))
            text = "%s: шов-линия в зоне «%s» (%sx%s px) — залить цветом соседних текселей референса." % (vru, ZONE_RU[zone], st["bbox"][2], st["bbox"][3])
        elif kind in ("missing_feature", "hole", "texture_smear"):
            action = "inpaint_from_ref"
            params = {"view": view, "camera": camera_params(), "zone_mask": mp, "target_rgb": target, "warp": None}
            if kind == "hole":
                measured = "просвет: у референса непрозрачно, у рендера пусто на %s px² (%s %% головы)" % (area, fmt(100 * share, 2))
                text = "%s: дыра/просвет в зоне «%s» (%sx%s px) — закрыть геометрией или заполнить текстурой референса." % (vru, ZONE_RU[zone], st["bbox"][2], st["bbox"][3])
            elif kind == "missing_feature":
                measured = "плотность краёв референса %s против %s у рендера, ΔE %s" % (fmt(st["ref_ed"], 3), fmt(st["ren_ed"], 3), fmt(de))
                text = "%s: в зоне «%s» нет детали, которая есть на референсе (%sx%s px) — перенести фрагмент референса по маске." % (vru, ZONE_RU[zone], st["bbox"][2], st["bbox"][3])
            else:
                smeared = st["ren_std"] < st["ref_std"]
                measured = "σ яркости рендера %s против %s у референса, края %s/%s, ΔE %s" % (fmt(st["ren_std"]), fmt(st["ref_std"]), fmt(st["ren_ed"], 3), fmt(st["ref_ed"], 3), fmt(de))
                text = "%s: %s — %s (%sx%s px); перерисовать зону по референсу." % (
                    vru, ZONE_RU[zone], "текстура размыта/плоская там, где у референса есть детали" if smeared else "лишние тёмные мазки/штрихи, которых нет на референсе", st["bbox"][2], st["bbox"][3])
        else:  # geometry_shape
            action = "geometry_warp"
            params = {"view": view, "camera": camera_params(), "zone_mask": mp, "target_rgb": None,
                      "warp": {"zone": zone, "dx_px": 0.0, "dy_px": 0.0, "falloff_px": falloff}}
            measured = "силуэты расходятся на %s %% пикселей пятна" % fmt(100 * st["sil_xor"], 0)
            text = "%s: форма в зоне «%s» не совпадает с референсом (%sx%s px) — подогнать сетку." % (vru, ZONE_RU[zone], st["bbox"][2], st["bbox"][3])
        bb_ren = st["bbox"] if not shift else [st["bbox"][0] + shift[0], st["bbox"][1] + shift[1], st["bbox"][2], st["bbox"][3]]
        add(zone, kind, st["bbox"], bb_ren, measured, sev, action, params, text, {"area_share": round(share, 4)})
    # 4) feature masks: hair see-through / stray dark blobs (hair xor)
    rfm, nfm = ctx["ref_fm"], ctx["ren_fm"]
    for cls_name, kind_missing, kind_extra, text_missing, text_extra in ([] if coarse else [
            ("hair", "hole", "texture_smear", "просвет в волосах: у референса волосы, у рендера нет", "тёмное пятно волос там, где у референса их нет"),
            ("headband", "missing_feature", "texture_smear", "повязки нет там, где она есть у референса", "синее пятно повязки там, где его нет у референса")]):
        x = rfm[cls_name] ^ nfm[cls_name]
        x = cv2.morphologyEx(x.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0
        lab, n = ndimage.label(x)
        for i in range(1, n + 1):
            m = lab == i
            area = int(m.sum())
            if area < max(120, 0.004 * head_area):
                continue
            if any(_bbox_overlap(d["bbox_ref"], _bbox_of(m)) > 0.6 for d in defects):
                continue
            st = comp_stats(m, ref_g, ren_g, ref_mask, ren_mask, ref_edges, ren_edges)
            zone = zone_of(st["cxy"][0], st["cxy"][1], lm, hm, face, is_back)
            missing = float(rfm[cls_name][m].mean()) > 0.5
            target = [int(v) for v in ref_bgr[m].mean(0)[::-1]]
            add(zone, kind_missing if missing else kind_extra, st["bbox"], st["bbox"],
                "маска «%s»: %s, %s px² (%s %% головы)" % (cls_name, "нет на рендере" if missing else "лишнее на рендере", area, fmt(100 * area / head_area, 2)),
                severity_for(zone, kind_missing if missing else kind_extra, area / head_area), "inpaint_from_ref",
                {"view": view, "camera": camera_params(), "zone_mask": mask_path(m, "%s_%d" % (cls_name, i)), "target_rgb": target, "warp": None},
                "%s: %s — %s (%sx%s px, зона «%s»); перенести фрагмент референса по маске." % (vru, cls_name, text_missing if missing else text_extra, st["bbox"][2], st["bbox"][3], ZONE_RU[zone]))
    # 5) VLM "no" answers
    vlm = ctx.get("vlm") or {}
    vlm_zone = {"face_readable": "nose", "eyes_symmetric": "left_eye", "mouth_visible": "mouth", "headband_on_forehead": "forehead_headband",
                "hair_solid": "hair_top", "no_smear": "left_cheek", "same_person": "nose"}
    vlm_text = {"face_readable": "лицо плохо читается", "eyes_symmetric": "глаза не симметричны", "mouth_visible": "рот не виден/бледный",
                "headband_on_forehead": "повязка не на лбу / не как на референсе", "hair_solid": "волосы с просветами", "no_smear": "есть размазня или лишние штрихи",
                "same_person": "не тот же человек, что на референсе"}
    if is_back:
        vlm_zone = {"headband_on_forehead": "forehead_headband", "hair_solid": "hair_top", "no_smear": "hair_left", "same_person": "hair_top"}
    for k, v in vlm.items():
        if v is False and k in vlm_zone and not coarse:
            zone = vlm_zone[k]
            bb = _zone_bbox(zone, lm, hm)
            add(zone, "texture_smear" if k in ("no_smear",) else ("missing_feature" if k in ("mouth_visible", "hair_solid", "headband_on_forehead") else "feature_shift"),
                bb, bb, "VLM qwen3-vl: %s = no" % k, "major" if ctx["strict"] else "minor", "inpaint_from_ref",
                {"view": view, "camera": camera_params(), "zone_mask": [int(x) for x in bb], "target_rgb": None, "warp": None},
                "%s: по оценке VLM %s — перерисовать зону «%s» по референсу." % (vru, vlm_text[k], ZONE_RU[zone]))
    return defects


FACE_ZONES = ("left_eye", "right_eye", "nose", "mouth", "brows")


def severity_for(zone, kind, share):
    """Severity: face features - blocker (except pure colour), cheeks/chin/forehead - major, hair/neck - by area."""
    if zone in FACE_ZONES:
        return "major" if kind == "colour_off" and share < 0.005 else "blocker"
    if zone in ("left_cheek", "right_cheek", "chin", "forehead_headband"):
        return "blocker" if share > 0.02 else "major"
    return "major" if share > 0.01 or kind in ("hole", "missing_feature") else "minor"


def _bbox_of(m):
    ys, xs = np.nonzero(m)
    return [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]


def _bbox_overlap(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / max(1, min(a[2] * a[3], b[2] * b[3]))


def _zone_bbox(zone, lm, hm):
    if lm is None:
        return [int(hm["cx"] - 0.5 * hm["head_w"]), int(hm["top"]), int(hm["head_w"]), int(hm["head_h"])]
    iod, ax = lm["iod"], lm["axis"]
    if zone in ("left_eye", "right_eye"):
        x, y = lm[zone]
        return [int(x - 0.4 * iod), int(y - 0.3 * iod), int(0.8 * iod), int(0.6 * iod)]
    if zone == "mouth":
        return [int(ax - 0.5 * iod), int(lm["mouth"][1] - 0.25 * iod), int(iod), int(0.5 * iod)]
    if zone == "forehead_headband":
        return [int(ax - 1.1 * iod), int(lm["brow_y"] - 1.0 * iod), int(2.2 * iod), int(0.75 * iod)]
    if zone == "hair_top":
        return [int(ax - 1.2 * iod), int(hm["top"]), int(2.4 * iod), int(max(lm["brow_y"] - 0.9 * iod - hm["top"], 20))]
    return [int(ax - 1.1 * iod), int(lm["brow_y"] - 0.4 * iod), int(2.2 * iod), int(lm["chin"][1] - lm["brow_y"] + 0.6 * iod)]


# ----------------------------------------------------------------------------------------------- per-view analysis
def analyse_view(key, view_ru, ref_rgba_full, raw_candidates, out_dir, mask_dir, strict, fixed_cam=None):
    """raw_candidates: a list of (rgba, camera) - for 3/4 both yaw signs; the best one is picked by silhouette
    IoU. fixed_cam: the frame_camera from the previous report - the frame is not searched again but taken as
    is (the fix cycle: the executor painted exactly in this frame, so the check has to run in it too;
    otherwise ECC "drifts" 2-3 px and 1-2° between iterations and the whole difference is the frame shift,
    not the paint)."""
    is_back = key == "back"
    ref_rgba = resize_frame(ref_rgba_full)
    ref_mask = alpha_mask(ref_rgba)
    ref_hm = head_measure(ref_mask)
    if ref_hm is None:
        raise RuntimeError("empty reference %s" % key)
    H = FRAME
    ref_g, ref_lab = gray_of(ref_rgba), lab_of(ref_rgba)
    # --- the reference features are computed before alignment: the ROI (head + neck down to the collar) depends on them
    rows0 = roi_rows_for(ref_hm, None, H)
    centers, cls = kmeans_classes(ref_lab, ref_mask & rows0)
    ref_idx = label_by_centers(ref_lab, ref_mask & rows0, centers)
    ref_fm0 = feature_masks(ref_idx, cls, ref_mask & rows0, ref_hm, None, is_back)
    lm = None if is_back else ref_landmarks(ref_g, ref_fm0, ref_hm)
    roi_rows = roi_rows_for(ref_hm, lm, H)
    # --- picking the render (for 3/4 - the yaw sign) by silhouette, then by gray correlation
    best = None
    if fixed_cam is not None:
        fixed_yaw = float(fixed_cam["yaw"])
        pick = [rc for rc in raw_candidates if abs(float(rc[1].get("yaw", 0)) - fixed_yaw) < 0.5]
        if not pick:
            raise RuntimeError("%s: the renders have no yaw %.1f from the fixed frame" % (key, fixed_yaw))
        raw, cam = pick[0]
        Mc = np.asarray(fixed_cam["post"], np.float64)
        T = lambda t: np.array([[1, 0, t], [0, 1, t], [0, 0, 1]], np.float64)  # noqa: E731
        M = (T(-0.5) @ np.vstack([Mc, [0, 0, 1]]) @ T(0.5))[:2]
        ren_rgba = cv2.warpAffine(raw, M.astype(np.float32), (FRAME, FRAME), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        ren_mask = alpha_mask(ren_rgba)
        roi = (ref_mask | ren_mask) & roi_rows
        scale = math.sqrt(abs(M[0, 0] * M[1, 1] - M[0, 1] * M[1, 0]))
        rot = math.degrees(math.atan2(M[1, 0], M[0, 0]))
        sil0 = iou(ref_mask & roi_rows, ren_mask & roi_rows) or 0.0
        corr0 = ncc_gray(ref_g, gray_of(ren_rgba), roi)
        cam = dict(cam, px_per_m_aligned=cam.get("px_per_m", 0) * scale)
        align = {"scale": round(scale, 5), "dx": round(float(M[0, 2]), 2), "dy": round(float(M[1, 2]), 2), "rot_deg": round(rot, 3),
                 "method": "fixed_frame", "ecc": "skipped (frame_from)", "camera": cam, "gray_corr": round(corr0, 4),
                 "ref_head": {k: (round(v, 1) if isinstance(v, float) else v) for k, v in ref_hm.items()},
                 "frame_camera": dict(fixed_cam, self_iou="fixed")}
        return _analyse_rest(key, view_ru, ref_rgba, ref_mask, ref_hm, ref_g, ref_lab, centers, cls, lm, roi_rows, ren_rgba, ren_mask, roi,
                             cam, align, sil0, out_dir, mask_dir, strict, is_back)
    for raw, cam in raw_candidates:
        raw_mask = alpha_mask(raw)
        hm = head_measure(raw_mask)
        if hm is None:
            continue
        scale, dx, dy, sil = sil_align(ref_mask, roi_rows, ref_hm, raw_mask, hm)
        warped = warp_rgba(raw, scale, dx, dy)
        roi_c = (ref_mask | alpha_mask(warped)) & roi_rows
        corr = ncc_gray(ref_g, gray_of(warped), roi_c)
        key_score = corr + 0.2 * sil
        if best is None or key_score > best[0]:
            best = (key_score, warped, cam, scale, dx, dy, sil, corr)
    if best is None:
        raise RuntimeError("no render for %s" % key)
    _, ren_rgba, cam, scale, dx, dy, sil0, corr0 = best
    roi = (ref_mask | alpha_mask(ren_rgba)) & roi_rows
    ren_rgba, ecc, ecc_note = ecc_refine(ref_rgba, ren_rgba, roi)
    ren_mask = alpha_mask(ren_rgba)
    roi = (ref_mask | ren_mask) & roi_rows
    tot_dx, tot_dy, rot = dx, dy, 0.0
    if ecc is not None:
        rot = math.degrees(math.atan2(ecc[1, 0], ecc[0, 0]))
        tot_dx, tot_dy = dx - float(ecc[0, 2]), dy - float(ecc[1, 2])
    cam = dict(cam, px_per_m_aligned=cam.get("px_per_m", 0) * scale)
    align = {"scale": round(scale, 5), "dx": round(tot_dx, 2), "dy": round(tot_dy, 2), "rot_deg": round(rot, 3),
             "method": "silhouette+ecc" if ecc is not None else "silhouette", "ecc": ecc_note, "camera": cam, "gray_corr": round(corr0, 4),
             "ref_head": {k: (round(v, 1) if isinstance(v, float) else v) for k, v in ref_hm.items()}}
    if cam.get("centre") is not None:
        # the exact check-frame camera for face_fix: the raw Blender frame (centre, px_per_m, raw_size) + the
        # affine map "silhouette scale -> shift -> ECC" in continuous coordinates (pixel centre +0.5)
        M1 = np.array([[scale, 0.0, dx], [0.0, scale, dy], [0.0, 0.0, 1.0]], np.float64)
        if ecc is not None:
            W = np.vstack([np.asarray(ecc, np.float64), [0.0, 0.0, 1.0]])
            M = np.linalg.inv(W) @ M1
        else:
            M = M1
        T = lambda t: np.array([[1, 0, t], [0, 1, t], [0, 0, 1]], np.float64)  # noqa: E731
        Mc = T(0.5) @ M @ T(-0.5)
        align["frame_camera"] = {"yaw": cam["yaw"], "pitch": cam["pitch"], "centre": [float(c) for c in cam["centre"]],
                                 "px_per_m": float(cam["px_per_m"]), "raw_size": int(cam.get("size", 1600)), "size": FRAME,
                                 "post": [[round(float(x), 6) for x in row] for row in Mc[:2]]}
        # self-check: the raw render silhouette through post must match the aligned one (IoU)
        try:
            raw0 = [r for r in raw_candidates if r[1] is cam or r[1].get("yaw") == cam["yaw"]][0][0]
            chk = cv2.warpAffine(alpha_mask(raw0).astype(np.uint8), np.asarray(M[:2], np.float32), (FRAME, FRAME), flags=cv2.INTER_NEAREST) > 0
            align["frame_camera"]["self_iou"] = round(iou(chk & roi_rows, ren_mask & roi_rows) or 0.0, 4)
        except Exception as exc:  # pragma: no cover
            align["frame_camera"]["self_iou"] = "err: %s" % exc
    return _analyse_rest(key, view_ru, ref_rgba, ref_mask, ref_hm, ref_g, ref_lab, centers, cls, lm, roi_rows, ren_rgba, ren_mask, roi,
                         cam, align, sil0, out_dir, mask_dir, strict, is_back)


def _analyse_rest(key, view_ru, ref_rgba, ref_mask, ref_hm, ref_g, ref_lab, centers, cls, lm, roi_rows, ren_rgba, ren_mask, roi,
                  cam, align, sil0, out_dir, mask_dir, strict, is_back):
    ren_g, ren_lab = gray_of(ren_rgba), lab_of(ren_rgba)
    # --- metrics
    sil_iou = iou(ref_mask & roi_rows, ren_mask & roi_rows) or 0.0
    _, smap = structural_similarity(ref_g, ren_g, data_range=255, win_size=7, full=True)
    ssim = float(smap[roi].mean()) if roi.any() else 0.0
    ref_edges = cv2.Canny(ref_g, 60, 140) > 0
    ren_edges = cv2.Canny(ren_g, 60, 140) > 0
    ref_edges &= roi
    ren_edges &= roi
    if ref_edges.any() and ren_edges.any():
        d1 = ndimage.distance_transform_edt(~ref_edges)[ren_edges].mean()
        d2 = ndimage.distance_transform_edt(~ren_edges)[ref_edges].mean()
        chamfer = float((d1 + d2) / 2)
    else:
        chamfer = 99.0
    ref_idx = label_by_centers(ref_lab, ref_mask & roi_rows, centers)
    ren_idx = label_by_centers(ren_lab, ren_mask & roi_rows, centers)
    ref_fm = feature_masks(ref_idx, cls, ref_mask & roi_rows, ref_hm, lm, is_back)
    ren_fm = feature_masks(ren_idx, cls, ren_mask & roi_rows, ref_hm, lm, is_back)
    fiou = {k: iou(ref_fm[k], ren_fm[k]) for k in ("skin", "hair", "headband", "dark_features")}
    offsets, sources, ren_lm = {}, {}, {}
    if lm is not None:
        ren_lm, sources = render_landmarks(lm, ref_g, ren_g, ren_fm)
        for k in ("left_eye", "right_eye", "nose", "mouth", "chin"):
            if k in ren_lm:
                offsets[k] = [round(ren_lm[k][0] - lm[k][0], 1), round(ren_lm[k][1] - lm[k][1], 1)]
    # difference map
    de = np.linalg.norm(ref_lab - ren_lab, axis=2)
    de_b = cv2.GaussianBlur(de.astype(np.float32), (11, 11), 2.5)
    diff_mask = (de_b > DIFF_DE) & roi
    diff_mask = cv2.morphologyEx(diff_mask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    head_area = float((ref_mask & roi_rows).sum())
    diff_share = float(diff_mask.sum() / max(head_area, 1))
    face_h = lm["face_h"] if lm else ref_hm["head_h"] * 0.6
    lm_max = max([math.hypot(*v) for v in offsets.values()], default=0.0)
    metrics = {"silhouette_iou": round(sil_iou, 4), "ssim_gray": round(ssim, 4), "edge_chamfer_px": round(chamfer, 2),
               "feature_mask_iou": {k: (round(v, 4) if v is not None else None) for k, v in fiou.items()},
               "landmark_offsets_px": offsets, "landmark_sources": sources, "landmark_max_px": round(lm_max, 1),
               "landmark_max_share": round(lm_max / face_h, 4), "face_h_px": round(face_h, 1),
               "diff_area_share": round(diff_share, 4), "cluster_classes": cls, "vlm": {}}
    ctx = {"lm": lm, "hm": ref_hm, "ref_g": ref_g, "ren_g": ren_g, "ref_mask": ref_mask, "ren_mask": ren_mask, "ref_fm": ref_fm,
           "ren_fm": ren_fm, "ref_lab": ref_lab, "ren_lab": ren_lab, "ref_rgba": ref_rgba, "ren_rgba": ren_rgba, "roi": roi,
           "diff_mask": diff_mask, "offsets": offsets, "camera": cam, "mask_dir": mask_dir, "view_ru": view_ru, "strict": strict,
           "de_map": de_b, "ren_lm": ren_lm, "sil_pre_ecc": sil0, "lm_sources": sources}
    ref_path = os.path.join(out_dir, "ref_%s.png" % key)
    ren_path = os.path.join(out_dir, "render_%s.png" % key)
    cv2.imwrite(ref_path, ref_rgba)
    cv2.imwrite(ren_path, ren_rgba)
    return {"ref": ref_path, "render": ren_path, "align": align, "metrics": metrics}, ctx


def view_score(metrics, is_back):
    q = []
    q.append((0.25, min(max(metrics["ssim_gray"], 0.0), 1.0)))
    f = [v for v in metrics["feature_mask_iou"].values() if v is not None]
    q.append((0.20, float(np.mean(f)) if f else 0.0))
    if not is_back:
        q.append((0.20, min(max(1.0 - metrics["landmark_max_share"] / 0.10, 0.0), 1.0)))
    q.append((0.20, min(max(1.0 - metrics["diff_area_share"] / 0.05, 0.0), 1.0)))
    q.append((0.10, min(max((metrics["silhouette_iou"] - 0.5) / 0.5, 0.0), 1.0)))
    vlm = {k: v for k, v in metrics.get("vlm", {}).items() if isinstance(v, bool)}
    if vlm:
        q.append((0.05, sum(1 for v in vlm.values() if v) / len(vlm)))
    w = sum(a for a, _ in q)
    return round(100.0 * sum(a * b for a, b in q) / w, 1)


def view_pass(metrics, is_back, strict):
    t = THRESHOLDS
    ok = metrics["ssim_gray"] >= t["ssim_gray"] and metrics["silhouette_iou"] >= t["silhouette_iou"] \
        and metrics["diff_area_share"] <= t["diff_area_share_max"]
    f = [v for v in metrics["feature_mask_iou"].values() if v is not None]
    ok = ok and all(v >= t["feature_mask_iou_min"] for v in f)
    if not is_back:
        ok = ok and metrics["landmark_max_share"] <= t["landmark_max_px_share"]
    if strict:
        ok = ok and all(v for v in metrics.get("vlm", {}).values() if isinstance(v, bool))
    return bool(ok)


# ----------------------------------------------------------------------------------------------- sheet
def put_text_ru(img_bgr, text, xy, size=18, color=(20, 20, 20)):
    try:
        from PIL import Image, ImageDraw, ImageFont
        font = None
        for f in (r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\segoeui.ttf",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
                  "/usr/share/fonts/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf"):
            if os.path.isfile(f):
                font = ImageFont.truetype(f, size)
                break
        pil = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
        ImageDraw.Draw(pil).text(xy, text, fill=color[::-1], font=font)
        img_bgr[:] = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception:
        cv2.putText(img_bgr, text.encode("ascii", "replace").decode(), (xy[0], xy[1] + size), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)


def build_sheet(path, views, ctxs, defects, report):
    cell, head = 360, 70
    cols = 8
    W, Hh = cell * cols, head + 2 * cell + 24
    sheet = np.full((Hh, W, 3), 214, np.uint8)
    SEV = {"blocker": (0, 0, 230), "major": (0, 120, 255), "minor": (0, 190, 230)}

    def tile(img):
        return cv2.resize(img, (cell, cell), interpolation=cv2.INTER_AREA)
    for i, key in enumerate([v[0] for v in VIEWS if v[0] in views]):
        ctx, v = ctxs[key], views[key]
        ref = composite(ctx["ref_rgba"]).copy()
        ren = composite(ctx["ren_rgba"]).copy()
        lm = ctx["lm"]
        if lm:
            for k in ("left_eye", "right_eye", "nose", "mouth", "chin", "brows"):
                x, y = lm[k]
                cv2.circle(ref, (int(x), int(y)), 5, (0, 200, 0), 2)
            for k, p in ctx["ren_lm"].items():
                if k.endswith("_bbox"):
                    continue
                cv2.circle(ren, (int(p[0]), int(p[1])), 5, (0, 200, 0), 2)
                if k in lm:
                    cv2.line(ren, (int(lm[k][0]), int(lm[k][1])), (int(p[0]), int(p[1])), (0, 0, 255), 2)
        for d in defects:
            if d["view"] != key:
                continue
            x, y, w, h = d["bbox_ref"]
            cv2.rectangle(ren, (x, y), (x + w, y + h), SEV[d["severity"]], 3)
            cv2.putText(ren, d["id"], (x + 2, max(y - 4, 12)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, SEV[d["severity"]], 2)
        heat = cv2.applyColorMap(np.clip(ctx["de_map"] * (255.0 / 40.0), 0, 255).astype(np.uint8), cv2.COLORMAP_JET)
        heat[~ctx["roi"]] = (214, 214, 214)
        over = composite(ctx["ref_rgba"]) // 2 + 60
        rf, nf = ctx["ref_fm"], ctx["ren_fm"]
        for name, col in (("dark_features", (0, 255, 0)), ("hair", (255, 160, 0)), ("headband", (255, 0, 160))):
            over[rf[name]] = (np.array(col) * 0.6 + over[rf[name]] * 0.4).astype(np.uint8)
        for name in ("dark_features", "hair", "headband"):
            edge = cv2.morphologyEx(nf[name].astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
            over[edge] = (0, 0, 255)
        y0 = head
        sheet[y0:y0 + cell, i * cell:(i + 1) * cell] = tile(ref)
        sheet[y0 + cell:y0 + 2 * cell, i * cell:(i + 1) * cell] = tile(ren)
        sheet[y0:y0 + cell, (4 + i) * cell:(5 + i) * cell] = tile(heat)
        sheet[y0 + cell:y0 + 2 * cell, (4 + i) * cell:(5 + i) * cell] = tile(over)
        m = v["metrics"]
        put_text_ru(sheet, "%s — референс" % dict((a, e) for a, _, _, _, e in VIEWS)[key], (i * cell + 6, y0 + 4), 16, (255, 255, 255))
        put_text_ru(sheet, "рендер  score %s  ssim %s  iou %s  diff %s%%  сдвиг %s px" % (
            v["score"], m["ssim_gray"], m["silhouette_iou"], fmt(100 * m["diff_area_share"]), m["landmark_max_px"]), (i * cell + 6, y0 + cell + 4), 14, (255, 255, 255))
        put_text_ru(sheet, "ΔE (0..40)", ((4 + i) * cell + 6, y0 + 4), 16, (255, 255, 255))
        put_text_ru(sheet, "маски черт: референс цветом, рендер — красный контур", ((4 + i) * cell + 6, y0 + cell + 4), 14, (255, 255, 255))
    put_text_ru(sheet, "face_match  %s  итерация %s  score %s  %s  дефектов: %d (blocker %d, major %d, minor %d)" % (
        os.path.basename(report["model"]), report["iteration"], report["score"], "PASS" if report["pass"] else "FAIL", len(defects),
        sum(d["severity"] == "blocker" for d in defects), sum(d["severity"] == "major" for d in defects), sum(d["severity"] == "minor" for d in defects)),
        (10, 8), 24)
    put_text_ru(sheet, "сверху референсы (зелёные точки — черты), снизу рендеры (рамки: красный blocker, оранжевый major, жёлтый minor); справа тепловая карта ΔE и наложение масок черт. Пороги: " +
                ", ".join("%s %s" % (k, v) for k, v in THRESHOLDS.items()), (10, 40), 15, (60, 60, 60))
    cv2.imwrite(path, sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])


# ----------------------------------------------------------------------------------------------- main
def render_model(model, out_dir, blender, fixed=None):
    # 3/4: the exact reference angle (the GPT picture) is unknown - render 15..45° of both signs, the view is
    # chosen by correlation
    views = [{"name": "front", "yaw": 0}, {"name": "back", "yaw": 180}]
    views += [{"name": "y%+d" % y, "yaw": y} for c in YAW34_CANDIDATES for y in (c, -c)]
    spec = {"res": 1600, "frame_frac": 0.28, "center_frac": 0.10, "views": views}
    if fixed:  # the frame from the previous report: the same camera the executor painted in
        spec["centre"] = fixed["centre"]
        spec["frame_m"] = float(fixed.get("raw_size", 1600)) / float(fixed["px_per_m"])
        spec["res"] = int(fixed.get("raw_size", 1600))
        log("camera fixed by the previous report: centre %s, frame %.4f m" % ([round(c, 4) for c in spec["centre"]], spec["frame_m"]))
    rdir = os.path.join(out_dir, "render_raw")
    os.makedirs(rdir, exist_ok=True)
    spec_path = os.path.join(rdir, "spec.json")
    with open(spec_path, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)
    cmd = [blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "face_render.py"), "--", model, rdir, spec_path]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    if "FACE_RENDER_OK" not in (p.stdout or ""):
        raise RuntimeError("Blender did not render: %s" % ((p.stdout or "")[-1500:] + (p.stderr or "")[-1500:]))
    log("rendered %d views: %.1f s" % (len(views), time.time() - t0))
    with open(os.path.join(rdir, "raw_info.json"), "r", encoding="utf-8") as fh:
        info = json.load(fh)
    centre = [info["cx"], info["cy"], info["zc"]]
    return {name: (load_rgba(v["png"]), {"yaw": v["yaw"], "pitch": v["pitch"], "px_per_m": v["px_per_m"], "centre": centre,
                                         "size": info["res"]}) for name, v in info["views"].items()}


def prerendered(model_dir, key, ref_name):
    for cand in ("%s.png" % key, "raw_%s.png" % key, "render_%s.png" % key, ref_name):
        p = os.path.join(model_dir, cand)
        if os.path.isfile(p):
            return [(load_rgba(p), {"yaw": {"front": 0.0, "back": 180.0}.get(key, 35.0 if key == "face34_right" else -35.0), "pitch": 0.0, "px_per_m": 0.0, "source": p})]
    return []


def parse_thresholds(text):
    """--thresholds: JSON text or a path to .json; known keys only, numbers 0..1."""
    if os.path.isfile(text):
        with open(text, "r", encoding="utf-8") as fh:
            t = json.load(fh)
    else:
        t = json.loads(text)
    if not isinstance(t, dict):
        raise ValueError("--thresholds: an object {threshold: number} is expected")
    bad = [k for k in t if k not in THRESHOLDS]
    if bad:
        raise ValueError("--thresholds: unknown thresholds %s; allowed: %s" % (bad, ", ".join(THRESHOLDS)))
    for k, v in t.items():
        if not isinstance(v, (int, float)) or not 0.0 <= float(v) <= 1.0:
            raise ValueError("--thresholds: threshold %s is a number from 0 to 1, got %r" % (k, v))
    return {k: float(v) for k, v in t.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help=".blend/.glb or a folder with ready renders (calibration)")
    ap.add_argument("--refs", required=True, help="folder with face_front_rgba.png, face34_rgba.png, face34_flip_rgba.png, head_back_rgba.png")
    ap.add_argument("--out", required=True)
    ap.add_argument("--iteration", type=int, default=0)
    ap.add_argument("--strict", action="store_true", help="VLM answers \"no\" become major and affect pass")
    ap.add_argument("--no-vlm", action="store_true")
    ap.add_argument("--vlm-model", default="qwen3-vl:8b")
    ap.add_argument("--blender", default=os.environ.get("HG_BLENDER") or os.environ.get("Imaginarium_BLENDER") or os.environ.get("IMAGINARIUM_BLENDER") or DEFAULT_BLENDER)
    ap.add_argument("--keep-comfy", action="store_true", help="do not free ComfyUI before the VLM")
    ap.add_argument("--frame-from", default=None, help="face_report.json of the previous iteration: take its frames (frame_camera) as they are, without new alignment")
    ap.add_argument("--thresholds", default=None, help="pass thresholds: JSON {ssim_gray, feature_mask_iou_min, landmark_max_px_share, diff_area_share_max, silhouette_iou} or a path to such a .json; unnamed ones keep the defaults")
    a = ap.parse_args()
    try:
        if a.thresholds:
            THRESHOLDS.update(parse_thresholds(a.thresholds))
        return run(a)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        try:
            os.makedirs(a.out, exist_ok=True)
            with open(os.path.join(a.out, "face_report.json"), "w", encoding="utf-8") as fh:
                json.dump({"model": a.model, "error": "%s: %s" % (type(exc).__name__, exc), "pass": False, "score": 0}, fh, ensure_ascii=False, indent=1)
        except Exception:
            pass
        return 2


def run(a):
    t_all = time.time()
    model = os.path.abspath(a.model)
    out_dir = os.path.abspath(a.out)
    os.makedirs(out_dir, exist_ok=True)
    mask_dir = os.path.join(out_dir, "masks")
    if os.path.isdir(mask_dir):
        old = mask_dir + "_old"
        if os.path.isdir(old):
            shutil.rmtree(old)
        os.rename(mask_dir, old)
    os.makedirs(mask_dir, exist_ok=True)
    fixed_cams = {}
    if a.frame_from:
        try:
            with open(a.frame_from, "r", encoding="utf-8") as fh:
                prev = json.load(fh)
            fixed_cams = {k: (v.get("align") or {}).get("frame_camera") for k, v in (prev.get("views") or {}).items()}
            fixed_cams = {k: v for k, v in fixed_cams.items() if v}
        except Exception as exc:
            log("frame_from: not read (%s) - aligning anew" % exc)
    if os.path.isdir(model):
        raws = None
    else:
        raws = render_model(model, out_dir, a.blender, fixed=fixed_cams.get("front") or (next(iter(fixed_cams.values())) if fixed_cams else None))
    views, ctxs, all_defects = {}, {}, []
    for key, ref_name, yaws, weight, view_ru in VIEWS:
        ref_path = os.path.join(a.refs, ref_name)
        if not os.path.isfile(ref_path):
            log("no reference", ref_path, "- view skipped")
            continue
        if raws is None:
            cands = prerendered(model, key, ref_name)
        elif key == "back":
            cands = [raws["back"]]
        elif key == "front":
            cands = [raws["front"]]
        else:  # both signs and all angles: the sign matching the reference is decided by the gray correlation
            cands = [raws["y%+d" % y] for c in YAW34_CANDIDATES for y in (c, -c)]
        if not cands:
            log("no render for", key)
            continue
        t0 = time.time()
        fixed = fixed_cams.get(key)
        if a.frame_from and fixed is None:
            log("frame_from: no frame_camera for %s - aligning anew" % key)
        v, ctx = analyse_view(key, view_ru, load_rgba(ref_path), cands, out_dir, mask_dir, a.strict, fixed_cam=fixed)
        v["weight"] = weight
        views[key], ctxs[key] = v, ctx
        log("%s: yaw %s  align %s  sil %.3f  ssim %.3f  diff %.1f%%  lm_max %.1f px  (%.1f s)" % (
            key, ctx["camera"]["yaw"], v["align"]["method"], v["metrics"]["silhouette_iou"], v["metrics"]["ssim_gray"],
            100 * v["metrics"]["diff_area_share"], v["metrics"]["landmark_max_px"], time.time() - t0))
    if not views:
        raise RuntimeError("not a single view")
    # --- VLM
    vlm_info = {"model": a.vlm_model, "used": False}
    if not a.no_vlm:
        try:
            tags = http_json("GET", VLM_URL + "/api/tags", timeout=10)
            have = any(m.get("name", "").split(":")[0] == a.vlm_model.split(":")[0] for m in tags.get("models", []))
        except Exception as exc:
            have, tags = False, {"error": str(exc)}
            log("Ollama unavailable:", exc)
        if have:
            if not a.keep_comfy:
                vlm_info["gpu_after_free"] = free_comfy()
            vlm_info["used"] = True
            vlm_info["requests"] = []
            for key, v in views.items():
                ctx = ctxs[key]
                pair_path = os.path.join(out_dir, "vlm_pair_%s.jpg" % key)
                size = make_pair(ctx["ref_rgba"], ctx["ren_rgba"], pair_path)
                try:
                    ans, sec, raw = vlm_ask(a.vlm_model, vlm_prompt_yesno(key), pair_path)
                except Exception as exc:
                    ans, sec, raw = None, 0, "error: %s" % exc
                vlm_info["requests"].append({"view": key, "kind": "yesno", "seconds": sec, "raw": raw[:600]})
                keys = BACK_KEYS if key == "back" else YESNO_KEYS
                vm = {}
                for k in keys:
                    val = (ans or {}).get(k)
                    vm[k] = (str(val).strip().lower().startswith("y")) if val is not None else None
                v["metrics"]["vlm"] = vm
                ctx["vlm"] = vm
                # landmark coordinates are asked once (front): if the reference error is >= 5 % of the frame the
                # VLM coordinates are not usable and the other views are not asked (saves ~80 s per request)
                if key != "back" and ctx["lm"] and vlm_info.get("coords_ok", True):
                    try:
                        co, sec, raw = vlm_ask(a.vlm_model, vlm_prompt_coords(size), pair_path)
                    except Exception as exc:
                        co, sec, raw = None, 0, "error: %s" % exc
                    vlm_info["requests"].append({"view": key, "kind": "coords", "seconds": sec, "raw": raw[:600]})
                    val = _vlm_coords(co, ctx["lm"], size)
                    v["metrics"]["vlm_landmarks"] = val
                    vlm_info["coords_ok"] = bool(val.get("valid"))
                    if val.get("valid") and val.get("offsets_px"):
                        # the second source: the mean absolute difference with the geometry, the VLM coordinates go into the report
                        geo = v["metrics"]["landmark_offsets_px"]
                        for k, o in val["offsets_px"].items():
                            if k not in geo:
                                geo[k] = o
                                v["metrics"]["landmark_sources"][k] = "vlm"
                                ctx["offsets"][k] = o
                log("VLM %s: %s" % (key, vm))
        else:
            vlm_info["skipped"] = "model %s not found in Ollama" % a.vlm_model
    # --- defects, scores
    for key, v in views.items():
        is_back = key == "back"
        ds = build_defects(key, ctxs[key])
        v["score"] = view_score(v["metrics"], is_back)
        v["pass"] = view_pass(v["metrics"], is_back, a.strict)
        all_defects.extend(ds)
    order = {"blocker": 0, "major": 1, "minor": 2}
    capped = []
    for key in views:
        ds = sorted([d for d in all_defects if d["view"] == key], key=lambda d: (order[d["severity"]], -d.get("area_share", 0)))
        capped.extend(ds[:MAX_DEFECTS_PER_VIEW])
    all_defects = capped
    all_defects.sort(key=lambda d: (order[d["severity"]], [k for k, *_ in VIEWS].index(d["view"]), -d.get("area_share", 0)))
    for i, d in enumerate(all_defects):
        d["id"] = "d%d" % (i + 1)
    wsum = sum(v["weight"] for v in views.values())
    score = round(sum(v["score"] * v["weight"] for v in views.values()) / wsum, 1)
    blocking = [d for d in all_defects if d["severity"] in ("blocker", "major")]
    passed = all(v["pass"] for v in views.values()) and not blocking
    report = {"model": model, "reference_set": os.path.abspath(a.refs), "iteration": a.iteration, "views": views, "score": score,
              "pass": bool(passed), "thresholds": THRESHOLDS, "defects": all_defects, "sheet": os.path.join(out_dir, "face_report.jpg"),
              "vlm": vlm_info, "seconds": round(time.time() - t_all, 1)}
    build_sheet(report["sheet"], views, ctxs, all_defects, report)
    for v in views.values():
        v.pop("weight", None)
    with open(os.path.join(out_dir, "face_report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    log("score %s  pass %s  defects %d  (%.0f s) -> %s" % (score, passed, len(all_defects), time.time() - t_all, out_dir))
    for d in all_defects:
        log("  [%s] %s" % (d["severity"], d["instruction"]["text_ru"]))
    return 0 if passed else 1


def _vlm_coords(co, lm, size):
    """Validating the VLM coordinates against the reference (error < 5 % of the frame) -> B-A offsets in 800-frame px."""
    out = {"valid": False}
    if not isinstance(co, dict) or not isinstance(co.get("A"), dict) or not isinstance(co.get("B"), dict):
        out["reason"] = "нет JSON A/B"
        return out
    k = FRAME / float(size)
    errs, offs = [], {}
    for key in ("left_eye", "right_eye", "nose", "mouth", "chin"):
        pa, pb = co["A"].get(key), co["B"].get(key)
        if not (isinstance(pa, (list, tuple)) and isinstance(pb, (list, tuple)) and len(pa) == 2 and len(pb) == 2):
            continue
        try:
            ax, ay, bx, by = float(pa[0]) * k, float(pa[1]) * k, float(pb[0]) * k, float(pb[1]) * k
        except (TypeError, ValueError):
            continue
        errs.append(math.hypot(ax - lm[key][0], ay - lm[key][1]))
        offs[key] = [round(bx - ax, 1), round(by - ay, 1)]
    if not errs:
        out["reason"] = "нет координат"
        return out
    out["ref_error_px_mean"] = round(float(np.mean(errs)), 1)
    out["ref_error_share"] = round(float(np.mean(errs)) / FRAME, 4)
    out["offsets_px"] = offs
    out["valid"] = out["ref_error_share"] < 0.05
    return out


if __name__ == "__main__":
    sys.exit(main())
