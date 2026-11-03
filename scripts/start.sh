#!/usr/bin/env bash
# Start the studio on Linux/macOS (the counterpart of scripts/Start.ps1).
# Reads the paths the installer wrote to config/paths.json into ASTRA_* variables, then runs the server
# detached with logs in data/runtime/. User-set environment variables win over config/paths.json.
# A missing piece is reported in Russian and English with the remedy, not as raw shell noise (0.4.14).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3210}"
URL="http://127.0.0.1:$PORT"
NO_BROWSER=0
[ "${1:-}" = '--no-browser' ] && NO_BROWSER=1

# Human failure (the shipped Start.ps1 words): what happened, what to do, where to write.
fail() { # $1 = reason in Russian, $2 = reason in English
  {
    echo "AstraForge не запускается: $1 Откройте папку $ROOT и запустите installer/install.sh — он докачает только недостающее; если не поможет — пришлите installer/install.log и data/runtime/server-error.log (контакт в README.md)." >&2
    echo "AstraForge cannot start: $2 Open the folder $ROOT and run installer/install.sh — it downloads only what is missing; if it still fails, send installer/install.log and data/runtime/server-error.log (contact in README.md)." >&2
  }
  exit 1
}

health() { curl -sf -m 2 "$URL/api/health" 2>/dev/null || true; }
H="$(health)"
if printf '%s' "$H" | grep -q '"app":"AstraForge"'; then
  [ "$NO_BROWSER" = 0 ] && command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 & exit 0
fi
[ -n "$H" ] && { echo "Порт $PORT занят другим приложением. / Port $PORT is in use by another application." >&2; exit 1; }

PATHS="$ROOT/config/paths.json"
# Any node on PATH can parse the config; a missing one is the installer's job to provide.
PARSER="$(command -v node || true)"
# BOM-safe parsing (scripts/paths-env.mjs), so installer-written paths are never silently dropped.
[ -f "$PATHS" ] && [ -n "$PARSER" ] && eval "$("$PARSER" "$ROOT/scripts/paths-env.mjs" "$PATHS" 2>/dev/null || true)"
# Node.js is found in the app's own runtime/node too, even without config/paths.json (0.4.14).
NODE="${ASTRA_NODE_PATH:-}"
{ [ -n "$NODE" ] && [ ! -x "$NODE" ]; } && NODE=''
[ -z "$NODE" ] && [ -x "$ROOT/runtime/node/bin/node" ] && NODE="$ROOT/runtime/node/bin/node"
[ -z "$NODE" ] && NODE="$PARSER"
{ [ -z "$NODE" ] || [ ! -x "$NODE" ]; } && fail 'не найден Node.js.' 'Node.js was not found.'
[ -d "$ROOT/node_modules/express" ] || fail 'не установлены библиотеки студии (node_modules).' 'the studio libraries are missing (node_modules).'
[ -f "$ROOT/dist/index.html" ] || fail 'интерфейс не собран.' 'the interface has not been built.'

mkdir -p "$ROOT/data/runtime"
cd "$ROOT"
nohup "$NODE" server/index.mjs >data/runtime/server.log 2>data/runtime/server-error.log &
echo $! >data/runtime/node.pid

for _ in $(seq 40); do
  H="$(health)"
  if printf '%s' "$H" | grep -q '"app":"AstraForge"'; then
    [ "$NO_BROWSER" = 0 ] && command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 &
    echo "AstraForge is ready: $URL"
    exit 0
  fi
  sleep 0.5
done
echo 'AstraForge не запустилась за 20 секунд. Смотрите data/runtime/server-error.log.' >&2
echo 'AstraForge did not start within 20 seconds. See data/runtime/server-error.log.' >&2
exit 1
