# Views on small cards: the fp8 memory tier

`comfy_client.mjs`'s step-watchdog comments cite this file. It records what the
MV-Adapter views job actually costs on real cards, measured on this machine
(2026-11-17, an RTX 5070 12 GB with a desktop session resident and, for the
before/after row pair, an RTX 5060 Ti 16 GB), and what the tier in
`astra_views.py` does about it.

## The problem

The fp16 pipeline wants its UNet on the card before the first step: about
5.4 GB of weights, plus the text encoder and VAE paths, plus activations.
Ticket 43's Windows post-mortem caught the failure mode downstream - a card
that "fits" by megabytes starts paging mid-step and one step runs 24 minutes;
that is what the 5-minute step sentinel interrupts. But on a 12 GB card with
a desktop session the job never even reaches a step: ComfyUI's memory budget
refuses the load outright.

## The tier

When the card is NVIDIA and `currentVramMib() <= ASTRA_VIEWS_FP8_MAX_MIB`
(default 16384) and `ASTRA_VIEWS_FP8` is `auto`/`1`, the node runs, after
loading the adapter and before sampling:

    pipe.unet.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn)

Per-MODULE on purpose - the shipped diffusers do not expose it on pipelines.
It is an ON-CARD dtype mechanism: fp8 masters live on the card and each block
is upcast to compute_dtype for the step it participates in (the first probe
of this, done as "cast in RAM then move", failed with
`mat1 is on cuda:0 ... on cpu` and corrected the assumption - casting must
happen before the upload, which is exactly why the upload shrinks). The VAE
is NOT cast: its `force_upcast` float32 path collides. `ASTRA_VIEWS_FP8=0`
disables the tier.

Because an fp8 step legitimately runs slower, `views_mvadapter.mjs` passes a
tier-loosened `stepMaxMs` (10 minutes) on the fp8 path; the fp16 path keeps
the 5-minute sentinel semantics untouched.

## Measured, this machine

Shape is the production one: `safeSize` caps, seed 21, 30 steps, text+vae
offload. Peak is the node's own `torch.cuda.max_memory_allocated()`;
`wall` is the sampling loop.

| card | tier | shape | peak VRAM | s/step | result |
|---|---|---|---|---|---|
| 5070 12 GB (desktop ~2.4 GB resident) | fp16 | 640 px, 4 views | - | - | refused before step 1; 512 fallback refused too |
| 5070 12 GB | fp8 | 640 px, 4 views | **6.45 GB** | 0.7 | ok, 21.5 s wall, watchdog idle |
| 5070 12 GB | fp8 | 512 px, 6 views | **5.87 GB** | 0.6 | ok, 19.2 s wall |
| 5060 Ti 16 GB | fp16 | 640 px, 4 views | **9.61 GB** | 0.8 | ok, 24.3 s wall |
| 5060 Ti 16 GB | fp8 | 640 px, 4 views | **6.45 GB** | 0.9 | ok, 26.2 s wall |

Read it as: fp8 costs ~0.1 s/step (~12% on the same card, within run noise
for a 30-step job) and saves 3.2 GB at peak. On the 12 GB card that is the
difference between "never loads" and "runs at 640". The 640 px peak of the
fp16 path (9.6 GB measured, matching the 9.7 the old Windows notes gave for
a 4070) is also why an 8 GB card cannot run fp16 views at all.

## What this settles for CFG-batch halves

The upstream cure for cards that still fail after fp8 splits the diffusion
step's 2N batch into two N halves. Measured here, fp8 at the widest shape the
branch picks (512 px, 6 views) peaks at 5.87 GB - under the 8 GB-class budget
with room for the ComfyUI baseline - so the branch does NOT carry the CFG
split; the surgery would make us the maintainer of a vendored pipeline for no
measured gain (ticket 45, closed on these numbers). If a future card-or-shape
combination breaks the assumption, the sentinel will say "paging" rather than
wait, and the split starts from this table.
