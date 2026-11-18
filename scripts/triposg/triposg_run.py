"""tripoSG_run.py - Imaginarium's one-shot TripoSG worker (behavior per ADR-0004, ticket 01).

Spawned by server/triposg.mjs inside the install's own venv (runtime/triposg/.venv):

    python triposg_run.py --image CONCEPT.png --out MESH.glb --weights DIR --src DIR \
        [--faces N] [--seed N] [--steps N] [--guidance F]

Contract (stdout lines; server/triposg.mjs parses them):
    PROGRESS <percent> <text>      - stage updates
    TRIPOSG_RESULT {json}          - success: out, vertices, faces, facesTarget, seconds
    TRIPOSG_ERROR {json}           - failure: message

The shape pipeline and weights are the MIT VAST-AI/TripoSG project (pinned clone in --src, HF
snapshot in --weights); nothing of the reference pipeline is rewritten here - this file only maps
the studio's job parameters onto its public API. Background removal is the studio's own upstream
of this call: --image must be the prepared RGBA concept. Their example uses a segmentation net
only when a channel is missing; a real alpha bypasses it, and with rmbg_net=None the non-commercial
model never loads. Face decimation uses fast_simplification (MIT) instead of the vendor example's
pymeshlab (MPL); iso-surface extraction goes through our scikit-image fallback
(diso_skimage_fallback.py, BSD-2) because the upstream `diso` is CC BY-NC 4.0 - non-commercial.
CUDA-only, as documented.
"""
import argparse
import json
import os
import sys
import time
import traceback

T0 = time.time()


def progress(pct, msg):
    print("PROGRESS %d %s" % (int(pct), msg), flush=True)


def fail(exc):
    print("TRIPOSG_ERROR " + json.dumps({"message": str(exc) or type(exc).__name__,
                                         "trace": traceback.format_exc(limit=4)}, ensure_ascii=False), flush=True)
    sys.exit(1)


def decimate(mesh, target, warnings):
    """Quadric decimation to the face budget; a missing wheel is a warning, the full mesh survives."""
    if target <= 0 or mesh.faces.shape[0] <= target:
        return mesh
    try:
        import fast_simplification  # noqa: F401  (trimesh calls into it by name)
        return mesh.simplify_quadric_decimation(face_count=target)
    except Exception as e:  # noqa: BLE001 - decimation is cosmetic, geometry is the product
        warnings.append("face budget %d not applied (%s); keeping the full mesh" % (target, e))
        return mesh


def repair_before_export(mesh, warnings):
    """A clean GLB: weld the vertices the float32 round-trip quantizes into coincident points,
    drop the faces that collapse as a result (and any sharing a non-manifold edge afterwards),
    then re-check. Classic marching cubes can pinch a one-face sliver where the octree band
    meets its NaN-filled margin; the repair changes no geometry a user can see, it only stops
    those slivers making the mesh non-watertight to downstream tools.
    """
    try:
        import numpy as np
        for _ in range(3):
            if mesh.is_watertight:
                return mesh
            before = mesh.faces.shape[0]
            mesh.merge_vertices()
            keep = mesh.nondegenerate_faces() & mesh.unique_faces()
            ev = np.sort(mesh.faces[keep][:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
            uniq, counts = np.unique(ev, axis=0, return_counts=True)
            bad_edges = uniq[counts > 2]
            if len(bad_edges):
                f = mesh.faces[keep]
                for edge in bad_edges:
                    hits = np.where((f == edge[0]).any(axis=1) & (f == edge[1]).any(axis=1))[0]
                    keep[np.flatnonzero(keep)[hits]] = False
            mesh.update_faces(keep)
            mesh.remove_unreferenced_vertices()
            if mesh.faces.shape[0] == before:
                break
        if not mesh.is_watertight:
            warnings.append("mesh kept %d faces but still reports non-manifold edges" % mesh.faces.shape[0])
    except Exception as e:  # noqa: BLE001 - repair is cosmetic, geometry is the product
        warnings.append("export repair skipped (%s)" % e)
    return mesh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--src", required=True, help="commit-pinned VAST-AI/TripoSG clone")
    ap.add_argument("--faces", type=int, default=200000, help="face budget (0 = keep as decoded)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--guidance", type=float, default=7.0)
    args = ap.parse_args()

    if not os.path.isfile(args.image):
        raise SystemExit(fail(ValueError("concept image not found: %s" % args.image)))

    sys.path.insert(0, args.src)
    sys.path.insert(0, os.path.join(args.src, "scripts"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    # diso (CC BY-NC 4.0) is never installed in a commercial build; make the upstream import of
    # it resolve to our scikit-image fallback (BSD-2) before any triposg module is loaded.
    from diso_skimage_fallback import register as _register_diso_fallback
    _register_diso_fallback()

    try:
        import numpy as np
        import torch
        import trimesh
        # diffusers refuses to import repo-named custom modules by itself; ours come from the
        # pinned clone on sys.path and must be loaded before from_pretrained resolves them.
        import triposg.schedulers.scheduling_rectified_flow  # noqa: F401
        import triposg.models.transformers.triposg_transformer  # noqa: F401
        import triposg.models.autoencoders.autoencoder_kl_triposg  # noqa: F401
        from triposg.pipelines.pipeline_triposg import TripoSGPipeline
        from image_process import prepare_image
    except ImportError as e:
        fail(e)

    try:
        if not torch.cuda.is_available():
            raise RuntimeError("TripoSG needs a CUDA GPU; this machine has none available to the worker")

        progress(8, "TripoSG: loading the pipeline")
        pipe = TripoSGPipeline.from_pretrained(args.weights).to("cuda", torch.float16)

        progress(24, "TripoSG: the concept (RGBA in, white matte out)")
        img = prepare_image(args.image, bg_color=np.array([1.0, 1.0, 1.0]), rmbg_net=None)
        if img is None:
            raise RuntimeError("the concept has no usable pixels (or no alpha the pipeline can read); "
                               "prepare the concept first - a background-mode of 'keep' needs an opaque source")

        progress(38, "TripoSG: rectified-flow diffusion of the shape")
        gen = torch.Generator(device=pipe.device).manual_seed(int(args.seed))
        samples = pipe(image=img, generator=gen, num_inference_steps=int(args.steps),
                       guidance_scale=float(args.guidance)).samples
        progress(74, "TripoSG: decoding the mesh")
        verts, faces = samples[0]
        mesh = trimesh.Trimesh(vertices=np.asarray(verts, dtype=np.float32),
                               faces=np.ascontiguousarray(np.asarray(faces)))

        warnings = []
        progress(86, "TripoSG: face budget")
        mesh = decimate(mesh, int(args.faces), warnings)
        progress(90, "TripoSG: export repair")
        mesh = repair_before_export(mesh, warnings)

        progress(94, "TripoSG: saving GLB")
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        mesh.export(args.out)

        print("TRIPOSG_RESULT " + json.dumps({
            "out": args.out, "vertices": int(mesh.vertices.shape[0]), "faces": int(mesh.faces.shape[0]),
            "facesTarget": int(args.faces), "seed": int(args.seed), "steps": int(args.steps),
            "guidance": float(args.guidance), "seconds": round(time.time() - T0, 2), "warnings": warnings,
        }, ensure_ascii=False), flush=True)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - every worker failure is a message for the job record
        fail(e)


if __name__ == "__main__":
    main()
