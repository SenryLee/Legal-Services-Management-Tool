import { invoke } from '@tauri-apps/api/core'
import Docxtemplater from 'docxtemplater'
import { aiChat } from './ai'
import { isTauri, safeParse } from './app-state'
import type { AISettings } from '../domain'
import { FREE_DRAFT_SYSTEM_PROMPT, TEMPLATE_DRAFT_SYSTEM_PROMPT } from './drafting-logic'

export { FREE_DRAFT_SYSTEM_PROMPT, TEMPLATE_DRAFT_SYSTEM_PROMPT }

type JSZipModule = typeof import('jszip')

const loadJSZip = async (): Promise<JSZipModule> => {
  const mod = (await import('jszip')) as unknown as JSZipModule | { default: JSZipModule }
  return (mod as { default?: JSZipModule }).default ?? (mod as JSZipModule)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateVariable {
  placeholder: string
  label: string
  type: 'text' | 'date' | 'money' | 'number' | 'long_text'
  example?: string
  description?: string
}

export interface TemplateMetadata {
  id: string
  title: string
  description: string
  variables: TemplateVariable[]
  originalFilename: string
  createdAt: string
  category?: string
  status?: TemplateStatus
  supportsFreeDraft?: boolean
  updatedAt?: string
}

export type TemplateStatus = 'ready' | 'new' | 'needs_conversion'

export interface TemplateListItem {
  id: string
  title: string
  description: string
  variableCount: number
  originalFilename: string
  createdAt: string
  category?: string
  docxPath: string
  metaPath: string
  status?: TemplateStatus
  supportsFreeDraft?: boolean
}

export interface VariableDetectionResult {
  title: string
  description: string
  category: string
  variables: TemplateVariable[]
  rawResponse?: string
}

export interface TemplateSyncResult {
  added: number
  updated: number
  incompatible: number
  templateDir: string
  templates: TemplateListItem[]
}

interface BrowserTemplateEntry {
  item: TemplateListItem
  metadata: TemplateMetadata
}

const browserTemplatesKey = (workspacePath: string): string =>
  `legalbiz-drafting-templates:${workspacePath || 'demo'}`

const browserDocxKey = (storedPath: string): string =>
  `legalbiz-drafting-docx:${storedPath}`

const browserMetaKey = (storedPath: string): string =>
  `legalbiz-drafting-meta:${storedPath}`

const readBrowserTemplateEntries = (workspacePath: string): BrowserTemplateEntry[] =>
  safeParse<BrowserTemplateEntry[]>(localStorage.getItem(browserTemplatesKey(workspacePath)), [])

const writeBrowserTemplateEntries = (workspacePath: string, entries: BrowserTemplateEntry[]): void => {
  localStorage.setItem(browserTemplatesKey(workspacePath), JSON.stringify(entries))
}

const toTemplateListItem = (metadata: TemplateMetadata, workspacePath: string): TemplateListItem => {
  const id = metadata.id || `template-${Date.now()}`
  return {
    id,
    title: metadata.title || '未命名模板',
    description: metadata.description || '',
    variableCount: metadata.variables?.length ?? 0,
    originalFilename: metadata.originalFilename || 'template.docx',
    createdAt: metadata.createdAt || new Date().toISOString(),
    category: metadata.category,
    docxPath: `demo://drafting/${encodeURIComponent(workspacePath || 'demo')}/${id}.docx`,
    metaPath: `demo://drafting/${encodeURIComponent(workspacePath || 'demo')}/${id}.json`,
    status: metadata.status || (metadata.variables?.length ? 'ready' : 'needs_conversion'),
    supportsFreeDraft: metadata.supportsFreeDraft || metadata.variables?.some((item) => item.placeholder === 'draft_body'),
  }
}

// ---------------------------------------------------------------------------
// Rust command wrappers
// ---------------------------------------------------------------------------

export const readDocxBase64 = async (path: string): Promise<string> => {
  if (!isTauri()) {
    const base64 = localStorage.getItem(browserDocxKey(path))
    if (!base64) throw new Error('浏览器演示模式未找到该模板文件。')
    return base64
  }
  return invoke<string>('drafting_read_docx', { path })
}

export const saveDocx = async (path: string, base64Data: string): Promise<void> => {
  if (!isTauri()) {
    localStorage.setItem(browserDocxKey(path), base64Data)
    return
  }
  await invoke('drafting_save_docx', { path, base64Data })
}

export const listTemplates = async (workspacePath: string): Promise<TemplateListItem[]> => {
  if (!isTauri()) {
    return readBrowserTemplateEntries(workspacePath).map((entry) => entry.item)
  }
  return invoke<TemplateListItem[]>('drafting_list_templates', { workspacePath })
}

export const getTemplateDir = async (workspacePath: string): Promise<string> => {
  if (!isTauri()) return `demo://${workspacePath || 'demo'}/.legalbiz/templates/docx`
  return invoke<string>('drafting_get_template_dir', { workspacePath })
}

export const importTemplateFile = async (
  workspacePath: string,
  sourcePath: string,
): Promise<string> => {
  if (!isTauri()) throw new Error('导入模板文件仅在桌面 App 中可用。')
  return invoke<string>('drafting_import_template_file', { workspacePath, sourcePath })
}

export const syncTemplates = async (workspacePath: string): Promise<TemplateSyncResult> => {
  if (!isTauri()) {
    const templates = await listTemplates(workspacePath)
    return {
      added: 0,
      updated: 0,
      incompatible: templates.filter((item) => !item.variableCount).length,
      templateDir: await getTemplateDir(workspacePath),
      templates,
    }
  }
  return invoke<TemplateSyncResult>('drafting_sync_templates', { workspacePath })
}

export const readTemplateMetadata = async (template: TemplateListItem): Promise<TemplateMetadata> => {
  const raw = isTauri()
    ? await invoke<string>('inbox_read_file_text', { storedPath: template.metaPath })
    : localStorage.getItem(browserMetaKey(template.metaPath))
  const parsed = safeParse<Partial<TemplateMetadata>>(raw, {})
  return {
    id: template.id,
    title: parsed.title || template.title,
    description: parsed.description || template.description,
    variables: parsed.variables || [],
    originalFilename: parsed.originalFilename || template.originalFilename,
    createdAt: parsed.createdAt || template.createdAt,
    category: parsed.category || template.category,
    status: parsed.status || template.status,
    supportsFreeDraft: parsed.supportsFreeDraft || template.supportsFreeDraft,
    updatedAt: parsed.updatedAt,
  }
}

export const saveTemplate = async (
  workspacePath: string,
  docxBase64: string,
  metadata: TemplateMetadata,
): Promise<TemplateListItem> => {
  if (!isTauri()) {
    const normalized = {
      ...metadata,
      createdAt: metadata.createdAt || new Date().toISOString(),
      status: metadata.status || 'ready' as TemplateStatus,
      supportsFreeDraft: metadata.supportsFreeDraft || metadata.variables.some((item) => item.placeholder === 'draft_body'),
      updatedAt: new Date().toISOString(),
    }
    const item = toTemplateListItem(normalized, workspacePath)
    const entries = readBrowserTemplateEntries(workspacePath).filter((entry) => entry.item.id !== item.id)
    writeBrowserTemplateEntries(workspacePath, [{ item, metadata: normalized }, ...entries])
    localStorage.setItem(browserDocxKey(item.docxPath), docxBase64)
    localStorage.setItem(browserMetaKey(item.metaPath), JSON.stringify(normalized))
    return item
  }
  return invoke<TemplateListItem>('drafting_save_template', { workspacePath, docxBase64, metadata })
}

export const deleteTemplate = async (workspacePath: string, templateId: string): Promise<void> => {
  if (!isTauri()) {
    const entries = readBrowserTemplateEntries(workspacePath)
    const target = entries.find((entry) => entry.item.id === templateId)
    if (target) {
      localStorage.removeItem(browserDocxKey(target.item.docxPath))
      localStorage.removeItem(browserMetaKey(target.item.metaPath))
    }
    writeBrowserTemplateEntries(workspacePath, entries.filter((entry) => entry.item.id !== templateId))
    return
  }
  await invoke('drafting_delete_template', { workspacePath, templateId })
}

export const updateTemplateMetadata = async (
  workspacePath: string,
  metadata: TemplateMetadata,
): Promise<TemplateListItem> => {
  if (!isTauri()) {
    const entries = readBrowserTemplateEntries(workspacePath)
    const existing = entries.find((entry) => entry.item.id === metadata.id)
    const normalized = {
      ...metadata,
      status: metadata.status || 'ready' as TemplateStatus,
      supportsFreeDraft: metadata.supportsFreeDraft || metadata.variables.some((item) => item.placeholder === 'draft_body'),
      updatedAt: new Date().toISOString(),
    }
    const item = existing
      ? {
          ...existing.item,
          title: normalized.title || existing.item.title,
          description: normalized.description || '',
          variableCount: normalized.variables?.length ?? 0,
          category: normalized.category,
          status: normalized.status,
          supportsFreeDraft: normalized.supportsFreeDraft,
        }
      : toTemplateListItem(normalized, workspacePath)
    const next = [{ item, metadata: normalized }, ...entries.filter((entry) => entry.item.id !== metadata.id)]
    writeBrowserTemplateEntries(workspacePath, next)
    localStorage.setItem(browserMetaKey(item.metaPath), JSON.stringify(normalized))
    return item
  }
  return invoke<TemplateListItem>('drafting_update_metadata', { workspacePath, metadata })
}

// ---------------------------------------------------------------------------
// Docx text extraction (pure JS, using JSZip + XML parsing)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a .docx file (given as base64).
 * Preserves paragraph structure (double newlines between paragraphs).
 */
export const extractTextFromDocx = async (base64: string): Promise<string> => {
  const JSZip = await loadJSZip()
  const zip = await JSZip.loadAsync(base64, { base64: true })
  const docXml = await zip.file('word/document.xml')?.async('text')
  if (!docXml) {
    throw new Error('无法解析 .docx 文件：缺少 word/document.xml')
  }

  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(docXml, 'application/xml')

  const paragraphs = xmlDoc.getElementsByTagName('w:p')
  const lines: string[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    const texts = paragraphs[i].getElementsByTagName('w:t')
    let line = ''
    for (let j = 0; j < texts.length; j++) {
      line += texts[j].textContent || ''
    }
    lines.push(line)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// AI variable detection
// ---------------------------------------------------------------------------

const VARIABLE_DETECTION_SYSTEM_PROMPT = `你是一位资深法律文书分析专家。你的任务是分析一篇法律文书，识别出其中所有"变量"部分——即每次使用这份文书模板时需要替换为新内容的部分。

## 什么是变量（需要识别）
- **当事人信息**：原告、被告、申请人、被申请人、甲方、乙方的姓名/名称、身份证号、地址、法定代表人、委托代理人
- **案件信息**：案号（如"（2024）京0101民初123号"）、法院名称、案由
- **时间信息**：起诉日期、开庭日期、签发日期、合同签订日期等具体日期
- **金额数字**：诉讼标的额、合同金额、违约金、赔偿金额、利息等具体数字
- **事实细节**：具体的事实描述（如"2023年5月，被告向原告借款10万元"中的时间、金额、行为）
- **具体诉求**：诉讼请求中的具体内容

## 什么是固定内容（不要识别）
- 法律条文引用本身是固定的（如"根据《中华人民共和国民法典》第六百七十五条"）
- 标准格式语句："本院认为"、"综上所述"、"特此通知"、"此致"、"具状人"
- 通用法律术语和格式性文字

## 关键规则：originalText 字段
**这是最重要的字段。** 你必须在原文中找到该变量对应的 **完整精确文本**（originalText），系统会用这个文本来定位并替换。
- 必须是原文中实际出现的文字，一字不差
- 如果同一变量在文中出现多次，用第一次出现的完整文本
- 如果变量是一段连续文字（如一整句事实描述），originalText 就是那一整段
- 不要截断，不要省略，不要概括——必须是原文精确副本

## 输出规则
1. 严格输出 JSON，不要 markdown 代码块包裹
2. 每个变量需要：placeholder（英文下划线命名）、label（中文标签）、type、originalText（原文精确文本）、description
3. placeholder 使用有意义的英文名，如 plaintiff_name、case_number、filing_date、claim_amount
4. 如果文书中有重复出现的同一实体（如同一个人名出现多次），只识别一次，用第一次出现的文本作为 originalText
5. title 字段填写文书类型（如"民事起诉状"、"律师函"）
6. description 字段简要描述模板用途
7. category 从以下选择："诉讼"、"非诉"、"合同"、"其他"
8. type 从以下选择：text、date、money、number、long_text

输出格式：
{
  "title": "文书类型",
  "description": "模板用途描述",
  "category": "诉讼|非诉|合同|其他",
  "variables": [
    {
      "placeholder": "variable_name",
      "label": "变量中文标签",
      "type": "text",
      "originalText": "原文中的精确文本",
      "description": "变量说明"
    }
  ]
}`

export const detectVariables = async (
  text: string,
  settings: AISettings,
): Promise<VariableDetectionResult> => {
  const result = await aiChat(settings, [
    { role: 'system', content: VARIABLE_DETECTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请分析以下法律文书，识别所有需要替换为模板变量的部分：\n\n${text}`,
    },
  ])

  const parsed = tryParseJson(result.content)
  if (!parsed) {
    return {
      title: '未识别文书',
      description: '',
      category: '其他',
      variables: [],
      rawResponse: result.content,
    }
  }

  return {
    title: typeof parsed.title === 'string' ? parsed.title : '未命名模板',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    category: typeof parsed.category === 'string' ? parsed.category : '其他',
    variables: Array.isArray(parsed.variables) ? parsed.variables.map(normalizeVariable) : [],
    rawResponse: result.content,
  }
}

const normalizeVariable = (raw: unknown): TemplateVariable => {
  if (!raw || typeof raw !== 'object') {
    return { placeholder: 'unknown', label: '未知', type: 'text' }
  }
  const obj = raw as Record<string, unknown>
  const validTypes = ['text', 'date', 'money', 'number', 'long_text']
  const rawType = typeof obj.type === 'string' ? obj.type : 'text'
  return {
    placeholder: typeof obj.placeholder === 'string' ? obj.placeholder : 'unknown',
    label: typeof obj.label === 'string' ? obj.label : '未知',
    type: (validTypes.includes(rawType) ? rawType : 'text') as TemplateVariable['type'],
    // Support both old (example) and new (originalText) field names
    example: typeof obj.originalText === 'string' ? obj.originalText
      : typeof obj.example === 'string' ? obj.example : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
  }
}

const tryParseJson = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim()
  try {
    const v = JSON.parse(trimmed)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* ignore */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    try {
      const v = JSON.parse(fenced[1])
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch { /* ignore */ }
  }

  const start = trimmed.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (inStr) {
        if (esc) { esc = false }
        else if (ch === '\\') { esc = true }
        else if (ch === '"') { inStr = false }
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            const v = JSON.parse(trimmed.slice(start, i + 1))
            if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
          } catch { /* ignore */ }
          break
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Template generation: replace variable text with {placeholder} tags in .docx XML
// ---------------------------------------------------------------------------

/**
 * Given a .docx (as base64), a map of originalText→placeholder, produce a new
 * .docx (as base64) where variable text is replaced with {placeholder} tags.
 *
 * Strategy: parse the XML, merge text runs within each paragraph to find
 * variable occurrences, then replace them while preserving formatting.
 */
export const generateTemplateDocx = async (
  base64: string,
  replacements: Array<{ originalText: string; placeholder: string }>,
): Promise<string> => {
  const JSZip = await loadJSZip()
  const zip = await JSZip.loadAsync(base64, { base64: true })
  const docXml = await zip.file('word/document.xml')?.async('text')
  if (!docXml) throw new Error('无法解析 .docx')

  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(docXml, 'application/xml')

  // Process each paragraph: collect all <w:t> nodes, merge text, find & replace
  const paragraphs = xmlDoc.getElementsByTagName('w:p')

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi]
    const runs = para.getElementsByTagName('w:r')
    if (runs.length === 0) continue

    // Collect all text nodes and their content
    const textNodes: Array<{ node: Text; text: string }> = []
    for (let ri = 0; ri < runs.length; ri++) {
      const tNodes = runs[ri].getElementsByTagName('w:t')
      for (let ti = 0; ti < tNodes.length; ti++) {
        const tNode = tNodes[ti]
        const text = tNode.textContent || ''
        if (text.length > 0) {
          textNodes.push({ node: tNode as unknown as Text, text })
        }
      }
    }

    if (textNodes.length === 0) continue

    // Build merged text and a position→node mapping
    let merged = ''
    const charMap: Array<{ nodeIndex: number; charOffset: number }> = []
    for (let ni = 0; ni < textNodes.length; ni++) {
      for (let ci = 0; ci < textNodes[ni].text.length; ci++) {
        charMap.push({ nodeIndex: ni, charOffset: ci })
        merged += textNodes[ni].text[ci]
      }
    }

    // Sort replacements by length descending to avoid partial matches
    const sortedReplacements = [...replacements].sort(
      (a, b) => b.originalText.length - a.originalText.length,
    )

    // Apply replacements
    let changed = false
    for (const { originalText, placeholder } of sortedReplacements) {
      const tag = `{${placeholder}}`
      const idx = merged.indexOf(originalText)
      if (idx < 0) continue

      // Replace all occurrences
      let searchFrom = 0
      while (true) {
        const foundAt = merged.indexOf(originalText, searchFrom)
        if (foundAt < 0) break

        // Map the found range to text node indices
        const startMapping = charMap[foundAt]
        const endMapping = charMap[foundAt + originalText.length - 1]

        if (!startMapping || !endMapping) break

        // If the replacement spans a single node, do a simple replace
        if (startMapping.nodeIndex === endMapping.nodeIndex) {
          const node = textNodes[startMapping.nodeIndex].node
          const text = node.textContent || ''
          node.textContent =
            text.slice(0, startMapping.charOffset) +
            tag +
            text.slice(startMapping.charOffset + originalText.length)
          textNodes[startMapping.nodeIndex].text = node.textContent || ''
        } else {
          // Multi-node replacement: put the tag in the first node, clear middle nodes,
          // remove excess text from last node
          const firstNode = textNodes[startMapping.nodeIndex].node
          const firstText = firstNode.textContent || ''
          firstNode.textContent = firstText.slice(0, startMapping.charOffset) + tag

          // Clear intermediate nodes
          for (let ni = startMapping.nodeIndex + 1; ni < endMapping.nodeIndex; ni++) {
            textNodes[ni].node.textContent = ''
            textNodes[ni].text = ''
          }

          // Remove replaced prefix from last node
          const lastNode = textNodes[endMapping.nodeIndex].node
          const lastText = lastNode.textContent || ''
          lastNode.textContent = lastText.slice(endMapping.charOffset + 1)
          textNodes[endMapping.nodeIndex].text = lastNode.textContent || ''
        }

        // Rebuild merged text for subsequent replacements
        merged = ''
        charMap.length = 0
        for (let ni = 0; ni < textNodes.length; ni++) {
          textNodes[ni].text = textNodes[ni].node.textContent || ''
          for (let ci = 0; ci < textNodes[ni].text.length; ci++) {
            charMap.push({ nodeIndex: ni, charOffset: ci })
            merged += textNodes[ni].text[ci]
          }
        }

        changed = true
        searchFrom = foundAt + tag.length
      }
    }

    // Preserve xml:space="preserve" on <w:t> nodes to prevent whitespace issues
    if (changed) {
      for (const tn of textNodes) {
        const elem = tn.node as unknown as Element
        if (elem.setAttribute) {
          elem.setAttribute('xml:space', 'preserve')
        }
      }
    }
  }

  // Serialize modified XML back
  const serializer = new XMLSerializer()
  const modifiedXml = serializer.serializeToString(xmlDoc)
  zip.file('word/document.xml', modifiedXml)

  return zip.generateAsync({ type: 'base64' })
}

// ---------------------------------------------------------------------------
// Document generation: fill template with variable values using docxtemplater
// ---------------------------------------------------------------------------

/**
 * Given a template .docx (with {placeholder} tags) and variable values,
 * generate a filled .docx document.
 */
export const generateDocument = async (
  templateBase64: string,
  variables: Record<string, string>,
): Promise<string> => {
  const JSZip = await loadJSZip()
  const zip = await JSZip.loadAsync(templateBase64, { base64: true })
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{', end: '}' },
  })

  doc.render(variables)

  // docxtemplater's getZip() returns JSZip; generateAsync is the v3 method
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputZip: any = doc.getZip()
  const buffer: string = await outputZip.generateAsync({ type: 'base64' })
  return buffer
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const paragraphXml = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`

export const createBuiltinFreeDraftDocx = async ({
  draftTitle,
  documentType,
  draftBody,
  riskNotes,
}: {
  draftTitle: string
  documentType: string
  draftBody: string
  riskNotes?: string[]
}): Promise<string> => {
  const JSZip = await loadJSZip()
  const zip = new JSZip()
  const bodyParagraphs = [
    draftTitle || documentType || '法律文书草稿',
    '',
    ...draftBody.split(/\r?\n/),
    ...(riskNotes?.length ? ['', '复核提示', ...riskNotes.map((item) => `- ${item}`)] : []),
  ].map(paragraphXml).join('')

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyParagraphs}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`)

  return zip.generateAsync({ type: 'base64' })
}

export const templateSupportsPlaceholder = async (
  templateBase64: string,
  placeholder: string,
): Promise<boolean> => {
  const JSZip = await loadJSZip()
  const zip = await JSZip.loadAsync(templateBase64, { base64: true })
  const docXml = await zip.file('word/document.xml')?.async('text')
  return Boolean(docXml?.includes(`{${placeholder}}`))
}

// ---------------------------------------------------------------------------
// End-to-end workflow helpers
// ---------------------------------------------------------------------------

/**
 * Full conversion flow: upload .docx → extract text → AI detect variables →
 * generate template .docx with placeholders.
 */
export const convertDocumentToTemplate = async (
  docxBase64: string,
  settings: AISettings,
  onProgress?: (step: string) => void,
): Promise<{ templateBase64: string; metadata: VariableDetectionResult }> => {
  onProgress?.('正在提取文档文本…')
  const text = await extractTextFromDocx(docxBase64)

  onProgress?.('正在用 AI 识别变量…')
  const detection = await detectVariables(text, settings)

  if (detection.variables.length === 0) {
    return { templateBase64: docxBase64, metadata: detection }
  }

  onProgress?.('正在生成模板…')
  const replacements = detection.variables
    .filter((v) => v.example && v.example.trim().length > 0)
    .map((v) => ({
      originalText: v.example!.trim(),
      placeholder: v.placeholder,
    }))

  const templateBase64 = await generateTemplateDocx(docxBase64, replacements)

  return { templateBase64, metadata: detection }
}

/**
 * Full drafting flow: load template + fill variables → generate .docx.
 */
export const draftDocument = async (
  templateBase64: string,
  variables: Record<string, string>,
): Promise<string> => {
  return generateDocument(templateBase64, variables)
}
