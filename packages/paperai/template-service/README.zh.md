# `@paperai/template-service`

[English](README.md) | 中文

`ctx.paperTemplates` 负责 PaperAI 模板包、不可变 Word 导入、OfficeCLI 合同解析、人工确认、角色安全关联和交付检查。服务将原始字节与检查所用 DOCX 分开保存，因此不会修改内置模板或用户上传模板。

## 配置

- `storageRoot` 是必填的绝对路径，用于保存内容寻址资产。
- `maxUploadBytes` 限制每个源文件和规范化资产，默认 128 MiB。
- `converterTimeoutMs`、`converterOutputMaxBytes` 和 `converterTerminateGraceMs` 限制旧版 `.doc` 转换。
- `wordComPowerShellCommand` 选择执行 Word COM 转换的 Windows PowerShell。Windows 默认使用 `powershell.exe`；设置为空字符串会明确拒绝自定义 `.doc` 上传。内置模板包自带规范化 DOCX，运行时不依赖 Word。

## 语义

模板包插件通过 Cordis effect 调用 `registerPack()`。`listPacks()` 只返回不含主机资产路径的摘要；`installPack()` 在复制前校验 manifest 的文件大小和 SHA-256，再把原始文件和规范化文件写入不可变的内容寻址路径。项目、模板包、成员、版本和源哈希共同形成确定性身份，因此重复安装幂等。

`upload()` 接受 `.docx` 和 `.doc`。服务先复制用户选择的文件再检查；旧版 `.doc` 以只读方式交给 Word COM 打开，并另存独立 DOCX。解析器读取完整文本节点并执行一次 `/body` 检查，生成带来源证据、字段、槽位、固定文字、必需章节、字体、字号、段落间距、页面设置和受支持定量规则的草稿 `TemplateContract`。只有调用 `confirm()` 才会转为 `confirmed`。

`validateAssociation()` 拒绝草稿、跨项目以及不兼容 `DocumentRole` 的绑定。实际 `bind-template` 发布只由 `paperCommits` 完成，因此每次关联都有可恢复版本与操作者来源。关联 `format-reference` 不复制参考模板正文。

`check()` 读取当前 Working DOCX，检查确认状态、角色、必填字段、固定文字、章节、受支持的样式与页面规则、最低字数、参考文献、占位符、表格和 Office 结构。草稿导出可以保留失败报告；`delivery-export` 中的 error 通过 `deliveryBlocked()` 阻止正式交付。未关联模板的文档以无模板自由模式检查：报告直接通过且没有任何发现，草稿与正式交付导出均不受模板检查约束。

服务先发布仅作证据的模板源与解析节点，最后写入合同记录；模板源不会进入普通 Working 文档列表。因此解析失败的模板不会出现在列表中，确定性重试可以补全尚未发布的记录。

## 模型体验

### 模板约定与门禁报告

#### 模型看到的内容

`ctx.paperTemplates` 不增加提示词、工具 schema 或结果。命令、MCP 工具与 UI 桥接决定向 Agent 展示哪些约定字段和门禁 finding。

#### Token 影响

直接影响为零。渲染约定或报告的消费方负责随数据变化的 token 数量和输出上限。

#### KV Cache 影响

模板解析与检查不发送模型请求。只有消费方把约定或 finding 投影到后续上下文中，它们才会影响缓存复用。

## 已知限制与延后工作

- 旧版 `.doc` 上传需要 Windows 上安装 Microsoft Word；没有 Word 的部署仍可使用 `.docx` 和已规范化的内置模板包。
- 第一版交付检查比较语义文本和 OfficeCLI 格式属性，尚未执行逐页图像视觉回归。
- 模板草稿编辑由仓储所有者持久化；本包目前提供解析、审阅读取和确认转换，尚未提供字段级草稿补丁 API。
