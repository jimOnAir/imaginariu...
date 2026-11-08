// The "Studio components" checklist (server/components.mjs): what of the programs and models is
// installed and at which version, what is missing or outdated; the ticked part downloads into the
// application folder in the background while the user keeps working. The same list the installer's
// "What to install" step shows (installer/af_scan.mjs).
import React, { useState, useEffect, useRef } from 'react';
import { Download, Loader2, RefreshCw, Check } from 'lucide-react';
import { api } from './api.js';
import { useT, t } from './i18n/index.js';

// install order: dependencies before the components that need them (the installer takes -Only in this order)
const ORDER = ['node', 'npm', 'blender', 'comfy', 'comfydeps', 'hy2', 'u2net', 'hymv', 'hy21', 'sdxl', 'mvadapter',
  'godot', 'clips', 'vfx', 'ollama', 'llm', 'vlm', 'pixal3d', 'pixal3dw', 'flux2', 'qwenimg'];
const PRESETS = [['q', 'quick'], ['f', 'full'], ['l', 'lite']];
const gb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');
const todo = (c) => c.status === 'missing' || c.status === 'outdated';
function statusText(c) {
  if (c.status === 'installed') return t('components.st.installed') + (c.have ? ' · ' + c.have : '');
  if (c.status === 'outdated') return t('components.st.outdated') + (c.have ? ' · ' + c.have : '') + (c.need ? ' → ' + c.need : '');
  if (c.status === 'unavailable') return c.note || t('components.st.unavailable');
  return t('components.st.missing') + (c.need ? ' ' + c.need : '');
}

export default function ComponentsPanel({ notify, onDone }) {
  useT();
  const [scan, setScan] = useState(null);
  const [job, setJob] = useState(null);
  const [checked, setChecked] = useState({});
  const [preset, setPreset] = useState('full');
  const [busy, setBusy] = useState(true);
  const [foreign, setForeign] = useState(false);   // an installer this studio did not start (ticket 24)
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const applyPreset = (items, p) => {
    const letter = PRESETS.find((x) => x[1] === p)?.[0] || 'f';
    setPreset(p);
    setChecked(Object.fromEntries(items.map((c) => [c.id, todo(c) && c.presets.includes(letter)])));
  };
  const rescan = async () => {
    setBusy(true); setError(null);
    try { const s = await api('/components/scan', { method: 'POST' }); setScan(s); applyPreset(s.items, s.profile || 'full'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const poll = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const s = await api('/components');
        setJob(s.job); setForeign(!!s.busy);
        if ((s.job && s.job.code == null) || s.busy) poll();   // follow a run, ours or somebody else's
        else if (s.job) onJobEnd(s.job);
      } catch { poll(); }
    }, 1500);
  };
  const onJobEnd = (j) => {
    if (j.code === 0) { notify(t('components.notify.installed')); void rescan(); }
    else notify(t('components.notify.partial', { failed: j.failed?.join(', ') || t('components.notify.log') }), true);
  };
  useEffect(() => {
    (async () => {
      try {
        const s = await api('/components');
        setForeign(!!s.busy);
        if (s.job) setJob(s.job);   // a run from before this window opened (re-attach, ticket 24) is shown as it stands
        if ((s.job && s.job.code == null) || s.busy) poll();
      } catch { /* the first open may be the only one */ }
      await rescan();
    })();
    return () => clearTimeout(timer.current);
  }, []);

  const items = scan?.items || [];
  const toggle = (c) => {
    if (c.status === 'unavailable') return;
    setChecked((v) => {
      const on = !v[c.id];
      const n = { ...v, [c.id]: on };
      if (on) for (const d of c.deps) {          // ticking a row pulls in what it needs
        const dc = items.find((x) => x.id === d);
        if (dc && todo(dc)) n[d] = true;
      }
      return n;
    });
  };
  const picked = items.filter((c) => checked[c.id]);
  const total = picked.reduce((s, c) => s + (c.size || 0), 0);
  const install = async () => {
    const ix = (x) => { const i = ORDER.indexOf(x); return i < 0 ? 99 : i; };
    const ids = [...new Set(picked.flatMap((c) => c.only))].sort((a, b) => ix(a) - ix(b));
    setBusy(true);
    try {
      const s = await api('/components/install', { method: 'POST', body: JSON.stringify({ ids, profile: preset }) });
      setJob(s.job); poll();
      notify(t('components.notify.started', { count: picked.length }));
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const later = async () => { try { await api('/components/dismiss', { method: 'POST' }); } catch { /* the window reopens on the next version anyway */ } onDone?.(); };

  const running = job && job.code == null;
  const groups = [...new Set(items.map((c) => c.group))];
  return <div className="comp-panel">
    <p className="field-note">{t('components.lead')}</p>
    {running && <div className="comp-job"><Loader2 className="spin" size={14} /><span>{job.text} — {job.progress}%</span><div className="comp-bar"><i style={{ width: job.progress + '%' }} /></div></div>}
    {running && job.external && <p className="field-note"><Download size={12} /> {t('components.job.reattached')}</p>}
    {foreign && !running && <p className="field-note"><Loader2 className="spin" size={12} /> {t('components.foreign')}</p>}
    {job && !running && job.external && job.code === -1 && <p className="field-note views-warn">{t('components.job.lost')}</p>}
    {job && job.code === 0 && !running && <p className="field-note"><Check size={12} /> {t('components.installed', { ids: job.ids.join(', ') })}</p>}
    {error && <p className="field-note views-warn">{error}</p>}
    {busy && !scan && <p className="field-note"><Loader2 className="spin" size={12} /> {t('components.checking')}</p>}
    {scan && <div className="comp-list">{groups.map((g) => <div key={g}>
      <div className="comp-group">{g}</div>
      {items.filter((c) => c.group === g).map((c) => <label key={c.id} className={'comp-row ' + c.status}
        title={[c.name, c.license && t('components.license', { license: c.license }), c.have && t('components.found', { have: c.have }), c.note].filter(Boolean).join('\n')}>
        <input type="checkbox" checked={!!checked[c.id]} disabled={running || c.status === 'unavailable'} onChange={() => toggle(c)} />
        <span className="comp-name">{c.name}{c.exp && <em className="comp-exp">{t('components.exp')}</em>}</span><span className="comp-state">{statusText(c)}</span>
        <span className="comp-size">{c.status === 'installed' || c.status === 'unavailable' || !c.size ? '' : gb(c.size)}</span>
      </label>)}
    </div>)}</div>}
    {scan && <div className="comp-presets">{PRESETS.map(([, id]) => <label key={id}>
      <input type="radio" name="comp-preset" checked={preset === id} disabled={running} onChange={() => applyPreset(items, id)} />
      {t('components.preset.' + id)}
    </label>)}</div>}
    {scan && <p className="field-note">{picked.length ? t('components.footer.download', { size: gb(total), count: picked.length }) : t('components.footer.none')}</p>}
    <div className="about-actions">
      <button type="button" className="primary small" disabled={busy || running || foreign || !picked.length} onClick={install}><Download size={14} />{t('components.installSelected')}</button>
      <button type="button" className="secondary small" disabled={busy || running || foreign} onClick={rescan}><RefreshCw size={14} />{t('components.recheck')}</button>
      <button type="button" className="secondary small" onClick={later}>{running ? t('components.laterRunning') : t('components.later')}</button>
    </div>
  </div>;
}
