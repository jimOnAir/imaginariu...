// TripoSG as the third 3D-shape engine (docs/product/triposg.md): install state and the spawn of a
// one-shot venv worker (scripts/triposg/triposg_run.py). Unlike Pixal3D there is no resident
// service and no port: each generation is a subprocess, the GPU lock in the job layer already
// serializes work. The behavior is derived per ADR-0004 ticket 01; the model itself is the MIT
// VAST-AI/TripoSG project (code and weights), vendored as a commit-pinned clone + an HF snapshot.
// Background removal stays the studio's own: the worker gets the prepared RGBA concept and the
// upstream pipeline needs no segmentation net when a real alpha channel arrives.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root, data } from './storage.mjs';

export const DEFAULT_TRIPOSG_DIR = 'runtime/triposg';
/** What has to be on disk for TripoSG. [relative to the install folder, what it is]. */
export const TRIPOSG_REQUIREMENTS = [
  [process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', 'the TripoSG Python environment'],
  ['src/TripoSG/triposg/pipelines/pipeline_triposg.py', 'TripoSG code (MIT, VAST-AI) pinned in src/TripoSG'],
  ['models/TripoSG/model_index.json', 'TripoSG weights (VAST-AI/TripoSG on Hugging Face, MIT)'],
];

/** Shown in the UI and docs; upstream's own estimate for an 8 GB card. */
export const TRIPOSG_ESTIMATE = { seconds: 20, vramGb: 3.8 };

/**
 * Surface level parity with Hunyuan: meshLevel -1..1 maps to a face budget the worker decimates
 * to (branch design choice, recorded in docs; the pipeline itself ignores meshLevel).
 */
export const FACES_BY_LEVEL = { '-1': 80000, 0: 200000, 1: 5000000 };
export function facesForLevel(level) {
  const l = Number.isFinite(+level) ? Math.max(-1, Math.min(1, +level)) : 0;
  if (l <= -1 / 3) return FACES_BY_LEVEL['-1'];
  if (l >= 1 / 3) return FACES_BY_LEVEL[1];
  return FACES_BY_LEVEL[0];
}

function readPathsJson(rootDir) {
  try { return JSON.parse(readFileSync(path.join(rootDir, 'config', 'paths.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

/** Where TripoSG lives: ASTRA_TRIPOSG_DIR, else config/paths.json (key triposgDir), else runtime/triposg. */
export function triposgConfig({ env = process.env, appRoot = root } = {}) {
  const paths = readPathsJson(appRoot);
  let dir = path.join(appRoot, DEFAULT_TRIPOSG_DIR), source = 'default';
  if (env.ASTRA_TRIPOSG_DIR) { dir = env.ASTRA_TRIPOSG_DIR; source = 'env'; }
  else if (typeof paths.triposgDir === 'string' && paths.triposgDir.trim()) { dir = paths.triposgDir.trim(); source = 'paths.json'; }
  return { dir: path.resolve(dir), source, appRoot };
}

/** Disk check only (no GPU, no network): which required files are missing. */
export function triposgInstallState(cfg = triposgConfig(), exists = existsSync) {
  const missing = TRIPOSG_REQUIREMENTS.filter(([rel]) => !exists(path.join(cfg.dir, rel))).map(([rel, label]) => ({ path: rel, label }));
  if (missing.length) {
    const names = missing.map((m) => m.label).join('; ');
    return { installed: false, missing, message: `TripoSG is not ready (${cfg.dir}): missing ${names}. Install it with installer/install.sh -Only triposg (the component is opt-in: it is new).` };
  }
  return { installed: true, missing: [], message: '' };
}

/** Status for /api/status and the MCP engines row. `running` is always false: a run is a subprocess, not a service. */
export function triposgStatus({ cfg = triposgConfig(), exists = existsSync } = {}) {
  const state = triposgInstallState(cfg, exists);
  return { installed: state.installed, running: false, dir: cfg.dir, missing: state.missing, message: state.message, estimate: TRIPOSG_ESTIMATE };
}

/** The worker's argv; exported so a test can pin the meshLevel parity without a GPU. */
export function triposgArgs(cfg, { image, out, level, seed, steps, guidance }) {
  return [
    path.join(cfg.dir, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'),
    path.join(cfg.appRoot, 'scripts', 'triposg', 'triposg_run.py'),
    '--image', image, '--out', out,
    '--weights', path.join(cfg.dir, 'models', 'TripoSG'),
    '--src', path.join(cfg.dir, 'src', 'TripoSG'),
    '--faces', String(facesForLevel(level)),
    '--seed', String(seed),
    ...(steps ? ['--steps', String(steps)] : []),
    ...(guidance ? ['--guidance', String(guidance)] : []),
  ];
}

/**
 * One TripoSG run: spawn the worker, follow its PROGRESS lines, return the GLB bytes and stats.
 * Cancellation kills the child; a worker failure carries its last lines into the Error message.
 */
export function generateTripoSG({ cfg = triposgConfig(), image, level, seed = 42, steps, guidance, signal, onProgress = () => {}, onWait = () => {}, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const out = path.join(data, 'runtime', 'temp', `triposg-${Date.now().toString(36)}.glb`);
    const [python, script, ...rest] = triposgArgs(cfg, { image, out, level, seed, steps, guidance });
    const env = { ...process.env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      HF_HOME: path.join(cfg.dir, 'cache', 'huggingface'), TORCH_HOME: path.join(cfg.dir, 'cache', 'torch') };
    delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
    const child = spawnFn(python, [script, ...rest], { cwd: cfg.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', err = '', done = false;
    const finish = (fn, value) => { if (!done) { done = true; signal?.removeEventListener('abort', onAbort); fn(value); } };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(reject, Object.assign(new Error('Cancelled'), { cancelled: true })); };
    signal?.addEventListener('abort', onAbort);
    const handle = (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith('PROGRESS ')) {
          const m = line.match(/^PROGRESS (\d+) (.*)$/);
          if (m) onProgress({ percent: Math.min(99, +m[1]), message: m[2] });
          else onWait(line.slice(9));
        } else if (line.startsWith('TRIPOSG_RESULT ')) {
          let stats = {}; try { stats = JSON.parse(line.slice(15)); } catch { /* keep raw */ }
          if (!existsSync(out)) return finish(reject, new Error('TripoSG reported success but no GLB arrived.'));
          finish(resolve, { buffer: readFileSync(out), stats, out });
        } else if (line.startsWith('TRIPOSG_ERROR ')) {
          let msg = line.slice(14); try { msg = JSON.parse(msg).message || msg; } catch { /* raw */ }
          finish(reject, new Error('TripoSG: ' + msg));
        }
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', (c) => { err = (err + c).slice(-16000); });
    child.on('error', (e) => finish(reject, new Error(`TripoSG worker did not start: ${e.message} (${python})`)));
    child.on('exit', (code) => {
      if (done || signal?.aborted) return;
      if (code === 0) return finish(reject, new Error('TripoSG ended without a result line. Last worker output:\n' + (err || buf).slice(-1500)));
      finish(reject, new Error(`TripoSG failed (code ${code}). Last worker output:\n${(err || buf).slice(-1500)}`));
    });
  });
}
