# Windows folder picker review

Date: 2026-09-03

## Scope and evidence

The user reported a separate Node.js taskbar item while selecting a project folder on Windows and asked to optimize it. Their comparison runs the original `npx @deepseek-ai/dsh web` on macOS, whose native picker uses `osascript`. The Windows implementation uses a child process and `IFileOpenDialog`.

The repository's pinned upstream has the same unowned Windows dialog. The fix follows Microsoft's [taskbar ownership documentation](https://learn.microsoft.com/en-us/windows/win32/shell/taskbar#managing-taskbar-buttons): the child supplies a hidden tool window as the modal dialog's owner and destroys it when `Show` finishes. Cancellation closes visible windows only, allowing COM to unwind before destroying that owner. The [existing Windows picker decision](../../.agents/notes/implemented/feature/2026-08-02-win32-in-process-folder-dialog.md) retains ownership of this mechanism; the native-picker and fallback-removal notes retain their separate decisions.

## Validation

- `pnpm exec vitest run packages/host/directory-picker-native/tests --coverage --coverage.include=packages/host/directory-picker-native/src/win32-dialog-bindings.ts`: 5 files, 50 tests passed; 1 POSIX-specific test skipped. The changed bindings file has 100% statements, branches, functions, and lines.
- `pnpm exec vitest run --config vitest.e2e.config.ts packages/host/directory-picker-native/tests/built-worker.e2e.ts`: the real Windows built-worker test passed; the POSIX-only test skipped.
- With `DSH_EXAMPLE_MODE=lib`, `pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/win32-directory-picker.snapshot.ts`: the keyless assembled Web snapshot passed. It confirms the real built child, visible native dialog, hidden owner, taskbar exclusion, HTTP cancellation response, window destruction, and normal process exit.
- `pnpm run build`: passed and recorded 204 client artifacts.
- `pnpm run lint:contracts-ready`: passed across the repository.
- `pnpm run doc-sync`: all 28 checks passed, including Host compilation, translation pairing, documentation links, catalogs, and Agent Note checks.
- `pnpm run verify-client-packages` and `pnpm run knip`: passed.

The standalone directory-browser golden depends on directories created by earlier tests in its suite. Its filtered run failed because those directories were absent. The complete `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-management.e2e.ts` run passed 3 tests and failed 9. Adding folders and renaming workspaces passed. The first failure follows session selection into workspace details while the deletion helper still expects a workspace-list action button; later cases share that page and time out waiting for list controls.

A control run temporarily forced the scaffold's original unconditional browse composition and selected `adds two workspaces|renames a workspace|deletes only`. The first two passed and deletion failed at the same `clickHoverAction` call. The scaffold was restored byte-for-byte in `finally`. This reproduces the initial failure without the new chooser-selection branch; the other eight failures were not independently bisected. The wider workspace suite remains failing and is not included in the passing picker checks above.

## Limits

Native window observations come from Win32 APIs. The desktop automation window list did not expose the owned test dialog, so no taskbar screenshot or interactive-selection acceptance was completed. Background-launch probes gave the same foreground result before and after the change. Packaged single-executable spawning and macOS/Linux visual behavior were not exercised.

The branch retains the inherited UI implementation and local completion fixes. No commit, push, or running Web service restart was performed for this follow-up. Restart an existing service to load the updated picker.
