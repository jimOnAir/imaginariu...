"""_unreal_lib — Unreal Engine conventions for the unreal_package step (behavior per ADR-0004,
ticket 05; see docs/product/unreal.md).

Rules the package obeys (interface facts of Unreal import):
  units      centimetres (the FBX carries the metres->cm conversion, the importer applies it)
  axes       Z up, nose +X, left-handed; the FBX is written with the exporter axes
             axis_forward='-Y', axis_up='Z' so a Blender -Y nose lands on UE +X
  naming     SM_ static mesh, SK_ skeletal mesh, A_ actor Blueprint, T_ texture,
             MI_ material instance; collision meshes UCX_<render mesh>_##; LOD meshes
             <render mesh>_LOD1/_LOD2
  textures   T_<asset>_<slot>_BaseColor (sRGB), _Normal (DirectX: green flipped),
             _ORM (R occlusion, G roughness, B metallic)
  material   instances of one master material (M_Imaginarium), created by the importer
"""
import re

FORMAT = "imaginarium-unreal-package/1"
PREFIX_MESH = {"static": "SM", "skinned": "SK"}
COLONLY_RE = re.compile(r"-(?:conv)?colonly$|_colonly$|_convcolonly$", re.I)
COL_HULL_RE = re.compile(r"^COL_", re.I)


def is_collision_name(name):
    return bool(COLONLY_RE.search(name) or COL_HULL_RE.search(name))


def ue_name(prefix, asset_id, part=None):
    """SM_asset_part / SK_asset / T_asset_slot_BaseColor / MI_asset_slot / A_asset."""
    bits = [prefix, asset_id] + ([part] if part else [])
    return "_".join(b for b in bits if b)


def lod_name(render_name, level):
    return "%s_LOD%d" % (render_name, level)


def ucx_name(render_name, index):
    return "UCX_%s_%02d" % (render_name, index)


def slot_slug(material_name, index):
    """A texture/material slot slug from a Blender material name (ASCII, no separators twice)."""
    s = re.sub(r"[^A-Za-z0-9]+", "_", material_name or "").strip("_")
    return (s or "mat%d" % (index + 1))[:48]


def anim_name(clip):
    """A_<clip> with the studio '-loop' suffix folded into the UE animation name."""
    base = re.sub(r"-loop$", "", clip or "", flags=re.I)
    slug = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_") or "anim"
    return "A_" + slug, bool(re.search(r"-loop$", clip or "", re.I))


def source_forward_for(kind, explicit):
    """The nose axis in GLB space: ships, props and turrets -Z; characters and creatures +Z
    (the same per-kind rule the Godot package applies); explicit overrides."""
    if explicit in ("+Z", "-Z"):
        return explicit
    return "-Z" if (kind or "").lower() in ("ship", "prop", "turret", "station") else "+Z"


def rotation_for_source(source_forward):
    """Z rotation (degrees) that turns the asset nose into UE +X once the exporter maps
    Blender -Y -> +X: a -Z GLB nose (Blender -Y) needs nothing, a +Z one turns -90."""
    return 0.0 if source_forward == "-Z" else -90.0
