import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye, Loader2, Save } from 'lucide-react'
import type { AiProvider, AISettings, ModuleKey, WorkspaceSnapshot } from '../../domain'
import { MODULE_ORDER, PROVIDER_PRESETS } from '../../domain'
import { aiTestConnection, DEFAULT_AI_SYSTEM_PROMPT, isAiReady, saveAiSettings } from '../../storage'
import { friendlyError } from '../../shared/utils'
import PromptPreview from './PromptPreview'

function isPresetBase(provider: AiProvider, value: string): boolean {
  const preset = PROVIDER_PRESETS[provider]
  return preset ? value.trim() === preset.baseUrl : false
}

function isPresetModel(provider: AiProvider, value: string): boolean {
  const preset = PROVIDER_PRESETS[provider]
  return preset ? value.trim() === preset.model : false
}

export default function AiSettingsTab({
  settings,
  onChange,
  setStatus,
  config,
}: {
  settings: AISettings
  onChange: (next: AISettings) => void
  setStatus: (status: string) => void
  config: WorkspaceSnapshot['config']
}) {
  const [draft, setDraft] = useState<AISettings>(settings)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [previewModule, setPreviewModule] = useState<ModuleKey>('litigation')
  const [previewSampleText, setPreviewSampleText] = useState(
    '示例：2026年4月发上海长宁区法院的起诉状摘录，案号(2026)沪0105民初1234号，原告上海岚山科技有限公司，被告北辰贸易有限公司，案由服务合同纠纷，标的额120000元。',
  )
  const [previewCustomPrompt, setPreviewCustomPrompt] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  const preset = PROVIDER_PRESETS[draft.provider] ?? PROVIDER_PRESETS.openai

  const update = (patch: Partial<AISettings>) => {
    setDraft({ ...draft, ...patch })
  }

  const handleProvider = (provider: AiProvider) => {
    const next: AISettings = {
      ...draft,
      provider,
      baseUrl: !draft.baseUrl || isPresetBase(draft.provider, draft.baseUrl) ? '' : draft.baseUrl,
      model: !draft.model || isPresetModel(draft.provider, draft.model) ? '' : draft.model,
    }
    setDraft(next)
  }

  const handleSave = async () => {
    try {
      await saveAiSettings(draft)
      onChange(draft)
      setStatus('AI 配置已保存到 ~/Library/Application Support/com.local.legalbiz/ai.json')
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await aiTestConnection(draft)
      setTestResult({
        ok: true,
        message: `连通成功：${result.provider}/${result.model}，耗时 ${result.latencyMs}ms。响应：${result.content.slice(0, 60)}`,
      })
    } catch (error) {
      setTestResult({ ok: false, message: friendlyError(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">
          <h2>AI 接口</h2>
          <span>支持 OpenAI / DeepSeek / Claude / 豆包(火山方舟) / 任意 OpenAI 兼容</span>
        </div>

        <p className="muted setup-hint">
          只要填写并保存 API Key，AI 助手即视为已启用。
          {isAiReady(draft) ? (
            <strong className="ready-badge"> 当前：已启用</strong>
          ) : (
            <strong className="ready-badge off"> 当前：未启用（请填 API Key）</strong>
          )}
        </p>

        <label className="field">
          <span>提供商</span>
          <div className="provider-pills">
            {(Object.keys(PROVIDER_PRESETS) as AiProvider[]).map((key) => (
              <button
                key={key}
                type="button"
                className={draft.provider === key ? 'active' : ''}
                onClick={() => handleProvider(key)}
              >
                {PROVIDER_PRESETS[key].label}
              </button>
            ))}
          </div>
        </label>
        <p className="muted preset-help">{preset.help}</p>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder={
              draft.provider === 'anthropic' ? 'sk-ant-...' : draft.provider === 'deepseek' ? 'sk-...' : 'sk-...'
            }
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder={preset.baseUrl}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input
            value={draft.model}
            onChange={(event) => update({ model: event.target.value })}
            placeholder={preset.model}
            spellCheck={false}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Temperature</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature ?? 0.2}
              onChange={(event) => update({ temperature: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>Max tokens</span>
            <input
              type="number"
              min={256}
              max={32000}
              step={128}
              value={draft.maxTokens ?? 2048}
              onChange={(event) => update({ maxTokens: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>超时（秒）</span>
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={draft.timeoutSeconds ?? 60}
              onChange={(event) => update({ timeoutSeconds: Number(event.target.value) })}
            />
          </label>
        </div>

        <label className="field full">
          <span>系统提示词（留空则使用默认）</span>
          <textarea
            rows={9}
            value={draft.systemPrompt}
            onChange={(event) => update({ systemPrompt: event.target.value })}
            placeholder={DEFAULT_AI_SYSTEM_PROMPT}
          />
          <small className="muted">
            <strong>系统提示词 = 通用工作规则</strong>，对所有模块共用。
            <strong>当前模块的字段 schema</strong>（key / type / options / required）
            会在每次调用时<strong>动态拼到 user message</strong>，所以这里不需要枚举字段。
            点下方"预览实际发送内容"按钮可看到任意模块的拼接结果。
          </small>
        </label>

        <details className="prompt-preview" open={previewOpen}>
          <summary onClick={(event) => { event.preventDefault(); setPreviewOpen((v) => !v) }}>
            <Eye size={14} /> 预览实际发送内容（按模块拼接）
          </summary>
          <div className="prompt-preview-body">
            <div className="field-row">
              <label className="field">
                <span>模块</span>
                <select
                  value={previewModule}
                  onChange={(event) => setPreviewModule(event.target.value as ModuleKey)}
                >
                  {MODULE_ORDER.map((key) => (
                    <option key={key} value={key}>
                      {config.modules[key].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ gridColumn: 'span 2' }}>
                <span>补充指引（可选，模拟 AI 助手里的输入）</span>
                <input
                  value={previewCustomPrompt}
                  onChange={(event) => setPreviewCustomPrompt(event.target.value)}
                  placeholder={'例如：把"乙方"作为客户、"甲方"作为相对方'}
                />
              </label>
            </div>
            <label className="field full">
              <span>示例文本</span>
              <textarea
                rows={3}
                value={previewSampleText}
                onChange={(event) => setPreviewSampleText(event.target.value)}
              />
            </label>
            <PromptPreview
              text={previewSampleText}
              targetModule={previewModule}
              config={config}
              settings={draft}
              customPrompt={previewCustomPrompt}
            />
          </div>
        </details>

        <div className="button-row end">
          <button type="button" onClick={handleTest} disabled={testing || !draft.apiKey}>
            {testing ? <Loader2 size={14} className="spinning" /> : <CheckCircle2 size={14} />}{' '}
            测试连接
          </button>
          <button type="button" className="primary" onClick={handleSave}>
            <Save size={14} /> 保存
          </button>
        </div>

        {testResult ? (
          <div className={`test-banner ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{testResult.message}</span>
          </div>
        ) : null}
      </section>

      <aside className="panel">
        <div className="section-title">
          <h2>说明</h2>
          <span>v1 默认调用本地 Rust 端发起 HTTPS 请求</span>
        </div>
        <ul className="info-list">
          <li>
            <strong>本地存储</strong>：API Key 写入
            <code>~/Library/Application Support/com.local.legalbiz/ai.json</code>，不会同步到工作区。
          </li>
          <li>
            <strong>Claude</strong>：自动添加 <code>anthropic-version: 2023-06-01</code> 头。
          </li>
          <li>
            <strong>豆包</strong>：火山方舟控制台的 model id 形如 <code>doubao-1-5-pro-32k-250115</code> 或自定义 endpoint id。
          </li>
          <li>
            <strong>自定义</strong>：OneAPI、SiliconFlow、Together、Groq 都属此类，按 OpenAI Chat Completions 协议调用。
          </li>
          <li>
            <strong>调用失败</strong>：可点上方"测试连接"，错误信息会包含 HTTP 状态码与服务端 body 摘要，便于排查。
          </li>
        </ul>
      </aside>
    </div>
  )
}
