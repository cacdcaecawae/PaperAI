# `@paperai/tool-document`

English | [中文](README.zh.md)

Native DSH document tools for the PaperAI writing agent. The ten `paperai_*` tools keep the exact names and result fields of the [PaperAI MCP surface](../mcp/README.md), so the built-in agent, Codex, and Claude share one document vocabulary while every route reaches the same Host domain services.

## What it does

Registers ten tools on `ctx.tools`: `paperai_list_projects`, `paperai_list_documents`, `paperai_read_document`, `paperai_list_templates`, `paperai_get_template`, `paperai_list_versions`, `paperai_check_gate`, `paperai_prepare_export`, `paperai_commit_document`, and `paperai_revert_document`. Handlers delegate to `ctx.paperProjects`, `ctx.paperDocuments`, `ctx.paperTemplates`, and `ctx.paperCommits`; the package owns no domain rules. Contract validity of a `bind-template` mutation stays with `paperCommits.submit()`, whose `validateAssociation` call owns confirmation and role compatibility.

## Access scope

Every call is bounded by the calling session: `ctx.sandboxPolicy` resolves the session's workspace root and effective sandbox mode (the same fold the filesystem tools apply), `paperProjects.resolveForPath()` finds the project that owns that root, and the ten tools accept only project, document, and template records of that project — any other project's record is refused with `PROJECT_OUT_OF_SCOPE`, and a session whose workspace no project owns is refused with `NO_PROJECT_FOR_SESSION`. Under the `read-only` sandbox mode reads stay open while `paperai_commit_document` and `paperai_revert_document` are refused with `READ_ONLY_SESSION`; `danger-full-access` widens the filesystem, not the document scope. The checks are shared primitives from `@paperai/domain`, and the PaperAI MCP bridge applies the same ones to Codex and Claude.

## Provenance

Every commit and revert stamps the calling DSH session: `kind: 'agent'`, `name: 'DSH'`, `client: 'dsh'`, the session id, and the provider and model route. The route comes from the session's latest durable `request/header`, which the loop writes before each model request, so a model switched through the picker mid-session is what the version ledger records; the creation route is the fallback only before any request was made. A call without an owning agent is rejected, because its commit would be untraceable in the version ledger. This is what makes built-in-agent changes distinguishable from Codex and Claude entries in the document history.

## Gate digest

`paperai_commit_document` and `paperai_revert_document` return `{ commit, provenance, gateSummary }`, where `gateSummary` is the shared `summarizeGate()` digest from `@paperai/domain` over the continuous gate report already stored on the commit: severity counts, the most severe findings first, and one actionable Chinese next step, with a distinct templateless free-mode message. The Native render leads with the new version id and that next step.

## Configuration

- `defaultNodesPerRead` (default `80`) — node-page size when a read names no `limit`.
- `maxNodesPerRead` (default `200`) — upper bound for one read's node page.
- `maxMutationsPerCommit` (default `64`) — maximum ordered mutations in one commit.

The defaults mirror the PaperAI MCP limits. Non-positive values, unsafe integers, or a default above the maximum fail plugin load.

## Rendering

All render intents are the generic card: reads return their canonical JSON as Native text, and mutating tools prefix the JSON with a one-line commit acknowledgement carrying the gate next step. No diff or terminal card applies — mutations address semantic Word nodes, not files the UI could diff.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and no default, preserving loader injection metadata.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`paperai_*` schemas](../../../docs/tool-catalog.md#paperaitool-document) plus each result rendered as canonical JSON; commit results lead with the version id and the gate next step.

#### Token effect

Fixed schema cost on every request where the tools are visible. Read results scale with the requested node page; `defaultNodesPerRead` and `maxNodesPerRead` bound them.

#### KV Cache effect

Schemas are stable across a session, so the tool catalog does not disturb provider prefix caching.

## Known Limitations and Deferred Work

- No `paperai_export_document`: publishing a file stays with the workbench and the MCP export adapter; the agent prepares and reports through `paperai_prepare_export`.
- Provenance follows the session's latest `request/header`; a tool call always happens after its turn's header is durable, so there is no lag window, but a commit made before the first request can only record the creation route.
