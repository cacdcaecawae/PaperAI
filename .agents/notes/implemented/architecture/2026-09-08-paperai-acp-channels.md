# Agent Note: PaperAI ACP channels and provider-owned sessions

Status: implemented

English | [中文](2026-09-08-paperai-acp-channels.zh.md)

## Problem

A channel overview must distinguish installation, a past successful handshake, and a currently open conversation. ACP processes also own external history, options, tools, and credentials; treating those as interchangeable with DSH's local state can lose context or grant access to the wrong project.

## Decision

PaperAI exposes Codex and Claude through one ACP implementation and a settings directory. Other channel identities are rejected. DSH's native loop and other profiles retain their own composition. Provider definitions contribute exact factory routes to the preset registry; copying a contributed route as an ordinary file preset is rejected because an empty composition cannot reproduce the external loop.

This partially supersedes the initial PaperAI roster in the [product-profile decision](2026-08-28-paperai-product-profile.md). The [Agentero adoption decision](2026-09-05-paperai-agentero-adoption.md) still owns document navigation and draft retention; this note owns the expanded ACP directory and lifecycle. The [model-option decision](../feature/2026-09-02-acp-model-effort-switch-selection.md) retains its transaction and log-reconstruction rationale.

## Ownership

Only a published conversation with an open ACP connection is connected. Discovery and isolated probes report observations. Probes and management connections receive no project files, permissions, or PaperAI MCP descriptor. Startup has a deadline and cancellation; a superseded selection cancels the old startup while preserving the browser's session binding until Host replacement settles.

The settings mirror remains the browser's sole settings reader. Credential edits use path mutations so redacted values cannot be erased by an unrelated edit. Model favorites and default settings belong to a channel; negotiated options and plans belong to one conversation.

External history imports load into a new local conversation. Replay is staged in a detached log, validated before publication, and associated with provider identity and execution host. Existing associations are reused. Local forks cannot reuse the parent's external session or invent a truncation point. Native close releases a connection; explicit external deletion has a separate capability check and refuses active local associations.

Filesystem and terminal requests retain their owning session and cancellation. Results returned to the provider are logged, as are extra prompt context and answers. Tool progress updates an existing call; a pure presenter supplies the existing generic, diff, and terminal cards without registering an executable DSH tool. Images enter the attachment service; media without a canonical display block retains its original data and an explicit display notice.

Managed npm installations publish a new directory atomically after validation. Cancellation preserves the previous installation. Uninstall targets only the current managed generation; bundled and external installations remain separate. Previous generations remain available for another process that may still own them.

SSH starts an installed adapter on an explicitly configured POSIX host. Launch data goes through stdin, host-key checking is strict, and the session's revocable HTTP MCP endpoint travels over a private reverse tunnel. Remote adapters do not receive local filesystem or terminal callbacks. HTTP MCP falls back to a standard stdio bridge only for local adapters that lack HTTP support.

## Alternatives considered

**A successful probe as connection status.** Initialization does not prove that a live conversation exists or that an account can make model requests. Separate observations prevent stale green status after process exit.

**A shared warm conversation pool.** Agentero's warm-up starts and closes a session. Reusing real project sessions would entangle external identities, permissions, and MCP credentials; per-conversation processes preserve ownership.

**Copying Agentero's state framework or history database.** Existing Cordis services, slots, settings, and session logs already own these responsibilities. Adopting another state system would duplicate lifecycle and persistence rules.

## Consequences

The directory makes channel availability inspectable without switching conversations. Startup cancellation keeps newer choices responsive, while native CLI startup time remains visible. Optional protocol features depend on what the adapter advertises. Remote execution requires a configured host and installed software; file synchronization and remote workspace browsing remain outside this decision.
