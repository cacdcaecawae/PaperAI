# Context Brief

Last updated: 2026-09-03

## Current stage

The PaperAI UI overhaul is implemented with focused local validation on `feat/paperai-ui-overhaul`. The branch still contains the inherited uncommitted implementation and the completion fixes from this handoff. The August release evidence belongs to that earlier baseline; see [progress.md](progress.md) for its history.

The current UI has a project start page, a shared template library, a document-only sidebar contribution, and editing inside the Word preview. Template formats are chosen by document type. DSH continues to own the conversation, settings, permissions, layout, and Agent engines.

The Windows folder-picker follow-up adds a hidden owner so the native dialog does not create a separate Node.js taskbar button. Native window, built-worker, and assembled Web cancellation checks pass; desktop screenshot acceptance remains unverified. See the [picker review](review/2026-09-03-windows-picker.md).

The document and ACP follow-up aligns new Word imports with `documents/source` and `documents/working`, reserves names retained by missing-file records, clarifies create-or-open behavior, and reactivates resident Sessions after Claude/Codex replacement. The switching regression passes in the assembled browser. The user's existing project and settings were inspected read-only. The owning bilingual Agent Notes and translation records are present; see the [documents and ACP review](review/2026-09-03-project-documents-and-acp.md).

The broader `workspace-management.e2e.ts` suite has 9 failures beginning with its deletion helper expecting list controls after navigation into workspace details. The first failure also reproduces with the original unconditional browse composition. Adding folders and renaming workspaces pass. This older suite needs separate navigation/fixture work; the branch does not have an all-green browser suite.

## Completed in this handoff

- Preserve unsaved block text when reselecting the block, attempting another document action, or reconnecting; surface a localized save/cancel message.
- Refresh loaded project lists when another Session or Agent creates a document.
- Retain the selected template id after its set is deleted and show the missing-template state; retry failed initial project reads.
- Complete the real-browser scenarios and their portable ARIA fixtures, regenerate the affected catalogs, remove unused test exports, and repair stale rescope-check assumptions.
- Synchronize the affected bilingual READMEs, generated references, and the owning UI Agent Note.

## Verification

The final focused workbench run passed 7 files and 92 tests. Browser replay passed 3 files and 15 tests, including built boot. The production build and contract lint passed; documentation synchronization passed all 28 gates. All 13 hygiene leaves passed across the aggregate run and focused reruns of its two repaired failures. The rescope classifier and preset tests passed 2 files and 6 tests. Exact commands and limits are recorded in [review/2026-09-03-ui-takeover.md](review/2026-09-03-ui-takeover.md).

## Next work

Continue from this branch and the [UI decision](../.agents/notes/implemented/feature/2026-09-03-paperai-ui-overhaul.md), using [CONTEXT.md](../CONTEXT.md) for product terms. Exact visual matching of the overhaul against its intended design is not part of the acceptance evidence. A real school project is the next useful acceptance check; this handoff's browser scenarios use controlled ACP responses. Existing Web services need a restart to load the Windows picker change.

## Historical recovery pointers

These pointers come from the earlier replatform record, not a fresh recovery test:

- Legacy commit: `c908361ecdc9dc9d1517d7382e5c7eb8f0c1aa48`.
- Legacy branch: `legacy-standalone-local`.
- Bundle: `F:\Papel-agent-legacy-20260828.bundle`.
- Source archive: `F:\Papel-agent-legacy-20260828.zip`.
