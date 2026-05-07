import { invoke } from '@tauri-apps/api/core'

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const recentKey = 'legalbiz-recent-workspaces'
const lastKey = 'legalbiz-last-workspace'

// ---------------------------------------------------------------------------
// 持久化最近工作区：Tauri 环境下写入 app config dir 的 state.json，浏览器降级到
// localStorage。两条轨道同步写入，以防任一端被清。
// ---------------------------------------------------------------------------

interface AppState {
  lastWorkspace?: string | null
  recentWorkspaces?: string[]
}

export const safeParse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

let cachedState: AppState | null = null

const readLocalState = (): AppState => ({
  lastWorkspace: localStorage.getItem(lastKey) || null,
  recentWorkspaces: safeParse<string[]>(localStorage.getItem(recentKey), []),
})

const writeLocalState = (state: AppState) => {
  if (state.lastWorkspace) {
    localStorage.setItem(lastKey, state.lastWorkspace)
  } else {
    localStorage.removeItem(lastKey)
  }
  localStorage.setItem(recentKey, JSON.stringify(state.recentWorkspaces ?? []))
}

export const loadAppState = async (): Promise<AppState> => {
  if (cachedState) return cachedState
  if (isTauri()) {
    try {
      const fromDisk = await invoke<AppState>('load_app_state')
      // 顺手同步到 localStorage，方便浏览器调试
      writeLocalState(fromDisk)
      cachedState = fromDisk
      return fromDisk
    } catch {
      // 读取失败时降级
    }
  }
  const local = readLocalState()
  cachedState = local
  return local
}

const persistAppState = async (state: AppState): Promise<void> => {
  cachedState = state
  writeLocalState(state)
  if (isTauri()) {
    try {
      await invoke('save_app_state', { state })
    } catch {
      // 写盘失败不致命，localStorage 仍有副本
    }
  }
}

export const rememberWorkspace = async (path: string): Promise<void> => {
  if (!path) return
  const current = await loadAppState()
  const recents = (current.recentWorkspaces ?? []).filter((item) => item !== path)
  await persistAppState({
    lastWorkspace: path,
    recentWorkspaces: [path, ...recents].slice(0, 8),
  })
}

export const forgetWorkspace = async (path: string): Promise<void> => {
  const current = await loadAppState()
  const recents = (current.recentWorkspaces ?? []).filter((item) => item !== path)
  const last = current.lastWorkspace === path ? null : current.lastWorkspace ?? null
  await persistAppState({ lastWorkspace: last, recentWorkspaces: recents })
}

export const getRecentWorkspacesSync = (): string[] => {
  if (cachedState?.recentWorkspaces) return cachedState.recentWorkspaces
  return readLocalState().recentWorkspaces ?? []
}

export const getLastWorkspaceSync = (): string | null => {
  if (cachedState?.lastWorkspace !== undefined) return cachedState.lastWorkspace ?? null
  return readLocalState().lastWorkspace ?? null
}

export const getDefaultWorkspaceRoot = async (): Promise<string> => {
  if (!isTauri()) return ''
  try {
    return await invoke<string>('default_workspace_root')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Folder picker — Tauri dialog plugin in app, prompt() in browser
// ---------------------------------------------------------------------------

export const pickWorkspaceDirectory = async (
  startingPath?: string,
): Promise<string | null> => {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择本地工作区文件夹',
      defaultPath: startingPath || undefined,
    })
    if (typeof selected === 'string') return selected
    return null
  }

  const value = window.prompt('输入演示工作区名称：', startingPath || '浏览器演示工作区')
  return value && value.trim() ? value.trim() : null
}
