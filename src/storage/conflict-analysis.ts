import type { ConflictHit, ModuleKey, RecordSummary } from '../domain'

// ---------------------------------------------------------------------------
// 利冲分析：聚焦"现有客户"语义
// 1) 拟接案的相对方与现有客户重名 → 阻断（不能接案）
// 2) 拟接案的关联方与现有客户重名 → 提醒核查
// 3) 拟委托人是现有客户的历史相对方 / 在已有事项中是相对方 → 阻断或提醒
// ---------------------------------------------------------------------------

export interface ConflictCandidate {
  proposedClient?: string
  opposingParties?: string[]
  relatedParties?: string[]
}

export interface AnnotatedConflictHit extends ConflictHit {
  severity: 'block' | 'warn' | 'candidate'
  score: number
  matchQuery: string
  matchStrength: 'exact' | 'strong' | 'weak'
  sourceField: string
}

const norm = (value: string | undefined | null): string =>
  String(value ?? '').trim().toLowerCase()

const compactText = (value: string): string =>
  norm(value)
    .replace(/\s+/g, '')
    .replace(/[()（）【】<>《》]/g, '')
    .replace(/\[/g, '')
    .replace(/]/g, '')

const genericConflictTerms = new Set([
  '公司',
  '有限',
  '有限公司',
  '股份',
  '股份公司',
  '股份有限公司',
  '集团',
  '控股',
  '客户',
  '个人',
  '相对方',
  '关联方',
])

const isMeaningfulConflictToken = (value: string): boolean => {
  const token = compactText(value)
  if (!token || genericConflictTerms.has(token)) return false
  const chineseCount = (token.match(/[一-龥]/g) ?? []).length
  if (chineseCount >= 2) return true
  const latinOrNumberCount = (token.match(/[a-z0-9]/g) ?? []).length
  return latinOrNumberCount >= 3
}

const splitTokens = (value: unknown): string[] => {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const tokens = text
    .split(/[,\n，、；;/|]/)
    .map((token) => token.trim())
    .filter(isMeaningfulConflictToken)
  return Array.from(new Set(tokens))
}

const matchConflictText = (
  haystack: string,
  needle: string,
): { strength: AnnotatedConflictHit['matchStrength']; score: number } | null => {
  const a = compactText(haystack)
  const b = compactText(needle)
  if (!a || !b || !isMeaningfulConflictToken(needle)) return null
  if (a === b) return { strength: 'exact', score: 100 }
  if (a.includes(b)) {
    const coverage = Math.min(1, b.length / Math.max(a.length, 1))
    return { strength: coverage >= 0.5 ? 'strong' : 'weak', score: 60 + Math.round(coverage * 30) }
  }
  if (b.includes(a) && isMeaningfulConflictToken(haystack)) {
    const coverage = Math.min(1, a.length / Math.max(b.length, 1))
    return { strength: 'strong', score: 70 + Math.round(coverage * 20) }
  }
  return null
}

const moduleLabel = (module: ModuleKey): string => {
  const labels: Record<ModuleKey, string> = {
    client: '客户',
    conflict_check: '利冲检查',
    service_contract: '服务合同',
    litigation: '诉讼事项',
    non_litigation: '非诉事项',
    invoice: '发票',
    calendar_event: '日程',
  }
  return labels[module]
}

const severityWeight: Record<AnnotatedConflictHit['severity'], number> = {
  block: 300,
  warn: 200,
  candidate: 100,
}

export const analyzeClientConflicts = (
  records: RecordSummary[],
  candidate: ConflictCandidate,
): AnnotatedConflictHit[] => {
  const clients = records.filter((record) => record.module === 'client')
  const matters = records.filter((record) =>
    record.module === 'litigation' ||
    record.module === 'non_litigation' ||
    record.module === 'service_contract',
  )
  const searchableRecords = records.filter((record) =>
    record.module === 'client' ||
    record.module === 'litigation' ||
    record.module === 'non_litigation' ||
    record.module === 'service_contract' ||
    record.module === 'conflict_check',
  )

  const opponents = (candidate.opposingParties ?? []).flatMap((value) => splitTokens(value))
  const related = (candidate.relatedParties ?? []).flatMap((value) => splitTokens(value))
  const proposedTokens = splitTokens(candidate.proposedClient ?? '')

  const hits = new Map<string, AnnotatedConflictHit>()
  const push = (hit: AnnotatedConflictHit) => {
    const key = `${hit.id}|${hit.sourceField}|${hit.matchQuery}`
    const current = hits.get(key)
    const currentRank = current ? severityWeight[current.severity] + current.score : -1
    const nextRank = severityWeight[hit.severity] + hit.score
    if (!current || nextRank > currentRank) hits.set(key, hit)
  }
  const pushMatch = (
    record: RecordSummary,
    query: string,
    sourceField: string,
    matchedField: string,
    matchedValue: string,
    severity: AnnotatedConflictHit['severity'],
    reason: string,
    baseScore: number,
  ) => {
    const match = matchConflictText(matchedValue, query)
    if (!match) return
    push({
      id: record.id,
      module: record.module,
      title: record.title,
      matchedField,
      matchedValue,
      reason,
      severity,
      score: baseScore + match.score,
      matchQuery: query,
      matchStrength: match.strength,
      sourceField,
    })
  }

  // 1) 相对方撞名现有客户 / 现有客户的关联方
  for (const opp of opponents) {
    for (const client of clients) {
      const name = String(client.fields.name ?? client.title ?? '')
      pushMatch(client, opp, '相对方', 'name', name, 'block',
        `相对方「${opp}」与现有客户「${client.title}」匹配，建议拒绝接案。`, 80)
      const relatedParties = String(client.fields.related_parties ?? '')
      pushMatch(client, opp, '相对方', 'related_parties', relatedParties, 'block',
        `相对方「${opp}」出现在现有客户「${client.title}」的关联方列表中。`, 68)
    }
  }

  // 2) 关联方撞名现有客户
  for (const rel of related) {
    for (const client of clients) {
      const name = String(client.fields.name ?? client.title ?? '')
      pushMatch(client, rel, '关联方', 'name', name, 'warn',
        `拟接案的关联方「${rel}」与现有客户「${client.title}」匹配，需进一步核查关系。`, 70)
      const relatedParties = String(client.fields.related_parties ?? '')
      pushMatch(client, rel, '关联方', 'related_parties', relatedParties, 'warn',
        `拟接案的关联方「${rel}」出现在现有客户「${client.title}」的关联方列表中。`, 52)
    }
  }

  // 3) 拟委托人是现有客户的历史相对方 / 在已有事项中作为相对方出现
  for (const proposed of proposedTokens) {
    for (const client of clients) {
      const opps = String(client.fields.opponents ?? '')
      pushMatch(client, proposed, '拟委托人', 'opponents', opps, 'block',
        `拟委托人「${proposed}」是现有客户「${client.title}」的历史相对方。`, 78)
      const name = String(client.fields.name ?? client.title ?? '')
      pushMatch(client, proposed, '拟委托人', 'name', name, 'candidate',
        `拟委托人「${proposed}」疑似匹配现有客户「${client.title}」，可直接查看既有客户信息。`, 34)
      const relatedParties = String(client.fields.related_parties ?? '')
      pushMatch(client, proposed, '拟委托人', 'related_parties', relatedParties, 'warn',
        `拟委托人「${proposed}」出现在现有客户「${client.title}」的关联方列表中，建议核查是否存在关系冲突。`, 50)
    }
    for (const matter of matters) {
      const opp = String(matter.fields.opposing_parties ?? '')
      pushMatch(matter, proposed, '拟委托人', 'opposing_parties', opp, 'block',
        `拟委托人「${proposed}」在已有事项「${matter.title}」中作为相对方出现。`, 74)
    }
  }

  const candidateQueries = [
    ...proposedTokens.map((value) => ({ value, sourceField: '拟委托人' })),
    ...opponents.map((value) => ({ value, sourceField: '相对方' })),
    ...related.map((value) => ({ value, sourceField: '关联方' })),
  ]
  const candidateFields = [
    { key: 'name', label: '客户名称' },
    { key: 'client_name', label: '客户/委托人' },
    { key: 'opposing_parties', label: '相对方' },
    { key: 'related_parties', label: '关联方' },
    { key: 'opponents', label: '历史相对方' },
    { key: 'contacts', label: '联系人' },
    { key: 'title', label: '标题' },
  ]

  for (const query of candidateQueries) {
    for (const record of searchableRecords) {
      for (const field of candidateFields) {
        const value = field.key === 'title'
          ? record.title
          : String(record.fields[field.key] ?? '')
        if (!value) continue
        pushMatch(record, query.value, query.sourceField, field.key, value, 'candidate',
          `${query.sourceField}「${query.value}」匹配${moduleLabel(record.module)}「${record.title}」的${field.label}，可作为候选信息核对。`,
          field.key === 'title' ? 10 : 22)
      }
    }
  }

  const sorted = Array.from(hits.values()).sort((a, b) => {
    const severityDiff = severityWeight[b.severity] - severityWeight[a.severity]
    if (severityDiff !== 0) return severityDiff
    return b.score - a.score
  })
  const required = sorted.filter((hit) => hit.severity !== 'candidate')
  const candidates = sorted.filter((hit) => hit.severity === 'candidate').slice(0, 8)
  return [...required, ...candidates]
}
