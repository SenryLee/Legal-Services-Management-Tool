import { invoke } from '@tauri-apps/api/core'
import {
  defaultConfig,
  type ModuleKey,
  type RecordSummary,
  type WorkspaceConfig,
  type WorkspaceSnapshot,
} from '../domain'
import { isTauri, rememberWorkspace, safeParse } from './app-state'

const demoKey = 'legalbiz-demo-workspace'

// ---------------------------------------------------------------------------
// Browser demo snapshot — 浏览器模式下的演示数据
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

export const loadDemo = (path: string): WorkspaceSnapshot => {
  const raw = localStorage.getItem(demoKey)
  const parsed = safeParse<WorkspaceSnapshot | null>(raw, null)
  if (!parsed) {
    const seeded = browserDemoSnapshot(path)
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

export const saveDemo = (snapshot: WorkspaceSnapshot) => {
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
