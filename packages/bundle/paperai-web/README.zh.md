# `@paperai/bundle-web`

[English](README.md) | 中文

PaperAI 是固定版本 DeepSeek Harness Web profile 之上的产品层。它在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后应用，保留 DSH Host、Harness/Loop、会话、Settings、凭据、模型选择、权限、工作区基础设施、传输层和客户端插件树。

[`cordis.patch.yml`](cordis.patch.yml) 只禁用上游官方品牌 contribution，并通过既有客户端 slot 插入 PaperAI 品牌与文档工作台插件。文档服务和 UI 插件以各自拥有的独立配置行加入这一层；通用 DSH 行为不会被复制进产品组合包。

PaperAI 工作台通过既有 `ui-layout` 服务配置 420–960 px 的详情栏范围、600 px 的打开宽度、560 px 的中栏下限，以及 `current-session` 详情可见条件。

权限继续由 `@deepseek-ai/dsh-base` 负责。当用户保存的权限默认值以及部署或 profile 配置都没有选择其他 preset 时，新的 PaperAI 会话以 `workspace-write` 和 `ask` 启动：Agent 可以修改所选 Workspace，超出该权限的操作需要请求批准。用户仍可通过标准 DSH 权限选择器主动开启完全访问，并完成既有风险确认；部署方也可以通过明确配置覆盖默认值。

使用 `pnpm paperai` 运行源码 profile。profile 自有的 `cordis.patch.yml` 与 DSH home patch 仍然应用在本组合包之上，因此标准 DSH 配置和插件管理继续可用。

## 模型体验

### PaperAI profile 组合

#### 模型看到的内容

`@paperai/bundle-web` 自身不增加提示文本、工具 schema 或结果。它挂载 PaperAI Agent、MCP 与文档服务配置行；每个被挂载的包负责自身贡献的上下文。

#### Token 影响

直接影响为零。被挂载的包负责各自的提示词、工具 schema 与工具结果 token。

#### KV Cache 影响

本组合包不组装模型请求。修改其 patch 组合可能改变后续会话挂载的提示词或工具集合；由受到影响的包负责对应缓存行为。

## 已知限制与暂缓事项

- PaperAI 目前是仓库内私有产品 profile，尚未作为独立 npm 组合包发布。
- 后续 PaperAI 配置行必须保持可加，并各自提供 Loader/组合测试与 invariant。
