#!/usr/bin/env bash
# Pixal3D (TRELLIS.2) as a separate portable ComfyUI on 127.0.0.1:8191 — the Linux counterpart of
# installer/pixal3d/pixal3d.ps1. Same manifest.json pins; the differences live in its "linux" section:
# a uv venv instead of python_embeded, wheels/Linux/Torch291 of the node archive instead of the Windows
# wheels, PyTorch 2.9.1+cu128 (the node ships Linux wheels for that pair), triton instead of
# triton-windows, official Linux wheels of FlashAttention and NATTEN.
#
#   installer/pixal3d/install-pixal3d.sh engine  <dir>   Python, ComfyUI, Trellis2 nodes, packages
#   installer/pixal3d/install-pixal3d.sh weights <dir>   Pixal3D/MoGe/NAF/DINOv3 weights (about 42 GB)
#   installer/pixal3d/install-pixal3d.sh test    <dir>   smoke: start the engine on 8191, check the nodes
#   installer/pixal3d/install-pixal3d.sh natten  <dir>   check-and-fix NATTEN kernels in BOTH Pixal3D environments (ticket 11)
#
# Uses helpers of the parent install.sh only through its own copies: no shared state, resumable.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$SRC/../.." && pwd)"
DL="$APP/installer/downloads"
LOG="$APP/installer/install.log"
MAN="$SRC/manifest.json"
PORT=8191

say() { printf '%s\n' "$1"; printf '%s\n' "$1" >>"$LOG"; }
Title() { say ''; say "== $1 =="; }
NodeBin() { local n; n="${ASTRA_NODE:-$(command -v node || true)}"; printf '%s' "$n"; }
Mv() { local n; n="$(NodeBin)"; "$n" -e 'const m=require(process.argv[1]);const g=process.argv[2].split(".").reduce((o,k)=>o&&o[k],m);console.log(typeof g==="string"?g:JSON.stringify(g??null))' "$MAN" "$1"; }

# the shared download core (reason table, resume/retry loop, checksums, mirrors, UvTry)
# shellcheck source=../af_download.sh
. "$APP/installer/af_download.sh"
Repo() { # <url> <name> <dest>  GitHub archive -> folder (top directory stripped)
  local zip="$DL/$2.zip" tmp
  Download "$1" "$zip" || return 1
  tmp="$(dirname "$3")/_unpack_$2"
  rm -rf "$tmp"; mkdir -p "$tmp"
  if ! unzip -q "$zip" -d "$tmp"; then rm -f "$zip"; say "  The archive $2 is corrupt - deleted, run again."; return 1; fi
  local top; top="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -n "$top" ] || { rm -rf "$tmp"; say "  The archive $2 is empty."; return 1; }
  rm -rf "$3"; mkdir -p "$(dirname "$3")"
  mv "$top" "$3"
  rm -rf "$tmp"
}
FreeOn() { df -B1 --output=avail "$1" 2>/dev/null | tail -1 | tr -d ' '; }

# ---------------------------------------------------------------- environment of the portable install (as the bat file)
P3EnvPush() { # <dir>
  local dir="$1"
  unset CUDA_PATH CUDA_HOME CUDA_BIN_PATH CUDNN_PATH PYTHONPATH PYTHONHOME VIRTUAL_ENV CONDA_PREFIX 2>/dev/null || true
  mkdir -p "$dir/cache/tmp" "$dir/cache/huggingface" "$dir/cache/torch"
  export HF_HOME="$dir/cache/huggingface" TORCH_HOME="$dir/cache/torch" PYTHONUTF8=1 TMPDIR="$dir/cache/tmp"
  export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_SYMLINKS_WARNING=1
}
Uv() {
  if command -v uv >/dev/null; then UV_BIN="$(command -v uv)"; else UV_BIN="$APP/runtime/uv/uv"; [ -x "$UV_BIN" ] || { say '  uv not found - run installer/install.sh first.'; return 1; }; fi
  export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$APP/runtime/python}" UV_CACHE_DIR="${UV_CACHE_DIR:-$APP/runtime/uv-cache}"
}

# ---------------------------------------------------------------- NATTEN (ticket 11)
NattenPlan() { # <dir> -> the probe's machine line (##NATTEN json), empty when it says nothing
  local n; n="$(NodeBin)"; [ -n "$n" ] || return 0
  "$n" "$SRC/af_natten_probe.mjs" "$1" 2>>"$LOG" | grep '^##NATTEN' | tail -1 | sed 's/^##NATTEN //'
}
NattenEval() { # <json> -> shell assignments AR_* (values quoted by JSON.stringify)
  local n; n="$(NodeBin)"
  "$n" -e 'const j=JSON.parse(process.argv[1]);for(const k of ["verdict","reason","file","url","size","sha256","installed","forwardOk","needsReinstall","cc","torch","cuda"]){console.log("AR_"+k.toUpperCase()+"="+JSON.stringify(j[k]==null?"":String(j[k])))}' "$1"
}
NattenInstall() { # <dir>  probe -> install the row's wheel -> kernel check -> one repair, then honest truth
  local dir="$1" plan url size sha file
  plan="$(NattenPlan "$dir")"
  if [ -n "$plan" ]; then eval "$(NattenEval "$plan")"
  else AR_VERDICT=probe-failed; AR_REASON='the probe said nothing - keeping the pinned wheel'; fi
  say "  probe: verdict=${AR_VERDICT:-?} cc=${AR_CC:-?} torch=${AR_TORCH:-?}+cu${AR_CUDA:-?} installed=${AR_INSTALLED:-none} - ${AR_REASON:-}"
  [ "${AR_VERDICT:-}" = "lite-recommendation" ] && say "  this card has no NATTEN kernels (below sm_75) - Pixal3D will not run on it; the studio recommends the lighter set (the pinned wheel still installs, the smoke test tells the truth)"
  url="${AR_URL:-$(Mv linux.natten.url)}"; size="${AR_SIZE:-$(Mv linux.natten.size)}"; sha="${AR_SHA256:-$(Mv linux.natten.sha256)}"; file="${AR_FILE:-$(Mv linux.natten.file)}"
  DownloadChecked "$url" "$DL/$file" "$size" "$sha" || return 1
  local py="$dir/.venv/bin/python"
  "$UV_BIN" pip install --python "$py" --no-deps "$DL/$file" || return 1
  plan="$(NattenPlan "$dir")"
  if [ -n "$plan" ]; then eval "$(NattenEval "$plan")"
  else AR_FORWARDOK=true; AR_VERDICT=probe-failed; AR_REASON='kernel check silent (kept as installed - the smoke test verifies)'; return 0; fi
  if [ "${AR_FORWARDOK:-}" != "true" ]; then
    say "  the kernel check did not pass (${AR_REASON:-}) - reinstalling the row's wheel once"
    "$UV_BIN" pip install --python "$py" --no-deps --reinstall "$DL/$file" || return 1
    plan="$(NattenPlan "$dir")"; [ -n "$plan" ] && eval "$(NattenEval "$plan")"
    if [ "${AR_FORWARDOK:-}" != "true" ]; then
      say "  NATTEN still cannot run a forward pass on this card - the engine smoke will report it; no fake green"
    else
      say '  NATTEN kernels verified on this card after reinstall'
    fi
  else
    say '  NATTEN kernels verified on this card'
  fi
  return 0
}
NattenOne() { # <dir> <name>  the repair path for one environment
  local dir="$1" name="$2" plan
  [ -x "$dir/.venv/bin/python" ] || { say "  $name: no .venv there - nothing to check"; return 0; }
  Uv || return 1
  P3EnvPush "$dir"
  plan="$(NattenPlan "$dir")"
  [ -n "$plan" ] || { say "  $name: the probe says nothing (node or venv broken) - environment left as is"; return 0; }
  eval "$(NattenEval "$plan")"
  say "  $name: cc=${AR_CC:-?} installed=${AR_INSTALLED:-none} forward=${AR_FORWARDOK:-?} verdict=${AR_VERDICT} - ${AR_REASON}"
  [ "${AR_VERDICT:-}" = "lite-recommendation" ] && { say "  $name: this card gets no NATTEN kernels; nothing to install - the lighter set is the answer"; return 0; }
  if [ "${AR_FORWARDOK:-}" = "true" ] && [ "${AR_NEEDSREINSTALL:-}" != "true" ]; then say "  $name: NATTEN runs on this card - nothing to fix"; return 0; fi
  local url="${AR_URL:-$(Mv linux.natten.url)}" size="${AR_SIZE:-$(Mv linux.natten.size)}" sha="${AR_SHA256:-$(Mv linux.natten.sha256)}" file="${AR_FILE:-$(Mv linux.natten.file)}"
  say "  $name: replacing NATTEN with ${file}"
  DownloadChecked "$url" "$DL/$file" "$size" "$sha" || { say "  $name: the replacement wheel could not be downloaded"; return 1; }
  "$UV_BIN" pip install --python "$dir/.venv/bin/python" --no-deps --reinstall "$DL/$file" || return 1
  plan="$(NattenPlan "$dir")"; [ -n "$plan" ] && eval "$(NattenEval "$plan")"
  if [ "${AR_FORWARDOK:-}" = "true" ]; then say "  $name: fixed - kernels verified"; return 0; fi
  say "  $name: still no kernels after the replacement - the environment needs a NATTEN build this matrix does not have yet"; return 1
}
NattenFix() { # <primary dir>  check-and-fix BOTH Pixal3D environments (the 0.6.5 fact, ticket 02's slimmed line)
  NattenOne "$1" 'ComfyUI-Pixal3D (8191)' || return 1
  local legacy="$APP/runtime/ComfyUI"
  if [ -d "$legacy/custom_nodes/ComfyUI-Trellis2" ]; then NattenOne "$legacy" 'the pre-0.5 Pixal3D-on-ComfyUI environment' || return 1
  else say '  the pre-0.5 Pixal3D-on-ComfyUI environment is not present here - nothing to fix'; fi
}

# ---------------------------------------------------------------- engine
Engine() { # <dir>
  local dir="$1" py node
  py="$dir/.venv/bin/python"; node="$dir/ComfyUI/custom_nodes/ComfyUI-Trellis2"
  Uv || return 1
  P3EnvPush "$dir"
  if [ ! -x "$py" ]; then
    Title 'Python 3.12 (uv-managed venv inside the install)'
    (cd "$dir" && UvTry 'Python 3.12 via uv' 3 "$UV_BIN" venv --python 3.12 .venv) || return 1
  fi
  "$UV_BIN" pip install --python "$py" 'setuptools>=75' wheel pip >/dev/null || return 1   # idempotent; a venv created before may lack pip
  Title 'ComfyUI (pinned version)'
  if [ ! -f "$dir/ComfyUI/main.py" ]; then
    local czip="$DL/pixal3d-ComfyUI.zip"
    Download "$(Mv comfy.url)" "$czip" || return 1
    local tmp="$dir/_unpack_comfy"; rm -rf "$tmp"; mkdir -p "$tmp"
    unzip -q "$czip" -d "$tmp" || return 1
    rm -rf "$dir/ComfyUI"; mv "$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)" "$dir/ComfyUI"
    rm -rf "$tmp"
  fi
  Title 'ComfyUI-Trellis2 nodes (pinned commit, Linux wheels inside)'
  [ -f "$node/nodes.py" ] || Repo "$(Mv trellis2.url)" "ComfyUI-Trellis2-$(Mv trellis2.commit | cut -c1-8)" "$node" || return 1
  if ! "$py" -c 'import torch' >/dev/null 2>&1; then
    Title 'PyTorch 2.9.1 + CUDA 12.8 (the pair the node ships Linux wheels for)'
    UvTry 'PyTorch 2.9.1 (multi-GB, slow links allowed)' 3 "$UV_BIN" pip install --python "$py" torch==2.9.1 torchvision torchaudio --index-url "$(Mv linux.torch.index)" || return 1
  fi
  Title 'libraries from PyPI (pinned versions, triton replaces triton-windows, msvc-runtime is Windows-only)'
  local lock="$DL/pixal3d-requirements-linux.txt"
  sed -E -e '/^msvc[-_]runtime==/d' -e 's/^triton-windows==.*/'"$(Mv linux.triton)"'/' "$SRC/requirements-lock.txt" > "$lock"
  UvTry 'Pixal3D packages (requirements-lock)' 3 "$UV_BIN" pip install --python "$py" --no-deps -r "$lock" || return 1
  Title 'FlashAttention 2.8.3 (official Linux wheel, sha256 checked)'
  DownloadChecked "$(Mv linux.flashAttn.url)" "$DL/$(Mv linux.flashAttn.file)" "$(Mv linux.flashAttn.size)" "$(Mv linux.flashAttn.sha256)" || return 1
  "$UV_BIN" pip install --python "$py" --no-deps "$DL/$(Mv linux.flashAttn.file)" || return 1
  Title 'NATTEN (kernel probe picks the wheel: torch, CUDA, compute capability - ticket 11)'
  if ! NattenInstall "$dir"; then return 1; fi
  Title 'node wheels (cumesh, custom_rasterizer, flex_gemm, nvdiffrast, nvdiffrec_render, o_voxel)'
  local wd="$node/$(Mv linux.wheelDir)" f dn
  for f in $(Mv linux.wheels | tr -d '[]"' | tr ',' ' '); do
    [ -f "$wd/$f" ] || { say "  The node archive has no wheel $f"; return 1; }
    dn="${f%%-*}"
    if ! ls "$dir/.venv/lib/python3.12/site-packages/$dn"-*.dist-info >/dev/null 2>&1; then
      "$UV_BIN" pip install --python "$py" --no-deps "$wd/$f" || return 1
    fi
  done
  Title 'utils3d 1.7 (GitHub EasternJournalist/utils3d)'
  if ! ls "$dir/.venv/lib/python3.12/site-packages/utils3d-"*.dist-info >/dev/null 2>&1; then
    local uz="$DL/utils3d-$(Mv utils3d.commit | cut -c1-8).zip"
    Download "$(Mv utils3d.url)" "$uz" || return 1
    "$UV_BIN" pip install --python "$py" --no-deps --no-build-isolation "$uz" || return 1
  fi
  Title 'node patch: automatic DINOv3 download from a third-party mirror disabled'
  "$py" "$SRC/patch_trellis2.py" "$node" || return 1
  Extras "$dir" || return 1
  say '  pip check:'; ("$py" -m pip check 2>&1 || true) | while read -r l; do say "    $l"; done   # moderngl is expected: MoGe does not need it
  return 0
}

Extras() { # <dir>  own helpers: vram probe, tools, launch script, installation description
  local dir="$1"
  local d
  for d in tools logs cache/huggingface cache/torch/hub/checkpoints; do mkdir -p "$dir/$d"; done
  mkdir -p "$dir/ComfyUI/custom_nodes"
  cp -f "$SRC/af_vram_probe.py" "$dir/ComfyUI/custom_nodes/af_vram_probe.py"
  local f
  for f in dinov3_timm_to_hf.py normalize_seed_mesh.py smoke_test.py patch_trellis2.py; do cp -f "$SRC/$f" "$dir/tools/$f"; done
  cp -f "$SRC/af_natten_probe.mjs" "$dir/tools/af_natten_probe.mjs"
  cat > "$dir/start-pixal3d.sh" <<'EOF'
#!/usr/bin/env bash
# Start the Pixal3D engine (ComfyUI on 127.0.0.1:8191). Stop: Ctrl+C. The studio starts it on its own.
cd "$(dirname "$0")"
unset CUDA_PATH CUDA_HOME CUDA_BIN_PATH CUDNN_PATH PYTHONPATH PYTHONHOME VIRTUAL_ENV CONDA_PREFIX 2>/dev/null || true
export HF_HOME="$PWD/cache/huggingface" TORCH_HOME="$PWD/cache/torch" PYTHONUTF8=1
exec .venv/bin/python -W ignore::FutureWarning ComfyUI/main.py --listen 127.0.0.1 --port 8191 --disable-auto-launch
EOF
  chmod +x "$dir/start-pixal3d.sh"
  local rd="$dir/ComfyUI/models/microsoft/TRELLIS.2-4B"
  mkdir -p "$rd"
  [ -f "$dir/ComfyUI/custom_nodes/ComfyUI-Trellis2/reconviagen_pipeline.json" ] && [ ! -f "$rd/reconviagen_pipeline.json" ] && cp "$dir/ComfyUI/custom_nodes/ComfyUI-Trellis2/reconviagen_pipeline.json" "$rd/"
  local nodec; nodec="$(Mv trellis2.commit | cut -c1-8)"
  cat > "$dir/ASTRAFORGE_README.md" <<EOF
# ComfyUI-Pixal3D for AstraForge (Linux)

A separate portable ComfyUI with TRELLIS.2 + Pixal3D (shape only, no texturing), port 127.0.0.1:8191.
Installed by the AstraForge installer; the studio ComfyUI (port 8190) and the system Python are not touched.

Start: \`.\/start-pixal3d.sh\` (the studio also starts it). Stop: Ctrl+C.
Check: \`.venv/bin/python tools/smoke_test.py\` (with ComfyUI running).

Versions: Python 3.12 (venv), ComfyUI 0.39.0 (@COMFY@), ComfyUI-Trellis2 1.0.27 (@NODE@), PyTorch 2.9.1+cu128,
FlashAttention 2.8.3, NATTEN 0.21.5+torch290cu128, triton (replaces triton-windows), utils3d 1.7 (GitHub),
other packages per the installer's requirements-lock.txt; CUDA wheels from the node folder wheels/Linux/Torch291.

Licenses: Pixal3D, TRELLIS.2 and the node wrapper, MoGe: MIT; NAF: Apache-2.0; FlashAttention and NATTEN: BSD-3;
DINOv3: the DINOv3 license (\`ComfyUI/models/facebook/.../LICENSE.md\`; royalty-free, commercial use allowed;
military purposes and violating trade restrictions are prohibited; redistribution must include the license text).

IMPORTANT: nvdiffrast and nvdiffrec_render (NVIDIA) are non-commercial. They are installed only because the
Trellis2 node imports them on load; AstraForge does not call them. Do not use in production the nodes
MeshTexturing*, TexSlatGenerator, RenderMultiViewNvdiffrast, UnWrapAndRasterizer, PostProcessAndUnWrapAndRasterizer,
Multi-View Texturing and Trellis2/Pixal3D texturing. The meshlib package (non-commercial only) is not installed:
the nodes are patched (patch_trellis2.py), holes are filled by CuMesh (MIT). pymeshlab is GPL-3.0.

Node patch: ComfyUI/custom_nodes/ComfyUI-Trellis2/nodes.py is marked ASTRAFORGE PATCH: the automatic DINOv3
download from a third-party mirror is replaced by an error.
EOF
  sed -i "s/@NODE@/$nodec/" "$dir/ASTRAFORGE_README.md"
  sed -i "s/@COMFY@/$(Mv comfy.commit | cut -c1-8)/" "$dir/ASTRAFORGE_README.md"
}

# ---------------------------------------------------------------- weights
Weights() { # <dir>
  local dir="$1" py md n
  py="$dir/.venv/bin/python"; md="$dir/ComfyUI/models"
  [ -x "$py" ] || { say '  Install the engine first.'; return 1; }
  P3EnvPush "$dir"
  mkdir -p "$md"
  local nbin; nbin="$(NodeBin)"
  # Pixal3D shape weights + MoGe-2: size/sha from manifest.json, refreshed against the live HF listing
  local items
  items="$("$nbin" -e '
    const m=require(process.argv[1]);const out=[];
    for(const f of m.pixal3d.files) out.push(["TencentARC/Pixal3D/"+f.path,"https://huggingface.co/"+m.pixal3d.repo+"/resolve/main/"+f.path,f.size,f.sha256||""].join("\t"));
    for(const f of m.moge.files) out.push(["Ruicheng/moge-2-vitl/"+f.path,"https://huggingface.co/"+m.moge.repo+"/resolve/main/"+f.path,f.size,f.sha256||""].join("\t"));
    console.log(out.join("\n"))' "$MAN")"
  Title 'Pixal3D weights (shape, single view and several views) and MoGe-2'
  while IFS=$'\t' read -r rel url size sha; do
    [ -n "$rel" ] || continue
    if [ -n "$sha" ]; then
      DownloadChecked "$url" "$md/$rel" "$size" "$sha" || return 1
    else
      DownloadChecked "$url" "$md/$rel" "$size" || return 1
    fi
  done <<<"$items"
  # sparse structure decoder: the same file must also sit where the node expects it
  for n in ss_dec_conv3d_16l8_fp16.json ss_dec_conv3d_16l8_fp16.safetensors; do
    mkdir -p "$md/microsoft/TRELLIS-image-large/ckpts"
    [ -f "$md/microsoft/TRELLIS-image-large/ckpts/$n" ] || cp "$md/TencentARC/Pixal3D/ckpts/$n" "$md/microsoft/TRELLIS-image-large/ckpts/$n"
  done
  mkdir -p "$md/microsoft/TRELLIS.2-4B"
  Title 'NAF (feature upsampler): code at the pinned commit + the release weights'
  local hub="$dir/cache/torch/hub"
  local naf="$hub/valeoai_NAF_main"
  [ -f "$naf/hubconf.py" ] || { mkdir -p "$hub"; Repo "$(Mv naf.url)" "NAF-$(Mv naf.commit | cut -c1-8)" "$naf" || return 1; }
  DownloadChecked "$(Mv naf.checkpoint.url)" "$hub/checkpoints/naf_release.pth" "$(Mv naf.checkpoint.size)" "$(Mv naf.checkpoint.sha256)" || return 1
  Title 'DINOv3 ViT-L/16: official timm copy -> transformers format, parity check'
  local fb="$md/facebook/dinov3-vitl16-pretrain-lvd1689m"
  if [ ! -f "$fb/model.safetensors" ]; then
    local td="$md/timm/vit_large_patch16_dinov3.lvd1689m"
    mkdir -p "$td"
    while IFS=$'\t' read -r rel url size sha; do
      [ -n "$rel" ] || continue
      DownloadChecked "$url" "$td/$rel" "$size" "$sha" || return 1
    done < <("$nbin" -e '
      const m=require(process.argv[1]);
      for(const f of m.dinov3.files) console.log([f.path,"https://huggingface.co/"+m.dinov3.repo+"/resolve/main/"+f.path,f.size,f.sha256||""].join("\t"))' "$MAN")
    # 1024 px parity needs ~9 GB of activations: on a 12 GB card with the eager attention path it can OOM
    # (found on an RTX 5070). Retry at 512 px — the same conversion, a still-real parity row; noted in docs/linux.md.
    if ! "$py" "$SRC/dinov3_timm_to_hf.py" --timm-dir "$td" --out-dir "$fb" --report "$dir/logs/dinov3_parity.json"; then
      say '  parity at the default sizes did not fit in video memory - retrying at 512 px'
      "$py" "$SRC/dinov3_timm_to_hf.py" --timm-dir "$td" --out-dir "$fb" --report "$dir/logs/dinov3_parity.json" --sizes 512 || return 1
    fi
    [ -f "$fb/model.safetensors" ] || { say '  The DINOv3 conversion did not create model.safetensors.'; return 1; }
    rm -f "$td/model.safetensors"
  fi
}

# ---------------------------------------------------------------- smoke
Test() { # <dir>
  local dir="$1" py proc=''
  py="$dir/.venv/bin/python"
  if curl -sf -m 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null; then
    say "  port $PORT is already taken by a running ComfyUI: checking it without stopping it"
    "$py" "$SRC/smoke_test.py" --port "$PORT" && return 0 || return 1
  fi
  P3EnvPush "$dir"
  mkdir -p "$dir/logs"
  say "  smoke start of ComfyUI on 127.0.0.1:$PORT (the first start takes up to a couple of minutes)"
  (cd "$dir" && setsid "$py" -W ignore::FutureWarning ComfyUI/main.py --listen 127.0.0.1 --port "$PORT" --disable-auto-launch >"$dir/logs/smoke_comfy.log" 2>"$dir/logs/smoke_comfy_err.log" & echo $! > "$dir/logs/smoke.pid")
  proc="$(cat "$dir/logs/smoke.pid")"
  local up='' i
  for i in $(seq 150); do
    kill -0 "$proc" 2>/dev/null || break
    curl -sf -m 3 "http://127.0.0.1:$PORT/system_stats" >/dev/null && { up=1; break; }
    sleep 2
  done
  local rc=0
  if [ -z "$up" ]; then
    say "  ComfyUI did not respond on port $PORT. Log: $dir/logs/smoke_comfy.log"
    tail -8 "$dir/logs/smoke_comfy_err.log" 2>/dev/null | while read -r l; do say "    $l"; done
    rc=1
  else
    "$py" "$SRC/smoke_test.py" --port "$PORT" || rc=1
  fi
  kill -KILL -- -"$proc" 2>/dev/null || kill -KILL "$proc" 2>/dev/null
  say '  smoke start stopped'
  return $rc
}

cmd="${1:-}"; dir="${2:-$APP/runtime/ComfyUI-Pixal3D}"
case "$cmd" in
  engine)  Engine "$dir" ;;
  weights) Weights "$dir" ;;
  test)    Test "$dir" ;;
  natten)  NattenFix "$dir" ;;
  *) echo 'usage: install-pixal3d.sh engine|weights|test|natten [dir]'; exit 2 ;;
esac
