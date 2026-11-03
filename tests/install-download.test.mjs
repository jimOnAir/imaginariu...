// Download core of the Linux installers (installer/af_download.sh, sourced by install.sh):
// mirror fallthrough with checksum verification, resume after a cut connection, clean restart for
// hosts without resume (code 33), bad-checksum files deleted and never used, the plain-language
// reason + the exact curl text in the log, ##PROGRESS lines for the unattended frontend, and the
// uv network retries. The non-win32 sibling of the reference tests/install-download.test.mjs -
// same ASTRA_INSTALL_CURL fake-curl harness; the Windows code-35/--ssl-no-revoke flip has no Linux
// twin here (curl uses OpenSSL, which never asks about revoked certificates), so code 35 is
// asserted as an ordinary flaky-TLS retry instead.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.join(HERE, '..', 'installer', 'install.sh');
const tmp = mkdtempSync(path.join(tmpdir(), 'af-dl-'));
const PAYLOAD_SHA = '239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5'; // sha256 of 'payload'
after(() => rmSync(tmp, { recursive: true, force: true }));

// fake curl (like the reference harness): one mjs per mode + a .sh wrapper pointed at by ASTRA_INSTALL_CURL
function fakeCurl(mode, stateDir) {
  const js = path.join(tmp, `fake-curl-${mode}.mjs`);
  const sh = path.join(tmp, `fake-curl-${mode}.sh`);
  writeFileSync(js, `import fs from 'node:fs';
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const out = opt('-o'), err = opt('--stderr'), url = a[a.length - 1];
const resume = a.includes('-C');
const log = ${JSON.stringify(path.join(stateDir, 'calls.txt'))};
fs.appendFileSync(log, JSON.stringify({ url, resume }) + '\\n');
const mode = ${JSON.stringify(mode)};
const say = (t) => { if (err) fs.writeFileSync(err, t); };
const st = ${JSON.stringify(path.join(stateDir, mode + '.cnt'))};
const n = fs.existsSync(st) ? +fs.readFileSync(st) + 1 : 1;
fs.writeFileSync(st, String(n));
if (mode === 'mirror_ok') {
  if (url.includes('primary.test')) { say('fake: primary is down'); process.exit(7); }
  fs.writeFileSync(out, 'payload'); process.exit(0);
}
if (mode === 'cut56') {
  if (n === 1) { fs.writeFileSync(out, 'A'.repeat(10)); say('curl: (56) Recv failure: Connection reset by peer'); process.exit(56); }
  if (!resume) { say('fake: resumed run must pass -C'); process.exit(99); }
  fs.appendFileSync(out, 'B'.repeat(10)); process.exit(0);
}
if (mode === 'noresume33') {
  if (n === 1) { fs.writeFileSync(out, 'PARTIAL'); say('curl: (33) HTTP server does not seem to support byte ranges'); process.exit(33); }
  if (resume) { say('fake: a no-resume host must get a clean restart'); process.exit(99); }
  fs.writeFileSync(out, 'FULL'); process.exit(0);
}
if (mode === 'badsha') { fs.writeFileSync(out, 'wrong-bytes'); process.exit(0); }
if (mode === 'fail6') { say('curl: (6) Could not resolve host: dead.test'); process.exit(6); }
if (mode === 'always35') {
  if (a.includes('--ssl-no-revoke')) { say('fake: Linux curl must not get --ssl-no-revoke'); process.exit(98); }
  say('curl: (35) SSL connect error'); process.exit(35);
}
if (mode === 'progress') {
  fs.writeFileSync(out, 'x'.repeat(5e6));
  const t0 = Date.now(); while (Date.now() - t0 < 3000) { /* slow link */ }
  fs.writeFileSync(out, 'x'.repeat(10e6)); process.exit(0);
}
process.exit(0);`);
  writeFileSync(sh, `#!/usr/bin/env bash\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

// run a snippet with install.sh sourced (functions only - the start section returns when sourced)
function inCore(mode, snippet, opts = {}) {
  const stateDir = path.join(tmp, `state-${mode}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, 'install.log');
  const curl = fakeCurl(mode, stateDir);
  const script = `
    say() { printf '%s\\n' "$1"; printf '%s\\n' "$1" >>"$LOG"; }
    source ${JSON.stringify(INSTALL_SH)}
    LOG=${JSON.stringify(logFile)}
    ${snippet}
  `;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ASTRA_INSTALL_CURL: curl, ASTRA_INSTALL_NO_GPU: '', ...(opts.env || {}) },
  });
  const calls = existsSync(path.join(stateDir, 'calls.txt'))
    ? readFileSync(path.join(stateDir, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { stdout: r.stdout, stderr: r.stderr, code: r.status, calls, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}

test('dead primary falls through to the mirror, checksum verified on whichever site answered', () => {
  const dst = path.join(tmp, 'mirror-ok', 'file.bin');
  const r = inCore('mirror_ok', `DownloadMirrors ${JSON.stringify(dst)} 7 ${JSON.stringify(PAYLOAD_SHA)} ${JSON.stringify('https://primary.test/file.bin')} ${JSON.stringify('https://mirror1.test/file.bin')} && echo RC=$?`);
  assert.match(r.stdout, /RC=0/, r.log + r.stderr);
  assert.equal(readFileSync(dst, 'utf8'), 'payload');
  assert.deepEqual(r.calls.map((c) => c.url),
    ['https://primary.test/file.bin', 'https://primary.test/file.bin', 'https://primary.test/file.bin', 'https://primary.test/file.bin',
     'https://mirror1.test/file.bin'], 'four tries on the dead primary, then the mirror');
  assert.match(r.log, /using the backup mirror 2 of 2/);
});

test('all mirrors dead: every URL is tried and the summary names the count', () => {
  const r6 = inCore('fail6', `DownloadMirrors ${JSON.stringify(path.join(tmp, 'y-none.bin'))} 0 '' https://dead.test/a https://dead2.test/a; echo RC=$?`);
  assert.equal(r6.calls.length, 8, '4 tries per mirror'); // 2 mirrors x 4 resume tries
  assert.match(r6.log, /none of the 2 mirrors answered/);
  assert.match(r6.log, /curl code 6 - the site address was not found/);
});

test('killed connection resumes from the byte offset (-C -) and completes the file', () => {
  const dst = path.join(tmp, 'cut', 'big.bin');
  const r = inCore('cut56', `Download ${JSON.stringify('https://files.test/big.bin')} ${JSON.stringify(dst)} 20; echo RC=$?`);
  assert.match(r.stdout, /RC=0/, r.log);
  assert.equal(readFileSync(dst, 'utf8'), 'A'.repeat(10) + 'B'.repeat(10));
  assert.equal(r.calls[0].resume, false);
  assert.equal(r.calls[1].resume, true);
  assert.match(r.log, /connection dropped \(code 56 - the connection dropped while receiving data\)[\s\S]*continuing from the same place, try 2 of 4/);
});

test('a host that cannot continue from the break point (code 33) gets a clean restart', () => {
  const dst = path.join(tmp, 'noreturn', 'clips.glb');
  const r = inCore('noresume33', `Download ${JSON.stringify('https://actionforge.app/clips.glb')} ${JSON.stringify(dst)}; echo RC=$?`);
  assert.match(r.stdout, /RC=0/, r.log);
  assert.equal(readFileSync(dst, 'utf8'), 'FULL');
  assert.equal(r.calls[1].resume, false, 'the partial file must be deleted before the retry');
  assert.match(r.log, /the site cannot continue a download from the break point \(code 33\)[\s\S]*from the start, try 2 of 4/);
});

test('checksum mismatch: the existing file and a bad fresh download are both deleted, never kept', () => {
  const dst = path.join(tmp, 'sha', 'model.safetensors');
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, 'wrong-bytes');                 // same size, other content
  const good = PAYLOAD_SHA;
  const r = inCore('badsha', `DownloadChecked ${JSON.stringify('https://hf.test/model.safetensors')} ${JSON.stringify(dst)} 11 ${good}; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.match(r.log, /does not match the checksum - downloading again/);
  assert.match(r.log, /downloaded incorrectly \(size or sha256 mismatch\)/);
  assert.ok(!existsSync(dst), 'a file that fails the checksum must not stay around');
  assert.equal(r.calls.length, 1);                   // one redownload attempt, then stop
});

test('the log gets a plain-language reason and the exact curl text in one quotable line', () => {
  const r = inCore('fail6', `Download ${JSON.stringify('https://dead.test/x.zip')} ${JSON.stringify(path.join(tmp, 'z.bin'))}; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.match(r.log, /Download failed: https:\/\/dead\.test\/x\.zip \(curl code 6 - the site address was not found: no internet or DNS is not answering; curl: curl: \(6\) Could not resolve host: dead\.test\)\. Run the installer again - the download will resume\./);
});

test('code 35 on Linux is a flaky-TLS resume case, no Windows --ssl-no-revoke flag is ever passed', () => {
  const r = inCore('always35', `Download ${JSON.stringify('https://proxy.test/x.zip')} ${JSON.stringify(path.join(tmp, 't.bin'))}; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.equal(r.calls.length, 4, '35 retries within the connection-drop set');
  assert.match(r.log, /curl code 35 - the secure connection was not established/);
});

test('unattended downloads emit ##PROGRESS lines for the calling frontend', () => {
  const r = inCore('progress', `Download ${JSON.stringify('https://slow.test/big.tgz')} ${JSON.stringify(path.join(tmp, 'p.tgz'))} 10000000; echo RC=$?`,
    { env: { ASTRA_UNATTENDED: '1' } });
  assert.match(r.stdout, /RC=0/, r.log);
  assert.match(r.stdout, /##PROGRESS \d+\|downloaded \d+ MB of 10 MB/);
});

// fake uv: counts invocations, fails with network or non-network text per mode
function fakeUv(mode, stateDir) {
  const sh = path.join(tmp, `fake-uv-${mode}-${path.basename(stateDir)}.sh`);
  writeFileSync(sh, `#!/usr/bin/env bash
n=$(cat "${stateDir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${stateDir}/n"
case "${mode}" in
  net2ok)  if [ "$n" -lt 3 ]; then echo "error: Failed to fetch 'torch'"; echo "  Caused by: operation timed out"; exit 1; fi; exit 0 ;;
  netalways) echo "error: Failed to download index"; echo "  Caused by: connection reset by peer"; exit 1 ;;
  nonet)   echo "error: invalid lock file format"; exit 1 ;;
esac
`);
  chmodSync(sh, 0o755);
  return sh;
}
function inUv(mode, tries) {
  const stateDir = path.join(tmp, `uv-${mode}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });
  const uv = fakeUv(mode, stateDir);
  const r = spawnSync('bash', ['-c', `
    say() { printf '%s\\n' "$1"; }
    source ${JSON.stringify(INSTALL_SH)}
    UvTry 'PyTorch' ${tries} ${JSON.stringify(uv)} pip install torch; echo RC=$?
  `], { encoding: 'utf8', timeout: 120000, env: { ...process.env, ASTRA_UV_WAIT: '0' } });
  const calls = existsSync(path.join(stateDir, 'n')) ? +readFileSync(path.join(stateDir, 'n'), 'utf8') : 0;
  return { stdout: r.stdout, calls };
}

test('uv network failures get retried with the error line and the package-server advice', () => {
  const ok = inUv('net2ok', 3);
  assert.equal(ok.calls, 3);
  assert.match(ok.stdout, /RC=0/);
  assert.match(ok.stdout, /the network faltered[\s\S]*try 2 of 3/);
  const dead = inUv('netalways', 3);
  assert.equal(dead.calls, 3);
  assert.match(dead.stdout, /PyTorch - failed \(code 1\): error: Failed to download index · Caused by: connection reset by peer\./);
  assert.match(dead.stdout, /download\.pytorch\.org, pypi\.org/);
  assert.match(dead.stdout, /not downloaded a second time/);
});

test('a non-network uv error is not retried', () => {
  const r = inUv('nonet', 3);
  assert.equal(r.calls, 1);
  assert.match(r.stdout, /PyTorch - failed \(code 1\): error: invalid lock file format\./);
  assert.doesNotMatch(r.stdout, /pytorch\.org/);
});

test('manifest mirrors are rewritten from the pinned Windows archive to this Linux one', () => {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(INSTALL_SH)}; ManifestMirrors node node-v22.23.3-linux-x64.tar.xz; ManifestMirrors blender blender-5.0.1-linux-x64.tar.xz`],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const urls = r.stdout.trim().split('\n');
  assert.equal(urls.length, 13, r.stdout); // node: primary + 4 mirrors; blender: primary + 7 mirrors of the blender.org release folder
  assert.ok(urls.some((u) => u.startsWith('https://nodejs.org/dist/') && u.endsWith('linux-x64.tar.xz')));
  assert.ok(urls.some((u) => u.startsWith('https://download.blender.org/') && u.endsWith('linux-x64.tar.xz')));
  assert.ok(!urls.some((u) => /win-x64|windows/.test(u)), 'no Windows archives left in the list');
});

// ---------------------------------------------------------------- the 0.4.15 Ollama gate (Linux form)
// Windows: the installer runs OllamaSetup.exe only with a valid 'Ollama Inc.' Authenticode
// signature. Linux runs no installers: the release archive is installed only after its sha256
// matches the vendor's sha256sum.txt from the same https release - and it is never executed.
function tinyOllamaArchive(name) {
  const dir = path.join(tmp, name);
  const stage = path.join(dir, 'stage');
  mkdirSync(path.join(stage, 'bin'), { recursive: true });
  writeFileSync(path.join(stage, 'bin', 'ollama'), '#!/bin/sh\necho ollama-stub-must-not-run\n');
  chmodSync(path.join(stage, 'bin', 'ollama'), 0o755);
  const tgz = path.join(dir, 'ollama-linux-amd64.tar.zst');
  const r = spawnSync('tar', ['--zstd', '-cf', tgz, '-C', stage, 'bin']);
  if (r.status !== 0) return null;                                   // no zstd here: the test skips
  const sha = spawnSync('sha256sum', [tgz], { encoding: 'utf8' }).stdout.split(' ')[0];
  return { tgz, sha };
}

function fakeOllamaCurl(stateDir) {
  const js = path.join(tmp, 'fake-ollama-curl.mjs');
  const sh = path.join(tmp, 'fake-ollama-curl.sh');
  writeFileSync(js, `import fs from 'node:fs';
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const out = opt('-o'), url = a[a.length - 1];
fs.appendFileSync(${JSON.stringify(path.join(stateDir, 'calls.txt'))}, url + '\\n');
if (url.endsWith('sha256sum.txt')) {
  fs.writeFileSync(out, process.env.AF_SHA + '  ./ollama-linux-amd64.tar.zst\\n');
  process.exit(0);
}
if (url.endsWith('.tar.zst')) {
  if (process.env.AF_TAMPER === '1') fs.writeFileSync(out, 'tampered-bytes');
  else fs.writeFileSync(out, fs.readFileSync(process.env.AF_TGZ));
  process.exit(0);
}
process.exit(22);`);
  writeFileSync(sh, `#!/usr/bin/env bash\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

function runInstallOllama({ tamper = false, seed = null } = {}) {
  const art = tinyOllamaArchive(`ol-${tamper}-${Math.random().toString(36).slice(2)}`);
  if (!art) return null;
  const base = path.join(tmp, `olrun-${Math.random().toString(36).slice(2)}`);
  const rt = path.join(base, 'runtime'); const dl = path.join(base, 'downloads'); const cfg = path.join(base, 'config', 'paths.json');
  mkdirSync(dl, { recursive: true }); mkdirSync(path.dirname(cfg), { recursive: true });
  if (seed) writeFileSync(path.join(dl, 'ollama-linux-amd64.tar.zst'), seed);
  const logFile = path.join(base, 'install.log');
  const r = spawnSync('bash', ['-c', `
    say() { printf '%s\\n' "$1"; printf '%s\\n' "$1" >>"$LOG"; }
    source ${JSON.stringify(INSTALL_SH)}
    RT=${JSON.stringify(rt)} DL=${JSON.stringify(dl)} CFGF=${JSON.stringify(cfg)} LOG=${JSON.stringify(logFile)}
    InstallOllama; echo RC=$?
  `], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ASTRA_INSTALL_CURL: fakeOllamaCurl(base), ASTRA_INSTALL_NO_OLLAMA: '1',
      AF_SHA: art.sha, AF_TGZ: art.tgz, AF_TAMPER: tamper ? '1' : '' },
  });
  return { r, rt, dl, cfg, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}

test('Ollama gate: a tampered archive is refused (cached and fresh), deleted, never extracted or run', () => {
  const run = runInstallOllama({ tamper: true, seed: 'cached-evil' });
  if (!run) return;
  assert.match(run.r.stdout, /RC=1/);
  assert.match(run.log, /does not match the checksum - downloading again/, 'the tampered cached file triggers a redownload');
  assert.match(run.log, /The Ollama archive did not match the release checksum/);
  assert.ok(!existsSync(path.join(run.dl, 'ollama-linux-amd64.tar.zst')), 'the bad archive is deleted');
  assert.ok(!existsSync(run.rt), 'nothing is extracted');
  assert.doesNotMatch(run.r.stdout + run.log, /ollama-stub/, 'the archive content is never executed');
});

test('Ollama gate: the verified archive installs into runtime/ollama and the config points at it', () => {
  const run = runInstallOllama();
  if (!run) return;
  assert.match(run.r.stdout, /RC=0/, run.log);
  assert.ok(existsSync(path.join(run.rt, 'ollama', 'bin', 'ollama')), 'extracted');
  assert.match(run.log, /checksum of the official release matched/);
  assert.doesNotMatch(run.r.stdout + run.log, /ollama-stub/, 'the binary is installed, not executed');
  assert.match(readFileSync(run.cfg, 'utf8'), /runtime\/ollama\/bin\/ollama/);
});
