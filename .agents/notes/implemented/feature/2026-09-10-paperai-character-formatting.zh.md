# Agent Note: 从页面把字符格式写进 DOCX

Status: implemented

[English](2026-09-10-paperai-character-formatting.md) | 中文

部分取代：[写作流程决策](2026-09-12-paperai-writing-workflow.zh.md)拥有常驻工具栏和结构草稿；[Word 编辑保留决策](../bug-fix/2026-09-13-paperai-word-edit-preservation.zh.md)拥有引擎写入、原 run 元数据和显式清除。本记录的浏览器解析格式与传输校验继续有效。

## 问题

纯文本段落 setter 会替换原 run，因此改一个错字也可能清除加粗开头或红色短语。字符格式需要随浏览器编辑一起传递，并允许在段落内部修改。

## 决策

`replace-text` 接受可选的 `runs`：把块的文字按字符格式的变化切分，携带显式的 `bold`、`italic`、`underline`、`font`、以磅为单位的 `size` 及 `color` 值。这些字段经过 domain 的 `DocumentTextRun`、引擎 API 的 `EngineTextRun` 和工作台传输的 `PaperAIDocumentTextRun`，因为这些层各自声明变更类型。带 runs 时，文字未变的提交也被接受，于是单独的排版也是一个版本，其消息读作"排版"而非"修改"。runs 的文字拼接必须与变更的 `nextText` 完全一致，由提交服务校验。

纯文本与带格式编辑共用 [Word 编辑保留决策](../bug-fix/2026-09-13-paperai-word-edit-preservation.zh.md)拥有的 XML 保留路径。

浏览器从 Host 渲染的 run span 读取解析后的样式。`runsOf` 遍历块内的文本节点，合并格式相同的相邻部分；没有覆盖的块序列化为一个 run，按纯文本提交。选中的文字通过包一层声明该变化的 span 来格式化，并清除其内部的同名声明，使解析值反映此次编辑。编辑器拦截粘贴并只插入文字。常驻工具栏与 Ctrl/Cmd+B、I、U 应用字符格式。

选中文字上方的声明无法仅从内部关闭：文本装饰不继承，却会绘制到后代上。修改会清除块与选区之间的该声明，并保留两侧文字的格式。浏览器按块自身的解析值，在每个受影响 run 上显式重述被清除的属性，避免保留的源元数据重新带回已取消的覆盖。

## 考虑过的替代方案

**只提供段落级强调。** 向全部 run 应用同一个值，无法表达句中的加粗短语。字符 run 保留写作者选择的范围。

**只发送动过的 run，按原始序号寻址。** span 拆分与合并会使这些序号失效。附着于段落的草稿使传输层不依赖 Word run 的位置；引擎中的字符映射由 Word 编辑保留决策拥有。

**用内联样式而非解析样式读取 run。** Host 的样式表也会按规则设置字符属性（页眉页脚、目录链接），只读内联会误判。这里用解析样式没有代价：页面的缩放不会缩放报告出的字号，磅值可以直接由像素换算。

**`document.execCommand`。** 它已废弃的编辑行为在 shadow 树内无法可靠保留编辑器的区间与格式规则。显式修改 span 使这些规则由编辑器控制。

## 测试

单元测试覆盖 run 解析值、跨 run 显式清除、草稿比较、传输校验和仅排版提交。浏览器场景应用及清除字符格式、保存并检查刷新后的预览。原生元数据与命令数量验证由 [Word 编辑保留测试](../bug-fix/2026-09-13-paperai-word-edit-preservation.zh.md#word-edit-tests)拥有。

## 后果

显式 run 字号以磅保存，因此会覆盖后续模板默认值。未建模的 Word 元数据和插入文字继承遵循 [Word 编辑保留决策](../bug-fix/2026-09-13-paperai-word-edit-preservation.zh.md)。新增 Remote 字段必须重新构建 typert 描述符：生成的客户端 schema 会省略未声明字段，使仅排版请求成为被拒绝的无操作。
