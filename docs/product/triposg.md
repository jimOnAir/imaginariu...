# TripoSG (the third shape engine)

TripoSG turns **one concept image into a shape** — a GLB mesh, no textures. It is the sibling of
Hunyuan3D and Pixal3D in the generation tab, not a fourth thing: same job queue, same concept
prep, same viewer. On the wire the request is `{ "engine": "triposg" }`; the job record carries
the same fields as any generation plus a `triposg` block (seconds, faces, face budget, seed).

## Why a worker instead of the service

Hunyuan3D lives inside the studio's ComfyUI (port 8190); Pixal3D in its own portable ComfyUI
(port 8191). TripoSG is neither: every generation spawns a **one-shot Python process in its own
venv** (`runtime/triposg/.venv`) and kills it when the mesh lands. No port to probe, no service
to keep warm, nothing to contaminate the studio's ComfyUI — the GPU lock in the job layer
already serializes engines. This is the same subprocess idiom as the Blender step.

The cost of that choice: each run pays pipeline load (~a minute with the weights on disk). The
benefit: an uninstalled or half-installed TripoSG can never break a Hunyuan job, and the whole
component is opt-in — the installer fetches it only when you ask.

## What has to be on disk

The status line (connections panel, `/api/status.triposg`, `engine_status`) checks three things
under the install folder (`IMAGINARIUM_TRIPOSG_DIR` or `config/paths.json → triposgDir`, default
`runtime/triposg`):

| Piece | Where | What it is |
|---|---|---|
| venv | `.venv/bin/python` | its own Python environment (torch from a CUDA 12.8 index; Blackwell works) |
| code | `src/TripoSG/` | the MIT VAST-AI/TripoSG project, pinned to one commit (`src/TripoSG` → `PINNED-COMMIT.txt` next to it) |
| weights | `models/TripoSG/` | the published HF snapshot `VAST-AI/TripoSG` (transformer + VAE + the DINOv2-large image encoder, Apache-2.0, included in the snapshot), ~8 GB |

The pipeline runs fully offline: every component resolves inside these four paths
(`HF_HUB_OFFLINE` is set for the worker, so nothing can sneak out to fetch anything).

Missing anything → the engine says so with the exact paths, and a `engine: "triposg"` request is
refused **before the queue** with the install instruction (`installer/install.sh -Only triposg`).

## The run

1. **Concept** — the studio's own prep step (rembg + u2net, same as the sibling engines): the
   worker receives a clean RGBA image. TripoSG's pipeline does not run its own segmentation net.
2. **Generate** — `scripts/triposg/triposg_run.py` loads the pipeline (fp16, CUDA) and runs the
   rectified-flow diffusion; progress arrives as `PROGRESS <percent> <text>` lines on the job.
3. **Extract** — the octree SDF becomes a triangle mesh. Here the branch deviates on purpose:
   the upstream example imports `diso`, which is **CC BY-NC 4.0 — non-commercial**, so it is
   never installed. `scripts/triposg/diso_skimage_fallback.py` (BSD-2 scikit-image marching
   cubes, our code) registers itself as `diso` before the upstream import resolves; the
   iso-surface self-test (watertight unit sphere, correct volume and outward winding) runs in
   the test suite.
4. **Face budget** — `meshLevel` maps to a target face count the same way it does for the
   siblings: **-1 → 80 000, 0 → 200 000, +1 → 5 000 000** faces, decimated with
   fast_simplification (MIT). A mesh below budget is kept as decoded.
5. **Land** — GLB through the normal asset path, validated like every other result.

One view only: multi-view view-sets stay with Hunyuan3D/Pixal3D (the API says so explicitly),
and `backgroundMode: keep` is refused — TripoSG always works on the cutout.

## Hardware

Roughly **4 GB VRAM** for the pipeline in fp16 (upstream quotes ~20 s per shape on an 8 GB card;
the live 5070 ran a full job in ~30 s). The auto rule is the low-VRAM seam: with TripoSG installed,
`engine: "auto"` resolves to TripoSG on cards up to **9216 MiB** and to Pixal3D/Hunyuan above it
(view-set jobs never land on TripoSG). `/api/status` carries the current verdict as `shapeAuto`
(engine + why), and the installer checklist knows the row too: `full` always offers TripoSG, and
on a ≤9216 MiB card the quick preset trades the two multi-view Hunyuan models for it. The
`IMAGINARIUM_VRAM_MIB` environment variable overrides the card reading (tests, odd setups).

Installing it: `installer/install.sh -Only triposg,triposgvae,triposgdino` — one row in the
checklist, three resumable components (Python env + pinned code + transformer / VAE / DINOv2
weights, each sha256-pinned and verified on every run).

## Not here (yet, or never)

The UI still shows two engines (hunyuan/pixal3d) — `engine: "triposg"` works via the API and
MCP today; the generator-choice UI is a later ticket. No textures: TripoSG is shape-only, the
texturing pipeline is the same as for the other engines. No Engine-plugin plumbing and no
provenance marks for this engine on this branch.
