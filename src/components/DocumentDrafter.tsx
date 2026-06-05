import React, { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileText, Upload, Wand2, Download, Trash2, ChevronRight, Loader2, Check, Edit3, X, Plus } from 'lucide-react'
import type { AISettings, WorkspaceSnapshot } from '../domain'
import {
  type TemplateVariable,
  type TemplateMetadata,
  type TemplateListItem,
  type VariableDetectionResult,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  updateTemplateMetadata,
  readDocxBase64,
  saveDocx,
  convertDocumentToTemplate,
  draftDocument,
} from '../storage/drafting'
import { isAiReady } from '../storage/ai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type View = 'list' | 'convert' | 'review' | 'draft'

interface Props {
  snapshot: WorkspaceSnapshot
  aiSettings: AISettings
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DocumentDrafter({ snapshot, aiSettings }: Props) {
  const [view, setView] = useState<View>('list')
  const [templates, setTemplates] = useState<TemplateListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  // Convert flow state
  const [sourceDocxBase64, setSourceDocxBase64] = useState<string | null>(null)
  const [sourceFileName, setSourceFileName] = useState<string>('')
  const [detection, setDetection] = useState<VariableDetectionResult | null>(null)
  const [editVariables, setEditVariables] = useState<TemplateVariable[]>([])
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [templateBase64, setTemplateBase64] = useState<string | null>(null)

  // Draft flow state
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateListItem | null>(null)
  const [templateMeta, setTemplateMeta] = useState<TemplateMetadata | null>(null)
  const [templateDocxBase64, setTemplateDocxBase64] = useState<string | null>(null)
  const [draftValues, setDraftValues] = useState<Record<string, string>>({})
  const [generatedBase64, setGeneratedBase64] = useState<string | null>(null)

  // Load templates
  const refreshTemplates = useCallback(async () => {
    try {
      const list = await listTemplates(snapshot.workspacePath)
      setTemplates(list)
    } catch (e) {
      setError(String(e))
    }
  }, [snapshot.workspacePath])

  useEffect(() => {
    refreshTemplates()
  }, [refreshTemplates])

  // -----------------------------------------------------------------------
  // Upload & Convert
  // -----------------------------------------------------------------------

  const handleUpload = async () => {
    try {
      // Use Tauri dialog to pick a .docx file
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
      setSourceDocxBase64(base64)
      setView('convert')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  const handleStartConversion = async () => {
    if (!sourceDocxBase64) return
    if (!isAiReady(aiSettings)) {
      setError('请先在设置中配置 AI（填写 API Key）')
      return
    }

    setLoading(true)
    setError(null)
    setProgress('正在用 AI 识别变量…')

    try {
      const result = await convertDocumentToTemplate(
        sourceDocxBase64,
        aiSettings,
        setProgress,
      )

      setDetection(result.metadata)
      setTemplateBase64(result.templateBase64)
      setEditTitle(result.metadata.title)
      setEditDescription(result.metadata.description)
      setEditCategory(result.metadata.category)
      setEditVariables([...result.metadata.variables])
      setView('review')
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
      const metadata: TemplateMetadata = {
        id: '',
        title: editTitle,
        description: editDescription,
        variables: editVariables,
        originalFilename: sourceFileName,
        createdAt: new Date().toISOString(),
        category: editCategory || undefined,
      }

      await saveTemplate(snapshot.workspacePath, templateBase64, metadata)
      await refreshTemplates()
      resetConvertState()
      setView('list')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const resetConvertState = () => {
    setSourceDocxBase64(null)
    setSourceFileName('')
    setDetection(null)
    setEditVariables([])
    setEditTitle('')
    setEditDescription('')
    setEditCategory('')
    setTemplateBase64(null)
  }

  // -----------------------------------------------------------------------
  // Draft (fill template & generate)
  // -----------------------------------------------------------------------

  const handleSelectTemplate = async (tpl: TemplateListItem) => {
    setSelectedTemplate(tpl)
    setLoading(true)
    setError(null)

    try {
      // Read template docx base64
      const base64 = await readDocxBase64(tpl.docxPath)
      setTemplateDocxBase64(base64)

      // Read metadata JSON via existing Tauri command
      const jsonContent = await invoke<string>('inbox_read_file_text', { path: tpl.metaPath })
      const parsed = JSON.parse(jsonContent) as TemplateMetadata

      const meta: TemplateMetadata = {
        id: tpl.id,
        title: tpl.title,
        description: tpl.description,
        variables: parsed.variables || [],
        originalFilename: tpl.originalFilename,
        createdAt: tpl.createdAt,
        category: tpl.category,
      }

      setTemplateMeta(meta)
      setDraftValues({})
      setGeneratedBase64(null)
      setView('draft')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleGenerate = async () => {
    if (!templateDocxBase64 || !templateMeta) return

    setLoading(true)
    setError(null)

    try {
      const base64 = await draftDocument(templateDocxBase64, draftValues)
      setGeneratedBase64(base64)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleSaveDocument = async () => {
    if (!generatedBase64) return

    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const filePath = await save({
        defaultPath: `${editTitle || templateMeta?.title || '文书'}.docx`,
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      })
      if (!filePath) return

      setLoading(true)
      await saveDocx(filePath, generatedBase64)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('确定删除此模板？')) return
    try {
      await deleteTemplate(snapshot.workspacePath, id)
      await refreshTemplates()
    } catch (e) {
      setError(String(e))
    }
  }

  // -----------------------------------------------------------------------
  // Variable editing helpers
  // -----------------------------------------------------------------------

  const updateVariable = (index: number, field: keyof TemplateVariable, value: string) => {
    setEditVariables((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const removeVariable = (index: number) => {
    setEditVariables((prev) => prev.filter((_, i) => i !== index))
  }

  const addVariable = () => {
    setEditVariables((prev) => [
      ...prev,
      { placeholder: `var_${prev.length + 1}`, label: '新变量', type: 'text' },
    ])
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={20} />
          <span style={{ fontWeight: 600, fontSize: 16 }}>文书起草</span>
          {view !== 'list' && (
            <button style={backBtnStyle} onClick={() => { setView('list'); resetConvertState(); setSelectedTemplate(null); }}>
              ← 返回列表
            </button>
          )}
        </div>
        {view === 'list' && (
          <button style={primaryBtnStyle} onClick={handleUpload} disabled={loading}>
            <Upload size={14} /> 上传文书转模板
          </button>
        )}
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
        {view === 'list' && (
          <TemplateList
            templates={templates}
            onSelect={handleSelectTemplate}
            onDelete={handleDeleteTemplate}
            onUpload={handleUpload}
            loading={loading}
          />
        )}
        {view === 'convert' && sourceDocxBase64 && (
          <ConvertView
            fileName={sourceFileName}
            onStart={handleStartConversion}
            loading={loading}
            aiReady={isAiReady(aiSettings)}
          />
        )}
        {view === 'review' && (
          <ReviewView
            title={editTitle}
            description={editDescription}
            category={editCategory}
            variables={editVariables}
            onTitleChange={setEditTitle}
            onDescriptionChange={setEditDescription}
            onCategoryChange={setEditCategory}
            onUpdateVariable={updateVariable}
            onRemoveVariable={removeVariable}
            onAddVariable={addVariable}
            onSave={handleSaveTemplate}
            loading={loading}
            rawResponse={detection?.rawResponse}
          />
        )}
        {view === 'draft' && selectedTemplate && templateMeta && (
          <DraftView
            template={selectedTemplate}
            metadata={templateMeta}
            values={draftValues}
            onValuesChange={setDraftValues}
            onGenerate={handleGenerate}
            onSave={handleSaveDocument}
            generated={!!generatedBase64}
            loading={loading}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function TemplateList({
  templates,
  onSelect,
  onDelete,
  onUpload,
  loading,
}: {
  templates: TemplateListItem[]
  onSelect: (t: TemplateListItem) => void
  onDelete: (id: string) => void
  onUpload: () => void
  loading: boolean
}) {
  if (templates.length === 0) {
    return (
      <div style={emptyStyle}>
        <FileText size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
        <p style={{ color: '#888', marginTop: 12 }}>暂无模板</p>
        <p style={{ color: '#aaa', fontSize: 13 }}>上传一篇写好的法律文书，AI 会自动识别变量并转化为可复用模板</p>
        <button style={{ ...primaryBtnStyle, marginTop: 16 }} onClick={onUpload} disabled={loading}>
          <Upload size={14} /> 上传文书转模板
        </button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#888', fontSize: 13 }}>共 {templates.length} 个模板</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {templates.map((tpl) => (
          <div key={tpl.id} style={templateCardStyle}>
            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => onSelect(tpl)}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>{tpl.title}</div>
              <div style={{ fontSize: 12, color: '#888', display: 'flex', gap: 12 }}>
                {tpl.category && <span>📂 {tpl.category}</span>}
                <span>📝 {tpl.variableCount} 个变量</span>
                <span>📄 {tpl.originalFilename}</span>
              </div>
              {tpl.description && (
                <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{tpl.description}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                style={iconBtnStyle}
                onClick={(e) => { e.stopPropagation(); onSelect(tpl); }}
                title="使用此模板起草"
              >
                <ChevronRight size={16} />
              </button>
              <button
                style={{ ...iconBtnStyle, color: '#e74c3c' }}
                onClick={(e) => { e.stopPropagation(); onDelete(tpl.id); }}
                title="删除模板"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ConvertView({
  fileName,
  onStart,
  loading,
  aiReady,
}: {
  fileName: string
  onStart: () => void
  loading: boolean
  aiReady: boolean
}) {
  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      <div style={sectionCardStyle}>
        <h3 style={sectionTitleStyle}>📄 文档已加载</h3>
        <p style={{ color: '#666', marginBottom: 16 }}>
          文件：<strong>{fileName}</strong>
        </p>
        <p style={{ color: '#666', marginBottom: 20 }}>
          点击下方按钮，AI 将自动分析文档内容，识别出需要作为模板变量的部分（如当事人姓名、案号、日期、金额等）。
        </p>
        {!aiReady && (
          <div style={warningStyle}>
            ⚠️ 请先在设置中配置 AI（填写 API Key），否则无法进行变量识别。
          </div>
        )}
        <button
          style={{ ...primaryBtnStyle, width: '100%', justifyContent: 'center', padding: '12px 20px' }}
          onClick={onStart}
          disabled={loading || !aiReady}
        >
          <Wand2 size={16} /> {loading ? '正在识别…' : 'AI 识别变量'}
        </button>
      </div>
    </div>
  )
}

function ReviewView({
  title, description, category, variables,
  onTitleChange, onDescriptionChange, onCategoryChange,
  onUpdateVariable, onRemoveVariable, onAddVariable,
  onSave, loading, rawResponse,
}: {
  title: string; description: string; category: string; variables: TemplateVariable[]
  onTitleChange: (v: string) => void; onDescriptionChange: (v: string) => void; onCategoryChange: (v: string) => void
  onUpdateVariable: (i: number, f: keyof TemplateVariable, v: string) => void
  onRemoveVariable: (i: number) => void; onAddVariable: () => void
  onSave: () => void; loading: boolean; rawResponse?: string
}) {
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={sectionCardStyle}>
        <h3 style={sectionTitleStyle}>✏️ 确认模板变量</h3>
        <p style={{ color: '#666', marginBottom: 16 }}>
          AI 已识别出以下变量。请检查并调整，确认后保存为模板。
        </p>

        {/* Basic info */}
        <div style={formGroupStyle}>
          <label style={labelStyle}>模板标题</label>
          <input style={inputStyle} value={title} onChange={(e) => onTitleChange(e.target.value)} />
        </div>
        <div style={formGroupStyle}>
          <label style={labelStyle}>模板描述</label>
          <input style={inputStyle} value={description} onChange={(e) => onDescriptionChange(e.target.value)} />
        </div>
        <div style={formGroupStyle}>
          <label style={labelStyle}>分类</label>
          <select style={inputStyle} value={category} onChange={(e) => onCategoryChange(e.target.value)}>
            <option value="">请选择</option>
            <option value="诉讼">诉讼</option>
            <option value="非诉">非诉</option>
            <option value="合同">合同</option>
            <option value="其他">其他</option>
          </select>
        </div>

        {/* Variables */}
        <h4 style={{ ...sectionTitleStyle, fontSize: 14, marginTop: 20 }}>
          变量列表 ({variables.length})
        </h4>
        {variables.length === 0 && (
          <p style={{ color: '#999', padding: 12 }}>AI 未识别到变量，您可以手动添加。</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {variables.map((v, i) => (
            <div key={i} style={variableRowStyle}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 40px', gap: 8, alignItems: 'center' }}>
                <input
                  style={inputStyle}
                  value={v.placeholder}
                  onChange={(e) => onUpdateVariable(i, 'placeholder', e.target.value)}
                  placeholder="placeholder_name"
                />
                <input
                  style={inputStyle}
                  value={v.label}
                  onChange={(e) => onUpdateVariable(i, 'label', e.target.value)}
                  placeholder="中文标签"
                />
                <select
                  style={inputStyle}
                  value={v.type}
                  onChange={(e) => onUpdateVariable(i, 'type', e.target.value)}
                >
                  <option value="text">文本</option>
                  <option value="date">日期</option>
                  <option value="money">金额</option>
                  <option value="number">数字</option>
                  <option value="long_text">长文本</option>
                </select>
                <button style={iconBtnStyle} onClick={() => onRemoveVariable(i)} title="移除">
                  <X size={14} />
                </button>
              </div>
              {v.example && (
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 4, paddingLeft: 4 }}>
                  示例：{v.example}
                </div>
              )}
            </div>
          ))}
        </div>
        <button style={addBtnStyle} onClick={onAddVariable}>
          <Plus size={14} /> 添加变量
        </button>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button style={{ ...primaryBtnStyle, flex: 1, justifyContent: 'center' }} onClick={onSave} disabled={loading}>
            <Check size={14} /> {loading ? '保存中…' : '保存模板'}
          </button>
        </div>

        {/* Debug: raw AI response */}
        {rawResponse && (
          <div style={{ marginTop: 16 }}>
            <button style={linkBtnStyle} onClick={() => setShowRaw(!showRaw)}>
              {showRaw ? '隐藏' : '查看'} AI 原始响应
            </button>
            {showRaw && (
              <pre style={{ ...codeBlockStyle, marginTop: 8 }}>{rawResponse}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DraftView({
  template, metadata, values, onValuesChange, onGenerate, onSave, generated, loading,
}: {
  template: TemplateListItem; metadata: TemplateMetadata; values: Record<string, string>
  onValuesChange: (v: Record<string, string>) => void; onGenerate: () => void
  onSave: () => void; generated: boolean; loading: boolean
}) {
  const setValue = (key: string, val: string) => {
    onValuesChange({ ...values, [key]: val })
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      <div style={sectionCardStyle}>
        <h3 style={sectionTitleStyle}>📝 {template.title}</h3>
        {template.description && <p style={{ color: '#666', marginBottom: 16 }}>{template.description}</p>}

        <h4 style={{ ...sectionTitleStyle, fontSize: 14 }}>填写变量</h4>
        {metadata.variables.length === 0 ? (
          <p style={{ color: '#999', padding: 12 }}>此模板没有定义变量。</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {metadata.variables.map((v) => (
              <div key={v.placeholder} style={formGroupStyle}>
                <label style={labelStyle}>
                  {v.label}
                  <span style={{ fontSize: 11, color: '#aaa', marginLeft: 8 }}>
                    {'{'}{v.placeholder}{'}'}
                  </span>
                </label>
                {v.type === 'long_text' ? (
                  <textarea
                    style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                    value={values[v.placeholder] || ''}
                    onChange={(e) => setValue(v.placeholder, e.target.value)}
                    placeholder={v.example || v.description || ''}
                  />
                ) : (
                  <input
                    style={inputStyle}
                    type={v.type === 'date' ? 'date' : 'text'}
                    value={values[v.placeholder] || ''}
                    onChange={(e) => setValue(v.placeholder, e.target.value)}
                    placeholder={v.example || v.description || ''}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button
            style={{ ...primaryBtnStyle, flex: 1, justifyContent: 'center' }}
            onClick={onGenerate}
            disabled={loading}
          >
            <Wand2 size={14} /> {loading ? '生成中…' : '生成文书'}
          </button>
          {generated && (
            <button
              style={{ ...successBtnStyle, flex: 1, justifyContent: 'center' }}
              onClick={onSave}
              disabled={loading}
            >
              <Download size={14} /> 保存为 .docx
            </button>
          )}
        </div>
        {generated && (
          <div style={{ marginTop: 12, padding: 12, background: '#f0fdf4', borderRadius: 8, color: '#16a34a', fontSize: 13 }}>
            <Check size={14} /> 文书已生成，点击"保存为 .docx"选择保存位置。
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 20px',
  borderBottom: '1px solid #e5e7eb',
  background: '#fafafa',
}

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 16px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const successBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: '#16a34a',
}

const backBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  padding: '4px 12px',
  fontSize: 13,
  cursor: 'pointer',
  color: '#555',
}

const iconBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 6,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  color: '#666',
}

const addBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'none',
  border: '1px dashed #d1d5db',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 13,
  cursor: 'pointer',
  color: '#666',
  marginTop: 8,
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#2563eb',
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'underline',
  padding: 0,
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 18,
  color: '#999',
  padding: 0,
  marginLeft: 8,
}

const errorBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 20px',
  background: '#fef2f2',
  color: '#dc2626',
  fontSize: 13,
  borderBottom: '1px solid #fecaca',
}

const progressBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 20px',
  background: '#eff6ff',
  color: '#2563eb',
  fontSize: 13,
  borderBottom: '1px solid #bfdbfe',
}

const emptyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 80,
  textAlign: 'center',
}

const templateCardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '12px 16px',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  background: '#fff',
  transition: 'border-color 0.15s',
}

const sectionCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 24,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const formGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 12,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: '#374151',
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 13,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const variableRowStyle: React.CSSProperties = {
  padding: '8px',
  background: '#f9fafb',
  borderRadius: 6,
  border: '1px solid #f3f4f6',
}

const warningStyle: React.CSSProperties = {
  padding: '10px 14px',
  background: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: 8,
  color: '#92400e',
  fontSize: 13,
  marginBottom: 16,
}

const codeBlockStyle: React.CSSProperties = {
  background: '#f3f4f6',
  padding: 12,
  borderRadius: 6,
  fontSize: 11,
  overflow: 'auto',
  maxHeight: 300,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}
