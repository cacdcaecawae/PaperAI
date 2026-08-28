# `@paperai/template-pack-hit`

[English](README.md) | 中文

面向 `ctx.paperTemplates` 的内置“HIT 硕士毕设”贡献。本包包含固定 manifest 和本产品收到的学校原始文件：开题报告、中期报告与理工类学位论文书写范例。

每个成员都保留原始 `.doc`、供 OfficeCLI 检查的只读规范化 DOCX、字节数、SHA-256、原始文件名、来源快照版本、兼容的 `DocumentRole` 和用途。开题与中期成员属于 `form-template`；论文书写范例属于 `format-reference`，因此关联时不会复制示例研究正文。

本包的 MIT 声明仅覆盖 PaperAI 代码；学校 Word 文件仍是受其发布方条款约束的参考材料，详见 [`ASSET_NOTICE.md`](ASSET_NOTICE.md)。

插件通过 Cordis effect 注册模板包，并在插件 fiber 释放时移除。安装过程按照 `assets/manifest.json` 校验所有资产；最初提供这些文件的目录不是运行时依赖。

## 模型体验

### HIT 模板元数据

#### 模型看到的内容

注册 `HIT_TEMPLATE_PACK` 不增加提示词或工具结果。只有命令、UI 桥接或 MCP 工具请求模板服务投影时，Agent 才会看到成员名称或编译后的要求。

#### Token 影响

注册时的直接影响为零。渲染所选元数据或编译后约定的消费方负责随数据变化的结果 token。

#### KV Cache 影响

模板包注册不会改变模型请求。只有消费方把所选模板的元数据或要求放入后续上下文时，模板选择才会影响缓存复用。

## 已知限制与延后工作

- 源文件没有权威发布版本标识，因此本包将来源记录为用户提供的 2026-08-28 快照。
- 论文书写范例是理工类格式参考；其他 HIT 学科需要增加并审阅独立成员后，才能获得同等交付覆盖。
