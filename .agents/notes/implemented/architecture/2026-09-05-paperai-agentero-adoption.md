# Agent Note: Responsive PaperAI Agents and a document-centered workbench

Status: implemented

English | [中文](2026-09-05-paperai-agentero-adoption.zh.md)

## Problem

Native Agent initialization can take seconds, but disabling the whole composer makes that latency prevent writing. Document navigation also needs explicit context provenance and bounded rendering without losing drafts. Missing project files need an inspectable recovery path that cannot overwrite newer work.

## Decision

PaperAI adopts independent Agent diagnostics, immediate pending selection, explicit document references, bounded preview retention, and read-only project inspection from the architecture reviewed in [Agentero](https://github.com/poco-ai/Agentero/tree/7c5efcd1fbab0c5bd14969acdaa437912beb4b93). These concepts fit DSH's plugin seams; Cordis, generated Remote APIs, and authoritative DOCX operations remain the foundation. Agentero's Tauri process, Zustand stores, and rich-text body model are not dependencies. Its warm-up starts and closes an adapter session; it does not establish a reusable process pool for PaperAI.

This decision partially supersedes the layout and draft-refresh behavior in the [PaperAI UI decision](../feature/2026-09-03-paperai-ui-overhaul.md). Its template, brand, and block-editing decisions remain active.

## Agent replacement and diagnostics

A selection publishes the pending name immediately. One controller serializes Host replacement and consumes the latest pending intent after each reply. The intent belongs to the selected Session; navigation cannot apply it to another Workspace. Failure restores the last accepted route. A scoped submission hold permits drafting while preventing keyboard and button sends, including while the old Agent is removed. A caller-owned runtime binding lease retains the listed Session and its browser scope until replacement settles; it preserves navigation and draft identity without granting send authority. Only the connected adapter's advertisement enables live model selection.

Provider-owned diagnostics remain separate from conversation handles. Discovery reads installation metadata without spawning. Explicit probes use an empty temporary directory, no prompt or PaperAI MCP descriptor, denied client file operations, and native read-only mode. Concurrent probes share work, configured limits bound initialization and failure retries, and teardown completes before settlement. Cached metadata follows the exact launch configuration; a newer actual session takes precedence over an older probe. The cache reports previous observations, not current authorization or a selectable model list. Native CLI startup latency remains observable rather than hidden behind an asserted speedup.

The API gateway orders model reads and selections with preset replacement, resolving the live Agent after replacement settles. A committed preset event refreshes that Session’s resident model directory. Document navigation stays in the selected project Session, so opening Word does not replace an existing conversation or its draft.

## Document workspace

The generic layout accepts validated placement before the conversation. PaperAI puts projects left, Word in the middle, and Agent right, suppressing introductory content beside Word. At narrow widths, asking about selected text reveals the composer while retaining the document and its width preference.

Word selections become removable input references containing exact text, block ids, path, document id, revision, and head commit. Serialization freezes the visible context before asynchronous submission. Existing `user/message` events record the same text the model receives; navigation and diagnostics add no hidden context. A product-owned text projection displays the quotation and folds provenance behind an optional source disclosure; copied and logged text stay complete.

Preview retention has a configurable bound including the active view. Eviction releases heavy rendering while lightweight scroll offsets and drafts survive navigation. External changes invalidate cached previews. A changed block retains its local draft for copying or discarding and forbids overwriting the replacement block. DOCX commits remain the only durable edit path.

## Project inspection and recovery

Project Doctor reads registered project records, originals, working files, and retained snapshots without initializing or repairing them. It reports missing or changed files, invalid heads or snapshots, duplicate ownership, and unsafe paths. Only a missing working file with a verified owned head receives a recovery candidate.

Recovery runs inside the commit service's document queue, rechecks the candidate through a fresh scan, verifies snapshot bytes and destination ancestors, then publishes complete bytes with an atomic no-overwrite link. A changed head or existing destination rejects the plan. Materializing the already committed head adds no content version; it does not synthesize originals, overwrite external edits, or roll history backward.

## Consequences

Pending choice and actual readiness are separate states. Retained previews consume a bounded amount of rendering memory, while unsaved text remains browser-lifetime state. Diagnostics can report startup failures but cannot guarantee later provider authentication. Recovery is limited to reconstructing verified committed bytes.

Focused tests cover competing selections, submission holds, probe timeout and cooldown, frozen references, preview eviction, stale reads, and recovery refusal. Assembled keyless browser snapshots cover pending initialization, Word selection, draft conflicts, and separate scan/review/recovery gestures alongside model and permission flows. Package documentation owns configuration details and limitations.

The PaperAI CI selection includes the owning runtime, locale, Agent-preset, layout, conversation, and native-picker tests as well as product tests. Changed-source coverage applies to every affected module at the existing thresholds. The [OfficeCLI provider](../../../../packages/paperai/document-engine-officecli/README.md) suppresses the pinned binary's background updater during real document validation and mutation.

## Alternatives considered

A shared live ACP process pool would couple Session permissions and authenticated MCP descriptors across projects; conversation handles therefore keep separate processes. Replacing DSH with Tauri and Zustand would discard existing plugin lifetimes and generated APIs without reducing native adapter startup. Automatic repair during scanning would hide file mutations from the user; inspection and explicit recovery remain separate operations.
