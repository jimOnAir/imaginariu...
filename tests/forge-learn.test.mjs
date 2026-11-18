// Self-learning of the forge (docs/forge/LEARN.md): production journal, verdicts, class recipes.
// Stub step runner (no Blender) and a temporary library, as in forge-pipeline.test.mjs.
// The non-win32 sibling of the reference forge-learn.test.mjs: same behaviors, minus the shared
// community-recipe layer (server/learn-community.* is excluded on this branch, EXCLUDED.md).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { ForgeEngine } from '../server/forge-pipeline.mjs';
import { registerForge } from '../server/forge.mjs';
import {
  ForgeLearn, normalizeVerdict, paramsDiff, recipeParams, stableJson, tagsFromText, variantOf,
} from '../server/forge-learn.mjs';

const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
const TEMP_DIRS = [];
const tempDir = (prefix) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); TEMP_DIRS.push(d); return d; };
after(async () => { for (const d of TEMP_DIRS) await fs.rm(d, { recursive: true, force: true }).catch(() => {}); });

/** Stub runner: render_sprites writes a preview and fails its checks when asked (checksFail). */
function stubRunner({ checksFail = false } = {}) {
  const calls = [];
  const runStep = async (o) => {
    calls.push(o);
    o.onStart?.();
    const out = o.request.out_dir;
    await fs.mkdir(out, { recursive: true });
    const outputs = { preview: path.join(out, 'preview.png') };
    await fs.writeFile(outputs.preview, 'png');
    if (o.step !== 'render_sprites') {
      outputs.glb = path.join(out, `${o.step}.glb`);
      outputs.blend = path.join(out, `${o.step}.blend`);
      for (const f of [outputs.glb, outputs.blend]) await fs.writeFile(f, 'x');
    }
    const red = checksFail && o.step === 'render_sprites';
    const result = {
      ok: !red, step: o.step, outputs, stats: {}, seconds: 1.5,
      checks: [{ name: 'cell_fit', ok: !red, severity: 'error', value: red ? 3 : 0 }, { name: 'body_scale_px_per_m', ok: true, severity: 'warning', value: { px_per_m: 12 } }],
      warnings: [],
    };
    return { result, logTail: ['ok'], logFile: null, warnings: [] };
  };
  return { runStep, calls };
}

async function makeEngine(opts = {}) {
  const dir = opts.dir || tempDir('imaginarium-learn-');
  const stub = opts.stub || stubRunner(opts.runner);
  const engine = new ForgeEngine({
    libraryDir: path.join(dir, 'library'),
    runtimeDir: path.join(dir, 'runtime'),
    studioAssetsDir: path.join(dir, 'studio', 'assets'),
    studioJobsDir: path.join(dir, 'studio', 'jobs'),
    runStep: stub.runStep,
    blenderInfo: () => ({ ok: false, path: 'none', version: null }),
    godotInfo: () => ({ ok: false, path: null, version: null }),
    persistIntervalMs: 0,
  });
  await engine.init();
  return { engine, dir, calls: stub.calls };
}

const zombie = (engine, name = 'zciv_office_man') => engine.createAsset({ kind: 'prop', name, source: { type: 'upload' } }, { buffer: GLB, originalName: `${name}.glb` });

// the three passes of the «Квартал 30» zombies (31.10.2026), the worked example of docs/forge/LEARN.md
const PASS_ACID = { profile: 'pixel', pixels_per_meter: 12, outline: 'auto', colors: 24, clips: ['walk', 'run'], frames: { walk: 8, run: 6 } };
const PASS_PALE = { ...PASS_ACID, levels: false, saturation: 0.85 };
const PASS_GOOD = { ...PASS_ACID, levels: true, saturation: 1, outline: 'dark' };

async function runSprites(engine, assetId, params, extra = {}) {
  const run = await engine.startRun(assetId, { steps: [{ step: 'render_sprites', params }], ...extra });
  const job = await engine.waitJob(run.jobId);
  return { run, job };
}

test('pure helpers: variants, recipe params, diff, verdict aliases, tags from words', () => {
  assert.equal(variantOf('render_sprites', { profile: 'pixel' }), 'pixel');
  assert.equal(variantOf('render_sprites', {}), 'iso8', 'the registry default profile');
  assert.equal(variantOf('cleanup', { target_tris: 1000 }), '');
  const p = recipeParams('render_sprites', { ...PASS_GOOD, asset_id: 'x', height_m: 1.7, frames: { walk: 8 }, loop: { walk: true } });
  assert.deepEqual(Object.keys(p).sort(), ['colors', 'levels', 'outline', 'pixels_per_meter', 'profile', 'saturation'],
    'clip lists, per-clip frames, sizes and server-filled ids are not a class recipe');
  assert.deepEqual(recipeParams('render_sprites', { frames: 6 }), { frames: 6 }, 'a single frame count is style');
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.deepEqual(paramsDiff({ saturation: 0.85, levels: false }, { saturation: 1, levels: true, outline: 'dark' }).map((d) => d.key), ['levels', 'outline', 'saturation']);
  assert.equal(normalizeVerdict('брак'), 'rejected', 'the Russian verdict words are the shipped parsing contract');
  assert.equal(normalizeVerdict('Принято'), 'accepted');
  assert.equal(normalizeVerdict('approved'), 'accepted');
  assert.equal(normalizeVerdict('maybe'), null);
  assert.deepEqual(tagsFromText('Цвета кислотные, контур потерялся'), ['acid_colors', 'outline']);
  assert.deepEqual(tagsFromText('рвётся одежда/плащ'), ['torn_mesh']);
  assert.deepEqual(tagsFromText('ближе всего к листу концептов, контур хороший'), [], 'praise names no defect');
});

test('asset class: run override, passport profile.class, name rules, then the kind', async () => {
  const learn = new ForgeLearn({ libraryDir: tempDir('imaginarium-learn-cls-') });
  assert.equal((await learn.classify({ kind: 'prop', name: 'zciv_brute' })).id, 'zombie');
  assert.equal((await learn.classify({ kind: 'prop', name: 'weapon_gatling' })).id, 'weapon');
  assert.equal((await learn.classify({ kind: 'prop', name: 'bld_hospital' })).id, 'building');
  assert.equal((await learn.classify({ kind: 'prop', name: 'barrel' })).id, 'prop', 'no rule -> the kind');
  assert.equal((await learn.classify({ kind: 'humanoid', name: 'zciv_x', profile: { class: 'hero' } })).id, 'hero', 'passport class wins over rules');
  const over = await learn.classify({ kind: 'prop', name: 'zciv_x' }, 'Boss');
  assert.deepEqual([over.id, over.from], ['boss', 'run']);
  await assert.rejects(learn.classify({ kind: 'prop' }, 'плохой класс'), /Asset class/);
  await learn.setClassRule({ id: 'zombie', title: 'Зомби-горожанин', match: '^civ_' });
  assert.equal((await learn.classify({ kind: 'prop', name: 'civ_granny' })).id, 'zombie', 'own rule replaces the built-in one');
  assert.equal((await learn.classify({ kind: 'prop', name: 'civ_granny' })).title, 'Зомби-горожанин');
});

test('every finished step writes a journal line: class, params, checks, preview, time', async () => {
  const { engine } = await makeEngine();
  const a = await zombie(engine);
  const { run, job } = await runSprites(engine, a.id, PASS_GOOD);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.assetClass, 'zombie');
  const runs = await engine.learn.runs({ assetId: a.id });
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.id, `${run.jobId}:1`);
  assert.equal(r.class, 'zombie');
  assert.equal(r.classFrom, 'rule:zombie');
  assert.equal(r.kind, 'prop');
  assert.equal(r.assetName, 'zciv_office_man');
  assert.equal(r.version, 'v001');
  assert.equal(r.stepKey, 'render_sprites@pixel');
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.params, PASS_GOOD);
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['cell_fit', true], ['body_scale_px_per_m', true]]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.previews.length, 1);
  assert.match(r.previews[0].url, new RegExp(`/api/forge/assets/${a.id}/files/v001/01_render_sprites/preview.png$`));
  assert.equal(typeof r.seconds, 'number');
  assert.equal(r.renderSeconds, 1.5);
  assert.equal(r.source, 'live');
  const lines = readFileSync(engine.learn.files.journal, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'one line per step run');
  assert.ok(!readFileSync(engine.learn.files.journal, 'utf8').includes('http://'), 'the journal stores app-local paths and relative urls only');

  // a step stopped by its red checks is journaled as failed with the failed check names
  const { engine: e2 } = await makeEngine({ runner: { checksFail: true } });
  const b = await zombie(e2, 'zciv_brute');
  const bad = await runSprites(e2, b.id, PASS_GOOD);
  assert.equal(bad.job.status, 'failed');
  const [fr] = await e2.learn.runs({ assetId: b.id });
  assert.equal(fr.status, 'failed');
  assert.deepEqual(fr.failed, ['cell_fit']);
  // without verdicts a run stopped by red checks is one line of the digest, not a recipe section
  const md = await e2.learn.digest();
  assert.match(md, /Вердиктов ещё нет; запуски останавливались красными проверками: `render_sprites@pixel` ×1/);
  assert.doesNotMatch(md, /### Sprites/);
});

test('feedback is validated, stored per version, and shown on the review card', async () => {
  const { engine } = await makeEngine();
  const a = await zombie(engine);
  await runSprites(engine, a.id, PASS_ACID);
  const r = await engine.addFeedback({ assetId: a.id, verdict: 'брак', tags: ['acid_colors', 'кислотные цвета'], comment: 'Слишком ярко', rating: 2 });
  assert.equal(r.count, 1);
  const f = r.feedback[0];
  assert.equal(f.version, 'v001', 'the latest version with runs by default');
  assert.equal(f.verdict, 'rejected');
  assert.deepEqual(f.tags, ['acid_colors'], 'tag ids and titles collapse to one id');
  assert.equal(f.class, 'zombie');
  const m = await engine.getAsset(a.id);
  assert.equal(m.qa.decision, 'rejected');
  assert.match(m.qa.comment, /кислотные цвета — Слишком ярко/);
  assert.equal((await engine.learn.feedbackList({ assetId: a.id })).length, 1);

  await assert.rejects(engine.addFeedback({ assetId: a.id, verdict: 'так себе' }), /verdict/);
  await assert.rejects(engine.addFeedback({ assetId: a.id, verdict: 'accepted', rating: 7 }), /rating/);
  await assert.rejects(engine.addFeedback({ assetId: a.id, verdict: 'accepted', step: 'no_such_step' }), /Unknown step/);
  await assert.rejects(engine.addFeedback({ assetId: a.id, verdict: 'accepted', version: '3' }), /version/);
  const fresh = await engine.createAsset({ kind: 'prop', name: 'never_built', source: { type: 'params' } });
  await assert.rejects(engine.addFeedback({ assetId: fresh.id, verdict: 'accepted' }), /no versions/);

  // a review decision (PATCH qa.decision) is a verdict of the journal too
  await engine.patchAsset(a.id, { qa: { decision: 'rework', comment: 'не похож на концепт' } });
  const list = await engine.learn.feedbackList({ assetId: a.id });
  assert.equal(list[0].verdict, 'rework');
  assert.equal(list[0].source, 'review');
  assert.deepEqual(list[0].tags, ['unlike_concept']);
});

test('recipes: the accepted params win, the rejected ones become pitfalls with the difference', async () => {
  const { engine } = await makeEngine();
  const ids = [];
  for (const [i, params] of [PASS_ACID, PASS_PALE, PASS_GOOD].entries()) {
    const a = await zombie(engine, `zciv_variant_${i}`);
    await runSprites(engine, a.id, params);
    ids.push(a.id);
  }
  await engine.addFeedback({ assetId: ids[0], verdict: 'rejected', tags: ['acid_colors'] });
  await engine.addFeedback({ assetId: ids[1], verdict: 'rejected', tags: ['washed_out'], comment: 'блёкло' });
  await engine.addFeedback({ assetId: ids[2], verdict: 'accepted', rating: 5, comment: 'кислотности нет, как на листе концептов' });
  assert.deepEqual((await engine.learn.feedbackList({ assetId: ids[2] }))[0].tags, [], 'words in an accepted comment are not defect tags');
  const r = await engine.learn.recipes({ cls: 'zombie' });
  const g = r.groups.find((x) => x.stepKey === 'render_sprites@pixel');
  assert.ok(g?.best, 'a recipe exists');
  assert.deepEqual(g.best.params, recipeParams('render_sprites', PASS_GOOD));
  assert.equal(g.best.accepted, 1);
  assert.equal(g.pitfalls.length, 2);
  const pale = g.pitfalls.find((p) => p.tags.some((t) => t.id === 'washed_out'));
  assert.deepEqual(pale.diff.map((d) => d.key), ['levels', 'outline', 'saturation']);
  assert.deepEqual(pale.comments, ['блёкло']);
  const acid = g.pitfalls.find((p) => p.tags.some((t) => t.id === 'acid_colors'));
  assert.ok(acid.diff.find((d) => d.key === 'saturation').unset, 'the default saturation of the acid pass is "unset"');

  const md = await engine.learn.digest({ cls: 'zombie' });
  assert.match(md, /## Зомби \(`zombie`\)/);
  assert.match(md, /render_sprites@pixel/);
  assert.match(md, /"saturation":1/);
  assert.match(md, /блёклые цвета/);
  assert.match(md, /`saturation` 0.85 вместо 1/);

  // a later rejection of the same params takes the recipe away (score <= 0)
  await engine.addFeedback({ assetId: ids[2], verdict: 'rejected', comment: 'передумал' });
  const after2 = (await engine.learn.recipes({ cls: 'zombie' })).groups.find((x) => x.stepKey === 'render_sprites@pixel');
  assert.equal(after2.best, null, 'the latest verdict of a version wins');
});

// Ticket 67 (0.7.10 fold wave): "settings from a single editing session no longer end up in
// shared recipes". The branch journal has always required an explicit accepted verdict for a
// params signature to win (winners = accepted > 0 && score > 0), and there is no shared layer at
// all (learn-community is EXCLUDED.md). The guarantee is structural, so it is cheap to pin as a
// regression test - three blind sessions of the SAME params must still produce no recipe.
test('a recipe needs an accepted verdict: blind single-session runs never become one (ticket 67)', async () => {
  const { engine } = await makeEngine();
  const ids = [];
  for (const i of [0, 1, 2]) {
    const a = await zombie(engine, `zciv_blind_${i}`);
    await runSprites(engine, a.id, PASS_GOOD);
    ids.push(a.id);
  }
  const find = async () => (await engine.learn.recipes({ cls: 'zombie' })).groups.find((x) => x.stepKey === 'render_sprites@pixel');
  const g = await find();
  assert.ok(g, 'the group counts the runs');
  assert.equal(g.runs, 3);
  assert.equal(g.best, null, 'runs without a verdict never win - a session cannot mint a recipe');
  assert.equal(g.pitfalls.length, 0, 'blind runs are not pitfalls either - nothing was said about them');
  // the moment one is explicitly accepted, that very params becomes the recipe: the gate is the
  // verdict, not the count of sessions
  await engine.addFeedback({ assetId: ids[2], verdict: 'accepted', rating: 5 });
  const g2 = await find();
  assert.ok(g2.best, 'one explicit accepted verdict is the whole gate');
  assert.deepEqual(g2.best.params, recipeParams('render_sprites', PASS_GOOD));
});

test('the next run of the class starts from the recipe; explicit params win; recipes:false turns it off', async () => {
  const { engine, calls } = await makeEngine();
  const old = await zombie(engine, 'zciv_old');
  await runSprites(engine, old.id, PASS_GOOD);
  await engine.addFeedback({ assetId: old.id, verdict: 'accepted' });

  // a new zombie, rendered with the profile only: the class recipe fills the rest
  const fresh = await zombie(engine, 'zciv_new_granny');
  const plan = await engine.planRun(fresh.id, { steps: [{ step: 'render_sprites', params: { profile: 'pixel', saturation: 0.95 } }] });
  assert.equal(plan.assetClass.id, 'zombie');
  assert.deepEqual(plan.steps[0].params, { ...recipeParams('render_sprites', PASS_GOOD), saturation: 0.95 }, 'explicit saturation stays');
  assert.deepEqual(Object.keys(plan.learned[0].params).sort(), ['colors', 'levels', 'outline', 'pixels_per_meter']);
  assert.equal(plan.learned[0].from.levels, 'zombie:journal');
  assert.match(plan.recipeNotes[0], /Class recipe "Зомби" for "Sprites" \(pixel\): .*levels=true/);
  assert.equal((await engine.getAsset(fresh.id)).versions.length, 0, 'a plan creates no version');

  const { run, job } = await runSprites(engine, fresh.id, { profile: 'pixel', saturation: 0.95 });
  assert.equal(job.status, 'completed');
  assert.deepEqual(run.learned[0].params, plan.learned[0].params);
  const sent = calls.at(-1).request.params;
  assert.equal(sent.levels, true, 'the recipe reaches Blender');
  assert.equal(sent.outline, 'dark');
  assert.equal(sent.saturation, 0.95);
  const [rec] = await engine.learn.runs({ assetId: fresh.id });
  assert.deepEqual(rec.recipe.params, plan.learned[0].params, 'the journal says which params came from the recipe');

  // another variant (iso8) and another class get nothing; recipes:false gets nothing
  const iso = await engine.planRun(fresh.id, { steps: [{ step: 'render_sprites', params: {} }] });
  assert.deepEqual(iso.learned, []);
  const weapon = await engine.createAsset({ kind: 'prop', name: 'weapon_mg', source: { type: 'upload' } }, { buffer: GLB, originalName: 'weapon_mg.glb' });
  assert.deepEqual((await engine.planRun(weapon.id, { steps: [{ step: 'render_sprites', params: { profile: 'pixel' } }] })).learned, []);
  const off = await engine.planRun(fresh.id, { steps: [{ step: 'render_sprites', params: { profile: 'pixel' } }], recipes: false });
  assert.deepEqual(off.steps[0].params, { profile: 'pixel' });
  // an explicit class for the run borrows that class's recipe
  const borrowed = await engine.planRun(weapon.id, { steps: [{ step: 'render_sprites', params: { profile: 'pixel' } }], assetClass: 'zombie' });
  assert.equal(borrowed.steps[0].params.levels, true);
});

test('pinned recipes layer under the class: "*" for everybody, the class recipe on top', async () => {
  const { engine } = await makeEngine();
  await engine.learn.pin({ cls: '*', step: 'render_sprites', variant: 'pixel', params: { levels: true, saturation: 1, outline: 'dark', clips: ['walk'] }, note: 'мелкие пиксель-спрайты' });
  const k = await engine.learn.knowledge();
  assert.deepEqual(k.pinned[0].params, { levels: true, saturation: 1, outline: 'dark' }, 'a pin keeps only recipe params');
  await assert.rejects(engine.learn.pin({ cls: '*', step: 'render_sprites', variant: 'pixel', params: { saturation: 9 } }), /saturation/);
  await assert.rejects(engine.learn.pin({ cls: '*', step: 'render_sprites', params: { clips: ['walk'] } }), /recipe parameters/);

  const w = await engine.createAsset({ kind: 'prop', name: 'weapon_mg', source: { type: 'upload' } }, { buffer: GLB, originalName: 'weapon_mg.glb' });
  const plan = await engine.planRun(w.id, { steps: [{ step: 'render_sprites', params: { profile: 'pixel', directions: [['S', 0], ['N', 180]] } }] });
  assert.deepEqual(plan.steps[0].params, { profile: 'pixel', directions: [['S', 0], ['N', 180]], levels: true, saturation: 1, outline: 'dark' },
    'custom directions of the caller stay; the global pin fills colour params');
  assert.equal(plan.learned[0].from.saturation, '*:pinned');

  await engine.learn.pin({ cls: 'weapon', step: 'render_sprites', variant: 'pixel', params: { saturation: 0.9 } });
  const p2 = await engine.planRun(w.id, { steps: [{ step: 'render_sprites', params: { profile: 'pixel' } }] });
  assert.equal(p2.steps[0].params.saturation, 0.9, 'the class pin beats the global one');
  assert.equal(p2.steps[0].params.outline, 'dark', 'keys the class does not set come from the global pin');

  await engine.learn.pin({ cls: 'weapon', step: 'render_sprites', variant: 'pixel', params: null });
  assert.equal((await engine.learn.knowledge()).pinned.length, 1, 'null params remove the pin');

  const note = await engine.learn.addNote({ cls: 'building', kind: 'route', text: 'Дома — процедурно: city_bldg.py, не Pixal3D.' });
  assert.match((await engine.learn.digest()).replace(/\r/g, ''), /\*\*Путь:\*\* Дома — процедурно/);
  await engine.learn.removeNote(note.id);
  await assert.rejects(engine.learn.removeNote(note.id), /not found/);
});

test('sync imports finished steps of job records once; versions view groups runs with verdicts', async () => {
  const { engine } = await makeEngine();
  const a = await zombie(engine);
  await runSprites(engine, a.id, PASS_GOOD);
  await runSprites(engine, a.id, PASS_PALE);
  // the journal is lost (or the runs were made by an older studio): sync rebuilds it from jobs/
  await fs.rm(engine.learn.files.journal);
  const s1 = await engine.learn.sync();
  assert.equal(s1.added, 2);
  assert.equal((await engine.learn.runs()).every((r) => r.source === 'sync' && r.class === 'zombie'), true);
  const s2 = await engine.learn.sync();
  assert.equal(s2.added, 0, 'idempotent');

  await engine.addFeedback({ assetId: a.id, version: 'v001', verdict: 'accepted' });
  const v = await engine.learn.versions({ cls: 'zombie' });
  assert.equal(v.total, 2);
  assert.deepEqual(v.items.map((x) => x.version), ['v002', 'v001'], 'newest first');
  assert.equal(v.items[1].verdict.verdict, 'accepted');
  assert.equal(v.items[0].verdict, null);
  assert.equal((await engine.learn.versions({ pending: true })).total, 1);
  const o = await engine.learn.overview();
  assert.equal(o.classes[0].id, 'zombie');
  assert.ok(o.tags.some((t) => t.id === 'foil'));
  // a review decision stored in the passport before the journal existed becomes a verdict, once
  const b = await zombie(engine, 'zciv_old_review');
  await runSprites(engine, b.id, PASS_PALE);
  await engine._updateManifest(b.id, (m) => { m.qa = { ...m.qa, decision: 'rework', comment: 'цвета блёклые', at: new Date().toISOString() }; });
  const s3 = await engine.learn.sync();
  assert.equal(s3.decisions, 1);
  const [imported] = await engine.learn.feedbackList({ assetId: b.id });
  assert.deepEqual([imported.verdict, imported.version, imported.source, imported.by], ['rework', 'v001', 'review-import', 'owner']);
  assert.deepEqual(imported.tags, ['washed_out']);
  assert.equal((await engine.learn.sync()).decisions, 0, 'decisions are imported once');
  await engine.patchAsset(b.id, { qa: { decision: 'approved', comment: '' } });
  assert.equal((await engine.learn.sync()).decisions, 0, 'a decision the review hook already wrote is not imported again');
  assert.equal((await engine.learn.feedbackList({ assetId: b.id }))[0].verdict, 'accepted');
});

test('About -> Learning toggles the journaling itself (this tree records only locally)', async () => {
  const { engine } = await makeEngine();
  const a = await zombie(engine, 'zciv_quiet');
  await engine.learn.setJournaling(false);
  const run = await engine.startRun(a.id, { steps: [{ step: 'render_sprites', params: PASS_GOOD }] });
  await engine.waitJob(run.jobId);
  assert.equal((await engine.learn.runs({ assetId: a.id })).length, 0, 'no journal line while journaling is off');
  assert.equal((await engine.learn.overview()).journaling, false);
  const s = await engine.learn.sync();
  assert.equal(s.added, 0);
  assert.match(s.skipped, /journaling is off/, 'sync also pauses');
  // the switch is persisted in the library (knowledge.json), so the CLI and MCP see the same state
  const other = new ForgeLearn({ libraryDir: engine.libraryDir });
  assert.equal(await other.journalingOn(), false);
  await other.setJournaling(true);
  assert.equal((await engine.learn.knowledge()).journaling, true, 'the engine cache follows the file');
  const run2 = await engine.startRun(a.id, { steps: [{ step: 'render_sprites', params: PASS_GOOD }] });
  await engine.waitJob(run2.jobId);
  assert.equal((await engine.learn.runs({ assetId: a.id })).length, 1, 'journaling resumes');
});

test('HTTP: feedback, plan, recipes, journal and digest routes', async () => {
  const { engine } = await makeEngine();
  const app = express();
  app.use(express.json());
  registerForge(app, null, { engine });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/forge`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-imaginarium-client': 'studio' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  };
  try {
    const a = await zombie(engine);
    await runSprites(engine, a.id, PASS_GOOD);
    let r = await call('POST', `/assets/${a.id}/feedback`, { verdict: 'accepted', tags: [], comment: 'как на листе' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.feedback[0].verdict, 'accepted');
    r = await call('POST', '/learn/feedback', { assetId: a.id, verdict: 'nope' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /verdict/);
    const b = await zombie(engine, 'zciv_next');
    r = await call('POST', `/assets/${b.id}/plan`, { steps: [{ step: 'render_sprites', params: { profile: 'pixel' } }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.steps[0].params.outline, 'dark');
    r = await call('GET', '/learn/recipes?class=zombie');
    assert.ok(r.json.groups[0].best);
    r = await call('GET', '/learn/journal?class=zombie&limit=5');
    assert.equal(r.json.total, 1);
    r = await call('GET', '/learn/versions?class=zombie');
    assert.equal(r.json.items[0].verdict.comment, 'как на листе');
    r = await call('GET', '/learn/digest?class=zombie');
    assert.match(r.text, /Рецепт/);
    r = await call('POST', '/learn/pin', { class: '*', step: 'render_sprites', variant: 'pixel', params: { levels: true } });
    assert.equal(r.status, 200, r.text);
    r = await call('POST', '/learn/notes', { class: 'building', kind: 'route', text: 'процедурно' });
    assert.equal(r.status, 201, r.text);
    r = await call('GET', '/learn');
    assert.ok(Array.isArray(r.json.tags));
    r = await call('POST', '/learn/journaling', { on: false });
    assert.equal(r.json.journaling, false);
    r = await call('GET', '/learn');
    assert.equal(r.json.journaling, false);
    r = await call('POST', '/learn/journaling', { on: true });
    assert.equal(r.json.journaling, true);
    r = await call('POST', '/learn/sync', {});
    assert.equal(r.json.added, 0);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
