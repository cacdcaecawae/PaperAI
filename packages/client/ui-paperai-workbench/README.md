# @paperai/ui-workbench

English | [中文](README.zh.md)

PaperAI's browser workbench over DSH plugins and slots. Projects and tracked Word documents occupy the left sidebar, the document occupies the middle column, and the Agent conversation occupies the right. The product installs `PAPERAI_LAYOUT_CONFIG` through `ctx.layout.configure`: `detailsPosition: start`, `centerMin: 360`, `detailsMin: 480`, `detailsDefault: 760`, `detailsMax: 1280`, current-Session visibility, and document focus when both columns cannot fit. Opening Word makes the blank conversation compact; quoting text reveals the conversation while retaining the document beside it when space permits.

The plugin contributes the document list and Project Doctor, project start page, Templates settings page, `paperai` document view, and Agent-status child slot. It retains DSH Workspace navigation, conversation, permission controls, and model selection. Registrations follow their declaring slots through `slots.inject()`. Colors and shared controls come from DSH.

The start page creates or opens a project directory, names the project with its template, document count, and last edit, lists the tracked documents with their types, and creates or imports a document from one menu of the project's template formats plus free Word import. The template dialog and settings page share one library store. Unanswered template choices open the dialog once per visit. The [Host service](../../paperai/workbench-service/README.md) owns import limits, template semantics, and document operations.

The document view renders sanitized, derived HTML in a shadow root, retaining embedded raster images. Only blocks carrying a provider-issued `data-path` participate in matching by text, table-cell membership, and reading order. Unaddressed headers and footers stay read-only and cannot consume a same-text body match; unmatched or read-only cells cannot target body paragraphs. Clicking a mapped paragraph, heading, list item, or cell opens its plain-text editor from the document snapshot’s node text. Save or Ctrl/Cmd+Enter creates one version through `commit`; Escape cancels. Templates, gate findings, and versions open individually, loading secondary content on demand. Picking a version compares it on the document itself: changed words are marked in place, removed paragraphs reappear struck through, a floating navigator walks the changes, and blocks stay read-only until the comparison closes. Exports display their paths; a failed formal-export gate opens its findings.

`Config.retainedPreviews` is a positive integer, default `2`, including the active preview. Recent previews retain their DOM, scroll positions, and block drafts. Eviction releases the heavy preview while retaining lightweight drafts and scroll offsets until plugin disposal. Document changes invalidate inactive previews; reconnect re-reads loaded projections. An external change to the edited block retains the draft for copying or discarding and disables saving it over the new block. Starting a document rejects an existing dirty draft. Drafting or navigation during import or template creation keeps the active view; the completed document is added to the project list.

Selecting mapped Word text exposes “Ask Agent.” The gesture inserts a removable composer reference with document id, path, revision, head commit, block ids, and exact text. Its serialized value freezes before asynchronous submission; changing documents cannot retarget it. The existing reference codec handles clipboard persistence, removal, and message serialization. Selection alone never sends a message.

The Agent selector reports diagnostic results and startup progress separately from the live model selector. Another conversation using the provider does not establish a connection for this selector. Explicit detection launches a bounded, prompt-free probe without replacing the conversation process. Project Doctor opens a read-only scan. The recovery preview identifies the missing working file and exact version before the user restores it. [Commit-service recovery](../../paperai/commit-service/README.md) owns validation and publication.

The plugin mounts the generated `@paperai/workbench-service/remote` descriptor before registering UI. Transport types come from `@paperai/workbench-service/types`. React-free controllers own browser state, reject stale replies, and release subscriptions and pending reads on disposal.

Opening, importing, or creating a document keeps the selected Session when it belongs to that project, including after its Agent conversation has started. Connecting another project resolves a Session there. Reopening the active document preserves its draft.

Submitted Word quotations display the selected text with source information in an optional disclosure. The document title leads the serialized message; complete provenance remains in copy output and the session log. Project diagnostics display localized issue names and portable path separators.

## Model Experience

### Explicit Word context

#### What the model sees

Only references the user keeps and submits enter ordinary `user/message` content. Each contains exact text and document/version provenance, so the DSH log reconstructs the context without consulting the current preview.

#### Token effect

Submitted selections add their text and provenance to that message; previews and diagnostics add no tokens.

#### KV Cache effect

The user message appends normally; diagnostics and navigation do not change the request prefix.

## Known Limitations and Deferred Work

- DOCX remains authoritative; browser HTML and drafts are never a second document store.
- Editing changes plain text per mapped block. Unmapped content and rich formatting require the Agent and document engine.
- Preview retention and drafts last for the browser lifetime and are not restored after reload.
- Cached models describe earlier initialization. Only the connected adapter authorizes current selection.
