# Agent Note: preserve Word metadata and original edit targets

Status: implemented

English | [中文](2026-09-13-paperai-word-edit-preservation.zh.md)

## Problem

Rebuilding a paragraph from the browser's editable fields loses Word properties that the preview cannot represent. Rejecting those properties instead blocks ordinary Chinese templates, including runs with East Asian font hints. Positional addresses can target an inserted paragraph after an earlier structural edit, even though the commit records a different semantic node. Reading and parsing the full document before every replacement adds latency to multi-paragraph saves.

## Decision

The OfficeCLI Provider reads document XML once under its existing file lease and binds every original Office path to an XML node before applying mutations in caller order. References stay attached through insertions and splits; using a removed node rejects the batch before writing. Workbench, direct service, and MCP callers share this rule regardless of ordering or `paraId` availability.

The text index uses OfficeCLI's JSON output so whitespace and literal newlines remain data rather than record separators. Numeric body counters include first-level content-control children; unqualified body paths cannot bind to those children. Every targeted mutation carries the indexed original text, and a mismatch rejects the entire write batch, including deletions and anchored insertions. Replacement compares the editor's projection of the bound XML. Removals and anchors do not rewrite the anchor's inline content, so they compare OfficeCLI's own index reading of the target, read again under the same lease. That reading is looked up by the supplied address, or by the target's `paraId` when OfficeCLI indexes it that way, rather than by resolving the whole index, so removals and anchors take the address as `readTextNodes` spells it; another spelling of the same node raises `INVALID_OFFICE_PATH`, since refreshing cannot fix it. Paragraphs with equations, fields, nested wrappers, or carriage returns stay removable and usable as anchors. Where the XML itself yields the text, it must agree with that reading, so an incorrectly resolved address still conflicts. For a numbered paragraph, the reading may carry the generated list marker before the XML text. A paragraph is numbered when its own paragraph properties hold a `numId` other than 0, or, holding none, when the nearest `numId` along the `basedOn` chain of its explicit paragraph style is not 0, so the styles part is read only when a removal or anchor target has a style; tracked history under `w:pPrChange` does not count. Styled paragraphs without numbering, such as the 28 `a9` body paragraphs of the HIT proposal, keep the exact agreement. For a paragraph the editor cannot project, the comparison is index-only and cannot detect an incorrectly resolved numeric address. A paragraph split earlier in the batch stays one node: later checks join its paragraphs with line feeds, as the commit service records the replacement text, and removal, anchoring, and further replacement act on the whole group.

Character differences reuse original run properties for surviving text. Insertions inherit nearby properties, replacements inherit the start of the replaced range, and empty paragraphs retain a character seed. Explicit formatting overrides represented fields; omitted fields retain metadata. The [format-intent decision](2026-09-13-paperai-rendered-format-intent.md) owns which browser readings become explicit overrides. Bookmarks and pagination markers retain text-relative positions; split paragraphs inherit layout, with section properties on the final replacement. Unsupported editable objects still reject replacement.

A private JSON file carries one OfficeCLI `batch --input` command replacing the body through `/word/document.xml`, followed by save. The batch summary and individual result must confirm that the operation executed successfully; a zero process exit code alone cannot authorize publication. The `/document` write alias is unsuitable: its typed parser renames legacy indentation attributes, changing physical edges in bidirectional paragraphs. The standard package part preserves those attributes and unaffected subtrees. The file avoids Windows argument limits and is removed after success or failure. Explicit style changes resolve names through one additional styles read.

The paragraph-style menu reads the document's defined IDs and display names through the engine, document service, and workbench snapshot. It submits stored IDs, with exact IDs taking precedence over colliding names. The absent optional styles part yields no choices; malformed styles still fail the engine read. Workbench catalog failures yield an empty, disabled menu without failing document opening or a completed commit. Deferred commit replies preserve the browser's previous catalog until refresh. The menu says “Apply style” when no draft selection exists, because the preview does not identify each paragraph's current style.

This partially supersedes engine reconstruction and run inheritance in [character formatting](../feature/2026-09-10-paperai-character-formatting.md), and addressing and protection in [writing workflow](../feature/2026-09-12-paperai-writing-workflow.md). Their browser interaction, transport validation, draft, and transaction decisions remain active. Parsed XML is an operation-local projection of the candidate DOCX, with no persisted or browser-owned document authority.

## Alternatives considered

**Allow more run properties through the reconstruction whitelist.** Typing becomes possible but run splits and merges still discard metadata.

**Sort every caller's mutations backwards.** General batches have meaningful insertion, deletion, and repeated-reference order. Binding original nodes preserves that order and protects alternate callers.

**Read again after each structural operation.** Repeated parsing adds latency and still needs original identity tracking. One bound projection meets both requirements without a long-lived cache.

**Reject later references to a split paragraph when compiling the batch.** This is simpler but refuses valid sequential edits, such as splitting a paragraph and then inserting after it; tracking the resulting group keeps them working.

**Reimplement OfficeCLI's text view for removals and anchors.** Each construct needs its own rule: nested wrappers, carriage returns, and equations all read differently, and every gap blocks removing or anchoring on common thesis paragraphs. Reading OfficeCLI's index costs one more command only for batches that identify existing nodes.

<a id="word-edit-tests"></a>

## Testing

Unit tests verify metadata mapping, empty paragraph inheritance, explicit clearing, markers, section order, original-node references, file cleanup, and one document read per batch. The native Windows CI test requires OfficeCLI 1.0.145, edits the real HIT proposal template, compares untouched XML subtrees, checks bidirectional legacy indentation, and verifies resident and reopened text. Real direct-service and SDK-to-MCP readbacks exercise documents with and without paragraph ids, mixed operations, and published version contents. Assembled browser scenarios verify editing and delayed Agent-model replacement. The keyless `agent-whitespace` browser snapshot in `apps/web/tests/paperai-permissions.e2e.ts` has a scripted Agent edit a paragraph with full-width indentation and a double space on the assembled PaperAI app; the page shows the new text with both kept, and two later edits against the current head, one from the pre-edit reading and one from the reading without its indentation, are rejected with `NODE_TEXT_CONFLICT` and leave the version and file unchanged.

The native content-control fixture has no paragraph ids and fixes its whitespace-preserving index in a keyless snapshot. It covers full-width indentation, tabs, literal newlines, mixed edits after the content control, and byte-for-byte unchanged files after rejected stale operands. A second native fixture removes and anchors on hyperlink and field-result paragraphs by their indexed text, and anchors and replaces again after a split within one batch. A third removes and anchors on paragraphs with an inline equation, a hyperlink around an inserted revision, a smart tag around a hyperlink, a carriage return, and a table, and rejects the equation paragraph's editable-text-only reading as stale. A fourth removes and anchors on directly numbered, bulleted, and style-numbered paragraphs by their marker-prefixed indexed text, and rejects the marker-free reading as stale.

## Consequences

Multiple edited blocks share one document read and file-backed write. Word properties outside the toolbar remain preserved rather than becoming new controls. Drawing, equation, field, and symbol editing still requires Word when embedded in the target paragraph. Draft persistence and final Word pagination remain outside this change.
