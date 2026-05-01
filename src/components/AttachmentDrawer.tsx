import { useCallback, useEffect, useState } from 'react'
import { Eye, FolderOpen, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import type { AttachmentEntry, RecordSummary } from '../domain'
import { addAttachments, deleteAttachment, ensureAttachmentsDir, isTauri, listAttachments, openInFinder, pickFilesToAttach } from '../storage'
import { formatBytes, friendlyError } from '../shared/utils'

export default function AttachmentDrawer({
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
