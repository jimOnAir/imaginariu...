// The Hybrid UI top-bar controls (ticket 04): a theme switch (dark / light / follow-system) and
// a view-mode switch (Simple / Detailed). Both persist through src/shell/hooks.js and speak the
// branch's i18n mechanism.
import React from 'react';
import { Moon, Sun, Monitor, AlignJustify, SlidersHorizontal } from 'lucide-react';
import { useT } from '../i18n/index.js';
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

export function ModeSwitch() {
  const t = useT();
  const { mode, set } = useMode();
  return <div className="shell-switch mode-switch" role="group" aria-label={t('shell.mode.title')}>
    {[['simple', AlignJustify], ['detailed', SlidersHorizontal]].map(([id, Icon]) => <button key={id} type="button"
      className={mode === id ? 'active' : ''} aria-pressed={mode === id} aria-label={t('shell.mode.' + id)} title={t('shell.mode.' + id)}
      onClick={() => set(id)}><Icon size={13} /><span className="mode-label">{t('shell.mode.' + id)}</span></button>)}
  </div>;
}
