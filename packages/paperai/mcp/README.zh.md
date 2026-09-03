# @paperai/mcp

[English](README.md) | 中文

从 DSH Host 向本地 Codex 和 Claude ACP Agent 提供带身份认证的 PaperAI MCP 领域桥。

## Host 服务

插件提供 `ctx.paperMcp`，并在 `ctx.webServer` 注册一个精确匹配的 Streamable HTTP 路由。`issueDescriptor(actor, scope)` 返回兼容 ACP 的 HTTP MCP descriptor 及幂等 disposer。随机 Bearer token 绑定由 lease 管理的 Agent 身份，因此调用方不能通过工具参数伪造或改写修改来源。lease 的访问范围记录所属会话的工作区根目录，并按请求读取其沙箱模式：每个工具都解析拥有该根目录的 PaperAI 项目，其他项目的记录一律以 `PROJECT_OUT_OF_SCOPE` 拒绝（没有项目拥有该工作区时为 `NO_PROJECT_FOR_SESSION`），修改类工具在 `read-only` 下以 `READ_ONLY_SESSION` 拒绝——与原生 DSH 文档工具施加的是 `@paperai/domain` 里同一套共享检查，因此在 DSH 会话上执行 `/permission` 切换后，下一次 MCP 调用即受其约束，无需重新签发 descriptor。导出工具还会像文件系统工具约束写入那样约束目标路径：`workspace-write` 下解析后的路径必须位于会话工作区内（相对路径按工作区解析），否则以 `WRITE_OUTSIDE_WORKSPACE` 失败；工作区还会作为 `writableRoot` 传给导出提供方，由它在发布时按真实路径复查父目录，工作区内的目录链接也无法把文件带出去（`DESTINATION_OUTSIDE_WORKSPACE`）；只有 `danger-full-access` 才能发布到别处。

ACP 会话所有者让 descriptor lease 与 Agent 生命周期一致：

```ts ignore
const lease = ctx.paperMcp.issueDescriptor({
  kind: 'agent',
  name: 'Codex',
  client: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-codex',
  sessionId: String(agent.session.id),
})

try {
  await runAcpSession({ mcpServers: [lease.descriptor] })
} finally {
  await lease.dispose()
}
```

即使浏览器服务器监听 `0.0.0.0`，descriptor 也只使用回环地址。缺失、格式错误或已撤销的 token 会在 MCP 解析前收到 `401`。插件卸载会移除路由并撤销所有未释放的 lease。

`lease.updateActor(actor)` 允许 ACP Host 在不更换 MCP descriptor 的前提下同步 model controller 变化。lease 永久固定 `client` 与 `sessionId`，只允许替换 Agent 来源字段 `name`、`provider`、`model`、`modelRevision` 和 `runId`。替换会针对后续请求原子生效、返回克隆，并在 lease 释放后失败；当前的 `lease.actor` accessor 也只返回克隆。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `routePath` | `/api/paperai/mcp` | Streamable HTTP MCP 在 WebServer 上的精确路径。 |
| `serverName` | `paperai` | ACP MCP 服务器列表中显示的名称。 |
| `defaultNodesPerRead` | `80` | Agent 未指定读取数量时返回的语义节点数。 |
| `maxNodesPerRead` | `200` | 单次调用最多返回的语义节点数。 |
| `maxMutationsPerCommit` | `64` | 单个文档提交允许的有序修改数。 |

所有数值字段必须是正安全整数，默认读取数不能超过最大值。无效配置会使插件启动失败。

## 工具

基础工具目录保持紧凑：

| 工具 | 模式 | 领域操作 |
|---|---|---|
| `paperai_list_projects` | 只读 | `paperProjects.list()` |
| `paperai_list_documents` | 只读 | `paperDocuments.listDocuments()` |
| `paperai_read_document` | 只读 | `paperDocuments.readDocument()`，并对节点分页设限 |
| `paperai_list_templates` | 只读 | `paperTemplates.listPacks()` 与 `listContracts()` |
| `paperai_get_template` | 只读 | `paperTemplates.getContract()` |
| `paperai_list_versions` | 只读 | `paperCommits.listHistory()` |
| `paperai_check_gate` | 只读 | `paperTemplates.check()` |
| `paperai_prepare_export` | 只读 | 检查导出条件并返回权威 Working DOCX 路径；不会发布文件。 |
| `paperai_commit_document` | 修改 | `paperCommits.submit()` |
| `paperai_revert_document` | 修改 | `paperCommits.revert()` |

提交 schema 只暴露当前提交服务已经实现的修改：替换文字、插入段落、删除节点、绑定模板和记录里程碑。提交 `bind-template` 前，handler 要求 contract 存在、已经确认，并且 `appliesToRoles` 包含目标文档角色；draft 或角色不兼容的 contract 不会进入 `paperCommits.submit()`。修改成功后返回完整 `DocumentCommit`、其中记录的 `provenance`，以及对存储的 continuous 门禁报告的 `gateSummary` 摘要：按严重度计数、最严重的发现排在前面，并给出一条可执行的下一步；未关联模板时给出明确的自由模式提示。乐观 head 冲突和节点文字冲突会在 MCP 错误结果中保留领域错误码。

`registerExportAdapter(adapter)` 会按条件增加 `paperai_export_document`。适配器接收已检查的文档、目标路径、模式和 descriptor 绑定的 actor，并且必须返回属于同一文档和 actor 的 commit；否则 MCP 调用返回 `INVALID_EXPORT_PROVENANCE`。正式交付检查失败时不会调用适配器。调用方通过 Cordis effect 注册适配器并持有 disposer。

`createPaperMcpServer(dependencies, actor, limits, exportAdapter?)` 是 Host 路由使用的传输无关服务器工厂。已经拥有 PaperAI 服务的进程也可以把它连接到 SDK stdio transport。独立子进程若没有额外 RPC 载体便无法访问 Host 内存中的服务，因此当前 Agent descriptor 复用已有的认证 HTTP 载体。

## 失败与所有权

工具处理器返回结构化的 `{ error: { code, message, details? } }`，不会暴露调用栈。可预期的服务错误保留 `code`，未分类错误使用 `PAPERAI_OPERATION_FAILED`。领域桥本身不编辑 DOCX、仓库、模板或导出文件；所有操作都委托给对应的 PaperAI 服务。

每个 HTTP 请求独占一个新的无状态 MCP server 与 transport。响应关闭和插件卸载会关闭其拥有的资源；回调失败会记录日志，不会遗留未处理的 rejection。

## 模型体验

### MCP 工具目录与结果

#### 模型看到的内容

本地 ACP Agent 会收到上述十个基础工具 schema。只有注册导出适配器时才会出现 `paperai_export_document`。只读结果包含当前领域记录；文档语义节点默认不包含样式数据，并采用有上限的分页。

#### Token 影响

工具 schema 为 Agent 会话增加固定的请求前缀。工具结果增加随数据变化的 token；文档节点结果受 `maxNodesPerRead` 限制，修改数组受 `maxMutationsPerCommit` 限制。

#### KV Cache 影响

基础工具目录在 descriptor 生命周期内保持稳定。注册或移除可选导出适配器会改变后续 HTTP 请求创建的工具目录，并可能使提供方可复用的工具 schema 前缀失效；Bearer token 和 actor 值不会进入工具 schema。

## 已知限制与延后工作

- **交付发布需要提供方** — 当前 PaperAI 服务提供交付检查，但没有文件发布服务。`paperai_prepare_export` 保持只读；只有注册实现 `PaperMcpExportAdapter` 的提供方后，才会出现修改型导出工具。
- **生命周期修改需要持久来源记录** — 项目创建、Word 导入、模板安装、上传和确认目前不会从其领域服务返回持久操作 commit，因此本桥只开放这些对象的查询，不提供无跟踪的 Agent 修改。
- **Descriptor 依赖 Host WebServer** — WebServer 获得监听端口前调用 `issueDescriptor()` 会失败。descriptor 固定使用回环地址，因此 ACP Agent 与 Host 必须位于同一台机器。
