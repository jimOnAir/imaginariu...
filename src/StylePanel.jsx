// The "Style" tab (ticket 06): the project look as data — 1..6 reference pictures + an English
// description (+ negative / palette / notes), kept under data/styles. "Describe" drafts the
// description from the pictures with the local vision model (the same pick Connections shows);
// nothing is downloaded and a removed style moves to the trash folder. The generators start
// consuming styles in ticket 07. Details: docs/product/styles.md.
import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Plus, Trash2, RefreshCw, Sparkles, ImageIcon, Save } from 'lucide-react';
import { api } from './api.js';
import { useT } from './i18n/index.js';
import './style-panel.css';

const MAX_IMAGES = 6;

export default function StylePanel({ notify }) {
  const t = useT();
  const [styles, setStyles] = useState([]);
  const [selected, setSelected] = useState(null);   // a full record, edited in draft
  const [draft, setDraft] = useState(null);
  const [newName, setNewName] = useState('');
  const [newFiles, setNewFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [describing, setDescribing] = useState(false);
  const fileBox = useRef(null);
  const addBox = useRef(null);
  const run = async fn => { setBusy(true); try { return await fn(); } catch (e) { notify(e.message, true); } finally { setBusy(false); } };

  const refresh = () => run(async () => {
    const list = await api('/styles');
    setStyles(list);
    setSelected(cur => cur ? list.find(s => s.id === cur.id) || null : null);
  });
  useEffect(() => { refresh(); }, []);

  const open = id => run(async () => { const rec = await api('/styles/' + id); setSelected(rec); setDraft(rec); });
  const put = (name, value) => setDraft(v => ({ ...v, [name]: value }));

  const create = () => run(async () => {
    if (!newName.trim() || !newFiles.length) { notify(t('style.needNameAndPictures'), true); return; }
    const form = new FormData();
    form.append('name', newName.trim());
    for (const f of newFiles) form.append('images', f);
    const rec = await api('/styles', { method: 'POST', body: form });
    setNewName(''); setNewFiles([]);
    if (fileBox.current) fileBox.current.value = '';
    await refresh();
    setSelected(rec); setDraft(rec);
    notify(t('style.created'));
  });

  const save = () => run(async () => {
    const { id, name, description, negative, palette, notes } = draft;
    const rec = await api('/styles/' + id, { method: 'PUT', body: JSON.stringify({ name: name.trim(), description, negative, palette, notes }) });
    setSelected(rec); setDraft(rec);
    await refresh();
    notify(t('style.saved'));
  });

  const describe = () => run(async () => {
    setDescribing(true);
    try {
      const { style, model } = await api(`/styles/${draft.id}/describe`, { method: 'POST' });
      setSelected(style); setDraft(style);
      notify(t('style.described', { model }));
    } finally { setDescribing(false); }
  });

  const addPictures = e => run(async () => {
    const files = [...e.target.files];
    if (!files.length) return;
    const form = new FormData();
    for (const f of files) form.append('images', f);
    const rec = await api(`/styles/${draft.id}/images`, { method: 'POST', body: form });
    e.target.value = '';
    setSelected(rec); setDraft(rec);
  });

  const removePicture = file => run(async () => {
    const rec = await api(`/styles/${draft.id}/images/${file}`, { method: 'DELETE' });
    setSelected(rec); setDraft(rec);
  });

  const remove = () => run(async () => {
    if (!window.confirm(t('style.confirmDelete', { name: draft.name }))) return;
    await api('/styles/' + draft.id, { method: 'DELETE' });
    setSelected(null); setDraft(null);
    await refresh();
    notify(t('style.movedToTrash'));
  });

  return <div className="style-panel">
    <div className="style-list">
      <div className="section-heading"><h3>{t('style.title')}</h3><button className="text-btn" onClick={refresh}><RefreshCw size={14}/>{t('style.refresh')}</button></div>
      <div className="style-new">
        <input placeholder={t('style.newName')} value={newName} onChange={e => setNewName(e.target.value)}/>
        <input ref={fileBox} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => setNewFiles([...e.target.files].slice(0, MAX_IMAGES))}/>
        <button className="secondary small" disabled={busy} onClick={create}><Plus size={14}/>{t('style.create')}</button>
        <p className="field-note">{newFiles.length ? t('style.pickedCount', { n: newFiles.length }) : t('style.newHint')}</p>
      </div>
      {!styles.length && <p className="field-note">{t('style.empty')}</p>}
      {styles.map(s => <button key={s.id} className={'style-card' + (selected?.id === s.id ? ' active' : '')} onClick={() => open(s.id)}>
        {s.images[0] ? <img src={`/api/styles/${s.id}/images/${s.images[0]}`} alt="" loading="lazy"/> : <span className="style-noimg"><ImageIcon size={18}/></span>}
        <span className="style-card-text"><strong>{s.name}</strong><em>{s.description ? s.description.slice(0, 90) : t('style.noDescription')}</em></span>
      </button>)}
      <p className="field-note">{t('style.usageHint')}</p>
    </div>
    {draft && <div className="style-editor">
      <div className="section-heading"><h3>{t('style.editor')}</h3><span className="badge">{t('style.imageCount', { n: draft.images.length })}</span></div>
      <div className="style-images">
        {draft.images.map(f => <span key={f} className="style-thumb">
          <img src={`/api/styles/${draft.id}/images/${f}`} alt="" loading="lazy"/>
          <button title={t('style.removePicture')} onClick={() => removePicture(f)} disabled={draft.images.length <= 1}><Trash2 size={12}/></button>
        </span>)}
        {draft.images.length < MAX_IMAGES && <label className="style-add"><input ref={addBox} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={addPictures}/><Plus size={18}/></label>}
      </div>
      <label>{t('style.name')}<input value={draft.name} onChange={e => put('name', e.target.value)}/></label>
      <label>{t('style.description')}<textarea rows={5} value={draft.description} onChange={e => put('description', e.target.value)} placeholder={t('style.descriptionPlaceholder')}/>
        <button className="secondary small" disabled={busy || describing} onClick={describe}>{describing ? <Loader2 className="spin" size={14}/> : <Sparkles size={14}/>}{describing ? t('style.describing') : t('style.describe')}</button></label>
      <label>{t('style.negative')}<input value={draft.negative} onChange={e => put('negative', e.target.value)}/></label>
      <div className="two-fields"><label>{t('style.palette')}<input value={draft.palette} onChange={e => put('palette', e.target.value)}/></label><label>{t('style.notes')}<input value={draft.notes} onChange={e => put('notes', e.target.value)}/></label></div>
      <div className="style-buttons">
        <button className="primary" disabled={busy} onClick={save}><Save size={14}/>{t('style.save')}</button>
        <button className="text-btn style-danger" disabled={busy} onClick={remove}><Trash2 size={14}/>{t('style.delete')}</button>
      </div>
      <p className="field-note">{t('style.trashNote')}</p>
    </div>}
  </div>;
}
