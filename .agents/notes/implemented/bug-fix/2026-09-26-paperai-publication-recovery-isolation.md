# Agent Note: Isolate document publication recovery and flush published bytes

Status: implemented

English | [中文](2026-09-26-paperai-publication-recovery-isolation.zh.md)

## Problem

A retained publication may encounter an externally edited Working DOCX or unavailable project. Failing service initialization makes every project unavailable. Import cleanup can also delete the files and document record named by an unresolved journal. Atomic filesystem publication alone does not ensure that snapshot and Working bytes survive power loss.

## Decision

The [commit service](../../../../packages/paperai/commit-service/README.md) attempts each startup recovery independently and logs failures. It retains unresolved journals and retries recovery at the affected document's FIFO; unrelated documents remain usable. The [document service](../../../../packages/paperai/document-service/README.md) writers, import rollback and index rebuild, refuse any document with a retained publication journal with `PUBLICATION_PENDING`.

Publication flushes temporary file bytes before linking snapshots or replacing Working DOCX. Supported platforms sync containing directories and every snapshot ancestor through the project root, because an existing directory may have been created by a publication that has not synced it yet. A corrupt regular snapshot can be atomically replaced from caller bytes verified against the same digest. Unknown Working bytes, symlinks, and non-regular snapshots remain protected from automatic replacement. Read-only Project Doctor inspection retains its existing recovery policy.

## Alternatives considered

**Fail all service initialization.** It protects unknown bytes but unnecessarily prevents work on unrelated documents; per-document admission enforces the same protection.

**Delete unresolved journals or imports.** This removes the durable evidence and files needed to recover a failed publication.

**Reject every corrupt existing snapshot.** Verified bytes already held by publication can repair the same content address without inventing historical content.

## Consequences

Focused recovery tests retain one unrecoverable journal while recovering and committing another document, verify import rollback and index rebuild preserve pending publication data, sync snapshot ancestors when the bucket already exists, and exercise snapshot repair and publication flush ordering. Windows flushes file bytes but Node does not support directory fsync there. Unknown publication state still requires repair before that document accepts new work.
