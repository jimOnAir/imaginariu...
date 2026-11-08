// One place answers "which card, how much VRAM, which driver" (0.6.10 wave ticket 20, the Linux
// twin of the 0.6.8 NVIDIA-driver gate). Upstream's problem class: Pixal3D on a machine with an
// ancient driver died mid-run (Windows crash-code signature 3221225477); the fix shape is to know
// the driver BEFORE spawning anything and to refuse up front with an actionable sentence. The
// floor below is the interface fact (570 - the driver branch that ships working Blackwell support
// on Linux too); the wording is this branch's.
//
// Seam style as everywhere in this wave: ASTRA_DRIVER_VERSION overrides the reading (and
// ASTRA_VRAM_MIB still overrides the size where the reader is shared), spawnFn injects the probe.
import { spawnSync } from 'node:child_process';

export const MIN_NVIDIA_DRIVER = 570;

const QUERY = ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'];

// module cache: every status call would otherwise spawn nvidia-smi again (a fresh studio polled
// this every few seconds); refresh:true forces a re-read, resetGpuInfo() clears the cache.
let cache = null;

/** The first integer of a driver version string ('615.71.09' -> 615, '570.86.16' -> 570). */
export function driverMajor(driverVersion) {
  const m = /^(\d+)/.exec(String(driverVersion || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * Read the card once: {name, vramMiB, driverVersion, driverMajor} or null when nvidia-smi does
 * not answer (no NVIDIA card here - the callers treat that as "not our problem to gate").
 * ASTRA_DRIVER_VERSION fakes the driver for tests and odd setups (the probe is still tried for
 * name/size unless ASTRA_VRAM_MIB also pins the size).
 */
export function gpuInfo({ appRoot = null, env = process.env, refresh = false, spawnFn = spawnSync } = {}) {
  void appRoot;   // parity with the interface signature; the cache here is in-memory
  if (cache && !refresh && env === process.env) return cache;
  let name = null, vramMiB = null, driverVersion = null;
  try {
    const out = spawnFn('nvidia-smi', QUERY, { encoding: 'utf8', timeout: 8000 });
    const line = String(out?.stdout || '').trim().split('\n')[0] || '';
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length >= 3 && parts[0]) {
      name = parts[0];
      const v = Number(parts[1]);
      vramMiB = Number.isFinite(v) && v > 0 ? v : null;
      driverVersion = parts[2] || null;
    }
  } catch { /* no nvidia-smi: fall through to nulls */ }
  if (env.ASTRA_DRIVER_VERSION) driverVersion = String(env.ASTRA_DRIVER_VERSION);
  const seam = Number(env.ASTRA_VRAM_MIB);
  if (Number.isFinite(seam) && seam > 0) vramMiB = seam;
  const info = name || driverVersion || vramMiB
    ? { name, vramMiB, driverVersion, driverMajor: driverMajor(driverVersion) }
    : null;
  if (env === process.env) cache = info;
  return info;
}

export function resetGpuInfo() { cache = null; }

/**
 * The up-front refusal sentence when the driver is below the floor, or null when it is fine or
 * unknown (an unknown driver must never be refused - `what` names the feature being gated).
 * `card` is a gpuInfo() result or any object with a driverVersion/driverMajor.
 */
export function oldDriverText(card, what = 'This engine') {
  const major = card && Number.isFinite(card.driverMajor) ? card.driverMajor : driverMajor(card?.driverVersion);
  if (major === null || major >= MIN_NVIDIA_DRIVER) return null;
  return `${what} needs NVIDIA driver ${MIN_NVIDIA_DRIVER} or newer - this machine reports ${card.driverVersion || major}. Update the driver and start again; nothing was downloaded or run.`;
}
