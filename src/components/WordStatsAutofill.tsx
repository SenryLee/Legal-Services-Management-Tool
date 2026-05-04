import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, Upload } from 'lucide-react'
import { readWordDocumentStats, type WordDocumentStats } from '../storage'
import { friendlyError } from '../shared/utils'

export default function WordStatsAutofill({
  onApply,
  setStatus,
}: {
  onApply: (patch: Record<string, unknown>) => void
  setStatus: (status: string) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<WordDocumentStats | null>(null)
  const [error, setError] = useState('')

  const handleFile = async (file: File | null) => {
    if (!file) return
    setReading(true)
    setResult(null)
    setError('')
    try {
      const stats = await readWordDocumentStats(file)
      onApply({
        page_count: stats.pageCount,
        word_count: stats.wordCount,
      })
      setResult(stats)
      setStatus(`已从「${stats.fileName}」填入页数 ${stats.pageCount}、字数 ${stats.wordCount}，保存前仍可手动修改。`)
    } catch (caught) {
      const message = friendlyError(caught)
      setError(message)
      setStatus(`Word 自动填表失败：${message}`)
    } finally {
      setReading(false)
    }
  }

  const sourceText =
    result?.pageSource === 'metadata' && result.wordSource === 'metadata'
      ? '页数和字数来自 Word 元数据。'
      : '部分结果来自正文统计/估算，请保存前按 Word 实际结果核对。'

  return (
    <div className="ai-card open">
      <div className="ai-card-header">
        <FileText size={15} />
        <span>Word 自动填表 · 页数/字数</span>
        <small>非 AI</small>
      </div>
      <div className="ai-card-body">
        <p className="muted">
          上传 <code>.docx</code> 后自动填入“页数”和“字数”。PDF 不支持；旧版 <code>.doc</code> 请先另存为 <code>.docx</code>。
        </p>
        <div className="ai-toolbar">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={reading}>
            {reading ? <Loader2 size={14} className="spinning" /> : <Upload size={14} />}{' '}
            {reading ? '解析中...' : '选择 Word 文档'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".docx,.doc,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/pdf"
            hidden
            onChange={(event) => {
              handleFile(event.target.files?.[0] ?? null)
              event.target.value = ''
            }}
          />
        </div>
        {result ? (
          <div className="file-status ok">
            <CheckCircle2 size={14} />
            <div className="file-status-body">
              <strong>已填入「{result.fileName}」</strong>
              <small>
                页数 {result.pageCount.toLocaleString()} · 字数 {result.wordCount.toLocaleString()} · {sourceText}
              </small>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="file-status error" role="alert">
            <AlertTriangle size={14} />
            <div className="file-status-body">
              <strong>解析失败</strong>
              <small>{error}</small>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
