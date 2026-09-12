# @paperai/ui-workbench

English | [中文](README.zh.md)

PaperAI's browser workbench over DSH plugins and slots. Projects and tracked Word documents occupy the left sidebar; a document opens in writing mode, with an explicit switch to Agent collaboration on the right. Writing mode and zoom are remembered per Session. The product installs `PAPERAI_LAYOUT_CONFIG` through `ctx.layout.configure`: `detailsPosition: start`, `centerMin: 360`, `detailsMin: 480`, `detailsDefault: 860`, `detailsMax: 1280`, current-Session visibility, and document focus when both columns cannot fit. Entering collaboration, asking the Agent to fix findings, or quoting text closes any document panel and reveals the conversation, retaining the document beside it when space permits.

The plugin contributes the document list and Project Doctor, project start page, Templates settings page, and `paperai` document view. It retains DSH Workspace navigation, conversation, permission controls, and model selection. Registrations follow their declaring slots through `slots.inject()`. Colors and shared controls come from DSH.

The start page creates or opens a project directory, names the project with its template, document count, and last edit, lists the tracked documents with their types, and creates or imports a document from one menu of the project's template formats plus free Word import. Same-name documents show a filename and short document id; tooltips retain full working paths and titles. Template selection opens explicitly. Its dialog and settings page share one library store, with replacement impact hints and confirmation before removing a format or set. The [Host service](../../paperai/workbench-service/README.md) owns import limits, template semantics, and document operations.

The document view renders sanitized, derived HTML in a shadow root, retaining embedded raster images. One editing host preserves native selections across paragraphs. Only blocks carrying a provider-issued `data-path` participate in matching by text, table-cell membership, and reading order. Unmapped subtrees are explicitly read-only; input outside a mapped block, deletion across original-block edges, and drag/drop mutations are refused. Empty draft paragraphs within one original block can still merge. Rejected non-cancelable composition restores the preview's nodes without invalidating draft or history references. Unaddressed headers and footers cannot consume a same-text body match; unmatched or read-only cells cannot target body paragraphs. Paragraphs containing complex objects are protected against text/run rebuilds in both the browser and Host.

The persistent toolbar exposes save, draft undo/redo, font, point size, bold/italic/underline, character-format clearing, paragraph style/alignment/left indent/line spacing, and find. Character readings distinguish inherited, explicit, and mixed values. A retained selection supports formatting across mapped blocks; a collapsed caret targets subsequent input. Enter splits ordinary body paragraphs, Shift+Enter inserts a soft break, and pasted line breaks become structural drafts. Composition input is grouped for undo. Drafts stay addressed by their original nodes, carrying paragraphs, runs, and layout to one transactional commit. Ctrl/Cmd+S or Ctrl/Cmd+Enter saves; Ctrl/Cmd+Z and redo affect local drafts, while Escape discards the focused block's draft.

Template, format-check, and version panels open one at a time beside the page, temporarily taking the conversation's space and restoring focus when closed; narrow columns stack the panel. Version comparison marks locatable text changes and lists unplaced changes without guessing. Recorded format operations have a separate count, not a visual format diff. Comparison makes blocks read-only. Restoring requires confirmation and creates a new version; it never replaces draft undo. Export uses the saved document, is blocked by drafts, distinguishes unchecked draft output from formal delivery checks, and reports the output path or blocking findings.

A stable status bar reports in-memory drafts, saving, completion, and failed operations. Zoom supports fit-width and 50–200%; changing zoom preserves relative scroll position. The preview explicitly disclaims final Word pagination. A commit refused because the Working DOCX changed outside PaperAI offers to record that file as a version of its own and reopens the document with the draft kept; the project doctor offers the same for every document it flags.

`Config.retainedPreviews` is a positive integer, default `2`, including the active preview. Recent previews retain their DOM, scroll positions, and block drafts. Eviction releases the heavy preview while retaining lightweight drafts and scroll offsets until plugin disposal. Document changes invalidate inactive previews; reconnect re-reads loaded projections. Drafts retain their base revision: a newer head conflicts them even if its text is unchanged, preventing format-only updates from being overwritten. Conflicted drafts remain available for copying or discarding. Starting a document rejects an existing dirty draft. Drafting or navigation during import or template creation keeps the active view; the completed document is added to the project list.

Selecting mapped Word text exposes “Ask Agent.” The gesture inserts a removable composer reference with document id, path, revision, head commit, block ids, and exact text. Its serialized value freezes before asynchronous submission; changing documents cannot retarget it. The existing reference codec handles clipboard persistence, removal, and message serialization. The format-check panel's repair action appends its request after any existing composer text, preserving images and references, and reveals the conversation for review. These gestures never send a message.

Project Doctor opens a read-only scan. The recovery preview identifies the missing working file and exact version before the user restores it. [Commit-service recovery](../../paperai/commit-service/README.md) owns validation and publication.

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
- Unmapped content, complex-object paragraphs, and structural changes inside tables require Word or supported Agent/engine operations. Unmodelled run properties cannot be authored in the browser.
- Replacement or deletion across distinct original nodes is protected; selections can span those nodes for formatting and quotation. Detailed formatting diffs and exact Word pagination are unavailable.
- Preview retention and drafts last for the browser lifetime and are not restored after reload.
- Cached models describe earlier initialization. Only the connected adapter authorizes current selection.
