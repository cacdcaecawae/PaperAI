# `@paperai/repository`

[English](README.md) | 中文

PaperAI repository 服务（`ctx.paperRepository`）构建在 DSH `storage-domain` 之上。产品 profile 把带版本的 `paperai` domain 路由到 DSH SQLite 后端，而 Web profile 的其他数据可以继续使用原有存储路由。

Repository 持有项目、文档、语义节点、可恢复提交、提交发布日志、模板约定和冲突的运行时验证与类型化表。读取同步来自 storage-domain 的权威内存状态；写入使用其单一持久队列，并只在 SQLite 写入落盘后发出标准 `domain/changed` 事件。

`commit_publications` 为每个文档最多保留一条写前记录。每条记录包含不可变提交、发布前后的文档与节点状态，以及回滚所需的内容寻址 Working DOCX 映像。`@paperai/commit-service` 仅在完成由 head 判定的状态后清除该记录。

提交发布日志是 PaperAI v1 KV unit 的兼容增量扩展。首次打开已有 v1 SQLite 存储时，存储后端会在加载 domain 前幂等创建缺失的 `commit_publications` 表。unit 版本标记与所有已有记录均保持不变；不需要删除用户状态或重写记录。

## 模型体验

### Repository 状态

#### 模型看到的内容

`ctx.paperRepository` 不增加提示词、工具 schema 或结果。命令与 MCP 消费方负责项目、文档、提交、模板和冲突的所有模型可见投影。

#### Token 影响

直接影响为零。读取并渲染 repository 记录的消费方负责由此产生的 token 数量和输出上限。

#### KV Cache 影响

Repository 写入本身不会进入模型请求。只有消费方把变化后的记录投影到后续上下文中，缓存复用才会改变。

## 已知限制与暂缓事项

- 1 以外的 unit 版本仍不兼容，并会在修改记录前明确失败。
- SQLite 后端是进程内方案，不提供多进程写入仲裁。
