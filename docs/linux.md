# AstraForge on Linux

AstraForge shipped as a Windows application; the `linux-support` branch has grown into the Linux
studio — since 0.5.0 it carries the full feature set of the shipped Windows 0.4.16 re-derived for
Linux, since 0.5.1 the re-derived behavior of the shipped Windows 0.5.x line, since 0.6.6 the
Windows 0.6.0 → 0.6.6 line as one release, and since 0.6.12 the Windows 0.6.7 → 0.6.12 patches as
one folded release (see the sections below and
`docs/product/acceptance-0.5.0.md` / `acceptance-0.5.1.md` / `acceptance-0.6.6.md` /
`acceptance-0.6.12.md`). This page documents the
Linux support and the exact boundaries of parity (see `GLOSSARY.md`, "Linux parity", and
ADR-0001/0002). The Windows side stays untouched: every shared-code change is behind a
`process.platform` check or lives in Linux-only files, and the Windows frontends
(`Setup.cs`, `Install.ps1`, `*.ps1`) are frozen.

## 0.5.0 — the 0.4.16 re-introduction

Version 0.5.0 of this branch re-introduces everything the shipped `AstraForge-Setup-0.4.16.exe`
contained, as clean-room re-derivations (ADR-0003): the installer "What to install" checklist with
presets, dependency auto-tick and the Lite setup for machines without an NVIDIA GPU
(`installer/af_scan.mjs` + `install.sh`); the download core with mirrors, resume and plain-language
reasons in `installer/install.log` (`installer/af_download.sh`); the integrity gates (node/Blender
sha+size pins, Ollama installed only on a checksum match against the vendor's own
`sha256sum.txt`, PixaFlux https + pinned sums); the in-app **Studio components** window with
background installs; the **local self-learning** journal (verdicts, class recipes, pitfalls —
Review → "Journal & recipes", `scripts/forge.mjs learn`, About → Learning); plus the whole
never-committed 0.4.6-era body (About panel, 2D tab with FLUX.2 klein and Qwen-Image, Sculpt,
pixel sprites, generators and the engine check, MCP server and integrator kit, the Blender
deltas, the forge server, the studio UI, the Unity export line).

Excluded by decision (ADR-0003), so absent here and named in every doc that mentions them:
license validation, auto-update, telemetry (error reports, journal shipping, install id),
support endpoints, shared community recipes, the installer subscription step, release-sign, the
AMD build. Flagged unverified on Linux hardware: the Unity editor round-trip of the export line
(no Unity editor on the verification machine) — the generated package data itself is covered by
`npm test`.

The bullet-by-bullet map of release notes 0.4.7–0.4.16 to this tree, with the proof command for
each row, is the [0.5.0 acceptance report](product/acceptance-0.5.0.md).

## 0.5.1 — the Windows 0.5.x wave, re-derived under Protocol v2

Version 0.5.1 adds the behavior of the shipped `AstraForge-Setup-0.5.0.exe` … `0.5.3.exe`
(parity artifact: **0.5.3**, the union; Windows builds stamp FileVersion 0.4.17 internally),
re-derived under the strict clean-room protocol of
[ADR-0004](adr/0004-protocol-v2-clean-room-and-attribution.md): paraphrased intent, observed
behavior and interface facts as the only spec channels; implementing contexts never read the
extracted payload; every commit gated by an independent similarity audit:

- **startup resilience** — corrupt job files move to `data/jobs/broken/`; a `config.json` that is
  not JSON at all moves aside untouched as `config.json.broken-<timestamp>` and defaults boot the
  run (ticket 02); a `config.json` that *is* JSON but holds a key from another program or a value
  this build rejects is read field by field — the foreign key is dropped, that one field falls back
  to its default, everything the user set survives, and the file on disk is left for the next save
  to rewrite (ticket 17). Saving from the Connections window is still strictly validated: the
  tolerant path only ever reads what is already there;
- **installer honesty** — Ollama below 0.12.7 refused with a recovery sentence, vanished downloads
  name the antivirus/folder-sync cause, `ASTRA_INSTALL_ISOLATED=1` keeps a check run out of the
  user's model library, `-v` and every banner print the real `package.json` version (ticket 03);
- **Hybrid UI** — dark/light/follow-system theme applied before first paint, Simple/Detailed view
  modes, top-bar switches, the whole palette tokenized so light theme works everywhere, Inter +
  Oswald + JetBrains Mono bundled under OFL (ticket 04);
- **Unreal Engine 5 export** — `unreal_package` builds `af_unreal.json` (SM_/SK_, UCX hulls, LODs,
  BaseColor/DirectX-Normal/ORM, MI_ instances), the Python-only `unreal/AstraForge` plugin
  materializes it, the engine bridge gained create/send/test/mcp-register for `.uproject`
  projects — verified at the data level, in-editor run flagged unverified here (ticket 05);
- **MCP `generator_*`** — status/nodes/graphs/run/restart for the ComfyUI backend through the
  studio job layer; the engine-management, graph-edit and learn verbs are documented as absent
  with the reason, not silently missing (ticket 06);
- **Unity collision hulls** — `*-colonly` / `*-convcolonly` / `COL_*` meshes never render: they
  become UCX convex hulls in the FBX, wired into the passport and double-checked by the importer
  (ticket 07).

Deferred or excluded by decision (Engine + self-learning LoRA, provenance/licensing machinery,
updater/telemetry/keys-server, AMD/ROCm, frozen Windows frontends) — the full list with reasons is
the deviations section of the [0.5.1 acceptance report](product/acceptance-0.5.1.md).

## 0.6.6 — the Windows 0.6.0 → 0.6.6 line, re-derived and shipped once

Version 0.6.6 of this branch adds everything the shipped `AstraForge-Setup-0.6.0.exe` plus its
0.6.1–0.6.6 patches bring over 0.5.3 — as a **single Linux release** (Windows shipped 0.6.0 and
then patched; this branch folded the patches in before its one release, so there was never a
Linux 0.6.0–0.6.5; recorded deviation). Same Protocol v2 discipline as 0.5.1: T1/T2/T3 spec
channels only, payload quarantined, every commit gated by a fresh-context similarity audit.

- **TripoSG — the third shape engine** (ticket 01/02): a standalone venv worker (weights + code
  installed as checklist components, per-file resumable checksummed downloads), `auto` resolves the
  shape engine by card — TripoSG ≤ 9216 MiB, else Pixal3D, else Hunyuan — all through the
  `ASTRA_VRAM_MIB` seam; Windows ships it as an Engine plugin, this branch keeps the worker shape
  (deviation recorded);
- **SkinTokens refused on license grounds** (ticket 03): the released checkpoint hard-asserts a
  GPL-vendored mesh encoder, so the engine slot stays open and `skintokens` is rejected before
  anything spawns, with the reason and a doc — the Blender template rig remains the supported path;
- **Sound** (tickets 04/05): a tab that makes effects from a description and seamless music loops
  from a style prompt (MOSS-SoundEffect + ACE-Step, Apache-2.0/MIT, own venv), library + event
  bindings on the game object, and the MCP `sound_*` family for agents;
- **the style bible** (tickets 06/07): styles are reference pictures + an English description
  (described locally by the installed vision model); a 2D set carries a bible, and the drawing
  goes through **Qwen-Image-Edit 2511 GGUF** with the lightning LoRA (stock ComfyUI nodes, not the
  Engine — deviation), gated at 10 GiB of video memory, FLUX.2 klein below it;
- **auto-review** (ticket 08): the studio checks its own finished shapes — Blender orbit render,
  five VLM score axes, and the **verdict from a fixed threshold table, never from the model**;
  rejected attempts redo with new seeds (retries 0..3, best kept), every verdict journaled
  (`<library>/learning/autoreview.jsonl`), the «Check» tab shows it all;
- **FLUX.2 klein 4B** (ticket 09): the 2D tab's base model swapped from 9B to the Apache-2.0 4B
  GGUF — commercial-safe; an existing 9B is reported and left on disk for the user to remove;
- **NATTEN kernel probe** (ticket 11): the Pixal3D installer checks the actual card (torch, CUDA,
  compute capability) and verifies a real `na2d` forward pass instead of assuming; old cards get
  the honest lighter-set recommendation; `install-pixal3d.sh natten` re-checks both environments;
- **«новое, проба»** (ticket 12): experimental components are never preselected by presets (below);
- **Ollama goes local-first** (ticket 14): the studio starts Ollama when nothing answers on
  127.0.0.1:11434, only offers models that are actually installed (live catalog), and the review
  model travels through one explicit pick with the reason recorded next to every verdict;
- **network resilience** (ticket 16): huggingface.co failures retry through hf-mirror.com behind
  the same sha256 gate, damaged arrivals get one full re-download before a named honest failure,
  the clips step reads its mirror list from the manifest, and an unwritable install log never
  aborts a component;
- **tolerant config boot** (ticket 17): one foreign key or bad value in `config.json` no longer
  costs every setting — the file is read field by field, the offender defaults, the rest survives.

The bullet-by-bullet evidence, ⚠️ rows and the audit trail are the
[0.6.6 acceptance report](product/acceptance-0.6.6.md).

## «Новое, проба» — experimental components are never preselected (0.6.6, ticket 12)

Everything this branch classes as experimental — **TripoSG**, **Sound**, **Qwen-Image-Edit**
(and **SkinTokens**, the day it lands; ticket 03 kept it out on license grounds) — is listed in
the checklist and the Studio components window with a «new - a try» badge, but **no preset
(quick / full / lite) ever ticks it**: `installer/af_scan.mjs` (`EXPERIMENTAL`) filters the
manifest profiles, and the -Profile fallback in `install.sh` mirrors the same lists. Ticking one
by hand works exactly like any other row. Upstream's one exception — forcing TripoSG into the
low-VRAM quick set — stays on the Windows side; on this branch the opt-in is unconditional,
which supersedes ticket 02's quick-swap rule (recorded as ticket 12's deviation).

## 0.6.12 — the Windows 0.6.7 → 0.6.12 patches, folded into one release

The second patch fold: Windows shipped 0.6.7…0.6.12 after our 0.6.6; the installers that arrived
(0.6.8, 0.6.10, 0.6.12) drove the re-derivation, and 0.6.7/0.6.9/0.6.11 exist in these trees only
folded (recorded deviation; same honesty as the 0.6.0–0.6.5 fold). Protocol v2 unchanged: notes
and interface facts through the spec channel, payloads quarantined, every commit gated by a
fresh-context similarity audit. Full per-ticket evidence:
[acceptance-0.6.12](product/acceptance-0.6.12.md).

- **Bevy is the fourth export target** (tickets 28–31): profile "Bevy 0.20" ships the same GLB as
  Godot plus an `af_bevy.json` passport; `bevy/astraforge_bevy/` (branch-original MIT) plays a
  package in Bevy 0.20 with one `add_astraforge_asset` line — default-clip autostart, blended
  clips, socket effects, `af_sounds.json` sound banks, hot model reload. With Rust on PATH the
  step also runs a **headless check** (the crate's `af_bevy_check` proves the passport against the
  live world and captures `shots/forward.png` + `shots/clip.png`; env `ASTRA_CARGO*`, shared
  target cache, first check pays the compile); without Rust the export is byte-identical minus
  the check. `node scripts/engines/bevy.mjs status` tells which half this machine gets.
- **MCP parity**: `bevy` in the engine enums and every engine verb; `sound_export
  {engine:"bevy"}` lays the crate-shaped bank; the `bevy_brp_mcp 0.23.0` editor bridge installs
  ONLY via `engine_mcp_register {installBevyBrp:true}` — download, pinned sha256, verified file
  only (the supply-chain rule; there is no bare index install).
- **Self-healing venvs + locale** (25–27): a broken python link is repaired at startup (rebuild,
  not relink); the UI starts in the OS language (`LC_ALL`→`LC_MESSAGES`→`LANG`), persists only an
  explicit choice, header RU/EN switch + Appearance chooser on the key-based i18n layer.
- **Installer honesty and concurrency** (22–24, 33): flock-based single-instance, detached
  installer re-attach (`pid.json`/`status.jsonl`), Ollama models relocate to a roomy drive, and
  an unreadable free-space reading is `unknown` — never a false "0.0 GB — not enough space" stop.
- **Gates before Pixal3D** (20–21): driver 570 floor (unknown driver is never refused), RAM
  precheck with generator unload so a retry goes through.
- **What 0.6.12's own speedups are NOT here**: the native mesh simplifier and raster camera
  fitter ship in the Windows payload as closed binaries with no published source or checksum —
  excluded with reasons (acceptance report); Blender paths stay, slower. The engine lifeline and
  the AMD ROCm fallback sit on standing 🚫 exclusions (engine files / AMD).

## Quick start (Linux)

```bash
git clone https://github.com/jimOnAir/AstraForge AstraForge && cd AstraForge
installer/install.sh -ScanOnly      # report GPU, VRAM, disk, what is already installed
installer/install.sh                # wizard; or: installer/install.sh -Yes
scripts/start.sh                    # http://127.0.0.1:3210
scripts/stop.sh
```

`installer/install.sh` is the bash counterpart of `installer/Install.ps1`: same component ids,
`-ScanOnly` / `-DryRun` / `-Only a,b` / `-Yes` semantics, app-local installs (`runtime/`,
`data/models/`), no administrator rights, resumable downloads (`installer/install.log`).
`scripts/start.sh` / `stop.sh` mirror `Start.ps1` / `Stop.ps1` (paths from `config/paths.json`
into `ASTRA_*`, PID files in `data/runtime/`, shutdown through `POST /api/shutdown`, only the
studio's own ComfyUI/Pixal3D processes are stopped).

Requirements: NVIDIA GPU with the proprietary driver (`nvidia-smi` visible), Node.js ≥ 22.12 or
the installer downloads it, ~20–40 GB free disk (about 52 GB more with Pixal3D), system Blender
5.x or the installer downloads 5.0.1 into `runtime/blender`.

## What differs from Windows

| Area | Windows | Linux |
|---|---|---|
| Secrets (Connections tab) | DPAPI vault | environment variables only: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TRIPO_API_KEY`; entering a key in the tab refuses with an explanation (ADR-0002) |
| GPU lock | named mutex via PowerShell holder | `flock(1)` lock file via an `sh` holder (`$XDG_RUNTIME_DIR`/tmp `astraforge-gpu-*.lock`), kernel-released when the holder dies; `ASTRA_GPU_LOCK_FILE` overrides the file |
| Process launch | `taskkill /T /F` | process groups: `detached` spawn + `kill -KILL -<pid>` (already the POSIX branch) |
| "Open folder" buttons | `explorer.exe` | `xdg-open` |
| VFX desktop tools | Material Maker, FlowMap Painter, PixaFlux, KumoWorks, Slate, Pseudo Volume Generator | **to the vendor limit**: Material Maker (official linux tar) and the 4 web generators work; Pseudo Volume has a Linux zip on itch.io (manual download into `runtime/vfx/downloads`, then rerun); FlowMap Painter / PixaFlux / KumoWorks / Slate show as unavailable (their vendors ship no Linux binary) and are never run through Wine (ADR-0001 context) |
| Pixal3D | portable `python_embeded` + `--windows-standalone-build` | portable folder layout with a `.venv` (same engine on 127.0.0.1:8191, same checks, `runtime/ComfyUI-Pixal3D` default) |

## Gotchas (found on real hardware, RTX 5070 12 GB)

- **Blackwell GPUs (sm_120) need PyTorch `cu128`.** `install.sh` picks the cu128 index whenever
  `nvidia-smi` reports a GPU; a `cpu` wheel will fail generation later, not at install time.
- **`flock -w` parses decimals per locale.** `ru` locales reject `flock -w 2.00` ("invalid
  timeout"), which made every wait look like an instant timeout. The holder therefore passes
  integer seconds and runs with `LC_ALL=C`.
- **MV-Adapter pins can be unsatisfiable in a fresh Linux ComfyUI venv** (diffusers 0.40 vs the
  frozen constraints). The installer retries unpinned while keeping the constraint file, so
  torch/transformers are never upgraded; the "packages added / versions unchanged" line tells
  you it worked.
- **Blender 5.x minor drift is tolerated**: any 5.x from `ASTRA_BLENDER`/PATH is used
  (`install.sh` scans it first, the app-local 5.0.1 portable is the fallback);
  `scripts/forge-smoke.mjs` arbitrates — all generator presets pass on 5.2.2.
- **Godot 4.7 from distro packages validates fine**, but the forge targets 4.5 semantics;
  the installer's `godot` component unpacks the official 4.5.1 Linux binary into
  `runtime/Godot` (scanned before PATH).
- **DINOv3 parity needs two passes on a 12 GB card**: the converter's default parity sizes (512+1024 px)
  allocate ~9 GB on the eager attention path and OOM on an RTX 5070 before saving. `install-pixal3d.sh`
  retries with `--sizes 512` automatically; the parity report then records a 512 px row
  (measured worst diff 1.9e-05, target < 1e-3).
- Ollama keeps its model resident; on a 12 GB card do not run generation while the assistant
  holds a big model (the studio already refuses `/api/chat` while jobs run; the reverse is on you).

## Porting map (for future diffs against upstream)

Windows-only assumptions that got a platform branch — anything new should follow the same shape:

- `server/storage.mjs` — `venvPython()`: `.venv/Scripts/python.exe` on Windows, `.venv/bin/python`
  on POSIX (mirrored in `scripts/views/comfy_client.mjs`); consumers: `runtime.mjs`,
  `preprocess.mjs`, `uv.mjs`.
- `server/gpu-lock.mjs` — `startHolder()` shared; PowerShell holder on Windows, flock holder on
  Linux (`supported: true` on both).
- `server/blender.mjs` — `whichSync()`; Blender/Godot discovered from PATH off Windows;
  `runtime/Godot` scanned for `Godot_v*_stable_linux*`.
- `server/pixal3d.mjs` — `pixal3dEnv()` keeps the bat-file System32 PATH trick on Windows only;
  the default folder is `runtime/ComfyUI-Pixal3D` off Windows.
- `server/vfx-tools.mjs` — `linux.local` / `linux.unsupported` catalog fields; `xdg-open`
  instead of `explorer.exe`; the UAC elevation retry is Windows-only.
- `server/vault.mjs` — refuses non-Windows key entry; env vars are the documented path.
- Tests gate Windows-path semantics (`..\\x`, System32, `taskkill`) behind `process.platform`.
