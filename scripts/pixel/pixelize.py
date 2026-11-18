"""pixelize - deterministic conversion of a picture or a render frame into pixel art.

One module serves two uses (docs/forge/pixel.md):
  * the `pixel` profile of the Blender step `render_sprites` (scripts/blender/steps/render_sprites.py) calls
    these functions per sheet frame; the shared palette for the whole asset comes from `auto_palette`;
  * the command line and `scripts/pixel/pixel_gen.mjs`: any picture -> pixel art.

The only dependency is numpy. PNGs are read and written through Pillow when it exists and through bpy inside
Blender (which has no Pillow). The result depends only on the input pixels and the parameters: no random
anywhere, the palette order is fixed.

Stages (each one a separate function; a sprite sheet calls them in a row over a shared palette):
  1. `resize_area` / `reduce_block` / `reduce_dominant` - downscale: area average (premultiplied alpha),
     nearest, or the most frequent colour of each block;
  2. `binarize_alpha` - alpha only 0 or 255 by a threshold (no half-transparent edges);
  3. `auto_palette` (median cut weighted by pixel counts, box colour = weighted mean) | `load_palette`
     (.gpl, .hex, .png);
  4. `quantize` - every colour replaced by the nearest palette entry; `dither`: ordered Bayer 4x4;
  5. `add_outline` - a 1-pixel outline outside the body (4-neighbours only), colour from the palette.

CLI:
    python3 -I pixelize.py in.png out.png --size 64 --colors 32 --outline auto [--dither] [--palette file.gpl]
"""
import argparse
import json
import math
import os
import sys

import numpy as np

BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], dtype=np.float32)
# channel weights for colour comparison (the eye is most sensitive to green)
DIST_W = np.array([2, 4, 3], dtype=np.int64)
OUTLINES = ("none", "dark", "auto")


# --------------------------------------------------------------------------- PNG

def read_png(path):
    """PNG -> uint8 (H, W, 4), rows top-down. Pillow; without it (inside Blender) - bpy."""
    path = os.path.abspath(path)
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Image is not None:
        with Image.open(path) as im:
            return np.array(im.convert("RGBA"), dtype=np.uint8)
    import bpy
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        buf = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
    finally:
        bpy.data.images.remove(img)
    return np.rint(buf.reshape(h, w, 4) * 255.0).astype(np.uint8)[::-1].copy()


def write_png(path, arr):
    """uint8 (H, W, 4) top-down -> PNG (straight alpha)."""
    arr = np.ascontiguousarray(arr, dtype=np.uint8)
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Image is not None:
        Image.fromarray(arr, "RGBA").save(path, optimize=True)
        return path
    import bpy
    h, w = arr.shape[:2]
    img = bpy.data.images.new("imaginarium_pixelize_out", width=w, height=h, alpha=True)
    try:
        img.pixels.foreach_set((arr[::-1].astype(np.float32) / 255.0).ravel())
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)
    return path


# --------------------------------------------------------------------------- colour

def luminance(rgb):
    """Luminance 0..255 (Rec. 601) of (..., 3)."""
    rgb = np.asarray(rgb, dtype=np.float64)
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def pack_rgb(rgb):
    rgb = np.asarray(rgb)
    return (rgb[..., 0].astype(np.int64) << 16) | (rgb[..., 1].astype(np.int64) << 8) | rgb[..., 2].astype(np.int64)


def unpack_rgb(packed):
    packed = np.asarray(packed, dtype=np.int64)
    return np.stack([(packed >> 16) & 255, (packed >> 8) & 255, packed & 255], axis=-1).astype(np.uint8)


def hex_of(rgb):
    return "#%02x%02x%02x" % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def _dist(a, b):
    """Weighted squared distance: a (n, 3) and b (m, 3) -> (n, m) int64."""
    d = a[:, None, :].astype(np.int64) - b[None, :, :].astype(np.int64)
    return (d * d * DIST_W).sum(axis=2)


def nearest_index(rgb, palette, noise=None):
    """Index of the nearest palette colour for each pixel of rgb (..., 3).

    noise - an additive per-pixel offset (one value per pixel) for dithering; without it only unique
    colours are compared, which makes the common case cheap."""
    shape = rgb.shape[:-1]
    flat = rgb.reshape(-1, 3)
    pal = np.asarray(palette, dtype=np.int64)
    if noise is None:
        packed = pack_rgb(flat)
        uniq, inv = np.unique(packed, return_inverse=True)
        idx_u = np.argmin(_dist(unpack_rgb(uniq), pal), axis=1)
        return idx_u[inv.reshape(-1)].reshape(shape)
    flat = np.clip(flat.astype(np.float32) + noise.reshape(-1, 1), 0, 255).astype(np.int64)
    out = np.empty(len(flat), dtype=np.int64)
    for s in range(0, len(flat), 32768):
        out[s:s + 32768] = np.argmin(_dist(flat[s:s + 32768], pal), axis=1)
    return out.reshape(shape)


# --------------------------------------------------------------------------- palette

def median_cut(colors, counts, n):
    """A palette of n colours by median cut (colors (M, 3) unique, counts (M,) - how many pixels each).

    A colour weighs by the square root of its pixel count: otherwise a big sky or background would take the
    whole palette and a small detail (a red roof, an eye) would merge into its neighbours. The box with the
    largest weighted squared deviation splits, along its widest channel, at the weighted median. The colour
    of a box is its weighted mean. The result is ordered by luminance."""
    colors = np.asarray(colors, dtype=np.int64)
    counts = np.rint(np.sqrt(np.asarray(counts, dtype=np.float64)) * 4.0).astype(np.int64) + 1
    if len(colors) == 0:
        return np.zeros((0, 3), np.uint8)
    n = max(1, int(n))
    boxes = [np.arange(len(colors))]
    w = DIST_W.astype(np.float64)

    def sse(idx):
        c = colors[idx].astype(np.float64)
        m = (c * counts[idx, None]).sum(0) / counts[idx].sum()
        return float((((c - m) ** 2) * w * counts[idx, None]).sum())

    errs = [sse(boxes[0])]
    while len(boxes) < n:
        cand = [(errs[i], -i) for i, b in enumerate(boxes) if len(b) > 1 and errs[i] > 0]
        if not cand:
            break
        bi = -max(cand)[1]
        idx = boxes.pop(bi)
        errs.pop(bi)
        c = colors[idx]
        ch = int(np.argmax((c.max(0) - c.min(0)) * w))
        order = idx[np.argsort(c[:, ch], kind="stable")]
        cum = np.cumsum(counts[order])
        cut = int(np.searchsorted(cum, cum[-1] / 2.0)) + 1
        cut = min(max(cut, 1), len(order) - 1)
        for part in (order[:cut], order[cut:]):
            boxes.append(part)
            errs.append(sse(part))
    pal = np.array([np.rint((colors[b] * counts[b, None]).sum(0) / counts[b].sum()) for b in boxes],
                   dtype=np.int64)
    pal = np.unique(pal, axis=0)
    return pal[np.argsort(luminance(pal), kind="stable")].astype(np.uint8)


def opaque_colors(images, alpha_min=1):
    """Unique colours and their counts over a list of RGBA frames (opaque pixels only)."""
    packed = [pack_rgb(im[..., :3][im[..., 3] >= alpha_min]) for im in images]
    packed = np.concatenate(packed) if packed else np.zeros(0, np.int64)
    uniq, cnt = np.unique(packed, return_counts=True)
    return unpack_rgb(uniq), cnt


def auto_palette(images, colors=32, outline="none"):
    """A shared palette over frames. With an outline one colour stays reserved for a dark border when the
    body has none dark enough."""
    if outline not in OUTLINES:
        raise ValueError("outline must be none, dark or auto: %r" % (outline,))
    uniq, cnt = opaque_colors(images)
    n = max(2, int(colors))
    reserve = outline != "none" and n >= 3
    pal = median_cut(uniq, cnt, n - 1 if reserve else n)
    if reserve and len(pal):
        dark = pal[int(np.argmin(luminance(pal)))]
        if luminance(dark) > 45.0:
            extra = np.clip(np.rint(dark.astype(np.float64) * 0.45), 0, 255).astype(np.uint8)
            pal = np.concatenate([pal, extra[None]])
            pal = pal[np.argsort(luminance(pal), kind="stable")]
    return pal


def tone(images, saturation=1.0, levels=False, lo_pct=2.0, hi_pct=98.0, lo_to=14.0, hi_to=240.0):
    """Tone correction before quantization, identical for every frame of an asset (otherwise the colour
    would jump between frames).

    levels - stretch luminance: the lo_pct and hi_pct percentiles of the opaque pixels' luminance over all
    frames map to lo_to and hi_to (one shift and scale for all channels, hue preserved); saturation -
    saturation around the luminance. Without this, dark dull models give a muddy grey-brown palette."""
    if saturation == 1.0 and not levels:
        return images
    lum = [luminance(im[..., :3][im[..., 3] > 0]) for im in images]
    lum = np.concatenate(lum) if lum else np.zeros(0)
    lo, scale = 0.0, 1.0
    if levels and len(lum) > 16:
        lo = float(np.percentile(lum, lo_pct))
        hi = float(np.percentile(lum, hi_pct))
        if hi - lo > 8.0:
            scale = (hi_to - lo_to) / (hi - lo)
    out = []
    for im in images:
        on = im[..., 3] > 0
        rgb = im[..., :3].astype(np.float64)
        if saturation != 1.0:
            lm = luminance(rgb)[..., None]
            rgb = lm + (rgb - lm) * float(saturation)
        if levels:
            rgb = (rgb - lo) * scale + lo_to
        res = im.copy()
        res[..., :3] = np.where(on[..., None], np.clip(np.rint(rgb), 0, 255), 0).astype(np.uint8)
        out.append(res)
    return out


def parse_gpl(text):
    """GIMP .gpl -> (N, 3) uint8. Lines 'R G B name'; the header, 'Name:', 'Columns:' and '#' are skipped."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.lower().startswith(("gimp palette", "name:", "columns:")):
            continue
        parts = line.split()
        if len(parts) >= 3 and all(p.lstrip("-").isdigit() for p in parts[:3]):
            out.append([min(255, max(0, int(p))) for p in parts[:3]])
    if not out:
        raise ValueError("the .gpl file has no colours")
    return np.array(out, dtype=np.uint8)


def parse_hex(text):
    """Lospec .hex: one RRGGBB per line."""
    out = []
    for raw in text.splitlines():
        s = raw.strip().lstrip("#")
        if len(s) == 6:
            try:
                out.append([int(s[i:i + 2], 16) for i in (0, 2, 4)])
            except ValueError:
                continue
    if not out:
        raise ValueError("the .hex file has no colours")
    return np.array(out, dtype=np.uint8)


def load_palette(path, max_colors=256):
    """A palette from a .gpl, .hex or .png file (unique opaque colours in row order)."""
    ext = os.path.splitext(path)[1].lower()
    if not os.path.isfile(path):
        raise FileNotFoundError("palette file not found: %s" % path)
    if ext in (".gpl", ".hex"):
        with open(path, encoding="utf-8-sig") as fh:
            text = fh.read()
        pal = parse_gpl(text) if ext == ".gpl" else parse_hex(text)
    elif ext == ".png":
        img = read_png(path)
        flat = pack_rgb(img[..., :3][img[..., 3] >= 128])
        _, first = np.unique(flat, return_index=True)
        pal = unpack_rgb(flat[np.sort(first)])
        if not len(pal):
            raise ValueError("the palette image has no opaque pixels")
    else:
        raise ValueError("palette: .gpl, .hex or .png, got %r" % ext)
    pal = pal[:max_colors]
    _, first = np.unique(pack_rgb(pal), return_index=True)
    return pal[np.sort(first)]


def palette_strip(palette):
    """A strip of colours: 1 pixel per colour (how Lospec and Pixelorama read palettes)."""
    pal = np.asarray(palette, np.uint8)
    return np.concatenate([pal[None], np.full((1, len(pal), 1), 255, np.uint8)], axis=2)


def palette_gpl(palette, name="Imaginarium"):
    lines = ["GIMP Palette", "Name: %s" % name, "Columns: 8", "#"]
    lines += ["%3d %3d %3d\t%s" % (r, g, b, hex_of((r, g, b))) for r, g, b in np.asarray(palette)]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- geometry and alpha

def _area_weights(n_old, n_new):
    w = np.zeros((n_new, n_old), dtype=np.float64)
    scale = n_old / float(n_new)
    for i in range(n_new):
        a, b = i * scale, (i + 1) * scale
        for j in range(int(math.floor(a)), min(int(math.ceil(b)), n_old)):
            w[i, j] = max(0.0, min(b, j + 1) - max(a, j))
    return w / w.sum(axis=1, keepdims=True)


def resize_area(img, width, height):
    """Area-average downscale with premultiplied alpha. img uint8 (H, W, 4) -> (height, width, 4)."""
    h, w = img.shape[:2]
    width, height = max(1, int(width)), max(1, int(height))
    if (w, h) == (width, height):
        return img.copy()
    if width > w or height > h:
        raise ValueError("pixelize can only shrink: %dx%d -> %dx%d" % (w, h, width, height))
    f = img.astype(np.float64)
    a = f[..., 3:4] / 255.0
    pm = np.concatenate([f[..., :3] * a, f[..., 3:4]], axis=2)
    pm = np.einsum("ij,jkc->ikc", _area_weights(h, height), pm)
    pm = np.einsum("ij,kjc->kic", _area_weights(w, width), pm)
    alpha = pm[..., 3:4]
    rgb = np.where(alpha > 0, pm[..., :3] / np.maximum(alpha / 255.0, 1e-9), 0.0)
    return np.clip(np.rint(np.concatenate([rgb, alpha], axis=2)), 0, 255).astype(np.uint8)


def reduce_block(img, k, mode="box"):
    """Integer downscale by k: 'box' (block average) or 'nearest' (the centre pixel of the block)."""
    k = int(k)
    if mode not in ("box", "nearest"):
        raise ValueError("mode: box or nearest, got %r" % (mode,))
    if k <= 1:
        return img
    h, w = img.shape[:2]
    if h % k or w % k:
        raise ValueError("%dx%d is not divisible by %d" % (w, h, k))
    if mode == "nearest":
        return img[k // 2::k, k // 2::k].copy()
    return resize_area(img, w // k, h // k)


def reduce_dominant(img, width, height, bits=4):
    """Downscale to width x height taking each block's most frequent colour (colours are counted on a grid
    of 2^bits levels per channel; the result is the mean of that basket's pixels). It never mixes colours at
    edges, so an already pixel-drawn picture (the pixel-art-xl LoRA output) keeps clean colours instead of
    averaged mud. The block's alpha is the average."""
    h, w = img.shape[:2]
    width, height = max(1, int(width)), max(1, int(height))
    if width > w or height > h:
        raise ValueError("pixelize can only shrink: %dx%d -> %dx%d" % (w, h, width, height))
    ys = np.rint(np.linspace(0, h, height + 1)).astype(int)
    xs = np.rint(np.linspace(0, w, width + 1)).astype(int)
    shift = 8 - bits
    key = (((img[..., 0].astype(np.int64) >> shift) << (2 * bits))
           | ((img[..., 1].astype(np.int64) >> shift) << bits)
           | (img[..., 2].astype(np.int64) >> shift))
    out = np.zeros((height, width, 4), np.uint8)
    for j in range(height):
        for i in range(width):
            blk = img[ys[j]:ys[j + 1], xs[i]:xs[i + 1]].reshape(-1, 4)
            kb = key[ys[j]:ys[j + 1], xs[i]:xs[i + 1]].reshape(-1)
            on = blk[:, 3] >= 128
            if not on.any():
                continue
            vals, cnt = np.unique(kb[on], return_counts=True)
            top = vals[int(np.argmax(cnt))]
            sel = blk[on][kb[on] == top]
            out[j, i, :3] = np.rint(sel[:, :3].mean(axis=0))
            out[j, i, 3] = int(np.rint(blk[:, 3].mean()))
    return out


def binarize_alpha(img, threshold=128):
    """Alpha only 0 or 255: a pixel with alpha >= threshold becomes opaque, the rest empty (colour 0)."""
    out = img.copy()
    on = out[..., 3] >= int(threshold)
    out[~on] = 0
    out[on, 3] = 255
    return out


def remove_background(img, tolerance=24):
    """Corner colour -> transparency. A flood fill from the border: only background connected to the edge
    is removed; a background pixel is within tolerance per channel from the median of the corners. A shadow
    under the item is darker than the background and stays (raise the tolerance or remove it by hand)."""
    h, w = img.shape[:2]
    rgb = img[..., :3].astype(np.int32)
    corners = np.array([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]])
    bg = np.median(corners, axis=0)
    near = (np.abs(rgb - bg) <= int(tolerance)).all(axis=2)
    seed = np.zeros((h, w), bool)
    seed[0, :] = seed[-1, :] = seed[:, 0] = seed[:, -1] = True
    reach = near & seed
    while True:
        p = np.pad(reach, 1)
        grown = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | reach) & near
        if np.array_equal(grown, reach):
            break
        reach = grown
    out = img.copy()
    out[reach] = 0
    return out


# --------------------------------------------------------------------------- quantization and outline

def quantize(img, palette, dither=False, strength=0.5):
    """Every opaque pixel's colour -> the nearest palette colour. dither: ordered Bayer 4x4 by frame coordinates."""
    pal = np.asarray(palette, np.uint8)
    out = np.zeros_like(img)
    on = img[..., 3] > 0
    if not on.any():
        return out
    noise = None
    if dither:
        h, w = img.shape[:2]
        thr = (BAYER4[np.arange(h)[:, None] % 4, np.arange(w)[None, :] % 4] + 0.5) / 16.0 - 0.5
        amp = float(strength) * 255.0 / max(len(pal), 2) ** (1.0 / 3.0)
        noise = (thr * amp)[on]
    idx = nearest_index(img[..., :3][on], pal, noise=noise)
    out[on, :3] = pal[idx]
    out[on, 3] = 255
    return out


def add_outline(img, palette, mode="dark"):
    """A 1-pixel outline outside the body (4-neighbours) in a palette colour.

    'dark' - the darkest palette colour; 'auto' - the neighbouring body colour darkened to the nearest
    palette colour that is darker (the outline picks up the edge colour). 'none' - unchanged."""
    if mode == "none":
        return img
    if mode not in OUTLINES:
        raise ValueError("outline must be none, dark or auto: %r" % (mode,))
    pal = np.asarray(palette, np.uint8)
    body = img[..., 3] > 0
    p = np.pad(body, 1)
    edge = ~body & (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:])
    if not edge.any():
        return img
    out = img.copy()
    pal_l = luminance(pal)
    if mode == "dark":
        out[edge, :3] = pal[int(np.argmin(pal_l))]
    else:
        yy, xx = np.nonzero(edge)
        pr = np.pad(img[..., :3].astype(np.float64), ((1, 1), (1, 1), (0, 0)))
        pb = np.pad(body, 1).astype(np.float64)
        acc = np.zeros((len(yy), 3))
        cnt = np.zeros(len(yy))
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            m = pb[yy + 1 + dy, xx + 1 + dx]
            acc += pr[yy + 1 + dy, xx + 1 + dx] * m[:, None]
            cnt += m
        base = acc / cnt[:, None]
        d = _dist(np.rint(base * 0.45), pal).astype(np.float64)
        d[pal_l[None, :] > (luminance(base)[:, None] - 8.0)] = np.inf
        pick = np.argmin(d, axis=1)
        pick[~np.isfinite(d.min(axis=1))] = int(np.argmin(pal_l))
        out[yy, xx, :3] = pal[pick]
    out[edge, 3] = 255
    return out


def palette_violations(img, palette):
    """(pixels whose colour is not in the palette, pixels with alpha neither 0 nor 255) among visible ones."""
    pal = set(pack_rgb(np.asarray(palette, np.uint8)).tolist())
    on = img[..., 3] > 0
    packed = pack_rgb(img[..., :3][on])
    bad_color = sum(1 for v in np.unique(packed).tolist() if v not in pal) if len(packed) else 0
    bad_alpha = int(((img[..., 3] > 0) & (img[..., 3] < 255)).sum())
    return int(bad_color), bad_alpha


# --------------------------------------------------------------------------- the whole chain for one picture

def pixelize(img, size=None, factor=None, palette="auto", colors=32, dither=False, outline="none",
             alpha_threshold=128, mode="box", remove_bg=False, bg_tolerance=24, dither_strength=0.5,
             saturation=1.0, levels=False):
    """A picture uint8 (H, W, 4) -> (pixel art uint8, palette (N, 3)).

    size - the long side of the result in pixels; factor - an integer reduction (used when size is absent);
    mode: 'box' - area average (default), 'dominant' - the most frequent colour of a block (for pictures
    already drawn in pixels), 'nearest' - the centre pixel (on an integer ratio, otherwise averaged);
    palette - 'auto' | 'none' | a path to .gpl/.hex/.png | an array of colours."""
    h, w = img.shape[:2]
    if size:
        s = float(size) / max(h, w)
        tw, th = max(1, int(round(w * s))), max(1, int(round(h * s)))
        k = max(1, int(round(1.0 / s))) if s < 1.0 else 1
        if mode == "dominant" and s < 1.0:
            out = reduce_dominant(img, tw, th)
        elif mode == "nearest" and k > 1 and h % k == 0 and w % k == 0 and (w // k, h // k) == (tw, th):
            out = reduce_block(img, k, "nearest")
        else:
            out = resize_area(img, tw, th) if s < 1.0 else img.copy()
    elif factor and int(factor) > 1:
        out = reduce_dominant(img, w // int(factor), h // int(factor)) if mode == "dominant" else reduce_block(img, factor, mode)
    else:
        out = img.copy()
    if remove_bg:
        out = remove_background(out, bg_tolerance)
    out = binarize_alpha(out, alpha_threshold)
    out = tone([out], saturation, levels)[0]
    if isinstance(palette, str) and palette.lower() == "none":
        return out, np.zeros((0, 3), np.uint8)
    if isinstance(palette, str) and palette.lower() == "auto":
        pal = auto_palette([out], colors, outline)
    elif isinstance(palette, (list, tuple, np.ndarray)):
        pal = np.asarray(palette, np.uint8)
    else:
        pal = load_palette(palette)
    out = quantize(out, pal, dither, dither_strength)
    out = add_outline(out, pal, outline)
    return out, pal


# --------------------------------------------------------------------------- command line

def main(argv=None):
    ap = argparse.ArgumentParser(description="a picture -> pixel art (deterministic, numpy)")
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--size", type=int, help="the long side of the result in pixels (64, 96, 128)")
    ap.add_argument("--factor", type=int, help="an integer reduction instead of --size")
    ap.add_argument("--mode", choices=("box", "nearest", "dominant"), default="box",
                    help="how to shrink: block average, nearest or the most frequent colour of a block")
    ap.add_argument("--palette", default="auto", help="auto | none | a .gpl/.hex/.png file")
    ap.add_argument("--colors", type=int, default=32, help="colours when --palette auto")
    ap.add_argument("--dither", action="store_true", help="ordered Bayer 4x4 dithering")
    ap.add_argument("--dither-strength", type=float, default=0.5)
    ap.add_argument("--outline", choices=OUTLINES, default="none")
    ap.add_argument("--alpha-threshold", type=int, default=128)
    ap.add_argument("--saturation", type=float, default=1.0, help="saturation before quantization (1 = unchanged)")
    ap.add_argument("--levels", action="store_true", help="stretch luminance (percentiles 2..98 -> 14..240)")
    ap.add_argument("--remove-bg", action="store_true", help="remove the background picked from the corners")
    ap.add_argument("--bg-tol", type=int, default=24)
    ap.add_argument("--preview", type=int, default=0, help="additionally write <output>_xN.png upscaled nearest")
    ap.add_argument("--palette-out", help="write the palette as a PNG strip (1 pixel per colour)")
    a = ap.parse_args(argv)
    img = read_png(a.input)
    out, pal = pixelize(img, size=a.size, factor=a.factor, palette=a.palette, colors=a.colors, dither=a.dither,
                        outline=a.outline, alpha_threshold=a.alpha_threshold, mode=a.mode,
                        remove_bg=a.remove_bg, bg_tolerance=a.bg_tol, dither_strength=a.dither_strength,
                        saturation=a.saturation, levels=a.levels)
    write_png(a.output, out)
    info = {"ok": True, "output": os.path.abspath(a.output), "size": [out.shape[1], out.shape[0]],
            "colors": int(len(pal)), "palette": [hex_of(c) for c in pal]}
    if a.preview and a.preview > 1:
        base, ext = os.path.splitext(a.output)
        big = np.repeat(np.repeat(out, a.preview, axis=0), a.preview, axis=1)
        info["preview"] = write_png("%s_x%d%s" % (base, a.preview, ext), big)
    if a.palette_out and len(pal):
        write_png(a.palette_out, palette_strip(pal))
    print(json.dumps(info, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
