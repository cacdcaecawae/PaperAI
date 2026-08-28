# Progress

## 2026-08-28 — Safe DSH replatform baseline

- Archived the previous standalone PaperAI implementation in a local branch, verified Git bundle, and ZIP source archive.
- Recreated `main` from the pinned DeepSeek Harness release commit while preserving `origin` and adding the upstream remote.
- Installed the 246-workspace dependency graph with the frozen lockfile; supply-chain policy verification passed.
- Confirmed the DSH web profile composes with the bundled `dsh-agent-loop` and native model/settings/permission stack.
- Ran focused upstream UI baselines: 50 test files and 824 tests passed for layout, workspace, conversation, and Agent preset packages.
- Completed independent audits of UI extension points, Git/repository strategy, and legacy domain migration.
- Started the PaperAI product-profile Agent Note and lean project context for the new architecture.

## 2026-08-28 — PaperAI vertical product implementation

- Added the PaperAI web profile and official Codex/Claude brand/preset contributions while retaining the complete pinned DSH Host, Harness, Loop, settings, permissions, model, session, and plugin foundation.
- Implemented project initialization, immutable Word import, semantic indexing, recoverable document commits, real continuous template reports, version restore, draft/formal export, and the built-in `HIT 硕士毕设` template pack.
- Added `.doc` normalization through read-only Windows Word automation and separated immutable source files from Working DOCX bytes; source integrity and cancellation-safe OfficeCLI cleanup now have regression tests.
- Implemented authenticated Streamable HTTP PaperAI MCP tools and wired one revocable descriptor into every local Codex/Claude ACP session. Model switching updates actor/model provenance.
- Made Agent preset routing exact across create, resume, fork, cold resume, and blank-session driver replacement. Missing Codex/Claude routes fail instead of falling back to the DSH loop.
- Added the strict Host workbench Remote and a DSH-native resource/details client with read-only HTML preview, one selected semantic-node text buffer, gate results, and actor/model version history.
- Independent review found one P0, six P1, and two P2 issues. The MCP injection, routing, template-source identity, commit bypass, Working/head digest, source immutability, real gate evidence, and OfficeCLI cleanup findings have been implemented and covered by focused tests.
- PaperAI document/template/commit/ACP focused tests pass (101 tests in the combined lane); source-integrity and OfficeCLI lanes pass 83 tests; route lanes pass 90 tests. Workspace constraints and regenerated persistence catalog pass.
- Regenerated third-party notices for pinned ACP and OfficeCLI dependencies and fixed exact-version resolution when two Claude Agent SDK payload versions coexist in pnpm's virtual store.
- Host composite build reached strict test-fixture type checking; remaining failures are isolated test typing fixes being resolved in parallel before the final build/browser gates.

## 2026-08-28 — Release-candidate recovery and browser validation

- Reworked optional first-run onboarding as a live DSH client service. The PaperAI product plugin now disables the DeepSeek credential and generic welcome dialogs at runtime while preserving the stock Models settings page.
- Fixed Agent-option ownership so named Codex/Claude ACP factories no longer receive the DSH loop's provider/model default, and made the Hero preset chip reconcile an already-restored session instead of displaying a different default Agent.
- Verified a genuinely new project through the real UI: it creates a Codex ACP session in `danger-full-access`, exposes the native Codex model catalog, starts on GPT-5.6-Sol, and successfully switches to GPT-5.6-Luna. Existing Standard sessions remain honestly labeled Standard.
- Completed a real legacy `.doc` browser workflow with Word normalization, immutable source preservation, OfficeCLI HTML preview, a human document commit, version history, HIT template confirmation/association, gate findings, draft export, and blocked formal export.
- Added a durable commit-publication journal with old-v1 SQLite compatibility and crash recovery. Added import compensation so rejected/cancelled root commits remove only the uncommitted derived Working import while preserving the uploaded source and all committed/template documents.
- Validated the DSH-native workbench at 1440×900 and 1366×768 in three-column mode, plus 1259×800 in document-focus mode. The Word page remains readable and the details workbench expands instead of collapsing into a narrow tool panel.
- Promoted the bilingual PaperAI product-profile ADR to `implemented`; focused client and document lanes, package invariants, Cordis config, TypeScript project references, and real browser checks pass. The subsequent full workspace release gates and GitHub publication are recorded below.

## 2026-08-28 — Release gates complete

- Completed multi-Agent review and Windows-native browser adaptation for approval, Code Mode, Goal actions, turn-tail actions, long conversations, navigation terminal cards, background jobs, fixture realization, HMR, and platform-portable ARIA paths without changing committed replay fixtures or goldens.
- Fixed deterministic PageUp/PageDown/Home/End conversation navigation, kept the scroll owner programmatically focusable without adding a Tab stop, and verified the complete long-chat geometry lane (5/5).
- Made settings path mutations re-read and reapply the latest user action once after a revision conflict; added fault-isolated settings-modal cleanup and a real Host mutation barrier for theme persistence. The settings scope lane passes 23 tests and the settings browser surface passes 9/9.
- Final production build passes and records 204 client artifacts. HMR plus built-boot artifact verification passes 2/2 after the final build.
- Full Web built lane passes 84/84 files: 285 tests passed and 13 mode-specific tests skipped.
- Full workspace lane passes 883 files with 4 skipped: 14,344 tests passed and 61 skipped. Independent E2E passes 28 files/112 tests, with 33 files/92 tests skipped by platform or recording design.
- Static release aggregate passes 37/37 gates, including documentation build, Markdown links, translation pairing, package paths, catalogs, module graph, Knip, licenses, and repository constraints. Contract lint, third-party notice verification, and `git diff --check` also pass.
- Release candidate passed every gate required for the history-reset publication to `cacdcaecawae/PaperAI`.

## 2026-08-28 — Release published

- Rebuilt the shallow upstream boundary as a self-contained root commit whose tree is byte-identical to DeepSeek Harness `b150a551`, preserving the pinned baseline without importing unrelated upstream history.
- Published the complete PaperAI v1 implementation to `cacdcaecawae/PaperAI` `main` with `--force-with-lease`; Git and GitHub API hashes were independently verified.
- Kept the pre-replatform implementation recoverable in the local legacy branch, verified Git bundle, and source ZIP, plus a local pre-root-rewrite branch for the tested shallow-history commit.
