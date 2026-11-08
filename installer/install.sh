#!/usr/bin/env bash
# AstraForge installer for Linux (the counterpart of installer/Install.ps1).
#
#   installer/install.sh                 check the computer, the "What to install" checklist, install
#   installer/install.sh -ScanOnly       only inspect the computer, download nothing (verdict table)
#   installer/install.sh -ScanList       the machine scan as "##ITEM" lines (frontend contract)
#   installer/install.sh -Profile quick|full|lite   the checklist's preset (default quick)
#   installer/install.sh -DryRun         walk through the checklist without downloading
#   installer/install.sh -Only hy2,u2net install only these components (list them in install order;
#                                        -Only none installs nothing)
#   installer/install.sh -Yes            no questions: the preset of -Profile ticks as a whole
#   installer/install.sh -v              print the installer version - always the app version in package.json
#
# Isolated check mode: ASTRA_INSTALL_ISOLATED=1 runs the installer as a check that leaves no trace on
# this computer beyond the application folder (models pulled by the studio land in runtime/models/ollama
# instead of the shared user library; a serve process started by this run is stopped on exit).
#
# The checklist ticks every missing/outdated row of the preset, Node.js, npm and Blender are
# untickable, ticking a row pulls in its dependencies, a computer without an NVIDIA card is offered
# the Lite set, and the footer shows the download size against the free disk. A failed computer
# check falls back to installing the chosen preset as a whole. Scan logic: installer/af_scan.mjs.
# Everything installs into this application folder (runtime/, data/models/), needs no root, and an
# interrupted download resumes on the next run. Ids: node, npm, blender, comfy, comfydeps, hy2,
# hymv, hy21, sdxl, u2net, godot, clips, ollama, llm, vlm, mvadapter, pixal3d, pixal3dw,
# triposg, triposgvae, triposgdino, pixal3dtest, vfx, gguf, flux2, qwenimg, sound, soundmoss, soundace.  Log: installer/install.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$ROOT/runtime"
DL="$ROOT/installer/downloads"
LOG="$ROOT/installer/install.log"
CFGF="$ROOT/config/paths.json"

NodeVersion='v22.23.3'
ComfyTag='v0.33.2'
BlenderTar='https://download.blender.org/release/Blender5.0/blender-5.0.1-linux-x64.tar.xz'
# Linux archive pins (the manifest pins the Windows archives; these were taken from the official
# downloads on 2026-11-03 and are verified on every download, mirrors included)
NodeTarSize=31001304; NodeTarSha='df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'
BlenderTarSize=374154072; BlenderTarSha='8019580ee1b7262e505f4196a00237ccf743c88d205b38d34201510676e60b09'
GodotZip='https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_linux.x86_64.zip'
GodotBin='Godot_v4.5.1-stable_linux.x86_64'
UvTar='https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz'
VlmName='qwen3-vl:8b'
VlmBytes=6100000000
# 2D engines (the same pins as installer/manifest.json; the Windows frontends stay frozen, ADR-0003)
GgufNodeCommit='b6016439f135342819461256ec5f03fbb4003a8b'
GgufNodeUrl="https://github.com/molbal/ComfyUI-GGUF/archive/$GgufNodeCommit.zip"
Flux2UnetUrl='https://huggingface.co/unsloth/FLUX.2-klein-base-4B-GGUF/resolve/main/flux-2-klein-base-4b-Q4_K_M.gguf'
Flux2UnetSha='5e3893a005ec1b0515ba6c23f6a93bec37ddf7fd2dfcf101fef4e19bc53c3a1c'
Flux2TeUrl='https://huggingface.co/Comfy-Org/Flux-2-Klein-4B/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors'
Flux2TeSha='3eab03a77adb0ee5304a4e677d5c10ac22f9049c1d7c894adca4f8bb39206ca8'
Flux2VaeUrl='https://huggingface.co/Comfy-Org/Flux-2-Klein-4B/resolve/main/split_files/vae/flux2-vae.safetensors'
Flux2VaeSha='868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3'
QwenUnetUrl='https://huggingface.co/city96/Qwen-Image-gguf/resolve/main/qwen-image-Q4_K_M.gguf'
QwenUnetSha='c6f49103603b9a4927502549fb615c910386cfc675b1466325930ba10d2a11f4'
QwenTeUrl='https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'
QwenTeSha='cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4'
QwenEditUnetUrl='https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF/resolve/main/qwen-image-edit-2511-Q4_K_M.gguf'
QwenEditUnetSha='07951f61941a81e236cbd4a9b6f250d49626b3ba518f260135bf2e01a87cf1c8'
QwenEditLoraUrl='https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'
QwenEditLoraSha='22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f'
QwenVaeUrl='https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files/vae/qwen_image_vae.safetensors'
QwenVaeSha='a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f'
# TripoSG (docs/product/triposg.md, ticket 02): the MIT VAST-AI clone pinned to one commit (the
# archive sha from the same archive on 2026-11-06) and the HF snapshot files (sha256 as published
# by the Hugging Face LFS listing, re-verified on the downloaded files). Weights go to
# runtime/triposg/models/TripoSG, the venv to runtime/triposg/.venv, the clone to src/TripoSG.
TripoSGCommit='fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c'
TripoSGZip="https://github.com/VAST-AI-Research/TripoSG/archive/$TripoSGCommit.zip"
TripoSGZipSize=16411924; TripoSGZipSha='cbb21f7dbb9f6759b84f00b5bcdce5c75a5130ae3a63d012646cd274fd945062'
TripoSGTfUrl='https://huggingface.co/VAST-AI/TripoSG/resolve/main/transformer/diffusion_pytorch_model.safetensors'
TripoSGTfSize=5758280104; TripoSGTfSha='9192b5923f7b605b394192809aa2ceb73bf0f4009674d8e3b999b45bb97d4bf2'
TripoSGVaeUrl='https://huggingface.co/VAST-AI/TripoSG/resolve/main/vae/diffusion_pytorch_model.safetensors'
TripoSGVaeSize=970685468; TripoSGVaeSha='a2e667c24927a5a35e5f19fcb4c75890e9399aa966b6db8131d7df733a750c8b'
TripoSGDinoUrl='https://huggingface.co/VAST-AI/TripoSG/resolve/main/image_encoder_dinov2/model.safetensors'
TripoSGDinoSize=1217522888; TripoSGDinoSha='399fba97a95f22c36834418bc69373364a99af3a1153da1c0fb31db567c92e23'
# The version this installer sets up is read from package.json - the installer never stamps its own
# literal, so the announced version cannot drift from the app (behavior per ADR-0004, ticket 03)
InstallerVersion="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$ROOT/package.json" 2>/dev/null | head -1)"
[ -n "$InstallerVersion" ] || InstallerVersion='dev'
# Models need at least this Ollama (the minVersion gate, Linux form per ADR-0004, ticket 03: the
# shipped manifest.json keeps its Windows text, the pin lives here like the other Linux constants)
OllamaMinVersion='0.12.7'
S_OLLAMA=''

# ---------------------------------------------------------------- arguments
ScanOnly=0 ScanList=0 DryRun=0 Yes=0 Only='' Profile='quick' Lite=0
prev=''
for arg in "$@"; do
  case "$arg" in
    -ScanOnly|--scan-only) ScanOnly=1 ;;
    -ScanList|--scan-list) ScanList=1 ;;
    -DryRun|--dry-run) DryRun=1 ;;
    -Yes|--yes) Yes=1 ;;
    -Profile=*|--profile=*) Profile="${arg#*=}" ;;
    -Only=*|--only=*) Only="${arg#*=}" ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    -v|--version) printf 'AstraForge installer %s\n' "$InstallerVersion"; exit 0 ;;
    *) if [ "$prev" = '-Only' ] || [ "$prev" = '--only' ]; then Only="$arg"
       elif [ "$prev" = '-Profile' ] || [ "$prev" = '--profile' ]; then Profile="$arg"; fi ;;
  esac
  prev="$arg"
done
case "$Profile" in quick|full|lite) ;; *) printf 'Unknown profile: %s (quick, full, lite)\n' "$Profile" >&2; exit 2 ;; esac
# an unattended run (or -Only): curl works quietly and the download loop prints '##PROGRESS' lines
if [ "$Yes" = 1 ] || [ -n "$Only" ]; then ASTRA_UNATTENDED=1; export ASTRA_UNATTENDED; fi

# ---------------------------------------------------------------- helpers
say() { printf '%s\n' "$1"; printf '%s\n' "$1" >>"$LOG"; }
Ok() { say "  [found]    $1"; }
Miss() { say "  [missing]  $1"; }
Opt() { say "  [optional] $1"; }
Title() { say ''; say "== $1 =="; }
Gb() { awk -v b="$1" 'BEGIN{printf "%.1f GB", b/1e9}'; }
Mb() { awk -v b="$1" 'BEGIN{printf "%.0f MB", b/1e6}'; }
Human() { if [ "$(awk -v b="$1" 'BEGIN{print (b>=1e9)?1:0}')" = 1 ]; then Gb "$1"; else Mb "$1"; fi; }

# Ask <question> <default y|n> — returns true when the answer is yes
Ask() {
  local def="${2:-y}"
  if [ "$Yes" = 1 ]; then [ "$def" = y ]; return; fi
  local ans
  if [ "$def" = y ]; then read -r -p "$1 [Y/n] " ans || ans=''; else read -r -p "$1 [y/N] " ans || ans=''; fi
  ans="${ans:-$def}"
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# the download core (Download/FileOk/DownloadChecked/DownloadMirrors/CurlReason/UvTry) is shared
# with the pixal3d and vfx installers: installer/af_download.sh
# shellcheck source=af_download.sh
. "$ROOT/installer/af_download.sh"

# mirror URL list of a program from installer/manifest.json, rewritten from the pinned Windows
# archive to this Linux one (the mirrors carry the whole release folder); primary site first
ManifestMirrors() { # <program> <replacement file name>
  local prog="$1" leaf="$2" n
  n="$(NodeBin)"
  if [ -z "$n" ]; then return 1; fi
  "$n" -e '
    const m = require(process.argv[1]); const p = (m.programs || {})[process.argv[2]] || {};
    const re = /(node-v[\d.]+-win-x64\.zip|blender-[\d.]+-windows-x64\.zip)$/;
    const us = [p.url].concat(p.mirrors || []).filter(Boolean).map((u) => (re.test(u) ? u.replace(re, process.argv[3]) : u));
    process.stdout.write(us.join("\n") + "\n");' "$ROOT/installer/manifest.json" "$prog" "$leaf" 2>/dev/null
}

# Run <exe> <what it is> [args...]
Run() {
  say "    $2"
  "$1" "${@:3}"
  local rc=$?
  [ "$rc" = 0 ] || say "  $2 - failed (code $rc)"
  return $rc
}

# config/paths.json through node (the same file scripts/start.sh reads)
NodeBin() { if [ -n "${S_NODE:-}" ]; then printf '%s' "$S_NODE"; else command -v node || true; fi; }
CfgGet() { local n; n="$(NodeBin)"; if [ -z "$n" ]; then printf ''; return; fi; "$n" -e 'try{const c=require(process.argv[1]);const v=c[process.argv[2]];process.stdout.write(v==null?"":String(v))}catch(e){}' "$CFGF" "$1" 2>/dev/null || true; }
CfgSet() { local n; n="$(NodeBin)"; if [ -z "$n" ]; then say '  node is needed to save config/paths.json'; return 1; fi; "$n" -e '
 const fs=require("fs"),p=require("path"),f=process.argv[1];let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
 for(let i=2;i<process.argv.length;i+=2)c[process.argv[i]]=process.argv[i+1];
 fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$CFGF" "$@"; }

FreeOn() { df -B1 --output=avail "$1" 2>/dev/null | tail -1 | tr -d ' '; }

# ---------------------------------------------------------------- scan (installer/af_scan.mjs is the scan core)
ITEMS_FILE="$DL/scan-items.tsv"

ScanCore() {   # af_scan.mjs --sh -> the S_* scan state + the ##ITEM checklist rows; SCAN_OK=0 on any failure
  SCAN_OK=0
  local n; n="$(NodeBin)"
  if [ -z "$n" ]; then
    say '  Node.js is needed for the computer check - the chosen preset will be installed as a whole.'
    return 1
  fi
  local out="$DL/scan-sh.txt"
  mkdir -p "$DL"
  if ! "$n" "$ROOT/installer/af_scan.mjs" --sh >"$out" 2>"$DL/scan-err.txt"; then
    say "  The computer check failed: $(head -1 "$DL/scan-err.txt" 2>/dev/null)"
    say '  The chosen preset will be installed as a whole.'
    return 1
  fi
  grep '^##ITEM' "$out" >"$ITEMS_FILE" || : >"$ITEMS_FILE"
  grep -v '^##ITEM' "$out" >"$DL/scan-state.sh"
  # shellcheck source=/dev/null
  . "$DL/scan-state.sh"
  SCAN_OK=1
}

ScanTable() {  # -ScanOnly: the per-component verdict table of the scan core
  local n; n="$(NodeBin)"
  if [ -z "$n" ]; then say '  Node.js is needed for the computer check (installer/install.sh -Only node first).'; return 2; fi
  "$n" "$ROOT/installer/af_scan.mjs" --table
}

ScanList() {   # -ScanList: the ##ITEM frontend contract (the same lines Setup.cs parses on Windows)
  local n; n="$(NodeBin)"
  if [ -z "$n" ]; then say '  Node.js is needed for the computer check (installer/install.sh -Only node first).'; return 2; fi
  "$n" "$ROOT/installer/af_scan.mjs" --items
}

RecommendLlm() {
  if [ "${S_VRAM:-0}" -ge 16000 ] 2>/dev/null; then WantLlm='qwen3:14b'; LlmBytes=9300000000
  elif [ "${S_VRAM:-0}" -ge 8000 ] 2>/dev/null; then WantLlm='qwen3:8b'; LlmBytes=5200000000
  else WantLlm='qwen3:4b'; LlmBytes=2500000000; fi
}

# ---------------------------------------------------------------- installing components
InstallNode() {
  local arch tarname urls=()
  arch="$(uname -m)"; case "$arch" in x86_64) arch='x64' ;; aarch64) arch='arm64' ;; esac
  tarname="node-$NodeVersion-linux-$arch.tar.xz"
  mapfile -t urls < <(ManifestMirrors node "$tarname") || true
  [ "${#urls[@]}" -gt 0 ] || urls=("https://nodejs.org/dist/$NodeVersion/$tarname")
  # arch != x64: the pinned checksum is the x64 archive's - then only size verification by Download itself
  if [ "$arch" = x64 ]; then
    DownloadMirrors "$DL/$tarname" "$NodeTarSize" "$NodeTarSha" "${urls[@]}" || return 1
  else
    DownloadMirrors "$DL/$tarname" 0 '' "${urls[@]}" || return 1
  fi
  rm -rf "$RT/node"; mkdir -p "$RT"
  tar -xf "$DL/$tarname" -C "$RT" || return 1
  mv "$RT/${tarname%.tar.xz}" "$RT/node" || return 1
  S_NODE="$RT/node/bin/node"; CfgSet node "$S_NODE"
}
InstallNpm() {
  local npm; npm="$RT/node/bin/npm"; [ -x "$npm" ] || npm="$(command -v npm || true)"
  [ -n "$npm" ] || { say '  npm was not found'; return 1; }
  PATH="$(dirname "$S_NODE"):$PATH"
  (cd "$ROOT" && Run "$npm" 'installing dependencies (npm ci)' ci --no-audit --no-fund && Run "$npm" 'building the interface (npm run build)' run build)
}
InstallBlender() {
  local t='blender-5.0.1-linux-x64.tar.xz' urls=()
  mapfile -t urls < <(ManifestMirrors blender "$t") || true
  [ "${#urls[@]}" -gt 0 ] || urls=("$BlenderTar")
  DownloadMirrors "$DL/$t" "$BlenderTarSize" "$BlenderTarSha" "${urls[@]}" || return 1
  mkdir -p "$RT/blender"
  tar -xf "$DL/$t" -C "$RT/blender" || return 1
  S_BLENDER="$RT/blender/blender-5.0.1-linux-x64/blender"; CfgSet blender "$S_BLENDER"
}
InstallGodot() {
  Download "$GodotZip" "$DL/$GodotBin.zip" || return 1
  mkdir -p "$RT/Godot"
  unzip -o -q "$DL/$GodotBin.zip" -d "$RT/Godot" || return 1
  chmod +x "$RT/Godot/$GodotBin"
  S_GODOT="$RT/Godot/$GodotBin"; CfgSet godot "$S_GODOT"
}
Uv() {
  if command -v uv >/dev/null; then
    UV_BIN="$(command -v uv)"
  else
    UV_BIN="$RT/uv/uv"
    if [ ! -x "$UV_BIN" ]; then
      Download "$UvTar" "$DL/uv.tar.gz" || return 1
      mkdir -p "$RT/uv"
      tar -xzf "$DL/uv.tar.gz" -C "$RT/uv" --strip-components=1 || return 1
      chmod +x "$UV_BIN"
    fi
  fi
  export UV_PYTHON_INSTALL_DIR="$RT/python" UV_CACHE_DIR="$RT/uv-cache"
}
InstallComfyDeps() { # <dir> — the venv and PyTorch (CUDA when an NVIDIA GPU was found, CPU otherwise)
  local dir="$1" py
  py="$dir/.venv/bin/python"
  Uv || return 1
  if [ ! -x "$py" ]; then (cd "$dir" && Run "$UV_BIN" 'Python 3.12 for ComfyUI' venv --python 3.12 .venv) || return 1; fi
  local torchIndex='https://download.pytorch.org/whl/cpu'
  [ -n "$S_GPU" ] && torchIndex='https://download.pytorch.org/whl/cu128'
  if ! "$py" -c 'import torch' >/dev/null 2>&1; then
    UvTry 'PyTorch' 3 "$UV_BIN" pip install --python "$py" torch torchvision torchaudio --index-url "$torchIndex" || return 1
  fi
  UvTry 'ComfyUI libraries' 3 "$UV_BIN" pip install --python "$py" -r "$dir/requirements.txt" || return 1
  UvTry 'AstraForge libraries (background removal, meshing, unwrapping)' 3 \
    "$UV_BIN" pip install --python "$py" rembg onnxruntime numba scikit-image xatlas || return 1
}
InstallComfy() {
  local t="ComfyUI-$ComfyTag.zip" dir="$RT/ComfyUI"
  Download "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/$ComfyTag.zip" "$DL/$t" || return 1
  if [ ! -f "$dir/main.py" ]; then
    mkdir -p "$RT"
    unzip -q "$DL/$t" -d "$RT" || return 1
    local src; src="$(find "$RT" -maxdepth 1 -type d -name 'ComfyUI-*' | head -1)"
    mv "$src" "$dir" || return 1
  fi
  InstallComfyDeps "$dir" || return 1
  S_COMFY="$dir"; CfgSet comfyDir "$dir"
}
Model() { # <url> <name>
  Download "$1" "$ROOT/data/models/checkpoints/$2"
}
InstallGgufNode() {
  [ -n "$S_COMFY" ] || { say '  ComfyUI must be installed first'; return 1; }
  local d="$S_COMFY/custom_nodes/ComfyUI-GGUF"
  if [ ! -f "$d/nodes.py" ]; then
    local t='ComfyUI-GGUF.zip'
    Download "$GgufNodeUrl" "$DL/$t" || return 1
    rm -rf "$DL/gguf-x"; mkdir -p "$DL/gguf-x"
    unzip -q "$DL/$t" -d "$DL/gguf-x" || return 1
    local src; src="$(find "$DL/gguf-x" -maxdepth 1 -type d -name 'ComfyUI-GGUF-*' | head -1)"
    mkdir -p "$S_COMFY/custom_nodes"
    mv "$src" "$d" || return 1
    rm -rf "$DL/gguf-x"
  fi
  # node dependencies even when the node was already copied: an interrupted first run left gguf uninstalled
  if [ -f "$d/requirements.txt" ] && ! "$S_COMFY/.venv/bin/python" -c 'import gguf' >/dev/null 2>&1; then
    Uv || return 1
    Run "$UV_BIN" 'installing ComfyUI-GGUF dependencies' pip install --python "$S_COMFY/.venv/bin/python" -r "$d/requirements.txt" || return 1
  fi
  S_GGUF=yes
  say '  ComfyUI-GGUF is installed; the engine attaches it at startup (restart the studio after the install).'
}
InstallFlux2() {
  InstallGgufNode || return 1
  # the 9B era left weights here; they are the user's files, kept, but said out loud (ticket 09)
  for old in "$S_COMFY"/models/unet/flux-2-klein*9b*.gguf; do
    [ -e "$old" ] && say "  Note: the previous FLUX.2 klein 9B is still on disk ($(du -h "$old" | cut -f1)): $(basename "$old"). It is not used or touched; delete it yourself when you want the space."
  done
  DownloadChecked "$Flux2UnetUrl" "$S_COMFY/models/unet/flux-2-klein-base-4b-Q4_K_M.gguf" 2422055488 "$Flux2UnetSha" || return 1
  DownloadChecked "$Flux2TeUrl" "$S_COMFY/models/text_encoders/qwen_3_4b_fp4_flux2.safetensors" 3848213998 "$Flux2TeSha" || return 1
  DownloadChecked "$Flux2VaeUrl" "$S_COMFY/models/vae/flux2-vae.safetensors" 336211292 "$Flux2VaeSha" || return 1
  S_FLUX2=yes
}
# the style engine (ticket 07): the edit model rides the SAME text encoder and VAE pins as qwenimg,
# so it downloads them if absent but never the plain t2i unet - 13 GB of picture belongs to its own row.
InstallQwenEdit() {
  InstallGgufNode || return 1
  DownloadChecked "$QwenTeUrl" "$S_COMFY/models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" 9384670680 "$QwenTeSha" || return 1
  DownloadChecked "$QwenVaeUrl" "$S_COMFY/models/vae/qwen_image_vae.safetensors" 253806246 "$QwenVaeSha" || return 1
  DownloadChecked "$QwenEditUnetUrl" "$S_COMFY/models/unet/qwen-image-edit-2511-Q4_K_M.gguf" 12842830432 "$QwenEditUnetSha" || return 1
  DownloadChecked "$QwenEditLoraUrl" "$S_COMFY/models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" 849608296 "$QwenEditLoraSha" || return 1
  S_QWENEDIT=yes
}
InstallQwen() {
  InstallGgufNode || return 1
  DownloadChecked "$QwenUnetUrl" "$S_COMFY/models/unet/qwen-image-Q4_K_M.gguf" 13065746976 "$QwenUnetSha" || return 1
  DownloadChecked "$QwenTeUrl" "$S_COMFY/models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" 9384670680 "$QwenTeSha" || return 1
  DownloadChecked "$QwenVaeUrl" "$S_COMFY/models/vae/qwen_image_vae.safetensors" 253806246 "$QwenVaeSha" || return 1
  S_QWEN=yes
}

EnsureOllama() {
  if [ -z "$S_OLLAMA" ]; then
    say '  No usable Ollama - the model step was skipped. Install Ollama from https://ollama.com, then run this installer again: it will retry the model.'
    return 1
  fi
  local started=''
  for _ in $(seq 30); do
    curl -sf -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && return 0
    if [ "$started" != 1 ]; then "$S_OLLAMA" serve >/dev/null 2>&1 & disown; started=1; ASTRA_SERVE_PID=$!; ASTRA_SERVE_OWNED=1; fi
    sleep 2
  done
  say '  Ollama did not answer on http://127.0.0.1:11434 - the model step was skipped; check this Ollama can serve (ollama --version, ollama serve), then run the installer again.'
  return 1
}
PullModel() { EnsureOllama && Run "$S_OLLAMA" "downloading model $1" pull "$1"; }
PullLlm() {
  PullModel "$1" || return 1
  local n; n="$(NodeBin)"
  (cd "$ROOT" && "$n" -e '
   const fs=require("fs"),f="data/config.json";let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
   c.provider="ollama";c.ollamaModel=process.argv[1];c.ollamaUrl="http://127.0.0.1:11434";
   fs.mkdirSync("data",{recursive:true});fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$1")
}
InstallVfx() {
  local dir; dir="$(CfgGet vfxTools)"; [ -n "$dir" ] || dir="$RT/vfx"
  CfgSet vfxTools "$dir"
  "$ROOT/scripts/vfx/install-vfx.sh" -Root "$dir"
}
InstallClips() {
  local src="$DL/actionforge" base='https://actionforge.app/assets/animation-library' n f
  n="$(NodeBin)"
  Download "$base/manifests/library.json" "$src/manifests/library.json" || return 1
  while read -r f; do [ -n "$f" ] && { Download "$base/$f" "$src/$f" || return 1; }; done < <("$n" -e '
   const fs=require("fs");const man=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
   for(const k of Object.keys(man.clips))console.log(man.clips[k].file.split("?")[0])' "$src/manifests/library.json")
  local fbx="$DL/actionforge_fbx"
  Run "$S_BLENDER" 'converting clips to FBX (Blender)' -b --factory-startup --python "$ROOT/installer/af_clips_to_fbx.py" -- "$src" "$fbx" --library || return 1
  mkdir -p "$fbx/_import"
  "$n" -e '
   const files=require(process.argv[1]);
   require("fs").writeFileSync(process.argv[2],JSON.stringify({step:"clip_library",inputs:{},params:{action:"import",files,library:process.argv[3]},out_dir:process.argv[4]},null,2))' \
    "$fbx/files.json" "$fbx/_import/request.json" "$S_LIBRARY/animations" "$fbx/_import" || return 1
  Run "$S_BLENDER" 'importing clips into the AstraForge library' -b --factory-startup --python "$ROOT/scripts/blender/af_run.py" -- clip_library "$fbx/_import/request.json" || return 1
}
# The 0.4.15 gate, Linux form: Windows verifies the OllamaSetup.exe Authenticode signature of
# 'Ollama Inc.' before running it; on Linux nothing is ever run as an installer, so the equivalent
# is: the official release archive is installed only after its sha256 matches the sha256sum.txt of
# the same GitHub release (https, the publisher's own checksum list - what the signature chain
# stands for on Windows). A tampered or mismatched archive is deleted and never extracted/executed.
OLLAMA_SHA=''
OllamaReleaseSha() { # <asset file name> - sets OLLAMA_SHA from the release's sha256sum.txt
  OLLAMA_SHA=''
  rm -f "$DL/ollama-sha256sum.txt"   # always fresh: a cached list could trail the archive
  say '    checking the release checksum list of Ollama'
  if ! Download "https://github.com/ollama/ollama/releases/latest/download/sha256sum.txt" "$DL/ollama-sha256sum.txt"; then return 1; fi
  OLLAMA_SHA="$(awk -v f="$1" '$2 == "./" f || $2 == f { print $1; exit }' "$DL/ollama-sha256sum.txt")"
  [ -n "$OLLAMA_SHA" ]
}

# True when the binary reports at least OllamaMinVersion: an older Ollama is never used for the
# model steps, the checksum-verified copy goes into runtime/ollama instead (like a missing one).
OllamaVersionOk() { # <binary>
  local v
  v="$("$1" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
  [ -n "$v" ] && [ "$(printf '%s\n%s\n' "$OllamaMinVersion" "$v" | sort -V | head -1)" = "$OllamaMinVersion" ]
}

InstallOllama() {
  local got cfgn arch asset
  # ASTRA_INSTALL_NO_OLLAMA=1 forces the download path for tests, like ASTRA_INSTALL_NO_GPU for the scan
  got=""; [ "${ASTRA_INSTALL_NO_OLLAMA:-}" = 1 ] || got="$(command -v ollama || true)"
  if [ -n "$got" ] && OllamaVersionOk "$got"; then S_OLLAMA="$got"; CfgSet ollama "$got"; return 0; fi
  [ -n "$got" ] && say "  Ollama at $got is older than $OllamaMinVersion - not used; the checksum-verified copy goes into runtime/ollama instead."
  cfgn="$(CfgGet ollama)"; if [ -n "$cfgn" ] && [ -x "$cfgn" ] && OllamaVersionOk "$cfgn"; then S_OLLAMA="$cfgn"; return 0; fi
  [ -n "$cfgn" ] && [ -x "$cfgn" ] && say "  The Ollama saved in config/paths.json is older than $OllamaMinVersion - not used; installing a current copy into runtime/ollama."
  arch="$(uname -m)"; asset=''
  case "$arch" in x86_64) asset='ollama-linux-amd64.tar.zst' ;; aarch64) asset='ollama-linux-arm64.tar.zst' ;; esac
  if [ -z "$asset" ] || ! command -v zstd >/dev/null; then
    say "  Ollama $OllamaMinVersion or newer is needed: install or update it from https://ollama.com (Linux: curl -fsSL https://ollama.com/install.sh | sh) and run the installer again."
    return 1
  fi
  if ! OllamaReleaseSha "$asset"; then
    say '  The sha256 list of the latest Ollama release did not answer or has no line for the asset - Ollama was not installed.'
    return 1
  fi
  say "  downloading Ollama $asset (sha256 verified)"
  if ! DownloadChecked "https://github.com/ollama/ollama/releases/latest/download/$asset" "$DL/$asset" 0 "$OLLAMA_SHA"; then
    say '  The Ollama archive did not match the release checksum - the file is deleted and Ollama is not installed.'
    return 1
  fi
  mkdir -p "$RT/ollama"
  if ! tar --zstd -xf "$DL/$asset" -C "$RT/ollama"; then
    say '  Could not unpack the Ollama archive.'
    rm -rf "$RT/ollama"; return 1
  fi
  if [ ! -x "$RT/ollama/bin/ollama" ]; then
    say '  The Ollama archive has no bin/ollama - the release layout changed; Ollama was not installed.'
    rm -rf "$RT/ollama"; return 1
  fi
  S_OLLAMA="$RT/ollama/bin/ollama"; CfgSet ollama "$S_OLLAMA"
  say '  Ollama is in runtime/ollama - the checksum of the official release matched.'
}

# Pixal3D for Linux: installer/pixal3d/install-pixal3d.sh (engine|weights|test), same manifest pins
# TripoSG as a standalone install (docs/product/triposg.md, ticket 02): its own venv, the
# commit-pinned MIT clone and the HF snapshot split into three verified download steps, each
# resumable on its own. configs=small json files (checksummed) land next to their weights.
TriposgDir() { local dir; dir="$(CfgGet triposgDir)"; [ -n "$dir" ] || dir="${ASTRA_TRIPOSG_DIR:-$RT/triposg}"; CfgSet triposgDir "$dir"; printf '%s' "$dir"; }
TriposgConfig() { # <url> <dst> <sha>
  DownloadChecked "$1" "$2" 0 "$3" || return 1
}
TriposgComponent() { # env|code|tf|vae|dino
  local dir; dir="$(TriposgDir)"
  local py="$dir/.venv/bin/python"
  local M="$dir/models/TripoSG"
  case "$1" in
    env)
      Uv || return 1
      if [ ! -x "$py" ]; then Run "$UV_BIN" 'TripoSG Python environment (Python 3.11)' venv "$dir/.venv" --python 3.11 || return 1; fi
      local torchIndex='https://download.pytorch.org/whl/cpu'
      [ -n "$S_GPU" ] && torchIndex='https://download.pytorch.org/whl/cu128'
      if ! "$py" -c 'import torch' >/dev/null 2>&1; then
        UvTry 'TripoSG PyTorch' 3 "$UV_BIN" pip install --python "$py" torch torchvision --index-url "$torchIndex" || return 1
      fi
      UvTry 'TripoSG libraries' 3 "$UV_BIN" pip install --python "$py" -r "$ROOT/scripts/triposg/requirements.txt" || return 1 ;;
    code)
      DownloadChecked "$TripoSGZip" "$DL/triposg-code.zip" "$TripoSGZipSize" "$TripoSGZipSha" || return 1
      if [ ! -f "$dir/src/TripoSG/triposg/pipelines/pipeline_triposg.py" ]; then
        say '    unpacking the pinned TripoSG clone'
        mkdir -p "$dir/src"
        rm -rf "$dir/src/TripoSG" "$dir/src/TripoSG-$TripoSGCommit"
        unzip -q "$DL/triposg-code.zip" -d "$dir/src" || return 1
        mv "$dir/src/TripoSG-$TripoSGCommit" "$dir/src/TripoSG" || return 1
      fi
      printf '%s\n' "$TripoSGCommit" > "$dir/PINNED-COMMIT.txt"
      TriposgConfig 'https://huggingface.co/VAST-AI/TripoSG/resolve/main/model_index.json' "$M/model_index.json" '750af638d10fc67a5f43d19ef0a0d1d3d446174e24b73bddd0a49226016c80c2' || return 1
      TriposgConfig 'https://huggingface.co/VAST-AI/TripoSG/resolve/main/scheduler/scheduler_config.json' "$M/scheduler/scheduler_config.json" 'ea7c9b4d502dcaba97cd85291cfd7dbd3c6c82cbc4c775af5c6d9224864279c9' || return 1
      TriposgConfig 'https://huggingface.co/VAST-AI/TripoSG/resolve/main/feature_extractor_dinov2/preprocessor_config.json' "$M/feature_extractor_dinov2/preprocessor_config.json" '14e780d86fa1861f8751f868d7f45425b5feb55c38ca26f152ca5097ab30f828' || return 1 ;;
    tf)
      TriposgConfig 'https://huggingface.co/VAST-AI/TripoSG/resolve/main/transformer/config.json' "$M/transformer/config.json" '54ad779e68f9bc7303122cdf291f6db48dec7c67e41d28c05ac359daf914128a' || return 1
      DownloadChecked "$TripoSGTfUrl" "$M/transformer/diffusion_pytorch_model.safetensors" "$TripoSGTfSize" "$TripoSGTfSha" || return 1 ;;
    vae)
      TriposgConfig 'https://huggingface.co/VAST-AI/TripoSG/resolve/main/vae/config.json' "$M/vae/config.json" '2fb6ba9b364d42c9681879dca0f7edcb978f2db974a1ca4b15d28f9b15a5baed' || return 1
      DownloadChecked "$TripoSGVaeUrl" "$M/vae/diffusion_pytorch_model.safetensors" "$TripoSGVaeSize" "$TripoSGVaeSha" || return 1 ;;
    dino)
      TriposgConfig 'https://huggingface.co/VAST-AI/TripoSG/resolve/main/image_encoder_dinov2/config.json' "$M/image_encoder_dinov2/config.json" '8ed81b0d5ffd2c8b2cecd7dc1326d3eefa409bc9d525537b6b2a3c70a992fd02' || return 1
      DownloadChecked "$TripoSGDinoUrl" "$M/image_encoder_dinov2/model.safetensors" "$TripoSGDinoSize" "$TripoSGDinoSha" || return 1 ;;
    *) say "  TriposgComponent: unknown step $1"; return 1 ;;
  esac
}

# Sound as a standalone install (docs/product/sound.md, ticket 04): one venv for both engines (each
# wants its own transformers line), the two commit-pinned open-source archives, and the weight
# snapshots - every file by pinned revision, size and sha256 from installer/sound/manifest.json.
# The code step comes first: the two libraries are installed from the checkouts.
SoundDir() { local dir; dir="$(CfgGet soundDir)"; [ -n "$dir" ] || dir="${ASTRA_SOUND_DIR:-$RT/sound}"; CfgSet soundDir "$dir"; printf '%s' "$dir"; }
SoundManifest() { printf '%s' "$ROOT/installer/sound/manifest.json"; }
SoundWeights() { # <moss|ace> - the manifest files of one engine, each verified before it is accepted
  local dir="$1" key="$2" n url dst size sha
  n="$(NodeBin)"
  while IFS="$(printf '\t')" read -r url dst size sha; do
    [ -n "$url" ] || continue
    DownloadChecked "$url" "$dir/models/$dst" "$size" "$sha" || return 1
  done < <("$n" -e 'const m=require(process.argv[1]),e=m.models[process.argv[2]];if(!e)process.exit(1);
    for(const f of e.files)console.log([`https://huggingface.co/${e.repo}/resolve/${e.revision}/${f.path}`,`${e.dst}/${f.path}`,f.size,f.sha256].join("\t"));' "$(SoundManifest)" "$key")
}
SoundComponent() { # code|env|moss|ace
  local dir; dir="$(SoundDir)"
  local py="$dir/.venv/bin/python" n; n="$(NodeBin)"
  if [ -z "$n" ]; then say '  node is needed to read installer/sound/manifest.json'; return 1; fi
  case "$1" in
    code)
      mkdir -p "$dir/src"
      local key url size sha leaf commit
      for key in moss ace; do
        read -r url size sha leaf commit <<<"$("$n" -e 'const c=require(process.argv[1]).code[process.argv[2]];console.log(c.url,c.size,c.sha256,c.leaf,c.commit)' "$(SoundManifest)" "$key")"
        DownloadChecked "$url" "$DL/sound-$key-code.zip" "$size" "$sha" || return 1
        if [ ! -f "$dir/src/$leaf/pyproject.toml" ]; then
          say "    unpacking the pinned $leaf checkout"
          rm -rf "$dir/src/$leaf" "$dir/src/$leaf-$commit"
          unzip -q "$DL/sound-$key-code.zip" -d "$dir/src" || return 1
          mv "$dir/src/$leaf-$commit" "$dir/src/$leaf" || return 1
        fi
      done
      "$n" -e 'const m=require(process.argv[1]);console.log(Object.values(m.code).map(c=>`${c.repo} ${c.commit} ${c.license}`).join("\n"))' "$(SoundManifest)" > "$dir/PINNED-COMMIT.txt" ;;
    env)
      Uv || return 1
      if [ ! -x "$py" ]; then Run "$UV_BIN" 'Sound Python environment (Python 3.12)' venv "$dir/.venv" --python 3.12 || return 1; fi
      local torchIndex='https://download.pytorch.org/whl/cpu' libs torchlibs
      [ -n "$S_GPU" ] && torchIndex='https://download.pytorch.org/whl/cu128'
      torchlibs="$("$n" -e 'console.log(require(process.argv[1]).env.torch.join(" "))' "$(SoundManifest)")"
      libs="$("$n" -e 'console.log(require(process.argv[1]).env.libs.join(" "))' "$(SoundManifest)")"
      if ! "$py" -c 'import torch' >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        UvTry 'Sound PyTorch' 3 "$UV_BIN" pip install --python "$py" --index-url "$torchIndex" $torchlibs || return 1
      fi
      # ACE-Step brings its own library set; MOSS-SoundEffect follows with --no-deps and the pinned
      # line below, so the two engines cannot pull each other off the versions they were built on.
      UvTry 'Sound libraries (ACE-Step 1.5)' 3 "$UV_BIN" pip install --python "$py" -e "$dir/src/ACE-Step-1.5" || return 1
      UvTry 'Sound libraries (MOSS-SoundEffect v2)' 3 "$UV_BIN" pip install --python "$py" --no-deps -e "$dir/src/MOSS-TTS/moss_soundeffect_v2" || return 1
      # shellcheck disable=SC2086
      UvTry 'Sound libraries (the pinned set both engines run on)' 3 "$UV_BIN" pip install --python "$py" $libs || return 1 ;;
    moss) SoundWeights "$dir" moss || return 1 ;;
    ace)  SoundWeights "$dir" ace  || return 1 ;;
    *) say "  SoundComponent: unknown step $1"; return 1 ;;
  esac
}

Pixal3dComponent() { # engine|weights|test
  local dir; dir="$(CfgGet pixal3dDir)"; [ -n "$dir" ] || dir="${ASTRA_PIXAL3D_DIR:-$RT/ComfyUI-Pixal3D}"
  CfgSet pixal3dDir "$dir"
  "$ROOT/installer/pixal3d/install-pixal3d.sh" "$1" "$dir"
}

InstallMvadapter() {
  local man="$ROOT/installer/mvadapter/manifest.json" n py
  n="$(NodeBin)"
  py="${S_COMFY:-}/.venv/bin/python"
  if [ ! -f "$man" ]; then say '  installer/mvadapter/manifest.json is missing'; return 1; fi
  if [ ! -x "$py" ]; then say '  The studio ComfyUI has no Python environment - install ComfyUI first.'; return 1; fi
  Uv || return 1
  say '  MV-Adapter node'
  if ! grep -q local_sdxl_config "$ROOT/data/runtime/custom_nodes/ComfyUI-MVAdapter/utils.py" 2>/dev/null; then
    say '  The bundled MV-Adapter node with the AstraForge patches is missing from the checkout.'; return 1
  fi
  say '  Python packages in the studio ComfyUI environment'
  local modules missing
  modules="$("$n" -e 'console.log(Object.keys(require(process.argv[1]).modules).join(" "))' "$man")"
  # shellcheck disable=SC2086
  missing="$("$py" -c "import importlib.util as u,sys;print(' '.join(m for m in sys.argv[1:] if u.find_spec(m) is None))" $modules 2>/dev/null || printf '%s' "$modules")"
  if [ -z "$missing" ]; then
    say '    the required Python packages are already installed'
  else
    mkdir -p "$DL"
    local cons="$DL/mvadapter-constraints.txt" before="$DL/mvadapter-freeze-before.txt" after="$DL/mvadapter-freeze-after.txt"
    "$UV_BIN" pip freeze --python "$py" 2>/dev/null | grep '==' | sort > "$before"
    cp "$before" "$cons"
    local pinned plain
    pinned="$("$n" -e 'const m=require(process.argv[1]);console.log(process.argv[2].split(" ").map(w=>m.modules[w]).join(" "))' "$man" "$missing")"
    plain="$(printf '%s' "$pinned" | tr ' ' '\n' | cut -d= -f1 | paste -sd' ' -)"
    say "    missing packages: $pinned (already installed ones will not be upgraded)"
    # shellcheck disable=SC2086
    if ! Run "$UV_BIN" 'installing Python packages for MV-Adapter' pip install --python "$py" -c "$cons" $pinned; then
      say '    the pinned versions did not fit, trying unpinned ones (still without upgrading installed packages)'
      # shellcheck disable=SC2086
      Run "$UV_BIN" 'installing Python packages for MV-Adapter (unpinned versions)' pip install --python "$py" -c "$cons" $plain || return 1
    fi
    "$UV_BIN" pip freeze --python "$py" 2>/dev/null | grep '==' | sort > "$after"
    local changed; changed="$(awk -F'==' 'NR==FNR{a[$1]=$2;next} ($1 in a) && a[$1]!=$2 {print $1": "a[$1]" -> "$2}' "$before" "$after" | paste -sd', ' -)"
    if [ -n "$changed" ]; then say "    WARNING: versions changed: $changed"; else
      say "    packages added: $(($(wc -l < "$after") - $(wc -l < "$before"))), versions of installed ones unchanged"; fi
    # shellcheck disable=SC2086
    missing="$("$py" -c "import importlib.util as u,sys;print(' '.join(m for m in sys.argv[1:] if u.find_spec(m) is None))" $modules 2>/dev/null || true)"
    if [ -n "$missing" ]; then say "  After installation these modules are still not found: $missing"; return 1; fi
  fi
  say '  MV-Adapter weights (Hugging Face huanngzh/mv-adapter, Apache-2.0)'
  local repo fpath fsize fsha
  repo="$("$n" -e 'console.log(require(process.argv[1]).repo)' "$man")"
  read -r fpath fsize fsha <<<"$("$n" -e 'const f=require(process.argv[1]).files[0];console.log(f.path,f.size,f.sha256||"")' "$man")"
  # refresh the pins from the live HF listing when it is reachable (same as the PS HfTree)
  local live
  live="$(curl -s -L --fail --retry 2 --max-time 60 "https://huggingface.co/api/models/$repo/tree/main?recursive=true" 2>/dev/null |
    "$n" -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{const f=JSON.parse(t).find(e=>e.path===process.argv[1]);if(f)console.log(f.size,f.lfs?f.lfs.oid:"")}catch(e){}})' "$fpath" 2>/dev/null || true)"
  if [ -n "$live" ]; then read -r s2 h2 <<<"$live"; [ -n "$s2" ] && fsize="$s2"; [ -n "$h2" ] && fsha="$h2"; fi
  DownloadChecked "https://huggingface.co/$repo/resolve/main/$fpath" "$ROOT/data/models/mvadapter/$fpath" "$fsize" "${fsha:-}" || return 1
  say '  SDXL configs without weights (scripts/views/make_sdxl_config.py)'
  local cfgdir="$ROOT/data/models/mvadapter/sdxl-config"
  Run "$py" 'building data/models/mvadapter/sdxl-config' "$ROOT/scripts/views/make_sdxl_config.py" "$cfgdir" "$S_COMFY" || return 1
  if [ ! -f "$cfgdir/model_index.json" ]; then say '  make_sdxl_config.py did not create sdxl-config.'; return 1; fi
  say '    to make the views work, restart the studio (scripts/stop.sh, then scripts/start.sh)'
}

# ---------------------------------------------------------------- plan
plan=()   # entries: id|what|size|lic
plan_add() { plan+=("$1|$2|$3|$4"); }

comp_what() { case "$1" in
  node) printf 'Node.js %s (into the application folder)' "$NodeVersion" ;;
  npm) printf 'Studio interface and libraries' ;;
  blender) printf 'Blender 5.0.1 (into the application folder)' ;;
  comfy) printf 'ComfyUI %s + Python 3.12 + PyTorch' "$ComfyTag" ;;
  comfydeps) printf 'Missing Python libraries for ComfyUI' ;;
  hy2) printf 'Hunyuan3D-2 model (3D from an image)' ;;
  hymv) printf 'Hunyuan3D-2mv model' ;;
  hy21) printf 'Hunyuan3D-2.1 model' ;;
  sdxl) printf 'SDXL model' ;;
  u2net) printf 'u2net background-removal model' ;;
  mvadapter) printf 'MV-Adapter: node, weights, Python packages' ;;
  godot) printf 'Godot 4.5.1' ;;
  clips) printf 'Quaternius / ActionForge animations (CC0)' ;;
  vfx) printf 'VFX texture generators' ;;
  ollama) printf 'Ollama' ;;
  llm) printf 'model %s' "${WantLlmSet:-${WantLlm:-qwen3:8b}}" ;;
  vlm) printf 'model %s (texture and animation check)' "$VlmName" ;;
  pixal3d) printf 'Pixal3D: engine (Python, PyTorch, ComfyUI, Trellis2 nodes)' ;;
  pixal3dw) printf 'Pixal3D: weights (shape, MoGe-2, NAF, DINOv3)' ;;
  pixal3dtest) printf 'Pixal3D: smoke test' ;;
  triposg) printf 'TripoSG: Python environment, pinned MIT code, shape weights' ;;
  triposgvae) printf 'TripoSG: VAE weights' ;;
  triposgdino) printf 'TripoSG: DINOv2 image-encoder weights' ;;
  sound) printf 'Sound: pinned MOSS + ACE-Step code and Python environment' ;;
  soundmoss) printf 'Sound: MOSS-SoundEffect v2.0 weights (effects)' ;;
  soundace) printf 'Sound: ACE-Step 1.5 weights (music loops)' ;;
  gguf) printf 'ComfyUI-GGUF node' ;;
  flux2) printf 'FLUX.2 klein 4B GGUF + text encoder + VAE' ;;
  qwenimg) printf 'Qwen-Image GGUF + text encoder + VAE' ;;  qwenedit) printf 'Qwen-Image-Edit 2511 GGUF + lightning LoRA (reuses the Qwen-Image encoder and VAE)' ;;
  *) printf '%s' "$1" ;;
esac; }

# the install order of component ids (the Order of Setup.cs; pixal3dtest/gguf are only reachable via -Only)
ORDER_IDS='node npm blender comfy comfydeps hy2 u2net hymv hy21 sdxl mvadapter godot clips vfx ollama llm vlm pixal3d pixal3dw triposg triposgvae triposgdino flux2 qwenimg sound soundmoss soundaceflux2 qwenimg qwenedit sound soundmoss soundace'

# ---------------------------------------------------------------- the "What to install" checklist (0.4.8)
declare -a IT_ID IT_GRP IT_ST IT_HAVE IT_NEED IT_SIZE IT_NAME IT_LIC IT_PRE IT_DEPS IT_ONLY IT_NOTE IT_TICK
declare -A SEL_WHAT SEL_LIC SEL_SIZE
WantLlmSet=''

ParseItems() {   # the ##ITEM rows into the checklist arrays
  IT_ID=(); IT_GRP=(); IT_ST=(); IT_HAVE=(); IT_NEED=(); IT_SIZE=(); IT_NAME=(); IT_LIC=(); IT_PRE=(); IT_DEPS=(); IT_ONLY=(); IT_NOTE=(); IT_TICK=()
  local line m id grp st have need size name lic pre deps only note
  # tab is IFS whitespace: read would collapse empty fields, so split on a non-whitespace separator
  while IFS= read -r line; do
    line="${line//$'\t'/$'\036'}"
    IFS=$'\036' read -r m id grp st have need size name lic pre deps only note <<<"$line"
    [ "$m" = '##ITEM' ] || continue
    IT_ID+=("$id"); IT_GRP+=("$grp"); IT_ST+=("$st"); IT_HAVE+=("$have"); IT_NEED+=("$need"); IT_SIZE+=("$size")
    IT_NAME+=("$name"); IT_LIC+=("$lic"); IT_PRE+=("$pre"); IT_DEPS+=("$deps"); IT_ONLY+=("$only"); IT_NOTE+=("$note"); IT_TICK+=(0)
  done <"$ITEMS_FILE"
}

IsMandatory() { case " node npm blender " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

ApplyPreset() {  # tick = (missing|outdated) && (the row is in the preset || mandatory) - the Setup.cs rule
  local letter="$1" i
  for i in "${!IT_ID[@]}"; do
    IT_TICK[i]=0
    if [ "${IT_ST[i]}" = missing ] || [ "${IT_ST[i]}" = outdated ]; then
      case "${IT_PRE[i]}" in *"$letter"*) IT_TICK[i]=1 ;; *) IsMandatory "${IT_ID[i]}" && IT_TICK[i]=1 ;; esac
    fi
  done
}

TickDeps() {     # ticking a row pulls in its dependencies that are not installed (the Setup.cs rule)
  local row="$1" d j
  [ "${IT_TICK[row]}" = 1 ] || return 0
  for d in ${IT_DEPS[row]//,/ }; do
    for j in "${!IT_ID[@]}"; do
      [ "${IT_ID[j]}" = "$d" ] || continue
      case "${IT_ST[j]}" in missing|outdated) IT_TICK[j]=1 ;; esac
    done
  done
}

CheckedSum() { printf '%s %s' "$(CheckedCount)" "$(CheckedBytesSum)"; }
CheckedCount() { local i n=0; for i in "${!IT_ID[@]}"; do [ "${IT_TICK[i]}" = 1 ] && n=$((n+1)); done; printf '%s' "$n"; }
CheckedBytesSum() { local i s=0; for i in "${!IT_ID[@]}"; do [ "${IT_TICK[i]}" = 1 ] && s=$((s + ${IT_SIZE[i]:-0})); done; printf '%s' "$s"; }

ShowChecklist() {
  local i last='' verdict note mark
  say ''
  say '== What to install =='
  for i in "${!IT_ID[@]}"; do
    [ "${IT_GRP[i]}" = "$last" ] || { last="${IT_GRP[i]}"; say "  -- $last"; }
    case "${IT_ST[i]}" in
      installed) verdict="installed${IT_HAVE[i]:+ · ${IT_HAVE[i]}}" ;;
      outdated)  verdict="update: $(Human "${IT_SIZE[i]}")${IT_HAVE[i]:+ · ${IT_HAVE[i]}}" ;;
      missing)   verdict="download: $(Human "${IT_SIZE[i]}")${IT_NEED[i]:+ (${IT_NEED[i]})}" ;;
      *)         verdict="unavailable: ${IT_NOTE[i]}" ;;
    esac
    mark=' '; [ "${IT_TICK[i]}" = 1 ] && mark='x'
    note=''
    if { [ "${IT_ST[i]}" = missing ] || [ "${IT_ST[i]}" = outdated ]; } && [ -n "${IT_NOTE[i]}" ]; then note=" (${IT_NOTE[i]})"; fi
    say "   $(printf '%2d' "$((i+1))")) [$mark] ${IT_NAME[i]}$(IsMandatory "${IT_ID[i]}" && printf ' (required)') [${IT_ID[i]}] - $verdict$note"
  done
}

SumFooter() {   # the footer of the checklist: download vs free disk (the UpdateSum of Setup.cs)
  local n="$1" cs="$2" free="${S_FREE:-}"; free="${free:-$(FreeOn "$ROOT")}"; free="${free:-0}"
  if [ "$n" = 0 ]; then say "  Nothing ticked: everything needed is installed. Free on $ROOT: $(Gb "$free")."
  else say "  Download: $(Gb "$cs") ($n items). Free on $ROOT: $(Gb "$free")."; fi
}

BeginInstallPlan() {   # the ticked rows -> $plan; 1 = the user refused a confirmation (back to the checklist)
  local i o n cs free needx id gpuOnly=''
  SEL_WHAT=(); SEL_LIC=(); SEL_SIZE=()
  for i in "${!IT_ID[@]}"; do
    [ "${IT_TICK[i]}" = 1 ] || continue
    if [ -z "$gpuOnly" ] && [ "$S_NOGPU" = 1 ]; then
      case "${IT_NOTE[i]}" in *NVIDIA*) gpuOnly=yes ;; *) case "${IT_GRP[i]}" in 3D*) gpuOnly=yes ;; esac ;; esac
    fi
    for o in ${IT_ONLY[i]//,/ }; do
      [ -n "${SEL_WHAT[$o]:-}" ] || { SEL_WHAT[$o]="${IT_NAME[i]}"; SEL_LIC[$o]="${IT_LIC[i]}"; SEL_SIZE[$o]="${IT_SIZE[i]}"; }
      [ "$o" != llm ] || WantLlmSet="${IT_NEED[i]}"
    done
  done
  if [ "$S_NOGPU" = 1 ] && [ -n "$gpuOnly" ]; then
    say ''
    say '  No NVIDIA graphics card found: the ticked shape and image models will be downloaded but will not work without it.'
    if [ "$Yes" = 1 ]; then say '  Autonomous mode: installing anyway.'
    else Ask 'Install anyway?' n || return 1; fi
  fi
  n="$(CheckedCount)"; cs="$(CheckedBytesSum)"
  free="${S_FREE:-$(FreeOn "$ROOT")}"; free="${free:-0}"
  needx="$(awk -v c="$cs" 'BEGIN{printf "%d", c + c/10}')"
  if [ "$n" != 0 ] && [ "$(awk -v f="$free" -v d="$needx" 'BEGIN{print (f<d)?1:0}')" = 1 ]; then
    say ''
    say "  $ROOT has $(Gb "$free") free, the ticked items need about $(Gb "$needx")."
    if [ "$Yes" = 1 ]; then say '  Autonomous mode: installing anyway (interrupted downloads resume on the next run).'
    else Ask 'Continue anyway?' n || return 1; fi
  fi
  plan=()
  for id in $ORDER_IDS; do
    [ -n "${SEL_WHAT[$id]:-}" ] && plan_add "$id" "${SEL_WHAT[$id]}" "${SEL_SIZE[$id]}" "${SEL_LIC[$id]}"
  done
  return 0
}

ChecklistFlow() {   # the interactive checklist; returns with a confirmed plan
  local letter ans i idx
  case "$Profile" in full) letter=f ;; lite) letter=l ;; *) letter=q ;; esac
  ApplyPreset "$letter"
  while :; do
    ShowChecklist
    SumFooter "$(CheckedCount)" "$(CheckedBytesSum)"
    if [ "$Yes" = 1 ]; then BeginInstallPlan && return 0; continue; fi
    printf '  Number - tick or untick, q/f/l - presets, a - all, r - only required, done - install: '
    # stdin closed mid-flow: the answers would only repeat defaults - close the checklist instead of looping
    read -r ans || { say ''; say '  The input ended - the installation is cancelled.'; exit 1; }
    case "${ans,,}" in
      done|'') BeginInstallPlan || continue; return 0 ;;
      q|f|l) ApplyPreset "${ans,,}" ;;
      a) for i in "${!IT_ID[@]}"; do [ "${IT_ST[i]}" != unavailable ] && IT_TICK[i]=1; done ;;
      r) ApplyPreset '-' ;;
      [0-9]*) idx=$((ans-1))
        if [ "$idx" -lt 0 ] || [ "$idx" -ge "${#IT_ID[@]}" ]; then say '  No such row.'; continue; fi
        if [ "${IT_ST[idx]}" = unavailable ]; then say "  Cannot tick: ${IT_NOTE[idx]}"; continue; fi
        if [ "${IT_TICK[idx]}" = 1 ]; then
          if IsMandatory "${IT_ID[idx]}"; then say '  A required component cannot be unticked: Node.js, the studio interface and Blender.'; continue; fi
          IT_TICK[idx]=0
        else
          IT_TICK[idx]=1; TickDeps "$idx"
        fi ;;
      *) say '  Enter a number, q, f, l, a, r or done.' ;;
    esac
  done
}

OnlyPlan() {   # -Only <ids>: exactly these components, unattended (none = nothing ticked)
  local ids=" ${Only//,/ } " id
  for id in ${ids//,/ }; do
    case " $ORDER_IDS pixal3dtest gguf " in *" $id "*) ;; *) say "Unknown component id: $id"; exit 1 ;; esac
  done
  plan=()
  for id in $ORDER_IDS pixal3dtest gguf; do
    case "$ids" in *" $id "*) plan_add "$id" "$(comp_what "$id")" 0 '' ;; esac
  done
  [ "$Profile" = lite ] && Lite=1
}

PresetPlan() {   # the failed-check fallback: install the chosen preset as a whole (the Setup.cs rule)
  local ids='' n id
  n="$(NodeBin)"
  if [ -n "$n" ]; then ids="$("$n" -e 'try{const m=require(process.argv[1]);process.stdout.write(m.profiles[process.argv[2]].join(" "))}catch(e){}' "$ROOT/installer/manifest.json" "$Profile" 2>/dev/null)"; fi
  [ -n "$ids" ] || case "$Profile" in   # without node the manifest is unreadable: the 0.5.0 lists mirrored
    lite) ids='node npm blender godot clips vfx' ;;
    full) ids='node npm blender comfy hy2 u2net hymv hy21 sdxl mvadapter godot clips vfx ollama llm vlm pixal3d pixal3dw flux2 qwenimg' ;;  # «новое, проба» (ticket 12): the triposg* experimental ids are never in a preset
    *)    ids='node npm blender comfy hy2 u2net hymv sdxl mvadapter godot clips' ;;
  esac
  plan=()
  for id in $ORDER_IDS; do
    case " $ids " in *" $id "*) plan_add "$id" "$(comp_what "$id")" 0 '' ;; esac
  done
  Lite=$( [ "$Profile" = lite ] && echo 1 || echo "$Lite" )
}

# ---------------------------------------------------------------- start
# when sourced by tests/install-download.test.mjs, only the functions above are needed
# (run directly, $0 and BASH_SOURCE[0] are the same file; sourced, $0 is the caller's shell)
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

if [ "$ScanList" = 1 ]; then ScanList; exit $?; fi

# The installer reports the true version of the app it sets up (never its own literal), and the
# isolated check mode keeps this computer as it found it (behavior per ADR-0004, ticket 03): the
# Windows check mode also silences telemetry and the journal - this branch has neither, so
# isolation here means the shared user model library and leftover processes.
say "AstraForge installer $InstallerVersion (Linux)"
if [ "${ASTRA_INSTALL_ISOLATED:-}" = 1 ]; then
  export OLLAMA_MODELS="${OLLAMA_MODELS:-$RT/models/ollama}"
  trap '[ "${ASTRA_SERVE_OWNED:-}" = 1 ] && kill "${ASTRA_SERVE_PID:-}" 2>/dev/null || true' EXIT
  say '  isolated check mode: pulled models go to runtime/models/ollama, a serve this run starts is stopped on exit, shared user folders stay untouched'
fi

if [ "$ScanOnly" = 1 ]; then ScanTable; exit $?; fi
ScanCore
RecommendLlm

if [ -z "$Only" ] && [ "$SCAN_OK" = 1 ] && [ "$S_NOGPU" = 1 ] && [ "$Profile" != lite ]; then
  # the 0.4.7 Lite setup: no NVIDIA card means the shape and image models will not run
  say ''
  say '  NVIDIA graphics card not found: the shape and image models will be downloaded but will not work without it.'
  if [ "$Yes" = 1 ]; then
    say "  Profile $Profile selected: installing it as it is."
  elif Ask 'Install the Lite set instead (about 3 GB: Blender, rig, animations, sprites, VFX, Godot; no 3D-from-image and no image generation)?' y; then
    Profile=lite; Lite=1
  fi
fi

if [ -n "$Only" ]; then
  if [ "$Only" = none ]; then
    say 'Nothing ticked: everything needed is installed. (-Only none)'
    if [ "$DryRun" != 1 ] && [ -n "${S_LIBRARY:-}" ] && [ -z "$(CfgGet library)" ]; then CfgSet library "$S_LIBRARY"; fi
    exit 0
  fi
  OnlyPlan
elif [ "$SCAN_OK" = 1 ]; then
  ParseItems
  ChecklistFlow
else
  PresetPlan
fi

Title 'Total'
dl=0
for e in "${plan[@]:-}"; do [ -n "$e" ] || continue; s="$(printf '%s' "$e" | cut -d'|' -f3)"; dl=$((dl+s)); done
say "  components: ${#plan[@]}, download about $(Human "$dl")"
free="$(FreeOn "$ROOT")"
if [ "${#plan[@]}" != 0 ]; then
  say "  disk: about $(Human "$dl") needed, $(Gb "${free:-0}") free"
  if [ "$SCAN_OK" != 1 ] && [ "$(awk -v d="$dl" -v f="${free:-0}" 'BEGIN{print (d>f)?1:0}')" = 1 ]; then say '  Not enough disk space - free some space and run again.'; exit 1; fi
fi
lics="$(for e in "${plan[@]:-}"; do [ -n "$e" ] && printf '%s\n' "$(printf '%s' "$e" | cut -d'|' -f4)"; done | grep -v '^$' | sort -u | awk '{printf "%s%s", (NR>1?"; ":""), $0}')"
[ -n "$lics" ] && say "  licenses: $lics"
if printf '%s\n' "${plan[@]:-}" | grep -q '^hy'; then
  say '  The Hunyuan3D models are distributed under the Tencent Hunyuan Community License: use is prohibited in the territory of'
  say '  the European Union, the United Kingdom and South Korea. Text: https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE'
fi
if [ "${#plan[@]}" = 0 ]; then
  if [ -z "$(CfgGet library)" ] && [ -n "${S_LIBRARY:-}" ]; then CfgSet library "$S_LIBRARY"; fi
  if [ "$DryRun" != 1 ] && { [ "$Yes" = 1 ] || [ "$Lite" = 1 ] || [ -z "$(CfgGet profile)" ]; }; then CfgSet profile "$Profile"; fi
  [ "${ASTRA_UNATTENDED:-}" = 1 ] && printf '##DONE\n'
  say 'Done - launch with scripts/start.sh.'
  exit 0
fi
if [ "$DryRun" != 1 ] && { [ "$Yes" = 1 ] || [ "$Lite" = 1 ] || [ -z "$(CfgGet profile)" ]; }; then CfgSet profile "$Profile"; fi

failed_ids=''
dl_join_failed() { printf '%s' "$failed_ids" | tr -s ' ' '\n' | sed '/^$/d' | paste -sd, -; }
for e in "${plan[@]}"; do
  id="$(printf '%s' "$e" | cut -d'|' -f1)"; what="$(printf '%s' "$e" | cut -d'|' -f2)"
  Title "$what"
  if [ "$DryRun" = 1 ]; then say '  dry run - skipped'; continue; fi
  err=''
  case "$id" in
    node) InstallNode || err=$? ;;
    npm) InstallNpm || err=$? ;;
    blender) InstallBlender || err=$? ;;
    comfy) InstallComfy || err=$? ;;
    comfydeps) InstallComfyDeps "$S_COMFY" || err=$? ;;
    hy2) Model 'https://huggingface.co/tencent/Hunyuan3D-2/resolve/main/hunyuan3d-dit-v2-0/model.fp16.safetensors' 'hunyuan3d-dit-v2.safetensors' || err=$? ;;
    hymv) Model 'https://huggingface.co/tencent/Hunyuan3D-2mv/resolve/main/hunyuan3d-dit-v2-mv/model.fp16.safetensors' 'hunyuan3d-dit-v2-mv.safetensors' || err=$? ;;
    hy21) Model 'https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged/resolve/main/hunyuan_3d_v2.1.safetensors' 'hunyuan_3d_v2.1.safetensors' || err=$? ;;
    sdxl) Model 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors' 'sd_xl_base_1.0.safetensors' || err=$? ;;
    u2net) Download 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx' "$ROOT/data/models/background/models/u2net/u2net.onnx" || err=$? ;;
    godot) InstallGodot || err=$? ;;
    clips)
      if [ -z "$S_BLENDER" ]; then say '  Blender is required - install it in the same run.'; err=1
      else CfgSet library "$S_LIBRARY"; InstallClips || err=$?; fi ;;
    ollama) InstallOllama || err=$? ;;
    llm) PullLlm "${WantLlmSet:-$WantLlm}" || err=$? ;;
    vlm) PullModel "$VlmName" || err=$? ;;
    mvadapter) InstallMvadapter || err=$? ;;
    vfx) InstallVfx || err=$? ;;
    pixal3d) { Pixal3dComponent engine && Pixal3dComponent test; } || err=$? ;;
    pixal3dw) Pixal3dComponent weights || err=$? ;;
    pixal3dtest) Pixal3dComponent test || err=$? ;;
    triposg) { TriposgComponent env && TriposgComponent code && TriposgComponent tf; } || err=$? ;;
    triposgvae) TriposgComponent vae || err=$? ;;
    triposgdino) TriposgComponent dino || err=$? ;;
    sound) { SoundComponent code && SoundComponent env; } || err=$? ;;
    soundmoss) SoundWeights "$(SoundDir)" moss || err=$? ;;
    soundace) SoundWeights "$(SoundDir)" ace || err=$? ;;
    gguf) InstallGgufNode || err=$? ;;
    flux2) InstallFlux2 || err=$? ;;
    qwenimg) InstallQwen || err=$? ;;    qwenedit) InstallQwenEdit || err=$? ;;
    *) say "  not implemented yet: $id"; err=1 ;;
  esac
  if [ -z "$err" ]; then
    say '  done'
  else
    say "  ERROR: $id failed (reinstall it with: installer/install.sh -Only $id)"
    failed_ids="$failed_ids $id"
    if [ "$Yes" != 1 ]; then Ask 'Continue with the remaining components?' y || exit 1; fi
  fi
done
if [ "$DryRun" = 1 ]; then
  if [ "${ASTRA_UNATTENDED:-}" = 1 ]; then [ -n "$failed_ids" ] && printf '##FAILED %s\n' "$(dl_join_failed)" && exit 1; printf '##DONE\n'; fi
  exit 0
fi
# the machine contract for the calling frontend (server/components.mjs): what failed and where it ended
if [ "${ASTRA_UNATTENDED:-}" = 1 ]; then
  if [ -n "$failed_ids" ]; then printf '##FAILED %s\n' "$(dl_join_failed)"; exit 1; fi
  printf '##DONE\n'
fi

if [ -z "$(CfgGet library)" ]; then CfgSet library "$S_LIBRARY"; fi
if [ -z "$(CfgGet forgeRuntime)" ] && [ -z "${ASTRA_FORGE_RUNTIME:-}" ]; then CfgSet forgeRuntime "$ROOT/data/runtime/forge"; fi
if [ -n "$S_COMFY" ] && [ -z "$(CfgGet comfyDir)" ]; then CfgSet comfyDir "$S_COMFY"; fi
if [ -n "$S_BLENDER" ] && [ -z "$(CfgGet blender)" ]; then CfgSet blender "$S_BLENDER"; fi
if [ -n "$S_GODOT" ] && [ -z "$(CfgGet godot)" ]; then CfgSet godot "$S_GODOT"; fi
if [ -n "$S_NODE" ] && [ -z "$(CfgGet node)" ]; then CfgSet node "$S_NODE"; fi
Title 'Post-install check'
ScanCore && ScanTable
if [ "${S_P3:-}" = yes ] && [ -z "$(CfgGet pixal3dDir)" ]; then CfgSet pixal3dDir "$S_P3_DIR"; fi
say 'Done - launch with scripts/start.sh.'
