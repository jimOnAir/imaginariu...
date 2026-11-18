"""inspect — import a model and report stats; optional preview sheet.

inputs.mesh: path (.glb/.gltf/.fbx/.obj/.stl/.vrm/.blend); params.preview: bool (default true),
params.views: list of view names (imaginarium_common.VIEWS), params.size: px.
"""
import os

import imaginarium_common as ima


def run(req):
    ima.reset_scene()
    objs = ima.import_any(req["inputs"]["mesh"])
    stats = ima.scene_stats(objs)
    outputs = {}
    if req["params"].get("preview", True):
        views = req["params"].get("views", ["front", "left", "back", "three_quarter"])
        outputs["preview"] = ima.render_views(ima.out_path(req, "preview.png"), objs, views=views,
                                             size=req["params"].get("size", 384))
    mixamo = any(b.name.startswith("mixamorig") for a in ima.armatures(objs) for b in a.data.bones)
    stats["mixamo_skeleton"] = mixamo
    stats["file"] = os.path.basename(req["inputs"]["mesh"])
    return {"outputs": outputs, "stats": stats}
