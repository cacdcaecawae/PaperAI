# @paperai/ui-workbench

English | [中文](README.zh.md)

DSH-native PaperAI document UI plugin. It contributes a flat project resource tree to `sidebar.workspaces.content` and a complete `paperai` view to `conversation.details.view`; it does not replace the Workspace browser, conversation shell, Tool details, or `ui-layout` geometry.

The Workspace contribution renders the fixed Documents, Templates, Images, Experiments, and Code groups from one Host-projected flat list. Each row carries an opaque resource id, path, depth, kind, optional working status, and an explicit `openable` capability. Only openable rows render as buttons. Selecting one connects the Workspace to its reusable blank Session, opens that Session, selects the `paperai` details view, and asks the Host for the document projection. Non-openable rows remain ordinary tree rows rather than dead controls.

The authoritative body is always the Working DOCX. The right column reuses the DSH details-host structure: a compact title row, line tabs, weak separators, ordinary 13–14px type, and row-level actions. Preview renders OfficeCLI-derived HTML in a strict read-only sandbox; that complete HTML never enters an edit callback. Edit renders the Host-projected semantic outline and requests a temporary plain-text buffer for only the selected editable node. The buffer is browser-local until **Commit and create version** submits one `replace-text` mutation addressed by `nodeId`. Switching nodes, opening another document, restoring a version, template changes, gate checks, and exports are disabled while an edit or conflict is unresolved. An external reload rebases the draft when that node is unchanged. When the same node changed, the workbench advances to the latest revision, retains both texts, and lets the user adopt the local text, adopt the external text, or edit and accept merged text before committing from the latest node buffer. The reload consumes only the external notification captured when it starts, so a newer notification received in flight remains actionable. Discard changes resets a non-conflicting buffer locally. Versions show durable summaries plus human or Agent provenance, including the Agent client and exact model, and expose Restore only for Host-marked restorable commits. Template gate shows the selected built-in or uploaded template, its latest findings, and one backed Run gate action.

`@paperai/workbench-service/types` is the sole owner of the transport data types; this package re-exports those types and keeps only browser store state locally. `PaperAIWorkbenchRemote` is a `Pick` of the generated `TypertClientRemote['paperaiWorkbench']` namespace, not a handwritten RPC interface. The plugin injects `@deepseek-ai/dsh-api-remotes`, imports the `@paperai/workbench-service/remote` descriptor, and awaits `ctx.remote.$mount()` before constructing the controller or registering UI. A descriptor-mount failure rejects plugin activation instead of producing an optional guessed namespace, and disposal unmounts the descriptor with the plugin lifecycle. The generated `list`, `open`, `readNode`, `commit`, `validate`, and `restore` methods use branded ids and `RemoteResult` envelopes. `readNode` returns one plain-text buffer with `nodeId`, `baseRevision`, and `baseCommitId`; `commit` sends node mutations against those base values and must return the created commit id plus fresh document and selected-node projections. It has no whole-document HTML input. Restore also creates a recoverable commit instead of moving the head silently.

`PaperAIWorkbenchController` is React-free and receives the already mounted generated namespace. It owns one stable resource store per Workspace and one workbench store per Session, including the selected-node phase, immutable Host buffer, current draft, external-conflict inputs, dirty flag, and action state. It aborts superseded cancellable reads, rejects stale node responses and buffers from another document revision, folds Remote rejections into display state, preserves the selected tab across document updates, refreshes observed projections after `connection/reset`, and rejects callbacks after plugin disposal. Slot registration follows declaration lifetimes through `slots.inject()`, including declarer unload and reload.

The plugin does not choose a details width. Its root fills the column supplied by `ui-layout`. The edit view splits the semantic outline and selected-node editor at ordinary widths, then stacks them through a container query when the column narrows; version metadata adapts through the same query. The project tree follows the existing Workspace indentation and does not render in collapsed, flat, search, or Ungrouped paths because those decisions belong to `ui-workspace`.

## Model Experience

### Browser document projection

#### What the model sees

Nothing from `@paperai/ui-workbench`; it renders Host document projections and does not register a prompt, Tool schema, or Session event.

#### Token effect

No tokens are added because the package neither assembles nor sends a model request.

#### KV Cache effect

No cache prefix changes because the package contributes only browser UI and explicit document RPC actions.

## Known Limitations and Deferred Work

- The package consumes the Host-owned protocol and generated descriptor but does not provide the Host implementation or compose itself into a bundle.
- The v1 shared protocol exposes plain-text selected-node buffers only, and the editor has no formatting toolbar. Rich-node editing requires a Host protocol addition rather than a private client DTO.
- The browser never maintains Markdown or complete editable HTML as a second body. Preview HTML is a derived projection; every durable body change is applied to the Working DOCX through `commit`.
- The Host owns preview generation and sanitization. The browser additionally uses a strict iframe sandbox but is not the document sanitizer.
