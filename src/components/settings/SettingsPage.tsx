import { ClipboardList, KeyRound, Settings2, Sparkles } from 'lucide-react'
import type { AISettings, WorkspaceSnapshot } from '../../domain'
import AiSettingsTab from './AiSettingsTab'
import GeneralSettingsTab from './GeneralSettingsTab'
import FieldSettingsTab from './FieldSettingsTab'
import AboutTab from './AboutTab'

export default function SettingsPage({
  tab,
  setTab,
  config,
  workspacePath,
  aiSettings,
  onAiSettings,
  onConfigSaved,
  recents,
  onClearRecents,
  setStatus,
}: {
  tab: 'ai' | 'general' | 'fields' | 'about'
  setTab: (value: 'ai' | 'general' | 'fields' | 'about') => void
  config: WorkspaceSnapshot['config']
  workspacePath: string
  aiSettings: AISettings
  onAiSettings: (next: AISettings) => void
  onConfigSaved: (config: WorkspaceSnapshot['config']) => void
  recents: string[]
  onClearRecents: () => void
  setStatus: (status: string) => void
}) {
  return (
    <div className="settings-page">
      <nav className="settings-tabs" aria-label="设置分类">
        <button type="button" className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
          <KeyRound size={14} /> AI 配置
        </button>
        <button
          type="button"
          className={tab === 'general' ? 'active' : ''}
          onClick={() => setTab('general')}
        >
          <Settings2 size={14} /> 通用
        </button>
        <button
          type="button"
          className={tab === 'fields' ? 'active' : ''}
          onClick={() => setTab('fields')}
        >
          <ClipboardList size={14} /> 字段
        </button>
        <button
          type="button"
          className={tab === 'about' ? 'active' : ''}
          onClick={() => setTab('about')}
        >
          <Sparkles size={14} /> 关于
        </button>
      </nav>

      <div className="settings-body">
        {tab === 'ai' ? (
          <AiSettingsTab
            settings={aiSettings}
            onChange={onAiSettings}
            setStatus={setStatus}
            config={config}
          />
        ) : tab === 'general' ? (
          <GeneralSettingsTab
            workspacePath={workspacePath}
            recents={recents}
            onClearRecents={onClearRecents}
            setStatus={setStatus}
          />
        ) : tab === 'fields' ? (
          <FieldSettingsTab
            config={config}
            workspacePath={workspacePath}
            onSaved={onConfigSaved}
            setStatus={setStatus}
          />
        ) : (
          <AboutTab />
        )}
      </div>
    </div>
  )
}
