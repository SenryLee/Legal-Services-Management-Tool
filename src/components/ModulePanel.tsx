import { useEffect, useState } from 'react'
import { FileSpreadsheet, Paperclip, Plus, Save, Search, ShieldCheck } from 'lucide-react'
import type { AISettings, ModuleKey, RecordSummary, WorkspaceSnapshot } from '../domain'
import { emptyRecordFor } from '../domain'
import { createRecord, exportRowsToCsv, generateLedgerSnapshot } from '../storage'
import { friendlyError } from '../shared/utils'
import AiAssistant from './AiAssistant'
import ConflictAnalyzer from './ConflictAnalyzer'
import DynamicForm from './DynamicForm'
import AttachmentDrawer from './AttachmentDrawer'

export default function ModulePanel({
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
