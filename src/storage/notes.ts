import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './app-state'
import { localIsoDate, localIsoDateTime } from '../shared/date'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  tags: string[]
  relatedRecords: string[]
  path: string
  bodyPreview: string
}

// ---------------------------------------------------------------------------
// Helpers (browser demo mode)
// ---------------------------------------------------------------------------

const notesKey = (wp: string) => `legalbiz-notes-${wp}`
const bodyKey = (wp: string, id: string) => `legalbiz-note-body-${wp}-${id}`

const readDemoNotes = (wp: string): NoteSummary[] =>
  JSON.parse(localStorage.getItem(notesKey(wp)) || '[]')

const writeDemoNotes = (wp: string, notes: NoteSummary[]) =>
  localStorage.setItem(notesKey(wp), JSON.stringify(notes))

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const saveNote = async (
  workspacePath: string,
  title: string,
  body: string,
  tags: string[],
  relatedRecordId?: string,
  relatedModule?: string,
): Promise<string> => {
  if (isTauri()) {
    return invoke<string>('note_save', {
      workspacePath,
      title,
      body,
      tags,
      relatedRecordId: relatedRecordId || null,
      relatedModule: relatedModule || null,
    })
  }
  const existing = readDemoNotes(workspacePath)
  const year = localIsoDate().slice(0, 4)
  const id = `NOTE-${year}-${String(existing.length + 1).padStart(4, '0')}`
  const now = localIsoDateTime()
  const note: NoteSummary = {
    id,
    title: title || `笔记 ${now}`,
    createdAt: now,
    updatedAt: now,
    tags,
    relatedRecords: relatedRecordId ? [relatedRecordId] : [],
    path: `notes/${year}/${id}.md`,
    bodyPreview: body.slice(0, 200),
  }
  existing.unshift(note)
  writeDemoNotes(workspacePath, existing)
  localStorage.setItem(bodyKey(workspacePath, id), body)
  return note.path
}

export const updateNote = async (
  workspacePath: string,
  notePath: string,
  title: string,
  body: string,
  tags: string[],
  relatedRecordId?: string,
  relatedModule?: string,
): Promise<string> => {
  if (isTauri()) {
    return invoke<string>('note_update', {
      workspacePath,
      notePath,
      title,
      body,
      tags,
      relatedRecordId: relatedRecordId || null,
      relatedModule: relatedModule || null,
    })
  }
  const existing = readDemoNotes(workspacePath)
  const idx = existing.findIndex((n) => n.path === notePath)
  if (idx >= 0) {
    const prev = existing[idx]
    existing[idx] = {
      ...prev,
      title: title || prev.title,
      updatedAt: localIsoDateTime(),
      tags,
      relatedRecords: relatedRecordId ? [relatedRecordId] : prev.relatedRecords,
      bodyPreview: body.slice(0, 200),
    }
    writeDemoNotes(workspacePath, existing)
    localStorage.setItem(bodyKey(workspacePath, prev.id), body)
  }
  return notePath
}

export const deleteNote = async (
  workspacePath: string,
  notePath: string,
): Promise<void> => {
  if (isTauri()) {
    return invoke<void>('note_delete', { workspacePath, notePath })
  }
  const existing = readDemoNotes(workspacePath)
  const idx = existing.findIndex((n) => n.path === notePath)
  if (idx >= 0) {
    localStorage.removeItem(bodyKey(workspacePath, existing[idx].id))
    existing.splice(idx, 1)
    writeDemoNotes(workspacePath, existing)
  }
}

export const listNotes = async (
  workspacePath: string,
): Promise<NoteSummary[]> => {
  if (isTauri()) {
    return invoke<NoteSummary[]>('note_list', { workspacePath })
  }
  return readDemoNotes(workspacePath)
}

export const loadNoteBody = async (
  workspacePath: string,
  notePath: string,
): Promise<string> => {
  if (isTauri()) {
    return invoke<string>('note_read_body', { workspacePath, notePath })
  }
  const existing = readDemoNotes(workspacePath)
  const note = existing.find((n) => n.path === notePath)
  if (!note) return ''
  return localStorage.getItem(bodyKey(workspacePath, note.id)) ?? note.bodyPreview
}

export const searchNotes = async (
  workspacePath: string,
  query: string,
): Promise<NoteSummary[]> => {
  if (isTauri()) {
    return invoke<NoteSummary[]>('note_search', { workspacePath, query })
  }
  const all = await listNotes(workspacePath)
  const q = query.toLowerCase()
  return all.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.bodyPreview.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q)),
  )
}
