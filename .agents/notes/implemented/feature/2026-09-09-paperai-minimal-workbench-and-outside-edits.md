# Agent Note: PaperAI minimal workbench, resident document engine, and outside edits

Status: implemented

English | [中文](2026-09-09-paperai-minimal-workbench-and-outside-edits.zh.md)

## Problem

A paragraph commit took 13 to 15 seconds on a 23 KB document because every OfficeCLI command started a fresh process and every commit waited for the Host to render the preview again. The browser looked assembled from parts rather than designed: the start page repeated the DSH headline, the ACP settings page carried banners and counters, the document view wore capsule chips, and the version panels lay over the page they described. A Working DOCX changed outside PaperAI (Word, a file sync, an older import defect) left the writer stuck: the commit service refused edits until "the external edit is captured as its own version", and nothing offered that capture. Editing itself did not feel like Word: a click swapped the paragraph for a textarea with its own buttons, one paragraph at a time, and the Agent-status chip beside the composer opened a popover that the conversation column clipped.

## Decision

The OfficeCLI engine keeps one resident process per file across operations and closes it after `residentIdleMs` (default 2 s) of idleness. While resident, the file can be read and written in place by other programs but not renamed, replaced, or deleted, so the window is short and every PaperAI path that replaces or deletes a file the engine touched calls `release()` first: the commit candidate and Working DOCX in commit-service, the staged import copy in document-service. `release()` is a no-op without a resident.

A block commit no longer waits for the Host preview. The Host answers with the committed document and an empty preview (`projectOpen(..., 'skip')`); the browser writes the committed text into the preview it already shows and opens the document again in the background for the rendered one. The interim patch locates the block exactly as the block editor maps it: an addressed block (`data-path`) of the same kind (body paragraph or table cell), with the same text, at the node's ordinal among its same-text peers. A block the mapping cannot name stays as it was until the render arrives. The background render replaces the preview only when it belongs to the same revision; a render carrying a newer head raises the existing external-update notice instead of entering the projection.

`paperCommits.captureExternal` records a Working DOCX that no longer matches its head as a new version of its own: the bytes stay, a snapshot and a commit are added, with no operations and the message 载入外部修改. A Working DOCX that already matches its head is rejected. The workbench exposes it as the `captureExternal` Remote, which re-reads the integrity report. A refused commit shows why and offers 记为新版本, which captures and reopens the document with the draft kept when its block still reads the same; the project doctor offers the same for every document it flags as changed outside PaperAI.

Comparing a version marks its changes on the current page only where exactly one addressed body block still carries the changed or added text; removed paragraphs and changes whose text is gone or repeated are listed in the panel rather than placed by guess. Document panels (template, gate, versions) open as a column beside the page and claim the content area through the layout's details focus, so the page keeps its width and the conversation yields until the panel closes; a column too narrow for both lays the panel over the page. Pages zoom down to the column width; the details column opens at 860 px so one A4 page shows at full size.

Blocks are written into in place. Every mapped block is `contenteditable` (the Host may not pre-declare any block editable; the sanitizer strips the attribute), an `input` event reports the block to the controller, and the workbench keeps a list of drafts rather than one: `updateDraft(nodeId, draft)` adds or replaces a block's draft and `null` drops it, `cancelEdit` drops them all, `commitEdit` sends every draft as one commit with one `replace-text` mutation per block, and the interim preview patch locates all blocks against the original text before rewriting any. A retyped block shows a gold marker and tint like a compared change; one whose block changed outside PaperAI turns the marker red, and the save waits until that draft is discarded. Enter never breaks a paragraph (a new block is the Agent's job), Ctrl/Cmd+Enter saves, Escape returns one block to the Host's rendering, whose runs are kept from a clone taken at render time. One bar at the foot of the page counts the retyped blocks and offers 放弃修改 and 保存; blocks stop being editable while a save is in flight or a version is compared.

The browser follows one visual grammar: the ink-and-gold token layer in `ui-paperai-brand`, which supersedes the no-token-layer half of the [UI overhaul note](2026-09-03-paperai-ui-overhaul.md), 12 to 13 px UI text, hairlines, radii of 8 and 12, one filled action per screen (导出 in the document view, 保存 in the pending bar), and Codex/Claude logos kept where people look for them. The start page names the project with its template, document count, and last edit, lists the tracked documents with type badges, and starts every format from one menu; ACP settings read as grouped cards. The Agent-status chip and its popover are gone from the composer row: detection lives in the Agent settings page, and the workbench no longer fills `conversation.hero.agentPreset.status` or depends on `ui-agent-preset`.

## Alternatives considered

**Mutate the Working DOCX resident directly and `save`.** Removes the candidate copy and one cold start per commit, but a crash mid-save corrupts the writer's file; the candidate-and-replace publication stays.

**Keep the panels as overlays and widen the column on demand.** The layout exposes no width setter; the details preference is the user's. Details focus is the existing lever and matches the mockup, where the history replaces the Agent column.

**Guess positions for removed paragraphs and repeated text.** The Host diff carries no positions; a guessed mark on the wrong block reads as a wrong edit. Listing beats guessing.

**Show the diff on the compared version's own preview.** Needs a Host method rendering a snapshot; deferred until the history view earns it.

**Keep the textarea editor and restyle it.** Any seat beside the paragraph still reads as a form, and one open editor at a time is not how people revise a page. Typing into the rendered block is what Word does; plain-text editing keeps the block's runs intact while the text changes and hands one string per block to the existing `replace-text` mutation.

**Fix the chip's popover placement.** Anchoring it elsewhere keeps a second Agent status beside the settings page's; the row is quieter without it.

## Testing

Unit coverage: resident reuse, idle close, and no-op release in document-engine-officecli; staged release and capture in document-service and commit-service; the Remote and doctor paths in workbench-service; patch ordinals, unique-match marking, deferred refresh with revision checks, capture from the notice and the doctor, the panel column, and in-place retyping (editable blocks, input reporting, multi-block commits, restore on Escape, the pending bar) in ui-paperai-workbench. The PaperAI browser goldens follow the start page, the Agent settings label, the 860 px column, relative dates, and the pending bar in place of the block editor; the browser flows retype blocks with select-all and insert-text as a writer would.

## Consequences

Word and PaperAI can alternate on the same file: PaperAI refuses to build on unrecorded outside bytes, but one click records them as a version and editing continues. Other programs cannot rename, replace, or delete a file within about two seconds of a PaperAI operation. A commit paints in about 5 seconds on the reference document instead of 13 to 15, and the rendered preview follows about a second later; run formatting inside a retyped block flattens until then. Version comparison shows fewer marks on the page for documents with repeated text and lists those changes instead. Several paragraphs can be revised before one save, which records them as one version; a paragraph cannot be split or added from the page, and a block retyped after an outside change must be discarded before the rest saves. The composer row no longer reports Agent detection; the Agent settings page does. Adding a Remote method still requires the catalog registration (`linkedTypePages`) and the generated docs, plus hand-mirrored line references in the Chinese catalogs.
