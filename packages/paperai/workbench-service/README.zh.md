# `@paperai/workbench-service`

[English](README.md) | 中文

PaperAI 工作台的 Host Remote，作为产品层接入固定版本的 DeepSeek Harness 客户端。它会把所选 DSH 工作区幂等初始化为 PaperAI 项目，描述该项目（选用的模板与被追踪的文档），投影只读 OfficeCLI HTML 及块级节点摘要，只为当前选中的语义节点提供临时编辑缓冲，并让每次保存、模板变更或回退都经过 `ctx.paperCommits`。

`agentDiagnostics()` 读取可选 ACP provider 的缓存观察，未组装 provider 时返回空名单。`probeAgent()` 请求显式且有时限的初始化，未组装 provider 时失败。`inspectProject()` 只读已登记项目，不创建上下文文件或初始化项目。`recoverWorking()` 验证方案中的文档属于该 Workspace，再交由提交服务处理并返回新扫描。诊断传输类型通过 `/types` 重导出，不将 Host 实现引入浏览器。

`overview()` 描述一个项目：项目名称、模板是否已经选定（`templateDecided`；选择不用模板也算一次决定）、选用的模板及其格式，以及每份被追踪 Word 文档一行，附带其文档类型与所绑定格式的名称。只有领域层追踪的文档会被列出；项目目录里的其他文件从不投影。选用的模板若已不在模板库中，则读作 `null`，而 `templateDecided` 保持为 true，`templatePackId` 保留所选模板的 id。id 为 `null` 表示尚未选择或明确选择自由写作。持久化的 `paperai` `documents` put 引用了确实存在的 head commit 后，Host 会发出 JSON-safe 的 `paperai/document-changed` 事件，其中包含 `documentId`、`headCommitId` 与 `updatedAt`。

`listTemplateLibrary()` 列出用户可选的全部模板：先是内置模板，然后是自定义模板——至少含有一份格式的按创建顺序排列，其后是仍为空的。`createTemplateSet()`、`deleteTemplateSet()`、`addTemplateFormat()` 与 `removeTemplateFormat()` 通过 `ctx.paperTemplates` 维护自定义模板并返回刷新后的模板库；一套自定义模板对每种文档类型最多保留一份格式，因此为同一类型再添加格式会替换原来的那份。`setProjectTemplate()` 通过 `ctx.paperProjects.setTemplateChoice()` 记录项目的选择——指向现有模板的 `packId`，或以 `null` 表示不用模板——并返回刷新后的概览。删除一套自定义模板后，选用它的项目在下一次概览中报告模板缺失，而已经从中安装的格式继续有效。

Working DOCX 是唯一正文权威。预览 HTML 只用于显示，任何修改接口都不接受整份 HTML。编辑请求同时携带已观察到的文档 revision 与 head commit；成功后立即返回带人工来源的可恢复版本。

`importDocument()` 把浏览器选择的一份 `.doc` 或 `.docx` 导入为自由写作的文档：不绑定格式，文档类型保持为 `other`，直到用户或 Agent 设置为止。文档导入与根版本创建构成一个工作台操作。如果根提交被拒绝或取消，Host 会等待不可取消的文档回滚完成后再拒绝请求；原始上传文件或模板源保持不变。根提交是提交点：一旦落盘，即使预览无法渲染或调用方在此期间取消，操作也会返回已创建的文档与提交——投影不再使用调用方的取消信号，预览失败会变成空预览并记录原因，重试也不会产生第二份文档。

`createFromTemplate()` 通过同一操作，从项目选用的模板按给定文档类型新建一份文档。它要求项目已选定模板且其中有对应该类型的格式，为项目安装该格式的契约（幂等）并予以确认——模板库中的格式随附已审阅的要求，因此新建不再被单独的审阅步骤拦住——然后在根提交中于里程碑之外绑定该格式。内容来源由格式的 usage 决定，而不是由调用方决定：内容表单从其规范化资产导入并成为文档本身，携带上传稿的请求会被拒绝；排版参考必须携带它要约束的论文稿上传，没有上传则拒绝。名称默认取该格式的显示名称。

`applyTemplate()` 经提交路径为某种文档类型绑定项目模板中的格式，类型不同时会在同一提交里追加一条 `set-document-type` 修改；重复绑定已绑定的格式会被拒绝。`detachTemplate()` 通过一次 `unbind-template` 提交解除已绑定的格式，文档保留其类型，此后自由写作。`suggestDocumentType()` 先根据文档标题、再根据开头几段猜测文档类型，并说明依据（`title`、`content`，或没有任何匹配时为 `current`）；它本身不做任何修改。

`diffVersion()` 通过文档引擎读取两份不可变快照，在段落级别解释一个版本相对其父版本的改动：相邻的删除与新增会配对为 `changed` 条目，根版本会把每一段都列为新增，`unchangedCount` 报告未改动的段落数。`open()`、`readNode()`、`commit()`、`validate()` 与 `restore()` 维护文档投影本身；`restore()` 会从较早的版本创建新版本，而不是把 head 向后移动。

`exportDocument()` 返回判别结果。草稿发布和通过检查的正式交付返回带输出及里程碑版本工作台状态的 `status: 'success'`。因模板错误受阻的正式交付返回带未变 revision 与可投影门禁报告的 `status: 'blocked'`，既不创建输出，也不创建导出里程碑；其他导出失败仍会拒绝请求。服务为每份文档最多保留一个门禁槽位。每次验证和导出都会记录来源 revision 与唯一所有权标识；revision 未变化时，只有最新标识可以发布结果。导出把来源推进到里程碑 revision 后，可以取代仍属于原来源 revision 的较晚标识，但从里程碑 revision 发起的门禁操作会阻止该导出结果进入缓存。提交、恢复或模板关联发布新 revision 后，其修改屏障只会替换仍锚定旧来源的标识；从已发布 revision 发起的门禁标识继续拥有缓存。成功导出的报告也只会在其里程碑仍为 head 时进入缓存。

## 模型体验

### 浏览器工作台状态

#### 模型看到的内容

`ctx.paperaiWorkbench` 提供浏览器投影，不向 Agent 请求增加提示词、工具 schema 或结果。Codex 与 Claude 通过 PaperAI MCP 分别访问同一组领域服务。

#### Token 影响

直接影响为零。项目概览、模板库列表、预览 HTML 与所选节点缓冲区保持为浏览器状态。

#### KV Cache 影响

工作台读写不组装模型请求，因此不会直接改变 Provider 缓存复用。

## 已知限制与延后工作

- 浏览器编辑仅支持纯文本，且一次只编辑一个块（语义节点）；更丰富的样式修改留给 OfficeCLI 与领域层扩展。
- 只投影被追踪的文档；项目目录中的其他文件既不会列出，也不由此 Remote 编辑。
- 文档类型猜测基于标题与开头文字中的关键词，是供用户或 Agent 确认的建议，而不是分类器。
