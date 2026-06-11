import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFreeDraftMessages,
  buildTemplateDraftMessages,
  normalizeFreeDraftResult,
  parseStructuredAiJson,
  resolveFreeDraftTemplate,
} from './drafting-logic.ts'

test('parseStructuredAiJson extracts fenced JSON objects', () => {
  const parsed = parseStructuredAiJson('```json\n{"status":"drafted","draft_body":"正文"}\n```')

  assert.deepEqual(parsed, {
    status: 'drafted',
    draft_body: '正文',
  })
})

test('resolveFreeDraftTemplate uses configured template when it exists', () => {
  const result = resolveFreeDraftTemplate(
    [
      { id: 'tpl-001', title: '通用函件', docxPath: '/tmp/tpl-001.docx' },
      { id: 'tpl-002', title: '诉讼文书', docxPath: '/tmp/tpl-002.docx' },
    ],
    'tpl-002',
  )

  assert.equal(result.kind, 'template')
  assert.equal(result.template?.id, 'tpl-002')
  assert.equal(result.notice, '')
})

test('resolveFreeDraftTemplate falls back when configured template is missing', () => {
  const result = resolveFreeDraftTemplate(
    [{ id: 'tpl-001', title: '通用函件', docxPath: '/tmp/tpl-001.docx' }],
    'tpl-missing',
  )

  assert.equal(result.kind, 'builtin')
  assert.equal(result.template, null)
  assert.match(result.notice, /默认模板已失效/)
})

test('normalizeFreeDraftResult keeps drafted body and missing-info questions separate', () => {
  const drafted = normalizeFreeDraftResult({
    mode: 'free',
    status: 'drafted',
    document_type: '律师函',
    draft_title: '律师函',
    draft_body: '完整正文',
    risk_notes: ['需核对主体信息'],
  })

  assert.equal(drafted.status, 'drafted')
  assert.equal(drafted.draftBody, '完整正文')
  assert.deepEqual(drafted.questions, [])
  assert.deepEqual(drafted.riskNotes, ['需核对主体信息'])

  const missing = normalizeFreeDraftResult({
    mode: 'free',
    status: 'need_more_info',
    questions: ['请补充相对方名称', '请补充违约事实'],
  })

  assert.equal(missing.status, 'need_more_info')
  assert.equal(missing.draftBody, '')
  assert.deepEqual(missing.questions, ['请补充相对方名称', '请补充违约事实'])
})

test('prompt builders enforce structured JSON and anti-fabrication rules', () => {
  const freeMessages = buildFreeDraftMessages('起草律师函', [])
  const templateMessages = buildTemplateDraftMessages('王某，2026-06-10', [
    { placeholder: 'client_name', label: '委托人', type: 'text' },
  ], {})

  assert.match(freeMessages[0].content, /不得编造事实/)
  assert.match(freeMessages[0].content, /输出严格 JSON/)
  assert.match(templateMessages[0].content, /不是重写模板/)
  assert.match(templateMessages[0].content, /need_more_info \| ready/)
})
