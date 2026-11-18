# Imaginarium 0.7.9 — acceptance report (the performance wave + the Windows 0.7.2→0.7.9 fold, re-derived on Linux, shipped once)

This tree (`linux-support`) is version **0.7.9**. It carries everything the
[0.7.1 acceptance report](acceptance-0.7.1.md) covered — the 0.4.16 feature set, the Windows
0.5.x/0.6.x lines and the folded Windows 0.6.7→0.7.1 stretch — and adds two more: a
**performance wave** (tickets 44–49, `.scratch/imaginarium-1110-performance/`) driven by this
machine's real cards and a real 4M-triangle mesh, and the fold of the Windows releases
**0.7.2 through 0.7.9** (tickets 50–60, `.scratch/imaginarium-1115-079-fold/`), re-derived under
Protocol v2 ([ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md)): T1 intent from
the public notes and sanctioned channels, T2/T3 facts through the spec channel only; implementing
contexts never read the extracted payload trees; every code commit gated by an independent
fresh-context similarity audit recorded per ticket. The fresh-context gate earned its keep again
this wave: on ticket 54 the auditor hashed the installed 3.8 GB file against the pin and caught
that the implementer had recorded the resolve URL's transport ETag (a xet hash) where a sha256
belongs — the corrected pin is the content oid (matching the HF LFS oid, the `x-linked-etag` and
`sha256sum` alike), and the wrong value would have silently refused genuine weight reuse for that
model.

**Positioning.** The Windows author ships one installer; this branch ships the same product for
Linux — same studio, same engines, same Blender lane — re-derived rather than ported, and every
parity claim below is stated as measured on this machine or recorded as a deviation. Where the
0.7.x line grows closed bodies (the Rust core, subscription-gated studios), this release says so
and stays outside them; where it fixes what users actually hit — network honesty, small cards,
LODs, the 5.2.4 LTS Blender — the fix lands here too, in this branch's own architecture.

**Retarget record #4 (disclosed, user-directed).** The wave of the 0.6.10 era has retargeted
three times (records #1–#3 in the 0.7.1 report). This wave launched toward
`0.7.2→0.7.4`-territory while 0.7.5–0.7.9 kept arriving, and the fold target became **0.7.9**
by user order on 2026-11-15, before any tag; `spec.md` of the fold wave carries the record.
The base stays `v0.7.1` (`d20b03e`); that tag moves to `v0.7.9` at this closeout — it was never
pushed, so nothing is revoked and no interim Linux 0.7.2…0.7.8 tag ever existed or will.

**Artifact honesty.** The payloads backing this fold are the extracted trees **0.7.3** (public
notes 0.7.2–0.7.3) and **0.7.9**; the 0.7.4…0.7.8 rows rest on the public release notes and on
the 0.7.9 payload's embedded notes, as the fold spec's fact digest records. The Linux
`AstraForge-0.7.9-linux.tar.gz` that arrived alongside is **not** an audit-corpus source: it is
the same author's build of the same product (like every payload, quarantined from the reading
contexts; recorded here because a Linux artifact is new in this lineage).

Statuses (as before): ✅ implemented · 🚫 excluded by decision · ⚪ not applicable on Linux
(frozen Windows surface) · ⚫ already covered by shipped branch code (probe evidence) · ⚠️
implemented but unverified on this machine.

## Cluster N — the performance wave: measured, not assumed (tickets 44–49)

The wave's premise: the 0.7 line's Windows speed claims rest on machinery this branch either owns
or can measure. Every row below carries its own number or its own honest ⚫.

✅ **Ticket 44 — the fp8 UNet tier, measured on two cards** (`d05175a`): the 0.7.1-era sentinel
(ticket 43) only caught the paging symptom after minutes; the cause is the fp16 UNet itself. When
the card is NVIDIA and ≤ `IMAGINARIUM_VIEWS_FP8_MAX_MIB` (default 16384, env `IMAGINARIUM_VIEWS_FP8=auto`),
the views node now runs `pipe.unet.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn)`
per-MODULE (the shipped diffusers do not expose it on pipelines) after the adapter loads and
before the upload; the VAE is deliberately not cast (its `force_upcast` float32 path collides).
The mechanism was corrected mid-ticket by probe: layerwise casting is **ON-CARD** (fp8 masters
resident, blocks upcast per step) — the wrong "streams from CPU RAM" reading failed with a
`mat1 is on cuda:0 … on cpu` error and no shipped line carries it anymore. Measured on this
machine (RTX 5070 12 GB with a desktop session; RTX 5060 Ti 16 GB, user-blessed): fp16 at the
production shape is **refused before step 1** on the 12 GB card (both at 640 and at the 512
fallback — ComfyUI's own budget), 9.61 GB peak on the 16 GB card; fp8 peaks **6.45 GB** at 640 px
/ 4 views on both and **5.87 GB** at 512 px / 6 views, costing ~0.1 s/step. Full table and
mechanism: [`views-low-vram.md`](../forge/views-low-vram.md) (which also repairs the dangling
`comfy_client` citation). The fp8 path loosens only its own step sentinel (10 min); the fp16
5-minute semantics stay. k=8 REWRITE (40) ruled **provenance-mandated** with a stronger chain
than the implementer offered: the matched sentence is ours since `cce8c29` (0.3.0) and the whole
corpus file is byte-identical to our HEAD copy after line-ending normalization — shared ancestry
in its purest form.
⚫ **Ticket 45 — CFG-batch halves, closed on ticket 44's numbers**: the upstream cure for cards
that still fail after fp8 splits the diffusion step's 2N batch; measured, the widest shape this
branch picks (512 px, 6 views) peaks at 5.87 GB in fp8 — under the 8 GB-class budget with room —
so the branch does NOT vendor a split pipeline. The honest caveat is on the record: no 8 GB card
was physically here; the margin and the sentinel carry the contingency.
✅ **Ticket 46 — imaginarium-mesh-rs: the studio's own decimator** (`795e506` + `31bde28`): a
branch-original MIT crate over **vendored, pinned** meshoptimizer v1.3 (per-file sha256, built
offline, never downloaded) with the carry contract proven in Rust tests (rig weights, vertex
colors, custom normals, shape keys survive 1:1; face attributes refused with `carried.dropped`).
The salvage chain tries it FIRST (budget→halve logic unchanged, `IMAGINARIUM_SALVAGE=blender` forces
the old route byte-identically); the live before/after on the 3 998 792-triangle fixture: **24.9 s
→ 0.38 s**, exactly 2.5M triangles out. The gate earned its keep twice: it REWRITE-flagged the
first test-fixture builder (verbatim from the salvage lane — rewritten from scratch), and it
taught the scanner to classify untracked files and moved lines.
✅ **Ticket 47 — closing 0.7.1's Bevy ⚠️ row with a live session** (`f0bea2a`): the bridge was
installable and the stdio surface proven in 0.7.1, but nobody had driven a RUNNING game. This
wave did: player starter on xvfb (Vulkan on the 5070), 52 MCP tools, `imaginarium/play_clip` live
in `rpc.discover`, and the attack clip visible in the numbers (x = 0.25·0.633 = 0.15825 captured
after the agent's call). Defect found and fixed with a regression test: the `installBrpMcp`
curl fallback had never actually run (`curl … -- <url> -o <file>` reads `-o` as a URL — the unit
lane always injected `fetchImpl`); the docs gained the verified game-side shape (the bridge's own
README omits `RemoteHttpPlugin` — on bevy 0.20.1 verbs register but 15702 never binds). The
auditor re-launched the game itself; the fresh launch reads the idle phase before the call — the
proof is stronger than the owner's run.
✅ **Ticket 48 — hidden-arms landmark pass, closing 0.7.1's drift ⚠️** (`b38f1a5`): the recorded
0.08–0.12 m shoulder/elbow degradation on arms inside the torso silhouette is now **≤ 0.034**
(probe reproduced the exact record, named the losing stage — `free_chains` never sees where the
arm sinks — and shipped one targeted mechanism: when the chain top falls below the armpit window
and the visible chain is a straight hanging line, its fitted axis is extrapolated through the
band's INTERIOR (`_buried_shoulder`, confidence `S_src="interior"` ranked below a measured
shoulder, never smuggled). Baseline cases byte-identical; markers override still rules; the
teeth were proven by the auditor monkeypatching the pass off (drift returns to 0.1226).
✅ **Ticket 49 — collapse before planar on heavy meshes** (`c45e57a`): the branch's `cleanup`
could spend its whole budget in the planar DISSOLVE; above `planar_wait_above_tris` the COLLAPSE
stages now run first. The audit record is the wave's process poster: the first implementation had
inherited the upstream param **name and default** (150000) from the planner's tree-reading
workpaper — a T2/T3 leak the per-ticket gate CAUGHT (it was never in the public note); the fix
was **re-derivation, not disclosure**: branch-native name, default re-chosen from this machine's
measured cost table (planar dissolves 2.7 s @ 40.8k → 193 s @ 202.5k → killed > 45 min @ 410k;
default **120000**, just under the cliff). `=0` reproduces the old order exactly. This is also
the row that motivated imaginarium-mesh-rs's sub-second answer (46).

## Cluster O — the 0.7.2 → 0.7.9 fold (retarget #4; tickets 50–60)

Public notes 0.7.2…0.7.9 drove this cluster; the fold spec's fact digest records each row's
verdict before code. Two rows were closed ⚫ by probe (51, and the clips half of 55) and the
rest shipped; tickets 53 and 59 were never issued (the spec table skips them — recorded so the
numbering gap is not read as a lost ticket).

✅ **Ticket 50 — language parity, guards not strings** (`63ccef8` + `f56f948`): the four surfaces
(imaginarium_scan rows, components.mjs, ComponentsPanel, install.sh `say`) probed clean — so the fix is
structural: an EN-display guard (Cyrillic before a comment marker in the EN-only scan/installer
surfaces fails), a functional sibling running `scanItems` over three machine shapes asserting
every display field English, and a JSX text-node guard proving ComponentsPanel has zero raw text
nodes (a hardcoded string in the RU skin is now a red test). The installer-language decision the
ticket asked for is **recorded EN-always** (standalone pre-studio context, bug-report pasteability,
machine contract). The audit caught the new guard being **vacuous** for text inside a top-level
component (whole-file brace collapse) — fixed with teeth re-proven by injecting raw text into the
panel's return region.
⚫ **Ticket 51 — Pixal3D residency on ≥16 GB, closed by probe**: the branch never had the problem
the note cures. One process, one `Trellis2LoadModel` for the whole job (coarse→512→1024→decode
are nodes of ONE prompt graph, so ComfyUI's node cache is the residency), release-on-idle in
`finally`, and the ticket-21 handover already frees the card for other engines. The economical
knobs are all already on (`low_vram:true`, tiled decoder, CuMesh); a retry over the same graph
would fail the same way. The one-line lever for a future ≥16 GB report is recorded, deliberately
unimplemented on a 12 GB card where it can never be measured.
✅ **Ticket 52 — klein 4B stays the default; 9B returns as an explicit opt-in** (`c8542c4`): the
9B pins are not invented — they are **field-wise byte-identical restorations of this branch's own
history** (`git show 8986276^`), which is also the audit's REWRITE ruling: factual download pins
for the same public files converge on the same bytes; provenance is our git lineage, never the
payload tree. Explicit-only is enforced at every auto path (the auto chain filters
`commercial !== false`; `assertEngineWeights` demands the engine's own files by name before the
first upload — with only 9B weights on disk, auto names the missing 4B and says so, never quietly
draws on non-commercial weights). The Components row rides no preset and asks a `confirm` that any
future non-commercial row inherits; the license warning chain (record → panel → ASSET_INFO) was
already there and the 9B inherits it. The flux2 row's "9B kept and unused" note is rewritten away
exactly when the 9B is actually installed (tested both ways).
✅ **Ticket 54 — Hunyuan3D-2mini: the small shape model, and `auto`** (`018e34e`): the 0.7.4 note
promises a 6–10 s shape at ≤4.2 GB; the pin rests on live probes, not memory — official
`tencent/Hunyuan3D-2mini` repo, the plain mini (NOT the guidance-distilled `-fast`, whose
`guidance_in` would need a second sampler knob this branch has no measurement to justify), its
content sha256 — the HF LFS oid, triple-verified against `x-linked-etag` and a `sha256sum` of the
installed file (the first pin carried the transport ETag; the audit caught it, above) — and size,
a remote safetensors-**header**-range probe proving the
file self-contained (`conditioner`+`model`+`vae`, the same shape as the installed 2.0 file), and
this runtime's ComfyUI core carrying `Hunyuan3Dv2mini` auto-detection (`depth: 8` — confirmed
against the same header). `shapeModel` grows `hunyuan2mini` + **`auto` as the new default**: auto
picks mini only when the file is installed AND the branch's one 9216-MiB seam (ticket 37 — no
second number) says the card is small; unknown VRAM is "not small". Explicit `default` stays
byte-for-byte the pre-0.7.9 path, and old persisted job records are untouched. The file rides the
**quick** preset too — it is what small-card users install. The one deliberate default flip of
the wave (per the note's own "default on ≤8 GB"), recorded as deviation #17 below. Live run on
this machine (12 GB class): explicit-mini job through the real pipeline **completed** —
`modelCheckpoint: hunyuan3d-dit-v2-mini.safetensors`, 22 s wall to GLB, **7038–7047 MiB**
nvidia-smi peak vs ~2537 MiB desktop baseline (**~4.5 GB net** — the note's ≤4.2 GB class), zero
new OOM lines in comfy.log; an actual 8 GB card stays an honest ⚠️ (deviation #21).
✅ **Ticket 55 — network honesty** (`520e0e4`): the torch wheel sites gain PyTorch's official R2
twin (`download-r2.pytorch.org`, probed live: same simple index, per-file `#sha256=`, uv verifies
whichever host answered — the sanctioned mirror the "no invented mirrors" rule was waiting for)
across all four wheel sites; `HfGate` turns a dead Hugging Face into ONE named reason per run and
a periodic re-probe (interactive waits, unattended refuses after 3 rounds — a job nobody watches
cannot hang), with zero probes for non-HF URLs and zero for files already on disk. The clips
archive (0.7.4: "author now publishes the source") probed to **⚫ recorded deviation**: the
publisher serves no archive (every candidate path 404, library.json carries no checksums, no
author-published GitHub archive found) — an invented mirror stays the one move worse than a
failed download, and the v0.6.6 empty-chain note now carries today's probe.
✅ **Ticket 56 — LOD files and compact GLB** (`9c19bc1`): `convert` grows `lods` (exact triangle
fractions — imaginarium-mesh-rs primary, proven 512/127 exact with skeleton+clips carried — and gltfpack
`-si` as the honest approximate fallback with its band) and `compress`/`quantize` (separate
`.compact.glb` with EXT_meshopt_compression; main files stay plain because Godot cannot read the
compressed form — the auditor had Godot 4.7.2 verify both halves: three plain files import clean,
the compact one is rejected). gltfpack is a new installer component: official GitHub release,
sha256-pinned, all presets, purely additive installer surgery (the one-token splices kept the k=8
scan clean). Probe facts shipped as code comments: gltfpack drops animations without `-ac`, and
without `-noq` the "plain" fallback files would secretly carry KHR_mesh_quantization.
✅ **Ticket 57 — Pixal3D fast-fail; cancelled is not an error** (`810629c`): the slowness was one
step later than the note's summary — the ComfyUI venv python behind concept prep was only reached
after minutes of LLM+SDXL work; `pixal3dPreflight()` (exported, source-order-tested to run first)
answers with the ticket-25 sentence verbatim — which component, which command — in milliseconds.
`batchCounts` splits `cancelled` into its own row: the Forge batch UI shows it as a settled
segment, not an error badge.
✅ **Ticket 58 — Blender 5.0.1 → 5.2.4 LTS** (`1124209` + the lane proof below): the pin half
landed before the supply-chain gate (Blender 5.2.4 published 2026-11-10 08:36 UTC → download
allowed 2026-11-17 08:36 UTC): manifest + installer URL/size/sha from the publisher's own
sha256sums (all 7 mirrors HEAD-verified with byte-equal sizes), runtime path, imaginarium_scan candidates,
the docs' version rows. The audit's REWRITE (151-token run of the manifest URL+mirrors+size+sha
line vs the 0.7.9 corpus) was ruled provenance-mandated: the host list is byte-identical to the
branch's OWN 5.0.1 line and the corpus line carries a `minVersion` field ours does not — a copy
did not happen, and publisher constants have one correct byte sequence. The claimed 5.2.4
regression (glTF track-built animations shifted one frame) was probed relevant (`turret_gen`
exports NLA_TRACKS) and then measured away: the exporter maps `seconds = frame / fps` IDENTICALLY
at v5.0.1, v5.2.2 and v5.2.4 (official source) — a long-standing convention this branch already
shipped under 5.0.1, not a bump delta; the live re-check on the pinned 5.2.4 binary: **measured
away there too** — ACTIONS and NLA_TRACKS exports both carry `first_time = 0.04167 s = 1/24 fps`
(frame 1 at 24 fps), byte-equal to the system 5.2.2 measurement: the pinned binary keeps the
convention this branch already shipped under.
The lane proof (the ticket's spine): 5.0.1 baseline **285/3/54** vs 5.2.2 control **286/2/54** —
the delta is `items_kit_plate` (fixed by 5.2.x), the shared pair of failures is the disclosed
pre-existing environment pair (cloth floor + the Windows-font test on a Linux box), skip sets
byte-identical. On the pinned 5.2.4 through the installer's own checksum gate: **286 passed / 2
failed / 54 skipped (480 s)** — per-test identical to the 5.2.2 control: same 342 test tuples,
zero status diffs, the two failures the same disclosed environment pair. The installer's own
scan table afterwards reads `Blender [blender] installed · 5.2.4 · runtime/blender/
blender-5.2.4-linux-x64/blender` — the binary the lane ran is the one the sha-gated download
placed.
✅ **Ticket 60 — six small honest probes** (`a55e46c`, 24 files): Components progress never lies
(a percent prints only with a denominator; unknown-size work gets an indeterminate bar; a 90 s
silence says "no new data"), the port contract (`take_port` names the holder, advances bounded;
`port.json` is the single truth read by launcher, stop, MCP and forge), the Ollama-folder MOVE
offer (never destructive before verified: staging copy, every blob re-hashed against the checksum
in its own name, originals deleted only after), the retarget remedy sentence ("run rig_humanoid
first"), the paint-camera front lock (mirror plane FITTED per band — a one-side weapon is exactly
what drags a naive median sideways — and yaw pinned through all three fit stages only when the
body mirrors itself; angled concepts still paint angled, the decision rides `camera_front_lock`),
and RU text→3D without an assistant (the concept draws from the text as written with an honest
`conceptNote`; a live assistant that fails to translate is still the old honest error; abort
parity kept).

## Excluded from the fold, with reasons

🚫 **0.7.6's Rust-rewritten Forge hot paths** (fingers 54→16 s, tail 70→35 s, face 131→63 s):
their host is the closed `imaginarium-rs` core's Forge (standing closed-binary posture — no
published source, checksum or attribution; the imaginarium-mesh rule applies automatically). What this
branch owns stays: this wave's imaginarium-mesh-rs + planar-wait + fp8 rows are the honest Linux answer on
the same classes, each with its own measured number.
🚫 the subscription/content-studio/launcher line (0.7.x, unchanged: the 0.7.1 report's reasons
stand), 🚫 cloud/points/Shop, 🚫 AMD/ROCm, 🚫 telemetry/journals, 🚫 engine-plugin files beyond
the perf wave's scoped MV-Adapter memory-layer lift (ticket 44's `imagi_views.py` is the branch's
own patch copy), 🚫 Windows frontends (⚪ where Linux-irrelevant). Deferred-candidates list for
the next wave (recorded, not decided): Open-in-Blender + version history, mechanism builder,
2D-pack line, character pack, motion-from-text, voice input, remote engine, Omni (license
posture first), AutoRemesher (GPL-external-component posture first).

## Deviations from the shipped Windows line (this wave's additions, all decisions)

14. Linux ships 0.7.2→0.7.9 as one release `0.7.9`; there was never a Linux 0.7.2…0.7.8
    (continues the 0.7.1 list's numbering).
15. Retarget #4 (0.7.2-target → 0.7.9) executed before any tag by user order; the 0.7.9 fold
    rests on public notes + the 0.7.3/0.7.9 payload trees; the Linux tar.gz is not a corpus
    source (positioning paragraph).
16. Blender 5.2.4: the Windows launcher's staged-install-beside-5.0.1 has no Linux counterpart —
    in-place update + flock + the pinned-sha gate (ticket 58's recorded deviation).
17. `shapeModel` default flips to `auto` (theirs: mini is the default on ≤8 GB) — the wave's one
    schema-default flip, per the note's own wording; persisted job records and the explicit
    `default` path stay byte-for-byte.
18. imaginarium-mesh-rs is vendored meshoptimizer built from source, never downloaded; the closed
    af-mesh.exe stays excluded (ticket 46 answers the speed rows branch-Originally).
19. Clips stay per-file: the 0.7.4 "one archive" claim could not be verified against any source
    this branch is allowed to trust (⚫ recorded, probe in the ticket).
20. `gltfpack -si` approximations land inside a declared band (warned in step stats), never
    silently relabeled as exact; imaginarium-mesh-rs stays primary where it exists.
21. No 8 GB card exists on this machine: ticket 44/45/54's small-card claims are carried by
    measured headroom (5.87/6.45 GB peaks), the 9216-MiB seam's unit matrix, and the sentinel —
    not by an 8 GB live run (⚠️ rows below).

## Similarity-audit trail (Protocol v2, decision 4)

Every ticket carries its own fresh-context audit PASS on its issue file, with the per-commit
ADDED-token-run scan (clean <8, REVIEW 8–39 adjudicated, ≥40 REWRITE fails unless a fresh-context
auditor rules the match provenance-mandated). The wave settled three rulings that now bind the
trail: **factual pins** (t52's 9B pins from `8986276^`, t58's publisher URL/sha line) — a correct
restoration of public constants converges on the same bytes, so a match against a corpus copy of
data is provenance, not copying; **shared ancestry** (t44: a 40-token run whose every token
pre-exists in our history since 0.3.0, the corpus file byte-identical to HEAD after line-ending
normalization) — and its practical corollary: corpus trees ≥0.7.0 include snapshots of this
lineage's own LATER releases, so future scans will keep producing such hits; **mega-line
re-wraps** (t50's JSX line, t54's 43-token run on App.jsx: the verbatim span exists in HEAD's
line) — editing one long line counts the whole line as added; provenance checks span-by-span.
The gates also caught three real defects this wave that the implementing context had missed
(t49's inherited param name+default from a planner workpaper — re-derived, not disclosed; t50's
vacuous guard — fixed with teeth; t54's `sha256` pin holding the resolve URL's xet transport ETag
instead of the content hash — caught by hashing the installed file, a step the implementer had
skipped), which is exactly what the fresh-context gate is for.

**Retroactive audit re-run at this release** (`scripts/audit/similarity-audit.mjs`, k=8, corpus
= all **sixteen** payload trees 0.4.6→0.7.9 (0.7.3 + 0.7.9 new since 0.7.1; the Linux tar.gz
excluded), base `d20b03e` = the v0.7.1 release): 22 595 reference files × 595 tracked — of the
wave's own files, **11** carry runs ≥8 tokens; the worst is the vendored stock
`meshoptimizer/LICENSE.md` (202 tokens, containment 1.00 — published license text, exactly the
0.7.1 precedent), and every real addition is ≤48 tokens × ≤0.08 containment (node:test / Rust
manifest boilerplate matching the branch's OWN tests and crates). The multi-thousand-token runs
on files like `ship_gen.py` are the disclosed ADR-0003-era body plus self-lineage (corpus trees
≥0.7.0 contain snapshots of this branch's own later releases) — unchanged in meaning from the
0.7.1 report's headline. Evidence file: `similarity-audit-0-7-9.evidence.json`.

**Closeout-doc gate** (the same k=8 method over the closeout's own staged files): README.md,
README.ru.md, docs/linux.md, ADR-0004, package.json — **all clean** (max run 0). The acceptance
report itself scans one REVIEW: a 12-token run (`fingers 54 16 s tail 70 35 s face 131 63 s`)
against `0.7.9/installer/notes-0.7.9.txt` — this report is quoting the author's *published*
0.7.6 speed claims, and the quote's provenance is the fold spec's own fact digest (spec.md line
58), the sanctioned channel; publisher-fact quotation, same ruling class as t52/t58. The evidence
JSON is tool-generated audit output — its excerpts quote the corpus by construction and it is not
prose subject to the scan; it was produced by the committed runner (`scripts/audit/`) with the
full command line recorded above.

## ⚠️ rows and carry-overs

- ✅→closed: 0.7.1's Bevy live-session ⚠️ is closed by ticket 47; 0.7.1's hidden-arms drift ⚠️ is
  closed by ticket 48's measured numbers. Both had been carried honestly; now they are history.
- ⚠️ No 8 GB-class card on this machine: the fp8 tier (44), the CFG-halves ⚫ (45) and 2mini's
  auto-default (54) rest on measured peaks (5.87/6.45 GB), the 9216-MiB seam's unit matrix and a
  12 GB live run — the contingency wording lives in `docs/forge/views-low-vram.md` and the tickets.
- ⚠️ 0.7.1's owner-flagged UI surfaces, unchanged in posture: visual review stays on the owner's
  side; ticket 60's progress-bar and cancelled-segment are new surfaces in the same bucket.
- ⚫-recorded: the clips archive (55) and Pixal3D residency (51) carry their probe evidence; if
  the author publishes what 0.7.4 claimed, both tickets' records name the exact lever.
- FINDING-1 carried (ticket 54's live path surfaced it): the Hunyuan job pipeline trusts
  persisted fields at the step-map seam — a job record created without `quality` (possible only
  by calling `createJob` directly; the HTTP route always parses through `generationSchema`)
  crashes on `steps` instead of defaulting. Pre-existing, out of the fold's scope; recorded with
  reproduction in the t54 ticket for the next wave's probe list.
- The open campaign on the ADR-0003-era pre-0.5.0 tree (disclosed since 0.5.1) is unchanged;
  everything these two waves added is ADR-0004 original, audit-gated per commit.

## What "done" meant for these waves

Tickets 44–49 (perf wave) and 50–58 + 60 (fold wave; 51/45/55-part closed ⚫ by probe; 53/59 never
issued) implemented or verdicted — each with tests at its commit and its PASS audit line; the
closeout shipped this report + README/docs + version 0.7.9 + the retroactive **sixteen**-tree
audit re-run + the `v0.7.9` tag (the unpushed `v0.7.1` moves).

Suites at the release commit, stated honestly: node `npm test` **695 tests / 693 pass / 0 fail /
2 skip**; the Blender lane on
**5.2.4 through the installer's own gate**: **286 / 2 / 54**, per-test identical to the control
(baseline context: 5.0.1 285/3/54, system 5.2.2
286/2/54 — the shared pair of fails is the disclosed environment pair from the 0.7.1 report,
`cloth_sim` floor + `DejaVuSans-Bold`); live runs this wave: the fp8 measurement matrix (44), the
4M-tri salvage before/after (46), the live Bevy game session (47), the hidden-arms fixtures (48),
the 2mini shape generation (54), the gltfpack/Godot import matrix (56), the pinned-5.2.4 install +
frame-shift probe (58).

Nothing is pushed; the author questions carried since 0.7.1 (spec Q1–Q12) stay open here for the
author.
