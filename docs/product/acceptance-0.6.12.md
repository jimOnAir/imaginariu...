# AstraForge 0.6.12 — acceptance report (Windows 0.6.6→0.6.12 behavior, re-derived on Linux, shipped once)

This tree (`linux-support`) is version **0.6.12**. It carries everything the
[0.6.6 acceptance report](acceptance-0.6.6.md) covered — the 0.4.16 feature set, the Windows
0.5.x line, and the Windows 0.6.0→0.6.6 line re-derived as one Linux release — and folds the
next stretch: the shipped Windows patches **0.6.7 through 0.6.12**, re-derived under Protocol v2
([ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md)): T1 intent / T2 observed
behavior / T3 interface facts through the spec channel only; implementing contexts never read
the extracted payloads; every commit gated by an independent fresh-context similarity audit
recorded per ticket under `.scratch/astraforge-0610-reintroduction/issues/`.

**Parity line and artifacts.** Windows shipped six patches after 0.6.6; the installers that
actually arrived are **`AstraForge-Setup-0.6.8.exe`** (61 121 536 B, md5
`8fc2d345501e1abea7637be1a73f3846`, sha256 `2957f4a9993a894ac6ed5d2f1c52c0c2837a935966a3a013f0f9c5867653e805`),
**`AstraForge-Setup-0.6.10.exe`** (61 570 560 B, md5 `49a32878c1bb26918a508e4c0dc6f813`, sha256
`bb5c6e768304a35eff4dcddd95bd8f45997996eb03c1babdf32960d8a811cfbd`) and
**`AstraForge-Setup-0.6.12.exe`** (62 298 112 B, md5 `2a58c9d62e4de282bea244d26f00ae43`, sha256
`13cae7da19a485ea572941912e2e0396932ae53260ae90ea56610eec891e7f4e`). The 0.6.7, 0.6.9 and 0.6.11
installers never arrived — their content is observable only folded into the trees above
(recorded deviation, same pattern as the 0.6.6 wave's folded 0.6.1–0.6.4). No public release
notes existed for 0.6.7–0.6.10: their intent came from the notes files inside the payloads
through the planner channel (a second recorded deviation from "published notes", asked of the
author in the wave spec); 0.6.11/0.6.12 notes arrive the same way.

**Retarget record (disclosed, user-directed).** The wave ran toward a `v0.6.10` release; while
it stood at its closeout ticket, `AstraForge-Setup-0.6.12.exe` arrived and the user directed the
release line to update onto it. ADR-0004's "Retarget honesty" row — which held the line at 0.6.6
when 0.6.10 arrived *without* sourced intent — named exactly the condition now met (the
0.6.11/0.6.12 notes are inside the payload), so the closeout moved to **0.6.12**: one new
implementation ticket (33, the installer free-space honesty ported to `install.sh`), two rows
verified already covered by shipped tickets (21 covers the low-memory generator-unload; 20's
`oldDriverText` already shows driver advice only for a demonstrably old driver), the rest
excluded with reasons below. The 0.6.7→0.6.10 commits were untouched by the retarget.

Statuses (as before): ✅ implemented · 🚫 excluded by decision · ⚪ not applicable on Linux
(frozen Windows surface) · ⚠️ implemented but unverified on this machine.

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
(no relocation, no bash errors). Commits `351ddb0`.

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

## 0.6.12's speedups — excluded this release, with reasons

🚫 `bin/af-mesh.exe` + `bin/af_raster.dll` (the 700k-tri-mesh cleanup ≈5 s vs 10–20 min; the
7× faster ship camera fit): payload-internal native binaries with **no published source,
checksum or attribution** — shipping or re-deriving them is wave-scale work (a production
quadric-decimation + raster stack, its build wiring, its audits), not a closeout ticket, and a
closed blob would violate the branch's license posture. The branch's Blender paths stay —
correct, only slower. Recorded as the headline exclusion and a next-wave candidate; questions
8 (source/attribution?) and 9 (`ai/mcp/bridge.mjs` — what is it for? it has no release-note
fact; not implemented) are carried to the author in the wave spec.
🚫 The engine lifeline (self-stop after an abrupt studio close) lives in `engine/astra_engine/`
— Engine files are a standing exclusion and this branch has no such engine process.
🚫 The 0.6.11 AMD ROCm attention-kernel fallback — standing AMD/ROCm exclusion.
🚫 Pixal3D crash-line reporting inside the worker — engine/plugin files.
⚪ `Setup.cs`/`Install.ps1` free-space plumbing (behavior ported to `install.sh` instead,
ticket 33) · ⚪ installer language follow-ups (unchanged from 0.6.6).

## Deviations from the shipped Windows line (all decisions)

1. Linux ships 0.6.7→0.6.12 as one release `0.6.12`; there was never a Linux 0.6.7…0.6.11.
2. The 0.6.7–0.6.10 intent came from payload-embedded notes via the planner channel (no public
   notes existed); same for 0.6.11/0.6.12. Author confirmation asked (wave-spec Q1).
3. Retarget 0.6.10→0.6.12 executed mid-closeout by user order, per the disclosure above.
4. Concurrency: POSIX `flock` replaces the Windows exclusive-open (ticket 24).
5. Venv repair is a rebuild, never a junction/relief of `python.exe` trampolines (ticket 25).
6. The 530 KB phrase-map is not ported; the key-based i18n layer stays (tickets 26/27).
7. `astraforge_bevy` is a branch-original MIT crate written from pins + public Bevy API; the
   Bevy passport schema is this branch's (documented in `docs/forge/bevy.md`), differing from
   the upstream crate's format by design.
8. The headless check's window renders off-screen (`(-32000,-32000)`); audio is checked as
   files, never through a sound device; the first check pays the Bevy compile, later ones reuse
   the shared target cache.
9. No Engine/updater/telemetry/provenance surface, no Windows frontends, no AMD path (standing).

## Similarity-audit trail (Protocol v2, decision 4)

Every ticket of the wave carries its own fresh-context audit PASS on its ticket file
(`issues/20…33`), with the per-commit ADDED-line method (untracked files: all lines; tracked:
`git diff -U0` added runs), the clean/review/rewrite bands, and dual-tree scans always including
the 0.6.8/0.6.10/0.6.12 payloads. Highlights of what the audits proved: our driver vs theirs
(different return shapes, different kill mechanisms, English vs Russian strings, zero ≥8 runs on
our prose); our check design vs their `ASTRAFORGE_CHECK` sentinel (different at every level);
`exportSoundBank` vs their zip export under a different format string (`astraforge-soundbank`
appears nowhere in their payload); the `install.sh` free-space port with **zero** added-start
runs against any tree (their side is PowerShell/C#).

**Retroactive audit re-run at this release** (`scripts/audit/similarity-audit.mjs`, k=8, corpus
= all eleven payload trees 0.4.6→0.6.12; evidence file
[`similarity-audit-0-6-12.evidence.json`](similarity-audit-0-6-12.evidence.json)). Numbers and
per-module verdict: filled at the release commit below.

## ⚠️ rows and carry-overs

- ⚠️ The 0.6.12 native speedups: excluded, so large-mesh cleanup stays minutes-slow here until
  the next-wave decision lands (author Q8).
- ⚠️ Owner-flagged UI surfaces from the wave (header switch placement, Components busy-state):
  implemented per the wave order; visual review on the owner's side.
- ⚠️ `bevy_brp_mcp` live game-editor bridging: the install path is checksum-gated and tested;
  an actual running-game session through the bridge has not been exercised on this machine.
- The open campaign on the ADR-0003-era pre-0.5.0 tree (disclosed since 0.5.1) is unchanged;
  everything this wave added is ADR-0004 original, audit-gated per commit.

## What "done" meant for this wave

Tickets 20–31 + 33 implemented, each with tests at its commit, each with its PASS audit line;
ticket 32 shipped this report + README/docs + version 0.6.12 + the retroactive eleven-tree
audit re-run + tag `v0.6.12`. All suites green at the release commit: node
`npm test` 588 (586 pass, 2 skip), Blender `run_tests.py` (full), crate `cargo test` +
`cargo check --features check`, and the live MCP session test. Nothing is pushed; the author
questions (spec Q1–Q9) stay open here for the author.
