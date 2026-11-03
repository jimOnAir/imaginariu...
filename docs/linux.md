# AstraForge on Linux

AstraForge shipped as a Windows application; the `linux-support` branch has grown into the Linux
studio — since 0.5.0 it carries the full feature set of the shipped Windows 0.4.16 re-derived for
Linux (see the section below and `docs/product/acceptance-0.5.0.md`). This page documents the
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
