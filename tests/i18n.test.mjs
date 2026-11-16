// UI dictionaries (src/i18n): same keys in en and ru, same placeholders, no hard-coded Cyrillic in src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../src/i18n/en.js';
import ru from '../src/i18n/ru.js';
import { t, tOr, hasT, getLang, setLang } from '../src/i18n/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const placeholders = (v) => {
  const text = typeof v === 'object' ? Object.values(v).join(' ') : String(v);
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
};

test('i18n: en and ru have identical key sets', () => {
  const a = Object.keys(en).sort();
  const b = Object.keys(ru).sort();
  assert.deepEqual(a.filter((k) => !(k in ru)), [], 'keys missing in ru.js');
  assert.deepEqual(b.filter((k) => !(k in en)), [], 'keys missing in en.js');
  assert.ok(a.length > 100, `only ${a.length} keys`);
});

test('i18n: entries are non-empty strings or plural objects with the same placeholders', () => {
  for (const [key, v] of Object.entries(en)) {
    for (const [name, dict] of [['en', en], ['ru', ru]]) {
      const e = dict[key];
      if (typeof e === 'object') {
        assert.ok(e && typeof e.other === 'string' && e.other, `${name}:${key} plural needs "other"`);
      } else {
        assert.equal(typeof e, 'string', `${name}:${key}`);
        assert.ok(e.length > 0 || v === '', `${name}:${key} is empty`);
      }
    }
    assert.deepEqual(placeholders(ru[key]), placeholders(v), `placeholders differ: ${key}`);
  }
});

test('i18n: English entries contain no Cyrillic', () => {
  for (const [key, v] of Object.entries(en)) {
    const text = typeof v === 'object' ? Object.values(v).join(' ') : v;
    assert.doesNotMatch(text, /[Ѐ-ӿ]/, key);
  }
});

test('i18n: t() interpolates, falls back to English, then to the key; plurals; tOr', () => {
  const before = getLang();
  try {
    setLang('en');
    assert.equal(t('lang.ru'), 'Russian');
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.equal(tOr('no.such.key', 'Server label'), 'Server label');
    assert.equal(hasT('lang.ru'), true);
    setLang('ru');
    assert.equal(getLang(), 'ru');
    assert.equal(t('lang.ru'), 'Русский');
    setLang('xx');
    assert.equal(getLang(), 'ru', 'unknown languages are ignored');
  } finally {
    setLang(before);
  }
});

// Files that may contain Cyrillic, with the reason. Keep this list short.
const CYRILLIC_WHITELIST = new Map([
  ['src/i18n/ru.js', 'the Russian dictionary'],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('i18n: no .js/.jsx file under src/ contains Cyrillic outside the Russian dictionary', () => {
  const offenders = [];
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (CYRILLIC_WHITELIST.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/[Ѐ-ӿ]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], `Cyrillic outside src/i18n/ru.js:\n${offenders.slice(0, 40).join('\n')}`);
});

// The language policy of the installer surfaces, recorded by 0.7.9 fold wave ticket 50: the
// scan core, the install log and the components bridge are EN-ALWAYS, not studio-language.
// The reasons are structural: install.sh runs standalone before the studio or its language
// setting exist, its log gets pasted into bug reports across languages, and the ##ITEM rows
// are a machine contract (the 0.4.16 Setup.cs parser shape). Inside the app every label the
// branch owns goes through t(); the scan rows ride the EN policy on purpose. Cyrillic is
// allowed in COMMENTS only (the «новое, проба» policy notes) - a display string in these
// files is exactly the straggler this guard catches.
const EN_DISPLAY_SURFACES = [
  ['installer/af_scan.mjs', 'js'],
  ['installer/install.sh', 'sh'],
  ['server/components.mjs', 'js'],
];
test('i18n: the installer and component surfaces keep Cyrillic inside comments (EN display policy)', () => {
  const offenders = [];
  for (const [rel, kind] of EN_DISPLAY_SURFACES) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const cyr = line.search(/[Ѐ-ӿ]/);
      if (cyr < 0) return;
      const cmt = kind === 'sh' ? line.search(/(^|\s)#/) : line.indexOf('//');
      if (cmt < 0 || cyr < cmt) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], `Cyrillic outside a comment on an EN-display surface:\n${offenders.join('\n')}`);
});
