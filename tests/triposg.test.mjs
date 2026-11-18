// TripoSG core (behavior per ADR-0004, ticket 01): install state and honest absence messages, the
// engine enum and resolver (auto untouched - its card rule is ticket 02), the worker spawn
// contract (argv parity for meshLevel/seed, PROGRESS parsing, result/error mapping, cancellation),
// and the booted-studio surface (/api/status triposg row; an explicit uninstalled triposg job is
// refused with the install instruction, never a crash). The real GPU run is the live demo in the
// ticket - nothing here needs a card.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { facesForLevel, triposgArgs, triposgConfig, triposgInstallState, triposgStatus, generateTripoSG, TRIPOSG_REQUIREMENTS, autoShape, vramMiB, TRIPOSG_AUTO_MAX_VRAM_MIB } from '../server/triposg.mjs';
import { resolveEngine, PIXAL3D_REQUIREMENTS } from '../server/pixal3d.mjs';
import { generationSchema } from '../server/schema.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-triposg-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('meshLevel parity: the face budget maps -1/0/1 and clamps', () => {
  assert.equal(facesForLevel(-1), 80000);
  assert.equal(facesForLevel(0), 200000);
  assert.equal(facesForLevel(1), 5000000);
  assert.equal(facesForLevel(-3), facesForLevel(-1), 'clamped');
  assert.equal(facesForLevel(undefined), facesForLevel(0));
});

test('worker argv: python + script + the job parameters, level mapped to --faces', () => {
  const cfg = triposgConfig({ env: { IMAGINARIUM_TRIPOSG_DIR: '/opt/triposg' }, appRoot: '/app' });
  const argv = triposgArgs(cfg, { image: '/tmp/c.png', out: '/tmp/o.glb', level: 1, seed: 7, steps: 50 });
  assert.ok(argv[0].endsWith(path.join('.venv', process.platform === 'win32' ? 'python.exe' : 'python')) || argv[0].includes('python'), argv[0]);
  assert.ok(argv.some((a) => a.endsWith('tripoSG_run.py') || a.endsWith('triposg_run.py')), 'our worker script');
  assert.deepEqual(argv.slice(argv.indexOf('--faces'), argv.indexOf('--faces') + 2), ['--faces', '5000000']);
  assert.ok(argv.includes('--seed') && argv[argv.indexOf('--seed') + 1] === '7');
  assert.ok(argv.includes('--steps'));
});

test('install state names every missing piece and points at the opt-in component', () => {
  const cfg = { dir: '/opt/triposg', source: 'env', appRoot: '/app' };
  const state = triposgInstallState(cfg, () => false);
  assert.equal(state.installed, false);
  assert.deepEqual(state.missing.map((m) => m.path), TRIPOSG_REQUIREMENTS.map(([p]) => p));
  assert.match(state.message, /TripoSG is not ready/);
  assert.match(state.message, /install\.sh -Only triposg/);
  assert.match(state.message, /opt-in/);
  const all = new Set(TRIPOSG_REQUIREMENTS.map(([p]) => p));
  const ok = triposgInstallState(cfg, (p) => all.has(path.relative('/opt/triposg', p)));
  assert.equal(ok.installed, true);
  assert.deepEqual(ok.missing, []);
});

test('status: subprocess engine - never claims a running service', () => {
  const st = triposgStatus({ cfg: { dir: '/opt/triposg', source: 'env', appRoot: '/app' }, exists: () => false });
  assert.equal(st.installed, false);
  assert.equal(st.running, false);
  assert.ok(Array.isArray(st.missing) && st.missing.length === TRIPOSG_REQUIREMENTS.length);
  assert.equal(typeof st.estimate.seconds, 'number');
});

test('resolveEngine: explicit triposg refuses honestly when uninstalled; auto behavior untouched (ticket 02)', () => {
  process.env.IMAGINARIUM_TRIPOSG_DIR = path.join(tmp, 'nothing-here');
  try {
    assert.throws(() => resolveEngine('triposg'), (e) => e.code === 'triposg_not_installed' && /TripoSG is not ready/.test(e.message));
    const installed = TRIPOSG_REQUIREMENTS.map(([rel]) => path.join(tmp, 'inst', rel));
    mkdirSync(tmp, { recursive: true });
    for (const f of installed) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, 'x'); }
    process.env.IMAGINARIUM_TRIPOSG_DIR = path.join(tmp, 'inst');
    assert.equal(resolveEngine('triposg'), 'triposg');
    assert.equal(resolveEngine('hunyuan'), 'hunyuan');
  } finally { delete process.env.IMAGINARIUM_TRIPOSG_DIR; }
});

test('generationSchema accepts engine=triposg and still refuses unknown engines', () => {
  const base = { prompt: 'a knight', seed: 1 };
  assert.equal(generationSchema.parse({ ...base, engine: 'triposg' }).engine, 'triposg');
  assert.throws(() => generationSchema.parse({ ...base, engine: 'midjourney' }));
});

// - - - - - - - - - auto rule (ticket 02) - - - - - - - - - - - - - - - - - - - - - - - - - - -

test('autoShape: TripoSG takes the low-VRAM band when installed; never for view sets or without a reading', () => {
  const T = { triposgInstalled: true, pixal3dInstalled: true };
  assert.equal(autoShape({ ...T, vram: 8192 }).engine, 'triposg');
  assert.equal(autoShape({ ...T, vram: TRIPOSG_AUTO_MAX_VRAM_MIB }).engine, 'triposg', 'boundary is inclusive');
  assert.equal(autoShape({ ...T, vram: TRIPOSG_AUTO_MAX_VRAM_MIB + 1 }).engine, 'pixal3d');
  assert.equal(autoShape({ ...T, vram: 8192, hasViews: true }).engine, 'pixal3d', 'view sets keep multi-view engines');
  assert.equal(autoShape({ ...T, vram: null }).engine, 'pixal3d', 'no card reading -> the old behavior');
  assert.equal(autoShape({ triposgInstalled: false, pixal3dInstalled: false, vram: 4096 }).engine, 'hunyuan');
  assert.match(autoShape({ ...T, vram: 8192 }).reason, /8192/, 'the reason names the reading');
});

test('vramMiB: IMAGINARIUM_VRAM_MIB wins; a missing nvidia-smi reads null, not a crash', () => {
  assert.equal(vramMiB({ env: { IMAGINARIUM_VRAM_MIB: '12288' } }), 12288);
  assert.equal(vramMiB({ env: { IMAGINARIUM_VRAM_MIB: '0' }, spawnFn: () => { throw new Error('no such command'); } }), null);
  assert.equal(vramMiB({ env: {}, spawnFn: () => ({ stdout: '8192 MiB\n' }) }), 8192, 'nvidia-smi nounits line');
});

test('resolveEngine(auto) with opts: installed TripoSG + small card wins; big card and views keep Pixal3D', () => {
  const tsDir = path.join(tmp, 'ts-full');
  const p3Dir = path.join(tmp, 'p3-full');
  const need = new Set([...TRIPOSG_REQUIREMENTS.map(([rel]) => path.join(tsDir, rel)),
    ...PIXAL3D_REQUIREMENTS.map(([rel]) => path.join(p3Dir, rel))]);
  for (const f of need) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, 'x'); }
  process.env.IMAGINARIUM_TRIPOSG_DIR = tsDir;
  try {
    const p3cfg = { dir: p3Dir, url: 'http://127.0.0.1:8191', port: 8191 };
    const ex = (p) => need.has(p) || p === p3Dir || p === tsDir;
    assert.equal(resolveEngine('auto', p3cfg, ex, { vram: 8192 }), 'triposg');
    assert.equal(resolveEngine('auto', p3cfg, ex, { vram: 12288 }), 'pixal3d');
    assert.equal(resolveEngine('auto', p3cfg, ex, { vram: 8192, hasViews: true }), 'pixal3d');
    assert.equal(resolveEngine('auto', { dir: path.join(tmp, 'p3-none'), url: 'http://127.0.0.1:8191', port: 8191 }, ex, { vram: 8192 }), 'triposg',
      'no Pixal3D at all and a small card: still TripoSG, never hunyuan-on-a-tiny-card');
  } finally { delete process.env.IMAGINARIUM_TRIPOSG_DIR; }
});

// - - - - - - - - - worker spawn contract (fake child, no python needed) - - - - - - - - - - - -

function fakeChild({ lines, exitCode = 0, onKill = null, writeOutFromArgv = null, stayAlive = false }) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = (sig) => { onKill?.(sig); return true; };
  setImmediate(() => {
    for (const l of lines) c.stdout.write(l + '\n');
    if (stayAlive) return;
    if (exitCode !== 0) c.emit('exit', exitCode);
    else if (!writeOutFromArgv) c.emit('exit', 0);
  });
  return c;
}

test('generateTripoSG: argv, progress mapping, result bytes', async () => {
  const cfg = triposgConfig({ env: { IMAGINARIUM_TRIPOSG_DIR: '/opt/triposg' }, appRoot: '/app' });
  let seenArgv = null;
  const spawned = (python, argv) => {
    seenArgv = [python, ...argv];
    const out = argv[argv.indexOf('--out') + 1];
    writeFileSync(out, 'GLBDATA');
    const c = fakeChild({ lines: ['PROGRESS 8 TripoSG: loading the pipeline', 'PROGRESS 24 x', 'TRIPOSG_RESULT {"out":"p","faces":1234,"seconds":3.5}'], exitCode: 0 });
    return c;
  };
  const res = await generateTripoSG({ cfg: { ...cfg }, image: '/tmp/concept.png', level: -1, seed: 5, spawnFn: spawned, onProgress: () => {} });
  // the out path lives under data/runtime/temp; the fake wrote through argv, so read the same file back
  const outArg = seenArgv[seenArgv.indexOf('--out') + 1];
  assert.equal(readFileSync(outArg).toString(), 'GLBDATA');
  assert.equal(res.stats.faces, 1234);
  assert.ok(seenArgv.includes('--faces') && seenArgv[seenArgv.indexOf('--faces') + 1] === '80000', 'level -1 mapped');
  rmSync(outArg, { force: true });
});

test('generateTripoSG: a card from the GPU pool pins CUDA_VISIBLE_DEVICES into the worker env, none touches it', async () => {
  const cfg = triposgConfig({ env: { IMAGINARIUM_TRIPOSG_DIR: '/opt/triposg' }, appRoot: '/app' });
  const lines = ['TRIPOSG_RESULT {"out":"p"}'];
  let seenEnv = null;
  const spawnCard = (exe, argv, opts) => { seenEnv = opts.env; writeFileSync(argv[argv.indexOf('--out') + 1], 'GLB'); return fakeChild({ lines, exitCode: 0 }); };
  await generateTripoSG({ cfg, image: '/tmp/c.png', card: { index: 1, uuid: 'GPU-B' }, spawnFn: spawnCard, onProgress: () => {} });
  assert.equal(seenEnv.CUDA_VISIBLE_DEVICES, '1', 'the worker sees only its card');
  assert.equal(seenEnv.HF_HUB_OFFLINE, '1', 'the worker environment survives the pin');
  await generateTripoSG({ cfg, image: '/tmp/c.png', spawnFn: spawnCard, onProgress: () => {} });
  assert.equal(seenEnv.CUDA_VISIBLE_DEVICES, process.env.CUDA_VISIBLE_DEVICES, 'no pool -> the inherited value passes through untouched (the pre-pool behaviour)');
});

test('generateTripoSG: progress callbacks fire in order; TRIPOSG_ERROR becomes the job message', async () => {
  const cfg = triposgConfig({ env: { IMAGINARIUM_TRIPOSG_DIR: '/opt/triposg' }, appRoot: '/app' });
  const got = [];
  await assert.rejects(
    generateTripoSG({ cfg, image: '/tmp/c.png', spawnFn: () => fakeChild({ lines: ['PROGRESS 8 loading', 'PROGRESS 74 decoding', 'TRIPOSG_ERROR {"message":"CUDA out of memory"}'], exitCode: 1 }),
      onProgress: (p) => got.push(p.percent) }),
    (e) => e.message.includes('TripoSG: CUDA out of memory'),
  );
  assert.deepEqual(got, [8, 74]);
});

test('generateTripoSG: aborting kills the worker and rejects as cancelled', async () => {
  const cfg = triposgConfig({ env: { IMAGINARIUM_TRIPOSG_DIR: '/opt/triposg' }, appRoot: '/app' });
  const ctrl = new AbortController();
  let killed = null;
  const p = generateTripoSG({ cfg, image: '/tmp/c.png', signal: ctrl.signal, spawnFn: () => fakeChild({ lines: [], stayAlive: true, onKill: (s) => { killed = s; } }), onProgress: () => {} });
  await new Promise((r) => setImmediate(r));
  ctrl.abort();
  await assert.rejects(p, (e) => e.cancelled === true);
  assert.equal(killed, 'SIGKILL');
});

test('generateTripoSG: a python that cannot start says so with the path', async () => {
  const cfg = triposgConfig({ env: { IMAGINARIUM_TRIPOSG_DIR: '/opt/triposg' }, appRoot: '/app' });
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true;
  setImmediate(() => c.emit('error', new Error('ENOENT')));
  await assert.rejects(generateTripoSG({ cfg, image: '/tmp/c.png', spawnFn: () => c }), (e) => /did not start/.test(e.message) && /python/.test(e.message));
});

// - - - - - - - - - booted studio surface - - - - - - - - - - - - - - - - - - - - - - - - - - -

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39877;
const base = `http://127.0.0.1:${PORT}`;
let child = null;

async function boot() {
  if (child) return;
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), IMAGINARIUM_ENGINE_AUTOSTART: '0', IMAGINARIUM_TRIPOSG_DIR: path.join(tmp, 'definitely-not-installed') },
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('studio did not boot');
}
after(() => child?.kill());

test('GET /api/status carries the triposg row (installed:false with the missing list, honest) and a shapeAuto verdict', async () => {
  await boot();
  const st = await (await fetch(base + '/api/status')).json();
  assert.equal(st.triposg.installed, false);
  assert.equal(st.triposg.running, false);
  assert.equal(st.triposg.missing.length, TRIPOSG_REQUIREMENTS.length);
  assert.match(st.triposg.message, /TripoSG is not ready/);
  assert.ok(['hunyuan', 'pixal3d', 'triposg'].includes(st.shapeAuto.engine), JSON.stringify(st.shapeAuto));
  assert.equal(typeof st.shapeAuto.reason, 'string');
});

test('POST /api/jobs engine=triposg is refused before the queue with the install instruction', async () => {
  await boot();
  const r = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'x-imaginarium-client': 'studio', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a knight', engine: 'triposg' }) });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /TripoSG is not ready/);
  assert.match(body.error, /-Only triposg/);
});

// The iso-surface fallback (diso is CC BY-NC 4.0, never installed here) must produce a watertight
// outward-oriented mesh: its own python self-test, run with the component's venv when present.
test('diso_skimage_fallback self-test: unit sphere, watertight, positive volume', (t) => {
  const python = path.join(ROOT, 'runtime', 'triposg', '.venv', 'bin', 'python');
  if (!existsSync(python)) { t.skip('no TripoSG venv on this machine (installer component triposg)'); return; }
  const r = spawnSync(python, ['scripts/triposg/diso_skimage_fallback.py'], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, (r.stderr || r.stdout).slice(-800));
  assert.match(r.stdout, /OK: \d+ verts, \d+ faces, watertight, volume=\d+\.\d+/);
});
