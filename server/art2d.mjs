// "2D": pictures by reference - turnarounds, body parts for a cutout rig, animation frames, expressions, storyboards,
// poses from 3D clips, restyling (docs/art2d.md). The work lives in scripts/art2d/; this module wraps it for the Studio:
//   GET  /api/art2d/status                         engines on the studio ComfyUI + styles, recipes, actions, sheet presets
//   GET  /api/art2d/sets                           all sets, newest first (short form)
//   POST /api/art2d/sets                           {recipe, style, engine, prompt, action, ..., characterId, styleImageId, poseIds[], inputIds[]}
//                                                  -> creates the set and starts generating it (one set at a time)
//   GET  /api/art2d/sets/:id                       manifest + running task
//   GET  /api/art2d/sets/:id/file?path=raw/x.png   a picture of the set (only inside the set folder)
//   POST /api/art2d/sets/:id/redo                  {keys[], newSeed}  re-draw some shots
//   POST /api/art2d/sets/:id/resume                continue a failed / cancelled set
//   POST /api/art2d/sets/:id/cancel
//   POST /api/art2d/sets/:id/asset                 {key}  a shot -> studio asset (use as reference, or as a concept for 3D)
//   GET  /api/art2d/sets/:id/godot                 ZIP for Godot 4.5 (SpriteFrames .tres / cutout .tscn / PNGs)
import path from 'node:path';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import JSZip from 'jszip';
import { data, isId, root, pathsConfig, assetInfo, saveAsset } from './storage.mjs';
import * as defaultRunner from '../scripts/art2d/art2d_run.mjs';
import { STYLES } from '../scripts/art2d/art2d_styles.mjs';
import { RECIPES, ACTIONS, DIRECTIONS, TURNAROUND, PARTS } from '../scripts/art2d/art2d_recipes.mjs';
import { ENGINES } from '../scripts/art2d/art2d_workflows.mjs';
import { getStyle, styleImageFile } from './styles.mjs';
import { vramMiB } from './triposg.mjs';

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const uuid = z.string().uuid();

export const createSchema = z.object({
  recipe: z.enum(Object.keys(RECIPES)),
  style: z.enum(Object.keys(STYLES)).default('painted'),
  engine: z.enum([...Object.keys(ENGINES), 'auto']).default('flux2'),
  styleBibleId: uuid.optional(),
  prompt: z.string().max(1500).optional(),
  name: z.string().max(120).optional(),
  action: z.enum(Object.keys(ACTIONS)).optional(),
  direction: z.enum(Object.keys(DIRECTIONS)).optional(),
  frames: z.number().int().min(1).max(12).optional(),
  chain: z.boolean().optional(),
  views: z.array(z.enum(TURNAROUND.map((t) => t[0]))).max(5).optional(),
  parts: z.array(z.enum(PARTS.map((p) => p[0]))).max(10).optional(),
  scenes: z.array(z.string().max(400)).max(16).optional(),
  sheet: z.enum(Object.keys(defaultRunner.SHEET_PRESETS)).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  steps: z.number().int().min(8).max(60).optional(),
  characterId: uuid.optional(),
  styleImageId: uuid.optional(),
  poseIds: z.array(uuid).max(24).optional(),
  inputIds: z.array(uuid).max(24).optional(),
}).strict();
const redoSchema = z.object({ keys: z.array(z.string().regex(/^[\w-]{1,40}$/)).min(1).max(24), newSeed: z.boolean().default(true) }).strict();

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

export function createArt2dService({ root = defaultRunner.ART2D_ROOT, runner = defaultRunner, getConfig = () => ({ comfyUrl: 'http://127.0.0.1:8190' }), getAsset = assetInfo, assetFile = (info) => path.join(data, 'assets', info.id + info.extension), putAsset = saveAsset, getVram = () => vramMiB(), styleDataDir = data } = {}) {
  const tasks = new Map();
  const dirOf = (id) => {
    if (!isId(id)) throw httpError('Incorrect set id.', 400);
    return path.join(root, id);
  };
  const busy = () => [...tasks.values()].some((t) => t.status === 'running');

  async function read(id) {
    const set = await runner.loadSet(dirOf(id));
    if (!set) throw httpError('2D set not found.', 404);
    return set;
  }

  const fileUrl = (id, rel) => (rel ? `/api/art2d/sets/${id}/file?path=${encodeURIComponent(rel)}` : null);
  function publicSet(set) {
    const t = tasks.get(set.id);
    return {
      ...set,
      shots: set.shots.map((s) => ({ ...s, url: fileUrl(set.id, s.file), finalUrl: fileUrl(set.id, s.final || s.file) })),
      urls: Object.fromEntries(Object.entries(set.outputs || {}).filter(([, v]) => v?.file).map(([k, v]) => [k, fileUrl(set.id, v.file)])),
      task: t ? { status: t.status, message: t.message, startedAt: t.startedAt, finishedAt: t.finishedAt || null, error: t.error || null } : null,
    };
  }

  async function imagePath(id, label) {
    const info = await getAsset(id);
    if (!IMAGE_EXT.includes(info.extension)) throw httpError(label + ': a PNG, JPG or WEBP picture is needed.');
    return assetFile(info);
  }

  function start(set, dir, opts = {}) {
    if (busy()) throw httpError('A 2D generation is already running. Wait for it to finish or cancel it.', 409);
    const task = { status: 'running', message: 'Starting', startedAt: new Date().toISOString(), controller: new AbortController() };
    tasks.set(set.id, task);
    void runner.runSet(dir, { comfyUrl: getConfig().comfyUrl, signal: task.controller.signal, onProgress: (m) => { task.message = m; }, ...opts })
      .then(() => { task.status = 'completed'; task.message = 'Done'; })
      .catch((e) => {
        task.status = e?.name === 'AbortError' ? 'cancelled' : 'failed';
        task.message = task.status === 'cancelled' ? 'Cancelled' : e.message;
        task.error = task.status === 'failed' ? e.message : null;
      })
      .finally(() => { task.finishedAt = new Date().toISOString(); task.controller = null; });
  }

  async function create(input) {
    const o = createSchema.parse(input);
    if (busy()) throw httpError('A 2D generation is already running. Wait for it to finish or cancel it.', 409);
    const files = {
      character: o.characterId ? await imagePath(o.characterId, 'Character') : undefined,
      styleImage: o.styleImageId ? await imagePath(o.styleImageId, 'Style sample') : undefined,
      poses: await Promise.all((o.poseIds || []).map((id) => imagePath(id, 'Pose'))),
      inputs: await Promise.all((o.inputIds || []).map((id) => imagePath(id, 'Picture'))),
    };
    // the style bible (ticket 07): its pictures and text ride the set; the engine follows the look -
    // a style is drawn by Qwen-Image-Edit when the gate and the weights allow it, FLUX.2 klein otherwise
    let styleBible = null;
    if (o.styleBibleId) {
      const rec = getStyle(o.styleBibleId, styleDataDir);
      if (!rec) throw httpError('No such style bible - add one in the Style tab first.', 404);
      const imageFiles = rec.images.map((f) => styleImageFile(rec.id, f, styleDataDir)).filter(Boolean);
      if (!imageFiles.length) throw httpError('This style bible has no picture files on disk.');
      styleBible = { id: rec.id, name: rec.name, description: rec.description, negative: rec.negative, files: imageFiles };
    }
    let engine = o.engine, engineNote = null;
    if (engine === 'auto' || (styleBible && engine === 'flux2')) {
      const st = await runner.art2dStatus(getConfig().comfyUrl, { vramMiB: getVram() });
      const qe = st.engines.qwenedit;
      if (qe?.ready) {
        if (engine !== 'qwenedit') {
          engineNote = engine === 'auto'
            ? `auto: ${qe.label} (the biggest style engine this machine runs)`
            : `style engine: ${qe.label}${styleBible ? ` (${refsOf(styleBible)})` : ''}`;
        }
        engine = 'qwenedit';
      } else if (engine === 'auto') {
        // the edit recipes can only be drawn by the reference engines; plain concepts may use any
        // the edit recipes can only be drawn by the reference engines; plain concepts may use any -
        // except the non-commercial opt-ins (ticket 52): auto never borrows the klein 9B's files,
        // that engine is picked by an explicit click only, so its absence is not something to route around
        const wantEdit = !!RECIPES[o.recipe]?.edit;
        const order = wantEdit ? ['qwenedit', 'flux2'] : ['qwenedit', 'flux2', 'qwen', 'sdxl'];
        engine = order.find((k) => st.engines[k]?.ready) || Object.keys(st.engines).find((k) => st.engines[k]?.ready && st.engines[k].commercial !== false) || 'flux2';
        engineNote = `auto: ${ENGINES[engine]?.label || engine} - Qwen-Image-Edit unavailable (${qe?.reasons?.[0] || 'not checked'})`;
      } else if (styleBible) {
        engineNote = `style drawn by ${ENGINES.flux2.label} - ${qe?.reasons?.[0] || 'Qwen-Image-Edit unavailable'}`;
      }
    }
    const { characterId, styleImageId, poseIds, inputIds, styleBibleId, engine: engineRaw, ...rest } = o;
    const { dir, set } = await runner.createSet({ ...rest, engine, engineNote, ...files, styleBible }, { root });
    set.sourceAssets = { characterId: characterId || null, styleImageId: styleImageId || null, styleBibleId: styleBibleId || null };
    await runner.saveSet(dir, set);
    start(set, dir);
    return publicSet(set);
  }
  const refsOf = (sb) => `${sb.files.length} reference picture${sb.files.length === 1 ? '' : 's'}`;

  async function list() {
    const sets = await runner.listSets(root);
    return sets.slice(0, 200).map((s) => {
      const first = s.shots.find((x) => x.status === 'done');
      return {
        id: s.id, name: s.name, recipe: s.recipe, style: s.style, engine: s.engine, createdAt: s.createdAt, done: s.shots.filter((x) => x.status === 'done').length, total: s.shots.length,
        status: tasks.get(s.id)?.status || s.run?.status || 'new', thumb: first ? fileUrl(s.id, first.final || first.file) : null,
      };
    });
  }

  async function redo(id, input) {
    const o = redoSchema.parse(input);
    const set = await read(id);
    const unknown = o.keys.filter((k) => !set.shots.some((s) => s.key === k));
    if (unknown.length) throw httpError('No shots: ' + unknown.join(', '));
    start(set, dirOf(id), { only: o.keys, newSeed: o.newSeed });
    return publicSet(await read(id));
  }

  async function resume(id) {
    const set = await read(id);
    start(set, dirOf(id));
    return publicSet(set);
  }

  async function cancel(id) {
    tasks.get(id)?.controller?.abort();
    return publicSet(await read(id));
  }

  // only these subfolders of the set may be served, nothing else
  const SAFE_FILE = /^(refs|raw|cut|px|out)\/[\w./-]+\.(png|jpg|jpeg|webp|json)$/i;
  async function filePath(id, rel) {
    const dir = dirOf(id);
    const clean = String(rel || '').replaceAll('\\', '/');
    if (!SAFE_FILE.test(clean) || clean.includes('..')) throw httpError('Invalid path.', 400);
    const file = path.join(dir, clean);
    if (!existsSync(file)) throw httpError('File not found.', 404);
    return file;
  }

  async function toAsset(id, key) {
    const set = await read(id);
    const shot = set.shots.find((s) => s.key === key && s.status === 'done');
    if (!shot) throw httpError('The shot is not ready yet.');
    const file = path.join(dirOf(id), shot.final || shot.file);
    return putAsset(await fs.readFile(file), '.png', `${set.name} - ${shot.label}.png`);
  }

  async function godotZip(id) {
    const set = await read(id);
    if (!set.shots.some((s) => s.status === 'done')) throw httpError('The set has no finished shots.');
    if (tasks.get(id)?.status === 'running') throw httpError('Wait for the generation to finish.', 409);
    const outDir = await runner.exportGodot(dirOf(id));
    const zip = new JSZip();
    const walk = async (d, prefix) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(d, e.name), prefix + e.name + '/');
        else zip.file(prefix + e.name, await fs.readFile(path.join(d, e.name)));
      }
    };
    const name = path.basename(outDir);
    await walk(outDir, name + '/');
    return { name: name + '_godot.zip', buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
  }

  return { create, list, get: async (id) => publicSet(await read(id)), redo, resume, cancel, filePath, toAsset, godotZip, tasks, root };
}

let statusCache = { at: 0, value: null };

/**
 * For /api/status (ticket 07 T3): is the style engine ready - cheaply. File existence against the
 * manifest pins (one source for names), plus the card against the gate. No ComfyUI round trip here;
 * the full per-node verdict lives in /api/art2d/status.
 */
export function editReadiness({ appRoot = root, exists = existsSync, env = process.env } = {}) {
  let files;
  try {
    const man = JSON.parse(readFileSync(path.join(appRoot, 'installer', 'manifest.json'), 'utf8'));
    files = ['qwenedit', 'qweneditlora', 'qwente', 'qwenvae'].map((id) => ({ dir: man.models[id].dir, file: man.models[id].file, label: man.models[id].name }));
  } catch { return { installed: false, dir: '', missing: [{ file: 'installer/manifest.json', label: 'the manifest' }], gateMiB: 10240 }; }
  const cfg = pathsConfig(appRoot);
  const dir = env.ASTRA_COMFY_DIR || (typeof cfg.comfyDir === 'string' && cfg.comfyDir.trim()) || path.join(appRoot, 'runtime', 'ComfyUI');
  const missing = files.filter((f) => !exists(path.join(dir, 'models', f.dir, f.file))).map(({ file, label }) => ({ file, label }));
  return { installed: missing.length === 0, dir, missing, gateMiB: 10240 };
}

export function registerArt2d(app, asyncRoute, options = {}) {
  const service = options.service || createArt2dService(options);
  const comfyUrl = () => options.getConfig?.()?.comfyUrl || 'http://127.0.0.1:8190';
  app.get('/api/art2d/status', asyncRoute(async (req, res) => {
    if (!statusCache.value || Date.now() - statusCache.at > 15000 || req.query.fresh) {
      statusCache = { at: Date.now(), value: await (options.runner || defaultRunner).art2dStatus(comfyUrl(), { vramMiB: (options.getVram || (() => vramMiB()))() }) };
    }
    res.json({
      ...statusCache.value,
      styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label, note: s.note, pixel: !!s.post?.pixel })),
      recipes: Object.entries(RECIPES).map(([id, r]) => ({ id, ...r })),
      actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, frames: a.poses.length, fps: a.fps, loop: a.loop })),
      directions: Object.keys(DIRECTIONS), views: TURNAROUND.map(([id, label]) => ({ id, label })), parts: PARTS.map(([id, label]) => ({ id, label })),
      sheets: Object.entries(defaultRunner.SHEET_PRESETS).map(([id, p]) => ({ id, label: p.label })),
    });
  }));
  app.get('/api/art2d/sets', asyncRoute(async (req, res) => res.json(await service.list())));
  app.post('/api/art2d/sets', asyncRoute(async (req, res) => res.status(202).json(await service.create(req.body))));
  app.get('/api/art2d/sets/:id', asyncRoute(async (req, res) => res.json(await service.get(req.params.id))));
  app.get('/api/art2d/sets/:id/file', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    // dotfiles: the app may live under a dot folder (git worktrees); filePath() already whitelists the path
    res.sendFile(await service.filePath(req.params.id, req.query.path), { dotfiles: 'allow' });
  }));
  app.post('/api/art2d/sets/:id/redo', asyncRoute(async (req, res) => res.status(202).json(await service.redo(req.params.id, req.body))));
  app.post('/api/art2d/sets/:id/resume', asyncRoute(async (req, res) => res.status(202).json(await service.resume(req.params.id))));
  app.post('/api/art2d/sets/:id/cancel', asyncRoute(async (req, res) => res.json(await service.cancel(req.params.id))));
  app.post('/api/art2d/sets/:id/asset', asyncRoute(async (req, res) => res.json(await service.toAsset(req.params.id, z.string().max(40).parse(req.body?.key)))));
  app.get('/api/art2d/sets/:id/godot', asyncRoute(async (req, res) => {
    const { name, buffer } = await service.godotZip(req.params.id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(buffer);
  }));
  return service;
}
