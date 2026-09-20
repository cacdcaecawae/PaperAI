# Agent Note: PaperAI 工作台视觉语法：一行标题、一行命令、浮层控件

Status: implemented

[English](2026-09-15-paperai-workbench-visual-grammar.md) | 中文

## Problem

[写作工作流](2026-09-12-paperai-writing-workflow.zh.md)和[字符格式](2026-09-10-paperai-character-formatting.zh.md)落地后，文档列在纸面上方堆了三行 chrome：详情标题、带导出与专注的事实芯片行、以及会再展开第四行段落设置的命令工具栏。工具栏里有六个原生 `<select>` 和一个带步进箭头的输入框，唯一的实心按钮是黑色的，底部还有一条状态栏把纸面封住。用户觉得结果像生成的而不是设计的，也不醒目。2026-09-09 批准的设计稿只有一行承载文档事实的标题栏、一个金色实心动作、浮在纸面上的控件，且没有任何原生表单控件。

## Decision

**视觉语法。** 所有 PaperAI 表面遵循同一套规则。界面文字 13 与 12 px，标题 15 与 20 px。圆角：控件 8，面板 12，浮层胶囊 16。分隔线用细线 `--dsw-alias-border-l2`。控件无边框：命令行里 28 px 高，标题栏里 32 px；hover 涂 `--dsw-alias-interactive-bg-hover`；按下与选中涂 `--dsw-alias-state-business-tertiary` 配金色 `--dsw-alias-state-business-primary`。每屏一个实心动作，浅深两色都是金：`--dsw-alias-button-primary-fill` 浅色 `#9a6a1a`、深色 `#e2b457`，墨色只留给品牌与文字。所有离散选择都用 DSH 的 `Menu`，原生 `<select>` 不再出现。投影只来自品牌 token `--paperai-page-shadow` 与 `--paperai-float-shadow`，二者定义在 `ui-paperai-brand/src/client/theme.ts`，这是唯一允许出现字面颜色的地方。浮层胶囊共用一个配方：半透明底（`--dsw-alias-bg-base` 的 `color-mix`）、`backdrop-filter: blur(12px)`、16 圆角、细线与浮层投影。蓝色仍只做文档类型的信息色。

**标题栏。** `ui-primitives` 的 `DetailsViewShell` 接受 React 节点形式的 `subtitle`，以及位于关闭控件之前的 `actions` 节点。工作台把文档事实作为副标题传入：模板名（未关联时显示「模板」）、带状态点的格式检查、「版本 N」，以及一个 live region，读作「已写入文档」、金色的「未保存 · N 段」、「正在保存…」或红色的失败提示。「专注写作」与实心的「导出」是 actions。事实芯片行和状态栏都去掉了。

**命令行。** 一行 `role="toolbar"`：撤销与重做用图标；字体与字号是 `Menu` 触发按钮，读数是当前值或弱化的「继承」「混合」，每个列表都以一行「继承」开头，让已声明的值可以退回到块的值；B、I、U、Tx；「段落」是一个带四个子菜单的 `Menu`（样式、带图标的对齐、行距、0 到 72 磅步进的缩进），当前读数带勾选标记，`Menu` 的子菜单现在会渲染这个标记；查找是一个图标，展开一个行内 `Input`。把选中文字交给 Agent 不是工具栏控件。在映射块内选中文字并松开（鼠标或键盘）后，选区最后一行下方会浮出一条小条，上面是「交给 Agent」和三项固定动作「润色」「扩写」「检查引用」；小条始终留在纸面舞台之内，下方没有空间时翻到选区上方，选区变化、页面滚动或动作执行后消失。在选区上右键会在指针处打开同一份列表的 `Menu`，固定动作前有分隔线；每项都以同样方式引用选区，再把一句固定指令追加到输入框草稿里，消息由人读过后自己发送；在其他位置右键仍是浏览器自己的菜单。工具栏自己的「保存」按钮去掉了：待保存条持有唯一的实心「保存」，Ctrl/Cmd+S 与 Ctrl/Cmd+Enter 仍然保存。漫游焦点仍在这一行的按钮与查找框之间；打开的菜单自己处理按键。

**纸面。** `.page` 用细线、2 圆角和 `--paperai-page-shadow`。缩放是纸面右上角的一个胶囊：− 与 + 在 50 到 200 % 间步进，点数值打开一个同时提供「适合页宽」的 `Menu`，适合页宽时显示实际落到的百分比。分页声明是这个胶囊的提示；内存草稿的提醒是待保存条的提示。变化导航和待保存条使用同一浮层配方。点一个版本时显示的是这一版自己的页面：`diffVersion` 返回 Host 对该快照的渲染，以及包含相等步骤的完整段落对齐；浏览器按文档顺序沿页面走这条对齐，把修改和新增的段落就地标出，被删除的段落用删除线画在它原来的位置，落在最后一块之后时也保持原有顺序，不再另列。不是当前版本时顶部有一条横幅点名版本。面板提供两种读法，所选版本以哪种读法显示由比较本身决定（带基准提交即「和现在比差多少」），因此重新比较会重发同一基准，比较进行中不能切换读法：「这一版改了什么」把版本和它的父版本比（初始版本无从比较，显示自己的页面且不标记，面板说它收录了全部 N 段）；「和现在比差多少」让 `diffVersion` 以所选版本为基准计量当前版本，显示当前页面及自那一版以来的全部变化。

**侧栏与 Agent 栏。** 「项目体检」是一行 36 px 的侧栏行，报告里用 outline 按钮。文档列表下方的「大纲」以 28 px 的行列出所选 Session 打开文档的标题，每级向内缩进 12 px。标题按文字从节点索引中识别（第 N 章、最多三级的编号小节，以及摘要、参考文献等固定部分），点击后通过工作台状态里的 `reveal` 请求让纸面把该块滚到顶边之下，随后的一次滚动会清掉这个请求。控制器在打开的文档变化时把每个 Session 的大纲推导进一个独立的 store，侧栏通过绑定的 `useOutlines` hook 读取，自身不带任何订阅。纸面右下角的页码胶囊显示视口中线所在的「第 current / total 页」。ACP 会话控件是一个 ghost 芯片，用 `StateDot` 表示连接状态，文字进入 title；ACP 设置页和会话对话框的离散设置改用同一个基于 `Menu` 的 `Choice`，PaperAI 的任何表面都不再有原生 `<select>`。PaperAI 自己的 MCP 工具有独立的 Tool call 行：Host 把这些调用写成 `paperai_document_tool`（其他 provider 调用仍是 `paperai_acp_tool`），`ui-paperai-acp` 在 `tool.call.toolview` 里接管这个 key，行内显示状态点、动作名称（读取文档、提交修改、检查格式……）、折叠时的失败原因一行，展开后才显示输入与输出。思考行、输入框和模型选择仍归 DSH。

**所有权。** 这些是 PaperAI 在共享 DSH 包内的增补，因此后续的 DSH 更新是重新应用它们，而不是保留它们。七项中有五项在[基线](../process/2026-08-28-paperai-dsh-baseline.zh.md)与上游中都不存在：`DetailsViewShell.subtitle` 与 `DetailsViewShell.actions`——它们不是加在 DSH 组件上的两个 prop，而是 PaperAI 自有文件的组成部分——以及 `conversation.hero.content`、`LocaleRuntime.override` 与 `ILayout.setDetailsFocus`。`Menu` 子菜单中的选中标记与 details 视图的 `setDraft`，则是对 DSH 确实提供的文件所做的改动。这份清单只是索引，不是全部足迹——[产品档案笔记](../architecture/2026-08-28-paperai-product-profile.zh.md)把足迹计为横跨两个平面的 29 个共享 DSH 包；上游此后已删除后两项所依附的布局 details 栏。本决策部分取代[写作工作流决策](2026-09-12-paperai-writing-workflow.zh.md)中工具栏呈现与状态栏的部分，以及[极简工作台决策](2026-09-09-paperai-minimal-workbench-and-outside-edits.zh.md)中实心动作颜色与文档事实位置的部分；它们的其他决策继续有效。

## Alternatives considered

**自己绘制整个详情标题栏。** 可以精确复现设计稿的 48 px 一行，但会失去共享的关闭与页签 chrome；两个可选的 shell 属性既保住 chrome 也保住布局。

**把事实放在命令行右端。** 加上命令后整行超过 900 px，在 860 px 的默认列宽里会折行。

**为段落设置自制锚定浮层。** 定位、消失与焦点还原都是 `Menu` 已经拥有的能力；带选中标记的子菜单读起来就像原生应用的格式菜单。

**保留状态栏。** 它重复了待保存条和标题栏，还把纸面从第四面封住；批准的设计稿让缩放浮在纸面上。

**保留墨色主按钮。** 设计稿的规矩把金色定为唯一的实心色；墨色留给品牌标记和文字。

**把「交给 Agent」做成工具栏按钮。** 一个偶尔才用的动作常驻成按钮，在用户眼里就是生成出来的 chrome；选区本身才是自然的锚点，没有选中文字时右键菜单不占任何位置。

## Testing

`styles.client.spec.ts` 扫描工具栏与诊断样式表，禁止所有工作台组件出现 `<select`，并要求使用投影 token。`editor.client.spec.tsx` 与 `components.client.spec.tsx` 通过字体、字号与段落菜单操作，经选区右键菜单引用文字，并经待保存条保存。ui-primitives 的原子测试覆盖 shell；ACP 会话测试读取芯片的 title。`apps/web/tests/paperai-permissions.e2e.ts` 经菜单选择缩放、字体、字号、对齐、缩进、行距与样式，`writing-controls.*` golden 捕获详情标题栏、命令行与缩放胶囊。`outline.client.spec.ts` 固定标题识别规则；`components.client.spec.tsx` 渲染大纲并触发 reveal；`editor.client.spec.tsx` 统计页数并滚动到被指名的块；ACP 的 `tool-row.client.spec.tsx` 以 Host 的名称为 key 并读取一次失败调用；`tool-presentation.spec.ts` 区分两个 transcript 名称；`apps/web/tests/paperai-acp-tool-failure.e2e.ts` 捕获折叠与展开的 PaperAI 行。

## Consequences

文档列只有一行标题与一行命令，纸面是最大的亮面。浏览器里左缩进从六个档位中选择，Word 仍保留任意值。混合的段落读数让所有子菜单都不带标记。浅色模式下金色成为所有 DSH 表面的主按钮颜色。浏览器流程依赖悬停打开子菜单，若菜单在指针移动时关闭，这些流程会失败。在节点索引带上 Word 标题级别之前，标题按文字识别，因此不足 60 字、末尾无标点的编号列表项也会被当作标题。此前写入的 transcript 里 PaperAI 工具仍是 `paperai_acp_tool`，继续用通用卡片渲染。
