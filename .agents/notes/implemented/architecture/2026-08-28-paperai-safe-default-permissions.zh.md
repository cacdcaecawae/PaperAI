# Agent Note: PaperAI 继承 DSH 的安全权限默认值

Status: implemented

[English](2026-08-28-paperai-safe-default-permissions.md) | 中文

## 问题

PaperAI 产品组合包曾覆盖 DSH 权限配置行，使每个新会话都以 `danger-full-access` 和批准策略 `never` 启动。用户尚未选择权限时，Agent 就已经获得不受限制的文件系统和命令执行能力。既有 DSH 完全访问选择器要求用户明确确认风险，但由产品组合包自动设置的默认值不会经过这条交互路径。

该覆盖还让 PaperAI 成为权限默认值的第二个属主，可能与固定版本的 DSH 底座发生漂移，并且没有用独立架构记录说明这一影响整个产品的安全决策。

## 决策

PaperAI 不再覆盖 `sandbox-policy` 或 `approval` 配置行。没有已保存的权限设置以及部署或 profile 覆盖时，产品 profile 继承 `@deepseek-ai/dsh-base` 持有的值：沙箱为 `workspace-write`，批准策略为 `ask`。已保存的 `permissionPresets.defaultPreset`、`DSH_PERMISSION_MODE` 或更高层配置仍可明确覆盖未来会话的默认值。

完全访问仍是可选的 DSH 权限 preset。用户在客户端主动选择时，需要完成既有风险确认。部署方仍可明确设置 `DSH_PERMISSION_MODE`；这是部署方主动做出的配置选择，而不是 PaperAI 静默启用的产品默认值。

该变更影响新创建会话的默认值。恢复的会话继续使用日志中记录的权限状态，因此重新打开会话不会静默替换其历史产生时采用的权限。

PaperAI 会把每个 DSH 沙箱 preset 投影为提供方正式支持的原生 ACP 权限模式。Codex 把 `read-only`、`workspace-write` 和 `danger-full-access` 分别映射为 `read-only`、`agent` 和 `agent-full-access`；Claude 分别映射为 `plan`、`acceptEdits` 和 `bypassPermissions`。Codex 进程启动时还会通过 `INITIAL_AGENT_MODE` 接收同一目标。新建和加载的提供方会话必须声明目标模式，并在 Agent 发布前校准当前模式。空闲时的 `sandbox/mode` 变更会依次通过 ACP `session/set_mode` 同步，下一次 prompt 会等待最终选择生效。提供方活动回合中切换到更严格的模式会撤销进程代际并取消该回合；替代进程会从 Session 当前状态重新推导模式。每个模式请求都会组合 Agent 生命周期、进程代际和调用方取消信号，因此取消操作撤销代际后，无响应的提供方请求无法继续卡住关闭流程或替代 prompt。如果提供方没有声明目标模式，系统会明确报告提供方失败，不会虚构标识或继续保留不一致的模式。

Codex 与 Claude 的 ACP 客户端文件回调通过 `ctx.fs` 解析。每次最终写入都会携带 `ctx.sandboxPolicy.resolve({ session })` 的结果，因此即使 ACP provider 漏掉或错误处理权限请求，当前 Session 模式与 Workspace 根目录仍会被强制执行。每个 ACP 进程都持有不可复用的文件 I/O 代际，并与请求、当前 Agent 活动和 handle 生命周期信号共同约束操作。取消 turn 会永久撤销该代际；后续 turn 会先关闭旧进程，再在新进程中恢复 Provider 会话，之后才接受回调，因此旧延迟请求无法借用新 turn 的权限。通用 ACP 权限响应不会放宽之后的文件回调：协议没有在 `fs/write_text_file` 上提供授权标识，把最近一次批准当作无范围限制的文件系统能力并不安全。

## 验证

PaperAI 组合包测试禁止产品层持有 `sandbox-policy` 和 `approval` 配置行。构建版 CLI 配置转储测试组合真实 `paperai` profile，并以快照确认两个有效配置行都来自 DSH base，默认值分别为 `workspace-write` 和 `ask`。Keyless Web 快照会启动 PaperAI overlay，捕获新会话的 Workspace Write 控件，执行一次真实的 Read Only 切换，并保留 Session 事件断言。ACP 集成测试会穿过两个提供方的运行时协议适配层，覆盖新建、加载、运行中切换、prompt 顺序、重启、无响应模式请求的取消和未声明模式路径。活动回合收紧权限的测试证明旧代际会先被取消，替代进程再以 Read Only 启动。同一测试套件还会在平台临时目录之外使用彼此分离的 fallback 根和 Session 根：Workspace 内写入成功，fallback 根写入与只读模式写入在最终文件操作处失败；已经派发的写入会收到被撤销的代际信号，且不能在替代 turn 通过新进程恢复 ACP 会话时发布。

## 曾考虑的替代方案

**保留完全访问默认值，只显示信息警告。** 警告不等于权限选择，产品仍会在用户确认前授予不受限制的权限。

**在创建 PaperAI 项目时增加专用确认。** 这会重复 DSH 权限选择器，并让同一会话状态由两条 UI 路径共同负责。

**默认只读。** PaperAI 必须在选中的论文 Workspace 内创建和修改文件。只读会让普通文档工作不断触发权限升级请求。

**在 PaperAI patch 中重复 DSH 的安全值。** 复制 `workspace-write` 和 `ask` 虽然能得到当前正确值，但仍保留两个属主，并允许未来再次漂移。删除覆盖可以维持单一真源。

**只依赖 ACP 权限回调和 DSH 文件回调，不改变提供方模式。** 这些回调无法约束提供方原生的 shell 与编辑工具，因此 UI 可能显示只读，而提供方仍保留写权限。

**定义 PaperAI 专用的提供方模式标识，或在模式缺失时静默回退。** 原生模式语义由提供方持有。虚构或替换的值要么会被拒绝，要么会掩盖权限不一致。

## 后果

采用未覆盖的 base 默认值时，新的 PaperAI 会话可以在 Workspace 内写入，并在操作需要更高权限时请求批准。不受限制的文件系统修改和命令执行需要用户或部署方明确选择。提供方原生工具与最终 DSH 文件系统回调都会遵循 Session preset，包括恢复、运行中切换或进程替换之后。当前环境隐藏所需提供方模式时，该权限选择会明确失败，不会继续使用不一致的权限。PaperAI 与 DSH 底座共用同一条经过测试的权限生命周期，并在提供方声明支持时保留标准完全访问选项。
