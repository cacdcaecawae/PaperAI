# Agent Note: ACP 模型、推理强度与 fast 模式选择

Status: implemented

[English](2026-09-02-acp-model-effort-switch-selection.md) | 中文

## Problem

PaperAI 的 Codex 与 Claude 引擎经固定版本的 ACP 适配器运行，两者都通告三个会话选择器：`model` 下拉、`thought_level` 下拉（推理强度）和一个布尔型 fast 模式选项（Codex 为 `fast-mode`、Claude 为 `fast`，均属 `model_config`）。DSH 的 `AgentModelController` 缝只承载模型，因此输入框的模型菜单只显示 ACP 模型，没有推理等级也没有 fast 模式，`session.selectModel` 对驱动方拥有的会话更是直接拒绝任何推理强度。使用外部引擎的用户完全无法在 PaperAI 里选择推理强度或 fast 模式。

## Decision

**一条可叠加的驱动方缝。**`@deepseek-ai/dsh-agent` 为 `AgentDriverModel` 增加可选的 `reasoning`（驱动方拥有的等级列表以及驱动方默认应用的等级），为 `AgentModelController` 增加可选的 `currentReasoningEffort`、`switches`（带驱动方自己名称与说明的布尔开关）以及 `selectModel(model, { reasoningEffort?, switches? })` 的第二个参数。什么都不通告的驱动保持原契约；DSH Agent Loop 仍走 `ctx.llm`，不暴露其中任何一项。

**Host 只转发，驱动方负责校验。**`session.models` 把驱动方的等级投影进既有的精确模型 `reasoning` 元数据，把开关列为 `SessionModels.switches`；上报的 `current` 选择携带已应用的等级与每个开关的值。`session.selectModel` 在推理强度之外接受可选的 `switches`，一并交给驱动方，并回显驱动方得到的选择结果。Host 不再拒绝驱动会话的推理强度：驱动方拒绝它未通告的等级或开关，表现为菜单已本地化的同一种 `model-unavailable` 失败。

**ACP 按提供方顺序、原子地应用选项。**`@paperai/agent-acp` 解析 `thought_level` 下拉（回退到 `effort` / `reasoning_effort` id）与所有布尔选项进入模型状态，把当前等级列表附到每个通告的模型上，并按"先模型、再等级、后开关"的顺序应用一次选择——每一步都经 `session/set_config_option`，已生效的值跳过，因此重复提交同一选择不会向提供方发送任何请求。当前通告能回答的校验都在第一次提供方调用之前完成；切换模型后会针对重新通告再校验一次等级；若某一步在前面步骤已生效后被提供方拒绝，则把会话驱动回事务开始前记录的那份选择——不只是显式步骤，因为切换模型会自行重新通告等级——按依赖顺序：先开关、再模型、然后是原模型的等级、最后是模型切换自行改变的开关，即使某一步恢复失败也会把剩余各步都试完。`AcpSelectionError` 说明会话是否已回到先前的选择；没有回到时，Agent 把 runtime 标记为待重建，下一次操作会在新进程中恢复提供方会话并记录它实际应用的选择。事务期间的提供方配置通知只更新 runtime 内部状态，观察者只在事务结束时听到一次变化。布尔选项走 SDK 的布尔请求形态，客户端能力声明里早已包含它。

**已应用的选择进入日志。**Model-visible ⟺ logged：已应用选择的每次变化都追加一条 `paperai/acp/config` 事件（提供方、模型、等级、开关值；每次变化只记一次，启动时延后到 DSH Session 就绪后写入），每一回合的 `request/header` 也在模型旁记录等级，因此驱动会话的一次模型调用无需提供方自身状态即可从 DSH 日志重建、审计与 fork。

**菜单把驱动方开关渲染为可勾选行。**输入框模型菜单保留模型 / 推理等级两行，并按驱动方开关逐个追加 `menuitemcheckbox` 行，标签与说明取自驱动方自己的文案；翻转一次会把当前模型与等级连同这一个改变的开关一起提交，被接受的选择就地更新该行，已开启的开关会跟在等级之后进入触发按钮的说明文字。走 LLM 路由的会话永远收不到开关，其菜单不变。

## Alternatives considered

**单独的 `session.setModelSwitch` RPC。**否决：菜单本来就通过一次调用提交完整选择，为一个布尔值再加一条 RPC 需要各自的 schema、客户端、handler 与文档；把 `switches` 放在 `ModelSelection` 上让选择仍是一个事实。

**把 fast 模式建模为额外的推理等级。**否决：fast 模式是与推理强度正交的服务档位，两个适配器都把它作为独立选项暴露；折进等级列表会误报已应用的推理强度。

**由 Host 依据目录校验推理强度。**否决：目录按设计只是建议，适配器会按模型重新通告等级，只有驱动方知道当前模型接受什么。

## Testing

`catalog.spec.ts` 钉住 `thought_level` 与布尔解析；ACP 集成测试经假适配器驱动推理强度与 fast 模式，断言精确的 `session/set_config_option` 序列、拒绝路径、重复提交零请求、`paperai/acp/config` 事件与 `request/header` 里的等级，以及提供方拒绝后续步骤时的逆序恢复；`api-proxy-models.spec.ts` 覆盖投影、转发与驱动方拒绝路径；`model-select.client.spec.tsx` 覆盖开关行、提交的选择、说明文字与拒绝提示；`apps/web/tests/paperai-permissions.e2e.ts` 对装配后的菜单做快照，并对假 Codex 适配器应用推理强度与 fast 模式。

## Consequences

等级按会话而非按模型通告，因此在提供方于切换后重新通告之前，菜单里每个模型显示的都是当前模型的等级；菜单每次打开都会重新加载，新列表在那时出现。开关值在 `LlmCallConfig` 里没有对应字段，所以只通过 `paperai/acp/config` 事件持久化，这是 PaperAI 自己的日志词汇而非核心请求头字段。提供方若连恢复步骤也拒绝，会话会停在中间状态直到重建：失败的选择返回 `restored: false`，半应用状态不会写入日志，新进程重新通告后日志追上提供方的真实选择。上游补丁集又多一条可叠加缝（`AgentModelController` 上的驱动方等级与开关、`ModelSelection` 与 `SessionModels` 上的 `switches`），后续合并 DSH 时必须保留。
