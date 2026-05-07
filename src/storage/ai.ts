import { invoke } from '@tauri-apps/api/core'
import type {
  AISettings,
  ChatResult,
  ExtractionDraft,
  ModuleKey,
  WorkspaceConfig,
} from '../domain'
import { defaultAiSettings, PROVIDER_PRESETS } from '../domain'
import { isTauri } from './app-state'

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
      '\n诉讼当事人抽取规则：client_name 只在原文明确出现"客户/委托人/我方客户"时填写；原告、被告、上诉人、被上诉人、申请人、被申请人等请优先分别填入 our_parties、opposing_parties、third_parties 和 party_position，最终由用户决定应用到哪个字段。',
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
    const str = String(value).trim()
    if (!str) continue
    suggestions.push({
      fieldKey: field.key,
      label: field.label,
      value: str,
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
