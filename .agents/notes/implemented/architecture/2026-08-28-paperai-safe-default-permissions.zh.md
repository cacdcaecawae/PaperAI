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

Codex 与 Claude 的 ACP 客户端文件回调通过 `ctx.fs` 解析。每次最终写入都会携带 `ctx.sandboxPolicy.resolve({ session })` 的结果，因此即使 ACP provider 漏掉或错误处理权限请求，当前 Session 模式与 Workspace 根目录仍会被强制执行。每个 ACP 进程都持有不可复用的文件 I/O 代际，并与请求、当前 Agent 活动和 handle 生命周期信号共同约束操作。取消 turn 会永久撤销该代际；后续 turn 会先关闭旧进程，再在新进程中恢复 Provider 会话，之后才接受回调，因此旧延迟请求无法借用新 turn 的权限。通用 ACP 权限响应不会放宽之后的文件回调：协议没有在 `fs/write_text_file` 上提供授权标识，把最近一次批准当作无范围限制的文件系统能力并不安全。

## 验证

PaperAI 组合包测试禁止产品层持有 `sandbox-policy` 和 `approval` 配置行。构建版 CLI 配置转储测试组合真实 `paperai` profile，并以快照确认两个有效配置行都来自 DSH base，默认值分别为 `workspace-write` 和 `ask`。Web scaffold 测试会启动 PaperAI overlay，并证明真实新 Session 会记录 `workspace-write` preset、`workspace-write` 沙箱模式和 `ask` 批准策略。ACP 集成测试在平台临时目录之外使用彼此分离的 fallback 根和 Session 根：Workspace 内写入成功，fallback 根写入与只读模式写入在最终文件操作处失败；已经派发的写入会收到被撤销的代际信号，且不能在替代 turn 通过新进程恢复 ACP 会话时发布。

## 曾考虑的替代方案

**保留完全访问默认值，只显示信息警告。** 警告不等于权限选择，产品仍会在用户确认前授予不受限制的权限。

**在创建 PaperAI 项目时增加专用确认。** 这会重复 DSH 权限选择器，并让同一会话状态由两条 UI 路径共同负责。

**默认只读。** PaperAI 必须在选中的论文 Workspace 内创建和修改文件。只读会让普通文档工作不断触发权限升级请求。

**在 PaperAI patch 中重复 DSH 的安全值。** 复制 `workspace-write` 和 `ask` 虽然能得到当前正确值，但仍保留两个属主，并允许未来再次漂移。删除覆盖可以维持单一真源。

## 后果

采用未覆盖的 base 默认值时，新的 PaperAI 会话可以在 Workspace 内写入，并在操作需要更高权限时请求批准。不受限制的文件系统修改和命令执行需要用户或部署方明确选择。ACP 文件回调会一直保持受限，直到 Session preset 本身发生变化；这样不会从无关的 provider 批准中臆造宽泛授权。PaperAI 与 DSH 底座共用同一条经过测试的权限生命周期，并保留标准完全访问选项供确有需要的用户使用。
