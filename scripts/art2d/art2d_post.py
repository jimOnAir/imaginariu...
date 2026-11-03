"""Deterministic post-processing for the 2D module (docs/art2d.md). Runs in the ComfyUI venv (PIL, numpy, rembg).

    art2d_post.py run --job job.json

job.json = {"ops": [...]} - executed in order inside ONE process (rembg loads once). Operations:
    {"op": "cut",   "in": a.png, "out": b.png, "pad": 8}                       cut the figure off a plain background -> RGBA, trimmed
    {"op": "pixel", "in": a.png, "out": b.png, "cell": 6, "colors": 24}        real pixel art: box downscale, palette, nearest upscale
    {"op": "sheet", "items": [png...], "out": s.png, "cols": 4, "cell": [w,h], "anchor": [ax, ay], "fit": "common"}
        sprite sheet: every frame scaled by ONE common factor (frames keep their relative size), feet on the anchor
    {"op": "board", "items": [png...], "captions": [str...], "out": b.png, "cols": 3, "thumb": 640}   storyboard / contact sheet
The last stdout line is `RESULT {json}` with per-op results.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent
os.environ.setdefault("U2NET_HOME", str(APP / "data" / "models" / "background"))
os.environ.setdefault("OMP_NUM_THREADS", "4")

_SESSION = None


def session():
    global _SESSION
    if _SESSION is None:
        from rembg import new_session
        _SESSION = new_session("u2net", providers=["CPUExecutionProvider"])
    return _SESSION


def white_key(rgb):
    """Alpha from 'how far from the near-white backdrop', only for regions connected to the image border."""
    from scipy import ndimage
    f = rgb.astype(np.int16)
    near_white = (f.min(-1) > 238) & ((f.max(-1) - f.min(-1)) < 14)
    lab, n = ndimage.label(near_white)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(border))
    return (~bg * 255).astype(np.uint8)


def cut(src, dst, pad=8):
    """Keep the figure, drop the plain backdrop: the white key gives exact edges, the network (dilated so thin
    weapons and hair near the figure survive) removes the shadows and specks the key would keep."""
    from rembg import remove
    from scipy import ndimage
    img = Image.open(src).convert("RGBA")
    arr = np.array(img)
    if arr[..., 3].min() < 250:                        # already transparent: trust it
        alpha = arr[..., 3]
    else:
        rgb = Image.fromarray(arr[..., :3])
        a_net = np.array(remove(rgb, session=session(), only_mask=True))
        a_key = white_key(arr[..., :3])
        near = ndimage.binary_dilation(a_net > 40, iterations=max(3, min(arr.shape[:2]) // 120))
        alpha = np.where(near, a_key, 0).astype(np.uint8)
        alpha = np.array(Image.fromarray(alpha).filter(ImageFilter.MedianFilter(3)))
    arr[..., 3] = alpha
    ys, xs = np.nonzero(alpha > 8)
    if len(xs) == 0:
        raise RuntimeError("No object found in the picture: " + str(src))
    x0, x1 = max(0, xs.min() - pad), min(arr.shape[1], xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(arr.shape[0], ys.max() + 1 + pad)
    out = Image.fromarray(arr[y0:y1, x0:x1])
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    out.save(dst)
    return {"out": str(dst), "size": [out.width, out.height], "bbox": [int(x0), int(y0), int(x1), int(y1)],
            "coverage": round(float((alpha > 8).mean()), 4)}


def pixel(src, dst, cell=6, colors=24):
    """Real pixel art: BOX downscale by `cell`, palette quantization without dithering, NEAREST upscale."""
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    sw, sh = max(1, w // cell), max(1, h // cell)
    small = img.resize((sw, sh), Image.BOX)
    a = np.array(small)
    alpha = np.where(a[..., 3] > 110, 255, 0).astype(np.uint8)
    rgb = Image.fromarray(a[..., :3]).quantize(colors=int(colors), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    small = Image.fromarray(np.dstack([np.array(rgb), alpha]), "RGBA")
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    small.resize((sw * cell, sh * cell), Image.NEAREST).save(dst)
    small.save(str(dst).replace(".png", "_1x.png"))
    return {"out": str(dst), "native": [sw, sh], "colors": int(colors)}


def bbox(img):
    a = np.array(img.getchannel("A"))
    ys, xs = np.nonzero(a > 8)
    if len(xs) == 0:
        return (0, 0, img.width, img.height)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def sheet(items, dst, cols=4, cell=(256, 256), anchor=None, fit="common", margin=0.06):
    cw, ch = int(cell[0]), int(cell[1])
    ax, ay = (anchor or [cw / 2, ch * (1 - margin)])
    frames = [Image.open(p).convert("RGBA") for p in items]
    boxes = [bbox(f) for f in frames]
    usable_w, usable_h = cw * (1 - 2 * margin), ch * (1 - 2 * margin)
    if fit == "common":
        # one factor for the whole set: frames keep their relative size (the animation must not jump)
        mw = max(b[2] - b[0] for b in boxes)
        mh = max(b[3] - b[1] for b in boxes)
        scales = [min(usable_w / mw, usable_h / mh)] * len(frames)
    else:
        scales = [min(usable_w / (b[2] - b[0]), usable_h / (b[3] - b[1])) for b in boxes]
    cols = max(1, min(int(cols), len(frames)))
    rows = (len(frames) + cols - 1) // cols
    out = Image.new("RGBA", (cols * cw, rows * ch), (0, 0, 0, 0))
    rects = []
    for i, (f, b, s) in enumerate(zip(frames, boxes, scales)):
        crop = f.crop(b)
        nw, nh = max(1, round(crop.width * s)), max(1, round(crop.height * s))
        crop = crop.resize((nw, nh), Image.LANCZOS)
        cx, cy = (i % cols) * cw, (i // cols) * ch
        px = int(round(cx + ax - nw / 2))
        py = max(cy, int(round(cy + ay - nh)))          # feet (bottom of the figure) on the anchor
        out.alpha_composite(crop, (px, py))
        rects.append({"x": cx, "y": cy, "w": cw, "h": ch})
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    out.save(dst)
    return {"out": str(dst), "size": [out.width, out.height], "cols": cols, "rows": rows, "cell": [cw, ch],
            "anchor": [ax, ay], "frames": rects, "scale": round(scales[0], 4)}


def font(size):
    for name in ("arial.ttf", "segoeui.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def wrap(draw, text, fnt, width, max_lines=3):
    lines, line = [], ""
    for word in str(text).split():
        test = (line + " " + word).strip()
        if draw.textlength(test, font=fnt) <= width:
            line = test
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines[:max_lines]


def board(items, dst, captions=None, cols=3, thumb=640):
    captions = captions or [""] * len(items)
    frames = [Image.open(p).convert("RGB") for p in items]
    tw = int(thumb)
    th = max(round(tw * f.height / f.width) for f in frames)
    cap_h, gap = 92, 18
    cols = max(1, min(int(cols), len(frames)))
    rows = (len(frames) + cols - 1) // cols
    W, H = cols * tw + (cols + 1) * gap, rows * (th + cap_h) + (rows + 1) * gap
    out = Image.new("RGB", (W, H), (245, 243, 238))
    d = ImageDraw.Draw(out)
    f_num, f_cap = font(22), font(18)
    for i, f in enumerate(frames):
        x = gap + (i % cols) * (tw + gap)
        y = gap + (i // cols) * (th + cap_h + gap)
        im = f.resize((tw, round(tw * f.height / f.width)), Image.LANCZOS)
        out.paste(im, (x, y))
        d.rectangle([x, y, x + tw - 1, y + im.height - 1], outline=(40, 40, 40), width=2)
        d.text((x, y + th + 8), "%02d" % (i + 1), fill=(20, 20, 20), font=f_num)
        for j, line in enumerate(wrap(d, captions[i] if i < len(captions) else "", f_cap, tw - 44)):
            d.text((x + 40, y + th + 10 + j * 24), line, fill=(60, 60, 60), font=f_cap)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    out.save(dst)
    return {"out": str(dst), "size": [W, H]}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--job", required=True)
    a = ap.parse_args()
    job = json.loads(Path(a.job).read_text(encoding="utf-8"))
    results = []
    for op in job["ops"]:
        kind = op["op"]
        if kind == "cut":
            results.append(cut(op["in"], op["out"], int(op.get("pad", 8))))
        elif kind == "pixel":
            results.append(pixel(op["in"], op["out"], int(op.get("cell", 6)), int(op.get("colors", 24))))
        elif kind == "sheet":
            results.append(sheet(op["items"], op["out"], op.get("cols", 4), op.get("cell", [256, 256]), op.get("anchor"), op.get("fit", "common")))
        elif kind == "board":
            results.append(board(op["items"], op["out"], op.get("captions"), op.get("cols", 3), op.get("thumb", 640)))
        else:
            raise SystemExit("unknown op " + kind)
        print("done", kind, flush=True)
    print("RESULT " + json.dumps({"results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
