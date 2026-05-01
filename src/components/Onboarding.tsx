import { FileSpreadsheet, FolderOpen, GitCompareArrows, Plus, ShieldCheck, Sparkles } from 'lucide-react'

export default function Onboarding({
  onCreate,
  onOpen,
  onDemo,
}: {
  onCreate: () => void
  onOpen: () => void
  onDemo: () => void
}) {
  return (
    <div className="onboarding">
      <section>
        <h2>选择一个文件夹作为法律业务工作区</h2>
        <p>
          系统会在该文件夹下创建 clients、contracts、matters、invoices、calendar 等目录。
          每条记录都是独立 Markdown，台账按月动态汇总，工作区也可以直接用 Obsidian 等工具打开。
        </p>
        <div className="quick-paths">
          <button type="button" onClick={onCreate}>
            <Plus size={16} /> 新建工作区
          </button>
          <button type="button" onClick={onOpen}>
            <FolderOpen size={16} /> 打开已有工作区
          </button>
          <button type="button" className="ghost" onClick={onDemo}>
            <Sparkles size={16} /> 创建并载入示例
          </button>
        </div>
      </section>
      <section className="principles">
        <div>
          <ShieldCheck size={22} />
          <strong>完全本地化</strong>
          <span>无账号、无服务器、默认离线。</span>
        </div>
        <div>
          <FileSpreadsheet size={22} />
          <strong>Markdown 主数据</strong>
          <span>外部编辑、版本管理、跨工具友好。</span>
        </div>
        <div>
          <GitCompareArrows size={22} />
          <strong>先利冲再立项</strong>
          <span>历史客户、相对方、关联方本地检索。</span>
        </div>
      </section>
    </div>
  )
}
