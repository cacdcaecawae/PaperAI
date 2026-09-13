# Agent Note: preserve Word metadata and original edit targets

Status: implemented

English | [中文](2026-09-13-paperai-word-edit-preservation.zh.md)

## Problem

Rebuilding a paragraph from the browser's editable fields loses Word properties that the preview cannot represent. Rejecting those properties instead blocks ordinary Chinese templates, including runs with East Asian font hints. Positional addresses can target an inserted paragraph after an earlier structural edit, even though the commit records a different semantic node. Reading and parsing the full document before every replacement adds latency to multi-paragraph saves.

## Decision

The OfficeCLI Provider reads document XML once under its existing file lease and binds every original Office path to an XML node before applying mutations in caller order. References stay attached through insertions and splits; using a removed node rejects the batch before writing. Workbench, direct service, and MCP callers share this rule regardless of ordering or `paraId` availability.

Character differences reuse original run properties for surviving text. Insertions inherit nearby properties, replacements inherit the start of the replaced range, and empty paragraphs retain a character seed. Explicit formatting overrides represented fields; omitted fields retain metadata. The browser explicitly restates cleared values across all affected runs. Bookmarks and pagination markers retain text-relative positions; split paragraphs inherit layout, with section properties on the final replacement. Unsupported editable objects still reject replacement.

A private JSON file carries one OfficeCLI `batch --input` command replacing the body through `/word/document.xml`, followed by save. The batch summary and individual result must confirm that the operation executed successfully; a zero process exit code alone cannot authorize publication. The `/document` write alias is unsuitable: its typed parser renames legacy indentation attributes, changing physical edges in bidirectional paragraphs. The standard package part preserves those attributes and unaffected subtrees. The file avoids Windows argument limits and is removed after success or failure. Explicit style changes resolve names through one additional styles read.

The paragraph-style menu reads the document's defined IDs and display names through the engine, document service, and workbench snapshot. It submits stored IDs, with exact IDs taking precedence over colliding names. The absent optional styles part yields no choices; malformed styles still fail the engine read. Workbench catalog failures yield an empty, disabled menu without failing document opening or a completed commit. Deferred commit replies preserve the browser's previous catalog until refresh. The menu says “Apply style” when no draft selection exists, because the preview does not identify each paragraph's current style.

This partially supersedes engine reconstruction and run inheritance in [character formatting](../feature/2026-09-10-paperai-character-formatting.md), and addressing and protection in [writing workflow](../feature/2026-09-12-paperai-writing-workflow.md). Their browser interaction, transport validation, draft, and transaction decisions remain active. Parsed XML is an operation-local projection of the candidate DOCX, with no persisted or browser-owned document authority.

## Alternatives considered

**Allow more run properties through the reconstruction whitelist.** Typing becomes possible but run splits and merges still discard metadata.

**Sort every caller's mutations backwards.** General batches have meaningful insertion, deletion, and repeated-reference order. Binding original nodes preserves that order and protects alternate callers.

**Read again after each structural operation.** Repeated parsing adds latency and still needs original identity tracking. One bound projection meets both requirements without a long-lived cache.

<a id="word-edit-tests"></a>

## Testing

Unit tests verify metadata mapping, empty paragraph inheritance, explicit clearing, markers, section order, original-node references, file cleanup, and one document read per batch. The native Windows CI test requires OfficeCLI 1.0.145, edits the real HIT proposal template, compares untouched XML subtrees, checks bidirectional legacy indentation, and verifies resident and reopened text. Real direct-service and SDK-to-MCP readbacks exercise documents with and without paragraph ids, mixed operations, and published version contents. Assembled browser scenarios verify editing and delayed Agent-model replacement.

## Consequences

Multiple edited blocks share one document read and file-backed write. Word properties outside the toolbar remain preserved rather than becoming new controls. Drawing, equation, field, and symbol editing still requires Word when embedded in the target paragraph. Draft persistence and final Word pagination remain outside this change.
