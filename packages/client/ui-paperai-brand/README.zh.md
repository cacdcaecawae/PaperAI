# @paperai/ui-brand

[English](README.md) | 中文

本包通过既有的 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark` slot 以及 `@paperai/ui-workbench` 在起始页上声明的 `paperai.start.mark` seat 提供 PaperAI 品牌标识，并通过带键的 `conversation.hero.agentPreset.mark` slot 提供装饰性的 Codex、Claude 与内置 DSH 引擎图标。标志是按产品 logo 描摹的图形——机器人头的钢笔尖落在一本翻开的书上，书压成黄金矩形——以 `brand-paths.ts` 中的一条 even-odd 路径交付并用 `currentColor` 填色：宿主预留一个正方形边长，竖向的图形以高度填满该边长、宽度按图形比例得出，因此侧边栏、hero 与起始页显示的是同一枚标志，各按自己的尺寸。字标是 `PaperAI` 的轮廓，与 DSH 字标同为 24px 高、使用主标签墨色，以 `data-brand-name="PaperAI"` 供测试与工具识别，而不是渲染文本。没有说明行、没有 hero 文案，也没有主题层：颜色保持出厂的 DSH 主题，只有标志与字标属于 PaperAI。所有图标都对辅助技术隐藏，无障碍名称由相邻的字标或预设名称提供。

插件同时把产品语言覆盖到 shell 上。`PROJECT_COPY` 以 `zh` 和 `en` 两种语言把 `workspace` 与 `conversation` 命名空间里所有称呼“工作区”的键——从侧边栏区段、分组、添加、返回、详情与会话标签，到选择器、冲突、重命名与删除文案、操作菜单，以及 hero 的工作区占位与选择片——改写为“项目”，并通过 `ctx.locale.override` 安装。未列出的键保持 DSH 文案，两种语言携带相同的键集合，因此不会有一种语言回退到另一种；插件卸载即撤除覆盖。

三个品牌 occupant 通过嵌套的 `slots.inject()` 作为一组声明感知注册安装，起始页标志与预设图标各自跟随自己的声明。因此无论本包条目先于还是后于侧边栏、会话及工作台声明方激活，它都能工作；任一声明折叠时会撤回全部 occupant，HMR 期间不会留下混合品牌。它不保留运行时状态。node 半边是空的 Loader seat，浏览器标题不由本包负责。

PaperAI 产品 profile 在挂载本包前必须禁用 `@deepseek-ai/dsh-client-ui-brand-official`，因为两个插件占用相同的 single slot。

## 模型体验

### 浏览器品牌呈现

#### 模型看到的内容

无；本包只在浏览器中占用 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`、`paperai.start.mark` 和 `conversation.hero.agentPreset.mark`，并改写 shell 文案。

#### Token 影响

为零；本包不注册提示词、工具 schema、会话事件或模型请求输入。

#### KV Cache 影响

无；仅用于浏览器的品牌呈现不会组装或发送 provider 请求。

## 已知限制与暂缓事项

- **slot 所有权互斥** —— 产品 profile 不得同时挂载本包与 `@deepseek-ai/dsh-client-ui-brand-official` 等其他 occupant；single slot 会拒绝优先级相同的重复注册。
- **浏览器标题相互独立** —— 本包不设置构建期页面标题。
- **语言覆盖只限于命名空间** —— 只改写 `workspace` 与 `conversation` 两个命名空间；其他 DSH 包拥有的文案保持 DSH 自己的措辞。
