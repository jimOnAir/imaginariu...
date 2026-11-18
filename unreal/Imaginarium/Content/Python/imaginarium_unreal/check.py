"""check - verifies an imported Imaginarium package against its manifest: the report says what
the import attempted, this says what actually exists in the project. Used by
scripts/engines/imaginarium_engine.mjs test (UnrealEditor-Cmd -run=pythonscript). Unverified by design on
this machine (no Unreal Editor): docs/product/unreal.md."""
import json
import os


def check_package(json_path):
    import unreal  # engine-only, imported lazily so the module file parses anywhere
    import imaginarium_unreal as au

    man = au.load_manifest(json_path)
    pkg_dir = os.path.dirname(os.path.abspath(json_path))
    dest = "%s/%s" % (au.CONTENT_ROOT, man["asset"]["id"])

    def exists(path):
        return bool(unreal.EditorAssetLibrary.does_asset_exist(path))

    rows = [{"what": "main mesh", "path": "%s/%s" % (dest, man["main"]["mesh"]), "ok": exists("%s/%s" % (dest, man["main"]["mesh"]))},
            {"what": "master material", "path": "%s/%s" % (dest, au.MASTER_MATERIAL), "ok": exists("%s/%s" % (dest, au.MASTER_MATERIAL))},
            {"what": "actor blueprint", "path": "%s/Blueprints/%s" % (dest, man["actor_blueprint"]),
             "ok": exists("%s/Blueprints/%s" % (dest, man["actor_blueprint"]))}]
    for m in man["materials"]:
        rows.append({"what": "material instance", "path": "%s/Materials/%s" % (dest, m["name"]),
                     "ok": exists("%s/Materials/%s" % (dest, m["name"]))})
    report_path = os.path.join(pkg_dir, "import_report.json")
    report = None
    if os.path.isfile(report_path):
        with open(report_path, "r", encoding="utf-8") as fh:
            report = json.load(fh)
    skipped = [s for s in (report or {}).get("steps", []) if not s.get("ok")]
    out = {"ok": all(r["ok"] for r in rows), "rows": rows, "import_skipped": skipped,
           "unverified_note": "the in-editor pass is proven wherever an Unreal Editor runs; the Linux studio proves the package contract"}
    with open(os.path.join(pkg_dir, "unreal_check.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    return out
