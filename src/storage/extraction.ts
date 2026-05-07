import type { ExtractionDraft, ModuleKey, WorkspaceConfig } from '../domain'

// ---------------------------------------------------------------------------
// AI 占位：基于正则的 module-aware 抽取（默认离线）
// ---------------------------------------------------------------------------

const firstNonEmptyLine = (text: string): string | undefined =>
  text.split(/\n+/).map((line) => line.trim()).find(Boolean)

const matchCompany = (text: string): string | undefined =>
  text.match(/([一-龥A-Za-z0-9（）()]{2,}(?:有限公司|股份公司|公司|律所|事务所|集团))/)?.[1]

const matchDate = (text: string): string | undefined => {
  const m = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (!m) return undefined
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`
}

const cleanMoney = (raw: string | undefined): string | undefined =>
  raw ? raw.replace(/[,，\s]/g, '') : undefined

const normalizeDateText = (value: string): string => {
  const matched = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (!matched) return value
  return `${matched[1]}-${String(Number(matched[2])).padStart(2, '0')}-${String(Number(matched[3])).padStart(2, '0')}`
}

type Heuristic = (text: string) => string | undefined

const HEURISTICS: Record<string, Heuristic> = {
  title: (text) => firstNonEmptyLine(text)?.slice(0, 40),
  name: (text) => matchCompany(text) ?? firstNonEmptyLine(text)?.slice(0, 30),
  client_name: (text) => matchCompany(text),
  our_parties: (text) =>
    text.match(/(?:我方|委托人|客户|原告|上诉人|申请人|仲裁申请人)[：:\s]*([^\n，。；;]+)/)?.[1]?.trim(),
  party_position: (text) => text.match(/(原告|被告|上诉人|被上诉人|申请人|被申请人|第三人|执行申请人|被执行人|仲裁申请人|仲裁被申请人)/)?.[1],
  contract_no: (text) => text.match(/合同(?:编号|号)[：:\s]*([A-Za-z0-9-]{4,})/)?.[1],
  case_number: (text) => text.match(/案号[：:\s]*([（(][^)）]+[)）][^\s，。；;\n]+)/)?.[1],
  court: (text) => text.match(/([一-龥]{2,}(?:人民法院|仲裁委员会))/)?.[1],
  cause_of_action: (text) => text.match(/案由[：:\s]*([^\n，。；;]+)/)?.[1]?.trim(),
  procedure: (text) => text.match(/(一审|二审|再审|执行|仲裁)/)?.[1],
  hearing_status: (text) => {
    const value = text.match(/(未开庭|已开庭|已排期|延期|取消)/)?.[1]
    if (value === '未开庭') return '未安排'
    if (value === '已排期') return '已排期未开庭'
    return value
  },
  hearing_date: (text) =>
    text.match(/(?:开庭|庭审|听证)(?:时间|日期)?[：:\s]*(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/)?.[1],
  amount: (text) => cleanMoney(text.match(/(?:合同金额|金额|律师费|服务费|标的额)[：:\s]*([0-9,.，]+)\s*(?:元)?/)?.[1]),
  receivable_amount: (text) => cleanMoney(text.match(/(?:应收|应收金额)[：:\s]*([0-9,.，]+)/)?.[1]),
  paid_amount: (text) => cleanMoney(text.match(/(?:已收|已付|已收金额)[：:\s]*([0-9,.，]+)/)?.[1]),
  invoice_no: (text) => text.match(/发票号[：:\s]*([0-9]{8,})/)?.[1],
  invoice_date: matchDate,
  sign_date: matchDate,
  opened_at: matchDate,
  received_at: matchDate,
  check_date: matchDate,
  created_at: matchDate,
  date: matchDate,
  delivery_deadline: (text) =>
    text.match(/交付(?:期限|日期|截止)[：:\s]*((?:20)?\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/)?.[1],
  limitation_deadline: (text) =>
    text.match(/(?:期限|截止|截至)[：:\s]*((?:20)?\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/)?.[1],
  contacts: (text) =>
    text.match(/([一-龥A-Za-z]{2,4}(?:[\s ]*(?:总监|总经理|经理|主任|律师))?[\s ]*1[3-9]\d{9})/)?.[1],
  related_parties: (text) => text.match(/关联方[：:\s]*([^\n]+)/)?.[1]?.trim(),
  opposing_parties: (text) =>
    text.match(/(?:相对方|对方当事人|被告|被上诉人|被申请人|仲裁被申请人)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  third_parties: (text) => text.match(/(?:第三人|其他当事人)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  opponents: (text) =>
    text.match(/(?:相对方|对方当事人|历史相对方)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  review_round: (text) => text.match(/(?:第\s*)?(\d+)\s*轮/)?.[1],
  business_type: (text) => text.match(/(合同审查|法律咨询|专项服务|常年顾问)/)?.[1],
  service_scope: (text) => text.match(/服务(?:范围|内容)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  subject: (text) =>
    text.match(/(?:审查对象|咨询内容|主题|内容)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  hits_summary: (text) => text.match(/(?:命中|结论摘要|说明)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  conclusion: (text) => text.match(/(无冲突|存在冲突|需进一步核查)/)?.[1],
  event_type: (text) => text.match(/(开庭|会议|期限|交付|跟进)/)?.[1],
  time: (text) =>
    text.match(/(?:于|在|时间)\s*(\d{1,2}[:：]\d{2})/)?.[1] ?? text.match(/(\d{1,2}[:：]\d{2})/)?.[1],
  status: (text) => text.match(/(?:状态|进度)[：:\s]*([^\n，。；;]+)/)?.[1]?.trim(),
  contract_title: (text) =>
    text.match(/(?:关联(?:服务)?合同|合同名称)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  related_matter: (text) =>
    text.match(/(?:关联事项|关联案件)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  next_task: (text) => text.match(/(?:下一步|待办|任务安排)[：:\s]*([^\n]+)/)?.[1]?.trim(),
  next_task_due: (text) =>
    text.match(/(?:任务截止|待办截止|完成期限)[：:\s]*((?:20)?\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/)?.[1],
  progress_log: (text) => text.match(/(?:进度|案件进展|办理进展)[：:\s]*([^\n]+)/)?.[1]?.trim(),
}

export const parseTextToDraft = (
  text: string,
  targetModule: ModuleKey,
  config: WorkspaceConfig,
): ExtractionDraft => {
  const definition = config.modules[targetModule]
  const suggestions: ExtractionDraft['suggestions'] = []
  const seen = new Set<string>()

  for (const field of definition.fields) {
    if (seen.has(field.key)) continue
    const heuristic = HEURISTICS[field.key]
    if (!heuristic) continue
    const rawValue = heuristic(text)
    const value = rawValue && field.type === 'date' ? normalizeDateText(rawValue) : rawValue
    if (!value) continue
    suggestions.push({
      fieldKey: field.key,
      label: field.label,
      value,
      confidence: 0.65,
      sourceExcerpt: value,
    })
    seen.add(field.key)
  }

  return {
    targetModule,
    sourceKind: 'pasted_text',
    suggestions,
    unresolved: definition.fields
      .filter((field) => field.required && !suggestions.some((item) => item.fieldKey === field.key))
      .map((field) => field.label),
  }
}

export const draftToFormPatch = (draft: ExtractionDraft): Record<string, unknown> =>
  Object.fromEntries(draft.suggestions.map((item) => [item.fieldKey, item.value]))
