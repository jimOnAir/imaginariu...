// Ticket 40 (0.7.1 wave): model-weight reuse. Windows 0.7 "weights other programs already
// downloaded are connected without copying" - the branch's own scanner/connector. A fake tree
// (studio root + an external ComfyUI + an HF-shaped cache) drives every rule: name+size match,
// sha256 only at accept, symlink (never copy), paths.json record, and the imaginarium_scan side reporting
// the result as `installed (external)` so no frontend offers to re-download it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectWeight, findByName, recordLinks, reportWeights, studioTarget, weightSearchDirs } from '../installer/imaginarium_weights.mjs';
import { modelState, scanItems } from '../installer/imaginarium_scan.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'imaginarium-wt-'));
  const man = {
    profiles: { quick: [], full: [], lite: [] },
    programs: { node: { version: '22.0.0' }, blender: { version: '5.0.1' }, comfy: { version: 'v0.3.0' } },
    clips: { size: 1, license: 'MIT' }, vfx: { size: 1, license: 'MIT' }, llm: { byVram: [{ minVramMiB: 0, model: 'x', size: 1 }] },
    models: {
      hy2: { file: 'hunyuan3d-dit-v2.safetensors', size: 5000, sha256: '', license: 'MIT' },
      sdxl: { file: 'sd_xl_base_1.0.safetensors', size: 999, sha256: 'deadbeef', license: 'MIT' },
      hymv: { file: 'hunyuan3d-dit-v2-mv.safetensors', size: 700, sha256: '00', license: 'MIT' },
      // scanComponents probes these too (the model loop and the 2D sets); none have a candidate.
      hy21: { file: 'hunyuan_3d_v2.1.safetensors', size: 4, sha256: '00', license: 'MIT' },
      hy2mini: { file: 'hunyuan3d-dit-v2-mini.safetensors', size: 4, sha256: '00', license: 'MIT' },
      u2net: { file: 'u2net.onnx', size: 4, sha256: '00', license: 'MIT' },
      flux2: { file: 'flux.gguf', dir: 'unet', size: 4, sha256: '00', license: 'Apache-2.0' },
      qwenimg: { file: 'qwen.gguf', dir: 'unet', size: 4, sha256: '00', license: 'Apache-2.0' },
      qwenedit: { file: 'qedit.gguf', dir: 'unet', size: 4, sha256: '00', license: 'Apache-2.0' },
    },
  };
  const content = Buffer.alloc(5000, 7);
  man.models.hy2.sha256 = sha(content);
  man.models.hymv.sha256 = sha(Buffer.alloc(700, 9));   // the HF-cache candidate's real bytes
  mkdirSync(path.join(root, 'installer'), { recursive: true });
  writeFileSync(path.join(root, 'installer', 'manifest.json'), JSON.stringify(man));
  // an external ComfyUI holds hy2 (exact bytes), a same-named wrong-size sdxl, and a nested
  // deep hit for hymv under an HF-cache-shaped snapshots folder; node_modules is off-limits.
  const ext = path.join(root, 'external');
  mkdirSync(path.join(ext, 'comfy', 'models', 'checkpoints'), { recursive: true });
  mkdirSync(path.join(ext, 'hf', 'Qwen-snap', 'snapshots', 'main'), { recursive: true });
  mkdirSync(path.join(ext, 'comfy', 'models', 'node_modules'), { recursive: true });
  writeFileSync(path.join(ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'), content);
  writeFileSync(path.join(ext, 'comfy', 'models', 'checkpoints', 'sd_xl_base_1.0.safetensors'), Buffer.alloc(998, 3));
  writeFileSync(path.join(ext, 'hf', 'Qwen-snap', 'snapshots', 'main', 'hunyuan3d-dit-v2-mv.safetensors'), Buffer.alloc(700, 9));
  writeFileSync(path.join(ext, 'comfy', 'models', 'node_modules', 'hunyuan3d-dit-v2.safetensors'), content);
  const env = { IMAGINARIUM_INSTALL_NO_GPU: '1', IMAGINARIUM_WEIGHT_DIRS: ext, HOME: path.join(root, 'no-home') };
  return { root, ext, man, env, content };
}

test('report: name+size matches only, biggest first, outdated files are not offered', () => {
  const f = fixture();
  try {
    const rep = reportWeights({ root: f.root, env: f.env });
    assert.deepEqual(rep.items.map((i) => i.id).sort(), ['hy2', 'hymv'],
      'the exact-size hits are offered; the wrong-size sdxl copy is a version question, not reuse');
    assert.deepEqual(rep.items.map((i) => i.id), ['hy2', 'hymv'], 'bytes order: 5000 before 700');
    const it = rep.items[0];
    assert.equal(it.bytes, 5000);
    assert.equal(it.source, path.join(f.ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'),
      'node_modules copies are never candidates');
    assert.equal(it.target, path.join(f.root, 'data', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'));
    assert.equal(rep.total, 5700);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('connect: sha256 verified against the pin, symlink placed, nothing moved or copied', async () => {
  const f = fixture();
  try {
    const rep = reportWeights({ root: f.root, env: f.env });
    const res = [];
    for (const it of rep.items) {
      const r = await connectWeight({ id: it.id, file: it.file, bytes: it.bytes, source: it.source, target: it.target, man: f.man });
      assert.ok(r.ok, `${it.id}: ${r.reason}`);
      res.push(r);
    }
    recordLinks(f.root, res);
    const link = path.join(f.root, 'data', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors');
    assert.ok(lstatSync(link).isSymbolicLink(), 'a link, not a copy');
    assert.equal(readlinkSync(link), path.join(f.ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'));
    assert.equal(statSync(path.join(f.ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors')).size, 5000,
      'the user file is still there, untouched');
    const cfg = JSON.parse(readFileSync(path.join(f.root, 'config', 'paths.json'), 'utf8'));
    assert.equal(cfg.weightLinks.length, 2);
    assert.equal(cfg.weightLinks[0].id, 'hy2');
    // the very same bytes are not hashed again when nothing else needs connecting:
    assert.deepEqual(reportWeights({ root: f.root, env: f.env }).items, [], 'after connect nothing is missing anymore');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a candidate whose bytes differ from the pin is refused, the link not placed', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'), Buffer.alloc(5000, 8));
    const it = reportWeights({ root: f.root, env: f.env }).items.find((x) => x.id === 'hy2');
    const r = await connectWeight({ id: it.id, file: it.file, bytes: it.bytes, source: it.source, target: it.target, man: f.man });
    assert.equal(r.ok, false);
    assert.match(r.reason, /sha256 does not match/);
    assert.ok(!existsSync(it.target), 'a refused candidate never becomes a link');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('no pin, no link: the branch does not connect files it cannot name', async () => {
  const f = fixture();
  try {
    const r = await connectWeight({ id: 'hy2', file: 'x', bytes: 1, source: path.join(f.ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'), target: path.join(f.root, 'data', 'models', 'checkpoints', 'x'), man: { models: { hy2: { file: 'x', size: 5000 } } } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no sha256 pinned/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a real file at the target is never replaced by a link', async () => {
  const f = fixture();
  try {
    const target = path.join(f.root, 'data', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(5000, 7));   // the user already downloaded it themselves
    const r = await connectWeight({ id: 'hy2', file: 'hunyuan3d-dit-v2.safetensors', bytes: 5000,
      source: path.join(f.ext, 'comfy', 'models', 'checkpoints', 'hunyuan3d-dit-v2.safetensors'), target, man: f.man });
    assert.equal(r.ok, false);
    assert.match(r.reason, /real file already sits/);
    assert.ok(!lstatSync(target).isSymbolicLink());
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('imaginarium_scan: a connected link reads installed (external) with the owner path, and no frontend re-downloads it', () => {
  const f = fixture();
  try {
    const it = reportWeights({ root: f.root, env: f.env }).items[0];
    mkdirSync(path.dirname(it.target), { recursive: true });
    symlinkSync(it.source, it.target);
    const st = modelState(f.root, '', f.man, 'hy2');
    assert.equal(st.st, 'installed');
    assert.equal(st.extern, it.source, 'the truth: this file is a link into someone else\'s folder');
    assert.equal(st.where, path.dirname(it.source), 'the human column names the external folder');
    // a link INTO the studio's own data stays plain installed:
    const ownReal = path.join(f.root, 'data', 'models', 'checkpoints', 'own-copy.bin');
    writeFileSync(ownReal, Buffer.alloc(700, 9));
    const inner = path.join(f.root, 'data', 'models', 'checkpoints', 'hunyuan3d-dit-v2-mv.safetensors');
    symlinkSync(ownReal, inner);
    assert.equal(modelState(f.root, '', f.man, 'hymv').extern, '', 'a link into the studio\'s own folder is not external');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('scanItems: the model row carries installed (external) through the frontend contract', () => {
  const man = JSON.parse(readFileSync(new URL('../installer/manifest.json', import.meta.url), 'utf8'));
  const s = {
    root: '/r', rt: '/r/runtime', man, env: {}, cfg: {}, noGpu: false, gpu: 'RTX 4070', vram: 12288, cc: '8.9', gpuBroken: '', adapters: [],
    node: '', nodeVer: '', npmDeps: false, ui: false, blender: '', blenderVer: '', comfy: '', comfyVer: '', comfyDeps: false, gguf: false,
    godot: '', godotVer: '', clips: 0, library: '/l', vfxDir: '/v', vfxOk: false, ollama: '', llms: [], vlm: false,
    hy2: { st: 'installed', where: '/home/u/ComfyUI/models/checkpoints', extern: '/home/u/ComfyUI/models/checkpoints/f.safetensors' },
    hymv: { st: 'missing', where: '' }, hy21: { st: 'missing', where: '' }, hy2mini: { st: 'missing', where: '' }, sdxl: { st: 'missing', where: '' }, u2net: { st: 'missing', where: '' },
    flux2: { st: 'missing', where: '' }, qwenimg: { st: 'missing', where: '' }, qwenedit: { st: 'missing', where: '' },
    mv: { ready: false, offer: false, reason: 'x', warn: '', bytes: 0 }, p3: { complete: false, offer: false, reason: 'x', warn: '', missingBytes: 0, engine: false },
    ts: { complete: false, offer: false, reason: 'x', env: false }, snd: { complete: false, offer: false, reason: 'x', env: false, codeBytes: 0, missingBytes: 0 },
    flux2old: [], free: 1e11,
  };
  const row = scanItems(s).find((x) => x.id === 'hy2');
  assert.equal(row.status, 'installed (external)');
  assert.equal(row.have, '/home/u/ComfyUI/models/checkpoints');
});

test('search dirs: IMAGINARIUM_WEIGHT_DIRS first, then the known homes, never the studio data twice', () => {
  const dirs = weightSearchDirs({ env: { IMAGINARIUM_WEIGHT_DIRS: '/a:/b', HOME: '/h' }, root: '/x/Studio' });
  assert.deepEqual(dirs.slice(0, 2), ['/a', '/b']);
  assert.ok(dirs.includes(path.join('/h', '.cache', 'huggingface', 'hub')));
  assert.ok(dirs.includes(path.join('/h', 'ComfyUI', 'models')));
  assert.ok(dirs.includes('/x/Imaginarium/data/models'), 'a sibling Imaginarium copy is searched');
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
});
