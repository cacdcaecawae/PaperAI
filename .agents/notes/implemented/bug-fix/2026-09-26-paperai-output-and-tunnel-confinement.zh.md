# Agent Note: PaperAI 输出与隧道范围约束

Status: implemented

[English](2026-09-26-paperai-output-and-tunnel-confinement.md) | 中文

## Problem

项目工作区包含不可变导入源、Working DOCX 文件、模板和历史快照。允许导出到工作区内任意位置，会使合法的导出请求替换另一文档的权威字节。指向共享 Host Web 端口的 SSH 反向隧道还会暴露其他路由，这些路由的回环信任检查无法区分本地调用方和远程流量。

## Decision

导出提供方解析文档所属项目，并将所有调用方限制在其 `exports/` 目录内。目标的真实父目录在里程碑提交前和发布前都必须位于该目录内；exports 根目录本身也不能重定向到别处。该规则同样适用于完全访问会话。可选的 writable root 仍作为附加限制。

SSH ACP（Agent Client Protocol）运行时拥有专用回环代理。只有描述符中精确的 MCP URL 路径和 Bearer 凭据才能到达本地 HTTP 端点。SSH 隧道转发代理端口；无关的 Host 路由不会到达上游服务。运行时释放会关闭代理及其活动连接。这实现了 [ACP 渠道](../architecture/2026-09-08-paperai-acp-channels.zh.md)所承诺的远程会话隔离，该记录的会话和提供方决策仍然有效。

## Alternatives considered

**只保护枚举出的文档文件。** 这会漏掉其他文档、旧快照和将来新增的受管理文件。专用输出目录无需不断增加拒绝列表即可保护这些文件。

**转发共享 Web 端口，只在 MCP 上验证身份。** 发往其他路由的请求会绕过 MCP 处理器。隧道必须终止于只接受预期端点的 HTTP 监听器。

## Consequences

任意路径导出会被拒绝；用户可以在导出完成后移动文件。导出区域内的目录链接只有在真实目标仍位于区域内时才能使用。每个远程运行时多拥有一个监听器，释放时会等待其关闭。提供方和应用组装测试验证导出被拒后，其他文档的源文件、Working DOCX 和快照字节保持不变；HTTP 测试验证路由过滤、凭据隔离、允许的 MCP 流量及监听器释放。
