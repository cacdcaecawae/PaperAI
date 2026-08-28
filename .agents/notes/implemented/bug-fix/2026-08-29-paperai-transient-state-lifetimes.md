# Agent Note: PaperAI transient workbench state follows its owning revision

Status: implemented

English | [中文](2026-08-29-paperai-transient-state-lifetimes.zh.md)

## Problem

PaperAI keeps two kinds of non-durable workbench state: the browser's selected-node draft and the Host's latest template-gate report. Both must remain attached to the document revision from which they were derived.

The external-update banner allowed a dirty browser draft to be replaced by a newly committed document projection. The button named the version-loading action but did not require the user to commit or discard the unversioned draft first. Separately, each successful export created a milestone revision and cached its gate report under that revision without removing the preceding revision's entry. Repeated exports therefore retained reports that no caller could read.

## Decision

Loading an external document version preserves a dirty selected-node draft. The controller reads the same node from the new head: when its Host text still matches the draft's original base, the controller updates the immutable buffer to the new revision and reapplies the browser-local draft; when that node changed or disappeared, it keeps the old projection and draft and reports a conflict. A clean workbench still reloads automatically after an external commit.

The Host gate cache retains one entry per document. Each entry stores the revision and report. Projection returns the report only when the current document revision matches; validation, blocked delivery, and successful export replace the document's entry, while document mutations delete it.

## Alternatives considered

**Allow destructive external reload after an informational warning.** An uncommitted draft has no recoverable version, so a warning does not prevent data loss.

**Require Commit or Discard before loading.** A commit against the old head is rejected once another Session has advanced the document, so this instruction offers no successful path for preserving the draft. Node-level rebase permits the non-conflicting case and exposes the conflicting case without overwriting either side.

**Retain gate reports for every revision.** The workbench exposes only the current document projection and durable commit history does not consume gate-cache entries. Historical retention would need a separate durable data model, not an unbounded process map.

## Verification

Controller and component tests prove that a dirty external reload rebases an unchanged node without changing the draft, and preserves the old projection and draft when the same node changed externally. The workbench-service export test performs consecutive milestone exports and verifies that only one gate-cache entry remains for the document.

## Consequences

Non-conflicting external commits can advance the open document without interrupting local editing. Same-node conflicts remain explicit and retain the local draft until the user resolves or discards it. Gate-report memory is bounded by the number of documents observed by the Host rather than the number of revisions or exports.
