import { invoke } from '@tauri-apps/api/core'
import type { AttachmentEntry } from '../domain'
import { isTauri } from './app-state'

// ---------------------------------------------------------------------------
// 附件管理
// ---------------------------------------------------------------------------

export const ensureAttachmentsDir = async (
  workspacePath: string,
  recordPath: string,
): Promise<string> => {
  if (!isTauri()) return `demo://${recordPath}/attachments`
  return invoke<string>('record_attachments_dir', { workspacePath, recordPath })
}

export const listAttachments = async (
  workspacePath: string,
  recordPath: string,
): Promise<AttachmentEntry[]> => {
  if (!isTauri()) return []
  return invoke<AttachmentEntry[]>('list_attachments', { workspacePath, recordPath })
}

export const addAttachments = async (
  workspacePath: string,
  recordPath: string,
  srcPaths: string[],
): Promise<string[]> => {
  if (!isTauri()) throw new Error('附件管理仅在桌面 App 中可用。')
  return invoke<string[]>('add_attachments', { workspacePath, recordPath, srcPaths })
}

export const deleteAttachment = async (
  workspacePath: string,
  recordPath: string,
  name: string,
): Promise<void> => {
  if (!isTauri()) throw new Error('附件管理仅在桌面 App 中可用。')
  await invoke('delete_attachment', { workspacePath, recordPath, name })
}

export const openInFinder = async (path: string): Promise<void> => {
  if (!isTauri()) return
  await invoke('open_path_in_finder', { path })
}

export const pickFilesToAttach = async (): Promise<string[]> => {
  if (!isTauri()) return []
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({ multiple: true, directory: false, title: '选择要添加的附件' })
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}
