/** React-free object layer for PaperAI Workspace resources and semantic-node editing. */

import {
  createSnapshotStore, type SessionId, type WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PaperAIActionResult, PaperAIDocumentCommitId, PaperAIDocumentCommitResult,
  PaperAIDocumentMutation, PaperAIDocumentNodeId, PaperAIDocumentOpenResult, PaperAIDocumentRole,
  PaperAIDocumentChangedEvent, PaperAIExportMode,
  PaperAIDocumentSnapshot, PaperAIResourceId, PaperAIResourceTreeState,
  PaperAIResourceDirectoryState, PaperAIResourceDirectoryStore, PaperAIResourceTreeStore,
  PaperAISelectedNodeBuffer, PaperAIWorkbenchRemote,
  PaperAIImportDocumentResult, PaperAITemplateCatalog, PaperAITemplateChoicesResult,
  PaperAITemplateStartInput, PaperAITemplateUsage, PaperAIWorkbenchAction,
  PaperAIWorkbenchState, PaperAIWorkbenchStore, PaperAIWorkbenchTab,
} from './types.ts'

const RESOURCE_INITIAL: PaperAIResourceTreeState = Object.freeze({
  phase: 'cold', resources: [], selected: null, error: null,
})

const WORKBENCH_INITIAL: PaperAIWorkbenchState = Object.freeze({
  phase: 'idle',
  tab: 'preview',
  document: null,
  nodePhase: 'idle',
  selectedNode: null,
  draft: '',
  dirty: false,
  action: null,
  templates: null,
  exportReceipt: null,
  externalUpdate: null,
  externalConflict: null,
  error: null,
  nodeError: null,
  actionError: null,
})

const OK: PaperAIActionResult = Object.freeze({ ok: true })

interface RequestEntry<Store> {
  readonly store: Store
  generation: number
  abort: AbortController | null
}

/** Convert a generated Remote failure into one displayable diagnostic. */
function remoteError(error: { readonly code: string; readonly message: string }): string {
  return `${error.code}: ${error.message}`
}

/** Fold an assembly-level Remote rejection into the same state path as carrier failures. */
async function callRemote<T>(call: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  try {
    return await call()
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'remote-rejected',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/** Return the immutable Host value from one selected-node buffer. */
function bufferValue(buffer: PaperAISelectedNodeBuffer): string {
  return buffer.text
}

/** Build the single node mutation represented by one temporary draft. */
function mutationFor(buffer: PaperAISelectedNodeBuffer, draft: string): PaperAIDocumentMutation {
  return { type: 'replace-text', nodeId: buffer.nodeId, baseText: buffer.text, nextText: draft }
}

/** Whether a selected buffer was read from the displayed document head. */
function bufferMatchesDocument(
  buffer: PaperAISelectedNodeBuffer,
  document: PaperAIDocumentSnapshot,
): boolean {
  return buffer.documentId === document.documentId
    && buffer.baseRevision === document.revision
    && buffer.baseCommitId === document.headCommitId
    && document.nodes.some(node => node.nodeId === buffer.nodeId && node.editable)
}

/** Whether document navigation must retain the selected-node editing state. */
function hasUnresolvedEdit(state: PaperAIWorkbenchState): boolean {
  return state.dirty || state.externalConflict !== null
}

/** Whether two durable-head notices represent the same event instance. */
function sameDocumentChange(
  left: PaperAIDocumentChangedEvent | null,
  right: PaperAIDocumentChangedEvent,
): boolean {
  return left?.documentId === right.documentId
    && left.headCommitId === right.headCommitId
    && left.updatedAt === right.updatedAt
}

/** Per-browser PaperAI controller; all React surfaces subscribe to its stable stores. */
export class PaperAIWorkbenchController {
  private readonly resources = new Map<WorkspaceId, RequestEntry<PaperAIResourceTreeStore>>()
  private readonly resourceDirectory: PaperAIResourceDirectoryStore = createSnapshotStore<PaperAIResourceDirectoryState>({
    workspaces: {},
  })
  private readonly resourceMirrors = new Map<WorkspaceId, () => void>()
  private readonly workbenches = new Map<SessionId, RequestEntry<PaperAIWorkbenchStore>>()
  private readonly targets = new Map<SessionId, {
    readonly workspaceId: WorkspaceId
    readonly resourceId: PaperAIResourceId
  }>()
  private disposed = false

  /**
   * @param remote - generated Host Remote namespace mounted by the owning UI plugin.
   */
  constructor(private readonly remote: PaperAIWorkbenchRemote) {}

  /**
   * Return the stable resource source for one Workspace.
   * @param workspaceId - Workspace owning the tree.
   * @returns one stable writable snapshot store.
   */
  resourceStore(workspaceId: WorkspaceId): PaperAIResourceTreeStore {
    this.assertLive()
    return this.resourceEntry(workspaceId).store
  }

  /**
   * Return the one aggregate resource source bound by the slot renderer.
   * @returns the stable store containing every loaded Workspace resource projection.
   */
  resourceDirectoryStore(): PaperAIResourceDirectoryStore {
    this.assertLive()
    return this.resourceDirectory
  }

  /**
   * Return the stable workbench source for one Session.
   * @param sessionId - Session owning the details column.
   * @returns one stable writable snapshot store.
   */
  workbenchStore(sessionId: SessionId): PaperAIWorkbenchStore {
    this.assertLive()
    return this.workbenchEntry(sessionId).store
  }

  /**
   * Load a cold Workspace tree exactly once.
   * @param workspaceId - Workspace to seed.
   * @returns after the current read settles.
   */
  ensureResources(workspaceId: WorkspaceId): Promise<void> {
    const entry = this.resourceEntry(workspaceId)
    return entry.store.getSnapshot().phase === 'cold'
      ? this.loadResources(workspaceId)
      : Promise.resolve()
  }

  /**
   * Replace one Workspace tree from the Host.
   * @param workspaceId - Workspace to refresh.
   * @returns after the current read settles.
   */
  async loadResources(workspaceId: WorkspaceId): Promise<void> {
    this.assertLive()
    const entry = this.resourceEntry(workspaceId)
    const request = this.begin(entry)
    entry.store.update((state) => {
      state.phase = 'loading'
      state.error = null
    })
    const result = await callRemote(() => this.remote.list({ workspaceId }, request.signal))
    if (!this.isCurrent(entry, request)) return
    if (!result.ok) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = remoteError(result.error)
      })
      return
    }
    entry.store.set({
      phase: 'ready',
      resources: result.value.resources,
      selected: entry.store.getSnapshot().selected,
      error: null,
    })
  }

  /**
   * Import one browser-selected Word file and open its versioned Working copy.
   * @param workspaceId - Workspace that receives the imported document.
   * @param sessionId - Session that displays the imported Working copy.
   * @param input - Word payload, document role, and optional display name.
   * @returns the settled local result after the resource tree and workbench projection are updated.
   */
  async importDocument(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    input: {
      readonly fileName: string
      readonly contentBase64: string
      readonly role: PaperAIDocumentRole
      readonly name?: string
    },
  ): Promise<PaperAIActionResult> {
    return await this.establishDocument(workspaceId, sessionId, signal => this.remote.importDocument({
      workspaceId,
      sessionId,
      ...input,
    }, signal))
  }

  /**
   * Start one document from a built-in template pack member and open its Working copy.
   * @param workspaceId - Workspace that receives the new document.
   * @param sessionId - Session that displays the new Working copy.
   * @param input - pack member, optional manuscript upload, role, and display name.
   * @returns the settled local result after the resource tree and workbench projection are updated.
   */
  async createFromTemplate(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    input: PaperAITemplateStartInput,
  ): Promise<PaperAIActionResult> {
    return await this.establishDocument(workspaceId, sessionId, signal => this.remote.createFromTemplate({
      workspaceId,
      sessionId,
      ...input,
    }, signal))
  }

  /**
   * Read the built-in template packs offered when starting a document.
   * @param workspaceId - Workspace whose project catalog is consulted.
   * @returns the pack choices, or the Host diagnostic when the catalog is unavailable.
   */
  async templateChoices(workspaceId: WorkspaceId): Promise<PaperAITemplateChoicesResult> {
    this.assertLive()
    const result = await callRemote(() => this.remote.listTemplates({ workspaceId }))
    if (!result.ok) return { ok: false, error: remoteError(result.error) }
    return { ok: true, packs: result.value.packs }
  }

  /**
   * Run one Host document-establishing call (import or template start) and
   * open the resulting Working copy in the Session's workbench.
   */
  private async establishDocument(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    call: (signal: AbortSignal) => Promise<RemoteResult<PaperAIImportDocumentResult>>,
  ): Promise<PaperAIActionResult> {
    this.assertLive()
    const workbench = this.workbenchEntry(sessionId)
    const current = workbench.store.getSnapshot()
    if (current.action !== null) {
      return { ok: false, error: 'workbench is busy' }
    }
    if (hasUnresolvedEdit(current)) {
      const error = 'commit or discard the selected node draft before importing another document'
      workbench.store.update((state) => { state.actionError = error })
      return { ok: false, error }
    }
    if (current.nodePhase === 'loading') {
      return { ok: false, error: 'selected node buffer is loading' }
    }

    const resources = this.resourceEntry(workspaceId)
    // Import owns the document workbench request generation. Resource refreshes
    // may still settle while the native/OfficeCLI import runs, but they must not
    // cancel a successful import or make its Working copy unreachable.
    const request = this.begin(workbench)
    workbench.store.update((state) => {
      state.action = 'importing-document'
      state.actionError = null
    })
    resources.store.update((state) => {
      state.phase = 'loading'
      state.error = null
    })
    const result = await callRemote(() => call(request.signal))
    if (!this.isCurrent(workbench, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) {
      resources.store.update((state) => {
        state.phase = state.resources.length === 0 ? 'error' : 'ready'
        state.error = remoteError(result.error)
      })
      return this.failAction(workbench.store, remoteError(result.error))
    }
    if (result.value.status === 'degraded') {
      const error = `${result.value.capability}: ${result.value.detail}`
      resources.store.update((state) => {
        state.phase = state.resources.length === 0 ? 'error' : 'ready'
        state.error = error
      })
      return this.failAction(workbench.store, error)
    }
    const opened = result.value.opened
    if (opened.document.workspaceId !== workspaceId || opened.document.sessionId !== sessionId
      || !this.openResultMatches(opened)) {
      const error = 'paperaiWorkbench returned an imported document for another Workspace or Session'
      resources.store.update((state) => {
        state.phase = state.resources.length === 0 ? 'error' : 'ready'
        state.error = error
      })
      return this.failAction(workbench.store, error)
    }
    this.targets.set(sessionId, { workspaceId, resourceId: opened.document.resourceId })
    resources.store.update((state) => {
      state.phase = 'ready'
      state.selected = opened.document.resourceId
      state.error = null
    })
    this.publishOpenResult(workbench.store, opened)
    await this.loadResources(workspaceId)
    return OK
  }

  /**
   * Publish a Workspace-selection failure that occurred before a Remote call.
   * @param workspaceId - Workspace whose row gesture failed.
   * @param error - rejected connect/open reason.
   */
  failWorkspace(workspaceId: WorkspaceId, error: unknown): void {
    if (this.disposed) return
    this.resourceEntry(workspaceId).store.update((state) => {
      state.phase = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    })
  }

  /**
   * Open one backed resource into a Session's workbench.
   * @param workspaceId - Workspace owning the resource.
   * @param sessionId - blank or existing Session displaying the details column.
   * @param resourceId - openable resource selected by the user.
   * @returns after the current read settles.
   */
  async openDocument(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    resourceId: PaperAIResourceId,
  ): Promise<void> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.action !== null || hasUnresolvedEdit(state)) {
      entry.store.update((draft) => {
        draft.actionError = hasUnresolvedEdit(state)
          ? 'commit or discard the selected node draft before opening another document'
          : 'wait for the current document action before opening another document'
      })
      return
    }
    this.targets.set(sessionId, { workspaceId, resourceId })
    this.resourceEntry(workspaceId).store.update((state) => { state.selected = resourceId })
    const request = this.begin(entry)
    const tab = entry.store.getSnapshot().tab
    entry.store.set({ ...WORKBENCH_INITIAL, phase: 'loading', tab })
    const result = await callRemote(() => this.remote.open({ workspaceId, sessionId, resourceId }, request.signal))
    if (!this.isCurrent(entry, request)) return
    if (!result.ok) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = remoteError(result.error)
      })
      return
    }
    if (!this.openResultMatches(result.value)
      || result.value.document.workspaceId !== workspaceId
      || result.value.document.sessionId !== sessionId
      || result.value.document.resourceId !== resourceId) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = 'paperaiWorkbench returned a node buffer from another document revision'
      })
      return
    }
    this.publishOpenResult(entry.store, result.value)
  }

  /**
   * Retry the last resource open requested for one Session.
   * @param sessionId - Session whose failed or stale read is retried.
   * @returns after the retried read settles, or immediately when no target was requested.
   */
  retryOpen(sessionId: SessionId): Promise<void> {
    this.assertLive()
    const target = this.targets.get(sessionId)
    return target === undefined
      ? Promise.resolve()
      : this.openDocument(target.workspaceId, sessionId, target.resourceId)
  }

  /**
   * Select one local workbench tab without touching the Host.
   * @param sessionId - Session whose details view changes.
   * @param tab - selected tab id.
   */
  selectTab(sessionId: SessionId, tab: PaperAIWorkbenchTab): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => { state.tab = tab })
    if (tab === 'gate') void this.loadTemplates(sessionId)
  }

  /**
   * Read one semantic node into the Session's temporary edit buffer.
   * @param sessionId - Session owning the open workbench.
   * @param nodeId - Host-projected semantic node identity.
   * @returns settled local action result.
   */
  async selectNode(sessionId: SessionId, nodeId: PaperAIDocumentNodeId): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) {
      return { ok: false, error: 'no open document' }
    }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    if (hasUnresolvedEdit(state) && state.selectedNode?.nodeId !== nodeId) {
      return { ok: false, error: 'discard unsaved node changes before selecting another node' }
    }
    if (state.nodePhase === 'ready' && state.selectedNode?.nodeId === nodeId) return OK
    if (!state.document.nodes.some(node => node.nodeId === nodeId && node.editable)) {
      return { ok: false, error: 'selected node is not editable in the current document projection' }
    }
    const document = state.document
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.nodePhase = 'loading'
      draft.selectedNode = null
      draft.draft = ''
      draft.dirty = false
      draft.nodeError = null
      draft.actionError = null
    })
    const result = await callRemote(() => this.remote.readNode({
      sessionId,
      documentId: document.documentId,
      nodeId,
      revision: document.revision,
      headCommitId: document.headCommitId,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failNode(entry.store, remoteError(result.error))
    if (result.value.nodeId !== nodeId || !bufferMatchesDocument(result.value, document)) {
      return this.failNode(entry.store, 'paperaiWorkbench returned a mismatched node buffer')
    }
    entry.store.update((draft) => {
      draft.nodePhase = 'ready'
      draft.selectedNode = result.value
      draft.draft = bufferValue(result.value)
      draft.dirty = false
      draft.nodeError = null
    })
    return OK
  }

  /**
   * Replace the browser-local draft for the selected node.
   * @param sessionId - Session owning the temporary buffer.
   * @param value - current plain-text node draft.
   */
  updateDraft(sessionId: SessionId, value: string): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => {
      if (state.phase !== 'ready'
        || state.nodePhase !== 'ready'
        || state.selectedNode === null
        || state.action !== null) return
      state.draft = value
      state.dirty = value !== bufferValue(state.selectedNode)
      state.actionError = null
    })
  }

  /**
   * Reset the temporary draft to the selected node's Host value.
   * @param sessionId - Session owning the temporary buffer.
   */
  discardDraft(sessionId: SessionId): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => {
      if (state.selectedNode === null || state.action !== null || state.externalConflict !== null) return
      state.draft = bufferValue(state.selectedNode)
      state.dirty = false
      state.actionError = null
    })
  }

  /**
   * Commit the selected node's draft as one mutation and create a version.
   * @param sessionId - Session owning the open workbench.
   * @returns settled local action result.
   */
  async commitSelected(sessionId: SessionId): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) {
      return { ok: false, error: 'no open document' }
    }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    if (state.nodePhase !== 'ready' || state.selectedNode === null) {
      return { ok: false, error: 'no selected node buffer' }
    }
    if (state.externalConflict !== null) {
      return { ok: false, error: 'resolve the external node conflict before committing' }
    }
    if (!state.dirty) return { ok: false, error: 'selected node has no changes' }
    if (!bufferMatchesDocument(state.selectedNode, state.document)) {
      return this.failAction(entry.store, 'selected node buffer is stale')
    }
    const document = state.document
    const selectedNode = state.selectedNode
    const mutation = mutationFor(selectedNode, state.draft)
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = 'committing'
      draft.actionError = null
    })
    const result = await callRemote(() => this.remote.commit({
      sessionId,
      documentId: document.documentId,
      baseRevision: selectedNode.baseRevision,
      baseCommitId: selectedNode.baseCommitId,
      mutations: [mutation],
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    if (!this.commitResultMatches(result.value, document)) {
      return this.failAction(entry.store, 'paperaiWorkbench returned an invalid commit projection')
    }
    this.publishCommitResult(entry.store, result.value)
    return OK
  }

  /**
   * Run the selected template gate for the open revision.
   * @param sessionId - Session owning the open workbench.
   * @returns settled local action result.
   */
  async validate(sessionId: SessionId): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'validating')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.validate({
      sessionId,
      documentId: document.documentId,
      revision: document.revision,
      headCommitId: document.headCommitId,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    if (result.value.documentId !== document.documentId
      || result.value.revision !== document.revision
      || result.value.headCommitId !== document.headCommitId) {
      return this.failAction(entry.store, 'paperaiWorkbench returned a gate for another document revision')
    }
    entry.store.update((state) => {
      if (state.document === null) return
      state.document = { ...state.document, gate: result.value.gate }
      state.action = null
      state.actionError = null
    })
    return OK
  }

  /**
   * Load built-in packs and installed template contracts for the open document.
   * @param sessionId - Session owning the open workbench.
   * @returns the settled local action result after publishing the template catalog.
   */
  async loadTemplates(sessionId: SessionId): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) return { ok: false, error: 'no open document' }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    const document = state.document
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = 'loading-templates'
      draft.actionError = null
    })
    const result = await callRemote(() => this.remote.listTemplates({
      workspaceId: document.workspaceId,
    }))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    return this.publishTemplateCatalog(entry.store, document.workspaceId, result.value)
  }

  /**
   * Install one member of a registered institutional template pack.
   * @param sessionId - Session owning the open workbench.
   * @param packId - registered template-pack id.
   * @param memberId - member of the pack to install.
   * @returns the settled local action result after publishing the updated template catalog.
   */
  async installTemplate(
    sessionId: SessionId,
    packId: string,
    memberId: string,
  ): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'installing-template')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.installTemplatePack({
      workspaceId: document.workspaceId,
      packId,
      memberIds: [memberId],
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    return this.publishTemplateCatalog(entry.store, document.workspaceId, result.value)
  }

  /**
   * Upload a custom Word template for the open document's academic role.
   * @param sessionId - Session owning the open workbench.
   * @param input - Word payload, display name, and intended template usage.
   * @returns the settled local action result after publishing the updated template catalog.
   */
  async uploadTemplate(
    sessionId: SessionId,
    input: {
      readonly fileName: string
      readonly contentBase64: string
      readonly name: string
      readonly usage: PaperAITemplateUsage
    },
  ): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'uploading-template')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.uploadTemplate({
      workspaceId: document.workspaceId,
      fileName: input.fileName,
      contentBase64: input.contentBase64,
      name: input.name,
      appliesToRoles: [document.role],
      usage: input.usage,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    return this.publishTemplateCatalog(entry.store, document.workspaceId, result.value)
  }

  /**
   * Confirm one parsed template contract after the user reviews its requirements.
   * @param sessionId - Session owning the open workbench.
   * @param templateId - parsed template contract to confirm.
   * @returns the settled local action result after publishing the updated template catalog.
   */
  async confirmTemplate(sessionId: SessionId, templateId: string): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'confirming-template')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.confirmTemplate({
      workspaceId: document.workspaceId,
      templateId,
    }))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    return this.publishTemplateCatalog(entry.store, document.workspaceId, result.value)
  }

  /**
   * Bind one confirmed compatible template through the Document Commit path.
   * @param sessionId - Session owning the open workbench.
   * @param templateId - confirmed template contract to associate.
   * @returns the settled local action result after publishing the new document revision.
   */
  async associateTemplate(sessionId: SessionId, templateId: string): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'associating-template')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.associateTemplate({
      sessionId,
      documentId: document.documentId,
      baseRevision: document.revision,
      baseCommitId: document.headCommitId,
      templateId,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    if (!this.commitResultMatches(result.value, document)) {
      return this.failAction(entry.store, 'paperaiWorkbench returned an invalid template commit projection')
    }
    this.publishCommitResult(entry.store, result.value)
    return OK
  }

  /**
   * Export the exact open revision as a draft or gated formal delivery DOCX.
   * @param sessionId - Session owning the open workbench.
   * @param mode - draft or formal-delivery validation mode.
   * @returns the settled local action result; a blocked formal delivery is an unsuccessful result.
   */
  async exportDocument(sessionId: SessionId, mode: PaperAIExportMode): Promise<PaperAIActionResult> {
    const action: PaperAIWorkbenchAction = mode === 'draft-export'
      ? 'exporting-draft'
      : 'exporting-delivery'
    const prepared = this.prepareAction(sessionId, action)
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.exportDocument({
      sessionId,
      documentId: document.documentId,
      baseRevision: document.revision,
      baseCommitId: document.headCommitId,
      mode,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    if (result.value.status === 'blocked') {
      if (
        result.value.documentId !== document.documentId
        || result.value.revision !== document.revision
        || result.value.headCommitId !== document.headCommitId
      ) {
        return this.failAction(entry.store, 'paperaiWorkbench returned an invalid blocked export projection')
      }
      const failed = result.value.gate.findings.filter(finding => !finding.passed).length
      const error = `delivery blocked by ${failed} template requirement${failed === 1 ? '' : 's'}`
      entry.store.update((state) => {
        if (state.document !== null) state.document = { ...state.document, gate: result.value.gate }
        state.tab = 'gate'
        state.action = null
        state.actionError = error
        state.exportReceipt = null
      })
      return { ok: false, error }
    }
    const exported = result.value
    if (!this.commitResultMatches(exported, document)) {
      return this.failAction(entry.store, 'paperaiWorkbench returned an invalid export commit projection')
    }
    this.publishCommitResult(entry.store, exported)
    entry.store.update((state) => {
      if (state.document !== null) state.document = { ...state.document, gate: exported.gate }
      state.exportReceipt = {
        mode,
        fileName: exported.fileName,
        outputPath: exported.outputPath,
      }
    })
    return OK
  }

  /**
   * Restore one durable commit through a newly created version.
   * @param sessionId - Session owning the open workbench.
   * @param targetCommitId - historical commit selected from the Host projection.
   * @returns settled local action result.
   */
  async restore(
    sessionId: SessionId,
    targetCommitId: PaperAIDocumentCommitId,
  ): Promise<PaperAIActionResult> {
    this.assertLive()
    const currentEntry = this.workbenchEntry(sessionId)
    const state = currentEntry.store.getSnapshot()
    if (hasUnresolvedEdit(state)) {
      return this.failAction(
        currentEntry.store,
        'commit or discard the selected node draft before restoring a version',
      )
    }
    const prepared = this.prepareAction(sessionId, 'restoring')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.restore({
      sessionId,
      documentId: document.documentId,
      baseRevision: document.revision,
      baseCommitId: document.headCommitId,
      targetCommitId,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    if (!this.commitResultMatches(result.value, document)) {
      return this.failAction(entry.store, 'paperaiWorkbench returned an invalid restore projection')
    }
    this.publishCommitResult(entry.store, result.value)
    return OK
  }

  /**
   * Observe a durable head change from another Session or Agent.
   * @param change - new document head advertised by the Host event stream.
   */
  handleDocumentChanged(change: PaperAIDocumentChangedEvent): void {
    if (this.disposed) return
    for (const [sessionId, entry] of this.workbenches) {
      const state = entry.store.getSnapshot()
      if (state.document?.documentId !== change.documentId
        || state.document.headCommitId === change.headCommitId) continue
      entry.store.update((draft) => { draft.externalUpdate = change })
      if (state.action === null && !hasUnresolvedEdit(state) && state.nodePhase !== 'loading') {
        void this.reloadExternal(sessionId)
      }
    }
  }

  /**
   * Load a pending durable head and rebase any selected-node draft without discarding conflict inputs.
   * @param sessionId - Session whose pending external head should replace the local projection.
   * @returns the settled local action result after the refreshed document is published.
   */
  async reloadExternal(sessionId: SessionId): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    const target = this.targets.get(sessionId)
    if (state.phase !== 'ready' || state.document === null || target === undefined) {
      return { ok: false, error: 'no open document' }
    }
    if (state.externalUpdate === null) return { ok: false, error: 'no external document update' }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    const pendingExternalUpdate = state.externalUpdate
    const localDraft = hasUnresolvedEdit(state) && state.selectedNode !== null
      ? { buffer: state.selectedNode, value: state.draft }
      : null
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = 'reloading-external'
      draft.actionError = null
    })
    const result = await callRemote(() => this.remote.open({
      workspaceId: target.workspaceId,
      sessionId,
      resourceId: target.resourceId,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.failAction(entry.store, remoteError(result.error))
    if (!this.openResultMatches(result.value)
      || result.value.document.workspaceId !== target.workspaceId
      || result.value.document.sessionId !== sessionId
      || result.value.document.resourceId !== target.resourceId) {
      return this.failAction(entry.store, 'paperaiWorkbench returned an invalid external document projection')
    }
    let rebasedBuffer: PaperAISelectedNodeBuffer | null = null
    let conflict = state.externalConflict
    if (localDraft !== null) {
      const document = result.value.document
      if (!document.nodes.some(node => node.nodeId === localDraft.buffer.nodeId && node.editable)) {
        return this.failAction(entry.store, 'selected node no longer exists in the external version; local draft preserved')
      }
      const rebased = await callRemote(() => this.remote.readNode({
        sessionId,
        documentId: document.documentId,
        nodeId: localDraft.buffer.nodeId,
        revision: document.revision,
        headCommitId: document.headCommitId,
      }, request.signal))
      if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
      if (!rebased.ok) return this.failAction(entry.store, remoteError(rebased.error))
      if (rebased.value.nodeId !== localDraft.buffer.nodeId
        || !bufferMatchesDocument(rebased.value, document)) {
        return this.failAction(entry.store, 'paperaiWorkbench returned a mismatched rebased node buffer')
      }
      if (bufferValue(rebased.value) !== bufferValue(localDraft.buffer)) {
        conflict = {
          localDraft: localDraft.value,
          externalText: bufferValue(rebased.value),
        }
      }
      rebasedBuffer = rebased.value
    }
    this.publishOpenResult(entry.store, result.value, pendingExternalUpdate)
    if (localDraft !== null && rebasedBuffer !== null) {
      entry.store.update((draft) => {
        draft.nodePhase = 'ready'
        draft.selectedNode = rebasedBuffer
        draft.draft = localDraft.value
        draft.dirty = localDraft.value !== bufferValue(rebasedBuffer)
        draft.externalConflict = conflict
      })
    }
    return OK
  }

  /**
   * Resolve a selected-node conflict on the latest external document head.
   * @param sessionId - Session owning the rebased selected-node buffer.
   * @param resolution - preserved local text, latest external text, or the currently edited merged text.
   */
  resolveExternalConflict(
    sessionId: SessionId,
    resolution: 'local' | 'external' | 'merged',
  ): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => {
      if (state.externalConflict === null
        || state.selectedNode === null
        || state.action !== null
        || state.externalUpdate !== null) return
      if (resolution === 'local') state.draft = state.externalConflict.localDraft
      if (resolution === 'external') state.draft = state.externalConflict.externalText
      state.dirty = state.draft !== bufferValue(state.selectedNode)
      state.externalConflict = null
      state.actionError = null
    })
  }

  /** Retry every previously loaded projection after a connection generation reset. */
  refreshLoaded(): void {
    if (this.disposed) return
    for (const [workspaceId, entry] of this.resources) {
      if (entry.store.getSnapshot().phase !== 'cold') void this.loadResources(workspaceId)
    }
    for (const sessionId of this.workbenches.keys()) {
      if (this.targets.has(sessionId)) void this.retryOpen(sessionId)
    }
  }

  /** Abort active reads, release stores, and reject stale callbacks. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.resources.values()) entry.abort?.abort()
    for (const entry of this.workbenches.values()) entry.abort?.abort()
    for (const dispose of this.resourceMirrors.values()) dispose()
    this.resources.clear()
    this.resourceMirrors.clear()
    this.workbenches.clear()
    this.targets.clear()
  }

  private resourceEntry(workspaceId: WorkspaceId): RequestEntry<PaperAIResourceTreeStore> {
    this.assertLive()
    let entry = this.resources.get(workspaceId)
    if (entry === undefined) {
      const created = { store: createSnapshotStore(RESOURCE_INITIAL), generation: 0, abort: null }
      entry = created
      this.resources.set(workspaceId, created)
      const publish = (): void => {
        const snapshot = created.store.getSnapshot()
        this.resourceDirectory.update((directory) => {
          directory.workspaces[workspaceId] = snapshot
        })
      }
      publish()
      this.resourceMirrors.set(workspaceId, created.store.subscribe(publish))
    }
    return entry
  }

  private workbenchEntry(sessionId: SessionId): RequestEntry<PaperAIWorkbenchStore> {
    this.assertLive()
    let entry = this.workbenches.get(sessionId)
    if (entry === undefined) {
      entry = { store: createSnapshotStore(WORKBENCH_INITIAL), generation: 0, abort: null }
      this.workbenches.set(sessionId, entry)
    }
    return entry
  }

  private begin<Store>(entry: RequestEntry<Store>): { readonly generation: number; readonly signal: AbortSignal } {
    entry.abort?.abort()
    const abort = new AbortController()
    entry.abort = abort
    entry.generation += 1
    return { generation: entry.generation, signal: abort.signal }
  }

  private isCurrent<Store>(
    entry: RequestEntry<Store>,
    request: { readonly generation: number; readonly signal: AbortSignal },
  ): boolean {
    return !this.disposed && !request.signal.aborted && entry.generation === request.generation
  }

  private prepareAction(
    sessionId: SessionId,
    action: NonNullable<PaperAIWorkbenchState['action']>,
  ):
    | {
      readonly ok: true
      readonly entry: RequestEntry<PaperAIWorkbenchStore>
      readonly document: PaperAIDocumentSnapshot
      readonly request: { readonly generation: number; readonly signal: AbortSignal }
    }
    | { readonly ok: false; readonly result: PaperAIActionResult } {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) {
      return { ok: false, result: { ok: false, error: 'no open document' } }
    }
    if (state.action !== null) return { ok: false, result: { ok: false, error: 'workbench is busy' } }
    if (hasUnresolvedEdit(state)) {
      return {
        ok: false,
        result: { ok: false, error: 'commit or discard the selected node draft before this action' },
      }
    }
    if (state.nodePhase === 'loading') {
      return { ok: false, result: { ok: false, error: 'selected node buffer is loading' } }
    }
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = action
      draft.actionError = null
    })
    return { ok: true, entry, document: state.document, request }
  }

  private failNode(store: PaperAIWorkbenchStore, error: string): PaperAIActionResult {
    store.update((state) => {
      state.nodePhase = 'error'
      state.nodeError = error
    })
    return { ok: false, error }
  }

  private failAction(store: PaperAIWorkbenchStore, error: string): PaperAIActionResult {
    store.update((state) => {
      state.action = null
      state.actionError = error
    })
    return { ok: false, error }
  }

  private publishOpenResult(
    store: PaperAIWorkbenchStore,
    result: PaperAIDocumentOpenResult,
    consumedExternalUpdate?: PaperAIDocumentChangedEvent,
  ): void {
    const previous = store.getSnapshot()
    const tab = previous.tab
    const sameWorkspace = previous.document?.workspaceId === result.document.workspaceId
    const sameDocument = previous.document?.documentId === result.document.documentId
    store.set({
      phase: 'ready',
      tab,
      document: result.document,
      nodePhase: result.selectedNode === null ? 'idle' : 'ready',
      selectedNode: result.selectedNode,
      draft: result.selectedNode === null ? '' : bufferValue(result.selectedNode),
      dirty: false,
      action: null,
      templates: sameWorkspace ? previous.templates : null,
      exportReceipt: sameDocument ? previous.exportReceipt : null,
      externalUpdate: consumedExternalUpdate === undefined
        ? previous.externalUpdate?.headCommitId === result.document.headCommitId
          ? null
          : previous.externalUpdate
        : sameDocumentChange(previous.externalUpdate, consumedExternalUpdate)
          ? null
          : previous.externalUpdate,
      externalConflict: null,
      error: null,
      nodeError: null,
      actionError: null,
    })
  }

  private publishCommitResult(store: PaperAIWorkbenchStore, result: PaperAIDocumentCommitResult): void {
    this.publishOpenResult(store, result)
  }

  private publishTemplateCatalog(
    store: PaperAIWorkbenchStore,
    workspaceId: WorkspaceId,
    catalog: PaperAITemplateCatalog,
  ): PaperAIActionResult {
    if (catalog.workspaceId !== workspaceId) {
      return this.failAction(store, 'paperaiWorkbench returned templates for another Workspace')
    }
    store.update((state) => {
      state.templates = catalog
      state.action = null
      state.actionError = null
    })
    return OK
  }

  private openResultMatches(result: PaperAIDocumentOpenResult): boolean {
    return result.selectedNode === null || bufferMatchesDocument(result.selectedNode, result.document)
  }

  private commitResultMatches(
    result: PaperAIDocumentCommitResult,
    expected: PaperAIDocumentSnapshot,
  ): boolean {
    return result.document.documentId === expected.documentId
      && result.document.resourceId === expected.resourceId
      && result.document.workspaceId === expected.workspaceId
      && result.document.sessionId === expected.sessionId
      && result.document.headCommitId === result.createdCommitId
      && this.openResultMatches(result)
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('paperai workbench: controller disposed')
  }
}
