#!/usr/bin/env bash
# AstraForge installer for Linux (the counterpart of installer/Install.ps1).
#
#   installer/install.sh                 scan, ask about optional components, install
#   installer/install.sh -ScanOnly       only inspect the computer, download nothing
#   installer/install.sh -DryRun         walk through the wizard without downloading
#   installer/install.sh -Only hy2,u2net install only these components (list them in install order)
#   installer/install.sh -Yes            no questions: required components and the wizard's defaults
#
# Everything installs into this application folder (runtime/, data/models/), needs no root, and an
# interrupted download resumes on the next run. Ids: node, npm, blender, comfy, comfydeps, hy2,
# hymv, hy21, sdxl, u2net, godot, clips, ollama, llm, vlm, mvadapter, pixal3d, pixal3dw,
# pixal3dtest, vfx.  Log: installer/install.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$ROOT/runtime"
DL="$ROOT/installer/downloads"
LOG="$ROOT/installer/install.log"
CFGF="$ROOT/config/paths.json"

NodeVersion='v22.23.3'
ComfyTag='v0.33.2'
BlenderTar='https://download.blender.org/release/Blender5.0/blender-5.0.1-linux-x64.tar.xz'
GodotZip='https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_linux.x86_64.zip'
GodotBin='Godot_v4.5.1-stable_linux.x86_64'
UvTar='https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz'
VlmName='qwen3-vl:8b'
VlmBytes=6100000000

# ---------------------------------------------------------------- arguments
ScanOnly=0 DryRun=0 Yes=0 Only=''
prev=''
for arg in "$@"; do
  case "$arg" in
    -ScanOnly|--scan-only) ScanOnly=1 ;;
    -DryRun|--dry-run) DryRun=1 ;;
    -Yes|--yes) Yes=1 ;;
    -Only=*|--only=*) Only="${arg#*=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) [ "$prev" = '-Only' ] || [ "$prev" = '--only' ] && { Only="$arg"; } ;;
  esac
  prev="$arg"
done

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

Download() { # <url> <dst>
  mkdir -p "$(dirname "$2")"
  if [ -f "$2" ]; then say "    already downloaded: $(basename "$2")"; return 0; fi
  say "    downloading $1"
  local resume=()
  [ -f "$2.part" ] && resume=(-C -)   # resume only with an existing partial: some GitHub archives refuse byte ranges
  if ! curl -L --fail --retry 5 --retry-delay 3 "${resume[@]}" --progress-bar -o "$2.part" "$1"; then
    say "  Download failed: $1 (run the installer again - the download will resume)."
    return 1
  fi
  mv -f "$2.part" "$2"
}

FileOk() { # <path> [size] [sha256]
  [ -f "$1" ] || return 1
  local len; len="$(stat -c%s "$1" 2>/dev/null || echo 0)"
  if [ "${2:-0}" != 0 ] && [ "$len" != "$2" ]; then return 1; fi
  if [ "$len" = 0 ]; then return 1; fi
  if [ -n "${3:-}" ]; then
    local h; h="$(sha256sum "$1" | cut -d' ' -f1)"
    [ "$h" = "$3" ] || return 1
  fi
  return 0
}

DownloadChecked() { # <url> <dst> [size] [sha256]
  local leaf; leaf="$(basename "$2")"
  if FileOk "$2" "${3:-0}"; then
    if [ -z "${4:-}" ]; then say "    already in place: $leaf"; return 0; fi
    say "    checking checksum: $leaf"
    if FileOk "$2" "${3:-0}" "$4"; then say '    matches, no download needed'; return 0; fi
    say "    file $leaf does not match the checksum - downloading again"
  fi
  rm -f "$2"
  Download "$1" "$2" || return 1
  [ -n "${4:-}" ] && say "    checking checksum: $leaf"
  if ! FileOk "$2" "${3:-0}" "${4:-}"; then
    rm -f "$2"
    say "File $leaf was downloaded incorrectly (size or sha256 mismatch). The file was deleted - run the installer again."
    return 1
  fi
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

# ---------------------------------------------------------------- scan
Scan() {
  S_GPU=''; S_VRAM=0; S_CC=''
  if command -v nvidia-smi >/dev/null; then
    local line
    line="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)"
    if [ -n "$line" ]; then S_GPU="$(printf '%s' "$line" | cut -d, -f1 | sed 's/^ *//;s/ *$//')"; S_VRAM="$(printf '%s' "$line" | cut -d, -f2 | tr -d ' ')"; fi
    local cc; cc="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')"
    if printf '%s' "$cc" | grep -Eq '^[0-9]+\.[0-9]+$'; then S_CC="$cc"; fi
  fi
  # Node.js >= 22.12
  S_NODE=''; S_NODEVER=''
  local cands=() n v maj min
  n="$(CfgGet node)"; [ -n "$n" ] && cands+=("$n")
  cands+=("$RT/node/bin/node")
  n="$(command -v node || true)"; [ -n "$n" ] && cands+=("$n")
  for n in "${cands[@]}"; do
    [ -x "$n" ] || continue
    v="$("$n" -v 2>/dev/null | tr -d 'v')"; maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
    if [ "${maj:-0}" -gt 22 ] 2>/dev/null || { [ "${maj:-0}" = 22 ] && [ "${min:-0}" -ge 12 ] 2>/dev/null; }; then S_NODE="$n"; S_NODEVER="$v"; break; fi
  done
  if [ -d "$ROOT/node_modules/express" ]; then S_NPM=yes; else S_NPM=''; fi
  if [ -f "$ROOT/dist/index.html" ]; then S_UI=yes; else S_UI=''; fi
  # Blender 5.x: config, env, app-local, system
  S_BLENDER=''
  local bls=() b
  n="$(CfgGet blender)"; [ -n "$n" ] && bls+=("$n")
  [ -n "${ASTRA_BLENDER:-}" ] && bls+=("$ASTRA_BLENDER")
  bls+=("$RT/blender/blender-5.0.1-linux-x64/blender")
  n="$(command -v blender || true)"; [ -n "$n" ] && bls+=("$n")
  for b in "${bls[@]}"; do if [ -x "$b" ]; then S_BLENDER="$b"; break; fi; done
  # ComfyUI: the app's own copy (.venv + main.py + the Hunyuan3D nodes)
  S_COMFY=''
  local comfys=() c
  n="$(CfgGet comfyDir)"; [ -n "$n" ] && comfys+=("$n")
  [ -n "${ASTRA_COMFY_DIR:-}" ] && comfys+=("$ASTRA_COMFY_DIR")
  comfys+=("$RT/ComfyUI")
  for c in "${comfys[@]}"; do
    if [ -x "$c/.venv/bin/python" ] && [ -f "$c/main.py" ] && [ -f "$c/comfy_extras/nodes_hunyuan3d.py" ]; then S_COMFY="$c"; break; fi
  done
  S_COMFYDEPS=''
  if [ -n "$S_COMFY" ]; then
    if "$S_COMFY/.venv/bin/python" -c "import sys; sys.path.insert(0, '$ROOT/data/python'); import torch, rembg, skimage, numba, onnxruntime, xatlas" >/dev/null 2>&1; then S_COMFYDEPS=yes; fi
  fi
  # Godot 4.5
  S_GODOT=''
  local gds=()
  n="$(CfgGet godot)"; [ -n "$n" ] && gds+=("$n")
  [ -n "${ASTRA_GODOT:-}" ] && gds+=("$ASTRA_GODOT")
  gds+=("$RT/Godot/$GodotBin")
  n="$(command -v godot || true)"; [ -n "$n" ] && gds+=("$n")
  n="$(command -v godot4 || true)"; [ -n "$n" ] && gds+=("$n")
  for n in "${gds[@]}"; do if [ -x "$n" ]; then S_GODOT="$n"; break; fi; done
  # models - in the application folder or in an existing ComfyUI's checkpoints (the studio reads both)
  S_HY2=''; S_HYMV=''; S_HY21=''; S_SDXL=''
  local ckdirs=("$ROOT/data/models/checkpoints") d
  [ -n "$S_COMFY" ] && ckdirs+=("$S_COMFY/models/checkpoints")
  for d in "${ckdirs[@]}"; do
    [ -f "$d/hunyuan3d-dit-v2.safetensors" ] && S_HY2=yes
    [ -f "$d/hunyuan3d-dit-v2-mv.safetensors" ] && S_HYMV=yes
    [ -f "$d/hunyuan_3d_v2.1.safetensors" ] && S_HY21=yes
    [ -f "$d/sd_xl_base_1.0.safetensors" ] && S_SDXL=yes
  done
  S_U2NET=''
  if find "$ROOT/data/models/background" -name u2net.onnx -type f 2>/dev/null | grep -q .; then S_U2NET=yes; fi
  # Ollama and its models (the server may be stopped: the disk manifests count too)
  S_OLLAMA="$(command -v ollama || true)"
  n="$(CfgGet ollama)"; [ -n "$n" ] && [ -x "$n" ] && S_OLLAMA="$n"
  S_LLMS=()
  if [ -n "$S_OLLAMA" ]; then
    local m
    while read -r m; do [ -n "$m" ] && S_LLMS+=("$m"); done < <("$S_OLLAMA" list 2>/dev/null | tail -n +2 | awk '{print $1}')
    local mroot="${OLLAMA_MODELS:-$HOME/.ollama/models}/manifests/registry.ollama.ai" rel ns nm tg
    if [ -d "$mroot" ]; then
      while read -r f; do
        rel="${f#"$mroot"/}"; ns="$(dirname "$(dirname "$rel")")"; nm="$(basename "$(dirname "$rel")")"; tg="$(basename "$rel")"
        printf '%s' "$tg" | grep -Eq '^[0-9a-f]{64}$' && continue
        if [ "$ns" = library ]; then m="$nm:$tg"; else m="$ns/$nm:$tg"; fi
        local seen=''
        for v in "${S_LLMS[@]:-}"; do [ "$v" = "$m" ] && seen=yes; done
        [ -z "$seen" ] && S_LLMS+=("$m")
      done < <(find "$mroot" -mindepth 3 -maxdepth 3 -type f)
    fi
  fi
  S_VLM=''
  for m in "${S_LLMS[@]:-}"; do [ "$m" = "$VlmName" ] && S_VLM=yes; done
  # clip library (Quaternius / ActionForge animations, CC0)
  S_LIBRARY="$(CfgGet library)"; [ -z "$S_LIBRARY" ] && S_LIBRARY="${ASTRA_FORGE_LIBRARY:-}"
  [ -z "$S_LIBRARY" ] && S_LIBRARY="$ROOT/library"
  S_CLIPS="$(find "$S_LIBRARY/animations/quaternius" -name '*.fbx' 2>/dev/null | wc -l | tr -d ' ')"
  # Pixal3D (a separate portable ComfyUI on 8191): state report; the Linux recipe lands with its phase
  S_P3_DIR="$(CfgGet pixal3dDir)"; [ -z "$S_P3_DIR" ] && S_P3_DIR="${ASTRA_PIXAL3D_DIR:-}"
  [ -z "$S_P3_DIR" ] && S_P3_DIR="$RT/ComfyUI-Pixal3D"
  S_P3_ENGINE=''; if [ -x "$S_P3_DIR/.venv/bin/python" ] && [ -f "$S_P3_DIR/ComfyUI/main.py" ]; then S_P3_ENGINE=yes; fi
  # weights and nodes: the same requirements list the studio server checks (server/pixal3d.mjs), minus the python entry
  S_P3_WEIGHTS=''; S_P3_MISSING=''
  if [ -n "$S_P3_ENGINE" ]; then
    n2="$(NodeBin)"
    if [ -n "$n2" ]; then
      S_P3_MISSING="$("$n2" --input-type=module -e "
        import { existsSync } from 'node:fs'; import path from 'node:path';
        const { PIXAL3D_REQUIREMENTS, PIXAL3D_PYTHON_REL } = await import('file://$ROOT/server/pixal3d.mjs');
        const need = PIXAL3D_REQUIREMENTS.map(([r]) => r).filter(r => r !== PIXAL3D_PYTHON_REL && r !== 'ComfyUI/main.py');
        process.stdout.write(need.filter(r => !existsSync(path.join(process.argv[1], r))).join('; '))
        " "$S_P3_DIR" 2>/dev/null || echo unknown)"
      [ "$S_P3_MISSING" = '' ] && S_P3_WEIGHTS=yes
    fi
  fi
  # MV-Adapter: node (bundled in data/runtime/custom_nodes, already patched) + weights + SDXL config
  S_MV_NODE=''; grep -q local_sdxl_config "$ROOT/data/runtime/custom_nodes/ComfyUI-MVAdapter/utils.py" 2>/dev/null && S_MV_NODE=yes
  S_MV_WEIGHTS=''; [ -f "$ROOT/data/models/mvadapter/mvadapter_i2mv_sdxl.safetensors" ] && S_MV_WEIGHTS=yes
  S_MV_CONFIG=''; [ -f "$ROOT/data/models/mvadapter/sdxl-config/model_index.json" ] && S_MV_CONFIG=yes
}

Show() {
  Title 'What is already on this computer'
  if [ -n "$S_GPU" ]; then Ok "GPU: $S_GPU ($(awk -v v="$S_VRAM" 'BEGIN{printf "%d GB", v/1024+0.5}'))"; else Miss 'NVIDIA GPU not found - 3D generation from an image will be unavailable (the interface and Blender still work)'; fi
  if [ -n "$S_NODE" ]; then Ok "Node.js $S_NODEVER"; else Miss 'Node.js 22.12+'; fi
  if [ -n "$S_NPM" ] && [ -n "$S_UI" ]; then Ok 'Application dependencies and interface'; else Miss 'Dependencies / interface build (npm)'; fi
  if [ -n "$S_BLENDER" ]; then Ok "Blender 5: $S_BLENDER"; else Miss 'Blender 5.0'; fi
  if [ -n "$S_COMFY" ]; then
    if [ -n "$S_COMFYDEPS" ]; then Ok "ComfyUI: $S_COMFY"; else Miss "ComfyUI is present ($S_COMFY), but Python libraries are missing"; fi
  else Miss 'ComfyUI (3D generation)'; fi
  if [ -n "$S_HY2" ]; then Ok 'Hunyuan3D-2 model'; else Miss 'Hunyuan3D-2 model (required, 4.9 GB)'; fi
  if [ -n "$S_U2NET" ]; then Ok 'u2net background-removal model'; else Miss 'u2net background-removal model (176 MB)'; fi
  if [ -n "$S_HYMV" ]; then Ok 'Hunyuan3D-2mv model (from two views)'; else Opt 'Hunyuan3D-2mv model (from two views, 4.9 GB)'; fi
  if [ -n "$S_HY21" ]; then Ok 'Hunyuan3D-2.1 model'; else Opt 'Hunyuan3D-2.1 model (7.4 GB)'; fi
  if [ -n "$S_SDXL" ]; then Ok 'SDXL (images)'; else Opt 'SDXL for image generation (6.9 GB)'; fi
  if [ -n "$S_GODOT" ]; then Ok "Godot 4.5: $S_GODOT"; else Opt 'Godot 4.5 (validation of game packages, 77 MB)'; fi
  if [ -n "$S_OLLAMA" ]; then Ok "Ollama, models: $(if [ "${#S_LLMS[@]}" -gt 0 ]; then printf '%s' "${S_LLMS[*]}"; else echo none; fi)"; else Opt 'Ollama - local AI assistant (optional)'; fi
  if [ "${S_CLIPS:-0}" -gt 0 ] 2>/dev/null; then Ok "Quaternius animations: $S_CLIPS clips"; else Opt 'Quaternius / ActionForge animations, 86 clips (CC0)'; fi
  if [ -n "$S_MV_NODE" ] && [ -n "$S_MV_WEIGHTS" ] && [ -n "$S_MV_CONFIG" ]; then Ok 'MV-Adapter: views locally (node, weights, SDXL configs)'
  elif [ -n "$S_MV_NODE$S_MV_WEIGHTS$S_MV_CONFIG" ]; then Miss 'MV-Adapter is not fully installed'
  else Opt 'MV-Adapter - views from a single image, locally (3.6 GB of weights; needs SDXL)'; fi
  if [ -n "$S_VLM" ]; then Ok "Check model $VlmName (textures and animation)"; else Opt "Check model $VlmName via Ollama ($(Gb "$VlmBytes"), textures and animation)"; fi
  if [ -n "$S_P3_ENGINE" ]; then
    if [ -n "$S_P3_WEIGHTS" ]; then Ok "Pixal3D (3D from 1-4 views, shape only): $S_P3_DIR"
    else Miss "Pixal3D is not fully installed ($S_P3_DIR), missing: weights"; fi
  else Opt 'Pixal3D - 3D from 1-4 views, shape only (ComfyUI on port 8191), about 48.5 GB on disk'; fi
}

RecommendLlm() {
  if [ "${S_VRAM:-0}" -ge 16000 ] 2>/dev/null; then WantLlm='qwen3:14b'; LlmBytes=9300000000
  elif [ "${S_VRAM:-0}" -ge 8000 ] 2>/dev/null; then WantLlm='qwen3:8b'; LlmBytes=5200000000
  else WantLlm='qwen3:4b'; LlmBytes=2500000000; fi
}

# ---------------------------------------------------------------- installing components
InstallNode() {
  local arch tarname url
  arch="$(uname -m)"; case "$arch" in x86_64) arch='x64' ;; aarch64) arch='arm64' ;; esac
  tarname="node-$NodeVersion-linux-$arch.tar.xz"; url="https://nodejs.org/dist/$NodeVersion/$tarname"
  Download "$url" "$DL/$tarname" || return 1
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
  local t='blender-5.0.1-linux-x64.tar.xz'
  Download "$BlenderTar" "$DL/$t" || return 1
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
    Run "$UV_BIN" 'PyTorch' pip install --python "$py" torch torchvision torchaudio --index-url "$torchIndex" || return 1
  fi
  Run "$UV_BIN" 'ComfyUI libraries' pip install --python "$py" -r "$dir/requirements.txt" || return 1
  Run "$UV_BIN" 'AstraForge libraries (background removal, meshing, unwrapping)' pip install --python "$py" rembg onnxruntime numba scikit-image xatlas || return 1
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
EnsureOllama() {
  local started=''
  for _ in $(seq 30); do
    curl -sf -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && return 0
    if [ "$started" != 1 ]; then "$S_OLLAMA" serve >/dev/null 2>&1 & disown; started=1; fi
    sleep 2
  done
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
  Run "$S_BLENDER" 'importing clips into the AstraForge library' -b --factory-startup --python "$ROOT/scripts/blender/af_run.py" -- clip_library "$fbx/_import/request.json"
}
InstallOllama() {
  local got; got="$(command -v ollama || true)"
  if [ -n "$got" ]; then S_OLLAMA="$got"; CfgSet ollama "$got"; return 0; fi
  say '  Ollama is not installed: install it from https://ollama.com (Linux: curl -fsSL https://ollama.com/install.sh | sh) and run the installer again.'
  return 1
}

# Pixal3D for Linux: installer/pixal3d/install-pixal3d.sh (engine|weights|test), same manifest pins
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
plan_get() { local e; for e in "${plan[@]:-}"; do if [ "${e%%|*}" = "$1" ]; then printf '%s' "$e"; return 0; fi; done; return 1; }

Scan
if [ "$ScanOnly" = 1 ]; then Show; exit 0; fi
free="$(FreeOn "$ROOT")"

Title 'Required'
if [ -z "$S_NODE" ]; then plan_add node "Node.js $NodeVersion (into the application folder)" 32000000 'MIT'; fi
if [ -z "$S_NPM" ] || [ -z "$S_UI" ]; then plan_add npm 'dependencies and interface build' 250000000 'open-source licenses of npm packages'; fi
if [ -z "$S_BLENDER" ]; then plan_add blender 'Blender 5.0.1 (into the application folder)' 401000000 'GPL'; fi
if [ -z "$S_COMFY" ]; then plan_add comfy "ComfyUI $ComfyTag + Python 3.12 + PyTorch" 6000000000 'GPL / BSD'
elif [ -z "$S_COMFYDEPS" ]; then plan_add comfydeps 'missing Python libraries for ComfyUI' 1000000000 'open-source licenses'; fi
if [ -z "$S_HY2" ]; then plan_add hy2 'Hunyuan3D-2 model (3D from an image)' 4928151562 'Tencent Hunyuan Community License'; fi
if [ -z "$S_U2NET" ]; then plan_add u2net 'u2net background-removal model' 175997641 'Apache-2.0'; fi
for e in "${plan[@]:-}"; do [ -n "$e" ] && say "  • $(printf '%s' "$e" | cut -d'|' -f2)  — $(Human "$(printf '%s' "$e" | cut -d'|' -f3)")"; done
if [ "${#plan[@]}" = 0 ]; then say '  everything required is already installed'; fi
mandatory="${#plan[@]}"

Title 'Optional'
if [ -z "$S_HYMV" ]; then Ask 'Hunyuan3D-2mv model - 3D from a front and a back view, 4.9 GB. Download?' y && plan_add hymv 'Hunyuan3D-2mv model' 4928151562 'Tencent Hunyuan Community License'; fi
if [ -z "$S_HY21" ]; then Ask 'Hunyuan3D-2.1 model - a second shape model, 7.4 GB. Download?' n && plan_add hy21 'Hunyuan3D-2.1 model' 7365943290 'Tencent Hunyuan Community License'; fi
if [ -z "$S_SDXL" ]; then Ask 'SDXL - generate concept images right in the application, 6.9 GB. Download?' n && plan_add sdxl 'SDXL model' 6938078334 'CreativeML Open RAIL++-M'; fi
if [ -z "$S_GODOT" ]; then Ask 'Godot 4.5.1 - validation of finished game packages, 77 MB. Download?' y && plan_add godot 'Godot 4.5.1' 76685794 'MIT'; fi
if [ "${S_CLIPS:-0}" = 0 ] 2>/dev/null; then Ask 'Quaternius animations (ActionForge): 86 clips - running, swords, shields, magic, 10 MB. Download?' y && plan_add clips 'Quaternius / ActionForge animations (CC0)' 10000000 'CC0'; fi
RecommendLlm
WantLlmSet=''
if ! printf '%s\n' "${S_LLMS[@]:-}" | grep -qxF "$WantLlm"; then
  say '  Local AI assistant (descriptions, prompts, task breakdown) - free, works offline.'
  say "  The best model for your GPU is $WantLlm ($(Gb "$LlmBytes")) via Ollama."
  if [ "${#S_LLMS[@]}" -gt 0 ]; then say "  You already have: ${S_LLMS[*]}"; fi
  if Ask "Install model $WantLlm?" "$(if [ "${#S_LLMS[@]}" -eq 0 ]; then echo y; else echo n; fi)"; then
    if [ -z "$S_OLLAMA" ]; then plan_add ollama 'Ollama' 1578217944 'MIT'; fi
    plan_add llm "model $WantLlm" "$LlmBytes" 'Apache 2.0 (Qwen3)'; WantLlmSet="$WantLlm"
  fi
fi
if [ -z "$S_VLM" ] && [ -n "$S_OLLAMA" ]; then
  say "  Local check model $VlmName (understands images): checks textures and animation, works offline."
  if [ "${S_VRAM:-0}" -gt 0 ] 2>/dev/null && [ "${S_VRAM:-0}" -lt 8000 ] 2>/dev/null; then say '  Warning: less than 8 GB of video memory, the model will run slowly.'; fi
  if Ask "Install model $VlmName ($(Gb "$VlmBytes"))?" "$(if [ "${S_VRAM:-0}" -ge 8000 ] 2>/dev/null; then echo y; else echo n; fi)"; then plan_add vlm "model $VlmName (texture and animation check)" "$VlmBytes" 'Apache 2.0 (Qwen3-VL)'; fi
fi

if [ -n "$Only" ]; then
  newplan=()
  IFS=',' read -r -a ids <<<"$Only"
  for id in "${ids[@]}"; do
    case " node npm blender comfy comfydeps hy2 hymv hy21 sdxl u2net godot clips ollama llm vlm mvadapter pixal3d pixal3dw pixal3dtest vfx " in
      *" $id "*) ;; *) say "Unknown component id: $id"; exit 1 ;;
    esac
    hit="$(plan_get "$id" || true)"
    if [ -n "$hit" ]; then newplan+=("$hit"); else plan_add "$id" "$id" 0 ''; newplan+=("$(plan_get "$id")"); fi
    [ "$id" = llm ] && [ -z "$WantLlmSet" ] && WantLlmSet="$WantLlm"
  done
  plan=("${newplan[@]}")
fi

if [ "${#plan[@]}" -gt "$mandatory" ] && [ -z "$Only" ]; then
  Title 'Selected optional components'
  i=0
  for e in "${plan[@]}"; do
    if [ "$i" -ge "$mandatory" ]; then say "  • $(printf '%s' "$e" | cut -d'|' -f2)  — $(Human "$(printf '%s' "$e" | cut -d'|' -f3)")  [$(printf '%s' "$e" | cut -d'|' -f4)]"; fi
    i=$((i+1))
  done
fi

Title 'Total'
dl=0
for e in "${plan[@]:-}"; do [ -n "$e" ] || continue; s="$(printf '%s' "$e" | cut -d'|' -f3)"; dl=$((dl+s)); done
say "  components: ${#plan[@]}, download about $(Gb "$dl")"
say "  disk: about $(Gb "$dl") needed, $(Gb "${free:-0}") free"
if [ "$(awk -v d="$dl" -v f="${free:-0}" 'BEGIN{print (d>f)?1:0}')" = 1 ]; then say '  Not enough disk space - free some space and run again.'; exit 1; fi
lics="$(for e in "${plan[@]:-}"; do [ -n "$e" ] && printf '%s\n' "$(printf '%s' "$e" | cut -d'|' -f4)"; done | grep -v '^$' | sort -u | awk '{printf "%s%s", (NR>1?"; ":""), $0}')"
[ -n "$lics" ] && say "  licenses: $lics"
if printf '%s\n' "${plan[@]:-}" | grep -q '^hy'; then
  say '  The Hunyuan3D models are distributed under the Tencent Hunyuan Community License: use is prohibited in the territory of'
  say '  the European Union, the United Kingdom and South Korea. Text: https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE'
fi
if [ "${#plan[@]}" = 0 ]; then
  if [ -z "$(CfgGet library)" ]; then CfgSet library "$S_LIBRARY"; fi
  say 'Done - launch with scripts/start.sh.'
  exit 0
fi
if [ -z "$Only" ] && [ "$Yes" != 1 ]; then Ask 'Start the installation?' y || { say 'Cancelled.'; exit 0; } fi

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
    *) say "  not implemented yet: $id"; err=1 ;;
  esac
  if [ -z "$err" ]; then
    say '  done'
  else
    say "  ERROR: $id failed (reinstall it with: installer/install.sh -Only $id)"
    if [ "$Yes" != 1 ]; then Ask 'Continue with the remaining components?' y || exit 1; fi
  fi
done
if [ "$DryRun" = 1 ]; then exit 0; fi

if [ -z "$(CfgGet library)" ]; then CfgSet library "$S_LIBRARY"; fi
if [ -z "$(CfgGet forgeRuntime)" ] && [ -z "${ASTRA_FORGE_RUNTIME:-}" ]; then CfgSet forgeRuntime "$ROOT/data/runtime/forge"; fi
if [ -n "$S_COMFY" ] && [ -z "$(CfgGet comfyDir)" ]; then CfgSet comfyDir "$S_COMFY"; fi
if [ -n "$S_BLENDER" ] && [ -z "$(CfgGet blender)" ]; then CfgSet blender "$S_BLENDER"; fi
if [ -n "$S_GODOT" ] && [ -z "$(CfgGet godot)" ]; then CfgSet godot "$S_GODOT"; fi
if [ -n "$S_NODE" ] && [ -z "$(CfgGet node)" ]; then CfgSet node "$S_NODE"; fi
Title 'Post-install check'
Scan
Show
say 'Done - launch with scripts/start.sh.'
