# Agent Note: ACP model, reasoning effort, and fast-mode selection

Status: implemented

English | [中文](2026-09-02-acp-model-effort-switch-selection.zh.md)

## Problem

PaperAI's Codex and Claude engines run through pinned ACP adapters that advertise three session selectors: a `model` select, a `thought_level` select (reasoning effort), and a boolean fast-mode option (`fast-mode` for Codex, `fast` for Claude, both under `model_config`). The DSH `AgentModelController` seam carried only the model, so the composer's model menu showed the ACP models but no effort levels and no fast mode, and `session.selectModel` rejected any effort for a driver-owned session outright. Users of the external engines could not choose reasoning strength or fast mode from PaperAI at all.

## Decision

**One additive driver seam.** `@deepseek-ai/dsh-agent` extends `AgentDriverModel` with optional `reasoning` (driver-owned efforts plus the effort the driver applies by default) and `AgentModelController` with optional `currentReasoningEffort`, `switches` (driver-owned boolean switches with the driver's own names and descriptions), and a second `selectModel(model, { reasoningEffort?, switches? })` argument. A driver that advertises nothing keeps its previous contract; the DSH Agent Loop still routes through `ctx.llm` and exposes none of it.

**The Host forwards, the driver validates.** `session.models` projects a driver's efforts into the existing exact-model `reasoning` metadata and lists its switches as `SessionModels.switches`; the reported `current` selection carries the applied effort and every switch value. `session.selectModel` accepts optional `switches` beside the effort, passes both to the driver, and echoes the driver's resulting selection. The Host no longer refuses an effort for driver sessions: the driver rejects an effort or switch it does not advertise, which surfaces as the same `model-unavailable` failure the menu already localizes.

**ACP applies options in provider order, atomically.** `@paperai/agent-acp` parses the `thought_level` select (falling back to the `effort` / `reasoning_effort` ids) and every boolean option into the model state, attaches the current effort list to every advertised model, and applies a selection as model first, then effort, then switches — each through `session/set_config_option`, skipping values already in effect so a re-submitted selection sends nothing. Everything the current advertisement can answer is validated before the first provider call; the effort is validated again against the re-advertisement that follows a model switch; and a step the provider rejects after earlier steps took effect drives the session back to the selection captured before the transaction — not merely the explicit steps, since a model switch re-advertises the effort on its own — in dependency order: switches, then the model, then the previous model's effort, then any switch the model switch changed, attempting every restore even after one fails. The `AcpSelectionError` reports whether the session is back at its previous selection; when it is not, the Agent marks the runtime for rebuild so the next operation resumes the provider session in a fresh process and logs what it actually applies. Provider config notifications during the transaction update runtime state only, and observers hear one change when it ends. Boolean options ride the SDK's boolean request shape, which the client capabilities already declared.

**The applied selection is logged.** Model-visible ⟺ logged: every change of the applied selection appends a `paperai/acp/config` event (provider, model, effort, switch values; recorded once per change, deferred until the DSH Session is live at startup), and each turn's `request/header` carries the effort beside the model, so a driver session's model call is reconstructable, auditable, and forkable from the DSH log without the provider's own state.

**The menu renders driver switches as checkable rows.** The composer model menu keeps its Model / Effort rows and appends one `menuitemcheckbox` row per driver switch, labelled with the driver's own name and description; a flip submits the current model and effort together with the one changed switch, the accepted selection updates the row in place, and enabled switches join the trigger caption after the effort. LLM-routed sessions never receive switches, so their menu is unchanged.

## Alternatives considered

**A separate `session.setModelSwitch` RPC.** Rejected: the menu already submits the complete selection through one call, and a second RPC would need its own schema, client, handler, and documentation for one boolean; carrying `switches` on `ModelSelection` keeps the selection a single fact.

**Modelling fast mode as an extra effort level.** Rejected: fast mode is a service tier orthogonal to reasoning strength, and both adapters expose it as a separate option; folding it into the effort list would misreport the applied effort.

**Host-side effort validation from the catalog.** Rejected: the catalog is advisory by design, and the adapter re-advertises effort levels per model, so only the driver knows what the current model accepts.

## Testing

`catalog.spec.ts` pins the `thought_level` and boolean parsing; the ACP integration spec drives effort and fast mode through the fake adapter and asserts the exact `session/set_config_option` sequence, the rejections, the no-op re-submission, the `paperai/acp/config` events and the effort in `request/header`, and the reverse-order restore when the provider rejects a later step; `api-proxy-models.spec.ts` covers projection, forwarding, and the driver rejection path; `model-select.client.spec.tsx` covers the switch rows, the submitted selection, the caption, and the rejection toast; `apps/web/tests/paperai-permissions.e2e.ts` snapshots the assembled menu and applies effort and fast mode against the fake Codex adapter.

## Consequences

Efforts are advertised per session, not per model, so every model in the menu shows the current model's levels until the provider re-advertises after a switch; the menu reloads on every open, which is when the new list appears. Switch values have no `LlmCallConfig` field, so they are durable only through the `paperai/acp/config` event, which is PaperAI's own log vocabulary rather than a core header field. A provider that rejects a restore step leaves the session mid-way until the rebuild: the failed selection returns `restored: false`, nothing is logged for the half state, and the log catches up with the provider's real selection when the fresh process re-advertises it. The upstream patch set gains one more additive seam (driver efforts and switches on `AgentModelController`, `switches` on `ModelSelection` and `SessionModels`) that later DSH merges must preserve.
