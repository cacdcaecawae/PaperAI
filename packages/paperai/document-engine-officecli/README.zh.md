# `@paperai/document-engine-officecli`

[English](README.md) | 中文

`ctx.documentEngine` 的 OfficeCLI Service Provider。带 runs 的 `replace-text` 会重建该段落——先设置段落文字，再声明第一个 run 的覆盖，然后依次追加其余 run——并作为一次 `batch` 调用发出，而不是每个操作一次进程往返；纯文本仍是单条 `set`。它解析固定版本 `@officecli/officecli` launcher（或显式命令），通过 DSH `ctx.subprocess` 运行所有进程，限制执行时间和捕获输出，关闭 OfficeCLI 自动更新，并让 OfficeCLI 为每条命令启动的常驻文档进程在 lease 之间继续存活，同一文件的连续操作因此免去冷启动。常驻进程在 `residentIdleMs` 无操作后关闭，在 `release(filePath)` 时立即关闭（提交服务在替换或删除文件前调用它），Provider 销毁时也会关闭。关闭清理使用独立 signal 和单独的短超时，因此调用方取消操作也不会跳过清理。

段落替换写入前检查 OfficeCLI 投影和常驻文档的原始 XML。识别命名空间的 XML 解析保护分页符、分栏符、域、符号、绘图、公式及其他未投影的段内内容。未支持的字符属性也会阻止替换，包括上下标、删除线、隐藏文字及字符样式引用。支持普通文字、制表符和软换行。`paragraphs` 修改先编辑原段，再紧接着插入其余段落，并使用每次插入返回的 Office 路径。新段继承受支持的段落格式和字符默认值，包括字体、字号；显式字符覆盖优先。段落格式可以覆盖样式、对齐、缩进和行距。仅修改段落格式时保留未变的文字和字符片段。OfficeCLI 保存时可能规范化 XML 序列化和段落 id，因此保留的是文档语义内容，不承诺 ZIP 条目字节完全一致。

字符片段替换也会拒绝不同文字系统各自的字体或字号、复杂文字系统独立的粗体或斜体、关联主题的字体和颜色，以及单线或无下划线以外的下划线细节。这些值超出了可编辑字符字段的表达范围，替换文字可能改变作者未选择修改的格式。

文档协议用垂直制表符表示软换行。段落 setter 创建首个 run 的换行，后续 setter 只应用格式，不重复写入其文字。追加 run 时将软换行编码为换行符交给 OfficeCLI，由它写成 Word 换行元素。

每次调用均设置固定版本二进制识别的更新检查禁用选项 `OFFICECLI_SKIP_UPDATE=1`，使文档操作独立于后台二进制替换和已安装技能的刷新。

同一路径文件的全部读写共用 FIFO lease。一个修改批次应用全部 Office path 操作，只保存一次，并在返回前释放 OfficeCLI 文档句柄。失败通过 `OfficeCliError` 保留 stdout/stderr，同时不向领域消费方暴露通用命令 runner。

`normalizeLegacyDocument()` 提供 `@paperai/document-service` 按结构检测的可选旧版文档规范化能力。在 Windows 上，它通过 `ctx.subprocess` 直接启动配置的 PowerShell 可执行文件，并运行包内 Word COM 程序，不经过命令 shell。Microsoft Word 以只读方式打开源 `.doc`，再写入独立 DOCX；源文件不会被保存或替换。非 Windows 主机、禁用或无法解析的 PowerShell 命令以及不可用的 Word COM 都返回明确的 degraded 结果。

转换器在 Windows 上默认使用 `powershell.exe`。`legacyDocPowerShellCommand` 可指定其他可执行文件名称或绝对路径，也可设为 `false` 或空字符串以禁用 `.doc` 规范化。`legacyDocTimeoutMs` 默认 120000，`legacyDocOutputMaxBytes` 默认每个流 1048576，`legacyDocTerminateGraceMs` 默认 5000；三个限制都必须是正安全整数。

`cleanupTimeoutMs` 默认为 5000，且必须是正安全整数。每次独立尽力 `close` 命令受该值约束。`residentIdleMs` 默认为 2000，且必须是正安全整数：最后一次操作之后常驻文档保持多久空闲再关闭。文档常驻期间，其他程序可以读取并就地写入该文件，但不能重命名、替换或删除它，因此这个窗口保持很短，引擎在自己替换或删除文件前也会先释放。

取消、超时、输出截断、非零转换失败以及缺失或无效的 DOCX 输出会抛出带稳定 `code` 的 `LegacyDocConversionError`。每次未成功的转换尝试都会删除生成的目标；已存在的目标会在进程启动前被拒绝且不会被覆盖。若清理失败，错误会同时保留主要转换失败和清理失败。

## 模型体验

### OfficeCLI 操作结果

#### 模型看到的内容

Provider 自身不增加模型上下文。消费方可以投影 `readTextNodes`、结构化检查、验证或修改失败的结果，并负责过滤与渲染。

#### Token 影响

直接影响为零。捕获的 OfficeCLI 输出只作为 Provider 诊断信息，除非消费方明确把有界结果或错误放入模型可见内容。

#### KV Cache 影响

Provider 不发起模型请求。只有消费方在后续请求中发送变化后的文档事实时，Working DOCX 的变化才会影响缓存复用。

## 已知限制与暂缓事项

- 首个 Provider 只支持本地进程；远程 OfficeCLI 执行应实现为另一个 Provider。
- lease key 是调用方提供的路径。文档服务必须先规范化 Working DOCX 路径，避免路径别名形成并行队列。
- 预览输出超过配置上限时会明确失败，而不是返回截断 HTML。
- 旧版 `.doc` 规范化要求桌面 Microsoft Word 已为配置的进程身份注册；LibreOffice 和服务端 Word 转换不是回退路径。
