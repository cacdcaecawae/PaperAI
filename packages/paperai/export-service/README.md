# `@paperai/export-service`

English | [中文](README.zh.md)

`ctx.paperExports` publishes checked DOCX files for the PaperAI Host UI and registers itself with `ctx.paperMcp.registerExportAdapter()` through a Cordis effect. The registration makes `paperai_export_document` available only while the provider is mounted.

## Configuration

- `maxExportBytes` bounds the immutable commit snapshot copied by one export. The default is 512 MiB.
- `overwriteExisting` controls replacement of an explicitly selected existing regular DOCX. It defaults to `true`; source documents, Working DOCX files, commit snapshots, symbolic links, and non-files remain protected regardless of this setting.

## Semantics

`exportDocument()` accepts both Host callers and the current `PaperMcpExportAdapter` request. It always runs `paperTemplates.check()` itself, so a report checked earlier by MCP cannot bypass current document state. Draft exports retain and return every finding. A delivery report for which `deliveryBlocked()` is true rejects with `DELIVERY_BLOCKED` before creating a commit, temporary file, or output.

Every caller, including a full-access Agent, publishes only inside the owning project's `exports/` directory. The provider resolves the project itself and checks the destination's real parent before the milestone and again before publication. A redirected `exports/` root or an escaping directory link fails with `DESTINATION_PROTECTED`; managed documents, templates, and history therefore cannot be export targets.

An allowed export submits one `milestone` mutation through `paperCommits` using the head observed in the supplied `DocumentRecord`. Head movement rejects through commit-service optimistic concurrency. The commit receives the supplied human or Agent identity unchanged, including client, provider, model, revision, session, and run provenance.

The service publishes from the new commit's immutable `snapshotPath`, never from the Working DOCX. It creates a random same-directory temporary file exclusively, keeps its handle open, copies the snapshot through that handle, verifies the size and SHA-256, synchronizes it, rechecks protected paths, and renames it into place. It then confirms that the destination's real parent is unchanged and that the destination is the file the handle holds (same device and inode); a publication redirected by a concurrent directory swap fails with `DESTINATION_PROTECTED`. A failed publication empties its output through the handle, never by path, removes the temporary file if it was not renamed, and leaves imported sources and Working DOCX files unchanged. A request that names a `writableRoot` (the MCP bridge passes the session workspace for every sandbox mode but full access) is confined at publish time on real paths: the destination's real parent directory must lie inside the real root, compared with the platform's case semantics (case folded only on Windows, so a case-sensitive filesystem keeps `paper` and `Paper` apart), so a directory link under the workspace cannot carry the file elsewhere; the check runs before the milestone commit and again before the rename, and rejects with `DESTINATION_OUTSIDE_WORKSPACE`.

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
- Publication is confined by path checks, not directory handles: Node exposes no `openat()` or `renameat()`, and Windows has no `O_NOFOLLOW`. If a process that can write inside `exports/` swaps an ancestor directory for a link between the last pre-publication check and the path walk inside `rename()`, the rename lands in the directory the link names. It succeeds only where the temporary file then is, so only in a directory that process can already write, and it replaces a same-named file there whatever `overwriteExisting` says: `rename()` always replaces its target, and that setting only gates the check made before the swap. The confirmation after the rename detects the escape, empties the output, and fails the export, but cannot restore a replaced file; being two path lookups itself, it can also be evaded by a process that toggles the link between them. The `FIXME:` in `publishSnapshot()` tracks this.
