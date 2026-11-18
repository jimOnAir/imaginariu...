# Imaginarium 0.5.0 — re-introduction acceptance report (0.4.7 → 0.4.16 on Linux)

This tree (`linux-support`) is version **0.5.0**: the studio with everything the shipped Windows
`Imaginarium-Setup-0.4.16.exe` contained, re-developed for Linux as clean-room re-derivations per
ADR-0003 (`docs/adr/0003-reintroduce-0-4-16-as-clean-room-re-derivations.md`). The source history of
0.4.7→0.4.16 was lost when git froze at 0.4.6; this report is the artifact that replaces it: every
bullet of the shipped release notes (`installer/notes-0.4.7.txt` … `installer/notes-0.4.16.txt`,
the RU/EN originals restored verbatim) mapped to **where it lives**, **"excluded by decision"** with
the pointer, or **"unverified here"** — each with the command that proves it.

Statuses: ✅ implemented · 🚫 excluded by decision (ADR-0003 / EXCLUDED line) · ⚪ not applicable
on Linux (frozen Windows surface, with the Linux outcome stated) · ⚠️ implemented but unverified
on this machine.

How to verify the whole tree:

```bash
npm ci
IMAGINARIUM_ENGINE_AUTOSTART=0 npm test      # the full suite (395 tests at the 0.5.0 commit)
npm run build                          # the frontend build
installer/install.sh -ScanOnly         # the machine scan, no downloads
scripts/start.sh --no-browser          # boots the studio at http://127.0.0.1:3210
```

Ticket numbers are `.scratch/imaginarium-0416-reintroduction/issues/` (the work papers); commits are
on this branch.

## 0.4.7 — subscription in the installer, 2D engines, computers without NVIDIA

| # | Bullet (notes, EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | Buy a subscription right in the installer; key entry/move | 🚫 | Entire monetization line excluded (license/validation/subscription) | ADR-0003 "The entire monetization and identity line … is excluded"; ticket 01 |
| 2 | Tab 2D: FLUX.2 klein and Qwen-Image installed and listed under "Engine", with what is missing said under the list; Full installs them (~16 and 23 GB) | ✅ | ticket 06 (`aea39d6`, `b1f3f2b`): both engines download over GGUF loader + pinned weights (`installer/install.sh` ids `gguf,flux2,qwenimg`), `server/art2d.mjs` + `src/Art2dPanel.jsx` engine list shows per-engine missing reasons | `node --test tests/art2d.test.mjs`; `node --test tests/install-scan.test.mjs` (GGUF-loader and weight-set scan rules) |
| 3 | PC without NVIDIA: pre-download warning + Lite setup ≈3 GB (Blender, rig, animations, sprites, VFX, Godot) | ✅ | ticket 16 (`a7ef9b9`): `install.sh` asks before any download and switches to the `lite` profile (`config/paths.json` gets `profile: lite`); scan marks GPU items `unavailable` with reasons | `node --test tests/install-scan.test.mjs`; the `IMAGINARIUM_INSTALL_NO_GPU=1` checklist demo in ticket 16 comments |
| 4 | Error reports and the learning journal on by default; toggles in About → Reports and learning | 🚫+✅ | Reporting/shipping excluded (telemetry line). The **learning journal itself is local and present**: ticket 20 (`af3efc7`) re-derives journal/verdicts/recipes; About → **Learning** toggles the local recording (`knowledge.json.journaling`) — the consent it replaces gated shipping, which does not exist here | `node --test tests/forge-learn.test.mjs` (incl. the journaling-switch test) |
| 5 | Update check sends a random install id + version + plan | 🚫 | telemetry + auto-update excluded | ADR-0003; EXCLUDED line (license.mjs, update.mjs, telemetry) |
| 6 | Setup choice lines no longer cut off on the right | ⚪ | Windows `Setup.cs` stays frozen (ADR-0003); the Linux checklist prints full rows (`installer/install.sh`, `ShowChecklist`) | `installer/install.sh -DryRun` transcript in ticket 16 comments |

## 0.4.8 — the installer looks at what is already there and installs the chosen set

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | "What to install" step: every program/model with version, location, download size; outdated marked "update" (old ComfyUI, model of another size, no FLUX.2/Qwen loader) | ✅ | ticket 16 (`a7ef9b9`): scan core `installer/imaginarium_scan.mjs` emits the shipped `##ITEM` 13-field contract; `-ScanOnly` prints the verdict table | `node --test tests/install-scan.test.mjs`; live `installer/install.sh -ScanOnly` |
| 2 | Per-component checkboxes; Quick/Full/Lite presets; Node.js/interface/Blender untickable; dependencies auto-tick; footer download vs free disk | ✅ | ticket 16: `install.sh` checklist (rules re-derived from Setup.cs: mandatory trio, preset letters, dep tick, footer) | same suite + the scripted checklist demo (ticket 16 comments) |
| 3 | Exactly the ticked set installs, unattended, into the app folder; unavailable items greyed with the reason | ✅ | ticket 16 | real partial install demo: ticks `clips`+`vfx` → exactly those landed (88 clips + VFX apps, comfy untouched) |
| 4 | A failed computer check installs the chosen set whole | ✅ | ticket 16: `IMAGINARIUM_INSTALL_SCAN_FAIL=1` demo; `PresetPlan` fallback | ticket 16 demo transcript |

## 0.4.9 — free updates install themselves

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1–3 | Free versions download+install updates in the background; About → Updates switch; subscriber versions auto-install only with subscription | 🚫 | auto-update (`server/update.mjs`) and subscription excluded; the "check what an update brought" half survives as the Components window (0.4.10 row below) | ADR-0003 |

## 0.4.10 — after an update the studio checks whether everything is installed

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | "Studio components" window: lists installed/missing/outdated; "Install selected" downloads in the background into the app folder; restart so new models appear | ✅ | ticket 19 (`2bd09b7`): `server/components.mjs` + `src/ComponentsPanel.jsx`; without an auto-update channel "after an update" = **first start of a new version** (`data/update/checklist.json`); the restart hint names `scripts/stop.sh`/`start.sh` | `node --test tests/components.test.mjs`; live demo installed `godot` in the background and the engine list picked it up after restart (ticket 19 comments) |
| 2 | Presets set the ticks, deps auto-tick; "Later" closes, About → Studio components reopens | ✅ | ticket 19 (panel presets q/f/l + dep tick + dismissal) | same suite; "Later" during a job hides while the install keeps running (reference parity: no cancel exists) |
| 3 | Add FLUX.2 klein / Qwen-Image from the window without the installer | ✅ | tickets 06+19: rows `flux2`/`qwenimg` with `only` ids land via `install.sh -Yes -Only …` | `tests/install-scan.test.mjs` (2D rows) + components argv test |
| 4 | Free updates install themselves on next start | 🚫 | as 0.4.9 | ADR-0003 |

## 0.4.11 — the studio starts again after a Full setup

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | The assistant settings file (`data/config.json`) was written unreadable and closed the studio on every start; now both sides handle it | ✅ | ticket 03 (`bb1511b`): BOM-safe, forgiving config readers (`readJson` strips BOM, tolerates junk) and an installer that writes `config/paths.json` through node (never BOMs) | `node --test tests/json-bom.test.mjs tests/start-launch.test.mjs` |
| 2 | The Pixal3D path the installer wrote is no longer lost | ✅ | ticket 03 (paths survive as `pixal3dDir`) + ticket 16 (`SaveFound` writes `pixal3dDir` after scan) | `node --test tests/pixal3d.test.mjs`; t16 install transcripts show `config/paths.json` |

## 0.4.12 — downloads pass where they fell with code 35

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | Code 35 (Windows could not check the site's certificate revocation): after the first such error download on without that check; site certificate still verified; model files checksummed | ⚪+✅ | The `--ssl-no-revoke` flip is Windows Schannel-specific. Linux curl (OpenSSL) never performs revocation checks — **not applicable**; the shipped ruling is recorded in ticket 17. Code 35 joins the ordinary flaky-TLS resume set here; checksum verification is unconditional on every checked download | `node --test tests/install-download.test.mjs` (test asserts code 35 retries AND that `--ssl-no-revoke` is never passed); `installer/imaginarium_download.sh` header |
| 2 | A failed download writes a plain-language reason + the exact error text to `installer/install.log` (and into the report) | ✅🚫 | ticket 17 (`da194e6`): one quotable line `Download failed: <url> (curl code N - <reason>; curl: <text>). Run the installer again - the download will resume.`; codes 6/7/18/22/28/33/35/52/56/60/92 decoded like the shipped `CurlReason`; the report channel excluded (telemetry) | `node --test tests/install-download.test.mjs`; the shipped error journal `docs/product/install-errors.md` restored verbatim (ticket 17) |

## 0.4.13 — PyTorch, Blender and animations install where they fell; updates resume

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | PyTorch (code 2, ~3 GB): waits longer, retries, repeats the step twice more on network failure; the real reason shown | ✅ | ticket 17: `PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10` + `UvTry` (3 tries, growing pause, `error:`/`Caused by:` extraction, package-server advice) wrapping the uv/pip steps of `install.sh`, `install-pixal3d.sh` | `node --test tests/install-download.test.mjs` (retry, advice, fail-fast on non-network errors) |
| 2 | Blender 403 (code 22): same file from the official Blender mirrors, checksum verified | ✅ | ticket 17: `ManifestMirrors` rewrites the manifest's Windows-archive mirror list to the Linux archive; real Linux sha256/size pins verified on whichever mirror answered | live demo: dead primary → halifax mirror delivered the 374 MB archive, sha matched (ticket 17 comments) |
| 3 | Animations "code 33": a host that cannot resume gets a clean re-download | ✅ | ticket 17: code 33 deletes the `.part` and restarts the file (never re-sends `-C -`) | `node --test tests/install-download.test.mjs` (noresume33) |
| 4 | An update cut off mid-download resumes from the same place | 🚫+✅ | update delivery excluded (0.4.9); **resumable downloads are implemented for everything the installer fetches** (`-C -` for the flaky-code classes) | `node --test tests/install-download.test.mjs` (cut56 byte-offset resume); live: a truncated 100 MB `u2net.onnx.part` resumed to the exact 175 997 641 bytes |

## 0.4.14 — Node.js installs where nodejs.org does not answer; clear start messages

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | "Node.js was not found" after setup: Node now taken from backup mirrors with a checksum | ✅ | ticket 17: `InstallNode` via `ManifestMirrors node …` (nodejs.org primary + 4 mirrors rewritten to the Linux tar) + `NodeTarSha/NodeTarSize` pins | `node --test tests/install-download.test.mjs` (mirror rewrite lists 5 node URLs) |
| 2 | When something is missing, start says what happened and what to do (run the installer; send install.log) | ✅ | ticket 03 (`bb1511b`): `scripts/start.sh` fails bilingually (RU/EN, the shipped Start.ps1 words) with the remedy and the log files named | `node --test tests/start-launch.test.mjs` |
| 3 | The studio finds Node in its own `runtime/node` even without a saved settings file | ✅ | ticket 03: `start.sh` scans `runtime/node/bin/node` before PATH | same suite |

## 0.4.15 — Ollama signature check, PixaFlux protected download

| # | Bullet (EN/RU notes) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | The Ollama installer runs only when signed by "Ollama Inc."; a substituted file is deleted and the rest of the setup continues | ✅⚠️ | ticket 18 (`6fd8334`) Linux form: Authenticode has no Linux analogue and this tree never runs third-party installer binaries — the equivalent anchor is the vendor's own checksum channel: the official release `tar.zst` installs into `runtime/ollama` **only if its sha256 matches the same release's `sha256sum.txt`**; mismatch → deleted, never extracted/executed, setup continues (deliberate difference recorded in ticket 18) | `node --test tests/install-download.test.mjs` (tamper pair: cached + fresh mismatch deleted, stub binary never run; verified archive installs and `config/paths.json` points at it) |
| 2 | PixaFlux (VFX tab) over https with a pinned checksum — installer, Blender add-on and samples; a cached file with another sum is re-downloaded; the studio runs the installer only on a match | ✅ | ticket 18: catalog https + three `sha256` pins (shipped values); `scripts/vfx/install-vfx.sh` passes the sums through the shared `DownloadChecked` — nothing that failed is ever unpacked or launched (PixaFlux itself stays a Windows-only tool per its vendor; the gate protects the whole VFX download line) | `node --test tests/vfx-tools.test.mjs` (https + pin test); live tamper demo (wrong pin → empty `apps/`, right pin → installs) |
| 3 | Subscription price/update paragraphs | 🚫 | monetization line excluded | ADR-0003 |

## 0.4.16 — shared studio recipes

| # | Bullet (EN) | Status | Where / why | Proof |
|---|---|---|---|---|
| 1 | Shared studio recipes: journals studios send are summed into default recipes that arrive with the update | 🚫 | the whole community layer (`server/learn-community.mjs`, shipped digest, upload pipeline) excluded per EXCLUDED.md; an update channel does not exist here either | ticket 20 comments; ADR-0003 |
| 2 | Your own experience wins: your params, accepted runs and pinned recipes beat shared ones; a shared recipe only fills what is unset and every value is checked | ✅ | ticket 20 (`af3efc7`) in the local form — the same precedence ladder is what the layering implements here: explicit/preset params > class pin > class journal > kind > `*`; only unset keys filled; every result passes `normalizeParams` | `node --test tests/forge-learn.test.mjs` (precedence, `recipes:false`, pinned-layer tests) |
| 3 | A recipe becomes shared only after confirmation on several computers / by the studio author; ratings improve recipes for everyone | 🚫 | multi-computer aggregation needs journal shipping — excluded with telemetry | ADR-0003 |

## Shipped since 0.4.6 but never committed (not in any release note)

The payload contained a whole body that predates the lost history; it is part of this tree too
(ticket → commit): About panel 04 `7d103b4` · 2D tab body 05 `8af7f72` · Sculpt 07 `e477dd7` ·
pixel sprites 08 `ab708b6…2404697` (5 commits) · generators & engine check 09 `2404697`/
`ab708b6` · MCP server + integrator kit 10 `0b50989` · Blender humanoid/creature 11 `65025a7` ·
Blender mesh/export/paint 12 `853136f…bfa8aaf` (4 commits) · forge server deltas 13 `6f759d0` ·
studio UI body 14 `60a2ef4` · Unity export line 15 `05f7ed3`.

## Unverified on this machine (flagged per policy)

| Item | Status | What is verified / what is not |
|---|---|---|
| Unity export (`unity/` C# editor scripts, `unity_package` profiles) | ⚠️ | Generated package data, project settings and the export steps are covered by `npm test` (forge suites run headless Blender/Godot stubs); **no Unity editor exists on this machine**, so opening the package in Unity and the C# compile are unverified — the flag also sits in the unity package README and ticket 15 comments |
| Windows install/start flow (`Setup.cs`, `Install.ps1`, `Start.cmd`) | ⚪ | Frozen at their repo state per ADR-0003; verification on this branch is Linux-only by decision |
| AMD / non-RTX hardware paths | ⚪ | The AMD installer build is excluded; the scan's RTX-family reasons and no-GPU Lite branch are unit-tested with `IMAGINARIUM_INSTALL_NO_GPU=1` instead of real AMD hardware |
| License/keys server, support endpoints, auto-update | 🚫 | Not implemented here at all (EXCLUDED line), so nothing to verify |

## Exclusion list (complete, per ADR-0003)

`license.mjs` (validation/prose) · `server/update.mjs` (auto-update) · telemetry (error reports,
journal shipping, install id) · `support.mjs` endpoints · `learn-community.*` (shared recipes) ·
installer subscription step · release-sign · AMD build · Windows frontends kept frozen
(`Setup.cs`, `Install.ps1`, `*.ps1` except the shared download core swap, which left them
untouched). The subscription/license paragraphs inside the restored `installer/notes-*.txt` files
are historical artifacts kept verbatim and describe the Windows distribution, not this tree.

*Closeout commit: this file's first commit on `linux-support` at version 0.5.0; clean-clone
verification transcript in ticket 21's comments.*
