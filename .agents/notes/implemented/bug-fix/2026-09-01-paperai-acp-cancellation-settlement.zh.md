# Agent Note: PaperAI ACP 取消以提供方响应作为结算点

Status: implemented

[English](2026-09-01-paperai-acp-cancellation-settlement.md) | 中文

## 问题

把出站 ACP prompt 请求绑定到 DSH turn 信号后，该信号一旦中止，SDK 就会立即拒绝本地请求。即使继续等待这个已经拒绝的 Promise，DSH turn 投影仍会在提供方发送工具终态更新和 cancelled 响应之前关闭。

## 决策

ACP prompt 只有在已经发送后，才会在取消后继续作为结算属主。PaperAI 会先解析 prompt block，再在发送前立即检查 DSH turn 信号，因此取消只要在这段间隔内胜出，就不会启动提供方工作。prompt 一旦发送，PaperAI 就不会把其请求或已建立的提供方进程绑定到 turn 信号；它会发送 ACP Session 取消，退役模式请求和文件回调所使用的操作代际，中止该 turn，然后继续等待原始 prompt 请求。排在提供方最终响应之前的 Session 更新仍会进入活动 turn 投影。只有收到响应后，PaperAI 才完成 interrupted assistant 投影，并追加 `step/end` 和 `turn/end`。

进程生命期跟随 Agent 生命周期和显式运行时关闭，与操作代际分离。替换运行时尚在启动时，turn 信号可以取消初始化；但启动成功后，取消该 turn 不能在提供方处理 `session/cancel` 前终止进程。下一个需要运行时的操作会关闭已取消的进程，并在新进程中恢复提供方 Session。

模式选择和启动请求继续保留显式中止竞速。这些操作不会发布 turn transcript，而且其进程代际可以替换，因此撤销代际后放弃本地等待不会丢失有顺序要求的模型输出。提供方模型发现与选择使用同一个 FIFO 操作队列。取消把运行时标记为需要替换后，只有队首操作会进入 maintenance 完成恢复；后续模型操作会等待该结果，不能争抢 maintenance 阶段。所有已接收的模型操作结算前，唤醒请求会保持预约状态，因此待处理 turn 能看到队列中的最终选择。释放过程会停止接收新的模型操作、等待已接收队列结算，然后才拆除提供方运行时和 Agent scope。

## 曾考虑的替代方案

**DSH 信号中止时立即关闭投影。** 这种方式看起来响应迅速，却把本地信号误当成提供方结算点，并会丢失协议顺序中的工具终态更新。

**用固定宽限时间保持投影。** 定时器无法识别最后一条更新，还会让正确性依赖提供方和机器时序。

**turn 关闭后接受迟到更新。** 工具结果必须位于所属 step 和 turn 内；稍后追加会破坏 transcript 顺序。

## 验证

子进程集成 fixture 会先打开工具调用，等待 ACP 取消，再发送 completed 更新，最后返回 `cancelled`。测试要求 `tool/call`、`tool/result`、`step/end` 和 `turn/end` 按此顺序出现，同时包含 interrupted assistant 投影和 aborted turn。第二个测试会在准备 prompt 与发送 prompt 之间的微任务中取消，要求提供方收到零个 prompt，并证明替换运行时可以接受下一回合。取消后的并发模型发现与选择必须通过同一个替换运行时完成，在待处理 turn 启动前应用最终选择，并在释放完成前全部结算。权限测试还会拒绝原生模式、保留工具终态输出，并且只在结算后提交替换模式。无密钥 PaperAI 浏览器场景会通过已交付 Codex preset 与组装后的会话 UI，同时覆盖发送前取消和由提供方结算的工具终态结果。

## 后果

取消仍会立即撤销文件权限，而 transcript 关闭会等待固定版本的提供方适配器结算 prompt。违反 ACP、取消后永不响应的提供方可能延迟 `whenIdle()` 和释放；PaperAI 不会用超时截断有效的终态更新。
