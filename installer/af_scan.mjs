#!/usr/bin/env node
// AstraForge scan core: what this computer already has and what the installer would download.
//
// Platform-neutral and dependency-free (it must run before `npm ci` too): the same scan serves
// every frontend - the interactive `installer/install.sh` (--sh / --table), the studio's Components
// window (ticket 19 imports scanComponents/scanItems) and tests. The Windows frontends
// (Install.ps1 -ScanList, Setup.cs) stay frozen and keep their own copy of this contract.
//
//   node installer/af_scan.mjs --items   one "##ITEM" line per component (13 tab-separated fields):
//        ##ITEM id group status have need bytes name license presets deps only note
//        status: installed | outdated | missing | unavailable;
//        presets: which sets contain this component (letters q=quick, f=full, l=lite);
//        deps: ids of other rows a ticked row pulls in; only: the component ids that -Only installs
//        for this row (empty = the row's own id); note: why an item is outdated/unavailable, or a warning.
//   node installer/af_scan.mjs --table   the same verdicts as a human-readable table (-ScanOnly)
//   node installer/af_scan.mjs --state   KEY=VALUE shell assignments of the scan state
//   node installer/af_scan.mjs --sh      the state assignments followed by the ##ITEM lines (install.sh)
//
// Test hooks: ASTRA_INSTALL_NO_GPU=1 pretends the machine has no NVIDIA card (the Lite branch),
// ASTRA_INSTALL_SCAN_FAIL=1 makes the check fail - the frontend then installs its preset as a whole.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..');

// ids that cannot be unticked in the checklist (the Mandatory of Setup.cs)
export const MANDATORY = ['node', 'npm', 'blender'];
// install order of the component ids (the -Only list of a checklist run, the Order of Setup.cs)
export const ORDER = ['node', 'npm', 'blender', 'comfy', 'comfydeps', 'hy2', 'u2net', 'hymv', 'hy21', 'sdxl',
  'mvadapter', 'godot', 'gltfpack', 'clips', 'vfx', 'ollama', 'llm', 'vlm', 'pixal3d', 'pixal3dw', 'triposg', 'triposgvae', 'triposgdino', 'flux2', 'qwenimg', 'qwenedit', 'qweneditlora',
  'sound', 'soundmoss', 'soundace'];

const G_P = 'Programs';
const G_3D = '3D: shape and views';
const G_2D = '2D and images';
const G_AI = 'AI assistant';
const G_SND = 'Sound and music';

// The manifest pins the Windows archives; these are the Linux download sizes (the same numbers
// install.sh used before the scan core existed).
const SIZE = { node: 32000000, npm: 250000000, blender: 401000000, comfy: 6000000000, comfydeps: 1000000000, godot: 76685794, gltfpack: 1977681, ollama: 1578217944 };
// Pixal3D: the engine download/disk estimates of installer/pixal3d/pixal3d.ps1 ($P3EngineDownload,
// $P3EngineDisk); weights take the sizes of installer/pixal3d/manifest.json + 1.3 GB of slack (DINOv3 copy).
const P3_ENGINE_DOWNLOAD = 5.5e9;
const P3_ENGINE_DISK = 12e9;
const MV_PKG_BYTES = 0.2e9;                       // the MvPkgBytes estimate of mvadapter.ps1
// TripoSG (docs/product/triposg.md, ticket 02): standalone install in runtime/triposg - own venv
// (the CUDA torch wheels dominate the download), the commit-pinned MIT clone, the HF snapshot
// weights with the exact sizes install.sh pins and verifies.
const TS_ENV_DOWNLOAD = 900e6;                            // torch cu128 + the requirements set
const TS_CODE_BYTES = 16411924;                           // the pinned commit archive
const TS_WEIGHTS = [
  ['transformer/diffusion_pytorch_model.safetensors', 5758280104],
  ['vae/diffusion_pytorch_model.safetensors', 970685468],
  ['image_encoder_dinov2/model.safetensors', 1217522888],
];
export const TRIPOSG_AUTO_MAX_VRAM_MIB = 9216;            // the same seam as server/triposg.mjs
// Sound (docs/product/sound.md, ticket 04): standalone install in runtime/sound - one venv for both
// engines (each needs its own transformers line), the two commit-pinned open-source checkouts, and
// the weight snapshots. installer/sound/manifest.json is the single source of the pins (revision +
// size + sha256 per file); only the environment download is an estimate, like Pixal3D's engine.
const SOUND_ENV_DOWNLOAD = 7.0e9;                         // torch cu128 + both engines' libraries
// the NVIDIA driver branch that carries working Blackwell support (ticket 20; the same floor
// as server/gpu-info.mjs - the installer keeps its own copy, like TRIPOSG_AUTO_MAX_VRAM_MIB)
export const MIN_NVIDIA_DRIVER = 570;
/**
 * NVIDIA driver facts from the two sources this branch reads (ticket 36; Windows 0.6.14:
 * "the installer reads the NVIDIA driver version reliably - it sometimes missed it, hiding
 * the warning"). `smiDriver` is nvidia-smi's driver_version column ('[N/A]' when it cannot
 * say); `procText` is /proc/driver/nvidia/version on Linux. `driverUnknown` means a GPU was
 * found but neither source could read the version - that must be SAID, never treated as new.
 */
export function nvidiaDriverFacts(smiDriver, procText, min = MIN_NVIDIA_DRIVER) {
  let driver = /^\d/.test(String(smiDriver || '').trim()) ? String(smiDriver).trim() : '';
  if (!driver && procText) {
    const m = /Kernel Module\s+(\d+(?:\.\d+)*)/.exec(procText);
    if (m) driver = m[1];
  }
  const dm = /^(\d+)/.exec(driver);
  const driverMajor = dm ? Number(dm[1]) : null;
  return { driver, driverMajor, driverOld: driverMajor !== null && driverMajor < min, driverUnknown: driver === '' };
}
export const SOUND_MIN_VRAM_MIB = 8192;                   // the smallest card both engines fit on
export const VLM = 'qwen3-vl:8b';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const isExe = (p) => { try { const st = statSync(p); return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0); } catch { return false; } };
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
const freeOn = (p) => { try { const s = statfsSync(p); return s.bsize * s.bavail; } catch { return null; } };

/** Candidate paths for a program: config key, then env variable, then the given own/system paths. */
const candidates = (cfgKey, envName, cfg, env, ...own) => [cfg[cfgKey], env[envName], ...own].filter(Boolean);

function which(name) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(d, process.platform === 'win32' ? `${name}.exe` : name);
    if (isExe(f)) return f;
  }
  return '';
}

function spawnText(cmd, args, ms = 20000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms });
    return { ok: !r.error && r.status === 0, out: String(r.stdout || '') };
  } catch { return { ok: false, out: '' }; }
}

/** Version of a path or string: first `\d+\.\d+(\.\d+)?` group (the VerOf of Install.ps1). */
export function verOf(s) { const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? m[1] : ''; }
/** Numeric-tuple compare like [version]a -lt [version]b; unparsable is "not less". */
export function verLess(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) { const x = pa[i] || 0; const y = pb[i] || 0; if (x !== y) return x < y; }
  return false;
}

/**
 * Ollama models on disk and from a running server - never `ollama list`: with a stopped server the
 * client may start the tray app and hold the scan (the reason Install.ps1 reads /api/tags, 2 s).
 */
function ollamaModels(env) {
  const names = new Set();
  try {
    const r = spawnText('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:11434/api/tags'], 6000);
    if (r.ok) for (const m of (JSON.parse(r.out).models || [])) if (m && m.name) names.add(m.name);
  } catch { /* server not up or no curl */ }
  try {
    const root = path.join(env.OLLAMA_MODELS || path.join(env.HOME || '', '.ollama', 'models'), 'manifests', 'registry.ollama.ai');
    for (const ns of readdirSync(root)) for (const nm of readdirSync(path.join(root, ns))) for (const tg of readdirSync(path.join(root, ns, nm))) {
      if (/^[0-9a-f]{64}$/.test(tg)) continue; // a sha-only manifest is a revision, not a tag
      names.add(ns === 'library' ? `${nm}:${tg}` : `${ns}/${nm}:${tg}`);
    }
  } catch { /* nothing on disk */ }
  return [...names];
}

/** Model dirs: the app data folder plus the ComfyUI's own trees (dir and its alt name). */
function modelDirs(root, comfy, sub) {
  const alt = { unet: 'diffusion_models', text_encoders: 'clip', vae: 'vae', checkpoints: 'checkpoints' }[sub] || sub;
  const out = [path.join(root, 'data', 'models', sub)];
  if (comfy) out.push(path.join(comfy, 'models', sub), path.join(comfy, 'models', alt));
  return out;
}

/**
 * A symlink the weight-connector (installer/af_weights.mjs, ticket 40) left behind points outside
 * the studio's own folders: that file is reused, not owned - say so in the status and the human
 * column. A real file, or a link into data/ or the configured ComfyUI, is the plain installed.
 */
function externLink(f, root, comfy) {
  try {
    if (!lstatSync(f).isSymbolicLink()) return '';
    const real = realpathSync(f);
    const own = [path.join(root, 'data'), comfy ? path.join(comfy, 'models') : null].filter(Boolean);
    return own.some((o) => real === o || real.startsWith(o + path.sep)) ? '' : real;
  } catch { return ''; }
}

/**
 * installed | outdated | missing for manifest models (the ModelState of Install.ps1): the first id
 * not on disk makes the set missing; a file of another size makes it outdated. u2net is found by
 * name under data/models/background (where both the studio and rembg keep it). A file that turns
 * out to be a connector's external link reports extern (the truth for "installed (external)").
 */
export function modelState(root, comfy, man, id) {
  const m = man.models[id];
  let where = '';
  if (id === 'u2net') {
    const base = path.join(root, 'data', 'models', 'background');
    const stack = [base];
    while (stack.length) {
      const d = stack.pop();
      let ents = [];
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) stack.push(f);
        else if (e.name === m.file) {
          where = d;
          if (m.size && sizeOf(f) !== m.size) return { st: 'outdated', where };
          const ex = externLink(f, root, comfy);
          return { st: 'installed', where: ex ? path.dirname(ex) : where, extern: ex };
        }
      }
    }
    return { st: 'missing', where: '' };
  }
  const sub = m.dir || 'checkpoints';
  for (const d of modelDirs(root, comfy, sub)) {
    const f = path.join(d, m.file);
    if (existsSync(f)) {
      where = d;
      if (m.size && sizeOf(f) !== m.size) return { st: 'outdated', where };
      break;
    }
  }
  if (!where) return { st: 'missing', where: '' };
  const ex = externLink(path.join(where, m.file), root, comfy);
  return { st: 'installed', where: ex ? path.dirname(ex) : where, extern: ex };
}
const multiState = (root, comfy, man, ids) => {
  let where = '';
  let st = 'installed';
  for (const id of ids) {
    const x = modelState(root, comfy, man, id);
    if (x.st === 'missing') return { st: 'missing', where: '' };
    if (!where) where = x.where;
    if (x.st === 'outdated') st = 'outdated';
  }
  return { st, where };
};
const sumSizes = (man, ids) => ids.reduce((n, id) => n + (man.models[id] ? man.models[id].size : 0), 0);

function recommendLlm(man, vramMiB) {
  for (const t of man.llm.byVram) if (vramMiB >= t.minVramMiB) return t;
  return man.llm.byVram.at(-1);
}

/** MV-Adapter state (MvScan of mvadapter.ps1): the patched node, its weights, config and Python modules. */
export function mvScan(s) {
  const r = { node: false, weights: false, config: false, pkgs: false, ready: false, offer: true, reason: '', warn: '', bytes: 0 };
  let man;
  try { man = readJson(path.join(s.root, 'installer', 'mvadapter', 'manifest.json')); } catch { r.offer = false; r.reason = 'installer/mvadapter/manifest.json is missing'; return r; }
  const wSize = man.files[0].size;
  const wPath = path.join(s.root, 'data', 'models', 'mvadapter', man.files[0].path);
  const nodeDir = path.join(s.root, 'data', 'runtime', 'custom_nodes', 'ComfyUI-MVAdapter');
  try {
    r.node = existsSync(path.join(nodeDir, 'astra_views.py')) && /local_sdxl_config/.test(readFileSync(path.join(nodeDir, 'utils.py'), 'utf8'));
  } catch { r.node = false; }
  r.weights = sizeOf(wPath) === wSize;
  r.config = existsSync(path.join(s.root, 'data', 'models', 'mvadapter', 'sdxl-config', 'model_index.json'));
  if (s.comfy) {
    const py = path.join(s.comfy, s.pyRel);
    const names = Object.keys(man.modules).map((m) => `'${m}'`).join(', ');
    const chk = spawnText(py, ['-c', `import importlib.util as u; print(' '.join(m for m in [${names}] if u.find_spec(m) is None))`], 60000);
    r.pkgs = chk.ok && !chk.out.trim();
  }
  r.ready = r.node && r.weights && r.config && r.pkgs;
  if (!r.ready) {
    if (!s.gpu) { r.offer = false; r.reason = 'needs an NVIDIA graphics card'; }
    else if (s.vram < 7900) { r.offer = false; r.reason = `video memory is ${Math.round(s.vram / 1024)} GB, at least 8 GB needed`; }
    else if (s.vram < 10000) r.warn = `video memory is ${Math.round(s.vram / 1024)} GB: views render only at 512 px on 8 GB and memory may fall short, 10 GB+ is comfortable`;
  }
  if (!r.weights) r.bytes += wSize;
  if (!r.node || !r.pkgs) r.bytes += MV_PKG_BYTES;
  return r;
}

/** Pixal3D state (P3Scan of pixal3d.ps1): the portable ComfyUI in runtime/ComfyUI-Pixal3D. */
export function p3Scan(s) {
  const r = { dir: '', exists: false, engine: false, weights: false, complete: false, offer: true, reason: '', warn: '', missingBytes: 0, diskNeed: 0 };
  let man;
  try { man = readJson(path.join(s.root, 'installer', 'pixal3d', 'manifest.json')); } catch { r.offer = false; r.reason = 'installer/pixal3d/manifest.json is missing'; return r; }
  const env = s.env;
  const cands = env.ASTRA_PIXAL3D_DIR
    ? [env.ASTRA_PIXAL3D_DIR]
    : candidates('pixal3dDir', 'ASTRA_PIXAL3D_DIR', s.cfg, env, path.join(s.rt, 'ComfyUI-Pixal3D'));
  const probe = (dir) => {
    const p = { dir, exists: existsSync(dir), python: false, comfy: false, node: false, patched: false, weights: false, missingBytes: 0 };
    p.python = isExe(path.join(dir, '.venv', 'bin', 'python'));           // the uv venv (python_embeded on Windows)
    p.comfy = existsSync(path.join(dir, 'ComfyUI', 'main.py'));
    const nodes = path.join(dir, 'ComfyUI', 'custom_nodes', 'ComfyUI-Trellis2', 'nodes.py');
    p.node = existsSync(nodes);
    try { p.patched = p.node && readFileSync(nodes, 'utf8').includes('ASTRAFORGE PATCH'); } catch { p.patched = false; }
    p.engine = p.python && p.comfy && p.node && p.patched;
    const md = path.join(dir, 'ComfyUI', 'models');
    const files = [];
    for (const f of man.pixal3d.files) files.push({ p: path.join(md, 'TencentARC', 'Pixal3D', f.path), size: f.size });
    for (const f of man.moge.files) files.push({ p: path.join(md, 'Ruicheng', 'moge-2-vitl', f.path), size: f.size });
    const dino = man.dinov3.files.find((f) => f.path === 'model.safetensors');
    files.push({ p: path.join(md, 'facebook', 'dinov3-vitl16-pretrain-lvd1689m', 'model.safetensors'), size: dino ? dino.size : 0 });
    files.push({ p: path.join(dir, 'cache', 'torch', 'hub', 'checkpoints', 'naf_release.pth'), size: man.naf.checkpoint.size });
    p.missingBytes = files.reduce((n, f) => n + (sizeOf(f.p) === f.size ? 0 : f.size), 0);
    p.weights = p.missingBytes === 0;
    return p;
  };
  const probed = cands.map(probe);
  const p = probed.find((x) => x.engine && x.weights) || probed.find((x) => x.python || x.comfy || x.node) || probed[0] || probe(cands[0]);
  Object.assign(r, { dir: p.dir, exists: p.exists, engine: p.engine, weights: p.weights, missingBytes: p.missingBytes });
  r.complete = r.engine && r.weights;
  if (r.complete && s.driverOld) r.warn = `installed, but Pixal3D refuses to run below NVIDIA driver ${MIN_NVIDIA_DRIVER} (this machine reports ${s.driver})`;
  if (!r.complete) {
    if (!s.gpu) { r.offer = false; r.reason = 'needs an NVIDIA RTX graphics card'; }
    else if (s.vram < 7900) { r.offer = false; r.reason = `video memory is ${Math.round(s.vram / 1024)} GB, at least 8 GB needed (10+ preferred)`; }
    else if (s.cc && parseFloat(s.cc) < 8.0) { r.offer = false; r.reason = 'needs an NVIDIA RTX 30-series or newer (Ampere and above)'; }
    else if (!s.cc && !/RTX\s*(30|40|50|A\d|PRO)/i.test(s.gpu)) { r.offer = false; r.reason = 'needs an NVIDIA RTX 30/40/50'; }
    else if (s.driverOld) { r.offer = false; r.reason = `needs NVIDIA driver ${MIN_NVIDIA_DRIVER} or newer (this machine reports ${s.driver}) - update the driver, then run the installer again: Pixal3D would not run with it anyway`; }
    else if (s.vram < 10000) r.warn = `video memory is ${Math.round(s.vram / 1024)} GB: several views on 8 GB may fall short of memory, 10+ GB recommended`;
    if (s.driverUnknown && r.offer && !r.warn) r.warn = `the NVIDIA driver version could not be read (neither nvidia-smi nor /proc/driver/nvidia/version answered) - Pixal3D needs driver ${MIN_NVIDIA_DRIVER} or newer; if it refuses to start, update the driver`;
    if (r.offer) {
      r.diskNeed = (r.engine ? 0 : P3_ENGINE_DISK) + (r.weights ? 0 : r.missingBytes);
      const free = freeOn(path.dirname(r.dir));
      if (free !== null && free < r.diskNeed + 3.3e9) { r.offer = false; r.reason = `not enough free space on ${r.dir} (about ${(r.diskNeed / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free)`; }
    }
  }
  return r;
}

/** TripoSG state (docs/product/triposg.md): venv + pinned clone + snapshot weights on disk. */
export function triposgScan(s) {
  const r = { dir: '', env: false, code: false, weights: false, complete: false, offer: true, reason: '', missingBytes: 0 };
  const cands = s.env.ASTRA_TRIPOSG_DIR
    ? [s.env.ASTRA_TRIPOSG_DIR]
    : candidates('triposgDir', 'ASTRA_TRIPOSG_DIR', s.cfg, s.env, path.join(s.rt, 'triposg'));
  const probe = (dir) => {
    const p = { dir, env: isExe(path.join(dir, '.venv', 'bin', 'python')), code: existsSync(path.join(dir, 'src', 'TripoSG', 'triposg', 'pipelines', 'pipeline_triposg.py')) };
    p.missingBytes = TS_WEIGHTS.reduce((n, [rel, sz]) => n + (sizeOf(path.join(dir, 'models', 'TripoSG', rel)) === sz ? 0 : sz), 0);
    p.weights = p.missingBytes === 0 && existsSync(path.join(dir, 'models', 'TripoSG', 'model_index.json'));
    return p;
  };
  const probed = cands.map(probe);
  const p = probed.find((x) => x.env && x.code && x.weights) || probed[0];
  Object.assign(r, { dir: p.dir, env: p.env, code: p.code, weights: p.weights, missingBytes: p.missingBytes });
  r.complete = r.env && r.code && r.weights;
  if (!r.complete) {
    if (!s.gpu) { r.offer = false; r.reason = 'needs an NVIDIA graphics card'; }
    else if (s.vram > 0 && s.vram < 4000) { r.offer = false; r.reason = `video memory is ${Math.round(s.vram / 1024)} GB, TripoSG needs about 4 GB`; }
  }
  return r;
}

/** Sound state (docs/product/sound.md): one venv, both engine checkouts, both weight snapshots. */
export function soundScan(s) {
  const r = { dir: '', env: false, code: false, weights: false, complete: false, offer: true, reason: '', missingBytes: 0, codeBytes: 0, weightBytes: 0 };
  let man;
  try { man = readJson(path.join(s.root, 'installer', 'sound', 'manifest.json')); } catch { r.offer = false; r.reason = 'installer/sound/manifest.json is missing'; return r; }
  const files = Object.values(man.models).flatMap((m) => m.files.map((f) => [path.join(m.dst, f.path), f.size]));
  r.codeBytes = Object.values(man.code).reduce((n, c) => n + c.size, 0);
  r.weightBytes = files.reduce((n, [, sz]) => n + sz, 0);
  const cands = s.env.ASTRA_SOUND_DIR
    ? [s.env.ASTRA_SOUND_DIR]
    : candidates('soundDir', 'ASTRA_SOUND_DIR', s.cfg, s.env, path.join(s.rt, 'sound'));
  const probe = (dir) => {
    const p = { dir, env: isExe(path.join(dir, '.venv', 'bin', 'python')) };
    p.code = existsSync(path.join(dir, 'src', 'MOSS-TTS', 'moss_soundeffect_v2', 'pyproject.toml'))
      && existsSync(path.join(dir, 'src', 'ACE-Step-1.5', 'pyproject.toml'));
    p.missingBytes = files.reduce((n, [rel, sz]) => n + (sizeOf(path.join(dir, 'models', rel)) === sz ? 0 : sz), 0);
    p.weights = p.missingBytes === 0;
    return p;
  };
  const probed = cands.map(probe);
  const p = probed.find((x) => x.env && x.code && x.weights) || probed[0];
  Object.assign(r, { dir: p.dir, env: p.env, code: p.code, weights: p.weights, missingBytes: p.missingBytes });
  r.complete = r.env && r.code && r.weights;
  if (!r.complete) {
    if (!s.gpu) { r.offer = false; r.reason = 'needs an NVIDIA graphics card'; }
    else if (s.vram > 0 && s.vram < SOUND_MIN_VRAM_MIB) { r.offer = false; r.reason = `video memory is ${Math.round(s.vram / 1024)} GB, the Sound models need about 8 GB`; }
  }
  return r;
}

/**
 * Scan the machine. opts = { root, env, noGpu, fail }. Throws when the check fails
 * (ASTRA_INSTALL_SCAN_FAIL=1 / opts.fail) or the folder is not the application folder -
 * frontends fall back to installing their preset as a whole.
 */
export function scanComponents(opts = {}) {
  const env = opts.env || process.env;
  if (opts.fail || env.ASTRA_INSTALL_SCAN_FAIL) throw new Error('ASTRA_INSTALL_SCAN_FAIL=1: the computer check failed on purpose');
  const root = opts.root || APP_ROOT;
  const rt = path.join(root, 'runtime');
  let man;
  try { man = readJson(path.join(root, 'installer', 'manifest.json')); } catch { throw new Error('installer/manifest.json is missing - this is not the application folder'); }
  let cfg = {};
  try { cfg = readJson(path.join(root, 'config', 'paths.json')); } catch { /* no config yet */ }

  const pyRel = process.platform === 'win32' ? path.join('.venv', 'Scripts', 'python.exe') : path.join('.venv', 'bin', 'python');
  const s = { root, rt, env, cfg, man, pyRel, gpu: '', vram: 0, cc: '', adapters: [], gpuBroken: '',
    node: '', nodeVer: '', npmDeps: false, ui: false, blender: '', blenderVer: '', comfy: '', comfyVer: '', comfyDeps: false, driver: '', driverMajor: null, driverOld: false,
    gguf: false, godot: '', godotVer: '', gltfpack: '', gltfpackVer: '', clips: 0, library: '', vfxDir: '', vfxOk: false, ollama: '', llms: [], vlm: false };

  // --- GPU: name/VRAM/compute capability from nvidia-smi; lspci only names the cards in the warning
  if (env.ASTRA_INSTALL_NO_GPU || opts.noGpu) {
    s.adapters = ['AMD Radeon (test)'];
  } else {
    const smi = which('nvidia-smi') || (process.platform === 'win32'
      ? [path.join(env.SystemRoot || 'C:/Windows', 'System32', 'nvidia-smi.exe')].find(isExe) : '');
    if (smi) {
      const out = spawnText(smi, ['--query-gpu=name,memory.total,compute_cap,driver_version', '--format=csv,noheader,nounits'], 15000).out;
      const parts = (out.split('\n')[0] || '').split(',').map((x) => x.trim());
      if (parts.length >= 3 && parts[0] && /^\d+(\.\d+)?$/.test(parts[2])) {
        s.gpu = parts[0]; s.vram = parseInt(parts[1], 10) || 0; s.cc = parts[2];
        // [N/A] on old nvidia-smi: /proc/driver/nvidia/version is the second source before
        // the version counts as unknown (ticket 36; env seam for the tests).
        let procText = '';
        if (process.platform !== 'win32') { try { procText = readFileSync(env.ASTRA_NVIDIA_VERSION_FILE || '/proc/driver/nvidia/version', 'utf8'); } catch { procText = ''; } }
        Object.assign(s, nvidiaDriverFacts(parts[3], procText));
      }
      else s.gpuBroken = `nvidia-smi answered unexpectedly: ${parts.join(', ') || 'no output'}`;
    }
    if (which('lspci')) {
      s.adapters = spawnText(which('lspci'), ['-nn'], 10000).out.split('\n')
        .map((l) => l.replace(/^[0-9a-f:.]+\s+[^:]+:\s*/, '').replace(/\[\w+:\w+\].*$/, '').trim())
        .filter((l) => /VGA|3D controller|Display/i.test(l) && !/Basic Display|Virtual|Parsec/i.test(l));
    }
  }
  s.noGpu = !s.gpu && !s.gpuBroken;

  // --- Node.js >= 22.12, the studio build, Blender 5.x
  for (const n of candidates('node', 'ASTRA_NODE', cfg, env, path.join(rt, 'node', 'bin', 'node'), path.join(rt, 'node', 'node.exe'), which('node'))) {
    if (!isExe(n)) continue;
    const v = spawnText(n, ['-v'], 10000).out.trim().replace(/^v/, '');
    const [maj, min] = v.split('.').map((x) => parseInt(x, 10) || 0);
    if (maj > 22 || (maj === 22 && min >= 12)) { s.node = n; s.nodeVer = v; break; }
  }
  s.npmDeps = existsSync(path.join(root, 'node_modules', 'express'));
  s.ui = existsSync(path.join(root, 'dist', 'index.html'));
  for (const b of candidates('blender', 'ASTRA_BLENDER', cfg, env,
    path.join(rt, 'blender', 'blender-5.0.1-linux-x64', 'blender'), path.join(rt, 'blender', 'blender-5.0.1-windows-x64', 'blender.exe'), which('blender'))) {
    if (!isExe(b)) continue;
    const out = spawnText(b, ['--version'], 30000).out.split('\n')[0] || '';
    const m = /Blender\s+(\d+)(\.\d+(?:\.\d+)?)/.exec(out);
    if (m && m[1] === '5') { s.blender = b; s.blenderVer = `${m[1]}${m[2]}`; break; }
  }

  // --- ComfyUI of the studio: venv + main.py + the Hunyuan3D nodes mark the app's copy
  const comfyOk = (c) => c && isExe(path.join(c, pyRel)) && existsSync(path.join(c, 'main.py')) && existsSync(path.join(c, 'comfy_extras', 'nodes_hunyuan3d.py'));
  s.comfy = candidates('comfyDir', 'ASTRA_COMFY_DIR', cfg, env, path.join(rt, 'ComfyUI')).find(comfyOk) || '';
  if (s.comfy) {
    try { const m = /__version__\s*=\s*"([\d.]+)"/.exec(readFileSync(path.join(s.comfy, 'comfyui_version.py'), 'utf8')); if (m) s.comfyVer = m[1]; } catch { /* no version file: treated as current */ }
    s.comfyDeps = spawnText(path.join(s.comfy, pyRel), ['-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(path.join(root, 'data', 'python'))}); import torch, rembg, skimage, numba, onnxruntime, xatlas`], 120000).ok;
  }
  s.gguf = [path.join(root, 'data', 'runtime', 'custom_nodes', 'ComfyUI-GGUF', 'nodes.py'),
    s.comfy ? path.join(s.comfy, 'custom_nodes', 'ComfyUI-GGUF', 'nodes.py') : ''].some((p) => p && existsSync(p));

  // --- Godot, models, clip library, VFX, Ollama, MV-Adapter, Pixal3D
  s.godot = candidates('godot', 'ASTRA_GODOT', cfg, env,
    path.join(rt, 'Godot', 'Godot_v4.5.1-stable_linux.x86_64'), path.join(rt, 'godot'), which('godot'), which('godot4')).find((g) => isExe(g)) || '';
  if (s.godot) {
    const out = spawnText(s.godot, ['--version'], 15000).out.split('\n')[0] || '';
    s.godotVer = verOf(out) || verOf(path.basename(s.godot));
  }
  // gltfpack (0.7.9 fold wave ticket 56): the LOD fallback and the compact.glb writer of the
  // convert step; the installer unpacks the pinned official release into runtime/gltfpack
  s.gltfpack = candidates('gltfpack', 'ASTRA_GLTFPACK', cfg, env,
    path.join(rt, 'gltfpack', 'gltfpack'), which('gltfpack')).find((g) => isExe(g)) || '';
  s.gltfpackVer = s.gltfpack ? String(man.programs.gltfpack.version || '') : '';
  for (const id of ['hy2', 'hymv', 'hy21', 'sdxl', 'u2net']) s[id] = modelState(root, s.comfy, man, id);
  // the 2D engines install as a set (weights + text encoder + VAE): one verdict per engine
  s.flux2 = multiState(root, s.comfy, man, ['flux2', 'flux2te', 'flux2vae']);
  s.qwenedit = multiState(root, s.comfy, man, ['qwenedit', 'qweneditlora', 'qwente', 'qwenvae']);
  // replaced-but-retained weights (ticket 09): the klein 9B era's files, kept as the user's property
  s.flux2old = (() => {
    if (!s.comfy) return [];
    const dir = path.join(s.comfy, 'models', 'unet');
    try { return readdirSync(dir).filter((f) => /flux-2-klein.*9b.*\.gguf$/i.test(f)).map((f) => ({ name: f, size: statSync(path.join(dir, f)).size })); } catch { return []; }
  })();
  s.qwenimg = multiState(root, s.comfy, man, ['qwenimg', 'qwente', 'qwenvae']);
  s.library = cfg.library || env.ASTRA_FORGE_LIBRARY || path.join(root, 'library');
  const quats = path.join(s.library, 'animations', 'quaternius');
  try { s.clips = readdirSync(quats).filter((f) => f.endsWith('.fbx')).length; } catch { s.clips = 0; }
  s.vfxDir = cfg.vfxTools || path.join(rt, 'vfx');
  // the same marker as the Windows Scan (apps/material-maker/material_maker.exe), Linux builds included
  s.vfxOk = ['material_maker.exe', 'material_maker.x86_64', 'material_maker']
    .some((n) => existsSync(path.join(s.vfxDir, 'apps', 'material-maker', n)));
  s.ollama = candidates('ollama', 'ASTRA_OLLAMA', cfg, env, which('ollama')).find((o) => isExe(o)) || '';
  s.llms = s.ollama ? ollamaModels(env) : [];
  s.vlm = s.llms.includes(VLM);
  s.mv = mvScan(s);
  s.p3 = p3Scan(s);
  s.ts = triposgScan(s);
  s.snd = soundScan(s);
  s.free = freeOn(root);
  return s;
}

// «Новое, проба» (ticket 12): components this branch classes as experimental. The flag
// drives: no preset preselection (profileIds filter + empty presets), the checklist/panel marker,
// and the install.sh -Profile fallback (its mirror lists omit these ids too). 'skintokens' is
// listed for the day it lands - ticket 03 kept it out of this branch on license grounds.
export const EXPERIMENTAL = ['triposg', 'skintokens', 'sound', 'qwenedit'];

/** Checklist rows in the reference ##ITEM semantics; display strings in English (branch policy). */
export function scanItems(s) {
  const { man, noGpu } = s;
  const items = [];
  const gpuNote = noGpu ? "won't work without an NVIDIA GPU" : '';
  // «Новое, проба» (0.6.x wave ticket 12): experimental components are never preselected by
  // any preset - the checklist, -Profile installs and the Components window all tick them only by
  // an explicit click. Upstream's exception (forcing TripoSG into the low-VRAM quick set, ticket
  // 02's swap rule) stays on the Windows side and is NOT ported - the rule here is unconditional
  // opt-in, recorded as the ticket's deviation. manifest.json stays the Windows pin it is.
  const profileIds = (p) => (man.profiles[p] || []).filter((i) => !EXPERIMENTAL.includes(i));
  const profilesOf = (only) => ['quick', 'full', 'lite']
    .filter((p) => only.split(',').filter(Boolean).some((id) => profileIds(p).includes(id))).map((p) => p[0]).join('');
  const add = (id, group, status, have, need, size, name, lic, deps = '', only = '', note = '') => {
    const o = only || id;
    const exp = o.split(',').filter(Boolean).some((x) => EXPERIMENTAL.includes(x));
    const txt = `${note || ''}`.replace(/[\t\r\n]+/g, ' ').trim();
    items.push({ id, group, status, have, need, size: Math.round(size), name, lic: lic || '', presets: profilesOf(o), deps, only: o, exp, note: exp && !/never preselected/.test(txt) ? [txt, 'new in 0.6.x, still a try - no preset preselects it, tick it by hand'].filter(Boolean).join(' - ') : txt });
  };
  add('node', G_P, s.node ? 'installed' : 'missing', s.node ? `${s.nodeVer} · ${s.node}` : '', man.programs.node.version, SIZE.node, 'Node.js', 'MIT');
  add('npm', G_P, s.npmDeps && s.ui ? 'installed' : 'missing', s.npmDeps && s.ui ? 'in the application folder' : '', '', SIZE.npm, 'Studio interface and libraries', 'open-source licenses of npm packages', 'node');
  add('blender', G_P, s.blender ? 'installed' : 'missing', s.blender ? `${s.blenderVer} · ${s.blender}` : '', man.programs.blender.version, SIZE.blender, 'Blender', 'GPL-3.0');
  add('godot', G_P, s.godot ? 'installed' : 'missing', s.godot ? `${s.godotVer} · ${s.godot}` : '', '4.5.1', SIZE.godot, 'Godot 4.5 (game package validation)', 'MIT');
  add('gltfpack', G_P, s.gltfpack ? 'installed' : 'missing', s.gltfpack || '', 'v1.3', SIZE.gltfpack,
    'gltfpack (LOD levels and compact GLB)', man.programs.gltfpack.license, '', '',
    'the convert step writes LOD files and compact.glb with it (af-mesh-rs stays primary for LODs)');
  add('clips', G_P, s.clips > 0 ? 'installed' : 'missing', s.clips > 0 ? `${s.clips} clips` : '', '', man.clips.size, 'Quaternius / ActionForge animations', man.clips.license, 'blender');
  add('vfx', G_P, s.vfxOk ? 'installed' : 'missing', s.vfxOk ? s.vfxDir : '', '', man.vfx.size, 'VFX texture generators', man.vfx.license);
  const cNeed = String(man.programs.comfy.version).replace(/^v/, '');
  const comfyName = 'ComfyUI + Python + PyTorch (generation engine)';
  if (!s.comfy) add('comfy', G_3D, 'missing', '', cNeed, SIZE.comfy, comfyName, 'GPL-3.0 / BSD', '', '', gpuNote);
  else if (s.comfyVer && verLess(s.comfyVer, cNeed)) add('comfy', G_3D, 'outdated', `${s.comfyVer} · ${s.comfy}`, cNeed, SIZE.comfy, comfyName, 'GPL-3.0 / BSD', '', '', 'old version: a copy goes into the application folder');
  else if (!s.comfyDeps) add('comfy', G_3D, 'outdated', `${s.comfyVer} · ${s.comfy}`, cNeed, SIZE.comfydeps, comfyName, 'GPL-3.0 / BSD', '', 'comfydeps', 'Python libraries are missing - they will be added');
  else add('comfy', G_3D, 'installed', `${s.comfyVer} · ${s.comfy}`, cNeed, SIZE.comfy, comfyName, 'GPL-3.0 / BSD');
  for (const [id, name, group] of [['hy2', 'Hunyuan3D-2: 3D from a picture', G_3D], ['u2net', 'u2net: background removal', G_3D],
    ['hymv', 'Hunyuan3D-2mv: 3D from front and back views', G_3D], ['hy21', 'Hunyuan3D-2.1: a second shape model', G_3D], ['sdxl', 'SDXL: images and views', G_2D]]) {
    const st = s[id];
    add(id, group, st.extern ? 'installed (external)' : st.st, st.where, '', man.models[id].size, name, man.models[id].license, 'comfy', '', st.st === 'outdated' ? 'file of another version - update' : gpuNote);
  }
  const mvName = 'MV-Adapter: views from a single picture';
  if (s.mv.ready) add('mvadapter', G_3D, 'installed', 'in the application folder', '', s.mv.bytes, mvName, 'Apache-2.0', 'sdxl,comfy');
  else if (s.mv.offer) add('mvadapter', G_3D, 'missing', '', '', s.mv.bytes, mvName, 'Apache-2.0', 'sdxl,comfy', '', s.mv.warn);
  else add('mvadapter', G_3D, 'unavailable', '', '', 0, mvName, 'Apache-2.0', '', '', s.mv.reason);
  const p3Name = 'Pixal3D (TRELLIS.2): shape from 1-4 views';
  if (s.p3.complete) add('pixal3d', G_3D, 'installed', s.p3.dir, '', 0, p3Name, 'MIT; DINOv3', '', 'pixal3d,pixal3dw', s.p3.warn);
  else if (s.p3.offer) add('pixal3d', G_3D, 'missing', '', '', (s.p3.engine ? 0 : P3_ENGINE_DOWNLOAD) + (s.p3.weights ? 0 : s.p3.missingBytes),
    p3Name, 'MIT; DINOv3', '', s.p3.engine ? 'pixal3dw' : s.p3.weights ? 'pixal3d' : 'pixal3d,pixal3dw', s.p3.warn);
  else add('pixal3d', G_3D, 'unavailable', '', '', 0, p3Name, 'MIT; DINOv3', '', 'pixal3d,pixal3dw', s.p3.reason);
  const tsName = 'TripoSG: shape from a single picture (the low-VRAM path)';
  const tsLic = 'MIT (VAST-AI); Apache-2.0 (DINOv2)';
  const tsOnly = 'triposg,triposgvae,triposgdino';
  if (s.ts.complete) add('triposg', G_3D, 'installed', s.ts.dir, '', 0, tsName, tsLic, '', tsOnly);
  else if (s.ts.offer) add('triposg', G_3D, 'missing', '', '', (s.ts.env ? 0 : TS_ENV_DOWNLOAD + TS_CODE_BYTES) + (s.ts.weights ? 0 : s.ts.missingBytes),
    tsName, tsLic, '', tsOnly, gpuNote);
  else add('triposg', G_3D, 'unavailable', '', '', 0, tsName, tsLic, '', tsOnly, s.ts.reason);
  // Sound (ticket 04): its own row group, and no preset contains the id - the component is new and
  // installs only when the user ticks it (or calls -Only sound).
  const sndName = 'Sound: effects by description + music loops';
  const sndLic = 'Apache-2.0 (MOSS-SoundEffect); MIT (ACE-Step)';
  const sndOnly = 'sound,soundmoss,soundace';
  if (s.snd.complete) add('sound', G_SND, 'installed', s.snd.dir, '', 0, sndName, sndLic, '', sndOnly);
  else if (s.snd.offer) add('sound', G_SND, 'missing', '', '', (s.snd.env ? 0 : SOUND_ENV_DOWNLOAD + s.snd.codeBytes) + (s.snd.weights ? 0 : s.snd.missingBytes),
    sndName, sndLic, '', sndOnly, gpuNote);
  else add('sound', G_SND, 'unavailable', '', '', 0, sndName, sndLic, '', sndOnly, s.snd.reason);
  for (const [id, ids, name, licNote] of [['flux2', ['flux2', 'flux2te', 'flux2vae'], 'FLUX.2 klein 4B: 2D by description and references', 'Apache-2.0 - commercial use OK'],
    ['qwenimg', ['qwenimg', 'qwente', 'qwenvae'], 'Qwen-Image: 2D by description, readable text in pictures', ''],
    ['qwenedit', ['qwenedit', 'qweneditlora', 'qwente', 'qwenvae'], 'Qwen-Image-Edit 2511: style series from the style bible', 'Apache-2.0 - 10 GB card or bigger']]) {
    const ms = s[id];                        // the set verdict from scanComponents (no re-probing here)
    let status = ms.st;
    if (status !== 'missing' && !s.gguf) status = 'outdated';
    let note = noGpu ? 'needs an NVIDIA graphics card' : status === 'outdated' ? 'another file version or no GGUF loader - update' : licNote;
    if (noGpu && status !== 'installed') status = 'unavailable';
    if (id === 'qwenedit' && status === 'missing' && s.vram > 0 && s.vram < 10240) {
      // the ticket-07 gate: below 10 GiB the style is drawn by FLUX.2 klein, this row says so and bows out
      status = 'unavailable';
      note = `the card has ${Math.round(s.vram / 1024)} GB - style series are drawn by FLUX.2 klein on smaller cards`;
    }
    if (id === 'flux2' && s.flux2old?.length) {
      // the pre-0.6.6 9B weights are the user's files: never used, never deleted, always named (ticket 09)
      const gb = Math.round(s.flux2old.reduce((n, f) => n + f.size, 0) / 1e8) / 10;
      note = (note ? note + '; ' : '') + `the previous klein 9B (${gb} GB on disk) is kept and unused - delete it yourself to free the space`;
    }
    add(id, G_2D, status, ms.where, '', sumSizes(man, ids), name, man.models[ids[0]].license, 'comfy', '', note);
  }
  add('ollama', G_AI, s.ollama ? 'installed' : 'missing', s.ollama || '', '', SIZE.ollama, 'Ollama (local AI models)', 'MIT');
  const llm = recommendLlm(man, s.vram);
  add('llm', G_AI, s.llms.includes(llm.model) ? 'installed' : 'missing', s.llms.length ? `have: ${s.llms.join(', ')}` : '', llm.model, llm.size,
    `Assistant ${llm.model} (picked for the GPU)`, 'Apache-2.0 (Qwen3)', 'ollama');
  add('vlm', G_AI, s.vlm ? 'installed' : 'missing', s.vlm ? VLM : '', VLM, man.llm.vlm.size, `Texture and animation check ${VLM}`, 'Apache-2.0 (Qwen3-VL)', 'ollama',
    '', s.vram > 0 && s.vram < 8000 ? 'less than 8 GB of video memory - it will run slowly' : '');
  return items;
}

/** ##ITEM lines - the frontend contract (13 tab-separated fields incl. the marker).
 *  Values are collapsed like the $emit of Install.ps1: one line per component, no stray tabs. */
export function itemLines(items) {
  const clean = (v) => `${v ?? ''}`.replace(/[\t\r\n]+/g, ' ').trim();
  return items.map((it) => ['##ITEM', it.id, it.group, it.status, it.have, it.need, String(it.size), it.name,
    it.lic, it.presets, it.deps, it.only, it.note].map(clean).join('\t'));
}

const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
// the Size() of Install.ps1: MB below a gigabyte, GB above
const size = (b) => (b >= 1e9 ? gb(b) : `${Math.round(b / 1e6)} MB`);
/** Human verdict table (-ScanOnly): found/version/location, download size, update and reason lines. */
export function scanTable(items) {
  const out = ['', '== What is on this computer and what the installer would download =='];
  let group = '';
  for (const it of items) {
    if (it.group !== group) { group = it.group; out.push(`-- ${group}`); }
    const marks = ['q', 'f', 'l'].map((p) => (it.presets.includes(p) ? p : '-')).join('');
    const verdict = it.status.startsWith('installed') ? `installed${it.status === 'installed (external)' ? ' (external)' : ''} · ${it.have}`
      : it.status === 'outdated' ? `update (${size(it.size)})${it.have ? `: ${it.have}` : ''}`
      : it.status === 'missing' ? `download ${size(it.size)}${it.need ? `, ${it.need}` : ''}`
      : `unavailable: ${it.note || 'this computer cannot run it'}`;
    out.push(`  [${marks}] ${it.name} [${it.id}]`.padEnd(62, ' ') + verdict
      + (it.status === 'outdated' && it.note ? ` - ${it.note}` : ''));
  }
  return out;
}

/** Shell assignments for installer/install.sh (the checklist and the install loop share this state). */
export function stateLines(s) {
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const st = (x) => (x ? x.st : 'missing');
  const pairs = {
    S_GPU: s.gpu, S_VRAM: s.vram, S_CC: s.cc, S_GPU_BROKEN: s.gpuBroken, S_ADAPTERS_STR: s.adapters.join('; '), S_NOGPU: s.noGpu ? '1' : '',
    S_DRIVER: s.driver || '', S_DRIVER_OLD: s.driverOld ? '1' : '',
    S_NODE: s.node, S_NODEVER: s.nodeVer, S_NPM: s.npmDeps ? 'yes' : '', S_UI: s.ui ? 'yes' : '',
    S_BLENDER: s.blender, S_BLENDER_VER: s.blenderVer, S_COMFY: s.comfy, S_COMFYVER: s.comfyVer, S_COMFYDEPS: s.comfyDeps ? 'yes' : '',
    S_GGUF: s.gguf ? 'yes' : '', S_GODOT: s.godot, S_GODOT_VER: s.godotVer, S_GLTFPACK: s.gltfpack || '', S_LIBRARY: s.library, S_CLIPS: s.clips,
    S_VFXDIR: s.vfxDir, S_VFXOK: s.vfxOk ? 'yes' : '', S_OLLAMA: s.ollama, S_LLMS_STR: s.llms.join(' '), S_VLM: s.vlm ? 'yes' : '',
    S_HY2: st(s.hy2), S_HYMV: st(s.hymv), S_HY21: st(s.hy21), S_SDXL: st(s.sdxl), S_U2NET: st(s.u2net),
    S_FLUX2W: st(s.flux2), S_QWENW: st(s.qwenimg), S_QWENEDITW: st(s.qwenedit),
    S_MV: s.mv.ready ? 'yes' : '', S_MV_NODE: s.mv.node ? 'yes' : '', S_MV_WEIGHTS: s.mv.weights ? 'yes' : '', S_MV_CONFIG: s.mv.config ? 'yes' : '',
    S_MV_PKGS: s.mv.pkgs ? 'yes' : '', S_MV_BYTES: s.mv.bytes, S_MV_REASON: s.mv.reason, S_MV_WARN: s.mv.warn,
    S_TS: s.ts.complete ? 'yes' : '', S_TS_ENV: s.ts.env ? 'yes' : '', S_TS_CODE: s.ts.code ? 'yes' : '', S_TS_WEIGHTS: s.ts.weights ? 'yes' : '',
    S_TS_DIR: s.ts.dir, S_TS_BYTES: s.ts.missingBytes, S_TS_REASON: s.ts.reason,
    S_SND: s.snd.complete ? 'yes' : '', S_SND_ENV: s.snd.env ? 'yes' : '', S_SND_CODE: s.snd.code ? 'yes' : '', S_SND_WEIGHTS: s.snd.weights ? 'yes' : '',
    S_SND_DIR: s.snd.dir, S_SND_BYTES: s.snd.missingBytes, S_SND_REASON: s.snd.reason,
    S_P3: s.p3.complete ? 'yes' : '', S_P3_ENGINE: s.p3.engine ? 'yes' : '', S_P3_WEIGHTS: s.p3.weights ? 'yes' : '',
    S_P3_DIR: s.p3.dir, S_P3_BYTES: s.p3.weights ? 0 : s.p3.missingBytes, S_P3_REASON: s.p3.reason, S_P3_WARN: s.p3.warn,
    S_FREE: s.free === null ? '' : s.free, S_LLM_RECOMMENDED: recommendLlm(s.man, s.vram).model,
  };
  return Object.entries(pairs).map(([k, v]) => `${k}=${q(v)}`).join('\n');
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--items') ? 'items' : process.argv.includes('--state') ? 'state'
    : process.argv.includes('--sh') ? 'sh' : 'table';
  try {
    const s = scanComponents();
    const items = scanItems(s);
    if (mode === 'items') process.stdout.write(`${itemLines(items).join('\n')}\n`);
    else if (mode === 'state') process.stdout.write(`${stateLines(s)}\n`);
    else if (mode === 'sh') process.stdout.write(`${stateLines(s)}\n${itemLines(items).join('\n')}\n`);
    else {
      const head = ['', `AstraForge scan: ${s.root}`];
      if (s.gpu) head.push(`  [found]    GPU: ${s.gpu} (${Math.round(s.vram / 1024)} GB${s.cc ? `, compute ${s.cc}` : ''}${s.driver ? `, driver ${s.driver}` : ''})`);
      else if (s.gpuBroken) head.push(`  [driver]   the NVIDIA driver does not answer (${s.gpuBroken}) - generation starts only after a reboot or a driver update`);
      else head.push(`  [no GPU]   NVIDIA graphics card not found${s.adapters.length ? ` (this computer has: ${s.adapters.join(', ')})` : ''} - 3D generation from a picture will be unavailable (the interface and Blender still work)`);
      if (s.gpu && s.driverOld) head.push(`  [driver]   NVIDIA driver ${s.driver} is older than ${MIN_NVIDIA_DRIVER}: Pixal3D is withheld and would refuse to start (ticket 20) - a driver update fixes both`);
      if (s.free !== null) head.push(`  [disk]     free in the application folder: ${gb(s.free)}`);
      process.stdout.write(`${head.concat(scanTable(items)).join('\n')}\n`);
    }
  } catch (e) {
    process.stderr.write(`scan failed: ${e.message}\n`);
    process.exit(2);
  }
}
