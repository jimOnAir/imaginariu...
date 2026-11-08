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
if (mode === 'empty_ok') { fs.writeFileSync(out, ''); process.exit(0); }   // curl "succeeds" with an empty file
if (mode === 'hf_fallback') {
  if (url.includes('huggingface.co')) { say('fake: huggingface.co drops the connection'); process.exit(7); }
  if (url.includes('hf-mirror.com')) { fs.writeFileSync(out, 'payload'); process.exit(0); }
  say('fake: unexpected host ' + url); process.exit(22);
}
if (mode === 'damaged_once') {
  if (n === 1) { fs.writeFileSync(out, 'corrupt-on-the-wire'); process.exit(0); }
  fs.writeFileSync(out, 'payload'); process.exit(0);
}
if (mode === 'fail6') { say('curl: (6) Could not resolve host: dead.test'); process.exit(6); }
if (mode === 'always35') {
  if (a.includes('--ssl-no-revoke')) { say('fake: Linux curl must not get --ssl-no-revoke'); process.exit(98); }
  say('curl: (35) SSL connect error'); process.exit(35);
}
if (mode === 'vanished') { process.exit(0); } // "success" - but the antivirus ate the file before the move
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
  assert.match(r.log, /downloaded damaged \(size or sha256 mismatch\) - downloading it once more from the start/, 'ticket 16: the damaged file gets ONE full re-download');
  assert.match(r.log, /file model\.safetensors downloaded damaged \(size or sha256 mismatch\); removed - run the installer again/, 'second failure: named line');
  assert.ok(!existsSync(dst), 'a file that fails the checksum must not stay around');
  assert.equal(r.calls.length, 2);                   // the redownload plus the one from-scratch retry, then stop
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

test('a downloaded file eaten before it lands gets exclusion advice, never a raw mv error', () => {
  const dst = path.join(tmp, 'vanished', 'tool.zip');
  const r = inCore('vanished', `Download ${JSON.stringify('https://files.test/tool.zip')} ${JSON.stringify(dst)}; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.match(r.log, /The downloaded file vanished between the connection and the folder/);
  assert.match(r.log, /exclusions and run the installer again; downloading the same file once more without an exclusion changes nothing/);
  assert.doesNotMatch(r.stderr, /mv:.*No such file/, 'no raw mv failure surfaces');
  assert.ok(!existsSync(dst));
});

// - - - - - the Ollama version gate (ticket 03) - - - - - -

function stubOllama(version) {
  const dir = path.join(tmp, `olstub-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'ollama');
  writeFileSync(f, `#!/bin/sh\ncase "$1" in --version) echo 'ollama version is ${version}' ;; *) exit 0 ;; esac\n`);
  chmodSync(f, 0o755);
  return dir;
}

function runOllamaGate(version) {
  const stateDir = path.join(tmp, `olgate-${Math.random().toString(36).slice(2)}`);
  const base = path.join(stateDir, 'app');
  const rt = path.join(base, 'runtime'); const dl = path.join(base, 'downloads'); const cfg = path.join(base, 'config', 'paths.json');
  mkdirSync(dl, { recursive: true }); mkdirSync(path.dirname(cfg), { recursive: true });
  const logFile = path.join(base, 'install.log');
  const r = spawnSync('bash', ['-c', `
    say() { printf '%s\\n' "$1"; printf '%s\\n' "$1" >>"$LOG"; }
    source ${JSON.stringify(INSTALL_SH)}
    RT=${JSON.stringify(rt)} DL=${JSON.stringify(dl)} CFGF=${JSON.stringify(cfg)} LOG=${JSON.stringify(logFile)}
    InstallOllama; echo "RC=$?"
    echo "USED=$S_OLLAMA"
    PullModel qwen3:8b; echo "PULL=$?"
  `], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PATH: stubOllama(version) + ':' + process.env.PATH, ASTRA_INSTALL_CURL: fakeCurl('fail6', stateDir) },
  });
  return { r, cfg, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}

test('Ollama gate: an older-than-minimum Ollama is refused and the model step says what to do, no crash', () => {
  const run = runOllamaGate('0.11.2');
  assert.match(run.log, /is older than 0\.12\.7 - not used/);
  assert.match(run.r.stdout, /RC=1/);
  assert.match(run.r.stdout, /USED=/);
  assert.match(run.log, /No usable Ollama - the model step was skipped\. Install Ollama from https:\/\/ollama\.com, then run this installer again: it will retry the model\./);
  assert.match(run.r.stdout, /PULL=1/);
  assert.doesNotMatch(run.r.stderr, /unbound variable|serve: command not found/, 'the guard answers before any command runs');
});

test('Ollama gate: exactly the minimum version is accepted and used', () => {
  const run = runOllamaGate('0.12.7');
  assert.match(run.r.stdout, /RC=0/);
  assert.match(run.r.stdout, /USED=.*ollama/);
  assert.doesNotMatch(run.log, /is older than/);
});

test('Ollama gate: a newer Ollama is accepted too', () => {
  const run = runOllamaGate('99.9.9');
  assert.match(run.r.stdout, /RC=0/);
  assert.doesNotMatch(run.log, /is older than/);
});

// ---------------------------------------------------------------- ticket 16: hf-mirror fallthrough,
// the damaged-file one-shot, the never-abort log rule, and the clips mirror wiring

test('huggingface.co that never comes through is retried once through hf-mirror.com, same checksum', () => {
  const dst = path.join(tmp, 'hf16', 'model.bin');
  const r = inCore('hf_fallback', `DownloadChecked ${JSON.stringify('https://huggingface.co/some.repo/resolve/main/model.bin')} ${JSON.stringify(dst)} 7 ${JSON.stringify(PAYLOAD_SHA)} && echo RC=$?`);
  assert.match(r.stdout, /RC=0/, r.log + r.stderr);
  assert.equal(readFileSync(dst, 'utf8'), 'payload');
  assert.ok(r.calls.some((c) => c.url === 'https://hf-mirror.com/some.repo/resolve/main/model.bin'), JSON.stringify(r.calls));
  assert.match(r.log, /trying the same file through hf-mirror\.com/);
});

test('a non-HF URL gets no invented mirror, and a sha-less HF file gets no unverified fallthrough', () => {
  const a = inCore('fail6', `HfMirrorUrl https://huggingface.co/a/b; echo; HfMirrorUrl https://files.test/a; echo RC=$?`);
  assert.match(a.stdout, /^https:\/\/hf-mirror\.com\/a\/b$/m, 'the path is kept');
  const b = inCore('hf_fallback', `DownloadChecked ${JSON.stringify('https://huggingface.co/x/y.bin')} ${JSON.stringify(path.join(tmp, 'hf16nosh.bin'))} 7 '' ; echo RC=$?`);
  assert.equal(b.calls.every((c) => !c.url.includes('hf-mirror.com')), true, 'no checksum = no mirror: a substituted file must not pass');
  assert.match(b.stdout, /RC=1/);
});

test('a file that arrives damaged re-downloads once from scratch and heals', () => {
  const dst = path.join(tmp, 'hf16dmg', 'file.bin');
  const r = inCore('damaged_once', `DownloadChecked ${JSON.stringify('https://files.test/file.bin')} ${JSON.stringify(dst)} 7 ${JSON.stringify(PAYLOAD_SHA)} && echo RC=$?`);
  assert.match(r.stdout, /RC=0/, r.log + r.stderr);
  assert.equal(readFileSync(dst, 'utf8'), 'payload');
  assert.match(r.log, /downloaded damaged \(size or sha256 mismatch\) - downloading it once more from the start/);
  assert.doesNotMatch(r.log, /; removed - run the installer again/, 'the healing path is not the failure path');
});

test('damaged twice: the file is removed and the named line tells to run the installer again', () => {
  const dst = path.join(tmp, 'hf16dmg2', 'file.bin');
  const r = inCore('badsha', `DownloadChecked ${JSON.stringify('https://files.test/file.bin')} ${JSON.stringify(dst)} 7 ${JSON.stringify(PAYLOAD_SHA)}; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.equal(existsSync(dst), false, 'the damaged file must not stay on disk');
  assert.match(r.log, /file file\.bin downloaded damaged \(size or sha256 mismatch\); removed - run the installer again/);
});

test('an unwritable install log never aborts the run - it is announced once, then silence', () => {
  const dir = path.join(tmp, 'log16'); mkdirSync(dir, { recursive: true });
  const script = `
    source ${JSON.stringify(INSTALL_SH)}
    LOG=${JSON.stringify(dir)}                       # a directory: appending always fails
    say 'first line'; say 'second line'; echo RC=$?
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ASTRA_INSTALL_CURL: '/bin/true' } });
  assert.match(r.stdout, /RC=0/);
  assert.match(r.stdout, /first line/);              // the user still sees everything
  const warns = (r.stdout.match(/the install log is not writable/g) || []).length;
  assert.equal(warns, 1, 'announced exactly once: ' + r.stdout);
});

test('the clips step reads its mirror bases from installer/manifest.json (ships empty until a verified copy exists)', () => {
  const man = JSON.parse(readFileSync(path.join(HERE, '..', 'installer', 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(man.clips.mirrors) && man.clips.mirrors.length === 0, 'the list is explicit and empty - no invented mirrors');
  const src = readFileSync(INSTALL_SH, 'utf8');
  assert.match(src, /clips\.mirrors/);
  assert.match(src, /no verified mirror yet/, 'and the honest failure line says exactly that');
});

// ---------------------------------------------------------------- ticket 23: the interception verdict

test('a "successful" empty download is named as an interception, not a checksum puzzle', () => {
  const dst = path.join(tmp, 'intr23', 'clip.zip');
  const r = inCore('empty_ok', `DownloadChecked ${JSON.stringify('https://files.test/clip.zip')} ${JSON.stringify(dst)} 2048 ''; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.match(r.log, /The site answered with an empty file: something intercepted the transfer \(a captive provider login page, a proxy block page, or an antivirus substitute\)/);
  assert.match(r.log, /Open the site's address in a browser/);
  assert.equal(existsSync(dst), false, 'the empty impostor is never left in place');
  assert.equal(existsSync(dst + '.part'), false);
});

test('the mirror rule holds behind interception: an HF file that only mirrors empty still dies honestly', () => {
  // hf_fallback: huggingface exits 7, the mirror answers - now with both sides empty the file
  // must never be accepted, and the explanation must be there
  const r = inCore('empty_ok', `Download ${JSON.stringify('https://huggingface.co/x/y.bin')} ${JSON.stringify(path.join(tmp, 'intr23b.bin'))} 1024; echo RC=$?`);
  assert.match(r.stdout, /RC=1/);
  assert.match(r.log, /empty file/);
});
