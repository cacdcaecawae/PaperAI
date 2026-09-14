# Agent Note: separate preview formatting from Word edit intent

Status: implemented

English | [中文](2026-09-13-paperai-rendered-format-intent.zh.md)

## Problem

OfficeCLI's HTML can display a fallback font that differs from the stored Word run properties. A run containing only `w:hAnsi="宋体"` can display Times New Roman. Sending that unchanged display value while correcting text or applying bold silently overwrites the original font. A resolved browser style describes the preview, not a request to rewrite Word metadata.

Live drafts group replacement paragraphs under their original block. Reusing that grouping in a serialized committed preview can separate a paragraph's address from its text or concatenate heading text during HTML reparsing. Caret-placeholder breaks can also become real soft breaks when sanitization removes their marker. These changes can lose editable node mappings or alter the text used by subsequent edits while Host rendering is pending.

## Decision

Browser drafts retain complete rendered runs for repaint and undo, together with their initial and current character readings. Submission compares those readings and sends only changed character properties. Plain typing does not restate baseline fonts or sizes; bold-only changes do not restate unrelated fields. Cleared properties remain explicit when their rendered values changed. Selecting a value already displayed is a no-op, not an instruction to normalize hidden Word properties.

Character alignment uses the same insertion and replacement inheritance as the Word engine: inserted text follows adjacent original text, and replacements start from the replaced range. Empty paragraphs retain a formatting baseline. Leading empty splits inherit the first original run, including font slots and other properties absent from the preview. An empty split paragraph keeps a placeholder break inside its formatted span through initial insertion and draft repaint, so native typing retains that format; the placeholder is excluded from text. Paragraph splits keep original-block ownership and explicit paragraph layout; separator newlines do not become run text. The rendered baseline remains browser state and never enters the mutation RPC.

The temporary committed preview uses separate sibling copies of the original semantic block for each saved paragraph. Supplied runs and paragraph layout belong to those blocks, so reparsing preserves one matchable block per new indexed paragraph. Only the first copy keeps an existing HTML id. Serialization removes caret-placeholder breaks while retaining empty formatted spans and real soft breaks. Live draft grouping still belongs to the original indexed node. A delayed Host render at the committed revision replaces HTML only when no new draft exists in that document view; it cannot repaint newer work. Complex-content and cross-original-node editing protections remain unchanged.

This partially supersedes draft serialization in [character formatting](../feature/2026-09-10-paperai-character-formatting.md). Its selection editing and transport validation remain active. [Word edit preservation](2026-09-13-paperai-word-edit-preservation.md) still owns original XML properties, character inheritance, and transactional engine writes.

## Alternatives considered

**Transmit every resolved style.** Browser fallback values would become destructive overrides even when the user edits only text.

**Drop font and size from every request.** This protects baseline properties but prevents deliberate font and size changes.

**Treat repeated selection of the same value as metadata normalization.** The menu describes visible values; an unchanged choice does not express intent to replace per-script Word properties.

**Serialize the live draft grouping as the committed preview.** The grouping preserves original-node ownership during editing, but its nested block elements cannot represent independently indexed saved paragraphs through HTML reparsing. The temporary committed projection needs separate semantic blocks.

## Testing

Browser unit tests cover unchanged rendered fonts, isolated format changes, clearing, mixed runs, insertion, empty paragraphs, splitting, undo, and draft repaint. Component-to-controller tests inspect submitted mutations; assembled browser tests verify native input and saved Word XML. The native OfficeCLI 1.0.145 test edits text and applies bold to an `hAnsi`-only run, then verifies that its font, size, and remaining properties survive a close and reopen.

Committed-preview regressions reparse formatted paragraphs and split headings, distinguish repeated text, preserve table-cell placement, and exercise empty paragraph, run, and plain-text patches through the actual sanitizer and node mapping. Components continue editing the separately mapped saved paragraphs before Host rendering arrives; controller regressions retain newer drafts when that rendering completes.

## Consequences

Formatting shown by the preview remains useful for editing without becoming a second document authority. The browser preserves a richer local draft than the mutation it submits. Word properties outside the preview remain the engine's responsibility; the toolbar does not expose a command for normalizing them.
