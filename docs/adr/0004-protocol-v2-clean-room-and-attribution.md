# Protocol v2: strict clean-room re-derivations and honest attribution

ADR-0003 rebuilt the `linux-support` branch toward parity with shipped Windows 0.4.16 by
*reading the extracted payload as a behavioral reference* and restoring non-code artifacts
(docs, notes, data JSON) verbatim. At the time the branch was treated as an author-side effort.
It is not: the upstream product — including everything shipped in Windows releases 0.4.2 through
0.5.3 — is © Artem Doronin (Dops Media) and is distributed under the
**PolyForm Noncommercial License 1.0.0 plus a commercial-subscription license** (the
`LICENSE` embedded in the shipped payloads; byte-identical across 0.4.16→0.5.3). The branch
maintainer is neither the author nor a licensee of that code. Two strings inside the shipped
builds — the exe `LegalCopyright` version resource ("… MIT License") and an outdated paragraph
in the shipped `THIRD_PARTY_NOTICES.md` (Russian: «бесплатная программа по лицензии MIT… можно
использовать в том числе в коммерческих целях» — free under MIT, commercial use OK) — contradict
the authoritative in-payload `LICENSE`; they are treated as upstream bugs (reported, see
`.scratch/astraforge-051-reintroduction/issues/10-*`), never as a grant.

Under those facts, "read as spec, write fresh" is a defensible but *middle* position, and
"restore artifacts verbatim" is untenable: only the licensor can re-license to MIT, and the
public MIT grant must cover nothing that a court could deem a derivative of PolyForm-licensed
expression. This ADR raises the bar for all work from 0.5.1 onward and fixes attribution.

## Decision

1. **Attribution rewrite.** `LICENSE` becomes MIT © 2026 Dmitry Belozerov (jimOnAir) covering
   *this re-implementation*, with a provenance/attribution block: AstraForge is the work of
   Artem Doronin (Dops Media); this branch re-derives documented behavior clean-room under this
   protocol; it is not affiliated, distributes no PolyForm-licensed source, and the Windows
   releases remain under their own licenses. Mirrored in `README.md` / `README.ru.md`.

2. **Spec-input tiers.** Every change is specified from three tiers only:
   - **T1 — intent.** The author's public release notes and product prose as a statement of
     *what* the feature does, paraphrased into functional bullets. Never verbatim.
   - **T2 — behavior.** Observed operation: UI flows, HTTP responses, exported files, installer
     output, logs.
   - **T3 — interface facts.** Names, keys, thresholds, formats, attribute and storage keys,
     URLs — data that is inseparable from interoperability — recorded as `[fact]` lines.
   No verbatim restoration of upstream documentation, notes or data files: ADR-0003's
   artifact-verbatim clause is **retired** for all new work. Third-party license texts may ship
   only where those third-party licenses themselves require their inclusion.

3. **Quarantine.** The extracted payload trees and change reports
   (`~/github/AstraForge-0.4.16-ref/`) are quarantined work papers: readable by the
   *spec-drafter* (who distills T1/T2/T3 into ticket files) and by the independent
   *similarity auditor*, and by **no implementing context**. Implementation runs from the ticket
   file and this repository only.

4. **Per-ticket similarity audit.** Before its commit lands, every change is reviewed by a
   fresh context (which may read the quarantined payload) comparing the new diff against the
   reference corpus for textual and structural similarity; a PASS is recorded on the ticket.
   The audit checks both source and prose.

5. **Commit hygiene** (carried from ADR-0003): per-cluster commits, `npm test` green at every
   commit, each carrying the provenance note "behavior derived per ADR-0004, no source
   consulted". Windows frontends (`Setup.cs`, `Install.ps1`) stay frozen (ADR-0001); installer
   features land as the platform-neutral `install.sh` core.

6. **Excluded and deferred lines** for the 0.5.x wave (recorded per release in the acceptance
   reports): the AstraForge Engine and its self-learning LoRA line — deferred as a
   Windows-specific architecture; the FLUX.2-klein non-commercial restriction survives here as
   notice prose only. The asset-provenance and licensing machinery (invisible watermarks,
   `AFC1` certificates, signed core-manifest, owner mode, license build checks) — excluded:
   exports carry no marks and checks run license-blind. The updater, telemetry, support
   endpoints and keys-server — excluded, with only their *message patterns* mirrored into
   `install.sh`. AMD/ROCm support — deferred until there is AMD hardware to verify against.

## Consequences

- The branch's MIT claim becomes honest: the copyright line names the actual author of the
  code, attribution names the actual author of the product, and the derivation method is
  documented and enforced per change.
- A residual, disclosed risk stays: re-implementation from published behavior is lawful, but
  "clean room" is a defense posture, not a guarantee. It is mitigated to the practical floor by
  tiers (2), quarantine (3) and audits (4), and the open lever to remove it entirely is an
  explicit blessing from the rights holder (ticket 10).
- Historical scope is disclosed, not hidden: `v0.5.0` was produced under the weaker ADR-0003
  bar and is subject to a retroactive similarity audit whose results and follow-up rewrites are
  tracked publicly (ticket 09).

## Rejected

- Relying on the stale "MIT" strings in the shipped builds as a license grant (the authoritative
  `LICENSE` says otherwise; a contradiction in the licensor's own artifacts is not a grant).
- Keeping ADR-0003's read-as-spec method while asserting MIT authorship we cannot confer.
- Staying private "until blessed" — with tiers/quarantine/audits, public development at the
  defensible floor is possible now, and the blessing lever remains open in parallel.

## Amendment at the 0.5.1 release (deviations actually taken while implementing)

Recorded here because they refine how the protocol was applied; the per-cluster evidence and the
full deviations table live in `docs/product/acceptance-0.5.1.md`.

- **Engine-management scope.** The Windows `generator_*` family drives the proprietary AstraForge
  Engine; this branch maps the family onto the ComfyUI backend and exposes only
  status/nodes/graphs/run/restart. The other verbs are documented absent by name (MCP README,
  integrator skill) — absence as a contract, per decision 6.
- **Unity hull handling mechanism.** The accepted behavior is "hull names never render, hulls are
  the collider source"; the implementation re-derives it through Unity's public UCX FBX convention
  (synthesize convex hulls ≤64 tris, drop the sources) rather than any upstream mechanism — an
  independently chosen shape, audited as such.
- **Isolated check mode.** Windows silences telemetry and the journal in check mode; this branch
  has neither by design, so isolation means model-library and process containment only.
- **Unverified-by-design lines.** The Unreal in-editor pass and the Unity C# importer cannot run on
  the verification machine; they ship flagged, with data-level tests as the tested scope and
  guarded engine-side reports where the contract allows (plugin step reports, batch checks).
- **Graph catalog.** `GET /api/runtime/graphs` derives its rows by invoking this branch's own
  workflow builders, so the agent-facing catalog cannot drift from the code.
- **Audit outcome discipline.** Three of seven feature tickets were rejected by the audit gate at
  first pass (a release-note sentence, one transcribed hex constant, one copied helper) and
  re-landed only after original rework; the FAIL→fix→PASS trail is part of the release record.
  Pre-existing ADR-0003-era strings flagged by the auditors were carried to the retroactive audit
  (ticket 09) rather than silently kept.

## Amendment at the 0.6.6 release (deviations actually taken while implementing)

The 0.6.x wave re-derived the shipped Windows 0.6.0 → 0.6.6 line into a single Linux release 0.6.6.
Per-cluster evidence and the full deviations table live in
`docs/product/acceptance-0.6.6.md`; what refines the protocol's application here:

- **Shape-engine mapping.** Windows ships TripoSG inside the proprietary Engine; this branch maps
  it to a standalone venv worker (its own Python, commit-pinned clone, checksummed HF snapshot
  split into resumable steps) behind the same `auto` rule — plugin plumbing stays deferred with
  the Engine line.
- **A license refusal as a shipped feature.** The SkinTokens checkpoint hard-asserts a GPL-vendored
  mesh encoder with no clean substitute; rather than port or fake it, the engine slot accepts only
  `blender`, refuses `skintokens` before spawning anything, and names the reason and the doc. The
  license rule never trades for one rigging button.
- **Style generation without the Engine.** The style bible rides Qwen-Image-Edit 2511 GGUF through
  stock ComfyUI nodes (deviation recorded like the TripoSG worker): the VRAM gate (10 GiB) and the
  klein fallback are this branch's own constants.
- **Verdicts are code, not opinions.** The auto-review loop takes the VLM's scores but decides
  through an exported fixed-threshold table (tunable via env, clamped); plain mesh numbers cap the
  seam score so topology out-votes taste. Verdicts journal to the learning directory as
  `source:"auto"` in their own file — same vocabulary intent as forge feedback, different contract
  (forge records require a forge asset manifest a studio job does not have).
- **Stricter than upstream on opt-in.** Upstream forces TripoSG into the low-VRAM quick preset;
  this branch's «новое, проба» rule is unconditional: no preset ever preselects an experimental
  component (supersedes the wave's earlier swap rule).
- **No invented mirrors.** The clips step gained a mirror chain, and the list ships deliberately
  empty: as of the release no public copy of the retargeted clip repack is checksum-verifiable.
  An unverified "mirror" is a supply-chain hazard worse than an honest failed step.
- **Audit discipline held.** All fifteen implementing tickets of the wave passed the fresh-context
  similarity gate (no FAIL→rewrite cycles this time); the live-caught defects found during demos
  (an input-name plural, an unassigned camera, `think:false` ignored by the local runtime) are
  recorded on their tickets with the reproduction, per the protocol's evidence rule.
- **Retarget honesty.** `AstraForge-Setup-0.6.10.exe` arrived before closeout with no published
  behavior facts for 0.6.7–0.6.10; the wave scope did not move on an artifact's arrival alone —
  recorded as an open decision (keep `v0.6.6`, or fold 0.6.7–0.6.10 into a later release when
  their intent is sourced). The branch also skips a Linux 0.6.5 entirely (single folded release).

## Amendment at the 0.6.12 release (deviations actually taken while implementing)

- **Retarget-on-sourced-intent, executed.** The wave ran to `v0.6.10`; `AstraForge-Setup-0.6.12.exe`
  arrived before closeout *with* the 0.6.11/0.6.12 behavior notes inside the payload — the exact
  condition the 0.6.6 amendment's "Retarget honesty" row asked for — and the user ordered the
  release line onto it. Artifact arrival alone still moved nothing; the sourced intent moved it.
  The delta folded at closeout was scoped honestly: one new ticket (33), two rows proven already
  covered by shipped code, the rest excluded with reasons.
- **Notes inside payloads are a channel, with a question attached.** For 0.6.7–0.6.10 (and
  0.6.11/0.6.12) no public release notes existed; the `installer/notes-<version>.txt` files inside
  the payloads carried the intent. They flowed through the planner channel into the wave spec only
  — implementing contexts still never opened the trees — and the author is asked to confirm or
  publish them (spec Q1).
- **Closed native blobs are an automatic 🚫.** 0.6.12's speedups ship as `af-mesh.exe` /
  `af_raster.dll` with no published source, checksum or attribution. Re-deriving their *behavior*
  is legitimate wave work; shipping or depending on the blobs is not. The slower-but-clean Blender
  paths stay, and the exclusion is a release headline, not a footnote.
- **Venv repair is a rebuild.** On Linux the 0.9-row "restore the internal Python link" becomes
  `uv venv --allow-existing` in place, with the heavy recreation delegated to the installer's
  component flow; the studio never deletes a venv.
- **Concurrency via flock.** The Windows exclusive-open installer lock becomes POSIX `flock`;
  the detached-install + `pid.json`/`status.jsonl` re-attach is this branch's own design.
- **Phrase-map not ported.** The upstream 530 KB runtime RU→EN dictionary is the opposite of this
  branch's key-based i18n layer; the behavior (OS-language first run, persistent switch, header +
  Appearance choosers) was re-derived on the existing layer.
- **The Bevy passport is this branch's schema.** `af_bevy.json` (`{name,loop,seconds}` clips,
  `{kind}` collider) is what our ticket-28 step writes and our ticket-29 crate reads; upstream's
  crate reads a different shape. Both halves living on this branch is the deviation, recorded in
  `docs/forge/bevy.md`.
- **Original-code claims are made from ground truth.** The 0.20 API surface the crate and the
  check harness call was grepped from the vendored crates.io sources rather than guessed, and the
  live headless check caught (with a recorded reproduction) the one real crate bug the unit tests
  could not see — the animation player anchors inside the instance, not at the scene root.
- **Third-party installs stay checksum-pinned.** `bevy_brp_mcp 0.23.0` installs only from the
  downloaded .crate whose sha256 equals the pinned crates.io record (live-verified); a mismatch
  refuses before any toolchain runs. Same rule as the model downloads: no unverified fetch is
  ever executed.
- **Audit discipline held.** All thirteen implementing tickets (20–31, 33) passed the fresh-context
  similarity gate with the PASS recorded per ticket; the auditors also corrected their own
  scanner twice mid-wave (a tokenizer line-attribution defect; CRLF-diff artifacts) and the
  corrections are on the ticket files.

## Amendment at the 0.7.1 release (deviations actually taken while implementing)

- **Retarget honesty, exercised twice more.** Before any tag was applied, `0.6.18.exe` arrived
  (record #2 — its payload carries the 0.6.13–0.6.18 notes) and, again mid-closeout,
  `0.7.0.exe` and `0.7.1.exe` arrived together (record #3 — both notes files ride the payloads).
  Both moves were user-directed and satisfy the rule's condition: intent is *sourced*, not
  inferred from an artifact's existence. No v0.6.12, v0.6.18 or v0.7.0 tag ever existed; the
  `acceptance-0.6.12.md` report became a superseded pointer so no file claims a Linux release
  under an intermediate target. The 0.6.19+ window has no installer and no notes file — folded
  as a recorded deviation, not guessed at.
- **Probe-first withdrew a ticket before implementation.** The 0.7 note "self-learning idle gate"
  became ticket 41; probing the branch's own `server/forge-learn.mjs` showed a local
  event-driven journal with no background GPU work — an idle/VRAM/cooldown gate would have
  nothing to gate (the note governs the engine-side trainer, a standing exclusion). The ticket
  was withdrawn with the evidence recorded rather than implemented as a fabricated feature.
- **A closed core is excluded as a body.** 0.7.0 moved the node editor (and the subscription-
  gated content studio) into `bin/astraforge-rs.exe` — a native binary with no published
  source, checksum or attribution. The af-mesh rule applies automatically, and with it the
  observation that the monetization exclusion covers whole product bodies, not only
  updater/telemetry plumbing: anything whose *host* is a closed binary is excluded with it
  (author questions Q11/Q12 keep the door open).
- **Reuse of existing seams over new machinery.** keep_rig (ticket 39) threads the
  `_mesh_lib.prepare_meshes(keep_armatures=)` flag that already existed unused and transfers
  weights through `_cloth_lib.transfer_weights` (the cloth lane's idiom) on a points-only
  carrier; the transform-bake recipe was measured in Blender first (world drift 0.000000 m,
  deform identical) instead of reasoned about. The branch's `keep_rig` defaults off where
  upstream's defaults true — recorded: patch waves do not flip existing step defaults.
- **Weight reuse is a link, never a copy.** The Windows mechanism (hardlinks + folder
  registration) becomes, on Linux, a symlink into the studio's own `data/models` + a
  `weightLinks` record in the pre-existing `config/paths.json` layer, sha256-verified at accept
  against the manifest pin (no pin — no link). The user's folders are never written to, moved
  through, or relinked; the af_scan row `installed (external)` carries the truth into both the
  installer checklist and the Components window.
- **The paging sentinel stays on the branch's side of the boundary.** 0.7's low-VRAM cures are
  engine-side fp8/eviction machinery (🚫); what this branch owns is the orchestrator fact —
  a step over five minutes is paging — enforced client-side against ComfyUI's own progress
  stream (ticket 43). The auditors' line-by-line comparison of the two guards (engine-side
  Python with Russian strings vs the WS step clock here) is the fold's cleanest boundary demo.
- **Corpus change recorded.** From 0.7.0 the payloads stopped shipping their JS tests and most
  product docs (104 files); retroactive-audit false positives shrink accordingly, and newer
  interface facts come from code shapes only. Container note for future waves: 0.7.x exes carry
  ~70 KB of resources AFTER the zip EOCD — carve, then truncate to `EOCD + 22 + commentLen`.
- **Audit discipline held.** Every fold ticket (34–40, 42–43) passed the fresh-context gate
  with the PASS recorded per ticket; 39 and 40 were audited directly against the payload's
  same-named implementations (`replace_part` keep_rig, `model-scan.mjs`) and survived
  line-by-line comparison — longest shared runs 4 and 3 lines respectively, both boilerplate.

## Amendment at the 0.7.9 release (deviations actually taken while implementing)

- **Retarget honesty, exercised a fourth time.** The fold wave launched toward `0.7.2 → 0.7.4`-territory
  while 0.7.5–0.7.9 kept arriving upstream; the release target became **0.7.9** by user order on
  2026-11-15, before any tag (record #4 in the fold `spec.md`). The unpushed `v0.7.1` tag
  (`d20b03e`) moves to `v0.7.9` at this closeout; no interim Linux 0.7.2…0.7.8 tag ever existed
  or will.
- **The intent channel changed; the quarantine did not.** From 0.7.x the author publishes
  bilingual **public release notes + sha256-sidecarred assets on GitHub Releases**, so T1 intent
  is now *sourced* publicly — the standing question Q1 (where do release intents come from) is
  answered for every version back to 0.4.6. Payload trees stay quarantined from implementing
  contexts for T2/T3 facts exactly as before.
- **A Linux artifact arrived and changes nothing about the posture.** Upstream ships official
  Linux builds from v0.7.7 (their `AstraForge-0.7.9-linux.tar.gz` landed alongside the fold). It
  is the same author's output: **not** an audit-corpus source, **not** a reading channel —
  quarantined like every payload. The branch's positioning (an MIT clean-room studio without the
  subscription line) is stated once in the release docs and stops there.
- **Corpus change recorded.** The retroactive audit now runs over **sixteen** trees: 0.4.6 …
  0.7.1 plus **0.7.3** and **0.7.9** (the fold spec's row said "0.7.4 tree"; what was extracted
  and what the corpus therefore carries is 0.7.3 + 0.7.9 — recorded honestly). Trees ≥0.7.0
  include snapshots of this branch's own later releases, so shared-ancestry hits are expected
  and must be adjudicated as such (next bullet).
- **Three provenance rulings now bind the audit trail.** (1) *Factual pins converge*: a correct
  restoration of public constants (a model's URL/sha256/size, a publisher's mirror list) matches
  the corpus byte-for-byte because there is one correct byte sequence — ruled provenance-mandated
  when the branch's own probing chain proves independence (t52: the 9B pins restored field-wise
  from `8986276^`; t58: the Blender 5.2.4 line, byte-identical to our own 5.0.1 line except the
  version facts). (2) *Shared ancestry*: a run whose every token pre-exists in our own history
  (t44: ours since `cce8c29`, 0.3.0 — the corpus file byte-identical to HEAD after line-ending
  normalization) is the branch reading itself through the corpus. (3) *Mega-line re-wraps*:
  editing one long line counts the whole line as ADDED, so long matched spans inside it are
  checked span-by-span against HEAD (t50's JSX line, t54's App.jsx 43-token run — the verbatim
  span exists in HEAD's line, token-multiset diff shows insertions only). Each ruling was made
  by a fresh-context auditor, never by the implementing context.
- **The per-ticket gates caught two real process leaks** — which is what they are for. t49: the
  first implementation had inherited the upstream cleanup param's *name and default* from the
  planner's tree-reading workpaper (a T2/T3 leak upstream of the gate); the fix was
  **re-derivation, not disclosure**: branch-native name, default re-chosen from this machine's
  measured cost table. t50: the new i18n guard was **vacuous** for text inside a top-level
  component (whole-file brace collapse); fixed and re-proven by injecting raw text into the
  panel's return region.
- **Supply-chain defense held on a dependency bump.** Blender 5.2.4 (published 2026-11-10
  08:36 UTC) was pinned by URL/size/sha256 from the publisher's own sha256sums immediately, but
  the tarball was not downloaded until the 7-day freshness gate opened (2026-11-17 08:36 UTC);
  the lane proof runs through the installer's own checksum gate.
- **Probe-first closed three rows before any code** (the 0.7.1 precedent, exercised again): the
  CFG-batch halves (t45 — fp8 peaks measured 5.87 GB make the split unnecessary here), Pixal3D
  residency (t51 — the branch never had the per-stage reload the note cures), and the clips
  "one archive" (t55 — the publisher serves no archive this branch is allowed to verify; an
  invented mirror stays the one move worse than a failed download, ⚫ recorded with the probe).
