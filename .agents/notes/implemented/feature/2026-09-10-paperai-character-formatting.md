# Agent Note: character formatting from the page into the DOCX

Status: implemented

English | [中文](2026-09-10-paperai-character-formatting.zh.md)

Partially superseded: the [writing-workflow decision](2026-09-12-paperai-writing-workflow.md) owns the persistent toolbar and structural drafts. The [Word edit preservation decision](../bug-fix/2026-09-13-paperai-word-edit-preservation.md) owns engine writes and original run metadata; the [format-intent decision](../bug-fix/2026-09-13-paperai-rendered-format-intent.md) owns draft serialization and clearing. Resolved browser formatting and transport validation remain active here.

## Problem

Plain-text paragraph setters replace the original runs, so correcting a typo can erase a bold lead-in or a red phrase. Character formatting needs to travel with browser edits and remain editable within a paragraph.

## Decision

`replace-text` accepts optional `runs`: the block's text split where its character formatting changes, with explicit `bold`, `italic`, `underline`, `font`, `size` in points, and `color` values. Those fields travel through `DocumentTextRun` in the domain, `EngineTextRun` at the engine API, and `PaperAIDocumentTextRun` on the workbench transport because those layers separately declare the mutation. A commit whose text is unchanged is admitted when runs are present, so formatting alone is a version; its message reads 排版 rather than 修改. The runs must spell exactly the mutation's `nextText`, which the commit service enforces.

Plain text and formatted edits share the XML preservation path owned by the [Word edit preservation decision](../bug-fix/2026-09-13-paperai-word-edit-preservation.md).

The browser reads resolved styles from the Host's rendered run spans. `runsOf` walks each block's text nodes and merges neighbours with equal formatting for draft rendering. Selected text is formatted by wrapping it in a span stating the change and clearing that same declaration inside it, so the resolved value reflects the edit. The editor intercepts paste and inserts text alone. The persistent toolbar and Ctrl/Cmd+B, I, and U apply character formatting.

A declaration above selected text cannot be turned off solely inside it: text decoration draws onto descendants without inheriting. A change removes that declaration between the block and selection, retaining it on either side. Submission of the changed readings follows the format-intent decision.

## Alternatives considered

**Offer only paragraph-level emphasis.** Applying one value to every run cannot express a bold phrase inside a sentence. Character runs preserve the writer's selected range.

**Send only touched runs by original index.** Splitting and merging spans invalidates those indices. Paragraph-anchored drafts keep Word run positions out of the transport; the Word edit preservation decision owns character mapping in the engine.

**Read the runs from inline styles rather than resolved ones.** The Host's stylesheet sets character properties by rule as well (page bands, table-of-contents links), so an inline-only reading would misstate them. Resolved styles cost nothing here: the page's zoom does not scale the reported font size, so points convert from pixels directly.

**`document.execCommand`.** Its deprecated editing behavior inside a shadow tree cannot reliably preserve the editor's range and formatting rules. Explicit span changes keep those rules under the editor's control.

## Testing

Unit coverage exercises resolved run readings, explicit clearing across run boundaries, draft comparison, transport validation, and formatting-only commits. Browser scenarios apply and clear character formatting, save, and inspect the refreshed preview. Native metadata and command-count verification belong to the [Word edit preservation tests](../bug-fix/2026-09-13-paperai-word-edit-preservation.md#word-edit-tests).

## Consequences

Explicit run sizes remain in points and therefore override later template defaults. Unmodeled Word metadata and inserted-text inheritance follow the [Word edit preservation decision](../bug-fix/2026-09-13-paperai-word-edit-preservation.md). Adding a Remote field requires rebuilding typert descriptors: generated client schemas omit undeclared fields, which can turn a formatting-only request into a rejected no-op.
