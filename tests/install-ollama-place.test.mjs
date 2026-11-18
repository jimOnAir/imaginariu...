// The installer's Ollama model placement (0.6.10 wave ticket 22) is tested black-box: the
// placement functions are extracted from installer/install.sh verbatim and driven in a bash with
// a fake HOME, a node-path seam, a curl stub (server up/down) and, for the cross-device branch,
// a fake df on PATH. What is pinned: the user always wins; existing models are never hidden;
// a recorded placement is reused (and recreated); the short-drive relocation writes the
// paths.json key AND exports OLLAMA_MODELS; a live server decides for itself. The 0.7.9-fold
// ticket-60 offer rides the same harness: short drive + room at the studio asks (and an answered
// yes moves through a staging copy verified per file - blobs against the checksum in their own
// name - before an original is deleted), a no keeps, -Yes never asks, a corrupt blob aborts the
// move, and a studio drive without room never gets the question at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SCRIPT = `
set -u
REPO=${REPO}
ROOT="$WORK/root"; RT="$ROOT/runtime"; CFGF="$ROOT/config/paths.json"
mkdir -p "$RT"
export HOME="$WORK/home"; mkdir -p "$HOME"
export IMAGINARIUM_MANIFEST="$REPO/installer/manifest.json"
NodeBin() { printf '%s' "$NODE"; }
Gb() { awk -v b="$1" 'BEGIN{printf "%.1f GB", b/1e9}'; }
FreeOn() { df -B1 --output=avail "$1" 2>/dev/null | tail -1 | tr -d ' '; }
FreeText() { local f="$1"; if [ -n "$f" ]; then Gb "$f"; else printf 'unknown'; fi; }
FreeUnder() { [ -n "$1" ] && [ "$(awk -v f="$1" -v d="$2" 'BEGIN{print (f<d)?1:0}')" = 1 ]; }
say() { echo "SAY: $1"; }
curl() { [ "\${FAKE_SERVER_UP:-0}" = 1 ] && return 0; return 7; }
CfgGet() { local n; n="$(NodeBin)"; [ -n "$n" ] || { printf ''; return; }; "$n" -e 'try{const c=require(process.argv[1]);const v=c[process.argv[2]];if(v!=null)process.stdout.write(String(v))}catch(e){}' "$CFGF" "$1" 2>/dev/null || true; }
CfgSet() { local n; n="$(NodeBin)"; [ -n "$n" ] || return 1; "$n" -e '
 const fs=require("fs"),p=require("path"),f=process.argv[1];let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
 for(let i=2;i<process.argv.length;i+=2)c[process.argv[i]]=process.argv[i+1];
 fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(c,null,2)+"\\n")' "$CFGF" "$@"; }
# the move-offer tests (ticket 60 item 3) need the real Ask semantics: -Yes answers the default
# without reading, anything else reads the line; and a df whose two drives differ by device and
# free space, plus a models folder shaped as Ollama keeps it (name-verified blob + manifest).
Yes="\${ASK_YES:-0}"
Ask() { local def="\${2:-y}"
  if [ "$Yes" = 1 ]; then [ "$def" = y ]; return; fi
  local ans
  if [ "$def" = y ]; then read -r -p "$1 [Y/n] " ans || ans=''; else read -r -p "$1 [y/N] " ans || ans=''; fi
  ans="\${ans:-$def}"
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac; }
fake_df() { # env in: HOME_AVAIL, STUDIO_AVAIL, FAKE_HOME_PREFIX
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/df" <<'DF'
#!/usr/bin/env bash
p="\${*: -1}"
case "\$p" in
  *"\$FAKE_HOME_PREFIX"*) dev="/dev/fakehome"; avail="\$HOME_AVAIL" ;;
  *)                     dev="/dev/fakestudio"; avail="\$STUDIO_AVAIL" ;;
esac
case "\$*" in
  *--output=avail*) echo "Avail"; echo "\$avail" ;;
  *) echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "\$dev 1 1 1 100% /" ;;
esac
DF
  chmod +x "$WORK/bin/df"; PATH="$WORK/bin:$PATH"
}
ollama_with_models() { # the real layout: blobs named by their own sha256 + a manifest json
  local content='ollama blob payload' h
  h="$(printf '%s' "$content" | sha256sum | cut -d' ' -f1)"
  mkdir -p "$HOME/.ollama/models/blobs" "$HOME/.ollama/models/manifests"
  printf '%s' "$content" > "$HOME/.ollama/models/blobs/sha256-$h"
  printf '%s' '{"model":"x"}' > "$HOME/.ollama/models/manifests/latest"
  printf '%s' "$h" > "$WORK/blob-sha"
}
eval "$(awk '/^# ---------------------------------------------------------------- Ollama model placement/,/^PullModel\\(\\)/' "$REPO/installer/install.sh" | grep -v '^PullModel()')"
case "$CASE" in
  modelbytes) echo "MB[$(modelBytes qwen3:14b)][$(modelBytes qwen3-vl:8b)][$(modelBytes bogus:x)]" ;;
  serverup)   FAKE_SERVER_UP=1; PrepareOllamaModels 9000000000 ;;
  same)       PrepareOllamaModels 6000000000; echo "MODELS=\${OLLAMA_MODELS:-unset}"; [ -f "$CFGF" ] && echo wrote || echo clean ;;
  have)       mkdir -p "$HOME/.ollama/models/manifests"; touch "$HOME/.ollama/models/manifests/keep"
              PrepareOllamaModels 6000000000; echo "MODELS=\${OLLAMA_MODELS:-unset}" ;;
  recorded)   mkdir -p "$WORK/studiomodels"
              CfgSet ollamaModels "$WORK/studiomodels"
              rmdir "$WORK/studiomodels"   # the recorded folder is gone: recreation is part of the contract
              PrepareOllamaModels 6000000000; echo "MODELS=\${OLLAMA_MODELS:-unset} recreated=$([ -d "$WORK/studiomodels" ] && echo yes)" ;;
  userenv)    OLLAMA_MODELS="$WORK/usermodels"; PrepareOllamaModels 6000000000; echo "MODELS=\${OLLAMA_MODELS}" ;;
  relocate)   mkdir -p "$WORK/bin"
              cat > "$WORK/bin/df" <<'DF'
#!/usr/bin/env bash
p="\${*: -1}"
case "\$p" in
  *"\$FAKE_HOME_PREFIX"*) dev="/dev/fakehome"; avail=1000 ;;
  *)              dev="/dev/fakestudio"; avail=40000000000 ;;
esac
case "\$*" in
  *--output=avail*) echo "Avail"; echo "\$avail" ;;
  *) echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "$dev 1 1 1 100% /" ;;
esac
DF
              export FAKE_HOME_PREFIX="$HOME"
              chmod +x "$WORK/bin/df"; PATH="$WORK/bin:$PATH"
              PrepareOllamaModels 9300000000
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "PATHS=$(cat "$CFGF" 2>/dev/null)" ;;
  moveyes)    ollama_with_models
              export HOME_AVAIL=1000 STUDIO_AVAIL=40000000000 FAKE_HOME_PREFIX="$HOME"; fake_df
              PrepareOllamaModels 6000000000
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "BLOBS=$(ls "$RT/models/ollama/blobs" 2>/dev/null)"
              echo "MANIFEST=$(cat "$RT/models/ollama/manifests/latest" 2>/dev/null)"
              echo "SRC=$([ -e "$HOME/.ollama/models" ] && echo kept || echo gone)"
              echo "STAGE=$(ls -A "$RT/models" 2>/dev/null)"
              echo "CFG=$(tr -d ' \n' < "$CFGF" 2>/dev/null)" ;;
  moveno)     ollama_with_models
              export HOME_AVAIL=1000 STUDIO_AVAIL=40000000000 FAKE_HOME_PREFIX="$HOME"; fake_df
              PrepareOllamaModels 6000000000
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "SRC=$([ -e "$HOME/.ollama/models" ] && echo kept || echo gone)" ;;
  moveunatt)  ollama_with_models
              export HOME_AVAIL=1000 STUDIO_AVAIL=40000000000 FAKE_HOME_PREFIX="$HOME"; fake_df
              PrepareOllamaModels 6000000000
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "SRC=$([ -e "$HOME/.ollama/models" ] && echo kept || echo gone)" ;;
  movecorrupt) ollama_with_models   # blob whose bytes no longer match the checksum its name carries
              printf 'tampered' > "$HOME/.ollama/models/blobs/sha256-$(cat "$WORK/blob-sha")"
              export HOME_AVAIL=1000 STUDIO_AVAIL=40000000000 FAKE_HOME_PREFIX="$HOME"; fake_df
              PrepareOllamaModels 6000000000
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "SRC=$([ -e "$HOME/.ollama/models" ] && echo kept || echo gone)"
              echo "STAGE=$(ls -A "$RT/models" 2>/dev/null)" ;;
  movefull)   ollama_with_models   # studio drive cannot fit the models plus the download: no offer
              export HOME_AVAIL=1000 STUDIO_AVAIL=900 FAKE_HOME_PREFIX="$HOME"; fake_df
              PrepareOllamaModels 6000000000
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "SRC=$([ -e "$HOME/.ollama/models" ] && echo kept || echo gone)" ;;
  dfunknown)  mkdir -p "$WORK/bin"
              cat > "$WORK/bin/df" <<'DF'
#!/usr/bin/env bash
case "$*" in
  *--output=avail*) exit 1 ;;
esac
p="\${*: -1}"
case "\$p" in
  *"\$FAKE_HOME_PREFIX"*) dev="/dev/fakehome" ;;
  *)                     dev="/dev/fakestudio" ;;
esac
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "$dev 1 1 1 100% /"
DF
              export FAKE_HOME_PREFIX="$HOME"
              chmod +x "$WORK/bin/df"; PATH="$WORK/bin:$PATH"
              PrepareOllamaModels 9300000000 2> "$WORK/err.txt"
              echo "rc=$?"; echo "ERR=$(cat "$WORK/err.txt")"
              echo "MODELS=\${OLLAMA_MODELS:-unset}"
              echo "PATHS=$(cat "$CFGF" 2>/dev/null)" ;;
esac
`;

const run = (env = {}, input) => {
  const work = mkdtempSync(path.join(tmpdir(), 'imaginarium-t22-'));
  const scriptFile = path.join(work, 'harness.sh');
  writeFileSync(scriptFile, SCRIPT);
  const r = spawnSync('bash', [scriptFile], {
    encoding: 'utf8', timeout: 60000, input,
    env: { ...process.env, WORK: work, NODE: process.execPath, ...env },
  });
  return { ...r, work };
};

test('modelBytes reads the expected size from the installer manifest (empty for unknown names)', () => {
  const r = run({ CASE: 'modelbytes' });
  assert.match(r.stdout, /MB\[9300000000\]\[6100000000\]\[\]/, r.stdout + r.stderr);
  rmSync(r.work, { recursive: true, force: true });
});

test('a server that already answers decides storage - the installer does not pretend otherwise', () => {
  const r = run({ CASE: 'serverup' });
  assert.match(r.stdout, /an Ollama server is already running - models land where that server stores them/);
  assert.doesNotMatch(r.stdout, /OLLAMA_MODELS=/);
  rmSync(r.work, { recursive: true, force: true });
});

test('same drive and no existing models: usual Ollama folder, nothing written, nothing exported', () => {
  const r = run({ CASE: 'same' });
  assert.match(r.stdout, /models download to Ollama's usual folder \(.+\/\.ollama\/models\)/);
  assert.match(r.stdout, /MODELS=unset/);
  assert.match(r.stdout, /clean/);
  rmSync(r.work, { recursive: true, force: true });
});

test('models that already exist are never hidden or switched - only kept (T1-3)', () => {
  const r = run({ CASE: 'have' });
  assert.match(r.stdout, /you already have models in .+\.ollama\/models \(.+ used\) - they stay exactly where they are, nothing is hidden; moving them to the studio's drive would free that much/);
  assert.match(r.stdout, /MODELS=unset/);
  rmSync(r.work, { recursive: true, force: true });
});

// The ticket-22 extension (0.7.9 fold wave ticket 60 item 3, the 0.7.8 note): when the drive
// under the existing models is short and the studio's drive has room, the move is OFFERED -
// interactively only, verified file by file before any original goes away.
test('short drive + room at the studio: the move is offered, a yes copies, verifies, deletes, records', () => {
  // (a prompt on a piped stdin is not echoed by bash - the proof the offer was made is that the
  //  answered 'y' was CONSUMED: the move happened, so the fallback sentence must not appear)
  const r = run({ CASE: 'moveyes' }, 'y\n');
  assert.match(r.stdout, /models moved to .+runtime\/models\/ollama - every file verified/);
  assert.doesNotMatch(r.stdout, /you already have models in/, 'the yes was asked and heard');
  assert.match(r.stdout, /restart it pointing at OLLAMA_MODELS=/, 'a self-run ollama serve is warned about');
  assert.match(r.stdout, /BLOBS=sha256-[0-9a-f]{64}/, 'the blob arrived under its checksum name');
  assert.match(r.stdout, /MANIFEST=\{"model":"x"\}/, 'the manifest arrived with its bytes');
  assert.match(r.stdout, /SRC=gone/, 'the originals went only after the verified copy');
  assert.match(r.stdout, /STAGE=ollama\s*$/m, 'no staging folder was left behind');
  assert.match(r.stdout, /MODELS=\S+models\/ollama/, 'and this run already uses the new home');
  assert.match(r.stdout, /CFG=.*"ollamaModels"/, 'config/paths.json records it (the studio serve reads it)');
  rmSync(r.work, { recursive: true, force: true });
});

test('a declined offer changes nothing - the ticket-22 keep sentence stays the answer', () => {
  const r = run({ CASE: 'moveno' }, 'n\n');
  assert.match(r.stdout, /you already have models in .+\.ollama\/models \(.+ used\) - they stay exactly where they are/);
  assert.match(r.stdout, /MODELS=unset/);
  assert.match(r.stdout, /SRC=kept/);
  rmSync(r.work, { recursive: true, force: true });
});

test('an unattended run (-Yes) never sees the question - placement is never moved behind a job', () => {
  // a 'y' line is available and must never be read: -Yes answers the default (no) itself
  const r = run({ CASE: 'moveunatt', ASK_YES: '1' }, 'y\n');
  assert.match(r.stdout, /you already have models in/);
  assert.match(r.stdout, /MODELS=unset/);
  assert.match(r.stdout, /SRC=kept/);
  rmSync(r.work, { recursive: true, force: true });
});

test('a blob that cannot confirm its own name-checksum stops the move before any original is touched', () => {
  const r = run({ CASE: 'movecorrupt' }, 'y\n');
  assert.match(r.stdout, /failed verification - the copy is discarded, the originals are not touched/);
  assert.match(r.stdout, /you already have models in/, 'the honest fallback sentence follows');
  assert.match(r.stdout, /MODELS=unset/);
  assert.match(r.stdout, /SRC=kept/);
  assert.doesNotMatch(r.stdout, /STAGE=.*tmp-/, 'the discarded copy leaves no staging folder behind');
  rmSync(r.work, { recursive: true, force: true });
});

test('a studio drive that cannot fit the models plus the download ahead is offered nothing', () => {
  // input offers a 'y' nobody will ask for: if the short-circuit failed, this WOULD move - SRC=kept
  const r = run({ CASE: 'movefull' }, 'y\n');
  assert.match(r.stdout, /you already have models in/);
  assert.match(r.stdout, /MODELS=unset/);
  assert.match(r.stdout, /SRC=kept/);
  rmSync(r.work, { recursive: true, force: true });
});

test('a placement recorded in config/paths.json is reused - and the folder recreated if lost', () => {
  const r = run({ CASE: 'recorded' });
  assert.match(r.stdout, /models go to the studio folder from config\/paths\.json/);
  assert.match(r.stdout, /MODELS=\S+studiomodels recreated=yes/);
  rmSync(r.work, { recursive: true, force: true });
});

test('the user-set OLLAMA_MODELS always wins', () => {
  const r = run({ CASE: 'userenv' });
  assert.match(r.stdout, /keeping your OLLAMA_MODELS \(models live under .+usermodels\)/);
  assert.match(r.stdout, /MODELS=\S+usermodels/);
  rmSync(r.work, { recursive: true, force: true });
});

test('short system drive + room on the studio drive: placed, recorded, exported', () => {
  const r = run({ CASE: 'relocate' });
  assert.match(r.stdout, /the system drive is short on space - models go under the studio instead/);
  assert.match(r.stdout, /MODELS=\S+runtime\/models\/ollama/);
  const paths = JSON.parse(/PATHS=\{[\s\S]*\}/.exec(r.stdout)[0].slice('PATHS='.length));
  assert.match(paths.ollamaModels, /runtime\/models\/ollama$/, 'the recorded key is the studio folder (server/ollama-run.mjs reads the same key)');
  rmSync(r.work, { recursive: true, force: true });
});

test('an unreadable free-space reading never fakes a short drive: no relocation, no error (ticket 33)', () => {
  const r = run({ CASE: 'dfunknown' });
  assert.match(r.stdout, /rc=0/, r.stdout + r.stderr);
  assert.match(r.stdout, /ERR=$/m, 'bash stayed silent: no integer-expression test error, no missing helper');
  assert.match(r.stdout, /MODELS=unset/, 'unknown free space must not relocate the user\'s models');
  assert.match(r.stdout, /PATHS=$/m, 'and nothing is written to config');
  assert.match(r.stdout, /usual folder/, 'the ordinary placement message still runs');
  rmSync(r.work, { recursive: true, force: true });
});
