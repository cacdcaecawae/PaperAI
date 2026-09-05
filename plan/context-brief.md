# Context Brief

Last updated: 2026-09-05

## Current delivery

The five accepted Agentero adaptations are implemented on `codex/paperai-agentero-workbench`. The inherited UI overhaul was rebased onto PaperAI main `22f08a884a` as `c4c980aad8`; the current PR includes that preserved implementation and the September 5 changes. The [task packet](task-packets/2026-09-05-agentero-adoption.md) owns acceptance, and the [review](review/2026-09-05-agentero-adoption.md) records current evidence and limitations.

PaperAI uses the full DSH/Cordis platform. Projects and documents occupy the left column, Word the center, and Agent the right. Word remains authoritative DOCX through OfficeCLI; browser previews and unsaved drafts remain temporary views. Template sets, document types, and formats follow [CONTEXT.md](../CONTEXT.md) and the [template-model decision](../.agents/notes/implemented/architecture/2026-09-03-paperai-template-model.md).

## Implemented behavior

- Agent selection immediately displays pending intent and keeps the composer editable. Session binding survives Host replacement, model operations wait for replacement, and sends remain blocked until readiness. Consecutive picks settle to the latest intent without changing another project's Session.
- Word selections create removable references with exact text, document, path, revision, head, and block identities. The same frozen content reaches the model and session log; the user sees a quotation with optional source disclosure.
- Recent previews have a configurable retention budget, including the active document. Scroll positions and lightweight drafts survive document navigation. Conflicting external block edits retain the draft and disable stale saving.
- Independent ACP diagnostics inspect cached metadata or run an explicit prompt-free probe with bounded time, cooldown, and teardown. Historical models never authorize current model selection.
- Project Doctor scans registered artifacts without writing. A reviewed missing-file repair verifies the current head and snapshot and publishes without overwriting an existing file or adding a content version.

## Validation and remaining limits

The [current review](review/2026-09-05-agentero-adoption.md) separates focused service tests, real assembled browser replay, and static/build gates. Earlier release-wide counts in [progress.md](progress.md) describe their dated revisions, not the current tree. Browser scenarios use controlled ACP adapters and real isolated DOCX projects; no real-provider response-time claim follows from them. Agentero was reviewed at commit `7c5efcd1fbab0c5bd14969acdaa437912beb4b93`, without running its desktop application.

The user authorized a pull request, not a merge. Do not change personal Agent settings, write to the user's existing projects, or republish main while completing that delivery. Real school-document acceptance and distribution hardening remain later work.

## Historical recovery pointers

- Legacy commit: `c908361ecdc9dc9d1517d7382e5c7eb8f0c1aa48`.
- Legacy branch: `legacy-standalone-local`.
- Bundle: `F:\Papel-agent-legacy-20260828.bundle`.
- Source archive: `F:\Papel-agent-legacy-20260828.zip`.
