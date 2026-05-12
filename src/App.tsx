import { AlertTriangle, FolderOpen, Inbox, LayoutDashboard, Plus, RefreshCw, Settings2, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { ENCOURAGEMENTS } from './encouragements'
import {
  defaultAiSettings,
  defaultConfig,
  MODULE_ORDER,
  type AISettings,
  type ModuleKey,
  type WorkspaceSnapshot,
} from './domain'
import {
  checkWorkspaceExists,
  createWorkspace,
  forgetWorkspace,
  getDefaultWorkspaceRoot,
  getLastWorkspaceSync,
  getRecentWorkspacesSync,
  isTauri,
  loadAiSettings,
  loadAppState,
  openWorkspace,
  pickWorkspaceDirectory,
  seedDemoRecords,
} from './storage'
import { currentMonth, emptyRecords, moduleIcons } from './shared/constants'
import type { RelationTarget } from './shared/relations'
import { friendlyError } from './shared/utils'
import BrandLogo from './components/BrandLogo'
import NavButton from './components/NavButton'
import Onboarding from './components/Onboarding'
import Dashboard from './components/Dashboard'
import InboxPanel from './components/InboxPanel'
import ModulePanel from './components/ModulePanel'
import SettingsPage from './components/settings/SettingsPage'

type FieldFiltersByModule = Partial<Record<ModuleKey, Record<string, string>>>

function App() {
  const [workspacePath, setWorkspacePath] = useState('')
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [active, setActive] = useState<ModuleKey | 'dashboard' | 'settings' | 'inbox'>('dashboard')
  const [month, setMonth] = useState(currentMonth)
  const [query, setQuery] = useState('')
  const [fieldFilters, setFieldFilters] = useState<FieldFiltersByModule>({})
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
  const diagnostics = snapshot?.diagnostics ?? []

  const refreshRecents = useCallback(() => {
    setRecents(getRecentWorkspacesSync())
  }, [])

  const handleSnapshotResult = useCallback((next: WorkspaceSnapshot) => {
    setSnapshot(next)
    setWorkspacePath(next.workspacePath || '')
    setRecents(getRecentWorkspacesSync())
  }, [])

  const filteredRecords = useMemo(() => {
    if (active === 'dashboard' || active === 'settings' || active === 'inbox') return records
    const definition = config.modules[active]
    const activeFieldFilters = fieldFilters[active] ?? {}
    const filterableFields = definition.fields.filter((field) => field.filterable)

    return records.filter((record) => {
      const matchesModule = record.module === active
      const haystack = JSON.stringify(record).toLowerCase()
      const matchesQuery = !query || haystack.includes(query.toLowerCase())
      const matchesMonth =
        active === 'client' || active === 'conflict_check' || !month || record.date?.startsWith(month)
      const matchesFieldFilters = filterableFields.every((field) => {
        const filterValue = activeFieldFilters[field.key]?.trim()
        if (!filterValue) return true

        const recordValue = record.fields[field.key]
        if (field.type === 'boolean') {
          const valueText = String(recordValue ?? '').toLowerCase()
          if (filterValue === 'true') return recordValue === true || valueText === 'true' || valueText === '是'
          return (
            recordValue === false ||
            recordValue == null ||
            valueText === '' ||
            valueText === 'false' ||
            valueText === '否'
          )
        }
        if (field.type === 'single_select') return String(recordValue ?? '') === filterValue

        return String(recordValue ?? '').toLowerCase().includes(filterValue.toLowerCase())
      })

      return matchesModule && matchesQuery && matchesMonth && matchesFieldFilters
    })
  }, [active, config, fieldFilters, month, query, records])

  const handleFieldFilter = useCallback((fieldKey: string, value: string) => {
    if (active === 'dashboard' || active === 'settings' || active === 'inbox') return
    setFieldFilters((prev) => {
      const current = prev[active] ?? {}
      const nextForModule = { ...current }
      if (value) {
        nextForModule[fieldKey] = value
      } else {
        delete nextForModule[fieldKey]
      }
      return { ...prev, [active]: nextForModule }
    })
  }, [active])

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

  const openReference = useCallback((target: RelationTarget) => {
    setActive(target.module)
    setQuery(target.query)
    setMonth('')
    setFieldFilters((prev) => ({ ...prev, [target.module]: {} }))
    setStatus(`已打开关联记录：${target.label}`)
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
          <NavButton
            active={active === 'inbox'}
            icon={Inbox}
            label="收件箱"
            onClick={() => setActive('inbox')}
          />
          <div className="nav-separator" />
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
                ? '工作台'
                : active === 'settings'
                  ? '设置'
                  : active === 'inbox'
                    ? '智能收件箱'
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

        {diagnostics.length > 0 ? (
          <section className="diagnostic-banner" aria-live="polite">
            <div>
              <AlertTriangle size={16} />
              <strong>有 {diagnostics.length} 个 Markdown 记录未能读取</strong>
            </div>
            <ul>
              {diagnostics.slice(0, 3).map((item, index) => (
                <li key={`${item.path ?? 'workspace'}-${index}`}>
                  {item.path ? `${item.path}：` : ''}
                  {item.message}
                </li>
              ))}
            </ul>
            {diagnostics.length > 3 ? <p>还有 {diagnostics.length - 3} 个问题，请修复后点击“重读 MD”。</p> : null}
          </section>
        ) : null}

        {!snapshot && active !== 'settings' ? (
          <Onboarding onCreate={() => handleCreate()} onOpen={() => handleOpen()} onDemo={handleSeedDemo} />
        ) : active === 'dashboard' ? (
          <Dashboard
            records={records}
            setActive={setActive}
            onSeedDemo={handleSeedDemo}
            month={month}
            setMonth={setMonth}
          />
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
        ) : active === 'inbox' ? (
          <InboxPanel
            workspacePath={snapshot?.workspacePath ?? workspacePath}
            records={records}
            config={config}
            aiSettings={aiSettings}
            onSnapshot={handleSnapshotResult}
            setStatus={setStatus}
            onConfigureAi={goToAiSettings}
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
            fieldFilters={fieldFilters[active] ?? {}}
            onFieldFilter={handleFieldFilter}
            onSnapshot={handleSnapshotResult}
            setStatus={setStatus}
            aiSettings={aiSettings}
            onConfigureAi={goToAiSettings}
            onOpenReference={openReference}
          />
        )}
      </section>
    </main>
  )
}

export default App
