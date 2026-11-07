// The Sound tab's engine (docs/product/sound.md, 0.6.x wave ticket 04): two local generators -
// MOSS-SoundEffect v2.0 (text -> SFX, Apache-2.0, OpenMOSS) and ACE-Step 1.5 turbo (text ->
// seamless music loop, MIT) - in one dedicated venv (runtime/sound), spawned per task like the
// TripoSG worker. No provenance marks: exported WAV/OGG are plain audio (branch policy Q5/Q11).
// The project sound library lives under data/sound; removal moves files to a trash folder, the
// product never destroys a user's sound. NVIDIA only; AMD arrives with the ROCm line (deferred).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, data, pathsConfig } from './storage.mjs';

export const DEFAULT_SOUND_DIR = 'runtime/sound';

/** What has to be on disk for the Sound tab. [relative to the install folder, what it is]. */
export const SOUND_REQUIREMENTS = [
  [process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', 'the Sound Python environment'],
  ['src/MOSS-TTS/moss_soundeffect_v2/pyproject.toml', 'MOSS-SoundEffect v2 code (Apache-2.0, OpenMOSS) pinned in src/MOSS-TTS'],
  ['models/MOSS-SoundEffect-v2.0/model_index.json', 'MOSS-SoundEffect weights (HF OpenMOSS-Team/MOSS-SoundEffect-v2.0, Apache-2.0)'],
  ['src/ACE-Step-1.5/pyproject.toml', 'ACE-Step code (MIT) pinned in src/ACE-Step-1.5'],
  ['models/ACE-Step1.5/acestep-v15-turbo/model.safetensors', 'ACE-Step 1.5 turbo weights (HF ACE-Step/Ace-Step1.5, MIT)'],
];

/** Generation estimates shown in the UI (seconds of wall time on an RTX card, rough). */
export const SOUND_ESTIMATE = { sfxSeconds: 40, loopSeconds: 60 };

/** Event kinds a sound can bind to; the UI renders them through i18n (the names are ours). */
export const SOUND_EVENTS = ['footstep', 'run', 'jump', 'attack', 'hit', 'death', 'impact', 'spell', 'ui_click', 'ambient'];

/** Presets are data, not prose: labels resolve through the UI dictionaries. */
export function soundPresets() {
  return {
    sfx: {
      durations: [2, 5, 10, 20, 30],
      steps: 100, cfg_scale: 4.0,
      ideas: ['footsteps on gravel, steady pace', 'heavy wooden door creaks open', 'sword unsheathing with a metallic ring',
        'distant thunder over a quiet forest', 'creature growl, low and menacing'],
    },
    loop: {
      bpm: [60, 80, 100, 120, 140, 160, 180],
      bars: [2, 4, 8],
      steps: 8,
      ideas: ['calm exploration theme, soft strings and piano', 'tense chase drums, orchestral percussion',
        'medieval tavern lute, cheerful', 'synthwave arpeggio loop, driving'],
    },
    events: SOUND_EVENTS,
  };
}

/** Where the Sound stack lives: ASTRA_SOUND_DIR, else config/paths.json (key soundDir), else runtime/sound. */
export function soundConfig({ env = process.env, appRoot = root, dataDir = data } = {}) {
  const paths = pathsConfig(appRoot);
  let dir = path.join(appRoot, DEFAULT_SOUND_DIR), source = 'default';
  if (env.ASTRA_SOUND_DIR) { dir = env.ASTRA_SOUND_DIR; source = 'env'; }
  else if (typeof paths.soundDir === 'string' && paths.soundDir.trim()) { dir = paths.soundDir.trim(); source = 'paths.json'; }
  return { dir: path.resolve(dir), source, appRoot, dataDir };
}

export function soundInstallState(cfg = soundConfig(), exists = existsSync) {
  const missing = [];
  for (const [rel, label] of SOUND_REQUIREMENTS) if (!exists(path.join(cfg.dir, rel))) missing.push({ path: rel, label });
  if (missing.length) {
    const names = missing.map((m) => m.label).join('; ');
    return { installed: false, missing, message: `Sound is not ready (${cfg.dir}): missing ${names}. Install it with installer/install.sh -Only sound (the component is opt-in: it is new).` };
  }
  return { installed: true, missing: [], message: '' };
}

/** Status for /api/sound/status and /api/status. A task is a subprocess, never a service. */
export function soundStatus({ cfg = soundConfig(), exists = existsSync } = {}) {
  const state = soundInstallState(cfg, exists);
  return { installed: state.installed, running: false, dir: cfg.dir, missing: state.missing, message: state.message, estimate: SOUND_ESTIMATE, busy: currentTaskId() };
}

// - - - - - - - - - - - - - - - - library (WAV + OGG, trash not delete) - - - - - - - - - - - - - -

export function soundPaths(cfg = soundConfig()) {
  const base = path.join(cfg.dataDir || data, 'sound');
  return { lib: path.join(base, 'library'), trash: path.join(base, 'trash'), bindingsFile: path.join(base, 'bindings.json') };
}
const isSoundId = (id) => /^[0-9a-f-]{36}$/.test(String(id));

/** The library as [{id, name, kind, prompt, seconds, bpm, bars, seed, createdAt, wav, ogg}]; wav/ogg are API urls or null. */
export function soundLibrary(cfg = soundConfig()) {
  const { lib } = soundPaths(cfg);
  let ids = [];
  try { ids = (JSON.parse(readFileSync(path.join(lib, 'index.json'), 'utf8')) || []); } catch { return []; }
  return ids.filter(isSoundId).map((id) => {
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(lib, id + '.json'), 'utf8')); } catch { return null; }
    return { id, wav: existsSync(path.join(lib, id + '.wav')) ? '/api/sound/library/' + id + '/wav' : null,
      ogg: existsSync(path.join(lib, id + '.ogg')) ? '/api/sound/library/' + id + '/ogg' : null, ...meta };
  }).filter(Boolean);
}

/** Register a generated file in the library: WAV lands, OGG is the playback companion if present. */
export function addSoundToLibrary(wavPath, meta = {}, cfg = soundConfig()) {
  const { lib } = soundPaths(cfg);
  mkdirSync(lib, { recursive: true });
  const id = randomUUID();
  renameSync(wavPath, path.join(lib, id + '.wav'));
  const oggSrc = String(wavPath).replace(/\.wav$/, '.ogg');
  let ogg = false;
  if (existsSync(oggSrc)) { renameSync(oggSrc, path.join(lib, id + '.ogg')); ogg = true; }
  const rec = { id, name: meta.name || 'Sound ' + id.slice(0, 8), kind: meta.kind || 'sfx', prompt: meta.prompt || '',
    seconds: meta.seconds ?? null, bpm: meta.bpm ?? null, bars: meta.bars ?? null, seed: meta.seed ?? null,
    engine: meta.engine || null, createdAt: new Date().toISOString() };
  writeFileSync(path.join(lib, id + '.json'), JSON.stringify(rec, null, 1));
  const ids = soundLibrary(cfg).map((x) => x.id);
  writeFileSync(path.join(lib, 'index.json'), JSON.stringify([id, ...ids], null, 1));
  return { ...rec, ogg };
}

/** Remove from the library = move to trash (never delete). Returns the trashed item id or null. */
export function trashSound(id, cfg = soundConfig()) {
  if (!isSoundId(id)) return null;
  const { lib, trash } = soundPaths(cfg);
  let moved = 0;
  for (const ext of ['.wav', '.ogg', '.json']) {
    const from = path.join(lib, id + ext);
    if (existsSync(from)) { mkdirSync(trash, { recursive: true }); renameSync(from, path.join(trash, id + ext)); moved++; }
  }
  if (!moved) return null;
  let ids = [];
  try { ids = JSON.parse(readFileSync(path.join(lib, 'index.json'), 'utf8')); } catch { ids = []; }
  writeFileSync(path.join(lib, 'index.json'), JSON.stringify(ids.filter((x) => x !== id), null, 1));
  // bindings to a trashed sound become dangling on purpose: the UI shows them and lets the user
  // re-pick or clear - the sound itself is one move away in the trash folder, never destroyed.
  return id;
}

// - - - - - - - - - - - - - - - - - - per-asset event bindings - - - - - - - - - - - - - - - - - -

export function loadBindings(cfg = soundConfig()) {
  try { return JSON.parse(readFileSync(soundPaths(cfg).bindingsFile, 'utf8')); } catch { return {}; }
}
export function setBinding(assetId, event, soundId, cfg = soundConfig()) {
  if (!/^[0-9a-f-]{36}$/.test(String(assetId)) || !SOUND_EVENTS.includes(event)) throw new Error('Unknown asset or event kind.');
  const all = loadBindings(cfg);
  if (soundId) { if (!isSoundId(soundId)) throw new Error('Unknown sound id.'); (all[assetId] ??= {})[event] = soundId; }
  else delete all[assetId]?.[event];
  if (all[assetId] && !Object.keys(all[assetId]).length) delete all[assetId];
  mkdirSync(path.dirname(soundPaths(cfg).bindingsFile), { recursive: true });
  writeFileSync(soundPaths(cfg).bindingsFile, JSON.stringify(all, null, 1));
  return all[assetId] || {};
}

// - - - - - - - - - - - - - - - - the worker + the task queue - - - - - - - - - - - - - - - - - - -

/** The worker's argv; exported so tests can pin the parameters without a GPU. */
export function soundArgs(cfg, task) {
  const python = path.join(cfg.dir, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const loop = task.kind === 'loop';
  const base = [python, path.join(cfg.appRoot, 'scripts', 'sound', 'sound_run.py'),
    '--engine', loop ? 'acestep' : 'moss',
    '--prompt', String(task.prompt || ''),
    '--out', path.join(cfg.dataDir || data, 'runtime', 'temp', `sound-${task.id}.wav`),
    '--weights', path.join(cfg.dir, 'models'),
    '--src', path.join(cfg.dir, 'src'),
    '--steps', String(task.steps || (loop ? soundPresets().loop.steps : soundPresets().sfx.steps)),
    '--seed', String(task.seed ?? 42)];
  if (loop) base.push('--bpm', String(task.bpm || 120), '--bars', String(task.bars || 4));
  else base.push('--seconds', String(task.seconds || 10));
  return base;
}

const tasks = new Map();
let currentTaskId = () => null;
let queue = Promise.resolve();

/**
 * Enqueue a generation task: one at a time (the GPU), spawn the venv worker, follow its
 * SOUND_* lines, land the WAV (+ OGG companion when ffmpeg is available) in the library.
 * Returns the task record immediately; poll soundTask(id) for progress.
 */
export function createSoundTask(input, { cfg = soundConfig(), spawnFn = spawn, onSettle = () => {} } = {}) {
  const kind = input.kind === 'loop' ? 'loop' : 'sfx';
  const state = soundInstallState(cfg);
  if (!state.installed) throw Object.assign(new Error(state.message), { code: 'sound_not_installed' });
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('Describe the sound you want.');
  if (kind === 'sfx' && !(Number(input.seconds) >= 1 && Number(input.seconds) <= 30)) throw new Error('SFX duration must be 1..30 seconds.');
  if (kind === 'loop' && !(Number(input.bars || 4) >= 1 && Number(input.bars || 4) <= 8 && Number(input.bpm || 120) >= 40 && Number(input.bpm || 120) <= 240)) throw new Error('A loop is 1..8 bars at 40..240 BPM.');
  const task = { id: randomUUID(), kind, prompt, seconds: kind === 'loop' ? null : Number(input.seconds), bpm: kind === 'loop' ? Number(input.bpm || 120) : null,
    bars: kind === 'loop' ? Number(input.bars || 4) : null, seed: input.seed ?? 42, status: 'queued', progress: 0, message: 'Waiting for the sound queue',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), item: null, error: null };
  tasks.set(task.id, task);
  const update = (patch) => { Object.assign(task, patch, { updatedAt: new Date().toISOString() }); };
  const kill = { child: null };
  currentTaskId = () => [...tasks.values()].find((t) => t.status === 'running')?.id || null;
  task.cancel = () => { if (task.status === 'running') { try { kill.child?.kill('SIGKILL'); } catch { /* gone */ } } if (task.status === 'running' || task.status === 'queued') update({ status: 'cancelled', message: 'Cancelled' }); };
  queue = queue.then(() => runSoundTask(task, { cfg, spawnFn, update, kill })).catch(() => {}).then(() => onSettle(task));
  return publicTask(task);
}

function publicTask(t) {
  const { cancel, ...pub } = t;
  return pub;
}
export function soundTask(id) { const t = tasks.get(id); return t ? publicTask(t) : null; }
export function soundTasks() { return [...tasks.values()].map(publicTask).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50); }
export function cancelSoundTask(id) { const t = tasks.get(id); if (!t) return false; t.cancel(); return true; }

async function runSoundTask(task, { cfg, spawnFn, update, kill }) {
  if (task.status === 'cancelled') return;
  update({ status: 'running', message: task.kind === 'loop' ? 'Generating the music loop · ACE-Step 1.5' : 'Generating the sound · MOSS-SoundEffect', progress: 0 });
  const argv = soundArgs(cfg, task);
  const out = argv[argv.indexOf('--out') + 1];
  const env = { ...process.env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTORCH_ALLOC_CONF: 'expandable_segments:True', TORCHINDUCTOR_CACHE_DIR: path.join(cfg.dir, 'cache', 'torchinductor'),
    HF_HOME: path.join(cfg.dir, 'cache', 'huggingface'), TORCH_HOME: path.join(cfg.dir, 'cache', 'torch') };
  delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
  await new Promise((finish) => {
    let child;
    try { child = spawnFn(argv[0], argv.slice(1), { cwd: cfg.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { update({ status: 'failed', error: `Sound worker did not start: ${e.message}`, message: 'Sound worker did not start' }); return finish(); }
    kill.child = child;
    let err = '';
    let buf = '';
    const onLine = (line) => {
      if (line.startsWith('SOUND_PROGRESS ')) {
        const m = line.match(/^SOUND_PROGRESS (\d+) (.*)$/);
        if (m) update({ progress: Math.min(99, +m[1]), message: m[2] });
      } else if (line.startsWith('SOUND_RESULT ')) {
        let stats = {}; try { stats = JSON.parse(line.slice('SOUND_RESULT '.length)); } catch { /* raw */ }
        finishOnce(() => {
          if (!existsSync(out)) { update({ status: 'failed', error: 'The worker reported success but no WAV arrived.', message: 'Failed' }); return; }
          try {
            const meta = { name: (task.prompt || 'Sound').slice(0, 50), kind: task.kind, prompt: task.prompt, seconds: stats.seconds ?? task.seconds,
              bpm: task.bpm, bars: task.bars, seed: stats.seed ?? task.seed, engine: stats.engine };
            task.landed = addSoundToLibrary(out, meta, cfg);
            update({ status: 'completed', progress: 100, message: task.kind === 'loop' ? 'Loop ready' : 'Sound ready', item: task.landed });
          } catch (e) { update({ status: 'failed', error: e.message, message: 'Failed to store the sound' }); }
        });
      } else if (line.startsWith('SOUND_ERROR ')) {
        let msg = line.slice('SOUND_ERROR '.length); try { msg = JSON.parse(msg).message || msg; } catch { /* raw */ }
        finishOnce(() => { finishCleanup(out); update({ status: task.status === 'cancelled' ? 'cancelled' : 'failed', error: msg, message: 'Failed' }); });
      }
    };
    let done = false;
    const finishOnce = (fn) => { if (!done) { done = true; fn(); finish(); } };
    child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (l.trim()) onLine(l.trim()); } });
    child.stderr.on('data', (c) => { err = (err + c).slice(-16000); });
    child.on('error', (e) => finishOnce(() => { update({ status: 'failed', error: `Sound worker did not start: ${e.message}`, message: 'Failed' }); finish(); }));
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      if (task.status === 'cancelled') { finishCleanup(out); return finish(); }
      if (code === 0) update({ status: 'failed', error: 'The sound worker ended without a result. Last output:\n' + (err || buf).slice(-1500), message: 'Failed' });
      else update({ status: 'failed', error: `Sound worker failed (code ${code}). Last output:\n${(err || buf).slice(-1500)}`, message: 'Failed' });
      finish();
    });
  });
}
function finishCleanup(p) { try { unlinkSync(p); } catch { /* gone */ } }

/** Convert a library WAV to OGG (playback companion); null without ffmpeg - honest, never fatal. */
export function encodeOgg(id, { spawnFn = spawn, cfg = soundConfig() } = {}) {
  const { lib } = soundPaths(cfg);
  const wav = path.join(lib, id + '.wav'), ogg = path.join(lib, id + '.ogg');
  if (existsSync(ogg)) return ogg;
  if (!existsSync(wav)) return null;
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-qscale:a', '5', ogg], { stdio: 'ignore' }); }
    catch { return resolve(null); }
    child.on('error', () => { try { unlinkSync(ogg); } catch { /* nothing written */ } resolve(null); });
    child.on('exit', (code) => resolve(code === 0 && existsSync(ogg) ? ogg : (finishCleanup(ogg), null)));
  });
}

// The strings that would name this product inside an exported file: the `afmk` RIFF chunk of the
// provenance machinery (never shipped on this branch) and the product name in any spelling.
const PROVENANCE_WORDS = ['afmk', 'AstraForge', 'astraforge', 'ASTRA_'];

/**
 * The export guard (branch policy Q5/Q11): a sound this studio releases carries no provenance
 * mark. A WAV holds the plain `fmt `/`data` RIFF chunks and nothing else; an OGG comment header
 * may carry the encoder's own banner (Xiph's vendor string, ENCODER=libsndfile) but no field that
 * names this product or the `afmk` chunk. Returns the list of violations - empty means plain audio.
 */
export function findAudioMarks(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const found = [];
  for (const word of PROVENANCE_WORDS) if (bytes.includes(word)) found.push(word);
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') {
    let i = 12;
    while (i + 8 <= bytes.length) {
      const id = bytes.subarray(i, i + 4).toString('latin1'), size = bytes.readUInt32LE(i + 4);
      if (id !== 'fmt ' && id !== 'data') found.push(`wav chunk ${id}`);
      i += 8 + size + (size % 2);
    }
  }
  const comment = bytes.indexOf(Buffer.from('\x03vorbis', 'latin1'));
  if (comment >= 0 && comment + 15 <= bytes.length) {
    const readField = (at) => { const len = bytes.readUInt32LE(at); return [bytes.subarray(at + 4, at + 4 + len).toString('latin1'), at + 4 + len]; };
    let at = comment + 7;
    let field; [field, at] = readField(at);
    const fields = [field];
    const count = bytes.readUInt32LE(at); at += 4;
    for (let n = 0; n < count && at + 4 <= bytes.length; n++) { let v; [v, at] = readField(at); fields.push(v); }
    for (const f of fields) for (const word of PROVENANCE_WORDS) if (f.includes(word)) found.push(`ogg field ${f}`);
  }
  return found;
}

/** Size on disk of the component (for the checklist footer and the About tab). */
export function soundDiskBytes(cfg = soundConfig()) {
  let total = 0;
  const walk = (p) => {
    let st; try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { try { for (const e of readdirSync(p)) walk(path.join(p, e)); } catch { /* unreadable dir: skip */ } }
    else total += st.size;
  };
  for (const rel of ['models', '.venv']) walk(path.join(cfg.dir, rel));
  return total;
}

// - - - - - - - - - - - - - - - - - - - - - HTTP routes - - - - - - - - - - - - - - - - - - - - - - -

/**
 * /api/sound/*: status + presets, the library (WAV/OGG, removal = trash), per-asset event
 * bindings, and the task queue. Everything here is local; a task is one worker subprocess.
 */
export function registerSound(app, asyncRoute, { cfg = soundConfig(), encode = encodeOgg } = {}) {
  app.get('/api/sound/status', asyncRoute(async (req, res) => res.json({ ...soundStatus({ cfg }), presets: soundPresets(), events: SOUND_EVENTS })));
  app.get('/api/sound/library', asyncRoute(async (req, res) => res.json(soundLibrary(cfg))));
  app.get('/api/sound/library/:id/:kind', asyncRoute(async (req, res) => {
    if (!isSoundId(req.params.id) || !['wav', 'ogg'].includes(req.params.kind)) throw new Error('Unknown sound or format.');
    const file = path.join(soundPaths(cfg).lib, `${req.params.id}.${req.params.kind}`);
    if (!existsSync(file)) throw new Error('This sound is not in the library anymore.');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  }));
  app.post('/api/sound/library/:id/ogg', asyncRoute(async (req, res) => {
    const file = await encode(req.params.id, { cfg });
    if (!file) throw new Error('OGG encoding needs ffmpeg on this computer.');
    res.json({ ogg: `/api/sound/library/${req.params.id}/ogg` });
  }));
  app.post('/api/sound/library/:id/trash', asyncRoute(async (req, res) => {
    const id = trashSound(req.params.id, cfg);
    if (!id) throw new Error('This sound is not in the library anymore.');
    res.json({ trashed: id, message: 'Moved to the trash folder (data/sound/trash), nothing was deleted.' });
  }));
  app.get('/api/sound/bindings', asyncRoute(async (req, res) => res.json(loadBindings(cfg))));
  app.put('/api/sound/bindings', asyncRoute(async (req, res) => {
    const { assetId, event, soundId } = req.body || {};
    res.json(setBinding(assetId, event, soundId || null, cfg));
  }));
  app.post('/api/sound/tasks', asyncRoute(async (req, res) => res.status(202).json(createSoundTask(req.body || {}, { cfg }))));
  app.get('/api/sound/tasks', asyncRoute(async (req, res) => res.json(soundTasks())));
  app.get('/api/sound/tasks/:id', asyncRoute(async (req, res) => {
    const t = soundTask(req.params.id);
    if (!t) throw new Error('Unknown sound task.');
    res.json(t);
  }));
  app.post('/api/sound/tasks/:id/cancel', asyncRoute(async (req, res) => res.json({ cancelled: cancelSoundTask(req.params.id) })));
}
