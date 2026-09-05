# Agent Note: PaperAI 起始页、追踪文档侧边栏与块级原地编辑

Status: implemented

[English](2026-09-03-paperai-ui-overhaul.md) | 中文

部分取代：布局与草稿刷新由[以文档为中心的工作台决策](../architecture/2026-09-05-paperai-agentero-adoption.zh.md)规定，下述其他决策继续有效。

## 问题

PaperAI 客户端长出了一套用户读不懂的层级。每个 Workspace 下面，侧边栏在追踪文档和会话列表旁边同时列出模板行、按模板新建的操作、"新建文档"行，以及图像、实验、代码三个文件夹分组，项目的第二层把配置、操作和内容混在一起。文档视图是一组标签页：编辑页一页只呈现一个语义节点，与旁边的预览完全不像；模板页要求用户从一份平铺目录里为每份文档挑选模板。外壳在 DSH 主题之上涂了一层松绿色强调色，字标下面挂着"论文工作台"描述语，空白会话打开时显示 DSH 的"探索未至之境 / 预览版"文案，产品看起来像是从它所运行的 harness 上撕裂下来的。用户要求重做：侧边栏要像 DSH 一样简洁，颜色和行样式照 DSH 的来，模板只在一个地方配置，编辑视图要像文档本身。

## 决策

产品术语固定在仓库根目录的术语表 [CONTEXT.md](../../../../CONTEXT.md) 中：项目、文档、会话、块、版本、文档类型、模板、格式、模板库。界面背后的模板模型由[模板套装决策](../architecture/2026-09-03-paperai-template-model.zh.md)记录；本文记录建在它之上的各个界面。

**侧边栏。** `ui-paperai-workbench` 只贡献一个 `sidebar.workspaces.content` 条目："文档"区段列出项目中被追踪的 Word 文档及其文档类型，不带任何操作；DSH 的 `ui-workspace` 在同一个 [Workspace 详情](2026-08-30-workspace-detail-navigation.zh.md)中保留会话区段、新建会话操作和自身的折叠行为。`ui-paperai-brand` 覆盖 `workspace` 和 `conversation` 两个 locale 命名空间，让外壳在 DSH 说"工作区"的地方说"项目"（列表标题、返回操作、详情与会话区域的标签、选择器、重命名和删除对话框）。这层覆盖依赖 `@deepseek-ai/dsh-client-locale` 的 `LocaleRuntime.override(ns, dicts)` seam：每个命名空间和 locale 只保留一层覆盖，查找时先于所有者的词典，对同一组合重复注册即抛错，并返回 disposer。

**起始页。** `ui-conversation` 声明了 `conversation.hero.content` 这个根作用域单占 slot，其 owner 共享数据携带空白会话 id、所属 Workspace id 和 `openWorkspacePicker` 回调，DSH 的标题块（标志、标题、预览徽标）作为回退。PaperAI 的 `StartPage` 占据它。有项目时，页面显示标志与项目名、"本项目模板：X · 更换…"一行、项目模板套装中每份格式各一个操作（表单模板直接"新建{类型}"；排版参考提供"导入初稿，套{类型}格式"并接收初稿文件），以及"导入 Word，自由写"；从未决定模板的项目每次访问会弹出一次模板对话框，关闭对话框就是本次访问的回答。没有项目时，页面显示标志、"PaperAI"和"新建或打开项目"，后者打开 DSH 的 Workspace 选择器。选择已经登记的目录会重新打开其已有项目、文档和模板决定；起始页会说明这一行为。DSH 的输入框及其 Workspace、agent 预设两个 chip 保留在下方。

**模板页与对话框。** `settings.section` 条目"模板"和项目对话框渲染同一个 `TemplateLibraryView`，共用同一个模板库 store：内置与自定义模板套装及各自的格式、"添加自定义模板"、按文档类型"添加格式"（附 Word 文件及其用途：填写用的表单模板或排版参考的范例）、替换或移除格式、确认后删除自定义套装；在项目语境下，同一视图额外提供"用于本项目"和"不用模板，自由写"。

**文档视图。** `conversation.details.view` 条目 `paperai` 先净化 Host 预览，再把它渲染进一个开放的 shadow root：丢弃 `script`、`iframe`、`object`、`embed`、`link`、`meta`、`base`、表单控件和 `noscript`，剥除 `on*` 属性以及 `javascript:` 或 `data:` URL，文档自带的 `style` 元素移入 shadow 树，使其排版留在内部。每个段落、标题、列表项和表格单元格都按归一化文本和位置与一个可编辑语义节点配对；点击一个块，原位换成一个 textarea，"保存"通过既有提交路径把一次 `replace-text` 变更提交为一个版本，Escape 取消，未能配对的块会提示只能交给 Agent 修改。工具栏带有"模板"、"门禁"（附未通过数）、"版本"（附数量）三个 chip、一个"导出"菜单（草稿或正式版），以及基于 `ctx.layout.setDetailsFocus` 的专注开关；三个 chip 每次只打开一个侧面板，取代标签页。模板面板显示已绑定的格式及其要求，用 Host 的猜测（`suggestDocumentType`：先看标题，再看开头段落）询问文档类型并等待确认，按类型套用项目格式，解除绑定，并打开项目模板对话框。只有已绑定的模板套成员及其来源版本都与项目所选格式相同时，套用按钮才会禁用；切换模板套或替换其中一项格式后，仍可按文档当前类型重新套用。门禁面板列出带位置的发现项，执行"检查"，"让 Agent 修复"通过 ui-conversation 的 `setDraft` 把发现项起草进输入框。版本面板是一条带作者徽标和"当前"标记的时间线；一次展开一个版本，通过 `diffVersion` 显示段落级改动，可恢复的版本提供"恢复到此版本"。针对已打开文档的 `paperai/document-changed` 事件，在没有任何草稿偏离其基准文本时立即重新加载；否则显示一条横幅提供"刷新"，刷新时若被编辑的块文字未变则保留草稿，否则丢弃草稿并提示。布局配置为 centerMin 560、detailsMin 420、detailsDefault 760。

**品牌。** `ui-paperai-brand` 不再安装任何主题 token 层：所有交互色都是 DSH 的，PaperAI 的行沿用 DSH 的行高、圆角和字号。标志是从用户提供的 logo 描摹出的路径数据（机器人头、笔尖和一本压成黄金矩形的打开的书），以 `brand-paths.ts` 入库，并以 `currentColor` 的内联 SVG 渲染；字标是与 DSH 字标等高的"PaperAI"轮廓。描述语和 DSH 的空白会话文案都已移除。

**Host。** `@paperai/workbench-service` 暴露 `overview`（项目名、模板决定、文档行）、`setProjectTemplate`、`listTemplateLibrary`、`createTemplateSet`、`deleteTemplateSet`、`addTemplateFormat`、`removeTemplateFormat`、`importDocument`（类型为 `other` 的自由写作文档，不询问类型）、`createFromTemplate`（由项目模板套装和文档类型解析格式；表单模板成为文档本身，排版参考约束上传的初稿）、`applyTemplate`（一次提交，类型变化时携带 `set-document-type`，并携带 `bind-template`）、`detachTemplate`（`unbind-template`）、`suggestDocumentType`、`diffVersion`（经文档引擎读取两份不可变快照）、`exportDocument`、`open`、`readNode`、`commit`、`validate` 和 `restore`。`@paperai/template-service` 新增 `TemplateLibrary`，通过原子的临时文件写入把自定义套装持久化到 `<storageRoot>/library/library.json`，其 Word 文件存放在内容寻址的资源存储中；`listPacks` 报告内置与自定义两种类别。`@paperai/project-service` 用 `setTemplateChoice` 记录选择，在 `ProjectRecord` 上写入 `templatePackId` 和 `templateDecidedAt`（`null` 记录"自由写作"的选择）。`@paperai/domain` 新增 `unbind-template` 和 `set-document-type` 两种变更；`@paperai/commit-service` 按同一次提交所设置的文档类型校验绑定；MCP 服务器和原生 `paperai_commit_document` 工具都接受这两种变更，因此 Agent 可以按类型重新绑定文档。

文档变更通知会刷新已加载的项目列表，包括 Agent 在其他会话中新建的文档。再次选择同一块、尝试切换文档或连接恢复时，未保存的块文字都会保留。打开或新建其他文档之前必须先保存或取消草稿。重连会读取当前版本而不替换草稿；遗漏的新版本通过外部更新横幅提示，读取期间收到的更新通知仍保留为待处理状态。项目概览分别携带所选 `templatePackId` 与可用套装，因此删除套装会显示模板缺失，不会把项目的选择改成自由写作。首次读取项目失败后，可以直接从起始页重试。

块编辑器的显式外部刷新策略取代了[临时状态记录](../bug-fix/2026-08-29-paperai-transient-state-lifetimes.zh.md)中的浏览器冲突控件；该记录继续负责 Host 门禁报告的顺序规则。

## 考虑过的替代方案

**把模板行和新建操作留在侧边栏。** 这样项目的第二层就会把配置、操作和内容放在一起，正是用户读不懂的那套层级；起始页拥有侧边栏行所缺少的空间和语境（空白会话所属的 Workspace）。

**标签页加一页一个节点的编辑器。** 编辑页一页只显示一个段落，看不到周围的文档；在预览中按块编辑让文档成为唯一视图，并把每次点击都变成同一种 `replace-text` 提交。

**在预览 HTML 之上做富文本编辑器。** HTML 是生成的展示层，Working DOCX 才是权威，可编辑的 DOM 需要第二套文档模型并往返回写 Word。每个块一个 textarea 让每次修改都保持为针对已知节点的语义变更。

**PaperAI 专属的强调色层。** 松绿色覆盖正是让产品看起来与 DSH 撕裂的原因；用户要求使用 DSH 的颜色，因此品牌只贡献标志和字标。

**为"项目"一词 fork `ui-workspace` 和 `ui-conversation` 的词典。** 为几个词 fork 会复制全部键；locale 覆盖 seam 只改产品需要改名的键，所有者的词典保持原样。

**整页的历史查看器。** 用户要的是 VS Code 的 Git 体验：一条时间线，其中一个版本可以展开差异并恢复，一个面板即可提供。

## 测试

包测试覆盖 Host 方法与规则（`workbench-service`、`template-service` 的模板库、`project-service`、`commit-service`、`mcp`、`tool-document`）、locale 覆盖层（`locale`）、hero slot 及其回退（`ui-conversation`）、品牌占位组件（`ui-paperai-brand`），以及工作台控制器、带 jsdom shadow 树的四个组件、插件注册和 DSH token 样式规则（`ui-paperai-workbench`）。组装后的浏览器套件 `apps/web/tests/paperai-workspace-navigation.e2e.ts` 与 `apps/web/tests/paperai-permissions.e2e.ts` 在真实的 PaperAI 组合上固定侧边栏详情、起始页和文档视图。

## 后果

上游补丁集新增两个可叠加 seam：`conversation.hero.content` slot 和 `LocaleRuntime.override`，与此前的 `setDraft`、`setDetailsFocus` 并列；之后合并 DSH 时必须保留这四处。客户端把 Host 预览视为不可信标记，因此依赖脚本或外部资源的预览会在没有它们的情况下渲染。块级编辑只触及文本能匹配到可编辑节点的块；Host 未作为可编辑节点暴露的表格单元格、图和图题交给 Agent。删除自定义套装后，选用它的项目会显示模板缺失，直到重新选择，而已安装的格式继续可用。本文取代[多智能体论文写作基线](2026-09-02-multi-agent-thesis-writing-baseline.zh.md)中描述的侧边栏新建流程、带状态栏的标签页工作台和主题层；该记录的其他决策（自由模式、写作规程、门禁摘要、原生工具、访问范围）仍然有效，而其中"hero 文案没有覆盖 seam"这一后果已不再成立。
