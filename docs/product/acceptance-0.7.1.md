# AstraForge 0.7.1 — acceptance report (Windows 0.6.6→0.7.1 behavior, re-derived on Linux, shipped once)

This tree (`linux-support`) is version **0.7.1**. It carries everything the
[0.6.6 acceptance report](acceptance-0.6.6.md) covered — the 0.4.16 feature set, the Windows
0.5.x line, and the Windows 0.6.0→0.6.6 line re-derived as one Linux release — and folds three
more stretches: the shipped Windows patches **0.6.7 through 0.7.1**, re-derived under Protocol v2
([ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md)): T1 intent / T2 observed
behavior / T3 interface facts through the spec channel only; implementing contexts never read
the extracted payloads; every commit gated by an independent fresh-context similarity audit
recorded per ticket under `.scratch/astraforge-0610-reintroduction/issues/`.

**Parity line and artifacts.** Windows shipped fourteen patches after 0.6.6; the installers that
actually arrived are **`AstraForge-Setup-0.6.8.exe`** (61 121 536 B, md5
`8fc2d345501e1abea7637be1a73f3846`, sha256 `2957f4a9993a894ac6ed5d2f1c52c0c2837a935966a3a013f0f9c5867653e805`),
**`AstraForge-Setup-0.6.10.exe`** (61 570 560 B, md5 `49a32878c1bb26918a508e4c0dc6f813`, sha256
`bb5c6e768304a35eff4dcddd95bd8f45997996eb03c1babdf32960d8a811cfbd`),
**`AstraForge-Setup-0.6.12.exe`** (62 298 112 B, md5 `2a58c9d62e4de282bea244d26f00ae43`, sha256
`13cae7da19a485ea572941912e2e0396932ae53260ae90ea56610eec891e7f4e`),
**`AstraForge-Setup-0.6.18.exe`** (62 412 288 B, md5 `458223df82e2b291b089b38dd06e021f`, sha256
`365dd35a2f22bd51dc40ec6e5d94c971d31b24ec5a056bfe7ee1fcc502305354`),
**`AstraForge-Setup-0.7.0.exe`** (69 168 128 B, md5 `e4213515d8695d042298194b87c9fe5b`, sha256
`966c2f337e8ff2f9bf996ccc76ef26dc54a90c1c2ff1833a9e131face213addd`) and
**`AstraForge-Setup-0.7.1.exe`** (69 173 760 B, md5 `f074a5e56460c6c8262da576f4e5610c`, sha256
`2ee18e651c68d7dad6c4943112d4650497ba67282da373029aa3b0ab38ef09e0`). The 0.6.7, 0.6.9, 0.6.11
and 0.6.13–0.6.17 installers never arrived — their content is observable only folded into the
trees above (recorded deviation, same pattern as the 0.6.6 wave's folded 0.6.1–0.6.4); **0.7.0
and 0.7.1 arrived the same hour, the first time two consecutive installers landed together**,
and no 0.6.19+ installer or notes file exists for the gap between them and 0.6.18 — that window
is folded as a recorded deviation. No public release notes existed for any of these: the intent
came from the `installer/notes-*.txt` files inside the payloads through the planner channel (a
recorded deviation from "published notes", asked of the author in the wave spec, Q1).

**Retarget records (three, all disclosed, all user-directed).** The wave originally ran toward
`v0.6.10`; at its closeout **0.6.12** arrived and the line moved onto it (record #1: ADR-0004's
"Retarget honesty" row — the payload-embedded notes supplied the sourced intent 0.6.10's arrival
had lacked). Before any tag was applied, **0.6.18** arrived (record #2: its payload carries the
0.6.13–0.6.18 notes, adding tickets 34–38). Again before any tag, **0.7.0 and 0.7.1 arrived
together** (record #3: their notes ride both payloads; the line moved to 0.7.1, adding tickets
39–43). Linux ships once at the final target; nothing was revoked, and no v0.6.12, v0.6.18 or
v0.7.0 tag ever existed or will. The acceptance draft written for 0.6.18 became raw material for
this report.

Statuses (as before): ✅ implemented · 🚫 excluded by decision · ⚪ not applicable on Linux
(frozen Windows surface) · ⚫ already covered by shipped branch code · ⚠️ implemented but
unverified on this machine.

## Cluster H — GPU and RAM honesty before Pixal3D (0.6.7/0.6.8 line)

✅ **Ticket 20** — `server/gpu-info.mjs`: real `nvidia-smi` query, `oldDriverText()` refuses
below the 570 floor and answers **null for unknown drivers** — the advice appears only for a
demonstrably old driver, which is also the 0.6.11 "advice only when actually old" behavior
(reused at `server/pixal3d-run.mjs` without a change).
✅ **Ticket 21** — RAM precheck + generator unload before Pixal3D (own mechanism, no Engine
plumbing): low memory explains itself and frees the other generators first, so a retry goes
through — the Linux shape of the 0.6.11 page-file row, which is why that row needed no ticket.
Commits `c527a8f`, `28319b3`.

## Cluster I — installer resilience and concurrency (0.6.8 line + 0.6.11 row)

✅ **Ticket 22** — Ollama models land on the studio drive when the home drive runs short; the
user's own `OLLAMA_MODELS` and existing models always win. Commit `b92e1c2`.
✅ **Ticket 23** — intercepted-download explanation (the SNI/`127.0.0.1` trap documented, not
"fixed") and the NATTEN probe's honest exit-code + 570 reminder. Commit `46d50fb`.
✅ **Ticket 24** — installer concurrency via POSIX `flock` (the Windows exclusive-open semantics
replaced by design), Components busy-state, and the studio detaching the installer with
`pid.json`/`status.jsonl` re-attach. Commit `830151f`.
✅ **Ticket 33** — 0.6.11's free-space fix ported: `FreeText`/`FreeUnder` make an unreadable
reading **unknown, never 0.0 GB** at all four decision points; the hard stop and the plan
warning fire only on a known shortfall; a simulated df failure runs the placement logic clean
(no relocation, no bash errors). Commit `351ddb0`.

## Cluster J — the studio heals itself and speaks the machine's language (0.6.9/0.6.10 line)

✅ **Ticket 25** — venv self-repair at startup: a broken Python link inside a studio venv is
rebuilt in place (`uv venv --allow-existing`), with the heavy rebuild delegated to the
installer's component flow; the studio never deletes. The Windows trampoline repair is
re-expressed as rebuild — recorded deviation. Commit `ab6102a`.
✅ **Ticket 26** — locale: first run follows the OS (`LC_ALL`→`LC_MESSAGES`→`LANG` detection,
never persisted), the choice persists only once made; `GET /api/locale`. The upstream 530 KB
runtime RU→EN phrase-map is the opposite architecture and **not ported** — this branch keeps
its key-based layer with full en/ru coverage — recorded deviation. Commit `ecc528f`.
✅ **Ticket 27** — header RU/EN `LangSwitch` + the Appearance theme chooser (extracted from the
pre-0.3.0 inline block; own-HEAD lineage). Commit `6904984`.

## Cluster K — Bevy joins as the fourth engine (0.6.10 line, the largest ticket set)

✅ **Ticket 28** — the `bevy_package` export profile: the same GLB the Godot profile ships plus
the `af_bevy.json` asset passport (clips `{name,loop,seconds}`, sockets, collider plan, fx,
rig/scene facts) written by `scripts/blender/steps/bevy_package.py` + `_bevy_lib.py`; clip names
are read back from the shipped GLB's JSON chunk (bpy's `.001` renames cannot lie).
Commit `f26b392`.
✅ **Ticket 29** — `bevy/astraforge_bevy/`: the consumer crate, **branch-original MIT written
from the interface facts only** (pins: `astraforge_bevy 0.20.0`, edition 2024, rust-version
1.97.1, bevy 0.20.1 default-features=false `3d`+`audio`, serde/serde_json 1) — one
`add_astraforge_asset` line brings default-clip autostart, transition-blended clips,
socket-mounted effects, `af_sounds.json` banks and hot model reload; every 0.20 API was grepped
from the vendored crates, not guessed. Plus the integrator template + player starter (compiles
against the real 0.20 API). Commit `fa9f385`.
✅ **Ticket 30** — headless validation: `scripts/engines/bevy.mjs` drives the crate's
`af_bevy_check` (behind the crate's `check` feature) when cargo exists — the package's passport
promises are verified against the live Bevy world, two preview frames through the screenshot
pass, four contract tokens (`bevy_check`/`bevy_shots`/`bevy_log`/`bevy_forward`) on the step —
and exports byte-identical-minus-check honestly when Rust is absent. The live check earned its
keep: it caught (and ticket 30 fixed) a real crate bug — bevy_gltf anchors the AnimationPlayer
inside the instance, not at the scene root, and the wiring had waited at the root. Live runs:
static 690k-tri package and a rigged two-clip package, both 5/5 checks, warm cache 4.5 s.
Commit `a1e4cf5`.
✅ **Ticket 31** — MCP + sound parity: `bevy` in the engine enums and every engine verb, the
export profile list, `sound_export {engine:"bevy"}` laying down the
`assets/astraforge/sounds/<slug>/` bank + `af_sounds.json` manifest exactly as the crate parses
it (`astraforge-soundbank/1`, replace-wholesale), the integrator skill updated, and the
`bevy_brp_mcp 0.23.0` bridge installable **only** from the checksum-pinned crates.io file
(sha256 `a6ec60a2…af11`, live-verified against the real download; a tampered file refuses and
cargo never runs — never a bare index install). A live stdio MCP session test proves the agent
surface. Commit `7a44601`.

## Cluster L — keeping what you paid for: the 0.6.13 → 0.6.18 fold (retarget #2)

✅ **Ticket 34** — heavy generations are kept, not thrown away (0.6.13: "simplified to the
limit instead of the generation being thrown away"): `server/mesh-salvage.mjs` turns the
triangle/byte caps into typed, salvageable outcomes; over-cap GLBs go through the branch's own
`cleanup` decimate path (every other knob off) with the budget halved when even the reduced
mesh misses a cap — the live run proved why: a 115 MB/5 242 880-tri mesh came back **67 MB /
623 750 tris, accepted, 115 s, two passes**. Every `.glb` job completion (Hunyuan, Pixal3D,
TripoSG, re-validate) keeps the asset and names the reduction in its message; an un-salvageable
mesh still fails with the original honest error, and 0.6.15's "Surface level at ±1 → try 0"
hint rides the empty/irreducible messages. Commit `36b6577`.
✅ **Ticket 35** — posture is fixed and checked on every styled clip (0.6.13: "no longer roll
the fighters' shoulders back"), probes first, no invented fixes: this branch's retarget never
had the bug (`arm_dir_err_deg` 0.00 measured, plus the existing twist-span gate — recorded, not
duplicated), and `motion_style` now carries the branch's own guard — elbow-crease **twist**
about the upper-arm axis, referenced to the hips SIDE axis (swing-invariant by construction,
proven: ±60° swing moves it < 5°, a 40° humeral roll moves it 1:1), pre-style reference,
offenders rotated back **inside** the tolerance rim and verified by re-measure; death clips are
measured but exempt ("a fall pose is normal", 0.6.14). The 0.6.14 auto-rig modes were probed
against branch code: hidden-in-torso arms degrade 0.08–0.12 m (not broken; the sanctioned
markers fallback covers hard bodies — recorded, next-wave candidate), hollow two-layer models
cannot fail the way they did upstream (the voxel fuse precedes skinning — 0 unweighted of
69 819). A latent `death:"auto"` bug found by the new test (the reference pose read after the
styling loop superseded it) is fixed on the way. Commit `3669bdc`.
✅ **Ticket 36** — install resilience: `PullModel` retries to three attempts with honest lines
(0.6.13), the NVIDIA driver version gains `/proc/driver/nvidia/version` as a second source and
an explicit **unknown** row when both are silent (0.6.14's "it sometimes missed it, hiding the
warning" — the ticket-33 honesty lesson), and an old Ollama server holding port 11434 after a
user update is named once, plainly, with the systemd remedy (0.6.18's loop shape — this branch
never auto-updates Ollama, so the diagnosis replaces the loop ⚪). Commit `8fe6274`.
✅ **Ticket 37** — the 8 GB card (0.6.15): `runWorkflow` POSTs ComfyUI `/interrupt` on Cancel
**and** timeout (the card used to keep computing — proven against a real local HTTP server);
`server/low-vram.mjs` is the one seam (derived from the branch's own 9216-MiB TripoSG seam, so
the installer and the engine can never disagree); views render at 512 px with a 20-minute cap
there; the GPU hand-over unloads resident Ollama models before 3D and **names the processes**
still holding the card when `/free` did not return the memory; the installer's "Full" unticks —
in both the checklist and the whole-preset route — what does not fit: Python Pixal3D with its
weights, Qwen-Image, qwen3-vl:8b. Commit `641c585`.
✅ **Ticket 38** — VFX download honesty (0.6.13): both npm build chains retry ×3 (commands
byte-preserved), and when the author's site answers with a web page instead of the file, the
download core says exactly that — HTML-shaped bytes are caught before the damage verdict, no
pointless re-fetch, no scary tamper wording. Commit `f1630f7`.

## Cluster M — the 0.7.0/0.7.1 fold: what lives outside the closed core (retarget #3)

The 0.7.0 headline is architectural: the Windows studio gained a **closed Rust core**
(`bin/astraforge-rs.exe`, hosting the new node editor and content studio). That whole body sits
on the standing closed-binary posture (🚫 rows below, author questions Q11/Q12). What this
cluster kept is everything the notes state that lives in files this branch owns — each one
audited against the 0.7.x payloads that contain their upstream originals.

✅ **Ticket 39 — `replace_part keep_rig`** (0.7.0: "replacing a part of a model keeps the rig"):
the branch's part-swap step **dropped the rig**; now an opt-in keeps it — the armature rides
`normalize` with the body and is baked with it by a Blender-probed recipe (world drift
0.000000 m, deform identical), the removed piece carries the body's bones, and `_weight_missing`
skins every vertex the swap introduced (part, eye spheres, seam band) via the branch's own
cloth `transfer_weights` on a points-only carrier, so untouched weights are never rewritten;
`replaced.glb` exports skinned. Default **off** — the classic static swap stays byte-for-byte
(theirs defaults true; the branch keeps existing behavior byte-stable — recorded deviation).
Probed first: where the rig actually dies (`prepare_meshes`, whose unused `keep_armatures`
flag became the seam). Lane tests +3: rigged-GLB fixture, default drops, opt-in keeps (asserted
on the RE-IMPORTED GLB: armature, bones, every vertex weighted, body weights exact), static
body + opt-in warns and falls back. Commit `07134ca`.
✅ **Ticket 40 — model-weight reuse** (0.7.0: "weights other programs already downloaded are
connected without copying"): `installer/af_weights.mjs` — a branch-designed scanner over the
**Linux** homes where weights already lie (`ASTRA_WEIGHT_DIRS`, a sibling `~/ComfyUI`, the
Hugging Face hub cache, StabilityMatrix data, a sibling AstraForge), matched by name + exact
byte size, the manifest's pinned sha256 verified **only at accept**, then connected by a symlink
in `data/models` + a `weightLinks` record in the existing `config/paths.json` layer — the user's
files are never moved, copied or touched (their Windows mechanism is hardlinks + folder
registration; the symlink is the Linux shape). `install.sh` offers the found files with the
download size saved (`ASTRA_CONNECT_EXISTING=0` opts out), and af_scan rows read **`installed
(external)`** down to the Components window (en/ru) so nothing re-downloads them. Live machine:
report empty (nothing missing to offer). Tests 8/8 on fake trees, incl. wrong-size refusal,
tampered-bytes refusal, no-pin refusal, real-file-never-replaced. Commit `c85e0ee`.
✅ **Ticket 42 — degraded start, honest messages** (0.7.0: the studio opens even when a server
fails; clear messages for missing Blender / too-old card): probe-first over the three branch
shapes — engine-down at startup is **already honest** (live `/api/status` probe feeds the dots,
engine badges and setup path), old-card refusals **already honest** (af_scan reasons flow into
both checklists), and the one bricked shape fixed: a Forge step spawning missing Blender
answered `spawn blender ENOENT`; it now names the real remedy (`install.sh -Yes -Only blender`
or `ASTRA_BLENDER`), in the ticket-25 idiom, with the errno kept to the log. Commit `cd752f6`.
✅ **Ticket 43 — the paging sentinel on views** (0.7's low-VRAM post-mortem: on an RTX 5060
8 GB a **single** MV-Adapter step ran 24 minutes — the card was swapping — and the job waited
out its 20-minute cap doing nothing): their cures (fp8 layerwise casting, encoder/VAE eviction,
CFG-halves) live in engine files 🚫; the orchestrator fact is branch-owned: `runWorkflow` now
watches ComfyUI's own WS progress frames, and a step outliving 5 minutes (`ASTRA_VIEWS_STEP_MAX_SEC`)
interrupts the engine and fails with the paging diagnosis, the measured step and the real
levers. Their guard is engine-side Python with Russian strings; the branch's is client-side JS
— zero shared lines. Tests 4/4 against a real HTTP+WebSocket fake engine. Commit `398ce60`.
⚪ **Ticket 41 — self-learning idle gate — withdrawn before implementing** (0.7.0: training
starts only after 20 min idle, never on ≤9 GB cards, day cooldown after an error): the branch's
self-learning (`server/forge-learn.mjs`) is a local event-driven journal + recipes with **no
background GPU work at all** — a gate would have nothing to gate; the note governs their
engine-side trainer (standing exclusion). Inventing an idle job to gate it would have been the
wave's first fabricated feature; the number 41 stays retired. Recorded in the spec digest.
⚫ 0.7.1 "Bevy: the engine check no longer fails" — this branch's `af_bevy_check` was live-run
5/5 at ticket 30 and the 0.7.0→0.7.1 diff touches no `bevy.mjs` line: their failure lived in a
path this branch never had. No ticket.

## Excluded from the fold, with reasons

🚫 `bin/af-mesh.exe` + `bin/af_raster.dll` (0.6.12: the 700k-tri cleanup ≈5 s, the 7× camera
fit): payload-internal native binaries with **no published source, checksum or attribution** —
shipping or re-deriving them is wave-scale work, and a closed blob would violate the branch's
license posture. The branch's Blender paths stay — correct, only slower. Headline exclusion,
next-wave candidate; author questions 8 and 9 carried.
🚫 **Pixal3D with texture (C++)** (0.6.14–0.6.17: the colored one-image model, its weight
conversion, the beside-old-Pixal3D install fixes): the same closed-binary posture — no published
source/checksum; covers the 0.6.16/0.6.17 lines entirely and the "on 8 GB always the new
engine" row of 0.6.15. Their `check.rs` frame fix is covered by this branch's ticket-30 gate
(re-captures until content — stronger than restoring the frame). Next-wave candidate.
🚫 **0.7.0 content studio (Brand / Video / Publishing) and the node editor** — the fold's
headline exclusion: the subscription line (the notes themselves: "7-day trial, then works with
an active subscription" — the monetization standing exclusion), their host being the **closed
Rust core** (`bin/astraforge-rs.exe` / `bin/astraforge-mcp.exe`, no published source, checksum
or attribution — the af-mesh rule applies automatically), plus engine capture files and brand
font/panel plumbing. Covers the 0.7.1 content-studio fixes too. Re-enters only if the author
publishes the component (questions Q11/Q12).
🚫 0.7 engine-side low-VRAM machinery (fp8 layerwise casting, encoder/VAE eviction, CFG-halves,
fp8-LoRA hook): engine/plugin files (standing exclusion); its orchestrator-level fact is kept
as ticket 43.
🚫 0.6.13 "the engine no longer sends a false crash report when the studio closed the request"
and the refreshed journals — Engine files and the telemetry/journal line (standing exclusions).
🚫 0.6.11 AMD ROCm fallback · 🚫 0.6.12 engine lifeline · 🚫 license-panel version display
(0.7: license line) (standing exclusions, unchanged).
⚚ 0.6.13's u2net/Godot fallback download addresses: the mirror URLs are not in the notes and no
author-published distribution is confirmed — the branch's "no invented mirrors" rule keeps
downloads GitHub-only until the author answers (wave-spec Q10).
⚪ 0.6.15's small-pagefile warning (Windows error surface; ticket 21's RAM precheck is the
Linux shape) · ⚪ 0.6.15 "damaged studio libraries" reinstall (the Windows-AV shape; on Linux
the venv self-repair of ticket 25 covers the analogue) · ⚪ `Setup.cs`/`Install.ps1` surface
(behavior ported to `install.sh` instead) · ⚪ 0.7's install-over backup folder (a `Setup.cs`
shape; this branch's in-place update model has no recorded "old files to back up" failure) ·
⚪ the 0.7 `ffmpeg` installer component (its only consumer is the excluded video line —
shipping 110 MB with no user is ceremony) · ⚪ 0.7's MCP auto-connect to detected AI apps (the
branch never writes third-party app configs; the integrator skill stays pull-based — absence is
the posture).

## Deviations from the shipped Windows line (all decisions)

1. Linux ships 0.6.7→0.7.1 as one release `0.7.1`; there was never a Linux 0.6.7…0.7.0.
2. All folded intent came from payload-embedded notes via the planner channel (no public notes
   existed for 0.6.7–0.7.1). Author confirmation asked (Q1).
3. Retargets 0.6.10→0.6.12→0.6.18→0.7.1 executed mid-closeout by user order, per the disclosure
   above; the 0.6.19+ gap has no artifact and no notes file and is folded as a deviation.
4. Concurrency: POSIX `flock` replaces the Windows exclusive-open (ticket 24).
5. Venv repair is a rebuild, never a junction/relief of `python.exe` trampolines (ticket 25).
6. The 530 KB phrase-map is not ported; the key-based i18n layer stays (tickets 26/27).
7. `astraforge_bevy` is a branch-original MIT crate; the Bevy passport schema is this branch's
   (documented in `docs/forge/bevy.md`), differing from the upstream crate's format by design.
8. The headless check's window renders off-screen; audio is checked as files; the first check
   pays the Bevy compile, later ones reuse the shared target cache.
9. Posture (ticket 35): the guard watches humeral TWIST pre/post style (this branch's proof of
   what "roll" is), not the upstream clavicle-vs-rest observable; retarget stays on its existing
   gates because the probe measured zero injection — documented, not assumed.
10. Low-VRAM threshold: the branch's own 9216-MiB seam (imported from `server/triposg.mjs`),
    strict-below, shared by installer and engine — no second number.
11. `keep_rig` defaults **false** here (theirs true): this branch never flips the default of an
    existing step inside a patch wave; the opt-in is documented in both registries (ticket 39).
12. Weight reuse links (symlink + `weightLinks` record) instead of their hardlink/registration
    mechanism — the Linux shape; and only the Linux-known locations are searched, not the
    Windows app list (ticket 40).
13. No Engine/updater/telemetry/provenance surface, no Windows frontends, no AMD path, no
    subscription-gated body (standing).

## Similarity-audit trail (Protocol v2, decision 4)

Every ticket of the wave carries its own fresh-context audit PASS on its ticket file
(`issues/20…43`), with the per-commit ADDED-line method (untracked files: all lines; tracked:
`git diff -U0` added runs), the clean/review/rewrite bands, and dual-tree scans always including
the newest payloads (0.6.18 from retarget #2, **0.7.0 + 0.7.1 from retarget #3** on).
Highlights of what the audits proved: our driver vs theirs (different return shapes, kill
mechanisms, English vs Russian); our check design vs their `ASTRAFORGE_CHECK` sentinel; the
`install.sh` free-space port with zero added-start runs against any tree; ticket 34 vs their
real `mesh-fit.mjs` (in-process meshoptimizer vs tagged-error + Blender budget-halving: zero
overlap); ticket 37 vs their 8 GB machinery (process-naming probe absent from all 12 trees;
unload in hand-over, not views); ticket 35 audited **line-by-line against the payload's
same-named `_posture_lib.py`**: different observable, different architecture, zero shared
identifiers; ticket 39 against the payload's OWN keep_rig (kNN weights, export-time re-binding
vs this branch's carrier transfer + transform-bake — longest shared run 4 lines of bmesh
boilerplate); ticket 40 against their `model-scan.mjs` (hardlinks + discovery walks vs symlink +
`weightLinks`; 16 coined literals 0 hits across 14 trees; longest shared run 3 import lines);
and tickets 42/43 against their Russian missing-Blender family and engine-side Python step guard
respectively. From 0.7.0 the payloads stopped shipping their JS tests and product docs —
corpus lineage false positives shrink; `files.txt`/`core-manifest.json` still track.

**Retroactive audit re-run at this release** (`scripts/audit/similarity-audit.mjs`, k=8, corpus
= all **fourteen** payload trees 0.4.6→0.7.1, base `886ca18` = the v0.6.6 release; evidence file
[`similarity-audit-0-7-1.evidence.json`](similarity-audit-0-7-1.evidence.json)). Numbers and
per-module verdict: filled at the release commit below.

## ⚠️ rows and carry-overs

- ⚠️ The closed native speedups (af-mesh/af_raster), the Pixal3D-C++ component, and the 0.7.0
  closed Rust core (node editor + content studio): excluded, so large-mesh cleanup stays
  Blender-slow, one-image color models are absent, and the node editor / content studio are not
  on this branch until the next-wave decision lands (author Q8; Rust component Q11; content
  studio separability Q12).
- ⚠️ Owner-flagged UI surfaces from the wave (header switch placement, Components busy-state,
  and now the `installed (external)` row styling): implemented per the wave order; visual review
  on the owner's side.
- ⚠️ `bevy_brp_mcp` live game-editor bridging: the install path is checksum-gated and tested;
  an actual running-game session through the bridge has not been exercised on this machine.
- ⚠️ Ticket 35's hidden-arms drift (0.08–0.12 m): documented with probe numbers; marker fallback
  is the sanctioned workaround; a landmark-pass retrain is a next-wave candidate, not silently
  accepted.
- ⚠️ Ticket 40's set-rows (FLUX.2 / Qwen-Image / Qwen-Image-Edit): the aggregate row reports
  plain `installed` when some members are external links; per-file truth lives in
  `config/paths.json` `weightLinks`. Simplification recorded, not hidden.
- The open campaign on the ADR-0003-era pre-0.5.0 tree (disclosed since 0.5.1) is unchanged;
  everything this wave added is ADR-0004 original, audit-gated per commit.

## What "done" meant for this wave

Tickets 20–31 + 33–40 + 42–43 implemented — each with tests at its commit, each with its PASS
audit line; 41 withdrawn before implementation (probe proved inapplicability — recorded);
ticket 32 shipped this report + README/docs + version 0.7.1 + the retroactive **fourteen**-tree
audit re-run + tag `v0.7.1`.

Suites at the release commit, stated honestly: node `npm test` **644/642/0/2** (642 pass, 2
environment-gated skips, 0 failures); the Bevy crate `cargo test` **12/12** + doctest +
`cargo check --features check`; the Blender lane (`run_tests.py`, full) — see the numbers block
below — carries **two failing tests that are proven PRE-EXISTING at the v0.6.6 base** (identical
failures in a `886ca18` worktree on this same machine, neither file touched by this wave):
`test_cloth_sim.test_cloth_sim_mannequin_robe_end_to_end` (AssertionError) and
`test_ships.test_ship_from_mesh_paint_and_decals` (`ValueError: font 'DejaVuSans-Bold' not
found` — a Linux font-environment gap the Windows-only lane never saw); and live runs: the
ticket-30 Bevy checks, the ticket-31 MCP stdio session, the ticket-34 Blender salvage
(115 MB → 67 MB accepted), the ticket-37 local-server `/interrupt` proofs, the ticket-43 fake
HTTP+WebSocket paging trip, and the ticket-40 real-machine `--report` empty run.

Numbers (filled at the release commit). **Blender lane** (`run_tests.py`, full, at this commit):
**279 passed / 2 failed / 54 skipped** — the two failures reproduce the disclosed pre-existing
pair measured at the `886ca18` base worktree (cloth_sim mannequin AssertionError; the ships test
and its `DejaVuSans-Bold` font-environment gap), neither file touched by this wave; the suite
grew 276→279 with ticket 39's three keep_rig tests, every touched lane green. **Retroactive
audit** (k=8, corpus = **fourteen** trees 0.4.6→0.7.1, base `886ca18`, 20 051 reference files ×
580 tracked): 568 tracked files share a run ≥ 8 tokens — overwhelmingly the disclosed pre-0.5.0
campaign body. The wave's own (post-v0.6.6) files at ≥ 8: **37**, unchanged in character from
the 0.6.18-era run — worst are `bevy/astraforge_bevy/LICENSE` 194 tokens × 0.96 containment
(the standard MIT text, present in every payload — boilerplate by definition), `bevy_package.py`
124 × 0.13 and `mesh-salvage.test.mjs` 69 × 0.09; 9 wave files sit in the ≥40-token band, 28 in
8–39, all carrying their per-ticket audit PASS lines and trivial public-idiom containment. Every
0.7.1-fold addition lands at or below 39 tokens × ≤ 0.05 (`af_weights.mjs` 39×0.03; the new
test files 31–32 × ≤ 0.05), and `replace_part.py`, `comfy_client.mjs` and `forge-steps.mjs`
show **no** ≥8-token run against any of the fourteen trees at all.

Nothing is pushed; the author questions (spec Q1–Q12) stay open here for the author.
