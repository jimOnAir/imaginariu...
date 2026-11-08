// The Hybrid UI top-bar controls (ticket 04): a theme switch (dark / light / follow-system) and
// a view-mode switch (Simple / Detailed). Both persist through src/shell/hooks.js and speak the
// branch's i18n mechanism.
import React from 'react';
import { Moon, Sun, Monitor, AlignJustify, SlidersHorizontal } from 'lucide-react';
import { useT, useLang, setLang, LANGS } from '../i18n/index.js';
import { useTheme, useMode } from './hooks.js';
import './shell.css';

export function ThemeSwitch() {
  const t = useT();
  const { pref, set } = useTheme();
  return <div className="shell-switch" role="group" aria-label={t('shell.theme.title')}>
    {[['dark', Moon], ['light', Sun], ['system', Monitor]].map(([id, Icon]) => <button key={id} type="button"
      className={pref === id ? 'active' : ''} aria-pressed={pref === id} aria-label={t('shell.theme.' + id)} title={t('shell.theme.' + id)}
      onClick={() => set(id)}><Icon size={13} /></button>)}
  </div>;
}

/**
 * The interface-language switch (ticket 27): EN / RU buttons in the header, next to the theme
 * control, and the same component reused as the Settings → Appearance chooser. It speaks the
 * branch's i18n layer directly (astra.lang persists through setLang), so both places always show
 * the same truth; the OS default (ticket 26) only ever decides the very first start.
 */
export function LangSwitch() {
  const t = useT();
  const lang = useLang();
  return <div className="lang-switch" role="group" aria-label={t('lang.switch')} title={t('lang.switch')}>
    {LANGS.map((l) => <button key={l.id} type="button" className={lang === l.id ? 'active' : ''} aria-pressed={lang === l.id}
      aria-label={t('lang.' + l.id)} title={t('lang.' + l.id)} onClick={() => setLang(l.id)}>{l.label}</button>)}
  </div>;
}

export function ModeSwitch() {
  const t = useT();
  const { mode, set } = useMode();
  return <div className="shell-switch mode-switch" role="group" aria-label={t('shell.mode.title')}>
    {[['simple', AlignJustify], ['detailed', SlidersHorizontal]].map(([id, Icon]) => <button key={id} type="button"
      className={mode === id ? 'active' : ''} aria-pressed={mode === id} aria-label={t('shell.mode.' + id)} title={t('shell.mode.' + id)}
      onClick={() => set(id)}><Icon size={13} /><span className="mode-label">{t('shell.mode.' + id)}</span></button>)}
  </div>;
}
