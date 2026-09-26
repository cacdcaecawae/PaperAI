# Agent Note: 隔离文档发布恢复并刷新发布字节

Status: implemented

[English](2026-09-26-paperai-publication-recovery-isolation.md) | 中文

## Problem

保留的发布记录可能遇到被外部编辑的 Working DOCX 或不可用的项目。服务初始化失败会使所有项目不可用。导入清理也可能删除未完成日志引用的文件和文档记录。仅原子发布文件并不能保证快照和 Working 字节在断电后保留。

## Decision

[提交服务](../../../../packages/paperai/commit-service/README.zh.md) 独立尝试每条启动恢复并记录失败，保留未完成日志，在受影响文档的 FIFO 入口重试恢复；其他文档仍可使用。[导入回滚](../../../../packages/paperai/document-service/README.zh.md) 拒绝删除存在保留发布日志的文档。

发布在链接快照或替换 Working DOCX 前刷新临时文件字节。支持的平台会同步包含文件的目录及新建快照目录的祖先。损坏的普通快照可以由调用方持有、且通过相同摘要校验的字节原子替换。未知 Working 字节、符号链接和非普通快照仍受保护，不会被自动替换。只读 Project Doctor 检查保留现有恢复策略。

## Alternatives considered

**让整个服务初始化失败。** 这能保护未知字节，却无谓地阻止其他文档的工作；按文档限制操作可提供同样的保护。

**删除未完成日志或导入。** 这会移除恢复失败发布所需的持久证据和文件。

**拒绝所有损坏的已有快照。** 发布已持有的校验通过字节可以修复同一内容地址，无需虚构历史内容。

## Consequences

针对性恢复测试保留一条无法恢复的日志，同时恢复并提交另一文档，验证导入回滚保留待发布数据，并覆盖快照修复及发布刷新顺序。Windows 会刷新文件字节，但 Node 不支持该平台的目录 fsync。未知发布状态仍须修复，该文档才能接受新操作。
