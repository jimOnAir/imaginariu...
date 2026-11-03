"""Tests of pixelize.py without Blender: python3 -I scripts/pixel/test_pixelize.py (tests/pixel.test.mjs runs them too)."""
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pixelize as px  # noqa: E402


def sample_image(seed=3, h=40, w=48):
    """A gradient with a dark body over a transparent background and a soft edge."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 4), np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    body = ((yy - h / 2) ** 2 / (h * 0.4) ** 2 + (xx - w / 2) ** 2 / (w * 0.3) ** 2) < 1.0
    img[..., 0] = (xx * 255 // w)
    img[..., 1] = (yy * 255 // h)
    img[..., 2] = rng.integers(0, 255, size=(h, w))
    img[..., 3] = np.where(body, 255, 0)
    img[0:3, 0:3, 3] = 90          # a weak alpha tail: it must disappear
    return img


class PixelizeTests(unittest.TestCase):
    def test_gpl_hex_png_palettes(self):
        gpl = "GIMP Palette\nName: x\nColumns: 4\n#\n  0   0   0\tblack\n255 128   0 orange\n 10  20  30\n"
        self.assertEqual(px.parse_gpl(gpl).tolist(), [[0, 0, 0], [255, 128, 0], [10, 20, 30]])
        self.assertEqual(px.parse_hex("#ff0000\n00ff00\nbad\n").tolist(), [[255, 0, 0], [0, 255, 0]])
        with self.assertRaises(ValueError):
            px.parse_gpl("GIMP Palette\n#\n")
        with tempfile.TemporaryDirectory() as d:
            pal = np.array([[1, 2, 3], [200, 100, 50], [9, 9, 9]], np.uint8)
            px.write_png(os.path.join(d, "p.png"), px.palette_strip(pal))
            with open(os.path.join(d, "p.gpl"), "w", encoding="utf-8") as fh:
                fh.write(px.palette_gpl(pal))
            self.assertEqual(px.load_palette(os.path.join(d, "p.png")).tolist(), pal.tolist())
            self.assertEqual(px.load_palette(os.path.join(d, "p.gpl")).tolist(), pal.tolist())
            with open(os.path.join(d, "p.txt"), "w", encoding="utf-8"):
                pass
            with self.assertRaises(ValueError):
                px.load_palette(os.path.join(d, "p.txt"))
            with self.assertRaises(FileNotFoundError):
                px.load_palette(os.path.join(d, "none.gpl"))

    def test_median_cut_deterministic_and_bounded(self):
        img = sample_image()
        a = px.auto_palette([img], 12)
        b = px.auto_palette([img.copy()], 12)
        self.assertTrue(np.array_equal(a, b))
        self.assertLessEqual(len(a), 12)
        self.assertGreater(len(a), 6)
        lum = px.luminance(a)
        self.assertTrue(np.all(np.diff(lum) >= 0), "the palette is ordered by luminance")

    def test_quantize_palette_only_and_alpha_binary(self):
        img = px.binarize_alpha(sample_image(), 128)
        self.assertEqual(sorted(set(img[..., 3].ravel().tolist())), [0, 255])
        pal = px.auto_palette([img], 8)
        for dither in (False, True):
            q = px.quantize(img, pal, dither)
            self.assertEqual(px.palette_violations(q, pal), (0, 0))
            self.assertTrue(np.array_equal(q[..., 3], img[..., 3]))
            self.assertTrue(np.array_equal(q, px.quantize(img, pal, dither)), "deterministic")
        self.assertFalse(np.array_equal(px.quantize(img, pal, True), px.quantize(img, pal, False)))

    def test_dither_uses_bayer_pattern(self):
        flat = np.zeros((8, 8, 4), np.uint8)
        flat[..., :3] = 128
        flat[..., 3] = 255
        pal = np.array([[0, 0, 0], [255, 255, 255]], np.uint8)
        q = px.quantize(flat, pal, dither=True, strength=1.0)
        white = int((q[..., 0] == 255).sum())
        self.assertTrue(24 <= white <= 40, white)       # grey 50 % -> about half the pixels go white
        self.assertTrue(np.array_equal(q[:4, :4], q[4:, 4:]), "the pattern repeats every 4 px")

    def test_outline_modes(self):
        img = np.zeros((9, 9, 4), np.uint8)
        img[3:6, 3:6] = (200, 120, 40, 255)
        pal = np.array([[10, 10, 10], [90, 50, 20], [200, 120, 40]], np.uint8)
        dark = px.add_outline(img, pal, "dark")
        added = (dark[..., 3] > 0) & (img[..., 3] == 0)
        self.assertEqual(int(added.sum()), 12)           # 4 sides of 3, no corners
        self.assertTrue(np.all(dark[added][:, :3] == pal[0]))
        auto = px.add_outline(img, pal, "auto")
        self.assertTrue(np.all(px.luminance(auto[added][:, :3]) < px.luminance(np.array([200, 120, 40])) - 8))
        self.assertEqual(px.palette_violations(auto, pal), (0, 0))
        self.assertTrue(px.add_outline(img, pal, "none") is img)
        with self.assertRaises(ValueError):
            px.add_outline(img, pal, "thick")

    def test_auto_palette_reserves_dark_outline_colour(self):
        light = np.zeros((6, 6, 4), np.uint8)
        light[..., :3] = [(200, 180, 90), (210, 190, 100)][0]
        light[:3, :, :3] = (230, 210, 120)
        light[..., 3] = 255
        pal = px.auto_palette([light], 8, outline="dark")
        self.assertLess(float(px.luminance(pal).min()), 100.0)
        self.assertEqual(len(px.auto_palette([light], 8, outline="none")), 2)

    def test_reduce_modes(self):
        flat = np.zeros((16, 16, 4), np.uint8)
        flat[..., :3] = (40, 90, 200)
        flat[..., 3] = 255
        self.assertTrue(np.all(px.resize_area(flat, 4, 4)[..., :3] == (40, 90, 200)))
        k = np.zeros((8, 8, 4), np.uint8)
        k[..., 3] = 255
        k[3:5, 3:5, :3] = 255
        self.assertEqual(px.reduce_block(k, 4, "nearest").shape, (2, 2, 4))
        self.assertEqual(px.reduce_block(k, 4, "box")[0, 0, 0], int(round(255 * 1 / 16)))
        # the dominant colour of a block: 3 red pixels and 1 blue -> red, no mixing
        blk = np.zeros((2, 2, 4), np.uint8)
        blk[..., 3] = 255
        blk[..., 0] = 255
        blk[1, 1] = (0, 0, 255, 255)
        self.assertEqual(px.reduce_dominant(blk, 1, 1)[0, 0, :3].tolist(), [255, 0, 0])
        with self.assertRaises(ValueError):
            px.reduce_block(k, 3, "box")

    def test_resize_area_premultiplied_alpha(self):
        img = np.zeros((2, 2, 4), np.uint8)
        img[0, 0] = (255, 0, 0, 255)           # one opaque red pixel and three empty ones
        out = px.resize_area(img, 1, 1)
        self.assertEqual(out[0, 0, :3].tolist(), [255, 0, 0])      # the colour is not muddied by the transparency
        self.assertTrue(60 <= out[0, 0, 3] <= 68)

    def test_tone_levels_and_saturation(self):
        a = np.zeros((10, 10, 4), np.uint8)
        a[..., :3] = np.linspace(60, 100, 10).astype(np.uint8)[None, :, None]
        a[..., 3] = 255
        out = px.tone([a, a.copy()], 1.0, True)
        lum = px.luminance(out[0][..., :3])
        self.assertLess(lum.min(), 30)
        self.assertGreater(lum.max(), 220)
        self.assertTrue(np.array_equal(out[0], out[1]))
        self.assertTrue(px.tone([a], 1.0, False)[0] is a)
        gray = px.tone([a], 2.0, False)[0]
        self.assertTrue(np.array_equal(gray, a), "grey does not change with saturation")

    def test_remove_background_keeps_enclosed_colour(self):
        img = np.zeros((12, 12, 4), np.uint8)
        img[..., :3] = 250
        img[..., 3] = 255
        img[3:9, 3:9, :3] = (30, 30, 30)
        img[5:7, 5:7, :3] = 250                  # white inside the object is not the background
        out = px.remove_background(img, 10)
        self.assertEqual(out[0, 0, 3], 0)
        self.assertEqual(out[5, 5, 3], 255)

    def test_pixelize_end_to_end_deterministic(self):
        img = sample_image(h=64, w=64)
        a, pa = px.pixelize(img, size=32, colors=10, outline="auto", dither=True)
        b, pb = px.pixelize(img.copy(), size=32, colors=10, outline="auto", dither=True)
        self.assertTrue(np.array_equal(a, b) and np.array_equal(pa, pb))
        self.assertEqual(a.shape[:2], (32, 32))
        self.assertEqual(px.palette_violations(a, pa), (0, 0))
        c, pc = px.pixelize(img, size=32, palette="none")
        self.assertEqual(len(pc), 0)
        d, pd = px.pixelize(img, size=32, palette=pa)       # the palette as an array
        self.assertEqual(px.palette_violations(d, pa), (0, 0))

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.png")
            px.write_png(src, sample_image(h=64, w=64))
            out = os.path.join(d, "out.png")
            self.assertEqual(px.main([src, out, "--size", "16", "--colors", "6", "--outline", "dark", "--preview", "3",
                                      "--palette-out", os.path.join(d, "pal.png")]), 0)
            res = px.read_png(out)
            self.assertEqual(res.shape[:2], (16, 16))
            self.assertEqual(px.read_png(os.path.join(d, "out_x3.png")).shape[:2], (48, 48))
            self.assertTrue(os.path.isfile(os.path.join(d, "pal.png")))


if __name__ == "__main__":
    unittest.main()
