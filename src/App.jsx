import { useState, useEffect, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from './supabase'

// ─── Constants ────────────────────────────────────────────────────────────────
const FIELD_TYPES = [
  { value: 'text',     label: '📝 Text Input' },
  { value: 'dropdown', label: '📋 Dropdown'   },
  { value: 'number',   label: '🔢 Number'     },
  { value: 'date',     label: '📅 Date'       },
]

const DEFAULT_FIELDS = [
  { id: 'f1', label: 'Ticket ID',         key: 'ticketId',         type: 'text',     required: true,  options: [] },
  { id: 'f2', label: 'Employee Name',     key: 'employeeName',     type: 'text',     required: true,  options: [] },
  { id: 'f3', label: 'Month',             key: 'month',            type: 'dropdown', required: false, options: ['January','February','March','April','May','June','July','August','September','October','November','December'] },
  { id: 'f4', label: 'Reporting Manager', key: 'reportingManager', type: 'text',     required: false, options: [] },
]

const DEFAULT_FORM = {
  title: 'Quality Scorecard',
  sections: [
    { id: 's1', title: 'Communication',    points: 30, sections: [], questions: [
      { id: 'q1', text: 'Was the agent polite and professional?', points: 10 },
      { id: 'q2', text: 'Did the agent communicate clearly?',     points: 10 },
      { id: 'q3', text: 'Did the agent confirm understanding?',   points: 10 },
    ]},
    { id: 's2', title: 'Resolution',       points: 40, sections: [], questions: [
      { id: 'q4', text: 'Was the issue resolved on first contact?', points: 20 },
      { id: 'q5', text: 'Was the solution accurate?',               points: 20 },
    ]},
    { id: 's3', title: 'Process Adherence', points: 30, sections: [], questions: [
      { id: 'q6', text: 'Did the agent follow the script?',   points: 15 },
      { id: 'q7', text: 'Was the ticket updated correctly?',  points: 15 },
    ]},
  ],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
let _uid = Date.now()
const uid = () => `id_${++_uid}`

function calcScore(sections, answers = {}) {
  let earned = 0, possible = 0
  const recurse = secs => {
    for (const sec of secs) {
      for (const q of sec.questions || []) {
        const ans = answers[q.id]
        if (ans === 'yes')     { earned += q.points; possible += q.points }
        else if (ans === 'no') { possible += q.points }
      }
      recurse(sec.sections || [])
    }
  }
  recurse(sections)
  return { earned, possible, pct: possible > 0 ? Math.round((earned / possible) * 100) : 0 }
}

function flattenQuestions(sections, prefix = '') {
  const out = []
  for (const s of sections) {
    const path = prefix ? `${prefix} > ${s.title}` : s.title
    for (const q of s.questions || []) out.push({ ...q, path })
    out.push(...flattenQuestions(s.sections || [], path))
  }
  return out
}

// ─── Excel Export ─────────────────────────────────────────────────────────────
function exportXLSX(submissions, fields, form) {
  const allQ = flattenQuestions(form.sections)
  const headers = [
    ...fields.map(f => f.label),
    'Total Score', 'Max Possible', 'Percentage', 'Submission Date',
    ...allQ.map(q => `[${q.path}] ${q.text} (${q.points}pts)`),
  ]
  const rows = submissions.map(sub => {
    const { earned, possible, pct } = calcScore(form.sections, sub.answers || {})
    return [
      ...fields.map(f => sub.meta?.[f.key] || ''),
      earned, possible, pct / 100, new Date(sub.created_at),
      ...allQ.map(q => (sub.answers?.[q.id] || '').toUpperCase()),
    ]
  })
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!cols'] = headers.map((h, i) => ({ wch: i < fields.length ? 22 : Math.min(Math.max(String(h).length * 0.85, 14), 52) }))
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let C = range.s.c; C <= range.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: C })
    if (ws[addr]) ws[addr].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '3B4A8A' } } }
  }
  const pctC = fields.length + 2, dateC = fields.length + 3
  for (let R = 1; R <= rows.length; R++) {
    const p = XLSX.utils.encode_cell({ r: R, c: pctC }), d = XLSX.utils.encode_cell({ r: R, c: dateC })
    if (ws[p]) ws[p].z = '0%'
    if (ws[d]) ws[d].z = 'dd/mm/yyyy'
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Submissions')
  if (submissions.length > 0) {
    const pcts = submissions.map(s => s.pct)
    const avg  = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length)
    const wsSummary = XLSX.utils.aoa_to_sheet([
      ['ScoreCard Summary'], ['Generated', new Date().toLocaleString()], ['Form', form.title], [],
      ['Metric', 'Value'], ['Total Submissions', submissions.length],
      ['Average Score', `${avg}%`], ['Highest', `${Math.max(...pcts)}%`], ['Lowest', `${Math.min(...pcts)}%`],
      [], ['Section', 'Max Points'], ...form.sections.map(s => [s.title, s.points]),
    ])
    wsSummary['!cols'] = [{ wch: 28 }, { wch: 22 }]
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')
  }
  XLSX.writeFile(wb, `scorecard_${form.title.replace(/\s+/g, '_')}_${Date.now()}.xlsx`)
}

// ─── Supabase DB Layer ────────────────────────────────────────────────────────
const db = {
  async listForms() {
    const { data, error } = await supabase.from('sc_forms').select('id,name,updated_at').order('updated_at', { ascending: false })
    if (error) throw error
    return data || []
  },
  async loadForm(id) {
    const { data, error } = await supabase.from('sc_forms').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async saveForm(id, name, form, fields) {
    const { data, error } = await supabase.from('sc_forms')
      .upsert({ id, name, form, fields, updated_at: new Date().toISOString() }).select().single()
    if (error) throw error
    return data
  },
  async deleteForm(id) {
    const { error } = await supabase.from('sc_forms').delete().eq('id', id)
    if (error) throw error
  },
  async loadSubmissions(formId) {
    let q = supabase.from('sc_submissions').select('*').order('created_at', { ascending: false })
    if (formId) q = q.eq('form_id', formId)
    const { data, error } = await q
    if (error) throw error
    return data || []
  },
  async addSubmission(formId, meta, answers, earned, possible, pct) {
    const { data, error } = await supabase.from('sc_submissions')
      .insert([{ form_id: formId, meta, answers, earned, possible, pct }]).select().single()
    if (error) throw error
    return data
  },
  async deleteSubmission(id) {
    const { error } = await supabase.from('sc_submissions').delete().eq('id', id)
    if (error) throw error
  },
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function Toast({ msg, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t) }, [onClose])
  return (
    <div className={`toast toast-${type}`}>
      <span>{type === 'success' ? '✅' : '❌'}</span>
      <span>{msg}</span>
      <button onClick={onClose}>×</button>
    </div>
  )
}

function useToast() {
  const [toasts, setToasts] = useState([])
  const toast = useCallback((msg, type = 'success') => {
    const id = uid(); setToasts(t => [...t, { id, msg, type }])
  }, [])
  const removeToast = useCallback(id => setToasts(t => t.filter(x => x.id !== id)), [])
  return { toasts, toast, removeToast }
}

function Spinner({ size = 18 }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

function Editable({ value, onChange, placeholder, className = '' }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => { setEditing(false); if (v.trim()) onChange(v.trim()) }
  if (editing)
    return <input autoFocus className={`editable-input ${className}`} value={v}
      onChange={e => setV(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }} />
  return (
    <span className={`editable-text ${className}`} onClick={() => setEditing(true)} title="Click to edit">
      {value || <span className="placeholder">{placeholder}</span>}
      <span className="edit-icon">✏️</span>
    </span>
  )
}

// ─── Field Editor ─────────────────────────────────────────────────────────────
function FieldEditor({ field, onUpdate, onDelete, canDelete }) {
  const [showOpts, setShowOpts] = useState(false)
  const [newOpt, setNewOpt]     = useState('')
  const update = patch => onUpdate({ ...field, ...patch })

  const addOption = () => {
    const v = newOpt.trim(); if (!v) return
    update({ options: [...(field.options || []), v] }); setNewOpt('')
  }
  const removeOption = idx => update({ options: field.options.filter((_, i) => i !== idx) })

  return (
    <div className="field-editor">
      <div className="field-editor-row">
        {/* Type selector */}
        <select className="field-type-select" value={field.type || 'text'}
          onChange={e => update({ type: e.target.value, options: e.target.value === 'dropdown' ? (field.options?.length ? field.options : ['Option 1']) : [] })}>
          {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        {/* Label */}
        <input className="field-label-input" value={field.label}
          onChange={e => update({ label: e.target.value })} placeholder="Field label" />

        {/* Required pill */}
        <label className={`req-toggle-pill ${field.required ? 'on' : ''}`}>
          <input type="checkbox" checked={!!field.required} onChange={e => update({ required: e.target.checked })} />
          Required
        </label>

        {/* Options toggle for dropdown */}
        {field.type === 'dropdown' && (
          <button className="btn-sm secondary" onClick={() => setShowOpts(x => !x)}>
            {showOpts ? '▲ Hide Options' : `▼ Options (${(field.options || []).length})`}
          </button>
        )}

        {/* Delete */}
        {canDelete && (
          <button className="btn-icon danger" onClick={onDelete} title="Delete this field">🗑️</button>
        )}
      </div>

      {/* Dropdown options panel */}
      {field.type === 'dropdown' && showOpts && (
        <div className="options-panel">
          <p className="options-hint">These will appear as choices in the dropdown on the Submit form</p>
          <div className="options-list">
            {(field.options || []).map((opt, i) => (
              <div key={i} className="option-item">
                <input className="option-input" value={opt}
                  onChange={e => { const opts = [...field.options]; opts[i] = e.target.value; update({ options: opts }) }} />
                <button className="btn-icon danger sm" onClick={() => removeOption(i)} title="Remove option">×</button>
              </div>
            ))}
          </div>
          <div className="option-add-row">
            <input className="option-input" value={newOpt} onChange={e => setNewOpt(e.target.value)}
              placeholder="Type new option and press Add…"
              onKeyDown={e => e.key === 'Enter' && addOption()} />
            <button className="btn-sm primary" onClick={addOption}>+ Add</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Section Builder ──────────────────────────────────────────────────────────
function QuestionRow({ q, onUpdate, onDelete }) {
  return (
    <div className="question-row">
      <span className="q-drag">⠿</span>
      <div className="q-text">
        <Editable value={q.text} onChange={v => onUpdate({ ...q, text: v })} placeholder="Question text…" />
      </div>
      <div className="q-points">
        <input type="number" min={0} max={1000} value={q.points}
          onChange={e => onUpdate({ ...q, points: Number(e.target.value) })} className="points-input" />
        <span className="pts-label">pts</span>
      </div>
      <button className="btn-icon danger" onClick={onDelete} title="Delete question">🗑️</button>
    </div>
  )
}

function SectionBuilder({ sec, onChange, onDelete, depth = 0 }) {
  const addQ   = () => onChange({ ...sec, questions: [...(sec.questions||[]), { id: uid(), text: 'New question', points: 10 }] })
  const addSub = () => onChange({ ...sec, sections:  [...(sec.sections||[]),  { id: uid(), title: 'New Sub-Section', points: 0, questions: [], sections: [] }] })
  const updateQ   = (i,q) => onChange({ ...sec, questions: sec.questions.map((o,idx)=> idx===i?q:o) })
  const deleteQ   = i     => onChange({ ...sec, questions: sec.questions.filter((_,idx)=> idx!==i) })
  const updateSub = (i,s) => onChange({ ...sec, sections:  sec.sections.map((o,idx)=> idx===i?s:o) })
  const deleteSub = i     => onChange({ ...sec, sections:  sec.sections.filter((_,idx)=> idx!==i) })
  const totalQpts = (sec.questions||[]).reduce((a,q)=>a+q.points,0)

  return (
    <div className={`section-card depth-${depth}`}>
      <div className="section-header">
        <div className="section-title-row">
          <span className="section-icon">📋</span>
          <Editable value={sec.title} onChange={v=>onChange({...sec,title:v})} placeholder="Section Title" className="section-title-edit" />
          <div className="section-pts-wrap">
            <span className="section-pts-label">Max:</span>
            <input type="number" min={0} max={10000} value={sec.points}
              onChange={e=>onChange({...sec,points:Number(e.target.value)})} className="points-input section-pts" />
            <span className="pts-label">pts</span>
          </div>
          {totalQpts > 0 && <span className="q-pts-info">({totalQpts} from Qs)</span>}
        </div>
        <div className="section-actions">
          <button className="btn-sm primary" onClick={addQ}>+ Question</button>
          {depth < 2 && <button className="btn-sm secondary" onClick={addSub}>+ Sub-Section</button>}
          <button className="btn-icon danger" onClick={onDelete} title="Delete section">🗑️</button>
        </div>
      </div>
      <div className="section-body">
        {(sec.questions||[]).map((q,i)=><QuestionRow key={q.id} q={q} onUpdate={q=>updateQ(i,q)} onDelete={()=>deleteQ(i)} />)}
        {(sec.sections||[]).map((s,i)=><SectionBuilder key={s.id} sec={s} depth={depth+1} onChange={s=>updateSub(i,s)} onDelete={()=>deleteSub(i)} />)}
        {!(sec.questions?.length) && !(sec.sections?.length) && <div className="empty-section">Click "+ Question" to add questions</div>}
      </div>
    </div>
  )
}

// ─── Sidebar: Saved Forms ─────────────────────────────────────────────────────
function FormsSidebar({ forms, activeId, onLoad, onDelete, onNew, loading }) {
  const [deleting, setDeleting] = useState(null)
  const handleDelete = async (e, id) => {
    e.stopPropagation()
    if (!window.confirm('Delete this form? All its submissions will also be deleted.')) return
    setDeleting(id); await onDelete(id); setDeleting(null)
  }
  return (
    <div className="forms-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">📁 Saved Forms</span>
        <button className="btn-sm primary" onClick={onNew}>+ New</button>
      </div>
      {loading && <div className="sidebar-loading"><Spinner size={14} /> Loading…</div>}
      {!loading && forms.length === 0 && <div className="sidebar-empty">No saved forms yet.<br/>Click "Save As…" to save your current form.</div>}
      <div className="sidebar-list">
        {forms.map(f => (
          <div key={f.id} className={`sidebar-item ${f.id === activeId ? 'active' : ''}`} onClick={() => onLoad(f.id)}>
            <div className="sidebar-item-info">
              <span className="sidebar-item-name">{f.name}</span>
              <span className="sidebar-item-date">{new Date(f.updated_at).toLocaleDateString('en-GB')}</span>
            </div>
            <button className="btn-icon danger sm" disabled={deleting === f.id} onClick={e => handleDelete(e, f.id)} title="Delete form">
              {deleting === f.id ? <Spinner size={12} /> : '🗑️'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Save Modal ───────────────────────────────────────────────────────────────
function SaveModal({ defaultName, onSave, onClose, saving }) {
  const [name, setName] = useState(defaultName)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card small" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>💾 Save Form</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="meta-label">Form Name</label>
          <input className="meta-input" value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Q1 Quality Audit" autoFocus
            onKeyDown={e => e.key === 'Enter' && name.trim() && onSave(name.trim())} />
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 6 }}>This form will appear in the Saved Forms list on the left</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button className="btn primary" style={{ flex: 1 }} disabled={!name.trim() || saving}
              onClick={() => onSave(name.trim())}>
              {saving ? <><Spinner size={14} /> Saving…</> : 'Save Form →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page: Form Builder ───────────────────────────────────────────────────────
function PageBuilder({ form, setForm, fields, setFields, forms, activeFormId, onSaveForm, onLoadForm, onDeleteForm, onNewForm, loadingForms, saving }) {
  const [showSaveModal, setShowSaveModal] = useState(false)
  const updateSection = (i,s) => setForm({...form, sections: form.sections.map((o,idx)=>idx===i?s:o)})
  const deleteSection = i     => setForm({...form, sections: form.sections.filter((_,idx)=>idx!==i)})
  const addSection    = ()    => setForm({...form, sections: [...form.sections, { id:uid(), title:'New Section', points:0, questions:[], sections:[] }]})
  const addField    = ()      => setFields([...fields, { id:uid(), label:'New Field', key:`field_${uid()}`, type:'text', required:false, options:[] }])
  const updateField = (i,f)   => setFields(fields.map((o,idx)=>idx===i?f:o))
  const deleteField = i       => setFields(fields.filter((_,idx)=>idx!==i))

  return (
    <div className="builder-layout">
      <FormsSidebar forms={forms} activeId={activeFormId} onLoad={onLoadForm} onDelete={onDeleteForm} onNew={onNewForm} loading={loadingForms} />

      <div className="page-content builder-main">
        <div className="page-hero">
          <div className="page-hero-top">
            <div>
              <h2 className="page-title">
                <Editable value={form.title} onChange={v=>setForm({...form,title:v})} placeholder="Form Title" className="form-title-edit" />
              </h2>
              <p className="page-sub">Click any text to edit inline · Use the sidebar to switch between forms</p>
            </div>
            <div style={{ display:'flex', gap:10 }}>
              {activeFormId && (
                <button className="btn secondary" onClick={()=>onSaveForm(null, form.title)} disabled={saving}>
                  {saving ? <><Spinner size={14}/> Updating…</> : '🔄 Update'}
                </button>
              )}
              <button className="btn primary" onClick={()=>setShowSaveModal(true)} disabled={saving}>💾 Save As…</button>
            </div>
          </div>
        </div>

        {/* Submission Fields */}
        <div className="panel">
          <div className="panel-header">
            <span>🎫 Submission Fields</span>
            <button className="btn-sm primary" onClick={addField}>+ Add Field</button>
          </div>
          <p className="panel-desc">These fields appear at the top of every submission. Choose type: Text, Dropdown, Number, or Date.</p>
          <div className="fields-editor-list">
            {fields.map((f,i) => (
              <FieldEditor key={f.id} field={f} onUpdate={u=>updateField(i,u)} onDelete={()=>deleteField(i)} canDelete={fields.length>1} />
            ))}
          </div>
        </div>

        {/* Sections */}
        <div className="sections-wrap">
          {form.sections.map((sec,i)=>(
            <SectionBuilder key={sec.id} sec={sec} onChange={s=>updateSection(i,s)} onDelete={()=>deleteSection(i)} />
          ))}
          <button className="btn-add-section" onClick={addSection}>＋ Add Section</button>
        </div>
      </div>

      {showSaveModal && (
        <SaveModal defaultName={form.title} saving={saving} onClose={()=>setShowSaveModal(false)}
          onSave={name=>onSaveForm(name,name).then(()=>setShowSaveModal(false))} />
      )}
    </div>
  )
}

// ─── Page: Submit ─────────────────────────────────────────────────────────────
function MetaField({ field, value, onChange, hasError }) {
  if (field.type === 'dropdown')
    return (
      <select className={`meta-input ${hasError?'error':''}`} value={value||''} onChange={e=>onChange(e.target.value)}>
        <option value="">Select {field.label}…</option>
        {(field.options||[]).map(o=><option key={o} value={o}>{o}</option>)}
      </select>
    )
  return <input type={field.type==='number'?'number':field.type==='date'?'date':'text'}
    className={`meta-input ${hasError?'error':''}`} value={value||''} onChange={e=>onChange(e.target.value)} placeholder={`Enter ${field.label}`} />
}

function AnswerBlock({ q, value, onChange }) {
  return (
    <div className={`answer-row ${value==='na'?'row-na':''}`}>
      <div className="answer-q">
        <span className="answer-q-text">{q.text}</span>
        <span className="answer-q-pts">{q.points} pts</span>
      </div>
      <div className="answer-choices">
        {[['yes','✅ Yes'],['no','❌ No'],['na','⊘ N/A']].map(([opt,label])=>(
          <button key={opt} className={`choice-btn ${opt} ${value===opt?'active':''}`}
            onClick={()=>onChange(value===opt?null:opt)}>{label}</button>
        ))}
      </div>
    </div>
  )
}

function SubmitSection({ sec, answers, onAnswer, depth=0 }) {
  const [collapsed, setCollapsed] = useState(false)
  const allQs=[]; const collectQ=s=>{(s.questions||[]).forEach(q=>allQs.push(q));(s.sections||[]).forEach(collectQ)}; collectQ(sec)
  const answered=allQs.filter(q=>answers[q.id]!=null).length
  return (
    <div className={`submit-section depth-${depth}`}>
      <div className="submit-sec-header" onClick={()=>setCollapsed(!collapsed)}>
        <div className="submit-sec-title"><span>{collapsed?'▶':'▼'}</span><span>{sec.title}</span><span className="sec-badge">{answered}/{allQs.length}</span></div>
        <span className="sec-maxpts">{sec.points} pts max</span>
      </div>
      {!collapsed && (
        <div className="submit-sec-body">
          {(sec.questions||[]).map(q=><AnswerBlock key={q.id} q={q} value={answers[q.id]} onChange={v=>onAnswer(q.id,v)} />)}
          {(sec.sections||[]).map(s=><SubmitSection key={s.id} sec={s} answers={answers} onAnswer={onAnswer} depth={depth+1} />)}
        </div>
      )}
    </div>
  )
}

function PageSubmit({ form, fields, onSubmit }) {
  const [meta, setMeta]=[useState({}),(v)=>setMeta(v)][1] && useState({})
  const [answers, setAnswers] = useState({})
  const [errors, setErrors]   = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]       = useState(null)
  const [metaState, setMetaState] = useState({})
  const score = calcScore(form.sections, answers)

  const handleSubmit = async () => {
    const errs = fields.filter(f=>f.required && !metaState[f.key]?.toString().trim()).map(f=>f.label)
    if (errs.length) { setErrors(errs); return }
    setErrors([]); setSubmitting(true)
    try { const sub=await onSubmit(metaState,answers,score.earned,score.possible,score.pct); setDone(sub) }
    finally { setSubmitting(false) }
  }

  if (done) {
    const s=calcScore(form.sections,done.answers||{})
    return (
      <div className="page-content center">
        <div className="success-card">
          <div className="success-icon">🎉</div><h2>Submitted!</h2>
          <div className="score-big">{s.pct}%</div><p>{s.earned} / {s.possible} points earned</p>
          <button className="btn primary lg" onClick={()=>{setMetaState({});setAnswers({});setDone(null)}}>Submit Another</button>
        </div>
      </div>
    )
  }
  return (
    <div className="page-content">
      <div className="page-hero"><h2 className="page-title">{form.title}</h2><p className="page-sub">Fill in the details, then answer each question</p></div>
      <div className="score-preview">
        <div className="score-bar-wrap"><div className="score-bar" style={{width:`${score.pct}%`}} /></div>
        <span className="score-preview-text">{score.earned} / {score.possible} pts ({score.pct}%)</span>
      </div>
      <div className="panel meta-panel">
        <div className="panel-header"><span>📝 Submission Details</span></div>
        <div className="meta-grid">
          {fields.map(f=>(
            <div key={f.id} className="meta-field">
              <label className="meta-label">{f.label}{f.required&&<span className="req-star">*</span>}</label>
              <MetaField field={f} value={metaState[f.key]} hasError={errors.includes(f.label)}
                onChange={v=>setMetaState(p=>({...p,[f.key]:v}))} />
            </div>
          ))}
        </div>
        {errors.length>0 && <div className="error-msg">Required fields missing: {errors.join(', ')}</div>}
      </div>
      {form.sections.map(sec=><SubmitSection key={sec.id} sec={sec} answers={answers} onAnswer={(qid,v)=>setAnswers(p=>({...p,[qid]:v}))} />)}
      <div className="submit-footer">
        <div className="final-score">Score: <strong>{score.earned}/{score.possible} pts ({score.pct}%)</strong></div>
        <button className="btn primary lg" onClick={handleSubmit} disabled={submitting}>
          {submitting?<><Spinner size={16}/> Saving…</>:'Submit Scorecard →'}
        </button>
      </div>
    </div>
  )
}

// ─── Page: Reports ────────────────────────────────────────────────────────────
function PageReports({ submissions, form, fields, onDelete, loading }) {
  const [search,setSortSearch]=[useState(''),null][0] && useState('')
  const [searchStr, setSearchStr] = useState('')
  const [sortKey,setSortKey]=useState('created_at')
  const [sortDir,setSortDir]=useState('desc')
  const [selected,setSelected]=useState(null)
  const [deleting,setDeleting]=useState(null)
  const allQ=flattenQuestions(form.sections)

  const filtered=submissions
    .filter(sub=>!searchStr||Object.values(sub.meta||{}).join(' ').toLowerCase().includes(searchStr.toLowerCase()))
    .sort((a,b)=>{const va=sortKey==='pct'?a.pct:a[sortKey]||'',vb=sortKey==='pct'?b.pct:b[sortKey]||''; return sortDir==='asc'?(va>vb?1:-1):(va<vb?1:-1)})
  const toggleSort=key=>{if(sortKey===key)setSortDir(d=>d==='asc'?'desc':'asc');else{setSortKey(key);setSortDir('desc')}}
  const handleDelete=async id=>{setDeleting(id);await onDelete(id);setDeleting(null);if(selected?.id===id)setSelected(null)}

  const stats=submissions.length>0?(()=>{
    const pcts=submissions.map(s=>s.pct)
    return{avg:Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length),high:Math.max(...pcts),low:Math.min(...pcts)}
  })():null

  return (
    <div className="page-content">
      <div className="page-hero"><h2 className="page-title">Reports & Analytics</h2><p className="page-sub">{submissions.length} total submissions — synced from cloud</p></div>
      {loading&&<div className="loading-bar"><Spinner/> Loading submissions…</div>}
      {stats&&(
        <div className="stats-row">
          <div className="stat-card"><div className="stat-num">{submissions.length}</div><div className="stat-lbl">Submissions</div></div>
          <div className="stat-card"><div className="stat-num">{stats.avg}%</div><div className="stat-lbl">Average</div></div>
          <div className="stat-card"><div className="stat-num green">{stats.high}%</div><div className="stat-lbl">Highest</div></div>
          <div className="stat-card"><div className="stat-num red">{stats.low}%</div><div className="stat-lbl">Lowest</div></div>
        </div>
      )}
      <div className="report-toolbar">
        <input className="search-input" placeholder="🔍 Search by ticket, employee…" value={searchStr} onChange={e=>setSearchStr(e.target.value)} />
        <button className="btn secondary" disabled={submissions.length===0} onClick={()=>exportXLSX(filtered,fields,form)}>⬇ Export Excel</button>
      </div>
      {!loading&&submissions.length===0?(
        <div className="empty-state">No submissions yet. Go to the <strong>Submit</strong> tab to add entries.</div>
      ):(
        <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr>
              {fields.map(f=><th key={f.id} className="sortable" onClick={()=>toggleSort(f.key)}>{f.label} {sortKey===f.key?(sortDir==='asc'?'↑':'↓'):''}</th>)}
              <th className="sortable" onClick={()=>toggleSort('pct')}>Score% {sortKey==='pct'?(sortDir==='asc'?'↑':'↓'):''}</th>
              <th>Earned / Max</th>
              <th className="sortable" onClick={()=>toggleSort('created_at')}>Date {sortKey==='created_at'?(sortDir==='asc'?'↑':'↓'):''}</th>
              <th>Actions</th>
            </tr></thead>
            <tbody>
              {filtered.map(sub=>(
                <tr key={sub.id} className="report-row" onClick={()=>setSelected(sub)}>
                  {fields.map(f=><td key={f.id}>{sub.meta?.[f.key]||'—'}</td>)}
                  <td><span className={`score-pill ${sub.pct>=80?'green':sub.pct>=60?'yellow':'red'}`}>{sub.pct}%</span></td>
                  <td>{sub.earned} / {sub.possible}</td>
                  <td>{new Date(sub.created_at).toLocaleDateString('en-GB')}</td>
                  <td onClick={e=>e.stopPropagation()}>
                    <button className="btn-icon danger sm" disabled={deleting===sub.id} onClick={()=>handleDelete(sub.id)}>
                      {deleting===sub.id?<Spinner size={14}/>:'🗑️'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected&&(
        <div className="modal-overlay" onClick={()=>setSelected(null)}>
          <div className="modal-card" onClick={e=>e.stopPropagation()}>
            <div className="modal-header"><h3>Submission Detail</h3><button className="btn-icon" onClick={()=>setSelected(null)}>✕</button></div>
            <div className="modal-body">
              <div className="detail-meta">
                {fields.map(f=><div key={f.id} className="detail-meta-row"><span className="detail-label">{f.label}:</span><span>{selected.meta?.[f.key]||'—'}</span></div>)}
                <div className="detail-meta-row"><span className="detail-label">Submitted:</span><span>{new Date(selected.created_at).toLocaleString('en-GB')}</span></div>
              </div>
              <div className="detail-score"><div className="score-big">{selected.pct}%</div><p>{selected.earned} / {selected.possible} pts</p></div>
              <div className="detail-questions">
                {allQ.map(q=>(
                  <div key={q.id} className="detail-q-row">
                    <div className="detail-q-text"><span className="detail-q-path">{q.path}</span><span>{q.text} <span className="detail-q-pts">({q.points}pts)</span></span></div>
                    <span className={`answer-badge ${selected.answers?.[q.id]||'none'}`}>{(selected.answers?.[q.id]||'—').toUpperCase()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────
function SetupScreen({ onSave }) {
  const [url,setUrl]=useState(''); const [key,setKey]=useState(''); const [err,setErr]=useState(''); const [testing,setTesting]=useState(false)
  const handleSave=async()=>{
    if(!url.trim()||!key.trim()){setErr('Both fields are required.');return}
    setErr('');setTesting(true)
    try{
      const{createClient}=await import('@supabase/supabase-js')
      const client=createClient(url.trim(),key.trim())
      const{error}=await client.from('sc_forms').select('id').limit(1)
      if(error)throw new Error(error.message)
      localStorage.setItem('sc_supabase_url',url.trim()); localStorage.setItem('sc_supabase_key',key.trim()); onSave()
    }catch(e){setErr(`Connection failed: ${e.message}`)}finally{setTesting(false)}
  }
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-logo">📊</div>
        <h1 className="setup-title">ScoreCard Setup</h1>
        <p className="setup-sub">Connect your Supabase project to get started</p>
        <div className="setup-steps">
          <div className="step"><span className="step-num">1</span><span>Go to <a href="https://supabase.com" target="_blank" rel="noreferrer">supabase.com</a> → New Project</span></div>
          <div className="step"><span className="step-num">2</span><span>SQL Editor → run <code>supabase-schema.sql</code> from the project zip</span></div>
          <div className="step"><span className="step-num">3</span><span>Settings → API → copy <strong>Project URL</strong> and <strong>anon key</strong></span></div>
        </div>
        <div className="setup-form">
          <label className="meta-label">Supabase Project URL</label>
          <input className="meta-input" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://xxxxxxxxxxxx.supabase.co" />
          <label className="meta-label" style={{marginTop:14}}>Supabase Anon Key</label>
          <input className="meta-input" value={key} onChange={e=>setKey(e.target.value)} placeholder="eyJhbGciOi…" type="password" />
          {err&&<div className="error-msg" style={{marginTop:12,marginLeft:0,marginRight:0}}>{err}</div>}
          <button className="btn primary lg" style={{marginTop:18,width:'100%'}} onClick={handleSave} disabled={testing}>
            {testing?<><Spinner size={16}/> Testing connection…</>:'Connect & Start →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [ready,setReady]=useState(false)
  const [tab,setTab]=useState('builder')
  const [form,setForm]=useState(DEFAULT_FORM)
  const [fields,setFields]=useState(DEFAULT_FIELDS)
  const [activeFormId,setActiveFormId]=useState(null)
  const [forms,setForms]=useState([])
  const [loadingForms,setLoadingForms]=useState(false)
  const [submissions,setSubmissions]=useState([])
  const [loadingSubs,setLoadingSubs]=useState(false)
  const [saving,setSaving]=useState(false)
  const{toasts,toast,removeToast}=useToast()

  useEffect(()=>{
    const envUrl=import.meta.env.VITE_SUPABASE_URL, envKey=import.meta.env.VITE_SUPABASE_ANON_KEY
    const lsUrl=localStorage.getItem('sc_supabase_url'), lsKey=localStorage.getItem('sc_supabase_key')
    if((envUrl&&envKey&&envUrl!=='https://your-project-id.supabase.co')||(lsUrl&&lsKey))setReady(true)
  },[])

  useEffect(()=>{ if(!ready)return; fetchForms(); fetchSubmissions() },[ready])

  const fetchForms=async()=>{ setLoadingForms(true); try{setForms(await db.listForms())}catch(e){toast('Failed to load forms: '+e.message,'error')}finally{setLoadingForms(false)} }
  const fetchSubmissions=async(formId)=>{ setLoadingSubs(true); try{setSubmissions(await db.loadSubmissions(formId))}catch(e){toast('Failed to load submissions: '+e.message,'error')}finally{setLoadingSubs(false)} }

  const handleSaveForm=async(name,fallbackName)=>{
    setSaving(true)
    try{
      const id=name?uid():activeFormId
      const formName=name||forms.find(f=>f.id===activeFormId)?.name||fallbackName
      await db.saveForm(id,formName,form,fields)
      setActiveFormId(id); await fetchForms(); toast(`Form "${formName}" saved ✓`)
    }catch(e){toast('Save failed: '+e.message,'error');throw e}finally{setSaving(false)}
  }

  const handleLoadForm=async id=>{
    try{
      const data=await db.loadForm(id)
      if(data.form&&Object.keys(data.form).length)setForm(data.form)
      if(data.fields&&data.fields.length)setFields(data.fields)
      setActiveFormId(id); fetchSubmissions(id); toast(`Loaded "${data.name}" ✓`)
    }catch(e){toast('Failed to load form: '+e.message,'error')}
  }

  const handleDeleteForm=async id=>{
    try{
      await db.deleteForm(id); setForms(p=>p.filter(f=>f.id!==id))
      if(activeFormId===id){setActiveFormId(null);setForm(DEFAULT_FORM);setFields(DEFAULT_FIELDS)}
      toast('Form deleted')
    }catch(e){toast('Delete failed: '+e.message,'error')}
  }

  const handleNewForm=()=>{ setForm(DEFAULT_FORM); setFields(DEFAULT_FIELDS); setActiveFormId(null); setSubmissions([]); toast('New form started') }

  const handleSubmit=async(meta,answers,earned,possible,pct)=>{
    const sub=await db.addSubmission(activeFormId,meta,answers,earned,possible,pct)
    setSubmissions(p=>[sub,...p]); toast('Submission saved to cloud ✓'); return sub
  }

  const handleDeleteSubmission=async id=>{
    try{await db.deleteSubmission(id);setSubmissions(p=>p.filter(s=>s.id!==id));toast('Submission deleted')}
    catch(e){toast('Delete failed: '+e.message,'error')}
  }

  if(!ready)return<SetupScreen onSave={()=>setReady(true)}/>

  return (
    <>
      <style>{CSS}</style>
      <div className="toast-container">{toasts.map(t=><Toast key={t.id} msg={t.msg} type={t.type} onClose={()=>removeToast(t.id)}/>)}</div>
      <nav className="app-nav">
        <div className="app-brand">ScoreCard</div>
        {[{key:'builder',label:'🏗️ Form Builder'},{key:'submit',label:'📝 Submit'},{key:'reports',label:'📊 Reports'}].map(t=>(
          <button key={t.key} className={`nav-tab ${tab===t.key?'active':''}`} onClick={()=>setTab(t.key)}>{t.label}</button>
        ))}
        <div className="nav-spacer"/>
        <button className="btn-sm secondary nav-refresh" onClick={()=>fetchSubmissions(activeFormId)}>🔄 Sync</button>
      </nav>
      <div className="app-body">
        {tab==='builder'&&<PageBuilder form={form} setForm={setForm} fields={fields} setFields={setFields} forms={forms} activeFormId={activeFormId} onSaveForm={handleSaveForm} onLoadForm={handleLoadForm} onDeleteForm={handleDeleteForm} onNewForm={handleNewForm} loadingForms={loadingForms} saving={saving}/>}
        {tab==='submit'&&<PageSubmit form={form} fields={fields} onSubmit={handleSubmit}/>}
        {tab==='reports'&&<PageReports submissions={submissions} form={form} fields={fields} onDelete={handleDeleteSubmission} loading={loadingSubs}/>}
      </div>
    </>
  )
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--bg2:#161b27;--bg3:#1c2135;--card:#1a1f2e;--card2:#202540;--border:#2a3050;--border2:#374068;--accent:#6c8aff;--accent2:#92a8ff;--green:#3ecf8e;--red:#f05858;--yellow:#f5a623;--text:#e8eaf2;--text2:#8b93b0;--text3:#555f80;--radius:12px;--shadow:0 8px 32px rgba(0,0,0,.5)}
body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;min-height:100vh}
.spinner{display:inline-block;border-radius:50%;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.toast-container{position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:10px}
.toast{display:flex;align-items:center;gap:10px;background:var(--card2);border:1px solid var(--border2);border-radius:10px;padding:12px 16px;font-size:13.5px;box-shadow:var(--shadow);animation:slideIn .25s ease;min-width:260px;max-width:380px}
.toast-success{border-left:4px solid var(--green)}.toast-error{border-left:4px solid var(--red)}
.toast button{margin-left:auto;background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;line-height:1}
@keyframes slideIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
.setup-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(ellipse at 60% 20%,rgba(108,138,255,.08) 0%,transparent 60%),var(--bg)}
.setup-card{background:var(--card);border:1px solid var(--border2);border-radius:20px;padding:48px 44px;max-width:520px;width:100%;box-shadow:var(--shadow);display:flex;flex-direction:column;align-items:center;gap:10px}
.setup-logo{font-size:52px}.setup-title{font-family:'DM Serif Display',serif;font-size:32px;letter-spacing:-1px}.setup-sub{color:var(--text2);font-size:14px;margin-bottom:8px}
.setup-steps{width:100%;display:flex;flex-direction:column;gap:10px;background:var(--bg3);border-radius:var(--radius);padding:18px 20px;margin:8px 0}
.step{display:flex;gap:12px;align-items:flex-start;font-size:13px;color:var(--text2);line-height:1.5}.step a{color:var(--accent2)}.step code{background:var(--bg2);padding:1px 6px;border-radius:4px;font-family:monospace;font-size:12px;color:var(--accent2)}
.step-num{background:var(--accent);color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
.setup-form{width:100%;display:flex;flex-direction:column}
.app-nav{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;position:sticky;top:0;z-index:100;box-shadow:0 2px 16px rgba(0,0,0,.4)}
.app-brand{font-family:'DM Serif Display',serif;font-size:20px;color:var(--accent2);padding:16px 20px 16px 0;border-right:1px solid var(--border);margin-right:8px;letter-spacing:-.5px}
.nav-tab{padding:18px 18px;cursor:pointer;color:var(--text2);font-weight:500;border:none;border-bottom:3px solid transparent;background:none;transition:all .2s;font-size:13.5px;font-family:inherit}
.nav-tab:hover{color:var(--text)}.nav-tab.active{color:var(--accent2);border-bottom-color:var(--accent)}.nav-spacer{flex:1}
.builder-layout{display:flex;gap:20px;align-items:flex-start}
.builder-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:22px}
.forms-sidebar{width:220px;flex-shrink:0;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);position:sticky;top:72px;overflow:hidden}
.sidebar-header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--card2);border-bottom:1px solid var(--border);font-weight:600;font-size:13px}
.sidebar-title{color:var(--text2)}.sidebar-loading{padding:14px;color:var(--text2);font-size:12.5px;display:flex;align-items:center;gap:8px}
.sidebar-empty{padding:16px 14px;color:var(--text3);font-size:12px;text-align:center;line-height:1.6}
.sidebar-list{max-height:68vh;overflow-y:auto}
.sidebar-item{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .15s;gap:8px}
.sidebar-item:hover{background:var(--bg3)}.sidebar-item.active{background:rgba(108,138,255,.1);border-left:3px solid var(--accent)}
.sidebar-item-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sidebar-item-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.sidebar-item-date{font-size:11px;color:var(--text3)}
.app-body{max-width:1100px;margin:0 auto;padding:28px 24px 80px}
.page-content{display:flex;flex-direction:column;gap:22px}
.page-hero{padding-bottom:16px;border-bottom:1px solid var(--border)}
.page-hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.page-title{font-family:'DM Serif Display',serif;font-size:28px;color:var(--text);letter-spacing:-.5px}.page-sub{color:var(--text2);margin-top:6px;font-size:13.5px}
.center{align-items:center;justify-content:center;min-height:60vh}.loading-bar{display:flex;align-items:center;gap:10px;color:var(--text2);font-size:13.5px}
.editable-text{cursor:pointer;border-bottom:1px dashed var(--border2);display:inline-flex;align-items:center;gap:6px;transition:border-color .2s}
.editable-text:hover{border-bottom-color:var(--accent)}.edit-icon{font-size:11px;opacity:0;transition:opacity .2s}.editable-text:hover .edit-icon{opacity:.5}.placeholder{opacity:.35}
.editable-input{background:var(--bg3);border:1.5px solid var(--accent);border-radius:6px;padding:4px 8px;color:var(--text);font-size:inherit;font-family:inherit;outline:none;min-width:140px}
.form-title-edit{font-family:'DM Serif Display',serif;font-size:28px}.section-title-edit{font-size:15px;font-weight:600}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.panel-header{padding:14px 20px;background:var(--card2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:13.5px}
.panel-desc{padding:10px 20px 0;color:var(--text2);font-size:12.5px}
/* Field Editor */
.fields-editor-list{display:flex;flex-direction:column}
.field-editor{border-bottom:1px solid var(--border)}.field-editor:last-child{border-bottom:none}
.field-editor-row{display:flex;align-items:center;gap:10px;padding:12px 20px;flex-wrap:wrap}
.field-type-select{background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;color:var(--text);font-family:inherit;font-size:12.5px;padding:7px 10px;outline:none;cursor:pointer;min-width:148px}
.field-type-select:focus{border-color:var(--accent)}
.field-label-input{flex:1;min-width:120px;background:var(--bg3);border:1.5px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--text);font-family:inherit;font-size:13.5px;outline:none;transition:border-color .2s}
.field-label-input:focus{border-color:var(--accent)}
.req-toggle-pill{display:flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border);border-radius:99px;padding:6px 13px;cursor:pointer;font-size:12px;color:var(--text2);white-space:nowrap;user-select:none}
.req-toggle-pill input{accent-color:var(--accent);margin:0}.req-toggle-pill.on{border-color:var(--accent);color:var(--accent2);background:rgba(108,138,255,.08)}
.options-panel{background:var(--bg3);border-top:1px solid var(--border);padding:14px 20px 16px;display:flex;flex-direction:column;gap:10px}
.options-hint{font-size:12px;color:var(--text3)}
.options-list{display:flex;flex-direction:column;gap:7px}.option-item{display:flex;align-items:center;gap:8px}
.option-input{flex:1;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:13px;outline:none}
.option-input:focus{border-color:var(--accent)}.option-add-row{display:flex;gap:8px}
.sections-wrap{display:flex;flex-direction:column;gap:16px}
.section-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.section-card.depth-1{background:var(--bg3);border-color:var(--border2)}.section-card.depth-2{background:var(--bg2)}
.section-header{padding:14px 18px;background:var(--card2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.section-card.depth-1 .section-header{background:rgba(108,138,255,.05)}
.section-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.section-icon{font-size:15px}
.section-pts-wrap{display:flex;align-items:center;gap:6px}.section-pts-label{color:var(--text2);font-size:12px}.q-pts-info{color:var(--text3);font-size:11px}
.section-actions{display:flex;gap:8px;align-items:center}.section-body{padding:14px 18px;display:flex;flex-direction:column;gap:8px}
.empty-section{color:var(--text3);font-size:12.5px;padding:14px;text-align:center;border:1px dashed var(--border);border-radius:8px}
.question-row{display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px}
.q-drag{color:var(--text3);cursor:grab}.q-text{flex:1;font-size:13.5px}.q-points{display:flex;align-items:center;gap:4px}
.points-input{background:var(--bg2);border:1px solid var(--border2);border-radius:6px;color:var(--accent2);font-size:14px;font-weight:600;width:64px;padding:4px 8px;text-align:right;outline:none;font-family:inherit}
.points-input:focus{border-color:var(--accent)}.section-pts{width:72px}.pts-label{color:var(--text2);font-size:12px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:8px;font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer;border:none;transition:all .18s}
.btn.primary{background:var(--accent);color:#fff}.btn.primary:hover:not(:disabled){background:var(--accent2)}
.btn.secondary{background:var(--bg3);color:var(--text);border:1px solid var(--border2)}.btn.secondary:hover:not(:disabled){border-color:var(--accent);color:var(--accent2)}
.btn:disabled{opacity:.55;cursor:not-allowed}.btn.lg{padding:13px 28px;font-size:15px}
.btn-sm{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:6px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;border:none;transition:all .18s}
.btn-sm.primary{background:var(--accent);color:#fff}.btn-sm.primary:hover{opacity:.88}
.btn-sm.secondary{background:var(--bg3);color:var(--text2);border:1px solid var(--border2)}.btn-sm.secondary:hover{border-color:var(--accent);color:var(--accent2)}
.btn-icon{background:none;border:none;cursor:pointer;font-size:16px;padding:4px;border-radius:4px;transition:opacity .2s;display:inline-flex;align-items:center}
.btn-icon:hover{opacity:.7}.btn-icon.danger{color:var(--red)}.btn-icon.sm{font-size:14px}.btn-icon:disabled{opacity:.4;cursor:not-allowed}
.btn-add-section{width:100%;padding:14px;border:2px dashed var(--border2);border-radius:var(--radius);background:transparent;color:var(--text2);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-add-section:hover{border-color:var(--accent);color:var(--accent);background:rgba(108,138,255,.04)}
.meta-panel .meta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;padding:16px 20px 20px}
.meta-field{display:flex;flex-direction:column}
.meta-label{display:block;font-size:11.5px;color:var(--text2);font-weight:600;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px}
.meta-input{width:100%;background:var(--bg3);border:1.5px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:inherit;font-size:14px;outline:none;transition:border-color .2s;appearance:none}
.meta-input:focus{border-color:var(--accent)}.meta-input.error{border-color:var(--red)}
select.meta-input{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238b93b0' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px;cursor:pointer}
.req-star{color:var(--red);margin-left:2px}
.error-msg{background:rgba(240,88,88,.08);border:1px solid var(--red);color:var(--red);padding:10px 16px;border-radius:8px;margin:0 20px 16px;font-size:13px}
.score-preview{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;display:flex;align-items:center;gap:14px}
.score-bar-wrap{flex:1;height:10px;background:var(--bg3);border-radius:99px;overflow:hidden}
.score-bar{height:100%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:99px;transition:width .4s ease}
.score-preview-text{color:var(--text2);font-size:13px;white-space:nowrap}
.submit-section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.submit-section.depth-1{background:var(--bg3)}
.submit-sec-header{padding:14px 18px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;background:var(--card2);border-bottom:1px solid var(--border)}
.submit-section.depth-1 .submit-sec-header{background:rgba(108,138,255,.05)}
.submit-sec-title{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px}
.sec-badge{background:var(--bg3);border:1px solid var(--border);padding:2px 8px;border-radius:99px;font-size:11px;font-weight:500;color:var(--text2)}
.sec-maxpts{color:var(--accent);font-weight:600;font-size:13px}.submit-sec-body{padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.answer-row{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 16px;transition:opacity .2s;flex-wrap:wrap}
.answer-row.row-na{opacity:.42}.answer-q{flex:1;min-width:180px}.answer-q-text{font-size:13.5px}.answer-q-pts{color:var(--accent);font-size:12px;font-weight:600;margin-left:8px}
.answer-choices{display:flex;gap:8px}
.choice-btn{padding:6px 14px;border-radius:6px;border:1.5px solid var(--border2);background:var(--bg2);color:var(--text2);font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:all .18s}
.choice-btn:hover{border-color:var(--accent)}.choice-btn.yes.active{background:rgba(62,207,142,.12);border-color:var(--green);color:var(--green)}
.choice-btn.no.active{background:rgba(240,88,88,.1);border-color:var(--red);color:var(--red)}.choice-btn.na.active{background:rgba(108,138,255,.1);border-color:var(--accent);color:var(--accent)}
.submit-footer{display:flex;justify-content:space-between;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px}
.final-score{font-size:14px;color:var(--text2)}.final-score strong{color:var(--text)}
.success-card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:48px 40px;text-align:center;max-width:380px;display:flex;flex-direction:column;align-items:center;gap:16px;box-shadow:var(--shadow)}
.success-icon{font-size:52px}.score-big{font-family:'DM Serif Display',serif;font-size:60px;color:var(--green);letter-spacing:-2px;line-height:1}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 16px;text-align:center}
.stat-num{font-family:'DM Serif Display',serif;font-size:34px;color:var(--text);letter-spacing:-1px}.stat-num.green{color:var(--green)}.stat-num.red{color:var(--red)}
.stat-lbl{color:var(--text2);font-size:11.5px;margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
.report-toolbar{display:flex;gap:12px;align-items:center}
.search-input{flex:1;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-family:inherit;font-size:13.5px;outline:none}
.search-input:focus{border-color:var(--accent)}
.report-table-wrap{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--border)}
.report-table{width:100%;border-collapse:collapse;font-size:13px}
.report-table th{background:var(--card2);color:var(--text2);text-align:left;padding:12px 14px;border-bottom:1px solid var(--border);white-space:nowrap;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}
.report-table th.sortable{cursor:pointer;user-select:none}.report-table th.sortable:hover{color:var(--text)}
.report-table td{padding:12px 14px;border-bottom:1px solid var(--border);color:var(--text)}
.report-row{cursor:pointer;transition:background .12s}.report-row:hover td{background:rgba(108,138,255,.04)}.report-table tr:last-child td{border-bottom:none}
.score-pill{padding:3px 10px;border-radius:99px;font-weight:700;font-size:12px}
.score-pill.green{background:rgba(62,207,142,.1);color:var(--green)}.score-pill.yellow{background:rgba(245,166,35,.1);color:var(--yellow)}.score-pill.red{background:rgba(240,88,88,.1);color:var(--red)}
.empty-state{color:var(--text3);text-align:center;padding:60px 20px;font-size:15px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-card{background:var(--card);border:1px solid var(--border2);border-radius:16px;max-width:620px;width:100%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.modal-card.small{max-width:420px}
.modal-header{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid var(--border);background:var(--card2)}
.modal-header h3{font-family:'DM Serif Display',serif;font-size:20px}
.modal-body{overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column;gap:16px}
.detail-meta{display:flex;flex-direction:column;gap:8px}.detail-meta-row{display:flex;gap:10px;font-size:13.5px}
.detail-label{color:var(--text2);min-width:150px;font-weight:600}.detail-score{text-align:center;padding:8px}
.detail-questions{display:flex;flex-direction:column;gap:8px}
.detail-q-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;background:var(--bg3);border-radius:8px;padding:10px 14px}
.detail-q-text{font-size:13px;flex:1;display:flex;flex-direction:column;gap:2px}
.detail-q-path{font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.3px}.detail-q-pts{color:var(--text3);font-size:11px}
.answer-badge{padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap}
.answer-badge.yes{background:rgba(62,207,142,.1);color:var(--green)}.answer-badge.no{background:rgba(240,88,88,.1);color:var(--red)}
.answer-badge.na{background:rgba(108,138,255,.1);color:var(--accent)}.answer-badge.none{background:var(--bg2);color:var(--text3)}
@media(max-width:768px){.builder-layout{flex-direction:column}.forms-sidebar{width:100%;position:static}.sidebar-list{max-height:200px}.stats-row{grid-template-columns:repeat(2,1fr)}.answer-row{flex-direction:column;align-items:flex-start}.page-hero-top{flex-direction:column}}
`
