/** React-free object layer for PaperAI projects, the template library, and block editing. */

import {
  createSnapshotStore, type SessionId, type WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { resolvePreviewBudget } from '../config.ts'
import type {
  PaperAIActionResult, PaperAIAddFormatInput, PaperAIDocumentChangedEvent, PaperAIDocumentCommitId,
  PaperAIDocumentCommitResult, PaperAIDocumentNodeId, PaperAIDocumentOpenResult, PaperAIDocumentSnapshot,
  PaperAIDocumentType, PaperAIExportMode, PaperAIExternalDocumentHead, PaperAIImportDocumentResult, PaperAILibraryAction,
  PaperAILibraryState, PaperAILibraryStore, PaperAIProjectAction, PaperAIProjectDirectoryState,
  PaperAIProjectDirectoryStore, PaperAIProjectOverview, PaperAIProjectState, PaperAIProjectStore,
  PaperAIResourceId, PaperAIRetainedView, PaperAIBlockEdit, PaperAITemplateLibrary, PaperAITemplateStartInput, PaperAIWorkbenchAction,
  PaperAIWorkbenchPanel, PaperAIWorkbenchRemote, PaperAIWorkbenchState, PaperAIWorkbenchStore,
} from './types.ts'

const PROJECT_INITIAL: PaperAIProjectState = Object.freeze({
  phase: 'cold', overview: null, selected: null, error: null, action: null, actionError: null,
})

const LIBRARY_INITIAL: PaperAILibraryState = Object.freeze({
  phase: 'cold', library: null, error: null, action: null, actionError: null,
})

const WORKBENCH_INITIAL: PaperAIWorkbenchState = Object.freeze({
  retained: [],
  scrollTop: 0,
  phase: 'idle',
  document: null,
  edit: null,
  action: null,
  panel: null,
  diff: null,
  typeSuggestion: null,
  exportReceipt: null,
  externalUpdate: null,
  error: null,
  actionError: null,
})

const OK: PaperAIActionResult = Object.freeze({ ok: true })

interface RequestEntry<Store> {
  readonly store: Store
  generation: number
  abort: AbortController | null
}

interface Request {
  readonly generation: number
  readonly signal: AbortSignal
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

function hasUnsavedEdit(state: PaperAIWorkbenchState): boolean {
  return state.edit !== null && state.edit.draft !== state.edit.baseText
}

/** Preserve an evicted or externally changed draft without applying it to a different block. */
function restoreEdit(document: PaperAIDocumentSnapshot, edit: PaperAIBlockEdit): PaperAIBlockEdit {
  const node = document.nodes.find(candidate => candidate.nodeId === edit.nodeId)
  return { ...edit, conflicted: node === undefined || !node.editable || node.text !== edit.baseText }
}

/** Commit identity is shared by live notifications and reconnect reads. */
function sameDocumentChange(
  left: PaperAIExternalDocumentHead | null,
  right: PaperAIExternalDocumentHead,
): boolean {
  return left?.documentId === right.documentId
    && left.headCommitId === right.headCommitId
}

function commitMatches(result: PaperAIDocumentCommitResult, expected: PaperAIDocumentSnapshot): boolean {
  return result.document.documentId === expected.documentId
    && result.document.resourceId === expected.resourceId
    && result.document.workspaceId === expected.workspaceId
    && result.document.sessionId === expected.sessionId
    && result.document.headCommitId === result.createdCommitId
}

/** Per-browser PaperAI controller; all React surfaces subscribe to its stable stores. */
export class PaperAIWorkbenchController {
  private readonly projects = new Map<WorkspaceId, RequestEntry<PaperAIProjectStore>>()
  private readonly projectDirectory: PaperAIProjectDirectoryStore = createSnapshotStore<PaperAIProjectDirectoryState>({
    workspaces: {},
  })
  private readonly projectMirrors = new Map<WorkspaceId, () => void>()
  private readonly library: RequestEntry<PaperAILibraryStore> = {
    store: createSnapshotStore(LIBRARY_INITIAL), generation: 0, abort: null,
  }
  private readonly workbenches = new Map<SessionId, RequestEntry<PaperAIWorkbenchStore>>()
  private readonly drafts = new Map<SessionId, Map<PaperAIResourceId, PaperAIBlockEdit>>()
  private readonly positions = new Map<SessionId, Map<PaperAIResourceId, number>>()
  private readonly targets = new Map<SessionId, {
    readonly workspaceId: WorkspaceId
    readonly resourceId: PaperAIResourceId
  }>()
  private disposed = false

  /**
   * @param remote - generated Host Remote namespace mounted by the owning UI plugin.
   * @param previewBudget - validated limit including the active preview.
   */
  constructor(private readonly remote: PaperAIWorkbenchRemote, private readonly previewBudget = resolvePreviewBudget()) {}

  /**
   * Return the stable project source for one Workspace.
   * @param workspaceId - Workspace owning the project.
   * @returns one stable writable snapshot store.
   */
  projectStore(workspaceId: WorkspaceId): PaperAIProjectStore {
    this.assertLive()
    return this.projectEntry(workspaceId).store
  }

  /**
   * Return the one aggregate project source bound by the slot renderer.
   * @returns the stable store containing every loaded project projection.
   */
  projectDirectoryStore(): PaperAIProjectDirectoryStore {
    this.assertLive()
    return this.projectDirectory
  }

  /**
   * Return the stable template-library source shared by the settings page and the template dialog.
   * @returns one stable writable snapshot store.
   */
  libraryStore(): PaperAILibraryStore {
    this.assertLive()
    return this.library.store
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
   * Load an unread project, or retry its failed read; reuse a ready or pending read.
   * @param workspaceId - Workspace to seed.
   * @returns after the current read settles.
   */
  ensureProject(workspaceId: WorkspaceId): Promise<void> {
    const entry = this.projectEntry(workspaceId)
    const phase = entry.store.getSnapshot().phase
    return phase === 'cold' || phase === 'error'
      ? this.loadProject(workspaceId)
      : Promise.resolve()
  }

  /**
   * Replace one project overview from the Host.
   * @param workspaceId - Workspace to refresh.
   * @returns after the current read settles.
   */
  async loadProject(workspaceId: WorkspaceId): Promise<void> {
    this.assertLive()
    const entry = this.projectEntry(workspaceId)
    const request = this.begin(entry)
    entry.store.update((state) => {
      state.phase = 'loading'
      state.error = null
    })
    const result = await callRemote(() => this.remote.overview({ workspaceId }, request.signal))
    if (!this.isCurrent(entry, request)) return
    if (!result.ok) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = remoteError(result.error)
      })
      return
    }
    this.publishOverview(entry, result.value)
  }

  /**
   * Record the project's template set (or the choice of none).
   * @param workspaceId - Workspace whose project decides.
   * @param packId - template set id, or `null` for no template.
   * @returns the settled local result after the overview is refreshed.
   */
  async setProjectTemplate(workspaceId: WorkspaceId, packId: string | null): Promise<PaperAIActionResult> {
    const prepared = this.prepareProjectAction(workspaceId, 'choosing-template')
    if (!prepared.ok) return prepared.result
    const { entry, request } = prepared
    const result = await callRemote(() => this.remote.setProjectTemplate({ workspaceId, packId }))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    this.publishOverview(entry, result.value)
    return OK
  }

  /**
   * Import one browser-selected Word file as a free-writing document and open its Working copy.
   * @param workspaceId - Workspace that receives the document.
   * @param sessionId - Session that displays the Working copy.
   * @param input - Word payload and optional display name.
   * @returns the settled local result after the project and workbench projections are updated.
   */
  importDocument(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    input: { readonly fileName: string; readonly contentBase64: string; readonly name?: string },
  ): Promise<PaperAIActionResult> {
    return this.establishDocument(workspaceId, sessionId, signal => this.remote.importDocument({
      workspaceId,
      sessionId,
      ...input,
    }, signal))
  }

  /**
   * Start one document of a type from the project template and open its Working copy.
   * @param workspaceId - Workspace that receives the new document.
   * @param sessionId - Session that displays the new Working copy.
   * @param input - document type, optional manuscript upload, and display name.
   * @returns the settled local result after the project and workbench projections are updated.
   */
  createFromTemplate(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    input: PaperAITemplateStartInput,
  ): Promise<PaperAIActionResult> {
    return this.establishDocument(workspaceId, sessionId, signal => this.remote.createFromTemplate({
      workspaceId,
      sessionId,
      ...input,
    }, signal))
  }

  /**
   * Load the template library exactly once, or refresh it.
   * @param force - re-read even when already loaded.
   * @returns after the current read settles.
   */
  async loadLibrary(force = false): Promise<void> {
    this.assertLive()
    const entry = this.library
    if (!force && entry.store.getSnapshot().phase !== 'cold') return
    const request = this.begin(entry)
    entry.store.update((state) => {
      state.phase = 'loading'
      state.error = null
    })
    const result = await callRemote(() => this.remote.listTemplateLibrary())
    if (!this.isCurrent(entry, request)) return
    if (!result.ok) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = remoteError(result.error)
      })
      return
    }
    this.publishLibrary(result.value)
  }

  /**
   * Create an empty custom template set.
   * @param input - display name and optional description.
   * @returns settled local action result.
   */
  createTemplateSet(input: { readonly name: string; readonly description?: string }): Promise<PaperAIActionResult> {
    return this.libraryAction('creating', () => this.remote.createTemplateSet(input))
  }

  /**
   * Remove a custom template set.
   * @param packId - custom set id.
   * @returns settled local action result.
   */
  deleteTemplateSet(packId: string): Promise<PaperAIActionResult> {
    return this.libraryAction('deleting', () => this.remote.deleteTemplateSet({ packId }))
  }

  /**
   * Add or replace one format in a custom template set.
   * @param input - set, document type, usage, optional name, and the Word upload.
   * @returns settled local action result.
   */
  addTemplateFormat(input: PaperAIAddFormatInput): Promise<PaperAIActionResult> {
    return this.libraryAction('adding', signal => this.remote.addTemplateFormat(input, signal))
  }

  /**
   * Remove one format from a custom template set.
   * @param packId - custom set id.
   * @param documentType - document type whose format is removed.
   * @returns settled local action result.
   */
  removeTemplateFormat(packId: string, documentType: PaperAIDocumentType): Promise<PaperAIActionResult> {
    return this.libraryAction('removing', () => this.remote.removeTemplateFormat({ packId, documentType }))
  }

  /**
   * Publish a Workspace-selection failure that occurred before a Remote call.
   * @param workspaceId - Workspace whose gesture failed.
   * @param error - rejected connect/open reason.
   */
  failWorkspace(workspaceId: WorkspaceId, error: unknown): void {
    if (this.disposed) return
    this.projectEntry(workspaceId).store.update((state) => {
      state.phase = state.overview === null ? 'error' : 'ready'
      state.error = error instanceof Error ? error.message : String(error)
    })
  }

  /**
   * Open one tracked document into a Session's workbench.
   * @param workspaceId - Workspace owning the document.
   * @param sessionId - blank or existing Session displaying the details column.
   * @param resourceId - document row selected by the user.
   * @param force - read the Host even when a retained preview is available.
   * @returns after the current read settles.
   */
  async openDocument(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    resourceId: PaperAIResourceId,
    force = false,
  ): Promise<void> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.action !== null) {
      entry.store.update((draft) => { draft.actionError = 'wait for the current document action before opening another document' })
      return
    }
    if (!force && state.phase === 'ready' && state.document?.resourceId === resourceId) return
    const retained = this.retain(sessionId, state, resourceId)
    const cached = force ? undefined : state.retained.find(view => view.document?.resourceId === resourceId)
    this.targets.set(sessionId, { workspaceId, resourceId })
    this.projectEntry(workspaceId).store.update((state) => { state.selected = resourceId })
    const request = this.begin(entry)
    if (cached !== undefined) {
      entry.store.set({ ...cached, retained })
      return
    }
    entry.store.set({ ...WORKBENCH_INITIAL, retained, phase: 'loading' })
    const result = await callRemote(() => this.remote.open({ workspaceId, sessionId, resourceId }, request.signal))
    if (!this.isCurrent(entry, request)) return
    if (!result.ok) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = remoteError(result.error)
      })
      return
    }
    if (result.value.document.workspaceId !== workspaceId
      || result.value.document.sessionId !== sessionId
      || result.value.document.resourceId !== resourceId) {
      entry.store.update((state) => {
        state.phase = 'error'
        state.error = 'paperaiWorkbench returned another document'
      })
      return
    }
    this.publishOpenResult(entry.store, result.value)
    const edit = this.drafts.get(sessionId)?.get(resourceId)
    entry.store.update((draft) => {
      draft.scrollTop = this.positions.get(sessionId)?.get(resourceId) ?? 0
      if (edit !== undefined) draft.edit = restoreEdit(result.value.document, edit)
    })
  }

  /**
   * Retry the last document open requested for one Session.
   * @param sessionId - Session whose failed or stale read is retried.
   * @returns after the retried read settles, or immediately when no target was requested.
   */
  retryOpen(sessionId: SessionId): Promise<void> {
    this.assertLive()
    const target = this.targets.get(sessionId)
    return target === undefined
      ? Promise.resolve()
      : this.openDocument(target.workspaceId, sessionId, target.resourceId, true)
  }

  /**
   * Remember the active preview's scroll position without loading another document.
   * @param sessionId - owning Session.
   * @param scrollTop - DOM scroll offset.
   */
  setScroll(sessionId: SessionId, scrollTop: number): void {
    if (this.disposed) return
    this.workbenchEntry(sessionId).store.update((state) => { state.scrollTop = scrollTop })
  }

  private retain(sessionId: SessionId, state: PaperAIWorkbenchState, opening: PaperAIResourceId): PaperAIRetainedView[] {
    const retained = state.retained.filter(view => view.document?.resourceId !== opening)
    if (state.document !== null && state.phase === 'ready') {
      const resource = state.document.resourceId
      const drafts = this.drafts.get(sessionId) ?? new Map<PaperAIResourceId, PaperAIBlockEdit>()
      if (hasUnsavedEdit(state) && state.edit !== null) drafts.set(resource, state.edit)
      else drafts.delete(resource)
      this.drafts.set(sessionId, drafts)
      const positions = this.positions.get(sessionId) ?? new Map<PaperAIResourceId, number>()
      positions.set(resource, state.scrollTop)
      this.positions.set(sessionId, positions)
      if (resource !== opening) {
        const { retained: _retained, ...view } = state
        retained.push(view)
      }
    }
    return this.previewBudget === 1 ? [] : retained.slice(1 - this.previewBudget)
  }

  /**
   * Open or close one secondary panel beside the document.
   * @param sessionId - Session whose view changes.
   * @param panel - panel to show, or `null` to return to the document alone.
   */
  showPanel(sessionId: SessionId, panel: PaperAIWorkbenchPanel | null): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => {
      state.panel = state.panel === panel ? null : panel
      if (state.panel !== 'versions') state.diff = null
    })
  }

  /**
   * Start editing one block in place.
   * @param sessionId - Session owning the open workbench.
   * @param nodeId - block chosen in the document view.
   * @returns settled local action result.
   */
  selectBlock(sessionId: SessionId, nodeId: PaperAIDocumentNodeId): PaperAIActionResult {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) return { ok: false, error: 'no open document' }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    if (state.edit?.nodeId === nodeId) return OK
    if (hasUnsavedEdit(state)) {
      return { ok: false, error: 'save or cancel the current block first' }
    }
    const node = state.document.nodes.find(candidate => candidate.nodeId === nodeId)
    if (node === undefined || !node.editable) {
      return { ok: false, error: 'block is not editable' }
    }
    entry.store.update((draft) => {
      draft.edit = { nodeId, baseText: node.text, draft: node.text }
      draft.actionError = null
    })
    return OK
  }

  /**
   * Replace the draft of the block being edited.
   * @param sessionId - Session owning the edit.
   * @param value - current plain-text draft.
   */
  updateDraft(sessionId: SessionId, value: string): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => {
      if (state.edit === null || state.action !== null) return
      state.edit = { ...state.edit, draft: value }
      state.actionError = null
    })
  }

  /**
   * Leave the block as it was, discarding the draft.
   * @param sessionId - Session owning the edit.
   */
  cancelEdit(sessionId: SessionId): void {
    this.assertLive()
    this.workbenchEntry(sessionId).store.update((state) => {
      if (state.action !== null) return
      state.edit = null
      state.actionError = null
    })
  }

  /**
   * Save the block draft as one version.
   * @param sessionId - Session owning the edit.
   * @returns settled local action result.
   */
  async commitEdit(sessionId: SessionId): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) return { ok: false, error: 'no open document' }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    if (state.edit === null) return { ok: false, error: 'no block is being edited' }
    if (state.edit.conflicted === true) return { ok: false, error: 'block changed externally; local draft retained' }
    if (state.edit.draft === state.edit.baseText) return { ok: false, error: 'block has no changes' }
    const document = state.document
    const edit = state.edit
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = 'committing'
      draft.actionError = null
    })
    const result = await callRemote(() => this.remote.commit({
      sessionId,
      documentId: document.documentId,
      baseRevision: document.revision,
      baseCommitId: document.headCommitId,
      mutations: [{ type: 'replace-text', nodeId: edit.nodeId, baseText: edit.baseText, nextText: edit.draft }],
    }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    if (!commitMatches(result.value, document)) {
      return this.fail(entry.store, 'paperaiWorkbench returned an invalid commit projection')
    }
    this.publishOpenResult(entry.store, result.value)
    return OK
  }

  /**
   * Run the template gate for the open revision.
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
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    if (result.value.documentId !== document.documentId
      || result.value.revision !== document.revision
      || result.value.headCommitId !== document.headCommitId) {
      return this.fail(entry.store, 'paperaiWorkbench returned a gate for another document revision')
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
   * Ask the Host what type the open document looks like, for the apply-template step.
   * @param sessionId - Session owning the open workbench.
   * @returns settled local action result; the suggestion lands in state.
   */
  async suggestType(sessionId: SessionId): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'suggesting-type')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.suggestDocumentType({ documentId: document.documentId }))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    entry.store.update((state) => {
      state.typeSuggestion = result.value
      state.action = null
      state.actionError = null
    })
    return OK
  }

  /**
   * Bind the project template's format for a type through a commit.
   * @param sessionId - Session owning the open workbench.
   * @param documentType - type whose format applies.
   * @returns settled local action result.
   */
  async applyTemplate(sessionId: SessionId, documentType: PaperAIDocumentType): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'applying-template')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.applyTemplate({
      sessionId,
      documentId: document.documentId,
      baseRevision: document.revision,
      baseCommitId: document.headCommitId,
      documentType,
    }, request.signal))
    return this.settleCommit(entry, request, document, result)
  }

  /**
   * Drop the bound format through a commit.
   * @param sessionId - Session owning the open workbench.
   * @returns settled local action result.
   */
  async detachTemplate(sessionId: SessionId): Promise<PaperAIActionResult> {
    const prepared = this.prepareAction(sessionId, 'detaching-template')
    if (!prepared.ok) return prepared.result
    const { entry, document, request } = prepared
    const result = await callRemote(() => this.remote.detachTemplate({
      sessionId,
      documentId: document.documentId,
      baseRevision: document.revision,
      baseCommitId: document.headCommitId,
    }, request.signal))
    return this.settleCommit(entry, request, document, result)
  }

  /**
   * Load one version's paragraph diff into the versions panel.
   * @param sessionId - Session owning the open workbench.
   * @param commitId - version to explain; the same id again closes the diff.
   * @returns settled local action result.
   */
  async showDiff(sessionId: SessionId, commitId: PaperAIDocumentCommitId): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) return { ok: false, error: 'no open document' }
    if (state.action !== null) return { ok: false, error: 'workbench is busy' }
    if (state.diff?.commitId === commitId) {
      entry.store.update((draft) => { draft.diff = null })
      return OK
    }
    const document = state.document
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = 'diffing'
      draft.diff = { commitId, result: null, error: null }
      draft.actionError = null
    })
    const result = await callRemote(() => this.remote.diffVersion({ documentId: document.documentId, commitId }, request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    entry.store.update((draft) => {
      draft.action = null
      draft.diff = result.ok
        ? { commitId, result: result.value, error: null }
        : { commitId, result: null, error: remoteError(result.error) }
    })
    return result.ok ? OK : { ok: false, error: remoteError(result.error) }
  }

  /**
   * Export the exact open revision as a draft or gated formal delivery DOCX.
   * @param sessionId - Session owning the open workbench.
   * @param mode - draft or formal-delivery validation mode.
   * @returns the settled local action result; a blocked formal delivery is an unsuccessful result.
   */
  async exportDocument(sessionId: SessionId, mode: PaperAIExportMode): Promise<PaperAIActionResult> {
    const action: PaperAIWorkbenchAction = mode === 'draft-export' ? 'exporting-draft' : 'exporting-delivery'
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
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    if (result.value.status === 'blocked') {
      if (result.value.documentId !== document.documentId
        || result.value.revision !== document.revision
        || result.value.headCommitId !== document.headCommitId) {
        return this.fail(entry.store, 'paperaiWorkbench returned an invalid blocked export projection')
      }
      const failed = result.value.gate.findings.filter(finding => !finding.passed).length
      const error = `delivery blocked by ${failed} template requirement${failed === 1 ? '' : 's'}`
      entry.store.update((state) => {
        if (state.document !== null) state.document = { ...state.document, gate: result.value.gate }
        state.panel = 'gate'
        state.action = null
        state.actionError = error
        state.exportReceipt = null
      })
      return { ok: false, error }
    }
    const exported = result.value
    if (!commitMatches(exported, document)) {
      return this.fail(entry.store, 'paperaiWorkbench returned an invalid export commit projection')
    }
    this.publishOpenResult(entry.store, exported)
    entry.store.update((state) => {
      if (state.document !== null) state.document = { ...state.document, gate: exported.gate }
      state.exportReceipt = { mode, fileName: exported.fileName, outputPath: exported.outputPath }
    })
    return OK
  }

  /**
   * Restore one durable version through a newly created version.
   * @param sessionId - Session owning the open workbench.
   * @param targetCommitId - historical commit selected from the timeline.
   * @returns settled local action result.
   */
  async restore(sessionId: SessionId, targetCommitId: PaperAIDocumentCommitId): Promise<PaperAIActionResult> {
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
    return this.settleCommit(entry, request, document, result)
  }

  /**
   * Observe a durable head change from another Session or Agent.
   * @param change - new document head advertised by the Host event stream.
   */
  handleDocumentChanged(change: PaperAIDocumentChangedEvent): void {
    if (this.disposed) return
    // A newly committed document is absent from the cached project rows.
    for (const [workspaceId, entry] of this.projects) {
      const state = entry.store.getSnapshot()
      if (state.phase !== 'cold' && state.action === null) void this.loadProject(workspaceId)
    }
    for (const [sessionId, entry] of this.workbenches) {
      entry.store.update((draft) => {
        draft.retained = draft.retained.filter(view => view.document?.documentId !== change.documentId)
      })
      const state = entry.store.getSnapshot()
      if (state.document?.documentId !== change.documentId
        || state.document.headCommitId === change.headCommitId) continue
      entry.store.update((draft) => { draft.externalUpdate = change })
      if (state.action === null && (state.edit === null || state.edit.draft === state.edit.baseText)) {
        void this.reloadExternal(sessionId)
      }
    }
  }

  /**
   * Load a pending durable head. A block draft survives when its block still
   * reads as it did; otherwise it remains available for copying or discarding.
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
    const pending = state.externalUpdate
    const edit = state.edit
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
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    if (result.value.document.workspaceId !== target.workspaceId
      || result.value.document.sessionId !== sessionId
      || result.value.document.resourceId !== target.resourceId) {
      return this.fail(entry.store, 'paperaiWorkbench returned an invalid external document projection')
    }
    this.publishOpenResult(entry.store, result.value, pending)
    if (edit !== null && edit.draft !== edit.baseText) {
      entry.store.update((draft) => {
        draft.edit = restoreEdit(result.value.document, edit)
      })
    }
    return OK
  }

  /** Refresh loaded projections after reconnect without replacing unsaved block text. */
  refreshLoaded(): void {
    if (this.disposed) return
    for (const [workspaceId, entry] of this.projects) {
      if (entry.store.getSnapshot().phase !== 'cold') void this.loadProject(workspaceId)
    }
    if (this.library.store.getSnapshot().phase !== 'cold') void this.loadLibrary(true)
    for (const [sessionId, entry] of this.workbenches) {
      entry.store.update((state) => { state.retained = [] })
      if (!this.targets.has(sessionId)) continue
      if (hasUnsavedEdit(entry.store.getSnapshot())) void this.refreshEditedDocument(sessionId)
      else void this.retryOpen(sessionId)
    }
  }

  /** A reconnect may discover a missed head notification; a dirty draft still requires an explicit refresh. */
  private async refreshEditedDocument(sessionId: SessionId): Promise<void> {
    const entry = this.workbenchEntry(sessionId)
    const target = this.targets.get(sessionId)
    const current = entry.store.getSnapshot()
    if (target === undefined || current.document === null || current.action !== null) return
    const request = this.begin(entry)
    const result = await callRemote(() => this.remote.open({
      workspaceId: target.workspaceId, sessionId, resourceId: target.resourceId,
    }, request.signal))
    if (!this.isCurrent(entry, request)) return
    if (!result.ok) {
      this.fail(entry.store, remoteError(result.error))
      return
    }
    const latest = result.value.document
    if (latest.documentId !== current.document.documentId
      || latest.workspaceId !== target.workspaceId
      || latest.sessionId !== sessionId
      || latest.resourceId !== target.resourceId) {
      this.fail(entry.store, 'paperaiWorkbench returned another document')
      return
    }
    if (!hasUnsavedEdit(entry.store.getSnapshot())) {
      this.publishOpenResult(entry.store, result.value)
    } else if (latest.headCommitId !== current.document.headCommitId) {
      entry.store.update((state) => {
        if (state.externalUpdate !== null && !sameDocumentChange(current.externalUpdate, state.externalUpdate)) return
        state.externalUpdate = { documentId: latest.documentId, headCommitId: latest.headCommitId }
      })
    }
  }

  /** Abort active reads, release stores, and reject stale callbacks. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.projects.values()) entry.abort?.abort()
    this.library.abort?.abort()
    for (const entry of this.workbenches.values()) entry.abort?.abort()
    for (const dispose of this.projectMirrors.values()) dispose()
    this.projects.clear()
    this.projectMirrors.clear()
    this.workbenches.clear()
    this.targets.clear()
    this.drafts.clear()
    this.positions.clear()
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
    const prepared = this.prepareProjectAction(workspaceId, 'starting')
    if (!prepared.ok) return prepared.result
    const { entry: project, request } = prepared
    const workbench = this.workbenchEntry(sessionId)
    if (workbench.store.getSnapshot().action !== null) {
      return this.fail(project.store, 'workbench is busy')
    }
    if (hasUnsavedEdit(workbench.store.getSnapshot())) {
      const error = 'save or cancel the current block first'
      this.fail(workbench.store, error)
      return this.fail(project.store, error)
    }
    const result = await callRemote(() => call(request.signal))
    if (!this.isCurrent(project, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.fail(project.store, remoteError(result.error))
    if (result.value.status === 'degraded') {
      return this.fail(project.store, `${result.value.capability}: ${result.value.detail}`)
    }
    const opened = result.value.opened
    if (opened.document.workspaceId !== workspaceId || opened.document.sessionId !== sessionId) {
      return this.fail(project.store, 'paperaiWorkbench returned a document for another Workspace or Session')
    }
    this.targets.set(sessionId, { workspaceId, resourceId: opened.document.resourceId })
    project.store.update((state) => {
      state.selected = opened.document.resourceId
      state.action = null
      state.actionError = null
    })
    this.publishOpenResult(workbench.store, opened)
    await this.loadProject(workspaceId)
    return OK
  }

  private async libraryAction(
    action: PaperAILibraryAction,
    call: (signal: AbortSignal) => Promise<RemoteResult<PaperAITemplateLibrary>>,
  ): Promise<PaperAIActionResult> {
    this.assertLive()
    const entry = this.library
    if (entry.store.getSnapshot().action !== null) return { ok: false, error: 'template library is busy' }
    const request = this.begin(entry)
    entry.store.update((state) => {
      state.action = action
      state.actionError = null
    })
    const result = await callRemote(() => call(request.signal))
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) {
      const error = remoteError(result.error)
      entry.store.update((state) => {
        state.action = null
        state.actionError = error
      })
      return { ok: false, error }
    }
    this.publishLibrary(result.value)
    // A changed library changes what every loaded project can offer.
    for (const [workspaceId, project] of this.projects) {
      if (project.store.getSnapshot().phase === 'ready') void this.loadProject(workspaceId)
    }
    return OK
  }

  private publishLibrary(library: PaperAITemplateLibrary): void {
    this.library.store.set({ phase: 'ready', library, error: null, action: null, actionError: null })
  }

  private publishOverview(entry: RequestEntry<PaperAIProjectStore>, overview: PaperAIProjectOverview): void {
    const previous = entry.store.getSnapshot()
    entry.store.set({
      phase: 'ready',
      overview,
      selected: previous.selected,
      error: null,
      action: null,
      actionError: null,
    })
  }

  private projectEntry(workspaceId: WorkspaceId): RequestEntry<PaperAIProjectStore> {
    this.assertLive()
    let entry = this.projects.get(workspaceId)
    if (entry === undefined) {
      const created = { store: createSnapshotStore(PROJECT_INITIAL), generation: 0, abort: null }
      entry = created
      this.projects.set(workspaceId, created)
      const publish = (): void => {
        const snapshot = created.store.getSnapshot()
        this.projectDirectory.update((directory) => {
          directory.workspaces[workspaceId] = snapshot
        })
      }
      publish()
      this.projectMirrors.set(workspaceId, created.store.subscribe(publish))
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

  private begin<Store>(entry: RequestEntry<Store>): Request {
    entry.abort?.abort()
    const abort = new AbortController()
    entry.abort = abort
    entry.generation += 1
    return { generation: entry.generation, signal: abort.signal }
  }

  private isCurrent<Store>(entry: RequestEntry<Store>, request: Request): boolean {
    return !this.disposed && !request.signal.aborted && entry.generation === request.generation
  }

  private prepareProjectAction(
    workspaceId: WorkspaceId,
    action: PaperAIProjectAction,
  ):
    | { readonly ok: true; readonly entry: RequestEntry<PaperAIProjectStore>; readonly request: Request }
    | { readonly ok: false; readonly result: PaperAIActionResult } {
    this.assertLive()
    const entry = this.projectEntry(workspaceId)
    if (entry.store.getSnapshot().action !== null) {
      return { ok: false, result: { ok: false, error: 'project is busy' } }
    }
    const request = this.begin(entry)
    entry.store.update((state) => {
      state.action = action
      state.actionError = null
    })
    return { ok: true, entry, request }
  }

  private prepareAction(
    sessionId: SessionId,
    action: PaperAIWorkbenchAction,
  ):
    | {
      readonly ok: true
      readonly entry: RequestEntry<PaperAIWorkbenchStore>
      readonly document: PaperAIDocumentSnapshot
      readonly request: Request
    }
    | { readonly ok: false; readonly result: PaperAIActionResult } {
    this.assertLive()
    const entry = this.workbenchEntry(sessionId)
    const state = entry.store.getSnapshot()
    if (state.phase !== 'ready' || state.document === null) {
      return { ok: false, result: { ok: false, error: 'no open document' } }
    }
    if (state.action !== null) return { ok: false, result: { ok: false, error: 'workbench is busy' } }
    if (hasUnsavedEdit(state)) {
      return { ok: false, result: this.fail(entry.store, 'save or cancel the current block first') }
    }
    const request = this.begin(entry)
    entry.store.update((draft) => {
      draft.action = action
      draft.actionError = null
    })
    return { ok: true, entry, document: state.document, request }
  }

  private settleCommit(
    entry: RequestEntry<PaperAIWorkbenchStore>,
    request: Request,
    document: PaperAIDocumentSnapshot,
    result: RemoteResult<PaperAIDocumentCommitResult>,
  ): PaperAIActionResult {
    if (!this.isCurrent(entry, request)) return { ok: false, error: 'request superseded' }
    if (!result.ok) return this.fail(entry.store, remoteError(result.error))
    if (!commitMatches(result.value, document)) {
      return this.fail(entry.store, 'paperaiWorkbench returned an invalid commit projection')
    }
    this.publishOpenResult(entry.store, result.value)
    return OK
  }

  /** Settle a failed action on either store kind: clear the action, keep the reason for the view. */
  private fail(store: PaperAIProjectStore | PaperAIWorkbenchStore, error: string): PaperAIActionResult {
    store.update((state: PaperAIProjectState | PaperAIWorkbenchState) => {
      state.action = null
      state.actionError = error
    })
    return { ok: false, error }
  }

  private publishOpenResult(
    store: PaperAIWorkbenchStore,
    result: PaperAIDocumentOpenResult,
    consumedExternalUpdate?: PaperAIExternalDocumentHead,
  ): void {
    const previous = store.getSnapshot()
    const sameDocument = previous.document?.documentId === result.document.documentId
    store.set({
      phase: 'ready',
      retained: previous.retained,
      scrollTop: sameDocument ? previous.scrollTop : 0,
      document: result.document,
      edit: null,
      action: null,
      panel: sameDocument ? previous.panel : null,
      diff: null,
      typeSuggestion: sameDocument ? previous.typeSuggestion : null,
      exportReceipt: sameDocument ? previous.exportReceipt : null,
      externalUpdate: consumedExternalUpdate === undefined
        ? previous.externalUpdate?.headCommitId === result.document.headCommitId
          ? null
          : previous.externalUpdate
        : sameDocumentChange(previous.externalUpdate, consumedExternalUpdate)
          ? null
          : previous.externalUpdate,
      error: null,
      actionError: null,
    })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('paperai workbench: controller disposed')
  }
}
