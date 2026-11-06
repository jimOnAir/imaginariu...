# SkinTokens / TokenRig — the learned creature rig we do not ship

**Decision (2026-11-07, wave 0.6.x ticket 03): not shipped on this branch.** The `rig_creature`
step keeps the engine choice in its contract (`rig_engine: blender | skintokens`, plus the
`skeleton` hint), and asking for `skintokens` fails the job before anything runs, with this
reason. The supported path is `rig_engine: 'blender'` — the template skeleton this branch has
always used (quadrupeds, birds, winged, six- and eight-legged, snakes; bone-heat weights,
sockets, previews).

## What SkinTokens is

VAST-AI's SkinTokens (the TokenRig line, successor to UniRig) is a learned auto-rigger: one
autoregressive pass over an input mesh emits a whole rig — skeleton hierarchy and per-vertex
skinning weights — as a single token sequence. The code (github.com/VAST-AI-Research/SkinTokens)
and the published checkpoints (huggingface.co/VAST-AI/SkinTokens) carry an MIT license, and we
studied them as upstream always does.

## Why it stays out

The upstream MIT label does not survive contact with the dependency tree:

- `src/model/michelangelo/` is vendored **into** the MIT repo — module-for-module the structure
  and classes of NeuralCarver/Michelangelo (`models/modules/{embedder,transformer_blocks,
  distributions}.py`, `models/tsal/{sal_perceiver,tsal_base}.py`), and that project is
  **GPL-3.0** (its own README and LICENSE). An MIT notice on a copy of GPL code does not
  relicense it.
- The released checkpoint **cannot run around it**: `TokenRig` asserts the mesh encoder is the
  Michelangelo perceiver (`michelangelo` / `michelangelo_encoder` — the `tripo` target exists in
  the code but no published weights use it), and `output_proj` is a trained linear against that
  encoder's latent width. A clean encoder is not a swap, it is a retrain — far outside a
  reintroduction ticket.
- The encoder's own published weights are LGPL-3.0 territory as well (Hugging Face model card),
  another copyleft flag we would inherit.

Under the branch's license posture (ADR-0004: the tree is MIT, everything it runs must be
compatible), shipping a venv worker that executes GPL-derived inference would put the whole
product under copyleft obligations. That trades the one thing this branch promises — a clean
license line — for one rigging button. Not a trade we take.

## The shape of the absence

- `rig_engine: 'skintokens'` → the step fails with the reason above and a pointer to this file;
  nothing spawns, nothing downloads, no half-state.
- `rig_engine: 'blender'` (default) → today's behavior, untouched.
- `skeleton: '<template>'` → respected: with the blender engine it fills `template` when that is
  left `auto` (a bad hint name is rejected with the allowed list).
- No venv, no weights, no installer rows, no notices rows for SkinTokens — there is nothing of it
  in the build. The `rig_creature` Blender step and its `template` parameter are unchanged.

If VAST-AI ever publishes the model with a clean encoder (or the training data lets us retrain
one), the engine slot is already in the contract — it can arrive as a pure addition.
