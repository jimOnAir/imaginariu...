// Ticket 36 (0.6.18 wave): install resilience. Three folds — PullModel retries ×3 (0.6.13),
// the NVIDIA driver second source + honest unknown (0.6.14), and the old-Ollama-on-the-port
// diagnosis instead of a loop (0.6.18). The bash functions are extracted from installer/install.sh
// verbatim and driven with stubs; the scan facts run as pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_ROOT, MIN_NVIDIA_DRIVER, nvidiaDriverFacts, p3Scan } from '../installer/af_scan.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const INSTALL = readFileSync(path.join(REPO, 'installer', 'install.sh'), 'utf8');
function fn(name) {
  const lines = INSTALL.split('\n');
  const a = lines.findIndex((l) => l.startsWith(name + '()'));
  if (a < 0) throw new Error(name + ' moved');
  let b = a; while (lines[b] !== '}') b++;
  return lines.slice(a, b + 1).join('\n');
}

// ---------- af_scan: nvidiaDriverFacts ----------
const PROC_OK = 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  575.57.08  Tue Jul  1 00:00:00 UTC 2025\nGCC version:  gcc version 12.4.0\n';

test('nvidiaDriverFacts: nvidia-smi stays the primary source', () => {
  const f = nvidiaDriverFacts('615.71.09', '');
  assert.deepEqual(f, { driver: '615.71.09', driverMajor: 615, driverOld: false, driverUnknown: false });
  assert.equal(nvidiaDriverFacts('550.54.14', '').driverOld, true);
});

test('nvidiaDriverFacts: [N/A] from nvidia-smi falls through to the /proc kernel module line (0.6.14)', () => {
  const f = nvidiaDriverFacts('[N/A]', PROC_OK);
  assert.equal(f.driver, '575.57.08');
  assert.equal(f.driverMajor, 575);
  assert.equal(f.driverOld, false);
  assert.equal(f.driverUnknown, false);
  assert.equal(nvidiaDriverFacts('', PROC_OK).driver, '575.57.08');
  assert.equal(nvidiaDriverFacts('', PROC_OK).driverOld, false, '575 passes the 570 floor');
  assert.equal(nvidiaDriverFacts('[N/A]', PROC_OK.replace('575.57.08', '550.54.14')).driverOld, true, MIN_NVIDIA_DRIVER + ' floor applies to the fallback too');
});

test('nvidiaDriverFacts: both sources silent = UNKNOWN, stated as such, never old, never new', () => {
  const f = nvidiaDriverFacts('[N/A]', '');
  assert.equal(f.driver, '');
  assert.equal(f.driverOld, false);
  assert.equal(f.driverUnknown, true);
});

// ---------- p3Scan: the unknown driver is said, not hidden ----------
function mkS(over = {}) {
  const man = JSON.parse(readFileSync(path.join(APP_ROOT, 'installer', 'manifest.json'), 'utf8'));
  const miss = { st: 'missing', where: '' };
  return {
    root: APP_ROOT, rt: path.join(APP_ROOT, 'runtime'), man, env: {}, cfg: {}, noGpu: false, gpu: 'NVIDIA GeForce RTX 4070', vram: 12288, cc: '8.9', gpuBroken: '', adapters: [],
    node: '', nodeVer: '', npmDeps: false, ui: false, blender: '', blenderVer: '',
    comfy: '', comfyVer: '', comfyDeps: false, gguf: false, godot: '', godotVer: '', clips: 0, library: '/l',
    vfxDir: '/v', vfxOk: false, ollama: '', llms: [], vlm: false,
    hy2: miss, hymv: miss, hy21: miss, hy2mini: miss, sdxl: miss, u2net: miss, flux2: miss, qwenimg: miss, qwenedit: miss,
    free: 200e9, ...over,
  };
}

test('p3Scan with an unreadable driver keeps the offer but says so plainly', () => {
  const s = mkS({ driverUnknown: true });
  const r = p3Scan(s);
  assert.equal(r.offer, true, 'unknown is not a refusal');
  assert.match(r.warn, /driver version could not be read/);
  assert.match(r.warn, new RegExp(String(MIN_NVIDIA_DRIVER)));
});

test('p3Scan with a readable current driver keeps its warning surface clean', () => {
  const r = p3Scan(mkS({ driver: '615.71.09', driverMajor: 615, driverOld: false, driverUnknown: false }));
  assert.equal(r.warn, '');
});

test('scanComponents wires /proc as the second source with the test seam', () => {
  const src = readFileSync(path.join(REPO, 'installer', 'af_scan.mjs'), 'utf8');
  assert.match(src, /ASTRA_NVIDIA_VERSION_FILE \|\| '\/proc\/driver\/nvidia\/version'/);
  assert.match(src, /Object\.assign\(s, nvidiaDriverFacts\(parts\[3\], procText\)\)/);
});

// ---------- install.sh bash lane ----------
const SCRIPT = `
set -u
OllamaMinVersion='0.12.7'
S_OLLAMA=/bin/true
say() { echo "SAY: $1"; }
Run() { say "    $2"; echo "RUN[$3 $4]"; [ "$PULL_OK_AT" = "" ] && return 7; CNT=$(($(cat "$CNTF"))); CNT=$((CNT+1)); echo "$CNT" > "$CNTF"; [ "$CNT" -ge "$PULL_OK_AT" ] && return 0; return 7; }
PrepareOllamaModels() { :; }
modelBytes() { echo 6000000000; }
sleep() { :; }
${fn('OllamaVersionAtFloor')}
${fn('EnsureOllama')}
${fn('PullModel')}
case "$CASE" in
  floor) OllamaVersionAtFloor 0.12.6 && echo BAD1; OllamaVersionAtFloor 0.12.7 || echo BAD2; OllamaVersionAtFloor 0.13.0 || echo BAD3; OllamaVersionAtFloor '' && echo BAD4 ;;
  oldsrv) curl() { echo '{"version":"0.11.4"}'; }; PullModel qwen3:8b; echo "rc=$?" ;;
  newsrv) curl() { echo '{"version":"0.12.7"}'; }; S_OLLAMA=/bin/false CNTF="$CNTF" PULL_OK_AT=3; PullModel qwen3:8b; echo "rc=$?" ;;
  pullfail) curl() { echo '{"version":"0.13.1"}'; }; S_OLLAMA=/bin/false CNTF="$CNTF" PULL_OK_AT=99; PullModel qwen3:8b; echo "rc=$?" ;;
esac
`;

function bash(caseName, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 't36-'));
  const cntf = path.join(dir, 'cnt');
  writeFileSync(cntf, '0');
  const r = spawnSync('bash', ['-c', `CASE=${caseName} CNTF=${cntf} ${extra.env || ''}\n${SCRIPT}`], { encoding: 'utf8', timeout: 30000 });
  rmSync(dir, { recursive: true, force: true });
  return { out: r.stdout + r.stderr, code: r.status };
}

test('OllamaVersionAtFloor is a real version compare at the 0.12.7 floor', () => {
  const r = bash('floor');
  assert.equal(r.out, '');
});

test('0.6.18: an OLD server on 11434 is named once, honestly, and the step stops (no loop)', () => {
  const r = bash('oldsrv');
  assert.match(r.out, /Port 11434 is answered by an OLD Ollama \(server 0\.11\.4, below 0\.12\.7\)/);
  assert.match(r.out, /systemctl restart ollama/);
  assert.match(r.out, /rc=1/);
  assert.ok(!/RUN\[pull/.test(r.out), 'never pulls against the old server');
  assert.equal((r.out.match(/Port 11434/g) || []).length, 1, 'the cause is named once, not looped');
});

test('0.6.13: a dropped pull retries up to 3 attempts and the success lands (attempt line present)', () => {
  const r = bash('newsrv');
  assert.match(r.out, /downloading model qwen3:8b \(attempt 1 of 3\)/);
  assert.match(r.out, /attempt 1 failed .* retrying, the download resumes/);
  assert.match(r.out, /downloading model qwen3:8b \(attempt 3 of 3\)/);
  assert.match(r.out, /rc=0/);
  assert.equal((r.out.match(/attempt . of 3/g) || []).length, 3, 'exactly three attempts');
});

test('after three failed attempts the give-up line is honest and rc survives', () => {
  const r = bash('pullfail');
  assert.equal((r.out.match(/RUN\[pull qwen3:8b\]/g) || []).length, 3);
  assert.match(r.out, /could not be downloaded after 3 attempts/);
  assert.match(r.out, /rc=7/, 'the real ollama exit code surfaces');
});
