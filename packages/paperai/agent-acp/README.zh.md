# @paperai/agent-acp

[English](README.md) | 中文

PaperAI 的 Codex 与 Claude 同级顶层 Agent 驱动。插件保留 DSH 原生 Agent Loop 作为默认工厂，并注册由固定版本本地 ACP 适配器提供的 `codex` 与 `claude` 精确路由。ACP 会话选项接入现有 DSH 模型选择器：`model` 下拉成为提供方的模型分组，`thought_level` 下拉成为精确模型的推理等级（附在每个通告的模型上，因为提供方按当前模型通告等级、切换后重新通告），每个布尔选项——Codex 的 `fast-mode` 与 Claude 的 `fast`——成为一个驱动方开关，以提供方自己的名称与说明渲染为可勾选的菜单行。一次选择按"先模型、再等级、后开关"应用，每一步都经 `session/set_config_option`，已生效的值跳过；当前通告能回答的校验都在任何提供方调用之前完成，提供方未通告的等级或开关会在不调用提供方的情况下被拒绝；若某一步在前面步骤已生效后被提供方拒绝，则把会话驱动回事务开始前应用的那份选择——不只是撤销显式步骤，因为切换模型会自行重新通告等级——按依赖顺序进行：先开关、再模型、然后是原模型的等级、最后是模型切换自行改变的开关，即使某一步恢复失败也会把剩余各步都试完。抛出的 `AcpSelectionError` 说明会话是否已回到先前的选择；没有回到时，Agent 会把提供方 runtime 标记为待重建，下一次操作会在新进程中恢复提供方会话并记录它实际应用的选择。事务期间收到的提供方配置通知只更新 runtime 内部状态，观察者只在事务结束时听到一次变化，绝不会听到中间状态。已应用的选择是持久的会话事实：每次变化都追加一条携带提供方、模型、等级与开关值的 `paperai/acp/config` 事件，每一回合的 `request/header` 也在模型旁记录等级，因此一次模型调用无需依赖提供方自身状态就能从 DSH 日志重建。ACP 权限请求则复用现有 DSH 权限与审批界面。

`diagnosticStatus()` 发现适配器安装情况并读取历史模型元数据，不创建进程。`probe()` 在空临时目录中独立初始化，不携带提示词或 PaperAI MCP descriptor，拒绝文件回调，并采用原生只读模式。同一启动配置的并发探测共享工作。`Config.probeTimeoutMs` 默认 `15000`，`failureCooldownMs` 默认 `120000`，两者都必须为正整数。显式强制重试可跳过失败冷却。真实会话启动也记录元数据，旧探测不能覆盖新观察。缓存模型名称不能授权当前选择，成功初始化也不保证后续提示词能够通过认证。卸载会中止探测并等待进程树清理。

每个返回的 handle 负责其已发布的 Agent、DSH Session 与本地 ACP 进程。释放操作会等待三者完全停止；启动失败会回滚尚未发布的生命周期，使同一 Session ID 可以重试。发送 ACP prompt 前，Agent 会在解析完全部 prompt block 后再次检查 turn 信号，因此取消不会启动新的提供方工作。prompt 一旦发送，其请求和已建立的提供方进程就不会绑定到 DSH turn 信号。取消时会发送 ACP `session/cancel`，并退役用于约束模式请求和文件回调的操作代际，但 DSH turn 会保持打开，直到提供方发送最终 prompt 响应；在该响应之前排序的 Session 更新（包括工具终态更新）会先完成投影，然后 step 和 turn 才会关闭。下一个需要运行时的操作会先关闭旧进程，再在新进程中恢复提供方 Session，之后才接受模式或文件操作。提供方模型发现与选择共用一个 FIFO 队列，所以只有队首操作能够持有替换 maintenance，后续操作会在恢复后的运行时上继续执行。队列排空前，待处理 turn 会保持预约状态；释放过程会先停止接收新操作，再等待所有已入队操作结算。

DSH Session 的沙箱 preset 也会选择提供方已声明的原生 ACP 权限模式。Codex 把 `read-only`、`workspace-write` 和 `danger-full-access` 分别映射为 `read-only`、`agent` 和 `agent-full-access`；Claude 分别映射为 `plan`、`acceptEdits` 和 `bypassPermissions`。Claude 的 `acceptEdits` 控制提供方原生文件编辑姿态；DSH 仍会在每次 ACP 客户端文件回调处执行 `workspace-write` 限制。Codex 进程启动时还会通过 `INITIAL_AGENT_MODE` 接收同一目标。新建和加载的会话会在发布前校准提供方声明的当前模式。`/permission` 切换会先通过 ACP `session/set_mode` 应用目标；只有提供方接受后，preset、沙箱和审批事件才会持久化。因此拒绝会让 Session 投影保持原预设，并使命令失败。活动回合中发生切换时，会先预约 maintenance，再取消并排空该回合，让替代运行时以目标模式启动或完成同步，最后才提交 DSH 事件。该预约会让所有排队唤醒等待中间 idle 状态结束；排队输入只会在提交或失败后恢复，并发权限切换失败时也不会释放活动预约。非命令直接写入的沙箱事件仍由校准观察器处理，下一次 prompt 会等待队列中的模式选择。模式请求会组合 Agent 生命周期、进程代际和调用方取消信号，因此同步失败退役其代际后，无响应的提供方请求无法继续卡住关闭流程或替代 prompt。如果固定版本的适配器没有声明所需原生模式，启动或同步会明确失败；本包不会虚构提供方模式标识，也不会静默选择权限更弱的模式。

ACP 适配器可能在提供方形成持久对话历史之前返回会话 id。如果 DSH Session 既不包含 `user/message` 也不包含 `turn/start`，则运行时会在冷启动的 `session/load` 失败后新建提供方会话，并记录新的关联。只要任一事件已经存在，加载失败就会继续明确终止恢复：PaperAI 不会用空白提供方会话替代无法恢复的对话历史。

ACP 客户端文件回调使用已挂载的 DSH 文件系统，而不是直接调用 Node 文件系统。读取继续遵循 DSH 的读取策略；每次写入都会在最终文件操作处重新解析当前 Session 的沙箱模式和不可变 Workspace 根目录。`read-only` 拒绝写入，`workspace-write` 将写入限制在 Workspace 与平台临时目录内，完全访问则移除该限制。ACP 的 `session/request_permission` 响应不会隐式放宽后续文件回调，因为 ACP 不会把该批准与之后的 `fs/write_text_file` 请求绑定。

每个 ACP 会话还独占一份经过身份验证的 PaperAI MCP 描述符。描述符会在 ACP `session/new` 或 `session/load` 时传入，随 Provider 模型切换同步提交来源，携带会话的工作区根目录与其沙箱模式的实时视图（MCP 工具因此只能停留在该会话自己的 PaperAI 项目内，并在 `read-only` 下拒绝修改），并在 Agent handle 释放时撤销。因此 Codex 与 Claude 会和人工工作台共用文档提交、模板门禁、历史、回退与导出服务；MCP 服务缺失会明确导致启动失败，不会静默退化成只改文件系统。

模型名称和可用范围来自运行中的适配器返回的 ACP 会话选项。固定版本的 Claude 适配器默认启动其内置 Claude Code，可与终端安装的版本不同。若要使用指定的本机 Claude Code，在启动 PaperAI 前将 `CLAUDE_CODE_EXECUTABLE` 设为其可执行文件的绝对路径，或通过本插件配置的 `claude.env` 设置该变量。`claude.command` 应继续指向 ACP 适配器；Claude Code 可执行文件本身不能替代适配器。修改启动环境后需重启 PaperAI。适配器应用 Claude 设置和提供方公布的模型可用范围；PaperAI 不维护静态的 Claude 模型列表。

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
- **取消结算** — PaperAI 会等待提供方的 cancelled prompt 响应，使协议中有序的终态更新仍保留在所属 turn 内。取消后始终不结算的非兼容提供方可能延迟完全停止。
- **能力投影** — ACP Agent 通过经过身份验证的 MCP 描述符获得 PaperAI 文档能力。DSH 原生 Loop 工具不会自动映射到 ACP Provider 会话。
- **文件系统权限升级** — ACP 客户端文件回调始终执行 Session 当前的沙箱 preset。若要允许 Workspace 外写入，用户必须通过标准 DSH 权限控件把该 Session 切换为完全访问；之前的通用 ACP 批准不会产生无范围限制的文件系统授权。
