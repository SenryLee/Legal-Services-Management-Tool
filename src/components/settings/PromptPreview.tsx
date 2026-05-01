import { useMemo } from 'react'
import type { AISettings, ModuleKey, WorkspaceSnapshot } from '../../domain'
import { buildExtractionMessages } from '../../storage'

export default function PromptPreview({
  text,
  targetModule,
  config,
  settings,
  customPrompt,
}: {
  text: string
  targetModule: ModuleKey
  config: WorkspaceSnapshot['config']
  settings: AISettings
  customPrompt: string
}) {
  const messages = useMemo(
    () => buildExtractionMessages(text, targetModule, config, settings, customPrompt),
    [config, customPrompt, settings, targetModule, text],
  )
  return (
    <div className="prompt-blocks">
      <div>
        <header>
          <span className="role">role: system</span>
          <small className="muted">通用规则 · 所有模块共用</small>
        </header>
        <pre>{messages.system}</pre>
      </div>
      <div>
        <header>
          <span className="role user">role: user</span>
          <small className="muted">每次调用按当前模块动态拼接</small>
        </header>
        <pre>{messages.user}</pre>
      </div>
    </div>
  )
}
