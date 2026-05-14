import { invoke } from '@tauri-apps/api/core'
import {
  dateFromFields,
  type ConflictHit,
  type ModuleKey,
  type RecordSummary,
  type WorkspaceSnapshot,
} from '../domain'
import { isTauri } from './app-state'
import { loadDemo, saveDemo } from './workspace'

export const createRecord = async (
  workspacePath: string,
  moduleKey: ModuleKey,
  fields: Record<string, unknown>,
  body: string,
): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    return invoke<WorkspaceSnapshot>('create_record', {
      workspacePath,
      moduleKey,
      fields,
      body,
    })
  }

  const snapshot = loadDemo(workspacePath)
  const prefix: Record<ModuleKey, string> = {
    client: 'CLI',
    service_contract: 'CON',
    litigation: 'LIT',
    non_litigation: 'NON',
    invoice: 'INV',
    conflict_check: 'CHK',
    calendar_event: 'CAL',
  }
  const next = snapshot.records.filter((item) => item.module === moduleKey).length + 1
  const date = dateFromFields(fields)
  const id = `${prefix[moduleKey]}-${date.slice(0, 4)}-${String(next).padStart(4, '0')}`
  const title = String(fields.title ?? fields.name ?? fields.client_name ?? id)

  snapshot.records.unshift({
    id,
    module: moduleKey,
    title,
    date,
    status: String(fields.status ?? fields.invoice_status ?? fields.conclusion ?? ''),
    fields,
    body,
    path: `demo://${moduleKey}/${id}.md`,
  })
  appendLinkedCalendarEvents(snapshot, moduleKey, id, title, fields)
  saveDemo(snapshot)
  return snapshot
}

export const updateRecord = async (
  workspacePath: string,
  recordPath: string,
  moduleKey: ModuleKey,
  fields: Record<string, unknown>,
  body: string,
): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    return invoke<WorkspaceSnapshot>('update_record', {
      workspacePath,
      recordPath,
      moduleKey,
      fields,
      body,
    })
  }

  const snapshot = loadDemo(workspacePath)
  const index = snapshot.records.findIndex((item) =>
    item.path === recordPath || (item.module === moduleKey && item.id === fields.id),
  )
  if (index < 0) throw new Error('未找到要修改的记录。')

  const current = snapshot.records[index]
  const id = current.id
  const nextFields: Record<string, unknown> = {
    ...fields,
    id,
    module: current.module,
  }
  const title = String(nextFields.title ?? nextFields.name ?? nextFields.client_name ?? id)
  nextFields.title = title

  snapshot.records[index] = {
    ...current,
    title,
    date: dateFromFields(nextFields),
    status: String(nextFields.status ?? nextFields.invoice_status ?? nextFields.conclusion ?? ''),
    fields: nextFields,
    body,
  }
  saveDemo(snapshot)
  return snapshot
}

const appendLinkedCalendarEvents = (
  snapshot: WorkspaceSnapshot,
  moduleKey: ModuleKey,
  sourceId: string,
  title: string,
  fields: Record<string, unknown>,
) => {
  if (moduleKey !== 'litigation') return

  const events: Array<{ title: string; eventType: string; date?: unknown; status?: string; body: string }> = [
    {
      title: `${title} · 开庭`,
      eventType: '开庭',
      date: fields.hearing_date,
      status: '待处理',
      body: `由诉讼案件 ${sourceId} 自动生成。`,
    },
    {
      title: `${title} · 关键期限`,
      eventType: '期限',
      date: fields.limitation_deadline,
      status: '待处理',
      body: `由诉讼案件 ${sourceId} 的关键期限自动生成。`,
    },
    {
      title: String(fields.next_task || `${title} · 下一步任务`),
      eventType: '任务',
      date: fields.next_task_due,
      status: '待处理',
      body: `由诉讼案件 ${sourceId} 的任务安排自动生成。`,
    },
  ]

  const existingCount = snapshot.records.filter((item) => item.module === 'calendar_event').length
  let offset = 0
  for (const event of events) {
    const date = typeof event.date === 'string' ? event.date : ''
    if (!date || date.length < 7) continue
    offset += 1
    const year = date.slice(0, 4)
    const id = `CAL-${year}-${String(existingCount + offset).padStart(4, '0')}`
    snapshot.records.unshift({
      id,
      module: 'calendar_event',
      title: event.title,
      date,
      status: event.status,
      fields: {
        id,
        module: 'calendar_event',
        title: event.title,
        event_type: event.eventType,
        date,
        time: '',
        related_matter: title,
        source_record_id: sourceId,
        status: event.status,
      },
      body: event.body,
      path: `demo://calendar_event/${id}.md`,
    })
  }
}

export const runConflictCheck = async (
  snapshot: WorkspaceSnapshot,
  terms: string[],
): Promise<ConflictHit[]> => {
  if (isTauri()) {
    return invoke<ConflictHit[]>('run_conflict_check', {
      records: snapshot.records,
      terms,
    })
  }
  return localConflictCheck(snapshot.records, terms)
}

export const localConflictCheck = (records: RecordSummary[], terms: string[]): ConflictHit[] => {
  const normalized = terms
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase())

  const hits: ConflictHit[] = []

  for (const record of records) {
    for (const [key, value] of Object.entries(record.fields)) {
      const text = String(value ?? '').toLowerCase()
      const matched = normalized.find((term) => term.length >= 2 && text.includes(term))
      if (matched) {
        hits.push({
          id: record.id,
          module: record.module,
          title: record.title,
          matchedField: key,
          matchedValue: String(value),
          reason: `字段"${key}"包含"${matched}"`,
        })
        break
      }
    }
  }

  return hits
}

export const deleteRecord = async (
  workspacePath: string,
  recordPath: string,
): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    return invoke<WorkspaceSnapshot>('delete_record', { workspacePath, recordPath })
  }

  const snapshot = loadDemo(workspacePath)
  const index = snapshot.records.findIndex((item) => item.path === recordPath)
  if (index >= 0) {
    snapshot.records.splice(index, 1)
  }
  saveDemo(snapshot)
  return snapshot
}

export const generateLedgerSnapshot = async (
  workspacePath: string,
  month: string,
  ledgerType: ModuleKey,
  records: RecordSummary[],
): Promise<string> => {
  if (isTauri()) {
    return invoke<string>('generate_ledger_snapshot', {
      workspacePath,
      month,
      ledgerType,
    })
  }

  const rows = records.filter((item) => item.module === ledgerType && item.date?.startsWith(month))
  return `demo://ledgers/${month}-${ledgerType}.md (${rows.length} 条)`
}
