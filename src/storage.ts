import { invoke } from '@tauri-apps/api/core'
import {
  defaultAiSettings,
  defaultConfig,
  dateFromFields,
  PROVIDER_PRESETS,
  type AISettings,
  type AttachmentEntry,
  type ChatResult,
  type ConflictHit,
  type ExtractionDraft,
  type ModuleKey,
  type RecordSummary,
  type WorkspaceConfig,
  type WorkspaceSnapshot,
} from './domain'

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const recentKey = 'legalbiz-recent-workspaces'
const lastKey = 'legalbiz-last-workspace'
const demoKey = 'legalbiz-demo-workspace'

// ---------------------------------------------------------------------------
// 持久化最近工作区：Tauri 环境下写入 app config dir 的 state.json，浏览器降级到
// localStorage。两条轨道同步写入，以防任一端被清。
// ---------------------------------------------------------------------------

interface AppState {
  lastWorkspace?: string | null
  recentWorkspaces?: string[]
}

const safeParse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

let cachedState: AppState | null = null

const readLocalState = (): AppState => ({
  lastWorkspace: localStorage.getItem(lastKey) || null,
  recentWorkspaces: safeParse<string[]>(localStorage.getItem(recentKey), []),
})

const writeLocalState = (state: AppState) => {
  if (state.lastWorkspace) {
    localStorage.setItem(lastKey, state.lastWorkspace)
  } else {
    localStorage.removeItem(lastKey)
  }
  localStorage.setItem(recentKey, JSON.stringify(state.recentWorkspaces ?? []))
}

export const loadAppState = async (): Promise<AppState> => {
  if (cachedState) return cachedState
  if (isTauri()) {
    try {
      const fromDisk = await invoke<AppState>('load_app_state')
      // 顺手同步到 localStorage，方便浏览器调试
      writeLocalState(fromDisk)
      cachedState = fromDisk
      return fromDisk
    } catch {
      // 读取失败时降级
    }
  }
  const local = readLocalState()
  cachedState = local
  return local
}

const persistAppState = async (state: AppState): Promise<void> => {
  cachedState = state
  writeLocalState(state)
  if (isTauri()) {
    try {
      await invoke('save_app_state', { state })
    } catch {
      // 写盘失败不致命，localStorage 仍有副本
    }
  }
}

export const rememberWorkspace = async (path: string): Promise<void> => {
  if (!path) return
  const current = await loadAppState()
  const recents = (current.recentWorkspaces ?? []).filter((item) => item !== path)
  await persistAppState({
    lastWorkspace: path,
    recentWorkspaces: [path, ...recents].slice(0, 8),
  })
}

export const forgetWorkspace = async (path: string): Promise<void> => {
  const current = await loadAppState()
  const recents = (current.recentWorkspaces ?? []).filter((item) => item !== path)
  const last = current.lastWorkspace === path ? null : current.lastWorkspace ?? null
  await persistAppState({ lastWorkspace: last, recentWorkspaces: recents })
}

export const getRecentWorkspacesSync = (): string[] => {
  if (cachedState?.recentWorkspaces) return cachedState.recentWorkspaces
  return readLocalState().recentWorkspaces ?? []
}

export const getLastWorkspaceSync = (): string | null => {
  if (cachedState?.lastWorkspace !== undefined) return cachedState.lastWorkspace ?? null
  return readLocalState().lastWorkspace ?? null
}

export const getDefaultWorkspaceRoot = async (): Promise<string> => {
  if (!isTauri()) return ''
  try {
    return await invoke<string>('default_workspace_root')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Folder picker — Tauri dialog plugin in app, prompt() in browser
// ---------------------------------------------------------------------------

export const pickWorkspaceDirectory = async (
  startingPath?: string,
): Promise<string | null> => {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择本地工作区文件夹',
      defaultPath: startingPath || undefined,
    })
    if (typeof selected === 'string') return selected
    return null
  }

  const value = window.prompt('输入演示工作区名称：', startingPath || '浏览器演示工作区')
  return value && value.trim() ? value.trim() : null
}

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

const browserDemoSnapshot = (path: string): WorkspaceSnapshot => {
  type Seed = { module: ModuleKey; fields: Record<string, unknown>; body: string }
  const seeds: Seed[] = [
    { module: 'client', fields: { name: '上海岚山科技有限公司', client_type: '公司', contacts: '王宇 总经理 13800000001', related_parties: '岚山控股有限公司、王宇', opponents: '北辰贸易有限公司', owner: '张律师', created_at: '2026-03-12', status: '在服' }, body: 'SaaS 服务商，主营企业协同办公；常年顾问 + 不定期合同审查。' },
    { module: 'client', fields: { name: '北京华诚医药股份有限公司', client_type: '公司', contacts: '李静 法务总监 010-65000000', related_parties: '华诚医药控股集团、李静', opponents: '前员工赵某', owner: '陈律师', created_at: '2026-02-08', status: '在服' }, body: '上市医药公司，处理合规、知识产权和劳动争议事务。' },
    { module: 'client', fields: { name: '王某（个人）', client_type: '个人', contacts: '13900000123', related_parties: '配偶、未成年子女', opponents: '北辰贸易有限公司', owner: '张律师', created_at: '2026-04-02', status: '在服' }, body: '个人家事 + 商事综合委托。' },
    { module: 'conflict_check', fields: { title: '拟接案 利冲检查 - 北辰贸易咨询', client_name: '北辰贸易有限公司', opposing_parties: '上海岚山科技有限公司', related_parties: '北辰控股', check_date: '2026-04-18', conclusion: '存在冲突', hits_summary: '拟委托人为现有客户岚山科技的相对方，建议拒绝接案。' }, body: '客户拓展同事推送的咨询线索，命中现有客户相对方，已沟通拒绝。' },
    { module: 'conflict_check', fields: { title: '拟接案 利冲检查 - 远东供应链股份', client_name: '远东供应链股份有限公司', opposing_parties: '上海岚山科技有限公司', related_parties: '—', check_date: '2026-04-22', conclusion: '需进一步核查', hits_summary: '潜在相对方与现有客户岚山科技重名，待向客户确认。' }, body: '需要客户书面确认是否同意接案。' },
    { module: 'service_contract', fields: { title: '常年法律顾问合同', client_name: '上海岚山科技有限公司', contract_no: 'LS-LEGAL-2026-001', service_scope: '常年法律顾问、合同审查、日常咨询', sign_date: '2026-04-01', amount: 120000, paid_amount: 60000, invoice_status: '部分开票', status: '履行中' }, body: '按半年收款，2026 上半年款已收。' },
    { module: 'service_contract', fields: { title: '股权激励项目专项法律服务合同', client_name: '北京华诚医药股份有限公司', contract_no: 'HC-EQUITY-2026-002', service_scope: '股权激励方案设计、协议起草、税务衔接', sign_date: '2026-03-20', amount: 180000, paid_amount: 60000, invoice_status: '部分开票', status: '履行中' }, body: '按里程碑收款，已收首期 60000。' },
    { module: 'service_contract', fields: { title: '知识产权事务委托合同', client_name: '王某（个人）', contract_no: 'WX-IP-2026-003', service_scope: '商标维权、版权登记', sign_date: '2026-04-05', amount: 30000, paid_amount: 30000, invoice_status: '已开票', status: '履行中' }, body: '一次性收款，发票已开。' },
    { module: 'litigation', fields: { title: '岚山科技 v. 北辰贸易 服务合同纠纷', client_name: '上海岚山科技有限公司', opposing_parties: '北辰贸易有限公司', case_number: '(2026)沪0105民初1234号', court: '上海市长宁区人民法院', cause_of_action: '服务合同纠纷', procedure: '一审', opened_at: '2026-03-15', limitation_deadline: '2026-05-20', status: '待开庭' }, body: '需要在开庭前完成证据目录、代理意见初稿。' },
    { module: 'litigation', fields: { title: '华诚医药 v. 赵某 劳动争议二审', client_name: '北京华诚医药股份有限公司', opposing_parties: '赵某', case_number: '(2026)京01民终567号', court: '北京市第一中级人民法院', cause_of_action: '劳动争议', procedure: '二审', opened_at: '2026-03-02', limitation_deadline: '2026-05-12', status: '待开庭' }, body: '重点准备竞业限制条款合理性的论证。' },
    { module: 'litigation', fields: { title: '王某 v. 北辰贸易 民间借贷纠纷', client_name: '王某（个人）', opposing_parties: '北辰贸易有限公司', case_number: '(2026)沪0104民初890号', court: '上海市徐汇区人民法院', cause_of_action: '民间借贷纠纷', procedure: '一审', opened_at: '2026-04-10', limitation_deadline: '2026-06-01', status: '进行中' }, body: '对方已提出调解意向。' },
    { module: 'non_litigation', fields: { title: '股权激励协议审查', client_name: '上海岚山科技有限公司', business_type: '合同审查', subject: '股权激励协议、授予通知书、离职回购条款', received_at: '2026-04-16', delivery_deadline: '2026-04-29', review_round: 1, status: '办理中' }, body: '重点关注回购价格、竞业限制和个人所得税安排。' },
    { module: 'non_litigation', fields: { title: '数据合规整改方案', client_name: '北京华诚医药股份有限公司', business_type: '专项服务', subject: '出境数据合规、患者数据本地化整改', received_at: '2026-04-08', delivery_deadline: '2026-05-15', review_round: 2, status: '待反馈' }, body: '已交付第一轮整改建议，等待客户内部讨论反馈。' },
    { module: 'non_litigation', fields: { title: '婚前财产协议起草', client_name: '王某（个人）', business_type: '法律咨询', subject: '婚前财产范围、债务隔离、过户安排', received_at: '2026-04-20', delivery_deadline: '2026-04-30', review_round: 1, status: '办理中' }, body: '需要在 4 月 30 日前提交协议初稿。' },
    { module: 'invoice', fields: { title: '岚山顾问费 - Q2 首款', client_name: '上海岚山科技有限公司', contract_title: '常年法律顾问合同', receivable_amount: 60000, paid_amount: 60000, invoice_status: '已开票', invoice_no: '20260401001', invoice_date: '2026-04-01' }, body: '顾问费已收已开。' },
    { module: 'invoice', fields: { title: '华诚股权激励 - 首期款', client_name: '北京华诚医药股份有限公司', contract_title: '股权激励项目专项法律服务合同', receivable_amount: 60000, paid_amount: 60000, invoice_status: '未开票', invoice_no: '', invoice_date: '' }, body: '客户已付款，等待开票指示。' },
    { module: 'invoice', fields: { title: '王某 IP 委托 - 一次性律师费', client_name: '王某（个人）', contract_title: '知识产权事务委托合同', receivable_amount: 30000, paid_amount: 30000, invoice_status: '已开票', invoice_no: '20260405002', invoice_date: '2026-04-05' }, body: '一次性收款，发票已开。' },
    { module: 'calendar_event', fields: { title: '岚山案开庭', event_type: '开庭', date: '2026-04-30', time: '09:30', related_matter: '岚山科技 v. 北辰贸易 服务合同纠纷', status: '待处理' }, body: '提前一日确认证据目录与出庭安排。' },
    { module: 'calendar_event', fields: { title: '华诚劳动争议二审 庭前会议', event_type: '会议', date: '2026-05-06', time: '14:00', related_matter: '华诚医药 v. 赵某 劳动争议二审', status: '待处理' }, body: '与客户对齐答辩思路。' },
    { module: 'calendar_event', fields: { title: '婚前财产协议交付截止', event_type: '交付', date: '2026-04-30', time: '18:00', related_matter: '婚前财产协议起草', status: '待处理' }, body: '提交前再做一轮交叉校对。' },
  ]

  const counters: Record<ModuleKey, number> = {
    client: 0, conflict_check: 0, service_contract: 0, litigation: 0, non_litigation: 0, invoice: 0, calendar_event: 0,
  }
  const prefix: Record<ModuleKey, string> = {
    client: 'CLI', conflict_check: 'CHK', service_contract: 'CON', litigation: 'LIT', non_litigation: 'NON', invoice: 'INV', calendar_event: 'CAL',
  }

  const records: RecordSummary[] = seeds.map((seed) => {
    counters[seed.module] += 1
    const date = String(seed.fields.date ?? seed.fields.opened_at ?? seed.fields.received_at ?? seed.fields.sign_date ?? seed.fields.check_date ?? seed.fields.invoice_date ?? seed.fields.created_at ?? '2026-04-01')
    const id = `${prefix[seed.module]}-${date.slice(0, 4)}-${String(counters[seed.module]).padStart(4, '0')}`
    const title = String(seed.fields.title ?? seed.fields.name ?? id)
    return {
      id,
      module: seed.module,
      title,
      status: String(seed.fields.status ?? seed.fields.invoice_status ?? seed.fields.conclusion ?? ''),
      date,
      path: `demo://${seed.module}/${id}.md`,
      fields: { ...seed.fields, id, module: seed.module, title },
      body: seed.body,
    }
  })

  return {
    workspacePath: path,
    config: { ...defaultConfig(), workspaceName: path || '浏览器演示工作区' },
    records,
    diagnostics: [],
  }
}

const demoSnapshot = browserDemoSnapshot

const mergeDefaultConfig = (config: WorkspaceConfig): WorkspaceConfig => {
  const defaults = defaultConfig()
  const next: WorkspaceConfig = {
    ...config,
    version: Math.max(config.version ?? 0, defaults.version),
    modules: { ...config.modules },
  }

  for (const moduleKey of Object.keys(defaults.modules) as ModuleKey[]) {
    const current = next.modules[moduleKey]
    const defaultModule = defaults.modules[moduleKey]
    if (!current) {
      next.modules[moduleKey] = defaultModule
      continue
    }

    const fields = [...current.fields]
    for (const defaultField of defaultModule.fields) {
      const existing = fields.find((field) => field.key === defaultField.key)
      if (!existing) {
        fields.push(defaultField)
        continue
      }
      if ((!existing.options || existing.options.length === 0) && defaultField.options?.length) {
        existing.options = defaultField.options
      }
      if (moduleKey === 'litigation' && existing.key === 'client_name' && existing.label === '客户') {
        existing.label = '客户/委托人'
      }
    }
    next.modules[moduleKey] = { ...current, fields }
  }

  return next
}

const loadDemo = (path: string): WorkspaceSnapshot => {
  const raw = localStorage.getItem(demoKey)
  const parsed = safeParse<WorkspaceSnapshot | null>(raw, null)
  if (!parsed) {
    const seeded = demoSnapshot(path)
    localStorage.setItem(demoKey, JSON.stringify(seeded))
    return seeded
  }
  parsed.workspacePath = path
  parsed.config.workspaceName = path || parsed.config.workspaceName
  parsed.config = mergeDefaultConfig(parsed.config)
  parsed.diagnostics = parsed.diagnostics ?? []
  saveDemo(parsed)
  return parsed
}

const saveDemo = (snapshot: WorkspaceSnapshot) => {
  localStorage.setItem(demoKey, JSON.stringify(snapshot))
}

export const createWorkspace = async (workspacePath: string): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    const snapshot = await invoke<WorkspaceSnapshot>('create_workspace', { workspacePath })
    await rememberWorkspace(snapshot.workspacePath || workspacePath)
    return snapshot
  }
  const snapshot = loadDemo(workspacePath)
  saveDemo(snapshot)
  await rememberWorkspace(workspacePath)
  return snapshot
}

export const openWorkspace = async (workspacePath: string): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    const snapshot = await invoke<WorkspaceSnapshot>('open_workspace', { workspacePath })
    await rememberWorkspace(snapshot.workspacePath || workspacePath)
    return snapshot
  }
  const snapshot = loadDemo(workspacePath)
  await rememberWorkspace(workspacePath)
  return snapshot
}

export const seedDemoRecords = async (workspacePath: string): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    const snapshot = await invoke<WorkspaceSnapshot>('seed_demo_records', { workspacePath })
    await rememberWorkspace(snapshot.workspacePath || workspacePath)
    return snapshot
  }
  // 浏览器演示：合成全套 demo 数据
  const seeded = browserDemoSnapshot(workspacePath)
  saveDemo(seeded)
  await rememberWorkspace(workspacePath)
  return seeded
}

export const checkWorkspaceExists = async (workspacePath: string): Promise<boolean> => {
  if (!workspacePath) return false
  if (isTauri()) {
    try {
      return await invoke<boolean>('workspace_exists', { workspacePath })
    } catch {
      return false
    }
  }
  return Boolean(localStorage.getItem(demoKey))
}

export const saveConfig = async (
  workspacePath: string,
  config: WorkspaceConfig,
): Promise<WorkspaceConfig> => {
  if (isTauri()) {
    return invoke<WorkspaceConfig>('save_config', { workspacePath, config })
  }
  const snapshot = loadDemo(workspacePath)
  snapshot.config = config
  saveDemo(snapshot)
  return config
}

export const createRecord = async (
  workspacePath: string,
  moduleKey: ModuleKey,
  fields: Record<string, unknown>,
  body: string,
): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    return invoke<WorkspaceSnapshot>('create_record', {
      workspacePath,
      moduleKey,
      fields,
      body,
    })
  }

  const snapshot = loadDemo(workspacePath)
  const prefix: Record<ModuleKey, string> = {
    client: 'CLI',
    service_contract: 'CON',
    litigation: 'LIT',
    non_litigation: 'NON',
    invoice: 'INV',
    conflict_check: 'CHK',
    calendar_event: 'CAL',
  }
  const next = snapshot.records.filter((item) => item.module === moduleKey).length + 1
  const date = dateFromFields(fields)
  const id = `${prefix[moduleKey]}-${date.slice(0, 4)}-${String(next).padStart(4, '0')}`
  const title = String(fields.title ?? fields.name ?? fields.client_name ?? id)

  snapshot.records.unshift({
    id,
    module: moduleKey,
    title,
    date,
    status: String(fields.status ?? fields.invoice_status ?? fields.conclusion ?? ''),
    fields,
    body,
    path: `demo://${moduleKey}/${id}.md`,
  })
  appendLinkedCalendarEvents(snapshot, moduleKey, id, title, fields)
  saveDemo(snapshot)
  return snapshot
}

const appendLinkedCalendarEvents = (
  snapshot: WorkspaceSnapshot,
  moduleKey: ModuleKey,
  sourceId: string,
  title: string,
  fields: Record<string, unknown>,
) => {
  if (moduleKey !== 'litigation') return

  const events: Array<{ title: string; eventType: string; date?: unknown; status?: string; body: string }> = [
    {
      title: `${title} · 开庭`,
      eventType: '开庭',
      date: fields.hearing_date,
      status: '待处理',
      body: `由诉讼案件 ${sourceId} 自动生成。`,
    },
    {
      title: `${title} · 关键期限`,
      eventType: '期限',
      date: fields.limitation_deadline,
      status: '待处理',
      body: `由诉讼案件 ${sourceId} 的关键期限自动生成。`,
    },
    {
      title: String(fields.next_task || `${title} · 下一步任务`),
      eventType: '任务',
      date: fields.next_task_due,
      status: '待处理',
      body: `由诉讼案件 ${sourceId} 的任务安排自动生成。`,
    },
  ]

  const existingCount = snapshot.records.filter((item) => item.module === 'calendar_event').length
  let offset = 0
  for (const event of events) {
    const date = typeof event.date === 'string' ? event.date : ''
    if (!date || date.length < 7) continue
    offset += 1
    const year = date.slice(0, 4)
    const id = `CAL-${year}-${String(existingCount + offset).padStart(4, '0')}`
    snapshot.records.unshift({
      id,
      module: 'calendar_event',
      title: event.title,
      date,
      status: event.status,
      fields: {
        id,
        module: 'calendar_event',
        title: event.title,
        event_type: event.eventType,
        date,
        time: '',
        related_matter: title,
        source_record_id: sourceId,
        status: event.status,
      },
      body: event.body,
      path: `demo://calendar_event/${id}.md`,
    })
  }
}

export const runConflictCheck = async (
  snapshot: WorkspaceSnapshot,
  terms: string[],
): Promise<ConflictHit[]> => {
  if (isTauri()) {
    return invoke<ConflictHit[]>('run_conflict_check', {
      records: snapshot.records,
      terms,
    })
  }
  return localConflictCheck(snapshot.records, terms)
}

export const localConflictCheck = (records: RecordSummary[], terms: string[]): ConflictHit[] => {
  const normalized = terms
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase())

  const hits: ConflictHit[] = []

  for (const record of records) {
    for (const [key, value] of Object.entries(record.fields)) {
      const text = String(value ?? '').toLowerCase()
      const matched = normalized.find((term) => term.length >= 2 && text.includes(term))
      if (matched) {
        hits.push({
          id: record.id,
          module: record.module,
          title: record.title,
          matchedField: key,
          matchedValue: String(value),
          reason: `字段“${key}”包含“${matched}”`,
        })
        break
      }
    }
  }

  return hits
}

export const generateLedgerSnapshot = async (
  workspacePath: string,
  month: string,
  ledgerType: ModuleKey,
  records: RecordSummary[],
): Promise<string> => {
  if (isTauri()) {
    return invoke<string>('generate_ledger_snapshot', {
      workspacePath,
      month,
      ledgerType,
    })
  }

  const rows = records.filter((item) => item.module === ledgerType && item.date?.startsWith(month))
  return `demo://ledgers/${month}-${ledgerType}.md (${rows.length} 条)`
}

// ---------------------------------------------------------------------------
// CSV export — UTF-8 with BOM so Excel opens it directly. Replaces the heavy
// write-excel-file dependency.
// ---------------------------------------------------------------------------

const csvEscape = (value: unknown): string => {
  const text = value == null ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export const exportRowsToCsv = (
  records: RecordSummary[],
  filename: string,
): void => {
  const rows: Array<Record<string, unknown>> = records.map((record) => ({
    id: record.id,
    module: record.module,
    title: record.title,
    status: record.status,
    date: record.date,
    ...record.fields,
  }))

  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','))
  }

  const blob = new Blob(['﻿', lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

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
  const chineseCount = (token.match(/[\u4e00-\u9fa5]/g) ?? []).length
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
      pushMatch(
        client,
        opp,
        '相对方',
        'name',
        name,
        'block',
        `相对方「${opp}」与现有客户「${client.title}」匹配，建议拒绝接案。`,
        80,
      )
      const relatedParties = String(client.fields.related_parties ?? '')
      pushMatch(
        client,
        opp,
        '相对方',
        'related_parties',
        relatedParties,
        'block',
        `相对方「${opp}」出现在现有客户「${client.title}」的关联方列表中。`,
        68,
      )
    }
  }

  // 2) 关联方撞名现有客户
  for (const rel of related) {
    for (const client of clients) {
      const name = String(client.fields.name ?? client.title ?? '')
      pushMatch(
        client,
        rel,
        '关联方',
        'name',
        name,
        'warn',
        `拟接案的关联方「${rel}」与现有客户「${client.title}」匹配，需进一步核查关系。`,
        70,
      )
      const relatedParties = String(client.fields.related_parties ?? '')
      pushMatch(
        client,
        rel,
        '关联方',
        'related_parties',
        relatedParties,
        'warn',
        `拟接案的关联方「${rel}」出现在现有客户「${client.title}」的关联方列表中。`,
        52,
      )
    }
  }

  // 3) 拟委托人是现有客户的历史相对方 / 在已有事项中作为相对方出现
  for (const proposed of proposedTokens) {
    for (const client of clients) {
      const opps = String(client.fields.opponents ?? '')
      pushMatch(
        client,
        proposed,
        '拟委托人',
        'opponents',
        opps,
        'block',
        `拟委托人「${proposed}」是现有客户「${client.title}」的历史相对方。`,
        78,
      )
      const name = String(client.fields.name ?? client.title ?? '')
      pushMatch(
        client,
        proposed,
        '拟委托人',
        'name',
        name,
        'candidate',
        `拟委托人「${proposed}」疑似匹配现有客户「${client.title}」，可直接查看既有客户信息。`,
        34,
      )
      const relatedParties = String(client.fields.related_parties ?? '')
      pushMatch(
        client,
        proposed,
        '拟委托人',
        'related_parties',
        relatedParties,
        'warn',
        `拟委托人「${proposed}」出现在现有客户「${client.title}」的关联方列表中，建议核查是否存在关系冲突。`,
        50,
      )
    }
    for (const matter of matters) {
      const opp = String(matter.fields.opposing_parties ?? '')
      pushMatch(
        matter,
        proposed,
        '拟委托人',
        'opposing_parties',
        opp,
        'block',
        `拟委托人「${proposed}」在已有事项「${matter.title}」中作为相对方出现。`,
        74,
      )
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
        pushMatch(
          record,
          query.value,
          query.sourceField,
          field.key,
          value,
          'candidate',
          `${query.sourceField}「${query.value}」匹配${moduleLabel(record.module)}「${record.title}」的${field.label}，可作为候选信息核对。`,
          field.key === 'title' ? 10 : 22,
        )
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

/**
 * 读取文件为纯文本。按扩展名/魔数分发：
 *   - .pdf  → pdfjs-dist 提取文字层（懒加载）
 *   - .docx → JSZip 解 zip + 解析 word/document.xml（懒加载）
 *   - .doc  → 拒绝（老格式无法可靠解析；提示用户另存为 .docx）
 *   - 其它  → 按文本流水线：BOM → UTF-8 → GB18030
 *
 * 失败时抛人话错误，textarea 不会被污染。
 */
const TEXT_DECODE_LIMIT = 10 * 1024 * 1024 // 纯文本 10 MB
const PDF_DOCX_LIMIT = 30 * 1024 * 1024 // PDF/DOCX 30 MB

export interface WordDocumentStats {
  fileName: string
  pageCount: number
  wordCount: number
  pageSource: 'metadata' | 'estimated'
  wordSource: 'metadata' | 'text'
}

type JSZipModule = typeof import('jszip')
type JSZipInstance = Awaited<ReturnType<JSZipModule['loadAsync']>>

const loadJSZip = async (): Promise<JSZipModule> => {
  // jszip 用 `export = JSZip`，esModuleInterop 下默认会包装成 { default: JSZip }
  // 但 TS 类型解析有时给的是 JSZip 本体；都兼容一下。
  try {
    const mod = (await import('jszip')) as unknown as JSZipModule | { default: JSZipModule }
    return (mod as { default?: JSZipModule }).default ?? (mod as JSZipModule)
  } catch (error) {
    throw new Error(
      `DOCX 解析引擎加载失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

const loadDocxZip = async (file: File): Promise<JSZipInstance> => {
  const JSZipCtor = await loadJSZip()
  const buffer = await file.arrayBuffer()
  try {
    return await JSZipCtor.loadAsync(buffer)
  } catch (error) {
    throw new Error(
      `DOCX 打开失败：${error instanceof Error ? error.message : String(error)}。可能是文件损坏或不是有效 docx。`,
      { cause: error },
    )
  }
}

const parseXml = (xml: string, failureMessage: string): Document => {
  const dom = new DOMParser().parseFromString(xml, 'application/xml')
  if (dom.getElementsByTagName('parsererror').length > 0) {
    throw new Error(failureMessage)
  }
  return dom
}

const optionalPositiveInt = (value: string | null | undefined): number | null => {
  if (!value) return null
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const firstTagNumber = (dom: Document, tagNames: string[]): number | null => {
  for (const tagName of tagNames) {
    const value = optionalPositiveInt(dom.getElementsByTagName(tagName)[0]?.textContent)
    if (value) return value
  }
  return null
}

const wordCountFromText = (text: string): number => {
  const chineseChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latinWords = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0
  return chineseChars + latinWords
}

const estimatePagesFromText = (text: string): number =>
  Math.max(1, Math.ceil(Math.max(wordCountFromText(text), text.length) / 900))

const decodeAttempt = (
  buffer: ArrayBuffer,
  encoding: string,
): { text: string; badRatio: number } => {
  try {
    const decoder = new TextDecoder(encoding, { fatal: false })
    const text = decoder.decode(buffer)
    if (text.length === 0) return { text, badRatio: 1 }
    let bad = 0
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (code === 0xfffd) bad += 1
      // 控制字符（除制表 \t 换行 \n 回车 \r）也视作乱码
      else if (code < 32 && code !== 9 && code !== 10 && code !== 13) bad += 1
    }
    return { text, badRatio: bad / text.length }
  } catch {
    return { text: '', badRatio: 1 }
  }
}

const PLAIN_TEXT_EXTS = ['.txt', '.md', '.markdown', '.text', '.csv', '.tsv', '.json', '.yml', '.yaml', '.log', '.html', '.htm']

const isLikelyPlainText = (file: File): boolean => {
  const lower = file.name.toLowerCase()
  if (PLAIN_TEXT_EXTS.some((ext) => lower.endsWith(ext))) return true
  if (file.type && (file.type.startsWith('text/') || file.type === 'application/json')) return true
  return false
}

export const readFileAsText = async (file: File): Promise<string> => {
  const lower = file.name.toLowerCase()

  // 路由 1：PDF（懒加载 pdfjs）
  if (lower.endsWith('.pdf')) {
    if (file.size > PDF_DOCX_LIMIT) {
      throw new Error(
        `PDF 过大（${(file.size / 1024 / 1024).toFixed(1)} MB）。建议拆分或仅上传相关章节（≤ 30 MB）。`,
      )
    }
    return extractPdfText(file)
  }

  // 路由 2：DOCX（懒加载 jszip）
  if (lower.endsWith('.docx')) {
    if (file.size > PDF_DOCX_LIMIT) {
      throw new Error(
        `DOCX 过大（${(file.size / 1024 / 1024).toFixed(1)} MB）。建议拆分或仅上传相关章节（≤ 30 MB）。`,
      )
    }
    return extractDocxText(file)
  }

  // 路由 3：旧 .doc 格式 —— 拒绝并指引另存
  if (lower.endsWith('.doc')) {
    throw new Error(
      `旧版 .doc（Word 97-2003）格式无法直接解析。请在 Word 中"另存为 .docx"后重试，或复制内容粘贴到文本框。`,
    )
  }

  if (file.size > TEXT_DECODE_LIMIT) {
    throw new Error(
      `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB）。纯文本仅支持 ≤ 10 MB。`,
    )
  }

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  // BOM 探测
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }

  // 二进制特征兜底（即使扩展名错也能识别）
  if (
    (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) ||
    (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) ||
    (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
  ) {
    throw new Error(
      `文件 "${file.name}" 是二进制格式（图片或办公文档）。当前已支持 .pdf 和 .docx 直接上传——请检查文件扩展名是否正确，或复制文本粘贴到下方文本框。`,
    )
  }

  // 3) 多编码尝试
  const utf8 = decodeAttempt(buffer, 'utf-8')
  if (utf8.badRatio < 0.005) return utf8.text

  let best = utf8
  try {
    const gbk = decodeAttempt(buffer, 'gb18030')
    if (gbk.badRatio < best.badRatio) best = gbk
  } catch {
    /* 部分浏览器 runtime 不支持 gb18030，忽略 */
  }

  if (best.badRatio < 0.02) return best.text

  const hint = isLikelyPlainText(file)
    ? `文件 "${file.name}" 解码失败（UTF-8 / GB18030 都有大量乱码）。可能是文件损坏或采用了非常用编码——请用记事本/VS Code 另存为 UTF-8 后重试。`
    : `文件 "${file.name}" 不是纯文本格式，且不是 PDF/DOCX。请复制内容粘贴到下方文本框。`
  throw new Error(hint)
}

// ---------------------------------------------------------------------------
// PDF 文本提取（动态加载 pdfjs-dist，不影响主 bundle 首屏）
// ---------------------------------------------------------------------------

let pdfjsModule: typeof import('pdfjs-dist') | null = null

const loadPdfjs = async (): Promise<typeof import('pdfjs-dist')> => {
  if (pdfjsModule) return pdfjsModule
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    // Vite 把 worker 输出到 dist/assets/，?url 返回最终路径，
    // Tauri webview 通过 tauri://localhost 加载即可。
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  }
  pdfjsModule = pdfjs
  return pdfjs
}

const extractPdfText = async (file: File): Promise<string> => {
  let pdfjs: typeof import('pdfjs-dist')
  try {
    pdfjs = await loadPdfjs()
  } catch (error) {
    throw new Error(
      `PDF 解析引擎加载失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  const buffer = await file.arrayBuffer()
  let pdf: import('pdfjs-dist').PDFDocumentProxy
  try {
    pdf = await pdfjs.getDocument({ data: buffer }).promise
  } catch (error) {
    throw new Error(
      `PDF 打开失败：${error instanceof Error ? error.message : String(error)}。可能是文件损坏或加密。`,
      { cause: error },
    )
  }

  const parts: string[] = []
  const maxPages = Math.min(pdf.numPages, 200)
  for (let i = 1; i <= maxPages; i += 1) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    // 按 y 坐标聚合成行（pdfjs 返回的 item 顺序未必按行）
    const lineMap = new Map<number, string[]>()
    for (const item of content.items) {
      if (!('str' in item)) continue
      const text = (item as { str: string }).str
      if (!text) continue
      const transform = (item as { transform?: number[] }).transform
      const y = Math.round((transform?.[5] ?? 0) * 10) / 10
      const arr = lineMap.get(y) ?? []
      arr.push(text)
      lineMap.set(y, arr)
    }
    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a)
    const pageText = sortedYs.map((y) => (lineMap.get(y) ?? []).join('')).join('\n')
    parts.push(pageText)
    page.cleanup()
  }
  await pdf.cleanup()
  await pdf.destroy()

  const out = parts.join('\n\n').trim()
  if (!out) {
    throw new Error(
      `PDF "${file.name}" 没有可提取的文字层。可能是扫描件 / 图片 PDF——这种情况需要 OCR，本地暂不支持。建议先用 Adobe / WPS 做 OCR 后再上传。`,
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// DOCX 文本提取（动态加载 JSZip，约 100KB）
// ---------------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

const extractDocxTextFromZip = async (zip: JSZipInstance, fileName: string): Promise<string> => {
  const docFile = zip.file('word/document.xml')
  if (!docFile) {
    throw new Error('DOCX 缺少 word/document.xml，文件可能不是有效的 Word 文档。')
  }
  const docXml = await docFile.async('string')
  const dom = parseXml(docXml, 'DOCX XML 解析失败，文件可能损坏。')

  const paragraphs = Array.from(dom.getElementsByTagNameNS(W_NS, 'p'))
  const lines: string[] = []
  for (const p of paragraphs) {
    const ts = Array.from(p.getElementsByTagNameNS(W_NS, 't'))
    const text = ts.map((t) => t.textContent ?? '').join('')
    lines.push(text)
  }
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!out) {
    throw new Error(`DOCX "${fileName}" 中没有提取到任何文字。`)
  }
  return out
}

const extractDocxText = async (file: File): Promise<string> => {
  const zip = await loadDocxZip(file)
  return extractDocxTextFromZip(zip, file.name)
}

export const readWordDocumentStats = async (file: File): Promise<WordDocumentStats> => {
  const lower = file.name.toLowerCase()

  if (lower.endsWith('.pdf')) {
    throw new Error('不支持 PDF。此入口只用于 Word 文档页数/字数自动填表，请上传 .docx。')
  }

  if (lower.endsWith('.doc')) {
    throw new Error('旧版 .doc 无法在当前前端环境可靠解析页数/字数。请先另存为 .docx 后重试。')
  }

  if (!lower.endsWith('.docx')) {
    throw new Error('只支持 Word .docx 文档。PDF、旧版 .doc、图片和 Excel 暂不支持。')
  }

  if (file.size > PDF_DOCX_LIMIT) {
    throw new Error(
      `DOCX 过大（${(file.size / 1024 / 1024).toFixed(1)} MB）。建议拆分或另存精简版本（≤ 30 MB）。`,
    )
  }

  const zip = await loadDocxZip(file)
  let metadataPages: number | null = null
  let metadataWords: number | null = null
  const appFile = zip.file('docProps/app.xml')
  if (appFile) {
    const appXml = await appFile.async('string')
    const appDom = parseXml(appXml, 'DOCX 元数据 XML 解析失败，文件可能损坏。')
    metadataPages = firstTagNumber(appDom, ['Pages'])
    metadataWords = firstTagNumber(appDom, ['Words'])
  }

  const needsTextFallback = !metadataPages || !metadataWords
  const text = needsTextFallback ? await extractDocxTextFromZip(zip, file.name) : ''
  const textWordCount = text ? wordCountFromText(text) : 0

  return {
    fileName: file.name,
    pageCount: metadataPages ?? estimatePagesFromText(text),
    wordCount: metadataWords ?? textWordCount,
    pageSource: metadataPages ? 'metadata' : 'estimated',
    wordSource: metadataWords ? 'metadata' : 'text',
  }
}

// ---------------------------------------------------------------------------
// AI settings + chat client
// ---------------------------------------------------------------------------

const aiSettingsLocalKey = 'legalbiz-ai-settings'

const VALID_PROVIDERS = ['openai', 'deepseek', 'anthropic', 'doubao', 'custom'] as const

const sanitizeNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  if (value === null || value === undefined || value === '') return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

const normalizeAiSettings = (raw: Partial<AISettings> | null | undefined): AISettings => {
  const base = defaultAiSettings()
  if (!raw || typeof raw !== 'object') return base
  const providerRaw = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const provider = (VALID_PROVIDERS as readonly string[]).includes(providerRaw)
    ? (providerRaw as AISettings['provider'])
    : base.provider
  return {
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : base.apiKey,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : base.baseUrl,
    model: typeof raw.model === 'string' ? raw.model : base.model,
    temperature: sanitizeNumber(raw.temperature, base.temperature ?? 0.2, 0, 2),
    maxTokens: sanitizeNumber(raw.maxTokens, base.maxTokens ?? 2048, 64, 32000),
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : base.systemPrompt,
    timeoutSeconds: sanitizeNumber(raw.timeoutSeconds, base.timeoutSeconds ?? 60, 5, 600),
    // enabled 字段仅作派生属性，等价于"apiKey 是否非空"。
    // UI 上不再暴露 toggle —— 一旦填了 key 就视为启用。
    enabled: typeof raw.apiKey === 'string' && raw.apiKey.trim().length > 0,
  }
}

/** AI 是否已就绪：填了 apiKey 即可 */
export const isAiReady = (settings: AISettings): boolean =>
  typeof settings.apiKey === 'string' && settings.apiKey.trim().length > 0

export const loadAiSettings = async (): Promise<AISettings> => {
  if (isTauri()) {
    try {
      const raw = await invoke<Partial<AISettings>>('load_ai_settings')
      return normalizeAiSettings(raw)
    } catch {
      // fallthrough
    }
  }
  const local = localStorage.getItem(aiSettingsLocalKey)
  if (!local) return defaultAiSettings()
  try {
    return normalizeAiSettings(JSON.parse(local))
  } catch {
    return defaultAiSettings()
  }
}

export const saveAiSettings = async (settings: AISettings): Promise<void> => {
  localStorage.setItem(aiSettingsLocalKey, JSON.stringify(settings))
  if (isTauri()) {
    await invoke('save_ai_settings', { settings })
  }
}

export const getAiDefaultSystemPrompt = async (): Promise<string> => {
  if (isTauri()) {
    try {
      return await invoke<string>('ai_default_system_prompt')
    } catch {
      return ''
    }
  }
  return DEFAULT_AI_SYSTEM_PROMPT
}

export const DEFAULT_AI_SYSTEM_PROMPT = `你是法律业务管理系统的字段抽取助手。用户每次会给你"当前模块上下文 + 字段定义 + 待抽取文本"，请按字段定义从原文中精确抽取。

规则：
1) 严格输出 JSON：键为字段 key，值为字符串。
2) 没有抽取到的字段，请直接省略不要包含；不要写空字符串、不要写"未提供"。
3) 日期统一为 YYYY-MM-DD（不补全为不准确的日期）。
4) 金额输出纯数字，不带千分位逗号、不带"元"。
5) 当字段 type 是 single_select / multi_select 时，值必须**严格从 options 列表中选择**；如果原文没有匹配到任何 option，请省略该字段。
6) 不要捏造任何数据；若不确定，请省略。
7) 只输出 JSON，不要 markdown 代码块包裹，不要任何解释或说明文字。`

export const aiTestConnection = async (settings: AISettings): Promise<ChatResult> => {
  if (!isTauri()) {
    throw new Error('AI 连接测试仅在桌面 App 中可用，浏览器调试模式下无法发起跨域请求。')
  }
  return invoke<ChatResult>('ai_test', { settings })
}

export const aiChat = async (
  settings: AISettings,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<ChatResult> => {
  if (!isTauri()) {
    throw new Error('AI 调用仅在桌面 App 中可用。')
  }
  return invoke<ChatResult>('ai_chat', { settings, messages })
}

const tryExtractJsonObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim()
  // 直接解析
  try {
    const value = JSON.parse(trimmed)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    /* ignore */
  }
  // 提取 ```json ... ``` 块
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    try {
      const value = JSON.parse(fenced[1])
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      /* ignore */
    }
  }
  // 取第一个 {...} 平衡块
  const start = trimmed.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i]
      if (inString) {
        if (escape) {
          escape = false
        } else if (ch === '\\') {
          escape = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1)
          try {
            const value = JSON.parse(candidate)
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              return value as Record<string, unknown>
            }
          } catch {
            /* ignore */
          }
          break
        }
      }
    }
  }
  return null
}

/**
 * 拼装一次抽取请求的 system + user message。
 * 抽出来作为纯函数，让设置页能在不发请求的情况下"预览实际发送内容"。
 *
 * - system: 通用工作规则（用户自定义或默认 DEFAULT_AI_SYSTEM_PROMPT）。所有模块共用。
 * - user: 当前模块标签 + 字段 schema（按 key 严格列出，包含 type/options/required）+ 用户补充指引 + 原文。
 *   user message 在每次调用时根据 targetModule 动态拼出，因此天然适配每个页面的字段。
 */
export const buildExtractionMessages = (
  text: string,
  targetModule: ModuleKey,
  config: WorkspaceConfig,
  settings: AISettings,
  customPrompt?: string,
): { system: string; user: string } => {
  const definition = config.modules[targetModule]
  const schema = definition.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options ?? null,
    required: Boolean(field.required),
  }))

  const system = (settings.systemPrompt || '').trim() || DEFAULT_AI_SYSTEM_PROMPT

  const moduleHeader = `当前模块：${definition.label}（key=${definition.key}）\n模块说明：${definition.description}`
  const schemaJson = JSON.stringify(schema, null, 2)

  const userParts = [moduleHeader, '\n字段定义（请严格按 key 输出 JSON）：', schemaJson]
  if (targetModule === 'litigation') {
    userParts.push(
      '\n诉讼当事人抽取规则：client_name 只在原文明确出现“客户/委托人/我方客户”时填写；原告、被告、上诉人、被上诉人、申请人、被申请人等请优先分别填入 our_parties、opposing_parties、third_parties 和 party_position，最终由用户决定应用到哪个字段。',
    )
  }
  if (customPrompt && customPrompt.trim()) {
    userParts.push(`\n用户补充指引：\n${customPrompt.trim()}`)
  }
  userParts.push(
    text
      ? `\n待抽取文本：\n"""\n${text}\n"""`
      : '\n待抽取文本：\n"""\n（此处会插入用户在 AI 助手中粘贴/上传的文本）\n"""',
  )

  return { system, user: userParts.join('\n') }
}

export const extractWithAi = async (
  text: string,
  targetModule: ModuleKey,
  config: WorkspaceConfig,
  settings: AISettings,
  customPrompt?: string,
): Promise<ExtractionDraft> => {
  const definition = config.modules[targetModule]
  const { system, user } = buildExtractionMessages(text, targetModule, config, settings, customPrompt)

  const result = await aiChat(settings, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])

  const json = tryExtractJsonObject(result.content)
  if (!json) {
    return {
      targetModule,
      sourceKind: 'pasted_text',
      suggestions: [],
      unresolved: definition.fields.filter((f) => f.required).map((f) => f.label),
      rawResponse: result.content,
      notice: '未能从模型响应中解析出 JSON，请检查响应内容或换一个模型重试。',
    }
  }

  const suggestions: ExtractionDraft['suggestions'] = []
  for (const field of definition.fields) {
    const value = json[field.key]
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (!text) continue
    suggestions.push({
      fieldKey: field.key,
      label: field.label,
      value: text,
      confidence: 0.92,
      sourceExcerpt: '',
    })
  }
  const unresolved = definition.fields
    .filter((f) => f.required && !suggestions.some((s) => s.fieldKey === f.key))
    .map((f) => f.label)

  return {
    targetModule,
    sourceKind: 'pasted_text',
    suggestions,
    unresolved,
    rawResponse: result.content,
    notice:
      suggestions.length === 0
        ? '模型未从文本中识别出任何字段，可能是文本与本模块无关，或文本过短。'
        : `共识别 ${suggestions.length} 个字段。模型 ${result.provider}/${result.model}，耗时 ${result.latencyMs}ms。`,
  }
}

export const PROVIDER_LABELS = PROVIDER_PRESETS

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const ensureAttachmentsDir = async (
  workspacePath: string,
  recordPath: string,
): Promise<string> => {
  if (!isTauri()) return `demo://${recordPath}/attachments`
  return invoke<string>('record_attachments_dir', { workspacePath, recordPath })
}

export const listAttachments = async (
  workspacePath: string,
  recordPath: string,
): Promise<AttachmentEntry[]> => {
  if (!isTauri()) return []
  return invoke<AttachmentEntry[]>('list_attachments', { workspacePath, recordPath })
}

export const addAttachments = async (
  workspacePath: string,
  recordPath: string,
  srcPaths: string[],
): Promise<string[]> => {
  if (!isTauri()) throw new Error('附件管理仅在桌面 App 中可用。')
  return invoke<string[]>('add_attachments', { workspacePath, recordPath, srcPaths })
}

export const deleteAttachment = async (
  workspacePath: string,
  recordPath: string,
  name: string,
): Promise<void> => {
  if (!isTauri()) throw new Error('附件管理仅在桌面 App 中可用。')
  await invoke('delete_attachment', { workspacePath, recordPath, name })
}

export const openInFinder = async (path: string): Promise<void> => {
  if (!isTauri()) return
  await invoke('open_path_in_finder', { path })
}

export const pickFilesToAttach = async (): Promise<string[]> => {
  if (!isTauri()) return []
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({ multiple: true, directory: false, title: '选择要添加的附件' })
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}
