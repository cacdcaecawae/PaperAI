# Agent Note: PaperAI ACP cancellation settles at the provider response

Status: implemented

English | [中文](2026-09-01-paperai-acp-cancellation-settlement.zh.md)

## Problem

Binding the outgoing ACP prompt request to the DSH turn signal lets the SDK reject the local request as soon as that signal aborts. Waiting for that already-rejected Promise still closes the DSH turn projection before the provider can send a terminal tool update and its cancelled response.

## Decision

An ACP prompt remains the settlement owner after cancellation only after it has been dispatched. PaperAI resolves the prompt blocks and then checks the DSH turn signal immediately before dispatch, so cancellation that wins that interval starts no provider work. Once dispatched, PaperAI does not bind the prompt request or the established provider process to the turn signal. It sends ACP session cancellation, retires the operation generation used by mode requests and file callbacks, aborts the turn, and then awaits the original prompt request. Session updates ordered before the provider's final response continue through the active turn projection. Only after the response arrives does PaperAI finish the interrupted assistant projection and append `step/end` and `turn/end`.

Process lifetime follows the Agent lifecycle and explicit runtime closure, separately from the operation generation. A turn signal may cancel initialization while a replacement is still starting, but once startup succeeds, cancelling that turn cannot terminate the provider before it handles `session/cancel`. The next runtime-bound operation closes the cancelled process and resumes the provider session in a fresh process.

Mode-selection and startup requests retain their explicit abort race. Those operations publish no turn transcript and their process generation is replaceable, so abandoning their local wait after generation revocation does not lose ordered model output. Provider model discovery and selection use one FIFO operation queue. When cancellation marks the runtime for replacement, only the queue head enters maintenance to recover it; later model operations wait for that result and cannot compete for the maintenance phase. A wake request remains reserved until every admitted model operation settles, so a pending turn observes the final queued selection. Disposal closes the queue to new operations, waits for the admitted queue to settle, and only then tears down the provider runtime and Agent scope.

## Alternatives considered

**Close the projection when the DSH signal aborts.** This makes cancellation appear prompt but treats the local signal as provider settlement and loses protocol-ordered terminal updates.

**Keep the projection open for a fixed grace period.** A timer cannot identify the final update and would make correctness depend on provider and machine timing.

**Accept late updates after the turn closes.** Tool results must remain inside their owning step and turn; appending them later would break transcript ordering.

## Verification

The subprocess integration fixture opens a tool call, waits for ACP cancellation, sends its completed update, and then returns `cancelled`. The test requires `tool/call`, `tool/result`, `step/end`, and `turn/end` in that order, with an interrupted assistant projection and an aborted turn. A second test cancels in the microtask between prompt preparation and dispatch, requires zero provider prompts, and then proves that the replacement runtime accepts the next turn. Concurrent model discovery and selection after cancellation must both complete through one replacement runtime, apply the final selection before a pending turn starts, and settle before disposal completes. The permission tests also reject a native mode, preserve terminal tool output, and commit a replacement mode only after settlement. Keyless PaperAI browser scenarios cover both the pre-dispatch cancellation and the provider-settled terminal tool result through the shipped Codex preset and assembled conversation UI.

## Consequences

Cancellation still revokes file authority immediately, while transcript closure waits for the pinned provider adapter to settle its prompt. A provider that violates ACP by never answering cancellation can therefore delay `whenIdle()` and disposal; PaperAI does not truncate valid terminal updates with a timeout.
