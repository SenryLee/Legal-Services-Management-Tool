import { invoke } from '@tauri-apps/api/core'
import JSZip from 'jszip'
import Docxtemplater from 'docxtemplater'
import { aiChat } from './ai'
import type { AISettings } from '../domain'

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
}

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
}

export interface VariableDetectionResult {
  title: string
  description: string
  category: string
  variables: TemplateVariable[]
  rawResponse?: string
}

// ---------------------------------------------------------------------------
// Rust command wrappers
// ---------------------------------------------------------------------------

export const readDocxBase64 = async (path: string): Promise<string> => {
  return invoke<string>('drafting_read_docx', { path })
}

export const saveDocx = async (path: string, base64Data: string): Promise<void> => {
  await invoke('drafting_save_docx', { path, base64Data })
}

export const listTemplates = async (workspacePath: string): Promise<TemplateListItem[]> => {
  return invoke<TemplateListItem[]>('drafting_list_templates', { workspacePath })
}

export const saveTemplate = async (
  workspacePath: string,
  docxBase64: string,
  metadata: TemplateMetadata,
): Promise<TemplateListItem> => {
  return invoke<TemplateListItem>('drafting_save_template', { workspacePath, docxBase64, metadata })
}

export const deleteTemplate = async (workspacePath: string, templateId: string): Promise<void> => {
  await invoke('drafting_delete_template', { workspacePath, templateId })
}

export const updateTemplateMetadata = async (
  workspacePath: string,
  metadata: TemplateMetadata,
): Promise<TemplateListItem> => {
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

const VARIABLE_DETECTION_SYSTEM_PROMPT = `你是一位资深法律文书分析专家。你的任务是分析一篇法律文书，识别出其中所有"变量"部分——即每次使用时需要替换的内容。

变量类型包括：
- 当事人信息：原告/被告/申请人/被申请人姓名、名称、身份证号、地址、法定代表人
- 案件信息：案号、法院名称、案由
- 时间信息：起诉日期、开庭日期、签发日期、合同签订日期
- 金额信息：诉讼标的额、合同金额、违约金、赔偿金额
- 其他可变信息：事实描述的关键细节、具体诉求内容

固定内容（不应识别为变量）：
- 法律条文引用（如"根据《中华人民共和国民法典》第XXX条"——这里法条是固定的）
- 标准格式语句（如"本院认为"、"综上所述"、"特此通知"）
- 通用法律术语和格式性文字

输出规则：
1. 严格输出 JSON，不要 markdown 代码块包裹
2. 每个变量需要：placeholder（英文下划线命名）、label（中文标签）、type（text/date/money/number/long_text）、example（原文中的示例值）、description（简短说明）
3. placeholder 使用有意义的英文名，如 plaintiff_name、case_number、filing_date、claim_amount
4. 如果文书中有重复出现的同一实体（如同一个人名出现多次），只识别一次，用同一个 placeholder
5. title 字段填写文书类型（如"民事起诉状"、"律师函"、"合同"）
6. description 字段简要描述模板用途
7. category 字段从以下选择："诉讼"、"非诉"、"合同"、"其他"

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
      "example": "原文中的示例",
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
    example: typeof obj.example === 'string' ? obj.example : undefined,
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
  const zip = await JSZip.loadAsync(templateBase64, { base64: true })
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{', end: '}' },
  })

  doc.render(variables)

  const outputZip = doc.getZip()
  const buffer = await (outputZip as any).generateAsync({ type: 'base64' })
  return buffer
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
  const replacements = detection.variables.map((v) => ({
    originalText: v.example || '',
    placeholder: v.placeholder,
  })).filter((r) => r.originalText.length > 0)

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
