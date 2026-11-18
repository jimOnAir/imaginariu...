// Ticket 37 (Windows 0.6.15: the 8 GB card release - RTX 5060, 4060, 3070). One seam answers
// "is this a small card" for the views and the GPU hand-over; every surface that adapts reads
// the SAME fact. Their server/low-vram.mjs is quarantined payload - this module is the branch's
// own: the threshold is the branch's EXISTING 8 GB seam - server/triposg.mjs's
// TRIPOSG_AUTO_MAX_VRAM_MIB (9216, compared strictly-below here) - so the installer's "Full skips what does not fit" and the engine's
// 512 px / unload decisions can never disagree. Unknown VRAM is NOT small (ticket 33's honesty),
// and the IMAGINARIUM_VRAM_MIB seam of gpu-info.mjs (ticket 21) overrides the probe for tests.
import { gpuInfo } from './gpu-info.mjs';
import { TRIPOSG_AUTO_MAX_VRAM_MIB } from './triposg.mjs';

// Not a new number: the branch's own 8 GB seam, imported so it cannot drift (that constant is
// compared with <= in triposg.mjs for its own auto-choice; THIS seam is exclusive - below the
// ceiling - matching the installer's `-lt 9216` checklist rule, so 9216 MiB cards are "big"
// for both surfaces).
export const LOW_VRAM_CEILING_MIB = TRIPOSG_AUTO_MAX_VRAM_MIB;
export const MVA_MAX_WAIT_MS = 20 * 60 * 1000; // 0.6.15: "wait capped at 20 minutes" on 8 GB

export function isLowVram(vramMib) {
  const v = Number(vramMib);
  return Number.isFinite(v) && v > 0 && v < LOW_VRAM_CEILING_MIB;
}

/** VRAM of this machine in MiB through the gpu-info probe (null = unknown = not small). */
export function currentVramMib(opts = {}) {
  try { return gpuInfo(opts)?.vramMiB ?? null; } catch { return null; }
}

// Ticket 44 (views fp8 tier): the node streams the UNet as fp8 on NVIDIA cards up to
// IMAGINARIUM_VIEWS_FP8_MAX_MIB (default 16384 — the node's own gate, astra_views._fp8_tier).
// gpu-info only answers for NVIDIA (null on AMD/none), so a finite number here mirrors the
// node's vendor check; unknown VRAM keeps the fp16 semantics (ticket 33's honesty).
export const FP8_STEP_MAX_MS = 10 * 60 * 1000;
export function viewsFp8Tier(vramMib) {
  const mode = (process.env.IMAGINARIUM_VIEWS_FP8 || 'auto').trim().toLowerCase();
  if (mode === '0' || mode === 'off' || mode === 'no') return false;
  const maxMib = Math.max(0, Number(process.env.IMAGINARIUM_VIEWS_FP8_MAX_MIB ?? 16384) || 0);
  const v = Number(vramMib);
  return Number.isFinite(v) && v > 0 && (maxMib <= 0 || v <= maxMib);
}
