# Agentero adoption review

Date: 2026-09-05

## Delivery and ADR status

The user accepted five architecture adaptations and authorized implementation in the current workspace followed by a pull request. The delivery branch is `codex/paperai-agentero-workbench`, based on PaperAI main `22f08a884a`. It includes the preserved UI overhaul `c4c980aad8` and the additional adoption work. Main's current CI checkout configuration and regression remain intact.

| Decision | Current implementation |
| --- | --- |
| [Product platform](../../.agents/notes/implemented/architecture/2026-08-28-paperai-product-profile.md) | Implemented: complete DSH/Cordis, authoritative Working DOCX, immutable sources, OfficeCLI, recoverable commits, template gate and export. |
| [Template model](../../.agents/notes/implemented/architecture/2026-09-03-paperai-template-model.md) | Implemented: library sets contain formats by document type; project decisions and deleted selections remain explicit. |
| [UI overhaul](../../.agents/notes/implemented/feature/2026-09-03-paperai-ui-overhaul.md) | Implemented: project start, document sidebar, shared templates and Word block editing. The September 5 decision supersedes layout and conflicting-draft disposal. |
| [Session replacement](../../.agents/notes/implemented/bug-fix/2026-09-03-session-replacement-reactivation.md) | Implemented and extended: reactivation preserves projection observers; a replacement lease now also preserves navigation and composer identity during the Host removal gap. |
| [Agentero adoption](../../.agents/notes/implemented/architecture/2026-09-05-paperai-agentero-adoption.md) | Implemented: all five accepted adaptations and their assembled acceptance scenarios. |

## Source comparison

The code review uses [Agentero commit 7c5efcd1](https://github.com/poco-ai/Agentero/tree/7c5efcd1fbab0c5bd14969acdaa437912beb4b93). Agentero combines a React frontend with Zustand state and a Tauri/Rust backend. Its Markdown-oriented workspace and PaperAI's academic DOCX workflow share project, document, and Agent interactions; their authoritative document engines differ. No Agentero desktop usage is claimed.

| Transferable idea | PaperAI implementation |
| --- | --- |
| Independent Agent discovery, cached advertisements, bounded probes and stale-result rejection | ACP diagnostics belong to the provider plugin. Empty-directory probes send no prompt and mount no project MCP descriptor. Cached models are historical observations. |
| Immediate Agent intent with asynchronous readiness | The preset seat serializes replacement and keeps only the latest pending choice. A runtime binding lease preserves the Session UI, a submission hold allows typing, and the gateway orders model requests after replacement. |
| [Frozen selection context](https://github.com/poco-ai/Agentero/blob/7c5efcd1fbab0c5bd14969acdaa437912beb4b93/src/lib/agent/turn-prompt.ts) | A removable composer reference freezes exact Word text and provenance. Existing logged user messages contain the complete model input. A product text slot shows a quotation with an optional source disclosure. |
| [Retained workspace hosts](https://github.com/poco-ai/Agentero/blob/7c5efcd1fbab0c5bd14969acdaa437912beb4b93/src/components/workspace/workspace-host.tsx) | A configurable recent-preview budget defaults to two including the active view. Scroll offsets and lightweight drafts survive eviction; secondary document panels load when opened. |
| [Vault Doctor](https://github.com/poco-ai/Agentero/blob/7c5efcd1fbab0c5bd14969acdaa437912beb4b93/crates/agentero-core/src/features/vault/doctor/mod.rs) | Project Doctor scans registered originals, working bytes, snapshots, ownership and containment. Only a reviewed missing working copy can be reconstructed from a verified unchanged head. |

Agentero's warm-up creates and closes an adapter session. It does not provide a reusable live process pool for PaperAI. Conversation processes, permissions, and project MCP capabilities remain isolated. The adaptation adds no Tauri, React major-version, Zustand ownership, or Word-engine migration.

## Behavior verification

Focused ACP, runtime, document, and layout checks passed 36 files / 643 tests. Subsequent model-operation and focus regressions passed 4 files / 151 tests; document-navigation and context regressions passed 3 files / 80 tests. These runs overlap and are not summed.

After adding the user-text presentation slot, this focused command passed 42 files / 604 tests:

`pnpm exec vitest run packages/client/ui-conversation/tests packages/client/ui-paperai-workbench/tests packages/client/ui-workflow-run/tests`

The final built browser replay passed 3 files / 22 tests:

`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/paperai-permissions.e2e.ts apps/web/tests/paperai-workspace-navigation.e2e.ts apps/web/tests/built-boot.snapshot.ts --reporter verbose`

The scenarios cover an editable composer during deliberately gated ACP initialization, rapid latest-choice selection, independent prompt-free diagnostics, four Claude/Codex model round trips, permission failures, cancellation, reasoning/fast-mode selection, external block conflicts, retained preview identity/scroll/draft, exact selected text in the durable message, and separate scan/review/recovery gestures. The narrow-to-wide transition asserts actual 280 px sidebar and 760 px Word column widths. A screenshot of the isolated fixture was visually inspected at 1680 × 1000.

The workspace-management fixture now enters project details to open its seeded Session and returns to the list for project actions. Its committed goldens are unchanged. This command passed all 12 tests and resolves the previously recorded nine cascading fixture failures:

`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-management.e2e.ts --bail 1 --reporter verbose`

## Build and publication checks

- Production build: `NODE_OPTIONS=--max-old-space-size=8192 pnpm run build` passed and recorded 204 client artifacts. The higher heap is required on this Windows host.
- `pnpm run hygiene` passed all 13 gates after the text-slot change, including built invariants, client packages, NodeNext consumers, optional imports and Knip.
- `pnpm run lint:contracts-ready` passed. `pnpm exec vitest run scripts/ci-workflow.spec.ts` passed all 18 tests. `pnpm run doc-sync` passed all 28 gates. The pre-push hook owns the final incremental typecheck.
- `pnpm --silent run change-scope --base origin/main` inspected the complete inherited and current diff against the fetched live base. `git diff --check` passed.

## Limits

Browser replay uses controlled ACP responses with real Host composition, isolated project directories, and actual DOCX operations. It establishes lifecycle and UI behavior, not production model quality or provider response time. No live school project or personal Agent configuration was modified. Agent startup still launches its native CLI; no end-to-end switching speedup is asserted. Unsaved drafts last for the browser lifetime. Recovery reconstructs verified committed working bytes and refuses changed heads, existing files, unsafe ancestors and invalid snapshots; it cannot recreate missing originals or absent snapshots.

The inherited Windows picker implementation has native API and built-worker evidence in the [September 3 review](2026-09-03-windows-picker.md); interactive desktop screenshot acceptance remains separate. Repository-wide coverage, the complete platform matrix and live-model e2e were not rerun for this PR. The PR is reviewable delivery and is not authorization to merge.
