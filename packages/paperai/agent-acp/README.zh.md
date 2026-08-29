# @paperai/agent-acp

[English](README.md) | 中文

PaperAI 的 Codex 与 Claude 同级顶层 Agent 驱动。插件保留 DSH 原生 Agent Loop 作为默认工厂，并注册由固定版本本地 ACP 适配器提供的 `codex` 与 `claude` 精确路由。ACP 会话模型选项接入现有 DSH 模型选择器，ACP 权限请求则复用现有 DSH 权限与审批界面。

每个返回的 handle 负责其已发布的 Agent、DSH Session 与本地 ACP 进程。释放操作会等待三者完全停止；启动失败会回滚尚未发布的生命周期，使同一 Session ID 可以重试；prompt 响应之前发送的 ACP 更新会在 DSH turn 关闭前完成投影。每个进程都会获得不可复用的文件 I/O 代际，并与协议请求、当前 Agent 活动和 handle 生命周期共同约束回调。取消操作会永久撤销该代际；下一个 turn 会先关闭旧进程，再在新进程中恢复 Provider 会话，之后才接受文件回调。

DSH Session 的沙箱 preset 也会选择提供方已声明的原生 ACP 权限模式。Codex 把 `read-only`、`workspace-write` 和 `danger-full-access` 分别映射为 `read-only`、`agent` 和 `agent-full-access`；Claude 分别映射为 `plan`、`acceptEdits` 和 `bypassPermissions`。Claude 的 `acceptEdits` 控制提供方原生文件编辑姿态；DSH 仍会在每次 ACP 客户端文件回调处执行 `workspace-write` 限制。Codex 进程启动时还会通过 `INITIAL_AGENT_MODE` 接收同一目标。新建和加载的会话会在发布前校准提供方声明的当前模式。空闲时的沙箱变更会依次通过 ACP `session/set_mode` 同步，下一次 prompt 会等待最终选择生效。提供方活动回合中切换到更严格的模式会撤销该进程代际并取消当前回合；替代进程会以 Session 当前模式启动。模式请求会组合 Agent 生命周期、进程代际和调用方取消信号，因此取消操作撤销代际后，无响应的提供方请求无法继续卡住关闭流程或替代 prompt。如果固定版本的适配器没有声明所需原生模式，启动或同步会明确失败；本包不会虚构提供方模式标识，也不会静默选择权限更弱的模式。

ACP 客户端文件回调使用已挂载的 DSH 文件系统，而不是直接调用 Node 文件系统。读取继续遵循 DSH 的读取策略；每次写入都会在最终文件操作处重新解析当前 Session 的沙箱模式和不可变 Workspace 根目录。`read-only` 拒绝写入，`workspace-write` 将写入限制在 Workspace 与平台临时目录内，完全访问则移除该限制。ACP 的 `session/request_permission` 响应不会隐式放宽后续文件回调，因为 ACP 不会把该批准与之后的 `fs/write_text_file` 请求绑定。

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
- **提供方模式可用性** — 完全访问要求固定版本的适配器声明其原生无限制模式。如果提供方在当前环境中隐藏该模式，选择 DSH preset 会明确失败，不会让两套权限状态保持不一致。
- **能力投影** — ACP Agent 通过经过身份验证的 MCP 描述符获得 PaperAI 文档能力。DSH 原生 Loop 工具不会自动映射到 ACP Provider 会话。
- **文件系统权限升级** — ACP 客户端文件回调始终执行 Session 当前的沙箱 preset。若要允许 Workspace 外写入，用户必须通过标准 DSH 权限控件把该 Session 切换为完全访问；之前的通用 ACP 批准不会产生无范围限制的文件系统授权。
