// The studio Components checklist (server/components.mjs): the ##ITEM parsing, when the window
// opens, background installs with progress, the busy guard. The non-win32 sibling of the reference
// components.test.mjs: the reference stubs powershell; here the child is installer/install.sh and
// the scan is the shared core module, so the same behaviors are checked with an importCore stub and
// a fake spawn that streams the '##PROGRESS / ##FAILED / ##DONE' contract of ticket 16/17.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// a child process that streams the given lines and exits with the given code (the fakeSpawn of the reference)
function fakeSpawn(lines, code = 0) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    setTimeout(() => { for (const l of lines) c.stdout.emit('data', Buffer.from(l + '\n')); c.emit('exit', code); }, 5);
    return c;
  };
  return { calls, spawnImpl };
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
    hy2: miss, hymv: miss, hy21: miss, sdxl: miss, u2net: miss, flux2: miss, qwenimg: miss,
    mv: { node: false, weights: false, config: false, pkgs: false, ready: false, offer: true, reason: '', warn: '', bytes: 1 },
    p3: { dir: '', exists: false, engine: false, weights: false, complete: false, offer: true, reason: '', warn: '', missingBytes: 0, diskNeed: 0 },
    free: 200e9,
  };
}

test('install: the ids go to install.sh -Yes -Profile -Only, ##PROGRESS feeds the job, ##DONE closes it', async () => {
  const { root, data } = app('quick');
  const { calls, spawnImpl } = fakeSpawn(['##PROGRESS 12|downloaded 5 MB of 40 MB', '##PROGRESS 80|downloaded 32 MB of 40 MB', '##DONE'], 0);
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl });
  const st = await c.install(['godot', 'clips']);
  assert.equal(st.job.code, null);
  assert.equal(st.job.progress, 0);
  assert.equal(st.job.profile, 'quick', 'the profile from config is the default');
  await tick();
  const after1 = (await c.state()).job;
  assert.equal(after1.code, 0);
  assert.equal(after1.progress, 100);
  assert.equal(after1.text, 'Done');
  assert.deepEqual(after1.failed, []);
  assert.equal(calls[0].cmd, 'bash');
  assert.ok(calls[0].args[0].endsWith(path.join('installer', 'install.sh')), calls[0].args[0]);
  assert.deepEqual(calls[0].args.slice(1), ['-Yes', '-Profile', 'quick', '-Only', 'godot,clips']);
  assert.equal(JSON.parse(readFileSync(path.join(data, 'update', 'checklist.json'), 'utf8')).version, '0.5.0',
    'starting an install marks the version seen');
});

test('install: ##FAILED carries the failed ids and a nonzero exit lands in the job state', async () => {
  const { root, data } = app();
  const { spawnImpl } = fakeSpawn(['##PROGRESS 40|downloaded 16 MB of 40 MB', '##FAILED hy2,u2net'], 1);
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl });
  await c.install(['hy2', 'u2net'], { profile: 'full' });
  await tick();
  const j = (await c.state()).job;
  assert.equal(j.code, 1);
  assert.deepEqual(j.failed, ['hy2', 'u2net']);
  assert.equal(j.progress, 40);
});

test('a running job is never started twice, and scan waits for it (the reference busy rules)', async () => {
  const { root, data } = app();
  const { calls, spawnImpl } = fakeSpawn(['##DONE'], 0);
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl,
    importCore: fakeCore(scanStateFixture, (s) => CORE.scanItems(s)) });
  await c.install(['godot']);
  const again = await c.install(['clips']);
  assert.deepEqual(again.job.ids, ['godot'], 'the second request returns the running job');
  assert.equal(calls.length, 1);
  await assert.rejects(c.scan(), /install is running/);
  await tick();
  const s = await c.scan();
  assert.ok(s.items.length > 0, 'scan works again after the job finished');
});

test('install sanitizes ids: nothing ticked is an error, junk ids are dropped', async () => {
  const { root, data } = app();
  const { calls, spawnImpl } = fakeSpawn(['##DONE'], 0);
  const c = createComponents({ appRoot: root, dataDir: data, appVersion: '0.5.0', spawnImpl });
  await assert.rejects(c.install([]), /Nothing ticked/);
  await assert.rejects(c.install(undefined), /Nothing ticked/);
  await assert.rejects(c.install(['../../etc', 'OK SHOUTING']), /Nothing ticked/);
  await c.install(['godot', 'godot', '../evil', 'u2net']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(' '), /-Only godot,u2net$/);
});
