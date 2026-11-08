#!/usr/bin/env bash
# AstraForge - VFX texture generators for Linux/macOS (the counterpart of scripts/vfx/Install-VfxTools.ps1).
# Downloads the generators from server/vfx-tools-catalog.json that are usable on this OS from their official
# sites; tools whose vendor ships no Linux build are reported, never emulated (docs/linux.md, GLOSSARY "Linux parity").
#   -Root <folder>  where to install; default $ASTRA_VFX_TOOLS or <app>/runtime/vfx
#   -Only a,b       only these tools (ids from the catalog)
#   -DryRun         show the plan without downloading anything
# Anything already downloaded is skipped, so the script can be run again. No administrator rights needed.
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${ASTRA_VFX_TOOLS:-$APP/runtime/vfx}"
Only='' DryRun=0 prev=''
for arg in "$@"; do
  case "$arg" in
    -Root|--root) prev='Root' ;;
    -Only|--only) prev='Only' ;;
    -DryRun|--dry-run) DryRun=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) [ "$prev" = Root ] && ROOT="$arg"; [ "$prev" = Only ] && Only="$arg"; ;;
  esac
done
CATALOG="${ASTRA_VFX_CATALOG:-$APP/server/vfx-tools-catalog.json}"   # the seam tests use; production reads the shipped catalog
NODE_BIN="${ASTRA_NODE:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || { echo 'node is required (npm for DisplacementX). Run installer/install.sh first.'; exit 1; }
NPM_BIN="$("$NODE_BIN" -e 'const p=require("path"),d=require("path").dirname(process.execPath);console.log(p.join(d,process.platform==="win32"?"npm.cmd":"npm"))')"

say() { printf '%s\n' "$1"; }
# the shared download core (reason table, resume/retry loop, checksums, mirrors)
DL_USER_AGENT='Mozilla/5.0 AstraForge'; export DL_USER_AGENT
# shellcheck source=../../installer/af_download.sh
. "$APP/installer/af_download.sh"
Inside() { case "$1" in /*|*..*) say "Path outside the tools folder: $1"; exit 1 ;; esac; printf '%s/%s' "$ROOT" "$1"; }
Filled() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }
Unpack() { # <archive> <dst> [strip]
  local dst="$2" strip="${3:-}" tmp
  tmp="$(mktemp -d "${ROOT}/_unpack.XXXXXX")"
  case "$1" in
    *.tar.gz|*.tgz) tar -xzf "$1" -C "$tmp" ;;
    *.zip) unzip -q "$1" -d "$tmp" ;;
    *) rm -rf "$tmp"; say "  Unsupported archive: $1"; return 1 ;;
  esac
  if [ -z "$strip" ]; then   # a single top-level folder inside the archive is stripped automatically
    if [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" = 1 ] && [ -d "$(find "$tmp" -mindepth 1 -maxdepth 1)" ]; then
      strip="$(basename "$(find "$tmp" -mindepth 1 -maxdepth 1)")"
    fi
  fi
  local src="$tmp"
  if [ -n "$strip" ]; then src="$tmp/$strip"; [ -d "$src" ] || { rm -rf "$tmp"; say "  The archive has no folder $strip"; return 1; }
  elif [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" = 1 ]; then src="$(find "$tmp" -mindepth 1 -maxdepth 1)"; fi
  mkdir -p "$dst"
  if ! cp -a "$src"/. "$dst"/; then rm -rf "$tmp"; say "  Could not move the archive contents to $dst"; return 1; fi
  rm -rf "$tmp"
}
Fetch() { # <url> <file|unzip-target> <is-unzip 0|1> [strip] [sha256]
  # with a catalog sha256 the file is verified before use; a mismatch is deleted and never unpacked (0.4.15 gate)
  if [ "$2x" != x ] && [ "$3" = 1 ]; then
    local dst; dst="$(Inside "$2")"
    if Filled "$dst"; then say "    already unpacked: $2"; return 0; fi
    local leaf zip
    leaf="$(basename "$1" | cut -d'?' -f1)"; zip="$(Inside "downloads/$leaf")"
    DownloadChecked "$1" "$zip" 0 "${5:-}" || return 1
    Unpack "$zip" "$dst" "${4:-}" || return 1
    rm -f "$zip"
  else
    DownloadChecked "$1" "$(Inside "$2")" 0 "${5:-}"
  fi
}
GitHub() { # <git-url> <branch> <dir>
  local dst; dst="$(Inside "$3")"
  if Filled "$dst"; then say "    already present: $3"; return 0; fi
  local repo branch zip
  repo="$(printf '%s' "$1" | sed -E 's#^https://github\.com/##; s#/$##')"; branch="$2"
  zip="$(Inside "downloads/$(printf '%s' "$repo" | tr '/' '_').zip")"
  # two delivery channels for the same branch archive (ticket 03 VFX mirror): github.com answers via
  # a redirect to codeload; if that layer does not answer, the codeload endpoint itself is tried
  DownloadMirrors "$zip" 0 '' "https://github.com/$repo/archive/refs/heads/$branch.zip" "https://codeload.github.com/$repo/zip/refs/heads/$branch" || return 1
  Unpack "$zip" "$dst" "${repo##*/}-$branch" || return 1
  rm -f "$zip"
}
BuildAstro() { # <dir> <base> <out>
  local src; src="$(Inside "$1")"
  local out; out="$(Inside "$3")"
  if [ -f "$out/index.html" ]; then say "    already built: $3"; return 0; fi
  if [ ! -x "$NPM_BIN" ]; then say '    npm not found - build skipped (install Node.js and run the script again).'; return 0; fi
  local cfg="$src/astro.config.mjs"
  if [ -f "$cfg" ] && ! grep -q 'base:' "$cfg"; then
    "$NODE_BIN" -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],fs.readFileSync(process.argv[1],"utf8").replace("integrations:", "base: \x27"+process.argv[2]+"\x27,\n  integrations:"))' "$cfg" "$2"
  fi
  (cd "$src" && "$NPM_BIN" ci --no-audit --no-fund && "$NPM_BIN" exec -- astro build) || { say '  The DisplacementX build failed'; return 1; }
  rm -rf "$out"
  mv "$src/dist" "$out"
  rm -rf "$src/node_modules"
}
BuildSculptGL() { # <src> <out> - the Sculpt tab (src/SculptPanel.jsx): webpack release build, then scripts/sculpt/assemble.mjs stitches the studio page (bridge in, external calls out)
  local src; src="$(Inside "$1")"
  local out; out="$(Inside "$2")"
  if [ -f "$out/index.html" ] && grep -q sculptgl-bridge.js "$out/index.html"; then say "    already built: $2"; return 0; fi
  if [ ! -x "$NPM_BIN" ]; then say '    npm not found - SculptGL not built (install Node.js and run the script again).'; return 0; fi
  if [ ! -f "$src/app/index.html" ]; then   # app/ exists after a successful webpack build: a repeated run does not rebuild
    (cd "$src" && "$NPM_BIN" ci --ignore-scripts --no-audit --no-fund &&
      "$NPM_BIN" install --no-save --ignore-scripts --no-audit --no-fund webpack@5.97.1 webpack-cli@4.10.0 &&
      "$NPM_BIN" exec -- webpack --env release) || { say '  The SculptGL build failed'; return 1; }
    rm -rf "$src/node_modules"
  fi
  "$NODE_BIN" "$APP/scripts/sculpt/assemble.mjs" "$src" "$out" || { say '  Could not assemble SculptGL (assemble.mjs)'; return 1; }
  say '  SculptGL is built; the studio opens it in the Sculpt tab after a restart.'
}

MaterialMaker() { # <id> <file>
  local dst; dst="$(Inside "$2")"
  if [ -f "$dst" ]; then say "    already downloaded: $(basename "$dst")"; return 0; fi
  local json
  json="$(curl -s -L --fail --retry 3 --max-time 60 "https://www.materialmaker.org/api/getMaterial?id=$1" |
    "$NODE_BIN" -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const m=JSON.parse(t);process.stdout.write(typeof m.json==="string"?m.json:JSON.stringify(m.json))})')" || { say '  materialmaker.org did not answer'; return 1; }
  mkdir -p "$(dirname "$dst")"
  printf '%s' "$json" > "$dst"
}

say "VFX texture generators -> $ROOT"
mkdir -p "$ROOT/downloads" "$ROOT/textures"
failed=''
# Ticket 15: a catalog entry whose download carries an `optional` reason string never fails the
# step - the miss is named in the log with the reason and the hint to the author's site (which the
# VFX tab links anyway); every hard entry still fails the way it always did.
FailOrSkip() { # <id> <name> <optional-reason>
  if [ -n "$3" ]; then say "    SKIPPED (optional, $1): $3 - open the author's site from the VFX tab if you still want it"; return 0; fi
  failed="$failed $1"; return 0
}
while IFS=$'\t' read -r id name license action payload plan optional; do
  [ -n "$id" ] || continue
  [ -n "$Only" ] && { case ",$Only," in *",$id,"*) ;; *) continue ;; esac; }
  say "  $name  ($license)"
  if [ "$DryRun" = 1 ]; then say "    plan: $plan"; continue; fi
  case "$action" in
    skip) say "    $payload" ;;
    fetch) IFS=$'\x1f' read -r url kind target strip sha <<<"$payload"
      Fetch "$url" "$target" "$([ "$kind" = unzip ] && echo 1 || echo 0)" "$strip" "$sha" || FailOrSkip "$id" "$name" "${optional:-}" ;;
    github) IFS=$'\x1f' read -r git branch dir build base out <<<"$payload"
      if GitHub "$git" "$branch" "$dir"; then
        case "$build" in
          astro) BuildAstro "$dir" "$base" "$out" || failed="$failed $id" ;;
          sculptgl) BuildSculptGL "$dir" "$out" || failed="$failed $id" ;;
        esac
      else failed="$failed $id"; fi ;;
    materialmaker) IFS=$'\x1f' read -r mmid file <<<"$payload"
      MaterialMaker "$mmid" "$file" || failed="$failed $id" ;;
    manual) IFS=$'\x1f' read -r url dst strip_linux note <<<"$payload"
      if Filled "$(Inside "$dst")"; then say "    already unpacked: $dst"
      else
        local_zip="$(find "$ROOT/downloads" -maxdepth 1 -iname '*Volume*Linux*.zip' | head -1)"
        if [ -n "$local_zip" ]; then Unpack "$local_zip" "$(Inside "$dst")" "$strip_linux" && say "    unpacked from $(basename "$local_zip")" || failed="$failed $id"
        else say "    download manually: $url"; say "    $note"; fi
      fi ;;
  esac
done < <("$NODE_BIN" -e '
 const IS_WIN = process.platform === "win32";
 const cat = require(process.argv[1]);
 for (const t of cat.tools) {
   const lin = t.linux;
   if (!IS_WIN && lin?.unsupported) { console.log([t.id, t.name, t.license || "", "skip", lin.unsupported, "skipped: no Linux build"].join("\t")); continue; }
   const d = lin?.download || t.download;
   if (!d) continue;
   const sep = "\x1f";
   if (d.manual) {
     const url = lin?.manualUrl || d.manual, stripLinux = lin?.stripLinux || "3D Volume Generator 2.7 Linux";
     console.log([t.id, t.name, t.license || "", "manual", [url, d.unzip, stripLinux, (lin?.manualNote || d.note || "")].join(sep), "manual: " + url].join("\t"));
   } else if (d.git) {
     console.log([t.id, t.name, t.license || "", "github", [d.git, d.branch || "main", d.dir, d.build || "", d.base || "", d.out || ""].join(sep), d.git].join("\t"));
   } else if (d.materialMaker) {
     console.log([t.id, t.name, t.license || "", "materialmaker", [d.materialMaker, d.file].join(sep), "materialmaker.org #" + d.materialMaker].join("\t"));
   } else if (d.url) {
     const kind = d.unzip ? "unzip" : "file", target = d.unzip || d.file;
     console.log([t.id, t.name, t.license || "", "fetch", [d.url, kind, target, d.strip || "", d.sha256 || ""].join(sep), d.url, String(d.optional || "").replace(/[\t\r\n]+/g, " ")].join("\t"));
   }
   for (const x of [].concat(d.extra || [])) if (x) console.log([t.id + ":extra", t.name, t.license || "", x.unzip ? "fetch" : "fetch", [x.url, x.unzip ? "unzip" : "file", x.unzip || x.file, x.strip || "", x.sha256 || ""].join(sep), x.url].join("\t"));
 }' "$CATALOG")
if [ -n "$failed" ]; then say "Failed: $(printf '%s' "$failed" | tr -s ' ' ',' | sed 's/^,//'). Run the script again with -Only $(printf '%s' "$failed" | tr -s ' ' '\n' | sort -u | paste -sd, -)"; exit 1; fi
say 'Done. Open the studio, "VFX" tab.'
