// RAM room before Pixal3D (0.6.10 wave ticket 21, the Linux twin of the 0.6.8 fix). The class of
// bug: Pixal3D (TRELLIS.2) is hungry for host memory too, and after other generators ran it died
// MID-RUN. The Linux shape: when free RAM looks short, first make room the honest way - ask the
// studio's other ComfyUI (8190) to unload its cached models, but ONLY while its queue is idle
// (a running job is never interrupted - same rule as the GPU hand-over) - then re-read; if it is
// STILL not enough, refuse up front with the numbers in the sentence. TripoSG and Sound are
// per-job workers here, so their memory is gone when they exit; there is nothing to evict.
//
// The thresholds are this branch's own tuning (never transcribed; the upstream Engine-side gate
// is an excluded line): PIXAL3D_MIN_FREE_RAM_MIB, tunable via ASTRA_RAM_FLOOR_MIB (clamped) -
// the ASTRA_VRAM_MIB seam style for the tests.
import { promises as fs } from 'node:fs';
import { engineUrls, engineQueue } from './gpu-handover.mjs';

export const RAM_THRESHOLDS = {
  pixal3dMinFreeMiB: 4096,   // measured on this branch's 12 GiB-card machine: TRELLIS decode pages badly below this
};

/** The floor for an engine, env-tunable and clamped to a sane range (0 disables the check). */
export function ramFloor(engine = 'pixal3d', env = process.env) {
  const base = engine === 'pixal3d' ? RAM_THRESHOLDS.pixal3dMinFreeMiB : 0;
  const over = Number(env.ASTRA_RAM_FLOOR_MIB);
  const v = Number.isFinite(over) ? over : base;
  return Math.max(0, Math.min(1024 * 1024, Math.trunc(v)));   // a petabyte is obviously a typo, not a floor
}

/**
 * Free memory in MiB from /proc/meminfo MemAvailable (the kernel's "safely reclaimable" number -
 * what a big allocation really gets). null when the system does not say (non-Linux, unreadable):
 * the caller must NOT guess - a check that cannot read does not refuse.
 * Seam for tests: ASTRA_FREE_RAM_MIB.
 */
export async function freeRamMiB({ env = process.env, readFile = fs.readFile } = {}) {
  const seam = Number(env.ASTRA_FREE_RAM_MIB);
  if (Number.isFinite(seam) && seam > 0) return seam;
  let text = '';
  try { text = await readFile('/proc/meminfo', 'utf8'); } catch { return null; }
  const m = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(text);
  if (!m) return null;
  return Math.floor(Number(m[1]) / 1024);
}

/** The refusal sentence with the numbers in it, or null when there is room. */
export function ramRoomText(freeMiB, needMiB, what = 'This engine') {
  if (freeMiB === null || needMiB <= 0 || freeMiB >= needMiB) return null;
  return `${what} wants at least ${needMiB} MiB of free memory to start - this machine has ${freeMiB} MiB free. Close a few programs (or restart the studio to release its cached models) and start again; the engine was not started.`;
}

/** Ask one idle ComfyUI to unload its models and return its memory to the OS. Best effort. */
async function freeOneEngine(url, { fetchFn, onStep }) {
  try {
    await fetchFn(url + '/free', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(8000),
    });
    onStep?.(`Unloaded ${url}`);
    return true;
  } catch { return false; }
}

/**
 * The pre-run check for one engine. Steps: read free RAM -> when short, unload the OTHER engine's
 * idle ComfyUI (skipped when it is busy - the GPU hand-over waits for it later anyway; when it
 * does not answer, it is simply not running) -> wait a beat for the reclaim -> re-read -> answer.
 * Never throws; answers { freeMiB, needMiB, unloaded: string[], busy: string[], refuse: sentence|null }.
 */
export async function ensureRamFor({
  engine = 'pixal3d', env = process.env, urls = {}, fetchFn = fetch, readFile = fs.readFile,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 1500, onStep = null,
} = {}) {
  const need = ramFloor(engine, env);
  const answer = { freeMiB: null, needMiB: need, unloaded: [], busy: [], refuse: null };
  if (need <= 0) return answer;                       // disabled: no probe, no refusal
  answer.freeMiB = await freeRamMiB({ env, readFile });
  if (answer.freeMiB === null || answer.freeMiB >= need) return answer;
  const all = engineUrls(urls, env);
  for (const [name, url] of Object.entries(all)) {
    if (name === engine || !url) continue;
    const queue = await engineQueue(url, fetchFn);
    if (!queue) continue;                              // not running: nothing resident to free
    if (queue.running || queue.pending) { answer.busy.push(name); continue; }   // never interrupt a job
    if (await freeOneEngine(url, { fetchFn, onStep })) answer.unloaded.push(name);
  }
  if (answer.unloaded.length) {
    await sleepFn(settleMs);
    answer.freeMiB = await freeRamMiB({ env, readFile });
  }
  answer.refuse = ramRoomText(answer.freeMiB, need, engine === 'pixal3d' ? 'Pixal3D' : engine);
  return answer;
}
