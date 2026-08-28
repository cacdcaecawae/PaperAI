# `@paperai/domain`

[English](README.md) | 中文

PaperAI 与传输无关的领域词汇，覆盖项目、权威 Working DOCX、语义节点与修改、模板约定、交付门禁、可恢复文档提交、来源信息、冲突和选中章节缓冲区。

跨包 id 在编译期带有品牌类型，在磁盘和协议中仍是普通字符串。本包不持有持久化、OfficeCLI 进程、Cordis 服务、UI、传输或 Agent 行为；其他包依赖这套词汇，而不是重复定义数据形状。

`deliveryBlocked(report)` 是导出消费方共用的与传输无关解释：只有 `delivery-export` 模式中的有效 hard error 才阻止正式交付。草稿与持续检查可以继续报告，不会隐式成为保存边界。

## 模型体验

### 领域记录

#### 模型看到的内容

`DocumentCommit`、`TemplateContract` 和 `GateReport` 等类型不会由本包序列化进模型上下文。MCP 或 Agent 消费方负责选择字段和渲染结果。

#### Token 影响

直接影响为零。投影领域记录的消费方负责由此产生的 schema、消息或工具结果 token。

#### KV Cache 影响

本包不贡献请求内容。只有消费方把变化后的记录投影到后续请求中，记录变化才会影响缓存复用。

## 已知限制与暂缓事项

- 首版词汇针对 Word/DOCX 论文工作流；尚不包含电子表格、演示文稿、LaTeX 和协同编辑记录。
- 视觉分页证据暂时保留开放的 `actual`/`expected` 载荷，待 OfficeCLI 门禁 Provider 拥有稳定 schema。
