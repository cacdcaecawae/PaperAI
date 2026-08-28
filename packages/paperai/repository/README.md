# `@paperai/repository`

English | [中文](README.zh.md)

PaperAI repository service (`ctx.paperRepository`) over DSH `storage-domain`. The product profile routes the versioned `paperai` domain to DSH's SQLite backend while the rest of the Web profile may continue using its existing storage route.

The repository owns runtime validation and typed tables for projects, documents, semantic nodes, recoverable commits, commit-publication journals, template contracts, and conflicts. Reads come synchronously from storage-domain's authoritative in-memory state; writes use its single durable queue and emit the standard `domain/changed` event only after the SQLite write lands.

`commit_publications` holds at most one write-ahead record per document. Each record contains the immutable commit, the publication's before/after document and node states, and the content-addressed Working DOCX image needed for rollback. `@paperai/commit-service` clears the record only after the head-selected state is complete.

The publication journal is an additive extension of the PaperAI v1 KV unit. On the first open of an existing v1 SQLite store, the storage backend creates the missing `commit_publications` table idempotently before loading the domain. The unit version stamp and every existing row remain unchanged; no user-state deletion or record rewrite is required.

## Model Experience

### Repository state

#### What the model sees

`ctx.paperRepository` adds no prompt, tool schema, or result. Commands and MCP consumers own every model-visible projection of projects, documents, commits, templates, and conflicts.

#### Token effect

Zero direct tokens. A consumer that reads and renders repository records owns the resulting token count and output bounds.

#### KV Cache effect

Repository writes do not reach a model request by themselves. Cache reuse changes only when a consumer projects changed records into later context.

## Known Limitations and Deferred Work

- Unit versions other than 1 remain incompatible and fail before records are changed.
- The SQLite backend is process-local and does not add multi-process writer arbitration.
