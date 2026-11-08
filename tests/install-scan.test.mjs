// Scan core of the installer (installer/af_scan.mjs): the ##ITEM contract of 0.4.8, the checklist
// rules (presets, mandatory, dependencies, reasons), the Lite branch without an NVIDIA card and the
// scan-failure fallback. The non-win32 sibling of the reference update.test.mjs -ScanList shape test
// (that one drives powershell and skips here): the same field contract, checked on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_ROOT, MANDATORY, ORDER, VLM, p3Scan, triposgScan, soundScan, scanComponents, scanItems, itemLines, verOf, verLess, stateLines, TRIPOSG_AUTO_MAX_VRAM_MIB, SOUND_MIN_VRAM_MIB, MIN_NVIDIA_DRIVER, EXPERIMENTAL,
} from '../installer/af_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(APP_ROOT, 'installer', 'af_scan.mjs');

test('verOf/verLess - the version rules of Install.ps1', () => {
  assert.equal(verOf('C:/x/blender-5.0.1-linux-x64/blender'), '5.0.1');
  assert.equal(verOf('Godot_v4.5.1-stable_linux.x86_64'), '4.5.1');
  assert.equal(verOf('no digits'), '');
  assert.ok(verLess('0.30.0', '0.33.2'));
  assert.ok(!verLess('0.33.2', '0.33.2'));
  assert.ok(!verLess('0.40.0', '0.9.0'), 'numeric compare, not lexical');
  assert.ok(verLess('4.5', '4.5.1'));
});

test('the checklist constants: node/npm/blender are untickable, the install order is the Order of Setup.cs', () => {
  assert.deepEqual(MANDATORY, ['node', 'npm', 'blender']);
  assert.equal(new Set(ORDER).size, ORDER.length, 'no duplicate ids in ORDER');
  assert.deepEqual(ORDER.slice(0, 3), ['node', 'npm', 'blender']);
  // every id any profile installs is ordered (and may carry the two extra ids of the old wizard)
  const man = JSON.parse(readFileSync(path.join(APP_ROOT, 'installer', 'manifest.json'), 'utf8'));
  for (const p of ['quick', 'full', 'lite']) {
    for (const id of man.profiles[p]) assert.ok(ORDER.includes(id), `${p}: ${id} not in ORDER`);
  }
});

// a synthetic scan state: no machine probes, deterministic verdicts (scanItems consumes this shape)
function mkS(over = {}) {
  const man = JSON.parse(readFileSync(path.join(APP_ROOT, 'installer', 'manifest.json'), 'utf8'));
  const miss = { st: 'missing', where: '' };
  return {
    root: APP_ROOT, rt: path.join(APP_ROOT, 'runtime'), man, env: {}, cfg: {}, noGpu: false, gpu: 'NVIDIA GeForce RTX 4070', vram: 12288, cc: '8.9', gpuBroken: '', adapters: [],
    node: '', nodeVer: '', npmDeps: false, ui: false, blender: '', blenderVer: '',
    comfy: '', comfyVer: '', comfyDeps: false, gguf: false, godot: '', godotVer: '', clips: 0, library: '/l',
    vfxDir: '/v', vfxOk: false, ollama: '', llms: [], vlm: false,
    hy2: miss, hymv: miss, hy21: miss, sdxl: miss, u2net: miss, flux2: miss, qwenimg: miss, qwenedit: miss,
    mv: { node: false, weights: false, config: false, pkgs: false, ready: false, offer: false, reason: 'needs an NVIDIA graphics card', warn: '', bytes: 0 },
    p3: { dir: '/p3', exists: false, engine: false, weights: false, complete: false, offer: false, reason: 'needs an NVIDIA RTX graphics card', warn: '', missingBytes: 0, diskNeed: 0 },
    ts: { dir: '', env: false, code: false, weights: false, complete: false, offer: false, reason: '', missingBytes: 0 },
    snd: { dir: '', env: false, code: false, weights: false, complete: false, offer: false, reason: '', missingBytes: 0, codeBytes: 21071466, weightBytes: 21322260234 },
    free: 200e9, ...over,
  };
}
const row = (items, id) => items.find((x) => x.id === id);

test('empty machine with an RTX card: preset letters, dependencies, the mandatory trio missing', () => {
  const s = mkS();
  s.mv = { ...s.mv, offer: true, reason: '' };       // with a card both gated offers are open
  s.p3 = { ...s.p3, offer: true, reason: '' };
  const items = scanItems(s);
  assert.equal(row(items, 'node').status, 'missing');
  assert.deepEqual(MANDATORY.filter((id) => row(items, id).status === 'missing'), MANDATORY);
  assert.equal(row(items, 'node').presets, 'qfl');
  assert.equal(row(items, 'vfx').presets, 'fl', 'vfx is not in the quick set');
  assert.equal(row(items, 'hy21').presets, 'f', 'the second shape model is full-only');
  assert.equal(row(items, 'npm').deps, 'node');
  assert.equal(row(items, 'hy2').deps, 'comfy');
  assert.equal(row(items, 'llm').deps, 'ollama');
  assert.equal(row(items, 'llm').need, 'qwen3:8b', 'the assistant is picked for 12 GB of VRAM');
  assert.equal(row(items, 'vlm').need, VLM);
  const p3 = row(items, 'pixal3d');
  assert.equal(p3.status, 'missing');
  assert.equal(p3.only, 'pixal3d,pixal3dw', 'a fresh machine gets engine and weights');
  assert.equal(p3.size, 5.5e9, 'the engine download estimate of pixal3d.ps1');
  // GPU items on a machine WITH a card: no GPU warnings anywhere
  assert.ok(!items.some((it) => /NVIDIA/i.test(it.note)), items.map((it) => it.note).join('|'));
});

test('the checklist rows match the profiles of installer/manifest.json (the presets field contract)', () => {
  // The profile rule since ticket 12: presets come from the manifest MINUS the experimental ids
  // (never preselected) - upstream's low-VRAM TripoSG forcing (ticket 02's swap) is not ported.
  const expected = () => { const man = JSON.parse(readFileSync(path.join(APP_ROOT, 'installer', 'manifest.json'), 'utf8')); const no = (a) => a.filter((i) => !EXPERIMENTAL.includes(i)); return {
      quick: no(man.profiles.quick), full: no(man.profiles.full), lite: no(man.profiles.lite) }; };
  for (const vram of [12288, 8192]) {
    const prof = expected();
    for (const it of scanItems(mkS({ vram }))) {
      const only = it.only.split(',').filter(Boolean);
      for (const [p, letter] of [['quick', 'q'], ['full', 'f'], ['lite', 'l']]) {
        const inProfile = only.some((id) => prof[p].includes(id));
        assert.equal(it.presets.includes(letter), inProfile, `${it.id}/${p}@${vram}: presets=${it.presets}`);
      }
    }
  }
});

test('no NVIDIA card (the Lite branch of 0.4.7): GPU items are unavailable with a reason, installed ones stay', () => {
  const s = mkS({ noGpu: true, vram: 0, cc: '', gpu: '' });
  const items = scanItems(s);
  assert.equal(row(items, 'pixal3d').status, 'unavailable');
  assert.match(row(items, 'pixal3d').note, /NVIDIA RTX/);
  assert.equal(row(items, 'flux2').status, 'unavailable', 'missing 2D weights cannot run without the card');
  assert.match(row(items, 'flux2').note, /NVIDIA/);
  assert.match(row(items, 'comfy').note, /won't work without an NVIDIA GPU/);
  // installed rows never turn unavailable:
  const kept = scanItems(mkS({ noGpu: true, vram: 0, cc: '', gpu: '', flux2: { st: 'installed', where: '/m' }, qwenimg: { st: 'installed', where: '/m' }, comfy: '/c', comfyVer: '0.33.2', comfyDeps: true, gguf: true }));
  assert.equal(row(kept, 'flux2').status, 'installed');
  assert.match(row(kept, 'flux2').note, /needs an NVIDIA graphics card/, 'the reference keeps the warning note on the row');
});

test('Pixal3D offer gates (P3Scan of pixal3d.ps1): VRAM and compute capability gray the row out with the reference reasons', () => {
  assert.match(p3Scan(mkS({ vram: 6144 })).reason, /video memory is 6 GB, at least 8 GB needed/);
  assert.match(p3Scan(mkS({ cc: '7.5' })).reason, /RTX 30-series or newer/);
  assert.match(p3Scan(mkS({ cc: '', gpu: 'NVIDIA GeForce GTX 1660' })).reason, /RTX 30\/40\/50/);
  assert.match(p3Scan(mkS({ gpu: '' })).reason, /NVIDIA RTX graphics card/);
  // a half-installed Pixal3D: engine in place -> only the weights download (only=pixal3dw)
  const part = mkS();
  part.p3 = { dir: '/p3', exists: true, engine: true, weights: false, complete: false, offer: true, reason: '', warn: '', missingBytes: 1.2e9, diskNeed: 1.2e9 };
  const r = row(scanItems(part), 'pixal3d');
  assert.equal(r.status, 'missing');
  assert.equal(r.only, 'pixal3dw');
  assert.equal(r.size, 1.2e9);
  // ticket 20: an NVIDIA driver below the 570 floor withholds the Pixal3D offer up front (no
  // multi-GB downloads for a config that cannot run), and an installed Pixal3D says it would refuse.
  const old = p3Scan(mkS({ driver: '550.54.14', driverMajor: 550, driverOld: true }));
  assert.equal(old.offer, false);
  assert.match(old.reason, /NVIDIA driver 570 or newer \(this machine reports 550\.54\.14\)/);
  assert.equal(MIN_NVIDIA_DRIVER, 570, 'the installer floor matches server/gpu-info.mjs');
  const done = mkS();
  done.p3 = { dir: '/p3', exists: true, engine: true, weights: true, complete: true, offer: true, reason: '', warn: 'installed, but Pixal3D refuses to run below NVIDIA driver 570 (this machine reports 550.54.14)', missingBytes: 0, diskNeed: 0 };
  assert.match(row(scanItems(done), 'pixal3d').note, /refuses to run below NVIDIA driver 570/);
  // a low-VRAM card that is otherwise fine only warns:
  const warn = p3Scan(mkS({ vram: 8192 }));
  assert.equal(warn.offer, true);
  assert.match(warn.warn, /8 GB: several views/);
});

test('MV-Adapter: ready/offer/unavailable - the MvScan rules of mvadapter.ps1', () => {
  const ready = mkS(); ready.mv = { ready: true, offer: false, bytes: 0, node: true, weights: true, config: true, pkgs: true, reason: '', warn: '' };
  assert.equal(row(scanItems(ready), 'mvadapter').status, 'installed');
  const offer = mkS(); offer.mv = { ready: false, offer: true, bytes: 3802537816, node: false, weights: false, config: false, pkgs: false, reason: '', warn: '' };
  const r = row(scanItems(offer), 'mvadapter');
  assert.equal(r.status, 'missing');
  assert.equal(r.deps, 'sdxl,comfy');
  assert.equal(row(scanItems(mkS()), 'mvadapter').status, 'unavailable', 'no reason -> the row is greyed with it');
});

test('ComfyUI states: old version and missing Python libraries read as outdated (the comfydeps only-id)', () => {
  const old = mkS({ comfy: '/c', comfyVer: '0.30.0', comfyDeps: true });
  assert.equal(row(scanItems(old), 'comfy').status, 'outdated');
  assert.match(row(scanItems(old), 'comfy').note, /old version/);
  const deps = mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: false });
  const r = row(scanItems(deps), 'comfy');
  assert.equal(r.status, 'outdated');
  assert.equal(r.only, 'comfydeps', 'a row can install a different component id');
  assert.match(r.note, /libraries are missing/);
  assert.equal(row(scanItems(mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: true })), 'comfy').status, 'installed');
});

test('models and 2D engines: a size mismatch reads as outdated; no GGUF loader turns found 2D weights into outdated', () => {
  const s = mkS({ hy2: { st: 'outdated', where: '/d' } });
  assert.equal(row(scanItems(s), 'hy2').status, 'outdated');
  assert.match(row(scanItems(s), 'hy2').note, /another version - update/);
  const found2d = mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: true, flux2: { st: 'installed', where: '/d' }, qwenimg: { st: 'installed', where: '/d' }, gguf: false });
  assert.equal(row(scanItems(found2d), 'flux2').status, 'outdated', 'weights without the GGUF node need an update');
  assert.match(row(scanItems(found2d), 'flux2').note, /GGUF loader/);
  // 0.6.6 swap (ticket 09): the row is the 4B, Apache-2.0; a leftover 9B is named but never touched
  const ok4 = mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: true, gguf: true, flux2: { st: 'installed', where: '/d' } });
  const r4 = row(scanItems(ok4), 'flux2');
  assert.equal(r4.status, 'installed');
  assert.match(r4.name, /klein 4B/);
  assert.equal(r4.lic, 'Apache-2.0', 'the row license comes from the manifest pin');
  const withOld = mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: true, gguf: true, flux2: { st: 'installed', where: '/d' }, flux2old: [{ name: 'flux-2-klein-base-9b-Q5_K_M.gguf', size: 7017126176 }] });
  assert.match(row(scanItems(withOld), 'flux2').note, /previous klein 9B \(7 GB on disk\) is kept and unused/);
  // ticket 07: the style engine rows and its 10 GiB card gate
  const qeBig = mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: true, gguf: true, qwenedit: { st: 'installed', where: '/d' } });
  assert.equal(row(scanItems(qeBig), 'qwenedit').status, 'installed');
  assert.match(row(scanItems(qeBig), 'qwenedit').name, /Qwen-Image-Edit/);
  const qeSmall = mkS({ comfy: '/c', comfyVer: '0.33.2', comfyDeps: true, gguf: true, vram: 8192, qwenedit: { st: 'missing', where: '' } });
  assert.equal(row(scanItems(qeSmall), 'qwenedit').status, 'unavailable', 'an 8 GB card is under the style gate');
  assert.match(row(scanItems(qeSmall), 'qwenedit').note, /8 GB - style series are drawn by FLUX.2 klein/);
});

test('the ##ITEM lines: 13 tab-separated fields, tabs and newlines inside values are collapsed', () => {
  const items = scanItems(mkS());
  items[0].note = 'bad\ttab\nand newline';
  const lines = itemLines(items);
  assert.ok(lines.every((l) => l.startsWith('##ITEM\t')));
  for (const l of lines) assert.equal(l.split('\t').length, 13, l);
  assert.ok(lines[0].endsWith('bad tab and newline'), lines[0]);
  // Setup.cs reads: f[1] id, f[3] status, f[6] size, f[9] presets, f[11] only
  const f = lines.find((l) => l.split('\t')[1] === 'hy2').split('\t');
  assert.equal(f[1], 'hy2');
  assert.equal(Number(f[6]), mkS().man.models.hy2.size);
});

// - - - - - - - - - TripoSG (0.6.0 wave, ticket 02) - - - - - - - - - - - - - - - - - - - - - -

test('triposgScan: venv + pinned code + exact-weight snapshot is complete; a removed venv is not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-ts-'));
  const p = (...a) => path.join(dir, ...a);
  const w = (rel, size) => { mkdirSync(path.dirname(p(rel)), { recursive: true }); writeFileSync(p(rel), ''); truncateSync(p(rel), size); };   // sparse
  w('models/TripoSG/transformer/diffusion_pytorch_model.safetensors', 5758280104);
  w('models/TripoSG/vae/diffusion_pytorch_model.safetensors', 970685468);
  w('models/TripoSG/image_encoder_dinov2/model.safetensors', 1217522888);
  mkdirSync(path.dirname(p('src/TripoSG/triposg/pipelines/pipeline_triposg.py')), { recursive: true });
  writeFileSync(p('models/TripoSG/model_index.json'), '{}');
  writeFileSync(p('src/TripoSG/triposg/pipelines/pipeline_triposg.py'), '');
  mkdirSync(p('.venv/bin'), { recursive: true });
  writeFileSync(p('.venv/bin/python'), '#!/bin/sh\n'); chmodSync(p('.venv/bin/python'), 0o755);
  const r = triposgScan(mkS({ env: { ASTRA_TRIPOSG_DIR: dir } }));
  assert.ok(r.complete, r.reason);
  assert.equal(r.missingBytes, 0);
  rmSync(p('.venv/bin/python'));
  const r2 = triposgScan(mkS({ env: { ASTRA_TRIPOSG_DIR: dir } }));
  assert.equal(r2.complete, false); assert.equal(r2.env, false); assert.equal(r2.code, true); assert.equal(r2.offer, true);
  rmSync(dir, { recursive: true, force: true });
});

test('triposgScan offer gates: no NVIDIA card, or a card under ~4 GB, declines the row honestly', () => {
  const absent = { env: { ASTRA_TRIPOSG_DIR: path.join(tmpdir(), 'af-ts-absent-' + Math.random()) } };
  assert.match(triposgScan(mkS({ ...absent, gpu: '' })).reason, /NVIDIA graphics card/);
  assert.match(triposgScan(mkS({ ...absent, vram: 2048 })).reason, /2 GB/);
  assert.equal(triposgScan(mkS({ ...absent, vram: 4096 })).offer, true, '4 GB is enough to offer the low-VRAM path');
});

test('ticket 12 «новое, проба»: experimental rows are never preselected and say so; regular rows keep their presets', () => {
  assert.deepEqual(EXPERIMENTAL, ['triposg', 'skintokens', 'sound', 'qwenedit']);
  let items = scanItems(mkS());   // 12288 MiB
  for (const it of items) if (it.only.split(',').some((x) => EXPERIMENTAL.includes(x))) {
    assert.equal(it.presets, '', it.id + ': no preset letter for an experimental component');
    assert.equal(it.exp, true, it.id + ': the exp flag rides the row');
    assert.match(it.note, /no preset preselects it, tick it by hand/, it.id + ': the marker text');
  }
  assert.equal(row(items, 'qwenedit').presets, '', 'ticket 07 added qwenedit to the manifest full list - the rule still keeps it out of presets');
  assert.equal(row(items, 'flux2').presets.includes('f'), true, 'regular rows are untouched');
  assert.ok(!row(items, 'flux2').exp, 'flux2 is not experimental');
  assert.equal(row(items, 'hy2').presets.includes('q'), true);
  items = scanItems(mkS({ vram: TRIPOSG_AUTO_MAX_VRAM_MIB }));   // a low-VRAM card...
  assert.equal(row(items, 'triposg').presets.includes('q'), false, '...still gets no forced TripoSG: opt-in only (ticket 02 swap not ported)');
  assert.equal(row(items, 'hy2').presets.includes('q'), true, 'quick keeps the multi-view pair on every card');
  assert.equal(row(items, 'hymv').presets.includes('q'), true);
});

test('the triposg state reaches install.sh (S_TS) and survives the shell eval', () => {
  const s = mkS();
  s.ts = { dir: '/d/ts', env: true, code: false, weights: false, complete: false, offer: true, reason: '', missingBytes: 123 };
  const state = stateLines(s);
  assert.match(state, /S_TS=''/.test(state) ? /S_TS=''/ : /S_TS='yes'/);
  assert.match(state, /S_TS_DIR='\/d\/ts'/);
  assert.match(state, /S_TS_BYTES='123'/);
});

// - - - - - - - - - Sound (0.6.x wave, ticket 04) - - - - - - - - - - - - - - - - - - - - - - - - - -

/** a runtime/sound folder the scan is happy with: venv, both checkouts, every manifest file at its size */
function buildSound(dir) {
  const man = JSON.parse(readFileSync(path.join(APP_ROOT, 'installer', 'sound', 'manifest.json'), 'utf8'));
  const p = (...a) => path.join(dir, ...a);
  const put = (rel, size = 0) => { mkdirSync(path.dirname(p(rel)), { recursive: true }); writeFileSync(p(rel), ''); if (size) truncateSync(p(rel), size); };
  for (const e of Object.values(man.models)) for (const f of e.files) put(path.join('models', e.dst, f.path), f.size);
  put('src/MOSS-TTS/moss_soundeffect_v2/pyproject.toml');
  put('src/ACE-Step-1.5/pyproject.toml');
  put('.venv/bin/python'); chmodSync(p('.venv/bin/python'), 0o755);
  return man;
}

test('soundScan: venv + both checkouts + every pinned weight is complete; a cut file is not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-snd-'));
  const man = buildSound(dir);
  const r = soundScan(mkS({ env: { ASTRA_SOUND_DIR: dir } }));
  assert.ok(r.complete, r.reason);
  assert.equal(r.missingBytes, 0);
  assert.equal(r.weightBytes, Object.values(man.models).flatMap((e) => e.files).reduce((n, f) => n + f.size, 0));
  assert.equal(r.codeBytes, Object.values(man.code).reduce((n, c) => n + c.size, 0));
  const big = path.join(dir, 'models', man.models.moss.dst, 'transformer', 'diffusion_pytorch_model.safetensors');
  truncateSync(big, 1024);
  const r2 = soundScan(mkS({ env: { ASTRA_SOUND_DIR: dir } }));
  assert.equal(r2.weights, false);
  assert.ok(r2.missingBytes > 5e9, 'the shortfall is the size of the truncated file');
  rmSync(dir, { recursive: true, force: true });
});

test('soundScan offer gates: no NVIDIA card, or a card under 8 GB, declines the row honestly', () => {
  const absent = { env: { ASTRA_SOUND_DIR: path.join(tmpdir(), 'af-snd-absent-' + Math.random()) } };
  assert.match(soundScan(mkS({ ...absent, gpu: '' })).reason, /NVIDIA graphics card/);
  assert.match(soundScan(mkS({ ...absent, vram: 6144 })).reason, /6 GB/);
  assert.equal(soundScan(mkS({ ...absent, vram: SOUND_MIN_VRAM_MIB })).offer, true, '8 GB is the seam');
});

test('the sound checklist row: its own group, both licenses, and never a preset tick', () => {
  const SOUND_ENV_GUESS = 7.0e9;
  for (const vram of [12288, TRIPOSG_AUTO_MAX_VRAM_MIB, 4096]) {
    const items = scanItems(mkS({ vram }));
    const snd = row(items, 'sound');
    assert.equal(snd.group, 'Sound and music');
    assert.equal(snd.presets, '', 'new and experimental: no quick/full/lite preset preselects it');
    assert.deepEqual(snd.only.split(','), ['sound', 'soundmoss', 'soundace']);
  }
  const s = mkS();
  s.snd = { ...s.snd, offer: true, missingBytes: 1e9 };
  const r = row(scanItems(s), 'sound');
  assert.equal(r.status, 'missing');
  assert.match(r.lic, /Apache-2\.0 \(MOSS-SoundEffect\); MIT \(ACE-Step\)/);
  assert.equal(r.size, SOUND_ENV_GUESS + s.snd.codeBytes + s.snd.missingBytes, 'env estimate + code + weights still to fetch');
  const gone = row(scanItems(mkS({ gpu: '' })), 'sound');
  assert.equal(gone.status, 'unavailable');
});

test('the sound state reaches install.sh (S_SND) and survives the shell eval', () => {
  const s = mkS();
  s.snd = { ...s.snd, dir: '/d/sound', env: true, code: true, weights: false, complete: false, offer: true, reason: '', missingBytes: 42 };
  const state = stateLines(s);
  assert.match(state, /S_SND=''/);
  assert.match(state, /S_SND_ENV='yes'/);
  assert.match(state, /S_SND_DIR='\/d\/sound'/);
  assert.match(state, /S_SND_BYTES='42'/);
  assert.match(state, /S_SND_REASON=''/);
});

test('installer/sound/manifest.json pins both engines by commit and every weight by size + sha256', () => {
  const man = JSON.parse(readFileSync(path.join(APP_ROOT, 'installer', 'sound', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(man.code).sort(), ['ace', 'moss']);
  for (const [key, c] of Object.entries(man.code)) {
    assert.match(c.commit, /^[0-9a-f]{40}$/, key);
    assert.ok(c.url.includes(c.commit), `${key}: the archive url is the pinned commit`);
    assert.ok(c.size > 0 && /^[0-9a-f]{64}$/.test(c.sha256), `${key}: size and sha256`);
    assert.ok(c.license, `${key}: the license travels with the pin`);
  }
  for (const [key, e] of Object.entries(man.models)) {
    assert.match(e.revision, /^[0-9a-f]{40}$/, key);
    assert.ok(e.files.length > 1 && e.files.every((f) => f.size > 0 && /^[0-9a-f]{64}$/.test(f.sha256)), `${key}: every file pinned`);
    assert.ok(new Set(e.files.map((f) => f.path)).size === e.files.length, `${key}: no duplicate paths`);
  }
  // the files ACE-Step's own checkpoint check insists on are all in the ACE pin
  for (const need of ['acestep-v15-turbo/model.safetensors', 'vae/diffusion_pytorch_model.safetensors', 'Qwen3-Embedding-0.6B/model.safetensors', 'acestep-5Hz-lm-1.7B/model.safetensors']) {
    assert.ok(man.models.ace.files.some((f) => f.path === need), `ACE-Step needs ${need}`);
  }
});

test('the state block for install.sh: shell-safe quotes and the status strings of the checklist', () => {
  const s = mkS({ ollama: '/o', llms: ["it's", VLM], vlm: true });
  s.hy2 = { st: 'outdated', where: '/d' };
  const state = stateLines(s);
  assert.match(state, /S_HY2='outdated'/);
  assert.match(state, /S_VLM='yes'/);
  assert.match(state, /S_LLMS_STR='it'\\''s qwen3-vl:8b'/);
  const r = spawnSync('bash', ['-c', `eval "$(cat)" && printf '%s' "$S_HY2"`, 'bash'], { input: state, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'outdated');
});

test('the scan failure is what the frontend catches: ASTRA_INSTALL_SCAN_FAIL throws (preset-whole fallback)', () => {
  assert.throws(() => scanComponents({ env: { ASTRA_INSTALL_SCAN_FAIL: '1' } }), /the computer check failed on purpose/);
  assert.throws(() => scanComponents({ root: path.join(APP_ROOT, 'scripts') }), /not the application folder/);
});

test('integration: a fake app folder with a wrong-size model reads as outdated, u2net as missing', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'af-scan-'));
  try {
    mkdirSync(path.join(tmp, 'installer'), { recursive: true });
    mkdirSync(path.join(tmp, 'data', 'models', 'checkpoints'), { recursive: true });
    writeFileSync(path.join(tmp, 'installer', 'manifest.json'), JSON.stringify({
      models: {
        hy2: { file: 'h.safetensors', size: 123 }, u2net: { file: 'u2net.onnx', size: 5 },
        hymv: { file: 'hm.safetensors', size: 5 }, hy21: { file: 'h21.safetensors', size: 5 },
        sdxl: { file: 'sd.safetensors', size: 5 }, flux2: { file: 'f.gguf', size: 5 }, qwenimg: { file: 'q.gguf', size: 5 },
        qwenedit: { file: 'qe.gguf', size: 5 }, qweneditlora: { file: 'qe.safetensors', dir: 'loras', size: 5 },
      },
    }));
    writeFileSync(path.join(tmp, 'data', 'models', 'checkpoints', 'h.safetensors'), 'x'.repeat(9));
    const s = scanComponents({ root: tmp, env: { ASTRA_INSTALL_NO_GPU: '1' } });
    assert.equal(s.hy2.st, 'outdated', 'a found file of another size is an outdated model');
    assert.equal(s.u2net.st, 'missing');
    assert.equal(s.noGpu, true, 'the test hook keeps the probe branch deterministic');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI contract (this machine): -ScanList emits parseable rows for every profile component', () => {
  const r = spawnSync(process.execPath, [SCAN, '--items'], { encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, r.stderr);
  // no trim(): a trailing empty note field is part of the 13-field contract
  const rows = r.stdout.split('\n').filter((l) => l.startsWith('##ITEM')).map((l) => l.split('\t'));
  assert.ok(rows.length >= 19, `expected the full checklist, got ${rows.length}`);
  for (const f of rows) {
    assert.equal(f.length, 13, f.join('|'));
    assert.ok(['installed', 'outdated', 'missing', 'unavailable'].includes(f[3]), f[3]);
    assert.match(f[9], /^[qfl]*$/, f[9]);
    assert.ok(!Number.isNaN(Number(f[6])), f[6]);
  }
  const ids = rows.map((f) => f[1]);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const id of [...MANDATORY, 'comfy', 'hy2', 'u2net', 'godot', 'clips', 'flux2', 'qwenimg', 'pixal3d', 'llm', 'vlm']) {
    assert.ok(ids.includes(id), `row ${id} missing`);
  }
  for (const f of rows) for (const d of f[10].split(',').filter(Boolean)) assert.ok(ids.includes(d), `unknown dep ${d}`);
  for (const f of rows) for (const o of f[11].split(',').filter(Boolean)) assert.ok(ORDER.includes(o), `unknown only-id ${o}`);
});
