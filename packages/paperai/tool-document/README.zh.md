# `@paperai/tool-document`

[English](README.md) | 中文

面向 PaperAI 写作智能体的原生 DSH 文档工具。十个 `paperai_*` 工具与 [PaperAI MCP 工具面](../mcp/README.zh.md)保持完全相同的名称与结果字段，因此内置智能体、Codex 与 Claude 共用一套文档词汇，而每条路线最终到达的都是同一批 Host 域服务。

## 功能

在 `ctx.tools` 上注册十个工具：`paperai_list_projects`、`paperai_list_documents`、`paperai_read_document`、`paperai_list_templates`、`paperai_get_template`、`paperai_list_versions`、`paperai_check_gate`、`paperai_prepare_export`、`paperai_commit_document` 与 `paperai_revert_document`。处理器委托给 `ctx.paperProjects`、`ctx.paperDocuments`、`ctx.paperTemplates` 与 `ctx.paperCommits`；本包不拥有任何领域规则。`bind-template` 修改的契约有效性由 `paperCommits.submit()` 负责，其 `validateAssociation` 调用拥有确认状态与角色兼容性检查。

## 访问范围

每次调用都以调用会话为界：`ctx.sandboxPolicy` 解析出会话的工作区根目录与当前生效的沙箱模式（与文件系统工具同一套折叠），`paperProjects.resolveForPath()` 找到拥有该根目录的项目，十个工具只接受属于这个项目的项目、文档与模板记录，其他项目的记录一律以 `PROJECT_OUT_OF_SCOPE` 拒绝；没有项目拥有会话工作区时以 `NO_PROJECT_FOR_SESSION` 拒绝。`read-only` 沙箱模式下读取照常，`paperai_commit_document` 与 `paperai_revert_document` 以 `READ_ONLY_SESSION` 拒绝；`danger-full-access` 放宽的是文件系统，不放宽文档范围。这些检查是 `@paperai/domain` 提供的共享原语，PaperAI MCP 桥对 Codex 与 Claude 施加同一套约束。

## 溯源

每次提交与回退都会盖上调用方 DSH 会话的身份：`kind: 'agent'`、`name: 'DSH'`、`client: 'dsh'`、会话 id，以及 provider 与 model 路由。路由取自会话最新的持久 `request/header`——循环在每次模型请求前写入它——因此用户在会话中途通过模型选择器切换模型后，版本账本记录的是实际写作的模型；在任何请求发生之前才回退到创建时的路由。没有归属 agent 的调用会被拒绝，否则其提交在版本账本中无从追溯。这正是版本历史中内置智能体的修改能与 Codex、Claude 条目区分开的原因。

## 门禁摘要

`paperai_commit_document` 与 `paperai_revert_document` 返回 `{ commit, provenance, gateSummary }`，其中 `gateSummary` 是 `@paperai/domain` 共享的 `summarizeGate()` 对提交上已存储的 continuous 门禁报告的摘要：按严重度计数、最严重的发现排在前面，并给出一条可执行的中文下一步；未关联模板时给出明确的自由模式提示。Native 渲染以新版本 id 和该下一步开头。

## 配置

- `defaultNodesPerRead`（默认 `80`）——读取未指定 `limit` 时的节点页大小。
- `maxNodesPerRead`（默认 `200`）——单次读取节点页的上限。
- `maxMutationsPerCommit`（默认 `64`）——单次提交的最大有序修改数。

默认值与 PaperAI MCP 的限制一致。非正数、不安全整数或默认值超过上限都会使插件加载失败。

## 渲染

所有渲染意图均为 generic 卡片：读取工具把规范 JSON 作为 Native 文本返回，变更工具在 JSON 前加一行携带门禁下一步的提交确认。不适用 diff 或 terminal 卡片——修改针对的是语义 Word 节点，不是 UI 可以做 diff 的文件。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，没有 default，以保留 loader 注入元数据。

## Model Experience

### 工具 schema

#### 模型看到什么

模型看到生成的 [`paperai_*` schema](../../../docs/tool-catalog.zh.md#paperaitool-document)，以及以规范 JSON 渲染的各结果；提交结果以版本 id 与门禁下一步开头。

#### Token 影响

工具可见的每个请求都承担固定的 schema 成本。读取结果随请求的节点页大小伸缩；`defaultNodesPerRead` 与 `maxNodesPerRead` 是其边界。

#### KV Cache 影响

schema 在会话内保持稳定，工具目录不会扰动提供方的前缀缓存。

## Known Limitations and Deferred Work

- 没有 `paperai_export_document`：文件发布仍归工作台与 MCP 导出适配器；agent 通过 `paperai_prepare_export` 预检并汇报。
- 溯源取自会话最新的 `request/header`；一次工具调用总在其所属回合的请求头落盘之后发生，因此不存在滞后窗口，但在首个请求之前发生的提交只能记录创建路由。
