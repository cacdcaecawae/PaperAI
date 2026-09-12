# `@paperai/document-engine`

[English](README.md) | 中文

PaperAI Word 能力 seam 的 Service Definition，以 `ctx.documentEngine` 暴露。它定义健康状态、文本节点检查、结构化 Office path 检查、生成 HTML 预览、批量语义修改和验证，同时让消费方不依赖 OfficeCLI 或进程传输细节。

Provider 必须串行化指向同一规范 Working DOCX 的操作。`applyMutations` 持有贯穿保存过程的独占 lease；消费方在其外部创建和发布可恢复快照。HTML 被明确限定为预览结果。

替换操作可以携带多个段落及其字符片段和段落格式。同次保存拆分多个原始段落时，消费方必须保持原有位置地址有效；浏览器工作台先提交靠后的节点。Provider 会拒绝替换无法重建的段内对象，由版本服务丢弃候选文件。

## 模型体验

### 引擎支持的文档操作

#### 模型看到的内容

`ctx.documentEngine` 不增加提示词、工具 schema 或结果。PaperAI MCP 与工作台消费方决定是否把检查文本、验证证据或操作失败呈现给模型。

#### Token 影响

直接影响为零。将引擎结果投影到模型请求中的消费方负责这些 token 及其输出上限。

#### KV Cache 影响

本服务不发起模型请求。只有消费方把变化后的引擎输出放入后续请求时，DOCX 变化才会影响缓存复用。

## 已知限制与暂缓事项

- v1 定义的是 DOCX/Word 形态的 seam；ODF 或 LaTeX 等其他 Provider 需要独立能力约定。
- 复杂版式证据继续由 Provider 以结构化数据持有，直到门禁包稳定各类规则 schema。
