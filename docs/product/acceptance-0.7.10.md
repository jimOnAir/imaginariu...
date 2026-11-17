# AstraForge 0.7.10 — acceptance report (the VRM release, folded on Linux, shipped once)

This tree (`linux-support`) is version **0.7.10**. It carries everything the
[0.7.9 acceptance report](acceptance-0.7.9.md) covered — the 0.4.16 feature set, the Windows
0.5.x/0.6.x/0.7.x lines through 0.7.9 and this branch's performance wave — and adds one fold:
upstream **v0.7.10, the VRM release** (tickets 61–68, `.scratch/astraforge-1117-0710-fold/`),
re-derived under Protocol v2 ([ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md)):
T1 intent from the public notes, T2/T3 facts through the spec channel only; implementing contexts
never read the extracted payload trees; every code commit gated by an independent fresh-context
k=8 similarity audit recorded per ticket. The bone table, the Mixamo→VRM correspondence and the
ARKit expression blends were transcribed from the **live published sources** (the VRMC_vrm-1.0
humanoid spec; the saturday06 add-on's `mixamo_mapping.py` / `arkit_mapping.py` @ v4.10.5, both
fetched and auditor byte-checked in either direction), never from the quarantined payload.

**Positioning.** The Windows author ships one installer; this branch ships the same product for
Linux — same studio, same engines, same Blender lane — re-derived rather than ported, and every
parity claim below is stated as measured on this machine or recorded as a deviation. v0.7.10's
own line — anime humanoid avatars as one `.vrm` file — is this release's feature: the
`vrmaddon` component, the `vrm_package` step, the `.vrm` upload route, the "VRM 1.0 (anime)"
export profile and the `humanoid_vrm` preset, documented at
[`docs/forge/vrm_package.md`](../forge/vrm_package.md).

**Retarget record #5 (disclosed, user-directed).** The fold line launched toward the next
Windows release while the note grew; the target became **v0.7.10** by user order before any tag
(record #5 of the line's #1–#5, all disclosed in the acceptance reports). The base stays
`ff410e3` — the unpushed `v0.7.9` tag (annotated object `2a11190` → `ff410e3`); it moves to
`v0.7.10` at this closeout. Nothing was ever pushed, so nothing is revoked.
`acceptance-0.7.9.md` stays in the tree as the history of clusters N–O — everything it certified
still ships here; only the release label moves.

Statuses (as before): ✅ implemented · 🚫 excluded by decision · ⚪ not applicable on Linux
(frozen Windows surface) · ⚫ already covered by shipped branch code (probe evidence) · ⚠️
implemented but unverified on this machine.

## Cluster P — the VRM fold (tickets 61–63, 68; the release's own feature line)

✅ **Ticket 61 — `vrmaddon` installer component** (`af40995` + install proof 2026-11-17): the
VRM Add-on for Blender **4.10.5**, pinned by URL/size/sha256 — the digest observed through the
GitHub releases API (the publisher ships no separate digest file; the platform-served asset
digest is byte-identical to the pin, live-verified). `InstallVrmAddon` unpacks to
`runtime/vrm-addon`, writes config key `vrm_addon`, the scan row rides all three presets right
after `gltfpack`, pin-guard tests travel. **Install proof: rc=0 through the installer's own
`DownloadChecked` sha256 gate** — downloaded 2026-11-17 by owner order, one day before the 7-day
age buffer opened; the supply-chain deviation is record #23 below, not a footnote.
Audit: PASS ×2 (k=8 exit 0; the 3 REVIEW hits — bone-name runs and the URL — adjudicated
published-fact convergence).

✅ **Ticket 62 — the `vrm_package` step** (`6a0bf1c` non-gated half + `4d8f5ef` runtime half):
a rigged character becomes one `.vrm` — VRM 1.0 container written by the addon's own exporter,
driven through `bpy.ops.export_scene.vrm` from the step's background Blender. The data core
(`_vrm_lib.py`) is a branch-original re-derivation: the spec's **Required-15** humanoid bones
(shoulders optional — a shoulder-less rig never blocks; regression-guarded), the 52 ARKit
blendshape names, the publisher's blend weights per preset, honest named gaps. `stats.
expressions_bound` is a count pinned EQUAL to what the exported JSON carries
(`test_expressions_bound_in_the_exported_vrm`) — including switching OFF the addon's own
automatic expression assignment, found live to put presets in the file that our table calls gaps.
The runtime half ran **live 2026-11-17** and the live run was the point: it caught three defects
no dry lane could see (a `bl_idname`-less legacy module in `addon_utils.modules()`; the
extensions-repo load route being dead headless — replaced by by-path
`addon_utils.enable(name, default_set=True)`; the addon's validator ENFORCING the humanoid
parent chain, which the orphan-bone fixture failed). Audits: cycle FAIL→fix→PASS (the first
draft cited Required-**17** where the spec says 15 — a citation-honesty failure, fixed with a
guard) + a runtime-half fresh-context PASS.

✅ **Ticket 63 — the Forge surfaces** (`5630647` + real-file acceptance 2026-11-17): `.vrm`
uploads pass the gate only if the container DECLARES a VRM extension (`extensionsUsed` ∋
`VRMC_vrm` or `VRM`, whole-chunk read — `bad_vrm` otherwise; the same two-gate shape —
signature AND declaration — is the pattern for any extension-flavored container); the lane route
accepts `.vrm` natively; "VRM 1.0 (anime)" export profile and the `humanoid_vrm` preset (cleanup
→ rig → retarget → vrm_package) land en/ru. The audit cycle caught the integration seam live:
the upload gate had been opened a step short of the chain (`MESH_FORMATS` lacked `vrm` — the UI
invited the file in and every chain's first step raised `no_input`); fixed with a chain-level
regression test. **Real-file acceptance, two directions:** UniVRM's own test avatar
`AliciaSolid_vrm-0.51.vrm` (7 878 712 B, sha256 `237bb02e…48d05dc2`, a VRM **0.x** file — the
other arm of the container check) enters through upload, is stored byte-identical, starts the
humanoid chain, and its real 128-bone skeleton maps **52 bones, Required-15 missing = 0**; and
a `.vrm` our own chain produced through the addon exporter passes the same route
(`.scratch` evidence copies; probe `.scratch/tools/t63-real-vrm-probe.mjs`).

✅ **Ticket 68 — the branch's own agent surfaces** (`fca310c`): VRM rows in SKILL.md/studio.md
with honest step/preset counts, `docs/forge/vrm_package.md` shipping with the
verification-status table (tested / verified-live / not-attempted / not-ours-to-claim rows —
flipped with dated evidence as the runtime landed), and a **drift class caught and killed**: the
MCP `forge_export` gate hardcoded its profile list, so the new registry profile was invisible to
agents — fixed plus a guard test pinning MCP PROFILES == registry EXPORT_PROFILES
(mutation-tested). The marketplace skill surface was probed first: it does not exist on this
branch, so no row was invented for it.

## Cluster Q — wave guarantees: what the gates themselves proved (tickets 64–67)

- ✅ **t64** (`ae6516a`): `pick_hands_armature` remedy hints + `grip_hint` (the t60/t64 remedy
  family), TDD.
- ⚫ **t65 closed by probe**: the branch's Ollama chain is already PATH→config→own-sha-verified
  copy + live port probe — the note's failure mode belongs to the Windows half. No code written,
  correctly.
- 🚫 **t66 closed deferred**: version *records* exist; restore *semantics* + GUI open do not —
  this rides the standing candidate-W wave rather than half-landing.
- ✅ **t67** (`6bea102`): blind single-session runs never mint a shared recipe — the scoping
  guarantee pinned by a mutation-verified sole-guard test.
- **Three per-ticket audit cycles, two of them FAIL→fix→PASS** (t62 citation honesty, t63
  integration seam): the fresh-context gate earned its keep again; both catches are recorded
  verbatim in their tickets with the fixes' regression guards. The runtime lane gate then caught
  three more integration defects on first live export (t62 above) — "lane-tested" and
  "runtime-verified" are stated as different evidence classes throughout this release.

## Excluded from the fold, with reasons

Engine + plugins (scoped lift only for the MV-Adapter memory layer — unchanged), the whole
provenance/licensing/subscription line (Cloud/points/Shop/telemetry/ratings — ⚪/🚫 rows recorded
in the fold spec), AMD/ROCm, Windows frontends, closed binaries
(`astraforge-mcp.exe`/`astraforge-rs.exe` halves of rows 1/5). Standing exclusions, unchanged
from the 0.7.9 report.

## Deviations from the shipped Windows line (this wave's additions, all decisions)

22. Linux ships the VRM fold as one release `0.7.10` (continues the 0.7.1 list's numbering,
    then #14–#21 of 0.7.9); retarget record #5 — the fold target moved to v0.7.10 by user order
    before any tag, and the unpushed `v0.7.9` tag moves to `v0.7.10` at closeout.
23. **Supply chain: the pin pattern held; the age buffer did not — by owner order, recorded.**
    The VRM addon (asset published 2026-11-11 08:35:20Z) was pinned and tested *before* any
    download, the t58 pattern; but the download ran 2026-11-17, ~24.5 h before the 7-day age
    buffer would have opened (2026-11-18 08:35:20 UTC), when the owner explicitly waived the
    buffer ("скачай VRM-аддон, разрешаю"). What still enforced was integrity: the installer's own
    `DownloadChecked` sha256 gate ran and passed against the pinned digest before anything was
    unpacked (rc=0). The waiver traded the buffer's protection (time-since-publication as a
    malware window) for a live end-to-end proof the same day; the digest's protection stayed.
    Alicia's sample file (record 25 below) is data published in 2019 — no buffer applies.
24. `expressions_bound` ships as a **count pinned to the exported bytes**, with the addon's own
    `initial_automatic_expression_assignment` switched off before export — the Windows line's
    UI flow lets that heuristic add presets; this branch's report contract (a run never claims
    more than it did, and here also never *less*: the file matches the report exactly) required
    closing it. Recorded because it is a behavior difference inside a third-party dependency.
25. **Springs ship unimplemented, by ruling** (ticket 62): `VRMC_springBone` authoring needs the
    character's own spring-carrying chains (hair, cloth); inventing stiffness/collider constants
    for a bare rig is exactly the magic the fold spec forbids. The run report names it
    (`gaps.springs`), the docs table states it, and the trigger to land this half is a real
    chain-carrying character. The real-file acceptance therefore proves the ROUTE with a VRM
    0.x avatar (Alicia) and a VRM 1.0 file exported without springs — honest scope, stated.
26. The integrator kit gets no VRM row: probed — the integration surface has no template or
    tests to carry it; a row without them was refused (same discipline as the marketplace
    surface, t68).

## Similarity-audit trail (Protocol v2, decision 4)

Per-ticket audits at the commits: `af40995` PASS ×2 · `6bea102` PASS (mutation-guard) ·
`ae6516a` PASS · `6a0bf1c` FAIL→fix→PASS (Required-17 misread — the payload's own copy carrying
15 proved implementer misread, not contamination) · `5630647` FAIL→fix→PASS (F1 dead seam,
reproduced by the auditor as a RED chain test) · `fca310c` PASS (incl. the MCP drift find) ·
`4d8f5ef` PASS (runtime half: both REVIEW hits — the `sys.path` idiom at 11 and the numeric
fixture literals at 8 — adjudicated language-idiom / numeric-convergence with branch-native
prior art; ~28-phrase prose spot-check clean; the auditor re-ran the lane on the final
snapshot). Two provenance rulings extended the 0.7.9 three to literals: the ARKit-52 canonical
table and the skill doc's 35-name step list scanned long because canonical data has exactly one
correct content — both regrouped under branch-authored labels with set equality proven
mechanically, records carrying BOTH measurement scales (shipped scanner vs auditor token-level,
e.g. 54/23 vs 212/92). The **retroactive seventeen-tree audit** (corpus 0.4.6 … 0.7.10, the
`*-linux` trees excluded by the scanner itself) ran over the final range `ff410e3..HEAD` —
37 files, exit 0, **zero REWRITE-band hits** (29 REVIEW, 8 clean; worst 36, all adjudicated at
their ticket commits): [`similarity-audit-0-7-10.evidence.json`](similarity-audit-0-7-10.evidence.json).

## ⚠️ rows and carry-overs

- **Unity/UniVRM, UE5/VRM4U, Godot/godot-vrm opening our produced files: not verified by us** —
  that is the standard's promise, not this branch's test result. What IS verified here: the
  container parses as glTF with `VRMC_vrm`, the rig survives a stock glTF re-import in Blender,
  the report matches the bytes.
- MToon authoring and `VRMC_springBone`: not attempted (report + docs say so; see deviation 25).
- No VRoid Studio on this machine: the real-file acceptance used UniVRM's shipped test avatar
  (2019, in-repo artifact of the standard's own project) instead of a fresh VRoid export.
- Carry-overs recorded: `af_common.MESH_EXT` dead constant (tidy pass), marketplace skill
  surface absent (probe), integrator VRM row refused until an integration template with tests
  exists (deviation 26).

## What "done" meant for this wave

Tickets 61–63 + 68 shipped the feature line with tests and audits at every commit; 64–67 landed
or verdicted (⚫/🚫 by probe with evidence); the runtime half ran live on the owner-ordered
install and its three findings are fixed and recorded at their own layers; the closeout shipped
this report + README/docs + version 0.7.10 + the retroactive **seventeen**-tree audit re-run +
the `v0.7.10` tag (the unpushed `v0.7.9` moves).

Suites at the release commit, stated honestly: node `npm test` **701 tests / 699 pass / 0 fail /
2 skip** (the two disclosed skips of the 0.7.9 report); the Blender lane on the pinned
**5.2.4**: **300 / 2 / 54** — the 2 FAILs are the disclosed environment pair (`cloth_sim`
mannequin-robe e2e, `DejaVuSans-Bold` font), the round-trip SKIP is gone; the closeout commit
touches documentation only. Live runs this wave: the owner-ordered component install (rc=0,
checksum gate), the export round trip + expression binding (11/11 module filter), the Alicia
recognition probe, the fresh-context lane re-run.

Nothing is pushed; the author questions carried since 0.7.1 (spec Q1–Q12) stay open here for the
author.
