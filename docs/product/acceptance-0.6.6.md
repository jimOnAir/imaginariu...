# Imaginarium 0.6.6 — acceptance report (Windows 0.5.3→0.6.6 behavior, re-derived on Linux, shipped once)

This tree (`linux-support`) is version **0.6.6**. It carries everything the [0.5.1 acceptance
report](acceptance-0.5.1.md) covered — the 0.4.16 feature set plus the Windows 0.5.x line — and
adds the behavior of the shipped Windows releases **0.6.0 through 0.6.6**, re-derived under
Protocol v2 ([ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md)): the author's
published intent paraphrased to functional bullets (T1), observed behavior (T2) and interface
facts (T3) as the only spec channels; implementing contexts never read the extracted payload;
every commit gated by an independent fresh-context similarity audit recorded per ticket under
`.scratch/imaginarium-060-reintroduction/issues/`.

**Parity line.** Windows shipped 0.6.0 and then patched it six times; **this branch folds the
whole line into one Linux release** — there was never a Linux 0.6.0…0.6.5 (recorded deviation).
The parity artifacts are therefore three installers: **`AstraForge-Setup-0.6.0.exe`** (md5
`5438e1b3e7e215afcb25303e827a3f66`), **`AstraForge-Setup-0.6.5.exe`** (61 099 008 B, md5
`da25af2d8956ad86249d3afb945078d1`) and **`AstraForge-Setup-0.6.6.exe`** (61 105 664 B, md5
`f30021db2672946ebb3b3e260d242537`, sha256 `3968efef247502a6d0c7ad444540f69aac749f4f646278c05b27972130ca7197`).
The 0.6.0 installer finally fixed its own version stamp (0.5.x stamped `FileVersion 0.4.17`),
while `LegalCopyright` in the shipped binaries still misstates MIT — the authoritative `LICENSE`
says otherwise, which is why this branch exists at all. **Open decision, disclosed:**
`AstraForge-Setup-0.6.10.exe` (61 570 560 B, md5 `49a32878c1bb26918a508e4c0dc6f813`, sha256
`bb5c6e768304a35eff4dcddd95bd8f45997996eb03c1babdf32960d8a811cfbd`) arrived before closeout with
no published behavior facts for 0.6.7–0.6.10; the wave scope does not move on an artifact's
arrival alone — a later release folds that line in once its intent is sourced.

Statuses (as before): ✅ implemented · 🚫 excluded by decision · ⚪ not applicable on Linux
(frozen Windows surface) · ⚠️ implemented but unverified on this machine.

How to verify the whole tree at this commit:

```bash
npm ci
IMAGINARIUM_ENGINE_AUTOSTART=0 npm test    # 519 tests: 517 pass, 0 fail, 2 skipped (both pre-existing)
cd ai/mcp && npm test                # 24 tests: 23 pass, 1 skipped (the fake-Start case is win32-only)
npm run build
installer/install.sh -v              # prints the package.json version (0.6.6) — the drift guard
blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- unreal   # 5 pass, 1 designed skip
blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- unity    # 6 pass, 1 designed skip
```

Commits of this wave (base `ea96e11`, the 0.5.1 release): `4ef4989` (01) · `47127c1` (02) ·
`d52a17f` (03) · `6a74d60` (04) · `a753967` (05) · `6821781` (06) · `cde3b34` (07) · `d67abac`
(08) · `8986276` (09) · `991ad8d` (11) · `f7986bd` (12) · `a6ce9d3` (14) · `1604176` (15) ·
`13156e9` (16) · `8d132d1` (17) · this commit (13, closeout). Ticket 10 (generator-choice UI)
stays **unsent by owner decision** — the surfaces it describes are already largely at HEAD and no
draft was landed.

## Cluster A — the third shape engine: TripoSG (Windows 0.6.0 line A)

| # | Behavior (intent, paraphrased) | Status | Where | Proof |
|---|---|---|---|---|
| 1 | TripoSG generates a mesh from a single picture as its own worker: dedicated venv (torch cpu/cu128 by card), commit-pinned MIT clone, HF snapshot split into resumable checksummed steps; `engine: triposg` rides the studio job layer and lands a GLB | ✅ | ticket 01 (`4ef4989`), `server/triposg.mjs`, `server/triposg-run.mjs` | live demo on the 5070 (studio booted, `POST /api/jobs engine=triposg` → GLB opens, record in the ticket) + `tests/triposg*.test.mjs` |
| 2 | Installer components `triposg`/`triposgvae`/`triposgdino`, scan rows, `-Only` installs them; `auto` resolves the shape engine by card: TripoSG ≤ 9216 MiB, else Pixal3D if installed, else Hunyuan — proven through the `IMAGINARIUM_VRAM_MIB` seam without hardware surgery | ✅ | ticket 02 (`47127c1`), `installer/imaginarium_scan.mjs`, `installer/install.sh`, `server/triposg.mjs` | `-ScanList` rows + real `-Yes -Only` run verified pins against the on-disk install; the auto rule unit-pinned at both sides of the boundary |
| 3 | Windows ships TripoSG inside the Imaginarium Engine (plugin + engine installer); this branch keeps the standalone-worker mapping | recorded deviation | ADR-0004 §0.6.6 amendment | engine plumbing stays deferred with the Engine line |

## Cluster B — the autorig slot that refuses honestly: SkinTokens (Windows 0.6.0 line, license outcome)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | `rig_creature` accepts the upstream contract params (`rig_engine: blender \| skintokens`, skeleton hint); `skintokens` is refused **before anything spawns** with the license reason and a pointer to the doc — the released checkpoint hard-asserts a GPL-vendored mesh encoder (structure-for-structure Michelangelo classes) with no clean substitute for the published weights | ✅ (degraded per the ticket's own rule: scope degrades, the license rule does not) | ticket 03 (`d52a17f`), `scripts/blender/steps/rig_creature.py`, `docs/product/skintokens.md` | refusal + fallback + absence tests; the Blender template rig (the supported path) untouched |
| 2 | A `skintokens` checklist row the day a clean encoder lands | 🚫 by decision | `installer/imaginarium_scan.mjs` `EXPERIMENTAL` lists it for that day | no row today; the decision doc carries the re-evaluation conditions |

## Cluster C — Sound: local effects and music (Windows 0.6.0 line B)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | A tab that turns a description into an effect and a style prompt into a seamless loop: MOSS-SoundEffect (Apache-2.0) + ACE-Step (MIT) in their own venv, VRAM-gated with honest absence sentences | ✅ | ticket 04 (`6a74d60`), `scripts/sound/*`, `server/sound*.mjs`, `src/SoundPanel.jsx` | live demo through the product API on this machine (SFX + loop audible); loop seam measured (`max\|d[0]-d[-1]\| ≈ 1.5e-4`) |
| 2 | Library with previews, tags, and event bindings that ride the game object export; watermark-mark stripping machinery is NOT part of this branch (provenance line excluded) | ✅ (marks: 🚫 by decision) | ticket 04; `docs/product/sound.md` | suite + export tests; OGG Vorbis comments sanitized against product-name keys |
| 3 | MCP `sound_*` family for agents: status / generate / list / bind / export, documented presence and absences | ✅ | ticket 05 (`a753967`), `ai/mcp/server.mjs` + routes | live stdio MCP-client demo against a booted studio; `cd ai/mcp && npm test` |

## Cluster D — the style bible draws the series (Windows 0.6.0 line D)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | Styles carry reference pictures + an English description, described locally by the installed vision model (`/describe`, no cloud) | ✅ | ticket 06 (`6821781`), `server/styles.mjs`, `src/StylePanel.jsx` | live demo with real qwen3-vl:8b (two painted references → usable description into the bible) |
| 2 | A 2D set carries `styleBibleId`; series, turnarounds and text-edits draw **in style** on Qwen-Image-Edit 2511 GGUF (stock ComfyUI nodes, lightning LoRA 4-step, `reference_latents_method` wiring); the gate is honest: 10 GiB of video memory or the style series fall back to FLUX.2 klein, the reason rides the card | ✅ | ticket 07 (`cde3b34`), `scripts/art2d/art2d_workflows.mjs`, `server/art2d.mjs`, `installer` component `qwenedit` | live T2 demo: bible → `engine: qwenedit` (auto-upgrade note), 48 s, real 768×1024 PNGs, bible text in `prompt_final`; fallback proven live too (ComfyUI silent → `flux2` with the reason) |
| 3 | Upstream draws this inside the Imaginarium Engine; this branch uses stock ComfyUI nodes (deviation, like TripoSG) | recorded deviation | ADR-0004 §0.6.6 amendment | docs state it |

## Cluster E — the studio checks its own shapes (auto-review)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | A finished GLB gets a Blender orbit render (8 frames + `orbit.json` + plain mesh numbers); the local VLM scores five axes (likeness, silhouette, seams, face, style); **the verdict comes from the fixed threshold table, not the model** — mesh numbers cap the seam score; rejected attempts redo with new seeds (retries 0..3, best kept); every verdict journals to `<library>/learning/autoreview.jsonl` (`source:"auto"`); the «Check» tab shows scores, reasons, models and frames | ✅ | ticket 08 (`d67abac`), `server/autoreview.mjs`, `scripts/blender/steps/orbit_render.py`, `src/AutoReviewPanel.jsx` | live T2 loop: seed 505 → `likeness 2 is under 4` → auto-retry seed 855199914 → accepted `best=1`; journal + record + real PNG frames on disk; 12 tests incl. all absence paths |
| 2 | The review model is ticket 14's pick; which model answered and **why it was chosen** is part of every journal line | ✅ | `server/vlm.mjs`, `server/ollama-run.mjs` | `modelReason: "qwen3.5:9b is not installed - taking qwen3-vl:8b"` in the live journal |

## Cluster F — model and hardware honesty

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | The 2D tab's base model becomes FLUX.2 klein **4B** (Apache-2.0 GGUF, commercial-safe): component `flux2` retargeted, notices reworded (the last non-commercial FLUX caveat of this branch disappears); an existing 9B is reported and left on disk for the user | ✅ | ticket 09 (`8986276`), `installer/manifest.json`, `THIRD_PARTY_NOTICES.md` | `-ScanOnly` live row + install-scan/version-rule tests |
| 2 | Pixal3D on Blackwell without "no kernel image": the installer **probes** the real card (torch, CUDA, compute capability), installs the matrix row's wheel, then runs a live `na2d` kernel check with one repair; pre-sm_75 cards get the honest lighter-set recommendation; `install-pixal3d.sh natten` re-checks both Pixal3D environments | ✅ | ticket 11 (`991ad8d`), `installer/pixal3d/imaginarium_natten_probe.mjs`, `linux.nattenMatrix` | live on the 5070: the pinned wheel carries sm_120 kernels (na2d finite forward), probe reports `nothing to fix`; seams prove the older-card branch; 6/6 tests |
| 3 | klein-4B *drawing* on this machine (weights present) | ⚠ | ticket 09 kept the old 9B unused per its rule | swap logic seam-tested; a fresh-install demo belongs to the next card that runs the installer end to end |

## Cluster G — installer resilience and hygiene

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | «новое, проба»: experimental components (`triposg*`, `sound`, `qwenedit`, `skintokens` when it lands) carry a badge and are **never preselected by any preset** — stricter than upstream (their low-VRAM TripoSG forcing stays Windows-side; this branch's opt-in is unconditional) | ✅ | ticket 12 (`f7986bd`), `installer/imaginarium_scan.mjs` `EXPERIMENTAL`, panel badge | live `##ITEM` rows (empty presets + marker) + rule-pinning tests |
| 2 | Network survival: hf-mirror.com fallthrough behind the sha256 gate (a substituted file cannot pass), one full re-download of a damaged file before the named honest failure, clips mirror chain from the manifest (ships deliberately **empty** — no checksum-verifiable public copy of the repack exists; no invented mirrors), `say()` never aborts on an unwritable install log (the 0.6.6 Linux form) | ✅ | ticket 16 (`13156e9`), `installer/imaginarium_download.sh`, `install.sh`, `install-pixal3d.sh`, `install-vfx.sh` | 6 new offline download-core tests (blackhole/mirror/corrupt fakes); 23/23 in that file |
| 3 | Dead third-party generator links no longer kill the VFX install: catalog entries carry an `optional` dated reason; install names and skips them, the tab distinguishes skipped-optional from missing, the site link stays | ✅ | ticket 15 (`1604176`), `server/vfx-tools-catalog.json`, `scripts/vfx/install-vfx.sh`, `src/VfxPanel.jsx` | live blocked-URL demo (`SKIPPED (optional, pixaflux)` + exit 0) + skip-vs-fail shell probe |
| 4 | Ollama local-first: the studio starts Ollama when nothing answers on 127.0.0.1:11434, offers only installed models (live catalog), the Connections choice + `IMAGINARIUM_REVIEW_VLM` precedence, and the pick's reason is recorded wherever a verdict is made | ✅ | ticket 14 (`a6ce9d3`), `server/ollama-run.mjs`, `server/vlm.mjs` | network-namespace recovery demos (boot / dead / user choice) |
| 5 | One bad field no longer costs every setting: a `config.json` that is valid JSON with a foreign key or a rejected value is read field by field — offender defaulted, everything else survives, the file untouched; a non-JSON file still moves aside (0.5.1 rule) | ✅ | ticket 17 (`8d132d1`), `server/schema.mjs` | live boot demo with the ticket's hostile config + tolerant-read tests |
| 6 | 0.6.6's updater-429 fix | 🚫 by decision | no updater on this branch (Q5) | — |

## Deviations from the shipped Windows line (all decisions)

| Line | Decision | Where recorded |
|---|---|---|
| Imaginarium Engine + plugin plumbing (TripoSG-in-Engine, generator plugin verbs, self-learning LoRA) | **Deferred** — mappings land as workers (TripoSG, Sound) on stock ComfyUI; documented absent by name | ADR-0004 §0.6.6 amendment; Cluster A row 3 |
| Provenance/licensing machinery (afmk watermarks, MODEL_LICENSES, core-manifest, `AFC1` certificates) | **Excluded** — sound exports carry no marks; OGG comments sanitized only against product-name keys | ADR-0004 §6; Cluster C row 2 |
| Updater, telemetry, keys-server (incl. 0.6.6's updater-429 fix) | **Excluded**; only message patterns mirrored | ADR-0004 §6; Cluster G row 6 |
| AMD/ROCm | **Deferred** — no AMD hardware to verify against (unchanged) | ADR-0004 §6 |
| Windows frontends (`Setup.cs`, `Install.ps1`, WPF 0.6.x additions) | **Frozen** per ADR-0001; the generator-choice ticket (10) stays unsent by owner decision | Cluster header note |
| Low-VRAM quick-preset TripoSG forcing | **Not ported** — «новое, проба» opt-in is unconditional here | Cluster G row 1 |
| Clips GitHub-copy fallback | **Mechanism only, list empty** — no public copy of the retargeted repack is checksum-verifiable; inventing a mirror refused (supply-chain rule) | Cluster G row 2 |
| Single folded release (no Linux 0.6.0–0.6.5) + 0.6.10 open decision | Disclosed above and in the spec | header; ADR-0004 §0.6.6 amendment |
| SkinTokens | **Refused on license grounds** with the reasoning public (GPL-vendored encoder assert, no clean substitute) | Cluster B; `docs/product/skintokens.md` |

## Similarity-audit trail (Protocol v2, decision 4)

| Ticket | Verdict | Notes |
|---|---|---|
| 01 TripoSG worker | PASS | — |
| 02 installer + auto rule | PASS | — |
| 03 skintokens refusal | PASS | — |
| 04 Sound tab | PASS | — |
| 05 MCP sound family | PASS | — |
| 06 style bible CRUD | PASS | — |
| 07 Qwen-Image-Edit style gen | PASS | CRLF damage (2 docs) caught and fixed **before** commit; junction-anchor classification (payload bundles the same lineage files — attribution by `git diff -U0` added-lines) |
| 08 auto-review | PASS | independent auditor re-implementation proved ticket 08 added zero new shared 8-grams to the lineage-bundled files |
| 09 klein 4B swap | PASS | one 83-token run decomposed field by field as own-HEAD lineage + public pins |
| 11 NATTEN probe | PASS | band-edge 40-run = the canonical node:test import preamble |
| 12 opt-in rule | PASS | single 105-token junction (2 tokens added) |
| 14 ollama run + pick | PASS | — |
| 15 VFX optional | PASS | payload 0.6.5/0.6.6 ships its own implementation of the same feature — zero shared sentences; the `optional` key name is the T3 contract |
| 16 network resilience | PASS | no (D); shared literals = T3-dictated line + public host |
| 17 tolerant config | PASS | — |
| 13 closeout | this report | retroactive audit re-run below |

No FAIL→rewrite cycles this wave (the 0.5.1 wave had three; the gate held on first pass fifteen
times). Live-caught defects during demos are recorded with their reproduction on their tickets:
`reference_latents_method` plural (07), orbit camera unassigned (08), ollama `think:false` ignored
→ vlmAsk reasoning-ON escape hatch (08), `cp\d{2,3}` wheel regex (11).

**Retroactive audit re-run at this release** (`scripts/audit/similarity-audit.mjs`, k=8, corpus =
all eight payload trees 0.4.6…0.6.6 — 13 619 reference files vs 541 tracked; evidence file
[`similarity-audit-0-6-6.evidence.json`](similarity-audit-0-6-6.evidence.json)). The pre-existing
(ADR-0003-era) tree buckets are **unchanged** from the [0.5.1 audit](similarity-audit-0-5-1.md) —
identical worst runs (`ship_gen.py` 35 973 etc.): the 0.6.0/0.6.5/0.6.6 trees bundle the same
lineage files, so widening the corpus added no new contamination to the grandfathered body, and
the rewrite campaign (09a…09j) continues unchanged. The tool's own wave split (files added since
v0.5.0) mixes both waves; splitting the evidence for **this wave's 34 added files** only: 31 carry
a ≥8-token run — 25 review-band, **6 rewrite-band by raw rule**, all containment-trivial
(≤0.148): `installer/sound/manifest.json` 135 (public pins), `src/SoundPanel.jsx` 54 (junction),
`tests/autoreview.test.mjs` 51 (own-HEAD fixtures), `server/triposg.mjs` 49 and `server/styles.mjs`
40 and `tests/natten-probe.test.mjs` 40 (HEAD idioms / canonical import preamble) — every one of
them already classified ADDED-vs-inherited with PASS by its per-ticket fresh-context audit (the
per-ticket table above); 3 files clean outright. Wave files add no new shared expression; the
retroactive rewrite duty stays exactly where the 0.5.1 audit left it.

## ⚠️ rows and carry-overs

| Row | State |
|---|---|
| Unreal in-editor execution; Unity C# importer | unchanged from 0.5.1 — no editors on the verification machine, data-level verified |
| AMD/ROCm | unchanged — deferred, no hardware |
| klein-4B drawing on this machine | ⚠ — swap logic seam-tested; this card still holds the old 9B (left per policy) |
| Windows 0.6.x WPF surfaces | ⚪ frozen |
| Ticket 10 (generator-choice UI) | owner decision: draft stays unsent |
| `09j` (0.5.1-wave lines inheriting HEAD strings) | **stays open** — the wave strings inherit HEAD content whose rewrite campaign (09a…09i) is not finished; re-verification duty unchanged, now also covering the 0.6.x wave strings that anchor on HEAD idioms (auditors classified each as inherited; none authored) |

## What "done" meant for this wave

Tickets 01–09 and 11–12 and 14–17 green through the similarity gate (per-ticket records under
`.scratch/imaginarium-060-reintroduction/issues/`) · the suites above green at every commit ·
live Linux demos per cluster (TripoSG job → GLB, Sound audible, MCP client session, style-bible
set in 48 s, the auto-review reject→redo→accept loop, NATTEN forward on the 5070, network
blackhole/mirror/corruption fakes, config-boot hostility) · this report + the ADR amendment +
README parity (en/ru) naming the three parity installers + `package.json` 0.6.6 + tag `v0.6.6`.
