# Agent Note: PaperAI iOS visual language across the DSH shell and the product surfaces

Status: implemented

[English](2026-10-19-paperai-ios-visual-language.md) | 中文

## Problem

[工作台视觉语法](2026-09-15-paperai-workbench-visual-grammar.zh.md)给了 PaperAI 墨金调色板和一套克制的控件语汇，但只覆盖产品自己的包：侧边栏、输入框、菜单、对话框与设置面板仍是 DSH 的几何，只在其单色调色板上换了暖色。用户要求按 iOS 风格整体重做，并明确选了两点：以系统蓝而非金色作 tint；全局修改，包括 DSH 核心包，而不只是 token 层与 PaperAI 包。

## Decision

**调色板。** `ui-paperai-brand/src/client/theme.ts` 仍是唯一允许字面颜色的地方，现在为两种配色都提供 iOS 系统调色板。浅色是 `#f2f2f7` 分组底色上的白色内容；深色是 `#1c1c1e` 底色上的黑色内容与 `#2c2c2e` 的抬升卡片，所以深色下 `--dsw-alias-bg-layer-1` 是 `#2c2c2e`、`--dsw-alias-bg-layer-2` 是 `#1c1c1e`：layer 2 是底（纸面背后的桌面、设置面板、检查器），layer 1 与 layer 3 是其上的卡片。标签用系统灰，12 到 13 px 文字需要可读处用可访问的 `#6c6c70` 与 `#8a8a8e`。悬停、按下与输入框填充用 iOS 的半透明 `rgba(118, 118, 128, …)`。系统蓝是品牌强调色、选中态、焦点环、链接与唯一的填充按钮；状态色取 iOS 的红、绿、橙。浅色用 Apple 网页蓝 `#0071e3` 而非 `#007aff`，白底蓝字与蓝底白字都达到 4.7:1，`#007aff` 只有 4.0:1；深色保留 iOS 的 `#0a84ff`。金色只保留为 `--paperai-brand-gold`（标志在两种配色下都用它）与学位论文类型强调色。用户发出的消息是 iMessage 气泡：tint 填充、白字、右下角收为 6 px。该层还把 SF Pro 字体栈放在平台 UI 字体之前，并把共享的 `--dsw-shadow-lv1` 到 `lv3` 投影调柔。

**共享控件别名。** `ui-theme` 声明五个带 DSH 中性默认值的别名，让核心 primitives 通过 token 改写外观，而不读取产品名：`--dsw-alias-focus-ring`（tint 半透明，以 3 px 外环画在控件外侧，取代 2 px outline）、`--dsw-alias-material-bar` 与 `--dsw-alias-material-thick`（覆盖在 `blur(…) saturate(180%)` 背景上的半透明外壳），以及分段控件用的 `--dsw-alias-segment-fill`、`--dsw-alias-segment-track` 与 `--dsw-shadow-segment`。轨道单独成为别名、不复用 `--dsw-alias-bg-module-platform`，因为滚动条约定把每个 `--dsw-alias-bg-*` 值都视为高层级表面。

**控件。** 按钮是胶囊；填充变体是半粗的 tint，outline 变体改为 iOS 灰色按钮（半透明填充、tint 文字），按下时降到 70% 不透明度。输入框是带焦点环的灰色填充 r10 字段。菜单是 thick 材质加 40 px 模糊的 r14 上下文菜单，分隔用 6 px 的分组色带，勾选标记为 tint。对话框保持 r24、坐在分组底色上，标题为 17 px 半粗，关闭钮是灰色填充圆。菜单从锚点所在的角长出（180 ms 内由 0.94 缩放到 1），对话框与设置面板以 iOS sheet 曲线在 280 ms 内上浮 16 px 落位；定位读取的 `offsetWidth` 与 `offsetHeight` 不受 transform 影响，`prefers-reduced-motion` 会关闭这两种动效。Toast 是用标签墨色的 thick 材质 HUD 胶囊。所有两到三项的视图切换都是分段控件：详情视图标签、对话区的 对话 / 轨迹、插件设置的标签、外观选择（取代原来的三块方块）以及版本面板的两种读法；后者改为带 `aria-pressed` 的普通按钮，因为 `Pill` 不暴露按下状态。

**外壳。** 侧边栏仿照 iPadOS 侧边栏：工具图标为 tint 色，分区标题 17 px 粗体，灰色搜索框，r10 行，新会话按钮为 tinted 按钮，当前会话用 tinted 填充与 tint 文字，打开中的文档行是填充选中态，文字、图标与徽标都变白。对话区头部只保留一条细线，标签放进分段控件；hero 标题是 28/34 粗体大标题，hero 背后的模糊椭圆背景被删除。设置面板像 iPadOS 的设置 App：导航上方 28 px 大标题，选中项为 tint 填充，页面标题 22 px 粗体，各行坐在白色分组卡片上（`GeneralSection` 变为一张卡片；模型、插件、预设、ACP 与模板卡片去掉描边、改为 layer-1 填充，当前预设与模板加 tint 外环）。

**PaperAI 界面。** 起始页把金色标志放在 64 px 的 App 图标底板上，项目名为大标题，模板显示为 tint 链接，文档是内嵌分组列表：分组底色上的一个 r12 分组，每行一个按文档类型着色的 28 px 图标底板，细线缩进到图标列之后，带披露箭头，最后是 tint 色的 新建或导入文档 行。工作台头部的 chip 是 tint 胶囊，旁边是填充的 导出；命令行与侧面板头部坐在 bar 材质里；浮层胶囊用 thick 材质；侧面板是分组底色上白色卡片组成的检查器（格式检查状态与结果、当前模板、版本时间线各占一张）；弹出选择的触发器为灰色填充、值为 tint。画在纸面上的墨色仍与配色无关，由金色改为线条 `#0071e3`、文字 `#0058c6`。

**所有权。** 对 DSH 核心（ui-primitives、ui-theme、ui-sidebar、ui-workspace、ui-conversation、ui-settings-general、ui-settings-models、ui-settings-plugins、ui-agent-preset、session-log-export）的修改是 PaperAI 在共享包内的改动，计入[产品 profile 笔记](../architecture/2026-08-28-paperai-product-profile.zh.md)统计的足迹；DSH 更新时需要重新施加。本决定在调色板、金色填充按钮、圆角、浮层配方与焦点样式上取代[工作台视觉语法](2026-09-15-paperai-workbench-visual-grammar.zh.md)；其头部、命令行、纸面与侧边栏结构仍然有效。

## Alternatives considered

**保留金色作 tint。** 备忘录等 iOS 自带 App 也保留自家 tint，且标志是金色。用户选择了更具辨识度的系统蓝；金色留在标志与学位论文徽标上。

**只改 token 层与 PaperAI 包。** 这样 DSH 合并成本为零，但侧边栏行、输入框、菜单、对话框与设置面板会在 iOS 配色下保留 DSH 的形状。用户选择了全局修改并接受合并成本。

**把所有控件提到 iOS 触控尺寸（44 pt 行、17 pt 正文）。** 产品是纸面旁的桌面 Web 应用；侧边栏与设置保留 32 到 40 px 的行与 14 px 正文，只有标题改用 iOS 字号阶梯。

**分段控件轨道复用 `--dsw-alias-bg-module-platform`。** 数值合适，但滚动条约定把每个 `--dsw-alias-bg-*` 值视为高层级表面，会迫使无关的滚动容器重新绑定滑块。

## Consequences

外壳、设置与产品界面共用一套语汇，调色板、焦点环、材质与分段控件都可以在 `theme.ts` 中调整而不改组件样式表。代价是 PaperAI 在 DSH 核心样式表中的足迹变大、深色下 layer 1 比 layer 2 更亮，以及半透明菜单依赖 `backdrop-filter`。PaperAI 浏览器 golden 是 aria 快照，回放不变；视觉结果仅由截图核对。
