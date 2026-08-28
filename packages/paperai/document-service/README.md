# `@paperai/document-service`

English | [中文](README.zh.md)

PaperAI document service exposed as `ctx.paperDocuments`. It imports Word sources into a project, keeps an immutable source snapshot separate from the authoritative Working DOCX, builds an ordered semantic node index through `ctx.documentEngine`, and serves generated HTML preview.

## Service API

- `importDocument(request, signal?)` accepts `.docx` and `.doc`. A successful result contains the durable document record and complete node index. Capability failures return `{ status: 'degraded', capability, health, detail }` and publish no document record.
- `rollbackImport(documentId)` removes a Working import that has not acquired a head commit. Cleanup cannot be cancelled, deletes the service-owned immutable and Working copies plus their index, and never deletes the original source supplied to `importDocument`.
- `listDocuments(projectId, role?)` returns deterministic project records with an optional exact role filter.
- `readDocument(documentId)` returns repository metadata and ordered nodes without reading Word bytes again.
- `verifyImmutableSource(documentId, signal?)` verifies that the imported source remains a read-only regular file whose bytes match the recorded SHA-256. Consumers call it before reading or copying source bytes.
- `previewHtml(documentId, signal?)` renders the current Working DOCX. HTML remains preview-only.
- `rebuildIndex(documentId, signal?)` re-reads the Working DOCX and replaces its semantic index without creating a document commit.

## File and index semantics

Imports use private same-filesystem staging below `<project>/.paperai/documents/v1`. The immutable source is copied to an exclusive final path, hashed against the staged bytes, and made read-only before its record is published. The Working DOCX is an independent writable file; editing either file cannot change the other. Conflicting names receive ` (2)`, ` (3)`, and later suffixes. Node identity is retained first by semantic hash, then related text and Office-path evidence; retained nodes keep lineage, style metadata, and last-commit attribution.

The current pinned OfficeCLI supports `.docx`, `.xlsx`, and `.pptx`, not legacy binary `.doc`. A document-engine Provider may implement `LegacyDocumentNormalizer`; otherwise `.doc` import returns the explicit `legacy-doc-normalization` degraded result. The service never reports a `.doc` import as successful without a newly produced non-empty DOCX.

The service writes no commit history. The document-commit package owns mutations, snapshots, actor/model provenance, and calling `rebuildIndex` after a completed Working DOCX change.

## Model Experience

### Document service state

#### What the model sees

The model sees nothing from `ctx.paperDocuments` directly. PaperAI commands and MCP tools decide which document records, nodes, previews, and degraded results become model-visible.

#### Token effect

Zero direct tokens. A Consumer that projects service data into a request owns and documents those tokens.

#### KV Cache effect

None directly. Repository or preview changes do not affect a model request until a Consumer projects them.

## Known Limitations and Deferred Work

- Text-node reads do not provide complete style or parent metadata. Rebuilds retain known style data for matched nodes; new nodes start with an empty style record.
- File publication and repository writes cannot share one filesystem/SQLite transaction. The service publishes files first, rolls back failed repository writes, and may leave unreferenced files only after a process crash between those durability points.
- Legacy `.doc` support remains degraded until the configured document engine implements `LegacyDocumentNormalizer`.
