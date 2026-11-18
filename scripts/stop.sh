#!/usr/bin/env bash
# Stop the studio on Linux/macOS (the counterpart of scripts/Stop.ps1).
# Stops only processes the studio itself started: the node server (node.pid), the ComfyUI whose command
# line names this folder's data/runtime/input on port 8190 (comfy.pid), and the Pixal3D engine carrying
# the pixal3d-temp marker (pixal3d.pid). A ComfyUI on 8188 or Ollama you run yourself is never touched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# ticket 60 item 2: the studio may have taken another port at start - stop the address it
# actually answered on; without node (or before the first start) the usual 3210 still applies.
URL="http://127.0.0.1:$(command -v node >/dev/null 2>&1 && node "$ROOT/scripts/studio-port.mjs" 2>/dev/null || echo 3210)"

owned_cmdline() { # <pid> <marker...> — is the process alive and does its command line contain every marker?
  local pid="$1"; shift
  [ -r "/proc/$pid/cmdline" ] || return 1
  local cmd; cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  local marker
  for marker in "$@"; do case "$cmd" in *"$marker"*) ;; *) return 1 ;; esac; done
  return 0
}

kill_tree() { # <pid> — the studio starts these detached (their own process group), so the whole tree goes
  local pid="$1"
  kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

stop_owned() { # <pidfile> <marker...>
  local file="$ROOT/data/runtime/$1"; shift
  [ -f "$file" ] || return 0
  local pid; pid="$(cat "$file" 2>/dev/null || true)"
  case "$pid" in (*[!0-9]*|'') return 0 ;; esac
  owned_cmdline "$pid" "$@" && kill_tree "$pid"
  rm -f "$file"
}

if curl -sf -m 2 "$URL/api/health" 2>/dev/null | grep -q '"app":"Imaginarium"'; then
  curl -sf -m 5 -X POST -H 'x-imaginarium-client: studio' "$URL/api/shutdown" >/dev/null || true
  sleep 1
fi
[ -f "$ROOT/data/runtime/node.pid" ] && { pid="$(cat "$ROOT/data/runtime/node.pid")"; case "$pid" in (*[!0-9]*|'') : ;; (**) owned_cmdline "$pid" 'server/index.mjs' && kill_tree "$pid" ;; esac; rm -f "$ROOT/data/runtime/node.pid"; }
stop_owned comfy.pid "$ROOT/data/runtime/input" '--port' '8190'
stop_owned pixal3d.pid "$ROOT/data/runtime/pixal3d-temp"
echo 'Imaginarium stopped. The existing ComfyUI on 8188 and Ollama were left running.'
