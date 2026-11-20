// The "Check" tab (ticket 08): the studio reviews its own finished shapes. Each record is one
// generation: orbit frames rendered by Blender, scores from the local review model (the ticket-14
// pick, model + reason recorded), and the verdict from the FIXED threshold table — not from the
// model. Failed attempts auto-redo with new seeds (retries 0..3), the best attempt is kept.
// Every verdict is in <library>/learning/autoreview.jsonl. Details: docs/product/autoreview.md.
import React, {useState, useEffect} from 'react';
import {IconLoader2 as Loader2,IconRefresh as RefreshCw,IconShieldCheck as ShieldCheck,IconShieldX as ShieldX,IconHelpCircle as HelpCircle,IconScanEye as ScanEye,IconAward as Award} from '@tabler/icons-react';
import {api} from './api.js';
import {useT} from './i18n/index.js';
import './autoreview.css';

const ACTIVE = (st) => st === 'queued' || st === 'reviewing' || String(st).startsWith('retry');
const VERDICT_ICON = {accepted: ShieldCheck, rejected: ShieldX, skipped: HelpCircle};

export default function AutoReviewPanel({notify}) {
  const t = useT();
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [limits, setLimits] = useState(null);
  const [picking, setPicking] = useState(false);

  const refresh = async () => {
    try {
      const l = await api('/autoreview');
      setList(l);
      setDetail((cur) => (cur ? l.find((x) => x.id === cur.id) || null : null));
      return l;
    } catch (e) { notify(t('autoreview.loadFail') + e.message, true); return null; }
  };
  useEffect(() => {
    refresh();
    api('/autoreview/thresholds').then(setLimits).catch(() => {});
    const timer = setInterval(() => { setList((cur) => { if (cur?.some((r) => ACTIVE(r.status))) refresh(); return cur; }); }, 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { if (detail) api('/autoreview/' + detail.id).then(setDetail).catch(() => {}); }, [detail?.id]);

  const reviewLatest = async () => {
    setPicking(true);
    try {
      const jobs = await api('/jobs');
      const job = (jobs || []).filter((j) => j.status === 'completed' && j.asset?.extension === '.glb').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (!job) { notify(t('autoreview.noJob'), true); return; }
      const rec = await api('/autoreview', {method: 'POST', body: {jobId: job.id}});
      setDetail(rec);
      await refresh();
    } catch (e) { notify(e.message, true); } finally { setPicking(false); }
  };

  const floor = limits?.thresholds?.axisFloor, mean = limits?.thresholds?.meanFloor;
  const scoreCls = (v) => v === null || v === undefined ? 'na' : v < floor ? 'bad' : v < mean ? 'mid' : 'good';
  const selected = detail && (list || []).find((r) => r.id === detail.id) ? detail : null;

  return <div className="panel-scroll ar-panel">
    <div className="section intro"><span className="step-label">{t('autoreview.step')}</span><h1>{t('autoreview.title')}</h1><p>{t('autoreview.lead')}</p></div>
    <div className="ar-bar">
      <button className="primary small" onClick={reviewLatest} disabled={picking}>{picking ? <Loader2 size={14} className="spin"/> : <ScanEye size={14}/>}{t('autoreview.reviewLatest')}</button>
      <button className="subtle-btn" onClick={refresh}><RefreshCw size={14}/>{t('autoreview.refresh')}</button>
      {limits && <span className="ar-limits">{t('autoreview.limits', {floor: limits.thresholds.axisFloor, mean: limits.thresholds.meanFloor, retries: limits.thresholds.maxAttempts - 1})}</span>}
    </div>
    {!list && <div className="chat-empty"><Loader2 className="spin" size={20}/></div>}
    {list && !list.length && <div className="chat-empty"><ScanEye size={26}/><p>{t('autoreview.empty1')}<br/>{t('autoreview.empty2')}</p></div>}
    {!!list?.length && <div className="ar-list">{list.map((r) => {
      const VIcon = VERDICT_ICON[statusVerdict(r.status)] || Loader2;
      return <button key={r.id} className={'ar-card' + (selected?.id === r.id ? ' active' : '')} onClick={() => api('/autoreview/' + r.id).then(setDetail).catch((e) => notify(e.message, true))}>
        <span className={'ar-status ar-' + statusVerdict(r.status)}><VIcon size={14} className={ACTIVE(r.status) ? 'spin' : ''}/>{t('autoreview.status.' + statusVerdict(r.status))}</span>
        <strong>{r.engine}</strong>
        <span className="ar-muted">{r.prompt || r.jobId.slice(0, 8)}</span>
        <span className="ar-attempts">{r.attempts.map((a) => <i key={a.n} className={'ar-dot ' + (a.verdict || 'pending')} title={t('autoreview.attemptTitle', {n: a.n, mean: a.mean ?? '-'})}>{a.n}</i>)}</span>
      </button>;
    })}</div>}
    {selected && <div className="section ar-detail">
      <div className="section-heading"><h3>{t('autoreview.detail', {id: selected.id.slice(0, 8)})}</h3>{selected.best !== null && selected.best !== undefined && <span className="ar-best"><Award size={13}/>{t('autoreview.best', {n: selected.best})}</span>}</div>
      {selected.error && <p className="ar-error">{selected.error}</p>}
      {selected.attempts.map((a) => {
        const AIcon = VERDICT_ICON[a.verdict] || Loader2;
        return <div key={a.n} className="ar-attempt">
          <div className="ar-attempt-head"><AIcon size={14} className={ACTIVE(selected.status) && a.n === selected.attempts.length - 1 && !a.verdict ? 'spin' : ''}/><strong>{t('autoreview.attempt', {n: a.n})}</strong>
            {a.mean !== null && a.mean !== undefined && <span className="ar-mean">{t('autoreview.mean', {mean: a.mean})}</span>}
            {a.model && <span className="ar-muted">{a.model}</span>}
          </div>
          {!!a.scores && <div className="ar-scores">{Object.entries(a.scores).filter(([k]) => k !== 'note').map(([k, v]) => <span key={k} className={'ar-score ' + scoreCls(v)} title={a.modelReason || ''}>{t('autoreview.axis.' + k)} <b>{v ?? '—'}</b></span>)}</div>}
          {!!a.mesh && <p className="ar-muted">{a.mesh.load_error ? t('autoreview.meshBroken') : t('autoreview.meshNumbers', {boundary: a.mesh.boundary_edges, manifold: a.mesh.non_manifold_edges, loose: a.mesh.loose_parts})}</p>}
          {!!a.reasons?.length && <ul className="ar-reasons">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          {a.modelReason && <p className="ar-muted">{t('autoreview.modelWhy', {why: a.modelReason})}</p>}
          {a.orbitFrames && <div className="ar-orbit">{Array.from({length: Math.min(8, a.orbitFrames)}, (_, i) => <img key={i} loading="lazy" alt="" src={`/api/autoreview/${selected.id}/orbit/a${a.n}/orbit_${String(i).padStart(2, '0')}.png`}/>)}</div>}
        </div>;
      })}
    </div>}
  </div>;
}

// list statuses map to three chips: running kinds, accepted, rejected; unavailable shows as help
function statusVerdict(status) {
  if (ACTIVE(status)) return 'running';
  if (status === 'accepted') return 'accepted';
  if (status === 'review-unavailable' || status === 'failed') return 'skipped';
  return 'rejected';
}
