// The style bible (docs/product/styles.md, 0.6.x wave ticket 06): the project's look as data. A
// style is 1..6 reference pictures plus an English description (and negative / palette / notes);
// "describe" drafts that description from the pictures with the local vision model - the same pick
// Connections shows (server/vlm.mjs), never a download. Consumption (style-conditioned generation)
// is ticket 07. Like every creative folder of this branch, removing a style MOVES it to a trash
// folder; nothing here destroys a user's work.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { data, isId } from './storage.mjs';
import { ollamaModels } from './ollama-run.mjs';
import { pickReviewModel, vlmAsk } from './vlm.mjs';
import { vramMiB } from './triposg.mjs';

export const MAX_STYLE_IMAGES = 6;

/** The editable text of a style. description is the English prompt the generators receive (ticket 07). */
export const styleFields = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(4000).default(''),
  negative: z.string().max(2000).default(''),
  palette: z.string().max(500).default(''),      // free text: "warm ochre, dusty teal, no black"
  notes: z.string().max(2000).default(''),       // production notes, for humans
}).strict();

/** Magic bytes only - the same contract /api/assets holds uploaded pictures to (ticket 06 image set). */
export function imageKind(buffer, filename = '') {
  const ext = path.extname(String(filename)).toLowerCase();
  const ok =
    ext === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ext === '.jpg' || ext === '.jpeg' ? buffer[0] === 0xff && buffer[1] === 0xd8
        : ext === '.webp' ? buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
          : false;
  return ok ? (ext === '.jpeg' ? '.jpg' : ext) : null;
}

/** Where styles live for a given data folder (the trash sits inside it, so one move is atomic). */
export const stylePaths = (dataDir = data) => ({ dir: path.join(dataDir, 'styles'), trash: path.join(dataDir, 'styles', 'trash') });
const styleDirOf = (id, dataDir = data) => path.join(stylePaths(dataDir).dir, id);
const recordFile = (id, dataDir = data) => path.join(styleDirOf(id, dataDir), 'style.json');

/** Names this module generated: `<uuid>.<ext>` - anything else never touches the disk. */
const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/i;

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }

function readRecord(id, dataDir = data) {
  try { return styleFields.extend({ id: z.string(), images: z.array(z.string()), createdAt: z.string(), updatedAt: z.string() }).parse(JSON.parse(readFileSync(recordFile(id, dataDir), 'utf8'))); }
  catch { return null; }
}
function writeRecord(rec, dataDir = data) {
  writeFileSync(recordFile(rec.id, dataDir), JSON.stringify(rec, null, 2));
  return rec;
}

/** Every style, newest first; the trash folder and foreign directories are not styles. */
export function listStyles(dataDir = data) {
  const { dir, trash } = stylePaths(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!isId(name) || full === trash || !existsSync(path.join(full, 'style.json'))) continue;
    const rec = readRecord(name, dataDir);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ------------------------------------------------------------------ describe

/**
 * The picture-reading instruction (EN on purpose: the output is the English prompt generators
 * consume). Own wording; the model must not narrate the pictures, it must write the recipe.
 */
export const DESCRIBE_PROMPT =
  'You are writing an art-style sheet for an image generator. Study these reference pictures - ' +
  'they all share one style. Describe the STYLE itself (not the subjects) in one English paragraph ' +
  'of at most 90 words: medium and line quality, colour palette, lighting and shading, rendering ' +
  'technique, era and mood. Be concrete enough that another artist could match it. Then add one ' +
  'final line that starts with "Avoid:" naming what would break this style. No headings, no lists.';

/**
 * Draft the description with the installed vision model: same pick as the review step (Connections
 * choice honored, ASTRA_REVIEW_VLM wins), think:false enforced, no download - an uninstalled model
 * answers with the pick's own reason instead. Returns {style, model, reason}; the draft lands in
 * style.description (the editor keeps it under the user's control: save or re-describe).
 */
export async function describeStyle(id, { getLiveConfig, dataDir = data, fetchFn = fetch, env = process.env, timeoutMs = 180000 } = {}) {
  const rec = readRecord(id, dataDir);
  if (!rec) throw bad('No such style.', 404);
  const images = [];
  for (const file of rec.images.slice(0, MAX_STYLE_IMAGES)) {
    const full = path.join(styleDirOf(id, dataDir), file);
    if (existsSync(full)) images.push(readFileSync(full).toString('base64'));
  }
  if (!images.length) throw bad('This style has no pictures left to look at - add references first.');
  const live = getLiveConfig();
  const installed = (await ollamaModels(live.ollamaUrl, fetchFn)) || [];
  const pick = pickReviewModel(vramMiB(), installed, env, live.reviewModel);
  if (!pick.installed) throw Object.assign(new Error(`No local vision model to describe with: ${pick.reason}`), { status: 503 });
  const draft = (await vlmAsk({ url: live.ollamaUrl, model: pick.model, prompt: DESCRIBE_PROMPT, images, fetchFn, timeoutMs })).slice(0, 4000);
  const saved = writeRecord({ ...rec, description: draft, updatedAt: new Date().toISOString() }, dataDir);
  return { style: saved, model: pick.model, reason: pick.reason };
}

// ------------------------------------------------------------------ routes

/** multer is only here for the upload endpoints; memory storage, six pictures, fifteen MB each.
 *  The extension gate is cheap; the magic-byte check happens on the finished buffer in `written`. */
const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: MAX_STYLE_IMAGES },
  fileFilter: (_req, file, cb) => cb(['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(String(file.originalname)).toLowerCase()) ? null : bad('Pictures must be PNG, JPG or WEBP files.'), true),
});

export function registerStyles(app, asyncRoute, { getLiveConfig, dataDir = data, fetchFn = fetch, env = process.env } = {}) {
  const store = (rec) => writeRecord(rec, dataDir);
  const mustGet = (id) => { const rec = isId(id) && readRecord(id, dataDir); if (!rec) throw bad('No such style.', 404); return rec; };
  const written = (files) => {
    for (const f of files || []) {
      const ext = imageKind(f.buffer, f.originalname);
      if (!ext) throw bad(`"${f.originalname}" is not a real PNG, JPG or WEBP picture.`);
      f.saved = randomUUID() + ext;
    }
    return files || [];
  };

  app.get('/api/styles', asyncRoute(async (_req, res) => res.json(listStyles(dataDir))));
  app.get('/api/styles/:id', asyncRoute(async (req, res) => res.json(mustGet(req.params.id))));
  app.get('/api/styles/:id/images/:file', asyncRoute(async (req, res, next) => {
    const rec = mustGet(req.params.id);
    if (!IMAGE_NAME.test(req.params.file) || !rec.images.includes(req.params.file)) return next(bad('No such picture.', 404));
    const full = path.join(styleDirOf(req.params.id, dataDir), req.params.file);
    if (!existsSync(full)) return next(bad('The picture file is gone from disk.', 404));
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(full);
  }));

  app.post('/api/styles', uploadImages.array('images', MAX_STYLE_IMAGES), asyncRoute(async (req, res) => {
    const fields = styleFields.parse({ ...req.body, name: String(req.body?.name || '').trim() });
    const files = written(req.files);
    if (!files.length) throw bad(`A style needs at least one reference picture (up to ${MAX_STYLE_IMAGES}).`);
    if (files.length > MAX_STYLE_IMAGES) throw bad(`A style carries at most ${MAX_STYLE_IMAGES} reference pictures.`);
    const now = new Date().toISOString();
    const rec = { id: randomUUID(), ...fields, images: files.map((f) => f.saved), createdAt: now, updatedAt: now };
    mkdirSync(styleDirOf(rec.id, dataDir), { recursive: true });
    for (const f of files) writeFileSync(path.join(styleDirOf(rec.id, dataDir), f.saved), f.buffer);
    res.json(store(rec));
  }));

  app.put('/api/styles/:id', asyncRoute(async (req, res) => {
    const rec = mustGet(req.params.id);
    const patch = styleFields.partial().strict().parse(req.body ?? {});
    if (patch.name === '') throw bad('A style needs a name.');
    res.json(store({ ...rec, ...patch, id: rec.id, images: rec.images, createdAt: rec.createdAt, updatedAt: new Date().toISOString() }));
  }));

  app.post('/api/styles/:id/images', uploadImages.array('images', MAX_STYLE_IMAGES), asyncRoute(async (req, res) => {
    const rec = mustGet(req.params.id);
    const files = written(req.files);
    if (!files.length) throw bad('No pictures in this request.');
    if (rec.images.length + files.length > MAX_STYLE_IMAGES) throw bad(`A style carries at most ${MAX_STYLE_IMAGES} reference pictures (this one has ${rec.images.length}).`);
    for (const f of files) writeFileSync(path.join(styleDirOf(rec.id, dataDir), f.saved), f.buffer);
    res.json(store({ ...rec, images: [...rec.images, ...files.map((f) => f.saved)], updatedAt: new Date().toISOString() }));
  }));

  // pictures and styles alike move to the trash - the studio never erases a reference on its own
  app.delete('/api/styles/:id/images/:file', asyncRoute(async (req, res) => {
    const rec = mustGet(req.params.id);
    if (!IMAGE_NAME.test(req.params.file) || !rec.images.includes(req.params.file)) throw bad('No such picture.', 404);
    if (rec.images.length <= 1) throw bad('A style keeps at least one reference picture - remove the whole style instead.');
    const { trash } = stylePaths(dataDir);
    mkdirSync(trash, { recursive: true });
    renameSync(path.join(styleDirOf(req.params.id, dataDir), req.params.file), path.join(trash, req.params.file));
    res.json(store({ ...rec, images: rec.images.filter((x) => x !== req.params.file), updatedAt: new Date().toISOString() }));
  }));

  app.post('/api/styles/:id/describe', asyncRoute(async (req, res) => res.json(await describeStyle(req.params.id, { getLiveConfig, dataDir, fetchFn, env }))));

  app.delete('/api/styles/:id', asyncRoute(async (req, res) => {
    const rec = mustGet(req.params.id);
    const { trash } = stylePaths(dataDir);
    mkdirSync(trash, { recursive: true });
    renameSync(styleDirOf(rec.id, dataDir), path.join(trash, rec.id));
    res.json({ trashed: rec.id });
  }));
}
