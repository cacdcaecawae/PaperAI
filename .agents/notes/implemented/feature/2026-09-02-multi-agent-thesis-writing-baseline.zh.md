# Agent Note: 多智能体论文写作基线

Status: implemented

[English](2026-09-02-multi-agent-thesis-writing-baseline.md) | 中文

## Problem

PaperAI 的产品方向是多个平级智能体——内置 DSH、Codex、Claude——在同一版本账本下共写一份论文，但四个缺口挡住了这种平权。未关联模板的文档被强制打上 `template_missing` 硬错误并阻断正式交付，无模板自由写作根本不可能。没有任何通道把写作流程送达外部 CLI：ACP 无法注入系统提示词，也没有东西告诉 Codex 或 Claude 去读模板契约、修复门禁发现。提交结果里虽然带着已存储的门禁报告，却只是一个没人被告知要读的无名字段。而内置 DSH 智能体完全没有文档能力——十个 PaperAI MCP 工具只发给 `codex`/`claude` 白名单后的 ACP 会话，随产品发布的 `standard` 预设碰不到 Working DOCX。

## Decision

四个已交付的部分合拢闭环：一份规程源、一份门禁摘要，供所有路线共用。

**无模板自由模式。**未关联模板时 `checkTemplateContract` 返回零发现的通过报告（`packages/paperai/template-service/src/gate.ts`）；关联模板才是进入检查的开关，草稿与正式交付在无模板时都自由导出。

**项目写作规程。**`@paperai/project-service` 拥有项目根的 `AGENTS.md`：一个带标记、可再生的区块，承载写作流程、红线和按仓库状态渲染的逐文档模板摘要，外加只创建一次、内容为 `@AGENTS.md` 的 `CLAUDE.md`（`src/charter.ts`）。初始化时写入，此后每次持久化的 `paperai` documents 变更都经服务的串行队列重新渲染，仅在内容变化时改写并逐字节保留标记外文字。Codex 直接读 `AGENTS.md`，Claude Code 导入它，thesis 预设的 `agent-instructions` 行把同一文件喂给内置智能体。已有 `CLAUDE.md` 的既有项目会逐字节保留该文件，并在其中两种写法的导入行都不存在时追加一行 `@AGENTS.md`，因此 Claude 不会悄悄错过规程。两个文件是一次同步：处理 `CLAUDE.md` 时失败会在错误抵达调用方之前把刚写入的 `AGENTS.md` 放回原状，恢复句柄也会对两个文件都尝试并汇总失败。

**共享门禁摘要。**`summarizeGate` 与 `deliveryBlocked` 同住 `@paperai/domain`：按严重度计数、最严重的发现在前、一条可执行的中文下一步，以及区分无模板情形的提示。MCP 的提交与回退结果和原生工具都把它作为 `gateSummary` 内嵌，任何智能体每次提交后立刻看到违规，且无需重跑三次引擎调用的检查；服务端 `deliveryBlocked` 拦截仍是硬保证。

**原生文档工具与 thesis 预设。**`@paperai/tool-document` 在 `ctx.tools` 上注册与 MCP 完全同名同结果字段的十个 `paperai_*` 工具，委托同一批域服务；提交盖上 `kind: 'agent'`、`client: 'dsh'`、会话 id，以及会话最新持久 `request/header` 里的 provider/model 路由（首个请求之前才用创建路由），因此经模型选择器切换后的模型就是账本记录的模型，使内置智能体的条目在版本账本中一等可辨。名单是两层的：PaperAI 是唯一的写作智能体，预设选择器选的是它的引擎。`packages/bundle/paperai-web/config/agent-presets/` 下的 `dsh` 预设目录组合写作 persona、agent-instructions、文档工具和完整的 `standard` 行集，使内置引擎保留标准模式的全部能力；启动器（`apps/cli/src/profile-boot.ts`）现在只提供产品自有的预设根，不具备文档能力的共享 DSH 预设因此不进入 PaperAI 名单，`ui-paperai-brand` 在 `dsh` 键下呈现文档标。这取代了[产品 profile 记录](../architecture/2026-08-28-paperai-product-profile.zh.md)中按 id 选用共享 `standard` 预设的名单策略。

**所有 Agent 路线共用一套访问范围。**`@paperai/domain` 拥有 `PaperAccessScope`、`assertProjectInScope` 与 `assertMutationAllowed`；`@paperai/project-service` 负责解析拥有会话工作区根目录的项目（`resolveForPath`）。原生工具每次调用都从 `ctx.sandboxPolicy` 解析范围，MCP 描述符 lease 携带会话工作区根目录与沙箱模式的实时读取器，因此两条路线都拒绝其他项目的项目、文档与模板记录（`PROJECT_OUT_OF_SCOPE`、`NO_PROJECT_FOR_SESSION`），并在 `read-only` 下拒绝提交、回退与导出（`READ_ONLY_SESSION`）；MCP 导出目标在 `workspace-write` 下被限制在会话工作区内（先按解析路径给出 `WRITE_OUTSIDE_WORKSPACE`，再由导出服务在发布时按真实父目录复查、给出 `DESTINATION_OUTSIDE_WORKSPACE`，目录链接也无法把文件带出去），完全访问放宽的是文件系统，从不放宽文档范围。`paperai_list_projects` 因此只列出会话自己的项目。

**模板优先的新建流程。**Workspace 侧栏贡献现在以内置模板包开头，而不是一条光秃秃的"导入 Word"栏：Host 列出的每个模板包成员都是一行新建入口，内容表单模板成员（哈工大开题报告、中期报告）一键从模板新建文档，格式参考模板成员（论文书写范例）接收用户自己的 Word 稿并套用格式，末尾的"不用模板"行保留自由模式导入。`@paperai/workbench-service` 新增 `createFromTemplate`：安装该成员、确认其契约（内置成员随包附带已审阅的要求，新建不再被单独的审阅步骤拦住）、经同一"导入加根提交"操作导入模板资产或上传稿，并在该根提交中绑定契约；内容来源由成员的 usage 决定，表单模板拒绝上传稿、格式参考模板必须带上传稿。在这个共用操作里根提交就是提交点：一旦落盘，即使预览失败或调用方中途取消，结果也会报告已创建的文档与提交（投影不再使用调用方的信号，预览失败变成空预览并记录原因），因此重试绝不会产生重复文档。项目没有文档时流程保持展开，之后折叠到标题之下。`ui-primitives` 的 `Tooltip` 不再为平台未标记为 `:focus-visible` 的脚本聚焦弹出气泡，点击工作区行后自动聚焦的返回控件上那条多余的"返回列表"气泡随之消失。

**工作台与身份表面。**工作台把模板、门禁、导出拆成独立标签页，新增常驻状态条（已关联模板或自由模式、门禁结论与未通过数、版本数，均可跳转标签页），并把版本溯源呈现为按作者的账本徽标。门禁未通过时提供"让 Agent 修复"，经 ui-conversation 详情视图新增的可叠加 `setDraft` owner 操作把发现起草进会话输入框。`ui-paperai-brand` 安装一层 `ctx.theme.overrideTokens`，在明暗两种配色下把 DeepSeek 蓝强调色族替换为学术松青；`ui-theme` 补上此前被消费却未声明的 `--dsw-alias-label-quaternary`；工作台几何加宽到 760/1280；ui-layout 增加可叠加的 `setDetailsFocus` 要求（store 标志、求解器参数、`ctx.layout` 方法），工作台把它暴露为专注写作开关。

## Alternatives considered

**门禁 error 触发强制修复环（post-execute 阻断或转向追加）。**按产品决策否决：所选强度是工具级自检加既有的服务端交付拦截，无视摘要的智能体浪费的是过程，不是交付质量。

**让内置智能体桥接现有 MCP 服务器。**否决：那需要放宽 `validateActor` 白名单并为非 ACP 调用方发明令牌通道，削弱租约绑定的溯源模型；原生工具用更少机制到达同一批服务，且保留完整的循环可观察性。

**规程只走系统提示词。**否决：ACP 没有系统提示词通道，外部 CLI 永远看不到流程；项目指令文件是三条路线都已经在读的唯一通道。

**为无模板文档内置一套通用检查。**暂缓：用户选择完全自由模式；基线检查包以后可以叠加，而不改变自由模式契约。

**把 `template_missing` 降级为 warning 保留。**否决：每次无模板提交都带一条永久 warning 会训练智能体忽略摘要；未关联模板是一种模式，不是缺陷。

**内置模板新建文档前仍要求审阅步骤。**对内置模板包否决：模板包随附的要求已经审阅，用户选中某个成员就是采纳这些要求的明确动作，而在第一份文档出现之前强制先到模板标签页确认，会让侧栏无法作为起点使用。上传的自定义模板保留"草稿—确认"流程。

**在名单里保留共享的 `standard` 预设并在它旁边补文档工具。**否决：预设是一个整体组合，无法从外部往别人的预设里追加工具，而共享预设必须不含产品服务，因为 `web` 与 `headless` profile 在没有这些服务的情况下挂载它。在产品自有的 `dsh` 预设中复列 standard 行，是用一份手工跟进漂移的义务换来"名单里每个选项都能写论文"。

## Testing

域摘要、无模板门禁、规程渲染/合并/事件同步、MCP `gateSummary` 内嵌与全部十个原生工具由包测试覆盖（`domain`、`template-service`、`project-service`、`mcp`、`tool-document`）；预设入名单由 `apps/cli/tests/profile-preset-roots.spec.ts` 断言，`apps/web/tests/paperai-dsh-preset.e2e.ts` 则在真实装配的组合（base、web 与 PaperAI 覆盖层）上挂载它，证明 persona、十个文档工具与标准工具集能一起组合、且 host 的全局工具层保持为空；品牌键渲染由 `ui-paperai-brand` 测试覆盖；目录门禁证明工具包已被记录。`createFromTemplate`（表单模板资产导入、参考模板上传、角色与缺失源文档拒绝、根提交绑定）由 `workbench-service` 测试覆盖；侧栏新建流程及其折叠、目录失败重试和两种新建手势由 `ui-paperai-workbench` 的组件、controller 与插件测试覆盖；tooltip 的 focus-visible 规则由 `ui-primitives` 测试覆盖。

## Consequences

两类通道保持不对称：内置智能体以后可以获得主动的循环增强，而外部 CLI 只能靠规程文件与工具返回被动引导——可接受，因为硬保证在服务端。两条路线的文档工具都被限制在会话自己的项目内，需要动别的项目的智能体必须在那个工作区里开会话。`dsh` 预设复列了 `standard` 的各行，需要手工跟进上游对这些行的修正。上游补丁集新增三个可叠加缝（详情 `setDraft`、布局 `setDetailsFocus`、quaternary 标签 token），后续合并 DSH 时必须保留；聚焦要求是浏览器内的瞬态状态。内置模板契约由新建手势直接确认，因此模板包改版后，新建文档会在没有审阅提示的情况下采纳新要求；模板标签页仍会展示已采纳的要求。会话首页文案仍是 DSH 默认值，因为 locale 命名空间只有单一属主，尚无覆盖缝。
