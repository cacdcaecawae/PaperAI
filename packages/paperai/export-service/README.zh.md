# `@paperai/export-service`

[English](README.md) | 中文

`ctx.paperExports` 为 PaperAI Host UI 发布经过检查的 DOCX，并通过 Cordis effect 注册到 `ctx.paperMcp.registerExportAdapter()`。只有在该提供者挂载期间，MCP 才会提供 `paperai_export_document`。

## 配置

- `maxExportBytes` 限制单次导出复制的不可变提交快照，默认 512 MiB。
- `overwriteExisting` 控制是否替换用户明确选择的现有普通 DOCX，默认值为 `true`。无论该设置如何，源文档、Working DOCX、提交快照、符号链接和非普通文件都不会被覆盖。

## 语义

`exportDocument()` 同时接受 Host 调用和当前 `PaperMcpExportAdapter` 请求。服务始终自行调用 `paperTemplates.check()`，因此 MCP 先前生成的报告不能绕过当前文档状态。草稿导出保留并返回全部 finding；如果正式交付报告满足 `deliveryBlocked()`，服务会在创建提交、临时文件或输出前以 `DELIVERY_BLOCKED` 拒绝。

允许导出后，服务使用传入 `DocumentRecord` 中观察到的 head，通过 `paperCommits` 提交一个 `milestone` 变更。head 已移动时由 commit-service 的乐观并发检查拒绝。提交原样保留传入的人工或 Agent 身份，包括 client、provider、model、revision、session 和 run 来源。

服务只从新提交的不可变 `snapshotPath` 发布，不读取 Working DOCX 作为导出源。它校验大小和 SHA-256，将内容复制到目标目录中的随机临时文件，同步后再次检查受保护路径，再通过重命名发布。发布失败会删除临时文件，且不会修改导入源文件或 Working DOCX。

## 模型体验

### `paperai_export_document` 可用性与结果

#### 模型看到的内容

本服务与 `@paperai/mcp` 同时挂载期间，MCP 目录包含 `paperai_export_document`。其结果包含输出路径、当前模板报告、里程碑提交和记录的来源信息；本包不增加提示文本。

#### Token 影响

这个条件性工具贡献一个固定 schema。成功和受阻调用会为报告与提交增加随数据变化的结果 token；传输层结果渲染由 MCP 包负责。

#### KV Cache 影响

导出适配器注册期间，schema 集合保持稳定。挂载或卸载本服务会改变后续 MCP 工具目录，并可能使可复用的工具 schema 前缀失效；本服务不保留 Provider KV cache。

## 已知限制与延后工作

- 目标父目录必须已存在；目录选择和创建由 Host UI 工作流负责。
- 里程碑发布后若文件系统操作失败，历史中会保留可恢复的里程碑，同时导出返回失败；不会把输出报告为成功。
