# Project documents and ACP switching review

Date: 2026-09-03

## Findings

Read-only inspection of the PaperAI repository and `F:\test` found three working-document records created at separate times: a proposal at 09:33, a midterm report at 17:35, and another proposal at 22:27 on September 3, in local time. They were not the output of one creation request. The two proposal records referenced the same hidden working path. Only the later proposal's source and working files were present; the midterm files and the earlier documents' latest edited snapshots were absent. The inspection did not establish how those files disappeared. No project files, records, or personal settings were changed.

The importer allocated names from files alone. When files disappeared but their records remained, a later import could reuse a tracked name and path. The project guide also advertised `documents/source` and `documents/working`, while the importer published inside `.paperai/documents/v1`.

Project creation is a create-or-adopt operation keyed by the canonical directory. Selecting `F:\test` reopened its existing project and retained the template decision made at 17:32. The template chooser appears when the project has not made a decision; the existing start page also exposes the Change action.

Switching peer Agent drivers removes the old Host Agent and publishes its replacement under the same Session id. The resident client Session kept its `removed` flag after `host/session-added`, permanently disabling the model selector and composer. Removal also discarded the manager's projection store while the resident Session retained it, disconnecting the visible permission state from subsequent updates. Focused unit regressions and the assembled browser scenarios reproduced both failures before their fixes.

## Changes

- Document imports publish originals under `documents/source` and editable DOCX files under `documents/working`. Staging and immutable version snapshots remain under `.paperai`. Existing records continue to use their stored paths.
- Tracked document names remain reserved even when both files are missing. New imports receive an unused suffix; filesystem-exclusive publication still handles concurrent imports.
- The start action says “新建或打开项目” and explains that an existing directory retains documents and its template choice. Project context describes the actual private version store.
- An authoritative added frame reactivates the resident Session. A list baseline cannot reactivate it because a delayed baseline may precede removal. Removal clears the resident projection store's values and sequence watermarks while preserving the subscribed faces, so replacement updates reach the existing view. Genuine removal still disables controls.
- The real browser scenario switches Claude and Codex repeatedly and selects a model after every completed switch. It waits for the provider chip to finish its transition before opening the model menu.

## Claude model source

`packages/paperai/agent-acp/src/catalog.ts` projects the model choices advertised through ACP; it contains no static Claude model list. The pinned `@agentclientprotocol/claude-agent-acp` 0.70.0 starts the executable bundled with its SDK by default. Read-only version probes returned Claude Code 2.1.232 for that executable and 2.1.258 for the user's terminal executable. Neither the inspected PaperAI settings nor the current process environment specified `CLAUDE_CODE_EXECUTABLE`.

The installed adapter obtains models from SDK initialization and applies Claude's settings and allowlist. A version or provider configuration difference can therefore change the menu. The inspection did not compare two live provider catalogs and does not establish that version alone accounts for every model difference.

To use the native Windows installation, set the following in the shell that starts PaperAI, then run the usual PaperAI launch command there:

```powershell
$env:CLAUDE_CODE_EXECUTABLE = (Get-Command claude.exe -CommandType Application -ErrorAction Stop).Source
```

The plugin also accepts that variable under `claude.env`. Keep `claude.command` pointed at the ACP adapter. No provider upgrade, authentication change, real model prompt, or live-service restart was performed.

## Validation

- `pnpm exec vitest run packages/paperai/document-service/tests`: 4 files, 30 tests passed after the public-path and missing-file regressions first reproduced their failures.
- `pnpm exec vitest run packages/client/runtime/tests/manager.client.spec.ts packages/client/runtime/tests/session.client.spec.ts packages/paperai/project-service/tests/project-service.spec.ts`: 3 files, 119 tests passed.
- After the projection-store fix, `pnpm exec vitest run packages/client/runtime/tests/manager.client.spec.ts packages/client/runtime/tests/session.client.spec.ts packages/client/runtime/tests/projection-store.client.spec.ts`: 3 files, 126 tests passed.
- `pnpm run build`: passed and recorded 204 client artifacts.
- With `DSH_SNAPSHOT=replay`, `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/paperai-permissions.e2e.ts` passed all 11 scenarios on the final build, including repeated provider/model switches, permission changes and rejected changes, cancellation, model errors, and document editing.
- `paperai-workspace-navigation.e2e.ts` passed all 5 scenarios. Its fresh-project scenario chose a template, created exactly one proposal, and verified the public working file. A combined run before the projection-store fix passed these 5 scenarios and 9 permission/document scenarios; its two permission failures led to the final store fix and the successful 11-scenario rerun.
- `pnpm run lint:contracts-ready`: passed.
- The first `pnpm run doc-sync` passed 26 of 28 gates. The README model-experience format failure was corrected and its focused gate passed; the bilingual Agent Notes and translation records were then added for the final run.
- `git diff --check`: passed.

## Remaining limits

The broader workspace-management browser failures recorded in the Windows picker review remain outside this fix. Existing missing Word files and snapshots were not reconstructed; the earlier proposal's edited content was not available to restore safely. Existing document paths were not migrated.

The durable document-path decision and the Session replacement ordering rule are recorded in bilingual Agent Notes, with cross-links from the retained UI and Session-scope decisions.
