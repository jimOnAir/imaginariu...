#!/usr/bin/env node
// Pixel art from a prompt: SDXL + the pixel-art-xl LoRA in the local ComfyUI, then the deterministic
// post-processing of scripts/pixel/pixelize.py (downscale to pixels, palette, outline). See docs/forge/pixel.md.
//
//   node scripts/pixel/pixel_gen.mjs "medieval wooden chest" --out chest.png [--size 128] [--colors 32]
//        [--palette auto|file.gpl|.hex|.png] [--outline none|dark|auto] [--dither] [--remove-bg [--bg-tol 24]]
//        [--item] [--mode dominant|box|nearest] [--seed N] [--steps 20] [--cfg 7] [--lora-strength 1] [--negative "..."] [--preview 4] [--keep-raw]
//        [--comfy http://127.0.0.1:8188] [--checkpoint sd_xl_base_1.0.safetensors] [--lora pixel-art-xl.safetensors]
//
// Write the prompt in English (SDXL and the LoRA understand it best). Prints one JSON line with the result.
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIXELIZE = path.join(HERE, 'pixelize.py');
export const DEFAULTS = {
  comfy: 'http://127.0.0.1:8188',
  checkpoint: 'sd_xl_base_1.0.safetensors',
  lora: 'pixel-art-xl.safetensors',
  loraStrength: 1.0,
  steps: 20,
  cfg: 7,
  sampler: 'euler_ancestral',
  scheduler: 'normal',
  render: 1024, // the side SDXL renders; it is downscaled to --size afterwards
  size: 128,   // the long side of the finished pixel art
  colors: 32,
  outline: 'none',
  mode: 'dominant', // how to shrink the render: the most frequent colour of a block (the LoRA picture is already drawn in pixels)
  timeoutS: 600,
};
export const PROMPT_PREFIX = 'pixel art, pixel, ';
export const PROMPT_SUFFIX = ', clean pixel art, flat colors, crisp pixels, limited palette';
// --item mode: a single object on a flat background, the background is then cut to transparency
export const ITEM_SUFFIX = ', single isolated object, centered, plain flat light background, no shadow';
export const ITEM_NEGATIVE = 'shadow, drop shadow, ground, floor, reflection, scenery, multiple objects, border, frame';
export const NEGATIVE = 'blurry, realistic, photo, 3d render, smooth gradient, anti-aliasing, noisy, jpeg artifacts, text, watermark';

/** The ComfyUI graph in API format: checkpoint -> LoRA -> texts -> KSampler -> decoder -> file. */
export function buildWorkflow(o) {
  const w = o.width ?? o.render ?? DEFAULTS.render;
  const h = o.height ?? o.render ?? DEFAULTS.render;
  const positive = `${PROMPT_PREFIX}${o.prompt}${o.item ? ITEM_SUFFIX : ''}${o.noSuffix ? '' : PROMPT_SUFFIX}`;
  const negative = [NEGATIVE, o.item ? ITEM_NEGATIVE : '', o.negative ?? ''].filter(Boolean).join(', ');
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.checkpoint ?? DEFAULTS.checkpoint } },
    2: {
      class_type: 'LoraLoader',
      inputs: {
        model: ['1', 0],
        clip: ['1', 1],
        lora_name: o.lora ?? DEFAULTS.lora,
        strength_model: o.loraStrength ?? DEFAULTS.loraStrength,
        strength_clip: o.loraStrength ?? DEFAULTS.loraStrength,
      },
    },
    3: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 1] } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 1] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    6: {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0],
        seed: o.seed,
        steps: o.steps ?? DEFAULTS.steps,
        cfg: o.cfg ?? DEFAULTS.cfg,
        sampler_name: o.sampler ?? DEFAULTS.sampler,
        scheduler: o.scheduler ?? DEFAULTS.scheduler,
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['5', 0],
        denoise: 1,
      },
    },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'imaginarium_pixel' } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url}: HTTP ${res.status} ${body.slice(0, 400)}`);
  }
  return res.json();
}

/** Is the checkpoint in ComfyUI, is the LoRA there: a plain error before queueing. Nodes that do not answer with a list are skipped silently. */
export async function checkModels(base, o) {
  const names = async (node, field) => {
    try {
      const info = await getJson(`${base}/object_info/${node}`);
      return info?.[node]?.input?.required?.[field]?.[0] ?? null;
    } catch {
      return null;
    }
  };
  const ckpts = await names('CheckpointLoaderSimple', 'ckpt_name');
  if (Array.isArray(ckpts) && !ckpts.includes(o.checkpoint)) {
    throw new Error(`ComfyUI has no checkpoint ${o.checkpoint} (known: ${ckpts.slice(0, 8).join(', ') || 'none'})`);
  }
  const loras = await names('LoraLoader', 'lora_name');
  if (Array.isArray(loras) && !loras.includes(o.lora)) {
    throw new Error(`ComfyUI has no LoRA ${o.lora}: put it into models/loras (docs/forge/pixel.md) and restart ComfyUI`);
  }
}

/** Queues the graph, waits for the result and returns the PNG (Buffer) and its file name in ComfyUI. */
export async function runWorkflow(base, workflow, { timeoutS = DEFAULTS.timeoutS, pollMs = 700 } = {}) {
  let queued;
  try {
    queued = await getJson(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'imaginarium-pixel' }),
    });
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`ComfyUI does not answer on ${base}: start it and retry (${e.cause?.code ?? e.message})`);
    throw e;
  }
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`ComfyUI rejected the graph: ${JSON.stringify(queued.node_errors).slice(0, 600)}`);
  }
  const id = queued.prompt_id;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const hist = await getJson(`${base}/history/${id}`);
    const item = hist[id];
    if (item?.status?.status_str === 'error') throw new Error(`ComfyUI: execution failed ${JSON.stringify(item.status.messages ?? []).slice(0, 600)}`);
    const img = item?.outputs?.['8']?.images?.[0];
    if (img) {
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
      const res = await fetch(`${base}/view?${q}`);
      if (!res.ok) throw new Error(`GET /view: HTTP ${res.status}`);
      return { png: Buffer.from(await res.arrayBuffer()), file: img.filename, promptId: id };
    }
    await sleep(pollMs);
  }
  throw new Error(`ComfyUI did not answer within ${timeoutS} s (prompt_id ${id})`);
}

export function pythonCommand() {
  return process.platform === 'win32' ? { cmd: 'py', args: ['-3', '-I'] } : { cmd: 'python3', args: ['-I'] };
}

/** Runs pixelize.py and returns its JSON answer. */
export function runPixelize(input, output, o) {
  const args = [PIXELIZE, input, output, '--size', String(o.size ?? DEFAULTS.size), '--colors', String(o.colors ?? DEFAULTS.colors),
    '--outline', o.outline ?? DEFAULTS.outline, '--palette', o.palette ?? 'auto', '--mode', o.mode ?? DEFAULTS.mode];
  if (o.dither) args.push('--dither');
  if (o.removeBg) args.push('--remove-bg');
  if (o.bgTol != null) args.push('--bg-tol', String(o.bgTol));
  if (o.saturation) args.push('--saturation', String(o.saturation));
  if (o.levels) args.push('--levels');
  if (o.preview) args.push('--preview', String(o.preview));
  const py = pythonCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(py.cmd, [...py.args, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`could not start Python (${py.cmd}): ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`pixelize.py exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        reject(new Error(`pixelize.py did not return JSON: ${out.slice(0, 300)}`));
      }
    });
  });
}

/** The full path: prompt -> SDXL+LoRA render -> pixel art. Returns the report about the result. */
export async function generate(opts) {
  const o = { ...DEFAULTS, ...opts };
  if (o.item) o.removeBg = true;
  if (!o.prompt || !String(o.prompt).trim()) throw new Error('a prompt is required (in English)');
  if (!o.out) throw new Error('an --out file.png is required');
  o.seed ??= randomInt(0, 2 ** 31);
  const base = o.comfy.replace(/\/+$/, '');
  await checkModels(base, o);
  const { png, file, promptId } = await runWorkflow(base, buildWorkflow(o), { timeoutS: o.timeoutS, pollMs: o.pollMs });
  const out = path.resolve(o.out);
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = await mkdtemp(path.join(tmpdir(), 'imaginarium-pixel-'));
  try {
    const raw = path.join(tmp, 'raw.png');
    await writeFile(raw, png);
    if (o.keepRaw) await copyFile(raw, out.replace(/\.png$/i, '') + '.raw.png');
    const info = await runPixelize(raw, out, o);
    return { ...info, prompt: o.prompt, seed: o.seed, steps: o.steps, cfg: o.cfg, loraStrength: o.loraStrength, comfyFile: file, promptId };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const FLAGS = {
  '--out': ['out', String], '--size': ['size', Number], '--colors': ['colors', Number], '--palette': ['palette', String],
  '--outline': ['outline', String], '--seed': ['seed', Number], '--steps': ['steps', Number], '--cfg': ['cfg', Number],
  '--lora-strength': ['loraStrength', Number], '--negative': ['negative', String], '--preview': ['preview', Number],
  '--comfy': ['comfy', String], '--checkpoint': ['checkpoint', String], '--lora': ['lora', String],
  '--render': ['render', Number], '--timeout': ['timeoutS', Number], '--saturation': ['saturation', Number], '--mode': ['mode', String], '--bg-tol': ['bgTol', Number],
};
const SWITCHES = { '--dither': 'dither', '--remove-bg': 'removeBg', '--keep-raw': 'keepRaw', '--levels': 'levels', '--no-suffix': 'noSuffix', '--item': 'item' };

export function parseArgs(argv) {
  const o = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS[a]) {
      const [key, conv] = FLAGS[a];
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      const v = conv(argv[++i]);
      if (conv === Number && !Number.isFinite(v)) throw new Error(`${a}: a number was expected`);
      o[key] = v;
    } else if (SWITCHES[a]) o[SWITCHES[a]] = true;
    else if (a.startsWith('--')) throw new Error(`unknown parameter ${a}`);
    else words.push(a);
  }
  o.prompt = words.join(' ');
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const res = await generate(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, ...res }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
