// The "2D" tab: pictures by reference - turnarounds, cutout body parts, animation frames, expressions,
// storyboards, poses from 3D clips, restyle. All local: the studio ComfyUI (FLUX.2 klein / Qwen-Image / SDXL).
// Details: docs/art2d.md.
import React, {useState, useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import {Upload, X, Loader2, RefreshCw, Download, Box, UserRound, Square, Images, Clapperboard, Smile, Puzzle, PersonStanding, Brush, WandSparkles, Play, Ban} from 'lucide-react';
import {api, upload} from './api.js';
import {t, useT, hasT} from './i18n/index.js';
import './art2d.css';

const ICONS = {concept: WandSparkles, turnaround: UserRound, parts: Puzzle, animation: Play, expressions: Smile, storyboard: Clapperboard, poses3d: PersonStanding, restyle: Brush};

// server registries carry English labels; the UI prefers the i18n entry for the item id
const nameOf = (kind, item) => { const key = `art2d.${kind}.${item.id ?? item}`; return hasT(key) ? t(key) : (item.label ?? item); };

function Thumb({asset, onPick, onClear, label}) {
  const t = useT();
  return <div className="a2-ref">
    {asset ? <img src={asset.url} alt=""/> : <button className="a2-ref-empty" onClick={onPick}><Upload size={14}/>{label}</button>}
    {asset && <button className="a2-ref-x" title={t('art2d.remove')} onClick={onClear}><X size={12}/></button>}
  </div>;
}

export default function Art2dPanel({notify, reference, active, onConcept}) {
  const t = useT();
  const [status, setStatus] = useState(null);
  const [recipe, setRecipe] = useState('turnaround');
  const [style, setStyle] = useState('painted');
  const [engine, setEngine] = useState('flux2');
  const [character, setCharacter] = useState(null);
  const [styleImage, setStyleImage] = useState(null);
  const [many, setMany] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [action, setAction] = useState('walk');
  const [direction, setDirection] = useState('right');
  const [frames, setFrames] = useState('');
  const [chain, setChain] = useState(false);
  const [scenes, setScenes] = useState('');
  const [sheet, setSheet] = useState('default');
  const [seed, setSeed] = useState('');
  const [sets, setSets] = useState([]);
  const [current, setCurrent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState(null);
  const charInput = useRef(null), styleInput = useRef(null), manyInput = useRef(null);
  const run = async fn => { try { return await fn(); } catch (e) { notify(e.message, true); } };

  // a subscriber of the Windows build may have no FLUX.2 weights: pick the first installed engine right away,
  // otherwise "Draw" is silently grey
  useEffect(() => { api('/art2d/status').then(s => { setStatus(s); const first = Object.entries(s?.engines || {}).find(([, e]) => e.ready)?.[0]; if (first && !s.engines[engine]?.ready) setEngine(first); }).catch(e => notify(t('art2d.loadFail') + e.message, true)); refreshList(); }, []);
  useEffect(() => { if (reference && !character) setCharacter(reference); }, [reference]);
  useEffect(() => { setHost(active ? document.getElementById('art2d-stage-host') : null); }, [active]);
  // while the set generates - refresh every 2.5 s
  useEffect(() => {
    if (!current || current.task?.status !== 'running') return undefined;
    const timer = setInterval(() => api('/art2d/sets/' + current.id).then(s => { setCurrent(s); if (s.task?.status !== 'running') refreshList(); }).catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [current?.id, current?.task?.status]);

  const refreshList = () => api('/art2d/sets').then(setSets).catch(() => {});
  const r = status?.recipes?.find(x => x.id === recipe);
  const eng = status?.engines?.[engine];
  const needsEdit = r?.edit && !(engine === 'sdxl' && recipe === 'restyle');
  const engineOk = eng?.ready && (!needsEdit || eng.edit || recipe === 'storyboard');
  const act = status?.actions?.find(a => a.id === action);

  async function pick(e, kind) {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    await run(async () => {
      if (kind === 'many') { const list = []; for (const f of files.slice(0, 24)) list.push(await upload(f)); setMany(v => [...v, ...list].slice(0, 24)); return; }
      const asset = await upload(files[0]);
      if (kind === 'char') setCharacter(asset); else setStyleImage(asset);
    });
  }

  async function create() {
    setBusy(true);
    await run(async () => {
      const body = {recipe, style, engine, prompt: prompt || undefined, sheet, characterId: character?.id, styleImageId: styleImage?.id};
      if (seed !== '') body.seed = Number(seed);
      if (recipe === 'animation') Object.assign(body, {action, direction, chain, frames: frames ? Number(frames) : undefined});
      if (recipe === 'concept') body.frames = frames ? Number(frames) : 2;
      if (recipe === 'storyboard') body.scenes = scenes.split('\n').map(s => s.trim()).filter(Boolean);
      if (recipe === 'poses3d') body.poseIds = many.map(a => a.id);
      if (recipe === 'restyle') body.inputIds = many.map(a => a.id);
      const s = await api('/art2d/sets', {method: 'POST', body: JSON.stringify(body)});
      setCurrent(s); refreshList();
      notify(t('art2d.created', {name: s.name, n: s.shots.length}));
    });
    setBusy(false);
  }

  const open = id => run(async () => setCurrent(await api('/art2d/sets/' + id)));
  const redo = key => run(async () => setCurrent(await api(`/art2d/sets/${current.id}/redo`, {method: 'POST', body: JSON.stringify({keys: [key], newSeed: true})})));
  const resume = () => run(async () => setCurrent(await api(`/art2d/sets/${current.id}/resume`, {method: 'POST'})));
  const cancel = () => run(async () => setCurrent(await api(`/art2d/sets/${current.id}/cancel`, {method: 'POST'})));
  const toAsset = async key => api(`/art2d/sets/${current.id}/asset`, {method: 'POST', body: JSON.stringify({key})});
  const useAsCharacter = key => run(async () => { setCharacter(await toAsset(key)); notify(t('art2d.becameCharacter')); });
  const sendTo3d = key => run(async () => { onConcept?.(await toAsset(key)); notify(t('art2d.sentTo3d')); });

  const running = current?.task?.status === 'running';
  const stage = current && <div className="a2-stage">
    <div className="a2-stage-head">
      <div><span className="eyebrow">2D / {current.recipe.toUpperCase()} - {nameOf('style', {id: current.style, label: current.style})} - {status?.engines?.[current.engine]?.label || current.engine}</span><h2>{current.name}</h2>
        {running ? <p className="a2-progress"><Loader2 size={13} className="spin"/>{current.task.message}</p>
          : current.run?.status === 'failed' ? <p className="a2-error">{current.run.error}</p>
          : <p className="a2-muted">{t('art2d.progress', {done: current.shots.filter(s => s.status === 'done').length, total: current.shots.length, seed: current.params.seed})}{current.run?.seconds ? t('art2d.minutes', {min: Math.round(current.run.seconds / 60)}) : ''}</p>}
        {!current.license?.commercial && <p className="a2-warn">{t('art2d.licenseWarn', {license: current.license?.engine})}</p>}
      </div>
      <div className="a2-stage-actions">
        {running && <button className="secondary small" onClick={cancel}><Ban size={13}/>{t('art2d.cancel')}</button>}
        {!running && current.shots.some(s => s.status !== 'done') && <button className="secondary small" onClick={resume}><Play size={13}/>{t('art2d.resume')}</button>}
        {!running && current.shots.some(s => s.status === 'done') && <a className="primary small a2-link" href={`/api/art2d/sets/${current.id}/godot`}><Download size={13}/>{t('art2d.forGodot')}</a>}
        <button className="icon-btn" title={t('art2d.close')} onClick={() => setCurrent(null)}><X size={16}/></button>
      </div>
    </div>
    <div className={'a2-shots ' + (current.recipe === 'storyboard' ? 'wide' : '')}>
      {current.shots.map(s => <figure key={s.key} className={'a2-shot ' + s.status}>
        <div className="a2-shot-img">{s.status === 'done' ? <img src={s.finalUrl + '&v=' + encodeURIComponent(s.at || '')} alt={s.label}/> : running ? <Loader2 size={18} className="spin"/> : <Square size={18}/>}
          {s.status === 'done' && !running && <div className="a2-shot-tools">
            <button title={t('art2d.redo')} onClick={() => redo(s.key)}><RefreshCw size={13}/></button>
            <button title={t('art2d.makeCharacter')} onClick={() => useAsCharacter(s.key)}><UserRound size={13}/></button>
            <button title={t('art2d.sendTo3d')} onClick={() => sendTo3d(s.key)}><Box size={13}/></button>
          </div>}
        </div>
        <figcaption>{s.label}{s.seconds ? <small>{Math.round(s.seconds)} s</small> : null}{s.caption && <em>{s.caption}</em>}</figcaption>
      </figure>)}
    </div>
    {(current.urls?.sheet || current.urls?.board) && !running && <div className="a2-outputs">
      {current.urls.sheet && <div><span className="eyebrow">{t('art2d.sheetCaption', {cell: current.outputs.sheet.cell.join('x')})}</span><img className="a2-sheet" src={current.urls.sheet + '&v=' + encodeURIComponent(current.updatedAt)} alt=""/></div>}
      {current.urls.board && <div><span className="eyebrow">{t('art2d.boardCaption')}</span><img className="a2-sheet" src={current.urls.board + '&v=' + encodeURIComponent(current.updatedAt)} alt=""/></div>}
    </div>}
  </div>;

  const notInstalled = status && Object.values(status.engines).filter(e => !e.ready).map(e => `${e.label}: ${e.reasons[0] || t('art2d.noWeights')}`);
  return <div className="panel-scroll a2-panel">
    <div className="section intro"><span className="step-label">{t('art2d.step')}</span><h1>{t('art2d.title')}</h1><p>{t('art2d.lead1')}<br/>{t('art2d.lead2')}</p></div>
    {status && !status.ready && <div className="section"><p className="field-note views-warn">{t('art2d.notReady', {reason: notInstalled?.[0] || t('art2d.comfyDown')})}</p></div>}

    <section className="section"><div className="section-heading"><h3>{t('art2d.sec.what')}</h3></div>
      <div className="a2-recipes">{status?.recipes?.map(x => { const Icon = ICONS[x.id] || Images; return <button key={x.id} className={recipe === x.id ? 'active' : ''} title={nameOf('recipeNote', {id: x.id, label: x.note})} onClick={() => setRecipe(x.id)}><Icon size={16}/><span>{nameOf('recipe', x)}</span></button>; })}</div>
      {r && <p className="field-note">{nameOf('recipeNote', {id: r.id, label: r.note})}</p>}
    </section>

    {recipe !== 'restyle' && recipe !== 'concept' && <section className="section"><div className="section-heading"><h3>{t('art2d.sec.character')}</h3>{reference && reference.id !== character?.id && <button className="text-btn" onClick={() => setCharacter(reference)}>{t('art2d.fromConcept')}</button>}</div>
      <div className="a2-refs"><Thumb asset={character} label={r?.needsCharacter ? t('art2d.charPic') : t('art2d.charOptional')} onPick={() => charInput.current.click()} onClear={() => setCharacter(null)}/>
        <p className="field-note">{t('art2d.charHint')}</p></div>
    </section>}

    {(recipe === 'poses3d' || recipe === 'restyle') && <section className="section"><div className="section-heading"><h3>{recipe === 'poses3d' ? t('art2d.sec.poses') : t('art2d.sec.pictures')}</h3><span className="counter">{many.length}</span></div>
      <div className="a2-many">{many.map((a, i) => <div key={a.id} className="a2-ref small"><img src={a.url} alt=""/><button className="a2-ref-x" onClick={() => setMany(v => v.filter((_, j) => j !== i))}><X size={10}/></button></div>)}
        <button className="a2-ref-empty small" onClick={() => manyInput.current.click()}><Upload size={13}/>{t('art2d.add')}</button></div>
      <p className="field-note">{recipe === 'poses3d' ? t('art2d.posesHint') : t('art2d.restyleHint')}</p>
    </section>}

    {recipe === 'animation' && <section className="section"><div className="section-heading"><h3>{t('art2d.sec.motion')}</h3></div>
      <div className="a2-row"><label>{t('art2d.action')}<select value={action} onChange={e => setAction(e.target.value)}>{status?.actions?.map(a => <option key={a.id} value={a.id}>{nameOf('action', a)} - {t('art2d.framesCount', {n: a.frames})}</option>)}</select></label>
        <label>{t('art2d.frames')}<input type="number" min="2" max={act?.frames || 8} placeholder={String(act?.frames || '')} value={frames} onChange={e => setFrames(e.target.value)}/></label></div>
      <div className="segmented">{status?.directions?.map(id => <button key={id} className={direction === id ? 'active' : ''} onClick={() => setDirection(id)}>{nameOf('dir', {id, label: id})}</button>)}</div>
      <label className="a2-check"><input type="checkbox" checked={chain} onChange={e => setChain(e.target.checked)}/>{t('art2d.chain')}</label>
      <p className="field-note">{t('art2d.animNote')}</p>
    </section>}

    {recipe === 'storyboard' && <section className="section"><div className="section-heading"><h3>{t('art2d.sec.scenes')}</h3></div>
      <textarea rows={6} value={scenes} placeholder={t('art2d.scenesPlaceholder')} onChange={e => setScenes(e.target.value)}/>
    </section>}

    <section className="section"><div className="section-heading"><h3>{t('art2d.sec.style')}</h3></div>
      <div className="a2-styles">{status?.styles?.map(s => <button key={s.id} className={style === s.id ? 'active' : ''} title={nameOf('styleNote', {id: s.id, label: s.note})} onClick={() => setStyle(s.id)}>{nameOf('style', s)}</button>)}</div>
      <div className="a2-refs"><Thumb asset={styleImage} label={t('art2d.styleSample')} onPick={() => styleInput.current.click()} onClear={() => setStyleImage(null)}/>
        <p className="field-note">{t('art2d.styleSampleHint')}</p></div>
    </section>

    <section className="section"><div className="section-heading"><h3>{recipe === 'concept' ? t('art2d.sec.desc') : t('art2d.sec.refine')}</h3></div>
      <textarea rows={recipe === 'concept' ? 4 : 2} value={prompt} placeholder={recipe === 'concept' ? t('art2d.descPlaceholder') : t('art2d.refinePlaceholder')} onChange={e => setPrompt(e.target.value)}/>
      <div className="a2-row">
        <label>{t('art2d.engine')}<select value={engine} onChange={e => setEngine(e.target.value)}>{status && Object.entries(status.engines).map(([id, en]) => <option key={id} value={id} disabled={!en.ready}>{en.label}{en.edit ? '' : t('art2d.engineNoRef')}</option>)}</select></label>
        <label>{t('art2d.seed')}<input type="number" min="0" placeholder={t('art2d.seedRandom')} value={seed} onChange={e => setSeed(e.target.value)}/></label>
      </div>
      {['animation', 'poses3d', 'turnaround', 'expressions', 'parts', 'concept'].includes(recipe) && <label className="a2-block">{t('art2d.sheet')}<select value={sheet} onChange={e => setSheet(e.target.value)}>{status?.sheets?.map(s => <option key={s.id} value={s.id}>{nameOf('sheet', s)}</option>)}</select></label>}
      {recipe === 'concept' && <label className="a2-block">{t('art2d.variants')}<input type="number" min="1" max="4" placeholder="2" value={frames} onChange={e => setFrames(e.target.value)}/></label>}
      {notInstalled?.length > 0 && <p className="field-note">{t('art2d.notInstalled', {list: notInstalled.join('; ')})}</p>}
      {eng && <p className={'field-note ' + (eng.commercial ? '' : 'views-warn')}>{t('art2d.licenseNote', {engine: eng.label, license: eng.license})}{eng.commercial ? t('art2d.licenseCommercial') : t('art2d.licenseNoncommercial')}</p>}
      {needsEdit && eng && !eng.edit && <p className="field-note views-warn">{t('art2d.needFlux', {engine: eng.label})}</p>}
      <button className="primary a2-go" disabled={busy || !engineOk || (r?.needsCharacter && !character) || ((recipe === 'poses3d' || recipe === 'restyle') && !many.length) || sets.some(s => s.status === 'running') || running} onClick={create}>
        {busy ? <Loader2 size={15} className="spin"/> : <WandSparkles size={15}/>}{t('art2d.go')}</button>
    </section>

    <section className="section"><div className="section-heading"><h3>{t('art2d.sec.sets')}</h3><span className="counter">{sets.length}</span></div>
      <div className="a2-sets">{sets.map(s => <button key={s.id} className={current?.id === s.id ? 'active' : ''} onClick={() => open(s.id)}>
        {s.thumb ? <img src={s.thumb} alt=""/> : <span className="a2-set-empty"><Images size={14}/></span>}
        <span><strong>{s.name}</strong><small>{nameOf('style', {id: s.style, label: s.style})} - {s.done}/{s.total} - {hasT('art2d.status.' + s.status) ? t('art2d.status.' + s.status) : s.status}</small></span></button>)}
        {!sets.length && <p className="field-note">{t('art2d.emptySets')}</p>}</div>
    </section>

    <input type="file" hidden ref={charInput} accept=".png,.jpg,.jpeg,.webp" onChange={e => pick(e, 'char')}/>
    <input type="file" hidden ref={styleInput} accept=".png,.jpg,.jpeg,.webp" onChange={e => pick(e, 'style')}/>
    <input type="file" hidden multiple ref={manyInput} accept=".png,.jpg,.jpeg,.webp" onChange={e => pick(e, 'many')}/>
    {host && stage && createPortal(stage, host)}
  </div>;
}
