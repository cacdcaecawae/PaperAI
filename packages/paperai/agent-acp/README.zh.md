# @paperai/agent-acp

[English](README.md) | 中文

PaperAI 通过精确的 preset contribution 开放 Codex 和 Claude。原生 DSH 工厂仍可供其他 profile 使用。ACP 模型、思考级别与开关使用现有模型选择器；通用协商选项与模型收藏使用 ACP 会话控件。修改在 RPC 前校验公布的值，先应用模型再应用依赖选项，遭拒时恢复此前选择。观测者收到结算后的选择；恢复失败会标记运行时需要重建。实际选项写入 paperai/acp/config，request header 携带实际模型和思考级别。手工模型 ID 必须获得提供方接受。

`diagnosticStatus()` 发现适配器安装情况并读取历史模型元数据，不创建进程。`probe()` 在空临时目录中独立初始化，不携带提示词或 PaperAI MCP descriptor，拒绝文件回调，并采用原生只读模式。同一启动配置的并发探测共享工作。`Config.probeTimeoutMs` 默认 `15000`，`failureCooldownMs` 默认 `120000`，两者都必须为正整数。显式强制重试可跳过失败冷却。真实会话启动也记录元数据，旧探测不能覆盖新观察。缓存模型名称不能授权当前选择，成功初始化也不保证后续提示词能够通过认证。卸载会中止探测并等待进程树清理。

每个返回的 handle 负责其已发布的 Agent、DSH Session 与本地 ACP 进程。释放操作会等待三者完全停止；启动失败会回滚尚未发布的生命周期，使同一 Session ID 可以重试。发送 ACP prompt 前，Agent 会在解析完全部 prompt block 后再次检查 turn 信号，因此取消不会启动新的提供方工作。prompt 一旦发送，其请求和已建立的提供方进程就不会绑定到 DSH turn 信号。取消时会发送 ACP `session/cancel`，并退役用于约束模式请求和文件回调的操作代际，但 DSH turn 会保持打开，直到提供方发送最终 prompt 响应；在该响应之前排序的 Session 更新（包括工具终态更新）会先完成投影，然后 step 和 turn 才会关闭。下一个需要运行时的操作会先关闭旧进程，再在新进程中恢复提供方 Session，之后才接受模式或文件操作。提供方模型发现与选择共用一个 FIFO 队列，所以只有队首操作能够持有替换 maintenance，后续操作会在恢复后的运行时上继续执行。队列排空前，待处理 turn 会保持预约状态；释放过程会先停止接收新操作，再等待所有已入队操作结算。

DSH Session 的沙箱 preset 也会选择提供方已声明的原生 ACP 权限模式。通用 ACP 选项编辑器中的原生 `mode` 和权限选项保持只读。Codex 把 `read-only`、`workspace-write` 和 `danger-full-access` 分别映射为 `read-only`、`agent` 和 `agent-full-access`；Claude 分别映射为 `plan`、`acceptEdits` 和 `bypassPermissions`。Claude 的 `acceptEdits` 控制提供方原生文件编辑姿态；DSH 仍会在每次 ACP 客户端文件回调处执行 `workspace-write` 限制。Codex 进程启动时还会通过 `INITIAL_AGENT_MODE` 接收同一目标。新建和加载的会话会在发布前校准提供方声明的当前模式。`/permission` 切换会先通过 ACP `session/set_mode` 应用目标；只有提供方接受后，preset、沙箱和审批事件才会持久化。因此拒绝会让 Session 投影保持原预设，并使命令失败。活动回合中发生切换时，会先预约 maintenance，再取消并排空该回合，让替代运行时以目标模式启动或完成同步，最后才提交 DSH 事件。该预约会让所有排队唤醒等待中间 idle 状态结束；排队输入只会在提交或失败后恢复，并发权限切换失败时也不会释放活动预约。非命令直接写入的沙箱事件仍由校准观察器处理，下一次 prompt 会等待队列中的模式选择。模式请求会组合 Agent 生命周期、进程代际和调用方取消信号，因此同步失败退役其代际后，无响应的提供方请求无法继续卡住关闭流程或替代 prompt。如果固定版本的适配器没有声明所需原生模式，启动或同步会明确失败；本包不会虚构提供方模式标识，也不会静默选择权限更弱的模式。

ACP 适配器可能在提供方形成持久对话历史之前返回会话 id。如果 DSH Session 既不包含 `user/message` 也不包含 `turn/start`，则运行时会在冷启动的 `session/load` 失败后新建提供方会话，并记录新的关联。只要任一事件已经存在，加载失败就会继续明确终止恢复：PaperAI 不会用空白提供方会话替代无法恢复的对话历史。

ACP 客户端文件回调使用已挂载的 DSH 文件系统，而不是直接调用 Node 文件系统。读取继续遵循 DSH 的读取策略；每次写入都会在最终文件操作处重新解析当前 Session 的沙箱模式和不可变 Workspace 根目录。`read-only` 拒绝写入，`workspace-write` 将写入限制在 Workspace 与平台临时目录内，完全访问则移除该限制。ACP 的 `session/request_permission` 响应不会隐式放宽后续文件回调，因为 ACP 不会把该批准与之后的 `fs/write_text_file` 请求绑定。

每个 ACP 会话还独占一份经过身份验证的 PaperAI MCP 描述符。描述符会在 ACP `session/new` 或 `session/load` 时传入，随 Provider 模型切换同步提交来源，携带会话的工作区根目录与其沙箱模式的实时视图（MCP 工具因此只能停留在该会话自己的 PaperAI 项目内，并在 `read-only` 下拒绝修改），并在 Agent handle 释放时撤销。因此 Codex 与 Claude 会和人工工作台共用文档提交、模板门禁、历史、回退与导出服务；MCP 服务缺失会明确导致启动失败，不会静默退化成只改文件系统。

启动配置使用 providers.codex 和 providers.claude；其他身份会被拒绝。顶层 codex 与 claude 设置仍可读取，并在可写设置接入时迁移到 providers。用户的新格式字段优先；迁移保留凭据、移除旧键，并拒绝覆盖并发编辑。两种格式均对秘密脱敏。只读存储或迁移写入失败时继续读取旧设置并告警；已注册设置节的后续变更会重试迁移。设置通过路径编辑保留密钥，并分别存储模型、收藏、通用选项、个人指令与回复语言。启动配置变更作用于新运行代次；显示名称与提示词偏好不会取消启动、安装或探测，也不会使缓存检测结果失效。Claude 适配器使用其内置 Claude Code；providers.claude.env.CLAUDE_CODE_EXECUTABLE 可选择已安装的可执行文件，而 providers.claude.command 必须仍指向 ACP 适配器。

渠道默认值是新会话的偏好。自定义模型 ID 交给提供方校验；思考级别识别 thought_level 类别及 effort、reasoning_effort、reasoning-effort ID。不可用的思考级别、开关和通用选项会告警，并保留提供方当前选择。提供方拒绝后，只有确认恢复成功才能继续；取消、连接丢失和恢复失败仍会拒绝启动。创建时显式指定的模型覆盖存储的默认模型，并保留严格选择校验。恢复的会话保留提供方配置。

目录的 `connected` 字段表示已发布会话是否持有开放的提供方连接，与检测结果独立。不同会话可同时使用 Codex 和 Claude。启动报告阶段并受可配置期限约束；更新的选择和显式取消会终止待完成启动。认证、退出登录、模型服务商配置、历史分页和删除按 ACP 声明的能力提供。导入先在新本地会话中暂存重放，按提供方及主机去重关联，并保留既有草稿。声明 resume 时优先使用，否则通过 load 恢复上下文而不重复显示历史。原生 close 在进程回收前执行。不能保持提供方精确历史的本地分叉会被拒绝。

提供方命令以 /acp-… 显示并保留原始参数。普通 prompt 附带配置的指令和显式调用的本地技能，并记录为 paperai/acp/context；原生命令绕过该封套。表单问答使用 DSH questions 并记录接受的回答。文件系统与终端回调记录请求及返回结果。终端进程受可配置的数量、输出和回收限制。工具进度按 Config.toolProgressIntervalMs（默认 1000 ms）合并输出并保存限长快照。状态变化与回合结束时立即写入，包括取消回合；历史回放不使用定时器。展示函数复用现有工具卡片；正文、思考和消息 ID 保留到达顺序。图片进入附件服务；不支持展示的输出媒体在日志保留原始字节并显示提示。计划、标题、用量、停止原因与压缩状态保留为会话观测。

如果原生标题只是在规范化空白后完整重复首条多行提示词，会话详情与标题投影都保留已记录的标题。尚无标题时不显示该回声，等待标题提供方生成标题。单行提示词和独立概括的原生标题仍可接受；用户显式标题保持固定。原始用户消息与 ACP prompt 保留完整内容。

托管安装使用独立 npm 代次，并原子发布已验证的清单。取消保留当前安装；卸载只移除当前托管代次。旧代次保留给可能仍持有它的进程。SSH 要求显式配置 POSIX 主机、Node 和已安装的适配器。凭据通过 stdin 传输并严格检查主机密钥；独立反向隧道转发可撤销的 PaperAI HTTP MCP 端点。远程会话不接收本地文件系统或终端回调。不支持 HTTP MCP 的本地适配器使用已有 MCP SDK 的 stdio 桥接。

Codex 持有的终端引用与 terminal_output_delta 元数据进入相同的限长进度快照。元数据必须指向当前工具调用；格式错误的载荷与其他调用 ID 会被忽略。客户端持有的终端继续使用终端服务。

## 模型体验

### Codex 与 Claude ACP 会话

#### 模型看到的内容

选中的适配器接收用户输入、配置的回复语言与个人指令，以及显式调用的本地技能文本。这些附加内容与客户端回复分别保存在 `paperai/acp/context` 和 `paperai/acp/client-request` 事件中。@paperai/mcp 负责经过认证的描述符中文档工具的 schema 和结果。

#### Token 影响

用户输入、所选技能、配置的指令、客户端回复与提供方上下文消耗 token。MCP 包负责自身工具 schema 与结果的 token；连接观测不增加 token。

#### KV Cache 影响

每个本地 ACP 进程负责 Provider 请求与缓存复用。创建或加载会话、切换所选 Provider 模型或替换 MCP 描述符可能改变后续请求前缀；本包不保留或保证 Provider KV cache 条目。

## 已知限制与延后工作

- **Provider 依赖** — `codex` 与 `claude` 路由需要 ACP 适配器和 Provider 身份验证，可使用内置版本、私有安装、显式配置的命令或配置的 SSH 主机上的安装。命令启动或握手失败会拒绝创建 Agent。SSH 要求 POSIX 主机具备 Node 和 HTTP MCP 支持，不会同步本地文件。
- **可选能力** — 身份验证、模型服务配置和历史操作要求提供方声明支持。不支持的媒体会在会话日志中保留原始字节并显示提示；保留精确上下文的本地分支仍不可用。
- **提供方模式可用性** — 完全访问要求固定版本的适配器声明其原生无限制模式。如果提供方在当前环境中隐藏该模式，选择 DSH preset 会明确失败，不会让两套权限状态保持不一致。
- **取消结算** — PaperAI 会等待提供方的 cancelled prompt 响应，使协议中有序的终态更新仍保留在所属 turn 内。取消后始终不结算的非兼容提供方可能延迟完全停止。
- **能力投影** — ACP Agent 通过经过身份验证的 MCP 描述符获得 PaperAI 文档能力。DSH 原生 Loop 工具不会自动映射到 ACP Provider 会话。
- **文件系统权限升级** — ACP 客户端文件回调始终执行 Session 当前的沙箱 preset。若要允许 Workspace 外写入，用户必须通过标准 DSH 权限控件把该 Session 切换为完全访问；之前的通用 ACP 批准不会产生无范围限制的文件系统授权。
