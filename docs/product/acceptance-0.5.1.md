# AstraForge 0.5.1 — acceptance report (Windows 0.5.0→0.5.3 behavior, re-derived on Linux)

This tree (`linux-support`) is version **0.5.1**. It carries everything the earlier acceptance
report covered — the 0.4.16 feature set ([0.5.0 acceptance](acceptance-0.5.0.md)) — plus the
behavior of the shipped Windows releases **0.5.0, 0.5.1, 0.5.2 and 0.5.3**, re-derived under
Protocol v2 ([ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md)): spec inputs were
the author's published intent paraphrased to functional bullets (T1), observed behavior (T2) and
interface facts (T3); implementing contexts never read the extracted payload; every commit passed
an independent fresh-context similarity audit, recorded per ticket under
`.scratch/astraforge-051-reintroduction/issues/`.

**Parity line.** The Windows artifact this release matches is **`AstraForge-Setup-0.5.3.exe`** —
the cumulative union of the 0.5.x line (0.5.2 was a hotfix whose content is contained in 0.5.3;
its notes were recovered from the 0.5.3 payload). For disambiguation: the shipped Windows builds
stamp `FileVersion 0.4.17` internally; the artifact name above is the identifier, not that number.
Windows-only surfaces this branch does not carry are listed under *Deviations* — every one of them
was a decision, never an omission.

Statuses (as in the 0.5.0 report): ✅ implemented · 🚫 excluded by decision · ⚪ not applicable on
Linux (frozen Windows surface) · ⚠️ implemented but unverified on this machine.

How to verify the whole tree at this commit:

```bash
npm ci
ASTRA_ENGINE_AUTOSTART=0 npm test    # 429 tests: 427 pass, 0 fail, 2 skipped (both pre-existing)
cd ai/mcp && npm test                # 23 tests: 22 pass, 1 skipped (the fake-Start case is win32-only)
npm run build
installer/install.sh -v              # prints the package.json version — the drift guard
blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- unreal
blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- unity
```

Commits of this wave (base `a3c959d`): `d69b6ed` (01) · `c2c1d5d` (02) · `abad7c1` (03) ·
`d7bfe3d` (04) · `9601e12` + `9c7f0d6` (05) · `3c423af` (06) · `940ff5d` (07) · this commit (08).

## Cluster A — the studio survives corrupt state (Windows 0.5.1 hotfix line)

| # | Behavior (intent, paraphrased) | Status | Where | Proof |
|---|---|---|---|---|
| 1 | A corrupt, empty, truncated or BOM-garbled job-history file never stops the studio: the offender moves to `data/jobs/broken/` and the boot continues with a log line per file; nothing is deleted | ✅ | ticket 02 (`c2c1d5d`), `server/jobs.mjs` `loadJobs(dir, warn)` | `node --test tests/jobs-load.test.mjs`; the live boot demo (corrupt config + two bad jobs → health OK, files quarantined) recorded in ticket 02 |
| 2 | An unparseable or incompatible `config.json` is renamed `config.json.broken-<timestamp>` untouched and the run starts on defaults | ✅ at the time | ticket 02, `server/schema.mjs` `loadConfig(file, warn)` | same suite; first-run and BOM-good-file cases included. **Superseded for the "incompatible" half:** since 0.6.x ticket 17 a file that is valid JSON with one foreign key or one bad value is read field by field (the key dropped, that field defaulted, the rest kept, the file untouched); only a file that is not JSON at all still moves aside |

## Cluster B — the installer degrades honestly (Windows 0.5.0/0.5.3 robustness + version honesty)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | Ollama below **0.12.7** is refused for the model steps; the checksum-verified copy goes into `runtime/ollama` instead; missing Ollama ends the step with a plain recovery sentence, not a crash dump | ✅ | ticket 03 (`abad7c1`), `installer/install.sh` `OllamaMinVersion` / `OllamaVersionOk` / `EnsureOllama` | `node --test tests/install-download.test.mjs` (gate boundary 0.11.2 / 0.12.7 / 99.9.9, no-crash guard) |
| 2 | A downloaded file that vanishes between connection and folder (antivirus, folder sync) gets exclusion advice and a re-run instruction instead of a raw move error | ✅ | ticket 03, `installer/af_download.sh` | `node --test tests/install-download.test.mjs` (vanished-`.part` case) |
| 3 | Isolated check mode `ASTRA_INSTALL_ISOLATED=1`: pulled models stay under `runtime/models/ollama`, a serve the run started is stopped on exit, the shared user library is untouched | ✅ | ticket 03; this branch ships no telemetry or journal, so the isolation reduces to model library + leftover processes (stated deviation) | demo against a temp app root recorded in ticket 03 |
| 4 | The installer announces the true version — always the `package.json` version, never a literal; `-v` prints it | ✅ | ticket 03 | `node --test tests/install-version.test.mjs` (mutated-tree drift probe) |
| 5 | VFX branch archives get a second delivery channel (codeload twin of the GitHub archive) through the existing mirror core | ✅ | ticket 03, `scripts/vfx/install-vfx.sh` `GitHub()` | `node --test tests/install-download.test.mjs` keeps the core green; no third-party mirrors were invented (supply-chain rule) |
| 6 | Steam / MS-Store Blender discovery, error-report retry file, Setup.cs version stamp | ⚪ | Windows frontends frozen (ADR-0001/0004); the platform-neutral analogues landed above | audit confirmed zero leakage of those paths |

## Cluster C — the Hybrid UI generation (Windows 0.5.0 UI line)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | Themes dark (default) / light / follow-system, persisted under `astra.theme`, applied as `data-theme` **before first paint**, OS flips followed live | ✅ | ticket 04 (`d7bfe3d`), `src/shell/theme.js` + inline script in `index.html` | `node --test tests/shell-theme.test.mjs`; browser demo (persistence across full reload, live system flip, screenshots `t04-dark.png` / `t04-light-main.png` in ticket 04) |
| 2 | Simple (default) / Detailed view modes persisted under `astra.mode`; Detailed additionally reveals the advanced generation settings, the game export profiles and the keyboard-shortcut surfaces | ✅ | ticket 04, `src/shell/mode.js` (`REVEALED_IN_DETAILED` pins the contract), `App.jsx`, `StepExport.jsx` | `node --test tests/shell-mode.test.mjs` + reveal/hide checks in the live demo |
| 3 | Light theme reads correctly across the whole surface: all 509 stylesheet colors became palette tokens (`scripts/ui/palette-tokens.mjs`), `:root` = the original dark values byte-for-byte, `html[data-theme=light]` a derived map with a curated override table; `--check` keeps the contract | ✅ | ticket 04, `src/palette.css` (generated) | `node --test tests/shell-palette.test.mjs`; new CSS must use tokens, not literals |
| 4 | Inter, Oswald, JetBrains Mono bundled locally (SIL OFL 1.1, vendor-obtained, sha256 pinned in `src/fonts.css`); no runtime font fetches; listed in the notices | ✅ | ticket 04, `assets/fonts/` | suite + `THIRD_PARTY_NOTICES.md` rows; visual design of the whole shell is authored for this branch (stated deviation) |
| 5 | All new strings through i18n (en/ru) | ✅ | `src/i18n/{en,ru}.js` `shell.*`, `core.export.unreal.*`, `step.unreal_package` | `node --test tests/i18n.test.mjs` (key-parity guard) |

## Cluster D — Unreal Engine 5 export line (Windows 0.5.0 line C)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | `unreal_package` forge step: `af_unreal.json` package — SM_/SK_ renamed meshes, `_LOD1/_LOD2`, UCX collision hulls from the authored `-colonly`/`COL_*` names, T_* BaseColor/DirectX-Normal/ORM textures, MI_* instances of M_AstraForge, socket data, A_* animation names, centimetres / Z-up / nose +X, passport carried through | ✅ | ticket 05 (`9601e12`), `scripts/blender/steps/unreal_package.py` + `_unreal_lib.py` | `blender -b --factory-startup --python scripts/blender/tests/run_tests.py -- unreal` → 5 pass, 1 designed skip (the in-editor row) |
| 2 | Python-only importer plugin (no binaries) materializing every contract element, each step guarded into `import_report.json`; `check.py` → `unreal_check.json` | ✅⚠ | ticket 05, `unreal/AstraForge/` | module import + pure helpers proven outside the editor (`node --test tests/unreal.test.mjs`); **the in-editor pass is unverified by design — there is no Unreal Editor on the verification machine**, `docs/product/unreal.md` states the status |
| 3 | Engine bridge: create (editor-free `.uproject` with plugin + Python enabled) / send (packages → `AstraForgePackages/<id>`) / test (UnrealEditor-Cmd `-run=pythonscript` under `.af_unreal.lock`) / mcp-register (`unreal-mcp` when `ASTRA_UNREAL_MCP` is set); absence answers actionably everywhere | ✅⚠ | ticket 05, `scripts/engines/af_engine.mjs` | `node --test tests/unreal.test.mjs` 10/10 incl. a stubbed UnrealEditor-Cmd proving the drive contract; editor-boundary behavior unverified (no UE here) |
| 4 | Studio wiring: registry step + `unreal` export profile + en/ru labels | ✅ | `server/forge-steps.mjs`, `src/forge/forge-core.js`, i18n | registry/route snapshot tests updated in `9601e12` |

## Cluster E — MCP `generator_*` family (Windows 0.5.0 line J, scoped to this backend)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | An agent can observe and drive the generation backend: `generator_status`, `generator_nodes`, `generator_graphs`, `generator_run` (rides the studio job layer; validation/asset relayed), `generator_restart` (owned ComfyUI only; foreign instances declared, never touched) | ✅ | ticket 06 (`3c423af`), `ai/mcp/server.mjs` + routes `/api/runtime/{graphs,nodes,restart}` + `server/runtime.mjs` `restartRuntime()` | `cd ai/mcp && npm test` (6 new cases incl. exact family set) + `node --test tests/runtime-routes.test.mjs`; fresh-client live demo (status/nodes/graphs payloads, run visible in `jobs_list`, honest restart absence) recorded in ticket 06 |
| 2 | Engine-management verbs — `generator_plugins`, `generator_plugin_new`, `generator_plugin_install`, `generator_plugin_toggle`, `generator_learn_status`, `generator_learn_run`, `generator_learn_activate` — and the owner-gated `generator_graph_edit` | 🚫 | deferred with the AstraForge Engine line / excluded with owner mode; named with reasons in `ai/mcp/README.md` ("Границы семейства generator_*") and the integrator skill, so agents read the boundary from docs | tool-listing test asserts their absence |

## Cluster F — Unity collision hulls (Windows 0.5.0/0.5.3 line I)

| # | Behavior | Status | Where | Proof |
|---|---|---|---|---|
| 1 | Meshes named `*-colonly`, `*-convcolonly`, `COL_*` are collider input only: never rendered, never materialized, never inflating bounds; each becomes a UCX convex hull (≤64 tris, parent orientation) riding the FBX; the passport declares the wiring (`collider.type "ucx"` + hulls list) | ✅ | ticket 07 (`940ff5d`), `scripts/blender/steps/unity_package.py` | `blender … run_tests.py -- unity` → 6 pass, 1 designed skip (real Unity batchmode); new tests cover ucx synthesis, the `.001` copy-suffix variant, target binding, FBX-bytes absence and the box/none variants |
| 2 | Importer + batch check enforce both halves in Unity (MeshCollider on, renderer off) | ⚠ | `unity/com.astraforge.unity/Editor/{AFPackageData,AFPrefabBuilder,AFBatch}.cs` | unverified by design — no Unity editor on the verification machine; data-level contract proven in row 1 (same posture as the rest of the C# importer) |

## Deviations from the shipped Windows line (all decisions)

| Line | Decision | Where recorded |
|---|---|---|
| AstraForge Engine + self-learning LoRA (`generator_learn_*`, engine service, engine installer component) | **Deferred** — Windows-specific architecture; this branch keeps ComfyUI (+ Pixal3D) as the generation backend. FLUX.2-klein's non-commercial term survives only as third-party notice prose | ADR-0004 §6; Cluster E row 2 |
| Asset provenance and licensing machinery (invisible watermarks, `AFC1`/`AFCK1` certificates, signed core-manifest, owner mode, license build checks, `LICENSE.txt`/`ASSET_INFO.txt` package extras, per-export license warnings) | **Excluded** — exports on this branch carry no marks and checks run license-blind | ADR-0004 §6 |
| Auto-update, telemetry, support endpoints, keys-server | **Excluded**; only their *message patterns* (e.g. vanished-download guidance) are mirrored into `install.sh` | ADR-0004 §6; Cluster B |
| AMD/ROCm support | **Deferred** — no AMD hardware to verify against | ADR-0004 §6 |
| Windows frontends (`Setup.cs`, `Install.ps1`) | **Frozen** per ADR-0001; Linux gets the platform-neutral `install.sh` core | Cluster B row 6 |
| Unreal in-editor execution, Unity C# importer | **Unverified by design** (no UE/Unity editors on this Linux machine) — data-level verification only, flagged wherever it matters | Clusters D, F |
| Prose | All documentation, notes and messages in this branch are original; ADR-0003's verbatim-artifact restoration is retired. Third-party license/OFL texts ship because those licenses require them | ADR-0004 §2 |
| `v0.5.0` and earlier | Produced under the weaker ADR-0003 bar; disclosed here and scheduled for the retroactive per-module similarity audit (ticket 09), whose findings and follow-up rewrites land publicly in this repo | README branch bullet; ticket 09 |

## Similarity-audit trail (Protocol v2, decision 4)

| Ticket | First-pass verdict | Fixed before commit | Re-audit |
|---|---|---|---|
| 01 ADR + attribution | PASS | auditor nit (quote precision in ADR) | — |
| 02 resilience | PASS | — | — |
| 03 installer | **FAIL** — missing-Ollama message reproduced upstream EN release-note wording (9 tokens) | message rephrased originally; ticket T3 line re-rewritten to content-not-wording; offending sentence eradicated tree-wide | PASS (8-gram scan vs ~3 000 corpus files) |
| 04 Hybrid UI | **FAIL** — one transcribed hex constant (`#0b0d12`) found in `theme.js` | replaced with this branch's own HEAD value | PASS (485/485 light values proven formula-derived; fonts are different vendor files) |
| 05 Unreal | **FAIL** — `uprojectOf` (name + 13-token body) matched upstream | renamed `findUproject` with a regex body; uplugin description reworded | PASS (mechanical, HEAD-inheritance-filtered) |
| 06 MCP family | PASS (18 scan hits all provenanced to HEAD/boilerplate) | auditor hygiene: CRLF flattening of 3 docs restored; ticket-05 parity rows split into `9c7f0d6` | — |
| 07 Unity hulls | PASS (mechanisms differ: UCX-generate+delete vs upstream's exclude-and-keep) | auditor correctness nits: `.001` suffix tolerance, warning wording | PASS (focused) |

Known carry-overs for the retroactive audit (ticket 09): the HEAD restart message
"The job was interrupted by a restart…" is a translation of a 0.4.16-era RU string; pre-ADR-0004
README/NOTICES overlaps stay grandfathered until rewritten; `docs/forge/SMOKE.*` need a provenance
line; `generator_run` should share `generate_3d`'s param block when that tool is rewritten.

## What "done" meant for this wave

Tickets 02–07 green through the similarity gate · the suites above green at every commit · live
Linux demos per cluster (boot with corrupt state, installer probes, browser theme/mode proof,
MCP client session) · this report + the ADR amendment + README parity + `package.json` 0.5.1 +
tag `v0.5.1`.
