"""Unity side of the export module: find the editor, keep the check project, run batchmode validation.

The check project (URP; by default C:/Imaginarium/unity/ImaginariumUnityCheck on Windows and
<data>/unity/ImaginariumUnityCheck next to the studio elsewhere) references the importer package
unity/dev.imaginarium3d.unity of this repository by a file: path, so it always runs the current importer code.
A validation copies the packages into Assets/Imaginarium/<asset_id>/ of that project and runs
Imaginarium.Editor.ImaginariumBatch.Validate in `Unity -batchmode`; the method writes a JSON report and screenshots.
Nothing is written to any other Unity project here (the send command does that on an explicit request).
"""
import glob
import json
import os
import re
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))          # scripts/blender/steps -> APP
UNITY_PACKAGE_DIR = os.path.join(APP_DIR, "unity", "dev.imaginarium3d.unity")
# Unity Hub installs editors here: on Windows under Program Files, on Linux in the home folder
HUB_EDITORS = r"C:/Program Files/Unity/Hub/Editor" if os.name == "nt" else os.path.expanduser("~/Unity/Hub/Editor")
UNITY_EXE_NAME = "Unity.exe" if os.name == "nt" else "Unity"
UNITY_DEFAULT_VERSION = "6000.0.64f1"
# the same default as the MCP unity_status tool (server lives in ai/mcp/server.mjs)
CHECK_PROJECT_DEFAULT = (r"C:/Imaginarium/unity/ImaginariumUnityCheck" if os.name == "nt"
                         else os.path.join(APP_DIR, "data", "unity", "ImaginariumUnityCheck"))
URP_VERSION = "17.0.4"                     # URP of Unity 6000.0 LTS (same as the owner's projects)
LOCK_NAME = ".imaginarium_unity_check.lock"


def find_unity(params=None):
    """The editor executable: params.unity, IMAGINARIUM_UNITY, the default LTS under Unity Hub, else the newest 6000.x."""
    params = params or {}
    for cand in (params.get("unity"), os.environ.get("IMAGINARIUM_UNITY"),
                 os.path.join(HUB_EDITORS, UNITY_DEFAULT_VERSION, "Editor", UNITY_EXE_NAME)):
        if cand and os.path.isfile(cand):
            return cand
    found = sorted(glob.glob(os.path.join(HUB_EDITORS, "6000.*", "Editor", UNITY_EXE_NAME)), reverse=True)
    return found[0] if found else None


def unity_version(exe):
    m = re.search(r"[\\/](\d{4}\.\d+\.\d+[a-z]\d+)[\\/]", exe or "")
    return m.group(1) if m else None


def check_project(params=None):
    params = params or {}
    return os.path.abspath(params.get("unity_project") or os.environ.get("IMAGINARIUM_UNITY_PROJECT")
                           or CHECK_PROJECT_DEFAULT)


def _file_url(path):
    return "file:" + os.path.abspath(path).replace("\\", "/")


def write_manifest(proj, pipeline="urp"):
    """Packages/manifest.json of the check project: URP (or none) + the importer by file: path."""
    path = os.path.join(proj, "Packages", "manifest.json")
    data = {"dependencies": {}}
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    deps = data.setdefault("dependencies", {})
    deps["dev.imaginarium3d.unity"] = _file_url(UNITY_PACKAGE_DIR)
    if pipeline == "urp":
        deps.setdefault("com.unity.render-pipelines.universal", URP_VERSION)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=2)
    return path


def run_unity(exe, proj, args, log_path, timeout=1800, create=False):
    """Unity -batchmode (with graphics: screenshots need the GPU). Returns (exit code, log text, seconds)."""
    cmd = [exe, "-batchmode", "-logFile", log_path]
    cmd += ["-createProject", proj] if create else ["-projectPath", proj]
    cmd += list(args)
    t0 = time.time()
    try:
        cp = subprocess.run(cmd, capture_output=True, timeout=timeout)
        code = cp.returncode
    except subprocess.TimeoutExpired:
        code = -1
    text = ""
    if os.path.isfile(log_path):
        with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    if code == -1:
        text += "\nTIMEOUT after %ss" % timeout
    return code, text, round(time.time() - t0, 1)


LICENSE_RE = re.compile(r"No valid Unity Editor license|Please activate your license|com\.unity\.editor\.headless")


def license_problem(log_text):
    return bool(LICENSE_RE.search(log_text or ""))


def project_template(exe, pipeline):
    """Offline project template shipped with the editor: URP = 'Universal 3D' (3d-cross-platform),
    HDRP = 3d-high-end; Built-in = an empty project (None)."""
    name = {"urp": "com.unity.template.3d-cross-platform-*.tgz",
            "hdrp": "com.unity.template.3d-high-end-*.tgz"}.get(pipeline)
    if not name or not exe:
        return None
    tdir = os.path.join(os.path.dirname(exe), "Data", "Resources", "PackageManager", "ProjectTemplates")
    found = sorted(glob.glob(os.path.join(tdir, name)), reverse=True)
    return found[0] if found else None


def ensure_project(exe, proj, log_dir, pipeline="urp"):
    """Create the check project once (createProject from the editor's offline URP template + the importer in
    manifest.json + ImaginariumSetup.ConfigureCheckProject). Returns {ok, created, error, log}."""
    os.makedirs(log_dir, exist_ok=True)
    marker = os.path.join(proj, "ProjectSettings", "imaginarium_check_project.json")
    if os.path.isfile(marker):
        write_manifest(proj, pipeline)        # keep the file: path current (the repo may have moved)
        return {"ok": True, "created": False}
    if not os.path.isfile(os.path.join(proj, "ProjectSettings", "ProjectVersion.txt")):
        tpl = project_template(exe, pipeline)
        code, text, _sec = run_unity(exe, proj, (["-cloneFromTemplate", tpl] if tpl else []) + ["-quit"],
                                     os.path.join(log_dir, "create.log"), create=True)
        if license_problem(text):
            return {"ok": False, "error": "license", "log": os.path.join(log_dir, "create.log")}
        if not os.path.isfile(os.path.join(proj, "ProjectSettings", "ProjectVersion.txt")):
            return {"ok": False, "error": "createProject failed (exit %s)" % code,
                    "log": os.path.join(log_dir, "create.log")}
    write_manifest(proj, pipeline)
    log = os.path.join(log_dir, "setup.log")
    code, text, _sec = run_unity(exe, proj, ["-executeMethod", "Imaginarium.Editor.ImaginariumSetup.ConfigureCheckProject",
                                             "-afPipeline", pipeline, "-quit"], log)
    if license_problem(text):
        return {"ok": False, "error": "license", "log": log}
    if code != 0 or "AFSETUP ok" not in text:
        return {"ok": False, "error": "setup failed (exit %s)" % code, "log": log}
    with open(marker, "w", encoding="utf-8") as fh:
        json.dump({"pipeline": pipeline, "unity": unity_version(exe), "created": time.strftime("%Y-%m-%d %H:%M:%S")},
                  fh, indent=1)
    return {"ok": True, "created": True, "log": log}


class ProjectLock:
    """One batchmode Unity per check project at a time (Unity refuses a project that is already open)."""

    def __init__(self, proj, timeout=1800):
        self.path = os.path.join(proj, LOCK_NAME)
        self.timeout = timeout

    def __enter__(self):
        t0 = time.time()
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                if time.time() - os.path.getmtime(self.path) > self.timeout:
                    os.remove(self.path)       # stale lock of a crashed run
                    continue
                if time.time() - t0 > self.timeout:
                    raise TimeoutError("Unity check project is busy: %s" % self.path)
                time.sleep(2)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass


def project_open_in_editor(proj):
    """Temp/UnityLockfile is held while an editor has the project open."""
    lf = os.path.join(proj, "Temp", "UnityLockfile")
    if not os.path.isfile(lf):
        return False
    try:
        os.remove(lf)                        # succeeds only when no editor holds it
        return False
    except OSError:
        return True


def validate(packages, out_dir, params=None, timeout=1800):
    """Copy package folders into the check project and run ImaginariumBatch.Validate once for all of them.

    packages: [(asset_id, package_dir)]. Returns {ok, result, log, seconds, unity, error, shots}."""
    params = params or {}
    exe = find_unity(params)
    if exe is None:
        return {"ok": False, "error": "unity_missing"}
    proj = check_project(params)
    pipeline = params.get("unity_pipeline", "urp")
    log_dir = os.path.join(out_dir, "_unity_check")
    os.makedirs(log_dir, exist_ok=True)
    os.makedirs(proj, exist_ok=True)
    with ProjectLock(proj, timeout):
        if project_open_in_editor(proj):
            return {"ok": False, "error": "project_open", "project": proj}
        prep = ensure_project(exe, proj, log_dir, pipeline)
        if not prep["ok"]:
            return {"ok": False, "error": prep["error"], "log": prep.get("log"), "unity": unity_version(exe)}
        rels = []
        for asset_id, src in packages:
            dst = os.path.join(proj, "Assets", "Imaginarium", asset_id)
            if os.path.isdir(dst):
                shutil.rmtree(dst)
            # Unity keeps the .meta of a removed folder's assets only when the folder stays; a clean copy
            # re-imports everything with the importer settings of this package
            meta = dst + ".meta"
            if os.path.isfile(meta):
                os.remove(meta)
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("_unity_check", "*.meta"))
            rels.append("Assets/Imaginarium/%s" % asset_id)
        report = os.path.join(log_dir, "unity_report.json")
        shots = os.path.join(out_dir, "unity_shots")
        if os.path.isfile(report):
            os.remove(report)
        log = os.path.join(log_dir, "validate.log")
        code, text, sec = run_unity(exe, proj, ["-executeMethod", "Imaginarium.Editor.ImaginariumBatch.Validate",
                                                "-afPackages", ";".join(rels), "-afReport", report,
                                                "-afShots", shots, "-quit"], log, timeout=timeout)
    if license_problem(text):
        return {"ok": False, "error": "license", "log": log, "unity": unity_version(exe)}
    result = None
    if os.path.isfile(report):
        with open(report, "r", encoding="utf-8-sig") as fh:
            result = json.load(fh)
    errors = [ln.strip() for ln in text.splitlines()
              if re.search(r"error CS\d+|Shader error|NullReferenceException|Exception:", ln)][:20]
    return {"ok": bool(result) and bool(result.get("ok")), "result": result, "exit": code, "log": log,
            "seconds": sec, "unity": unity_version(exe), "project": proj, "engine_errors": errors,
            "shots": shots if os.path.isdir(shots) else None,
            "error": None if result else "no report (exit %s)" % code}
