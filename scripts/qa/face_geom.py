"""face_geom - fitting the head mesh to the reference (the geometry_fit action of the executor face_fix).

Idea: in the front frame (the checker's camera) build a per-row mapping of the model silhouette onto
the reference silhouette:
  * vertically - piecewise-linear over anchor rows (crown, bottom of the headband / top of skin, nose,
    chin, neck);
  * horizontally - in every row piecewise-linear over the nodes [silhouette edge, skin edge, skin
    edge, silhouette edge]: model silhouette edges -> reference silhouette edges, model skin edges
    (per the source classification map) -> reference skin edges. This matches both the head contour
    and the face/jaw width, and the position of strands relative to the cheeks.
  * in depth (along the camera view) - a scale equal to the median face-width ratio, around the neck ring.
The shift is applied to the head vertices (z >= zc) with a smooth decay to the cut; UVs do not change.

All functions are pure numpy/scipy; no cv2 needed.
"""
import math

import numpy as np

try:
    from scipy import ndimage
except Exception:  # pragma: no cover
    ndimage = None

import face_views as fv

ROW_SMOOTH = 5.0   # smoothing of the node rows along the rows, px
DEPTH_SCALE_CLAMP = (0.90, 1.25)


# ------------------------------------------------------------------ colour classification
def srgb_to_lab(rgb):
    c = np.clip(np.asarray(rgb, np.float64) / 255.0, 0, 1)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def classify_lab(lab):
    """0 other, 1 skin, 2 dark (hair/dark details), 3 blue (headband/collar)."""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    chroma = np.hypot(a, b)
    cls = np.zeros(L.shape, np.int8)
    cls[(a > 3) & (b > 6) & (L > 38)] = 1
    cls[(b < -10) & (chroma > 15)] = 3
    cls[(L < 42) & (chroma < 35)] = 2
    return cls


def classify_rgb(rgb):
    return classify_lab(srgb_to_lab(rgb))


# ------------------------------------------------------------------ masks and rows
def fill_face(skin):
    """The face fill from the skin mask: closing 9 px, hole filling, the largest component."""
    if ndimage is None or not skin.any():
        return skin.copy()
    m = ndimage.binary_closing(skin, structure=np.ones((9, 9), bool))
    m = ndimage.binary_fill_holes(m)
    lab, n = ndimage.label(m)
    if n == 0:
        return m
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def head_rows(mask):
    """Silhouette top and neck row (the first width minimum after the maximum) - like the checker's head_measure."""
    rows = np.where(mask.any(1))[0]
    if len(rows) == 0:
        return None
    top, bottom = int(rows[0]), int(rows[-1])
    w = mask.sum(1).astype(np.float64)
    ws = ndimage.uniform_filter1d(w, 9) if ndimage is not None else w
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
    lim = top + int(0.5 * (neck - top)) if neck < bottom else top + int(0.45 * (bottom - top))
    return {"top": top, "neck": int(neck), "bottom": bottom, "head_w": float(ws[top:max(lim, top + 1)].max())}


def row_extents(mask, y0, y1):
    """For rows y0..y1: left/right mask edge (nan when empty)."""
    H, W = mask.shape
    L = np.full(H, np.nan)
    R = np.full(H, np.nan)
    for y in range(max(y0, 0), min(y1 + 1, H)):
        xs = np.nonzero(mask[y])[0]
        if len(xs):
            L[y], R[y] = xs[0], xs[-1] + 1
    return L, R


def run_extents(mask, axis_x, y0, y1):
    """Edges of the continuous mask run containing (or nearest to) column axis_x in each row."""
    H, W = mask.shape
    L = np.full(H, np.nan)
    R = np.full(H, np.nan)
    ax = int(round(axis_x))
    for y in range(max(y0, 0), min(y1 + 1, H)):
        row = mask[y]
        if not row.any():
            continue
        xs = np.nonzero(row)[0]
        # the runs
        breaks = np.nonzero(np.diff(xs) > 1)[0]
        starts = np.concatenate([[xs[0]], xs[breaks + 1]])
        ends = np.concatenate([xs[breaks], [xs[-1]]]) + 1
        d = np.where((starts <= ax) & (ax < ends), 0, np.minimum(np.abs(starts - ax), np.abs(ends - ax)))
        i = int(np.argmin(d))
        L[y], R[y] = starts[i], ends[i]
    return L, R


def smooth_series(v, sigma=ROW_SMOOTH):
    """Linear interpolation of the gaps (nan) and smoothing along the rows; outside the given range -
    the nearest value."""
    v = np.asarray(v, np.float64).copy()
    ok = ~np.isnan(v)
    if ok.sum() == 0:
        return v
    idx = np.arange(len(v))
    v = np.interp(idx, idx[ok], v[ok])
    if ndimage is not None and sigma > 0:
        v = ndimage.gaussian_filter1d(v, sigma, mode="nearest")
    return v


def piecewise(x, knots_src, knots_dst):
    """Piecewise-linear mapping over the nodes (linear extrapolation past the outer nodes)."""
    ks, kd = np.asarray(knots_src, np.float64), np.asarray(knots_dst, np.float64)
    y = np.interp(x, ks, kd)
    if len(ks) >= 2:
        s0 = (kd[1] - kd[0]) / max(ks[1] - ks[0], 1e-6)
        s1 = (kd[-1] - kd[-2]) / max(ks[-1] - ks[-2], 1e-6)
        y = np.where(x < ks[0], kd[0] + (x - ks[0]) * s0, y)
        y = np.where(x > ks[-1], kd[-1] + (x - ks[-1]) * s1, y)
    return y


# ------------------------------------------------------------------ frame rasterization with attributes
def raster_frame(model, view, size=None):
    """Rasterize the whole model in the view frame: TRI, barycentrics, depth, mask, position (m) and UV per pixel."""
    from face_fix import rasterize  # noqa: E402  (the shared rasterizer)
    S = int(size or view.size)
    P = model.positions()
    u, v, z = fv.project(view.cam, P)
    P2 = np.stack([u[model.F], v[model.F]], axis=-1)
    TRI, B0, B1, Z = rasterize(P2, (S, S), depth=z[model.F])
    cov = TRI >= 0
    ys, xs = np.nonzero(cov)
    t = TRI[ys, xs]
    b0, b1 = B0[ys, xs].astype(np.float64), B1[ys, xs].astype(np.float64)
    b2 = 1 - b0 - b1
    Pt = P[model.F[t]]
    pos = Pt[:, 0] * b0[:, None] + Pt[:, 1] * b1[:, None] + Pt[:, 2] * b2[:, None]
    uvt = model.UV[t]
    uv = uvt[:, 0] * b0[:, None] + uvt[:, 1] * b1[:, None] + uvt[:, 2] * b2[:, None]
    return {"S": S, "TRI": TRI, "Z": Z, "mask": cov, "ys": ys, "xs": xs, "t": t, "pos": pos, "uv": uv, "mat": model.MAT[t]}


def pixel_classes(model, raster, class_tex, head_mat):
    """Class of each covered frame pixel via the classification map (the Head texture: the source paint)."""
    S = class_tex.shape[0]
    cls_tex = classify_rgb(class_tex)
    out = np.zeros(raster["mask"].shape, np.int8)
    sel = raster["mat"] == head_mat
    uv = raster["uv"][sel]
    tx = np.clip((uv[:, 0] * S).astype(np.int64), 0, S - 1)
    ty = np.clip(((1 - uv[:, 1]) * S).astype(np.int64), 0, S - 1)
    out[raster["ys"][sel], raster["xs"][sel]] = cls_tex[ty, tx]
    return out


# ------------------------------------------------------------------ the main fit
def fit_head(model, view, class_tex, ref_rows=None, log=print, debug_png=None, max_share=0.18):
    """Fit the model head to the reference of the `view` view (front). class_tex - the Head RGB map for the
    skin/hair classification (the source paint), ref_rows - the reference anchor rows from the checker
    {"top","face_top","nose","chin","neck","axis","iod"} (in the 800 frame); what is missing is measured here.
    -> dict of measurements; the shift is written into model.disp."""
    S = view.size
    ref = view.ref_in_frame()
    if ref is None:
        raise RuntimeError("geometry_fit: no reference for view %s" % view.name)
    ra = ref[..., 3] > 127
    rrgb = np.where(ra[..., None], ref[..., :3], 128.0)
    rcls = classify_lab(srgb_to_lab(rrgb))
    rcls[~ra] = 0
    rhm = head_rows(ra)
    if rhm is None:
        raise RuntimeError("geometry_fit: empty reference")
    r_face = fill_face((rcls == 1) & ra)
    fy, fx = np.nonzero(r_face)
    if len(fx) < 500:
        raise RuntimeError("geometry_fit: no face skin found on the reference")
    axis_r = float(fx.mean()) if not (ref_rows and ref_rows.get("axis")) else float(ref_rows["axis"])
    # the reference anchor rows (the neck only when the silhouette really narrows: with shoulders down to
    # the frame bottom there is none)
    rr = dict(top=float(rhm["top"]), neck=float(rhm["neck"]) if rhm["neck"] < rhm["bottom"] - 2 else None)
    col = r_face[:, int(axis_r) - 3:int(axis_r) + 4].any(1)
    rr["face_top"] = float(np.nonzero(col)[0].min()) if col.any() else rr["top"] + 0.35 * (fy.max() - rr["top"])
    rr["chin"] = float(fy.max())
    if ref_rows:
        for k in ("face_top", "nose", "chin", "neck", "top"):
            if ref_rows.get(k) is not None:
                rr[k] = float(ref_rows[k])
    if rr.get("nose") is None:
        rr["nose"] = rr["face_top"] + 0.62 * (rr["chin"] - rr["face_top"])
    r_last = rr["neck"] if rr.get("neck") else rr["chin"] + 0.25 * (rr["chin"] - rr["face_top"])
    # ---- the model
    rast = raster_frame(model, view)
    mmask = rast["mask"]
    mhm = head_rows(mmask)
    cls = pixel_classes(model, rast, class_tex, model.head_mat)
    zmap = np.full((S, S), np.nan)
    zmap[rast["ys"], rast["xs"]] = rast["pos"][:, 2]
    head_px = mmask & (np.nan_to_num(zmap, nan=-1) >= model.zc - 0.002)
    m_face = fill_face((cls == 1) & head_px)
    my, mx = np.nonzero(m_face)
    axis_m = float(mx.mean()) if len(mx) > 500 else float(np.nonzero(mmask[mhm["top"]:mhm["neck"]].any(0))[0].mean())
    mr = dict(top=float(mhm["top"]), neck=float(mhm["neck"]) if mhm["neck"] < mhm["bottom"] - 2 else None)
    colm = m_face[:, int(axis_m) - 3:int(axis_m) + 4].any(1)
    m_chin_skin = float(my.max()) if len(my) else mr["top"] + 0.8 * (rr["chin"] - rr["top"])
    mr["face_top"] = float(np.nonzero(colm)[0].min()) if colm.any() else mr["top"] + 0.35 * (m_chin_skin - mr["top"])
    # the model's nose and chin - from the depth profile along the axis (the nose - the point nearest the
    # camera, the chin - the maximal surface recession under it); the lower search bound is the bottom of
    # the model's face skin
    depth = rast["Z"].copy()
    depth[~mmask] = np.nan
    fh = m_chin_skin - mr["face_top"]
    c0, c1 = int(axis_m - 0.08 * fh), int(axis_m + 0.08 * fh)
    prof = np.nanmean(depth[:, max(c0, 0):max(c1, c0 + 1)], axis=1)
    prof_s = smooth_series(prof, 2.0)
    yA, yB = int(mr["face_top"] + 0.4 * fh), int(mr["face_top"] + 0.8 * fh)
    nose_m = float(yA + int(np.nanargmin(prof_s[yA:yB]))) if yB > yA + 2 else None
    chin_m = None
    if nose_m is not None:
        yA2, yB2 = int(nose_m + 0.3 * (m_chin_skin - nose_m)), int(min(m_chin_skin + 0.12 * fh, S - 2))
        if yB2 > yA2 + 3:
            g = np.gradient(prof_s)
            chin_m = float(yA2 + int(np.nanargmax(g[yA2:yB2])))
    mr["chin"] = chin_m if chin_m is not None else m_chin_skin
    m_last = mr["neck"] if mr.get("neck") else mr["chin"] + 0.25 * (mr["chin"] - mr["face_top"])
    # ---- vertical nodes
    ksrc, kdst, names = [mr["top"], mr["face_top"]], [rr["top"], rr["face_top"]], ["top", "face_top"]
    if nose_m is not None and rr.get("nose") is not None:
        ksrc.append(nose_m); kdst.append(rr["nose"]); names.append("nose")
    ksrc.append(mr["chin"]); kdst.append(rr["chin"]); names.append("chin")
    if mr.get("neck") and rr.get("neck"):
        ksrc.append(mr["neck"]); kdst.append(rr["neck"]); names.append("neck")
    # monotonicity: drop nodes that break the order
    keep = [0]
    for i in range(1, len(ksrc)):
        if ksrc[i] > ksrc[keep[-1]] + 4 and kdst[i] > kdst[keep[-1]] + 4:
            keep.append(i)
    ksrc, kdst, names = [ksrc[i] for i in keep], [kdst[i] for i in keep], [names[i] for i in keep]
    # below the last node - a pure shift (a tail node with slope 1) so the neck does not stretch
    ksrc.append(ksrc[-1] + 300.0); kdst.append(kdst[-1] + 300.0); names.append("tail")
    # ---- per-row horizontal nodes (model: head silhouette + skin; reference: silhouette + skin in the template row)
    y0, y1 = int(mr["top"]), int(min(m_last, S - 1))
    mL, mR = row_extents(head_px, y0, y1)
    sL, sR = run_extents(m_face, axis_m, y0, y1)
    rows = np.arange(S)
    vmap = piecewise(rows.astype(np.float64), ksrc, kdst)
    rL_all, rR_all = row_extents(ra, int(rr["top"]), int(min(r_last, S - 1)))
    fL_all, fR_all = run_extents(r_face, axis_r, int(rr["top"]), int(min(r_last, S - 1)))
    rL, rR, fL, fR = (np.full(S, np.nan) for _ in range(4))
    for y in range(y0, y1 + 1):
        yr = int(round(vmap[y]))
        if 0 <= yr < S:
            rL[y], rR[y], fL[y], fR[y] = rL_all[yr], rR_all[yr], fL_all[yr], fR_all[yr]
    # where one side has no skin - do not use the skin nodes
    skin_ok = ~np.isnan(sL) & ~np.isnan(fL) & ((sR - sL) > 8) & ((fR - fL) > 8)
    sL[~skin_ok] = np.nan; sR[~skin_ok] = np.nan; fL[~skin_ok] = np.nan; fR[~skin_ok] = np.nan
    series = {k: smooth_series(v) for k, v in dict(mL=mL, mR=mR, rL=rL, rR=rR).items()}
    use_skin = skin_ok.sum() > 0.3 * max(y1 - y0, 1)
    if use_skin:
        series.update({k: smooth_series(v) for k, v in dict(sL=sL, sR=sR, fL=fL, fR=fR).items()})
    face_rows = skin_ok.nonzero()[0]
    if use_skin:
        depth_scale = float(np.median((series["fR"] - series["fL"])[face_rows] / np.maximum((series["sR"] - series["sL"])[face_rows], 1)))
    else:
        mid = np.arange(int(mr["face_top"]), y1)
        depth_scale = float(np.median((series["rR"] - series["rL"])[mid] / np.maximum((series["mR"] - series["mL"])[mid], 1)))
    depth_scale = float(np.clip(depth_scale, *DEPTH_SCALE_CLAMP))

    def hmap(u, y):
        """The horizontal map of a point (u, y) of the model frame -> u' in the reference frame."""
        yi = int(np.clip(round(y), y0, y1))
        ks = [series["mL"][yi], series["mR"][yi]]
        kd = [series["rL"][yi], series["rR"][yi]]
        if use_skin and skin_ok[yi]:
            a, b = series["sL"][yi], series["sR"][yi]
            c, d = series["fL"][yi], series["fR"][yi]
            if ks[0] + 2 < a < b < ks[1] - 2 and kd[0] + 2 < c < d < kd[1] - 2:
                ks, kd = [ks[0], a, b, ks[1]], [kd[0], c, d, kd[1]]
        return float(piecewise(np.array([u]), ks, kd)[0])

    # ---- the vertex shift
    P = model.positions()
    u, v, _ = fv.project(view.cam, P)
    zc = model.zc
    wz = np.clip((P[:, 2] - (zc - 0.015)) / 0.05, 0, 1)
    wz = wz * wz * (3 - 2 * wz)
    sel = np.nonzero(wz > 0)[0]
    du = np.zeros(len(P))
    dv = np.zeros(len(P))
    for i in sel:
        uu, vv = float(u[i]), float(v[i])
        vv2 = float(piecewise(np.array([vv]), ksrc, kdst)[0])
        uu2 = hmap(uu, vv)
        du[i], dv[i] = uu2 - uu, vv2 - vv
    r, up, d = fv.basis(view.cam["yaw"], view.cam["pitch"])
    disp = np.zeros_like(P)
    for i in sel:
        disp[i] = fv.frame_shift_to_world(view.cam, du[i], dv[i])
    ring = np.abs(P[:, 2] - zc) < 0.012
    pivot = P[ring].mean(0) if ring.any() else P[sel].mean(0)
    along = (P - pivot) @ d
    disp += (along * (depth_scale - 1.0))[:, None] * d[None, :]
    disp *= wz[:, None]
    mag = np.linalg.norm(disp, axis=1)
    limit = max_share * model.head_h
    scale = 1.0
    if mag.max() > limit:
        scale = limit / mag.max()
        disp *= scale
    model.disp += disp
    # ---- the report
    ppm = fv.frame_px_per_m(view.cam)
    out = {"vertices": int((mag > 1e-6).sum()), "max_mm": round(1000 * float(mag.max()) * scale, 1), "mean_mm": round(1000 * float(mag[sel].mean()) * scale, 1),
           "depth_scale": round(depth_scale, 4), "knots": [{"name": n, "model_row": round(a, 1), "ref_row": round(b, 1)} for n, a, b in zip(names, ksrc, kdst) if n != "tail"],
           "rows_model": {k: (round(v, 1) if v is not None else None) for k, v in dict(mr, nose=nose_m).items()},
           "rows_ref": {k: (round(v, 1) if v is not None else None) for k, v in rr.items()}, "skin_rows_used": int(skin_ok.sum()), "limited": scale < 1,
           "width_scale_median": round(float(np.median(((series["rR"] - series["rL"]) / np.maximum(series["mR"] - series["mL"], 1))[int(mr["face_top"]):y1])), 4)}
    log("geometry_fit: vertical knots %s; width scale (median) x%.3f, depth x%.3f; skin rows %d/%d; vertices %d, mean shift %.1f mm, max %.1f mm%s" % (
        ["%s %.0f->%.0f" % (n, a, b) for n, a, b in zip(names, ksrc, kdst) if n != "tail"], out["width_scale_median"], depth_scale, int(skin_ok.sum()), y1 - y0 + 1,
        out["vertices"], out["mean_mm"], out["max_mm"], " (clamped x%.2f)" % scale if scale < 1 else ""))
    # silhouette IoU afterwards
    rast2 = raster_frame(model, view)
    m2 = rast2["mask"]
    rows_head = np.zeros((S, S), bool)
    rows_head[:int(min(r_last, S - 1)) + 1] = True
    inter = float((ra & m2 & rows_head).sum())
    union = float(((ra | m2) & rows_head).sum())
    inter0 = float((ra & mmask & rows_head).sum())
    union0 = float(((ra | mmask) & rows_head).sum())
    out["silhouette_iou_before"] = round(inter0 / max(union0, 1), 4)
    out["silhouette_iou_after"] = round(inter / max(union, 1), 4)
    log("geometry_fit: head silhouette IoU (up to the neck) %.3f -> %.3f" % (out["silhouette_iou_before"], out["silhouette_iou_after"]))
    if debug_png:
        try:
            from PIL import Image, ImageDraw
            im = np.full((S, S, 3), 40, np.uint8)
            im[ra] = (150, 40, 40)
            im[mmask & rows_head] = np.where(ra[mmask & rows_head][:, None], (150, 40, 140), (40, 40, 160))
            im[m2 & rows_head] = np.where(ra[m2 & rows_head][:, None], (230, 230, 230), (40, 180, 40))
            pil = Image.fromarray(im)
            dr = ImageDraw.Draw(pil)
            for n, a, b in zip(names, ksrc, kdst):
                if n == "tail":
                    continue
                dr.line([(0, a), (S // 2, a)], fill=(80, 80, 255), width=1)
                dr.line([(S // 2, b), (S, b)], fill=(255, 80, 80), width=1)
                dr.text((4, a - 12), "%s m%.0f" % (n, a), fill=(200, 200, 255))
                dr.text((S // 2 + 4, b - 12), "%s r%.0f" % (n, b), fill=(255, 200, 200))
            for y in range(y0, y1, 12):
                if use_skin and skin_ok[y]:
                    dr.line([(series["sL"][y], y), (series["sR"][y], y)], fill=(255, 220, 0), width=1)
                    dr.line([(series["fL"][y], vmap[y]), (series["fR"][y], vmap[y])], fill=(0, 220, 255), width=1)
            dr.text((4, S - 40), "red=ref  blue=model before  green=model after  white=after&ref  yellow=model skin  cyan=ref skin", fill=(240, 240, 240))
            dr.text((4, S - 22), "IoU %.3f -> %.3f  width x%.3f depth x%.3f" % (out["silhouette_iou_before"], out["silhouette_iou_after"], out["width_scale_median"], depth_scale), fill=(240, 240, 240))
            pil.save(debug_png)
        except Exception as exc:  # pragma: no cover
            log("geometry_fit: the debug image was not written: %s" % exc)
    return out
