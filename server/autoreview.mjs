// Auto-review (docs/product/autoreview.md, 0.6.x wave ticket 08): the studio checks its own 3D
// output. A finished shape gets an orbit render (Blender step `orbit_render`), the local VLM scores
// it against the concept on five axes, and the VERDICT COMES FROM THE FIXED TABLE in decide() —
// never from the model's own judgement; plain mesh numbers (boundary/non-manifold edges, loose
// parts) cap the seam score. Failed attempts auto-redo with new seeds (retries 0..3), the best
// attempt is kept, every verdict is journaled to <library>/learning/autoreview.jsonl with source
// «auto». The review model travels through ticket 14's pick (IMAGINARIUM_REVIEW_VLM > Connections
// choice > VRAM tier); which model answered and why is part of every journal line.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { data, assetInfo, isId, writeJson, readJson } from './storage.mjs';
import { vlmAsk, pickReviewModel } from './vlm.mjs';
import { ollamaModels } from './ollama-run.mjs';
import { vramMiB } from './triposg.mjs';
import { runBlenderStep } from './blender.mjs';
import { defaultLibraryDir } from './forge-pipeline.mjs';
import { getJob } from './jobs.mjs';

// The threshold table is this branch's own tuning (recorded as tunable, never transcribed from
// anywhere): integers 0-10 per axis; an axis a picture cannot speak for (face on a prop) is null.
export const THRESHOLDS = {
  axisFloor: 4,        // every scorable axis must reach this
  meanFloor: 5.5,      // and the average must reach this
  maxAttempts: 4,      // attempt 0 + retries 1..3
  seamCap: { clean: 10, looseParts: 7, boundary: 6, nonManifold: 5 },  // mesh numbers, not taste
};
// Tunable: IMAGINARIUM_REVIEW_TUNE='{"axisFloor":6}' (same seam style as IMAGINARIUM_VRAM_MIB) - for tuning
// and demos; production runs on the table above. Guards keep the table inside sane bounds.
export function tuneTable(base, over) {
  const o = { ...base, ...(over || {}) };
  o.axisFloor = Math.max(0, Math.min(10, Number(o.axisFloor) || 0));
  o.meanFloor = Math.max(0, Math.min(10, Number(o.meanFloor) || 0));
  o.maxAttempts = Math.max(1, Math.min(4, Math.trunc(Number(o.maxAttempts) || 1)));
  o.seamCap = { ...base.seamCap, ...(over && typeof over.seamCap === 'object' ? over.seamCap : {}) };
  return o;
}
export const AXES = ['likeness', 'silhouette', 'seams', 'face', 'style'];

export const REVIEW_PROMPT = 'You are reviewing a 3D asset generated from the concept picture. Image 1 is the concept; the rest are an orbit of the mesh (four azimuths, flat studio shading, transparent background). Rate the mesh against the concept with INTEGER scores 0-10 on five axes: "likeness" (same character as the concept), "silhouette" (shape readable at a distance), "seams" (surface continuity - holes, open edges, broken geometry; 10 is a clean surface), "face" (face quality, or null when the subject has no face), "style" (fits the project look implied by the concept, or null when the concept gives no style cue). Answer with ONLY one JSON object shaped like {"likeness":8,"silhouette":7,"seams":6,"face":null,"style":7,"note":"one short sentence"}.';

const clampScore = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v * 10) / 10)) : null);

// Parse the score object out of the answer; anything that is not a usable object is null (never a guess).
export function parseScores(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw;
  try { raw = JSON.parse(m[0]); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : null };
  let any = false;
  for (const a of AXES) { const v = clampScore(raw[a]); out[a] = v; if (v !== null) any = true; }
  return any ? out : null;
}

// Plain mesh numbers cap the seam score: a VLM that cannot see an internal hole still must not
// out-vote the edge counts. No numbers at all is no cap (the VLM is the only witness); an
// unopenable model is the worst seams case there is.
export function seamCap(mesh, t = THRESHOLDS) {
  if (mesh && mesh.load_error) return 0;
  if (!mesh) return t.seamCap.clean;
  let cap = t.seamCap.clean;
  if (mesh.boundary_edges > 0) cap = Math.min(cap, t.seamCap.boundary);
  if (mesh.non_manifold_edges > 0 || mesh.wire_edges > 0) cap = Math.min(cap, t.seamCap.nonManifold);
  if (mesh.loose_parts > 1) cap = Math.min(cap, t.seamCap.looseParts);
  return cap;
}

// The verdict rule (T2's "good passes, bad redoes"): the model scores, THIS table decides.
export function decide(scores, mesh, t = THRESHOLDS) {
  const cap = seamCap(mesh, t);
  const given = scores || {};
  const capped = {};
  for (const a of AXES) capped[a] = given[a] ?? null;
  capped.seams = capped.seams === null ? (cap === 0 ? 0 : null) : (cap === 0 ? 0 : Math.min(capped.seams, cap));
  const checked = AXES.map((a) => [a, capped[a]]).filter(([, v]) => v !== null);
  const reasons = [];
  for (const [a, v] of checked) if (v < t.axisFloor) reasons.push(`${a} ${v} is under ${t.axisFloor}`);
  if (given.seams !== null && given.seams !== undefined && given.seams !== capped.seams) {
    reasons.push(`the mesh numbers cap seams at ${cap}` + (mesh?.load_error ? ' (the model could not be opened)' : ` (${mesh.boundary_edges} open, ${mesh.non_manifold_edges} non-manifold, ${mesh.loose_parts} loose part(s))`));
  }  const mean = checked.length ? Math.round((checked.reduce((s, [, v]) => s + v, 0) / checked.length) * 100) / 100 : 0;
  if (mean < t.meanFloor) reasons.push(`average ${mean} is under ${t.meanFloor}`);
  return { verdict: reasons.length ? 'redo' : 'pass', mean, seamsCapped: capped.seams, cap, scores: capped, reasons };
}

export function createAutoReviewService(o = {}) {
  const {
    dataDir = data, getConfig = () => ({}), env = process.env,
    libraryDir = defaultLibraryDir(dataDir),
    blenderFn = runBlenderStep, vlmAskFn = vlmAsk, ollamaModelsFn = ollamaModels,
    vramFn = vramMiB, createJob, getJob, assetInfoFn = assetInfo,
    sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), fetchFn = fetch,
    pollMs = 2000, jobTimeoutMs = 45 * 60 * 1000,
  } = o;
  const rootDir = path.join(dataDir, 'autoreview');
  let TABLE; try { TABLE = tuneTable(THRESHOLDS, env.IMAGINARIUM_REVIEW_TUNE ? JSON.parse(env.IMAGINARIUM_REVIEW_TUNE) : null); } catch { TABLE = THRESHOLDS; }
  const journalFile = path.join(libraryDir, 'learning', 'autoreview.jsonl');
  const records = new Map();
  const recDir = (id) => path.join(rootDir, id);
  const fileChain = new Map();
  const appendJsonl = (file, line) => {
    const next = (fileChain.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify(line) + '\n', 'utf8');
    });
    fileChain.set(file, next);
    return next;
  };
  const persist = async (record) => { record.updatedAt = new Date().toISOString(); await fs.mkdir(recDir(record.id), { recursive: true }); return writeJson(path.join(recDir(record.id), 'record.json'), record); };
  const glbFile = async (job) => { const info = await assetInfoFn(job.asset.id); return path.join(dataDir, 'assets', info.id + info.extension); };
  async function conceptFile(job) { // the picture the VLM compares against, in the order of trust
    for (const id of [job.preparedConcept?.reference?.id, job.concept?.id, job.imageId]) {
      if (!id || !isId(id)) continue;
      try { const info = await assetInfoFn(id); const f = path.join(dataDir, 'assets', info.id + info.extension); await fs.access(f); return f; } catch { /* next */ }
    }
    return null;
  };
  const readImages = async (concept, frames, maxFrames = 4) => { // base64 for vlmAsk; concept first, orbit sampled to <=maxFrames
    // (four frames is what this branch measured as reliable on a single card that also hosts the shape engine)
    const files = [concept, ...(frames || []).filter((_, i) => frames.length <= maxFrames || i % Math.ceil(frames.length / maxFrames) === 0)].filter(Boolean);
    const out = [];
    for (const f of files) { try { out.push((await fs.readFile(f)).toString('base64')); } catch { /* a frame that vanished mid-review is not fatal */ } }
    return out;
  };
  async function waitJob(id) {
    const deadline = Date.now() + jobTimeoutMs;
    for (;;) {
      const j = getJob?.(id);
      if (j && !['queued', 'running'].includes(j.status)) return j;
      if (!j || Date.now() > deadline) return j || { id, status: 'lost', message: 'the job record disappeared' };
      await sleepFn(pollMs);
    }
  }

  async function journal(record, attempt, extra = {}) {
    await appendJsonl(journalFile, {
      v: 1, type: 'autoreview', id: record.id, at: new Date().toISOString(), source: 'auto',
      jobId: record.jobId, engine: record.engine || null, prompt: record.prompt || null,
      attempt: attempt?.n ?? null, jobId_attempt: attempt?.jobId ?? null, seed: attempt?.seed ?? null,
      assetId: attempt?.assetId ?? null, model: attempt?.model ?? null, modelReason: attempt?.modelReason ?? null,
      scores: attempt?.scores ?? null, seamsCap: attempt?.cap ?? null, mesh: attempt?.mesh ?? null,
      mean: attempt?.mean ?? null, verdict: attempt?.verdict ?? null, reasons: attempt?.reasons ?? [], ...extra,
    });
    return persist(record);
  }

  // One attempt = orbit render -> VLM scores -> decide(). Returns 'pass' | 'redo' | 'skipped'.
  async function reviewAttempt(record, job, n) {
    const attempt = { n, jobId: job.id, seed: job.seed ?? null, assetId: job.asset?.id ?? null };
    record.attempts.push(attempt);
    const outDir = path.join(recDir(record.id), 'a' + n);
    let mesh = null, frames = [];
    try {
      const res = await blenderFn({ step: 'orbit_render', jobId: ('ar_' + record.id + '_a' + n).slice(0, 40), request: { inputs: { mesh: await glbFile(job) }, params: { frames: 8, size: 384 }, out_dir: outDir } });
      mesh = res.result?.stats || null;
      frames = res.result?.outputs?.frames || [];
      const manifest = await readJson(path.join(outDir, 'orbit.json'), null);
      attempt.orbitFrames = manifest?.frames?.length ?? frames.length;
    } catch (e) {
      mesh = { load_error: true };
      attempt.error = 'the orbit render failed: ' + e.message;
    }
    let scores = null, pick = null, vlmError = null;
    try {
      const cfg = getConfig() || {};
      const installed = (await ollamaModelsFn(cfg.ollamaUrl, fetchFn)) || [];
      pick = pickReviewModel(vramFn(), installed, env, cfg.reviewModel);
      if (!pick.installed) throw new Error(pick.reason);
      const images = await readImages(await conceptFile(job), frames);
      // one quiet retry: local vision models answer honestly but occasionally flake an empty -
      // a pick failure is final, a flaky answer gets one more try before we call it unavailable
      for (let tryN = 0; tryN < 2 && !scores; tryN++) {
        try { scores = parseScores(await vlmAskFn({ url: cfg.ollamaUrl, model: pick.model, prompt: REVIEW_PROMPT, images, fetchFn, timeoutMs: 600000 })); }
        catch (e) { vlmError = e; if (tryN === 0) await sleepFn(3000); }
        if (!scores && tryN === 0) vlmError = vlmError || new Error('the review model did not answer with a score object');
      }
      if (!scores) throw vlmError || new Error('the review model did not answer with a score object');
    } catch (e) {
      attempt.model = pick?.model ?? null; attempt.modelReason = pick?.reason ?? String(e.message || e);
      attempt.verdict = 'skipped'; attempt.reasons = ['review unavailable: ' + e.message];
      attempt.mesh = mesh ? (mesh.load_error ? { load_error: true } : { boundary_edges: mesh.boundary_edges, non_manifold_edges: mesh.non_manifold_edges, loose_parts: mesh.loose_parts }) : null;
      await journal(record, attempt);
      return { kind: 'skipped', attempt };
    }
    const v = decide(scores, mesh, TABLE);
    attempt.model = pick.model; attempt.modelReason = pick.reason; attempt.note = scores.note;
    attempt.scores = v.scores; attempt.mean = v.mean; attempt.cap = v.cap; attempt.verdict = v.verdict === 'pass' ? 'accepted' : 'rejected'; attempt.reasons = v.reasons;
    attempt.mesh = mesh && !mesh.load_error ? { boundary_edges: mesh.boundary_edges, non_manifold_edges: mesh.non_manifold_edges, wire_edges: mesh.wire_edges, loose_parts: mesh.loose_parts, tris: mesh.tris } : { load_error: true };
    await journal(record, attempt);
    return { kind: v.verdict, attempt };
  }

  const freshSeed = () => 1 + Math.floor(Math.random() * 2147483646);
  const retryInput = (record, job) => ({ engine: job.engine, imageId: job.imageId, prompt: job.prompt, quality: job.quality, shapeModel: job.shapeModel, viewSetId: job.viewSetId, backgroundMode: job.backgroundMode, meshLevel: job.meshLevel, autoreviewOf: record.id });

  async function runRecord(record, job) {
    let attemptJob = job;
    let skipped = false;
    for (let n = 0; n < TABLE.maxAttempts; n++) {
      if (n > 0) { // a retry generation: same request, a new seed
        if (!attemptJob) { record.attempts.push({ n, verdict: 'rejected', reasons: ['there is no finished asset to review'] }); await journal(record, record.attempts.at(-1)); continue; }
        if (attemptJob.status !== 'completed' || !attemptJob.asset) {
          record.attempts.push({ n, jobId: attemptJob.id ?? null, seed: attemptJob.seed ?? null, verdict: 'rejected', reasons: ['the generation did not finish: ' + (attemptJob.message || attemptJob.status)] });
          await journal(record, record.attempts.at(-1));
          attemptJob = null;
          if (n + 1 < TABLE.maxAttempts) attemptJob = await waitJob((await createJob({ ...retryInput(record, job), seed: freshSeed() }, getConfig())).id);
          continue;
        }
      }
      record.status = n ? `retry ${n} · reviewing` : 'reviewing';
      await persist(record);
      const { kind, attempt } = await reviewAttempt(record, attemptJob, n);
      if (kind === 'skipped') { skipped = true; break; }
      if (kind === 'pass') { record.status = 'accepted'; record.best = attempt.n; await journal(record, attempt, { final: true, best: attempt.n, status: 'accepted' }); return; }
      if (n + 1 < TABLE.maxAttempts) {
        attemptJob = await waitJob((await createJob({ ...retryInput(record, job), seed: freshSeed() }, getConfig())).id);
      }
    }
    const scored = record.attempts.filter((a) => typeof a.mean === 'number');
    if (skipped) { record.status = 'review-unavailable'; record.best = scored[0]?.n ?? record.attempts[0]?.n ?? null; }
    else {
      record.status = 'rejected';
      let best = scored[0]; for (const a of scored) if (a.mean > best.mean) best = a;
      record.best = best ? best.n : record.attempts[0]?.n ?? null;
    }
    await journal(record, null, { final: true, best: record.best, status: record.status });
  }

  // One review at a time (Blender CPU + the local VLM): reviews queue in call order.
  let chain = Promise.resolve();
  function start(job, { auto = false } = {}) {
    if (!job?.asset || job.asset.extension !== '.glb') return Promise.resolve(null);
    if (auto && env.IMAGINARIUM_AUTOREVIEW === '0') return Promise.resolve(null);
    if (job.autoreviewOf) return Promise.resolve(null); // a child generation belongs to its record already
    const record = { v: 1, id: randomUUID(), jobId: job.id, engine: job.engine || 'hunyuan', prompt: job.prompt || null, createdAt: new Date().toISOString(), status: 'queued', attempts: [], best: null };
    records.set(record.id, record);
    chain = chain.then(() => runRecord(record, job).catch((e) => { record.status = 'failed'; record.error = e.message; return persist(record); }));
    return persist(record).then(() => record);
  }
  async function get(id) {
    if (records.has(id)) return records.get(id);
    const rec = await readJson(path.join(recDir(id), 'record.json'), null);
    if (rec) records.set(id, rec);
    return rec;
  }
  async function list() { // summaries for the panel; disk is the memory when the studio restarted
    const ids = new Set([...records.keys()]);
    try { for (const f of await fs.readdir(rootDir)) if (await fs.stat(path.join(rootDir, f)).then((s) => s.isDirectory()).catch(() => false)) ids.add(f); } catch { /* no reviews yet */ }
    const out = [];
    for (const id of ids) { const r = await get(id); if (r) out.push({ id: r.id, jobId: r.jobId, engine: r.engine, prompt: r.prompt, status: r.status, best: r.best, createdAt: r.createdAt, updatedAt: r.updatedAt, attempts: r.attempts.map((a) => ({ n: a.n, verdict: a.verdict, mean: a.mean ?? null, seed: a.seed ?? null, model: a.model ?? null })) }); }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async function journalLines(limit = 50) { // last journal entries, newest first (panel detail)
    let text = '';
    try { text = await fs.readFile(journalFile, 'utf8'); } catch { return []; }
    return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit).reverse();
  }
  return { start, get, list, journalLines, rootDir, journalFile, table: () => TABLE };
}

export function registerAutoReview(app, asyncRoute, { service, dataDir = data }) {
  const ORBIT_FILE = /^orbit_\d{2}\.png$/;
  const ATTEMPT_DIR = /^a[0-3]$/;
  const summary = (r) => ({ id: r.id, jobId: r.jobId, engine: r.engine, prompt: r.prompt, status: r.status, best: r.best, error: r.error || null, createdAt: r.createdAt, updatedAt: r.updatedAt, attempts: r.attempts });
  app.get('/api/autoreview', asyncRoute(async (_req, res) => res.json(await service.list())));
  app.get('/api/autoreview/thresholds', asyncRoute(async (_req, res) => res.json({ thresholds: service.table ? service.table() : THRESHOLDS, axes: AXES })));
  app.get('/api/autoreview/journal', asyncRoute(async (req, res) => res.json(await service.journalLines(Math.min(200, Math.max(1, Number(req.query.limit) || 50))))));
  app.get('/api/autoreview/:id', asyncRoute(async (req, res) => { const r = isId(req.params.id) && await service.get(req.params.id); if (!r) throw Object.assign(new Error('No such review.'), { status: 404 }); res.json(summary(r)); }));
  app.get('/api/autoreview/:id/orbit/:attempt/:file', asyncRoute(async (req, res, next) => {
    if (!isId(req.params.id) || !ATTEMPT_DIR.test(req.params.attempt) || !ORBIT_FILE.test(req.params.file)) return next(Object.assign(new Error('No such orbit picture.'), { status: 404 }));
    const r = await service.get(req.params.id);
    if (!r) return next(Object.assign(new Error('No such review.'), { status: 404 }));
    const full = path.join(dataDir, 'autoreview', req.params.id, req.params.attempt, req.params.file);
    await fs.access(full).catch(() => { throw Object.assign(new Error('The orbit picture is gone.'), { status: 404 }); });
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(full);
  }));
  app.post('/api/autoreview', asyncRoute(async (req, res) => {
    const { jobId } = z.object({ jobId: z.string().uuid() }).strict().parse(req.body || {});
    const job = getJob(jobId);
    if (!job) throw Object.assign(new Error('No such job.'), { status: 404 });
    if (job.status !== 'completed' || job.asset?.extension !== '.glb') throw new Error('Only a finished 3D generation with a GLB can be reviewed.');
    const rec = await service.start(job);
    if (!rec) throw new Error('This job is already part of a review.');
    res.status(202).json(summary(rec));
  }));
}
