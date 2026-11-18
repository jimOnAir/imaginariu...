"""Self-tests of the `pixel` profile of the render_sprites step (docs/forge/pixel.md); the pure numpy
part is tested by scripts/pixel/test_pixelize.py.

The model is built in the test (a grey column with a red nose, as in test_export). Temporary files go
only into tempfile.mkdtemp(). Run:

    blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- pixel
"""
import atexit
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np

import imaginarium_common as ima
from steps import _export_lib as xl
from steps import render_sprites
from test_export import build_marker_figure

sys.path.insert(0, render_sprites.PIXEL_DIR)
import pixelize as px  # noqa: E402


def _tmp(prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    if not os.environ.get("Imaginarium_KEEP_TEST_FILES"):
        atexit.register(shutil.rmtree, d, True)
    return d


def _done(*dirs):
    if not os.environ.get("Imaginarium_KEEP_TEST_FILES"):
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)


def _run(glb, out, **params):
    base = {"profile": "pixel", "asset_id": "marker", "directions": ["S", "E"], "validate_godot": False}
    base.update(params)
    ima.reset_scene()
    return render_sprites.run({"step": "render_sprites", "inputs": {"mesh": glb}, "params": base, "out_dir": out})


def _errors(res):
    return [c["name"] for c in res["checks"] if not c["ok"] and c.get("severity", "error") == "error"]


def _sheet_pixels(res):
    return [xl.load_png(p) for p in res["outputs"]["sheets"].values()]


def test_pixel_profile_palette_alpha_and_outputs():
    """Every visible sheet pixel is a palette colour, alpha is only 0/255, palette.png/.gpl and an enlarged preview lie next to the sheets."""
    d = _tmp("imaginarium_pixel_")
    glb = build_marker_figure(os.path.join(d, "figure.glb"))
    res = _run(glb, os.path.join(d, "out"), outline="auto", colors=12, levels=True)
    assert not _errors(res), _errors(res)
    names = {c["name"] for c in res["checks"]}
    assert {"pixel_palette_only", "pixel_alpha_binary"} <= names, names
    doc = json.load(open(res["outputs"]["sprites_json"], encoding="utf-8"))
    assert doc["profile"] == "pixel" and doc["px_per_meter"] == 24.0 and doc["pixel"]["texture_filter"] == "nearest"
    assert doc["clips"]["static"]["frames"] == 1         # the figure has no clips: one static frame
    cw, ch = doc["cell"]
    assert cw % 2 == 0 and float(doc["anchor"][0]) == cw / 2 and float(doc["anchor"][1]) == int(doc["anchor"][1])
    pal = px.load_palette(res["outputs"]["palette"])
    assert 2 <= len(pal) <= 12 and len(pal) == doc["pixel"]["colors"]
    assert px.load_palette(res["outputs"]["palette_gpl"]).tolist() == pal.tolist()
    for sheet in _sheet_pixels(res):
        assert px.palette_violations(sheet, pal) == (0, 0)
        assert set(np.unique(sheet[..., 3]).tolist()) <= {0, 255}
    # a 1.7 m figure at 24 px/m and 30 deg: about 1.7 * cos30 * 24 = 35 px
    sheet = _sheet_pixels(res)[0]
    body = xl.pixel_support(sheet[0:ch, 0:cw])["body_bounds_px"]
    assert 30 <= body[3] - body[1] <= 44, body
    pv = xl.load_png(res["outputs"]["preview"])
    assert pv.shape[1] >= 4 * cw * 2, "the preview is enlarged 4 times"
    _done(d)


def test_pixel_profile_deterministic_and_palette_file():
    """Two runs give identical sheets; a .gpl palette takes only the file's colours; dithering and the outline stay inside the palette."""
    d = _tmp("imaginarium_pixel_pal_")
    glb = build_marker_figure(os.path.join(d, "figure.glb"))
    a = _run(glb, os.path.join(d, "a"), outline="dark", dither=True, colors=8)
    b = _run(glb, os.path.join(d, "b"), outline="dark", dither=True, colors=8)
    for (n1, p1), (n2, p2) in zip(sorted(a["outputs"]["sheets"].items()), sorted(b["outputs"]["sheets"].items())):
        assert np.array_equal(xl.load_png(p1), xl.load_png(p2)), n1
    gpl = os.path.join(d, "mine.gpl")
    colors = [(20, 20, 30), (90, 80, 70), (150, 140, 130), (230, 220, 200), (200, 30, 30)]
    with open(gpl, "w", encoding="utf-8") as fh:
        fh.write("GIMP Palette\nName: mine\n#\n" + "".join("%d %d %d c\n" % c for c in colors))
    res = _run(glb, os.path.join(d, "c"), palette=gpl, outline="auto", supersample=2)
    assert not _errors(res), _errors(res)
    pal = px.load_palette(gpl)
    for sheet in _sheet_pixels(res):
        assert px.palette_violations(sheet, pal) == (0, 0)
    assert res["stats"]["pixel"]["palette_source"] == "file" and res["stats"]["pixel"]["supersample"] == 2
    _done(d)


def test_pixel_profile_downscale_nearest_and_guards():
    """downscale renders k times larger and takes nearest; invalid parameters are rejected before the render."""
    d = _tmp("imaginarium_pixel_ds_")
    glb = build_marker_figure(os.path.join(d, "figure.glb"))
    res = _run(glb, os.path.join(d, "ok"), downscale=3, directions=["S"], palette="none")
    assert not _errors(res), _errors(res)
    assert res["stats"]["pixel"]["reduce"] == "nearest" and res["stats"]["pixel"]["render_scale"] == 3
    for bad, words in (({"supersample": 2, "downscale": 2}, "not both"), ({"supersample": 9}, "supersample"),
                       ({"outline": "thick"}, "outline"), ({"palette": 5}, "palette"),
                       ({"palette": os.path.join(d, "none.gpl")}, "not found"), ({"colors": 1}, "colors")):
        t0 = time.time()
        try:
            _run(glb, os.path.join(d, "bad"), **bad)
        except (ValueError, FileNotFoundError) as exc:
            assert words in str(exc), (bad, str(exc))
        else:
            raise AssertionError("%r must be rejected" % (bad,))
        assert time.time() - t0 < 20 and not os.path.isdir(os.path.join(d, "bad", "_frames"))
    _done(d)
