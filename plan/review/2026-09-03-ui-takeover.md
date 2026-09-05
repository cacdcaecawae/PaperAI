# PaperAI UI takeover review

Last updated: 2026-09-03

The inspected UI iteration is locally integrated. The inherited implementation already contained the start page, template library, document preview editor, locale overlays, and Host template operations.

## Resolved findings

1. Unsaved drafts could be replaced by repeated block selection, document navigation, or reconnect reads. The controller now preserves the draft, blocks incompatible actions, and reports missed external heads without replacing newer notifications.
2. A document created by another Session or Agent did not appear in an already loaded project. Document-change events now refresh loaded project overviews.
3. A deleted selected template was indistinguishable from a free-writing choice, and an initial project-read failure could not be retried. The overview retains the chosen id, and failed reads can be retried.
4. Browser fixture setup did not wait for actual Session navigation. The scenarios now drive settled UI state and cover custom-format upload, selection, deletion, draft retention, external refresh, and final commit.
5. Generated catalogs, unused fixture exports, and rescope metadata lagged the current tree. These checks have been repaired without rewriting vendor sources.

## Validation

| Command | Result |
| --- | --- |
| `pnpm exec vitest run packages/client/ui-paperai-workbench/tests packages/paperai/workbench-service/tests` | 7 files, 92 tests passed |
| `pnpm run build` | Passed; 204 client artifacts |
| `pnpm run lint:contracts-ready` | Passed |
| `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/paperai-workspace-navigation.e2e.ts apps/web/tests/paperai-permissions.e2e.ts apps/web/tests/built-boot.snapshot.ts` | 3 files, 15 tests passed |
| `pnpm run doc-sync` | 28 gates passed |
| `pnpm run hygiene` | 11 passed initially; Knip and rescope failures repaired |
| `pnpm run knip` and `pnpm run rescope-vendor:check` | Both repaired leaves passed |
| `pnpm exec vitest run scripts/rescope-vendor.spec.ts apps/cli/tests/profile-preset-roots.spec.ts` | 2 files, 6 tests passed |
| `git diff --check` | Passed |

Before the completion fixes, a wider focused baseline covering the affected PaperAI services, brand, locale, conversation, and CI workflow tests passed 44 files and 322 tests. It is separate from the final regression counts above.

## Limits and next acceptance

Browser scenarios exercise the assembled application with controlled ACP responses. This turn does not establish live-model behavior, full-suite coverage, or every platform. No reference screenshot was attached. Editing remains plain text in matched preview blocks; richer structural editing remains with the Agent and Word engine.
