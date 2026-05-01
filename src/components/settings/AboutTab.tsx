export default function AboutTab() {
  return (
    <div className="settings-grid">
      <section className="panel about-panel">
        <h2>法律人业务管理系统</h2>
        <p className="muted">本地 Markdown 工作区 · v0.1</p>
        <ul className="info-list">
          <li>客户、利冲、合同、诉讼、非诉、开票、日历七个内置模块</li>
          <li>所有数据以独立 Markdown 文件保存，可用 Obsidian 等工具同时打开</li>
          <li>AI 解析支持 OpenAI / DeepSeek / Claude / 豆包(火山方舟) / 任意 OpenAI 兼容</li>
          <li>每条记录可挂附件目录；点表格 📎 图标即可管理</li>
          <li>无服务器、无账号；启动自动恢复上次工作区</li>
        </ul>
      </section>
    </div>
  )
}
