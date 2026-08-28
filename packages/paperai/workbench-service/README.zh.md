# `@paperai/workbench-service`

[English](README.md) | 中文

PaperAI 工作台的 Host Remote，作为产品层接入固定版本的 DeepSeek Harness 客户端。它会把所选 DSH 工作区幂等初始化为 PaperAI 项目，投影资源列表与只读 OfficeCLI HTML，只为当前选中的语义节点提供临时编辑缓冲，并让每次保存或回退都经过 `ctx.paperCommits`。

资源列表将 Working 文档与模板约定保留为领域服务持有的行。它只递归投影 `figures/`、`experiments/` 与 `code/` 下真实且非空的目录树，不跟随符号链接，也不从原始文件推导 Working 文档或模板行。持久化的 `paperai` `documents` put 引用了确实存在的 head commit 后，Host 会发出 JSON-safe 的 `paperai/document-changed` 事件，其中包含 `documentId`、`headCommitId` 与 `updatedAt`。

Working DOCX 是唯一正文权威。预览 HTML 只用于显示，任何修改接口都不接受整份 HTML。编辑请求同时携带已观察到的文档 revision 与 head commit；成功后立即返回带人工来源的可恢复版本。

文档导入与根版本创建构成一个工作台操作。如果根提交被拒绝或取消，Host 会等待不可取消的文档回滚完成后再拒绝请求；原始上传文件或模板源保持不变。根提交成功后，后续预览或打开失败不会删除已经提交的文档。

`exportDocument()` 返回判别结果。草稿发布和通过检查的正式交付返回带输出及里程碑版本工作台状态的 `status: 'success'`。因模板错误受阻的正式交付返回带未变 revision 与可投影门禁报告的 `status: 'blocked'`，既不创建输出，也不创建导出里程碑；其他导出失败仍会拒绝请求。服务为每份文档最多保留一份门禁报告，并且只在记录的 revision 与文档一致时投影该报告。

## 模型体验

### 浏览器工作台状态

#### 模型看到的内容

`ctx.paperaiWorkbench` 提供浏览器投影，不向 Agent 请求增加提示词、工具 schema 或结果。Codex 与 Claude 通过 PaperAI MCP 分别访问同一组领域服务。

#### Token 影响

直接影响为零。资源行、预览 HTML 与所选节点缓冲区保持为浏览器状态。

#### KV Cache 影响

工作台读写不组装模型请求，因此不会直接改变 Provider 缓存复用。

## 已知限制与延后工作

- v1 浏览器编辑仅支持单个语义节点的纯文本；更丰富的样式修改留给 OfficeCLI 与领域层扩展。
- Working 文档之外的文件系统资源当前只作为导航上下文投影，不由此 Remote 编辑。
