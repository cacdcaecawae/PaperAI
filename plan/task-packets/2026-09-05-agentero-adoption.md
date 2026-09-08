# Agentero architecture adoption

Last updated: 2026-09-05

## Authorized outcome

Implement the five transferable ideas accepted by the user in the current workspace and open a pull request against PaperAI main. Preserve the completed UI overhaul and the complete DSH platform. The reference is Agentero commit `7c5efcd1fbab0c5bd14969acdaa437912beb4b93`; adapt its separation of concerns without importing its Tauri shell or replacing the Word engine.

## Deliverables

1. Responsive Agent switching: publish the user's pending selection immediately, preserve an editable composer, gate submission until the selected Agent is ready, and prevent stale asynchronous completion from overwriting newer intent. Cached model metadata is visibly distinct from a live session's selectable models.
2. Explicit Word selection context: capture document, version, block, and exact selected text; display removable context before submission and record the frozen context with the submitted user message.
3. Document-centered workspace: documents on the left, Word in the center, Agent on the right; retain a bounded set of recent document previews with scroll and drafts, and hydrate secondary panels only when opened.
4. Independent Agent diagnostics: discover configured adapters, probe ACP without a prompt, report readiness and version or actionable failure, deduplicate concurrent probes, and apply configurable failure cooldown and timeout with quiescent teardown.
5. Project Doctor: read-only integrity scan, explicit repair candidates, and guarded recoverable repair of missing working copies from retained version snapshots. Report missing originals, missing snapshots, duplicate ownership, and unsafe paths without destructive automatic cleanup.

## Acceptance

Focused service and client tests cover concurrency, stale results, context freezing, cache eviction and draft retention, and diagnostic/repair failure cases. Real assembled browser scenarios cover switching with an editable draft, selected context, document navigation, layout, and project diagnostics. Run affected type, lint, documentation, build, and artifact checks before publishing. Record measured evidence and remaining limits; do not describe adapter startup benchmarks as end-to-end UI measurements.

## Current state

All five deliverables are implemented. The inherited rebase preserves the complete UI overhaul as commit `c4c980aad8`; the current branch is `codex/paperai-agentero-workbench`. The [review](../review/2026-09-05-agentero-adoption.md) records validation and the scope of the pull request.
