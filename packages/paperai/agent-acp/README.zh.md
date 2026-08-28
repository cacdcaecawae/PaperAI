# @paperai/agent-acp

[English](README.md) | 中文

PaperAI 的 Codex 与 Claude 同级顶层 Agent 驱动。插件保留 DSH 原生 Agent Loop 作为默认工厂，并注册由固定版本本地 ACP 适配器提供的 `codex` 与 `claude` 精确路由。ACP 会话模型选项接入现有 DSH 模型选择器，ACP 权限请求则复用现有 DSH 权限与审批界面。

每个返回的 handle 负责其已发布的 Agent、DSH Session 与本地 ACP 进程。释放操作会等待三者完全停止；启动失败会回滚尚未发布的生命周期，使同一 Session ID 可以重试；prompt 响应之前发送的 ACP 更新会在 DSH turn 关闭前完成投影。

每个 ACP 会话还独占一份经过身份验证的 PaperAI MCP 描述符。描述符会在 ACP `session/new` 或 `session/load` 时传入，随 Provider 模型切换同步提交来源，并在 Agent handle 释放时撤销。因此 Codex 与 Claude 会和人工工作台共用文档提交、模板门禁、历史、回退与导出服务；MCP 服务缺失会明确导致启动失败，不会静默退化成只改文件系统。

## 模型体验

### Codex 与 Claude ACP 会话

#### 模型看到的内容

选中的 `codex` 或 `claude` 适配器通过其 ACP 会话接收普通用户输入和一份经过身份验证的 PaperAI MCP 描述符。本包不持有提示词字面量或工具 schema；描述符中的模型可见工具与结果由 `@paperai/mcp` 负责。

#### Token 影响

本包持有的提示词 token 为零。用户输入与 Provider 持有的 ACP 上下文照常消耗 token，描述符启用的 schema 和结果 token 则由 MCP 包负责。

#### KV Cache 影响

每个本地 ACP 进程负责 Provider 请求与缓存复用。创建或加载会话、切换所选 Provider 模型或替换 MCP 描述符可能改变后续请求前缀；本包不保留或保证 Provider KV cache 条目。

## 已知限制与延后工作

- **本地 Provider 依赖** — `codex` 与 `claude` 路由依赖固定版本的本地 ACP 适配器和 Provider 身份验证；命令启动或握手失败会拒绝创建 Agent。
- **能力投影** — ACP Agent 通过经过身份验证的 MCP 描述符获得 PaperAI 文档能力。DSH 原生 Loop 工具不会自动映射到 ACP Provider 会话。
