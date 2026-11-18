# AstraForge: a local 3D asset studio

[Русская версия: README.ru.md](README.ru.md)

> **Free base version · Commercial license by subscription** — https://snodrod.github.io/AstraForge/
>
> - **Free:** [AstraForge-Setup.exe](https://github.com/Snodrod/AstraForge/releases/latest) (0.4.6, *Quick* ≈ 30 GB or *Full* ≈ 95 GB). Personal, educational and other **noncommercial** use only, no updates — [PolyForm Noncommercial 1.0.0](LICENSE-0.4.2.md).
> - **Subscription — $5/month or $49/year:** use AstraForge and everything you make with it **commercially**, and get every update on release day — [subscription license](COMMERCIAL-LICENSE.md). [Subscribe](https://snodrod.github.io/AstraForge/#subscribe).
> - **This branch (`linux-support`) is a Linux studio for AstraForge, an independent MIT-licensed re-implementation ([LICENSE](LICENSE), © 2026 Dmitry Belozerov).** AstraForge itself is a 3D asset studio created by Artem Doronin (Dops Media); this branch re-derives its *documented behavior* for Linux from scratch under the strict clean-room protocol of [ADR-0004](docs/adr/0004-protocol-v2-clean-room-and-attribution.md) — it contains no source code under the PolyForm or subscription licenses above, is not affiliated with Dops Media, and grants no rights in the AstraForge name. The monetization line (license validation, auto-update, telemetry) is out of scope by design. Version **0.7.10** carries, on top of the Windows 0.4.16 feature set (0.5.0/0.5.1 waves), the
re-derived behavior of the shipped Windows 0.6.0 → 0.7.10 line — 0.6.6 folded the first seven
releases into one, 0.7.1 the fourteen patches after it, 0.7.9 the eight after that together with
a performance wave measured on Linux hardware, and this release the VRM line after that; the
release line was retargeted a fifth time before tagging (this fold is record #5 of the line's
#1–#5, all disclosed in the acceptance reports); the parity artifacts that actually arrived are **`AstraForge-Setup-0.6.8.exe`** (md5 `8fc2d345501e1abea7637be1a73f3846`),
**`AstraForge-Setup-0.6.10.exe`** (md5 `49a32878c1bb26918a508e4c0dc6f813`),
**`AstraForge-Setup-0.6.12.exe`** (md5 `2a58c9d62e4de282bea244d26f00ae43`),
**`AstraForge-Setup-0.6.18.exe`** (md5 `458223df82e2b291b089b38dd06e021f`),
**`AstraForge-Setup-0.7.0.exe`** (md5 `e4213515d8695d042298194b87c9fe5b`) and
**`AstraForge-Setup-0.7.1.exe`** (md5 `f074a5e56460c6c8262da576f4e5610c`), and — new in this
lineage — the upstream **`AstraForge-0.7.9-linux.tar.gz`**: from v0.7.7 the author ships official
Linux builds too; like every payload it stays quarantined on this branch, this fold's tree
evidence being the extracted **0.7.3**, **0.7.9** and **0.7.10** payloads plus the branch's own
probes. The
0.6.7, 0.6.9, 0.6.11 and 0.6.13–0.6.17 installers never arrived, and no 0.6.19+ artifact or
notes file exists at all: their content is observable only folded into the trees above
(recorded deviations).
Highlights of the newest stretch, the VRM release: **anime humanoid avatars as one `.vrm` file**
— the VRM 1.0 export step, driven by the sha256-pinned VRM add-on inside the step's own Blender,
with the bone table re-derived from the published spec (Required-15, shoulders optional), the
ARKit-52 expression set wired from the publisher's own blend weights, and a run report whose
expression count is **pinned byte-equal to the exported file** — verified live, including a real
third-party avatar's 128-bone skeleton recognized at **52 bones, zero required missing**; the
`.vrm` upload route admits a file by signature **and** declaration, so a renamed `.glb` fails
closed. Highlights of the previous stretches: an **fp8 UNet tier for cards ≤16 GB, measured on both this
machine's cards** — the 12 GB card refuses the fp16 shape before step 1 and runs fp8 at a 6.45 GB
peak, the 16 GB card holds 5.87 GB on the widest shape, so the line's low-VRAM cures land here
without an 8 GB card in the room; **af-mesh-rs** — the studio's own MIT decimator over vendored
pinned meshoptimizer (built offline; rig weights, colors, normals and shape keys survive
simplification 1:1), a 3 998 792-triangle salvage in 24.9 s → 0.38 s, exactly 2.5M triangles out;
the **Bevy bridge driven against a running game** — 0.7.1's honest ⚠️ closed with a live session
(a curl fallback that never actually ran was found and fixed on the way); **hidden-arms
auto-rigging** — the recorded 0.08–0.12 m shoulder drift on arms inside the torso silhouette now
≤ 0.034 m with baseline cases byte-identical; **cleanup order honesty** — heavy meshes collapse
first (`planar_wait_above_tris`, default chosen from this machine's measured cost table);
**Hunyuan3D-2mini** — the small shape model (live run: 22 s, ~4.5 GB net on this card) with
`auto` as the new default, picking it only on a small card that actually has the file;
**network honesty** — PyTorch's official R2 wheel mirror and one named Hugging Face verdict per
run; **LOD files and a compact GLB** in the convert step (exact triangle fractions via af-mesh-rs;
EXT_meshopt_compression lands in a separate file, because Godot cannot read it — verified with
Godot 4.7.2); **Blender 5.2.4 LTS** pinned through the 7-day supply-chain gate, the full
22-module Blender lane run on it as the "same result" proof; **language-parity guards** that
turn a hardcoded string in either skin into a red test; **the klein 9B back as an explicit
opt-in** (its non-commercial licence travels with record, panel and asset; never a silent
fallback); and six small honesty fixes (progress without lies, a port contract, a verified
Ollama-folder move, cancelled ≠ failed, a front-locked paint camera, RU text→3D without an
assistant). The earlier folded stretches (Bevy as the fourth export target, salvaged
over-cap generations, the posture guard, the 8 GB paging sentinel, `keep_rig`, weight reuse,
self-healing venvs, installer concurrency — see the [0.7.1 acceptance
report](docs/product/acceptance-0.7.1.md)) all stay shipped here.
Excluded with reasons: the 0.6.12 native speedups (closed binaries, no published source or
checksum), the textured Pixal3D (C++) component, **the 0.7.6 Rust rewrites of the Forge hot
paths** (their host is that closed core — this wave's af-mesh-rs, fp8 tier and planar-wait are
the measured branch-own answer on the same classes), and **the 0.7.0 closed Rust core** — the host
of the node editor and content studio, gated on Windows by an active subscription: the
monetization line and unpublished native code are standing exclusions of this branch. See the
[0.7.10 acceptance report](docs/product/acceptance-0.7.10.md) (and
[0.7.9](docs/product/acceptance-0.7.9.md), [0.7.1](docs/product/acceptance-0.7.1.md),
[0.6.6](docs/product/acceptance-0.6.6.md),
[0.5.1](docs/product/acceptance-0.5.1.md)) for what
shipped, what is deliberately excluded and what is unverified here. The `v0.5.0` line (feature set of shipped Windows 0.4.16) was produced under the earlier ADR-0003 bar; the retroactive audit has now run and found that pre-existing body to be verbatim payload material rather than re-derived code — disclosed in full in the [similarity audit](docs/product/similarity-audit-0-5-1.md), with a module-by-module rewrite campaign open; until it lands, the MIT grant above covers the original code of this branch (everything added under ADR-0004, audit-gated per ticket), and the rest stays under the rights holder's terms. See also the [0.5.0 acceptance report](docs/product/acceptance-0.5.0.md). The `master` source stays the older 0.3.0; released Windows installers are distributed under the licenses above.

AstraForge is a Windows app that turns a picture or a text prompt into a game-ready 3D asset on your own machine: concept → geometry → editor → rig and animation → effects → export (GLB, OBJ, WebM, PNG, isometric sprite sheets, Godot packages). The server listens on `127.0.0.1` only. The UI is available in English and Russian (English by default, switch in the app).

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10/11 x64 | Windows 11 x64 |
| GPU | NVIDIA, 8 GB VRAM | NVIDIA, 12+ GB VRAM |
| Pixal3D (optional) | RTX 30/40/50 series, 10+ GB VRAM | RTX 40/50, 12+ GB VRAM |
| RAM | 16 GB | 32 GB |
| Free disk | 20-40 GB (+ about 52 GB if you add Pixal3D) | SSD |
| Network | Internet for the first install (downloads of models and tools) | |
| Rights | No administrator rights needed | |

Use a short Latin-only install path such as `C:\AstraForge`.

## Quick start with Claude Code

> **Linux?** This branch runs natively on Linux: `installer/install.sh` (the "What to install" checklist, the Lite setup, the mirror/resume/checksum download core - same component ids and flags as the PowerShell wizard), `scripts/start.sh` / `stop.sh`, the flock GPU lock, the Pixal3D Linux recipe, the in-app Studio components window and local self-learning. See [docs/linux.md](docs/linux.md) and the [0.6.6 acceptance report](docs/product/acceptance-0.6.6.md).

You need [Claude Code](https://claude.com/claude-code).

```powershell
git clone https://github.com/Snodrod/AstraForge C:\AstraForge
cd C:\AstraForge
claude
```

Then tell Claude Code: **"Install and set up AstraForge for me."** The repository contains a `CLAUDE.md` with the exact procedure. Claude Code will:

1. **Scan your computer without downloading anything:**
   `powershell -NoProfile -ExecutionPolicy Bypass -File installer\Install.ps1 -ScanOnly`
   It reports your GPU and VRAM, free disk space and what is already installed (Node.js, Blender, ComfyUI, Hunyuan3D models, SDXL, Godot, Ollama, Pixal3D).
2. **Show the plan and ask you which optional components to install.** Each has its own size and licence:

   | id | What | Size |
   |---|---|---|
   | `node`, `npm` | Node.js 22 and the UI build (required) | about 0.3 GB |
   | `blender` | Blender 5.2.4 (required) | about 0.4 GB |
   | `comfy` / `comfydeps` | ComfyUI 0.33.2 + Python 3.12 + PyTorch (required) | about 6 GB |
   | `hy2`, `u2net` | Hunyuan3D-2 (image to 3D) and background removal (required) | 4.9 GB + 0.2 GB |
   | `hymv` | Hunyuan3D-2mv: 3D from front and back views | 4.9 GB |
   | `hy21` | Hunyuan3D-2.1 | 7.4 GB |
   | `sdxl` | SDXL: text to image | 6.9 GB |
   | `mvadapter` | MV-Adapter: extra views from one picture (needs SDXL) | about 3.8 GB |
   | `godot` | Godot 4.5.1: validates game packages | 77 MB |
   | `clips` | Quaternius animations (CC0), needs Blender | 10 MB |
   | `ollama`, `llm` | local Qwen3 assistant (model picked by VRAM: qwen3:4b / 8b / 14b) | 2.5-9 GB |
   | `vlm` | qwen3-vl:8b: texture and animation checks | 6.1 GB |
   | `vfx` | VFX texture generators | about 0.5 GB |
   | `pixal3d`, `pixal3dw`, `pixal3dtest` | Pixal3D: shape from 1-4 views, RTX 30/40/50 and 10+ GB VRAM | about 48.5 GB |

3. **Run the installer unattended** (`-Yes -Only <ids>`) in the background, because the wizard is interactive and cannot be answered inside Claude Code. Downloads take tens of minutes; if one is interrupted, rerun the same command and it resumes.
4. **Verify the result** with `-ScanOnly` again and by reading `config\paths.json`.
5. **Start the studio** with `Start.cmd` and check `http://127.0.0.1:3210/api/health`, which must answer `"app":"AstraForge"`.
6. **Troubleshoot** from `installer\install.log`, `data\runtime\server-error.log` and `data\runtime\comfy.log`, reinstalling only the broken component with `Install.ps1 -Yes -Only <id>`.

The API key for the custom OpenAI-compatible endpoint and the Tripo key are optional. Enter them in the app's **Connections** tab, where Windows DPAPI encrypts them. Never paste keys into a chat or commit them to the repository.

## Manual install

1. Clone or download this repository to a short path, for example `C:\AstraForge`.
2. Double-click **Install AstraForge.cmd** and answer the wizard's questions. It scans your PC, shows what is missing with sizes and licences, and downloads everything into this same folder (`runtime\`, `data\models\`). An interrupted download continues on the next run. A desktop shortcut **AstraForge** is created at the end.
3. Start the studio with **Start.cmd**.

No git? Download **AstraForge-Setup-&lt;version&gt;.exe** from [Releases](https://github.com/Snodrod/AstraForge/releases/latest), run it and choose a folder: it unpacks the app and starts the same wizard. The file is not code-signed, so Windows SmartScreen may warn you: click *More info → Run anyway*.

The installer writes the paths it finds to `config\paths.json`, and `Start.cmd` reads them from there. Command-line options of `installer\Install.ps1`:

- `-ScanOnly`: only inspect the computer;
- `-DryRun`: walk through the wizard without downloading;
- `-Only hy2,u2net`: install the listed components only (no optional questions; list them in install order). Ids: `node`, `npm`, `blender`, `comfy`, `comfydeps`, `hy2`, `hymv`, `hy21`, `sdxl`, `u2net`, `godot`, `clips`, `ollama`, `llm`, `vlm`, `mvadapter`, `pixal3d`, `pixal3dw`, `pixal3dtest`, `vfx`;
- `-Yes`: no questions (installs the required components and the wizard's defaults; Pixal3D is not installed by default).

Log: `installer\install.log`.

## Run and stop

1. Double-click **Start.cmd** (or the **AstraForge** desktop shortcut). The studio opens at **http://127.0.0.1:3210**. It runs its own ComfyUI on port 8190; wait for the Hunyuan3D status to appear.
2. Stop with **Stop.cmd**. It stops this studio's processes and leaves any other ComfyUI and Ollama you run untouched.

Do not delete `data` if you want to keep your projects, models and connections.

## Features

- **Create.** Upload a PNG/JPG/WEBP with one object on a neutral background, or type a prompt (SDXL makes the picture first). rembg removes the background on the CPU and Hunyuan3D builds the geometry.
- **Views.** From one front view (a character in a T-pose) the app creates left, back and right views, either through ChatGPT/Codex or locally with MV-Adapter (offline, about 40 s). "Create 3D from views" then builds the model with Hunyuan3D-2mv from all views. See `docs/forge/views.md` and `docs/forge/views_install.md`.
- **Pixal3D.** Optional shape generation from 1-4 views (geometry only, no textures). See `docs/forge/pixal3d.md`.
- **Editor.** Move, rotate and scale objects; colour, metalness, roughness; primitives; import GLB, OBJ and STL (GLB must embed its textures; external links are blocked).
- **Textures.** UV atlas that keeps weights, PBR maps up to 4K, painting on the model, reference colour projection. See `SURFACES-SPRITES-GODOT.md`.
- **Bones.** Humanoid, Quadruped, Mechanical and Custom skeleton templates, hierarchy editing, rest/pose, distance-based skinning, a weights brush and a library of named clips. See `GODOT-RIGGING.md`.
- **Animation and effects.** Keyframes, ready-made clips (Quaternius CC0, Mixamo), particles (sparks, engine trail, energy field), and a VFX texture workshop (`docs/vfx-tools.md`).
- **Forge.** A Blender-based pipeline for parts, items in hands, rigs, motion styles, kitbash and procedural sci-fi ships and turrets (`docs/forge/`).
- **Export.** GLB, OBJ, WebM, PNG, `.astra.json` projects, isometric sprite sheets (PNG + Godot SpriteFrames) and game packages: Godot, Unity and Unreal Engine 5 (an `af_unreal.json` deliverable for the Python importer plugin). Export profiles: `godot`, `space_quest`, `heroes_gates`, `iso8`, `unity`, `unreal`. Everything is also saved to `data/exports`.
- **Tripo.** An optional tab that connects the official Tripo cloud API (generation, mesh processing, textures, auto-rig, motion, formats). It needs your own API key and credits. See `TRIPO-CAPABILITIES.md`.
- **AI assistant.** Local Ollama by default, or any OpenAI-compatible API endpoint: you give the base URL and the model name, the key is optional (local servers often need none). The assistant only returns a limited set of validated actions (material, transform, motion, effects) that you apply with a button. It never runs arbitrary code or OS commands.

Keyboard shortcuts: W move, E rotate, R scale, F frame, Space play, Delete remove, Ctrl+D duplicate, Ctrl+S save, Ctrl+Z undo, Ctrl+Shift+Z redo.

### Optional components

| Component | What it gives | Size | Requirements |
|---|---|---|---|
| **MV-Adapter** (`mvadapter`) | Builds left/back/right views from one front picture locally and offline. Node `huanngzh/ComfyUI-MVAdapter` (with AstraForge patches) goes to `data\runtime\custom_nodes`, weights to `data\models\mvadapter` | about 3.8 GB (+ SDXL 6.9 GB if missing) | NVIDIA, 10+ GB VRAM preferred |
| **qwen3-vl:8b** (`vlm`) | Local vision model for texture and animation checks (`ASTRA_QA_VLM` changes the model); installed through Ollama | 6.1 GB | Ollama |
| **Pixal3D** (`pixal3d` engine, `pixal3dw` weights, `pixal3dtest` smoke test) | A separate portable ComfyUI on port 8191 (`127.0.0.1` only) with TRELLIS.2 and Pixal3D. Default folder `runtime\ComfyUI-Pixal3D`; override with `ASTRA_PIXAL3D_DIR` (`pixal3dDir` in `config\paths.json`) | about 42 GB download, 48.5 GB on disk (52 GB free recommended) | NVIDIA RTX 30/40/50, 10+ GB VRAM (8 GB with a warning); short path without non-Latin characters |
| **VFX texture generators** (`vfx`) | Material Maker, PixaFlux, KumoWorks, Slate, FlowMap Painter, Pseudo Volume Generator and four offline web generators (`scripts\vfx\Install-VfxTools.ps1`, catalog `server\vfx-tools-catalog.json`) | about 330 MB download, 500 MB on disk | Node.js with npm for DisplacementX |

Pixal3D is installed by a pinned recipe: Python 3.12.10 (signature checked), ComfyUI 0.39.0 and `visualbruno/ComfyUI-Trellis2` at pinned commits, PyTorch 2.8.0+cu128, pinned PyPI packages (`installer\pixal3d\requirements-lock.txt`), FlashAttention 2.8.3, `utils3d` 1.7 from GitHub, and weights from Hugging Face verified with sha256. DINOv3 is taken only from the official timm copy and converted locally; the node's automatic download from a third-party mirror is disabled by the `ASTRAFORGE PATCH`.

## Licences

- **Hunyuan3D** models are distributed under the [Tencent Hunyuan Community License](https://github.com/Tencent-Hunyuan/Hunyuan3D-2), which **does not apply in the European Union, the United Kingdom and South Korea**. Do not use them there.
- **Pixal3D environment:** the Trellis2 node imports **nvdiffrast** and **nvdiffrec_render** (NVIDIA, **non-commercial licence**) and PyMeshLab (GPL-3.0). AstraForge does not call nvdiffrast, nvdiffrec_render or any texturing step. For commercial work, check these licences yourself and do not use the Trellis2/Pixal3D texturing nodes.
- Blender and ComfyUI are GPL; Quaternius / ActionForge animations are CC0.
- **The code on this branch** is MIT © 2026 Dmitry Belozerov (see `LICENSE`, with the provenance and attribution block); it re-implements documented behavior only and is not a work of Dops Media. The Windows AstraForge product and its source stay under PolyForm Noncommercial / subscription licenses (see `LICENSE-0.4.2.md`). Other licences are listed in `THIRD_PARTY_NOTICES.md`.

Generated results depend on the licence of the model that produced them. Check it before shipping anything commercially.

## AI and accounts

Local messages stay on your computer. If you pick the custom API, the message and a scene description are sent to the endpoint you configured, which needs that server to be reachable and, unless it runs without auth, your key and quota. Keys are encrypted with Windows DPAPI, stored on the server and never returned to the browser; `CUSTOM_LLM_API_KEY` is also supported (on Linux/macOS put it in the gitignored `.env` — `scripts/start.sh` exports it). A plain `http://` endpoint sends the key unencrypted — use `https://` with real keys. DPAPI keys are bound to your Windows user, so copying the folder to another user does not carry keys over. AI and generation share one GPU and run one after another.

## Limits

No sculpting, per-vertex editing, trained neural auto-rig, IK / foot contact, semantic segmentation or AI retopology locally; auto-rig, neural textures and mesh processing exist only as Tripo cloud operations. Local textures are procedural or projected. Heavy meshes need optimization; gzip projects are limited to 512 MB of unpacked JSON. This is not a replacement for a full DCC editor. Next-stage components are discussed in `RESEARCH-RIGGING-GODOT.md`; the architecture is in `ARCHITECTURE.md`.

## For AI agents

Skills for Claude Code, Codex and other agents are in `ai/skills/` (see `ai/skills/README.md`); `CLAUDE.md` holds the install procedure for Claude Code.

## Development

Node.js 22.12+; `npm install`, `npm run build`, `npm start` (or `npm run dev`). Tests: `npm test`. Logs: `data/runtime/server-error.log` and `data/runtime/comfy.log`. Point to an existing ComfyUI with `ASTRA_COMFY_DIR`. Without ComfyUI the editor still works, but neural generation is unavailable. Forge module docs are in `docs/forge/`.
