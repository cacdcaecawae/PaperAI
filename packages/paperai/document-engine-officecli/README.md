# `@paperai/document-engine-officecli`

English | [中文](README.zh.md)

OfficeCLI Service Provider for `ctx.documentEngine`. A `replace-text` mutation carrying runs rebuilds its paragraph — setting the paragraph text, stating the first run's overrides, then appending the rest — and travels as one `batch` invocation rather than one process round trip per operation; plain text stays a single `set`. It resolves the pinned `@officecli/officecli` launcher (or an explicit command), runs every process through DSH `ctx.subprocess`, bounds execution time and captured output, suppresses OfficeCLI auto-update, and keeps the resident document process OfficeCLI starts for every command alive between leases so successive operations on one file skip the cold start. The resident is closed after `residentIdleMs` without work, on `release(filePath)` (which the commit service calls before it replaces or deletes the file), and when the Provider is disposed. Close cleanup uses an independent signal and a separate short deadline, so caller cancellation cannot skip it.

Every invocation sets `OFFICECLI_SKIP_UPDATE=1`, the pinned binary's update-check opt-out. This keeps document operations independent of background binary replacement and installed-skill refresh.

All reads and writes for the same file path share a FIFO lease. A mutation batch applies every Office-path operation, saves once, and releases the OfficeCLI document handle before returning. Failures retain stdout/stderr through `OfficeCliError` without exposing a general command runner to domain consumers.

`normalizeLegacyDocument()` adds the optional structural normalizer consumed by `@paperai/document-service`. On Windows it starts the configured PowerShell executable directly through `ctx.subprocess` and runs the packaged Word COM program without a command shell. Microsoft Word opens the source `.doc` read-only and writes a separate DOCX; the source is never saved or replaced. Non-Windows hosts, a disabled or unresolved PowerShell command, and unavailable Word COM return an explicit degraded result.

The converter defaults to `powershell.exe` on Windows. Set `legacyDocPowerShellCommand` to another executable name or absolute path, or to `false` or an empty string to disable `.doc` normalization. `legacyDocTimeoutMs` defaults to 120000, `legacyDocOutputMaxBytes` to 1048576 per stream, and `legacyDocTerminateGraceMs` to 5000. All three limits must be positive safe integers.

`cleanupTimeoutMs` defaults to 5000 and must be a positive safe integer. It bounds each independent best-effort `close` command. `residentIdleMs` defaults to 2000 and must be a positive safe integer: the idle time after the last operation before a resident document is closed. While a document is resident, other programs can read and write it in place but cannot rename, replace, or delete it, so the window stays short and the engine releases a file before its own replace or delete.

Cancellation, timeout, output truncation, non-zero conversion failures, and missing or invalid DOCX output throw `LegacyDocConversionError` with a stable `code`. Every unsuccessful attempted conversion unlinks the generated target; an existing target is rejected before process start and is not overwritten. A cleanup failure is reported with the primary conversion failure instead of hiding either outcome.

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
