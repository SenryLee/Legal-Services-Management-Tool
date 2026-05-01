# 法律人业务管理系统

本项目是一个完全本地化的法律业务管理桌面 App 原型。技术栈为 Tauri 2 + React + TypeScript。数据以 Markdown + YAML Frontmatter 为主，SQLite 仅作为后续可重建索引预留。

## 已实现范围

- 固定业务板块：客户管理、立冲检查、服务合同、诉讼管理、非诉管理、开票管理、日历管理、AI 填表、字段设置。
- 工作区模型：用户输入本地文件夹路径后，Tauri 后端创建标准目录和 `.legalbiz/config.json`。
- 单事项 Markdown：新增记录会写入对应目录下的独立 `.md` 文件。
- 月度台账快照：可从单事项 Markdown 汇总生成 `ledgers/{year}/{yyyy-mm}-{type}.md`。
- 字段级自定义：固定大板块，支持对各板块新增字段、控制是否进入台账、是否可筛选。
- 利益冲突检查：基于本地记录中的客户、相对方、关联方等字段做结构化检索，输出疑似命中。
- AI 填表预留：当前提供本地规则抽取草稿；未来可替换为本地模型或用户自配云端 API。草稿必须经用户确认后写入。
- Excel 导出：按当前筛选结果导出 `.xlsx`。

## 本地开发

```bash
npm install
npm run dev
```

没有 Tauri 环境时，浏览器会使用演示工作区 fallback，便于查看和调试界面。

## 桌面开发

需要先安装 Rust 工具链：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
npm run tauri:dev
```

## 打包安装包

```bash
npm run tauri:build
```

Tauri 配置已启用 macOS `dmg` 和 Windows `msi` / `nsis` 目标。实际跨平台产物通常需要在对应系统上构建。

## 工作区结构

```text
.legalbiz/config.json
.legalbiz/index.db
clients/{client-id}/index.md
contracts/{contract-id}/index.md
matters/{year}/{matter-id}/index.md
conflict-checks/{year}/{check-id}.md
invoices/{year}/{invoice-id}.md
calendar/{year}/{event-id}.md
ledgers/{year}/{yyyy-mm}-{type}.md
templates/
```

`index.db` 是预留索引缓存，不是事实来源。删除后应能从 Markdown 和配置文件重建。
