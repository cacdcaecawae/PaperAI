# Agent Note: PaperAI transient workbench state follows its owning revision

Status: implemented

English | [中文](2026-08-29-paperai-transient-state-lifetimes.zh.md)

## Problem

PaperAI keeps two kinds of non-durable workbench state: the browser's selected-node draft and the Host's latest template-gate report. Both must remain attached to the document revision from which they were derived.

The external-update banner allowed a dirty browser draft to be replaced by a newly committed document projection. Preserving the draft avoided data loss, but a same-node external edit still left the immutable buffer on the old revision: reloading repeated the conflict, committing was rejected as stale, and dismissing the banner did not establish a new base. Separately, keeping only one gate report per document removed revision-count growth but did not order concurrent producers. A delayed validation for revision R1 could replace the report cached by a later export for R2, leaving the current projection with no matching gate.

## Decision

Loading an external document version preserves a dirty selected-node draft. The controller reads the same node from the new head: when its Host text still matches the draft's original base, the controller updates the immutable buffer to the new revision and reapplies the browser-local draft. When the same node changed, the controller also advances the document and immutable node buffer to the external head, retains the local draft and external text as explicit conflict inputs, and blocks document actions until the user chooses the local text, the external text, or the currently edited merged text. Local and merged resolutions remain dirty against the latest external base and can be committed normally; the external resolution selects the already-durable head text and becomes clean. A reload consumes the exact external notification captured when the request starts, even when the authoritative open has already advanced further, while retaining a newer notification received in flight. A further external head preserves the current merge draft and repeats the same cancellable rebase. A clean workbench still reloads automatically after an external commit.

The Host gate cache retains at most one slot per document. Every validation or export records a unique claim and the revision from which it began. On an unchanged revision, only the latest claim can publish. A successful export that advances its source revision may replace a later claim that still began from the same source, because its report belongs to the new milestone; a gate operation begun from that milestone revision still fences the completing export. The exported milestone must also remain the current head. After commit, restore, or template association publishes a target revision, its continuation installs a target-anchored mutation fence only when the active slot still belongs to the old source revision. This prevents old work from repopulating the slot without overwriting a validation begun from the already-published target revision.

## Alternatives considered

**Allow destructive external reload after an informational warning.** An uncommitted draft has no recoverable version, so a warning does not prevent data loss.

**Require Commit or Discard before loading.** A commit against the old head is rejected once another Session has advanced the document, so this instruction offers no successful path for preserving the draft. Node-level rebase permits the non-conflicting case and exposes the conflicting case without overwriting either side.

**Keep the old revision while displaying both conflict texts.** The user could compare the inputs, but every resulting commit would still carry a stale base. Conflict resolution must first bind the browser buffer to the latest immutable node version.

**Retain gate reports for every revision.** The workbench exposes only the current document projection and durable commit history does not consume gate-cache entries. Historical retention would need a separate durable data model, not an unbounded process map.

**Accept any completion whose revision matches.** A blocked export and a continuous validation can race on the same revision. Revision equality alone cannot prevent the earlier operation from replacing the later user-visible result.

## Verification

Controller tests cover unchanged-node rebase, local, external, and merged same-node resolutions, commit requests against the latest base, a second external head during merge, cancellation of node reads, consumption of an older notification by a newer authoritative open, and preservation of a notification received in flight. Component tests expose both retained texts and all three localized actions while every conflicting document action remains disabled. A keyless browser scenario imports a real Working DOCX, creates an external commit through the Host, snapshots the conflict surface, merges the texts, and commits successfully. Deferred workbench-service tests settle validation and export promises in both orders across successful export, blocked export, a new-revision validation, and an externally advanced head. Additional deferred commit, restore, and template-association tests start validation after the target revision is published but before the mutation Promise settles. The current report remains attached to its owning revision and the cache retains no more than one slot per document.

## Consequences

Non-conflicting external commits can advance the open document without interrupting local editing. Same-node conflicts retain both inputs, rebase editing onto the latest head, and provide a commit-capable resolution without requiring manual copy, discard, and paste steps. Gate-report memory remains bounded by document count rather than revision or operation count, and delayed work cannot replace the report selected by a newer operation or mutation.
