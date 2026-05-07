// ---------------------------------------------------------------------------
// 文件读取：PDF / DOCX / 纯文本 解析
// ---------------------------------------------------------------------------

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
  const chineseChars = text.match(/[㐀-鿿]/g)?.length ?? 0
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

  // 多编码尝试
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
