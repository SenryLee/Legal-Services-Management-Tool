import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle2, FilePlus2, Loader2, Sparkles, Upload, X } from 'lucide-react'
import type { AISettings, ModuleKey, WorkspaceSnapshot } from '../domain'
import { extractWithAi, isAiReady, parseTextToDraft, readFileAsText } from '../storage'
import { friendlyError } from '../shared/utils'

export default function AiAssistant({
  moduleKey,
  config,
  aiSettings,
  onApply,
  onConfigure,
  setStatus,
}: {
  moduleKey: ModuleKey
  config: WorkspaceSnapshot['config']
  aiSettings: AISettings
  onApply: (patch: Record<string, unknown>) => void
  onConfigure: () => void
  setStatus: (status: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof extractWithAi>> | null>(null)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [isExtracting, setIsExtracting] = useState(false)
  const [isReading, setIsReading] = useState(false)
  const [fileStatus, setFileStatus] = useState<
    { kind: 'ok'; name: string; size: number; chars: number } | { kind: 'error'; message: string } | null
  >(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const aiReady = isAiReady(aiSettings)

  const reset = useCallback(() => {
    setText('')
    setDraft(null)
    setSelected({})
    setEnabled({})
    setTargets({})
    setFileStatus(null)
  }, [])

  const handleFile = async (file: File | null) => {
    if (!file) return
    setIsReading(true)
    setFileStatus(null)
    try {
      const content = await readFileAsText(file)
      setText(content)
      setFileStatus({ kind: 'ok', name: file.name, size: file.size, chars: content.length })
      setStatus(`已读取「${file.name}」（${content.length} 字符）`)
    } catch (error) {
      const message = friendlyError(error)
      setFileStatus({ kind: 'error', message })
      setStatus(`读取失败：${message}`)
    } finally {
      setIsReading(false)
    }
  }

  const runAi = async () => {
    if (!text.trim()) {
      setStatus('请先粘贴或上传文本。')
      return
    }
    if (!aiReady) {
      setStatus('尚未配置 AI（设置 → AI 配置），可先用"使用本地正则"。')
      return
    }
    setIsExtracting(true)
    try {
      const next = await extractWithAi(text, moduleKey, config, aiSettings, customPrompt)
      setDraft(next)
      setSelected(Object.fromEntries(next.suggestions.map((item) => [item.fieldKey, item.value])))
      setEnabled(Object.fromEntries(next.suggestions.map((item) => [item.fieldKey, true])))
      setTargets(Object.fromEntries(next.suggestions.map((item) => [item.fieldKey, item.fieldKey])))
      if (next.notice) setStatus(next.notice)
    } catch (error) {
      setStatus(`AI 解析失败：${friendlyError(error)}`)
    } finally {
      setIsExtracting(false)
    }
  }

  const runRegex = () => {
    if (!text.trim()) {
      setStatus('请先粘贴或上传文本。')
      return
    }
    const next = parseTextToDraft(text, moduleKey, config)
    setDraft({ ...next, notice: '使用本地正则规则抽取（兜底）。识别精度有限，仅用作快速占位。' })
    setSelected(Object.fromEntries(next.suggestions.map((item) => [item.fieldKey, item.value])))
    setEnabled(Object.fromEntries(next.suggestions.map((item) => [item.fieldKey, true])))
    setTargets(Object.fromEntries(next.suggestions.map((item) => [item.fieldKey, item.fieldKey])))
    setStatus('已用本地正则完成解析。')
  }

  const apply = () => {
    if (!draft) return
    const patch: Record<string, unknown> = {}
    for (const suggestion of draft.suggestions) {
      if (!enabled[suggestion.fieldKey]) continue
      const value = selected[suggestion.fieldKey] ?? suggestion.value
      const target = targets[suggestion.fieldKey] || suggestion.fieldKey
      if (value && String(value).trim()) patch[target] = value
    }
    if (Object.keys(patch).length === 0) {
      setStatus('没有可应用的字段。')
      return
    }
    onApply(patch)
    setStatus(`AI 已建议 ${Object.keys(patch).length} 个字段，已填入表单（可继续编辑）。`)
  }

  return (
    <div className={`ai-card${open ? ' open' : ''}`}>
      <button type="button" className="ai-card-header" onClick={() => setOpen((value) => !value)}>
        <Sparkles size={15} />
        <span>AI 助手 · 解析后填充表单</span>
        <small>{aiReady ? `${aiSettings.provider}` : '未配置'}</small>
        <small>{open ? '收起' : '展开'}</small>
      </button>
      {open ? (
        <div className="ai-card-body">
          <p className="muted">
            <strong>支持上传</strong>：<code>.pdf</code>（提取文字层）、
            <code>.docx</code>（自动解 zip 取 XML 文本）、
            <code>.txt / .md / .csv / .json</code> 等纯文本（自动识别 UTF-8 / GBK / 带 BOM）。
            <br />
            <strong>暂不支持</strong>：扫描版 PDF（需 OCR）、旧版 .doc（请另存为 .docx）、Excel、图片。
            按当前模块字段调用 AI 抽取；文本里没有的字段会自动留空。
          </p>
          {!aiReady ? (
            <div className="warning">
              <AlertTriangle size={14} /> 当前未配置 AI 接口。
              <button type="button" className="link-btn" onClick={onConfigure}>
                去配置
              </button>
            </div>
          ) : null}
          <div className="ai-toolbar">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isReading}
            >
              {isReading ? <Loader2 size={14} className="spinning" /> : <Upload size={14} />}{' '}
              {isReading ? '读取中…' : '上传文件'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.text,.csv,.tsv,.json,.yml,.yaml,.log,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              hidden
              onChange={(event) => {
                handleFile(event.target.files?.[0] ?? null)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              className="primary"
              onClick={runAi}
              disabled={!text.trim() || !aiReady || isExtracting}
            >
              {isExtracting ? <Loader2 size={14} className="spinning" /> : <Bot size={14} />}{' '}
              AI 解析并填充
            </button>
            <button type="button" onClick={runRegex} disabled={!text.trim() || isExtracting}>
              使用本地正则
            </button>
            <button type="button" onClick={reset} className="ghost">
              清空
            </button>
          </div>
          {fileStatus ? (
            <div className={`file-status ${fileStatus.kind}`} role={fileStatus.kind === 'error' ? 'alert' : undefined}>
              {fileStatus.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              <div className="file-status-body">
                {fileStatus.kind === 'ok' ? (
                  <>
                    <strong>已读取「{fileStatus.name}」</strong>
                    <small>
                      {(fileStatus.size / 1024).toFixed(1)} KB · {fileStatus.chars.toLocaleString()} 字符 · 可点击"AI 解析并填充"
                    </small>
                  </>
                ) : (
                  <>
                    <strong>上传失败</strong>
                    <small>{fileStatus.message}</small>
                  </>
                )}
              </div>
              <button type="button" className="link-btn" onClick={() => setFileStatus(null)} aria-label="关闭">
                <X size={12} />
              </button>
            </div>
          ) : null}
          <details className="ai-prompt-extra">
            <summary>补充提示词（可选）</summary>
            <textarea
              value={customPrompt}
              onChange={(event) => setCustomPrompt(event.target.value)}
              placeholder={'例如：请把"乙方"识别为客户，把"甲方"识别为相对方。本模块场景是劳动争议二审...'}
              rows={3}
            />
          </details>
          <textarea
            className="ai-textarea"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="粘贴材料或上传文件后，按当前模块字段抽取..."
            rows={5}
          />
          {draft ? (
            <div className="ai-suggestions">
              {draft.notice ? <p className="ai-notice">{draft.notice}</p> : null}
              {draft.suggestions.length === 0 ? (
                <p className="muted">未识别到可填字段。可手动编辑或修改文本/补充提示词后重试。</p>
              ) : (
	                draft.suggestions.map((item) => (
	                  <label className="ai-suggestion" key={item.fieldKey}>
	                    <span>
	                      <input
	                        type="checkbox"
	                        checked={enabled[item.fieldKey] ?? true}
	                        onChange={(event) =>
	                          setEnabled({ ...enabled, [item.fieldKey]: event.target.checked })
	                        }
	                      />
	                      {item.label}
	                      <small>{Math.round(item.confidence * 100)}%</small>
	                    </span>
	                    <input
	                      value={selected[item.fieldKey] ?? ''}
	                      onChange={(event) =>
	                        setSelected({ ...selected, [item.fieldKey]: event.target.value })
	                      }
	                    />
	                    <select
	                      value={targets[item.fieldKey] ?? item.fieldKey}
	                      onChange={(event) =>
	                        setTargets({ ...targets, [item.fieldKey]: event.target.value })
	                      }
	                    >
	                      {config.modules[moduleKey].fields.map((field) => (
	                        <option key={field.key} value={field.key}>
	                          应用到：{field.label}
	                        </option>
	                      ))}
	                    </select>
	                  </label>
	                ))
              )}
              {draft.unresolved.length > 0 && (
                <div className="warning">
                  <AlertTriangle size={14} /> 未识别必填项：{draft.unresolved.join('、')}
                </div>
              )}
              {draft.suggestions.length > 0 && (
                <button type="button" className="primary ai-apply" onClick={apply}>
                  <FilePlus2 size={14} /> 应用到表单
                </button>
              )}
              {draft.rawResponse ? (
                <details className="ai-raw">
                  <summary>查看模型原始响应</summary>
                  <pre>{draft.rawResponse}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
