# Agent Note: PaperAI declares the Alibaba Bailian model route

Status: implemented

English | [中文](2026-09-19-paperai-bailian-route.zh.md)

## Problem

The native writing engine (the `dsh` preset from the [native-engine-in-roster decision](2026-09-17-paperai-native-engine-in-roster.md)) runs on whatever model route the person configures on the Models page. For Alibaba, the installed pi-ai catalog ships only the two Qwen Token Plan routes (`qwen-token-plan` on `token-plan.ap-southeast-1…`, `qwen-token-plan-cn` on `token-plan.cn-beijing…`). A person holding a regular 阿里云百炼 (DashScope) key — the common case — picks the nearest-sounding route, pastes the key, and every turn fails with `AUTH`: both Token Plan endpoints answer `401 Invalid API-key provided`, while the same key answers `200` on `dashscope.aliyuncs.com/compatible-mode/v1`. Nothing on the page says which endpoint a key belongs to, and the custom-provider card asks for endpoint, protocol, models, and compat switches the person cannot know. Upgrading pi-ai does not help: 0.85.1 still ships no plain DashScope route.

## Decision

The PaperAI profile declares the route itself. `packages/bundle/paperai-web/cordis.patch.yml` gives the `llm-pi-ai` row a `providers.bailian` profile: `displayName: 阿里云百炼`, `apiKeyEnv: DASHSCOPE_API_KEY`, `api: openai-completions`, `baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1`, route-level compat for DashScope's OpenAI-compatible surface (`thinkingFormat: qwen`, `supportsDeveloperRole: false`, `supportsStore: false`, `maxTokensField: max_tokens`), and eleven models the endpoint's `/models` listing confirms it serves (Qwen 3.7 Plus and Max, Qwen 3.6 Plus and Flash, DeepSeek V4 Pro and Flash, DeepSeek V3.2, GLM-5.2, Kimi K2.6 and K2.7 Code, MiniMax-M2.5).

**Every number comes from Alibaba's own model pages, never from pi-ai's catalog.** pi-ai describes these same ids on its `qwen-token-plan-cn` route, but that is a different endpoint whose capacities do not transfer, and copying them shipped five wrong caps and two wrong context windows. `enable_thinking` is this endpoint's only thinking switch, so no model carries a `thinkingFormat` of its own and none sets `requiresReasoningContentOnAssistantMessages`; Bailian's mechanism for replaying reasoning is `preserve_thinking`, which its DeepSeek page does not document at all.

**`maxTokens` is a request cap, not a capacity label.** The adapter sends the configured value as this route's `max_tokens` default, and Bailian rejects `max_tokens` above 32,768 while thinking is on, for its own Qwen, GLM and Kimi deployments — which default to thinking on. Those rows therefore carry `min(documented output, 32768)` rather than the model's headline output length: 32,768 for the four Qwen rows and GLM-5.2, and 16,384 for the two Kimi rows, whose documented output is already lower. DeepSeek and MiniMax sit outside that gate and carry their real caps, 393,216 for the V4 pair and 65,536 for V3.2. `kimi-k2.7-code` and `MiniMax-M2.5` run in 仅思考模式 and offer only `high`; every other model offers `off` and `high`. A declared level list decides the menu, not the wire: pi-ai's qwen format writes `enable_thinking` from whether the request carries an effort at all, so a call that names none — the composer's own default — would ask those two to stop thinking. The route therefore sets `reasoning: high` as the default for an unnamed level, which Bailian also matches for seven of the nine mixed models; an explicit `off` still reaches the ones that allow it.

The row config is the settings namespace's base layer, so the route appears in the Models page directory as a declared provider named 阿里云百炼, its key is entered there under `DASHSCOPE_API_KEY`, and a person's own routes in `settings.yaml` merge beside it. The route registers whether or not a key is stored, which is how every DSH route behaves; a turn without the key fails with `MISSING_CREDENTIAL`.

## Alternatives considered

**Leave it to the custom-provider card.** The card works, but it asks for endpoint, protocol, model ids, capacities, and compat switches, and the person who reached for `qwen-token-plan` did so because a named route looked like the right answer. A named route that is right removes the guess.

**Wait for or patch pi-ai.** pi-ai 0.85.1 still ships only the Token Plan routes; a vendored catalog addition would need re-applying on every upgrade, and DSH's profile mechanism exists for exactly this kind of deployment-declared route.

**Ship the Token Plan route with the Bailian endpoint swapped in.** A `baseURL` override on `qwen-token-plan-cn` would serve the same models but keep the misleading name and the wrong credential reference, and it would drop the route pi-ai ships for people who do hold a Token Plan key.

**Send `max_completion_tokens` instead and keep the full output caps.** Alibaba recommends it and calls `max_tokens` 即将废弃, and it escapes the 32,768 gate. It also bounds the chain of thought and the reply together, which is a different axis from 最大输出长度, and its acceptance is not documented per model here. A writing turn never needs 32,768 output tokens, and a 400 costs more than the headroom, so the conservative field stays until a request-level check proves the other one.

## Consequences

A Bailian key works on the first try through a named route, and every model asks for an output length the endpoint accepts. `packages/bundle/paperai-web/tests/paperai-web.spec.ts` pins each model's own context window, cap and offered levels through the adapter's `Config` schema and asserts the route resolves through `assertServiceable`; `tests/bailian-request.spec.ts` mounts the shipped row against a local server and asserts what each model actually sends, which is the only check a capacity copied from another endpoint cannot pass. The model list stays hand-maintained: a model Bailian adds is not offered until listed, one it retires fails at request time until removed, and `deepseek-v3.2` is on Alibaba's retirement list for 2026-10-10. DashScope's international site (`dashscope-intl`) is not covered; a key from there still needs the custom-provider card.
