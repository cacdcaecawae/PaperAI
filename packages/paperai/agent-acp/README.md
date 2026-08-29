# @paperai/agent-acp

English | [中文](README.zh.md)

PaperAI's peer top-level Codex and Claude Agent drivers. The plugin keeps the native DSH Agent Loop as the default factory and registers exact `codex` and `claude` routes backed by their pinned local ACP adapters. ACP session model options feed the existing DSH model picker, and ACP permission requests pass through the existing DSH permission and approval surfaces.

Each returned handle owns its published Agent, DSH Session, and local ACP process. Disposal waits for all three to reach quiescence, failed startup rolls the unpublished lifecycle back so the same session ID can be retried, and ACP updates sent before a prompt response are projected before the DSH turn closes. Each process receives a non-reusable file-I/O generation combined with the protocol request, current Agent activity, and handle lifecycle. Cancellation revokes that generation permanently; the next turn closes the old process and resumes the provider session in a fresh process before accepting file callbacks.

The DSH Session sandbox preset also selects the provider's advertised native ACP permission mode. Codex maps `read-only`, `workspace-write`, and `danger-full-access` to `read-only`, `agent`, and `agent-full-access`; Claude maps them to `plan`, `acceptEdits`, and `bypassPermissions`. Claude's `acceptEdits` controls the provider's native file-edit posture; DSH still applies the `workspace-write` fence at every ACP client file callback. Codex receives the same target through `INITIAL_AGENT_MODE` at process startup. New and loaded sessions reconcile their advertised current mode before publication. Idle sandbox changes are serialized through ACP `session/set_mode`, and the next prompt waits for the final selection. A restrictive change during an active provider turn revokes that process generation and cancels the turn; the replacement process starts in the current Session mode. Mode requests combine the Agent lifecycle, process generation, and caller cancellation signals, so a stalled provider request cannot continue to pin shutdown or a replacement prompt after cancellation revokes its generation. Startup or synchronization fails if the pinned adapter does not advertise the required native mode; the package does not invent provider mode identifiers or silently select a weaker mode.

ACP client file callbacks use the mounted DSH filesystem instead of Node filesystem calls. Reads retain the DSH read policy; every write resolves the current Session's sandbox mode and immutable Workspace root at the final filesystem operation. `read-only` rejects writes, `workspace-write` confines them to the Workspace and platform temporary roots, and Full access removes that fence. An ACP `session/request_permission` response does not implicitly widen a later file callback because ACP does not bind that grant to the subsequent `fs/write_text_file` request.

Every ACP session also owns one authenticated PaperAI MCP descriptor. The descriptor is supplied during ACP `session/new` or `session/load`, follows provider model changes for commit provenance, and is revoked with the Agent handle. Codex and Claude therefore use the same document commit, template gate, history, revert, and export services as the human workbench; a missing MCP service is a startup failure, never a silent fallback to filesystem-only editing.

## Model Experience

### Codex and Claude ACP sessions

#### What the model sees

The selected `codex` or `claude` adapter receives ordinary user input through its ACP session and one authenticated PaperAI MCP descriptor. This package owns no prompt literal or tool schema; `@paperai/mcp` owns the descriptor's model-visible tools and results.

#### Token effect

Zero package-owned prompt tokens. User input and provider-owned ACP context consume tokens normally, while the MCP package owns the schema and result tokens enabled by the descriptor.

#### KV Cache effect

Each local ACP process owns provider request and cache reuse. Creating or loading a session, changing the selected provider model, or replacing the MCP descriptor can change subsequent request prefixes; this package does not retain or guarantee provider KV cache entries.

## Known Limitations and Deferred Work

- **Local provider dependency** — The `codex` and `claude` routes require their pinned local ACP adapters and provider authentication; command startup or handshake failure rejects Agent creation.
- **Provider mode availability** — Full access requires the pinned adapter to advertise its native unrestricted mode. If the provider suppresses that mode in the current environment, selecting the DSH preset fails explicitly instead of leaving the two permission states inconsistent.
- **Capability projection** — ACP Agents receive PaperAI document capabilities through the authenticated MCP descriptor. Native DSH Loop tools are not automatically mirrored into an ACP provider session.
- **Filesystem escalation** — ACP client file callbacks always enforce the Session's current sandbox preset. To permit an out-of-Workspace callback, the user must switch that Session to Full access through the standard DSH permission control; a preceding generic ACP approval does not create an unscoped filesystem grant.
