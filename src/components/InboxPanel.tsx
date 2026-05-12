import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri, isAiReady } from '../storage'
import { importFilesByPath, importFiles, listPending, runPipeline, confirmCreate, confirmAttach, skipEntry, clearAll, mergeInboxEntries } from '../inbox'
import { MODULE_ORDER, type AISettings, type FieldDefinition, type InboxEntry, type ModuleKey, type RecordSummary, type WorkspaceConfig, type WorkspaceSnapshot } from '../domain'

export default function InboxPanel({
  workspacePath,
  records,
  config,
  aiSettings,
  onSnapshot,
  setStatus,
  onConfigureAi,
  onNavigate,
}: {
  workspacePath: string
  records: RecordSummary[]
  config: WorkspaceConfig
  aiSettings: AISettings
  onSnapshot: (snap: WorkspaceSnapshot) => void
  setStatus: (msg: string) => void
  onConfigureAi: () => void
  onNavigate: (module: ModuleKey) => void
}) {
  const [entries, setEntries] = useState<InboxEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspacePath) return
    try {
      const pending = await listPending(workspacePath)
      setEntries(mergeInboxEntries(pending))
    } catch {
      // ignore
    }
  }, [workspacePath])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Tauri 原生拖拽事件监听（路径去重，防止重复导入）
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    const recentlyImported = new Set<string>()
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    const setup = async () => {
      unlisten = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-drop',
        async (event) => {
          const paths = event.payload.paths
          if (!paths || paths.length === 0) return
          // 路径去重：过滤掉最近已导入的路径
          const newPaths = paths.filter((p) => !recentlyImported.has(p))
          if (newPaths.length === 0) return
          for (const p of newPaths) recentlyImported.add(p)
          // 3 秒后清除去重缓存
          if (clearTimer) clearTimeout(clearTimer)
          clearTimer = setTimeout(() => recentlyImported.clear(), 3000)
          setBusy(true)
          try {
            const newEntries = await importFilesByPath(workspacePath, newPaths)
            setEntries((prev) => mergeInboxEntries(newEntries, prev))
            setStatus(`已导入 ${newEntries.length} 个文件到收件箱。`)
          } catch (err) {
            setStatus(`导入失败：${String(err)}`)
          } finally {
            setBusy(false)
          }
        },
      )
    }
    setup()
    return () => {
      if (unlisten) unlisten()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [workspacePath, setStatus])

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      // Tauri 模式下由 tauri://drag-drop 事件处理，避免重复
      if (isTauri()) return
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return
      setBusy(true)
      try {
        const newEntries = await importFiles(workspacePath, files)
        setEntries((prev) => mergeInboxEntries(newEntries, prev))
        setStatus(`已导入 ${files.length} 个文件到收件箱。`)
      } catch (err) {
        setStatus(`导入失败：${String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [workspacePath, setStatus],
  )

  const handleFilePick = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])
      if (files.length === 0) return
      setBusy(true)
      try {
        // 文件选择器：两种模式都用 importFiles（通过 File 对象）
        // Tauri 模式下 importFiles 内部会调用 Rust 命令
        const newEntries = await importFiles(workspacePath, files)
        setEntries((prev) => mergeInboxEntries(newEntries, prev))
        setStatus(`已导入 ${newEntries.length} 个文件到收件箱。`)
      } catch (err) {
        setStatus(`导入失败：${String(err)}`)
      } finally {
        setBusy(false)
        event.target.value = ''
      }
    },
    [workspacePath, setStatus],
  )

  const handleClearAll = useCallback(async () => {
    if (!confirm('确定清空所有待处理的收件箱条目？此操作不可撤销。')) return
    setBusy(true)
    try {
      await clearAll(workspacePath)
      setEntries([])
      setStatus('收件箱已清空。')
    } catch (err) {
      setStatus(`清空失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [workspacePath, setStatus])

  const handleAnalyze = useCallback(
    async (entry: InboxEntry) => {
      if (!isAiReady(aiSettings)) {
        setStatus('请先在设置中配置 AI API Key。')
        onConfigureAi()
        return
      }
      setAnalyzing(entry.id)
      try {
        const updated = await runPipeline(workspacePath, entry, records, config, aiSettings)
        setEntries((prev) => prev.map((e) => (e.id === entry.id ? updated : e)))
        setStatus(`分析完成：${updated.pipeline?.classify.documentType ?? '未知类型'}`)
      } catch (err) {
        setStatus(`分析失败：${String(err)}`)
      } finally {
        setAnalyzing(null)
      }
    },
    [workspacePath, records, config, aiSettings, setStatus, onConfigureAi],
  )

  const handleConfirmCreate = useCallback(
    async (entry: InboxEntry, targetModule: ModuleKey, fields: Record<string, string>, body: string) => {
      setBusy(true)
      try {
        const snap = await confirmCreate(
          workspacePath,
          entry.id,
          targetModule,
          fields,
          body,
        )
        onSnapshot(snap)
        setEntries((prev) => prev.filter((e) => e.id !== entry.id))
        onNavigate(targetModule)
        setStatus(`已保存到「${config.modules[targetModule]?.label ?? targetModule}」。`)
      } catch (err) {
        setStatus(`创建失败：${String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [workspacePath, onSnapshot, onNavigate, config.modules, setStatus],
  )

  const handleConfirmAttach = useCallback(
    async (entry: InboxEntry) => {
      if (!entry.pipeline?.suggest.existingRecordId) return
      setBusy(true)
      try {
        const snap = await confirmAttach(
          workspacePath,
          entry.id,
          entry.pipeline.suggest.existingRecordId,
          entry.pipeline.suggest.targetModule,
        )
        onSnapshot(snap)
        setEntries((prev) => prev.filter((e) => e.id !== entry.id))
        setStatus('已关联到现有记录。')
      } catch (err) {
        setStatus(`关联失败：${String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [workspacePath, onSnapshot, setStatus],
  )

  const handleSkip = useCallback(
    async (entry: InboxEntry) => {
      try {
        await skipEntry(workspacePath, entry.id)
        setEntries((prev) => prev.filter((e) => e.id !== entry.id))
        setStatus('已跳过。')
      } catch (err) {
        setStatus(`跳过失败：${String(err)}`)
      }
    },
    [workspacePath, setStatus],
  )

  return (
    <div className="panel" style={{ padding: '1.5rem' }}>
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        style={{
          border: '2px dashed #d8d0c1',
          borderRadius: 8,
          padding: '2rem',
          textAlign: 'center',
          marginBottom: '1rem',
          background: '#faf8f4',
          cursor: 'pointer',
        }}
      >
        <p style={{ margin: 0, color: '#6f675b' }}>
          拖拽文件到此处，或
          <label style={{ color: '#3b5bdb', cursor: 'pointer', marginLeft: 4 }}>
            点击选择文件
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={handleFilePick}
              accept=".pdf,.docx,.doc,.txt,.md,.jpg,.jpeg,.png"
            />
          </label>
        </p>
        <p style={{ margin: '0.5rem 0 0', fontSize: 12, color: '#9a8f82' }}>
          支持 PDF、DOCX、TXT、MD、图片等格式
        </p>
      </div>

      {entries.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: 14, color: '#6f675b' }}>待处理 ({entries.length})</span>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={busy}
            style={{ fontSize: 13, color: '#b35c1e' }}
          >
            全部清空
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#9a8f82', padding: '2rem' }}>
          收件箱为空。拖入文件开始智能分析。
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {entries.map((entry) => (
            <InboxEntryCard
              key={entry.id}
              entry={entry}
              config={config}
              busy={busy}
              analyzing={analyzing === entry.id}
              onAnalyze={handleAnalyze}
              onConfirmCreate={handleConfirmCreate}
              onConfirmAttach={handleConfirmAttach}
              onSkip={handleSkip}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function InboxEntryCard({
  entry,
  config,
  busy,
  analyzing,
  onAnalyze,
  onConfirmCreate,
  onConfirmAttach,
  onSkip,
}: {
  entry: InboxEntry
  config: WorkspaceConfig
  busy: boolean
  analyzing: boolean
  onAnalyze: (entry: InboxEntry) => void
  onConfirmCreate: (entry: InboxEntry, targetModule: ModuleKey, fields: Record<string, string>, body: string) => void
  onConfirmAttach: (entry: InboxEntry) => void
  onSkip: (entry: InboxEntry) => void
}) {
  const pipeline = entry.pipeline
  const initialModule = pipeline?.suggest.targetModule ?? 'non_litigation'
  const [targetModule, setTargetModule] = useState<ModuleKey>(initialModule)
  const [fieldDraft, setFieldDraft] = useState<Record<string, string>>(pipeline?.suggest.suggestedFields ?? {})
  const [bodyDraft, setBodyDraft] = useState(pipeline?.suggest.suggestedBody ?? '')

  useEffect(() => {
    if (!pipeline) return
    setTargetModule(pipeline.suggest.targetModule)
    setFieldDraft(pipeline.suggest.suggestedFields)
    setBodyDraft(pipeline.suggest.suggestedBody ?? '')
  }, [entry.id, pipeline])

  const module = config.modules[targetModule]
  const moduleFields = module?.fields ?? []
  const updateField = (key: string, value: string) => {
    setFieldDraft((prev) => ({ ...prev, [key]: value }))
  }
  const buildCreateFields = (): Record<string, string> => {
    const allowedKeys = moduleFields.map((field) => field.key)
    const keys = allowedKeys.length > 0 ? allowedKeys : Object.keys(fieldDraft)
    const next: Record<string, string> = {}
    for (const key of keys) {
      const value = (fieldDraft[key] ?? '').trim()
      if (value) next[key] = value
    }
    const titleField = moduleFields.find((field) => field.key === 'title' || field.key === 'name')
    if (titleField && !next[titleField.key]) {
      next[titleField.key] = entry.sourceFile.originalName.replace(/\.[^.]+$/, '')
    }
    return next
  }

  return (
    <div
      style={{
        border: '1px solid #ded8cb',
        borderRadius: 8,
        padding: '1rem',
        background: '#fffdf7',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <div>
          <strong>{entry.sourceFile.originalName}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#9a8f82' }}>
            {(entry.sourceFile.sizeBytes / 1024).toFixed(1)} KB
          </span>
        </div>
        <span style={{ fontSize: 12, color: '#9a8f82' }}>
          {new Date(entry.createdAt).toLocaleString('zh-CN')}
        </span>
      </div>

      {!pipeline ? (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            type="button"
            className="primary"
            onClick={() => onAnalyze(entry)}
            disabled={busy || analyzing}
          >
            {analyzing ? '分析中...' : 'AI 分析'}
          </button>
          <button type="button" onClick={() => onSkip(entry)} disabled={busy}>
            跳过
          </button>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 13, color: '#4a4540', lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 0.25rem' }}>
              <strong>文档类型：</strong>{pipeline.classify.documentType}
              <span style={{ marginLeft: 8, fontSize: 12, color: '#9a8f82' }}>
                置信度 {(pipeline.classify.confidence * 100).toFixed(0)}%
              </span>
            </p>
            <p style={{ margin: '0 0 0.25rem' }}>
              <strong>建议操作：</strong>
              {pipeline.suggest.action === 'create_new'
                ? '创建新记录'
                : pipeline.suggest.action === 'attach_to_existing'
                  ? `关联到 ${pipeline.match.existingRecord?.title ?? '现有记录'}`
                  : '创建笔记'}
            </p>
            {pipeline.suggest.conflictWarning && (
              <p style={{ margin: '0.25rem 0', color: '#b35c1e', fontSize: 12 }}>
                ⚠ {pipeline.suggest.conflictWarning}
              </p>
            )}
            {Object.keys(pipeline.suggest.suggestedFields).length > 0 && (
              <details style={{ marginTop: '0.5rem' }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6f675b' }}>
                  查看抽取字段 ({Object.keys(pipeline.suggest.suggestedFields).length})
                </summary>
                <div style={{ marginTop: '0.25rem', fontSize: 12 }}>
                  {Object.entries(pipeline.suggest.suggestedFields).map(([key, value]) => (
                    <div key={key}>
                      <span style={{ color: '#6f675b' }}>{key}:</span> {value}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: '#6f675b' }}>保存到板块</span>
                <select
                  value={targetModule}
                  onChange={(event) => setTargetModule(event.target.value as ModuleKey)}
                >
                  {MODULE_ORDER.map((key) => (
                    <option key={key} value={key}>
                      {config.modules[key]?.label ?? key}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                {moduleFields.map((field) => (
                  <InboxFieldEditor
                    key={field.key}
                    field={field}
                    value={fieldDraft[field.key] ?? ''}
                    onChange={(value) => updateField(field.key, value)}
                  />
                ))}
              </div>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 12, color: '#6f675b' }}>正文备注</span>
                <textarea
                  value={bodyDraft}
                  onChange={(event) => setBodyDraft(event.target.value)}
                  rows={3}
                  placeholder="可补充这份文件的处理说明、来源或下一步事项。"
                />
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button
              type="button"
              className="primary"
              onClick={() => onConfirmCreate(entry, targetModule, buildCreateFields(), bodyDraft)}
              disabled={busy}
            >
              保存到{module?.label ?? targetModule}
            </button>
            {pipeline.suggest.action === 'attach_to_existing' && pipeline.match.existingRecord && (
              <button
                type="button"
                onClick={() => onConfirmAttach(entry)}
                disabled={busy}
              >
                仅关联附件
              </button>
            )}
            <button type="button" onClick={() => onAnalyze(entry)} disabled={busy || analyzing}>
              {analyzing ? '重新分析中...' : '重新分析'}
            </button>
            <button type="button" onClick={() => onSkip(entry)} disabled={busy}>
              跳过
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function InboxFieldEditor({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition
  value: string
  onChange: (value: string) => void
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`
  if (field.options?.length) {
    return (
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 12, color: '#6f675b' }}>{label}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">未填写</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    )
  }
  if (field.type === 'long_text') {
    return (
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 12, color: '#6f675b' }}>{label}</span>
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} />
      </label>
    )
  }
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#6f675b' }}>{label}</span>
      <input
        type={field.type === 'number' || field.type === 'money' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
