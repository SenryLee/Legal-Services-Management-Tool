import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileText, Upload, Download, Trash2, Loader2, Check, X, Plus, PenTool, Send } from 'lucide-react'
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
import { isAiReady, aiChat } from '../storage/ai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'draft' | 'templates'
type TemplateSubView = 'list' | 'review'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  /** If assistant offers template match */
  templateMatch?: TemplateListItem
  /** If assistant generated a document */
  generatedDocBase64?: string
  /** Variables the assistant is asking for */
  pendingVariables?: TemplateVariable[]
}

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

  // Chat state
  const [messages, setMessages] = useState<ChatMsg[]>([{
    role: 'assistant',
    content: '你好！我是文书起草助手。请描述你需要起草的文书，例如：\n\n• "帮我写一份民事起诉状"\n• "起草一份律师函发给XX公司"\n• "拟一份借款合同"\n\n我会根据你的需求，匹配已有模板或直接为你起草。',
  }])
  const [input, setInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Template conversation state
  const [activeTemplate, setActiveTemplate] = useState<TemplateListItem | null>(null)
  const [activeTemplateMeta, setActiveTemplateMeta] = useState<TemplateMetadata | null>(null)
  const [activeTemplateBase64, setActiveTemplateBase64] = useState<string | null>(null)
  const [collectedValues, setCollectedValues] = useState<Record<string, string>>({})

  // Template conversion state
  const [tplSubView, setTplSubView] = useState<TemplateSubView>('list')
  const [sourceFileName, setSourceFileName] = useState('')
  const [editVariables, setEditVariables] = useState<TemplateVariable[]>([])
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [templateBase64, setTemplateBase64] = useState<string | null>(null)

  const refreshTemplates = useCallback(async () => {
    try {
      const list = await listTemplates(snapshot.workspacePath)
      setTemplates(list)
    } catch { /* workspace not ready yet */ }
  }, [snapshot.workspacePath])

  useEffect(() => { refreshTemplates() }, [refreshTemplates])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // -----------------------------------------------------------------------
  // Chat logic
  // -----------------------------------------------------------------------

const handleFreeConversation = async (userText: string) => {
    // Step 1: Check if user's request matches any template
    if (templates.length > 0) {
      const matchResult = await findMatchingTemplate(userText, templates)
      if (matchResult) {
        const matchMsg: ChatMsg = {
          role: 'assistant',
          content: `我找到了一个匹配的模板：**「${matchResult.title}」**${matchResult.description ? `\n${matchResult.description}` : ''}\n\n是否基于这个模板来起草？`,
          templateMatch: matchResult,
        }
        setMessages((prev) => [...prev, matchMsg])
        return
      }
    }

    // Step 2: No template match - generate directly
    await generateDirectDraft(userText)
  }

  const findMatchingTemplate = async (userText: string, tplList: TemplateListItem[]): Promise<TemplateListItem | null> => {
    const templateSummaries = tplList.map((t) => `- ${t.id}: "${t.title}" (${t.category || '未分类'}, ${t.variableCount}个变量) - ${t.description || '无描述'}`).join('\n')

    const result = await aiChat(aiSettings, [
      {
        role: 'system',
        content: `你是一个模板匹配助手。根据用户的文书需求，判断是否与已有模板匹配。

可用模板：
${templateSummaries}

规则：
1. 如果用户的需求明显匹配某个模板，返回该模板的 id
2. 如果没有明显匹配，返回 null
3. 严格输出 JSON：{"match": "模板id"} 或 {"match": null}
4. 不要输出任何其他内容`,
      },
      { role: 'user', content: userText },
    ])

    try {
      const parsed = JSON.parse(result.content.trim().replace(/```json?\s*|\s*```/g, ''))
      if (parsed.match && typeof parsed.match === 'string') {
        return tplList.find((t) => t.id === parsed.match) || null
      }
    } catch { /* no match */ }
    return null
  }

  const handleAcceptTemplate = async (tpl: TemplateListItem) => {
    setLoading(true)
    setError(null)
    try {
      const base64 = await readDocxBase64(tpl.docxPath)
      setActiveTemplateBase64(base64)
      const jsonContent = await invoke<string>('inbox_read_file_text', { path: tpl.metaPath })
      const parsed = JSON.parse(jsonContent) as TemplateMetadata
      const meta: TemplateMetadata = {
        id: tpl.id, title: tpl.title, description: tpl.description,
        variables: parsed.variables || [], originalFilename: tpl.originalFilename,
        createdAt: tpl.createdAt, category: tpl.category,
      }
      setActiveTemplate(tpl)
      setActiveTemplateMeta(meta)
      setCollectedValues({})

      if (meta.variables.length > 0) {
        const varList = meta.variables.map((v, i) => `${i + 1}. **${v.label}**${v.description ? `（${v.description}）` : ''}`).join('\n')
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `好的，基于「${tpl.title}」模板起草。请提供以下信息：\n\n${varList}\n\n你可以一次性提供所有信息，也可以分次告诉我。`,
          pendingVariables: meta.variables,
        }])
      } else {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `好的，基于「${tpl.title}」模板起草。这个模板没有需要填写的变量，我直接为你生成文书。`,
        }])
        await doGenerateFromTemplate(meta, base64, {})
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleDeclineTemplate = async (userText: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: '好的，不使用模板，我直接为你起草。' }])
    await generateDirectDraft(userText)
  }

  const handleTemplateConversation = async (userText: string) => {
    if (!activeTemplateMeta || !activeTemplateBase64) return

    // Use AI to extract variable values from user's message
    if (activeTemplateMeta.variables.length > 0) {
      const extractionResult = await extractVariablesFromText(userText, activeTemplateMeta.variables, collectedValues)
      const newValues = { ...collectedValues, ...extractionResult }
      setCollectedValues(newValues)

      // Check if all required variables are filled
      const missing = activeTemplateMeta.variables.filter((v) => !newValues[v.placeholder] || newValues[v.placeholder].trim() === '')
      if (missing.length > 0) {
        const missingList = missing.map((v) => `• ${v.label}`).join('\n')
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `已收到部分信息。还需要以下内容：\n\n${missingList}\n\n请继续提供。`,
        }])
        return
      }
    }

    // All variables collected - generate
    await doGenerateFromTemplate(activeTemplateMeta, activeTemplateBase64, collectedValues)
  }

  const extractVariablesFromText = async (
    text: string,
    variables: TemplateVariable[],
    existing: Record<string, string>,
  ): Promise<Record<string, string>> => {
    const unfilled = variables.filter((v) => !existing[v.placeholder])
    if (unfilled.length === 0) return {}

    const schema = unfilled.map((v) => `"${v.placeholder}": "${v.label}"`).join(', ')
    const result = await aiChat(aiSettings, [
      {
        role: 'system',
        content: `从用户的消息中提取以下字段的值。严格输出 JSON，只包含你能从消息中找到的字段。找不到的不要包含。

需要提取的字段：{${schema}}

规则：
1. 严格输出 JSON，不要其他内容
2. 日期格式 YYYY-MM-DD
3. 金额输出纯数字
4. 只提取用户明确提供的信息`,
      },
      { role: 'user', content: text },
    ])

    try {
      const parsed = JSON.parse(result.content.trim().replace(/```json?\s*|\s*```/g, ''))
      if (parsed && typeof parsed === 'object') {
        const extracted: Record<string, string> = {}
        for (const v of unfilled) {
          if (parsed[v.placeholder] !== undefined && parsed[v.placeholder] !== null) {
            extracted[v.placeholder] = String(parsed[v.placeholder]).trim()
          }
        }
        return extracted
      }
    } catch { /* ignore */ }
    return {}
  }

  const doGenerateFromTemplate = async (meta: TemplateMetadata, base64: string, values: Record<string, string>) => {
    try {
      const docBase64 = await draftDocument(base64, values)
        const summary = Object.entries(values).map(([k, v]) => {
        const variable = meta.variables.find((vr) => vr.placeholder === k)
        return `• ${variable?.label || k}：${v}`
      }).join('\n')
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: `✅ 文书已生成！\n\n**使用的信息：**\n${summary || '（无变量）'}\n\n如需修改，请告诉我具体要改哪里。满意后点击「保存为 .docx」下载。`,
        generatedDocBase64: docBase64,
      }])
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `生成失败：${String(e)}` }])
    }
  }

  const generateDirectDraft = async (userText: string) => {
    // Build conversation history for AI
    const history = messages
      .filter((m) => !m.templateMatch && !m.pendingVariables)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const result = await aiChat(aiSettings, [
      {
        role: 'system',
        content: `你是一位资深法律文书起草专家。用户会描述需要起草的文书，请根据需求撰写完整的法律文书。

规则：
1. 直接输出文书正文，不要解释你的思路
2. 使用标准的法律文书格式
3. 当事人、案号、日期等关键信息如果用户没有提供，用方括号标注如 [原告姓名]、[案号]、[日期]
4. 如果用户只给了大致方向，先输出一个初稿，让用户修改
5. 输出纯文本，不要 markdown 格式`,
      },
      ...history,
      { role: 'user', content: userText },
    ])

    setMessages((prev) => [...prev, {
      role: 'assistant',
      content: result.content,
    }])
  }

  // Re-generate after user asks for modifications
  const handleModification = async (userText: string) => {
    if (activeTemplate && activeTemplateMeta && activeTemplateBase64) {
      // Template-based: re-extract variables and regenerate
      const extractionResult = await extractVariablesFromText(userText, activeTemplateMeta.variables, collectedValues)
      const newValues = { ...collectedValues, ...extractionResult }
      setCollectedValues(newValues)
      await doGenerateFromTemplate(activeTemplateMeta, activeTemplateBase64, newValues)
    } else {
      // Free-form: continue the conversation
      const history = messages
        .filter((m) => !m.templateMatch)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const result = await aiChat(aiSettings, [
        {
          role: 'system',
          content: `你是一位资深法律文书起草专家。用户之前要求起草了一份文书，现在要求修改。请根据用户的修改意见，输出修改后的完整文书。

规则：
1. 输出修改后的完整文书，不要只输出修改的部分
2. 保持用户未要求修改的部分不变
3. 使用标准法律文书格式
4. 当事人等未提供的信息继续用方括号标注
5. 输出纯文本，不要 markdown 格式`,
        },
        ...history,
        { role: 'user', content: userText },
      ])

      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: result.content,
      }])
    }
  }

  // Decide whether this is a new request or a modification
  const shouldTreatAsModification = (): boolean => {
    // If there's an active template conversation, it's a template flow
    if (activeTemplate && activeTemplateMeta) return true
    // If the last assistant message has content (a draft), treat as modification
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && !m.templateMatch)
    return !!(lastAssistant && lastAssistant.content.length > 100) // Long content = likely a draft
  }

  // Override handleFreeConversation to detect modifications
  const handleSendWithModification = async (text: string) => {
    if (shouldTreatAsModification() && !activeTemplate) {
      await handleModification(text)
    } else {
      await handleFreeConversation(text)
    }
  }

  // -----------------------------------------------------------------------
  // Save generated document
  // -----------------------------------------------------------------------

  const handleSaveDocx = async (base64: string) => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const filePath = await save({
        defaultPath: `文书_${new Date().toISOString().slice(0, 10)}.docx`,
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      })
      if (!filePath) return
      setLoading(true)
      await saveDocx(filePath, base64)
      setMessages((prev) => [...prev, { role: 'assistant', content: `✅ 文书已保存到：${filePath}` }])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  // Reset conversation
  const handleNewDraft = () => {
    setMessages([{
      role: 'assistant',
      content: '你好！请描述你需要起草的文书，例如：\n\n• "帮我写一份民事起诉状"\n• "起草一份律师函"\n• "拟一份借款合同"',
    }])
    setActiveTemplate(null)
    setActiveTemplateMeta(null)
    setActiveTemplateBase64(null)
    setCollectedValues({})
  }

  // -----------------------------------------------------------------------
  // Template management
  // -----------------------------------------------------------------------

  const handleUpload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Word 文档', extensions: ['docx'] }] })
      if (!selected) return
      const filePath = Array.isArray(selected) ? selected[0] : selected
      setSourceFileName(filePath.split('/').pop() || 'document.docx')
      setLoading(true)
      setError(null)
      const base64 = await readDocxBase64(filePath)
      const result = await convertDocumentToTemplate(base64, aiSettings, () => {})
      setTemplateBase64(result.templateBase64)
      setEditTitle(result.metadata.title)
      setEditDescription(result.metadata.description)
      setEditCategory(result.metadata.category)
      setEditVariables([...result.metadata.variables])
      setTplSubView('review')
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  const handleSaveTemplate = async () => {
    if (!templateBase64) return
    setLoading(true)
    try {
      await saveTemplate(snapshot.workspacePath, templateBase64, {
        id: '', title: editTitle, description: editDescription,
        variables: editVariables, originalFilename: sourceFileName,
        createdAt: new Date().toISOString(), category: editCategory || undefined,
      })
      await refreshTemplates()
      setTplSubView('list')
      setEditVariables([]); setEditTitle(''); setEditDescription(''); setEditCategory(''); setTemplateBase64(null)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('确定删除此模板？')) return
    try { await deleteTemplate(snapshot.workspacePath, id); await refreshTemplates() }
    catch (e) { setError(String(e)) }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div style={rootStyle}>
      {/* Tab bar */}
      <div style={tabBarStyle}>
        <button style={tab === 'draft' ? activeTabBtn : tabBtn} onClick={() => setTab('draft')}>
          <PenTool size={15} /> 文书起草
        </button>
        <button style={tab === 'templates' ? activeTabBtn : tabBtn} onClick={() => { setTab('templates'); setTplSubView('list') }}>
          <FileText size={15} /> 模板管理
        </button>
      </div>

      {error && (
        <div style={errorBar}>
          <span>{error}</span>
          <button style={closeBtn} onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Content */}
      {tab === 'draft' ? (
        <ChatView
          messages={messages}
          input={input}
          loading={loading}
          onInputChange={setInput}
          onSend={async () => {
            const text = input.trim()
            if (!text || loading) return
            if (!isAiReady(aiSettings)) { setError('请先在设置中配置 AI（填写 API Key）'); return }
            const userMsg: ChatMsg = { role: 'user', content: text }
            setMessages((prev) => [...prev, userMsg])
            setInput('')
            setLoading(true)
            setError(null)
            try {
              if (activeTemplate && activeTemplateMeta) {
                await handleTemplateConversation(text)
              } else {
                await handleSendWithModification(text)
              }
            } catch (e) { setError(String(e)) }
            finally { setLoading(false) }
          }}
          onAcceptTemplate={handleAcceptTemplate}
          onDeclineTemplate={() => handleDeclineTemplate(input || '直接起草')}
          onSaveDocx={handleSaveDocx}
          onNewDraft={handleNewDraft}
          chatEndRef={chatEndRef}
        />
      ) : (
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
          onUpload={handleUpload}
          onSave={handleSaveTemplate}
          onCancel={() => { setTplSubView('list'); setEditVariables([]); setTemplateBase64(null) }}
          onDelete={handleDeleteTemplate}
          onTitleChange={setEditTitle}
          onDescriptionChange={setEditDescription}
          onCategoryChange={setEditCategory}
          onUpdateVariable={(i, f, v) => setEditVariables((p) => { const n = [...p]; n[i] = { ...n[i], [f]: v }; return n })}
          onRemoveVariable={(i) => setEditVariables((p) => p.filter((_, idx) => idx !== i))}
          onAddVariable={() => setEditVariables((p) => [...p, { placeholder: `var_${p.length + 1}`, label: '新变量', type: 'text' }])}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat View
// ---------------------------------------------------------------------------

function ChatView({
  messages, input, loading, onInputChange, onSend, onAcceptTemplate, onDeclineTemplate, onSaveDocx, onNewDraft, chatEndRef,
}: {
  messages: ChatMsg[]
  input: string
  loading: boolean
  onInputChange: (v: string) => void
  onSend: () => void
  onAcceptTemplate: (tpl: TemplateListItem) => void
  onDeclineTemplate: (tpl: TemplateListItem) => void
  onSaveDocx: (base64: string) => void
  onNewDraft: () => void
  chatEndRef: React.RefObject<HTMLDivElement | null>
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
  }

  return (
    <>
      {/* Messages */}
      <div style={chatAreaStyle}>
        {messages.map((msg, i) => (
          <div key={i} style={msg.role === 'user' ? userMsgStyle : assistantMsgStyle}>
            <div style={msg.role === 'user' ? userBubbleStyle : assistantBubbleStyle}>
              {/* Render content with line breaks */}
              {msg.content.split('\n').map((line, li) => (
                <p key={li} style={{ margin: '0 0 4px 0', lineHeight: 1.6 }}>{line || '\u00A0'}</p>
              ))}

              {/* Template match buttons */}
              {msg.templateMatch && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button style={primarySmallBtn} onClick={() => onAcceptTemplate(msg.templateMatch!)} disabled={loading}>
                    <Check size={13} /> 使用此模板
                  </button>
                  <button style={secondarySmallBtn} onClick={() => onDeclineTemplate(msg.templateMatch!)} disabled={loading}>
                    不用，直接起草
                  </button>
                </div>
              )}

              {/* Generated doc save button */}
              {msg.generatedDocBase64 && (
                <div style={{ marginTop: 12 }}>
                  <button style={successSmallBtn} onClick={() => onSaveDocx(msg.generatedDocBase64!)} disabled={loading}>
                    <Download size={13} /> 保存为 .docx
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div style={assistantMsgStyle}>
            <div style={{ ...assistantBubbleStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Loader2 size={14} className="spinning" /> 思考中…
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input area */}
      <div style={inputAreaStyle}>
        <button style={newDraftBtn} onClick={onNewDraft} title="新文书">新文书</button>
        <textarea
          style={inputBoxStyle}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="描述你需要起草的文书，或输入修改意见…"
          rows={1}
        />
        <button style={sendBtn} onClick={onSend} disabled={loading || !input.trim()}>
          <Send size={16} />
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Template Tab
// ---------------------------------------------------------------------------

function TemplateTab({
  subView, templates, loading, aiReady, sourceFileName,
  editTitle, editDescription, editCategory, editVariables,
  onUpload, onSave, onCancel, onDelete,
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
  onUpload: () => void
  onSave: () => void
  onCancel: () => void
  onDelete: (id: string) => void
  onTitleChange: (v: string) => void
  onDescriptionChange: (v: string) => void
  onCategoryChange: (v: string) => void
  onUpdateVariable: (i: number, f: keyof TemplateVariable, v: string) => void
  onRemoveVariable: (i: number) => void
  onAddVariable: () => void
}) {
  if (subView === 'review') {
    return (
      <div style={{ maxWidth: 750, margin: '0 auto', padding: 20 }}>
        <div style={cardBlock}>
          <h3 style={sectionTitle}>✏️ 确认模板变量</h3>
          <p style={{ color: '#666', fontSize: 13, marginBottom: 16 }}>
            AI 已分析文档 <strong>{sourceFileName}</strong>，请检查变量后保存。
          </p>
          <div style={formGroup}>
            <label style={label}>模板标题</label>
            <input style={inputStyle} value={editTitle} onChange={(e) => onTitleChange(e.target.value)} />
          </div>
          <div style={formGroup}>
            <label style={label}>模板描述</label>
            <input style={inputStyle} value={editDescription} onChange={(e) => onDescriptionChange(e.target.value)} />
          </div>
          <div style={formGroup}>
            <label style={label}>分类</label>
            <select style={inputStyle} value={editCategory} onChange={(e) => onCategoryChange(e.target.value)}>
              <option value="">请选择</option><option value="诉讼">诉讼</option><option value="非诉">非诉</option><option value="合同">合同</option><option value="其他">其他</option>
            </select>
          </div>
          <h4 style={{ ...sectionTitle, fontSize: 14, marginTop: 20 }}>变量列表 ({editVariables.length})</h4>
          {editVariables.length === 0 && <p style={{ color: '#999', padding: 12 }}>AI 未识别到变量，可手动添加。</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {editVariables.map((v, i) => (
              <div key={i} style={varRow}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 36px', gap: 8, alignItems: 'center' }}>
                  <input style={inputStyle} value={v.placeholder} onChange={(e) => onUpdateVariable(i, 'placeholder', e.target.value)} placeholder="placeholder" />
                  <input style={inputStyle} value={v.label} onChange={(e) => onUpdateVariable(i, 'label', e.target.value)} placeholder="中文标签" />
                  <select style={inputStyle} value={v.type} onChange={(e) => onUpdateVariable(i, 'type', e.target.value)}>
                    <option value="text">文本</option><option value="date">日期</option><option value="money">金额</option><option value="number">数字</option><option value="long_text">长文本</option>
                  </select>
                  <button style={iconBtn} onClick={() => onRemoveVariable(i)}><X size={14} /></button>
                </div>
                {v.example && <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>原文示例：{v.example}</div>}
              </div>
            ))}
          </div>
          <button style={addBtn} onClick={onAddVariable}><Plus size={14} /> 添加变量</button>
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button style={{ ...primaryBtn, flex: 1, justifyContent: 'center' }} onClick={onSave} disabled={loading}>
              <Check size={14} /> {loading ? '保存中…' : '保存模板'}
            </button>
            <button style={secondaryBtn} onClick={onCancel}>取消</button>
          </div>
        </div>
      </div>
    )
  }

  // List view
  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={sectionTitle}>模板库 ({templates.length})</h3>
        <button style={primaryBtn} onClick={onUpload} disabled={loading || !aiReady}>
          <Upload size={14} /> 上传文书转模板
        </button>
      </div>
      {!aiReady && <div style={warning}>⚠️ 请先在设置中配置 AI（填写 API Key）。</div>}
      {templates.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
          <FileText size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
          <p style={{ marginTop: 12 }}>暂无模板</p>
          <p style={{ fontSize: 13 }}>上传一篇写好的文书，AI 会自动识别变量并转化为模板</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map((tpl) => (
            <div key={tpl.id} style={cardRow}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>{tpl.title}</div>
                <div style={{ fontSize: 12, color: '#888', display: 'flex', gap: 12 }}>
                  {tpl.category && <span>📂 {tpl.category}</span>}
                  <span>📝 {tpl.variableCount} 个变量</span>
                  <span>📄 {tpl.originalFilename}</span>
                </div>
                {tpl.description && <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{tpl.description}</div>}
              </div>
              <button style={iconBtn} onClick={() => onDelete(tpl.id)} title="删除"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const rootStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }
const tabBarStyle: React.CSSProperties = { display: 'flex', borderBottom: '2px solid #e5e7eb', background: '#fafafa', padding: '0 20px' }
const tabBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 20px', background: 'none', border: 'none', fontSize: 14, color: '#888', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: -2 }
const activeTabBtn: React.CSSProperties = { ...tabBtn, color: '#2563eb', borderBottomColor: '#2563eb', fontWeight: 600 }
const chatAreaStyle: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }
const userMsgStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end' }
const assistantMsgStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-start' }
const userBubbleStyle: React.CSSProperties = { maxWidth: '75%', padding: '10px 14px', borderRadius: '12px 12px 2px 12px', background: '#2563eb', color: '#fff', fontSize: 13, lineHeight: 1.6 }
const assistantBubbleStyle: React.CSSProperties = { maxWidth: '85%', padding: '10px 14px', borderRadius: '12px 12px 12px 2px', background: '#f3f4f6', color: '#1f2937', fontSize: 13, lineHeight: 1.6 }
const inputAreaStyle: React.CSSProperties = { display: 'flex', gap: 8, padding: '12px 20px', borderTop: '1px solid #e5e7eb', background: '#fafafa', alignItems: 'flex-end' }
const inputBoxStyle: React.CSSProperties = { flex: 1, padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'none', minHeight: 40, maxHeight: 120, fontFamily: 'inherit' }
const sendBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }
const newDraftBtn: React.CSSProperties = { padding: '8px 12px', background: 'none', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12, cursor: 'pointer', color: '#666', whiteSpace: 'nowrap' }
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }
const primarySmallBtn: React.CSSProperties = { ...primaryBtn, padding: '6px 14px', fontSize: 12 }
const secondaryBtn: React.CSSProperties = { ...primaryBtn, background: '#fff', color: '#555', border: '1px solid #d1d5db' }
const secondarySmallBtn: React.CSSProperties = { ...secondaryBtn, padding: '6px 14px', fontSize: 12 }
const successSmallBtn: React.CSSProperties = { ...primarySmallBtn, background: '#16a34a' }
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 4, display: 'inline-flex', alignItems: 'center', color: '#999' }
const addBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: '1px dashed #d1d5db', borderRadius: 6, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: '#666', marginTop: 8 }
const errorBar: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 20px', background: '#fef2f2', color: '#dc2626', fontSize: 13, borderBottom: '1px solid #fecaca' }
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#999', padding: 0, marginLeft: 8 }
const cardRow: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '14px 18px', border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff' }
const cardBlock: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24 }
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }
const formGroup: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }
const label: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: '#374151' }
const inputStyle: React.CSSProperties = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }
const varRow: React.CSSProperties = { padding: '8px', background: '#f9fafb', borderRadius: 6, border: '1px solid #f3f4f6' }
const warning: React.CSSProperties = { padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, color: '#92400e', fontSize: 13, marginBottom: 16 }
