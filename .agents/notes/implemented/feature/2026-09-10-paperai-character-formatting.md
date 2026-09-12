# Agent Note: character formatting from the page into the DOCX

Status: implemented

English | [中文](2026-09-10-paperai-character-formatting.zh.md)

Partially superseded: the [writing-workflow decision](2026-09-12-paperai-writing-workflow.md) owns the persistent toolbar, fonts, structural drafts, and protected content. Run inheritance and clearing below remain active.

## Problem

Blocks could be written into but only as plain text. Every browser commit compiled to `set <paragraph> --prop text=`, which OfficeCLI answers by replacing the paragraph with one implicit run, so a paragraph that carried a bold lead-in or a red phrase lost it the moment anyone corrected a typo in it. Nothing in the product could make text bold or change its size, and the writer's own request was for exactly that.

## Decision

`replace-text` gained an optional `runs`: the block's text split where its character formatting changes, each run stating only what it overrides in its block (`bold`, `italic`, `underline`, `size` in points, `color`). The same shape travels the whole path — `DocumentTextRun` in the domain, `EngineTextRun` at the engine contract, `PaperAIDocumentTextRun` on the workbench transport — because those layers already restate the mutation rather than share it. A commit whose text is unchanged is admitted when runs are present, so formatting alone is a version; its message reads 排版 rather than 修改. The runs must spell exactly the mutation's `nextText`, which the commit service enforces.

OfficeCLI rebuilds the paragraph: set its text, state the first run's overrides on `r[1]`, append the rest. That is several operations, so runs travel as one `batch` invocation instead of one process round trip each — a warm command costs about 380 ms, and a three-run paragraph would otherwise pay four of them. Plain text keeps the single `set` it has always used, so a commit that changes no formatting costs exactly what it did before.

The browser reads a block the way Word stores it. The Host already renders every run as a `<span>` with inline styles, so `runsOf` walks the block's text nodes, reads each one's resolved style against the block's own, and merges neighbours that read alike; a block with no override serializes to one run and commits as plain text. Selected text is formatted by wrapping it in a span stating the change and clearing that same declaration inside it, so the value that reads is the new one. Blocks are `contenteditable` rather than `plaintext-only` now, so a paste is intercepted and inserted as its text alone. The formatting controls sit in the selection bar that already offers 交给 Agent, and Ctrl/Cmd+B, I, and U do the same from the keyboard.

Two rules follow from where the formatting actually lives. A declaration stated above the selected text cannot be turned off from inside it — text decoration draws onto descendants without inheriting at all — so a change first takes that declaration off every element between the block and the selection, keeping it on the text to either side. And because OfficeCLI leaves a paragraph's first run in place when the paragraph's text is set, that run carries whatever it had: the browser states back, from the block's own reading, anything the first run used to state and no longer does, or the rebuild would keep it.

## Alternatives considered

**Keep the plain-text path and add a paragraph-level bold.** OfficeCLI applies a paragraph-level `bold` to every run at once, which cannot express a bold phrase inside a sentence — and the run rebuild that expresses it also fixes the formatting loss the plain path already had, so the smaller step would have been thrown away.

**Send only the runs the writer touched, addressed by their original index.** It would preserve every property PaperAI does not model, but splits and merges make the addressing a diff problem in the engine. Rebuilding from the page is one rule; the properties at risk are those the rendered preview does not express, and the previous behaviour lost all of them.

**Read the runs from inline styles rather than resolved ones.** The Host's stylesheet sets character properties by rule as well (page bands, table-of-contents links), so an inline-only reading would misstate them. Resolved styles cost nothing here: the page's zoom does not scale the reported font size, so points convert from pixels directly.

**`document.execCommand`.** It splits and merges ranges for free, but its behaviour inside a shadow tree is unspecified and it is deprecated; the wrap-and-clear rule is about twenty lines and does exactly one thing.

## Testing

Unit coverage: reading a block as runs, including a run that turns its block's own formatting off, comparing runs so an untouched block keeps no draft, writing runs back as spans, and painting a formatted commit into the preview already on screen; the OfficeCLI batch a run rebuild produces beside the single command plain text keeps; the commit service admitting a formatting-only change and rejecting runs that do not spell the mutation's text; and the page reporting a bolded and resized selection as runs. A browser test bolds and resizes a paragraph, saves it, and reads the run properties back out of the re-rendered preview, so the OfficeCLI batch is exercised against a real document.

## Consequences

A paragraph's existing character formatting now survives an edit to its text, which it did not before. Formatting a run states its size in points on that run, so a later template change no longer moves it. A run appended by the rebuild inherits the paragraph mark's properties rather than the first run's, so a paragraph whose runs carried an East Asian font hint may lose it on the appended runs; the properties the rendered preview does not express — letter spacing, per-run typeface — are not carried at all. Adding a field to a Remote request requires regenerating the typert descriptors through the host build: the generated client schema drops what it does not declare, silently, and the Host then rejects the request as a no-op.
