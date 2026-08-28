# Context Brief

Last updated: 2026-08-28

## Current stage

The functional PaperAI v1 vertical product is released. `main` starts from a tree-identical root snapshot of pinned DeepSeek Harness commit `b150a551`; the PaperAI profile, Host/domain layer, HIT template pack, OfficeCLI adapter, ACP drivers, authenticated MCP bridge, export service, and DSH-native workbench are implemented. Real browser workflows cover project creation, legacy Word import, preview/edit/history, template gate, draft/formal export behavior, native Codex models, constrained-width layouts, Windows-native shell interactions, settings persistence, and HMR/artifact integrity.

## Confirmed architecture

- Keep the complete DSH product foundation, including its built-in Harness/Agent Loop.
- Add PaperAI as Cordis Host/client plugins and a dedicated product profile.
- Keep DSH, Codex, and Claude as peer top-level Agent presets; ACP backs Codex and Claude.
- Reuse existing DSH Settings for API keys, Base URL, providers, model lists, permissions, and theme.
- Extend only `ui-layout`, `ui-workspace`, `ui-conversation`, and `ui-agent-preset`; replace official brand through existing slots.
- Migrate the existing Word/template/commit/gate/export domain, OfficeCLI integration, HIT assets, tests, and PaperAI MCP knowledge; do not port the old custom shell, Host, REST client, or duplicate Agent gateway.
- One revocable PaperAI MCP descriptor is issued per Codex/Claude ACP session; model changes update commit provenance and Agent disposal revokes access.
- Codex/Claude preset routes fail loudly when unavailable. Blank idle sessions may replace their real factory driver with persistence-backed rollback; a preset label can never silently retain another Agent driver.
- Template sources are evidence-only documents excluded from the user Working-document list. Template binding is accepted only through a validated Document Commit.
- New PaperAI sessions default to local Codex ACP with full access; restored sessions keep and display their actual Agent/permission/model state.
- Optional DSH onboarding is controlled through a live client service so PaperAI can omit the DeepSeek key prompt without forking or removing the Models settings UI.
- Commit publication uses a durable recovery journal, and a failed root commit compensates its uncommitted derived import without deleting the browser upload, institutional source, committed document, or template evidence.
- Settings path writes retry one freshly read revision conflict, so a concurrent namespace update cannot silently drop a later user preference.

## Safety and recovery

- Legacy archive commit: `c908361ecdc9dc9d1517d7382e5c7eb8f0c1aa48`.
- Legacy branch: `legacy-standalone-local`.
- Verified bundle: `F:\Papel-agent-legacy-20260828.bundle`.
- Source ZIP: `F:\Papel-agent-legacy-20260828.zip`.
- The previous remote history remains recoverable through the legacy branch, bundle, and ZIP; the rebuilt DSH-based history is now published to `origin/main`.

## Release evidence

- Production build: passed; 204 client artifacts recorded.
- Web built: 84 files passed; 285 tests passed, 13 skipped.
- Full workspace: 883 files passed, 4 skipped; 14,344 tests passed, 61 skipped.
- Independent E2E: 28 files/112 tests passed; 33 files/92 tests skipped by design.
- Static aggregate: 37 passed, 0 failed, 0 skipped; contract lint, notices, and diff checks passed.

## Current next step

Use PaperAI v1 with real school projects, collect workflow and UI friction, and prioritize the next iteration without reopening the completed architecture reset.
