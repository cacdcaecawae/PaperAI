# @paperai/ui-workbench

[English](README.md) | 中文

DSH 原生的 PaperAI UI 插件。它只向既有的 DSH slot 贡献四个条目：向 `sidebar.workspaces.content` 贡献项目的文档列表，向 `conversation.hero.content` 贡献项目起始页，向 `settings.section` 贡献“模板”页，向 `conversation.details.view` 贡献完整的 `paperai` 文档视图。它不会替换 Workspace 浏览器、会话壳层、工具详情或 `ui-layout` 的几何规则，并且使用仓库术语表（`CONTEXT.md`）的产品语言：项目、项目里的文档与会话、文档的块与版本、决定从项目模板里取哪一份格式的文档类型，以及保存全部模板的模板库。激活时它还会安装 PaperAI 的宽详情栏布局配置（`PAPERAI_LAYOUT_CONFIG`：当前 Session 显示详情，列变窄时进入专注模式），关闭 DSH 的欢迎提示与 DeepSeek 凭据引导，并在每个 Workspace 进入 DSH 账本时立即为其初始化 PaperAI 项目，因此目录选择器的含义就是“新建或打开项目”。

侧边栏贡献只有一个区段——文档：项目里被追踪的 Word 文档按 DSH 会话行的样式逐行列出，每行显示文档名和（如有）文档类型，选中的行标记为当前。这里没有模板行、没有新建文档或文件夹分组，除读取失败时的“重试”外没有任何按钮；项目为空时只显示一行指向起始页的提示。选中一行会把 Workspace 连接到其可复用的空白 Session，打开该 Session，选择 `paperai` 详情视图，再向 Host 请求文档投影。Host 与 provider 诊断只写入日志，行内显示本地化的恢复文案。Workspace 列表、扁平展示、搜索展示与 Ungrouped 路径仍由 `ui-workspace` 决定，因此该区段只出现在项目详情内。

起始页占据空白会话的标题区。有项目时，它显示品牌标志与项目名称，一行说明本项目的模板（已选用的那一套，或“不使用模板、自由写作”，或“尚未选择”）并附“更换”或“选择”控件，再按论文流程顺序为该模板的每一份格式给出一个描边按钮：内容表单模板一键新建对应类型的文档（`createFromTemplate`），排版参考模板先要求用户选择自己的 Word 初稿再套用格式，末尾的“导入 Word，自由写”导入初稿且不询问类型（`importDocument`）。每个新建手势都会先连接 Workspace、显示其 Session、打开文档视图，再建立文档，因此新的 Working 副本会出现在用户正在看的那一栏。标志放在本条目声明的 `paperai.start.mark` seat 里，品牌插件会提供与侧边栏相同的标志；seat 为空时不显示标志。从未决定模板的项目每次访问会通过模板弹窗被询问一次，关闭弹窗即视为本次访问的答复。不是非空且不超过 32 MB 的 `.doc` 或 `.docx` 文件会在上传前被拒绝，新建失败时显示本地化文案而不是 Host 诊断。没有项目时，标题区显示标志、`PaperAI` 名称和唯一的行动入口“新建或打开项目”，它通过 owner 提供的 `openWorkspacePicker` 打开 DSH 的 Workspace 选择器。

模板是全局配置，不是项目内容。“模板”设置页与项目的模板弹窗渲染同一个模板库视图，读取同一个模板库 store：每套模板带“内置”或“自定义”标签，其格式按文档类型列出并标注用途（填写用的表单或排版参考的范例）；自定义模板还可以添加格式（先选文档类型与用途，再选 Word 文件；类型菜单默认落在该套尚缺的第一种类型上，格式以文件名命名）、移除格式，或在行内确认后删除整套；“添加自定义模板”按名称创建一套空模板。在项目里，视图会为每套模板增加“用于本项目”（没有格式的模板不可选），标出当前选择，并提供“不用模板，自由写”。模板库一有变化就会重新读取所有已加载的项目概览，起始页按钮与文档视图的模板面板随之更新。

文档视图就是文档本身。`DetailsViewShell` 标题栏显示文档标题与路径；其下是一行状态片：已绑定格式的名称（或“无模板”）、绑定格式时的门禁结论及未通过数、版本数、导出菜单（草稿或正式版），以及一个专注写作开关——它请求布局的整区详情聚焦（`ctx.layout.setDetailsFocus`），退出或卸载时释放。Host 的预览 HTML 渲染在一棵开放的 shadow 树里：先剔除活动内容（`script`、frame、embed、表单控件）、内联事件处理器以及 `javascript:` 或 `data:` URL，文档自己的样式表留在 shadow root 内部。每个段落、标题、列表项和表格单元格都按文字与阅读位置对应到一个可编辑的语义节点；点击某一块，它会原位换成纯文本编辑器（Escape 取消，Ctrl/Cmd+Enter 或“保存”提交），保存时只通过 `commit` 发送一个由 `nodeId` 定位的 `replace-text` mutation，从而产生一个版本。对应不到可编辑节点的块会提示可以交给 Agent 修改；未保存的草稿会阻止切换文档、新建其他文档、编辑其他块，以及会创建或修改版本的操作，直到保存或取消。再次选择正在编辑的块会保留草稿。状态片在文档旁一次只打开一个面板。模板面板展示已绑定格式、其要求与“解除绑定”，再按文档类型套用本项目模板，类型以 Host 的猜测（`suggestDocumentType`）为初值、由用户确认，并附一个更换本项目模板的入口。门禁面板说明检查内容、运行检查、列出发现项，并通过详情 host 的 `setDraft` 把未通过项起草进会话输入框而不直接发送。版本面板是按 Git 历史呈现的时间线：摘要、每个作者一枚账本徽标（人工、DSH、Codex 或 Claude，附精确模型）、时间、当前标记、按需加载该版本段落差异的“查看改动”，以及仅对 Host 标记为可恢复的版本显示的“恢复到此版本”——它会创建新版本而不是静默移动 head。其他会话提交的持久 head 在没有进行中操作时会立即重新加载视图；草稿未保存时则改为显示带“刷新”的横幅，刷新后如果该块的文字未变则保留草稿，否则丢弃草稿并给出提示。导出会报告写入路径，被门禁拦下的正式版导出会打开门禁面板并给出本地化说明。

`@paperai/workbench-service/types` 是传输数据类型的唯一所有者；本包重导出这些类型，只在本地维护浏览器 store 状态。`PaperAIWorkbenchRemote` 是从生成的 `TypertClientRemote['paperaiWorkbench']` 命名空间中 `Pick` 出来的类型，不是手写 RPC 接口：`overview`、`setProjectTemplate`、五个模板库方法、`importDocument`、`createFromTemplate`、`open`、`commit`、`validate`、`restore`、`applyTemplate`、`detachTemplate`、`suggestDocumentType`、`diffVersion` 与 `exportDocument`，全部使用带品牌的 id 与 `RemoteResult` 信封。插件注入 `@deepseek-ai/dsh-api-remotes`，导入 `@paperai/workbench-service/remote` descriptor，并在创建 controller 或注册 UI 之前等待 `ctx.remote.$mount()`；挂载失败会让插件激活失败，不会产生一个猜测出来的命名空间，插件销毁时卸载 descriptor。`PaperAIWorkbenchController` 不依赖 React，拥有三类稳定 store：每个 Workspace 一个项目 store，镜像进一个聚合的项目目录，供侧边栏、起始页与文档视图各自选取；一个模板库 store，由所有展示模板库的界面共享；每个 Session 一个工作台 store，保存文档、块编辑、打开的面板及其差异、类型猜测、导出回执与待处理的外部 head。它会中止被取代的读取、拒绝属于其他文档、Workspace 或 Session 的投影、把 Remote 拒绝折叠进显示状态、在同一文档更新后保留已打开的面板、在 `connection/reset` 后刷新所有已加载投影、消费 `paperai/document-changed`，并在插件销毁后拒绝回调。slot 注册通过 `slots.inject()` 跟随声明生命周期，包括声明方卸载与重新加载。

一切都用 DSH 自己的语言绘制：只用 `--dsw-alias-*` token，没有产品强调色、没有字面颜色、没有投影，用 DSH 原语（`DetailsViewShell`、`Button`、`Menu`、`Modal`、`Pill`、`DisclosureRow`、`StateDot`）而不是私有组件集。侧边栏行沿用会话列表的尺寸（32px 行高、8px 圆角、14px 字号，标题 34px），起始页沿用 DSH hero 标题区的几何，文档视图填满 `ui-layout` 分配的列，列变窄时通过容器查询让打开的面板占满整列。隐藏上传输入不进入无障碍树，菜单会播报展开状态，用户看到的每条失败都是本地化文案，诊断只写入日志。

文档变更通知会刷新已加载的项目列表，包括 Agent 在其他会话中新建的文档。首次读取项目失败后，可以直接在起始页重试。项目概览在所选模板被删除后仍保留 `templatePackId`，因此起始页和模板面板会提示模板缺失，选择器也不会把自由写作标记为当前决定。连接恢复时会保留未保存的块文字，并检查断线期间遗漏的文档更新；发现的新版本通过已有的“刷新”横幅提示，读取期间收到的更新通知优先于较早的重连读取结果。

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
- 编辑是按块的纯文本：一个块是一个段落、标题、列表项或单元格，编辑器只改它的文字。表格、图、图题、编号与排版是 Agent 的工作，富文本块编辑必须先加入 Host 协议，不能使用客户端私有 DTO。
- 浏览器不会把 Markdown 或整份可编辑 HTML 维护为第二份正文。预览 HTML 只是派生投影；所有持久正文修改都通过 `commit` 应用到 Working DOCX。
- Host 负责预览生成和清理。浏览器会额外剔除活动内容并把文档样式表限制在 shadow 树内，但它本身不是文档清理器。
- 块靠文字对应到语义节点：Host 投影为不可编辑的块，或投影中没有其文字的块，会原位保持只读，并提示用户交给 Agent。
