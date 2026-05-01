import {
  AlertTriangle,
  Bot,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Eye,
  FileInput,
  FilePlus2,
  FileSpreadsheet,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListTodo,
  Loader2,
  Paperclip,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { ENCOURAGEMENTS } from './encouragements'
import {
  defaultAiSettings,
  defaultConfig,
  emptyRecordFor,
  MODULE_ORDER,
  PROVIDER_PRESETS,
  type AISettings,
  type AiProvider,
  type AttachmentEntry,
  type FieldDefinition,
  type FieldType,
  type ModuleKey,
  type RecordSummary,
  type WorkspaceSnapshot,
} from './domain'
import {
  addAttachments,
  aiTestConnection,
  analyzeClientConflicts,
  type AnnotatedConflictHit,
  buildExtractionMessages,
  checkWorkspaceExists,
  createRecord,
  createWorkspace,
  DEFAULT_AI_SYSTEM_PROMPT,
  deleteAttachment,
  ensureAttachmentsDir,
  exportRowsToCsv,
  extractWithAi,
  forgetWorkspace,
  generateLedgerSnapshot,
  getDefaultWorkspaceRoot,
  getLastWorkspaceSync,
  getRecentWorkspacesSync,
  isAiReady,
  isTauri,
  listAttachments,
  loadAiSettings,
  loadAppState,
  openInFinder,
  openWorkspace,
  parseTextToDraft,
  pickFilesToAttach,
  pickWorkspaceDirectory,
  readFileAsText,
  saveAiSettings,
  saveConfig,
  seedDemoRecords,
} from './storage'

const moduleIcons: Record<ModuleKey | 'dashboard' | 'settings', typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  settings: Settings2,
  client: Users,
  conflict_check: ShieldCheck,
  service_contract: ClipboardList,
  litigation: Landmark,
  non_litigation: FileInput,
  invoice: ReceiptText,
  calendar_event: CalendarDays,
}

const fieldTypes: FieldType[] = [
  'text',
  'long_text',
  'date',
  'money',
  'number',
  'single_select',
  'multi_select',
  'boolean',
  'party_ref',
  'file_ref',
  'matter_ref',
]

const fieldTypeLabel: Record<FieldType, string> = {
  text: '文本',
  long_text: '长文本',
  date: '日期',
  money: '金额',
  number: '数字',
  single_select: '单选',
  multi_select: '多选',
  boolean: '布尔',
  party_ref: '主体引用',
  file_ref: '文件引用',
  matter_ref: '事项引用',
}

const today = new Date().toISOString().slice(0, 10)
const currentMonth = today.slice(0, 7)
const emptyRecords: RecordSummary[] = []
const closedTaskStatuses = new Set(['已完成', '已取消', '归档', '已结案', '已交付', '已复盘'])

const friendlyError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const textValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

const moneyValue = (value: unknown): number => {
  const next = Number(value)
  return Number.isFinite(next) ? next : 0
}

const isClosedStatus = (status: unknown): boolean => closedTaskStatuses.has(textValue(status))

const formatDateLabel = (date: string): string => {
  if (!date) return '未设日期'
  if (date === today) return '今天'

  const current = new Date(`${today}T00:00:00`)
  const target = new Date(`${date.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(target.getTime())) return date

  const diff = Math.round((target.getTime() - current.getTime()) / 86_400_000)
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  if (diff < 0) return `逾期 ${Math.abs(diff)} 天`
  if (diff <= 7) return `${diff} 天后`
  return date
}

function App() {
  const [workspacePath, setWorkspacePath] = useState('')
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [active, setActive] = useState<ModuleKey | 'dashboard' | 'settings'>('dashboard')
  const [month, setMonth] = useState(currentMonth)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState(
    isTauri()
      ? '点击下方"浏览"按钮选择本地文件夹，或从最近工作区中打开。'
      : '浏览器演示模式：填写一个名称即可加载演示数据。',
  )
  const [isBusy, setIsBusy] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const [aiSettings, setAiSettings] = useState<AISettings>(() => defaultAiSettings())
  const [settingsTab, setSettingsTab] = useState<'ai' | 'general' | 'fields' | 'about'>('ai')
  const [encouragement] = useState(
    () => ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)] ?? ENCOURAGEMENTS[0],
  )
  const autoOpenAttempted = useRef(false)

  const config = snapshot?.config ?? defaultConfig()
  const records = snapshot?.records ?? emptyRecords

  const refreshRecents = useCallback(() => {
    setRecents(getRecentWorkspacesSync())
  }, [])

  const handleSnapshotResult = useCallback((next: WorkspaceSnapshot) => {
    setSnapshot(next)
    setWorkspacePath(next.workspacePath || '')
    setRecents(getRecentWorkspacesSync())
  }, [])

  const filteredRecords = useMemo(() => {
    if (active === 'dashboard' || active === 'settings') return records
    return records.filter((record) => {
      const matchesModule = record.module === active
      const haystack = JSON.stringify(record).toLowerCase()
      const matchesQuery = !query || haystack.includes(query.toLowerCase())
      const matchesMonth =
        active === 'client' || active === 'conflict_check' || !month || record.date?.startsWith(month)
      return matchesModule && matchesQuery && matchesMonth
    })
  }, [active, month, query, records])

  const handleCreate = useCallback(
    async (rawPath?: string) => {
      let target = rawPath ?? workspacePath
      if (!target && isTauri()) {
        const picked = await pickWorkspaceDirectory(await getDefaultWorkspaceRoot())
        if (!picked) return
        target = picked
      }
      if (!target) {
        setStatus('请先选择一个本地文件夹作为工作区。')
        return
      }
      setIsBusy(true)
      try {
        const result = await createWorkspace(target)
        handleSnapshotResult(result)
        setStatus(`工作区已就绪：${result.workspacePath || target}`)
      } catch (error) {
        setStatus(`创建失败：${friendlyError(error)}`)
      } finally {
        setIsBusy(false)
      }
    },
    [handleSnapshotResult, workspacePath],
  )

  const handleOpen = useCallback(
    async (rawPath?: string) => {
      let target = rawPath ?? workspacePath
      if (!target && isTauri()) {
        const picked = await pickWorkspaceDirectory(await getDefaultWorkspaceRoot())
        if (!picked) return
        target = picked
      }
      if (!target) {
        setStatus('请先选择一个本地文件夹作为工作区。')
        return
      }
      setIsBusy(true)
      try {
        const result = await openWorkspace(target)
        handleSnapshotResult(result)
        setStatus(`已打开工作区：${result.workspacePath || target}`)
      } catch (error) {
        setStatus(`打开失败：${friendlyError(error)}`)
      } finally {
        setIsBusy(false)
      }
    },
    [handleSnapshotResult, workspacePath],
  )

  const handleBrowse = useCallback(async () => {
    const picked = await pickWorkspaceDirectory(workspacePath || (await getDefaultWorkspaceRoot()))
    if (!picked) return
    setWorkspacePath(picked)
    const exists = await checkWorkspaceExists(picked)
    if (exists) {
      await handleOpen(picked)
    } else {
      await handleCreate(picked)
    }
  }, [handleCreate, handleOpen, workspacePath])

  const handleSeedDemo = useCallback(async () => {
    let target = snapshot?.workspacePath || workspacePath
    if (!target) {
      if (isTauri()) {
        const picked = await pickWorkspaceDirectory(await getDefaultWorkspaceRoot())
        if (!picked) return
        target = picked
      } else {
        target = '浏览器演示工作区'
      }
    }
    setIsBusy(true)
    try {
      const result = await seedDemoRecords(target)
      handleSnapshotResult(result)
      setStatus('已写入演示数据，覆盖客户、利冲、合同、诉讼、非诉、开票、日历各模块。')
    } catch (error) {
      setStatus(`演示数据写入失败：${friendlyError(error)}`)
    } finally {
      setIsBusy(false)
    }
  }, [handleSnapshotResult, snapshot?.workspacePath, workspacePath])

  const handleForget = useCallback(
    async (path: string) => {
      await forgetWorkspace(path)
      refreshRecents()
    },
    [refreshRecents],
  )

  const refreshWorkspace = async () => {
    if (!snapshot) return
    setIsBusy(true)
    try {
      const next = await openWorkspace(snapshot.workspacePath)
      handleSnapshotResult(next)
      setStatus('已从 Markdown 重新读取工作区。')
    } catch (error) {
      setStatus(`重读失败：${friendlyError(error)}`)
    } finally {
      setIsBusy(false)
    }
  }

  const goToAiSettings = useCallback(() => {
    setActive('settings')
    setSettingsTab('ai')
  }, [])

  // 启动恢复
  useEffect(() => {
    if (autoOpenAttempted.current) return
    autoOpenAttempted.current = true
    ;(async () => {
      const [appState, ai] = await Promise.all([loadAppState(), loadAiSettings()])
      setRecents(appState.recentWorkspaces ?? [])
      setAiSettings(ai)
      const last = appState.lastWorkspace ?? getLastWorkspaceSync()
      if (!last) return
      if (!isTauri()) {
        try {
          const result = await openWorkspace(last)
          handleSnapshotResult(result)
          setStatus(`已自动恢复浏览器演示工作区：${last}`)
        } catch {
          /* ignore */
        }
        return
      }
      const exists = await checkWorkspaceExists(last)
      if (!exists) return
      try {
        const result = await openWorkspace(last)
        handleSnapshotResult(result)
        setStatus(`已自动打开上次的工作区：${last}`)
      } catch {
        /* ignore */
      }
    })()
  }, [handleSnapshotResult])

  const showChrome = Boolean(snapshot)

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandLogo />
          <div>
            <strong>法律人业务管理</strong>
            <span>Local Markdown Workspace</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <NavButton
            active={active === 'dashboard'}
            icon={LayoutDashboard}
            label="工作台"
            onClick={() => setActive('dashboard')}
          />
          {MODULE_ORDER.map((moduleKey) => (
            <NavButton
              key={moduleKey}
              active={active === moduleKey}
              icon={moduleIcons[moduleKey]}
              label={config.modules[moduleKey].label}
              onClick={() => setActive(moduleKey)}
            />
          ))}
          <NavButton
            active={active === 'settings'}
            icon={Settings2}
            label="设置"
            onClick={() => setActive('settings')}
          />
        </nav>

        <div className="workspace-card">
          <label htmlFor="workspace">本地工作区</label>
          <div className="workspace-input-row">
            <input
              id="workspace"
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
              placeholder={isTauri() ? '点击右侧按钮选择文件夹' : '演示工作区名称'}
              spellCheck={false}
            />
            <button type="button" onClick={handleBrowse} disabled={isBusy} title="浏览文件夹">
              <FolderOpen size={16} />
            </button>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => handleCreate()} disabled={isBusy}>
              <Plus size={16} /> 新建
            </button>
            <button type="button" onClick={() => handleOpen()} disabled={isBusy}>
              <FolderOpen size={16} /> 打开
            </button>
          </div>
          {recents.length > 0 ? (
            <div className="recent-list" aria-label="最近工作区">
              <span className="recent-title">最近</span>
              {recents.map((path) => (
                <div className="recent-item" key={path}>
                  <button
                    type="button"
                    className="recent-open"
                    title={path}
                    onClick={() => handleOpen(path)}
                  >
                    {path}
                  </button>
                  <button
                    type="button"
                    className="recent-forget"
                    onClick={() => handleForget(path)}
                    aria-label="从最近列表移除"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <p className="status-hint">{status}</p>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <h1>
              {active === 'dashboard'
                ? '本地业务工作台'
                : active === 'settings'
                  ? '设置'
                  : config.modules[active].label}
            </h1>
            <p>
              {active === 'dashboard'
                ? encouragement
                : showChrome
                  ? `${config.workspaceName} · Markdown 主数据 · 索引按需重建`
                  : '创建或打开工作区后，所有数据将以 Markdown 形式保存在你选择的本地文件夹中。'}
            </p>
          </div>
          <div className="topbar-actions">
            {showChrome && active !== 'settings' ? (
              <button type="button" onClick={handleSeedDemo} disabled={isBusy} title="写入示例数据">
                <Sparkles size={16} /> 载入示例
              </button>
            ) : null}
            {active !== 'settings' ? (
              <button type="button" onClick={refreshWorkspace} disabled={!snapshot || isBusy}>
                <RefreshCw size={16} /> 重读 MD
              </button>
            ) : null}
          </div>
        </header>

        {!snapshot && active !== 'settings' ? (
          <Onboarding onCreate={() => handleCreate()} onOpen={() => handleOpen()} onDemo={handleSeedDemo} />
        ) : active === 'dashboard' ? (
          <Dashboard records={records} setActive={setActive} onSeedDemo={handleSeedDemo} />
        ) : active === 'settings' ? (
          <SettingsPage
            tab={settingsTab}
            setTab={setSettingsTab}
            config={config}
            workspacePath={snapshot?.workspacePath ?? workspacePath}
            aiSettings={aiSettings}
            onAiSettings={setAiSettings}
            onConfigSaved={(next) =>
              snapshot ? handleSnapshotResult({ ...snapshot, config: next }) : undefined
            }
            recents={recents}
            onClearRecents={async () => {
              for (const path of recents) await forgetWorkspace(path)
              refreshRecents()
            }}
            setStatus={setStatus}
          />
        ) : (
          <ModulePanel
            moduleKey={active}
            records={filteredRecords}
            allRecords={records}
            snapshot={snapshot!}
            month={month}
            setMonth={setMonth}
            query={query}
            setQuery={setQuery}
            onSnapshot={handleSnapshotResult}
            setStatus={setStatus}
            aiSettings={aiSettings}
            onConfigureAi={goToAiSettings}
          />
        )}
      </section>
    </main>
  )
}

function BrandLogo() {
  return (
    <div className="brand-mark" aria-label="logo">
      <svg viewBox="0 0 32 32" width="34" height="34" xmlns="http://www.w3.org/2000/svg">
        <rect x="6" y="6" width="20" height="14" rx="2" fill="#c92929" />
        <rect x="9" y="9" width="14" height="8" rx="1" fill="#fffaf0" />
        <rect x="12" y="12" width="2" height="2" fill="#c92929" />
        <rect x="18" y="12" width="2" height="2" fill="#c92929" />
        <rect x="11" y="20" width="3" height="6" fill="#c92929" />
        <rect x="18" y="20" width="3" height="6" fill="#c92929" />
        <rect x="20" y="14" width="6" height="6" rx="1" fill="#7a3010" />
        <rect x="21" y="15" width="4" height="1" fill="#fffaf0" />
        <rect x="21" y="17" width="4" height="1" fill="#fffaf0" />
      </svg>
    </div>
  )
}

function NavButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: typeof LayoutDashboard
  label: string
  onClick: () => void
}) {
  return (
    <button type="button" className={active ? 'nav-item active' : 'nav-item'} onClick={onClick}>
      <Icon size={18} />
      <span>{label}</span>
    </button>
  )
}

function Onboarding({
  onCreate,
  onOpen,
  onDemo,
}: {
  onCreate: () => void
  onOpen: () => void
  onDemo: () => void
}) {
  return (
    <div className="onboarding">
      <section>
        <h2>选择一个文件夹作为法律业务工作区</h2>
        <p>
          系统会在该文件夹下创建 clients、contracts、matters、invoices、calendar 等目录。
          每条记录都是独立 Markdown，台账按月动态汇总，工作区也可以直接用 Obsidian 等工具打开。
        </p>
        <div className="quick-paths">
          <button type="button" onClick={onCreate}>
            <Plus size={16} /> 新建工作区
          </button>
          <button type="button" onClick={onOpen}>
            <FolderOpen size={16} /> 打开已有工作区
          </button>
          <button type="button" className="ghost" onClick={onDemo}>
            <Sparkles size={16} /> 创建并载入示例
          </button>
        </div>
      </section>
      <section className="principles">
        <div>
          <ShieldCheck size={22} />
          <strong>完全本地化</strong>
          <span>无账号、无服务器、默认离线。</span>
        </div>
        <div>
          <FileSpreadsheet size={22} />
          <strong>Markdown 主数据</strong>
          <span>外部编辑、版本管理、跨工具友好。</span>
        </div>
        <div>
          <GitCompareArrows size={22} />
          <strong>先利冲再立项</strong>
          <span>历史客户、相对方、关联方本地检索。</span>
        </div>
      </section>
    </div>
  )
}

function Dashboard({
  records,
  setActive,
  onSeedDemo,
}: {
  records: RecordSummary[]
  setActive: (key: ModuleKey) => void
  onSeedDemo: () => void
}) {
  const metrics = {
    client: records.filter((item) => item.module === 'client').length,
    litigation: records.filter((item) => item.module === 'litigation').length,
    nonLitigation: records.filter((item) => item.module === 'non_litigation').length,
    invoiceOpen: records.filter(
      (item) => item.module === 'invoice' && item.fields.invoice_status !== '已开票',
    ).length,
  }

  const calendarItems = useMemo(
    () =>
      records
        .filter((item) => item.module === 'calendar_event')
        .map((item) => ({
          id: item.id,
          title: item.title,
          date: textValue(item.fields.date ?? item.date),
          time: textValue(item.fields.time),
          type: textValue(item.fields.event_type || '日程'),
          status: textValue(item.fields.status ?? item.status),
          relatedMatter: textValue(item.fields.related_matter),
        }))
        .filter((item) => item.date && (item.date >= today || !isClosedStatus(item.status)))
        .sort((left, right) => `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`))
        .slice(0, 8),
    [records],
  )

  const taskItems = useMemo(() => {
    const items: Array<{
      id: string
      title: string
      date: string
      source: string
      detail: string
      status: string
    }> = []

    records.forEach((record) => {
      const status = textValue(record.fields.status ?? record.status)
      if (isClosedStatus(status)) return

      if (record.module === 'calendar_event') {
        const eventType = textValue(record.fields.event_type)
        if (eventType === '任务' || eventType === '跟进') {
          items.push({
            id: `${record.id}-calendar-task`,
            title: record.title,
            date: textValue(record.fields.date ?? record.date),
            source: eventType,
            detail: textValue(record.fields.related_matter),
            status,
          })
        }
        return
      }

      if (record.module === 'litigation') {
        const nextTask = textValue(record.fields.next_task)
        const nextTaskDue = textValue(record.fields.next_task_due)
        const keyDeadline = textValue(record.fields.limitation_deadline)
        if (nextTask || nextTaskDue) {
          items.push({
            id: `${record.id}-next-task`,
            title: nextTask || `${record.title} · 下一步`,
            date: nextTaskDue,
            source: '诉讼',
            detail: record.title,
            status,
          })
        }
        if (keyDeadline) {
          items.push({
            id: `${record.id}-deadline`,
            title: `${record.title} · 关键期限`,
            date: keyDeadline,
            source: '期限',
            detail: textValue(record.fields.court || record.fields.case_number),
            status,
          })
        }
        return
      }

      if (record.module === 'non_litigation') {
        const deadline = textValue(record.fields.delivery_deadline)
        if (deadline) {
          items.push({
            id: `${record.id}-delivery`,
            title: `${record.title} · 交付`,
            date: deadline,
            source: '非诉',
            detail: textValue(record.fields.client_name),
            status,
          })
        }
        return
      }

      if (record.module === 'invoice') {
        const invoiceStatus = textValue(record.fields.invoice_status)
        if (invoiceStatus && invoiceStatus !== '已开票' && invoiceStatus !== '无需开票') {
          const receivable = moneyValue(record.fields.receivable_amount)
          const paid = moneyValue(record.fields.paid_amount)
          items.push({
            id: `${record.id}-invoice`,
            title: record.title,
            date: textValue(record.fields.invoice_date),
            source: '开票',
            detail: receivable > 0 ? `应收 ${receivable}，已收 ${paid}` : textValue(record.fields.client_name),
            status: invoiceStatus,
          })
        }
      }
    })

    return items
      .sort((left, right) => (left.date || '9999-12-31').localeCompare(right.date || '9999-12-31'))
      .slice(0, 8)
  }, [records])

  return (
    <div className="dashboard-grid">
      <Metric title="客户档案" value={metrics.client} icon={Users} onClick={() => setActive('client')} />
      <Metric
        title="诉讼案件"
        value={metrics.litigation}
        icon={Landmark}
        onClick={() => setActive('litigation')}
      />
      <Metric
        title="非诉业务"
        value={metrics.nonLitigation}
        icon={FileInput}
        onClick={() => setActive('non_litigation')}
      />
      <Metric
        title="待核开票"
        value={metrics.invoiceOpen}
        icon={ReceiptText}
        onClick={() => setActive('invoice')}
      />

      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>日历日程</h2>
            <span>开庭、会议、交付、期限和跟进安排</span>
          </div>
          <button type="button" onClick={() => setActive('calendar_event')}>
            <CalendarDays size={14} /> 进入日历
          </button>
        </div>
        <div className="schedule-list">
          {calendarItems.length === 0 ? (
            <div className="empty-block">
              <p>暂无近期日程。</p>
              <button type="button" onClick={onSeedDemo}>
                <Sparkles size={14} /> 一键载入示例数据
              </button>
            </div>
          ) : (
            calendarItems.map((item) => (
              <article key={item.id} className={item.date < today ? 'overdue' : ''}>
                <time>
                  <strong>{formatDateLabel(item.date)}</strong>
                  <span>{item.date}{item.time ? ` ${item.time}` : ''}</span>
                </time>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.relatedMatter || item.status || '未关联事项'}</span>
                </div>
                <em>{item.type}</em>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>待办任务</h2>
            <span>从日历任务、诉讼进度、非诉交付和开票状态汇总</span>
          </div>
          <button type="button" onClick={() => setActive('litigation')}>
            <ListTodo size={14} /> 查看来源
          </button>
        </div>
        <div className="task-list">
          {taskItems.length === 0 ? (
            <div className="empty-block">
              <p>暂无待办任务。</p>
              <button type="button" onClick={() => setActive('calendar_event')}>
                <Plus size={14} /> 新增日程任务
              </button>
            </div>
          ) : (
            taskItems.map((item) => (
              <article key={item.id} className={item.date && item.date < today ? 'overdue' : ''}>
                <CheckCircle2 size={16} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail || item.status || '待处理'}</span>
                </div>
                <time>{item.date ? formatDateLabel(item.date) : '未设期限'}</time>
                <em>{item.source}</em>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function Metric({
  title,
  value,
  icon: Icon,
  onClick,
}: {
  title: string
  value: number
  icon: typeof Users
  onClick: () => void
}) {
  return (
    <button type="button" className="metric" onClick={onClick}>
      <Icon size={20} />
      <span>{title}</span>
      <strong>{value}</strong>
    </button>
  )
}

// ---------------------------------------------------------------------------
// AI 助手 — 优先调真实 LLM；无配置时降级到本地正则
// ---------------------------------------------------------------------------

function AiAssistant({
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

// ---------------------------------------------------------------------------
// 利冲分析
// ---------------------------------------------------------------------------

function ConflictAnalyzer({
  records,
  proposedClient,
  opposingParties,
  relatedParties,
}: {
  records: RecordSummary[]
  proposedClient: string
  opposingParties: string
  relatedParties: string
}) {
  const hits: AnnotatedConflictHit[] = useMemo(
    () =>
      analyzeClientConflicts(records, {
        proposedClient,
        opposingParties: [opposingParties],
        relatedParties: [relatedParties],
      }),
    [opposingParties, proposedClient, records, relatedParties],
  )

  if (!proposedClient && !opposingParties && !relatedParties) {
    return (
      <p className="muted">
        在上方表单中填入"拟委托人 / 相对方 / 关联方"后，系统会自动比对现有客户与历史事项。
      </p>
    )
  }

  if (hits.length === 0) {
    return (
      <div className="conflict-clear">
        <ShieldCheck size={16} />
        <span>未发现冲突命中。仍建议结合人工判断后留痕。</span>
      </div>
    )
  }

  return (
    <div className="conflict-hits">
      {hits.map((hit) => (
        <div className={`hit ${hit.severity}`} key={`${hit.id}-${hit.matchedField}-${hit.reason}`}>
          <div>
            <strong>{hit.title}</strong>
            <span>
              {hit.severity === 'block' ? '阻断' : '提醒'} · {hit.module}
            </span>
          </div>
          <p>{hit.reason}</p>
          <small>
            命中字段：{hit.matchedField} = {hit.matchedValue}
          </small>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 附件抽屉
// ---------------------------------------------------------------------------

function AttachmentDrawer({
  workspacePath,
  record,
  onClose,
  setStatus,
}: {
  workspacePath: string
  record: RecordSummary
  onClose: () => void
  setStatus: (status: string) => void
}) {
  const [items, setItems] = useState<AttachmentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [dirPath, setDirPath] = useState<string>('')

  const recordPath = record.path ?? ''

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listAttachments(workspacePath, recordPath)
      setItems(list)
      const dir = await ensureAttachmentsDir(workspacePath, recordPath)
      setDirPath(dir)
    } catch (error) {
      setStatus(`读取附件失败：${friendlyError(error)}`)
    } finally {
      setLoading(false)
    }
  }, [recordPath, setStatus, workspacePath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = async () => {
    if (!isTauri()) {
      setStatus('附件管理仅在桌面 App 中可用。')
      return
    }
    try {
      const sources = await pickFilesToAttach()
      if (sources.length === 0) return
      const copied = await addAttachments(workspacePath, recordPath, sources)
      setStatus(`已添加 ${copied.length} 个附件。`)
      refresh()
    } catch (error) {
      setStatus(`添加失败：${friendlyError(error)}`)
    }
  }

  const handleReveal = async (path: string) => {
    try {
      await openInFinder(path)
    } catch (error) {
      setStatus(`无法打开：${friendlyError(error)}`)
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`确认从附件目录中删除「${name}」？此操作不可撤销。`)) return
    try {
      await deleteAttachment(workspacePath, recordPath, name)
      setStatus(`已删除 ${name}`)
      refresh()
    } catch (error) {
      setStatus(`删除失败：${friendlyError(error)}`)
    }
  }

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h3>附件 · {record.title}</h3>
            <small>{recordPath}</small>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="drawer-toolbar">
          <button type="button" onClick={handleAdd}>
            <Upload size={14} /> 添加附件
          </button>
          <button type="button" onClick={() => dirPath && handleReveal(dirPath)}>
            <FolderOpen size={14} /> 在 Finder 中打开
          </button>
          <button type="button" onClick={refresh}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>

        <p className="muted dir-hint" title={dirPath}>
          {dirPath || '附件目录将自动创建'}
        </p>

        <div className="attachment-list">
          {loading ? (
            <p className="muted">加载中…</p>
          ) : items.length === 0 ? (
            <p className="muted">暂无附件。点上方"添加附件"，或在 Finder 中直接拖文件到该目录。</p>
          ) : (
            items.map((item) => (
              <article key={item.absolutePath}>
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.kind?.toUpperCase() || '文件'} · {formatBytes(item.size)} · {item.modified}
                  </span>
                </div>
                <div className="attach-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="在 Finder 中显示"
                    onClick={() => handleReveal(item.absolutePath)}
                  >
                    <Eye size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="删除"
                    onClick={() => handleDelete(item.name)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 模块面板
// ---------------------------------------------------------------------------

function ModulePanel({
  moduleKey,
  records,
  allRecords,
  snapshot,
  month,
  setMonth,
  query,
  setQuery,
  onSnapshot,
  setStatus,
  aiSettings,
  onConfigureAi,
}: {
  moduleKey: ModuleKey
  records: RecordSummary[]
  allRecords: RecordSummary[]
  snapshot: WorkspaceSnapshot
  month: string
  setMonth: (month: string) => void
  query: string
  setQuery: (query: string) => void
  onSnapshot: (snapshot: WorkspaceSnapshot) => void
  setStatus: (status: string) => void
  aiSettings: AISettings
  onConfigureAi: () => void
}) {
  const definition = snapshot.config.modules[moduleKey]
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyRecordFor(definition))
  const [body, setBody] = useState('')
  const [attachmentRecord, setAttachmentRecord] = useState<RecordSummary | null>(null)

  const ledgerFields = definition.fields.filter((field) => field.ledger).slice(0, 8)

  useEffect(() => {
    setForm(emptyRecordFor(definition))
    setBody('')
  }, [definition, moduleKey])

  const handleSave = async () => {
    try {
      const next = await createRecord(snapshot.workspacePath, moduleKey, form, body)
      onSnapshot(next)
      setForm(emptyRecordFor(definition))
      setBody('')
      setStatus(`已写入 ${definition.label} Markdown 记录。`)
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  const handleLedger = async () => {
    try {
      const output = await generateLedgerSnapshot(
        snapshot.workspacePath,
        month,
        moduleKey,
        allRecords,
      )
      setStatus(`月度台账快照已生成：${output}`)
    } catch (error) {
      setStatus(`生成失败：${friendlyError(error)}`)
    }
  }

  const handleCsv = () => {
    try {
      exportRowsToCsv(records, `${month}-${moduleKey}.csv`)
      setStatus('已按当前筛选结果导出 CSV（Excel 可直接打开）。')
    } catch (error) {
      setStatus(`导出失败：${friendlyError(error)}`)
    }
  }

  const applyAiPatch = (patch: Record<string, unknown>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  const supportsConflictCheck =
    moduleKey === 'conflict_check' ||
    moduleKey === 'litigation' ||
    moduleKey === 'non_litigation' ||
    moduleKey === 'service_contract'

  const proposedClient = String(form.client_name ?? form.name ?? '')
  const opposingPartiesText = String(form.opposing_parties ?? '')
  const relatedPartiesText = String(form.related_parties ?? '')

  return (
    <div className="module-layout">
      <section className="panel table-panel">
        <div className="section-title">
          <div>
            <h2>{definition.label}台账</h2>
            <span>{definition.description}</span>
          </div>
          <div className="toolbar">
            <label>
              月份
              <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
            </label>
            <label>
              搜索
              <span className="search-box">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="客户、案号、状态"
                />
              </span>
            </label>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>编号</th>
                <th>标题</th>
                {ledgerFields.map((field) => (
                  <th key={field.key}>{field.label}</th>
                ))}
                <th className="th-actions">附件</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={3 + ledgerFields.length} className="empty-row">
                    暂无符合条件的记录。
                  </td>
                </tr>
              ) : (
                records.map((record) => (
                  <tr key={record.id}>
                    <td>{record.id}</td>
                    <td>
                      <strong>{record.title}</strong>
                      {record.path ? <span className="muted">{record.path}</span> : null}
                    </td>
                    {ledgerFields.map((field) => (
                      <td key={field.key}>{String(record.fields[field.key] ?? '')}</td>
                    ))}
                    <td className="td-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="附件"
                        onClick={() => setAttachmentRecord(record)}
                        disabled={!record.path}
                      >
                        <Paperclip size={13} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="button-row end">
          <button type="button" onClick={handleLedger}>
            <Save size={16} /> 生成月度 MD 快照
          </button>
          <button type="button" onClick={handleCsv}>
            <FileSpreadsheet size={16} /> 导出 CSV
          </button>
        </div>
      </section>

      <aside className="panel editor-panel">
        <h2>新建{definition.label}</h2>
        <AiAssistant
          moduleKey={moduleKey}
          config={snapshot.config}
          aiSettings={aiSettings}
          onApply={applyAiPatch}
          onConfigure={onConfigureAi}
          setStatus={setStatus}
        />
        <DynamicForm fields={definition.fields} value={form} onChange={setForm} />
        <label className="field full">
          Markdown 正文
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="沟通纪要、复盘、背景说明..."
          />
        </label>
        <button type="button" className="primary" onClick={handleSave}>
          <Plus size={16} /> 保存为单事项 MD
        </button>

        {supportsConflictCheck ? (
          <div className="conflict-box">
            <h3>
              <ShieldCheck size={14} /> 与现有客户的利益冲突分析
            </h3>
            <ConflictAnalyzer
              records={allRecords}
              proposedClient={proposedClient}
              opposingParties={opposingPartiesText}
              relatedParties={relatedPartiesText}
            />
          </div>
        ) : null}
      </aside>

      {attachmentRecord ? (
        <AttachmentDrawer
          workspacePath={snapshot.workspacePath}
          record={attachmentRecord}
          onClose={() => setAttachmentRecord(null)}
          setStatus={setStatus}
        />
      ) : null}
    </div>
  )
}

function DynamicForm({
  fields,
  value,
  onChange,
}: {
  fields: FieldDefinition[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const setValue = (key: string, next: unknown) => {
    onChange({ ...value, [key]: next })
  }

  return (
    <div className="dynamic-form">
      {fields.map((field) => (
        <label key={field.key} className={field.type === 'long_text' ? 'field full' : 'field'}>
          <span>
            {field.label}
            {field.required ? <b>*</b> : null}
          </span>
          {field.type === 'long_text' ? (
            <textarea
              value={String(value[field.key] ?? '')}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          ) : field.type === 'single_select' && field.options?.length ? (
            <select
              value={String(value[field.key] ?? '')}
              onChange={(event) => setValue(field.key, event.target.value)}
            >
              <option value="">（未选择）</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(value[field.key])}
              onChange={(event) => setValue(field.key, event.target.checked)}
            />
          ) : (
            <input
              type={
                field.type === 'date'
                  ? 'date'
                  : field.type === 'money' || field.type === 'number'
                    ? 'number'
                    : 'text'
              }
              value={String(value[field.key] ?? '')}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          )}
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 设置页（多 tab）
// ---------------------------------------------------------------------------

function SettingsPage({
  tab,
  setTab,
  config,
  workspacePath,
  aiSettings,
  onAiSettings,
  onConfigSaved,
  recents,
  onClearRecents,
  setStatus,
}: {
  tab: 'ai' | 'general' | 'fields' | 'about'
  setTab: (value: 'ai' | 'general' | 'fields' | 'about') => void
  config: WorkspaceSnapshot['config']
  workspacePath: string
  aiSettings: AISettings
  onAiSettings: (next: AISettings) => void
  onConfigSaved: (config: WorkspaceSnapshot['config']) => void
  recents: string[]
  onClearRecents: () => void
  setStatus: (status: string) => void
}) {
  return (
    <div className="settings-page">
      <nav className="settings-tabs" aria-label="设置分类">
        <button type="button" className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
          <KeyRound size={14} /> AI 配置
        </button>
        <button
          type="button"
          className={tab === 'general' ? 'active' : ''}
          onClick={() => setTab('general')}
        >
          <Settings2 size={14} /> 通用
        </button>
        <button
          type="button"
          className={tab === 'fields' ? 'active' : ''}
          onClick={() => setTab('fields')}
        >
          <ClipboardList size={14} /> 字段
        </button>
        <button
          type="button"
          className={tab === 'about' ? 'active' : ''}
          onClick={() => setTab('about')}
        >
          <Sparkles size={14} /> 关于
        </button>
      </nav>

      <div className="settings-body">
        {tab === 'ai' ? (
          <AiSettingsTab
            settings={aiSettings}
            onChange={onAiSettings}
            setStatus={setStatus}
            config={config}
          />
        ) : tab === 'general' ? (
          <GeneralSettingsTab
            workspacePath={workspacePath}
            recents={recents}
            onClearRecents={onClearRecents}
            setStatus={setStatus}
          />
        ) : tab === 'fields' ? (
          <FieldSettingsTab
            config={config}
            workspacePath={workspacePath}
            onSaved={onConfigSaved}
            setStatus={setStatus}
          />
        ) : (
          <AboutTab />
        )}
      </div>
    </div>
  )
}

function AiSettingsTab({
  settings,
  onChange,
  setStatus,
  config,
}: {
  settings: AISettings
  onChange: (next: AISettings) => void
  setStatus: (status: string) => void
  config: WorkspaceSnapshot['config']
}) {
  const [draft, setDraft] = useState<AISettings>(settings)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [previewModule, setPreviewModule] = useState<ModuleKey>('litigation')
  const [previewSampleText, setPreviewSampleText] = useState(
    '示例：2026年4月发上海长宁区法院的起诉状摘录，案号(2026)沪0105民初1234号，原告上海岚山科技有限公司，被告北辰贸易有限公司，案由服务合同纠纷，标的额120000元。',
  )
  const [previewCustomPrompt, setPreviewCustomPrompt] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  const preset = PROVIDER_PRESETS[draft.provider] ?? PROVIDER_PRESETS.openai

  const update = (patch: Partial<AISettings>) => {
    setDraft({ ...draft, ...patch })
  }

  const handleProvider = (provider: AiProvider) => {
    const next: AISettings = {
      ...draft,
      provider,
      // 切到新 provider 时若用户没自定义 baseUrl/model，自动填默认
      baseUrl: !draft.baseUrl || isPresetBase(draft.provider, draft.baseUrl) ? '' : draft.baseUrl,
      model: !draft.model || isPresetModel(draft.provider, draft.model) ? '' : draft.model,
    }
    setDraft(next)
  }

  const handleSave = async () => {
    try {
      await saveAiSettings(draft)
      onChange(draft)
      setStatus('AI 配置已保存到 ~/Library/Application Support/com.local.legalbiz/ai.json')
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await aiTestConnection(draft)
      setTestResult({
        ok: true,
        message: `连通成功：${result.provider}/${result.model}，耗时 ${result.latencyMs}ms。响应：${result.content.slice(0, 60)}`,
      })
    } catch (error) {
      setTestResult({ ok: false, message: friendlyError(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">
          <h2>AI 接口</h2>
          <span>支持 OpenAI / DeepSeek / Claude / 豆包(火山方舟) / 任意 OpenAI 兼容</span>
        </div>

        <p className="muted setup-hint">
          只要填写并保存 API Key，AI 助手即视为已启用。
          {isAiReady(draft) ? (
            <strong className="ready-badge"> 当前：已启用</strong>
          ) : (
            <strong className="ready-badge off"> 当前：未启用（请填 API Key）</strong>
          )}
        </p>

        <label className="field">
          <span>提供商</span>
          <div className="provider-pills">
            {(Object.keys(PROVIDER_PRESETS) as AiProvider[]).map((key) => (
              <button
                key={key}
                type="button"
                className={draft.provider === key ? 'active' : ''}
                onClick={() => handleProvider(key)}
              >
                {PROVIDER_PRESETS[key].label}
              </button>
            ))}
          </div>
        </label>
        <p className="muted preset-help">{preset.help}</p>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder={
              draft.provider === 'anthropic' ? 'sk-ant-...' : draft.provider === 'deepseek' ? 'sk-...' : 'sk-...'
            }
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder={preset.baseUrl}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input
            value={draft.model}
            onChange={(event) => update({ model: event.target.value })}
            placeholder={preset.model}
            spellCheck={false}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Temperature</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature ?? 0.2}
              onChange={(event) => update({ temperature: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>Max tokens</span>
            <input
              type="number"
              min={256}
              max={32000}
              step={128}
              value={draft.maxTokens ?? 2048}
              onChange={(event) => update({ maxTokens: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>超时（秒）</span>
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={draft.timeoutSeconds ?? 60}
              onChange={(event) => update({ timeoutSeconds: Number(event.target.value) })}
            />
          </label>
        </div>

        <label className="field full">
          <span>系统提示词（留空则使用默认）</span>
          <textarea
            rows={9}
            value={draft.systemPrompt}
            onChange={(event) => update({ systemPrompt: event.target.value })}
            placeholder={DEFAULT_AI_SYSTEM_PROMPT}
          />
          <small className="muted">
            <strong>系统提示词 = 通用工作规则</strong>，对所有模块共用。
            <strong>当前模块的字段 schema</strong>（key / type / options / required）
            会在每次调用时<strong>动态拼到 user message</strong>，所以这里不需要枚举字段。
            点下方"预览实际发送内容"按钮可看到任意模块的拼接结果。
          </small>
        </label>

        <details className="prompt-preview" open={previewOpen}>
          <summary onClick={(event) => { event.preventDefault(); setPreviewOpen((v) => !v) }}>
            <Eye size={14} /> 预览实际发送内容（按模块拼接）
          </summary>
          <div className="prompt-preview-body">
            <div className="field-row">
              <label className="field">
                <span>模块</span>
                <select
                  value={previewModule}
                  onChange={(event) => setPreviewModule(event.target.value as ModuleKey)}
                >
                  {MODULE_ORDER.map((key) => (
                    <option key={key} value={key}>
                      {config.modules[key].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ gridColumn: 'span 2' }}>
                <span>补充指引（可选，模拟 AI 助手里的输入）</span>
                <input
                  value={previewCustomPrompt}
                  onChange={(event) => setPreviewCustomPrompt(event.target.value)}
                  placeholder={'例如：把"乙方"作为客户、"甲方"作为相对方'}
                />
              </label>
            </div>
            <label className="field full">
              <span>示例文本</span>
              <textarea
                rows={3}
                value={previewSampleText}
                onChange={(event) => setPreviewSampleText(event.target.value)}
              />
            </label>
            <PromptPreview
              text={previewSampleText}
              targetModule={previewModule}
              config={config}
              settings={draft}
              customPrompt={previewCustomPrompt}
            />
          </div>
        </details>

        <div className="button-row end">
          <button type="button" onClick={handleTest} disabled={testing || !draft.apiKey}>
            {testing ? <Loader2 size={14} className="spinning" /> : <CheckCircle2 size={14} />}{' '}
            测试连接
          </button>
          <button type="button" className="primary" onClick={handleSave}>
            <Save size={14} /> 保存
          </button>
        </div>

        {testResult ? (
          <div className={`test-banner ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{testResult.message}</span>
          </div>
        ) : null}
      </section>

      <aside className="panel">
        <div className="section-title">
          <h2>说明</h2>
          <span>v1 默认调用本地 Rust 端发起 HTTPS 请求</span>
        </div>
        <ul className="info-list">
          <li>
            <strong>本地存储</strong>：API Key 写入
            <code>~/Library/Application Support/com.local.legalbiz/ai.json</code>，不会同步到工作区。
          </li>
          <li>
            <strong>Claude</strong>：自动添加 <code>anthropic-version: 2023-06-01</code> 头。
          </li>
          <li>
            <strong>豆包</strong>：火山方舟控制台的 model id 形如 <code>doubao-1-5-pro-32k-250115</code> 或自定义 endpoint id。
          </li>
          <li>
            <strong>自定义</strong>：OneAPI、SiliconFlow、Together、Groq 都属此类，按 OpenAI Chat Completions 协议调用。
          </li>
          <li>
            <strong>调用失败</strong>：可点上方"测试连接"，错误信息会包含 HTTP 状态码与服务端 body 摘要，便于排查。
          </li>
        </ul>
      </aside>
    </div>
  )
}

function PromptPreview({
  text,
  targetModule,
  config,
  settings,
  customPrompt,
}: {
  text: string
  targetModule: ModuleKey
  config: WorkspaceSnapshot['config']
  settings: AISettings
  customPrompt: string
}) {
  const messages = useMemo(
    () => buildExtractionMessages(text, targetModule, config, settings, customPrompt),
    [config, customPrompt, settings, targetModule, text],
  )
  return (
    <div className="prompt-blocks">
      <div>
        <header>
          <span className="role">role: system</span>
          <small className="muted">通用规则 · 所有模块共用</small>
        </header>
        <pre>{messages.system}</pre>
      </div>
      <div>
        <header>
          <span className="role user">role: user</span>
          <small className="muted">每次调用按当前模块动态拼接</small>
        </header>
        <pre>{messages.user}</pre>
      </div>
    </div>
  )
}

function isPresetBase(provider: AiProvider, value: string): boolean {
  const preset = PROVIDER_PRESETS[provider]
  return preset ? value.trim() === preset.baseUrl : false
}
function isPresetModel(provider: AiProvider, value: string): boolean {
  const preset = PROVIDER_PRESETS[provider]
  return preset ? value.trim() === preset.model : false
}

function GeneralSettingsTab({
  workspacePath,
  recents,
  onClearRecents,
  setStatus,
}: {
  workspacePath: string
  recents: string[]
  onClearRecents: () => void
  setStatus: (status: string) => void
}) {
  const [defaultRoot, setDefaultRoot] = useState('')

  useEffect(() => {
    getDefaultWorkspaceRoot().then(setDefaultRoot).catch(() => setDefaultRoot(''))
  }, [])

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">
          <h2>工作区</h2>
          <span>当前会话</span>
        </div>
        <p>
          <strong>当前工作区：</strong>
          <code>{workspacePath || '（未选择）'}</code>
        </p>
        <p>
          <strong>默认新建位置：</strong>
          <code>{defaultRoot || '~/LegalVault'}</code>
        </p>

        <div className="button-row">
          <button
            type="button"
            onClick={async () => {
              if (workspacePath) {
                await openInFinder(workspacePath)
              } else {
                setStatus('请先打开一个工作区。')
              }
            }}
          >
            <FolderOpen size={14} /> 在 Finder 中打开当前工作区
          </button>
        </div>
      </section>

      <aside className="panel">
        <div className="section-title">
          <h2>最近工作区</h2>
          <span>{recents.length} 条</span>
        </div>
        {recents.length === 0 ? (
          <p className="muted">暂无最近记录。</p>
        ) : (
          <ul className="recent-full-list">
            {recents.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        )}
        <div className="button-row end">
          <button type="button" onClick={onClearRecents} disabled={recents.length === 0}>
            <Trash2 size={14} /> 清空最近列表
          </button>
        </div>
      </aside>
    </div>
  )
}

function FieldSettingsTab({
  config,
  workspacePath,
  onSaved,
  setStatus,
}: {
  config: WorkspaceSnapshot['config']
  workspacePath: string
  onSaved: (config: WorkspaceSnapshot['config']) => void
  setStatus: (status: string) => void
}) {
  const [draft, setDraft] = useState(config)
  const [moduleKey, setModuleKey] = useState<ModuleKey>('litigation')
  const [newField, setNewField] = useState({ key: '', label: '', type: 'text' as FieldType })

  useEffect(() => {
    setDraft(config)
  }, [config])

  const moduleDef = draft.modules[moduleKey]

  const addField = () => {
    if (!newField.key || !newField.label) return
    if (moduleDef.fields.some((field) => field.key === newField.key)) {
      setStatus(`字段 Key 重复：${newField.key}`)
      return
    }
    const nextField: FieldDefinition = {
      key: newField.key,
      label: newField.label,
      type: newField.type,
      required: false,
      builtIn: false,
      ledger: true,
      filterable: true,
    }
    setDraft({
      ...draft,
      modules: {
        ...draft.modules,
        [moduleKey]: { ...moduleDef, fields: [...moduleDef.fields, nextField] },
      },
    })
    setNewField({ key: '', label: '', type: 'text' })
  }

  const toggleField = (fieldKey: string, patch: Partial<FieldDefinition>) => {
    setDraft({
      ...draft,
      modules: {
        ...draft.modules,
        [moduleKey]: {
          ...moduleDef,
          fields: moduleDef.fields.map((field) =>
            field.key === fieldKey ? { ...field, ...patch } : field,
          ),
        },
      },
    })
  }

  const removeField = (fieldKey: string) => {
    setDraft({
      ...draft,
      modules: {
        ...draft.modules,
        [moduleKey]: {
          ...moduleDef,
          fields: moduleDef.fields.filter((field) => field.key !== fieldKey),
        },
      },
    })
  }

  const persist = async () => {
    try {
      const saved = await saveConfig(workspacePath, draft)
      onSaved(saved)
      setStatus('字段配置已保存到 .legalbiz/config.json。')
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">
          <h2>板块字段</h2>
          <span>大板块固定；板块内字段可扩展。内置字段锁定语义。</span>
        </div>
        <div className="module-pills">
          {MODULE_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className={moduleKey === key ? 'active' : ''}
              onClick={() => setModuleKey(key)}
            >
              {draft.modules[key].label}
            </button>
          ))}
        </div>

        <div className="field-list">
          {moduleDef.fields.map((field) => (
            <article key={field.key}>
              <div>
                <strong>{field.label}</strong>
                <span>
                  {field.key} · {fieldTypeLabel[field.type]} · {field.builtIn ? '内置字段' : '自定义字段'}
                </span>
              </div>
              <label>
                入台账
                <input
                  type="checkbox"
                  checked={field.ledger}
                  onChange={(event) => toggleField(field.key, { ledger: event.target.checked })}
                />
              </label>
              <label>
                可筛选
                <input
                  type="checkbox"
                  checked={field.filterable}
                  onChange={(event) => toggleField(field.key, { filterable: event.target.checked })}
                />
              </label>
              {field.builtIn ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  title="移除字段"
                  onClick={() => removeField(field.key)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </article>
          ))}
        </div>
      </section>

      <aside className="panel editor-panel">
        <h2>新增字段</h2>
        <label className="field">
          字段 Key
          <input
            value={newField.key}
            onChange={(event) => setNewField({ ...newField, key: event.target.value })}
            placeholder="custom_priority"
          />
        </label>
        <label className="field">
          显示名
          <input
            value={newField.label}
            onChange={(event) => setNewField({ ...newField, label: event.target.value })}
            placeholder="业务优先级"
          />
        </label>
        <label className="field">
          字段类型
          <select
            value={newField.type}
            onChange={(event) => setNewField({ ...newField, type: event.target.value as FieldType })}
          >
            {fieldTypes.map((type) => (
              <option key={type} value={type}>
                {fieldTypeLabel[type]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={addField}>
          <Plus size={16} /> 加入当前板块
        </button>
        <button type="button" className="primary" onClick={persist}>
          <Save size={16} /> 保存字段配置
        </button>
      </aside>
    </div>
  )
}

function AboutTab() {
  return (
    <div className="settings-grid">
      <section className="panel about-panel">
        <h2>法律人业务管理系统</h2>
        <p className="muted">本地 Markdown 工作区 · v0.1</p>
        <ul className="info-list">
          <li>客户、利冲、合同、诉讼、非诉、开票、日历七个内置模块</li>
          <li>所有数据以独立 Markdown 文件保存，可用 Obsidian 等工具同时打开</li>
          <li>AI 解析支持 OpenAI / DeepSeek / Claude / 豆包(火山方舟) / 任意 OpenAI 兼容</li>
          <li>每条记录可挂附件目录；点表格 📎 图标即可管理</li>
          <li>无服务器、无账号；启动自动恢复上次工作区</li>
        </ul>
      </section>
    </div>
  )
}

export default App
