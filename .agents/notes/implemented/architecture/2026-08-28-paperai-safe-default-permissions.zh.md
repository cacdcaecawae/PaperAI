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

PaperAI 会把每个 DSH 沙箱 preset 投影为提供方正式支持的原生 ACP 权限模式。Codex 把 `read-only`、`workspace-write` 和 `danger-full-access` 分别映射为 `read-only`、`agent` 和 `agent-full-access`；Claude 分别映射为 `plan`、`acceptEdits` 和 `bypassPermissions`。Codex 进程启动时还会通过 `INITIAL_AGENT_MODE` 接收同一目标。新建和加载的提供方会话必须声明目标模式，并在 Agent 发布前校准当前模式。用户发起的 `/permission` 切换会经过可等待、按 Agent 划分作用域的提交前 waterfall：ACP 驱动先通过 `session/set_mode` 应用目标，再委托后续处理，让 preset、沙箱和审批事件持久化。提供方拒绝会使命令失败，而不会改变 Session 投影。命令记录会省略提供方异常文本并使用客户端本地化兜底文案，Host 日志仍保留诊断。活动回合中发生切换时，会先预约 maintenance，再撤销进程代际，取消并排空该回合，让替代运行时以目标模式启动或完成同步，最后才委托后续处理。该预约会在 running 到 idle 的转换期间阻止自动唤醒，并只在提交或失败后重放已请求的唤醒，因此排队输入不能以旧原生模式启动。并发切换会失败，但不会释放其他切换的预约。waterfall 所有者会在持久提交点检查命令信号，防止已中止的异步监听器追加权限事件。命令以外直接写入的 `sandbox/mode` 事件仍会通过校准观察器按顺序处理，下一次 prompt 会等待最终选择生效。每个模式请求都会组合 Agent 生命周期、进程代际和调用方取消信号，因此取消操作撤销代际后，无响应的提供方请求无法继续卡住关闭流程或替代 prompt。如果提供方没有声明目标模式，系统会明确报告提供方失败，不会虚构标识或继续保留不一致的模式。

Codex 与 Claude 的 ACP 客户端文件回调通过 `ctx.fs` 解析。每次最终写入都会携带 `ctx.sandboxPolicy.resolve({ session })` 的结果，因此即使 ACP provider 漏掉或错误处理权限请求，当前 Session 模式与 Workspace 根目录仍会被强制执行。每个 ACP 进程都持有不可复用的文件 I/O 代际，并与请求、当前 Agent 活动和 handle 生命周期信号共同约束操作。取消 turn 会永久撤销该代际；后续 turn 会先关闭旧进程，再在新进程中恢复 Provider 会话，之后才接受回调，因此旧延迟请求无法借用新 turn 的权限。通用 ACP 权限响应不会放宽之后的文件回调：协议没有在 `fs/write_text_file` 上提供授权标识，把最近一次批准当作无范围限制的文件系统能力并不安全。

## 验证

PaperAI 组合包测试禁止产品层持有 `sandbox-policy` 和 `approval` 配置行。构建版 CLI 配置转储测试组合真实 `paperai` profile，并以快照确认两个有效配置行都来自 DSH base，默认值分别为 `workspace-write` 和 `ask`。Keyless Web 快照会在仅外部 ACP 边界使用 fake 进程的条件下启动 PaperAI overlay，捕获新会话的 Workspace Write 控件、执行一次真实的 Read Only 切换，并通过已交付 Codex preset 拒绝 `session/set_mode`；测试要求保留旧投影、显示本地化 Toast 与命令行，且页面不含提供方诊断。ACP 集成测试会穿过两个提供方的运行时协议适配层，覆盖新建、加载、持久化权限事件之前的命令拒绝、活动回合命令结算、排队跟进等待新模式提交、运行中切换、prompt 顺序、重启、无响应模式请求的取消和未声明模式路径。活动回合测试证明旧代际会先被取消，其工具终态更新完成投影，然后替代进程才以 Read Only 启动并提交权限事件，随后才发送排队输入。permission-presets 的 deferred 测试会在监听器启动后、委托前中止，并证明没有追加权限事件。同一测试套件还会在平台临时目录之外使用彼此分离的 fallback 根和 Session 根：Workspace 内写入成功，fallback 根写入与只读模式写入在最终文件操作处失败；已经派发的写入会收到被撤销的代际信号，且不能在替代 turn 通过新进程恢复 ACP 会话时发布。

## 曾考虑的替代方案

**保留完全访问默认值，只显示信息警告。** 警告不等于权限选择，产品仍会在用户确认前授予不受限制的权限。

**在创建 PaperAI 项目时增加专用确认。** 这会重复 DSH 权限选择器，并让同一会话状态由两条 UI 路径共同负责。

**默认只读。** PaperAI 必须在选中的论文 Workspace 内创建和修改文件。只读会让普通文档工作不断触发权限升级请求。

**在 PaperAI patch 中重复 DSH 的安全值。** 复制 `workspace-write` 和 `ask` 虽然能得到当前正确值，但仍保留两个属主，并允许未来再次漂移。删除覆盖可以维持单一真源。

**只依赖 ACP 权限回调和 DSH 文件回调，不改变提供方模式。** 这些回调无法约束提供方原生的 shell 与编辑工具，因此 UI 可能显示只读，而提供方仍保留写权限。

**定义 PaperAI 专用的提供方模式标识，或在模式缺失时静默回退。** 原生模式语义由提供方持有。虚构或替换的值要么会被拒绝，要么会掩盖权限不一致。

## 后果

采用未覆盖的 base 默认值时，新的 PaperAI 会话可以在 Workspace 内写入，并在操作需要更高权限时请求批准。不受限制的文件系统修改和命令执行需要用户或部署方明确选择。提供方原生工具与最终 DSH 文件系统回调都会遵循 Session preset，包括恢复、运行中切换或进程替换之后。当前环境隐藏所需提供方模式时，该权限选择会明确失败，不会继续使用不一致的权限。PaperAI 与 DSH 底座共用同一条经过测试的权限生命周期，并在提供方声明支持时保留标准完全访问选项。
