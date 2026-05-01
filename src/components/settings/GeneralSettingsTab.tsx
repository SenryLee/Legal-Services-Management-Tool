import { useEffect, useState } from 'react'
import { FolderOpen, Trash2 } from 'lucide-react'
import { getDefaultWorkspaceRoot, openInFinder } from '../../storage'

export default function GeneralSettingsTab({
  workspacePath,
  recents,
  onClearRecents,
  setStatus,
}: {
  workspacePath: string
  recents: string[]
  onClearRecents: () => void
  setStatus: (status: string) => void
}) {
  const [defaultRoot, setDefaultRoot] = useState('')

  useEffect(() => {
    getDefaultWorkspaceRoot().then(setDefaultRoot).catch(() => setDefaultRoot(''))
  }, [])

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
    </div>
  )
}
