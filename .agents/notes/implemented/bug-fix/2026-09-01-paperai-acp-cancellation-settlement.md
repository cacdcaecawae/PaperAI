# Agent Note: PaperAI ACP cancellation settles at the provider response

Status: implemented

English | [中文](2026-09-01-paperai-acp-cancellation-settlement.zh.md)

## Problem

Binding the outgoing ACP prompt request to the DSH turn signal lets the SDK reject the local request as soon as that signal aborts. Waiting for that already-rejected Promise still closes the DSH turn projection before the provider can send a terminal tool update and its cancelled response.

## Decision

An ACP prompt remains the settlement owner after cancellation. PaperAI does not bind the prompt request or the established provider process to the DSH turn signal. It sends ACP session cancellation, retires the operation generation used by mode requests and file callbacks, aborts the turn, and then awaits the original prompt request. Session updates ordered before the provider's final response continue through the active turn projection. Only after the response arrives does PaperAI finish the interrupted assistant projection and append `step/end` and `turn/end`.

Process lifetime follows the Agent lifecycle and explicit runtime closure, separately from the operation generation. A turn signal may cancel initialization while a replacement is still starting, but once startup succeeds, cancelling that turn cannot terminate the provider before it handles `session/cancel`. The next runtime-bound operation closes the cancelled process and resumes the provider session in a fresh process.

Mode-selection and startup requests retain their explicit abort race. Those operations publish no turn transcript and their process generation is replaceable, so abandoning their local wait after generation revocation does not lose ordered model output.

## Alternatives considered

**Close the projection when the DSH signal aborts.** This makes cancellation appear prompt but treats the local signal as provider settlement and loses protocol-ordered terminal updates.

**Keep the projection open for a fixed grace period.** A timer cannot identify the final update and would make correctness depend on provider and machine timing.

**Accept late updates after the turn closes.** Tool results must remain inside their owning step and turn; appending them later would break transcript ordering.

## Verification

The subprocess integration fixture opens a tool call, waits for ACP cancellation, sends its completed update, and then returns `cancelled`. The test requires `tool/call`, `tool/result`, `step/end`, and `turn/end` in that order, with an interrupted assistant projection and an aborted turn. It also rejects a native permission mode, starts a replacement runtime, and proves that cancelling its first turn still preserves the terminal tool result. The active permission-switch test exercises the same settlement before replacing the runtime and committing the new permission preset. A keyless PaperAI browser scenario boots the shipped Codex preset against that external-process fixture, stops the running turn after a rejected permission switch, and snapshots the terminal tool result in the assembled conversation UI.

## Consequences

Cancellation still revokes file authority immediately, while transcript closure waits for the pinned provider adapter to settle its prompt. A provider that violates ACP by never answering cancellation can therefore delay `whenIdle()` and disposal; PaperAI does not truncate valid terminal updates with a timeout.
