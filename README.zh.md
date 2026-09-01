<p align="center">
  <img src="docs/assets/paperai-logo.svg" width="92" alt="PaperAI 标志">
</p>

# PaperAI

[English](README.md) | 中文

<p align="center"><strong>面向学术写作、本地优先的 Word 原生 AI 工作台。</strong></p>

<p align="center">使用 Codex、Claude 或 DeepSeek Harness 写作，让每次修改都可恢复，并严格按照指定模板完成交付。</p>

<p align="center">
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-111827?style=flat-square"></a>
  <img alt="Node.js 22.19 或 24+" src="https://img.shields.io/badge/Node.js-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Word 原生" src="https://img.shields.io/badge/document-Word--native-2B579A?style=flat-square&logo=microsoftword&logoColor=white">
  <img alt="预发布" src="https://img.shields.io/badge/status-pre--release-EA580C?style=flat-square">
</p>

PaperAI 把 Working DOCX 作为学术文档的可编辑权威，而不是把 Markdown 或生成的 HTML 当作真源。人工编辑和本地 agent（智能体）使用同一套带版本的文档服务，已确认的学校模板则定义正式交付必须满足的检查要求。

产品建立在固定版本的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 底座上，并集成 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 完成 Word 检查、预览和结构化修改。

## PaperAI 提供什么

| 能力 | 含义 |
|---|---|
| Word 原生编辑 | 导入 `.docx`、保留原始源文件，并编辑独立且权威的 Working DOCX。 |
| 模板感知交付 | 使用内置的 HIT 硕士毕设模板包，或上传自定义 Word 模板；检查解析出的要求并确认后再使用。 |
| 多种 agent 路由 | 使用内置 DeepSeek Harness Agent，或通过 ACP（Agent Client Protocol）连接本地 Codex 和 Claude 适配器。 |
| 人工与 agent 能力一致 | 工作台和经过身份认证的 PaperAI MCP 工具调用同一套文档、模板、版本、恢复和导出服务。 |
| 可恢复历史 | 每次成功的人工或 agent 文档修改都会生成新版本，并记录操作者、客户端、提供方和模型来源。 |
| 正式导出检查 | 草稿可随时导出；正式交付必须满足已确认的模板要求。 |
| 本地优先运行 | 项目、源文件、Working 文档、模板、版本对象和应用状态均保留在本机。 |

## 文档工作流

1. **创建或接管工作区。** PaperAI 会幂等初始化项目目录和 Git 仓库。
2. **导入 Word 文档。** `.docx` 可直接导入；Windows 可通过只读 Microsoft Word 自动化规范化旧版 `.doc` 文件。
3. **关联模板。** 选择内置 HIT 模板包或上传自定义模板，然后检查并确认解析出的要求。
4. **由人工或 agent 写作。** 在工作台编辑语义章节，或让 Codex、Claude、DeepSeek Harness 使用 PaperAI 工具。
5. **审阅与恢复。** 检查修改来源、比较版本、解决并发编辑，或恢复较早的文档版本。
6. **明确选择导出方式。** 随时生成草稿，或在正式交付前运行模板检查。

原始 Word 文件和上传的模板是不可变输入。OfficeCLI 只为派生的 Working 副本生成预览并应用结构化修改。

<a id="run-from-source"></a>

## 从源码运行

### 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.7.0`
- Git
- 使用 Codex 或 Claude 时需要相应的本地 ACP 提供方
- 只有在 Windows 上规范化旧版 `.doc` 文件时才需要 Microsoft Word 桌面版

### 启动 PaperAI

```sh
git clone https://github.com/cacdcaecawae/PaperAI.git
cd PaperAI
pnpm install --frozen-lockfile
pnpm run build
pnpm paperai
```

提供方 API Key、接口地址、模型选择和权限模式均可在继承的 DSH 设置中配置。不可用的本地依赖会显示明确的降级状态，不会留下无效控件。

## 架构

| 层级 | 职责 |
|---|---|
| DSH 底座 | 插件运行时、agent loop（智能体循环）、会话、设置、权限、存储和共享客户端组件。 |
| PaperAI 工作台 | 工作区、对话、文档、模板、历史和交付体验。 |
| PaperAI 领域服务 | 项目、文档、模板、提交、冲突、门禁、导出、来源信息和经过身份认证的 MCP 操作。 |
| ACP 集成 | 使用提供方原生模型选择与权限模式的本地 Codex 和 Claude 会话。 |
| OfficeCLI 集成 | Word 结构检查、HTML 预览生成、结构化修改和文档验证。 |

请先阅读 [PaperAI 产品 Profile ADR](.agents/notes/implemented/architecture/2026-08-28-paperai-product-profile.zh.md)，再在修改包之前阅读[架构指南](docs/architecture.zh.md)。开发环境说明位于 [docs/development.zh.md](docs/development.zh.md)，仓库级 Agent 约定位于 [AGENTS.md](AGENTS.md)。

## 安全与隐私

- agent 权限使用可见的 DSH 权限控件；完全访问必须由用户明确选择。
- 选中的模型提供方可能收到 Agent 请求中包含的内容。PaperAI 本身不依赖托管式文档后端。
- 凭据应存放在本地设置或环境中，绝不能提交到仓库。
- Word 源文件和上传的模板与可修改的 Working 文档分开保存。
- 正式导出会按照文档所关联的已确认模板执行检查。

## 项目状态

PaperAI 是以源码分发的预发布软件。面向用户的工作流已经可用，但公开 API 和磁盘格式在首个正式标签发布前仍可能变化。请备份重要项目，并在提交前人工检查正式导出结果。

## 参与贡献

欢迎提交 Issue 和 PR（Pull Request）。环境配置、测试、文档和审查要求见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

## 许可证与致谢

PaperAI 代码与保留的 DeepSeek Harness 底座按 [MIT 许可证](LICENSE)分发。DeepSeek Harness 署名和直接依赖许可证保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)中。

学校模板资产不由 PaperAI 重新授权。内置 HIT 模板包在 [ASSET_NOTICE.md](packages/paperai/template-pack-hit/ASSET_NOTICE.md)中说明相关条款。
