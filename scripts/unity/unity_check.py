"""Validate Imaginarium Unity packages in the studio's check project (one Unity -batchmode run for all).

    python3 scripts/unity/unity_check.py <package dir> [<package dir> ...] [--out <folder>] [--unity <Unity>]
                                         [--project <check project>] [--pipeline urp|builtin|hdrp]

A package dir holds ima_unity.json (the output of the unity_package step). Prints a short table and writes
<out>/_unity_check/unity_report.json, screenshots to <out>/unity_shots/ (contact_sheet.png). Exit 1 on a failed check.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender", "steps"))
import _unity_lib as ul  # noqa: E402


def main(argv):
    pkgs, params, out = [], {}, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--out", "--unity", "--project", "--pipeline") and i + 1 < len(argv):
            if a == "--out":
                out = argv[i + 1]
            else:
                params[{"--unity": "unity", "--project": "unity_project", "--pipeline": "unity_pipeline"}[a]] = argv[i + 1]
            i += 2
            continue
        pkgs.append(a)
        i += 1
    items = []
    for d in pkgs:
        with open(os.path.join(d, "ima_unity.json"), "r", encoding="utf-8") as fh:
            items.append((json.load(fh)["asset_id"], os.path.abspath(d)))
    out = os.path.abspath(out or os.path.join(os.getcwd(), "unity_check_out"))
    os.makedirs(out, exist_ok=True)
    rep = ul.validate(items, out, params)
    print("Unity %s, %s s, log %s" % (rep.get("unity"), rep.get("seconds"), rep.get("log")))
    if rep.get("error"):
        print("ERROR:", rep["error"])
    for a in ((rep.get("result") or {}).get("assets") or []):
        print("%s %s" % ("OK  " if a["ok"] else "FAIL", a["asset_id"] or a["folder"]))
        for c in a["checks"]:
            print("   %s %-22s %s" % ("+" if c["ok"] else ("!" if c["severity"] != "error" else "x"), c["name"], (c["value"] or "")[:150]))
    for e in rep.get("engine_errors") or []:
        print("  log:", e[:200])
    if rep.get("shots"):
        print("shots:", rep["shots"])
    return 0 if rep.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
