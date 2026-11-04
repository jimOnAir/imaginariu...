// React wiring of the theme and mode stores (ticket 04): reads the browser reality, notifies
// subscribers on change, follows OS flips while the preference is 'system'. The pure decision
// logic lives in theme.js/mode.js (unit-tested without a browser); this module is browser-only.
import { useSyncExternalStore } from 'react';
import { THEME_PREFS, readThemePref, saveThemePref, resolveTheme, applyTheme } from './theme.js';
import { MODES, readMode, saveMode } from './mode.js';

const systemDark = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;

let themePref = readThemePref();
let themeListeners = [];
const emitTheme = () => themeListeners.forEach((f) => f());
const subscribeTheme = (fn) => { themeListeners.push(fn); return () => { themeListeners = themeListeners.filter((f) => f !== fn); }; };
globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
  if (themePref === 'system') { applyTheme(document, resolveTheme('system', systemDark())); emitTheme(); }
});
applyTheme(document, resolveTheme(themePref, systemDark())); // idempotent with the pre-paint script

export function useTheme() {
  const pref = useSyncExternalStore(subscribeTheme, () => themePref, () => themePref);
  const set = (next) => {
    if (!THEME_PREFS.includes(next)) return;
    themePref = next;
    saveThemePref(next);
    applyTheme(document, resolveTheme(next, systemDark()));
    emitTheme();
  };
  return { pref, resolved: resolveTheme(themePref, systemDark()), set };
}

let modePref = readMode();
let modeListeners = [];
const emitMode = () => modeListeners.forEach((f) => f());
const subscribeMode = (fn) => { modeListeners.push(fn); return () => { modeListeners = modeListeners.filter((f) => f !== fn); }; };

export function useMode() {
  const mode = useSyncExternalStore(subscribeMode, () => modePref, () => modePref);
  const set = (next) => {
    if (!MODES.includes(next)) return;
    modePref = next;
    saveMode(next);
    emitMode();
  };
  return { mode, set };
}
