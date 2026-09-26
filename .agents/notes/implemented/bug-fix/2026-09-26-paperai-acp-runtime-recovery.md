# Agent Note: PaperAI ACP runtime recovery preserves confirmed settings

Status: implemented

English | [中文](2026-09-26-paperai-acp-runtime-recovery.zh.md)

## Problem

A provider process can exit without a cancellation or failed selection. Reusing its disconnected runtime prevents both prompts and model operations from recovering. A new process can also advertise default settings when it loads the same conversation, so recording startup metadata before restoring the conversation's selection loses reasoning effort, switches, and general options.

## Decision

Runtime replacement is required when explicitly requested or when the current transport is disconnected. Prompts and the serialized model-operation queue use that same predicate. Recovery closes the previous process and loads the owned provider session; a failed load retains the existing history and remains retryable. Diagnostics can report a disconnected conversation when no runtime survived startup.

Every startup reads the last confirmed `paperai/acp/config` for its provider and restores model, reasoning effort, switches, and general options in that order. The Session sandbox preset continues to own permission controls. Startup config notifications update runtime state without publishing intermediate selections; the Agent records only the final applied settings. Missing or safely rejected preferences warn and keep the provider's accepted value. Connection loss, cancellation, or failed selection rollback fails recovery. Launch settings remain pinned to the published conversation.

This specifies replacement configuration for [model selection](../feature/2026-09-02-acp-model-effort-switch-selection.md) while retaining [provider cancellation settlement](2026-09-01-paperai-acp-cancellation-settlement.md).

## Alternatives considered

Marking only process-exit callbacks for restart misses other disconnected transports and failed recovery with no remaining runtime. Replaying the current in-memory selection can preserve a partially failed transaction. Replaying channel defaults replaces conversation choices with unrelated preferences for new conversations.

## Consequences

Recovery may make additional configuration RPCs before a prompt or model operation. Values the provider no longer supports cannot be preserved, but the log records the actual fallback selection. The next operation initiates recovery; a failed prompt is never automatically replayed. Subprocess regressions cover cold resume, cancelled turns, crashes, retry, and rejected settings. A keyless snapshot boots the shipped PaperAI profile and captures the recovered selection and conversation transcript across a crash and cancellation.
