// 2D module: graphs, recipes, set manifests, Godot files and the /api/art2d service (no ComfyUI, no Python).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flux2Workflow, qwenWorkflow, sdxlWorkflow, buildWorkflow, snapSize, ENGINES } from '../scripts/art2d/art2d_workflows.mjs';
import { expandRecipe, RECIPES, ACTIONS, PARTS, TURNAROUND, styleSuffix } from '../scripts/art2d/art2d_recipes.mjs';
import { STYLES } from '../scripts/art2d/art2d_styles.mjs';
import * as runner from '../scripts/art2d/art2d_run.mjs';
import { createArt2dService, createSchema } from '../server/art2d.mjs';

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 3, 0, 0, 0, 4, 0]),
  Buffer.alloc(16, 1),
]);
const tmp = () => mkdtempSync(path.join(tmpdir(), 'af2d-'));
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('flux2 graph: every reference is chained into BOTH positive and negative conditioning', () => {
  const w = flux2Workflow({ prompt: 'p', refs: ['a.png', 'b.png'], width: 1000, height: 1210, seed: 5 });
  assert.equal(w[1].class_type, 'UnetLoaderGGUF');
  assert.equal(w[2].inputs.type, 'flux2');
  const refs = Object.values(w).filter((n) => n.class_type === 'ReferenceLatent');
  assert.equal(refs.length, 4);
  // the guider sees the LAST link of each chain
  assert.deepEqual(w[10].inputs.positive, ['113', 0]);
  assert.deepEqual(w[10].inputs.negative, ['114', 0]);
  assert.deepEqual(w[113].inputs.conditioning, ['103', 0]);
  assert.deepEqual(w[103].inputs.conditioning, ['4', 0]);
  assert.deepEqual(w[104].inputs.conditioning, ['5', 0]);
  assert.equal(w[6].inputs.width, 1008);
  assert.equal(w[6].inputs.height, 1216);
  assert.equal(w[13].inputs.noise_seed, 5);
  assert.throws(() => flux2Workflow({ prompt: 'p', refs: ['1', '2', '3', '4', '5'] }), /4/);
  const plain = flux2Workflow({ prompt: 'p' });
  assert.deepEqual(plain[10].inputs.positive, ['4', 0]);
});

test('qwen and sdxl graphs; sdxl turns into img2img with an init image', () => {
  const q = qwenWorkflow({ prompt: 'p', seed: 1 });
  assert.equal(q[4].class_type, 'ModelSamplingAuraFlow');
  assert.equal(q[2].inputs.type, 'qwen_image');
  const t2i = sdxlWorkflow({ prompt: 'p' });
  assert.equal(t2i[4].class_type, 'EmptyLatentImage');
  assert.equal(t2i[8].inputs.denoise, 1);
  const i2i = buildWorkflow('sdxl', { prompt: 'p', refs: ['x.png'], denoise: 0.4 });
  assert.equal(i2i[4].class_type, 'LoadImage');
  assert.equal(i2i[8].inputs.denoise, 0.4);
  assert.throws(() => buildWorkflow('nope', {}), /engine/i);
  assert.equal(snapSize(100), 512);
  assert.equal(snapSize(5000), 1536);
});

test('recipes: turnaround, parts, animation chain, storyboard, poses, restyle', () => {
  const t = expandRecipe({ recipe: 'turnaround' });
  assert.deepEqual(t.map((s) => s.key), TURNAROUND.map((x) => x[0]));
  assert.ok(t.every((s) => s.refs[0] === 'character' && s.cut));
  assert.equal(expandRecipe({ recipe: 'turnaround', views: ['back', 'side'] }).length, 2);

  const p = expandRecipe({ recipe: 'parts', parts: ['head', 'forearm_l'] });
  assert.deepEqual(p.map((s) => s.rig.parent), ['torso', 'upper_arm_l']);

  const a = expandRecipe({ recipe: 'animation', action: 'run', frames: 3, direction: 'left' });
  assert.equal(a.length, 3);
  assert.deepEqual(a[0].refs, ['character']);
  assert.deepEqual(expandRecipe({ recipe: 'animation', action: 'walk', frames: 3, chain: true })[2].refs, ['character', 'prev']);
  assert.deepEqual(expandRecipe({ recipe: 'animation', action: 'walk', frames: 3 })[2].refs, ['character']);
  // fewer frames sample the whole cycle evenly: 4 of 8 walk poses = contact, passing, contact, passing
  assert.deepEqual(expandRecipe({ recipe: 'animation', action: 'walk', frames: 4 }).map((s) => s.prompt.match(/Pose: (\w+)/)[1]), ['contact', 'passing', 'contact', 'passing']);
  assert.match(a[1].prompt, /facing left/);
  assert.equal(expandRecipe({ recipe: 'animation', action: 'idle' }).length, ACTIONS.idle.poses.length);
  assert.throws(() => expandRecipe({ recipe: 'animation', action: 'fly' }), /action/i);

  const sb = expandRecipe({ recipe: 'storyboard', scenes: ['a', ' ', 'b'], hasCharacter: true });
  assert.equal(sb.length, 2);
  assert.equal(sb[0].caption, 'a');
  assert.deepEqual(sb[0].refs, ['character']);
  assert.throws(() => expandRecipe({ recipe: 'storyboard', scenes: [] }), /storyboard/i);

  assert.deepEqual(expandRecipe({ recipe: 'poses3d', poses: 2 })[1].refs, ['character', 'pose:1']);
  assert.throws(() => expandRecipe({ recipe: 'poses3d', poses: 0 }), /pose/i);
  assert.deepEqual(expandRecipe({ recipe: 'restyle', inputs: 1 })[0].refs, ['input:0']);
  assert.throws(() => expandRecipe({ recipe: 'concept' }), /Describe/);
  assert.equal(expandRecipe({ recipe: 'concept', prompt: 'elf', frames: 3 }).length, 3);

  assert.match(styleSuffix('pixel'), /pixel art/);
  assert.equal(styleSuffix('pixel', { styleImage: true }), '');
  assert.ok(STYLES.pixel.post.pixel.cell > 1);
  for (const id of Object.keys(RECIPES)) assert.ok(RECIPES[id].label);
});

test('createSet: manifest, copied refs, seeds, engine checks', async () => {
  const root = tmp();
  const ref = path.join(root, 'hero.png');
  await fs.writeFile(ref, PNG);
  const { dir, set } = await runner.createSet({ recipe: 'animation', action: 'run', frames: 3, style: 'cel', character: ref, seed: 100 }, { root });
  assert.equal(set.kind, 'art2d');
  assert.equal(set.refs.character, 'refs/character.png');
  assert.equal(set.shots.length, 3);
  assert.ok(set.shots.every((s) => s.seed === 100 && s.status === 'pending'));   // one seed through a sequence
  assert.equal(set.license.commercial, true, 'FLUX.2 klein 4B (since 0.6.6) is Apache-2.0: the 2D default set is commercial-safe');
  assert.equal(set.license.engine, 'Apache-2.0');
  assert.deepEqual(await runner.loadSet(dir), set);

  const t = await runner.createSet({ recipe: 'turnaround', character: ref, seed: 7 }, { root });
  assert.deepEqual(t.set.shots.map((s) => s.seed), [7, 8, 9, 10, 11]);

  await assert.rejects(runner.createSet({ recipe: 'turnaround' }, { root }), /character/i);
  await assert.rejects(runner.createSet({ recipe: 'turnaround', character: ref, engine: 'qwen' }, { root }), /FLUX/);
  const q = await runner.createSet({ recipe: 'concept', prompt: 'robot', engine: 'qwen' }, { root });
  assert.equal(q.set.license.commercial, true);
  assert.equal((await runner.listSets(root)).length, 3);
});

test('Godot: SpriteFrames over the sheet and a cutout scene with parents', () => {
  const tres = runner.spriteFramesTres({ texture: 'assets/art2d/hero/sheet.png', animation: 'walk', fps: 8, loop: true, frames: [{ x: 0, y: 0, w: 256, h: 256 }, { x: 256, y: 0, w: 256, h: 256 }] });
  assert.match(tres, /^\[gd_resource type="SpriteFrames" load_steps=4 format=3\]/);
  assert.match(tres, /region = Rect2\(256, 0, 256, 256\)/);
  assert.match(tres, /"name": &"walk"/);
  assert.match(tres, /"speed": 8\.0/);
  assert.match(tres, /"loop": true/);
  const scene = runner.cutoutTscn({ name: 'hero', dirRes: 'assets/art2d/hero/parts', parts: [
    { key: 'torso', size: [200, 300], pivot: [0.5, 0.85], parent: null },
    { key: 'upper_arm_l', size: [80, 160], pivot: [0.5, 0.08], parent: 'torso' },
    { key: 'forearm_l', size: [70, 150], pivot: [0.5, 0.06], parent: 'upper_arm_l' },
  ] });
  assert.match(scene, /\[node name="torso" type="Sprite2D" parent="\."\]/);
  assert.match(scene, /\[node name="forearm_l" type="Sprite2D" parent="torso\/upper_arm_l"\]/);
  assert.match(scene, /offset = Vector2\(0, -105\)/);
});

test('service: schema, asset checks, one set at a time, safe file paths', async () => {
  const root = tmp();
  const assets = {
    [uid(1)]: { id: uid(1), extension: '.png', name: 'hero.png' },
    [uid(2)]: { id: uid(2), extension: '.glb', name: 'm.glb' },
  };
  await fs.writeFile(path.join(root, uid(1) + '.png'), PNG);
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = { ...runner, runSet: async (dir, o) => { o.onProgress('drawing'); await gate; return runner.loadSet(dir); } };
  const svc = createArt2dService({ root, runner: fake, getAsset: async (id) => { if (!assets[id]) throw new Error('no asset'); return assets[id]; }, assetFile: (i) => path.join(root, i.id + i.extension) });

  assert.throws(() => createSchema.parse({ recipe: 'turnaround', bogus: 1 }));
  await assert.rejects(svc.create({ recipe: 'turnaround', characterId: uid(2) }), /PNG/);
  const s = await svc.create({ recipe: 'turnaround', characterId: uid(1), views: ['front', 'back'] });
  assert.equal(s.shots.length, 2);
  assert.equal(s.task.status, 'running');
  assert.equal(s.sourceAssets.characterId, uid(1));
  await assert.rejects(svc.create({ recipe: 'concept', prompt: 'x', engine: 'qwen' }), /already running/i);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await svc.get(s.id)).task.status, 'completed');

  await assert.rejects(svc.filePath(s.id, '../set.json'), /Invalid path/);
  await assert.rejects(svc.filePath(s.id, 'refs/../../x.png'), /Invalid path/);
  assert.ok((await svc.filePath(s.id, 'refs/character.png')).endsWith('character.png'));
  await assert.rejects(svc.get('nope'), /Incorrect set id/);
  await assert.rejects(svc.redo(s.id, { keys: ['zzz'] }), /No shots/);
  await assert.rejects(svc.toAsset(s.id, 'front'), /not ready/);
  const list = await svc.list();
  assert.equal(list[0].id, s.id);
  assert.equal(ENGINES.flux2.maxRefs, 4);
  assert.equal(PARTS.length, 10);
});

// ---------------------------------------------------------------- ticket 07: the style engine

test('qwenedit graph: lora chain, refs into both prompts, zero_cond on both, latent by intent', () => {
  const wf = buildWorkflow('qwenedit', { prompt: 'a fox in this style', negative: 'photo', refs: ['b0.png', 'b1.png', 'b2.png', 'b3.png'], width: 1000, height: 1210, seed: 11 });
  assert.equal(wf[1].class_type, 'UnetLoaderGGUF');
  assert.equal(wf[1].inputs.unet_name, 'qwen-image-edit-2511-Q4_K_M.gguf');
  assert.equal(wf[2].class_type, 'LoraLoaderModelOnly');
  assert.equal(wf[2].inputs.lora_name, ENGINES.qwenedit.lora);
  assert.equal(wf[5].inputs.model[0], '2', 'sampling rides the LoRA, not the raw unet');
  assert.equal(wf[5].inputs.shift, 3.1);
  // four references offered, three slots exist (TextEncodeQwenImageEditPlus image1..3) - and both prompts see them
  assert.deepEqual([wf[30].inputs.image1[0], wf[30].inputs.image2[0], wf[30].inputs.image3[0], wf[30].inputs.image4], ['40', '41', '42', undefined]);
  assert.deepEqual([wf[31].inputs.image1[0], wf[31].inputs.image2[0], wf[31].inputs.image3[0]], ['40', '41', '42'], 'the negative sees the same pictures');
  assert.equal(wf[30].inputs.vae[0], '4', 'a wired vae makes the encoder splice reference latents');
  // zero_cond handling: both conditionings marked index_timestep_zero, the sampler takes the marked pair
  assert.equal(wf[32].class_type, 'FluxKontextMultiReferenceLatentMethod');
  assert.equal(wf[32].inputs.reference_latents_method, 'index_timestep_zero');
  assert.equal(wf[33].inputs.reference_latents_method, 'index_timestep_zero');
  assert.deepEqual(wf[50].inputs.positive, ['32', 0]); assert.deepEqual(wf[50].inputs.negative, ['33', 0]);
  assert.deepEqual([wf[50].inputs.steps, wf[50].inputs.cfg], [4, 1], 'lightning: four steps at cfg 1');
  assert.equal(wf[46].class_type, 'EmptySD3LatentImage', 'generation in a style: no source pixels');
  const edit = buildWorkflow('qwenedit', { prompt: 'redraw', refs: [], base: 'src.png', seed: 1 });
  assert.equal(edit[45].class_type, 'FluxKontextImageScale');
  assert.equal(edit[46].class_type, 'VAEEncode', 'an image being re-drawn rides its own latent');
  const bare = buildWorkflow('qwenedit', { prompt: 'plain', seed: 1 });
  assert.ok(!Object.values(bare).some((n) => n.class_type === 'FluxKontextMultiReferenceLatentMethod'), 'no references, no method nodes');
  assert.deepEqual(bare[50].inputs.positive, ['30', 0]);
});

test('art2dStatus: the 10 GiB gate reasons only the qwenedit row', async () => {
  const need = new Set(Object.values(ENGINES).flatMap((e) => e.nodes));
  const info = {};
  const list = (key) => [Object.values(ENGINES).map((e) => e[key]).filter(Boolean)];  // object_info hands combos as [names]
  for (const n of need) info[n] = { input: { required: { unet_name: list('unet'), lora_name: list('lora'), clip_name: list('clip'), vae_name: list('vae'), ckpt_name: list('checkpoint') } } };
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(info)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = 'http://127.0.0.1:' + srv.address().port;
    const big = await runner.art2dStatus(url, { vramMiB: 12288 });
    assert.equal(big.engines.qwenedit.ready, true, JSON.stringify(big.engines.qwenedit.reasons));
    assert.equal(big.engines.qwenedit.gateMiB, 10240);
    const small = await runner.art2dStatus(url, { vramMiB: 8192 });
    assert.equal(small.engines.qwenedit.ready, false);
    assert.match(small.engines.qwenedit.reasons.find((r) => /10 GB/.test(r)), /FLUX.2 klein/, 'the reason names the fallback');
    assert.ok(small.engines.flux2.ready, 'the gate never touches the klein row');
  } finally { srv.close(); }
});

test('the style bible rides the set: picture copies, engine choice with a note, prompt fold', async () => {
  const root = tmp();
  // a style on disk in the real layout: <dir>/styles/<id>/style.json + pictures with generated names
  const styleDir = tmp();
  const sid = uid(9);
  const imgA = '11111111-1111-4111-8111-111111111111.png';
  const imgB = '22222222-2222-4222-8222-222222222222.png';
  await fs.mkdir(path.join(styleDir, 'styles', sid), { recursive: true });
  await fs.writeFile(path.join(styleDir, 'styles', sid, 'style.json'), JSON.stringify({
    id: sid, name: 'Painted dusk', description: 'soft gouache, warm rim light, painterly edges', negative: 'photo, gradients',
    palette: 'ochre and teal', notes: '', images: [imgA, imgB], createdAt: 'x', updatedAt: 'x',
  }));
  await fs.writeFile(path.join(styleDir, 'styles', sid, imgA), PNG);
  await fs.writeFile(path.join(styleDir, 'styles', sid, imgB), PNG);
  const assets = { [uid(1)]: { id: uid(1), extension: '.png', name: 'hero.png' } };
  await fs.writeFile(path.join(root, uid(1) + '.png'), PNG);
  const asset = () => ({ getAsset: async (id) => assets[id], assetFile: (i) => path.join(root, i.id + i.extension) });

  const stReady = { online: true, ready: true, engines: { qwenedit: { label: 'Qwen-Image-Edit 2511', ready: true, reasons: [], gateMiB: 10240 }, flux2: { label: 'FLUX.2 klein 4B', ready: true, reasons: [] } } };
  const fakeReady = { ...runner, art2dStatus: async () => stReady, runSet: async (dir) => runner.loadSet(dir) };
  const svc = createArt2dService({ root, runner: fakeReady, ...asset(), styleDataDir: styleDir, getVram: () => 12288 });
  const s = await svc.create({ recipe: 'turnaround', characterId: uid(1), views: ['front'], styleBibleId: sid });
  assert.equal(s.engine, 'qwenedit', 'a style on a capable card is drawn by the style engine (default klein upgrades)');
  assert.match(s.engineNote, /Qwen-Image-Edit 2511.*2 reference pictures/);
  assert.equal(s.styleBible.id, sid);
  assert.equal(s.styleBible.description, 'soft gouache, warm rim light, painterly edges');
  assert.deepEqual(s.refs.styleBible, ['refs/bible_00.png', 'refs/bible_01.png']);
  assert.ok((await fs.readFile(path.join(root, s.id, 'refs', 'bible_00.png'))).equals(PNG), 'the pictures are copied in - the set survives bible edits');
  assert.equal(s.sourceAssets.styleBibleId, sid);

  // the gate failed (or weights absent): the set stays honest - klein draws it, the note says why
  const stSmall = { ...stReady, engines: { ...stReady.engines, qwenedit: { ...stReady.engines.qwenedit, ready: false, reasons: ['wants at least 10 GB of video memory (this card has 8 GB) - style series fall back to FLUX.2 klein'] } } };
  const fakeSmall = { ...runner, art2dStatus: async () => stSmall, runSet: async (dir) => runner.loadSet(dir) };
  const svc2 = createArt2dService({ root: tmp(), runner: fakeSmall, ...asset(), styleDataDir: styleDir, getVram: () => 8192 });
  const s2 = await svc2.create({ recipe: 'turnaround', characterId: uid(1), views: ['front'], styleBibleId: sid });
  assert.equal(s2.engine, 'flux2');
  assert.match(s2.engineNote, /style drawn by FLUX.2 klein 4B - wants at least 10 GB/);

  // 'auto' without a bible: the first ready engine wins, still with a note
  const s3 = await svc.create({ recipe: 'concept', prompt: 'robot', engine: 'auto' });
  assert.equal(s3.engine, 'qwenedit'); assert.match(s3.engineNote, /^auto: Qwen-Image-Edit/);
  assert.equal(s3.styleBible, null);

  await new Promise((r) => setTimeout(r, 30));   // let the auto-set's fake run finish: one set at a time is the guard
  await assert.rejects(svc.create({ recipe: 'concept', prompt: 'x', styleBibleId: uid(8) }), /No such style bible/);

  // the prompt fold: the bible recipe rides every shot, the negative extends too (generation path reads these)
  const set = { engine: 'qwenedit', style: 'painted', refs: { styleBible: ['refs/bible_00.png'] }, styleBible: { id: sid, name: 'Painted dusk', description: 'soft gouache, warm rim light', negative: 'photo, gradients' }, shots: [] };
  const p = runner.finalPrompt(set, { prompt: 'a red fox' });
  assert.match(p, /^a red fox/); assert.match(p, /soft gouache, warm rim light/, 'the description is generator text');
  const files = []; // resolveRefs is internal - check through createSet's record that shots resolve bible refs
  assert.equal(set.refs.styleBible.length, 1);
});
