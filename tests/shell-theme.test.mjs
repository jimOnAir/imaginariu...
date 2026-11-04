// Theme layer of the Hybrid UI (ticket 04): preference storage, system resolution, the DOM
// attribute and meta update, and the pre-paint guarantee of index.html (the stored choice is set
// on <html> before any stylesheet runs - no flash of the wrong theme).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_PREFS, THEME_KEY, readThemePref, saveThemePref, resolveTheme, applyTheme } from '../src/shell/theme.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memStorage = (init = {}) => ({ data: { ...init }, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); } });

test('the default theme preference is dark, invalid stored values fall back to it', () => {
  assert.equal(THEME_PREFS.join(','), 'dark,light,system');
  assert.equal(readThemePref(memStorage()), 'dark');
  assert.equal(readThemePref(memStorage({ [THEME_KEY]: 'sepia' })), 'dark');
  assert.equal(readThemePref(undefined), 'dark', 'no storage at all (SSR/tests) is still dark');
});

test('the choice persists under astra.theme and reads back', () => {
  const s = memStorage();
  saveThemePref('light', s);
  assert.equal(s.data[THEME_KEY], 'light');
  assert.equal(readThemePref(s), 'light');
});

test('system preference resolves to the real theme; explicit prefs pass through', () => {
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('applyTheme writes data-theme to the document root and tunes the theme-color meta', () => {
  let attr = null, meta = null;
  const doc = { documentElement: { setAttribute: (k, v) => { if (k === 'data-theme') attr = v; } }, querySelector: () => ({ setAttribute: (k, v) => { if (k === 'content') meta = v; } }) };
  applyTheme(doc, 'light');
  assert.equal(attr, 'light');
  assert.match(meta, /^#/);
  applyTheme(doc, 'dark');
  assert.equal(attr, 'dark');
});

test('index.html applies the stored theme before first paint; main.jsx loads the palette first', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(html.indexOf('<script>') < html.indexOf('<title>'), 'the theme script runs before the body and styles');
  assert.match(script, /localStorage\.getItem\('astra\.theme'\)/);
  assert.match(script, /data-theme/);
  assert.match(script, /prefers-color-scheme: dark/);
  const main = readFileSync(path.join(ROOT, 'src', 'main.jsx'), 'utf8');
  assert.ok(main.indexOf("import './palette.css'") < main.indexOf("import './style.css'"), 'palette tokens load before the stylesheets that use them');
});
