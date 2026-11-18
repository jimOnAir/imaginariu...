// The Sculpt tab: SculptGL in an iframe over the center viewport. The page lives on another origin (the web port of
// the generators) and the exchange goes only through postMessage with event.origin and event.source checked
// (see scripts/sculpt/bridge.js). The panel must not unmount when the tab changes (see App.jsx), or the sculpt is lost.
import React,{useState,useEffect,useRef,useCallback} from 'react';import {createPortal} from 'react-dom';import {Brush,Download,ExternalLink,Maximize2,Minimize2,RefreshCw,Wand2} from 'lucide-react';import {api,upload,download} from './api.js';import {useT} from './i18n/index.js';import './sculpt.css';
const CALL_TIMEOUT=90000;
const safe=s=>String(s||'model').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,80)||'model';
function Section({title,children,aside}){return <section className="section"><div className="section-heading"><h3>{title}</h3>{aside}</div>{children}</section>;}
export default function SculptPanel({studio,snapshot,notify,active,onEdit}){
 const t=useT();
 const [status,setStatus]=useState(null),[loadError,setLoadError]=useState(''),[ready,setReady]=useState(false),[info,setInfo]=useState(null),[session,setSession]=useState(null),[edited,setEdited]=useState(false),[busy,setBusy]=useState(''),[wide,setWide]=useState(false),[popup,setPopup]=useState(false),[result,setResult]=useState(null),[host,setHost]=useState(null);
 const frame=useRef(null),popupWin=useRef(null),pending=useRef(new Map()),seq=useRef(0),origin=status?.available?new URL(status.url).origin:null;
 const src=status?.available?status.url+'?studio='+encodeURIComponent(location.origin):'';
 const target=()=>popupWin.current&&!popupWin.current.closed?popupWin.current:frame.current?.contentWindow||null;
 const loadStatus=useCallback(async()=>{try{setStatus(await api('/sculpt/status'));setLoadError('');}catch(e){setLoadError(e.message);}},[]);
 useEffect(()=>{loadStatus();setHost(document.querySelector('.center .viewport'));},[loadStatus]);
 // bridge answers
 useEffect(()=>{
  if(!origin)return;
  const on=e=>{
   if(e.origin!==origin||e.source!==target())return;const m=e.data;if(!m||typeof m.type!=='string')return;
   if(m.type==='ready'){if(m.started!==false){setReady(true);setInfo(m);}}
   else if(m.type==='edited'){setEdited(m.edits>0);setInfo(i=>({...i,edits:m.edits}));}
   else if(m.id&&pending.current.has(m.id)){const p=pending.current.get(m.id);pending.current.delete(m.id);clearTimeout(p.timer);m.type==='error'?p.reject(new Error(m.error||t('sculpt.error'))):p.resolve(m);}
   else if(m.type==='error'){setReady(false);notify(m.error||t('sculpt.error'),true);}
  };
  window.addEventListener('message',on);return()=>window.removeEventListener('message',on);
 },[origin,notify]);
 const call=msg=>new Promise((resolve,reject)=>{
  const win=target();if(!win||!ready)return reject(new Error(t('sculpt.busy')));
  const id=++seq.current,timer=setTimeout(()=>{pending.current.delete(id);reject(new Error(t('sculpt.noAnswer')));},CALL_TIMEOUT);
  pending.current.set(id,{resolve,reject,timer});win.postMessage({...msg,id},origin);
 });
 // the iframe may have loaded before the panel started listening: ask for state until the bridge answers
 useEffect(()=>{if(!origin||ready)return;const timer=setInterval(()=>{try{target()?.postMessage({type:'status'},origin);}catch{}},1000);return()=>clearInterval(timer);},[origin,ready,popup]);
 useEffect(()=>{if(!popup)return;const timer=setInterval(()=>{if(!popupWin.current||popupWin.current.closed){popupWin.current=null;setPopup(false);setReady(false);setInfo(null);setSession(null);setEdited(false);}},800);return()=>clearInterval(timer);},[popup]);
 const run=(what,fn)=>(async()=>{setBusy(what);try{await fn();}catch(e){notify(e.message,true);}finally{setBusy('');}})();
 const selected=snapshot?.selected;
 const open=()=>run('open',async()=>{
  if(edited&&!window.confirm(t('sculpt.confirmReplace')))return;
  const out=studio.current.sculptExport();
  const asset=await upload(new File([out.text],safe(out.name)+'.obj',{type:'text/plain'}));
  const r=await call({type:'load',url:new URL(asset.url,location.href).href,name:safe(out.name)+'.obj'});
  setSession(out);setEdited(false);setResult(null);setInfo(i=>({...i,vertices:r.vertices,meshes:r.meshes,loaded:true,name:r.name}));
  notify(out.rigged?t('sculpt.openedRigged'):t('sculpt.opened',{name:out.name}));
 });
 const back=()=>run('back',async()=>{
  const x=await call({type:'export',format:'obj'});
  const text=new TextDecoder().decode(x.bytes),res=studio.current.sculptApply(text);
  upload(new File([x.bytes],safe(x.name),{type:'text/plain'})).catch(()=>{});   // a copy of the result in the studio assets
  setResult(res);setEdited(false);if(res.mode!=='in-place')setSession(null);onEdit?.();
  notify(res.mode==='in-place'?(res.moved?t('sculpt.inPlace',{points:res.points}):t('sculpt.inPlaceNone')):res.mode==='replace'?t('sculpt.replaced',{name:res.name,uv:res.uvLost?t('sculpt.uvLost'):''}):t('sculpt.addedNew'));
 });
 const save=()=>run('save',async()=>{const x=await call({type:'export',format:'obj'});await download(new Blob([x.bytes],{type:'text/plain'}),safe(x.name));notify(t('sculpt.objSaved',{n:x.vertices.toLocaleString()}));});
 const detach=()=>{if(!src)return;const w=window.open(src,'imaginarium-sculpt');if(!w){notify(t('sculpt.popupBlocked'),true);return;}popupWin.current=w;setReady(false);setInfo(null);setSession(null);setEdited(false);setPopup(true);};
 const noModel=!status?.available;
 const left=<div className="panel-scroll" hidden={!active}>
  <div className="section intro"><span className="step-label">{t('sculpt.step')}</span><h1>{t('sculpt.title')}</h1><p>{t('sculpt.lead1')}<br/>{t('sculpt.lead2')}</p></div>
  <Section title="SculptGL" aside={<span className={'optional '+(ready?'sculpt-ok':'')}>{noModel?t('sculpt.notReady'):ready?t('sculpt.ready'):t('sculpt.loading')}</span>}>
   {loadError&&<p className="field-note sculpt-warn">{t('sculpt.stateFail',{msg:loadError})}</p>}
   {status&&!status.available&&<p className="field-note sculpt-warn">{status.hint||t('sculpt.unavailable')}</p>}
   {!status&&!loadError&&<p className="field-note">{t('sculpt.checking')}</p>}
   {(noModel||loadError)&&<button className="secondary small" onClick={loadStatus}><RefreshCw size={12}/>{t('sculpt.recheck')}</button>}
   {status?.webError&&<p className="field-note sculpt-warn">{status.webError}</p>}
   {popup&&<p className="field-note">{t('sculpt.popupNote')}</p>}
   <button className="primary full" disabled={!ready||!selected||!!busy} onClick={open}>{busy==='open'?t('sculpt.opening'):t('sculpt.open')}</button>
   {ready&&!selected&&<p className="field-note">{t('sculpt.chooseObject')}</p>}
   {session&&<div className="sculpt-info"><strong title={session.name}>{session.name}</strong><span>{t('sculpt.session',{v:session.vertices.toLocaleString(),p:session.parts})}{session.skipped?t('sculpt.skipped',{n:session.skipped}):''}</span>{session.rigged&&<span className="sculpt-warn">{t('sculpt.riggedWarn')}</span>}</div>}
  </Section>
  <Section title={t('sculpt.sec.result')} aside={edited?<span className="badge">{t('sculpt.editsBadge')}</span>:null}>
   <button className="primary full" disabled={!ready||!session||!!busy} onClick={back}>{busy==='back'?t('sculpt.returning'):t('sculpt.back')}</button>
   <p className="field-note">{t('sculpt.backNote')}</p>
   {result?.mode==='new'&&result.rigged&&<div className="sculpt-info"><span className="sculpt-warn">{t('sculpt.noRigWarn')}</span>
    <button className="secondary small" disabled title={t('sculpt.transferPending')}><Wand2 size={12}/>{t('sculpt.transfer')}</button></div>}
   <div className="sculpt-row"><button className="secondary small" disabled={!ready||!info?.loaded||!!busy} onClick={save}><Download size={12}/>{t('sculpt.saveObj')}</button><button className="secondary small" disabled={!src} onClick={detach}><ExternalLink size={12}/>{t('sculpt.inNewTab')}</button></div>
  </Section>
  <Section title={t('sculpt.sec.tips')}>
   <ul className="sculpt-tips"><li>{t('sculpt.tip1')}</li><li>{t('sculpt.tip2')}</li><li>{t('sculpt.tip3')}</li><li>{t('sculpt.tip4')}</li></ul>
  </Section>
  <details className="section sculpt-fold"><summary>{t('sculpt.limitsTitle')}</summary>
   <ul className="sculpt-tips"><li>{t('sculpt.limit1')}</li><li>{t('sculpt.limit2')}</li><li>{t('sculpt.limit3')}</li><li>{t('sculpt.limit4')}</li><li>{t('sculpt.limit5')}</li></ul>
  </details>
 </div>;
 const overlay=host&&status?.available&&createPortal(<div className={'sculpt-stage'+(wide?' wide':'')} hidden={!active}>
  <div className="sculpt-bar"><strong>SculptGL</strong><span>{info?.loaded?t('sculpt.vertices',{n:(info.vertices||0).toLocaleString()}):t('sculpt.notOpened')}{edited?t('sculpt.editsSuffix'):''}</span>{wide&&<button className="primary small" disabled={!ready||!session||!!busy} onClick={back}>{t('sculpt.back')}</button>}<button className="icon-btn" title={wide?t('sculpt.collapse'):t('sculpt.expand')} aria-label={wide?t('sculpt.collapse'):t('sculpt.expand')} onClick={()=>setWide(!wide)}>{wide?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button></div>
  {popup?<div className="sculpt-placeholder"><Brush size={30}/><p>{t('sculpt.popupNote')}<br/>{t('sculpt.popupNote2')}</p></div>
   :<iframe ref={frame} title="SculptGL" src={src} allow="fullscreen; clipboard-write" onLoad={()=>{try{frame.current?.contentWindow?.postMessage({type:'status'},origin);}catch{}}}/>}
 </div>,host);
 return <>{left}{overlay}</>;
}
