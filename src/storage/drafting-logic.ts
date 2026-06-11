export interface DraftingChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TemplateVariableInput {
  placeholder: string
  label: string
  type: string
  description?: string
}

export interface TemplateChoice {
  id: string
  title: string
  docxPath: string
}

export type FreeDraftTemplateResolution =
  | { kind: 'template'; template: TemplateChoice; notice: '' }
  | { kind: 'builtin'; template: null; notice: string }

export interface NormalizedFreeDraftResult {
  status: 'need_more_info' | 'drafted'
  documentType: string
  draftTitle: string
  draftBody: string
  questions: string[]
  assumptions: string[]
  riskNotes: string[]
  nextActions: string[]
}

export const TEMPLATE_DRAFT_SYSTEM_PROMPT = `你是法律文书模板起草助手。你的任务不是重写模板，而是根据模板变量列表，从用户消息中提取变量值，并判断是否可以填充模板。

规则：
1. 严格保留模板结构和措辞，不得自行增删模板条款。
2. 只提取用户明确提供的信息；不确定则留空。
3. 日期统一 YYYY-MM-DD；金额输出纯数字，可在 note 中说明币种。
4. 一次最多追问 3 个缺失字段，优先追问会阻断生成的字段。
5. 输出严格 JSON，不要 markdown。

输出格式：
{
  "mode": "template",
  "status": "need_more_info | ready",
  "collected": { "placeholder": "value" },
  "missing": [
    { "placeholder": "name", "label": "中文名", "reason": "为什么必需" }
  ],
  "question": "给用户的一句话追问；ready 时为空",
  "risk_notes": ["需要用户复核的法律或事实风险"],
  "user_summary": "给用户看的简短生成说明"
}`

export const FREE_DRAFT_SYSTEM_PROMPT = `你是资深法律文书起草助手。请根据用户需求生成可供律师复核的法律文书草稿。

规则：
1. 如果缺少足以起草的核心信息，先追问，不要强行生成。
2. 如果信息基本足够，直接输出完整文书。
3. 未提供但文书必需的信息，用 [方括号占位] 标注。
4. 不得编造事实、案号、法院、金额、日期或法律关系。
5. 文风应正式、清晰、可修改，避免口语化。
6. 输出严格 JSON，不要 markdown。

输出格式：
{
  "mode": "free",
  "status": "need_more_info | drafted",
  "document_type": "文书类型",
  "questions": ["需要用户补充的问题，最多 3 个"],
  "draft_title": "文书标题",
  "draft_body": "完整文书正文；need_more_info 时为空",
  "assumptions": ["根据用户信息作出的显式假设"],
  "risk_notes": ["需要律师复核的风险点"],
  "next_actions": ["建议用户下一步操作"]
}`

export const parseStructuredAiJson = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim()
  try {
    const direct = JSON.parse(trimmed)
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct
  } catch {
    /* continue */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    try {
      const value = JSON.parse(fenced[1])
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      /* continue */
    }
  }

  const start = trimmed.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const value = JSON.parse(trimmed.slice(start, index + 1))
          if (value && typeof value === 'object' && !Array.isArray(value)) return value
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []

export const normalizeFreeDraftResult = (raw: Record<string, unknown> | null): NormalizedFreeDraftResult => {
  const status = raw?.status === 'drafted' ? 'drafted' : 'need_more_info'
  return {
    status,
    documentType: String(raw?.document_type ?? raw?.documentType ?? ''),
    draftTitle: String(raw?.draft_title ?? raw?.draftTitle ?? ''),
    draftBody: status === 'drafted' ? String(raw?.draft_body ?? raw?.draftBody ?? '') : '',
    questions: asStringArray(raw?.questions).slice(0, 3),
    assumptions: asStringArray(raw?.assumptions),
    riskNotes: asStringArray(raw?.risk_notes ?? raw?.riskNotes),
    nextActions: asStringArray(raw?.next_actions ?? raw?.nextActions),
  }
}

export const resolveFreeDraftTemplate = (
  templates: TemplateChoice[],
  defaultTemplateId?: string | null,
): FreeDraftTemplateResolution => {
  const id = defaultTemplateId?.trim()
  if (!id) {
    return {
      kind: 'builtin',
      template: null,
      notice: '尚未选择自由起草默认模板，将使用内置基础版式导出。',
    }
  }

  const template = templates.find((item) => item.id === id) ?? null
  if (!template) {
    return {
      kind: 'builtin',
      template: null,
      notice: '自由起草默认模板已失效，将使用内置基础版式导出。',
    }
  }

  return { kind: 'template', template, notice: '' }
}

export const buildFreeDraftMessages = (
  userText: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): DraftingChatMessage[] => [
  { role: 'system', content: FREE_DRAFT_SYSTEM_PROMPT },
  ...history,
  { role: 'user', content: userText },
]

export const buildTemplateDraftMessages = (
  userText: string,
  variables: TemplateVariableInput[],
  existingValues: Record<string, string>,
): DraftingChatMessage[] => [
  { role: 'system', content: TEMPLATE_DRAFT_SYSTEM_PROMPT },
  {
    role: 'user',
    content: [
      '模板变量列表：',
      JSON.stringify(variables, null, 2),
      '已收集变量：',
      JSON.stringify(existingValues, null, 2),
      '用户最新输入：',
      userText,
    ].join('\n'),
  },
]
