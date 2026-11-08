# Auto-review — the studio checks its own shapes

Branch: `linux-support`, 0.6.x reintroduction wave, ticket 08. A finished 3D generation does not
just land in the scene: the studio renders it, asks the local vision model to score it against the
concept, and **the verdict comes from a fixed threshold table, not from the model's opinion**.
Failed attempts redo themselves with new seeds (retries 0..3); the best attempt is kept.

## The loop

```
job completed (GLB) -> orbit render (Blender) -> VLM scores 5 axes -> decide() table
        accepted? stop, keep this asset          |
              no  -> new seed, generate again -> review again (up to 4 attempts)
```

- **Orbit render** — the `orbit_render` Blender step (`scripts/blender/steps/orbit_render.py`)
  imports the GLB and renders 8 orthographic Workbench frames at even azimuths (`orbit_00..07.png`,
  the `orbit.json` manifest lists them with their yaw). The same pass reports the **plain mesh
  numbers** — open (boundary), non-manifold and wire edges, loose parts — which the table uses below.
- **Scores** — the review model is ticket 14's pick (`ASTRA_REVIEW_VLM` > the Connections choice >
  the VRAM tier, see docs/product/ollama.md); `server/vlm.mjs` sends the concept + 4 sampled orbit
  frames and asks for one JSON object: `likeness, silhouette, seams, face, style` (0–10, null when
  an axis cannot apply — a prop has no face). Which model answered **and why it was chosen** is
  recorded with every attempt (`model`, `modelReason`).
- **The table decides** — `decide()` in `server/autoreview.mjs`: every scorable axis must reach
  `axisFloor` (4) **and** the average must reach `meanFloor` (5.5); the plain mesh numbers *cap* the
  seam score (`seamCap`: open edges → ≤6, non-manifold/wire → ≤5, more than one loose part → ≤7; an
  unopenable model → 0). The table is this branch's own tuning, exported as `THRESHOLDS`
  (tunable via `ASTRA_REVIEW_TUNE='{"axisFloor":6}'`, clamped — for tuning and demos; production
  runs on the table). Retries: `maxAttempts` 4 total.
- **Journal** — every verdict appends a line to `<library>/learning/autoreview.jsonl` with
  `source: "auto"` (library = the forge library, `data/library` by default): scores, the cap that
  applied, mesh numbers, model + reason, seeds, the record's final status and kept best attempt.
  The learning loop reads the same `learning/` directory as the forge journal (`docs/forge/LEARN.md`).

## Surfaces

- **Tab «Check» / «Проверка»** (`src/AutoReviewPanel.jsx`) — records with attempt dots, score chips
  colored by the table, the mesh numbers, the reasons, the model that answered, and the orbit strip
  per attempt. «Check the latest generation» reviews a finished job by hand; the automatic hook
  starts a review the moment any shape job completes.
- **API** — `GET /api/autoreview` (summaries), `GET /api/autoreview/:id` (full record),
  `GET /api/autoreview/thresholds` (the table the panel explains itself with),
  `GET /api/autoreview/journal?limit=` (journal tail),
  `GET /api/autoreview/:id/orbit/a<n>/orbit_<nn>.png` (names whitelisted),
  `POST /api/autoreview {jobId}` (studio header required).
- **Off switch** — `ASTRA_AUTOREVIEW=0` skips the automatic hook (manual reviews still work).
  Child generations (the retries) carry `autoreviewOf` and never open a second review.

## Live measurement (RTX 5070, 2026-11-08, ollama 0.40.15 + qwen3-vl:8b)

Job seed 505 → attempt 0 scored `likeness 2` (other axes fine, average 6.75) → **rejected by the
floor**, not the average — exactly the point of fixed thresholds. Retry with seed 855199914 →
attempt 1 → **accepted** (mean 7.0); the record keeps attempt 1 as best. Each attempt: ~2 min
draft generation + ~30 s orbit (real 384² PNG frames on disk) + one review call.

Finding baked into `vlmAsk`: **ollama 0.40 ignores `think:false` for qwen3-vl** — the model fills
`message.thinking` and returns empty `content`, so with the old one-shot call every review died as
"empty text". `vlmAsk` now re-asks once with reasoning ON and a budget big enough to finish it
(`num_predict >= 3000`) when that happens; the finished answer arrives after ~2–3 min. Reviews send
concept + 4 orbit frames (of the 8 rendered): with the shape engine warm on the same card, 9
pictures push qwen3-vl into CPU offload and the answer stops arriving.

## Code map

| Piece | Where |
|---|---|
| table, decide, the loop, routes | `server/autoreview.mjs` |
| completion hook | `server/jobs.mjs` (`hooks.onCompleted`, wired in `server/index.mjs`) |
| orbit step | `scripts/blender/steps/orbit_render.py` via `server/blender.mjs` |
| model pick / ask | `server/vlm.mjs`, `server/ollama-run.mjs` (ticket 14) |
| panel | `src/AutoReviewPanel.jsx`, `src/autoreview.css`, tab `autoreview` in `src/App.jsx` |
| tests | `tests/autoreview.test.mjs`, `tests/vlm.test.mjs` |
