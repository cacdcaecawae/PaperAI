# `@paperai/document-service`

[English](README.md) | 中文

PaperAI 文档服务通过 `ctx.paperDocuments` 暴露。它将 Word 源文件导入项目，分别保存不可变源文件快照和作为正文权威的 Working DOCX，通过 `ctx.documentEngine` 建立有序语义节点索引，并提供生成式 HTML 预览。

## 服务 API

- `importDocument(request, signal?)` 接受 `.docx` 和 `.doc`。成功结果包含已持久化的文档记录和完整节点索引；能力不可用时返回 `{ status: 'degraded', capability, health, detail }`，且不发布文档记录。
- `rollbackImport(documentId)` 删除尚未获得 head commit 的 Working 导入。清理过程不可取消，会删除服务持有的不可变副本、Working 副本及其索引，但绝不删除传给 `importDocument` 的原始源文件。
- `listDocuments(projectId, role?)` 按确定顺序返回项目文档，并可按角色精确筛选。
- `readDocument(documentId)` 从仓库读取元数据和有序节点，不再次读取 Word 文件。
- `verifyImmutableSource(documentId, signal?)` 校验导入源仍是只读普通文件，且内容与记录的 SHA-256 一致。Consumer 在读取或复制源文件字节前调用该方法。
- `previewHtml(documentId, signal?)` 渲染当前 Working DOCX；HTML 只用于预览。
- `rebuildIndex(documentId, signal?)` 重新读取 Working DOCX 并替换语义索引，不创建文档提交。

## 文件与索引语义

导入过程使用 `<project>/.paperai/documents/v1` 下的同文件系统私有暂存目录。发布后的不可变原件位于 `documents/source/`，权威 Working DOCX 位于 `documents/working/`。不可变源文件会复制到排他的最终路径，与暂存内容核对哈希，并在发布记录前设为只读。Working DOCX 是独立的可写文件；修改任一文件都不会影响另一个。已追踪文档的名称即使在文件缺失时仍被占用；遇到这些名称或已有文件时，依次追加 ` (2)`、` (3)` 等后缀。已有记录继续使用其记载的路径。节点身份依次根据语义哈希、相关文本和 Office 路径证据保留；成功匹配的节点继续保留 lineage、样式元数据和最近提交归属。

当前锁定的 OfficeCLI 支持 `.docx`、`.xlsx` 和 `.pptx`，不支持旧版二进制 `.doc`。文档引擎 Provider 可以实现 `LegacyDocumentNormalizer`；否则 `.doc` 导入会明确返回 `legacy-doc-normalization` 降级结果。服务只有在得到一个新生成且非空的 DOCX 后才会报告 `.doc` 导入成功。

本服务不写入提交历史。文档提交包负责正文修改、快照、操作者/模型来源，以及在 Working DOCX 修改完成后调用 `rebuildIndex`。

## 模型体验

### 文档服务状态

#### 模型可见内容

模型不会直接看到 `ctx.paperDocuments` 的内容。PaperAI 命令和 MCP 工具决定哪些文档记录、节点、预览与降级结果对模型可见。

#### Token 影响

直接 Token 数为零。将服务数据投影进模型请求的 Consumer 负责说明相应 Token。

#### KV 缓存影响

没有直接影响。仓库或预览变化只有在 Consumer 将其投影进模型请求后才会影响模型上下文。

## 已知限制与延期工作

- 文本节点读取不能提供完整样式或父级元数据。重建时会为匹配节点保留已有样式，新节点以空样式记录开始。
- 文件发布与仓库写入不能共享一个文件系统/SQLite 事务。服务先发布文件，并在仓库写入失败时回滚；只有进程恰好在两个持久化点之间崩溃时，才可能留下未被记录引用的文件。
- 在配置的文档引擎实现 `LegacyDocumentNormalizer` 前，旧版 `.doc` 支持保持降级状态。
