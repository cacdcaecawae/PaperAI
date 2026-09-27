# `@paperai/export-service`

[English](README.md) | 中文

`ctx.paperExports` 为 PaperAI Host UI 发布经过检查的 DOCX，并通过 Cordis effect 注册到 `ctx.paperMcp.registerExportAdapter()`。只有在该提供者挂载期间，MCP 才会提供 `paperai_export_document`。

## 配置

- `maxExportBytes` 限制单次导出复制的不可变提交快照，默认 512 MiB。
- `overwriteExisting` 控制是否替换用户明确选择的现有普通 DOCX，默认值为 `true`。无论该设置如何，源文档、Working DOCX、提交快照、符号链接和非普通文件都不会被覆盖。

## 语义

`exportDocument()` 同时接受 Host 调用和当前 `PaperMcpExportAdapter` 请求。服务始终自行调用 `paperTemplates.check()`，因此 MCP 先前生成的报告不能绕过当前文档状态。草稿导出保留并返回全部 finding；如果正式交付报告满足 `deliveryBlocked()`，服务会在创建提交、临时文件或输出前以 `DELIVERY_BLOCKED` 拒绝。

所有调用方（包括完全访问模式的 Agent）都只能发布到所属项目的 `exports/` 目录。提供方自行解析项目，并在里程碑提交前及发布前复查目标的真实父目录。被重定向的 `exports/` 根目录或逃逸的目录链接会以 `DESTINATION_PROTECTED` 失败；受管理的文档、模板和历史版本因此不能作为导出目标。

允许导出后，服务使用传入 `DocumentRecord` 中观察到的 head，通过 `paperCommits` 提交一个 `milestone` 变更。head 已移动时由 commit-service 的乐观并发检查拒绝。提交原样保留传入的人工或 Agent 身份，包括 client、provider、model、revision、session 和 run 来源。

服务只从新提交的不可变 `snapshotPath` 发布，不读取 Working DOCX 作为导出源。它以独占方式在目标目录中创建随机临时文件并保持其句柄打开，通过该句柄复制快照，校验大小和 SHA-256，同步后再次检查受保护路径，再通过重命名发布。随后它确认目标的真实父目录未变，且目标正是该句柄持有的文件（设备号与 inode 相同）；被并发目录替换重定向的发布会以 `DESTINATION_PROTECTED` 失败。发布失败时，服务通过句柄而非路径清空输出，临时文件未被重命名时将其删除，且不会修改导入源文件或 Working DOCX。携带 `writableRoot` 的请求（MCP 桥在除完全访问外的所有沙箱模式下都传入会话工作区）会在发布时按真实路径约束：目标文件的真实父目录必须位于真实根目录之内，比较时遵循平台的大小写语义（只在 Windows 上折叠大小写，区分大小写的文件系统上 `paper` 与 `Paper` 仍是两个目录），因此工作区内的目录链接无法把文件带到别处；该检查在里程碑提交之前和重命名之前各执行一次，失败时以 `DESTINATION_OUTSIDE_WORKSPACE` 拒绝。

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
- 发布依靠路径检查而非目录句柄进行约束：Node 不提供 `openat()` 或 `renameat()`，Windows 也没有 `O_NOFOLLOW`。如果能在 `exports/` 内写入的进程在最后一次发布前检查与 `rename()` 内部的路径解析之间，把某个上级目录替换为链接，重命名就会落入该链接指向的目录。重命名只能在临时文件当时所在的位置成功，因此只会落入该进程本就能写入的目录；若启用 `overwriteExisting`，还会替换该目录中的同名文件。重命名后的确认会发现这种逃逸、清空输出并使导出失败，但无法恢复被替换的文件；该确认本身也是两次路径查询，在两次查询之间来回切换链接的进程可以绕过它。`publishSnapshot()` 中的 `FIXME:` 跟踪此问题。
