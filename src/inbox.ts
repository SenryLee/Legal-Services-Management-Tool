import { invoke } from '@tauri-apps/api/core'
import { isTauri, readFileAsText, aiChat, isAiReady, createRecord, buildExtractionMessages } from './storage'
import {
  MODULE_ORDER,
  type AISettings,
  type ClassifyResult,
  type FieldDefinition,
  type ExtractFieldResult,
  type InboxEntry,
  type InboxPipeline,
  type InboxSuggestion,
  type MatchResult,
  type ModuleKey,
  type RecordSummary,
  type WorkspaceConfig,
  type WorkspaceSnapshot,
} from './domain'

// ---------------------------------------------------------------------------
// localStorage keys (browser demo fallback)
// ---------------------------------------------------------------------------

const inboxKey = 'legalbiz-inbox-entries'

const safeParse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const loadInboxEntries = (): InboxEntry[] =>
  safeParse<InboxEntry[]>(localStorage.getItem(inboxKey), [])

const saveInboxEntries = (entries: InboxEntry[]) => {
  localStorage.setItem(inboxKey, JSON.stringify(entries))
}

const inboxEntryKey = (entry: InboxEntry): string => {
  const hash = entry.sourceFile.contentHash?.trim()
  if (hash) return `hash:${hash}`
  return `file:${entry.sourceFile.originalName}:${entry.sourceFile.sizeBytes}`
}

export const mergeInboxEntries = (...groups: InboxEntry[][]): InboxEntry[] => {
  const byKey = new Map<string, InboxEntry>()
  for (const entry of groups.flat()) {
    const key = inboxEntryKey(entry)
    const existing = byKey.get(key)
    if (!existing || entry.createdAt > existing.createdAt) {
      byKey.set(key, entry)
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let inboxSeq = Date.now() % 10000

const nextInboxId = (): string => {
  inboxSeq += 1
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `INB-${y}${m}${d}-${String(inboxSeq).padStart(4, '0')}`
}

// ---------------------------------------------------------------------------
// Import files into inbox (by File objects — file picker / browser demo)
// ---------------------------------------------------------------------------

export const importFiles = async (
  workspacePath: string,
  files: File[],
): Promise<InboxEntry[]> => {
  if (isTauri()) {
    // Tauri 模式：读取文件字节，通过 base64 传给 Rust 创建条目
    const results: InboxEntry[] = []
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        // 手动 base64 编码
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        const base64 = btoa(binary)
        const entry = await invoke<InboxEntry>('inbox_import_from_bytes', {
          workspacePath,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileBytesBase64: base64,
        })
        results.push(entry)
      } catch (err) {
        console.error(`导入文件失败 ${file.name}:`, err)
      }
    }
    return results
  }

  // Browser demo mode
  const entries = loadInboxEntries()
  const newEntries = files.map((file) => buildLocalEntry(file))
  const updated = mergeInboxEntries(newEntries, entries)
  saveInboxEntries(updated)
  return newEntries
}

// ---------------------------------------------------------------------------
// Import files into inbox (by file paths — Tauri drag-drop)
// ---------------------------------------------------------------------------

export const importFilesByPath = async (
  workspacePath: string,
  filePaths: string[],
): Promise<InboxEntry[]> => {
  if (isTauri()) {
    const results: InboxEntry[] = []
    for (const filePath of filePaths) {
      try {
        const entry = await invoke<InboxEntry>('inbox_import_file_by_path', {
          workspacePath,
          sourcePath: filePath,
        })
        results.push(entry)
      } catch (err) {
        console.error(`导入文件失败 ${filePath}:`, err)
      }
    }
    return results
  }

  // Browser fallback (shouldn't happen)
  return []
}

const buildLocalEntry = (file: File): InboxEntry => {
  const id = nextInboxId()
  return {
    id,
    createdAt: new Date().toISOString(),
    sourceFile: {
      originalName: file.name,
      storedPath: `inbox/sources/${id}/${file.name}`,
      sizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
    },
    pipeline: null,
    userDecision: 'pending',
  }
}

// ---------------------------------------------------------------------------
// AI Pipeline — 4 stages
// ---------------------------------------------------------------------------

export const runPipeline = async (
  workspacePath: string,
  entry: InboxEntry,
  allRecords: RecordSummary[],
  config: WorkspaceConfig,
  settings: AISettings,
): Promise<InboxEntry> => {
  // Read file text content — 根据文件类型选择读取方式
  let text: string
  try {
    const name = entry.sourceFile.originalName.toLowerCase()
    const isPdfOrDocx = name.endsWith('.pdf') || name.endsWith('.docx')
    const isPlainText = name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.json') || name.endsWith('.log')

    if (isTauri()) {
      if (isPdfOrDocx) {
        // PDF/DOCX: 读取 base64 字节，创建 File 对象，用前端的 readFileAsText 处理
        const base64 = await invoke<string>('inbox_read_file_base64', {
          storedPath: entry.sourceFile.storedPath,
        })
        const binaryStr = atob(base64)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i)
        }
        const file = new File([bytes], entry.sourceFile.originalName, {
          type: entry.sourceFile.mimeType,
        })
        text = await readFileAsText(file)
      } else if (isPlainText) {
        // 纯文本: 直接读取
        text = await invoke<string>('inbox_read_file_text', {
          storedPath: entry.sourceFile.storedPath,
        })
      } else {
        // 其他格式: 尝试 base64 后作为文本处理
        const base64 = await invoke<string>('inbox_read_file_base64', {
          storedPath: entry.sourceFile.storedPath,
        })
        const binaryStr = atob(base64)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i)
        }
        const file = new File([bytes], entry.sourceFile.originalName, {
          type: entry.sourceFile.mimeType,
        })
        text = await readFileAsText(file)
      }
    } else {
      text = `[浏览器演示模式] 文件: ${entry.sourceFile.originalName}, 大小: ${entry.sourceFile.sizeBytes} 字节`
    }
  } catch (err) {
    text = `[文件读取失败: ${String(err)}] 文件: ${entry.sourceFile.originalName}`
  }

  // Stage 1: Classify
  const classify = await classifyDocument(text, entry.sourceFile.originalName, config, settings)

  // Stage 2: Extract fields
  const extract = await extractFields(text, classify.targetModule, config, settings)

  // Stage 3: Match records (LOCAL, no AI)
  const fieldValues: Record<string, string> = {}
  for (const [key, result] of Object.entries(extract.fields)) {
    fieldValues[key] = result.value
  }
  const match = matchRecords(fieldValues, allRecords, classify.targetModule)

  // Stage 4: Generate suggestion
  const suggest = await generateSuggestion(classify, extract, match, settings)

  const pipeline: InboxPipeline = { classify, extract, match, suggest }
  const updated: InboxEntry = { ...entry, pipeline }

  // Persist
  if (isTauri()) {
    try {
      await invoke('inbox_update_pipeline', {
        workspacePath,
        inboxId: entry.id,
        pipeline,
      })
    } catch {
      // Ignore — pipeline result is returned directly
    }
  } else {
    const entries = loadInboxEntries()
    const idx = entries.findIndex((e) => e.id === entry.id)
    if (idx >= 0) {
      entries[idx] = updated
      saveInboxEntries(entries)
    }
  }

  return updated
}

// ---------------------------------------------------------------------------
// Stage 1: Classify
// ---------------------------------------------------------------------------

const classifyDocument = async (
  text: string,
  fileName: string,
  config: WorkspaceConfig,
  settings: AISettings,
): Promise<ClassifyResult> => {
  const localGuess = classifyDocumentLocally(text, fileName)
  if (!isAiReady(settings)) {
    return localGuess
  }

  const moduleBriefs = MODULE_ORDER.map((key) => {
    const module = config.modules[key]
    const required = module.fields.filter((field) => field.required).map((field) => field.label).join('、') || '无'
    const fieldLabels = module.fields.map((field) => field.label).join('、')
    return `- ${key}（${module.label}）：${module.description}；关键字段：${fieldLabels}；必填字段：${required}`
  }).join('\n')

  const prompt = `你是法律文书分类助手。请根据以下文本内容判断文档类型和所属业务模块。

文件名：${fileName}

可选模块（只能选择一个 targetModule）：
${moduleBriefs}

分类规则：
- 诉状、裁判文书、传票、举证通知、案号、法院/仲裁机构、开庭信息，通常归入 litigation。
- 法律服务合同、委托合同、常年顾问合同、合同编号、服务范围、签署日期，通常归入 service_contract。
- 发票、开票、收款、应收、发票号，通常归入 invoice。
- 利益冲突/利冲检查、拟委托人、相对方核查，通常归入 conflict_check。
- 单独的开庭、会议、期限、交付、跟进安排，通常归入 calendar_event。
- 合同审查、法律咨询、尽调、合规整改、函件起草等项目材料，通常归入 non_litigation。
- 客户建档资料、联系人、关联方、历史相对方，通常归入 client。

请严格输出 JSON：
{
  "documentType": "文档类型描述",
  "targetModule": "模块key",
  "confidence": 0.0~1.0,
  "reasoning": "判断依据"
}

文本内容：
"""
${text.slice(0, 10000)}
"""`

  try {
    const result = await aiChat(settings, [
      { role: 'system', content: '你是法律文书分类助手，只输出 JSON。' },
      { role: 'user', content: prompt },
    ])
    const json = tryExtractJsonObject(result.content)
    if (json) {
      const targetModule = isModuleKey(json.targetModule) ? json.targetModule : localGuess.targetModule
      return {
        documentType: String(json.documentType ?? '未知'),
        targetModule,
        confidence: sanitizeConfidence(json.confidence, localGuess.confidence),
        reasoning: String(json.reasoning ?? localGuess.reasoning),
      }
    }
  } catch {
    // Fall through to default
  }

  return {
    ...localGuess,
    confidence: Math.min(localGuess.confidence, 0.65),
    reasoning: `AI 分类失败，使用本地规则：${localGuess.reasoning}`,
  }
}

const isModuleKey = (value: unknown): value is ModuleKey =>
  typeof value === 'string' && MODULE_ORDER.includes(value as ModuleKey)

const sanitizeConfidence = (value: unknown, fallback: number): number => {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.max(0, Math.min(1, numberValue))
}

const classifyDocumentLocally = (text: string, fileName: string): ClassifyResult => {
  const haystack = `${fileName}\n${text}`.toLowerCase()
  const has = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(haystack))

  if (has([/案号|法院|仲裁委|开庭|传票|举证通知|应诉通知|起诉状|答辩状|判决书|裁定书|民初|民终|执恢|执行异议/])) {
    return { documentType: '诉讼/仲裁材料', targetModule: 'litigation', confidence: 0.72, reasoning: '命中案号、法院、开庭或诉讼文书关键词。' }
  }
  if (has([/法律服务合同|委托合同|常年顾问|合同编号|服务范围|签署日期|律师费|顾问费/])) {
    return { documentType: '服务合同材料', targetModule: 'service_contract', confidence: 0.68, reasoning: '命中合同编号、服务范围、签署日期或法律服务合同关键词。' }
  }
  if (has([/发票|开票|应收|已收|收款|invoice|发票号|税号/])) {
    return { documentType: '开票/收款材料', targetModule: 'invoice', confidence: 0.66, reasoning: '命中发票、开票、收款或应收关键词。' }
  }
  if (has([/利益冲突|利冲|冲突检查|拟委托人|相对方核查/])) {
    return { documentType: '利益冲突检查材料', targetModule: 'conflict_check', confidence: 0.66, reasoning: '命中利益冲突检查关键词。' }
  }
  if (has([/会议|期限|截止|交付|跟进|日程|提醒|待办/])) {
    return { documentType: '日程/任务材料', targetModule: 'calendar_event', confidence: 0.58, reasoning: '命中日程、期限、交付或待办关键词。' }
  }
  if (has([/客户名称|联系人|关联方|历史相对方|客户类型/])) {
    return { documentType: '客户资料', targetModule: 'client', confidence: 0.58, reasoning: '命中客户资料字段关键词。' }
  }
  return { documentType: '非诉业务材料', targetModule: 'non_litigation', confidence: 0.45, reasoning: '未命中更具体模块，默认作为非诉业务材料处理。' }
}

// ---------------------------------------------------------------------------
// Stage 2: Extract fields
// ---------------------------------------------------------------------------

const extractFields = async (
  text: string,
  targetModule: ModuleKey,
  config: WorkspaceConfig,
  settings: AISettings,
): Promise<{ fields: Record<string, ExtractFieldResult>; unresolved: string[] }> => {
  const definition = config.modules[targetModule]
  if (!definition) {
    return { fields: {}, unresolved: ['未知模块，无法抽取字段'] }
  }
  if (!isAiReady(settings)) {
    return { fields: {}, unresolved: ['AI 未配置，无法抽取字段'] }
  }

  const fields: Record<string, ExtractFieldResult> = {}
  const unresolved: string[] = []
  const customPrompt = [
    '这是智能收件箱自动分流后的字段抽取，请只抽取当前模块字段。',
    'title/name 应尽量使用文书标题、合同名称、案件名称、客户名称或事项名称。',
    '如果文本是诉讼/仲裁材料，不要把原告/被告随意写入 client_name；client_name 只在原文明确写明客户/委托人时填写。',
    '字段不存在或无法确定时直接省略，不要输出“无”“未载明”“不详”。',
  ].join('\n')
  const { system, user } = buildExtractionMessages(text.slice(0, 16000), targetModule, config, settings, customPrompt)

  try {
    const result = await aiChat(settings, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])
    const json = tryExtractJsonObject(result.content)
    if (!json) {
      unresolved.push(...definition.fields.filter((field) => field.required).map((field) => field.key))
    } else {
      for (const fieldDef of definition.fields) {
        const rawValue = json[fieldDef.key]
        const normalized = coerceExtractedValue(rawValue, fieldDef)
        if (normalized) {
          fields[fieldDef.key] = normalized
        } else if (fieldDef.required) {
          unresolved.push(fieldDef.key)
        }
      }
    }
  } catch {
    unresolved.push(...definition.fields.filter((field) => field.required).map((field) => field.key))
  }

  return { fields, unresolved }
}

const coerceExtractedValue = (
  rawValue: unknown,
  field: FieldDefinition,
): ExtractFieldResult | null => {
  if (rawValue === undefined || rawValue === null) return null

  let sourceExcerpt = ''
  let confidence = 0.9
  let value: unknown = rawValue
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    const objectValue = rawValue as Record<string, unknown>
    value = objectValue.value ?? objectValue.text ?? objectValue.content
    sourceExcerpt = String(objectValue.sourceExcerpt ?? objectValue.source ?? '')
    confidence = sanitizeConfidence(objectValue.confidence, confidence)
  }

  const text = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).join('、')
    : String(value ?? '').trim()
  if (!text || ['无', '暂无', '未提供', '未载明', '不详', 'null', 'undefined'].includes(text.toLowerCase())) {
    return null
  }

  if (field.options?.length) {
    const exact = field.options.find((option) => option === text)
    const matched = exact ?? fuzzyMatchOption(text, field.options)
    if (!matched) return null
    return { value: matched, confidence, sourceExcerpt }
  }

  return { value: text, confidence, sourceExcerpt }
}

// ---------------------------------------------------------------------------
// Stage 3: Match records (LOCAL, no AI)
// ---------------------------------------------------------------------------

export const matchRecords = (
  extractedFields: Record<string, string>,
  allRecords: RecordSummary[],
  targetModule: ModuleKey,
): MatchResult => {
  const caseNumber = extractedFields.case_number ?? extractedFields.case_no ?? ''
  const contractNo = extractedFields.contract_no ?? ''
  const clientName = extractedFields.client_name ?? extractedFields.name ?? ''
  const opposingParties = extractedFields.opposing_parties ?? ''
  const title = extractedFields.title ?? extractedFields.name ?? ''
  const sameModuleRecords = allRecords.filter((record) => record.module === targetModule)

  // Exact match on case_number or contract_no
  if (caseNumber) {
    const normalizedCaseNumber = normalizeIdentifier(caseNumber)
    for (const record of sameModuleRecords) {
      const recordCaseNo = String(record.fields.case_number ?? '')
      if (recordCaseNo && normalizeIdentifier(recordCaseNo) === normalizedCaseNumber) {
        return {
          matchType: 'existing',
          existingRecord: {
            id: record.id,
            module: record.module,
            title: record.title,
            matchScore: 1.0,
            matchReason: `案号完全匹配：${caseNumber}`,
          },
        }
      }
    }
  }

  if (contractNo) {
    const normalizedContractNo = normalizeIdentifier(contractNo)
    for (const record of sameModuleRecords) {
      const recordContractNo = String(record.fields.contract_no ?? '')
      if (recordContractNo && normalizeIdentifier(recordContractNo) === normalizedContractNo) {
        return {
          matchType: 'existing',
          existingRecord: {
            id: record.id,
            module: record.module,
            title: record.title,
            matchScore: 1.0,
            matchReason: `合同编号完全匹配：${contractNo}`,
          },
        }
      }
    }
  }

  // Fuzzy match on client_name + opposing_parties
  let bestMatch: MatchResult['existingRecord'] | undefined

  for (const record of sameModuleRecords) {
    let score = 0
    const reasons: string[] = []

    if (clientName) {
      const recordClient = String(record.fields.client_name ?? record.fields.name ?? '')
      if (recordClient && fuzzyIncludes(clientName, recordClient)) {
        score += 0.4
        reasons.push(`客户名称匹配：${clientName}`)
      }
    }

    if (opposingParties) {
      const recordOpposing = String(record.fields.opposing_parties ?? '')
      if (recordOpposing && fuzzyIncludes(opposingParties, recordOpposing)) {
        score += 0.3
        reasons.push(`对方当事人匹配：${opposingParties}`)
      }
    }

    if (title) {
      if (record.title && fuzzyIncludes(title, record.title)) {
        score += 0.2
        reasons.push(`标题相似：${record.title}`)
      }
    }

    if (score > 0.5 && (!bestMatch || score > bestMatch.matchScore)) {
      bestMatch = {
        id: record.id,
        module: record.module,
        title: record.title,
        matchScore: score,
        matchReason: reasons.join('；'),
      }
    }
  }

  // Conflict warning: check if opposing parties match existing clients
  const conflictWarning = buildConflictWarning(extractedFields, allRecords)

  if (bestMatch) {
    return {
      matchType: 'existing',
      existingRecord: bestMatch,
      conflictWarning,
    }
  }

  return {
    matchType: 'new',
    conflictWarning,
  }
}

const normalizeIdentifier = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[（）]/g, (match) => (match === '（' ? '(' : ')'))
    .replace(/[\s\-_/\\]+/g, '')

const fuzzyIncludes = (needle: string, haystack: string): boolean => {
  const n = needle.toLowerCase().trim()
  const h = haystack.toLowerCase().trim()
  if (!n || !h) return false
  if (h.includes(n) || n.includes(h)) return true
  // Simple character overlap: >= 60% of needle chars appear in haystack
  const needleChars = new Set(n.replace(/\s/g, ''))
  let matched = 0
  for (const ch of needleChars) {
    if (h.includes(ch)) matched += 1
  }
  return matched / needleChars.size >= 0.6
}

const buildConflictWarning = (
  fields: Record<string, string>,
  allRecords: RecordSummary[],
): MatchResult['conflictWarning'] => {
  const opposingParties = splitParties(fields.opposing_parties ?? '')
  if (opposingParties.length === 0) return undefined

  const clientRecords = allRecords.filter((r) => r.module === 'client')
  const matchedClients: string[] = []

  for (const party of opposingParties) {
    for (const client of clientRecords) {
      const clientName = String(client.fields.name ?? '')
      if (clientName && fuzzyIncludes(party, clientName)) {
        matchedClients.push(clientName)
      }
    }
  }

  if (matchedClients.length === 0) return undefined

  return {
    suspectedParties: opposingParties,
    existingClients: [...new Set(matchedClients)],
    recommendation: `对方当事人中包含现有客户（${[...new Set(matchedClients)].join('、')}），建议进行利益冲突检查。`,
  }
}

const splitParties = (text: string): string[] => {
  if (!text) return []
  return text
    .split(/[,，、；;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// 从文本中模糊匹配最接近的选项值
const fuzzyMatchOption = (text: string, options: string[]): string | null => {
  const t = text.toLowerCase()
  // 精确包含
  for (const opt of options) {
    if (t.includes(opt.toLowerCase())) return opt
  }
  // 关键词匹配
  const keywords: Record<string, string> = {
    '原告': '原告', '被告': '被告', '上诉': '上诉人', '被上诉': '被上诉人',
    '申请执行': '执行申请人', '被执行人': '被执行人',
    '一审': '一审', '二审': '二审', '再审': '再审', '执行': '执行',
    '仲裁': '仲裁', '调解': '诉前调解', '保全': '保全', '破产': '破产',
    '合同审查': '合同审查', '法律咨询': '法律咨询', '专项服务': '专项服务',
    '开庭': '开庭', '会议': '会议', '期限': '期限', '交付': '交付',
    '个人': '个人', '公司': '公司',
    '未开票': '未开票', '已开票': '已开票', '部分开票': '部分开票',
    '履行中': '履行中', '已完成': '已完成', '已终止': '已终止',
    '待处理': '待处理', '办理中': '办理中', '已交付': '已交付',
    '未安排': '未安排', '已开庭': '已开庭', '已排期': '已排期未开庭',
    '评估中': '评估中', '待立案': '待立案', '已立案': '已立案',
    '已判决': '已判决/裁决', '已结案': '已结案', '归档': '归档',
  }
  for (const [kw, opt] of Object.entries(keywords)) {
    if (t.includes(kw) && options.includes(opt)) return opt
  }
  return null
}

// ---------------------------------------------------------------------------
// Stage 4: Generate suggestion
// ---------------------------------------------------------------------------

const generateSuggestion = async (
  classify: ClassifyResult,
  extract: { fields: Record<string, ExtractFieldResult>; unresolved: string[] },
  match: MatchResult,
  settings: AISettings,
): Promise<InboxSuggestion> => {
  if (!isAiReady(settings)) {
    return buildFallbackSuggestion(classify, extract, match)
  }

  const fieldsSummary = Object.entries(extract.fields)
    .map(([k, v]) => `  ${k}: ${v.value} (置信度: ${v.confidence})`)
    .join('\n')

  const matchSummary =
    match.matchType === 'existing'
      ? `已匹配到现有记录：${match.existingRecord?.title}（${match.existingRecord?.id}，匹配度: ${match.existingRecord?.matchScore}）`
      : '未匹配到现有记录。'

  const conflictSummary = match.conflictWarning
    ? `利冲警告：${match.conflictWarning.recommendation}`
    : ''

  const prompt = `你是法律业务助手。根据以下分析结果，建议下一步操作。

文档分类：${classify.documentType}（模块: ${classify.targetModule}，置信度: ${classify.confidence}）

已抽取字段：
${fieldsSummary || '（无）'}

未抽取字段：${extract.unresolved.join(', ') || '（无）'}

记录匹配：${matchSummary}
${conflictSummary}

请输出 JSON：
{
  "action": "create_new | attach_to_existing | create_note",
  "targetModule": "模块key",
  "existingRecordId": "如果有匹配则填，否则省略",
  "suggestedFields": { "key": "value" },
  "suggestedBody": "建议的正文内容",
  "conflictWarning": "如果有冲突警告则填，否则省略",
  "confidence": 0.0~1.0,
  "reasoning": "建议理由"
}`

  try {
    const result = await aiChat(settings, [
      { role: 'system', content: '你是法律业务助手，只输出 JSON。' },
      { role: 'user', content: prompt },
    ])
    const json = tryExtractJsonObject(result.content)
    if (json) {
      const fallbackFields = extractFieldsToRecord(extract)
      const rawSuggestedFields =
        json.suggestedFields && typeof json.suggestedFields === 'object' && !Array.isArray(json.suggestedFields)
          ? Object.fromEntries(
              Object.entries(json.suggestedFields as Record<string, unknown>)
                .map(([key, value]) => [key, String(value ?? '').trim()])
                .filter(([, value]) => value),
            )
          : fallbackFields
      const matchedRecord = match.existingRecord
      const action = matchedRecord
        ? 'attach_to_existing'
        : normalizeSuggestionAction(json.action)
      return {
        action,
        targetModule: matchedRecord?.module ?? classify.targetModule,
        existingRecordId: matchedRecord?.id,
        suggestedFields: Object.keys(rawSuggestedFields).length > 0 ? rawSuggestedFields : fallbackFields,
        suggestedBody: String(json.suggestedBody ?? ''),
        conflictWarning: json.conflictWarning ? String(json.conflictWarning) : undefined,
        confidence: Number(json.confidence ?? 0.5),
        reasoning: String(json.reasoning ?? ''),
      }
    }
  } catch {
    // Fall through
  }

  return buildFallbackSuggestion(classify, extract, match)
}

const extractFieldsToRecord = (
  extract: { fields: Record<string, ExtractFieldResult>; unresolved: string[] },
): Record<string, string> =>
  Object.fromEntries(Object.entries(extract.fields).map(([key, result]) => [key, result.value]))

const normalizeSuggestionAction = (value: unknown): InboxSuggestion['action'] => {
  if (value === 'attach_to_existing' || value === 'create_note') return value
  return 'create_new'
}

const buildFallbackSuggestion = (
  classify: ClassifyResult,
  extract: { fields: Record<string, ExtractFieldResult>; unresolved: string[] },
  match: MatchResult,
): InboxSuggestion => {
  const suggestedFields = extractFieldsToRecord(extract)

  const action: InboxSuggestion['action'] =
    match.matchType === 'existing' ? 'attach_to_existing' : 'create_new'

  return {
    action,
    targetModule: classify.targetModule,
    existingRecordId: match.existingRecord?.id,
    suggestedFields,
    suggestedBody: '',
    conflictWarning: match.conflictWarning?.recommendation,
    confidence: classify.confidence * 0.8,
    reasoning:
      match.matchType === 'existing'
        ? `匹配到现有记录 "${match.existingRecord?.title}"，建议关联。`
        : '未匹配到现有记录，建议创建新记录。',
  }
}

// ---------------------------------------------------------------------------
// Confirm / Skip actions
// ---------------------------------------------------------------------------

export const confirmCreate = async (
  workspacePath: string,
  inboxId: string,
  moduleKey: string,
  fields: Record<string, string>,
  body: string,
): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    return invoke<WorkspaceSnapshot>('inbox_confirm_create', {
      workspacePath,
      inboxId,
      moduleKey,
      fields,
      body,
    })
  }

  markEntryStatusLocal(inboxId, 'confirmed')
  return createRecord(workspacePath, moduleKey as ModuleKey, fields, body)
}

export const confirmAttach = async (
  workspacePath: string,
  inboxId: string,
  targetRecordId: string,
  targetModule: string,
): Promise<WorkspaceSnapshot> => {
  if (isTauri()) {
    return invoke<WorkspaceSnapshot>('inbox_confirm_attach', {
      workspacePath,
      inboxId,
      targetRecordId,
      targetModule,
    })
  }

  // Browser demo: reload workspace (attachment is conceptual in demo mode)
  markEntryStatusLocal(inboxId, 'confirmed')
  const { openWorkspace } = await import('./storage')
  return openWorkspace(workspacePath)
}

export const skipEntry = async (
  workspacePath: string,
  inboxId: string,
): Promise<void> => {
  if (isTauri()) {
    await invoke('inbox_skip', { workspacePath, inboxId })
    return
  }
  markEntryStatusLocal(inboxId, 'skipped')
}

const markEntryStatusLocal = (
  inboxId: string,
  status: 'confirmed' | 'skipped',
): void => {
  const entries = loadInboxEntries()
  const idx = entries.findIndex((e) => e.id === inboxId)
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], userDecision: status }
    saveInboxEntries(entries)
  }
}

// ---------------------------------------------------------------------------
// List entries
// ---------------------------------------------------------------------------

export const listPending = async (workspacePath: string): Promise<InboxEntry[]> => {
  if (isTauri()) {
    try {
      return mergeInboxEntries(await invoke<InboxEntry[]>('inbox_list_pending', { workspacePath }))
    } catch {
      // Fall through to localStorage
    }
  }

  return mergeInboxEntries(loadInboxEntries().filter((e) => e.userDecision === 'pending'))
}

export const listProcessed = async (
  workspacePath: string,
  month: string,
): Promise<InboxEntry[]> => {
  if (isTauri()) {
    try {
      return mergeInboxEntries(await invoke<InboxEntry[]>('inbox_list_processed', { workspacePath, month }))
    } catch {
      // Fall through
    }
  }

  return mergeInboxEntries(loadInboxEntries().filter((e) => {
    if (e.userDecision === 'pending') return false
    if (month && !e.createdAt.startsWith(month)) return false
    return true
  }))
}

// ---------------------------------------------------------------------------
// Clear all pending entries
// ---------------------------------------------------------------------------

export const clearAll = async (workspacePath: string): Promise<void> => {
  if (isTauri()) {
    await invoke('inbox_clear_all', { workspacePath })
    return
  }
  saveInboxEntries([])
}

// ---------------------------------------------------------------------------
// JSON extraction helper (same pattern as storage.ts)
// ---------------------------------------------------------------------------

const tryExtractJsonObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim()
  try {
    const value = JSON.parse(trimmed)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    /* ignore */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    try {
      const value = JSON.parse(fenced[1])
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      /* ignore */
    }
  }
  const start = trimmed.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i]
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth += 1
      if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const value = JSON.parse(trimmed.slice(start, i + 1))
            if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
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
