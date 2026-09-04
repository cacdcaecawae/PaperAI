import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { PaperAIWorkbenchController } from '../src/client/controller.ts'
import type { PaperAIDocumentCommitResult, PaperAITemplateLibrary, PaperAIWorkbenchRemote } from '../src/client/types.ts'
import {
  COMMIT_0, COMMIT_1, COMMIT_2, CUSTOM_PACK_ID, DIFF, DOCUMENT_ID, documentOpenResult, HIT_PACK_ID,
  NODE_HEADING, NODE_PARAGRAPH, NODE_TABLE, OVERVIEW, RESOURCE_ID, REVISION_2, SESSION_ID, successfulRemote,
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

  it('refuses to start a document while the Session workbench is busy', async () => {
    const remote = successfulRemote()
    let finish!: (value: RemoteResult<PaperAIDocumentCommitResult>) => void
    const commit = vi.spyOn(remote, 'commit')
    commit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { controller } = await openedController(remote)
    expect(controller.selectBlock(SESSION_ID, NODE_HEADING)).toEqual({ ok: true })
    controller.updateDraft(SESSION_ID, 'Changed')
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
  it('opens a document, edits one block in place, and saves it as a version', async () => {
    const remote = successfulRemote()
    const commit = vi.spyOn(remote, 'commit')
    const { controller, store } = await openedController(remote)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', edit: null, panel: null })
    expect(controller.projectStore(WORKSPACE_ID).getSnapshot().selected).toBe(RESOURCE_ID)

    expect(controller.selectBlock(SESSION_ID, NODE_TABLE)).toEqual({ ok: false, error: 'block is not editable' })
    expect(controller.selectBlock(SESSION_ID, NODE_HEADING)).toEqual({ ok: true })
    expect(store.getSnapshot().edit).toEqual({ nodeId: NODE_HEADING, baseText: 'Introduction', draft: 'Introduction' })
    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: false, error: 'block has no changes' })
    controller.updateDraft(SESSION_ID, 'Rewritten introduction')
    expect(controller.selectBlock(SESSION_ID, NODE_PARAGRAPH)).toEqual({ ok: false, error: 'save or cancel the current block first' })
    expect(controller.selectBlock(SESSION_ID, NODE_HEADING)).toEqual({ ok: true })
    expect(store.getSnapshot().edit?.draft).toBe('Rewritten introduction')

    await expect(controller.commitEdit(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(commit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: 'revision-1',
      baseCommitId: COMMIT_1,
      mutations: [{ type: 'replace-text', nodeId: NODE_HEADING, baseText: 'Introduction', nextText: 'Rewritten introduction' }],
    }, expect.any(AbortSignal))
    expect(store.getSnapshot()).toMatchObject({ edit: null, action: null, document: { revision: REVISION_2, headCommitId: COMMIT_2 } })

    controller.selectBlock(SESSION_ID, NODE_PARAGRAPH)
    controller.updateDraft(SESSION_ID, 'Draft')
    controller.cancelEdit(SESSION_ID)
    expect(store.getSnapshot().edit).toBeNull()
  })

  it('keeps an unsaved draft and selection when another document is opened or started', async () => {
    const { controller, remote, store } = await openedController()
    const open = vi.spyOn(remote, 'open')
    const importDocument = vi.spyOn(remote, 'importDocument')
    const createFromTemplate = vi.spyOn(remote, 'createFromTemplate')
    const validate = vi.spyOn(remote, 'validate')
    controller.selectBlock(SESSION_ID, NODE_HEADING)
    controller.updateDraft(SESSION_ID, 'Unsaved introduction')
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, 'document:other' as typeof RESOURCE_ID)
    expect(open).not.toHaveBeenCalled()
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
      edit: { draft: 'Unsaved introduction' },
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
    controller.selectBlock(SESSION_ID, NODE_HEADING)
    controller.updateDraft(SESSION_ID, 'Unsaved introduction')

    controller.refreshLoaded()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
    expect(store.getSnapshot()).toMatchObject({
      edit: { draft: 'Unsaved introduction' }, document: { headCommitId: COMMIT_1 }, externalUpdate: null,
    })

    open.mockResolvedValue({ ok: true, value: documentOpenResult(REVISION_2) })
    controller.refreshLoaded()
    await vi.waitFor(() => { expect(store.getSnapshot().externalUpdate).toMatchObject({ headCommitId: COMMIT_2 }) })
    expect(store.getSnapshot()).toMatchObject({
      edit: { draft: 'Unsaved introduction' }, document: { headCommitId: COMMIT_1 },
    })
    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot()).toMatchObject({
      edit: { draft: 'Unsaved introduction' }, document: { headCommitId: COMMIT_2 }, externalUpdate: null,
    })
  })

  it('keeps a newer live head notice when a reconnect read finishes late', async () => {
    const { controller, remote, store } = await openedController()
    let finish!: (value: RemoteResult<ReturnType<typeof documentOpenResult>>) => void
    vi.spyOn(remote, 'open').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    controller.selectBlock(SESSION_ID, NODE_HEADING)
    controller.updateDraft(SESSION_ID, 'Unsaved introduction')
    controller.refreshLoaded()
    controller.handleDocumentChanged({ documentId: DOCUMENT_ID, headCommitId: 'commit-newest' as typeof COMMIT_2, updatedAt: '2026-09-03T00:00:00.000Z' })
    finish({ ok: true, value: documentOpenResult(REVISION_2) })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot()).toMatchObject({
      externalUpdate: { headCommitId: 'commit-newest' }, edit: { draft: 'Unsaved introduction' },
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
    expect(controller.selectBlock(SESSION_ID, NODE_HEADING)).toEqual({ ok: false, error: 'no open document' })
  })

  it('reloads external heads, keeping a clean draft and dropping a stale one', async () => {
    const remote = successfulRemote()
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
    controller.selectBlock(SESSION_ID, NODE_HEADING)
    controller.updateDraft(SESSION_ID, 'Local draft')
    controller.handleDocumentChanged({ ...change, headCommitId: 'commit-9' as never })
    expect(store.getSnapshot().externalUpdate).toMatchObject({ headCommitId: 'commit-9' })
    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(store.getSnapshot()).toMatchObject({
      externalUpdate: null,
      actionError: 'block changed externally; local draft dropped',
      edit: null,
    })
    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: false, error: 'no external document update' })
  })
})
