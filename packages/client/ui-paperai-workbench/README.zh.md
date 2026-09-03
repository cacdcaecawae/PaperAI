# @paperai/ui-workbench

[English](README.md) | 中文

DSH 原生的 PaperAI 文档 UI 插件。它向 `sidebar.workspaces.content` 贡献项目详情资源视图，并向 `conversation.details.view` 贡献完整的 `paperai` 视图；不会替换 Workspace 浏览器、会话壳层、工具详情或 `ui-layout` 的几何规则。

Workspace 条目以"模板优先"的新建流程开头，随后根据一份 Host 投影的扁平列表渲染固定的文档、模板、图像、实验和代码分组。新建流程按模板包名称分组列出 Host 提供的全部内置模板成员（`listTemplates`）：开题报告、中期报告这类内容表单模板一键从模板新建文档（`createFromTemplate`）；论文书写范例这类格式参考模板会要求用户选择自己的 Word 稿并套用格式；末尾的"不用模板"行保留带文档类型选择器的自由模式 Word 导入。两类模板行都会在根提交中绑定该成员的契约，因此新文档一打开就处于门禁之下。项目还没有文档时该流程保持展开，之后折叠到标题之下，用户可随时重新展开。每一行都携带不透明资源 id、路径、深度、类型、可选工作状态以及显式的 `openable` 能力。只有可打开的行才渲染为按钮。选中后，它会把 Workspace 连接到可复用的空白 Session，打开该 Session，选择 `paperai` 详情视图，再向 Host 请求文档投影。不可打开的行只是普通树行，不会成为无效控件。

Working DOCX 始终是唯一权威正文。右栏复用 DSH 的详情 host 结构：紧凑标题行、行式标签页、弱分隔、正常的 13–14px 字号以及行级操作。预览在严格只读沙箱中渲染 OfficeCLI 派生的 HTML；完整 HTML 不会进入任何编辑回调。编辑页展示 Host 投影的语义节点目录，并且只为当前选中的可编辑节点请求临时纯文本 buffer。用户选择“提交并创建版本”之前，buffer 仅存在于浏览器；提交时只发送一个由 `nodeId` 定位的 `replace-text` mutation。编辑或冲突未解决时会禁止切换节点、打开另一文档、恢复历史版本、修改模板、运行门禁和导出。加载外部新版本时，如果该节点未变化，控制器会把草稿更新到新基线。同一节点也有外部修改时，工作台会前进到最新 revision、保留两份文本，并允许用户采用本地文本、采用外部文本，或编辑并采用合并文本，再从最新节点 buffer 提交。后续 revision 只修改其他节点时，不可变 buffer 会再次前进，但尚未解决的两份冲突输入与编辑中的合并草稿都会保留；只有明确选择解决方案才会移除冲突。重新加载只消费开始时捕获的外部通知，因此加载期间收到的新通知仍可继续处理。“放弃修改”只在没有冲突时恢复本地 buffer。版本列表展示持久化摘要，并把人工或 Agent 来源呈现为每行一枚账本徽标——人工、DSH、Codex 或 Claude，附精确模型；只有 Host 标记为可恢复的提交才出现恢复操作。模板、门禁与导出是三个独立标签页：模板页拥有内置模板包、自定义上传、审阅与关联流程；门禁页展示已关联模板、最近发现、一个有真实后端支撑的运行门禁操作，以及"让 Agent 修复"——它通过详情 host 的 `setDraft` owner 操作把未通过项起草进会话输入框而不直接发送；导出页拥有草稿与正式交付。所有标签页上方有一条常驻状态条，把已关联模板（或无模板自由模式）、门禁结论与未通过数、版本数呈现为可跳转标签页的状态片，并提供一个专注写作开关：它请求布局的整区详情聚焦（`ctx.layout.setDetailsFocus`），退出或卸载时释放。

`@paperai/workbench-service/types` 是传输数据类型的唯一所有者；本包重导出这些类型，只在本地维护浏览器 store 状态。`PaperAIWorkbenchRemote` 是从生成的 `TypertClientRemote['paperaiWorkbench']` 命名空间中 `Pick` 出来的类型，不是手写 RPC 接口。插件注入 `@deepseek-ai/dsh-api-remotes`，导入 `@paperai/workbench-service/remote` descriptor，并且在创建 controller 或注册 UI 之前等待 `ctx.remote.$mount()`。descriptor 挂载失败会让插件激活失败，不会产生一个猜测出来的可选命名空间；插件销毁时也会随生命周期卸载 descriptor。生成的 `list`、`open`、`readNode`、`commit`、`validate` 和 `restore` 方法使用带品牌的 id 与 `RemoteResult` 信封。`readNode` 返回一个携带 `nodeId`、`baseRevision` 和 `baseCommitId` 的纯文本 buffer；`commit` 根据这些基准发送节点 mutation，并且必须返回新建的 commit id、最新文档投影和选中节点投影。它没有整文档 HTML 输入。恢复也会创建一个可恢复提交，不会静默移动 head。

`PaperAIWorkbenchController` 不依赖 React，并接收已经挂载的生成命名空间。它为每个 Workspace 维护一个稳定资源 store，为每个 Session 维护一个工作台 store，其中包含选中节点阶段、不可变 Host buffer、当前 draft、外部冲突输入、dirty 标记和操作状态。它会中止被取代且可取消的读取、拒绝过期节点响应与来自其他文档修订的 buffer、把 Remote 拒绝折叠到显示状态、在文档更新后保留当前标签页、在 `connection/reset` 后刷新已观察投影，并在插件销毁后拒绝回调。slot 注册通过 `slots.inject()` 跟随声明生命周期，包括声明方卸载与重新加载。

插件不决定详情栏宽度。根节点填满 `ui-layout` 分配的列；普通宽度下编辑页左右排列语义目录和选中节点编辑器，列变窄后通过容器查询改为上下排列，版本元数据也通过同一查询适配。项目资源区段沿用 Workspace 详情的紧凑行式节奏与共用 hover、焦点过渡；项目为空时以模板新建行和自由模式的 Word 导入开头，而不会制造虚构分类。进入 Workspace 详情时焦点会落到返回控件，打开同节点冲突时焦点会先落到对比标题，再由用户选择或编辑解决内容。隐藏上传输入不会进入无障碍树，文档类型选择器会播报当前值；Host/provider 诊断只写入日志，界面显示本地化恢复文案。Workspace 列表、扁平展示、搜索展示和 Ungrouped 路径是否渲染由 `ui-workspace` 决定，因此这里不会自行出现。

## 模型体验

### 浏览器文档投影

#### 模型看到的内容

模型不会看到来自 `@paperai/ui-workbench` 的内容；它只渲染 Host 文档投影，不注册提示词、工具 schema 或 Session 事件。

#### Token 影响

本包既不组装也不发送模型请求，因此不会增加 token。

#### KV Cache 影响

本包只贡献浏览器 UI 和显式文档 RPC 操作，因此不会改变缓存前缀。

## 已知限制与后续工作

- 本包消费 Host 所有的协议和生成 descriptor，但不提供 Host 实现，也不会自行加入 bundle 组合。
- v1 共享协议只提供纯文本选中节点 buffer，编辑器也没有格式工具栏。富文本节点编辑必须先加入 Host 协议，不能使用客户端私有 DTO。
- 浏览器不会把 Markdown 或整份可编辑 HTML 维护为第二份正文。预览 HTML 只是派生投影；所有持久正文修改都通过 `commit` 应用到 Working DOCX。
- Host 负责预览生成和清理。浏览器会额外使用严格 iframe 沙箱，但它本身不是文档清理器。
