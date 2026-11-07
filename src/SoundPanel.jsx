// The "Sound" tab: sound effects from a description (MOSS-SoundEffect v2.0) and seamless music
// loops for games (ACE-Step 1.5), both local in runtime/sound. The library keeps WAV + OGG pairs;
// removing a sound moves it to the trash folder, the studio never destroys one. Sounds bind to
// per-object game events (footsteps, impact, spell...). Details: docs/product/sound.md.
import React, {useState, useEffect, useRef} from 'react';
import {Loader2, Play, Pause, Trash2, RefreshCw, Link2, Unlink, Volume2, Music, Ban, AlertTriangle} from 'lucide-react';
import {api} from './api.js';
import {t, useT, hasT} from './i18n/index.js';
import './sound.css';

const nameOfEvent = (id) => { const key = `sound.event.${id}`; return hasT(key) ? t(key) : id; };

export default function SoundPanel({snapshot, notify}) {
  const t = useT();
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState('sfx');
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState(10);
  const [bpm, setBpm] = useState(120);
  const [bars, setBars] = useState(4);
  const [seed, setSeed] = useState('');
  const [tasks, setTasks] = useState([]);
  const [library, setLibrary] = useState([]);
  const [bindings, setBindings] = useState({});
  const [event, setEvent] = useState('footstep');
  const [soundId, setSoundId] = useState('');
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(null);
  const audio = useRef(null);
  const run = async fn => { try { return await fn(); } catch (e) { notify(e.message, true); } };

  const refresh = () => run(async () => {
    setStatus(await api('/sound/status'));
    setLibrary(await api('/sound/library'));
    setTasks(await api('/sound/tasks'));
    setBindings(await api('/sound/bindings'));
  });
  useEffect(() => { refresh(); }, []);

  // a running task is a worker subprocess: follow it until it settles, then show the new sound
  const running = tasks.find(x => x.status === 'running' || x.status === 'queued');
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => api('/sound/tasks').then(setTasks).then(() => api('/sound/library').then(setLibrary)).catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [running?.id]);

  const selected = snapshot?.selected;
  const forObject = selected ? bindings[selected.id] || {} : {};

  async function generate() {
    setBusy(true);
    await run(async () => {
      const body = {kind: mode, prompt: prompt.trim(), seed: seed === '' ? 42 : Number(seed)};
      if (mode === 'sfx') body.seconds = Number(seconds);
      else Object.assign(body, {bpm: Number(bpm), bars: Number(bars)});
      const task = await api('/sound/tasks', {method: 'POST', body: JSON.stringify(body)});
      setTasks(v => [task, ...v]);
      notify(t('sound.started', {kind: mode === 'loop' ? t('sound.mode.loop') : t('sound.mode.sfx')}));
    });
    setBusy(false);
  }

  const cancel = id => run(async () => { await api(`/sound/tasks/${id}/cancel`, {method: 'POST'}); setTasks(await api('/sound/tasks')); });
  const trash = id => run(async () => { await api(`/sound/library/${id}/trash`, {method: 'POST'}); notify(t('sound.trashed')); setLibrary(await api('/sound/library')); setBindings(await api('/sound/bindings')); });

  function play(item) {
    const url = (item.ogg || item.wav) ? '/api/sound/library/' + item.id + '/' + (item.ogg ? 'ogg' : 'wav') : null;
    if (!url) return notify(t('sound.noFile'), true);
    if (playing === item.id) { audio.current?.pause(); return setPlaying(null); }
    audio.current.src = url;
    audio.current.play().catch(() => notify(t('sound.playFailed'), true));
    setPlaying(item.id);
  }

  const bind = () => run(async () => {
    if (!selected) return;
    const next = await api('/sound/bindings', {method: 'PUT', body: JSON.stringify({assetId: selected.id, event, soundId: soundId || null})});
    setBindings(v => ({...v, [selected.id]: next}));
    notify(soundId ? t('sound.bound', {event: nameOfEvent(event), name: library.find(x => x.id === soundId)?.name || ''}) : t('sound.unbound', {event: nameOfEvent(event)}));
  });

  const ideas = mode === 'loop' ? status?.presets?.loop?.ideas : status?.presets?.sfx?.ideas;
  const installing = status && !status.installed;

  return <div className="panel-scroll sound-panel">
    <div className="section intro"><span className="step-label">{t('sound.step')}</span><h1>{t('sound.title')}</h1><p>{t('sound.lead')}</p></div>
    {installing && <div className="section sound-missing"><AlertTriangle size={16}/><div><strong>{t('sound.notInstalled')}</strong><p>{status.message}</p><p className="field-note">{t('sound.missingHint')}</p></div></div>}
    <Section title={t('sound.generate')}>
      <div className="segmented">
        <button className={mode === 'sfx' ? 'active' : ''} onClick={() => setMode('sfx')}><Volume2 size={14}/>{t('sound.mode.sfx')}</button>
        <button className={mode === 'loop' ? 'active' : ''} onClick={() => setMode('loop')}><Music size={14}/>{t('sound.mode.loop')}</button>
      </div>
      <textarea className="prompt-input" rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t(mode === 'loop' ? 'sound.loopPlaceholder' : 'sound.sfxPlaceholder')}/>
      {!!ideas?.length && <div className="sound-ideas">{ideas.map(i => <button key={i} className="sound-idea" onClick={() => setPrompt(i)}>{i}</button>)}</div>}
      {mode === 'sfx'
        ? <label className="sound-row">{t('sound.seconds')}<select aria-label={t('sound.seconds')} value={seconds} onChange={e => setSeconds(e.target.value)}>{(status?.presets?.sfx?.durations || [2, 5, 10, 20, 30]).map(d => <option key={d} value={d}>{t('sound.unit.seconds', {n: d})}</option>)}</select></label>
        : <div className="sound-row"><label>{t('sound.bpm')}<select aria-label={t('sound.bpm')} value={bpm} onChange={e => setBpm(e.target.value)}>{(status?.presets?.loop?.bpm || [120]).map(b => <option key={b} value={b}>{b}</option>)}</select></label><label>{t('sound.bars')}<select aria-label={t('sound.bars')} value={bars} onChange={e => setBars(e.target.value)}>{(status?.presets?.loop?.bars || [2, 4, 8]).map(b => <option key={b} value={b}>{t('sound.unit.bars', {n: b})}</option>)}</select></label></div>}
      <label className="sound-row">{t('sound.seed')}<input type="number" min="0" max="2147483647" value={seed} onChange={e => setSeed(e.target.value)}/></label>
      <button className="primary full" disabled={busy || installing || !prompt.trim()} onClick={generate}>{busy ? <Loader2 className="spin" size={16}/> : <Play size={16}/>}{t('sound.make')}</button>
      <p className="field-note">{mode === 'loop' ? t('sound.loopNote') : t('sound.sfxNote')}</p>
    </Section>
    {!!tasks.length && <Section title={t('sound.tasks')} aside={<button className="subtle-btn" onClick={refresh}><RefreshCw size={13}/>{t('sound.refresh')}</button>}>
      <div className="sound-tasks">{tasks.slice(0, 6).map(x => <div key={x.id} className={'sound-task ' + x.status}>
        <div className="sound-task-head"><span>{x.kind === 'loop' ? <Music size={13}/> : <Volume2 size={13}/>} {x.prompt.slice(0, 60)}</span>
          {(x.status === 'running' || x.status === 'queued') && <button className="subtle-btn" onClick={() => cancel(x.id)}><Ban size={12}/>{t('sound.cancel')}</button>}</div>
        {(x.status === 'running' || x.status === 'queued') && <><div className="progress-bar"><i style={{width: (x.progress || 0) + '%'}}/></div><small>{x.message}</small></>}
        {x.status === 'failed' && <small className="sound-err">{x.error || x.message}</small>}
        {x.status === 'completed' && x.item && <small>{t('sound.landed', {name: x.item.name})}</small>}
      </div>)}</div>
    </Section>}
    <Section title={t('sound.library')} aside={<span className="optional">{t('sound.libraryCount', {n: library.length})}</span>}>
      {!library.length && <p className="field-note">{t('sound.libraryEmpty')}</p>}
      <div className="sound-items">{library.map(x => <div key={x.id} className="sound-item">
        <button className="sound-play" onClick={() => play(x)} title={t('sound.listen')} aria-label={t('sound.listen')}>{playing === x.id ? <Pause size={14}/> : <Play size={14}/>}</button>
        <div className="sound-item-meta"><strong>{x.name}</strong><small>{x.kind === 'loop' ? t('sound.unit.loop', {bars: x.bars, bpm: x.bpm}) : t('sound.unit.seconds', {n: Math.round(x.seconds || 0)})} · {x.prompt.slice(0, 48)}</small></div>
        {x.ogg && <span className="sound-badge">OGG</span>}
        <button className="subtle-btn" onClick={() => setSoundId(x.id)} disabled={!selected}>{t('sound.pick')}</button>
        <button className="icon-btn" onClick={() => trash(x.id)} title={t('sound.trash')} aria-label={t('sound.trash')}><Trash2 size={13}/></button>
      </div>)}</div>
      <p className="field-note">{t('sound.trashNote')}</p>
    </Section>
    <Section title={t('sound.bindings')}>
      {!selected && <p className="field-note">{t('sound.pickObject')}</p>}
      {!!selected && <>
        <p className="field-note">{t('sound.bindingFor', {name: selected.name})}</p>
        <div className="sound-bind-row">
          <select aria-label={t('sound.event')} value={event} onChange={e => setEvent(e.target.value)}>{(status?.events || []).map(e => <option key={e} value={e}>{nameOfEvent(e)}</option>)}</select>
          <select aria-label={t('sound.sound')} value={soundId} onChange={e => setSoundId(e.target.value)}>
            <option value="">{t('sound.soundNone')}</option>
            {library.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <button className="secondary" onClick={bind}>{soundId ? <Link2 size={13}/> : <Unlink size={13}/>}{soundId ? t('sound.bind') : t('sound.unbind')}</button>
        </div>
        {!!Object.keys(forObject).length && <div className="sound-bound">{Object.entries(forObject).map(([ev, id]) => {
          const item = library.find(x => x.id === id);
          return <div key={ev}><span>{nameOfEvent(ev)}</span><strong>{item ? item.name : t('sound.trashedRef')}</strong><button className="icon-btn" title={t('sound.unbind')} aria-label={t('sound.unbind')} onClick={() => { setEvent(ev); setSoundId(''); }}><Unlink size={12}/></button></div>;
        })}</div>}
      </>}
    </Section>
    <audio ref={audio} onEnded={() => setPlaying(null)}/>
  </div>;
}

function Section({title, aside, children}) {
  return <section className="section"><div className="section-heading"><h3>{title}</h3>{aside}</div>{children}</section>;
}
