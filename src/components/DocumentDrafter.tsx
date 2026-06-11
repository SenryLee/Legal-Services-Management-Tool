import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import type { AISettings, WorkspaceConfig, WorkspaceSnapshot } from '../domain'
import { isTauri, openInFinder, saveConfig } from '../storage'
import { aiChat, isAiReady } from '../storage/ai'
import {
  type TemplateListItem,
  type TemplateMetadata,
  type TemplateVariable,
  convertDocumentToTemplate,
  createBuiltinFreeDraftDocx,
  deleteTemplate,
  draftDocument,
  getTemplateDir,
  importTemplateFile,
  listTemplates,
  readDocxBase64,
  readTemplateMetadata,
  saveDocx,
  saveTemplate,
  syncTemplates,
  templateSupportsPlaceholder,
} from '../storage/drafting'
import {
  buildFreeDraftMessages,
  buildTemplateDraftMessages,
  normalizeFreeDraftResult,
  parseStructuredAiJson,
  resolveFreeDraftTemplate,
  type NormalizedFreeDraftResult,
} from '../storage/drafting-logic'
import { friendlyError } from '../shared/utils'

type DraftMode = 'template' | 'free'
type TemplateSubView = 'list' | 'review'
type DraftTurn = { role: 'user' | 'assistant'; content: string }

interface Props {
  snapshot: WorkspaceSnapshot
  aiSettings: AISettings
  onConfigSaved: (config: WorkspaceConfig) => void
  setStatus: (status: string) => void
}

const todayLabel = () => new Date().toISOString().slice(0, 10)

const templateStatusLabel = (template: TemplateListItem): string => {
  if (template.supportsFreeDraft) return '自由起草可用'
  if (template.status === 'new') return '新发现'
  if (template.status === 'needs_conversion') return '需转换'
  return '可用'
}

const syncNotice = (added: number, updated: number, incompatible: number): string => {
  if (added === 0 && updated === 0) return '模板扫描完成，没有新增模板。'
  const parts = [`新增 ${added} 个`, `更新 ${updated} 个`]
  if (incompatible > 0) parts.push(`${incompatible} 个需转换`)
  return `模板扫描完成：${parts.join('，')}。`
}

const stringifyCollected = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, String(raw ?? '').trim()])
      .filter(([, raw]) => raw),
  )
}

export default function DocumentDrafter({ snapshot, aiSettings, onConfigSaved, setStatus }: Props) {
  const [mode, setMode] = useState<DraftMode>('template')
  const [templates, setTemplates] = useState<TemplateListItem[]>([])
  const [templateDir, setTemplateDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')

  const [templateInput, setTemplateInput] = useState('')
  const [activeTemplate, setActiveTemplate] = useState<TemplateListItem | null>(null)
  const [activeTemplateMeta, setActiveTemplateMeta] = useState<TemplateMetadata | null>(null)
  const [activeTemplateBase64, setActiveTemplateBase64] = useState('')
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({})
  const [templateDocBase64, setTemplateDocBase64] = useState('')

  const [freeInput, setFreeInput] = useState('')
  const [freeDraft, setFreeDraft] = useState<NormalizedFreeDraftResult | null>(null)
  const [freeHistory, setFreeHistory] = useState<DraftTurn[]>([])

  const [tplSubView, setTplSubView] = useState<TemplateSubView>('list')
  const [sourceFileName, setSourceFileName] = useState('')
  const [editVariables, setEditVariables] = useState<TemplateVariable[]>([])
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [templateBase64, setTemplateBase64] = useState('')

  const aiReady = isAiReady(aiSettings)
  const defaultTemplateId = snapshot.config.drafting?.defaultFreeTemplateId ?? ''
  const autoScanTemplates = snapshot.config.drafting?.autoScanTemplates ?? true
  const defaultTemplate = templates.find((item) => item.id === defaultTemplateId) ?? null

  const refreshTemplates = useCallback(async (scan = autoScanTemplates, announce = false) => {
    try {
      if (scan) {
        const result = await syncTemplates(snapshot.workspacePath)
        setTemplates(result.templates)
        setTemplateDir(result.templateDir)
        if (announce) setNotice(syncNotice(result.added, result.updated, result.incompatible))
        return
      }
      setTemplates(await listTemplates(snapshot.workspacePath))
    } catch (error) {
      setNotice(`模板读取失败：${friendlyError(error)}`)
    }
  }, [autoScanTemplates, snapshot.workspacePath])

  useEffect(() => {
    void refreshTemplates()
  }, [refreshTemplates])

  useEffect(() => {
    getTemplateDir(snapshot.workspacePath)
      .then(setTemplateDir)
      .catch(() => setTemplateDir(''))
  }, [snapshot.workspacePath])

  const missingTemplateVariables = useMemo(() => {
    if (!activeTemplateMeta) return []
    return activeTemplateMeta.variables.filter((variable) => !templateValues[variable.placeholder]?.trim())
  }, [activeTemplateMeta, templateValues])

  const selectTemplate = async (template: TemplateListItem) => {
    setLoading(true)
    setNotice('')
    try {
      const [base64, metadata] = await Promise.all([
        readDocxBase64(template.docxPath),
        readTemplateMetadata(template),
      ])
      setActiveTemplate(template)
      setActiveTemplateBase64(base64)
      setActiveTemplateMeta(metadata)
      setTemplateValues({})
      setTemplateDocBase64('')
      setMode('template')
      setNotice(
        template.status === 'needs_conversion'
          ? '该文件尚未包含模板占位符，请用 AI 转模板或手动加入 {变量} 后重新扫描。'
          : `已选择模板：${template.title}`,
      )
    } catch (error) {
      setNotice(`模板打开失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const generateTemplateDoc = async (values: Record<string, string>) => {
    if (!activeTemplateMeta || !activeTemplateBase64) return
    const missing = activeTemplateMeta.variables.filter((variable) => !values[variable.placeholder]?.trim())
    if (missing.length > 0) {
      setNotice(`还缺少 ${missing.slice(0, 3).map((item) => item.label).join('、')}。`)
      return
    }
    const docBase64 = await draftDocument(activeTemplateBase64, values)
    setTemplateDocBase64(docBase64)
    setNotice('模板文书已生成，可保存为 .docx。')
  }

  const askAiForTemplateValues = async () => {
    if (!activeTemplateMeta) {
      setNotice('请先选择一个模板。')
      return
    }
    if (!templateInput.trim()) {
      setNotice('请先输入当事人、事实或需要填入模板的信息。')
      return
    }
    if (!aiReady) {
      setNotice('请先在设置中配置 AI 服务。')
      return
    }

    setLoading(true)
    setNotice('')
    try {
      const result = await aiChat(
        aiSettings,
        buildTemplateDraftMessages(templateInput, activeTemplateMeta.variables, templateValues),
      )
      const parsed = parseStructuredAiJson(result.content)
      const collected = stringifyCollected(parsed?.collected)
      const nextValues = { ...templateValues, ...collected }
      setTemplateValues(nextValues)

      const missing = activeTemplateMeta.variables.filter((variable) => !nextValues[variable.placeholder]?.trim())
      const question = typeof parsed?.question === 'string' ? parsed.question.trim() : ''
      if (missing.length > 0) {
        setNotice(question || `还需要补充：${missing.slice(0, 3).map((item) => item.label).join('、')}。`)
      } else {
        await generateTemplateDoc(nextValues)
      }
    } catch (error) {
      setNotice(`模板变量抽取失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const generateFreeDraft = async () => {
    if (!freeInput.trim()) {
      setNotice('请先描述你要起草的文书。')
      return
    }
    if (!aiReady) {
      setNotice('请先在设置中配置 AI 服务。')
      return
    }

    setLoading(true)
    setNotice('')
    try {
      const history = freeDraft
        ? [
            ...freeHistory,
            {
              role: 'assistant' as const,
              content: `上一版草稿：\n${freeDraft.draftBody || freeDraft.questions.join('\n')}`,
            },
          ]
        : freeHistory
      const result = await aiChat(aiSettings, buildFreeDraftMessages(freeInput, history))
      const parsed = parseStructuredAiJson(result.content)
      const normalized = normalizeFreeDraftResult(parsed)
      if (normalized.status === 'drafted' && !normalized.draftBody) {
        normalized.draftBody = result.content
      }
      setFreeDraft(normalized)
      const nextHistory: DraftTurn[] = [
        ...history,
        { role: 'user', content: freeInput },
        { role: 'assistant', content: normalized.draftBody || normalized.questions.join('\n') },
      ]
      setFreeHistory(nextHistory.slice(-8))
      setNotice(normalized.status === 'drafted' ? '自由起草初稿已生成。' : '信息不足，请按追问补充。')
      setFreeInput('')
    } catch (error) {
      setNotice(`自由起草失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const saveGeneratedDocx = async (base64: string, defaultName: string) => {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const filePath = await save({
      defaultPath: `${defaultName || '法律文书'}_${todayLabel()}.docx`,
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    })
    if (!filePath) return
    await saveDocx(filePath, base64)
    setStatus(`文书已保存：${filePath}`)
  }

  const exportFreeDraft = async () => {
    if (!freeDraft || freeDraft.status !== 'drafted' || !freeDraft.draftBody.trim()) {
      setNotice('请先生成自由起草初稿。')
      return
    }

    setLoading(true)
    setNotice('')
    try {
      const resolution = resolveFreeDraftTemplate(
        templates.map((item) => ({ id: item.id, title: item.title, docxPath: item.docxPath })),
        defaultTemplateId,
      )
      let outputBase64 = ''
      if (resolution.kind === 'template') {
        const base64 = await readDocxBase64(resolution.template.docxPath)
        if (await templateSupportsPlaceholder(base64, 'draft_body')) {
          outputBase64 = await draftDocument(base64, {
            draft_title: freeDraft.draftTitle || freeDraft.documentType || '法律文书草稿',
            document_type: freeDraft.documentType,
            draft_body: freeDraft.draftBody,
            generated_date: todayLabel(),
            risk_notes: freeDraft.riskNotes.join('\n'),
          })
        } else {
          outputBase64 = await createBuiltinFreeDraftDocx(freeDraft)
          setNotice('默认模板缺少 {draft_body}，已使用内置基础版式导出。')
        }
      } else {
        outputBase64 = await createBuiltinFreeDraftDocx(freeDraft)
        if (resolution.notice) setNotice(resolution.notice)
      }
      await saveGeneratedDocx(outputBase64, freeDraft.draftTitle || freeDraft.documentType || '自由起草')
    } catch (error) {
      setNotice(`自由起草导出失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async () => {
    if (!aiReady) {
      setNotice('请先在设置中配置 AI 服务，再上传文书转模板。')
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Word 文档', extensions: ['docx'] }] })
      if (!selected) return
      const filePath = Array.isArray(selected) ? selected[0] : selected
      setSourceFileName(filePath.split('/').pop() || 'document.docx')
      setLoading(true)
      const base64 = await readDocxBase64(filePath)
      const result = await convertDocumentToTemplate(base64, aiSettings)
      setTemplateBase64(result.templateBase64)
      setEditTitle(result.metadata.title)
      setEditDescription(result.metadata.description)
      setEditCategory(result.metadata.category)
      setEditVariables([...result.metadata.variables])
      setTplSubView('review')
    } catch (error) {
      setNotice(`模板转换失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleImportTemplate = async () => {
    if (!isTauri()) {
      setNotice('导入本地模板文件仅在桌面 App 中可用；浏览器演示可查看模板库结构。')
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Word 模板', extensions: ['docx'] }] })
      if (!selected) return
      const filePath = Array.isArray(selected) ? selected[0] : selected
      setLoading(true)
      await importTemplateFile(snapshot.workspacePath, filePath)
      const result = await syncTemplates(snapshot.workspacePath)
      setTemplates(result.templates)
      setTemplateDir(result.templateDir)
      setNotice(syncNotice(result.added, result.updated, result.incompatible))
    } catch (error) {
      setNotice(`模板导入失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenTemplateDir = async () => {
    if (!isTauri()) {
      setNotice('打开本地模板文件夹仅在桌面 App 中可用。')
      return
    }
    try {
      const dir = templateDir || await getTemplateDir(snapshot.workspacePath)
      setTemplateDir(dir)
      await openInFinder(dir)
      setStatus(`已打开模板文件夹：${dir}`)
    } catch (error) {
      setNotice(`打开模板文件夹失败：${friendlyError(error)}`)
    }
  }

  const handleScanTemplates = async () => {
    setLoading(true)
    try {
      const result = await syncTemplates(snapshot.workspacePath)
      setTemplates(result.templates)
      setTemplateDir(result.templateDir)
      setNotice(syncNotice(result.added, result.updated, result.incompatible))
    } catch (error) {
      setNotice(`模板扫描失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveTemplate = async () => {
    if (!templateBase64) return
    setLoading(true)
    try {
      await saveTemplate(snapshot.workspacePath, templateBase64, {
        id: '',
        title: editTitle || sourceFileName || '未命名模板',
        description: editDescription,
        variables: editVariables,
        originalFilename: sourceFileName,
        createdAt: new Date().toISOString(),
        category: editCategory || undefined,
        status: 'ready',
        supportsFreeDraft: editVariables.some((item) => item.placeholder === 'draft_body'),
      })
      await refreshTemplates()
      setTplSubView('list')
      setEditVariables([])
      setEditTitle('')
      setEditDescription('')
      setEditCategory('')
      setTemplateBase64('')
      setNotice('模板已保存。')
    } catch (error) {
      setNotice(`模板保存失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('确定删除此模板？')) return
    try {
      await deleteTemplate(snapshot.workspacePath, id)
      if (defaultTemplateId === id) {
        const nextConfig = {
          ...snapshot.config,
          drafting: { ...snapshot.config.drafting, defaultFreeTemplateId: '' },
        }
        const saved = await saveConfig(snapshot.workspacePath, nextConfig)
        onConfigSaved(saved)
        setNotice('已删除默认模板，自由起草将回退到内置基础版式。')
      }
      if (activeTemplate?.id === id) {
        setActiveTemplate(null)
        setActiveTemplateMeta(null)
        setActiveTemplateBase64('')
        setTemplateValues({})
        setTemplateDocBase64('')
      }
      await refreshTemplates()
    } catch (error) {
      setNotice(`模板删除失败：${friendlyError(error)}`)
    }
  }

  return (
    <div className="drafting-page">
      <section className="drafting-hero glass-strong">
        <div>
          <p className="drafting-kicker">Document Studio</p>
          <h2>告诉我你要起草什么文书。</h2>
          <span>模板起草守住格式，自由起草补全文书；两种模式都支持导出 .docx。</span>
        </div>
        <div className="drafting-mode-switch" role="tablist" aria-label="文书起草模式">
          <button type="button" className={mode === 'template' ? 'active' : ''} onClick={() => setMode('template')}>
            <FileText size={15} /> 模板起草
          </button>
          <button type="button" className={mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}>
            <Sparkles size={15} /> 自由起草
          </button>
        </div>
      </section>

      {notice ? (
        <div className="glass-status">
          <span>{notice}</span>
          <button type="button" className="icon-btn" onClick={() => setNotice('')} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      ) : null}

      <div className="drafting-grid">
        <aside className="drafting-side glass-panel">
          <TemplateLibrary
            templates={templates}
            selectedId={activeTemplate?.id ?? ''}
            defaultTemplateId={defaultTemplateId}
            subView={tplSubView}
            loading={loading}
            aiReady={aiReady}
            sourceFileName={sourceFileName}
            templateDir={templateDir}
            editTitle={editTitle}
            editDescription={editDescription}
            editCategory={editCategory}
            editVariables={editVariables}
            onUpload={handleUpload}
            onImport={handleImportTemplate}
            onOpenDir={handleOpenTemplateDir}
            onScan={handleScanTemplates}
            onSelect={selectTemplate}
            onDelete={handleDeleteTemplate}
            onSave={handleSaveTemplate}
            onCancel={() => setTplSubView('list')}
            onTitleChange={setEditTitle}
            onDescriptionChange={setEditDescription}
            onCategoryChange={setEditCategory}
            onUpdateVariable={(index, field, value) => setEditVariables((current) => {
              const next = [...current]
              next[index] = { ...next[index], [field]: value }
              return next
            })}
            onRemoveVariable={(index) => setEditVariables((current) => current.filter((_, idx) => idx !== index))}
            onAddVariable={() => setEditVariables((current) => [
              ...current,
              { placeholder: `var_${current.length + 1}`, label: '新变量', type: 'text' },
            ])}
          />
        </aside>

        <main className="drafting-workspace">
          {mode === 'template' ? (
            <section className="drafting-composer glass-strong">
              <div className="drafting-panel-heading">
                <div>
                  <h3>{activeTemplate ? activeTemplate.title : '选择模板后开始'}</h3>
                  <span>{activeTemplateMeta?.description || '从左侧模板库选择，或上传一篇文书转换为模板。'}</span>
                </div>
                {templateDocBase64 ? (
                  <button type="button" className="primary" onClick={() => saveGeneratedDocx(templateDocBase64, activeTemplate?.title || '模板文书')}>
                    <Download size={15} /> 保存 .docx
                  </button>
                ) : null}
              </div>

              <textarea
                className="drafting-main-input"
                value={templateInput}
                onChange={(event) => setTemplateInput(event.target.value)}
                placeholder="粘贴当事人、事实、日期、金额等信息，AI 会按模板变量提取。"
              />
              <div className="drafting-actions">
                <button type="button" onClick={askAiForTemplateValues} disabled={loading || !activeTemplateMeta || activeTemplate?.status === 'needs_conversion'}>
                  {loading ? <Loader2 size={15} className="spinning" /> : <WandSparkles size={15} />}
                  AI 填变量
                </button>
                <button type="button" className="primary" onClick={() => generateTemplateDoc(templateValues)} disabled={loading || !activeTemplateMeta || activeTemplate?.status === 'needs_conversion'}>
                  <Check size={15} /> 生成模板文书
                </button>
              </div>

              <VariablePanel
                variables={activeTemplateMeta?.variables ?? []}
                values={templateValues}
                onChange={(placeholder, value) => setTemplateValues((current) => ({ ...current, [placeholder]: value }))}
                missingCount={missingTemplateVariables.length}
              />
            </section>
          ) : (
            <section className="drafting-composer glass-strong">
              <div className="drafting-panel-heading">
                <div>
                  <h3>自由起草</h3>
                  <span>
                    默认模板：
                    {defaultTemplate ? defaultTemplate.title : '内置基础版式'}
                  </span>
                </div>
                {freeDraft?.status === 'drafted' ? (
                  <button type="button" className="primary" onClick={exportFreeDraft}>
                    <Download size={15} /> 导出 .docx
                  </button>
                ) : null}
              </div>
              <textarea
                className="drafting-main-input"
                value={freeInput}
                onChange={(event) => setFreeInput(event.target.value)}
                placeholder="描述文书类型、当事人、事实、诉求、风格要求。若已有草稿，直接输入修改意见。"
              />
              <div className="drafting-actions">
                <button type="button" className="primary" onClick={generateFreeDraft} disabled={loading}>
                  {loading ? <Loader2 size={15} className="spinning" /> : <Sparkles size={15} />}
                  {freeDraft?.status === 'drafted' ? '生成修改版' : '生成初稿'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFreeDraft(null)
                    setFreeHistory([])
                    setFreeInput('')
                    setNotice('已开始新的自由起草。')
                  }}
                >
                  <Plus size={15} /> 新文书
                </button>
              </div>
            </section>
          )}

          <DraftPreview freeDraft={freeDraft} templateMeta={activeTemplateMeta} templateValues={templateValues} mode={mode} />
        </main>
      </div>
    </div>
  )
}

function TemplateLibrary({
  templates,
  selectedId,
  defaultTemplateId,
  subView,
  loading,
  aiReady,
  sourceFileName,
  templateDir,
  editTitle,
  editDescription,
  editCategory,
  editVariables,
  onUpload,
  onImport,
  onOpenDir,
  onScan,
  onSelect,
  onDelete,
  onSave,
  onCancel,
  onTitleChange,
  onDescriptionChange,
  onCategoryChange,
  onUpdateVariable,
  onRemoveVariable,
  onAddVariable,
}: {
  templates: TemplateListItem[]
  selectedId: string
  defaultTemplateId: string
  subView: TemplateSubView
  loading: boolean
  aiReady: boolean
  sourceFileName: string
  templateDir: string
  editTitle: string
  editDescription: string
  editCategory: string
  editVariables: TemplateVariable[]
  onUpload: () => void
  onImport: () => void
  onOpenDir: () => void
  onScan: () => void
  onSelect: (template: TemplateListItem) => void
  onDelete: (id: string) => void
  onSave: () => void
  onCancel: () => void
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onUpdateVariable: (index: number, field: keyof TemplateVariable, value: string) => void
  onRemoveVariable: (index: number) => void
  onAddVariable: () => void
}) {
  if (subView === 'review') {
    return (
      <div className="template-review">
        <div className="drafting-panel-heading compact">
          <div>
            <h3>确认模板变量</h3>
            <span>{sourceFileName}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>
        <label className="field">
          模板标题
          <input value={editTitle} onChange={(event) => onTitleChange(event.target.value)} />
        </label>
        <label className="field">
          模板描述
          <input value={editDescription} onChange={(event) => onDescriptionChange(event.target.value)} />
        </label>
        <label className="field">
          分类
          <select value={editCategory} onChange={(event) => onCategoryChange(event.target.value)}>
            <option value="">请选择</option>
            <option value="诉讼">诉讼</option>
            <option value="非诉">非诉</option>
            <option value="合同">合同</option>
            <option value="其他">其他</option>
          </select>
        </label>
        <div className="template-variable-list">
          {editVariables.map((variable, index) => (
            <article key={`${variable.placeholder}-${index}`} className="template-variable-row">
              <input value={variable.placeholder} onChange={(event) => onUpdateVariable(index, 'placeholder', event.target.value)} />
              <input value={variable.label} onChange={(event) => onUpdateVariable(index, 'label', event.target.value)} />
              <select value={variable.type} onChange={(event) => onUpdateVariable(index, 'type', event.target.value)}>
                <option value="text">文本</option>
                <option value="date">日期</option>
                <option value="money">金额</option>
                <option value="number">数字</option>
                <option value="long_text">长文本</option>
              </select>
              <button type="button" className="icon-btn" onClick={() => onRemoveVariable(index)}>
                <Trash2 size={13} />
              </button>
            </article>
          ))}
        </div>
        <div className="drafting-actions stacked">
          <button type="button" onClick={onAddVariable}>
            <Plus size={14} /> 添加变量
          </button>
          <button type="button" className="primary" onClick={onSave} disabled={loading}>
            <Save size={14} /> 保存模板
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="drafting-panel-heading compact">
        <div>
          <h3>模板库</h3>
          <span>{templates.length} 个模板</span>
        </div>
        <button type="button" onClick={onUpload} disabled={loading || !aiReady}>
          <WandSparkles size={14} /> AI 转模板
        </button>
      </div>
      <div className="template-dir-card">
        <span>本地模板文件夹</span>
        <code title={templateDir}>{templateDir || '正在读取模板目录...'}</code>
        <div className="template-dir-actions">
          <button type="button" onClick={onOpenDir} disabled={loading}>
            <FolderOpen size={14} /> 打开
          </button>
          <button type="button" onClick={onScan} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spinning' : ''} /> 扫描
          </button>
          <button type="button" onClick={onImport} disabled={loading}>
            <Upload size={14} /> 导入
          </button>
        </div>
      </div>
      {!aiReady ? <p className="glass-help">AI 转模板需要先配置 AI；已有占位符的 .docx 可直接放入本地模板文件夹后扫描。</p> : null}
      {templates.length === 0 ? (
        <div className="drafting-empty">
          <FileText size={42} strokeWidth={1.4} />
          <strong>暂无模板</strong>
          <span>把 .docx 放入本地模板文件夹后点击扫描，或用 AI 转模板生成变量。</span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((template) => (
            <article key={template.id} className={selectedId === template.id ? 'active' : ''}>
              <button type="button" className="template-select" onClick={() => onSelect(template)}>
                <strong>{template.title}</strong>
                <span>
                  {template.category || '未分类'} · {template.variableCount} 个变量
                  {defaultTemplateId === template.id ? ' · 自由起草默认' : ''}
                </span>
                <small>{templateStatusLabel(template)}</small>
              </button>
              <button type="button" className="icon-btn" onClick={() => onDelete(template.id)} title="删除模板">
                <Trash2 size={13} />
              </button>
            </article>
          ))}
        </div>
      )}
    </>
  )
}

function VariablePanel({
  variables,
  values,
  missingCount,
  onChange,
}: {
  variables: TemplateVariable[]
  values: Record<string, string>
  missingCount: number
  onChange: (placeholder: string, value: string) => void
}) {
  if (variables.length === 0) {
    return <div className="drafting-empty compact">当前模板没有变量，可直接生成。</div>
  }

  return (
    <div className="variable-panel">
      <div className="drafting-panel-heading compact">
        <div>
          <h3>模板变量</h3>
          <span>{missingCount > 0 ? `还缺 ${missingCount} 项` : '变量已齐备'}</span>
        </div>
      </div>
      <div className="variable-grid">
        {variables.map((variable) => (
          <label key={variable.placeholder} className="field">
            {variable.label}
            <input
              value={values[variable.placeholder] ?? ''}
              onChange={(event) => onChange(variable.placeholder, event.target.value)}
              placeholder={variable.description || variable.placeholder}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function DraftPreview({
  mode,
  freeDraft,
  templateMeta,
  templateValues,
}: {
  mode: DraftMode
  freeDraft: NormalizedFreeDraftResult | null
  templateMeta: TemplateMetadata | null
  templateValues: Record<string, string>
}) {
  const templateSummary = templateMeta?.variables
    .filter((variable) => templateValues[variable.placeholder])
    .map((variable) => `${variable.label}: ${templateValues[variable.placeholder]}`)

  return (
    <section className="drafting-preview glass-panel">
      <div className="drafting-panel-heading compact">
        <div>
          <h3>文书预览</h3>
          <span>{mode === 'template' ? '模板变量与生成状态' : '自由起草草稿'}</span>
        </div>
        <RefreshCw size={15} />
      </div>

      {mode === 'template' ? (
        templateSummary?.length ? (
          <div className="draft-preview-paper">
            <h4>{templateMeta?.title}</h4>
            {templateSummary.map((line) => <p key={line}>{line}</p>)}
          </div>
        ) : (
          <div className="drafting-empty compact">选择模板并填写变量后，这里会显示摘要。</div>
        )
      ) : freeDraft?.status === 'need_more_info' ? (
        <div className="draft-preview-paper">
          <h4>需要补充信息</h4>
          {freeDraft.questions.map((question) => <p key={question}>{question}</p>)}
        </div>
      ) : freeDraft?.draftBody ? (
        <div className="draft-preview-paper">
          <h4>{freeDraft.draftTitle || freeDraft.documentType || '法律文书草稿'}</h4>
          {freeDraft.draftBody.split(/\r?\n/).map((line, index) => (
            <p key={`${line}-${index}`}>{line || '\u00A0'}</p>
          ))}
          {freeDraft.riskNotes.length > 0 ? (
            <aside>
              <strong>复核提示</strong>
              {freeDraft.riskNotes.map((note) => <span key={note}>{note}</span>)}
            </aside>
          ) : null}
        </div>
      ) : (
        <div className="drafting-empty compact">生成初稿后，这里会显示完整正文。</div>
      )}
    </section>
  )
}
