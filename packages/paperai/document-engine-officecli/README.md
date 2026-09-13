# `@paperai/document-engine-officecli`

English | [中文](README.zh.md)

OfficeCLI Service Provider for `ctx.documentEngine`. Each mutation batch reads and parses `/document` once, binds every original Office path to its XML node, and applies mutations in caller order. Insertions, splits, and removals cannot redirect later original-node references, including documents without `paraId`. A reference removed earlier in the batch rejects the edit before writing. Explicit paragraph style changes additionally read `/styles` once to resolve style names and ids.

`readParagraphStyles()` reads `/styles` through the same file lease and parser used by style mutations. Only defined paragraph styles are returned; missing display names use the stored ID, and an absent styles part returns no choices. Exact IDs take precedence over colliding names, and unknown styles reject before writing.

Text differences retain each surviving character's original run properties. Inserted text inherits the surrounding run, or the replaced range's first run; empty paragraphs retain their character defaults. Explicit character values override the supported fields, while omitted values preserve original properties. East Asian font hints, per-script fonts, kerning, spacing, and other opaque run properties survive edits. An explicitly supplied font or size equal to its original displayed value preserves script-specific details. Browser clients restate cleared fields explicitly on every affected run.

Bookmarks, proofing markers, and manual or rendered page breaks retain their positions relative to edited text. Split paragraphs inherit paragraph properties; a section boundary remains on the last replacement paragraph. Paragraph format overrides cover existing styles, alignment, indentation, and line spacing. Fields, symbols, drawings, formulas, and other unsupported inline objects reject text replacement; unchanged paragraphs and other document parts remain in the candidate. OfficeCLI can normalize XML serialization and paragraph ids when saving; preservation is checked by document semantics rather than ZIP byte identity.

Plain and formatted edits share one `batch --input` call containing `raw-set` on `/word/document.xml`, followed by `save`. The Provider requires the batch summary and individual result to confirm complete success, rejecting failed, skipped, or missing operations even when the process exits with code zero. The private command file carries the modified body without exposing document text in process arguments or hitting Windows command-line limits, and is removed after success or failure. The parsed XML exists only within the file lease; Working DOCX and the commit service's candidate/version transaction remain authoritative. Vertical tabs encode soft breaks; line feeds in an unstructured replacement create paragraphs.

Every invocation sets `OFFICECLI_SKIP_UPDATE=1`, the pinned binary's update-check opt-out. This keeps document operations independent of background binary replacement and installed-skill refresh.

All reads and writes for the same file path share a FIFO lease. The Provider resolves the pinned npm launcher or explicit executable, runs it through DSH `ctx.subprocess`, and bounds time and captured output. The resident document stays open between leases until `residentIdleMs`, explicit `release(filePath)`, or disposal. Commit publication releases it before replacing files. Close cleanup uses an independent signal and deadline. Native failures retain stdout/stderr through `OfficeCliError` without exposing a general command runner to consumers.

`normalizeLegacyDocument()` adds the optional structural normalizer consumed by `@paperai/document-service`. On Windows it starts the configured PowerShell executable directly through `ctx.subprocess` and runs the packaged Word COM program without a command shell. Microsoft Word opens the source `.doc` read-only and writes a separate DOCX; the source is never saved or replaced. Non-Windows hosts, a disabled or unresolved PowerShell command, and unavailable Word COM return an explicit degraded result.

The converter defaults to `powershell.exe` on Windows. Set `legacyDocPowerShellCommand` to another executable name or absolute path, or to `false` or an empty string to disable `.doc` normalization. `legacyDocTimeoutMs` defaults to 120000, `legacyDocOutputMaxBytes` to 1048576 per stream, and `legacyDocTerminateGraceMs` to 5000. All three limits must be positive safe integers.

`cleanupTimeoutMs` defaults to 5000 and must be a positive safe integer. It bounds each independent best-effort `close` command. `residentIdleMs` defaults to 2000 and must be a positive safe integer: the idle time after the last operation before a resident document is closed. While a document is resident, other programs can read and write it in place but cannot rename, replace, or delete it, so the window stays short and the engine releases a file before its own replace or delete.

Cancellation, timeout, output truncation, non-zero conversion failures, and missing or invalid DOCX output throw `LegacyDocConversionError` with a stable `code`. Every unsuccessful attempted conversion unlinks the generated target; an existing target is rejected before process start and is not overwritten. A cleanup failure is reported with the primary conversion failure instead of hiding either outcome.

## Verification

Native regression tests run with `DSH_PAPERAI_OFFICECLI_REAL=1` in the Windows CI job and require the pinned binary version. `DSH_PAPERAI_OFFICECLI_COMMAND` selects an isolated executable for local verification; package version alone does not prove the installed binary version.

## Model Experience

### OfficeCLI operation results

#### What the model sees

The Provider adds no model context itself. Consumers may project results from `readTextNodes`, structured inspection, validation, or mutation failures; those consumers own filtering and rendering.

#### Token effect

Zero direct tokens. Captured OfficeCLI output remains Provider diagnostics unless a consumer deliberately includes a bounded result or error in model-visible content.

#### KV Cache effect

The Provider makes no model request. Changes to a Working DOCX affect cache reuse only when a consumer emits changed document facts in a later request.

## Known Limitations and Deferred Work

- The first Provider is local-process only; remote OfficeCLI execution would be a separate Provider.
- The lease key is the supplied path. The document service must canonicalize Working DOCX paths before calling this seam so aliases cannot form parallel queues.
- Preview output exceeding the configured bound fails explicitly rather than returning truncated HTML.
- Legacy `.doc` normalization requires desktop Microsoft Word registered for the configured process identity; LibreOffice and server-side Word conversion are not fallback paths.
