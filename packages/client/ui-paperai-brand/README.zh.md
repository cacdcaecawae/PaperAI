# @paperai/ui-brand

[English](README.md) | 中文

本包通过既有的 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark` slot 提供 PaperAI 品牌标识，并通过带键的 `conversation.hero.agentPreset.mark` slot 提供装饰性的 Codex、Claude 与内置 DSH 引擎图标。它遵循 DSH 组件约定，使用 CSS Modules 与语义设计 token 呈现克制的文档图标、`paperai` 字标及中文说明 `论文工作台`，不引入另一套 shell 或主题。提供方图标会对辅助技术隐藏，由相邻的预设名称提供无障碍标签。

插件同时安装一层 `ctx.theme.overrideTokens`（`PAPERAI_THEME_TOKENS`）：DeepSeek 蓝的强调色族替换为学术松青，并配套明暗两种配色方案下的对话气泡与侧栏柔和底色。中性色、字体、间距与布局 token 保持原样；插件卸载即移除该层。

三个 occupant 通过嵌套的 `slots.inject()` 作为一组声明感知注册安装。因此无论本包条目先于还是后于侧边栏及会话声明方激活，它都能工作；任一声明折叠时会撤回全部 occupant，HMR 期间不会留下混合品牌。它不保留运行时状态。node 半边是空的 Loader seat，浏览器标题不由本包负责。

PaperAI 产品 profile 在挂载本包前必须禁用 `@deepseek-ai/dsh-client-ui-brand-official`，因为两个插件占用相同的 single slot。

## 模型体验

### 浏览器品牌呈现

#### 模型看到的内容

无；本包只在浏览器中占用 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark` 和 `conversation.hero.agentPreset.mark`。

#### Token 影响

为零；本包不注册提示词、工具 schema、会话事件或模型请求输入。

#### KV Cache 影响

无；仅用于浏览器的品牌呈现不会组装或发送 provider 请求。

## 已知限制与暂缓事项

- **slot 所有权互斥** —— 产品 profile 不得同时挂载本包与 `@deepseek-ai/dsh-client-ui-brand-official` 等其他 occupant；single slot 会拒绝优先级相同的重复注册。
- **浏览器标题相互独立** —— 本包不设置构建期页面标题。
