import { useEffect, useMemo, useState } from 'react'
import { FileSpreadsheet, FolderKanban, Paperclip, Pencil, Plus, Save, Search, ShieldCheck, X } from 'lucide-react'
import type { AISettings, FieldDefinition, ModuleKey, RecordSummary, WorkspaceSnapshot } from '../domain'
import { emptyRecordFor } from '../domain'
import { createRecord, exportRowsToCsv, generateLedgerSnapshot, openWorkspace, updateRecord } from '../storage'
import {
  buildRelationIndex,
  relationPatchForField,
  relationTargetForField,
  type RelationIndex,
  type RelationTarget,
} from '../shared/relations'
import { friendlyError } from '../shared/utils'
import AiAssistant from './AiAssistant'
import ConflictAnalyzer from './ConflictAnalyzer'
import DynamicForm from './DynamicForm'
import AttachmentDrawer from './AttachmentDrawer'
import LitigationCaseOrganizer from './LitigationCaseOrganizer'
import WordStatsAutofill from './WordStatsAutofill'

export default function ModulePanel({
  moduleKey,
  records,
  allRecords,
  snapshot,
  month,
  setMonth,
  query,
  setQuery,
  fieldFilters,
  onFieldFilter,
  onSnapshot,
  setStatus,
  aiSettings,
  onConfigureAi,
  onOpenReference,
}: {
  moduleKey: ModuleKey
  records: RecordSummary[]
  allRecords: RecordSummary[]
  snapshot: WorkspaceSnapshot
  month: string
  setMonth: (month: string) => void
  query: string
  setQuery: (query: string) => void
  fieldFilters: Record<string, string>
  onFieldFilter: (fieldKey: string, value: string) => void
  onSnapshot: (snapshot: WorkspaceSnapshot) => void
  setStatus: (status: string) => void
  aiSettings: AISettings
  onConfigureAi: () => void
  onOpenReference: (target: RelationTarget) => void
}) {
  const definition = snapshot.config.modules[moduleKey]
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyRecordFor(definition))
  const [body, setBody] = useState('')
  const [editingRecord, setEditingRecord] = useState<RecordSummary | null>(null)
  const [attachmentRecord, setAttachmentRecord] = useState<RecordSummary | null>(null)
  const [organizerRecord, setOrganizerRecord] = useState<RecordSummary | null>(null)

  const relationIndex = useMemo(() => buildRelationIndex(allRecords), [allRecords])
  const ledgerFields = definition.fields.filter((field) => field.ledger).slice(0, 8)
  const filterableFields = definition.fields.filter((field) => field.filterable)
  const hasTitleField = definition.fields.some((field) => field.key === 'title')
  const hasFieldFilters = Object.values(fieldFilters).some(Boolean)

  useEffect(() => {
    setForm(emptyRecordFor(definition))
    setBody('')
    setEditingRecord(null)
  }, [definition, moduleKey])

  const handleSave = async () => {
    try {
      const fieldsForSave = { ...form }
      if (!hasTitleField) delete fieldsForSave.title
      const next = editingRecord
        ? await updateRecord(
            snapshot.workspacePath,
            editingRecord.path ?? '',
            moduleKey,
            fieldsForSave,
            body,
          )
        : await createRecord(snapshot.workspacePath, moduleKey, fieldsForSave, body)
      onSnapshot(next)
      setForm(emptyRecordFor(definition))
      setBody('')
      setEditingRecord(null)
      setStatus(editingRecord ? `已更新 ${editingRecord.id}。` : `已写入 ${definition.label} Markdown 记录。`)
    } catch (error) {
      setStatus(`${editingRecord ? '更新' : '保存'}失败：${friendlyError(error)}`)
    }
  }

  const handleEdit = (record: RecordSummary) => {
    const nextForm = { ...emptyRecordFor(definition), ...record.fields }
    if (!hasTitleField) delete nextForm.title
    setEditingRecord(record)
    setForm(nextForm)
    setBody(record.body ?? '')
    setStatus(`正在修改 ${record.id}，保存后会更新原 Markdown 记录。`)
  }

  const handleCancelEdit = () => {
    setEditingRecord(null)
    setForm(emptyRecordFor(definition))
    setBody('')
    setStatus('已取消修改。')
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

  const handleRelationCommit = (fieldKey: string, value: unknown) => {
    const patch = relationPatchForField(moduleKey, fieldKey, value, form, relationIndex)
    if (Object.keys(patch).length === 0) return

    setForm((prev) => ({ ...prev, ...patch }))
    setStatus('已根据关联记录自动带出可复用字段，保存前仍可手动修改。')
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
            {filterableFields.map((field) => (
              <label key={field.key}>
                {field.label}
                {field.type === 'single_select' && field.options?.length ? (
                  <select
                    value={fieldFilters[field.key] ?? ''}
                    onChange={(event) => onFieldFilter(field.key, event.target.value)}
                  >
                    <option value="">全部</option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'boolean' ? (
                  <select
                    value={fieldFilters[field.key] ?? ''}
                    onChange={(event) => onFieldFilter(field.key, event.target.value)}
                  >
                    <option value="">全部</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <input
                    value={fieldFilters[field.key] ?? ''}
                    onChange={(event) => onFieldFilter(field.key, event.target.value)}
                    placeholder={`筛选${field.label}`}
                  />
                )}
              </label>
            ))}
            {hasFieldFilters ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  for (const field of filterableFields) onFieldFilter(field.key, '')
                }}
              >
                清空字段筛选
              </button>
            ) : null}
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
                <th className="th-actions">操作</th>
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
                      <td key={field.key}>
                        <RelationCell
                          moduleKey={moduleKey}
                          field={field}
                          record={record}
                          relationIndex={relationIndex}
                          onOpenReference={onOpenReference}
                        />
                      </td>
                    ))}
                    <td className="td-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="修改记录"
                        onClick={() => handleEdit(record)}
                        disabled={!record.path}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="附件"
                        onClick={() => setAttachmentRecord(record)}
                        disabled={!record.path}
                      >
                        <Paperclip size={13} />
                      </button>
                      {moduleKey === 'litigation' ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title="案件文件整理"
                          onClick={() => setOrganizerRecord(record)}
                          disabled={!record.path}
                        >
                          <FolderKanban size={13} />
                        </button>
                      ) : null}
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
        <div className="editor-heading">
          <div>
            <h2>{editingRecord ? `修改${definition.label}` : `新建${definition.label}`}</h2>
            {editingRecord ? <span>{editingRecord.id}</span> : null}
          </div>
          {editingRecord ? (
            <button type="button" className="ghost" onClick={handleCancelEdit}>
              <X size={14} /> 取消
            </button>
          ) : null}
        </div>
        <AiAssistant
          moduleKey={moduleKey}
          config={snapshot.config}
          aiSettings={aiSettings}
          onApply={applyAiPatch}
          onConfigure={onConfigureAi}
          setStatus={setStatus}
        />
        {moduleKey === 'non_litigation' ? (
          <WordStatsAutofill onApply={applyAiPatch} setStatus={setStatus} />
        ) : null}
        <DynamicForm
          fields={definition.fields}
          value={form}
          onChange={setForm}
          moduleKey={moduleKey}
          relationIndex={relationIndex}
          onFieldCommit={handleRelationCommit}
          onOpenReference={onOpenReference}
        />
        <label className="field full">
          Markdown 正文
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="沟通纪要、复盘、背景说明..."
          />
        </label>
        <button type="button" className="primary" onClick={handleSave}>
          {editingRecord ? <Save size={16} /> : <Plus size={16} />}
          {editingRecord ? ' 保存修改' : ' 保存为单事项 MD'}
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
      {organizerRecord ? (
        <LitigationCaseOrganizer
          workspacePath={snapshot.workspacePath}
          record={organizerRecord}
          onClose={() => setOrganizerRecord(null)}
          onAfterExecute={async () => {
            const refreshed = await openWorkspace(snapshot.workspacePath)
            onSnapshot(refreshed)
          }}
          setStatus={setStatus}
        />
      ) : null}
    </div>
  )
}

function RelationCell({
  moduleKey,
  field,
  record,
  relationIndex,
  onOpenReference,
}: {
  moduleKey: ModuleKey
  field: FieldDefinition
  record: RecordSummary
  relationIndex: RelationIndex
  onOpenReference: (target: RelationTarget) => void
}) {
  const value = record.fields[field.key]
  const text = Array.isArray(value) ? value.join('、') : String(value ?? '')
  if (!text) return null

  const target = relationTargetForField(moduleKey, field, value, relationIndex)
  if (!target) return <>{text}</>

  return (
    <button type="button" className="relation-link" onClick={() => onOpenReference(target)}>
      {text}
      <small>{target.subtitle || target.module}</small>
    </button>
  )
}
