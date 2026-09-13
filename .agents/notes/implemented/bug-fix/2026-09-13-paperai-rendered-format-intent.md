# Agent Note: separate preview formatting from Word edit intent

Status: implemented

English | [中文](2026-09-13-paperai-rendered-format-intent.zh.md)

## Problem

OfficeCLI's HTML can display a fallback font that differs from the stored Word run properties. A run containing only `w:hAnsi="宋体"` can display Times New Roman. Sending that unchanged display value while correcting text or applying bold silently overwrites the original font. A resolved browser style describes the preview, not a request to rewrite Word metadata.

## Decision

Browser drafts retain complete rendered runs for repaint and undo, together with their initial and current character readings. Submission compares those readings and sends only changed character properties. Plain typing does not restate baseline fonts or sizes; bold-only changes do not restate unrelated fields. Cleared properties remain explicit when their rendered values changed. Selecting a value already displayed is a no-op, not an instruction to normalize hidden Word properties.

Character alignment uses the same insertion and replacement inheritance as the Word engine: inserted text follows adjacent original text, and replacements start from the replaced range. Empty paragraphs retain a formatting baseline. Leading empty splits inherit the first original run, including font slots and other properties absent from the preview. An empty split paragraph keeps a placeholder break inside its formatted span through initial insertion and draft repaint, so native typing retains that format; the placeholder is excluded from text. Paragraph splits keep original-block ownership and explicit paragraph layout; separator newlines do not become run text. The rendered baseline remains browser state and never enters the mutation RPC.

This partially supersedes draft serialization in [character formatting](../feature/2026-09-10-paperai-character-formatting.md). Its selection editing and transport validation remain active. [Word edit preservation](2026-09-13-paperai-word-edit-preservation.md) still owns original XML properties, character inheritance, and transactional engine writes.

## Alternatives considered

**Transmit every resolved style.** Browser fallback values would become destructive overrides even when the user edits only text.

**Drop font and size from every request.** This protects baseline properties but prevents deliberate font and size changes.

**Treat repeated selection of the same value as metadata normalization.** The menu describes visible values; an unchanged choice does not express intent to replace per-script Word properties.

## Testing

Browser unit tests cover unchanged rendered fonts, isolated format changes, clearing, mixed runs, insertion, empty paragraphs, splitting, undo, and draft repaint. Component-to-controller tests inspect submitted mutations; assembled browser tests verify native input and saved Word XML. The native OfficeCLI 1.0.145 test edits text and applies bold to an `hAnsi`-only run, then verifies that its font, size, and remaining properties survive a close and reopen.

## Consequences

Formatting shown by the preview remains useful for editing without becoming a second document authority. The browser preserves a richer local draft than the mutation it submits. Word properties outside the preview remain the engine's responsibility; the toolbar does not expose a command for normalizing them.
