# Workspaces

English | [中文](workspace.zh.md)

A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it. The subsystem is one package ([dsh-workspace](../../packages/workspace/workspace), `ctx.workspaceRegistry`) — an optional host-side capability, not part of the agent-loop spine, and invisible to models (no tools, no prompt text, no session events). It stores its records through the [storage domain form](storage.md) and validates session membership against [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log), so `storageDomain` and `sessionPersistence` are mandatory startup dependencies: an unavailable persistence peer leaves the plugin pending rather than being mistaken for an empty history. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md); bootstrap and GUI ordering: [Workspace UI product-flow Agent Note](../../.agents/notes/implemented/feature/2026-07-25-workspace-ui-product-flow.md).

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## Identity

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` is a [branded id](core.md#branded-ids). Path identity is separate: `realpathNormalize` (`fs.realpath`; trailing slashes, `..`, and symlinks resolved) is the one uniqueness canon — workspace paths are stored canonicalized, uniqueness is string equality of canonical paths (a symlink to an owned directory collides), and attach-time session cwd checks go through the same canon.

## The workspace entity

Consumers see only the `Workspace` interface; the implementation stays package-private.

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

Ownership truth is the record's ordered `sessionIds`, never derived from session cwd — but membership requires both: an id on the account and a header whose canonical cwd equals the workspace path, so one session structurally belongs to at most one workspace. Failed writes reject (`insertSessionBefore` account errors as `WorkspaceMoveInvalidError`, storage failures as plain errors); every accepted mutation stamps `updatedAt` and durably prunes candidates that no longer pass the membership check.

## The registry: `ctx.workspaceRegistry`

`WorkspaceRegistry` ([signatures](#ctxworkspaceregistry--workspaceregistry)) owns registration and resolution. `create(path, title?)` canonicalizes the path, rejects a nonexistent path (the original `ENOENT`) or a non-directory, returns the existing entity unchanged when the canonical path is already owned, and otherwise creates a record with `title ?? basename(path)` prepended to the durable registry order — a new record cannot duplicate an existing display title (`WorkspaceNameConflictError`). `get(id)` and the ordered `list()` are synchronous cache reads; `resolveByPath(path)` applies the same realpath canon without creating. `delete(id)` removes only the registration, order entry, and session account — the directory, user files, live sessions, and persisted logs are never touched, so those sessions become Ungrouped ([decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)); unknown ids return `false`. Create and delete persist a pending-mutation marker before their two writes (record + order) can diverge; startup resolves exactly the marked mutation — by deleting the marked table row, which completes an interrupted delete and rolls back an interrupted create (the registration is re-creatable, so rollback is the safe direction) — and an unmarked order/table mismatch fails loud as corruption.

Sessions get their cwd at create time from whoever creates them, not from this registry — the API gateway resolves a new session's cwd from the chosen workspace's `path` (falling back to an explicit or default cwd), creates the session so the cwd lands in its immutable [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log), then calls `attachSession`, which re-validates that stored header cwd against the workspace path. On the first successful start, the registry bootstraps history from persisted headers alone (`id`, `cwd`, `createdAt` — never event bodies), grouping sessions with a valid canonical cwd into per-directory workspaces, newest first; the initialized marker is written last so an interrupted bootstrap resumes safely. The bootstrap is one-time: cwd-less legacy sessions stay Ungrouped, and sessions created afterwards join a workspace only through `attachSession`.

## Consumers

[dsh-host-apiproxy](../../packages/host/apiproxy) is the product consumer: it serves workspace CRUD to GUI clients over `ctx.workspaceRegistry` and performs the create-session-then-attach flow above. [dsh-agent-instructions](../../packages/context/agent-instructions) is **not** a consumer despite the name: it discovers AGENTS.md-style instruction files under an agent's own cwd and never touches `ctx.workspaceRegistry` — the shared word refers to the user's working directory, not to this registry's entities.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxdocumentengine--documentengine-abstract-seam"></a>

### `ctx.documentEngine` — `DocumentEngine` (abstract seam)

Word document engine. Every method addresses an explicit file path; the provider must serialize operations for the same canonical Working DOCX.

```ts cordis-catalog
/**
 * Probe the configured engine without mutating a document.
 * @param signal - optional cancellation signal for the provider probe.
 * @returns capability availability and provider diagnostic details.
 */
abstract health(signal?: AbortSignal): Promise<CapabilityHealth>

/**
 * Read the complete text-node index in document order.
 * @param filePath - canonical DOCX path to inspect.
 * @param signal - optional cancellation signal for provider work.
 * @returns all text-bearing nodes in document order.
 * @throws when cancelled or the provider cannot read or parse the document.
 */
abstract readTextNodes(filePath: string, signal?: AbortSignal): Promise<EngineTextNode[]>

/**
 * Produce generated HTML preview; HTML is never an editable authority.
 * @param filePath - canonical DOCX path to render.
 * @param signal - optional cancellation signal for provider work.
 * @returns generated preview HTML for the current document bytes.
 * @throws when cancelled or the provider cannot render the document.
 */
abstract previewHtml(filePath: string, signal?: AbortSignal): Promise<string>

/**
 * Read structured properties from one Office path.
 * @param filePath - canonical DOCX path to inspect.
 * @param officePath - provider-defined Office node path.
 * @param depth - optional traversal depth; the provider chooses its default when omitted.
 * @param signal - optional cancellation signal for provider work.
 * @returns the structured property tree rooted at the Office path.
 * @throws when cancelled or the document, Office path, or response cannot be read.
 */
abstract inspect(filePath: string, officePath: string, depth?: number, signal?: AbortSignal): Promise<Record<string, unknown>>

/**
 * Apply a batch under one exclusive file lease and save before returning.
 * @param filePath - canonical Working DOCX path to mutate.
 * @param mutations - ordered Office-path mutations in the batch.
 * @param signal - optional cancellation signal for provider work.
 * @throws when cancelled or any mutation or save operation fails.
 */
abstract applyMutations(filePath: string, mutations: readonly EngineMutation[], signal?: AbortSignal): Promise<void>

/**
 * Run structural Office validation and return all available evidence.
 * @param filePath - canonical DOCX path to validate.
 * @param signal - optional cancellation signal for provider work.
 * @returns structural success and the provider's complete validation evidence.
 * @throws when cancelled or the provider cannot produce structured validation evidence.
 */
abstract validate(filePath: string, signal?: AbortSignal): Promise<EngineValidation>
```

Source: [`packages/paperai/document-engine/src/index.ts`](../../packages/paperai/document-engine/src/index.ts)

<a id="ctxpaperaiacpagents--paperaiacpagents"></a>

### `ctx.paperAiAcpAgents` — `PaperAiAcpAgents`

Owns the two exact ACP factory routes and every lifecycle they create.

```ts cordis-catalog
/**
 * Resolve secrets and endpoint overrides at session creation time.
 * @param definition - pinned provider definition to combine with the current settings.
 * @returns the provider definition with current command, credential, and endpoint overrides applied.
 */
resolveProvider(definition: AcpProviderDefinition): AcpProviderDefinition

/**
 * Read installation and cached catalogs without spawning any adapter.
 * @returns metadata for both configured providers, independent from live model selection.
 */
diagnosticStatus(): readonly AcpDiagnostic[]

/**
 * Run a prompt-free probe with shared failure cooldown and process teardown.
 * @param provider - installed peer Agent to inspect.
 * @param force - explicit retry bypassing failure cooldown.
 * @returns observed ACP metadata, including a cached model preview.
 */
probe(provider: 'codex' | 'claude', force: boolean): Promise<AcpDiagnostic>

/**
 * Complete setup, atomically publish the DSH lifecycle, and return its owner capability.
 * @param ownerCtx - active Context whose lifetime owns the published Agent and Session.
 * @param provider - configured ACP provider definition to launch.
 * @param preparation - exclusive prepared Session consumed and disposed by this call.
 * @param options - create or resume options, including cancellation, model selection, and setup.
 * @returns the Agent handle after startup, setup, Session entry, and Agent entry complete.
 * @throws when ownership, cancellation, ACP startup, model selection, or setup fails; partial resources are disposed before rejection.
 */
async publish( ownerCtx: Context, provider: AcpProviderDefinition, preparation: SessionPreparation, options: CreateAgentOptions | ResumeAgentOptions, ): Promise<AgentHandle>
```

Types: [AgentHandle](core.md) · [CreateAgentOptions](core.md) · [ResumeAgentOptions](core.md) · [SessionPreparation](persistence.md)

Source: [`packages/paperai/agent-acp/src/index.ts`](../../packages/paperai/agent-acp/src/index.ts)

<a id="ctxpaperaiworkbench--paperaiworkbenchservice"></a>

### `ctx.paperaiWorkbench` — `PaperAiWorkbenchService`

Strict Remote that keeps the DSH client free of PaperAI Host dependencies.

```ts cordis-catalog
/**
 * Lazily initialize the selected Workspace's project and describe it: the
 * template set it writes against and its tracked documents.
 * @param request - Workspace whose project should be described.
 * @param signal - optional cancellation signal for project initialization.
 * @returns the project name, template decision, and document rows.
 * @throws when the Workspace or its PaperAI project cannot be resolved.
 */
@Remote('overview') async overview(request: PaperAIOverviewRequest, signal?: AbortSignal): Promise<PaperAIProjectOverview>

/**
 * Read configured Agent discovery and cached model previews without starting processes.
 * @returns configured ACP peers, or an empty roster when the provider plugin is absent.
 */
@Remote('agentDiagnostics') agentDiagnostics(): readonly PaperAIAgentDiagnostic[]

/**
 * Probe ACP initialization in an empty directory without a model prompt.
 * @param request - selected provider and explicit cooldown bypass.
 * @returns readiness and model metadata after the diagnostic process exits.
 */
@Remote('probeAgent') probeAgent(request: PaperAIProbeAgentRequest): Promise<PaperAIAgentDiagnostic>

/**
 * Inspect the selected project's retained files and document ownership.
 * @param request - registered Workspace to scan.
 * @param signal - optional cancellation between artifact reads.
 * @returns read-only issues and explicit recovery plans.
 */
@Remote('inspectProject') async inspectProject(request: PaperAIOverviewRequest, signal?: AbortSignal): Promise<PaperAIProjectIntegrityReport>

/**
 * Restore missing working bytes using an unchanged verified version.
 * @param request - owning Workspace and scan-bound recovery plan.
 * @param signal - optional cancellation before publication.
 * @returns a fresh integrity report after recovery.
 */
@Remote('recoverWorking') async recoverWorking(request: PaperAIRecoverWorkingRequest, signal?: AbortSignal): Promise<PaperAIProjectIntegrityReport>

/**
 * Record the template set the project writes against, or the explicit
 * choice to write without one.
 * @param request - Workspace and template set id, or `null` for none.
 * @returns the refreshed overview.
 * @throws when the Workspace is unknown or the set is not in the library.
 */
@Remote('setProjectTemplate') async setProjectTemplate(request: PaperAISetProjectTemplateRequest): Promise<PaperAIProjectOverview>

/**
 * List every template set the user can choose from.
 * @returns built-in sets, then custom sets in creation order (empty ones included).
 */
@Remote('listTemplateLibrary') listTemplateLibrary(): Promise<PaperAITemplateLibrary>

/**
 * Create an empty custom template set.
 * @param request - display name and optional description.
 * @returns the refreshed library.
 * @throws when the name is blank or already used.
 */
@Remote('createTemplateSet') async createTemplateSet(request: PaperAICreateTemplateSetRequest): Promise<PaperAITemplateLibrary>

/**
 * Remove a custom template set. Projects that chose it fall back to
 * "no template" on their next overview; installed formats keep working.
 * @param request - custom set id.
 * @returns the refreshed library.
 * @throws when the set is unknown or built-in.
 */
@Remote('deleteTemplateSet') async deleteTemplateSet(request: PaperAIDeleteTemplateSetRequest): Promise<PaperAITemplateLibrary>

/**
 * Add or replace the Word format for one document type in a custom set.
 * @param request - set, document type, usage, optional name, and the upload.
 * @param signal - optional cancellation signal for staging and normalization.
 * @returns the refreshed library.
 * @throws when the set is unknown, the upload is invalid, or normalization fails.
 */
@Remote('addTemplateFormat') async addTemplateFormat( request: PaperAIAddTemplateFormatRequest, signal?: AbortSignal, ): Promise<PaperAITemplateLibrary>

/**
 * Remove the format for one document type from a custom set.
 * @param request - custom set id and document type.
 * @returns the refreshed library.
 * @throws when the set or format is unknown.
 */
@Remote('removeTemplateFormat') async removeTemplateFormat(request: PaperAIRemoveTemplateFormatRequest): Promise<PaperAITemplateLibrary>

/**
 * Import one browser-selected `.doc` or `.docx` as a free-writing document
 * and establish its root version. A rejected root submission is followed
 * by non-cancellable import rollback before this method settles.
 * @param request - Workspace, Session, upload bytes, and optional display name.
 * @param signal - optional cancellation signal for import, indexing, commit, and preview work.
 * @returns the opened imported document and root commit, or an explicit native-engine downgrade.
 * @throws when upload, project, import, or commit work fails; an AggregateError includes any rollback failure.
 */
@Remote('importDocument') async importDocument( request: PaperAIImportDocumentRequest, signal?: AbortSignal, ): Promise<PaperAIImportDocumentResult>

/**
 * Start one document of a given type from the project's template set and
 * bind that format in the root commit. A form template is imported as the
 * document itself; a formatting reference governs the uploaded manuscript
 * instead. Library formats ship reviewed requirements, so the contract is
 * confirmed here without a separate review step.
 * @param request - Workspace, Session, document type, optional manuscript upload, and display name.
 * @param signal - optional cancellation signal for installation, import, commit, and preview work.
 * @returns the opened document and root commit, or an explicit native-engine downgrade.
 * @throws when the project has no template set or no format for the type, a formatting reference
 * has no upload, or import or commit work fails; an AggregateError includes any rollback failure.
 */
@Remote('createFromTemplate') async createFromTemplate( request: PaperAICreateFromTemplateRequest, signal?: AbortSignal, ): Promise<PaperAIImportDocumentResult>

/**
 * Bind the project template's format for a document type through the
 * document commit path, changing the document's type in the same commit
 * when it differs.
 * @param request - document projection, Session provenance, and the document type to apply.
 * @param signal - optional cancellation signal for installation, commit, and refreshed projection work.
 * @returns the refreshed document projection and the new binding commit identity.
 * @throws when the projection is stale, the project has no template set or format for the type,
 * or the same format is already bound.
 */
@Remote('applyTemplate') async applyTemplate( request: PaperAIApplyTemplateRequest, signal?: AbortSignal, ): Promise<PaperAIDocumentCommitResult>

/**
 * Drop the bound format through the document commit path; the document
 * keeps its type and writes freely from then on.
 * @param request - document projection and Session provenance.
 * @param signal - optional cancellation signal for commit and refreshed projection work.
 * @returns the refreshed document projection and the new commit identity.
 * @throws when the projection is stale or no format is bound.
 */
@Remote('detachTemplate') async detachTemplate( request: PaperAIDetachTemplateRequest, signal?: AbortSignal, ): Promise<PaperAIDocumentCommitResult>

/**
 * Guess a document's type from its title, then its opening paragraphs.
 * @param request - document to inspect.
 * @returns the guessed type and what it was based on; the current type when nothing matches.
 * @throws when the document is unknown.
 */
@Remote('suggestDocumentType') suggestDocumentType(request: PaperAISuggestDocumentTypeRequest): Promise<PaperAIDocumentTypeSuggestion>

/**
 * Diff one version against its parent at paragraph level, reading both
 * immutable snapshots through the document engine.
 * @param request - document and version to explain.
 * @param signal - optional cancellation signal for engine reads.
 * @returns paragraph changes in document order; a root version lists every paragraph as added.
 * @throws when the version does not belong to the document.
 */
@Remote('diffVersion') async diffVersion(request: PaperAIDiffVersionRequest, signal?: AbortSignal): Promise<PaperAIVersionDiff>

/**
 * Export a draft or gated delivery DOCX into the project's output tree.
 * @param request - observed document projection, export mode, Session provenance, and optional file name.
 * @param signal - optional cancellation signal for validation, snapshot, publication, and refreshed projection work.
 * @returns export success with its milestone commit, or a delivery-gate rejection with no output or commit.
 * @throws when the projection or file name is invalid, or export work fails for a reason other than delivery-gate rejection.
 */
@Remote('exportDocument') async exportDocument( request: PaperAIExportDocumentRequest, signal?: AbortSignal, ): Promise<PaperAIExportDocumentResult>

/**
 * Open a read-only Working DOCX projection and its first editable node.
 * @param request - Workspace, Session, and document resource to open.
 * @param signal - optional cancellation signal for preview generation.
 * @returns the current document projection and optional first editable-node buffer.
 * @throws when the Workspace or document is missing, mismatched, or cannot be projected.
 */
@Remote('open') async open(request: PaperAIOpenDocumentRequest, signal?: AbortSignal): Promise<PaperAIDocumentOpenResult>

/**
 * Read one semantic node into a temporary plain-text edit buffer.
 * @param request - document projection identity and semantic node to read.
 * @param signal - optional cancellation signal for the node read.
 * @returns a fresh buffer tied to the observed revision and head commit.
 * @throws when the document or node is missing or the observed projection is stale.
 */
@Remote('readNode') readNode(request: PaperAIReadNodeRequest, signal?: AbortSignal): Promise<PaperAISelectedNodeBuffer>

/**
 * Apply block text mutations and create one immediate human commit.
 * @param request - observed document projection, Session provenance, and node text replacements.
 * @param signal - optional cancellation signal for mutation, commit, indexing, and preview work.
 * @returns the refreshed document projection and the new content commit identity.
 * @throws when no mutation is supplied, the projection is stale, or mutation or commit work fails.
 */
@Remote('commit') async commit( request: PaperAICommitDocumentRequest, signal?: AbortSignal, ): Promise<PaperAIDocumentCommitResult>

/**
 * Run the live continuous template gate for one unchanged revision.
 * @param request - observed document projection to validate.
 * @param signal - optional cancellation signal for document-engine checks.
 * @returns the gate report tied to the unchanged revision and head commit.
 * @throws when the document is missing, the projection is stale, or gate evaluation fails.
 */
@Remote('validate') async validate( request: PaperAIValidateDocumentRequest, signal?: AbortSignal, ): Promise<PaperAIValidateResult>

/**
 * Restore one reachable version through a new human commit.
 * @param request - current document projection, target commit, and Session provenance.
 * @param signal - optional cancellation signal for restore, indexing, and preview work.
 * @returns the refreshed document projection and the new restoration commit identity.
 * @throws when the document has no head, the projection is stale, or the target is unreachable or cannot be restored.
 */
@Remote('restore') async restore( request: PaperAIRestoreDocumentRequest, signal?: AbortSignal, ): Promise<PaperAIDocumentCommitResult>
```

Source: [`packages/paperai/workbench-service/src/index.ts`](../../packages/paperai/workbench-service/src/index.ts)

<a id="ctxpapercommits--papercommitservice"></a>

### `ctx.paperCommits` — `PaperCommitService`

FIFO commit controller and the only authoritative Working DOCX mutation path.

```ts cordis-catalog
/**
 * Apply mutations to a temporary copy and publish one recoverable commit.
 * Cancellation remains effective through staging; once publication starts,
 * the method completes publication or rollback before it settles.
 * @param request - base head, provenance, message, and ordered mutations.
 * @returns the completed commit after its Working DOCX and head are durable.
 */
submit(request: SubmitDocumentCommitRequest): Promise<DocumentCommit>

/**
 * Restore a reachable snapshot and record the restoration as a new commit.
 * @param request - current head, historical target, provenance, and message.
 * @returns the new revert commit; the historical target remains unchanged.
 */
revert(request: RevertDocumentCommitRequest): Promise<DocumentCommit>

/**
 * Read one stored commit object by id, including an unreachable recovery object.
 * @param commitId - exact commit identity.
 * @returns an isolated copy, or `undefined` when no object exists.
 */
getCommit(commitId: DocumentCommitIdType): DocumentCommit | undefined

/**
 * Read the user-visible history from the current head toward the root.
 * Unreachable objects retained after failed publication are excluded.
 * @param documentId - document whose reachable history is requested.
 * @returns newest-first isolated commit records.
 */
listHistory(documentId: DocumentId): DocumentCommitHistory

/**
 * Scan a registered project's artifacts without changing files or records.
 * @param project - registered project.
 * @param signal - optional cancellation.
 * @returns current integrity issues and explicit recovery plans.
 */
inspectProject(project: ProjectRecord, signal?: AbortSignal): Promise<ProjectIntegrityReport>

/**
 * Materialize missing working bytes from an unchanged verified head; existing files are never overwritten.
 * @param plan - exact recovery candidate returned by the integrity scan.
 * @param signal - cancellation before the atomic file publication.
 * @returns after the existing version's bytes are restored; no content or version history is changed.
 */
recoverMissingWorking(plan: WorkingRecoveryPlan, signal?: AbortSignal): Promise<void>
```

Source: [`packages/paperai/commit-service/src/index.ts`](../../packages/paperai/commit-service/src/index.ts)

<a id="ctxpaperdocuments--paperdocumentservice"></a>

### `ctx.paperDocuments` — `PaperDocumentService`

Immutable-source and Working-DOCX service backed by repository and engine Providers.

```ts cordis-catalog
/**
 * Snapshot and index a Word source. No files or records are published when
 * the configured engine reports a degraded capability.
 * @param request - project, source path, role, and optional display stem.
 * @param signal - optional cancellation propagated to engine operations.
 * @returns a complete imported snapshot or an explicit capability downgrade.
 * @throws PaperDocumentError for invalid input, missing records, or invalid engine nodes.
 */
async importDocument(request: ImportDocumentRequest, signal?: AbortSignal): Promise<ImportDocumentResult>

/**
 * Remove a Working import after its root-commit attempt has settled without a commit.
 * Cleanup is non-cancellable, deletes only service-published copies, and removes the
 * document record last so a failed attempt can be retried with the same identity.
 * @param documentId - identity returned by a successful {@link importDocument} call.
 * @returns after the record, semantic nodes, immutable copy, and Working copy are absent.
 * @throws PaperDocumentError when the record is not a Working import or has acquired a head commit.
 */
async rollbackImport(documentId: DocumentId): Promise<void>

/**
 * List project documents, optionally restricted to one academic role.
 * @param projectId - owning project identity.
 * @param role - optional exact role filter.
 * @returns deterministic creation/name/id order.
 */
listDocuments(projectId: ProjectId, role?: DocumentRole): DocumentRecord[]

/**
 * Read one repository snapshot.
 * @param documentId - document identity.
 * @returns document metadata and ordered nodes, or undefined when absent.
 */
readDocument(documentId: DocumentId): PaperDocumentSnapshot | undefined

/**
 * Verify the immutable source before a Consumer reads or copies its bytes.
 * @param documentId - document identity whose source should be verified.
 * @param signal - optional hash cancellation.
 * @returns the verified lowercase SHA-256 digest.
 * @throws PaperDocumentError when the document is absent, writable, replaced, or corrupted.
 */
async verifyImmutableSource(documentId: DocumentId, signal?: AbortSignal): Promise<string>

/**
 * Read the current ordered semantic index without exposing repository aliases.
 * @param documentId - document identity.
 * @returns an isolated node snapshot.
 * @throws PaperDocumentError when the document does not exist.
 */
readNodes(documentId: DocumentId): readonly DocumentNode[]

/**
 * Build, but do not publish, the semantic index for a staged commit DOCX.
 * The commit service remains the sole owner of Working DOCX and repository
 * publication; this method only projects candidate bytes through OfficeCLI.
 * @param request - candidate file, observed metadata, and stable prior nodes.
 * @returns isolated nodes carrying the prospective commit identity.
 */
buildCandidateIndex(request: BuildCandidateDocumentIndexRequest): Promise<readonly DocumentNode[]>

/**
 * Render the current Working DOCX as generated preview HTML.
 * @param documentId - document identity.
 * @param signal - optional engine cancellation.
 * @returns generated preview HTML; it is never an editable authority.
 * @throws PaperDocumentError when the document does not exist.
 */
async previewHtml(documentId: DocumentId, signal?: AbortSignal): Promise<string>

/**
 * Re-read the Working DOCX and replace its semantic index while preserving
 * prior node identity where content or structure still identifies lineage.
 * @param documentId - document identity.
 * @param signal - optional engine cancellation.
 * @returns updated repository snapshot.
 * @throws PaperDocumentError when the document is missing or engine nodes are invalid.
 */
rebuildIndex(documentId: DocumentId, signal?: AbortSignal): Promise<PaperDocumentSnapshot>
```

Source: [`packages/paperai/document-service/src/index.ts`](../../packages/paperai/document-service/src/index.ts)

<a id="ctxpaperexports--paperexportservice"></a>

### `ctx.paperExports` — `PaperExportService`

Template-checked atomic publisher and MCP export provider.

```ts cordis-catalog
/**
 * Check template requirements, record an optimistic milestone, and publish
 * its immutable snapshot. Draft findings are returned without blocking;
 * delivery errors reject before any commit or output is created.
 * Cancellation is observed before milestone publication. Once the commit
 * completes, file publication reaches success or cleanup before settlement.
 * @param request - observed document, destination, mode, and provenance.
 * @returns canonical output path, fresh report, and recoverable commit.
 */
exportDocument(request: ExportDocumentRequest): Promise<ExportDocumentResult & PaperMcpExportResult>
```

Source: [`packages/paperai/export-service/src/index.ts`](../../packages/paperai/export-service/src/index.ts)

<a id="ctxpapermcp--papermcpservice"></a>

### `ctx.paperMcp` — `PaperMcpService`

Authenticated PaperAI MCP route and descriptor registry.

```ts cordis-catalog
/**
 * Issue one revocable HTTP descriptor bound to one Agent client, session,
 * and access scope. The caller must retain and dispose the lease with the
 * ACP Agent session.
 * @param actor - Local Codex or Claude identity recorded on every commit.
 * @param scope - Session workspace root and live sandbox mode that constrain every tool call.
 * @returns the ACP-compatible descriptor and its idempotent disposer.
 */
issueDescriptor(actor: PaperMcpAgentIdentity, scope: PaperMcpAccessScope): PaperMcpDescriptorLease

/**
 * Register the sole provider for file-producing export tools. The caller
 * must retain the returned disposer through a Cordis effect.
 * @param adapter - Provider that checks publication and records a commit.
 * @returns a disposer that hides the export tool for future connections.
 */
registerExportAdapter(adapter: PaperMcpExportAdapter): () => void
```

Source: [`packages/paperai/mcp/src/index.ts`](../../packages/paperai/mcp/src/index.ts)

<a id="ctxpaperprojects--paperprojectservice"></a>

### `ctx.paperProjects` — `PaperProjectService`

Idempotent PaperAI project lifecycle with no separate open-project action.

```ts cordis-catalog
/**
 * Create or adopt one directory, initialize missing project artifacts, and
 * publish exactly one ProjectRecord associated with its DSH workspace.
 * Repeating the operation for the same canonical path preserves the first
 * record identity, name, creation time, and all existing files. The writing
 * charter is synchronized before the record is published, and a failed
 * publication restores the charter files it created or rewrote.
 * @param input - Selected directory and optional first-use display name.
 * @returns the durable record, context-file outcome, and Git readiness.
 */
create(input: CreatePaperProjectInput): Promise<CreatePaperProjectResult>

/**
 * Read one durable project.
 * @param id - PaperAI project id.
 * @returns the record, or `undefined` when unknown.
 */
get(id: ProjectId): ProjectRecord | undefined

/**
 * List durable projects in repository order.
 * @returns a fresh record array.
 */
list(): ProjectRecord[]

/**
 * Record the template set a project writes against. `null` records the
 * explicit choice to write without a template; either way the project counts
 * as decided, so the first-open prompt does not return.
 * @param id - PaperAI project id.
 * @param packId - template set id, or `null` for no template.
 * @returns the updated record.
 */
setTemplateChoice(id: ProjectId, packId: string | null): Promise<ProjectRecord>

/**
 * Resolve a project by an existing directory spelling.
 * @param rootPath - Existing directory path.
 * @returns the unique record for its canonical path, or `undefined`.
 */
async findByPath(rootPath: string): Promise<ProjectRecord | undefined>

/**
 * Resolve the project whose root owns a path: the session workspace root
 * itself or any directory inside it. Agent routes use this to scope document
 * tools to the calling session's project. A path that no project root
 * contains resolves to `undefined`; a missing path is compared lexically.
 * @param path - workspace root or a path inside one.
 * @returns the deepest owning project, or `undefined`.
 */
async resolveForPath(path: string): Promise<ProjectRecord | undefined>
```

Source: [`packages/paperai/project-service/src/index.ts`](../../packages/paperai/project-service/src/index.ts)

<a id="ctxpaperrepository--paperrepository"></a>

### `ctx.paperRepository` — `PaperRepository`

Typed repository with synchronous reads and durable queued writes. Returned records are retained storage values and must be replaced rather than mutated; calls outside the initialized service lifetime fail and writes propagate storage errors.

```ts cordis-catalog
/**
 * Read one project from the in-memory domain snapshot.
 * @param id - project identity to read.
 * @returns the stored project, or `undefined` when absent.
 */
getProject(id: ProjectId): ProjectRecord | undefined

/**
 * List all projects from a stable domain snapshot.
 * @returns projects in repository insertion order.
 */
listProjects(): ProjectRecord[]

/**
 * Durably insert or replace one complete project record.
 * @param record - complete project record keyed by its identity.
 */
putProject(record: ProjectRecord): Promise<void>

/**
 * Read one document from the in-memory domain snapshot.
 * @param id - document identity to read.
 * @returns the stored document, or `undefined` when absent.
 */
getDocument(id: DocumentId): DocumentRecord | undefined

/**
 * List all documents or those owned by one project.
 * @param projectId - optional project identity used to filter the snapshot.
 * @returns matching documents in repository insertion order.
 */
listDocuments(projectId?: ProjectId): DocumentRecord[]

/**
 * Durably insert or replace one complete document record.
 * @param record - complete document record keyed by its identity.
 */
putDocument(record: DocumentRecord): Promise<void>

/**
 * Atomically replace one document from the value current at its write-queue slot.
 * @param id - existing document identity to update.
 * @param update - synchronous transform from the current record to its replacement.
 * @returns the durably stored replacement record.
 * @throws when the document is absent at the update's queue slot.
 */
updateDocument(id: DocumentId, update: (record: DocumentRecord) => DocumentRecord): Promise<DocumentRecord>

/**
 * Durably delete one document record without cascading to related tables.
 * @param id - document identity to delete.
 * @returns `true` when a record was deleted, or `false` when it was absent.
 */
deleteDocument(id: DocumentId): Promise<boolean>

/**
 * List one document's semantic nodes in document order.
 * @param documentId - owning document identity.
 * @returns matching nodes sorted by ascending ordinal.
 */
listNodes(documentId: DocumentId): DocumentNode[]

/**
 * Durably insert or replace one complete semantic node.
 * @param record - complete node record keyed by its identity.
 */
putNode(record: DocumentNode): Promise<void>

/**
 * Durably delete one semantic node when present.
 * @param id - node identity to delete.
 * @returns `true` when a record was deleted, or `false` when it was absent.
 */
deleteNode(id: DocumentNodeId): Promise<boolean>

/**
 * Read one document commit from the in-memory domain snapshot.
 * @param id - commit identity to read.
 * @returns the stored commit, or `undefined` when absent.
 */
getCommit(id: DocumentCommitId): DocumentCommit | undefined

/**
 * List one document's commits in chronological order.
 * @param documentId - owning document identity.
 * @returns matching commits sorted by ascending creation timestamp.
 */
listCommits(documentId: DocumentId): DocumentCommit[]

/**
 * Durably insert or replace one complete document commit.
 * @param record - complete commit record keyed by its identity.
 */
putCommit(record: DocumentCommit): Promise<void>

/**
 * Read one document's interrupted commit publication.
 * @param documentId - document identity that owns the journal slot.
 * @returns the retained publication record, or `undefined` when no recovery is pending.
 */
getCommitPublication(documentId: DocumentId): DocumentCommitPublication | undefined

/**
 * List interrupted commit publications from a stable domain snapshot.
 * @returns publication records in repository insertion order.
 */
listCommitPublications(): DocumentCommitPublication[]

/**
 * Durably insert or replace one document's commit publication intent.
 * @param record - complete write-ahead record keyed by its document identity.
 */
putCommitPublication(record: DocumentCommitPublication): Promise<void>

/**
 * Durably clear one resolved commit publication.
 * @param documentId - document identity whose journal slot is resolved.
 * @returns `true` when a record was deleted, or `false` when it was already absent.
 */
deleteCommitPublication(documentId: DocumentId): Promise<boolean>

/**
 * Read one template contract from the in-memory domain snapshot.
 * @param id - template contract identity to read.
 * @returns the stored contract, or `undefined` when absent.
 */
getTemplate(id: TemplateContractId): TemplateContract | undefined

/**
 * List all template contracts or those owned by one project.
 * @param projectId - optional project identity used to filter the snapshot.
 * @returns matching contracts in repository insertion order.
 */
listTemplates(projectId?: ProjectId): TemplateContract[]

/**
 * Durably insert or replace one complete template contract.
 * @param record - complete template contract keyed by its identity.
 */
putTemplate(record: TemplateContract): Promise<void>

/**
 * List unresolved or resolved conflicts recorded for one document.
 * @param documentId - owning document identity.
 * @returns matching conflicts in repository insertion order.
 */
listConflicts(documentId: DocumentId): ChangeConflict[]

/**
 * Durably insert or replace one complete change-conflict record.
 * @param record - complete conflict record keyed by its identity.
 */
putConflict(record: ChangeConflict): Promise<void>
```

Source: [`packages/paperai/repository/src/index.ts`](../../packages/paperai/repository/src/index.ts)

<a id="ctxpapertemplates--papertemplateservice"></a>

### `ctx.paperTemplates` — `PaperTemplateService`

Host service owning institutional and uploaded template lifecycle.

```ts cordis-catalog
/**
 * Register one immutable built-in pack until the returned disposer runs.
 * @param manifest - validated same-process pack contribution.
 * @returns disposer removing only this exact registration.
 */
registerPack(manifest: TemplatePackManifest): () => void

/**
 * List every installable template set without exposing Host asset paths:
 * built-in packs in display-name order, then the user's custom sets that
 * hold at least one format, in creation order.
 * @returns asset-free pack summaries.
 */
listPacks(): TemplatePackSummary[]

/**
 * List the user's custom template sets, including sets that hold no format yet.
 * @returns fresh library records in creation order.
 */
listLibraryPacks(): TemplateLibraryPack[]

/**
 * Create an empty custom template set.
 * @param input - display name and optional description.
 * @returns the created set.
 */
createLibraryPack(input: { readonly name: string; readonly description?: string }): Promise<TemplateLibraryPack>

/**
 * Remove a custom template set; contracts already installed from it stay valid.
 * @param packId - custom set id.
 */
deleteLibraryPack(packId: string): Promise<void>

/**
 * Add or replace the Word format for one document type in a custom set.
 * @param input - set, document type, usage, optional name, and the upload bytes.
 * @param signal - optional cancellation signal for staging and normalization.
 * @returns the updated set.
 */
addLibraryFormat(input: AddLibraryFormatInput, signal?: AbortSignal): Promise<TemplateLibraryPack>

/**
 * Remove the format for one document type from a custom set.
 * @param packId - custom set id.
 * @param role - document type whose format is removed.
 * @returns the updated set.
 */
removeLibraryFormat(packId: string, role: TemplateLibraryPack['formats'][number]['id']): Promise<TemplateLibraryPack>

/**
 * Return one installed draft or confirmed contract.
 * @param templateId - durable contract identity.
 * @returns the stored contract, or `undefined` when absent.
 */
getContract(templateId: TemplateContractId): TemplateContract | undefined

/**
 * List installed contracts for one project.
 * @param projectId - owning PaperAI project.
 * @returns all draft and confirmed contracts in repository order.
 */
listContracts(projectId: ProjectId): TemplateContract[]

/**
 * Install selected members, verifying package bytes before OfficeCLI inspection.
 * Repeating the same project, pack version, member, and source digest returns
 * the existing draft or confirmed contract without another compilation.
 * @param input - project, pack, and optional member selection.
 * @param signal - optional cancellation signal.
 * @returns contracts in manifest order.
 */
async installPack(input: InstallTemplatePackInput, signal?: AbortSignal): Promise<TemplateContract[]>

/**
 * Import a custom `.doc` or `.docx` without mutating the selected file.
 * The returned contract always remains draft until {@link confirm} is called.
 * @param input - project, display name, source path, roles, and usage.
 * @param signal - optional cancellation signal.
 * @returns the reviewable draft contract.
 */
async upload(input: UploadTemplateInput, signal?: AbortSignal): Promise<TemplateContract>

/**
 * Perform the explicit user confirmation transition for a draft.
 * @param templateId - draft contract selected by the user.
 * @returns the confirmed durable contract; confirming twice is idempotent.
 */
async confirm(templateId: TemplateContractId): Promise<TemplateContract>

/**
 * Validate a proposed template binding. Publication belongs exclusively to
 * `paperCommits.submit({ mutations: [{ type: 'bind-template', ... }] })` so
 * the association always receives a recoverable version and provenance.
 * @param input - target document and confirmed contract identities.
 * @returns isolated target metadata when the binding is valid.
 */
validateAssociation(input: AssociateTemplateInput): DocumentRecord

/**
 * Check current Working DOCX content and styles against its attached contract.
 * Draft export callers may continue with a failing report; `delivery-export`
 * callers use the domain's `deliveryBlocked()` result before publishing.
 * @param input - document identity and requested check mode.
 * @param signal - optional cancellation signal.
 * @returns complete findings with the attached template identity when present.
 */
async check(input: CheckTemplateInput, signal?: AbortSignal): Promise<GateReport>

/**
 * Check an unpublished commit candidate against an explicit prospective
 * template binding. Repository metadata and the authoritative Working DOCX
 * remain unchanged while the gate runs.
 * @param input - current document metadata, candidate path, prospective template, and check mode.
 * @param signal - optional cancellation signal for document-engine work.
 * @returns complete findings for the isolated candidate and prospective binding.
 * @throws when the document or template is missing, candidate metadata is inconsistent, or the template belongs to another project.
 */
async checkCandidate(input: CheckTemplateCandidateInput, signal?: AbortSignal): Promise<GateReport>
```

Source: [`packages/paperai/template-service/src/index.ts`](../../packages/paperai/template-service/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The path is
 * canonicalized through `fs.realpath`; a nonexistent path rejects with the
 * original error and a non-directory rejects. Repeated calls for the same
 * canonical path return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in any path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * An already archived id resolves without writing.
 * @param sessionId - The session to archive.
 * @returns resolution after durability.
 */
archiveSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in any spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="paperai-events"></a>

### `paperai/*` events

<a id="paperaidocument-changed--emit"></a>

#### `paperai/document-changed` — emit

A Working document head was durably stored after its commit.

```ts cordis-catalog
/**
 * A Working document head was durably stored after its commit.
 * @param change - JSON-safe document id, committed head id, and update time.
 * @mode emit
 */
'paperai/document-changed'(change: PaperAIDocumentChangedEvent): void
```

Source: [`packages/paperai/workbench-service/src/types.ts`](../../packages/paperai/workbench-service/src/types.ts)
<!-- END GENERATED cordis-surface -->
