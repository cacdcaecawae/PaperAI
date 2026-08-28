# `@paperai/export-service`

English | [中文](README.zh.md)

`ctx.paperExports` publishes checked DOCX files for the PaperAI Host UI and registers itself with `ctx.paperMcp.registerExportAdapter()` through a Cordis effect. The registration makes `paperai_export_document` available only while the provider is mounted.

## Configuration

- `maxExportBytes` bounds the immutable commit snapshot copied by one export. The default is 512 MiB.
- `overwriteExisting` controls replacement of an explicitly selected existing regular DOCX. It defaults to `true`; source documents, Working DOCX files, commit snapshots, symbolic links, and non-files remain protected regardless of this setting.

## Semantics

`exportDocument()` accepts both Host callers and the current `PaperMcpExportAdapter` request. It always runs `paperTemplates.check()` itself, so a report checked earlier by MCP cannot bypass current document state. Draft exports retain and return every finding. A delivery report for which `deliveryBlocked()` is true rejects with `DELIVERY_BLOCKED` before creating a commit, temporary file, or output.

An allowed export submits one `milestone` mutation through `paperCommits` using the head observed in the supplied `DocumentRecord`. Head movement rejects through commit-service optimistic concurrency. The commit receives the supplied human or Agent identity unchanged, including client, provider, model, revision, session, and run provenance.

The service publishes from the new commit's immutable `snapshotPath`, never from the Working DOCX. It verifies the size and SHA-256, copies to a random same-directory temporary file, synchronizes it, rechecks protected paths, and renames it into place. A failed publication removes the temporary file and leaves imported sources and Working DOCX files unchanged.

## Model Experience

### `paperai_export_document` availability and result

#### What the model sees

While this service and `@paperai/mcp` are mounted together, the MCP catalog includes `paperai_export_document`. Its result contains the output path, current template report, milestone commit, and recorded provenance; this package adds no prompt text.

#### Token effect

The conditional tool contributes one fixed schema. Successful and blocked calls add data-dependent result tokens for the report and commit; the MCP package owns transport-level result rendering.

#### KV Cache effect

The schema set remains stable while the export adapter is registered. Mounting or unmounting this service changes later MCP tool catalogs and can invalidate a reusable tool-schema prefix; the service retains no provider KV cache.

## Known Limitations and Deferred Work

- Destination parent directories must already exist. Directory selection and creation belong to the Host UI workflow.
- A filesystem failure after milestone publication leaves the recoverable milestone in history while returning an export failure; no output is reported as successful.
