# `@paperai/document-engine-officecli`

[English](README.md) | 中文

`ctx.documentEngine` 的 OfficeCLI Service Provider。它解析固定版本 `@officecli/officecli` launcher（或显式命令），通过 DSH `ctx.subprocess` 运行所有进程，限制执行时间和捕获输出，关闭 OfficeCLI 自动更新，并在每个 lease 后关闭常驻文档句柄。关闭清理使用独立 signal 和单独的短超时，因此调用方取消操作也不会跳过清理。

同一路径文件的全部读写共用 FIFO lease。一个修改批次应用全部 Office path 操作，只保存一次，并在返回前释放 OfficeCLI 文档句柄。失败通过 `OfficeCliError` 保留 stdout/stderr，同时不向领域消费方暴露通用命令 runner。

`normalizeLegacyDocument()` 提供 `@paperai/document-service` 按结构检测的可选旧版文档规范化能力。在 Windows 上，它通过 `ctx.subprocess` 直接启动配置的 PowerShell 可执行文件，并运行包内 Word COM 程序，不经过命令 shell。Microsoft Word 以只读方式打开源 `.doc`，再写入独立 DOCX；源文件不会被保存或替换。非 Windows 主机、禁用或无法解析的 PowerShell 命令以及不可用的 Word COM 都返回明确的 degraded 结果。

转换器在 Windows 上默认使用 `powershell.exe`。`legacyDocPowerShellCommand` 可指定其他可执行文件名称或绝对路径，也可设为 `false` 或空字符串以禁用 `.doc` 规范化。`legacyDocTimeoutMs` 默认 120000，`legacyDocOutputMaxBytes` 默认每个流 1048576，`legacyDocTerminateGraceMs` 默认 5000；三个限制都必须是正安全整数。

`cleanupTimeoutMs` 默认为 5000，且必须是正安全整数。读取、检查、修改、预览和验证结束后的独立尽力 `close` 命令受该值约束，调用方取消原操作时也一样。

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
