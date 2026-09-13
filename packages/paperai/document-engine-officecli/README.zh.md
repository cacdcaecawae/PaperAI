# `@paperai/document-engine-officecli`

[English](README.md) | 中文

`ctx.documentEngine` 的 OfficeCLI Service Provider。每个修改批次只读取并解析一次 `/document`，将全部原始 Office 路径绑定到对应 XML 节点，再按调用方顺序修改。插入、拆段和删除不会改变后续原节点引用的目标，无 `paraId` 的文档也适用。引用已在本批次删除的节点会在写入前拒绝修改。显式修改段落样式时，额外读取一次 `/styles` 以解析样式名和 id。

`readParagraphStyles()` 与样式修改共用文件 lease 和 `/styles` 解析器。仅返回已定义的段落样式，缺少显示名称时使用存储 ID，样式部件缺失时返回空目录。精确 ID 优先于同名样式，未知样式在写入前拒绝。

文字差异保留每个存留字符的原 run 属性。插入文字继承相邻 run，替换文字继承被替换范围的首个 run；空段保留字符默认值。显式字符值覆盖受支持字段，省略值保留原属性。东亚字体提示、各文字体系字体、字距调整、字符间距和其他未建模 run 属性在编辑后保留。显式字体或字号与原显示值相同时，保留不同文字体系的细节。浏览器客户端在每个受影响 run 上显式重述被清除的字段。

书签、校对标记、手动或渲染分页符保留相对编辑文字的位置。拆分后的段落继承段落属性，分节边界保留在最后一个替换段落。段落格式可以覆盖现有样式、对齐、缩进和行距。域、符号、绘图、公式及其他不支持的段内对象会拒绝文字替换；未修改段落和其他文档部分保留在候选文件中。OfficeCLI 保存时可能规范化 XML 序列化和段落 id，因此按文档语义检查保留情况，不承诺 ZIP 字节完全一致。

纯文本和带格式的编辑共用一次对 `/word/document.xml` 执行 `raw-set` 的 `batch --input` 调用，随后执行 `save`。Provider 要求批次汇总与单项结果确认全部成功，即使进程退出码为零，也会拒绝失败、跳过或缺失的操作。私有命令文件承载修改后的正文，避免正文出现在进程参数中或撞上 Windows 命令行长度限制，并在成功或失败后删除。解析后的 XML 只存在于文件 lease 内；Working DOCX 与提交服务的候选文件及版本事务仍是权威来源。垂直制表符表示软换行，非结构化替换中的换行符创建段落。

每次调用均设置固定版本二进制识别的更新检查禁用选项 `OFFICECLI_SKIP_UPDATE=1`，使文档操作独立于后台二进制替换和已安装技能的刷新。

同一路径文件的全部读写共用 FIFO lease。Provider 解析固定版本的 npm launcher 或显式可执行文件，通过 DSH `ctx.subprocess` 运行，并限制时间和捕获输出。常驻文档在 lease 之间保持打开，直到 `residentIdleMs`、显式 `release(filePath)` 或销毁。提交发布在替换文件前释放它。关闭清理使用独立 signal 和超时。原生命令失败通过 `OfficeCliError` 保留 stdout/stderr，不向消费方暴露通用命令 runner。

`normalizeLegacyDocument()` 提供 `@paperai/document-service` 按结构检测的可选旧版文档规范化能力。在 Windows 上，它通过 `ctx.subprocess` 直接启动配置的 PowerShell 可执行文件，并运行包内 Word COM 程序，不经过命令 shell。Microsoft Word 以只读方式打开源 `.doc`，再写入独立 DOCX；源文件不会被保存或替换。非 Windows 主机、禁用或无法解析的 PowerShell 命令以及不可用的 Word COM 都返回明确的 degraded 结果。

转换器在 Windows 上默认使用 `powershell.exe`。`legacyDocPowerShellCommand` 可指定其他可执行文件名称或绝对路径，也可设为 `false` 或空字符串以禁用 `.doc` 规范化。`legacyDocTimeoutMs` 默认 120000，`legacyDocOutputMaxBytes` 默认每个流 1048576，`legacyDocTerminateGraceMs` 默认 5000；三个限制都必须是正安全整数。

`cleanupTimeoutMs` 默认为 5000，且必须是正安全整数。每次独立尽力 `close` 命令受该值约束。`residentIdleMs` 默认为 2000，且必须是正安全整数：最后一次操作之后常驻文档保持多久空闲再关闭。文档常驻期间，其他程序可以读取并就地写入该文件，但不能重命名、替换或删除它，因此这个窗口保持很短，引擎在自己替换或删除文件前也会先释放。

取消、超时、输出截断、非零转换失败以及缺失或无效的 DOCX 输出会抛出带稳定 `code` 的 `LegacyDocConversionError`。每次未成功的转换尝试都会删除生成的目标；已存在的目标会在进程启动前被拒绝且不会被覆盖。若清理失败，错误会同时保留主要转换失败和清理失败。

## 验证

原生回归测试在 Windows CI 中通过 `DSH_PAPERAI_OFFICECLI_REAL=1` 启用，并要求固定的二进制版本。`DSH_PAPERAI_OFFICECLI_COMMAND` 可选择隔离的可执行文件供本地验证；npm 包版本本身不能证明已安装二进制的版本。

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
