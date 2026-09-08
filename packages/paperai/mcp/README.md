# @paperai/mcp

English | [中文](README.zh.md)

Authenticated MCP domain bridge from the DSH Host to local Codex and Claude ACP Agents.

## Host service

The plugin provides `ctx.paperMcp` and registers one exact Streamable HTTP route on `ctx.webServer`. `issueDescriptor(actor, scope)` returns an ACP-compatible HTTP MCP descriptor and an idempotent disposer. The random Bearer token selects a lease-owned Agent identity, so callers cannot supply or rewrite mutation provenance through tool arguments. The lease's access scope names the owning session's workspace root and reads its sandbox mode per request: every tool resolves the PaperAI project that owns that root and refuses records of any other project with `PROJECT_OUT_OF_SCOPE` (`NO_PROJECT_FOR_SESSION` when no project owns the workspace), and the mutating tools refuse under `read-only` with `READ_ONLY_SESSION` — the same shared `@paperai/domain` checks the native DSH document tools apply, so a `/permission` switch on the DSH session governs the next MCP call without reissuing the descriptor. The export tool additionally confines its destination the way the filesystem tools confine writes: under `workspace-write` the resolved path must lie inside the session workspace (a relative destination resolves against it) or the call fails with `WRITE_OUTSIDE_WORKSPACE`, and the workspace travels to the export provider as `writableRoot`, which re-checks the real parent directory at publish time so a directory link inside the workspace cannot carry the file out (`DESTINATION_OUTSIDE_WORKSPACE`); only `danger-full-access` may publish elsewhere.

The ACP session owner keeps the descriptor lease for exactly the Agent lifetime:

```ts ignore
const lease = ctx.paperMcp.issueDescriptor({
  kind: 'agent',
  name: 'Codex',
  client: 'codex',
  provider: 'openai',
  model: 'gpt-5.6-codex',
  sessionId: String(agent.session.id),
})

try {
  await runAcpSession({ mcpServers: [lease.descriptor] })
} finally {
  await lease.dispose()
}
```

The descriptor always uses loopback even when the browser server listens on `0.0.0.0`. Missing, malformed, and revoked tokens receive `401` before MCP parsing. Plugin disposal removes the route and revokes every outstanding lease.

`lease.updateActor(actor)` lets the ACP host synchronize model-controller changes without replacing the MCP descriptor. The lease permanently fixes `client` and `sessionId`; it may replace only the Agent provenance fields `name`, `provider`, `model`, `modelRevision`, and `runId`. Replacement is atomic for subsequent requests, returns a clone, and fails after disposal. The current `lease.actor` accessor also returns a clone.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `routePath` | `/api/paperai/mcp` | Exact WebServer pathname for Streamable HTTP MCP. |
| `serverName` | `paperai` | Name shown in the ACP MCP server list. |
| `defaultNodesPerRead` | `80` | Semantic nodes returned when the Agent omits a read limit. |
| `maxNodesPerRead` | `200` | Maximum semantic nodes returned by one call. |
| `maxMutationsPerCommit` | `64` | Maximum ordered mutations in one document commit. |

All numeric fields are positive safe integers. The default read count cannot exceed its maximum. Invalid configuration fails plugin activation.

## Tools

The base catalog is deliberately narrow:

| Tool | Mode | Domain operation |
|---|---|---|
| `paperai_list_projects` | Read-only | `paperProjects.list()` |
| `paperai_list_documents` | Read-only | `paperDocuments.listDocuments()` |
| `paperai_read_document` | Read-only | `paperDocuments.readDocument()` with bounded node pagination |
| `paperai_list_templates` | Read-only | `paperTemplates.listPacks()` and `listContracts()` |
| `paperai_get_template` | Read-only | `paperTemplates.getContract()` |
| `paperai_list_versions` | Read-only | `paperCommits.listHistory()` |
| `paperai_check_gate` | Read-only | `paperTemplates.check()` |
| `paperai_prepare_export` | Read-only | Checks export eligibility and returns the authoritative Working DOCX path; it never publishes a file. |
| `paperai_commit_document` | Mutating | `paperCommits.submit()` |
| `paperai_revert_document` | Mutating | `paperCommits.revert()` |

The commit schema exposes only mutations implemented by the current commit service: replace text, insert a paragraph, delete a node, bind a template, unbind the template, set the document type, and record a milestone. Before submitting `bind-template`, the handler requires an existing confirmed contract whose `appliesToRoles` includes the target document type — the type a `set-document-type` mutation in the same commit switches to, otherwise the stored one; draft and incompatible contracts never reach `paperCommits.submit()`. Setting a new type without rebinding drops the bound format, so an Agent that retypes a document binds the matching format in the same commit when one should apply. A successful mutation returns the complete `DocumentCommit`, its recorded `provenance`, and a `gateSummary` digest of the stored continuous gate: severity counts, the most severe findings first, and one actionable next step, with a distinct templateless free-mode message when no template is attached. Optimistic head and node-text conflicts retain the domain error code in the MCP error result.

`registerExportAdapter(adapter)` conditionally adds `paperai_export_document`. The adapter receives the checked document, destination, mode, and descriptor-bound actor. It must return a commit for that same document and actor; otherwise the MCP call rejects with `INVALID_EXPORT_PROVENANCE`. A failing formal delivery check rejects before the adapter runs. Callers register the adapter through a Cordis effect and retain its disposer.

`createPaperMcpServer(dependencies, actor, limits, exportAdapter?)` is the transport-neutral server factory used by the Host route. It can also be connected to an SDK stdio transport inside a process that already owns the PaperAI services. A standalone child process cannot use the Host's in-memory services without a separate RPC carrier, so the shipped Agent descriptor uses the existing authenticated HTTP carrier.

## Failures and ownership

Tool handlers return structured `{ error: { code, message, details? } }` results and do not expose stacks. Expected service errors preserve their `code`; uncategorized failures use `PAPERAI_OPERATION_FAILED`. The bridge does not edit DOCX files, repositories, templates, or exports itself. Every operation delegates to the owning PaperAI service.

Each HTTP request owns a fresh stateless MCP server and transport. Response close and plugin disposal close owned resources; callback failures are logged without leaving an unhandled rejection.

## Model Experience

### MCP tool catalog and results

#### What the model sees

The local ACP Agent receives the ten base tool schemas above. `paperai_export_document` appears only while an export adapter is registered. Read results contain current domain records; semantic document reads omit style data by default and use bounded pagination.

#### Token effect

The tool schemas add a fixed request prefix for the Agent session. Tool results add data-dependent tokens; document-node results are capped by `maxNodesPerRead`, and mutation arrays are capped by `maxMutationsPerCommit`.

#### KV Cache effect

The base catalog is stable for the descriptor lifetime. Registering or removing the optional export adapter changes the catalog created for later HTTP requests and may invalidate a provider's reusable tool-schema prefix; Bearer token and actor values never enter the tool schemas.

## Known Limitations and Deferred Work

- **Delivery publishing requires a provider** — Current PaperAI services expose delivery checks but no file-publication service. `paperai_prepare_export` remains read-only, and the mutating export tool is absent until a provider implementing `PaperMcpExportAdapter` is registered.
- **Lifecycle mutations need durable provenance** — Project creation, Word import, template installation, upload, and confirmation do not yet return a durable operation commit from their owning services, so this bridge exposes their query operations but does not offer untracked Agent mutations.
- **The descriptor depends on the Host WebServer** — `issueDescriptor()` fails before the WebServer has a listening port. The ACP Agent and Host must share a machine because the descriptor intentionally uses loopback.
