# paperai/ — 论文文档产品能力

[English](README.md) | 中文

PaperAI 自有 Cordis 包构建在固定版本的 DeepSeek Harness 平台之上。这些包包含论文文档词汇、Word 操作、模板约定、文档提交、门禁、导出、MCP 命令、ACP 集成和产品 UI，不重复实现通用 DSH Host 或客户端行为。

| 包 | 职责 | ctx key |
|---|---|---|
| [`domain/`](domain/README.zh.md) | 与传输无关的文档、模板、门禁和提交词汇 | — |
| [`document-engine/`](document-engine/README.zh.md) | Word 文档引擎 Service Definition | `documentEngine` |
| [`document-engine-officecli/`](document-engine-officecli/README.zh.md) | 本地 OfficeCLI Service Provider | `documentEngine` |
| [`repository/`](repository/README.zh.md) | 路由到 SQLite 的持久文档元数据 | `paperRepository` |

产品包使用 `@paperai/*` scope，使其所有权与保留的上游 `@deepseek-ai/dsh-*` 包明确区分。它们遵循相同的包、invariant、文档和测试约定。
