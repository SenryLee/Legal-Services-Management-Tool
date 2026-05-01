import { useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { RecordSummary } from '../domain'
import { analyzeClientConflicts, type AnnotatedConflictHit } from '../storage'

export default function ConflictAnalyzer({
  records,
  proposedClient,
  opposingParties,
  relatedParties,
}: {
  records: RecordSummary[]
  proposedClient: string
  opposingParties: string
  relatedParties: string
}) {
  const hits: AnnotatedConflictHit[] = useMemo(
    () =>
      analyzeClientConflicts(records, {
        proposedClient,
        opposingParties: [opposingParties],
        relatedParties: [relatedParties],
      }),
    [opposingParties, proposedClient, records, relatedParties],
  )

  if (!proposedClient && !opposingParties && !relatedParties) {
    return (
      <p className="muted">
        在上方表单中填入"拟委托人 / 相对方 / 关联方"后，系统会自动比对现有客户与历史事项。
      </p>
    )
  }

  if (hits.length === 0) {
    return (
      <div className="conflict-clear">
        <ShieldCheck size={16} />
        <span>未发现冲突命中。仍建议结合人工判断后留痕。</span>
      </div>
    )
  }

  return (
    <div className="conflict-hits">
      {hits.map((hit) => (
        <div className={`hit ${hit.severity}`} key={`${hit.id}-${hit.matchedField}-${hit.reason}`}>
          <div>
            <strong>{hit.title}</strong>
            <span>
              {hit.severity === 'block' ? '阻断' : '提醒'} · {hit.module}
            </span>
          </div>
          <p>{hit.reason}</p>
          <small>
            命中字段：{hit.matchedField} = {hit.matchedValue}
          </small>
        </div>
      ))}
    </div>
  )
}
