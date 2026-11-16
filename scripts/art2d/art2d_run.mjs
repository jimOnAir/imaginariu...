// Runner of the 2D module (docs/art2d.md). Works with or without the studio server (CLI: scripts/art2d/art2d.mjs).
//
// A "set" is a folder <root>/<id>/:
//   set.json          manifest: recipe, style, engine, licence, shots with their final prompts, seeds, status, timings
//   refs/             character.png, style.png, pose_00.png..., input_00.png...
//   raw/<key>.png     what the engine drew
//   cut/<key>.png     cut out of the background (RGBA, trimmed)      - recipes with cut: true
//   px/<key>.png      real pixel art (+ _1x native size)             - pixel styles
//   out/              sheet.png + sheet.json, board.png, parts.json, godot/ (SpriteFrames .tres or cutout .tscn)
// Generation goes through the studio ComfyUI (:8190) under the shared GPU lock; post-processing is deterministic Python.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA, DEFAULT_COMFY_URL, requireNodes, uploadImage, runWorkflow, downloadOutput, runPython } from '../views/comfy_client.mjs';
import { withEngineGpu } from '../../server/gpu-handover.mjs';
import { ENGINES, buildWorkflow } from './art2d_workflows.mjs';
import { STYLES, NEGATIVE, STYLE_REF_PROMPT } from './art2d_styles.mjs';
import { RECIPES, ACTIONS, expandRecipe, styleSuffix } from './art2d_recipes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ART2D_ROOT = path.join(DATA, 'art2d');
const POST = path.join(HERE, 'art2d_post.py');

// Sheet presets: the cell and the feet anchor a game expects (tactics games ship 320x320 with the feet anchor).
export const SHEET_PRESETS = {
  default: { cell: [256, 256], anchor: null, label: '256x256, feet bottom center' },
  heroes_gates: { cell: [320, 320], anchor: [160, 272], label: 'Heroes gates: 320x320, anchor 160,272' },
  hd: { cell: [512, 512], anchor: null, label: '512x512' },
};

const nowIso = () => new Date().toISOString();

export async function loadSet(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'set.json'), 'utf8')); } catch { return null; }
}
export async function saveSet(dir, set) {
  set.updatedAt = nowIso();
  const tmp = path.join(dir, 'set.json.' + process.pid + '.tmp');
  await fs.writeFile(tmp, JSON.stringify(set, null, 2));
  await fs.rename(tmp, path.join(dir, 'set.json'));
  return set;
}

/** {ready, engines:{flux2:{ready,reasons}, ...}} - what is usable right now on the given ComfyUI.
 *  vramMiB (optional): engines carrying a gateMiB (qwenedit, ticket 07) reason themselves out
 *  honestly on a small card - below the gate the style series are drawn by FLUX.2 klein. */
export async function art2dStatus(comfyUrl = DEFAULT_COMFY_URL, { vramMiB = 0, fetchFn = fetch } = {}) {
  let info = null;
  try {
    const r = await fetchFn(comfyUrl + '/object_info', { signal: AbortSignal.timeout(15000) });
    if (r.ok) info = await r.json();
  } catch { /* offline */ }
  const engines = {};
  for (const [id, e] of Object.entries(ENGINES)) {
    const reasons = [];
    if (!info) reasons.push(`the studio engine ComfyUI does not answer (${comfyUrl})`);
    else {
      const missing = e.nodes.filter((n) => !info[n]);
      if (missing.length) reasons.push('missing nodes ' + missing.join(', ') + (missing.includes('UnetLoaderGGUF') ? ' - restart the studio (stop.sh -> start.sh): the ComfyUI-GGUF node attaches at startup' : ''));
      const list = (node, field) => info[node]?.input?.required?.[field]?.[0] || [];
      if (e.unet && info.UnetLoaderGGUF && !list('UnetLoaderGGUF', 'unet_name').includes(e.unet)) reasons.push('no weights ' + e.unet);
      if (e.lora && info.LoraLoaderModelOnly && !list('LoraLoaderModelOnly', 'lora_name').includes(e.lora)) reasons.push('no LoRA ' + e.lora);
      if (e.clip && !list('CLIPLoader', 'clip_name').includes(e.clip)) reasons.push('no text encoder ' + e.clip);
      if (e.vae && !list('VAELoader', 'vae_name').includes(e.vae)) reasons.push('no VAE ' + e.vae);
      if (e.checkpoint && !list('CheckpointLoaderSimple', 'ckpt_name').includes(e.checkpoint)) reasons.push('no ' + e.checkpoint);
    }
    if (e.gateMiB && vramMiB > 0 && vramMiB < e.gateMiB) reasons.push(`wants at least ${Math.round(e.gateMiB / 1024)} GB of video memory (this card has ${Math.round(vramMiB / 1024)} GB) - style series fall back to FLUX.2 klein`);
    engines[id] = { label: e.label, license: e.license, commercial: e.commercial, edit: e.edit, gateMiB: e.gateMiB || null, ready: reasons.length === 0, reasons };
  }
  return { online: !!info, ready: Object.values(engines).some((e) => e.ready), engines };
}

const copyRef = async (dir, name, file) => {
  if (!file) return null;
  if (!existsSync(file)) throw new Error('No file ' + file);
  const ext = path.extname(file).toLowerCase() || '.png';
  const rel = path.join('refs', name + ext);
  await fs.copyFile(file, path.join(dir, rel));
  return rel.replaceAll('\\', '/');
};

/**
 * Create a set folder with its manifest; nothing is generated yet.
 * o: {recipe, style, engine, prompt, action, direction, frames, scenes, views, parts, seed, sheet,
 *     character (file), styleImage (file), poses (files[]), inputs (files[]), name}
 */
export async function createSet(o, { root = ART2D_ROOT } = {}) {
  const recipe = RECIPES[o.recipe];
  if (!recipe) throw new Error('Unknown 2D recipe: ' + o.recipe);
  if (!STYLES[o.style || 'painted']) throw new Error('Unknown 2D style: ' + o.style);
  const engine = o.engine || 'flux2';
  const e = ENGINES[engine];
  if (!e) throw new Error('Unknown 2D engine: ' + engine);
  if (recipe.needsCharacter && !o.character) throw new Error(`Recipe "${recipe.label}" needs a character picture.`);
  if (recipe.edit && o.recipe !== 'storyboard' && !e.edit && !(engine === 'sdxl' && o.recipe === 'restyle'))
    throw new Error(`${e.label} cannot draw from a reference. Pick FLUX.2 for "${recipe.label}".`);
  const id = o.id || randomUUID();
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, 'refs'), { recursive: true });
  const refs = {
    character: await copyRef(dir, 'character', o.character),
    styleImage: await copyRef(dir, 'style', o.styleImage),
    poses: [], inputs: [],
  };
  for (const [i, f] of (o.poses || []).entries()) refs.poses.push(await copyRef(dir, 'pose_' + String(i).padStart(2, '0'), f));
  for (const [i, f] of (o.inputs || []).entries()) refs.inputs.push(await copyRef(dir, 'input_' + String(i).padStart(2, '0'), f));
  // the style bible (ticket 07): its pictures are copied in, its text is remembered - the set keeps
  // the look it was made with even if the bible is edited afterwards
  refs.styleBible = [];
  for (const [i, f] of (o.styleBible?.files || []).entries()) refs.styleBible.push(await copyRef(dir, 'bible_' + String(i).padStart(2, '0'), f));
  const styleBible = o.styleBible?.id ? { id: o.styleBible.id, name: o.styleBible.name || '', description: o.styleBible.description || '', negative: o.styleBible.negative || '' } : null;
  const shots = expandRecipe({ ...o, hasCharacter: !!refs.character, poses: refs.poses.length, inputs: refs.inputs.length });
  const seed = Number.isFinite(Number(o.seed)) ? Math.trunc(Number(o.seed)) : Math.floor(Math.random() * 1e9);
  const style = o.style || 'painted';
  const set = {
    app: 'AstraForge', kind: 'art2d', version: 1, id, name: o.name || `${recipe.label}${o.action ? ' \u00b7 ' + (ACTIONS[o.action]?.label || o.action) : ''}`,
    recipe: o.recipe, style, engine, license: { engine: e.license, commercial: e.commercial },
    styleBible, engineNote: o.engineNote || null,
    params: { prompt: o.prompt || '', action: o.action || null, direction: o.direction || 'right', frames: o.frames || null, chain: !!o.chain, sheet: o.sheet || 'default', seed, steps: o.steps || null },
    refs, createdAt: nowIso(),
    shots: shots.map((s, i) => ({ ...s, seed: seed + (s.seedOffset ?? (o.recipe === 'animation' || o.recipe === 'poses3d' ? 0 : i)), status: 'pending' })),
    outputs: {},
  };
  return { dir, set: await saveSet(dir, set) };
}

/** The prompt a shot is drawn with (exported for tests): recipe text + style tab style + bible recipe. */
export function finalPrompt(set, shot) {
  const styleImage = !!set.refs.styleImage && ENGINES[set.engine].edit;
  let p = shot.prompt + styleSuffix(set.style, { styleImage });
  if (styleImage) p += ' ' + STYLE_REF_PROMPT;
  if (set.styleBible?.description) p += ' ' + set.styleBible.description;   // the bible's EN recipe, written for generators (ticket 06)
  return p.replace(/\s+/g, ' ').trim();
}

function resolveRefs(dir, set, shot, index) {
  const files = [];
  for (const r of shot.refs || []) {
    let rel = null;
    if (r === 'character') rel = set.refs.character;
    else if (r === 'prev') rel = index > 0 ? set.shots[index - 1].file : null;
    else if (r === 'first') rel = set.shots[0].file;
    else if (r.startsWith('pose:')) rel = set.refs.poses[Number(r.slice(5))];
    else if (r.startsWith('input:')) rel = set.refs.inputs[Number(r.slice(6))];
    if (!rel) {
      if (r === 'prev') continue;   // the first frame has no previous one
      throw new Error('Missing reference ' + r + ' for shot ' + shot.key);
    }
    files.push(path.join(dir, rel));
  }
  if (set.refs.styleImage && ENGINES[set.engine].edit) files.push(path.join(dir, set.refs.styleImage));
  // bible pictures ride last: character and pose are composition, the bible is the look (ticket 07)
  if (set.refs.styleBible?.length && ENGINES[set.engine].edit) for (const rel of set.refs.styleBible) files.push(path.join(dir, rel));
  return files.slice(0, ENGINES[set.engine].maxRefs || 0);
}

async function refSize(file) {
  // PNG/JPEG header sniff, enough for "keep the aspect of the input"
  const b = await fs.readFile(file);
  if (b.subarray(1, 4).toString() === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Generate the pending shots (or `only` keys, re-drawing them), then post-process and assemble.
 * Re-running a set continues where it stopped; finished shots are kept.
 */
/**
 * 0.7.9 fold wave ticket 52: the set was recorded with an engine - demand that engine's OWN
 * weight files up front, by name. A missing file is said honestly ('no weights <file>'), the run
 * never fails cryptically inside ComfyUI mid-draw, and never answers by borrowing another
 * klein's files: the video-memory gate reason is deliberately NOT a refusal here, because an
 * explicit pick on a small card stays the user's call (ticket 07). fetchFn is the test seam.
 */
export async function assertEngineWeights(engine, comfyUrl = DEFAULT_COMFY_URL, fetchFn = fetch) {
  const st = await art2dStatus(comfyUrl, { fetchFn });
  const reasons = (st.engines[engine]?.reasons || []).filter((r) => !/video memory/.test(r));
  if (reasons.length) throw new Error(`${ENGINES[engine]?.label || engine}: ${reasons.join('; ')}`);
}

export async function runSet(dir, { comfyUrl = DEFAULT_COMFY_URL, signal, onProgress = () => {}, only = null, newSeed = false } = {}) {
  let set = await loadSet(dir);
  if (!set) throw new Error('2D set not found: ' + dir);
  const e = ENGINES[set.engine];
  await requireNodes(comfyUrl, e.nodes).catch((err) => {
    throw new Error(err.message.includes('UnetLoaderGGUF') ? 'The studio engine has no GGUF node. Restart the studio (stop.sh -> start.sh) so ComfyUI-GGUF attaches.' : err.message);
  });
  // ticket 52: the engine's own weights are demanded by name before the first upload
  await assertEngineWeights(set.engine, comfyUrl);
  await fs.mkdir(path.join(dir, 'raw'), { recursive: true });
  const todo = set.shots.map((s, i) => [s, i]).filter(([s]) => (only ? only.includes(s.key) : s.status !== 'done'));
  if (only) for (const [s] of todo) { s.status = 'pending'; if (newSeed) s.seed = Math.floor(Math.random() * 1e9); }
  set.run = { status: 'running', startedAt: nowIso(), done: 0, total: todo.length };
  await saveSet(dir, set);
  // cancelling must stop the GPU too, not only stop waiting for it
  const interrupt = () => { void fetch(comfyUrl + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {}); };
  signal?.addEventListener('abort', interrupt, { once: true });
  const started = Date.now();
  try {
    for (const [shot, index] of todo) {
      signal?.throwIfAborted();
      const t0 = Date.now();
      onProgress(`${shot.label}: drawing (${set.run.done + 1} of ${todo.length})`);
      const refFiles = resolveRefs(dir, set, shot, index);
      const names = [];
      for (const [k, f] of refFiles.entries()) names.push(await uploadImage(comfyUrl, f, `astra2d_${set.id.slice(0, 8)}_${shot.key}_${k}${path.extname(f)}`));
      let { w, h } = shot;
      if (shot.sizeFromRef && refFiles[0]) {
        const sz = await refSize(refFiles[0]);
        if (sz) { const k = Math.sqrt((1024 * 1024) / (sz.w * sz.h)); w = sz.w * k; h = sz.h * k; }
      }
      const prompt = finalPrompt(set, shot);
      const negative = NEGATIVE + (set.styleBible?.negative ? ' ' + set.styleBible.negative : '');
      const wf = buildWorkflow(set.engine, { prompt, negative, refs: names, width: w, height: h, seed: shot.seed, steps: set.params.steps || undefined, prefix: `astra_2d/${set.id.slice(0, 8)}_${shot.key}` });
      const run = await withEngineGpu('hunyuan', () => runWorkflow(comfyUrl, wf, { signal, onProgress: (t) => onProgress(`${shot.label}: ${t}`) }),
        { signal, failOpen: true, timeoutMs: 60 * 60 * 1000, urls: { hunyuan: comfyUrl }, onWait: () => onProgress('Waiting for the GPU to free up'), onStep: onProgress });
      const img = Object.values(run.outputs).flatMap((x) => x.images || [])[0];
      if (!img) throw new Error('The engine returned no picture for ' + shot.label);
      const rel = `raw/${shot.key}.png`;
      await downloadOutput(comfyUrl, img, path.join(dir, rel));
      Object.assign(shot, { status: 'done', file: rel, prompt_final: prompt, seconds: Math.round((Date.now() - t0) / 100) / 10, at: nowIso(), error: null });
      delete shot.cutFile; delete shot.pixelFile;
      set.run.done++;
      await saveSet(dir, set);
    }
    onProgress('Post-processing: cutting the background and assembling the sheets');
    set = await postProcess(dir, set);
    set.run = { ...set.run, status: 'completed', finishedAt: nowIso(), seconds: Math.round((Date.now() - started) / 1000) };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    set.run = { ...set.run, status: aborted ? 'cancelled' : 'failed', finishedAt: nowIso(), error: aborted ? null : String(err.message || err).slice(0, 900) };
    await saveSet(dir, set);
    throw err;
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }
  return saveSet(dir, set);
}

/** Cut-outs, pixel art, sheet / board / parts manifest. Idempotent: re-run after re-drawing a shot. */
export async function postProcess(dir, set, { signal } = {}) {
  const done = set.shots.filter((s) => s.status === 'done' && s.file);
  if (!done.length) return set;
  const pixel = STYLES[set.style]?.post?.pixel;
  const ops = [];
  for (const s of done) {
    let src = path.join(dir, s.file);
    if (s.cut) { ops.push({ op: 'cut', in: src, out: path.join(dir, 'cut', s.key + '.png'), pad: 8 }); src = path.join(dir, 'cut', s.key + '.png'); }
    if (pixel) ops.push({ op: 'pixel', in: src, out: path.join(dir, 'px', s.key + '.png'), cell: pixel.cell, colors: pixel.colors });
  }
  const finalOf = (s) => path.join(dir, pixel ? `px/${s.key}.png` : s.cut ? `cut/${s.key}.png` : s.file);
  const out = path.join(dir, 'out');
  const preset = SHEET_PRESETS[set.params.sheet] || SHEET_PRESETS.default;
  const sheetLike = ['animation', 'poses3d', 'turnaround', 'expressions', 'parts', 'concept'].includes(set.recipe);
  if (sheetLike) {
    ops.push({
      op: 'sheet', items: done.map(finalOf), out: path.join(out, 'sheet.png'),
      cols: set.recipe === 'animation' || set.recipe === 'poses3d' ? Math.min(done.length, 8) : Math.min(done.length, 5),
      cell: preset.cell, anchor: preset.anchor,
      fit: set.recipe === 'parts' || set.recipe === 'expressions' ? 'each' : 'common',
    });
  }
  if (set.recipe === 'storyboard' || set.recipe === 'restyle')
    ops.push({ op: 'board', items: done.map(finalOf), captions: done.map((s) => s.caption || s.label), out: path.join(out, 'board.png'), cols: 3, thumb: 640 });
  const jobFile = path.join(dir, 'post_job.json');
  await fs.writeFile(jobFile, JSON.stringify({ ops }));
  const res = await runPython(POST, ['run', '--job', jobFile], { signal, timeoutMs: 20 * 60 * 1000 });
  const results = res.results;
  let k = 0;
  for (const s of done) {
    if (s.cut) { s.cutFile = `cut/${s.key}.png`; s.cutInfo = results[k++]; }
    if (pixel) { s.pixelFile = `px/${s.key}.png`; k++; }
    s.final = path.relative(dir, finalOf(s)).replaceAll('\\', '/');
  }
  set.outputs = {};
  if (sheetLike) {
    const sh = results[k++];
    set.outputs.sheet = { file: 'out/sheet.png', preset: set.params.sheet || 'default', cols: sh.cols, rows: sh.rows, cell: sh.cell, anchor: sh.anchor, frames: done.map((s, i) => ({ key: s.key, label: s.label, ...sh.frames[i] })) };
    await fs.writeFile(path.join(out, 'sheet.json'), JSON.stringify(set.outputs.sheet, null, 2));
  }
  if (set.recipe === 'storyboard' || set.recipe === 'restyle') set.outputs.board = { file: 'out/board.png' };
  if (set.recipe === 'parts') {
    const parts = done.map((s) => ({ key: s.key, label: s.label, file: s.final, size: s.cutInfo?.size || null, pivot: s.rig?.pivot || [0.5, 0.5], parent: s.rig?.parent ?? null }));
    set.outputs.parts = { file: 'out/parts.json' };
    await fs.writeFile(path.join(out, 'parts.json'), JSON.stringify({ character: set.name, parts }, null, 2));
  }
  return saveSet(dir, set);
}

// ---------- Godot 4.5 export ----------

const tresNum = (n) => (Number.isInteger(n) ? n + '.0' : String(n));

/** SpriteFrames .tres over one sheet texture (one animation named after the action). */
export function spriteFramesTres({ texture, animation, frames, fps = 8, loop = true }) {
  const lines = [`[gd_resource type="SpriteFrames" load_steps=${frames.length + 2} format=3]`, '', `[ext_resource type="Texture2D" path="res://${texture}" id="1"]`, ''];
  frames.forEach((f, i) => {
    lines.push(`[sub_resource type="AtlasTexture" id="a${i}"]`, 'atlas = ExtResource("1")', `region = Rect2(${f.x}, ${f.y}, ${f.w}, ${f.h})`, '');
  });
  lines.push('[resource]', 'animations = [{', '"frames": [' + frames.map((_, i) => `{\n"duration": 1.0,\n"texture": SubResource("a${i}")\n}`).join(', ') + '],',
    `"loop": ${loop},`, `"name": &"${animation}",`, `"speed": ${tresNum(fps)}`, '}]', '');
  return lines.join('\n');
}

/** Cutout rig scene: Node2D root, Sprite2D per part, parented per parts.json; pivot = sprite offset. Parts start stacked
 *  at their parent's joint - positions are meant to be adjusted once in the Godot editor (the honest part of automation). */
export function cutoutTscn({ name, parts, dirRes }) {
  const ext = parts.map((p, i) => `[ext_resource type="Texture2D" path="res://${dirRes}/${p.key}.png" id="${i + 1}"]`);
  const lines = [`[gd_scene load_steps=${parts.length + 1} format=3]`, '', ...ext, '', `[node name="${name.replace(/[^\w]/g, '_') || 'Character2D'}" type="Node2D"]`, ''];
  const chainOf = (key) => {
    const chain = [];
    let p = parts.find((x) => x.key === key);
    while (p) { chain.unshift(p.key); p = parts.find((x) => x.key === p.parent); }
    return chain;
  };
  for (const [i, p] of parts.entries()) {
    const chain = chainOf(p.key);
    const parent = chain.length > 1 ? chain.slice(0, -1).join('/') : '.';
    const [w, h] = p.size || [256, 256];
    const off = [Math.round((0.5 - p.pivot[0]) * w), Math.round((0.5 - p.pivot[1]) * h)];
    lines.push(`[node name="${p.key}" type="Sprite2D" parent="${parent}"]`, `texture = ExtResource("${i + 1}")`, `offset = Vector2(${off[0]}, ${off[1]})`, '');
  }
  return lines.join('\n');
}

/** Writes out/godot/<slug>/ ready to copy under res://. Returns the folder. */
export async function exportGodot(dir, { resPrefix = 'assets/art2d' } = {}) {
  const set = await loadSet(dir);
  if (!set) throw new Error('Set not found.');
  const slug = (set.name || set.id).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40) || set.id.slice(0, 8);
  const ascii = /^[\x20-\x7e]+$/.test(slug) ? slug : `${set.recipe}_${set.id.slice(0, 8)}`;
  const outDir = path.join(dir, 'out', 'godot', ascii);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const res = `${resPrefix}/${ascii}`;
  const files = [];
  const done = set.shots.filter((s) => s.status === 'done' && s.final);
  if (set.outputs.sheet && (set.recipe === 'animation' || set.recipe === 'poses3d')) {
    await fs.copyFile(path.join(dir, set.outputs.sheet.file), path.join(outDir, 'sheet.png'));
    const act = ACTIONS[set.params.action] || { fps: 8, loop: true };
    const anim = set.params.action || 'default';
    await fs.writeFile(path.join(outDir, `${anim}.tres`), spriteFramesTres({ texture: `${res}/sheet.png`, animation: anim, frames: set.outputs.sheet.frames, fps: act.fps, loop: act.loop }));
    files.push('sheet.png', `${anim}.tres`);
  } else if (set.recipe === 'parts') {
    await fs.mkdir(path.join(outDir, 'parts'), { recursive: true });
    const parts = done.map((s) => ({ key: s.key, size: s.cutInfo?.size, pivot: s.rig?.pivot || [0.5, 0.5], parent: s.rig?.parent ?? null }));
    for (const s of done) await fs.copyFile(path.join(dir, s.final), path.join(outDir, 'parts', s.key + '.png'));
    await fs.writeFile(path.join(outDir, 'character_cutout.tscn'), cutoutTscn({ name: ascii, parts, dirRes: `${res}/parts` }));
    files.push('parts/', 'character_cutout.tscn');
  } else {
    for (const s of done) { await fs.copyFile(path.join(dir, s.final), path.join(outDir, s.key + '.png')); files.push(s.key + '.png'); }
    if (set.outputs.sheet) { await fs.copyFile(path.join(dir, set.outputs.sheet.file), path.join(outDir, 'sheet.png')); files.push('sheet.png'); }
    if (set.outputs.board) { await fs.copyFile(path.join(dir, set.outputs.board.file), path.join(outDir, 'board.png')); files.push('board.png'); }
  }
  const license = `Made with AstraForge (2D), engine ${ENGINES[set.engine].label}, weights licence: ${set.license.engine}.` + (set.license.commercial ? '' : ' Noncommercial use only until re-drawn by a commercial model.');
  await fs.writeFile(path.join(outDir, 'ASSET_INFO.txt'), [license, `Set: ${set.id}`, `Recipe: ${set.recipe}, style: ${set.style}, seed: ${set.params.seed}`, `Path in the project: res://${res}/`, ''].join('\n'), 'utf8');
  set.outputs.godot = { dir: path.relative(dir, outDir).replaceAll('\\', '/'), res: `res://${res}/`, files, at: nowIso() };
  await saveSet(dir, set);
  return outDir;
}

export async function listSets(root = ART2D_ROOT) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of await fs.readdir(root)) {
    const s = await loadSet(path.join(root, name));
    if (s?.kind === 'art2d') out.push(s);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
