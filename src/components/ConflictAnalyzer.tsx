import { useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { RecordSummary } from '../domain'
import { analyzeClientConflicts, type AnnotatedConflictHit } from '../storage'

const hasPotentialSearchInput = (...values: string[]): boolean => {
  return values.some((value) => {
    const text = value.replace(/\s+/g, '')
    return /[\u4e00-\u9fa5]{2,}/.test(text) || /[A-Za-z0-9]{3,}/.test(text)
  })
}

const severityText: Record<AnnotatedConflictHit['severity'], string> = {
  block: '阻断',
  warn: '提醒',
  candidate: '候选',
}

const strengthText: Record<AnnotatedConflictHit['matchStrength'], string> = {
  exact: '精确匹配',
  strong: '强匹配',
  weak: '弱匹配',
}

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
        在上方表单中填入“拟委托人 / 相对方 / 关联方”后，系统会自动比对现有客户、历史事项和既有利冲记录。
      </p>
    )
  }

  const hasSearchInput = hasPotentialSearchInput(proposedClient, opposingParties, relatedParties)
  if (!hasSearchInput) {
    return (
      <p className="conflict-tip">
        继续输入至少 2 个中文字符或 3 个字母/数字后开始匹配，避免单个无意义字符刷屏。
      </p>
    )
  }

  if (hits.length === 0) {
    return (
      <div className="conflict-clear">
        <ShieldCheck size={16} />
        <span>未发现阻断、提醒或候选匹配。仍建议结合人工判断后留痕。</span>
      </div>
    )
  }

  const groups = [
    {
      severity: 'block' as const,
      title: '阻断风险',
      hint: '相对方或拟委托人与现有客户、历史相对方直接相关，优先处理。',
    },
    {
      severity: 'warn' as const,
      title: '提醒核查',
      hint: '关联方或关系链条存在重合，建议人工确认后再决定。',
    },
    {
      severity: 'candidate' as const,
      title: '候选匹配',
      hint: '部分关键词命中的本地记录，按相关度展示前几条用于逐级核对。',
    },
  ]

  return (
    <div className="conflict-hits">
      {groups.map((group) => {
        const groupHits = hits.filter((hit) => hit.severity === group.severity)
        if (groupHits.length === 0) return null
        return (
          <section className="conflict-section" key={group.severity}>
            <div className="conflict-section-title">
              <strong>{group.title}</strong>
              <span>{group.hint}</span>
            </div>
            {groupHits.map((hit) => (
              <div className={`hit ${hit.severity}`} key={`${hit.id}-${hit.sourceField}-${hit.matchQuery}`}>
                <div className="hit-header">
                  <strong>{hit.title}</strong>
                  <span>
                    {severityText[hit.severity]} · {hit.module}
                  </span>
                </div>
                <p>{hit.reason}</p>
                <small>
                  {hit.sourceField}“{hit.matchQuery}” → {strengthText[hit.matchStrength]} · 命中字段：
                  {hit.matchedField} = {hit.matchedValue}
                </small>
              </div>
            ))}
          </section>
        )
      })}
      <div className="conflict-tip">
        当前为本地前端关键词匹配：先看阻断，再看提醒，候选匹配只作为补充线索。
      </div>
    </div>
  )
}
