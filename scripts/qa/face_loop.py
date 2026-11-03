# -*- coding: utf-8 -*-
"""face_loop - the face "check -> fix" cycle until it matches the reference.

    python face_loop.py --start <painted.blend> --refs <in/ folder> --work <folder v5> [--max-iter 8] [--no-vlm] [--strict]
                        [--resume] [--finalize-only] [--body-refs <mv/ folder>] [--blender <exe>]

Iteration i: face_match (in iteration 1's frame via --frame-from) -> iter_XX/check/face_report.json|jpg; if
pass - stop; otherwise face_fix over the report -> iter_XX/fix/painted.blend - the next iteration's model.
Keeps loop_state.json (score_history, best). If the score does not grow for `plateau` iterations in a row,
stops with code 3 (analyze by hand, then --resume). At the end: the best model -> <work>/best/
(painted.blend, archer_painted.glb, face_report.json/.jpg) and the overview sheet best/texture_check.jpg
(front, back, front-face, 3/4 left/right: reference on top, model below).
Codes: 0 - pass, 1 - iteration limit without pass, 2 - error, 3 - plateau (score not growing).

The "=== ITERATION n/m" progress marker is ASCII on purpose: face_step.py parses it to drive the studio
progress bar (done = n - 1, total = m).
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
BLENDER_DEFAULT = (r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" if os.name == "nt" else "blender")
# front/back body renders for the overview sheet: a copy of the video's tools/bl_paint_check.py role lives
# next to this file (scripts/qa); ASTRA_PAINT_CHECK overrides
PAINT_CHECK = os.environ.get("ASTRA_PAINT_CHECK") or os.path.join(HERE, "bl_paint_check.py")
if not os.path.isfile(PAINT_CHECK):
    PAINT_CHECK = r"C:\Dorn\Dops media\02 Проекты\Таймлапс AstraForge\01 Лучник\tools\bl_paint_check.py"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
T0 = time.time()
LOG = {"fh": None}


def out(line):
    print(line, flush=True)
    if LOG["fh"] is not None:
        try:
            LOG["fh"].write(line + chr(10))
            LOG["fh"].flush()
        except Exception:
            pass


def say(msg):
    out("[face_loop %6.1f s] %s" % (time.time() - T0, msg))


def run(cmd, label):
    """Run with live output (for the terminal record)."""
    say("> " + label)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    for raw in iter(p.stdout.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip()
        if line:
            out("    " + line)
    p.wait()
    return p.returncode


def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)


def summarize(rep):
    d = rep.get("defects") or []
    sev = {k: sum(1 for x in d if x.get("severity") == k) for k in ("blocker", "major", "minor")}
    per = "  ".join("%s %.1f" % (k, v.get("score", 0)) for k, v in (rep.get("views") or {}).items())
    return "score %.1f  %s  defects %d (blocker %d, major %d, minor %d)  [%s]" % (
        rep.get("score", 0), "PASS" if rep.get("pass") else "FAIL", len(d), sev["blocker"], sev["major"], sev["minor"], per)


def finalize(a, state):
    best = state.get("best")
    if not best:
        say("no best model - not building the sheet")
        return None
    bdir = os.path.join(a.work, "best")
    os.makedirs(bdir, exist_ok=True)
    src_model = best["model"]
    src_dir = os.path.dirname(src_model)
    # the best model is always best/painted.blend (the start model may be named differently); its GLB goes next to it as is
    if os.path.isfile(src_model):
        shutil.copy2(src_model, os.path.join(bdir, "painted.blend"))
    for p in sorted(glob.glob(os.path.join(src_dir, "*.glb"))):
        shutil.copy2(p, os.path.join(bdir, os.path.basename(p)))
    chk = best["check_dir"]
    for name in ("face_report.json", "face_report.jpg"):
        p = os.path.join(chk, name)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(bdir, name))
    say("best model: iteration %d, score %.1f -> %s" % (best["iteration"], best["score"], bdir))
    # body renders (front/back) - the video's bl_paint_check.py; the face - the checker's aligned frames
    prefix = os.path.join(bdir, "chk_final")
    if os.path.isfile(PAINT_CHECK):
        rc = run([a.blender, "-b", "--factory-startup", "--python", PAINT_CHECK, "--", os.path.join(bdir, "painted.blend"), prefix], "Blender: front/back body renders")
        if rc != 0:
            say("body render failed (code %s)" % rc)
    else:
        say("no bl_paint_check.py (%s) - sheet without the front/back renders" % PAINT_CHECK)
    import cv2  # noqa: E402  (studio QA python)
    import numpy as np  # noqa: E402
    refs_body = a.body_refs or os.path.join(os.path.dirname(os.path.abspath(a.refs.rstrip("\\/"))), "mv")
    # column titles are sheet captions - Russian verbatim (report artifact)
    cols = [("Перед", os.path.join(refs_body, "ref_front.png"), prefix + "_front.png"),
            ("Спина", os.path.join(refs_body, "ref_back.png"), prefix + "_back.png"),
            ("Анфас", os.path.join(chk, "ref_front.png"), os.path.join(chk, "render_front.png")),
            ("3/4 слева", os.path.join(chk, "ref_face34_left.png"), os.path.join(chk, "render_face34_left.png")),
            ("3/4 справа", os.path.join(chk, "ref_face34_right.png"), os.path.join(chk, "render_face34_right.png"))]
    S = 520
    sheet = np.full((2 * S + 70, len(cols) * S, 3), 128, np.uint8)

    def cell(path):
        im = cv2.imread(path, cv2.IMREAD_UNCHANGED) if path and os.path.isfile(path) else None
        if im is None:
            return np.full((S, S, 3), 90, np.uint8)
        if im.ndim == 2:
            im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
        if im.shape[2] == 3:
            im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
        al = im[:, :, 3:4].astype(np.float32) / 255.0
        bgr = (im[:, :, :3].astype(np.float32) * al + 128 * (1 - al)).astype(np.uint8)
        h, w = bgr.shape[:2]
        k = S / max(h, w)
        bgr = cv2.resize(bgr, (max(1, int(w * k)), max(1, int(h * k))), interpolation=cv2.INTER_AREA)
        out_im = np.full((S, S, 3), 128, np.uint8)
        y0, x0 = (S - bgr.shape[0]) // 2, (S - bgr.shape[1]) // 2
        out_im[y0:y0 + bgr.shape[0], x0:x0 + bgr.shape[1]] = bgr
        return out_im

    try:
        from PIL import Image, ImageDraw, ImageFont
        font = fontb = None
        for f in (r"C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                  "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
                  "/usr/share/fonts/noto/NotoSans-Regular.ttf"):
            if os.path.isfile(f):
                font = ImageFont.truetype(f, 22)
                fontb = ImageFont.truetype(f, 26)
                break
    except Exception:
        font = fontb = None
    for i, (name, rp, mp) in enumerate(cols):
        sheet[70:70 + S, i * S:(i + 1) * S] = cell(rp)
        sheet[70 + S:70 + 2 * S, i * S:(i + 1) * S] = cell(mp)
    rep = load(os.path.join(chk, "face_report.json"))
    title = "texture_check  %s/best  итерация %d  score %.1f  %s  (сверху референс, снизу модель)" % (
        os.path.basename(os.path.abspath(a.work)), best["iteration"], best["score"], "PASS" if rep.get("pass") else "FAIL")
    if font is not None:
        pil = Image.fromarray(cv2.cvtColor(sheet, cv2.COLOR_BGR2RGB))
        dr = ImageDraw.Draw(pil)
        dr.text((12, 8), title, fill=(255, 255, 255), font=fontb)
        for i, (name, _, _) in enumerate(cols):
            dr.text((i * S + 10, 44), name + " — референс", fill=(240, 240, 240), font=font)
            dr.text((i * S + 10, 70 + S + 6), name + " — модель", fill=(240, 240, 240), font=font)
        sheet = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    out_path = os.path.join(bdir, "texture_check.jpg")
    cv2.imwrite(out_path, sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])
    say("overview sheet: " + out_path)
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True)
    ap.add_argument("--refs", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--max-iter", type=int, default=8)
    ap.add_argument("--no-vlm", action="store_true")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--resume", action="store_true", help="continue by loop_state.json")
    ap.add_argument("--resume-from-best", action="store_true", help="continue starting from the best model (after editing the scripts)")
    ap.add_argument("--finalize-only", action="store_true")
    ap.add_argument("--body-refs", default=None)
    ap.add_argument("--blender", default=os.environ.get("HG_BLENDER") or os.environ.get("ASTRA_BLENDER") or BLENDER_DEFAULT)
    ap.add_argument("--plateau", type=int, default=2, help="stop if the score does not grow for this many iterations in a row")
    ap.add_argument("--thresholds", default=None, help="pass thresholds for face_match (JSON or a path to .json), see face_match.py --thresholds")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    LOG["fh"] = open(os.path.join(a.work, "face_loop.log"), "a", encoding="utf-8")
    state_path = os.path.join(a.work, "loop_state.json")
    state = {"start": os.path.abspath(a.start), "refs": os.path.abspath(a.refs), "score_history": [], "iterations": [], "best": None,
             "model": os.path.abspath(a.start), "next_iter": 1, "frame_report": None, "pass": False}
    if (a.resume or a.resume_from_best or a.finalize_only) and os.path.isfile(state_path):
        state = load(state_path)
        say("continuing: iteration %d, history %s" % (state["next_iter"], state["score_history"]))
        if a.resume_from_best and state.get("best"):
            state["model"] = state["best"]["model"]
            say("restarting from the best model (iteration %d, score %.1f): %s" % (state["best"]["iteration"], state["best"]["score"], state["model"]))
            state.setdefault("restarts", []).append({"at_iter": state["next_iter"], "from_best_iter": state["best"]["iteration"]})
    if a.finalize_only:
        finalize(a, state)
        return 0 if state.get("pass") else 1
    say("start: %s" % state["model"])
    say("references: %s" % a.refs)
    rc_final = 1
    i = state["next_iter"]
    while i <= a.max_iter:
        it_dir = os.path.join(a.work, "iter_%02d" % i)
        chk = os.path.join(it_dir, "check")
        os.makedirs(chk, exist_ok=True)
        say("=== ITERATION %d/%d: check %s" % (i, a.max_iter, os.path.basename(os.path.dirname(state["model"])) + "/" + os.path.basename(state["model"])))
        cmd = [PY, os.path.join(HERE, "face_match.py"), "--model", state["model"], "--refs", a.refs, "--out", chk, "--iteration", str(i), "--blender", a.blender]
        if a.no_vlm:
            cmd.append("--no-vlm")
        if a.strict:
            cmd.append("--strict")
        if a.thresholds:
            cmd += ["--thresholds", a.thresholds]
        if state.get("frame_report"):
            cmd += ["--frame-from", state["frame_report"]]
        rc = run(cmd, "face_match (iteration %d)" % i)
        rep_path = os.path.join(chk, "face_report.json")
        if rc == 2 or not os.path.isfile(rep_path):
            say("checker ERROR (code %s) - stop" % rc)
            save(state_path, state)
            return 2
        rep = load(rep_path)
        if os.path.isfile(os.path.join(chk, "face_report.jpg")):
            shutil.copy2(os.path.join(chk, "face_report.jpg"), os.path.join(it_dir, "face_report_iter_%02d.jpg" % i))
        score = float(rep.get("score", 0))
        say("iteration %d: %s" % (i, summarize(rep)))
        for d in (rep.get("defects") or [])[:12]:
            say("   [%s] %s" % (d.get("severity"), (d.get("instruction") or {}).get("text_ru")))
        if len(rep.get("defects") or []) > 12:
            say("   ... %d more" % (len(rep["defects"]) - 12))
        state["score_history"].append(score)
        state["iterations"].append({"iteration": i, "model": state["model"], "check_dir": chk, "score": score, "pass": bool(rep.get("pass")),
                                    "defects": len(rep.get("defects") or [])})
        if state["best"] is None or score > state["best"]["score"] or (rep.get("pass") and score >= state["best"]["score"]):
            state["best"] = {"iteration": i, "model": state["model"], "check_dir": chk, "score": score}
        if state.get("frame_report") is None:
            state["frame_report"] = rep_path   # iteration 1's frame - the contract for all the following
        state["next_iter"] = i + 1
        save(state_path, state)
        if rep.get("pass"):
            say("PASS at iteration %d - the face matches the reference on every threshold" % i)
            state["pass"] = True
            rc_final = 0
            break
        if i >= a.max_iter:
            say("iteration limit (%d) - pass not reached" % a.max_iter)
            break
        h = state["score_history"]
        if len(h) >= a.plateau + 1 and all(h[-k] <= h[-a.plateau - 1] for k in range(1, a.plateau + 1)):
            say("score not growing %d iterations in a row (%s) - stop for analysis (code 3); continue: --resume" % (a.plateau, h[-a.plateau - 1:]))
            save(state_path, state)
            return 3
        fix = os.path.join(it_dir, "fix")
        say("=== ITERATION %d: fix from %d instructions -> %s" % (i, len(rep.get("defects") or []), fix))
        rc = run([PY, os.path.join(HERE, "face_fix.py"), "--model", state["model"], "--report", rep_path, "--refs", a.refs, "--out", fix, "--blender", a.blender],
                 "face_fix (iteration %d)" % i)
        new_model = os.path.join(fix, "painted.blend")
        if rc != 0 or not os.path.isfile(new_model):
            say("executor ERROR (code %s) - stop" % rc)
            save(state_path, state)
            return 2
        state["model"] = new_model
        state["next_iter"] = i + 1
        save(state_path, state)
        i += 1
    save(state_path, state)
    say("score history: %s" % state["score_history"])
    finalize(a, state)
    save(state_path, state)
    return rc_final


if __name__ == "__main__":
    sys.exit(main())
