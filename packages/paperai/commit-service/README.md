# @paperai/commit-service

English | [中文](README.zh.md)

Recoverable document version service for PaperAI. `PaperCommitService` owns `ctx.paperCommits` and is the only supported path for human or Agent changes to an authoritative Working DOCX. A successful `submit()` or `revert()` has already applied the change and advanced the document head; no separate user confirmation is required.

## Service: `PaperCommitService` (`ctx.paperCommits`)

The service requires `paperRepository`, `documentEngine`, and `paperDocuments`.

- `submit(request)` applies an ordered mutation batch and returns the new `DocumentCommit` after publication.
- `revert(request)` restores one reachable snapshot as a new child commit instead of moving the head backward.
- `getCommit(commitId)` reads one isolated commit object by id.
- `listHistory(documentId)` follows `headCommitId` and `parentId` from newest to oldest, excluding unreachable recovery objects.

`submit()` requires a non-blank message and at least one mutation. `baseCommitId` must equal the current head; omission is valid only before the first commit. `revert()` requires the caller's current head and a different target reachable from that head.

Compiled mutations cover `replace-text`, `insert-node`, `delete-node`, `bind-template`, `unbind-template`, `set-document-type`, and `milestone`. `bind-template` runs `paperTemplates.validateAssociation()` with the document type the same commit switches to; `unbind-template` fails on a document with no bound template; `set-document-type` fails when the type is unchanged and, unless the same commit binds another template, records an `unbind-template` operation first because a bound format applies to one type. The published `DocumentRecord` carries the resulting type and template binding.

## Publication and Recovery

Each document has one in-process FIFO. The service copies the Working DOCX to a private project-local candidate, compiles supported domain mutations to Office-path mutations, asks `documentEngine` to save and validate that candidate, and asks `paperDocuments` to rebuild its semantic index without publishing it.

Before touching authoritative state, publication durably stores one per-document write-ahead record. It contains the immutable commit, exact before/after document and node states, and a content-addressed snapshot of the original Working DOCX. Publication then stores the commit object, atomically replaces the Working DOCX, replaces the node index, updates `DocumentRecord.headCommitId`, and clears the journal. The head update remains the publication point.

Service initialization recovers every retained journal before accepting work, and each FIFO operation rechecks its document before honoring caller cancellation. A journal whose head is still the recorded parent rolls back the Working DOCX and node index. A journal whose head is the recorded commit completes that commit and clears the journal. Recovery accepts only the recorded original or candidate Working SHA-256 and only node values from the journal's before/after states; an unknown head, file, node, snapshot, or conflicting commit raises `RECOVERY_FAILED` or the applicable snapshot failure and retains the journal without overwriting the unknown data.

An in-process publication failure runs the same recovery. A failure before the head update rejects after rollback. If the backend stored the head before reporting failure, recovery completes the commit and the original operation succeeds. Independent Working DOCX and node rollback attempts both run; an incomplete recovery rejects with `AggregateError` and leaves the durable journal for startup or the next operation.

The service compares both the base head and the captured Working DOCX SHA-256 immediately before publication. A stale head raises `HEAD_CONFLICT`; a file changed outside the commit path raises `WORKING_COPY_CHANGED` instead of overwriting it.

Caller cancellation is admitted while work waits in the FIFO and throughout candidate staging. Once durable publication begins, the operation completes publication or rollback before settling.

## Document Index Peer

The service consumes the structural `PaperDocumentIndexPeer` at `ctx.paperDocuments`. `readNodes(documentId)` returns the current stable index. `buildCandidateIndex(request)` inspects the temporary candidate and returns nodes stamped with the supplied document and commit ids; it must not publish those nodes or mutate the authoritative Working DOCX. Its distinct name prevents accidental use of an authoritative index-rebuild operation during staging.

This interface lets `@paperai/document-service` own Office-path parsing, semantic identity reconciliation, node hashing, and index reconstruction without copying those rules into the commit service.

## Snapshots and History

DOCX snapshots are project-local content-addressed objects under `.paperai/objects/docx/<prefix>/<sha256>.docx`. Publication creates the final object only after all bytes are written, verifies an existing object before reuse, and never mutates an object in place.

A rolled-back publication can leave an unreachable commit or snapshot object, including the original Working image retained for first-commit rollback. `listHistory()` exposes only the parent chain reachable from the current document head. `getCommit()` deliberately permits direct recovery inspection when an object id is known.

`revert()` verifies the target snapshot path and SHA-256, validates and reindexes a private copy, restores the target commit's template binding while keeping the document's current type, then creates a new commit whose parent is the current head. The restored bytes may reuse the target's content-addressed snapshot while actor and operation provenance remain unique to the revert commit.

## Provenance and Failures

Every commit retains the supplied `ActorIdentity` without inferring a model from process state. Agent commits require non-blank `client`, `model`, and `sessionId` fields; human and system actors retain any supplied client, provider, model revision, session, and run fields.

Expected caller failures use `PaperCommitError.code`. `DocumentHeadConflictError` retains expected and actual heads, while `DocumentValidationError` retains structured Office validation evidence. `RECOVERY_FAILED` means the service could not prove that the current state belongs to either side of a retained journal. A publication failure whose recovery also fails rejects with `AggregateError` containing both outcomes.

## Model Experience

### Durable document commit

#### What the model sees

No content is added directly. Agent-facing consumers may render the returned `DocumentCommit`, but they own that rendering.

#### Token effect

Zero direct tokens; the service does not add prompts, messages, tool schemas, or tool results.

#### KV Cache effect

None; document commits do not assemble or send provider requests.

## Known Limitations and Deferred Work

- **Mutation coverage** — the current document-engine interface applies text replacement, paragraph insertion, and node deletion. `set-style` and `set-fact` fail explicitly until their owning services expose executable operations; snapshot restoration must use `revert()`.
- **Process scope** — FIFO ordering is per Host process. The head and file fingerprint checks reject observed outside changes, but independently running Hosts do not share a writer lock.
- **Unreachable storage objects** — the repository has no multi-record transaction or commit-object deletion operation, so publication failure after object storage can retain unreachable commits and snapshots for later garbage collection.
