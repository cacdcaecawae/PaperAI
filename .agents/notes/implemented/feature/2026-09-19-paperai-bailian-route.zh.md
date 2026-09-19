# Agent Note: PaperAI 声明阿里云百炼模型路由

Status: implemented

[English](2026-09-19-paperai-bailian-route.md) | 中文

## Problem

原生写作引擎（[原生引擎入名册决策](2026-09-17-paperai-native-engine-in-roster.zh.md)中的 `dsh` preset）跑在用户在"模型"页配置的模型路由上。对于阿里，随附的 pi-ai 目录只带两条千问 Token 计划路由（`qwen-token-plan` 指向 `token-plan.ap-southeast-1…`，`qwen-token-plan-cn` 指向 `token-plan.cn-beijing…`）。手持普通阿里云百炼（DashScope）key 的人——这是常见情形——会选名字最像的那条，贴上 key，然后每一轮都以 `AUTH` 失败：两个 Token 计划端点都回 `401 Invalid API-key provided`，而同一把 key 在 `dashscope.aliyuncs.com/compatible-mode/v1` 上回 `200`。页面上没有任何提示说明 key 属于哪个端点，而自定义 provider 卡片要填的端点、协议、模型和兼容开关，用户无从知晓。升级 pi-ai 也无济于事：0.85.1 仍没有普通 DashScope 路由。

## Decision

PaperAI 档案自己声明这条路由。`packages/bundle/paperai-web/cordis.patch.yml` 给 `llm-pi-ai` 行加上 `providers.bailian` 档案：`displayName: 阿里云百炼`、`apiKeyEnv: DASHSCOPE_API_KEY`、`api: openai-completions`、`baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1`，路由级兼容开关按 DashScope 的 OpenAI 兼容面配置（`thinkingFormat: qwen`、`supportsDeveloperRole: false`、`supportsStore: false`、`maxTokensField: max_tokens`），以及该端点 `/models` 列表确认提供的十一个模型（Qwen 3.7 Plus 与 Max、Qwen 3.6 Plus 与 Flash、DeepSeek V4 Pro 与 Flash、DeepSeek V3.2、GLM-5.2、Kimi K2.6 与 K2.7 Code、MiniMax-M2.5），每个模型的容量与模态取自 pi-ai 在 `qwen-token-plan-cn` 路由上为同一 id 记录的值，并带 `reasoningEfforts: { off: null, high: high }`，pi-ai 的 Qwen 格式会把它发成 `enable_thinking`。两个 DeepSeek V4 模型保留各自的 `thinkingFormat: deepseek` 与 `requiresReasoningContentOnAssistantMessages`。

行配置是设置命名空间的基础层，所以这条路由会以"阿里云百炼"这个已声明 provider 出现在模型页目录里，key 在那里以 `DASHSCOPE_API_KEY` 录入，用户 `settings.yaml` 里自己的路由与之合并共存。无论是否存了 key，路由都会注册，这与 DSH 的每条路由一致；没有 key 的一轮以 `MISSING_CREDENTIAL` 失败。

## Alternatives considered

**交给自定义 provider 卡片。** 卡片能用，但要填端点、协议、模型 id、容量和兼容开关；而去点 `qwen-token-plan` 的人，正是因为一条有名字的路由看起来就是答案。一条名字对的路由才能消除猜测。

**等待或修补 pi-ai。** pi-ai 0.85.1 仍只带 Token 计划路由；在 vendored 目录里加条目每次升级都得重打，而 DSH 的档案机制正是为部署声明的路由而设。

**把 Token 计划路由的端点换成百炼。** 在 `qwen-token-plan-cn` 上覆盖 `baseURL` 能提供同样的模型，但名字仍然误导、凭据引用仍然错误，还会让真正持有 Token 计划 key 的人失去 pi-ai 随附的那条路由。

## Consequences

百炼 key 通过一条有名字的路由一次就能用。`packages/bundle/paperai-web/tests/paperai-web.spec.ts` 用适配器自己的 `Config` schema 解析这一行，并固定端点、协议、凭据引用、兼容开关和模型清单。模型清单靠人工维护：百炼新增的模型列入之前不会提供，下线的模型在移除之前会在请求时失败。DashScope 国际站（`dashscope-intl`）不在覆盖范围内；来自那里的 key 仍需走自定义 provider 卡片。
