// Auto-review (ticket 08): the decide() table, the retry bookkeeping, the absence paths, and the
// /api/autoreview routes. Nothing here touches Blender, Ollama or ComfyUI — every outside world is
// a scripted fake through the service's dependency seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { decide, seamCap, parseScores, tuneTable, THRESHOLDS, AXES, createAutoReviewService, registerAutoReview } from '../server/autoreview.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'imaginarium-ar-'));

// ---------------------------------------------------------------- decide(): the fixed table decides, never the model

test('decide: good scores pass, a floor miss and a mean miss both redo, N/A axes are skipped', () => {
  const good = { likeness: 8, silhouette: 7, seams: 9, face: null, style: 7 };
  assert.deepEqual(decide(good, null).verdict, 'pass', JSON.stringify(decide(good, null)));
  const floor = decide({ ...good, silhouette: 3 }, null);
  assert.equal(floor.verdict, 'redo');
  assert.match(floor.reasons.join(' '), /silhouette 3 is under 4/);
  const weak = decide({ likeness: 5, silhouette: 5, seams: 5, face: null, style: null }, null);
  assert.equal(weak.verdict, 'redo'); assert.match(weak.reasons.join(' '), /average 5 is under 5.5/);
  const na = decide({ likeness: 6, silhouette: 6, seams: 6, face: null, style: null }, { boundary_edges: 0, non_manifold_edges: 0, wire_edges: 0, loose_parts: 1 });
  assert.equal(na.verdict, 'pass', 'a prop with no face and no style cue is judged on three axes');
  assert.equal(na.mean, 6);
});

test('seamCap: plain mesh numbers cap the seam score, an unopenable model is the worst case', () => {
  const clean = { boundary_edges: 0, non_manifold_edges: 0, wire_edges: 0, loose_parts: 1 };
  assert.equal(seamCap(clean), 10);
  assert.equal(seamCap({ ...clean, boundary_edges: 12 }), 6);
  assert.equal(seamCap({ ...clean, non_manifold_edges: 2 }), 5);
  assert.equal(seamCap({ ...clean, wire_edges: 9 }), 5);
  assert.equal(seamCap({ ...clean, loose_parts: 4 }), 7);
  assert.equal(seamCap({ boundary_edges: 1, non_manifold_edges: 0, wire_edges: 0, loose_parts: 9 }), 6, 'the harshest applicable cap wins');
  assert.equal(seamCap(null), 10, 'no mesh numbers at all means no cap - the VLM is the only witness');
  assert.equal(seamCap({ load_error: true }), 0);
  const v = decide({ likeness: 9, silhouette: 9, seams: 10, face: 9, style: 9 }, { boundary_edges: 3, non_manifold_edges: 0, wire_edges: 0, loose_parts: 1 });
  assert.equal(v.scores.seams, 6, 'the VLM loves the surface, the edge counts overrule it');
  assert.equal(v.verdict, 'redo');
  assert.match(v.reasons.join(' '), /mesh numbers cap seams at 6 \(3 open/);
  const broken = decide({ likeness: 9, silhouette: 9, seams: 10, face: null, style: null }, { load_error: true });
  assert.equal(broken.scores.seams, 0, 'a model that will not open cannot have good seams whatever the VLM said');
});

test('decide is tunable: a different table is a different verdict, THRESHOLDS itself is untouched', () => {
  const scores = { likeness: 6, silhouette: 6, seams: 5, face: null, style: null };
  assert.equal(decide(scores, null, THRESHOLDS).verdict, 'pass');
  const strict = { ...THRESHOLDS, axisFloor: 6 };
  assert.equal(decide(scores, null, strict).verdict, 'redo');
  assert.equal(THRESHOLDS.axisFloor, 4, 'the default table is never mutated');
  const t = tuneTable(THRESHOLDS, { axisFloor: 99, meanFloor: -3, maxAttempts: 100, seamCap: { boundary: 2 } });
  assert.deepEqual([t.axisFloor, t.meanFloor, t.maxAttempts, t.seamCap.boundary, t.seamCap.nonManifold], [10, 0, 4, 2, 5], 'the env tune is clamped, the cap table merges');
});

test('parseScores: takes the object, ignores chatter, clamps, returns null instead of guessing', () => {
  assert.deepEqual(parseScores('Sure! {"likeness":8,"silhouette":"x","seams":12,"face":null,"style":7.4,"note":"fine"} hope that helps'), { note: 'fine', likeness: 8, silhouette: null, seams: 10, face: null, style: 7.4 });
  assert.equal(parseScores('the mesh looks okay to me'), null);
  assert.equal(parseScores('{"likeness":null,"silhouette":null,"seams":null,"face":null,"style":null}'), null, 'no usable axis is not a score');
  assert.equal(parseScores(''), null);
});

// ---------------------------------------------------------------- the retry loop with every world faked

function world({ answers = [], stats, pollFlip = 1 } = {}) {
  const dataDir = tmp(), libraryDir = tmp();
  const jobs = new Map();
  let created = 0, asked = 0;
  const made = { seeds: [], inputs: [] };
  const svc = createAutoReviewService({
    dataDir, libraryDir, env: {},
    getConfig: () => ({ ollamaUrl: 'http://127.0.0.1:1', reviewModel: '' }),
    vramFn: () => 12288,
    ollamaModelsFn: async () => ['qwen3-vl:8b'],
    assetInfoFn: async (id) => ({ id, extension: '.glb' }),
    blenderFn: async (o) => {
      await fs.mkdir(o.request.out_dir, { recursive: true });
      const frames = [];
      for (let i = 0; i < o.request.params.frames; i++) { const f = path.join(o.request.out_dir, `orbit_${String(i).padStart(2, '0')}.png`); await fs.writeFile(f, Buffer.from([137, 80, 78, 71])); frames.push(f); }
      await fs.writeFile(path.join(o.request.out_dir, 'orbit.json'), JSON.stringify({ frames: frames.map((f, i) => ({ file: path.basename(f), yaw_deg: i * 45 })) }));
      return { result: { stats: typeof stats === 'function' ? stats(o.request.out_dir) : stats ?? { boundary_edges: 0, non_manifold_edges: 0, wire_edges: 0, loose_parts: 1, tris: 900 }, outputs: { frames } } };
    },
    vlmAskFn: async (o) => { asked++; assert.ok(o.images.length >= 1, 'the orbit pictures ride the review call'); return answers[Math.min(asked - 1, answers.length - 1)]; },
    createJob: async (input) => { created++; made.inputs.push(input); const id = 'child' + created; made.seeds.push(input.seed); jobs.set(id, { id, status: 'running', seed: input.seed }); return { id }; },
    getJob: (id) => { const j = jobs.get(id); if (j && j.status === 'running' && pollFlip <= 1) { j.status = 'completed'; j.asset = { id: randomUUID(), extension: '.glb' }; } return j; },
    sleepFn: async () => {},
  });
  const parent = { id: randomUUID(), status: 'completed', engine: 'hunyuan', prompt: 'a red fox kit', seed: 11, asset: { id: randomUUID(), extension: '.glb' } };
  const journal = async () => (await fs.readFile(path.join(libraryDir, 'learning', 'autoreview.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { svc, parent, jobs, created: () => created, made, journal, asked: () => asked };
}
const ans = (n) => JSON.stringify({ likeness: n, silhouette: n, seams: n, face: n, style: n, note: 'x' });

test('a rejected first attempt auto-redoes with a NEW SEED and the accepted second becomes the record', async () => {
  const w = world({ answers: [ans(2), ans(8)] });
  const rec = await w.svc.start(w.parent);
  await new Promise((r) => setTimeout(r, 50));
  const r = await w.svc.get(rec.id);
  assert.equal(r.status, 'accepted'); assert.equal(r.best, 1);
  assert.equal(r.attempts.length, 2, 'pass stops the loop - no fourth attempt after the accepted one');
  assert.equal(w.created(), 1, 'exactly one retry generation');
  assert.notEqual(w.made.seeds[0], w.parent.seed, 'a retry with the same seed would render the same mesh');
  assert.equal(w.made.inputs[0].autoreviewOf, rec.id, 'the child belongs to this record and must not open its own review');
  assert.equal(w.made.inputs[0].prompt, 'a red fox kit', 'the retry repeats the request, only the seed changes');
  const lines = await w.journal();
  assert.deepEqual(lines.map((l) => l.verdict), ['rejected', 'accepted', 'accepted']);
  assert.ok(lines.every((l) => l.source === 'auto' && l.type === 'autoreview' && l.id === rec.id));
  assert.equal(lines.at(-1).final, true); assert.equal(lines.at(-1).best, 1);
  assert.equal(lines[0].reasons.length > 0, true, 'every reject names what fell short');
});

test('retries are spent 0..3 and the best-scoring attempt is kept', async () => {
  const w = world({ answers: [ans(4.5), ans(5.2), ans(4.8), ans(5)] });
  const rec = await w.svc.start(w.parent);
  await new Promise((r) => setTimeout(r, 50));
  const r = await w.svc.get(rec.id);
  assert.equal(r.attempts.length, 4, 'THRESHOLDS.maxAttempts attempts, never more');
  assert.equal(w.created(), 3);
  assert.equal(r.status, 'rejected');
  assert.equal(r.best, 1, 'the 5.2 attempt is the best of the rejects');
  assert.equal(r.attempts[1].mean, 5.2);
});

test('no review model installed: the verdict is skipped honestly - no retry storm, no fake pass', async () => {
  const dataDir = tmp(), libraryDir = tmp();
  const svc = createAutoReviewService({
    dataDir, libraryDir, env: {},
    getConfig: () => ({ ollamaUrl: 'http://127.0.0.1:1' }),
    vramFn: () => 12288, ollamaModelsFn: async () => [],   // Ollama silent: nothing installed
    assetInfoFn: async (id) => ({ id, extension: '.glb' }),
    blenderFn: async () => ({ result: { stats: { boundary_edges: 0, non_manifold_edges: 0, wire_edges: 0, loose_parts: 1 }, outputs: { frames: [] } } }),
    vlmAskFn: async () => { throw new Error('must not be called'); },
    createJob: async () => { throw new Error('must not generate without a reviewer'); },
    getJob: () => null, sleepFn: async () => {},
  });
  const rec = await svc.start({ id: randomUUID(), status: 'completed', engine: 'hunyuan', seed: 1, asset: { id: randomUUID(), extension: '.glb' } });
  await new Promise((r) => setTimeout(r, 30));
  const r = await svc.get(rec.id);
  assert.equal(r.status, 'review-unavailable');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].verdict, 'skipped');
  assert.match(r.attempts[0].reasons[0], /review unavailable/);
});

test('the mesh numbers out-vote a delighted VLM end to end: cap -> redo -> journal reason', async () => {
  const w = world({ answers: [ans(9)], stats: { boundary_edges: 41, non_manifold_edges: 0, wire_edges: 0, loose_parts: 1, tris: 900 } });
  const rec = await w.svc.start(w.parent);
  await new Promise((r) => setTimeout(r, 200));
  const r = await w.svc.get(rec.id);
  const first = r.attempts[0];
  assert.equal(first.scores.seams, 6, '9 was capped to 6 by the boundary edges');
  assert.match(first.reasons.join(' '), /mesh numbers cap seams/);
  assert.equal(first.mesh.boundary_edges, 41, 'the plain numbers ride the journal line');
  assert.equal(r.status, 'rejected', 'a hole-riddled mesh cannot be accepted by taste');
});

test('the IMAGINARIUM_AUTOREVIEW=0 gate and the child-job guard: start() declines without a fuss', async () => {
  const gated = createAutoReviewService({ dataDir: tmp(), libraryDir: tmp(), env: { IMAGINARIUM_AUTOREVIEW: '0' }, getJob: () => null, createJob: async () => { throw new Error('no'); } });
  assert.equal(await gated.start({ id: randomUUID(), asset: { id: randomUUID(), extension: '.glb' } }, { auto: true }), null);
  const open = createAutoReviewService({ dataDir: tmp(), libraryDir: tmp(), env: {}, getJob: () => null, createJob: async () => { throw new Error('no'); } });
  assert.equal(await open.start({ id: randomUUID(), autoreviewOf: randomUUID(), asset: { id: randomUUID(), extension: '.glb' } }), null, 'a retry child is reviewed by its own record');
  assert.equal(await open.start({ id: randomUUID(), asset: { id: randomUUID(), extension: '.png' } }), null, 'no GLB, no review');
});

// ---------------------------------------------------------------- routes

function routeApp() {
  const svc = createAutoReviewService({ dataDir: tmp(), libraryDir: tmp(), env: {}, getJob: () => null, createJob: async () => ({ id: randomUUID() }) });
  const app = express();
  app.use((req, res, next) => { if (!['GET', 'HEAD'].includes(req.method) && req.path.startsWith('/api') && req.headers['x-imaginarium-client'] !== 'studio') return res.status(403).json({ error: 'The request must be sent from the studio.' }); next(); });
  app.use(express.json());
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  registerAutoReview(app, asyncRoute, { service: svc, dataDir: svc.rootDir.replace(/\/autoreview$/, '') });
  app.use((err, req, res, next) => { res.status(err.status || 400).json({ error: err.message }); });
  return { app, svc };
}
const servers = [];
const listen = async (app) => { const srv = app.listen(0, '127.0.0.1'); servers.push(srv); await new Promise((r) => srv.once('listening', r)); return 'http://127.0.0.1:' + srv.address().port; };

test('routes: studio guard, empty list, thresholds readout, honest 404s, orbit files only by name', async (t) => {
  const { app } = routeApp();
  const base = await listen(app);
  t.after(() => new Promise((r) => { for (const srv of servers) { srv.closeAllConnections(); srv.close(r); } }));
  const get = (p) => fetch(base + p).then(async (r) => ({ code: r.status, body: await r.json().catch(() => null) }));
  assert.equal((await get('/api/autoreview')).code, 200);
  assert.deepEqual((await get('/api/autoreview')).body, []);
  const th = await get('/api/autoreview/thresholds');
  assert.deepEqual(Object.keys(th.body.thresholds).sort(), ['axisFloor', 'maxAttempts', 'meanFloor', 'seamCap']);
  assert.deepEqual(th.body.axes, AXES);
  assert.equal((await get('/api/autoreview/' + randomUUID())).code, 404);
  assert.equal((await get('/api/autoreview/not-an-id')).code, 404);
  const orbit = await fetch(base + '/api/autoreview/' + randomUUID() + '/orbit/a0/..%2F..%2F..%2Fetc%2Fpasswd');
  assert.equal(orbit.status, 404, 'the attempt and file names are whitelisted, not joined blindly');
  const post = await fetch(base + '/api/autoreview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 403, 'a mutating call without the studio header is refused');
  const ok = await fetch(base + '/api/autoreview', { method: 'POST', headers: { 'content-type': 'application/json', 'x-imaginarium-client': 'studio' }, body: JSON.stringify({ jobId: randomUUID() }) });
  assert.equal(ok.status, 404, 'a job this studio never had cannot be reviewed');
  const junk = await fetch(base + '/api/autoreview', { method: 'POST', headers: { 'content-type': 'application/json', 'x-imaginarium-client': 'studio' }, body: JSON.stringify({ jobId: 'cucumber' }) });
  assert.ok(junk.status >= 400 && junk.status < 500);
});
