# paperai/ — academic document product capabilities

English | [中文](README.zh.md)

PaperAI-owned Cordis packages layered over the pinned DeepSeek Harness platform. These packages contain academic-document vocabulary, Word operations, template contracts, document commits, gates, exports, MCP commands, ACP integration, and product UI without duplicating generic DSH Host or client behavior.

| Package | Role | ctx key |
|---|---|---|
| [`domain/`](domain/README.md) | Transport-neutral document, template, gate, and commit vocabulary | — |
| [`document-engine/`](document-engine/README.md) | Word document-engine Service Definition | `documentEngine` |
| [`document-engine-officecli/`](document-engine-officecli/README.md) | Local OfficeCLI Service Provider | `documentEngine` |
| [`repository/`](repository/README.md) | SQLite-routed durable document metadata | `paperRepository` |

Product packages use the `@paperai/*` scope to keep ownership distinct from the retained `@deepseek-ai/dsh-*` upstream packages. They follow the same package, invariant, documentation, and test contracts.
