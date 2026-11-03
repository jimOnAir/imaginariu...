// Pixel Art (docs/forge/pixel.md): pixelize.py (its Python tests) and the ComfyUI graph plus the whole
// pixel_gen.mjs path on a fake ComfyUI. No real ComfyUI or Blender needed; the Python tests are skipped
// without a Python 3 that has numpy and Pillow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildWorkflow, parseArgs, generate, pythonCommand, PROMPT_PREFIX, NEGATIVE, ITEM_NEGATIVE, DEFAULTS } from '../scripts/pixel/pixel_gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const py = pythonCommand();
const pyOk = spawnSync(py.cmd, [...py.args, '-c', 'import numpy, PIL'], { windowsHide: true }).status === 0;
const skipPy = pyOk ? false : 'needs Python 3 with numpy and Pillow';

const crc32 = (buf) => {
  let c;
  let crc = ~0;
  for (const b of buf) {
    c = (crc ^ b) & 255;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** RGBA PNG: a light background and a dark red square in the middle. */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x > w / 4 && x < (3 * w) / 4 && y > h / 4 && y < (3 * h) / 4;
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw.set(inside ? [150 + (x % 7), 20, 30, 255] : [245, 245, 240, 255], o);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let server;
let base;
let tmp;
let queued = [];
let loras = ['pixel-art-xl.safetensors'];

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'af-pixel-test-'));
  server = http.createServer((req, res) => {
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/object_info/CheckpointLoaderSimple') return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors']] } } } });
    if (req.url === '/object_info/LoraLoader') return json({ LoraLoader: { input: { required: { lora_name: [loras] } } } });
    if (req.method === 'POST' && req.url === '/prompt') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { queued.push(JSON.parse(body).prompt); json({ prompt_id: 'p1', node_errors: {} }); });
      return;
    }
    if (req.url === '/history/p1') return json({ p1: { status: { status_str: 'success' }, outputs: { 8: { images: [{ filename: 'x_00001_.png', subfolder: '', type: 'output' }] } } } });
    if (req.url.startsWith('/view?')) { res.setHeader('content-type', 'image/png'); return res.end(makePng(64, 64)); }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('pixelize.py: the Python tests (palettes, quantization, outline, dithering, CLI)', { skip: skipPy }, () => {
  const r = spawnSync(py.cmd, [...py.args, path.join(here, '..', 'scripts', 'pixel', 'test_pixelize.py')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /OK/);
});

test('the ComfyUI graph: checkpoint -> LoRA -> texts -> KSampler -> VAE -> file', () => {
  const w = buildWorkflow({ prompt: 'wooden chest', seed: 42, width: 1024, height: 1024 });
  assert.equal(w[1].class_type, 'CheckpointLoaderSimple');
  assert.equal(w[1].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors');
  assert.equal(w[2].class_type, 'LoraLoader');
  assert.deepEqual([w[2].inputs.lora_name, w[2].inputs.strength_model], ['pixel-art-xl.safetensors', 1.0]);
  assert.ok(w[3].inputs.text.startsWith(PROMPT_PREFIX + 'wooden chest'));
  assert.ok(w[4].inputs.text.startsWith(NEGATIVE) && w[4].inputs.text.includes('realistic'));
  assert.deepEqual(w[6].inputs.model, ['2', 0]);
  assert.deepEqual(w[3].inputs.clip, ['2', 1]);
  assert.deepEqual([w[6].inputs.seed, w[6].inputs.steps, w[6].inputs.cfg, w[6].inputs.sampler_name], [42, 20, 7, 'euler_ancestral']);
  assert.deepEqual([w[5].inputs.width, w[5].inputs.height], [1024, 1024]);
  assert.equal(w[8].class_type, 'SaveImage');
  const item = buildWorkflow({ prompt: 'sword', seed: 1, item: true, negative: 'blood' });
  assert.ok(item[3].inputs.text.includes('isolated') && item[4].inputs.text.includes(ITEM_NEGATIVE) && item[4].inputs.text.endsWith('blood'));
});

test('parseArgs: words are the prompt, flags are parameters, junk is rejected', () => {
  const o = parseArgs(['stone', 'tower', '--out', 'a.png', '--size', '64', '--dither', '--outline', 'auto', '--seed', '9']);
  assert.deepEqual([o.prompt, o.out, o.size, o.dither, o.outline, o.seed], ['stone tower', 'a.png', 64, true, 'auto', 9]);
  assert.throws(() => parseArgs(['x', '--nope']), /unknown parameter/);
  assert.throws(() => parseArgs(['x', '--size']), /needs a value/);
  assert.throws(() => parseArgs(['x', '--size', 'abc']), /a number was expected/);
});

test('generate: a fake ComfyUI -> a PNG of the right size, the item background transparent, deterministic post-processing', { skip: skipPy }, async () => {
  queued = [];
  const out1 = path.join(tmp, 'a', 'chest.png');
  const res = await generate({ comfy: base, prompt: 'chest', out: out1, size: 16, colors: 6, outline: 'dark', seed: 5, item: true, pollMs: 5 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.size, [16, 16]);
  assert.ok(res.colors >= 2 && res.colors <= 6, String(res.colors));
  assert.equal(queued.length, 1);
  assert.equal(queued[0][6].inputs.seed, 5);
  assert.equal(queued[0][5].inputs.width, DEFAULTS.render);
  const png = readFileSync(out1);
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
  // the same render and the same parameters give the same file
  const out2 = path.join(tmp, 'b', 'chest.png');
  await generate({ comfy: base, prompt: 'chest', out: out2, size: 16, colors: 6, outline: 'dark', seed: 5, item: true, pollMs: 5 });
  assert.deepEqual(readFileSync(out2), png);
  // --item cut the light background: the corner is transparent, the centre is not
  const probe = spawnSync(py.cmd, [...py.args, '-c', `from PIL import Image; im=Image.open(r'${out1}').convert('RGBA'); print(im.getpixel((0,0))[3], im.getpixel((8,8))[3])`], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '0 255');
});

test('generate: no LoRA in ComfyUI - a plain error before queueing; an empty prompt is rejected', async () => {
  queued = [];
  loras = ['other.safetensors'];
  await assert.rejects(generate({ comfy: base, prompt: 'x', out: path.join(tmp, 'c.png'), pollMs: 5 }), /no LoRA pixel-art-xl/);
  assert.equal(queued.length, 0);
  loras = ['pixel-art-xl.safetensors'];
  await assert.rejects(generate({ comfy: base, prompt: '  ', out: path.join(tmp, 'c.png') }), /a prompt is required/);
  await assert.rejects(generate({ comfy: 'http://127.0.0.1:1', prompt: 'x', out: path.join(tmp, 'c.png') }), /ComfyUI does not answer/);
  assert.equal(existsSync(path.join(tmp, 'c.png')), false);
});
