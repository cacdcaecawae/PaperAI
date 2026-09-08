# PaperAI ACP 功能补全审查

审查日期：2026-09-08。范围：用户要求的新 ACP 功能补全 PR。本文记录代码审查、已复现的问题和验收要求，不表示下列缺失功能已经实现。

## 实施范围

按用户的最新约束，渠道配置、目录和默认选择只开放 Codex 与 Claude；不添加其他渠道或自定义身份。主状态固定为「已连接 / 未连接」，只来自已发布的活动 ACP 连接；安装发现和独立握手仅作补充信息。

实现位于 [ACP 服务](../../packages/paperai/agent-acp/README.md)与 [ACP 设置和会话控件](../../packages/client/ui-paperai-acp/README.md)，架构取舍见 [ACP 渠道记录](../../.agents/notes/implemented/architecture/2026-09-08-paperai-acp-channels.md)。本次包含设置与密钥保留、安装管理、可取消启动、模型及通用选项、原生命令与技能/指令上下文、表单问答、终端回调、历史导入与删除、媒体及工具进度投影。历史截断无法忠实映射到提供方时明确拒绝分叉。

原清单 S02/S03 的其他模板与任意自定义渠道，以及 I05 的 Grok 扩展，依最新两渠道范围排除。音频/二进制输出保留原始事件并显示不支持预览的提示；不声称已经提供播放。可选认证、历史和服务商配置只在适配器声明支持时开放。SSH 启动、严格主机密钥检查及 MCP 反向转发有实现和协议测试；尚无真实远程主机验证，不能标成远程端到端验收通过。

以下表格保留实现前的审查依据与验收要求；其中「当前状态」指审查基线，不代表分支实现状态。测试结果以 PR 的实际执行记录为准。

## 审查基线与结论

PaperAI 基线是合并 PR #25 后的 `main`，提交 `2b9a419ffb4f7651289ee4c8d619d0d420b3be7a`；当前工作区提交 `dc35a610aacb186fb7f675569cb7e81c30f06c70` 的代码树与该基线相同。参考项目固定为 [Agentero `8ccb00ae`](https://github.com/poco-ai/Agentero/tree/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d)。本次检查了源码、协议 SDK 和测试，没有实际使用 Agentero 桌面应用。

目前 PaperAI 有完整的 DSH 平台、Codex/Claude 顶层 ACP 会话、独立诊断、模型/思考强度/布尔选项、权限与取消处理。统一渠道设置、通用 ACP 接入、安装管理、问答和终端回调、原生命令、外部会话管理尚未形成完整用户流程。仅增加设置总览不能完成本次要求。

主要实现位置是 [顶层 ACP 客户端](../../packages/paperai/agent-acp/README.md)。[自动化 ACP 服务端](../../packages/acp/acp/README.md)和 [ACP 子智能体 provider](../../packages/subagent/subagent-acp/README.md)承担不同角色，共用依赖发生变化时需回归；它们已有的协议支持不能代替顶层客户端的设置与交互实现。

[上一轮采纳记录](../../.agents/notes/implemented/architecture/2026-09-05-paperai-agentero-adoption.md)覆盖五项架构适配，并未声明 Agentero 的全部 ACP 功能已经迁移。[产品架构记录](../../.agents/notes/implemented/architecture/2026-08-28-paperai-product-profile.md)包含三个初始 Agent 的限制；本次扩展渠道时，需要一并更新这一限制及对应测试，保留内置 DSH 的完整能力。[模型选项记录](../../.agents/notes/implemented/feature/2026-09-02-acp-model-effort-switch-selection.md)中的事务应用和日志要求继续适用。

## 已复现的问题

### P1：分叉继续使用父会话的 ACP 身份

[Host 分叉路径](../../packages/host/apiproxy/src/api-proxy.ts)在第 2463–2478 行把父会话事件作为新会话的 seed。[ACP Agent](../../packages/paperai/agent-acp/src/agent.ts)第 944–950 行从全部事件中读取最近的外部会话 ID，没有区分继承的 seed 与新会话自己建立的关联；随后调用 `session/load`。结果是两个 PaperAI 会话可以连接同一个 provider 会话，分叉点之后的上下文也无法按本地截断位置保证隔离。

复现：父会话完成一轮，使用它的事件和 `parentSession`/`seedLength` 创建 ACP 子会话。子进程收到 `session/load("external-parent")`，独立身份断言失败。补全时应按 provider 能力创建真正的分叉；不支持分叉或无法表示指定历史截断点时，明确拒绝该操作，不能把恢复父会话当成分叉。

### P1：恢复能力消失时静默创建空会话

[ACP runtime](../../packages/paperai/agent-acp/src/runtime.ts)第 359–398 行只在 `loadSession === true` 时进入恢复分支；当存在外部会话 ID、但 provider 不声明加载能力时，直接执行 `session/new`。已有的“非空会话不能替换”检查仅覆盖加载请求报错，没有覆盖能力缺失。界面保留本地历史，provider 却从空上下文继续。

复现：持久化有一轮历史的会话，然后使同一配置的 ACP 初始化响应不再声明 `loadSession`。恢复操作成功并新建空会话，预期拒绝的断言失败。补全时应在 `resume`、`load` 之间按能力选择；二者均不可用且存在历史时明确报错。只有经现有规则证明为空的会话才可重建。

### P2：文件读取忽略行范围

[ACP runtime](../../packages/paperai/agent-acp/src/runtime.ts)第 312–314 行只向回调传递 `path`，丢弃 `fs/read_text_file` 的 `line` 和 `limit`。[文件回调](../../packages/paperai/agent-acp/src/agent.ts)因此总是返回全文。

复现：读取 `first\nsecond\nthird\n`，请求 `line: 2, limit: 1`，收到三行而非 `second`。修复应保留现有文件策略，按协议的一基行号截取返回内容，覆盖 LF、CRLF、文件末尾与省略范围参数。

## 功能核对清单

“已有”表示拥有对应实现和现有测试，仍需在扩展渠道后回归；“部分”表示底层能力存在但某些入口、协议数据或生命周期未接通；“缺失”表示没有找到可完成该流程的 ACP 实现。完成每项需要同时核对设置/会话入口、Host、协议交互、日志或展示、失败恢复与验收证据。

### 渠道与设置

参考：[设置页](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src/components/settings/panes/agent-pane.tsx)、[目录行](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src/components/settings/panes/agent/agent-catalog-rows.tsx)、[模板目录](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/registry/templates.rs)、[安装管理](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/registry/lifecycle.rs)。PaperAI 对照：[ACP 设置与注册](../../packages/paperai/agent-acp/src/index.ts)、[诊断类型](../../packages/paperai/agent-acp/src/diagnostic-types.ts)、[诊断弹层](../../packages/client/ui-paperai-workbench/src/client/AgentDiagnostics.tsx)、[现有预设设置](../../packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx)。

| ID | 功能 | 当前状态 | 本次补全与验收要求 |
| --- | --- | --- | --- |
| S01 | 统一 Agent/ACP 设置总览 | 缺失 | 集中展示全部内置、已接入及未安装渠道；每行有名称、运行主机、CLI/适配器状态、最近检测、失败原因和可执行操作。无需先切换 Agent 才能查看它。 |
| S02 | 通用渠道注册 | 缺失 | 消除 provider 身份、配置、诊断、事件与 UI 中的 `codex \| claude` 限制；同一通用 ACP 实现承载目录模板与自定义命令。不同渠道不能默认套用 Claude 的权限模式。 |
| S03 | 自定义渠道的新增、编辑、停用、移除 | 部分 | 目前能覆盖两个固定入口的 command/args/env，不能创建独立 ACP 身份。增加稳定实例 ID、名称、参数数组、环境变量和保存错误；验证含空格路径、引号、多个相同类型实例、取消编辑与重启恢复。 |
| S04 | API Key、Base URL、环境变量 | 部分 | 现有 DSH 设置 schema 已支持并脱敏，保留其读写机制。统一页提供明确配置入口、凭据修改/清除和生效范围；列表、诊断、日志、错误消息均不泄露凭据。 |
| S05 | 网络代理及渠道特有高级设置 | 部分 | env 能表达一部分设置，但没有集中入口。接通代理启停、地址和必要的 provider 高级配置；验证清除覆盖值后继承行为。Agentero 的 Codex User-Agent/provider-id 设置按实际原生配置需要接入，不复制另一套配置存储。 |
| S06 | CLI 与 ACP 适配器分别发现 | 部分 | 当前只解析捆绑包或返回覆盖的命令，未完整判断宿主 CLI 与适配器各自是否可执行。显示解析路径、版本、安装来源及二者是否共用入口；发现阶段不执行安装或下载。 |
| S07 | 安装、更新、卸载 | 缺失 | 增加受控渠道操作、前置条件、进度/日志、取消、失败重试及完成后刷新。区分随 PaperAI 发布的固定版本适配器、应用管理的安装与用户已有全局安装；操作对象必须明确，不能把应用包目录当作全局安装修改。 |
| S08 | 单项/批量检测与结果缓存 | 部分 | 复用现有独立诊断服务，接通目录批量刷新、逐行忙碌状态、取消和过期结果处理。按配置实例缓存、限制并发、保留超时/冷却；检测不发送模型 prompt，也不获得项目 MCP/文件操作权限。 |
| S09 | 认证引导与认证失败恢复 | 部分 | 当前只有 API Key/env 与粗粒度 authentication 错误。展示真实认证方式、CLI 登录指引或 provider 声明的认证交互，接通重试及支持时的退出登录。握手通过、创建会话成功、模型请求成功分别记录，不能用绿灯推断账户额度或后续授权。 |
| S10 | 默认 Agent、启用状态与默认模型 | 部分 | DSH 已有默认预设，复用它。目录接入后须同步会话选择器和默认项；移除默认渠道时明确处理引用。默认模型/选项按实例保存，新会话应用，运行中的会话保留自身配置。 |
| S11 | Agent 内的模型供应商配置 | 缺失，扩展项 | 已安装 SDK 有 `providers/list/set/disable`，Agentero 此次审查路径未使用它们。若渠道声明此能力，在其详情中接入供应商设置；与“选择 Codex/Claude 等 Agent”区分，不能把普通 OpenAI-compatible API URL 直接当 ACP 服务。 |

上游当前目录共 11 个固定条目：Pi、OpenCode、OpenClaw、Claude、Codex、Hermes Agent、Antigravity、Qoder CLI、Grok Build、Dsh、Kimi Code，另有 Custom。PaperAI 的 DSH 继续使用内置原生 Agent，其余模板进入通用 ACP 目录。上游此版本把旧 Gemini 条目映射为 Antigravity；迁移时不能据此把两个不同产品视为同一渠道。每个模板需要独立核实当前命令、平台与认证条件，目录可见不代表已完成真实模型验证。上游本地一键安装列表也不包含 Qoder，不能宣称其所有目录项均支持自动安装。

统一页采用“默认设置 → 渠道列表 → 行内操作/详情 → 自定义渠道”的结构。把状态、操作和配置放在同一渠道名下，保留会话标题处的简短状态入口，并让它能打开对应设置详情。

### 模型与会话选项

参考：[配置解析](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/acp/updates.rs)、[模型配置控制器](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src/components/agent/hooks/use-agent-config.ts)。PaperAI 对照：[选项解析](../../packages/paperai/agent-acp/src/catalog.ts)、[协议应用](../../packages/paperai/agent-acp/src/runtime.ts)、[模型菜单](../../packages/client/ui-model-selection/src/client/ModelSelect.tsx)。

| ID | 功能 | 当前状态 | 本次补全与验收要求 |
| --- | --- | --- | --- |
| C01 | 模型、思考强度、布尔开关 | 已有 | 复用实时目录、分组、说明及事务回滚；保留不同模型重新声明选项时的校验、并发串行化与不可恢复时重建。 |
| C02 | Plan/Default 等协作模式、其他 select 选项 | 缺失 | 当前只提取 model、thought_level 和 boolean。显示渠道声明的模式与其余可配置 select；包括以 on/off select 表示的 fast mode。协作模式与 DSH 文件权限分开处理，切换 Plan 不得意外扩大权限。 |
| C03 | 模型搜索、收藏、当前自定义模型展示 | 部分 | 保留现有分组，补齐较长目录的搜索/收藏及当前模型不在常规目录中的显示。手工输入模型 ID 时由 provider 验证，不能将缓存或任意输入直接当作实时支持。 |
| C04 | 按渠道保存偏好 | 部分 | 现有日志保存会话模型/effort/switches；补齐新会话默认值、实例间隔离及失效选项提示。不能强制给所有渠道套用同一思考等级或“最高”默认值。 |
| C05 | 能力展示与按钮可用性 | 部分 | 目前仅局部使用 image/load/modes。记录初始化返回的会话、输入、MCP、认证等能力；不支持的操作解释原因，初始化、恢复和配置变化均更新相应 UI。 |

### 切换与进程生命周期

参考：[上游预热](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/session/warm.rs)、[预热失败冷却](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/runtime/control.rs)。PaperAI 对照：[切换控制器](../../packages/client/ui-agent-preset/src/client/seat-store.ts)、[Host 调度](../../packages/host/apiproxy/src/api-proxy.ts)、[独立诊断](../../packages/paperai/agent-acp/src/diagnostics.ts)。

| ID | 功能 | 当前状态 | 本次补全与验收要求 |
| --- | --- | --- | --- |
| L01 | 立即显示所选 Agent，连接期间继续写草稿 | 已有 | 保留最新意图、同一 Session 的 UI 绑定、提交限制与失败回滚；回归 A→B→C、跨项目导航、失败后重选及保存过程中继续输入。 |
| L02 | 启动阶段、超时与用户取消 | 部分 | 独立诊断有配置超时；实际创建/切换还需要完整的阶段反馈、应用级启动期限和取消入口。过期启动不能阻塞最新选择，也不能留下子进程或让已输入内容消失。 |
| L03 | 缓存模型与受控预热 | 部分 | 缓存只能提供预览；可借鉴选中稳定后再预取、失败冷却和缓存优先呈现。每次操作不能为无关渠道各启动一个真实项目会话。 |
| L04 | 独立进程、退出与重建 | 已有 | 复用 DSH subprocess 的进程树清理和现有 Agent 生命周期；扩展后覆盖启动失败、崩溃、配置变更、退出与工作区切换。记录冷启动、重复选择和切换耗时，不能把输入框可编辑当作启动速度已经改善。 |
| L05 | 停止生成、队列与运行中追加输入 | 已有 | 保留 ACP cancel 的最终结果收尾、stale generation 拦截及已协商 steering 扩展；不支持 steering 时按既有队列处理。问答/终端/权限请求必须随所属运行取消并结清。 |

Agentero 的 warm 会启动并结束连接，不是可直接迁入的长期进程池。PaperAI 已有的会话进程隔离、日志和 MCP 授权不应为复刻预热实现而重写。

### 历史会话

参考：[上游会话恢复](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/session/run.rs)、[外部历史读取](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/session/history.rs)、[历史合并](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src/components/agent/hooks/use-agent-history.ts)。PaperAI 对照：[ACP Agent](../../packages/paperai/agent-acp/src/agent.ts)、[DSH 会话 API](../../packages/host/apiproxy/src/api/sessions.ts)。

| ID | 功能 | 当前状态 | 本次补全与验收要求 |
| --- | --- | --- | --- |
| H01 | new/load/resume | 部分 | 已有 new/load 与本地持久化；补齐按能力选 resume/load、能力缺失拒绝及恢复配置同步，修复上述 P1。重放不得重复显示为新回复。 |
| H02 | provider 历史列表与导入 | 缺失 | 接通 `session/list` 分页、工作目录和渠道筛选、加载选中会话及本地/外部 ID 去重。现有 DSH 本地会话列表保留，不能误标成已支持 provider 历史。 |
| H03 | 标题与更新时间 | 部分 | DSH 有标题和历史 UI；ACP `session_info_update` 未接入。更新对应会话，保留用户主动命名，避免迟到的历史响应覆盖当前选择。 |
| H04 | 分叉、编辑后重发 | 部分且有 P1 | DSH 有通用分叉，但 ACP provider 身份未分离。按 provider 能力完成分叉和截断语义，或明确拒绝；不能只截断本地显示后继续恢复原始 provider 历史。 |
| H05 | 关闭、归档与删除 | 部分 | 本地会话管理与 provider 会话删除分别处理；支持时调用 `session/close`、`session/delete`，标明操作范围并回收相关运行。Agentero probe 读取 delete 能力，但此次代码未找到实际删除 RPC，不能据此把上游删除流程记为已实现。 |

### 输入、权限与客户端请求

参考：[初始化能力](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/acp/client.rs)、[问答和权限桥接](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/acp/interaction.rs)、[Grok 问答扩展](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/acp/ask_user.rs)、[终端请求](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/acp/terminal.rs)、[技能输入](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/prompt/skills.rs)。PaperAI 对照：[输入与回调](../../packages/paperai/agent-acp/src/agent.ts)、[用户问答服务](../../packages/interaction/user-questions/README.md)、[命令 UI](../../packages/client/ui-commands/README.md)、[终端服务](../../packages/terminal/terminal/README.md)、[MCP 服务](../../packages/paperai/mcp/README.md)。

| ID | 功能 | 当前状态 | 本次补全与验收要求 |
| --- | --- | --- | --- |
| I01 | 文本、文件/选区上下文、图片 | 已有主要流程 | 保留冻结后的论文选区、可移除引用、附件和 image 能力校验；回归纯图片、组合输入、发送失败保留附件以及切换后的能力变化。 |
| I02 | ACP 斜杠命令 | 缺失 | 接通 `available_commands_update`、说明/参数提示、命令菜单与原样发送；复用 DSH 命令 UI，但按来源处理重名，provider 命令不能被本地 `/plan` 等路由错误拦截。 |
| I03 | 本地技能选择及原生技能触发 | 部分 | DSH 技能能力存在，两个 ACP 预设不运行 DSH 的工具循环。补齐 ACP 输入中的技能选择、必要内容及渠道原生触发方式；选择内容必须进入同一条可重建日志，不能只显示技能标签。 |
| I04 | 回复语言和个人指令 | 部分 | 不能假定 DSH system-prompt 插件会自动影响外部 ACP 循环。接通 Agent 设置中的语言/个人指令与实际 prompt，记录模型收到的内容，并为原生命令避免错误添加正文封套。 |
| I05 | 结构化问答 | 缺失 | 实现 `elicitation/create` form，接入现有 userQuestions/UI；覆盖单选、多选、自定义回答、必要的布尔/数字字段及 accept/decline/cancel。接入采用的 Grok 问答扩展。迟到回答不得进入新会话。 |
| I06 | 终端五类请求 | 缺失 | 实现 create/output/wait_for_exit/kill/release，复用 DSH 的执行与权限能力。覆盖 cwd/env、字节截断、退出码、运行中读输出、等待期间 kill、请求取消及连接关闭后的进程树回收。不能仅声明 `terminal: true`。 |
| I07 | ACP 文件读写 | 部分且有 P2 | 读写已经通过 DSH fs/策略，补齐行范围；所有客户端请求验证会话身份和所属运行，取消后的文件操作不得继续。 |
| I08 | 权限请求与原生模式 | 已有两个渠道 | 保留允许/拒绝/取消、策略日志与工作区约束；按新渠道实际能力定义原生模式映射，无法提供所需保障时明确不可用。展示 provider 给出的说明与相关路径，不将未知模式默认为全权限。 |
| I09 | PaperAI MCP 能力 | 已有两个渠道 | 保留会话专属描述符、动态权限、模型/操作者归属和销毁撤销。扩展渠道时协商 HTTP/stdio/SSE 等支持及远程可达性；握手成功但不能连接论文工具时不能宣称完整可用。 |
| I10 | 资源链接、嵌入资源、音频及输出媒体 | 部分 | 目前主要投影 text/image，其余类型可能文本化或忽略。按协商能力转发并显示可支持的标准内容；unsupported 时在发送前说明，不悄悄丢弃。此项同时补协议完整性，不能宣称 Agentero 已经覆盖全部媒体类型。 |

### 回复与状态展示

参考：[上游事件投影](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/acp/updates.rs)、[聊天展示](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src/components/agent/chat-transcript.tsx)。PaperAI 对照：[AcpTurnProjection](../../packages/paperai/agent-acp/src/agent.ts)。

| ID | 功能 | 当前状态 | 本次补全与验收要求 |
| --- | --- | --- | --- |
| O01 | 正文、思考内容和消息分段 | 部分 | 已有 text/reasoning 流。补齐 `messageId` 与实际到达顺序的展示，避免不同消息的内容被合并；只显示 provider 明确发出的内容。 |
| O02 | 工具状态、输入输出、位置与 diff | 部分 | 当前主要记录首次 tool/call 与终态结果，结构化输出常变成 JSON 文本。补齐进行中更新、增量参数、可展开详情、路径、diff/terminal 内容与输出上限，复用 DSH tool presentation。 |
| O03 | 计划 | 部分 | 已有 todo 投影；多个 plan ID、增量更新和移除需要按身份处理，不能移除一个计划就清空其余计划。 |
| O04 | 上下文、用量、停止原因与压缩状态 | 部分 | 已有 context 用量和终态 token 统计；保留可获得的成本/停止原因，补齐压缩状态与摘要更新，刷新和历史恢复后展示一致。未报告的用量或费用留空，不能估造。 |
| O05 | 失败信息与连接状态 | 部分 | 已有错误分类及退出 stderr，需接通渠道级错误详情、重试路径、已脱敏诊断与当前连接阶段；批量检测中一个失败不能使全部渠道信息不可见。 |

## 运行位置与明确边界

Agentero 有 [远程 Agent 接口](https://github.com/poco-ai/Agentero/blob/8ccb00ae6b0d63a67875a2183f53d5d8eb632c8d/src-tauri/src/features/agent/remote_host.rs)和远程设置页，发现、检测与启动在 SSH 主机执行。这是需要登记的 ACP 功能，不能因为本地 Codex/Claude 可用就漏掉。

| ID | 项目 | 本次处理 |
| --- | --- | --- |
| R01 | 当前 Host 的渠道目录 | 纳入。设置明确显示 ACP 实际运行在哪个 Host；通过远程浏览器访问 PaperAI 时，检查的是该 Host 的安装。 |
| R02 | SSH 上的 ACP 发现、配置、检测与运行 | 纳入。接通远程渠道目录及运行，需要对应主机的 cwd、环境、认证及 MCP 可达性，不能只把本地 command 改成 ssh 就声称可用。复用已有 Host/执行能力，避免另建一套会话存储。 |
| X01 | 远程资料库同步、SFTP 文件浏览 | 属于 Agentero 的远程工作区产品；没有纳入 ACP 渠道补全的文件同步实现。R02 的论文工具可达性和明确失败仍必须完成。 |
| X02 | 独立 PDF Ask、Translate、Embedding 页面 | 这些是使用 Agent 或模型的业务功能，不是 ACP 协议能力。本次统一渠道设置服务现有论文会话，不新增三套业务入口；已有论文上下文与 MCP 需对各渠道验收。 |
| X03 | Tauri、Zustand、另一套 UI/历史/权限框架 | 借鉴入口和状态表达，继续使用 Cordis、DSH slots、settings、日志和 UI 组件。 |
| X04 | IDE 的 Next Edit Suggestions 与 document/* 通知 | 当前 SDK 的实验能力，Agentero 审查路径未使用，PaperAI 没有相应源码编辑器消费者。本次不声明支持；不能绕开 Working DOCX 的提交路径。 |
| X05 | ACP v2、实验 HTTP/WebSocket ACP 传输 | 当前比较基线为两边正在使用的 v1/stdin-stdout 流程；不隐式升级协议大版本。此处的 ACP 传输与 I09 的 MCP 传输是两回事。 |

## 协议逐项核对

对照已安装的 `@agentclientprotocol/sdk@1.4.0` 导出方法与 schema，以及 [ACP v1 概览](https://agentclientprotocol.com/protocol/v1/overview)。Agentero 的功能列表并不是整个 ACP 协议的完整实现，下面单独记录尚未通过该项目覆盖的项目。

| 协议项目 | PaperAI 当前处理 | 本次对应 |
| --- | --- | --- |
| initialize / 版本协商 | 已实现 v1 版本检查，初始化信息只保留部分用途 | C05、S08 |
| authenticate / logout、terminal auth | 未接通；依赖原生登录或配置凭据 | S09；按声明能力处理，交互终端可用后才声明 terminal auth |
| providers/list、set、disable | 未接通，SDK 标记为实验能力 | S11，按 provider 显式声明接入 |
| session/new、load、resume | new/load 已有，resume 未调用 | H01 |
| session/list、delete、fork、close | 未接通 provider 方法 | H02、H04、H05；fork 为 SDK 实验能力，不能用 load 代替 |
| session/set_mode、set_config_option | 固定权限映射与 model/effort/boolean | C01、C02、I08 |
| additionalDirectories | 未传递 | C05、H01；传入目录必须与 DSH 文件授权一致，不能仅增加路径就扩大访问权限 |
| session/prompt、cancel | 已实现，并有 steering 扩展 | L05、I01、I10 |
| session/request_permission | 已接通 userApproval | I08 |
| fs/read_text_file、write_text_file | 已实现，读行范围遗漏 | I07 |
| terminal/create、output、wait_for_exit、kill、release | 未注册处理器、未声明能力 | I06 |
| elicitation/create form | 未注册处理器、未声明能力 | I05 |
| elicitation/create URL、complete | 未接通；Agentero 检查路径也主要处理 form | S09/I05：有明确 URL 交互实现及完成/取消处理后才声明支持 |
| user_message_chunk | live 投影未处理，load 重放整体被抑制 | H02、O01；区分用户原文重放、命令生成内容及已记录本地输入，避免重复或丢失 |
| agent_message_chunk、agent_thought_chunk | 仅 text 内容，未按 messageId 分段 | I10、O01 |
| tool_call、tool_call_update | 首次调用与终态，未完整保留增量展示数据 | O02 |
| plan、plan_update、plan_removed | 单个 todo 列表投影 | O03 |
| available_commands_update | 忽略 | I02 |
| current_mode_update、config_option_update | 局部接通固定权限与模型目录 | C01、C02、C05 |
| session_info_update | 忽略 | H03 |
| usage_update | used/size 映射到 context；成本未投影 | O04 |
| compaction_update、compaction_summary_chunk | 忽略 | O04 |
| $/cancel_request | 使用 SDK 取消机制，部分请求带 cancellationSignal | L02、L05、I05–I07；新增请求覆盖超时和作用域销毁 |
| 未识别的自定义请求与通知 | SDK 默认处理/业务忽略 | 返回明确 unsupported；采用的 Grok/steering 扩展逐项记录，未知扩展不推测执行 |
| nes/*、document/* 与 experimental/v2 | 未使用 | X04、X05 |

## 实施顺序与交付验收

1. 修复三个已复现问题；建立可扩展的 ACP 实例注册、能力记录与配置读写，保留现有 Codex/Claude 默认行为。
2. 实现统一目录、详情、自定义接入、安装管理及认证流程，使“发现 → 配置/安装 → 检测 → 设为默认 → 创建会话”可以连续完成。
3. 接通协作模式、问答、终端、原生命令/技能、历史和完整事件展示；新渠道按实际能力提供功能。
4. 验证本地与远程 Host 路径、性能与资源清理，补充对应 Agent Note、READMEs、生成接口及受影响的 SDK/日志预期。

每项记录入口、实现位置和验证证据后才能标记完成。至少覆盖：全新环境无 CLI；CLI 有而适配器缺失；安装取消/失败；无认证、认证成功及失效；两个自定义同类实例；模型/模式/凭据变更；快速连续切换并输入；非空恢复与真正分叉；外部历史分页；问答取消；终端等待期间停止；跨会话请求；远程 cwd/MCP；配置或进程退出后重试。没有凭据的渠道标记“未完成真实模型验证”，不能让协议替身测试替代这一事实。

代码验证采用对应单元/集成测试、真实组装的 keyless 快照、GUI 回归、必要的真实适配器/模型流程及更改范围所需的构建/静态/文档检查。包含可见 GUI 修改的 PR 需要提交对应版本真实服务器和模型流程的 GIF。通过条件包括正确性、功能入口和资源清理；测试数量或目录行数不能单独证明补全。

## 本次审查证据

以下聚焦命令通过 8 个测试文件、129 项测试：

```sh
pnpm exec vitest run packages/paperai/agent-acp/tests packages/client/ui-agent-preset/tests/seat-concurrency.client.spec.ts packages/client/ui-paperai-workbench/tests/diagnostics-controller.client.spec.ts packages/client/ui-paperai-workbench/tests/diagnostics-components.client.spec.tsx packages/host/apiproxy/tests/api-proxy-agent-preset.spec.ts --reporter dot
```

额外三个协议替身复现均失败，分别确认分叉身份复用、恢复能力缺失时新建空会话、文件行范围丢失。临时测试及替身已从源码测试目录清理，业务代码未修改。本次未重跑完整浏览器 E2E，也没有把 Agentero 桌面体验、所有渠道登录或真实模型调用记为已验证。

文档检查 `pnpm run doc-sync` 通过全部 28 项；本报告的本地链接、核对项 ID 唯一性和文件末尾换行另行检查通过。清单包含 43 项功能核对及 5 项明确边界。
