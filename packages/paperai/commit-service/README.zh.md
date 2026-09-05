# @paperai/commit-service

[English](README.md) | 中文

PaperAI 的可恢复文档版本服务。`PaperCommitService` 提供 `ctx.paperCommits`，是人工或 agent（智能体）修改权威 Working DOCX 的唯一受支持路径。`submit()` 或 `revert()` 成功时，修改已经应用且文档 head 已前移；不要求用户再次确认。

`inspectProject(project)` 只读检查已登记原件、工作文件、当前版本、路径归属和保留快照，返回问题与独立的 `WorkingRecoveryPlan` 候选方案。`recoverMissingWorking(plan)` 与文档提交串行，重新检查当前提交和最新扫描结果，验证快照字节及项目内无符号链接的目标祖先，再原子创建缺失的工作文件，不覆盖已存在目标。过期方案会被拒绝。恢复只是重新实体化已有当前提交，保留历史且不创建内容提交。原件丢失、快照损坏、重复归属和外部修改只报告问题，不自动修复。仅含传输数据的报告和方案类型通过 `/doctor-types` 发布。

## 服务：`PaperCommitService`（`ctx.paperCommits`）

该服务依赖 `paperRepository`、`documentEngine` 和 `paperDocuments`。

- `submit(request)` 应用有序修改批次，并在发布完成后返回新的 `DocumentCommit`。
- `revert(request)` 把一个可达快照恢复为新的子提交，而不是把 head 向后移动。
- `getCommit(commitId)` 按 id 读取一份隔离的提交对象。
- `listHistory(documentId)` 从新到旧沿 `headCommitId` 和 `parentId` 读取历史，不包含不可达的恢复对象。

`submit()` 要求非空消息和至少一项修改。`baseCommitId` 必须等于当前 head；只有首次提交前可以省略。`revert()` 要求调用方提供当前 head，并指定一个不同且从该 head 可达的目标。

编译的修改覆盖 `replace-text`、`insert-node`、`delete-node`、`bind-template`、`unbind-template`、`set-document-type` 与 `milestone`。`bind-template` 会以同一提交要切换到的文档类型调用 `paperTemplates.validateAssociation()`；`unbind-template` 在文档没有绑定模板时失败；`set-document-type` 在类型未变化时失败，并且除非同一提交绑定了另一模板，否则会先记录一条 `unbind-template` 操作，因为一份绑定的格式只适用于一种类型。发布的 `DocumentRecord` 携带最终的类型与模板绑定。

## 发布与恢复

每个文档有一个进程内 FIFO。服务把 Working DOCX 复制为项目内的私有候选文件，把受支持的领域修改编译为 Office 路径修改，要求 `documentEngine` 保存并校验候选文件，再要求 `paperDocuments` 重建语义索引但不发布索引。

发布在修改权威状态前，会持久存储一条文档级写前记录。该记录包含不可变提交、发布前后的完整文档与节点状态，以及原始 Working DOCX 的内容寻址快照。随后发布依次存储提交对象、原子替换 Working DOCX、替换节点索引、更新 `DocumentRecord.headCommitId`，最后清除日志。head 更新仍是发布点。

服务初始化会在接受工作前恢复所有保留日志；每个 FIFO 操作也会在响应调用方取消前重新检查其文档。日志中的当前 head 仍为所记录父提交时，服务回滚 Working DOCX 与节点索引；当前 head 已是所记录提交时，服务完成该提交并清除日志。恢复只接受日志记录的原始或候选 Working SHA-256，也只接受日志发布前后状态中的节点值；未知 head、文件、节点、快照或冲突提交会引发 `RECOVERY_FAILED` 或相应快照错误，日志会保留，未知数据不会被覆盖。

进程内发布失败使用同一恢复过程。head 更新前的失败会在回滚后拒绝；如果后端先存储了 head 再报告失败，恢复会完成提交，原操作成功。Working DOCX 与节点回滚会分别尝试；恢复不完整时以 `AggregateError` 拒绝，并保留持久日志供启动或下一次操作继续处理。

服务在发布前立即同时比较 base head 和捕获的 Working DOCX SHA-256。陈旧 head 会引发 `HEAD_CONFLICT`；绕过提交路径修改文件会引发 `WORKING_COPY_CHANGED`，而不会覆盖该文件。

操作在 FIFO 中等待及候选文件准备期间都接受调用方取消。持久发布开始后，操作会先完成发布或回滚，再结束调用。

## 文档索引对等接口

服务使用 `ctx.paperDocuments` 上的结构接口 `PaperDocumentIndexPeer`。`readNodes(documentId)` 返回当前稳定索引。`buildCandidateIndex(request)` 检查临时候选文件并返回带有指定文档 id 和提交 id 的节点；它不得发布这些节点，也不得修改权威 Working DOCX。该名称与权威索引重建操作明确区分，防止准备阶段误用会直接发布的接口。

该接口让 `@paperai/document-service` 负责 Office 路径解析、语义身份协调、节点哈希和索引重建，无需在提交服务中复制这些规则。

## 快照与历史

DOCX 快照是项目内的内容寻址对象，路径为 `.paperai/objects/docx/<prefix>/<sha256>.docx`。发布只在全部字节写完后创建最终对象，复用已有对象前会校验内容，并且绝不就地修改对象。

回滚的发布可能留下不可达提交或快照对象，其中包括首次提交回滚所保留的原始 Working 映像。`listHistory()` 仅暴露从当前文档 head 可达的父提交链。已知对象 id 时，`getCommit()` 特意允许直接检查恢复对象。

`revert()` 会校验目标快照路径与 SHA-256，在私有副本上校验并重建索引，恢复目标提交的模板绑定但保留文档当前的类型，然后创建以当前 head 为父级的新提交。恢复后的字节可以复用目标的内容寻址快照，而 actor 和操作来源仍只属于这次 revert 提交。

## 来源与失败

每次提交都会原样保留调用方提供的 `ActorIdentity`，不会从进程状态推断模型。agent 提交要求 `client`、`model` 和 `sessionId` 均非空；人工和系统 actor 会保留调用方提供的客户端、提供方、模型修订、会话及运行字段。

预期的调用方失败使用 `PaperCommitError.code`。`DocumentHeadConflictError` 保留预期和实际 head，`DocumentValidationError` 保留结构化 Office 校验证据。`RECOVERY_FAILED` 表示服务无法证明当前状态属于所保留日志的任一侧。如果发布失败且恢复也失败，调用会以包含两种结果的 `AggregateError` 拒绝。

## 模型体验

### 持久文档提交

#### 模型看到的内容

本包不会直接添加内容。面向 agent 的消费方可以渲染返回的 `DocumentCommit`，但该渲染由消费方负责。

#### Token 影响

直接 token 为零；该服务不会添加提示词、消息、工具 schema 或工具结果。

#### KV Cache 影响

无；文档提交不会组装或发送提供方请求。

## 已知限制与延后工作

- **修改覆盖范围** — 当前文档引擎接口支持文本替换、段落插入和节点删除。`set-style` 与 `set-fact` 会明确失败，直到各自的所属服务提供可执行操作；快照恢复必须使用 `revert()`。
- **进程范围** — FIFO 排序以单个 Host 进程为范围。head 与文件指纹检查会拒绝已观察到的外部修改，但独立运行的多个 Host 不共享写锁。
- **不可达存储对象** — repository 没有跨记录事务或删除提交对象的操作，因此对象存储后的发布失败可能保留不可达的提交与快照，等待后续垃圾回收。
