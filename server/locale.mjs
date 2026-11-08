// Where the studio's language comes from before anybody clicked anything (0.6.10 wave ticket 26).
// Upstream reads the OS culture from the Windows registry; the Linux shape is the environment
// chain LC_ALL -> LC_MESSAGES -> LANG (POSIX precedence): a value starting with `ru` means
// Russian, anything else - English. The USER's pick (the astra.lang localStorage key, contract
// unchanged) always outranks this: the server only answers what the OS says, the client applies
// it when nothing is stored. GET /api/locale is that answer - for the no-browser first paint and
// for anything scripted that wants to speak the machine's language.
export const LANG_DEFAULT = 'en';

/**
 * 'ru' or 'en' from the environment, with what it read: { lang, source, raw }.
 * 'C'/'POSIX' and empty values are "the OS is not saying" - they fall through the chain, and the
 * whole chain silent means English (the branch's fallback, same as the dictionary default).
 */
export function osLang({ env = process.env } = {}) {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = String(env[name] || '').trim();
    if (!raw || raw === 'C' || raw === 'POSIX') continue;
    const m = /^([A-Za-z]{2,})/.exec(raw);                 // the primary subtag of ru_RU.UTF-8, sr@latin, ...
    if (!m) continue;
    const lang = m[1].toLowerCase() === 'ru' ? 'ru' : LANG_DEFAULT;
    return { lang, source: name, raw };
  }
  return { lang: LANG_DEFAULT, source: '', raw: '' };
}

/** The GET /api/locale answer shape (kept in one place so tests and route never disagree). */
export function localeInfo({ env = process.env } = {}) {
  const { lang, source, raw } = osLang({ env });
  return { lang, source: source || 'default', osValue: raw };
}

/** Route registration, same shape as registerComponents (index.mjs owns asyncRoute). */
export function registerLocale(app, asyncRoute) {
  app.get('/api/locale', asyncRoute(async (_req, res) => res.json(localeInfo())));
}
