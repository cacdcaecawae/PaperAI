# Agent Note: PaperAI replaces only unrestorable blank ACP sessions

Status: implemented

English | [中文](2026-08-30-paperai-blank-acp-session-recovery.zh.md)

## Problem

An ACP adapter can return a provider session id before the provider has persisted any conversation. Codex exhibits this lifecycle for a newly started thread that receives no prompt: PaperAI records the successful `session/new` link, but a later process cannot load that id. Cold operations such as permission changes and model discovery then fail during Agent resume even though the DSH Session contains no conversation to recover.

Treating every load failure as replaceable would be unsafe. A DSH Session with a logged user message or opened turn may correspond to provider-owned history that PaperAI does not duplicate. Replacing that provider session would make the visible DSH transcript and the provider's prompt context disagree.

## Decision

`AcpAgent` classifies a provider session as replaceable only while its DSH event log contains neither `user/message` nor `turn/start`. The runtime still attempts `session/load` first. If that request fails, the caller signal remains active, and the session is replaceable, the runtime clears the failed replay state, creates a provider session on the same ACP connection, reapplies the current native permission mode, and publishes a new `paperai/acp/session` link.

A load failure for any DSH Session with user or turn history remains fatal. Cancellation also remains fatal instead of entering the replacement path. This rule depends on DSH-owned durable events rather than provider error text, because ACP adapters may normalize a missing or non-durable provider thread to a generic internal error.

The Web prompt admission gate treats an Agent-owned model controller as the authoritative route for its provider. The shared LLM adapter registry is consulted only for Agents without such a controller. Codex and Claude ACP Agents therefore do not need a duplicate DSH LLM adapter registration merely to submit their first prompt.

## Verification

A real `codex-acp` adapter test starts a blank thread, makes its fake Codex App Server reject the subsequent resume, and verifies that PaperAI creates a second thread with the required native permission mode. Agent lifecycle tests verify the new link for a blank persisted DSH Session and verify that the same load failure never reaches `session/new` after a `turn/start` event exists. A gateway test admits a prompt through an Agent-owned Codex model controller when no Codex route exists in the LLM adapter registry, and the PaperAI browser snapshot sends and cancels a prompt through that assembled path.

## Alternatives considered

**Replace the provider session after every load failure.** This would restore controls but could silently discard provider conversation history. The replacement path is restricted to a DSH log that proves no user message or turn has begun.

**Never replace a recorded provider session.** A blank provider id is not necessarily durable even though `session/new` returned successfully. Failing permanently leaves an otherwise empty DSH Session unusable without preserving any additional context.

**Match a provider-specific missing-session diagnostic.** Codex currently reports this case as a generic internal error, and other adapters may report different text. DSH event history provides the safety condition; provider wording does not.

## Consequences

Blank Codex Sessions survive a Host or ACP process restart and remain usable for permission changes, model discovery, and their first prompt. Agent-owned providers remain prompt-routable without duplicate LLM adapter registrations. Sessions with conversation history fail closed when provider state cannot be restored, preserving the requirement that PaperAI never presents a fresh provider context as a continuation of existing work.
