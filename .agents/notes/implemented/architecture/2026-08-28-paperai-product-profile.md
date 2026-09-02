# Agent Note: PaperAI product profile on DeepSeek Harness

Status: implemented

English | [中文](2026-08-28-paperai-product-profile.zh.md)

## Problem

PaperAI needs a complete local academic-document product, but its first implementation copied DeepSeek Harness presentation into a separate React/Fastify application. That duplicated the generic Agent shell, settings, permissions, model selection, session lifecycle, and responsive behavior while still looking and behaving unlike the pinned upstream client. The result made every upstream improvement expensive to adopt and left document-specific code coupled to a second application framework.

The product still needs capabilities that DeepSeek Harness does not own: Word import and mutation, institutional template contracts, document commits, paragraph history, academic delivery gates, and DOCX export. Those capabilities must work for the bundled DSH Agent and for local Codex and Claude ACP Agents without creating a second model loop or a parallel UI runtime.

## Decision

Use the pinned DeepSeek Harness repository as the PaperAI product foundation. Keep its Cordis Host, web client, agent harness and loop, session lifecycle, permissions, credentials, model settings, workspace infrastructure, connection layer, and UI plugins. PaperAI becomes a product profile assembled from the normal DSH web profile plus independently loadable PaperAI Cordis plugins.

The fork keeps upstream packages under `@deepseek-ai/dsh-*`. New product-owned packages use the `@paperai/*` scope so provenance and ownership remain explicit. PaperAI additions follow the same package, invariant, Loader, slot, test, and documentation contracts as DSH packages. The product profile disables only the upstream official brand contribution and replaces it through existing brand slots.

### Runtime and Agent composition

The PaperAI profile exposes three peer top-level Agent presets:

- **DSH** uses the existing full `standard` system preset, including the bundled DSH agent harness and `dsh-agent-loop`, with providers configured through the existing Models settings.
- **Codex** uses the installed local Codex ACP adapter and maps ACP lifecycle, configuration options, permissions, streamed content, plans, tools, cancellation, and errors into DSH sessions.
- **Claude** uses the installed local Claude ACP adapter through the same top-level ACP Agent implementation.

These are session-time Agent choices, not DSH subagents. Codex and Claude obtain their actual model choices from ACP `session/new.configOptions` and apply changes through `session/set_config_option`; the UI does not invent model identifiers. Existing DSH credentials and model settings remain the place to configure the bundled DSH provider, including API key, Base URL, protocol, and model list.

The PaperAI launcher restricts the shared system preset root to `standard`, then adds the product-owned Codex and Claude root. The roster therefore presents exactly those three system choices on a fresh harness home without copying the DSH composition. Other profiles keep the complete shipped DSH root, and the preset service continues to append its user-authoring root for locally created choices.

PaperAI MCP tools are the model-facing document capability surface for all Agents. Host commands and MCP handlers call the same domain services, and actor/model provenance is resolved from the active DSH session when each document command runs.

### Client composition

The DSH client stays the page shell. PaperAI extends four narrow upstream seams and otherwise composes through existing slots:

| Owner | Narrow extension | PaperAI contribution |
|---|---|---|
| `ui-layout` | Configurable center/details geometry and details visibility | A wider document workbench with the original concession and drag behavior |
| `ui-workspace` | A list slot in each real Workspace's second-level detail | Documents, templates, figures, experiments, and document status |
| `ui-conversation` | A generic details-view host alongside the existing Tool details view | Preview, Edit, History, and Template Gate views |
| `ui-agent-preset` | A keyed brand presentation slot | Official DSH, Codex, and Claude marks without hardcoded generic icons |

PaperAI supplies `ui-brand`, `ui-document-tree`, `ui-document-workbench`, `ui-toolviews`, and feature-owned settings contributions. Components use DSH CSS Modules and semantic tokens; they do not introduce another component system, theme, page shell, modal framework, or global store. Product copy is Chinese in the client and follows the existing locale service where a user-visible string needs translation.

### Document domain

The Working DOCX is the authoritative editable body. Imported source files and templates are immutable; operations target derived working copies. OfficeCLI is the sole v1 Word engine for inspection, normalization, semantic mutation, HTML preview, validation, rendering, and export preparation. HTML is generated presentation and Tiptap is only an ephemeral selected-section editing buffer.

PaperAI domain services are independent from the DSH platform and are exposed through Cordis Service Definitions with replaceable Service Providers:

- project and repository services own PaperAI metadata while projecting projects into DSH workspaces; project roots use canonical real paths, with Windows case folding, so symlink, junction, and spelling aliases cannot create competing identities; missing persisted roots retain a lexical identity until they become resolvable;
- the OfficeCLI document-engine Provider serializes mutations per Working DOCX;
- document, template, HIT template-pack, gate, commit, and export services own their respective business rules;
- one command contract is consumed by browser remotes and the PaperAI MCP transport;
- every completed human or Agent mutation creates a recoverable Document Commit with operation diff and actor/model provenance;
- draft export remains available with warnings, while delivery export is blocked by active hard errors.

The first bundled template pack is the supplied HIT master's-degree set. Users can select HIT templates or upload custom Word templates. Custom templates compile into a reviewable Template Contract and remain draft until confirmed. Template role compatibility, immutable source preservation, cross-document facts, and delivery requirements are enforced in domain services rather than duplicated in UI or MCP handlers.

### Migration sequence

The previous standalone tree remains recoverable from the `legacy-standalone-local` branch and the external Git bundle. Migration brings over only PaperAI-owned domain types, services, tests, template assets, OfficeCLI integration, and ACP/MCP adapter knowledge. The former custom Fastify Host, Vite application, copied DSH components, hand-written REST client, and generic Agent gateway are not ported.

The implementation proceeds as runnable vertical slices: product profile and brand; project plus DOCX import/preview; transactional human document commits and history; shared command/MCP surface; Codex and Claude top-level ACP sessions; template contracts, gates, and export; then full browser and document-fixture verification.

## Alternatives considered

**Continue styling the standalone PaperAI shell to resemble DSH.** This preserves duplicated layout, session, settings, and interaction code. Pixel matching does not reproduce upstream behavior and every new document panel would deepen the split.

**Treat DSH as an optional external executable detected at runtime.** Users would lose the guaranteed bundled Agent experience, settings integration, and one coherent lifecycle. Installation differences would become a product-level failure mode.

**Use DSH only as an ACP side Agent.** This keeps PaperAI responsible for another Host, Agent loop, and client runtime, which is the duplication the replatforming removes.

**Copy DSH into a submodule, subtree, or nested gitlink.** PaperAI modifies product composition and a small set of extension seams across the same workspace. A nested repository would complicate one lockfile, source builds, tests, releases, and upstream patch review.

**Rewrite the Word and document-history domain on top of DSH from scratch.** The existing domain already contains validated OfficeCLI flows, real HIT fixtures, template roles, commits, conflicts, gates, and export behavior. Migrating those seams is lower risk than rediscovering the rules.

**Persist Markdown or editable HTML as a second authoritative document.** Round-tripping Word layout through another full-document model introduces synchronization and fidelity conflicts. A single Working DOCX plus generated preview and section buffers keeps one source of truth.

**Copy `standard` into the PaperAI bundle.** A duplicate would drift from the DSH Agent it claims to provide and would require every upstream preset correction to be applied twice. Selecting `standard` by id from the shared system root keeps one composition as the source of the native Agent while allowing PaperAI to curate its roster.

## Testing

- The PaperAI profile boots from source and from a built artifact with the original DSH session, permission, settings, credential, model, and responsive UI behavior intact.
- A fresh PaperAI harness home lists exactly the existing `standard` DSH Agent, local Codex, and local Claude as peer top-level Agent choices with their own marks; each shows real provider/model choices and can run a session. Other profiles retain the complete shipped DSH roster.
- A user can choose a directory, initialize or resume a PaperAI project, import DOC/DOCX, inspect an OfficeCLI HTML preview, edit a selected section, and create a recoverable document commit.
- The document workbench exposes Preview, Edit, History, and Template Gate without shrinking to the former 300–520 px Tool-details width.
- HIT templates are bundled, custom templates can be uploaded and confirmed, source files remain unchanged, and derived documents obey role compatibility.
- Human and Agent changes use one serialized commit path with correct provenance, conflict detection, paragraph history, and rollback.
- Project repair and lookup treat symlink, junction, case, and short-path aliases as one root and reject ambiguous persisted duplicates.
- Draft export works while incomplete; delivery export runs the template gate and blocks active hard errors.
- PaperAI MCP and browser operations call the same domain command contract.
- Loader/composition tests cover every product-visible plugin, service tests cover domain behavior, and browser smoke tests cover the main project-to-export workflow at desktop and constrained widths.
- Third-party licenses, upstream attribution, package READMEs, bilingual architecture records, and local startup instructions match the shipped product.

## Consequences

The fork carries a small upstream patch set in four UI packages; each extension must remain additive and covered so later DSH updates can be merged rather than manually recopied. Top-level ACP projection must preserve DSH session-event balance, cancellation, permission requests, resumability, and process cleanup. OfficeCLI and legacy DOC conversion have Windows/native dependency failure modes that require explicit degraded states. Document commits span filesystem and SQLite state and need recoverable transaction ordering. DSH is pinned to a release candidate, so public contracts may still move. The first release targets the user's HIT workflow; other institutions will require additional template packs and larger visual-regression corpora before equivalent fidelity can be claimed.
