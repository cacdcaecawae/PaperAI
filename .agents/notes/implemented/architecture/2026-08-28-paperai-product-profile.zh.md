# Agent Note: 基于 DeepSeek Harness 的 PaperAI 产品配置

Status: implemented

[English](2026-08-28-paperai-product-profile.md) | 中文

> 产品定位、分叉策略与领域服务划分仍然有效。客户端贡献表中的两行被 [PaperAI UI 大改](../feature/2026-09-03-paperai-ui-overhaul.zh.md)取代：`ui-workspace` 的槽位现在只列出被追踪的 Word 文档，`ui-conversation` 的详情视图是一个以预览为主的文档界面，配模板、门禁、版本和导出面板，而不是四个并列视图。模板的选择与上传遵循 [PaperAI 模板模型](2026-09-03-paperai-template-model.zh.md)：一套模板按文档类型各存一个格式，由项目选择使用哪一套。

## 问题

PaperAI 需要成为完整的本地论文文档产品，但第一版实现把 DeepSeek Harness 的呈现复制进了另一套 React/Fastify 应用。通用 Agent 壳、Settings、权限、模型选择、会话生命周期和响应式行为因此被重复实现，外观与交互仍然不像固定版本的上游客户端。每次采用上游改进都变得昂贵，文档业务代码也耦合在第二套应用框架中。

产品仍需要 DeepSeek Harness 不负责的能力：Word 导入与修改、学校模板约定、文档提交、段落历史、论文交付门禁和 DOCX 导出。这些能力必须同时服务于内置 DSH Agent，以及本地 Codex、Claude ACP Agent，且不能再创建第二套模型循环或平行 UI 运行时。

## 决策

以固定版本的 DeepSeek Harness 仓库作为 PaperAI 产品底座。保留其 Cordis Host、Web 客户端、agent harness（智能体框架）与 agent loop（智能体循环）、会话生命周期、权限、凭据、模型 Settings、工作区基础设施、连接层和 UI 插件。PaperAI 成为一个产品配置：在标准 DSH Web 配置上组合可独立加载的 PaperAI Cordis 插件。

fork 中的上游包继续使用 `@deepseek-ai/dsh-*`，新增的产品自有包使用 `@paperai/*` scope，从而明确来源和所有权。PaperAI 新增包遵循 DSH 相同的包、invariant、Loader、slot、测试和文档约定。产品配置只禁用上游官方品牌 contribution，并通过既有品牌 slot 替换。

### 运行时与 Agent 组合

PaperAI 配置提供三个并列的顶级 Agent preset：

- **DSH** 使用内置 DSH agent harness 和 `dsh-agent-loop`；提供方由既有 Models Settings 配置。它最初按 id 选用共享的 `standard` 系统 preset；自[多智能体论文写作基线](../feature/2026-09-02-multi-agent-thesis-writing-baseline.zh.md)起以产品自有的 `dsh` preset 交付，该 preset 复列 `standard` 各行并加入原生文档工具与写作 persona。
- **Codex** 使用已安装的本地 Codex ACP 适配器，把 ACP 生命周期、配置选项、权限、流式内容、计划、工具、取消和错误映射到 DSH 会话。
- **Claude** 使用已安装的本地 Claude ACP 适配器，并复用同一个顶级 ACP Agent 实现。

它们是创建会话时的 Agent 选择，不是 DSH subagent。Codex 和 Claude 从 ACP `session/new.configOptions` 获取真实模型选择，并通过 `session/set_config_option` 应用变更；UI 不虚构模型 id。既有 DSH 凭据和模型 Settings 继续负责内置 DSH 提供方，包括 API key、Base URL、协议和模型列表。

PaperAI 启动器最初把共享系统 preset 根目录限制为 `standard`，随后加入产品自有的 Codex 与 Claude 根目录。自[多智能体论文写作基线](../feature/2026-09-02-multi-agent-thesis-writing-baseline.zh.md)起，它只提供产品自有根目录——`dsh`、Codex 与 Claude，即每个引擎一个 PaperAI 写作智能体——因为共享 preset 不具备文档能力。其他 profile 保留完整的随附 DSH 根目录；preset 服务继续追加用户创作根目录，以提供本地创建的选项。

PaperAI MCP 工具是所有 Agent 可见的文档能力面。Host 命令与 MCP handler 调用相同的领域服务；每次执行文档命令时，都从当前 DSH 会话解析 actor/model 来源信息。

### 客户端组合

DSH 客户端继续作为页面壳。PaperAI 只扩展四个窄上游 seam，并通过既有 slot 完成其他组合：

| 属主 | 窄扩展 | PaperAI contribution |
|---|---|---|
| `ui-layout` | 可配置的中栏/详情栏几何和详情栏可见性 | 更宽的文档工作台，同时保留原有让位和拖拽行为 |
| `ui-workspace` | 每个真实 Workspace 二级详情中的 list slot | 文档、模板、图片、实验和文档状态 |
| `ui-conversation` | 与既有工具详情并列的通用详情视图宿主 | 预览、编辑、历史和模板门禁视图 |
| `ui-agent-preset` | keyed 品牌呈现 slot | DSH、Codex、Claude 官方标记，不再硬编码通用图标 |

PaperAI 提供 `ui-brand`、`ui-document-tree`、`ui-document-workbench`、`ui-toolviews`，以及由功能属主注册的 Settings contribution。组件使用 DSH CSS Modules 和语义 token；不引入另一套组件系统、主题、页面壳、Modal 框架或全局 store。客户端产品文案使用中文；需要翻译的可见字符串遵守既有 locale 服务。

### 文档领域

Working DOCX 是权威可编辑正文。导入的源文件和模板保持不可变；操作只作用于派生工作副本。OfficeCLI 是 v1 唯一 Word 引擎，负责检查、归一化、语义修改、HTML 预览、验证、渲染和导出准备。HTML 是生成的呈现结果，Tiptap 只是临时的选中章节编辑缓冲区。

PaperAI 领域服务独立于 DSH 平台，并通过 Cordis Service Definition 和可替换 Service Provider 暴露：

- 项目与 repository 服务持有 PaperAI 元数据，同时把项目投影到 DSH 工作区；项目根目录以规范化真实路径为标识，并在 Windows 上折叠大小写，避免符号链接、junction 和路径拼写别名形成竞争标识；尚不存在的持久化根目录在可解析前保留词法标识；
- OfficeCLI 文档引擎 Provider 按 Working DOCX 串行化修改；
- 文档、模板、HIT 模板包、门禁、提交和导出服务分别持有自身业务规则；
- 同一份命令约定同时被浏览器 remote 和 PaperAI MCP 传输层消费；
- 每次完成的人工或 Agent 修改都创建可恢复 Document Commit，并记录操作 diff 与 actor/model 来源；
- 草稿导出允许 warning，交付导出则被有效 hard error 阻止。

首个内置模板包是用户提供的 HIT 硕士学位模板集合。用户可以选择 HIT 模板，也可以上传自定义 Word 模板。自定义模板会编译成可审阅的 Template Contract，并在确认前保持 draft。模板角色兼容性、不可变源文件、跨文档事实和交付要求由领域服务执行，不在 UI 或 MCP handler 中重复。

### 迁移顺序

之前的独立应用树保存在 `legacy-standalone-local` 分支和外部 Git bundle 中，可随时恢复。迁移只带入 PaperAI 自有领域类型、服务、测试、模板资产、OfficeCLI 集成，以及 ACP/MCP 适配经验。旧的自定义 Fastify Host、Vite 应用、复制的 DSH 组件、手写 REST 客户端和通用 Agent gateway 不迁移。

实现按可运行纵切推进：产品配置与品牌；项目与 DOCX 导入/预览；事务化人工文档提交与历史；共享命令/MCP 能力面；Codex、Claude 顶级 ACP 会话；模板约定、门禁与导出；最后完成浏览器和文档 fixture 验证。

## 曾考虑的替代方案

**继续把独立 PaperAI 壳调整得更像 DSH。** 这会保留重复的布局、会话、Settings 和交互代码。像素对齐无法复制上游行为，每新增一个文档面板都会进一步扩大分裂。

**把 DSH 作为运行时自动检测的可选外部程序。** 用户将失去确定可用的内置 Agent 体验、Settings 集成和统一生命周期，安装差异会成为产品级故障模式。

**只把 DSH 当作 ACP 侧边 Agent。** 这样 PaperAI 仍需负责另一套 Host、Agent loop 和客户端运行时，无法消除本次换底座要解决的重复实现。

**通过 submodule、subtree 或嵌套 gitlink 复制 DSH。** PaperAI 需要在同一工作区修改产品组合与少量扩展 seam。嵌套仓库会让单一锁文件、源码构建、测试、发布和上游补丁审查变复杂。

**在 DSH 上从零重写 Word 与文档历史领域。** 现有领域已经具备验证过的 OfficeCLI 流程、真实 HIT fixture、模板角色、提交、冲突、门禁和导出行为。迁移这些 seam 的风险低于重新发现规则。

**把 Markdown 或可编辑 HTML 持久化为第二份权威文档。** 通过另一种全文模型往返 Word 版式会产生同步和保真冲突。单一 Working DOCX 配合生成预览和章节缓冲区，可以维持一个真源。

**把 `standard` 复制进 PaperAI 组合包。** 副本会逐渐偏离其声称提供的 DSH Agent，也会要求每项上游 preset 修正重复应用两次。按 id 从共享系统根目录选择 `standard`，可以让原生 Agent 继续只有一份组装真源，同时允许 PaperAI 收敛自己的 roster。

## 测试

- PaperAI 配置可从源码和构建产物启动，并完整保留原生 DSH 会话、权限、Settings、凭据、模型和响应式 UI 行为。
- 全新的 PaperAI harness home 只列出既有 `standard` DSH Agent、本地 Codex 与本地 Claude，三者以并列顶级 Agent 显示，各自具有标记和真实提供方/模型选择，并均能运行会话。其他 profile 保留完整的随附 DSH roster。
- 用户可以选择目录、初始化或恢复 PaperAI 项目、导入 DOC/DOCX、查看 OfficeCLI HTML 预览、编辑选中章节并创建可恢复文档提交。
- 文档工作台提供预览、编辑、历史和模板门禁，且不再受原先 300–520 px 工具详情栏宽度限制。
- HIT 模板内置可用，自定义模板可以上传和确认，源文件保持不变，派生文档遵守角色兼容性。
- 人工与 Agent 修改共用一个串行提交路径，并具备正确来源、冲突检测、段落历史和回退。
- 项目修复与查找把符号链接、junction、大小写和短路径别名视为同一根目录，并拒绝有歧义的持久化重复记录。
- 不完整时仍可导出草稿；交付导出执行模板门禁并阻止有效 hard error。
- PaperAI MCP 与浏览器操作调用同一份领域命令约定。
- 每个产品可见插件都有 Loader/组合测试，领域行为有服务测试，浏览器冒烟测试在桌面和受限宽度下覆盖从项目到导出的主流程。
- 第三方许可、上游归属、包 README、双语架构记录和本地启动说明与实际产品一致。

## 后果

fork 在四个 UI 包中维护少量上游补丁；每项扩展都必须保持可加性并有测试，使后续 DSH 更新可以通过 merge 而非手工重抄。顶级 ACP 投影必须保持 DSH 会话事件配对、取消、权限请求、恢复和进程清理。OfficeCLI 与旧版 DOC 转换存在 Windows/原生依赖故障模式，需要明确的降级状态。文档提交跨越文件系统和 SQLite，需要可恢复的事务顺序。DSH 固定在 release candidate，公开约定仍可能变化。首版针对用户的 HIT 工作流；其他学校在获得同等保真承诺前，需要新增模板包和更大的视觉回归语料。
