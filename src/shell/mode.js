// The Hybrid UI view modes (behavior per ADR-0004, ticket 04): "Simple" (the default) shows the
// everyday surface of the studio; "Detailed" additionally reveals the rare settings (advanced
// generation options), the game export profiles and the keyboard-shortcut surfaces. The choice
// persists under 'astra.mode'. Pure functions here; the visibility decisions are a data map
// (REVEALED_IN_DETAILED) so a test pins exactly which surfaces the mode controls.
export const MODES = ['simple', 'detailed'];
export const MODE_KEY = 'astra.mode';
const DEFAULT_MODE = 'simple';

// the ids of surfaces only the Detailed mode reveals
export const REVEALED_IN_DETAILED = ['advanced-generation', 'game-export-profiles', 'keyboard-shortcuts'];
export const isRevealed = (mode, surface) => mode !== 'detailed' ? !REVEALED_IN_DETAILED.includes(surface) : true;

export function readMode(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(MODE_KEY);
    return MODES.includes(v) ? v : DEFAULT_MODE;
  } catch { return DEFAULT_MODE; }
}

export function saveMode(mode, storage = globalThis.localStorage) {
  try { storage?.setItem(MODE_KEY, mode); } catch { /* private mode: the choice lives for the session only */ }
}
