# @paperai/ui-brand

[English](README.md) | 中文

本包通过既有的 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark` slot 以及 `@paperai/ui-workbench` 在起始页上声明的 `paperai.start.mark` seat 提供 PaperAI 品牌标识，并通过带键的 `conversation.hero.agentPreset.mark` slot 提供装饰性的 Codex、Claude 与内置 DSH 引擎图标。标志是按产品 logo 描摹的图形——机器人头的钢笔尖落在一本翻开的书上，书压成黄金矩形——以 `brand-paths.ts` 中的一条 even-odd 路径交付并用 `currentColor` 填色，本包样式表把该颜色设为 `--paperai-brand-gold`，宿主的 class 可以改写它：宿主预留一个正方形边长，竖向的图形以高度填满该边长、宽度按图形比例得出，因此侧边栏、hero 与起始页显示的是同一枚标志，各按自己的尺寸。字标是 `PaperAI` 的轮廓，与 DSH 字标同为 24px 高、使用主标签墨色，以 `data-brand-name="PaperAI"` 供测试与工具识别，而不是渲染文本。没有说明行、没有 hero 文案。配色由本包的 iOS token 层负责：`theme.ts` 通过 `ctx.theme.overrideTokens` 在出厂 DSH 调色板之上叠加一层别名 token，取 iOS 系统调色板（浅色为 `#f2f2f7` 分组底色上的白色内容；深色为黑色内容、`#1c1c1e` 底色与抬升的 `#2c2c2e` 卡片），标签用系统灰，悬停、按下与输入框用半透明灰色填充，系统蓝是选中态、焦点环、链接与填充按钮共用的唯一 tint。每个文字 token 都满足 WCAG AA 4.5:1，由插件测试从 token 值算出：覆盖每种纯色底、叠在这些底上的半透明灰色填充、每种状态色与文档类型自己的浅色底，以及白纸上的纸面墨色。两种配色都把 tint 拆开：承载白字的填充用 `#0066cc` 与 `#0071e3`，白字经 `--dsw-alias-button-primary-foreground` 与 `--dsw-specific-bubble-foreground` 着色；文字与标记用 `#0060c0` 与 `#64b0ff`。标签用 iOS 增强对比度的灰色（二级 `#545458` / `#c7c7cc`，三级与说明 `#636366` / `#aeaeb2`），错误文字用 `#c80013` / `#ff8a82`，浅色的成功与警告文字用 `#1b7031` 与 `#b83000`，文档类型强调色在浅色下加深、深色下提亮，直到徽标文字在自己的浅色底上达标。该层从不覆盖 `--dsw-alias-label-primary-foreground`，DSH 把它当作主标签色的反色。它还设置 SF Pro 字体栈、焦点环、bar 与 thick 材质、分段控件别名、更柔和的 DSH 投影、工作台文档类型徽标使用的 `--paperai-type-*` 强调色、`--paperai-page-shadow`、`--paperai-float-shadow` 与 `--paperai-card-shadow` 投影，以及让标志在两种配色下都保持金色的 `--paperai-brand-gold`，组件样式表因此不含任何字面颜色或投影。每个 token 都同时给出浅色与深色两个值，因此用户的浅色/深色/跟随系统偏好照常决定应用哪一侧，插件卸载即撤除该层。所有图标都对辅助技术隐藏，无障碍名称由相邻的字标或预设名称提供。

插件同时把产品语言覆盖到 shell 上。`PROJECT_COPY` 以 `zh` 和 `en` 两种语言把 `workspace` 与 `conversation` 命名空间里所有称呼“工作区”的键——从侧边栏区段、分组、添加、返回、详情与会话标签，到选择器、冲突、重命名与删除文案、操作菜单，以及 hero 的工作区占位与选择片——改写为“项目”，并通过 `ctx.locale.override` 安装。未列出的键保持 DSH 文案，两种语言携带相同的键集合，因此不会有一种语言回退到另一种；插件卸载即撤除覆盖。

三个品牌 occupant 通过嵌套的 `slots.inject()` 作为一组声明感知注册安装，起始页标志与预设图标各自跟随自己的声明。因此无论本包条目先于还是后于侧边栏、会话及工作台声明方激活，它都能工作；任一声明折叠时会撤回全部 occupant，HMR 期间不会留下混合品牌。它不保留运行时状态。node 半边是空的 Loader seat，浏览器标题不由本包负责。

PaperAI 产品 profile 在挂载本包前必须禁用 `@deepseek-ai/dsh-client-ui-brand-official`，因为两个插件占用相同的 single slot。

ACP 目录通过带键的 `paperai.acp.channel.mark` slot 复用 Codex 与 Claude 预设图标。注册跟随 ACP 设置声明，声明撤除时一并移除。

## 模型体验

### 浏览器品牌呈现

#### 模型看到的内容

无；本包只在浏览器中占用 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`、`paperai.start.mark`、`conversation.hero.agentPreset.mark` 和 `paperai.acp.channel.mark`，并改写 shell 文案。

#### Token 影响

为零；本包不注册提示词、工具 schema、会话事件或模型请求输入。

#### KV Cache 影响

无；仅用于浏览器的品牌呈现不会组装或发送 provider 请求。

## 已知限制与暂缓事项

- **对比度检查范围有限** —— 浅色三级说明文字、成功和警告文字，以及半透明 tint 填充不在 AA 检查范围内；部分既有组合仍低于 4.5:1。
- **slot 所有权互斥** —— 产品 profile 不得同时挂载本包与 `@deepseek-ai/dsh-client-ui-brand-official` 等其他 occupant；single slot 会拒绝优先级相同的重复注册。
- **浏览器标题相互独立** —— 本包不设置构建期页面标题。
- **语言覆盖只限于命名空间** —— 只改写 `workspace` 与 `conversation` 两个命名空间；其他 DSH 包拥有的文案保持 DSH 自己的措辞。
