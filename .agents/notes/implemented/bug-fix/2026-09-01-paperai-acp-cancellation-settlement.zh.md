# Agent Note: PaperAI ACP 取消以提供方响应作为结算点

Status: implemented

[English](2026-09-01-paperai-acp-cancellation-settlement.md) | 中文

## 问题

把出站 ACP prompt 请求绑定到 DSH turn 信号后，该信号一旦中止，SDK 就会立即拒绝本地请求。即使继续等待这个已经拒绝的 Promise，DSH turn 投影仍会在提供方发送工具终态更新和 cancelled 响应之前关闭。

## 决策

取消之后，ACP prompt 仍是结算属主。PaperAI 不会把 prompt 请求或已建立的提供方进程绑定到 DSH turn 信号；它会发送 ACP Session 取消，退役模式请求和文件回调所使用的操作代际，中止该 turn，然后继续等待原始 prompt 请求。排在提供方最终响应之前的 Session 更新仍会进入活动 turn 投影。只有收到响应后，PaperAI 才完成 interrupted assistant 投影，并追加 `step/end` 和 `turn/end`。

进程生命期跟随 Agent 生命周期和显式运行时关闭，与操作代际分离。替换运行时尚在启动时，turn 信号可以取消初始化；但启动成功后，取消该 turn 不能在提供方处理 `session/cancel` 前终止进程。下一个需要运行时的操作会关闭已取消的进程，并在新进程中恢复提供方 Session。

模式选择和启动请求继续保留显式中止竞速。这些操作不会发布 turn transcript，而且其进程代际可以替换，因此撤销代际后放弃本地等待不会丢失有顺序要求的模型输出。

## 曾考虑的替代方案

**DSH 信号中止时立即关闭投影。** 这种方式看起来响应迅速，却把本地信号误当成提供方结算点，并会丢失协议顺序中的工具终态更新。

**用固定宽限时间保持投影。** 定时器无法识别最后一条更新，还会让正确性依赖提供方和机器时序。

**turn 关闭后接受迟到更新。** 工具结果必须位于所属 step 和 turn 内；稍后追加会破坏 transcript 顺序。

## 验证

子进程集成 fixture 会先打开工具调用，等待 ACP 取消，再发送 completed 更新，最后返回 `cancelled`。测试要求 `tool/call`、`tool/result`、`step/end` 和 `turn/end` 按此顺序出现，同时包含 interrupted assistant 投影和 aborted turn。它还会拒绝一次原生权限模式，启动替换运行时，并证明取消其第一个 turn 仍保留工具终态结果。活动权限切换测试还会在替换运行时并提交新权限 preset 之前经过同一结算流程。无密钥 PaperAI 浏览器场景会让已交付 Codex preset 连接该外部进程 fixture，在权限切换被拒后停止运行中的 turn，并在组装后的对话 UI 中快照最终工具结果。

## 后果

取消仍会立即撤销文件权限，而 transcript 关闭会等待固定版本的提供方适配器结算 prompt。违反 ACP、取消后永不响应的提供方可能延迟 `whenIdle()` 和释放；PaperAI 不会用超时截断有效的终态更新。
