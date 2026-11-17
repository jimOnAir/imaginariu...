// GPU hand-over between the two 3D engines (Hunyuan ComfyUI :8190 and Pixal3D ComfyUI :8191, docs/forge/pixal3d.md).
//
// Pixal3D peaks at ~9.5 GB of the 12 GB card, Hunyuan keeps its models cached, so they can not both sit in VRAM.
// Before a generation on engine X the studio (under the shared GPU mutex, see gpu-lock.mjs):
//   1. looks at the OTHER engine's queue: while something runs or waits there it WAITS (a running job is never interrupted);
//   2. when that queue is empty it asks the other engine to unload its models (POST /free) and waits until the memory is back.
// An engine that does not answer (not started, not installed) is simply skipped.
import { acquireGpuLock } from './gpu-lock.mjs';
import { engineCardFor, sharesCard } from './gpu-pool.mjs';
import { pixal3dConfig } from './pixal3d.mjs';
import { isLowVram, currentVramMib } from './low-vram.mjs';
import { spawnSync } from 'node:child_process';

export const ENGINE_LABELS = { hunyuan: 'Hunyuan3D', pixal3d: 'Pixal3D' };
export const DEFAULT_HUNYUAN_URL = 'http://127.0.0.1:8190';

const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** URLs of both engines. hunyuan: explicit option, else ASTRA_COMFY_URL, else 8190; pixal3d: from pixal3dConfig(). */
export function engineUrls(urls = {}, env = process.env) {
  let pixal3d;
  try { pixal3d = pixal3dConfig({ env }).url; } catch { pixal3d = 'http://127.0.0.1:8191'; }
  return { hunyuan: env.ASTRA_COMFY_URL || DEFAULT_HUNYUAN_URL, pixal3d, ...urls };
}

async function json(fetchFn, url, options = {}) {
  const res = await fetchFn(url, { ...options, signal: options.signal || AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** ComfyUI queue of an engine: {running, pending} or null when it does not answer like a ComfyUI. */
export async function engineQueue(url, fetchFn = fetch) {
  try {
    const q = await json(fetchFn, url + '/queue', { signal: AbortSignal.timeout(2500) });
    if (!Array.isArray(q?.queue_running) || !Array.isArray(q?.queue_pending)) return null;
    return { running: q.queue_running.length, pending: q.queue_pending.length };
  } catch { return null; }
}

/** Torch VRAM currently reserved by an engine's own process (bytes), null when unknown. */
async function torchVram(url, fetchFn) {
  try {
    const stats = await json(fetchFn, url + '/system_stats', { signal: AbortSignal.timeout(2500) });
    const d = stats?.devices?.[0];
    return Number.isFinite(d?.torch_vram_total) ? d.torch_vram_total : null;
  } catch { return null; }
}

/**
 * Make room for `target` by unloading the other engine. Resolves with a report, throws only on abort or after `maxWaitMs`.
 * @param {'hunyuan'|'pixal3d'} target engine that is about to run
 * @param {object} [o] urls, signal, onWait(text) (called once when waiting starts), onStep(text), fetchFn, sleep, pollMs, maxWaitMs, settleMs,
 *   card (the card the target runs on; default the pool's claim - an engine that runs on ANOTHER card than `other` needs no room from it)
 * @returns {Promise<{waited:boolean, freed:string[], skipped:string[]}>}
 */
export async function handoverTo(target, o = {}) {
  const { signal, onWait, onStep, fetchFn = fetch, sleep = sleepMs, pollMs = 2000, maxWaitMs = 60 * 60 * 1000, settleMs = 8000 } = o;
  const urls = engineUrls(o.urls);
  const myCard = 'card' in o ? o.card : engineCardFor(target);
  const report = { waited: false, freed: [], skipped: [] };
  for (const other of Object.keys(ENGINE_LABELS).filter((name) => name !== target)) {
    const url = urls[other];
    if (!url || url === urls[target]) { report.skipped.push(other); continue; }
    // GPU pool (0.7.11): engines on different cards never fight - no drain, no /free, no ollama
    // unload there. An unknown card (no pool, reused external engine) keeps the old full hand-over.
    if (!sharesCard(myCard, engineCardFor(other))) { report.crossCard = (report.crossCard || []).concat(other); continue; }
    let queue = await engineQueue(url, fetchFn);
    if (!queue) { report.skipped.push(other); continue; }
    const started = Date.now();
    while (queue && (queue.running || queue.pending)) {
      if (!report.waited) {
        report.waited = true;
        onWait?.(`Waiting for ${ENGINE_LABELS[other]} to finish its job (not interrupting it)`);
      }
      if (Date.now() - started > maxWaitMs) throw new Error(`${ENGINE_LABELS[other]} has been busy too long (over ${Math.round(maxWaitMs / 60000)} min). Wait for its job to finish and try again.`);
      await sleep(pollMs, signal);
      signal?.throwIfAborted();
      queue = await engineQueue(url, fetchFn);
    }
    if (!queue) { report.skipped.push(other); continue; }   // it went away while we waited
    onStep?.(`Freeing VRAM: unloading ${ENGINE_LABELS[other]}`);
    const before = await torchVram(url, fetchFn);
    try {
      await fetchFn(url + '/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(5000) });
    } catch { report.skipped.push(other); continue; }
    report.freed.push(other);
    // ComfyUI runs /free on its worker loop: wait until its torch memory drops (bounded, best effort)
    if (before && before > 512 * 1024 * 1024) {
      const t0 = Date.now();
      let now = before;
      for (;;) {
        await sleep(500, signal);
        now = await torchVram(url, fetchFn);
        if (now === null || now < before * 0.5 || Date.now() - t0 > settleMs) break;
      }
      // Ticket 37 (Windows 0.6.15: "if other programs hold the GPU the studio says so
      // plainly"): the memory did not come back - name who holds the card.
      if (now !== null && now >= before * 0.5) {
        const held = await listGpuHolders(o.holdersProbe);
        if (held) { report.heldBy = held; onStep?.(`Video memory is still held by: ${held} - close that program (or wait for it to finish) before the next generation`); }
      }
    }
  }
  // Ticket 37 (Windows 0.6.15): before 3D on an 8 GB card the assistant models step aside too -
  // a resident Ollama model costs several of the eight gigabytes. Best effort, and only when
  // something is actually resident.
  if (o.lowVram ?? isLowVram(o.vramMib ?? currentVramMib({ refresh: true }))) {
    const unloaded = await unloadOllamaModels(o.ollamaUrl, fetchFn, o.env ?? process.env);
    if (unloaded.length) { report.ollamaUnloaded = unloaded; onStep?.(`Unloaded the assistant models (${unloaded.join(', ')}) - the card needs the room`); }
  }
  return report;
}

/** Process names holding compute memory (nvidia-smi), '' when it cannot be read or nothing runs. */
export async function listGpuHolders(probe) {
  try {
    const run = probe || ((args) => spawnSync('nvidia-smi', args, { encoding: 'utf8', timeout: 5000 })?.stdout || '');
    const out = String(await run(['--query-compute-apps=process_name,used_memory', '--format=csv,noheader']) || '');
    return out.trim().split('\n').map((l) => l.trim()).filter(Boolean).join('; ');
  } catch { return ''; }
}

/** Ask Ollama to drop its resident models (keep_alive 0 per running model - the documented unload).
 *  Best effort; resolves with the names it asked about, [] when Ollama does not answer. */
export async function unloadOllamaModels(url = null, fetchFn = fetch, env = process.env) {
  const base = url || (env.OLLAMA_HOST ? (/^https?:/.test(env.OLLAMA_HOST) ? env.OLLAMA_HOST : 'http://' + env.OLLAMA_HOST) : 'http://127.0.0.1:11434');
  let names;
  try {
    const res = await fetchFn(base + '/api/ps', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    names = (await res.json())?.models || [];
  } catch { return []; }
  const out = [];
  for (const m of names) {
    const name = m?.name || m?.model;
    if (!name) continue;
    out.push(name);
    try { await fetchFn(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(5000) }); } catch { /* best effort per model */ }
  }
  return out;
}

/**
 * The studio's GPU mutex (cross-process, gpu-lock.mjs) plus the hand-over to `engine`. Same result as acquireGpuLock: call release().
 * @param {'hunyuan'|'pixal3d'} engine
 * @param {object} [opts] everything acquireGpuLock takes, plus urls, onStep, fetchFn, sleep, acquire (tests), pollMs, maxWaitMs, settleMs
 */
export async function acquireEngineGpu(engine, opts = {}) {
  const { acquire = acquireGpuLock, urls, card, onStep, fetchFn, sleep, pollMs, maxWaitMs, settleMs, ...lockOpts } = opts;
  const lock = await acquire(lockOpts);
  try {
    lock.handover = await handoverTo(engine, { urls, card, signal: lockOpts.signal, onWait: onStep, onStep, fetchFn, sleep, pollMs, maxWaitMs, settleMs });
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Run fn under the GPU mutex after the hand-over. */
export async function withEngineGpu(engine, fn, opts = {}) {
  const lock = await acquireEngineGpu(engine, opts);
  try { return await fn(lock); } finally { await lock.release(); }
}

/** Best effort: unload one engine's models when it is idle (used after a Pixal3D job so other GPU work gets the memory). */
export async function freeIfIdle(url, fetchFn = fetch) {
  const queue = await engineQueue(url, fetchFn);
  if (!queue || queue.running || queue.pending) return false;
  try {
    await fetchFn(url + '/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(5000) });
    return true;
  } catch { return false; }
}
