# -*- coding: utf-8 -*-
"""face_step - the forge steps "face_match" (the head-paint gate) and "face_fix_loop" (the check -> fix cycle).

Called from a Blender step (scripts/blender/steps/face_match.py and face_fix_loop.py -> run_match / run_loop)
or by itself, without Blender, over the same forge protocol (docs/FORGE-CONTRACT.md §3: result.json plus an
IMAGINARIUM_RESULT / IMAGINARIUM_ERROR line):

    python face_step.py run face_match <request.json>
    python face_step.py run face_fix_loop <request.json>
    python face_step.py summary <face_report.json> [--min-score N]   # a flat summary of the checker report (JSON)

The step itself is thin: it finds the model (inputs.blend | inputs.mesh) and the face reference folder
(params.refs_dir, otherwise face_refs/ next to the asset or the model), runs the checker face_match.py or
the cycle face_loop.py with an interpreter that has numpy / cv2 / scikit-image / scipy (params.python ->
IMAGINARIUM_QA_PYTHON -> the studio QA python), turns their output into IMAGINARIUM_LOG, and face_report.json /
loop_state.json into the forge outputs, stats and checks. Standard library only: the module is imported
under the Blender Python and under a system Python alike.

The report text (summary_ru, threshold notes, per-view Russian labels) is the report contract and stays
Russian: the forge review and the agent read those fields.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
# the interpreter with numpy/cv2/scikit-image/scipy: the owner's ComfyUI venv on Windows, the studio's own
# engine venv on Linux (same role, scripts/install downloads both)
DEFAULT_PYTHON = (r"D:\ComfyUI\.venv\Scripts\python.exe" if os.name == "nt"
                  else os.path.join(APP_DIR, "runtime", "ComfyUI", ".venv", "bin", "python"))
DEFAULT_BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"
REF_FILES = ("face_front_rgba.png", "face34_rgba.png", "face34_flip_rgba.png", "head_back_rgba.png")
THRESHOLD_KEYS = ("ssim_gray", "feature_mask_iou_min", "landmark_max_px_share", "diff_area_share_max", "silhouette_iou")
VIEW_RU = {"front": "анфас", "face34_left": "3/4 слева", "face34_right": "3/4 справа", "back": "затылок"}
MAX_INSTRUCTIONS = 12   # how many instructions make it into stats (the full list is in face_report.json)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:  # under Blender (imaginarium_run.py puts scripts/blender on sys.path) use the imaginarium_common protocol; otherwise our own minimum
    import imaginarium_common as ima
except Exception:  # pragma: no cover
    af = None

T0 = time.time()


# ----------------------------------------------------------------------------------------------- protocol
def log(msg, **data):
    if af is not None:
        ima.log(msg, **data)
        return
    payload = {"t": round(time.time() - T0, 2), "msg": str(msg)}
    payload.update(data)
    print("IMAGINARIUM_LOG " + json.dumps(payload, ensure_ascii=False), flush=True)


def check(name, ok, value=None, limit=None, severity="error", note=None):
    item = {"name": name, "ok": bool(ok), "value": value, "limit": limit, "severity": severity}
    if note:
        item["note"] = note
    return item


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ----------------------------------------------------------------------------------------------- report
def view_failed(metrics, thresholds, is_back):
    """Which thresholds a view did not pass (the same logic as face_match.view_pass without strict)."""
    t = dict(zip(THRESHOLD_KEYS, (0.85, 0.80, 0.02, 0.01, 0.93)))
    t.update({k: v for k, v in (thresholds or {}).items() if isinstance(v, (int, float))})
    m = metrics or {}
    failed = []

    def num(key):
        v = m.get(key)
        return v if isinstance(v, (int, float)) else None

    if num("ssim_gray") is not None and num("ssim_gray") < t["ssim_gray"]:
        failed.append("ssim_gray")
    if num("silhouette_iou") is not None and num("silhouette_iou") < t["silhouette_iou"]:
        failed.append("silhouette_iou")
    if num("diff_area_share") is not None and num("diff_area_share") > t["diff_area_share_max"]:
        failed.append("diff_area_share_max")
    fmi = [v for v in (m.get("feature_mask_iou") or {}).values() if isinstance(v, (int, float))]
    if fmi and min(fmi) < t["feature_mask_iou_min"]:
        failed.append("feature_mask_iou_min")
    if not is_back and num("landmark_max_share") is not None and num("landmark_max_share") > t["landmark_max_px_share"]:
        failed.append("landmark_max_px_share")
    return failed


def parse_report(rep):
    """face_report.json -> a flat summary: score, pass, views with failed thresholds, defects by severity, instructions."""
    if not isinstance(rep, dict):
        raise ValueError("face_report.json: an object is expected")
    error = rep.get("error")
    thresholds = rep.get("thresholds") if isinstance(rep.get("thresholds"), dict) else {}
    views = {}
    for name, v in (rep.get("views") or {}).items():
        if not isinstance(v, dict):
            continue
        m = v.get("metrics") or {}
        fmi = [x for x in (m.get("feature_mask_iou") or {}).values() if isinstance(x, (int, float))]
        views[name] = {
            "ru": VIEW_RU.get(name, name),
            "score": float(v.get("score") or 0.0),
            "pass": bool(v.get("pass")),
            "ssim_gray": m.get("ssim_gray"),
            "silhouette_iou": m.get("silhouette_iou"),
            "diff_area_share": m.get("diff_area_share"),
            "landmark_max_share": m.get("landmark_max_share"),
            "feature_mask_iou_min": min(fmi) if fmi else None,
            "failed": view_failed(m, thresholds, name == "back"),
            "vlm_no": sorted(k for k, b in (m.get("vlm") or {}).items() if b is False),
        }
    defects = [d for d in (rep.get("defects") or []) if isinstance(d, dict)]
    sev = {k: sum(1 for d in defects if d.get("severity") == k) for k in ("blocker", "major", "minor")}
    sev["total"] = len(defects)
    instructions = []
    for d in defects:
        ins = d.get("instruction") or {}
        instructions.append({"id": d.get("id"), "view": d.get("view"), "zone": d.get("zone"), "kind": d.get("kind"),
                             "severity": d.get("severity"), "action": ins.get("action"), "text_ru": ins.get("text_ru")})
    vlm = rep.get("vlm") if isinstance(rep.get("vlm"), dict) else {}
    s = {
        "ok": error is None,
        "error": error,
        "score": float(rep.get("score") or 0.0),
        "pass": bool(rep.get("pass")),
        "iteration": rep.get("iteration"),
        "model": rep.get("model"),
        "reference_set": rep.get("reference_set"),
        "thresholds": thresholds,
        "views": views,
        "defects": sev,
        "blocking": sev["blocker"] + sev["major"],
        "instructions": instructions,
        "sheet": rep.get("sheet"),
        "vlm_used": bool(vlm.get("used")),
        "seconds": rep.get("seconds"),
    }
    s["summary_ru"] = summary_ru(s)
    return s


def summary_ru(s):
    if s.get("error"):
        return "ошибка проверяльщика: %s" % s["error"]
    d = s["defects"]
    per = ", ".join("%s %.1f" % (v["ru"], v["score"]) for v in s["views"].values())
    failed = "; ".join("%s — %s" % (v["ru"], ", ".join(v["failed"])) for v in s["views"].values() if v["failed"])
    text = "score %.1f  %s  дефектов %d (blocker %d, major %d, minor %d)  [%s]" % (
        s["score"], "PASS" if s["pass"] else "FAIL", d["total"], d["blocker"], d["major"], d["minor"], per)
    if failed:
        text += "  не по порогам: " + failed
    return text


def pass_check(s, name, gate=True, min_score=None):
    """The forge check: pass by thresholds or a score not below min_score; severity error - a gate, warning - a report only."""
    enough = min_score is not None and s["score"] >= float(min_score)
    ok = bool(s["pass"]) or enough
    if s.get("error"):
        ok, note = False, "ошибка проверяльщика: %s" % s["error"]
    elif s["pass"]:
        note = "лицо совпадает с референсом по всем порогам"
    elif enough:
        note = "pass не достигнут, но балл %.1f не ниже достаточного %.1f" % (s["score"], float(min_score))
    else:
        note = "лицо не совпадает с референсом: " + s["summary_ru"]
    return check(name, ok, {"score": s["score"], "pass": s["pass"], "blocking": s["blocking"], "defects": s["defects"]["total"]},
                 {"min_score": min_score, "thresholds": s["thresholds"]}, "error" if gate else "warning", note)


# ----------------------------------------------------------------------------------------------- step input
def model_path(req):
    inputs = req.get("inputs") or {}
    model = inputs.get("blend") or inputs.get("mesh") or inputs.get("glb")
    if not model:
        raise RuntimeError("The step needs a model: inputs.blend or inputs.mesh (GLB) of the previous step.")
    model = os.path.abspath(model)
    if not os.path.isfile(model):
        raise FileNotFoundError("model not found: %s" % model)
    if os.path.splitext(model)[1].lower() not in (".blend", ".glb", ".gltf"):
        raise RuntimeError("The face check accepts .blend or GLB, got: %s" % model)
    return model


def refs_candidates(req, model):
    p = req.get("params") or {}
    inputs = req.get("inputs") or {}
    out_dir = os.path.abspath(req.get("out_dir") or ".")
    asset_dir = os.path.dirname(os.path.dirname(out_dir))   # <library>/assets/<id>/<version>/<NN_step> -> the asset
    cands = []
    for c in (p.get("refs_dir"), inputs.get("face_refs"), os.path.join(asset_dir, "face_refs"),
              os.path.join(os.path.dirname(model), "face_refs"), os.path.join(os.path.dirname(os.path.dirname(model)), "face_refs")):
        if c and os.path.abspath(c) not in cands:
            cands.append(os.path.abspath(c))
    return cands


def resolve_refs(req, model):
    """The face reference folder: the front face_front_rgba.png is mandatory, the other views are optional
    (the checker skips a missing one)."""
    cands = refs_candidates(req, model)
    for c in cands:
        if os.path.isfile(os.path.join(c, REF_FILES[0])):
            missing = [f for f in REF_FILES if not os.path.isfile(os.path.join(c, f))]
            return c, missing
    explicit = (req.get("params") or {}).get("refs_dir")
    if explicit:
        raise RuntimeError("refs_dir has no %s, which the face reference folder requires: %s" % (REF_FILES[0], explicit))
    raise RuntimeError("A face reference folder is required (%s - head close-ups on a transparent background): "
                       "the refs_dir parameter (a path, CLI --direct / request.json only) or a face_refs/ folder in one of: %s"
                       % (", ".join(REF_FILES), "; ".join(cands)))


def resolve_python(p):
    py = p.get("python") or os.environ.get("IMAGINARIUM_QA_PYTHON") or DEFAULT_PYTHON
    if not os.path.isfile(py):
        raise RuntimeError("The face-check Python was not found (%s): an interpreter with numpy, cv2, scikit-image, scipy, "
                           "Pillow is needed - params.python, IMAGINARIUM_QA_PYTHON or %s" % (py, DEFAULT_PYTHON))
    return py


def resolve_blender(p):
    if p.get("blender") and os.path.isfile(p["blender"]):
        return p["blender"]
    try:
        import bpy  # noqa: F401  - the same Blender that runs the step
        if os.path.isfile(bpy.app.binary_path):
            return bpy.app.binary_path
    except Exception:
        pass
    for key in ("IMAGINARIUM_BLENDER", "HG_BLENDER", "Imaginarium_BLENDER"):
        if os.environ.get(key) and os.path.isfile(os.environ[key]):
            return os.environ[key]
    return DEFAULT_BLENDER


def vlm_args(p):
    mode = p.get("vlm", "auto")
    args = []
    if mode == "off":
        args.append("--no-vlm")
    elif mode == "strict":
        args.append("--strict")
    if p.get("vlm_model"):
        args += ["--vlm-model", str(p["vlm_model"])]
    return args


def thresholds_args(p):
    t = p.get("thresholds")
    if not t:
        return []
    if not isinstance(t, dict):
        raise RuntimeError("params.thresholds is an object {threshold: number 0..1}")
    bad = [k for k in t if k not in THRESHOLD_KEYS]
    if bad:
        raise RuntimeError("unknown thresholds %s; allowed: %s" % (bad, ", ".join(THRESHOLD_KEYS)))
    return ["--thresholds", json.dumps(t)]


ITER_RE = re.compile(r"=== ITERATION (\d+)/(\d+)")


def run_streaming(cmd, label):
    """Run with live output: the checker/cycle lines go into IMAGINARIUM_LOG (the step message in the studio), the rest - into the log."""
    log("%s: %s" % (label, " ".join(os.path.basename(c) if os.sep in str(c) else str(c) for c in cmd[:2])))
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", PYTHONUNBUFFERED="1")
    p = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=HERE)
    tail = []
    for raw in iter(p.stdout.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip()
        if not line:
            continue
        tail = (tail + [line])[-25:]
        m = ITER_RE.search(line)
        if m:
            done, total = int(m.group(1)) - 1, int(m.group(2))
            log(line.split("]", 1)[-1].strip(), done=done, total=total)
        elif line.startswith("[face_match]") or line.startswith("[face_loop"):
            log(line.split("]", 1)[-1].strip())
        else:
            print(line, flush=True)
    p.wait()
    return p.returncode, tail


# ----------------------------------------------------------------------------------------------- steps
def run_match(req):
    """The face_match step: one checker run, the gate by pass / min_score."""
    p = req.get("params") or {}
    model = model_path(req)
    refs, missing = resolve_refs(req, model)
    out_dir = os.path.abspath(req["out_dir"])
    work = os.path.join(out_dir, "face_match")
    os.makedirs(work, exist_ok=True)
    warnings = []
    if missing:
        warnings.append("References %s are missing - those views are skipped." % ", ".join(missing))
    py, blender = resolve_python(p), resolve_blender(p)
    cmd = [py, os.path.join(HERE, "face_match.py"), "--model", model, "--refs", refs, "--out", work,
           "--iteration", str(int(p.get("iteration", 0) or 0)), "--blender", blender] + vlm_args(p) + thresholds_args(p)
    if p.get("frame_from"):
        cmd += ["--frame-from", os.path.abspath(p["frame_from"])]
    log("face check: %s against %s" % (os.path.basename(model), refs))
    rc, tail = run_streaming(cmd, "face_match")
    rep_path = os.path.join(work, "face_report.json")
    if not os.path.isfile(rep_path):
        raise RuntimeError("The face checker left no face_report.json (code %s): %s" % (rc, "\n".join(tail[-8:])))
    s = parse_report(load_json(rep_path))
    if s["error"]:
        raise RuntimeError("The face checker finished with an error (code %s): %s" % (rc, s["error"]))
    gate = bool(p.get("gate", True))
    min_score = p.get("min_score")
    chk = pass_check(s, "face_match_pass", gate, min_score)
    if not chk["ok"] and not gate:
        warnings.append(chk["note"])
    log("result: " + s["summary_ru"])
    outputs = {"face_report": rep_path, "face_match_dir": work}
    if s["sheet"] and os.path.isfile(s["sheet"]):
        outputs["face_report_jpg"] = s["sheet"]
    result = {"outputs": outputs, "stats": stats_of(s, rc, py), "checks": [chk], "warnings": warnings}
    if gate and not chk["ok"]:
        result["error"] = "the face does not match the reference - %s; the instructions are in %s" % (s["summary_ru"], rep_path)
    return result


def stats_of(s, rc, py):
    return {"score": s["score"], "pass": s["pass"], "iteration": s["iteration"], "blocking": s["blocking"], "defects": s["defects"],
            "views": {k: {"score": v["score"], "pass": v["pass"], "failed": v["failed"], "vlm_no": v["vlm_no"]} for k, v in s["views"].items()},
            "instructions": [i["text_ru"] for i in s["instructions"][:MAX_INSTRUCTIONS]],
            "instructions_total": len(s["instructions"]), "thresholds": s["thresholds"], "vlm_used": s["vlm_used"],
            "check_seconds": s["seconds"], "exit_code": rc, "python": py}


def run_loop(req):
    """The face_fix_loop step: face_loop.py until pass / the limit / a plateau; the best model continues the pipeline."""
    p = req.get("params") or {}
    model = model_path(req)
    refs, missing = resolve_refs(req, model)
    out_dir = os.path.abspath(req["out_dir"])
    work = os.path.join(out_dir, "face_loop")
    os.makedirs(work, exist_ok=True)
    warnings = []
    if missing:
        warnings.append("References %s are missing - those views are skipped." % ", ".join(missing))
    py, blender = resolve_python(p), resolve_blender(p)
    max_iter = int(p.get("max_iter", 6) or 6)
    cmd = [py, os.path.join(HERE, "face_loop.py"), "--start", model, "--refs", refs, "--work", work,
           "--max-iter", str(max_iter), "--plateau", str(int(p.get("plateau", 2) or 2)), "--blender", blender] + vlm_args(p) + thresholds_args(p)
    if p.get("body_refs_dir"):
        cmd += ["--body-refs", os.path.abspath(p["body_refs_dir"])]
    if os.path.isfile(os.path.join(work, "loop_state.json")):
        cmd.append("--resume")   # a repeated step in the same folder continues the cycle instead of restarting
    log("face fix: %s, up to %d iterations, references %s" % (os.path.basename(model), max_iter, refs))
    rc, tail = run_streaming(cmd, "face_loop")
    state_path = os.path.join(work, "loop_state.json")
    if not os.path.isfile(state_path):
        raise RuntimeError("The face fix cycle left no loop_state.json (code %s): %s" % (rc, "\n".join(tail[-8:])))
    state = load_json(state_path)
    best = state.get("best")
    if rc == 2 or not best:
        raise RuntimeError("The face fix cycle was interrupted by an error (code %s): %s" % (rc, "\n".join(tail[-8:])))
    best_dir = os.path.join(work, "best")
    blend = os.path.join(best_dir, "painted.blend")
    if not os.path.isfile(blend):
        blend = best["model"]
        warnings.append("The best model was not copied into best/ - %s continues the pipeline" % blend)
    glbs = sorted(f for f in os.listdir(best_dir) if f.lower().endswith(".glb")) if os.path.isdir(best_dir) else []
    rep_path = os.path.join(best_dir, "face_report.json")
    if not os.path.isfile(rep_path):
        rep_path = os.path.join(best["check_dir"], "face_report.json")
    s = parse_report(load_json(rep_path))
    require_pass = bool(p.get("require_pass", False))
    chk = pass_check(s, "face_loop_pass", require_pass, p.get("min_score"))
    history = [float(x) for x in state.get("score_history") or []]
    if rc == 3:
        warnings.append("The score has not grown for %s iterations in a row (%s) - the cycle stopped at a plateau." % (p.get("plateau", 2), history[-3:]))
    if not s["pass"]:
        warnings.append("pass was not reached in %d iterations; the best is iteration %d, score %.1f%s" % (
            len(state.get("iterations") or []), best["iteration"], best["score"], "" if chk["ok"] else "; " + chk["note"]))
    log("result: iteration %d is the best, %s" % (best["iteration"], s["summary_ru"]))
    outputs = {"blend": blend, "face_report": rep_path, "loop_state": state_path, "loop_dir": work}
    if glbs:
        outputs["glb"] = os.path.join(best_dir, glbs[0])
    for key, name in (("face_report_jpg", "face_report.jpg"), ("texture_check", "texture_check.jpg")):
        if os.path.isfile(os.path.join(best_dir, name)):
            outputs[key] = os.path.join(best_dir, name)
    if os.path.isfile(os.path.join(work, "face_loop.log")):
        outputs["loop_log"] = os.path.join(work, "face_loop.log")
    stats = stats_of(s, rc, py)
    stats.update({"iterations": len(state.get("iterations") or []), "score_history": history, "best_iteration": best["iteration"],
                  "plateau": rc == 3, "restarts": len(state.get("restarts") or [])})
    result = {"outputs": outputs, "stats": stats, "checks": [chk], "warnings": warnings}
    if require_pass and not chk["ok"]:
        result["error"] = "the face was not brought to the reference in %d iterations - %s" % (max_iter, s["summary_ru"])
    return result


STEPS = {"face_match": run_match, "face_fix_loop": run_loop}


# ----------------------------------------------------------------------------------------------- CLI
def _finish(req, result, step):
    res = {"ok": True, "step": step, "outputs": {}, "stats": {}, "checks": [], "warnings": []}
    res.update(result or {})
    failed = [c for c in res["checks"] if not c.get("ok") and c.get("severity", "error") == "error"]
    if failed:
        res["ok"] = False
        res.setdefault("error", "checks failed: " + ", ".join(c["name"] for c in failed))
    res["seconds"] = round(time.time() - T0, 2)
    os.makedirs(req["out_dir"], exist_ok=True)
    with open(os.path.join(req["out_dir"], "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=2)
    print("IMAGINARIUM_RESULT " + json.dumps(res, ensure_ascii=False), flush=True)
    return res


def main(argv):
    if len(argv) >= 3 and argv[0] == "run":
        step, req_path = argv[1], argv[2]
        if step not in STEPS:
            print("unknown step %r; available: %s" % (step, ", ".join(STEPS)), file=sys.stderr)
            return 2
        req = load_json(req_path)
        req.setdefault("step", step)
        req.setdefault("out_dir", os.path.join(os.path.dirname(os.path.abspath(req_path)), "out"))
        try:
            res = _finish(req, STEPS[step](req), step)
        except Exception as exc:
            import traceback
            payload = {"step": step, "error": "%s: %s" % (type(exc).__name__, exc), "trace": traceback.format_exc()[-6000:]}
            try:
                os.makedirs(req["out_dir"], exist_ok=True)
                with open(os.path.join(req["out_dir"], "result.json"), "w", encoding="utf-8") as fh:
                    json.dump(dict(payload, ok=False), fh, ensure_ascii=False, indent=2)
            finally:
                print("IMAGINARIUM_ERROR " + json.dumps(payload, ensure_ascii=False), flush=True)
            return 1
        return 0 if res.get("ok") else 1
    if len(argv) >= 2 and argv[0] == "summary":
        min_score = None
        if "--min-score" in argv:
            min_score = float(argv[argv.index("--min-score") + 1])
        s = parse_report(load_json(argv[1]))
        s["check"] = pass_check(s, "face_match_pass", True, min_score)
        print(json.dumps(s, ensure_ascii=False, indent=1))
        return 0 if s["check"]["ok"] else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
