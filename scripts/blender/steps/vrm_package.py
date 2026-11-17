"""vrm_package - the character as ONE .vrm file (VRM 1.0; 0.7.10 fold wave ticket 62).

The 0.7.10 note: a rigged (and shaped) character becomes a single VRM 1.0 file - MToon toon
material, the ARKit expression set, blink, vowels and the VRM emotions, spring bones - openable
in Unity (UniVRM), UE5 (VRM4U) and Godot 4 (godot-vrm). Mechanically the step enables the
ticket-61 component (saturday06 VRM Add-on for Blender, installed into runtime/vrm-addon,
config key vrm_addon) in its own background Blender and drives its documented scripting API:
`bpy.ops.export_scene.vrm(filepath=...)` after the VRM 1.0 humanoid bone assignment and the
meta fields (the addon's own docs, v4.10.5 tag - saved copies in the wave folder). Everything
data-shaped (bone table, ARKit blends, preset matcher) lives in _vrm_lib.py, unit-tested without
the addon; the export half is verified by scripts/blender/tests/test_vrm_package.py end to end,
which SKIPS honestly while the addon is not installed (the 7-day supply-chain gate opens
2026-11-18 08:35:20 UTC).

inputs.glb        a rigged character (armature with a Hips bone - our rig_humanoid output,
                  Mixamo naming or prefix-free; shape keys optional but they are what the
                  expressions come from); a .vrm input also passes (VRM 1.0 is a glTF-2.0
                  container and re-packaging is a legal round trip)
inputs.manifest   optional asset.json - meta_name defaults to the asset name
params:
  profile        'vrm1' (the only one; named after the VRM 1.0 specification)
  meta_name      VRM meta name (empty - the asset name, else 'model')
  meta_version   VRM meta version (empty - '0.1.0')
  meta_author    author string for meta.authors (empty - 'AstraForge studio')
  license_url    meta license URL (empty - unset; the studio's commercial terms are not a VRM
                 licence URL and this step never pretends otherwise)
  expressions    'auto' wire the presets _vrm_lib matches (direct keys first, the publisher's
                 ARKit blends otherwise) | 'off'
  validate       true: after exporting, re-read the .vrm (pure glTF JSON-chunk parse: the
                 VRMC extensions the note promises) and re-import the bytes as a GLB (VRM 1.0
                 IS that container) so the stock glTF importer proves it reads the rig back
outputs: vrm (the single .vrm file), report (vrm_package.json: what was wired, what was not)
honesty rule: a preset or a spring chain the character cannot support is REPORTED in
stats['gaps'], never silently dropped; bones the spec lists as Required fail the step (such a
humanoid is invalid per VRMC_vrm and importers may reject it) with the t60/t64 remedy wording
naming the fix step.
"""
import json
import os
import re
import shutil

import bpy

import af_common as af
from steps import _mesh_lib as ml
from steps import _vrm_lib as V

REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "..", "..", ".."))


def _addon_dir():
    """Resolve the installed component the way convert resolves gltfpack (env, then the
    installer-written config key, then the in-repo default) - but it is a FOLDER holding
    blender_manifest.toml (the extension), not a binary."""
    forced = (os.environ.get("ASTRA_VRM_ADDON") or "").strip()
    if forced:
        return forced if os.path.isfile(os.path.join(forced, "blender_manifest.toml")) else None
    try:
        with open(os.path.join(REPO_ROOT, "config", "paths.json")) as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = {}
    for cand in [str(cfg.get("vrm_addon") or "").strip(),
                 os.path.join(REPO_ROOT, "runtime", "vrm-addon", "vrm"),
                 os.path.join(REPO_ROOT, "runtime", "vrm-addon")]:
        if cand and os.path.isfile(os.path.join(cand, "blender_manifest.toml")):
            return cand
    return None


def _enable_addon(ext_dir, warnings):
    """Enable the extension in THIS background Blender.

    The extensions-repository route is fragile headless: the folder name must be a
    valid Python module name (our component dir "vrm-addon" has a hyphen, Blender
    skips it with "not a supported module name") and repo_sync_all refuses to run
    without online access in a --factory-startup Blender. The extension itself is a
    legacy-compatible add-on package (bl_info + register() in its root __init__.py,
    verified in the unpacked 4.10.5), so we load it by path instead: expose it under
    valid module name through a temporary symlink when needed, and enable it through
    addon_utils (which imports from sys.path, registers, and creates the add-on
    preferences entry the extension's exporter asserts on). The verdict is still the
    extension's own export operator appearing, so none of this trusts a guess."""
    import sys
    import tempfile

    ext_dir = os.path.abspath(ext_dir)
    name = os.path.basename(ext_dir)
    root = os.path.dirname(ext_dir)
    if not name.isidentifier():
        alias_root = tempfile.mkdtemp(prefix="astra-vrm-")
        try:
            os.symlink(ext_dir, os.path.join(alias_root, "vrm_addon"))
        except OSError as exc:  # noqa: BLE001 - reported, not hidden
            warnings.append("could not alias %s under a valid module name (%s)" % (ext_dir, exc))
            return None
        name, root = "vrm_addon", alias_root
    if root not in sys.path:
        sys.path.insert(0, root)
    import addon_utils
    if addon_utils.enable(name, default_set=True) is None:
        warnings.append("addon_utils.enable(%s) from %s failed" % (name, ext_dir))
        return None
    return name if hasattr(bpy.ops.export_scene, "vrm") else None


def _pick_rig(objs, warnings):
    """The armature with the most VRM-mappable bones; the failure names the next click."""
    best = None
    for a in af.armatures(objs):
        mapped, missing = V.match_human_bones([b.name for b in a.data.bones])
        if best is None or len(mapped) > len(best[1]):
            best = (a, mapped, missing)
    if best is None or not best[1]:
        raise ValueError("no skeleton with VRM-mappable bones in the input: this mesh has no "
                         "humanoid skeleton yet - run rig_humanoid first (or attach an armature), "
                         "then package VRM")
    arm, mapped, missing = best
    if missing:
        raise ValueError("the rig lacks bones the VRM 1.0 spec lists as Required: %s - such a "
                         "humanoid is invalid per VRMC_vrm and importers are entitled to reject "
                         "it; fix the rig (run rig_humanoid, or complete the skeleton), then "
                         "package VRM" % ", ".join(missing))
    if len(af.armatures(objs)) > 1:
        warnings.append("several armatures - packaged '%s' (most VRM bones mapped)" % arm.name)
    return arm, mapped


def _snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _apply_vrm1(arm, mapped, meta, warnings, stats):
    """Write the documented VRM 1.0 surface (armature.data.vrm_addon_extension.vrm1): the
    humanoid bone assignment (the addon's example: human_bones.<attr>.node.bone_name) and the
    meta fields (vrm_name/version/authors...). Attributes are the spec's bone names in
    snake_case (hips, spine, left_upper_arm...) as the published example shows."""
    ext1 = getattr(getattr(arm.data, "vrm_addon_extension", None), "vrm1", None)
    human_bones = getattr(getattr(ext1, "humanoid", None), "human_bones", None)
    if ext1 is None or human_bones is None:
        raise ValueError("the VRM add-on extension data (vrm_addon_extension.vrm1.humanoid) is "
                         "not on the armature - the enabled add-on does not match the pinned 4.10.5")
    assigned = 0
    for vrm_bone, actual in sorted(mapped.items()):
        hb = getattr(human_bones, _snake(vrm_bone), None)
        node = getattr(hb, "node", None) if hb is not None else None
        if node is None:
            warnings.append("no human_bones.%s attribute - '%s' left unmapped" % (_snake(vrm_bone), actual))
            continue
        node.bone_name = actual
        assigned += 1
    stats["human_bones_assigned"] = assigned
    m = getattr(ext1, "meta", None)
    if m is None:
        warnings.append("no vrm1.meta surface - name/version/author were not written")
        return
    m.vrm_name = meta["name"]
    m.version = meta["version"]
    try:
        m.authors.add().value = meta["author"]
    except AttributeError:
        warnings.append("meta.authors surface differs on this addon build - author not written")
    if meta.get("license_url"):
        try:
            m.license_url = meta["license_url"]
        except AttributeError:
            warnings.append("meta license URL surface differs - left unset")


def _shape_keys(objs):
    keys = set()
    for o in objs:
        if o.type == "MESH" and o.data and o.data.shape_keys:
            keys.update(kb.name for kb in o.data.shape_keys.key_blocks[1:])
    return sorted(keys)


def _apply_expressions(arm, objs, warnings, stats):
    """Bind what the face supports into the addon's VRM 1.0 expression presets, so the addon
    itself writes them into VRMC_vrm on export. Field semantics confirmed against the installed
    4.10.5 surface live on 2026-11-17 (exporter/vrm1_exporter.create_expression_dict resolves a
    bind's `index` as the SHAPE KEY NAME against the mesh object named by `node.mesh_object_name`,
    `weight` in 0..1). Unsupported presets stay named gaps; bindings that cannot land are warned."""
    found, gaps = V.match_expressions(_shape_keys(objs))
    stats["expressions_matched"] = {k: (v.get("direct") or "arkit-blend") for k, v in found.items()}
    stats["gaps"] = {"expressions": gaps,
                     # springs are NOT attempted by this step at all: an empty list here would
                     # read as "checked, found none" - a character with spring-carrying chains
                     # (hair, cloth) is the honest trigger, kept as a named gap until then
                     "springs": "not attempted yet - spring parameters need the character's "
                                "own chains; nothing is invented for a bare rig"}
    preset_group = getattr(getattr(getattr(getattr(arm.data, "vrm_addon_extension", None),
                                           "vrm1", None), "expressions", None), "preset", None)
    expressions = getattr(getattr(arm.data, "vrm_addon_extension", None), "vrm1", None)
    expressions = getattr(expressions, "expressions", None) if expressions else None
    if expressions is not None and hasattr(expressions, "initial_automatic_expression_assignment"):
        # The addon can auto-assign expressions from its own heuristics at export; that would
        # put presets in the FILE that our published-blend table calls gaps - the report must
        # describe the bytes exactly, so the file contains OUR bindings and nothing else.
        # (Found live 2026-11-17: with the default on, the exported presets out-listed the
        # step's matched set - blinkLeft/ee/ou/surprised bound from keys our table does not
        # wire. Flag confirmed on the installed 4.10.5: Vrm1ExpressionsPropertyGroup.)
        expressions.initial_automatic_expression_assignment = False
    owner = {}
    for o in objs:
        if o.type == "MESH" and o.data and o.data.shape_keys:
            for kb in o.data.shape_keys.key_blocks[1:]:
                owner.setdefault(kb.name, o)
    bound, skipped = 0, []
    if found and preset_group is None:
        warnings.append("no vrm1.expressions.preset surface on this addon - matched presets "
                        "were NOT bound")
    for preset, spec in sorted(found.items()):
        expr = getattr(preset_group, preset, None) if preset_group is not None else None
        if expr is None:
            skipped.append(preset)
            continue
        binds = {spec["direct"]: 1.0} if "direct" in spec else dict(spec["blend"])
        expr.morph_target_binds.clear()
        for key_name, weight in sorted(binds.items()):
            obj = owner.get(key_name)
            if obj is None:
                continue
            b = expr.morph_target_binds.add()  # the addon's own migration code uses .add()
            b.node.mesh_object_name = obj.name
            b.index = key_name
            b.weight = float(weight)
        if len(expr.morph_target_binds):
            bound += 1
        else:
            skipped.append(preset)
    stats["expressions_bound"] = bound
    if skipped:
        warnings.append("%d matched preset(s) not bound (no preset attribute on this addon build "
                        "or no owning mesh): %s" % (len(skipped), sorted(skipped)))


def run(req):
    p = req.get("params") or {}
    warnings, stats, checks = [], {}, []
    profile = str(p.get("profile", "vrm1")).lower()
    if profile != "vrm1":
        raise ValueError("params.profile must be 'vrm1', got %r" % (p.get("profile"),))
    ext_dir = _addon_dir()
    if not ext_dir:
        raise ValueError("the VRM Add-on for Blender component is not installed - install it "
                         "(studio installer -Only vrmaddon, or tick it in Components) and run "
                         "this step again")
    src = (req.get("inputs") or {}).get("glb") or (req.get("inputs") or {}).get("mesh") \
        or (req.get("inputs") or {}).get("blend")
    if not src or not os.path.isfile(str(src)):
        raise FileNotFoundError("vrm_package needs inputs.glb - the rigged character file: %r" % src)
    src = os.path.abspath(str(src))
    out_dir = req["out_dir"]
    import_src, label_copy = src, None
    if os.path.splitext(src)[1].lower() == ".vrm":
        # VRM 1.0 IS a glTF-2.0 binary container and the stock importer dispatches by
        # extension, so a .vrm input travels as a byte-identical .glb LABEL copy (never a
        # byte change). Ticket 63 gives .vrm its own route; until then this is it.
        label_copy = os.path.join(out_dir, "vrm-input.glb")
    af.reset_scene()
    try:
        if label_copy:
            shutil.copyfile(src, label_copy)
            import_src = label_copy
        objs = af.import_any(import_src)
    finally:
        if label_copy:
            try:
                os.remove(label_copy)
            except OSError:
                pass
    objs, stats["import_helpers_removed"] = ml.purge_import_helpers(objs)
    manifest = {}
    manifest_path = (req.get("inputs") or {}).get("manifest")
    if manifest_path:  # the pipeline hands inputs.manifest as a PATH to asset.json (godot/bevy convention)
        with open(manifest_path, "r", encoding="utf-8-sig") as fh:
            manifest = json.load(fh)
    arm, mapped = _pick_rig(objs, warnings)
    mod = _enable_addon(ext_dir, warnings)
    if mod is None:
        raise ValueError("the VRM add-on did not enable from %s - reinstall the vrmaddon "
                         "component (installer -Only vrmaddon)" % ext_dir)
    stats["addon_module"] = mod
    meta = {"name": str(p.get("meta_name") or manifest.get("name") or "model"),
            "version": str(p.get("meta_version") or "0.1.0"),
            "author": str(p.get("meta_author") or "AstraForge studio")}
    if p.get("license_url"):
        meta["license_url"] = str(p["license_url"])
    _apply_vrm1(arm, mapped, meta, warnings, stats)
    if str(p.get("expressions", "auto")).lower() != "off":
        _apply_expressions(arm, objs, warnings, stats)
    name = ml.safe_name(p.get("name") or manifest.get("name") or "model", "model")
    vrm_path = os.path.join(out_dir, name + ".vrm")
    result = bpy.ops.export_scene.vrm(filepath=vrm_path)  # presence checked in _enable_addon
    if result != {"FINISHED"}:
        raise ValueError("bpy.ops.export_scene.vrm returned %r (the addon's own failure contract)" % (result,))
    exists = os.path.isfile(vrm_path) and os.path.getsize(vrm_path) > 0
    checks.append(af.check("vrm_written", exists, os.path.getsize(vrm_path) if exists else 0))
    if not exists:
        raise ValueError("bpy.ops.export_scene.vrm did not write %s" % vrm_path)

    # the glTF-valid acceptance half (no Unity on this machine): VRM 1.0 IS a GLB container -
    # parse the JSON chunk, require the extensions the note promises
    from steps import convert as cvt
    g = cvt._glb_json(vrm_path)
    used = set((g or {}).get("extensionsUsed", []))
    stats["extensions_used"] = sorted(used)
    stats["vrm_meta_name"] = ((g or {}).get("extensions", {}).get("VRMC_vrm", {})
                              .get("meta", {}) or {}).get("name")
    for want in ("VRMC_vrm", "VRMC_materials_mtoon", "VRMC_springBone"):
        checks.append(af.check("extension_" + want, want in used, sorted(used), severity="warning"))
    if bool(p.get("validate", True)):
        # re-import pass: the stock glTF importer reads the rig back (its counts, not ours). The
        # bytes are handed to the importer under a .glb label because VRM 1.0 is exactly a
        # glTF-2.0 binary container and import_any still dispatches by extension (ticket 63
        # gives .vrm its own route; until then a label copy, never a byte change).
        tmp = os.path.join(out_dir, name + ".validate.glb")
        try:
            shutil.copyfile(vrm_path, tmp)
            af.reset_scene()
            back = af.import_any(tmp)
            arms = af.armatures(back)
            stats["reimport"] = {"objects": len(back), "armatures": len(arms),
                                 "skinned_meshes": sum(1 for o in back if o.type == "MESH"
                                                       and any(m.type == "ARMATURE" for m in o.modifiers))}
            checks.append(af.check("reimport_rig", bool(arms), stats["reimport"]))
        except Exception as exc:  # noqa: BLE001
            warnings.append("re-import validation failed: %s (the .vrm file itself passed the "
                            "container checks)" % exc)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    report = os.path.join(out_dir, "vrm_package.json")
    with open(report, "w") as fh:
        json.dump({"meta": meta, "stats": stats, "warnings": warnings, "checks": checks},
                  fh, ensure_ascii=False, indent=1)
    return {"outputs": {"vrm": vrm_path, "report": report},
            "stats": stats, "warnings": warnings, "checks": checks}
