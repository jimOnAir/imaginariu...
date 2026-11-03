"""Shared conventions of the face check (face_match / face_fix): canonical views, camera, zones.

The check frame: 800x800, an orthographic camera, the same geometry as in tools/bl_shots.py ("face",
"face34", "face34r", "back"):
  centre = (cx, 0, zmax - crop/2), ortho_scale = crop * 1.1, crop = 0.42 m (head with shoulders),
  transparent background.
The camera basis is the one of scripts/blender/steps/_paint_lib.OrthoCam:
  d = (-sin(yaw) cos(pitch), cos(yaw) cos(pitch), -sin(pitch)), right = d x Z, up = right x d.
  yaw 0 - the camera in front of the model (looking along +Y); yaw +35 - the camera on the +X side (the
  character's left cheek is visible: the "face34" shot of bl_shots, the face34_rgba.png reference);
  yaw -35 - "face34r"; yaw 180 - the back of the head.
Frame pixel: u = px_per_m * (P - centre) . right + size/2,  v = size/2 - px_per_m * (P - centre) . up,
  px_per_m = size / ortho_scale; the centre of pixel (i, j) is (i + 0.5, j + 0.5).

Reference alignment (align / params.camera.{scale,dx,dy}): the reference is shrunk so that its longer
side becomes size px (k = size / max(W, H)), then frame_px = scale * ref_px * k + (dx, dy).

Zones (the fallback when the checker produced no bbox): fractions of the head silhouette bbox in the
frame (x0, y0, x1, y1); "left/right" is per image (the left/right of the frame).
"""
import math

import numpy as np

SIZE = 800
CROP_M = 0.42               # gives the frame that matches chk_final_face.png (IoU 1.000)
MARGIN = 1.1
HEAD_CUT_Z = 1.515          # the head cut in archer v4 (the Head material above it)

VIEWS = {
    "front": {"yaw": 0.0, "pitch": 0.0, "ref": "face_front_rgba.png", "ru": "анфас", "shot": "face"},
    "face34_left": {"yaw": 35.0, "pitch": 0.0, "ref": "face34_rgba.png", "ru": "3/4 слева", "shot": "face34"},
    "face34_right": {"yaw": -35.0, "pitch": 0.0, "ref": "face34_flip_rgba.png", "ru": "3/4 справа", "shot": "face34r"},
    "back": {"yaw": 180.0, "pitch": 0.0, "ref": "head_back_rgba.png", "ru": "затылок", "shot": "back"},
}
ALIASES = {"face": "front", "anfas": "front", "face34": "face34_left", "left34": "face34_left", "face34l": "face34_left",
           "face34r": "face34_right", "right34": "face34_right", "rear": "back"}

# fractions of the head silhouette bbox (hair included): x0, y0, x1, y1
ZONE_TABLE = {
    "forehead_headband": (0.20, 0.22, 0.80, 0.40),
    "brows": (0.22, 0.38, 0.78, 0.48),
    "left_eye": (0.22, 0.44, 0.50, 0.56),
    "right_eye": (0.50, 0.44, 0.78, 0.56),
    "nose": (0.40, 0.50, 0.60, 0.70),
    "left_cheek": (0.18, 0.55, 0.42, 0.80),
    "right_cheek": (0.58, 0.55, 0.82, 0.80),
    "mouth": (0.36, 0.70, 0.64, 0.82),
    "chin": (0.34, 0.80, 0.66, 0.94),
    "hair_left": (0.00, 0.10, 0.28, 0.85),
    "hair_right": (0.72, 0.10, 1.00, 0.85),
    "hair_top": (0.15, 0.00, 0.85, 0.24),
    "neck_collar": (0.25, 0.90, 0.75, 1.10),
    "seam": (0.20, 0.85, 0.80, 1.05),
}


def canon_view(name):
    n = str(name or "front").strip().lower()
    return ALIASES.get(n, n)


def basis(yaw_deg, pitch_deg=0.0):
    a, e = math.radians(float(yaw_deg)), math.radians(float(pitch_deg))
    d = np.array([-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), -math.sin(e)], np.float64)
    r = np.cross(d, [0.0, 0.0, 1.0])
    r /= max(float(np.linalg.norm(r)), 1e-12)
    u = np.cross(r, d)
    return r, u, d


def view_camera(view, zmax, cx, crop=CROP_M, size=SIZE, yaw=None, pitch=None):
    """The canonical camera of a view (a dict, serialized to JSON for Blender)."""
    v = VIEWS[canon_view(view)]
    ortho = float(crop) * MARGIN
    return {"view": canon_view(view), "yaw": float(v["yaw"] if yaw is None else yaw),
            "pitch": float(v["pitch"] if pitch is None else pitch),
            "centre": [float(cx), 0.0, float(zmax) - float(crop) / 2.0], "ortho_scale": ortho,
            "size": int(size), "px_per_m": float(size) / ortho, "distance": 6.0}


def project(cam, P):
    """P (n,3) world -> u, v (frame pixels, pixel centre +0.5), depth (along the view, smaller = closer).
    cam["post"] (2x3, optional) - the affine map from the raw camera frame into the check frame
    (silhouette scale + ECC): the executor works directly in the face_match frame that way."""
    r, u, d = basis(cam["yaw"], cam["pitch"])
    Q = np.asarray(P, np.float64) - np.asarray(cam["centre"], np.float64)
    s, h = cam["px_per_m"], cam.get("raw_size", cam["size"]) / 2.0
    uu, vv = (s * (Q @ r) + h), (h - s * (Q @ u))
    M = cam.get("post")
    if M is not None:
        M = np.asarray(M, np.float64)
        uu, vv = M[0, 0] * uu + M[0, 1] * vv + M[0, 2], M[1, 0] * uu + M[1, 1] * vv + M[1, 2]
    return uu, vv, (Q @ d)


def frame_px_per_m(cam):
    """Pixels per metre in the check frame (accounting for the post-scale)."""
    M = cam.get("post")
    if M is None:
        return float(cam["px_per_m"])
    M = np.asarray(M, np.float64)
    return float(cam["px_per_m"]) * math.sqrt(abs(M[0, 0] * M[1, 1] - M[0, 1] * M[1, 0]))


def frame_shift_to_world(cam, dx_px, dy_px):
    """A frame content shift of (dx, dy) px -> a world shift (metres) in the camera plane."""
    r, up, _ = basis(cam["yaw"], cam["pitch"])
    M = cam.get("post")
    du, dv = float(dx_px), float(dy_px)
    if M is not None:
        A = np.asarray(M, np.float64)[:, :2]
        du, dv = np.linalg.solve(A, np.array([du, dv]))
    s = float(cam["px_per_m"])
    return (du / s) * r + (-dv / s) * up


def toward(cam):
    """A unit vector from the surface toward the camera (orthographic: -d)."""
    return -basis(cam["yaw"], cam["pitch"])[2]


def zone_bbox(zone, head_bbox):
    """A fallback zone by name: fractions of the head silhouette bbox (x, y, w, h in frame pixels)."""
    fr = ZONE_TABLE.get(zone)
    if fr is None:
        return None
    x0, y0, x1, y1 = head_bbox
    w, h = x1 - x0, y1 - y0
    return [x0 + fr[0] * w, y0 + fr[1] * h, (fr[2] - fr[0]) * w, (fr[3] - fr[1]) * h]
