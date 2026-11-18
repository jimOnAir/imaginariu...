// Review -> "Journal & recipes": every asset version the forge made (production journal), a verdict
// form for each one (accepted / rework / rejected, rating, defect tags, comment) and the class
// recipes the studio derives from the verdicts (docs/forge/LEARN.md). Data: GET /api/forge/learn*,
// verdicts: POST /api/forge/learn/feedback. The shared community-recipe surfaces of the shipped
// studio are intentionally absent here: this tree learns only from this computer.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Check, Wrench, Ban, Star, MessageSquarePlus, Loader2, ImageOff, BookOpen } from 'lucide-react';
import * as forgeApi from './forge-api.js';
import { Notice, useForge } from './ForgeUi.jsx';
import { t, useT } from '../i18n/index.js';
import './forge-learn.css';

const VERDICTS = [
  { id: 'accepted', Icon: Check, cls: 'approve' },
  { id: 'rework', Icon: Wrench, cls: 'rework' },
  { id: 'rejected', Icon: Ban, cls: 'reject' },
];
const verdictTitle = (id) => t('forge.learn.verdict.' + id);
const STORE_KEY = 'imaginarium.forge.learn.v1';
const STATUS_MARK = { completed: '✓', failed: '✗', cancelled: '–' };

function readPrefs() {
  try {
    return { cls: '', pending: false, ...(JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}) };
  } catch {
    return { cls: '', pending: false };
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* per-viewer convenience only */
  }
}

function loadError(e) {
  if (e?.notReady || e?.status === 404) {
    return t('forge.learn.stale');
  }
  return e?.message || t('forge.learn.loadFail');
}

const fmtValue = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const fmtDate = (iso) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

function ParamChips({ params, mark = null }) {
  const entries = Object.entries(params || {});
  if (!entries.length) return <span className="lr-none">{t('forge.learn.noParams')}</span>;
  return (
    <span className="lr-params">
      {entries.map(([k, v]) => (
        <code key={k} className={mark?.has(k) ? 'diff' : ''}>{k}={fmtValue(v)}</code>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------- feedback form

function FeedbackForm({ item, tags, onSaved, onCancel }) {
  useT();
  const { notify } = useForge();
  const last = item.verdict;
  const [verdict, setVerdict] = useState(last?.verdict || null);
  const [rating, setRating] = useState(last?.rating || 0);
  const [picked, setPicked] = useState(last?.tags || []);
  const [comment, setComment] = useState('');
  const [step, setStep] = useState('');
  const [saving, setSaving] = useState(false);
  const toggleTag = (id) => setPicked((list) => (list.includes(id) ? list.filter((t2) => t2 !== id) : [...list, id]));
  const save = async () => {
    if (!verdict) return notify(t('forge.learn.needVerdict'), true);
    setSaving(true);
    try {
      const r = await forgeApi.sendFeedback({
        assetId: item.assetId, version: item.version, verdict, rating: rating || undefined,
        tags: verdict === 'accepted' ? [] : picked, comment, step: step || undefined, source: 'review',
      });
      notify(t('forge.learn.saved', { name: item.assetName || item.assetId, version: item.version, verdict: verdictTitle(verdict) }));
      onSaved(r.feedback?.[0] || null);
    } catch (e) {
      notify(e.message || t('forge.learn.saveFail'), true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="lr-form" onClick={(e) => e.stopPropagation()}>
      <div className="rv-buttons">
        {VERDICTS.map(({ id, Icon, cls }) => (
          <button key={id} type="button" className={`rv-btn ${cls} ${verdict === id ? 'on' : ''}`} onClick={() => setVerdict(id)} disabled={saving}>
            <Icon size={13} />
            {verdictTitle(id)}
          </button>
        ))}
      </div>
      <div className="lr-stars" role="radiogroup" aria-label={t('forge.learn.rating')}>
        <span>{t('forge.learn.rating')}</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} className={n <= rating ? 'on' : ''}
            onClick={() => setRating(rating === n ? 0 : n)} title={t('forge.learn.ratingOf', { n })} aria-label={t('forge.learn.ratingOf', { n })}>
            <Star size={13} />
          </button>
        ))}
      </div>
      {verdict && verdict !== 'accepted' && (
        <div className="forge-chips lr-tags" role="group" aria-label={t('forge.learn.tagsAria')}>
          {tags.filter((tg) => tg.id !== 'other').map((tg) => (
            <button key={tg.id} type="button" role="checkbox" aria-checked={picked.includes(tg.id)} className={picked.includes(tg.id) ? 'active' : ''} onClick={() => toggleTag(tg.id)}>
              {tg.title}
            </button>
          ))}
        </div>
      )}
      {item.steps.length > 1 && (
        <label className="lr-step">
          <span>{t('forge.learn.stepLabel')}</span>
          <select value={step} onChange={(e) => setStep(e.target.value)} aria-label={t('forge.learn.stepAria')}>
            <option value="">{t('forge.learn.stepWhole')}</option>
            {item.steps.map((s) => <option key={s.index} value={s.step}>{s.title}{s.variant ? ` (${s.variant})` : ''}</option>)}
          </select>
        </label>
      )}
      <textarea rows={2} value={comment} placeholder={t('forge.learn.commentPh')} aria-label={t('forge.learn.commentAria')}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } }} />
      <div className="rv-buttons">
        <button type="button" className="rv-btn approve on" onClick={save} disabled={saving || !verdict}>
          {saving ? <Loader2 size={13} className="spin" /> : <MessageSquarePlus size={13} />}
          {t('forge.learn.save')}
        </button>
        <button type="button" className="forge-link" onClick={onCancel}>{t('forge.learn.cancel')}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- one asset version

function Preview({ url, label }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (!url || broken) return <div className="lr-preview empty"><ImageOff size={14} /><span>{t('forge.learn.noPreview')}</span></div>;
  return (
    <a className="lr-preview" href={url} target="_blank" rel="noreferrer" title={t('forge.learn.openPreview')}>
      <img src={url} alt={label} loading="lazy" decoding="async" onError={() => setBroken(true)} />
    </a>
  );
}

function VersionCard({ item, tags, titles, open, onOpen, onClose, onSaved }) {
  useT();
  const v = item.verdict;
  const tone = v ? { accepted: 'approved', rework: 'rework', rejected: 'rejected' }[v.verdict] : 'none';
  return (
    <article className={`rv-card lr-card verdict-${tone}`}>
      <Preview url={item.previews[0]} label={item.assetName} />
      <header className="rv-head">
        <h4 title={item.assetName}>{item.assetName || item.assetId}</h4>
        <span className="forge-pill muted">{titles[item.class] || item.class}</span>
      </header>
      <div className="rv-meta">{item.version} · {fmtDate(item.at)}</div>
      <ul className="lr-steps">
        {item.steps.map((s) => (
          <li key={s.index} className={s.status} title={s.failed?.length ? t('forge.learn.redChecks', { names: s.failed.join(', ') }) : t('forge.learn.checksCount', { n: s.checks })}>
            <b>{STATUS_MARK[s.status] || '·'}</b> {s.title}{s.variant ? ` (${s.variant})` : ''}
            {s.seconds ? <small> {Math.round(s.seconds)}{t('forge.learn.secondsShort')}</small> : null}
            {s.recipe && <em title={Object.entries(s.recipe.params).map(([k, val]) => `${k}=${fmtValue(val)} (${s.recipe.from?.[k] || ''})`).join('\n')}>{t('forge.learn.recipeMark')}</em>}
          </li>
        ))}
      </ul>
      {v ? (
        <p className={`rv-verdict ${tone}`}>
          <b>{verdictTitle(v.verdict)}</b>
          {v.rating ? <span> · {'★'.repeat(v.rating)}</span> : null}
          {v.tags?.length ? <span> · {v.tags.map((tg) => tags.find((x) => x.id === tg)?.title || tg).join(', ')}</span> : null}
          {v.comment ? <em>{v.comment}</em> : null}
        </p>
      ) : <p className="lr-pending">{t('forge.learn.noVerdict')}</p>}
      {open ? (
        <FeedbackForm item={item} tags={tags} onSaved={onSaved} onCancel={onClose} />
      ) : (
        <div className="rv-actions">
          <button type="button" className="secondary small" onClick={onOpen}>
            <MessageSquarePlus size={13} />
            {v ? t('forge.learn.changeVerdict') : t('forge.learn.giveVerdict')}
          </button>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------- recipes of a class

function RecipesPanel({ recipes, titles }) {
  useT();
  if (!recipes) return null;
  const groups = recipes.groups.filter((g) => g.best || g.pitfalls.some((p) => p.rejected || p.rework));
  const empty = !groups.length && !recipes.pinned.length && !recipes.notes.length;
  const noteKind = { route: t('forge.learn.noteRoute'), pitfall: t('forge.learn.notePitfall'), tip: t('forge.learn.noteTip') };
  return (
    <details className="lr-recipes" open={!!recipes.class}>
      <summary><BookOpen size={13} /> {recipes.class ? t('forge.learn.recipesOf', { title: titles[recipes.class] || recipes.class }) : t('forge.learn.recipesAll')}</summary>
      {empty && <p className="field-note">{t('forge.learn.recipesEmpty')}</p>}
      {recipes.notes.map((n) => (
        <p key={n.id} className={`lr-note ${n.kind}`}><b>{noteKind[n.kind] || n.kind}{n.class === '*' ? t('forge.learn.noteAllClasses') : ''}:</b> {n.text}</p>
      ))}
      {recipes.pinned.map((p) => (
        <div key={`${p.class}|${p.step}|${p.variant}`} className="lr-group">
          <h5>{p.step}{p.variant ? ` · ${p.variant}` : ''} <span className="forge-pill good">{p.class === '*' ? t('forge.learn.pinnedAll') : t('forge.learn.pinned')}</span></h5>
          <ParamChips params={p.params} />
          {p.note && <small>{p.note}</small>}
        </div>
      ))}
      {groups.map((g) => {
        const best = g.best;
        return (
          <div key={`${g.class}|${g.stepKey}`} className="lr-group">
            <h5>{g.stepTitle}{g.variant ? ` · ${g.variant}` : ''}{!recipes.class ? ` — ${titles[g.class] || g.class}` : ''}
              <small> {t('forge.learn.groupStats', { runs: g.runs, accepted: g.verdicts.accepted, rework: g.verdicts.rework, rejected: g.verdicts.rejected })}</small>
            </h5>
            {best ? (
              <div className="lr-best"><span className="forge-pill good">{t('forge.learn.recipe')}</span> <ParamChips params={best.params} /></div>
            ) : <p className="field-note">{t('forge.learn.noRecipe')}</p>}
            {g.pitfalls.filter((p) => p.rejected || p.rework).slice(0, 4).map((p, i) => (
              <div key={i} className="lr-pitfall">
                <span className="forge-pill bad">{t('forge.learn.pitfall')}</span>{' '}
                {p.diff.length
                  ? <span className="lr-params">{p.diff.map((d) => <code key={d.key} className="diff">{d.key}={d.unset ? t('forge.learn.defaultParam') : fmtValue(d.value)}</code>)}</span>
                  : <ParamChips params={p.params} />}
                <small>
                  {p.rejected ? ` ${t('forge.learn.rejectedTimes', { n: p.rejected })}` : ''}{p.rework ? ` ${t('forge.learn.reworkTimes', { n: p.rework })}` : ''}
                  {p.tags.length ? ` — ${p.tags.map((tg) => tg.title).join(', ')}` : ''}
                  {p.blind && p.blind >= p.rejected + p.rework ? ` · ${t('forge.learn.causeUnknown')}` : ''}
                </small>
              </div>
            ))}
          </div>
        );
      })}
    </details>
  );
}

// ---------------------------------------------------------------------------- the view

export default function ForgeLearn() {
  useT();
  const { offline, server } = useForge();
  const [prefs, setPrefs] = useState(readPrefs);
  const [overview, setOverview] = useState(null);
  const [versions, setVersions] = useState(null);
  const [recipes, setRecipes] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [problem, setProblem] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setPhase((p) => (p === 'ready' ? 'refresh' : 'loading'));
    try {
      const [o, v, r] = await Promise.all([
        forgeApi.getLearnOverview(),
        forgeApi.getLearnVersions({ cls: prefs.cls, pending: prefs.pending, limit: 120 }),
        forgeApi.getRecipes(prefs.cls || undefined),
      ]);
      if (my !== seq.current) return;
      setOverview(o);
      setVersions(v);
      setRecipes(r);
      setPhase('ready');
      setProblem('');
    } catch (e) {
      if (my !== seq.current) return;
      setProblem(loadError(e));
      setPhase('error');
    }
  }, [prefs.cls, prefs.pending]);

  useEffect(() => {
    if (!offline) load();
  }, [offline, load]);
  useEffect(() => writePrefs(prefs), [prefs]);

  if (offline) {
    return <div className="rv-body"><Notice tone="info"><p>{server?.message || t('forge.learn.offline')}</p></Notice></div>;
  }

  const titles = { ...(recipes?.titles || {}), ...Object.fromEntries((overview?.classes || []).map((c) => [c.id, c.title])) };
  const tags = overview?.tags || [];
  const items = versions?.items || [];
  const keyOf = (i) => `${i.assetId}|${i.version}`;
  const saved = (item, record) => {
    setOpenKey(null);
    if (record) {
      setVersions((v) => ({ ...v, items: v.items.map((i) => (keyOf(i) === keyOf(item) ? { ...i, verdict: record } : i)) }));
    }
    forgeApi.getRecipes(prefs.cls || undefined).then(setRecipes).catch(() => {});
  };

  return (
    <>
      <div className="rv-top lr-top">
        <div className="rv-tools">
          <select value={prefs.cls} onChange={(e) => setPrefs((p) => ({ ...p, cls: e.target.value }))} aria-label={t('forge.learn.classAria')}>
            <option value="">{t('forge.learn.classAll')}</option>
            {(overview?.classes || []).map((c) => <option key={c.id} value={c.id}>{c.title} · {c.runs}</option>)}
          </select>
          <label className="lr-check">
            <input type="checkbox" checked={prefs.pending} onChange={(e) => setPrefs((p) => ({ ...p, pending: e.target.checked }))} />
            {t('forge.learn.pending')}
          </label>
          <button type="button" className="icon-btn" onClick={load} disabled={phase === 'loading' || phase === 'refresh'} title={t('forge.learn.refresh')} aria-label={t('forge.learn.refreshAria')}>
            <RefreshCw size={14} className={phase === 'loading' || phase === 'refresh' ? 'spin' : ''} />
          </button>
        </div>
        {overview && (
          <small className="rv-written">
            {overview.journaling === false ? t('forge.learn.paused') : t('forge.learn.summary', { runs: overview.runs, feedback: overview.feedback })}
          </small>
        )}
        {overview && overview.journaling === false && <small className="rv-written">{t('forge.learn.pausedHint')}</small>}
      </div>
      <div className="panel-scroll forge-scroll rv-body">
        {phase === 'loading' && <p className="field-note"><Loader2 size={12} className="spin" /> {t('forge.learn.loading')}</p>}
        {phase === 'error' && (
          <Notice tone="warn">
            <p>{problem}</p>
            <button type="button" className="forge-link" onClick={load}><RefreshCw size={12} />{t('forge.learn.retry')}</button>
          </Notice>
        )}
        {(phase === 'ready' || phase === 'refresh') && (
          <>
            <RecipesPanel recipes={recipes} titles={titles} />
            {!items.length && <p className="field-note">{prefs.pending ? t('forge.learn.allJudged') : t('forge.learn.journalEmpty')}</p>}
            <div className="rv-grid" aria-label={t('forge.learn.versionsAria')}>
              {items.map((item) => (
                <VersionCard
                  key={keyOf(item)}
                  item={item}
                  tags={tags}
                  titles={titles}
                  open={openKey === keyOf(item)}
                  onOpen={() => setOpenKey(keyOf(item))}
                  onClose={() => setOpenKey(null)}
                  onSaved={(record) => saved(item, record)}
                />
              ))}
            </div>
            {versions && versions.total > items.length && (
              <p className="rv-foot">{t('forge.learn.shownOf', { shown: items.length, total: versions.total })}</p>
            )}
          </>
        )}
      </div>
    </>
  );
}
