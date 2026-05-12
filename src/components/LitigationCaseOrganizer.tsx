import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bot, CheckSquare, FolderOpen, Loader2, RefreshCw, Wand2, X } from 'lucide-react'
import type { LitigationCaseExecutionResult, LitigationCasePlan, LitigationCaseScan, RecordSummary } from '../domain'
import {
  executeLitigationCaseActions,
  openInFinder,
  proposeLitigationCasePlan,
  scanLitigationCase,
} from '../storage'
import { friendlyError } from '../shared/utils'

export default function LitigationCaseOrganizer({
  workspacePath,
  record,
  onClose,
  onAfterExecute,
  setStatus,
}: {
  workspacePath: string
  record: RecordSummary
  onClose: () => void
  onAfterExecute: () => Promise<void>
  setStatus: (status: string) => void
}) {
  const [scan, setScan] = useState<LitigationCaseScan | null>(null)
  const [plan, setPlan] = useState<LitigationCasePlan | null>(null)
  const [execution, setExecution] = useState<LitigationCaseExecutionResult | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<Record<string, boolean>>({})
  const [selectedActions, setSelectedActions] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const selectedFilePaths = useMemo(
    () => Object.entries(selectedFiles).filter(([, enabled]) => enabled).map(([path]) => path),
    [selectedFiles],
  )

  const acceptedActions = useMemo(
    () => (plan?.actions ?? []).filter((action) => selectedActions[action.id]),
    [plan?.actions, selectedActions],
  )

  const runScan = async () => {
    if (!record.path) return
    setBusy(true)
    try {
      const next = await scanLitigationCase(workspacePath, record.path)
      setScan(next)
      setPlan(null)
      setExecution(null)
      setSelectedFiles(Object.fromEntries(next.pendingFiles.map((file) => [file.relativePath, true])))
      setStatus(next.hasPending ? `发现 ${next.pendingFiles.length} 个待整理文件。` : '案件目录暂无待整理文件。')
    } catch (error) {
      setStatus(`扫描失败：${friendlyError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const buildPlan = async (deepAnalysis: boolean) => {
    if (!record.path) return
    const files = selectedFilePaths
    if (files.length === 0) {
      setStatus('请先选择至少一个待整理文件。')
      return
    }
    setBusy(true)
    try {
      const next = await proposeLitigationCasePlan(workspacePath, record.path, files, deepAnalysis)
      setPlan(next)
      setExecution(null)
      setSelectedActions(Object.fromEntries(next.actions.map((action) => [action.id, true])))
      setStatus(`已生成 ${next.actions.length} 条待确认操作。`)
    } catch (error) {
      setStatus(`生成整理方案失败：${friendlyError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const execute = async () => {
    if (!record.path) return
    if (acceptedActions.length === 0) {
      setStatus('没有已勾选的确认操作。')
      return
    }
    setBusy(true)
    try {
      const result = await executeLitigationCaseActions(workspacePath, record.path, acceptedActions)
      setExecution(result)
      await onAfterExecute()
      setStatus(`已执行 ${result.results.filter((item) => item.ok).length}/${result.results.length} 条确认操作。`)
      const nextScan = await scanLitigationCase(workspacePath, record.path)
      setScan(nextScan)
      setSelectedFiles(Object.fromEntries(nextScan.pendingFiles.map((file) => [file.relativePath, true])))
    } catch (error) {
      setStatus(`执行失败：${friendlyError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.path])

  return (
    <div className="modal-backdrop">
      <div className="case-organizer">
        <div className="case-organizer-header">
          <div>
            <h2>诉讼案件文件整理</h2>
            <p>{record.title}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="case-organizer-toolbar">
          <button type="button" onClick={runScan} disabled={busy}>
            {busy ? <Loader2 size={14} className="spinning" /> : <RefreshCw size={14} />} 扫描案件目录
          </button>
          <button
            type="button"
            onClick={() => scan?.caseRoot && openInFinder(scan.caseRoot)}
            disabled={!scan?.caseRoot}
          >
            <FolderOpen size={14} /> 打开案件文件夹
          </button>
        </div>

        {scan ? (
          <div className={`case-intake-banner${scan.hasPending ? ' active' : ''}`}>
            {scan.hasPending ? <AlertTriangle size={16} /> : <CheckSquare size={16} />}
            <div>
              <strong>{scan.hasPending ? '有文件待整理' : '暂无待整理文件'}</strong>
              <small>
                案件目录：{scan.caseRootRelative} · 最近扫描：{new Date(scan.lastScannedAt).toLocaleString()}
              </small>
            </div>
          </div>
        ) : null}

        <section className="case-organizer-section">
          <h3>1. 待整理文件</h3>
          {scan?.pendingFiles.length ? (
            <div className="case-file-list">
              {scan.pendingFiles.map((file) => (
                <label key={file.relativePath} className="case-file-row">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedFiles[file.relativePath])}
                    onChange={(event) =>
                      setSelectedFiles((prev) => ({ ...prev, [file.relativePath]: event.target.checked }))
                    }
                  />
                  <span>
                    <strong>{file.currentName}</strong>
                    <small>
                      {file.status === 'changed' ? '变更' : '新增'} · {file.relativePath} · {(file.size / 1024).toFixed(1)} KB
                    </small>
                    {file.suspectedWrongCase ? <em>疑似异常：{file.reason}</em> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">没有待整理文件。把材料放入该案件主文件夹后，再点击“扫描案件目录”。</p>
          )}
          <div className="button-row">
            <button type="button" onClick={() => buildPlan(false)} disabled={busy || selectedFilePaths.length === 0}>
              <Wand2 size={14} /> 初筛生成方案
            </button>
            <button type="button" className="primary" onClick={() => buildPlan(true)} disabled={busy || selectedFilePaths.length === 0}>
              <Bot size={14} /> 深入分析后生成方案
            </button>
          </div>
          <p className="muted">
            初筛只看文件名、扩展名和当前位置；深入分析只读取用户确认的文件。PDF 文字层与 .docx 会尝试提取正文，图片 OCR 暂不在第一版内。
          </p>
        </section>

        {plan ? (
          <section className="case-organizer-section">
            <h3>2. AI 整理建议与待确认操作</h3>
            {plan.notes.map((note) => (
              <p key={note} className="muted">{note}</p>
            ))}
            <div className="case-report-grid">
              {plan.reports.map((report) => (
                <article key={report.filePath} className={report.wrongCaseSuspected ? 'case-report warning-report' : 'case-report'}>
                  <strong>{report.currentName}</strong>
                  <small>{report.documentType} · {report.stage} · {report.deepAnalyzed ? '已深入分析' : '初筛'}</small>
                  <p>{report.reasoningExcerpt}</p>
                  <code>{report.suggestedDirectory}/{report.suggestedFilename}</code>
                  {report.wrongCaseSuspected ? <em>疑似放错案件：仅提示，不自动跨案件移动。</em> : null}
                </article>
              ))}
            </div>
            <div className="case-action-list">
              {plan.actions.map((action) => (
                <label key={action.id} className="case-action-row">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedActions[action.id])}
                    onChange={(event) =>
                      setSelectedActions((prev) => ({ ...prev, [action.id]: event.target.checked }))
                    }
                  />
                  <span>
                    <strong>{action.title}</strong>
                    <small>{action.description}</small>
                    {action.targetPath ? <code>{action.targetPath}</code> : null}
                  </span>
                </label>
              ))}
            </div>
            <button type="button" className="primary" onClick={execute} disabled={busy || acceptedActions.length === 0}>
              <CheckSquare size={14} /> 执行已确认操作
            </button>
          </section>
        ) : null}

        {execution ? (
          <section className="case-organizer-section">
            <h3>3. 执行结果</h3>
            <div className="case-action-list">
              {execution.results.map((result) => (
                <div key={result.actionId} className={`case-result-row${result.ok ? ' ok' : ' error'}`}>
                  <strong>{result.ok ? '成功' : '失败'}</strong>
                  <small>{result.message}</small>
                </div>
              ))}
            </div>
            <p className="muted">整理日志：{execution.logPath}</p>
          </section>
        ) : null}
      </div>
    </div>
  )
}
