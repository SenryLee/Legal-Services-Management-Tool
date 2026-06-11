import { useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2 } from 'lucide-react'
import type { WorkspaceSnapshot } from '../../domain'
import { getDefaultWorkspaceRoot, openInFinder, saveConfig } from '../../storage'
import { getTemplateDir, listTemplates, syncTemplates, type TemplateListItem } from '../../storage/drafting'
import { friendlyError } from '../../shared/utils'

export default function GeneralSettingsTab({
  config,
  workspacePath,
  recents,
  onClearRecents,
  onConfigSaved,
  setStatus,
}: {
  config: WorkspaceSnapshot['config']
  workspacePath: string
  recents: string[]
  onClearRecents: () => void
  onConfigSaved: (config: WorkspaceSnapshot['config']) => void
  setStatus: (status: string) => void
}) {
  const [defaultRoot, setDefaultRoot] = useState('')
  const [templates, setTemplates] = useState<TemplateListItem[]>([])
  const [templateDir, setTemplateDir] = useState('')
  const [defaultTemplateId, setDefaultTemplateId] = useState(config.drafting?.defaultFreeTemplateId ?? '')
  const [autoScanTemplates, setAutoScanTemplates] = useState(config.drafting?.autoScanTemplates ?? true)

  useEffect(() => {
    getDefaultWorkspaceRoot().then(setDefaultRoot).catch(() => setDefaultRoot(''))
  }, [])

  useEffect(() => {
    setDefaultTemplateId(config.drafting?.defaultFreeTemplateId ?? '')
    setAutoScanTemplates(config.drafting?.autoScanTemplates ?? true)
  }, [config])

  useEffect(() => {
    if (!workspacePath) {
      setTemplates([])
      return
    }
    getTemplateDir(workspacePath)
      .then(setTemplateDir)
      .catch(() => setTemplateDir(''))
    const loader = config.drafting?.autoScanTemplates ?? true
      ? syncTemplates(workspacePath).then((result) => result.templates)
      : listTemplates(workspacePath)
    loader
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [config.drafting?.autoScanTemplates, workspacePath])

  const persistDefaultTemplate = async () => {
    try {
      const selected = templates.find((template) => template.id === defaultTemplateId)
      if (selected && !selected.supportsFreeDraft) {
        setStatus('默认模板需要包含 {draft_body} 占位符。')
        return
      }
      const saved = await saveConfig(workspacePath, {
        ...config,
        drafting: {
          ...config.drafting,
          defaultFreeTemplateId: defaultTemplateId,
          autoScanTemplates,
        },
      })
      onConfigSaved(saved)
      setStatus(
        defaultTemplateId
          ? '自由起草默认模板已保存。'
          : '已清空自由起草默认模板，将使用内置基础版式。',
      )
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">
          <h2>工作区</h2>
          <span>当前会话</span>
        </div>
        <p>
          <strong>当前工作区：</strong>
          <code>{workspacePath || '（未选择）'}</code>
        </p>
        <p>
          <strong>默认新建位置：</strong>
          <code>{defaultRoot || '~/LegalVault'}</code>
        </p>

        <div className="button-row">
          <button
            type="button"
            onClick={async () => {
              if (workspacePath) {
                await openInFinder(workspacePath)
              } else {
                setStatus('请先打开一个工作区。')
              }
            }}
          >
            <FolderOpen size={14} /> 在 Finder 中打开当前工作区
          </button>
        </div>
      </section>

      <aside className="panel">
        <div className="section-title">
          <h2>最近工作区</h2>
          <span>{recents.length} 条</span>
        </div>
        {recents.length === 0 ? (
          <p className="muted">暂无最近记录。</p>
        ) : (
          <ul className="recent-full-list">
            {recents.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        )}
        <div className="button-row end">
          <button type="button" onClick={onClearRecents} disabled={recents.length === 0}>
            <Trash2 size={14} /> 清空最近列表
          </button>
        </div>
      </aside>

      <section className="panel">
        <div className="section-title">
          <h2>文书起草</h2>
          <span>自由起草导出模板</span>
        </div>
        <label className="field">
          自由起草默认模板
          <select
            value={defaultTemplateId}
            onChange={(event) => setDefaultTemplateId(event.target.value)}
            disabled={!workspacePath}
          >
            <option value="">内置基础版式</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id} disabled={!template.supportsFreeDraft}>
                {template.title}{template.supportsFreeDraft ? '' : '（缺少 draft_body）'}
              </option>
            ))}
          </select>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={autoScanTemplates}
            onChange={(event) => setAutoScanTemplates(event.target.checked)}
            disabled={!workspacePath}
          />
          自动扫描本地模板文件夹
        </label>
        <p className="muted">
          模板目录：
          <code>{templateDir || '当前工作区/.legalbiz/templates/docx'}</code>
        </p>
        <p className="muted">
          选择的模板需要包含 <code>{'{draft_body}'}</code> 占位符。若模板失效或缺少正文占位符，导出时会回退到内置基础版式。
        </p>
        <div className="button-row end">
          <button
            type="button"
            onClick={async () => {
              if (!templateDir) {
                setStatus('模板目录还未准备好。')
                return
              }
              await openInFinder(templateDir)
            }}
            disabled={!workspacePath}
          >
            <FolderOpen size={14} /> 打开模板目录
          </button>
          <button type="button" className="primary" onClick={persistDefaultTemplate} disabled={!workspacePath}>
            <Save size={14} /> 保存默认模板
          </button>
        </div>
      </section>
    </div>
  )
}
