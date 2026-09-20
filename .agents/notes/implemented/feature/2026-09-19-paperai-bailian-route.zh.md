# Agent Note: PaperAI 声明阿里云百炼模型路由

Status: implemented

[English](2026-09-19-paperai-bailian-route.md) | 中文

## Problem

原生写作引擎（[原生引擎入名册决策](2026-09-17-paperai-native-engine-in-roster.zh.md)中的 `dsh` preset）跑在用户在"模型"页配置的模型路由上。对于阿里，随附的 pi-ai 目录只带两条千问 Token 计划路由（`qwen-token-plan` 指向 `token-plan.ap-southeast-1…`，`qwen-token-plan-cn` 指向 `token-plan.cn-beijing…`）。手持普通阿里云百炼（DashScope）key 的人——这是常见情形——会选名字最像的那条，贴上 key，然后每一轮都以 `AUTH` 失败：两个 Token 计划端点都回 `401 Invalid API-key provided`，而同一把 key 在 `dashscope.aliyuncs.com/compatible-mode/v1` 上回 `200`。页面上没有任何提示说明 key 属于哪个端点，而自定义 provider 卡片要填的端点、协议、模型和兼容开关，用户无从知晓。升级 pi-ai 也无济于事：0.85.1 仍没有普通 DashScope 路由。

## Decision

PaperAI 档案自己声明这条路由。`packages/bundle/paperai-web/cordis.patch.yml` 给 `llm-pi-ai` 行加上 `providers.bailian` 档案：`displayName: 阿里云百炼`、`apiKeyEnv: DASHSCOPE_API_KEY`、`api: openai-completions`、`baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1`，路由级兼容开关按 DashScope 的 OpenAI 兼容面配置（`thinkingFormat: qwen`、`supportsDeveloperRole: false`、`supportsStore: false`、`maxTokensField: max_tokens`），以及该端点 `/models` 列表确认提供的十一个模型（Qwen 3.7 Plus 与 Max、Qwen 3.6 Plus 与 Flash、DeepSeek V4 Pro 与 Flash、DeepSeek V3.2、GLM-5.2、Kimi K2.6 与 K2.7 Code、MiniMax-M2.5）。

**每个数字都取自阿里云自己的模型页面，而非 pi-ai 的目录。** pi-ai 在 `qwen-token-plan-cn` 路由上描述了同样的 id，但那是另一个端点，其容量并不通用；照搬的结果是五个错误的输出上限和两个错误的上下文长度。`enable_thinking` 是这个端点唯一的思考开关，因此没有任何模型携带自己的 `thinkingFormat`，也没有任何模型设置 `requiresReasoningContentOnAssistantMessages`；百炼用于回放思考内容的机制是 `preserve_thinking`，而其 DeepSeek 页面根本没有记载这个参数。

**`maxTokens` 是请求上限，不是容量标签。** 适配器会把配置值作为这条路由的 `max_tokens` 默认值发出，而百炼在思考模式下拒绝超过 32,768 的 `max_tokens`，该约束覆盖阿里云直供的 Qwen、GLM 与 Kimi 部署，而它们默认开启思考。因此这些行填的是 `min(文档输出长度, 32768)`，而不是模型的标称输出长度：四个 Qwen 行与 GLM-5.2 填 32,768，两个 Kimi 行填 16,384（其文档输出长度本就更低）。DeepSeek 与 MiniMax 不受该约束，填各自的真实上限：V4 两个为 393,216，V3.2 为 65,536。`kimi-k2.7-code` 与 `MiniMax-M2.5` 运行在仅思考模式，只提供 `high`；其余模型提供 `off` 与 `high`。

行配置是设置命名空间的基础层，所以这条路由会以"阿里云百炼"这个已声明 provider 出现在模型页目录里，key 在那里以 `DASHSCOPE_API_KEY` 录入，用户 `settings.yaml` 里自己的路由与之合并共存。无论是否存了 key，路由都会注册，这与 DSH 的每条路由一致；没有 key 的一轮以 `MISSING_CREDENTIAL` 失败。

## Alternatives considered

**交给自定义 provider 卡片。** 卡片能用，但要填端点、协议、模型 id、容量和兼容开关；而去点 `qwen-token-plan` 的人，正是因为一条有名字的路由看起来就是答案。一条名字对的路由才能消除猜测。

**等待或修补 pi-ai。** pi-ai 0.85.1 仍只带 Token 计划路由；在 vendored 目录里加条目每次升级都得重打，而 DSH 的档案机制正是为部署声明的路由而设。

**把 Token 计划路由的端点换成百炼。** 在 `qwen-token-plan-cn` 上覆盖 `baseURL` 能提供同样的模型，但名字仍然误导、凭据引用仍然错误，还会让真正持有 Token 计划 key 的人失去 pi-ai 随附的那条路由。

**改用 `max_completion_tokens` 并保留完整输出上限。** 阿里云推荐这个参数，并称 `max_tokens` 即将废弃，它也不受 32,768 的约束。但它把思维链与回复合并计量，与最大输出长度是两根不同的轴，且这里没有逐模型记载它的可用性。写作单轮不会需要 32,768 个输出 token，而一次 400 的代价大于损失的余量，因此保守字段保持不变，直到请求级检查能证明另一个可行。

## Consequences

百炼 key 通过一条有名字的路由一次就能用，且每个模型请求的输出长度都在端点接受范围内。`packages/bundle/paperai-web/tests/paperai-web.spec.ts` 通过适配器的 `Config` schema 固定每个模型各自的上下文长度、上限与可选等级，并用 `assertServiceable` 断言路由可服务；`tests/bailian-request.spec.ts` 把随包发布的这一行挂到本地服务器上，断言每个模型实际发出的内容——这是从其他端点照搬来的容量唯一无法通过的检查。模型清单仍靠人工维护：百炼新增的模型列入之前不会提供，下线的模型在移除之前会在请求时失败，而 `deepseek-v3.2` 在阿里云的下架名单上，日期为 2026-10-10。DashScope 国际站（`dashscope-intl`）不在覆盖范围内；来自那里的 key 仍需走自定义 provider 卡片。
