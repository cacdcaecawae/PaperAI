// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { PaperAIWorkbenchController } from '../src/client/controller.ts'
import type { PaperAIDocumentCommitResult, PaperAIDocumentOpenResult, PaperAITemplateLibrary, PaperAIWorkbenchRemote } from '../src/client/types.ts'
import {
  COMMIT_0, COMMIT_1, COMMIT_2, CUSTOM_PACK_ID, DIFF, DOCUMENT_ID, documentOpenResult, HIT_PACK_ID,
  NODE_HEADING, NODE_PARAGRAPH, NODE_TABLE, OVERVIEW, RESOURCE_ID, REVISION_1, REVISION_2, SESSION_ID, successfulRemote,
  WORKSPACE_ID,
} from './fixtures.client.ts'

const REMOTE_FAILURE: RemoteResult<never> = {
  ok: false,
  error: { code: 'internal', message: 'Host capability unavailable', details: {} },
}

async function openedController(remote: PaperAIWorkbenchRemote = successfulRemote()) {
  const controller = new PaperAIWorkbenchController(remote)
  await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
  return { controller, remote, store: controller.workbenchStore(SESSION_ID) }
}

describe('PaperAIWorkbenchController projects', () => {
  it('bounds heavy previews while retaining evicted drafts and invalidating background changes', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<typeof remote.open>(async request => ({ ok: true as const, value: documentOpenResult(undefined, {
      resourceId: request.resourceId, documentId: String(request.resourceId).slice('document:'.length) as never,
    }) }))
    const { controller, store } = await openedController(remote)
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Survives eviction' })
    controller.setScroll(SESSION_ID, 420)
    const second = 'document:second' as typeof RESOURCE_ID
    const third = 'document:third' as typeof RESOURCE_ID
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, second)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, third)
    expect(store.getSnapshot().retained.map(view => view.document?.resourceId)).toEqual([second])
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(remote.open).toHaveBeenCalledTimes(4)
    expect(store.getSnapshot()).toMatchObject({ scrollTop: 420, edits: [{ draft: 'Survives eviction', conflicted: false }] })
    expect(store.getSnapshot().retained.map(view => view.document?.resourceId)).toEqual([third])
    controller.handleDocumentChanged({ documentId: 'third' as never, headCommitId: COMMIT_2, updatedAt: '2026-09-05T00:00:00Z' })
    expect(store.getSnapshot().retained).toHaveLength(0)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, third)
    expect(remote.open).toHaveBeenCalledTimes(5)
  })

  it('loads a cold project once, mirrors it into the directory, and refreshes on demand', async () => {
    const remote = successfulRemote()
    const overview = vi.spyOn(remote, 'overview')
    const controller = new PaperAIWorkbenchController(remote)
    const directory = controller.projectDirectoryStore()
    expect(directory.getSnapshot().workspaces[WORKSPACE_ID]).toBeUndefined()

    await controller.ensureProject(WORKSPACE_ID)
    await controller.ensureProject(WORKSPACE_ID)
    expect(overview).toHaveBeenCalledOnce()
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({ phase: 'ready', overview: OVERVIEW })
    expect(directory.getSnapshot().workspaces[WORKSPACE_ID]).toBe(controller.projectStore(WORKSPACE_ID).getSnapshot())

    remote.overview = vi.fn<typeof remote.overview>().mockResolvedValueOnce(REMOTE_FAILURE)
    await controller.loadProject(WORKSPACE_ID)
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'error', overview: OVERVIEW, error: 'internal: Host capability unavailable',
    })
    controller.failWorkspace(WORKSPACE_ID, new Error('connect failed'))
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({ phase: 'ready', error: 'connect failed' })
    controller.dispose()
    expect(() => controller.projectStore(WORKSPACE_ID)).toThrow('controller disposed')
  })

  it('retries a failed initial project read without duplicating its pending retry', async () => {
    const remote = successfulRemote()
    const overview = vi.spyOn(remote, 'overview').mockResolvedValueOnce(REMOTE_FAILURE)
    const controller = new PaperAIWorkbenchController(remote)
    await controller.ensureProject(WORKSPACE_ID)
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().phase).toBe('error')

    const retry = controller.ensureProject(WORKSPACE_ID)
    await controller.ensureProject(WORKSPACE_ID)
    await retry
    expect(overview).toHaveBeenCalledTimes(2)
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({ phase: 'ready', overview: OVERVIEW })
  })

  it('records the template choice and refuses a second project action while one runs', async () => {
    const remote = successfulRemote()
    const setProjectTemplate = vi.spyOn(remote, 'setProjectTemplate')
    const controller = new PaperAIWorkbenchController(remote)
    let finish!: (value: RemoteResult<typeof OVERVIEW>) => void
    setProjectTemplate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const choosing = controller.setProjectTemplate(WORKSPACE_ID, null)
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().action).toBe('choosing-template')
    await expect(controller.setProjectTemplate(WORKSPACE_ID, HIT_PACK_ID)).resolves.toEqual({ ok: false, error: 'project is busy' })
    finish({ ok: true, value: { ...OVERVIEW, templatePackId: null, template: null } })
    await expect(choosing).resolves.toEqual({ ok: true })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'ready', action: null, overview: { template: null, templateDecided: true },
    })
    expect(setProjectTemplate).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, packId: null })

    setProjectTemplate.mockResolvedValueOnce(REMOTE_FAILURE)
    await expect(controller.setProjectTemplate(WORKSPACE_ID, CUSTOM_PACK_ID)).resolves.toEqual({
      ok: false, error: 'internal: Host capability unavailable',
    })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().actionError).toBe('internal: Host capability unavailable')
  })

  it('adds externally committed documents to an already loaded project', async () => {
    const remote = successfulRemote()
    const overview = vi.spyOn(remote, 'overview').mockResolvedValueOnce({ ok: true, value: { ...OVERVIEW, documents: [] } })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.ensureProject(WORKSPACE_ID)
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().overview?.documents).toEqual([])
    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID, headCommitId: COMMIT_1, updatedAt: '2026-09-03T00:00:00.000Z',
    })
    await vi.waitFor(() => {
      expect(controller.projectStore(WORKSPACE_ID).getSnapshot().overview?.documents).toEqual(OVERVIEW.documents)
    })
    expect(overview).toHaveBeenCalledTimes(2)
  })

  it('starts documents from the project template or a free import and opens them in the Session', async () => {
    const remote = successfulRemote()
    const createFromTemplate = vi.spyOn(remote, 'createFromTemplate')
    const importDocument = vi.spyOn(remote, 'importDocument')
    const overview = vi.spyOn(remote, 'overview')
    const controller = new PaperAIWorkbenchController(remote)

    await expect(controller.createFromTemplate(WORKSPACE_ID, SESSION_ID, { documentType: 'proposal' })).resolves.toEqual({ ok: true })
    expect(createFromTemplate).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, documentType: 'proposal' },
      expect.any(AbortSignal),
    )
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({ phase: 'ready', document: { documentId: DOCUMENT_ID } })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({ phase: 'ready', selected: RESOURCE_ID })
    expect(overview).toHaveBeenCalledOnce()

    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, { fileName: '初稿.docx', contentBase64: 'd29yZA==' }))
      .resolves.toEqual({ ok: true })
    expect(importDocument).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, fileName: '初稿.docx', contentBase64: 'd29yZA==' },
      expect.any(AbortSignal),
    )
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().document?.documentType).toBe('other')

    importDocument.mockResolvedValueOnce({ ok: true, value: { status: 'degraded', capability: 'document-engine', detail: 'OfficeCLI missing' } })
    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, { fileName: 'x.docx', contentBase64: 'd29yZA==' }))
      .resolves.toEqual({ ok: false, error: 'document-engine: OfficeCLI missing' })
    importDocument.mockResolvedValueOnce({
      ok: true,
      value: { status: 'imported', opened: documentOpenResult(REVISION_2, { sessionId: 'other' as never }), createdCommitId: COMMIT_2 },
    })
    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, { fileName: 'x.docx', contentBase64: 'd29yZA==' }))
      .resolves.toMatchObject({ ok: false })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().actionError).toContain('another Workspace or Session')
  })

  it.each(['importDocument', 'createFromTemplate'] as const)('preserves a draft typed while %s is pending', async (method) => {
    const { controller, remote, store } = await openedController()
    const overview = vi.spyOn(remote, 'overview')
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.importDocument>>>()
    vi.spyOn(remote, method).mockReturnValueOnce(pending.promise)
    const starting = method === 'importDocument'
      ? controller.importDocument(WORKSPACE_ID, SESSION_ID, { fileName: 'new.docx', contentBase64: 'd29yZA==' })
      : controller.createFromTemplate(WORKSPACE_ID, SESSION_ID, { documentType: 'proposal' })
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Written during import' })
    const current = store.getSnapshot()
    pending.resolve({ ok: true, value: {
      status: 'imported', createdCommitId: COMMIT_2,
      opened: documentOpenResult(REVISION_2, { resourceId: 'document:imported' as never, documentId: 'imported' as never }),
    } })
    await expect(starting).resolves.toEqual({ ok: true })
    expect(store.getSnapshot()).toEqual(current)
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot()).toMatchObject({ selected: RESOURCE_ID, action: null })
    expect(overview).toHaveBeenCalledOnce()
  })

  it('keeps a later document selection when an import completes', async () => {
    const { controller, remote, store } = await openedController()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.importDocument>>>()
    vi.spyOn(remote, 'importDocument').mockReturnValueOnce(pending.promise)
    const starting = controller.importDocument(WORKSPACE_ID, SESSION_ID, { fileName: 'new.docx', contentBase64: 'd29yZA==' })
    vi.spyOn(remote, 'open').mockResolvedValueOnce({ ok: true, value: documentOpenResult(undefined, {
      resourceId: 'document:chosen' as never, documentId: 'chosen' as never,
    }) })
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, 'document:chosen' as never)
    pending.resolve({ ok: true, value: { status: 'imported', createdCommitId: COMMIT_2, opened: documentOpenResult(REVISION_2) } })
    await expect(starting).resolves.toEqual({ ok: true })
    expect(store.getSnapshot().document?.documentId).toBe('chosen')
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().selected).toBe('document:chosen')
  })

  it('refuses to start a document while the Session workbench is busy', async () => {
    const remote = successfulRemote()
    let finish!: (value: RemoteResult<PaperAIDocumentCommitResult>) => void
    const commit = vi.spyOn(remote, 'commit')
    commit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { controller } = await openedController(remote)
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Changed' })
    const committing = controller.commitEdit(SESSION_ID)
    await expect(controller.createFromTemplate(WORKSPACE_ID, SESSION_ID, { documentType: 'midterm' }))
      .resolves.toEqual({ ok: false, error: 'workbench is busy' })
    finish(REMOTE_FAILURE)
    await committing
  })
})

describe('PaperAIWorkbenchController template library', () => {
  it('loads the library once, reloads on demand, and reports read failures', async () => {
    const remote = successfulRemote()
    const listTemplateLibrary = vi.spyOn(remote, 'listTemplateLibrary')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.loadLibrary()
    await controller.loadLibrary()
    expect(listTemplateLibrary).toHaveBeenCalledOnce()
    expect(controller.libraryStore().getSnapshot()).toMatchObject({ phase: 'ready' })
    expect(controller.libraryStore().getSnapshot().library?.sets.map(set => set.packId)).toEqual([HIT_PACK_ID, CUSTOM_PACK_ID])
    listTemplateLibrary.mockResolvedValueOnce(REMOTE_FAILURE)
    await controller.loadLibrary(true)
    expect(controller.libraryStore().getSnapshot()).toMatchObject({ phase: 'error', error: 'internal: Host capability unavailable' })
  })

  it('applies library changes, republishes loaded projects, and serializes actions', async () => {
    const remote = successfulRemote()
    const createTemplateSet = vi.spyOn(remote, 'createTemplateSet')
    const overview = vi.spyOn(remote, 'overview')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.ensureProject(WORKSPACE_ID)
    expect(overview).toHaveBeenCalledOnce()

    let finish!: (value: RemoteResult<PaperAITemplateLibrary>) => void
    createTemplateSet.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const creating = controller.createTemplateSet({ name: '新模板' })
    expect(controller.libraryStore().getSnapshot().action).toBe('creating')
    await expect(controller.deleteTemplateSet(CUSTOM_PACK_ID)).resolves.toEqual({ ok: false, error: 'template library is busy' })
    finish({ ok: true, value: { sets: [] } })
    await expect(creating).resolves.toEqual({ ok: true })
    expect(controller.libraryStore().getSnapshot()).toMatchObject({ phase: 'ready', action: null, library: { sets: [] } })
    // A changed library re-reads every loaded project, whose offer depends on it.
    await vi.waitFor(() => { expect(overview).toHaveBeenCalledTimes(2) })

    await expect(controller.addTemplateFormat({
      packId: CUSTOM_PACK_ID, documentType: 'midterm', usage: 'form-template', fileName: '中期.docx', contentBase64: 'd29yZA==',
    })).resolves.toEqual({ ok: true })
    await expect(controller.removeTemplateFormat(CUSTOM_PACK_ID, 'midterm')).resolves.toEqual({ ok: true })
    remote.deleteTemplateSet = vi.fn<typeof remote.deleteTemplateSet>().mockResolvedValue(REMOTE_FAILURE)
    await expect(controller.deleteTemplateSet(CUSTOM_PACK_ID)).resolves.toEqual({ ok: false, error: 'internal: Host capability unavailable' })
    expect(controller.libraryStore().getSnapshot()).toMatchObject({ action: null, actionError: 'internal: Host capability unavailable' })
  })
})

describe('PaperAIWorkbenchController documents', () => {
  it('retains draft text and the unsupported-content diagnostic when Word preservation rejects a save', async () => {
    const remote = successfulRemote()
    const message = "UNSUPPORTED_DOCUMENT_CONTENT: paragraph '/body/p[2]' contains objects that require editing in Word"
    vi.spyOn(remote, 'commit').mockResolvedValueOnce({ ok: false, error: { code: 'internal', message, details: {} } })
    const { controller, store } = await openedController(remote)
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Keep my words' })
    const original = store.getSnapshot().document
    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: false, error: `internal: ${message}` })
    expect(store.getSnapshot()).toMatchObject({ action: null, actionError: `internal: ${message}`, edits: [{ draft: 'Keep my words' }] })
    expect(store.getSnapshot().document).toBe(original)
    controller.dispose()
  })

  it('opens a document, retypes blocks in place, and saves them as one version', async () => {
    const remote = successfulRemote()
    const commit = vi.spyOn(remote, 'commit')
    const { controller, store } = await openedController(remote)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', edits: [], panel: null })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().selected).toBe(RESOURCE_ID)

    controller.updateDraft(SESSION_ID, NODE_TABLE, { text: 'Cells without a node stay as rendered' })
    expect(store.getSnapshot().edits).toEqual([])
    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: false, error: 'no block has changes' })
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Rewritten introduction' })
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Rewritten background' })
    // The page owns the comparison, because a block can differ by its formatting alone; null drops its draft.
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, null)
    expect(store.getSnapshot().edits).toEqual([{ nodeId: NODE_HEADING, baseText: 'Introduction', baseRevision: REVISION_1, draft: 'Rewritten introduction' }])
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Rewritten background', runs: [
      { text: 'Rewritten ' }, { text: 'background', bold: true },
    ] })

    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(commit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: 'revision-1',
      baseCommitId: COMMIT_1,
      mutations: [
        { type: 'replace-text', nodeId: NODE_HEADING, baseText: 'Introduction', nextText: 'Rewritten introduction' },
        {
          type: 'replace-text',
          nodeId: NODE_PARAGRAPH,
          baseText: 'Research background',
          nextText: 'Rewritten background',
          runs: [{ text: 'Rewritten ' }, { text: 'background', bold: true }],
        },
      ],
    }, expect.any(AbortSignal))
    expect(store.getSnapshot()).toMatchObject({ edits: [], action: null, document: { revision: REVISION_2, headCommitId: COMMIT_2 } })

    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Draft' })
    controller.cancelEdit(SESSION_ID)
    expect(store.getSnapshot().edits).toEqual([])
  })

  it('retains an unsaved draft across document navigation while excluding competing document mutations', async () => {
    const { controller, remote, store } = await openedController()
    const open = vi.spyOn(remote, 'open')
    const importDocument = vi.spyOn(remote, 'importDocument')
    const createFromTemplate = vi.spyOn(remote, 'createFromTemplate')
    const validate = vi.spyOn(remote, 'validate')
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Unsaved introduction' })
    controller.setScroll(SESSION_ID, 240)
    open.mockResolvedValueOnce({ ok: true, value: documentOpenResult(undefined, {
      resourceId: 'document:other' as typeof RESOURCE_ID, documentId: 'other' as typeof DOCUMENT_ID,
    }) })
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, 'document:other' as typeof RESOURCE_ID)
    expect(store.getSnapshot().document?.documentId).toBe('other')
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(open).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).toMatchObject({ edits: [{ draft: 'Unsaved introduction' }], scrollTop: 240 })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().selected).toBe(RESOURCE_ID)

    const blocked = { ok: false, error: 'save or cancel the current block first' }
    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, { fileName: 'paper.docx', contentBase64: 'd29yZA==' }))
      .resolves.toEqual(blocked)
    await expect(controller.createFromTemplate(WORKSPACE_ID, SESSION_ID, { documentType: 'proposal' }))
      .resolves.toEqual(blocked)
    await expect(controller.validate(SESSION_ID)).resolves.toEqual(blocked)
    expect(importDocument).not.toHaveBeenCalled()
    expect(createFromTemplate).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({
      document: { documentId: DOCUMENT_ID },
      edits: [{ draft: 'Unsaved introduction' }],
      actionError: blocked.error,
    })

    controller.cancelEdit(SESSION_ID)
    await controller.retryOpen(SESSION_ID)
    expect(open).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, resourceId: RESOURCE_ID }, expect.any(AbortSignal),
    )
  })

  it('preserves edits across reconnect and offers a missed external version for explicit refresh', async () => {
    const { controller, remote, store } = await openedController()
    const open = vi.spyOn(remote, 'open')
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Unsaved introduction' })

    controller.refreshLoaded()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
    expect(store.getSnapshot()).toMatchObject({
      edits: [{ draft: 'Unsaved introduction' }], document: { headCommitId: COMMIT_1 }, externalUpdate: null,
    })

    open.mockResolvedValue({ ok: true, value: documentOpenResult(REVISION_2) })
    controller.refreshLoaded()
    await vi.waitFor(() => { expect(store.getSnapshot().externalUpdate).toMatchObject({ headCommitId: COMMIT_2 }) })
    expect(store.getSnapshot()).toMatchObject({
      edits: [{ draft: 'Unsaved introduction' }], document: { headCommitId: COMMIT_1 },
    })
    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot()).toMatchObject({
      edits: [{ draft: 'Unsaved introduction' }], document: { headCommitId: COMMIT_2 }, externalUpdate: null,
    })
  })

  it('keeps a newer live head notice when a reconnect read finishes late', async () => {
    const { controller, remote, store } = await openedController()
    let finish!: (value: RemoteResult<ReturnType<typeof documentOpenResult>>) => void
    vi.spyOn(remote, 'open').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Unsaved introduction' })
    controller.refreshLoaded()
    controller.handleDocumentChanged({ documentId: DOCUMENT_ID, headCommitId: 'commit-newest' as typeof COMMIT_2, updatedAt: '2026-09-03T00:00:00.000Z' })
    finish({ ok: true, value: documentOpenResult(REVISION_2) })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot()).toMatchObject({
      externalUpdate: { headCommitId: 'commit-newest' }, edits: [{ draft: 'Unsaved introduction' }],
    })
  })

  it('toggles panels, runs the gate, and keeps the diff only while the versions panel is open', async () => {
    const remote = successfulRemote()
    const validate = vi.spyOn(remote, 'validate')
    const diffVersion = vi.spyOn(remote, 'diffVersion')
    const { controller, store } = await openedController(remote)
    controller.showPanel(SESSION_ID, 'gate')
    expect(store.getSnapshot().panel).toBe('gate')
    await expect(controller.validate(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(validate).toHaveBeenCalledOnce()
    expect(store.getSnapshot().document?.gate).toEqual({ status: 'passed', findings: [] })

    controller.showPanel(SESSION_ID, 'versions')
    await expect(controller.showDiff(SESSION_ID, COMMIT_1)).resolves.toEqual({ ok: true })
    expect(diffVersion).toHaveBeenCalledWith({ documentId: DOCUMENT_ID, commitId: COMMIT_1 }, expect.any(AbortSignal))
    expect(store.getSnapshot().diff).toEqual({ commitId: COMMIT_1, result: { ...DIFF, commitId: COMMIT_1 }, error: null })
    await expect(controller.showDiff(SESSION_ID, COMMIT_1)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot().diff).toBeNull()
    diffVersion.mockResolvedValueOnce(REMOTE_FAILURE)
    await expect(controller.showDiff(SESSION_ID, COMMIT_0)).resolves.toEqual({ ok: false, error: 'internal: Host capability unavailable' })
    expect(store.getSnapshot().diff).toEqual({ commitId: COMMIT_0, result: null, error: 'internal: Host capability unavailable' })
    diffVersion.mockResolvedValueOnce({ ok: true, value: { ...DIFF, commitId: COMMIT_0 } })
    await expect(controller.showDiff(SESSION_ID, COMMIT_0)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot().diff?.result?.commitId).toBe(COMMIT_0)
    controller.showPanel(SESSION_ID, 'versions')
    expect(store.getSnapshot()).toMatchObject({ panel: null, diff: null })
  })

  it('applies and detaches the project template, guessing the type first', async () => {
    const remote = successfulRemote()
    const applyTemplate = vi.spyOn(remote, 'applyTemplate')
    const detachTemplate = vi.spyOn(remote, 'detachTemplate')
    const { controller, store } = await openedController(remote)
    await expect(controller.suggestType(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot().typeSuggestion).toEqual({ documentId: DOCUMENT_ID, documentType: 'proposal', basis: 'title' })
    await expect(controller.applyTemplate(SESSION_ID, 'midterm')).resolves.toEqual({ ok: true })
    expect(applyTemplate).toHaveBeenCalledWith(expect.objectContaining({ documentType: 'midterm', baseCommitId: COMMIT_1 }), expect.any(AbortSignal))
    expect(store.getSnapshot().document?.documentType).toBe('midterm')
    await expect(controller.detachTemplate(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(detachTemplate).toHaveBeenCalledOnce()
    expect(store.getSnapshot().document?.template).toBeNull()
    detachTemplate.mockResolvedValueOnce(REMOTE_FAILURE)
    await expect(controller.detachTemplate(SESSION_ID)).resolves.toEqual({ ok: false, error: 'internal: Host capability unavailable' })
    expect(store.getSnapshot()).toMatchObject({ action: null, actionError: 'internal: Host capability unavailable' })
  })

  it('exports drafts and formal copies, turning a blocked delivery into the gate panel', async () => {
    const remote = successfulRemote()
    const { controller, store } = await openedController(remote)
    await expect(controller.exportDocument(SESSION_ID, 'draft-export')).resolves.toEqual({ ok: true })
    expect(store.getSnapshot().exportReceipt).toEqual({
      mode: 'draft-export', fileName: '开题报告-草稿.docx', outputPath: 'F:/paper/exports/drafts/开题报告-草稿.docx',
    })
    remote.exportDocument = vi.fn<typeof remote.exportDocument>().mockResolvedValueOnce({
      ok: true,
      value: {
        status: 'blocked',
        documentId: DOCUMENT_ID,
        revision: REVISION_2,
        headCommitId: COMMIT_2,
        fileName: '开题报告.docx',
        gate: { status: 'failed', findings: [{ id: 'f' as never, severity: 'error', title: 'Title', message: 'Missing', passed: false }] },
      },
    })
    await expect(controller.exportDocument(SESSION_ID, 'delivery-export')).resolves.toEqual({
      ok: false, error: 'delivery blocked by 1 template requirement',
    })
    expect(store.getSnapshot()).toMatchObject({ panel: 'gate', exportReceipt: null, document: { gate: { status: 'failed' } } })
  })

  it('restores versions and retries the last open after a reset', async () => {
    const remote = successfulRemote()
    const open = vi.spyOn(remote, 'open')
    const restore = vi.spyOn(remote, 'restore')
    const { controller, store } = await openedController(remote)
    await expect(controller.restore(SESSION_ID, COMMIT_0)).resolves.toEqual({ ok: true })
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ targetCommitId: COMMIT_0 }), expect.any(AbortSignal))
    expect(store.getSnapshot().document?.headCommitId).toBe('commit-3')
    controller.refreshLoaded()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(2) })
    await expect(controller.retryOpen('other-session' as never)).resolves.toBeUndefined()
  })

  it('surfaces open failures and mismatched documents through state', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<typeof remote.open>()
      .mockResolvedValueOnce(REMOTE_FAILURE)
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2, { resourceId: 'document:other' as never }) })
    const controller = new PaperAIWorkbenchController(remote)
    const store = controller.workbenchStore(SESSION_ID)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'internal: Host capability unavailable' })
    await controller.retryOpen(SESSION_ID)
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'paperaiWorkbench returned another document' })
    await expect(controller.validate(SESSION_ID)).resolves.toEqual({ ok: false, error: 'no open document' })
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Nothing to edit' })
    expect(store.getSnapshot().edits).toEqual([])
  })

  it('reloads external heads and retains a conflicting draft without allowing it to overwrite the block', async () => {
    const remote = successfulRemote()
    remote.commit = vi.fn(remote.commit)
    remote.open = vi.fn<typeof remote.open>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
      .mockResolvedValueOnce({
        ok: true,
        value: documentOpenResult(REVISION_2, {
          nodes: documentOpenResult().document.nodes.map(node => node.nodeId === NODE_HEADING ? { ...node, text: 'Changed elsewhere' } : node),
        }),
      })
    const { controller, store } = await openedController(remote)
    const change = { documentId: DOCUMENT_ID, headCommitId: COMMIT_2, updatedAt: '2026-08-28T12:00:00.000Z' }

    // Idle: the new head loads at once.
    controller.handleDocumentChanged(change)
    await vi.waitFor(() => { expect(store.getSnapshot().document?.revision).toBe(REVISION_2) })
    expect(store.getSnapshot().externalUpdate).toBeNull()

    // A dirty draft waits for the user; the block still reads the same, so the draft survives.
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Local draft' })
    controller.handleDocumentChanged({ ...change, headCommitId: 'commit-9' as never })
    expect(store.getSnapshot().externalUpdate).toMatchObject({ headCommitId: 'commit-9' })
    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot()).toMatchObject({
      externalUpdate: null,
      actionError: null,
      edits: [{ draft: 'Local draft', conflicted: true }],
    })
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Local draft with more typing' })
    expect(store.getSnapshot().edits).toMatchObject([{ draft: 'Local draft', conflicted: true }])
    await expect(controller.commitEdit(SESSION_ID)).resolves.toMatchObject({ ok: false })
    expect(remote.commit).not.toHaveBeenCalled()
    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: false, error: 'no external document update' })
  })

  it('retains formatting drafts as conflicts after an external revision changes no plain text', async () => {
    const remote = successfulRemote()
    const commit = vi.spyOn(remote, 'commit')
    const { controller, store } = await openedController(remote)
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Introduction', runs: [{ text: 'Introduction', bold: true }] })
    remote.open = vi.fn<typeof remote.open>().mockResolvedValue({ ok: true, value: documentOpenResult(REVISION_2) })
    controller.handleDocumentChanged({ documentId: DOCUMENT_ID, headCommitId: COMMIT_2, updatedAt: '2026-09-12T00:00:00.000Z' })
    await controller.reloadExternal(SESSION_ID)
    expect(store.getSnapshot().edits).toMatchObject([{ baseRevision: REVISION_1, conflicted: true, runs: [{ bold: true }] }])
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Changed again' })
    await expect(controller.commitEdit(SESSION_ID)).resolves.toMatchObject({ ok: false })
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('PaperAIWorkbenchController deferred previews', () => {
  it('paints a commit into the current preview and swaps in the rendered one', async () => {
    const remote = successfulRemote()
    remote.commit = vi.fn<typeof remote.commit>(async request => ({
      ok: true,
      value: {
        createdCommitId: COMMIT_2,
        ...documentOpenResult(REVISION_2, {
          previewHtml: '',
          nodes: documentOpenResult().document.nodes.map(node => node.nodeId === request.mutations[0]?.nodeId
            ? { ...node, text: request.mutations[0].nextText, label: request.mutations[0].nextText }
            : node),
        }),
      },
    }))
    const { controller, store } = await openedController(remote)
    let finish!: (value: RemoteResult<PaperAIDocumentOpenResult>) => void
    remote.open = vi.fn<typeof remote.open>(() => new Promise((resolve) => { finish = resolve }))
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Rewritten' })
    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: true })
    const patched = store.getSnapshot().document?.previewHtml ?? ''
    expect(new DOMParser().parseFromString(patched, 'text/html').querySelector('h1')?.textContent).toBe('Rewritten')
    expect(patched).toContain('Research background')
    expect(remote.open).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, resourceId: RESOURCE_ID })
    const rendered = '<html><head></head><body><h1 data-path="/body/p[1]">Rewritten</h1></body></html>'
    finish({ ok: true, value: documentOpenResult(REVISION_2, { previewHtml: rendered }) })
    await vi.waitFor(() => { expect(store.getSnapshot().document?.previewHtml).toBe(rendered) })
  })

  it('keeps a new draft and its preview while an earlier commit render completes', async () => {
    const remote = successfulRemote()
    remote.commit = vi.fn<typeof remote.commit>(async () => ({
      ok: true, value: { createdCommitId: COMMIT_2, ...documentOpenResult(REVISION_2, { previewHtml: '' }) },
    }))
    const { controller, store } = await openedController(remote)
    let finish!: (value: RemoteResult<PaperAIDocumentOpenResult>) => void
    remote.open = vi.fn<typeof remote.open>(() => new Promise((resolve) => { finish = resolve }))
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Committed text' })
    await controller.commitEdit(SESSION_ID)
    const painted = store.getSnapshot().document?.previewHtml
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Typing during preview rendering' })
    finish({ ok: true, value: documentOpenResult(REVISION_2, { previewHtml: '<p>Fresh render</p>' }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().document?.previewHtml).toBe(painted)
    expect(store.getSnapshot().edits).toMatchObject([{ draft: 'Typing during preview rendering' }])
  })

  it('records an outside working edit as a version and reopens the document with the draft kept', async () => {
    const remote = successfulRemote()
    const { controller, store } = await openedController(remote)
    const documentId = store.getSnapshot().document?.documentId
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Unsaved introduction' })
    const capture = vi.spyOn(remote, 'captureExternal')
    vi.spyOn(remote, 'open').mockResolvedValue({ ok: true, value: documentOpenResult(REVISION_2) })
    await expect(controller.captureExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(capture).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, documentId }, expect.any(AbortSignal))
    expect(store.getSnapshot()).toMatchObject({
      action: null, edits: [{ draft: 'Unsaved introduction' }], document: { headCommitId: COMMIT_2 },
    })
    vi.spyOn(remote, 'captureExternal').mockResolvedValue({ ok: false, error: { code: 'internal', message: 'nothing external to capture', details: {} } })
    await expect(controller.captureExternal(SESSION_ID)).resolves.toEqual({ ok: false, error: 'internal: nothing external to capture' })
    expect(store.getSnapshot().actionError).toBe('internal: nothing external to capture')
  })


  it('keeps the painted preview and raises the external-update notice when the render belongs to another version', async () => {
    const remote = successfulRemote()
    remote.commit = vi.fn<typeof remote.commit>(async () => ({
      ok: true,
      value: { createdCommitId: COMMIT_2, ...documentOpenResult(REVISION_2, { previewHtml: '' }) },
    }))
    const { controller, store } = await openedController(remote)
    remote.open = vi.fn<typeof remote.open>(async () => ({
      ok: true,
      value: documentOpenResult(REVISION_1, { previewHtml: '<html><head></head><body><p data-path="/body/p[2]">Elsewhere</p></body></html>' }),
    }))
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Rewritten' })
    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: true })
    await vi.waitFor(() => { expect(store.getSnapshot().externalUpdate).toMatchObject({ headCommitId: COMMIT_1 }) })
    expect(store.getSnapshot().document?.previewHtml).toContain('Rewritten')
    expect(store.getSnapshot().document?.previewHtml).not.toContain('Elsewhere')
  })

})
