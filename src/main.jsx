import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { t } from './i18n/index.js';
import { applyOsLang, hasStoredLang } from './i18n/index.js';
import './palette.css';
import './style.css';
import './fonts.css';
import './rig.css';
import './surface.css';
class ErrorBoundary extends React.Component{constructor(p){super(p);this.state={error:null};}static getDerivedStateFromError(error){return {error};}render(){return this.state.error?<div className="fatal"><h1>{t('main.error.title')}</h1><p>{this.state.error.message}</p><button onClick={()=>location.reload()}>{t('main.error.reload')}</button></div>:this.props.children;}}
// First paint in the machine's language (ticket 26): when the user has never picked one, the
// studio asks its own server what the OS says before rendering a single word - a local round trip,
// and English stays the fallback when even that does not answer.
async function boot() {
  if (!hasStoredLang()) {
    try {
      const r = await fetch('/api/locale');
      if (r.ok) applyOsLang((await r.json()).lang);
    } catch { /* offline dev boot, tests: the dictionary default holds */ }
  }
  createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);
}
boot();
