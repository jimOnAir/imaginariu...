// The studio Components checklist (server/components.mjs): the ##ITEM parsing, when the window
// opens, background installs with progress, the busy guard. The non-win32 sibling of the reference
// components.test.mjs: the reference stubs powershell; here the child is installer/install.sh and
// the scan is the shared core module, so the same behaviors are checked with an importCore stub and
// a fake spawn. Ticket 24 changed the child contract: the installer is DETACHED (stdio ignored -
// a closed studio must not kill it) and reports progress into the file named by its env
// ASTRA_INSTALL_STATUS (WriteInstallStatus in installer/af_download.sh), so the fakes below write
// that file, exactly like a live run does, and the studio re-attaches by reading it plus pid.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScanList, createComponents } from '../server/components.mjs';
import * as CORE from '../installer/af_scan.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'af-comp-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const T = String.fromCharCode(9);
const item = (...f) => ['##ITEM', ...f].join(T);

const SCAN = [
  '== What the studio checked ==',
  item('node', 'Programs', 'installed', '22.23.3', 'v22.23.3', '32000000', 'Node.js', 'MIT', 'qfl', '', 'node', ''),
  item('flux2', '2D and images', 'missing', '', '', '16018186210', 'FLUX.2 klein', 'FLUX NC', 'f', 'comfy', 'flux2', ''),
  item('pixal3d', '3D: shape and views', 'missing', '', '', '9000000000', 'Pixal3D', 'MIT; DINOv3', 'f', '', 'pixal3d,pixal3dw', ''),
  'junk', item('bad', 'few fields'),
].join('\n');

test('parseScanList: fields, dependencies, the -Only ids; short lines are skipped', () => {
  const items = parseScanList(SCAN);
  assert.equal(items.length, 3);
  assert.deepEqual(items[1], { id: 'flux2', group: '2D and images', status: 'missing', have: '', need: '', size: 16018186210,
    name: 'FLUX.2 klein', license: 'FLUX NC', presets: 'f', deps: ['comfy'], only: ['flux2'], note: '' });
  assert.deepEqual(items[2].only, ['pixal3d', 'pixal3dw']);
});

// A fake install.sh: detached-spawn shaped (pid, unref, exit events) and speaking the ticket-24
// truth file. status() appends one WriteInstallStatus-shaped JSON line; finish() ends the run.
function manualSpawn() {
  const calls = [];
  let child = null;
  const spawnImpl = (cmd, args, o = {}) => {
    calls.push({ cmd, args, opts: o });
    child = new EventEmitter();
    child.pid = process.pid;                      // alive, so re-attach reads see a live run
    child.unref = () => {};
    child.status = (progress, text, extra = {}) => {
      writeFileSync(o.env.ASTRA_INSTALL_STATUS, JSON.stringify(
        { at: new Date().toISOString(), pid: child.pid, progress, text, ...extra }) + '\n', { flag: 'a' });
    };
    child.finish = (code) => child.emit('exit', code);
    return child;
  };
  return { calls, spawnImpl, child: () => child };
}
// script the whole run at once: lines flush, then the exit (the old fakeSpawn, file-based now)
function fakeSpawn(lines, code = 0) {
  const m = manualSpawn();
  const spawnImpl = (...a) => {
    const c = m.spawnImpl(...a);
    setTimeout(() => { for (const [p, t, x] of lines) c.status(p, t, x || {}); c.finish(code); }, 5);
    return c;
  };
  return { calls: m.calls, spawnImpl, child: m.child };
}
function app(profile) {
  const root = path.join(tmp, 'app-' + Math.random().toString(36).slice(2));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  if (profile) writeFileSync(path.join(root, 'config', 'paths.json'), JSON.stringify({ profile }));
  return { root, data: path.join(root, 'data') };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const fakeCore = (scanComponents = () => ({}), scanItems = () => []) => async () => ({
  scanComponents, scanItems, itemLines: CORE.itemLines,
});
const NEVER_SPAWN = () => { throw new Error('a surviving run must never be doubled by the studio'); };

test('the window opens once per version: first start is due, after it only when the version changes', async () => {
  const { root, data } = app();
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: fakeSpawn([]).spawnImpl });
  assert.equal(await c.due(), true, 'a fresh install shows the checklist once');
  await c.markSeen();
  assert.equal(await c.due(), false, 'the same version does not reopen it');
  const same = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.1', spawnImpl: fakeSpawn([]).spawnImpl });
  assert.equal(await same.due(), true, 'a new app version opens it again');
  const seen = JSON.parse(readFileSync(path.join(data, 'update', 'checklist.json'), 'utf8'));
  assert.equal(seen.version, '0.5.0');
});

test('scan: the real scan core through the ##ITEM contract, the profile comes from config (lite here)', async () => {
  const { root, data } = app('lite');
  const state = { ...scanStateFixture() };
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0',
    importCore: fakeCore(() => state, (s) => CORE.scanItems(s)) });
  const s = await c.scan();
  assert.equal(s.profile, 'lite', 'the checklist default follows the installed profile');
  assert.ok(s.items.length >= 19, `all rows: ${s.items.length}`);
  const node = s.items.find((x) => x.id === 'node');
  assert.equal(node.status, 'installed');
  assert.equal(node.presets, 'qfl');
  assert.deepEqual(s.items.find((x) => x.id === 'hy2').deps, ['comfy']);
  assert.equal((await c.state()).scan.at, s.at);
});

// a synthetic scan state (an empty machine with an RTX card) - the same fixture as the scan tests
function scanStateFixture() {
  const man = JSON.parse(readFileSync(path.join(APP, 'installer', 'manifest.json'), 'utf8'));
  const miss = { st: 'missing', where: '' };
  return {
    root: APP, rt: path.join(APP, 'runtime'), man, env: {}, cfg: {}, noGpu: false,
    gpu: 'RTX 4070', vram: 12288, cc: '8.9', gpuBroken: '', adapters: [], node: '/n', nodeVer: '22.23.3',
    npmDeps: true, ui: true, blender: '/b', blenderVer: '5.0.1', comfy: '', comfyVer: '', comfyDeps: false,
    gguf: false, godot: '', godotVer: '', clips: 0, library: '/l', vfxDir: '/v', vfxOk: false, ollama: '', llms: [], vlm: false,
    driver: '615.71.09', driverMajor: 615, driverOld: false,
    hy2: miss, hymv: miss, hy21: miss, hy2mini: miss, sdxl: miss, u2net: miss, flux2: miss, qwenimg: miss, qwenedit: miss,
    mv: { node: false, weights: false, config: false, pkgs: false, ready: false, offer: true, reason: '', warn: '', bytes: 1 },
    p3: { dir: '', exists: false, engine: false, weights: false, complete: false, offer: true, reason: '', warn: '', missingBytes: 0, diskNeed: 0 },
    ts: { dir: '', env: false, code: false, weights: false, complete: false, offer: false, reason: '', missingBytes: 0 },
    snd: { dir: '', env: false, code: false, weights: false, complete: false, offer: true, reason: '', missingBytes: 0, codeBytes: 21071466, weightBytes: 21322260234 },
    free: 200e9,
  };
}

test('install: the detached run reports through the status file; progress, done, pid bookkeeping', async () => {
  const { root, data } = app('quick');
  const { calls, spawnImpl, child } = manualSpawn();
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl });
  const st = await c.install(['godot', 'clips']);
  assert.equal(st.job.code, null);
  assert.equal(st.job.progress, 0);
  assert.equal(st.job.profile, 'quick', 'the profile from config is the default');
  assert.equal(calls[0].cmd, 'bash');
  assert.ok(calls[0].args[0].endsWith(path.join('installer', 'install.sh')), calls[0].args[0]);
  assert.deepEqual(calls[0].args.slice(1), ['-Yes', '-Profile', 'quick', '-Only', 'godot,clips']);
  assert.equal(calls[0].opts.detached, true, 'the run must survive a studio closing');
  assert.equal(calls[0].opts.stdio, 'ignore', 'and never die on the studio\'s closed stdout');
  const statusFile = path.join(data, 'update', 'install-run', 'status.jsonl');
  assert.equal(calls[0].opts.env.ASTRA_INSTALL_STATUS, statusFile, 'the run is told where to report');
  const pidInfo = JSON.parse(readFileSync(path.join(data, 'update', 'install-run', 'pid.json'), 'utf8'));
  assert.equal(pidInfo.pid, process.pid);
  assert.deepEqual(pidInfo.ids, ['godot', 'clips']);
  assert.equal(JSON.parse(readFileSync(path.join(data, 'update', 'checklist.json'), 'utf8')).version, '0.5.0',
    'starting an install marks the version seen');
  // progress arrives through the file, not the pipe:
  child().status(12, 'downloaded 5 MB of 40 MB');
  const mid = (await c.state()).job;
  assert.equal(mid.progress, 12);
  assert.equal(mid.text, 'downloaded 5 MB of 40 MB');
  assert.equal(typeof mid.at, 'string', 'ticket 60 item 1: the panel gets the time of the last line, so a stalled step can say how long ago it was');
  assert.equal((await c.state()).busy, true);
  child().status(100, 'done', { code: 0 });
  child().finish(0);
  await tick();
  const after1 = (await c.state());
  assert.equal(after1.job.code, 0);
  assert.equal(after1.job.progress, 100);
  assert.equal(after1.job.text, 'done');
  assert.deepEqual(after1.job.failed, []);
  assert.equal(after1.busy, false);
  assert.equal(existsSync(path.join(data, 'update', 'install-run', 'pid.json')), false, 'a finished run gives up its pid');
});

test('install: the failed line carries the failed ids and a nonzero exit lands in the job state', async () => {
  const { root, data } = app();
  const { spawnImpl, child } = manualSpawn();
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl });
  await c.install(['hy2', 'u2net'], { profile: 'full' });
  child().status(40, 'downloaded 16 MB of 40 MB');
  child().status(100, 'failed', { code: 1, failed: 'hy2,u2net' });
  child().finish(1);
  await tick();
  const j = (await c.state()).job;
  assert.equal(j.code, 1);
  assert.deepEqual(j.failed, ['hy2', 'u2net']);
  assert.equal(j.progress, 100, 'the closing line wins: the run said where it ended');
});

test('a running job is never started twice, and scan waits for it (the reference busy rules)', async () => {
  const { root, data } = app();
  const { calls, spawnImpl } = manualSpawn();
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl,
    importCore: fakeCore(scanStateFixture, (s) => CORE.scanItems(s)) });
  await c.install(['godot']);
  const again = await c.install(['clips']);
  assert.deepEqual(again.job.ids, ['godot'], 'the second request returns the running job');
  assert.equal(calls.length, 1);
  await assert.rejects(c.scan(), /install is running/);
  spawnImpl; // (child stays open - the next test proves the finished path)
  const done = fakeSpawn([[100, 'done', { code: 0 }]], 0);
  const c2 = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: done.spawnImpl,
    importCore: fakeCore(scanStateFixture, (s) => CORE.scanItems(s)) });
  await c2.install(['clips']);
  await tick();
  const s = await c2.scan();
  assert.ok(s.items.length > 0, 'scan works again after the job finished');
});

test('install sanitizes ids: nothing ticked is an error, junk ids are dropped', async () => {
  const { root, data } = app();
  const { calls, spawnImpl } = fakeSpawn([[100, 'done', { code: 0 }]], 0);
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl });
  await assert.rejects(c.install([]), /Nothing ticked/);
  await assert.rejects(c.install(undefined), /Nothing ticked/);
  await assert.rejects(c.install(['../../etc', 'OK SHOUTING']), /Nothing ticked/);
  await c.install(['godot', 'godot', '../evil', 'u2net']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(' '), /-Only godot,u2net$/);
});

// ---------------------------------------------------------------- ticket 24: survive and re-attach

// write what a PREVIOUS studio session left behind (same files the real run writes)
function plantRun(data, { pid, lines, ids = ['pixal3d', 'pixal3dw'], profile = 'full' }) {
  const runDir = path.join(data, 'update', 'install-run');
  mkdirSync(runDir, { recursive: true });
  if (lines) writeFileSync(path.join(runDir, 'status.jsonl'),
    lines.map((l) => JSON.stringify({ at: '2026-11-08T10:00:0Z', pid, ...l })).join('\n') + '\n');
  if (pid) writeFileSync(path.join(runDir, 'pid.json'), JSON.stringify({ pid, ids, profile, startedAt: '2026-11-08T09:55:0Z' }));
}

test('studio restart mid-install: the panel re-attaches to the surviving run - progress, no error, no double', async () => {
  const { root, data } = app();
  plantRun(data, { pid: process.pid, lines: [{ progress: 0, text: 'starting' }, { progress: 55, text: 'downloaded 9 GB of 16 GB' }] });
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: NEVER_SPAWN, lockProbe: async () => true });
  const s = await c.state();
  assert.equal(s.busy, true);
  assert.equal(s.job.external, true, 'the window says so (a note line rides it)');
  assert.equal(s.job.code, null, 'still running - the dead studio changed nothing');
  assert.equal(s.job.progress, 55);
  assert.equal(s.job.text, 'downloaded 9 GB of 16 GB');
  assert.match(String(s.job.at), /2026-11-08/, 'ticket 60 item 1: the survivor\'s last-line time rides the re-attach');
  assert.deepEqual(s.job.ids, ['pixal3d', 'pixal3dw']);
  // and asking for an install now joins the survivor, never spawns a second one:
  const s2 = await c.install(['clips']);
  assert.equal(s2.job.progress, 55);
});

test('a run that died mid-way answers honestly: no finish line, no pretending', async () => {
  const { root, data } = app();
  plantRun(data, { pid: 999999, lines: [{ progress: 30, text: 'downloaded 4 GB of 16 GB' }] });   // dead pid, no closing line
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: NEVER_SPAWN });
  const s = await c.state();
  assert.equal(s.busy, false, 'a corpse does not block the install button');
  assert.equal(s.job.code, -1);
  assert.match(s.job.text, /ended without a finish line - installer\/install\.log has the story/);
});

test('an install completed outside the studio reads as done, with its ids', async () => {
  const { root, data } = app();
  plantRun(data, { pid: 999999, lines: [{ progress: 100, text: 'done', code: 0 }] });
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: NEVER_SPAWN });
  const s = await c.state();
  assert.equal(s.busy, false);
  assert.equal(s.job.code, 0);
  assert.equal(s.job.text, 'done');
});

test('the second install.sh run is refused through the lock - busy state, honest sentence, no spawn', async () => {
  const { root, data } = app();
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: NEVER_SPAWN, lockProbe: async () => true });
  const s = await c.state();
  assert.equal(s.busy, true, 'busy comes from the lock alone (a terminal run writes no status file)');
  assert.equal(s.job, null, 'and with no status to read, the window says "another installer" - not fake progress');
  await assert.rejects(c.install(['godot']), /Another installer is already running \(it holds installer\/install\.lock\)/);
});

test('the real flock probe: a live holder is busy, the same lock free again is not (no fake injected)', async () => {
  const { root, data } = app();
  mkdirSync(path.join(root, 'installer'), { recursive: true });
  const lock = path.join(root, 'installer', 'install.lock');
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl: NEVER_SPAWN });
  assert.equal((await c.state()).busy, false, 'nobody runs yet');
  // exactly what TakeInstallLock in installer/install.sh does, in its own process:
  const holder = spawn('bash', ['-c', `exec 19>${lock}; flock -n 19; printf '%s\\n' $$ >&19; exec sleep 30`], { detached: true, stdio: 'ignore' });
  holder.unref();
  try {
    await tick(500);
    assert.match(readFileSync(lock, 'utf8').trim(), /^\d+$/, 'the holder recorded its pid inside the lock');
    assert.equal((await c.state()).busy, true, 'flock -n says held - the studio believes it');
    await assert.rejects(c.install(['godot']), /Another installer is already running/);
  } finally { try { process.kill(holder.pid); } catch { /* already gone */ } }
  await tick(300);
  assert.equal((await c.state()).busy, false, 'the lock is off again - installs are open');
});
// The progress TRUTH of the panel (0.7.9 fold wave ticket 60 item 1, the 0.7.8 note): a percent is
// a promise about a denominator. Downloads of unknown size and every blender/ollama step have
// none - the row must show the moving indeterminate bar instead of a frozen "0%", and a step that
// stopped writing lines must say how long ago the last one was. The server half (the last-line
// time riding the job) is asserted in the flow tests above; these lock the panel and the style.
test('the Components progress row never freezes at 0%: percent needs a denominator, else the moving bar (ticket 60 item 1)', () => {
  const comp = readFileSync(path.join(APP, 'src', 'ComponentsPanel.jsx'), 'utf8');
  assert.match(comp, /job\.progress > 0 \? ` — \$\{job\.progress\}%` : ''/,
    'the percent prints only when there is one - the frozen "— 0%" is gone');
  assert.match(comp, /'comp-bar' \+ \(job\.progress > 0 \? '' : ' indet'\)/, 'without a denominator the bar takes the indeterminate class');
  assert.match(comp, /job\.at \? Date\.parse\(job\.at\)/, 'elapsed comes from the last line the installer wrote, not from job start');
  assert.match(comp, /t\('components\.stalled'/, 'a step without new lines says so, with the seconds count');
  const css = readFileSync(path.join(APP, 'src', 'about.css'), 'utf8');
  assert.match(css, /\.comp-bar\.indet i\{[^}]*animation:comp-indet/, 'the indeterminate stripe is a real animation, not a static gray bar');
  assert.match(css, /@keyframes comp-indet/, 'and the keyframes exist');
  for (const loc of ['en', 'ru']) {
    const dict = readFileSync(path.join(APP, 'src', 'i18n', `${loc}.js`), 'utf8');
    assert.match(dict, /"components\.stalled": "[^"]*\{n\}[^"]*"/, `${loc}: the stall note counts seconds`);
  }
});
