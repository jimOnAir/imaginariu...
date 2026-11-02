#!/usr/bin/env bash
# Start the studio on Linux/macOS (the counterpart of scripts/Start.ps1).
# Reads the paths the installer wrote to config/paths.json into ASTRA_* variables, then runs the server
# detached with logs in data/runtime/. User-set environment variables win over config/paths.json.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL='http://127.0.0.1:3210'
NO_BROWSER=0
[ "${1:-}" = '--no-browser' ] && NO_BROWSER=1

health() { curl -sf -m 2 "$URL/api/health" 2>/dev/null || true; }
H="$(health)"
if printf '%s' "$H" | grep -q '"app":"AstraForge"'; then
  [ "$NO_BROWSER" = 0 ] && command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 & exit 0
fi
[ -n "$H" ] && { echo 'Port 3210 is in use by another application.' >&2; exit 1; }

SETUP_HINT="Run 'installer/install.sh' in the application folder."
PATHS="$ROOT/config/paths.json"

# Node for parsing the config: any node on PATH works; a missing one is the installer's job to provide.
PARSER="$(command -v node || true)"
if [ -f "$PATHS" ] && [ -n "$PARSER" ]; then
  eval "$("$PARSER" -e 'const c=require(process.argv[1]);const m={comfyDir:"ASTRA_COMFY_DIR",blender:"ASTRA_BLENDER",godot:"ASTRA_GODOT",library:"ASTRA_FORGE_LIBRARY",forgeRuntime:"ASTRA_FORGE_RUNTIME",pixal3dDir:"ASTRA_PIXAL3D_DIR",vfxTools:"ASTRA_VFX_TOOLS"};for(const[k,v]of Object.entries(m)){if(c[k]&&!process.env[v])console.log(`export ${v}=${JSON.stringify(String(c[k]))};`);}if(c.node&&!process.env.ASTRA_NODE)console.log(`export ASTRA_NODE_PATH=${JSON.stringify(String(c.node))};`);' "$PATHS")"
fi
NODE="${ASTRA_NODE_PATH:-$PARSER}"   # node written by the installer if present and executable, else the system one
[ -n "$NODE" ] && [ ! -x "$NODE" ] && NODE="$PARSER"
{ [ -z "$NODE" ] || [ ! -x "$NODE" ]; } && { echo "Node.js was not found. $SETUP_HINT" >&2; exit 1; }
[ -d "$ROOT/node_modules/express" ] || { echo "Dependencies are missing. $SETUP_HINT" >&2; exit 1; }
[ -f "$ROOT/dist/index.html" ] || { echo "The interface has not been built. $SETUP_HINT" >&2; exit 1; }

mkdir -p "$ROOT/data/runtime"
cd "$ROOT"
nohup "$NODE" server/index.mjs >data/runtime/server.log 2>data/runtime/server-error.log &
echo $! >data/runtime/node.pid

for _ in $(seq 40); do
  H="$(health)"
  if printf '%s' "$H" | grep -q '"app":"AstraForge"'; then
    [ "$NO_BROWSER" = 0 ] && command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 &
    echo 'AstraForge is ready: http://127.0.0.1:3210'
    exit 0
  fi
  sleep 0.5
done
echo 'AstraForge did not start. See data/runtime/server-error.log.' >&2
exit 1
