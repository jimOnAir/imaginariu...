// GPU card pool (0.7.11): the studio does not ask WHICH card to use - it asks WHICH IS BEST
// RIGHT NOW. At every engine spawn (ComfyUI 8190, Pixal3D 8191, the one-shot TripoSG worker) the
// pool enumerates the cards, keeps those that fit the engine's needs, and claims the smallest
// fitting one (fit-first: a light job must not eat the big card the heavy engine will want);
// ties break to more free VRAM. A long-lived engine keeps its card until it exits (a running
// torch process cannot be moved - CUDA_VISIBLE_DEVICES is fixed at spawn), so a job whose card
// is taken waits in the queue instead of thrashing two engines over one VRAM budget.
//
// Cross-process safety stays with gpu-lock.mjs, but the lock is per CARD now
// (AF_GPU_RENDER_<uuid>): two engines on two cards run at once, two on one card serialize and
// hand over. When nvidia-smi cannot be read there is no pool: engineCardFor() answers null,
// every caller falls back to the legacy single global lock and an untouched environment -
// exactly the pre-pool behaviour, never a guess.
//
// Seam style as everywhere: ASTRA_GPU_CARDS (a JSON array) fakes the enumeration for tests and
// odd machines; spawnFn injects the probe; resetGpuPool() clears state between tests.
import { spawnSync } from 'node:child_process';
import { GPU_MUTEX_NAME } from './gpu-lock.mjs';

// Branch tuning (never transcribed): a card with less FREE VRAM than the engine's need is not
// offered to it as a first choice. These are preferences, not hard limits - the hard gates stay
// where they always were (the Pixal3D driver/RAM preflight, the OOM wording). pixal3d is the
// measured peak of this branch's own runs (9.9 GiB on a wizard, live 2026-11-17); hunyuan is
// dominated by its SDXL concept stage; triposg by its 575M DiT.
export const ENGINE_VRAM_NEED_MIB = { hunyuan: 6144, triposg: 4096, pixal3d: 10240 };

const QUERY = ['--query-gpu=index,uuid,name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'];

// Short TTL: memory.used is what we decide on and it moves every second; a fresh studio
// refreshing /api/gpus should not spawn nvidia-smi per poll.
const CACHE_MS = 2000;
let probeCache = null;   // {at, cards}

/** [{index,uuid,name,memoryTotalMiB,memoryUsedMiB,freeMiB,driverVersion}] or null when the pool is unavailable. */
export function enumerateGpus({ env = process.env, spawnFn = spawnSync, refresh = false } = {}) {
  const seam = String(env.ASTRA_GPU_CARDS || '').trim();
  if (seam) {
    try {
      const list = JSON.parse(seam);
      if (Array.isArray(list)) return list.map(toCard).filter(Boolean);
    } catch { /* a broken seam falls through to the real probe - the file's truth beats a typo */ }
  }
  if (env === process.env && !refresh && probeCache && Date.now() - probeCache.at < CACHE_MS) return probeCache.cards;
  let cards = null;
  try {
    const out = spawnFn('nvidia-smi', QUERY, { encoding: 'utf8', timeout: 8000 });
    const lines = String(out?.stdout || '').trim().split('\n').filter((l) => l.trim());
    if (lines.length) cards = lines.map((l) => toCardFromCsv(l)).filter(Boolean);
    if (cards && !cards.length) cards = null;
  } catch { /* no nvidia-smi: no pool */ }
  if (env === process.env) probeCache = { at: Date.now(), cards };
  return cards;
}

function toCardFromCsv(line) {
  // nvidia-smi prints the fields in QUERY order; only the NAME can contain a comma, so anchor:
  // first two and last three fields are index/uuid and memory/driver, everything between is the name.
  const p = line.split(',').map((s) => s.trim());
  if (p.length < 6) return null;
  return toCard({
    index: Number(p[0]), uuid: p[1], name: p.slice(2, p.length - 3).join(', '),
    memoryTotalMiB: Number(p[p.length - 3]), memoryUsedMiB: Number(p[p.length - 2]), driverVersion: p[p.length - 1],
  });
}

function toCard(c) {
  const index = Number(c.index), total = Number(c.memoryTotalMiB ?? c.totalMiB), used = Number(c.memoryUsedMiB ?? c.usedMiB);
  if (!Number.isInteger(index) || index < 0) return null;
  const memoryTotalMiB = Number.isFinite(total) && total > 0 ? total : null;
  const memoryUsedMiB = Number.isFinite(used) && used >= 0 ? used : null;
  const freeMiB = memoryTotalMiB !== null && memoryUsedMiB !== null ? Math.max(0, memoryTotalMiB - memoryUsedMiB) : null;
  return {
    index, uuid: c.uuid ? String(c.uuid) : null, name: c.name ? String(c.name) : null,
    memoryTotalMiB, memoryUsedMiB, freeMiB, driverVersion: c.driverVersion ? String(c.driverVersion) : null,
  };
}

/** Engine need with the ASTRA_GPU_NEED_MIB_<ENGINE> override (test seam and rescue lever). */
export function vramNeedMiB(engine, env = process.env) {
  const over = Number(env['ASTRA_GPU_NEED_MIB_' + String(engine).toUpperCase()]);
  if (Number.isFinite(over) && over >= 0) return over;
  return ENGINE_VRAM_NEED_MIB[engine] ?? 0;
}

const fits = (card, need) => card.freeMiB === null || card.freeMiB >= need;   // unknown free: only "not offered when something better is" - callers decide
const key = (card) => card.uuid || `#${card.index}`;

/**
 * Choose the card for an engine spawn. fit-first (smallest fitting card), tie -> more free VRAM.
 * @param {object} o engine (for the need profile), cards, claimed (uuid keys of cards held by
 *   other studio engines - never offered), free:true (default) only offers cards with room for
 *   the engine; free:false is the spawn-anyway answer: the most suitable card even when its
 *   memory is currently busy (the per-card lock and hand-over serialize it).
 * @returns {object|null} a card or null (no card exists/can fit - the caller waits or refuses).
 */
export function pickCard({ engine = 'hunyuan', cards = enumerateGpus(), claimed = [], free = true, env = process.env } = {}) {
  if (!cards?.length) return null;
  const need = vramNeedMiB(engine, env);
  const held = new Set(claimed.map((c) => (c && typeof c === 'object' ? key(c) : c)));
  const pool = cards
    .filter((c) => !held.has(key(c)))
    .filter((c) => (free ? fits(c, need) : (c.memoryTotalMiB === null || c.memoryTotalMiB >= need || fits(c, need))));
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => {
    const ta = a.memoryTotalMiB ?? Number.MAX_SAFE_INTEGER, tb = b.memoryTotalMiB ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;                                            // smallest card that fits
    return (b.freeMiB ?? -1) - (a.freeMiB ?? -1);                             // tie: the emptiest
  })[0];
}

// Which long-lived engine sits on which card. Set by the spawner, read by the job layer (lock
// name) and the hand-over (skip cross-card); a reused external engine claims nothing (unknown card).
const engineCards = new Map();
export const claimEngineCard = (engine, card) => { if (card) engineCards.set(engine, card); else engineCards.delete(engine); return card || null; };
export const engineCardFor = (engine) => engineCards.get(engine) || null;
export function resetGpuPool() { engineCards.clear(); probeCache = null; }

/** True when the two engines must take turns (same card, or either card unknown - the old default). */
export function sharesCard(cardA, cardB) { return !cardA || !cardB || key(cardA) === key(cardB); }

/** The per-card lock name for a card; null card -> the legacy global name. */
export function cardLockName(card) {
  return card ? `Global\\${GPU_MUTEX_NAME.replace(/^Global\\/, '')}_${(card.uuid || String(card.index)).replace(/[^A-Za-z0-9._-]+/g, '_')}` : null;
}

/** Child environment for a chosen card: pin CUDA_VISIBLE_DEVICES; no card (no pool) touches nothing. */
export const cardEnv = (card, base = process.env) => (card ? { ...base, CUDA_VISIBLE_DEVICES: String(card.index) } : { ...base });

/** The honest queue sentence when no card is currently offered ("waiting" is a state, not an error). */
export function noCardText(engine, cards) {
  const need = vramNeedMiB(engine);
  const who = { hunyuan: 'Hunyuan3D/SDXL', triposg: 'TripoSG', pixal3d: 'Pixal3D' }[engine] || engine;
  if (!cards?.length) return `${who} wants a GPU with at least ${need} MiB free - no card was detected here.`;
  return `${who} waits for a GPU with at least ${need} MiB free - every card is busy or too small (${cards.map((c) => `${c.name || c.index}: ${c.freeMiB ?? '?'} MiB free`).join('; ')}).`;
}
