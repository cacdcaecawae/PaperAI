# Agent Note: Host 替换后恢复已展示 Session 的交互

Status: implemented

[English](2026-09-03-session-replacement-reactivation.md) | 中文

## 问题

空会话切换到另一种 Agent 驱动时，Host 会移除旧 Agent，再以同一 Session id 添加替代实例。客户端保留已展示的 Session 实例，其移除标记会禁用输入框和模型选择器。若只更新替代实例的摘要，启动成功后这些控件仍然不可用。移除还丢弃了 manager 的投影 store，而可见的 Session 仍保留旧 store，权限更新因而无法再传递给它的观察者。

## 决策

权威的 `host/session-added` 帧清除已有 Session 实例的移除标记，并应用新 Session 的空会话状态。`host/session-removed` 再次禁用交互。列表基线可以更新摘要，但不能清除移除标记，因为较早的响应可能晚于移除帧到达。

移除时在常驻 store 内清除投影值和序号水位，不替换 store。被订阅的读取接口继续连接接收替代实例帧的 manager；从未实例化的会话可以释放其 store。仅替换 store 会让已展示的 Session 继续读取过期的权限等投影值。

[会话作用域决策](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)继续约束展示和作用域拆卸。恢复交互时保留已展示的实例，不为重置一个标记而丢弃其本地状态。

## 曾考虑的替代方案

**每次刷新摘要都清除移除标记。** 延迟的基线响应可能在替代实例出现之前，就让已移除的 Agent 显示为可交互。

**模型选择器忽略移除状态。** 输入框和其他控件仍会被禁用，真正被移除的会话则会获得可操作的模型菜单。

**替换客户端 Session 对象。** 已展示的视图仍持有该实例；为清除可用状态而更换身份会干扰观察者和本地状态。

## 后果

Host 发布替代实例后，控件恢复可用；切换失败后恢复的 Agent 也遵循此规则。单元回归区分过期列表基线和添加帧。组装后的 PaperAI 浏览器场景反复切换 Claude 与 Codex，每次切换后选择模型，记录最终模型菜单快照，并通过替代 Agent 验证权限切换。
