# Agent Note: PaperAI declares the Alibaba Bailian model route

Status: implemented

English | [中文](2026-09-19-paperai-bailian-route.zh.md)

## Problem

The native writing engine (the `dsh` preset from the [native-engine-in-roster decision](2026-09-17-paperai-native-engine-in-roster.md)) runs on whatever model route the person configures on the Models page. For Alibaba, the installed pi-ai catalog ships only the two Qwen Token Plan routes (`qwen-token-plan` on `token-plan.ap-southeast-1…`, `qwen-token-plan-cn` on `token-plan.cn-beijing…`). A person holding a regular 阿里云百炼 (DashScope) key — the common case — picks the nearest-sounding route, pastes the key, and every turn fails with `AUTH`: both Token Plan endpoints answer `401 Invalid API-key provided`, while the same key answers `200` on `dashscope.aliyuncs.com/compatible-mode/v1`. Nothing on the page says which endpoint a key belongs to, and the custom-provider card asks for endpoint, protocol, models, and compat switches the person cannot know. Upgrading pi-ai does not help: 0.85.1 still ships no plain DashScope route.

## Decision

The PaperAI profile declares the route itself. `packages/bundle/paperai-web/cordis.patch.yml` gives the `llm-pi-ai` row a `providers.bailian` profile: `displayName: 阿里云百炼`, `apiKeyEnv: DASHSCOPE_API_KEY`, `api: openai-completions`, `baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1`, route-level compat for DashScope's OpenAI-compatible surface (`thinkingFormat: qwen`, `supportsDeveloperRole: false`, `supportsStore: false`, `maxTokensField: max_tokens`), and eleven models the endpoint's `/models` listing confirms it serves (Qwen 3.7 Plus and Max, Qwen 3.6 Plus and Flash, DeepSeek V4 Pro and Flash, DeepSeek V3.2, GLM-5.2, Kimi K2.6 and K2.7 Code, MiniMax-M2.5), each with the capacity and modalities pi-ai records for the same ids on its `qwen-token-plan-cn` route and `reasoningEfforts: { off: null, high: high }`, which pi-ai's Qwen format sends as `enable_thinking`. The two DeepSeek V4 models keep their own `thinkingFormat: deepseek` and `requiresReasoningContentOnAssistantMessages`.

The row config is the settings namespace's base layer, so the route appears in the Models page directory as a declared provider named 阿里云百炼, its key is entered there under `DASHSCOPE_API_KEY`, and a person's own routes in `settings.yaml` merge beside it. The route registers whether or not a key is stored, which is how every DSH route behaves; a turn without the key fails with `MISSING_CREDENTIAL`.

## Alternatives considered

**Leave it to the custom-provider card.** The card works, but it asks for endpoint, protocol, model ids, capacities, and compat switches, and the person who reached for `qwen-token-plan` did so because a named route looked like the right answer. A named route that is right removes the guess.

**Wait for or patch pi-ai.** pi-ai 0.85.1 still ships only the Token Plan routes; a vendored catalog addition would need re-applying on every upgrade, and DSH's profile mechanism exists for exactly this kind of deployment-declared route.

**Ship the Token Plan route with the Bailian endpoint swapped in.** A `baseURL` override on `qwen-token-plan-cn` would serve the same models but keep the misleading name and the wrong credential reference, and it would drop the route pi-ai ships for people who do hold a Token Plan key.

## Consequences

A Bailian key works on the first try through a named route. `packages/bundle/paperai-web/tests/paperai-web.spec.ts` parses the row through the adapter's own `Config` schema and pins the endpoint, protocol, credential reference, compat, and model list. The model list is hand-maintained: a model Bailian adds is not offered until listed here, and a model it retires fails at request time until removed. DashScope's international site (`dashscope-intl`) is not covered; a key from there still needs the custom-provider card.
