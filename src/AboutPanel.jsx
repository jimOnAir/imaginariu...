// The About panel: the studio version, project links and the full license texts.
// The shipped Windows build shows here subscription, update and reporting sections - this tree
// has none of those by decision (ADR-0003): what you see is version, links, licenses.
// The Studio components entry appears when the host passes onComponents (ticket 19).
import React,{useEffect,useState} from 'react';
import {Info,ScrollText,Layers,ArrowUpRight,Loader2,BookOpen,Home} from 'lucide-react';
import {api} from './api.js';
import {useT} from './i18n/index.js';
import './about.css';

export default function AboutPanel({onComponents}){
  const t=useT();
  const [about,setAbout]=useState(null);
  const [view,setView]=useState('about');
  useEffect(()=>{api('/about').then(setAbout).catch(()=>setAbout({error:true}));},[]);
  if(!about) return <p className="field-note"><Loader2 className="spin" size={13}/> {t('about.loading')}</p>;
  if(about.error) return <p className="field-note">{t('about.failed')}</p>;
  const links=[['site',Home,'about.link.site','about.link.siteText',about.links?.site],['source',BookOpen,'about.link.source','about.link.sourceText',about.links?.source]];
  return <div className="about">
    <div className="connection-tabs about-tabs">
      <button type="button" className={view==='about'?'active':''} onClick={()=>setView('about')}><Info size={16}/>{t('about.tab.about')}</button>
      <button type="button" className={view==='licenses'?'active':''} onClick={()=>setView('licenses')}><ScrollText size={16}/>{t('about.tab.licenses')}</button>
    </div>
    {view==='about'&&<>
      <p className="about-lead">{t('about.lead',{version:about.version})}</p>
      <div className="about-links">
        {links.filter(([, , , , href])=>href).map(([id,Icon,titleKey,textKey,href])=><a key={id} className="about-link" href={href} target="_blank" rel="noreferrer"><Icon size={20}/><span><strong>{t(titleKey)}</strong><small>{t(textKey)}</small></span><ArrowUpRight size={14}/></a>)}
      </div>
      {onComponents&&<div className="about-actions"><button type="button" className="secondary small" onClick={()=>onComponents()}><Layers size={14}/>{t('about.components.open')}</button></div>}
    </>}
    {view==='licenses'&&<>
      <p className="about-lead">{t('about.licenses.lead')}</p>
      <pre className="about-text" tabIndex={0}>{about.notices}</pre>
      <pre className="about-text small" tabIndex={0}>{about.licenseText}</pre>
      {about.commercialText&&<pre className="about-text small" tabIndex={0}>{about.commercialText}</pre>}
    </>}
  </div>;
}
