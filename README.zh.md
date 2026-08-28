# PaperAI

[English](README.md) | 中文

PaperAI 是一个本地运行、由 Agent 驱动的学术 Word 工作台。产品始终以一份 Working DOCX 作为可编辑权威，让 Codex、Claude 或内置 DeepSeek Harness Agent 通过同一套带版本的文档工具协作，并在正式导出前按照已确认的学校模板执行门禁检查。

产品建立在固定版本的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 客户端、Host、会话、设置、模型、权限和插件底座上。PaperAI 增加文档、模板、提交、MCP、ACP 与工作台产品层，同时保留 DSH 原有的交互语言。

## 第一版工作流

- 选择本地工作区；PaperAI 会幂等初始化项目目录和 Git 仓库。
- 直接导入 `.docx`；Windows 下可通过只读 Microsoft Word 自动化把旧版 `.doc` 规范化为独立 DOCX。
- 选择内置“HIT 硕士毕设”模板包，或上传自定义 Word 模板，审阅解析出的合同并确认。
- 每次只编辑一个语义段落，也可以让本地 Codex/Claude ACP Agent 使用经过身份验证的 PaperAI MCP 工具。
- 每次人工或 Agent 文档修改都会形成可恢复版本，并记录操作者、客户端、Provider 与模型来源。
- 草稿可随时导出；正式交付必须先通过已确认模板的门禁。

原始 Word 文件和模板始终保留不变。OfficeCLI 只对派生的 Working 副本生成预览并执行结构化修改。

<a id="run-from-source"></a>

## 从源码运行

需要 Node.js、pnpm、Git，以及准备使用的本地 ACP Provider。只有在 Windows 上规范化旧版 `.doc` 时才需要 Microsoft Word 桌面版。

```sh
git clone https://github.com/cacdcaecawae/PaperAI.git
cd PaperAI
pnpm install
pnpm run build
pnpm paperai
```

Provider API Key 与接口地址可直接在 DSH 原生设置页面配置。无法使用的本地依赖会显示明确的降级状态，不会留下无效按钮。

## 架构与开发

- 产品决策：[PaperAI 产品 Profile ADR](.agents/notes/implemented/architecture/2026-08-28-paperai-product-profile.zh.md)
- DSH 架构：[docs/architecture.zh.md](docs/architecture.zh.md)
- 开发指南：[docs/development.zh.md](docs/development.zh.md)
- Agent 约定：[AGENTS.md](AGENTS.md)

## 许可证与署名

PaperAI 代码与保留的 DeepSeek Harness 底座按 [MIT](LICENSE) 分发。DeepSeek Harness 署名及直接依赖许可证完整保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。学校模板资产不由 PaperAI 重新授权，详见模板包的[资产说明](packages/paperai/template-pack-hit/ASSET_NOTICE.md)。
