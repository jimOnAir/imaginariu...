// Locale (0.6.10 wave ticket 26): what the machine's environment says, what the server answers,
// and the rule that a user pick outranks the OS - pinned at the client layer with a localStorage
// stub, and at the route through the same shape the app mounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osLang, localeInfo, registerLocale, LANG_DEFAULT } from '../server/locale.mjs';

test('osLang: the LC_ALL > LC_MESSAGES > LANG chain, ru only when it says ru', () => {
  assert.equal(osLang({ env: { LANG: 'ru_RU.UTF-8' } }).lang, 'ru');
  assert.equal(osLang({ env: { LANG: 'ru' } }).lang, 'ru');
  assert.equal(osLang({ env: { LANG: 'RU_ru.UTF-8' } }).lang, 'ru', 'case is the OS\'s business');
  assert.equal(osLang({ env: { LANG: 'en_US.UTF-8' } }).lang, 'en');
  assert.equal(osLang({ env: { LANG: 'de_DE.UTF-8' } }).lang, 'en', 'everything not-Russian is English here');
  assert.equal(osLang({ env: { LANG: 'sr@latin' } }).lang, 'en');
  assert.equal(osLang({ env: {} }).lang, 'en', 'silence is English (the dictionary fallback)');
  assert.equal(osLang({ env: { LANG: '' } }).lang, 'en');
  assert.equal(osLang({ env: { LANG: 'C' } }).lang, 'en', 'the default container locale is not a statement');
  assert.equal(osLang({ env: { LANG: 'POSIX' } }).lang, 'en');
  assert.equal(osLang({ env: { LANG: 'POSIX', LC_MESSAGES: 'ru_RU.UTF-8' } }).lang, 'ru', 'a real LC wins over C');
  assert.equal(osLang({ env: { LANG: 'ru_RU.UTF-8', LC_MESSAGES: 'en_US.UTF-8' } }).lang, 'en', 'LC_MESSAGES outranks LANG');
  assert.equal(osLang({ env: { LC_ALL: 'ru_RU.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'de_DE' } }).lang, 'ru', 'LC_ALL outranks everything');
  assert.deepEqual(osLang({ env: { LANG: 'ru_RU.UTF-8' } }), { lang: 'ru', source: 'LANG', raw: 'ru_RU.UTF-8' }, 'what it read rides along');
  assert.equal(LANG_DEFAULT, 'en');
});

test('localeInfo / GET /api/locale: the answer shape and the route wiring', async () => {
  assert.deepEqual(localeInfo({ env: { LC_MESSAGES: 'ru_RU.UTF-8', LANG: 'C' } }), { lang: 'ru', source: 'LC_MESSAGES', osValue: 'ru_RU.UTF-8' });
  assert.deepEqual(localeInfo({ env: {} }), { lang: 'en', source: 'default', osValue: '' });
  const routes = {};
  registerLocale({ get: (p, h) => { routes[p] = h; } }, (fn) => fn);
  const body = {};
  await routes['/api/locale']({}, { json: (v) => Object.assign(body, v) });
  assert.equal(body.lang, 'en');   // the test runner's own environment is not Russian; a dev box could be
  assert.ok(['en', 'ru'].includes(body.lang));
  assert.ok(typeof body.source === 'string' && typeof body.osValue === 'string');
});

// ---------------------------------------------------------------- the client rule: pick > OS
test('the i18n layer: the OS default applies only while nothing is stored, and is never stored', async () => {
  const store = new Map();
  globalThis.window = { localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  } };
  globalThis.document = { documentElement: { lang: '' } };
  const i18n = await import('../src/i18n/index.js');
  try {
    assert.equal(i18n.hasStoredLang(), false);
    i18n.applyOsLang('ru');
    assert.equal(i18n.getLang(), 'ru', 'first paint speaks the machine');
    assert.equal(store.has('astra.lang'), false, 'the detection is not a pick');
    assert.equal(globalThis.document.documentElement.lang, 'ru', '<html lang> follows');
    i18n.setLang('en');                                   // the user chooses
    assert.equal(store.get('astra.lang'), 'en');
    i18n.applyOsLang('ru');
    assert.equal(i18n.getLang(), 'en', 'the pick outranks the OS, forever after');
    assert.equal(store.get('astra.lang'), 'en');
    assert.match(i18n.t('app.save'), /./);                // dictionaries answer in the picked language
  } finally { delete globalThis.window; delete globalThis.document; }
});
