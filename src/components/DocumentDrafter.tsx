import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileText, Upload, Wand2, Download, Trash2, Loader2, Check, X, Plus, PenTool } from 'lucide-react'
import type { AISettings, WorkspaceSnapshot } from '../domain'
import {
  type TemplateVariable,
  type TemplateMetadata,
  type TemplateListItem,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  readDocxBase64,
  saveDocx,
  convertDocumentToTemplate,
  draftDocument,
} from '../storage/drafting'
import { isAiReady } from '../storage/ai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'draft' | 'templates'
type TemplateSubView = 'list' | 'convert' | 'review'
type DraftSubView = 'select' | 'form' | 'done'

interface Props {
  snapshot: WorkspaceSnapshot
  aiSettings: AISettings
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DocumentDrafter({ snapshot, aiSettings }: Props) {
  const [tab, setTab] = useState<Tab>('draft')
  const [templates, setTemplates] = useState<TemplateListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  // Template conversion state
  const [tplSubView, setTplSubView] = useState<TemplateSubView>('list')
  const [sourceFileName, setSourceFileName] = useState('')
  const [editVariables, setEditVariables] = useState<TemplateVariable[]>([])
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [templateBase64, setTemplateBase64] = useState<string | null>(null)
  const [detectionRaw, setDetectionRaw] = useState<string | undefined>(undefined)

  // Drafting state
  const [draftSubView, setDraftSubView] = useState<DraftSubView>('select')
  const [templateMeta, setTemplateMeta] = useState<TemplateMetadata | null>(null)
  const [templateDocxBase64, setTemplateDocxBase64] = useState<string | null>(null)
  const [draftValues, setDraftValues] = useState<Record<string, string>>({})
  const [generatedBase64, setGeneratedBase64] = useState<string | null>(null)

  const refreshTemplates = useCallback(async () => {
    try {
      const list = await listTemplates(snapshot.workspacePath)
      setTemplates(list)
    } catch (e) { setError(String(e)) }
  }, [snapshot.workspacePath])

  useEffect(() => { refreshTemplates() }, [refreshTemplates])

  // -----------------------------------------------------------------------
  // Template conversion flow
  // -----------------------------------------------------------------------

  const handleUpload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      })
      if (!selected) return
      const filePath = Array.isArray(selected) ? selected[0] : selected
      setSourceFileName(filePath.split('/').pop() || 'document.docx')
      setLoading(true)
      setError(null)
      setProgress('正在读取文档…')
      const base64 = await readDocxBase64(filePath)
      setProgress('正在用 AI 分析变量…')
      const result = await convertDocumentToTemplate(base64, aiSettings, setProgress)
      setTemplateBase64(result.templateBase64)
      setEditTitle(result.metadata.title)
      setEditDescription(result.metadata.description)
      setEditCategory(result.metadata.category)
      setEditVariables([...result.metadata.variables])
      setDetectionRaw(result.metadata.rawResponse)
      setTplSubView('review')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  const handleSaveTemplate = async () => {
    if (!templateBase64) return
    setLoading(true)
    setError(null)
    try {
      await saveTemplate(snapshot.workspacePath, templateBase64, {
        id: '', title: editTitle, description: editDescription,
        variables: editVariables, originalFilename: sourceFileName,
        createdAt: new Date().toISOString(), category: editCategory || undefined,
      })
      await refreshTemplates()
      resetConvertState()
      setTplSubView('list')
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  const resetConvertState = () => {
    setSourceFileName('')
    setEditVariables([]); setEditTitle(''); setEditDescription(''); setEditCategory('')
    setTemplateBase64(null); setDetectionRaw(undefined)
  }

  // -----------------------------------------------------------------------
  // Drafting flow
  // -----------------------------------------------------------------------

  const handleSelectTemplate = async (tpl: TemplateListItem) => {
    setLoading(true)
    setError(null)
    try {
      const base64 = await readDocxBase64(tpl.docxPath)
      setTemplateDocxBase64(base64)
      const jsonContent = await invoke<string>('inbox_read_file_text', { path: tpl.metaPath })
      const parsed = JSON.parse(jsonContent) as TemplateMetadata
      setTemplateMeta({
        id: tpl.id, title: tpl.title, description: tpl.description,
        variables: parsed.variables || [], originalFilename: tpl.originalFilename,
        createdAt: tpl.createdAt, category: tpl.category,
      })
      setDraftValues({})
      setGeneratedBase64(null)
      setDraftSubView('form')
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  const handleGenerate = async () => {
    if (!templateDocxBase64 || !templateMeta) return
    setLoading(true)
    setError(null)
    try {
      const base64 = await draftDocument(templateDocxBase64, draftValues)
      setGeneratedBase64(base64)
      setDraftSubView('done')
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  const handleSaveDocument = async () => {
    if (!generatedBase64) return
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const filePath = await save({
        defaultPath: `${templateMeta?.title || '文书'}_${new Date().toISOString().slice(0, 10)}.docx`,
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      })
      if (!filePath) return
      setLoading(true)
      await saveDocx(filePath, generatedBase64)
      setError(null)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('确定删除此模板？')) return
    try {
      await deleteTemplate(snapshot.workspacePath, id)
      await refreshTemplates()
    } catch (e) { setError(String(e)) }
  }

  const updateVariable = (index: number, field: keyof TemplateVariable, value: string) => {
    setEditVariables((prev) => {
      const next = [...prev]; next[index] = { ...next[index], [field]: value }; return next
    })
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={tabBarStyle}>
        <button style={tab === 'draft' ? activeTabBtnStyle : tabBtnStyle} onClick={() => { setTab('draft'); setDraftSubView('select'); }}>
          <PenTool size={15} /> 文书起草
        </button>
        <button style={tab === 'templates' ? activeTabBtnStyle : tabBtnStyle} onClick={() => { setTab('templates'); setTplSubView('list'); }}>
          <FileText size={15} /> 模板管理
        </button>
      </div>

      {/* Error & progress */}
      {error && (
        <div style={errorBarStyle}>
          <span>{error}</span>
          <button style={closeBtnStyle} onClick={() => setError(null)}>×</button>
        </div>
      )}
      {progress && (
        <div style={progressBarStyle}>
          <Loader2 size={14} className="spinning" /> {progress}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {tab === 'draft' && (
          <DraftTab
            subView={draftSubView}
            templates={templates}
            templateMeta={templateMeta}
            draftValues={draftValues}
            loading={loading}
            onSelectTemplate={handleSelectTemplate}
            onValuesChange={setDraftValues}
            onGenerate={handleGenerate}
            onSave={handleSaveDocument}
            onBackToSelect={() => { setDraftSubView('select'); setTemplateMeta(null); }}
            onNewDraft={() => { setDraftSubView('select'); setGeneratedBase64(null); setDraftValues({}); }}
          />
        )}
        {tab === 'templates' && (
          <TemplateTab
            subView={tplSubView}
            templates={templates}
            loading={loading}
            aiReady={isAiReady(aiSettings)}
            sourceFileName={sourceFileName}
            editTitle={editTitle}
            editDescription={editDescription}
            editCategory={editCategory}
            editVariables={editVariables}
            detectionRaw={detectionRaw}
            onUpload={handleUpload}
            onSave={handleSaveTemplate}
            onCancelConvert={() => { resetConvertState(); setTplSubView('list'); }}
            onDelete={handleDeleteTemplate}
            onTitleChange={setEditTitle}
            onDescriptionChange={setEditDescription}
            onCategoryChange={setEditCategory}
            onUpdateVariable={updateVariable}
            onRemoveVariable={(i) => setEditVariables((p) => p.filter((_, idx) => idx !== i))}
            onAddVariable={() => setEditVariables((p) => [...p, { placeholder: `var_${p.length + 1}`, label: '新变量', type: 'text' }])}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Draft Tab — the main "起草" workflow
// ---------------------------------------------------------------------------

function DraftTab({
  subView, templates, templateMeta, draftValues, loading,
  onSelectTemplate, onValuesChange, onGenerate, onSave, onBackToSelect, onNewDraft,
}: {
  subView: DraftSubView
  templates: TemplateListItem[]
  templateMeta: TemplateMetadata | null
  draftValues: Record<string, string>
  loading: boolean
  onSelectTemplate: (t: TemplateListItem) => void
  onValuesChange: (v: Record<string, string>) => void
  onGenerate: () => void
  onSave: () => void
  onBackToSelect: () => void
  onNewDraft: () => void
}) {
  // Step 1: Select template
  if (subView === 'select') {
    if (templates.length === 0) {
      return (
        <div style={emptyStyle}>
          <PenTool size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
          <p style={{ color: '#555', fontWeight: 500, marginTop: 12, fontSize: 15 }}>暂无可使用的模板</p>
          <p style={{ color: '#999', fontSize: 13, maxWidth: 380, lineHeight: 1.6 }}>
            请先到「模板管理」标签页上传一篇已写好的法律文书，AI 会自动识别变量并转化为模板。
          </p>
        </div>
      )
    }
    return (
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        <h3 style={sectionTitleStyle}>选择模板开始起草</h3>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 16 }}>
          点击下方模板卡片，进入变量填写并生成新文书。
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map((tpl) => (
            <div key={tpl.id} style={cardStyle} onClick={() => onSelectTemplate(tpl)}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{tpl.title}</div>
                <div style={{ fontSize: 12, color: '#888', display: 'flex', gap: 12 }}>
                  {tpl.category && <span>📂 {tpl.category}</span>}
                  <span>📝 {tpl.variableCount} 个变量</span>
                </div>
                {tpl.description && <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{tpl.description}</div>}
              </div>
              <button style={primaryBtnSmallStyle}>
                <PenTool size={13} /> 开始起草
              </button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Step 2: Fill variables
  if (subView === 'form' && templateMeta) {
    const setValue = (key: string, val: string) => onValuesChange({ ...draftValues, [key]: val })
    return (
      <div style={{ maxWidth: 650, margin: '0 auto' }}>
        <div style={cardBlockStyle}>
          <button style={linkBtnStyle} onClick={onBackToSelect}>← 返回选择模板</button>
          <h3 style={{ ...sectionTitleStyle, marginTop: 12 }}>
            <PenTool size={18} /> {templateMeta.title}
          </h3>
          {templateMeta.description && <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>{templateMeta.description}</p>}

          {templateMeta.variables.length === 0 ? (
            <div style={{ color: '#999', padding: '16px 0' }}>
              此模板没有定义变量，点击下方直接生成文书。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {templateMeta.variables.map((v, idx) => (
                <div key={v.placeholder} style={formGroupStyle}>
                  <label style={labelStyle}>
                    <span style={{ color: '#2563eb', fontWeight: 600, marginRight: 6 }}>#{idx + 1}</span>
                    {v.label}
                    <span style={{ fontSize: 10, color: '#bbb', marginLeft: 8, fontFamily: 'monospace' }}>{`{${v.placeholder}}`}</span>
                  </label>
                  {v.type === 'long_text' ? (
                    <textarea
                      style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                      value={draftValues[v.placeholder] || ''}
                      onChange={(e) => setValue(v.placeholder, e.target.value)}
                      placeholder={v.example || v.description || `请输入${v.label}`}
                    />
                  ) : (
                    <input
                      style={inputStyle}
                      type={v.type === 'date' ? 'date' : 'text'}
                      value={draftValues[v.placeholder] || ''}
                      onChange={(e) => setValue(v.placeholder, e.target.value)}
                      placeholder={v.example || v.description || `请输入${v.label}`}
                    />
                  )}
                  {v.description && <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{v.description}</div>}
                </div>
              ))}
            </div>
          )}

          <button
            style={{ ...primaryBtnStyle, width: '100%', justifyContent: 'center', padding: '12px 20px', marginTop: 24, fontSize: 14 }}
            onClick={onGenerate}
            disabled={loading}
          >
            <Wand2 size={16} /> {loading ? '正在生成文书…' : '生成文书'}
          </button>
        </div>
      </div>
    )
  }

  // Step 3: Done — save
  if (subView === 'done') {
    return (
      <div style={{ maxWidth: 500, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>文书已生成</h3>
        <p style={{ color: '#666', marginBottom: 24 }}>
          {templateMeta?.title || '文书'} 已准备就绪，请选择保存位置。
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button style={{ ...successBtnStyle, padding: '12px 28px', fontSize: 14 }} onClick={onSave} disabled={loading}>
            <Download size={16} /> 保存为 .docx
          </button>
          <button style={{ ...secondaryBtnStyle, padding: '12px 28px', fontSize: 14 }} onClick={onNewDraft}>
            再次起草
          </button>
        </div>
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Template Tab — upload & convert management
// ---------------------------------------------------------------------------

function TemplateTab({
  subView, templates, loading, aiReady, sourceFileName,
  editTitle, editDescription, editCategory, editVariables, detectionRaw,
  onUpload, onSave, onCancelConvert, onDelete,
  onTitleChange, onDescriptionChange, onCategoryChange,
  onUpdateVariable, onRemoveVariable, onAddVariable,
}: {
  subView: TemplateSubView
  templates: TemplateListItem[]
  loading: boolean
  aiReady: boolean
  sourceFileName: string
  editTitle: string
  editDescription: string
  editCategory: string
  editVariables: TemplateVariable[]
  detectionRaw?: string
  onUpload: () => void
  onSave: () => void
  onCancelConvert: () => void
  onDelete: (id: string) => void
  onTitleChange: (v: string) => void
  onDescriptionChange: (v: string) => void
  onCategoryChange: (v: string) => void
  onUpdateVariable: (i: number, f: keyof TemplateVariable, v: string) => void
  onRemoveVariable: (i: number) => void
  onAddVariable: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)

  // List view
  if (subView === 'list') {
    return (
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={sectionTitleStyle}>已有模板 ({templates.length})</h3>
          <button style={primaryBtnStyle} onClick={onUpload} disabled={loading || !aiReady}>
            <Upload size={14} /> 上传文书转模板
          </button>
        </div>
        {!aiReady && (
          <div style={warningStyle}>⚠️ 请先在设置中配置 AI（填写 API Key），否则无法识别变量。</div>
        )}
        {templates.length === 0 ? (
          <div style={emptyStyle}>
            <FileText size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
            <p style={{ color: '#888', marginTop: 12 }}>暂无模板</p>
            <p style={{ color: '#aaa', fontSize: 13 }}>点击上方按钮，上传一篇写好的文书转化模板</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {templates.map((tpl) => (
              <div key={tpl.id} style={cardStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>{tpl.title}</div>
                  <div style={{ fontSize: 12, color: '#888', display: 'flex', gap: 12 }}>
                    {tpl.category && <span>📂 {tpl.category}</span>}
                    <span>📝 {tpl.variableCount} 个变量</span>
                    <span>📄 {tpl.originalFilename}</span>
                  </div>
                </div>
                <button style={iconBtnStyle} onClick={() => onDelete(tpl.id)} title="删除">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Review view — after AI detection
  if (subView === 'review') {
    return (
      <div style={{ maxWidth: 750, margin: '0 auto' }}>
        <div style={cardBlockStyle}>
          <h3 style={sectionTitleStyle}>✏️ 确认模板变量</h3>
          <p style={{ color: '#666', fontSize: 13, marginBottom: 16 }}>
            AI 已分析文档 <strong>{sourceFileName}</strong>，识别出以下变量。请检查后保存为模板。
          </p>
          <div style={formGroupStyle}>
            <label style={labelStyle}>模板标题</label>
            <input style={inputStyle} value={editTitle} onChange={(e) => onTitleChange(e.target.value)} />
          </div>
          <div style={formGroupStyle}>
            <label style={labelStyle}>模板描述</label>
            <input style={inputStyle} value={editDescription} onChange={(e) => onDescriptionChange(e.target.value)} />
          </div>
          <div style={formGroupStyle}>
            <label style={labelStyle}>分类</label>
            <select style={inputStyle} value={editCategory} onChange={(e) => onCategoryChange(e.target.value)}>
              <option value="">请选择</option>
              <option value="诉讼">诉讼</option>
              <option value="非诉">非诉</option>
              <option value="合同">合同</option>
              <option value="其他">其他</option>
            </select>
          </div>

          <h4 style={{ ...sectionTitleStyle, fontSize: 14, marginTop: 20 }}>
            变量列表 ({editVariables.length})
          </h4>
          {editVariables.length === 0 && (
            <p style={{ color: '#999', padding: 12 }}>AI 未识别到变量，可手动添加。</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {editVariables.map((v, i) => (
              <div key={i} style={varRowStyle}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 36px', gap: 8, alignItems: 'center' }}>
                  <input style={inputStyle} value={v.placeholder} onChange={(e) => onUpdateVariable(i, 'placeholder', e.target.value)} placeholder="placeholder_name" />
                  <input style={inputStyle} value={v.label} onChange={(e) => onUpdateVariable(i, 'label', e.target.value)} placeholder="中文标签" />
                  <select style={inputStyle} value={v.type} onChange={(e) => onUpdateVariable(i, 'type', e.target.value)}>
                    <option value="text">文本</option><option value="date">日期</option><option value="money">金额</option>
                    <option value="number">数字</option><option value="long_text">长文本</option>
                  </select>
                  <button style={iconBtnStyle} onClick={() => onRemoveVariable(i)}><X size={14} /></button>
                </div>
                {v.example && <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>原文示例：{v.example}</div>}
              </div>
            ))}
          </div>
          <button style={addBtnStyle} onClick={onAddVariable}><Plus size={14} /> 添加变量</button>

          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button style={{ ...primaryBtnStyle, flex: 1, justifyContent: 'center' }} onClick={onSave} disabled={loading}>
              <Check size={14} /> {loading ? '保存中…' : '保存模板'}
            </button>
            <button style={{ ...secondaryBtnStyle, justifyContent: 'center' }} onClick={onCancelConvert}>
              取消
            </button>
          </div>

          {detectionRaw && (
            <div style={{ marginTop: 16 }}>
              <button style={linkBtnStyle} onClick={() => setShowRaw(!showRaw)}>
                {showRaw ? '隐藏' : '查看'} AI 原始响应
              </button>
              {showRaw && <pre style={{ ...codeBlockStyle, marginTop: 8 }}>{detectionRaw}</pre>}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const tabBarStyle: React.CSSProperties = {
  display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', background: '#fafafa', padding: '0 20px',
}

const tabBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '10px 20px', background: 'none', border: 'none',
  fontSize: 14, color: '#888', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: -2,
}

const activeTabBtnStyle: React.CSSProperties = {
  ...tabBtnStyle, color: '#2563eb', borderBottomColor: '#2563eb', fontWeight: 600,
}

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
}

const primaryBtnSmallStyle: React.CSSProperties = {
  ...primaryBtnStyle, padding: '6px 14px', fontSize: 12,
}

const successBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle, background: '#16a34a',
}

const secondaryBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle, background: '#fff', color: '#555', border: '1px solid #d1d5db',
}

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 4,
  display: 'inline-flex', alignItems: 'center', color: '#999',
}

const addBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: 'none', border: '1px dashed #d1d5db', borderRadius: 6,
  padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: '#666', marginTop: 8,
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#2563eb', fontSize: 13, cursor: 'pointer', padding: 0,
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#999', padding: 0, marginLeft: 8,
}

const errorBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 20px', background: '#fef2f2', color: '#dc2626', fontSize: 13, borderBottom: '1px solid #fecaca',
}

const progressBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 20px', background: '#eff6ff', color: '#2563eb', fontSize: 13, borderBottom: '1px solid #bfdbfe',
}

const emptyStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  padding: 60, textAlign: 'center',
}

const cardStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '14px 18px',
  border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', cursor: 'pointer',
}

const cardBlockStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
}

const formGroupStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: '#374151',
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
}

const varRowStyle: React.CSSProperties = {
  padding: '8px', background: '#f9fafb', borderRadius: 6, border: '1px solid #f3f4f6',
}

const warningStyle: React.CSSProperties = {
  padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a',
  borderRadius: 8, color: '#92400e', fontSize: 13, marginBottom: 16,
}

const codeBlockStyle: React.CSSProperties = {
  background: '#f3f4f6', padding: 12, borderRadius: 6, fontSize: 11,
  overflow: 'auto', maxHeight: 300, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
}
