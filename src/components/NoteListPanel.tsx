import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Save, Search, StickyNote, Trash2, X } from 'lucide-react'
import type { AISettings, RecordSummary } from '../domain'
import {
  deleteNote,
  listNotes,
  loadNoteBody,
  saveNote,
  searchNotes,
  updateNote,
  type NoteSummary,
} from '../storage'
import { friendlyError } from '../shared/utils'

const AUTO_SAVE_DELAY = 2000

export default function NoteListPanel({
  workspacePath,
  records,
  setStatus,
}: {
  workspacePath: string
  records: RecordSummary[]
  aiSettings: AISettings
  setStatus: (status: string) => void
}) {
  const [noteList, setNoteList] = useState<NoteSummary[]>([])
  const [query, setQuery] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [relatedRecordId, setRelatedRecordId] = useState('')
  const [relatedModule, setRelatedModule] = useState('')

  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedPathRef = useRef<string | null>(null)
  const bodyRef = useRef(body)
  const titleRef = useRef(title)
  useEffect(() => {
    bodyRef.current = body
    titleRef.current = title
  }, [body, title])

  // Load notes
  const refresh = useCallback(async () => {
    if (!workspacePath) return
    try {
      const list = query
        ? await searchNotes(workspacePath, query)
        : await listNotes(workspacePath)
      setNoteList(list)
    } catch (error) {
      setStatus(`加载笔记失败：${friendlyError(error)}`)
    }
  }, [workspacePath, query, setStatus])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-save logic
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    autoSaveRef.current = setTimeout(async () => {
      const currentBody = bodyRef.current
      const currentTitle = titleRef.current
      if (!currentBody.trim() && !currentTitle.trim()) return
      if (!workspacePath) return

      const tags = tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean)

      try {
        if (savedPathRef.current) {
          await updateNote(
            workspacePath,
            savedPathRef.current,
            currentTitle,
            currentBody,
            tags,
            relatedRecordId || undefined,
            relatedModule || undefined,
          )
        } else {
          const path = await saveNote(
            workspacePath,
            currentTitle,
            currentBody,
            tags,
            relatedRecordId || undefined,
            relatedModule || undefined,
          )
          savedPathRef.current = path
        }
        setStatus('已自动保存笔记')
        refresh()
      } catch (error) {
        setStatus(`自动保存失败：${friendlyError(error)}`)
      }
    }, AUTO_SAVE_DELAY)
  }, [workspacePath, tagsText, relatedRecordId, relatedModule, setStatus, refresh])

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    }
  }, [])

  const handleBodyChange = (value: string) => {
    setBody(value)
    scheduleAutoSave()
  }

  const handleTitleChange = (value: string) => {
    setTitle(value)
    scheduleAutoSave()
  }

  const handleNewNote = () => {
    setShowEditor(true)
    setEditingPath(null)
    savedPathRef.current = null
    setTitle('')
    setBody('')
    setTagsText('')
    setRelatedRecordId('')
    setRelatedModule('')
  }

  const handleManualSave = async () => {
    if (!workspacePath) return
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)

    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)

    try {
      if (savedPathRef.current || editingPath) {
        const path = savedPathRef.current || editingPath!
        await updateNote(
          workspacePath,
          path,
          title,
          body,
          tags,
          relatedRecordId || undefined,
          relatedModule || undefined,
        )
        setStatus('笔记已保存')
      } else {
        const path = await saveNote(
          workspacePath,
          title,
          body,
          tags,
          relatedRecordId || undefined,
          relatedModule || undefined,
        )
        savedPathRef.current = path
        setStatus('新笔记已保存')
      }
      refresh()
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  const handleCloseEditor = () => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    // Trigger a final save if there's content
    if (body.trim() || title.trim()) {
      handleManualSave()
    }
    setShowEditor(false)
    setEditingPath(null)
    savedPathRef.current = null
  }

  const handleEdit = async (note: NoteSummary) => {
    setShowEditor(true)
    setEditingPath(note.path)
    savedPathRef.current = note.path
    setTitle(note.title)
    setTagsText(note.tags.join('，'))
    setRelatedRecordId(note.relatedRecords[0] ?? '')
    // Load full body
    try {
      const fullBody = await loadNoteBody(workspacePath, note.path)
      setBody(fullBody)
    } catch {
      setBody(note.bodyPreview)
    }
  }

  const handleDeleteNote = async (note: NoteSummary) => {
    const confirmed = window.confirm(`确定要删除笔记"${note.title}"吗？`)
    if (!confirmed) return
    try {
      await deleteNote(workspacePath, note.path)
      setStatus(`已删除笔记：${note.title}`)
      if (savedPathRef.current === note.path) {
        setShowEditor(false)
        savedPathRef.current = null
      }
      refresh()
    } catch (error) {
      setStatus(`删除失败：${friendlyError(error)}`)
    }
  }

  // Build record options for relation dropdown
  const recordOptions = records
    .filter((r) => r.module === 'litigation' || r.module === 'non_litigation')
    .slice(0, 50)

  return (
    <div className="module-layout">
      <section className="panel table-panel">
        <div className="section-title">
          <div>
            <h2>随手笔记</h2>
            <span>碎片记录、通话要点、灵感速记 — 写下即保存，AI 自动关联案件。</span>
          </div>
          <div className="toolbar">
            <label>
              搜索
              <span className="search-box">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索标题、内容、标签"
                />
              </span>
            </label>
          </div>
        </div>

        <div className="button-row">
          <button type="button" className="primary" onClick={handleNewNote}>
            <Plus size={16} /> 新建笔记
          </button>
        </div>

        {noteList.length === 0 ? (
          <div className="empty-state">
            <StickyNote size={48} strokeWidth={1} />
            <h3>暂无笔记</h3>
            <p>点击"新建笔记"开始记录，内容会自动保存。</p>
          </div>
        ) : (
          <div className="note-cards">
            {noteList.map((note) => (
              <div key={note.path} className="note-card">
                <div className="note-card-header">
                  <strong>{note.title || '无标题'}</strong>
                  <span className="muted">{note.createdAt.replace('T', ' ')}</span>
                </div>
                {note.tags.length > 0 ? (
                  <div className="note-tags">
                    {note.tags.map((tag) => (
                      <span key={tag} className="tag-badge">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="note-preview">{note.bodyPreview || '(空)'}</p>
                {note.relatedRecords.length > 0 ? (
                  <div className="note-relations">
                    关联：{note.relatedRecords.join('、')}
                  </div>
                ) : null}
                <div className="note-card-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="编辑"
                    onClick={() => handleEdit(note)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="删除"
                    onClick={() => handleDeleteNote(note)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showEditor ? (
        <aside className="panel editor-panel">
          <div className="editor-heading">
            <div>
              <h2>{editingPath ? '编辑笔记' : '新建笔记'}</h2>
              <span className="muted">输入即自动保存</span>
            </div>
            <button type="button" className="ghost" onClick={handleCloseEditor}>
              <X size={14} /> 关闭
            </button>
          </div>

          <label className="field full">
            标题
            <input
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="笔记标题（可选，自动生成）"
            />
          </label>

          <label className="field full">
            内容
            <textarea
              value={body}
              onChange={(e) => handleBodyChange(e.target.value)}
              placeholder="随便写点什么..."
              rows={12}
              autoFocus
            />
          </label>

          <label className="field full">
            标签（逗号分隔）
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="例如：华诚医药，电话沟通，股权激励"
            />
          </label>

          <label className="field full">
            关联案件
            <select
              value={relatedRecordId}
              onChange={(e) => {
                const selected = recordOptions.find((r) => r.id === e.target.value)
                setRelatedRecordId(e.target.value)
                setRelatedModule(selected?.module ?? '')
              }}
            >
              <option value="">不关联</option>
              {recordOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} — {r.title}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="primary" onClick={handleManualSave}>
            <Save size={16} /> 手动保存
          </button>
        </aside>
      ) : null}
    </div>
  )
}
