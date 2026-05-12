import { localIsoDate } from './shared/date'

export type ModuleKey =
  | 'client'
  | 'service_contract'
  | 'litigation'
  | 'non_litigation'
  | 'invoice'
  | 'conflict_check'
  | 'calendar_event'

export type FieldType =
  | 'text'
  | 'long_text'
  | 'date'
  | 'money'
  | 'number'
  | 'single_select'
  | 'multi_select'
  | 'boolean'
  | 'party_ref'
  | 'file_ref'
  | 'matter_ref'

export interface FieldDefinition {
  key: string
  label: string
  type: FieldType
  required: boolean
  builtIn: boolean
  ledger: boolean
  filterable: boolean
  options?: string[]
}

export interface ModuleDefinition {
  key: ModuleKey
  label: string
  description: string
  fields: FieldDefinition[]
}

export interface WorkspaceConfig {
  workspaceName: string
  version: number
  modules: Record<ModuleKey, ModuleDefinition>
  aiPolicy: {
    mode: 'local_first_optional_cloud'
    requireConfirmationBeforeRead: boolean
    requireConfirmationBeforeWrite: boolean
  }
}

export interface RecordSummary {
  id: string
  module: ModuleKey
  title: string
  status?: string
  date?: string
  path?: string
  fields: Record<string, unknown>
  body?: string
}

export interface WorkspaceDiagnostic {
  severity: 'warning'
  message: string
  path?: string
}

export interface WorkspaceSnapshot {
  workspacePath: string
  config: WorkspaceConfig
  records: RecordSummary[]
  diagnostics: WorkspaceDiagnostic[]
}

export interface ConflictHit {
  id: string
  module: ModuleKey
  title: string
  matchedField: string
  matchedValue: string
  reason: string
}

export interface ExtractionDraft {
  targetModule: ModuleKey
  sourceKind: 'pasted_text' | 'selected_file'
  suggestions: Array<{
    fieldKey: string
    label: string
    value: string
    confidence: number
    sourceExcerpt: string
  }>
  unresolved: string[]
  rawResponse?: string
  notice?: string
}

export type AiProvider = 'openai' | 'deepseek' | 'anthropic' | 'doubao' | 'custom'

export interface AISettings {
  provider: AiProvider
  apiKey: string
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
  systemPrompt: string
  timeoutSeconds?: number
  enabled: boolean
}

export const PROVIDER_PRESETS: Record<AiProvider, { label: string; baseUrl: string; model: string; help: string }> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    help: '官方 API。如使用 Azure 或国内代理，请改 base URL 为对应地址。',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    help: 'DeepSeek 官方接口（OpenAI 兼容）。可在 platform.deepseek.com 获取 API Key。',
  },
  anthropic: {
    label: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    help: '使用 anthropic-version: 2023-06-01。需要在 console.anthropic.com 创建 API Key。',
  },
  doubao: {
    label: '豆包 / 火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1-5-pro-32k-250115',
    help: 'OpenAI 兼容接口。model 通常为方舟控制台开通的模型 endpoint id。',
  },
  custom: {
    label: '自定义 (OpenAI 兼容)',
    baseUrl: 'https://your-endpoint.example.com/v1',
    model: 'your-model-id',
    help: '凡是 OpenAI Chat Completions 协议兼容的服务（OneAPI、SiliconFlow、Together、Groq 等）都可以填这里。',
  },
}

export const defaultAiSettings = (): AISettings => ({
  provider: 'deepseek',
  apiKey: '',
  baseUrl: '',
  model: '',
  temperature: 0.2,
  maxTokens: 2048,
  systemPrompt: '',
  timeoutSeconds: 60,
  enabled: false,
})

export interface AttachmentEntry {
  name: string
  size: number
  modified: string
  absolutePath: string
  kind: string
}

export interface ChatResult {
  content: string
  provider: string
  model: string
  latencyMs: number
}

export interface InboxSourceFile {
  originalName: string
  storedPath: string
  sizeBytes: number
  mimeType: string
  contentHash?: string
}

export interface ClassifyResult {
  documentType: string
  targetModule: ModuleKey
  confidence: number
  reasoning: string
}

export interface ExtractFieldResult {
  value: string
  confidence: number
  sourceExcerpt: string
}

export interface MatchResult {
  matchType: 'existing' | 'new'
  existingRecord?: {
    id: string
    module: ModuleKey
    title: string
    matchScore: number
    matchReason: string
  }
  conflictWarning?: {
    suspectedParties: string[]
    existingClients: string[]
    recommendation: string
  }
}

export interface InboxSuggestion {
  action: 'create_new' | 'attach_to_existing' | 'create_note'
  targetModule: ModuleKey
  existingRecordId?: string
  suggestedFields: Record<string, string>
  suggestedBody: string
  conflictWarning?: string
  confidence: number
  reasoning: string
}

export interface InboxPipeline {
  classify: ClassifyResult
  extract: { fields: Record<string, ExtractFieldResult>; unresolved: string[] }
  match: MatchResult
  suggest: InboxSuggestion
}

export type InboxStatus = 'pending' | 'confirmed' | 'skipped'

export interface InboxEntry {
  id: string
  createdAt: string
  sourceFile: InboxSourceFile
  pipeline: InboxPipeline | null
  userDecision: InboxStatus
}

export const MODULE_ORDER: ModuleKey[] = [
  'client',
  'conflict_check',
  'service_contract',
  'litigation',
  'non_litigation',
  'invoice',
  'calendar_event',
]

const field = (
  key: string,
  label: string,
  type: FieldType = 'text',
  options: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  key,
  label,
  type,
  required: Boolean(options.required),
  builtIn: options.builtIn ?? true,
  ledger: options.ledger ?? true,
  filterable: options.filterable ?? true,
  options: options.options,
})

export const FIELD_OPTION_PRESETS: Partial<Record<ModuleKey, Record<string, string[]>>> = {
  client: {
    client_type: ['个人', '公司', '政府/事业单位', '其他组织'],
    status: ['潜在', '在服', '暂停', '终止服务', '归档'],
  },
  conflict_check: {
    conclusion: ['未检查', '无冲突', '需进一步核查', '存在冲突', '已拒绝接案', '已取得豁免/同意'],
  },
  service_contract: {
    invoice_status: ['未开票', '部分开票', '已开票', '无需开票'],
    status: ['拟签', '履行中', '待续签', '已完成', '已终止', '归档'],
  },
  litigation: {
    party_position: [
      '原告',
      '被告',
      '上诉人',
      '被上诉人',
      '申请人',
      '被申请人',
      '第三人',
      '执行申请人',
      '被执行人',
      '仲裁申请人',
      '仲裁被申请人',
      '其他',
    ],
    procedure: [
      '诉前评估',
      '诉前调解',
      '一审',
      '二审',
      '再审审查',
      '再审',
      '执行',
      '执行异议',
      '执行异议之诉',
      '仲裁',
      '撤裁',
      '不予执行仲裁裁决',
      '保全',
      '破产',
      '行政复议',
      '其他',
    ],
    hearing_status: ['未安排', '已排期未开庭', '已开庭', '多次开庭', '延期', '取消'],
    status: [
      '评估中',
      '待立案',
      '已立案',
      '未开庭',
      '已排期开庭',
      '已开庭',
      '庭后待判',
      '已判决/裁决',
      '上诉期',
      '二审中',
      '执行中',
      '和解/调解中',
      '中止/暂停',
      '已结案',
      '归档',
    ],
  },
  non_litigation: {
    business_type: ['合同审查', '法律咨询', '专项服务', '常年顾问', '尽职调查', '合规整改', '法律培训', '函件起草', '其他'],
    status: ['待处理', '办理中', '待客户反馈', '待对方反馈', '已交付', '已复盘', '暂停', '归档'],
  },
  invoice: {
    invoice_status: ['未开票', '部分开票', '已开票', '无需开票', '待客户信息', '已作废/红冲'],
  },
  calendar_event: {
    event_type: ['开庭', '会议', '期限', '交付', '跟进', '任务', '电话', '出差', '其他'],
    status: ['待处理', '进行中', '已完成', '已延期', '已取消'],
  },
}

export const optionPresetFor = (moduleKey: ModuleKey, fieldKey: string): string[] | undefined =>
  FIELD_OPTION_PRESETS[moduleKey]?.[fieldKey]

export const defaultConfig = (): WorkspaceConfig => ({
  workspaceName: '法律业务工作区',
  version: 3,
  aiPolicy: {
    mode: 'local_first_optional_cloud',
    requireConfirmationBeforeRead: true,
    requireConfirmationBeforeWrite: true,
  },
  modules: {
    client: {
      key: 'client',
      label: '客户管理',
      description: '客户、联系人、关联方和历史业务入口。',
      fields: [
        field('name', '客户名称', 'text', { required: true }),
        field('client_type', '客户类型', 'single_select', {
          options: ['个人', '公司', '政府/事业单位', '其他组织'],
        }),
        field('contacts', '联系人', 'long_text'),
        field('related_parties', '关联方', 'long_text'),
        field('opponents', '历史相对方', 'long_text'),
        field('owner', '负责人'),
        field('created_at', '建档日期', 'date'),
        field('status', '状态', 'single_select', {
          options: ['潜在', '在服', '暂停', '归档'],
        }),
      ],
    },
    conflict_check: {
      key: 'conflict_check',
      label: '利冲检查',
      description: '利益冲突检查记录：检查拟委托人/相对方/关联方与历史客户的冲突。',
      fields: [
        field('title', '检查主题', 'text', { required: true }),
        field('client_name', '拟委托人', 'party_ref'),
        field('opposing_parties', '相对方', 'long_text'),
        field('related_parties', '关联方', 'long_text'),
        field('check_date', '检查日期', 'date'),
        field('conclusion', '人工结论', 'single_select', {
          options: FIELD_OPTION_PRESETS.conflict_check?.conclusion,
        }),
        field('hits_summary', '疑似命中摘要', 'long_text'),
      ],
    },
    service_contract: {
      key: 'service_contract',
      label: '服务合同',
      description: '与客户签署的委托或法律服务合同。',
      fields: [
        field('title', '合同名称', 'text', { required: true }),
        field('client_name', '客户', 'party_ref'),
        field('contract_no', '合同编号'),
        field('service_scope', '服务范围', 'long_text'),
        field('sign_date', '签署日期', 'date'),
        field('amount', '合同金额', 'money'),
        field('paid_amount', '已收金额', 'money'),
        field('invoice_status', '开票状态', 'single_select', {
          options: ['未开票', '部分开票', '已开票', '无需开票'],
        }),
        field('status', '合同状态', 'single_select', {
          options: ['拟签', '履行中', '已完成', '已终止'],
        }),
      ],
    },
    litigation: {
      key: 'litigation',
      label: '诉讼管理',
      description: '诉讼案件录入、期限、开庭和状态追踪。',
      fields: [
        field('title', '案件名称', 'text', { required: true }),
        field('client_name', '客户/委托人', 'party_ref'),
        field('our_parties', '我方当事人', 'long_text'),
        field('party_position', '我方地位', 'single_select', {
          options: FIELD_OPTION_PRESETS.litigation?.party_position,
        }),
        field('opposing_parties', '对方当事人', 'long_text'),
        field('third_parties', '第三人/其他当事人', 'long_text'),
        field('case_number', '案号'),
        field('court', '法院/仲裁机构'),
        field('cause_of_action', '案由'),
        field('procedure', '程序', 'single_select', {
          options: FIELD_OPTION_PRESETS.litigation?.procedure,
        }),
        field('opened_at', '立案/建档日期', 'date'),
        field('hearing_status', '开庭状态', 'single_select', {
          options: FIELD_OPTION_PRESETS.litigation?.hearing_status,
        }),
        field('hearing_date', '下次开庭日期', 'date'),
        field('limitation_deadline', '关键期限', 'date'),
        field('next_task', '下一步任务'),
        field('next_task_due', '任务截止日期', 'date'),
        field('progress_log', '进度记录', 'long_text', { ledger: false, filterable: false }),
        field('status', '案件状态', 'single_select', {
          options: FIELD_OPTION_PRESETS.litigation?.status,
        }),
      ],
    },
    non_litigation: {
      key: 'non_litigation',
      label: '非诉管理',
      description: '合同审查、咨询、专项非诉业务和复盘。',
      fields: [
        field('title', '业务名称', 'text', { required: true }),
        field('client_name', '客户', 'party_ref'),
        field('business_type', '业务类型', 'single_select', {
          options: FIELD_OPTION_PRESETS.non_litigation?.business_type,
        }),
        field('subject', '审查对象/咨询内容', 'long_text'),
        field('received_at', '接收日期', 'date'),
        field('delivery_deadline', '交付期限', 'date'),
        field('review_round', '审查轮次', 'number'),
        field('page_count', '页数', 'number'),
        field('word_count', '字数', 'number'),
        field('status', '办理状态', 'single_select', {
          options: FIELD_OPTION_PRESETS.non_litigation?.status,
        }),
      ],
    },
    invoice: {
      key: 'invoice',
      label: '开票管理',
      description: '围绕服务合同记录应收、已收和开票信息。',
      fields: [
        field('title', '开票事项', 'text', { required: true }),
        field('client_name', '客户', 'party_ref'),
        field('contract_title', '关联服务合同', 'matter_ref'),
        field('receivable_amount', '应收金额', 'money'),
        field('paid_amount', '已收金额', 'money'),
        field('invoice_status', '是否开票', 'single_select', {
          options: ['未开票', '部分开票', '已开票', '无需开票'],
        }),
        field('invoice_no', '发票号'),
        field('invoice_date', '开票日期', 'date'),
      ],
    },
    calendar_event: {
      key: 'calendar_event',
      label: '日历管理',
      description: '开庭、会议、期限、交付和跟进任务。',
      fields: [
        field('title', '日程标题', 'text', { required: true }),
        field('event_type', '日程类型', 'single_select', {
          options: FIELD_OPTION_PRESETS.calendar_event?.event_type,
        }),
        field('date', '日期', 'date'),
        field('time', '时间'),
        field('related_matter', '关联事项', 'matter_ref'),
        field('status', '状态', 'single_select', {
          options: FIELD_OPTION_PRESETS.calendar_event?.status,
        }),
      ],
    },
  },
})

export const emptyRecordFor = (definition: ModuleDefinition) => {
  const today = localIsoDate()
  return Object.fromEntries(
    definition.fields.map((item) => {
      if (item.type === 'date') {
        return [item.key, ['created_at', 'check_date', 'date'].includes(item.key) ? today : '']
      }
      if (item.type === 'boolean') return [item.key, false]
      if (item.type === 'multi_select') return [item.key, []]
      if (item.options?.length) return [item.key, '']
      return [item.key, '']
    }),
  )
}

export const titleFromFields = (fields: Record<string, unknown>, fallback: string) => {
  const value =
    fields.title ??
    fields.name ??
    fields.contract_title ??
    fields.client_name ??
    fallback

  return String(value || fallback)
}

export const dateFromFields = (fields: Record<string, unknown>) => {
  const keys = [
    'date',
    'opened_at',
    'received_at',
    'sign_date',
    'check_date',
    'invoice_date',
    'created_at',
    'hearing_date',
    'next_task_due',
    'delivery_deadline',
    'limitation_deadline',
  ]

  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string' && value.length >= 7) return value
  }

  return localIsoDate()
}
