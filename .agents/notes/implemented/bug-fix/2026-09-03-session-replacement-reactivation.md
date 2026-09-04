# Agent Note: Host replacement reactivates a staged Session

Status: implemented

English | [中文](2026-09-03-session-replacement-reactivation.zh.md)

## Problem

Switching a blank conversation between peer Agent drivers removes the old Host Agent and adds its replacement under the same Session id. The client retains the staged Session instance, whose removal flag disables its composer and model selector. Updating only the replacement's summary leaves those controls disabled after startup succeeds. Removal also dropped the manager's projection store while the visible Session retained the old one, so permission updates no longer reached its observers.

## Decision

An authoritative `host/session-added` frame clears removal on an existing Session instance and applies the added Session's blank bit. `host/session-removed` disables interaction again. A list baseline can update summary data but cannot clear removal, because an older response may arrive after the removal frame.

Removal clears projection values and sequence watermarks in the resident store without replacing it. Subscribed faces remain connected to the manager that receives replacement frames; sessions that were never instantiated can release their store. Replacing the store alone would leave the visible Session reading stale permission and other projection values.

The [session-scope decision](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) continues to govern staging and scope teardown. Reactivation preserves the staged instance rather than discarding its local state merely to reset one flag.

## Alternatives considered

**Clear removal during every summary refresh.** A delayed baseline can make a removed Agent appear interactive before a replacement exists.

**Ignore removal in the model selector.** The composer and other controls would remain disabled, and genuinely removed sessions would gain an actionable model menu.

**Replace the client Session object.** The staged view already holds its instance; replacing identity to clear availability would disturb its observers and local state.

## Consequences

Controls recover when the Host publishes the replacement, including a restored Agent after a failed switch. Unit coverage distinguishes a stale list baseline from an added frame. The assembled PaperAI browser scenario switches Claude and Codex repeatedly, selects models after each switch, snapshots the resulting model menu, and exercises permission changes against the replacement Agent.
