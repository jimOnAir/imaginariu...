// The language switch of ticket 27. The repo tests UI the established way: the logic layer under
// real DOM stubs (the click handlers ARE setLang from the i18n layer) plus structural assertions
// on the component source (there is no JSX-capable test loader in this stack, same pattern as
// tests/shell-theme.test.mjs asserting index.html's pre-paint contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const memStorage = (init = {}) => ({ data: { ...init }, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); } });

globalThis.window = { localStorage: memStorage() };
globalThis.document = { documentElement: { lang: 'en' } };
const i18n = await import('../src/i18n/index.js');

test('what a click does: <html lang> flips, the labels flip, listeners re-render, the pick persists', () => {
  let renders = 0;
  const off = i18n.subscribeLang(() => renders++);
  try {
    i18n.setLang('en');
    assert.equal(globalThis.document.documentElement.lang, 'en');
    assert.equal(i18n.t('app.appearance.title'), 'Appearance');
    i18n.setLang('ru');                                    // the body of the RU button: onClick={() => setLang(l.id)}
    assert.equal(i18n.getLang(), 'ru');
    assert.equal(globalThis.document.documentElement.lang, 'ru', '<html lang> flipped with the click');
    assert.equal(i18n.t('app.appearance.title'), 'Внешний вид', 'every label answers in the new language');
    assert.equal(i18n.t('lang.switch'), 'Язык интерфейса', 'even the switch describes itself in Russian');
    assert.equal(globalThis.window.localStorage.getItem('imaginarium.lang'), 'ru', 'remembered (only picks are - ticket 26)');
    assert.equal(renders, 1, 'the one real switch re-rendered subscribers live, no reload');   // setLang('en') first was a no-op: same language
    i18n.setLang('en');
    assert.equal(renders, 2, 'and switching back fires it again');
  } finally { off(); }
});

test('the component: named LangSwitch, both languages pressed through aria, one handler per id', () => {
  const controls = readFileSync(path.join(ROOT, 'src', 'shell', 'Controls.jsx'), 'utf8');
  const body = /export function LangSwitch\(\) \{[\s\S]*?\n\}/.exec(controls);
  assert.ok(body, 'Controls.jsx exports LangSwitch');
  assert.match(body[0], /useLang\(\)/, 'it follows the layer (re-renders on a switch)');
  assert.match(body[0], /LANGS\.map/, 'both languages from the one table');
  assert.match(body[0], /aria-pressed=\{lang === l\.id \? 'active' : ''\}[\s\S]*onClick=\{\(\) => setLang\(l\.id\)\}|aria-pressed[^}]*\}[\s\S]*onClick=\{\(\) => setLang\(l\.id\)\}/, 'pressed state + the setLang click');
  assert.match(body[0], /role="group" aria-label=\{t\('lang\.switch'\)\}/, 'accessible group in the current language');
});

// Ticket 50 (0.7.9 fold wave): switching language re-reads the Components list. It does because
// App itself subscribes (useLang at its top) so every panel under it re-renders, and the panel
// owns no label outside t() - the scan-core rows ride the EN display policy of the installer.
test('the Components window speaks in keys and re-renders with the language', () => {
  const app = readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  assert.match(app, /useT\(\),lang=useLang\(\)/, 'App subscribes to the language at its top: the whole panel tree re-reads');
  assert.match(app, /<ComponentsPanel/, 'Components is a panel under App (so it re-renders with the switch)');
  const panel = readFileSync(path.join(ROOT, 'src', 'ComponentsPanel.jsx'), 'utf8');
  // Slice from the JSX return first: collapsing the WHOLE file deletes the component body as one
  // brace region (the fresh-context audit of ticket 50 caught that vacuous shape), so the scan
  // starts where the JSX starts. Then collapse every {...} expression slot (nested: until stable)
  // - what can remain between > and < is a raw text node, and a raw text node is a straggler.
  const start = panel.search(/\breturn\s*[([{<]/);
  assert.ok(start >= 0, 'the panel has a JSX return');
  let jsx = panel.slice(start).replace(/=>/g, '    ');
  for (;;) { const n = jsx.replace(/\{[^{}]*\}/g, ''); if (n === jsx) break; jsx = n; }
  // prose never carries these; a > ... < gap that does is JS code between an arrow and the next
  // element, not a text node - and a real straggler ("<p>Some raw text</p>") is pure words.
  const texts = [...jsx.matchAll(/>([^<>]+)</g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((x) => x && /[A-Za-zА-Я]/.test(x) && !/[;{}[\]=&|]/.test(x) && !/^\s*(\/\/|\/\*|\*)/.test(x));
  assert.deepEqual(texts, [], 'no raw JSX text nodes: every display string is a t() key (the scan-core rows are policy EN)');
});

test('both surfaces exist and share the component: the header and Settings → Appearance', () => {
  const app = readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  assert.match(app, /<ThemeSwitch\/><ModeSwitch\/><LangSwitch\/>/, 'the header renders <LangSwitch/> beside the theme switch');
  assert.match(app, /appearance-card[\s\S]*?shell\.theme\.title[\s\S]*?<ThemeSwitch\/>[\s\S]*?lang\.switch[\s\S]*?<LangSwitch\/>/,
    'Settings gains the Appearance card: the theme picker first, then the language chooser');
  assert.ok(!/LANGS\.map/.test(app), 'no hand-rolled switch survives beside the component');
  const en = readFileSync(path.join(ROOT, 'src', 'i18n', 'en.js'), 'utf8');
  const ru = readFileSync(path.join(ROOT, 'src', 'i18n', 'ru.js'), 'utf8');
  for (const [src, needle] of [[en, '"app.appearance.title": "Appearance"'], [ru, '"app.appearance.title": "Внешний вид"']]) assert.ok(src.includes(needle), needle);
});
